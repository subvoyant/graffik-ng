import { describe, it, expect } from "vitest";
import { bringUpReport, BringUpState, capUntaughtJog, UNTAUGHT_JOG_CAP, AxisLimit } from "../src/index.js";

const untaught: AxisLimit = { min: null, max: null };
const at = "2026-08-21T09:00:00Z";

describe("creep speed on an axis nobody has taught", () => {
  /**
   * The one moment the soft-limit system cannot protect anything is the first
   * jog — because limits are taught BY jogging to them.
   */
  it("caps an untaught axis", () => {
    const r = capUntaughtJog(untaught, 4000);
    expect(r.stepsPerSec).toBe(UNTAUGHT_JOG_CAP);
    expect(r.capped).toBe(true);
    expect(r.reason).toMatch(/Teach a limit to unlock full speed/);
  });

  it("caps in both directions and keeps the sign", () => {
    expect(capUntaughtJog(untaught, -4000).stepsPerSec).toBe(-UNTAUGHT_JOG_CAP);
  });

  it("leaves a slow jog alone — the cap is a ceiling, not a speed", () => {
    const r = capUntaughtJog(untaught, 120);
    expect(r.stepsPerSec).toBe(120);
    expect(r.capped).toBe(false);
  });

  /** Self-clearing. One taught bound is enough — that is why there is no
      separate override switch to leave on by mistake. */
  it("stops capping once EITHER bound is taught", () => {
    expect(capUntaughtJog({ min: -100, max: null }, 4000).capped).toBe(false);
    expect(capUntaughtJog({ min: null, max: 9000 }, 4000).capped).toBe(false);
  });

  it("passes zero through, so stopping is never slowed down", () => {
    expect(capUntaughtJog(untaught, 0).stepsPerSec).toBe(0);
  });
});

describe("the bring-up report", () => {
  it("says what was never done, rather than omitting it", () => {
    const md = bringUpReport({ at });
    expect(md).toMatch(/Never connected in this session/);
    expect(md).toMatch(/Soft limits[\s\S]*Not taught/);
    expect(md).toMatch(/Not measured\.\*\* A 3D export is a shape/);
    expect(md).toMatch(/Not measured\.\*\* This is the thing multiplicity depends on/);
    expect(md).toMatch(/No lens motors configured/);
    expect(md).toMatch(/Anything marked \*\*not measured\*\* is still unknown/);
  });

  it("reports the connection and flags an overridden firmware gate", () => {
    const md = bringUpReport({
      at, connection: { port: "/dev/tty.usbserial-A1", firmware: 64, supported: false, overridden: true },
    });
    expect(md).toMatch(/usbserial-A1/);
    expect(md).toMatch(/Firmware: 64 — \*\*not the verified version\*\*/);
    expect(md).toMatch(/overridden.*unverified command set.*ADR-0004/);
  });

  it("tabulates taught limits and names the axes that are still open", () => {
    const md = bringUpReport({ at, limits: [{ min: 0, max: 52000 }, untaught, { min: -200, max: null }] });
    expect(md).toMatch(/\| Slide \| 0 \| 52000 \| yes \|/);
    expect(md).toMatch(/\| Pan \| — \| — \| \*\*no\*\* \|/);
    expect(md).toMatch(/\| Tilt \| -200 \| — \| yes \|/);
  });

  it("fits every measured axis and keeps the raw spans", () => {
    const md = bringUpReport({
      at,
      spans: {
        slide: [{ steps: 80000, measured: 500, note: "steel rule" }, { steps: 64000, measured: 400 }],
        pan: [],
      },
    });
    expect(md).toMatch(/\| slide \| 160\.000 steps\/mm \|/);
    expect(md).toMatch(/\| pan \| \*\*not measured\*\* \|/);
    expect(md).toMatch(/80000 steps over 500 mm — steel rule/);
  });

  it("gives the repeatability verdict, not just the numbers", () => {
    const md = bringUpReport({ at, repeatability: { readings: [0, 0.02, -0.03, 0.01, -0.01], thresholdMm: 0.1 } });
    expect(md).toMatch(/Readings \(mm\): 0\.00, 0\.02/);
    expect(md).toMatch(/\*\*pass — worst 0\.03 mm/);
  });

  it("distinguishes a configured-but-uncalibrated motor from no motor at all", () => {
    const md = bringUpReport({ at, lensMotors: { focus: { steps: 0, maxStepsPerSec: 3000, invert: false } } });
    expect(md).toMatch(/\| focus \| \*\*not calibrated\*\* \| 3000 steps\/s \| no \|/);
  });

  it("carries the operator's notes and the log verbatim", () => {
    const md = bringUpReport({
      at, notes: "  belt slipped on pass 3, retensioned  ",
      log: ["21:04 pass 5 complete", "21:01 pass 4 complete"],
    });
    expect(md).toMatch(/belt slipped on pass 3, retensioned/);
    // newest-first, unsummarised — nobody knows yet what mattered
    expect(md.indexOf("pass 5 complete")).toBeLessThan(md.indexOf("pass 4 complete"));
  });

  /**
   * The easiest way to leave a session believing a calibration is in effect
   * when it is not: measure it, never press Apply, and read a table with two
   * numbers in it.
   */
  it("flags a calibration that was measured but never applied", () => {
    const md = bringUpReport({
      at,
      spans: { slide: [{ steps: 80000, measured: 500 }, { steps: 64000, measured: 400 }] },
      calibration: { slideStepsPerMm: 100 },
    });
    expect(md).toMatch(/was measured at 160\.000 but the exporter is still using 100/);
    expect(md).toMatch(/"Use these numbers" was not pressed/);
  });

  it("says nothing when the measurement is the one in use", () => {
    const md = bringUpReport({
      at,
      spans: { slide: [{ steps: 80000, measured: 500 }, { steps: 64000, measured: 400 }] },
      calibration: { slideStepsPerMm: 160 },
    });
    expect(md).not.toMatch(/was not pressed/);
  });

  it("spells warnings out instead of counting them", () => {
    const md = bringUpReport({ at, spans: { slide: [{ steps: 8000, measured: 50 }] } });
    expect(md).toMatch(/slide: one measurement cannot disagree with itself/);
    expect(md).toMatch(/slide: shortest span is only 50 mm/);
  });

  it("is pure — same input, same bytes", () => {
    const s: BringUpState = { at, limits: [untaught, untaught, untaught], notes: "x" };
    expect(bringUpReport(s)).toBe(bringUpReport(s));
  });
});
