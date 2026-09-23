#!/usr/bin/env node
/**
 * No test file may hold two copies of LocalDB.
 *
 * Tests compile TypeScript with esbuild, and each `load(...)` / `loadTs(...)`
 * call is a SEPARATE bundle that carries its own copy of everything it imports.
 * Load two modules that both reach src/lib/localdb.ts that way and the process
 * holds two LocalDB instances on one DB_PATH — two lowdb writers, one
 * `.db.json.tmp` — and when their writes overlap, one rename moves the other's
 * temp file away: ENOENT on rename. It failed the public CI once (2026-09-23,
 * tests/lib.test.mjs) and reproduces every time with concurrent writes; eight
 * test files had the shape.
 *
 * The fix is `loadTogether([...])` from tests/lib/load.mjs (one build,
 * `splitting: true`, one instance). This test finds any file that loads two or
 * more LocalDB-bearing modules through the separate-bundle helpers, by asking
 * esbuild what each module actually pulls in.
 *
 * What it cannot see: a hand-written `build({ entryPoints: [...] })` per module.
 * Those were all converted; a new one should use loadTogether instead.
 *
 * Run with:  node tests/test-harness-localdb.test.mjs
 */
import { buildSync } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
let fail = 0;
const check = (n, c, detail = '') => {
  if (c) pass++;
  else { fail++; console.error(`✗ ${n}${detail ? `\n    ${detail}` : ''}`); }
};

/** Helpers that compile ONE module per call. loadTogether is not one of them. */
const SEPARATE = /\b(?:load|loadTs)\(\s*['"](src\/[^'"]+\.ts)['"]/g;

const bearsDb = new Map();
function reachesLocalDb(rel) {
  if (!bearsDb.has(rel)) {
    let yes = false;
    try {
      const { metafile } = buildSync({
        entryPoints: [path.join(root, rel)], bundle: true, format: 'esm', platform: 'node',
        packages: 'external', write: false, metafile: true, logLevel: 'silent',
      });
      yes = Object.keys(metafile.inputs).some((i) => i.endsWith('src/lib/localdb.ts'));
    } catch { /* a module that does not build is some other test's problem */ }
    bearsDb.set(rel, yes);
  }
  return bearsDb.get(rel);
}

/** The LocalDB-bearing modules a source text loads separately. */
function separateDbLoads(source) {
  const rels = [...new Set([...source.matchAll(SEPARATE)].map((m) => m[1]))];
  return rels.filter(reachesLocalDb);
}

// The scanner must be able to fail: the shape that raced, and the shape that fixed it.
check('the scanner flags two separately loaded LocalDB-bearing modules',
  separateDbLoads(`const a = await load('src/lib/scheduler.ts', 's');\nconst b = await loadTs('src/lib/localdb.ts');`).length === 2);
check('...and does not flag the same modules loaded together',
  separateDbLoads(`const [a, b] = await loadTogether(['src/lib/scheduler.ts', 'src/lib/localdb.ts']);`).length === 0);
check('...nor a module that never reaches LocalDB',
  separateDbLoads(`const a = await load('src/lib/escape-html.ts', 'e'); const b = await load('src/lib/localdb.ts', 'd');`).length === 1);

// This file names the pattern in its own self-test above, so it scans everyone else.
const self = path.basename(fileURLToPath(import.meta.url));
const files = fs.readdirSync(path.join(root, 'tests')).filter((f) => f.endsWith('.mjs') && f !== self).sort();
check('there are test files to scan', files.length > 50);
for (const f of files) {
  const found = separateDbLoads(fs.readFileSync(path.join(root, 'tests', f), 'utf8'));
  check(`${f} holds at most one LocalDB`, found.length < 2,
    `separately bundled: ${found.join(', ')} — load them with loadTogether([...]) from ./lib/load.mjs`);
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
