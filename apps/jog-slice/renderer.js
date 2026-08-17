/* Graffik NG renderer — UI only; hardware via window.nmx (ADR-0007).
   Runs in Electron, and also standalone in a browser (preview stub below). */
"use strict";

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------------
   Browser-preview stub: opening index.html directly in a browser (no
   Electron) installs a fake device so the UI can be designed/reviewed
   without hardware or a build. Never active under Electron.
   ------------------------------------------------------------------ */
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
    previewMove: async (axes, dur, n = 140) => axes.map(({ axis, points }) => {
      const s = [];
      for (let i = 0; i <= n; i++) {
        const t = (dur * i) / n;
        let seg = 0;
        for (let k = 0; k < points.length - 1; k++) if (t >= points[k].time) seg = k;
        const a = points[seg], b = points[seg + 1] ?? a;
        const u = b.time === a.time ? 0 : (t - a.time) / (b.time - a.time);
        const e = u * u * (3 - 2 * u);
        s.push({ t, pos: a.position + (b.position - a.position) * e });
      }
      return { axis, samples: s };
    }),
    uploadKf: async (a) => a.length * 8, kfRun: async () => { pct = 0; }, kfStop: async () => {},
    kfProgress: async () => ({ state: pct < 100 ? 1 : 0, percent: (pct = Math.min(100, pct + 20)) }),
    gotoKfStart: async () => {},
    camArm: async () => {}, camFire: async () => {}, camDisable: async () => {},
    saveFilm: async () => null, loadFilm: async () => null, stopAll: async () => { speeds.fill(0); },
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

/* ---------------- film model ---------------- */
function defaultFilm(durationMs = 30000) {
  return {
    format: "graffik-ng-move", version: 1, name: "Untitled Move",
    durationMs, startDelayMs: 5000, engine: "keyframe",
    axes: AXES.map((a) => ({ axis: a.axis, points: [{ time: 0, position: 0 }, { time: durationMs, position: 0 }] })),
  };
}
let film = defaultFilm();
let playheadMs = 0, previewCache = null, uploaded = false, selection = null;
let view = { t0: 0, t1: 30000 };            // visible time window (zoom/pan)

/* ---------------- undo/redo ---------------- */
const undoStack = [], redoStack = [];
const clone = (f) => JSON.parse(JSON.stringify(f));
function snapshot() { undoStack.push(clone(film)); if (undoStack.length > 60) undoStack.shift(); redoStack.length = 0; }
function undo() { if (!undoStack.length) return; redoStack.push(clone(film)); film = undoStack.pop(); afterFilmChange(); }
function redo() { if (!redoStack.length) return; undoStack.push(clone(film)); film = redoStack.pop(); afterFilmChange(); }
function afterFilmChange() { selection = null; updateInspector(); syncInputs(); refreshPreview(); }
function syncInputs() {
  $("moveName").value = film.name;
  $("tlDuration").value = String(Math.round(film.durationMs / 1000));
  $("tlCue").value = String(Math.round(film.startDelayMs / 1000));
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
const tToX = (t, r) => r.x + ((t - view.t0) / (view.t1 - view.t0)) * r.w;
const xToT = (x, r) => view.t0 + ((x - r.x) / r.w) * (view.t1 - view.t0);

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

function niceStep(spanMs, targetPx, widthPx) {
  const perPx = spanMs / widthPx;
  const raw = perPx * targetPx;
  const steps = [100, 250, 500, 1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000, 600000];
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
  const step = niceStep(view.t1 - view.t0, 70, rTop.w);
  const first = Math.ceil(view.t0 / step) * step;
  for (let t = first; t <= view.t1; t += step) {
    const x = tToX(t, rTop);
    ctx.fillRect(x, RULER - 5, 1, 5);
    const s = t / 1000;
    const label = s >= 60
      ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`
      : `${+s.toFixed(step < 1000 ? 1 : 0)}s`;
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
        if (pt.t < view.t0 - 100 || pt.t > view.t1 + 100) continue;
        const x = tToX(pt.t, r), y = posToY(pt.pos, r, s);
        started ? ctx.lineTo(x, y) : (ctx.moveTo(x, y), started = true);
      }
      ctx.stroke(); ctx.restore(); ctx.lineWidth = 1;
    }

    /* keyframes as diamonds — the animation-software convention */
    film.axes[i].points.forEach((p, k) => {
      if (p.time < view.t0 - 500 || p.time > view.t1 + 500) return;
      const x = tToX(p.time, r), y = posToY(p.position, r, s);
      const sel = selection && selection.track === i && selection.k === k;
      const R = sel ? 6 : 4.5;
      ctx.beginPath();
      ctx.moveTo(x, y - R); ctx.lineTo(x + R, y); ctx.lineTo(x, y + R); ctx.lineTo(x - R, y); ctx.closePath();
      ctx.fillStyle = a.color; ctx.fill();
      ctx.strokeStyle = sel ? "#ffffff" : "#0e1013"; ctx.lineWidth = sel ? 1.6 : 1; ctx.stroke(); ctx.lineWidth = 1;
    });
  });

  /* playhead */
  const px = tToX(playheadMs, rTop);
  if (px >= PAD_L - 1 && px <= w - PAD_R + 1) {
    ctx.strokeStyle = "rgba(232,234,237,.55)"; ctx.beginPath();
    ctx.moveTo(px + .5, RULER); ctx.lineTo(px + .5, h); ctx.stroke();
    ctx.fillStyle = INK; ctx.beginPath();
    ctx.moveTo(px - 5, RULER - 9); ctx.lineTo(px + 5, RULER - 9); ctx.lineTo(px, RULER - 1); ctx.closePath(); ctx.fill();
  }

  $("playheadLabel").textContent = (playheadMs / 1000).toFixed(1) + " s";
  $("zoomLabel").textContent = Math.round((film.durationMs / (view.t1 - view.t0)) * 100) + "%";
}

let previewTimer = null;
function refreshPreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    try {
      previewCache = await window.nmx.previewMove(
        film.axes.map((a) => ({ axis: a.axis, points: a.points })), film.durationMs, 200);
    } catch (e) { previewCache = null; status("Curve solve failed: " + e.message); }
    uploaded = false; render();
  }, 50);
}

/* ---------------- zoom / pan ---------------- */
function frameAll() { view = { t0: 0, t1: film.durationMs }; render(); }
$("tlFrame").onclick = frameAll;

cv.addEventListener("wheel", (e) => {
  e.preventDefault();
  const r = { x: PAD_L, w: cv.clientWidth - PAD_L - PAD_R };
  const span = view.t1 - view.t0;
  if (e.shiftKey) {
    const d = (e.deltaY || e.deltaX) * span * 0.0015;
    view.t0 += d; view.t1 += d;
  } else {
    const rect = cv.getBoundingClientRect();
    const anchor = xToT(e.clientX - rect.left, r);
    const f = Math.exp(e.deltaY * 0.0015);
    let ns = Math.min(film.durationMs * 4, Math.max(400, span * f));
    const frac = (anchor - view.t0) / span;
    view.t0 = anchor - frac * ns; view.t1 = view.t0 + ns;
  }
  /* keep the window from drifting far outside the move */
  const pad = film.durationMs * 0.25;
  if (view.t0 < -pad) { const s = view.t1 - view.t0; view.t0 = -pad; view.t1 = -pad + s; }
  if (view.t1 > film.durationMs + pad) { const s = view.t1 - view.t0; view.t1 = film.durationMs + pad; view.t0 = view.t1 - s; }
  render();
}, { passive: false });

/* ---------------- pointer interaction ---------------- */
let drag = null;
function hit(mx, my) {
  for (let i = 0; i < 3; i++) {
    const r = trackRect(i), s = axisScale(i), pts = film.axes[i].points;
    for (let k = 0; k < pts.length; k++) {
      const x = tToX(pts[k].time, r), y = posToY(pts[k].position, r, s);
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
    const d = ((drag.x - mx) / r.w) * (view.t1 - view.t0);
    view.t0 += d; view.t1 += d; drag.x = mx; return render();
  }
  const { track, k, r, s } = drag, pts = film.axes[track].points;
  pts[k].position = Math.round(yToPos(my, r, s));
  if (k > 0 && k < pts.length - 1) {
    const lo = pts[k - 1].time + 100, hi = pts[k + 1].time - 100;
    pts[k].time = Math.round(Math.max(lo, Math.min(hi, xToT(mx, r))));
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
  playheadMs = Math.round(Math.max(0, Math.min(film.durationMs, xToT(mx, r))));
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
  $("kfTime").value = (p.time / 1000).toFixed(1);
  $("kfPos").value = String(Math.round(p.position));
  $("kfTime").disabled = end; $("kfDelete").disabled = end;
}
$("kfTime").onchange = () => {
  if (!selection) return;
  const pts = film.axes[selection.track].points, k = selection.k;
  if (k === 0 || k === pts.length - 1) return;
  snapshot();
  pts[k].time = Math.round(Math.max(pts[k - 1].time + 100, Math.min(pts[k + 1].time - 100, Number($("kfTime").value) * 1000)));
  updateInspector(); refreshPreview();
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
  const near = pts.findIndex((p) => Math.abs(p.time - playheadMs) < 250);
  if (near >= 0) pts[near].position = pos;
  else { pts.push({ time: playheadMs, position: pos }); pts.sort((x, y) => x.time - y.time); }
  status(`${a.name} key @ ${(playheadMs / 1000).toFixed(1)}s = ${pos} steps`);
  refreshPreview();
}
$("capSlide").onclick = () => capture(0);
$("capPan").onclick = () => capture(1);
$("capTilt").onclick = () => capture(2);

/* ---------------- move params / files ---------------- */
$("tlDuration").onchange = () => {
  snapshot();
  const ms = Math.max(2000, Number($("tlDuration").value) * 1000), sc = ms / film.durationMs;
  for (const ax of film.axes) for (const p of ax.points) p.time = Math.round(p.time * sc);
  film.durationMs = ms; playheadMs = Math.min(playheadMs, ms); frameAll(); refreshPreview();
};
$("tlCue").onchange = () => { film.startDelayMs = Number($("tlCue").value) * 1000; };
$("moveName").onchange = () => { film.name = $("moveName").value; };

function adopt(f) { film = f; undoStack.length = 0; redoStack.length = 0; selection = null; updateInspector(); syncInputs(); playheadMs = 0; frameAll(); refreshPreview(); }
$("tlNew").onclick = () => adopt(defaultFilm(Number($("tlDuration").value) * 1000));
$("tlSave").onclick = async () => {
  try { const p = await window.nmx.saveFilm(film); if (p) { logPass(`saved “${film.name}”`); status("Saved: " + p); } }
  catch (e) { status("Save failed: " + e.message); }
};
$("tlLoad").onclick = async () => {
  try { const f = await window.nmx.loadFilm(); if (f) { adopt(f); status(`Loaded “${f.name}”.`); } }
  catch (e) { status("Load failed: " + e.message); }
};

/* ---------------- KF transport ---------------- */
$("tlUpload").onclick = async () => {
  try {
    const n = await window.nmx.uploadKf(film.axes.map((a) => ({ axis: a.axis, points: a.points })), film.durationMs);
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
    await countdown(Math.round(film.startDelayMs / 1000));
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
    const ms = Number($("travel").value) * 1000, ac = Math.min(2000, ms / 4);
    await window.nmx.armMove(ms, ac, ac);
    status(`Armed: ${$("travel").value}s continuous, quadratic ease.`);
  } catch (e) { status("Arm blocked: " + e.message); }
};
$("gotoStart").onclick = async () => { await window.nmx.gotoStart(); status("Sending axes to start marks…"); };
$("run").onclick = async () => {
  try {
    passCount++; $("passCounter").textContent = "pass " + passCount;
    await countdown(Number($("tlCue").value));
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
  if (e.key === "f" || e.key === "Home") { e.preventDefault(); return frameAll(); }
  if (e.key === " ") { e.preventDefault(); return $("tlRun").click(); }
  if (!selection) return;
  const pts = film.axes[selection.track].points, p = pts[selection.k];
  if (!p) return;
  const end = selection.k === 0 || selection.k === pts.length - 1;
  const stepPos = e.shiftKey ? 100 : 10;
  if (e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); snapshot(); p.position += e.key === "ArrowUp" ? stepPos : -stepPos; }
  else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && e.altKey && !end) {
    e.preventDefault(); snapshot();
    p.time = Math.max(pts[selection.k - 1].time + 100, Math.min(pts[selection.k + 1].time - 100, p.time + (e.key === "ArrowRight" ? 100 : -100)));
  } else if (e.key === "Backspace" || e.key === "Delete") { e.preventDefault(); return delKey(selection.track, selection.k); }
  else return;
  updateInspector(); refreshPreview();
});

/* ---------------- init ---------------- */
(async function init() {
  buildAxes();
  await refreshPorts();
  try {
    const p = await window.nmx.getPrefs();
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
