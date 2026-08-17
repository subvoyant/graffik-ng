/**
 * 3D camera-move export (ADR-0015).
 *
 * A motion-control move is only half a shot. The other half is the CG that has
 * to sit inside it, and that only works if the 3D package can reproduce the
 * camera's path exactly. This module bakes a `.graffik` move into standard
 * interchange formats, sampled **once per frame** — the same frames the camera
 * exposed (ADR-0014), so a renderer's frame N and the rig's frame N are the
 * same instant by construction rather than by interpolation.
 *
 * Two formats, deliberately:
 *
 *  - **USDA** (ASCII OpenUSD) is the primary. It is the format every major
 *    package now reads, it is plain text so this package keeps its zero runtime
 *    dependencies, and — the reason that actually matters — it carries
 *    `metersPerUnit` and `upAxis` as explicit stage metadata. Every other option
 *    makes the importer guess the scale, and a guessed scale is a camera move
 *    that is subtly the wrong size in a way nobody notices until the composite.
 *  - **.chan** is the lowest-common-denominator fallback: one line per frame,
 *    read by Nuke, 3DEqualizer, Syntheyes, Terragen, Blender. No metadata at
 *    all, so its conventions are documented here and in the ADR.
 *
 * Alembic is NOT written here. Alembic's Ogawa container has no maintained
 * pure-JavaScript writer, so supporting it means a native dependency in what is
 * currently a dependency-free core. If a facility demands `.abc`, convert the
 * USD with `usdcat`/Houdini/Blender rather than compromise the core.
 */

import { Film, filmAxesToMs } from "./film.js";
import { computeVelocities, splineAt } from "./spline.js";
import { framesToMs, fpsDecimal, framesToTimecode } from "./timecode.js";

/* ------------------------------------------------------------------
   Calibration — the answer to "how do steps become metres and degrees"
   ------------------------------------------------------------------ */

/**
 * Steps are meaningless outside the rig. The NMX reports motor steps and has no
 * encoder, so nothing in the system knows how far a step moves the carriage —
 * that depends on belt pitch, pulley diameter, gear ratio and microstepping.
 * It has to be MEASURED on the physical rig (see docs/HARDWARE-BRINGUP.md), and
 * an export without it is a shape, not a camera move.
 */
export interface RigCalibration {
  /** Slide: motor steps per millimetre of carriage travel. */
  slideStepsPerMm: number;
  /** Pan: motor steps per degree of rotation. */
  panStepsPerDeg: number;
  /** Tilt: motor steps per degree of rotation. */
  tiltStepsPerDeg: number;
  /** Flip a sign where the rig's positive direction disagrees with the scene. */
  invertSlide?: boolean;
  invertPan?: boolean;
  invertTilt?: boolean;
  /**
   * Distance from the tilt axis to the camera's entrance pupil, in mm, along
   * the lens axis. Non-zero on every real head: the camera swings on an arc
   * rather than rotating in place, and ignoring it is the classic reason a
   * perfectly tracked CG element slides against the plate on a tilt.
   */
  nodalOffsetMm?: number;
  /** Height of the pan axis above the rail, mm. Pure scene placement. */
  headHeightMm?: number;
}

export const DEFAULT_CALIBRATION: RigCalibration = {
  slideStepsPerMm: 100,
  panStepsPerDeg: 100,
  tiltStepsPerDeg: 100,
  nodalOffsetMm: 0,
  headHeightMm: 0,
};

export interface LensInfo {
  /** Focal length in mm. */
  focalLengthMm: number;
  /** Sensor width in mm (horizontal aperture). Default is Super 35. */
  sensorWidthMm: number;
  /** Sensor height in mm (vertical aperture). */
  sensorHeightMm: number;
}

/** Super 35 / most cinema cameras' open gate 16:9 window. */
export const DEFAULT_LENS: LensInfo = { focalLengthMm: 35, sensorWidthMm: 24.89, sensorHeightMm: 14.00 };

export interface ExportOptions {
  calibration?: RigCalibration;
  lens?: LensInfo;
  /**
   * Scene units. USD writes this into `metersPerUnit` so the importer does not
   * have to guess: 1 = metres (Blender, Unreal, Unity), 0.01 = centimetres
   * (Maya, Cinema 4D, Houdini's default, and USD's own fallback).
   */
  metersPerUnit?: number;
  /** "Y" (Maya, C4D, USD default) or "Z" (Blender, Houdini, Unreal). */
  upAxis?: "Y" | "Z";
  /** Prim name for the exported rig. */
  name?: string;
}

const DEFAULTS: Required<Omit<ExportOptions, "calibration" | "lens">> = {
  metersPerUnit: 1,
  upAxis: "Y",
  name: "GraffikRig",
};

/* ------------------------------------------------------------------
   Sampling — one pose per frame, from the SAME solver the rig runs
   ------------------------------------------------------------------ */

export interface RigPose {
  frame: number;
  /** Carriage position along the rail, mm. */
  slideMm: number;
  /** Pan angle, degrees. */
  panDeg: number;
  /** Tilt angle, degrees. */
  tiltDeg: number;
}

/**
 * Bake the move to one pose per frame.
 *
 * This calls `computeVelocities`/`splineAt` — the same functions that build the
 * packets uploaded to the controller (ADR-0009). A second interpolation written
 * "just for export" would produce a 3D camera that agrees with the drawing but
 * not with the rig, which is the worst of the three possible outcomes.
 */
export function sampleRig(film: Film, calibration: RigCalibration = DEFAULT_CALIBRATION): RigPose[] {
  const msAxes = filmAxesToMs(film);
  const solved = new Map<number, ReturnType<typeof computeVelocities>>();
  for (const ax of msAxes) solved.set(ax.axis, computeVelocities(ax.points));

  const at = (axis: number, ms: number) => {
    const s = solved.get(axis);
    return s ? splineAt(s, ms).value : 0;
  };

  const sgn = (on: boolean | undefined) => (on ? -1 : 1);
  const out: RigPose[] = [];
  for (let f = 0; f <= film.durationFrames; f++) {
    const ms = framesToMs(f, film.timebase);
    out.push({
      frame: f,
      slideMm: (at(0, ms) / calibration.slideStepsPerMm) * sgn(calibration.invertSlide),
      panDeg: (at(1, ms) / calibration.panStepsPerDeg) * sgn(calibration.invertPan),
      tiltDeg: (at(2, ms) / calibration.tiltStepsPerDeg) * sgn(calibration.invertTilt),
    });
  }
  return out;
}

/* ------------------------------------------------------------------
   USDA
   ------------------------------------------------------------------ */

const n = (v: number) => (Object.is(v, -0) ? 0 : Number(v.toFixed(6)));

/**
 * The rig hierarchy is exported as the mechanism actually is —
 * `rail → carriage(translate) → pan(rotate) → tilt(rotate) → camera` — rather
 * than as one baked camera transform. A 3D artist can then re-time or offset a
 * single joint, and, more importantly, can SEE that the pan happens at the
 * carriage and the tilt above it. A flattened matrix hides the geometry that
 * makes parallax behave the way it does on set.
 */
export function exportUsda(film: Film, opts: ExportOptions = {}): string {
  const cal = { ...DEFAULT_CALIBRATION, ...opts.calibration };
  const lens = { ...DEFAULT_LENS, ...opts.lens };
  const o = { ...DEFAULTS, ...opts };
  const poses = sampleRig(film, cal);
  const fps = fpsDecimal(film.timebase);
  const mmToUnit = 0.001 / o.metersPerUnit;   // mm -> scene units

  // The rail runs along +X in both conventions; pan turns about the up axis,
  // tilt about the cross axis. That is the only thing upAxis actually changes.
  const panAxis = o.upAxis === "Z" ? "Z" : "Y";
  const tiltAxis = "X";

  const vec = (x: number, y: number, z: number) => `(${n(x)}, ${n(y)}, ${n(z)})`;
  const headUp = (cal.headHeightMm ?? 0) * mmToUnit;
  const nodal = (cal.nodalOffsetMm ?? 0) * mmToUnit;

  const translateSamples = poses
    .map((p) => {
      const d = p.slideMm * mmToUnit;
      return `            ${p.frame}: ${o.upAxis === "Z" ? vec(d, 0, headUp) : vec(d, headUp, 0)},`;
    })
    .join("\n");
  const panSamples = poses.map((p) => `            ${p.frame}: ${n(p.panDeg)},`).join("\n");
  const tiltSamples = poses.map((p) => `            ${p.frame}: ${n(p.tiltDeg)},`).join("\n");

  const startTc = framesToTimecode(film.startFrame, film.timebase);
  const endTc = framesToTimecode(film.startFrame + film.durationFrames, film.timebase);

  return `#usda 1.0
(
    doc = """Graffik NG camera move — "${film.name}"
             ${film.durationFrames} frames @ ${fps} fps, ${startTc} to ${endTc}
             Baked one sample per frame from the same spline solver that drives
             the NMX controller. Calibration: ${cal.slideStepsPerMm} steps/mm slide,
             ${cal.panStepsPerDeg} steps/deg pan, ${cal.tiltStepsPerDeg} steps/deg tilt."""
    defaultPrim = "${o.name}"
    metersPerUnit = ${o.metersPerUnit}
    upAxis = "${o.upAxis}"
    timeCodesPerSecond = ${fps}
    framesPerSecond = ${fps}
    startTimeCode = 0
    endTimeCode = ${film.durationFrames}
)

def Xform "${o.name}" ()
{
    def Xform "Carriage"
    {
        double3 xformOp:translate.timeSamples = {
${translateSamples}
        }
        uniform token[] xformOpOrder = ["xformOp:translate"]

        def Xform "Pan"
        {
            float xformOp:rotate${panAxis}.timeSamples = {
${panSamples}
            }
            uniform token[] xformOpOrder = ["xformOp:rotate${panAxis}"]

            def Xform "Tilt"
            {
                float xformOp:rotate${tiltAxis}.timeSamples = {
${tiltSamples}
                }
                uniform token[] xformOpOrder = ["xformOp:rotate${tiltAxis}"]

                def Camera "Camera"
                {
                    float focalLength = ${n(lens.focalLengthMm)}
                    float horizontalAperture = ${n(lens.sensorWidthMm)}
                    float verticalAperture = ${n(lens.sensorHeightMm)}
                    float2 clippingRange = (0.01, 10000)
                    token projection = "perspective"
                    double3 xformOp:translate = ${o.upAxis === "Z" ? vec(0, nodal, 0) : vec(0, 0, nodal)}
                    uniform token[] xformOpOrder = ["xformOp:translate"]
                }
            }
        }
    }
}
`;
}

/* ------------------------------------------------------------------
   .chan
   ------------------------------------------------------------------ */

/**
 * One line per frame: `frame tx ty tz rx ry rz vfov`.
 *
 * `.chan` carries no metadata whatsoever — no units, no up-axis, no rotation
 * order, not even a comment line to put them in. That is its virtue (everything
 * reads it) and its trap. This exporter writes **XYZ-order Euler degrees with
 * rz = 0**, which reproduces the rig only if the importing camera's rotation
 * order is set to **YXZ**; Nuke's default is ZXY and will look wrong. Set it
 * explicitly on import, or use the USD.
 */
export function exportChan(film: Film, opts: ExportOptions = {}): string {
  const cal = { ...DEFAULT_CALIBRATION, ...opts.calibration };
  const lens = { ...DEFAULT_LENS, ...opts.lens };
  const o = { ...DEFAULTS, ...opts };
  const mmToUnit = 0.001 / o.metersPerUnit;
  const vfov = 2 * Math.atan(lens.sensorHeightMm / (2 * lens.focalLengthMm)) * (180 / Math.PI);
  const headUp = (cal.headHeightMm ?? 0) * mmToUnit;

  return sampleRig(film, cal)
    .map((p) => {
      const d = p.slideMm * mmToUnit;
      const [tx, ty, tz] = o.upAxis === "Z" ? [d, 0, headUp] : [d, headUp, 0];
      return [
        film.startFrame + p.frame,
        n(tx), n(ty), n(tz),
        n(p.tiltDeg), n(p.panDeg), 0,
        n(vfov),
      ].join(" ");
    })
    .join("\n") + "\n";
}



/* ------------------------------------------------------------------
   After Effects — "Keyframe Data" clipboard text
   ------------------------------------------------------------------ */

/**
 * After Effects has **no real-world units**: its 3D space is measured in
 * pixels. So an AE export cannot be "correct" the way a USD export can — it
 * needs an explicit metres-to-pixels mapping, and picking one is a creative
 * decision about how big the CG world is relative to the comp. `pixelsPerMeter`
 * is that decision, made visible rather than hidden in a magic number.
 *
 * The output is AE's tab-delimited Keyframe Data: select a camera layer in AE
 * and paste. AE's Y axis points DOWN and its camera looks down +Z, so the
 * signs here are not the same as the USD path — that is AE, not a bug.
 */
export function exportAfterEffects(
  film: Film,
  opts: ExportOptions & { pixelsPerMeter?: number; compWidth?: number; compHeight?: number } = {},
): string {
  const cal = { ...DEFAULT_CALIBRATION, ...opts.calibration };
  const lens = { ...DEFAULT_LENS, ...opts.lens };
  const ppm = opts.pixelsPerMeter ?? 1000;
  const W = opts.compWidth ?? 1920;
  const H = opts.compHeight ?? 1080;
  const poses = sampleRig(film, cal);
  const rate = fpsDecimal(film.timebase);

  // AE "zoom" is the focal length expressed in pixels for this comp width.
  const zoom = (lens.focalLengthMm / lens.sensorWidthMm) * W;
  const mmToPx = ppm / 1000;
  const t = (s: string) => `\t${s}`;

  const pos = poses
    .map((p) => t(`${film.startFrame + p.frame}\t${n(W / 2 + p.slideMm * mmToPx)}\t${n(H / 2 - (cal.headHeightMm ?? 0) * mmToPx)}\t${n(-zoom)}`))
    .join("\n");
  // AE orientation is X,Y,Z degrees with Y down, so tilt and pan both invert.
  const ori = poses
    .map((p) => t(`${film.startFrame + p.frame}\t${n((-p.tiltDeg + 360) % 360)}\t${n((-p.panDeg + 360) % 360)}\t0`))
    .join("\n");
  const camOpts = poses
    .map((p) => t(`${film.startFrame + p.frame}\t${n(zoom)}\t0\t${n(zoom)}\t25\t100`))
    .join("\n");

  return `Adobe After Effects 8.0 Keyframe Data

\tUnits Per Second\t${n(rate)}
\tSource Width\t${W}
\tSource Height\t${H}
\tSource Pixel Aspect Ratio\t1
\tComp Pixel Aspect Ratio\t1

Camera Options
\tFrame\tZoom\tDepth of Field\tFocus Distance\tAperture\tBlur Level
${camOpts}

Transform\tPosition
\tFrame\tX pixels\tY pixels\tZ pixels
${pos}

Transform\tOrientation
\tFrame\tX degrees\tY degrees\tZ degrees
${ori}


End of Keyframe Data
`;
}

/* ------------------------------------------------------------------
   Nuke — a Camera3 node with animated knobs
   ------------------------------------------------------------------ */

/**
 * A `.nk` fragment that can be pasted straight into a Nuke script. Unlike
 * `.chan` this one carries its own rotation order (`rotate_order YXZ`) and its
 * lens, so it cannot be imported wrong — which makes it the better Nuke target
 * whenever pasting is acceptable.
 *
 * Nuke curve syntax `{curve x<start> v1 v2 …}` lists one value per consecutive
 * frame, which is exactly what a baked move is.
 */
export function exportNukeScript(film: Film, opts: ExportOptions = {}): string {
  const cal = { ...DEFAULT_CALIBRATION, ...opts.calibration };
  const lens = { ...DEFAULT_LENS, ...opts.lens };
  const o = { ...DEFAULTS, ...opts };
  const poses = sampleRig(film, cal);
  const mmToUnit = 0.001 / o.metersPerUnit;
  const start = film.startFrame;
  const curve = (vals: number[]) => `{curve x${start} ${vals.map((v) => n(v)).join(" ")}}`;
  const headUp = (cal.headHeightMm ?? 0) * mmToUnit;

  const tx = curve(poses.map((p) => p.slideMm * mmToUnit));
  const ty = curve(poses.map(() => headUp));
  const tz = curve(poses.map(() => 0));
  const rx = curve(poses.map((p) => p.tiltDeg));
  const ry = curve(poses.map((p) => p.panDeg));

  return `# Graffik NG — "${film.name}"
# ${film.durationFrames} frames @ ${n(fpsDecimal(film.timebase))} fps, ${framesToTimecode(start, film.timebase)} onward
# Scene units: 1 unit = ${o.metersPerUnit} m. Calibration: ${cal.slideStepsPerMm} steps/mm slide.
Camera3 {
 inputs 0
 rot_order YXZ
 translate {${tx} ${ty} ${tz}}
 rotate {${rx} ${ry} {curve x${start} 0}}
 focal ${n(lens.focalLengthMm)}
 haperture ${n(lens.sensorWidthMm)}
 vaperture ${n(lens.sensorHeightMm)}
 name GraffikCamera
}
`;
}

/* ------------------------------------------------------------------
   Plain data
   ------------------------------------------------------------------ */

/**
 * Everything the move knows, one row per frame, in both the rig's units and
 * the scene's. This is the format that answers "what actually happened" when
 * something disagrees — and the one that will still open in thirty years.
 */
export function exportCsv(film: Film, opts: ExportOptions = {}): string {
  const cal = { ...DEFAULT_CALIBRATION, ...opts.calibration };
  const o = { ...DEFAULTS, ...opts };
  const msAxes = filmAxesToMs(film);
  const solved = new Map<number, ReturnType<typeof computeVelocities>>();
  for (const ax of msAxes) solved.set(ax.axis, computeVelocities(ax.points));
  const steps = (axis: number, ms: number) => {
    const s = solved.get(axis);
    return s ? splineAt(s, ms).value : 0;
  };
  const mmToUnit = 0.001 / o.metersPerUnit;

  const head = [
    "frame", "timecode", "ms",
    "slide_steps", "pan_steps", "tilt_steps",
    "slide_mm", "pan_deg", "tilt_deg",
    `slide_scene_units_at_${o.metersPerUnit}m`,
  ].join(",");

  const rows = sampleRig(film, cal).map((p) => {
    const ms = framesToMs(p.frame, film.timebase);
    return [
      film.startFrame + p.frame,
      framesToTimecode(film.startFrame + p.frame, film.timebase),
      ms,
      n(steps(0, ms)), n(steps(1, ms)), n(steps(2, ms)),
      n(p.slideMm), n(p.panDeg), n(p.tiltDeg),
      n(p.slideMm * mmToUnit),
    ].join(",");
  });
  return [head, ...rows].join("\n") + "\n";
}

/**
 * A Blender headless script that converts the exported USD to Alembic and FBX.
 *
 * This is the honest answer to "can we have Alembic". We will not write Ogawa
 * by hand (ADR-0015), but nobody should have to work out the bridge themselves
 * either: run this next to the `.usda` and Blender does it in one pass. Blender
 * is free, scriptable, and already in most of these pipelines.
 */
export function alembicConverterScript(usdaFileName: string): string {
  const base = usdaFileName.replace(/\.usda?$/i, "");
  return `# Convert the exported USD camera move to Alembic (.abc) and FBX.
#   blender --background --python ${base}-convert.py
# Blender 3.x+ required. Produces ${base}.abc and ${base}.fbx beside the .usda.
import bpy, os

HERE = os.path.dirname(os.path.abspath(__file__))
USDA = os.path.join(HERE, "${usdaFileName}")

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.wm.usd_import(filepath=USDA)

scene = bpy.context.scene
# The USD carries its own frame range; mirror it so the cache covers the move.
print("frame range:", scene.frame_start, "-", scene.frame_end)

bpy.ops.wm.alembic_export(
    filepath=os.path.join(HERE, "${base}.abc"),
    start=scene.frame_start, end=scene.frame_end,
    selected=False, flatten=False,
)
bpy.ops.export_scene.fbx(
    filepath=os.path.join(HERE, "${base}.fbx"),
    bake_anim=True, object_types={'CAMERA', 'EMPTY'},
)
print("wrote ${base}.abc and ${base}.fbx")
`;
}

/**
 * The export menu. `note` is shown in the dialog — every one of these has a
 * caveat, and a caveat the operator reads beats a caveat in a commit message.
 */
export const EXPORT_FORMATS: ReadonlyArray<{
  id: string; label: string; ext: string; note: string;
  write: (film: Film, opts: ExportOptions) => string;
}> = [
  {
    id: "usda", label: "OpenUSD (.usda)", ext: "usda",
    note: "Cinema 4D, Blender, Houdini, Maya, Unreal. Carries its own units and up-axis, so it cannot be imported at the wrong scale.",
    write: exportUsda,
  },
  {
    id: "abc", label: "Alembic + FBX (via Blender)", ext: "usda",
    note: "Writes the .usda plus a Blender script that converts it to .abc and .fbx. Alembic's container has no pure-JS writer, so this is the bridge rather than a compromise (ADR-0015).",
    write: exportUsda,
  },
  {
    id: "ae", label: "After Effects keyframe data (.txt)", ext: "txt",
    note: "Paste onto a camera layer. AE has no real-world units — set pixels-per-metre below, it is a creative choice about world scale.",
    write: exportAfterEffects,
  },
  {
    id: "nk", label: "Nuke camera (.nk)", ext: "nk",
    note: "Paste into a Nuke script. Carries its own rotation order and lens, so unlike .chan it cannot be imported wrong.",
    write: exportNukeScript,
  },
  {
    id: "chan", label: "Channel file (.chan)", ext: "chan",
    note: "Nuke, 3DEqualizer, Syntheyes, Blender. No metadata at all — set the importing camera's rotation order to YXZ.",
    write: exportChan,
  },
  {
    id: "csv", label: "Data table (.csv)", ext: "csv",
    note: "One row per frame in steps, millimetres, degrees and scene units. The format that still opens in thirty years.",
    write: exportCsv,
  },
];

/**
 * What the move actually covers, for the scale readout in the export dialog.
 * Seeing "travel 412 mm · pan 37.4°" before exporting catches a calibration
 * that is out by a factor of ten far more reliably than reading the file does.
 */
export function moveExtents(film: Film, calibration: RigCalibration = DEFAULT_CALIBRATION) {
  const poses = sampleRig(film, calibration);
  const span = (get: (p: RigPose) => number) => {
    const vals = poses.map(get);
    return { min: Math.min(...vals), max: Math.max(...vals), range: Math.max(...vals) - Math.min(...vals) };
  };
  return { slideMm: span((p) => p.slideMm), panDeg: span((p) => p.panDeg), tiltDeg: span((p) => p.tiltDeg) };
}
