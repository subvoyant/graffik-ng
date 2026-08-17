# Digest: apps/jog-slice (Electron app)

**Verified against** `apps/jog-slice/*` @ 2026-08-17 (v0.4) · Electron ^43.4.0 · serialport ^12 · electron-builder ^26 (`npm run dist` → unsigned dmg in `release/`)

## Shape

Four files, no bundler: `main.js` (ESM main process — all hardware + film I/O + pure math endpoints), `preload.cjs` (contextBridge → `window.nmx`), `index.html` (markup/styles), `renderer.js` (all UI logic, vanilla). `contextIsolation: true`, `nodeIntegration: false` (ADR-0007).

## main.js facts

- `NMX_BAUD=19200` · `SIM_PORT="simulator://nmx"` (demo mode) · `SUPPORTED_FIRMWARE=70` · `MAX_JOG_SPEED=4000` (hard clamp in the jog handler).
- **Firmware gate (ADR-0004):** connect returns `{firmwareVersion, supported}`; `requireProgrammedMovesAllowed()` throws on arm/run/upload/kf-run unless v70 or the user explicitly hit `nmx:override-firmware-gate`. Jog + queries are NOT gated (needed for diagnosis).
- Connect flow: open → `NmxClient(timeoutMs:800)` → `handshake()` → watchdog on. Disconnect/quit: `stopAll()` best-effort → close.
- **Cue countdown is host-side** (uniform across engines): classic arm sets firmware `startDelay(0)`; renderer shows the countdown overlay then triggers run. (Changed from v0.1 which used firmware gen-21 delay.)
- `nmx:preview-move` is **pure math** — no client required; the editor works disconnected (ADR-0009).

## IPC surface (the app's API contract — keep current)

| channel | args | notes |
|---|---|---|
| nmx:list-ports / connect / disconnect | — / portPath / — | connect → {firmwareVersion, supported} |
| nmx:override-firmware-gate | — | explicit unsafe override; resets on reconnect |
| nmx:enable-motors / jog / position | — / (motor, ±steps/s) / motor | jog clamped to ±4000 |
| nmx:set-start-here / set-stop-here | — | classic jog-to-set (gen 26/27) |
| nmx:arm-move | travelMs, accelMs, decelMs | GATED; mode 1, delay 0, easing quadratic ×3 motors |
| nmx:goto-start / run / pause / progress | — | run GATED; progress = {percent, running} |
| nmx:preview-move | axes, durationMs, sampleCount? | pure; returns per-axis {solved, samples[{t,pos}]} |
| nmx:upload-kf | axes, durationMs | GATED; buildKeyFrameMove → returns packet count |
| nmx:kf-run / kf-stop / kf-progress | — | run GATED (backlash+run); progress = {state 0/1/2, percent} |
| nmx:goto-kf-start | axes | sendToPosition(motor, first-keyframe pos) per axis |
| nmx:save-film / load-film | film / — | native dialogs; `.graffik`; serialize/deserialize in core (ADR-0010); null on cancel |
| nmx:cam-arm / cam-fire / cam-disable | cfg{triggerMs,focusMs,delayMs,maxShots,intervalMs} / — / — | sub-addr 4; arm = enable + params; fire = exposeNow |
| nmx:stop-all | — | E-STOP; bypasses queue |

## renderer.js facts

- **Film model** mirrors core schema; `adoptFilm()` is the single entry for new/load. `uploaded` flag: any edit (drag, capture, delete, duration change) marks the controller copy stale → Run refuses until re-upload (ADR-0009 guard).
- **Timeline canvas (234px):** top ruler (drag = playhead), 3 stacked tracks (slide/pan/tilt, colored), curve polylines from `preview-move` (debounced 60ms), keyframe dots draggable (interior: time+position, clamped 100ms from neighbors; endpoints: position only), double-click deletes interior keyframes, auto y-scale per track with 100-step minimum span. **All layout math in CSS pixels (`clientWidth/Height`); DPR only scales the backing store** — mixing `canvas.height` (device px) into layout was a real bug (tracks 2× tall, Pan/Tilt clipped on retina; fixed 2026-08-16).
- **Layout is compact by design** to fit ~930px content height with zero scroll (window 900×930 `useContentSize`, min 820×760); no h1, tight fieldsets, 52px pass log. Keep it that way when adding sections — vertical space is a budget.
- **Capture buttons** (Dragonframe/eMotimo jog-to-keyframe idiom): query live position → add/replace keyframe at playhead (replace window ±250ms).
- **Duration change rescales** all keyframe times proportionally.
- **Gamepad jog:** toggle; 66ms poll; LS-X→slide, RS-X→pan, RS-Y(inv)→tilt; deadzone 0.15 with quadratic response; sends on change + ~264ms heartbeat while deflected (keeps watchdog fed); off/e-stop/disconnect zero all axes.
- **Pass workflow:** host countdown overlay → run → 500ms progress poll → pass log (timestamped, newest first). Separate counters for classic vs KF passes.
- E-STOP clears timers + countdown + gamepad before `stopAll()`.

## Icons & packaging stub

`build/` holds the full icon set derived from the owner's Siena icns master: `icon.icns` (complete macOS ladder 16→1024 incl. retina), `icon.ico` (16–256 ladder for Windows), `icons/{256,512,1024}.png` (Linux + dev window/dock). electron-builder picks `build/icon.*` automatically; `package.json` carries the `build` stub (appId `com.subvoyant.graffik-ng`, productName "Graffik NG"). Dev-mode: BrowserWindow `icon` (win/linux) + `app.dock.setIcon` (macOS).

## Editor interactions (v0.4)

Undo/redo: film-snapshot stacks (≤50), ⌘Z/⇧⌘Z, snapshot taken before every mutation (drag start, capture, delete, duration change, inspector edit); adoptFilm clears stacks. Keyframe **selection** (click; white ring): inspector row shows axis/#, numeric t(s) + pos(steps) entry (endpoints time-locked), ✕ delete; keyboard ↑↓ nudge pos ±10 (⇧ ±100), ⌥←→ time ±100ms (interior), ⌫ delete. Keyboard ignored while typing in inputs. Demo mode: main.js calls `sim.startPhysics()` so jog moves live positions; camera "Test fire" works against sim state.

## Known gaps (intentional)

Camera trigger UI (plan says manual roll OK for v0.1); per-axis classic arm params; KF `updateRateMs` not exposed; no undo in editor. (Simulator animates progress +20%/poll so demo passes complete — see nmx-protocol digest.)
