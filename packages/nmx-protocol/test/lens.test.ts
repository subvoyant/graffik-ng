import { describe, it, expect } from "vitest";
import {
  LensAxis, LensMap, newLensAxis, sampleLensAxis, lensValueAt, lensPositionFor,
  formatLensValue, validateLensMap, validateLensAxis, LENS_KINDS,
} from "../src/lens.js";
import { newFilm, serializeFilm, deserializeFilm, FILM_VERSION } from "../src/film.js";
import { Timebase } from "../src/timecode.js";

const TB_24: Timebase = { num: 24, den: 1, dropFrame: false };

/** A real focus scale: heavily non-linear, which is the whole point. */
const FOCUS_MAP: LensMap = {
  name: "Zeiss CP.3 32mm", kind: "focus",
  marks: [
    { position: 0, value: 0.45, label: "18\"" },
    { position: 0.35, value: 1.0, label: "3'3\"" },
    { position: 0.7, value: 3.0, label: "10'" },
    { position: 1, value: 100, label: "inf" },
  ],
};

describe("lens maps", () => {
  it("interpolates between marks", () => {
    expect(lensValueAt(FOCUS_MAP, 0)).toBe(0.45);
    expect(lensValueAt(FOCUS_MAP, 0.35)).toBe(1.0);
    expect(lensValueAt(FOCUS_MAP, 0.525)).toBeCloseTo(2.0, 6);   // halfway 1.0 -> 3.0
  });

  it("clamps outside the marked range instead of extrapolating", () => {
    // Past the last witness mark a lens claims nothing, so neither do we.
    expect(lensValueAt(FOCUS_MAP, -1)).toBe(0.45);
    expect(lensValueAt(FOCUS_MAP, 2)).toBe(100);
  });

  it("follows a non-linear scale — the reason marks exist at all", () => {
    // Half travel is NOT half distance: 0.5 sits at 1.86 m, not 50 m.
    expect(lensValueAt(FOCUS_MAP, 0.5)).toBeCloseTo(1.857, 2);
  });

  it("inverts back to a barrel position", () => {
    expect(lensPositionFor(FOCUS_MAP, 1.0)).toBeCloseTo(0.35, 6);
    expect(lensPositionFor(FOCUS_MAP, 2.0)).toBeCloseTo(0.525, 6);
    expect(lensPositionFor(FOCUS_MAP, 0.1)).toBe(0);      // closer than the lens goes
    expect(lensPositionFor(FOCUS_MAP, 1000)).toBe(1);     // beyond infinity
  });

  it("handles a descending scale (iris: open is a low T-number)", () => {
    const iris: LensMap = { name: "T", kind: "iris", marks: [
      { position: 0, value: 1.5 }, { position: 1, value: 22 } ] };
    expect(lensPositionFor(iris, 1.5)).toBe(0);
    expect(lensPositionFor(iris, 22)).toBe(1);
    expect(lensValueAt(iris, 0.5)).toBeCloseTo(11.75, 6);
  });

  it("rejects maps that cannot be interpolated", () => {
    expect(() => validateLensMap({ name: "x", kind: "focus", marks: [{ position: 0, value: 1 }] }))
      .toThrow(/at least 2 marks/);
    expect(() => validateLensMap({ name: "x", kind: "focus", marks: [
      { position: 0.5, value: 1 }, { position: 0.2, value: 2 }] })).toThrow(/increasing position order/);
    expect(() => validateLensMap({ name: "x", kind: "focus", marks: [
      { position: 0, value: 1 }, { position: 1.5, value: 2 }] })).toThrow(/0\.\.1/);
    expect(() => validateLensMap({ name: "x", kind: "warp" as never, marks: [
      { position: 0, value: 1 }, { position: 1, value: 2 }] })).toThrow(/unknown lens axis kind/);
  });
});

describe("display", () => {
  const axis = (kind: "focus" | "iris" | "zoom", map?: LensMap): LensAxis =>
    ({ kind, target: kind, keys: [], ...(map ? { map } : {}) });

  it("shows a percentage when the lens is not mapped — never a fake distance", () => {
    expect(formatLensValue(axis("focus"), 0.42)).toBe("42%");
  });

  it("shows real units once marks exist", () => {
    expect(formatLensValue(axis("focus", FOCUS_MAP), 0.35)).toBe("1.00m");
    expect(formatLensValue(axis("iris", { name: "t", kind: "iris", marks: [
      { position: 0, value: 1.4 }, { position: 1, value: 16 }] }), 0)).toBe("T1.4");
    expect(formatLensValue(axis("zoom", { name: "z", kind: "zoom", marks: [
      { position: 0, value: 24 }, { position: 1, value: 70 }] }), 1)).toBe("70mm");
  });
});

describe("sampling", () => {
  it("uses the same solver as the motion axes, one sample per frame", () => {
    const ax = newLensAxis("focus", 48);
    ax.keys = [{ frame: 0, position: 0 }, { frame: 48, position: 1 }];
    const s = sampleLensAxis(ax, 48);
    expect(s).toHaveLength(49);
    expect(s[0]).toBe(0);
    expect(s[48]).toBeCloseTo(1, 6);
    // Eased like every other axis: the midpoint is half, the quarter is behind.
    expect(s[24]).toBeCloseTo(0.5, 3);
    expect(s[12]).toBeLessThan(0.25);
  });

  it("clamps to the barrel — a solver overshoot must not drive past the stop", () => {
    const ax = newLensAxis("focus", 48);
    ax.keys = [{ frame: 0, position: 0 }, { frame: 8, position: 1 }, { frame: 48, position: 0.98 }];
    for (const v of sampleLensAxis(ax, 48)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it("holds a single key flat, and an empty axis at zero", () => {
    const one = newLensAxis("iris", 10);
    one.keys = [{ frame: 5, position: 0.7 }];
    expect(sampleLensAxis(one, 10)).toEqual(new Array(11).fill(0.7));
    const none = newLensAxis("zoom", 4);
    none.keys = [];
    expect(sampleLensAxis(none, 4)).toEqual([0, 0, 0, 0, 0]);
  });
});

describe("validation", () => {
  it("refuses positions outside the barrel and fractional frames", () => {
    const ax = newLensAxis("focus", 48);
    ax.keys = [{ frame: 0, position: 1.5 }];
    expect(() => validateLensAxis(ax, 48)).toThrow(/0\.\.1/);
    ax.keys = [{ frame: 2.5, position: 0.5 }];
    expect(() => validateLensAxis(ax, 48)).toThrow(/whole frames/);
    ax.keys = [{ frame: 99, position: 0.5 }];
    expect(() => validateLensAxis(ax, 48)).toThrow(/outside the move/);
  });

  it("refuses a map for the wrong axis", () => {
    const ax = newLensAxis("zoom", 48);
    ax.map = FOCUS_MAP;
    expect(() => validateLensAxis(ax, 48)).toThrow(/map is for a focus axis/);
  });

  it("starts a new axis flat at mid-travel", () => {
    const ax = newLensAxis("focus", 240);
    expect(ax.keys).toEqual([{ frame: 0, position: 0.5 }, { frame: 240, position: 0.5 }]);
    expect(LENS_KINDS).toContain(ax.kind);
  });
});

describe("film integration (schema v3)", () => {
  const withLens = () => {
    const f = newFilm("Focus pull", 240, TB_24);
    const focus = newLensAxis("focus", 240);
    focus.keys = [{ frame: 0, position: 0.2 }, { frame: 120, position: 0.8 }, { frame: 240, position: 0.6 }];
    focus.map = FOCUS_MAP;
    f.lensAxes = [focus];
    return f;
  };

  it("round-trips lens axes and their maps", () => {
    const f = withLens();
    expect(deserializeFilm(serializeFilm(f))).toEqual(f);
  });

  it("is schema v3 — an older build must REFUSE, not silently drop the focus", () => {
    expect(FILM_VERSION).toBe(3);
    const f = withLens();
    expect(() => serializeFilm({ ...f, version: 4 })).toThrow(/newer than this app/);
  });

  it("accepts a v2 file unchanged and stamps it v3", () => {
    const v2 = { ...newFilm("old", 240, TB_24), version: 2 };
    delete (v2 as { lensAxes?: unknown }).lensAxes;
    const f = deserializeFilm(JSON.stringify(v2));
    expect(f.version).toBe(3);
    expect(f.lensAxes).toBeUndefined();
  });

  it("rejects two axes of the same kind", () => {
    const f = withLens();
    f.lensAxes = [newLensAxis("focus", 240), newLensAxis("focus", 240)];
    expect(() => serializeFilm(f)).toThrow(/duplicate lens axis: focus/);
  });

  it("validates lens keys against the move's duration", () => {
    const f = withLens();
    f.lensAxes![0].keys.push({ frame: 999, position: 0.5 });
    expect(() => serializeFilm(f)).toThrow(/outside the move/);
  });
});
