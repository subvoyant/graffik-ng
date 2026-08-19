# ADR-0017: Lens axes (focus / iris / zoom) — normalised travel, mapped by witness marks, driven device-side

**Status:** Accepted — **partially superseded by [ADR-0018](0018-lens-device-protocol-v2.md)**
(schema, solver, timeline lanes, lens maps and 3D export landed in v0.10; §4's device
driver was built in v0.11, and §1's per-axis `invert` was wrong and moved to rig
configuration in schema v4 — see ADR-0018 §5)
**Date:** 2026-08-18
**Deciders:** Project owner + Claude

## Context

The owner's framing: *"Camera motion control without focus is less than ideal."*

That is exactly right, and it is sharper than it sounds. Multiplicity's whole
promise is that pass A and pass B are the same move. The rig delivers that — the
NMX runs the program off its own clock (ADR-0005). The focus puller cannot. A
human pulling focus by hand reproduces a mark to maybe a tenth of a turn on a
good take, which at T2 on a 35 mm lens is visible. So the one place the illusion
breaks is the lens, and it breaks in exactly the way that composite work makes
obvious: the subject breathes in and out of focus differently on each layer.

Focus is the urgent one. Iris and zoom are the same problem in cheaper clothes —
an exposure ramp or a zoom that has to match between passes has no more chance
of being reproduced by hand.

Mid-design, the owner stated the intended hardware: **Arduino-class
microcontroller with stepper motor control boards.** That settles the question
this ADR had left open, and the driving decision below is written against it.

## Decision

### 1. Lens axes are a separate collection from the motion axes

`.graffik` v3 adds `lensAxes?: LensAxis[]` beside `axes: FilmAxis[]`. It would
have been less code to make focus "axis 4", and it would have been wrong:

- `FilmAxis.position` is **NMX motor steps** at `axis: 0|1|2`, uploaded to the
  key-frame engine, bounded by taught soft limits (ADR-0013), and converted to
  millimetres and degrees by a rig calibration (ADR-0015). None of that is true
  of a lens axis. A shared type would have carried four meanings that do not
  apply and one — normalised travel — that the motion axes do not have.
- The NMX has three motor channels and the key-frame engine addresses three
  axes. Slide, pan and tilt use all of them. A lens axis is not a thing the NMX
  can be asked to run, today or later.
- The failure modes differ. A motion axis that runs past its bound crashes a
  camera into a rail end. A lens axis that runs past its bound stalls a small
  motor against a hard stop, which is how it *calibrates itself* (see 4).

Keeping them apart also means a v0.9 build refuses a v3 file outright rather
than opening it with the focus lane silently missing. The schema version was
bumped even though the change is purely additive, precisely for that: a move
file that quietly loses a focus pull is worse than one that will not open.

### 2. A lens position is a fraction of barrel travel, 0..1 — never a distance

The truth stored in the file is **where along its travel the motor is**, as a
number between 0 and 1. Real-world units are a *translation*, supplied by a
**lens map**: a list of witness marks, each pairing a travel fraction with what
the barrel reads there.

This is not an invention. It is how the professional systems work, and the
Preston FI+Z manual describes the same two-stage model in almost these terms:
the MDR "uses a lens calibration sequence to determine the mechanical limits of
the zoom, focus, and iris rings of the lens," run whenever a motor is connected
or the unit is reset — that establishes the 0..1 span — and then Lens Mapping
records the motor position at each of six discrete focus distances plus infinity
and stores the result per lens in an on-board library. Our `LensMark[]` is that
list; our `LensMap` is that library entry.

The alternative — storing feet or metres directly — bakes one piece of glass
into the move file. Change lenses, or move to a different rig with a different
gear ratio, and every number in the file is quietly a lie. Storing travel and
mapping at the edges means the *shape* of the pull survives a lens change even
when the distances do not.

Consequences that fall out of this and are implemented as such:

- Without a map the lane still works and still repeats exactly. It displays
  percent. It never invents a distance.
- `lensValueAt` interpolates linearly **between marks** and **clamps outside**
  them. A focus scale is grossly non-linear, so a linear fit across the whole
  barrel would be wrong everywhere; between two adjacent marks a few degrees
  apart it is right enough for the job. Extrapolating past the outermost mark
  would be inventing data, so it does not.
- End-of-travel labels on the timeline prefer the **engraving** the AC wrote
  (`∞`) over the map's number (`60.0m`), because the number claims a precision
  the barrel never had.
- Iris maps descend as often as they ascend (T2.1 wide open at one stop end), so
  `lensPositionFor` handles a descending mark list rather than assuming order.

### 3. Lens keys use the same solver as everything else

`sampleLensAxis` calls `computeVelocities`/`splineAt` — the identical core
functions that drive the motion preview and the firmware upload (ADR-0009), then
clamps the result to 0..1. There is no second easing implementation anywhere in
this project, and a focus pull with a different acceleration character from the
dolly move it accompanies would be a bug you could see.

Lens keys retime with the move when the duration or the timebase changes
(ADR-0014). A focus pull is timed to the move, not to the wall clock.

### 4. Lens axes are driven by a device that owns its own clock — not by the host

This is ADR-0005 and ADR-0016 arriving for the third time. Streaming lens
positions from the host at 24 Hz would inherit the same ±20 ms of
non-reproducible jitter that made Tier 1 unfit for cues, and focus is *more*
sensitive to it than a cue light: a half-frame timing error in a fast pull is a
visibly different amount of blur on that frame.

So the lens curve is **uploaded before the pass and executed on the device**,
started by the same single `GO` that starts the cue list. The owner's stated
hardware — an Arduino-class board with stepper driver boards — is the right
shape for that, and it is the same board that already runs GRAFFIK-TRIG. Lens
axes therefore extend that firmware to **protocol v2** rather than adding a
second device:

```
  -> HELLO                          <- GRAFFIK-TRIG 2 <name> <outs> <ins> <lens>
  -> LAXIS <n> <kind> <steps> <invert>    declare a lens axis and its travel
  -> LCAL <n>                       <- LCAL <n> <steps>   calibrate to the stops
  -> LCLEAR
  -> LKEY <n> <ms> <pos0..65535>          one point of the sampled curve
  -> LSEEK <n> <pos0..65535>              park before the pass / manual jog
  -> ARM                            <- READY <cues> <lensPoints>
  -> GO                             <- STARTED <deviceMs>
  -> ABORT                                stops motion, holds position
```

Design notes carried into the firmware:

- **The host uploads samples, not keys.** The spline lives in the core, is
  tested there, and is shared with the preview (ADR-0009). Re-implementing it
  in an Arduino sketch would create the second solver this project has spent
  three ADRs avoiding. The device interpolates linearly between uploaded points
  at whatever rate its stepper loop runs, and the host chooses the sample
  density; at 24 fps over a 30 s move that is 720 points per axis, which fits
  comfortably in the RAM of an ATmega328-class board at 4 bytes each.
- **Calibrate to the mechanical stops on connect**, exactly as the MDR does.
  Steppers are open-loop: absolute position only means something relative to a
  known stop, and the stops are the only reference a lens barrel offers. A
  TMC2209 is the recommended driver specifically because StallGuard4 detects
  the stop without a switch, and StealthChop keeps the motor quiet enough to
  live next to a microphone — an A4988 is audible on a set and has no stall
  detection. Recalibrate on every power-up and after any lens change.
- **0.8 module** is the gear standard for cine focus/iris/zoom rings; drive the
  ring through an 0.8 MOD pinion. Pick the reduction so the motor's full travel
  slightly exceeds the barrel's, then let calibration find the real limits.
- **`ABORT` stops lens motion but holds position.** It must never home, and it
  must never release — an aborted pass leaves a rig with a heavy lens on it, and
  a focus ring that free-wheels on e-stop is a way to lose a lens.

Until that firmware exists, a lens lane is authored, saved, displayed and
exported, and **is not driven**. The app says so rather than implying otherwise.

### 5. 3D export carries the lens, and omits it honestly when unmapped

`sampleLens` produces per-frame tracks; the USD camera prim gets animated
`focusDistance` (converted by the stage's `metersPerUnit`), `focalLength` and
`fStop`. An **unmapped** axis is not exported at all — a travel fraction is not
a focal length, and writing `0.62` into `focalLength` would produce a file that
looks valid and is nonsense. Instead the exported document carries an explicit
`NOT EXPORTED: iris — the lens has no marks` note. CSV, being the format people
open to check things, carries **both** columns: travel fraction and mapped value.

### 6. The lens lanes reuse the validated three-colour palette

Six categorical slots **failed** all-pairs CVD validation (magenta↔aqua ΔE 1.6
deutan; yellow↔orange ΔE 10.6 normal vision), so per ADR-0012 the answer is
faceting, not a wider palette. Focus/iris/zoom reuse slots 1–3 inside a
separately banded and labelled group. Identity comes from the group band and the
per-lane direct label, never from colour alone — which is the rule anyway.

Lens lanes are drawn on a **fixed** 0..1 scale, unlike the auto-scaled motion
tracks, so the shape of a pull is comparable between takes and between lanes.
Because that scale is fixed and load-bearing, both ends are labelled.

## Consequences

- A focus pull is now part of the move file, versioned with it, retimed with it,
  exported with it, and undo-able like any other keyframe.
- Lens maps are stored **in the move**, not yet in a reusable per-lens library.
  Preston stores 150. We should too; that is a later slice and a schema addition
  rather than a change.
- Nothing drives a lens motor yet. The gap between "the app has a focus lane"
  and "the rig pulls focus" is one firmware slice and a board, and this ADR is
  the specification for it.
- Adding lens lanes consumes half the timeline stage when all three are present.
  Six tracks at 1440×880 was verified by headless render; a seventh lane would
  need scrolling tracks, which is a real design change and not a small one.
- **Unverified against hardware.** No lens motor has been connected. The travel
  model, the stall-based calibration, the sample density and the ABORT-holds
  behaviour are all reasoned, not measured.

## Alternatives considered

**Make focus a fourth NMX axis.** The NMX cannot run it — three motor channels,
three used. Dead on arrival.

**Store distances in feet/metres directly.** Simpler UI, and wrong the moment
anybody changes glass or gearing. Rejected: it makes the file describe one lens
on one day.

**Stream lens positions from the host during the pass.** Simplest to build,
needs no firmware — and reintroduces exactly the jitter ADR-0016 was written to
eliminate, on the axis least able to tolerate it. Rejected on the same grounds,
and the owner's Arduino direction makes the better option available anyway.

**Servo instead of stepper.** Hobby servos have no useful resolution over a
270° barrel and hunt audibly. Steppers with an 0.8 MOD pinion and microstepping
are what the commercial units use. Rejected.

**Interpolate the spline on the device.** Would cut the upload to a handful of
keys, and would put a second motion solver in the project. Rejected — ADR-0009
is worth more than the bytes.
