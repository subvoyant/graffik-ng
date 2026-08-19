import { describe, it, expect } from "vitest";
import {
  fitCalibration, plausibilityWarnings, diagnoseCalibration,
  degreesFromLaser, laserAngleWarning, repeatability,
} from "../src/index.js";

const warn = (r: { warnings: string[] }, re: RegExp) => r.warnings.some((w) => re.test(w));

describe("fitting a calibration from measured spans", () => {
  it("averages independent spans", () => {
    const r = fitCalibration([
      { steps: 80000, measured: 500 },
      { steps: 64000, measured: 400 },
    ], "mm");
    expect(r.perUnit).toBeCloseTo(160, 6);
    expect(r.n).toBe(2);
    expect(r.spreadPct).toBeCloseTo(0, 6);
  });

  it("is sign-agnostic — measuring back down the rail is still a measurement", () => {
    const r = fitCalibration([{ steps: -80000, measured: 500 }], "mm");
    expect(r.perUnit).toBeCloseTo(160, 6);
  });

  /**
   * The load-bearing property. The spread across independent spans IS the error
   * estimate; a fit that quietly absorbed the disagreement would stop telling
   * the operator anything.
   */
  it("reports disagreement as the operator sees it — peak to peak, not half of it", () => {
    const r = fitCalibration([
      { steps: 80000, measured: 500, note: "tape" },
      { steps: 64000, measured: 380, note: "suspect" },
    ], "mm");
    // 160.00 vs 168.42 steps/mm: the two numbers differ by ~5%, and that is the
    // figure to print. Deviation-from-the-mean would say 2.5% and read as a
    // contradiction of the operator's own arithmetic.
    expect(r.spreadPct).toBeGreaterThan(4);
    expect(r.spreadPct).toBeLessThan(6);
  });

  it("will not name a culprit when there are only two measurements", () => {
    const r = fitCalibration([
      { steps: 80000, measured: 500, note: "tape" },
      { steps: 64000, measured: 380, note: "suspect" },
    ], "mm");
    expect(r.worst).toBeNull();
    expect(warn(r, /nothing here can tell you which; take a third/)).toBe(true);
  });

  it("names the outlier once a third span breaks the tie", () => {
    const r = fitCalibration([
      { steps: 80000, measured: 500, note: "tape" },
      { steps: 64000, measured: 400, note: "tape again" },
      { steps: 64000, measured: 380, note: "suspect" },
    ], "mm");
    expect(r.worst?.note).toBe("suspect");
    expect(warn(r, /re-measure the marked span/)).toBe(true);
  });

  it("says a single measurement cannot disagree with itself", () => {
    expect(warn(fitCalibration([{ steps: 80000, measured: 500 }], "mm"), /cannot disagree with itself/)).toBe(true);
  });

  it("warns that a short baseline magnifies a fixed reading error", () => {
    const r = fitCalibration([{ steps: 8000, measured: 50 }, { steps: 8000, measured: 50 }], "mm");
    expect(warn(r, /0\.5 mm reading error is 1\.0%/)).toBe(true);
  });

  it("warns about small rotations too", () => {
    const r = fitCalibration([{ steps: 3000, measured: 20 }, { steps: 3000, measured: 20 }], "deg");
    expect(warn(r, /rotation is hard to read/)).toBe(true);
  });

  it("ignores unusable rows instead of producing NaN", () => {
    const r = fitCalibration([
      { steps: 80000, measured: 500 },
      { steps: 1000, measured: 0 },            // divide-by-zero bait
      { steps: NaN, measured: 100 },
    ], "mm");
    expect(r.n).toBe(1);
    expect(r.perUnit).toBeCloseTo(160, 6);
  });

  it("returns something honest with no measurements at all", () => {
    const r = fitCalibration([], "mm");
    expect(r.perUnit).toBe(0);
    expect(r.worst).toBeNull();
    expect(warn(r, /no usable measurements/)).toBe(true);
  });
});

describe("plausibility", () => {
  it("passes an ordinary slider and head", () => {
    expect(plausibilityWarnings(160, "mm")).toEqual([]);
    expect(plausibilityWarnings(220, "deg")).toEqual([]);
  });

  it("catches a decimal point", () => {
    expect(plausibilityWarnings(0.16, "mm")[0]).toMatch(/outside anything plausible/);
    expect(plausibilityWarnings(160000, "mm")[0]).toMatch(/outside anything plausible/);
  });

  it("refuses a non-number rather than passing it along", () => {
    expect(plausibilityWarnings(NaN, "mm")[0]).toMatch(/not a usable number/);
    expect(plausibilityWarnings(-5, "deg")[0]).toMatch(/not a usable number/);
  });
});

describe("diagnosing a disagreement with the stored value", () => {
  it("names a unit slip", () => {
    expect(diagnoseCalibration(16000, 160)).toMatch(/100x/);
    expect(diagnoseCalibration(1.6, 160)).toMatch(/1\/100/);
    expect(diagnoseCalibration(1600, 160)).toMatch(/10x/);
  });

  /** ADR-0015's other trap: a number that looks entirely reasonable and is
      wrong by the driver's microstep jumper. */
  it("names the microstep jumper", () => {
    expect(diagnoseCalibration(320, 160)).toMatch(/microstep/);
    expect(diagnoseCalibration(2560, 160)).toMatch(/microstep/);
    expect(diagnoseCalibration(20, 160)).toMatch(/1\/8/);
  });

  it("mentions a plain mechanical difference without blaming units", () => {
    const d = diagnoseCalibration(176, 160);
    expect(d).toMatch(/\+10\.0%/);
    expect(d).not.toMatch(/microstep|unit slip/);
  });

  it("says nothing when the two agree", () => {
    expect(diagnoseCalibration(160, 160)).toBeNull();
    expect(diagnoseCalibration(163, 160)).toBeNull();     // inside 5%
  });

  it("says nothing about nonsense input", () => {
    expect(diagnoseCalibration(0, 160)).toBeNull();
    expect(diagnoseCalibration(160, NaN)).toBeNull();
  });
});

describe("the laser-on-a-wall angle method", () => {
  it("is plain trigonometry", () => {
    expect(degreesFromLaser(1000, 1000)).toBeCloseTo(45, 6);
    expect(degreesFromLaser(1000, 4000)).toBeCloseTo(14.036, 3);
    expect(degreesFromLaser(0, 4000)).toBe(0);
  });

  it("does not divide by zero", () => {
    expect(degreesFromLaser(500, 0)).toBe(0);
  });

  it("warns where the square-to-the-wall assumption stops being free", () => {
    expect(laserAngleWarning(1000, 1000)).toMatch(/past where/);
    expect(laserAngleWarning(1000, 4000)).toBeNull();
    expect(laserAngleWarning(100, 4000)).toMatch(/small angle/);
  });
});

describe("repeatability", () => {
  it("passes a tight set and reports both numbers", () => {
    const r = repeatability([0, 0.02, -0.03, 0.01, -0.01], 0.1);
    expect(r.pass).toBe(true);
    expect(r.n).toBe(5);
    expect(r.maxAbsMm).toBeCloseTo(0.03, 6);
    expect(r.spreadMm).toBeCloseTo(0.05, 6);
    expect(r.verdict).toMatch(/^pass —/);
  });

  it("fails on the worst reading, not the average", () => {
    const r = repeatability([0, 0, 0, 0, 0.9], 0.1);
    expect(r.pass).toBe(false);
    expect(r.verdict).toMatch(/FAIL.*0\.90 mm/);
  });

  /**
   * Bias and scatter have different causes and different fixes — a consistent
   * offset is backlash and is largely correctable, scatter is lost steps and is
   * not. One number would hide the distinction exactly when it matters.
   */
  it("distinguishes a consistent offset from scatter", () => {
    const r = repeatability([0.30, 0.31, 0.29, 0.30, 0.31], 0.5);
    expect(r.pass).toBe(true);
    expect(r.verdict).toMatch(/offset 0\.30 mm the same way.*backlash/);
  });

  it("refuses to be believed on too few passes", () => {
    expect(repeatability([0, 0.01], 0.1).verdict).toMatch(/at least five/);
    expect(repeatability([], 0.1).verdict).toMatch(/no passes recorded/);
    expect(repeatability([], 0.1).pass).toBe(false);
  });

  it("ignores non-numbers rather than poisoning the mean", () => {
    const r = repeatability([0.01, NaN, -0.01, 0.02, 0, 0.01], 0.1);
    expect(r.n).toBe(5);
    expect(Number.isFinite(r.meanMm)).toBe(true);
  });
});

