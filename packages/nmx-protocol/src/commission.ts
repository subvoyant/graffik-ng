/**
 * Rig commissioning — turning a tape measure into numbers the software can use
 * (ADR-0020).
 *
 * The NMX has no encoder. It reports **motor steps**, and how far a step moves
 * the carriage is belt pitch times pulley diameter times gear ratio times the
 * driver's microstep setting — a property of one physical rig on one day. Until
 * somebody measures it, a 3D export (ADR-0015) is a shape, not a camera move,
 * and it has been described that way in the docs for four versions because
 * nothing in the app helped anybody measure it.
 *
 * Everything here is arithmetic on numbers a human read off a rule. That is the
 * point: the measurement is physical and cannot be automated, but the
 * arithmetic, the error estimate and the "that number looks wrong" check can
 * all be done properly instead of on the back of a call sheet.
 */

/** One measured span: how many steps the axis moved, and how far that was. */
export interface CalObservation {
  /** Motor steps travelled — the difference between two reported positions. */
  steps: number;
  /** What a rule or an inclinometer said: millimetres, or degrees. */
  measured: number;
  /** Free text — "tape, 2nd read", "inclinometer", "laser @ 4 m". */
  note?: string;
}

export type CalUnit = "mm" | "deg";

export interface CalResult {
  /** Steps per millimetre, or steps per degree. */
  perUnit: number;
  n: number;
  /**
   * Peak-to-peak disagreement between the spans, as a percentage of the mean.
   *
   * Peak-to-peak rather than deviation-from-the-mean deliberately: with two
   * measurements the latter is exactly half the disagreement the operator can
   * see between their own two numbers, and a warning that says "these disagree
   * by X%" while printing half of X is a warning that teaches people to
   * distrust it.
   */
  spreadPct: number;
  /**
   * The observation furthest from the mean — the one to re-measure first.
   *
   * **Null below three observations.** With two that disagree, both sit exactly
   * the same distance from their own mean and nothing here can tell you which
   * one is wrong; naming either would be the app inventing a culprit. A third
   * span breaks the tie, which is why the warning asks for one.
   */
  worst: CalObservation | null;
  /** Operator-facing sentences. Empty means nothing looked wrong. */
  warnings: string[];
}

/**
 * Fit a calibration from measured spans.
 *
 * Each observation contributes its own steps-per-unit and they are averaged —
 * deliberately NOT a least-squares line through absolute positions. A line has
 * an intercept, an intercept absorbs backlash and measurement offset, and a fit
 * that quietly absorbs your errors is a fit that stops telling you about them.
 * The spread across independent spans IS the error estimate, and it is the
 * number that tells an operator whether to measure again.
 */
export function fitCalibration(observations: CalObservation[], unit: CalUnit): CalResult {
  const usable = observations.filter((o) => Number.isFinite(o.steps) && Number.isFinite(o.measured) && o.measured !== 0);
  if (!usable.length) {
    return { perUnit: 0, n: 0, spreadPct: 0, worst: null, warnings: ["no usable measurements yet"] };
  }
  const ratios = usable.map((o) => Math.abs(o.steps / o.measured));
  const perUnit = ratios.reduce((a, b) => a + b, 0) / ratios.length;

  const spreadPct = perUnit === 0 ? 0 : ((Math.max(...ratios) - Math.min(...ratios)) / perUnit) * 100;
  let worst: CalObservation | null = null;
  if (usable.length >= 3) {
    let worstDev = -1;
    ratios.forEach((r, i) => {
      const dev = Math.abs(r - perUnit);
      if (dev > worstDev) { worstDev = dev; worst = usable[i]; }
    });
  }

  const warnings: string[] = [];
  if (usable.length === 1) {
    warnings.push("one measurement cannot disagree with itself — take a second span before trusting this");
  }
  if (spreadPct > 2) {
    warnings.push(
      usable.length === 2
        ? `the two measurements disagree by ${spreadPct.toFixed(1)}% — one of them is wrong and nothing here can tell you which; take a third span`
        : `measurements disagree by ${spreadPct.toFixed(1)}% — re-measure the marked span; a slipped mark or a short baseline is the usual cause`,
    );
  }
  /* A fixed reading error over a short baseline is a large percentage error.
     0.5 mm on 50 mm is 1%; on 500 mm it is 0.1%. Say so while it can be fixed. */
  const shortest = Math.min(...usable.map((o) => Math.abs(o.measured)));
  if (unit === "mm" && shortest < 200) {
    warnings.push(`shortest span is only ${shortest} mm — a ~0.5 mm reading error is ${((0.5 / shortest) * 100).toFixed(1)}% here; use 400 mm or more`);
  }
  if (unit === "deg" && shortest < 45) {
    warnings.push(`shortest span is only ${shortest}° — rotation is hard to read; use 90° or more`);
  }
  warnings.push(...plausibilityWarnings(perUnit, unit));
  return { perUnit, n: usable.length, spreadPct, worst, warnings };
}

/**
 * Magnitudes that are almost certainly a slip rather than an unusual rig.
 * Bounds are deliberately generous — the job is to catch a decimal point, not
 * to have an opinion about somebody's gearbox.
 */
export function plausibilityWarnings(perUnit: number, unit: CalUnit): string[] {
  const out: string[] = [];
  if (!Number.isFinite(perUnit) || perUnit <= 0) return ["result is not a usable number"];
  if (unit === "mm" && (perUnit < 1 || perUnit > 20000)) {
    out.push(`${perUnit.toFixed(2)} steps/mm is outside anything plausible — check you entered millimetres, not centimetres or inches`);
  }
  if (unit === "deg" && (perUnit < 1 || perUnit > 100000)) {
    out.push(`${perUnit.toFixed(2)} steps/° is outside anything plausible — check the angle units`);
  }
  return out;
}

/**
 * Compare a new measurement against one already held, and name the usual
 * suspects when they disagree.
 *
 * The two diagnostics come straight from ADR-0015: a factor of ~100 is a unit
 * setting (millimetres against centimetres), and a clean power of two is the
 * driver's microstep jumper. Both produce a number that looks entirely
 * reasonable on its own and is wrong by an order of magnitude in the export.
 */
export function diagnoseCalibration(measured: number, reference: number): string | null {
  if (!Number.isFinite(measured) || !Number.isFinite(reference) || measured <= 0 || reference <= 0) return null;
  const ratio = measured / reference;
  const near = (v: number, target: number) => Math.abs(v - target) / target < 0.03;

  for (const f of [100, 10, 1000]) {
    if (near(ratio, f)) return `${f}x the stored value — almost always a unit slip (${f === 10 ? "cm vs mm" : "check mm vs cm vs m"})`;
    if (near(1 / ratio, f)) return `1/${f} of the stored value — almost always a unit slip`;
  }
  for (const f of [2, 4, 8, 16, 32]) {
    if (near(ratio, f)) return `exactly ${f}x the stored value — that is the driver's microstep setting, not the rig`;
    if (near(1 / ratio, f)) return `exactly 1/${f} of the stored value — that is the driver's microstep setting, not the rig`;
  }
  const pct = (ratio - 1) * 100;
  if (Math.abs(pct) > 5) return `${pct > 0 ? "+" : ""}${pct.toFixed(1)}% against the stored value — something mechanical changed, or one of the two was measured badly`;
  return null;
}

/**
 * Angle from a laser on the rotating axis, marked on a wall.
 *
 * The practical field method: point a laser square at a wall a measured
 * distance away, mark the dot, rotate, mark again, measure between the marks.
 * It beats a protractor taped to a tripod and it needs nothing you would not
 * already have.
 *
 * Assumes the FIRST mark is square to the wall. That assumption is nearly free
 * at small angles and stops being free at large ones, which is what the warning
 * from `laserAngleWarning` is for.
 */
export const degreesFromLaser = (offsetMm: number, distanceMm: number): number =>
  distanceMm === 0 ? 0 : (Math.atan(offsetMm / distanceMm) * 180) / Math.PI;

export function laserAngleWarning(offsetMm: number, distanceMm: number): string | null {
  const deg = Math.abs(degreesFromLaser(offsetMm, distanceMm));
  if (deg > 25) {
    return `${deg.toFixed(1)}° is past where "start square to the wall" is a safe assumption — use an inclinometer, or split the move either side of square`;
  }
  if (deg < 5) return `${deg.toFixed(1)}° is a small angle to measure well — move further, or stand the wall further away`;
  return null;
}

/* ------------------------------------------------------------------
   Repeatability — the thing multiplicity actually depends on
   ------------------------------------------------------------------ */

export interface RepeatabilityResult {
  n: number;
  /** Mean of the readings, mm. A non-zero mean is a bias, not scatter. */
  meanMm: number;
  /** Largest absolute reading — the number that decides pass or fail. */
  maxAbsMm: number;
  /** Peak-to-peak spread, mm. */
  spreadMm: number;
  pass: boolean;
  verdict: string;
}

/**
 * Judge a set of return-to-start readings from a dial indicator.
 *
 * Bias and scatter are reported separately because they have different causes
 * and different fixes: a consistent offset every pass is backlash or a
 * take-up problem and is largely correctable, while readings scattered either
 * side of zero are lost steps and are not. Collapsing them into one number
 * would hide the distinction exactly when it matters.
 */
export function repeatability(readingsMm: number[], thresholdMm: number): RepeatabilityResult {
  const r = readingsMm.filter((v) => Number.isFinite(v));
  if (!r.length) {
    return { n: 0, meanMm: 0, maxAbsMm: 0, spreadMm: 0, pass: false, verdict: "no passes recorded yet" };
  }
  const meanMm = r.reduce((a, b) => a + b, 0) / r.length;
  const maxAbsMm = Math.max(...r.map(Math.abs));
  const spreadMm = Math.max(...r) - Math.min(...r);
  const pass = maxAbsMm <= thresholdMm;

  let verdict: string;
  if (r.length < 3) {
    verdict = `only ${r.length} pass${r.length === 1 ? "" : "es"} — run at least five before believing the number`;
  } else if (!pass) {
    verdict = `FAIL — worst return is ${maxAbsMm.toFixed(2)} mm against a ${thresholdMm} mm limit`;
  } else if (Math.abs(meanMm) > spreadMm && Math.abs(meanMm) > thresholdMm / 2) {
    /* Every pass off the same way = a systematic offset, which is a mechanical
       fix rather than a reason to distrust the rig. */
    verdict = `pass, but every return is offset ${meanMm.toFixed(2)} mm the same way — that is backlash or belt take-up, not lost steps`;
  } else {
    verdict = `pass — worst ${maxAbsMm.toFixed(2)} mm, spread ${spreadMm.toFixed(2)} mm over ${r.length} passes`;
  }
  return { n: r.length, meanMm, maxAbsMm, spreadMm, pass, verdict };
}
