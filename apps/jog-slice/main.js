/**
 * Graffik NG — main process. ALL hardware I/O lives here (ADR-0007);
 * the renderer sees only the intent-level IPC surface below.
 * Soft-limit enforcement is here too, so no renderer bug can bypass it (ADR-0013).
 */
import { app, BrowserWindow, dialog, ipcMain } from "electron";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dgram from "node:dgram";
import { SerialPort } from "serialport";
import {
  NmxClient, SimulatedNmx, handshake,
  general, motors, cam, keyFrame,
  buildKeyFrameMove, runSequence, computeVelocities, splineAt,
  serializeFilm, deserializeFilm,
  filmAxesToMs, filmDurationMs, filmCueMs, msToFramesExact, framesToMs,
  EXPORT_FORMATS, DEFAULT_CALIBRATION, DEFAULT_LENS, moveExtents, alembicConverterScript,
  buildCueList, SimulatedTriggerBackend, SerialTriggerBackend, SimulatedTriggerDevice, CueScheduler,
  DmxTriggerBackend, SimulatedEnttecDevice, OscTriggerBackend, SimulatedDatagram,
  sampleLensAxis, LENS_KINDS,
  buildLensProgram, lensProgramSize, lensFeasibility, LENS_AXIS_INDEX,
  serializeLensLibrary, parseLensLibrary, mergeLensLibrary,
  validateLensLibraryEntry, lensLibraryId,
  fitCalibration, diagnoseCalibration, repeatability,
  probeNmx, judgePorts, noUsablePortAdvice,
  capUntaughtJog, bringUpReport, PLAN_TYPE, limitTrust,
  describeMoveFeasibility, moveIsFeasible,
  newTrace, addSample, traceCoverage, compareTraces, deviationFromPlan, traceToCsv, timingCheck,
  parsePassTrace,
  NO_LIMITS, isTaught, jogWouldExceed, violationsForFilm, describeViolations,
} from "@graffik-ng/nmx-protocol";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SIM_PORT = "simulator://nmx";
const NMX_BAUD = 19200;          // firmware: USBSerial.begin(19200) — ADR-0004
const SUPPORTED_FIRMWARE = 70;   // ADR-0004: refuse programmed moves on other versions
const MAX_JOG_SPEED = 4000;      // hard clamp, independent of soft limits

/* ---------------- preferences ---------------- */

/** Motor index by calibration axis. Slide is motor 1 (KF axis 0). */
const CAL_AXES = ["slide", "pan", "tilt"];
const CAL_MOTOR = { slide: 1, pan: 2, tilt: 3 };
const CAL_UNIT = { slide: "mm", pan: "deg", tilt: "deg" };
const CAL_PREF_KEY = { slide: "slideStepsPerMm", pan: "panStepsPerDeg", tilt: "tiltStepsPerDeg" };

const DEFAULT_PREFS = {
  window: { width: 1180, height: 820 },
  lastPort: null,
  jogSpeed: 800,
  limits: NO_LIMITS,
  gamepad: {
    // gamepad axis index + inversion per motion axis; "ballistics" below
    bindings: {
      slide: { axisIndex: 0, invert: false },
      pan:   { axisIndex: 2, invert: false },
      tilt:  { axisIndex: 3, invert: true },
    },
    deadzone: 0.15,   // fraction of stick travel ignored at centre
    curve: 2.0,       // response exponent: 1 linear, 2 quadratic, 3 cubic
    maxSpeedPct: 100, // scales the jog-speed field at full deflection
    /* Physical buttons (ADR-0021). Nothing is bound by default — a guessed
       e-stop is worse than none, because the operator would believe in it. */
    buttons: {
      estop: { index: null }, runPass: { index: null }, gotoStart: { index: null },
      jogToggle: { index: null }, markKey: { index: null },
    },
  },
  recent: [],
  /* The flight recorder (ADR-0027). On by default: a pass you did not record is
     gone, and the first hardware session is the one worth having a record of.
     `checkSending` costs three extra queries a sample and buys the guarantee
     that a rescaled reading is never mixed in (firmware query 106 vs 124) — turn
     it off only after the rig has shown 124 is always false during a run. */
  trace: { enabled: true, checkSending: true },
  /* Lens motors are rig configuration, not part of a move (ADR-0018).
     `steps` is remembered between sessions as a HINT for the feasibility
     pre-flight — it is never treated as homing, because only the board knows
     whether it has seen a mechanical stop since it powered up. */
  /* Marks belong to a LENS, not to a move (ADR-0019). Kept here so marking a
     piece of glass is done once, not once per setup. */
  lensLibrary: [],
  /* Commissioning (ADR-0020): the measurements themselves, not just the
     conclusion. Keeping the spans means a suspect number can be argued with
     later — "which measurement gave us 160?" is answerable. */
  commission: {
    spans: { slide: [], pan: [], tilt: [] },
    marked: { slide: null, pan: null, tilt: null },
    passes: [],
    thresholdMm: 0.1,
  },
  lens: {
    motors: {
      focus: { steps: 0, maxStepsPerSec: 3000, invert: false },
      iris:  { steps: 0, maxStepsPerSec: 2000, invert: false },
      zoom:  { steps: 0, maxStepsPerSec: 2000, invert: false },
    },
  },
  /* Logical target -> physical output (ADR-0016). Bindings are rig config, so
     they live here rather than in the move file — a .graffik must survive being
     carried to another rig. */
  triggers: {
    bindings: [
      { target: "cue-light", backendId: "simulated", output: 1 },
    ],
    lastPort: null,
    /* DMX and OSC are separate transports from the trigger board; each keeps
       its own connection settings so one can be live without the other. */
    dmxPort: null,
    osc: { host: "127.0.0.1", port: 9000, prefix: "/graffik" },
  },
  /* 3D export settings (ADR-0015). Calibration is a property of the RIG, so it
     belongs in preferences, not in the move file — the same move exported from
     a re-belted rig needs the new numbers, not the old ones. */
  export: {
    formatId: "usda",
    metersPerUnit: 1,
    upAxis: "Y",
    pixelsPerMeter: 1000,
    compWidth: 1920,
    compHeight: 1080,
    calibration: { ...DEFAULT_CALIBRATION },
    lens: { ...DEFAULT_LENS },
  },
};

const PREFS_PATH = path.join(app.getPath("userData"), "preferences.json");
let prefs = structuredClone(DEFAULT_PREFS);

function loadPrefs() {
  try {
    const raw = JSON.parse(fsSync.readFileSync(PREFS_PATH, "utf-8"));
    prefs = {
      ...structuredClone(DEFAULT_PREFS), ...raw,
      window: { ...DEFAULT_PREFS.window, ...(raw.window ?? {}) },
      gamepad: {
        ...DEFAULT_PREFS.gamepad, ...(raw.gamepad ?? {}),
        bindings: { ...DEFAULT_PREFS.gamepad.bindings, ...(raw.gamepad?.bindings ?? {}) },
        /* Guarded like every other sub-object. A corrupt buttons map must not be
           able to leave the e-stop silently unbound — and merging over the
           defaults means an older preferences file simply has nothing bound,
           which the UI then says out loud (ADR-0021). */
        buttons: { ...DEFAULT_PREFS.gamepad.buttons, ...(raw.gamepad?.buttons ?? {}) },
      },
      limits: Array.isArray(raw.limits) && raw.limits.length === 3 ? raw.limits : structuredClone(NO_LIMITS),
      /* `recent` was the one sub-object without a guard, and it is read with
         .filter() by both save and load — so a preferences file carrying
         anything but an array broke exactly those two commands and nothing
         else. Every sub-object gets a guard now; none of them may be trusted
         to have survived an older build. */
      recent: Array.isArray(raw.recent) ? raw.recent.filter((p) => typeof p === "string") : [],
      trace: { ...DEFAULT_PREFS.trace, ...(raw.trace ?? {}) },
      triggers: {
        ...DEFAULT_PREFS.triggers, ...(raw.triggers ?? {}),
        bindings: Array.isArray(raw.triggers?.bindings) ? raw.triggers.bindings : [...DEFAULT_PREFS.triggers.bindings],
        osc: { ...DEFAULT_PREFS.triggers.osc, ...(raw.triggers?.osc ?? {}) },
      },
      /* Guarded like every other sub-object — `prefs.recent` taught us what an
         unguarded one costs (v0.7.0). A malformed library must not break the
         Lens dialog, let alone a save. */
      lensLibrary: Array.isArray(raw.lensLibrary) ? raw.lensLibrary.filter((e) => {
        try { validateLensLibraryEntry(e); return true; } catch { return false; }
      }) : [],
      commission: {
        ...DEFAULT_PREFS.commission, ...(raw.commission ?? {}),
        spans: Object.fromEntries(CAL_AXES.map((k) => [
          k, Array.isArray(raw.commission?.spans?.[k])
            ? raw.commission.spans[k].filter((o) => Number.isFinite(o?.steps) && Number.isFinite(o?.measured))
            : [],
        ])),
        marked: { ...DEFAULT_PREFS.commission.marked, ...(raw.commission?.marked ?? {}) },
        passes: Array.isArray(raw.commission?.passes) ? raw.commission.passes.filter(Number.isFinite) : [],
      },
      lens: {
        ...DEFAULT_PREFS.lens, ...(raw.lens ?? {}),
        motors: Object.fromEntries(LENS_KINDS.map((k) => [
          k, { ...DEFAULT_PREFS.lens.motors[k], ...(raw.lens?.motors?.[k] ?? {}) },
        ])),
      },
      export: {
        ...DEFAULT_PREFS.export, ...(raw.export ?? {}),
        calibration: { ...DEFAULT_CALIBRATION, ...(raw.export?.calibration ?? {}) },
        lens: { ...DEFAULT_LENS, ...(raw.export?.lens ?? {}) },
      },
    };
  } catch { /* first run, or corrupt — defaults are fine */ }
}
let saveTimer = null;
function savePrefs() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(PREFS_PATH, JSON.stringify(prefs, null, 2), "utf-8").catch(() => {});
  }, 400);
}

/* ---------------- connection ---------------- */

/** @type {SerialPort | null} */ let port = null;
/** @type {NmxClient | null} */  let client = null;
/** @type {SimulatedNmx | null} */ let sim = null;
let firmwareVersion = null, firmwareGateOverridden = false;

async function connect(portPath) {
  await disconnect();
  if (portPath === SIM_PORT) {
    sim = new SimulatedNmx();
    sim.startPhysics();
    client = new NmxClient(sim, { timeoutMs: 800 });
  } else {
    port = new SerialPort({ path: portPath, baudRate: NMX_BAUD, autoOpen: false });
    await new Promise((res, rej) => port.open((e) => (e ? rej(e) : res())));
    client = new NmxClient(port, { timeoutMs: 800 });
  }
  const v = await handshake(client);
  await client.send(general.setJoystickWatchdog(true));
  firmwareVersion = v.value;
  firmwareGateOverridden = false;

  /* Ask ONCE per connection, and keep the answer (ADR-0030).
     Query 119 is a one-shot latch — the firmware's `powerCycled()` returns true
     the first time it is called after a power cycle and false thereafter — so
     asking twice throws away the only chance to hear it, and asking late lets
     another app consume it first. */
  origin = { reportedPowerCycle: null, restoresPosition: null };
  try { origin.reportedPowerCycle = Boolean((await client.query(general.queryPowerCycled())).value); } catch { /* stays null */ }
  try { origin.restoresPosition = Boolean((await client.query(general.queryRestoresPosition())).value); } catch { /* stays null */ }
  const verdict = limitTrust(origin, prefs.limits.some(isTaught));
  /* Voided means the stored step numbers point somewhere else on the rail now.
     Not deleted — the operator may know they are still right — but not enforced
     as taught either, which also re-arms the ADR-0023 creep cap. */
  limitsVoided = verdict.voided;

  prefs.lastPort = portPath; savePrefs();
  return {
    firmwareVersion,
    supported: firmwareVersion === SUPPORTED_FIRMWARE,
    origin,
    limitTrust: verdict,
  };
}

/** What the controller said about its own origin, this connection. */
let origin = { reportedPowerCycle: null, restoresPosition: null };
/** True while taught limits must not be enforced as taught (ADR-0030). */
let limitsVoided = false;

/** The limits as they may be ACTED on — voided ones read as untaught. */
const effectiveLimits = () => (limitsVoided ? structuredClone(NO_LIMITS) : prefs.limits);

async function disconnect() {
  stopJogMonitor();
  stopCues();
  if (client) { try { await client.stopAll(); } catch { /* already gone */ } }
  if (port?.isOpen) await new Promise((r) => port.close(() => r()));
  sim?.stopPhysics();
  sim = null; port = null; client = null; firmwareVersion = null;
}

const requireClient = () => {
  if (!client) throw new Error("Not connected");
  return client;
};

function requireProgrammedMovesAllowed() {
  const c = requireClient();
  if (firmwareVersion !== SUPPORTED_FIRMWARE && !firmwareGateOverridden) {
    throw new Error(
      `Firmware v${firmwareVersion} ≠ verified v${SUPPORTED_FIRMWARE}. Programmed moves blocked ` +
      `(command maps differ across firmware eras). Update the NMX firmware, or override explicitly.`,
    );
  }
  return c;
}

/* ---------------- soft limits (ADR-0013) ---------------- */

let jogMonitor = null;
const activeJogs = new Map(); // motor -> stepsPerSec

function stopJogMonitor() {
  if (jogMonitor) { clearInterval(jogMonitor); jogMonitor = null; }
  activeJogs.clear();
}

/** Poll positions while jogging and cut the motor before it reaches a limit. */
function ensureJogMonitor(win) {
  if (jogMonitor) return;
  jogMonitor = setInterval(async () => {
    if (!client || activeJogs.size === 0) return;
    for (const [motor, speed] of [...activeJogs]) {
      const lim = effectiveLimits()[motor - 1];
      if (!lim || !isTaught(lim)) continue;
      try {
        const res = await client.query(motors.queryPosition(motor));
        const pos = Number(res.value);
        if (jogWouldExceed(lim, pos, speed)) {
          activeJogs.delete(motor);
          await client.send(motors.setContinuousSpeed(motor, 0));
          win?.webContents.send("nmx:limit-hit", { motor, position: pos, speed });
        }
      } catch { /* transient */ }
    }
    if (activeJogs.size === 0) stopJogMonitor();
  }, 90);
}

/* ---------------- IPC: connection ---------------- */

ipcMain.handle("nmx:list-ports", async () => {
  const ports = await SerialPort.list();
  const all = [
    ...ports.map((p) => ({ path: p.path, manufacturer: p.manufacturer ?? "" })),
    { path: SIM_PORT, manufacturer: "demo mode — no hardware" },
  ];
  /* Ranked, not just listed. A macOS port list is mostly Bluetooth entries and
     on a first bring-up nobody knows which of eight identical-looking paths is
     the rig (ADR-0022). */
  const judged = judgePorts(all);
  return {
    ports: all.map((p, i) => ({ ...p, likelihood: judged[i].likelihood, why: judged[i].why })),
    advice: noUsablePortAdvice(judged.filter((j) => !j.path.startsWith("simulator://"))),
  };
});

/**
 * Ask every plausible address and report what came back.
 *
 * Opens its OWN port rather than reusing a live client: this runs when the
 * normal connect has already failed, so there is nothing to reuse, and it must
 * not disturb a connection that did succeed.
 */
ipcMain.handle("nmx:diagnose", async (_e, portPath) => {
  if (portPath === SIM_PORT) {
    return probeNmx(new SimulatedNmx(), { timeoutMs: 200, expectedFirmware: SUPPORTED_FIRMWARE });
  }
  let probePort = null;
  try {
    probePort = new SerialPort({ path: portPath, baudRate: 19200, autoOpen: false });
    await new Promise((res, rej) => probePort.open((err) => (err ? rej(err) : res())));
    return await probeNmx(probePort, {
      timeoutMs: 400,
      expectedFirmware: SUPPORTED_FIRMWARE,
      portLooksLikeBluetooth: /bluetooth|incoming-port/i.test(portPath),
    });
  } catch (err) {
    /* Failing to OPEN is its own diagnosis, and a much more specific one than
       anything the probe could have said. */
    return {
      probes: [], answeringAddress: null, firmware: null, bytesSeen: 0, verdict: "silence",
      headline: `The port would not open: ${err.message}`,
      steps: [
        /^.*(busy|resource|access|EBUSY|EACCES).*$/i.test(err.message)
          ? "Something else has this port open — a serial monitor, the Arduino IDE, or another copy of this app."
          : "Check the device is still plugged in, then rescan the port list.",
      ],
    };
  } finally {
    if (probePort?.isOpen) await new Promise((r) => probePort.close(() => r()));
  }
});
ipcMain.handle("nmx:connect", (_e, p) => connect(p));
ipcMain.handle("nmx:disconnect", () => disconnect());
ipcMain.handle("nmx:override-firmware-gate", () => { firmwareGateOverridden = true; });

/* ---------------- IPC: preferences ---------------- */

ipcMain.handle("nmx:get-prefs", () => prefs);
ipcMain.handle("nmx:set-prefs", (_e, patch) => {
  prefs = { ...prefs, ...patch };
  savePrefs();
  return prefs;
});

/* ---------------- IPC: limits ---------------- */

ipcMain.handle("nmx:get-limits", () => prefs.limits);
/** Teach a bound from where the rig is standing right now. */
ipcMain.handle("nmx:set-limit-here", async (_e, motor, bound) => {
  const res = await requireClient().query(motors.queryPosition(motor));
  const pos = Math.round(Number(res.value));
  prefs.limits[motor - 1] = { ...prefs.limits[motor - 1], [bound]: pos };
  /* Teaching a bound is the operator saying where the rig IS, right now, against
     this origin. That answers the question voiding asked, so it clears — the
     same self-clearing shape as the creep cap (ADR-0023), and for the same
     reason: an override you have to remember to turn off is one you leave on. */
  limitsVoided = false;
  savePrefs();
  return prefs.limits;
});
/**
 * Ask the controller to remember its position across a power cycle.
 *
 * This writes the NMX's EEPROM, so it happens on an explicit button and never
 * silently on connect — it is somebody else's device, and a tool that quietly
 * changes persistent settings is a tool you stop trusting. Fixes the fragile
 * case at the root: with position restored, a taught step limit keeps meaning
 * the same place on the rail.
 */
ipcMain.handle("nmx:set-restore-position", async (_e, on) => {
  const c = requireClient();
  await c.send(general.setRestorePosition(Boolean(on)));
  try { origin.restoresPosition = Boolean((await c.query(general.queryRestoresPosition())).value); }
  catch { origin.restoresPosition = null; }
  return limitStatus();
});

/** The operator saying "I know it power-cycled; these are still right." */
ipcMain.handle("nmx:trust-limits", () => { limitsVoided = false; return limitStatus(); });
ipcMain.handle("nmx:limit-status", () => limitStatus());
function limitStatus() {
  return {
    voided: limitsVoided,
    origin,
    verdict: limitTrust(origin, prefs.limits.some(isTaught)),
  };
}

ipcMain.handle("nmx:clear-limits", (_e, motor) => {
  if (motor) prefs.limits[motor - 1] = { min: null, max: null };
  else prefs.limits = structuredClone(NO_LIMITS);
  savePrefs();
  return prefs.limits;
});

/* ---------------- IPC: jog ---------------- */

ipcMain.handle("nmx:enable-motors", async () => {
  const c = requireClient();
  for (const m of [1, 2, 3]) await c.send(motors.setEnable(m, true));
});

ipcMain.handle("nmx:jog", async (e, motor, stepsPerSec) => {
  const c = requireClient();
  const clamped = Math.max(-MAX_JOG_SPEED, Math.min(MAX_JOG_SPEED, stepsPerSec));
  /* Voided limits read as untaught here — deliberately (ADR-0030). Enforcing a
     step number whose origin has moved is worse than enforcing nothing, because
     it puts the guard rail somewhere else on the rail while the operator still
     believes in it. Reading them as untaught also re-arms the creep cap below,
     which is the correct fallback: you have just learned you know less than you
     thought about where the carriage is. */
  const lim = effectiveLimits()[motor - 1] ?? { min: null, max: null };

  /* An axis nobody has taught gets a creep cap (ADR-0023). The first jog on a
     new rig necessarily happens before any limits exist — limits are taught BY
     jogging to them — so this is the one moment the limit system cannot help.
     Enforced HERE, main-side, for the same reason the limits themselves are
     (ADR-0013): no renderer bug can bypass it. Self-clears on the first taught
     bound. */
  const cap = capUntaughtJog(lim, clamped);
  const speed = cap.stepsPerSec;

  if (speed !== 0 && lim && isTaught(lim)) {
    const res = await c.query(motors.queryPosition(motor));
    const pos = Number(res.value);
    if (jogWouldExceed(lim, pos, speed)) {
      await c.send(motors.setContinuousSpeed(motor, 0));
      activeJogs.delete(motor);
      return { blocked: true, position: pos };
    }
  }

  await c.send(motors.setContinuousSpeed(motor, speed));
  if (speed === 0) activeJogs.delete(motor);
  else { activeJogs.set(motor, speed); ensureJogMonitor(BrowserWindow.fromWebContents(e.sender)); }
  return { blocked: false };
});

/** The one place a motor position is read, so commissioning and the readout
    cannot drift into asking different questions. */
async function readPosition(motor) {
  const r = await requireClient().query(motors.queryPosition(motor));
  return r.value;
}
ipcMain.handle("nmx:position", (_e, motor) => readPosition(motor));

/* ---------------- IPC: classic engine ---------------- */

ipcMain.handle("nmx:set-start-here", () => requireClient().send(general.setStartHere()));
ipcMain.handle("nmx:set-stop-here", () => requireClient().send(general.setStopHere()));

/** Classic 2-point arm. Frames in (ADR-0014); ms only inside, for the wire. */
ipcMain.handle("nmx:arm-move", async (_e, travelFrames, accelFrames, decelFrames, timebase) => {
  const c = requireProgrammedMovesAllowed();
  const travelMs = framesToMs(travelFrames, timebase);
  const accelMs = framesToMs(accelFrames, timebase);
  const decelMs = framesToMs(decelFrames, timebase);
  /* CONT_VID, not CONT_TL. The value decides what percent complete is divided
     by, and on a video shoot it also makes the classic engine fire the shutter
     once at the end of the pass (start/stop record). See PLAN_TYPE. */
  await c.send(general.setProgramMode(PLAN_TYPE.contVideo));
  await c.send(general.setStartDelay(0));   // cue countdown is host-side
  for (const m of [1, 2, 3]) {
    await c.send(motors.setTravel(m, travelMs));
    await c.send(motors.setProgramAccel(m, accelMs));
    await c.send(motors.setProgramDecel(m, decelMs));
    await c.send(motors.setEasing(m, 2));
  }
});

ipcMain.handle("nmx:goto-start", () => requireClient().send(general.sendAllToStart()));
ipcMain.handle("nmx:run", () => requireProgrammedMovesAllowed().send(general.startProgram()));
ipcMain.handle("nmx:pause", () => requireClient().send(general.pauseProgram()));
ipcMain.handle("nmx:progress", async () => {
  const c = requireClient();
  const p = await c.query(general.queryProgramProgress());
  const r = await c.query(general.queryMotorsRunning());
  return { percent: p.value, running: Boolean(r.value) };
});

/* ---------------- IPC: key-frame engine ---------------- */

/**
 * Pure math — no client needed; the editor works disconnected (ADR-0009).
 *
 * Takes and returns FRAMES (ADR-0014): the renderer hands over the whole film
 * and gets sample points on the frame axis. Milliseconds exist only inside this
 * handler, where the solver needs them, and never cross the IPC boundary — one
 * object in, one unit out, so the two sides cannot disagree about units.
 */
ipcMain.handle("nmx:preview-move", (_e, film, sampleCount = 140) => {
  const tb = film.timebase;
  const msAxes = filmAxesToMs(film);
  const durMs = filmDurationMs(film);
  return msAxes.map(({ axis, points }) => {
    const solved = computeVelocities(points);
    const samples = [];
    for (let i = 0; i <= sampleCount; i++) {
      const t = (durMs * i) / sampleCount;
      samples.push({ frame: msToFramesExact(t, tb), pos: splineAt(solved, t).value });
    }
    return { axis, solved, samples };
  });
});

ipcMain.handle("nmx:upload-kf", async (_e, film) => {
  const c = requireProgrammedMovesAllowed();
  // Nothing reaches the controller before the whole move is checked (ADR-0013).
  if (limitsVoided) {
    throw new Error(
      "Taught limits are not trusted: the controller reports it has been power-cycled and does not restore " +
      "position, so those numbers describe different places on the rail now. Re-teach both bounds, or trust " +
      "them explicitly, before uploading a programmed move (ADR-0030).",
    );
  }
  const v = violationsForFilm(film, prefs.limits);
  if (v.length) throw new Error("Soft limits: " + describeViolations(v));
  /* The key-frame path never set a plan type at all, so a KF pass ran under
     whatever was last latched — by our own classic arm, or by the stock app.
     It is not cosmetic: on anything but CONT_VID the firmware divides percent
     complete by move time PLUS the camera's focus and trigger time, so the
     playhead (ADR-0025) and the recorder's join key (ADR-0027) are both wrong
     by that factor. Set it explicitly, every upload. */
  await c.send(general.setProgramMode(PLAN_TYPE.contVideo));
  /* Read it back rather than assume the write took. One query, and it is the
     difference between a percent that means what we think it means and one
     that is quietly scaled by the camera's focus and trigger time. */
  try { latchedPlanType = (await c.query(general.queryPlanType())).value; }
  catch { latchedPlanType = null; }
  const packets = buildKeyFrameMove(filmAxesToMs(film), { videoTimeMs: filmDurationMs(film) });
  for (const p of packets) await c.send(p);
  return { packets: packets.length, planType: latchedPlanType, wanted: PLAN_TYPE.contVideo };
});

/**
 * Solve every lens axis, one sample per frame (ADR-0017).
 *
 * Pure math, like `preview-move`, and through the SAME spline solver — so the
 * focus curve the operator draws is the focus the rig will pull, rather than
 * two interpolations that happen to look alike (ADR-0009).
 */
ipcMain.handle("nmx:preview-lens", (_e, film) => {
  const out = {};
  for (const ax of film.lensAxes ?? []) {
    if (!LENS_KINDS.includes(ax.kind)) continue;
    out[ax.kind] = sampleLensAxis(ax, film.durationFrames);
  }
  return out;
});

/** Cue countdown length in ms — the renderer counts down, main owns the math. */
ipcMain.handle("nmx:cue-ms", (_e, film) => filmCueMs(film));

ipcMain.handle("nmx:kf-run", async () => {
  const c = requireProgrammedMovesAllowed();
  for (const p of runSequence()) await c.send(p);
});
ipcMain.handle("nmx:kf-stop", () => requireClient().send(keyFrame.stop()));
ipcMain.handle("nmx:kf-progress", async () => {
  const c = requireClient();
  const s = await c.query(keyFrame.queryRunState());
  const p = await c.query(keyFrame.queryPercentComplete());
  return { state: s.value, percent: p.value };
});

/* ---------------- IPC: the flight recorder (ADR-0027) ---------------- */

/**
 * What the rig actually did, recorded while it did it.
 *
 * Sampling folds into the poll the renderer was already running for the
 * progress bar, so there is ONE timer and one place a pass is observed from.
 * A second timer would have meant two clocks disagreeing about when the pass
 * was, which is the bug the playhead already taught us (ADR-0025).
 *
 * Safe to do mid-move because the firmware steps off Timer1, not the main loop
 * (`OM_MotorMaster.ino` startISR) — a serial query costs loop time, not steps.
 */
const TRACE_CAP = 20;
/**
 * Recordings are written to disk the moment a pass ends (ADR-0032).
 *
 * They were memory-only for five versions, which means the first hardware day —
 * the one day the measurements matter most, and the day the app is most likely
 * to be restarted — would have lost them to any quit. The mitigation was "export
 * the CSVs by hand", which is not a mitigation on a shoot.
 */
const TRACE_DIR = path.join(app.getPath("userData"), "recordings");
/** Loaded at startup; older files stay on disk and are counted, never deleted. */
const TRACE_LOAD_LIMIT = 50;
let traceFilesOnDisk = 0;
/** Result of the startup read — declared here, filled at startup, read by IPC. */
let traceLoad = { loaded: 0, skipped: 0, onDisk: 0 };
let traces = [];
let activeTrace = null;
let traceSeq = 0;
let traceDropped = 0;

const AXIS_NAMES = ["Slide", "Pan", "Tilt"];

/** Last plan type read back off the device — null until an upload has checked. */
let latchedPlanType = null;

async function readMicrosteps() {
  const out = [];
  for (const m of [1, 2, 3]) {
    try { out.push((await requireClient().query(motors.queryMicrosteps(m))).value); }
    catch { out.push(null); }
  }
  return out;
}

ipcMain.handle("nmx:trace-begin", async (_e, engine, meta) => {
  if (!prefs.trace.enabled) return { recording: false, reason: "recording is switched off in preferences" };
  const microsteps = await readMicrosteps();
  activeTrace = newTrace({
    id: `pass-${++traceSeq}`,
    engine,
    startedAt: new Date().toISOString(),
    durationFrames: meta?.durationFrames ?? 0,
    timebase: meta?.timebase ?? { num: 24, den: 1, dropFrame: false },
    axisNames: AXIS_NAMES,
    microsteps,
  });
  activeTrace.note = meta?.name;
  return { recording: true, id: activeTrace.id, microsteps };
});

/**
 * One poll: progress AND position, in a single IPC round trip.
 *
 * Every position read is individually guarded. A query that times out records a
 * `null` for that axis and the pass carries on — a recorder that can abort the
 * take it is recording is worse than no recorder.
 */
ipcMain.handle("nmx:pass-sample", async (_e, engine) => {
  const c = requireClient();
  const t0 = Date.now();
  let percent = 0, state = 0, running = false;
  if (engine === "classic") {
    percent = (await c.query(general.queryProgramProgress())).value;
    running = Boolean((await c.query(general.queryMotorsRunning())).value);
    state = running ? 1 : 0;
  } else {
    state = (await c.query(keyFrame.queryRunState())).value;
    percent = (await c.query(keyFrame.queryPercentComplete())).value;
    running = state !== 0;
  }

  if (activeTrace) {
    const position = [];
    let suspect = false;
    for (const m of [1, 2, 3]) {
      try { position.push((await c.query(motors.queryPosition(m))).value); }
      catch { position.push(null); }
      if (prefs.trace.checkSending) {
        /* Query 106 comes back rescaled while a motor is mid "send to" — the
           firmware silently switches to quarter-stepping for a send. One motor
           sending taints the whole sample, because a pass where an axis is
           being repositioned is not the phase we are measuring. */
        try { if ((await c.query(motors.queryIsSending(m))).value) suspect = true; }
        catch { /* unknown; leave the sample as taken */ }
      }
    }
    addSample(activeTrace, {
      atMs: t0 - Date.parse(activeTrace.startedAt),
      percent: Number(percent) || 0,
      position,
      suspect,
      costMs: Date.now() - t0,
    });
  }
  return { state, percent, running };
});

ipcMain.handle("nmx:trace-end", async (_e, endedBy, expectedMs) => {
  if (!activeTrace) return null;
  activeTrace.endedBy = endedBy ?? "complete";
  /* Read the device's own arithmetic once, now, while the program's numbers are
     still loaded. Key-frame query 122 IS the denominator the firmware divided
     percent by; comparing it against the duration we uploaded catches ADR-0028's
     bug from the rig rather than from a mode read-back. Guarded individually —
     the recording is worth keeping whether or not this succeeds. */
  const timing = { runTimeMs: null, totalMs: null, expectedMs: expectedMs ?? null };
  try {
    const c = requireClient();
    if (activeTrace.engine === "keyframe") {
      timing.runTimeMs = (await c.query(keyFrame.queryRunTime())).value;
      timing.totalMs = (await c.query(keyFrame.queryMaxRunTime())).value;
    } else {
      timing.runTimeMs = (await c.query(general.queryRunTime())).value;
      timing.totalMs = (await c.query(general.queryProgramTotalTime())).value;
    }
  } catch { /* leave the nulls; timingCheck says so out loud */ }
  activeTrace.deviceTiming = timing;
  const cov = traceCoverage(activeTrace);
  const id = activeTrace.id;
  const timingLines = timingCheck(activeTrace);
  /* Disk FIRST. The file is the record; the in-memory array is only what the
     dialog can show without reading files, and it has a cap that drops the
     oldest. Saving after the cap could have discarded a pass before writing it. */
  const saved = await saveTrace(activeTrace);
  traces.push(activeTrace);
  while (traces.length > TRACE_CAP) { traces.shift(); traceDropped++; }
  traceFilesOnDisk++;
  activeTrace = null;
  return {
    id, coverage: cov, dropped: traceDropped, timing: timingLines,
    saved: typeof saved === "string" ? saved : null,
    saveError: typeof saved === "string" ? null : saved.error,
  };
});

/** Write one recording. Failures are logged into the returned status, never thrown. */
async function saveTrace(trace) {
  try {
    await fs.mkdir(TRACE_DIR, { recursive: true });
    const stamp = trace.startedAt.slice(0, 19).replace(/[:T]/g, "-");
    const file = path.join(TRACE_DIR, `${stamp}-${trace.id}.json`);
    await fs.writeFile(file, JSON.stringify({ ...trace, appVersion: app.getVersion() }, null, 1), "utf-8");
    return file;
  } catch (e) {
    return { error: e.message };
  }
}

/**
 * Read previous sessions back. One unreadable file is skipped and counted — it
 * must not cost you the other nineteen (the `prefs.recent` lesson, v0.7.0).
 */
function loadTraces() {
  let names = [];
  try { names = fsSync.readdirSync(TRACE_DIR).filter((n) => n.endsWith(".json")).sort(); }
  catch { return { loaded: 0, skipped: 0, onDisk: 0 }; }
  traceFilesOnDisk = names.length;
  let skipped = 0;
  for (const name of names.slice(-TRACE_LOAD_LIMIT)) {
    try { traces.push(parsePassTrace(fsSync.readFileSync(path.join(TRACE_DIR, name), "utf-8"))); }
    catch { skipped++; }
  }
  /* Keep ids unique against this session's counter, so a reloaded `pass-3` and a
     new `pass-3` cannot collide in the compare dropdowns. */
  traceSeq = traces.length;
  return { loaded: traces.length, skipped, onDisk: traceFilesOnDisk };
}

ipcMain.handle("nmx:traces", () => ({
  dropped: traceDropped,
  cap: TRACE_CAP,
  dir: TRACE_DIR,
  onDisk: traceFilesOnDisk,
  /* Said out loud rather than swallowed: a file this build could not read is a
     recording somebody made and cannot see. */
  unreadable: traceLoad.skipped,
  loadLimit: TRACE_LOAD_LIMIT,
  items: traces.map((t) => ({
    id: t.id, engine: t.engine, startedAt: t.startedAt, note: t.note,
    endedBy: t.endedBy, microsteps: t.microsteps, coverage: traceCoverage(t),
  })),
}));

ipcMain.handle("nmx:trace-compare", (_e, idA, idB) => {
  const a = traces.find((t) => t.id === idA);
  const b = traces.find((t) => t.id === idB);
  if (!a || !b) throw new Error("that pass is no longer in memory");
  return compareTraces(a, b);
});

/**
 * Measured against the move that was uploaded, sampled from the SAME solver the
 * upload used (ADR-0009) — percent maps to a frame, the frame to milliseconds,
 * and the spline answers. Comparing against a second interpolation would be
 * comparing the rig to a drawing of the move rather than the move.
 */
ipcMain.handle("nmx:trace-vs-plan", (_e, id, film) => {
  const t = traces.find((x) => x.id === id);
  if (!t) throw new Error("that pass is no longer in memory");
  const durMs = filmDurationMs(film);
  const solved = new Map();
  for (const { axis, points } of filmAxesToMs(film)) solved.set(axis, computeVelocities(points));
  return deviationFromPlan(t, (pct) => {
    const ms = (durMs * pct) / 100;
    return [0, 1, 2].map((axis) => {
      const sp = solved.get(axis);
      return sp ? splineAt(sp, ms).value : null;
    });
  });
});

/**
 * The recording as something the timeline can draw: percent mapped onto the
 * frame axis using the trace's OWN duration, so a classic pass and a key-frame
 * pass each land on their own time base rather than being stretched onto the
 * film's.
 */
ipcMain.handle("nmx:trace-points", (_e, id) => {
  const t = traces.find((x) => x.id === id);
  if (!t) throw new Error("that pass is no longer in memory");
  const series = [0, 1, 2].map((axis) => ({
    axis,
    points: t.samples
      .filter((s) => !s.suspect && typeof s.position[axis] === "number")
      .map((s) => ({ frame: (s.percent / 100) * t.durationFrames, pos: s.position[axis] })),
  }));
  return { id: t.id, engine: t.engine, durationFrames: t.durationFrames, series };
});

ipcMain.handle("nmx:trace-csv", async (_e, id) => {
  const t = traces.find((x) => x.id === id);
  if (!t) throw new Error("that pass is no longer in memory");
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: "Export pass recording",
    defaultPath: `${t.id}-${t.startedAt.slice(0, 19).replace(/[:T]/g, "-")}.csv`,
    filters: [{ name: "CSV", extensions: ["csv"] }],
  });
  if (canceled || !filePath) return null;
  await fs.writeFile(filePath, traceToCsv(t), "utf-8");
  return filePath;
});
ipcMain.handle("nmx:goto-kf-start", async (_e, axes) => {
  const c = requireClient();
  for (const { axis, points } of axes) {
    await c.send(motors.sendToPosition(/** @type {1|2|3} */ (axis + 1), Math.round(points[0].position)));
  }
});

/* ---------------- IPC: camera ---------------- */

ipcMain.handle("nmx:cam-arm", async (_e, cfg) => {
  const c = requireClient();
  await c.send(cam.setEnable(true));
  await c.send(cam.setTriggerTime(cfg.triggerMs));
  await c.send(cam.setFocusTime(cfg.focusMs));
  await c.send(cam.setExposureDelay(cfg.delayMs));
  if (cfg.maxShots > 0) await c.send(cam.setMaxShots(cfg.maxShots));
  if (cfg.intervalMs > 0) await c.send(cam.setInterval(cfg.intervalMs));
});
ipcMain.handle("nmx:cam-fire", () => requireClient().send(cam.exposeNow()));
ipcMain.handle("nmx:cam-disable", () => requireClient().send(cam.setEnable(false)));

/* ---------------- IPC: films ---------------- */

/** Push a path onto the recent list. Never throws — it is bookkeeping, and it
    must not be able to fail a save the user has already committed to. */
function remember(filePath) {
  try {
    if (!Array.isArray(prefs.recent)) prefs.recent = [];
    prefs.recent = [filePath, ...prefs.recent.filter((p) => p !== filePath)].slice(0, 8);
    savePrefs();
  } catch { /* bookkeeping only */ }
}

/** Surface a failure where it cannot be missed. A status-bar line is fine for
    "connected"; it is not fine for "your move did not save". */
function reportFailure(win, what, err) {
  const message = err?.message ?? String(err);
  console.error(`[graffik] ${what} failed:`, err);
  dialog.showMessageBox(win, {
    type: "error", title: `${what} failed`, message: `${what} failed`, detail: message,
    buttons: ["OK"], noLink: true,
  }).catch(() => {});
  return message;
}

/**
 * Save the move. With `existingPath` this is Save (no dialog); without it this
 * is Save As. Serialisation happens BEFORE the dialog so an invalid move is
 * refused without first asking the operator where to put it.
 */
ipcMain.handle("nmx:save-film", async (e, film, existingPath) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  try {
    const text = serializeFilm({ ...film, savedAt: new Date().toISOString() });
    let filePath = existingPath;
    if (!filePath) {
      const r = await dialog.showSaveDialog(win, {
        defaultPath: `${film.name.replace(/[^\w\- ]+/g, "").trim() || "move"}.graffik`,
        filters: [{ name: "Graffik NG Move", extensions: ["graffik"] }],
      });
      if (r.canceled || !r.filePath) return null;
      filePath = r.filePath;
    }
    await fs.writeFile(filePath, text, "utf-8");
    remember(filePath);
    return filePath;
  } catch (err) {
    throw new Error(reportFailure(win, "Save", err));
  }
});

ipcMain.handle("nmx:load-film", async (e, presetPath) => {
  let file = presetPath;
  if (!file) {
    const win = BrowserWindow.fromWebContents(e.sender);
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      filters: [{ name: "Graffik NG Move", extensions: ["graffik"] }], properties: ["openFile"],
    });
    if (canceled || !filePaths.length) return null;
    file = filePaths[0];
  }
  try {
    const film = deserializeFilm(await fs.readFile(file, "utf-8"));
    remember(file);
    return { film, path: file };
  } catch (err) {
    throw new Error(reportFailure(BrowserWindow.fromWebContents(e.sender), "Open", err));
  }
});

/* ---------------- IPC: 3D export (ADR-0015) ---------------- */

ipcMain.handle("nmx:export-formats", () =>
  EXPORT_FORMATS.map((f) => ({ id: f.id, label: f.label, ext: f.ext, note: f.note })));

/** What the move covers in real units — the pre-flight scale check. */
ipcMain.handle("nmx:move-extents", (_e, film, calibration) =>
  moveExtents(film, { ...DEFAULT_CALIBRATION, ...calibration }));

ipcMain.handle("nmx:export-move", async (e, film, formatId, opts) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const fmt = EXPORT_FORMATS.find((f) => f.id === formatId);
  if (!fmt) throw new Error(`unknown export format: ${formatId}`);
  try {
    const text = fmt.write(film, opts);        // fails before the dialog if it fails
    const base = (film.name.replace(/[^\w\- ]+/g, "").trim() || "move").replace(/\s+/g, "-").toLowerCase();
    const r = await dialog.showSaveDialog(win, {
      defaultPath: `${base}.${fmt.ext}`,
      filters: [{ name: fmt.label, extensions: [fmt.ext] }],
    });
    if (r.canceled || !r.filePath) return null;
    await fs.writeFile(r.filePath, text, "utf-8");

    const written = [r.filePath];
    if (formatId === "abc") {
      // The Alembic bridge is the USD plus the script that converts it.
      const dir = path.dirname(r.filePath);
      const name = path.basename(r.filePath);
      const scriptPath = path.join(dir, name.replace(/\.usda?$/i, "") + "-convert.py");
      await fs.writeFile(scriptPath, alembicConverterScript(name), "utf-8");
      written.push(scriptPath);
    }
    return { written, format: fmt.label };
  } catch (err) {
    throw new Error(reportFailure(win, "Export", err));
  }
});

/* ---------------- IPC: e-stop ---------------- */

/* ---------------- triggers / cues (ADR-0016) ---------------- */

/** @type {Map<string, import("@graffik-ng/nmx-protocol").TriggerBackend>} */
const backends = new Map();
/** @type {SerialPort | null} */ let trigPort = null;
let scheduler = null, passClock = null, passStartedAt = 0;

const binding = (target) => prefs.triggers.bindings.find((b) => b.target === target);
const backendFor = (id) => backends.get(id);

function ensureScheduler(win) {
  if (!scheduler) {
    scheduler = new CueScheduler(binding, backendFor, (msg) => win?.webContents.send("nmx:cue-problem", msg));
  }
  return scheduler;
}

/** The simulated backend is always present, so cues are testable with nothing attached. */
backends.set("simulated", new SimulatedTriggerBackend({ tier: 1 }));

ipcMain.handle("nmx:trigger-backends", () =>
  [...backends.values()].map((b) => ({ id: b.id, tier: b.tier, outputs: b.outputs(), describe: b.describe() })));

ipcMain.handle("nmx:trigger-connect", async (e, portPath) => {
  await closeTriggerPort();
  const dev = portPath === SIM_PORT ? new SimulatedTriggerDevice() : null;
  if (!dev) {
    trigPort = new SerialPort({ path: portPath, baudRate: 115200, autoOpen: false });
    await new Promise((res, rej) => trigPort.open((err) => (err ? rej(err) : res())));
  }
  const be = new SerialTriggerBackend(dev ?? trigPort);
  const info = await be.hello();
  be.onFired = (id, deviceMs) => BrowserWindow.fromWebContents(e.sender)?.webContents.send("nmx:cue-fired", { id, deviceMs });
  be.onInput = (n, edge, deviceMs) => BrowserWindow.fromWebContents(e.sender)?.webContents.send("nmx:trigger-input", { n, edge, deviceMs });
  backends.set("serial", be);
  prefs.triggers.lastPort = portPath; savePrefs();
  return { ...info, tier: be.tier };
});

async function closeTriggerPort() {
  const be = backends.get("serial");
  if (be) { try { await be.abort(); await be.close(); } catch { /* going away anyway */ } }
  backends.delete("serial");
  if (trigPort?.isOpen) await new Promise((r) => trigPort.close(() => r()));
  trigPort = null;
}
ipcMain.handle("nmx:trigger-disconnect", () => closeTriggerPort());

/** Every trigger transport, closed. Called on quit. */
async function closeAllTriggers() {
  await closeTriggerPort();
  await closeDmx();
  await closeOsc();
}

/* ---- DMX (Enttec DMX USB Pro) ---- */

/** @type {SerialPort | null} */ let dmxPort = null;

async function closeDmx() {
  const be = backends.get("dmx");
  if (be) { try { await be.close(); } catch { /* going away */ } }
  backends.delete("dmx");
  if (dmxPort?.isOpen) await new Promise((r) => dmxPort.close(() => r()));
  dmxPort = null;
}

ipcMain.handle("nmx:dmx-connect", async (_e, portPath) => {
  await closeDmx();
  let transport;
  if (portPath === SIM_PORT) {
    transport = new SimulatedEnttecDevice();
  } else {
    /* The Pro is an FTDI virtual COM port; per Enttec's API the baud rate is a
       dummy value and does not set the DMX timing — the widget owns that. */
    dmxPort = new SerialPort({ path: portPath, baudRate: 115200, autoOpen: false });
    await new Promise((res, rej) => dmxPort.open((err) => (err ? rej(err) : res())));
    transport = dmxPort;
  }
  const be = new DmxTriggerBackend(transport);
  backends.set("dmx", be);
  prefs.triggers.dmxPort = portPath; savePrefs();
  return { id: be.id, tier: be.tier, outputs: be.outputs(), describe: be.describe() };
});
ipcMain.handle("nmx:dmx-disconnect", () => closeDmx());

/* ---- OSC ---- */

async function closeOsc() {
  const be = backends.get("osc");
  if (be) { try { await be.close(); } catch { /* going away */ } }
  backends.delete("osc");
}

ipcMain.handle("nmx:osc-connect", async (_e, cfg) => {
  await closeOsc();
  const conf = { ...prefs.triggers.osc, ...(cfg ?? {}) };
  /* A UDP socket that never binds still sends; there is nothing to fail here,
     which is exactly why OSC needs the receiver checked by hand. */
  const sock = conf.host === "simulated" ? new SimulatedDatagram() : dgram.createSocket("udp4");
  const be = new OscTriggerBackend(
    conf.host === "simulated" ? sock : {
      send: (data, port, host, cb) => sock.send(Buffer.from(data), port, host, cb),
      close: () => sock.close(),
    },
    { host: conf.host, port: conf.port, addressPrefix: conf.prefix },
  );
  backends.set("osc", be);
  prefs.triggers.osc = conf; savePrefs();
  return { id: be.id, tier: be.tier, outputs: be.outputs(), describe: be.describe() };
});
ipcMain.handle("nmx:osc-disconnect", () => closeOsc());

ipcMain.handle("nmx:get-bindings", () => prefs.triggers.bindings);
ipcMain.handle("nmx:set-bindings", (_e, bindings) => {
  prefs.triggers.bindings = Array.isArray(bindings) ? bindings : [];
  savePrefs();
  return prefs.triggers.bindings;
});

/* ------------------------------------------------------------------
   Lens motors (ADR-0018) — the same board as the cues, protocol v2
   ------------------------------------------------------------------ */

/** The lens device IS the trigger board; there is no second connection. */
const lensBackend = () => {
  const be = backends.get("serial");
  return be && be.supportsLens?.() ? be : null;
};

/** Push the stored motor configuration at the board. Cheap and idempotent. */
async function declareLensMotors(be, kinds = LENS_KINDS) {
  for (const kind of kinds) {
    const m = prefs.lens.motors[kind];
    await be.declareLensAxis({ kind, steps: m.steps, maxStepsPerSec: m.maxStepsPerSec, invert: m.invert });
  }
}

/**
 * Write everything this app knows about this rig, today, to a file.
 *
 * A hardware session produces facts that exist only in that room, and by
 * default they live in somebody's memory until the next morning (ADR-0023).
 */
ipcMain.handle("nmx:bringup-report", async (e, extra) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  try {
    const md = bringUpReport({
      at: new Date().toISOString(),
      appVersion: app.getVersion(),
      connection: {
        planType: latchedPlanType,
        origin,
        limitTrust: limitTrust(origin, prefs.limits.some(isTaught)),
        /* `prefs.lastPort` is written on every successful connect, so it is
           the record of what actually answered — a disconnect must not erase
           the report's memory of the session. */
        port: prefs.lastPort,
        firmware: firmwareVersion,
        supported: firmwareVersion === SUPPORTED_FIRMWARE,
        overridden: firmwareGateOverridden,
      },
      limits: prefs.limits,
      calibration: prefs.export.calibration,
      spans: prefs.commission.spans,
      repeatability: { readings: prefs.commission.passes, thresholdMm: prefs.commission.thresholdMm },
      lensMotors: prefs.lens.motors,
      traces: {
        summaries: traces.map((t) => ({
          id: t.id, engine: t.engine, endedBy: t.endedBy, ...traceCoverage(t),
          timing: timingCheck(t),
        })),
        /* The last two COMPLETE passes on the same engine, compared without
           being asked. It is the number the session exists to produce, and a
           report that made you go and click something to get it would mostly
           be written without it. */
        storage: { dir: TRACE_DIR, onDisk: traceFilesOnDisk, unreadable: traceLoad.skipped },
        comparisons: (() => {
          const out = [];
          for (const engine of ["keyframe", "classic"]) {
            const done = traces.filter((t) => t.engine === engine && t.endedBy === "complete");
            if (done.length < 2) continue;
            const [a, b] = done.slice(-2);
            out.push({ title: `${a.id} vs ${b.id} (${engine}) — pass-to-pass`, result: compareTraces(a, b) });
          }
          return out;
        })(),
      },
      triggerDevice: backends.get("serial")?.describe() ?? null,
      log: extra?.log ?? [],
      notes: extra?.notes ?? "",
    });
    const r = await dialog.showSaveDialog(win, {
      defaultPath: `graffik-bringup-${new Date().toISOString().slice(0, 10)}.md`,
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (r.canceled || !r.filePath) return null;
    await fs.writeFile(r.filePath, md, "utf-8");
    return { path: r.filePath, bytes: md.length };
  } catch (err) {
    throw new Error(reportFailure(win, "Bring-up report", err));
  }
});

/* ------------------------------------------------------------------
   Commissioning (ADR-0020) — measuring the rig instead of guessing it
   ------------------------------------------------------------------ */

function commissionFits() {
  const out = {};
  for (const axis of CAL_AXES) {
    const fit = fitCalibration(prefs.commission.spans[axis], CAL_UNIT[axis]);
    const stored = prefs.export.calibration[CAL_PREF_KEY[axis]];
    out[axis] = {
      ...fit,
      unit: CAL_UNIT[axis],
      stored,
      /* Compared against what the export is USING, not against a textbook
         value. "You measured 320 and the file says 160" is actionable; "that
         is unusual for a slider" is not. */
      diagnosis: fit.n && stored ? diagnoseCalibration(fit.perUnit, stored) : null,
    };
  }
  return out;
}

ipcMain.handle("nmx:commission-state", () => ({
  spans: structuredClone(prefs.commission.spans),
  marked: structuredClone(prefs.commission.marked),
  passes: [...prefs.commission.passes],
  thresholdMm: prefs.commission.thresholdMm,
  fits: commissionFits(),
  repeatability: repeatability(prefs.commission.passes, prefs.commission.thresholdMm),
  calibration: structuredClone(prefs.export.calibration),
}));

/** Remember where an axis is now, so the next reading can be a span from here. */
ipcMain.handle("nmx:commission-mark", async (_e, axis) => {
  if (!CAL_AXES.includes(axis)) throw new Error(`unknown axis "${axis}"`);
  const pos = await readPosition(CAL_MOTOR[axis]);
  prefs.commission.marked[axis] = pos;
  savePrefs();
  return pos;
});

/**
 * Close a span: read the position now, subtract the mark, and pair the step
 * count with whatever the tape said.
 */
ipcMain.handle("nmx:commission-span", async (_e, axis, measured, note) => {
  if (!CAL_AXES.includes(axis)) throw new Error(`unknown axis "${axis}"`);
  const from = prefs.commission.marked[axis];
  if (from === null || from === undefined) throw new Error("mark the start first — there is nothing to measure from");
  const m = Number(measured);
  if (!Number.isFinite(m) || m === 0) throw new Error(`"${measured}" is not a distance`);
  const pos = await readPosition(CAL_MOTOR[axis]);
  const steps = pos - from;
  if (steps === 0) throw new Error("the axis has not moved since the mark");
  prefs.commission.spans[axis].push({ steps, measured: m, ...(note ? { note } : {}) });
  prefs.commission.marked[axis] = null;
  savePrefs();
  return commissionFits()[axis];
});

ipcMain.handle("nmx:commission-drop-span", (_e, axis, index) => {
  if (!CAL_AXES.includes(axis)) throw new Error(`unknown axis "${axis}"`);
  prefs.commission.spans[axis].splice(index, 1);
  savePrefs();
  return commissionFits()[axis];
});

/**
 * Write the measured numbers into the calibration the export actually uses.
 *
 * Only axes that HAVE a measurement are touched — applying a zero over a good
 * stored value because one axis has not been measured yet would be the app
 * losing work on the operator's behalf.
 */
ipcMain.handle("nmx:commission-apply", () => {
  const fits = commissionFits();
  const applied = [];
  for (const axis of CAL_AXES) {
    if (!fits[axis].n || !(fits[axis].perUnit > 0)) continue;
    prefs.export.calibration[CAL_PREF_KEY[axis]] = Number(fits[axis].perUnit.toFixed(4));
    applied.push(`${axis} ${fits[axis].perUnit.toFixed(2)} ${fits[axis].unit === "mm" ? "steps/mm" : "steps/°"}`);
  }
  savePrefs();
  return { applied, calibration: structuredClone(prefs.export.calibration), skipped: CAL_AXES.filter((a) => !fits[a].n) };
});

/** A dial-indicator reading after a pass. `null` clears the set. */
ipcMain.handle("nmx:commission-pass", (_e, readingMm) => {
  if (readingMm === null) prefs.commission.passes = [];
  else {
    const v = Number(readingMm);
    if (!Number.isFinite(v)) throw new Error(`"${readingMm}" is not a reading`);
    prefs.commission.passes.push(v);
  }
  savePrefs();
  return { passes: [...prefs.commission.passes], result: repeatability(prefs.commission.passes, prefs.commission.thresholdMm) };
});

ipcMain.handle("nmx:commission-set", (_e, patch) => {
  if (patch.thresholdMm !== undefined) {
    const v = Number(patch.thresholdMm);
    if (Number.isFinite(v) && v > 0) prefs.commission.thresholdMm = v;
  }
  for (const k of ["nodalOffsetMm", "headHeightMm"]) {
    if (patch[k] !== undefined && Number.isFinite(Number(patch[k]))) {
      prefs.export.calibration[k] = Number(patch[k]);
    }
  }
  savePrefs();
  return { thresholdMm: prefs.commission.thresholdMm, calibration: structuredClone(prefs.export.calibration) };
});

/* ---- the lens library (ADR-0019) ---- */

ipcMain.handle("nmx:lens-library", () => structuredClone(prefs.lensLibrary));

/**
 * Save or update a lens. An `id` means "this is the same glass, re-marked";
 * no id means a new entry. The salt is generated here rather than in the core
 * so the core stays pure and testable.
 */
ipcMain.handle("nmx:lens-library-save", (e, entry) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  try {
    const id = entry.id || lensLibraryId(entry.kind, entry.name, Math.random().toString(36).slice(2, 8));
    const saved = { ...entry, id, savedAt: new Date().toISOString() };
    validateLensLibraryEntry(saved);
    const i = prefs.lensLibrary.findIndex((x) => x.id === id);
    if (i >= 0) prefs.lensLibrary[i] = saved; else prefs.lensLibrary.push(saved);
    prefs.lensLibrary.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
    savePrefs();
    return saved;
  } catch (err) {
    throw new Error(reportFailure(win, "Save lens", err));
  }
});

ipcMain.handle("nmx:lens-library-delete", (_e, id) => {
  prefs.lensLibrary = prefs.lensLibrary.filter((x) => x.id !== id);
  savePrefs();
  return prefs.lensLibrary.length;
});

/** Export the whole library — glass moves between rigs and between people. */
ipcMain.handle("nmx:lens-library-export", async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  try {
    if (!prefs.lensLibrary.length) throw new Error("the library is empty — nothing to export");
    const r = await dialog.showSaveDialog(win, {
      defaultPath: "lenses.graffiklens",
      filters: [{ name: "Graffik NG Lens Library", extensions: ["graffiklens", "json"] }],
    });
    if (r.canceled || !r.filePath) return null;
    await fs.writeFile(r.filePath, serializeLensLibrary(prefs.lensLibrary), "utf-8");
    return { path: r.filePath, count: prefs.lensLibrary.length };
  } catch (err) {
    throw new Error(reportFailure(win, "Export lens library", err));
  }
});

/**
 * Import and MERGE. Never replace: somebody hands you their library and losing
 * your own marks in exchange is not an import, it is an accident.
 */
ipcMain.handle("nmx:lens-library-import", async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  try {
    const r = await dialog.showOpenDialog(win, {
      properties: ["openFile"],
      filters: [{ name: "Graffik NG Lens Library", extensions: ["graffiklens", "json"] }],
    });
    if (r.canceled || !r.filePaths.length) return null;
    const incoming = parseLensLibrary(await fs.readFile(r.filePaths[0], "utf-8"));
    const m = mergeLensLibrary(prefs.lensLibrary, incoming);
    prefs.lensLibrary = m.merged;
    savePrefs();
    return { added: m.added, updated: m.updated, rejected: m.rejected, total: m.merged.length };
  } catch (err) {
    throw new Error(reportFailure(win, "Import lens library", err));
  }
});

ipcMain.handle("nmx:lens-status", () => {
  const be = lensBackend();
  return {
    connected: !!be,
    /* A connected v1 cue board is a real, useful device that simply has no lens
       hardware. Saying "not connected" would send the operator looking for a
       cable; saying so explicitly sends them looking for the right board. */
    reason: be ? null : backends.get("serial") ? "the connected board speaks protocol v1 — cues only, no lens axes" : null,
    axes: be ? be.lensAxes() : 0,
    describe: be ? be.describe() : null,
    motors: structuredClone(prefs.lens.motors),
  };
});

ipcMain.handle("nmx:lens-set-motor", async (_e, kind, patch) => {
  if (!LENS_KINDS.includes(kind)) throw new Error(`unknown lens axis "${kind}"`);
  Object.assign(prefs.lens.motors[kind], patch);
  savePrefs();
  const be = lensBackend();
  if (be) await declareLensMotors(be, [kind]);
  return structuredClone(prefs.lens.motors[kind]);
});

/**
 * Drive a barrel into both stops and record the travel between them.
 *
 * Given a long timeout on purpose — a slow barrel takes many seconds, and the
 * 1.5 s request timeout that suits every other command would abandon a
 * calibration that was working perfectly.
 */
ipcMain.handle("nmx:lens-calibrate", async (_e, kind) => {
  const be = lensBackend();
  if (!be) throw new Error("no lens device connected");
  await declareLensMotors(be, [kind]);
  const steps = await be.calibrateLens(kind, 90_000);
  prefs.lens.motors[kind].steps = steps;
  savePrefs();
  return { kind, steps };
});

/** Jog a barrel by hand — for marking a lens against its witness marks. */
ipcMain.handle("nmx:lens-seek", (_e, kind, position) => {
  const be = lensBackend();
  if (!be) throw new Error("no lens device connected");
  be.seekLens(kind, position);
  return true;
});

/**
 * Pre-flight the lens program: is it too big, and can the motors follow it?
 *
 * Same idea as `cue-check`. The expensive moment to learn that a snap focus
 * outruns the motor is the rushes; the cheap one is before the performer is in
 * position.
 */
ipcMain.handle("nmx:lens-check", (_e, film) => {
  const lanes = (film.lensAxes ?? []).map((a) => a.kind);
  const be = lensBackend();
  const motorSteps = Object.fromEntries(LENS_KINDS.map((k) => [k, prefs.lens.motors[k].steps]));
  const program = buildLensProgram(film, { motorSteps });
  const points = lensProgramSize(program);
  return {
    lanes,
    connected: !!be,
    points,
    densePoints: (film.durationFrames + 1) * lanes.length,
    /* An honest estimate: the line the host will actually send, at 115200 8N1. */
    uploadSeconds: Number(((points * 22 * 10) / 115200).toFixed(2)),
    toleranceUnits: program.toleranceUnits,
    infeasible: lanes.length ? lensFeasibility(program, prefs.lens.motors) : [],
  };
});

ipcMain.handle("nmx:lens-upload", async (_e, film) => {
  const be = lensBackend();
  if (!be) throw new Error("no lens device connected");
  await declareLensMotors(be);
  const motorSteps = Object.fromEntries(LENS_KINDS.map((k) => [k, prefs.lens.motors[k].steps]));
  const program = buildLensProgram(film, { motorSteps });
  const sent = await be.uploadLens(program);
  return { points: sent, axes: program.axes.map((a) => ({ kind: a.kind, points: a.points.length })) };
});

/**
 * Ask the CONTROLLER whether the uploaded move is inside what its motors can do
 * (ADR-0031). Selecting an axis is a pure pointer move in the firmware, so this
 * is safe to run after an upload — it cannot disturb the program it is checking.
 */
async function moveFeasibility(film) {
  const c = requireClient();
  const rows = [];
  for (const ax of film.axes ?? []) {
    const row = { axis: ax.axis, name: AXIS_NAMES[ax.axis] ?? `Axis ${ax.axis}`, velocityOk: null, accelOk: null };
    try {
      await c.send(keyFrame.setAxis(ax.axis));
      row.velocityOk = Boolean((await c.query(keyFrame.queryVelocityValid())).value);
      row.accelOk = Boolean((await c.query(keyFrame.queryAccelValid())).value);
    } catch { /* leave nulls — describeMoveFeasibility calls that unchecked */ }
    rows.push(row);
  }
  return rows;
}

/** The same question for the classic engine, where the device answers per motor. */
async function classicFeasibility() {
  const c = requireClient();
  const rows = [];
  for (const m of [1, 2, 3]) {
    const row = { axis: m - 1, name: AXIS_NAMES[m - 1], velocityOk: null, accelOk: null };
    try { row.velocityOk = Boolean((await c.query(motors.queryTwoPointVelocityValid(m))).value); }
    catch { /* stays null */ }
    rows.push(row);
  }
  return rows;
}

ipcMain.handle("nmx:classic-check", async () => {
  const c = requireClient();
  const rows = await classicFeasibility();
  let all = null;
  try { all = Boolean((await c.query(general.queryProgramValid())).value); } catch { /* stays null */ }
  return { rows, all, problems: describeMoveFeasibility(rows), ok: moveIsFeasible(rows) && all !== false };
});

/** Pre-flight: which cues cannot be delivered, checked before the pass runs. */
ipcMain.handle("nmx:cue-check", async (e, film) => {
  const s = ensureScheduler(BrowserWindow.fromWebContents(e.sender));
  s.load(buildCueList(film));
  const serial = backends.get("serial");
  const lensLanes = (film.lensAxes ?? []).length;
  const lensBe = lensBackend();
  /* Lens infeasibility is reported alongside unroutable cues so ONE pre-flight
     gate covers the whole pass. Two gates would mean two chances to skip one. */
  let lensProblems = [];
  if (lensLanes && lensBe) {
    const motorSteps = Object.fromEntries(LENS_KINDS.map((k) => [k, prefs.lens.motors[k].steps]));
    lensProblems = lensFeasibility(buildLensProgram(film, { motorSteps }), prefs.lens.motors);
  }
  return {
    /* One gate covers cues, lens speeds AND whether the rig can physically do
       the move (ADR-0018's stated reason: two gates mean two chances to skip
       one). Async now, because the last of those has to ask the controller. */
    moveProblems: describeMoveFeasibility(await moveFeasibility(film)),
    total: (film.events ?? []).length,
    unroutable: s.unroutable().map((u) => ({ id: u.cue.id, target: u.cue.target, reason: u.reason })),
    tier: serial ? serial.tier : 1,
    device: serial ? serial.describe() : null,
    lensLanes,
    lensDriven: !!lensBe,
    lensProblems: lensProblems.map((p) => ({ kind: p.kind, reason: p.reason })),
  };
});

/**
 * Arm cues for a pass. With a Tier-2 device the whole list is uploaded now and
 * the device runs it off its own clock; otherwise the host schedules them and
 * the caller is told, so the UI can say which it got.
 */
ipcMain.handle("nmx:cues-arm", async (e, film) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const cues = buildCueList(film);
  const s = ensureScheduler(win);
  s.load(cues);
  const serial = backends.get("serial");
  if (serial && serial.tier === 2) {
    /* The lens program must be on the board BEFORE ARM: ARM is what latches it,
       and its reply carries the point count the backend cross-checks against
       what it sent. Uploading after ARM would arm an empty curve. */
    let lensPoints = 0;
    if (serial.supportsLens?.() && (film.lensAxes ?? []).length) {
      await declareLensMotors(serial);
      const motorSteps = Object.fromEntries(LENS_KINDS.map((k) => [k, prefs.lens.motors[k].steps]));
      lensPoints = await serial.uploadLens(buildLensProgram(film, { motorSteps }));
    }
    const routed = cues
      .map((cue) => ({ cue, b: binding(cue.target) }))
      .filter((x) => x.b && x.b.backendId === "serial")
      .map((x) => ({ cue: x.cue, output: x.b.output }));
    const accepted = await serial.arm(routed);
    return { tier: 2, armed: accepted, hostScheduled: cues.length - routed.length, lensPoints };
  }
  return { tier: 1, armed: cues.length, hostScheduled: cues.length, lensPoints: 0 };
});

/** Called by the renderer the instant the move starts, so t=0 is the same t=0. */
ipcMain.handle("nmx:cues-start", async () => {
  const serial = backends.get("serial");
  if (serial && serial.tier === 2) await serial.start();
  if (!scheduler) return { running: false };
  scheduler.start();
  passStartedAt = Date.now();
  clearInterval(passClock);
  // 10 ms is well inside the ±20 ms Tier-1 jitter this cannot fix; a faster
  // poll would only make the number look better without making it truer.
  passClock = setInterval(() => scheduler.advanceTo(Date.now() - passStartedAt), 10);
  return { running: true };
});

function stopCues() {
  clearInterval(passClock); passClock = null;
  scheduler?.stop();
}
/**
 * Stop dispatch and report what Tier 1 actually delivered. The measured number
 * is the whole point: "±20 ms and not repeatable" is a claim until a pass hands
 * back its own worst case (ADR-0016).
 */
ipcMain.handle("nmx:cues-stop", async () => {
  stopCues();
  if (!scheduler) return { fired: 0, worstJitterMs: 0, dispatched: [] };
  return {
    fired: scheduler.dispatched.length,
    worstJitterMs: scheduler.worstJitterMs(),
    dispatched: scheduler.dispatched.map((d) => ({ id: d.id, target: d.target, atMs: d.atMs, firedAtMs: d.firedAtMs })),
  };
});

ipcMain.handle("nmx:cue-test", async (_e, target, action) => {
  const b = binding(target);
  if (!b) throw new Error(`"${target}" is not bound to an output`);
  const be = backendFor(b.backendId);
  if (!be) throw new Error(`backend "${b.backendId}" is not connected`);
  await be.fire({ id: "test", atMs: 0, target, action }, b.output);
});

ipcMain.handle("nmx:stop-all", async () => {
  stopJogMonitor();
  /* An armed cue list is state on a device the motion e-stop does not reach
     (ADR-0016). Cancel it FIRST and independently of the NMX: if the serial
     link to the controller is the thing that has failed, the cue that is about
     to fire is still ours to stop. */
  stopCues();
  for (const be of backends.values()) { try { await be.abort(); } catch { /* best effort */ } }
  if (client) await client.stopAll();
});

/* ---------------- window ---------------- */

function createWindow() {
  const w = prefs.window ?? DEFAULT_PREFS.window;
  const win = new BrowserWindow({
    width: w.width, height: w.height,
    x: w.x, y: w.y,
    useContentSize: true,
    minWidth: 940, minHeight: 660,
    title: "Graffik NG",
    backgroundColor: "#131517",
    icon: path.join(__dirname, "build", "icons", "512x512.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile("index.html");

  const remember = () => {
    if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
    const b = win.getContentBounds();
    prefs.window = { width: b.width, height: b.height, x: b.x, y: b.y };
    savePrefs();
  };
  win.on("resize", remember);
  win.on("move", remember);

  if (process.platform === "darwin" && app.dock) {
    try { app.dock.setIcon(path.join(__dirname, "build", "icons", "512x512.png")); } catch { /* non-fatal */ }
  }
}

loadPrefs();
/* Previous sessions' recordings, before the first window opens, so the Passes
   dialog has them the moment it is asked (ADR-0032). */
traceLoad = loadTraces();
app.whenReady().then(createWindow);
app.on("window-all-closed", async () => {
  /* Close the trigger transports too, and abort before closing: a board left
     holding an armed cue list, or a DMX lamp left at full, is not "quit". */
  await closeAllTriggers();
  await disconnect();
  app.quit();
});
