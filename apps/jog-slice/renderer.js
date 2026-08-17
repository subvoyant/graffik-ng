/* Graffik NG renderer — UI only; hardware via window.nmx (see ADR-0007). */
"use strict";

const $ = (id) => document.getElementById(id);
const status = (msg) => { $("status").textContent = msg; };
const AXES = [
  { name: "Slide", motor: 1, axis: 0, color: getComputedStyle(document.documentElement).getPropertyValue("--slide") },
  { name: "Pan", motor: 2, axis: 1, color: getComputedStyle(document.documentElement).getPropertyValue("--pan") },
  { name: "Tilt", motor: 3, axis: 2, color: getComputedStyle(document.documentElement).getPropertyValue("--tilt") },
];

let connected = false;
let fwSupported = false;
let passCount = 0, kfPassCount = 0;
let pollTimer = null;

/* ---------------- film model (mirrors core film.ts schema) ---------------- */

function defaultFilm(durationMs = 30000) {
  return {
    format: "graffik-ng-move",
    version: 1,
    name: "Untitled Move",
    durationMs,
    startDelayMs: 5000,
    engine: "keyframe",
    axes: AXES.map((a) => ({ axis: a.axis, points: [{ time: 0, position: 0 }, { time: durationMs, position: 0 }] })),
  };
}
let film = defaultFilm();
let playheadMs = 0;
let previewCache = null; // per-axis {samples:[{t,pos}]} from core solver
let uploaded = false;
let selection = null; // {track, k} — selected keyframe

/* ---------------- undo/redo (film snapshots) ---------------- */

const undoStack = [], redoStack = [];
const cloneFilm = (f) => JSON.parse(JSON.stringify(f));
function snapshot() {
  undoStack.push(cloneFilm(film));
  if (undoStack.length > 50) undoStack.shift();
  redoStack.length = 0;
}
function undo() {
  if (!undoStack.length) return;
  redoStack.push(cloneFilm(film));
  film = undoStack.pop();
  selection = null;
  updateInspector();
  syncHeaderInputs();
  refreshPreview();
}
function redo() {
  if (!redoStack.length) return;
  undoStack.push(cloneFilm(film));
  film = redoStack.pop();
  selection = null;
  updateInspector();
  syncHeaderInputs();
  refreshPreview();
}
function syncHeaderInputs() {
  $("moveName").value = film.name;
  $("tlDuration").value = String(Math.round(film.durationMs / 1000));
  $("tlCue").value = String(Math.round(film.startDelayMs / 1000));
}

/* ---------------- pass log ---------------- */

function logPass(text) {
  const div = document.createElement("div");
  div.textContent = `${new Date().toLocaleTimeString()} — ${text}`;
  $("passlog").prepend(div);
}

/* ---------------- connection ---------------- */

function setConnected(on) {
  connected = on;
  for (const id of ["enable", "gamepad", "markStart", "markStop", "arm", "gotoStart", "run",
    "capSlide", "capPan", "capTilt", "tlUpload", "tlGotoStart", "tlRun", "tlStop",
    "camArm", "camFire", "camOff"]) {
    $(id).disabled = !on;
  }
}

async function refreshPorts() {
  const ports = await window.nmx.listPorts();
  $("ports").innerHTML = ports.map((p) =>
    `<option value="${p.path}">${p.path}${p.manufacturer ? " — " + p.manufacturer : ""}</option>`).join("");
}

$("refresh").onclick = refreshPorts;

$("connect").onclick = async () => {
  try {
    if (connected) {
      stopGamepad();
      await window.nmx.disconnect();
      setConnected(false);
      $("connect").textContent = "Connect";
      $("fwbadge").textContent = "";
      $("fwOverride").style.display = "none";
      return;
    }
    const info = await window.nmx.connect($("ports").value);
    setConnected(true);
    fwSupported = info.supported;
    $("connect").textContent = "Disconnect";
    $("fwbadge").textContent = `firmware v${info.firmwareVersion}` + (info.supported ? "" : " — UNSUPPORTED");
    $("fwbadge").className = info.supported ? "" : "bad";
    $("fwOverride").style.display = info.supported ? "none" : "";
    status(info.supported
      ? "Connected. Graffik mode on, joystick watchdog armed."
      : `Connected, but firmware v${info.firmwareVersion} differs from the verified v70 — programmed moves are blocked. Update the NMX firmware (recommended), or override at your own risk.`);
  } catch (err) { status("Connect failed: " + err.message); }
};

$("fwOverride").onclick = async () => {
  await window.nmx.overrideFirmwareGate();
  status("Firmware gate overridden — command numbers may not match this firmware. Verify every move at low speed first.");
};

/* ---------------- jog ---------------- */

function buildAxisRows() {
  $("axes").innerHTML = AXES.map((a) => `
    <div class="axisrow">
      <span class="axisname" style="color:${a.color}">${a.name}</span>
      <button class="jogbtn" data-m="${a.motor}" data-dir="-1">−</button>
      <div></div>
      <button class="jogbtn" data-m="${a.motor}" data-dir="1">+</button>
      <span class="pos" id="pos${a.motor}">—</span>
    </div>`).join("");
  for (const btn of document.querySelectorAll(".jogbtn")) {
    const m = Number(btn.dataset.m), dir = Number(btn.dataset.dir);
    const start = async (e) => { e.preventDefault(); if (!connected) return;
      await window.nmx.jog(m, dir * Number($("speed").value)); };
    const stop = async () => { if (!connected) return;
      await window.nmx.jog(m, 0);
      $("pos" + m).textContent = String(await window.nmx.position(m)); };
    btn.addEventListener("pointerdown", start);
    btn.addEventListener("pointerup", stop);
    btn.addEventListener("pointerleave", stop);
  }
}

$("enable").onclick = async () => { await window.nmx.enableMotors(); status("Motors enabled."); };

/* ---------------- gamepad jog (Slice E) ---------------- */

let gamepadTimer = null;
const lastSent = [0, 0, 0];

function stopGamepad() {
  if (gamepadTimer) { clearInterval(gamepadTimer); gamepadTimer = null; }
  $("gamepad").textContent = "🎮 Gamepad: off";
  $("gamepad").classList.remove("active");
  if (connected) for (const a of AXES) window.nmx.jog(a.motor, 0);
  lastSent.fill(0);
}

$("gamepad").onclick = () => {
  if (gamepadTimer) { stopGamepad(); return; }
  $("gamepad").textContent = "🎮 Gamepad: ON";
  $("gamepad").classList.add("active");
  status("Gamepad jog active: left stick X = slide, right stick X = pan, right stick Y = tilt.");
  let beat = 0;
  gamepadTimer = setInterval(() => {
    const pad = navigator.getGamepads().find((g) => g);
    if (!pad || !connected) return;
    $("gamepadName").textContent = pad.id.slice(0, 40);
    const DEAD = 0.15, max = Number($("speed").value);
    const sticks = [pad.axes[0] ?? 0, pad.axes[2] ?? 0, -(pad.axes[3] ?? 0)]; // slide, pan, tilt(inverted)
    beat = (beat + 1) % 4; // heartbeat: resend every ~264ms even if unchanged (watchdog food)
    sticks.forEach((v, i) => {
      const mag = Math.abs(v) < DEAD ? 0 : Math.sign(v) * ((Math.abs(v) - DEAD) / (1 - DEAD)) ** 2;
      const speed = Math.round(mag * max);
      if (speed !== lastSent[i] || (beat === 0 && speed !== 0)) {
        lastSent[i] = speed;
        window.nmx.jog(AXES[i].motor, speed);
      }
    });
  }, 66);
};

window.addEventListener("gamepadconnected", (e) => { $("gamepadName").textContent = e.gamepad.id.slice(0, 40); });

/* ---------------- countdown (host-side cue, uniform across engines) ---------------- */

function countdown(seconds) {
  return new Promise((resolve) => {
    if (seconds <= 0) return resolve();
    const el = $("countdown");
    let n = seconds;
    el.style.display = "flex";
    el.textContent = n;
    const t = setInterval(() => {
      n -= 1;
      if (n <= 0) { clearInterval(t); el.style.display = "none"; resolve(); }
      else el.textContent = n;
    }, 1000);
  });
}

/* ---------------- timeline editor (Slice B) ---------------- */

const canvas = $("timeline");
const ctx = canvas.getContext("2d");
const RULER = 22, PAD_L = 46, PAD_R = 10;

// All layout math in CSS pixels (clientWidth/Height); DPR only scales the backing store.
function trackRect(i) {
  const h = (canvas.clientHeight - RULER) / 3;
  return { x: PAD_L, y: RULER + i * h + 5, w: canvas.clientWidth - PAD_L - PAD_R, h: h - 10 };
}
const tToX = (t, r) => r.x + (t / film.durationMs) * r.w;
const xToT = (x, r) => Math.max(0, Math.min(film.durationMs, ((x - r.x) / r.w) * film.durationMs));

function axisScale(i) {
  const pts = film.axes[i].points;
  const samples = previewCache?.[i]?.samples ?? [];
  const vals = [...pts.map((p) => p.position), ...samples.map((s) => s.pos)];
  let min = Math.min(...vals), max = Math.max(...vals);
  if (max - min < 100) { const mid = (min + max) / 2; min = mid - 50; max = mid + 50; }
  const pad = (max - min) * 0.12;
  return { min: min - pad, max: max + pad };
}
const posToY = (pos, r, s) => r.y + r.h - ((pos - s.min) / (s.max - s.min)) * r.h;
const yToPos = (y, r, s) => s.min + ((r.y + r.h - y) / r.h) * (s.max - s.min);

function render() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== w * devicePixelRatio) { canvas.width = w * devicePixelRatio; canvas.height = h * devicePixelRatio; }
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  Object.assign(canvas, {}); // noop
  ctx.clearRect(0, 0, w, h);
  const W = { width: w, height: h };
  // ruler
  ctx.fillStyle = "#0f1216"; ctx.fillRect(0, 0, w, RULER);
  ctx.fillStyle = "#9aa3ad"; ctx.font = "10px system-ui"; ctx.textBaseline = "top";
  const secs = film.durationMs / 1000;
  const step = secs > 120 ? 30 : secs > 45 ? 10 : 5;
  const rTop = { x: PAD_L, y: 0, w: w - PAD_L - PAD_R, h: RULER };
  for (let s = 0; s <= secs; s += step) {
    const x = tToX(s * 1000, rTop);
    ctx.fillRect(x, RULER - 6, 1, 6);
    ctx.fillText(`${s}s`, x + 2, 4);
  }
  // tracks
  AXES.forEach((a, i) => {
    const r = trackRect(i);
    const s = axisScale(i);
    ctx.strokeStyle = "#2a2e35"; ctx.strokeRect(r.x, r.y, r.w, r.h);
    ctx.fillStyle = "#9aa3ad"; ctx.save(); ctx.translate(14, r.y + r.h / 2); ctx.rotate(-Math.PI / 2);
    ctx.textAlign = "center"; ctx.fillText(a.name, 0, 0); ctx.restore(); ctx.textAlign = "left";
    // curve from the core solver (what the firmware will actually run — ADR-0009)
    const samples = previewCache?.[i]?.samples;
    if (samples) {
      ctx.strokeStyle = a.color; ctx.lineWidth = 1.6; ctx.beginPath();
      samples.forEach((pt, j) => {
        const x = tToX(pt.t, r), y = posToY(pt.pos, r, s);
        j === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.stroke(); ctx.lineWidth = 1;
    }
    // keyframes
    film.axes[i].points.forEach((p, k) => {
      const x = tToX(p.time, r), y = posToY(p.position, r, s);
      const isSel = selection && selection.track === i && selection.k === k;
      ctx.fillStyle = a.color; ctx.beginPath(); ctx.arc(x, y, isSel ? 6 : 5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = isSel ? "#ffffff" : "#14161a"; ctx.lineWidth = isSel ? 2 : 1; ctx.stroke(); ctx.lineWidth = 1;
    });
  });
  // playhead
  const px = tToX(playheadMs, rTop);
  ctx.strokeStyle = "#e6e8eb"; ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(px, RULER); ctx.lineTo(px, h); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = "#e6e8eb"; ctx.beginPath();
  ctx.moveTo(px - 5, RULER - 8); ctx.lineTo(px + 5, RULER - 8); ctx.lineTo(px, RULER); ctx.fill();
  void W;
}

let previewTimer = null;
function refreshPreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    try {
      previewCache = await window.nmx.previewMove(
        film.axes.map((a) => ({ axis: a.axis, points: a.points })), film.durationMs, 140);
    } catch (err) { previewCache = null; status("Curve solve failed: " + err.message); }
    uploaded = false;
    render();
  }, 60);
}

/* canvas interaction: drag playhead / drag keyframes / dblclick delete */
let drag = null;
function hitTest(mx, my) {
  for (let i = 0; i < 3; i++) {
    const r = trackRect(i);
    const s = axisScale(i);
    const pts = film.axes[i].points;
    for (let k = 0; k < pts.length; k++) {
      const x = tToX(pts[k].time, r), y = posToY(pts[k].position, r, s);
      if ((mx - x) ** 2 + (my - y) ** 2 < 81) return { track: i, k, r, s };
    }
  }
  return null;
}
canvas.addEventListener("pointerdown", (e) => {
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  canvas.setPointerCapture(e.pointerId);
  if (my <= RULER) { drag = { type: "playhead" }; movePlayhead(mx); return; }
  const hit = hitTest(mx, my);
  if (hit) {
    snapshot(); // one undo step per drag/selection interaction
    selection = { track: hit.track, k: hit.k };
    drag = { type: "kf", ...hit };
  } else {
    selection = null;
  }
  updateInspector();
  render();
});
canvas.addEventListener("pointermove", (e) => {
  if (!drag) return;
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  if (drag.type === "playhead") { movePlayhead(mx); return; }
  const { track, k, r, s } = drag;
  const pts = film.axes[track].points;
  pts[k].position = Math.round(yToPos(my, r, s));
  const isEndpoint = k === 0 || k === pts.length - 1;
  if (!isEndpoint) {
    const lo = pts[k - 1].time + 100, hi = pts[k + 1].time - 100;
    pts[k].time = Math.round(Math.max(lo, Math.min(hi, xToT(mx, r))));
  }
  refreshPreview();
});
canvas.addEventListener("pointerup", () => { drag = null; });
canvas.addEventListener("dblclick", (e) => {
  const rect = canvas.getBoundingClientRect();
  const hit = hitTest(e.clientX - rect.left, e.clientY - rect.top);
  if (!hit) return;
  deleteKeyframe(hit.track, hit.k);
});

function deleteKeyframe(track, k) {
  const pts = film.axes[track].points;
  if (k === 0 || k === pts.length - 1 || pts.length <= 2) return; // endpoints stay
  snapshot();
  pts.splice(k, 1);
  selection = null;
  updateInspector();
  refreshPreview();
}

/* selected-keyframe inspector */
function updateInspector() {
  const box = $("kfInspector");
  if (!selection) { box.style.display = "none"; return; }
  const p = film.axes[selection.track].points[selection.k];
  if (!p) { selection = null; box.style.display = "none"; return; }
  box.style.display = "";
  $("kfLabel").textContent = `${AXES[selection.track].name} #${selection.k + 1}`;
  $("kfTime").value = (p.time / 1000).toFixed(1);
  $("kfPos").value = String(Math.round(p.position));
  const isEndpoint = selection.k === 0 || selection.k === film.axes[selection.track].points.length - 1;
  $("kfTime").disabled = isEndpoint;
  $("kfDelete").disabled = isEndpoint;
}
$("kfTime").onchange = () => {
  if (!selection) return;
  const pts = film.axes[selection.track].points;
  const k = selection.k;
  if (k === 0 || k === pts.length - 1) return;
  snapshot();
  const lo = pts[k - 1].time + 100, hi = pts[k + 1].time - 100;
  pts[k].time = Math.round(Math.max(lo, Math.min(hi, Number($("kfTime").value) * 1000)));
  updateInspector();
  refreshPreview();
};
$("kfPos").onchange = () => {
  if (!selection) return;
  snapshot();
  film.axes[selection.track].points[selection.k].position = Math.round(Number($("kfPos").value));
  refreshPreview();
};
$("kfDelete").onclick = () => { if (selection) deleteKeyframe(selection.track, selection.k); };

/* keyboard: nudge selection, undo/redo */
window.addEventListener("keydown", (e) => {
  const tag = document.activeElement?.tagName;
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
  const meta = e.metaKey || e.ctrlKey;
  if (meta && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (!selection) return;
  const pts = film.axes[selection.track].points;
  const p = pts[selection.k];
  if (!p) return;
  const isEndpoint = selection.k === 0 || selection.k === pts.length - 1;
  const posStep = e.shiftKey ? 100 : 10;
  if (e.key === "ArrowUp" || e.key === "ArrowDown") {
    e.preventDefault(); snapshot();
    p.position += (e.key === "ArrowUp" ? posStep : -posStep);
  } else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && e.altKey && !isEndpoint) {
    e.preventDefault(); snapshot();
    const lo = pts[selection.k - 1].time + 100, hi = pts[selection.k + 1].time - 100;
    p.time = Math.max(lo, Math.min(hi, p.time + (e.key === "ArrowRight" ? 100 : -100)));
  } else if (e.key === "Backspace" || e.key === "Delete") {
    e.preventDefault(); deleteKeyframe(selection.track, selection.k); return;
  } else return;
  updateInspector();
  refreshPreview();
});
function movePlayhead(mx) {
  const rTop = { x: PAD_L, y: 0, w: canvas.clientWidth - PAD_L - PAD_R, h: RULER };
  playheadMs = Math.round(xToT(mx, rTop));
  render();
}

/* capture-from-rig: the Dragonframe/eMotimo jog-to-keyframe idiom */
async function capture(trackIdx) {
  const a = AXES[trackIdx];
  const pos = await window.nmx.position(a.motor);
  snapshot();
  const pts = film.axes[trackIdx].points;
  const near = pts.findIndex((p) => Math.abs(p.time - playheadMs) < 250);
  if (near >= 0) pts[near].position = pos;
  else {
    pts.push({ time: playheadMs, position: pos });
    pts.sort((x, y) => x.time - y.time);
  }
  status(`${a.name}: keyframe @ ${(playheadMs / 1000).toFixed(1)}s = ${pos} steps`);
  refreshPreview();
}
$("capSlide").onclick = () => capture(0);
$("capPan").onclick = () => capture(1);
$("capTilt").onclick = () => capture(2);

/* duration / name / cue inputs */
$("tlDuration").onchange = () => {
  snapshot();
  const ms = Math.max(2000, Number($("tlDuration").value) * 1000);
  const scale = ms / film.durationMs;
  for (const ax of film.axes) for (const p of ax.points) p.time = Math.round(p.time * scale);
  film.durationMs = ms;
  playheadMs = Math.min(playheadMs, ms);
  refreshPreview();
};
$("tlCue").onchange = () => { film.startDelayMs = Number($("tlCue").value) * 1000; };
$("moveName").onchange = () => { film.name = $("moveName").value; };

/* new / save / load */
function adoptFilm(f) {
  film = f;
  undoStack.length = 0;
  redoStack.length = 0;
  selection = null;
  updateInspector();
  syncHeaderInputs();
  playheadMs = 0;
  refreshPreview();
}
$("tlNew").onclick = () => adoptFilm(defaultFilm(Number($("tlDuration").value) * 1000));
$("tlSave").onclick = async () => {
  try {
    const path = await window.nmx.saveFilm(film);
    if (path) { logPass(`saved "${film.name}" → ${path}`); status(`Saved: ${path}`); }
  } catch (err) { status("Save failed: " + err.message); }
};
$("tlLoad").onclick = async () => {
  try {
    const f = await window.nmx.loadFilm();
    if (f) { adoptFilm(f); status(`Loaded "${f.name}".`); }
  } catch (err) { status("Load failed: " + err.message); }
};

/* KF upload / run / stop */
$("tlUpload").onclick = async () => {
  try {
    const n = await window.nmx.uploadKf(film.axes.map((a) => ({ axis: a.axis, points: a.points })), film.durationMs);
    uploaded = true;
    status(`Move uploaded to controller (${n} packets). Ready to run.`);
  } catch (err) { status("Upload blocked: " + err.message); }
};
$("tlGotoStart").onclick = async () => {
  await window.nmx.gotoKfStart(film.axes.map((a) => ({ axis: a.axis, points: a.points })));
  status("Sending all axes to first keyframes…");
};
$("tlRun").onclick = async () => {
  try {
    if (!uploaded) { status("Upload the move first (⬆) — edits since last upload aren't on the controller."); return; }
    kfPassCount += 1;
    $("tlPassCounter").textContent = `pass ${kfPassCount}`;
    await countdown(Math.round(film.startDelayMs / 1000));
    await window.nmx.kfRun();
    logPass(`KF pass ${kfPassCount} started — "${film.name}" (${(film.durationMs / 1000).toFixed(0)}s)`);
    clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
      try {
        const p = await window.nmx.kfProgress();
        $("tlProg").value = p.percent ?? 0;
        if (p.state === 0 && (p.percent ?? 0) > 0) {
          clearInterval(pollTimer);
          logPass(`KF pass ${kfPassCount} complete`);
          status(`Pass ${kfPassCount} complete. "All to start", reposition performer, run again.`);
        }
      } catch { clearInterval(pollTimer); }
    }, 500);
  } catch (err) { status("Run blocked: " + err.message); }
};
$("tlStop").onclick = async () => { clearInterval(pollTimer); await window.nmx.kfStop(); status("KF program stopped."); };

/* ---------------- classic 2-point pass ---------------- */

$("markStart").onclick = async () => { await window.nmx.setStartHere(); status("START marked at current positions (all axes)."); };
$("markStop").onclick = async () => { await window.nmx.setStopHere(); status("END marked at current positions (all axes)."); };
$("arm").onclick = async () => {
  try {
    const travelMs = Number($("travel").value) * 1000;
    const accel = Math.min(2000, travelMs / 4);
    await window.nmx.armMove(travelMs, accel, accel);
    status(`Armed: ${$("travel").value}s continuous move, quadratic ease. Cue is taken from the Timeline "Cue" field.`);
  } catch (err) { status("Arm blocked: " + err.message); }
};
$("gotoStart").onclick = async () => { await window.nmx.gotoStart(); status("Sending all axes to start marks…"); };
$("run").onclick = async () => {
  try {
    passCount += 1;
    $("passCounter").textContent = `pass ${passCount}`;
    await countdown(Number($("tlCue").value));
    await window.nmx.run();
    logPass(`classic pass ${passCount} started`);
    clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
      try {
        const p = await window.nmx.progress();
        $("prog").value = p.percent ?? 0;
        if (!p.running && (p.percent ?? 0) > 0) {
          clearInterval(pollTimer);
          logPass(`classic pass ${passCount} complete`);
          status(`Pass ${passCount} complete.`);
        }
      } catch { clearInterval(pollTimer); }
    }, 500);
  } catch (err) { status("Run blocked: " + err.message); }
};

/* ---------------- camera ---------------- */

$("camArm").onclick = async () => {
  try {
    await window.nmx.camArm({
      triggerMs: Number($("camTrigger").value),
      focusMs: Number($("camFocus").value),
      delayMs: Number($("camDelay").value),
      maxShots: 0,
      intervalMs: 0,
    });
    $("camStatus").textContent = "armed";
    status("Camera armed on NMX output.");
  } catch (err) { status("Camera arm failed: " + err.message); }
};
$("camFire").onclick = async () => {
  try {
    await window.nmx.camFire();
    $("camStatus").textContent = "fired ✓";
    status("Test exposure fired.");
  } catch (err) { status("Test fire failed: " + err.message); }
};
$("camOff").onclick = async () => {
  await window.nmx.camDisable();
  $("camStatus").textContent = "";
  status("Camera control disabled.");
};

/* ---------------- e-stop ---------------- */

$("estop").onclick = async () => {
  clearInterval(pollTimer);
  $("countdown").style.display = "none";
  stopGamepad();
  try { await window.nmx.stopAll(); status("STOP ALL sent (program + key-frame broadcast stop)."); }
  catch (err) { status("STOP ALL error: " + err.message); }
};

/* ---------------- init ---------------- */

buildAxisRows();
refreshPorts();
adoptFilm(film);
window.addEventListener("resize", render);
