#!/usr/bin/env node
/**
 * Graceful shutdown (src/lib/shutdown.ts), exercised with a real signal.
 *
 * ## What it was
 *
 * Nothing listened for SIGTERM. Every `systemctl restart` and every deploy
 * killed the process wherever it stood: a checkout half-written, a minute of
 * buffered article views that existed only in memory, the scheduler mid-sweep.
 *
 * ## How this proves the fix
 *
 * A child process loads the REAL modules on a REAL database, starts the real
 * scheduler, opens a fake request (the same counter the middleware uses),
 * buffers some views — and then sends ITSELF a SIGTERM. The parent reads what
 * the child saw while it was draining and what reached the database after it
 * exited:
 *
 *  - /readyz answered 503 while the request was still open;
 *  - the process had NOT exited while the request was open;
 *  - the scheduler was already stopped;
 *  - the exit was status 0, after the request finished;
 *  - the buffered views are in the database, read back by a fresh process.
 *
 * Once per driver, because the last step is a write. Plus: the timeout bounds
 * the wait, a second signal exits at once, GRACEFUL_SHUTDOWN=0 opts out, and
 * loading the module registers nothing.
 *
 * Run with:  node tests/shutdown.test.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { loadTs, ROOT } from './lib/load.mjs';

const MODE = process.env.SHUTDOWN_TEST_CHILD;

/* ================================================================ child === */
if (MODE) {
  const out = (tag, obj) => console.log(`${tag}${JSON.stringify(obj)}`);

  // ONE bundle for everything, so the middleware's counter, the drain and the
  // readiness route share a single copy of observability.ts. Separate loadTs
  // calls would each get their own, and the test would watch the wrong one.
  const cacheDir = path.join(ROOT, 'node_modules', '.cache');
  await fs.mkdir(cacheDir, { recursive: true });
  const entry = path.join(cacheDir, `astrobaas-shutdown-entry-${process.pid}.ts`);
  const outfile = path.join(cacheDir, `astrobaas-shutdown-${process.pid}.mjs`);
  const src = (rel) => JSON.stringify(path.join(ROOT, rel));
  await fs.writeFile(entry, [
    `export * as shutdown from ${src('src/lib/shutdown.ts')};`,
    `export * as obs from ${src('src/lib/observability.ts')};`,
    `export * as views from ${src('src/lib/views.ts')};`,
    `export * as scheduler from ${src('src/lib/scheduler.ts')};`,
    `export * as readyz from ${src('src/pages/readyz.ts')};`,
    `export { LocalDB } from ${src('src/lib/localdb.ts')};`,
  ].join('\n'));
  await build({
    entryPoints: [entry], bundle: true, format: 'esm', platform: 'node',
    packages: 'external', outfile, logLevel: 'silent',
  });
  const M = await import(pathToFileURL(outfile).href);
  await fs.rm(entry, { force: true });
  await fs.rm(outfile, { force: true });
  const { shutdown, obs, views, scheduler, readyz, LocalDB } = M;

  if (MODE === 'read') {
    await LocalDB.init();
    const p = await LocalDB.getPost(process.env.SHUTDOWN_POST_ID);
    out('__READ__', { views: p?.views ?? null });
    process.exit(0);
  }

  if (MODE === 'disabled') {
    const before = process.listenerCount('SIGTERM');
    const installed = shutdown.installGracefulShutdown();
    out('__RESULT__', { installed, added: process.listenerCount('SIGTERM') - before });
    shutdown.trackRequest(); // a request in flight must not matter: nothing is listening
    process.kill(process.pid, 'SIGTERM');
    setTimeout(() => { out('__SURVIVED__', {}); process.exit(0); }, 3000);
    await new Promise(() => {});
  }

  await LocalDB.init();
  const admin = (await LocalDB.getUsers?.())?.find?.((u) => u.role === 'admin');
  const post = await LocalDB.createPost({
    title: 'Drained', slug: `drained-${process.pid}`, content: '<p>x</p>',
    status: 'published', author_id: admin?.id ?? 'admin', tags: [], views: 0,
  });

  let firstSignalAt = 0;
  const exit = (code) => {
    out('__EXIT__', {
      code,
      sinceSignalMs: firstSignalAt ? Date.now() - firstSignalAt : null,
      inflight: obs.inflightRequests(),
      pendingViews: views.pendingViewCount(),
    });
    process.exit(code);
  };

  const before = process.listenerCount('SIGTERM');
  const first = shutdown.installGracefulShutdown({ exit });
  const second = shutdown.installGracefulShutdown({ exit });
  const added = process.listenerCount('SIGTERM') - before;
  const addedInt = process.listenerCount('SIGINT');

  if (MODE === 'drain') {
    // The real scheduler, on a long interval. Wait for its immediate first
    // sweep to finish so it is not still writing when the test starts.
    scheduler.startScheduler({ SCHEDULER_INTERVAL_MS: '60000' });
    for (let i = 0; i < 100 && !scheduler.schedulerStatus().lastRunAt; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  // A real server's listening socket keeps its event loop alive; this stands
  // in for it. Without it a child whose request never finishes simply runs
  // out of work before the signal is even delivered.
  setInterval(() => {}, 1000);

  const finish = shutdown.trackRequest(); // the fake in-flight request
  for (let i = 0; i < 3; i++) views.recordView(post.id);
  out('__START__', { postId: post.id, first, second, added, addedInt, inflight: obs.inflightRequests() });

  process.on('SIGTERM', () => { if (!firstSignalAt) firstSignalAt = Date.now(); });
  process.kill(process.pid, 'SIGTERM');

  if (MODE === 'drain') {
    setTimeout(async () => {
      const r = await readyz.GET({});
      const body = await r.json();
      out('__MID__', {
        draining: obs.isDraining(),
        readyStatus: r.status,
        readyBody: body,
        inflight: obs.inflightRequests(),
        // false = the drain already stopped it. If the drain had not, this
        // call would stop it now and return true.
        schedulerStillRunning: scheduler.stopScheduler(),
      });
      finish();
      finish(); // idempotent: a second call must not decrement someone else's request
      out('__FINISHED__', { inflight: obs.inflightRequests() });
    }, 400);
  }
  if (MODE === 'double') {
    setTimeout(() => process.kill(process.pid, 'SIGTERM'), 300);
  }
  // 'timeout': the request never finishes.
  await new Promise(() => {});
}

/* =============================================================== parent === */
let pass = 0;
let fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };

const self = fileURLToPath(import.meta.url);
const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'astrobaas-shutdown-'));

function runChild(mode, dir, extraEnv = {}) {
  // Every scenario finishes in a few seconds; the timeout turns a drain that
  // never ends into a failed check instead of a hung suite.
  const res = spawnSync(process.execPath, [self], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 30_000, killSignal: 'SIGKILL',
    env: {
      ...process.env,
      SHUTDOWN_TEST_CHILD: mode,
      NODE_ENV: 'test',
      UPLOADS_DIR: path.join(dir, 'uploads'),
      PRIVATE_UPLOADS_DIR: path.join(dir, 'private'),
      ...extraEnv,
    },
  });
  const lines = (res.stdout || '').split('\n');
  const grab = (tag) => {
    const l = lines.find((x) => x.startsWith(tag));
    return l ? JSON.parse(l.slice(tag.length)) : null;
  };
  const index = (tag) => lines.findIndex((x) => x.startsWith(tag));
  const logs = lines.filter((l) => l.startsWith('{')).map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((j) => j && j.type === 'shutdown');
  return { res, grab, index, logs, stderr: res.stderr || '' };
}

const DRIVERS = [
  { name: 'lowdb', env: (d) => ({ DB_PATH: path.join(d, 'db.json') }) },
  { name: 'libsql', env: (d) => ({ DATABASE_URL: `file:${path.join(d, 'db.sqlite')}` }) },
  { name: 'relational', env: (d) => ({ DATABASE_URL: `file:${path.join(d, 'db.sqlite')}`, DATABASE_DRIVER: 'relational' }) },
];

/* --- 1. the drain, per driver --------------------------------------------- */
for (const driver of DRIVERS) {
  const dir = path.join(tmpRoot, driver.name);
  await fs.mkdir(path.join(dir, 'uploads'), { recursive: true });
  const env = { ...driver.env(dir), SHUTDOWN_TIMEOUT_MS: '10000' };
  const t = (n, c) => check(`[${driver.name}] ${n}`, c);
  const run = runChild('drain', dir, env);
  const start = run.grab('__START__');
  const mid = run.grab('__MID__');
  const exited = run.grab('__EXIT__');
  const drained = run.logs.find((l) => l.msg === 'drained' || /timed out/.test(l.msg ?? ''));
  if (!start || !mid || !exited) {
    fail++;
    console.error(`✗ [${driver.name}] child did not report\n${run.res.stdout?.slice(-1500)}\n${run.stderr.slice(-1500)}`);
    continue;
  }

  t('the handlers are registered exactly once, however often install is called',
    start.first === true && start.second === false && start.added === 1 && start.addedInt >= 1);
  t('the fake request is counted as in flight', start.inflight === 1);

  t('while it drains, the process says so', mid.draining === true);
  t('...and /readyz answers 503, so a balancer stops routing here',
    mid.readyStatus === 503 && mid.readyBody?.ready === false && mid.readyBody?.draining === true);
  t('...and the open request is still counted (the drain is WAITING, not done)', mid.inflight === 1);
  t('...and the scheduler has already been stopped', mid.schedulerStillRunning === false);
  t('it did not exit while the request was open',
    run.index('__MID__') !== -1 && run.index('__EXIT__') > run.index('__FINISHED__'));
  t('the finishing call is idempotent: the count reaches 0, not -1',
    run.grab('__FINISHED__')?.inflight === 0);

  t('it exits 0 once the request is done', run.res.status === 0 && exited.code === 0);
  t('...having waited for it (~400 ms), not for the whole 10 s budget',
    exited.sinceSignalMs >= 350 && exited.sinceSignalMs < 5000);
  t('...with nothing in flight and no views left in memory', exited.inflight === 0 && exited.pendingViews === 0);
  t('the shutdown log line says what happened',
    !!drained && drained.msg === 'drained' && drained.abandoned_requests === 0
      && drained.scheduler_stopped === true && drained.views_written >= 1 && drained.views_lost === 0);

  const read = runChild('read', dir, { ...driver.env(dir), SHUTDOWN_POST_ID: start.postId }).grab('__READ__');
  t('the buffered views reached the database before the exit (read back by a new process)',
    read?.views === 3);
}

/* --- 2. the timeout bounds the wait ---------------------------------------- */
{
  const dir = path.join(tmpRoot, 'timeout');
  await fs.mkdir(path.join(dir, 'uploads'), { recursive: true });
  const run = runChild('timeout', dir, { DB_PATH: path.join(dir, 'db.json'), SHUTDOWN_TIMEOUT_MS: '1000' });
  const exited = run.grab('__EXIT__');
  const line = run.logs.find((l) => /timed out/.test(l.msg ?? ''));
  check('timeout: a request that never finishes does not hold the process forever',
    run.res.status === 0 && exited?.code === 0);
  check('timeout: ...it waits about the budget less the flush reserve, then goes',
    exited?.sinceSignalMs >= 700 && exited?.sinceSignalMs < 4000);
  check('timeout: ...and says a request was abandoned',
    !!line && line.abandoned_requests === 1 && line.level === 'warn');
  check('timeout: ...and still writes the buffered views', !!line && line.views_written >= 1 && exited?.pendingViews === 0);
}

/* --- 3. a second signal means now ------------------------------------------ */
{
  const dir = path.join(tmpRoot, 'double');
  await fs.mkdir(path.join(dir, 'uploads'), { recursive: true });
  const run = runChild('double', dir, { DB_PATH: path.join(dir, 'db.json'), SHUTDOWN_TIMEOUT_MS: '20000' });
  const exited = run.grab('__EXIT__');
  check('double signal: the second SIGTERM exits at once, with 143',
    run.res.status === 143 && exited?.code === 143);
  check('double signal: ...without waiting out the 20 s budget', exited?.sinceSignalMs < 3000);
  check('double signal: ...and logs why',
    run.logs.some((l) => /second signal/.test(l.msg ?? '')));
}

/* --- 4. the opt-out ---------------------------------------------------------- */
{
  const dir = path.join(tmpRoot, 'disabled');
  await fs.mkdir(path.join(dir, 'uploads'), { recursive: true });
  const run = runChild('disabled', dir, { DB_PATH: path.join(dir, 'db.json'), GRACEFUL_SHUTDOWN: '0' });
  const r = run.grab('__RESULT__');
  check('GRACEFUL_SHUTDOWN=0 registers nothing', r?.installed === false && r?.added === 0);
  check('...so SIGTERM kills the process the default way', run.res.signal === 'SIGTERM' && !run.grab('__SURVIVED__'));
}

/* --- 5. the drain sequence on its own, with a fake clock ------------------- */
const S = await loadTs('src/lib/shutdown.ts');
{
  // Loading the module must not take over the test runner's signals.
  check('importing the module registers no handlers',
    process.listenerCount('SIGTERM') === 0 && process.listenerCount('SIGINT') === 0);

  check('timeout default is 25 s', S.shutdownTimeoutMs({}) === 25_000);
  check('timeout honours the env', S.shutdownTimeoutMs({ SHUTDOWN_TIMEOUT_MS: '8000' }) === 8000);
  check('a typo falls back to the default rather than 0 or forever',
    S.shutdownTimeoutMs({ SHUTDOWN_TIMEOUT_MS: 'abc' }) === 25_000
      && S.shutdownTimeoutMs({ SHUTDOWN_TIMEOUT_MS: '-5' }) === 25_000);
  check('an absurd timeout is clamped to 10 minutes', S.shutdownTimeoutMs({ SHUTDOWN_TIMEOUT_MS: '99999999' }) === 600_000);
  check('0 is allowed (do not wait at all)', S.shutdownTimeoutMs({ SHUTDOWN_TIMEOUT_MS: '0' }) === 0);
  check('enabled unless GRACEFUL_SHUTDOWN=0/false',
    S.gracefulShutdownEnabled({}) && !S.gracefulShutdownEnabled({ GRACEFUL_SHUTDOWN: '0' })
      && !S.gracefulShutdownEnabled({ GRACEFUL_SHUTDOWN: 'false' }) && S.gracefulShutdownEnabled({ GRACEFUL_SHUTDOWN: '1' }));

  // RUNAWAY: a drain whose wait is not bounded would loop forever on a request
  // that never ends. The fake request gives up at a fake hour instead, so such
  // a drain FAILS the waited_ms checks below rather than hanging the suite.
  const RUNAWAY = 3_600_000;
  const fake = (inflightUntil, { flush } = {}) => {
    let now = 0;
    let inflight = 1;
    const calls = [];
    return {
      calls,
      deps: {
        markDraining: () => calls.push('draining'),
        stopScheduler: () => { calls.push('scheduler'); return true; },
        inflight: () => { if (now >= inflightUntil || now >= RUNAWAY) inflight = 0; return inflight; },
        flushViews: () => { calls.push(`flush@${now}:${inflight}`); return flush ? flush() : Promise.resolve(4); },
        pendingViews: () => 0,
        now: () => now,
        sleep: async (ms) => { now += ms; },
      },
    };
  };

  const a = fake(300);
  const ra = await S.drain('SIGTERM', 10_000, a.deps);
  check('order: draining is announced first, then the scheduler stops, then the flush',
    a.calls[0] === 'draining' && a.calls[1] === 'scheduler' && a.calls[2]?.startsWith('flush@'));
  check('the flush runs only AFTER the last request finished', a.calls[2] === 'flush@300:0');
  check('the report says so', ra.abandoned_requests === 0 && ra.waited_ms === 300 && ra.views_written === 4
    && ra.scheduler_stopped === true && ra.signal === 'SIGTERM');

  const b = fake(Infinity);
  const rb = await S.drain('SIGINT', 10_000, b.deps);
  check('a request that never ends: the wait stops at the budget less the 2 s flush reserve',
    rb.waited_ms === 8_000 && rb.abandoned_requests === 1);
  check('...and the flush still runs', b.calls.some((c) => c.startsWith('flush@8000')));

  const c = fake(Infinity);
  const rc = await S.drain('SIGTERM', 60_000, c.deps);
  check('the flush reserve is capped at 5 s', rc.waited_ms === 55_000);

  // A flush that never settles must not hang the exit. Real timers here: the
  // bound is a setTimeout of max(1 s, what is left of the budget).
  const d = fake(0, { flush: () => new Promise(() => {}) });
  const t0 = Date.now();
  // Raced against a watchdog, so an unbounded flush FAILS here rather than
  // leaving the test with nothing to wait on.
  let watchdog;
  const rd = await Promise.race([
    S.drain('SIGTERM', 0, d.deps),
    new Promise((r) => { watchdog = setTimeout(() => r('hung'), 5000); }),
  ]);
  clearTimeout(watchdog);
  const took = Date.now() - t0;
  check('a flush that hangs is abandoned after its bound, reporting 0 written',
    rd !== 'hung' && rd.views_written === 0 && took >= 900 && took < 3000);

  // The request counter handed to the middleware.
  const O = await loadTs('src/lib/observability.ts');
  O.requestFinished();
  check('an unpaired finish cannot drive the count negative', O.inflightRequests() === 0);
}

/* --- 6. the last flush waits for one already running ----------------------- */
{
  // flushViews() returns 0 at once when another flush is running — right for
  // the scheduler (it retries next tick), wrong on the way out (there is no
  // next tick). If the scheduler's flush is mid-write when SIGTERM lands, the
  // exit flush must wait for it and then write what arrived meanwhile.
  const cacheDir = path.join(ROOT, 'node_modules', '.cache');
  const stub = path.join(cacheDir, `astrobaas-shutdown-views-stub-${process.pid}.ts`);
  const entry = path.join(cacheDir, `astrobaas-shutdown-views-entry-${process.pid}.ts`);
  const out = path.join(cacheDir, `astrobaas-shutdown-views-${process.pid}.mjs`);
  await fs.writeFile(stub, `
export const __state = { store: new Map(), gate: null };
export const LocalDB = {
  async bumpPostViews(deltas) {
    if (__state.gate) await __state.gate;
    for (const [id, d] of deltas) __state.store.set(id, (__state.store.get(id) ?? 0) + d);
    return deltas.size;
  },
};
`);
  await fs.writeFile(entry, `export * from ${JSON.stringify(path.join(ROOT, 'src/lib/views.ts'))};\nexport { __state } from ${JSON.stringify(stub)};\n`);
  await build({
    entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', packages: 'external',
    outfile: out, logLevel: 'silent',
    plugins: [{ name: 'stub-localdb', setup(b) { b.onResolve({ filter: /(^|\/)localdb$/ }, () => ({ path: stub })); } }],
  });
  const V = await import(pathToFileURL(out).href);
  await Promise.all([out, entry, stub].map((f) => fs.rm(f, { force: true })));

  let release;
  V.__state.gate = new Promise((r) => { release = r; });
  V.recordView('p'); V.recordView('p');
  const running = V.flushViews();              // the scheduler's flush, now stuck mid-write
  V.recordView('p'); V.recordView('p'); V.recordView('p');
  check('views: a plain flush during another returns 0 (the reason the exit flush needs its own)',
    (await V.flushViews()) === 0);
  const last = V.flushViewsBeforeExit();
  setTimeout(() => release(), 30);
  await Promise.all([running, last]);
  check('views: the exit flush waited for the running one AND wrote what arrived meanwhile',
    V.__state.store.get('p') === 5 && V.pendingViewCount() === 0);
}

await fs.rm(tmpRoot, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
