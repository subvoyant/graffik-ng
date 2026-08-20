# ADR-0032: A recording is written to disk the moment the pass ends

**Status:** Accepted (v0.26)
**Date:** 2026-08-19
**Deciders:** Project owner + Claude

## Context

The flight recorder (ADR-0027) has held its recordings in memory since it
shipped: an array of twenty, dropped oldest-first, gone on quit. The documented
mitigation was "export the CSVs".

That is not a mitigation on a shoot. The first hardware day is simultaneously
the day the measurements matter most — first contact, first repeatability
numbers, the sample-cost figure that decides the poll rate, the device-timing
check that ratifies ADR-0028 — and the day the app is most likely to be
restarted: a preference change, a crash, an Electron reload, a laptop lid.
"Remember to export twenty CSVs by hand before quitting" is a step nobody
performs under time pressure, and its absence is silent.

## Decision

**Write each recording to `userData/recordings/` as JSON the instant the pass
ends, before anything else can drop it.**

- **Disk first, then the in-memory list.** The array has a cap that discards the
  oldest; saving after that could have thrown a pass away before writing it.
  The file is the record. The array is only what the dialog can show without
  reading files.
- **Previous sessions load at startup**, through `parsePassTrace()` — a
  validating parser in the core, not `JSON.parse` at the call site. One
  unreadable file is skipped and **counted**, never allowed to cost you the
  other nineteen. That is the `prefs.recent` lesson from v0.7.0, applied to a
  new kind of stored data.
- **The parser is strict about what it knows and permissive about what it does
  not.** A file from a future build still opens, minus whatever this build
  cannot interpret. A sample whose reading is unusable keeps its slot as `null`
  — the sample happened; that axis just has nothing to say — while a sample with
  no usable percent is dropped, because percent is the join key and a sample
  without one cannot be placed.
- **Nothing is ever deleted.** The load limit (50) bounds what is read at
  startup, not what is kept. The dialog shows *shown / on disk / unreadable* and
  the path, so the counts never quietly disagree with the folder.
- **A failed write is said out loud** in the pass log, with the remedy: *"could
  NOT be written to disk — export the CSV before quitting."* A recorder that
  silently fails to record is worse than one that never claimed to.

## Why JSON and not the CSV

The CSV is for taking data somewhere else, and it flattens: it cannot carry the
timebase, the per-axis microstep setting, `endedBy`, or the device-timing block
that says whether percent meant what we think it meant. A recording without
those is not a measurement — it is a column of numbers. The JSON is the record;
the CSV is an export of it.

## Consequences

- A few kB per pass; a whole hardware day is well under a megabyte.
- Recording ids are seeded from the loaded count at startup, so a reloaded
  `pass-3` and a fresh `pass-3` cannot collide in the compare dropdowns.
- The bring-up report names the folder and the file count, and flags any file it
  could not read — the report is what leaves the room, so it has to say where
  the rest of the evidence is.
- Not encrypted, not compressed, not rotated. If a folder of session recordings
  ever becomes large enough to care about, that is a good problem and a later
  decision.
