/**
 * The flight recorder — what the rig actually did, recorded while it did it
 * (ADR-0027).
 *
 * Everything else in this codebase describes what the rig was *told* to do. The
 * whole promise of the project — multiplicity, the same move shot five times —
 * rests on a claim nobody has ever measured: that pass two lands where pass one
 * landed. `docs/HARDWARE-BRINGUP.md` answers that with a tape measure at the end
 * of the move, five times, which measures the endpoint and nothing in between.
 *
 * This module records position *during* the pass and compares passes to each
 * other and to the plan.
 *
 * Three facts from the firmware dispatch (ADR-0004) shape every decision here:
 *
 *  1. **Stepping runs off Timer1, not the main loop** (`OM_MotorMaster.ino`
 *     `startISR` → `Timer1.attachInterrupt(_runISR)`). Answering a serial query
 *     mid-move costs loop time, not steps. Sampling during a pass is therefore
 *     safe in a way it would not be on a firmware that bit-banged its steps.
 *  2. **Motor query 106 is rescaled while the motor is mid "send to"**:
 *     `curPos = isSending() ? (lastMs()/ms()) * curPos : curPos`. A send forces
 *     quarter-stepping without telling the host, so the value's *unit* changes
 *     underneath you. Motor query 124 answers "am I sending?" — a sample taken
 *     while it is true is recorded and marked **suspect**, never silently mixed
 *     in with the rest.
 *  3. **A key-frame move does not set that flag** (`sendTo(..., kf_move)` only
 *     calls `setSending(true)` when `!kf_move`), so run-phase samples are in the
 *     program's own microstep units. The pre-pass goto-to-first-keyframe is the
 *     phase that lies, and it is the phase we are not measuring.
 *
 * The join key between two passes is **the controller's own percent**, never
 * host time — same principle as the playhead (ADR-0025). Two passes started
 * three seconds apart are still the same move at 40%.
 *
 * Nothing here reads a clock or does I/O. Timestamps come from the caller.
 */

import type { Timebase } from "./timecode.js";

/** One observation of the rig, mid-pass. */
export interface PassSample {
  /** Host clock, ms since the pass began. Recorded for the record, not used to align. */
  atMs: number;
  /** The controller's own percent complete, 0..100. This is the join key. */
  percent: number;
  /** Steps per axis; `null` where the query failed or was not asked. */
  position: (number | null)[];
  /**
   * The firmware said at least one motor was mid "send to", so query 106 came
   * back rescaled (see the header). Excluded from comparison by default.
   */
  suspect: boolean;
  /** Wall-clock cost of collecting this whole sample, ms. */
  costMs: number;
}

export interface PassTrace {
  id: string;
  engine: "keyframe" | "classic";
  /** Supplied by the caller — this module never reads a clock. */
  startedAt: string;
  durationFrames: number;
  timebase: Timebase;
  /** Axis labels, in sample order. */
  axisNames: string[];
  /** Microstep setting per axis, read once at the start. Steps mean nothing without it. */
  microsteps: (number | null)[];
  samples: PassSample[];
  endedBy?: "complete" | "stopped" | "lost";
  note?: string;
}

export interface NewTraceOptions {
  id: string;
  engine: "keyframe" | "classic";
  startedAt: string;
  durationFrames: number;
  timebase: Timebase;
  axisNames: string[];
  microsteps?: (number | null)[];
}

export function newTrace(o: NewTraceOptions): PassTrace {
  return {
    id: o.id,
    engine: o.engine,
    startedAt: o.startedAt,
    durationFrames: o.durationFrames,
    timebase: o.timebase,
    axisNames: [...o.axisNames],
    microsteps: o.microsteps ? [...o.microsteps] : o.axisNames.map(() => null),
    samples: [],
  };
}

/**
 * Record one sample. Deliberately does NOT clamp, dedupe or enforce a monotonic
 * percent: a controller that reports 40% and then 38% is telling you something,
 * and a recorder that tidies that away is not a recorder.
 */
export function addSample(trace: PassTrace, sample: PassSample): void {
  trace.samples.push(sample);
}

/** A sample is usable for comparison only if it is not suspect and has a reading. */
const usableAt = (s: PassSample, axis: number) =>
  !s.suspect && typeof s.position[axis] === "number" && Number.isFinite(s.position[axis] as number);

export interface TraceCoverage {
  samples: number;
  /** Samples with at least one usable axis reading. */
  usable: number;
  suspect: number;
  /** Samples where every axis reading was missing. */
  failed: number;
  /** Percent range actually observed. */
  fromPercent: number;
  toPercent: number;
  /** Largest jump in percent between consecutive samples — the size of the biggest blind spot. */
  maxGapPct: number;
  /** Median cost of a sample, ms. This is how the rig tells you whether you may poll faster. */
  medianCostMs: number;
  /** True where the reported percent went backwards at least once. */
  wentBackwards: boolean;
}

export function traceCoverage(trace: PassTrace): TraceCoverage {
  const s = trace.samples;
  const usable = s.filter((x) => trace.axisNames.some((_, i) => usableAt(x, i))).length;
  const suspect = s.filter((x) => x.suspect).length;
  const failed = s.filter((x) => x.position.every((p) => p === null || !Number.isFinite(p as number))).length;
  const pcts = s.map((x) => x.percent);
  let maxGap = 0;
  let backwards = false;
  for (let i = 1; i < pcts.length; i++) {
    const d = pcts[i] - pcts[i - 1];
    if (d < 0) backwards = true;
    maxGap = Math.max(maxGap, Math.abs(d));
  }
  const costs = s.map((x) => x.costMs).sort((a, b) => a - b);
  const median = costs.length ? costs[Math.floor(costs.length / 2)] : 0;
  return {
    samples: s.length,
    usable,
    suspect,
    failed,
    fromPercent: pcts.length ? Math.min(...pcts) : 0,
    toPercent: pcts.length ? Math.max(...pcts) : 0,
    maxGapPct: maxGap,
    medianCostMs: median,
    wentBackwards: backwards,
  };
}

export interface ResampleOptions {
  /**
   * Refuse to interpolate across a hole bigger than this, in percent. Filling a
   * 30% gap with a straight line produces a number that looks like a
   * measurement and is not one.
   */
  maxGapPct?: number;
}

/**
 * Position of one axis at each percent on `grid`, linearly interpolated between
 * bracketing usable samples. `null` outside the covered span, or across a gap
 * wider than `maxGapPct`.
 */
export function resampleByPercent(
  trace: PassTrace,
  axis: number,
  grid: number[],
  opts: ResampleOptions = {},
): (number | null)[] {
  const maxGap = opts.maxGapPct ?? 10;
  const pts = trace.samples
    .filter((s) => usableAt(s, axis))
    .map((s) => ({ pct: s.percent, pos: s.position[axis] as number }))
    .sort((a, b) => a.pct - b.pct);
  if (pts.length === 0) return grid.map(() => null);

  return grid.map((g) => {
    if (g < pts[0].pct || g > pts[pts.length - 1].pct) return null;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      if (g >= a.pct && g <= b.pct) {
        if (b.pct - a.pct > maxGap) return null;
        if (b.pct === a.pct) return a.pos;
        const t = (g - a.pct) / (b.pct - a.pct);
        return a.pos + t * (b.pos - a.pos);
      }
    }
    return null;
  });
}

export interface AxisDeviation {
  axis: number;
  name: string;
  maxSteps: number;
  rmsSteps: number;
  /** Percent at which the worst deviation happened — where to go look. */
  atPercent: number;
  points: number;
  /**
   * The deviation this comparison could not have resolved even on a perfect rig,
   * because the controller reports percent in whole numbers. Below this, a
   * result means "at least this good", not "exactly this".
   */
  floorSteps: number;
  /** True when `maxSteps` is at or under the floor — the honest read of the number. */
  belowFloor: boolean;
}

export interface CompareResult {
  ok: boolean;
  /** Why the comparison was refused. Present only when `ok` is false. */
  reason?: string;
  perAxis: AxisDeviation[];
  /** Percent span both traces covered. */
  fromPercent: number;
  toPercent: number;
  comparedPoints: number;
}

export interface CompareOptions {
  /** Grid resolution in percent. */
  stepPct?: number;
  /** Refuse below this much shared coverage. */
  minSpanPct?: number;
  /** Refuse below this many compared points. */
  minPoints?: number;
  maxGapPct?: number;
  /**
   * How coarsely the controller reports percent. The firmware answers whole
   * numbers, so a matched-percent comparison cannot resolve motion finer than
   * one percent of the path. Set to 0 only if you have measured otherwise.
   */
  percentQuantum?: number;
}

const emptyCompare = (reason: string): CompareResult => ({
  ok: false, reason, perAxis: [], fromPercent: 0, toPercent: 0, comparedPoints: 0,
});

/** Steps of travel per one percent of the move, worst case over the span — the resolution floor. */
function slopePerPercent(values: (number | null)[], grid: number[]): number {
  let worst = 0;
  for (let i = 1; i < values.length; i++) {
    const a = values[i - 1];
    const b = values[i];
    if (a === null || b === null) continue;
    const dp = grid[i] - grid[i - 1];
    if (dp <= 0) continue;
    worst = Math.max(worst, Math.abs(b - a) / dp);
  }
  return worst;
}

/**
 * How far apart two passes of the same move were, axis by axis, compared at
 * matched controller percent.
 */
export function compareTraces(a: PassTrace, b: PassTrace, opts: CompareOptions = {}): CompareResult {
  const step = opts.stepPct ?? 1;
  const minSpan = opts.minSpanPct ?? 50;
  const minPoints = opts.minPoints ?? 5;
  const quantum = opts.percentQuantum ?? 1;

  if (a.axisNames.length !== b.axisNames.length) {
    return emptyCompare("these passes do not have the same axes");
  }
  const ca = traceCoverage(a);
  const cb = traceCoverage(b);
  const from = Math.max(ca.fromPercent, cb.fromPercent);
  const to = Math.min(ca.toPercent, cb.toPercent);
  if (to - from < minSpan) {
    return emptyCompare(
      `these passes only overlap over ${Math.max(0, Math.round(to - from))}% of the move ` +
      `(need ${minSpan}%) — one of them was not recorded end to end`,
    );
  }

  const grid: number[] = [];
  for (let p = from; p <= to + 1e-9; p += step) grid.push(Number(p.toFixed(6)));

  const perAxis: AxisDeviation[] = [];
  let comparedPoints = 0;
  for (let axis = 0; axis < a.axisNames.length; axis++) {
    const va = resampleByPercent(a, axis, grid, opts);
    const vb = resampleByPercent(b, axis, grid, opts);
    let max = 0, atPct = from, sum = 0, n = 0;
    for (let i = 0; i < grid.length; i++) {
      const x = va[i], y = vb[i];
      if (x === null || y === null) continue;
      const d = Math.abs(x - y);
      if (d > max) { max = d; atPct = grid[i]; }
      sum += d * d;
      n++;
    }
    comparedPoints = Math.max(comparedPoints, n);
    const floor = Math.max(slopePerPercent(va, grid), slopePerPercent(vb, grid)) * quantum;
    perAxis.push({
      axis,
      name: a.axisNames[axis],
      maxSteps: max,
      rmsSteps: n ? Math.sqrt(sum / n) : 0,
      atPercent: atPct,
      points: n,
      floorSteps: floor,
      belowFloor: n > 0 && max <= floor,
    });
  }

  if (comparedPoints < minPoints) {
    return emptyCompare(
      `only ${comparedPoints} point(s) could be compared (need ${minPoints}) — ` +
      `too many readings were missing or taken during a send`,
    );
  }
  return { ok: true, perAxis, fromPercent: from, toPercent: to, comparedPoints };
}

/**
 * How far the rig was from the move it was given, at matched percent.
 *
 * `plannedAt` is injected rather than imported so this module stays free of the
 * solver: the caller samples whatever it uploaded (ADR-0009 — one owner for the
 * motion math) and hands the positions back.
 */
export function deviationFromPlan(
  trace: PassTrace,
  plannedAt: (percent: number) => (number | null)[],
  opts: CompareOptions = {},
): CompareResult {
  const step = opts.stepPct ?? 1;
  const minSpan = opts.minSpanPct ?? 50;
  const minPoints = opts.minPoints ?? 5;
  const quantum = opts.percentQuantum ?? 1;

  const cov = traceCoverage(trace);
  if (cov.toPercent - cov.fromPercent < minSpan) {
    return emptyCompare(
      `this pass was only recorded over ${Math.max(0, Math.round(cov.toPercent - cov.fromPercent))}% ` +
      `of the move (need ${minSpan}%)`,
    );
  }

  const grid: number[] = [];
  for (let p = cov.fromPercent; p <= cov.toPercent + 1e-9; p += step) grid.push(Number(p.toFixed(6)));
  const planned = grid.map((g) => plannedAt(g));

  const perAxis: AxisDeviation[] = [];
  let comparedPoints = 0;
  for (let axis = 0; axis < trace.axisNames.length; axis++) {
    const measured = resampleByPercent(trace, axis, grid, opts);
    const want = planned.map((p) => (p && typeof p[axis] === "number" ? (p[axis] as number) : null));
    let max = 0, atPct = cov.fromPercent, sum = 0, n = 0;
    for (let i = 0; i < grid.length; i++) {
      const x = measured[i], y = want[i];
      if (x === null || y === null) continue;
      const d = Math.abs(x - y);
      if (d > max) { max = d; atPct = grid[i]; }
      sum += d * d;
      n++;
    }
    comparedPoints = Math.max(comparedPoints, n);
    const floor = Math.max(slopePerPercent(measured, grid), slopePerPercent(want, grid)) * quantum;
    perAxis.push({
      axis, name: trace.axisNames[axis],
      maxSteps: max, rmsSteps: n ? Math.sqrt(sum / n) : 0,
      atPercent: atPct, points: n, floorSteps: floor, belowFloor: n > 0 && max <= floor,
    });
  }

  if (comparedPoints < minPoints) {
    return emptyCompare(`only ${comparedPoints} point(s) could be compared (need ${minPoints})`);
  }
  return { ok: true, perAxis, fromPercent: cov.fromPercent, toPercent: cov.toPercent, comparedPoints };
}

/**
 * One line per axis, saying what the number means rather than only what it is.
 * A deviation at or below the resolution floor is reported as a bound, not a
 * measurement — the difference matters when somebody quotes it later.
 */
export function deviationLines(r: CompareResult): string[] {
  if (!r.ok) return [`not comparable — ${r.reason}`];
  return r.perAxis.map((d) =>
    d.points === 0
      ? `${d.name}: no overlapping readings`
      : d.belowFloor
        ? `${d.name}: within ±${d.floorSteps.toFixed(0)} steps — at or below what a whole-percent ` +
          `comparison can resolve, so this is a bound, not a measurement`
        : `${d.name}: max ${d.maxSteps.toFixed(0)} steps at ${d.atPercent.toFixed(0)}%, ` +
          `rms ${d.rmsSteps.toFixed(1)} (floor ±${d.floorSteps.toFixed(0)}, ${d.points} points)`,
  );
}

/** CSV of the raw record — one row per sample, units stated in the header. */
export function traceToCsv(trace: PassTrace): string {
  const head = [
    "at_ms", "percent", "suspect", "cost_ms",
    ...trace.axisNames.map((n, i) => `${n}_steps_ms${trace.microsteps[i] ?? "unknown"}`),
  ];
  const rows = trace.samples.map((s) => [
    s.atMs, s.percent, s.suspect ? 1 : 0, s.costMs,
    ...s.position.map((p) => (p === null ? "" : p)),
  ].join(","));
  return [head.join(","), ...rows].join("\n") + "\n";
}
