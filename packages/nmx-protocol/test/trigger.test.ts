import { describe, it, expect, vi } from "vitest";
import { newFilm, buildCueList, Cue, Timebase } from "../src/index.js";
import {
  SimulatedTriggerBackend, SerialTriggerBackend, SimulatedTriggerDevice,
  CueScheduler, TargetBinding, actionToWire, TRIGGER_PROTOCOL_VERSION,
} from "../src/trigger.js";

const TB_24: Timebase = { num: 24, den: 1, dropFrame: false };

function cuedMove() {
  const f = newFilm("Cued", 240, TB_24);
  f.events = [
    { id: "flash", frame: 0, target: "cue-light", action: { kind: "pulse", ms: 40 } },
    { id: "focus", frame: 48, target: "focus", action: { kind: "level", value: 0.5 } },
    { id: "house", frame: 120, target: "house", action: { kind: "dmx", channel: 12, value: 255 } },
  ];
  return f;
}

const BINDINGS: TargetBinding[] = [
  { target: "cue-light", backendId: "simulated", output: 1 },
  { target: "focus", backendId: "simulated", output: 2 },
  { target: "house", backendId: "simulated", output: 3 },
];
const resolver = (bindings: TargetBinding[]) => (t: string) => bindings.find((b) => b.target === t);

describe("action wire encoding", () => {
  it("encodes what a microcontroller can actually do", () => {
    expect(actionToWire({ kind: "pulse", ms: 40 })).toBe("PULSE 40");
    expect(actionToWire({ kind: "pulse" })).toBe("PULSE 30");          // sane default
    expect(actionToWire({ kind: "level", value: 0.5 })).toBe("LEVEL 128");
    expect(actionToWire({ kind: "level", value: 1 })).toBe("LEVEL 255");
    expect(actionToWire({ kind: "dmx", channel: 12, value: 255 })).toBe("DMX 12 255");
  });

  it("returns null for actions that belong on another transport", () => {
    expect(actionToWire({ kind: "camera" })).toBeNull();
    expect(actionToWire({ kind: "midi", status: 144, data1: 60, data2: 100 })).toBeNull();
    expect(actionToWire({ kind: "osc", address: "/go" })).toBeNull();
  });

  it("clamps a level rather than emitting an out-of-range byte", () => {
    expect(actionToWire({ kind: "level", value: 5 })).toBe("LEVEL 255");
    expect(actionToWire({ kind: "level", value: -1 })).toBe("LEVEL 0");
  });
});

describe("host-side scheduler (Tier 1)", () => {
  const setup = (bindings = BINDINGS) => {
    const backend = new SimulatedTriggerBackend({ tier: 1 });
    const problems: string[] = [];
    const s = new CueScheduler(resolver(bindings), (id) => (id === "simulated" ? backend : undefined), (m) => problems.push(m));
    s.load(buildCueList(cuedMove()));
    return { backend, s, problems };
  };

  it("fires nothing before start", async () => {
    const { backend, s } = setup();
    await s.advanceTo(99_999);
    expect(backend.fired).toHaveLength(0);
  });

  it("fires cues as the pass clock passes them, in order", async () => {
    const { backend, s } = setup();
    s.start();
    await s.advanceTo(0);
    expect(backend.fired.map((f) => f.id)).toEqual(["flash"]);
    await s.advanceTo(1999);
    expect(backend.fired.map((f) => f.id)).toEqual(["flash"]);
    await s.advanceTo(2000);                       // 48 frames @ 24 = 2000 ms
    expect(backend.fired.map((f) => f.id)).toEqual(["flash", "focus"]);
    await s.advanceTo(10_000);
    expect(backend.fired.map((f) => f.id)).toEqual(["flash", "focus", "house"]);
  });

  it("routes each cue to its bound output", async () => {
    const { backend, s } = setup();
    s.start(); await s.advanceTo(10_000);
    expect(backend.fired.map((f) => f.output)).toEqual([1, 2, 3]);
  });

  it("fires a late cue rather than dropping it", async () => {
    // A missed cue light is invisible; a late one is at least explicable.
    const { backend, s } = setup();
    s.start();
    await s.advanceTo(10_000);                     // one big jump, host stalled
    expect(backend.fired).toHaveLength(3);
    expect(s.worstJitterMs()).toBe(10_000);        // and the lateness is reported
  });

  it("reports jitter honestly — this is the Tier 1 caveat, measured", async () => {
    const { s } = setup();
    s.start();
    await s.advanceTo(5); await s.advanceTo(2013); await s.advanceTo(5002);
    expect(s.worstJitterMs()).toBe(13);
  });

  it("skips an unbound target and says so instead of failing silently", async () => {
    const { backend, s, problems } = setup(BINDINGS.filter((b) => b.target !== "focus"));
    s.start(); await s.advanceTo(10_000);
    expect(backend.fired.map((f) => f.id)).toEqual(["flash", "house"]);
    expect(problems.join(" ")).toMatch(/focus/);
  });

  it("lists unroutable cues BEFORE the pass, which is when it is useful", () => {
    const { s } = setup([{ target: "cue-light", backendId: "simulated", output: 1 }]);
    const bad = s.unroutable();
    expect(bad.map((b) => b.cue.id)).toEqual(["focus", "house"]);
    expect(bad[0].reason).toMatch(/not bound/);
  });

  it("flags a backend that cannot perform the action", () => {
    const backend = new SimulatedTriggerBackend({ tier: 1 });
    vi.spyOn(backend, "supports").mockReturnValue(false);
    const s = new CueScheduler(resolver(BINDINGS), () => backend);
    s.load(buildCueList(cuedMove()));
    expect(s.unroutable()).toHaveLength(3);
    expect(s.unroutable()[0].reason).toMatch(/cannot perform/);
  });

  it("keeps running when one cue throws", async () => {
    const backend = new SimulatedTriggerBackend({ tier: 1 });
    const problems: string[] = [];
    vi.spyOn(backend, "fire").mockImplementationOnce(async () => { throw new Error("wire fell out"); });
    const s = new CueScheduler(resolver(BINDINGS), () => backend, (m) => problems.push(m));
    s.load(buildCueList(cuedMove()));
    s.start(); await s.advanceTo(10_000);
    expect(problems[0]).toMatch(/wire fell out/);
    expect(backend.fired).toHaveLength(2);
  });

  it("stop() halts dispatch mid-pass", async () => {
    const { backend, s } = setup();
    s.start(); await s.advanceTo(0);
    s.stop(); await s.advanceTo(10_000);
    expect(backend.fired).toHaveLength(1);
  });
});

describe("serial backend against the simulated device (Tier 2)", () => {
  const connect = async () => {
    const dev = new SimulatedTriggerDevice("bench-trig", 6, 2);
    const be = new SerialTriggerBackend(dev, 200);
    const info = await be.hello();
    return { dev, be, info };
  };

  it("handshakes and reports the device's capabilities", async () => {
    const { be, info } = await connect();
    expect(info).toEqual({ protocol: TRIGGER_PROTOCOL_VERSION, name: "bench-trig", outputs: 6, inputs: 2, lensAxes: 3 });
    expect(be.outputs()).toBe(6);
    expect(be.describe()).toContain("bench-trig");
    expect(be.tier).toBe(2);
  });

  it("refuses an unknown protocol version rather than guessing a command set", async () => {
    // The same trap as ADR-0004: a command map that differs between firmware
    // eras is worse than no connection, because it moves things unexpectedly.
    const dev = new SimulatedTriggerDevice("future-trig", 8, 2, TRIGGER_PROTOCOL_VERSION + 1);
    const be = new SerialTriggerBackend(dev, 200);
    // Version-agnostic on purpose: this assertion is about the REFUSAL, and
    // pinning the numbers made it rot the moment the protocol grew to v2.
    await expect(be.hello()).rejects.toThrow(
      new RegExp(`speaks protocol v${TRIGGER_PROTOCOL_VERSION + 1}`),
    );
    await expect(be.hello()).rejects.toThrow(/refusing rather than guessing/);
  });

  it("times out with a readable message when the device says nothing", async () => {
    const silent = { write: () => true, on: () => silent } as unknown as SimulatedTriggerDevice;
    const be = new SerialTriggerBackend(silent, 30);
    await expect(be.hello()).rejects.toThrow(/did not answer "HELLO" within 30 ms/);
  });

  it("uploads the cue list and the device runs it off its own clock", async () => {
    const { dev, be } = await connect();
    const cues = buildCueList(cuedMove()).map((cue, i) => ({ cue, output: i + 1 }));
    expect(await be.arm(cues)).toBe(3);

    await be.start();
    dev.tick(0);
    expect(dev.performed.map((p) => p.id)).toEqual([1]);      // the 0 ms cue
    dev.tick(2000);
    expect(dev.performed.map((p) => p.id)).toEqual([1, 2]);
    dev.tick(3000);
    expect(dev.performed.map((p) => p.id)).toEqual([1, 2, 3]);
    expect(dev.performed.map((p) => p.wire)).toEqual(["PULSE 40", "LEVEL 128", "DMX 12 255"]);
  });

  it("reports each fire back with the DEVICE's timestamp, not the host's", async () => {
    const { dev, be } = await connect();
    const seen: Array<{ id: string; ms: number }> = [];
    be.onFired = (id, ms) => seen.push({ id, ms });
    let done = -1;
    be.onDone = (ms) => { done = ms; };
    await be.arm(buildCueList(cuedMove()).map((cue, i) => ({ cue, output: i + 1 })));
    await be.start();
    dev.tick(0); dev.tick(2000); dev.tick(3000);
    // ids come back as the move's string ids, not the wire integers
    expect(seen.map((s) => s.id)).toEqual(["flash", "focus", "house"]);
    expect(seen.map((s) => s.ms)).toEqual([0, 2000, 5000]);
    expect(done).toBe(5000);
  });

  it("refuses to run a partial list", async () => {
    const { dev, be } = await connect();
    dev.acceptLimit = 2;
    const cues = buildCueList(cuedMove()).map((cue, i) => ({ cue, output: i + 1 }));
    await expect(be.arm(cues)).rejects.toThrow(/accepted 2 of 3 cues/);
  });

  it("skips actions the wire cannot carry instead of sending garbage", async () => {
    const { dev, be } = await connect();
    const cues: Array<{ cue: Cue; output: number }> = [
      { cue: { id: "a", atMs: 0, target: "x", action: { kind: "pulse", ms: 10 } }, output: 1 },
      { cue: { id: "b", atMs: 10, target: "y", action: { kind: "midi", status: 144, data1: 60, data2: 1 } }, output: 2 },
    ];
    expect(await be.arm(cues)).toBe(1);
    await be.start(); dev.tick(50);
    expect(dev.performed.map((p) => p.wire)).toEqual(["PULSE 10"]);
  });

  it("ABORT clears an armed list so nothing fires afterwards", async () => {
    const { dev, be } = await connect();
    await be.arm(buildCueList(cuedMove()).map((cue, i) => ({ cue, output: i + 1 })));
    await be.start();
    await be.abort();
    dev.tick(10_000);
    expect(dev.performed).toHaveLength(0);
  });

  it("relays GPI input edges — a camera roll signal or a foot switch", async () => {
    const { dev, be } = await connect();
    const edges: Array<[number, string, number]> = [];
    be.onInput = (n, edge, ms) => edges.push([n, edge, ms]);
    dev.tick(1234);
    dev.input(1, "RISE");
    dev.input(1, "FALL");
    expect(edges).toEqual([[1, "RISE", 1234], [1, "FALL", 1234]]);
  });

  it("fires a single cue immediately in Tier-1 style", async () => {
    const { dev, be } = await connect();
    await be.fire({ id: "x", atMs: 0, target: "cue-light", action: { kind: "pulse", ms: 25 } }, 4);
    expect(dev.performed).toEqual([{ out: 4, wire: "PULSE 25", deviceMs: 0 }]);
  });
});

describe("simulated backend", () => {
  it("records an armed list and replays it perfectly on start", async () => {
    const be = new SimulatedTriggerBackend({ tier: 2 });
    const cues = buildCueList(cuedMove()).map((cue, i) => ({ cue, output: i + 1 }));
    expect(await be.arm(cues)).toBe(3);
    expect(be.fired).toHaveLength(0);
    await be.start();
    expect(be.fired.map((f) => f.id)).toEqual(["flash", "focus", "house"]);
    // A simulated device has no jitter by definition — do not read this as proof
    // that real hardware has none.
    expect(be.fired.every((f) => f.firedAtMs === f.atMs)).toBe(true);
  });

  it("abort clears the armed list", async () => {
    const be = new SimulatedTriggerBackend({ tier: 2 });
    await be.arm(buildCueList(cuedMove()).map((cue, i) => ({ cue, output: i + 1 })));
    await be.abort();
    await be.start();
    expect(be.fired).toHaveLength(0);
    expect(be.aborted).toBe(true);
  });
});
