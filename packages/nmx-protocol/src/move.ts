/**
 * High-level move programming for the NMX key-frame engine.
 *
 * Produces the exact command sequence the official NMX Motion app sends for a
 * key-framed move (per axis: setAxis → setKeyFrameCount → [video time] →
 * all abscissas → all positions → all velocities → endTransmission), with
 * interior velocities auto-computed on the Hermite spline (see spline.ts).
 *
 * The controller stores the program and executes it deterministically —
 * upload once, then run identical passes with runSequence()/kfStart.
 */

import { Packet } from "./packet.js";
import { keyFrame } from "./commands.js";
import { KeyFramePoint, computeVelocities } from "./spline.js";

export type AxisIndex = 0 | 1 | 2; // slide, pan, tilt (KF engine is 0-based)

export interface AxisMove {
  axis: AxisIndex;
  /** Key frames: time in ms (video mode), position in steps. ≥2 points. */
  points: KeyFramePoint[];
}

export interface KeyFrameMoveOptions {
  /** Total video move duration, ms. Required for continuous (video) moves. */
  videoTimeMs: number;
  /** Motor velocity update rate at run time, ms. Firmware default applies if omitted. */
  updateRateMs?: number;
}

/**
 * Build the full upload sequence for a multi-axis key-framed move.
 * Send every packet in order (NmxClient serializes them); then run with
 * runSequence() or broadcast.kfStart().
 */
export function buildKeyFrameMove(axes: AxisMove[], options: KeyFrameMoveOptions): Packet[] {
  if (axes.length === 0) throw new Error("no axes in move");
  const packets: Packet[] = [];
  if (options.updateRateMs !== undefined) {
    packets.push(keyFrame.setUpdateRate(options.updateRateMs));
  }
  for (const { axis, points } of axes) {
    const solved = computeVelocities(points);
    packets.push(keyFrame.setAxis(axis));
    packets.push(keyFrame.setKeyFrameCount(solved.length));
    packets.push(keyFrame.setContinuousVideoTime(options.videoTimeMs));
    for (const p of solved) packets.push(keyFrame.setNextAbscissa(p.time));
    for (const p of solved) packets.push(keyFrame.setNextPosition(p.position));
    for (const p of solved) packets.push(keyFrame.setNextVelocity(p.velocity));
    packets.push(keyFrame.endTransmission());
  }
  return packets;
}

/**
 * The pass-start sequence the official app uses: take up backlash, then run.
 * Between passes, stop the program and re-run — the stored key frames persist
 * on the controller until re-uploaded.
 */
export function runSequence(): Packet[] {
  return [keyFrame.takeUpBacklash(), keyFrame.run()];
}

/* ------------------------------------------------------------------ */
/* Is this move physically possible? Ask the device (ADR-0031)          */
/* ------------------------------------------------------------------ */

/**
 * The controller validates an uploaded move against what its motors can
 * actually deliver, and has done since the firmware we gate on: key-frame
 * queries 105/106 run `validateVel()` / `validateAccel()` for the selected
 * axis, and on the classic engine general 129 is `validateProgram()` with motor
 * 120 naming the axis.
 *
 * We uploaded moves for twenty-four versions without ever asking. A move that
 * demands more than a motor can deliver does not fail loudly — **it just fails
 * to track**, which on a shoot reads as a belt problem, a payload problem, or a
 * software bug, in that order, and costs the afternoon.
 */
export interface AxisFeasibility {
  axis: number;
  name: string;
  /** `null` where the device was not asked or did not answer. */
  velocityOk: boolean | null;
  accelOk: boolean | null;
}

/**
 * One line per axis that has something to say. Silent for axes the device is
 * happy with — a pre-flight that prints three "fine" lines is a pre-flight
 * people learn to scroll past.
 */
export function describeMoveFeasibility(rows: AxisFeasibility[]): string[] {
  const out: string[] = [];
  for (const r of rows) {
    if (r.velocityOk === false && r.accelOk === false) {
      out.push(`${r.name}: the controller says this move exceeds both its top speed and its acceleration.`);
    } else if (r.velocityOk === false) {
      out.push(`${r.name}: the controller says this move exceeds the motor's top speed — it will not track it.`);
    } else if (r.accelOk === false) {
      out.push(`${r.name}: the controller says this move accelerates harder than the motor can follow.`);
    } else if (r.velocityOk === null && r.accelOk === null) {
      out.push(`${r.name}: the controller did not answer whether this move is achievable — treat it as unchecked.`);
    }
  }
  return out;
}

/** True when nothing the device told us should stop the pass. */
export const moveIsFeasible = (rows: AxisFeasibility[]): boolean =>
  rows.every((r) => r.velocityOk !== false && r.accelOk !== false);
