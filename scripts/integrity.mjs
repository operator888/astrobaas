#!/usr/bin/env node
/**
 * The deployed-file checksum manifest (C-82).
 *
 *   node scripts/integrity.mjs generate [dir]   write <dir>/integrity.json
 *   node scripts/integrity.mjs verify   [dir]   compare it to what is there now
 *
 * `dir` defaults to `dist` — what actually runs. Exit code 1 on any difference,
 * so `verify` drops straight into a cron job or a deploy check.
 *
 * ## Record the digest somewhere that is not this server
 *
 * Both commands print `manifest digest: <sha256>`. The manifest lives beside
 * the files it describes, so on its own it proves nothing against somebody with
 * write access — they would rewrite both. The digest, written down off-box, is
 * what turns this into a check that can actually fail for an attacker.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadTs, ROOT } from './lib/load-ts.mjs';

// The REAL module, through the shared loader every maintenance script uses —
// not a second copy of the hashing rules here. A verifier that re-spells them
// is a verifier that eventually disagrees with the generator, and the symptom
// would be an integrity alert nobody can explain.
const I = await loadTs('src/lib/integrity.ts');

const MANIFEST_NAME = 'integrity.json';

/**
 * Every file under `dir`, relative and forward-slashed.
 *
 * SYMLINKS COUNT. `readdir` returns lstat-semantics entries, so a symlink is
 * neither `isFile()` nor `isDirectory()` — and the first version of this walk
 * therefore skipped them entirely. `dist/shell.js -> /tmp/payload.js` was not
 * hashed, not reported as added, and not reported as removed: invisible to
 * every command, which is the one thing this tool must never be.
 *
 * A symlink is recorded by its TARGET PATH rather than by the bytes it points
 * at. Following it would mean hashing something outside the tree — and the
 * interesting fact about a symlink in a deployment is where it points, not
 * what is there this second.
 */
async function walk(dir, base = dir, out = []) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    const rel = path.relative(base, abs).split(path.sep).join('/');
    if (entry.isSymbolicLink()) out.push({ rel, link: true, abs });
    else if (entry.isDirectory()) await walk(abs, base, out);
    else if (entry.isFile()) out.push({ rel, link: false, abs });
    // Anything else — a socket, a fifo, a device node — is reported rather
    // than skipped: none of them belong in a build output.
    else out.push({ rel, link: false, abs, odd: true });
  }
  return out;
}

async function hashTree(dir) {
  const entries = (await walk(dir))
    .filter((e) => e.rel !== MANIFEST_NAME)
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  // Null-prototype, for the same reason the manifest is: `out['__proto__'] = h`
  // on a plain object is a silent no-op, so a file with that name would never
  // be hashed at all.
  const out = Object.create(null);
  for (const entry of entries) {
    if (entry.link) {
      // The target path, marked so it can never collide with a real hash.
      out[entry.rel] = `symlink:${I.hashBuffer(await fs.readlink(entry.abs))}`;
    } else if (entry.odd) {
      out[entry.rel] = 'not-a-regular-file';
    } else {
      out[entry.rel] = I.hashBuffer(await fs.readFile(entry.abs));
    }
  }
  return out;
}

const [, , command = 'verify', dirArg = 'dist'] = process.argv;
const dir = path.resolve(ROOT, dirArg);

try {
  await fs.access(dir);
} catch {
  console.error(`✗ ${dirArg} does not exist. Run \`npm run build\` first.`);
  process.exit(1);
}

if (command === 'generate') {
  const actual = await hashTree(dir);
  const manifest = I.buildManifest(Object.entries(actual), new Date().toISOString());
  await fs.writeFile(path.join(dir, MANIFEST_NAME), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`✓ ${Object.keys(manifest.files).length} files recorded in ${dirArg}/${MANIFEST_NAME}`);
  console.log(`  manifest digest: ${I.manifestDigest(manifest)}`);
  console.log('  Record that digest somewhere that is NOT this server.');
  process.exit(0);
}

if (command === 'verify') {
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(path.join(dir, MANIFEST_NAME), 'utf8'));
  } catch {
    console.error(`✗ no ${dirArg}/${MANIFEST_NAME}. Generate one at deploy time:`);
    console.error('    node scripts/integrity.mjs generate');
    process.exit(1);
  }
  const diff = I.diffManifest(manifest, await hashTree(dir));
  console.log(`  manifest digest: ${I.manifestDigest(manifest)}`);
  if (diff.ok) {
    console.log(`✓ ${I.describeDiff(diff)} — ${Object.keys(manifest.files).length} files`);
    process.exit(0);
  }
  console.error(`✗ ${I.describeDiff(diff)}`);
  for (const [label, list] of [['changed', diff.changed], ['added', diff.added], ['removed', diff.removed]]) {
    for (const p of list.slice(0, 50)) console.error(`  ${label.padEnd(7)} ${p}`);
    if (list.length > 50) console.error(`  ${label.padEnd(7)} …and ${list.length - 50} more`);
  }
  process.exit(1);
}

console.error(`Unknown command "${command}". Use generate or verify.`);
process.exit(1);
