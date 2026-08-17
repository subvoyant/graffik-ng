# ADR-0014: Frames are the authoring unit; SMPTE timecode is the display

**Status:** Accepted
**Date:** 2026-08-17
**Deciders:** Project owner + Claude

## Context

Every time value in the app was a millisecond: move duration, keyframe times,
cue countdown, the ruler, the inspector. Milliseconds are what the NMX firmware
wants on the wire, so the unit propagated outward from the protocol until it
reached the operator — who does not think in milliseconds. A cinematographer
thinks *"the move is 240 frames"* and *"the reveal lands at 01:00:15:12"*, and
everyone else on the production — editorial, VFX, the DIT — speaks timecode too.

There was also a correctness problem hiding behind the convenience. A move
authored as "10 seconds" runs 10.000 s. At 23.976 fps, 240 frames is 10.010 s.
Nothing in the app knew the difference, because nothing in the app knew what
rate the shoot was on.

## Decision

**Frames are the unit of authorship. Milliseconds exist only at the protocol
boundary.**

- `.graffik` v2 stores `timebase` (an exact rational + drop-frame flag),
  `durationFrames`, `cueFrames`, `startFrame`, and per-keyframe `frame`.
  Keyframe times are integers: a keyframe belongs to a frame, not to a
  millisecond that happens to fall near one.
- Frame rates are **exact rationals**, never decimals. 23.976 is `24000/1001`.
  The rounded decimal drifts ~3.6 ms per 1000 frames — a frame every seven
  minutes, which between two passes of a multiplicity composite is a visible
  misregistration.
- Conversion happens in exactly two functions, `filmAxesToMs` and
  `filmDurationMs`, called from the IPC handlers that talk to the controller.
  Nothing upstream of them holds a millisecond.
- The timecode implementation lives in the core with unit tests and is bridged
  **synchronously** into the renderer by preload. The renderer redraws on every
  pointer move, so an IPC round-trip per label is absurd; a second copy of the
  arithmetic in the renderer is worse, because drop-frame drifts quietly.
- Changing the timebase **retimes** the move: frame numbers are recomputed so
  the rig does exactly what it did before, over the same real seconds.

Drop-frame is supported and is **only legal at 29.97 and 59.94**, enforced by
`validateTimebase`. It is a counting convention, not a change to the pictures:
it renumbers so the label tracks the wall clock. At 23.976 the same correction
works out to 14.4 frames per 10 minutes, which is not a whole number of frames,
which is why no drop-frame standard exists for it — offering the option would
be offering a bug.

Typing a timecode that drop-frame skips (`00:01:00;00`) is rejected rather than
silently rounded. Those timecodes do not exist, and accepting one hides a typo
inside a move that later fails to line up.

## Options Considered

**A. Keep milliseconds internally, format frames for display.** Least code.
Rejected: rounding then happens at display time, so the number the operator sees
is not the number the file holds. Nudge a keyframe by one frame twice and it
lands somewhere between frames. The unit an operator manipulates must be the
unit that is stored.

**B. Store seconds as floats plus a rate.** Same failure with extra steps.

**C. Frames as canonical, ms at the boundary (chosen).** The file is
frame-exact and diffable, the UI needs no rounding, and the ms rounding that
does happen (≤0.5 ms, against a 20–42 ms frame) lands once per keyframe on an
absolute abscissa, so it cannot accumulate.

## Consequences

- `.graffik` v1 files still load. v1 carried no timebase, so **24 fps is
  assumed** and the migration records that assumption in the file's `notes`
  rather than hiding it; real-time duration is preserved exactly, and changing
  the timebase afterwards re-derives the frame numbers.
- The IPC surface passes whole films rather than loose `(axes, durationMs)`
  arguments, so the two processes cannot disagree about units.
- Timeline drag, arrow-key nudge, and capture all snap to whole frames, and
  keyframes can never be closer than one frame apart.
- `startFrame` gives a move a start timecode, so a pass can be handed to
  editorial or a 3D package without anyone recalculating offsets by hand. This
  is what makes ADR-0015's export line up with the plate.
- Ruler ticks are built from the shooting rate, so they land on whole seconds;
  they print `MM:SS:FF` because the hour never changes across a camera move.
- The preload bridge means the app now hard-depends on the core being **built**
  (`dist/`), not merely present. A stale `dist` is now a startup failure rather
  than a subtle wrong answer, which is the right trade.
