import { describe, it, expect } from "vitest";
import {
  oscString, oscInt32, oscFloat32, encodeOscMessage,
  OscTriggerBackend, SimulatedDatagram,
} from "../src/osc.js";
import { Cue } from "../src/film.js";

const cue = (action: Cue["action"], target = "focus"): Cue => ({ id: "c", atMs: 0, target, action });
const str = (d: Uint8Array) => Array.from(d).map((b) => (b === 0 ? "\\0" : String.fromCharCode(b))).join("");

describe("OSC primitives", () => {
  it("pads a string to a multiple of 4 WITH at least one null", () => {
    // The classic OSC bug: "data" is 4 chars and still occupies 8 bytes.
    expect(oscString("data").length).toBe(8);
    expect(str(oscString("data"))).toBe("data\\0\\0\\0\\0");
    expect(oscString("OSC").length).toBe(4);
    expect(str(oscString("OSC"))).toBe("OSC\\0");
    expect(oscString("").length).toBe(4);
  });

  it("encodes numbers big-endian, like the spec's own example", () => {
    // 440.0 is 0x43DC0000 — the value printed in the OSC 1.0 examples.
    expect(Array.from(oscFloat32(440))).toEqual([0x43, 0xdc, 0x00, 0x00]);
    expect(Array.from(oscInt32(1))).toEqual([0, 0, 0, 1]);
    expect(Array.from(oscInt32(-1))).toEqual([255, 255, 255, 255]);
  });
});

describe("message encoding", () => {
  it("lays out address, type tags, then arguments", () => {
    const m = encodeOscMessage("/oscillator/4/frequency", [440.5]);
    expect(str(m.subarray(0, 24))).toBe("/oscillator/4/frequency\\0");
    expect(str(m.subarray(24, 28))).toBe(",f\\0\\0");
    expect(m.length % 4).toBe(0);
  });

  it("starts the type tag string with a comma, even with no arguments", () => {
    const m = encodeOscMessage("/go");
    expect(str(m)).toBe("/go\\0,\\0\\0\\0");
  });

  it("picks i for integers and f for everything else, and lets you force it", () => {
    expect(str(encodeOscMessage("/a", [1]).subarray(4, 8))).toBe(",i\\0\\0");
    expect(str(encodeOscMessage("/a", [1.5]).subarray(4, 8))).toBe(",f\\0\\0");
    expect(str(encodeOscMessage("/a", [{ float: 1 }]).subarray(4, 8))).toBe(",f\\0\\0");
    expect(str(encodeOscMessage("/a", [{ int: 3 }]).subarray(4, 8))).toBe(",i\\0\\0");
  });

  it("handles mixed argument types in order", () => {
    const m = encodeOscMessage("/a", [1, "hi", 2.5]);
    expect(str(m.subarray(4, 8))).toBe(",isf");
    // "/a\0\0"(4) + ",isf\0\0\0\0"(8 — the tag string pads like any other
    // OSC-string) + int(4) + "hi\0\0"(4) + float(4)
    expect(m.length).toBe(24);
  });

  it("rejects an address that does not start with a slash", () => {
    expect(() => encodeOscMessage("nope")).toThrow(/must start with/);
  });
});

describe("OSC backend", () => {
  const setup = () => {
    const sock = new SimulatedDatagram();
    return { sock, be: new OscTriggerBackend(sock, { host: "10.0.0.5", port: 7000 }) };
  };

  it("is honest that it is host-timed", () => {
    const { be } = setup();
    expect(be.tier).toBe(1);
    expect(be.describe()).toBe("OSC → 10.0.0.5:7000, tier 1 (host-timed)");
  });

  it("sends an osc action to its own address", async () => {
    const { sock, be } = setup();
    await be.fire(cue({ kind: "osc", address: "/lx/go", args: [3] }), 1);
    expect(sock.addressOf(0)).toBe("/lx/go");
    expect(sock.packets[0]).toMatchObject({ host: "10.0.0.5", port: 7000 });
  });

  it("publishes generic actions under a predictable address", async () => {
    const { sock, be } = setup();
    await be.fire(cue({ kind: "level", value: 0.75 }, "focus"), 2);
    expect(sock.addressOf(0)).toBe("/graffik/focus");
    await be.fire(cue({ kind: "pulse", ms: 50 }, "cue-light"), 1);
    expect(sock.addressOf(1)).toBe("/graffik/cue-light");
  });

  it("tells the receiver we stopped, best effort", async () => {
    const { sock, be } = setup();
    await be.abort();
    expect(sock.addressOf(0)).toBe("/graffik/abort");
  });

  it("refuses an action it cannot carry", async () => {
    const { be } = setup();
    expect(be.supports({ kind: "camera" })).toBe(false);
    await expect(be.fire(cue({ kind: "camera" }), 1)).rejects.toThrow(/cannot perform/);
  });

  it("closes its socket", async () => {
    const { sock, be } = setup();
    await be.close();
    expect(sock.closed).toBe(true);
  });
});
