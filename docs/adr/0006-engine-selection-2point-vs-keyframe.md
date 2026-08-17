# ADR-0006: Classic program engine for 2-point moves; key-frame engine for 3+ points

**Status:** Accepted (pending hardware replay-fidelity validation)
**Date:** 2026-08-15
**Deciders:** Claude (from official-app behavior), to be ratified on hardware

## Context

The NMX has two on-board execution engines. The classic program engine (sub-addr 0 + per-motor commands) runs a start→stop move with travel time, accel/decel, and easing. The key-frame engine (sub-addr 5) interpolates a cubic Hermite spline through N uploaded keyframes. The official NMX Motion iOS app (`nmx-motion-ios`, our best usage reference) uses the KF engine **only for 3-point moves** and the classic engine (`mainStartPlannedMove`) for simple 2-point moves.

## Decision

Mirror the official app: jog-slice's 2-point record/replay uses the classic engine; multi-keyframe moves (the future timeline editor) use the KF engine via `buildKeyFrameMove()`. Interior keyframe velocities are solved host-side on the Hermite spline (endpoints 0; interior maximized to the monotonicity boundary via bisection, ×0.995 back-off) — behavior-matched to the official app, independently expressed (ADR-0003).

## Consequences

- Two code paths to maintain; both covered by simulator tests.
- Open validation item: on real hardware, compare replay fidelity of both engines across passes (marker-on-frame test). If the KF engine repeats better even for 2-point moves, revisit this ADR.
- KF uploads must end each axis with `endTransmission` (cmd 16) — the firmware finalizes start/stop points there; forgetting it is the classic silent-failure mode.
