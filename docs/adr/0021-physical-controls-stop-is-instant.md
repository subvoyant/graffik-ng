# ADR-0021: Physical controls — stopping is instant, starting is a hold

**Status:** Accepted (v0.14)
**Date:** 2026-08-19
**Deciders:** Project owner + Claude

## Context

Gamepad **axis** bindings landed in v0.6. Gamepad **button** bindings went into
the backlog and stayed there for eight versions, described as "e-stop on a
button" — which undersells it. Until now the only e-stop was a button on screen,
reachable by moving a mouse cursor to a target.

That is the wrong instrument for the job. When a camera is heading somewhere it
should not be, the operator is looking at the rig, not the screen, and their
hand is on a controller. Hunting for a cursor is measured in seconds; a thumb is
measured in milliseconds.

Reading the existing poll loop to add buttons turned up two things that made the
slice more urgent than "nice to have".

## Decision

### 1. Stopping is instant and always available. Starting requires deliberation.

This is the rule the whole feature exists to encode, and it is deliberately
**asymmetric**:

- **STOP fires the moment the button goes down.** No hold, no confirmation, no
  modal, no check for what the app is currently doing. An e-stop that asks a
  question is not an e-stop.
- **Anything that can put the rig in motion must be held for 600 ms.** Run pass
  and Send to start are both a hold. A controller put down on a flight case, or
  knocked off one, must not be able to start a cinema camera moving.

Deliberation means **hold**, not double-press. A bouncing or sticky button can
fake a double-press; nothing fakes 600 ms of continuous contact. A hold can also
show progress while it happens — there is a bar in the dialog — so the control
teaches itself instead of surprising people.

`HoldLatch` fires **once per press**, not repeatedly while held: a held button
is one instruction, and a Run pass that retriggered every tick would restart the
move the instant it finished.

### 2. The button loop is separate from the jog loop, and always runs

The jog loop only runs when the operator has toggled gamepad jog on. Hanging the
e-stop off that would have made it work only while jogging — and the moment you
most want a physical stop is during a *programmed pass*, which is exactly when
gamepad jog is off.

So there are two loops. The button loop runs at 40 ms whenever a controller is
present, regardless of the jog toggle, regardless of which dialog is open, and
regardless of what has DOM focus.

### 3. Nothing is bound by default

A guessed e-stop button is worse than no e-stop, because the operator would
believe in it. Instead the absence is made loud: the dialog shows a red warning
whenever no STOP button is bound, and two actions sharing one button is reported
as the ambiguity it is rather than accepted as a shortcut.

### 4. The policy lives in the core and is bridged, not copied

`CONTROL_ACTIONS` — including every `holdMs` — lives in
`packages/nmx-protocol/src/controls.ts` and reaches the renderer through preload,
exactly as timecode does (ADR-0014). "Starting requires deliberation" having two
homes is how it would quietly stop being true in one of them. Only the twelve-line
latch state machine is mirrored in the renderer, because the button loop reads it
every 40 ms and an IPC round trip per tick would be absurd.

The invariant is also asserted directly: a test walks `CONTROL_ACTIONS` and fails
if the stop action ever grows a hold, or if any motion action ever loses one.

### 5. A vanished controller stops the rig — this was a live bug

The old jog loop did `if (!pad || !connected) return;`. If a controller's USB
dropped mid-jog, that returned early **and left the last commanded jog speed
running.** The firmware's joystick watchdog would eventually catch it, which is
what it is for — but "eventually, by a timeout we have never measured" is not how
a moving camera should be stopped, and nothing told the operator it had happened.

Now a missing controller with non-zero speeds outstanding zeroes every axis
immediately, says so in the status bar, and logs it to the pass log. The firmware
watchdog remains the backstop it always was.

## Consequences

- The rig has a physical stop for the first time. It works during a programmed
  pass, with any dialog open, and whether or not gamepad jog is on.
- Capture-keyframe on a button makes the jog-to-keyframe idiom the editor was
  built around actually usable at the rig rather than at the laptop.
- Adding a Buttons section to the gamepad dialog pushed its content past what
  the sheet could show and silently clipped the live-response canvas. Fixed
  generally rather than locally: **no `.sheet` may clip its own content** — a
  dialog whose last section is invisible does not have a last section.
- **Unverified against a controller.** The Gamepad API behaviour, button
  numbering per device, and how a real controller reports a dropped connection
  are all reasoned. Button indices are not standardised across devices, which is
  exactly why binding is a learn-by-pressing flow and not a numbered list.

## Alternatives considered

**Double-press for motion actions.** Fewer milliseconds to wait, and a bouncing
button can produce one on its own. Rejected — the failure mode is "the rig
started moving and nobody pressed anything twice".

**Confirm dialog for motion actions.** Puts the confirmation on screen, which is
the exact place the operator is not looking. It would also mean reaching for the
mouse to confirm a control whose whole purpose is to avoid the mouse.

**Bind a sensible default e-stop button (say, B on an Xbox pad).** Button indices
are not standardised, so a default is a guess, and a guessed e-stop is one people
trust without testing. Rejected in favour of a loud warning.

**Make the e-stop unbindable-away.** Tempting, and it would stop somebody
accidentally clearing it. But it would also mean the app refusing to let an
operator lay out their own controller, and the warning already covers the case
without taking the decision away.
