/**
 * The bring-up report (ADR-0023).
 *
 * A hardware session produces facts that only exist in that room: the firmware
 * version, which port answered, the travel that was taught, the spans that were
 * measured, whether five passes returned to the same place. Those facts are the
 * input to every software decision that follows, and by default they live in
 * somebody's memory until the next morning.
 *
 * So the app writes them down. One markdown file, everything the app knows
 * about this rig on this day, in a form that can be pasted into a decision log
 * or handed to whoever is going to correct the code against it.
 *
 * Pure: state in, markdown out. No IO, no clock — the caller supplies the
 * timestamp, so the same input always produces the same file and it can be
 * tested without freezing time.
 */

import { AxisLimit, isTaught } from "./limits.js";
import { CalObservation, fitCalibration, repeatability } from "./commission.js";
import { LensAxisKind } from "./lens.js";

export interface BringUpState {
  /** ISO timestamp — supplied, not read, so this stays a pure function. */
  at: string;
  appVersion?: string;
  connection?: {
    port?: string | null;
    firmware?: number | null;
    supported?: boolean;
    overridden?: boolean;
  };
  limits?: AxisLimit[];
  calibration?: Record<string, number | undefined>;
  spans?: Partial<Record<"slide" | "pan" | "tilt", CalObservation[]>>;
  repeatability?: { readings: number[]; thresholdMm: number };
  lensMotors?: Partial<Record<LensAxisKind, { steps: number; maxStepsPerSec: number; invert: boolean }>>;
  triggerDevice?: string | null;
  /** Newest-first lines from the pass log — what actually happened, in order. */
  log?: string[];
  /** Whatever the operator typed. The most valuable field and the only free one. */
  notes?: string;
}

const AXIS_NAMES = ["Slide", "Pan", "Tilt"] as const;
const CAL_UNIT = { slide: "mm", pan: "deg", tilt: "deg" } as const;

const bound = (v: number | null) => (v === null || v === undefined ? "—" : String(v));

/**
 * Render the report.
 *
 * Everything unmeasured is listed as **not measured** rather than omitted. A
 * report that silently drops the parts nobody got to reads like a complete one,
 * and the whole point is to know what is still missing when the rig goes away.
 */
export function bringUpReport(s: BringUpState): string {
  const L: string[] = [];
  L.push(`# Graffik NG — bring-up report`);
  L.push("");
  L.push(`- **When:** ${s.at}`);
  if (s.appVersion) L.push(`- **App version:** ${s.appVersion}`);
  L.push("");

  L.push(`## Connection`);
  const c = s.connection;
  if (!c?.port) L.push(`- **Never connected in this session.**`);
  else {
    L.push(`- Port: \`${c.port}\``);
    L.push(`- Firmware: ${c.firmware ?? "unknown"}${c.supported === false ? " — **not the verified version**" : ""}`);
    if (c.overridden) L.push(`- ⚠ Firmware gate was **overridden** — programmed moves ran on an unverified command set (ADR-0004).`);
  }
  L.push("");

  L.push(`## Soft limits (taught by jogging)`);
  const lim = s.limits ?? [];
  if (!lim.length || !lim.some(isTaught)) L.push(`- **Not taught.** Nothing constrains travel yet.`);
  else {
    L.push(`| Axis | min | max | taught |`);
    L.push(`|---|---|---|---|`);
    lim.forEach((l, i) => L.push(`| ${AXIS_NAMES[i] ?? i} | ${bound(l.min)} | ${bound(l.max)} | ${isTaught(l) ? "yes" : "**no**"} |`));
  }
  L.push("");

  L.push(`## Rig calibration`);
  const spans = s.spans ?? {};
  const anySpan = Object.values(spans).some((v) => v?.length);
  if (!anySpan) {
    L.push(`- **Not measured.** A 3D export is a shape, not a camera move, until it is (ADR-0015).`);
  } else {
    const CAL_KEY = { slide: "slideStepsPerMm", pan: "panStepsPerDeg", tilt: "tiltStepsPerDeg" } as const;
    const notes: string[] = [];
    L.push(`| Axis | measured | in use by the exporter | spans | spread |`);
    L.push(`|---|---|---|---|---|`);
    for (const axis of ["slide", "pan", "tilt"] as const) {
      const obs = spans[axis] ?? [];
      const unit = CAL_UNIT[axis];
      const applied = s.calibration?.[CAL_KEY[axis]];
      if (!obs.length) { L.push(`| ${axis} | **not measured** | ${applied ?? "—"} | 0 | — |`); continue; }
      const f = fitCalibration(obs, unit);
      /* Flag measured-but-not-applied rather than leaving two numbers in a
         table for somebody to diff. It is the single easiest way to leave a
         session believing a calibration is in effect when it is not. */
      const drift = applied !== undefined && Math.abs(f.perUnit - applied) / f.perUnit > 0.001;
      if (drift) notes.push(`⚠ **${axis} was measured at ${f.perUnit.toFixed(3)} but the exporter is still using ${applied}** — "Use these numbers" was not pressed.`);
      for (const w of f.warnings) notes.push(`- ${axis}: ${w}`);
      L.push(
        `| ${axis} | ${f.perUnit.toFixed(3)} steps/${unit === "mm" ? "mm" : "°"} | ${applied ?? "—"}${drift ? " ⚠" : ""} | ${f.n} | ${f.spreadPct.toFixed(2)}% |`,
      );
    }
    L.push("");
    /* Warnings spelled out, not counted. "1 warning" tells nobody anything. */
    for (const n of notes) L.push(n);
    if (notes.length) L.push("");
    L.push(`<details><summary>Every span, as measured</summary>`);
    L.push("");
    for (const axis of ["slide", "pan", "tilt"] as const) {
      for (const o of spans[axis] ?? []) {
        L.push(`- ${axis}: ${o.steps} steps over ${o.measured} ${CAL_UNIT[axis] === "mm" ? "mm" : "°"}${o.note ? ` — ${o.note}` : ""}`);
      }
    }
    L.push("");
    L.push(`</details>`);
  }
  if (s.calibration) {
    const extra = Object.entries(s.calibration)
      .filter(([k, v]) => v !== undefined && !/StepsPer/.test(k))
      .map(([k, v]) => `${k}=${v}`);
    if (extra.length) L.push(`Scene placement: ${extra.join(" · ")}`);
  }
  L.push("");

  L.push(`## Repeatability`);
  const rep = s.repeatability;
  if (!rep?.readings.length) L.push(`- **Not measured.** This is the thing multiplicity depends on.`);
  else {
    const r = repeatability(rep.readings, rep.thresholdMm);
    L.push(`- Readings (mm): ${rep.readings.map((v) => v.toFixed(2)).join(", ")}`);
    L.push(`- Limit: ${rep.thresholdMm} mm`);
    L.push(`- **${r.verdict}**`);
  }
  L.push("");

  L.push(`## Lens motors`);
  const lm = s.lensMotors ?? {};
  /* Listed whenever a motor is CONFIGURED, not only when one is calibrated.
     "a focus motor exists and has never been calibrated" is a different and
     more useful fact than "no barrel calibrated", and collapsing the two loses
     the one that tells you what to do next. */
  const anyLens = Object.values(lm).some(Boolean);
  if (!anyLens) L.push(`- **No lens motors configured.**`);
  else {
    L.push(`| Axis | travel (steps) | top speed | inverted |`);
    L.push(`|---|---|---|---|`);
    for (const [k, m] of Object.entries(lm)) {
      if (!m) continue;
      L.push(`| ${k} | ${m.steps || "**not calibrated**"} | ${m.maxStepsPerSec} steps/s | ${m.invert ? "yes" : "no"} |`);
    }
  }
  L.push("");

  L.push(`## Trigger / lens device`);
  L.push(s.triggerDevice ? `- ${s.triggerDevice}` : `- **Not connected.**`);
  L.push("");

  if (s.notes?.trim()) {
    L.push(`## Notes from the session`);
    L.push("");
    L.push(s.notes.trim());
    L.push("");
  }

  if (s.log?.length) {
    L.push(`## Pass log (newest first)`);
    L.push("");
    /* Verbatim and in order. A summarised log is a log somebody has already
       decided what mattered in, and on a first bring-up nobody knows yet. */
    for (const line of s.log) L.push(`- ${line}`);
    L.push("");
  }

  L.push(`---`);
  L.push(`Anything marked **not measured** is still unknown. Software written against`);
  L.push(`an unmeasured number is software written against a guess.`);
  return L.join("\n") + "\n";
}
