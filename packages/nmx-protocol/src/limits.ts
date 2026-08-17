/**
 * Soft travel limits — host-side guard rails (ADR-0013).
 *
 * Motion control has one catastrophic-and-cheap failure: driving the carriage
 * into a mechanical end stop with mass on it. The NMX has no encoder feedback,
 * so the firmware cannot know where "the end" is — a human has to teach it by
 * jogging there. We store those taught positions and refuse to exceed them.
 *
 * Enforcement is host-side because the host authors every move: jog speeds are
 * ours, and every keyframe position is known before upload. Nothing reaches the
 * controller unchecked.
 */

import { Film } from "./film.js";

export interface AxisLimit {
  /** Minimum allowed absolute step position, or null for "not taught". */
  min: number | null;
  /** Maximum allowed absolute step position, or null for "not taught". */
  max: number | null;
}

export type Limits = [AxisLimit, AxisLimit, AxisLimit];

export const NO_LIMITS: Limits = [
  { min: null, max: null },
  { min: null, max: null },
  { min: null, max: null },
];

export function isTaught(l: AxisLimit): boolean {
  return l.min !== null || l.max !== null;
}

/** True if `pos` is allowed for this axis. Untaught bounds never block. */
export function withinLimit(l: AxisLimit, pos: number): boolean {
  if (l.min !== null && pos < l.min) return false;
  if (l.max !== null && pos > l.max) return false;
  return true;
}

/** Clamp a position into the taught range. */
export function clampToLimit(l: AxisLimit, pos: number): number {
  let p = pos;
  if (l.min !== null) p = Math.max(l.min, p);
  if (l.max !== null) p = Math.min(l.max, p);
  return p;
}

/**
 * Would jogging at `stepsPerSec` from `pos` run past a limit within `lookaheadMs`?
 * Used to stop a jog *before* it arrives, since we poll position rather than
 * getting interrupts. Direction matters: you may always jog away from a limit,
 * which is what makes a violated state recoverable.
 */
export function jogWouldExceed(
  l: AxisLimit,
  pos: number,
  stepsPerSec: number,
  lookaheadMs = 250,
): boolean {
  if (stepsPerSec === 0) return false;
  const projected = pos + (stepsPerSec * lookaheadMs) / 1000;
  if (stepsPerSec > 0 && l.max !== null) return projected > l.max;
  if (stepsPerSec < 0 && l.min !== null) return projected < l.min;
  return false;
}

export interface LimitViolation {
  axis: 0 | 1 | 2;
  keyIndex: number;
  position: number;
  bound: "min" | "max";
  limit: number;
}

/**
 * Every keyframe in `film` that lies outside the taught range. Empty array
 * means the move is safe to upload. Checked before anything is sent, so a
 * bad move is rejected on the host rather than discovered by a noise.
 */
export function violationsForFilm(film: Film, limits: Limits): LimitViolation[] {
  const out: LimitViolation[] = [];
  for (const ax of film.axes) {
    const l = limits[ax.axis];
    if (!l || !isTaught(l)) continue;
    ax.points.forEach((p, keyIndex) => {
      if (l.min !== null && p.position < l.min) {
        out.push({ axis: ax.axis, keyIndex, position: p.position, bound: "min", limit: l.min });
      } else if (l.max !== null && p.position > l.max) {
        out.push({ axis: ax.axis, keyIndex, position: p.position, bound: "max", limit: l.max });
      }
    });
  }
  return out;
}

const AXIS_NAMES = ["Slide", "Pan", "Tilt"];

/** Human-readable summary for the UI/CLI — these strings surface verbatim. */
export function describeViolations(v: LimitViolation[]): string {
  if (v.length === 0) return "";
  const parts = v.slice(0, 4).map(
    (x) =>
      `${AXIS_NAMES[x.axis]} key ${x.keyIndex + 1} at ${Math.round(x.position)} exceeds ${x.bound} limit ${Math.round(x.limit)}`,
  );
  if (v.length > 4) parts.push(`…and ${v.length - 4} more`);
  return parts.join("; ");
}
