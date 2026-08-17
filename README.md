# Graffik NG

Modern, maintained software for driving the Dynamic Perception NMX 3-axis
motion controller — built for live-action, repeatable, multi-pass camera moves
(motion-control "multiplicity"). Spiritual successor to Dynamic Perception's
abandoned Graffik; implemented fresh from the official protocol documentation
(see `packages/nmx-protocol` header comments for provenance and version-drift
notes). Not affiliated with Dynamic Perception, LLC — with gratitude for their
open-sourced firmware, apps, and protocol docs.

## Layout

- `packages/nmx-protocol` — headless TypeScript implementation of the NMX
  serial protocol: packet codec, full command vocabulary (general / motors /
  camera / key-frame engine / broadcasts), and a queued request/response
  client with e-stop fast path. Zero runtime dependencies; 37 unit tests,
  byte-exact against the firmware's own sample packets and dispatch source.
- `apps/jog-slice` — Phase 1 vertical slice (Electron): connect over USB
  serial (19200 baud), enable motors, hold-to-jog slide/pan/tilt, mark
  start/end at jogged positions, arm a timed continuous move, run identical
  passes with a cue delay, big red STOP ALL (broadcast stop, jumps the queue).

## Running the jog slice (macOS, NMX on USB)

```sh
cd packages/nmx-protocol && npm install && npm test   # should be all green
cd ../../apps/jog-slice && npm install && npm start
```

Plug in the NMX first; it shows up as a usbserial/usbmodem device in the port
picker. On connect the app queries firmware version, enables Graffik mode, and
arms the joystick watchdog (motors stop if the app dies mid-jog).

## Safety

- STOP ALL sends broadcast stop for both the program engine and the key-frame
  engine, bypassing the command queue.
- The joystick watchdog is enabled at connect: if the host stops talking
  mid-jog, the firmware stops the motors.
- Firmware version is checked at connect. Old NMX firmware has a different
  command map in places (documented in `src/commands.ts`) — update the
  controller to the last official firmware (nanoMoCo_Firmware repo) before
  trusting programmed moves.

## Multiplicity workflow (v0.1)

1. Connect → Enable motors.
2. Jog each axis to the shot's start framing → **Mark START here**.
3. Jog to the end framing → **Mark END here**.
4. Set move duration + cue delay → **Arm move**.
5. For each pass: **All to start** → reposition performer → **Run pass**.
   The controller executes the identical stored move every time.
