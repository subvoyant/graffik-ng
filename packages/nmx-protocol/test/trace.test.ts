import { describe, it, expect } from "vitest";
import {
  newTrace, addSample, traceCoverage, resampleByPercent,
  compareTraces, deviationFromPlan, deviationLines, traceToCsv,
  timingCheck, motors, general, keyFrame,
} from "../src/index.js";
import type { PassTrace } from "../src/index.js";

const TB = { num: 24, den: 1, dropFrame: false };

function trace(id: string, opts: { axes?: string[]; microsteps?: (number | null)[] } = {}): PassTrace {
  return newTrace({
    id, engine: "keyframe", startedAt: "2026-08-19T09:00:00Z",
    durationFrames: 240, timebase: TB,
    axisNames: opts.axes ?? ["Slide", "Pan", "Tilt"],
    microsteps: opts.microsteps,
  });
}

/** A pass that ran a straight line on every axis, sampled every `stepPct`. */
function straight(id: string, gain: number, o: { stepPct?: number; offset?: number; to?: number } = {}) {
  const t = trace(id);
  const step = o.stepPct ?? 5;
  for (let p = 0; p <= (o.to ?? 100); p += step) {
    addSample(t, {
      atMs: p * 300, percent: p,
      position: [p * gain + (o.offset ?? 0), p * gain * 2, -p * gain],
      suspect: false, costMs: 12,
    });
  }
  return t;
}

describe("coverage — what the recording actually caught", () => {
  it("reports the span, the biggest blind spot and the median sample cost", () => {
    const t = trace("a");
    addSample(t, { atMs: 0, percent: 0, position: [0, 0, 0], suspect: false, costMs: 10 });
    addSample(t, { atMs: 500, percent: 5, position: [50, 0, 0], suspect: false, costMs: 20 });
    addSample(t, { atMs: 4000, percent: 40, position: [400, 0, 0], suspect: false, costMs: 30 });
    const c = traceCoverage(t);
    expect(c.samples).toBe(3);
    expect(c.fromPercent).toBe(0);
    expect(c.toPercent).toBe(40);
    expect(c.maxGapPct).toBe(35);
    expect(c.medianCostMs).toBe(20);
    expect(c.wentBackwards).toBe(false);
  });

  it("records a percent that went backwards rather than tidying it away", () => {
    const t = trace("a");
    addSample(t, { atMs: 0, percent: 40, position: [0, 0, 0], suspect: false, costMs: 5 });
    addSample(t, { atMs: 500, percent: 38, position: [1, 0, 0], suspect: false, costMs: 5 });
    expect(traceCoverage(t).wentBackwards).toBe(true);
    expect(t.samples.map((s) => s.percent)).toEqual([40, 38]);
  });

  it("counts suspect and wholly failed samples separately", () => {
    const t = trace("a");
    addSample(t, { atMs: 0, percent: 0, position: [0, 0, 0], suspect: false, costMs: 5 });
    addSample(t, { atMs: 1, percent: 1, position: [9, 9, 9], suspect: true, costMs: 5 });
    addSample(t, { atMs: 2, percent: 2, position: [null, null, null], suspect: false, costMs: 5 });
    const c = traceCoverage(t);
    expect(c.suspect).toBe(1);
    expect(c.failed).toBe(1);
    expect(c.usable).toBe(1);
  });
});

describe("resampling on the controller's percent", () => {
  it("interpolates between bracketing samples", () => {
    const t = straight("a", 10, { stepPct: 10 });
    expect(resampleByPercent(t, 0, [25])[0]).toBeCloseTo(250, 6);
  });

  it("returns null outside the recorded span rather than extrapolating", () => {
    const t = straight("a", 10, { stepPct: 10, to: 50 });
    expect(resampleByPercent(t, 0, [75])[0]).toBeNull();
  });

  it("refuses to interpolate across a hole bigger than maxGapPct", () => {
    const t = trace("a");
    addSample(t, { atMs: 0, percent: 0, position: [0, 0, 0], suspect: false, costMs: 5 });
    addSample(t, { atMs: 9000, percent: 90, position: [900, 0, 0], suspect: false, costMs: 5 });
    expect(resampleByPercent(t, 0, [45], { maxGapPct: 10 })[0]).toBeNull();
    expect(resampleByPercent(t, 0, [45], { maxGapPct: 95 })[0]).toBeCloseTo(450, 6);
  });

  it("ignores suspect samples — their units are not the same units", () => {
    const t = trace("a");
    addSample(t, { atMs: 0, percent: 0, position: [0, 0, 0], suspect: false, costMs: 5 });
    addSample(t, { atMs: 5000, percent: 50, position: [99999, 0, 0], suspect: true, costMs: 5 });
    addSample(t, { atMs: 10000, percent: 100, position: [1000, 0, 0], suspect: false, costMs: 5 });
    expect(resampleByPercent(t, 0, [50], { maxGapPct: 100 })[0]).toBeCloseTo(500, 6);
  });
});

describe("comparing two passes", () => {
  it("reports a real offset above the resolution floor", () => {
    const a = straight("a", 10);
    const b = straight("b", 10, { offset: 400 });
    const r = compareTraces(a, b);
    expect(r.ok).toBe(true);
    expect(r.perAxis[0].maxSteps).toBeCloseTo(400, 6);
    expect(r.perAxis[0].belowFloor).toBe(false);
  });

  it("calls a perfect match a BOUND, not a measurement — whole-percent reporting sets a floor", () => {
    const a = straight("a", 10);
    const b = straight("b", 10);
    const r = compareTraces(a, b);
    expect(r.ok).toBe(true);
    expect(r.perAxis[0].maxSteps).toBe(0);
    /* 10 steps of travel per percent, one percent of quantisation. */
    expect(r.perAxis[0].floorSteps).toBeCloseTo(10, 6);
    expect(r.perAxis[0].belowFloor).toBe(true);
    expect(deviationLines(r)[0]).toMatch(/bound, not a measurement/);
  });

  it("a deviation smaller than the floor is still only a bound", () => {
    const a = straight("a", 10);
    const b = straight("b", 10, { offset: 3 });
    const r = compareTraces(a, b);
    expect(r.perAxis[0].maxSteps).toBeCloseTo(3, 6);
    expect(r.perAxis[0].belowFloor).toBe(true);
  });

  it("refuses when the two passes barely overlap", () => {
    const a = straight("a", 10, { to: 100 });
    const b = straight("b", 10, { to: 20 });
    const r = compareTraces(a, b);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/only overlap/);
    expect(r.perAxis).toEqual([]);
  });

  it("refuses when every reading was taken during a send", () => {
    const a = straight("a", 10);
    const b = trace("b");
    for (let p = 0; p <= 100; p += 5) {
      addSample(b, { atMs: p * 300, percent: p, position: [p * 10, 0, 0], suspect: true, costMs: 5 });
    }
    const r = compareTraces(a, b);
    expect(r.ok).toBe(false);
    /* The span check passes — suspect samples still tell you the pass ran end to
       end. It is the comparison that has nothing to work with. */
    expect(r.reason).toMatch(/only 0 point\(s\) could be compared/);
    expect(r.reason).toMatch(/taken during a send/);
  });

  it("refuses passes with different axis counts instead of comparing the first three", () => {
    const a = straight("a", 10);
    const b = trace("b", { axes: ["Slide", "Pan"] });
    for (let p = 0; p <= 100; p += 5) {
      addSample(b, { atMs: p, percent: p, position: [p * 10, 0], suspect: false, costMs: 5 });
    }
    expect(compareTraces(a, b).reason).toMatch(/same axes/);
  });

  it("names the percent where the worst deviation happened", () => {
    const a = straight("a", 10);
    const b = straight("b", 10);
    b.samples[10].position[0] = (b.samples[10].position[0] as number) + 900;
    const r = compareTraces(b, a);
    expect(r.perAxis[0].atPercent).toBe(50);
  });
});

describe("comparing a pass against the move it was given", () => {
  it("measures the gap between plan and rig", () => {
    const t = straight("a", 10);
    const r = deviationFromPlan(t, (pct) => [pct * 10 + 250, pct * 20, -pct * 10]);
    expect(r.ok).toBe(true);
    expect(r.perAxis[0].maxSteps).toBeCloseTo(250, 6);
    expect(r.perAxis[1].maxSteps).toBeCloseTo(0, 6);
  });

  it("refuses a pass that was only recorded over a sliver of the move", () => {
    const t = straight("a", 10, { to: 15 });
    const r = deviationFromPlan(t, (pct) => [pct * 10, 0, 0]);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/only recorded over/);
  });

  it("skips grid points the plan has no answer for", () => {
    const t = straight("a", 10);
    const r = deviationFromPlan(t, (pct) => (pct > 50 ? [null, null, null] : [pct * 10, pct * 20, -pct * 10]));
    expect(r.ok).toBe(true);
    /* The grid runs 0..100 at 1%, but the plan answers for only half of it. */
    expect(r.perAxis[0].points).toBe(51);
    expect(r.perAxis[0].maxSteps).toBeCloseTo(0, 6);
  });
});

describe("the raw record", () => {
  it("states the microstep setting in the CSV header, because steps mean nothing without it", () => {
    const t = trace("a", { microsteps: [16, 16, null] });
    addSample(t, { atMs: 0, percent: 0, position: [1, 2, null], suspect: false, costMs: 7 });
    const csv = traceToCsv(t);
    expect(csv.split("\n")[0]).toBe("at_ms,percent,suspect,cost_ms,Slide_steps_ms16,Pan_steps_ms16,Tilt_steps_msunknown");
    expect(csv.split("\n")[1]).toBe("0,0,0,7,1,2,");
  });
});

describe("query 124 — is this motor mid send", () => {
  it("is a motor-subaddress query, matching the firmware dispatch", () => {
    const p = motors.queryIsSending(2);
    expect(p.subAddress).toBe(2);
    expect(p.command).toBe(124);
  });
});

describe("the device's own arithmetic (ADR-0029)", () => {
  const withTiming = (t: Partial<NonNullable<PassTrace["deviceTiming"]>>, endedBy: PassTrace["endedBy"] = "complete") => {
    const x = trace("a");
    x.endedBy = endedBy;
    x.deviceTiming = { runTimeMs: 10000, totalMs: 10000, expectedMs: 10000, ...t };
    return x;
  };

  it("says so when nothing read the device timing, rather than staying silent", () => {
    expect(timingCheck(trace("a"))[0]).toMatch(/not read/);
  });

  it("agrees when the denominator matches the uploaded move", () => {
    expect(timingCheck(withTiming({}))[0]).toMatch(/agrees with the uploaded/);
  });

  it("catches the ADR-0028 skew FROM THE RIG: a denominator longer than the move", () => {
    /* 10 s move, 2 s exposure folded into the denominator on the wrong plan type. */
    const lines = timingCheck(withTiming({ totalMs: 12000, runTimeMs: 12000 }));
    expect(lines[0]).toMatch(/divided percent by 12000 ms while the uploaded move is 10000 ms/);
    expect(lines[0]).toMatch(/20\.0% longer/);
    expect(lines[0]).toMatch(/plan type/);
  });

  it("tolerates a small disagreement rather than crying wolf every pass", () => {
    expect(timingCheck(withTiming({ totalMs: 10100 }))[0]).toMatch(/agrees/);
  });

  it("flags a pass that called itself complete well short of the device's own clock", () => {
    const lines = timingCheck(withTiming({ runTimeMs: 6000 }));
    expect(lines.some((l) => /stopped short of its own clock/.test(l))).toBe(true);
  });

  it("does not flag a short run time on a pass that was stopped on purpose", () => {
    const lines = timingCheck(withTiming({ runTimeMs: 6000 }, "stopped"));
    expect(lines.some((l) => /stopped short/.test(l))).toBe(false);
  });

  it("says the denominator is unverified when the read failed", () => {
    expect(timingCheck(withTiming({ totalMs: null }))[0]).toMatch(/unverified/);
  });
});

describe("the queries this rests on are the ones the dispatch answers", () => {
  it("key-frame 122 is the denominator; general 125 is the classic total", () => {
    expect(keyFrame.queryMaxRunTime().command).toBe(122);
    expect(general.queryProgramTotalTime().command).toBe(125);
    expect(general.queryProgramTotalTime().subAddress).toBe(0);
  });
});
