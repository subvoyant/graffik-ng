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
import { SerialPort } from "serialport";
import {
  NmxClient, SimulatedNmx, handshake,
  general, motors, cam, keyFrame,
  buildKeyFrameMove, runSequence, computeVelocities, splineAt,
  serializeFilm, deserializeFilm,
  filmAxesToMs, filmDurationMs, filmCueMs, msToFramesExact, framesToMs,
  EXPORT_FORMATS, DEFAULT_CALIBRATION, DEFAULT_LENS, moveExtents, alembicConverterScript,
  buildCueList, SimulatedTriggerBackend, SerialTriggerBackend, SimulatedTriggerDevice, CueScheduler,
  NO_LIMITS, isTaught, jogWouldExceed, violationsForFilm, describeViolations,
} from "@graffik-ng/nmx-protocol";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SIM_PORT = "simulator://nmx";
const NMX_BAUD = 19200;          // firmware: USBSerial.begin(19200) — ADR-0004
const SUPPORTED_FIRMWARE = 70;   // ADR-0004: refuse programmed moves on other versions
const MAX_JOG_SPEED = 4000;      // hard clamp, independent of soft limits

/* ---------------- preferences ---------------- */

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
  },
  recent: [],
  /* 3D export settings (ADR-0015). Calibration is a property of the RIG, so it
     belongs in preferences, not in the move file — the same move exported from
     a re-belted rig needs the new numbers, not the old ones. */
  /* Logical target -> physical output (ADR-0016). Bindings are rig config, so
     they live here rather than in the move file — a .graffik must survive being
     carried to another rig. */
  triggers: {
    bindings: [
      { target: "cue-light", backendId: "simulated", output: 1 },
    ],
    lastPort: null,
  },
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
      },
      limits: Array.isArray(raw.limits) && raw.limits.length === 3 ? raw.limits : structuredClone(NO_LIMITS),
      /* `recent` was the one sub-object without a guard, and it is read with
         .filter() by both save and load — so a preferences file carrying
         anything but an array broke exactly those two commands and nothing
         else. Every sub-object gets a guard now; none of them may be trusted
         to have survived an older build. */
      recent: Array.isArray(raw.recent) ? raw.recent.filter((p) => typeof p === "string") : [],
      triggers: {
        ...DEFAULT_PREFS.triggers, ...(raw.triggers ?? {}),
        bindings: Array.isArray(raw.triggers?.bindings) ? raw.triggers.bindings : [...DEFAULT_PREFS.triggers.bindings],
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
  prefs.lastPort = portPath; savePrefs();
  return { firmwareVersion, supported: firmwareVersion === SUPPORTED_FIRMWARE };
}

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
      const lim = prefs.limits[motor - 1];
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
  return [
    ...ports.map((p) => ({ path: p.path, manufacturer: p.manufacturer ?? "" })),
    { path: SIM_PORT, manufacturer: "demo mode — no hardware" },
  ];
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
  savePrefs();
  return prefs.limits;
});
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
  const speed = Math.max(-MAX_JOG_SPEED, Math.min(MAX_JOG_SPEED, stepsPerSec));
  const lim = prefs.limits[motor - 1];

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

ipcMain.handle("nmx:position", async (_e, motor) => {
  const r = await requireClient().query(motors.queryPosition(motor));
  return r.value;
});

/* ---------------- IPC: classic engine ---------------- */

ipcMain.handle("nmx:set-start-here", () => requireClient().send(general.setStartHere()));
ipcMain.handle("nmx:set-stop-here", () => requireClient().send(general.setStopHere()));

/** Classic 2-point arm. Frames in (ADR-0014); ms only inside, for the wire. */
ipcMain.handle("nmx:arm-move", async (_e, travelFrames, accelFrames, decelFrames, timebase) => {
  const c = requireProgrammedMovesAllowed();
  const travelMs = framesToMs(travelFrames, timebase);
  const accelMs = framesToMs(accelFrames, timebase);
  const decelMs = framesToMs(decelFrames, timebase);
  await c.send(general.setProgramMode(1));
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
  const v = violationsForFilm(film, prefs.limits);
  if (v.length) throw new Error("Soft limits: " + describeViolations(v));
  const packets = buildKeyFrameMove(filmAxesToMs(film), { videoTimeMs: filmDurationMs(film) });
  for (const p of packets) await c.send(p);
  return packets.length;
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

ipcMain.handle("nmx:get-bindings", () => prefs.triggers.bindings);
ipcMain.handle("nmx:set-bindings", (_e, bindings) => {
  prefs.triggers.bindings = Array.isArray(bindings) ? bindings : [];
  savePrefs();
  return prefs.triggers.bindings;
});

/** Pre-flight: which cues cannot be delivered, checked before the pass runs. */
ipcMain.handle("nmx:cue-check", (e, film) => {
  const s = ensureScheduler(BrowserWindow.fromWebContents(e.sender));
  s.load(buildCueList(film));
  const serial = backends.get("serial");
  return {
    total: (film.events ?? []).length,
    unroutable: s.unroutable().map((u) => ({ id: u.cue.id, target: u.cue.target, reason: u.reason })),
    tier: serial ? serial.tier : 1,
    device: serial ? serial.describe() : null,
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
    const routed = cues
      .map((cue) => ({ cue, b: binding(cue.target) }))
      .filter((x) => x.b && x.b.backendId === "serial")
      .map((x) => ({ cue: x.cue, output: x.b.output }));
    const accepted = await serial.arm(routed);
    return { tier: 2, armed: accepted, hostScheduled: cues.length - routed.length };
  }
  return { tier: 1, armed: cues.length, hostScheduled: cues.length };
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
ipcMain.handle("nmx:cues-stop", async () => { stopCues(); return scheduler?.worstJitterMs() ?? 0; });

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
app.whenReady().then(createWindow);
app.on("window-all-closed", async () => { await disconnect(); app.quit(); });
