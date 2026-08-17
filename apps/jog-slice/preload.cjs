const { contextBridge, ipcRenderer } = require("electron");

/**
 * Timecode math is exposed SYNCHRONOUSLY from the core package (ADR-0014).
 *
 * The renderer redraws the timeline on every pointer move; a per-tick IPC
 * round-trip for "what timecode is this frame" would be absurd. But timecode
 * must still have exactly one implementation — a second copy in the renderer
 * would drift, and drop-frame is precisely the kind of arithmetic that drifts
 * quietly. So the tested core functions are bridged straight through as pure
 * functions. `require()` of an ESM package needs Node >= 22.12, which every
 * Electron we support ships; if that ever regresses, fail loudly here rather
 * than let a duplicate implementation grow.
 */
let core;
try {
  core = require("@graffik-ng/nmx-protocol");
} catch (err) {
  throw new Error(
    "preload could not load @graffik-ng/nmx-protocol — run `npm run build --prefix ../../packages/nmx-protocol`. " +
      `Underlying error: ${err.message}`,
  );
}

contextBridge.exposeInMainWorld("tc", {
  TIMEBASES: core.TIMEBASES.map((t) => ({ id: t.id, label: t.label, tb: { ...t.tb } })),
  DEFAULT_TIMEBASE: { ...core.DEFAULT_TIMEBASE },
  timebaseById: (id) => core.timebaseById(id),
  timebaseId: (tb) => core.timebaseId(tb),
  timebaseLabel: (tb) => core.timebaseLabel(tb),
  nominalRate: (tb) => core.nominalRate(tb),
  fpsDecimal: (tb) => core.fpsDecimal(tb),
  framesToTimecode: (f, tb) => core.framesToTimecode(f, tb),
  timecodeToFrames: (s, tb) => core.timecodeToFrames(s, tb),
  framesToMs: (f, tb) => core.framesToMs(f, tb),
  framesToMsExact: (f, tb) => core.framesToMsExact(f, tb),
  msToFrames: (ms, tb) => core.msToFrames(ms, tb),
  msToFramesExact: (ms, tb) => core.msToFramesExact(ms, tb),
  formatDuration: (f, tb) => core.formatDuration(f, tb),
  retimeFrames: (f, from, to) => core.retimeFrames(f, from, to),
  newFilm: (name, durationFrames, tb) => core.newFilm(name, durationFrames, tb),
});

contextBridge.exposeInMainWorld("nmx", {
  // connection
  listPorts: () => ipcRenderer.invoke("nmx:list-ports"),
  connect: (path) => ipcRenderer.invoke("nmx:connect", path),
  disconnect: () => ipcRenderer.invoke("nmx:disconnect"),
  overrideFirmwareGate: () => ipcRenderer.invoke("nmx:override-firmware-gate"),
  // preferences
  getPrefs: () => ipcRenderer.invoke("nmx:get-prefs"),
  setPrefs: (patch) => ipcRenderer.invoke("nmx:set-prefs", patch),
  // soft limits
  getLimits: () => ipcRenderer.invoke("nmx:get-limits"),
  setLimitHere: (motor, bound) => ipcRenderer.invoke("nmx:set-limit-here", motor, bound),
  clearLimits: (motor) => ipcRenderer.invoke("nmx:clear-limits", motor),
  onLimitHit: (fn) => ipcRenderer.on("nmx:limit-hit", (_e, d) => fn(d)),
  // jog
  enableMotors: () => ipcRenderer.invoke("nmx:enable-motors"),
  jog: (motor, stepsPerSec) => ipcRenderer.invoke("nmx:jog", motor, stepsPerSec),
  position: (motor) => ipcRenderer.invoke("nmx:position", motor),
  // classic engine
  setStartHere: () => ipcRenderer.invoke("nmx:set-start-here"),
  setStopHere: () => ipcRenderer.invoke("nmx:set-stop-here"),
  armMove: (travelFrames, accelFrames, decelFrames, timebase) =>
    ipcRenderer.invoke("nmx:arm-move", travelFrames, accelFrames, decelFrames, timebase),
  gotoStart: () => ipcRenderer.invoke("nmx:goto-start"),
  run: () => ipcRenderer.invoke("nmx:run"),
  pause: () => ipcRenderer.invoke("nmx:pause"),
  progress: () => ipcRenderer.invoke("nmx:progress"),
  // key-frame engine
  previewMove: (film, n) => ipcRenderer.invoke("nmx:preview-move", film, n),
  uploadKf: (film) => ipcRenderer.invoke("nmx:upload-kf", film),
  cueMs: (film) => ipcRenderer.invoke("nmx:cue-ms", film),
  kfRun: () => ipcRenderer.invoke("nmx:kf-run"),
  kfStop: () => ipcRenderer.invoke("nmx:kf-stop"),
  kfProgress: () => ipcRenderer.invoke("nmx:kf-progress"),
  gotoKfStart: (axes) => ipcRenderer.invoke("nmx:goto-kf-start", axes),
  // camera
  camArm: (cfg) => ipcRenderer.invoke("nmx:cam-arm", cfg),
  camFire: () => ipcRenderer.invoke("nmx:cam-fire"),
  camDisable: () => ipcRenderer.invoke("nmx:cam-disable"),
  // move files
  saveFilm: (film, existingPath) => ipcRenderer.invoke("nmx:save-film", film, existingPath),
  loadFilm: (path) => ipcRenderer.invoke("nmx:load-film", path),
  // 3D export
  exportFormats: () => ipcRenderer.invoke("nmx:export-formats"),
  exportMove: (film, formatId, opts) => ipcRenderer.invoke("nmx:export-move", film, formatId, opts),
  moveExtents: (film, calibration) => ipcRenderer.invoke("nmx:move-extents", film, calibration),
  // e-stop
  stopAll: () => ipcRenderer.invoke("nmx:stop-all"),
});
