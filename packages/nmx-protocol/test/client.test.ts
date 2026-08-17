/**
 * NmxClient transport tests against a scripted mock port.
 */
import { describe, expect, it } from "vitest";
import { NmxClient, decodeResponse, handshake } from "../src/client.js";
import { PACKET_HEADER, encodePacket } from "../src/packet.js";
import { broadcast, general, motors } from "../src/commands.js";

type DataListener = (chunk: Uint8Array) => void;

/** Mock port: records writes, lets tests inject device responses. */
class MockPort {
  written: Uint8Array[] = [];
  private listeners: DataListener[] = [];
  /** Optional auto-responder invoked after each write. */
  autoRespond: ((written: Uint8Array) => Uint8Array | null) | null = null;

  write(data: Uint8Array, cb?: (err?: Error | null) => void): void {
    this.written.push(data);
    cb?.(null);
    if (this.autoRespond) {
      const response = this.autoRespond(data);
      if (response) queueMicrotask(() => this.emit(response));
    }
  }
  on(event: "data", listener: DataListener): void {
    if (event === "data") this.listeners.push(listener);
  }
  emit(chunk: Uint8Array): void {
    for (const l of this.listeners) l(chunk);
  }
}

const ack = (ok: boolean) =>
  Uint8Array.from([...PACKET_HEADER, 0x00, 0x00, 0x01, 0x01, ok ? 1 : 0]);

const typedResponse = (type: number, value: number[]) =>
  Uint8Array.from([...PACKET_HEADER, 0x00, 0x00, 0x64, 1 + value.length, type, ...value]);

describe("NmxClient", () => {
  it("serializes commands and matches responses FIFO", async () => {
    const port = new MockPort();
    port.autoRespond = () => ack(true);
    const client = new NmxClient(port);
    const [a, b] = await Promise.all([
      client.send(motors.setEnable(1, true)),
      client.send(motors.setEnable(2, true)),
    ]);
    expect(port.written).toHaveLength(2);
    expect(a?.payload[0]).toBe(1);
    expect(b?.payload[0]).toBe(1);
    // second write must not start before first response arrived (queue depth 1)
    expect(Buffer.from(port.written[0]).toString("hex")).toBe(
      Buffer.from(encodePacket(motors.setEnable(1, true))).toString("hex"),
    );
  });

  it("times out a lost response and continues with the next command", async () => {
    const port = new MockPort();
    const client = new NmxClient(port, { timeoutMs: 20 });
    const first = client.send(motors.queryPosition(1));
    await expect(first).rejects.toThrow(/timeout/);
    port.autoRespond = () => ack(true);
    await expect(client.send(motors.stop(1))).resolves.toBeTruthy();
  });

  it("treats broadcasts as fire-and-forget (no response expected)", async () => {
    const port = new MockPort(); // no auto-responder — would time out if awaited
    const client = new NmxClient(port, { timeoutMs: 20 });
    await expect(client.send(broadcast.stop())).resolves.toBeNull();
    expect(port.written).toHaveLength(1);
  });

  it("suppresses response-wait for jog speed while Graffik mode is on (firmware sends none)", async () => {
    const port = new MockPort();
    port.autoRespond = (w) => (w[8] === 50 ? ack(true) : null); // only ack the mode switch
    const client = new NmxClient(port, { timeoutMs: 20 });
    await client.send(general.setGraffikMode(true));
    // firmware: "Don't send a response in joystick or Graffik modes"
    await expect(client.send(motors.setContinuousSpeed(1, 400))).resolves.toBeNull();
  });

  it("stopAll flushes the queue and jumps to broadcast stops", async () => {
    const port = new MockPort(); // device never responds — queue is stuck
    const client = new NmxClient(port, { timeoutMs: 5000 });
    const stuck = client.send(motors.queryPosition(1));
    stuck.catch(() => {});
    const queued = client.send(motors.queryPosition(2));
    queued.catch(() => {});
    await client.stopAll();
    await expect(stuck).rejects.toThrow(/aborted by stopAll/);
    await expect(queued).rejects.toThrow(/aborted by stopAll/);
    const cmds = port.written.map((w) => [w[6], w[8]]);
    // last two writes: broadcast stop (addr 1 cmd 2), broadcast kf-stop (addr 1 cmd 8)
    expect(cmds.slice(-2)).toEqual([
      [1, 2],
      [1, 8],
    ]);
  });

  it("handshake queries firmware version then enables Graffik mode", async () => {
    const port = new MockPort();
    port.autoRespond = (w) =>
      w[8] === 100 ? typedResponse(3, [0x00, 0x00, 0x00, 0x46]) : ack(true);
    const client = new NmxClient(port);
    const version = await handshake(client);
    expect(version.value).toBe(70);
    expect(port.written.map((w) => w[8])).toEqual([100, 50]);
  });
});

describe("decodeResponse", () => {
  it("decodes typed values including fixed-point floats", () => {
    expect(decodeResponse(Uint8Array.from([1])).value).toBe(true);
    expect(decodeResponse(Uint8Array.from([0])).value).toBe(false);
    expect(decodeResponse(Uint8Array.from([0, 42])).value).toBe(42);
    expect(decodeResponse(Uint8Array.from([1, 0x0f, 0xff])).value).toBe(0x0fff);
    expect(decodeResponse(Uint8Array.from([3, 0xff, 0xff, 0xff, 0xfe])).value).toBe(-2);
    // fixed-point "float": 1234 / 100 = 12.34 (e.g. 12.34 V supply)
    expect(decodeResponse(Uint8Array.from([5, 0x00, 0x00, 0x04, 0xd2])).value).toBe(12.34);
    expect(decodeResponse(Uint8Array.from([6, 0x4e, 0x4d, 0x58])).value).toBe("NMX");
  });
});
