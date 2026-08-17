import { describe, it, expect } from "vitest";
import {
  TIMEBASES, DEFAULT_TIMEBASE, timebaseById, timebaseId, nominalRate, fpsDecimal,
  validateTimebase, isDropFrameLegal, framesToMs, framesToMsExact, msToFrames,
  msToFramesExact, framesToTimecode, timecodeToFrames, formatDuration,
  timebaseLabel, retimeFrames, Timebase,
} from "../src/timecode.js";

const TB_24: Timebase = { num: 24, den: 1, dropFrame: false };
const TB_23976: Timebase = { num: 24000, den: 1001, dropFrame: false };
const TB_25: Timebase = { num: 25, den: 1, dropFrame: false };
const TB_2997NDF: Timebase = { num: 30000, den: 1001, dropFrame: false };
const TB_2997DF: Timebase = { num: 30000, den: 1001, dropFrame: true };
const TB_5994DF: Timebase = { num: 60000, den: 1001, dropFrame: true };

describe("timebase basics", () => {
  it("counts in the nominal integer rate, not the real rate", () => {
    expect(nominalRate(TB_2997DF)).toBe(30);
    expect(nominalRate(TB_23976)).toBe(24);
    expect(fpsDecimal(TB_23976)).toBeCloseTo(23.976023976, 8);
  });

  it("round-trips preset ids", () => {
    for (const { id, tb } of TIMEBASES) expect(timebaseId(tb)).toBe(id);
    expect(timebaseById("23.976")).toEqual(TB_23976);
    expect(timebaseById("nope")).toBeUndefined();
  });

  it("allows drop-frame only at 29.97 and 59.94", () => {
    expect(isDropFrameLegal(TB_2997DF)).toBe(true);
    expect(isDropFrameLegal(TB_5994DF)).toBe(true);
    expect(isDropFrameLegal(TB_23976)).toBe(false);
    expect(() => validateTimebase({ num: 24000, den: 1001, dropFrame: true })).toThrow(/only defined for/);
    expect(() => validateTimebase(TB_2997DF)).not.toThrow();
  });

  it("rejects malformed timebases", () => {
    expect(() => validateTimebase({ num: 0, den: 1, dropFrame: false })).toThrow(/positive integer/);
    expect(() => validateTimebase({ num: 24, den: 0, dropFrame: false })).toThrow(/positive integer/);
    expect(() => validateTimebase({ num: 23.976, den: 1, dropFrame: false })).toThrow(/positive integer/);
  });

  it("labels rates readably", () => {
    expect(timebaseLabel(TB_23976)).toBe("23.976");
    expect(timebaseLabel(TB_2997DF)).toBe("29.97 DF");
    expect(timebaseLabel(TB_24)).toBe("24");
  });
});

describe("frames <-> milliseconds", () => {
  it("uses the exact rational, not the rounded decimal", () => {
    // 1000 frames at 23.976: exact is 41708.33ms; the naive 1000/23.976*1000
    // is 41708.375ms. The gap is the drift this module exists to prevent.
    expect(framesToMsExact(1000, TB_23976)).toBeCloseTo(41708.3333, 4);
    expect(framesToMsExact(1000, TB_23976)).not.toBeCloseTo(1000 / 23.976 * 1000, 4);
  });

  it("converts whole seconds cleanly at integer rates", () => {
    expect(framesToMs(24, TB_24)).toBe(1000);
    expect(framesToMs(240, TB_24)).toBe(10_000);
    expect(framesToMs(25, TB_25)).toBe(1000);
    expect(msToFrames(10_000, TB_24)).toBe(240);
  });

  it("round-trips frames through ms without accumulating error", () => {
    for (const tb of [TB_24, TB_23976, TB_25, TB_2997NDF]) {
      for (const f of [0, 1, 47, 240, 1439, 86_399]) {
        expect(msToFrames(framesToMs(f, tb), tb)).toBe(f);
      }
    }
  });

  it("gives fractional frames for scrubbing", () => {
    expect(msToFramesExact(500, TB_24)).toBeCloseTo(12, 9);
    expect(msToFramesExact(20.833, TB_24)).toBeCloseTo(0.499992, 5);
  });
});

describe("SMPTE formatting (non-drop)", () => {
  it("formats hours/minutes/seconds/frames", () => {
    expect(framesToTimecode(0, TB_24)).toBe("00:00:00:00");
    expect(framesToTimecode(23, TB_24)).toBe("00:00:00:23");
    expect(framesToTimecode(24, TB_24)).toBe("00:00:01:00");
    expect(framesToTimecode(1440, TB_24)).toBe("00:01:00:00");
    expect(framesToTimecode(86_400, TB_24)).toBe("01:00:00:00");
  });

  it("counts 29.97 NDF in 30s, so the label lags the wall clock", () => {
    // 108000 frames labels as exactly one hour...
    expect(framesToTimecode(108_000, TB_2997NDF)).toBe("01:00:00:00");
    // ...but took 1 h 0 m 3.6 s of real time. That 3.6 s/hour gap is the entire
    // reason drop-frame exists, and why a long take must not be cut to NDF.
    expect(framesToMsExact(108_000, TB_2997NDF)).toBeCloseTo(3_603_600, 3);
  });

  it("uses a colon before frames, never a semicolon", () => {
    expect(framesToTimecode(100, TB_24)).toContain(":");
    expect(framesToTimecode(100, TB_24)).not.toContain(";");
  });

  it("handles negative counts (pre-roll / handles)", () => {
    expect(framesToTimecode(-24, TB_24)).toBe("-00:00:01:00");
    expect(timecodeToFrames("-00:00:01:00", TB_24)).toBe(-24);
  });
});

describe("SMPTE formatting (drop-frame)", () => {
  it("marks drop-frame with a semicolon", () => {
    expect(framesToTimecode(0, TB_2997DF)).toBe("00:00:00;00");
  });

  it("skips labels 00 and 01 at the top of a non-tenth minute", () => {
    // frame 1798 is the last of minute 0; the next label jumps 00:00:59;29 -> 00:01:00;02
    expect(framesToTimecode(1_799, TB_2997DF)).toBe("00:00:59;29");
    expect(framesToTimecode(1_800, TB_2997DF)).toBe("00:01:00;02");
  });

  it("does NOT skip at the tenth minute", () => {
    // 10 minutes of 29.97 DF is 17982 frames and lands exactly on 00:10:00;00
    expect(framesToTimecode(17_982, TB_2997DF)).toBe("00:10:00;00");
    expect(framesToTimecode(17_981, TB_2997DF)).toBe("00:09:59;29");
  });

  it("tracks the wall clock over an hour, unlike NDF", () => {
    // 107892 frames labels as one hour AND took one hour of real time — to
    // within 3.6 ms. Drop-frame is a very good approximation, not an exact one:
    // a true hour is 107892.107 frames, and you cannot count a tenth of a frame.
    expect(framesToTimecode(107_892, TB_2997DF)).toBe("01:00:00;00");
    expect(framesToMsExact(107_892, TB_2997DF)).toBeCloseTo(3_599_996.4, 1);
    expect(Math.abs(framesToMs(107_892, TB_2997DF) - 3_600_000)).toBeLessThan(5);
  });

  it("drops 4 per event at 59.94", () => {
    expect(framesToTimecode(3_599, TB_5994DF)).toBe("00:00:59;59");
    expect(framesToTimecode(3_600, TB_5994DF)).toBe("00:01:00;04");
    expect(framesToTimecode(35_964, TB_5994DF)).toBe("00:10:00;00");
    expect(framesToTimecode(215_784, TB_5994DF)).toBe("01:00:00;00");
  });

  it("round-trips every frame across a 10-minute drop cycle", () => {
    for (let f = 0; f <= 17_982; f += 7) {
      expect(timecodeToFrames(framesToTimecode(f, TB_2997DF), TB_2997DF)).toBe(f);
    }
  });

  it("round-trips a full hour at 59.94 DF", () => {
    for (let f = 0; f <= 215_784; f += 997) {
      expect(timecodeToFrames(framesToTimecode(f, TB_5994DF), TB_5994DF)).toBe(f);
    }
  });
});

describe("timecode parsing", () => {
  it("accepts short forms and bare frame numbers", () => {
    expect(timecodeToFrames("00:00:10:00", TB_24)).toBe(240);
    expect(timecodeToFrames("10:00", TB_24)).toBe(240);       // SS:FF
    expect(timecodeToFrames("01:00:00", TB_24)).toBe(1440);   // MM:SS:FF
    expect(timecodeToFrames("240", TB_24)).toBe(240);         // bare frame count
  });

  it("rejects a frame field the rate cannot hold", () => {
    expect(() => timecodeToFrames("00:00:00:24", TB_24)).toThrow(/out of range/);
    expect(() => timecodeToFrames("00:00:00:25", TB_25)).toThrow(/out of range/);
    expect(() => timecodeToFrames("00:00:00:29", TB_2997DF)).not.toThrow();
  });

  it("rejects timecodes that drop-frame skips", () => {
    expect(() => timecodeToFrames("00:01:00;00", TB_2997DF)).toThrow(/does not exist/);
    expect(() => timecodeToFrames("00:01:00;01", TB_2997DF)).toThrow(/does not exist/);
    expect(() => timecodeToFrames("00:01:00;02", TB_2997DF)).not.toThrow();
    // ...but the tenth minute is real
    expect(() => timecodeToFrames("00:10:00;00", TB_2997DF)).not.toThrow();
    expect(() => timecodeToFrames("00:01:00;03", TB_5994DF)).toThrow(/does not exist/);
    expect(() => timecodeToFrames("00:01:00;04", TB_5994DF)).not.toThrow();
  });

  it("rejects garbage with a readable message", () => {
    expect(() => timecodeToFrames("", TB_24)).toThrow(/empty/);
    expect(() => timecodeToFrames("half past four", TB_24)).toThrow(/not a timecode/);
    expect(() => timecodeToFrames("00:99:00:00", TB_24)).toThrow(/invalid timecode/);
  });
});

describe("retiming and labels", () => {
  it("preserves real duration when the timebase changes", () => {
    // 10 s at 24 fps must stay 10 s at 25 fps — the rig's behaviour is fixed.
    expect(retimeFrames(240, TB_24, TB_25)).toBe(250);
    expect(retimeFrames(250, TB_25, TB_24)).toBe(240);
    expect(retimeFrames(240, TB_24, TB_23976)).toBe(240); // 24 -> 23.976 is a pulldown, same count
  });

  it("formats a duration with frames first", () => {
    expect(formatDuration(240, TB_24)).toBe("240f · 00:00:10:00");
  });

  it("has a sane default", () => {
    expect(DEFAULT_TIMEBASE).toEqual(TB_24);
  });
});
