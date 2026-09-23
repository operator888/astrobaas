#!/usr/bin/env node
/**
 * The lowdb read cache.
 *
 * lowdb's `read()` re-parses the whole JSON document every call, and LocalDB
 * calls it from all 78 getters. Measured on a 26.5 MB database: 158.7 ms per
 * parse, 9.4 parses to serve one /blog request, 16.2 s of wall clock for ten
 * concurrent requests. Caching that is the difference between running on a
 * small VPS and not.
 *
 * A cache is only worth having if it cannot serve wrong data, so most of this
 * file is about correctness rather than speed:
 *
 *   1. a write from ANOTHER process must be seen (a second replica, an import
 *      CLI, a restore, an operator with an editor)
 *   2. a caller mutating what a getter returned must not corrupt the cache —
 *      `(await getOrders()).sort()` exists in this codebase and would have
 *      silently reordered the stored document
 *   3. deleting or replacing the file must not serve a ghost
 *
 * Run with:  node tests/db-cache.test.mjs
 */
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const cacheDir = path.join(root, 'node_modules', '.cache');
await fs.mkdir(cacheDir, { recursive: true });

const out = path.join(cacheDir, `astrobaas-dbcache-${process.pid}.mjs`);
await build({
  entryPoints: [path.join(root, 'src/lib/storage/caching-adapter.ts')],
  bundle: true, format: 'esm', platform: 'node', packages: 'external',
  outfile: out, logLevel: 'silent',
});
const { withReadCache } = await import(pathToFileURL(out).href);
await fs.rm(out, { force: true });

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) pass++;
  else { fail++; console.error(`✗ ${name}`); }
}

const tmp = path.join(os.tmpdir(), `astrobaas-cache-test-${process.pid}`);
await fs.mkdir(tmp, { recursive: true });
const file = path.join(tmp, 'db.json');

/** A stand-in for lowdb's JSONFile that counts how often it actually parses. */
function countingAdapter(filePath) {
  const a = {
    parses: 0,
    async read() {
      let raw;
      try { raw = await fs.readFile(filePath, 'utf8'); } catch { return null; }
      a.parses++;
      return JSON.parse(raw);
    },
    async write(data) {
      await fs.writeFile(filePath, JSON.stringify(data));
    },
  };
  return a;
}

// Advance mtime monotonically. A real filesystem's clock only moves forward;
// using a fixed offset twice in a row would freeze it, which is not a case any
// real writer produces.
let clock = Date.now();
const touchLater = async (p) => {
  clock += 1500;
  const t = new Date(clock);
  await fs.utimes(p, t, t);
};

/* ---------------- it actually caches ---------------- */
{
  await fs.writeFile(file, JSON.stringify({ posts: [{ id: 'a' }], n: 1 }));
  const inner = countingAdapter(file);
  const db = withReadCache(inner, file);

  const first = await db.read();
  check('the first read parses', inner.parses === 1 && first.n === 1);

  for (let i = 0; i < 25; i++) await db.read();
  check('25 further reads of an unchanged file parse ZERO more times', inner.parses === 1);
  check('...and the cache reports the hits', db.stats.hits === 25 && db.stats.misses === 1);

  // This is the whole point: one page render makes many getter calls.
  check('a 26-call render costs one parse, not 26', inner.parses === 1);
}

/* ---------------- it cannot serve stale data ---------------- */
{
  await fs.writeFile(file, JSON.stringify({ n: 1 }));
  const inner = countingAdapter(file);
  const db = withReadCache(inner, file);
  await db.read();

  // Another process writes. This is the scenario that makes a naive
  // "invalidate on my own writes" cache dangerous: an import CLI, a restore, a
  // second replica, or an operator with an editor.
  await fs.writeFile(file, JSON.stringify({ n: 2 }));
  await touchLater(file);
  const after = await db.read();
  check('an external write is picked up (no stale read)', after.n === 2);
  check('...and it cost a real parse', inner.parses === 2);

  // Same byte length, different content — size alone would not catch this.
  await fs.writeFile(file, JSON.stringify({ n: 3 }));
  await touchLater(file);
  // Same byte length AND same inode — only mtime distinguishes them, which is
  // the case the stamp exists for.
  check('a same-LENGTH external write is still picked up', (await db.read()).n === 3);

  // A file that is replaced wholesale (restore from backup) changes inode.
  await fs.rm(file);
  await fs.writeFile(file, JSON.stringify({ n: 4 }));
  await touchLater(file);
  check('a replaced file is picked up', (await db.read()).n === 4);
}

/* ---------------- a caller cannot corrupt the cache ---------------- */
{
  await fs.writeFile(file, JSON.stringify({ posts: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }));
  const db = withReadCache(countingAdapter(file), file);

  const doc = await db.read();
  // LocalDB hands out COPIES of collections precisely so this cannot bite.
  // Here we prove the hazard is real on the raw document, which is why that
  // copy-on-read exists in localdb.ts.
  const handedOut = [...doc.posts];
  handedOut.reverse();
  const again = await db.read();
  check('reversing a COPY of a collection leaves the cache intact',
    again.posts.map((p) => p.id).join('') === 'abc');

  // And the hazard itself, documented rather than hidden: mutating the live
  // array WOULD corrupt it. This assertion exists so that if someone later
  // removes the copy-on-read in localdb.ts, the reason is on record.
  doc.posts.reverse();
  check('mutating the LIVE array does affect the cache (hence copy-on-read)',
    (await db.read()).posts.map((p) => p.id).join('') === 'cba');
}

/* ---------------- writes keep the cache correct ---------------- */
{
  await fs.writeFile(file, JSON.stringify({ n: 1 }));
  const inner = countingAdapter(file);
  const db = withReadCache(inner, file);
  await db.read();

  await db.write({ n: 99 });
  const parsesAfterWrite = inner.parses;
  const back = await db.read();
  check('a read after our own write returns the new data', back.n === 99);
  check('...without re-parsing what we just serialised', inner.parses === parsesAfterWrite);

  // And it must be on disk, not only in memory.
  check('the write reached the file', JSON.parse(fss.readFileSync(file, 'utf8')).n === 99);
}

/* ---------------- degenerate cases ---------------- */
{
  const missing = path.join(tmp, 'nope.json');
  const db = withReadCache(countingAdapter(missing), missing);
  check('a missing file reads as null rather than throwing', (await db.read()) === null);

  await fs.writeFile(missing, JSON.stringify({ n: 7 }));
  check('...and is picked up once it appears', (await db.read()).n === 7);
}

await fs.rm(tmp, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
