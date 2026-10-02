/**
 * Dead-export audit for the credential- and quota-sensitive modules.
 *
 * Phase 5 requires that no UNUSED credential-handling code survives in
 * production. This walks the real import graph (not a regex over one file, which
 * is how the first attempt produced nonsense) and reports exports nothing
 * imports.
 *
 * Run: node scripts/audit-dead-exports.cjs
 */

const fs = require("node:fs");
const path = require("node:path");

const SKIP = new Set(["node_modules", ".next", ".git", "dist", ".pm2", "coverage"]);

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const files = [...walk("src"), ...walk("scripts"), ...walk("tests")].filter((f) =>
  /\.(ts|tsx)$/.test(f),
);
const sources = files.map((f) => ({ f, s: fs.readFileSync(f, "utf8") }));

const MODULES = [
  "src/lib/encryption.ts",
  "src/lib/warmup/imap.ts",
  "src/lib/warmup/service.ts",
  "src/lib/warmup/worker.ts",
  "src/lib/warmup/messages.ts",
  "src/lib/warmup/pool.ts",
  "src/lib/warmup/validation.ts",
  "src/lib/smtp.ts",
  "src/lib/quota.ts",
];

let anyDead = false;

for (const mod of MODULES) {
  if (!fs.existsSync(mod)) {
    console.log(`  MISSING  ${mod}`);
    continue;
  }
  const self = sources.find((o) => o.f === mod.split("/").join(path.sep) || o.f === mod);
  const names = new Set();
  const add = (n) => {
    if (n) names.add(n);
  };
  for (const m of self.s.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)) add(m[1]);
  for (const m of self.s.matchAll(/export\s+(?:const|let|var)\s+(\w+)/g)) add(m[1]);
  for (const m of self.s.matchAll(/export\s+class\s+(\w+)/g)) add(m[1]);
  for (const m of self.s.matchAll(/export\s+(?:type|interface)\s+(\w+)/g)) add(m[1]);

  // Two very different situations look alike from outside the file:
  //
  //   DEAD          the name appears nowhere except its own `export` line, so
  //                 nothing in the repo can ever reach it.
  //   internal-only the file uses it itself and merely exports it. Harmless,
  //                 but still API surface with no consumer.
  //
  // Conflating them is exactly what made the first version of this audit call
  // `warmupBounds` dead when it is referenced a dozen times beneath its own
  // definition.
  const dead = [];
  const internalOnly = [];
  for (const name of names) {
    const re = new RegExp("\\b" + name + "\\b");
    if (sources.some((o) => o.f !== self.f && re.test(o.s))) continue;

    // NOTE: the counting match MUST be global. `String.match` with a
    // non-global regex returns only the first hit, which made every internal
    // use invisible and reported the whole codebase as dead.
    const selfHits = (self.s.match(new RegExp("\\b" + name + "\\b", "g")) || []).length;
    const definedHere = new RegExp("export[\\s\\S]{0,80}?\\b" + name + "\\b").test(self.s);
    if (selfHits - (definedHere ? 1 : 0) > 0) internalOnly.push(name);
    else dead.push(name);
  }

  if (dead.length) {
    anyDead = true;
    console.log(`  DEAD (${dead.length})  ${mod}`);
    for (const n of dead) console.log(`      - ${n}`);
  } else {
    console.log(`  no dead exports  ${mod}  (${names.size} exports)`);
  }
  if (internalOnly.length) {
    console.log(`      internal-only (exported, never imported elsewhere): ${internalOnly.join(", ")}`);
  }
}

console.log(anyDead ? "\nRESULT: DEAD exports found" : "\nRESULT: no dead exports");