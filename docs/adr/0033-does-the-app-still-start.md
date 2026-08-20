# ADR-0033: Check that the app still starts, and that its two IPC halves agree

**Status:** Accepted (v0.27)
**Date:** 2026-08-20
**Deciders:** Project owner + Claude

## Context

`check.sh` grew to eight steps and covers a great deal: the protocol core, the
CLI against the simulator, the reference firmware compiled against a host shim,
protocol parity, dead exports, the command vocabulary against the dispatch.

**None of it loads the Electron main process.**

Seven versions in one session added roughly fifteen IPC handlers, a startup read
of the recordings folder, controller state captured on connect, and a plan-type
read-back — and the app itself had not been launched since v0.18. Everything was
verified either as pure core, or in a browser against the renderer's preview
stub, which is precisely the half where `main.js` does not exist.

Two specific failure modes make that gap sharp:

- **`ipcMain.handle` throws on a duplicate channel.** Register the same string
  twice and the app is dead before the window opens. `node --check` sees a
  perfectly valid file.
- **A preload method invoking a channel nobody handles fails only when the
  operator clicks the thing.** Rename one side of a pair and everything builds,
  loads, and looks right until somebody presses Run — on a shoot, that is the
  worst available moment to find out.

Both are cheap to introduce (I added `classicCheck` / `nmx:classic-check` as a
pair a version ago and nothing but my own care connected them) and neither is
visible to any check that existed.

## Decision

Two steps, in `check.sh` and in CI.

**`scripts/audit-ipc.mjs`** — text-matches `ipcMain.handle("…")` in `main.js`
against `ipcRenderer.invoke("…")` in `preload.cjs` and fails on a duplicate
registration, a channel invoked but not handled, or a handler nothing invokes.
Text matching is deliberate: both files declare their channels as string
literals, and a parser would be more machinery than the problem. Today: 82
handlers, 82 invoked, all agreeing.

**`scripts/smoke-electron.sh`** — boots the real app under `xvfb-run`, holds it
open, and fails if it exits early or reports a fault. It reads the output too,
because a crash on a background thread can leave the process up but useless —
with a **narrow** pattern list, because a broad grep would trip on the first
harmless deprecation notice and get switched off, which is how a check dies.

**It skips loudly rather than silently.** No `xvfb-run` (macOS, most laptops) or
no Electron installed → it says which, and says the Linux CI leg is the one that
has to pass. A check that quietly does nothing is worse than one that is absent,
because the green tick is a claim.

## What this is not

It is not a UI test. It asserts that the app **starts** — modules resolve, all
handlers register, the startup read of the recordings folder does not throw, a
window is created. Whether the app is *correct* is what the other 404 tests and
the headless render passes are for.

It is also not a substitute for running the thing. The first hardware session
still needs a human to open it.

## Consequences

- `check.sh` gains ~10 seconds.
- CI installs Electron on the ubuntu leg to run it; the macOS leg skips and says
  so.
- The `SMOKE_HOLD_SECONDS` knob exists so a slow machine can hold longer without
  editing the script.
- If Electron ever becomes flaky to boot in CI, the honest response is to make
  the failure louder, not to delete the step — the class of bug it catches
  produces an app that does not open at all.
