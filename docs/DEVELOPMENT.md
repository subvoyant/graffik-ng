# Development guide

Practical how-to for working on Graffik NG. For *why* the project is built this
way, see [`adr/`](adr/README.md); for *how the code is laid out*, see
[`digests/HUB.md`](digests/HUB.md).

## Prerequisites

- **Node 18+** (`node --version`). Node 22 LTS or newer recommended; CI runs 22.
- macOS for the app and packaging. The protocol core and CLI are cross-platform.
- An NMX controller on USB for hardware work — everything else runs against the
  built-in simulator.

## Repo layout: three npm projects, never the root

The repository root is **not** an npm project — it has no `package.json`. Running
`npm ci` there fails with `EUSAGE`, which is expected, not a problem. All npm
commands run inside one of these:

| Directory | What it is |
|---|---|
| `packages/nmx-protocol` | Headless core: protocol, solver, film schema, simulator. Has the test suite. |
| `packages/nmx-cli` | Headless runner (`nmx ports/info/run/stop`). |
| `apps/jog-slice` | The Electron app. |

`nmx-cli` and `jog-slice` depend on the core via `file:../nmx-protocol`, so the
core must be **built** (`npm run build` → `dist/`) before they can import it.

## First-time setup

```sh
cd packages/nmx-protocol && npm ci && npm run build
cd ../nmx-cli && npm ci
cd ../../apps/jog-slice && npm ci
```

If npm warns that install scripts are "not yet covered by allowScripts", approve
the two that legitimately need them — Electron downloads its runtime and
serialport builds native bindings:

```sh
npm install-scripts approve electron
npm install-scripts approve @serialport/bindings-cpp
```

Approvals are **pinned to the installed version**, so re-approve after upgrading
either package. (See [ADR-0008](adr/0008-dependency-hygiene-electron-xprotect.md).)

## Daily loop

Changed core source (`packages/nmx-protocol/src/**`)? Rebuild, then launch:

```sh
cd packages/nmx-protocol && npm run build
cd ../../apps/jog-slice && npm start
```

Changed only app files (`main.js`, `renderer.js`, `index.html`, `preload.cjs`)?
Skip the build — just `npm start`. There is no bundler or watch step; the app
loads those files directly.

## Tests

```sh
cd packages/nmx-protocol && npm test        # 53 tests, ~300 ms
npx tsc --noEmit                            # strict type check
```

The suite is the same one CI runs: byte-exact protocol encoding against the
firmware's own sample packets, the Hermite spline solver, film round-trips, and
end-to-end workflows driven against `SimulatedNmx`. It needs no hardware.

## When you actually need `npm ci`

Rarely. It deletes `node_modules` and reinstalls exactly what the lockfile
specifies ([ADR-0011](adr/0011-commit-lockfiles-npm-ci.md)). Use it on a fresh
clone, or after a `git pull` that changed any `package.json` / `package-lock.json`.
Otherwise your existing `node_modules` is fine. To refresh all three at once:

```sh
for d in packages/nmx-protocol packages/nmx-cli apps/jog-slice; do (cd $d && npm ci); done
```

## Demo mode (no hardware)

Pick **`simulator://nmx — demo mode — no hardware`** in the app's port picker.
The simulator implements the firmware's dispatch semantics, animates program
progress so passes complete, and integrates jog speed into positions in real
time — so jogging, capturing keyframes, uploading, running passes, and the
camera test-fire all behave end to end. Fidelity and timing questions still need
real hardware.

The CLI has the same escape hatch:

```sh
cd packages/nmx-cli
node cli.js info --sim
node cli.js run ~/moves/my-move.graffik --sim --passes 3 --cue 2
```

## Running against real hardware

```sh
cd packages/nmx-cli
node cli.js ports                                   # find /dev/tty.usbserial-*
node cli.js info --port /dev/tty.usbserial-XXXX     # expect: firmware v70
```

Programmed moves are **blocked unless the controller reports firmware v70**, the
version the command map was verified against ([ADR-0004](adr/0004-firmware-dispatch-is-ground-truth.md)).
Update the NMX from Dynamic Perception's `nanoMoCo_Firmware` repo rather than
overriding the gate. If you must override: the app has a button; the CLI takes
`--force`. Jog and queries are never gated, so you can always diagnose.

**Do not pick `/dev/tty.debug-console`** — that's a macOS system device, not the
controller.

## Packaging

```sh
cd apps/jog-slice && npm run dist     # → release/Graffik NG-<version>.dmg
```

Unsigned. macOS will warn on first launch until an Apple Developer ID is wired
into electron-builder (`CSC_LINK` / `CSC_KEY_PASSWORD`, plus notarization
credentials). CI builds the same unsigned dmg as a downloadable artifact on every
push to `main`.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `dyld: Library not loaded: ...libllhttp...` on any npm command | Homebrew upgraded a lib out from under Node. `brew reinstall node`. |
| `Electron failed to install correctly` | Its postinstall was blocked (allowScripts) so the binary never downloaded. Approve `electron`, then `npm rebuild electron`. If `node_modules/electron/path.txt` is missing, recreate it: `printf 'Electron.app/Contents/MacOS/Electron' > node_modules/electron/path.txt`. |
| macOS says the app "contains malware" and trashes it | XProtect false-positive on a **stale** Electron build — the same pattern that has hit other npm-delivered tools. Do not bypass it: upgrade to current-stable Electron (check `endoflife.date/electron`). Never pin an EOL major. |
| `npm ci` → `EUSAGE ... can only install with an existing package-lock.json` | You're in the repo root. Run it inside one of the three project directories. |
| CI fails with `npm error Missing: <pkg> from lock file` (many lines) | A `package.json` gained or changed a dependency without a matching `npm install`, so the committed lockfile is stale. `npm ci` is *supposed* to fail here rather than silently resolving something new ([ADR-0011](adr/0011-commit-lockfiles-npm-ci.md)). Fix: `cd` into that package, run `npm install`, and commit the updated `package-lock.json`. Tell which package from the failing job's `working-directory`. |
| App can't find the NMX | Wrong port, a charge-only USB cable, or the controller is asleep. Hit ↻ to re-list, power-cycle the NMX, try another cable. |
| `npm audit` reports high/critical in `nmx-protocol` | Dev-only dependency tree (vitest/esbuild). The core ships **zero** runtime dependencies and none of it reaches the app bundle. Still worth clearing on a bump. |

## Conventions

Read [`CONTRIBUTING.md`](../CONTRIBUTING.md) before changing anything — in
particular the no-GPL-code rule (which keeps our MIT license valid), the
firmware-as-ground-truth rule, and the same-change rule for keeping digests in
sync with code.
