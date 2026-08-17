# ADR-0016: Timeline events, and where they are scheduled

**Status:** Accepted (schema + scheduler landed; backends staged)
**Date:** 2026-08-17
**Deciders:** Project owner + Claude

## Context

The rig moves the camera. A shot needs more than that to happen at the right
moment: a cue light flashing the start mark so a performer hits the same
position on every pass, a focus motor pulling on cue, animatronics firing, a
practical dimming through DMX, a MIDI note starting playback. All of it has to
land at a specific *frame*, and — for multiplicity — at the *same* frame on
every pass.

The owner asked for a general-purpose trigger interface, driven by Arduino-class
microcontrollers or common USB devices, with the events scheduled on the
timeline.

## Decision

### 1. Events live in the move, on the frame grid

`.graffik` v2 carries an `events` array alongside the axes. An event has a
`frame`, an optional `durationFrames`, a logical `target`, and an `action`
(`pulse` / `level` / `midi` / `dmx` / `osc` / `camera`). Events are frame
numbers for the same reason keyframes are (ADR-0014): "flash the cue light at
02:14" is a statement about a frame, and it must survive a timebase change by
being retimed with everything else.

Targets are **logical names**, not ports — `"cue-light"`, not `"/dev/tty.usb…
channel 2"`. The binding from name to physical output lives in preferences with
the rest of the rig configuration, so a move file stays portable between rigs
and does not embed one machine's USB enumeration.

### 2. Two scheduling tiers, and the difference is stated plainly

This is the decision that matters, and it is ADR-0005 applied again: *whatever
must be identical between passes cannot be timed by the host.*

**Tier 1 — host-scheduled.** The Electron main process fires the event during
the pass, against the pass clock. Jitter is roughly ±20 ms, and it is *not*
repeatable — JS timers, GC and USB scheduling do not do the same thing twice.
At 24 fps that is half a frame of slop. Perfectly adequate for a cue light, a
room light, a "roll camera" signal, anything a human is reacting to. Requires no
extra hardware: the NMX's own shutter output, DMX, MIDI and OSC all work this
way today.

**Tier 2 — device-scheduled.** The whole cue list is uploaded to the
microcontroller *before* the pass; the device runs it from its own clock and the
host sends exactly one `GO`. Repeatability between passes is then set by the
device's crystal, not by the host — sub-millisecond. Any event that must match
frame-to-frame across passes (focus pulls, animatronics, anything the audience
will see A/B'd in a composite) belongs here.

The UI must show which tier an event is on. An operator who thinks a host-timed
focus pull is frame-accurate will not discover otherwise until the composite,
which is the most expensive possible moment.

### 3. GPI is bidirectional

"GPI" is taken literally: the device reports **input** edges as well as driving
outputs. The obvious use is starting the pass from the camera's run signal or a
foot switch rather than from a mouse click — the pass then begins at the same
point in the camera's own frame cadence every time, which is exactly the problem
multiplicity has. Inputs are reported with the device's timestamp, not the
host's arrival time, so a Tier-2 device can also tell us *how late* the host was.

### 4. Backends behind one seam, like `PortLike`

A `TriggerBackend` interface (`describe` / `supports` / `arm` / `fire` / `start`
/ `stop`) mirrors the `PortLike` seam that already lets the protocol core be
tested against a simulator. A simulated backend records what would have fired,
so the event system is testable with no hardware at all — the same trick that
got the motion path this far.

Backend survey, ordered by what it costs us:

| Backend | Transport | New dependency? | Tier |
|---|---|---|---|
| NMX camera | existing sub-address 4 | none | 1 |
| Arduino-class board | USB CDC serial, text protocol below | none (`serialport`) | 1 **and 2** |
| DMX (Enttec DMX USB Pro) | FTDI serial, documented `0x7E`-framed packets | none (`serialport`) | 1 |
| OSC | UDP | none (`node:dgram`) | 1 |
| MIDI | — | **yes** — a native module | 1 |

Three of the five need nothing we do not already ship. MIDI is the odd one out:
every Node MIDI binding is native, and Web MIDI would put hardware I/O in the
renderer, which ADR-0007 forbids. MIDI therefore waits until there is a real
need, and arrives as an optional dependency rather than a core one.

### 5. The device protocol is plain text and versioned

```
→ HELLO                      ← GRAFFIK-TRIG 1 <name> <outs> <ins>
→ CLEAR
→ CUE <id> <ms> <out> <action…>      e.g.  CUE 3 4500 2 PULSE 40
→ ARM                        ← READY <count>
→ GO                         ← STARTED <deviceMs>
→ ABORT
                             ← IN <n> <RISE|FALL> <deviceMs>
                             ← FIRED <id> <deviceMs>
                             ← DONE <deviceMs>
```

Text, line-oriented, one command per line. Anyone can implement it on any board
in an afternoon, debug it in a serial monitor, and — the real reason — we can
read a session transcript when a cue fires late on set at 2 a.m. A binary
protocol would save bytes we do not need to save. Cue times are milliseconds
because that is what a microcontroller counts; the host converts from frames at
the boundary, exactly as it does for the NMX (ADR-0014).

## Options Considered

**A. Host-times everything.** Simplest, works today, no firmware to write.
Rejected as the *only* mechanism because it cannot deliver pass-to-pass
repeatability, which is the entire point of the product. Kept as Tier 1, where
its limits are acceptable and stated.

**B. Drive everything from the NMX's camera output.** One output, one action,
already implemented. Too narrow: it cannot address a DMX universe or fire four
things at different frames.

**C. Two tiers behind one interface (chosen).** The operator schedules on the
timeline once; where it gets timed is a property of the target's binding, shown
in the UI. Costs an abstraction, buys honesty about which events are frame-exact.

## Consequences

- The film schema grows an `events` array now, so files written from this point
  carry cues even though the backends land incrementally. A move saved today
  will not silently lose its cue list to a later version.
- Events retime with the move when the timebase changes, and are validated
  against the move's duration like keyframes.
- Tier 2 requires firmware we have not written and a board we do not have. The
  protocol above is the contract that firmware will be written against; until a
  device answers `HELLO`, only Tier 1 exists and the UI must say so.
- A simulated backend is required before any real one, so cue lists are
  verifiable without hardware — same discipline as `SimulatedNmx`.
- Safety: an armed cue list is state on a device the e-stop does not currently
  reach. `ABORT` must be wired into `stopAll()` before any Tier-2 output drives
  anything that moves.
