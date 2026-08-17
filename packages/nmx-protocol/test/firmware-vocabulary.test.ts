/**
 * Vocabulary tests derived from the firmware dispatch source
 * (OM_Serial_Com_Client.ino @ nanoMoCo_Firmware master) — covering commands
 * that have no example packet in Sample Commands.txt: the jog/record/replay
 * primitives, the key-frame engine, and broadcasts.
 */
import { describe, expect, it } from "vitest";
import { broadcast, encodePacket, general, keyFrame, motors } from "../src/index.js";

const hexOf = (p: Parameters<typeof encodePacket>[0]) => Buffer.from(encodePacket(p)).toString("hex");
const want = (s: string) => s.replace(/\s+/g, "").toLowerCase();

describe("jog primitives (serMotor/serMain)", () => {
  it("continuous-speed jog is float32 big-endian (Node.ntof)", () => {
    // 500.0 steps/s = IEEE754 0x43FA0000
    expect(hexOf(motors.setContinuousSpeed(1, 500))).toBe(want("00 00 00 00 00 FF 03 01 0D 04 43 FA 00 00"));
    // negative speed = reverse direction: -500.0 = 0xC3FA0000
    expect(hexOf(motors.setContinuousSpeed(2, -500))).toBe(want("00 00 00 00 00 FF 03 02 0D 04 C3 FA 00 00"));
  });

  it("joystick watchdog + joystick mode + graffik mode", () => {
    expect(hexOf(general.setJoystickWatchdog(true))).toBe(want("00 00 00 00 00 FF 03 00 0E 01 01"));
    expect(hexOf(general.setJoystickMode(true))).toBe(want("00 00 00 00 00 FF 03 00 17 01 01"));
    expect(hexOf(general.setGraffikMode(true))).toBe(want("00 00 00 00 00 FF 03 00 32 01 01"));
  });
});

describe("record/replay primitives (the multiplicity core)", () => {
  it("jog-to-set: start/stop points at current position, all axes (serMain 26/27)", () => {
    expect(hexOf(general.setStartHere())).toBe(want("00 00 00 00 00 FF 03 00 1A 00"));
    expect(hexOf(general.setStopHere())).toBe(want("00 00 00 00 00 FF 03 00 1B 00"));
  });

  it("reset pass: all motors to program start (serMain 25)", () => {
    expect(hexOf(general.sendAllToStart())).toBe(want("00 00 00 00 00 FF 03 00 19 00"));
  });

  it("per-motor send-to-start is cmd 23 in current firmware (2015 app's 25 is now lead-out)", () => {
    expect(hexOf(motors.sendToProgramStart(1))).toBe(want("00 00 00 00 00 FF 03 01 17 00"));
    expect(hexOf(motors.setLeadOut(1, 0))).toBe(want("00 00 00 00 00 FF 03 01 19 04 00 00 00 00"));
  });

  it("travel time + program accel/decel (continuous mode repeatability parameters)", () => {
    expect(hexOf(motors.setTravel(1, 30000))).toBe(want("00 00 00 00 00 FF 03 01 14 04 00 00 75 30"));
    expect(hexOf(motors.setProgramAccel(1, 2000))).toBe(want("00 00 00 00 00 FF 03 01 15 04 00 00 07 D0"));
    expect(hexOf(motors.setProgramDecel(1, 2000))).toBe(want("00 00 00 00 00 FF 03 01 16 04 00 00 07 D0"));
  });

  it("start delay for performer cueing (serMain 21)", () => {
    expect(hexOf(general.setStartDelay(5000))).toBe(want("00 00 00 00 00 FF 03 00 15 04 00 00 13 88"));
  });
});

describe("key-frame engine (sub-address 5, serKeyFrame)", () => {
  it("axis select and KF count are int16 (Node.ntoi)", () => {
    expect(hexOf(keyFrame.setAxis(0))).toBe(want("00 00 00 00 00 FF 03 05 0A 02 00 00"));
    expect(hexOf(keyFrame.setKeyFrameCount(3))).toBe(want("00 00 00 00 00 FF 03 05 0B 02 00 03"));
  });

  it("abscissa/position/velocity are float32 (Node.ntof)", () => {
    // x = 1000.0 -> 0x447A0000 ; pos = 2000.0 -> 0x44FA0000 ; v = 0.0
    expect(hexOf(keyFrame.setNextAbscissa(1000))).toBe(want("00 00 00 00 00 FF 03 05 0C 04 44 7A 00 00"));
    expect(hexOf(keyFrame.setNextPosition(2000))).toBe(want("00 00 00 00 00 FF 03 05 0D 04 44 FA 00 00"));
    expect(hexOf(keyFrame.setNextVelocity(0))).toBe(want("00 00 00 00 00 FF 03 05 0E 04 00 00 00 00"));
  });

  it("transport controls", () => {
    expect(hexOf(keyFrame.endTransmission())).toBe(want("00 00 00 00 00 FF 03 05 10 00"));
    expect(hexOf(keyFrame.run())).toBe(want("00 00 00 00 00 FF 03 05 14 00"));
    expect(hexOf(keyFrame.pause())).toBe(want("00 00 00 00 00 FF 03 05 15 00"));
    expect(hexOf(keyFrame.stop())).toBe(want("00 00 00 00 00 FF 03 05 16 00"));
    expect(hexOf(keyFrame.queryRunState())).toBe(want("00 00 00 00 00 FF 03 05 78 00"));
    expect(hexOf(keyFrame.queryPercentComplete())).toBe(want("00 00 00 00 00 FF 03 05 7B 00"));
  });
});

describe("broadcasts (address 1, OMMoCoDefs.h)", () => {
  it("e-stop primitives: broadcast stop / kf-stop", () => {
    expect(hexOf(broadcast.stop())).toBe(want("00 00 00 00 00 FF 01 00 02 00"));
    expect(hexOf(broadcast.kfStop())).toBe(want("00 00 00 00 00 FF 01 00 08 00"));
  });

  it("start / pause / graffik-usb / assign address", () => {
    expect(hexOf(broadcast.start())).toBe(want("00 00 00 00 00 FF 01 00 01 00"));
    expect(hexOf(broadcast.pause())).toBe(want("00 00 00 00 00 FF 01 00 03 00"));
    expect(hexOf(broadcast.graffikModeUsb())).toBe(want("00 00 00 00 00 FF 01 00 05 00"));
    expect(hexOf(broadcast.assignAddress(3))).toBe(want("00 00 00 00 00 FF 01 00 04 01 03"));
  });
});
