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
import { LensAxisKind, LensProgram, LENS_POS_MAX } from "./lens.js";

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

/** What this build speaks. v2 adds the lens axes (ADR-0018). */
export const TRIGGER_PROTOCOL_VERSION = 2;

/**
 * Versions we can still talk to. ADR-0004's lesson is "never guess at a command
 * set you do not know" — but a v1 board is a version we DO know: it runs cues
 * correctly and simply has no lens hardware. Refusing it because the app grew a
 * feature it does not have would break a working rig for no reason. So v1 is
 * accepted and `supportsLens()` answers false; an unrecognised version is still
 * refused outright.
 */
export const SUPPORTED_TRIGGER_PROTOCOLS: readonly number[] = [1, 2];

/**
 * Lines sent between flow-control checkpoints during a lens upload.
 *
 * An ATmega's UART buffer is 64 bytes. At 115 200 baud an `LKEY` line arrives
 * in under 2 ms and parses in microseconds, so in principle the device keeps up
 * — but "in principle the firmware is never busy" is exactly the assumption
 * that produces a silently truncated focus curve. A sync every 32 points costs
 * two round trips on a typical upload and converts a corrupt pull into a
 * refusal.
 */
export const LENS_UPLOAD_CHUNK = 32;

/** Wire index for each lens axis. Fixed so a device's pin map can be, too. */
export const LENS_AXIS_INDEX: Record<LensAxisKind, number> = { focus: 0, iris: 1, zoom: 2 };

/** How a lens motor is set up on the board. */
export interface LensAxisConfig {
  kind: LensAxisKind;
  /** Barrel travel in motor steps — 0 until `calibrateLens` has run. */
  steps: number;
  /** Usable top speed, steps/s. Measured on the rig, not from a datasheet. */
  maxStepsPerSec: number;
  /** The motor is geared or mounted backwards relative to the barrel. */
  invert: boolean;
}

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

export interface DeviceInfo {
  name: string;
  protocol: number;
  outputs: number;
  inputs: number;
  /** Lens axes the board can drive. v1 boards report 0. */
  lensAxes: number;
}

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

  private request(line: string, match: RegExp, timeoutMs = this.timeoutMs): Promise<RegExpMatchArray> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = this.pending.filter((p) => p.timer !== timer);
        reject(new Error(`trigger device did not answer "${line.split(" ")[0]}" within ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.push({ match, resolve, reject, timer });
      this.write(line);
    });
  }

  private write(line: string) {
    this.port.write(toAscii(line + "\n"));
  }

  /** Handshake. Throws on an UNKNOWN protocol version; an older known one is fine. */
  async hello(): Promise<DeviceInfo> {
    const m = await this.request("HELLO", /^GRAFFIK-TRIG (\d+) (\S+) (\d+) (\d+)(?: (\d+))?$/);
    const protocol = Number(m[1]);
    if (!SUPPORTED_TRIGGER_PROTOCOLS.includes(protocol)) {
      throw new Error(
        `trigger device speaks protocol v${protocol}; this build speaks ` +
          `v${SUPPORTED_TRIGGER_PROTOCOLS.join("/v")} — refusing rather than guessing at a ` +
          "command set (the same trap as ADR-0004)",
      );
    }
    this.info = {
      protocol, name: m[2], outputs: Number(m[3]), inputs: Number(m[4]),
      /* v1 boards do not report a lens count and do not have lens hardware. */
      lensAxes: protocol >= 2 ? Number(m[5] ?? 0) : 0,
    };
    return this.info;
  }

  describe() {
    if (!this.info) return "trigger device (no handshake yet)";
    const lens = this.info.lensAxes ? ` / ${this.info.lensAxes} lens` : "";
    return `${this.info.name} — ${this.info.outputs} out / ${this.info.inputs} in${lens} (v${this.info.protocol})`;
  }

  /** A v1 cue board is perfectly good at cues and cannot pull focus. */
  supportsLens() { return (this.info?.lensAxes ?? 0) > 0; }
  lensAxes() { return this.info?.lensAxes ?? 0; }
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
    const m = await this.request("ARM", /^READY (\d+)(?: (\d+))?$/);
    const accepted = Number(m[1]);
    this.armedLensPoints = Number(m[2] ?? 0);
    if (accepted !== n) {
      throw new Error(`device accepted ${accepted} of ${n} cues — refusing to run a partial list`);
    }
    if (this.uploadedLensPoints && this.armedLensPoints !== this.uploadedLensPoints) {
      throw new Error(
        `device armed ${this.armedLensPoints} of ${this.uploadedLensPoints} lens points — ` +
          "refusing to run a truncated focus pull",
      );
    }
    return accepted;
  }

  /* ----------------------------------------------------------------
     Lens axes (protocol v2, ADR-0018)
     ---------------------------------------------------------------- */

  /** Points the last `uploadLens` sent — checked against ARM's own count. */
  private uploadedLensPoints = 0;
  private armedLensPoints = 0;

  private requireLens() {
    if (!this.info) throw new Error("handshake with the lens device first");
    if (!this.supportsLens()) {
      throw new Error(
        `${this.info.name} speaks protocol v${this.info.protocol} with no lens axes — ` +
          "it can run cues but cannot drive focus, iris or zoom",
      );
    }
  }

  /** Tell the board how a barrel's motor is set up. Idempotent. */
  async declareLensAxis(cfg: LensAxisConfig): Promise<void> {
    this.requireLens();
    const n = LENS_AXIS_INDEX[cfg.kind];
    await this.request(
      `LAXIS ${n} ${cfg.kind} ${Math.max(0, Math.round(cfg.steps))} ` +
        `${Math.max(0, Math.round(cfg.maxStepsPerSec))} ${cfg.invert ? 1 : 0}`,
      new RegExp(`^LAXIS ${n} OK$`),
    );
  }

  /**
   * Drive the barrel to both mechanical stops and report the travel between
   * them. This is the *only* thing that gives a stepper an absolute reference —
   * open-loop position means nothing until it is measured against a stop — and
   * it is what the Preston MDR does whenever a motor is connected.
   *
   * Given its own long timeout: a slow barrel takes many seconds, and inheriting
   * the 1.5 s request timeout would abandon a calibration that was working.
   */
  async calibrateLens(kind: LensAxisKind, timeoutMs = 60_000): Promise<number> {
    this.requireLens();
    const n = LENS_AXIS_INDEX[kind];
    const m = await this.request(
      `LCAL ${n}`,
      new RegExp(`^(?:LCAL ${n} (\\d+)|LCALERR ${n} (.+))$`),
      timeoutMs,
    );
    if (m[2] !== undefined) throw new Error(`${kind} calibration failed: ${m[2]}`);
    const steps = Number(m[1]);
    if (!Number.isFinite(steps) || steps <= 0) {
      throw new Error(`${kind} calibration returned ${m[1]} steps — the barrel did not move`);
    }
    return steps;
  }

  /**
   * Upload the sampled curves. Chunked with a sync so a device that cannot keep
   * up says so instead of quietly dropping the middle of a focus pull.
   */
  async uploadLens(program: LensProgram): Promise<number> {
    this.requireLens();
    this.uploadedLensPoints = 0;
    await this.request("LCLEAR", /^LCLEAR OK$/);
    let total = 0, sinceSync = 0, syncId = 0;
    for (const axis of program.axes) {
      const n = LENS_AXIS_INDEX[axis.kind];
      for (const pt of axis.points) {
        const pos = Math.max(0, Math.min(LENS_POS_MAX, Math.round(pt.pos)));
        this.write(`LKEY ${n} ${Math.round(pt.ms)} ${pos}`);
        total++;
        if (++sinceSync >= LENS_UPLOAD_CHUNK) {
          sinceSync = 0;
          const id = ++syncId;
          const m = await this.request(`LSYNC ${id}`, new RegExp(`^LSYNC ${id} (\\d+)$`));
          if (Number(m[1]) !== total) {
            throw new Error(`lens upload desynced: sent ${total} points, device has ${m[1]}`);
          }
        }
      }
    }
    const m = await this.request(`LSYNC ${++syncId}`, new RegExp(`^LSYNC ${syncId} (\\d+)$`));
    if (Number(m[1]) !== total) {
      throw new Error(`lens upload desynced: sent ${total} points, device has ${m[1]}`);
    }
    this.uploadedLensPoints = total;
    return total;
  }

  /**
   * Park a barrel. Used to send the lens to its first key before a pass and to
   * jog it by hand while marking. Fire-and-forget so the marking UI stays
   * responsive under a held key.
   */
  seekLens(kind: LensAxisKind, pos01: number) {
    this.requireLens();
    const n = LENS_AXIS_INDEX[kind];
    const pos = Math.max(0, Math.min(LENS_POS_MAX, Math.round(pos01 * LENS_POS_MAX)));
    this.write(`LSEEK ${n} ${pos}`);
  }

  /**
   * Start the pass on the device's clock.
   *
   * `LERR` is accepted as an answer here on purpose. A stepper that has not
   * been homed since power-up has no idea where the barrel is, so running a
   * curve would drive it into a stop at speed. The device refuses instead of
   * starting, and this turns that refusal into a sentence the operator can act
   * on rather than a timeout they have to guess at.
   */
  async start() {
    const m = await this.request("GO", /^(?:STARTED (\d+)|LERR (\d+) (.+))$/);
    if (m[3] !== undefined) {
      const kind = (Object.keys(LENS_AXIS_INDEX) as LensAxisKind[])
        .find((k) => LENS_AXIS_INDEX[k] === Number(m[2])) ?? `axis ${m[2]}`;
      throw new Error(`device refused to start: ${kind} ${m[3]}`);
    }
  }

  /**
   * Cancel armed and running cues. Deliberately fire-and-forget: the e-stop
   * path must not be able to hang waiting for an acknowledgement from a device
   * that may be the thing that has gone wrong.
   */
  async abort() {
    this.write("ABORT");
    /* The device holds the barrel where it stopped (ADR-0017 §4) — a focus ring
       that free-wheels on an e-stop is a way to lose a lens. But the uploaded
       program is gone, so forget it here too: the next ARM must not "pass" by
       comparing against a count from a run that was abandoned. */
    this.uploadedLensPoints = 0;
    this.armedLensPoints = 0;
  }

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

  /* --- lens side (protocol v2) --- */
  private lensCfg = new Map<number, { kind: string; steps: number; maxSps: number; invert: boolean }>();
  private lensPending: Array<{ axis: number; ms: number; pos: number }> = [];
  private lensCurve: Array<{ axis: number; ms: number; pos: number }> = [];
  /** Where each barrel is, 0..65535. Survives ABORT on purpose. */
  readonly lensPos = new Map<number, number>();
  /** Barrel travel LCAL will report. Settable so tests can drive the failure. */
  calibrationSteps: number | null = 4000;
  /** Drop every Nth uploaded point, to exercise the desync refusal. */
  lensDropEvery: number | null = null;
  private lensSeen = 0;

  /** Everything the device "did", for assertions. */
  readonly performed: Array<{ out: number; wire: string; deviceMs: number; id?: number }> = [];
  /** Set to reject the next ARM with a short count, to test the partial path. */
  acceptLimit: number | null = null;

  /** Overridable so tests can drive the version-mismatch refusal path. */
  constructor(
    public name = "sim-trig",
    public outs = 8,
    public ins = 2,
    public protocol = TRIGGER_PROTOCOL_VERSION,
    public lens = 3,
  ) {}

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
        /* A v1 board has no lens field at all — not a zero. Emitting the field
           anyway would make the v1 path untestable, and the v1 path is the one
           that protects an owner who already built a cue board. */
        this.say(
          `GRAFFIK-TRIG ${this.protocol} ${this.name} ${this.outs} ${this.ins}` +
            (this.protocol >= 2 ? ` ${this.lens}` : ""),
        );
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
        this.lensCurve = [...this.lensPending].sort((a, b) => a.axis - b.axis || a.ms - b.ms);
        this.say(
          `READY ${this.cues.length}` + (this.protocol >= 2 ? ` ${this.lensCurve.length}` : ""),
        );
        break;
      }
      case "LAXIS": {
        const [n, kind, steps, maxSps, invert] = rest;
        /* Refuse an axis this board does not have, exactly as the firmware
           does. A simulator that is more permissive than the hardware is worse
           than no simulator: it turns "passes in tests, fails on the rig" into
           the default outcome. The parity check enforces this pairing. */
        if (Number(n) >= this.lens) { this.say(`ERR no axis ${Number(n)}`); break; }
        this.lensCfg.set(Number(n), {
          kind, steps: Number(steps), maxSps: Number(maxSps), invert: invert === "1",
        });
        this.say(`LAXIS ${Number(n)} OK`);
        break;
      }
      case "LCAL": {
        const n = Number(rest[0]);
        if (n >= this.lens) { this.say(`LCALERR ${n} no such axis`); break; }
        if (this.calibrationSteps === null) { this.say(`LCALERR ${n} barrel did not reach a stop`); break; }
        const cfg = this.lensCfg.get(n);
        if (cfg) cfg.steps = this.calibrationSteps;
        /* A real board ends calibration parked at one stop, and the host has to
           know that — a curve starting mid-barrel would slam on GO otherwise. */
        this.lensPos.set(n, 0);
        this.say(`LCAL ${n} ${this.calibrationSteps}`);
        break;
      }
      case "LCLEAR":
        this.lensPending = []; this.lensCurve = []; this.lensSeen = 0;
        this.say("LCLEAR OK");
        break;
      case "LKEY": {
        const [n, ms, pos] = rest;
        if (Number(n) >= this.lens) break;              // firmware drops it silently
        this.lensSeen++;
        if (this.lensDropEvery && this.lensSeen % this.lensDropEvery === 0) break;   // simulate a lost line
        this.lensPending.push({ axis: Number(n), ms: Number(ms), pos: Number(pos) });
        break;
      }
      case "LSYNC":
        this.say(`LSYNC ${Number(rest[0])} ${this.lensPending.length}`);
        break;
      case "LSEEK": {
        const [n, pos] = rest;
        if (Number(n) >= this.lens) break;
        this.lensPos.set(Number(n), Number(pos));
        break;
      }
      case "GO":
        this.runningFrom = this.clockMs;
        this.nextCue = 0;
        this.say(`STARTED ${this.clockMs}`);
        break;
      case "ABORT":
        this.runningFrom = null; this.cues = []; this.pendingCues = []; this.nextCue = 0;
        /* Lens motion stops and the program is discarded — but `lensPos` is
           NOT touched. ADR-0017 §4: abort holds, never homes, never releases. */
        this.lensPending = []; this.lensCurve = []; this.lensSeen = 0;
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
    /* Lens axes track the uploaded curve by linear interpolation — the same
       thing the firmware's step loop does, and the reason the host is allowed
       to decimate: the error bound is stated against exactly this. */
    for (const axis of new Set(this.lensCurve.map((p) => p.axis))) {
      const pts = this.lensCurve.filter((p) => p.axis === axis);
      this.lensPos.set(axis, interpolateAt(pts, elapsed));
    }
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

  /** Lens position as a travel fraction, for readable assertions. */
  lensTravel(kind: LensAxisKind): number {
    return (this.lensPos.get(LENS_AXIS_INDEX[kind]) ?? 0) / LENS_POS_MAX;
  }
}

/**
 * Where a piecewise-linear curve is at `ms`. Clamps outside its own range,
 * which is the honest behaviour for a lens: before the move starts and after it
 * ends the barrel simply holds the end value rather than extrapolating off the
 * stop.
 */
function interpolateAt(points: Array<{ ms: number; pos: number }>, ms: number): number {
  if (!points.length) return 0;
  if (ms <= points[0].ms) return points[0].pos;
  const last = points[points.length - 1];
  if (ms >= last.ms) return last.pos;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    if (ms >= a.ms && ms <= b.ms) {
      const t = b.ms === a.ms ? 0 : (ms - a.ms) / (b.ms - a.ms);
      return Math.round(a.pos + (b.pos - a.pos) * t);
    }
  }
  return last.pos;
}
