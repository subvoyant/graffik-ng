# ADR-0027: Record what the rig actually did, and compare passes at matched percent

**Status:** Accepted (v0.21) — unverified against hardware
**Date:** 2026-08-19
**Deciders:** Project owner + Claude

## Context

Twenty versions in, every single thing this software knows is about the move it
*sent*. Nothing in it has ever known what came back.

That is a strange gap for a project whose entire purpose is multiplicity — five
passes of the same move, composited, where the whole illusion collapses if pass
two is not where pass one was. `docs/HARDWARE-BRINGUP.md` answers that question
with a tape measure at the end of the move, five times. That is a good test and
it stays. It measures the **endpoint** and nothing between the endpoints, which
is where a lost step, a slipped belt or a stall would actually happen.

Hardware arrives in days. A first session that produces "it felt right" is a
session that has to be repeated.

## Three facts from the firmware, which is why this is possible at all

Read out of the 2018 dispatch (ADR-0004), not assumed:

1. **Stepping runs off Timer1, not the main loop.** `OM_MotorMaster.ino`
   `startISR()` → `Timer1.attachInterrupt(_runISR)`. A serial query answered
   mid-move costs loop time, not steps. On a firmware that bit-banged its steps
   in the main loop this whole feature would be unsafe, and the honest answer
   would have been "do not sample during a pass."
2. **Motor query 106 is rescaled during a "send to".** The handler reads
   `curPos = thisMotor.isSending() ? (thisMotor.lastMs()/thisMotor.ms()) * curPos : curPos`,
   because a send silently forces quarter-stepping and restores the previous
   microstep afterwards (`Motion_Engine.ino` clears the flag and calls
   `restoreLastMs()` once the motor stops). The value's **unit** changes
   underneath you, with nothing in the reply to say so.
3. **A key-frame move does not set that flag.** `sendTo(motor, pos, kf_move)`
   only calls `setSending(true)` when `!kf_move`. So the phase that lies is the
   pre-pass goto-to-first-keyframe, not the pass — and **motor query 124**
   answers "am I sending?" directly, so the host can tell.

Fact 2 is the one that would have produced a beautiful, wrong dataset. A
position read that is silently ×4 or ÷4 depending on invisible state is exactly
the "unit slip" trap ADR-0015 and ADR-0020 already name in another form.

## Decision

**Every pass is recorded while it runs, and passes are compared at matched
controller percent.**

- **One poll, both jobs.** The renderer already polled every 500 ms to move the
  progress bar and anchor the playhead. That same call now also collects
  position, and the sample it keeps *is* the reading the UI is driven from. A
  second timer would have meant two clocks disagreeing about when the pass was —
  the bug ADR-0025 already had to fix once.
- **Percent is the join key, never host time.** Two takes started three seconds
  apart are still the same move at 40%. Same principle as the playhead: the
  controller's clock is the truth, the host only smooths (ADR-0005, ADR-0025).
- **A sample taken while any motor reports `isSending` is marked suspect and set
  aside**, never silently mixed in. Conservative on purpose: one motor being
  repositioned means the sample is from a phase we are not measuring.
- **Nothing is invented to fill a hole.** Interpolation refuses across a gap
  wider than 10% of the move; outside the recorded span the answer is `null`,
  not an extrapolation. A comparison with too little overlap or too few points
  is **refused with the reason**, in the same idiom as ADR-0020's refusal to
  name a culprit from two observations.
- **The recorder never aborts the take.** Every position read is individually
  guarded; a query that times out records `null` for that axis and the pass
  carries on. A recorder that can kill the thing it is recording is worse than
  no recorder.
- **Recording survives a stop.** `STOP ALL`, the physical e-stop and a manual
  stop all *close* the recording rather than discard it. A pass that was stopped
  is precisely the pass somebody wants to look at afterwards.

## The resolution floor, stated rather than hidden

The firmware reports progress in **whole percent**. A comparison at matched
percent therefore cannot resolve motion finer than one percent of the path — on
an axis travelling 4000 steps, that is a 40-step floor no amount of averaging
removes.

So every comparison computes that floor from the data (worst steps-per-percent
over the compared span) and reports a result at or under it as a **bound**:

> *Pan: within ±40 steps — at or below what a whole-percent comparison can
> resolve, so this is a bound, not a measurement*

This matters because the number will be quoted later. "The rig repeats to 4
steps" and "the rig repeats to at least 40 steps, and we cannot see finer" are
different claims, and only one of them is true.

**This does not replace the tape.** The five-pass endpoint check measures the
endpoint far better than this does; this measures everything in between, which
the tape cannot. Both are in the bring-up report, unmerged.

## Consequences

- New core module `trace.ts`; nothing in it reads a clock or does I/O — the
  caller supplies timestamps, and `deviationFromPlan` takes an injected sampler
  so the module never imports the solver (ADR-0009 keeps one owner for motion
  math).
- New motor query **124** in the command vocabulary, sourced from the dispatch.
- Recorded passes are drawn on the lanes in **the axis's own hue**, dashed and
  thinner. Identity belongs to the series (ADR-0012); provenance is carried by
  style. A recorded Slide in a fifth colour would read as a fifth thing.
- **Recorded passes are included in each lane's y-scale.** A deviation big
  enough to leave the lane is the most important thing the overlay could show,
  and a scale computed from the plan alone would draw it outside the box and
  lose it — the same defect as v0.6's invisible taught limits.
- The bring-up report carries per-pass coverage and an automatic pass-to-pass
  comparison of the last two complete passes per engine. This is the number that
  ratifies or refutes ADR-0006.
- **The sampling cost is measured, not assumed.** Each sample records its own
  wall-clock cost, so the rig — not an estimate — decides whether 500 ms can be
  tightened. Eight queries per sample at 19200 baud is the thing to watch.
- Twenty recordings are kept in memory; older ones are dropped and **the drop is
  reported**, never silent. They are not written to preferences: a session's
  worth of samples is not configuration.
- `prefs.trace = { enabled, checkSending }` exists so the whole thing can be
  switched off at the rig if it turns out to perturb a move — a possibility that
  cannot be ruled out from here.

## What would make this wrong

If the NMX turns out to answer position queries slowly enough that eight of them
do not fit inside the poll interval, the poll backs up and the progress bar
starts lagging the rig. The measured `costMs` is there to catch exactly that on
the first session; the fix would be to sample position on every second poll, or
to drop query 124 once the rig has shown it is always false during a run.
