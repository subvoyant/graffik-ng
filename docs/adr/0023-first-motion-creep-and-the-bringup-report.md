# ADR-0023: Creep on an untaught axis, and a bring-up report that leaves the room

**Status:** Accepted (v0.16)
**Date:** 2026-08-19
**Deciders:** Project owner + Claude

## Context

Hardware in two days. Two gaps left that only matter on a first session, and
both of them stop mattering once the rig is known — which is exactly why they
are easy to leave undone and expensive to leave undone.

## Decision

### 1. An axis nobody has taught jogs at creep speed

ADR-0013 put soft limits in the main process and made them un-bypassable. It
cannot help with the first jog, because **limits are taught by jogging to
them** — so the procedure necessarily runs limit-less at the exact moment the
operator knows least about the machine.

So an axis with neither bound taught is capped at **500 steps/s** (against a
4000 hard clamp and an 800 default). A slow collision is a recoverable noise; a
fast one bends a rail or drops a camera off a head. Every motion-control
operator creeps on first motion — the software should default to what a careful
person would do anyway.

Enforced in the **main process**, alongside the limits themselves and for the
same reason: no renderer bug can bypass it.

**It self-clears.** Teach *either* bound on that axis and full speed returns.
That is one button press, which is why there is deliberately **no separate
override switch** — an override is a thing you leave on by accident, and the
escape hatch here is the action you were about to take anyway.

Zero passes through uncapped, so nothing about stopping is ever slowed down.

*This one is a judgement, not a measurement.* If 500 steps/s is uselessly slow
for teaching limits on a real slider, the number is wrong and should be changed
against what the rig does — not defended.

### 2. The facts from a hardware session have to be able to leave the room

A bring-up produces things that exist nowhere else: the firmware version, which
port answered, the travel taught, the spans measured, whether five passes
returned to the same place, what went wrong and what was done about it. All of
it is the input to every software decision that follows, and by default it lives
in somebody's memory until the next morning.

So: one button, one markdown file, everything the app knows about this rig
today.

Three rules make it worth reading:

- **Everything unmeasured is listed as "not measured", never omitted.** A report
  that silently drops the parts nobody got to reads like a complete one, and the
  entire point is to know what is still unknown when the rig goes away.
- **Warnings are spelled out, not counted.** "1 warning" tells nobody anything.
- **Measured-but-not-applied is flagged explicitly.** Measuring a calibration
  and never pressing *Use these numbers* is the easiest way to leave a session
  believing a number is in effect when it is not — and a table with two numbers
  in it puts the work of noticing onto the reader.

The renderer supplies the pass log, verbatim and newest-first, because main has
never seen it and because on a first bring-up nobody yet knows which line
mattered. The operator's free-text note is the most valuable field in the file
and the only one nothing else can produce.

`bringUpReport` is **pure** — state in, markdown out, caller supplies the
timestamp — so the same session always renders the same file and it is testable
without freezing time.

## Consequences

- The next round of software work starts from what the rig actually did rather
  than from what the previous round assumed. That is the whole reason this
  exists rather than being a nice-to-have.
- The report is a deliberate mirror of the project's own honesty rule: it is
  more useful for what it admits than for what it claims.
- A first jog is slower than a tenth jog. That is the intent, and it will be
  irritating exactly once per axis per rig.

## Alternatives considered

**A confirmation before the first jog.** A dialog at the rig, where nobody is
looking, and one that trains people to dismiss dialogs. Creeping needs no
attention and protects without asking for any.

**An override checkbox for the creep cap.** Rejected: the rail's height budget
is spent, and more importantly an override is a thing you leave on. Teaching a
limit is faster than finding a checkbox.

**Auto-export the report at quit.** Silent files nobody asked for, most of them
from sessions where nothing happened. A button pressed deliberately produces a
file somebody intends to read.

**Ship the report as JSON.** Better for tooling, worse for the actual consumer —
which is a person reading it, or pasting it into a conversation. Markdown loses
nothing here because the structured source is still in preferences.
