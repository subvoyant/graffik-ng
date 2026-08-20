/**
 * Spline velocity solving, key-frame move building, and end-to-end client ↔
 * simulated-NMX integration (the full multiplicity workflow without hardware).
 */
import { describe, expect, it } from "vitest";
import { computeVelocities, splineAt } from "../src/spline.js";
import { buildKeyFrameMove, runSequence, describeMoveFeasibility, moveIsFeasible } from "../src/move.js";
import { SimulatedNmx } from "../src/simulator.js";
import { NmxClient, handshake } from "../src/client.js";
import { broadcast, general, keyFrame, motors, PLAN_TYPE } from "../src/commands.js";

describe("Hermite spline velocity solver", () => {
  const points = [
    { time: 0, position: 0 },
    { time: 5000, position: 8000 },
    { time: 10000, position: 10000 },
  ];

  it("endpoints stay at rest; interior velocity is positive along travel", () => {
    const solved = computeVelocities(points);
    expect(solved[0].velocity).toBe(0);
    expect(solved[2].velocity).toBe(0);
    expect(solved[1].velocity).toBeGreaterThan(0);
  });

  it("solved spline never reverses direction (no bounce on the camera move)", () => {
    const solved = computeVelocities(points);
    let last = splineAt(solved, 0).value;
    for (let t = 50; t <= 10000; t += 50) {
      const now = splineAt(solved, t).value;
      // tolerance far below one microstep — a physical no-op
      expect(now).toBeGreaterThanOrEqual(last - 0.05);
      last = now;
    }
  });

  it("spline interpolates key frame positions exactly", () => {
    const solved = computeVelocities(points);
    for (const p of points) {
      expect(splineAt(solved, p.time).value).toBeCloseTo(p.position, 3);
    }
  });

  it("local extreme keeps zero velocity (matches official app behavior)", () => {
    const solved = computeVelocities([
      { time: 0, position: 0 },
      { time: 5000, position: 4000 }, // peak
      { time: 10000, position: 0 },
    ]);
    expect(solved[1].velocity).toBe(0);
  });

  it("rejects non-increasing times", () => {
    expect(() => computeVelocities([
      { time: 0, position: 0 },
      { time: 0, position: 10 },
    ])).toThrow(/strictly increasing/);
  });
});

describe("buildKeyFrameMove", () => {
  it("emits the official app's per-axis sequence: axis, count, video time, xn*, fn*, dn*, end", () => {
    const packets = buildKeyFrameMove(
      [{ axis: 0, points: [{ time: 0, position: 0 }, { time: 30000, position: 5000 }] }],
      { videoTimeMs: 30000 },
    );
    const cmds = packets.map((p) => p.command);
    expect(cmds).toEqual([10, 11, 17, 12, 12, 13, 13, 14, 14, 16]);
    expect(packets.every((p) => p.subAddress === 5)).toBe(true);
  });

  it("run sequence = take up backlash, then run", () => {
    expect(runSequence().map((p) => p.command)).toEqual([23, 20]);
  });
});

describe("end-to-end: NmxClient against SimulatedNmx", () => {
  it("runs the full multiplicity workflow (classic engine)", async () => {
    const sim = new SimulatedNmx();
    const client = new NmxClient(sim, { timeoutMs: 200 });

    const version = await handshake(client);
    expect(version.value).toBe(70);
    expect(sim.graffikMode).toBe(true);

    await client.send(general.setJoystickWatchdog(true));
    for (const m of [1, 2, 3] as const) await client.send(motors.setEnable(m, true));
    expect(sim.enabled).toEqual([true, true, true]);

    // jog slide "to the start framing" — fire-and-forget in Graffik mode
    await client.send(motors.setContinuousSpeed(1, 800));
    expect(sim.jogSpeeds[0]).toBe(800);
    await client.send(motors.stop(1));
    sim.positions[0] = 1200; // pretend the jog moved us here

    await client.send(general.setStartHere());
    sim.positions[0] = 9000;
    await client.send(general.setStopHere());
    expect(sim.startPoints[0]).toBe(1200);
    expect(sim.stopPoints[0]).toBe(9000);

    // pass loop: all to start → run
    await client.send(general.sendAllToStart());
    expect(sim.positions[0]).toBe(1200);
    await client.send(general.startProgram());
    expect(sim.running).toBe(true);

    // E-STOP mid-pass
    await client.stopAll();
    expect(sim.running).toBe(false);
    expect(sim.kfRunState).toBe(0);
  });

  it("uploads and runs a key-frame move (KF engine)", async () => {
    const sim = new SimulatedNmx();
    const client = new NmxClient(sim, { timeoutMs: 200 });
    await handshake(client);

    const packets = buildKeyFrameMove(
      [
        { axis: 0, points: [{ time: 0, position: 0 }, { time: 15000, position: 7000 }, { time: 30000, position: 8000 }] },
        { axis: 1, points: [{ time: 0, position: 0 }, { time: 30000, position: -2000 }] },
      ],
      { videoTimeMs: 30000 },
    );
    for (const p of packets) await client.send(p);

    expect(sim.kfAxes[0].xn).toEqual([0, 15000, 30000]);
    expect(sim.kfAxes[0].fn).toEqual([0, 7000, 8000]);
    expect(sim.kfAxes[0].dn[0]).toBe(0);
    expect(sim.kfAxes[0].dn[1]).toBeGreaterThan(0);
    expect(sim.kfAxes[1].xn).toEqual([0, 30000]);
    expect(sim.kfVideoTimeMs).toBe(30000);

    for (const p of runSequence()) await client.send(p);
    expect(sim.kfRunState).toBe(1);
    expect((await client.query(keyFrame.queryRunState())).value).toBe(1);

    // broadcast KF stop is the e-stop for this engine
    await client.send(broadcast.kfStop());
    expect(sim.kfRunState).toBe(0);
  });
});

describe("simulator progress animation (demo-mode pass completion)", () => {
  it("KF run completes after repeated progress polls", async () => {
    const sim = new SimulatedNmx();
    const client = new NmxClient(sim, { timeoutMs: 200 });
    await handshake(client);
    for (const p of runSequence()) await client.send(p);
    expect(sim.kfRunState).toBe(1);
    let last = 0;
    for (let i = 0; i < 6; i++) last = (await client.query(keyFrame.queryPercentComplete())).value as number;
    expect(last).toBe(100);
    expect(sim.kfRunState).toBe(0);
  });

  it("classic run completes and lands on stop points", async () => {
    const sim = new SimulatedNmx();
    const client = new NmxClient(sim, { timeoutMs: 200 });
    await handshake(client);
    sim.positions = [1200, 0, 0];
    await client.send(general.setStartHere());
    sim.positions = [9000, 0, 0];
    await client.send(general.setStopHere());
    await client.send(general.sendAllToStart());
    await client.send(general.startProgram());
    let percent = 0;
    for (let i = 0; i < 6; i++) percent = (await client.query(general.queryProgramProgress())).value as number;
    expect(percent).toBe(100);
    expect(sim.running).toBe(false);
    expect(sim.positions[0]).toBe(9000); // landed on stop point
  });
});

describe("simulator camera + physics", () => {
  it("camera state tracks enable/trigger/interval and test fires", async () => {
    const sim = new SimulatedNmx();
    const client = new NmxClient(sim, { timeoutMs: 200 });
    await handshake(client);
    const { cam } = await import("../src/commands.js");
    await client.send(cam.setEnable(true));
    await client.send(cam.setTriggerTime(120));
    await client.send(cam.setInterval(2000));
    await client.send(cam.exposeNow());
    await client.send(cam.exposeNow());
    expect(sim.camEnabled).toBe(true);
    expect(sim.camTriggerMs).toBe(120);
    expect(sim.camIntervalMs).toBe(2000);
    expect(sim.camExposures).toBe(2);
  });

  it("tick() integrates jog speed into position only when motor enabled", async () => {
    const sim = new SimulatedNmx();
    const client = new NmxClient(sim, { timeoutMs: 200 });
    await handshake(client);
    await client.send(motors.setContinuousSpeed(1, 800)); // enabled? not yet
    sim.tick(500);
    expect(sim.positions[0]).toBe(0);
    await client.send(motors.setEnable(1, true));
    sim.tick(500); // 800 steps/s for 0.5s
    expect(sim.positions[0]).toBe(400);
    await client.send(motors.stop(1));
    sim.tick(500);
    expect(sim.positions[0]).toBe(400);
  });
});

describe("plan type survives the round trip (ADR-0028)", () => {
  it("what we set is what the device reports back", async () => {
    const sim = new SimulatedNmx();
    const client = new NmxClient(sim);
    await handshake(client);
    await client.send(general.setProgramMode(PLAN_TYPE.contVideo));
    expect((await client.query(general.queryPlanType())).value).toBe(PLAN_TYPE.contVideo);
  });

  it("reports whatever was actually latched, including a wrong one", async () => {
    const sim = new SimulatedNmx();
    const client = new NmxClient(sim);
    await handshake(client);
    /* Standing in for the case this exists to catch: something else — the stock
       app, an older build of ours — left the device in time-lapse. */
    await client.send(general.setProgramMode(PLAN_TYPE.contTimelapse));
    expect((await client.query(general.queryPlanType())).value).toBe(PLAN_TYPE.contTimelapse);
  });
});

describe("the power-cycle flag is a one-shot latch (ADR-0030)", () => {
  it("the simulator consumes it exactly like the firmware does", async () => {
    const sim = new SimulatedNmx();
    const client = new NmxClient(sim);
    await handshake(client);
    /* First reader gets the truth. */
    expect((await client.query(general.queryPowerCycled())).value).toBe(1);
    /* Everyone after gets a zero that means nothing. A simulator that kept
       answering 1 would make the app look right and hide the whole problem. */
    expect((await client.query(general.queryPowerCycled())).value).toBe(0);
  });

  it("position restore is off by default, matching the firmware's ee_load_curPos", async () => {
    const sim = new SimulatedNmx();
    const client = new NmxClient(sim);
    await handshake(client);
    expect((await client.query(general.queryRestoresPosition())).value).toBe(0);
    await client.send(general.setRestorePosition(true));
    expect((await client.query(general.queryRestoresPosition())).value).toBe(1);
  });
});

describe("the solver refuses points it cannot use (v0.25)", () => {
  it("rejects a key frame with no usable time instead of emitting NaN", () => {
    /* `undefined <= undefined` is false, so the strictly-increasing check used
       to pass and every abscissa reached the wire as NaN. */
    expect(() => computeVelocities([{ position: 0 } as never, { position: 100 } as never]))
      .toThrow(/no usable time/);
  });

  it("rejects a non-finite position and a non-finite caller velocity", () => {
    expect(() => computeVelocities([{ time: 0, position: NaN }, { time: 1, position: 1 }]))
      .toThrow(/no usable position/);
    expect(() => computeVelocities([{ time: 0, position: 0, velocity: Infinity }, { time: 1, position: 1 }]))
      .toThrow(/non-finite velocity/);
  });
});

describe("asking the device whether the move is possible (ADR-0031)", () => {
  const row = (o: Partial<{ axis: number; name: string; velocityOk: boolean | null; accelOk: boolean | null }> = {}) =>
    ({ axis: 0, name: "Slide", velocityOk: true, accelOk: true, ...o });

  it("is silent about an axis the device is happy with", () => {
    expect(describeMoveFeasibility([row(), row({ axis: 1, name: "Pan" })])).toEqual([]);
    expect(moveIsFeasible([row()])).toBe(true);
  });

  it("names the axis and which limit it broke", () => {
    expect(describeMoveFeasibility([row({ velocityOk: false })])[0]).toMatch(/Slide.*top speed/);
    expect(describeMoveFeasibility([row({ accelOk: false })])[0]).toMatch(/Slide.*accelerates harder/);
    expect(describeMoveFeasibility([row({ velocityOk: false, accelOk: false })])[0]).toMatch(/both/);
    expect(moveIsFeasible([row({ velocityOk: false })])).toBe(false);
  });

  it("distinguishes NOT ASKED from told-no", () => {
    const lines = describeMoveFeasibility([row({ velocityOk: null, accelOk: null })]);
    expect(lines[0]).toMatch(/did not answer/);
    /* Not being able to ask is not a refusal — it must not block the pass. */
    expect(moveIsFeasible([row({ velocityOk: null, accelOk: null })])).toBe(true);
  });

  it("the simulator answers the key-frame validity questions for real, not with a cheerful yes", async () => {
    const sim = new SimulatedNmx();
    sim.maxStepsPerSec = 1000;
    const client = new NmxClient(sim);
    await handshake(client);
    const packets = buildKeyFrameMove(
      [{ axis: 0, points: [{ time: 0, position: 0 }, { time: 1000, position: 5000 }] }],
      { videoTimeMs: 1000 },
    );
    for (const p of packets) await client.send(p);
    await client.send(keyFrame.setAxis(0));
    /* 5000 steps in a second on a 1000 steps/s rig: the device should say no. */
    expect((await client.query(keyFrame.queryVelocityValid())).value).toBe(0);
    sim.maxStepsPerSec = 20000;
    expect((await client.query(keyFrame.queryVelocityValid())).value).toBe(1);
  });

  it("the simulator answers the 2-point question from the taught span and the travel time", async () => {
    const sim = new SimulatedNmx();
    sim.maxStepsPerSec = 1000;
    const client = new NmxClient(sim);
    await handshake(client);
    await client.send(motors.setEnable(1, true));
    await client.send(motors.setProgramStartPoint(1, 0));
    await client.send(motors.setProgramStopPoint(1, 9000));
    await client.send(motors.setTravel(1, 1000));           // 9000 steps in 1 s
    expect((await client.query(motors.queryTwoPointVelocityValid(1))).value).toBe(0);
    expect((await client.query(general.queryProgramValid())).value).toBe(0);
    await client.send(motors.setTravel(1, 60000));          // same span over a minute
    expect((await client.query(motors.queryTwoPointVelocityValid(1))).value).toBe(1);
    expect((await client.query(general.queryProgramValid())).value).toBe(1);
  });

  it("key-frame query 121 returns a run time, not a bare ack", async () => {
    const sim = new SimulatedNmx();
    const client = new NmxClient(sim);
    await handshake(client);
    await client.send(keyFrame.setContinuousVideoTime(10000));
    expect((await client.query(keyFrame.queryRunTime())).value).toBe(0);
  });
});
