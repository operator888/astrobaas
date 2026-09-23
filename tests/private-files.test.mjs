#!/usr/bin/env node
/**
 * Files a stranger uploads through a public form (C-23).
 *
 * The feature is not "an upload endpoint". It is WHERE THE BYTES GO.
 *
 * `public/uploads` is served by Astro's static handler in dev and by a reverse
 * proxy in most production deployments — the `/uploads/[...path]` route only
 * gets a look in a standalone Node build. So a file written there is readable
 * at its URL whatever the record's read policy says, and a content type marked
 * `visibility: 'staff'` collecting CVs, prescriptions or ID scans would have
 * been publishing them while its own settings screen said "staff only".
 *
 * Run with:  node tests/private-files.test.mjs
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadTs } from './lib/load.mjs';

// A directory of its own, so the test never writes near the repo's uploads.
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astrobaas-private-'));
process.env.PRIVATE_UPLOADS_DIR = dir;

const P = await loadTs('src/lib/media/private-files.ts');
const PATHS = await loadTs('src/lib/paths.ts');

let passed = 0;
const failures = [];
async function check(name, fn) {
  try { await fn(); passed += 1; }
  catch (err) { failures.push(`${name}: ${err.message}`); }
}
function eq(a, b, what = '') {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${what} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
}

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n', 'ascii');

// ────────────────────────────────────────────── the location IS the feature

await check('THE POINT: the private directory is NOT under public/uploads', () => {
  const priv = PATHS.getPrivateUploadsDir();
  const pub = PATHS.getUploadsDir();
  if (priv === pub) throw new Error('the same directory');
  if (priv.startsWith(pub + path.sep)) throw new Error('inside the public one');
  // The other direction matters too: a public dir inside the private one would
  // be served by the static handler with the private files beneath it.
  if (pub.startsWith(priv + path.sep)) throw new Error('the public dir is inside the private one');
});

await check('a stored file lands in the private directory and nowhere else', async () => {
  const r = await P.storePrivateFile(PNG, 'cv.png');
  if (!r.ok) throw new Error(r.error);
  const found = await fs.readFile(path.join(dir, r.file.rel));
  eq(found.length, PNG.length);
});

// ────────────────────────────────────────────────────── what is accepted

await check('the type is decided by the BYTES, not the name', async () => {
  // The uploader controls the filename and the Content-Type. Neither is
  // evidence, and trusting either is how an HTML polyglot arrives as
  // "photo.png".
  const r = await P.storePrivateFile(PNG, 'evil.exe');
  if (!r.ok) throw new Error(r.error);
  eq(r.file.mime_type, 'image/png');
  if (!r.file.rel.endsWith('.png')) throw new Error(r.file.rel);
});

await check('a PDF is accepted', async () => {
  const r = await P.storePrivateFile(PDF, 'letter.pdf');
  if (!r.ok) throw new Error(r.error);
  eq(r.file.mime_type, 'application/pdf');
});

await check('an SVG is REFUSED, unlike in the media library', async () => {
  // The library accepts one because an editor chose it deliberately and it is
  // sanitised on the way in. An SVG is a document that can carry script, and
  // this door is anonymous.
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'utf8');
  const r = await P.storePrivateFile(svg, 'x.svg');
  if (r.ok) throw new Error('accepted an SVG');
});

await check('a script, a zip and an empty file are refused', async () => {
  for (const [buf, what] of [
    [Buffer.from('#!/bin/sh', 'utf8'), 'a shell script'],
    [Buffer.from('PK', 'binary'), 'a zip'],
    [Buffer.alloc(0), 'nothing'],
  ]) {
    const r = await P.storePrivateFile(buf, 'x');
    if (r.ok) throw new Error(`accepted ${what}`);
  }
});

await check('an oversized file is refused, and the message says the limit', async () => {
  const big = Buffer.concat([PNG, Buffer.alloc(P.MAX_SUBMISSION_FILE_SIZE)]);
  const r = await P.storePrivateFile(big, 'big.png');
  if (r.ok) throw new Error('accepted an oversized file');
  if (!/MB/.test(r.error)) throw new Error(r.error);
});

// ────────────────────────────────────────────────────────── the id

await check('the id is derived from the BYTES, so it cannot be guessed', async () => {
  const a = await P.storePrivateFile(PNG, 'one.png');
  const b = await P.storePrivateFile(PNG, 'two.png');
  eq(a.file.id, b.file.id, 'the same bytes are one file');
  if (!P.isPrivateFileId(a.file.id)) throw new Error(a.file.id);
});

await check('the id carries a prefix a media-library id never has', () => {
  // The two must never be confused: one points into the public library, the
  // other at a file only an authenticated route can serve.
  if (!P.isPrivateFileId('pf_0123456789abcdef0123')) throw new Error('rejected a valid id');
  for (const bad of ['abc-123', 'pf_short', 'pf_' + 'g'.repeat(20), '', null, 42, '../../etc/passwd']) {
    if (P.isPrivateFileId(bad)) throw new Error(`accepted ${String(bad)}`);
  }
});

// ────────────────────────────────────────────────────── reading it back

await check('metadata and bytes round-trip', async () => {
  const r = await P.storePrivateFile(PDF, 'Θεραπεία.pdf');
  const meta = await P.readPrivateFileMeta(r.file.id);
  eq(meta.original_name, 'Θεραπεία.pdf', 'a Greek filename survives');
  const bytes = await P.readPrivateFile(meta);
  eq(bytes.length, PDF.length);
});

await check('a filename cannot carry a path or break a header', async () => {
  // It goes into Content-Disposition. A quote or a newline there splits the
  // header; a slash would be a path if anything ever used it as one.
  const nasty = '../../etc/pa' + String.fromCharCode(34) + 'ss' + String.fromCharCode(10) + 'wd.png';
  const r = await P.storePrivateFile(PNG, nasty);
  if (/[/\\]/.test(r.file.original_name)) throw new Error(r.file.original_name);
  if (r.file.original_name.includes(String.fromCharCode(34))) throw new Error(r.file.original_name);
  if (r.file.original_name.includes(String.fromCharCode(10))) throw new Error(r.file.original_name);
});

await check('an unknown id reads back as nothing rather than throwing', async () => {
  eq(await P.readPrivateFileMeta('pf_ffffffffffffffffffff'), null);
  eq(await P.readPrivateFileMeta('not-an-id'), null);
  eq(await P.readPrivateFileMeta(undefined), null);
});

await check('a sidecar pointing OUTSIDE the private root reads nothing', async () => {
  // `rel` comes from a file we wrote, but a restored or hand-edited archive
  // must not be able to turn this into an arbitrary file reader.
  eq(await P.readPrivateFile({ id: 'pf_0123456789abcdef0123', rel: '../../../etc/passwd' }), null);
});

// ──────────────────────────────────────────────────────────── erasure

await check('deleting removes the bytes AND the sidecar', async () => {
  const r = await P.storePrivateFile(PDF, 'erase-me.pdf');
  eq(await P.deletePrivateFile(r.file.id), true);
  eq(await P.readPrivateFileMeta(r.file.id), null);
  let stillThere = true;
  try { await fs.access(path.join(dir, r.file.rel)); } catch { stillThere = false; }
  if (stillThere) throw new Error('the bytes are still on disk after an erasure');
});

await check('deleting something that is not there is not an error', async () => {
  eq(await P.deletePrivateFile('pf_ffffffffffffffffffff'), false);
  eq(await P.deletePrivateFile(null), false);
});

await fs.rm(dir, { recursive: true, force: true });

if (failures.length) {
  console.error(`\n✗ private-files: ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error(`  · ${f}`);
  process.exit(1);
}
console.log(`✓ private-files: ${passed} passed`);
