/**
 * Trigger backends and cue scheduling (ADR-0016).
 *
 * The load-bearing idea, which is ADR-0005 said a second time: **anything that
 * must be identical between passes cannot be timed by the host.**
 *
 *  - **Tier 1 (host-scheduled).** The host fires each cue during the pass.
 *    Jitter is roughly ±20 ms and it is *not* repeatable — timers, GC and USB
 *    scheduling do not do the same thing twice. Fine for a cue light or a room
 *    light; not fine for anything an audience will see A/B'd in a composite.
 *  - **Tier 2 (device-scheduled).** The whole cue list is uploaded before the
 *    pass; the device runs it from its own crystal and the host sends one `GO`.
 *    Repeatability is then a property of the crystal, not of the host.
 *
 * A backend declares which tier it can deliver, and the UI shows it. An
 * operator who believes a host-timed focus pull is frame-accurate finds out in
 * the composite, which is the most expensive possible moment.
 */

import { Cue, EventAction } from "./film.js";
import { PortLike } from "./client.js";

export type Tier = 1 | 2;

/**
 * Where a logical target actually goes. Bindings live in preferences, not in
 * the move file — a `.graffik` should survive being carried to another rig.
 */
export interface TargetBinding {
  /** Logical name used by the move's events, e.g. "cue-light". */
  target: string;
  /** Which backend drives it. */
  backendId: string;
  /** Output index on that backend (1-based). */
  output: number;
}

export interface FiredCue {
  id: string;
  target: string;
  output: number;
  action: EventAction;
  /** Milliseconds from GO, as scheduled. */
  atMs: number;
  /** Milliseconds from GO, as actually dispatched. The gap is the jitter. */
  firedAtMs: number;
}

export interface TriggerBackend {
  readonly id: string;
  readonly tier: Tier;
  describe(): string;
  /** Number of addressable outputs. */
  outputs(): number;
  /** Can this backend perform this action at all? */
  supports(action: EventAction): boolean;
  /** Tier 1: fire one cue now. */
  fire(cue: Cue, output: number): Promise<void>;
  /** Tier 2: upload the whole list before the pass. Returns cues accepted. */
  arm(cues: Array<{ cue: Cue; output: number }>): Promise<number>;
  /** Tier 2: start the armed list. */
  start(): Promise<void>;
  /** Cancel everything, armed or running. Wired into the e-stop. */
  abort(): Promise<void>;
  close(): Promise<void>;
}

/* ------------------------------------------------------------------
   Simulated backend — the SimulatedNmx trick, applied to cues
   ------------------------------------------------------------------ */

/**
 * Records what would have fired. Exists so the whole cue system is verifiable
 * with no hardware, which is the same discipline that got the motion path this
 * far before an NMX was ever plugged in.
 */
export class SimulatedTriggerBackend implements TriggerBackend {
  readonly id = "simulated";
  readonly tier: Tier;
  readonly fired: FiredCue[] = [];
  armed: Array<{ cue: Cue; output: number }> = [];
  started = false;
  aborted = false;
  private outs: number;

  constructor({ tier = 1, outputs = 8 }: { tier?: Tier; outputs?: number } = {}) {
    this.tier = tier;
    this.outs = outputs;
  }

  describe() { return `Simulated trigger device — ${this.outs} outputs, tier ${this.tier}`; }
  outputs() { return this.outs; }
  supports() { return true; }

  async fire(cue: Cue, output: number) {
    this.fired.push({
      id: cue.id, target: cue.target, output, action: cue.action,
      atMs: cue.atMs, firedAtMs: cue.atMs,
    });
  }
  async arm(cues: Array<{ cue: Cue; output: number }>) {
    this.armed = [...cues];
    this.started = false; this.aborted = false;
    return cues.length;
  }
  async start() {
    this.started = true;
    for (const { cue, output } of this.armed) {
      this.fired.push({
        id: cue.id, target: cue.target, output, action: cue.action,
        atMs: cue.atMs, firedAtMs: cue.atMs,      // a perfect device, by definition
      });
    }
  }
  async abort() { this.aborted = true; this.armed = []; }
  async close() { /* nothing to release */ }
  reset() { this.fired.length = 0; this.armed = []; this.started = false; this.aborted = false; }
}

/* ------------------------------------------------------------------
   Serial (Arduino-class) backend — the GRAFFIK-TRIG text protocol
   ------------------------------------------------------------------ */

export const TRIGGER_PROTOCOL_VERSION = 1;

/** Render an action as the device's wire form. Returns null if unsupported. */
export function actionToWire(action: EventAction): string | null {
  switch (action.kind) {
    case "pulse": return `PULSE ${Math.max(1, Math.round(action.ms ?? 30))}`;
    case "level": return `LEVEL ${Math.max(0, Math.min(255, Math.round(action.value * 255)))}`;
    case "dmx": return `DMX ${action.channel} ${action.value}`;
    // camera goes out the NMX's own shutter line; midi/osc are other transports.
    default: return null;
  }
}

export interface DeviceInfo { name: string; protocol: number; outputs: number; inputs: number }

/* The protocol is ASCII by definition, so encode/decode by hand rather than
   reach for Buffer or TextEncoder — the core package has zero dependencies and
   must typecheck without Node or DOM lib types. */
const toAscii = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0x7f;
  return out;
};
const fromAscii = (d: Uint8Array): string => {
  let s = "";
  for (let i = 0; i < d.length; i++) s += String.fromCharCode(d[i]);
  return s;
};

/**
 * Speaks the line protocol over any `PortLike` — the same seam the NMX client
 * uses, so a real serial port and a simulated device are interchangeable.
 *
 * The protocol is plain text on purpose. Anyone can implement it on any board
 * in an afternoon, debug it in a serial monitor, and — the reason that actually
 * matters — we can read a session transcript when a cue fires late on set at
 * 2 a.m. A binary protocol would save bytes nobody needs saved.
 */
export class SerialTriggerBackend implements TriggerBackend {
  readonly id = "serial";
  /** A board that runs its own clock is the only Tier-2 path we have. */
  readonly tier: Tier = 2;

  private port: PortLike;
  private buf = "";
  private info: DeviceInfo | null = null;
  private pending: Array<{ match: RegExp; resolve: (m: RegExpMatchArray) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];
  private idMap = new Map<number, string>();
  /** Lines the device pushed unprompted: input edges and fire reports. */
  readonly events: Array<{ line: string; at: number }> = [];
  onInput: ((n: number, edge: "RISE" | "FALL", deviceMs: number) => void) | null = null;
  onFired: ((id: string, deviceMs: number) => void) | null = null;
  onDone: ((deviceMs: number) => void) | null = null;

  constructor(port: PortLike, private timeoutMs = 1500) {
    this.port = port;
    this.port.on("data", (chunk: Uint8Array | string) => this.ingest(chunk));
  }

  private ingest(chunk: Uint8Array | string) {
    this.buf += typeof chunk === "string" ? chunk : fromAscii(chunk);
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).replace(/\r$/, "").trim();
      this.buf = this.buf.slice(nl + 1);
      if (line) this.handleLine(line);
    }
  }

  private handleLine(line: string) {
    // Unsolicited reports first — they can arrive between any request/response.
    let m = line.match(/^IN (\d+) (RISE|FALL) (\d+)$/);
    if (m) {
      this.events.push({ line, at: Number(m[3]) });
      this.onInput?.(Number(m[1]), m[2] as "RISE" | "FALL", Number(m[3]));
      return;
    }
    m = line.match(/^FIRED (\d+) (\d+)$/);
    if (m) {
      this.events.push({ line, at: Number(m[2]) });
      this.onFired?.(this.idMap.get(Number(m[1])) ?? m[1], Number(m[2]));
      return;
    }
    m = line.match(/^DONE (\d+)$/);
    if (m) {
      this.events.push({ line, at: Number(m[1]) });
      this.onDone?.(Number(m[1]));
      return;
    }
    // Otherwise it answers the oldest waiter that matches.
    const idx = this.pending.findIndex((p) => p.match.test(line));
    if (idx >= 0) {
      const [p] = this.pending.splice(idx, 1);
      clearTimeout(p.timer);
      p.resolve(line.match(p.match)!);
    }
  }

  private request(line: string, match: RegExp): Promise<RegExpMatchArray> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = this.pending.filter((p) => p.timer !== timer);
        reject(new Error(`trigger device did not answer "${line.split(" ")[0]}" within ${this.timeoutMs} ms`));
      }, this.timeoutMs);
      this.pending.push({ match, resolve, reject, timer });
      this.write(line);
    });
  }

  private write(line: string) {
    this.port.write(toAscii(line + "\n"));
  }

  /** Handshake. Throws on an unknown protocol version rather than guessing. */
  async hello(): Promise<DeviceInfo> {
    const m = await this.request("HELLO", /^GRAFFIK-TRIG (\d+) (\S+) (\d+) (\d+)$/);
    const protocol = Number(m[1]);
    if (protocol !== TRIGGER_PROTOCOL_VERSION) {
      throw new Error(
        `trigger device speaks protocol v${protocol}, this build speaks v${TRIGGER_PROTOCOL_VERSION} — ` +
          "refusing rather than guessing at a command set (the same trap as ADR-0004)",
      );
    }
    this.info = { protocol, name: m[2], outputs: Number(m[3]), inputs: Number(m[4]) };
    return this.info;
  }

  describe() { return this.info ? `${this.info.name} — ${this.info.outputs} out / ${this.info.inputs} in` : "trigger device (no handshake yet)"; }
  outputs() { return this.info?.outputs ?? 0; }
  supports(action: EventAction) { return actionToWire(action) !== null; }

  async fire(cue: Cue, output: number) {
    const wire = actionToWire(cue.action);
    if (!wire) throw new Error(`serial backend cannot perform a "${cue.action.kind}" action`);
    this.write(`FIRE ${output} ${wire}`);
  }

  /**
   * Upload the cue list. Cue ids are strings in the move but integers on the
   * wire — a microcontroller should not be parsing arbitrary names — so the
   * mapping is kept here and reversed when the device reports back.
   */
  async arm(cues: Array<{ cue: Cue; output: number }>) {
    this.idMap.clear();
    this.write("CLEAR");
    let n = 0;
    for (const { cue, output } of cues) {
      const wire = actionToWire(cue.action);
      if (!wire) continue;               // silently skipped here; caller reports
      const numeric = ++n;
      this.idMap.set(numeric, cue.id);
      this.write(`CUE ${numeric} ${Math.round(cue.atMs)} ${output} ${wire}`);
    }
    const m = await this.request("ARM", /^READY (\d+)$/);
    const accepted = Number(m[1]);
    if (accepted !== n) {
      throw new Error(`device accepted ${accepted} of ${n} cues — refusing to run a partial list`);
    }
    return accepted;
  }

  async start() { await this.request("GO", /^STARTED (\d+)$/); }

  /**
   * Cancel armed and running cues. Deliberately fire-and-forget: the e-stop
   * path must not be able to hang waiting for an acknowledgement from a device
   * that may be the thing that has gone wrong.
   */
  async abort() { this.write("ABORT"); }

  async close() {
    for (const p of this.pending) clearTimeout(p.timer);
    this.pending = [];
  }
}

/* ------------------------------------------------------------------
   Host-side (Tier 1) scheduler
   ------------------------------------------------------------------ */

/**
 * Dispatches cues against a pass clock the caller advances. Time is injected
 * rather than read from `Date.now()` so the whole thing is deterministic under
 * test — the app drives `advanceTo` from a timer, the tests drive it directly.
 */
export class CueScheduler {
  private cues: Cue[] = [];
  private nextIndex = 0;
  private running = false;
  readonly dispatched: FiredCue[] = [];

  constructor(
    private resolveTarget: (target: string) => TargetBinding | undefined,
    private backendFor: (backendId: string) => TriggerBackend | undefined,
    private onProblem?: (message: string) => void,
  ) {}

  /** Load a pass. Cues arrive sorted by `buildCueList`; sort again defensively. */
  load(cues: Cue[]) {
    this.cues = [...cues].sort((a, b) => a.atMs - b.atMs);
    this.nextIndex = 0;
    this.dispatched.length = 0;
    this.running = false;
  }

  /** Cues whose target has no binding, or a backend that cannot do the action. */
  unroutable(): Array<{ cue: Cue; reason: string }> {
    const out: Array<{ cue: Cue; reason: string }> = [];
    for (const cue of this.cues) {
      const binding = this.resolveTarget(cue.target);
      if (!binding) { out.push({ cue, reason: `target "${cue.target}" is not bound to an output` }); continue; }
      const backend = this.backendFor(binding.backendId);
      if (!backend) { out.push({ cue, reason: `backend "${binding.backendId}" is not connected` }); continue; }
      if (!backend.supports(cue.action)) out.push({ cue, reason: `${backend.id} cannot perform a "${cue.action.kind}" action` });
    }
    return out;
  }

  start() { this.running = true; this.nextIndex = 0; this.dispatched.length = 0; }
  stop() { this.running = false; }

  /**
   * Fire everything due at or before `elapsedMs`. Late cues still fire —
   * dropping a cue because the host stalled is worse than firing it late, since
   * a missed cue light is invisible while a late one is at least explicable.
   */
  async advanceTo(elapsedMs: number) {
    if (!this.running) return;
    while (this.nextIndex < this.cues.length && this.cues[this.nextIndex].atMs <= elapsedMs) {
      const cue = this.cues[this.nextIndex++];
      const binding = this.resolveTarget(cue.target);
      const backend = binding && this.backendFor(binding.backendId);
      if (!binding || !backend) {
        this.onProblem?.(`cue "${cue.id}" skipped — ${binding ? "backend gone" : "no binding"} for target "${cue.target}"`);
        continue;
      }
      try {
        await backend.fire(cue, binding.output);
        this.dispatched.push({
          id: cue.id, target: cue.target, output: binding.output, action: cue.action,
          atMs: cue.atMs, firedAtMs: elapsedMs,
        });
      } catch (err) {
        this.onProblem?.(`cue "${cue.id}" failed: ${(err as Error).message}`);
      }
    }
  }

  /** Worst dispatch lateness so far, ms. The honest measure of Tier 1. */
  worstJitterMs(): number {
    return this.dispatched.reduce((w, d) => Math.max(w, d.firedAtMs - d.atMs), 0);
  }
}

/* ------------------------------------------------------------------
   Simulated DEVICE — the other side of the wire, for tests
   ------------------------------------------------------------------ */

/**
 * A `PortLike` that behaves like a board running the GRAFFIK-TRIG firmware:
 * parses the text protocol, holds a cue list, and runs it off its own clock
 * when `tick()` advances. Mirrors `SimulatedNmx` — the point is that the serial
 * backend can be tested end to end, including the timing behaviour that is the
 * entire reason Tier 2 exists, without a board on the desk.
 */
export class SimulatedTriggerDevice implements PortLike {
  private listeners: Array<(d: Uint8Array) => void> = [];
  private rx = "";
  private cues: Array<{ id: number; atMs: number; out: number; wire: string }> = [];
  private pendingCues: typeof this.cues = [];
  private clockMs = 0;
  private runningFrom: number | null = null;
  private nextCue = 0;

  /** Everything the device "did", for assertions. */
  readonly performed: Array<{ out: number; wire: string; deviceMs: number; id?: number }> = [];
  /** Set to reject the next ARM with a short count, to test the partial path. */
  acceptLimit: number | null = null;

  /** Overridable so tests can drive the version-mismatch refusal path. */
  constructor(public name = "sim-trig", public outs = 8, public ins = 2, public protocol = TRIGGER_PROTOCOL_VERSION) {}

  write(data: Uint8Array | string, cb?: (err?: Error | null) => void) {
    this.rx += typeof data === "string" ? data : fromAscii(data);
    let nl: number;
    while ((nl = this.rx.indexOf("\n")) >= 0) {
      const line = this.rx.slice(0, nl).trim();
      this.rx = this.rx.slice(nl + 1);
      if (line) this.command(line);
    }
    cb?.(null);
    return true;
  }

  on(event: "data", fn: (d: Uint8Array) => void) {
    if (event === "data") this.listeners.push(fn);
    return this;
  }

  private say(line: string) {
    const buf = toAscii(line + "\r\n");
    for (const fn of this.listeners) fn(buf);
  }

  private command(line: string) {
    const [verb, ...rest] = line.split(/\s+/);
    switch (verb) {
      case "HELLO":
        this.say(`GRAFFIK-TRIG ${this.protocol} ${this.name} ${this.outs} ${this.ins}`);
        break;
      case "CLEAR":
        this.pendingCues = []; this.cues = []; this.runningFrom = null; this.nextCue = 0;
        break;
      case "CUE": {
        const [id, atMs, out, ...action] = rest;
        this.pendingCues.push({ id: Number(id), atMs: Number(atMs), out: Number(out), wire: action.join(" ") });
        break;
      }
      case "ARM": {
        const limit = this.acceptLimit ?? this.pendingCues.length;
        this.cues = this.pendingCues.slice(0, limit).sort((a, b) => a.atMs - b.atMs);
        this.nextCue = 0;
        this.say(`READY ${this.cues.length}`);
        break;
      }
      case "GO":
        this.runningFrom = this.clockMs;
        this.nextCue = 0;
        this.say(`STARTED ${this.clockMs}`);
        break;
      case "ABORT":
        this.runningFrom = null; this.cues = []; this.pendingCues = []; this.nextCue = 0;
        break;
      case "FIRE": {
        const [out, ...action] = rest;
        this.performed.push({ out: Number(out), wire: action.join(" "), deviceMs: this.clockMs });
        break;
      }
      default:
        this.say(`ERR unknown ${verb}`);
    }
  }

  /** Advance the device's own clock, firing anything now due. */
  tick(dtMs: number) {
    this.clockMs += dtMs;
    if (this.runningFrom === null) return;
    const elapsed = this.clockMs - this.runningFrom;
    while (this.nextCue < this.cues.length && this.cues[this.nextCue].atMs <= elapsed) {
      const c = this.cues[this.nextCue++];
      this.performed.push({ out: c.out, wire: c.wire, deviceMs: this.clockMs, id: c.id });
      this.say(`FIRED ${c.id} ${this.clockMs}`);
    }
    if (this.nextCue >= this.cues.length && this.cues.length) {
      this.runningFrom = null;
      this.say(`DONE ${this.clockMs}`);
    }
  }

  /** Simulate a GPI edge — a camera run signal, a foot switch. */
  input(n: number, edge: "RISE" | "FALL") { this.say(`IN ${n} ${edge} ${this.clockMs}`); }
}
