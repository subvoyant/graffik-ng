#!/usr/bin/env bash
# Does the actual app still start? (ADR-0033)
#
# Everything else in check.sh exercises the core, the CLI, the reference
# firmware, or the renderer against its browser-preview stub. None of it loads
# the Electron main process. Seven versions of main-process work — new IPC
# handlers, a startup read of the recordings folder, controller state captured
# on connect — had never been run under Electron at all.
#
# `ipcMain.handle` THROWS on a duplicate channel, and a preload method invoking
# a channel nobody handles fails only when the operator clicks the thing. Both
# produce a dead app, and `node --check` sees neither.
#
# This boots the real app under a virtual display, holds it open, and fails on a
# crash or an early exit. It skips — loudly — where it cannot run.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../apps/jog-slice" && pwd)"
ELECTRON="$APP_DIR/node_modules/.bin/electron"
HOLD_SECONDS="${SMOKE_HOLD_SECONDS:-8}"

if [ ! -x "$ELECTRON" ]; then
    echo "SKIPPED: electron is not installed in apps/jog-slice (run npm ci there)"
    exit 0
fi
if ! command -v xvfb-run >/dev/null 2>&1; then
    echo "SKIPPED: no xvfb-run on this machine, so the app cannot be booted headlessly"
    echo "         (macOS and dev laptops hit this; the Linux CI job is the one that must pass)"
    exit 0
fi

LOG="$(mktemp)"
trap 'rm -f "$LOG"' EXIT

# --no-sandbox: the CI container has no user namespaces. It changes nothing
# about whether the app's own code starts.
xvfb-run -a "$ELECTRON" "$APP_DIR" --no-sandbox >"$LOG" 2>&1 &
PID=$!

sleep "$HOLD_SECONDS"

if ! kill -0 "$PID" 2>/dev/null; then
    echo "FAIL: the app exited within ${HOLD_SECONDS}s of starting"
    echo "--- output ---"
    cat "$LOG"
    exit 1
fi

kill "$PID" 2>/dev/null || true
wait "$PID" 2>/dev/null || true

# A crash on a background thread can leave the process up but useless, so read
# the output too. Deliberately narrow: broad greps here would fail on the first
# harmless deprecation notice and get switched off.
if grep -qE "Uncaught Exception|UnhandledPromiseRejection|Cannot find module|is not a function|already been registered" "$LOG"; then
    echo "FAIL: the app started but reported a fault"
    echo "--- output ---"
    cat "$LOG"
    exit 1
fi

echo "app booted and stayed up for ${HOLD_SECONDS}s with no fault reported"
