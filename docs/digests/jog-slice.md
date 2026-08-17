# Digest: apps/jog-slice (Electron app)

**Verified against** `apps/jog-slice/*` @ 2026-08-17 (v0.6) · Electron ^43.4.0 · serialport ^12 · electron-builder ^26 (`npm run dist` → unsigned dmg in `release/`)

## Shape

Four files, no bundler: `main.js` (ESM main process — all hardware + film I/O + pure math endpoints), `preload.cjs` (contextBridge → `window.nmx`), `index.html` (markup/styles), `renderer.js` (all UI logic, vanilla). `contextIsolation: true`, `nodeIntegration: false` (ADR-0007).

## main.js facts

- `NMX_BAUD=19200` · `SIM_PORT="simulator://nmx"` (demo mode) · `SUPPORTED_FIRMWARE=70` · `MAX_JOG_SPEED=4000` (hard clamp in the jog handler).
- **Firmware gate (ADR-0004):** connect returns `{firmwareVersion, supported}`; `requireProgrammedMovesAllowed()` throws on arm/run/upload/kf-run unless v70 or the user explicitly hit `nmx:override-firmware-gate`. Jog + queries are NOT gated (needed for diagnosis).
- Connect flow: open → `NmxClient(timeoutMs:800)` → `handshake()` → watchdog on. Disconnect/quit: `stopAll()` best-effort → close.
- **Cue countdown is host-side** (uniform across engines): classic arm sets firmware `startDelay(0)`; renderer shows the countdown overlay then triggers run. (Changed from v0.1 which used firmware gen-21 delay.)
- `nmx:preview-move` is **pure math** — no client required; the editor works disconnected (ADR-0009).

### Preferences (v0.6)

- File: `app.getPath("userData")/preferences.json`. `loadPrefs()` at startup merges over `DEFAULT_PREFS` (missing keys tolerated — never assume a field the user's file predates); `savePrefs()` is **debounced 400 ms** so scrub gestures don't hammer the disk.
- Shape: `{window:{width,height,x?,y?}, lastPort, jogSpeed, limits, gamepad:{bindings:{slide,pan,tilt →{axisIndex,invert}}, deadzone, curve, maxSpeedPct}, recent[]}`.
- `lastPort` is **remembered, never auto-connected** — the port dropdown pre-selects it; opening a serial port is always an explicit human act.
- Window bounds are saved on move/resize and restored on launch.

### Soft-limit enforcement (v0.6 — ADR-0013)

Main-process only; the renderer draws them but cannot bypass them (hub invariant 13). Three points:

1. **Jog request** — before sending speed, if the axis has a taught bound, query position and run `jogWouldExceed(lim, pos, speed)` (250 ms lookahead). If it would, send speed 0 and return `{blocked:true, position}` instead of throwing.
2. **Jog monitor** — `ensureJogMonitor()`, a **90 ms** interval over `activeJogs` (Map motor→speed). Re-queries each jogging axis; on violation removes it from `activeJogs`, sends speed 0, and pushes `nmx:limit-hit {motor, position, speed}` to the renderer. Self-cancels when `activeJogs` empties. Query failures are swallowed (transient serial hiccup must not kill the guard loop).
3. **Upload/arm** — `nmx:upload-kf` runs `violationsForFilm()` and **throws before any packet is written**; the message is `describeViolations()` output naming axis/key/position/bound.

Teaching: `nmx:set-limit-here (motor, "min"|"max")` queries live position and stores it; `nmx:clear-limits(motor)` (omit motor → all). Predicates all live in the core package (`limits.ts`) so they are unit-tested without Electron.

## IPC surface (the app's API contract — keep current)

| channel | args | notes |
|---|---|---|
| nmx:list-ports / connect / disconnect | — / portPath / — | connect → {firmwareVersion, supported} |
| nmx:override-firmware-gate | — | explicit unsafe override; resets on reconnect |
| nmx:get-prefs / set-prefs | — / patch | patch is shallow-merged, persisted debounced 400ms; returns full prefs |
| nmx:get-limits | — | 3-tuple `{min,max}` (nulls = untaught) |
| nmx:set-limit-here / clear-limits | (motor, "min"\|"max") / motor? | teach from live position; clear all if motor omitted |
| **event** nmx:limit-hit | {motor, position, speed} | main→renderer push when the 90ms monitor cuts an axis |
| nmx:enable-motors / jog / position | — / (motor, ±steps/s) / motor | jog clamped to ±4000; returns `{blocked:true, position}` if a limit refuses it |
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
- **Timeline canvas (flex-fills the stage):** ruler (drag = playhead), 3 stacked tracks, curve polylines from `preview-move` (debounced 50ms, 200 samples, clipped to the view window), draggable keyframes (interior: time+position clamped 100ms from neighbours; endpoints: position only), double-click deletes, auto y-scale per track with 100-step minimum span, zero-line drawn when the range crosses 0. **All layout math in CSS pixels (`clientWidth/Height`); DPR only scales the backing store** — mixing `canvas.height` (device px) into layout was a real bug (tracks 2× tall, Pan/Tilt clipped on retina; fixed 2026-08-16). Re-renders via `ResizeObserver`.
- **Capture buttons** (Dragonframe/eMotimo jog-to-keyframe idiom): query live position → add/replace keyframe at playhead (replace window ±250ms).
- **Duration change rescales** all keyframe times proportionally.
- **Gamepad jog (configurable as of v0.6):** toggle; 66ms poll; sends on change + ~264ms heartbeat while deflected (keeps watchdog fed); off/e-stop/disconnect zero all axes. Axis mapping comes from `prefs.gamepad.bindings` (defaults LS-X→slide, RS-X→pan, RS-Y inverted→tilt) via `readPadAxis(pad, which)`. Response shaping is `ballistics(raw, cfg)`: below `deadzone` → 0; else renormalize `(|raw|-dz)/(1-dz)`, raise to `curve`, scale by `maxSpeedPct/100`, re-sign. **Renormalizing after the deadzone is the point** — a naive `raw^curve` with a deadzone leaves a speed discontinuity at the threshold, which on a slider is a jerk in the shot.
- **Pass workflow:** host countdown overlay → run → 500ms progress poll → pass log (timestamped, newest first). Separate counters for classic vs KF passes.
- E-STOP clears timers + countdown + gamepad before `stopAll()`.

## Icons & packaging stub

`build/` holds the full icon set derived from the owner's Siena icns master: `icon.icns` (complete macOS ladder 16→1024 incl. retina), `icon.ico` (16–256 ladder for Windows), `icons/{256,512,1024}.png` (Linux + dev window/dock). electron-builder picks `build/icon.*` automatically; `package.json` carries the `build` stub (appId `com.subvoyant.graffik-ng`, productName "Graffik NG"). Dev-mode: BrowserWindow `icon` (win/linux) + `app.dock.setIcon` (macOS).

## Design system (v0.5 — ADR-0012)

Tokens are CSS custom properties in `index.html`'s `:root`; **never write literal hex in new UI**. Idiom is professional-3D-app: neutral dark greys (app `#131517` / panel `#1e2124` / raised `#262a2e`), **recessed** inputs (`#121416`, darker than their panel), elevation by 1px hairlines + value steps (no shadows), 24px uppercase micro-type panel headers, monospace tabular numerals for all values, accent (`--accent #3987e5`) only for active/selected. Axis colors are **validated** dataviz categorical slots 1–3 — slide `#3987e5`, pan `#d95926`, tilt `#199e70`; passes CVD all-pairs on this surface. Any new series color must come from the next validated slot, never invented. Axis identity is also carried by direct labels on each track (never color-alone).

Layout is a fixed frame — appbar / rail(244px) / stage / statusbar — with **no page scroll**; vertical space is a budget. New panels go in the rail or as a stage section.

**The rail's height budget is real and it is nearly spent.** Worst case (keyframe selected → the inspector expands, pass log populated) fits with 0 px to spare at the default 820 px window and overflows below ~790 px. The last rail panel (Pass log) is the elastic one — `flex:1 1 auto; min-height:56px`, scrolling internally — so it absorbs the slack; `.rail` keeps `overflow-y:auto` only as a safety valve. **Adding another always-visible rail panel will break the no-scroll rule** — put new configuration in a modal (as gamepad settings did) instead. Adding the Soft-limits panel in v0.6 is what consumed the remaining budget; it was paid for by moving its help text to a `title=` tooltip and putting the keyframe inspector's Time/Pos on one row.

**Browser-preview stub:** `renderer.js` installs a fake `window.nmx` when Electron's bridge is absent, so `index.html` opens directly in a browser for design work and screenshots. Guarded by `if (!window.nmx)` — unreachable under Electron. `window.nmx.__preview` flags it in the status line.

## Editor interactions (v0.5)

- **Drag-scrub numerics** (`makeScrubbable`, applied to every `input.num`): click to type, drag horizontally to scrub; ⇧ fine ×0.1, ⌘/Ctrl coarse ×10; 3px threshold distinguishes click from drag. The signature 3D-app gesture.
- **Timeline zoom/pan:** `view {t0,t1}` is the visible window. Wheel = zoom about cursor (clamped 400ms…4× duration), ⇧wheel or middle-drag = pan, `F`/`Home` or ⤢ = frame all, drift clamped to ±25% of duration. Ruler ticks auto-step through a nice-number ladder; zoom % shown in the panel header.
- **Keyframes are diamonds** (animation-software convention), white ring when selected.
- Space = run pass. Live position readout polls every 400ms while connected.

## v0.6 UI additions

- **Soft-limits rail panel** — per axis: numeric min/max readout (`—` when untaught), set-min/set-max-from-here buttons, clear. `nmx:limit-hit` flashes the axis row and writes a pass-log line.
- **Forbidden zones on the timeline.** `axisScale()` grows each track's y-range to *include* taught limits — capped at 60% of the move's own span per side so a distant bound can't squash the curve flat. Inside the view, the zone beyond a bound is shaded and the bound drawn as a dashed hairline; still off-scale (i.e. huge headroom, not a hazard) it becomes a **faint hairline pinned to the track edge**, deliberately weaker so "bound exists, far away" never reads as "forbidden here". Before this, auto-scaling on data alone made a limit invisible whenever it sat more than 15% outside the move — the case where the reassurance matters most (found by rendering the UI headless and looking at it, 2026-08-17).
- **Gamepad settings modal** — per-axis binding rows with a **"bind…" learn mode** (captures whichever stick moves past 0.5, so the user never has to know axis indices — controller axis numbering is not standardized across pads), invert checkbox, and ballistics sliders (deadzone / curve / max speed) over a **live response-curve canvas** that redraws as you drag. Writes through `setPrefs`.
- **Shortcut overlay** (`?`) — grouped key table. Both modals share `.modal/.sheet` styling and close on Esc / backdrop click; Esc handling is centralized so it can't fight the e-stop binding.

## Known gaps (intentional)

Per-axis classic arm params; KF `updateRateMs` not exposed; no per-keyframe easing/tangent handles (the solver picks velocities — ADR-0009); no panel resizing/docking; no light theme; gamepad **button** bindings (only axes are mappable — no e-stop-on-button yet); limits are per-axis boxes, not a swept-volume/collision model. (Simulator animates progress +20%/poll so demo passes complete — see nmx-protocol digest.)
