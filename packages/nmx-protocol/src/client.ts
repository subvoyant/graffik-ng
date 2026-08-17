/**
 * NmxClient — queued request/response transport over any serial-port-like
 * duplex. Deliberately decoupled from node-serialport: the Electron main
 * process (or a CLI, or a test) supplies a PortLike, so this package stays
 * dependency-free and headless-testable.
 *
 * Protocol behavior encoded here (from firmware source):
 *  - Strict one-command-at-a-time: every non-broadcast command gets a
 *    success/fail or query response; we serialize writes and match responses
 *    FIFO to the oldest pending request.
 *  - Broadcasts (address 1) never receive responses.
 *  - setContinuousSpeed (motor cmd 13) receives NO response while joystick or
 *    Graffik mode is active — the client tracks those mode bits and treats
 *    jog-speed writes as fire-and-forget accordingly.
 *  - stopAll() is the e-stop: it flushes the queue, fails pending requests,
 *    and writes broadcast stop + KF-stop immediately, jumping any backlog.
 *  - USB serial: 19200 baud, 8N1 (configure on the SerialPort you pass in).
 */

import { Packet, ResponseParser, encodePacket } from "./packet.js";
import { broadcast, general } from "./commands.js";

export interface PortLike {
  write(data: Uint8Array, cb?: (err?: Error | null) => void): unknown;
  on(event: "data", listener: (chunk: Uint8Array) => void): unknown;
  off?(event: "data", listener: (chunk: Uint8Array) => void): unknown;
}

export interface NmxClientOptions {
  /** Response timeout per command, ms. Default 500. */
  timeoutMs?: number;
}

interface Pending {
  packet: Packet;
  resolve: (response: Packet | null) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

/** Query response value types (PDF "Query Value Types" table). */
export const enum ValueType {
  Byte = 0,
  UInt = 1,
  Int = 2,
  Long = 3,
  ULong = 4,
  Float = 5,
  String = 6,
}

export interface DecodedResponse {
  type: ValueType | null;
  value: number | string | boolean | null;
  raw: Uint8Array;
}

/**
 * Decode a query response payload: <type byte><big-endian value>.
 * "Float" values are fixed-point: transmitted as long ×100 (per the official
 * spec sheet note) — divided back here.
 */
export function decodeResponse(payload: Uint8Array): DecodedResponse {
  if (payload.length === 0) return { type: null, value: null, raw: payload };
  if (payload.length === 1) {
    // set/action ack: 0x01 success / 0x00 fail
    return { type: ValueType.Byte, value: payload[0] !== 0, raw: payload };
  }
  const type = payload[0] as ValueType;
  const data = payload.subarray(1);
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  switch (type) {
    case ValueType.Byte:
      return { type, value: data[0], raw: payload };
    case ValueType.UInt:
      return { type, value: dv.getUint16(0, false), raw: payload };
    case ValueType.Int:
      return { type, value: dv.getInt16(0, false), raw: payload };
    case ValueType.Long:
      return { type, value: dv.getInt32(0, false), raw: payload };
    case ValueType.ULong:
      return { type, value: dv.getUint32(0, false), raw: payload };
    case ValueType.Float:
      return { type, value: dv.getInt32(0, false) / 100, raw: payload };
    case ValueType.String:
      return { type, value: new TextDecoder().decode(data), raw: payload };
    default:
      return { type, value: null, raw: payload };
  }
}

export class NmxClient {
  private readonly port: PortLike;
  private readonly timeoutMs: number;
  private readonly parser = new ResponseParser();
  private readonly queue: Pending[] = [];
  private inFlight: Pending | null = null;
  private graffikMode = false;
  private joystickMode = false;

  constructor(port: PortLike, options: NmxClientOptions = {}) {
    this.port = port;
    this.timeoutMs = options.timeoutMs ?? 500;
    port.on("data", (chunk) => this.onData(chunk));
  }

  /**
   * Send a command; resolves with the response packet, or null for
   * fire-and-forget commands (broadcasts, jog-speed while in live mode).
   */
  send(packet: Packet): Promise<Packet | null> {
    if (this.isFireAndForget(packet)) {
      this.trackModes(packet);
      return new Promise((resolve, reject) => {
        this.port.write(encodePacket(packet), (err) => (err ? reject(err) : resolve(null)));
      });
    }
    return new Promise<Packet | null>((resolve, reject) => {
      this.queue.push({ packet, resolve, reject, timer: null });
      this.pump();
    });
  }

  /** Send a query and decode its typed response value. */
  async query(packet: Packet): Promise<DecodedResponse> {
    const res = await this.send(packet);
    if (!res) throw new Error("no response (fire-and-forget packet passed to query)");
    return decodeResponse(res.payload);
  }

  /**
   * E-STOP. Flushes everything and broadcasts stop for both engines.
   * Broadcasts get no responses, so this cannot block on the device.
   */
  async stopAll(): Promise<void> {
    const pendingError = new Error("aborted by stopAll");
    if (this.inFlight) {
      if (this.inFlight.timer) clearTimeout(this.inFlight.timer);
      this.inFlight.reject(pendingError);
      this.inFlight = null;
    }
    for (const p of this.queue.splice(0)) p.reject(pendingError);
    await this.send(broadcast.stop());
    await this.send(broadcast.kfStop());
  }

  private isFireAndForget(packet: Packet): boolean {
    if (packet.address === 1) return true; // broadcasts: nodes never respond
    const isJogSpeed = packet.subAddress >= 1 && packet.subAddress <= 3 && packet.command === 13;
    return isJogSpeed && (this.graffikMode || this.joystickMode);
  }

  private trackModes(packet: Packet): void {
    if (packet.address === 1 && packet.command === 5) this.graffikMode = true; // OM_GRAFFIK_MODE_USB
  }

  private pump(): void {
    if (this.inFlight || this.queue.length === 0) return;
    const pending = this.queue.shift()!;
    this.inFlight = pending;
    this.trackModesFromAddressed(pending.packet);
    this.port.write(encodePacket(pending.packet), (err) => {
      if (err) {
        this.inFlight = null;
        pending.reject(err instanceof Error ? err : new Error(String(err)));
        this.pump();
      }
    });
    pending.timer = setTimeout(() => {
      if (this.inFlight === pending) {
        this.inFlight = null;
        pending.reject(new Error(`timeout after ${this.timeoutMs}ms: subaddr ${pending.packet.subAddress} cmd ${pending.packet.command}`));
        this.pump();
      }
    }, this.timeoutMs);
  }

  private trackModesFromAddressed(packet: Packet): void {
    if (packet.subAddress === 0 && packet.command === 50) this.graffikMode = packet.payload[0] !== 0;
    if (packet.subAddress === 0 && packet.command === 23) this.joystickMode = packet.payload[0] !== 0;
  }

  private onData(chunk: Uint8Array): void {
    for (const response of this.parser.push(chunk)) {
      const pending = this.inFlight;
      if (!pending) continue; // unsolicited/late packet — drop
      if (pending.timer) clearTimeout(pending.timer);
      this.inFlight = null;
      pending.resolve(response);
      this.pump();
    }
  }
}

/** Convenience: the connect-time handshake every session should run. */
export async function handshake(client: NmxClient): Promise<DecodedResponse> {
  const version = await client.query(general.queryFirmwareVersion());
  await client.send(general.setGraffikMode(true));
  return version;
}
