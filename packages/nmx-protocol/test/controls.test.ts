import { describe, it, expect } from "vitest";
import {
  CONTROL_ACTIONS, STOP_ACTION_ID, HoldLatch,
  DEFAULT_BUTTON_BINDINGS, unboundStopWarning, duplicateButtonBindings,
} from "../src/index.js";

describe("the deliberation policy", () => {
  /**
   * The load-bearing invariant of this whole file. If either half of this ever
   * fails, something has quietly made stopping harder or starting easier.
   */
  it("stops instantly and never asks anything to be held to stop", () => {
    const stop = CONTROL_ACTIONS.find((a) => a.id === STOP_ACTION_ID)!;
    expect(stop.holdMs).toBe(0);
    expect(stop.motion).toBe(false);
  });

  it("makes every action that can move the rig a hold", () => {
    for (const a of CONTROL_ACTIONS) {
      if (a.motion) expect(a.holdMs).toBeGreaterThanOrEqual(400);
    }
  });

  it("gives every action a note, so the policy is visible rather than folklore", () => {
    for (const a of CONTROL_ACTIONS) expect(a.note.length).toBeGreaterThan(10);
  });

  it("has no duplicate action ids", () => {
    const ids = CONTROL_ACTIONS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("HoldLatch", () => {
  it("fires immediately at zero hold — an e-stop that waits is not one", () => {
    const l = new HoldLatch(0);
    expect(l.update(true, 1000)).toBe(true);
  });

  it("does not fire on a knock", () => {
    const l = new HoldLatch(600);
    expect(l.update(true, 0)).toBe(false);
    expect(l.update(true, 200)).toBe(false);
    expect(l.update(false, 250)).toBe(false);   // released early
    expect(l.update(true, 300)).toBe(false);    // and the clock restarts
    expect(l.update(true, 700)).toBe(false);
  });

  it("fires once the hold completes", () => {
    const l = new HoldLatch(600);
    l.update(true, 0);
    expect(l.update(true, 599)).toBe(false);
    expect(l.update(true, 600)).toBe(true);
  });

  /** A held button is ONE instruction. Retriggering would restart a pass the
      instant it finished. */
  it("fires only once per press, however long it is held", () => {
    const l = new HoldLatch(600);
    l.update(true, 0);
    expect(l.update(true, 600)).toBe(true);
    for (const t of [700, 900, 5000]) expect(l.update(true, t)).toBe(false);
  });

  it("re-arms after a release", () => {
    const l = new HoldLatch(600);
    l.update(true, 0); l.update(true, 600);
    l.update(false, 700);
    l.update(true, 800);
    expect(l.update(true, 1400)).toBe(true);
  });

  it("reports progress so a hold is visible while it happens", () => {
    const l = new HoldLatch(600);
    expect(l.progress(0)).toBe(0);
    l.update(true, 0);
    expect(l.progress(300)).toBeCloseTo(0.5, 6);
    l.update(true, 600);
    expect(l.progress(600)).toBe(1);
  });

  it("reports no progress for an instant action", () => {
    const l = new HoldLatch(0);
    l.update(true, 0);
    expect(l.progress(0)).toBe(0);
  });

  it("forgets a press in flight when reset — a vanished controller is not a press", () => {
    const l = new HoldLatch(600);
    l.update(true, 0);
    l.reset();
    expect(l.update(true, 600)).toBe(false);   // the clock restarted at 600
    expect(l.update(true, 1200)).toBe(true);
  });
});

describe("binding hygiene", () => {
  it("binds nothing by default — a guessed e-stop is worse than none", () => {
    expect(DEFAULT_BUTTON_BINDINGS[STOP_ACTION_ID].index).toBeNull();
    expect(unboundStopWarning(DEFAULT_BUTTON_BINDINGS)).toMatch(/No STOP button is bound/);
  });

  it("goes quiet once a stop is bound", () => {
    expect(unboundStopWarning({ ...DEFAULT_BUTTON_BINDINGS, [STOP_ACTION_ID]: { index: 1 } })).toBeNull();
  });

  it("warns about a missing binding object at all, not just a null index", () => {
    expect(unboundStopWarning({})).toMatch(/No STOP button is bound/);
  });

  it("catches two actions on one button — an ambiguity, not a shortcut", () => {
    const d = duplicateButtonBindings({
      [STOP_ACTION_ID]: { index: 1 }, runPass: { index: 1 }, gotoStart: { index: 2 },
    });
    expect(d).toHaveLength(1);
    expect(d[0].index).toBe(1);
    expect(d[0].ids.sort()).toEqual(["estop", "runPass"]);
  });

  it("does not count unbound actions as sharing a button", () => {
    expect(duplicateButtonBindings(DEFAULT_BUTTON_BINDINGS)).toEqual([]);
  });
});
