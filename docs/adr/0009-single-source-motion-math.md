# ADR-0009: The timeline preview and the firmware program come from the same solver

**Status:** Accepted
**Date:** 2026-08-16
**Deciders:** Claude (design), per autonomous-slices mandate

## Context

The timeline editor draws motion curves. The firmware executes motion from keyframe arrays whose interior velocities our core solves (`computeVelocities`/`splineAt`). If the UI rendered its own approximation (e.g., a generic bezier), the drawn curve and the physical move would diverge — the worst kind of lie in a motion-control tool, discovered only on set.

## Decision

The renderer never computes motion math. It calls `nmx:preview-move` (IPC), whose handler runs the **same** `computeVelocities` + `splineAt` from `@graffik-ng/nmx-protocol` that `nmx:upload-kf` uses to program the controller, returning sampled polylines. What you see is what the firmware runs, by construction. The handler is pure (no client needed), so the editor works fully disconnected.

## Options Considered

**A. Renderer-side math (duplicate or import core into renderer):** violates the ADR-0007 seam or duplicates the solver → drift risk. Rejected.
**B. IPC preview from core (chosen):** one solver, one truth; ~1 round-trip per edit (debounced 60ms) — negligible.

## Consequences

- Any future easing/curve feature must land in the core first, then both preview and upload inherit it.
- The `uploaded` flag pattern in the renderer (edits invalidate the last upload) is the complementary guard — the controller never silently runs a stale version of what's on screen.
