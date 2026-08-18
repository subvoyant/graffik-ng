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
  /** Flip if the motor runs the opposite way to the barrel's scale. */
  invert?: boolean;
}

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
  const v = lensValueAt(axis.map, position);
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
