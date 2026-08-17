/**
 * Cubic Hermite spline utilities for key-frame moves.
 *
 * The NMX firmware's key-frame engine interpolates a cubic Hermite spline
 * on-device from per-keyframe arrays of abscissa (xn), position (fn), and
 * velocity (dn) — the host must supply the velocity at every key frame.
 * Endpoint velocities are 0 (the rig is at rest); interior velocities should
 * be as large as possible WITHOUT the spline overshooting and reversing
 * direction between neighbors (a reversal on a camera move reads as a bounce).
 *
 * The math here is the standard cubic Hermite segment in Newton form —
 * identical to what the firmware evaluates. The interior-velocity search
 * reproduces the observed behavior of the official NMX Motion app (velocity
 * maximized up to the monotonicity boundary, checked by sampling the segment
 * derivative), implemented independently via bisection.
 */

export interface KeyFramePoint {
  /** Abscissa: milliseconds (video mode) or frame number (SMS). */
  time: number;
  /** Motor position, steps. */
  position: number;
  /** Velocity at this key frame (steps per abscissa unit). Computed if absent. */
  velocity?: number;
}

interface Sampled {
  value: number;
  derivative: number;
}

/** Evaluate one cubic Hermite segment at x. */
function cubicSegment(
  x1: number, f1: number, d1: number,
  x2: number, f2: number, d2: number,
  x: number,
): Sampled {
  const h = x2 - x1;
  const df = (f2 - f1) / h;
  const c2 = -(2 * d1 - 3 * df + d2) / h;
  const c3 = (d1 - 2 * df + d2) / (h * h);
  const t = x - x1;
  return {
    value: f1 + t * (d1 + t * (c2 + t * c3)),
    derivative: d1 + t * (2 * c2 + t * 3 * c3),
  };
}

/** Evaluate the full spline (segments selected by abscissa) at x. */
export function splineAt(points: readonly Required<KeyFramePoint>[], x: number): Sampled {
  const clamped = Math.min(Math.max(x, points[0].time), points[points.length - 1].time);
  let seg = 0;
  for (let i = 0; i < points.length - 1; i++) {
    if (clamped >= points[i].time && clamped <= points[i + 1].time) {
      seg = i;
      break;
    }
  }
  const a = points[seg];
  const b = points[seg + 1];
  return cubicSegment(a.time, a.position, a.velocity, b.time, b.position, b.velocity, clamped);
}

const SAMPLES = 100;

/** Does the spline reverse direction between points i0 and i1? */
function reverses(points: readonly Required<KeyFramePoint>[], i0: number, i1: number): boolean {
  const startX = points[i0].time;
  const stopX = points[i1].time;
  const positive = points[i1].position - points[i0].position >= 0;
  const step = (stopX - startX) / SAMPLES;
  for (let i = 0; i < SAMPLES; i++) {
    const { derivative } = splineAt(points, startX + i * step);
    if (positive ? derivative < 0 : derivative > 0) return true;
  }
  return false;
}

/**
 * Fill in velocities: 0 at the endpoints; each interior key frame gets the
 * largest-magnitude velocity (in the direction of overall travel across its
 * neighbors) for which the spline still moves monotonically between those
 * neighbors. Skipped (left at 0) when the interior point is a local extreme
 * or a plateau — matching the official app's behavior.
 */
export function computeVelocities(points: readonly KeyFramePoint[]): Required<KeyFramePoint>[] {
  if (points.length < 2) throw new Error("a move needs at least 2 key frames");
  for (let i = 1; i < points.length; i++) {
    if (points[i].time <= points[i - 1].time) {
      throw new Error(`key frame times must be strictly increasing (index ${i})`);
    }
  }
  const result: Required<KeyFramePoint>[] = points.map((p) => ({
    time: p.time,
    position: p.position,
    velocity: p.velocity ?? 0,
  }));

  for (let i = 1; i < result.length - 1; i++) {
    if (points[i].velocity !== undefined) continue; // caller-specified — keep
    const before = result[i - 1].position;
    const here = result[i].position;
    const after = result[i + 1].position;
    // local extreme or plateau: velocity stays 0
    if (before === here || after === here) continue;
    if ((before > here && after > here) || (before < here && after < here)) continue;

    const direction = after - before >= 0 ? 1 : -1;
    // Bisect for the largest magnitude that does not cause a reversal.
    // Upper bound: average slope across the neighbors, generously scaled.
    let lo = 0;
    let hi = Math.abs((after - before) / (result[i + 1].time - result[i - 1].time)) * 4;
    for (let iter = 0; iter < 60; iter++) {
      const mid = (lo + hi) / 2;
      result[i].velocity = direction * mid;
      if (reverses(result, i - 1, i + 1)) hi = mid;
      else lo = mid;
    }
    // Back off the exact boundary slightly: at the limit the spline can
    // micro-overshoot between reversal-check samples (sub-microstep scale,
    // but keep a clean margin).
    result[i].velocity = direction * lo * 0.995;
  }
  return result;
}
