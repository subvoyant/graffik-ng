/**
 * Byte-exact validation against Sample Commands.txt from
 * DynamicPerception/nanoMoCo_Firmware/Firmware/Motion_Engine.
 *
 * Every expected byte string below is copied verbatim from that file —
 * these are the packets Dynamic Perception themselves used to exercise
 * the NMX. If these pass, our codec speaks the same dialect as the firmware.
 */
import { describe, expect, it } from "vitest";
import { ResponseParser, encodePacket, general, motors, cam } from "../src/index.js";

const hex = (s: string): Uint8Array =>
  Uint8Array.from(s.trim().split(/\s+/).map((b) => parseInt(b, 16)));

const enc = (p: Parameters<typeof encodePacket>[0]) => Buffer.from(encodePacket(p)).toString("hex");
const want = (s: string) => Buffer.from(hex(s)).toString("hex");

describe("Sample Commands.txt byte-exact packets", () => {
  it("enable motor 1/2/3", () => {
    expect(enc(motors.setEnable(1, true))).toBe(want("00 00 00 00 00 FF 03 01 03 01 01"));
    expect(enc(motors.setEnable(2, true))).toBe(want("00 00 00 00 00 FF 03 02 03 01 01"));
    expect(enc(motors.setEnable(3, true))).toBe(want("00 00 00 00 00 FF 03 03 03 01 01"));
  });

  it("microstep level 16 motor 3", () => {
    expect(enc(motors.setMicrosteps(3, 16))).toBe(want("00 00 00 00 00 FF 03 03 06 01 10"));
  });

  it("direction 1 motor 3", () => {
    expect(enc(motors.setDirection(3, 1))).toBe(want("00 00 00 00 00 FF 03 03 08 01 01"));
  });

  it("send motor 3 home", () => {
    expect(enc(motors.sendHome(3))).toBe(want("00 00 00 00 00 FF 03 03 0B 00"));
  });

  it("simple move 1000 steps on each motor", () => {
    expect(enc(motors.move(1, 1, 1000))).toBe(want("00 00 00 00 00 FF 03 01 0F 05 01 00 00 03 E8"));
    expect(enc(motors.move(2, 1, 1000))).toBe(want("00 00 00 00 00 FF 03 02 0F 05 01 00 00 03 E8"));
    expect(enc(motors.move(3, 1, 1000))).toBe(want("00 00 00 00 00 FF 03 03 0F 05 01 00 00 03 E8"));
  });

  it("read motor 1 microsteps", () => {
    expect(enc(motors.queryMicrosteps(1))).toBe(want("00 00 00 00 00 FF 03 01 66 00"));
  });

  it("enable camera", () => {
    expect(enc(cam.setEnable(true))).toBe(want("00 00 00 00 00 FF 03 04 02 01 01"));
  });

  it("set interval to 1 second", () => {
    expect(enc(cam.setInterval(1000))).toBe(want("00 00 00 00 00 FF 03 04 0A 04 00 00 03 E8"));
  });

  it("max shots 16", () => {
    expect(enc(cam.setMaxShots(16))).toBe(want("00 00 00 00 00 FF 03 04 06 02 00 10"));
  });

  it("max step speed motor 1", () => {
    expect(enc(motors.setMaxStepSpeed(1, 0x0fff))).toBe(want("00 00 00 00 00 FF 03 01 07 02 0F FF"));
  });

  it("start / stop program", () => {
    expect(enc(general.startProgram())).toBe(want("00 00 00 00 00 FF 03 00 02 00"));
    expect(enc(general.stopProgram())).toBe(want("00 00 00 00 00 FF 03 00 04 00"));
  });

  it("voltage / current queries", () => {
    expect(enc(general.queryVoltage())).toBe(want("00 00 00 00 00 FF 03 00 6B 00"));
    expect(enc(general.queryCurrent())).toBe(want("00 00 00 00 00 FF 03 00 6C 00"));
  });

  it("get position motor 1", () => {
    expect(enc(motors.queryPosition(1))).toBe(want("00 00 00 00 00 FF 03 01 6A 00"));
  });

  it("set start / stop position", () => {
    expect(enc(motors.setProgramStartPoint(1, 2000))).toBe(want("00 00 00 00 00 FF 03 01 10 04 00 00 07 D0"));
    expect(enc(motors.setProgramStopPoint(1, 5000))).toBe(want("00 00 00 00 00 FF 03 01 11 04 00 00 13 88"));
  });

  it("set SMS mode (deviates from stale Sample Commands.txt: firmware serMain dispatches program mode at cmd 22 = 0x16, not 0x22)", () => {
    expect(enc(general.setProgramMode(0))).toBe(want("00 00 00 00 00 FF 03 00 16 01 00"));
  });

  it("set ramping mode quadratic on motor 1", () => {
    expect(enc(motors.setEasing(1, 2))).toBe(want("00 00 00 00 00 FF 03 01 12 01 02"));
  });
});

describe("ResponseParser", () => {
  it("parses a response split across chunks and skips leading garbage", () => {
    const parser = new ResponseParser();
    const response = hex("AA BB 00 00 00 00 00 FF 03 00 64 03 01 00 46");
    expect(parser.push(response.slice(0, 9))).toHaveLength(0);
    const packets = parser.push(response.slice(9));
    expect(packets).toHaveLength(1);
    expect(packets[0].address).toBe(3);
    expect(packets[0].subAddress).toBe(0);
    expect(packets[0].command).toBe(0x64);
    expect(Array.from(packets[0].payload)).toEqual([0x01, 0x00, 0x46]);
  });

  it("parses two back-to-back packets", () => {
    const parser = new ResponseParser();
    const two = hex("00 00 00 00 00 FF 03 01 03 01 01 00 00 00 00 00 FF 03 02 03 01 00");
    const packets = parser.push(two);
    expect(packets).toHaveLength(2);
    expect(packets[0].subAddress).toBe(1);
    expect(packets[1].subAddress).toBe(2);
    expect(packets[1].payload[0]).toBe(0);
  });
});
