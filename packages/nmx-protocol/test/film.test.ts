import { describe, expect, it } from "vitest";
import {
  FILM_VERSION, deserializeFilm, newFilm, serializeFilm, migrateFilm,
  filmDurationMs, filmCueMs, filmAxesToMs, filmTimecode, buildCueList, eventsInWindow,
} from "../src/film.js";
import { Timebase } from "../src/timecode.js";

const TB_24: Timebase = { num: 24, den: 1, dropFrame: false };
const TB_23976: Timebase = { num: 24000, den: 1001, dropFrame: false };

describe("film persistence", () => {
  it("round-trips a valid film", () => {
    const film = newFilm("Jimini pass A", 720, TB_24);
    film.axes[0].points = [
      { frame: 0, position: 0 },
      { frame: 360, position: 7000 },
      { frame: 720, position: 8000 },
    ];
    expect(deserializeFilm(serializeFilm(film))).toEqual(film);
  });

  it("defaults a new film to 10 seconds at the given rate", () => {
    expect(newFilm("x", undefined, TB_24).durationFrames).toBe(240);
    expect(newFilm("x", undefined, { num: 25, den: 1, dropFrame: false }).durationFrames).toBe(250);
    expect(newFilm("x", undefined, TB_23976).durationFrames).toBe(240);
    expect(newFilm().cueFrames).toBe(120);
  });

  it("rejects garbage, wrong format, and future versions", () => {
    expect(() => deserializeFilm("not json {{{")).toThrow(/not valid JSON/);
    expect(() => deserializeFilm(JSON.stringify({ format: "other" }))).toThrow(/unknown format/);
    const future = { ...newFilm(), version: FILM_VERSION + 1 };
    expect(() => deserializeFilm(JSON.stringify(future))).toThrow(/newer than this app/);
  });

  it("rejects structural violations", () => {
    const base = newFilm();
    expect(() => serializeFilm({ ...base, durationFrames: 0 })).toThrow(/durationFrames/);
    expect(() => serializeFilm({ ...base, engine: "warp" as never })).toThrow(/unknown engine/);
    const badOrder = newFilm();
    badOrder.axes[0].points = [{ frame: 5, position: 0 }, { frame: 5, position: 1 }];
    expect(() => serializeFilm(badOrder)).toThrow(/strictly increasing/);
    const outOfRange = newFilm("x", 100, TB_24);
    outOfRange.axes[1].points = [{ frame: 0, position: 0 }, { frame: 200, position: 1 }];
    expect(() => serializeFilm(outOfRange)).toThrow(/outside the move/);
  });

  it("refuses fractional frames — a keyframe belongs to a frame", () => {
    const f = newFilm("x", 240, TB_24);
    f.axes[0].points = [{ frame: 0, position: 0 }, { frame: 12.5, position: 1 }, { frame: 240, position: 2 }];
    expect(() => serializeFilm(f)).toThrow(/whole frames/);
  });

  it("refuses an illegal drop-frame timebase", () => {
    const f = newFilm("x", 240, TB_24);
    f.timebase = { num: 24000, den: 1001, dropFrame: true };
    expect(() => serializeFilm(f)).toThrow(/only defined for/);
  });
});

describe("the protocol boundary (frames -> ms)", () => {
  it("converts duration and cue", () => {
    const f = newFilm("x", 240, TB_24);
    expect(filmDurationMs(f)).toBe(10_000);
    expect(filmCueMs(f)).toBe(5_000);
  });

  it("uses the exact rational for pulled-down rates", () => {
    const f = newFilm("x", 240, TB_23976);
    // 240 frames at 24000/1001 = 10010 ms, not 10000. Getting this wrong is a
    // 10 ms/10 s error — a quarter frame — which is visible between passes.
    expect(filmDurationMs(f)).toBe(10_010);
  });

  it("converts keyframe times for the KF engine", () => {
    const f = newFilm("x", 240, TB_24);
    f.axes[0].points = [{ frame: 0, position: 0 }, { frame: 96, position: 500 }, { frame: 240, position: 900 }];
    expect(filmAxesToMs(f)[0].points).toEqual([
      { time: 0, position: 0 },
      { time: 4000, position: 500 },
      { time: 10_000, position: 900 },
    ]);
  });

  it("preserves an explicitly solved velocity through the boundary", () => {
    const f = newFilm("x", 240, TB_24);
    f.axes[0].points = [{ frame: 0, position: 0 }, { frame: 120, position: 5, velocity: 0.25 }, { frame: 240, position: 9 }];
    expect(filmAxesToMs(f)[0].points[1]).toEqual({ time: 5000, position: 5, velocity: 0.25 });
  });

  it("labels frames against the move's start timecode", () => {
    const f = newFilm("x", 240, TB_24);
    expect(filmTimecode(f, 0)).toBe("00:00:00:00");
    f.startFrame = 86_400; // 01:00:00:00
    expect(filmTimecode(f, 0)).toBe("01:00:00:00");
    expect(filmTimecode(f, 24)).toBe("01:00:01:00");
  });
});

describe("v1 -> v2 migration", () => {
  const v1 = {
    format: "graffik-ng-move",
    version: 1,
    name: "Old move",
    durationMs: 30_000,
    startDelayMs: 5_000,
    engine: "keyframe",
    axes: [
      { axis: 0, points: [{ time: 0, position: 0 }, { time: 15_000, position: 7000 }, { time: 30_000, position: 8000 }] },
      { axis: 1, points: [{ time: 0, position: 0 }, { time: 30_000, position: 100 }] },
      { axis: 2, points: [{ time: 0, position: 0 }, { time: 30_000, position: -50 }] },
    ],
  };

  it("loads a v1 file and converts it to frames at 24 fps", () => {
    const f = deserializeFilm(JSON.stringify(v1));
    expect(f.version).toBe(2);
    expect(f.timebase).toEqual(TB_24);
    expect(f.durationFrames).toBe(720);
    expect(f.cueFrames).toBe(120);
    expect(f.axes[0].points.map((p) => p.frame)).toEqual([0, 360, 720]);
  });

  it("preserves real time exactly through the migration", () => {
    const f = deserializeFilm(JSON.stringify(v1));
    expect(filmDurationMs(f)).toBe(v1.durationMs);
    expect(filmAxesToMs(f)[0].points.map((p) => p.time)).toEqual([0, 15_000, 30_000]);
  });

  it("records the assumed rate in the file rather than hiding it", () => {
    const f = migrateFilm(v1);
    expect(f.notes).toMatch(/24 fps was assumed/);
  });
});

describe("timeline events (ADR-0016)", () => {
  const withEvents = () => {
    const f = newFilm("Cued move", 240, TB_24);
    f.events = [
      { id: "e2", frame: 120, target: "focus", action: { kind: "level", value: 0.6 } },
      { id: "e1", frame: 0, durationFrames: 12, target: "cue-light", action: { kind: "pulse", ms: 40 } },
      { id: "e3", frame: 240, target: "house", action: { kind: "dmx", channel: 12, value: 255 } },
    ];
    return f;
  };

  it("round-trips events through save/load", () => {
    const f = withEvents();
    expect(deserializeFilm(serializeFilm(f))).toEqual(f);
  });

  it("loads a v2 file that predates events", () => {
    const f = newFilm("No cues", 240, TB_24);
    delete f.events;
    expect(deserializeFilm(serializeFilm(f)).events).toBeUndefined();
  });

  it("rejects malformed events with a readable reason", () => {
    const bad = (mut) => { const f = withEvents(); mut(f); return () => serializeFilm(f); };
    expect(bad((f) => { f.events[0].frame = 12.5; })).toThrow(/whole frame/);
    expect(bad((f) => { f.events[0].frame = 9999; })).toThrow(/outside the move/);
    expect(bad((f) => { f.events[1].durationFrames = 9999; })).toThrow(/past the end/);
    expect(bad((f) => { f.events[0].id = "e1"; })).toThrow(/duplicate event id/);
    expect(bad((f) => { f.events[0].target = ""; })).toThrow(/needs a target/);
    expect(bad((f) => { f.events[0].action = { kind: "teleport" }; })).toThrow(/unknown action kind/);
    expect(bad((f) => { f.events[2].action = { kind: "dmx", channel: 0, value: 5 }; })).toThrow(/channel must be 1\.\.512/);
    expect(bad((f) => { f.events[2].action = { kind: "dmx", channel: 12, value: 300 }; })).toThrow(/value must be 0\.\.255/);
  });

  it("builds a device cue list in milliseconds, sorted", () => {
    const cues = buildCueList(withEvents());
    expect(cues.map((c) => c.id)).toEqual(["e1", "e2", "e3"]);
    expect(cues.map((c) => c.atMs)).toEqual([0, 5000, 10_000]);
    expect(cues[0].endMs).toBe(500);          // 12 frames at 24 fps
    expect(cues[1].endMs).toBeUndefined();
  });

  it("converts cue times with the exact rational rate", () => {
    const f = withEvents();
    f.timebase = { num: 24000, den: 1001, dropFrame: false };
    expect(buildCueList(f)[1].atMs).toBe(5005);   // 120 frames at 23.976
  });

  it("selects events for a host-dispatch window, upper bound exclusive", () => {
    const f = withEvents();
    expect(eventsInWindow(f, 0, 121).map((e) => e.id)).toEqual(["e2", "e1"]);
    expect(eventsInWindow(f, 121, 241).map((e) => e.id)).toEqual(["e3"]);
    expect(eventsInWindow(f, 0, 120).map((e) => e.id)).toEqual(["e1"]);
  });

  it("has no cues when the move has none", () => {
    expect(buildCueList(newFilm())).toEqual([]);
    expect(eventsInWindow(newFilm(), 0, 999)).toEqual([]);
  });
});
