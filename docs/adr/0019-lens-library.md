# ADR-0019: The lens library — marks belong to a lens, not to a move

**Status:** Accepted (v0.12)
**Date:** 2026-08-19
**Deciders:** Project owner + Claude

## Context

ADR-0017 established that a lens map — the witness marks translating barrel
travel into real distances — lives in the move file. That was right for one
move and wrong for a shoot.

A 35 mm prime has the same marks on Tuesday that it had on Monday. Marking a
barrel is careful, physical work: drive to a distance, check it against a tape,
write it down, repeat. Ask someone to redo that for every setup and they will
stop doing it, and the lane silently degrades to percent — which still repeats
perfectly and tells the operator nothing.

Preston's hand unit stores 150 lenses. That number is not arbitrary; it is what
a rental house's worth of glass looks like, and the reason the feature exists is
that a lens change on set cannot mean a re-calibration.

## Decision

### 1. A library, held in preferences, keyed by id

`LensLibraryEntry {id, name, kind, marks, notes?, savedAt?}`, stored in
`preferences.json` beside the other rig configuration and guarded on load like
every other sub-object — `prefs.recent` taught us in v0.7.0 what an unguarded one
costs, and a malformed library must not be able to break a save.

**Matching is on `id`, never on name.** Two people can call a lens "35mm" and
mean different glass; the same lens can be renamed without becoming a different
lens. Names are for humans, ids are for merging. Ids are readable and derived
(`focus-zeiss-cp-3-35mm-k3f9`) rather than opaque UUIDs, so a library file can be
read and edited by a person — and the entropy is supplied by the caller, keeping
the core pure and testable.

### 2. Applying a lens is undoable; forgetting one is not destructive

Picking a lens from the library takes an undo snapshot and replaces the lane's
map — it is an edit to the move, and ⌘Z must reach it.

Removing a lens from the library **does not touch any lane that is using it**.
The move keeps its marks; only the shortcut for next time is gone. A "delete"
that silently unmarks an already-marked move would be the worst kind of
destructive: invisible until the pull comes out wrong.

### 3. Import merges, and reports; it never replaces

Someone hands you their library and losing your own marks in exchange is not an
import, it is an accident. So import merges by id, and returns what it did —
added, updated, and rejected by name.

**A malformed entry does not sink the file.** If a library of 150 lenses
contains one bad one, refusing all 149 good ones helps nobody: the survivors go
in and the casualties are named. This is the opposite of the rule for a *move*
file, deliberately — a move is one indivisible thing whose partial load would be
a wrong move, while a library is a collection whose partial load is a smaller
collection.

### 4. The file format states what it is

`.graffiklens` is versioned JSON carrying its own `format` and `version`, and
parsing refuses somebody else's JSON rather than guessing at it — the same
discipline as `.graffik` (ADR-0010) and the trigger protocol (ADR-0004).
Duplicate ids are refused at serialisation: since merge matches on id, a file
containing two entries with one id is ambiguous, and an ambiguous library is
worse than a missing one.

### 5. Entry validation reuses the map validator

An entry that would be rejected as a `LensMap` is one that cannot be used.
Discovering that when it is applied to a lane is discovering it too late, so
`validateLensLibraryEntry` calls `validateLensMap` rather than growing a second,
subtly different set of rules.

## Consequences

- Marking a lens is now done once. The picker is filtered to the axis's kind, so
  a focus map cannot be hung on an iris lane.
- The button reads **Keep** for a lens the library has never seen and **Update**
  for one it has, because "I re-marked this lens" and "I have a second lens with
  a similar name" are different intentions and the UI should not conflate them.
- Libraries travel: Export writes the whole thing, Import merges it. Glass moves
  between rigs and between people, and so should its marks.
- The library lives in preferences, so it is per-machine until someone exports
  it. That is the right default (no sync service, no accounts) and the wrong
  long-term answer for a two-camera shoot; Export/Import is the manual bridge.
- **Unverified against a real lens.** Everything here is bookkeeping around
  numbers a human types in after looking at a barrel. Whether those numbers are
  right is Phase 7's problem, not this ADR's.

## Alternatives considered

**Keep marks only in the move file.** Status quo. Correct for one move, and it
makes the careful work non-reusable, which means it stops being done.

**A separate `lenses.json` in userData.** Cleaner separation, and 150 lenses is
about 70 kB — well within what preferences already carries. A second file means
a second loader, a second guard and a second thing to back up, for no benefit
the operator can see. Rejected.

**Match on name instead of id.** Simpler, no id generation, and it merges two
different people's "35mm" into one entry and loses a set of marks. Rejected.

**Refuse the whole file if any entry is malformed.** Consistent with how move
files are treated, and wrong here: a move is one indivisible thing, a library is
a collection. Rejected in favour of reporting the casualties.
