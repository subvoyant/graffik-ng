# ADR-0029: The command vocabulary is checked against the firmware dispatch, in CI

**Status:** Accepted (v0.23)
**Date:** 2026-08-19
**Deciders:** Project owner + Claude

## Context

ADR-0004 has said since the first week that protocol facts come only from the
firmware dispatch source. For twenty-eight versions that was a rule people
followed and nothing verified. ADR-0028 showed what that costs: a doc comment
described a three-valued plan-type enum as two-valued, the type signature then
enforced the mistake, and the consequence — percent complete divided by the
wrong thing — was invisible and would have produced entirely plausible numbers.

That was found by chasing one value to the source. There are 119 command
builders. Chasing them all by hand is exactly the kind of work that gets done
once, thoroughly, and then goes stale the first time the firmware reference is
re-read by somebody in a hurry.

## Decision

**Extract the dispatch into a committed fact table, and check the vocabulary
against it in CI.**

- `packages/nmx-protocol/reference/nmx-dispatch.json` — for each handler
  (`serMain` / `serMotor` / `serCamera` / `serKeyFrame`, plus the broadcast enum
  from `OMMoCoDefs.h`), every `case N:` the handler reaches, the firmware's own
  one-line comment, and a payload-width hint inferred from which `Node.nto*`
  reader the case body uses.
- `scripts/audit-vocabulary.mjs` checks that every exported builder (a) builds a
  packet on the sub-address its own block claims, and (b) sends a command number
  that handler actually has. `--strict` fails CI. `--coverage` lists what the
  firmware answers that we never send.
- `--extract <path-to-clone>` regenerates the table. Everything else runs off
  the committed data, so **CI never needs the GPL checkout**.

The table is **facts, not code** — command numbers and the firmware's own
comments — which is what ADR-0003 permits and what the reference-repos digest
has always described these clones as being for.

## What it found immediately

`general.setMaxStepRate` sent general command **11**, which `serMain` does not
handle: the firmware left a block comment saying *"Max step rate setting
deprecated in version 0.70"* where the case used to be — and 0.70 is the exact
version this app gates on. The default branch does not reply at all (its
`response(false)` is commented out), so anything calling it would have stalled
the one-command-in-flight queue until timeout. Nothing called it. Removed.

Coverage, reported rather than acted on: 31/74 general, 45/63 motor, 16/26
camera, 19/34 key-frame commands are sent. Two of the gaps were worth closing
immediately because they answer a question ADR-0028 raised — see below.

## Coverage is information, not a defect

A protocol vocabulary is a description of a device. Completeness there is a
feature, and "nobody in this app calls it" is not evidence of anything. This is
why the audit **reports** coverage instead of failing on it, and why members of
these exported objects are deliberately **not** fed into the dead-export audit
(ADR-0024): that audit's premise — reachable from the product — is the wrong
question to ask of a vocabulary. Fidelity to the dispatch is the right one, and
that is what this checks.

Worth noting the blind spot honestly: because `general` is itself reachable,
ADR-0024's reachability analysis counts every member of it as reachable too. It
would never have found `setMaxStepRate`. Two audits, two different questions.

## Closing two coverage gaps, because they check ADR-0028 from the rig

Key-frame query **122** returns `kf_getMaxProgramTime()`, which *is* the
denominator the firmware divides percent by — `kf_getMaxMoveTime() + start_delay`
on `CONT_VID`, `kf_getMaxCamTime() + start_delay` on anything else. We already
sent it. General query **125** is the classic equivalent (`totalProgramTime()`);
we now do too.

So at the end of every recorded pass the app reads the device's own elapsed and
its own denominator, and `timingCheck()` compares that denominator against the
duration we uploaded:

> *the device divided percent by 12000 ms while the uploaded move is 10000 ms —
> 20.0% longer. Percent, and every comparison joined on it, is scaled by that.
> Check the plan type and the start delay (ADR-0028).*

That detects the ADR-0028 bug class **from the rig**, not from a mode read-back —
which matters, because a mode read-back only catches the cause we already know
about. A start delay, a firmware variant, or something none of us has thought of
would show up here as the same disagreement.

## Consequences

- `check.sh` and CI gain a step. It runs in milliseconds off committed data.
- Re-extracting is a documented one-line command rather than a memory of how the
  file was made.
- The payload hints are **hints, not contracts** — the extractor classifies by
  which reader a case body calls, and says `null` where it cannot tell. The
  audit does not check payload widths today; doing so would need the hint to be
  a contract, and it is not one yet.
- If the firmware reference is ever updated past the Nov 2018 master, the table
  is regenerated and the diff is the change log of what moved.
