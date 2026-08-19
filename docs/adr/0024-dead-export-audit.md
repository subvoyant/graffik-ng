# ADR-0024: A dead-export audit — because "tested" is not "reachable"

**Status:** Accepted (v0.17)
**Date:** 2026-08-19
**Deciders:** Project owner + Claude

## Context

Seven versions shipped in one working session, none of it verified against
hardware. Before adding more surface, the question worth asking is whether what
already exists holds together.

The specific failure this targets happened here, once, and was caught by luck:
`degreesFromLaser` and `laserAngleWarning` shipped in v0.13 with passing tests
and **no way to reach them from the app**. They were noticed during a render
review, by accident. A function that is exported, tested, and callable by
nothing is worse than one with no tests at all — it *claims* coverage, so it
removes the pressure to check.

## Decision

### 1. Reachability is a fixpoint over symbol bodies, not a name search

```
seed    = core symbols named anywhere in the app, preload or CLI
expand  = if a reachable symbol's BODY names another core symbol, that one
          is reachable too
repeat  until nothing changes
```

Per-**symbol** rather than per-**file**, deliberately: `degreesFromLaser` lives
in `commission.ts` beside `fitCalibration`, which the app does use, so a
file-level rule would have missed the exact bug it was written for.

**Private helpers are in the graph but never reported.** A symbol used only by a
module-private function is genuinely reachable — walking only exported bodies
made `SubAddress` look dead because it is used by `commands.ts`'s private packet
builders.

### 2. Type-only exports are excluded

`interface` and `type` exports are consumed by the type system, and the app is
plain JavaScript that never names them. "Unreferenced" is the correct state for
those, and flagging 90 of them is how a check gets ignored — or worse, how
somebody "fixes" real code to silence it.

### 3. The two findings are reported separately

- **Unreferenced by anything** — ordinary dead code.
- **Tested but unreachable** — the dangerous one, and the reason this exists.

`--strict` fails CI on either.

### 4. It is a text scan, not a TypeScript program

It has to run in CI with no additional dependency, and a name that appears in no
consumer's source text is not used by that consumer whatever the compiler
believes. The cost is that a symbol reached purely through a computed string
would be a false positive; there are none today, and one would be a reason to
question the indirection.

## What the first run found

Eleven live findings out of 142 exported values. One of them was a *pattern*
rather than an oversight:

**The renderer had reimplemented four lens helpers** — `formatLensValue`,
`newLensAxis`, `lensEntryToMap`, `lensMapToEntry` — because nothing bridged the
originals. That is precisely the duplication ADR-0014 created the timecode
bridge to prevent, arrived at by the identical route: a tested pure function in
the core with no path to the UI, and a UI that needs the behaviour anyway. Now
bridged as `window.lens`, and the copies are gone.

Five were genuinely dead and were deleted: `controlAction`, `withinLimit`,
`clampToLimit`, `filmTimecode`, and **`eventsInWindow`** — the last of which
matters, because the nmx-protocol digest still described it as the Tier-1 host
dispatch mechanism. `CueScheduler` replaced it before v0.8 shipped and nothing
noticed. **A stale digest is a bug, and this is the first thing that found one.**

`lensPositionFor` was kept and wired through the bridge rather than deleted: the
inverse mark lookup is what "drive the lens to a marked distance" needs, and the
descending-scale handling in it is subtle enough to be worth keeping tested.

Also fixed: the parser read `export const enum X` as an export named `enum`.

## Consequences

- Dead code cannot accumulate silently, and the specific "tested but
  unreachable" trap now fails CI rather than waiting for a lucky review.
- The audit is a **doc-freshness check by side effect** — deleting a function
  the digest describes as live forces the digest to be corrected.
- Removing exports from the core is a breaking change for consumers. There are
  none outside this repo, and pretending otherwise would be how the surface
  grows forever.

## Alternatives considered

**`ts-prune` or `knip`.** Better tools, and a new dependency in a project whose
core is deliberately dependency-free, plus neither distinguishes
tested-but-unreachable from unreferenced — which is the distinction that
matters here.

**Trust code review.** Seven versions of evidence that it does not catch this:
every one of these eleven passed review, twice.

**Delete everything flagged.** Faster, and it would have thrown away
`lensPositionFor` and papered over the duplication finding by deleting the
originals instead of the copies. The audit is a prompt to look, not a verdict.
