import { describe, expect, it } from "vitest";
import { FILM_VERSION, deserializeFilm, newFilm, serializeFilm } from "../src/film.js";

describe("film persistence", () => {
  it("round-trips a valid film", () => {
    const film = newFilm("Jimini pass A", 30000);
    film.axes[0].points = [
      { time: 0, position: 0 },
      { time: 15000, position: 7000 },
      { time: 30000, position: 8000 },
    ];
    const restored = deserializeFilm(serializeFilm(film));
    expect(restored).toEqual(film);
  });

  it("rejects garbage, wrong format, and future versions", () => {
    expect(() => deserializeFilm("not json {{{")).toThrow(/not valid JSON/);
    expect(() => deserializeFilm(JSON.stringify({ format: "other" }))).toThrow(/unknown format/);
    const future = { ...newFilm(), version: FILM_VERSION + 1 };
    expect(() => deserializeFilm(JSON.stringify(future))).toThrow(/newer than this app/);
  });

  it("rejects structural violations", () => {
    const base = newFilm();
    expect(() => serializeFilm({ ...base, durationMs: 0 })).toThrow(/durationMs/);
    expect(() => serializeFilm({ ...base, engine: "warp" as never })).toThrow(/unknown engine/);
    const badOrder = newFilm();
    badOrder.axes[0].points = [{ time: 5, position: 0 }, { time: 5, position: 1 }];
    expect(() => serializeFilm(badOrder)).toThrow(/strictly increasing/);
    const outOfRange = newFilm("x", 1000);
    outOfRange.axes[1].points = [{ time: 0, position: 0 }, { time: 2000, position: 1 }];
    expect(() => serializeFilm(outOfRange)).toThrow(/outside 0..durationMs/);
  });
});
