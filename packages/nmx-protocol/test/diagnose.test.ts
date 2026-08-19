import { describe, it, expect } from "vitest";
import {
  probeNmx, explainProbe, PROBE_ADDRESSES,
  judgePort, judgePorts, noUsablePortAdvice,
  SimulatedNmx, PortLike, AddressProbe,
} from "../src/index.js";

const probe = (over: Partial<AddressProbe> = {}): AddressProbe =>
  ({ address: 3, answered: false, firmware: null, bytesSeen: 0, ...over });

/** A port that opens and says nothing — a dead link. */
class SilentPort implements PortLike {
  write() { return true; }
  on() { return this; }
  off() { return this; }
}
/** A port that returns bytes that never form a frame — a baud mismatch. */
class NoisyPort implements PortLike {
  private listeners: Array<(d: Uint8Array) => void> = [];
  write() {
    const junk = Uint8Array.from([0x5a, 0xa5, 0x13, 0x7f, 0xe1]);
    for (const fn of this.listeners) fn(junk);
    return true;
  }
  on(_e: "data", fn: (d: Uint8Array) => void) { this.listeners.push(fn); return this; }
  off(_e: "data", fn: (d: Uint8Array) => void) {
    const i = this.listeners.indexOf(fn); if (i >= 0) this.listeners.splice(i, 1);
    return this;
  }
}

describe("explaining the evidence", () => {
  it("calls a default-address answer good", () => {
    const r = explainProbe([probe({ answered: true, firmware: 70 })]);
    expect(r.verdict).toBe("ok");
    expect(r.headline).toMatch(/link is good/);
    expect(r.steps).toEqual([]);
  });

  it("flags a firmware the build was not written against, without refusing it", () => {
    const r = explainProbe([probe({ answered: true, firmware: 64 })], { expectedFirmware: 70 });
    expect(r.verdict).toBe("ok");
    expect(r.headline).toMatch(/firmware v64.*written against v70/);
    expect(r.steps.join(" ")).toMatch(/ADR-0004/);
  });

  /** The failure that is completely opaque without this: a legitimate,
      deliberate configuration that presents as a dead link. */
  it("names a non-default address that answered", () => {
    const r = explainProbe([probe({ address: 3 }), probe({ address: 5, answered: true, firmware: 70 })]);
    expect(r.verdict).toBe("wrong-address");
    expect(r.answeringAddress).toBe(5);
    expect(r.headline).toMatch(/Address 5 answered/);
    expect(r.steps.join(" ")).toMatch(/two controllers share a bus/);
  });

  /**
   * The distinction the whole file exists for: silence means nothing is
   * talking; garbage means something is and we cannot hear it.
   */
  it("reads unparseable bytes as a speed mismatch, not a dead link", () => {
    const r = explainProbe([probe({ bytesSeen: 40 })]);
    expect(r.verdict).toBe("noise");
    expect(r.steps[0]).toMatch(/baud mismatch.*19200/);
  });

  it("reads total silence as power, cable or mode", () => {
    const r = explainProbe([probe(), probe({ address: 5 })]);
    expect(r.verdict).toBe("silence");
    const all = r.steps.join(" ");
    expect(all).toMatch(/powered/);
    expect(all).toMatch(/Charge-only/);
    expect(all).toMatch(/BLE/);
    // and it rules out the thing it already checked, so nobody re-checks it
    expect(all).toMatch(/non-default address is not the cause/);
  });

  it("mentions Bluetooth only when the chosen port looks like one", () => {
    expect(explainProbe([probe()], { portLooksLikeBluetooth: true }).steps[0]).toMatch(/Bluetooth serial port/);
    expect(explainProbe([probe()]).steps[0]).not.toMatch(/Bluetooth/);
  });
});

describe("probing a port", () => {
  it("finds a simulator at the default address", async () => {
    const r = await probeNmx(new SimulatedNmx(), { timeoutMs: 60, expectedFirmware: 70 });
    expect(r.verdict).toBe("ok");
    expect(r.answeringAddress).toBe(3);
    expect(r.firmware).toBe(70);
    expect(r.probes).toHaveLength(1);          // stops as soon as one answers
  });

  it("finds a device that has been moved to another address", async () => {
    const sim = new SimulatedNmx();
    sim.address = 5;
    const r = await probeNmx(sim, { timeoutMs: 60 });
    expect(r.verdict).toBe("wrong-address");
    expect(r.answeringAddress).toBe(5);
  });

  it("reports silence, having actually asked every address", async () => {
    const r = await probeNmx(new SilentPort(), { timeoutMs: 20 });
    expect(r.verdict).toBe("silence");
    expect(r.bytesSeen).toBe(0);
    expect(r.probes.map((p) => p.address)).toEqual([...PROBE_ADDRESSES]);
  });

  it("reports noise when bytes come back that are not packets", async () => {
    const r = await probeNmx(new NoisyPort(), { timeoutMs: 20 });
    expect(r.verdict).toBe("noise");
    expect(r.bytesSeen).toBeGreaterThan(0);
  });

  it("detaches its tap — a probe must not leave a listener behind", async () => {
    const sim = new SimulatedNmx();
    let attached = 0;
    const realOn = sim.on.bind(sim), realOff = sim.off.bind(sim);
    sim.on = ((e: "data", fn: (d: Uint8Array) => void) => { attached++; return realOn(e, fn); }) as typeof sim.on;
    sim.off = ((e: "data", fn: (d: Uint8Array) => void) => { attached--; return realOff(e, fn); }) as typeof sim.off;
    await probeNmx(sim, { timeoutMs: 60 });
    // the client keeps its own listener; the probe's tap must be gone
    expect(attached).toBe(1);
  });
});

describe("triaging the port list before opening anything", () => {
  it("never suggests a Bluetooth or debug port", () => {
    for (const p of ["/dev/cu.Bluetooth-Incoming-Port", "/dev/cu.wlan-debug", "/dev/tty.debug-console"]) {
      expect(judgePort(p).likelihood).toBe("never");
    }
  });

  it("recognises the usual USB serial names", () => {
    for (const p of ["/dev/tty.usbserial-A906", "/dev/cu.usbmodem14201", "/dev/cu.wchusbserial1420"]) {
      expect(judgePort(p).likelihood).toBe("likely");
    }
  });

  it("uses the manufacturer when the path is uninformative", () => {
    const j = judgePort("/dev/ttyS3", "FTDI");
    expect(j.likelihood).toBe("likely");
    expect(j.why).toMatch(/FTDI/);
  });

  it("does not rule out something it simply does not recognise", () => {
    expect(judgePort("/dev/ttyACM0").likelihood).toBe("unlikely");
  });

  it("knows the simulator is fine to pick", () => {
    expect(judgePort("simulator://nmx").likelihood).toBe("likely");
  });

  it("says something useful when nothing in the list is worth trying", () => {
    const only = judgePorts([{ path: "/dev/cu.Bluetooth-Incoming-Port" }]);
    expect(noUsablePortAdvice(only)).toMatch(/every entry looks like Bluetooth/);
    expect(noUsablePortAdvice([])).toMatch(/No serial ports at all/);
    expect(noUsablePortAdvice(judgePorts([{ path: "/dev/tty.usbserial-1" }]))).toBeNull();
  });
});
