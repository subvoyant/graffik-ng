/**
 * NMX command builders — full vocabulary.
 *
 * Ground truth: DynamicPerception/nanoMoCo_Firmware @ master (last firmware,
 * Nov 2018), OM_Serial_Com_Client.ino dispatch (serMain / serMotor /
 * serCamera / serKeyFrame) and OMLibraries/OMMoCoBus/OMMoCoDefs.h for the
 * broadcast enum. Cross-checked against "NMX Commands 0.13 w-data types.pdf"
 * and Sample Commands.txt.
 *
 * ⚠ Version-drift notes (why some older references disagree):
 *  - Sample Commands.txt shows "set SMS mode" as byte 0x22 and "steps per
 *    interval" as motor cmd 0x0A; the shipping firmware dispatches program
 *    mode at general cmd 22 (0x16) and motor cmd 10 is "set end limit here".
 *    Those sample lines target an older firmware — we follow the firmware.
 *  - The 2015 Graffik reboot app sent "send motor to start" as motor cmd 25;
 *    current firmware has motor 23 = send-to-start, 25 = set lead-out shots.
 *  => Always query firmware version (general.queryFirmwareVersion) on connect
 *     and refuse/warn on pre-current firmware rather than silently misdrive.
 *
 * Response conventions (firmware): set/action commands reply 0x01/0x00;
 * queries (>=100) reply <type byte><value> where type is 0=byte 1=uint16
 * 2=int16 3=long 4=ulong 5=float 6=string; "float" query values are actually
 * fixed-point: value*100 transmitted as a long — divide by 100 host-side.
 * setContinuousSpeed sends NO response while joystick or Graffik mode is
 * active (firmware suppresses it) — the transport must not await one.
 */

import { BROADCAST_ADDRESS, DEFAULT_ADDRESS, Packet, SubAddress, be } from "./packet.js";

export type Motor = 1 | 2 | 3;

const none: Uint8Array = new Uint8Array(0);

const gen = (command: number, payload: Uint8Array = none, address = DEFAULT_ADDRESS): Packet => ({
  address, subAddress: SubAddress.General, command, payload,
});
const motor = (m: Motor, command: number, payload: Uint8Array = none, address = DEFAULT_ADDRESS): Packet => ({
  address, subAddress: m, command, payload,
});
const camera = (command: number, payload: Uint8Array = none, address = DEFAULT_ADDRESS): Packet => ({
  address, subAddress: SubAddress.Camera, command, payload,
});
const kfp = (command: number, payload: Uint8Array = none, address = DEFAULT_ADDRESS): Packet => ({
  address, subAddress: SubAddress.KeyFrame, command, payload,
});

const bool = (b: boolean) => be.u8(b ? 1 : 0);

/* ------------------------------------------------------------------ */
/* General / program engine (sub-address 0) — firmware serMain          */
/* ------------------------------------------------------------------ */

/**
 * Plan type (general cmd 22, query 118) — `Motion_Engine.ino` `SMS 0`,
 * `CONT_TL 1`, `CONT_VID 2`.
 *
 * **This is not just a label.** `kf_getPercentDone()` reads:
 *
 * ```
 * if (planType() == CONT_VID) kf_run_time / (kf_getMaxMoveTime() + start_delay)
 * else                        kf_run_time / (kf_getMaxCamTime() + start_delay)
 * ```
 *
 * and `kf_getMaxCamTime() = kf_getMaxMoveTime() + Camera.focusTime() + Camera.triggerTime()`.
 * So on any plan type **other than** `CONT_VID`, the reported percent is scaled
 * down by the camera's focus and trigger time — the move finishes before the
 * percent does. Anything that treats percent as a position on the move (the
 * playhead, ADR-0025; the flight recorder's join key, ADR-0027) is wrong by
 * that factor.
 *
 * `CONT_VID` also makes the classic engine fire the shutter once at the end of
 * a pass (`OM_ControlCycle.ino`), which is the start/stop-record semantic a
 * video shoot expects. The official iOS app sends `NMXProgramModeVideo` for a
 * video move; Graffik NG does video moves, so it sends the same.
 */
export const PLAN_TYPE = { sms: 0, contTimelapse: 1, contVideo: 2 } as const;
export type PlanType = (typeof PLAN_TYPE)[keyof typeof PLAN_TYPE];

export const general = {
  /** cmd 2 — start stored program on all axes. */
  startProgram: () => gen(2),
  /** cmd 3 — pause running program. */
  pauseProgram: () => gen(3),
  /** cmd 4 — stop running program (also required before new commands are accepted post-move). */
  stopProgram: () => gen(4),
  /** cmd 5 — debug LED on/off. */
  setDebugLed: (on: boolean) => gen(5, bool(on)),
  /** cmd 6 — set timing master flag. */
  setTimingMaster: (isMaster: boolean) => gen(6, bool(isMaster)),
  /** cmd 8 — set device bus address (2..255). */
  setDeviceAddress: (addr: number) => gen(8, be.u8(addr)),
  /** cmd 10 — send all motors to home position. */
  sendAllHome: () => gen(10),
  /* cmd 11 was "max step rate" and is **deprecated in firmware 0.70** — the very
     version this app gates on. `serMain` has no case 11 (the firmware left a
     block comment where the case used to be), and the default branch does not
     reply at all, so sending it would have stalled the one-command-in-flight
     queue until timeout. Removed in v0.23; found by the vocabulary audit
     (ADR-0029), not by anything calling it. Per-motor max speed is motor cmd 7. */
  /** cmd 14 — joystick watchdog: kill motors if host goes silent. Keep ON while jogging. */
  setJoystickWatchdog: (enabled: boolean) => gen(14, bool(enabled)),
  /** cmd 20 — max program run time, ms. */
  setMaxRunTime: (ms: number) => gen(20, be.u32(ms)),
  /** cmd 21 — program start delay, ms (countdown before motion — useful for multi-pass cueing). */
  setStartDelay: (ms: number) => gen(21, be.u32(ms)),
  /**
   * cmd 22 — **plan type**, and it has THREE values, not two.
   * (NOT 0x22 — see version-drift note.)
   *
   * `Motion_Engine.ino`: `SMS 0`, `CONT_TL 1`, `CONT_VID 2`. Reading this as a
   * boolean-ish "0 = SMS, 1 = continuous" made `CONT_VID` unrepresentable, and
   * the value is load-bearing well beyond naming — see `PLAN_TYPE` below.
   */
  setProgramMode: (mode: PlanType) => gen(22, be.u8(mode)),
  /** cmd 23 — joystick mode on/off (gates non-jog commands unless Graffik mode). */
  setJoystickMode: (enabled: boolean) => gen(23, bool(enabled)),
  /** cmd 24 — ping-pong (bounce) mode. */
  setPingPong: (enabled: boolean) => gen(24, bool(enabled)),
  /** cmd 25 — send ALL motors to their program start points (the multi-pass reset primitive). */
  sendAllToStart: () => gen(25),
  /** cmd 26 — set program START point for all axes at their CURRENT positions (jog-to-set). */
  setStartHere: () => gen(26),
  /** cmd 27 — set program STOP point for all axes at their CURRENT positions (jog-to-set). */
  setStopHere: () => gen(27),
  /** cmd 28 — frames/second flag. */
  setFpsFlag: (flag: number) => gen(28, be.u8(flag)),
  /** cmd 29 — swap all motors' start and stop positions. */
  swapStartStop: () => gen(29),
  /** cmd 50 — Graffik mode: unlock full command set during live control. */
  setGraffikMode: (enabled: boolean) => gen(50, bool(enabled)),
  /** cmd 51 — App mode. */
  setAppMode: (enabled: boolean) => gen(51, bool(enabled)),

  /** query 100 — firmware version. CHECK THIS ON CONNECT (see version-drift note). */
  queryFirmwareVersion: () => gen(100),
  /** query 101 — run status. */
  queryRunStatus: () => gen(101),
  /** query 102 — current run time, ms. */
  queryRunTime: () => gen(102),
  /** query 103 — camera currently exposing? */
  queryExposing: () => gen(103),
  /** query 107 — supply voltage (fixed-point ×100). */
  queryVoltage: () => gen(107),
  /** query 108 — motor current draw (fixed-point ×100). */
  queryCurrent: () => gen(108),
  /** query 118 — the plan type currently latched on the device. */
  queryPlanType: () => gen(118),
  /**
   * query 125 — the classic program's own total run time, ms (`totalProgramTime()`
   * = lead-in + travel + lead-out of the longest enabled motor).
   *
   * This is the **planned** total, not elapsed — query 102 is elapsed. Having
   * both lets a recorded pass check the firmware's own arithmetic: on CONT_VID
   * the reported percent should be elapsed/total (ADR-0028), and if it is not,
   * something is dividing by a number we do not know about.
   */
  queryProgramTotalTime: () => gen(125),
  /**
   * query 123 — program progress %.
   *
   * **Time-based, not distance-based**, on both engines: classic
   * `programPercent()` is `(run_time - start_delay) / longest_move` for any
   * non-SMS plan, and `kf_getPercentDone()` is `kf_run_time / (denominator)`.
   * That is what makes percent a legitimate join key between passes
   * (ADR-0025, ADR-0027) — but see `PLAN_TYPE` for what sets the denominator.
   */
  queryProgramProgress: () => gen(123),
  /** query 124 — all-motor status bitfield. */
  queryMotorsStatus: () => gen(124),
  /** query 128 — any motor running? */
  queryMotorsRunning: () => gen(128),
};

/* ------------------------------------------------------------------ */
/* Motors (sub-addresses 1..3) — firmware serMotor                      */
/* ------------------------------------------------------------------ */

export const motors = {
  /** cmd 2 — motor sleep (cut power when idle). */
  setSleep: (m: Motor, sleep: boolean) => motor(m, 2, bool(sleep)),
  /** cmd 3 — motor driver enable. */
  setEnable: (m: Motor, enabled: boolean) => motor(m, 3, bool(enabled)),
  /** cmd 4 — stop this motor now. */
  stop: (m: Motor) => motor(m, 4),
  /** cmd 5 — backlash compensation steps. */
  setBacklash: (m: Motor, steps: number) => motor(m, 5, be.u16(steps)),
  /** cmd 6 — microstep level (1, 2, 4, 8, 16). */
  setMicrosteps: (m: Motor, level: 1 | 2 | 4 | 8 | 16) => motor(m, 6, be.u8(level)),
  /** cmd 7 — max step speed (steps/s). */
  setMaxStepSpeed: (m: Motor, stepsPerSec: number) => motor(m, 7, be.u16(stepsPerSec)),
  /** cmd 8 — direction flag. */
  setDirection: (m: Motor, dir: 0 | 1) => motor(m, 8, be.u8(dir)),
  /** cmd 9 — set home limit at current position. */
  setHomeLimitHere: (m: Motor) => motor(m, 9),
  /** cmd 10 — set end limit at current position. (Sample Commands.txt's "steps per interval" here is stale.) */
  setEndLimitHere: (m: Motor) => motor(m, 10),
  /** cmd 11 — send motor to home limit. */
  sendHome: (m: Motor) => motor(m, 11),
  /** cmd 12 — send motor to end limit. */
  sendToEndLimit: (m: Motor) => motor(m, 12),
  /** cmd 13 — continuous-speed jog, steps/s float32 (sign = direction). NO reply in joystick/Graffik mode. */
  setContinuousSpeed: (m: Motor, stepsPerSec: number) => motor(m, 13, be.f32(stepsPerSec)),
  /** cmd 14 — accel/decel rate for continuous motion (steps/s²). */
  setContinuousAccel: (m: Motor, stepsPerSec2: number) => motor(m, 14, be.f32(stepsPerSec2)),
  /** cmd 15 — simple move: direction + step count. */
  move: (m: Motor, dir: 0 | 1, steps: number) => motor(m, 15, be.concat(be.u8(dir), be.u32(steps))),
  /** cmd 16 — set program start point (absolute step position). */
  setProgramStartPoint: (m: Motor, position: number) => motor(m, 16, be.u32(position)),
  /** cmd 17 — set program stop point (absolute step position). */
  setProgramStopPoint: (m: Motor, position: number) => motor(m, 17, be.u32(position)),
  /** cmd 18 — easing/ramping: 1 = linear, 2 = quadratic, 3 = inverse quadratic. */
  setEasing: (m: Motor, mode: 1 | 2 | 3) => motor(m, 18, be.u8(mode)),
  /** cmd 19 — lead-in shots/time before this motor starts moving. */
  setLeadIn: (m: Motor, value: number) => motor(m, 19, be.u32(value)),
  /** cmd 20 — travel: shots (SMS) or travel time ms (continuous). */
  setTravel: (m: Motor, shotsOrMs: number) => motor(m, 20, be.u32(shotsOrMs)),
  /** cmd 21 — program acceleration period. */
  setProgramAccel: (m: Motor, value: number) => motor(m, 21, be.u32(value)),
  /** cmd 22 — program deceleration period. */
  setProgramDecel: (m: Motor, value: number) => motor(m, 22, be.u32(value)),
  /** cmd 23 — send motor to its program start point. (2015 app used 25 — stale; see note.) */
  sendToProgramStart: (m: Motor) => motor(m, 23),
  /** cmd 24 — send motor to its program stop point. */
  sendToProgramStop: (m: Motor) => motor(m, 24),
  /** cmd 25 — lead-out shots/time. */
  setLeadOut: (m: Motor, value: number) => motor(m, 25, be.u32(value)),
  /** cmd 27 — reset limits and program start/stop positions; current position becomes home. */
  resetLimits: (m: Motor) => motor(m, 27),
  /** cmd 28 — auto-select highest feasible microstep resolution for programmed move. */
  autoMicrostep: (m: Motor) => motor(m, 28),
  /** cmd 29 — set program start point at CURRENT position. */
  setStartHere: (m: Motor) => motor(m, 29),
  /** cmd 30 — set program stop point at CURRENT position. */
  setStopHere: (m: Motor) => motor(m, 30),
  /** cmd 31 — send motor to an absolute step position. */
  sendToPosition: (m: Motor, position: number) => motor(m, 31, be.i32(position)),
  /** cmd 32 — redefine current position as the given step count. */
  setCurrentPosition: (m: Motor, position: number) => motor(m, 32, be.i32(position)),
  /** cmd 33 — set end limit to a specified location. */
  setEndLimit: (m: Motor, position: number) => motor(m, 33, be.i32(position)),

  /** query 100 — enable status. */
  queryEnable: (m: Motor) => motor(m, 100),
  /** query 101 — backlash. */
  queryBacklash: (m: Motor) => motor(m, 101),
  /** query 102 — microstep value. */
  queryMicrosteps: (m: Motor) => motor(m, 102),
  /** query 103 — direction. */
  queryDirection: (m: Motor) => motor(m, 103),
  /** query 104 — max step speed. */
  queryMaxStepSpeed: (m: Motor) => motor(m, 104),
  /** query 105 — end limit position. */
  queryEndLimit: (m: Motor) => motor(m, 105),
  /** query 106 — current absolute position. */
  queryPosition: (m: Motor) => motor(m, 106),
  /** query 107 — running? */
  queryRunning: (m: Motor) => motor(m, 107),
  /** query 108 — continuous speed (fixed-point ×100). */
  queryContinuousSpeed: (m: Motor) => motor(m, 108),
  /** query 110 — easing mode. */
  queryEasing: (m: Motor) => motor(m, 110),
  /** query 111 — program start point. */
  queryProgramStart: (m: Motor) => motor(m, 111),
  /** query 112 — program stop point. */
  queryProgramStop: (m: Motor) => motor(m, 112),
  /** query 113 — travel shots/time. */
  queryTravel: (m: Motor) => motor(m, 113),
  /**
   * query 124 — is this motor mid "send to"?
   *
   * Load-bearing for anything that reads position while the rig moves: the
   * firmware answers query 106 as `isSending() ? (lastMs/ms) * pos : pos`, so a
   * position read during a send comes back in the motor's *previous* microstep
   * units. A key-frame move never sets the flag; a goto always does.
   */
  queryIsSending: (m: Motor) => motor(m, 124),
};

/* ------------------------------------------------------------------ */
/* Camera (sub-address 4) — firmware serCamera                          */
/* ------------------------------------------------------------------ */

export const cam = {
  /** cmd 2 — camera control enable. */
  setEnable: (enabled: boolean) => camera(2, bool(enabled)),
  /** cmd 3 — trigger an exposure now. */
  exposeNow: () => camera(3),
  /** cmd 4 — trigger (shutter) time, ms. */
  setTriggerTime: (ms: number) => camera(4, be.u32(ms)),
  /** cmd 5 — focus time, ms. */
  setFocusTime: (ms: number) => camera(5, be.u16(ms)),
  /** cmd 6 — max shots. */
  setMaxShots: (n: number) => camera(6, be.u16(n)),
  /** cmd 7 — exposure delay, ms. */
  setExposureDelay: (ms: number) => camera(7, be.u16(ms)),
  /** cmd 8 — focus with shutter. */
  setFocusWithShutter: (enabled: boolean) => camera(8, bool(enabled)),
  /** cmd 9 — mirror-up / repeat cycles. */
  setRepeatCycles: (n: number) => camera(9, be.u8(n)),
  /** cmd 10 — interval between shots, ms. */
  setInterval: (ms: number) => camera(10, be.u32(ms)),
  /** cmd 11 — camera test mode. */
  setTestMode: (enabled: boolean) => camera(11, bool(enabled)),
  /** cmd 12 — keep-alive state. */
  setKeepAlive: (enabled: boolean) => camera(12, bool(enabled)),

  /** query 100 — enable status. */
  queryEnable: () => camera(100),
  /** query 101 — exposing now? */
  queryExposing: () => camera(101),
  /** query 102 — trigger time. */
  queryTriggerTime: () => camera(102),
  /** query 104 — max shots. */
  queryMaxShots: () => camera(104),
  /** query 108 — interval. */
  queryInterval: () => camera(108),
};

/* ------------------------------------------------------------------ */
/* Key-frame engine (sub-address 5) — firmware serKeyFrame              */
/* This is the engine the official NMX Motion app uses for real-time    */
/* moves; spline-interpolated, executed entirely on the controller.     */
/* Workflow: setAxis → setKeyFrameCount → for each KF: setNextAbscissa/ */
/* setNextPosition/setNextVelocity → endTransmission → run.             */
/* ------------------------------------------------------------------ */

export const keyFrame = {
  /** cmd 10 — select the axis (0-based) subsequent KF data applies to. */
  setAxis: (axis: 0 | 1 | 2) => kfp(10, be.i16(axis)),
  /** cmd 11 — number of key frames for the current axis (resets stored KF data). */
  setKeyFrameCount: (count: number) => kfp(11, be.i16(count)),
  /** cmd 12 — next key frame abscissa (x-axis: frames or ms), float32. */
  setNextAbscissa: (x: number) => kfp(12, be.f32(x)),
  /** cmd 13 — next key frame motor position (steps), float32. */
  setNextPosition: (steps: number) => kfp(13, be.f32(steps)),
  /** cmd 14 — next key frame velocity (steps/frame or steps/ms), float32. */
  setNextVelocity: (v: number) => kfp(14, be.f32(v)),
  /** cmd 15 — run-time motor velocity update rate, ms. */
  setUpdateRate: (ms: number) => kfp(15, be.u16(ms)),
  /** cmd 16 — end KF transmission for current axis; sets start/stop points. Always send last. */
  endTransmission: () => kfp(16),
  /** cmd 17 — continuous video move time, ms. */
  setContinuousVideoTime: (ms: number) => kfp(17, be.i32(ms)),
  /** cmd 20 — run/resume the key-frame program. */
  run: () => kfp(20),
  /** cmd 21 — pause the key-frame program. */
  pause: () => kfp(21),
  /** cmd 22 — stop the key-frame program. */
  stop: () => kfp(22),
  /** cmd 23 — take up motor backlash before the run. */
  takeUpBacklash: () => kfp(23),

  /** query 100 — number of key frames set. */
  queryKeyFrameCount: () => kfp(100),
  /** query 105/106 — spline max-speed validation for current axis. */
  queryVelocityValid: () => kfp(105),
  queryAccelValid: () => kfp(106),
  /** query 120 — run state: 0 stopped, 1 running, 2 paused. */
  queryRunState: () => kfp(120),
  /** query 121 — current program running time. */
  queryRunTime: () => kfp(121),
  /** query 122 — max program running time. */
  queryMaxRunTime: () => kfp(122),
  /** query 123 — percent complete. */
  queryPercentComplete: () => kfp(123),
};

/* ------------------------------------------------------------------ */
/* Broadcasts (bus address 1) — OMMoCoDefs.h BroadCastType.             */
/* Nodes send NO response to broadcast commands.                        */
/* ------------------------------------------------------------------ */

const bcast = (command: number, payload: Uint8Array = none): Packet => ({
  address: BROADCAST_ADDRESS, subAddress: 0, command, payload,
});

export const broadcast = {
  /** 1 — start program on every controller (multi-bus sync). */
  start: () => bcast(1),
  /** 2 — STOP everything. This is the e-stop primitive. */
  stop: () => bcast(2),
  /** 3 — pause everything. */
  pause: () => bcast(3),
  /** 4 — assign bus address (2..255) to a controller of unknown address. */
  assignAddress: (addr: number) => bcast(4, be.u8(addr)),
  /** 5 — enable Graffik mode over USB. */
  graffikModeUsb: () => bcast(5),
  /** 7 — start key-frame program everywhere. */
  kfStart: () => bcast(7),
  /** 8 — stop key-frame program everywhere (e-stop for KF moves). */
  kfStop: () => bcast(8),
  /** 9 — pause key-frame program everywhere. */
  kfPause: () => bcast(9),
};
