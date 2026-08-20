#!/usr/bin/env node
/**
 * Do the two halves of the IPC surface agree? (ADR-0033)
 *
 * Three failure modes, none of which any other check can see:
 *   - **a duplicate `ipcMain.handle`** throws at startup, so the app is dead
 *     before the window opens;
 *   - **a preload method invoking a channel nobody handles** fails only when
 *     the operator clicks the thing, which on a shoot is the worst possible
 *     moment to find out;
 *   - **a handler nothing invokes** is dead weight, and usually the leftover of
 *     a rename that half-landed.
 *
 * Text matching, deliberately: both files declare their channels as string
 * literals, and a parser here would be more machinery than the problem.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../apps/jog-slice");
const main = fs.readFileSync(path.join(APP, "main.js"), "utf-8");
const preload = fs.readFileSync(path.join(APP, "preload.cjs"), "utf-8");

const handled = [...main.matchAll(/ipcMain\.handle\(\s*"([^"]+)"/g)].map((m) => m[1]);
const invoked = [...preload.matchAll(/ipcRenderer\.invoke\(\s*"([^"]+)"/g)].map((m) => m[1]);

const duplicates = [...new Set(handled.filter((c, i) => handled.indexOf(c) !== i))];
const unhandled = [...new Set(invoked.filter((c) => !handled.includes(c)))];
const uninvoked = handled.filter((c) => !invoked.includes(c));

console.log(`${handled.length} handlers, ${new Set(invoked).size} channels invoked from preload`);

const problems = [
  ...duplicates.map((c) => `"${c}" is registered twice — ipcMain.handle throws on that, so the app would not start`),
  ...unhandled.map((c) => `preload invokes "${c}", which main does not handle — this fails only when somebody clicks it`),
  ...uninvoked.map((c) => `main handles "${c}", which nothing invokes`),
];

if (problems.length) {
  console.log("\nIPC SURFACE DOES NOT AGREE:");
  for (const p of problems) console.log("  " + p);
  process.exit(1);
}
console.log("every channel is handled once and invoked once.");
