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

ipcMain.handle("nmx:arm-move", async (_e, travelMs, accelMs, decelMs) => {
  const c = requireProgrammedMovesAllowed();
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

/** Pure math — no client needed; the editor works disconnected (ADR-0009). */
ipcMain.handle("nmx:preview-move", (_e, axes, durationMs, sampleCount = 140) =>
  axes.map(({ axis, points }) => {
    const solved = computeVelocities(points);
    const samples = [];
    for (let i = 0; i <= sampleCount; i++) {
      const t = (durationMs * i) / sampleCount;
      samples.push({ t, pos: splineAt(solved, t).value });
    }
    return { axis, solved, samples };
  }));

ipcMain.handle("nmx:upload-kf", async (_e, axes, durationMs) => {
  const c = requireProgrammedMovesAllowed();
  // Nothing reaches the controller before the whole move is checked (ADR-0013).
  const film = { format: "graffik-ng-move", version: 1, name: "x", durationMs, startDelayMs: 0, engine: "keyframe", axes };
  const v = violationsForFilm(film, prefs.limits);
  if (v.length) throw new Error("Soft limits: " + describeViolations(v));
  const packets = buildKeyFrameMove(axes.map(({ axis, points }) => ({ axis, points })), { videoTimeMs: durationMs });
  for (const p of packets) await c.send(p);
  return packets.length;
});

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

ipcMain.handle("nmx:save-film", async (e, film) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: `${film.name.replace(/[^\w\- ]+/g, "") || "move"}.graffik`,
    filters: [{ name: "Graffik NG Move", extensions: ["graffik"] }],
  });
  if (canceled || !filePath) return null;
  await fs.writeFile(filePath, serializeFilm({ ...film, savedAt: new Date().toISOString() }), "utf-8");
  prefs.recent = [filePath, ...prefs.recent.filter((p) => p !== filePath)].slice(0, 8);
  savePrefs();
  return filePath;
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
  const film = deserializeFilm(await fs.readFile(file, "utf-8"));
  prefs.recent = [file, ...prefs.recent.filter((p) => p !== file)].slice(0, 8);
  savePrefs();
  return film;
});

/* ---------------- IPC: e-stop ---------------- */

ipcMain.handle("nmx:stop-all", async () => {
  stopJogMonitor();
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
