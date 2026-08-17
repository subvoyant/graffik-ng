/* Graffik NG renderer — UI only; hardware via window.nmx (ADR-0007).
   Runs in Electron, and also standalone in a browser (preview stub below). */
"use strict";

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------------
   Browser-preview stub: opening index.html directly in a browser (no
   Electron) installs a fake device so the UI can be designed/reviewed
   without hardware or a build. Never active under Electron.
   ------------------------------------------------------------------ */
if (!window.tc) {
  /* Minimal timecode bridge for the browser preview ONLY. Non-drop, integer
     rates — enough to lay out and screenshot the UI. Under Electron the real,
     tested core implementation is bridged in by preload (ADR-0014), and this
     block is unreachable. Never extend it into a second implementation. */
  const nominal = (tb) => Math.round(tb.num / tb.den);
  const pad2 = (n) => String(n).padStart(2, "0");
  window.tc = {
    __preview: true,
    TIMEBASES: [
      { id: "23.976", label: "23.976", tb: { num: 24000, den: 1001, dropFrame: false } },
      { id: "24", label: "24", tb: { num: 24, den: 1, dropFrame: false } },
      { id: "25", label: "25", tb: { num: 25, den: 1, dropFrame: false } },
      { id: "29.97ndf", label: "29.97 NDF", tb: { num: 30000, den: 1001, dropFrame: false } },
      { id: "29.97df", label: "29.97 DF", tb: { num: 30000, den: 1001, dropFrame: true } },
      { id: "30", label: "30", tb: { num: 30, den: 1, dropFrame: false } },
      { id: "48", label: "48", tb: { num: 48, den: 1, dropFrame: false } },
      { id: "50", label: "50", tb: { num: 50, den: 1, dropFrame: false } },
      { id: "60", label: "60", tb: { num: 60, den: 1, dropFrame: false } },
    ],
    DEFAULT_TIMEBASE: { num: 24, den: 1, dropFrame: false },
    timebaseById(id) { return this.TIMEBASES.find((t) => t.id === id)?.tb; },
    timebaseId(tb) { return this.TIMEBASES.find((t) => t.tb.num === tb.num && t.tb.den === tb.den && t.tb.dropFrame === tb.dropFrame)?.id ?? ""; },
    timebaseLabel(tb) { return this.TIMEBASES.find((t) => t.tb.num === tb.num && t.tb.den === tb.den && t.tb.dropFrame === tb.dropFrame)?.label ?? String(tb.num / tb.den); },
    nominalRate: nominal,
    fpsDecimal: (tb) => tb.num / tb.den,
    framesToTimecode(f, tb) {
      const r = nominal(tb), n = Math.abs(Math.round(f)), sep = tb.dropFrame ? ";" : ":";
      const ff = n % r, ts = Math.floor(n / r);
      return `${f < 0 ? "-" : ""}${pad2(Math.floor(ts / 3600))}:${pad2(Math.floor(ts / 60) % 60)}:${pad2(ts % 60)}${sep}${pad2(ff)}`;
    },
    timecodeToFrames(str, tb) {
      const parts = String(str).trim().split(/[:;]/).map(Number);
      while (parts.length < 4) parts.unshift(0);
      const r = nominal(tb);
      return parts[0] * 3600 * r + parts[1] * 60 * r + parts[2] * r + parts[3];
    },
    framesToMsExact: (f, tb) => (f * 1000 * tb.den) / tb.num,
    framesToMs(f, tb) { return Math.round(this.framesToMsExact(f, tb)); },
    msToFramesExact: (ms, tb) => (ms * tb.num) / (1000 * tb.den),
    msToFrames(ms, tb) { return Math.round(this.msToFramesExact(ms, tb)); },
    formatDuration(f, tb) { return `${f}f \u00b7 ${this.framesToTimecode(f, tb)}`; },
    retimeFrames(f, from, to) { return Math.round(this.msToFramesExact(this.framesToMsExact(f, from), to)); },
  };
}

if (!window.nmx) {
  const pos = [0, 0, 0], speeds = [0, 0, 0];
  setInterval(() => { for (let i = 0; i < 3; i++) pos[i] = Math.round(pos[i] + speeds[i] * 0.05); }, 50);
  let pct = 0;
  window.nmx = {
    __preview: true,
    listPorts: async () => [{ path: "simulator://nmx", manufacturer: "browser preview — no hardware" }],
    connect: async () => ({ firmwareVersion: 70, supported: true }),
    disconnect: async () => {}, overrideFirmwareGate: async () => {},
    enableMotors: async () => {},
    jog: async (m, s) => { speeds[m - 1] = s; },
    position: async (m) => pos[m - 1],
    setStartHere: async () => {}, setStopHere: async () => {}, armMove: async () => {},
    gotoStart: async () => {}, run: async () => { pct = 0; }, pause: async () => {},
    progress: async () => ({ percent: (pct = Math.min(100, pct + 20)), running: pct < 100 }),
    previewMove: async (f, n = 140) => f.axes.map(({ axis, points }) => {
      const s = [];
      for (let i = 0; i <= n; i++) {
        const fr = (f.durationFrames * i) / n;
        let seg = 0;
        for (let k = 0; k < points.length - 1; k++) if (fr >= points[k].frame) seg = k;
        const a = points[seg], b = points[seg + 1] ?? a;
        const u = b.frame === a.frame ? 0 : (fr - a.frame) / (b.frame - a.frame);
        const e = u * u * (3 - 2 * u);
        s.push({ frame: fr, pos: a.position + (b.position - a.position) * e });
      }
      return { axis, samples: s };
    }),
    uploadKf: async (f) => f.axes.length * 8,
    cueMs: async (f) => Math.round((f.cueFrames * 1000 * f.timebase.den) / f.timebase.num), kfRun: async () => { pct = 0; }, kfStop: async () => {},
    kfProgress: async () => ({ state: pct < 100 ? 1 : 0, percent: (pct = Math.min(100, pct + 20)) }),
    gotoKfStart: async () => {},
    camArm: async () => {}, camFire: async () => {}, camDisable: async () => {},
    saveFilm: async () => null, loadFilm: async () => null, stopAll: async () => { speeds.fill(0); },
    exportFormats: async () => [
      { id: "usda", label: "OpenUSD (.usda)", ext: "usda", note: "Cinema 4D, Blender, Houdini, Maya, Unreal. Carries its own units and up-axis." },
      { id: "abc", label: "Alembic + FBX (via Blender)", ext: "usda", note: "Writes the .usda plus a Blender script that converts it." },
      { id: "ae", label: "After Effects keyframe data (.txt)", ext: "txt", note: "Paste onto a camera layer. AE has no real-world units." },
      { id: "nk", label: "Nuke camera (.nk)", ext: "nk", note: "Paste into a Nuke script. Carries its own rotation order." },
      { id: "chan", label: "Channel file (.chan)", ext: "chan", note: "Nuke, 3DEqualizer, Syntheyes, Blender. No metadata at all." },
      { id: "csv", label: "Data table (.csv)", ext: "csv", note: "One row per frame in steps, mm, degrees and scene units." },
    ],
    exportMove: async () => null,
    moveExtents: async (f, cal) => {
      const c = { slideStepsPerMm: 100, panStepsPerDeg: 100, tiltStepsPerDeg: 100, ...cal };
      const span = (i, per) => {
        const v = f.axes[i].points.map((p) => p.position / per);
        return { min: Math.min(...v), max: Math.max(...v), range: Math.max(...v) - Math.min(...v) };
      };
      return { slideMm: span(0, c.slideStepsPerMm), panDeg: span(1, c.panStepsPerDeg), tiltDeg: span(2, c.tiltStepsPerDeg) };
    },
    getPrefs: async () => ({ jogSpeed: 800, limits: [{min:null,max:null},{min:null,max:null},{min:null,max:null}],
      gamepad: { bindings: { slide:{axisIndex:0,invert:false}, pan:{axisIndex:2,invert:false}, tilt:{axisIndex:3,invert:true} },
                 deadzone: 0.15, curve: 2, maxSpeedPct: 100 }, recent: [] }),
    setPrefs: async (p) => p,
    getLimits: async () => [{min:null,max:null},{min:null,max:null},{min:null,max:null}],
    setLimitHere: async () => [{min:null,max:null},{min:null,max:null},{min:null,max:null}],
    clearLimits: async () => [{min:null,max:null},{min:null,max:null},{min:null,max:null}],
    onLimitHit: () => {},
  };
}

/* ------------------------------------------------------------------ */

const css = getComputedStyle(document.documentElement);
const AXES = [
  { name: "Slide", motor: 1, axis: 0, color: css.getPropertyValue("--slide").trim() },
  { name: "Pan",   motor: 2, axis: 1, color: css.getPropertyValue("--pan").trim() },
  { name: "Tilt",  motor: 3, axis: 2, color: css.getPropertyValue("--tilt").trim() },
];
const INK_FAINT = css.getPropertyValue("--ink-faint").trim();
const LINE = css.getPropertyValue("--line").trim();
const INK = css.getPropertyValue("--ink").trim();

let connected = false, passCount = 0, kfPassCount = 0, pollTimer = null;

const status = (m) => { $("status").textContent = m; };
function logPass(t) {
  const d = document.createElement("div");
  d.innerHTML = `<b>${new Date().toLocaleTimeString()}</b> ${t}`;
  $("passlog").prepend(d);
}

/* ---------------- drag-scrub numeric fields (3D-app idiom) ----------------
   Click to type, drag horizontally to scrub. Shift = fine (×0.1),
   Cmd/Ctrl = coarse (×10). This is the single interaction that makes an
   app feel native to Blender/C4D/Houdini users.                          */
function makeScrubbable(input) {
  let startX = 0, startVal = 0, active = false, moved = false;
  input.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    startX = e.clientX;
    startVal = Number(input.value) || 0;
    active = true; moved = false;
  });
  window.addEventListener("pointermove", (e) => {
    if (!active) return;
    const dx = e.clientX - startX;
    if (!moved && Math.abs(dx) < 3) return;
    if (!moved) { moved = true; input.classList.add("scrubbing"); input.blur(); }
    e.preventDefault();
    const step = Number(input.step) || 1;
    const mult = e.shiftKey ? 0.1 : (e.metaKey || e.ctrlKey) ? 10 : 1;
    let v = startVal + dx * step * mult;
    if (input.min !== "") v = Math.max(Number(input.min), v);
    if (input.max !== "") v = Math.min(Number(input.max), v);
    v = step < 1 ? Math.round(v * 10) / 10 : Math.round(v / step) * step;
    if (String(v) !== input.value) { input.value = v; input.dispatchEvent(new Event("input", { bubbles: true })); }
  });
  window.addEventListener("pointerup", () => {
    if (!active) return;
    if (moved) { input.classList.remove("scrubbing"); input.dispatchEvent(new Event("change", { bubbles: true })); }
    active = false;
  });
}
document.querySelectorAll("input.num").forEach(makeScrubbable);

/* ---------------- film model (frames — ADR-0014) ----------------
   Every time value in this file is a FRAME NUMBER. Milliseconds appear
   only in main.js, at the protocol boundary. If you find yourself writing
   `* 1000` here, you are about to introduce the bug this rule prevents. */
const TC = window.tc;
function defaultFilm(durationFrames, tb = film?.timebase ?? TC.DEFAULT_TIMEBASE) {
  const dur = durationFrames ?? Math.round(TC.fpsDecimal(tb) * 10);
  return {
    format: "graffik-ng-move", version: 2, name: "Untitled Move",
    timebase: { ...tb },
    durationFrames: dur,
    cueFrames: Math.round(TC.fpsDecimal(tb) * 5),
    startFrame: 0,
    engine: "keyframe",
    axes: AXES.map((a) => ({ axis: a.axis, points: [{ frame: 0, position: 0 }, { frame: dur, position: 0 }] })),
  };
}
let film = defaultFilm(undefined, TC.DEFAULT_TIMEBASE);
let playheadFrame = 0, previewCache = null, uploaded = false, selection = null;
/** Path of the move on disk, or null if it has never been saved. Save writes
    here without a dialog; Save As always asks. */
let filePath = null, dirty = false;
let view = { f0: 0, f1: film.durationFrames };   // visible frame window (zoom/pan)

/** Timecode of a frame within the move, honouring the move's start timecode. */
const tcOf = (frame) => TC.framesToTimecode(film.startFrame + Math.round(frame), film.timebase);
/** Smallest meaningful keyframe gap: one frame. */
const MIN_GAP = 1;

/* ---------------- undo/redo ---------------- */
const undoStack = [], redoStack = [];
const clone = (f) => JSON.parse(JSON.stringify(f));
function snapshot() {
  undoStack.push(clone(film)); if (undoStack.length > 60) undoStack.shift(); redoStack.length = 0;
  markDirty();
}
function undo() { if (!undoStack.length) return; redoStack.push(clone(film)); film = undoStack.pop(); afterFilmChange(); }
function redo() { if (!redoStack.length) return; undoStack.push(clone(film)); film = redoStack.pop(); afterFilmChange(); }
function afterFilmChange() { selection = null; updateInspector(); syncInputs(); refreshPreview(); }
function syncInputs() {
  $("moveName").value = film.name;
  $("tlDuration").value = String(film.durationFrames);
  $("tlCue").value = String(film.cueFrames);
  $("tlStartTc").value = TC.framesToTimecode(film.startFrame, film.timebase);
  $("tlTimebase").value = TC.timebaseId(film.timebase);
  $("tlDurationTc").textContent = TC.framesToTimecode(film.durationFrames, film.timebase);
  $("tlCueTc").textContent = TC.framesToTimecode(film.cueFrames, film.timebase);
  $("rateChip").textContent = TC.timebaseLabel(film.timebase) + " fps";
  updateFileLabel();
  $("tbSummary").textContent =
    `${TC.timebaseLabel(film.timebase)} fps · ${film.durationFrames} frames · ` +
    `${(TC.framesToMsExact(film.durationFrames, film.timebase) / 1000).toFixed(3)} s`;
}

/* ---------------- connection ---------------- */
function setConnected(on) {
  connected = on;
  for (const id of ["enable","gamepad","markStart","markStop","arm","gotoStart","run",
    "capSlide","capPan","capTilt","tlUpload","tlGotoStart","tlRun","tlStop","camArm","camFire","camOff"]) {
    $(id).disabled = !on;
  }
  $("connDot").className = "dot" + (on ? " on" : "");
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
      stopGamepad(); await window.nmx.disconnect(); setConnected(false);
      $("connect").textContent = "Connect"; $("fwchip").style.display = "none";
      $("fwOverride").style.display = "none"; status("Disconnected."); return;
    }
    const info = await window.nmx.connect($("ports").value);
    setConnected(true);
    $("connect").textContent = "Disconnect";
    const chip = $("fwchip");
    chip.style.display = ""; chip.textContent = "fw v" + info.firmwareVersion;
    chip.className = "chip" + (info.supported ? "" : " bad");
    $("fwOverride").style.display = info.supported ? "none" : "";
    $("connDot").className = "dot " + (info.supported ? "on" : "bad");
    status(info.supported
      ? "Connected · Graffik mode on · joystick watchdog armed."
      : `Firmware v${info.firmwareVersion} ≠ verified v70 — programmed moves blocked. Update the NMX, or override at your own risk.`);
  } catch (e) { status("Connect failed: " + e.message); }
};
$("fwOverride").onclick = async () => {
  await window.nmx.overrideFirmwareGate();
  status("Firmware gate overridden — verify every move at low speed first.");
};

/* ---------------- jog ---------------- */
function buildAxes() {
  $("axes").innerHTML = AXES.map((a) => `
    <div class="axis">
      <span class="swatch" style="background:${a.color}"></span>
      <span class="nm">${a.name}</span>
      <button class="jogbtn" data-m="${a.motor}" data-d="-1">−</button>
      <button class="jogbtn" data-m="${a.motor}" data-d="1">+</button>
      <span class="pos" id="pos${a.motor}">—</span>
    </div>`).join("");
  for (const b of document.querySelectorAll(".jogbtn")) {
    const m = +b.dataset.m, d = +b.dataset.d;
    const go = async (e) => {
      e.preventDefault(); if (!connected) return;
      const r = await window.nmx.jog(m, d * Number($("speed").value));
      if (r?.blocked) status(`⚠ ${AXES[m - 1].name} is at its soft limit — jog the other way, or clear the limit.`);
    };
    const stop = async () => {
      if (!connected) return;
      await window.nmx.jog(m, 0);
      $("pos" + m).textContent = String(await window.nmx.position(m));
    };
    b.addEventListener("pointerdown", go);
    b.addEventListener("pointerup", stop);
    b.addEventListener("pointerleave", stop);
  }
}
$("enable").onclick = async () => { await window.nmx.enableMotors(); status("Motors enabled."); };

/* live position readout */
setInterval(async () => {
  if (!connected) return;
  for (const a of AXES) {
    try { $("pos" + a.motor).textContent = String(await window.nmx.position(a.motor)); } catch { /* transient */ }
  }
}, 400);

/* ---------------- gamepad: bindings + ballistics (user-configurable) ----------
   Response curve: normalize past the deadzone, raise to `curve`, scale by
   maxSpeedPct. curve 1 = linear (twitchy near centre), 2 = quadratic (default,
   fine control near centre), 3+ = very soft centre for delicate framing.      */
const BIND_ORDER = ["slide", "pan", "tilt"];
let padCfg = { bindings: { slide: { axisIndex: 0, invert: false }, pan: { axisIndex: 2, invert: false }, tilt: { axisIndex: 3, invert: true } },
               deadzone: 0.15, curve: 2, maxSpeedPct: 100 };

function ballistics(raw, cfg) {
  const a = Math.abs(raw);
  if (a < cfg.deadzone) return 0;
  const n = (a - cfg.deadzone) / (1 - cfg.deadzone);
  return Math.sign(raw) * Math.pow(n, cfg.curve) * (cfg.maxSpeedPct / 100);
}
function readPadAxis(pad, which) {
  const b = padCfg.bindings[which];
  if (!b || b.axisIndex == null) return 0;
  const v = pad.axes[b.axisIndex] ?? 0;
  return b.invert ? -v : v;
}

let padTimer = null; const lastSent = [0, 0, 0];
function stopGamepad() {
  if (padTimer) { clearInterval(padTimer); padTimer = null; }
  $("gamepad").classList.remove("toggled");
  if (connected) for (const a of AXES) window.nmx.jog(a.motor, 0);
  lastSent.fill(0);
}
$("gamepad").onclick = () => {
  if (padTimer) { stopGamepad(); status("Gamepad off."); return; }
  $("gamepad").classList.add("toggled");
  status("Gamepad jog active — ⚙ to remap or change feel.");
  let beat = 0;
  padTimer = setInterval(() => {
    const pad = navigator.getGamepads?.().find((g) => g);
    if (!pad || !connected) return;
    $("gamepadName").textContent = pad.id.slice(0, 30);
    const max = Number($("speed").value);
    beat = (beat + 1) % 4;                       // heartbeat keeps the firmware watchdog fed
    BIND_ORDER.forEach((which, i) => {
      const sp = Math.round(ballistics(readPadAxis(pad, which), padCfg) * max);
      if (sp !== lastSent[i] || (beat === 0 && sp !== 0)) { lastSent[i] = sp; window.nmx.jog(AXES[i].motor, sp); }
    });
  }, 66);
};
window.addEventListener("gamepadconnected", (e) => { $("gamepadName").textContent = e.gamepad.id.slice(0, 30); });

/* ---- gamepad settings modal ---- */
let learning = null;                       // {which} while capturing a stick
function renderBinds() {
  $("binds").innerHTML = BIND_ORDER.map((w, i) => `
    <div class="bindrow">
      <span style="color:${AXES[i].color};font-size:11px">${AXES[i].name}</span>
      <span style="font-family:var(--mono);font-size:10.5px;color:var(--ink-dim)" id="bindLbl-${w}">axis ${padCfg.bindings[w].axisIndex}</span>
      <button data-inv="${w}" class="${padCfg.bindings[w].invert ? "toggled" : ""}">invert</button>
      <button data-learn="${w}">bind…</button>
    </div>`).join("");
  $("binds").querySelectorAll("[data-inv]").forEach((b) => b.onclick = () => {
    const w = b.dataset.inv; padCfg.bindings[w].invert = !padCfg.bindings[w].invert; savePad(); renderBinds();
  });
  $("binds").querySelectorAll("[data-learn]").forEach((b) => b.onclick = () => {
    learning = { which: b.dataset.learn, base: null };
    b.textContent = "move it…"; b.classList.add("toggled");
    $("padStatus").textContent = `Move the control you want for ${learning.which.toUpperCase()}.`;
  });
}
function savePad() { window.nmx.setPrefs({ gamepad: padCfg }); }

const padViz = $("padViz"), pvx = padViz.getContext("2d");
function drawPadViz(live) {
  const w = padViz.clientWidth, h = padViz.clientHeight, dpr = devicePixelRatio || 1;
  if (padViz.width !== Math.round(w * dpr)) { padViz.width = Math.round(w * dpr); padViz.height = Math.round(h * dpr); }
  pvx.setTransform(dpr, 0, 0, dpr, 0, 0); pvx.clearRect(0, 0, w, h);
  pvx.strokeStyle = "#232830"; pvx.beginPath(); pvx.moveTo(0, h / 2); pvx.lineTo(w, h / 2); pvx.stroke();
  pvx.strokeStyle = css.getPropertyValue("--accent").trim(); pvx.lineWidth = 2; pvx.beginPath();
  for (let i = 0; i <= 100; i++) {
    const x = (i / 100) * 2 - 1, y = ballistics(x, padCfg);
    const px = ((x + 1) / 2) * w, py = h / 2 - (y * h) / 2;
    i ? pvx.lineTo(px, py) : pvx.moveTo(px, py);
  }
  pvx.stroke(); pvx.lineWidth = 1;
  if (live) live.forEach((v, i) => {
    const y = ballistics(v, padCfg);
    pvx.fillStyle = AXES[i].color; pvx.beginPath();
    pvx.arc(((v + 1) / 2) * w, h / 2 - (y * h) / 2, 4, 0, Math.PI * 2); pvx.fill();
  });
}

setInterval(() => {
  if (!$("padModal").classList.contains("open")) return;
  const pad = navigator.getGamepads?.().find((g) => g);
  if (!pad) { $("padStatus").textContent = "No controller detected — connect one and press any button."; return drawPadViz(null); }
  if (!learning) $("padStatus").textContent = `${pad.id.slice(0, 40)} · ${pad.axes.length} axes`;
  if (learning) {
    if (!learning.base) learning.base = [...pad.axes];
    let best = -1, bestD = 0.35;
    pad.axes.forEach((v, i) => { const d = Math.abs(v - (learning.base[i] ?? 0)); if (d > bestD) { bestD = d; best = i; } });
    if (best >= 0) {
      padCfg.bindings[learning.which].axisIndex = best;
      $("padStatus").textContent = `${learning.which.toUpperCase()} → axis ${best}`;
      learning = null; savePad(); renderBinds();
    }
  }
  drawPadViz(BIND_ORDER.map((w) => readPadAxis(pad, w)));
}, 80);

$("gamepadCfg").onclick = () => { renderBinds(); syncPadInputs(); $("padModal").classList.add("open"); };
function syncPadInputs() {
  $("padDead").value = Math.round(padCfg.deadzone * 100);
  $("padCurve").value = padCfg.curve;
  $("padMax").value = padCfg.maxSpeedPct;
  $("padCurveDesc").textContent = padCfg.curve <= 1.2 ? "linear — direct, twitchy near centre"
    : padCfg.curve < 2.5 ? "quadratic — fine control near centre (default)" : "soft — very delicate near centre";
}
for (const [id, apply] of [["padDead", (v) => padCfg.deadzone = v / 100], ["padCurve", (v) => padCfg.curve = v], ["padMax", (v) => padCfg.maxSpeedPct = v]]) {
  $(id).addEventListener("input", () => { apply(Number($(id).value)); syncPadInputs(); drawPadViz(null); savePad(); });
}

/* ---------------- soft limits UI ---------------- */
let limits = [{ min: null, max: null }, { min: null, max: null }, { min: null, max: null }];
const fmtLim = (v) => (v === null ? "—" : String(Math.round(v)));

function renderLimits() {
  $("limits").innerHTML = AXES.map((a, i) => `
    <div class="lim">
      <span class="swatch" style="background:${a.color}"></span>
      <span class="nm">${a.name}</span>
      <button data-lim="${a.motor}:min" class="${limits[i].min === null ? "unset" : "set"}" title="Set minimum at current position">min ${fmtLim(limits[i].min)}</button>
      <button data-lim="${a.motor}:max" class="${limits[i].max === null ? "unset" : "set"}" title="Set maximum at current position">max ${fmtLim(limits[i].max)}</button>
      <button class="clr" data-limclr="${a.motor}" title="Clear this axis">✕</button>
    </div>`).join("");
  $("limits").querySelectorAll("[data-lim]").forEach((b) => b.onclick = async () => {
    if (!connected) return status("Connect first — limits are taught from the live position.");
    const [m, bound] = b.dataset.lim.split(":");
    limits = await window.nmx.setLimitHere(+m, bound);
    renderLimits(); render();
    status(`${AXES[+m - 1].name} ${bound} limit set at ${fmtLim(limits[+m - 1][bound])} steps.`);
  });
  $("limits").querySelectorAll("[data-limclr]").forEach((b) => b.onclick = async () => {
    limits = await window.nmx.clearLimits(+b.dataset.limclr); renderLimits(); render();
  });
}
$("limClearAll").onclick = async () => { limits = await window.nmx.clearLimits(null); renderLimits(); render(); status("All soft limits cleared."); };

window.nmx.onLimitHit?.(({ motor, position }) => {
  status(`⚠ ${AXES[motor - 1].name} stopped at soft limit (${Math.round(position)} steps).`);
});

/* ---------------- modals ---------------- */
document.querySelectorAll("[data-close]").forEach((b) => b.onclick = () => b.closest(".modal").classList.remove("open"));
document.querySelectorAll(".modal").forEach((m) => m.addEventListener("pointerdown", (e) => { if (e.target === m) m.classList.remove("open"); }));
$("helpBtn").onclick = () => $("helpModal").classList.add("open");
$("tbCfg").onclick = () => { syncInputs(); $("tbModal").classList.add("open"); };

/* ---------------- countdown ---------------- */
function countdown(sec) {
  return new Promise((res) => {
    if (sec <= 0) return res();
    const el = $("countdown"), n = el.querySelector(".n");
    let k = sec; el.style.display = "flex"; n.textContent = k;
    const t = setInterval(() => {
      if (--k <= 0) { clearInterval(t); el.style.display = "none"; res(); } else n.textContent = k;
    }, 1000);
  });
}

/* ================= timeline ================= */
const cv = $("timeline"), ctx = cv.getContext("2d");
const RULER = 20, PAD_L = 40, PAD_R = 12;

const trackRect = (i) => {
  const h = (cv.clientHeight - RULER) / 3;
  return { x: PAD_L, y: RULER + i * h + 6, w: cv.clientWidth - PAD_L - PAD_R, h: h - 12 };
};
const fToX = (f, r) => r.x + ((f - view.f0) / (view.f1 - view.f0)) * r.w;
const xToF = (x, r) => view.f0 + ((x - r.x) / r.w) * (view.f1 - view.f0);
/** Pointer x to a WHOLE frame — the timeline snaps, always. */
const xToFrame = (x, r) => Math.round(xToF(x, r));

function axisScale(i) {
  const pts = film.axes[i].points, sm = previewCache?.[i]?.samples ?? [];
  const vals = [...pts.map((p) => p.position), ...sm.map((s) => s.pos)];
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (hi - lo < 100) { const m = (lo + hi) / 2; lo = m - 50; hi = m + 50; }
  /* Grow the view to include taught soft limits, so the operator can SEE the
     headroom between the move and the bound (ADR-0013). Capped at 60% of the
     move's own span per side — a distant limit must not squash the curve into
     a flat line. Anything still off-scale is drawn as an edge hairline. */
  const cap = (hi - lo) * 0.6, L = limits[i];
  if (L) {
    if (L.max !== null) hi = Math.min(Math.max(hi, L.max), hi + cap);
    if (L.min !== null) lo = Math.max(Math.min(lo, L.min), lo - cap);
  }
  const pad = (hi - lo) * 0.12;
  return { min: lo - pad, max: hi + pad };
}
const posToY = (p, r, s) => r.y + r.h - ((p - s.min) / (s.max - s.min)) * r.h;
const yToPos = (y, r, s) => s.min + ((r.y + r.h - y) / r.h) * (s.max - s.min);

/**
 * Ruler tick spacing in FRAMES. The ladder is built from the shooting rate so
 * ticks land on whole seconds — a ruler that ticks every 37 frames is useless
 * to someone reading timecode.
 */
function niceStep(spanFrames, targetPx, widthPx) {
  const r = TC.nominalRate(film.timebase);
  const perPx = spanFrames / widthPx;
  const raw = perPx * targetPx;
  const steps = [1, 2, 5, 10, r / 2, r, 2 * r, 5 * r, 10 * r, 15 * r, 30 * r, 60 * r, 300 * r, 600 * r]
    .map((v) => Math.max(1, Math.round(v)))
    .filter((v, i, a) => a.indexOf(v) === i)
    .sort((a, b) => a - b);
  return steps.find((s) => s >= raw) ?? steps[steps.length - 1];
}

function render() {
  const w = cv.clientWidth, h = cv.clientHeight;
  const dpr = devicePixelRatio || 1;
  if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const rTop = { x: PAD_L, y: 0, w: w - PAD_L - PAD_R, h: RULER };

  /* ruler */
  ctx.fillStyle = "#171a1d"; ctx.fillRect(0, 0, w, RULER);
  ctx.fillStyle = INK_FAINT; ctx.font = "10px ui-monospace, Menlo, monospace"; ctx.textBaseline = "middle";
  const step = niceStep(view.f1 - view.f0, 78, rTop.w);
  const first = Math.ceil(view.f0 / step) * step;
  const rate = TC.nominalRate(film.timebase);
  for (let fr = first; fr <= view.f1; fr += step) {
    const x = fToX(fr, rTop);
    ctx.fillRect(x, RULER - 5, 1, 5);
    /* Ruler ticks drop the hours field — MM:SS:FF, or SS:FF when zoomed in
       past a second. The hour never changes across a camera move, so printing
       it on every tick is three wasted characters that push the labels into
       each other; the full timecode lives in the playhead chip. (Same
       convention as Resolve's and Premiere's rulers.) */
    const tc = tcOf(fr);
    const label = step < rate ? tc.slice(6) : tc.slice(3);
    /* Drop the label rather than let the last tick render clipped at the edge. */
    if (x + 3 + ctx.measureText(label).width <= rTop.x + rTop.w) ctx.fillText(label, x + 3, RULER / 2 - 1);
    /* vertical grid down the tracks */
    ctx.fillStyle = "#1b1f23"; ctx.fillRect(x, RULER, 1, h - RULER); ctx.fillStyle = INK_FAINT;
  }

  /* tracks */
  AXES.forEach((a, i) => {
    const r = trackRect(i), s = axisScale(i);
    ctx.strokeStyle = LINE; ctx.lineWidth = 1;
    ctx.strokeRect(r.x + .5, r.y + .5, r.w - 1, r.h - 1);

    /* forbidden zones outside the taught soft limits (ADR-0013) */
    const L = limits[i];
    if (L && (L.min !== null || L.max !== null)) {
      ctx.save(); ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.clip();
      ctx.fillStyle = "rgba(169,50,38,.14)";
      if (L.max !== null && L.max < s.max) { const y = posToY(L.max, r, s); ctx.fillRect(r.x, r.y, r.w, Math.max(0, y - r.y)); }
      if (L.min !== null && L.min > s.min) { const y = posToY(L.min, r, s); ctx.fillRect(r.x, y, r.w, Math.max(0, r.y + r.h - y)); }
      ctx.setLineDash([3, 3]);
      for (const b of [L.min, L.max]) {
        if (b === null) continue;
        /* Off-scale (still beyond the capped view) = lots of headroom, not a
           hazard: pin a faint hairline to that edge rather than a solid band,
           so "bound exists, far away" never reads as "forbidden here". */
        const off = b < s.min || b > s.max;
        const y = off ? (b > s.max ? r.y + 1 : r.y + r.h - 1) : posToY(b, r, s);
        ctx.strokeStyle = off ? "rgba(207,68,54,.28)" : "rgba(207,68,54,.5)";
        ctx.beginPath(); ctx.moveTo(r.x, y); ctx.lineTo(r.x + r.w, y); ctx.stroke();
      }
      ctx.setLineDash([]); ctx.restore();
    }

    /* zero line */
    if (s.min < 0 && s.max > 0) {
      const y0 = posToY(0, r, s);
      ctx.strokeStyle = "#232830"; ctx.beginPath(); ctx.moveTo(r.x, y0); ctx.lineTo(r.x + r.w, y0); ctx.stroke();
    }

    /* axis label (direct label — identity never color-alone) */
    ctx.save(); ctx.translate(13, r.y + r.h / 2); ctx.rotate(-Math.PI / 2);
    ctx.textAlign = "center"; ctx.fillStyle = a.color; ctx.font = "600 10px system-ui";
    ctx.fillText(a.name.toUpperCase(), 0, 0); ctx.restore(); ctx.textAlign = "left";

    /* curve — from the core solver (ADR-0009) */
    const sm = previewCache?.[i]?.samples;
    if (sm) {
      ctx.save(); ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.clip();
      ctx.strokeStyle = a.color; ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.beginPath();
      let started = false;
      for (const pt of sm) {
        if (pt.frame < view.f0 - 2 || pt.frame > view.f1 + 2) continue;
        const x = fToX(pt.frame, r), y = posToY(pt.pos, r, s);
        started ? ctx.lineTo(x, y) : (ctx.moveTo(x, y), started = true);
      }
      ctx.stroke(); ctx.restore(); ctx.lineWidth = 1;
    }

    /* keyframes as diamonds — the animation-software convention */
    film.axes[i].points.forEach((p, k) => {
      if (p.frame < view.f0 - 8 || p.frame > view.f1 + 8) return;
      const x = fToX(p.frame, r), y = posToY(p.position, r, s);
      const sel = selection && selection.track === i && selection.k === k;
      const R = sel ? 6 : 4.5;
      ctx.beginPath();
      ctx.moveTo(x, y - R); ctx.lineTo(x + R, y); ctx.lineTo(x, y + R); ctx.lineTo(x - R, y); ctx.closePath();
      ctx.fillStyle = a.color; ctx.fill();
      ctx.strokeStyle = sel ? "#ffffff" : "#0e1013"; ctx.lineWidth = sel ? 1.6 : 1; ctx.stroke(); ctx.lineWidth = 1;
    });
  });

  /* playhead */
  const px = fToX(playheadFrame, rTop);
  if (px >= PAD_L - 1 && px <= w - PAD_R + 1) {
    ctx.strokeStyle = "rgba(232,234,237,.55)"; ctx.beginPath();
    ctx.moveTo(px + .5, RULER); ctx.lineTo(px + .5, h); ctx.stroke();
    ctx.fillStyle = INK; ctx.beginPath();
    ctx.moveTo(px - 5, RULER - 9); ctx.lineTo(px + 5, RULER - 9); ctx.lineTo(px, RULER - 1); ctx.closePath(); ctx.fill();
  }

  $("playheadLabel").textContent = tcOf(playheadFrame);
  $("playheadFrameLabel").textContent = `${Math.round(playheadFrame)}f`;
  $("zoomLabel").textContent = Math.round((film.durationFrames / (view.f1 - view.f0)) * 100) + "%";
}

let previewTimer = null;
function refreshPreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    try {
      previewCache = await window.nmx.previewMove(film, 200);
    } catch (e) { previewCache = null; status("Curve solve failed: " + e.message); }
    uploaded = false; render();
  }, 50);
}

/* ---------------- zoom / pan ---------------- */
function frameAll() { view = { f0: 0, f1: film.durationFrames }; render(); }
$("tlFrame").onclick = frameAll;

cv.addEventListener("wheel", (e) => {
  e.preventDefault();
  const r = { x: PAD_L, w: cv.clientWidth - PAD_L - PAD_R };
  const span = view.f1 - view.f0;
  if (e.shiftKey) {
    const d = (e.deltaY || e.deltaX) * span * 0.0015;
    view.f0 += d; view.f1 += d;
  } else {
    const rect = cv.getBoundingClientRect();
    const anchor = xToF(e.clientX - rect.left, r);
    const f = Math.exp(e.deltaY * 0.0015);
    /* Floor the zoom at 8 frames across — past that a frame is wider than the
       track and the ruler stops meaning anything. */
    const ns = Math.min(film.durationFrames * 4, Math.max(8, span * f));
    const frac = (anchor - view.f0) / span;
    view.f0 = anchor - frac * ns; view.f1 = view.f0 + ns;
  }
  /* keep the window from drifting far outside the move */
  const pad = film.durationFrames * 0.25;
  if (view.f0 < -pad) { const w = view.f1 - view.f0; view.f0 = -pad; view.f1 = -pad + w; }
  if (view.f1 > film.durationFrames + pad) { const w = view.f1 - view.f0; view.f1 = film.durationFrames + pad; view.f0 = view.f1 - w; }
  render();
}, { passive: false });

/* ---------------- pointer interaction ---------------- */
let drag = null;
function hit(mx, my) {
  for (let i = 0; i < 3; i++) {
    const r = trackRect(i), s = axisScale(i), pts = film.axes[i].points;
    for (let k = 0; k < pts.length; k++) {
      const x = fToX(pts[k].frame, r), y = posToY(pts[k].position, r, s);
      if ((mx - x) ** 2 + (my - y) ** 2 < 90) return { track: i, k, r, s };
    }
  }
  return null;
}
cv.addEventListener("pointerdown", (e) => {
  const b = cv.getBoundingClientRect(), mx = e.clientX - b.left, my = e.clientY - b.top;
  cv.setPointerCapture(e.pointerId);
  if (e.button === 1) { drag = { type: "pan", x: mx }; return; }
  if (my <= RULER) { drag = { type: "ph" }; movePlayhead(mx); return; }
  const h = hit(mx, my);
  if (h) { snapshot(); selection = { track: h.track, k: h.k }; drag = { type: "kf", ...h }; }
  else selection = null;
  updateInspector(); render();
});
cv.addEventListener("pointermove", (e) => {
  const b = cv.getBoundingClientRect(), mx = e.clientX - b.left, my = e.clientY - b.top;
  if (!drag) return;
  if (drag.type === "ph") return movePlayhead(mx);
  if (drag.type === "pan") {
    const r = { x: PAD_L, w: cv.clientWidth - PAD_L - PAD_R };
    const d = ((drag.x - mx) / r.w) * (view.f1 - view.f0);
    view.f0 += d; view.f1 += d; drag.x = mx; return render();
  }
  const { track, k, r, s } = drag, pts = film.axes[track].points;
  pts[k].position = Math.round(yToPos(my, r, s));
  if (k > 0 && k < pts.length - 1) {
    /* Frame-quantised, and never closer than one frame to a neighbour: two
       keyframes on the same frame is not a move the solver can interpret. */
    const lo = pts[k - 1].frame + MIN_GAP, hi = pts[k + 1].frame - MIN_GAP;
    pts[k].frame = Math.max(lo, Math.min(hi, xToFrame(mx, r)));
  }
  updateInspector(); refreshPreview();
});
cv.addEventListener("pointerup", () => { drag = null; });
cv.addEventListener("dblclick", (e) => {
  const b = cv.getBoundingClientRect();
  const h = hit(e.clientX - b.left, e.clientY - b.top);
  if (h) delKey(h.track, h.k);
});
function movePlayhead(mx) {
  const r = { x: PAD_L, w: cv.clientWidth - PAD_L - PAD_R };
  playheadFrame = Math.max(0, Math.min(film.durationFrames, xToFrame(mx, r)));
  render();
}

function delKey(track, k) {
  const pts = film.axes[track].points;
  if (k === 0 || k === pts.length - 1 || pts.length <= 2) return;
  snapshot(); pts.splice(k, 1); selection = null; updateInspector(); refreshPreview();
}

/* ---------------- inspector ---------------- */
function updateInspector() {
  const p = selection && film.axes[selection.track].points[selection.k];
  if (!p) { $("kfEmpty").style.display = ""; $("kfFields").style.display = "none"; selection = null; return; }
  $("kfEmpty").style.display = "none"; $("kfFields").style.display = "flex";
  const pts = film.axes[selection.track].points;
  const end = selection.k === 0 || selection.k === pts.length - 1;
  $("kfLabel").textContent = `${AXES[selection.track].name} · key ${selection.k + 1}/${pts.length}${end ? " (endpoint)" : ""}`;
  $("kfTime").value = String(p.frame);
  $("kfTc").value = tcOf(p.frame);
  $("kfPos").value = String(Math.round(p.position));
  $("kfTime").disabled = end; $("kfTc").disabled = end; $("kfDelete").disabled = end;
}

/** Clamp a keyframe to whole frames inside its neighbours, then commit. */
function setKeyFrameNumber(frame) {
  const pts = film.axes[selection.track].points, k = selection.k;
  if (k === 0 || k === pts.length - 1) return;
  snapshot();
  pts[k].frame = Math.max(pts[k - 1].frame + MIN_GAP, Math.min(pts[k + 1].frame - MIN_GAP, Math.round(frame)));
  updateInspector(); refreshPreview();
}
$("kfTime").onchange = () => { if (selection) setKeyFrameNumber(Number($("kfTime").value)); };
$("kfTc").onchange = () => {
  if (!selection) return;
  try {
    /* Typed timecode is absolute (it includes the move's start TC), so subtract
       the start to get a frame offset within the move. */
    setKeyFrameNumber(TC.timecodeToFrames($("kfTc").value, film.timebase) - film.startFrame);
  } catch (err) { status(err.message); updateInspector(); }
};
$("kfPos").onchange = () => {
  if (!selection) return;
  snapshot();
  film.axes[selection.track].points[selection.k].position = Math.round(Number($("kfPos").value));
  refreshPreview();
};
$("kfDelete").onclick = () => selection && delKey(selection.track, selection.k);

/* ---------------- capture ---------------- */
async function capture(i) {
  const a = AXES[i], pos = await window.nmx.position(a.motor);
  snapshot();
  const pts = film.axes[i].points;
  /* Replace the key under the playhead rather than stacking a second one on
     top of it — within half a second, because that is the precision of a hand
     on a jog control, not of the playhead. */
  const window_ = Math.max(1, Math.round(TC.fpsDecimal(film.timebase) / 2));
  const near = pts.findIndex((p) => Math.abs(p.frame - playheadFrame) <= window_);
  if (near >= 0) { pts[near].position = pos; pts[near].frame = playheadFrame; }
  else { pts.push({ frame: playheadFrame, position: pos }); pts.sort((x, y) => x.frame - y.frame); }
  status(`${a.name} key @ ${tcOf(playheadFrame)} (${playheadFrame}f) = ${pos} steps`);
  refreshPreview();
}
$("capSlide").onclick = () => capture(0);
$("capPan").onclick = () => capture(1);
$("capTilt").onclick = () => capture(2);

/* ---------------- move params / files ---------------- */
$("tlDuration").onchange = () => {
  snapshot();
  const dur = Math.max(2, Math.round(Number($("tlDuration").value)));
  const sc = dur / film.durationFrames;
  for (const ax of film.axes) for (const p of ax.points) p.frame = Math.round(p.frame * sc);
  /* Rescaling can collide keys onto one frame; push them apart in order. */
  for (const ax of film.axes) {
    for (let k = 1; k < ax.points.length; k++) {
      if (ax.points[k].frame <= ax.points[k - 1].frame) ax.points[k].frame = ax.points[k - 1].frame + MIN_GAP;
    }
    ax.points[ax.points.length - 1].frame = Math.min(ax.points[ax.points.length - 1].frame, dur);
  }
  film.durationFrames = dur;
  playheadFrame = Math.min(playheadFrame, dur);
  syncInputs(); frameAll(); refreshPreview();
};
$("tlCue").onchange = () => { film.cueFrames = Math.max(0, Math.round(Number($("tlCue").value))); syncInputs(); };
$("tlStartTc").onchange = () => {
  try { film.startFrame = TC.timecodeToFrames($("tlStartTc").value, film.timebase); }
  catch (err) { status(err.message); }
  syncInputs(); updateInspector(); render();
};
/**
 * Changing the timebase RETIMES the move: frame numbers are recomputed so the
 * rig does exactly what it did before, in the same real seconds. The alternative
 * — keeping frame numbers and letting the move get shorter or longer — would
 * silently change a move that has already been matched to a performance.
 */
$("tlTimebase").onchange = () => {
  const tb = TC.timebaseById($("tlTimebase").value);
  if (!tb) return;
  snapshot();
  const from = film.timebase;
  film.durationFrames = Math.max(2, TC.retimeFrames(film.durationFrames, from, tb));
  film.cueFrames = TC.retimeFrames(film.cueFrames, from, tb);
  film.startFrame = TC.retimeFrames(film.startFrame, from, tb);
  for (const ax of film.axes) {
    for (const pt of ax.points) pt.frame = TC.retimeFrames(pt.frame, from, tb);
    for (let k = 1; k < ax.points.length; k++) {
      if (ax.points[k].frame <= ax.points[k - 1].frame) ax.points[k].frame = ax.points[k - 1].frame + MIN_GAP;
    }
  }
  playheadFrame = TC.retimeFrames(playheadFrame, from, tb);
  film.timebase = { ...tb };
  uploaded = false;
  syncInputs(); frameAll(); refreshPreview();
  status(`Timebase ${TC.timebaseLabel(tb)} — move retimed to ${film.durationFrames} frames, same real duration.`);
};
$("moveName").onchange = () => { film.name = $("moveName").value; };

function adopt(f, path = null) {
  film = f; undoStack.length = 0; redoStack.length = 0; selection = null;
  filePath = path; dirty = false;
  updateInspector(); syncInputs(); playheadFrame = 0; frameAll(); refreshPreview();
}

function markDirty() { dirty = true; updateFileLabel(); }

function updateFileLabel() {
  const name = filePath ? filePath.replace(/^.*\//, "") : "not saved yet";
  $("tlFilePath").textContent = (dirty ? "• " : "") + name;
  $("tlFilePath").title = filePath ?? "This move has never been written to disk";
  /* Save is only dead when there is a file AND nothing has changed since —
     never when the move has no file yet, or the first Save would look broken. */
  $("tlSave").disabled = Boolean(filePath) && !dirty;
}
$("tlNew").onclick = () => {
  if (dirty && !confirm("Discard unsaved changes to this move?")) return;
  adopt(defaultFilm(Math.round(Number($("tlDuration").value)), film.timebase));
  status("New move.");
};

/** Save to the current file. With no current file this becomes Save As. */
async function saveMove(forceDialog) {
  try {
    const p = await window.nmx.saveFilm(film, forceDialog ? null : filePath);
    if (!p) return null;                       // cancelled
    filePath = p; dirty = false; updateFileLabel();
    logPass(`saved “${film.name}”`);
    status("Saved: " + p);
    return p;
  } catch (e) {
    status("Save failed: " + e.message);       // main also raises a dialog
    return null;
  }
}
$("tlSave").onclick = () => saveMove(false);
$("tlSaveAs").onclick = () => saveMove(true);

$("tlLoad").onclick = async () => {
  if (dirty && !confirm("Discard unsaved changes to this move?")) return;
  try {
    const r = await window.nmx.loadFilm();
    if (!r) return;
    adopt(r.film, r.path);
    status(`Opened “${r.film.name}” — ${TC.formatDuration(r.film.durationFrames, r.film.timebase)} @ ${TC.timebaseLabel(r.film.timebase)} fps.`);
    if (r.film.notes) logPass(r.film.notes.split("\n")[0]);
  } catch (e) { status("Open failed: " + e.message); }
};

/* ---------------- 3D export (ADR-0015) ---------------- */

let exPrefs = null, exFormats = [];

const EX_FIELDS = {
  exSlideCal: ["calibration", "slideStepsPerMm"], exPanCal: ["calibration", "panStepsPerDeg"],
  exTiltCal: ["calibration", "tiltStepsPerDeg"], exNodal: ["calibration", "nodalOffsetMm"],
  exHead: ["calibration", "headHeightMm"],
  exFocal: ["lens", "focalLengthMm"], exSensorW: ["lens", "sensorWidthMm"], exSensorH: ["lens", "sensorHeightMm"],
  exPxPerM: [null, "pixelsPerMeter"], exCompW: [null, "compWidth"], exCompH: [null, "compHeight"],
};
const EX_CHECKS = { exInvSlide: "invertSlide", exInvPan: "invertPan", exInvTilt: "invertTilt" };

function exportOptsFromUi() {
  return {
    calibration: { ...exPrefs.calibration },
    lens: { ...exPrefs.lens },
    metersPerUnit: Number($("exUnits").value),
    upAxis: $("exUp").value,
    pixelsPerMeter: exPrefs.pixelsPerMeter,
    compWidth: exPrefs.compWidth,
    compHeight: exPrefs.compHeight,
  };
}

function syncExportUi() {
  for (const [id, [group, key]] of Object.entries(EX_FIELDS)) {
    $(id).value = String((group ? exPrefs[group] : exPrefs)[key] ?? 0);
  }
  for (const [id, key] of Object.entries(EX_CHECKS)) $(id).checked = Boolean(exPrefs.calibration[key]);
  $("exUnits").value = String(exPrefs.metersPerUnit);
  $("exUp").value = exPrefs.upAxis;
  $("exFormat").value = exPrefs.formatId;
  const fmt = exFormats.find((f) => f.id === exPrefs.formatId);
  $("exNote").textContent = fmt?.note ?? "";
  // AE is the only target with no real-world units, so its mapping row is the
  // only one that is conditional — showing it always would imply the others
  // need it too.
  $("exAeRow").style.display = exPrefs.formatId === "ae" ? "" : "none";
  refreshExtents();
}

/**
 * The pre-flight scale check. Reading "travel 412 mm · pan 37.4°" catches a
 * calibration that is out by a factor of ten far more reliably than opening
 * the exported file in another application does.
 */
async function refreshExtents() {
  try {
    const e = await window.nmx.moveExtents(film, exPrefs.calibration);
    const mpu = Number($("exUnits").value);
    const unit = mpu === 1 ? "m" : "cm";
    const toScene = (mm) => (mm / 1000 / mpu).toFixed(3);
    const row = (label, sp, u, extra = "") =>
      `${label.padEnd(6)} ${sp.min.toFixed(1).padStart(9)} → ${sp.max.toFixed(1).padStart(9)} ${u}` +
      `   travel ${sp.range.toFixed(1)} ${u}${extra}`;
    $("exExtents").textContent = [
      row("slide", e.slideMm, "mm", `  (${toScene(e.slideMm.range)} ${unit} in scene)`),
      row("pan", e.panDeg, "°"),
      row("tilt", e.tiltDeg, "°"),
    ].join("\n");
  } catch (err) { $("exExtents").textContent = "scale check failed: " + err.message; }
}

async function openExport() {
  if (!exFormats.length) exFormats = await window.nmx.exportFormats();
  if (!$("exFormat").options.length) {
    $("exFormat").innerHTML = exFormats.map((f) => `<option value="${f.id}">${f.label}</option>`).join("");
  }
  syncExportUi();
  $("exportModal").classList.add("open");
}
$("tlExport").onclick = openExport;

function wireExportInputs() {
  for (const [id, [group, key]] of Object.entries(EX_FIELDS)) {
    $(id).addEventListener("change", () => {
      const v = Number($(id).value);
      if (!Number.isFinite(v)) return;
      if (group) exPrefs[group][key] = v; else exPrefs[key] = v;
      persistExport(); refreshExtents();
    });
  }
  for (const [id, key] of Object.entries(EX_CHECKS)) {
    $(id).addEventListener("change", () => {
      exPrefs.calibration[key] = $(id).checked; persistExport(); refreshExtents();
    });
  }
  $("exUnits").onchange = () => { exPrefs.metersPerUnit = Number($("exUnits").value); persistExport(); refreshExtents(); };
  $("exUp").onchange = () => { exPrefs.upAxis = $("exUp").value; persistExport(); };
  $("exFormat").onchange = () => { exPrefs.formatId = $("exFormat").value; persistExport(); syncExportUi(); };
}

function persistExport() { window.nmx.setPrefs({ export: exPrefs }); }

$("exGo").onclick = async () => {
  try {
    const r = await window.nmx.exportMove(film, exPrefs.formatId, exportOptsFromUi());
    if (!r) return;
    $("exportModal").classList.remove("open");
    const names = r.written.map((p) => p.replace(/^.*\//, "")).join(" + ");
    logPass(`exported ${names}`);
    status(`Exported ${r.format}: ${names}`);
  } catch (e) { status("Export failed: " + e.message); }
};

/* ---------------- KF transport ---------------- */
$("tlUpload").onclick = async () => {
  try {
    const n = await window.nmx.uploadKf(film);
    uploaded = true; status(`Uploaded to controller (${n} packets). Ready to run.`);
  } catch (e) { status("Upload blocked: " + e.message); }
};
$("tlGotoStart").onclick = async () => {
  await window.nmx.gotoKfStart(film.axes.map((a) => ({ axis: a.axis, points: a.points })));
  status("Sending axes to first keys…");
};
$("tlRun").onclick = async () => {
  try {
    if (!uploaded) return status("Upload first (↑) — edits since last upload aren’t on the controller.");
    kfPassCount++; $("tlPassCounter").textContent = "pass " + kfPassCount;
    await countdown(Math.round((await window.nmx.cueMs(film)) / 1000));
    await window.nmx.kfRun();
    logPass(`KF pass ${kfPassCount} — “${film.name}”`);
    clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
      try {
        const p = await window.nmx.kfProgress();
        $("tlProg").style.width = (p.percent ?? 0) + "%";
        if (p.state === 0 && (p.percent ?? 0) > 0) {
          clearInterval(pollTimer); logPass(`KF pass ${kfPassCount} complete`);
          status(`Pass ${kfPassCount} complete. ⏮ then reposition, run again.`);
        }
      } catch { clearInterval(pollTimer); }
    }, 500);
  } catch (e) { status("Run blocked: " + e.message); }
};
$("tlStop").onclick = async () => { clearInterval(pollTimer); await window.nmx.kfStop(); status("Key-frame program stopped."); };

/* ---------------- classic 2-point ---------------- */
$("markStart").onclick = async () => { await window.nmx.setStartHere(); status("START marked at current positions."); };
$("markStop").onclick = async () => { await window.nmx.setStopHere(); status("END marked at current positions."); };
$("arm").onclick = async () => {
  try {
    const travelFrames = Math.max(1, Math.round(Number($("travel").value)));
    /* Ease over a quarter of the move, capped at 2 s worth of frames. */
    const ease = Math.min(Math.round(TC.fpsDecimal(film.timebase) * 2), Math.round(travelFrames / 4));
    await window.nmx.armMove(travelFrames, ease, ease, film.timebase);
    status(`Armed: ${TC.formatDuration(travelFrames, film.timebase)} continuous, quadratic ease.`);
  } catch (e) { status("Arm blocked: " + e.message); }
};
$("gotoStart").onclick = async () => { await window.nmx.gotoStart(); status("Sending axes to start marks…"); };
$("run").onclick = async () => {
  try {
    passCount++; $("passCounter").textContent = "pass " + passCount;
    await countdown(Math.round((await window.nmx.cueMs(film)) / 1000));
    await window.nmx.run(); logPass(`classic pass ${passCount}`);
    clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
      try {
        const p = await window.nmx.progress();
        $("prog").style.width = (p.percent ?? 0) + "%";
        if (!p.running && (p.percent ?? 0) > 0) {
          clearInterval(pollTimer); logPass(`classic pass ${passCount} complete`); status(`Pass ${passCount} complete.`);
        }
      } catch { clearInterval(pollTimer); }
    }, 500);
  } catch (e) { status("Run blocked: " + e.message); }
};

/* ---------------- camera ---------------- */
$("camArm").onclick = async () => {
  try {
    await window.nmx.camArm({ triggerMs: +$("camTrigger").value, focusMs: +$("camFocus").value, delayMs: +$("camDelay").value, maxShots: 0, intervalMs: 0 });
    status("Camera armed on NMX shutter output.");
  } catch (e) { status("Camera arm failed: " + e.message); }
};
$("camFire").onclick = async () => {
  try { await window.nmx.camFire(); status("Test exposure fired."); } catch (e) { status("Test fire failed: " + e.message); }
};
$("camOff").onclick = async () => { await window.nmx.camDisable(); status("Camera control disabled."); };

/* ---------------- e-stop ---------------- */
$("estop").onclick = async () => {
  clearInterval(pollTimer); $("countdown").style.display = "none"; stopGamepad();
  try { await window.nmx.stopAll(); status("STOP ALL sent — broadcast stop, both engines."); }
  catch (e) { status("STOP ALL error: " + e.message); }
};

/* ---------------- keyboard ---------------- */
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    document.querySelectorAll(".modal.open").forEach((m) => m.classList.remove("open"));
    $("countdown").style.display = "none";
    return;
  }
  const t = document.activeElement?.tagName;
  if (t === "INPUT" || t === "SELECT" || t === "TEXTAREA") return;
  if (e.key === "?" || (e.key === "/" && e.shiftKey)) { e.preventDefault(); return $("helpModal").classList.toggle("open"); }
  const meta = e.metaKey || e.ctrlKey;
  if (meta && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (meta && e.key.toLowerCase() === "s") { e.preventDefault(); saveMove(e.shiftKey); return; }
  if (meta && e.key.toLowerCase() === "o") { e.preventDefault(); $("tlLoad").click(); return; }
  if (meta && e.key.toLowerCase() === "n") { e.preventDefault(); $("tlNew").click(); return; }
  if (meta && e.shiftKey && e.key.toLowerCase() === "e") { e.preventDefault(); openExport(); return; }
  if (e.key === "f" || e.key === "Home") { e.preventDefault(); return frameAll(); }
  if (e.key === " ") { e.preventDefault(); return $("tlRun").click(); }
  if (!selection) return;
  const pts = film.axes[selection.track].points, p = pts[selection.k];
  if (!p) return;
  const end = selection.k === 0 || selection.k === pts.length - 1;
  const stepPos = e.shiftKey ? 100 : 10;
  if (e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); snapshot(); p.position += e.key === "ArrowUp" ? stepPos : -stepPos; }
  else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && e.altKey && !end) {
    /* One frame per press — the unit the operator is thinking in. Shift jumps
       a second, which at 24 fps is 24 frames, not "about a second". */
    e.preventDefault(); snapshot();
    const stepF = e.shiftKey ? Math.round(TC.fpsDecimal(film.timebase)) : 1;
    const d = e.key === "ArrowRight" ? stepF : -stepF;
    p.frame = Math.max(pts[selection.k - 1].frame + MIN_GAP,
                       Math.min(pts[selection.k + 1].frame - MIN_GAP, p.frame + d));
  } else if (e.key === "Backspace" || e.key === "Delete") { e.preventDefault(); return delKey(selection.track, selection.k); }
  else return;
  updateInspector(); refreshPreview();
});

/* ---------------- init ---------------- */
function buildTimebasePicker() {
  $("tlTimebase").innerHTML = TC.TIMEBASES
    .map((t) => `<option value="${t.id}">${t.label}</option>`).join("");
  $("tlTimebase").value = TC.timebaseId(film.timebase);
}

(async function init() {
  buildAxes();
  buildTimebasePicker();
  await refreshPorts();
  try {
    const p = await window.nmx.getPrefs();
    exPrefs = p?.export ?? {
      formatId: "usda", metersPerUnit: 1, upAxis: "Y", pixelsPerMeter: 1000,
      compWidth: 1920, compHeight: 1080,
      calibration: { slideStepsPerMm: 100, panStepsPerDeg: 100, tiltStepsPerDeg: 100, nodalOffsetMm: 0, headHeightMm: 0 },
      lens: { focalLengthMm: 35, sensorWidthMm: 24.89, sensorHeightMm: 14 },
    };
    wireExportInputs();
    if (p?.jogSpeed) $("speed").value = p.jogSpeed;
    if (p?.gamepad) padCfg = { ...padCfg, ...p.gamepad, bindings: { ...padCfg.bindings, ...(p.gamepad.bindings ?? {}) } };
    if (Array.isArray(p?.limits) && p.limits.length === 3) limits = p.limits;
    if (p?.lastPort) {
      const opt = [...$("ports").options].find((o) => o.value === p.lastPort);
      if (opt) $("ports").value = p.lastPort;         // remember, but never auto-connect to motors
    }
  } catch { /* preview / first run */ }
  renderLimits();
  syncPadInputs();
  adopt(film);
  new ResizeObserver(render).observe(cv);
  if (window.nmx.__preview) status("Browser preview — no hardware, no Electron. Controls are stubbed.");
})();

/* persist the jog speed as it changes */
$("speed").addEventListener("change", () => window.nmx.setPrefs?.({ jogSpeed: Number($("speed").value) }));
