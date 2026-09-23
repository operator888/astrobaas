#!/usr/bin/env node
/**
 * Fetching media during an import, against servers that misbehave.
 *
 * The media URLs in an export came out of a file somebody was emailed. They are
 * attacker-controlled in every sense that matters, and the server follows them
 * on its own behalf, from inside the network. So this covers the three ways
 * that goes wrong, each against a REAL server rather than a mocked promise:
 *
 *   1. **Redirect SSRF.** The URL in the file passes the guard; the 302 it
 *      answers with does not. Checking only the first URL is checking the
 *      wrong thing — the guard has to apply to the address actually connected
 *      to, on every hop.
 *   2. **An endless body.** `Content-Length` is a claim. A server that sends
 *      for ever must be cut off while it is sending, not measured afterwards.
 *   3. **A server that never answers.** One dead host must not stall an import
 *      of four hundred files.
 *
 * Run with:  node tests/import-fetch.test.mjs
 */
import http from 'node:http';
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

// An isolated database and uploads directory: this test WRITES media.
const tmp = path.join(os.tmpdir(), `astrobaas-fetch-test-${process.pid}`);
await fs.mkdir(path.join(tmp, 'uploads'), { recursive: true });
process.env.DB_PATH = path.join(tmp, 'db.json');
process.env.UPLOADS_DIR = path.join(tmp, 'uploads');

const cacheDir = path.join(root, 'node_modules', '.cache');
await fs.mkdir(cacheDir, { recursive: true });
const load = async (entry, name) => {
  const out = path.join(cacheDir, `astrobaas-fetch-${name}-${process.pid}.mjs`);
  await build({
    entryPoints: [path.join(root, entry)],
    bundle: true, format: 'esm', platform: 'node', packages: 'external',
    outfile: out, logLevel: 'silent',
  });
  const mod = await import(pathToFileURL(out).href);
  await fs.rm(out, { force: true });
  return mod;
};

const { applyImport } = await load('src/lib/import/apply.ts', 'apply');
const { LocalDB } = await load('src/lib/localdb.ts', 'db');

let pass = 0;
let fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };

/* ---- a server that misbehaves in the ways that matter ---- */
const hits = [];
const server = http.createServer((req, res) => {
  hits.push(req.url);
  if (req.url === '/redirect-off-http') {
    // The bypass this guards against: an http URL from the export whose 302
    // points somewhere the guard would never have accepted directly. A
    // non-http scheme is the version that can be asserted here, because the
    // test server itself is on loopback and loopback therefore has to be
    // allowed for any request to happen at all.
    res.writeHead(302, { Location: 'file:///etc/passwd' });
    res.end();
    return;
  }
  if (req.url === '/redirect-loop') {
    res.writeHead(302, { Location: '/redirect-loop' });
    res.end();
    return;
  }
  if (req.url === '/endless') {
    // No Content-Length, and it never stops.
    res.writeHead(200, { 'Content-Type': 'image/jpeg' });
    const pump = () => {
      if (res.writableEnded || res.destroyed) return;
      if (!res.write(Buffer.alloc(64 * 1024, 0x41))) {
        res.once('drain', pump);
        return;
      }
      setImmediate(pump);
    };
    pump();
    return;
  }
  if (req.url === '/never-answers') return;   // headers never sent
  if (req.url === '/no-length-but-big') {
    // Chunked, so there is no Content-Length to check — the only thing that
    // can stop this is counting bytes as they arrive.
    res.writeHead(200, { 'Content-Type': 'image/jpeg' });
    res.end(Buffer.alloc(2 * 1024 * 1024, 0x42));
    return;
  }
  if (req.url === '/real.png') {
    // A minimal real PNG (1x1), so the ingest pipeline actually stores it.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64');
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': String(png.length) });
    res.end(png);
    return;
  }
  if (req.url === '/empty') {
    res.writeHead(200, { 'Content-Type': 'image/jpeg' });
    res.end();
    return;
  }
  res.writeHead(404);
  res.end();
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const BASE = `http://127.0.0.1:${port}`;

await LocalDB.init();
const admin = (await LocalDB.getUsers()).find((u) => u.role === 'admin');

/** A plan with just the media entries under test. */
const planFor = (urls) => ({
  posts: [], redirects: [], skipped: [], authors: [],
  media: urls.map((url, i) => ({ wpId: String(i + 1), url })),
});

const run = (urls, opts = {}) =>
  applyImport(planFor(urls), admin.id, {
    dryRun: false,
    fetchMedia: true,
    // The test server IS on loopback, so private hosts must be allowed for the
    // fetch to be attempted at all. That is precisely what makes the redirect
    // case meaningful: the guard is not simply refusing everything.
    allowPrivateMediaHosts: true,
    maxMediaBytes: 1024 * 1024,
    ...opts,
  });

/* ---- 1. the guard applies to the FIRST url ---- */
{
  const r = await applyImport(planFor(['http://127.0.0.1:1/x.jpg']), admin.id, {
    dryRun: false, fetchMedia: true, allowPrivateMediaHosts: false,
  });
  check('a media URL pointing at loopback is refused before any request',
    r.skipped.some((s) => /private or loopback/.test(s.reason)));
  check('...and nothing was fetched', r.importedMedia === 0);
}

/* ---- 2. ...and to every hop after it ---- */
{
  const before = hits.length;
  const r = await run([`${BASE}/redirect-off-http`]);
  check('the guard runs on the REDIRECT TARGET, not only on the URL in the file',
    r.failed.some((f) => /redirected to a URL that refused scheme/.test(f.reason)));
  check('...and only the first hop was ever requested',
    hits.slice(before).length === 1);
  check('...and nothing was stored', r.importedMedia === 0);
}

/* ---- 3. a redirect loop terminates ---- */
{
  const r = await run([`${BASE}/redirect-loop`]);
  check('a redirect loop ends with a reason rather than spinning',
    r.failed.some((f) => /too many redirects/.test(f.reason)));
}

/* ---- 4. an endless body is cut off ---- */
{
  const started = Date.now();
  const r = await run([`${BASE}/endless`]);
  const elapsed = Date.now() - started;
  check('an endless body is refused', r.failed.some((f) => /larger than/.test(f.reason)));
  // 1 MB cap, 64 KB chunks: this must end almost immediately. If the body were
  // buffered whole and measured afterwards, it would never end at all.
  check('...quickly, because reading STOPS at the cap rather than after it',
    elapsed < 10_000);
}

/* ---- 5. a lying Content-Length does not get past the real check ---- */
{
  const r = await run([`${BASE}/no-length-but-big`], { maxMediaBytes: 100 * 1024 });
  check('a body over the cap is refused when there is no Content-Length to check',
    r.failed.some((f) => /larger than/.test(f.reason)));
}

/* ---- 6. an empty file is reported, not stored ---- */
{
  const r = await run([`${BASE}/empty`]);
  check('an empty response is a failure with a reason',
    r.failed.some((f) => /empty file/.test(f.reason)));
}

/* ---- 7. a server that never answers does not hang the import ---- */
{
  const started = Date.now();
  const r = await run([`${BASE}/never-answers`, `${BASE}/empty`]);
  const elapsed = Date.now() - started;
  check('a hanging host fails rather than stalling the run', r.failed.length >= 1);
  check('...within the per-file deadline, not for ever', elapsed < 60_000);
  check('...and the import CONTINUES to the next file',
    r.failed.length + r.importedMedia >= 2 || r.failed.length === 2);
}

/* ---- 8. re-running does not duplicate the media library ---- */
{
  const url = `${BASE}/real.png`;
  const first = await run([url]);
  const mediaAfterFirst = (await LocalDB.getMedia()).length;
  const again = await run([url]);
  const mediaAfterSecond = (await LocalDB.getMedia()).length;

  check('a real image imports once', first.importedMedia === 1 && mediaAfterFirst >= 1);
  // The module header's own scenario: a blip halfway through 400 images, then
  // "run it again". Without the wp_id stamp on media, the re-run re-downloaded
  // every file and doubled the library.
  check('a SECOND run fetches nothing', again.importedMedia === 0);
  check('...says why', again.skipped.some((s) => /already imported/.test(s.reason)));
  check('...and the library did not grow', mediaAfterSecond === mediaAfterFirst);
}

/* ---- 9. the cap on how many files one import will take ---- */
{
  const r = await run([`${BASE}/empty`, `${BASE}/empty`, `${BASE}/empty`], { maxMedia: 1 });
  check('the media cap is enforced and NAMED in the reason',
    r.skipped.some((s) => /media cap of 1 files reached/.test(s.reason)));
  check('...and it counts ATTEMPTS, so an export full of dead URLs cannot '
    + 'make one request per entry', r.failed.length + r.importedMedia === 1);
}

server.close();
await fs.rm(tmp, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
