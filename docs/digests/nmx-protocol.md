# Digest: @graffik-ng/nmx-protocol

**Verified against** `packages/nmx-protocol/src/*` @ 2026-08-17 (v0.4) · 53 tests green · zero runtime deps · MIT

## packet.ts — codec

- `PACKET_HEADER` = `00 00 00 00 00 FF`; `DEFAULT_ADDRESS=3`, `BROADCAST_ADDRESS=1`; `SubAddress` enum (General 0, Motor1-3, Camera 4, KeyFrame 5).
- `encodePacket({address, subAddress, command, payload})` → header + 4 bytes + payload; payload ≤254; throws RangeError on out-of-range bytes.
- `be` helpers: `u8/i16/u16/u32/i32/f32/concat` — ALL big-endian (f32 = IEEE754 BE, matches firmware `ntof`).
- `ResponseParser` — streaming: `push(chunk) → Packet[]`; scans for header, tolerates leading garbage, keeps partial-header tail, handles multiple packets per chunk. Response frames from device carry master address (addr 0 in practice; parser doesn't filter by address).

## commands.ts — vocabulary

Namespaces returning `Packet`: `general` (sub 0), `motors` (1–3, `Motor = 1|2|3`), `cam` (4), `keyFrame` (5), `broadcast` (addr 1). Every command has a provenance tag in its doc comment: `[S]`ample-packets / `[F]`irmware-dispatch / `[R]`eboot-app. Header comment documents the version-drift traps (see hub invariant 5). Key entries for the multiplicity flow: `general.setGraffikMode(50)`, `setJoystickWatchdog(14)`, `setJoystickMode(23)`, `setProgramMode(22)`, `setStartDelay(21)`, `setStartHere(26)`/`setStopHere(27)` (all axes at CURRENT pos — the jog-to-set primitive), `sendAllToStart(25)`, `startProgram(2)`/`pause(3)`/`stop(4)`; `motors.setContinuousSpeed(13, f32 signed)`, `move(15)`, `setTravel(20)`, `setProgramAccel/Decel(21/22)`, `setEasing(18: 1 lin/2 quad/3 inv-quad)`, `queryPosition(106)`; `keyFrame.setAxis(10, i16 0-based)`, `setKeyFrameCount(11)`, `setNextAbscissa/Position/Velocity(12/13/14, f32)`, `setContinuousVideoTime(17, i32 ms)`, `endTransmission(16)`, `run/pause/stop(20/21/22)`, `takeUpBacklash(23)`, `queryRunState(120)`, `queryPercentComplete(123)`; `broadcast.stop(2)`/`kfStop(8)` = e-stop.

## client.ts — transport

- `PortLike` = `{write(data, cb?), on("data", fn)}` — the seam; real SerialPort, SimulatedNmx, or future BLE all satisfy it.
- `NmxClient(port, {timeoutMs=500})`: FIFO queue, one in-flight, response resolves oldest pending; timeout rejects and pumps on.
- Fire-and-forget (resolves `null`, no wait): any packet to address 1; motor cmd 13 while client believes joystick/Graffik mode on (tracked from sent packets: gen 50, gen 23, bcast 5).
- `stopAll()`: rejects in-flight + queued with "aborted by stopAll", then sends broadcast stop + kfStop. The only queue-jumping path.
- `query(packet)` → `decodeResponse(payload)`: 1-byte payload = ack boolean; else `<type><value>` with types 0 byte/1 u16/2 i16/3 i32/4 u32/5 fixed-point÷100/6 string.
- `handshake(client)` = queryFirmwareVersion → setGraffikMode(true); returns decoded version (expect 70).

## spline.ts + move.ts — key-frame moves

- `computeVelocities(points)`: endpoints 0; interior skipped if extreme/plateau/caller-set; else bisection (60 iters, hi = 4× avg neighbor slope) for max velocity that doesn't reverse the Hermite segment (100-sample derivative sign check), final ×0.995 back-off. Times must be strictly increasing.
- `splineAt(points, x)` — Newton-form cubic Hermite, clamped, per-segment; same math the firmware evaluates from xn/fn/dn.
- `buildKeyFrameMove(axes, {videoTimeMs, updateRateMs?})` → Packet[] in the official app's order per axis: setAxis → count → videoTime → all abscissas → all positions → all velocities → endTransmission. `runSequence()` = [takeUpBacklash, run].
- Axis indices here are **0-based** (KF engine), unlike motor sub-addresses (1-based). Positions in steps; abscissas in ms (video mode).

## simulator.ts — SimulatedNmx

- Implements `PortLike`; parses writes, replies per firmware semantics (ack/typed/silent-broadcast/silent-jog-in-mode). State: positions/start/stop points, enabled, jogSpeeds, graffik/joystick/watchdog flags, programMode, kf axes {count,xn,fn,dn}, kfRunState, firmwareVersion=70. `received: Packet[]` log for assertions.
- NOT a physics model — moves teleport; no timing. Good for: command sequences, framing, queue behavior, UI demo mode. Bad for: fidelity/timing questions — those need hardware.
- Progress IS animated for demo UX: each progress query (gen 123 / KF 123) advances `progressPerPoll` (20%); at 100% the run ends and (classic) positions land on stop points.
- **Physics (v0.4):** `tick(dtMs)` integrates jogSpeeds→positions (only for enabled motors) — deterministic for tests; `startPhysics(intervalMs=50)`/`stopPhysics()` run it on a timer for the app's demo mode. Camera state tracked: `camEnabled/camExposures/camTriggerMs/camIntervalMs` (sub-addr 4 handler).

## film.ts — move persistence (ADR-0010)

- `Film` schema: `{format:"graffik-ng-move", version:1, name, durationMs, startDelayMs, engine:"classic"|"keyframe", axes:[{axis:0|1|2, points:[{time,position,velocity?}]}], savedAt?, notes?}`.
- `serializeFilm`/`deserializeFilm`/`validateFilm` — strict, human-readable errors (they surface in UI); refuses future versions; times strictly increasing and within 0..durationMs; ≥2 points/axis. `newFilm(name?, durationMs?)` = blank 3-axis document. Omitted `velocity` = auto-solve at upload time.

## Gotchas

- TS ≥5.9 `Uint8Array<ArrayBuffer>` generics: helper params annotated plain `Uint8Array` deliberately.
- Two tests intentionally deviate from `Sample Commands.txt` (stale) — comments explain; don't "fix" them back.
- ESM package (`"type": "module"`); imports use `.js` extensions; build via `tsc` → `dist/`.
