import { describe, expect, it } from "vitest";
import { NO_LIMITS, describeViolations, isTaught, jogWouldExceed, violationsForFilm, limitTrust } from "../src/limits.js";
import { newFilm } from "../src/film.js";

const L = { min: -1000, max: 5000 };

describe("soft limits", () => {
  it("untaught bounds never block", () => {
    expect(isTaught(NO_LIMITS[0])).toBe(false);
    expect(jogWouldExceed({ min: null, max: null }, 0, 4000)).toBe(false);
  });

  it("jog lookahead stops before arrival, and never blocks moving AWAY from a limit", () => {
    // 800 steps/s for 250ms = 200 steps of lookahead
    expect(jogWouldExceed(L, 4900, 800)).toBe(true);   // would reach 5100 > 5000
    expect(jogWouldExceed(L, 4700, 800)).toBe(false);  // reaches 4900, still legal
    // sitting past the max, jogging negative must remain allowed (recoverable)
    expect(jogWouldExceed(L, 5200, -800)).toBe(false);
    expect(jogWouldExceed(L, -1200, 800)).toBe(false);
  });

  it("flags every out-of-range keyframe before upload", () => {
    const film = newFilm("t", 30000);
    film.axes[0].points = [{ time: 0, position: 0 }, { time: 30000, position: 8000 }];
    film.axes[1].points = [{ time: 0, position: -4000 }, { time: 30000, position: 0 }];
    const v = violationsForFilm(film, [L, L, { min: null, max: null }]);
    expect(v).toHaveLength(2);
    expect(v[0]).toMatchObject({ axis: 0, keyIndex: 1, bound: "max", limit: 5000 });
    expect(v[1]).toMatchObject({ axis: 1, keyIndex: 0, bound: "min", limit: -1000 });
    expect(describeViolations(v)).toMatch(/Slide key 2 at 8000 exceeds max limit 5000/);
    expect(violationsForFilm(film, NO_LIMITS)).toEqual([]);
  });
});

describe("do the taught numbers still mean what they meant? (ADR-0030)", () => {
  const v = (reportedPowerCycle: boolean | null, restoresPosition: boolean | null, anyTaught = true) =>
    limitTrust({ reportedPowerCycle, restoresPosition }, anyTaught);

  it("voids the limits when the controller power-cycled and does not restore position", () => {
    const r = v(true, false);
    expect(r.trust).toBe("void");
    expect(r.voided).toBe(true);
    expect(r.message).toMatch(/describe different places/);
  });

  it("keeps them when the controller restores position across a cycle", () => {
    const r = v(true, true);
    expect(r.trust).toBe("trusted");
    expect(r.voided).toBe(false);
  });

  it("calls a controller that does not restore position FRAGILE even with no cycle reported", () => {
    const r = v(false, false);
    expect(r.trust).toBe("fragile");
    expect(r.voided).toBe(false);
    /* The whole point: query 119 is consumed by whoever reads it first, so a
       false is not evidence of no power cycle. */
    expect(r.message).toMatch(/consumed by whoever reads it first/);
  });

  it("does not claim to know when the controller was never asked", () => {
    expect(v(null, false).trust).toBe("unknown");
    expect(v(true, null).trust).toBe("unknown");
    expect(v(null, null).voided).toBe(false);
  });

  it("has nothing to say when nothing has been taught", () => {
    const r = v(true, false, false);
    expect(r.trust).toBe("unknown");
    expect(r.voided).toBe(false);
    expect(r.message).toMatch(/Nothing to trust or distrust|nothing to trust/i);
  });

  it("never voids on a controller that restores position, whatever the flag said", () => {
    expect(v(true, true).voided).toBe(false);
    expect(v(false, true).voided).toBe(false);
  });
});
