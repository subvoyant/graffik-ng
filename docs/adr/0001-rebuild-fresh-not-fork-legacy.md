# ADR-0001: Rebuild fresh instead of forking Graffik_Legacy

**Status:** Accepted
**Date:** 2026-08-15
**Deciders:** Project owner (Jason), Claude (recon + recommendation)

## Context

The original plan was to fork `DynamicPerception/Graffik_Legacy` (~167 commits, "feature-complete") and modernize it. Phase 0 recon invalidated the plan's premises: Legacy targets **Qt 4.8.1** (not Qt 5) with the dead `qextserialport` library, and — decisively — its `OpenMoCo/MoCoBus` protocol layer has **no sub-address concept**, meaning it speaks the older one-axis-per-node nanoMoCo dialect and **cannot drive an NMX at all**. Meanwhile the "unfinished" reboot repo (`DynamicPerception/Graffik`, ~31 commits) contains a complete ~1,100-line NMX protocol implementation, and the firmware repo ships the full official command-set PDFs.

## Decision

Do not fork either repo. Rebuild as a new codebase. Use Legacy strictly as a **UX/feature reference**, the reboot repo as a **protocol reference implementation**, and the firmware source as **protocol ground truth** (see ADR-0004).

## Options Considered

### Option A: Fork Graffik_Legacy (original plan)
**Pros:** 24k lines of working features; upstream history/attribution preserved.
**Cons:** Cannot talk to our hardware; Qt4→Qt6 is a massive port; dead serial lib; all effort lands on code welded to the wrong protocol.

### Option B: Fork the reboot repo
**Pros:** Correct protocol; Qt5 + QtSerialPort.
**Cons:** Unfinished app; QML Controls 1.x dead in Qt6; still inherits a UI we'd mostly rebuild.

### Option C: New codebase, old repos as references (chosen)
**Pros:** Inherit the small valuable part (protocol knowledge, now fully documented); free platform choice (ADR-0002); free license choice (ADR-0003).
**Cons:** No running app on day one; must re-earn feature parity.

## Consequences

- The "fork & revival" framing is dead; this is a **spiritual successor** with attribution.
- Feature parity with Legacy is a backlog, not an inheritance.
- The four original repos plus `nanoMoCo_Firmware`, `NMXComs`, `NMXCommander`, `nmx-motion-ios` remain permanent reference material (see digest `reference-repos.md`).
