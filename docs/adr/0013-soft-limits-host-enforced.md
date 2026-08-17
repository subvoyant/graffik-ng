# ADR-0013: Soft travel limits, enforced host-side

**Status:** Accepted (jog-stop margin to be tuned on hardware)
**Date:** 2026-08-17
**Deciders:** Project owner + Claude

## Context

The original project plan called for "soft limits, a global e-stop, and sane
behavior on serial disconnect." We shipped the e-stop and the firmware watchdog
but never the limits — leaving one un-mitigated failure: driving the carriage
into a mechanical end stop. Unloaded that is a stall and a noise; with a cinema
package on the slider it is a bent rail, a dropped camera, or worse. The NMX has
**no encoder feedback**, so the controller cannot discover where "the end" is —
a human has to teach it by jogging there.

## Decision

Soft limits are **taught by jogging** (move to each end of safe travel, press
set), stored per axis in preferences, and **enforced in the Electron main
process** — not the renderer, so no UI bug can bypass them.

Three enforcement points:

1. **Jog request:** before sending a speed, if the projected position after a
   250 ms lookahead would exceed a taught bound, the jog is refused and the axis
   stopped. Motion *away* from a violated bound is always allowed, so a rig
   parked outside its limits is recoverable rather than bricked.
2. **Jog monitor:** while any axis is jogging, a 90 ms poll re-checks position
   and cuts that axis as it approaches a bound. This is the guard that matters,
   since jog is a continuous-speed command with no host-side end condition.
3. **Upload/arm:** every keyframe is checked against the limits *before any
   packet is sent*. A move that would exceed travel is rejected with a message
   naming the axis, key index, position, and bound.

The pure predicates (`withinLimit`, `clampToLimit`, `jogWouldExceed`,
`violationsForFilm`) live in the **core** package with unit tests, so the logic
is verifiable without hardware or Electron.

## Options Considered

**A. Firmware limits (motor cmds 9/10/33).** The controller enforces them itself,
which is stronger in principle. Rejected as the *primary* mechanism because: we
cannot validate the firmware's limit behavior without hardware; it mutates
persistent controller state that other apps (NMX Motion, Dragonframe) also see;
and it does not address the real risk any better than the host does — **we author
every move**, so every position that will ever be commanded is known to us before
it is sent. Revisit after hardware bring-up; the command vocabulary already exists.

**B. Renderer-side enforcement.** Simpler, but a renderer bug or a stray IPC call
would bypass it. Safety code belongs behind the process boundary (ADR-0007).

**C. Host-side in main (chosen).** Fully testable today, covers both real risk
paths, cannot be bypassed from the UI.

## Consequences

- Limits persist across launches, so a rig configuration survives a restart —
  and, importantly, so does a *stale* one. The UI shows taught values numerically
  and shades the forbidden zone on each timeline track so a wrong limit is
  visible rather than mysterious.
- The 250 ms lookahead and 90 ms poll are estimates. At 4000 steps/s the worst
  case overshoot is ~1000 steps plus deceleration. **Tune on hardware**
  (`docs/HARDWARE-BRINGUP.md` Phase 2) and, if needed, scale the margin with speed.
- Untaught axes are unconstrained — limits are opt-in, and an operator who skips
  them is exactly as exposed as before. This is deliberate: a tool that refuses
  to move until configured gets configured carelessly.
- Limits are not a substitute for the e-stop, the watchdog, or a hand near the
  power switch. They are the fourth layer, not the first.
