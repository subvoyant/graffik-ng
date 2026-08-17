# ADR-0010: Versioned `.graffik` JSON move files, schema owned by the core

**Status:** Accepted
**Date:** 2026-08-16
**Deciders:** Claude (design), per autonomous-slices mandate

## Context

Multiplicity shoots need moves saved, reloaded identically days later, and shared between machines. The schema will outlive the current app UI, and a future CLI/scripted-shoot runner needs to read the same files without Electron.

## Decision

Move files are JSON with extension `.graffik`: `{format: "graffik-ng-move", version, name, durationMs, startDelayMs, engine: "classic"|"keyframe", axes: [{axis, points: [{time, position, velocity?}]}], savedAt?, notes?}`. The schema, serializer, and validator live in the **core package** (`film.ts`), not the app; the app only opens dialogs and moves bytes. Validation is strict and error messages are human-readable (they surface directly in the UI). Files newer than the app's `FILM_VERSION` are refused with an upgrade hint; older versions will be migrated forward when v2 ever exists. Omitted `velocity` means "auto-solve" (ADR-0009's solver), so files stay minimal and benefit from future solver improvements; an explicit velocity is preserved verbatim.

## Consequences

- Round-trip fidelity is unit-tested in the core (49-test suite), independent of the UI.
- JSON is human-diffable — moves can live in git alongside a shoot's project files.
- Format changes require a version bump + migration path — never silent field drift.
