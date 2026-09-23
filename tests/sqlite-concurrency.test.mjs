#!/usr/bin/env node
/**
 * SQLite with more than one writer: the connection settings, the second
 * process, and the backup.
 *
 * ## What was wrong
 *
 * Nothing set a PRAGMA anywhere. Measured with this repo's own @libsql/client
 * on a `file:` URL, the defaults are journal_mode=delete, busy_timeout=0 and
 * synchronous=FULL. So the moment a SECOND process wrote — an ERP sync CLI,
 * `npm run import:woo`, a second replica — whichever side lost the lock failed
 * with SQLITE_BUSY in zero milliseconds, and in delete mode a long reader made
 * the writer's COMMIT fail too.
 *
 * Setting the PRAGMAs once at start-up would not have been enough, and this
 * file proves the part that is easy to get wrong: the client keeps a POOL and
 * opens a fresh connection whenever every existing one is borrowed (during a
 * transaction, or when requests arrive together). A per-connection setting
 * applied once lands on one connection; the next one the pool opens has the
 * defaults again. So the settings are inspected AFTER a transaction and a batch
 * have run, from as many connections as the pool will hand out at once.
 *
 * ## And the backup, which WAL breaks if nothing else changes
 *
 * Under WAL the newest commits live in the `-wal` sibling, not the main file.
 * The backup read the main file and then the `-wal` in two separate reads; a
 * checkpoint between them (any commit can trigger one) moves the newest pages
 * into the main file after it was read and empties the WAL before it is read.
 * The round trip below FORCES that checkpoint at exactly that moment, then
 * restores the archive and restarts, and asks whether the write made just
 * before the backup is still there.
 *
 * ## And the running site AFTER a restore, which WAL turned into a silent loss
 *
 * The restore renames the restored file over the database. Every client the
 * site held kept the previous file's inode: in rollback-journal mode its next
 * write failed ("readonly database"), but under WAL it SUCCEEDED, into a log
 * nothing reads again, and was gone at the restart the restore asks for. The
 * round trip therefore also writes AFTER the restore, in the same process, and
 * asks the restarted site whether that write is there — on the relational AND
 * the doc-blob driver, both of which hold the file open.
 *
 * ## And the partial copies an interrupted backup leaves
 *
 * A snapshot and a restore both stage a database-sized file beside the live
 * one and remove it in a `finally`, which a killed process never runs.
 * Section 7 plants leftovers named for a dead pid and for this live one, and
 * asks the next open to remove exactly the dead ones.
 *
 * Run with:  node tests/sqlite-concurrency.test.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ROOT, loadTs } from './lib/load.mjs';

const SELF = fileURLToPath(import.meta.url);
/** How long an interfering process holds its lock. Long enough to measure a wait. */
const HOLD_MS = 1200;
const MODE = process.env.SQLITE_TEST_CHILD;

const emit = (obj) => process.stdout.write(`__RESULT__${JSON.stringify(obj)}\n`);
const exists = (p) => fs.access(p).then(() => true, () => false);
const post = (restoreBackup, body) => restoreBackup({
  request: new Request('http://localhost/api/backup/import', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }),
  locals: { user: { id: 'test-admin', role: 'admin' } },
});

/* --------------------------------------------------------------- children --- */

if (MODE === 'hold-write' || MODE === 'hold-read') {
  // An OUTSIDE process, opened deliberately with a bare client and SQLite's
  // defaults — the way an ad-hoc script or a third-party tool opens the file.
  // It takes the lock, says so, holds it, and lets go.
  const { createClient } = await import('@libsql/client');
  const c = createClient({ url: process.env.DATABASE_URL });
  const tx = await c.transaction(MODE === 'hold-write' ? 'write' : 'deferred');
  if (MODE === 'hold-write') {
    await tx.execute({ sql: 'INSERT INTO counters (id, data) VALUES (?, ?)', args: [`hold-${process.pid}`, '{"value":1}'] });
  } else {
    await tx.execute('SELECT count(*) FROM products');
  }
  process.stdout.write('HELD\n');
  await new Promise((r) => setTimeout(r, Number(process.env.HOLD_MS)));
  await tx.commit();
  c.close();
  process.exit(0);
}

if (MODE === 'wait-write') {
  // THIS codebase as the second process — the importer CLI's position. It
  // starts writing while the other side holds the lock, and must wait.
  const { SqlStorage } = await loadTs('src/lib/storage/sql-storage.ts', 'sqlitewait');
  process.stdout.write('READY\n');
  const t0 = Date.now();
  let ok = true;
  let code = null;
  try {
    const s = new SqlStorage(process.env.DATABASE_URL);
    await s.init();
    await s.createProduct({ name: 'From the importer', slug: `cli-${process.pid}`, status: 'active', price_cents: 100 });
  } catch (err) {
    ok = false;
    code = err?.code ?? String(err?.message ?? err);
  }
  emit({ ok, code, waitedMs: Date.now() - t0 });
  process.exit(0);
}

if (MODE === 'backup-live') {
  // The running site, relational driver, taking a backup of itself.
  const { LocalDB, buildPayload, restoreBackup } = await loadTs('tests/fixtures/storage-entry.ts', 'sqlitebackup');
  const { createClient } = await import('@libsql/client');
  await LocalDB.init();
  const file = process.env.DB_FILE;

  await LocalDB.createProduct({
    name: 'Before', slug: 'written-just-before-the-backup', status: 'active', price_cents: 100, stock: 3,
  });
  // The precondition that makes the rest mean something: at this instant the
  // write exists ONLY in the -wal.
  const walBytes = (await fs.stat(`${file}-wal`).catch(() => ({ size: 0 }))).size;
  const mainHasIt = (await fs.readFile(file)).includes('written-just-before-the-backup');

  // THE ADVERSARY: a checkpoint lands in the middle of the backup, right after
  // the first read of the database's bytes — for a copy of the file, between
  // the main-file read and the -wal read. It folds the WAL into the main file
  // and truncates the log. Any commit on a busy shop can do this unprompted.
  const realReadFile = fs.readFile;
  let checkpoint = null;
  fs.readFile = async function readFileThenCheckpoint(p, ...rest) {
    const out = await realReadFile.call(this, p, ...rest);
    if (!checkpoint && typeof p === 'string' && p.startsWith(file)) {
      const c = createClient({ url: `file:${file}` });
      const row = (await c.execute('PRAGMA wal_checkpoint(TRUNCATE)')).rows[0];
      checkpoint = { busy: Number(row[0]), frames: Number(row[1]) };
      c.close();
    }
    return out;
  };
  const payload = await buildPayload(process.env);
  fs.readFile = realReadFile;
  const archive = payload.ok ? JSON.parse(payload.body.toString('utf8')) : null;

  // A write AFTER the backup, which the restore must take away again — the
  // proof that the restore replaced the database rather than doing nothing.
  await LocalDB.createProduct({
    name: 'After', slug: 'written-after-the-backup', status: 'active', price_cents: 100, stock: 3,
  });

  const res = archive ? await post(restoreBackup, archive) : null;
  const body = res ? await res.json().catch(() => null) : null;

  // A write AFTER the restore, from this same process — a checkout taken
  // between the restore and the restart it asks for. It must either succeed
  // and SURVIVE the restart, or fail loudly now. Succeeding here and being
  // gone after the restart is the one outcome that is never acceptable.
  let afterRestoreOk = false;
  let afterRestoreError = null;
  try {
    await LocalDB.createProduct({
      name: 'After the restore', slug: 'written-after-the-restore', status: 'active', price_cents: 100, stock: 3,
    });
    afterRestoreOk = true;
  } catch (err) {
    afterRestoreError = String(err?.code ?? err?.message ?? err);
  }
  // What the RUNNING site now sees, without a restart.
  const liveHas = async (slug) => !!(await LocalDB.getProductBySlug(slug).catch(() => null));
  emit({
    walBytes, mainHasIt, checkpoint,
    payloadOk: payload.ok, payloadError: payload.ok ? null : payload.error,
    archiveCarriesWal: typeof archive?.wal_base64 === 'string',
    restoreStatus: res?.status ?? null,
    restartRequired: body?.data?.restartRequired ?? null,
    afterRestoreOk, afterRestoreError,
    liveHasAfterBackup: await liveHas('written-after-the-backup'),
    liveHasAfterRestore: await liveHas('written-after-the-restore'),
  });
  process.exit(0);
}

if (MODE === 'backup-restart') {
  // The restart the restore asks for.
  const { LocalDB } = await loadTs('tests/fixtures/storage-entry.ts', 'sqliterestart');
  await LocalDB.init();
  const before = await LocalDB.getProductBySlug('written-just-before-the-backup');
  const after = await LocalDB.getProductBySlug('written-after-the-backup');
  const afterRestore = await LocalDB.getProductBySlug('written-after-the-restore');
  const { createClient } = await import('@libsql/client');
  const c = createClient({ url: process.env.DATABASE_URL });
  const journal = String((await c.execute('PRAGMA journal_mode')).rows[0][0]);
  c.close();
  emit({ hasBefore: !!before, hasAfter: !!after, hasAfterRestore: !!afterRestore, journal });
  process.exit(0);
}

if (MODE === 'legacy-restore') {
  // An archive written by the PREVIOUS backup code: the main file and its
  // -wal, read raw while a connection had them open.
  const { restoreBackup } = await loadTs('tests/fixtures/storage-entry.ts', 'sqlitelegacy');
  const { createClient } = await import('@libsql/client');
  const target = process.env.DB_FILE;
  const source = path.join(path.dirname(target), 'old-shop.sqlite');
  const live = createClient({ url: `file:${source}` });
  await live.execute('PRAGMA journal_mode = WAL');
  await live.execute('CREATE TABLE notes (v TEXT)');
  // Enough pages that half the file is not a database.
  for (let i = 0; i < 40; i += 1) {
    await live.execute({ sql: 'INSERT INTO notes VALUES (?)', args: [`filler ${i} ${'x'.repeat(400)}`] });
  }
  await live.execute("INSERT INTO notes VALUES ('only-in-the-legacy-wal')");
  const legacy = {
    format: 'astrobaas-backup', version: 2, kind: 'libsql-file', created_at: new Date().toISOString(),
    sqlite_base64: (await fs.readFile(source)).toString('base64'),
    wal_base64: (await fs.readFile(`${source}-wal`)).toString('base64'),
    uploads: [], notes: [],
  };
  const legacyMainHasIt = Buffer.from(legacy.sqlite_base64, 'base64').includes('only-in-the-legacy-wal');
  live.close();

  const readNote = async () => {
    const c = createClient({ url: pathToFileURL(target).href });
    try {
      const r = await c.execute("SELECT count(*) FROM notes WHERE v = 'only-in-the-legacy-wal'");
      return Number(r.rows[0][0]);
    } catch (err) {
      return `error: ${err?.message ?? err}`;
    } finally {
      c.close();
    }
  };

  const res = await post(restoreBackup, legacy);
  const walBesideTarget = await exists(`${target}-wal`);
  // What the PREVIOUS process does when it closes its last connection to a
  // WAL database: checkpoint into the file IT has open, then delete `-wal` by
  // NAME — which, after a restore, is the restored one.
  await fs.rm(`${target}-wal`, { force: true });
  await fs.rm(`${target}-shm`, { force: true });
  const noteAfterWalDeleted = await readNote();

  // A truncated archive: the right header, half the pages.
  const good = await fs.readFile(target);
  const truncated = {
    ...legacy, wal_base64: undefined,
    sqlite_base64: good.subarray(0, Math.floor(good.length / 2)).toString('base64'),
  };
  const bad = await post(restoreBackup, truncated);
  const badBody = await bad.json().catch(() => null);
  const noteAfterRefusal = await readNote();

  // A CORRUPT archive of the right length and a valid header: the freelist
  // count claims five free pages that do not exist. SQLite opens it and
  // checkpoints it without complaint — nothing but an integrity check counts
  // the freelist — so only the integrity check can stand between this archive
  // and the live file. (The truncated archive above is refused earlier, when
  // opening it fails; and smashing a b-tree page makes quick_check THROW,
  // which the same catch refuses. This one reaches the verdict itself.)
  const smashedBytes = Buffer.from(await fs.readFile(target));
  smashedBytes.writeUInt32BE(5, 36); // page-1 header: total number of freelist pages
  const smashed = await post(restoreBackup, {
    ...legacy, wal_base64: undefined, sqlite_base64: smashedBytes.toString('base64'),
  });
  const smashedBody = await smashed.json().catch(() => null);
  const noteAfterCorruptRefusal = await readNote();

  emit({
    legacyMainHasIt, restoreStatus: res.status, walBesideTarget, noteAfterWalDeleted,
    goodBytes: good.length, truncatedStatus: bad.status,
    truncatedMessage: String(badBody?.error?.message ?? JSON.stringify(badBody)).slice(0, 300),
    noteAfterRefusal,
    corruptStatus: smashed.status,
    corruptMessage: String(smashedBody?.error?.message ?? JSON.stringify(smashedBody)).slice(0, 300),
    noteAfterCorruptRefusal,
  });
  process.exit(0);
}

/* ----------------------------------------------------------------- parent --- */
let pass = 0;
let fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };

const tmpRoot = path.join(os.tmpdir(), `astrobaas-sqlite-conc-${process.pid}`);
await fs.mkdir(tmpRoot, { recursive: true });
const { createClient } = await import('@libsql/client');

const LS = await loadTs('src/lib/storage/local-sqlite.ts', 'localsqlite');
const { SqlStorage } = await loadTs('src/lib/storage/sql-storage.ts', 'sqlstorage');
const { LibsqlAdapter } = await loadTs('src/lib/storage/libsql-adapter.ts', 'libsqladapter');
const { LibsqlRateLimitStore } = await loadTs('src/lib/rate-limit.ts', 'ratelimit');

/* ---- 1. which URLs are touched ---- */
{
  for (const u of ['file:./data/shop.sqlite', 'file:/srv/shop.sqlite', 'file:///srv/shop.sqlite', 'file://localhost/srv/shop.sqlite']) {
    check(`${u} is a local file`, LS.isLocalSqliteFile(u) === true);
  }
  for (const u of ['libsql://shop.turso.io', 'https://shop.turso.io', 'wss://shop.turso.io', ':memory:', 'file::memory:', '', undefined]) {
    check(`${u} is NOT a local file`, LS.isLocalSqliteFile(u) === false);
  }
  check('file:///abs and a query string resolve to the bare path',
    LS.localSqlitePath('file:///srv/shop.sqlite?mode=rwc') === '/srv/shop.sqlite');
  check('file://localhost/abs resolves to /abs, not ./localhost/abs',
    LS.localSqlitePath('file://localhost/srv/shop.sqlite') === '/srv/shop.sqlite');
  check('a relative file: URL resolves against the working directory',
    LS.localSqlitePath('file:./data/shop.sqlite') === path.resolve('data/shop.sqlite'));
  check('the path is percent-decoded, as libsql decodes it',
    LS.localSqlitePath('file:/srv/my%20shop.sqlite') === '/srv/my shop.sqlite');

  // Remote databases are somebody else's server. Their configuration must be
  // byte-for-byte what it was: no timeout, no pool size, nothing added.
  const remote = LS.sqliteClientConfig('libsql://shop.turso.io', 'tok');
  check('a remote URL gets exactly the configuration it had before',
    JSON.stringify(remote) === JSON.stringify({ url: 'libsql://shop.turso.io', authToken: 'tok' }));
  const local = LS.sqliteClientConfig('file:/srv/shop.sqlite');
  check(`a local file waits at least 5 s for a lock on EVERY connection (timeout=${local.timeout})`,
    Number(local.timeout) >= 5000);
  check('a local file uses one connection, so a per-connection PRAGMA covers every statement', local.concurrency === 1);
}

/* ---- 2. every connection has the settings, after a transaction ---- */
async function inspectConnections(client) {
  // The two moments the pool hands a connection away: an interactive
  // transaction and a batch.
  const tx = await client.transaction('write');
  await tx.execute('CREATE TABLE IF NOT EXISTS probe (v TEXT)');
  await tx.execute({ sql: 'INSERT INTO probe VALUES (?)', args: ['t'] });
  // A statement from elsewhere in the process while the transaction holds its
  // connection. It must never run on a connection WITHOUT the settings: it is
  // refused (the one-connection pool) or it sees them.
  let during;
  try {
    during = Number((await client.execute('PRAGMA synchronous')).rows[0][0]);
  } catch (err) {
    during = err?.code ?? 'error';
  }
  await tx.commit();
  await client.batch([{ sql: 'INSERT INTO probe VALUES (?)', args: ['b'] }], 'write');

  // Then as many connections as the pool will hand out at once.
  const reads = await Promise.all(Array.from({ length: 6 }, async () => ({
    sync: Number((await client.execute('PRAGMA synchronous')).rows[0][0]),
    busy: Number((await client.execute('PRAGMA busy_timeout')).rows[0][0]),
  })));
  const journal = String((await client.execute('PRAGMA journal_mode')).rows[0][0]).toLowerCase();
  return { during, reads, journal };
}

for (const opener of [
  {
    name: 'relational SqlStorage',
    // The change-feed upkeep runs behind the boot; waited for, so the probe's
    // transaction is the only thing on the one connection.
    open: async (url) => { const s = new SqlStorage(url); await s.init(); await s.changeFeedUpkeep; return s.client; },
  },
  {
    name: 'doc-blob LibsqlAdapter',
    open: async (url) => { const a = new LibsqlAdapter({ url }); await a.read(); return a.client; },
  },
  {
    name: 'LibsqlRateLimitStore',
    open: async (url) => { const r = new LibsqlRateLimitStore(url); await r.consume('probe', 60000, 10); return r.client; },
  },
]) {
  const dir = path.join(tmpRoot, `conn-${opener.name.replace(/\W+/g, '-')}`);
  await fs.mkdir(dir, { recursive: true });
  const client = await opener.open(`file:${path.join(dir, 'db.sqlite')}`);
  const r = await inspectConnections(client);
  const t = (n, c) => check(`[${opener.name}] ${n}`, c);
  t(`the file is in WAL mode (journal_mode=${r.journal})`, r.journal === 'wal');
  t(`every connection, after a transaction and a batch, has synchronous=NORMAL (${r.reads.map((x) => x.sync).join(',')})`,
    r.reads.every((x) => x.sync === 1));
  t(`...and a busy timeout of at least 5 s (${r.reads.map((x) => x.busy).join(',')})`,
    r.reads.every((x) => x.busy >= 5000));
  t(`a statement issued DURING a transaction never lands on a connection without them (got ${r.during})`,
    r.during === 1 || r.during === 'TRANSACTION_ACTIVE');
  client.close();
}

/* ---- 3 & 4. two processes, one file ---- */

/** Spawn a child of this file and let the parent wait for a line it prints. */
function startChild(mode, env) {
  const child = spawn(process.execPath, [SELF], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, SQLITE_TEST_CHILD: mode, NODE_ENV: 'test', ...env },
  });
  let out = '';
  let err = '';
  const waiters = [];
  child.stdout.on('data', (d) => {
    out += d;
    for (const w of [...waiters]) if (out.includes(w.marker)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(); }
  });
  child.stderr.on('data', (d) => { err += d; });
  const exited = new Promise((resolve) => child.on('exit', (code) => {
    for (const w of waiters.splice(0)) w.reject(new Error(`[${mode}] exited (${code}) before printing ${w.marker}\n${err.slice(-1500)}`));
    resolve(code);
  }));
  return {
    exited,
    output: () => out,
    waitFor: (marker) => (out.includes(marker)
      ? Promise.resolve()
      : new Promise((resolve, reject) => waiters.push({ marker, resolve, reject }))),
  };
}
const resultOf = (text) => {
  const line = (text || '').split('\n').find((l) => l.startsWith('__RESULT__'));
  return line ? JSON.parse(line.slice('__RESULT__'.length)) : null;
};

{
  const dir = path.join(tmpRoot, 'two-processes');
  await fs.mkdir(dir, { recursive: true });
  const url = `file:${path.join(dir, 'shop.sqlite')}`;
  const site = new SqlStorage(url);
  await site.init();

  // 3a. The SITE writes while an outside process holds the write lock.
  {
    const holder = startChild('hold-write', { DATABASE_URL: url, HOLD_MS: String(HOLD_MS) });
    let ok = true;
    let code = null;
    let waited = 0;
    try {
      await holder.waitFor('HELD');
      const t0 = Date.now();
      try {
        await site.createProduct({ name: 'Checkout during an import', slug: 'during-import', status: 'active', price_cents: 100 });
      } catch (err) {
        ok = false;
        code = err?.code ?? err?.message;
      }
      waited = Date.now() - t0;
    } catch (err) {
      ok = false;
      code = err.message;
    }
    await holder.exited;
    check(`the site's write succeeds while another process holds the write lock (ok=${ok}, code=${code})`, ok);
    check(`...because it WAITED for the lock (${waited} ms), instead of failing in 0 ms`, waited >= HOLD_MS / 3);
    check('...and got it well inside the busy timeout', waited < 5000);
  }

  // 3b. THIS code as the second process (the importer), while the site is
  //     mid-write. The parent holds the lock until the child is about to write.
  {
    const raw = createClient({ url });
    const tx = await raw.transaction('write');
    await tx.execute({ sql: "INSERT INTO counters (id, data) VALUES ('site-busy', '{}')" });
    const cli = startChild('wait-write', { DATABASE_URL: url });
    try {
      await cli.waitFor('READY');
      await new Promise((r) => setTimeout(r, HOLD_MS));
    } catch (err) {
      console.error(err.message);
    }
    await tx.commit();
    raw.close();
    await cli.exited;
    const r = resultOf(cli.output()) ?? { ok: false, code: 'no result', waitedMs: 0 };
    check(`a second process's write waits for the site's lock and succeeds (ok=${r.ok}, code=${r.code})`, r.ok === true);
    check(`...after genuinely waiting (${r.waitedMs} ms)`, r.waitedMs >= HOLD_MS / 3);
  }

  // 4. WAL: a long reader in another process does not hold up the writer. In
  //    delete mode the writer's COMMIT needs every reader gone — so it either
  //    failed at once or, with a timeout, waited out the whole report.
  {
    const readHold = HOLD_MS * 2;
    const reader = startChild('hold-read', { DATABASE_URL: url, HOLD_MS: String(readHold) });
    let ok = true;
    let code = null;
    let waited = 0;
    try {
      await reader.waitFor('HELD');
      const t0 = Date.now();
      try {
        await site.createProduct({ name: 'While a report reads', slug: 'during-a-report', status: 'active', price_cents: 100 });
      } catch (err) {
        ok = false;
        code = err?.code ?? err?.message;
      }
      waited = Date.now() - t0;
    } catch (err) {
      ok = false;
      code = err.message;
    }
    await reader.exited;
    check(`a write while another process holds a long read succeeds (ok=${ok}, code=${code})`, ok);
    check(`...without waiting for the reader (${waited} ms, the reader held ${readHold} ms)`, waited < HOLD_MS / 2);
  }
}

/* ---- 5. backup and restore under WAL, and the running site after it ---- */
// Both drivers that hold the file open: the relational SqlStorage and the
// doc-blob LibsqlAdapter (an empty DATABASE_DRIVER selects doc-blob).
for (const driver of [
  { name: 'relational', env: { DATABASE_DRIVER: 'relational' } },
  { name: 'doc-blob', env: { DATABASE_DRIVER: '' } },
]) {
  const dir = path.join(tmpRoot, `backup-${driver.name}`);
  await fs.mkdir(path.join(dir, 'uploads'), { recursive: true });
  const file = path.join(dir, 'shop.sqlite');
  const env = {
    ...process.env, NODE_ENV: 'test', DATABASE_URL: `file:${file}`, ...driver.env,
    DB_FILE: file, UPLOADS_DIR: path.join(dir, 'uploads'),
  };
  const run = (mode) => {
    const r = spawnSync(process.execPath, [SELF], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...env, SQLITE_TEST_CHILD: mode },
    });
    const res = resultOf(r.stdout);
    if (!res) console.error(`[${driver.name}/${mode}] produced no result\n${(r.stderr || '').slice(-1500)}`);
    return res;
  };
  const t = (n, c) => check(`[${driver.name}] ${n}`, c);

  const live = run('backup-live');
  t('backup-live produced a result', !!live);
  if (live) {
    t(`(precondition) the write sits ONLY in the -wal when the backup starts (wal=${live.walBytes} B, in main file=${live.mainHasIt})`,
      live.walBytes > 0 && live.mainHasIt === false);
    t(`(precondition) the adversarial checkpoint really ran mid-backup (${JSON.stringify(live.checkpoint)})`,
      live.checkpoint !== null && live.checkpoint.busy === 0);
    t(`the backup succeeds (${live.payloadError ?? 'ok'})`, live.payloadOk === true);
    t('...as one self-contained database file, with no -wal sidecar', live.archiveCarriesWal === false);
    t(`the restore is accepted (status ${live.restoreStatus})`, live.restoreStatus === 200);
    t('...and asks for the restart it needs', live.restartRequired === true);
    t(`the running site, before any restart, already reads the restored database: the write made after the backup is gone from its view (${live.liveHasAfterBackup})`,
      live.liveHasAfterBackup === false);
    t(`a write made after the restore, before the restart, succeeds (${live.afterRestoreError ?? 'ok'})`,
      live.afterRestoreOk === true);
    t('...and the running site can read it back', live.liveHasAfterRestore === true);
  }

  const restarted = run('backup-restart');
  t('backup-restart produced a result', !!restarted);
  if (restarted) {
    t('THE write made just before the backup survives the backup-and-restore round trip', restarted.hasBefore === true);
    t('...and the write made AFTER the backup is gone — the restore really replaced the database',
      restarted.hasAfter === false);
    t(`...and the restarted site is back in WAL mode (journal_mode=${restarted.journal})`, restarted.journal === 'wal');
  }
  if (live && restarted) {
    // The finding, as one assertion: a write the site reported as done must
    // not be gone after the restart. (Refusing it loudly would also pass.)
    t(`a write reported ok between the restore and the restart is never lost at the restart (ok=${live.afterRestoreOk}, after restart=${restarted.hasAfterRestore})`,
      !(live.afterRestoreOk && !restarted.hasAfterRestore));
    t('...it is there after the restart: the site moved onto the restored file rather than writing into the replaced one',
      restarted.hasAfterRestore === true);
  }
}

/* ---- 6. an OLD archive, carrying a -wal, restored ---- */
{
  const dir = path.join(tmpRoot, 'legacy');
  await fs.mkdir(path.join(dir, 'uploads'), { recursive: true });
  const file = path.join(dir, 'restored.sqlite');
  const r = spawnSync(process.execPath, [SELF], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env, NODE_ENV: 'test', SQLITE_TEST_CHILD: 'legacy-restore', DATABASE_URL: `file:${file}`,
      DATABASE_DRIVER: 'relational', DB_FILE: file, UPLOADS_DIR: path.join(dir, 'uploads'),
    },
  });
  const res = resultOf(r.stdout);
  if (!res) console.error(`[legacy-restore] produced no result\n${(r.stderr || '').slice(-1500)}`);
  check('legacy-restore produced a result', !!res);
  if (res) {
    check('(precondition) the archive\'s newest commit is in its -wal, not its main file', res.legacyMainHasIt === false);
    check(`an archive carrying a -wal still restores (status ${res.restoreStatus})`, res.restoreStatus === 200);
    check('...into ONE file: nothing is left beside it for another process to delete', res.walBesideTarget === false);
    check(`...and the commit that was in the archive's -wal survives the old process deleting "-wal" (count=${res.noteAfterWalDeleted})`,
      res.noteAfterWalDeleted === 1);
    check(`a TRUNCATED archive (right header, half of ${res.goodBytes} bytes) is refused (status ${res.truncatedStatus}: ${res.truncatedMessage})`,
      res.truncatedStatus === 400);
    check(`...and the working database it would have replaced is untouched (count=${res.noteAfterRefusal})`,
      res.noteAfterRefusal === 1);
    // The message pins WHICH check refused it: the integrity check, not a
    // failure to open. A restore without quick_check swaps this file in.
    check(`a CORRUPT archive of the right length is refused by the integrity check (status ${res.corruptStatus}: ${res.corruptMessage})`,
      res.corruptStatus === 400 && /integrity check/i.test(res.corruptMessage));
    check(`...and the working database is untouched (count=${res.noteAfterCorruptRefusal})`,
      res.noteAfterCorruptRefusal === 1);
  }
}

/* ---- 7. an interrupted snapshot's or restore's leftovers are swept ---- */
{
  const dir = path.join(tmpRoot, 'sweep');
  await fs.mkdir(dir, { recursive: true });
  // A pid that WAS a process and is not any more: a child that has exited and
  // been reaped by spawnSync.
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  let deadIsGone = false;
  try {
    process.kill(dead, 0);
  } catch (err) {
    deadIsGone = err?.code === 'ESRCH';
  }
  const names = {
    deadSnapshot: `shop.sqlite.snapshot-${dead}-1757600000000-abc123`,
    deadSnapshotJournal: `shop.sqlite.snapshot-${dead}-1757600000000-abc123-journal`,
    deadRestore: `shop.sqlite.restore-${dead}`,
    deadRestoreWal: `shop.sqlite.restore-${dead}-wal`,
    // A backup running right now, in a live process (this one).
    liveSnapshot: `shop.sqlite.snapshot-${process.pid}-1757600000000-def456`,
    // Somebody else's database, in the same directory.
    otherDatabase: `other.sqlite.snapshot-${dead}-1757600000000-abc123`,
    // A copy an operator made and named by hand.
    handNamed: 'shop.sqlite.snapshot-before-migration',
  };
  for (const n of Object.values(names)) await fs.writeFile(path.join(dir, n), 'a partial database copy');

  const s = new SqlStorage(`file:${path.join(dir, 'shop.sqlite')}`);
  await s.init();
  const left = new Set(await fs.readdir(dir));
  s.client.close();

  check(`(precondition) pid ${dead} is not running`, deadIsGone);
  check('a snapshot left by a process that is gone is removed when the database is next opened',
    !left.has(names.deadSnapshot));
  check('...together with its journal', !left.has(names.deadSnapshotJournal));
  check('a restore\'s staging file left by a process that is gone is removed, with its -wal',
    !left.has(names.deadRestore) && !left.has(names.deadRestoreWal));
  check('a snapshot belonging to a RUNNING process is kept', left.has(names.liveSnapshot));
  check('another database\'s leftovers are not this database\'s to remove', left.has(names.otherDatabase));
  check('a file the pattern does not describe exactly is kept', left.has(names.handNamed));
  check('...and the database itself is untouched', left.has('shop.sqlite'));
}

/* ---- 8. the importer will not write a doc-blob database beside a running site ---- */
{
  // On doc-blob every write replaces the one row holding the whole site, so an
  // import and the site writing at once silently overwrite each other. The busy
  // timeout removed the lock error that used to make that loud; the importer
  // must refuse instead, until the operator says the site is stopped. An EMPTY
  // dump: nothing is imported, so what is exercised is the guard and the path
  // past it — the real script, spawned the way `npm run import:woo` runs it.
  const dir = path.join(tmpRoot, 'importer');
  const dump = path.join(dir, 'dump');
  await fs.mkdir(dump, { recursive: true });
  await fs.mkdir(path.join(dir, 'uploads'), { recursive: true });
  const importer = (dbFile, driver, extra = []) => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'import-woocommerce.mjs'), dump, '--apply', ...extra], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 120_000,
      env: {
        ...process.env, NODE_ENV: 'test', DATABASE_URL: `file:${dbFile}`, DATABASE_DRIVER: driver,
        UPLOADS_DIR: path.join(dir, 'uploads'),
      },
    });
    return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const blob = path.join(dir, 'blob.sqlite');
  const refused = importer(blob, '');
  const blobCreated = await exists(blob);
  const stopped = importer(blob, '', ['--site-stopped']);
  const relational = importer(path.join(dir, 'relational.sqlite'), 'relational');
  const tail = (r) => r.out.trim().split('\n').slice(-3).join(' | ').slice(0, 300);

  check(`on doc-blob, --apply without --site-stopped is refused (exit ${refused.status}: ${tail(refused)})`,
    refused.status === 1 && /--site-stopped/.test(refused.out));
  check('...before anything opened the database: the file was never created', blobCreated === false);
  check(`...and with --site-stopped the import runs (exit ${stopped.status}: ${tail(stopped)})`,
    stopped.status === 0 && /Created:/.test(stopped.out));
  check(`on the relational driver an import runs beside the site, no flag needed (exit ${relational.status}: ${tail(relational)})`,
    relational.status === 0 && /Created:/.test(relational.out));
}

await fs.rm(tmpRoot, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
