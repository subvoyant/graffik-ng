/*
 * Protocol parity: the TypeScript SimulatedTriggerDevice and the C++ reference
 * firmware must answer the same script identically.
 *
 *     node firmware/graffik-trig/test/parity.mjs
 *
 * The host is written against the simulator, so a simulator that is more
 * permissive than the board means every test passes and the rig fails. That is
 * not hypothetical — this check caught the simulator accepting `LAXIS 9` on a
 * three-axis board the first time it ran.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SimulatedTriggerDevice } from "../../../packages/nmx-protocol/dist/trigger.js";

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(here, "parity-script.txt");
const lines = readFileSync(scriptPath, "utf-8")
  .split("\n").map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#"));

/* ---- TypeScript side ---- */
const dev = new SimulatedTriggerDevice("graffik-trig", 8, 2, 2, 3);
dev.calibrationSteps = 4000;              // the same barrel the C++ side models
let ts = "";
dev.on("data", (d) => { for (const b of d) ts += String.fromCharCode(b); });
for (const line of lines) dev.write(line + "\n");

/* ---- C++ side ---- */
const bin = join(mkdtempSync(join(tmpdir(), "parity-")), "parity_runner");
execFileSync("g++", ["-std=c++17", "-I", here, "-o", bin, join(here, "parity_runner.cpp")], { stdio: "inherit" });
const cpp = execFileSync(bin, [scriptPath], { encoding: "utf-8" });

/* Clocks legitimately differ; nothing else may. */
const norm = (s) => s.replace(/\r/g, "").trim().split("\n")
  .map((l) => l.replace(/^(STARTED|DONE) \d+$/, "$1 <ms>")
               .replace(/^(FIRED \d+) \d+$/, "$1 <ms>")
               .replace(/^(IN \d+ \w+) \d+$/, "$1 <ms>"));

const a = norm(ts), b = norm(cpp);
let bad = 0;
for (let i = 0; i < Math.max(a.length, b.length); i++) {
  if (a[i] === b[i]) continue;
  bad++;
  console.log(`  line ${i + 1}\n    simulator: ${a[i] ?? "(nothing)"}\n    firmware : ${b[i] ?? "(nothing)"}`);
}
if (bad) {
  console.log(`\nPARITY FAILED — ${bad} line(s) differ. The host is written against the simulator;`);
  console.log("a simulator that disagrees with the board is worse than no simulator.");
  process.exit(1);
}
console.log(`protocol parity OK — ${a.length} replies identical across ${lines.length} commands`);
