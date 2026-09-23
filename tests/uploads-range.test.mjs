#!/usr/bin/env node
/**
 * `/uploads/**` streams byte ranges instead of reading the whole file (S5.3).
 *
 * ## The bug
 *
 * The route `fs.readFile`d the ENTIRE file before it looked at the Range
 * header. Safari sends `Range: bytes=0-1` before it plays any video, and a
 * scrub bar is a range request for the middle of the file — so every one of
 * those allocated the whole video. A few anonymous requests for a large upload
 * were enough to exhaust the process.
 *
 * ## How "never read whole" is proven
 *
 * Against a 256 MB SPARSE file (no disk cost), three ways at once:
 *
 *   - `fs.readFile` is never called by the route;
 *   - the process's ArrayBuffer memory does not grow by anything like the file;
 *   - the bytes that come back are exactly the requested range.
 *
 * Everything the smoke suite already asserts about ranges (206/416, suffix
 * ranges, validators) is re-checked here against the streaming version, plus
 * HEAD, which must not open the file at all.
 *
 * Run with:  node tests/uploads-range.test.mjs
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadTs } from './lib/load.mjs';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astrobaas-uploads-'));
process.env.UPLOADS_DIR = dir;

const R = await loadTs('src/pages/uploads/[...path].ts', 'uploads');

let pass = 0;
let fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };

// Count what the route does with the filesystem. The bundle keeps
// `node:fs/promises` external, so it calls methods on this very object.
const counts = { readFile: 0, open: 0 };
const realReadFile = fs.readFile;
const realOpen = fs.open;
let failNextOpen = false;
fs.readFile = async (...args) => { counts.readFile += 1; return realReadFile(...args); };
fs.open = async (...args) => {
  counts.open += 1;
  if (failNextOpen) {
    failNextOpen = false;
    const err = new Error('ENOENT: gone');
    err.code = 'ENOENT';
    throw err;
  }
  return realOpen(...args);
};
const reset = () => { counts.readFile = 0; counts.open = 0; };

const get = (rel, headers = {}, method = 'GET') => R.GET({
  params: { path: rel },
  request: new Request(`http://cms.test/uploads/${rel}`, { method, headers }),
});

// A 256 MB sparse video with a recognisable stretch in the middle and at the end.
const BIG = 256 * 1024 * 1024;
const bigRel = 'video/big.mp4';
await fs.mkdir(path.join(dir, 'video'), { recursive: true });
{
  const h = await realOpen(path.join(dir, bigRel), 'w');
  await h.truncate(BIG);
  const mid = Buffer.alloc(1000);
  for (let i = 0; i < mid.length; i += 1) mid[i] = (i * 7) % 256;
  await h.write(mid, 0, mid.length, 50_000_000);
  await h.write(Buffer.from('THE-END!!!'), 0, 10, BIG - 10);
  await h.close();
}

/* --------------------------------------------- a range from a huge file --- */
{
  reset();
  // Settle the heap first so the measurement is about this request.
  if (global.gc) global.gc();
  const before = process.memoryUsage().arrayBuffers;
  const res = await get(bigRel, { Range: 'bytes=50000000-50000999' });
  const afterHeaders = process.memoryUsage().arrayBuffers;
  const bytes = Buffer.from(await res.arrayBuffer());
  const grew = Math.max(afterHeaders, process.memoryUsage().arrayBuffers) - before;

  check('a mid-file range answers 206', res.status === 206);
  check('...naming the range and the real size',
    res.headers.get('content-range') === `bytes 50000000-50000999/${BIG}`);
  check('...with a Content-Length of the RANGE', res.headers.get('content-length') === '1000');
  check('...and exactly those bytes',
    bytes.length === 1000 && bytes.every((b, i) => b === (i * 7) % 256));
  // THE BUG, two ways.
  check('the route never calls fs.readFile', counts.readFile === 0);
  check(`ArrayBuffer memory grew by far less than the file (${(grew / 1048576).toFixed(1)} MB)`,
    grew < 32 * 1024 * 1024);
}

{
  reset();
  const res = await get(bigRel, { Range: 'bytes=-10' });
  const text = await res.text();
  check('a suffix range is the LAST bytes', res.status === 206 && text === 'THE-END!!!');
  check('...named as such', res.headers.get('content-range') === `bytes ${BIG - 10}-${BIG - 1}/${BIG}`);
  check('...still without readFile', counts.readFile === 0);
}

{
  // Safari's probe.
  const res = await get(bigRel, { Range: 'bytes=0-1' });
  const b = Buffer.from(await res.arrayBuffer());
  check('bytes=0-1 is two bytes', res.status === 206 && b.length === 2
    && res.headers.get('content-length') === '2');
}

{
  const res = await get(bigRel, { Range: 'bytes=5-' });
  check('an open-ended range runs to the end',
    res.status === 206 && res.headers.get('content-range') === `bytes 5-${BIG - 1}/${BIG}`
    && res.headers.get('content-length') === String(BIG - 5));
  // Do not drain 256 MB: cancel, which must release the handle.
  await res.body.cancel();
}

{
  const past = await get(bigRel, { Range: `bytes=${BIG + 10}-` });
  check('a range past the end is 416 with the real length',
    past.status === 416 && past.headers.get('content-range') === `bytes */${BIG}`);
  const zero = await get(bigRel, { Range: 'bytes=-0' });
  check('an empty suffix range is 416', zero.status === 416);
  const backwards = await get(bigRel, { Range: 'bytes=9-3' });
  check('a backwards range is 416', backwards.status === 416);
}

/* ------------------------------------------------------- a whole file --- */
const smallRel = 'img/small.png';
await fs.mkdir(path.join(dir, 'img'), { recursive: true });
const small = Buffer.from('\x89PNG\r\n\x1a\n' + 'x'.repeat(5000), 'binary');
await fs.writeFile(path.join(dir, smallRel), small);

{
  reset();
  const res = await get(smallRel);
  const b = Buffer.from(await res.arrayBuffer());
  check('no Range: 200 with the whole file', res.status === 200 && b.equals(small));
  check('...and a Content-Length', res.headers.get('content-length') === String(small.length));
  check('...advertising ranges', res.headers.get('accept-ranges') === 'bytes');
  check('...served as its type', res.headers.get('content-type') === 'image/png');
  check('...streamed, not readFile', counts.readFile === 0);

  const etag = res.headers.get('etag');
  const lastMod = res.headers.get('last-modified');
  check('validators are still sent', !!etag && !!lastMod);
  reset();
  const cond = await get(smallRel, { 'If-None-Match': etag });
  check('If-None-Match → 304', cond.status === 304 && (await cond.text()) === '');
  check('...without opening the file', counts.open === 0);
  const since = await get(smallRel, { 'If-Modified-Since': lastMod });
  check('If-Modified-Since → 304', since.status === 304);
  const stale = await get(smallRel, { 'If-None-Match': 'W/"stale"' });
  check('a stale tag gets the file', stale.status === 200 && (await stale.arrayBuffer()).byteLength === small.length);
}

/* ---------------------------------------------------------------- HEAD --- */
{
  reset();
  const res = await get(bigRel, {}, 'HEAD');
  check('HEAD: 200 with the length and no body',
    res.status === 200 && res.headers.get('content-length') === String(BIG) && res.body === null);
  check('HEAD: the file is never opened', counts.open === 0 && counts.readFile === 0);
  const ranged = await get(bigRel, { Range: 'bytes=0-1' }, 'HEAD');
  check('HEAD with a Range: 206 headers, no body',
    ranged.status === 206 && ranged.headers.get('content-length') === '2' && ranged.body === null);
}

/* ------------------------------------------------------------ edge cases --- */
{
  await fs.writeFile(path.join(dir, 'empty.txt'), '');
  const res = await get('empty.txt');
  check('an empty file is a 200 with nothing in it',
    res.status === 200 && res.headers.get('content-length') === '0' && (await res.text()) === '');

  failNextOpen = true;
  const gone = await get(smallRel);
  check('a file that vanishes between stat and open is a 404, not a broken stream', gone.status === 404);

  for (const bad of ['', '../etc/passwd', 'img/../../x', '/abs']) {
    const r = await get(bad);
    check(`traversal refused: ${JSON.stringify(bad)}`, r.status === 404);
  }
  check('a directory is not a file', (await get('img')).status === 404);
  check('an octet-stream download is forced to attach', await (async () => {
    await fs.writeFile(path.join(dir, 'blob.bin'), 'abc');
    const r = await get('blob.bin');
    await r.arrayBuffer();
    return r.headers.get('content-disposition') === 'attachment';
  })());
}

fs.readFile = realReadFile;
fs.open = realOpen;
await fs.rm(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
