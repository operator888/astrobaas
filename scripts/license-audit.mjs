#!/usr/bin/env node
/**
 * Refuse to ship a dependency whose licence would break the business model.
 *
 *   npm run audit:licenses
 *
 * ## Why this is a build gate and not a spreadsheet
 *
 * AstroBaaS is GPL-3.0 and funded by selling proprietary modules on top of it.
 * That works because the Owner holds the copyright to the core (see CLA.md) —
 * but it also depends on every DEPENDENCY being licensed permissively enough to
 * redistribute inside a commercial product.
 *
 * One transitive dependency under AGPL-3.0 or SSPL ends that, quietly, on the
 * day someone runs `npm install`. Nothing would fail. The paid module would
 * simply have become unsellable, and nobody would find out until a customer's
 * lawyer asked.
 *
 * So the production tree is checked, and an unexpected copyleft licence fails
 * the build.
 *
 * ## What is checked, and what is not
 *
 * ONLY the production dependency tree (`npm ls --omit=dev`). A GPL test runner
 * is not a GPL product: devDependencies are never redistributed, and treating
 * them the same way trains people to ignore the job.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Licences that would make the core unsellable as part of a proprietary
 * product, or would force the whole combined work open.
 */
const FORBIDDEN = ['AGPL', 'SSPL', 'CPAL', 'OSL', 'EUPL', 'CC-BY-SA', 'CC-BY-NC', 'BUSL', 'ELASTIC'];

/**
 * Weak copyleft. Allowed, because dynamic linking against an LGPL library is
 * exactly what the LGPL is for — but it carries obligations (source
 * availability, notice, the right to relink), so each one has to be a decision
 * somebody made rather than something that arrived.
 *
 * Every entry here must also be listed in THIRD-PARTY-NOTICES.md.
 */
const ACKNOWLEDGED_WEAK_COPYLEFT = new Set([
  // libvips, the image library sharp wraps. Loaded as a shared library at
  // runtime; see THIRD-PARTY-NOTICES.md for the written offer of source.
  '@img/sharp-libvips-darwin-arm64',
  '@img/sharp-libvips-darwin-x64',
  '@img/sharp-libvips-linux-arm',
  '@img/sharp-libvips-linux-arm64',
  '@img/sharp-libvips-linux-ppc64',
  '@img/sharp-libvips-linux-riscv64',
  '@img/sharp-libvips-linux-s390x',
  '@img/sharp-libvips-linux-x64',
  '@img/sharp-libvips-linuxmusl-arm64',
  '@img/sharp-libvips-linuxmusl-x64',
  '@img/sharp-wasm32',
  '@img/sharp-freebsd-wasm32',
  '@img/sharp-webcontainers-wasm32',
]);

const WEAK_COPYLEFT = ['LGPL', 'MPL', 'CDDL', 'EPL'];

/** The project's own packages, which have no third-party licence to check. */
const OWN_SCOPE = '@astrobaas/';

function licenceOf(name) {
  const p = path.join('node_modules', name, 'package.json');
  if (!fs.existsSync(p)) return null; // Optional platform binary for another OS.
  let j;
  try { j = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return 'UNPARSEABLE'; }
  let lic = j.license;
  if (lic && typeof lic === 'object') lic = lic.type;
  if (!lic && Array.isArray(j.licenses) && j.licenses[0]) lic = j.licenses[0].type;
  return lic || 'UNKNOWN';
}

function productionTree() {
  // `npm ls` EXITS NON-ZERO whenever the tree has any complaint at all — an
  // extraneous package, a linked local module, a peer mismatch — while still
  // printing a perfectly good tree on stdout. A developer with a `npm link`ed
  // module in place would otherwise see this gate crash rather than run.
  let out;
  try {
    out = execFileSync('npm', ['ls', '--omit=dev', '--all', '--json'], {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (err) {
    out = err.stdout;
    if (!out) throw err;
  }
  const tree = JSON.parse(out);
  const names = new Set();
  (function walk(node) {
    for (const [name, meta] of Object.entries(node.dependencies || {})) {
      if (names.has(name)) continue;
      names.add(name);
      walk(meta);
    }
  })(tree);
  return [...names].sort();
}

const names = productionTree();
const forbidden = [];
const unacknowledged = [];
const acknowledged = [];
const unknown = [];
const counts = new Map();

for (const name of names) {
  if (name.startsWith(OWN_SCOPE)) continue;
  const lic = licenceOf(name);
  if (lic === null) continue; // not installed on this platform
  counts.set(lic, (counts.get(lic) ?? 0) + 1);
  const up = String(lic).toUpperCase();

  if (FORBIDDEN.some((f) => up.includes(f))) { forbidden.push([name, lic]); continue; }
  if (WEAK_COPYLEFT.some((w) => up.includes(w))) {
    (ACKNOWLEDGED_WEAK_COPYLEFT.has(name) ? acknowledged : unacknowledged).push([name, lic]);
    continue;
  }
  if (up === 'UNKNOWN' || up === 'UNPARSEABLE') unknown.push([name, lic]);
}

console.log(`Production dependency tree: ${names.length} packages\n`);
for (const [lic, n] of [...counts].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  ${lic}`);
}

let failed = false;

if (forbidden.length) {
  failed = true;
  console.error('\n✗ FORBIDDEN licences in the production tree.');
  console.error('  These make the core unsellable as part of a proprietary product.');
  for (const [n, l] of forbidden) console.error(`    ${n}: ${l}`);
}

if (unacknowledged.length) {
  failed = true;
  console.error('\n✗ UNACKNOWLEDGED weak copyleft.');
  console.error('  Allowed, but it carries obligations. Add it to THIRD-PARTY-NOTICES.md');
  console.error('  and to ACKNOWLEDGED_WEAK_COPYLEFT in this script, then re-run.');
  for (const [n, l] of unacknowledged) console.error(`    ${n}: ${l}`);
}

if (unknown.length) {
  failed = true;
  console.error('\n✗ UNKNOWN licence. A package that does not say cannot be assumed permissive.');
  for (const [n, l] of unknown) console.error(`    ${n}: ${l}`);
}

if (acknowledged.length) {
  console.log('\n  Weak copyleft, acknowledged in THIRD-PARTY-NOTICES.md:');
  for (const [n, l] of acknowledged) console.log(`    ${n}: ${l}`);
}

console.log(failed ? '\nFAILED' : '\n✓ Nothing in the production tree blocks commercial redistribution.');
process.exit(failed ? 1 : 0);
