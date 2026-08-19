/**
 * Physical control bindings and the deliberation policy (ADR-0021).
 *
 * THE RULE THIS FILE EXISTS TO ENCODE
 * -----------------------------------
 * **Stopping is instant and always available. Starting requires deliberation.**
 *
 * The asymmetry is the whole point. An e-stop that needs a confirmation is not
 * an e-stop; a "run pass" that fires on a knocked button puts a cinema camera
 * into motion because somebody put the controller down. Those two failures are
 * not symmetrical and must not be treated symmetrically.
 *
 * Deliberation here means **hold**, not double-press. A bouncing or sticky
 * button can fake a double-press; nothing fakes six hundred milliseconds of
 * continuous contact, and a hold can show progress while it happens, so the
 * operator learns the control rather than being surprised by it.
 */

export interface ControlAction {
  id: string;
  label: string;
  /** True if this action can put the rig in motion. */
  motion: boolean;
  /**
   * Milliseconds the button must be held before it fires. Zero = on press.
   * Motion actions are never zero, and the stop action is always zero.
   */
  holdMs: number;
  /** Shown next to the binding, so the policy is visible rather than folklore. */
  note: string;
}

export const STOP_ACTION_ID = "estop";

export const CONTROL_ACTIONS: readonly ControlAction[] = [
  {
    id: STOP_ACTION_ID, label: "STOP ALL", motion: false, holdMs: 0,
    note: "fires the instant it is pressed, whatever else is happening",
  },
  {
    id: "runPass", label: "Run pass", motion: true, holdMs: 600,
    note: "hold — this starts the rig moving",
  },
  {
    id: "gotoStart", label: "Send to start", motion: true, holdMs: 600,
    note: "hold — this starts the rig moving",
  },
  {
    id: "jogToggle", label: "Gamepad jog on/off", motion: false, holdMs: 0,
    note: "on press; turning jog OFF also zeroes every axis",
  },
  {
    id: "markKey", label: "Capture keyframe (all axes)", motion: false, holdMs: 0,
    note: "on press; edits the move, not the rig",
  },
];
/**
 * Guards a hold-to-fire control against a knock.
 *
 * Time is injected rather than read from `Date.now()`, for the same reason
 * `CueScheduler` does it: a safety-relevant state machine that cannot be tested
 * deterministically is one nobody can be confident in.
 */
export class HoldLatch {
  private downAt: number | null = null;
  private fired = false;

  constructor(readonly holdMs: number) {}

  /**
   * Feed the button's current state and the clock. Returns true on the single
   * tick where the action should fire.
   *
   * Fires **once** per press, not repeatedly while held: a held button is one
   * instruction, and a "run pass" that retriggered every tick would start the
   * move again the moment it finished.
   */
  update(pressed: boolean, nowMs: number): boolean {
    if (!pressed) { this.downAt = null; this.fired = false; return false; }
    if (this.downAt === null) { this.downAt = nowMs; this.fired = false; }
    if (this.fired) return false;
    if (nowMs - this.downAt >= this.holdMs) { this.fired = true; return true; }
    return false;
  }

  /** 0..1 while a hold is in progress — for showing the operator it is working. */
  progress(nowMs: number): number {
    if (this.downAt === null || this.holdMs <= 0) return 0;
    if (this.fired) return 1;
    return Math.max(0, Math.min(1, (nowMs - this.downAt) / this.holdMs));
  }

  /** Forget any press in flight — used when a controller disappears. */
  reset() { this.downAt = null; this.fired = false; }
}

export interface ButtonBinding {
  /** Gamepad button index, or null when nothing is bound. */
  index: number | null;
}

export type ButtonBindings = Record<string, ButtonBinding>;

export const DEFAULT_BUTTON_BINDINGS: ButtonBindings = {
  /* Nothing is bound by default. A guessed e-stop button is worse than none:
     the operator would believe the rig had one. `unboundStopWarning` makes the
     absence loud instead. */
  [STOP_ACTION_ID]: { index: null },
  runPass: { index: null },
  gotoStart: { index: null },
  jogToggle: { index: null },
  markKey: { index: null },
};

/**
 * The one binding whose absence is worth shouting about.
 *
 * A rig with a controller in someone's hands and no physical stop is a rig
 * whose stop is a mouse cursor, and hunting for a cursor is not what anybody
 * does when a camera is heading for the end of a rail.
 */
export function unboundStopWarning(bindings: ButtonBindings): string | null {
  return bindings[STOP_ACTION_ID]?.index === null || bindings[STOP_ACTION_ID]?.index === undefined
    ? "No STOP button is bound — the only e-stop is the one on screen. Bind a button before running anything that moves."
    : null;
}

/** Two actions on one button is an ambiguity, not a shortcut. */
export function duplicateButtonBindings(bindings: ButtonBindings): Array<{ index: number; ids: string[] }> {
  const byIndex = new Map<number, string[]>();
  for (const [id, b] of Object.entries(bindings)) {
    if (b?.index === null || b?.index === undefined) continue;
    byIndex.set(b.index, [...(byIndex.get(b.index) ?? []), id]);
  }
  return [...byIndex.entries()].filter(([, ids]) => ids.length > 1).map(([index, ids]) => ({ index, ids }));
}
