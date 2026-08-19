# Digest: @graffik-ng/nmx-protocol

**Verified against** `packages/nmx-protocol/src/*` @ 2026-08-19 (v0.15) · 324 tests green · vitest ^4 (audit clean) · zero runtime deps · MIT

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

## timecode.ts — timebase + SMPTE (ADR-0014)

- **The invariant:** frames are the authoring unit; ms exist only at the protocol boundary. If you write `* 1000` outside `film.ts`'s boundary helpers, stop.
- `Timebase {num, den, dropFrame}` — **exact rationals**, never decimals (23.976 = 24000/1001; the rounded decimal drifts ~3.6 ms/1000 frames). `TIMEBASES` presets, `DEFAULT_TIMEBASE` = 24.
- `nominalRate` = the integer timecode counts in (30 for 29.97) — NOT the real rate; that mismatch is why drop-frame exists. `fpsDecimal` is display-only.
- Drop-frame legal **only** at 30000/1001 and 60000/1001 (`isDropFrameLegal`); `validateTimebase` throws otherwise. At 23.976 the correction is 14.4 frames/10 min — not whole — so no DF standard exists.
- DF math is all integer: `drop = nominal/15` (2 or 4), `per10Min = nominal*600 − 9*drop`, `perMin = nominal*60 − drop`. Semicolon before frames marks a DF count.
- `timecodeToFrames` **rejects** timecodes DF skips (`00:01:00;00`) — they do not exist, and accepting one hides a typo. Accepts `HH:MM:SS:FF`, `MM:SS:FF`, `SS:FF`, and a bare integer.
- `retimeFrames(f, from, to)` preserves REAL TIME across a timebase change — the rig's behaviour is what must not move.

## film.ts — move persistence (ADR-0010, ADR-0014, ADR-0016, ADR-0017, ADR-0018)

- **v4 schema (frames):** `{format, version:4, name, timebase, durationFrames, cueFrames, startFrame, engine, axes:[{axis, points:[{frame,position,velocity?}]}], lensAxes?, events?, savedAt?, notes?}`. `startFrame` = timecode of frame 0, so a move lines up with the camera.
- **Protocol boundary — the only place ms appear:** `filmDurationMs`, `filmCueMs`, `filmAxesToMs`. Rounding is ≤0.5 ms on an absolute abscissa, so it cannot accumulate.
- `migrateFilm` v1→v2 assumes **24 fps** (v1 carried no timebase), preserves real duration exactly, and writes the assumption into `notes` rather than hiding it.
- Validation: whole-frame keyframes, strictly increasing, within 0..durationFrames, ≥2 points/axis, legal timebase. Errors are operator-facing sentences.
- `migrateFilm` v2→v3 only ADDS optional `lensAxes`; **v3→v4 REMOVES `lensAxes[].invert`** (ADR-0018 §5 — motor handedness is rig config, not part of a move) and writes the fact into `notes`, the same idiom as the v1→v2 timebase assumption. Versions go up even for additive changes so an older build **refuses** the file rather than opening it with the focus pull silently gone.
- `buildLensProgram(film, {toleranceUnits?, motorSteps?})` — the lens counterpart to `buildCueList`, and it lives beside it because both cross the frames→ms boundary. Samples per frame from the shared solver, quantises to 0..65535, then **decimates** under an explicit vertical error bound (half a motor step by default): 1731 dense points → ~132 for a three-lane 24 s move. `lensProgramSize` reports the total. Peak rate is taken from the **dense** curve so decimation cannot hide a snap from the pre-flight.
- `validateLensAxes(film)` rejects duplicate kinds (one focus lane, not two).
- **Events (ADR-0016):** `FilmEvent {id, frame, durationFrames?, target, action, label?}`; `target` is a LOGICAL name so files stay portable between rigs. `buildCueList(film)` → device cue list in ms, sorted (Tier 2); `eventsInWindow(film, from, to)` → host dispatch, upper bound exclusive (Tier 1).

## export3d.ts — 3D camera export (ADR-0015)

- `sampleLens(film)` → `LensTrack {focusMeters|null, fStop, focalLengthMm, unmapped}`. The USD camera prim carries animated `focusDistance` (converted by `metersPerUnit`), `focalLength`, `fStop`. An **unmapped** axis is NOT exported — a travel fraction is not a focal length — and the doc string carries a `NOT EXPORTED: …` note instead. CSV carries **both** travel fraction and mapped value.
- `sampleRig(film, calibration)` → one `RigPose {frame, slideMm, panDeg, tiltDeg}` **per frame**, via `computeVelocities`/`splineAt` — the same solver the controller runs (ADR-0009). Never write a second interpolation for export.
- `RigCalibration` is **measured on the rig**, not guessed: `slideStepsPerMm`, `panStepsPerDeg`, `tiltStepsPerDeg`, per-axis inverts, `nodalOffsetMm` (tilt axis → entrance pupil; ignoring it is why CG slides against a plate on tilts), `headHeightMm`.
- `exportUsda` — writes `metersPerUnit` + `upAxis` + `timeCodesPerSecond` explicitly (USD's own fallbacks are 0.01/Y). Exports the **mechanism** — Carriage(translate) → Pan(rotate about up) → Tilt(rotate X) → Camera(nodal offset) — not a flattened matrix.
- `exportChan` — `frame tx ty tz rx ry rz vfov`, tilt in rx, pan in ry, rz always 0 (no roll axis). Carries no metadata at all, so the importing camera **must be set to YXZ rotation order** (Nuke defaults to ZXY).
- `exportNukeScript` — a `Camera3` node with `rot_order YXZ` and baked `{curve x<start> …}` knobs. Carries its own rotation order and lens, so unlike `.chan` it cannot be imported wrong; prefer it whenever pasting is acceptable.
- `exportAfterEffects` — AE "Keyframe Data" clipboard text. **AE has no real-world units** (its 3D space is pixels), so it needs an explicit `pixelsPerMeter` — a creative decision about world scale, made visible rather than buried in a constant. AE's Y points down and its camera looks down +Z, so the signs differ from the USD path deliberately.
- `exportCsv` — one row per frame in steps AND mm/degrees AND scene units, so a unit mismatch is visible in one file.
- `alembicConverterScript(usdaName)` — a Blender headless script (`blender --background --python …`) that turns the exported USD into `.abc` and `.fbx`. The honest bridge to Alembic rather than a native dependency.
- `moveExtents(film, cal)` → per-axis `{min,max,range}` in mm/degrees. Drives the export dialog's scale check; a factor-of-ten calibration error shows up here before it reaches another application.
- `EXPORT_FORMATS` — the export menu: `usda · abc · ae · nk · chan · csv`, each with an operator-facing `note`.
- **No Alembic:** Ogawa has no maintained pure-JS writer; converting our USD downstream is one `usdcat` away and keeps the core dependency-free.

## lens.ts — focus / iris / zoom (ADR-0017)

- **A lens position is a fraction of barrel travel, 0..1 — never a distance.** Raw motor steps mean nothing outside that motor on that lens on that day; the travel fraction is stable. Real units come from a **lens map**: witness marks pairing a travel fraction with what the barrel reads there. This is the Preston FI+Z model — calibrate to the mechanical stops, then record motor position at a handful of marked distances.
- `LensAxis {kind:"focus"|"iris"|"zoom", target, keys:[{frame,position,velocity?}], map?, invert?}`. Units by kind: focus **metres**, iris **T-stop**, zoom **mm** (`LENS_UNITS`).
- `lensValueAt(map, position)` interpolates **linearly between adjacent marks** and **clamps outside** them — a focus scale is grossly non-linear, so a global fit is wrong everywhere, and extrapolating past the last mark is inventing data. `lensPositionFor` is the inverse and handles a **descending** mark list (iris usually is).
- `formatLensValue(axis, position)` returns `"42%"` when there is no map. It never fabricates a distance.
- `sampleLensAxis(axis, durationFrames)` calls `computeVelocities`/`splineAt` — the SAME solver as motion (ADR-0009) — then clamps to 0..1. No second easing implementation exists.
- `validateLensMap` (≥2 marks, positions in 0..1, strictly increasing) / `validateLensAxis` (whole frames, increasing, in range, ≥2 keys). `newLensAxis` starts flat at mid-travel.
- **There is deliberately no `invert` on a `LensAxis`** (ADR-0018 §5). The move describes the BARREL; motor handedness is rig config in preferences, declared to the board with `LAXIS`, and applied by the firmware at its DIR pin. Nothing between the two flips anything — not display, not export, not the wire program.
- `decimateLensPoints(points, tol)` — Douglas–Peucker with a **VERTICAL** error metric, iterative not recursive. Perpendicular distance would mix ms and travel units into one number whose answer changes with your choice of time unit; vertical distance bounds exactly "how far the device's linear interpolation can be from the spline", in the units the wire uses. **The firmware may only interpolate linearly** — the bound is stated against that.
- `lensPeakRate` / `lensFeasibility(program, limits)` — the pre-flight. Flags a lane with no motor, an uncalibrated barrel, and a pull that outruns the motor's measured top speed (naming the axis, the speed and the moment). `lensToleranceForSteps` derives the bound from calibrated travel; `DEFAULT_LENS_TOLERANCE_UNITS` = 32 when uncalibrated.

### The lens library (ADR-0019)

- `LensLibraryEntry {id, name, kind, marks, notes?, savedAt?}` + a versioned `.graffiklens` file (`LENS_LIBRARY_FORMAT`/`_VERSION`). `serializeLensLibrary` / `parseLensLibrary` refuse somebody else's JSON and a newer version rather than guessing (same discipline as ADR-0010/0004).
- **Merge matches on `id`, never on name.** Two people call a lens "35mm" and mean different glass; the same lens renamed is still the same lens. `lensLibraryId(kind, name, salt)` makes readable derived ids — the salt is the caller's, so the core stays pure.
- `mergeLensLibrary(existing, incoming)` → `{merged, added, updated, rejected}`. **A malformed entry does NOT sink the import** — the survivors go in and the casualties are named. Deliberately the opposite of a move file: a move is one indivisible thing, a library is a collection. `merged` is always sorted by kind then name so a picker is readable.
- `validateLensLibraryEntry` delegates to `validateLensMap` — an entry that would be rejected as a map cannot be used, and finding that out at apply time is too late.
- `lensEntryToMap` / `lensMapToEntry` **copy** their marks; mutating one must not reach the other.

## diagnose.ts — the connection doctor (ADR-0022)

- **Silence vs noise is the whole point.** Zero bytes = nothing is talking to us (power, cable, BLE mode, wrong port). Bytes that never form a valid frame = something IS talking and we cannot hear it — a **baud mismatch** (19200 8N1) or a different device. A timeout throws that distinction away; `probeNmx` taps the port's raw data alongside the client so it survives.
- Asks `PROBE_ADDRESSES` = 3, 2, 4, 5, 6, 7, 8 and stops at the first answer. A non-default address is a legitimate config (two controllers on one bus) that presents as a dead link. Broadcast (1) is skipped — it never replies by design. Having asked, the silence report **says so**, so nobody re-checks it.
- `explainProbe(probes, ctx)` is a **pure function** over evidence — no port, no timers, no IO — so the reasoning is what is under test rather than the plumbing.
- `judgePort` / `judgePorts` / `noUsablePortAdvice` rank a port list by name and manufacturer. Unlikely entries are **marked, not hidden**: hiding a port the operator can see in the system looks like a missing device.
- The probe opens its own port and detaches its tap. `SimulatedNmx` gained `off()` for this — a simulator that cannot detach a listener is less capable than the thing it stands in for.

## controls.ts — physical control policy (ADR-0021)

- **The rule: stopping is instant and always available; starting requires deliberation.** `CONTROL_ACTIONS` carries every action's `holdMs`; the stop action is always 0 and every `motion: true` action is always a hold. A test walks the list and fails if either ever stops being true.
- `HoldLatch(holdMs)` takes **injected time** (same discipline as `CueScheduler`) and fires **once per press** — a held button is one instruction, and a Run pass that retriggered every tick would restart the move the instant it finished. `progress()` exists so a hold is visible while it happens.
- Deliberation is a **hold, not a double-press**: a bouncing button can fake a double-press, nothing fakes 600 ms of contact.
- `DEFAULT_BUTTON_BINDINGS` binds **nothing** — a guessed e-stop is worse than none because it would be believed. `unboundStopWarning` makes the absence loud; `duplicateButtonBindings` reports two actions on one button as the ambiguity it is.
- Bridged into the renderer by preload (`window.controls`), never copied — the same reasoning as the timecode bridge.

## commission.ts — measuring the rig (ADR-0020)

- The unit is a **span**: `CalObservation {steps, measured, note?}` — how far the axis moved in steps, and what a rule or an inclinometer said that was. `fitCalibration(obs, "mm"|"deg")` averages each span's own ratio.
- **Deliberately not a least-squares line through absolute positions.** A line has an intercept, the intercept absorbs backlash and measurement offset, and a fit that absorbs your errors has stopped telling you about them. **The spread between spans IS the error estimate.**
- `spreadPct` is **peak-to-peak**, not deviation-from-the-mean: with two measurements the latter is exactly half the disagreement the operator can see between their own two numbers, and a warning that prints half of what it claims teaches people to distrust it.
- **`worst` is null below three observations.** Two disagreeing spans sit the same distance from their own mean; nothing here can say which is wrong, and naming one would be believed. The warning asks for a third instead.
- `diagnoseCalibration(measured, reference)` names ADR-0015's two traps against the **stored** value: ~×100 is a unit slip, a clean power of two is the driver's microstep jumper. Both look reasonable alone and are an order of magnitude out in the export.
- `degreesFromLaser` / `laserAngleWarning` — the field method for rotation (laser on the head, marks on a wall, `atan(offset/distance)`). Assumes the first mark is square to the wall; warns above 25° where that stops being free, and below 5° where the angle is too small to read.
- `repeatability(readingsMm, thresholdMm)` reports **bias and scatter separately** — a consistent offset is backlash and largely correctable, scatter is lost steps and is not. Refuses to be believed below five passes.

## limits.ts — soft travel limits (ADR-0013)

- `AxisLimit {min|null, max|null}`, `Limits` = 3-tuple, `NO_LIMITS`. Untaught bounds never block.
- `withinLimit` / `clampToLimit` / `isTaught`; **`jogWouldExceed(l,pos,stepsPerSec,lookaheadMs=250)`** projects forward and is direction-aware — motion *away* from a violated bound is always permitted so a rig parked outside limits stays recoverable.
- `violationsForFilm(film, limits)` → `LimitViolation[]` (axis, keyIndex, position, bound, limit); `describeViolations()` renders the operator-facing sentence. Called before any upload packet is sent.

## trigger.ts — cue backends + scheduler (ADR-0016)

- **The rule:** anything that must be identical between passes cannot be timed by the host. Backends declare `tier`; the UI must show it.
- `TriggerBackend` seam: `describe/outputs/supports/fire/arm/start/abort/close`. Same idea as `PortLike` — a real device and a fake one are interchangeable.
- `SimulatedTriggerBackend` records what would have fired (tier configurable). Its `firedAtMs === atMs` **by definition** — never read that as evidence that real hardware has no jitter.
- `SerialTriggerBackend` speaks **GRAFFIK-TRIG v1** over any `PortLike`. Handshake **refuses an unknown protocol version** rather than guessing a command set — the ADR-0004 trap, applied to a second device. Cue ids are strings in the move but integers on the wire (a microcontroller should not parse names); the map is reversed when the device reports back. `arm()` **refuses a partial list**. `abort()` is deliberately fire-and-forget: the e-stop path must not hang waiting on the device that may be what went wrong.
- `SimulatedTriggerDevice` implements the **device** side over `PortLike`, with `tick(dtMs)` driving its own clock and `input(n, edge)` faking a GPI edge — so Tier-2 timing is tested end to end without a board.
- `CueScheduler` (Tier 1) takes **injected time** (`advanceTo(elapsedMs)`), so it is deterministic under test and timer-driven in the app. It **fires late cues rather than dropping them** (a missed cue light is invisible; a late one is explicable), survives one cue throwing, and exposes `worstJitterMs()` — the Tier-1 caveat as a measured number. `unroutable()` reports undeliverable cues **before** the pass.
- `actionToWire` covers `pulse`/`level`/`dmx`; `camera`/`midi`/`osc` return null and are skipped rather than sent as garbage. Levels are clamped to 0–255.
- ASCII encode/decode is hand-rolled — the core has zero deps and must typecheck without Node or DOM lib types, so no `Buffer`, no `TextEncoder`.

### trigger.ts, protocol v2 (ADR-0018)

- `TRIGGER_PROTOCOL_VERSION = 2`; `SUPPORTED_TRIGGER_PROTOCOLS = [1, 2]`. A **v1 board is still accepted** — it runs cues correctly and simply has no lens hardware, so `supportsLens()` answers false. An unrecognised version is still refused (ADR-0004).
- `HELLO` reply gained an optional 5th field (lens axis count); `READY` gained an optional 2nd (lens point count). Both regexes accept the v1 form.
- `declareLensAxis` / `calibrateLens(kind, timeoutMs=60s)` / `uploadLens(program)` / `seekLens(kind, 0..1)`. `LENS_AXIS_INDEX = {focus:0, iris:1, zoom:2}` — fixed so a board's pin map can be.
- **Upload is chunked** (`LENS_UPLOAD_CHUNK = 32`) with an `LSYNC` handshake, and `arm()` cross-checks its `READY` lens count against what `uploadLens` sent. Over-capacity and lost lines both surface as a refusal; there is no path where a truncated focus pull runs.
- `start()` accepts `LERR <n> <reason>` as an answer to `GO` and throws it as a sentence. An axis that has not homed since power-up refuses to run — open-loop position means nothing without a stop.
- `abort()` clears the host's uploaded-point count (the device holds the barrel; ADR-0018 §6), so the next `ARM` cannot pass by comparing against an abandoned run.
- `SimulatedTriggerDevice` gained the whole lens side: `calibrationSteps` (settable to `null` to drive the failure path), `lensDropEvery` (to drive the desync refusal), `lensPos` / `lensTravel(kind)` which **survive ABORT on purpose**. It must stay **exactly as strict as the firmware** — see the parity check in `firmware/graffik-trig/test/`.

## dmx.ts — DMX512 via Enttec DMX USB Pro (ADR-0016)

- Frame: `0x7E | label | lenLSB | lenMSB | data | 0xE7`. **The length is LITTLE-endian** — the only such field in this codebase. The NMX is big-endian throughout; do not let the two bleed together.
- Label **6** = Output Only Send DMX Packet Request; its data starts with the **DMX start code** (0), so `dmxPayload` puts channel N at `payload[N]` and the caller has no off-by-one to get wrong. The widget rejects <24 channels, so a short universe is **padded, never truncated**.
- Per Enttec's API the host baud rate is a **dummy value** — the widget owns DMX timing. The app opens 115200 for form's sake.
- `DmxUniverse` is **state, not events**: a channel holds until changed. Consequences that fall out of that and are easy to miss: a `pulse` **schedules its own release** (nothing else will), and `abort()` **blacks out** — a cue system that leaves a lamp at full after an e-stop has not stopped.
- Frames are coalesced to the widget's 40 Hz ceiling. **One injected clock** (`nowFn` + `setTimeoutFn` from the same source). An earlier draft had a private counter advanced by `tick()` *alongside* injected timers; nothing called `tick()` in the app, so the rate limiter believed no time had passed and deferred every frame after the first. If you add timing here, inject it — do not grow a second clock.
- `SimulatedEnttecDevice` parses frames back out (reassembles split writes, tolerates leading garbage) so the whole path is testable with no rig.
- **Tier 1** and cannot be otherwise: DMX has no scheduled-cue concept.

## osc.ts — OSC 1.0 (ADR-0016)

- Encoded here rather than taken as a dependency; transport is `node:dgram` behind a `DatagramLike` seam.
- **The padding rule is the whole reason `oscString` is a named, tested function:** an OSC-string is null-terminated *and then* padded to a multiple of 4, **always with at least one null** — so `"data"` occupies 8 bytes, not 4, and the type-tag string pads by the same rule. That off-by-one is the classic OSC bug.
- Numbers are **big-endian** (`440.0` → `43 dc 00 00`, matching the spec's own example). Plain JS numbers are ambiguous, so the rule is stated: integers → `i`, everything else → `f`; `{int:…}`/`{float:…}` force it, because some receivers silently ignore the wrong type.
- An `osc` action carries its own address; generic `level`/`pulse` publish to `<prefix>/<target>`. `abort()` sends `<prefix>/abort` — best effort, because **UDP confirms nothing**.

## Gotchas

- TS ≥5.9 `Uint8Array<ArrayBuffer>` generics: helper params annotated plain `Uint8Array` deliberately.
- Two tests intentionally deviate from `Sample Commands.txt` (stale) — comments explain; don't "fix" them back.
- ESM package (`"type": "module"`); imports use `.js` extensions; build via `tsc` → `dist/`.
