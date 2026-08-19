import { describe, it, expect } from "vitest";
import {
  newFilm, Timebase, LensAxis,
  buildLensProgram, lensProgramSize,
  quantizeLensPos, decimateLensPoints, lensPeakRate, lensFeasibility,
  lensToleranceForSteps, LENS_POS_MAX, DEFAULT_LENS_TOLERANCE_UNITS,
  sampleLensAxis,
} from "../src/index.js";
import {
  SerialTriggerBackend, SimulatedTriggerDevice,
  TRIGGER_PROTOCOL_VERSION, SUPPORTED_TRIGGER_PROTOCOLS, LENS_AXIS_INDEX,
} from "../src/trigger.js";

const TB_24: Timebase = { num: 24, den: 1, dropFrame: false };

/** A pull that sits still, snaps, then eases out — the shape that stresses decimation. */
function pullFilm(durationFrames = 576) {
  const f = newFilm("Pull", durationFrames, TB_24);
  /* Keys are placed proportionally so the shape survives a shorter fixture —
     hard-coded frame numbers past the end are a solver error, not a test. */
  const at = (fraction: number) => Math.round(durationFrames * fraction);
  const focus: LensAxis = {
    kind: "focus", target: "focus",
    keys: [
      { frame: 0, position: 0.80 },
      { frame: at(5 / 12), position: 0.78 },
      { frame: at(1 / 2), position: 0.20 },   // the snap
      { frame: durationFrames, position: 0.24 },
    ],
  };
  const iris: LensAxis = {
    kind: "iris", target: "iris",
    keys: [{ frame: 0, position: 0.3 }, { frame: durationFrames, position: 0.3 }],
  };
  f.lensAxes = [focus, iris];
  return f;
}

describe("quantisation", () => {
  it("maps the travel ends exactly and clamps outside", () => {
    expect(quantizeLensPos(0)).toBe(0);
    expect(quantizeLensPos(1)).toBe(LENS_POS_MAX);
    expect(quantizeLensPos(0.5)).toBe(Math.round(0.5 * LENS_POS_MAX));
    expect(quantizeLensPos(-3)).toBe(0);
    expect(quantizeLensPos(9)).toBe(LENS_POS_MAX);
  });
});

describe("decimation", () => {
  const line = Array.from({ length: 200 }, (_, i) => ({ ms: i * 10, pos: i * 100 }));

  it("collapses a straight line to its endpoints", () => {
    expect(decimateLensPoints(line, 1)).toHaveLength(2);
  });

  it("always keeps first and last, even at zero tolerance", () => {
    const out = decimateLensPoints(line, 0);
    expect(out[0]).toEqual(line[0]);
    expect(out[out.length - 1]).toEqual(line[line.length - 1]);
  });

  it("passes short inputs through untouched", () => {
    expect(decimateLensPoints([], 5)).toEqual([]);
    expect(decimateLensPoints([{ ms: 0, pos: 1 }], 5)).toHaveLength(1);
  });

  /**
   * The load-bearing property. Decimation is only defensible if the device's
   * linear interpolation between the kept points stays inside the stated bound
   * everywhere — not on average, everywhere.
   */
  it("holds its error bound at every original sample", () => {
    const f = pullFilm();
    const dense = sampleLensAxis(f.lensAxes![0], f.durationFrames).map((v, frame) => ({
      ms: Math.round((frame * 1000) / 24), pos: quantizeLensPos(v),
    }));
    const tol = 40;
    const kept = decimateLensPoints(dense, tol);
    let worst = 0;
    for (const p of dense) {
      let seg = 0;
      while (seg < kept.length - 2 && kept[seg + 1].ms < p.ms) seg++;
      const a = kept[seg], b = kept[seg + 1];
      const t = b.ms === a.ms ? 0 : (p.ms - a.ms) / (b.ms - a.ms);
      worst = Math.max(worst, Math.abs(p.pos - (a.pos + (b.pos - a.pos) * t)));
    }
    expect(worst).toBeLessThanOrEqual(tol);
    expect(kept.length).toBeLessThan(dense.length / 4);   // and it actually compressed
  });

  it("keeps more points on a snap than on a hold", () => {
    const f = pullFilm();
    const prog = buildLensProgram(f, { toleranceUnits: 40 });
    const focus = prog.axes.find((a) => a.kind === "focus")!;
    const iris = prog.axes.find((a) => a.kind === "iris")!;
    expect(iris.points).toHaveLength(2);            // dead flat -> two points
    expect(focus.points.length).toBeGreaterThan(6);  // a snap needs describing
  });
});

describe("peak rate", () => {
  it("finds the fastest segment and when it starts", () => {
    const r = lensPeakRate([
      { ms: 0, pos: 0 }, { ms: 1000, pos: 100 }, { ms: 2000, pos: 5100 }, { ms: 3000, pos: 5200 },
    ]);
    expect(r.unitsPerSec).toBe(5000);
    expect(r.atMs).toBe(1000);
  });

  it("ignores zero-length segments rather than dividing by zero", () => {
    expect(lensPeakRate([{ ms: 0, pos: 0 }, { ms: 0, pos: 900 }]).unitsPerSec).toBe(0);
  });
});

describe("buildLensProgram", () => {
  it("puts milliseconds on the wire from the film's own timebase", () => {
    const f = pullFilm(48);
    const prog = buildLensProgram(f, { toleranceUnits: 1 });
    const focus = prog.axes.find((a) => a.kind === "focus")!;
    expect(focus.points[0].ms).toBe(0);
    expect(focus.points[focus.points.length - 1].ms).toBe(2000);  // 48 frames @ 24 = 2 s
  });

  /**
   * The program is BARREL TRAVEL, full stop. Motor handedness belongs to the
   * rig and is applied by the device at its DIR pin — if it were applied here,
   * the same move file would encode to different motion depending on which
   * machine ran the export, which is not a property a move file may have.
   */
  it("sends barrel travel, with no rig handedness baked in", () => {
    const f = pullFilm(48);
    const prog = buildLensProgram(f, { toleranceUnits: 1 });
    expect(prog.axes[0].points[0].pos).toBe(quantizeLensPos(0.8));
    expect("invert" in (f.lensAxes![0] as object)).toBe(false);
  });

  it("declares handedness to the DEVICE instead", async () => {
    const { dev, be } = await connected();
    await be.declareLensAxis({ kind: "focus", steps: 4000, maxStepsPerSec: 3000, invert: true });
    // the device is the one that now knows; nothing upstream of it does
    expect(dev.lensPos.has(LENS_AXIS_INDEX.focus)).toBe(false);
  });

  it("derives tolerance from calibrated motor steps when it has them", () => {
    expect(lensToleranceForSteps(0)).toBe(DEFAULT_LENS_TOLERANCE_UNITS);
    expect(lensToleranceForSteps(4000)).toBeCloseTo(LENS_POS_MAX / 8000, 6);
    // a coarser motor should never demand a tolerance finer than one unit
    expect(lensToleranceForSteps(10_000_000)).toBe(1);
  });

  it("reports its own size", () => {
    const prog = buildLensProgram(pullFilm(), { toleranceUnits: 40 });
    expect(lensProgramSize(prog)).toBe(prog.axes.reduce((n, a) => n + a.points.length, 0));
  });

  it("is empty for a move with no lens lanes", () => {
    const prog = buildLensProgram(newFilm("bare", 48, TB_24));
    expect(prog.axes).toEqual([]);
    expect(lensProgramSize(prog)).toBe(0);
  });
});

describe("feasibility pre-flight", () => {
  const prog = buildLensProgram(pullFilm(), { toleranceUnits: 40 });

  it("passes a pull the motor can follow", () => {
    expect(lensFeasibility(prog, {
      focus: { steps: 4000, maxStepsPerSec: 8000 },
      iris: { steps: 2000, maxStepsPerSec: 4000 },
    })).toEqual([]);
  });

  it("names the axis, the speed and the moment when it cannot", () => {
    const bad = lensFeasibility(prog, {
      focus: { steps: 4000, maxStepsPerSec: 200 },
      iris: { steps: 2000, maxStepsPerSec: 4000 },
    });
    expect(bad).toHaveLength(1);
    expect(bad[0].kind).toBe("focus");
    expect(bad[0].maxStepsPerSec).toBe(200);
    expect(bad[0].requiredStepsPerSec).toBeGreaterThan(200);
    expect(bad[0].atMs).toBeGreaterThan(0);
    expect(bad[0].reason).toMatch(/lag, not clip/);
  });

  it("flags an uncalibrated barrel before it flags a speed", () => {
    const bad = lensFeasibility(prog, {
      focus: { steps: 0, maxStepsPerSec: 8000 },
      iris: { steps: 2000, maxStepsPerSec: 4000 },
    });
    expect(bad[0].reason).toMatch(/not calibrated/);
  });

  it("flags a lane the device has no motor for", () => {
    const bad = lensFeasibility(prog, { focus: { steps: 4000, maxStepsPerSec: 8000 } });
    expect(bad.map((b) => b.kind)).toEqual(["iris"]);
    expect(bad[0].reason).toMatch(/no motor configured/);
  });
});

/* ------------------------------------------------------------------ */

async function connected(opts: Partial<{ protocol: number; lens: number }> = {}) {
  const dev = new SimulatedTriggerDevice("sim-fiz", 8, 2, opts.protocol ?? TRIGGER_PROTOCOL_VERSION, opts.lens ?? 3);
  const be = new SerialTriggerBackend(dev, 200);
  await be.hello();
  return { dev, be };
}

describe("protocol v2 handshake", () => {
  it("reports the lens axis count and says so in describe()", async () => {
    const { be } = await connected();
    expect(be.lensAxes()).toBe(3);
    expect(be.supportsLens()).toBe(true);
    expect(be.describe()).toMatch(/3 lens/);
  });

  it("still accepts a v1 cue board, and tells the truth about it", async () => {
    const { be } = await connected({ protocol: 1 });
    expect(be.supportsLens()).toBe(false);
    expect(be.lensAxes()).toBe(0);
    await expect(be.calibrateLens("focus")).rejects.toThrow(/cannot drive focus, iris or zoom/);
  });

  it("still refuses a version it does not know", async () => {
    const dev = new SimulatedTriggerDevice("future", 8, 2, 99, 3);
    const be = new SerialTriggerBackend(dev, 200);
    await expect(be.hello()).rejects.toThrow(/protocol v99/);
    expect(SUPPORTED_TRIGGER_PROTOCOLS).toEqual([1, 2]);
  });

  it("refuses lens work before a handshake", async () => {
    const be = new SerialTriggerBackend(new SimulatedTriggerDevice(), 200);
    await expect(be.declareLensAxis({ kind: "focus", steps: 0, maxStepsPerSec: 4000, invert: false }))
      .rejects.toThrow(/handshake/);
  });
});

describe("calibration", () => {
  it("reports the barrel's travel and parks at a stop", async () => {
    const { dev, be } = await connected();
    dev.calibrationSteps = 5200;
    await expect(be.calibrateLens("focus", 500)).resolves.toBe(5200);
    expect(dev.lensPos.get(LENS_AXIS_INDEX.focus)).toBe(0);
  });

  it("surfaces the device's own reason when it fails", async () => {
    const { dev, be } = await connected();
    dev.calibrationSteps = null;
    await expect(be.calibrateLens("focus", 500)).rejects.toThrow(/did not reach a stop/);
  });

  it("refuses a zero-travel result rather than treating it as calibrated", async () => {
    const { dev, be } = await connected();
    dev.calibrationSteps = 0;
    await expect(be.calibrateLens("focus", 500)).rejects.toThrow(/did not move/);
  });
});

describe("upload", () => {
  it("sends every point and agrees with the device on the count", async () => {
    const { dev, be } = await connected();
    const prog = buildLensProgram(pullFilm(), { toleranceUnits: 40 });
    const sent = await be.uploadLens(prog);
    expect(sent).toBe(lensProgramSize(prog));
    expect(sent).toBeGreaterThan(2);
  });

  it("refuses a truncated pull instead of running it", async () => {
    const { dev, be } = await connected();
    dev.lensDropEvery = 7;                         // the device loses a line now and then
    const prog = buildLensProgram(pullFilm(), { toleranceUnits: 4 });
    await expect(be.uploadLens(prog)).rejects.toThrow(/desynced/);
  });

  it("chunks the upload rather than blasting it", async () => {
    const { dev, be } = await connected();
    const prog = buildLensProgram(pullFilm(), { toleranceUnits: 2 });
    const size = lensProgramSize(prog);
    expect(size).toBeGreaterThan(32);              // enough to need more than one chunk
    await expect(be.uploadLens(prog)).resolves.toBe(size);
  });

  it("cross-checks ARM's lens count against what it uploaded", async () => {
    const { dev, be } = await connected();
    await be.uploadLens(buildLensProgram(pullFilm(), { toleranceUnits: 40 }));
    dev.lensDropEvery = null;
    // the device quietly loses the program between upload and arm
    dev.write("LCLEAR\n");
    await expect(be.arm([])).rejects.toThrow(/truncated focus pull/);
  });
});

describe("running a pull on the device's own clock", () => {
  it("follows the uploaded curve inside the decimation bound", async () => {
    const { dev, be } = await connected();
    const f = pullFilm();
    const tol = 40;
    const prog = buildLensProgram(f, { toleranceUnits: tol });
    await be.uploadLens(prog);
    await be.arm([]);
    await be.start();

    const truth = sampleLensAxis(f.lensAxes![0], f.durationFrames).map(quantizeLensPos);
    let worst = 0;
    for (let frame = 0; frame <= f.durationFrames; frame++) {
      dev.tick(1000 / 24);
      const seen = dev.lensPos.get(LENS_AXIS_INDEX.focus) ?? 0;
      worst = Math.max(worst, Math.abs(seen - truth[Math.min(frame + 1, f.durationFrames)]));
    }
    /* The device interpolates linearly between the kept points; the host bounded
       that error at `tol`. Allow one extra unit for the half-frame the tick
       lands on. If this ever grows, decimation and the firmware have drifted. */
    expect(worst).toBeLessThanOrEqual(tol + 1);
  });

  it("holds position on ABORT — never homes, never releases", async () => {
    const { dev, be } = await connected();
    await be.uploadLens(buildLensProgram(pullFilm(), { toleranceUnits: 40 }));
    await be.arm([]);
    await be.start();
    for (let i = 0; i < 300; i++) dev.tick(1000 / 24);
    const held = dev.lensPos.get(LENS_AXIS_INDEX.focus)!;
    expect(held).toBeGreaterThan(0);

    await be.abort();
    for (let i = 0; i < 100; i++) dev.tick(1000 / 24);
    expect(dev.lensPos.get(LENS_AXIS_INDEX.focus)).toBe(held);
  });

  it("parks a barrel with LSEEK", async () => {
    const { dev, be } = await connected();
    be.seekLens("zoom", 0.25);
    expect(dev.lensTravel("zoom")).toBeCloseTo(0.25, 4);
  });
});
