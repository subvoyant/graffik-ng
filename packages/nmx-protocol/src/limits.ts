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

/**
 * Creep speed for an axis whose travel nobody has taught yet (ADR-0023).
 *
 * The first jog on a new rig happens BEFORE any limits exist — that is the
 * order the procedure has to run in, because limits are taught by jogging to
 * them. So the one moment the soft-limit system cannot protect anything is
 * exactly the moment the operator knows least about the machine.
 *
 * A slow collision is a recoverable noise; a fast one bends a rail or drops a
 * camera off a head. Every motion-control operator creeps on first motion, and
 * the software should default to what they would do anyway.
 *
 * This clears itself: teach EITHER bound on an axis and it goes to full speed.
 * That is one button press, which is why there is no separate override to
 * forget you left on.
 */
export const UNTAUGHT_JOG_CAP = 500;

export interface CappedJog {
  stepsPerSec: number;
  capped: boolean;
  reason: string | null;
}

export function capUntaughtJog(l: AxisLimit, stepsPerSec: number, cap = UNTAUGHT_JOG_CAP): CappedJog {
  if (isTaught(l) || Math.abs(stepsPerSec) <= cap) {
    return { stepsPerSec, capped: false, reason: null };
  }
  return {
    stepsPerSec: Math.sign(stepsPerSec) * cap,
    capped: true,
    reason: `no travel taught on this axis yet — creeping at ${cap} steps/s. Teach a limit to unlock full speed.`,
  };
}
