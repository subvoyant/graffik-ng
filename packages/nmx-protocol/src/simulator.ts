/**
 * SimulatedNmx — a software NMX for end-to-end testing without hardware.
 *
 * Implements the PortLike interface, so an NmxClient can drive it exactly as
 * it would a real SerialPort. Behavior mirrors the firmware dispatch
 * (OM_Serial_Com_Client.ino):
 *  - set/action commands ack 0x01
 *  - queries reply <type><big-endian value>
 *  - broadcasts (address 1) get NO response
 *  - jog-speed (motor cmd 13) gets NO response while joystick/Graffik mode on
 *  - tracks motor positions, program points, key-frame uploads, and run state
 *
 * This is a test double, not a physics model: moves complete instantly unless
 * a latency is configured. Its value is validating command sequences, framing,
 * and client queue behavior end-to-end — and giving the UI a demo mode.
 */

import { PACKET_HEADER, Packet, ResponseParser } from "./packet.js";
import type { PortLike } from "./client.js";

type DataListener = (chunk: Uint8Array) => void;

interface SimAxisKf {
  count: number;
  xn: number[];
  fn: number[];
  dn: number[];
}

export class SimulatedNmx implements PortLike {
  address = 3;
  firmwareVersion = 70; // SERIAL_VERSION in Motion_Engine.ino

  graffikMode = false;
  joystickMode = false;
  watchdog = false;
  programMode = 0;
  /** Fresh boot, exactly like a real one — and like the firmware, false by default. */
  powerCycled = true;
  restoresPosition = false;
  startDelayMs = 0;
  running = false;
  progressPercent = 0;

  positions = [0, 0, 0];
  startPoints = [0, 0, 0];
  stopPoints = [0, 0, 0];
  travelMs = [0, 0, 0];
  enabled = [false, false, false];
  jogSpeeds = [0, 0, 0];

  kfAxes: SimAxisKf[] = [0, 1, 2].map(() => ({ count: 0, xn: [], fn: [], dn: [] }));
  /**
   * What this simulated rig can actually do, so feasibility questions get a real
   * answer rather than a cheerful one (ADR-0031). A simulator that always says
   * "yes, that move is possible" is the permissive-simulator trap: every test
   * passes and the rig cannot track the move.
   */
  maxStepsPerSec = 4000;
  maxStepsPerSec2 = 20000;
  kfCurrentAxis = 0;
  kfVideoTimeMs = 0;
  kfRunState: 0 | 1 | 2 = 0;
  kfProgressPercent = 0;
  /** Progress advances this much per progress query, so demo runs complete. */
  progressPerPoll = 20;

  camEnabled = false;
  camExposures = 0;
  camTriggerMs = 0;
  camIntervalMs = 0;

  /** Log of every decoded packet received, oldest first. */
  received: Packet[] = [];

  private parser = new ResponseParser();
  private listeners: DataListener[] = [];
  private physicsTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Physics: integrate jog speeds into positions over dtMs. Deterministic and
   * timer-free for tests; the app calls startPhysics() for real-time demo mode.
   * Motors must be enabled to move (mirrors firmware behavior).
   */
  tick(dtMs: number): void {
    for (let i = 0; i < 3; i++) {
      if (this.jogSpeeds[i] !== 0 && this.enabled[i]) {
        this.positions[i] = Math.round(this.positions[i] + (this.jogSpeeds[i] * dtMs) / 1000);
      }
    }
  }

  startPhysics(intervalMs = 50): void {
    this.stopPhysics();
    this.physicsTimer = setInterval(() => this.tick(intervalMs), intervalMs);
  }

  stopPhysics(): void {
    if (this.physicsTimer) {
      clearInterval(this.physicsTimer);
      this.physicsTimer = null;
    }
  }

  write(data: Uint8Array, cb?: (err?: Error | null) => void): void {
    cb?.(null);
    for (const packet of this.parser.push(data)) {
      this.received.push(packet);
      const reply = this.handle(packet);
      if (reply) queueMicrotask(() => this.emitReply(reply));
    }
  }

  on(event: "data", listener: DataListener): void {
    if (event === "data") this.listeners.push(listener);
  }

  /** Detach a listener. A real SerialPort can; a simulator that cannot is a
      simulator that quietly leaks in any code that taps the port temporarily
      (the connection doctor does exactly that). */
  off(event: "data", listener: DataListener): void {
    if (event !== "data") return;
    const i = this.listeners.indexOf(listener);
    if (i >= 0) this.listeners.splice(i, 1);
  }

  private emitReply(payload: Uint8Array): void {
    const frame = new Uint8Array(PACKET_HEADER.length + 4 + payload.length);
    frame.set(PACKET_HEADER, 0);
    frame[6] = 0; // response frames carry the master address
    frame[7] = 0;
    frame[8] = 1;
    frame[9] = payload.length;
    frame.set(payload, 10);
    for (const l of this.listeners) l(frame);
  }

  private ack(ok = true): Uint8Array {
    return Uint8Array.from([ok ? 1 : 0]);
  }

  private typedLong(value: number): Uint8Array {
    const v = value < 0 ? value + 0x1_0000_0000 : value;
    return Uint8Array.from([3, (v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]);
  }

  private typedByte(value: number): Uint8Array {
    return Uint8Array.from([0, value & 0xff]);
  }

  private f32(payload: Uint8Array): number {
    return new DataView(payload.buffer, payload.byteOffset, 4).getFloat32(0, false);
  }
  private i16(payload: Uint8Array): number {
    return new DataView(payload.buffer, payload.byteOffset, 2).getInt16(0, false);
  }
  private u32(payload: Uint8Array): number {
    return new DataView(payload.buffer, payload.byteOffset, 4).getUint32(0, false);
  }

  /** Returns the response payload, or null for no response. */
  private handle(p: Packet): Uint8Array | null {
    if (p.address === 1) return this.handleBroadcast(p);
    if (p.address !== this.address) return null;
    switch (p.subAddress) {
      case 0: return this.handleGeneral(p);
      case 1: case 2: case 3: return this.handleMotor(p.subAddress - 1, p);
      case 4: return this.handleCamera(p);
      case 5: return this.handleKeyFrame(p);
      default: return this.ack(false);
    }
  }

  private handleBroadcast(p: Packet): null {
    switch (p.command) {
      case 1: this.running = true; break;
      case 2: this.running = false; this.jogSpeeds = [0, 0, 0]; break;
      case 3: this.running = false; break;
      case 5: this.graffikMode = true; break;
      case 7: this.kfRunState = 1; break;
      case 8: this.kfRunState = 0; break;
      case 9: this.kfRunState = 2; break;
    }
    return null; // nodes never respond to broadcasts
  }

  private handleGeneral(p: Packet): Uint8Array | null {
    switch (p.command) {
      case 2: this.running = true; this.progressPercent = 0; return this.ack();
      case 3: this.running = false; return this.ack();
      case 4: this.running = false; return this.ack();
      case 14: this.watchdog = p.payload[0] !== 0; return this.ack();
      case 21: this.startDelayMs = this.u32(p.payload); return this.ack();
      case 22: this.programMode = p.payload[0]; return this.ack();
      case 30: this.restoresPosition = p.payload[0] !== 0; return this.ack();
      case 23: this.joystickMode = p.payload[0] !== 0; return this.ack();
      case 25: this.positions = [...this.startPoints]; return this.ack();
      case 26: this.startPoints = [...this.positions]; return this.ack();
      case 27: this.stopPoints = [...this.positions]; return this.ack();
      case 50: this.graffikMode = p.payload[0] !== 0; return this.ack();
      case 100: return this.typedLong(this.firmwareVersion);
      /* Answers what was actually latched, not what we wish had been. The whole
         point of reading it back is to catch a pass running under a plan type
         somebody else set (PLAN_TYPE — the denominator of percent depends on it). */
      case 118: return this.typedByte(this.programMode);
      /* Every motor can reach the 2-point speed only if none of the taught
         spans needs more than this rig has. */
      case 129: return this.typedByte(this.twoPointValid() ? 1 : 0);
      /* One-shot, exactly like the firmware: whoever asks first consumes it.
         A simulator that answered true every time would make the app look like
         it worked and hide the subtlety the ADR is about. */
      case 119: { const r = this.powerCycled; this.powerCycled = false; return this.typedByte(r ? 1 : 0); }
      case 131: return this.typedByte(this.restoresPosition ? 1 : 0);
      case 123: {
        // animate: each poll advances the "move" so demo passes complete
        if (this.running) {
          this.progressPercent = Math.min(100, this.progressPercent + this.progressPerPoll);
          if (this.progressPercent >= 100) {
            this.running = false;
            this.positions = [...this.stopPoints];
          }
        }
        return this.typedByte(this.progressPercent);
      }
      case 128: return this.typedByte(this.running ? 1 : 0);
      default: return this.ack();
    }
  }

  private handleMotor(idx: number, p: Packet): Uint8Array | null {
    switch (p.command) {
      case 3: this.enabled[idx] = p.payload[0] !== 0; return this.ack();
      case 4: this.jogSpeeds[idx] = 0; return this.ack();
      case 13: {
        this.jogSpeeds[idx] = this.f32(p.payload);
        // firmware: no response while joystick or Graffik mode is active
        return this.joystickMode || this.graffikMode ? null : this.ack();
      }
      case 16: this.startPoints[idx] = this.u32(p.payload); return this.ack();
      case 17: this.stopPoints[idx] = this.u32(p.payload); return this.ack();
      case 20: this.travelMs[idx] = this.u32(p.payload); return this.ack();
      /* Same question as `msAutoSet(motor, validateOnly)`, and like it this
         asking never changes anything. */
      case 120: return this.typedByte(this.motorTwoPointValid(idx) ? 1 : 0);
      case 23: this.positions[idx] = this.startPoints[idx]; return this.ack();
      case 106: return this.typedLong(this.positions[idx]);
      case 107: return this.typedByte(this.jogSpeeds[idx] !== 0 ? 1 : 0);
      default: return this.ack();
    }
  }

  private handleCamera(p: Packet): Uint8Array | null {
    switch (p.command) {
      case 2: this.camEnabled = p.payload[0] !== 0; return this.ack();
      case 3: this.camExposures += 1; return this.ack(); // expose now
      case 4: this.camTriggerMs = this.u32(p.payload); return this.ack();
      case 5: return this.ack(); // focus time (u16)
      case 6: return this.ack(); // max shots (u16)
      case 7: return this.ack(); // exposure delay (u16)
      case 10: this.camIntervalMs = this.u32(p.payload); return this.ack();
      case 100: return this.typedByte(this.camEnabled ? 1 : 0);
      default: return this.ack();
    }
  }

  /** Steps the 2-point program asks of this motor, per second. */
  private motorTwoPointValid(idx: number): boolean {
    const t = this.travelMs[idx];
    if (t <= 0) return true;   // nothing programmed asks nothing
    const need = (Math.abs(this.stopPoints[idx] - this.startPoints[idx]) * 1000) / t;
    return need <= this.maxStepsPerSec;
  }

  private twoPointValid(): boolean {
    return [0, 1, 2].every((i) => !this.enabled[i] || this.motorTwoPointValid(i));
  }

  /**
   * Peak speed of the uploaded spline, not of its knots.
   *
   * The first version of this checked `max|dn|` and happily passed a move that
   * goes 5000 steps in one second on a 1000 steps/s rig — because a two-point
   * move has **zero velocity at both keys** and all the speed in between. Knot
   * velocities are not the answer to "how fast does this go"; the curve is.
   * Sampled rather than solved analytically: 32 points per segment is far finer
   * than the firmware's own update rate, and the arithmetic stays obvious.
   */
  private kfPeakSpeed(axis: SimAxisKf): number {
    let peak = 0;
    for (let i = 1; i < axis.xn.length; i++) {
      const h = (axis.xn[i] - axis.xn[i - 1]) / 1000;   // ms → s
      if (h <= 0) continue;
      const p0 = axis.fn[i - 1], p1 = axis.fn[i];
      const m0 = (axis.dn[i - 1] ?? 0) * h, m1 = (axis.dn[i] ?? 0) * h;
      for (let k = 0; k <= 32; k++) {
        const t = k / 32;
        /* d/dt of the cubic Hermite basis, divided by h to get steps/second. */
        const d = (6 * t * t - 6 * t) * p0 + (3 * t * t - 4 * t + 1) * m0
                + (-6 * t * t + 6 * t) * p1 + (3 * t * t - 2 * t) * m1;
        peak = Math.max(peak, Math.abs(d / h));
      }
    }
    return peak;
  }

  private kfVelocityValid(axis: SimAxisKf): boolean {
    return this.kfPeakSpeed(axis) <= this.maxStepsPerSec;
  }

  private kfAccelValid(axis: SimAxisKf): boolean {
    for (let i = 1; i < axis.dn.length; i++) {
      const dt = (axis.xn[i] - axis.xn[i - 1]) / 1000;
      if (dt <= 0) continue;
      if (Math.abs((axis.dn[i] - axis.dn[i - 1]) / dt) > this.maxStepsPerSec2) return false;
    }
    return true;
  }

  private handleKeyFrame(p: Packet): Uint8Array | null {
    const axis = this.kfAxes[this.kfCurrentAxis];
    switch (p.command) {
      case 10: this.kfCurrentAxis = this.i16(p.payload); return this.ack();
      case 11: {
        const count = this.i16(p.payload);
        this.kfAxes[this.kfCurrentAxis] = { count, xn: [], fn: [], dn: [] };
        return this.ack();
      }
      case 12: axis.xn.push(this.f32(p.payload)); return this.ack();
      case 13: axis.fn.push(this.f32(p.payload)); return this.ack();
      case 14: axis.dn.push(this.f32(p.payload)); return this.ack();
      case 16: return this.ack(); // end transmission
      case 17: this.kfVideoTimeMs = this.u32(p.payload); return this.ack();
      case 20: this.kfRunState = 1; this.kfProgressPercent = 0; return this.ack();
      case 21: this.kfRunState = 2; return this.ack();
      case 22: this.kfRunState = 0; return this.ack();
      case 23: return this.ack(); // take up backlash
      case 100: return this.typedLong(axis.xn.length);
      /* Modelled, not stubbed: valid iff the uploaded spline stays inside what
         this rig can deliver — the same question `validateVel()` answers. */
      case 105: return this.typedByte(this.kfVelocityValid(axis) ? 1 : 0);
      case 106: return this.typedByte(this.kfAccelValid(axis) ? 1 : 0);
      case 120: return this.typedByte(this.kfRunState);
      /* 121 was missing until v0.25 and fell through to a bare ack, so a caller
         got something that was not a run time — the flight recorder's device
         timing read as "incomplete" against the simulator and nothing said why. */
      case 121: return this.typedLong(Math.round((this.kfProgressPercent / 100) * this.kfVideoTimeMs));
      case 122: return this.typedLong(this.kfVideoTimeMs);
      case 123: {
        if (this.kfRunState === 1) {
          this.kfProgressPercent = Math.min(100, this.kfProgressPercent + this.progressPerPoll);
          if (this.kfProgressPercent >= 100) this.kfRunState = 0;
        }
        return this.typedByte(this.kfProgressPercent);
      }
      default: return this.ack();
    }
  }
}
