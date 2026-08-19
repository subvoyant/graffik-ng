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
    cueMs: async (f) => Math.round((f.cueFrames * 1000 * f.timebase.den) / f.timebase.num),
    previewLens: async (f) => {
      const out = {};
      for (const ax of f.lensAxes ?? []) {
        const s = [];
        for (let fr = 0; fr <= f.durationFrames; fr++) {
          let seg = 0;
          for (let k = 0; k < ax.keys.length - 1; k++) if (fr >= ax.keys[k].frame) seg = k;
          const a = ax.keys[seg], b = ax.keys[seg + 1] ?? a;
          const u = b.frame === a.frame ? 0 : (fr - a.frame) / (b.frame - a.frame);
          const e = u * u * (3 - 2 * u);
          s.push(a.position + (b.position - a.position) * e);
        }
        out[ax.kind] = s;
      }
      return out;
    }, kfRun: async () => { pct = 0; }, kfStop: async () => {},
    kfProgress: async () => ({ state: pct < 100 ? 1 : 0, percent: (pct = Math.min(100, pct + 20)) }),
    gotoKfStart: async () => {},
    camArm: async () => {}, camFire: async () => {}, camDisable: async () => {},
    saveFilm: async () => null, loadFilm: async () => null, stopAll: async () => { speeds.fill(0); },
    lensStatus: async () => ({
      connected: false, reason: null, axes: 0, describe: null,
      motors: { focus: { steps: 0, maxStepsPerSec: 3000, invert: false },
                iris:  { steps: 0, maxStepsPerSec: 2000, invert: false },
                zoom:  { steps: 0, maxStepsPerSec: 2000, invert: false } },
    }),
    lensSetMotor: async (_k, patch) => patch,
    lensCalibrate: async () => { throw new Error("browser preview — no lens device"); },
    lensSeek: async () => true,
    lensCheck: async (f) => ({
      lanes: (f.lensAxes ?? []).map((a) => a.kind), connected: false, points: 0,
      densePoints: 0, uploadSeconds: 0, toleranceUnits: 32, infeasible: [],
    }),
    lensUpload: async () => ({ points: 0, axes: [] }),
    lensLibrary: async () => [],
    lensLibrarySave: async (e) => ({ ...e, id: e.id || "preview-1" }),
    lensLibraryDelete: async () => 0,
    lensLibraryExport: async () => null,
    lensLibraryImport: async () => null,
    commissionState: async () => ({
      spans: { slide: [{ steps: 80000, measured: 500, note: "steel rule" }, { steps: 64000, measured: 400 }], pan: [], tilt: [] },
      marked: { slide: null, pan: null, tilt: null },
      passes: [0, 0.02, -0.03, 0.01, -0.01], thresholdMm: 0.1,
      fits: {
        slide: { perUnit: 160, n: 2, spreadPct: 0, worst: null, warnings: [], unit: "mm", stored: 100, diagnosis: "+60.0% against the stored value — something mechanical changed, or one of the two was measured badly" },
        pan: { perUnit: 0, n: 0, spreadPct: 0, worst: null, warnings: ["no usable measurements yet"], unit: "deg", stored: 100, diagnosis: null },
        tilt: { perUnit: 0, n: 0, spreadPct: 0, worst: null, warnings: ["no usable measurements yet"], unit: "deg", stored: 100, diagnosis: null },
      },
      repeatability: { n: 5, meanMm: 0, maxAbsMm: 0.03, spreadMm: 0.05, pass: true, verdict: "pass — worst 0.03 mm, spread 0.05 mm over 5 passes" },
      calibration: { slideStepsPerMm: 100, panStepsPerDeg: 100, tiltStepsPerDeg: 100, nodalOffsetMm: 0, headHeightMm: 0 },
    }),
    commissionMark: async () => 0,
    commissionSpan: async () => { throw new Error("browser preview — no rig"); },
    commissionDropSpan: async () => ({ perUnit: 0, n: 0, warnings: [] }),
    commissionApply: async () => ({ applied: [], skipped: [] }),
    commissionPass: async () => ({ passes: [], result: { verdict: "browser preview" } }),
    commissionSet: async (p) => p,
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
    triggerBackends: async () => [{ id: "simulated", tier: 1, outputs: 8, describe: "Simulated trigger device — 8 outputs, tier 1" }],
    triggerConnect: async () => ({ name: "sim-trig", protocol: 1, outputs: 8, inputs: 2, tier: 2 }),
    triggerDisconnect: async () => {},
    getBindings: async () => [{ target: "cue-light", backendId: "simulated", output: 1 }],
    setBindings: async (b) => b,
    cueCheck: async (f) => ({ total: (f.events ?? []).length, unroutable: [], tier: 1, device: null }),
    cuesArm: async (f) => ({ tier: 1, armed: (f.events ?? []).length, hostScheduled: (f.events ?? []).length }),
    cuesStart: async () => ({ running: true }),
    cuesStop: async () => ({ fired: 0, worstJitterMs: 0, dispatched: [] }),
    cueTest: async () => {},
    dmxConnect: async () => ({ id: "dmx", tier: 1, outputs: 512, describe: "Enttec DMX USB Pro — 512 channels, tier 1 (host-timed)" }),
    dmxDisconnect: async () => {},
    oscConnect: async (c) => ({ id: "osc", tier: 1, outputs: 512, describe: `OSC → ${c?.host ?? "127.0.0.1"}:${c?.port ?? 9000}, tier 1 (host-timed)` }),
    oscDisconnect: async () => {},
    onCueFired: () => {}, onCueProblem: () => {}, onTriggerInput: () => {},
  };
}

/* ------------------------------------------------------------------ */

const css = getComputedStyle(document.documentElement);
const AXES = [
  { name: "Slide", motor: 1, axis: 0, color: css.getPropertyValue("--slide").trim() },
  { name: "Pan",   motor: 2, axis: 1, color: css.getPropertyValue("--pan").trim() },
  { name: "Tilt",  motor: 3, axis: 2, color: css.getPropertyValue("--tilt").trim() },
];
/**
 * Lens axes reuse categorical slots 1–3 rather than taking slots 4–6.
 *
 * Six simultaneous series FAILED the palette validator on all-pairs: magenta↔
 * aqua came out at ΔE 1.6 under deuteranopia (indistinguishable), and yellow↔
 * orange at 10.6 for normal vision. The skill's own guidance for that failure
 * is to facet rather than invent hues, and faceting is the better UI anyway —
 * you compare slide against pan, or focus against iris, never tilt against
 * zoom. So: two labelled, banded groups of three, each carrying the validated
 * three-slot palette that passes all-pairs. Identity comes from the group band
 * and the direct label, never from colour alone.
 */
const LENS_AXES = [
  { name: "Focus", kind: "focus", color: css.getPropertyValue("--slide").trim() },
  { name: "Iris",  kind: "iris",  color: css.getPropertyValue("--pan").trim() },
  { name: "Zoom",  kind: "zoom",  color: css.getPropertyValue("--tilt").trim() },
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
/** Per-frame lens travel, keyed by axis kind. Solved in main, like the motion. */
let lensCache = null;
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
    try {
      const p = String(await window.nmx.position(a.motor));
      $("pos" + a.motor).textContent = p;
      /* The rig panel's rows are rebuilt on every render, so look them up each
         tick rather than caching a node that may no longer be in the document. */
      const rp = document.getElementById("rigPos" + a.motor);
      if (rp) rp.textContent = p;
    } catch { /* transient */ }
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
const RULER = 20, PAD_L = 40, PAD_R = 12, CUE_LANE = 22;

/** The cue lane sits directly under the ruler: cues are timeline events, and
    putting them above the axes says they belong to the move, not to an axis. */
const cueRect = () => ({ x: PAD_L, y: RULER, w: cv.clientWidth - PAD_L - PAD_R, h: CUE_LANE });
const tracksTop = () => RULER + CUE_LANE;
const GROUP_HEAD = 15;   // the banded label strip above each group's tracks

/** Lens tracks only take space when the move actually has lens axes. */
const lensAxesOf = () => film.lensAxes ?? [];
const hasLens = () => lensAxesOf().length > 0;

/** Total rows across both groups, used to split the remaining height. */
const rowCount = () => 3 + lensAxesOf().length;
const rowHeight = () => {
  const heads = hasLens() ? GROUP_HEAD * 2 : 0;
  return (cv.clientHeight - tracksTop() - heads) / rowCount();
};
const motionTop = () => tracksTop() + (hasLens() ? GROUP_HEAD : 0);
const lensTop = () => motionTop() + rowHeight() * 3 + GROUP_HEAD;

const trackRect = (i) => {
  const h = rowHeight();
  return { x: PAD_L, y: motionTop() + i * h + 6, w: cv.clientWidth - PAD_L - PAD_R, h: h - 12 };
};
const lensRect = (i) => {
  const h = rowHeight();
  return { x: PAD_L, y: lensTop() + i * h + 6, w: cv.clientWidth - PAD_L - PAD_R, h: h - 12 };
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
    ctx.fillStyle = "#1b1f23"; ctx.fillRect(x, tracksTop(), 1, h - tracksTop()); ctx.fillStyle = INK_FAINT;
  }

  /* cue lane (ADR-0016) */
  {
    const r = cueRect();
    ctx.fillStyle = "#15181b"; ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeStyle = LINE; ctx.beginPath();
    ctx.moveTo(r.x, r.y + r.h + .5); ctx.lineTo(r.x + r.w, r.y + r.h + .5); ctx.stroke();
    ctx.save(); ctx.translate(13, r.y + r.h / 2); ctx.rotate(-Math.PI / 2);
    ctx.textAlign = "center"; ctx.fillStyle = INK_FAINT; ctx.font = "600 9px system-ui";
    ctx.fillText("CUES", 0, 0); ctx.restore(); ctx.textAlign = "left";

    ctx.save(); ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.clip();
    for (const ev of film.events ?? []) {
      if (ev.frame < view.f0 - 8 || ev.frame > view.f1 + 8) continue;
      const x = fToX(ev.frame, r);
      const sel = selection?.kind === "cue" && selection.id === ev.id;
      /* Sustained cues get a bar so "light on for 12 frames" reads as duration
         rather than as an instant. */
      if (ev.durationFrames) {
        const x2 = fToX(ev.frame + ev.durationFrames, r);
        ctx.fillStyle = "rgba(201,133,0,.28)";
        ctx.fillRect(x, r.y + 5, Math.max(2, x2 - x), r.h - 10);
      }
      ctx.fillStyle = sel ? "#ffffff" : "#c98500";
      ctx.beginPath();
      ctx.moveTo(x, r.y + 4); ctx.lineTo(x + 4, r.y + 9);
      ctx.lineTo(x + 4, r.y + r.h - 4); ctx.lineTo(x - 4, r.y + r.h - 4);
      ctx.lineTo(x - 4, r.y + 9); ctx.closePath(); ctx.fill();
      const label = ev.label || ev.target;
      if (label) {
        ctx.fillStyle = sel ? INK : INK_FAINT;
        ctx.font = "9px ui-monospace, Menlo, monospace";
        ctx.fillText(label, x + 7, r.y + r.h / 2);
      }
    }
    ctx.restore();
  }

  /* group bands — the faceting that lets both groups reuse slots 1-3 */
  const band = (y, label) => {
    const w = cv.clientWidth - PAD_L - PAD_R;
    ctx.fillStyle = "#171a1e"; ctx.fillRect(0, y, cv.clientWidth, GROUP_HEAD);
    ctx.fillStyle = LINE; ctx.fillRect(0, y + GROUP_HEAD - 1, cv.clientWidth, 1);
    ctx.fillStyle = INK_FAINT; ctx.font = "600 9px system-ui";
    ctx.fillText(label, PAD_L, y + GROUP_HEAD / 2 + 1);
    return w;
  };
  if (hasLens()) {
    band(tracksTop(), "MOTION — SLIDE · PAN · TILT");
    /* Say what is actually true right now. Once a v2 board is connected the
       lanes DO drive, and a permanent "authoring only" label would then be the
       app lying in the other direction. */
    band(
      lensTop() - GROUP_HEAD,
      "LENS — " + lensAxesOf().map((a) => a.kind.toUpperCase()).join(" · ") +
        (lensDriven ? "   (driven on device)" : "   (authoring + export only — no lens device)"),
    );
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
      const sel = selection?.kind === "key" && selection.track === i && selection.k === k;
      const R = sel ? 6 : 4.5;
      ctx.beginPath();
      ctx.moveTo(x, y - R); ctx.lineTo(x + R, y); ctx.lineTo(x, y + R); ctx.lineTo(x - R, y); ctx.closePath();
      ctx.fillStyle = a.color; ctx.fill();
      ctx.strokeStyle = sel ? "#ffffff" : "#0e1013"; ctx.lineWidth = sel ? 1.6 : 1; ctx.stroke(); ctx.lineWidth = 1;
    });
  });

  /* lens tracks (ADR-0017) — normalised barrel travel, fixed 0..1 scale so a
     focus pull's shape is comparable between takes rather than auto-rescaled */
  lensAxesOf().forEach((ax, i) => {
    const def = LENS_AXES.find((d) => d.kind === ax.kind) ?? LENS_AXES[0];
    const r = lensRect(i);
    ctx.strokeStyle = LINE; ctx.lineWidth = 1;
    ctx.strokeRect(r.x + .5, r.y + .5, r.w - 1, r.h - 1);
    const y01 = (v) => r.y + r.h - v * r.h;

    /* quarter guides: a lens has no natural zero, so the grid is the barrel */
    ctx.strokeStyle = "#1b1f23";
    for (const q of [0.25, 0.5, 0.75]) {
      ctx.beginPath(); ctx.moveTo(r.x, y01(q)); ctx.lineTo(r.x + r.w, y01(q)); ctx.stroke();
    }

    ctx.save(); ctx.translate(13, r.y + r.h / 2); ctx.rotate(-Math.PI / 2);
    ctx.textAlign = "center"; ctx.fillStyle = def.color; ctx.font = "600 10px system-ui";
    ctx.fillText(def.name.toUpperCase(), 0, 0); ctx.restore(); ctx.textAlign = "left";

    /* End-of-travel labels. The motion tracks auto-scale, so a number on them
       would be meaningless; a lens track's scale is FIXED and load-bearing —
       without these two labels the operator cannot tell which end of the lane
       is infinity and which is the close stop, and a focus lane you can misread
       is worse than no focus lane. Drawn before the curve so the curve wins any
       overlap. Reads real units through the map, percent without one. */
    ctx.fillStyle = INK_FAINT; ctx.font = "8px ui-monospace, Menlo, monospace";
    ctx.fillText(lensEndLabel(ax, 1), r.x + 4, r.y + 9);
    ctx.fillText(lensEndLabel(ax, 0), r.x + 4, r.y + r.h - 4);

    const samples = lensCache?.[ax.kind];
    if (samples) {
      ctx.save(); ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.clip();
      ctx.strokeStyle = def.color; ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.beginPath();
      let started = false;
      for (let f = Math.max(0, Math.floor(view.f0)); f <= Math.min(film.durationFrames, Math.ceil(view.f1)); f++) {
        const x = fToX(f, r), y = y01(samples[f] ?? 0);
        started ? ctx.lineTo(x, y) : (ctx.moveTo(x, y), started = true);
      }
      ctx.stroke(); ctx.restore(); ctx.lineWidth = 1;
    }

    ax.keys.forEach((k, ki) => {
      if (k.frame < view.f0 - 8 || k.frame > view.f1 + 8) return;
      const x = fToX(k.frame, r), y = y01(k.position);
      const sel = selection?.kind === "lens" && selection.axis === ax.kind && selection.k === ki;
      const R = sel ? 6 : 4.5;
      ctx.beginPath();
      ctx.moveTo(x, y - R); ctx.lineTo(x + R, y); ctx.lineTo(x, y + R); ctx.lineTo(x - R, y); ctx.closePath();
      ctx.fillStyle = def.color; ctx.fill();
      ctx.strokeStyle = sel ? "#ffffff" : "#0e1013"; ctx.lineWidth = sel ? 1.6 : 1; ctx.stroke(); ctx.lineWidth = 1;
    });

    /* Live value AT the playhead, drawn AT the playhead.
       It used to be pinned to the track's top-right corner, where it read like
       a scale label rather than a scrub readout and collided with any key on
       the last frame. A focus puller reads this against the picture, so it has
       to sit on the line it describes. Flips side near the right edge. */
    if (samples) {
      const pf = Math.max(0, Math.min(film.durationFrames, Math.round(playheadFrame)));
      const px = fToX(pf, r);
      if (px >= r.x - 1 && px <= r.x + r.w + 1) {
        const text = formatLens(ax, samples[pf] ?? 0);
        ctx.font = "9px ui-monospace, Menlo, monospace";
        const tw = ctx.measureText(text).width;
        const flip = px + 8 + tw + 4 > r.x + r.w;
        const bx = flip ? px - 8 - tw - 4 : px + 8;
        const by = Math.max(r.y + 2, Math.min(r.y + r.h - 15, y01(samples[pf] ?? 0) - 7));
        ctx.fillStyle = "rgba(14,16,19,.82)";
        ctx.fillRect(bx, by, tw + 6, 13);
        ctx.fillStyle = def.color;
        ctx.fillText(text, bx + 3, by + 9.5);
      }
    }
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
/** A cue marker under the pointer, if any. */
function hitCue(mx, my) {
  const r = cueRect();
  if (my < r.y || my > r.y + r.h) return null;
  for (const ev of film.events ?? []) {
    if (Math.abs(fToX(ev.frame, r) - mx) < 7) return ev;
  }
  return null;
}

/** A lens key under the pointer, if any. */
function hitLens(mx, my) {
  const axes = lensAxesOf();
  for (let i = 0; i < axes.length; i++) {
    const r = lensRect(i), ax = axes[i];
    if (my < r.y || my > r.y + r.h) continue;
    for (let k = 0; k < ax.keys.length; k++) {
      const x = fToX(ax.keys[k].frame, r), y = r.y + r.h - ax.keys[k].position * r.h;
      if ((mx - x) ** 2 + (my - y) ** 2 < 90) return { axis: ax.kind, k, r, i };
    }
    return { axis: ax.kind, k: -1, r, i };      // in the lane, but not on a key
  }
  return null;
}

cv.addEventListener("pointerdown", (e) => {
  const b = cv.getBoundingClientRect(), mx = e.clientX - b.left, my = e.clientY - b.top;
  cv.setPointerCapture(e.pointerId);
  if (e.button === 1) { drag = { type: "pan", x: mx }; return; }
  if (my <= RULER) { drag = { type: "ph" }; movePlayhead(mx); return; }
  const cueR = cueRect();
  if (my >= cueR.y && my <= cueR.y + cueR.h) {
    const ev = hitCue(mx, my);
    if (ev) { snapshot(); selection = { kind: "cue", id: ev.id }; drag = { type: "cue", id: ev.id }; }
    else selection = null;
    updateInspector(); render();
    return;
  }
  const lh = hitLens(mx, my);
  if (lh) {
    if (lh.k >= 0) { snapshot(); selection = { kind: "lens", axis: lh.axis, k: lh.k }; drag = { type: "lens", ...lh }; }
    else selection = null;
    updateInspector(); render();
    return;
  }
  const h = hit(mx, my);
  if (h) { snapshot(); selection = { kind: "key", track: h.track, k: h.k }; drag = { type: "kf", ...h }; }
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
  if (drag.type === "lens") {
    const ax = lensAxesOf().find((a) => a.kind === drag.axis);
    if (ax) {
      const key = ax.keys[drag.k], r = drag.r;
      key.position = Math.max(0, Math.min(1, (r.y + r.h - my) / r.h));
      if (drag.k > 0 && drag.k < ax.keys.length - 1) {
        const lo = ax.keys[drag.k - 1].frame + MIN_GAP, hi = ax.keys[drag.k + 1].frame - MIN_GAP;
        key.frame = Math.max(lo, Math.min(hi, xToFrame(mx, r)));
      }
      updateInspector(); refreshLens();
    }
    return;
  }
  if (drag.type === "cue") {
    const ev = (film.events ?? []).find((x) => x.id === drag.id);
    if (ev) {
      const f = Math.max(0, Math.min(film.durationFrames - (ev.durationFrames ?? 0), xToFrame(mx, cueRect())));
      ev.frame = f; updateInspector(); render();
    }
    return;
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
  const b = cv.getBoundingClientRect(), mx = e.clientX - b.left, my = e.clientY - b.top;
  const ev = hitCue(mx, my);
  if (ev) return delCue(ev.id);
  const lh = hitLens(mx, my);
  if (lh) {
    const ax = lensAxesOf().find((a) => a.kind === lh.axis);
    if (!ax) return;
    if (lh.k > 0 && lh.k < ax.keys.length - 1) {      // endpoints stay
      snapshot(); ax.keys.splice(lh.k, 1); selection = null;
      updateInspector(); refreshLens(); return;
    }
    /* Double-click in empty lane space adds a key at the pointer. */
    if (lh.k < 0) {
      snapshot();
      const f = Math.max(0, Math.min(film.durationFrames, xToFrame(mx, lh.r)));
      const pos = Math.max(0, Math.min(1, (lh.r.y + lh.r.h - my) / lh.r.h));
      if (!ax.keys.some((k) => Math.abs(k.frame - f) < MIN_GAP)) {
        ax.keys.push({ frame: f, position: pos });
        ax.keys.sort((a, b) => a.frame - b.frame);
        refreshLens();
      }
      return;
    }
    return;
  }
  const h = hit(mx, my);
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
  if (selection?.kind === "cue") return updateCueInspector();
  if (selection?.kind === "lens") return updateLensInspector();
  $("cueFields").style.display = "none";
  $("lensFields").style.display = "none";
  const p = selection?.kind === "key" && film.axes[selection.track].points[selection.k];
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
$("kfTime").onchange = () => { if (selection?.kind === "key") setKeyFrameNumber(Number($("kfTime").value)); };
$("kfTc").onchange = () => {
  if (selection?.kind !== "key") return;
  try {
    /* Typed timecode is absolute (it includes the move's start TC), so subtract
       the start to get a frame offset within the move. */
    setKeyFrameNumber(TC.timecodeToFrames($("kfTc").value, film.timebase) - film.startFrame);
  } catch (err) { status(err.message); updateInspector(); }
};
$("kfPos").onchange = () => {
  if (selection?.kind !== "key") return;
  snapshot();
  film.axes[selection.track].points[selection.k].position = Math.round(Number($("kfPos").value));
  refreshPreview();
};
$("kfDelete").onclick = () => selection?.kind === "key" && delKey(selection.track, selection.k);

/* ---------------- lens axes (ADR-0017) ---------------- */

/** Real units where the lens is mapped, percent where it is not — never a fake distance. */
function formatLens(ax, position) {
  if (!ax.map) return `${Math.round(position * 100)}%`;
  const m = ax.map.marks;
  /* No flip. The lane IS barrel travel; which way the motor turns to get there
     is rig configuration and lives in the motor settings (ADR-0018). */
  const p = position;
  let v = m[m.length - 1].value;
  if (p <= m[0].position) v = m[0].value;
  else {
    for (let i = 0; i < m.length - 1; i++) {
      const a = m[i], b = m[i + 1];
      if (p >= a.position && p <= b.position) { v = a.value + (b.value - a.value) * ((p - a.position) / (b.position - a.position)); break; }
    }
  }
  if (ax.kind === "iris") return `T${v.toFixed(1)}`;
  if (ax.kind === "zoom") return `${Math.round(v)}mm`;
  return `${v < 10 ? v.toFixed(2) : v.toFixed(1)}m`;
}

/**
 * The label at a hard stop. Prefer what the AC actually wrote on the barrel —
 * "\u221e" is the truth at the far stop, and printing the map's numeric there
 * ("60.0m") claims a precision the engraving never had. Falls back to the
 * mapped number, then to percent, so an unmapped lane still reads honestly.
 */
function lensEndLabel(ax, end) {
  const m = ax.map?.marks;
  if (!m?.length) return formatLens(ax, end);
  const mk = (ax.invert ? 1 - end : end) === 0 ? m[0] : m[m.length - 1];
  return mk.label || formatLens(ax, end);
}

const selectedLens = () =>
  selection?.kind === "lens" ? lensAxesOf().find((a) => a.kind === selection.axis) : undefined;

function addLensAxis(kind) {
  snapshot();
  film.lensAxes = film.lensAxes ?? [];
  if (film.lensAxes.some((a) => a.kind === kind)) return status(`${kind} is already on the timeline.`);
  film.lensAxes.push({
    kind, target: kind,
    keys: [{ frame: 0, position: 0.5 }, { frame: film.durationFrames, position: 0.5 }],
  });
  film.lensAxes.sort((a, b) => LENS_AXES.findIndex((d) => d.kind === a.kind) - LENS_AXES.findIndex((d) => d.kind === b.kind));
  uploaded = false;
  refreshLens(); syncInputs(); refreshLensDriven();
  status(
    lensDriven
      ? `${kind} lane added — set its motor and calibrate in ⌾ Lens….`
      : `${kind} lane added — mark the lens in ⌾ Lens… to see real units. No lens device, so it will not be driven.`,
  );
}

function removeLensAxis(kind) {
  snapshot();
  film.lensAxes = lensAxesOf().filter((a) => a.kind !== kind);
  if (!film.lensAxes.length) delete film.lensAxes;
  selection = null;
  refreshLens(); updateInspector(); syncInputs(); render();
}

/** Whether a connected board can actually drive these lanes. Display only. */
let lensDriven = false;
async function refreshLensDriven() {
  try { lensDriven = Boolean((await window.nmx.lensStatus()).connected); }
  catch { lensDriven = false; }
  render();
}

let lensTimer = null;
function refreshLens() {
  clearTimeout(lensTimer);
  lensTimer = setTimeout(async () => {
    try { lensCache = await window.nmx.previewLens(film); }
    catch { lensCache = null; }
    render();
  }, 50);
}

function updateLensInspector() {
  const ax = selectedLens();
  const key = ax?.keys[selection.k];
  if (!ax || !key) { selection = null; $("lensFields").style.display = "none"; $("kfEmpty").style.display = ""; return; }
  $("kfEmpty").style.display = "none";
  $("kfFields").style.display = "none";
  $("cueFields").style.display = "none";
  $("lensFields").style.display = "flex";
  const end = selection.k === 0 || selection.k === ax.keys.length - 1;
  $("lensLabel").textContent = `${ax.kind} · key ${selection.k + 1}/${ax.keys.length}${end ? " (endpoint)" : ""}`;
  $("lensFrame").value = String(key.frame);
  $("lensTc").textContent = tcOf(key.frame);
  $("lensPct").value = String(Math.round(key.position * 100));
  $("lensValue").textContent = formatLens(ax, key.position);
  $("lensFrame").disabled = end;
  $("lensDelete").disabled = end;
}

$("lensFrame").onchange = () => {
  const ax = selectedLens(); if (!ax) return;
  const k = selection.k;
  if (k === 0 || k === ax.keys.length - 1) return;
  snapshot();
  ax.keys[k].frame = Math.max(ax.keys[k - 1].frame + MIN_GAP,
    Math.min(ax.keys[k + 1].frame - MIN_GAP, Math.round(Number($("lensFrame").value))));
  updateLensInspector(); refreshLens();
};
$("lensPct").onchange = () => {
  const ax = selectedLens(); if (!ax) return;
  snapshot();
  ax.keys[selection.k].position = Math.max(0, Math.min(1, Number($("lensPct").value) / 100));
  updateLensInspector(); refreshLens();
};
$("lensDelete").onclick = () => {
  const ax = selectedLens(); if (!ax) return;
  const k = selection.k;
  if (k === 0 || k === ax.keys.length - 1) return;
  snapshot(); ax.keys.splice(k, 1); selection = null;
  updateInspector(); refreshLens();
};

/* ---------------- lens marks modal ---------------- */

function renderLensMarks() {
  const ax = selectedLens() ?? lensAxesOf()[0];
  if (!ax) return;
  $("lensMapKind").textContent = ax.kind;
  $("lensMapName").value = ax.map?.name ?? "";
  refreshLensMotor(ax.kind);
  refreshLensLibrary(ax);
  const unit = ax.kind === "iris" ? "T" : ax.kind === "zoom" ? "mm" : "m";
  const marks = ax.map?.marks ?? [];
  $("lensMarkRows").innerHTML = marks.length
    ? marks.map((m, i) => `
      <div class="bind">
        <span class="tcread">${Math.round(m.position * 100)}% travel</span>
        <span class="tcread">${m.value}${unit}</span>
        <span class="tcread">${m.label ?? ""}</span>
        <span></span>
        <button data-markdel="${i}" title="Remove">✕</button>
      </div>`).join("")
    : `<div style="font-size:10.5px;color:var(--ink-faint)">No marks — the lane reads in percent.</div>`;
  $("lensMarkRows").querySelectorAll("[data-markdel]").forEach((el) => el.onclick = () => {
    snapshot();
    ax.map.marks.splice(+el.dataset.markdel, 1);
    if (ax.map.marks.length < 2) delete ax.map;   // fewer than 2 cannot interpolate
    renderLensMarks(); refreshLens(); updateInspector();
  });
}

$("lensMarks").onclick = () => { renderLensMarks(); $("lensModal").classList.add("open"); };

$("lensAddMark").onclick = () => {
  const ax = selectedLens() ?? lensAxesOf()[0];
  if (!ax) return;
  snapshot();
  ax.map = ax.map ?? { name: $("lensMapName").value.trim() || `${ax.kind} lens`, kind: ax.kind, marks: [] };
  const pos = Math.max(0, Math.min(1, Number($("lensNewPos").value) / 100));
  ax.map.marks = ax.map.marks.filter((m) => Math.abs(m.position - pos) > 1e-6);
  ax.map.marks.push({ position: pos, value: Number($("lensNewVal").value), ...( $("lensNewLabel").value.trim() ? { label: $("lensNewLabel").value.trim() } : {}) });
  ax.map.marks.sort((a, b) => a.position - b.position);
  $("lensNewLabel").value = "";
  renderLensMarks(); refreshLens(); updateInspector(); render();
};

$("lensMapName").onchange = () => { const ax = selectedLens() ?? lensAxesOf()[0]; if (ax?.map) { ax.map.name = $("lensMapName").value.trim(); } };
/* ------------------------------------------------------------------
   Rig commissioning (ADR-0020)

   The panel carries its OWN jog buttons. The procedure is jog-to-a-mark,
   walk away with a tape, come back and type — so a dialog that covered the
   rail's jog controls would make the thing it exists for impossible.
   ------------------------------------------------------------------ */

const RIG_AXES = [
  { key: "slide", name: "Slide", motor: 1, unit: "mm",  color: css.getPropertyValue("--slide").trim() },
  { key: "pan",   name: "Pan",   motor: 2, unit: "deg", color: css.getPropertyValue("--pan").trim() },
  { key: "tilt",  name: "Tilt",  motor: 3, unit: "deg", color: css.getPropertyValue("--tilt").trim() },
];
let rigState = null;
let rigAxis = "slide";
let rigUnitShown = null;

function rigJogWiring() {
  for (const b of document.querySelectorAll("#rigAxes .jogbtn")) {
    const m = +b.dataset.m, d = +b.dataset.d;
    const go = async (e) => {
      e.preventDefault(); if (!connected) return;
      const r = await window.nmx.jog(m, d * Number($("speed").value));
      if (r?.blocked) status(`⚠ ${AXES[m - 1].name} is at its soft limit.`);
    };
    const stop = async () => { if (connected) await window.nmx.jog(m, 0); renderRig(); };
    b.addEventListener("pointerdown", go);
    b.addEventListener("pointerup", stop);
    b.addEventListener("pointerleave", stop);
  }
}

async function refreshRig() {
  try { rigState = await window.nmx.commissionState(); }
  catch (e) { rigState = null; status("Rig state unavailable: " + e.message); }
  renderRig();
}

function renderRig() {
  if (!rigState) return;
  const sel = RIG_AXES.find((a) => a.key === rigAxis);
  $("rigUnit").textContent = sel.unit === "mm" ? "mm" : "degrees";
  /* Carry a sensible default across an axis change. "500 degrees" is nonsense
     left over from the slide, and a nonsense default is one an operator
     eventually records without reading. */
  if (rigUnitShown !== sel.unit) {
    rigUnitShown = sel.unit;
    $("rigMeasured").value = sel.unit === "mm" ? "500" : "90";
    $("rigNote").placeholder = sel.unit === "mm" ? "steel rule, 2nd read" : "inclinometer";
  }

  $("rigAxes").innerHTML = RIG_AXES.map((a) => {
    const marked = rigState.marked[a.key];
    const f = rigState.fits[a.key];
    const on = a.key === rigAxis;
    /* The live position matters here more than anywhere: the panel carries its
       own jog buttons so the whole procedure happens in one place, and jogging
       without seeing where you are is exactly the thing that made a separate
       dialog unusable in the first place. */
    return `
      <div class="bind" style="grid-template-columns:3px 12px 44px 26px 26px 82px 116px 1fr;${on ? "" : "opacity:.62"}">
        <span style="width:3px;height:16px;border-radius:2px;background:${on ? a.color : "transparent"}"></span>
        <span class="swatch" style="background:${a.color}"></span>
        <span class="nm" style="color:${on ? "var(--ink)" : "var(--ink-dim)"}">${a.name}</span>
        <button class="jogbtn" data-m="${a.motor}" data-d="-1">−</button>
        <button class="jogbtn" data-m="${a.motor}" data-d="1">+</button>
        <span class="tcread" id="rigPos${a.motor}" style="text-align:right">—</span>
        <button data-rigmark="${a.key}">${marked === null || marked === undefined ? "Mark start" : `Close from ${marked}`}</button>
        <span class="tcread">${f.n ? `${f.perUnit.toFixed(2)} ${a.unit === "mm" ? "st/mm" : "st/°"}` : "not measured"}</span>
      </div>`;
  }).join("");
  rigJogWiring();

  for (const el of $("rigAxes").querySelectorAll("[data-rigmark]")) {
    el.onclick = async () => {
      const key = el.dataset.rigmark;
      rigAxis = key; renderRig();
      const marked = rigState.marked[key];
      try {
        if (marked === null || marked === undefined) {
          const at = await window.nmx.commissionMark(key);
          status(`${key} marked at ${at} steps — now jog to the far mark and measure the distance.`);
        } else {
          await window.nmx.commissionSpan(key, Number($("rigMeasured").value), $("rigNote").value.trim());
          $("rigNote").value = "";
          status(`${key} span recorded.`);
        }
      } catch (e) { status("Rig: " + e.message); }
      await refreshRig();
    };
  }

  /* Spans for the SELECTED axis only — three tables of two rows each would be
     mostly empty space, and the operator is working one axis at a time. */
  const spans = rigState.spans[rigAxis] ?? [];
  /* Naming the axis is not decoration: this table shows ONE axis's spans and
     nothing else on screen says which, so without it two measurements look
     like they belong to whatever was clicked last. */
  $("rigSpansHead").textContent = `${sel.name} spans — steps · measured · derived`;
  $("rigSpans").innerHTML = spans.length
    ? spans.map((o, i) => `
      <div class="bind" style="grid-template-columns:1fr 1fr 1fr 26px">
        <span class="tcread">${o.steps} steps</span>
        <span class="tcread">${o.measured} ${sel.unit === "mm" ? "mm" : "°"}</span>
        <span class="tcread">${(Math.abs(o.steps / o.measured)).toFixed(2)}${o.note ? ` · ${o.note}` : ""}</span>
        <button data-rigdrop="${i}" title="Remove this measurement">✕</button>
      </div>`).join("")
    : `<div style="font-size:10.5px;color:var(--ink-faint)">No spans for ${rigAxis} yet.</div>`;
  for (const el of $("rigSpans").querySelectorAll("[data-rigdrop]")) {
    el.onclick = async () => { await window.nmx.commissionDropSpan(rigAxis, +el.dataset.rigdrop); await refreshRig(); };
  }

  const f = rigState.fits[rigAxis];
  const lines = [];
  if (f.n) {
    lines.push(`<b>${f.perUnit.toFixed(3)}</b> ${sel.unit === "mm" ? "steps/mm" : "steps/°"} from ${f.n} span${f.n === 1 ? "" : "s"}, spread ${f.spreadPct.toFixed(2)}%`);
    if (f.worst) lines.push(`outlier: ${f.worst.steps} steps / ${f.worst.measured}${sel.unit === "mm" ? "mm" : "°"}${f.worst.note ? ` (${f.worst.note})` : ""}`);
    if (f.diagnosis) lines.push(`⚠ ${f.diagnosis}`);
  }
  lines.push(...f.warnings.map((w) => `⚠ ${w}`));
  $("rigFit").innerHTML = lines.join("<br>");

  /* Wire the laser method for rotation. It existed in the core with tests and
     no way to reach it, which is the same failure as a test that asserts
     nothing: capability the app claims and does not offer. */
  const rotational = sel.unit === "deg";
  $("rigLaserRow").style.display = rotational ? "" : "none";
  if (rotational) refreshLaser();

  $("rigNodal").value = String(rigState.calibration.nodalOffsetMm ?? 0);
  $("rigHead").value = String(rigState.calibration.headHeightMm ?? 0);
  $("rigThreshold").value = String(rigState.thresholdMm);

  const rep = rigState.repeatability;
  $("rigPasses").innerHTML =
    (rigState.passes.length
      ? `${rigState.passes.map((v) => v.toFixed(2)).join(" · ")} mm<br>`
      : "") +
    `<span style="color:${rep.pass && rep.n >= 5 ? "var(--ok)" : rep.n ? "var(--warn)" : "var(--ink-faint)"}">${rep.verdict}</span>`;
}

/** atan, mirrored from the core for display only — the recorded value is the
    number that lands in the Measured field, and that is what gets fitted. */
function refreshLaser() {
  const off = Number($("rigLaserOffset").value), dist = Number($("rigLaserDist").value);
  const deg = dist === 0 ? 0 : (Math.atan(off / dist) * 180) / Math.PI;
  $("rigLaserDeg").textContent = `${deg.toFixed(2)}°`;
  const abs = Math.abs(deg);
  $("rigLaserWarn").textContent =
    abs > 25 ? "past where “start square to the wall” is safe — use an inclinometer"
    : abs < 5 ? "small angle — move further or stand the wall further away"
    : "";
}
$("rigLaserOffset").oninput = $("rigLaserDist").oninput = refreshLaser;
$("rigLaserUse").onclick = () => {
  refreshLaser();
  $("rigMeasured").value = $("rigLaserDeg").textContent.replace("°", "");
  if (!$("rigNote").value.trim()) $("rigNote").value = `laser ${$("rigLaserOffset").value}mm @ ${$("rigLaserDist").value}mm`;
  status("Angle filled in — now close the span on the axis you rotated.");
};

$("exMeasure").onclick = async () => { await refreshRig(); $("rigModal").classList.add("open"); };

/* The rig panel writes main's copy of the calibration; the export dialog holds
   its OWN copy in `exPrefs` and writes it back wholesale on any field change.
   Without this merge the next keystroke in the export dialog would quietly
   overwrite the numbers that were just measured. */
function adoptCalibration(calibration) {
  if (!calibration) return;
  exPrefs.calibration = { ...exPrefs.calibration, ...calibration };
  syncExportUi();
}

$("rigApply").onclick = async () => {
  try {
    const r = await window.nmx.commissionApply();
    adoptCalibration(r.calibration);
    await refreshRig();
    status(r.applied.length
      ? `Calibration updated — ${r.applied.join(", ")}${r.skipped.length ? `. Still unmeasured: ${r.skipped.join(", ")}.` : ""}`
      : "Nothing measured yet — mark a start, jog, and record a span first.");
  } catch (e) { status("Apply failed: " + e.message); }
};

$("rigNodal").onchange = $("rigHead").onchange = async () => {
  try {
    const r = await window.nmx.commissionSet({
      nodalOffsetMm: Number($("rigNodal").value), headHeightMm: Number($("rigHead").value),
    });
    adoptCalibration(r.calibration);
    await refreshRig();
  } catch (e) { status("Rig: " + e.message); }
};

$("rigThreshold").onchange = async () => {
  await window.nmx.commissionSet({ thresholdMm: Number($("rigThreshold").value) });
  await refreshRig();
};

$("rigAddPass").onclick = async () => {
  try {
    const r = await window.nmx.commissionPass(Number($("rigReading").value));
    await refreshRig();
    logPass(`repeatability pass ${r.passes.length}: ${Number($("rigReading").value).toFixed(2)} mm — ${r.result.verdict}`);
  } catch (e) { status("Rig: " + e.message); }
};

$("rigClearPasses").onclick = async () => { await window.nmx.commissionPass(null); await refreshRig(); };

/* ---- the lens library: marks belong to a LENS, not a move (ADR-0019) ---- */

let lensLib = [];
/** Which library entry the open dialog is showing, so "Keep" can update it. */
let lensLibCurrent = null;

async function refreshLensLibrary(ax) {
  try { lensLib = await window.nmx.lensLibrary(); }
  catch { lensLib = []; }
  /* Filtered to this axis: a focus map on an iris lane is not a mistake worth
     making possible. */
  const mine = lensLib.filter((e) => e.kind === ax.kind);
  const sel = $("lensLibPick");
  sel.innerHTML =
    `<option value="">${mine.length ? "— pick a saved lens —" : "— library empty —"}</option>` +
    mine.map((e) => `<option value="${e.id}">${e.name}${e.savedAt ? ` · ${e.savedAt.slice(0, 10)}` : ""}</option>`).join("");
  /* Keep the selection if the open map came from the library, so "Keep" reads
     as "update this lens" rather than "make a second copy of it". */
  const match = mine.find((e) => e.id === lensLibCurrent) ?? mine.find((e) => e.name === ax.map?.name);
  lensLibCurrent = match?.id ?? null;
  sel.value = lensLibCurrent ?? "";
  $("lensLibDelete").disabled = !lensLibCurrent;
  $("lensLibSave").textContent = lensLibCurrent ? "Update" : "Keep";
  $("lensLibSave").disabled = !ax.map || (ax.map.marks?.length ?? 0) < 2;
}

$("lensLibPick").onchange = () => {
  const ax = selectedLens() ?? lensAxesOf()[0];
  const entry = lensLib.find((e) => e.id === $("lensLibPick").value);
  if (!ax || !entry) { lensLibCurrent = null; return refreshLensLibrary(ax ?? lensAxesOf()[0]); }
  snapshot();                                   // applying a lens is undoable
  ax.map = { name: entry.name, kind: entry.kind, marks: entry.marks.map((m) => ({ ...m })),
             ...(entry.notes ? { notes: entry.notes } : {}) };
  lensLibCurrent = entry.id;
  renderLensMarks(); refreshLens(); updateInspector(); render();
  status(`${entry.name} applied to the ${ax.kind} lane — ${entry.marks.length} marks.`);
};

$("lensLibSave").onclick = async () => {
  const ax = selectedLens() ?? lensAxesOf()[0];
  if (!ax?.map) return status("Add at least two marks before keeping this lens.");
  const name = $("lensMapName").value.trim() || ax.map.name;
  try {
    const saved = await window.nmx.lensLibrarySave({
      id: lensLibCurrent ?? "", name, kind: ax.kind,
      marks: ax.map.marks.map((m) => ({ ...m })),
      ...(ax.map.notes ? { notes: ax.map.notes } : {}),
    });
    lensLibCurrent = saved.id;
    ax.map.name = saved.name;
    await refreshLensLibrary(ax);
    status(`“${saved.name}” kept — it is now on every move, not just this one.`);
  } catch (e) { status("Keep lens failed: " + e.message); }
};

$("lensLibDelete").onclick = async () => {
  if (!lensLibCurrent) return;
  const gone = lensLib.find((e) => e.id === lensLibCurrent)?.name ?? "lens";
  const ax = selectedLens() ?? lensAxesOf()[0];
  try {
    await window.nmx.lensLibraryDelete(lensLibCurrent);
    lensLibCurrent = null;
    await refreshLensLibrary(ax);
    /* The lane keeps its marks. Removing a lens from the library must not
       silently unmark a move that is already using it. */
    status(`“${gone}” removed from the library — the ${ax.kind} lane keeps its marks.`);
  } catch (e) { status("Delete failed: " + e.message); }
};

$("lensLibExport").onclick = async () => {
  try {
    const r = await window.nmx.lensLibraryExport();
    if (r) status(`Exported ${r.count} lens${r.count === 1 ? "" : "es"} to ${r.path.replace(/^.*\//, "")}.`);
  } catch (e) { status("Export failed: " + e.message); }
};

$("lensLibImport").onclick = async () => {
  const ax = selectedLens() ?? lensAxesOf()[0];
  try {
    const r = await window.nmx.lensLibraryImport();
    if (!r) return;
    await refreshLensLibrary(ax);
    const bits = [];
    if (r.added.length) bits.push(`${r.added.length} added`);
    if (r.updated.length) bits.push(`${r.updated.length} updated`);
    if (r.rejected.length) bits.push(`${r.rejected.length} rejected (${r.rejected[0].name}: ${r.rejected[0].reason})`);
    status(`Library merged — ${bits.join(", ") || "nothing new"}; ${r.total} lenses held.`);
  } catch (e) { status("Import failed: " + e.message); }
};

/* ---- motor settings: rig config, saved outside the move (ADR-0018) ---- */

let lensDev = null;
async function refreshLensMotor(kind) {
  try { lensDev = await window.nmx.lensStatus(); }
  catch { lensDev = null; }
  const m = lensDev?.motors?.[kind] ?? { steps: 0, maxStepsPerSec: 3000, invert: false };
  const live = Boolean(lensDev?.connected);
  /* Short form on purpose: the full describe() string wrapped the Calibrate
     button onto its own line, where it read as unrelated to the device. */
  $("lensDevChip").textContent = live
    ? `${lensDev.describe.split(" ")[0]} · ${lensDev.axes} lens axes`
    : lensDev?.reason ?? "no lens device";
  $("lensDevChip").classList.toggle("dim", !live);
  /* Travel is shown as remembered-vs-measured, because they are not the same
     claim: only the board knows whether it has seen a stop since power-up. */
  $("lensTravel").textContent = m.steps ? `travel ${m.steps} steps (remembered)` : "travel — not calibrated";
  $("lensMaxSps").value = String(m.maxStepsPerSec);
  $("lensInvert").checked = Boolean(m.invert);
  $("lensCalibrate").disabled = !live;
  $("lensJog").disabled = !live || !m.steps;
  $("lensJogRead").textContent = live && m.steps ? "drag to drive the barrel" : "jog needs a calibrated device";
}

const motorKind = () => selectedLens()?.kind ?? "focus";

$("lensMaxSps").onchange = async () => {
  const v = Math.max(100, Math.round(Number($("lensMaxSps").value) || 3000));
  try { await window.nmx.lensSetMotor(motorKind(), { maxStepsPerSec: v }); }
  catch (e) { status("Motor setting failed: " + e.message); }
  refreshLensMotor(motorKind());
};

$("lensCalibrate").onclick = async () => {
  const kind = motorKind();
  $("lensCalibrate").disabled = true;
  $("lensTravel").textContent = "calibrating — driving to both stops…";
  try {
    const r = await window.nmx.lensCalibrate(kind);
    status(`${kind} calibrated: ${r.steps} steps of barrel travel.`);
    logPass(`${kind} calibrated — ${r.steps} steps`);
  } catch (e) {
    status(`${kind} calibration failed: ${e.message}`);
  }
  refreshLensMotor(kind);
};

/* Jogging a barrel by hand is how a lens gets marked: drive to a witness mark,
   read the travel, write it down. Fire-and-forget so a dragged slider stays
   responsive — the device clamps at its own stops regardless. */
$("lensJog").oninput = () => {
  const ax = selectedLens();
  const kind = ax?.kind ?? "focus";
  const pos = Number($("lensJog").value) / 100;
  window.nmx.lensSeek(kind, pos).catch(() => {});
  $("lensNewPos").value = String(Math.round(pos * 100));
  /* Show BOTH: the travel the mark will record, and what the existing map
     thinks it reads there — which is how you notice a map that has drifted. */
  $("lensJogRead").textContent =
    `${Math.round(pos * 100)}% travel` + (ax?.map ? ` \u00b7 map says ${formatLens(ax, pos)}` : "");
};

$("lensInvert").onchange = () => {
  const ax = selectedLens() ?? lensAxesOf()[0]; if (!ax) return;
  snapshot(); ax.invert = $("lensInvert").checked; refreshLens(); updateInspector(); render();
};
$("lensRemoveAxis").onclick = () => {
  const ax = selectedLens() ?? lensAxesOf()[0]; if (!ax) return;
  removeLensAxis(ax.kind);
  $("lensModal").classList.remove("open");
};

$("lensAdd").onchange = () => {
  const kind = $("lensAdd").value;
  $("lensAdd").value = "";
  if (kind) addLensAxis(kind);
};

/* ---------------- cues (ADR-0016) ---------------- */

/**
 * Pre-flight the cue list and arm it. Returns false to abort the pass — a cue
 * that cannot be delivered is found BEFORE the performer is in position, not
 * discovered afterwards from a log.
 */
/**
 * One gate for the whole pass: cues AND lens. Two gates would be two chances to
 * skip one, and both failures cost the same thing — a take.
 */
async function armCuesForPass() {
  const cues = (film.events ?? []).length;
  const lanes = lensAxesOf().length;
  if (!cues && !lanes) return true;
  try {
    const check = await window.nmx.cueCheck(film);
    if (check.unroutable?.length) {
      const first = check.unroutable[0];
      status(`Cue “${first.id}” cannot fire — ${first.reason}. ${check.unroutable.length} of ${check.total} unroutable; open ⚡ Cues…`);
      return false;
    }
    if (check.lensProblems?.length) {
      const first = check.lensProblems[0];
      status(`Lens: ${first.reason}. Open ⌾ Lens… — ${check.lensProblems.length} lane(s) cannot run.`);
      return false;
    }
    const armed = await window.nmx.cuesArm(film);
    if (cues) {
      logPass(armed.tier === 2
        ? `${armed.armed} cues armed on device (tier 2)`
        : `${armed.armed} cues host-scheduled (tier 1 — ±20 ms, not repeatable)`);
    }
    if (lanes) {
      logPass(armed.lensPoints
        ? `${lanes} lens lane(s) armed on device — ${armed.lensPoints} points (tier 2)`
        : `${lanes} lens lane(s) NOT driven — no lens device; pull by hand`);
    }
    return true;
  } catch (e) {
    status("Arm failed: " + e.message);
    return false;
  }
}

let cueSeq = 0;
const newCueId = () => `cue-${++cueSeq}-${film.durationFrames}`;
const selectedCue = () =>
  selection?.kind === "cue" ? (film.events ?? []).find((e) => e.id === selection.id) : undefined;

function addCue(frame = playheadFrame) {
  snapshot();
  film.events = film.events ?? [];
  const ev = {
    id: newCueId(),
    frame: Math.max(0, Math.min(film.durationFrames, Math.round(frame))),
    target: film.events.length ? film.events[film.events.length - 1].target : "cue-light",
    action: { kind: "pulse", ms: 40 },
  };
  film.events.push(ev);
  film.events.sort((a, b) => a.frame - b.frame);
  selection = { kind: "cue", id: ev.id };
  updateInspector(); render();
  status(`Cue at ${tcOf(ev.frame)} → “${ev.target}”.`);
}

function delCue(id) {
  snapshot();
  film.events = (film.events ?? []).filter((e) => e.id !== id);
  selection = null; updateInspector(); render();
}

/** Build the action object from the three action controls. */
function actionFromUi() {
  const kind = $("cueKind").value;
  const a = Number($("cueArgA").value) || 0, b = Number($("cueArgB").value) || 0;
  if (kind === "pulse") return { kind: "pulse", ms: Math.max(1, a || 40) };
  if (kind === "level") return { kind: "level", value: Math.max(0, Math.min(1, a / 100)) };
  if (kind === "dmx") return { kind: "dmx", channel: Math.max(1, Math.min(512, a || 1)), value: Math.max(0, Math.min(255, b)) };
  return { kind: "camera" };
}

function updateCueInspector() {
  const ev = selectedCue();
  if (!ev) { selection = null; $("cueFields").style.display = "none"; $("kfEmpty").style.display = ""; return; }
  $("kfEmpty").style.display = "none";
  $("kfFields").style.display = "none";
  $("cueFields").style.display = "flex";
  $("cueLabel").textContent = `Cue · ${ev.action.kind}`;
  $("cueFrame").value = String(ev.frame);
  $("cueTc").textContent = tcOf(ev.frame);
  $("cueTarget").value = ev.target;
  $("cueKind").value = ev.action.kind;
  const A = $("cueArgA"), B = $("cueArgB");
  if (ev.action.kind === "pulse") { A.style.display = ""; B.style.display = "none"; A.value = String(ev.action.ms ?? 40); A.title = "pulse width, ms"; }
  else if (ev.action.kind === "level") { A.style.display = ""; B.style.display = "none"; A.value = String(Math.round((ev.action.value ?? 0) * 100)); A.title = "level, %"; }
  else if (ev.action.kind === "dmx") { A.style.display = ""; B.style.display = ""; A.value = String(ev.action.channel ?? 1); B.value = String(ev.action.value ?? 0); A.title = "DMX channel"; B.title = "DMX value 0-255"; }
  else { A.style.display = "none"; B.style.display = "none"; }
}

$("cueAdd").onclick = () => addCue();
$("cueFrame").onchange = () => {
  const ev = selectedCue(); if (!ev) return;
  snapshot();
  ev.frame = Math.max(0, Math.min(film.durationFrames, Math.round(Number($("cueFrame").value))));
  film.events.sort((a, b) => a.frame - b.frame);
  updateCueInspector(); render();
};
$("cueTarget").onchange = () => {
  const ev = selectedCue(); if (!ev) return;
  snapshot(); ev.target = $("cueTarget").value.trim() || "cue-light"; render();
};
$("cueKind").onchange = () => {
  const ev = selectedCue(); if (!ev) return;
  snapshot();
  ev.action = $("cueKind").value === "pulse" ? { kind: "pulse", ms: 40 }
    : $("cueKind").value === "level" ? { kind: "level", value: 1 }
    : $("cueKind").value === "dmx" ? { kind: "dmx", channel: 1, value: 255 }
    : { kind: "camera" };
  updateCueInspector(); render();
};
for (const id of ["cueArgA", "cueArgB"]) {
  $(id).onchange = () => { const ev = selectedCue(); if (!ev) return; snapshot(); ev.action = actionFromUi(); updateCueInspector(); };
}
$("cueDelete").onclick = () => { const ev = selectedCue(); if (ev) delCue(ev.id); };
$("cueTest").onclick = async () => {
  const ev = selectedCue(); if (!ev) return;
  try { await window.nmx.cueTest(ev.target, ev.action); status(`Fired “${ev.target}” once.`); }
  catch (e) { status("Test failed: " + e.message); }
};

/**
 * What the cues actually delivered, logged after every pass.
 *
 * Tier 1's caveat is "±20 ms and not repeatable". Printing the pass's own worst
 * case turns that from a claim into a number the operator can watch drift —
 * and if it ever reads 80 ms on the take that mattered, they will know why the
 * composite is off instead of guessing.
 */
async function reportCueDelivery() {
  try {
    const r = await window.nmx.cuesStop();
    if (!r || !r.fired) return;
    logPass(`${r.fired} cues fired · worst lateness ${r.worstJitterMs} ms (host-timed)`);
    const late = (r.dispatched ?? []).filter((d) => d.firedAtMs - d.atMs > 40);
    for (const d of late) logPass(`  late: ${d.id} → ${d.target} by ${d.firedAtMs - d.atMs} ms`);
  } catch { /* nothing armed */ }
}

/* ---------------- trigger device + bindings ---------------- */

let bindings = [];
/** Every backend the app can route a cue to. `simulated` is always present. */
const BACKEND_IDS = ["simulated", "serial", "dmx", "osc"];

function renderBindings() {
  $("cueBindings").innerHTML = bindings.map((b, i) => `
    <div class="bind">
      <input data-bt="${i}" type="text" value="${b.target}" spellcheck="false" />
      <select data-bb="${i}">
        ${BACKEND_IDS.map((id) => `<option value="${id}"${b.backendId === id ? " selected" : ""}>${id}</option>`).join("")}
      </select>
      <input data-bo="${i}" type="number" min="1" max="512" value="${b.output}" class="num" style="width:56px" />
      <button data-btest="${i}" title="Fire this output now">▶</button>
      <button data-bdel="${i}" title="Remove">✕</button>
    </div>`).join("") || `<div style="font-size:10.5px;color:var(--ink-faint)">No targets bound yet.</div>`;

  const commit = () => window.nmx.setBindings(bindings);
  $("cueBindings").querySelectorAll("[data-bt]").forEach((el) => el.onchange = () => { bindings[+el.dataset.bt].target = el.value.trim(); commit(); render(); });
  $("cueBindings").querySelectorAll("[data-bb]").forEach((el) => el.onchange = () => { bindings[+el.dataset.bb].backendId = el.value; commit(); });
  $("cueBindings").querySelectorAll("[data-bo]").forEach((el) => el.onchange = () => { bindings[+el.dataset.bo].output = Number(el.value); commit(); });
  $("cueBindings").querySelectorAll("[data-bdel]").forEach((el) => el.onclick = () => { bindings.splice(+el.dataset.bdel, 1); commit(); renderBindings(); });
  $("cueBindings").querySelectorAll("[data-btest]").forEach((el) => el.onclick = async () => {
    const b = bindings[+el.dataset.btest];
    try { await window.nmx.cueTest(b.target, { kind: "pulse", ms: 120 }); status(`Pulsed “${b.target}”.`); }
    catch (e) { status("Test failed: " + e.message); }
  });
}

$("cueAddBinding").onclick = () => {
  const name = $("cueNewTarget").value.trim();
  if (!name) return;
  bindings.push({ target: name, backendId: "simulated", output: bindings.length + 1 });
  $("cueNewTarget").value = "";
  window.nmx.setBindings(bindings); renderBindings();
};

function setTier(tier, deviceLabel) {
  const chip = $("cueTierChip");
  chip.textContent = tier === 2 ? "tier 2 — device-scheduled" : "tier 1 — host-scheduled";
  chip.classList.toggle("tier2", tier === 2);
  $("cueDeviceLabel").textContent = deviceLabel ?? "no trigger device";
  $("cueDisconnect").disabled = tier !== 2;
}

async function refreshCuePorts() {
  const ports = await window.nmx.listPorts();
  const opts = ports.map((p) => `<option value="${p.path}">${p.path}${p.manufacturer ? " — " + p.manufacturer : ""}</option>`).join("");
  $("cuePort").innerHTML = opts;
  $("dmxPort").innerHTML = opts;
}
$("cuePortRefresh").onclick = refreshCuePorts;
$("cueCfg").onclick = async () => { await refreshCuePorts(); renderBindings(); $("cueModal").classList.add("open"); };
$("cueConnect").onclick = async () => {
  try {
    const info = await window.nmx.triggerConnect($("cuePort").value);
    setTier(info.tier, `${info.name} — ${info.outputs} out / ${info.inputs} in, protocol v${info.protocol}`);
    await refreshLensDriven();
    status(
      `Trigger device connected: ${info.name} (tier ${info.tier})` +
        (info.lensAxes ? `, ${info.lensAxes} lens axes.` : ". No lens axes — cues only."),
    );
  } catch (e) { status("Trigger connect failed: " + e.message); }
};
$("dmxConnect").onclick = async () => {
  try {
    const info = await window.nmx.dmxConnect($("dmxPort").value);
    $("dmxState").textContent = info.describe;
    $("dmxDisconnect").disabled = false;
    status("DMX connected — tier 1, host-timed.");
  } catch (e) { status("DMX connect failed: " + e.message); }
};
$("dmxDisconnect").onclick = async () => {
  await window.nmx.dmxDisconnect();
  $("dmxState").textContent = "not connected";
  $("dmxDisconnect").disabled = true;
  status("DMX disconnected — the universe was blacked out on the way.");
};

$("oscConnect").onclick = async () => {
  try {
    const cfg = { host: $("oscHost").value.trim(), port: Number($("oscPort").value), prefix: $("oscPrefix").value.trim() || "/graffik" };
    const info = await window.nmx.oscConnect(cfg);
    $("oscState").textContent = info.describe + " — nothing confirms delivery, so check the receiver";
    $("oscDisconnect").disabled = false;
    status("OSC enabled.");
  } catch (e) { status("OSC enable failed: " + e.message); }
};
$("oscDisconnect").onclick = async () => {
  await window.nmx.oscDisconnect();
  $("oscState").textContent = "not enabled";
  $("oscDisconnect").disabled = true;
  status("OSC off.");
};

$("cueDisconnect").onclick = async () => {
  await window.nmx.triggerDisconnect();
  setTier(1, null);
  await refreshLensDriven();
  status("Trigger device disconnected — cues fall back to host scheduling, lens lanes stop being driven.");
};

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
  /* Lens keys rescale with everything else — a focus pull is timed to the move,
     not to the wall clock, so stretching the move stretches the pull. */
  for (const ax of lensAxesOf()) {
    for (const k of ax.keys) k.frame = Math.round(k.frame * sc);
    for (let i = 1; i < ax.keys.length; i++) {
      if (ax.keys[i].frame <= ax.keys[i - 1].frame) ax.keys[i].frame = ax.keys[i - 1].frame + MIN_GAP;
    }
    if (ax.keys.length) ax.keys[ax.keys.length - 1].frame = Math.min(ax.keys[ax.keys.length - 1].frame, dur);
  }
  film.durationFrames = dur;
  playheadFrame = Math.min(playheadFrame, dur);
  syncInputs(); frameAll(); refreshPreview(); refreshLens();
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
  for (const ax of lensAxesOf()) {
    for (const k of ax.keys) k.frame = TC.retimeFrames(k.frame, from, tb);
    for (let i = 1; i < ax.keys.length; i++) {
      if (ax.keys[i].frame <= ax.keys[i - 1].frame) ax.keys[i].frame = ax.keys[i - 1].frame + MIN_GAP;
    }
  }
  /* Rounding + MIN_GAP can push a last key one frame past the retimed duration.
     Clamp every lane's tail, or validateLensAxis/validateFilm rejects the upload
     later with an error the operator did nothing to cause. */
  for (const ax of film.axes) {
    const last = ax.points[ax.points.length - 1];
    if (last) last.frame = Math.min(last.frame, film.durationFrames);
  }
  for (const ax of lensAxesOf()) {
    const last = ax.keys[ax.keys.length - 1];
    if (last) last.frame = Math.min(last.frame, film.durationFrames);
  }
  playheadFrame = TC.retimeFrames(playheadFrame, from, tb);
  film.timebase = { ...tb };
  uploaded = false;
  syncInputs(); frameAll(); refreshPreview(); refreshLens();
  status(`Timebase ${TC.timebaseLabel(tb)} — move retimed to ${film.durationFrames} frames, same real duration.`);
};
$("moveName").onchange = () => { film.name = $("moveName").value; };

function adopt(f, path = null) {
  film = f; undoStack.length = 0; redoStack.length = 0; selection = null;
  filePath = path; dirty = false;
  updateInspector(); syncInputs(); playheadFrame = 0; frameAll(); refreshPreview(); refreshLens();
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
    uploaded = true;
    /* The NMX has no lens channel — lens lanes go to the trigger board instead,
       and only at arm time. Say which of the two happened, because an operator
       who assumes a focus pull was sent finds out in the rushes. */
    const kinds = lensAxesOf().map((a) => a.kind);
    let lensNote = "";
    if (kinds.length) {
      try {
        const c = await window.nmx.lensCheck(film);
        lensNote = c.connected
          ? `  \u2014 ${kinds.join(" \u00b7 ")}: ${c.points} points ready (from ${c.densePoints}), ~${c.uploadSeconds}s at arm.`
          : `  \u2014 ${kinds.join(" \u00b7 ")} NOT sent: no lens device. Pull by hand or match in post.`;
        if (c.infeasible.length) lensNote += `  \u26a0 ${c.infeasible[0].reason}`;
      } catch { lensNote = `  \u2014 ${kinds.join(" \u00b7 ")}: lens state unknown.`; }
    }
    status(`Uploaded to controller (${n} packets). Ready to run.` + lensNote);
  } catch (e) { status("Upload blocked: " + e.message); }
};
$("tlGotoStart").onclick = async () => {
  await window.nmx.gotoKfStart(film.axes.map((a) => ({ axis: a.axis, points: a.points })));
  status("Sending axes to first keys…");
};
$("tlRun").onclick = async () => {
  try {
    if (!uploaded) return status("Upload first (↑) — edits since last upload aren’t on the controller.");
    if (!(await armCuesForPass())) return;
    kfPassCount++; $("tlPassCounter").textContent = "pass " + kfPassCount;
    await countdown(Math.round((await window.nmx.cueMs(film)) / 1000));
    await window.nmx.kfRun();
    /* Cues start at the same instant the move does — the countdown happens
       before both, so t=0 means the same thing on either side. */
    await window.nmx.cuesStart();
    logPass(`KF pass ${kfPassCount} — “${film.name}”`);
    clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
      try {
        const p = await window.nmx.kfProgress();
        $("tlProg").style.width = (p.percent ?? 0) + "%";
        if (p.state === 0 && (p.percent ?? 0) > 0) {
          clearInterval(pollTimer); logPass(`KF pass ${kfPassCount} complete`);
          reportCueDelivery();
          status(`Pass ${kfPassCount} complete. ⏮ then reposition, run again.`);
        }
      } catch { clearInterval(pollTimer); }
    }, 500);
  } catch (e) { status("Run blocked: " + e.message); }
};
$("tlStop").onclick = async () => {
  clearInterval(pollTimer); await window.nmx.kfStop(); await window.nmx.cuesStop();
  status("Key-frame program stopped.");
};

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
    if (!(await armCuesForPass())) return;
    passCount++; $("passCounter").textContent = "pass " + passCount;
    await countdown(Math.round((await window.nmx.cueMs(film)) / 1000));
    await window.nmx.run();
    await window.nmx.cuesStart();
    logPass(`classic pass ${passCount}`);
    clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
      try {
        const p = await window.nmx.progress();
        $("prog").style.width = (p.percent ?? 0) + "%";
        if (!p.running && (p.percent ?? 0) > 0) {
          clearInterval(pollTimer); logPass(`classic pass ${passCount} complete`); status(`Pass ${passCount} complete.`);
          reportCueDelivery();
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
  try { await window.nmx.stopAll(); status("STOP ALL — broadcast stop, both engines, and every armed cue aborted."); }
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
  if (e.key === "c" || e.key === "C") { e.preventDefault(); return addCue(); }
  if (selection?.kind === "lens") {
    const ax = selectedLens();
    const key = ax?.keys[selection.k];
    if (!key) return;
    const end = selection.k === 0 || selection.k === ax.keys.length - 1;
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault(); snapshot();
      key.position = Math.max(0, Math.min(1, key.position + (e.key === "ArrowUp" ? 1 : -1) * (e.shiftKey ? 0.05 : 0.01)));
      updateLensInspector(); refreshLens(); return;
    }
    if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && e.altKey && !end) {
      e.preventDefault(); snapshot();
      const stepF = e.shiftKey ? Math.round(TC.fpsDecimal(film.timebase)) : 1;
      key.frame = Math.max(ax.keys[selection.k - 1].frame + MIN_GAP,
        Math.min(ax.keys[selection.k + 1].frame - MIN_GAP, key.frame + (e.key === "ArrowRight" ? stepF : -stepF)));
      updateLensInspector(); refreshLens(); return;
    }
    if ((e.key === "Backspace" || e.key === "Delete") && !end) { e.preventDefault(); return $("lensDelete").click(); }
    return;
  }
  if (selection?.kind === "cue") {
    const ev = selectedCue();
    if (!ev) return;
    if (e.key === "Backspace" || e.key === "Delete") { e.preventDefault(); return delCue(ev.id); }
    if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && e.altKey) {
      e.preventDefault(); snapshot();
      const stepF = e.shiftKey ? Math.round(TC.fpsDecimal(film.timebase)) : 1;
      ev.frame = Math.max(0, Math.min(film.durationFrames, ev.frame + (e.key === "ArrowRight" ? stepF : -stepF)));
      film.events.sort((a, b) => a.frame - b.frame);
      updateCueInspector(); render();
    }
    return;
  }
  if (selection?.kind !== "key") return;
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
    bindings = (await window.nmx.getBindings()) ?? [];
    setTier(1, null);
    window.nmx.onCueFired(({ id, deviceMs }) => logPass(`cue ${id} fired @ ${deviceMs} ms (device clock)`));
    window.nmx.onCueProblem((msg) => { logPass(`cue problem: ${msg}`); status(msg); });
    window.nmx.onTriggerInput(({ n, edge, deviceMs }) => logPass(`GPI in ${n} ${edge} @ ${deviceMs} ms`));
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
  await refreshLensDriven();
  adopt(film);
  new ResizeObserver(render).observe(cv);
  if (window.nmx.__preview) status("Browser preview — no hardware, no Electron. Controls are stubbed.");
})();

/* persist the jog speed as it changes */
$("speed").addEventListener("change", () => window.nmx.setPrefs?.({ jogSpeed: Number($("speed").value) }));
