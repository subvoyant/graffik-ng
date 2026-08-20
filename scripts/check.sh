#!/usr/bin/env bash
#
# Everything CI runs, in one command, in the same order.
#
#     ./scripts/check.sh
#
# This exists because a handed-over command line with a `# comment` in it is a
# trap: zsh does not enable interactive comments by default, so `npm test  # 248`
# passes `#` and `248` to vitest as filters and it exits with "No test files
# found" — which looks like a broken repo and is actually a broken instruction.
# One script, no comments to paste, and it cannot drift from CI without someone
# noticing.
set -euo pipefail
cd "$(dirname "$0")/.."

step() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

step "build the protocol core"
npm run build --prefix packages/nmx-protocol

step "typecheck"
npx --prefix packages/nmx-protocol tsc --noEmit -p packages/nmx-protocol

step "core tests"
npm test --prefix packages/nmx-protocol

step "CLI smoke test against the simulator"
node packages/nmx-cli/cli.js info --sim

# The CLI drives the NMX only. A move carrying cues or lens axes must be refused,
# not quietly run as a motion-only pass that reports "complete" (ADR-0016/0018).
if node packages/nmx-cli/cli.js run packages/nmx-cli/test/lens-move.graffik --sim >/dev/null 2>&1; then
    echo "FAIL: nmx run accepted a lens-bearing move without --motion-only" >&2
    exit 1
fi
echo "lens-bearing move refused without --motion-only"

# ...and the whole run path still works end to end against the simulator.
node packages/nmx-cli/cli.js run packages/nmx-cli/test/lens-move.graffik --sim --motion-only --cue 0 \
    | tail -1

step "reference firmware exercise"
CXX=${CXX:-g++}
"$CXX" -std=c++17 -Wall -I firmware/graffik-trig/test \
    -o "${TMPDIR:-/tmp}/graffik-fwtest" firmware/graffik-trig/test/test_firmware.cpp
"${TMPDIR:-/tmp}/graffik-fwtest"

step "dead-export audit"
node scripts/audit-exports.mjs --strict

step "command vocabulary vs the firmware dispatch"
node scripts/audit-vocabulary.mjs --strict

step "IPC surface: main and preload agree"
node scripts/audit-ipc.mjs

step "the app actually starts"
./scripts/smoke-electron.sh

step "protocol parity — TypeScript simulator vs C++ firmware"
node firmware/graffik-trig/test/parity.mjs

printf '\n\033[32mall checks passed\033[0m\n'
