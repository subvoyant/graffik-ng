# ADR-0020: Commissioning — the app measures the rig, instead of asking the operator to

**Status:** Accepted (v0.13)
**Date:** 2026-08-19
**Deciders:** Project owner + Claude

## Context

ADR-0015 said it plainly and has said it for five versions: *"steps→mm/deg needs
a calibration MEASURED on the rig; without it an export is a shape, not a camera
move."* The procedure went into `HARDWARE-BRINGUP.md` Phase 6 as a document, the
export dialog grew three number fields, and nothing in between ever helped.

That gap is the whole problem. The measurement is physical and cannot be
automated — somebody has to put a rule against a rail. But everything *around*
it can be: reading the step counts, doing the arithmetic, estimating the error,
noticing that the answer is a power of two out, and remembering the result.
Leaving all of that on a clipboard is how a rig ends up with a calibration
nobody can defend, and how a factor-of-sixteen microstep error reaches a
composite.

The same applies to repeatability. Multiplicity depends entirely on pass N
matching pass 1, `HARDWARE-BRINGUP.md` Phase 3 describes how to check it with a
dial indicator, and the app has never had anywhere to put the readings.

## Decision

### 1. The unit of measurement is a **span**, not a position

An observation is `{steps, measured}` — how many steps the axis moved, and what
a rule or an inclinometer said that was.

Deliberately **not** a least-squares line through absolute positions. A line has
an intercept; an intercept absorbs backlash and measurement offset; and a fit
that quietly absorbs your errors is a fit that has stopped telling you about
them. Each span produces its own steps-per-unit, and those are averaged.

**The spread across independent spans IS the error estimate.** That number is
the one that tells an operator whether to measure again, and it is reported
peak-to-peak rather than as deviation-from-the-mean — with two measurements the
latter is exactly half the disagreement the operator can see between their own
two numbers, and a warning that says "these disagree by 5%" while printing 2.5%
teaches people to distrust it.

### 2. With two disagreeing measurements, the app does not name a culprit

Both sit exactly the same distance from their own mean. Nothing in the
arithmetic can tell you which one is wrong, so `worst` is null below three
observations and the warning asks for a third span instead of pointing at one.
Inventing a culprit would be worse than saying nothing, because it would be
believed.

### 3. Warnings are about *this* measurement, and name the usual suspects

- A short baseline is called out with the arithmetic done: "a ~0.5 mm reading
  error is 1.0% here". A fixed reading error over 50 mm is ten times the error
  it is over 500 mm, and that is worth knowing while it can still be fixed.
- The two traps from ADR-0015 are checked against the **stored** value, not
  against a textbook one: a factor of ~100 is a unit slip, a clean power of two
  is the driver's microstep jumper. Both produce a number that looks entirely
  reasonable on its own and is wrong by an order of magnitude in the export.
  "You measured 320 and the file says 160" is actionable; "that is unusual for a
  slider" is not.
- Magnitude bounds are deliberately generous. The job is to catch a decimal
  point, not to have an opinion about somebody's gearbox.

### 4. Rotation gets the laser method, because a protractor is worse

Measuring degrees well is the hard part, and a protractor taped under a tripod
is not a measuring instrument. Point a laser square at a wall a measured
distance away, mark the dot, rotate, mark again, measure between the marks:
`atan(offset / distance)`.

It assumes the first mark is square to the wall. That assumption is nearly free
at small angles and stops being free at large ones, so the UI says so above 25°
— and says the opposite below 5°, where the angle is too small to read well.

### 5. Applying only touches axes that were measured

Writing a zero over a good stored value because one axis has not been measured
yet would be the app losing work on the operator's behalf. Unmeasured axes are
skipped and named.

The renderer keeps its own copy of the export preferences and writes it back
wholesale on any field change, so applying a measurement **merges into that
copy** as well. Without that, the next keystroke in the export dialog would
quietly overwrite the numbers just measured — a bug that would have been
invisible until an export came out at the old scale.

### 6. Repeatability reports bias and scatter separately

A consistent offset every pass is backlash or belt take-up and is largely
correctable. Readings scattered either side of zero are lost steps and are not.
Collapsing them into one number would hide the distinction exactly when it
matters, so the verdict names which one it is seeing. Below five passes it
refuses to be believed at all.

### 7. The panel carries its own jog controls

The procedure is *jog to a mark, walk away with a tape, come back and type*. A
dialog that covered the rail's jog buttons would make the thing it exists for
impossible, so it has its own — and its own live position readout, because
jogging while blind to the step count is the same failure one layer down.

## Consequences

- The measurements themselves are kept, not just the conclusion. "Which
  measurement gave us 160?" is now an answerable question, and a suspect number
  can be argued with a week later.
- `HARDWARE-BRINGUP.md` Phase 6 stops being arithmetic on a clipboard and
  becomes a description of where to put the tape.
- The commissioning state lives in preferences, so it survives a restart — which
  matters, because measuring a rig is not something you finish in one sitting.
- **None of this has measured a real rig.** The arithmetic is tested; the
  procedure is not. Everything here still waits on Phase 1.

## Alternatives considered

**Leave it in the docs.** Five versions of evidence that this does not work.

**Least-squares through absolute positions.** More statistically conventional,
and the intercept silently absorbs backlash — turning a rig problem into a
slightly-worse-fitting line nobody looks at. Rejected.

**Derive the calibration from a commanded move.** Command 10 000 steps, measure
where it ended up. Identical arithmetic, and it requires the rig to move under
program control before it has ever been calibrated — which is the wrong order
for a first bring-up, when nobody yet knows whether a commanded move is safe.

**Infer it from the motor and belt specification.** Would work, right up until
someone changes a microstep jumper and does not update a config file. The whole
point is to measure the rig that exists rather than the one that was ordered.
