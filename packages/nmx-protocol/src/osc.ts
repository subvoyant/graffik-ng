/**
 * OSC 1.0 output (ADR-0016).
 *
 * Also dependency-free: OSC is a byte format we encode ourselves, and the
 * transport is `node:dgram`, which the main process already has. That makes
 * three of the four practical cue backends free of new dependencies.
 *
 * The format, from the OSC 1.0 spec:
 *
 *   <address pattern : OSC-string> <type tag string : OSC-string> <args…>
 *
 * An **OSC-string** is null-terminated and then padded with more nulls until
 * its length is a multiple of 4 — and there is **always at least one null**, so
 * a 4-character string occupies 8 bytes, not 4. That off-by-one is the classic
 * OSC bug and the reason `oscString` is a named, tested function rather than
 * three inline lines.
 *
 * Numbers are **big-endian**, like the NMX protocol and unlike the Enttec frame
 * header. Each format states its own byte order; none of them are assumed.
 *
 * Tier 1 — UDP to a listener that we do not control, so the host times it.
 */

import { Cue, EventAction } from "./film.js";
import { TriggerBackend, Tier } from "./trigger.js";

/** The seam: `node:dgram` satisfies this, and so does a test double. */
export interface DatagramLike {
  send(data: Uint8Array, port: number, host: string, cb?: (err?: Error | null) => void): void;
  close?(): void;
}

const ascii = (s: string): number[] => {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i) & 0x7f);
  return out;
};

/** Null-terminate and pad to a multiple of 4 — always at least one null. */
export function oscString(s: string): Uint8Array {
  const body = ascii(s);
  const padded = body.length + 4 - (body.length % 4);   // never zero padding
  const out = new Uint8Array(padded);
  out.set(body);
  return out;
}

export function oscInt32(v: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setInt32(0, v | 0, false);    // big-endian
  return out;
}

export function oscFloat32(v: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setFloat32(0, v, false);      // big-endian
  return out;
}

export type OscArg = number | string | { int: number } | { float: number };

/**
 * Encode one OSC message. Plain JS numbers are ambiguous — 1 could be an int or
 * a float — so the rule is stated rather than guessed: integers encode as `i`,
 * anything else as `f`. Wrap in `{int:…}` / `{float:…}` to force it, because
 * some receivers care and silently ignore the wrong type.
 */
export function encodeOscMessage(address: string, args: OscArg[] = []): Uint8Array {
  if (!address.startsWith("/")) throw new Error(`OSC address must start with "/" (got "${address}")`);
  const tags: string[] = [];
  const blobs: Uint8Array[] = [];
  for (const a of args) {
    if (typeof a === "string") { tags.push("s"); blobs.push(oscString(a)); }
    else if (typeof a === "number") {
      if (Number.isInteger(a)) { tags.push("i"); blobs.push(oscInt32(a)); }
      else { tags.push("f"); blobs.push(oscFloat32(a)); }
    } else if ("int" in a) { tags.push("i"); blobs.push(oscInt32(a.int)); }
    else { tags.push("f"); blobs.push(oscFloat32(a.float)); }
  }
  const head = oscString(address);
  const tagStr = oscString("," + tags.join(""));
  const total = head.length + tagStr.length + blobs.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  out.set(head, o); o += head.length;
  out.set(tagStr, o); o += tagStr.length;
  for (const b of blobs) { out.set(b, o); o += b.length; }
  return out;
}

export interface OscOptions {
  host?: string;
  port?: number;
  /** Prefix for cues that carry no explicit address, e.g. "/graffik". */
  addressPrefix?: string;
}

export class OscTriggerBackend implements TriggerBackend {
  readonly id = "osc";
  readonly tier: Tier = 1;

  readonly sent: Array<{ address: string; args: OscArg[]; bytes: Uint8Array }> = [];
  private sock: DatagramLike;
  private host: string;
  private port: number;
  private prefix: string;

  constructor(socket: DatagramLike, opts: OscOptions = {}) {
    this.sock = socket;
    this.host = opts.host ?? "127.0.0.1";
    this.port = opts.port ?? 9000;
    this.prefix = opts.addressPrefix ?? "/graffik";
  }

  describe() { return `OSC → ${this.host}:${this.port}, tier 1 (host-timed)`; }
  /** OSC addresses are names, not numbered outputs; the count is nominal. */
  outputs() { return 512; }

  supports(action: EventAction) {
    return action.kind === "osc" || action.kind === "level" || action.kind === "pulse";
  }

  private emit(address: string, args: OscArg[]) {
    const bytes = encodeOscMessage(address, args);
    this.sent.push({ address, args, bytes });
    this.sock.send(bytes, this.port, this.host);
  }

  /**
   * An `osc` action carries its own address. `level` and `pulse` are generic
   * cue actions, so they are published under `<prefix>/<target>` with a value —
   * a convention the receiving patch can bind to without us inventing one per
   * cue.
   */
  async fire(cue: Cue, output: number) {
    const a = cue.action;
    if (a.kind === "osc") {
      this.emit(a.address, (a.args ?? []) as OscArg[]);
    } else if (a.kind === "level") {
      this.emit(`${this.prefix}/${cue.target}`, [{ float: a.value }, { int: output }]);
    } else if (a.kind === "pulse") {
      this.emit(`${this.prefix}/${cue.target}`, [{ int: 1 }, { int: Math.round(a.ms ?? 30) }]);
    } else {
      throw new Error(`OSC backend cannot perform a "${a.kind}" action`);
    }
  }

  async arm() { return 0; }          // UDP fire-and-forget; nothing to pre-load
  async start() { /* see arm() */ }

  /** Tell the receiver we stopped. Best effort — UDP guarantees nothing. */
  async abort() { this.emit(`${this.prefix}/abort`, [{ int: 1 }]); }

  async close() { this.sock.close?.(); }
}

/** In-memory socket for tests and for the app's own dry-run mode. */
export class SimulatedDatagram implements DatagramLike {
  readonly packets: Array<{ data: Uint8Array; port: number; host: string }> = [];
  closed = false;
  send(data: Uint8Array, port: number, host: string, cb?: (err?: Error | null) => void) {
    this.packets.push({ data, port, host });
    cb?.(null);
  }
  close() { this.closed = true; }
  /** Decode a sent packet's address, for readable assertions. */
  addressOf(i: number): string {
    const d = this.packets[i].data;
    let s = "";
    for (let k = 0; k < d.length && d[k] !== 0; k++) s += String.fromCharCode(d[k]);
    return s;
  }
}
