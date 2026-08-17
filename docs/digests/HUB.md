# Graffik NG — Knowledge Hub

**Purpose:** read this file first; then read only the digest(s) for what you're touching. This replaces re-reading source for orientation. Trust digests for the map; verify against source before changing a detail. Update digests in the same change that alters behavior (ADR-0000).

**Project:** modern TypeScript/Electron software driving the Dynamic Perception NMX 3-axis motion controller for repeatable multi-pass camera moves ("multiplicity") — a maintained successor to the abandoned Graffik apps. MIT, fresh-from-spec (ADR-0003). First milestone: jog → record → replay identical passes.

## System map

```
graffik-ng/
├── packages/nmx-protocol/     # headless core — ALL protocol knowledge (zero runtime deps)
│   └── src/ packet · commands · client · spline · move · film · limits · timecode · export3d · trigger · simulator
│   └── test/ 159 tests: byte-exact vs firmware samples + e2e vs simulator + timecode/DF + export
├── packages/nmx-cli/          # headless runner: ports/info/run/stop for .graffik files
├── apps/jog-slice/            # Electron app (main.js / preload.cjs / index.html / renderer.js)
│                              # jog + configurable gamepad · timeline editor (zoom/undo/select/nudge)
│                              # 2-point pass · keyframe pass · camera trigger · pass log + cue countdown
│                              # soft limits · preferences · move files (new/open/save/as) · 3D export · fw gate
│                              # `npm run dist` → unsigned .dmg (electron-builder)
├── firmware/graffik-trig/     # reference Arduino trigger firmware (GRAFFIK-TRIG v1, ADR-0016)
├── .github/workflows/ci.yml   # test matrix (ubuntu+macos, `npm ci`) + unsigned dmg artifact on main
└── docs/ adr/ (why, 0000-0016) + digests/ (how, you are here)
    + DEVELOPMENT.md (setup/daily-loop/troubleshooting)
    + HARDWARE-BRINGUP.md (first-contact + repeatability + rig calibration) + images/
```

Dataflow: renderer (vanilla JS UI) → `window.nmx` (preload contextBridge) → IPC → main process → `NmxClient` → `PortLike` (real `SerialPort` @19200 8N1, or `SimulatedNmx`) → NMX firmware, which **executes moves itself** (ADR-0005).

## Load-bearing invariants (memorize these)

1. Packet = `00x5 FF` header · address (default **3**; broadcast **1**) · sub-address (0 gen / 1–3 motors / 4 camera / 5 key-frame) · command · length · **big-endian** payload.
2. USB serial is **19200 baud** — firmware `USBSerial.begin(19200)`; must be set explicitly.
3. Queries are commands **≥100**; sets/actions ack `0x01/0x00`. Query "floats" are **fixed-point ×100 longs** — divide by 100.
4. **One command in flight**; responses match FIFO. Never await a broadcast (nodes never reply). Jog-speed (motor cmd 13) gets **no reply** while joystick/Graffik mode is on.
5. Command numbers come **only** from the 2018 firmware dispatch (ADR-0004) — older refs disagree (prog-mode 22 not 0x22; motor 10 = end-limit-here; motor send-to-start 23 not 25).
6. `handshake()` = query firmware version (expect **v70**) + Graffik mode on. Arm the **joystick watchdog** (gen cmd 14) before any jogging.
7. E-stop = broadcast stop (cmd 2) + KF-stop (cmd 8); `NmxClient.stopAll()` flushes the queue first and jumps the line.
8. KF uploads end each axis with `endTransmission` (KF cmd 16) or the program silently isn't finalized.
9. No GPL code may be pasted/ported in (ADR-0003) — reference repos are for *facts* only.
10. Renderer never touches serial/Node; hardware ops only via the IPC surface (ADR-0007).
11. Motion math has ONE owner: core `computeVelocities`/`splineAt` feed both the editor preview and the firmware upload (ADR-0009). Never duplicate it in the UI.
12. Programmed moves are firmware-gated (v70) with explicit override only; jog speed hard-clamped ±4000 steps/s; cue countdown is host-side for both engines.
13. Soft limits are enforced in the MAIN process (jog request + 90ms monitor + pre-upload validation), never the renderer (ADR-0013). Motion away from a violated bound must always stay allowed.
14. **Frames are the authoring unit; milliseconds exist only at the protocol boundary** (ADR-0014). Rates are exact rationals — 23.976 is 24000/1001, never the decimal. Drop-frame is legal only at 29.97/59.94. Conversion happens in `filmDurationMs`/`filmCueMs`/`filmAxesToMs` and nowhere else.
15. 3D export samples the SAME solver as the upload, once per frame, and states its own `metersPerUnit`/`upAxis` (ADR-0015). Steps→mm/deg needs a calibration MEASURED on the rig; without it an export is a shape, not a camera move.
16. Anything that must be identical between passes cannot be timed by the host (ADR-0016, and ADR-0005 again). Host-scheduled cues are ±20 ms and non-repeatable; frame-exact cues must be uploaded to a device and triggered once.
17. UI uses design tokens only — **no literal hex in new UI** (ADR-0012). Axis colors are validated for colorblind separation; a new series color comes from the next validated categorical slot, never invented.

## Digest index

| Digest | Covers | Verified against |
|---|---|---|
| [nmx-protocol.md](nmx-protocol.md) | packet codec, command vocabulary, client/transport, spline solver, move builder, timecode, film schema + events, 3D export, simulator | `packages/nmx-protocol/src/*` @ 2026-08-17 (v0.7.1) |
| [jog-slice.md](jog-slice.md) | Electron app, IPC channel table, move files vs export, timecode UI, prefs, limit enforcement, gamepad ballistics, editor interactions, packaging | `apps/jog-slice/*` @ 2026-08-17 (v0.7.1) |
| [nmx-cli.md](nmx-cli.md) | headless runner commands + gaps | `packages/nmx-cli/cli.js` @ 2026-08-17 |
| [../HARDWARE-BRINGUP.md](../HARDWARE-BRINGUP.md) | first-contact sequence, repeatability method, ADR-0006 shootout, safe-limits worksheet | written pre-hardware @ 2026-08-17 |
| [reference-repos.md](reference-repos.md) | external ground truth: firmware, official apps, PDFs — where every fact lives | upstream clones @ 2026-08-15 |

## Current state & next steps (update every session)

- **Done (v0.7, 2026-08-17):** **Timecode everywhere** (ADR-0014) — `.graffik` v2 stores frames + an exact-rational timebase + start timecode; SMPTE display and entry throughout (ruler, playhead, inspector, duration, cue, classic travel); drop-frame supported and refused where it is undefined; changing the rate retimes the move; v1 files migrate at an assumed 24 fps with the assumption written into the file. Timecode is bridged synchronously into the renderer by preload so there is still exactly one implementation. **3D camera export** (ADR-0015) — OpenUSD `.usda` primary (states its own `metersPerUnit`/`upAxis`/`timeCodesPerSecond`, exports the rig hierarchy rather than a flattened matrix) plus `.chan`; sampled once per frame from the same solver as the upload; scale comes from a `RigCalibration` measured on the rig. Alembic deliberately not written — no pure-JS Ogawa writer, and our USD converts downstream. **Timeline events** (ADR-0016) — schema, validation, `buildCueList` (device/Tier 2) and `eventsInWindow` (host/Tier 1). 122 tests.
- **Done (v0.6, 2026-08-17):** **Soft travel limits** (ADR-0013) — taught by jogging, stored in prefs, enforced main-side at three points (jog request, 90ms jog monitor, pre-upload film validation), forbidden zones shaded on the timeline; core predicates unit-tested (57 tests). **Preferences persistence** (`userData/preferences.json`): window bounds, last port (remembered, never auto-connected), jog speed, limits, gamepad config, recent files. **Gamepad bindings + ballistics** — per-axis control mapping with a "bind…" learn mode that captures whichever stick moves, invert per axis, configurable deadzone / response curve / max-speed scaling, with a live response-curve plot. **Shortcut overlay** (`?`). Then a headless-render verification pass (Chromium + the browser-preview stub) caught three defects the code review had not: taught limits were **invisible** on the timeline whenever they sat >15% outside the move (auto-scale ignored them); the rail overflowed once a keyframe was selected; the last ruler label rendered clipped. All three fixed, and the **fresh README screenshot** was generated from that same render rather than asked of the owner.
- **Done (v0.5, 2026-08-17):** **UI redesigned to the professional-3D-application idiom** (ADR-0012) — token-based dark neutral palette, recessed inputs, app-bar/rail/stage/status-bar frame, diamond keyframes, **drag-scrub numeric fields**, **timeline zoom/pan**, selected-key inspector, live position readout. Axis colors replaced with the **validated** categorical palette after the originals failed colorblind separation (Pan↔Tilt ΔE 6.6 deutan). Renderer gained a **browser-preview stub** so `index.html` opens standalone for design/screenshots. vitest → ^4 (audit: 5 vulns incl. 1 critical → **0**). `docs/HARDWARE-BRINGUP.md` written pre-hardware: first-contact sequence, 5-pass repeatability method with pass/fail thresholds, the ADR-0006 engine shootout, and a safe-limits worksheet.
- **Done (v0.4, 2026-08-17):** v0.3.1 verified on owner's Mac (all tracks render; retina DPR layout bug fixed; zero-scroll layout). Then three hardware-free tracks: **camera trigger slice** (sub-addr 4 IPC + UI + sim state); **editor polish** (undo/redo ⌘Z, keyframe selection + inspector w/ numeric entry, arrow-key nudge); **sim physics** (`tick()` — jog moves live positions in demo); **nmx-cli** (ports/info/run/stop, verified end-to-end vs sim); **packaging** (`npm run dist` → unsigned dmg) + LICENSE/CONTRIBUTING/.gitignore + **GitHub Actions CI** + git history initialized. 53 core tests green. Parity: jog ✔ 2-point ✔ keyframes ✔ save/load ✔ joystick ✔ camera ✔; open: SMS/timelapse modes (deferred), multi-controller, timeline zoom, signing/notarization (needs Apple Developer ID).
- **Done (v0.7.1, 2026-08-17):** Split **move files** (New/Open/Save/Save As on the `.graffik` document, with dirty tracking and a real current-file path) from **3D export** (its own dialog, `⇧⌘E`) — conflating them was the confusion. Export dialog carries the rig calibration, scene units, up-axis, lens and a **live scale check**. Export targets: USD, Alembic+FBX via a generated Blender script, After Effects keyframe data, Nuke `.nk`, `.chan`, CSV. Fixed the v0.7.0 save/open defect: `prefs.recent` was the only unguarded preferences sub-object and both handlers read it. Save/open/export failures now raise a modal dialog, not just a status line. 134 tests.
- **Done (v0.8, 2026-08-17):** **Cue system live** (ADR-0016). Core `trigger.ts`: `TriggerBackend` seam, `SimulatedTriggerBackend`, `SerialTriggerBackend` speaking GRAFFIK-TRIG v1 over `PortLike`, `SimulatedTriggerDevice` (the device side, so Tier 2 timing is tested without a board), and `CueScheduler` with injected time — deterministic, and it reports `worstJitterMs()` so the Tier-1 caveat is measured rather than asserted. **Reference Arduino firmware** in `firmware/graffik-trig/` (non-blocking pulses, GPI edges, ABORT clears everything). **Cue lane on the timeline** above the axes, frame-snapped, with a context inspector shared with keyframes and a ⚡ Cues… modal for the device and target bindings. Cues are pre-flighted and armed before a pass and started with it. **`stopAll()` now aborts cues first, independently of the NMX** — the ADR-0016 safety gap is closed. 159 tests.
- **NEXT (software):** DMX (Enttec USB Pro over `serialport`) and OSC (`node:dgram`) backends — neither needs a new dependency; MIDI last, since every Node binding is native. Then sustained-cue editing (drag the tail), cue duplication, and a cue column in the pass log with measured jitter per pass.
- **NEXT (all hardware-gated):** first real-hardware contact — connect NMX, report firmware version (`docs/HARDWARE-BRINGUP.md` Phase 1); KF vs classic replay-fidelity test (ratifies ADR-0006); **tune the soft-limit margins** (250 ms lookahead / 90 ms poll are estimates — Phase 2); measure payload/speed ceilings with the cinema package on the slider; **measure the rig calibration** (steps/mm, steps/deg, nodal offset) — ADR-0015 export is untrustworthy until this exists. Hardware-free backlog: tagged release with .dmg, Windows CI job, Apple Developer ID signing/notarization env, gamepad **button** bindings (e-stop on a button).
- **Rail height budget is spent** — the next always-visible rail panel breaks the no-page-scroll rule. New configuration goes in a modal (see jog-slice digest).
- Cross-session memory also lives in the Claude project docs: `claude/graffik-ng-decisions.md` (running log), `claude/graffik-ng-hub.md` (this hub, mirrored), `claude/phase0-codebase-reality-report.md` (recon).

## Maintenance rules (the operating model — short version)

- Behavior/API/invariant changed → update the module digest + this hub's map/state **in the same commit**; refresh the "Verified against" stamp.
- New load-bearing decision → new ADR (next number), add to `docs/adr/README.md` index; never edit Accepted ADRs — supersede.
- Keep digests token-lean: facts, invariants, gotchas, pointers — no code dumps, no secrets, no narratives.
- Session end: update "Current state & next steps" here and the project decision log.
