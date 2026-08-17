const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("nmx", {
  // connection
  listPorts: () => ipcRenderer.invoke("nmx:list-ports"),
  connect: (path) => ipcRenderer.invoke("nmx:connect", path),
  disconnect: () => ipcRenderer.invoke("nmx:disconnect"),
  overrideFirmwareGate: () => ipcRenderer.invoke("nmx:override-firmware-gate"),
  // jog
  enableMotors: () => ipcRenderer.invoke("nmx:enable-motors"),
  jog: (motor, stepsPerSec) => ipcRenderer.invoke("nmx:jog", motor, stepsPerSec),
  position: (motor) => ipcRenderer.invoke("nmx:position", motor),
  // classic 2-point engine
  setStartHere: () => ipcRenderer.invoke("nmx:set-start-here"),
  setStopHere: () => ipcRenderer.invoke("nmx:set-stop-here"),
  armMove: (travelMs, accelMs, decelMs) => ipcRenderer.invoke("nmx:arm-move", travelMs, accelMs, decelMs),
  gotoStart: () => ipcRenderer.invoke("nmx:goto-start"),
  run: () => ipcRenderer.invoke("nmx:run"),
  pause: () => ipcRenderer.invoke("nmx:pause"),
  progress: () => ipcRenderer.invoke("nmx:progress"),
  // key-frame engine + timeline
  previewMove: (axes, durationMs, sampleCount) => ipcRenderer.invoke("nmx:preview-move", axes, durationMs, sampleCount),
  uploadKf: (axes, durationMs) => ipcRenderer.invoke("nmx:upload-kf", axes, durationMs),
  kfRun: () => ipcRenderer.invoke("nmx:kf-run"),
  kfStop: () => ipcRenderer.invoke("nmx:kf-stop"),
  kfProgress: () => ipcRenderer.invoke("nmx:kf-progress"),
  gotoKfStart: (axes) => ipcRenderer.invoke("nmx:goto-kf-start", axes),
  // camera
  camArm: (cfg) => ipcRenderer.invoke("nmx:cam-arm", cfg),
  camFire: () => ipcRenderer.invoke("nmx:cam-fire"),
  camDisable: () => ipcRenderer.invoke("nmx:cam-disable"),
  // film save/load
  saveFilm: (film) => ipcRenderer.invoke("nmx:save-film", film),
  loadFilm: () => ipcRenderer.invoke("nmx:load-film"),
  // e-stop
  stopAll: () => ipcRenderer.invoke("nmx:stop-all"),
});
