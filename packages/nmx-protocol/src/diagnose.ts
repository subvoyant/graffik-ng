/**
 * Connection diagnosis (ADR-0022).
 *
 * WHY THIS EXISTS
 * ---------------
 * A failed handshake produces exactly one symptom — a timeout — for at least
 * six unrelated causes: the cable is charge-only, the NMX is not powered, it is
 * in BLE mode rather than USB, the wrong port was picked from a list full of
 * Bluetooth entries, the device address is not 3, or the port is open at the
 * wrong baud rate.
 *
 * On a first bring-up those are indistinguishable, and the afternoon goes into
 * telling them apart by swapping things. Everything needed to separate them is
 * already observable — how many raw bytes came back, whether any of them ever
 * formed a valid frame, and whether some *other* address answers — so the app
 * should look rather than let somebody guess.
 *
 * The classification is a pure function over evidence, so it is testable
 * without a rig. The probing is a thin shell around it.
 */

import { PortLike, NmxClient } from "./client.js";
import { general } from "./commands.js";
import { BROADCAST_ADDRESS, DEFAULT_ADDRESS } from "./packet.js";

/** One address, asked politely, and what came back. */
export interface AddressProbe {
  address: number;
  answered: boolean;
  firmware: number | null;
  /** Raw bytes received while this address was being asked. */
  bytesSeen: number;
}

export type ProbeVerdict = "ok" | "wrong-address" | "noise" | "silence";

export interface ProbeReport {
  probes: AddressProbe[];
  answeringAddress: number | null;
  firmware: number | null;
  bytesSeen: number;
  verdict: ProbeVerdict;
  headline: string;
  /** Ordered, concrete things to try. Most likely cause first. */
  steps: string[];
}

/** Addresses worth asking. 1 is the broadcast address and never replies. */
export const PROBE_ADDRESSES: readonly number[] = [3, 2, 4, 5, 6, 7, 8];

/**
 * Turn evidence into an explanation.
 *
 * Split out from the probing so the reasoning is testable without a port, and
 * so the reasoning is the part under review rather than the plumbing.
 */
export function explainProbe(
  probes: AddressProbe[],
  ctx: { expectedFirmware?: number; portLooksLikeBluetooth?: boolean } = {},
): Pick<ProbeReport, "verdict" | "headline" | "steps" | "answeringAddress" | "firmware" | "bytesSeen"> {
  const bytesSeen = probes.reduce((n, p) => n + p.bytesSeen, 0);
  const winner = probes.find((p) => p.answered) ?? null;

  if (winner) {
    if (winner.address === DEFAULT_ADDRESS) {
      const fw = winner.firmware;
      const unexpected = ctx.expectedFirmware !== undefined && fw !== null && fw !== ctx.expectedFirmware;
      return {
        verdict: "ok",
        answeringAddress: winner.address,
        firmware: fw,
        bytesSeen,
        headline: unexpected
          ? `Answered at address ${winner.address}, firmware v${fw} — this build was written against v${ctx.expectedFirmware}.`
          : `Answered at address ${winner.address}, firmware v${fw}. The link is good.`,
        steps: unexpected
          ? [
              "Command numbers differ between firmware eras (ADR-0004), so a mismatch can move the wrong thing.",
              "Connect with the override only if you accept that risk, and check the first jog on an empty rig.",
            ]
          : [],
      };
    }
    /* Somebody set a non-default address, probably to run two controllers.
       That is a legitimate configuration and a completely opaque failure. */
    return {
      verdict: "wrong-address",
      answeringAddress: winner.address,
      firmware: winner.firmware,
      bytesSeen,
      headline: `Address ${winner.address} answered (firmware v${winner.firmware}) — the app was asking address ${DEFAULT_ADDRESS}.`,
      steps: [
        `This NMX has been given address ${winner.address}, which is normal when two controllers share a bus.`,
        `Either set the app to address ${winner.address}, or broadcast a set-address back to ${DEFAULT_ADDRESS}.`,
      ],
    };
  }

  if (bytesSeen > 0) {
    /* Bytes without a single valid frame is the signature of a speed
       mismatch. Silence would mean nothing is talking; garbage means
       something is talking and we cannot hear it. */
    return {
      verdict: "noise",
      answeringAddress: null,
      firmware: null,
      bytesSeen,
      headline: `${bytesSeen} bytes came back but none of them formed a valid packet.`,
      steps: [
        "Something is transmitting and we cannot read it — that is almost always a baud mismatch. The NMX is 19200 8N1.",
        "Check nothing else has the port open (a serial monitor, another copy of this app, Arduino IDE).",
        "If the port belongs to a different device entirely, pick another from the list.",
      ],
    };
  }

  return {
    verdict: "silence",
    answeringAddress: null,
    firmware: null,
    bytesSeen: 0,
    headline: "The port opened and nothing came back at all.",
    steps: [
      ...(ctx.portLooksLikeBluetooth
        ? ["That port looks like a Bluetooth serial port, not a USB one — pick a usbserial/usbmodem entry."]
        : []),
      "Check the NMX is powered up — a USB cable alone does not always power it.",
      "Check the cable carries data. Charge-only USB cables are common and look identical.",
      "Check the NMX is in USB mode rather than BLE — it will not answer over USB while it is talking Bluetooth.",
      `Every address in ${PROBE_ADDRESSES.join(", ")} was asked, so a non-default address is not the cause.`,
    ],
  };
}

/**
 * Ask every plausible address and report what happened.
 *
 * Taps the port's raw data alongside the client so it can tell "nothing at all"
 * from "bytes we could not parse" — the distinction that separates a dead link
 * from a wrong baud rate, and the one a timeout throws away.
 */
export async function probeNmx(
  port: PortLike,
  opts: { addresses?: readonly number[]; timeoutMs?: number; expectedFirmware?: number; portLooksLikeBluetooth?: boolean } = {},
): Promise<ProbeReport> {
  const addresses = opts.addresses ?? PROBE_ADDRESSES;
  const timeoutMs = opts.timeoutMs ?? 300;

  let bytes = 0;
  const tap = (chunk: Uint8Array | string) => { bytes += typeof chunk === "string" ? chunk.length : chunk.length; };
  port.on("data", tap as (c: Uint8Array) => void);

  const client = new NmxClient(port, { timeoutMs });
  const probes: AddressProbe[] = [];
  try {
    for (const address of addresses) {
      if (address === BROADCAST_ADDRESS) continue;      // never replies, by design
      const before = bytes;
      let answered = false, firmware: number | null = null;
      try {
        const r = await client.query({ ...general.queryFirmwareVersion(), address });
        answered = true;
        firmware = typeof r.value === "number" ? r.value : null;
      } catch { /* a timeout here is data, not an error */ }
      probes.push({ address, answered, firmware, bytesSeen: bytes - before });
      if (answered) break;                              // no reason to keep asking
    }
  } finally {
    port.off?.("data", tap as (c: Uint8Array) => void);
  }

  return { probes, ...explainProbe(probes, opts) };
}

/* ------------------------------------------------------------------
   Port list triage — before anything is even opened
   ------------------------------------------------------------------ */

export type PortLikelihood = "likely" | "unlikely" | "never";

export interface PortJudgement {
  path: string;
  likelihood: PortLikelihood;
  why: string;
}

/**
 * Rank a port list so the operator is not guessing.
 *
 * A macOS port list is mostly Bluetooth and debug entries, and on a first
 * bring-up nobody knows which of eight identical-looking paths is the rig.
 * Naming is the only evidence available before opening one, and opening the
 * wrong one is not free — a Bluetooth port can block for seconds.
 */
export function judgePort(path: string, manufacturer?: string): PortJudgement {
  const p = path.toLowerCase();
  const m = (manufacturer ?? "").toLowerCase();

  if (/bluetooth|incoming-port|wlan-debug|debug-console/.test(p)) {
    return { path, likelihood: "never", why: "a Bluetooth or debug port — not a serial device" };
  }
  if (/usbserial|usbmodem|ftdi|slab_usbtouart|wchusbserial/.test(p) || /ftdi|silicon labs|dynamic perception|arduino/.test(m)) {
    return { path, likelihood: "likely", why: manufacturer ? `USB serial · ${manufacturer}` : "USB serial" };
  }
  if (p.startsWith("simulator://")) {
    return { path, likelihood: "likely", why: "built-in simulator — no hardware" };
  }
  return { path, likelihood: "unlikely", why: "not obviously a USB serial device" };
}

export const judgePorts = (
  ports: Array<{ path: string; manufacturer?: string }>,
): PortJudgement[] => ports.map((p) => judgePort(p.path, p.manufacturer));

/** What to say when the list has nothing worth trying. */
export function noUsablePortAdvice(judged: PortJudgement[]): string | null {
  if (judged.some((j) => j.likelihood === "likely")) return null;
  return judged.length
    ? "No USB serial port in the list — every entry looks like Bluetooth or something else. Check the cable carries data and that the NMX is powered, then rescan."
    : "No serial ports at all. Check the cable is plugged in at both ends and carries data, and that the NMX is powered.";
}
