# ADR-0018: Driving lens axes — GRAFFIK-TRIG protocol v2, and what the host is allowed to send

**Status:** Accepted (core, firmware, host wiring and both cross-checks landed in v0.11; nothing verified against a motor)
**Date:** 2026-08-18
**Deciders:** Project owner + Claude

## Context

ADR-0017 gave the app lens lanes and specified, in §4, how they would be driven.
This is that specification built, plus the three things building it changed.

The owner's hardware direction — an Arduino-class board with stepper driver
boards — settles the shape. The board that already runs cues is the board that
runs lenses; there is no second device, no second connection and no second
protocol, only a version bump.

## Decision

### 1. Protocol v2 on the existing board, and v1 boards still work

`HELLO` gains a fifth field: the number of lens axes. A v1 board does not emit
it and does not have the hardware, so it reports zero and `supportsLens()`
answers false.

ADR-0004's rule is "never guess at a command set you do not know" — but v1 is a
version we *do* know. It runs cues correctly. Refusing to connect to a working
cue board because the app grew a feature that board does not have would be the
rule applied past the point where it protects anybody. So `SUPPORTED_TRIGGER_PROTOCOLS = [1, 2]`,
and anything else is still refused outright.

```
-> LAXIS <n> <kind> <steps> <maxStepsPerSec> <invert>   <- LAXIS <n> OK
-> LCAL <n>              <- LCAL <n> <steps>  |  LCALERR <n> <reason>
-> LCLEAR                <- LCLEAR OK
-> LKEY <n> <ms> <pos0..65535>
-> LSYNC <id>            <- LSYNC <id> <pointsHeld>
-> LSEEK <n> <pos>
-> ARM                   <- READY <cues> <lensPoints>
-> GO                    <- STARTED <deviceMs>  |  LERR <n> <reason>
-> ABORT
```

### 2. The host sends samples, and decimates them under a stated error bound

The spline lives in the core and is shared with the on-screen preview
(ADR-0009). Putting it in an `.ino` would create a second motion solver and the
curve the operator draws would stop being the curve the rig pulls. So the host
samples its own spline per frame and sends the result.

Per-frame is too many points to send — 1 731 for a 24-second three-lane move,
34 kB of text while a performer waits. So it is decimated by **Douglas–Peucker
with a vertical error metric**.

Vertical, not perpendicular, deliberately: perpendicular distance would mix
milliseconds and travel units into one number, and the answer would change if
you expressed the same move in seconds. Vertical distance measures exactly the
quantity worth bounding — *how far the device's linear interpolation can be from
the spline the operator drew, at any instant* — and it is in the same 0..65535
units the wire uses, so the bound can be stated in **motor steps**.

The default bound is half a motor step once the barrel is calibrated. Measured:

| barrel | tolerance | points | upload |
|---|---|---|---|
| uncalibrated | 32 u | 77 / 1731 | 0.12 s |
| 2 000 steps | 16.4 u | 109 / 1731 | 0.17 s |
| 4 000 steps | 8.2 u | 132 / 1731 | 0.21 s |
| 20 000 steps | 1.6 u | 304 / 1731 | 0.49 s |

Nothing observable is given up: at a half-step bound the device's error is
inside the finest distinction its own motor can make. The firmware therefore
interpolates **linearly and only linearly** — that is what the bound is stated
against, and smoothing it on the device would silently invalidate the number.

The peak rate used for the feasibility pre-flight is measured on the **dense**
curve, not the decimated one. A decimated chord's slope is a weighted average of
the slopes it replaces and so can never exceed the dense maximum; measuring
dense is the conservative choice, and it means decimation can never quietly hide
a snap from the check.

### 3. Uploads are chunked and cross-checked, because the failure mode is silence

An ATmega's UART buffer is 64 bytes. `LSYNC` every 32 points costs two round
trips on a typical upload and converts a corrupt focus pull into a refusal.
`ARM` then reports its own lens point count and the host compares it against
what it sent, so a program lost between upload and arm is caught as well.

Over-capacity behaves the same way by construction: the firmware drops points it
has no room for, `LSYNC` reports the short count, and the host refuses. There is
no path where a truncated pull runs.

### 4. Calibration is mandatory, and only the board can claim it

A stepper is open loop. Its position means nothing until it has been measured
against a physical stop, so `LCAL` drives to both ends and records the travel —
the same thing a Preston MDR does whenever a motor is connected.

The host remembers the travel figure between sessions, but **only as a hint for
the feasibility pre-flight**. It is never treated as homing, because only the
board knows whether it has seen a stop since it powered up. An axis with a curve
and no homing makes `GO` answer `LERR` instead of `STARTED`; running blind would
drive the barrel into a stop at speed.

`LCAL` gets a 90-second timeout of its own. Inheriting the 1.5 s request timeout
that suits every other command would abandon a calibration that was working.

### 5. Motor handedness moved OUT of the move file — schema v4

ADR-0017 put `invert` on the lens axis. That was wrong, and this ADR corrects it
rather than pretending otherwise.

Which way a motor turns to move a barrel is a fact about a rig on a day. A move
file carrying it reverses somebody else's focus pull the moment they open it —
precisely the failure ADR-0016 moved cue bindings into preferences to avoid.
`.graffik` v4 strips the field and writes the fact into the file's `notes`, the
same idiom the v1→v2 timebase assumption uses; the setting now lives in
preferences with the rest of the rig configuration and is declared to the board
with `LAXIS`.

Downstream of that, nothing flips anything. The move describes the **barrel**,
the motor config describes the **motor**, and the firmware reconciles the two at
the DIR pin, where the handedness physically is. Display, 3D export and the wire
program all became simpler as a result, which is usually the sign.

### 6. ABORT stops and holds

Lens motion stops, the program is discarded, the position is not touched and the
drivers stay enabled. Never homes, never releases: a focus ring that free-wheels
while a heavy lens sits on a tilted head is a way to lose the lens. The host
clears its uploaded-point count on abort too, so the next `ARM` cannot "pass" by
comparing against a run that was abandoned.

### 7. The firmware is tested, and tested *against the simulator*

The reference sketch used to be the only part of the repo nothing checked. It
now has two checks, both in CI:

- **A host exercise.** `Arduino.h` is shimmed on the desktop — fake clock, pin
  array, and a simulated barrel with hard stops that moves on STEP edges in
  whatever direction DIR says. The sketch compiles and its protocol state
  machine, calibration, capacity refusal, abort-holds behaviour and curve
  interpolation are all asserted. It found a real bug on its first run:
  `seekStop` backed off a stop in the wrong direction and reported zero travel,
  which would have looked like a dead motor on every calibration.
- **A protocol parity check.** One script file is fed to both the TypeScript
  `SimulatedTriggerDevice` and the C++ firmware, and their replies must match
  exactly. This is the check that matters most: the host is written against the
  simulator, so a simulator *more permissive than the board* means every test
  passes and the rig fails. It caught the simulator accepting `LAXIS 9` on a
  three-axis board the first time it ran.

Neither proves anything electrical. Step timing under load, StallGuard tuning
and motor torque need a board.

## Consequences

- A focus pull now runs on the same clock as the cue list, started by the same
  `GO`. Between passes it is as repeatable as the board's crystal.
- One pre-flight gate covers the whole pass — unroutable cues and infeasible
  lens speeds are reported together, because two gates are two chances to skip
  one.
- The timeline band now says what is actually true: `(driven on device)` with a
  v2 board, `(authoring + export only — no lens device)` without one. A
  permanent "not driven" label would have been the app lying in the other
  direction as soon as hardware appeared.
- `.graffik` went from v3 to v4 one day after v3 shipped. That is the cost of
  having got §5 wrong; the migration is written and the file says what changed.
- **Nothing has driven a real lens motor.** Two cross-checks are not a rig.
  `docs/HARDWARE-BRINGUP.md` Phase 7 is the procedure.

## Alternatives considered

**Interpolate the spline on the device.** Would cut the upload to a handful of
keys and would put a second motion solver in the project. Rejected — ADR-0009 is
worth more than 2 kB.

**Send every frame.** Simplest, and 34 kB down a 115 200-baud line is three
seconds of a performer standing still, for points a motor cannot resolve.

**Trust the device to keep up and skip `LSYNC`.** Probably fine. "Probably fine"
in a path whose failure mode is a silently truncated focus pull is not a
standard this project uses.

**Keep `invert` on the axis and document it.** Cheaper than a schema bump, and
it leaves a file that behaves differently on different rigs. Rejected: the whole
point of a move file is that it is the same move somewhere else.

**A separate FIZ board.** A second connection, a second port to pick, a second
thing to forget to plug in — and a second clock, so cues and focus would be
started by two different `GO`s and drift apart. Rejected.
