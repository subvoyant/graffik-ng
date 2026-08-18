# Graffik NG — agent entry point

You are working on Graffik NG: TypeScript/Electron software driving a Dynamic Perception NMX 3-axis motion controller for repeatable multi-pass camera moves. MIT-licensed, implemented fresh from the official protocol spec.

**Read order (do not skip):**
1. `docs/digests/HUB.md` — system map, load-bearing invariants, current state. Read it before touching anything.
2. Only the digest(s) in `docs/digests/` for the module(s) you're changing.
3. Source files only where you're editing. The digests exist so you don't re-read the codebase.

**Rules:**
- Decisions live in `docs/adr/` (index: `docs/adr/README.md`). Don't contradict an Accepted ADR silently — write a superseding one.
- `docs/DECISIONS.md` is the running session-by-session log (what broke, what was learned) — ADRs are the canonical *why*; that file is the narrative around them. Append to it at the end of every working session.
- If you change a module's behavior, API, or invariants: update its digest + the hub **in the same change**, and refresh its "Verified against" stamp. A stale digest is a bug.
- Update "Current state & next steps" in the hub at the end of every working session.
- Never paste or port GPL code from the reference repos (ADR-0003). Facts only.
- Protocol command numbers come only from the firmware dispatch source (ADR-0004).
- All hardware I/O stays in the Electron main process (ADR-0007). Safety invariants (watchdog, e-stop) are in the hub — read them before any code that moves motors.
