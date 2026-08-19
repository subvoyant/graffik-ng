# ADR-0025: The playhead follows a running pass — from the firmware's clock, not the host's

**Status:** Accepted (v0.18) · amended same day, see **Amendment (v0.19)**
**Date:** 2026-08-19
**Deciders:** Project owner (observed it) + Claude

## Context

The owner, watching a pass run: *"The playhead should move across the lanes when
a run is initiated. The blue line on bottom right moves but we should also see
position in the lanes."*

Correct. Both engines polled the controller for progress and put it in a
progress bar, and the timeline — the thing an operator is actually looking at —
sat still. The single most useful readout during a pass was the one not being
drawn.

## Decision

### 1. The firmware's percent is the truth; the local clock only smooths

The device runs the move off its own crystal (ADR-0005). A host timer started at
GO would drift away from it, and a playhead drawn from that timer would
progressively lie about where the rig is — quietly, and worse the longer the
move.

So the sweep is anchored to the controller's reported percent on every 500 ms
poll, and the local clock only interpolates between readings. **Extrapolation is
capped at one poll interval**, so a controller that stalls produces a stalled
playhead rather than a confident one that has run ahead of the rig.

The direction of authority matters and is easy to get backwards: the host is
allowed to smooth what the device says, never to assert it.

### 2. A classic pass is not the timeline, and the playhead says so

The lanes show the **key-frame** move. A 2-point classic pass runs between
taught start/end marks and is a *different move entirely* — it does not follow
those curves and has its own duration.

A normal playhead sweeping across those curves would be a statement: "the rig is
here, on this curve." During a classic pass that is false. So the classic sweep
is drawn in warning amber with the tag **"2-POINT PASS · these lanes are not
running"**, and it is swept against the classic duration rather than the film's.

Sweeping it at all is still right — the ruler is a time axis, and elapsed time
is true regardless of which engine is running. What needed marking was the
implication about the lanes, not the motion.

### 3. A running playhead is brighter ink, not a hue

The first attempt used `--accent` for the running KF playhead. `--accent` is the
same blue as the **Slide** trace, so the playhead vanished into its own curve —
caught by looking at the render.

Beyond that specific collision, ADR-0012's rule already answers it: **chrome
wears ink, the palette belongs to the series.** Running is full-opacity white at
2 px against 55 % at 1 px when idle. The classic case is the one exception,
because amber is carrying a *warning* rather than a state.

### 4. Stopping freezes the playhead

`STOP ALL`, the physical e-stop button and the KF stop all end the sweep. A
playhead that keeps moving after a stop is the UI asserting motion that has been
halted — which is the one thing a stop must never leave ambiguous.

On normal completion the playhead is left at the end of the move, because that
is where the rig is. ⏮ returns both.

### 5. The view follows when zoomed in

If the playhead leaves the visible frame range mid-pass, the view pans to keep
it on screen. Standard in every editor, and the alternative is a sweep the
operator cannot see on precisely the moves long enough to be worth watching.

## Consequences

- The most useful thing on screen during a pass is now drawn.
- The classic-vs-keyframe distinction became visible in the UI for the first
  time; it had only ever been stated in a status-bar chip.
- Unverified against hardware, like everything since v0.10. The specific thing
  to watch on the bench: whether the NMX's reported percent is smooth enough at
  500 ms that the interpolation looks right, or whether the poll wants to be
  faster during a pass.

## Alternatives considered

**Drive the playhead from a host timer started at GO.** Smoother, needs no
polling, and drifts from the rig — turning the playhead into a plausible
fiction. Rejected: this is ADR-0005's rule, and the whole project exists because
device-timed and host-timed are not the same thing.

**Do not sweep during a classic pass.** Honest about the lanes, and it throws
away the true part (elapsed time) to avoid the false part (implied position).
Marking it was strictly better than hiding it.

**Interpolate with no cap.** Smoothest, and a stalled or disconnected controller
would show a playhead confidently completing a pass that never happened.


---

## Amendment (v0.19, 2026-08-19) — it was jerky, and the reasons were not the ones I would have guessed

Owner, watching it run: *"The movement of the playhead is very jerky, can it be
smooth?"* Three independent causes, none of them the drawing:

1. **`setInterval` at 40 ms.** Not display-synced, so ticks landed early or late
   against the compositor. Now `requestAnimationFrame`.
2. **`Math.round` on the frame number.** The playhead could only occupy whole
   frames, so on a zoomed-in timeline it hopped between them instead of moving.
   The drawn position is a float; only the readout rounds, and `endPassSweep`
   puts it back on the grid because the rest of the editor assumes it is there.
3. **The re-anchor was a snap.** Every 500 ms poll assigned the controller's
   percent straight to the drawn position, so any disagreement with the
   extrapolation became a visible jump twice a second — the loudest of the
   three, and the one that came from the design rather than an oversight.

Also: `syncInputs()` was being called on every tick, rewriting every field in
the rail to update two labels.

### Converge by adjusting SPEED, never by assigning position

The reading now moves a *target*; the drawn position approaches it at a bounded,
non-negative rate. `shownPct` is monotonic by construction, so the playhead
**cannot step backwards** — and that is not hypothetical. The first version of
this fix clamped with `Math.min(predicted, …)`, which yanked the playhead
backwards the instant a reading came in behind the extrapolation. Measurement
caught it; reading the code had not.

Ahead of the prediction, speed falls to zero and the playhead waits. Behind it,
speed rises (capped at 3×). **A brief pause reads as steady; a reversal reads as
broken.**

### Measured rather than asserted

A headless harness runs a 30 s six-lane move, samples the drawn position every
frame, and feeds it deliberately disagreeing controller readings:

| | before | after |
|---|---|---|
| backwards steps | 2 | **0** |
| ticks in 2.2 s | — | 132 (60 fps) |
| `render()` cost | — | 0.74 ms |
| velocity spikes > 3× median | 0 | 0 |

`render()` at 0.74 ms means 60 fps was never in question — which is worth
knowing, because "redraw less often" would have been the obvious wrong fix.
