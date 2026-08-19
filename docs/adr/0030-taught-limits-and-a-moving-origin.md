# ADR-0030: A taught limit is a step count, and a step count is only a place if the origin holds

**Status:** Accepted (v0.24) — unverified against hardware
**Date:** 2026-08-19
**Deciders:** Project owner + Claude

## Context

Found in the coverage report ADR-0029 produced — commands the firmware answers
that we never asked. Three of them, read together, describe a hole under
ADR-0013.

Soft travel limits are the one guard between a camera package and a mechanical
end stop. They are taught by jogging the rig to each end and storing **the
motor's step count** at that point, in the app's preferences, across sessions.

A step count is not a place. It is a place *relative to the controller's
origin*. And:

- **`ee_load_curPos` defaults to `false`** in the firmware. Position is
  **not** restored across a power cycle unless somebody turned that on. Boot
  only calls `motor[i].currentPos(tempPos)` when the flag is set.
- **General query 119** answers "has the controller power-cycled since it was
  last asked?" — so the device can tell us the origin may have moved.
- **General query 131** answers whether it restores position at all.

So the failure is: the NMX is unplugged between sessions, its origin resets, the
app loads `{ min: -12000, max: 40000 }` from preferences, and enforces those
numbers against a rail they no longer describe. The guard rail silently moved
somewhere else, and the operator still believes in it.

**That is worse than having no limits.** No limits at least leaves you careful.

## The subtlety that shapes everything

`powerCycled()` is a **one-shot latch**:

```c
byte powerCycled() {
  // This function will respond true the first time it is
  // called after a power cycle and false thereafter
  static byte cycled = true;
  byte response = cycled;
  cycled = false;
  return(response);
}
```

Whoever asks first consumes it. So:

- The app must ask **exactly once per connection**, at connect, and keep the
  answer. Asking twice throws away the only chance to hear it.
- **`false` is not evidence of "no power cycle."** The stock app, an earlier
  session, or a diagnostic tool connecting first would have taken it. Nothing in
  this codebase may phrase a `false` as an all-clear, and the UI and the report
  both say so in those words.

## Decision

**Ask on connect. When the origin may have moved, stop enforcing the taught
numbers — do not delete them, and do not pretend.**

`limitTrust(origin, anyTaught)` in the core returns one of four verdicts:

| | restores position | does not |
|---|---|---|
| **power cycle reported** | `trusted` | **`void`** — not enforced |
| **none reported** | `trusted` | `fragile` — enforced, but one cable away |
| **not asked** | `unknown` | `unknown` |

When `void`:

- **The axis reads as untaught.** Not cleared — the numbers are still on screen,
  and the operator may know perfectly well they are still right. But they are
  not *acted* on, which also re-arms the ADR-0023 creep cap. That is the correct
  fallback and not a coincidence: you have just learned you know less than you
  thought about where the carriage is, which is precisely the moment ADR-0023
  exists for. A slow collision is a noise.
- **Programmed uploads are refused** with the reason. Validating a move against
  stale limits is the same lie with more steps.
- **Teaching either bound clears it**, because teaching a bound *is* the
  operator stating where the rig is against this origin — the same self-clearing
  shape as the creep cap, and for the same reason: an override you have to
  remember to turn off is one you leave on.
- **Or the operator says so explicitly**, once, on a button. On their say-so,
  not the controller's.

When `fragile`, nothing is blocked — but the app offers the actual fix: general
command 30 turns on position restore, after which a taught step limit keeps
meaning the same place.

## Why the app never writes that setting on its own

Command 30 writes the controller's EEPROM. It is somebody else's device, shared
with whatever else they use it with, and a tool that quietly changes persistent
settings on connect is a tool you stop trusting. It is a button, with the
sentence next to it.

## Consequences

- Two queries on connect, once each. Both individually guarded — a controller
  that will not answer leaves the verdict `unknown`, which blocks nothing and
  claims nothing.
- The simulator implements the latch **exactly** — first read true, every read
  after false — and defaults `restoresPosition` to false like the firmware. A
  simulator that answered true every time would make the app look correct and
  hide the whole problem (hub invariant 23).
- The rail carries **one line**; the sentence, the controller's own answers and
  both actions live in a dialog. The rail height budget is spent, and the first
  version of this notice was a five-line paragraph that pushed the pass log off
  the bottom of the window — caught by measuring, not by looking.
- The bring-up report prints the verdict **before** the limit numbers, because
  whether they mean anything is the first thing a reader needs.

## What would make this wrong

If a real NMX turns out to report `powerCycled` true on every query rather than
once, the app would void the limits on every connection and become tiresome
enough to be ignored — which is its own hazard. Phase 1 checks it: connect
twice without power-cycling, and confirm the second connection reports `no`.
