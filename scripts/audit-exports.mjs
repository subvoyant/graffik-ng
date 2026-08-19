/*
 * Dead-export audit — is every public symbol in the core actually reachable
 * from the product?
 *
 * The bug this exists for: a function exported, tested, passing, and callable
 * by nothing. It LOOKS covered. `degreesFromLaser` shipped that way in v0.13
 * and was caught by luck during a render review. This replaces the luck.
 *
 *     node scripts/audit-exports.mjs [--strict]
 *
 * HOW IT DECIDES
 * --------------
 * Reachability is a fixpoint over symbol bodies, not a flat name search:
 *
 *   seed      = core symbols named anywhere in the app, preload or CLI
 *   expand    = if a reachable symbol's BODY names another core symbol,
 *               that one is reachable too
 *   repeat    until nothing new
 *
 * Per-symbol bodies rather than per-file, deliberately: `degreesFromLaser`
 * lives in commission.ts beside `fitCalibration`, which the app does use, so a
 * file-level rule would have missed exactly the bug it was written for.
 *
 * TYPES ARE EXCLUDED. `interface`/`type` exports are consumed by the type
 * system, and the app is plain JavaScript that never names them — "unreferenced"
 * is the expected and correct state for those, so flagging them is noise that
 * would get the whole check ignored.
 *
 * A text scan, not a real TS program: it must run in CI with no extra
 * dependency, and a name that appears in no consumer's source text is not being
 * used by that consumer whatever the compiler believes.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const strict = process.argv.includes("--strict");

const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    statSync(p).isDirectory() ? walk(p, out) : out.push(p);
  }
  return out;
};

const SRC = join(root, "packages/nmx-protocol/src");
const srcFiles = walk(SRC).filter((f) => f.endsWith(".ts") && !f.endsWith("index.ts"));

/* ---- 1. every top-level declaration, with its body text ----
   PRIVATE helpers are included in the graph (never reported). A symbol used
   only by a module-private function is genuinely reachable, and walking only
   exported bodies made `SubAddress` — used by commands.ts's private packet
   builders — look dead. */
/* `const enum` is two keywords before the name — matching only the first
   produced a phantom export literally called "enum". */
const DECL = /^(export\s+)?(?:declare\s+)?(?:async\s+)?(?:const\s+enum|const|let|var|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm;

const symbols = new Map();      // name -> { file, kind, body }
for (const file of srcFiles) {
  const text = readFileSync(file, "utf-8");
  const hits = [...text.matchAll(DECL)];
  hits.forEach((m, i) => {
    const start = m.index;
    const end = i + 1 < hits.length ? hits[i + 1].index : text.length;
    const kind = /^(?:export\s+)?(?:declare\s+)?(?:async\s+)?(\w+)/.exec(m[0])[1];
    symbols.set(m[2], {
      file: file.slice(root.length + 1),
      kind,
      exported: Boolean(m[1]),
      body: text.slice(start, end),
    });
  });
}
const isValue = (s) => s.kind !== "interface" && s.kind !== "type";
/** Reported on. */
const values = [...symbols.entries()].filter(([, s]) => s.exported && isValue(s));
/** Walked, never reported — private helpers are part of the graph. */
const graph = [...symbols.entries()].filter(([, s]) => isValue(s));

/* ---- 2. what the PRODUCT names ---- */
const productText = [
  ...walk(join(root, "apps/jog-slice")).filter((f) => /\.(js|cjs|mjs|html)$/.test(f)),
  ...walk(join(root, "packages/nmx-cli")).filter((f) => f.endsWith(".js")),
].map((f) => readFileSync(f, "utf-8")).join("\n");

const testText = walk(join(root, "packages/nmx-protocol/test"))
  .filter((f) => f.endsWith(".ts")).map((f) => readFileSync(f, "utf-8")).join("\n");

const named = (text, name) => new RegExp(`\\b${name.replace(/\$/g, "\\$")}\\b`).test(text);

/* ---- 3. fixpoint ---- */
const reachable = new Set(graph.filter(([n]) => named(productText, n)).map(([n]) => n));
for (let changed = true; changed; ) {
  changed = false;
  for (const name of [...reachable]) {
    const body = symbols.get(name)?.body;
    if (!body) continue;
    for (const [other] of graph) {
      if (reachable.has(other) || other === name) continue;
      if (named(body, other)) { reachable.add(other); changed = true; }
    }
  }
}

/* ---- 4. report ---- */
const dead = values.filter(([n]) => !reachable.has(n))
  .map(([name, s]) => ({ name, file: s.file, testOnly: named(testText, name) }));
const testOnly = dead.filter((d) => d.testOnly);
const orphans = dead.filter((d) => !d.testOnly);

const typeCount = symbols.size - values.length;
console.log(
  `${values.length} exported values across ${srcFiles.length} core modules ` +
  `(${typeCount} type-only exports skipped — the app is JS and never names them)`,
);
console.log(`${values.filter(([n]) => reachable.has(n)).length} of them reachable from the product`);

const show = (title, rows) => {
  if (!rows.length) return;
  console.log(`\n${title}`);
  for (const r of rows) console.log(`  ${r.file.padEnd(38)} ${r.name}`);
};
show("TESTED BUT UNREACHABLE — looks covered, the product cannot call it:", testOnly);
show("UNREFERENCED BY ANYTHING:", orphans);

if (!dead.length) console.log("\nno dead exports.");
else console.log(`\n${testOnly.length} tested-but-unreachable · ${orphans.length} unreferenced`);
process.exit(strict && dead.length ? 1 : 0);
