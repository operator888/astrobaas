#!/usr/bin/env node
/**
 * Multi-instance safety: two processes on one database.
 *
 * ## What was wrong
 *
 * Every process ran the scheduler, so a second replica sent every newsletter
 * batch, recovery reminder and back-in-stock notice twice and pushed a second
 * full backup. The off-site backup's history lived in memory, so every restart
 * was a full backup and a crash during one was a backup loop. Two processes
 * booting together both ran the migrations. The campaign cursor was read, the
 * batch sent, THEN the cursor written — two senders, two copies. The media
 * base, the redirect map and the plugin registry were refreshed only by the
 * process that took the write. LocalDB.init() rewrote the whole document on
 * every call.
 *
 * ## How this proves the fixes
 *
 * Real child processes on real temporary databases — all three drivers — for
 * everything that is about more than one process. Nothing here binds a port:
 * the off-site bucket is a stubbed `fetch` inside the child.
 *
 * Run with:  node tests/multi-instance.test.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { loadTs, ROOT } from './lib/load.mjs';

const MODE = process.env.MI_CHILD;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const emit = (tag, obj) => console.log(`${tag}${JSON.stringify(obj)}`);

/* ================================================================ child === */
if (MODE) {
  const M = await import(pathToFileURL(process.env.MI_BUNDLE).href);
  const { LocalDB, scheduler, shutdown, lease, migrations, email, offsiteState, ops } = M;
  const env = process.env;

  if (MODE === 'boot') {
    try {
      await LocalDB.init();
      emit('__BOOT__', { ok: true, version: await LocalDB.getSchemaVersion() });
    } catch (err) {
      emit('__BOOT__', { ok: false, error: err?.name, message: err?.message, version: await LocalDB.getSchemaVersion() });
    }
    process.exit(0);
  }

  if (MODE === 'setver') {
    await LocalDB.init();
    await LocalDB.setSchemaVersion(Number(env.MI_VERSION));
    emit('__SETVER__', { version: await LocalDB.getSchemaVersion() });
    process.exit(0);
  }

  if (MODE === 'sched') {
    await LocalDB.init();
    shutdown.installGracefulShutdown({
      exit: (code) => {
        emit('__EXIT__', { code, sweeps: scheduler.schedulerStatus(env).sweeps });
        process.exit(code);
      },
    });
    scheduler.startScheduler(env);
    setInterval(() => {}, 1000); // stands in for the HTTP server's socket
    let last = '';
    setInterval(() => {
      const s = scheduler.schedulerStatus(env);
      const key = `${s.role}|${s.sweeps}`;
      if (key !== last) {
        last = key;
        emit('__STATE__', { role: s.role, sweeps: s.sweeps, holder: s.lease?.holder ?? null, current: s.lease?.currentHolder ?? null });
      }
    }, 20);
    await new Promise(() => {});
  }

  if (MODE === 'backup') {
    // The bucket. Every request is logged to a file the parent reads, so a
    // backup that happens in a process that then dies is still counted.
    globalThis.fetch = async (url, init = {}) => {
      const method = String(init.method || 'GET').toUpperCase();
      fss.appendFileSync(env.MI_FETCH_LOG, `${JSON.stringify({ pid: process.pid, method, url: String(url) })}\n`);
      if (method === 'PUT' && env.MI_CRASH_ON_PUT) {
        // A crash in the middle of the upload: no outcome is ever recorded.
        process.kill(process.pid, 'SIGKILL');
        await new Promise(() => {});
      }
      if (method === 'PUT' && env.MI_SIGTERM_ON_PUT) {
        // A deploy arrives while the upload is on the wire.
        emit('__PUT__', {});
        process.kill(process.pid, 'SIGTERM');
      }
      if (method === 'PUT' && env.MI_PUT_DELAY_MS) await sleep(Number(env.MI_PUT_DELAY_MS));
      if (method === 'GET') {
        return new Response('<?xml version="1.0"?><ListBucketResult></ListBucketResult>', {
          status: 200, headers: { 'Content-Type': 'application/xml' },
        });
      }
      return new Response(null, { status: method === 'DELETE' ? 204 : 200 });
    };
    await LocalDB.init();
    if (env.MI_SIGTERM_ON_PUT) {
      shutdown.installGracefulShutdown({
        exit: (code) => { emit('__EXIT__', { code }); process.exit(code); },
      });
      setInterval(() => {}, 1000);
      scheduler.startScheduler(env);
      await new Promise(() => {});
    }
    scheduler.startScheduler(env);
    for (let i = 0; i < 400 && (scheduler.schedulerStatus(env).sweeps ?? 0) < 3; i++) await sleep(20);
    const res = await ops.GET({ url: 'http://cms.test/api/operations', locals: { user: { id: 'u', role: 'admin' } } });
    const body = await res.json();
    emit('__DONE__', {
      sweeps: scheduler.schedulerStatus(env).sweeps,
      role: scheduler.schedulerStatus(env).role,
      state: await offsiteState.readOffsiteState(),
      ops: body?.data?.backup ?? null,
    });
    scheduler.stopScheduler();
    await scheduler.awaitSchedulerSweep(5000);
    await scheduler.releaseSchedulerLease();
    process.exit(0);
  }

  if (MODE === 'state') {
    await LocalDB.init();
    emit('__STATE_READ__', await offsiteState.readOffsiteState());
    process.exit(0);
  }

  if (MODE === 'parse') {
    const P = offsiteState.parseOffsiteState;
    emit('__PARSE__', {
      garbage: P('nonsense'),
      array: P([1, 2]),
      badDates: P({ attempt: { id: 'x', started_at: 'yesterday' }, last: { ok: true, at: 'never' } }),
      good: P({
        attempt: { id: 'a1', started_at: '2026-09-01T00:00:00.000Z', by: 'h:1' },
        last: { ok: false, at: '2026-09-01T00:00:00.000Z', error: 'x' },
        last_success: { ok: true, at: '2026-08-31T00:00:00.000Z', key: 'k' },
      }),
    });
    process.exit(0);
  }

  if (MODE === 'migrate-slow') {
    // The real runner, made slow enough that two processes certainly overlap
    // if nothing keeps them apart. Deliberately NOT LocalDB.init(), which
    // would run the real migrations on its own first.
    const log = (ev) => fss.appendFileSync(env.MI_MIG_LOG, `${JSON.stringify({ ev, pid: process.pid, t: Date.now() })}\n`);
    // Both processes read the version at the same moment, as two replicas
    // started by one deploy would.
    const startAt = Number(env.MI_START_AT || 0);
    while (Date.now() < startAt) await sleep(2);
    let waited = false;
    const res = await migrations.runMigrationsExclusive(
      LocalDB,
      () => {},
      (fn) => lease.runExclusive('migrations', fn, {
        ttlMs: 60_000, waitMs: 20_000, pollMs: 50, onWait: () => { waited = true; },
      }),
      async (storage, l) => {
        log('enter');
        await sleep(700);
        const r = await migrations.runMigrations(storage, l);
        log('exit');
        return r;
      },
    );
    emit('__MIGRATED__', { waited, applied: res.applied.length, from: res.from, to: res.to, version: await LocalDB.getSchemaVersion() });
    process.exit(0);
  }

  if (MODE === 'campaign') {
    await LocalDB.init();
    const sent = [];
    const delay = Number(env.MI_SEND_DELAY_MS || 0);
    email.setEmailTransport({
      name: 'capture',
      async send(msg) {
        if (delay) await sleep(delay);
        sent.push(String(msg.to));
      },
    });
    if (env.MI_SEED) {
      for (let i = 0; i < 30; i++) await LocalDB.createSubscriber(`reader${String(i).padStart(2, '0')}@example.test`);
      await LocalDB.createCustomEntity('newsletter_campaign', {
        subject: 'Spring', body: 'New frames.', status: 'sending',
        cursor: 0, sent_count: 0, failed_count: 0, audience: 30,
      });
    }
    const startAt = Number(env.MI_START_AT || 0);
    while (Date.now() < startAt) await sleep(2);
    if (env.MI_STOPPED) scheduler.stopScheduler();
    const n = Number(env.MI_PARALLEL ?? 1);
    await Promise.all(Array.from({ length: n }, () => scheduler.maybeSendCampaign()));
    const [camp] = await LocalDB.getCustomEntities('newsletter_campaign');
    emit('__SENT__', { sent, campaign: camp?.data ?? null });
    process.exit(0);
  }

  if (MODE === 'cas') {
    await LocalDB.init();
    const T = 'mi_cas';
    const e = await LocalDB.createCustomEntity(T, { cursor: 0, status: 'sending', label: 'x' });
    const r = {};
    r.first = !!(await LocalDB.updateCustomEntityIf(T, e.id, { cursor: 0, status: 'sending' }, { cursor: 25 }));
    r.stale = !!(await LocalDB.updateCustomEntityIf(T, e.id, { cursor: 0 }, { cursor: 50 }));
    r.stringVsNumber = !!(await LocalDB.updateCustomEntityIf(T, e.id, { cursor: '25' }, { cursor: 99 }));
    r.missingIsNull = !!(await LocalDB.updateCustomEntityIf(T, e.id, { absent: null, cursor: 25 }, {
      flag: true, obj: { a: [1, 2] }, cleared: null, label: 'y',
    }));
    r.presentIsNotNull = !!(await LocalDB.updateCustomEntityIf(T, e.id, { label: null }, { label: 'z' }));
    r.unknownId = await LocalDB.updateCustomEntityIf(T, 'no-such-id', {}, { cursor: 1 });
    const back = await LocalDB.getCustomEntity(T, e.id);
    r.data = back?.data ?? null;
    r.feedHasUpdate = (await LocalDB.getContentChanges()).some((c) => c.entity_id === e.id && c.action === 'update');
    emit('__CAS__', r);
    process.exit(0);
  }

  if (MODE === 'initwrites') {
    const url = env.DATABASE_URL;
    let probe;
    let client = null;
    if (url) {
      const { createClient } = await import('@libsql/client');
      // ONE connection, so the two data_version reads are comparable.
      client = createClient({ url, concurrency: 1 });
      probe = async () => Number((await client.execute('PRAGMA data_version')).rows[0].data_version);
    } else {
      probe = async () => {
        const st = fss.statSync(env.DB_PATH);
        return `${st.ino}:${st.mtimeMs}:${st.size}`;
      };
    }
    await LocalDB.init();
    await sleep(20);
    const before = await probe();
    for (let i = 0; i < 5; i++) { await LocalDB.init(); await sleep(15); }
    const after = await probe();

    // A document missing a key must still be repaired, and saved.
    const readDoc = async () => (url
      ? JSON.parse(String((await client.execute("SELECT v FROM astrobaas_doc WHERE k = 'astrobaas'")).rows[0].v))
      : JSON.parse(fss.readFileSync(env.DB_PATH, 'utf8')));
    const doc = await readDoc();
    delete doc.brands;
    if (url) {
      await client.execute({ sql: "UPDATE astrobaas_doc SET v = ? WHERE k = 'astrobaas'", args: [JSON.stringify(doc)] });
    } else {
      fss.writeFileSync(env.DB_PATH, JSON.stringify(doc));
    }
    await sleep(20);
    const b2 = await probe();
    await LocalDB.init();
    const a2 = await probe();
    const repaired = await readDoc();
    emit('__INIT__', { before, after, b2, a2, repaired: Array.isArray(repaired.brands) });
    process.exit(0);
  }

  if (MODE === 'busy') {
    await LocalDB.init();
    const startAt = Number(env.MI_START_AT || 0);
    while (Date.now() < startAt) await sleep(2);
    const end = Date.now() + 1500;
    let ok = 0;
    let errors = 0;
    let lastErr = '';
    while (Date.now() < end) {
      try {
        await LocalDB.createCustomEntity('mi_busy', { pid: process.pid, n: ok });
        ok += 1;
      } catch (err) {
        errors += 1;
        lastErr = String(err?.message ?? err);
      }
    }
    emit('__BUSY__', { ok, errors, lastErr });
    process.exit(0);
  }

  if (MODE === 'count') {
    await LocalDB.init();
    emit('__COUNT__', { n: (await LocalDB.getCustomEntities(env.MI_TYPE)).length });
    process.exit(0);
  }

  console.error(`unknown mode ${MODE}`);
  process.exit(2);
}

/* =============================================================== parent === */
let pass = 0;
let fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };

const self = fileURLToPath(import.meta.url);
const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'astrobaas-multi-'));
const cacheDir = path.join(ROOT, 'node_modules', '.cache');
await fs.mkdir(cacheDir, { recursive: true });

// ONE bundle for every child, built once: the modules a child uses must share
// one copy of localdb.ts, and forty children each running esbuild would take
// longer than the tests.
const entry = path.join(cacheDir, `astrobaas-multi-entry-${process.pid}.ts`);
const bundle = path.join(cacheDir, `astrobaas-multi-${process.pid}.mjs`);
const src = (rel) => JSON.stringify(path.join(ROOT, rel));
await fs.writeFile(entry, [
  `export { LocalDB } from ${src('src/lib/localdb.ts')};`,
  `export * as scheduler from ${src('src/lib/scheduler.ts')};`,
  `export * as shutdown from ${src('src/lib/shutdown.ts')};`,
  `export * as lease from ${src('src/lib/lease.ts')};`,
  `export * as migrations from ${src('src/lib/migrations.ts')};`,
  `export * as email from ${src('src/lib/email.ts')};`,
  `export * as offsiteState from ${src('src/lib/backup/offsite-state.ts')};`,
  `export * as ops from ${src('src/pages/api/operations.ts')};`,
].join('\n'));
await build({
  entryPoints: [entry], bundle: true, format: 'esm', platform: 'node',
  packages: 'external', outfile: bundle, logLevel: 'silent',
});
await fs.rm(entry, { force: true });

const BASE_ENV = {
  NODE_ENV: 'test',
  MI_BUNDLE: bundle,
  AUTH_SECRET: 'multi-instance-test-secret-0123456789abcdef',
  // The children must not inherit a scheduler setting from whoever runs this.
  SCHEDULER_DISABLED: '',
  SCHEDULER_LEASE: '',
  SCHEDULER_LEASE_TTL_MS: '',
  DATABASE_URL: '',
  DATABASE_DRIVER: '',
  DB_PATH: '',
  EMAIL_TRANSPORT: '',
};

function startChild(mode, env = {}) {
  const p = spawn(process.execPath, [self], {
    cwd: ROOT,
    env: { ...process.env, ...BASE_ENV, ...env, MI_CHILD: mode },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const c = { p, lines: [], stderr: '', exited: null };
  let buf = '';
  p.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      c.lines.push({ at: Date.now(), line: buf.slice(0, i) });
      buf = buf.slice(i + 1);
    }
  });
  p.stderr.on('data', (d) => { c.stderr += d; });
  // A child that hangs is a failed check, not a hung suite.
  const guard = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* gone */ } }, 60_000);
  c.done = new Promise((resolve) => p.on('exit', (code, signal) => {
    clearTimeout(guard);
    c.exited = { code, signal, at: Date.now() };
    resolve(c.exited);
  }));
  c.all = (tag) => c.lines
    .filter((l) => l.line.startsWith(tag))
    .map((l) => ({ at: l.at, ...JSON.parse(l.line.slice(tag.length)) }));
  c.last = (tag) => c.all(tag).at(-1) ?? null;
  c.logs = () => c.lines.map((l) => { try { return JSON.parse(l.line); } catch { return null; } })
    .filter((j) => j && j.type === 'shutdown');
  c.waitFor = async (tag, pred = () => true, timeout = 10_000) => {
    const end = Date.now() + timeout;
    for (;;) {
      const hit = c.all(tag).find(pred);
      if (hit) return hit;
      if (c.exited || Date.now() > end) return null;
      await sleep(10);
    }
  };
  c.kill = (sig) => { try { p.kill(sig); } catch { /* gone */ } };
  return c;
}

async function run(mode, env, tag) {
  const c = startChild(mode, env);
  await c.done;
  const r = c.last(tag);
  // A child killed on purpose has nothing to report; any other silence is a bug.
  if (!r && !c.exited.signal) console.error(`  (${mode} produced no ${tag}; exit ${JSON.stringify(c.exited)})\n${c.stderr.slice(-1500)}`);
  return { ...c, r };
}

const DRIVERS = [
  { name: 'lowdb', env: (d) => ({ DB_PATH: path.join(d, 'db.json') }) },
  { name: 'libsql', env: (d) => ({ DATABASE_URL: `file:${path.join(d, 'db.sqlite')}` }) },
  { name: 'relational', env: (d) => ({ DATABASE_URL: `file:${path.join(d, 'db.sqlite')}`, DATABASE_DRIVER: 'relational' }) },
];
const ONLY = (process.env.MI_ONLY || '').split(',').filter(Boolean);
const section = (name) => ONLY.length === 0 || ONLY.includes(name);

async function freshDir(name) {
  const dir = path.join(tmpRoot, name);
  await fs.mkdir(path.join(dir, 'uploads'), { recursive: true });
  return dir;
}
const dirEnv = (dir) => ({ UPLOADS_DIR: path.join(dir, 'uploads'), PRIVATE_UPLOADS_DIR: path.join(dir, 'private') });

/* --- 1. the lease primitive, in-process ------------------------------------ */
const L = await loadTs('src/lib/lease.ts');
if (section('lease')) {
  const dir = await freshDir('lease-unit');
  const stores = [
    ['file', new L.FileLeaseStore(dir, 'db.json')],
    ['libsql', new L.LibsqlLeaseStore(`file:${path.join(dir, 'lease.sqlite')}`)],
  ];
  for (const [kind, store] of stores) {
    const t = (n, c) => check(`[lease:${kind}] ${n}`, c);
    const a = await store.acquire('job', 'holder-a', 60_000);
    t('the first holder gets it', a.acquired === true && a.holder === 'holder-a' && a.expiresAt > Date.now());
    const b = await store.acquire('job', 'holder-b', 60_000);
    t('a second holder does not, and is told who has it', b.acquired === false && b.holder === 'holder-a');
    t('the holder can extend it', (await store.acquire('job', 'holder-a', 60_000)).acquired === true);
    t('renew works for the holder...', (await store.renew('job', 'holder-a', 60_000)) === true);
    t('...and never for anybody else', (await store.renew('job', 'holder-b', 60_000)) === false);
    t('only the holder can release it', (await store.release('job', 'holder-b')) === false);
    t('...and the release by the holder removes it', (await store.release('job', 'holder-a')) === true
      && (await store.read('job')) === null);
    t('a released lease is free', (await store.acquire('job', 'holder-b', 60_000)).acquired === true);
    await store.release('job', 'holder-b');

    await store.acquire('short', 'holder-a', 250);
    t('a live short lease is still refused', (await store.acquire('short', 'holder-b', 60_000)).acquired === false);
    await sleep(350);
    const took = await store.acquire('short', 'holder-b', 60_000);
    t('an EXPIRED lease is taken over', took.acquired === true && took.holder === 'holder-b');
    t('...and the old holder can no longer renew it', (await store.renew('short', 'holder-a', 60_000)) === false);
    const info = await store.read('short');
    t('read reports the holder and the store clock', info?.holder === 'holder-b' && Math.abs(info.now - Date.now()) < 5_000);
    t('leases are separate by name', (await store.acquire('other', 'holder-a', 60_000)).acquired === true);

    let threw = false;
    try { await store.acquire('../escape', 'h', 1000); } catch { threw = true; }
    t('a name that could leave the directory is refused', threw);

    if (kind === 'libsql') {
      // The shared opener (storage/local-sqlite.ts): a lease that could not
      // wait for another process's write lock would fail exactly when two
      // processes are busy, and a pool of more than one connection would not
      // carry synchronous=NORMAL.
      // The same probe tests/sqlite-concurrency.test.mjs runs on the other
      // three openers: with a pool, a statement issued while a transaction
      // holds a connection runs on a NEW connection that has neither setting.
      const S = await loadTs('src/lib/storage/local-sqlite.ts');
      const client = store.client;
      const tx = await client.transaction('write');
      await tx.execute('CREATE TABLE IF NOT EXISTS mi_probe (v TEXT)');
      let during;
      try {
        during = Number((await client.execute('PRAGMA busy_timeout')).rows[0][0]);
      } catch (err) {
        during = err?.code ?? 'error';
      }
      await tx.commit();
      const reads = await Promise.all(Array.from({ length: 4 }, async () => ({
        sync: Number((await client.execute('PRAGMA synchronous')).rows[0][0]),
        busy: Number((await client.execute('PRAGMA busy_timeout')).rows[0][0]),
      })));
      const settings = await S.readSqliteSettings(client);
      t('the lease client is opened like every other local client (one connection: refused, never unconfigured)',
        during === 'TRANSACTION_ACTIVE' || during === S.SQLITE_BUSY_TIMEOUT_MS);
      t('...every statement it runs has the busy timeout and synchronous=NORMAL, in WAL',
        reads.every((r) => r.sync === 1 && r.busy === S.SQLITE_BUSY_TIMEOUT_MS) && settings.journal_mode === 'wal');
    }
  }

  // lowdb specifics: a dead pid on this host is taken over at once.
  {
    const t = (n, c) => check(`[lease:file] ${n}`, c);
    const store = new L.FileLeaseStore(dir, 'db.json');
    const file = store.fileFor('dead');
    const gone = spawn(process.execPath, ['-e', '0']);
    const deadPid = gone.pid;
    await new Promise((r) => gone.on('exit', r));
    await fs.writeFile(file, JSON.stringify({
      name: 'dead', holder: 'ghost', pid: deadPid, host: os.hostname(),
      expires_at: Date.now() + 3_600_000, acquired_at: Date.now(),
    }));
    const r = await store.acquire('dead', 'heir', 60_000);
    t('a lease whose process is dead on this host is taken over before it expires', r.acquired === true);

    await fs.writeFile(store.fileFor('remote'), JSON.stringify({
      name: 'remote', holder: 'far', pid: deadPid, host: 'some-other-host',
      expires_at: Date.now() + 3_600_000, acquired_at: Date.now(),
    }));
    t('...but a pid from ANOTHER host proves nothing, and is waited out',
      (await store.acquire('remote', 'heir', 60_000)).acquired === false);

    // A mutex left by a process killed inside its critical section.
    const lock = `${store.fileFor('locked')}.lock`;
    await fs.writeFile(lock, JSON.stringify({ pid: process.pid, host: os.hostname(), at: Date.now() }));
    let busy = false;
    try { await store.acquire('locked', 'h', 60_000); } catch (err) { busy = /busy/.test(err.message); }
    t('a fresh mutex held by a live process makes the store report busy, not decide', busy);
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(lock, old, old);
    t('a stale mutex is broken and the lease taken', (await store.acquire('locked', 'h', 60_000)).acquired === true);

    const leftovers = (await fs.readdir(dir)).filter((f) => f.endsWith('.tmp') || f.endsWith('.lock'));
    t('no temp or mutex files are left behind', leftovers.length === 0);
  }

  // Leadership: what a holder BELIEVES, on a fake clock.
  {
    const t = (n, c) => check(`[leadership] ${n}`, c);
    let now = 0;
    let mode = 'grant';
    const fake = {
      kind: 'file',
      async acquire(name, holder, ttl) {
        if (mode === 'error') throw new Error('store down');
        return mode === 'grant'
          ? { acquired: true, holder, expiresAt: 1_000_000 + ttl }
          : { acquired: false, holder: 'someone-else', expiresAt: 2_000_000 };
      },
      async renew() { return true; },
      async release() { return true; },
      async read() { return null; },
    };
    const lead = new L.Leadership({ name: 'scheduler', ttlMs: 10_000, holder: 'me', store: fake, clock: () => now });
    t('not a leader before the first tick', lead.isLeader() === false);
    t('a granted tick makes it the leader', (await lead.tick()) === true && lead.snapshot().leading === true);
    now = 8_999;
    t('it believes it leads up to TTL minus the margin', lead.isLeader() === true);
    now = 9_000;
    t('...and not a moment after, without any I/O', lead.isLeader() === false);
    now = 9_500;
    mode = 'error';
    t('a store error does not extend a belief that has run out', (await lead.tick()) === false);
    t('...and records why', /store down/.test(lead.snapshot().lastError ?? ''));
    mode = 'grant';
    await lead.tick();
    now = 12_000;
    mode = 'error';
    t('a store error within the belief keeps it leading (the lease is still ours)', (await lead.tick()) === true);
    now = 20_000;
    t('...until the belief runs out', (await lead.tick()) === false);
    mode = 'deny';
    t('a refused tick makes it a follower that knows the leader',
      (await lead.tick()) === false && lead.snapshot().currentHolder === 'someone-else');
    mode = 'grant';
    await lead.tick();
    t('release steps down at once', (await lead.release()) === true && lead.isLeader() === false);

    let calls = 0;
    const slow = { ...fake, async acquire(n, h, ttl) { calls++; await sleep(30); return { acquired: true, holder: h, expiresAt: ttl }; } };
    const l2 = new L.Leadership({ name: 'x', ttlMs: 10_000, store: slow });
    await Promise.all([l2.tick(), l2.tick(), l2.tick()]);
    t('overlapping ticks share one store call', calls === 1);
  }

  // runExclusive in one process: the second caller waits, then runs alone.
  {
    const t = (n, c) => check(`[exclusive] ${n}`, c);
    const store = new L.FileLeaseStore(dir, 'excl.json');
    const events = [];
    let waited = false;
    const job = (id, ms) => async () => { events.push(`in:${id}`); await sleep(ms); events.push(`out:${id}`); return id; };
    const [a, b] = await Promise.all([
      L.runExclusive('m', job('a', 150), { ttlMs: 5_000, waitMs: 5_000, pollMs: 20, store, holder: 'A' }),
      (async () => {
        await sleep(20);
        return L.runExclusive('m', job('b', 10), {
          ttlMs: 5_000, waitMs: 5_000, pollMs: 20, store, holder: 'B', onWait: () => { waited = true; },
        });
      })(),
    ]);
    t('both ran', a === 'a' && b === 'b');
    t('one after the other, never together', events.join(',') === 'in:a,out:a,in:b,out:b');
    t('the second one waited for the lease', waited);
    t('the lease is released afterwards', (await store.read('m')) === null);

    await store.acquire('m', 'squatter', 60_000);
    let err = null;
    const t0 = Date.now();
    try {
      await L.runExclusive('m', job('c', 1), { ttlMs: 5_000, waitMs: 200, pollMs: 20, store, holder: 'C' });
    } catch (e) { err = e; }
    t('a lease that stays held ends the wait with LeaseWaitTimeout',
      err?.name === 'LeaseWaitTimeout' && /squatter/.test(err.message) && Date.now() - t0 < 2_000);
    t('...and the work did not run', !events.includes('in:c'));
    await store.release('m', 'squatter');

    let ran = false;
    const broken = { kind: 'file', async acquire() { throw new Error('EROFS'); }, async renew() { return false; }, async release() { return false; }, async read() { return null; } };
    await L.runExclusive('m', async () => { ran = true; }, { ttlMs: 1000, waitMs: 1000, store: broken });
    t('a store that cannot be reached at all does not stop the work', ran);

    // The heartbeat keeps a long job's lease alive past its TTL.
    const hb = new L.FileLeaseStore(dir, 'hb.json');
    let midway = null;
    await L.runExclusive('long', async () => {
      await sleep(700);
      midway = await hb.acquire('long', 'intruder', 5_000);
    }, { ttlMs: 300, waitMs: 1_000, store: hb, holder: 'worker' });
    t('a job that outlives its TTL keeps the lease (renewed while it runs)', midway?.acquired === false && midway.holder === 'worker');
  }

  // The scheduler's knobs.
  {
    const U = await loadTs('src/lib/scheduler-util.ts');
    const t = (n, c) => check(`[scheduler-util] ${n}`, c);
    t('the lease is on by default', U.schedulerLeaseEnabled({}) === true);
    t('SCHEDULER_LEASE=0/false/off turns it off',
      !U.schedulerLeaseEnabled({ SCHEDULER_LEASE: '0' }) && !U.schedulerLeaseEnabled({ SCHEDULER_LEASE: 'false' })
        && !U.schedulerLeaseEnabled({ SCHEDULER_LEASE: 'OFF' }));
    t('the TTL is three intervals by default', U.schedulerLeaseTtlMs({}) === 180_000);
    t('...and never less than two intervals plus a second',
      U.schedulerLeaseTtlMs({ SCHEDULER_LEASE_TTL_MS: '5000' }) === 121_000
        && U.schedulerLeaseTtlMs({ SCHEDULER_INTERVAL_MS: '200' }) === 1_400);
    t('a longer TTL is honoured', U.schedulerLeaseTtlMs({ SCHEDULER_LEASE_TTL_MS: '600000' }) === 600_000);
    t('nonsense falls back to the default', U.schedulerLeaseTtlMs({ SCHEDULER_LEASE_TTL_MS: 'soon' }) === 180_000);

  }
}

/* --- 2. the scheduler: one sweeper per database ---------------------------- */
if (section('scheduler')) {
  for (const driver of DRIVERS) {
    const t = (n, c) => check(`[scheduler:${driver.name}] ${n}`, c);
    const dir = await freshDir(`sched-${driver.name}`);
    // Interval 200 ms, so the lease TTL is 1.4 s.
    const env = { ...driver.env(dir), ...dirEnv(dir), SCHEDULER_INTERVAL_MS: '200', SHUTDOWN_TIMEOUT_MS: '3000' };
    await run('boot', env, '__BOOT__'); // create the database first, so the race below is only for the lease

    const A = startChild('sched', env);
    const B = startChild('sched', env);
    const up = (s) => s.role === 'leader' || s.role === 'follower';
    await Promise.all([A.waitFor('__STATE__', up, 20_000), B.waitFor('__STATE__', up, 20_000)]);
    await sleep(1_500);
    const a = A.last('__STATE__');
    const b = B.last('__STATE__');
    if (!a || !b) {
      t('both children started', false);
      console.error(A.stderr.slice(-800), B.stderr.slice(-800));
      A.kill('SIGKILL'); B.kill('SIGKILL');
      continue;
    }
    t('two processes started together: exactly one leads', [a.role, b.role].sort().join(',') === 'follower,leader');
    const [leader, follower, ls, fs_] = a.role === 'leader' ? [A, B, a, b] : [B, A, b, a];
    t('the leader sweeps', ls.sweeps >= 3);
    t('THE FIX: the follower has not swept once', fs_.sweeps === 0);
    t('the follower knows which process leads', fs_.current === ls.holder && !!ls.holder);

    // A clean shutdown hands over at once.
    leader.kill('SIGTERM');
    const exited = await leader.done;
    const drained = leader.logs().find((l) => l.msg === 'drained');
    t('the leader drains and exits 0', exited.code === 0 && leader.last('__EXIT__')?.code === 0);
    t('...having released the lease after its final flush', drained?.lease_released === true && drained?.sweep_abandoned === false);
    const took = await follower.waitFor('__STATE__', (s) => s.role === 'leader', 5_000);
    t('the follower takes over at its next tick, not after the 1.4 s TTL', !!took && took.at - exited.at < 900);
    await sleep(700);
    t('...and starts sweeping', (follower.last('__STATE__')?.sweeps ?? 0) >= 2);

    // A crash does not: the lease has to lapse (or, on lowdb, its pid be dead).
    const C = startChild('sched', env);
    await C.waitFor('__STATE__', (s) => s.role === 'follower', 20_000);
    await sleep(300);
    const killedAt = Date.now();
    follower.kill('SIGKILL');
    await follower.done;
    const tookC = await C.waitFor('__STATE__', (s) => s.role === 'leader', 8_000);
    const delay = tookC ? tookC.at - killedAt : Infinity;
    t('a third process stayed a follower (and did not sweep) while the leader lived',
      C.all('__STATE__').filter((s) => s.at < killedAt).every((s) => s.role === 'follower' && s.sweeps === 0));
    if (driver.name === 'lowdb') {
      t(`a crashed leader on this host is replaced at the next tick — its pid is dead (${delay} ms)`, delay < 1_000);
    } else {
      t(`a crashed leader is replaced once its lease lapses, not before (${delay} ms)`, delay >= 900 && delay < 4_000);
    }
    C.kill('SIGTERM');
    await C.done;
    t('the last leader also drains cleanly', C.exited.code === 0);
  }

  // The escape hatch: SCHEDULER_LEASE=0 is the old behaviour, both sweep.
  {
    const t = (n, c) => check(`[scheduler:lease-off] ${n}`, c);
    const dir = await freshDir('sched-off');
    const env = { DB_PATH: path.join(dir, 'db.json'), ...dirEnv(dir), SCHEDULER_INTERVAL_MS: '200', SCHEDULER_LEASE: '0' };
    await run('boot', env, '__BOOT__');
    const A = startChild('sched', env);
    const B = startChild('sched', env);
    await Promise.all([
      A.waitFor('__STATE__', (s) => s.sweeps >= 2, 20_000),
      B.waitFor('__STATE__', (s) => s.sweeps >= 2, 20_000),
    ]);
    t('with the lease off, every process is standalone and sweeps',
      A.last('__STATE__')?.role === 'standalone' && B.last('__STATE__')?.role === 'standalone'
        && A.last('__STATE__').sweeps >= 2 && B.last('__STATE__').sweeps >= 2);
    A.kill('SIGKILL'); B.kill('SIGKILL');
    await Promise.all([A.done, B.done]);
    t('...and no lease file is written', !fss.existsSync(path.join(dir, 'db.json.scheduler.lease')));
  }

  // SCHEDULER_DISABLED still means no scheduler at all.
  {
    const dir = await freshDir('sched-disabled');
    const env = { DB_PATH: path.join(dir, 'db.json'), ...dirEnv(dir), SCHEDULER_INTERVAL_MS: '200', SCHEDULER_DISABLED: '1' };
    const A = startChild('sched', env);
    await A.waitFor('__STATE__', () => true, 20_000);
    await sleep(600);
    check('[scheduler] SCHEDULER_DISABLED=1: never started, never swept, no lease',
      A.last('__STATE__')?.role === null && A.last('__STATE__')?.sweeps === 0
        && !fss.existsSync(path.join(dir, 'db.json.scheduler.lease')));
    A.kill('SIGKILL');
    await A.done;
  }
}

/* --- 3. the off-site backup survives a restart, and a crash ---------------- */
if (section('backup')) {
  const O = await loadTs('src/lib/backup/offsite.ts');
  {
    const t = (n, c) => check(`[backup:due] ${n}`, c);
    const cfg = { everyHours: 24 };
    const t0 = Date.parse('2026-09-10T12:00:00Z');
    const ok = (iso) => ({ ok: true, at: iso });
    const bad = (iso) => ({ ok: false, at: iso, error: 'nope' });
    const state = (over) => ({ attempt: null, last: null, last_success: null, ...over });
    t('a restarted process with an empty memory is NOT due when the record says a backup ran an hour ago',
      O.backupDue(cfg, null, t0, state({ last: ok('2026-09-10T11:00:00Z') })) === false);
    t('...and is due once the interval has passed',
      O.backupDue(cfg, null, t0, state({ last: ok('2026-09-09T11:00:00Z') })) === true);
    t('a recorded UPLOAD failure is retried now, as before',
      O.backupDue(cfg, null, t0, state({ last: { ...bad('2026-09-10T11:59:00Z'), transient: true }, last_success: ok('2026-09-10T00:00:00Z') })) === true);
    // main's rule for a failure to BUILD the archive (a VACUUM each time) holds
    // for a failure read from the record just as for one in memory.
    t('a recorded BUILD failure waits its hour, even in a process that did not see it',
      O.backupDue(cfg, null, t0, state({ last: bad('2026-09-10T11:30:00Z') })) === false
        && O.backupDue(cfg, null, t0, state({ last: bad('2026-09-10T10:59:00Z') })) === true);
    t('an attempt that started 5 minutes ago and never finished blocks another',
      O.backupDue(cfg, null, t0, state({ attempt: { id: 'a', started_at: '2026-09-10T11:55:00Z', by: 'x' } })) === false);
    t('...until it is older than the attempt timeout (1 h)',
      O.backupDue(cfg, null, t0, state({ attempt: { id: 'a', started_at: '2026-09-10T10:59:00Z', by: 'x' } })) === true);
    t('the newer of memory and record wins',
      O.backupDue(cfg, ok('2026-09-10T11:30:00Z'), t0, state({ last: bad('2026-09-10T11:00:00Z') })) === false
        && O.backupDue(cfg, ok('2026-09-09T00:00:00Z'), t0, state({ last: ok('2026-09-10T11:00:00Z') })) === false);
    t('without a record the old three-argument rules still hold',
      O.backupDue(cfg, null, t0) === true && O.backupDue(cfg, ok('2026-09-10T11:00:00Z'), t0) === false);
    t('the attempt timeout is never longer than the schedule', O.attemptTimeoutMs({ everyHours: 0.5 }, {}) === 1_800_000
      && O.attemptTimeoutMs({ everyHours: 24 }, { BACKUP_ATTEMPT_TIMEOUT_MS: '5000' }) === 5_000
      && O.attemptTimeoutMs({ everyHours: 24 }, { BACKUP_ATTEMPT_TIMEOUT_MS: '5' }) === 3_600_000);

    const h = (p, mine = null, nowMs = t0) => O.backupHealth(cfg, p, mine, nowMs);
    t('health: not configured is ok', O.backupHealth(null, null, null, t0).status === 'ok');
    t('health: a recent success is ok', h(state({ last: ok('2026-09-10T11:00:00Z'), last_success: ok('2026-09-10T11:00:00Z') })).status === 'ok');
    t('health: a failure is a WARNING, never a failure',
      h(state({ last: bad('2026-09-10T11:00:00Z') })).status === 'warn' && /nope/.test(h(state({ last: bad('2026-09-10T11:00:00Z') })).detail));
    t('health: a success older than two intervals warns', h(state({ last: ok('2026-09-07T00:00:00Z'), last_success: ok('2026-09-07T00:00:00Z') })).status === 'warn');
    t('health: an attempt that never finished warns once it is past its timeout',
      h(state({ attempt: { id: 'a', started_at: '2026-09-10T09:00:00Z', by: 'x' } })).status === 'warn'
        && h(state({ attempt: { id: 'a', started_at: '2026-09-10T11:59:00Z', by: 'x' } })).status === 'ok');
  }

  {
    const dir = await freshDir('parse');
    const p = await run('parse', { DB_PATH: path.join(dir, 'db.json'), ...dirEnv(dir) }, '__PARSE__');
    const t = (n, c) => check(`[backup:record] ${n}`, c);
    const empty = (s) => s && s.attempt === null && s.last === null && s.last_success === null;
    t('a stored value of the wrong shape reads as nothing remembered', empty(p.r?.garbage) && empty(p.r?.array) && empty(p.r?.badDates));
    t('a good one reads back whole', p.r?.good?.attempt?.id === 'a1' && p.r.good.last?.ok === false && p.r.good.last_success?.key === 'k');
  }

  for (const driver of DRIVERS) {
    const t = (n, c) => check(`[backup:${driver.name}] ${n}`, c);
    const setup = async (name) => {
      const dir = await freshDir(`backup-${driver.name}-${name}`);
      const log = path.join(dir, 'bucket.log');
      await fs.writeFile(log, '');
      const env = {
        ...driver.env(dir), ...dirEnv(dir),
        SCHEDULER_INTERVAL_MS: '100',
        BACKUP_S3_ENDPOINT: 'http://bucket.test.invalid', BACKUP_S3_ALLOW_HTTP: '1',
        BACKUP_S3_BUCKET: 'b', BACKUP_S3_KEY_ID: 'k', BACKUP_S3_SECRET: 's',
        BACKUP_EVERY_HOURS: '24', BACKUP_ATTEMPT_TIMEOUT_MS: '',
        MI_FETCH_LOG: log,
      };
      const puts = () => fss.readFileSync(log, 'utf8').split('\n').filter(Boolean)
        .map((l) => JSON.parse(l)).filter((q) => q.method === 'PUT').length;
      return { env, puts };
    };

    // A restart.
    {
      const { env, puts } = await setup('restart');
      const one = await run('backup', env, '__DONE__');
      t('the first process backs up', puts() === 1 && one.r?.state?.last?.ok === true && one.r.state.attempt === null);
      t('...and the record says so, success included', one.r?.state?.last_success?.key === one.r?.state?.last?.key);
      t('the operations screen reads the record', one.r?.ops?.last?.ok === true && one.r.ops.lastSuccess?.ok === true
        && one.r.ops.inProgress === null && one.r.ops.due === false);
      const two = await run('backup', env, '__DONE__');
      t('THE FIX: a restarted process does not back up again when none is due', puts() === 1 && (two.r?.sweeps ?? 0) >= 3);
      t('...and still shows the last backup rather than "none yet"', two.r?.ops?.last?.key === one.r?.state?.last?.key);
    }

    // A crash in the middle of one.
    {
      const { env, puts } = await setup('crash');
      const crashed = await run('backup', { ...env, MI_CRASH_ON_PUT: '1' }, '__DONE__');
      t('the crashing process really died mid-upload', crashed.exited.signal === 'SIGKILL' && puts() === 1);
      const after = await run('backup', env, '__DONE__');
      t('THE FIX: the process that comes up next does NOT start the same backup again', puts() === 1 && (after.r?.sweeps ?? 0) >= 3);
      t('...it sees the unfinished attempt, and so does the screen',
        !!after.r?.state?.attempt?.started_at && !!after.r?.ops?.inProgress?.started_at && after.r?.ops?.due === false);
      await sleep(1_100);
      const retry = await run('backup', { ...env, BACKUP_ATTEMPT_TIMEOUT_MS: '1000' }, '__DONE__');
      t('once the attempt is past its timeout it is retried — exactly once', puts() === 2
        && retry.r?.state?.last?.ok === true && retry.r.state.attempt === null);
    }
  }
}

/* --- 3b. a shutdown waits for the sweep in flight, then hands over ---------- */
if (section('drain')) {
  const S = await loadTs('src/lib/shutdown.ts');
  {
    const t = (n, c) => check(`[drain] ${n}`, c);
    let now = 0;
    const calls = [];
    const deps = {
      markDraining: () => calls.push('draining'),
      stopScheduler: () => { calls.push('stop'); return true; },
      inflight: () => (now >= 300 ? 0 : 1),
      flushViews: async () => { calls.push(`flush@${now}`); return 2; },
      pendingViews: () => 0,
      now: () => now,
      sleep: async (ms) => { now += ms; },
      awaitSweep: async (ms) => { calls.push(`sweep@${now}:${ms}`); now += 500; return true; },
      releaseLease: async () => { calls.push(`release@${now}`); return true; },
    };
    const rep = await S.drain('SIGTERM', 10_000, deps);
    t('order: stop, wait for requests, wait for the sweep, flush, THEN release the lease',
      calls.join(',') === 'draining,stop,sweep@300:7700,flush@800,release@800');
    t('the sweep gets what is left of the request budget, not the flush reserve', calls[2] === 'sweep@300:7700');
    t('the report says the sweep finished and the lease was released',
      rep.sweep_abandoned === false && rep.lease_released === true && rep.views_written === 2);

    const hung = { ...deps, awaitSweep: () => new Promise(() => {}), releaseLease: () => new Promise(() => {}) };
    now = 300;
    const t0 = Date.now();
    const r2 = await S.drain('SIGTERM', 0, hung);
    t('a sweep and a release that never settle cannot hold the exit',
      r2.sweep_abandoned === true && r2.lease_released === false && Date.now() - t0 < 3_000);
  }

  for (const driver of DRIVERS) {
    const t = (n, c) => check(`[drain:${driver.name}] ${n}`, c);
    const dir = await freshDir(`drain-${driver.name}`);
    const log = path.join(dir, 'bucket.log');
    await fs.writeFile(log, '');
    const env = {
      ...driver.env(dir), ...dirEnv(dir),
      SCHEDULER_INTERVAL_MS: '100',
      BACKUP_S3_ENDPOINT: 'http://bucket.test.invalid', BACKUP_S3_ALLOW_HTTP: '1',
      BACKUP_S3_BUCKET: 'b', BACKUP_S3_KEY_ID: 'k', BACKUP_S3_SECRET: 's',
      BACKUP_EVERY_HOURS: '24', MI_FETCH_LOG: log, MI_SIGTERM_ON_PUT: '1',
    };
    // SIGTERM lands while a backup upload takes 800 ms; the budget is 4 s.
    const c = startChild('backup', { ...env, MI_PUT_DELAY_MS: '800', SHUTDOWN_TIMEOUT_MS: '4000' });
    await c.done;
    const drained = c.logs().find((l) => l.msg === 'drained');
    t('the upload was in flight when the signal came', !!c.last('__PUT__'));
    t('the drain waited for the sweep and exited 0', c.exited.code === 0 && drained?.sweep_abandoned === false);
    t('...then gave up the lease', drained?.lease_released === true);
    const after = await run('state', { ...driver.env(dir), ...dirEnv(dir) }, '__STATE_READ__');
    t('THE FIX: the backup the sweep was running got to record its outcome before the exit',
      after.r?.attempt === null && after.r?.last?.ok === true);

    // ...but only within the budget.
    const dir2 = await freshDir(`drain-slow-${driver.name}`);
    const log2 = path.join(dir2, 'bucket.log');
    await fs.writeFile(log2, '');
    const t0 = Date.now();
    const slow = startChild('backup', {
      ...env, ...driver.env(dir2), ...dirEnv(dir2), MI_FETCH_LOG: log2,
      MI_PUT_DELAY_MS: '20000', SHUTDOWN_TIMEOUT_MS: '1500',
    });
    await slow.done;
    const line = slow.logs().find((l) => l.type === 'shutdown' && 'sweep_abandoned' in l);
    t('a sweep that outlasts the budget is abandoned, not waited for',
      slow.exited.code === 0 && line?.sweep_abandoned === true && Date.now() - t0 < 15_000);
    const left = await run('state', { ...driver.env(dir2), ...dirEnv(dir2) }, '__STATE_READ__');
    t('...and the attempt it abandoned stays marked, so the next process does not repeat it at once',
      !!left.r?.attempt?.started_at && left.r?.last === null);
  }
}

/* --- 4. migrations: one process at a time ---------------------------------- */
if (section('migrations')) {
  const MG = await loadTs('src/lib/migrations.ts');
  for (const driver of DRIVERS) {
    const t = (n, c) => check(`[migrations:${driver.name}] ${n}`, c);

    // A lease someone else holds keeps a booting process from migrating.
    {
      const dir = await freshDir(`mig-held-${driver.name}`);
      const env = { ...driver.env(dir), ...dirEnv(dir) };
      await run('boot', env, '__BOOT__');
      await run('setver', { ...env, MI_VERSION: '1' }, '__SETVER__');
      const store = L.selectLeaseStore({ ...driver.env(dir) });
      const held = await store.acquire('migrations', 'another-process', 60_000);
      const blocked = await run('boot', { ...env, MIGRATION_LOCK_WAIT_MS: '500' }, '__BOOT__');
      t('a boot that cannot get the migrations lease does not migrate',
        held.acquired && blocked.r?.ok === false && blocked.r.error === 'LeaseWaitTimeout' && blocked.r.version === 1);
      t('...and says who holds it', /another-process/.test(blocked.r?.message ?? ''));
      await store.release('migrations', 'another-process');
      const freed = await run('boot', env, '__BOOT__');
      t('once it is free, the same boot migrates to the latest version',
        freed.r?.ok === true && freed.r.version === MG.LATEST_SCHEMA_VERSION);
      const again = await run('boot', { ...env, MIGRATION_LOCK_WAIT_MS: '0' }, '__BOOT__');
      await store.acquire('migrations', 'another-process', 60_000);
      const current = await run('boot', { ...env, MIGRATION_LOCK_WAIT_MS: '0' }, '__BOOT__');
      t('a CURRENT database boots without the lease at all (even while somebody holds it)',
        again.r?.ok === true && current.r?.ok === true);
      await store.release('migrations', 'another-process');
    }

    // Two processes booting the same legacy database.
    {
      const dir = await freshDir(`mig-race-${driver.name}`);
      const env = { ...driver.env(dir), ...dirEnv(dir) };
      await run('boot', env, '__BOOT__');
      await run('setver', { ...env, MI_VERSION: '1' }, '__SETVER__');
      const log = path.join(dir, 'mig.log');
      await fs.writeFile(log, '');
      const startAt = String(Date.now() + 2_000);
      const A = startChild('migrate-slow', { ...env, MI_MIG_LOG: log, MI_START_AT: startAt });
      const B = startChild('migrate-slow', { ...env, MI_MIG_LOG: log, MI_START_AT: startAt });
      await Promise.all([A.done, B.done]);
      const ra = A.last('__MIGRATED__');
      const rb = B.last('__MIGRATED__');
      if (!ra || !rb) {
        t('both processes finished booting', false);
        console.error(A.stderr.slice(-800), B.stderr.slice(-800));
        continue;
      }
      const events = fss.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
        .sort((x, y) => x.t - y.t);
      const seq = events.map((e) => e.ev).join(',');
      t('THE FIX: the two never migrate at the same time', seq === 'enter,exit,enter,exit'
        && events[0].pid === events[1].pid && events[2].pid === events[3].pid);
      t('exactly one of them applied the migrations', [ra.applied, rb.applied].filter((n) => n > 0).length === 1);
      const second = ra.applied === 0 ? ra : rb;
      t('the other waited for the lease, re-read the version and applied nothing',
        second.waited === true && second.applied === 0 && second.from === MG.LATEST_SCHEMA_VERSION);
      t('the database ends at the latest version', ra.version === MG.LATEST_SCHEMA_VERSION && rb.version === MG.LATEST_SCHEMA_VERSION);
    }
  }
}

/* --- 5. the newsletter campaign: a batch is claimed before it is sent ------ */
if (section('campaign')) {
  const dupes = (list) => list.length - new Set(list).size;
  for (const driver of DRIVERS) {
    const t = (n, c) => check(`[campaign:${driver.name}] ${n}`, c);
    {
      const dir = await freshDir(`camp-${driver.name}`);
      const env = { ...driver.env(dir), ...dirEnv(dir) };
      const one = await run('campaign', { ...env, MI_SEED: '1', MI_PARALLEL: '2', MI_SEND_DELAY_MS: '5' }, '__SENT__');
      t('THE FIX: two sends side by side send one batch, nobody twice',
        one.r?.sent?.length === 25 && dupes(one.r.sent) === 0);
      t('...the cursor moved by exactly one batch and the counts add up',
        one.r?.campaign?.cursor === 25 && one.r.campaign.sent_count === 25 && one.r.campaign.unconfirmed_count === 0
          && one.r.campaign.status === 'sending');
      const two = await run('campaign', { ...env, MI_PARALLEL: '1' }, '__SENT__');
      const everyone = [...(one.r?.sent ?? []), ...(two.r?.sent ?? [])];
      t('the next tick sends the rest and finishes', two.r?.sent?.length === 5 && two.r.campaign.status === 'sent'
        && two.r.campaign.sent_count === 30);
      t('...every subscriber got it exactly once', everyone.length === 30 && dupes(everyone) === 0);
    }

    if (driver.name === 'lowdb') {
      const dir = await freshDir('camp-stopped');
      const r = await run('campaign', { ...driver.env(dir), ...dirEnv(dir), MI_SEED: '1', MI_STOPPED: '1' }, '__SENT__');
      t('a process that is shutting down does not start a batch', r.r?.sent?.length === 0 && r.r.campaign.cursor === 0);

      // EMAIL_CAMPAIGNS=0: a mailbox licensed for one-to-one mail only. Leaving this to sendEmail's
      // own refusal of bulk mail would throw once per subscriber, count every
      // one as FAILED, and walk the cursor to the end of the list with nothing
      // delivered. The sweep has to stop before it claims the batch.
      const tx = await freshDir('camp-transactional');
      const q = await run('campaign', { ...driver.env(tx), ...dirEnv(tx), MI_SEED: '1', EMAIL_CAMPAIGNS: '0' }, '__SENT__');
      t('EMAIL_CAMPAIGNS=0 sends no campaign mail', q.r?.sent?.length === 0);
      t('...and claims nothing: cursor 0, nobody counted as failed, the campaign still waiting',
        q.r?.campaign?.cursor === 0 && (q.r.campaign.failed_count ?? 0) === 0 && q.r.campaign.status === 'sending');
    }

    // Two PROCESSES at once. The relational driver claims with one conditional
    // UPDATE, the doc-blob driver with a compare-and-set on the document. The
    // lowdb file is single-process by design; the scheduler lease is its guard.
    if (driver.name !== 'lowdb') {
      const dir = await freshDir(`camp2-${driver.name}`);
      const env = { ...driver.env(dir), ...dirEnv(dir) };
      await run('campaign', { ...env, MI_SEED: '1', MI_PARALLEL: '0' }, '__SENT__');
      const startAt = String(Date.now() + 2_500);
      const A = startChild('campaign', { ...env, MI_START_AT: startAt, MI_SEND_DELAY_MS: '20' });
      const B = startChild('campaign', { ...env, MI_START_AT: startAt, MI_SEND_DELAY_MS: '20' });
      await Promise.all([A.done, B.done]);
      const all = [...(A.last('__SENT__')?.sent ?? []), ...(B.last('__SENT__')?.sent ?? [])];
      t('THE FIX: two processes sending at once — nobody gets it twice', all.length > 0 && dupes(all) === 0);
      t('...and between them exactly one batch went out', all.length === 25);
    }

    // The compare-and-set itself, with the same meaning on every driver.
    {
      const dir = await freshDir(`cas-${driver.name}`);
      const c = await run('cas', { ...driver.env(dir), ...dirEnv(dir) }, '__CAS__');
      const r = c.r ?? {};
      t('cas: matches the value that was read', r.first === true);
      t('cas: refuses once the field has moved', r.stale === false);
      t('cas: the string "25" is not the number 25', r.stringVsNumber === false);
      t('cas: a missing field matches null', r.missingIsNull === true);
      t('cas: a present field does not match null', r.presentIsNotNull === false);
      t('cas: an unknown id is null', r.unknownId === null);
      t('cas: patched values keep their JSON types, and untouched fields survive',
        r.data?.cursor === 25 && r.data.flag === true && JSON.stringify(r.data.obj) === '{"a":[1,2]}'
          && r.data.cleared === null && r.data.label === 'y' && r.data.status === 'sending');
      t('cas: the change is in the content feed like any other update', r.feedHasUpdate === true);
    }
  }
}

/* --- 6. LocalDB.init() no longer rewrites the document --------------------- */
if (section('init')) {
  for (const driver of DRIVERS.filter((d) => d.name !== 'relational')) {
    const t = (n, c) => check(`[init:${driver.name}] ${n}`, c);
    const dir = await freshDir(`init-${driver.name}`);
    const r = (await run('initwrites', { ...driver.env(dir), ...dirEnv(dir) }, '__INIT__')).r;
    t('THE FIX: calling init() again on an up-to-date document writes nothing', !!r && r.before === r.after);
    t('...but a document missing a key is still repaired AND saved', !!r && r.b2 !== r.a2 && r.repaired === true);
  }
}

/* --- 7. a second process waits for the SQLite lock -------------------------- */
// The busy timeout itself is storage/local-sqlite.ts's (tests/sqlite-concurrency
// covers it); this checks it through LocalDB, beside the leases and claims above.
if (section('busy')) {
  for (const driver of DRIVERS.filter((d) => d.name !== 'lowdb')) {
    const t = (n, c) => check(`[busy:${driver.name}] ${n}`, c);
    const dir = await freshDir(`busy-${driver.name}`);
    const env = { ...driver.env(dir), ...dirEnv(dir) };
    await run('boot', env, '__BOOT__');
    const startAt = String(Date.now() + 2_000);
    const kids = [0, 1, 2].map(() => startChild('busy', { ...env, MI_START_AT: startAt }));
    await Promise.all(kids.map((k) => k.done));
    const results = kids.map((k) => k.last('__BUSY__'));
    const errors = results.reduce((n, r) => n + (r?.errors ?? 1), 0);
    t(`three processes writing one file at once see no SQLITE_BUSY (${errors} errors${results.find((r) => r?.lastErr)?.lastErr ? `: ${results.find((r) => r?.lastErr).lastErr}` : ''})`,
      results.every(Boolean) && errors === 0);
    t('...and every process got writes in', results.every((r) => (r?.ok ?? 0) > 0));
    if (driver.name === 'relational') {
      const count = await run('count', { ...env, MI_TYPE: 'mi_busy' }, '__COUNT__');
      t('...and every row each one wrote is there', count.r?.n === results.reduce((n, r) => n + (r?.ok ?? 0), 0));
    }
  }
}

/* --- 8. caches pick up another process's write ----------------------------- */
if (section('caches')) {
  const stub = path.join(cacheDir, `astrobaas-multi-stub-${process.pid}.ts`);
  await fs.writeFile(stub, `
export const __state = { settings: [], redirects: [], reads: 0 };
export const LocalDB = {
  async getSettings() { __state.reads++; return __state.settings; },
  // A real read takes time; without it the background refresh would finish
  // before the caller's own await and the test could not see the old map.
  async getRedirects() { __state.reads++; await new Promise((r) => setTimeout(r, 5)); return __state.redirects; },
  async saveRedirect() {}, async getNotFound() { return []; }, async putNotFound() {},
};
`);
  const withStub = async (rel, tag) => {
    const e = path.join(cacheDir, `astrobaas-multi-${tag}-entry-${process.pid}.ts`);
    const out = path.join(cacheDir, `astrobaas-multi-${tag}-${process.pid}.mjs`);
    await fs.writeFile(e, `export * from ${JSON.stringify(path.join(ROOT, rel))};\nexport { __state } from ${JSON.stringify(stub)};\n`);
    await build({
      entryPoints: [e], bundle: true, format: 'esm', platform: 'node', packages: 'external',
      outfile: out, logLevel: 'silent',
      plugins: [{ name: 'stub-localdb', setup(b) { b.onResolve({ filter: /(^|\/)localdb$/ }, () => ({ path: stub })); } }],
    });
    const mod = await import(pathToFileURL(out).href);
    await Promise.all([e, out].map((f) => fs.rm(f, { force: true })));
    return mod;
  };
  const realNow = Date.now;
  let skew = 0;
  Date.now = () => realNow() + skew;
  try {
    const MB = await withStub('src/lib/media-base.ts', 'media');
    const t = (n, c) => check(`[cache:media-base] ${n}`, c);
    MB.__state.settings = [{ key: 'public_site_url', value: 'https://one.example' }];
    t('the first read resolves from settings', (await MB.mediaBaseFor('http://localhost/x')) === 'https://one.example');
    // Another replica saves a new value. Nothing in THIS process invalidates.
    MB.__state.settings = [{ key: 'public_site_url', value: 'https://two.example' }];
    skew = 1_000;
    t('within the TTL the memo still answers (no read per request)',
      (await MB.mediaBaseFor('http://localhost/x')) === 'https://one.example');
    skew = MB.MEDIA_BASE_TTL_MS + 1;
    t('THE FIX: after the TTL another process\'s write is picked up', (await MB.mediaBaseFor('http://localhost/x')) === 'https://two.example');
    t('the TTL is a few seconds', MB.MEDIA_BASE_TTL_MS > 0 && MB.MEDIA_BASE_TTL_MS <= 10_000);
    MB.__state.settings = [{ key: 'public_site_url', value: 'https://three.example' }];
    MB.invalidateMediaBase();
    t('a local write still takes effect at once', (await MB.mediaBaseFor('http://localhost/x')) === 'https://three.example');
    skew = 0;

    const RS = await withStub('src/lib/legacy/redirect-store.ts', 'redirects');
    const tr = (n, c) => check(`[cache:redirects] ${n}`, c);
    const rule = (match, target) => ({ id: match, match, target, status: 301, enabled: true, hits: 0, created_at: '', updated_at: '' });
    RS.__state.redirects = [rule('/old-a', '/new-a')];
    await RS.ensureRedirectsLoaded();
    tr('the map loads', RS.matchRedirect('/old-a')?.location === '/new-a');
    RS.__state.redirects = [rule('/old-b', '/new-b')];
    await RS.ensureRedirectsLoaded();
    tr('within the TTL the loaded map is served', RS.matchRedirect('/old-a')?.location === '/new-a' && RS.matchRedirect('/old-b') === null);
    skew = RS.REDIRECTS_TTL_MS + 1;
    const readsBefore = RS.__state.reads;
    await RS.ensureRedirectsLoaded();
    tr('the request that notices is still served from the map it has', RS.matchRedirect('/old-a')?.location === '/new-a');
    await sleep(20);
    tr('THE FIX: after the TTL another process\'s change is live', RS.matchRedirect('/old-b')?.location === '/new-b'
      && RS.matchRedirect('/old-a') === null && RS.__state.reads === readsBefore + 1);
    await RS.ensureRedirectsLoaded();
    await RS.ensureRedirectsLoaded();
    tr('...and it is not re-read on every request after that', RS.__state.reads === readsBefore + 1);
    skew = 0;
  } finally {
    Date.now = realNow;
    await fs.rm(stub, { force: true });
  }

  {
    const t = (n, c) => check(`[cache:theme] ${n}`, c);
    const code = await fs.readFile(path.join(ROOT, 'src/lib/theme-runtime.ts'), 'utf8');
    const ttl = Number((code.match(/THEME_CACHE_TTL_MS\s*=\s*([\d_]+)/)?.[1] ?? 'NaN').replace(/_/g, ''));
    t('the theme cache has a TTL of a few seconds', ttl > 0 && ttl <= 10_000);
    t('...and the cached value is only served while younger than it',
      /now\s*-\s*themeCache\.at\s*<\s*THEME_CACHE_TTL_MS/.test(code));
  }

  {
    const R = await loadTs('src/lib/plugin-platform/registry-recheck.ts');
    const t = (n, c) => check(`[cache:plugins] ${n}`, c);
    const recs = [{ id: 'b', active: false }, { id: 'a', active: true, settings: { color: 'red' } }];
    const fp = R.pluginRegistryFingerprint(recs, { comments_enabled: false, site_title: 'x' });
    t('the fingerprint ignores record order and unrelated settings',
      fp === R.pluginRegistryFingerprint([...recs].reverse(), { comments_enabled: false, site_title: 'y' }));
    t('...and plugin config',
      fp === R.pluginRegistryFingerprint([{ id: 'b', active: false }, { id: 'a', active: true, settings: { color: 'blue' } }], { comments_enabled: false }));
    t('it changes when a plugin is toggled',
      fp !== R.pluginRegistryFingerprint([{ id: 'b', active: true }, { id: 'a', active: true }], { comments_enabled: false }));
    t('...when a manifest changes',
      fp !== R.pluginRegistryFingerprint([{ id: 'b', active: false, settings: { manifest: { v: 2 } } }, { id: 'a', active: true }], { comments_enabled: false }));
    t('...and when a registry setting changes', fp !== R.pluginRegistryFingerprint(recs, { comments_enabled: true })
      && fp !== R.pluginRegistryFingerprint(recs, { comments_enabled: false, custom_content_types: [{ name: 'x' }] }));

    let now = 0;
    let stored = 'v1';
    let reloads = 0;
    let reads = 0;
    const rc = new R.RegistryRecheck({
      read: async () => { reads++; return stored; },
      reload: async () => { reloads++; rc.markBuilt(stored); },
      intervalMs: 15_000,
      now: () => now,
    });
    rc.poke();
    await rc.settled();
    t('nothing is checked before a registry has been built', reads === 0);
    rc.markBuilt('v1');
    now = 1_000;
    rc.poke();
    await rc.settled();
    t('not re-checked inside the interval', reads === 0);
    now = 15_000;
    rc.poke();
    await rc.settled();
    t('re-checked once the interval has passed, and unchanged means no reload', reads === 1 && reloads === 0);
    stored = 'v2';
    now = 20_000;
    rc.poke();
    await rc.settled();
    t('a change inside the interval waits for it', reads === 1 && reloads === 0);
    now = 30_000;
    rc.poke();
    rc.poke();
    await rc.settled();
    t('THE FIX: another process\'s change triggers exactly one rebuild', reads === 2 && reloads === 1);
    now = 46_000;
    rc.poke();
    await rc.settled();
    t('...after which the new state is the baseline', reads === 3 && reloads === 1);
    stored = 'v3';
    rc.markBuilt('v3'); // a LOCAL reload got there first
    now = 62_000;
    rc.poke();
    await rc.settled();
    t('a local rebuild is not repeated', reloads === 1);
    const failing = new R.RegistryRecheck({ read: async () => { throw new Error('db down'); }, reload: async () => {}, now: () => now });
    failing.markBuilt('x');
    now = 100_000;
    let threw = false;
    try { failing.poke(); await failing.settled(); } catch { threw = true; }
    t('a failed re-check never throws into the request', !threw);
    const pluginsIndex = await fs.readFile(path.join(ROOT, 'src/plugins/index.ts'), 'utf8');
    t('the bootstrap records the fingerprint and every request pokes the re-check',
      /registryRecheck\.markBuilt\(/.test(pluginsIndex) && /registryRecheck\.poke\(\)/.test(pluginsIndex));
  }
}

await fs.rm(bundle, { force: true });
await fs.rm(tmpRoot, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
