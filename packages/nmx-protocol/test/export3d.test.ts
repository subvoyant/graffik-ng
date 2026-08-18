import { describe, it, expect } from "vitest";
import { newFilm, Film } from "../src/film.js";
import { Timebase } from "../src/timecode.js";
import {
  sampleRig, exportUsda, exportChan, exportAfterEffects, exportNukeScript, exportCsv,
  alembicConverterScript, moveExtents, DEFAULT_CALIBRATION, RigCalibration, EXPORT_FORMATS,
} from "../src/export3d.js";

const TB_24: Timebase = { num: 24, den: 1, dropFrame: false };

/** 2 s move: slide 0 -> 20000 steps, pan 0 -> 9000, tilt flat. */
function move(): Film {
  const f = newFilm("Test move", 48, TB_24);
  f.axes[0].points = [{ frame: 0, position: 0 }, { frame: 48, position: 20_000 }];
  f.axes[1].points = [{ frame: 0, position: 0 }, { frame: 48, position: 9_000 }];
  f.axes[2].points = [{ frame: 0, position: 0 }, { frame: 48, position: 0 }];
  return f;
}

/** 100 steps/mm slide, 100 steps/deg pan and tilt — round numbers on purpose. */
const CAL: RigCalibration = { slideStepsPerMm: 100, panStepsPerDeg: 100, tiltStepsPerDeg: 100 };

describe("sampling", () => {
  it("emits exactly one pose per frame, inclusive of both ends", () => {
    const poses = sampleRig(move(), CAL);
    expect(poses).toHaveLength(49);
    expect(poses[0].frame).toBe(0);
    expect(poses[48].frame).toBe(48);
  });

  it("converts steps to millimetres and degrees using the calibration", () => {
    const poses = sampleRig(move(), CAL);
    expect(poses[48].slideMm).toBeCloseTo(200, 6);   // 20000 steps / 100 per mm
    expect(poses[48].panDeg).toBeCloseTo(90, 6);     // 9000 steps / 100 per deg
    expect(poses[0].slideMm).toBe(0);
  });

  it("scales with the calibration — the whole point of measuring the rig", () => {
    const half = sampleRig(move(), { ...CAL, slideStepsPerMm: 200 });
    expect(half[48].slideMm).toBeCloseTo(100, 6);
  });

  it("honours per-axis inversion", () => {
    const inv = sampleRig(move(), { ...CAL, invertPan: true });
    expect(inv[48].panDeg).toBeCloseTo(-90, 6);
  });

  it("matches the controller's own interpolation, not a second one", () => {
    // A 2-point move has zero endpoint velocities, so the Hermite is a smooth
    // ease — the midpoint must be at half travel, and NOT at the linear value
    // for any other sample. This is what ties the export to ADR-0009.
    const poses = sampleRig(move(), CAL);
    expect(poses[24].slideMm).toBeCloseTo(100, 3);
    expect(poses[12].slideMm).toBeLessThan(50);      // eased in, so behind linear
    expect(poses[36].slideMm).toBeGreaterThan(150);  // eased out, so ahead
  });
});

describe("USDA export", () => {
  const usd = exportUsda(move(), { calibration: CAL });

  it("declares the scale and up-axis explicitly rather than letting the importer guess", () => {
    expect(usd).toMatch(/^#usda 1\.0/);
    expect(usd).toContain("metersPerUnit = 1");
    expect(usd).toContain('upAxis = "Y"');
  });

  it("declares the shooting rate as the stage time base", () => {
    expect(usd).toContain("timeCodesPerSecond = 24");
    expect(usd).toContain("framesPerSecond = 24");
    expect(usd).toContain("startTimeCode = 0");
    expect(usd).toContain("endTimeCode = 48");
  });

  it("writes the exact rational rate for pulled-down timebases", () => {
    const f = move();
    f.timebase = { num: 24000, den: 1001, dropFrame: false };
    const out = exportUsda(f, { calibration: CAL });
    expect(out).toMatch(/timeCodesPerSecond = 23\.976023976/);
    expect(out).not.toContain("timeCodesPerSecond = 23.976\n");
  });

  it("exports the rig hierarchy, not a flattened camera", () => {
    expect(usd).toContain('def Xform "Carriage"');
    expect(usd).toContain('def Xform "Pan"');
    expect(usd).toContain('def Xform "Tilt"');
    expect(usd).toContain('def Camera "Camera"');
    // pan turns about the up axis
    expect(usd).toContain("xformOp:rotateY.timeSamples");
    expect(usd).toContain("xformOp:rotateX.timeSamples");
  });

  it("puts translation in scene units — metres by default", () => {
    expect(usd).toContain("48: (0.2, 0, 0)");    // 200 mm -> 0.2 m
  });

  it("switches to centimetres when asked, without changing the geometry", () => {
    const cm = exportUsda(move(), { calibration: CAL, metersPerUnit: 0.01 });
    expect(cm).toContain("metersPerUnit = 0.01");
    expect(cm).toContain("48: (20, 0, 0)");      // 200 mm -> 20 cm
  });

  it("rotates about Z for Z-up scenes (Blender / Houdini / Unreal)", () => {
    const z = exportUsda(move(), { calibration: CAL, upAxis: "Z" });
    expect(z).toContain('upAxis = "Z"');
    expect(z).toContain("xformOp:rotateZ.timeSamples");
  });

  it("carries the lens through to the camera prim", () => {
    const l = exportUsda(move(), { calibration: CAL, lens: { focalLengthMm: 50, sensorWidthMm: 36, sensorHeightMm: 24 } });
    expect(l).toContain("float focalLength = 50");
    expect(l).toContain("float horizontalAperture = 36");
    expect(l).toContain("float verticalAperture = 24");
  });

  it("offsets the camera from the tilt axis by the nodal distance", () => {
    const nod = exportUsda(move(), { calibration: { ...CAL, nodalOffsetMm: 120 } });
    expect(nod).toContain("double3 xformOp:translate = (0, 0, 0.12)");
  });

  it("records the calibration in the doc string so an orphaned file is still readable", () => {
    expect(usd).toContain("100 steps/mm slide");
  });
});

describe(".chan export", () => {
  const chan = exportChan(move(), { calibration: CAL });
  const lines = chan.trim().split("\n");

  it("writes one line per frame with 8 columns", () => {
    expect(lines).toHaveLength(49);
    expect(lines[0].split(" ")).toHaveLength(8);
  });

  it("numbers frames from the move's start timecode", () => {
    const f = move();
    f.startFrame = 86_400;                       // 01:00:00:00
    const out = exportChan(f, { calibration: CAL }).trim().split("\n");
    expect(out[0].split(" ")[0]).toBe("86400");
    expect(out[48].split(" ")[0]).toBe("86448");
  });

  it("puts tilt in rx, pan in ry, and zero in rz", () => {
    const last = lines[48].split(" ").map(Number);
    expect(last[1]).toBeCloseTo(0.2, 6);   // tx = 200 mm in metres
    expect(last[4]).toBeCloseTo(0, 6);     // rx = tilt (flat here)
    expect(last[5]).toBeCloseTo(90, 6);    // ry = pan
    expect(last[6]).toBe(0);               // rz always 0 — the rig has no roll
  });

  it("writes vertical field of view in degrees", () => {
    // 14 mm tall sensor on a 35 mm lens = 2*atan(7/35) = 22.62 deg
    expect(Number(lines[0].split(" ")[7])).toBeCloseTo(22.6199, 3);
  });
});

describe("After Effects keyframe data", () => {
  const ae = exportAfterEffects(move(), { calibration: CAL, pixelsPerMeter: 1000 });

  it("emits the header AE expects on paste", () => {
    expect(ae.startsWith("Adobe After Effects 8.0 Keyframe Data")).toBe(true);
    expect(ae.trimEnd().endsWith("End of Keyframe Data")).toBe(true);
    expect(ae).toContain("\tUnits Per Second\t24");
    expect(ae).toContain("Transform\tPosition");
    expect(ae).toContain("Transform\tOrientation");
  });

  it("maps metres to pixels with the mapping the operator chose", () => {
    // 200 mm at 1000 px/m = 200 px right of comp centre (1920/2 = 960).
    expect(ae).toMatch(/\n\t48\t1160\t/);
    const half = exportAfterEffects(move(), { calibration: CAL, pixelsPerMeter: 500 });
    expect(half).toMatch(/\n\t48\t1060\t/);
  });

  it("uses one row per frame in every block", () => {
    const rows = ae.split("\n").filter((l) => /^\t\d+\t/.test(l));
    expect(rows).toHaveLength(49 * 3);   // camera options + position + orientation
  });
});

describe("Nuke script", () => {
  const nk = exportNukeScript(move(), { calibration: CAL });

  it("declares its own rotation order, so it cannot be imported wrong", () => {
    expect(nk).toContain("rot_order YXZ");
  });

  it("writes baked curves starting at the move's start frame", () => {
    const f = move(); f.startFrame = 86_400;
    expect(exportNukeScript(f, { calibration: CAL })).toContain("{curve x86400 ");
  });

  it("carries the lens", () => {
    expect(nk).toContain("focal 35");
    expect(nk).toContain("haperture 24.89");
  });

  it("puts pan in the Y rotate slot and zero roll", () => {
    const rot = nk.match(/rotate \{(.+)\}\n/)?.[1] ?? "";
    expect(rot).toContain("90");           // pan reaches 90 deg
    expect(rot).toMatch(/\{curve x0 0\}/); // roll is a flat zero curve
  });
});

describe("CSV", () => {
  const csv = exportCsv(move(), { calibration: CAL });
  const lines = csv.trim().split("\n");

  it("has a header and one row per frame", () => {
    expect(lines).toHaveLength(50);
    expect(lines[0]).toContain("frame,timecode,ms,slide_steps");
  });

  it("carries both rig units and scene units so a mismatch is visible", () => {
    const last = lines[49].split(",");
    expect(last[3]).toBe("20000");    // slide steps
    expect(last[6]).toBe("200");      // slide mm
    expect(last[9]).toBe("0.2");      // scene units at 1 m
    expect(last[1]).toBe("00:00:02:00");
  });
});

describe("Alembic bridge", () => {
  it("generates a Blender script that names the right files", () => {
    const s = alembicConverterScript("jimini-pass-a.usda");
    expect(s).toContain("bpy.ops.wm.usd_import");
    expect(s).toContain("jimini-pass-a.usda");
    expect(s).toContain("jimini-pass-a.abc");
    expect(s).toContain("jimini-pass-a.fbx");
  });
});

describe("scale readout", () => {
  it("reports what the move actually covers, for a sanity check before export", () => {
    const e = moveExtents(move(), CAL);
    expect(e.slideMm.range).toBeCloseTo(200, 3);
    expect(e.panDeg.range).toBeCloseTo(90, 3);
    expect(e.tiltDeg.range).toBeCloseTo(0, 6);
  });

  it("moves with the calibration — a factor-of-ten error is visible here first", () => {
    expect(moveExtents(move(), { ...CAL, slideStepsPerMm: 10 }).slideMm.range).toBeCloseTo(2000, 3);
  });
});

describe("format registry", () => {
  it("lists every target with a writer and an operator-facing caveat", () => {
    expect(EXPORT_FORMATS.map((f) => f.id)).toEqual(["usda", "abc", "ae", "nk", "chan", "csv"]);
    for (const f of EXPORT_FORMATS) {
      expect(typeof f.write(move(), { calibration: DEFAULT_CALIBRATION })).toBe("string");
      expect(f.note.length).toBeGreaterThan(20);
    }
  });
});

describe("lens in the 3D export (ADR-0017)", () => {
  const withLens = () => {
    const f = move();
    const focus = { kind: "focus" as const, target: "focus", keys: [{ frame: 0, position: 0 }, { frame: 48, position: 1 }],
      map: { name: "m", kind: "focus" as const, marks: [{ position: 0, value: 1 }, { position: 1, value: 21 }] } };
    const zoom = { kind: "zoom" as const, target: "zoom", keys: [{ frame: 0, position: 0 }, { frame: 48, position: 1 }],
      map: { name: "z", kind: "zoom" as const, marks: [{ position: 0, value: 24 }, { position: 1, value: 70 }] } };
    const iris = { kind: "iris" as const, target: "iris", keys: [{ frame: 0, position: 0.5 }, { frame: 48, position: 0.5 }] };
    f.lensAxes = [focus, zoom, iris];
    return f;
  };

  it("animates the USD camera's focus distance and focal length", () => {
    const usd = exportUsda(withLens(), { calibration: CAL });
    expect(usd).toContain("float focusDistance.timeSamples");
    expect(usd).toContain("float focalLength.timeSamples");
    expect(usd).toMatch(/48: 21\b/);       // focus reaches 21 m
    expect(usd).toMatch(/48: 70\b/);       // zoom reaches 70 mm
  });

  it("converts focus distance into SCENE units, like every other length", () => {
    const cm = exportUsda(withLens(), { calibration: CAL, metersPerUnit: 0.01 });
    expect(cm).toMatch(/48: 2100\b/);      // 21 m -> 2100 cm
  });

  it("refuses to invent a distance for an UNMAPPED axis, and says so in the file", () => {
    const usd = exportUsda(withLens(), { calibration: CAL });
    expect(usd).not.toContain("fStop.timeSamples");
    expect(usd).toContain("NOT EXPORTED: iris");
  });

  it("falls back to the static lens when there are no lens axes at all", () => {
    const usd = exportUsda(move(), { calibration: CAL });
    expect(usd).toContain("float focalLength = 35");
    expect(usd).not.toContain("timeSamples = {\n                        0: 35");
  });

  it("puts both the travel fraction and the mapped value in the CSV", () => {
    const rows = exportCsv(withLens(), { calibration: CAL }).trim().split("\n");
    expect(rows[0]).toContain("focus_travel,focus_m");
    expect(rows[0]).toContain("iris_travel,iris_unmapped");
    // Index by header name rather than counting backwards — the column order
    // follows the move's lens axes, so a positional guess is a future bug.
    const cols = rows[0].split(","), last = rows[49].split(",");
    const at = (name: string) => last[cols.indexOf(name)];
    expect(at("zoom_mm")).toBe("70");
    expect(at("zoom_travel")).toBe("1");
    expect(at("focus_m")).toBe("21");
    expect(at("iris_unmapped")).toBe("");         // no map, so no invented value
  });
});
