# ADR-0015: 3D camera export via OpenUSD, with .chan as the fallback — not Alembic

**Status:** Accepted (calibration values pending hardware)
**Date:** 2026-08-17
**Deciders:** Project owner + Claude

## Context

A repeatable camera move is worth more than repeatability. If the same move can
be handed to a 3D package, CG elements can be rendered *through the real
camera's path* and composited into the plate. For a multiplicity shot this is
the difference between "we shot several passes" and "we can put anything in the
frame between them."

Three questions had to be settled: which format, how the rig's motor steps
become metres and degrees, and what "scale" even means across packages that
disagree about units and which way is up.

## Decision

### Format: OpenUSD (`.usda`) primary, `.chan` fallback, no Alembic

**`.usda`** — ASCII OpenUSD is the primary target because it is the only common
format that states its own scale. `metersPerUnit` and `upAxis` are stage
metadata; every other option leaves the importer to guess, and a guessed scale
produces a camera move that is subtly the wrong size in a way nobody notices
until the composite. It is also plain text, so the core keeps its zero runtime
dependencies, and it carries `timeCodesPerSecond`, so the shooting rate travels
with the move (ADR-0014).

**`.chan`** — one line per frame, `frame tx ty tz rx ry rz vfov`. Read by Nuke,
3DEqualizer, Syntheyes, Terragen and Blender. It carries no metadata at all —
no units, no up-axis, no rotation order, not even a comment line to put them in.
That is simultaneously why it works everywhere and why it is the fallback. We
write XYZ-order Euler degrees with `rz = 0`; the importing camera must be set to
**YXZ** rotation order (Nuke defaults to ZXY and will look wrong).

**Alembic is not written.** `.abc` is the obvious VFX answer and it was the
first thing considered, but its Ogawa container has no maintained pure-JS
writer. Supporting it means a native dependency and a build toolchain in a core
package that currently has neither, in exchange for a format that any facility
can produce from our USD with `usdcat`, Houdini or Blender in one step. If a
facility ever hard-requires `.abc` on delivery, convert downstream.

### Scale: measured calibration, not a guess

The NMX reports **motor steps** and has no encoder. Nothing in the software can
know how far a step moves the carriage — that is belt pitch, pulley diameter,
gear ratio and microstepping, i.e. a property of the physical rig. So export
takes a `RigCalibration`:

| Field | Unit | How it is obtained |
|---|---|---|
| `slideStepsPerMm` | steps / mm | jog a measured distance along the rail, divide reported steps by millimetres |
| `panStepsPerDeg` | steps / degree | rotate between two marked bearings, divide steps by degrees |
| `tiltStepsPerDeg` | steps / degree | as pan, against a digital level |
| `nodalOffsetMm` | mm | tilt-axis to entrance-pupil distance, along the lens axis |
| `headHeightMm` | mm | pan axis above the rail — scene placement only |

The measurement procedure belongs to hardware bring-up
(`docs/HARDWARE-BRINGUP.md`), and until it is done every export is a *shape*,
not a camera move. The calibration is written into the USD's `doc` string so an
orphaned file can still be interpreted years later.

`nodalOffsetMm` matters more than it looks. A real head swings the camera on an
arc rather than rotating it in place; ignoring the offset is the classic reason
a perfectly tracked CG element slides against the plate on a tilt.

### Hierarchy: export the mechanism, not a flattened matrix

`Rig → Carriage (translate) → Pan (rotate) → Tilt (rotate) → Camera (nodal
offset)`. A 3D artist can then re-time or offset a single joint, and can *see*
that the pan happens at the carriage and the tilt above it. A single baked
camera transform hides the geometry that makes the parallax behave the way it
does on set.

### Sampling: one pose per frame, from the same solver

Export calls `computeVelocities`/`splineAt` — the functions that build the
packets uploaded to the controller (ADR-0009). A second interpolation written
"just for export" would give a 3D camera that agrees with the drawing but not
with the rig: the worst of the three possible outcomes. Samples land on frame
boundaries, so the renderer's frame N and the rig's frame N are the same instant
by construction.

## Consequences

- Unit and up-axis are **chosen at export**, not assumed: metres/Y-up by default
  (USD's own fallback is centimetres/Y-up; Blender, Houdini and Unreal are
  Z-up; Maya and C4D are centimetres/Y-up). Both are written into the file.
- The export is only as good as the calibration, and a wrong calibration
  produces a plausible-looking file. Bring-up must record measured values before
  any export is trusted on a job.
- Lens data is supplied by the operator, not measured — the NMX knows nothing
  about the lens. Zooms and focus pulls are not represented; a zoom during the
  move will not match. That is a limitation to state, not to paper over.
- `.chan`'s rotation-order trap is documented here and in the app, because the
  format cannot document itself.
- The rig has no roll axis, so `rz` is always 0. If a roll axis is ever added
  this decision needs revisiting rather than extending.
