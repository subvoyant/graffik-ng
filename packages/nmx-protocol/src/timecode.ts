/**
 * SMPTE timecode and timebase math (ADR-0014).
 *
 * The rule this module exists to enforce: **frames are the authoring unit,
 * milliseconds are the wire unit.** Everything a human sees or types is a frame
 * number or a timecode; milliseconds appear only where the NMX firmware demands
 * them, and the conversion happens at that boundary and nowhere else.
 *
 * Frame rates are stored as EXACT rationals, never as decimals. 23.976 is
 * 24000/1001, which is 23.976023976…; a move authored against the rounded
 * decimal drifts by ~3.6 ms per 1000 frames — about a frame every seven
 * minutes. On a multi-pass composite that is a visible misregistration between
 * passes, so the decimal never appears in the math.
 */

export interface Timebase {
  /** Frame rate numerator. */
  num: number;
  /** Frame rate denominator. 1001 for the NTSC-derived rates. */
  den: number;
  /**
   * SMPTE drop-frame counting. Legal ONLY for 30000/1001 and 60000/1001.
   * Drop-frame renumbers the count so timecode tracks wall clock; it never
   * drops a picture. Nothing about the move changes — only how it is labelled.
   */
  dropFrame: boolean;
}

/** The rates a motion-control operator actually encounters. */
export const TIMEBASES: ReadonlyArray<{ id: string; label: string; tb: Timebase }> = [
  { id: "23.976", label: "23.976 (24 ÷ 1.001)", tb: { num: 24000, den: 1001, dropFrame: false } },
  { id: "24", label: "24", tb: { num: 24, den: 1, dropFrame: false } },
  { id: "25", label: "25 (PAL)", tb: { num: 25, den: 1, dropFrame: false } },
  { id: "29.97ndf", label: "29.97 NDF", tb: { num: 30000, den: 1001, dropFrame: false } },
  { id: "29.97df", label: "29.97 DF", tb: { num: 30000, den: 1001, dropFrame: true } },
  { id: "30", label: "30", tb: { num: 30, den: 1, dropFrame: false } },
  { id: "48", label: "48", tb: { num: 48, den: 1, dropFrame: false } },
  { id: "50", label: "50", tb: { num: 50, den: 1, dropFrame: false } },
  { id: "59.94ndf", label: "59.94 NDF", tb: { num: 60000, den: 1001, dropFrame: false } },
  { id: "59.94df", label: "59.94 DF", tb: { num: 60000, den: 1001, dropFrame: true } },
  { id: "60", label: "60", tb: { num: 60, den: 1, dropFrame: false } },
];

export const DEFAULT_TIMEBASE: Timebase = { num: 24, den: 1, dropFrame: false };

/** Look up a preset by id; returns undefined for an unknown id. */
export function timebaseById(id: string): Timebase | undefined {
  return TIMEBASES.find((t) => t.id === id)?.tb;
}

/** The id of the preset matching this timebase, or "" if it is a custom rate. */
export function timebaseId(tb: Timebase): string {
  return TIMEBASES.find(
    (t) => t.tb.num === tb.num && t.tb.den === tb.den && t.tb.dropFrame === tb.dropFrame,
  )?.id ?? "";
}

/**
 * The integer rate timecode counts in: 24, 25, 30, 60. NOT the real rate.
 * 29.97 fps counts in 30 frames per labelled second — that mismatch is the
 * entire reason drop-frame exists.
 */
export function nominalRate(tb: Timebase): number {
  return Math.round(tb.num / tb.den);
}

/** Real frames per second as a float. For display only — never for math. */
export function fpsDecimal(tb: Timebase): number {
  return tb.num / tb.den;
}

export function validateTimebase(tb: Timebase): void {
  if (!tb || typeof tb !== "object") throw new Error("timebase must be an object");
  if (!Number.isInteger(tb.num) || tb.num <= 0) throw new Error("timebase.num must be a positive integer");
  if (!Number.isInteger(tb.den) || tb.den <= 0) throw new Error("timebase.den must be a positive integer");
  if (typeof tb.dropFrame !== "boolean") throw new Error("timebase.dropFrame must be a boolean");
  if (tb.dropFrame && !isDropFrameLegal(tb)) {
    throw new Error(
      `drop-frame is only defined for 29.97 and 59.94 fps (got ${fpsDecimal(tb).toFixed(3)}) — ` +
        "at other rates the correction does not land on a whole number of frames",
    );
  }
}

/**
 * Drop-frame is defined only where the 0.1% NTSC pulldown works out to a whole
 * number of frames over a 10-minute cycle: 18 at 29.97, 36 at 59.94. At 23.976
 * the same arithmetic gives 14.4 frames, so no cyclical correction exists and
 * no drop-frame standard was ever written for it.
 */
export function isDropFrameLegal(tb: Timebase): boolean {
  return tb.den === 1001 && (tb.num === 30000 || tb.num === 60000);
}

/* ------------------------------------------------------------------
   frames <-> milliseconds — the ONLY place the two units meet
   ------------------------------------------------------------------ */

/** Exact real-time duration of a frame count, in ms (fractional). */
export function framesToMsExact(frames: number, tb: Timebase): number {
  return (frames * 1000 * tb.den) / tb.num;
}

/**
 * Frame count as integer milliseconds for the wire. The NMX takes i32 ms, so
 * this rounds — worst case 0.5 ms against a 20–42 ms frame. Abscissas are
 * absolute, not deltas, so the error never accumulates across a move.
 */
export function framesToMs(frames: number, tb: Timebase): number {
  return Math.round(framesToMsExact(frames, tb));
}

/** Milliseconds to a fractional frame position (for scrubbing / hit-testing). */
export function msToFramesExact(ms: number, tb: Timebase): number {
  return (ms * tb.num) / (1000 * tb.den);
}

/** Milliseconds snapped to the nearest whole frame. */
export function msToFrames(ms: number, tb: Timebase): number {
  return Math.round(msToFramesExact(ms, tb));
}

/* ------------------------------------------------------------------
   frames <-> SMPTE timecode
   ------------------------------------------------------------------ */

/** Frames dropped per drop-event: 2 at 29.97, 4 at 59.94. */
function dropCount(tb: Timebase): number {
  return nominalRate(tb) / 15;
}

const pad = (n: number, w = 2) => String(Math.abs(n)).padStart(w, "0");

/**
 * Frame count -> "HH:MM:SS:FF" (non-drop) or "HH:MM:SS;FF" (drop-frame).
 * The semicolon before the frames field is the SMPTE convention that marks a
 * count as drop-frame; it is the only visible difference, and reading it wrong
 * is how a shoot ends up 3.6 s out over an hour.
 */
export function framesToTimecode(frames: number, tb: Timebase): string {
  const neg = frames < 0;
  let f = Math.abs(Math.round(frames));
  const rate = nominalRate(tb);

  if (tb.dropFrame) {
    const drop = dropCount(tb);
    const per10Min = rate * 600 - 9 * drop;
    const perMin = rate * 60 - drop;
    const tenMinBlocks = Math.floor(f / per10Min);
    const rem = f % per10Min;
    // Renumber: add back the labels skipped by every drop event so far.
    f += drop * 9 * tenMinBlocks;
    if (rem > drop) f += drop * Math.floor((rem - drop) / perMin);
  }

  const ff = f % rate;
  const totalSec = Math.floor(f / rate);
  const ss = totalSec % 60;
  const mm = Math.floor(totalSec / 60) % 60;
  const hh = Math.floor(totalSec / 3600);
  const sep = tb.dropFrame ? ";" : ":";
  return `${neg ? "-" : ""}${pad(hh)}:${pad(mm)}:${pad(ss)}${sep}${pad(ff)}`;
}

/**
 * "HH:MM:SS:FF" / "HH:MM:SS;FF" -> frame count. Also accepts "MM:SS:FF",
 * "SS:FF", and a bare integer (treated as a frame number) so an operator can
 * type the short form under time pressure.
 *
 * Rejects a drop-frame label that names a frame the count skips — those
 * timecodes do not exist, and silently accepting one hides a typo inside a
 * move that later fails to line up.
 */
export function timecodeToFrames(text: string, tb: Timebase): number {
  const s = String(text).trim();
  if (s === "") throw new Error("empty timecode");
  const neg = s.startsWith("-");
  const body = neg ? s.slice(1) : s;

  if (/^\d+$/.test(body)) return (neg ? -1 : 1) * parseInt(body, 10);

  const parts = body.split(/[:;]/);
  if (parts.length < 2 || parts.length > 4 || parts.some((p) => !/^\d+$/.test(p))) {
    throw new Error(`not a timecode: "${text}" (expected HH:MM:SS:FF)`);
  }
  while (parts.length < 4) parts.unshift("0");
  const [hh, mm, ss, ff] = parts.map((p) => parseInt(p, 10));

  const rate = nominalRate(tb);
  if (ff >= rate) throw new Error(`frame ${ff} is out of range for a ${rate}-frame second`);
  if (ss > 59 || mm > 59) throw new Error(`invalid timecode "${text}"`);

  const totalMinutes = hh * 60 + mm;
  let f = rate * 3600 * hh + rate * 60 * mm + rate * ss + ff;

  if (tb.dropFrame) {
    const drop = dropCount(tb);
    if (ss === 0 && ff < drop && mm % 10 !== 0) {
      throw new Error(
        `${text} does not exist in drop-frame — frames 0..${drop - 1} are skipped at the start of ` +
          "every minute except every tenth",
      );
    }
    f -= drop * (totalMinutes - Math.floor(totalMinutes / 10));
  }
  return (neg ? -1 : 1) * f;
}

/**
 * Compact duration label: "240f · 00:00:10:00". Frame count first because a
 * move's length is a frame count — the timecode is the readback.
 */
export function formatDuration(frames: number, tb: Timebase): string {
  return `${frames}f · ${framesToTimecode(frames, tb)}`;
}

/** Human label for a timebase, e.g. "23.976" or "29.97 DF". */
export function timebaseLabel(tb: Timebase): string {
  const preset = TIMEBASES.find((t) => t.tb.num === tb.num && t.tb.den === tb.den && t.tb.dropFrame === tb.dropFrame);
  if (preset) return preset.label.replace(/\s*\(.*\)$/, "");
  const d = fpsDecimal(tb);
  return `${Number.isInteger(d) ? d : d.toFixed(3)}${tb.dropFrame ? " DF" : ""}`;
}

/**
 * Rescale a frame count from one timebase to another, preserving REAL TIME.
 * Changing a shoot from 24 to 25 fps keeps the move the same number of seconds
 * long and gives it more frames — the rig's behaviour is what must not change.
 */
export function retimeFrames(frames: number, from: Timebase, to: Timebase): number {
  return Math.round(msToFramesExact(framesToMsExact(frames, from), to));
}
