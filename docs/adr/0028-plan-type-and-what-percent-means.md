# ADR-0028: Plan type is CONT_VID, because it decides what "percent complete" is divided by

**Status:** Accepted (v0.22) — unverified against hardware
**Date:** 2026-08-19
**Deciders:** Project owner + Claude

## Context

Found while checking an assumption in the module shipped an hour earlier.

ADR-0027 made the controller's reported **percent complete** load-bearing: it is
the join key between two recorded passes, and the anchor for the playhead
(ADR-0025). Before trusting `deviationFromPlan`'s mapping of percent onto a
frame, I went to the dispatch to confirm percent is linear in *time* rather than
in *distance*. It is:

```
programPercent()      = (run_time - start_delay) / longest_move        // any non-SMS plan
kf_getPercentDone()   = kf_run_time / (denominator)
```

The denominator is where it went wrong:

```
if (Motors::planType() == CONT_VID) kf_run_time / (kf_getMaxMoveTime()  + start_delay)
else                                kf_run_time / (kf_getMaxCamTime()   + start_delay)

kf_getMaxCamTime() = kf_getMaxMoveTime() + Camera.focusTime() + Camera.triggerTime()
```

And `Motion_Engine.ino` defines **three** plan types, not two:

```
#define SMS       0
#define CONT_TL   1
#define CONT_VID  2
```

Graffik NG's command vocabulary described command 22 as *"program move mode:
0 = SMS, 1 = continuous"* and typed it `(mode: 0 | 1)` — which made `CONT_VID`
literally unrepresentable. The classic arm path sent **1 (CONT_TL)**, and the
key-frame path **never set a plan type at all**, so a key-frame pass ran under
whatever was last latched: our own classic arm, the stock app, or whatever the
device booted with.

## Consequences of the wrong value

- **Percent complete is scaled down by the camera's focus and trigger time.**
  With the app's default 120 ms shutter on a 10 s move that is ~1%; with a 2 s
  exposure it is ~17%. The playhead would stop short of the end of the lane
  while the rig finished, and every `vs plan` comparison would compare the rig
  at time *t* against the plan at a different time — silently, with
  plausible-looking numbers.
- **The classic engine does not fire the shutter at the end of the pass.** In
  `CONT_VID` the firmware calls `Camera.expose()` once when a non-ping-pong
  program stops (`OM_ControlCycle.ino`), which is the start/stop-record
  semantic a video shoot expects. In `CONT_TL` it does not.
- The official iOS app sends `NMXProgramModeVideo` for a video move
  (`SetupViewController.m`). Graffik NG shoots video moves. It was sending
  time-lapse.

## Decision

1. **`PLAN_TYPE = { sms: 0, contTimelapse: 1, contVideo: 2 }`** in the command
   vocabulary, sourced from the firmware defines, with `setProgramMode` typed to
   it. General **query 118** reads the latched plan type back.
2. **Both engines set `contVideo` explicitly** — the classic arm, and every
   key-frame upload. Never inherit a mode somebody else set.
3. **The value is read back off the device after an upload, not assumed.** One
   query. A mismatch is written to the pass log in the words that matter
   ("percent complete and every recorded comparison will be skewed"), and the
   bring-up report prints the latched plan type by name, or says **not read
   back** when no upload has checked it.

## Why read-back rather than trusting the write

Because the failure this guards against is not a dropped packet — it is
*something else having set it*. A write that succeeds tells you nothing about
what a later actor did. The whole reason this bug existed is that the key-frame
path assumed a mode it never set; assuming a mode it did set is the same
mistake with one more step.

## What this does not change

Classic `programPercent()` divides by `longest_move` for every non-SMS plan, so
2-point percent was already unaffected by the CONT_TL/CONT_VID distinction. Only
the key-frame engine's percent was skewed — which is the engine ADR-0006 favours
and the one the recorder is aimed at.

## What would make this wrong

If a real NMX turns out to answer query 118 with something other than the value
written — or if `CONT_VID` changes camera behaviour in a way that surprises a
shoot (it fires the shutter once at the end of a classic pass, which is intended
but has never been seen on a real camera) — this gets superseded rather than
quietly reinterpreted. Both are on the Phase 1 checklist.
