/**
 * Move ("film") persistence — versioned JSON schema for saved camera moves.
 *
 * Lives in the headless core (not the app) so the schema has one owner,
 * round-trips are unit-testable, and the CLI can run saved moves.
 * See ADR-0010 for the format decision and ADR-0014 for the move to frames.
 *
 * **v2 stores time in FRAMES, not milliseconds.** A camera move is authored
 * against a shooting rate; a keyframe belongs to a frame, not to a millisecond
 * that happens to fall near one. Milliseconds are computed once, at the
 * protocol boundary, by `filmAxesToMs` / `filmDurationMs`.
 */

import { KeyFramePoint } from "./spline.js";
import { AxisIndex } from "./move.js";
import {
  Timebase, DEFAULT_TIMEBASE, validateTimebase, framesToMs, msToFrames, framesToTimecode,
} from "./timecode.js";
import {
  LensAxis, validateLensAxis, sampleLensAxis, quantizeLensPos, decimateLensPoints,
  lensPeakRate, lensToleranceForSteps, DEFAULT_LENS_TOLERANCE_UNITS,
  LensProgram, LensProgramPoint, LensAxisKind,
} from "./lens.js";

export const FILM_FORMAT = "graffik-ng-move";
export const FILM_VERSION = 4;

export interface FilmPoint {
  /** Whole frames from the start of the move. */
  frame: number;
  /** Steps. */
  position: number;
  /** Steps per ms. Omitted = solved at upload time (the normal case). */
  velocity?: number;
}

export interface FilmAxis {
  /** 0 = slide, 1 = pan, 2 = tilt (KF-engine indexing). */
  axis: AxisIndex;
  points: FilmPoint[];
}

/**
 * A cue on the timeline (ADR-0016). `target` is a LOGICAL output name —
 * "cue-light", not a port and channel — so a move file stays portable between
 * rigs; the binding to hardware lives in preferences.
 */
export interface FilmEvent {
  id: string;
  /** Frame the cue fires on. */
  frame: number;
  /** Sustained cues (a light held on) end this many frames later. */
  durationFrames?: number;
  target: string;
  action: EventAction;
  label?: string;
}

export type EventAction =
  | { kind: "pulse"; ms?: number }
  | { kind: "level"; value: number }
  | { kind: "camera" }
  | { kind: "dmx"; channel: number; value: number }
  | { kind: "midi"; status: number; data1: number; data2: number }
  | { kind: "osc"; address: string; args?: Array<number | string> };

export interface Film {
  format: typeof FILM_FORMAT;
  version: number;
  name: string;
  /** Shooting rate this move is authored against. Exact rational (ADR-0014). */
  timebase: Timebase;
  /** Total move length in frames. */
  durationFrames: number;
  /** Cue countdown before motion starts, in frames. */
  cueFrames: number;
  /**
   * Timecode of frame 0, as a frame count. Lets a move line up with the
   * camera's timecode so the pass can be handed to editorial or a 3D package
   * without anyone recalculating offsets by hand. 0 = start at 00:00:00:00.
   */
  startFrame: number;
  /** "classic" = 2-point program engine; "keyframe" = KF engine. */
  engine: "classic" | "keyframe";
  axes: FilmAxis[];
  /**
   * Lens axes — focus / iris / zoom (ADR-0017). Separate from `axes` because
   * they are a different kind of thing: `axes` are NMX motors measured in
   * steps and uploaded to firmware; these are normalised barrel travel driven
   * by something else entirely. Folding them into one array would have made
   * every existing consumer — soft limits, the KF upload, the 3D sampler —
   * start asking "which sort of axis is this?".
   */
  lensAxes?: LensAxis[];
  /** Timeline cues (ADR-0016). Optional so v2 files predating cues still load. */
  events?: FilmEvent[];
  /** ISO timestamp of last save (informational only). */
  savedAt?: string;
  notes?: string;
}

export function serializeFilm(film: Film): string {
  validateFilm(film);
  return JSON.stringify(film, null, 2);
}

/** Parse + validate, migrating older versions. Throws with a readable reason. */
export function deserializeFilm(json: string): Film {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("not valid JSON");
  }
  const f = migrateFilm(raw);
  validateFilm(f);
  return f;
}

/**
 * Bring an older file up to the current schema.
 *
 * v1 → v2: v1 stored milliseconds and carried no timebase, so the shooting rate
 * it was authored against is genuinely unknown. We assume 24 and convert real
 * time faithfully — the move runs exactly as it did before, and the frame
 * numbers are a best-effort label the operator can re-base if the shoot was on
 * another rate. Guessing silently would be worse than saying so, so
 * `notes` records the assumption in the file itself.
 */
export function migrateFilm(raw: unknown): Film {
  const f = raw as Record<string, unknown>;
  if (!f || typeof f !== "object") throw new Error("film must be an object");
  if (f.format !== FILM_FORMAT) throw new Error(`unknown format: ${String(f.format)}`);
  const version = Number(f.version);
  if (!Number.isFinite(version) || version < 1) throw new Error("missing/invalid version");
  if (version > FILM_VERSION) {
    throw new Error(`file version ${version} is newer than this app understands (${FILM_VERSION})`);
  }
  if (version === FILM_VERSION) return f as unknown as Film;

  /* v2 -> v3: v3 only ADDS optional `lensAxes`, so a v2 file is already a valid
     v3 one. The version still went up rather than the field going in quietly:
     a v0.9 build loading a v3 file must REFUSE it, because silently dropping a
     focus pull on save is precisely the data loss versioning exists to stop. */
  if (version === 2) return migrateV3ToV4({ ...(f as unknown as Film), version: 3 });
  if (version === 3) return migrateV3ToV4(f as unknown as Film);

  // ---- v1 (milliseconds, no timebase) ----
  const tb = DEFAULT_TIMEBASE;
  const durationMs = Number(f.durationMs);
  const startDelayMs = Number(f.startDelayMs ?? 0);
  if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error("v1 film: durationMs must be > 0");
  const axes = (f.axes as Array<{ axis: AxisIndex; points: Array<{ time: number; position: number; velocity?: number }> }>) ?? [];
  const note =
    "Migrated from format v1 on load. v1 stored milliseconds and carried no timebase, " +
    "so 24 fps was assumed; real-time duration is preserved exactly. If this move was " +
    "shot at another rate, change the timebase — the frame numbers will re-derive.";
  return {
    format: FILM_FORMAT,
    version: FILM_VERSION,
    name: String(f.name ?? "Untitled Move"),
    timebase: tb,
    durationFrames: msToFrames(durationMs, tb),
    cueFrames: msToFrames(startDelayMs, tb),
    startFrame: 0,
    engine: (f.engine === "classic" ? "classic" : "keyframe"),
    axes: axes.map((ax) => ({
      axis: ax.axis,
      points: ax.points.map((p) => ({
        frame: msToFrames(p.time, tb),
        position: p.position,
        ...(p.velocity === undefined ? {} : { velocity: p.velocity }),
      })),
    })),
    savedAt: typeof f.savedAt === "string" ? f.savedAt : undefined,
    notes: [f.notes, note].filter(Boolean).join("\n"),
  };
}

export function validateFilm(f: Film): void {
  if (!f || typeof f !== "object") throw new Error("film must be an object");
  if (f.format !== FILM_FORMAT) throw new Error(`unknown format: ${String((f as { format?: unknown }).format)}`);
  if (typeof f.version !== "number" || f.version < 1) throw new Error("missing/invalid version");
  if (f.version > FILM_VERSION) throw new Error(`file version ${f.version} is newer than this app understands (${FILM_VERSION})`);
  if (typeof f.name !== "string") throw new Error("missing name");
  validateTimebase(f.timebase);
  if (!Number.isInteger(f.durationFrames) || f.durationFrames <= 0) throw new Error("durationFrames must be a positive integer");
  if (!Number.isInteger(f.cueFrames) || f.cueFrames < 0) throw new Error("cueFrames must be a non-negative integer");
  if (!Number.isInteger(f.startFrame)) throw new Error("startFrame must be an integer");
  if (f.engine !== "classic" && f.engine !== "keyframe") throw new Error(`unknown engine: ${String(f.engine)}`);
  if (!Array.isArray(f.axes) || f.axes.length === 0) throw new Error("axes must be a non-empty array");
  for (const ax of f.axes) {
    if (![0, 1, 2].includes(ax.axis)) throw new Error(`invalid axis index: ${String(ax.axis)}`);
    if (!Array.isArray(ax.points) || ax.points.length < 2) throw new Error(`axis ${ax.axis}: needs >= 2 points`);
    let prev = -Infinity;
    for (const p of ax.points) {
      if (!Number.isInteger(p.frame)) throw new Error(`axis ${ax.axis}: keyframe times must be whole frames (got ${String(p.frame)})`);
      if (!Number.isFinite(p.position)) throw new Error(`axis ${ax.axis}: non-numeric position`);
      if (p.frame <= prev) throw new Error(`axis ${ax.axis}: keyframes must be strictly increasing`);
      if (p.frame < 0 || p.frame > f.durationFrames) {
        throw new Error(`axis ${ax.axis}: frame ${p.frame} is outside the move (0..${f.durationFrames})`);
      }
      prev = p.frame;
    }
  }
  validateEvents(f);
  validateLensAxes(f);
}

export function validateLensAxes(f: Film): void {
  if (f.lensAxes === undefined) return;
  if (!Array.isArray(f.lensAxes)) throw new Error("lensAxes must be an array");
  const seen = new Set<string>();
  for (const ax of f.lensAxes) {
    if (seen.has(ax.kind)) throw new Error(`duplicate lens axis: ${ax.kind}`);
    seen.add(ax.kind);
    validateLensAxis(ax, f.durationFrames);
  }
}

const EVENT_KINDS = new Set(["pulse", "level", "camera", "dmx", "midi", "osc"]);

export function validateEvents(f: Film): void {
  if (f.events === undefined) return;
  if (!Array.isArray(f.events)) throw new Error("events must be an array");
  const seen = new Set<string>();
  for (const e of f.events) {
    if (!e || typeof e !== "object") throw new Error("event must be an object");
    if (typeof e.id !== "string" || e.id === "") throw new Error("event needs a non-empty id");
    if (seen.has(e.id)) throw new Error(`duplicate event id: ${e.id}`);
    seen.add(e.id);
    if (!Number.isInteger(e.frame)) throw new Error(`event ${e.id}: frame must be a whole frame`);
    if (e.frame < 0 || e.frame > f.durationFrames) {
      throw new Error(`event ${e.id}: frame ${e.frame} is outside the move (0..${f.durationFrames})`);
    }
    if (e.durationFrames !== undefined) {
      if (!Number.isInteger(e.durationFrames) || e.durationFrames < 0) {
        throw new Error(`event ${e.id}: durationFrames must be a non-negative integer`);
      }
      if (e.frame + e.durationFrames > f.durationFrames) {
        throw new Error(`event ${e.id}: ends past the end of the move`);
      }
    }
    if (typeof e.target !== "string" || e.target === "") throw new Error(`event ${e.id}: needs a target`);
    if (!e.action || !EVENT_KINDS.has(e.action.kind)) {
      throw new Error(`event ${e.id}: unknown action kind ${String(e.action && e.action.kind)}`);
    }
    if (e.action.kind === "dmx") {
      if (!Number.isInteger(e.action.channel) || e.action.channel < 1 || e.action.channel > 512) {
        throw new Error(`event ${e.id}: DMX channel must be 1..512`);
      }
      if (!Number.isInteger(e.action.value) || e.action.value < 0 || e.action.value > 255) {
        throw new Error(`event ${e.id}: DMX value must be 0..255`);
      }
    }
  }
}

/**
 * The cue list handed to a Tier-2 device before a pass (ADR-0016): milliseconds
 * from GO, sorted, because that is what a microcontroller counts. Frames are
 * converted here — at the boundary — exactly as keyframes are.
 */
export interface Cue { id: string; atMs: number; endMs?: number; target: string; action: EventAction }

export function buildCueList(f: Film): Cue[] {
  return (f.events ?? [])
    .map((e) => ({
      id: e.id,
      atMs: framesToMs(e.frame, f.timebase),
      ...(e.durationFrames === undefined
        ? {}
        : { endMs: framesToMs(e.frame + e.durationFrames, f.timebase) }),
      target: e.target,
      action: e.action,
    }))
    .sort((a, b) => a.atMs - b.atMs || a.id.localeCompare(b.id));
}

/**
 * Build the device program for every lens lane (ADR-0018).
 *
 * The counterpart to `buildCueList`, and it lives beside it for the same
 * reason: both cross the one boundary where frames become milliseconds
 * (ADR-0014), and both hand a microcontroller something it can run off its own
 * clock without the host in the loop.
 *
 * Sampled per frame from the SAME solver as the preview and the NMX upload
 * (ADR-0009), then decimated under an explicit error bound. Decimation is not
 * an optimisation for its own sake: a 30 s pull is 720 points per axis, and
 * three axes of that is 34 kB of text down a serial line while a performer
 * waits. Under a half-step bound a real focus pull comes out in tens of points,
 * and the device's linear interpolation is inside the motor's own resolution —
 * so nothing observable was given up to get there.
 */
export function buildLensProgram(
  f: Film,
  opts: { toleranceUnits?: number; motorSteps?: Partial<Record<LensAxisKind, number>> } = {},
): LensProgram {
  const axes = f.lensAxes ?? [];
  const out: LensProgram = { axes: [], sampledPoints: f.durationFrames + 1, toleranceUnits: 0 };
  const tolerances: number[] = [];

  for (const ax of axes) {
    const samples = sampleLensAxis(ax, f.durationFrames);
    const dense: LensProgramPoint[] = samples.map((v, frame) => ({
      ms: framesToMs(frame, f.timebase),
      /* Barrel travel, straight through. Motor handedness is rig config and is
         applied by the DEVICE at its DIR pin (ADR-0018) — flipping it here
         would mean the same move file produced different motion depending on
         which machine encoded it. */
      pos: quantizeLensPos(v),
    }));
    const tol = opts.toleranceUnits ?? lensToleranceForSteps(opts.motorSteps?.[ax.kind] ?? 0);
    tolerances.push(tol);
    const points = decimateLensPoints(dense, tol);
    /* Peak rate comes from the DENSE curve, deliberately. A decimated chord's
       slope is a weighted average of the segment slopes it replaces, so it can
       never exceed the dense maximum — measuring the dense curve is therefore
       the conservative bound, and it means decimation can never quietly hide a
       snap from the feasibility pre-flight. */
    const peak = lensPeakRate(dense);
    out.axes.push({ kind: ax.kind, points, peakUnitsPerSec: peak.unitsPerSec, peakAtMs: peak.atMs });
  }
  out.toleranceUnits = tolerances.length ? Math.min(...tolerances) : DEFAULT_LENS_TOLERANCE_UNITS;
  return out;
}

/** Total points across every axis — what the device must find room for. */
export const lensProgramSize = (p: LensProgram): number =>
  p.axes.reduce((n, a) => n + a.points.length, 0);

/**
 * v3 -> v4: `lensAxes[].invert` moves OUT of the move file.
 *
 * It should never have been in it. Whether a lens motor is geared backwards is
 * a fact about a rig on a day, and a move that carries it reverses a focus pull
 * the moment the file is opened somewhere else — the failure ADR-0016 already
 * moved cue bindings into preferences to avoid.
 *
 * The setting cannot be written to preferences from here (the core knows
 * nothing about an app), so it is dropped and the fact is written into `notes`
 * — the same idiom the v1 -> v2 timebase assumption uses. Saying it in the file
 * is the difference between an operator who re-ticks one box and one who spends
 * a take wondering why the pull runs the wrong way.
 */
function migrateV3ToV4(f: Film): Film {
  const flipped = (f.lensAxes ?? [])
    .filter((a) => (a as unknown as { invert?: boolean }).invert)
    .map((a) => a.kind);
  const lensAxes = f.lensAxes?.map((a) => {
    const { ...rest } = a as LensAxis & { invert?: boolean };
    delete (rest as { invert?: boolean }).invert;
    return rest as LensAxis;
  });
  const note = flipped.length
    ? `v3->v4: "motor runs backwards" for ${flipped.join(", ")} moved to rig settings; set it in Lens… if the pull comes out reversed.`
    : null;
  return {
    ...f,
    version: FILM_VERSION,
    ...(lensAxes ? { lensAxes } : {}),
    ...(note ? { notes: f.notes ? `${f.notes}\n${note}` : note } : {}),
  };
}

/* ------------------------------------------------------------------
   The protocol boundary: frames in, milliseconds out. Nothing upstream
   of these two functions should ever hold a millisecond (ADR-0014).
   ------------------------------------------------------------------ */

/** Move length in ms, for the KF engine's video-time field. */
export function filmDurationMs(f: Film): number {
  return framesToMs(f.durationFrames, f.timebase);
}

/** Cue countdown in ms, for the host-side countdown UI. */
export function filmCueMs(f: Film): number {
  return framesToMs(f.cueFrames, f.timebase);
}

/** Axes with keyframe times converted to ms, ready for `buildKeyFrameMove`. */
export function filmAxesToMs(f: Film): Array<{ axis: AxisIndex; points: KeyFramePoint[] }> {
  return f.axes.map((ax) => ({
    axis: ax.axis,
    points: ax.points.map((p) => ({
      time: framesToMs(p.frame, f.timebase),
      position: p.position,
      ...(p.velocity === undefined ? {} : { velocity: p.velocity }),
    })),
  }));
}

/** Timecode label for a frame within this move (honours `startFrame`). */
/** A sensible empty film for a new document: 10 seconds at the given rate. */
export function newFilm(name = "Untitled Move", durationFrames?: number, timebase: Timebase = DEFAULT_TIMEBASE): Film {
  const dur = durationFrames ?? Math.round((timebase.num / timebase.den) * 10);
  const cue = Math.round((timebase.num / timebase.den) * 5);
  return {
    format: FILM_FORMAT,
    version: FILM_VERSION,
    name,
    timebase,
    durationFrames: dur,
    cueFrames: cue,
    startFrame: 0,
    engine: "keyframe",
    axes: [
      { axis: 0, points: [{ frame: 0, position: 0 }, { frame: dur, position: 0 }] },
      { axis: 1, points: [{ frame: 0, position: 0 }, { frame: dur, position: 0 }] },
      { axis: 2, points: [{ frame: 0, position: 0 }, { frame: dur, position: 0 }] },
    ],
  };
}
