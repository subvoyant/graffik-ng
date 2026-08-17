import { describe, it, expect } from "vitest";
import {
  enttecFrame, dmxPayload, DmxUniverse, DmxTriggerBackend, SimulatedEnttecDevice,
  ENTTEC_SOM, ENTTEC_EOM, LABEL_OUTPUT_DMX, DMX_MIN_CHANNELS, DMX_MAX_CHANNELS,
} from "../src/dmx.js";
import { Cue } from "../src/film.js";

const cue = (action: Cue["action"], id = "c"): Cue => ({ id, atMs: 0, target: "t", action });

/** Deterministic timers: nothing fires until the test says so. */
function fakeClock() {
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let now = 0;
  return {
    nowFn: () => now,
    setTimeoutFn: (fn: () => void, ms: number) => { const h = ++seq; timers.set(h, { at: now + ms, fn }); return h; },
    clearTimeoutFn: (h: unknown) => { timers.delete(h as number); },
    advance(ms: number) {
      now += ms;
      for (const [h, t] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at <= now) { timers.delete(h); t.fn(); }
      }
    },
    get pending() { return timers.size; },
  };
}

describe("Enttec framing", () => {
  it("wraps a payload in 0x7E … 0xE7 with a LITTLE-endian length", () => {
    const f = enttecFrame(LABEL_OUTPUT_DMX, new Uint8Array([1, 2, 3]));
    expect(Array.from(f)).toEqual([ENTTEC_SOM, 6, 3, 0, 1, 2, 3, ENTTEC_EOM]);
  });

  it("splits a length over 255 across LSB then MSB", () => {
    // 513 = 0x0201 -> LSB 0x01, MSB 0x02. The one little-endian field in the
    // codebase; the NMX is big-endian and the two must not bleed together.
    const f = enttecFrame(LABEL_OUTPUT_DMX, new Uint8Array(513));
    expect([f[2], f[3]]).toEqual([0x01, 0x02]);
    expect(f.length).toBe(513 + 5);
  });

  it("puts the DMX start code first, so channel N lands at payload[N]", () => {
    const ch = new Uint8Array(DMX_MAX_CHANNELS);
    ch[11] = 200;                       // channel 12
    const p = dmxPayload(ch);
    expect(p[0]).toBe(0);               // start code
    expect(p[12]).toBe(200);
    expect(p.length).toBe(DMX_MAX_CHANNELS + 1);
  });

  it("pads a short universe up to the widget's minimum rather than truncating", () => {
    expect(dmxPayload(new Uint8Array(4)).length).toBe(DMX_MIN_CHANNELS + 1);
  });
});

describe("universe state", () => {
  it("holds values and reports change — DMX is state, not events", () => {
    const u = new DmxUniverse();
    expect(u.set(12, 255)).toBe(true);
    expect(u.get(12)).toBe(255);
    expect(u.set(12, 255)).toBe(false);      // no change, no frame needed
  });

  it("clamps values and rejects channels outside 1..512", () => {
    const u = new DmxUniverse();
    u.set(1, 999); expect(u.get(1)).toBe(255);
    u.set(1, -5); expect(u.get(1)).toBe(0);
    expect(() => u.set(0, 1)).toThrow(/1\.\.512/);
    expect(() => u.set(513, 1)).toThrow(/1\.\.512/);
  });

  it("blackout zeroes everything", () => {
    const u = new DmxUniverse();
    u.set(5, 200); u.blackout();
    expect(u.get(5)).toBe(0);
  });
});

describe("DMX backend", () => {
  const setup = () => {
    const clock = fakeClock();
    const dev = new SimulatedEnttecDevice();
    const be = new DmxTriggerBackend(dev, {
      nowFn: clock.nowFn, setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn,
      minFrameIntervalMs: 25,
    });
    return { clock, dev, be };
  };

  it("is honest that it is host-timed", () => {
    const { be } = setup();
    expect(be.tier).toBe(1);
    expect(be.describe()).toMatch(/tier 1/);
  });

  it("sends a channel value the widget can read back", async () => {
    const { dev, be } = setup();
    await be.fire(cue({ kind: "dmx", channel: 12, value: 200 }), 1);
    expect(dev.universes).toHaveLength(1);
    expect(dev.channel(12)).toBe(200);
    expect(dev.labels).toEqual([LABEL_OUTPUT_DMX]);
  });

  it("maps a level action onto the bound output channel", async () => {
    const { dev, be } = setup();
    await be.fire(cue({ kind: "level", value: 0.5 }), 7);
    expect(dev.channel(7)).toBe(128);
  });

  it("a dmx action's own channel wins over the binding", async () => {
    const { dev, be } = setup();
    await be.fire(cue({ kind: "dmx", channel: 100, value: 55 }), 3);
    expect(dev.channel(100)).toBe(55);
    expect(dev.channel(3)).toBe(0);
  });

  it("releases a pulse on its own — nothing else will, because DMX holds", async () => {
    const { clock, dev, be } = setup();
    await be.fire(cue({ kind: "pulse", ms: 40 }), 4);
    expect(dev.channel(4)).toBe(255);
    clock.advance(39);
    expect(dev.channel(4)).toBe(255);
    clock.advance(2);
    expect(dev.channel(4)).toBe(0);
  });

  it("coalesces a burst into one frame instead of flooding the widget", async () => {
    const { clock, dev, be } = setup();
    await be.fire(cue({ kind: "dmx", channel: 1, value: 10 }), 1);   // sends now
    expect(dev.universes).toHaveLength(1);
    await be.fire(cue({ kind: "dmx", channel: 2, value: 20 }), 1);   // too soon
    await be.fire(cue({ kind: "dmx", channel: 3, value: 30 }), 1);
    expect(dev.universes).toHaveLength(1);
    clock.advance(25);
    expect(dev.universes).toHaveLength(2);
    expect(dev.channel(2)).toBe(20);
    expect(dev.channel(3)).toBe(30);     // both changes in the one frame
  });

  it("refuses an action it cannot perform rather than sending something wrong", async () => {
    const { be } = setup();
    expect(be.supports({ kind: "dmx", channel: 1, value: 1 })).toBe(true);
    expect(be.supports({ kind: "camera" })).toBe(false);
    await expect(be.fire(cue({ kind: "camera" }), 1)).rejects.toThrow(/cannot perform/);
  });

  it("blacks out on abort — a cue system that leaves a lamp lit has not stopped", async () => {
    const { clock, dev, be } = setup();
    await be.fire(cue({ kind: "dmx", channel: 9, value: 255 }), 1);
    expect(dev.channel(9)).toBe(255);
    await be.abort();
    expect(dev.channel(9)).toBe(0);
    expect(clock.pending).toBe(0);       // and no pulse timer survives it
  });

  it("cancels a pending pulse release on abort", async () => {
    const { clock, be } = setup();
    await be.fire(cue({ kind: "pulse", ms: 500 }), 2);
    expect(clock.pending).toBe(1);
    await be.abort();
    expect(clock.pending).toBe(0);
  });
});

describe("simulated widget parsing", () => {
  it("reassembles a frame split across writes", () => {
    const dev = new SimulatedEnttecDevice();
    const frame = enttecFrame(LABEL_OUTPUT_DMX, dmxPayload(new Uint8Array(DMX_MAX_CHANNELS)));
    dev.write(frame.subarray(0, 7));
    expect(dev.universes).toHaveLength(0);
    dev.write(frame.subarray(7));
    expect(dev.universes).toHaveLength(1);
  });

  it("tolerates leading garbage before the start delimiter", () => {
    const dev = new SimulatedEnttecDevice();
    const ch = new Uint8Array(DMX_MAX_CHANNELS); ch[0] = 77;
    dev.write(new Uint8Array([0x11, 0x22]));
    dev.write(enttecFrame(LABEL_OUTPUT_DMX, dmxPayload(ch)));
    expect(dev.channel(1)).toBe(77);
  });
});
