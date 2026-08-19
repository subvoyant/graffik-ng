/**
 * Lens axes — focus, iris, zoom (ADR-0017).
 *
 * A camera move without focus is a camera move nobody can use: the rig repeats
 * its path exactly and the focus puller cannot, so the one thing multiplicity
 * promises — identical passes — breaks at the lens.
 *
 * WHY POSITIONS ARE NORMALISED 0..1
 * ---------------------------------
 * A lens motor drives a gear on the barrel. Its raw position is motor steps,
 * which mean nothing outside that motor on that lens on that day. What *is*
 * stable is the fraction of the barrel's travel — calibrate by driving to both
 * mechanical ends, and every position in between is a number between 0 and 1.
 *
 * Real-world units (feet, T-stops, millimetres) are then a **lens map**: the
 * witness marks off the barrel, recorded once per lens. That is exactly how the
 * job is done on set — an AC marks the barrel — and how Preston-style lens
 * files work. Storing feet directly would bake one lens into the move file and
 * silently lie the moment anybody changes glass.
 *
 * So: **0..1 is the truth, the map is the translation.** Everything downstream
 * (display, 3D export) reads through the map and degrades honestly without one.
 */

import { computeVelocities, splineAt, KeyFramePoint } from "./spline.js";

export type LensAxisKind = "focus" | "iris" | "zoom";
export const LENS_KINDS: readonly LensAxisKind[] = ["focus", "iris", "zoom"];

/** One witness mark: where on the barrel, and what it reads. */
export interface LensMark {
  /** Motor travel fraction, 0..1. */
  position: number;
  /**
   * The value at that mark, in the axis's natural unit:
   * focus = metres, iris = T-stop, zoom = millimetres.
   * Metres rather than feet because everything else downstream is metric and
   * one conversion at the display edge beats two in the middle.
   */
  value: number;
  /** Optional label as written on the barrel, e.g. `3'6"` or `T2.8`. */
  label?: string;
}

/**
 * The lens's marks, in travel order. Two marks is the minimum that means
 * anything; more marks make the interpolation honest across a non-linear
 * barrel, which focus scales always are.
 */
export interface LensMap {
  name: string;
  kind: LensAxisKind;
  marks: LensMark[];
  /** Free text — serial number, the AC who marked it, the date. */
  notes?: string;
}

export interface LensKey {
  frame: number;
  /** Motor travel fraction, 0..1. */
  position: number;
  velocity?: number;
}

export interface LensAxis {
  kind: LensAxisKind;
  /** Logical output name, bound to hardware in preferences (as cues are). */
  target: string;
  keys: LensKey[];
  /** Marks for this axis, if the lens has been mapped. */
  map?: LensMap;
}

/*
 * There is deliberately NO `invert` here.
 *
 * Which way a motor turns to move the barrel one way is a fact about how that
 * motor is mounted on that rig today — it is rig configuration, and it lives in
 * preferences beside the cue target bindings, for exactly the reason ADR-0016
 * gave for those: a move file has to survive being carried to another rig. A
 * v3 file did carry `invert` on the axis; v4 moved it out, because the version
 * where a saved focus pull silently runs backwards on someone else's rig is the
 * version nobody can debug.
 *
 * Downstream of here nothing flips anything: the move describes the BARREL, the
 * motor config describes the MOTOR, and the firmware reconciles the two at the
 * DIR pin where the handedness actually lives.
 */

export const LENS_UNITS: Record<LensAxisKind, { unit: string; label: string }> = {
  focus: { unit: "m", label: "Focus" },
  iris: { unit: "T", label: "Iris" },
  zoom: { unit: "mm", label: "Zoom" },
};

/* ------------------------------------------------------------------
   Lens maps — normalised position <-> real units
   ------------------------------------------------------------------ */

export function validateLensMap(map: LensMap): void {
  if (!map || typeof map !== "object") throw new Error("lens map must be an object");
  if (!LENS_KINDS.includes(map.kind)) throw new Error(`unknown lens axis kind: ${String(map.kind)}`);
  if (!Array.isArray(map.marks) || map.marks.length < 2) {
    throw new Error(`lens map "${map.name}": needs at least 2 marks to interpolate anything`);
  }
  let prev = -Infinity;
  for (const m of map.marks) {
    if (!Number.isFinite(m.position) || m.position < 0 || m.position > 1) {
      throw new Error(`lens map "${map.name}": mark positions must be 0..1 (got ${String(m.position)})`);
    }
    if (!Number.isFinite(m.value)) throw new Error(`lens map "${map.name}": non-numeric mark value`);
    if (m.position <= prev) throw new Error(`lens map "${map.name}": marks must be in increasing position order`);
    prev = m.position;
  }
}

/**
 * Real-world value at a travel position, linear between marks.
 *
 * Linear *between marks* rather than a fitted curve on purpose: a focus scale
 * is wildly non-linear, and the honest way to follow it is more marks, not a
 * cleverer curve through few. Outside the marked range the value is clamped to
 * the nearest mark — extrapolating a focus scale past its last witness mark
 * invents a distance the lens never claimed.
 */
export function lensValueAt(map: LensMap, position: number): number {
  const m = map.marks;
  if (position <= m[0].position) return m[0].value;
  if (position >= m[m.length - 1].position) return m[m.length - 1].value;
  for (let i = 0; i < m.length - 1; i++) {
    const a = m[i], b = m[i + 1];
    if (position >= a.position && position <= b.position) {
      const t = (position - a.position) / (b.position - a.position);
      return a.value + (b.value - a.value) * t;
    }
  }
  return m[m.length - 1].value;
}

/** Inverse: where on the barrel does this real value sit? */
export function lensPositionFor(map: LensMap, value: number): number {
  const m = map.marks;
  const rising = m[m.length - 1].value >= m[0].value;
  const first = m[0], last = m[m.length - 1];
  if (rising ? value <= first.value : value >= first.value) return first.position;
  if (rising ? value >= last.value : value <= last.value) return last.position;
  for (let i = 0; i < m.length - 1; i++) {
    const a = m[i], b = m[i + 1];
    const lo = Math.min(a.value, b.value), hi = Math.max(a.value, b.value);
    if (value >= lo && value <= hi && a.value !== b.value) {
      const t = (value - a.value) / (b.value - a.value);
      return a.position + (b.position - a.position) * t;
    }
  }
  return last.position;
}

/** Display string in the axis's natural unit, or a percentage without a map. */
export function formatLensValue(axis: LensAxis, position: number): string {
  if (!axis.map) return `${Math.round(position * 100)}%`;
  const v = lensValueAt(axis.map, position);   // barrel travel in, reading out — no flip
  const u = LENS_UNITS[axis.kind];
  if (axis.kind === "iris") return `T${v.toFixed(1)}`;
  if (axis.kind === "zoom") return `${Math.round(v)}${u.unit}`;
  return `${v < 10 ? v.toFixed(2) : v.toFixed(1)}${u.unit}`;
}

/* ------------------------------------------------------------------
   Solving — the SAME spline as the motion axes (ADR-0009)
   ------------------------------------------------------------------ */

/**
 * Sample a lens axis once per frame, through the same cubic-Hermite solver the
 * motion axes use. A second interpolation for lens would mean the focus curve
 * the operator draws and the focus the rig pulls are different shapes — the
 * exact failure ADR-0009 exists to prevent, transplanted to a new axis.
 *
 * Solved in FRAME space here (not ms) because a lens axis has no firmware
 * boundary demanding milliseconds; the frame grid is the whole model.
 */
export function sampleLensAxis(axis: LensAxis, durationFrames: number): number[] {
  if (!axis.keys.length) return new Array(durationFrames + 1).fill(0);
  if (axis.keys.length === 1) return new Array(durationFrames + 1).fill(clamp01(axis.keys[0].position));

  const pts: KeyFramePoint[] = axis.keys.map((k) => ({
    time: k.frame,
    position: k.position,
    ...(k.velocity === undefined ? {} : { velocity: k.velocity }),
  }));
  const solved = computeVelocities(pts);
  const out: number[] = [];
  for (let f = 0; f <= durationFrames; f++) out.push(clamp01(splineAt(solved, f).value));
  return out;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export function validateLensAxis(axis: LensAxis, durationFrames: number): void {
  if (!LENS_KINDS.includes(axis.kind)) throw new Error(`unknown lens axis kind: ${String(axis.kind)}`);
  if (typeof axis.target !== "string" || axis.target === "") throw new Error(`lens ${axis.kind}: needs a target`);
  if (!Array.isArray(axis.keys)) throw new Error(`lens ${axis.kind}: keys must be an array`);
  let prev = -Infinity;
  for (const k of axis.keys) {
    if (!Number.isInteger(k.frame)) throw new Error(`lens ${axis.kind}: keys must be on whole frames`);
    if (k.frame < 0 || k.frame > durationFrames) {
      throw new Error(`lens ${axis.kind}: frame ${k.frame} is outside the move (0..${durationFrames})`);
    }
    if (!Number.isFinite(k.position) || k.position < 0 || k.position > 1) {
      throw new Error(`lens ${axis.kind}: positions are travel fractions 0..1 (got ${String(k.position)})`);
    }
    if (k.frame <= prev) throw new Error(`lens ${axis.kind}: keys must be strictly increasing`);
    prev = k.frame;
  }
  if (axis.map) {
    validateLensMap(axis.map);
    if (axis.map.kind !== axis.kind) {
      throw new Error(`lens ${axis.kind}: map is for a ${axis.map.kind} axis`);
    }
  }
}

/** A blank axis: flat at mid-travel, which is a safe place to start marking. */
export function newLensAxis(kind: LensAxisKind, durationFrames: number): LensAxis {
  return {
    kind,
    target: kind,
    keys: [{ frame: 0, position: 0.5 }, { frame: durationFrames, position: 0.5 }],
  };
}

/* ==================================================================
   Device programs (ADR-0018)

   Everything above describes a lens axis. Everything below turns one
   into something a microcontroller can execute off its own clock —
   which is the only way a focus pull repeats between passes
   (ADR-0005 / ADR-0016 / ADR-0017 §4).
   ================================================================== */

/**
 * Positions go on the wire as 16-bit integers. 65 536 steps of resolution is
 * ~16× finer than any lens motor's actual travel, so quantisation is never the
 * limiting error, and an integer parses on an ATmega in microseconds where a
 * float does not.
 */
export const LENS_POS_MAX = 65535;

export const quantizeLensPos = (p: number): number =>
  Math.max(0, Math.min(LENS_POS_MAX, Math.round(clamp01(p) * LENS_POS_MAX)));

export interface LensProgramPoint {
  /** Milliseconds from the start of the move. */
  ms: number;
  /** Quantised travel, 0..65535. */
  pos: number;
}

export interface LensProgramAxis {
  kind: LensAxisKind;
  points: LensProgramPoint[];
  /** Fastest travel the curve demands, in travel-units per second. */
  peakUnitsPerSec: number;
  /** Where that peak occurs — the moment to look at when it is too fast. */
  peakAtMs: number;
}

export interface LensProgram {
  axes: LensProgramAxis[];
  /** Points before decimation, per axis — for reporting the compression. */
  sampledPoints: number;
  toleranceUnits: number;
}

/**
 * Douglas–Peucker with a VERTICAL error metric.
 *
 * The usual perpendicular-distance form would mix milliseconds and travel
 * units in one distance, which is meaningless — the answer would change if you
 * expressed the move in seconds instead. Vertical distance measures exactly the
 * thing worth bounding: *how far the device's linear interpolation can be from
 * the spline the operator drew, at any instant.* Under `toleranceUnits`, and a
 * focus pull is faithful; the units are the same 0..65535 the wire uses, so the
 * bound can be stated in motor steps once the barrel is calibrated.
 *
 * Iterative rather than recursive: a 30-second move at 60 fps is 1800 points,
 * and a degenerate curve would recurse 1800 deep on a stack we do not control.
 */
export function decimateLensPoints(points: LensProgramPoint[], toleranceUnits: number): LensProgramPoint[] {
  if (points.length <= 2) return [...points];
  const tol = Math.max(0, toleranceUnits);
  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = keep[points.length - 1] = true;

  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop()!;
    if (hi - lo < 2) continue;
    const a = points[lo], b = points[hi];
    const span = b.ms - a.ms;
    let worst = -1, worstAt = -1;
    for (let i = lo + 1; i < hi; i++) {
      const t = span === 0 ? 0 : (points[i].ms - a.ms) / span;
      const lerp = a.pos + (b.pos - a.pos) * t;
      const err = Math.abs(points[i].pos - lerp);
      if (err > worst) { worst = err; worstAt = i; }
    }
    if (worst > tol && worstAt > 0) {
      keep[worstAt] = true;
      stack.push([lo, worstAt], [worstAt, hi]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** Peak rate of change, and when. Used to pre-flight against motor top speed. */
export function lensPeakRate(points: LensProgramPoint[]): { unitsPerSec: number; atMs: number } {
  let peak = 0, at = 0;
  for (let i = 1; i < points.length; i++) {
    const dt = points[i].ms - points[i - 1].ms;
    if (dt <= 0) continue;
    const rate = (Math.abs(points[i].pos - points[i - 1].pos) * 1000) / dt;
    if (rate > peak) { peak = rate; at = points[i - 1].ms; }
  }
  return { unitsPerSec: peak, atMs: at };
}

/** What the operator told us about the motor on each barrel. */
export interface LensMotorLimit {
  /** Barrel travel in motor steps, from `LCAL`. 0 = not calibrated. */
  steps: number;
  /** The motor's usable top speed, steps/s — measured, not from a datasheet. */
  maxStepsPerSec: number;
}

export interface LensInfeasibility {
  kind: LensAxisKind;
  reason: string;
  requiredStepsPerSec: number;
  maxStepsPerSec: number;
  atMs: number;
}

/**
 * Pre-flight: can the motors actually do this pull?
 *
 * A curve is just a drawing until a motor has to follow it, and a lens motor
 * has a top speed a long way below a slider's. Discovering that the snap focus
 * at 00:14 was slewing at 6 000 steps/s on a 4 000 step/s motor belongs BEFORE
 * the take, next to `CueScheduler.unroutable()` — not in a log afterwards, and
 * certainly not in the rushes.
 */
export function lensFeasibility(
  program: LensProgram,
  limits: Partial<Record<LensAxisKind, LensMotorLimit>>,
): LensInfeasibility[] {
  const out: LensInfeasibility[] = [];
  for (const axis of program.axes) {
    const lim = limits[axis.kind];
    if (!lim) {
      out.push({
        kind: axis.kind, reason: `${axis.kind} has no motor configured on the lens device`,
        requiredStepsPerSec: 0, maxStepsPerSec: 0, atMs: 0,
      });
      continue;
    }
    if (!lim.steps) {
      out.push({
        kind: axis.kind, reason: `${axis.kind} is not calibrated — run Calibrate so the device knows the barrel's travel`,
        requiredStepsPerSec: 0, maxStepsPerSec: lim.maxStepsPerSec, atMs: 0,
      });
      continue;
    }
    /* units -> steps: the whole 0..65535 span IS the barrel, so one unit is
       steps/65535 of it. */
    const required = (axis.peakUnitsPerSec * lim.steps) / LENS_POS_MAX;
    if (lim.maxStepsPerSec > 0 && required > lim.maxStepsPerSec) {
      out.push({
        kind: axis.kind,
        reason:
          `${axis.kind} needs ${Math.round(required)} steps/s at ${(axis.peakAtMs / 1000).toFixed(2)}s ` +
          `but the motor tops out at ${lim.maxStepsPerSec} — the pull will lag, not clip`,
        requiredStepsPerSec: Math.round(required), maxStepsPerSec: lim.maxStepsPerSec, atMs: axis.peakAtMs,
      });
    }
  }
  return out;
}

/**
 * Tolerance in travel units for a given barrel. One motor step is the finest
 * distinction the hardware can make, so allowing half of one is free accuracy;
 * anything tighter just spends upload bytes on numbers the motor cannot reach.
 */
export const lensToleranceForSteps = (steps: number): number =>
  steps > 0 ? Math.max(1, LENS_POS_MAX / (2 * steps)) : DEFAULT_LENS_TOLERANCE_UNITS;

/**
 * ~0.05 % of travel. Used when the barrel has not been calibrated yet, chosen
 * to be finer than any plausible lens motor rather than tuned to one.
 */
export const DEFAULT_LENS_TOLERANCE_UNITS = 32;

/* ==================================================================
   The lens library (ADR-0019)

   Marks belong to a LENS, not to a move. A 35 mm prime has the same
   witness marks on Tuesday as it had on Monday, and a focus puller
   who has to re-mark it for every setup will stop marking it. Preston
   stores 150 lenses on the hand unit for exactly this reason.
   ================================================================== */

export interface LensLibraryEntry {
  /** Stable across renames and across machines — this is what merge matches on. */
  id: string;
  name: string;
  kind: LensAxisKind;
  marks: LensMark[];
  /** Serial number, who marked it, on what body, at what temperature. */
  notes?: string;
  /** ISO date, for "which of these two did I mark last week". */
  savedAt?: string;
}

export const LENS_LIBRARY_FORMAT = "graffik-ng.lenses";
export const LENS_LIBRARY_VERSION = 1;

export interface LensLibraryFile {
  format: typeof LENS_LIBRARY_FORMAT;
  version: number;
  lenses: LensLibraryEntry[];
}

export function validateLensLibraryEntry(e: LensLibraryEntry): void {
  if (!e || typeof e !== "object") throw new Error("lens entry must be an object");
  if (typeof e.id !== "string" || !e.id) throw new Error("lens entry needs an id");
  if (typeof e.name !== "string" || !e.name.trim()) throw new Error(`lens ${e.id} needs a name`);
  if (!LENS_KINDS.includes(e.kind)) throw new Error(`lens "${e.name}": unknown axis kind ${String(e.kind)}`);
  /* Reuse the map validator rather than write a second one — a library entry
     that would not be accepted as a map is a library entry that cannot be
     used, and finding that out at apply time is finding out too late. */
  validateLensMap({ name: e.name, kind: e.kind, marks: e.marks });
}

export function validateLensLibrary(file: LensLibraryFile): void {
  if (!file || typeof file !== "object") throw new Error("not a lens library file");
  if (file.format !== LENS_LIBRARY_FORMAT) {
    throw new Error(`not a Graffik lens library (format: ${String(file.format)})`);
  }
  if (!Number.isFinite(file.version) || file.version < 1) throw new Error("missing/invalid version");
  if (file.version > LENS_LIBRARY_VERSION) {
    throw new Error(`lens library version ${file.version} is newer than this app understands (${LENS_LIBRARY_VERSION})`);
  }
  if (!Array.isArray(file.lenses)) throw new Error("lens library has no lenses array");
  const seen = new Set<string>();
  for (const e of file.lenses) {
    validateLensLibraryEntry(e);
    if (seen.has(e.id)) throw new Error(`duplicate lens id in library: ${e.id}`);
    seen.add(e.id);
  }
}

export function serializeLensLibrary(lenses: LensLibraryEntry[]): string {
  const file: LensLibraryFile = { format: LENS_LIBRARY_FORMAT, version: LENS_LIBRARY_VERSION, lenses };
  validateLensLibrary(file);
  return JSON.stringify(file, null, 2);
}

export function parseLensLibrary(text: string): LensLibraryEntry[] {
  let raw: unknown;
  try { raw = JSON.parse(text); }
  catch { throw new Error("lens library file is not valid JSON"); }
  const file = raw as LensLibraryFile;
  validateLensLibrary(file);
  return file.lenses;
}

/** A library entry, ready to hang on an axis. */
export const lensEntryToMap = (e: LensLibraryEntry): LensMap => ({
  name: e.name,
  kind: e.kind,
  marks: e.marks.map((m) => ({ ...m })),
  ...(e.notes === undefined ? {} : { notes: e.notes }),
});

/** The map an operator just marked, ready to keep. */
export const lensMapToEntry = (map: LensMap, id: string, savedAt?: string): LensLibraryEntry => ({
  id,
  name: map.name,
  kind: map.kind,
  marks: map.marks.map((m) => ({ ...m })),
  ...(map.notes === undefined ? {} : { notes: map.notes }),
  ...(savedAt === undefined ? {} : { savedAt }),
});

export interface LensLibraryMerge {
  merged: LensLibraryEntry[];
  added: string[];
  updated: string[];
  /** Entries the incoming file could not contribute, and why. */
  rejected: Array<{ name: string; reason: string }>;
}

/**
 * Merge an imported library into the one already held.
 *
 * Matched on **id**, not name: two people can call a lens "35mm" and mean
 * different glass, and the same lens can be renamed without becoming a
 * different lens. Names are for humans; ids are for merging.
 *
 * A bad entry does NOT sink the import. Someone hands you a library with one
 * malformed lens in it, and refusing all 149 good ones because of it helps
 * nobody — so the survivors go in and the casualties are reported by name.
 */
export function mergeLensLibrary(existing: LensLibraryEntry[], incoming: LensLibraryEntry[]): LensLibraryMerge {
  const byId = new Map(existing.map((e) => [e.id, e]));
  const added: string[] = [], updated: string[] = [], rejected: LensLibraryMerge["rejected"] = [];
  for (const e of incoming) {
    try { validateLensLibraryEntry(e); }
    catch (err) { rejected.push({ name: e?.name ?? "(unnamed)", reason: (err as Error).message }); continue; }
    (byId.has(e.id) ? updated : added).push(e.name);
    byId.set(e.id, e);
  }
  const merged = [...byId.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
  return { merged, added, updated, rejected };
}

/**
 * An id for a lens marked on this machine. Not a UUID: no crypto in a
 * zero-dependency core, and this only has to be unique enough that two people
 * marking two different lenses on two machines do not collide. Caller supplies
 * the entropy, so the function stays pure and testable.
 */
export const lensLibraryId = (kind: LensAxisKind, name: string, salt: string): string =>
  `${kind}-${name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "lens"}-${salt}`;
