import { describe, it, expect } from "vitest";
import {
  LensLibraryEntry, LENS_LIBRARY_FORMAT, LENS_LIBRARY_VERSION,
  validateLensLibraryEntry, validateLensLibrary,
  serializeLensLibrary, parseLensLibrary,
  lensEntryToMap, lensMapToEntry, mergeLensLibrary, lensLibraryId,
  lensValueAt,
} from "../src/index.js";

const cp3 = (over: Partial<LensLibraryEntry> = {}): LensLibraryEntry => ({
  id: "focus-cp3-35mm-a1",
  name: "Zeiss CP.3 35mm",
  kind: "focus",
  marks: [
    { position: 0, value: 0.3, label: "1'" },
    { position: 0.45, value: 1.2, label: "4'" },
    { position: 1, value: 60, label: "∞" },
  ],
  ...over,
});

describe("library entries", () => {
  it("accepts a well-formed lens", () => {
    expect(() => validateLensLibraryEntry(cp3())).not.toThrow();
  });

  it("needs an id, a name and a known kind", () => {
    expect(() => validateLensLibraryEntry(cp3({ id: "" }))).toThrow(/needs an id/);
    expect(() => validateLensLibraryEntry(cp3({ name: "   " }))).toThrow(/needs a name/);
    expect(() => validateLensLibraryEntry(cp3({ kind: "bokeh" as never }))).toThrow(/unknown axis kind/);
  });

  /**
   * The point of reusing the map validator: an entry that would be rejected as
   * a map is one that cannot be used, and discovering that when it is applied
   * to a lane is discovering it too late.
   */
  it("rejects marks a map would reject", () => {
    expect(() => validateLensLibraryEntry(cp3({ marks: [{ position: 0, value: 1 }] }))).toThrow();
    expect(() => validateLensLibraryEntry(cp3({
      marks: [{ position: 0.5, value: 1 }, { position: 0.2, value: 2 }],
    }))).toThrow();
  });
});

describe("library files", () => {
  it("round-trips", () => {
    const lenses = [cp3(), cp3({ id: "iris-cp3-b2", name: "CP.3 T-stop", kind: "iris",
      marks: [{ position: 0, value: 2.1 }, { position: 1, value: 22 }] })];
    expect(parseLensLibrary(serializeLensLibrary(lenses))).toEqual(lenses);
  });

  it("stamps its own format and version", () => {
    const f = JSON.parse(serializeLensLibrary([cp3()]));
    expect(f.format).toBe(LENS_LIBRARY_FORMAT);
    expect(f.version).toBe(LENS_LIBRARY_VERSION);
  });

  it("refuses somebody else's JSON rather than guessing", () => {
    expect(() => parseLensLibrary('{"format":"something-else","version":1,"lenses":[]}'))
      .toThrow(/not a Graffik lens library/);
    expect(() => parseLensLibrary("not json at all")).toThrow(/not valid JSON/);
  });

  it("refuses a file from a newer build", () => {
    const f = { format: LENS_LIBRARY_FORMAT, version: LENS_LIBRARY_VERSION + 1, lenses: [] };
    expect(() => parseLensLibrary(JSON.stringify(f))).toThrow(/newer than this app/);
  });

  it("refuses duplicate ids — merge matches on id, so duplicates are ambiguous", () => {
    expect(() => serializeLensLibrary([cp3(), cp3({ name: "a different lens" })]))
      .toThrow(/duplicate lens id/);
  });
});

describe("applying and keeping", () => {
  it("an entry becomes a usable map", () => {
    const map = lensEntryToMap(cp3());
    expect(map.kind).toBe("focus");
    expect(lensValueAt(map, 0.45)).toBeCloseTo(1.2, 6);
  });

  it("a map becomes an entry, and the marks are copied not shared", () => {
    const map = lensEntryToMap(cp3());
    const entry = lensMapToEntry(map, "focus-x-1", "2026-08-19T00:00:00Z");
    entry.marks[0].value = 999;
    expect(map.marks[0].value).toBe(0.3);      // mutating one must not reach the other
    expect(entry.savedAt).toBe("2026-08-19T00:00:00Z");
  });

  it("makes readable, collision-resistant ids", () => {
    expect(lensLibraryId("focus", "Zeiss CP.3 35mm", "k3f9")).toBe("focus-zeiss-cp-3-35mm-k3f9");
    expect(lensLibraryId("iris", "  ***  ", "aa")).toBe("iris-lens-aa");
    expect(lensLibraryId("focus", "x".repeat(80), "z").length).toBeLessThan(50);
  });
});

describe("merging an imported library", () => {
  const mine = [cp3(), cp3({ id: "focus-sig-18mm", name: "Sigma 18mm" })];

  it("adds what is new and updates what matches by id", () => {
    const theirs = [
      cp3({ marks: [{ position: 0, value: 0.4 }, { position: 1, value: 70 }] }),   // same id
      cp3({ id: "focus-cooke-50", name: "Cooke S4 50mm" }),                        // new
    ];
    const r = mergeLensLibrary(mine, theirs);
    expect(r.updated).toEqual(["Zeiss CP.3 35mm"]);
    expect(r.added).toEqual(["Cooke S4 50mm"]);
    expect(r.merged).toHaveLength(3);
    expect(r.merged.find((e) => e.id === cp3().id)!.marks[0].value).toBe(0.4);
  });

  /** Names collide between people; ids do not. Matching on name would merge two
      different lenses into one and lose a set of marks. */
  it("does not match on name", () => {
    const r = mergeLensLibrary(mine, [cp3({ id: "focus-someone-elses-35" })]);
    expect(r.added).toEqual(["Zeiss CP.3 35mm"]);
    expect(r.merged).toHaveLength(3);
  });

  it("keeps the good lenses when one in the file is malformed", () => {
    const r = mergeLensLibrary(mine, [
      cp3({ id: "focus-good", name: "Good lens" }),
      cp3({ id: "focus-bad", name: "Bad lens", marks: [{ position: 0, value: 1 }] }),
    ]);
    expect(r.added).toEqual(["Good lens"]);
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0].name).toBe("Bad lens");
    expect(r.merged).toHaveLength(3);
  });

  it("leaves the library sorted by kind then name, so a picker is readable", () => {
    const r = mergeLensLibrary([], [
      cp3({ id: "z", name: "Zeiss 85", kind: "focus" }),
      cp3({ id: "a", name: "Angenieux", kind: "zoom", marks: [{ position: 0, value: 24 }, { position: 1, value: 290 }] }),
      cp3({ id: "b", name: "Arri 35", kind: "focus" }),
    ]);
    expect(r.merged.map((e) => e.name)).toEqual(["Arri 35", "Zeiss 85", "Angenieux"]);
  });

  it("importing an empty library adds nothing (but still returns canonical order)", () => {
    const r = mergeLensLibrary(mine, []);
    expect(r.added).toEqual([]);
    expect(r.updated).toEqual([]);
    expect(r.rejected).toEqual([]);
    // merge ALWAYS sorts — the picker has to be readable — so compare as a set
    expect([...r.merged].sort((a, b) => a.id.localeCompare(b.id)))
      .toEqual([...mine].sort((a, b) => a.id.localeCompare(b.id)));
  });
});
