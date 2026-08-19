# ADR-0026: A runner refuses work it can only partly do; a supervised UI may proceed after saying so

**Status:** Accepted (v0.20)
**Date:** 2026-08-19
**Deciders:** Project owner + Claude

## Context

A `.graffik` move file can carry three independent subsystems:

- **motion axes**, executed by the NMX (ADR-0005);
- **timeline cues**, executed by a GRAFFIK-TRIG board (ADR-0016);
- **lens axes**, executed by the same GRAFFIK-TRIG board on protocol v2 (ADR-0018).

Nothing guarantees the machine you are running on can reach all three. The CLI
opens a link to the NMX and to nothing else — by design, it has no trigger
backend at all. The app may be connected to a v1 cue board, which runs cues
correctly and has no lens hardware, or to no trigger device at all.

Until v0.19 `nmx run` loaded a file with lens axes, ignored them, ran the motion
axes, printed `pass complete`, and **exited 0**. Every layer of that is a lie to
whatever read it. It was found while packaging v0.19, not by a test — nothing
tested the CLI's run path end to end.

The tempting general rule is "always refuse what you cannot fully execute."
That rule is wrong for the app, and the reason it is wrong is the whole point of
this ADR.

## Decision

**A headless runner refuses. A supervised UI proceeds after saying so, in the
same breath as the thing it is saying it about.**

`nmx run` exits **1**, naming each subsystem it cannot execute, and runs only
when the operator passes `--motion-only` — which is them saying it back. The
flag is separate from `--force` (which bypasses the firmware-version gate);
overloading one flag with two meanings would make each one weaker.

The app arms the pass and logs, at arm time, `N lens lane(s) NOT driven — no
lens device; pull by hand`, then runs.

## Why the asymmetry is real and not laziness

- **The CLI's exit code is its only reader.** A script that gets 0 back has been
  told the pass happened. There is no operator to notice a line of stderr that
  scrolled past inside a loop of a hundred passes, and no second chance to catch
  it: the take is shot.
- **The app has a person looking at it**, at arm time, at the moment the message
  is about — and that person can still pull focus by hand, which is precisely
  what the message tells them to do. Refusing there would block the one workflow
  that still works: rig repeats, human pulls. That is how the shot was going to
  be done before lens motors existed, and it stays legitimate.
- **The difference is not "GUI vs terminal," it is whether a human is in the
  loop at the moment of the decision.** If the app ever grows an unattended
  batch-render mode, that mode is a runner and takes the runner's rule.

## The honest weak point

The app's warning is a **pass-log line, not a gate** — one line among several,
written as the pass starts. It is weaker than the CLI's refusal, deliberately,
and it is the place this decision is most likely to be wrong. If a take is ever
lost to an undriven lens lane, the fix is to promote it to a confirm-on-arm for
lens lanes specifically, and this ADR gets superseded rather than quietly
reinterpreted.

Soft travel limits are a separate and worse gap: they are enforced in the
Electron main process against limits in *its* preferences (ADR-0013), so the CLI
enforces **nothing**, including on the pre-pass `sendToPosition` that walks every
axis to the first keyframe. The CLI now says so on every run. That is a
disclosure, not a fix, and it is written down here so it is not mistaken for one.

## Consequences

- `scripts/check.sh` asserts both halves — the refusal, and a full
  `--motion-only` pass against the simulator. That is now the only end-to-end
  exercise of the CLI run path in CI; before v0.19 the CLI's only check was
  `nmx info --sim`.
- A fixture lives at `packages/nmx-cli/test/lens-move.graffik` and exists to be
  refused.
- Any future headless entry point (a batch renderer, a scheduled run) inherits
  the runner's rule, not the app's.
