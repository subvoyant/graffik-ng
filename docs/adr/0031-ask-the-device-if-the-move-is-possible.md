# ADR-0031: Ask the controller whether the move is physically possible, before running it

**Status:** Accepted (v0.25) — unverified against hardware
**Date:** 2026-08-19
**Deciders:** Project owner + Claude

## Context

The controller validates an uploaded move against what its motors can actually
deliver, and has done since the firmware version this app gates on:

- **Key-frame engine:** query **105** runs `validateVel()` and query **106**
  runs `validateAccel()`, both for the currently selected axis — so select, then
  ask.
- **Classic engine:** general **129** is `validateProgram()` across all motors;
  motor **120** is `msAutoSet(motor, validateOnly = true)`, which names the axis.

Graffik NG has uploaded moves for twenty-four versions without ever asking.
Worse, `queryVelocityValid` and `queryAccelValid` have been **in the command
vocabulary the whole time, called by nothing** — the same shape as the dead
exports of ADR-0024, and invisible to that audit for the reason ADR-0029 gives:
`keyFrame` is reachable, so all of its members are.

What this costs is specific. A move that demands more than a motor can deliver
**does not fail loudly** — the rig simply does not track it. On a shoot that
reads as a belt problem, then a payload problem, then a software bug, in that
order, and costs the afternoon before anyone suspects the move itself.

## Decision

**One pre-flight before any pass, asking two questions in the order that
matters:** can the rig do this move at all, and can everything attached to the
pass be delivered.

- Key-frame: `setAxis(n)` then 105 and 106, per axis in the move. Selecting an
  axis is a pure pointer assignment in the firmware (`KeyFrames::setAxis`), so
  this is safe to run *after* an upload — it cannot disturb the program it is
  checking.
- Classic: motor 120 per axis, plus general 129 for the whole program.
- `describeMoveFeasibility()` is pure and **silent about axes the device is
  happy with**. A pre-flight that prints three "fine" lines is a pre-flight
  people learn to scroll past.

**Being unable to ask is not the same as being told no.** A query that times out
records `null`, which reads as *"the controller did not answer whether this move
is achievable — treat it as unchecked"* and **does not block the pass**.
Refusing there would stop every pass the moment a query times out, which is how
a safety check gets switched off permanently.

### Why this is not the "two gates" ADR-0018 warned about

ADR-0018 put cues and lens speeds behind a single gate because two gates mean
two chances to skip one. This lives in the *same* gate — but it had to move
outside the cue check's early return: `if (!cues && !lanes) return true` skips
everything when nothing is attached to the pass, and a plain three-axis move
with no cues is exactly the case where "can the rig do this" still matters. So
`preflightPass(engine)` asks the device first, then arms cues and lens lanes.
One call, one gate, two questions.

## Two things found while building it

**The simulator was answering "yes" to questions it had never been asked.**
`handleKeyFrame`'s `default: return this.ack()` meant 105, 106 and 121 all
returned a bare ack — so key-frame run time read as garbage for the flight
recorder (ADR-0029) and nothing said why. It now models all three: peak spline
speed against `maxStepsPerSec`, peak acceleration against `maxStepsPerSec2`, and
a real run time. Hub invariant 23 again — a simulator more permissive than the
device means every test passes and the rig fails.

The first version of that model checked `max|dn|`, the **knot** velocities, and
cheerfully passed a move that travels 5000 steps in one second on a
1000 steps/s rig — because a two-point move has zero velocity at both keys and
all of its speed in between. **Knot velocities are not the answer to "how fast
does this go"; the curve is.** It samples the Hermite now.

**`computeVelocities` accepted points it could not use.** The strictly-increasing
check compares with `<=`, and `undefined <= undefined` is false — so points with
the wrong field name sailed through and every abscissa reached the wire as
`NaN`. Found by writing a test wrong, which is a perfectly good way to find it.
It now refuses non-finite time, position or caller-supplied velocity by name and
index. This is the one function every uploaded move passes through, and it
should be the last place a NaN can survive.

## Consequences

- Two more commands in the vocabulary (general 129, motor 120), both verified
  against the dispatch, and two that existed and now have a caller.
- Asking costs 2 queries per axis on the key-frame path, once per pass, before
  motion — never during.
- `msAutoSet` with `validateOnly` is why motor 120 is safe to ask: the same
  routine without that flag re-picks the microstep setting and writes EEPROM.
  Nothing here changes the device.

## What would make this wrong

If a real NMX answers "not valid" for moves it then executes perfectly, the
gate becomes an obstacle and operators will learn to route around it. Phase 2
should run one deliberately over-fast move and one comfortable one, and confirm
the device's answers match what actually happens.
