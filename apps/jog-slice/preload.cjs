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

/**
 * The physical-control policy (ADR-0021), bridged rather than copied.
 *
 * Same reasoning as the timecode bridge above: the hold times and the
 * stop-is-instant rule are the load-bearing part, the button loop reads them
 * every 40 ms, and a second copy in the renderer would be a second place for
 * "starting requires deliberation" to quietly stop being true.
 */
/**
 * Lens helpers, bridged rather than reimplemented (ADR-0024).
 *
 * The renderer had grown its own copy of the mark-interpolating formatter, its
 * own axis constructor and its own map<->library-entry conversion — the exact
 * duplication the timecode bridge exists to prevent, arrived at by the exact
 * same route (a pure function in the core with no way to reach it from the UI).
 * A dead-export audit found all four at once.
 */
contextBridge.exposeInMainWorld("lens", {
  formatValue: (axis, position) => core.formatLensValue(axis, position),
  positionFor: (map, value) => core.lensPositionFor(map, value),
  newAxis: (kind, durationFrames) => core.newLensAxis(kind, durationFrames),
  entryToMap: (entry) => core.lensEntryToMap(entry),
  mapToEntry: (map, id, savedAt) => core.lensMapToEntry(map, id, savedAt),
  UNITS: { ...core.LENS_UNITS },
});

contextBridge.exposeInMainWorld("controls", {
  ACTIONS: core.CONTROL_ACTIONS.map((a) => ({ ...a })),
  STOP_ACTION_ID: core.STOP_ACTION_ID,
  DEFAULT_BUTTON_BINDINGS: structuredClone(core.DEFAULT_BUTTON_BINDINGS),
  unboundStopWarning: (b) => core.unboundStopWarning(b),
  duplicateButtonBindings: (b) => core.duplicateButtonBindings(b),
});

/* How a deviation is WORDED is a policy, not a rendering detail — "a bound, not
   a measurement" has to say the same thing in the modal and in the bring-up
   report. Bridged rather than reimplemented, for the reason the four lens
   helpers taught us in v0.17. */
contextBridge.exposeInMainWorld("trace", {
  deviationLines: (r) => core.deviationLines(r),
});

contextBridge.exposeInMainWorld("nmx", {
  // connection
  listPorts: () => ipcRenderer.invoke("nmx:list-ports"),
  diagnose: (path) => ipcRenderer.invoke("nmx:diagnose", path),
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
  previewLens: (film) => ipcRenderer.invoke("nmx:preview-lens", film),
  kfRun: () => ipcRenderer.invoke("nmx:kf-run"),
  kfStop: () => ipcRenderer.invoke("nmx:kf-stop"),
  kfProgress: () => ipcRenderer.invoke("nmx:kf-progress"),
  gotoKfStart: (axes) => ipcRenderer.invoke("nmx:goto-kf-start", axes),
  // the flight recorder (ADR-0027) — passSample replaces the progress poll,
  // because the pass is observed from one place or from two disagreeing ones
  // limit trust (ADR-0030)
  classicCheck: () => ipcRenderer.invoke("nmx:classic-check"),
  limitStatus: () => ipcRenderer.invoke("nmx:limit-status"),
  trustLimits: () => ipcRenderer.invoke("nmx:trust-limits"),
  setRestorePosition: (on) => ipcRenderer.invoke("nmx:set-restore-position", on),
  traceBegin: (engine, meta) => ipcRenderer.invoke("nmx:trace-begin", engine, meta),
  passSample: (engine) => ipcRenderer.invoke("nmx:pass-sample", engine),
  traceEnd: (endedBy, expectedMs) => ipcRenderer.invoke("nmx:trace-end", endedBy, expectedMs),
  traces: () => ipcRenderer.invoke("nmx:traces"),
  traceCompare: (a, b) => ipcRenderer.invoke("nmx:trace-compare", a, b),
  traceVsPlan: (id, film) => ipcRenderer.invoke("nmx:trace-vs-plan", id, film),
  tracePoints: (id) => ipcRenderer.invoke("nmx:trace-points", id),
  traceCsv: (id) => ipcRenderer.invoke("nmx:trace-csv", id),
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
  // triggers / cues (ADR-0016)
  triggerBackends: () => ipcRenderer.invoke("nmx:trigger-backends"),
  triggerConnect: (path) => ipcRenderer.invoke("nmx:trigger-connect", path),
  triggerDisconnect: () => ipcRenderer.invoke("nmx:trigger-disconnect"),
  dmxConnect: (path) => ipcRenderer.invoke("nmx:dmx-connect", path),
  dmxDisconnect: () => ipcRenderer.invoke("nmx:dmx-disconnect"),
  oscConnect: (cfg) => ipcRenderer.invoke("nmx:osc-connect", cfg),
  oscDisconnect: () => ipcRenderer.invoke("nmx:osc-disconnect"),
  getBindings: () => ipcRenderer.invoke("nmx:get-bindings"),
  setBindings: (b) => ipcRenderer.invoke("nmx:set-bindings", b),
  cueCheck: (film) => ipcRenderer.invoke("nmx:cue-check", film),
  cuesArm: (film) => ipcRenderer.invoke("nmx:cues-arm", film),
  cuesStart: () => ipcRenderer.invoke("nmx:cues-start"),
  cuesStop: () => ipcRenderer.invoke("nmx:cues-stop"),
  cueTest: (target, action) => ipcRenderer.invoke("nmx:cue-test", target, action),
  onCueFired: (fn) => ipcRenderer.on("nmx:cue-fired", (_e, d) => fn(d)),
  onCueProblem: (fn) => ipcRenderer.on("nmx:cue-problem", (_e, d) => fn(d)),
  onTriggerInput: (fn) => ipcRenderer.on("nmx:trigger-input", (_e, d) => fn(d)),
  // lens motors (ADR-0018) — the same board as the cues, protocol v2
  lensStatus: () => ipcRenderer.invoke("nmx:lens-status"),
  lensSetMotor: (kind, patch) => ipcRenderer.invoke("nmx:lens-set-motor", kind, patch),
  lensCalibrate: (kind) => ipcRenderer.invoke("nmx:lens-calibrate", kind),
  lensSeek: (kind, position) => ipcRenderer.invoke("nmx:lens-seek", kind, position),
  lensCheck: (film) => ipcRenderer.invoke("nmx:lens-check", film),
  // lens library (ADR-0019)
  lensLibrary: () => ipcRenderer.invoke("nmx:lens-library"),
  lensLibrarySave: (entry) => ipcRenderer.invoke("nmx:lens-library-save", entry),
  lensLibraryDelete: (id) => ipcRenderer.invoke("nmx:lens-library-delete", id),
  lensLibraryExport: () => ipcRenderer.invoke("nmx:lens-library-export"),
  lensLibraryImport: () => ipcRenderer.invoke("nmx:lens-library-import"),
  lensUpload: (film) => ipcRenderer.invoke("nmx:lens-upload", film),
  // commissioning (ADR-0020)
  commissionState: () => ipcRenderer.invoke("nmx:commission-state"),
  commissionMark: (axis) => ipcRenderer.invoke("nmx:commission-mark", axis),
  commissionSpan: (axis, measured, note) => ipcRenderer.invoke("nmx:commission-span", axis, measured, note),
  commissionDropSpan: (axis, index) => ipcRenderer.invoke("nmx:commission-drop-span", axis, index),
  commissionApply: () => ipcRenderer.invoke("nmx:commission-apply"),
  commissionPass: (readingMm) => ipcRenderer.invoke("nmx:commission-pass", readingMm),
  commissionSet: (patch) => ipcRenderer.invoke("nmx:commission-set", patch),
  bringUpReport: (extra) => ipcRenderer.invoke("nmx:bringup-report", extra),
  // e-stop
  stopAll: () => ipcRenderer.invoke("nmx:stop-all"),
});
