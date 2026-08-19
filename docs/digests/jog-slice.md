# Digest: apps/jog-slice (Electron app)

**Verified against** `apps/jog-slice/*` @ 2026-08-19 (v0.24) · Electron ^43.4.0 · serialport ^12 · electron-builder ^26 (`npm run dist` → unsigned dmg in `release/`)

## Shape

Four files, no bundler: `main.js` (ESM main process — all hardware + film I/O + pure math endpoints), `preload.cjs` (contextBridge → `window.nmx` **and `window.tc`**), `index.html` (markup/styles), `renderer.js` (all UI logic, vanilla). `contextIsolation: true`, `nodeIntegration: false` (ADR-0007).

**`window.lens` and `window.controls` are bridged for the same reason as `window.tc`** (ADR-0024, ADR-0021): the renderer had grown its own copy of the lens formatter, axis constructor and library conversions because nothing exposed the originals. Never reimplement a core pure function in the renderer — bridge it.

**`window.tc` — the timecode bridge (v0.7, ADR-0014).** preload `require()`s the core package and re-exposes the timecode functions as pure SYNC calls. The renderer redraws on every pointer move, so per-label IPC is absurd; a second copy of the arithmetic in the renderer is worse, because drop-frame drifts quietly. Consequence: the app now hard-depends on the core being **built** (`dist/`), and preload throws a named error if it is not — a loud startup failure instead of a subtle wrong answer. `require()` of an ESM package needs Node ≥22.12, which every supported Electron ships.

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
| nmx:arm-move | travel/accel/decel **frames**, timebase | GATED; mode 1, delay 0, easing quadratic ×3 motors |
| nmx:goto-start / run / pause / progress | — | run GATED; progress = {percent, running} |
| nmx:preview-move | **film**, sampleCount? | pure; returns per-axis {solved, samples[{**frame**,pos}]} |
| nmx:upload-kf | **film** | GATED; limits check → buildKeyFrameMove → returns packet count |
| nmx:cue-ms | film | cue countdown in ms (main owns frames→ms) |
| nmx:kf-run / kf-stop / kf-progress | — | run GATED (backlash+run); progress = {state 0/1/2, percent} |
| nmx:goto-kf-start | axes | sendToPosition(motor, first-keyframe pos) per axis |
| nmx:save-film | film, existingPath? | **path given = Save (no dialog); omitted = Save As**. Serialises BEFORE the dialog so an invalid move is refused without first asking where to put it. Returns the path, or null on cancel |
| nmx:load-film | path? | returns `{film, path}` (the path is what makes Save work later); migrates v1 on the way in |
| nmx:export-formats | — | `[{id,label,ext,note}]` — the note is operator-facing and shown in the dialog |
| nmx:export-move | film, formatId, opts | writes the file; for `abc` also writes the Blender converter script beside it; returns `{written[], format}` |
| nmx:move-extents | film, calibration | pre-flight scale check: per-axis min/max/range in mm and degrees |
| nmx:cam-arm / cam-fire / cam-disable | cfg{triggerMs,focusMs,delayMs,maxShots,intervalMs} / — / — | sub-addr 4; arm = enable + params; fire = exposeNow |
| nmx:trigger-backends | — | `[{id,tier,outputs,describe}]`; the simulated backend is always present |
| nmx:trigger-connect / -disconnect | portPath / — | 115200 baud; `hello()` handshake; returns `{name,protocol,outputs,inputs,tier}` |
| nmx:get-bindings / set-bindings | — / bindings[] | logical target → `{backendId, output}`; rig config, lives in prefs |
| nmx:cue-check | film | pre-flight: `{total, unroutable[{id,target,reason}], tier, device}` |
| nmx:cues-arm | film | tier 2 → uploads the list to the device; tier 1 → loads the host scheduler. Returns which you got |
| nmx:cues-start / cues-stop | — | start with the move; **stop returns `{fired, worstJitterMs, dispatched[]}`** |
| nmx:cue-test | target, action | fire one cue now, for checking wiring |
| nmx:dmx-connect / dmx-disconnect | portPath / — | Enttec DMX USB Pro; disconnect blacks out on the way |
| nmx:osc-connect / osc-disconnect | {host,port,prefix} / — | UDP; `host: "simulated"` uses the in-memory socket |
| **events** nmx:cue-fired / cue-problem / trigger-input | … | device fire reports (device clock), scheduler problems, GPI edges |
| nmx:stop-all | — | E-STOP; **aborts every backend FIRST**, independently of the NMX (ADR-0016), then broadcast stop |

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

**Browser-preview stub:** `renderer.js` installs a fake `window.nmx` when Electron's bridge is absent, so `index.html` opens directly in a browser for design work and screenshots. Guarded by `if (!window.nmx)` — unreachable under Electron. `window.nmx.__preview` flags it in the status line. **A stub must be at least as faithful as the thing it stands in for**, for the same reason the simulator must be exactly as strict as the firmware (hub invariant 23): every headless render check runs against these stubs, so a stub that answers wrongly makes the verification worthless. v0.21 shipped a `window.trace.deviationLines` stub that returned the refusal line unconditionally, and the render check duly reported *"not comparable"* over a perfectly good comparison. The rule is not "keep stubs small" — it is *keep stubs honest, and keep them thin where honesty is cheap*.

## Editor interactions (v0.5)

- **Drag-scrub numerics** (`makeScrubbable`, applied to every `input.num`): click to type, drag horizontally to scrub; ⇧ fine ×0.1, ⌘/Ctrl coarse ×10; 3px threshold distinguishes click from drag. The signature 3D-app gesture.
- **Timeline zoom/pan:** `view {t0,t1}` is the visible window. Wheel = zoom about cursor (clamped 400ms…4× duration), ⇧wheel or middle-drag = pan, `F`/`Home` or ⤢ = frame all, drift clamped to ±25% of duration. Ruler ticks auto-step through a nice-number ladder; zoom % shown in the panel header.
- **Keyframes are diamonds** (animation-software convention), white ring when selected.
- Space = run pass. Live position readout polls every 400ms while connected.

## Cue lane (v0.8 — ADR-0016)

- **Canvas geometry:** `RULER(20) → CUE_LANE(22) → three tracks`. `tracksTop()` is the single place that offset is computed; grid lines and track rects both derive from it. Cues sit **above** the axes because they belong to the move, not to an axis.
- Markers are frame-snapped flags; a cue with `durationFrames` also draws a bar, so "light on for 12 frames" reads as duration rather than an instant. Label falls back to the target name.
- Click to select, drag to move (clamped so a sustained cue cannot run past the end), double-click or ⌫ to delete, `C` adds one at the playhead, ⌥← / ⌥→ nudges by a frame (⇧ = a second).
- **The inspector is context-sensitive:** `selection = {kind:"key"|"cue", …}`. One rail panel serves both, which is both the 3D-app idiom and the only way it fits the height budget. Every `selection.track` read must guard on `kind === "key"`.
- **Pass flow:** `armCuesForPass()` pre-flights via `cue-check` and **aborts the pass** if any cue is unroutable — found before the performer is in position, not afterwards in a log. Then `cues-arm`, and `cues-start` fires at the same instant the move does (the countdown precedes both, so t=0 means the same thing on both sides).
- **Measured jitter per pass (v0.9).** `reportCueDelivery()` runs when a pass completes and logs `N cues fired · worst lateness M ms (host-timed)`, naming any cue more than 40 ms late. Tier 1's caveat becomes something the operator watches rather than something a document claims.
- **⚡ Cues… modal:** three transports — trigger board (the only Tier-2 path), **DMX** (Enttec port picker) and **OSC** (host/port/prefix) — plus the target bindings table with per-row test-fire. A binding can point at `simulated`/`serial`/`dmx`/`osc`. The tier chip turns green only on a real Tier-2 device, and the tier explanation lives in the dialog, not just the ADR.

## Lens lanes — focus / iris / zoom (v0.10 — ADR-0017)

- **Canvas geometry, updated.** `RULER(20) → CUE_LANE(22) → [GROUP_HEAD(15) → 3 motion tracks → GROUP_HEAD(15) → N lens tracks]`. The two `GROUP_HEAD` band strips only exist when `hasLens()`; with no lens lanes the layout is byte-for-byte the old three-track one. `rowCount()`/`rowHeight()`/`motionTop()`/`lensTop()`/`lensRect(i)` are the only places this is computed — do not re-derive it.
- **Colour is faceted, not extended.** A six-slot categorical palette FAILED all-pairs CVD validation (magenta↔aqua ΔE 1.6 deutan; yellow↔orange ΔE 10.6 normal), so lens lanes **reuse validated slots 1–3** (`--slide`/`--pan`/`--tilt`) inside their own labelled band. Per ADR-0012 the answer to "I need more series colours" is faceting. Identity comes from the band + the rotated per-lane label, never colour alone.
- **Lens tracks use a FIXED 0..1 scale** (motion tracks auto-scale). That makes the shape of a pull comparable between takes — and because the scale is fixed and load-bearing, both ends are labelled. `lensEndLabel()` prefers the **mark's engraving** (`∞`) over the map's number (`60.0m`), since the number claims precision the barrel never had. Quarter guides instead of a zero line: a lens has no natural zero.
- **The live value is drawn AT the playhead**, on the line it describes, in the lane colour, flipping side near the right edge. It was originally pinned to the track's top-right corner, where it read as a scale label and collided with any key on the last frame — a headless-render pass caught that.
- `selection = {kind:"key"|"cue"|"lens", …}`; the one rail inspector serves all three. **Every `selection.track` read must guard on `kind === "key"`.**
- **⌾ Lens… modal** (from the inspector) holds the lens name, the marks table (travel % → reading → barrel label), an add-mark row, `invert`, and Remove lane. Marks live in the **move file**, not yet in a reusable per-lens library.
- `nmx:preview-lens` samples the lanes in main via the core solver, debounced 50 ms into `lensCache`, exactly like `previewMove`. The browser-preview stub has a crude smoothstep copy for layout only — never extend it.
- Lens keys **retime** with duration and timebase changes, and the retimed tail is clamped to `durationFrames` (rounding + `MIN_GAP` could otherwise push it one frame past and get the upload rejected).
- **The band says what is true right now** — `(driven on device)` with a v2 board, `(authoring + export only — no lens device)` without. `lensDriven` is refreshed on boot, on trigger connect and on disconnect. A permanent "not driven" label would be the app lying in the other direction the moment hardware appeared.

## Lens motors (v0.11 — ADR-0018)

- **The lens device IS the trigger board.** One connection, one `GO`. There is no second port to pick.
- Motor settings live in **`prefs.lens.motors[kind]`** = `{steps, maxStepsPerSec, invert}` — rig configuration, beside the cue bindings, for the reason ADR-0016 gave: a `.graffik` must survive being carried to another rig. `steps` is remembered **only as a hint for the pre-flight**; it is never treated as homing, because only the board knows whether it has seen a stop since power-up.
- IPC: `nmx:lens-status` · `lens-set-motor` · `lens-calibrate` (90 s timeout of its own) · `lens-seek` · `lens-check` · `lens-upload`.
- **`nmx:cues-arm` uploads the lens program BEFORE `ARM`.** `ARM` is what latches it and its reply carries the count the backend cross-checks; uploading after would arm an empty curve.
- **`nmx:cue-check` returns `lensProblems` too, and `armCuesForPass` is one gate for both.** Two gates would be two chances to skip one, and both failures cost the same thing — a take.
- ⌾ Lens… modal layout follows the *workflow*: marks table → add-mark row → **Jog** (drives the barrel and fills the "At" field, so marking is drive-read-type) → MOTOR subhead → device chip + Calibrate + travel → top speed + handedness. The jog was originally down in the motor block, which broke the marking loop and wrapped the Calibrate button onto its own line. `#lensMarkRows` is capped at 190 px and scrolls — a real lens map runs to a dozen marks and the sheet must not outgrow the window.
## The playhead during a pass (v0.18, smoothed in v0.19 — ADR-0025 + its amendment)

- `startPassSweep(engine, durationFrames)` / `anchorPassSweep(percent)` / `endPassSweep()`. **The controller's percent is the truth**; the local tick (a `requestAnimationFrame` loop since v0.19) only smooths between the 500 ms polls, and the extrapolation it draws from is **capped at one poll interval ahead** (`elapsed` clamped to `SWEEP_POLL_MS`), so a stalled controller shows a stalled playhead rather than one that has run ahead of the rig. Never invert that — ADR-0005.
- **A classic pass is not the timeline.** The lanes show the KF move; a 2-point pass is a different move with its own duration. It sweeps (elapsed time is true either way) but in warning amber with the tag `2-POINT PASS · these lanes are not running`, because a normal playhead over those curves would assert a position that is false.

  ![The amber classic-pass playhead sweeping the key-frame lanes, tagged 2-POINT PASS — these lanes are not running](../images/pass-playhead-classic.png)

- **A running playhead is brighter ink, never a series hue.** The first attempt used `--accent`, which is the *same blue as the Slide trace* — the playhead disappeared into its own curve. ADR-0012 already answers it: chrome wears ink.
- Every stop path (`STOP ALL`, the physical e-stop, KF stop) calls `endPassSweep()`. A playhead still moving after a stop asserts motion that has been halted.
- **Smoothness (v0.19).** `requestAnimationFrame`, not `setInterval`; the drawn frame is a **float** (only the readout rounds, and `endPassSweep` restores the grid); and the reading moves a **target** that the drawn position converges on **by adjusting speed, never by assigning position** — so `shownPct` is monotonic and the playhead cannot step backwards. A `Math.min(predicted, …)` clamp did allow exactly that and was caught by measuring, not by reading. Ahead → speed 0 and it waits; behind → speed rises, capped at 3×.
- Do **not** call `syncInputs()` from the sweep tick — it rewrites every rail field to update two labels.
- **How to re-verify** (needs Playwright, which the repo does not depend on — this runs outside it): load `index.html` headless, `startPassSweep(...)`, sample `playheadFrame` on every `requestAnimationFrame`, and drive `anchorPassSweep()` every 500 ms with values that **deliberately disagree** with the extrapolation by ±1%. Then check the per-frame velocity for *backwards steps* and *spikes over 3× median*. Disagreeing readings are the case that snaps; agreeing ones prove nothing.
- Measured: 60 fps, `render()` ≈ 0.74 ms on a six-lane 30 s move, 0 backwards steps, 0 velocity spikes over 3× median. Redrawing less often would have been the obvious wrong fix.
- `followPlayhead()` pans the view when the sweep leaves the visible range.

### Taught limits and a moving origin (v0.24 — ADR-0030)

- `connect()` asks general **119** and **131** **once**, keeps the answers in `origin`, and computes `limitTrust`. Asking 119 twice throws away the only chance to hear it — it is a one-shot latch.
- `effectiveLimits()` is what jog and the jog monitor act on: **voided limits read as `NO_LIMITS`**, which re-arms the ADR-0023 creep cap. `prefs.limits` still holds the numbers — nothing is deleted.
- `nmx:upload-kf` **refuses** while voided. Teaching either bound clears it (`nmx:set-limit-here`), and so does `nmx:trust-limits` — the operator's say-so, on a button.
- `nmx:set-restore-position` writes the controller's EEPROM and is therefore **only ever a button**, never something connect does on your behalf.
- The rail gets **one line**; the sentence, the controller's own answers and both actions are in `#limTrustModal`. The first version was a five-line paragraph in the rail that pushed the pass log off the bottom of the window — the height budget is spent, and measuring caught it.

  ![The limit-trust dialog: the controller reported a power cycle and does not restore position, with the two actions that resolve it](../images/limit-trust.png)

### Plan type (v0.22 — ADR-0028)

- `nmx:arm-move` and `nmx:upload-kf` both send `setProgramMode(PLAN_TYPE.contVideo)`. The KF path previously sent **nothing**, so a pass ran under whatever was last latched.
- `nmx:upload-kf` **reads it back** (general query 118) and returns `{packets, planType, wanted}`; the renderer writes a pass-log line on a mismatch saying that percent complete and every recorded comparison will be skewed. `main` keeps the last read-back for the bring-up report.
- The return shape changed from a number to an object — the renderer accepts both, because an older preload could still be in play during development.

## The flight recorder (v0.21 — ADR-0027)

- **One poll, both jobs.** `nmx:pass-sample` replaced `nmx:kf-progress` / `nmx:progress` in both run loops: the sample the recorder keeps IS the reading the progress bar and the playhead are driven from. Two timers would be two clocks disagreeing about when the pass was.
- Per sample: 2 progress queries + 3 positions + 3 × query 124 = **8 round trips**, and each sample records its own `costMs`. At 19200 baud that is the number to watch; `prefs.trace.checkSending` drops it to 5 once the rig shows 124 is always false during a run.
- `beginRecording` / `endRecording` bracket every pass. **Every stop path closes the recording rather than discarding it** — a stopped pass is the one you want to look at. `endedBy` is `complete` | `stopped` | `lost`.
- Coverage is reported into the pass log the moment a pass ends, and a **backwards percent is said out loud** rather than left in the data.
- On `trace-end` the app reads the **device's own elapsed and its own denominator** (key-frame 121/122, classic general 102/125) and hands over the duration it uploaded, so `timingCheck` can compare them (ADR-0029). The verdict goes to the pass log and, indented under its own pass, into the bring-up report.
- **Overlay: the axis's own hue, dashed and thinner.** Identity belongs to the series (ADR-0012); provenance is style. A recorded Slide in a fifth colour would read as a fifth thing. Direct-labelled `N recorded passes · dashed`, because a dash pattern is not self-explanatory. Capped at 4 shown, and the cap says so when it drops one.
- **`axisScale()` includes the overlays.** A deviation big enough to leave the lane is the most important thing the overlay could show; scaling from the plan alone would draw it outside the box. Same defect as v0.6's invisible taught limits.
- `◉ Passes…` modal (the rail height budget is spent — new configuration goes in a modal): recordings with coverage, overlay/vs-plan/CSV per pass, and a two-pass comparison. Wording comes from `window.trace.deviationLines`, not restated here.

  ![The Recorded passes dialog: each pass with its coverage, set-aside readings and stopped/backwards flags, and a two-pass comparison reporting one axis as a bound rather than a measurement](../images/recorded-passes.png)

  ![Three timeline lanes with a recorded pass drawn over the planned curve in the same hue, dashed, the lane scale grown to contain it](../images/trace-overlay.png)
- **`.sheet` has `max-width: 560px`, which is a CAP** — an inline `style="width:620px"` on a sheet is silently clipped and always has been (three existing dialogs declare widths they never get). Use `.sheet.wide` (760px) instead of writing a width and assuming you got it.

## Bring-up report + creep (v0.16 — ADR-0023)

- `nmx:jog` applies `capUntaughtJog` **before** the limit check — main-side, same reasoning as ADR-0013.
- `nmx:bringup-report` assembles prefs + connection state + the renderer's pass log into one markdown file. The renderer supplies `log` (newest-first, verbatim) and `notes`; main has never seen the pass log.
- Button lives at the bottom of the ⚖ Rig commissioning panel — same session, same purpose.

## Connection doctor (v0.15 — ADR-0022)

- `nmx:list-ports` now returns `{ports:[{path,manufacturer,likelihood,why}], advice}`. The renderer sorts likely-first and **marks** unlikely/never entries rather than hiding them. Both port pickers (rail, cue dialog) tolerate the old array shape.
- `nmx:diagnose` opens its **own** port — it runs after the normal connect has already failed, so there is nothing to reuse and it must not disturb a connection that worked. Failure to *open* short-circuits to its own, more specific diagnosis (something else has the port).
- The **Diagnose… button appears only after a failed connect** and disappears on a successful one. Offering it before there is a problem is clutter nobody reads at the moment it matters.

## Physical controls (v0.14 — ADR-0021)

- **TWO gamepad loops, and the distinction is load-bearing.** The jog loop runs only while gamepad jog is toggled on. The **button loop runs at 40 ms whenever a controller is present** — regardless of the jog toggle, of which dialog is open, or of what has DOM focus. Hanging the e-stop off the jog toggle would have made it work only while jogging, and the moment you most want a physical stop is during a programmed pass.
- `padCfg.buttons[actionId] = {index|null}` in prefs, guarded on load. Binding is **learn-by-pressing** because button indices are not standardised across devices; clicking a bound row's button **unbinds** it.
- `padLearning` blocks the action loop during a capture, so a learn press cannot also fire what it is being bound to.
- **A vanished controller mid-jog now zeroes every axis** and says so. It used to `return` early and leave the last commanded speed running — the firmware watchdog was the only thing stopping it, silently.
- **No `.sheet` may clip its own content** (`max-height` + a scrolling `.body`). Adding the Buttons section pushed the gamepad dialog past its sheet and silently cut off the live-response canvas.
- Watch for **flex children collapsing to zero height**: the hold-progress bar was present, styled, correctly coloured and 0 px tall until it got `flex:none`. Measure the render, do not just look at it.

## Rig commissioning (v0.13 — ADR-0020)

- Reached from **Export 3D… → Measure…**, because that is where an operator is standing when they realise they do not know their steps/mm.
- **The panel carries its own jog buttons AND its own live position readout.** The procedure is jog-to-a-mark, walk away with a tape, come back and type — a dialog covering the rail's jog controls would make the thing it exists for impossible, and jogging blind to the step count is the same failure one layer down. The existing position poll writes `#rigPos{motor}` when present; the rows are rebuilt on every render, so it looks the node up each tick rather than caching it.
- State in `prefs.commission` = `{spans:{slide,pan,tilt}, marked, passes, thresholdMm}` — **the measurements, not just the conclusion**, so "which measurement gave us 160?" stays answerable.
- IPC: `nmx:commission-state` · `-mark` · `-span` · `-drop-span` · `-apply` · `-pass` · `-set`. `readPosition()` is factored out of `nmx:position` so commissioning and the readout cannot drift into asking different questions.
- **`-apply` only touches axes that were measured** and returns the new calibration, which the renderer merges into `exPrefs` via `adoptCalibration()`. Without that merge the export dialog's next keystroke would write its stale copy back over the numbers just measured — invisible until an export came out at the old scale.
- The laser row shows only for pan/tilt; `Measured` defaults flip 500 mm ↔ 90° on axis change, because "500 degrees" is a nonsense default and nonsense defaults eventually get recorded.

## Lens library (v0.12 — ADR-0019)

- Held in **`prefs.lensLibrary`**, guarded on load by running each entry through `validateLensLibraryEntry` and dropping the failures — `prefs.recent` (v0.7.0) is why every sub-object gets a guard.
- IPC: `nmx:lens-library` · `-save` (upsert; generates the id + `savedAt` here so the core stays pure) · `-delete` · `-export` · `-import` (merge, never replace).
- Picker lives in ⌾ Lens…, **filtered to the axis's kind**. Applying a lens takes an `snapshot()` — it edits the move, so ⌘Z must reach it. **Forgetting a lens does NOT touch a lane using it**; the move keeps its marks and the status line says so.
- The save button reads **Keep** for a lens the library has not seen and **Update** for one it has: "I re-marked this lens" and "I have a second similar lens" are different intentions.
- Upload status now reports the lens honestly: point count and estimated upload time with a device, `NOT sent: no lens device` without one, plus the first infeasibility if any.

## Move files vs. export (v0.7.1)

These are **two different commands and must stay that way** — conflating them is what made the first pass confusing.

- **Move file** (`.graffik`, the document): New · Open… · Save · As…, plus `⌘N/⌘O/⌘S/⇧⌘S`. The renderer tracks `filePath` and `dirty`; **Save writes to the current path with no dialog**, Save As always asks, and Save is disabled only when there is a file *and* nothing has changed. Document identity lives in the **status bar** (`• name.graffik`), not the rail — that is where 3D apps put it, and the rail had no room. New/Open confirm before discarding unsaved edits.
- **Export** (`⇧⌘E`) is a separate dialog for handing the move to another application, and it never touches the `.graffik`.

**Failures are raised as a modal dialog by main, not only in the status line** (`reportFailure`). "Your move did not save" is not a status-bar-grade message.

### The v0.7.0 save/open defect

`prefs.recent` was the one preferences sub-object without a type guard in `loadPrefs`, and it is read with `.filter()` by **both** the save and open handlers and nowhere else — so a preferences file carrying anything but an array broke exactly those two commands and left everything else working. Every sub-object is guarded now, and `remember()` (the recent-list update) is wrapped so bookkeeping can never fail a save the operator has already committed to.

## Export dialog (ADR-0015)

Settings live in `prefs.export` — **calibration is a property of the rig, not of the move**, so the same move exported from a re-belted rig gets the new numbers rather than the old ones.

- Format picker over `EXPORT_FORMATS`; each format's `note` is displayed, because every one of them has a caveat and a caveat the operator reads beats one in a commit message.
- Rig calibration (steps/mm, steps/deg ×2, nodal offset, head height, per-axis invert), scene units + up-axis, lens.
- The AE pixels-per-metre row is shown **only** for the AE format — displaying it always would imply the other formats need it.
- **Scale check**: a live readout of what the move actually covers (`slide −40.0 → 177.5 mm · travel 217.5 mm (0.217 m in scene)`). Reading this catches a factor-of-ten calibration error far more reliably than opening the exported file elsewhere does.

## Timecode UI (v0.7 — ADR-0014)

**Whole films cross IPC now**, not `(axes, durationMs)` tuples — one object in, one unit out, so the two processes cannot disagree about units. Every renderer time value is a frame number; `* 1000` in `renderer.js` is a bug by definition.

- **Ruler** ticks step through a ladder built from the shooting rate (`1,2,5,10,r/2,r,2r,5r,…`) so ticks land on whole seconds. Labels print `MM:SS:FF`, or `SS:FF` when zoomed past a second — the hour never changes across a camera move, and printing it costs three characters that collide the labels. Full timecode lives in the playhead chip. Zoom floors at 8 frames across.
- **Playhead** shows both `372f` and `01:00:15:12`; `tcOf(frame)` adds `film.startFrame`.
- **Move panel:** Dur / Cue in frames with a timecode echo line beneath. Rate + Start TC moved to a **modal** (`TC` button in the panel header) — see the rail-budget note above; the rate is always visible as a status-bar chip instead.
- **Inspector:** Frame + Pos on one row, editable absolute **TC** field + delete on the next. Typed TC subtracts `startFrame` to get the move-relative frame; a bad or drop-frame-skipped timecode surfaces the core's error message in the status line.
- **Timebase change RETIMES** the move (`retimeFrames` on duration, cue, startFrame, every keyframe, playhead) so the rig does exactly what it did before over the same real seconds, then marks the upload stale. Keeping frame numbers instead would silently change a move already matched to a performance.
- **Everything snaps to whole frames:** drag, capture (replace window = ±½ second of frames), arrow nudge (1 frame, ⇧ = 1 second). `MIN_GAP = 1` frame between neighbouring keys.
- The browser-preview stub carries a **minimal non-drop `window.tc`** so `index.html` still opens standalone for design work. It is unreachable under Electron; never extend it into a second implementation.

## v0.6 UI additions

- **Soft-limits rail panel** — per axis: numeric min/max readout (`—` when untaught), set-min/set-max-from-here buttons, clear. `nmx:limit-hit` flashes the axis row and writes a pass-log line.
- **Forbidden zones on the timeline.** `axisScale()` grows each track's y-range to *include* taught limits — capped at 60% of the move's own span per side so a distant bound can't squash the curve flat. Inside the view, the zone beyond a bound is shaded and the bound drawn as a dashed hairline; still off-scale (i.e. huge headroom, not a hazard) it becomes a **faint hairline pinned to the track edge**, deliberately weaker so "bound exists, far away" never reads as "forbidden here". Before this, auto-scaling on data alone made a limit invisible whenever it sat more than 15% outside the move — the case where the reassurance matters most (found by rendering the UI headless and looking at it, 2026-08-17).
- **Gamepad settings modal** — per-axis binding rows with a **"bind…" learn mode** (captures whichever stick moves past 0.5, so the user never has to know axis indices — controller axis numbering is not standardized across pads), invert checkbox, and ballistics sliders (deadzone / curve / max speed) over a **live response-curve canvas** that redraws as you drag. Writes through `setPrefs`.
- **Shortcut overlay** (`?`) — grouped key table. Both modals share `.modal/.sheet` styling and close on Esc / backdrop click; Esc handling is centralized so it can't fight the e-stop binding.

## Known gaps (intentional)

Per-axis classic arm params; KF `updateRateMs` not exposed; no per-keyframe easing/tangent handles (the solver picks velocities — ADR-0009); no panel resizing/docking; no light theme; a 7th lane would need scrolling tracks — six is the height budget; limits are per-axis boxes, not a swept-volume/collision model; **no lens motor has ever turned** — protocol v2 ships and is parity-checked against the reference firmware (ADR-0018), but HARDWARE-BRINGUP Phase 7 is unrun. *(This paragraph was stale until v0.19: it still claimed there was no lens motor driver, no lens library and no gamepad button bindings, all three of which shipped in v0.11/v0.12/v0.14.)* (Simulator animates progress +20%/poll so demo passes complete — see nmx-protocol digest.)
