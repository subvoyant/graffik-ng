/**
 * DMX512 output via an Enttec DMX USB Pro (ADR-0016).
 *
 * Chosen because it needs **no new dependency**: the Pro presents as an FTDI
 * virtual COM port, so it rides the `serialport` package already in the app and
 * the same `PortLike` seam as everything else. Its API is a documented
 * `0x7E`-framed message protocol.
 *
 * Frame layout (Enttec DMX USB Pro API v1.44):
 *
 *   0x7E | label | lenLSB | lenMSB | data… | 0xE7
 *
 * Label 6 is "Output Only Send DMX Packet Request"; its data begins with the
 * **DMX start code** (0x00 for ordinary dimmer data), followed by up to 512
 * channel bytes. Length is 25..513 — the widget requires at least 24 channels.
 *
 * This is a **Tier 1** backend: DMX has no notion of a scheduled cue list, so
 * the host times every change. Fine for house lights and practicals; not for
 * anything that must match frame-to-frame between passes (ADR-0016).
 */

import { Cue, EventAction } from "./film.js";
import { PortLike } from "./client.js";
import { TriggerBackend, Tier } from "./trigger.js";

export const ENTTEC_SOM = 0x7e;
export const ENTTEC_EOM = 0xe7;
export const LABEL_OUTPUT_DMX = 6;
/** The widget rejects a universe shorter than this; pad rather than truncate. */
export const DMX_MIN_CHANNELS = 24;
export const DMX_MAX_CHANNELS = 512;

/**
 * Wrap a payload in the Enttec frame. Length is little-endian here — the one
 * place in this codebase that is not big-endian, because the widget says so
 * (the NMX is big-endian; do not let the two bleed into each other).
 */
export function enttecFrame(label: number, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length + 5);
  out[0] = ENTTEC_SOM;
  out[1] = label & 0xff;
  out[2] = data.length & 0xff;
  out[3] = (data.length >> 8) & 0xff;
  out.set(data, 4);
  out[out.length - 1] = ENTTEC_EOM;
  return out;
}

/**
 * Build a label-6 payload from a channel array. `channels` is 1-based in DMX
 * terms; index 0 of the returned payload is the start code, so channel N lands
 * at payload[N] with no off-by-one for the caller to get wrong.
 */
export function dmxPayload(channels: Uint8Array, startCode = 0): Uint8Array {
  const n = Math.max(DMX_MIN_CHANNELS, Math.min(DMX_MAX_CHANNELS, channels.length));
  const out = new Uint8Array(n + 1);
  out[0] = startCode;
  out.set(channels.subarray(0, n), 1);
  return out;
}

/**
 * A 512-channel universe with change tracking.
 *
 * DMX is **state, not events**: a channel holds its value until something
 * changes it. That is why a cue that sets a level does not need repeating, and
 * why a "pulse" has to schedule its own release — nothing else will.
 */
export class DmxUniverse {
  readonly channels = new Uint8Array(DMX_MAX_CHANNELS);
  private dirty = false;

  set(channel: number, value: number): boolean {
    if (!Number.isInteger(channel) || channel < 1 || channel > DMX_MAX_CHANNELS) {
      throw new Error(`DMX channel must be 1..${DMX_MAX_CHANNELS} (got ${channel})`);
    }
    const v = Math.max(0, Math.min(255, Math.round(value)));
    if (this.channels[channel - 1] === v) return false;
    this.channels[channel - 1] = v;
    this.dirty = true;
    return true;
  }

  get(channel: number): number { return this.channels[channel - 1]; }
  isDirty(): boolean { return this.dirty; }
  clearDirty(): void { this.dirty = false; }
  blackout(): void { this.channels.fill(0); this.dirty = true; }
}

export interface DmxOptions {
  /**
   * Minimum gap between frames, ms. The Pro tops out at 40 packets/second, and
   * it repeats the last frame it was given on its own — so there is no need to
   * stream continuously, only to coalesce bursts.
   */
  minFrameIntervalMs?: number;
  /**
   * Clock and timer, injected together so tests need no wall clock.
   *
   * They MUST come from the same source. An earlier draft kept a private
   * counter advanced by a `tick()` method *alongside* injected timers, which
   * gave the class two clocks that disagreed: in the app nothing ever called
   * `tick()`, so the rate limiter believed no time had passed and deferred
   * every frame after the first. One clock, injected.
   */
  nowFn?: () => number;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

export class DmxTriggerBackend implements TriggerBackend {
  readonly id = "dmx";
  /** Host-timed, and it cannot be otherwise — see the module header. */
  readonly tier: Tier = 1;

  readonly universe = new DmxUniverse();
  /** Every frame written, for assertions and for reading a session back. */
  readonly framesSent: Uint8Array[] = [];

  private port: PortLike;
  private minGap: number;
  private nowFn: () => number;
  private setT: (fn: () => void, ms: number) => unknown;
  private clearT: (h: unknown) => void;
  private pendingSend: unknown = null;
  private lastSentAt = -Infinity;
  private pulseTimers = new Set<unknown>();

  constructor(port: PortLike, opts: DmxOptions = {}) {
    this.port = port;
    this.minGap = opts.minFrameIntervalMs ?? 25;   // 40 Hz ceiling
    this.nowFn = opts.nowFn ?? (() => Date.now());
    this.setT = opts.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearT = opts.clearTimeoutFn ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  describe() { return "Enttec DMX USB Pro — 512 channels, tier 1 (host-timed)"; }
  outputs() { return DMX_MAX_CHANNELS; }

  supports(action: EventAction) {
    return action.kind === "dmx" || action.kind === "level" || action.kind === "pulse";
  }

  /**
   * A cue's `output` is the DMX channel for `level`/`pulse` actions; a `dmx`
   * action carries its own channel and wins, because it was authored with one.
   */
  async fire(cue: Cue, output: number) {
    const a = cue.action;
    if (a.kind === "dmx") {
      this.universe.set(a.channel, a.value);
    } else if (a.kind === "level") {
      this.universe.set(output, Math.round(a.value * 255));
    } else if (a.kind === "pulse") {
      this.universe.set(output, 255);
      const ms = Math.max(1, Math.round(a.ms ?? 30));
      // DMX holds its value, so a pulse MUST schedule its own release.
      const h = this.setT(() => {
        this.pulseTimers.delete(h);
        this.universe.set(output, 0);
        this.flush();
      }, ms);
      this.pulseTimers.add(h);
    } else {
      throw new Error(`DMX backend cannot perform a "${a.kind}" action`);
    }
    this.flush();
  }

  /** DMX cannot pre-schedule; the scheduler host-times this backend instead. */
  async arm() { return 0; }
  async start() { /* nothing to start — see arm() */ }

  async abort() {
    for (const h of this.pulseTimers) this.clearT(h);
    this.pulseTimers.clear();
    if (this.pendingSend) { this.clearT(this.pendingSend); this.pendingSend = null; }
    /* Blackout on abort. A cue system that leaves a lamp at full after an
       e-stop has not really stopped. */
    this.universe.blackout();
    this.writeFrame();
  }

  async close() { await this.abort(); }

  /** Send now if the widget is ready for a frame, else coalesce into one. */
  private flush() {
    if (!this.universe.isDirty() || this.pendingSend) return;
    const since = this.nowFn() - this.lastSentAt;
    if (since >= this.minGap) return this.writeFrame();
    this.pendingSend = this.setT(() => { this.pendingSend = null; this.writeFrame(); }, this.minGap - since);
  }

  private writeFrame() {
    const frame = enttecFrame(LABEL_OUTPUT_DMX, dmxPayload(this.universe.channels));
    this.framesSent.push(frame);
    this.port.write(frame);
    this.universe.clearDirty();
    this.lastSentAt = this.nowFn();
  }
}

/* ------------------------------------------------------------------
   Simulated widget — the device side, so this is testable with no rig
   ------------------------------------------------------------------ */

/** Parses Enttec frames and exposes the universes it was told to output. */
export class SimulatedEnttecDevice implements PortLike {
  private buf: number[] = [];
  /** One entry per label-6 frame: the 512 channel values it carried. */
  readonly universes: Uint8Array[] = [];
  readonly labels: number[] = [];

  write(data: Uint8Array | string) {
    const bytes = typeof data === "string"
      ? Array.from(data, (c) => c.charCodeAt(0))
      : Array.from(data);
    this.buf.push(...bytes);
    this.parse();
    return true;
  }

  on() { return this; }   // the widget in output-only mode never talks back

  private parse() {
    for (;;) {
      const som = this.buf.indexOf(ENTTEC_SOM);
      if (som < 0) { this.buf.length = 0; return; }
      if (som > 0) this.buf.splice(0, som);          // tolerate leading garbage
      if (this.buf.length < 5) return;
      const label = this.buf[1];
      const len = this.buf[2] | (this.buf[3] << 8);
      if (this.buf.length < len + 5) return;         // frame still arriving
      if (this.buf[len + 4] !== ENTTEC_EOM) { this.buf.splice(0, 1); continue; }
      const data = this.buf.slice(4, 4 + len);
      this.labels.push(label);
      if (label === LABEL_OUTPUT_DMX) {
        const u = new Uint8Array(DMX_MAX_CHANNELS);
        u.set(data.slice(1, DMX_MAX_CHANNELS + 1));  // drop the start code
        this.universes.push(u);
      }
      this.buf.splice(0, len + 5);
    }
  }

  /** Current value of a 1-based DMX channel, from the most recent frame. */
  channel(n: number): number {
    const last = this.universes[this.universes.length - 1];
    return last ? last[n - 1] : 0;
  }
}
