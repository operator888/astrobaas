#!/usr/bin/env node
/**
 * Does `node_modules` actually match `package-lock.json`?
 *
 * CI runs `npm ci`, which installs the lockfile exactly. A developer's tree
 * drifts: `npm install` at a different time, a branch switch across a lockfile
 * bump, an interrupted install. Nothing warns about it, and every local check
 * then grades a DIFFERENT dependency tree than the one CI will grade.
 *
 * That is not hypothetical. `@types/node` sat at 20.19.43 on disk while the
 * lockfile said 26.4.0, and the gate reported GREEN while CI reported
 * `src/lib/backup/s3.ts:47 - error ts(2345)` — a real type error, in committed
 * code, that the local type-checker could not see because it was reading
 * three-year-old type definitions. The gate was honest about what it ran; what
 * it ran was the wrong thing. A green gate that cannot see a red CI is worse
 * than no gate, because it is trusted.
 *
 * Run with:  node scripts/check-deps.mjs
 * Exits 1 and names the drift. `npm ci` is the fix.
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');

const lockPath = path.join(root, 'package-lock.json');
if (!fs.existsSync(lockPath)) {
  console.error('no package-lock.json — nothing to compare against');
  process.exit(1);
}
const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
const packages = lock.packages ?? {};

const missing = [];
const mismatched = [];
let checked = 0;

for (const [key, entry] of Object.entries(packages)) {
  // "" is the root project itself, and it has no version to install.
  if (!key.startsWith('node_modules/')) continue;
  // Link entries point at a workspace on disk rather than a published tarball.
  if (entry.link) continue;
  // No version means nothing to compare (aliases, some peer records).
  if (!entry.version) continue;

  const dir = path.join(root, key);
  const manifest = path.join(dir, 'package.json');

  if (!fs.existsSync(manifest)) {
    /*
     * Optional dependencies are ALLOWED to be absent, and most of the ones
     * here are platform-specific native binaries: the lockfile carries
     * @rollup/rollup-linux-x64-gnu and @img/sharp-linux-x64 alongside the
     * darwin builds, and a mac will never have the linux ones. Reporting those
     * as drift would make this script cry wolf on every machine and get
     * ignored, which is the failure mode a checker like this has to avoid
     * above all others.
     */
    if (entry.optional || entry.devOptional) continue;
    missing.push(key);
    continue;
  }

  checked += 1;
  const installed = JSON.parse(fs.readFileSync(manifest, 'utf8')).version;
  if (installed !== entry.version) {
    mismatched.push({ key, want: entry.version, got: installed });
  }
}

if (!missing.length && !mismatched.length) {
  console.log(`node_modules matches package-lock.json (${checked} packages checked)`);
  process.exit(0);
}

console.error('node_modules DOES NOT match package-lock.json.\n');
console.error('This machine would run the checks against a different dependency');
console.error('tree than CI, so a green result here would not mean CI is green.\n');

// The wrong-version case first: it is the one that silently changes behaviour,
// where a missing package usually fails loudly on import.
for (const m of mismatched.slice(0, 25)) {
  console.error(`  ${m.key}\n      lockfile: ${m.want}\n      installed: ${m.got}`);
}
if (mismatched.length > 25) console.error(`  … and ${mismatched.length - 25} more`);

for (const k of missing.slice(0, 25)) console.error(`  ${k} — not installed`);
if (missing.length > 25) console.error(`  … and ${missing.length - 25} more`);

console.error('\nFix:  npm ci');
process.exit(1);
