#!/usr/bin/env node
/**
 * Audit the command vocabulary against the firmware dispatch (ADR-0029).
 *
 * ADR-0004 has said since day one that protocol facts come from the firmware
 * dispatch source. It has been a rule people follow, checked by reading. This
 * makes it a rule CI enforces.
 *
 * What it checks, per exported command builder in `commands.ts`:
 *   - the packet is built on the sub-address its own block claims
 *     (`general.*` must build a general packet, `motors.*` a motor one, …)
 *   - the command number exists in that handler's dispatch
 *
 * And it reports COVERAGE — commands the firmware answers that we never send.
 * Coverage is information, not a defect: this is a vocabulary for a device, and
 * a complete one is a feature. Deliberately NOT wired into the dead-export
 * audit (ADR-0024), whose premise — "reachable from the product" — is the wrong
 * question to ask of a protocol vocabulary. Fidelity is the right one, and that
 * is what this checks.
 *
 *   node scripts/audit-vocabulary.mjs [--strict] [--coverage]
 *   node scripts/audit-vocabulary.mjs --extract <path-to-nanoMoCo_Firmware>
 *
 * `--extract` regenerates the fact table from a fresh clone. Everything else
 * runs off the committed table, so CI needs no GPL checkout.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TABLE = path.join(ROOT, "packages/nmx-protocol/reference/nmx-dispatch.json");
const SRC = path.join(ROOT, "packages/nmx-protocol/src/commands.ts");

/* Which handler each exported block must build packets for. */
const GROUP_OF_BLOCK = { general: "general", motors: "motor", cam: "camera", keyFrame: "keyframe", broadcast: "broadcast" };
/* Which handler each packet helper targets. */
const GROUP_OF_HELPER = { gen: "general", motor: "motor", camera: "camera", kfp: "keyframe", bcast: "broadcast" };

/* ---------------- extraction (only with --extract) ---------------- */

function extract(firmwareRoot) {
  const file = path.join(firmwareRoot, "Firmware/Motion_Engine/OM_Serial_Com_Client.ino");
  const lines = fs.readFileSync(file, "utf-8").split("\n");
  const bounds = [];
  lines.forEach((l, i) => {
    const m = l.match(/^\s*void (ser[A-Za-z]+)\s*\(/);
    if (m) bounds.push({ fn: m[1], start: i });
  });
  bounds.forEach((b, i) => { b.end = i + 1 < bounds.length ? bounds[i + 1].start : lines.length; });

  const groups = {};
  for (const [fn, group] of [["serMain", "general"], ["serMotor", "motor"], ["serCamera", "camera"], ["serKeyFrame", "keyframe"]]) {
    const b = bounds.find((x) => x.fn === fn);
    if (!b) throw new Error(`handler ${fn} not found in ${file}`);
    const cmds = [];
    for (let i = b.start; i < b.end; i++) {
      const m = lines[i].match(/^\s*case\s+(\d+)\s*:/);
      if (!m) continue;
      let note = "";
      for (let j = i - 1; j >= Math.max(b.start, i - 4); j--) {
        const c = lines[j].match(/^\s*(?:\/\/|\/\*)\s*(.+?)\s*(?:\*\/)?\s*$/);
        if (c && /command/i.test(c[1])) { note = c[1]; break; }
        if (lines[j].trim() && !/^\s*(\/\/|\{|\}|$)/.test(lines[j])) break;
      }
      let payload = null;
      for (let j = i; j < Math.min(b.end, i + 40); j++) {
        if (j > i && /^\s*case\s+\d+\s*:/.test(lines[j])) break;
        const t = lines[j];
        if (/Node\.ntoul\s*\(/.test(t)) { payload = "u32"; break; }
        if (/Node\.ntoui\s*\(/.test(t)) { payload = "u16"; break; }
        if (/Node\.ntof\s*\(/.test(t)) { payload = "f32"; break; }
        if (/Node\.ntol\s*\(/.test(t)) { payload = "i32"; break; }
        if (/input_serial_buffer\s*\[\s*0\s*\]/.test(t)) payload = payload ?? "u8";
      }
      cmds.push({ command: Number(m[1]), note, payload });
    }
    const seen = new Set();
    groups[group] = cmds.filter((c) => (seen.has(c.command) ? false : (seen.add(c.command), true)))
      .sort((a, b2) => a.command - b2.command);
  }
  const existing = JSON.parse(fs.readFileSync(TABLE, "utf-8"));
  existing.groups = { ...groups, broadcast: existing.groups.broadcast };
  fs.writeFileSync(TABLE, JSON.stringify(existing, null, 1) + "\n");
  console.log("extracted:", Object.entries(existing.groups).map(([g, c]) => `${g}=${c.length}`).join(" "));
}

/* ---------------- what we send ---------------- */

function ourCommands() {
  const src = fs.readFileSync(SRC, "utf-8");
  const blocks = [...src.matchAll(/^export const (general|motors|cam|keyFrame|broadcast) = \{/gm)]
    .map((m) => ({ name: m[1], start: m.index }))
    .sort((a, b) => a.start - b.start);
  blocks.forEach((b, i) => { b.end = i + 1 < blocks.length ? blocks[i + 1].start : src.length; });

  const out = [];
  for (const b of blocks) {
    const body = src.slice(b.start, b.end);
    for (const m of body.matchAll(/(\w+):\s*\(([^)]*)\)\s*=>\s*(gen|motor|camera|kfp|bcast)\(\s*(?:m,\s*)?(\d+)/g)) {
      out.push({ block: b.name, name: m[1], group: GROUP_OF_HELPER[m[3]], command: Number(m[4]) });
    }
  }
  return out;
}

/* ---------------- main ---------------- */

const args = process.argv.slice(2);
if (args[0] === "--extract") {
  const root = args[1];
  if (!root) { console.error("usage: audit-vocabulary.mjs --extract <path-to-nanoMoCo_Firmware>"); process.exit(2); }
  extract(root);
  process.exit(0);
}

const table = JSON.parse(fs.readFileSync(TABLE, "utf-8")).groups;
const ours = ourCommands();
const problems = [];

for (const o of ours) {
  const expected = GROUP_OF_BLOCK[o.block];
  if (o.group !== expected) {
    problems.push(`${o.block}.${o.name} builds a ${o.group} packet — its block is ${expected}`);
    continue;
  }
  if (!(table[o.group] ?? []).some((c) => c.command === o.command)) {
    problems.push(`${o.block}.${o.name} sends ${o.group} command ${o.command}, which the firmware dispatch does not handle`);
  }
}

const total = Object.values(table).reduce((n, c) => n + c.length, 0);
console.log(`${ours.length} command builders checked against ${total} dispatch entries in ${Object.keys(table).length} handlers`);

if (args.includes("--coverage")) {
  for (const g of Object.keys(table)) {
    const mine = new Set(ours.filter((o) => o.group === g).map((o) => o.command));
    const missing = table[g].filter((c) => !mine.has(c.command));
    console.log(`\n  ${g}: ${mine.size}/${table[g].length} sent, ${missing.length} not`);
    for (const c of missing) console.log(`    ${String(c.command).padStart(3)}  ${c.note || "(no comment in the dispatch)"}`);
  }
  console.log("");
}

if (problems.length) {
  console.log("\nVOCABULARY DOES NOT MATCH THE DISPATCH:");
  for (const p of problems) console.log("  " + p);
  console.log("");
  if (args.includes("--strict")) process.exit(1);
} else {
  console.log("\nevery command we send is one the firmware handles, on the sub-address it handles it.");
}
