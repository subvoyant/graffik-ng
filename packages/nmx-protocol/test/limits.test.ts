import { describe, expect, it } from "vitest";
import { NO_LIMITS, clampToLimit, describeViolations, isTaught, jogWouldExceed, violationsForFilm, withinLimit } from "../src/limits.js";
import { newFilm } from "../src/film.js";

const L = { min: -1000, max: 5000 };

describe("soft limits", () => {
  it("untaught bounds never block", () => {
    expect(isTaught(NO_LIMITS[0])).toBe(false);
    expect(withinLimit({ min: null, max: null }, 999999)).toBe(true);
    expect(jogWouldExceed({ min: null, max: null }, 0, 4000)).toBe(false);
  });

  it("within/clamp respect taught bounds", () => {
    expect(withinLimit(L, 0)).toBe(true);
    expect(withinLimit(L, 5001)).toBe(false);
    expect(withinLimit(L, -1001)).toBe(false);
    expect(clampToLimit(L, 9999)).toBe(5000);
    expect(clampToLimit(L, -9999)).toBe(-1000);
    expect(clampToLimit(L, 250)).toBe(250);
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
