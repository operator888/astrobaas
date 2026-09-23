#!/usr/bin/env node
/**
 * Off-site backup, against a real HTTP server pretending to be S3.
 *
 * A backup is the thing you reach for when everything else has gone wrong, so
 * the failures that matter are the ones that leave you with nothing while
 * reporting success:
 *
 *   · a retention rule that deletes the last good archive on the day uploads
 *     start failing;
 *   · a rotation that deletes the archive it has just written;
 *   · an install on a remote database quietly backing up a stale `db.json`
 *     that restores to an empty site;
 *   · an upload that "succeeded" with different bytes than were built.
 *
 * The stub is a real server rather than a mocked promise, so the signing, the
 * headers and the XML parsing are all exercised.
 *
 * Run with:  node tests/offsite-backup.test.mjs
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const cacheDir = path.join(root, 'node_modules', '.cache');
await fs.mkdir(cacheDir, { recursive: true });

const load = async (entry, name) => {
  const out = path.join(cacheDir, `astrobaas-offsite-${name}-${process.pid}.mjs`);
  await build({
    entryPoints: [path.join(root, entry)],
    bundle: true, format: 'esm', platform: 'node', packages: 'external',
    outfile: out, logLevel: 'silent',
  });
  const mod = await import(pathToFileURL(out).href);
  await fs.rm(out, { force: true });
  return mod;
};

// An isolated site to back up.
const tmp = path.join(os.tmpdir(), `astrobaas-offsite-${process.pid}`);
await fs.mkdir(path.join(tmp, 'uploads', '2026', '08'), { recursive: true });
process.env.DB_PATH = path.join(tmp, 'db.json');
process.env.UPLOADS_DIR = path.join(tmp, 'uploads');
await fs.writeFile(process.env.DB_PATH, JSON.stringify({ posts: [{ id: '1', title: 'Hello' }] }));
await fs.writeFile(path.join(tmp, 'uploads', '2026', '08', 'a.png'), Buffer.from('pretend png'));
// One file over the ceiling, which must be REPORTED as skipped rather than
// silently dropped or allowed to blow the archive up.
await fs.writeFile(path.join(tmp, 'uploads', '2026', '08', 'huge.bin'), Buffer.alloc(11 * 1024 * 1024, 1));

const O = await load('src/lib/backup/offsite.ts', 'offsite');

let pass = 0;
let fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };

/* ------------------------------------------------------------------ *
 * A server that behaves like S3, and can be told to misbehave.        *
 * ------------------------------------------------------------------ */
const stored = new Map();      // key -> Buffer
const requests = [];
let refuseWrites = false;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    requests.push({
      method: req.method,
      path: url.pathname,
      query: url.search,
      auth: req.headers.authorization ?? '',
      contentSha: req.headers['x-amz-content-sha256'] ?? '',
      bodyLength: body.length,
    });

    // Every request must be signed. An unsigned one would sail past a stub
    // that never looked, and then 403 against a real bucket.
    if (!/^AWS4-HMAC-SHA256 Credential=.+, SignedHeaders=.+, Signature=[0-9a-f]{64}$/.test(String(req.headers.authorization ?? ''))) {
      res.writeHead(403, { 'Content-Type': 'application/xml' });
      res.end('<Error><Message>Unsigned</Message></Error>');
      return;
    }

    const key = decodeURIComponent(url.pathname.replace(/^\/[^/]+\//, ''));

    if (req.method === 'PUT') {
      if (refuseWrites) {
        res.writeHead(403, { 'Content-Type': 'application/xml' });
        res.end('<Error><Code>AccessDenied</Code><Message>Bucket is read-only today</Message></Error>');
        return;
      }
      // Verify the signed content hash actually describes the body.
      const actual = crypto.createHash('sha256').update(body).digest('hex');
      if (actual !== req.headers['x-amz-content-sha256']) {
        res.writeHead(400, { 'Content-Type': 'application/xml' });
        res.end('<Error><Message>XAmzContentSHA256Mismatch</Message></Error>');
        return;
      }
      stored.set(key, body);
      res.writeHead(200); res.end('');
      return;
    }
    if (req.method === 'DELETE') {
      stored.delete(key);
      res.writeHead(204); res.end('');
      return;
    }
    if (req.method === 'GET' && url.searchParams.get('list-type') === '2') {
      const prefix = url.searchParams.get('prefix') ?? '';
      const keys = [...stored.keys()].filter((k) => k.startsWith(prefix)).sort();
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      res.end(`<?xml version="1.0"?><ListBucketResult>${keys.map((k) => `<Contents><Key>${k}</Key></Contents>`).join('')}</ListBucketResult>`);
      return;
    }
    res.writeHead(404); res.end('');
  });
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const cfg = {
  endpoint: `http://127.0.0.1:${port}`,
  region: 'eu-central-1',
  bucket: 'backups',
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'secret',
  forcePathStyle: true,
  prefix: 'astrobaas',
  keep: 3,
  everyHours: 24,
};
const at = (iso) => new Date(iso);

/* ---- 1. one backup, end to end ---- */
{
  const r = await O.runOffsiteBackup(cfg, fetch, at('2026-08-01T00:00:00Z'));
  check('the backup uploads', r.ok === true);
  check('...under a sortable timestamped key',
    r.key === 'astrobaas/2026-08-01T00-00-00-000Z.json');
  check('...and the bucket really has it', stored.has(r.key));

  const uploaded = JSON.parse(stored.get(r.key).toString('utf8'));
  check('the archive names its own format and version',
    uploaded.format === 'astrobaas-backup' && uploaded.version === 2);
  check('...and which driver it came from, in the payload not just the name',
    uploaded.kind === 'lowdb');
  check('the database is in it', uploaded.db?.posts?.[0]?.title === 'Hello');
  check('the uploads are in it', uploaded.uploads.some((u) => u.path === '2026/08/a.png'));
  check('a file over the ceiling is left out', !uploaded.uploads.some((u) => u.path.includes('huge')));
  check('...and SAID to be left out rather than dropped in silence', r.skipped === 1);

  // The hash the caller is given must describe the bytes that arrived.
  const actual = crypto.createHash('sha256').update(stored.get(r.key)).digest('hex');
  check('the reported sha256 matches the bytes in the bucket', r.sha256 === actual);
  check('every request was signed', requests.every((q) => q.auth.startsWith('AWS4-HMAC-SHA256 ')));
}

/* ---- 2. retention ---- */
{
  await O.runOffsiteBackup(cfg, fetch, at('2026-08-02T00:00:00Z'));
  await O.runOffsiteBackup(cfg, fetch, at('2026-08-03T00:00:00Z'));
  check('three backups are all kept when keep=3', stored.size === 3);

  const fourth = await O.runOffsiteBackup(cfg, fetch, at('2026-08-04T00:00:00Z'));
  check('a fourth prunes the oldest', stored.size === 3 && fourth.pruned === 1);
  check('...and the one pruned is the OLDEST', !stored.has('astrobaas/2026-08-01T00-00-00-000Z.json'));
  check('...while the newest survives', stored.has(fourth.key));
  // The rotation must never delete what it has just written.
  check('the archive just written is never the one pruned', stored.has(fourth.key));
}

/* ---- 3. the failure that must not destroy anything ---- */
{
  const before = new Set(stored.keys());
  refuseWrites = true;
  const failed = await O.runOffsiteBackup(cfg, fetch, at('2026-08-05T00:00:00Z'));
  refuseWrites = false;

  check('a refused upload is reported as a failure', failed.ok === false);
  check('...with the provider’s own message, not a bare status',
    /read-only today/.test(failed.error ?? ''));
  // The one kind of failure retried on the very next tick: the archive was
  // built, and the bucket may take it a minute from now.
  check('...marked transient', failed.transient === true);
  check('...so the schedule retries it on the next tick',
    O.backupDue(cfg, failed, Date.parse('2026-08-05T00:01:00Z')) === true);
  // The property: retention runs only after a SUCCESSFUL upload. Otherwise the
  // day writes start failing is the day the last good backup is deleted.
  check('a failed upload deletes nothing',
    stored.size === before.size && [...before].every((k) => stored.has(k)));
}

/* ---- 4. a remote database must not be backed up as if it were local ---- */
{
  const saved = process.env.DATABASE_URL;
  process.env.DATABASE_URL = 'libsql://my-shop.turso.io';
  const r = await O.buildPayload();
  process.env.DATABASE_URL = saved;

  check('a remote libSQL install refuses rather than archiving a stale file',
    r.ok === false);
  check('...and says what to do instead', /turso db dump|provider/i.test(r.error ?? ''));
}

/* ---- 5. a file: libSQL install backs up the SQLite file, not db.json ---- */
{
  // A REAL database in WAL mode, left with its newest commit still in the
  // `-wal` sibling — the state a live shop is in between checkpoints. (This
  // section used to write the bytes "SQLite format 3" plus a fake `-wal` and
  // assert both were copied. That pinned the old design, a raw copy of the
  // file and of its log in two separate reads, which lost commits whenever a
  // checkpoint fell between them. The archive is a snapshot now.)
  const sqlitePath = path.join(tmp, 'site.sqlite');
  const { createClient } = await import('@libsql/client');
  const live = createClient({ url: `file:${sqlitePath}` });
  await live.execute('PRAGMA journal_mode = WAL');
  await live.execute('CREATE TABLE t (v TEXT)');
  await live.execute("INSERT INTO t VALUES ('committed-but-only-in-the-wal')");
  const mainHoldsIt = (await fs.readFile(sqlitePath)).includes('committed-but-only-in-the-wal');

  const saved = process.env.DATABASE_URL;
  process.env.DATABASE_URL = `file:${sqlitePath}`;
  const r = await O.buildPayload();
  // A DATABASE_URL naming a file that is not there must FAIL the backup.
  // Opening it would create an empty database, which snapshots as a valid
  // archive of nothing: the green tick over an empty site.
  const missingPath = path.join(tmp, 'no-such-database.sqlite');
  process.env.DATABASE_URL = `file:${missingPath}`;
  const missing = await O.buildPayload();
  process.env.DATABASE_URL = saved;
  live.close();

  check('(precondition) the newest commit is in the -wal, not yet in the main file', mainHoldsIt === false);
  check('a file-backed libSQL install produces an archive', r.ok === true);
  const parsed = r.ok ? JSON.parse(r.body.toString('utf8')) : {};
  const dbBytes = Buffer.from(parsed.sqlite_base64 ?? '', 'base64');
  check('...marked as the libSQL kind', parsed.kind === 'libsql-file');
  check('...carrying the SQLITE file', dbBytes.subarray(0, 15).toString('latin1') === 'SQLite format 3');
  check('...whose database bytes hold the commit that was still only in the -wal',
    dbBytes.includes('committed-but-only-in-the-wal'));
  check('...and no -wal/-shm sidecar, because nothing needs one',
    parsed.wal_base64 === undefined && parsed.shm_base64 === undefined);
  check('...and no "copied live, best-effort" note: a snapshot is consistent',
    !(parsed.notes ?? []).some((n) => /best-effort|hot copy/i.test(n)));
  // The one that matters: db.json exists here and is NOT the database. An
  // archive containing it would look valid and restore an empty site.
  check('...and NOT the stale db.json', parsed.db === undefined);
  check('...with the uploads alongside it', (parsed.uploads ?? []).some((u) => u.path === '2026/08/a.png'));
  check('a DATABASE_URL naming a missing file fails the backup', missing.ok === false);
  check('...and does not create the file it was asked to back up',
    await fs.access(missingPath).then(() => false, () => true));
}

/* ---- 5c. a database too large for the archive is refused BEFORE the copy ---- */
{
  // The snapshot is a VACUUM INTO: the process frozen for its duration and a
  // database-sized file written. A copy that is going to be refused must not
  // be paid for — least of all every minute by a scheduler retrying it. Every
  // statement the libSQL client runs is recorded (patched on the prototype,
  // which the bundled module shares), so "refused" can be told apart from
  // "copied, then refused".
  const { createClient } = await import('@libsql/client');
  const file = path.join(tmp, 'budget.sqlite');
  const c = createClient({ url: `file:${file}` });
  await c.execute('PRAGMA journal_mode = WAL');
  await c.execute('CREATE TABLE t (v TEXT)');
  for (let i = 0; i < 50; i += 1) await c.execute({ sql: 'INSERT INTO t VALUES (?)', args: [`${i} ${'x'.repeat(500)}`] });
  c.close();

  const probe = createClient({ url: 'file::memory:' });
  const proto = Object.getPrototypeOf(probe);
  probe.close();
  const realExecute = proto.execute;
  const statements = [];
  proto.execute = async function recorded(stmt, args) {
    statements.push(typeof stmt === 'string' ? stmt : stmt.sql);
    return realExecute.call(this, stmt, args);
  };
  const saved = process.env.DATABASE_URL;
  process.env.DATABASE_URL = `file:${file}`;
  let tooSmall;
  let roomy;
  let vacuumedWhenRefused;
  let vacuumedWhenFits;
  try {
    // ~2,000 characters of room beyond the fixed overhead: about 1.5 KB of
    // database, for a database of ~30 KB.
    tooSmall = await O.buildPayload(process.env, { maxArchiveChars: 1_000_000 + 2_000 });
    vacuumedWhenRefused = statements.some((s) => /VACUUM/i.test(s));
    statements.length = 0;
    roomy = await O.buildPayload(process.env, { maxArchiveChars: 1_000_000 + 10_000_000 });
    vacuumedWhenFits = statements.some((s) => /VACUUM/i.test(s));
  } finally {
    proto.execute = realExecute;
    process.env.DATABASE_URL = saved;
  }

  check(`a database too large for the archive is refused (${tooSmall?.ok ? 'ok' : tooSmall?.error?.slice(0, 120)})`,
    tooSmall?.ok === false && /too large/i.test(tooSmall?.error ?? ''));
  check('...BEFORE any VACUUM INTO copy is made', vacuumedWhenRefused === false);
  check('...while one that fits is still archived, from a snapshot', roomy?.ok === true && vacuumedWhenFits === true);
}

/* ---- 5d. a snapshot too long for a string fails the backup; nothing throws ---- */
{
  // Past V8's limit Buffer#toString throws a plain Error with code
  // ERR_STRING_TOO_LONG — not the RangeError the guard used to test for — and
  // the base64 used to be built OUTSIDE the guard's try anyway. Reproducing it
  // for real needs a ~400 MB database, so the snapshot's own toString throws
  // exactly what Node throws.
  const file = path.join(tmp, 'budget.sqlite'); // from 5c
  const isSnapshot = (buf) => buf.length >= 15 && realToString.call(buf.subarray(0, 15), 'latin1') === 'SQLite format 3';
  const realToString = Buffer.prototype.toString;
  const saved = process.env.DATABASE_URL;
  process.env.DATABASE_URL = `file:${file}`;
  let tooLong;
  let buildThrew = null;
  let run;
  let runThrew = null;
  try {
    Buffer.prototype.toString = function toStringTooLong(encoding, ...rest) {
      if (encoding === 'base64' && isSnapshot(this)) {
        throw Object.assign(new Error('Cannot create a string longer than 0x1fffffe8 characters'), { code: 'ERR_STRING_TOO_LONG' });
      }
      return realToString.call(this, encoding, ...rest);
    };
    try { tooLong = await O.buildPayload(); } catch (err) { buildThrew = err; }

    // A build that throws something NOT about size must still be recorded as
    // the outcome of the run. It escaped runOffsiteBackup before, leaving
    // lastBackup() describing the attempt before.
    Buffer.prototype.toString = function toStringBroken(encoding, ...rest) {
      if (encoding === 'base64' && isSnapshot(this)) throw new TypeError('simulated: the archive could not be encoded');
      return realToString.call(this, encoding, ...rest);
    };
    try { run = await O.runOffsiteBackup(cfg, fetch, at('2026-08-06T00:00:00Z')); } catch (err) { runThrew = err; }
  } finally {
    Buffer.prototype.toString = realToString;
    process.env.DATABASE_URL = saved;
  }

  check(`a snapshot too long to encode does not throw out of buildPayload (${buildThrew?.message ?? 'no throw'})`, buildThrew === null);
  check(`...it fails the backup with a message instead (${tooLong?.ok ? 'ok' : tooLong?.error?.slice(0, 80)})`,
    tooLong?.ok === false && /too large/i.test(tooLong?.error ?? ''));
  check(`a build that throws does not escape runOffsiteBackup (${runThrew?.message ?? 'no throw'})`, runThrew === null);
  check('...it is recorded as the outcome of the run, with its reason',
    run?.ok === false && O.lastBackup() === run && /could not be encoded/.test(run?.error ?? ''));
  check('...and it is not transient: rebuilding a minute later would fail the same way', !run?.transient);
  check('...so the schedule waits before rebuilding it (not due 30 minutes later, due an hour later)',
    O.backupDue(cfg, run, Date.parse('2026-08-06T00:30:00Z')) === false
    && O.backupDue(cfg, run, Date.parse('2026-08-06T01:00:00Z')) === true);
}

/* ---- 5b. an oversized uploads folder does not crash the backup ---- */
{
  // Write more than the total budget in "eligible" files (each under the
  // per-file cap). The archive must still be produced — DB only — with a note.
  const bigDir = path.join(tmp, 'uploads', '2027', '01');
  await fs.mkdir(bigDir, { recursive: true });
  // 40 files of ~8MB = ~320MB > the 256MB total bound; each < 10MB per-file cap.
  for (let i = 0; i < 40; i += 1) {
    await fs.writeFile(path.join(bigDir, `big-${i}.bin`), Buffer.alloc(8 * 1024 * 1024, 1));
  }
  const saved = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL; // lowdb path
  const r = await O.buildPayload();
  if (saved) process.env.DATABASE_URL = saved;

  check('an oversized uploads folder still produces an archive', r.ok === true);
  const parsed = r.ok ? JSON.parse(r.body.toString('utf8')) : {};
  check('...with the database present', parsed.db !== undefined);
  check('...the uploads dropped rather than overflowing memory', (parsed.uploads ?? []).length === 0);
  check('...and a note explaining why', (parsed.notes ?? []).some((n) => /larger than|sync the uploads/i.test(n)));

  // Clean up the big files so later sections and reruns are fast.
  await fs.rm(bigDir, { recursive: true, force: true });
}

/* ---- 6. configuration ---- */
{
  const base = {
    BACKUP_S3_ENDPOINT: 'https://s3.example.com',
    BACKUP_S3_BUCKET: 'b',
    BACKUP_S3_KEY_ID: 'k',
    BACKUP_S3_SECRET: 's',
  };
  check('a fully configured target is read', O.offsiteConfig(base) !== null);
  check('a missing secret means not configured — not a broken one',
    O.offsiteConfig({ ...base, BACKUP_S3_SECRET: '' }) === null);
  check('no configuration at all is null, not an error', O.offsiteConfig({}) === null);
  // Backups travel with everything the site knows.
  check('an http endpoint is refused by default',
    O.offsiteConfig({ ...base, BACKUP_S3_ENDPOINT: 'http://s3.example.com' }) === null);
  check('...unless the operator explicitly allows it for a LAN MinIO',
    O.offsiteConfig({ ...base, BACKUP_S3_ENDPOINT: 'http://minio.lan:9000', BACKUP_S3_ALLOW_HTTP: '1' }) !== null);
  check('a nonsense endpoint is refused', O.offsiteConfig({ ...base, BACKUP_S3_ENDPOINT: 'not a url' }) === null);
  check('retention defaults to something sane', O.offsiteConfig(base).keep === 14);
  check('...and is bounded', O.offsiteConfig({ ...base, BACKUP_KEEP: '99999' }).keep === 365);
  check('a nonsense retention falls back rather than keeping zero',
    O.offsiteConfig({ ...base, BACKUP_KEEP: 'lots' }).keep === 14);
  check('the prefix is trimmed of slashes so keys are not doubled',
    O.offsiteConfig({ ...base, BACKUP_S3_PREFIX: '/shop/' }).prefix === 'shop');
}

/* ---- 7. when a backup is due ---- */
{
  const c = { ...cfg, everyHours: 24 };
  const t0 = Date.parse('2026-08-10T00:00:00Z');
  check('with no backup yet, one is due', O.backupDue(c, null, t0) === true);
  check('just after a success, one is not', O.backupDue(c, { ok: true, at: '2026-08-10T00:00:00Z' }, t0) === false);
  check('a day later, one is', O.backupDue(c, { ok: true, at: '2026-08-09T00:00:00Z' }, t0) === true);
  // A TRANSIENT failure must not reset the clock: a bucket refusing writes
  // since midnight should be retried on the next tick, not tomorrow.
  check('after a TRANSIENT failure (the bucket refused), one is due immediately',
    O.backupDue(c, { ok: false, transient: true, at: '2026-08-10T00:00:00Z' }, t0) === true);
  // A failure to BUILD the archive fails identically a minute later, and every
  // attempt is a full VACUUM INTO. It waits min(everyHours, 1 h).
  const built = { ok: false, at: '2026-08-10T00:00:00Z' };
  check('after a failure to BUILD the archive, the next attempt waits (not due 59 minutes later)',
    O.backupDue(c, built, t0 + 59 * 60_000) === false);
  check('...and is due an hour later', O.backupDue(c, built, t0 + 60 * 60_000) === true);
  check('...or sooner when the schedule itself is shorter than an hour (15 min: due at 15, not at 14)',
    O.backupDue({ ...c, everyHours: 0.25 }, built, t0 + 15 * 60_000) === true
    && O.backupDue({ ...c, everyHours: 0.25 }, built, t0 + 14 * 60_000) === false);
  check('everyHours=0 disables the schedule',
    O.backupDue({ ...c, everyHours: 0 }, null, t0) === false);
}

server.close();
await fs.rm(tmp, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
