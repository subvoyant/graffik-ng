const { contextBridge, ipcRenderer } = require("electron");

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
  armMove: (t, a, d) => ipcRenderer.invoke("nmx:arm-move", t, a, d),
  gotoStart: () => ipcRenderer.invoke("nmx:goto-start"),
  run: () => ipcRenderer.invoke("nmx:run"),
  pause: () => ipcRenderer.invoke("nmx:pause"),
  progress: () => ipcRenderer.invoke("nmx:progress"),
  // key-frame engine
  previewMove: (axes, dur, n) => ipcRenderer.invoke("nmx:preview-move", axes, dur, n),
  uploadKf: (axes, dur) => ipcRenderer.invoke("nmx:upload-kf", axes, dur),
  kfRun: () => ipcRenderer.invoke("nmx:kf-run"),
  kfStop: () => ipcRenderer.invoke("nmx:kf-stop"),
  kfProgress: () => ipcRenderer.invoke("nmx:kf-progress"),
  gotoKfStart: (axes) => ipcRenderer.invoke("nmx:goto-kf-start", axes),
  // camera
  camArm: (cfg) => ipcRenderer.invoke("nmx:cam-arm", cfg),
  camFire: () => ipcRenderer.invoke("nmx:cam-fire"),
  camDisable: () => ipcRenderer.invoke("nmx:cam-disable"),
  // films
  saveFilm: (film) => ipcRenderer.invoke("nmx:save-film", film),
  loadFilm: (path) => ipcRenderer.invoke("nmx:load-film", path),
  // e-stop
  stopAll: () => ipcRenderer.invoke("nmx:stop-all"),
});
