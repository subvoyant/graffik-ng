/**
 * Move ("film") persistence — versioned JSON schema for saved camera moves.
 *
 * Lives in the headless core (not the app) so the schema has one owner,
 * round-trips are unit-testable, and a future CLI can run saved moves.
 * See ADR-0010 for the format decision.
 */

import { KeyFramePoint } from "./spline.js";
import { AxisIndex } from "./move.js";

export const FILM_FORMAT = "graffik-ng-move";
export const FILM_VERSION = 1;

export interface FilmAxis {
  /** 0 = slide, 1 = pan, 2 = tilt (KF-engine indexing). */
  axis: AxisIndex;
  /** time in ms from move start; position in steps. Velocity omitted = auto-solve. */
  points: KeyFramePoint[];
}

export interface Film {
  format: typeof FILM_FORMAT;
  version: number;
  name: string;
  /** Total move duration, ms. */
  durationMs: number;
  /** Cue countdown before motion, ms. */
  startDelayMs: number;
  /** "classic" = 2-point program engine; "keyframe" = KF engine. */
  engine: "classic" | "keyframe";
  axes: FilmAxis[];
  /** ISO timestamp of last save (informational only). */
  savedAt?: string;
  notes?: string;
}

export function serializeFilm(film: Film): string {
  validateFilm(film);
  return JSON.stringify(film, null, 2);
}

/** Parse + validate. Throws Error with a human-readable reason on bad input. */
export function deserializeFilm(json: string): Film {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("not valid JSON");
  }
  const f = raw as Film;
  validateFilm(f);
  return f;
}

export function validateFilm(f: Film): void {
  if (!f || typeof f !== "object") throw new Error("film must be an object");
  if (f.format !== FILM_FORMAT) throw new Error(`unknown format: ${String((f as { format?: unknown }).format)}`);
  if (typeof f.version !== "number" || f.version < 1) throw new Error("missing/invalid version");
  if (f.version > FILM_VERSION) throw new Error(`file version ${f.version} is newer than this app understands (${FILM_VERSION})`);
  if (typeof f.name !== "string") throw new Error("missing name");
  if (!Number.isFinite(f.durationMs) || f.durationMs <= 0) throw new Error("durationMs must be > 0");
  if (!Number.isFinite(f.startDelayMs) || f.startDelayMs < 0) throw new Error("startDelayMs must be >= 0");
  if (f.engine !== "classic" && f.engine !== "keyframe") throw new Error(`unknown engine: ${String(f.engine)}`);
  if (!Array.isArray(f.axes) || f.axes.length === 0) throw new Error("axes must be a non-empty array");
  for (const ax of f.axes) {
    if (![0, 1, 2].includes(ax.axis)) throw new Error(`invalid axis index: ${String(ax.axis)}`);
    if (!Array.isArray(ax.points) || ax.points.length < 2) throw new Error(`axis ${ax.axis}: needs >= 2 points`);
    let prev = -Infinity;
    for (const p of ax.points) {
      if (!Number.isFinite(p.time) || !Number.isFinite(p.position)) {
        throw new Error(`axis ${ax.axis}: non-numeric point`);
      }
      if (p.time <= prev) throw new Error(`axis ${ax.axis}: point times must be strictly increasing`);
      if (p.time < 0 || p.time > f.durationMs) throw new Error(`axis ${ax.axis}: point time ${p.time} outside 0..durationMs`);
      prev = p.time;
    }
  }
}

/** A sensible empty film for a new document. */
export function newFilm(name = "Untitled Move", durationMs = 30_000): Film {
  return {
    format: FILM_FORMAT,
    version: FILM_VERSION,
    name,
    durationMs,
    startDelayMs: 5_000,
    engine: "keyframe",
    axes: [
      { axis: 0, points: [{ time: 0, position: 0 }, { time: durationMs, position: 0 }] },
      { axis: 1, points: [{ time: 0, position: 0 }, { time: durationMs, position: 0 }] },
      { axis: 2, points: [{ time: 0, position: 0 }, { time: durationMs, position: 0 }] },
    ],
  };
}
