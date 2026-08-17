# ADR-0000: Adopt ADRs + a digest knowledge system (and its operating model)

**Status:** Accepted
**Date:** 2026-08-16
**Deciders:** Project owner + Claude

## Context

This project is developed largely via AI pair-programming across many sessions. The AI's conversational context does not persist; the humans' memory of *why* fades. Research on teams that sustain this successfully converges on two complementary layers: **ADRs** (immutable records of *why* — Nygard/MADR practice) and a **living digest layer** (concise *how-it-works-now* summaries an agent or human reads instead of re-reading source — the "memory bank" pattern from agentic-coding practice). The documented root cause of failure in both: adopting the artifact without the operating model.

## Decision

Adopt both layers, in-repo, with these operating rules:

1. **ADRs** live in `docs/adr/`, numbered monotonically, never renumbered. Accepted ADRs are immutable — supersede, don't edit. `docs/adr/README.md` is the index (number/title/status).
2. **Digests** live in `docs/digests/`, one per module plus `HUB.md` as the entry point/system map. Each digest carries a freshness stamp ("Verified against `<paths>` @ `<date>`").
3. **Same-change rule:** any change that alters a module's behavior, API, or invariants updates its digest (and the hub if the system map changed) *in the same commit*. A stale digest is a bug.
4. **Read order for AI sessions:** `CLAUDE.md` → `docs/digests/HUB.md` → only the digests for modules being touched → source only where editing. Trust digests for orientation; verify against source before relying on a detail you're about to change.
5. **Code links back:** architectural seams carry `// See ADR-NNNN` comments so `grep -r "ADR-"` maps decisions to code.
6. **Cadence:** at each phase boundary (or ~monthly), sweep for drift: deprecated ADRs, undocumented recurring decisions, digests referencing deleted code.

## Consequences

- New-session spin-up cost drops from "re-read the codebase" to "read ~2 short files."
- Honest overhead: every substantive commit carries a docs delta; reviewers must enforce it.
- Known anti-patterns to watch (from published ADR practice): first-five syndrome, trivial-decision capture, advocacy writing, post-acceptance editing, decision drift, single-owner collapse.
