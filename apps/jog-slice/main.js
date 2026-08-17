/**
 * Graffik NG — main process. ALL hardware I/O lives here (see ADR-0007);
 * the renderer sees only the intent-level IPC surface below.
 */
import { app, BrowserWindow, dialog, ipcMain } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SerialPort } from "serialport";
import {
  NmxClient,
  SimulatedNmx,
  handshake,
  general,
  motors,
  cam,
  keyFrame,
  buildKeyFrameMove,
  runSequence,
  computeVelocities,
  splineAt,
  serializeFilm,
  deserializeFilm,
} from "@graffik-ng/nmx-protocol";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SIM_PORT = "simulator://nmx";
const NMX_BAUD = 19200; // firmware: USBSerial.begin(19200) — see ADR-0004
const SUPPORTED_FIRMWARE = 70; // ADR-0004: refuse programmed moves on other versions
const MAX_JOG_SPEED = 4000; // steps/s hard clamp — safety rail (ADR-0008 spirit)

/** @type {SerialPort | null} */
let port = null;
/** @type {NmxClient | null} */
let client = null;
/** @type {SimulatedNmx | null} */
let sim = null;
let firmwareVersion = null;
let firmwareGateOverridden = false;

async function connect(portPath) {
  await disconnect();
  if (portPath === SIM_PORT) {
    port = null;
    sim = new SimulatedNmx();
    sim.startPhysics(); // demo mode: jog actually moves positions in real time
    client = new NmxClient(sim, { timeoutMs: 800 });
  } else {
    port = new SerialPort({ path: portPath, baudRate: NMX_BAUD, autoOpen: false });
    await new Promise((resolve, reject) => port.open((err) => (err ? reject(err) : resolve())));
    client = new NmxClient(port, { timeoutMs: 800 });
  }
  const version = await handshake(client); // fw version query + Graffik mode on
  await client.send(general.setJoystickWatchdog(true)); // dead-man's switch for jogging
  firmwareVersion = version.value;
  firmwareGateOverridden = false;
  return { firmwareVersion, supported: firmwareVersion === SUPPORTED_FIRMWARE };
}

async function disconnect() {
  if (client) {
    try {
      await client.stopAll();
    } catch {
      /* device may already be gone */
    }
  }
  if (port?.isOpen) await new Promise((resolve) => port.close(() => resolve()));
  sim?.stopPhysics();
  sim = null;
  port = null;
  client = null;
  firmwareVersion = null;
}

function requireClient() {
  if (!client) throw new Error("Not connected");
  return client;
}

/** ADR-0004 gate: programmed moves only on the firmware we verified against. */
function requireProgrammedMovesAllowed() {
  const c = requireClient();
  if (firmwareVersion !== SUPPORTED_FIRMWARE && !firmwareGateOverridden) {
    throw new Error(
      `Firmware v${firmwareVersion} ≠ verified v${SUPPORTED_FIRMWARE}. ` +
        `Programmed moves blocked (command maps differ across firmware eras). ` +
        `Update the NMX firmware, or explicitly override in the app.`,
    );
  }
  return c;
}

/* ---------------- connection ---------------- */

ipcMain.handle("nmx:list-ports", async () => {
  const ports = await SerialPort.list();
  return [
    ...ports.map((p) => ({ path: p.path, manufacturer: p.manufacturer ?? "" })),
    { path: SIM_PORT, manufacturer: "demo mode — no hardware" },
  ];
});
ipcMain.handle("nmx:connect", (_e, portPath) => connect(portPath));
ipcMain.handle("nmx:disconnect", () => disconnect());
ipcMain.handle("nmx:override-firmware-gate", () => {
  firmwareGateOverridden = true;
});

/* ---------------- jog ---------------- */

ipcMain.handle("nmx:enable-motors", async () => {
  const c = requireClient();
  for (const m of [1, 2, 3]) await c.send(motors.setEnable(m, true));
});

ipcMain.handle("nmx:jog", (_e, motor, stepsPerSec) => {
  const clamped = Math.max(-MAX_JOG_SPEED, Math.min(MAX_JOG_SPEED, stepsPerSec));
  return requireClient().send(motors.setContinuousSpeed(motor, clamped));
});

ipcMain.handle("nmx:position", async (_e, motor) => {
  const res = await requireClient().query(motors.queryPosition(motor));
  return res.value;
});

/* ---------------- classic 2-point engine ---------------- */

ipcMain.handle("nmx:set-start-here", () => requireClient().send(general.setStartHere()));
ipcMain.handle("nmx:set-stop-here", () => requireClient().send(general.setStopHere()));

ipcMain.handle("nmx:arm-move", async (_e, travelMs, accelMs, decelMs) => {
  const c = requireProgrammedMovesAllowed();
  await c.send(general.setProgramMode(1)); // continuous (video)
  await c.send(general.setStartDelay(0)); // cue countdown is host-side, uniform across engines
  for (const m of [1, 2, 3]) {
    await c.send(motors.setTravel(m, travelMs));
    await c.send(motors.setProgramAccel(m, accelMs));
    await c.send(motors.setProgramDecel(m, decelMs));
    await c.send(motors.setEasing(m, 2)); // quadratic ease
  }
});

ipcMain.handle("nmx:goto-start", () => requireClient().send(general.sendAllToStart()));
ipcMain.handle("nmx:run", () => requireProgrammedMovesAllowed().send(general.startProgram()));
ipcMain.handle("nmx:pause", () => requireClient().send(general.pauseProgram()));

ipcMain.handle("nmx:progress", async () => {
  const c = requireClient();
  const progress = await c.query(general.queryProgramProgress());
  const running = await c.query(general.queryMotorsRunning());
  return { percent: progress.value, running: Boolean(running.value) };
});

/* ---------------- key-frame engine (timeline editor) ---------------- */

/**
 * Pure math — works while disconnected. The preview curve comes from the SAME
 * solver that programs the firmware (ADR-0009): what you see is what it runs.
 */
ipcMain.handle("nmx:preview-move", (_e, axes, durationMs, sampleCount = 120) => {
  return axes.map(({ axis, points }) => {
    const solved = computeVelocities(points);
    const samples = [];
    for (let i = 0; i <= sampleCount; i++) {
      const t = (durationMs * i) / sampleCount;
      samples.push({ t, pos: splineAt(solved, t).value });
    }
    return { axis, solved, samples };
  });
});

ipcMain.handle("nmx:upload-kf", async (_e, axes, durationMs) => {
  const c = requireProgrammedMovesAllowed();
  const packets = buildKeyFrameMove(
    axes.map(({ axis, points }) => ({ axis, points })),
    { videoTimeMs: durationMs },
  );
  for (const p of packets) await c.send(p);
  return packets.length;
});

ipcMain.handle("nmx:kf-run", async () => {
  const c = requireProgrammedMovesAllowed();
  for (const p of runSequence()) await c.send(p); // take up backlash, then run
});
ipcMain.handle("nmx:kf-stop", () => requireClient().send(keyFrame.stop()));

ipcMain.handle("nmx:kf-progress", async () => {
  const c = requireClient();
  const state = await c.query(keyFrame.queryRunState()); // 0 stopped / 1 running / 2 paused
  const pct = await c.query(keyFrame.queryPercentComplete());
  return { state: state.value, percent: pct.value };
});

/** Return all motors to the move's first keyframe positions (pass reset for KF engine). */
ipcMain.handle("nmx:goto-kf-start", async (_e, axes) => {
  const c = requireClient();
  for (const { axis, points } of axes) {
    await c.send(motors.sendToPosition(/** @type {1|2|3} */ (axis + 1), Math.round(points[0].position)));
  }
});

/* ---------------- camera (sub-address 4) ---------------- */

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

/* ---------------- film save/load ---------------- */

ipcMain.handle("nmx:save-film", async (e, film) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: `${film.name.replace(/[^\w\- ]+/g, "") || "move"}.graffik`,
    filters: [{ name: "Graffik NG Move", extensions: ["graffik"] }],
  });
  if (canceled || !filePath) return null;
  const stamped = { ...film, savedAt: new Date().toISOString() };
  await fs.writeFile(filePath, serializeFilm(stamped), "utf-8");
  return filePath;
});

ipcMain.handle("nmx:load-film", async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    filters: [{ name: "Graffik NG Move", extensions: ["graffik"] }],
    properties: ["openFile"],
  });
  if (canceled || filePaths.length === 0) return null;
  const json = await fs.readFile(filePaths[0], "utf-8");
  return deserializeFilm(json); // throws with readable reason on bad file
});

/* ---------------- e-stop ---------------- */

ipcMain.handle("nmx:stop-all", async () => {
  if (!client) return;
  await client.stopAll();
});

/* ---------------- window ---------------- */

function createWindow() {
  const win = new BrowserWindow({
    width: 900,
    height: 930,
    useContentSize: true,
    minWidth: 820,
    minHeight: 760,
    title: "Graffik NG",
    icon: path.join(__dirname, "build", "icons", "512x512.png"), // win/linux; packaged macOS uses build/icon.icns
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile("index.html");
  // dev-mode dock icon on macOS (packaged apps get it from the bundle)
  if (process.platform === "darwin" && app.dock) {
    try { app.dock.setIcon(path.join(__dirname, "build", "icons", "512x512.png")); } catch { /* non-fatal */ }
  }
}

app.whenReady().then(createWindow);
app.on("window-all-closed", async () => {
  await disconnect();
  app.quit();
});
