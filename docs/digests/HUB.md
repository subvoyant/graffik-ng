# Graffik NG — Knowledge Hub

**Purpose:** read this file first; then read only the digest(s) for what you're touching. This replaces re-reading source for orientation. Trust digests for the map; verify against source before changing a detail. Update digests in the same change that alters behavior (ADR-0000).

**Project:** modern TypeScript/Electron software driving the Dynamic Perception NMX 3-axis motion controller for repeatable multi-pass camera moves ("multiplicity") — a maintained successor to the abandoned Graffik apps. MIT, fresh-from-spec (ADR-0003). First milestone: jog → record → replay identical passes.

## System map

```
graffik-ng/
├── packages/nmx-protocol/     # headless core — ALL protocol knowledge (zero runtime deps)
│   └── src/ packet.ts | commands.ts | client.ts | spline.ts | move.ts | film.ts | simulator.ts
│   └── test/ 53 tests: byte-exact vs firmware samples + e2e vs simulator
├── packages/nmx-cli/          # headless runner: ports/info/run/stop for .graffik files
├── apps/jog-slice/            # Electron app (main.js / preload.cjs / index.html / renderer.js)
│                              # jog + gamepad · timeline editor (undo/select/nudge) · 2-point pass
│                              # camera trigger · pass log + cue countdown · save/load · fw gate
│                              # `npm run dist` → unsigned .dmg (electron-builder)
├── .github/workflows/ci.yml   # test matrix (ubuntu+macos) + unsigned dmg artifact on main
└── docs/ adr/ (why, 0000-0010) + digests/ (how) — you are here
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

## Digest index

| Digest | Covers | Verified against |
|---|---|---|
| [nmx-protocol.md](nmx-protocol.md) | packet codec, command vocabulary, client/transport, spline solver, move builder, film schema, simulator (+physics) | `packages/nmx-protocol/src/*` @ 2026-08-17 |
| [jog-slice.md](jog-slice.md) | Electron app, IPC channel table, editor interactions, packaging | `apps/jog-slice/*` @ 2026-08-17 |
| [nmx-cli.md](nmx-cli.md) | headless runner commands + gaps | `packages/nmx-cli/cli.js` @ 2026-08-17 |
| [reference-repos.md](reference-repos.md) | external ground truth: firmware, official apps, PDFs — where every fact lives | upstream clones @ 2026-08-15 |

## Current state & next steps (update every session)

- **Done (v0.4, 2026-08-17):** v0.3.1 verified on owner's Mac (all tracks render; retina DPR layout bug fixed; zero-scroll layout). Then three hardware-free tracks: **camera trigger slice** (sub-addr 4 IPC + UI + sim state); **editor polish** (undo/redo ⌘Z, keyframe selection + inspector w/ numeric entry, arrow-key nudge); **sim physics** (`tick()` — jog moves live positions in demo); **nmx-cli** (ports/info/run/stop, verified end-to-end vs sim); **packaging** (`npm run dist` → unsigned dmg) + LICENSE/CONTRIBUTING/.gitignore + **GitHub Actions CI** + git history initialized. 53 core tests green. Parity: jog ✔ 2-point ✔ keyframes ✔ save/load ✔ joystick ✔ camera ✔; open: SMS/timelapse modes (deferred), multi-controller, timeline zoom, signing/notarization (needs Apple Developer ID).
- **NEXT:** first real-hardware contact — connect NMX, report firmware version; KF vs classic replay-fidelity test (ratifies ADR-0006); user pushes repo to GitHub org (git history is ready); add Apple ID signing env to packaging.
- Cross-session memory also lives in the Claude project docs: `claude/graffik-ng-decisions.md` (running log), `claude/graffik-ng-hub.md` (this hub, mirrored), `claude/phase0-codebase-reality-report.md` (recon).

## Maintenance rules (the operating model — short version)

- Behavior/API/invariant changed → update the module digest + this hub's map/state **in the same commit**; refresh the "Verified against" stamp.
- New load-bearing decision → new ADR (next number), add to `docs/adr/README.md` index; never edit Accepted ADRs — supersede.
- Keep digests token-lean: facts, invariants, gotchas, pointers — no code dumps, no secrets, no narratives.
- Session end: update "Current state & next steps" here and the project decision log.
