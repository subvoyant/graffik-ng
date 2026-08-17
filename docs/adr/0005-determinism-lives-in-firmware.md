# ADR-0005: Determinism lives in the firmware; the host is an orchestrator

**Status:** Accepted
**Date:** 2026-08-15
**Deciders:** Claude (recon finding), foundational to ADR-0002

## Context

Multiplicity shots demand frame-identical repetition of a camera move across passes. The naive design streams motion commands from the host in real time, making host timing (GC, scheduler, USB latency) part of the repeatability budget. Recon showed the NMX firmware executes **stored programs on-device**: the classic program engine (per-motor start/stop points, travel time, accel/decel, easing) and the key-frame engine (sub-address 5, cubic Hermite spline over uploaded keyframe arrays).

## Decision

The host **uploads** a move once and triggers it; it never streams motion in real time. Repeatability = same stored program + steppers + same start position. Host responsibilities are: configuration, jog (low-rate speed commands with the firmware-side watchdog armed), program upload, run/pause/stop, progress polling, and safety (e-stop broadcasts).

## Consequences

- Host-side language/runtime jitter is irrelevant to move fidelity — this is what makes ADR-0002 (Electron) safe.
- Pass N and pass N+1 are identical by construction; the pass manager is just "send all to start → run" in a loop.
- Limitation accepted: moves are limited to what the firmware engines express (2-point eased moves; N-point Hermite splines). A future "arbitrary curve" feature must compile down to keyframes, not streaming.
- Progress UI is polled (query cmds), not event-driven — the firmware pushes nothing.
