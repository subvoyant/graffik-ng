# Contributing to Graffik NG

## Before you touch anything

Read `CLAUDE.md` (yes, even humans) → `docs/digests/HUB.md` → the digest for the
module you're changing. Decisions live in `docs/adr/`; don't silently contradict
an Accepted ADR — write a superseding one.

## Hard rules

1. **No GPL code.** The reference repos (Graffik, Graffik_Legacy, nmx-motion-ios,
   firmware) are read for *facts* only — command numbers, sequencing, units.
   Never paste or mechanically translate their code (ADR-0003). This keeps the
   MIT license valid.
2. **Protocol facts come from the firmware dispatch source** (ADR-0004), not
   from old apps or sample files — they disagree.
3. **Same-change rule:** if your change alters a module's behavior, API, or
   invariants, update its digest in `docs/digests/` and the hub in the same PR.
   A stale digest is a bug.
4. **Motion math lives in the core once** (ADR-0009). The UI never reimplements
   it.
5. **Safety code is not optional:** e-stop paths, the joystick watchdog, the
   firmware gate, and the jog speed clamp must survive every refactor. A
   runaway slider with a cinema camera on it is expensive.

## Practicalities

- `packages/nmx-protocol`: `npm test` must be green (byte-exact protocol tests);
  `npx tsc --noEmit` must be clean. New commands need a provenance tag
  (`[S]`/`[F]`/`[R]`) and a test.
- App code is plain JS/HTML on purpose (no bundler); keep the renderer free of
  Node/serial access (ADR-0007).
- Hardware-affecting changes should be exercised against `SimulatedNmx` first.
