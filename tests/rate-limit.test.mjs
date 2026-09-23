#!/usr/bin/env node
/**
 * Unit tests for the pluggable rate-limit store (src/lib/rate-limit.ts): the
 * in-process memory limiter and the shared libSQL-backed limiter (against a
 * throwaway SQLite file). Bundled in-process by the shared loader.
 *
 * Run with:  node tests/rate-limit.test.mjs
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTs } from './lib/load.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

// The shared loader BUNDLES. This file used to transpile rate-limit.ts alone
// with esbuild's `transform`, which leaves relative imports untouched — so the
// day rate-limit.ts imported a sibling (the shared SQLite opener in
// storage/local-sqlite.ts), the compiled copy in node_modules/.cache looked for
// it next to itself and every assertion below failed to run.
const RL = await loadTs('src/lib/rate-limit.ts');
const { MemoryRateLimitStore, LibsqlRateLimitStore, selectRateLimitStore, describeRateLimitStore } = RL;

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) pass++;
  else {
    fail++;
    console.error(`✗ ${name}`);
  }
}

// ---- memory store ----
{
  const s = new MemoryRateLimitStore();
  const r = [];
  for (let i = 0; i < 4; i++) r.push(await s.hit('ip1', 60_000, 3));
  check('memory: allows up to the limit then blocks', JSON.stringify(r) === JSON.stringify([true, true, true, false]));
  check('memory: a different key has its own bucket', (await s.hit('ip2', 60_000, 3)) === true);
  // A tiny window resets quickly.
  const a = await s.hit('ipw', 5, 1);
  await new Promise((res) => setTimeout(res, 12));
  const b = await s.hit('ipw', 5, 1);
  check('memory: window resets after windowMs', a === true && b === true);
}

// ---- libSQL store ----
{
  const dbFile = path.join(os.tmpdir(), `astrobaas-rl-${process.pid}.db`);
  await fs.rm(dbFile, { force: true });
  const s = new LibsqlRateLimitStore(`file:${dbFile}`);
  const r = [];
  for (let i = 0; i < 4; i++) r.push(await s.hit('ipA', 60_000, 3));
  check('libsql: allows up to the limit then blocks', JSON.stringify(r) === JSON.stringify([true, true, true, false]));
  check('libsql: a different key has its own counter', (await s.hit('ipB', 60_000, 3)) === true);
  await fs.rm(dbFile, { force: true });
  await fs.rm(`${dbFile}-shm`, { force: true });
  await fs.rm(`${dbFile}-wal`, { force: true });
}

// ---- libSQL store: MULTI-NODE correctness (the whole point) ----
// Two independent store instances on the SAME database file simulate two
// replicas behind a load balancer. A shared counter means the limit holds no
// matter which "replica" receives each request — the property the memory store
// cannot provide.
{
  const dbFile = path.join(os.tmpdir(), `astrobaas-rl-shared-${process.pid}.db`);
  await fs.rm(dbFile, { force: true });
  const replicaA = new LibsqlRateLimitStore(`file:${dbFile}`);
  const replicaB = new LibsqlRateLimitStore(`file:${dbFile}`);

  // Limit 3, alternating replicas: hits 1,2,3 pass; the 4th (on either) blocks.
  const seq = [
    await replicaA.hit('shared-ip', 60_000, 3), // 1
    await replicaB.hit('shared-ip', 60_000, 3), // 2
    await replicaA.hit('shared-ip', 60_000, 3), // 3
    await replicaB.hit('shared-ip', 60_000, 3), // 4 → over
  ];
  check('libsql: counter is SHARED across two instances (multi-node)', JSON.stringify(seq) === JSON.stringify([true, true, true, false]));
  // And a 5th on the first replica is still blocked (state persisted, not per-instance).
  check('libsql: shared block persists on the other instance', (await replicaA.hit('shared-ip', 60_000, 3)) === false);

  await fs.rm(dbFile, { force: true });
  await fs.rm(`${dbFile}-shm`, { force: true });
  await fs.rm(`${dbFile}-wal`, { force: true });
}

// ---- selector ----
{
  check('selector defaults to memory', selectRateLimitStore({}).constructor.name === 'MemoryRateLimitStore');
  check('selector: libsql needs both the mode and a URL', selectRateLimitStore({ RATE_LIMIT_STORE: 'libsql' }).constructor.name === 'MemoryRateLimitStore');
  check('selector picks libsql when configured', selectRateLimitStore({ RATE_LIMIT_STORE: 'libsql', DATABASE_URL: 'file:/tmp/x.db' }).constructor.name === 'LibsqlRateLimitStore');
  check('selector accepts the "shared" alias', selectRateLimitStore({ RATE_LIMIT_STORE: 'shared', DATABASE_URL: 'file:/tmp/x.db' }).constructor.name === 'LibsqlRateLimitStore');
}

// ---- describeRateLimitStore (startup diagnostic + foot-gun warning) ----
{
  const mem = describeRateLimitStore({});
  check('describe: bare env → per-process memory, no warning', mem.kind === 'memory' && mem.shared === false && !mem.warning);

  const shared = describeRateLimitStore({ RATE_LIMIT_STORE: 'libsql', DATABASE_URL: 'file:/tmp/x.db' });
  check('describe: configured → shared libsql', shared.kind === 'libsql' && shared.shared === true && !shared.warning);

  const footgun = describeRateLimitStore({ DATABASE_URL: 'file:/tmp/x.db' });
  check('describe: DB set but store unset → memory WITH under-count warning', footgun.kind === 'memory' && footgun.shared === false && typeof footgun.warning === 'string' && /UNDER-COUNT/.test(footgun.warning));
}

/* ================================================================== *
 * The budget a request is actually given
 *
 * Reported from production: a shop manager adding products kept being
 * throttled. Two causes in one line of code — every staff request was counted
 * against the ANONYMOUS 60/min ceiling, and it was keyed on the IP, so an
 * office behind one NAT address shared a single bucket between colleagues.
 * ================================================================== */
{
  const { MemoryRateLimitStore, toResult } = RL;

  /* ---- consume() reports a budget, not just a verdict ---- */
  {
    const store = new MemoryRateLimitStore();
    const first = store.consume('user:alice', 60_000, 3);
    check('consume allows the first request', first.allowed);
    check('and reports the ceiling that applied', first.limit === 3);
    check('and what is left', first.remaining === 2);
    check('and when the window rolls over', first.resetAt > Date.now());
    // A Retry-After of 0 invites every throttled client to retry at once.
    check('Retry-After is at least one second', first.retryAfterSeconds >= 1);

    store.consume('user:alice', 60_000, 3);
    const third = store.consume('user:alice', 60_000, 3);
    check('the last request in budget is allowed', third.allowed && third.remaining === 0);
    const fourth = store.consume('user:alice', 60_000, 3);
    check('the next one is refused', !fourth.allowed);
    check('and remaining never goes negative', fourth.remaining === 0);
  }

  /* ---- THE production bug: colleagues sharing one bucket ---- */
  {
    const store = new MemoryRateLimitStore();
    // Two people, one office, one NAT address. Keyed per user, they are
    // independent; keyed per IP they were not, and one person's bulk data
    // entry throttled everyone around them.
    for (let i = 0; i < 5; i += 1) store.consume('user:alice', 60_000, 5);
    const bob = store.consume('user:bob', 60_000, 5);
    check('two users behind one IP do NOT share a bucket', bob.allowed);
    check('and Bob has his full budget', bob.remaining === 4);
    const alice = store.consume('user:alice', 60_000, 5);
    check("while Alice's own budget is spent", !alice.allowed);
  }

  /* ---- a staff principal is not held to the anonymous ceiling ---- */
  {
    const store = new MemoryRateLimitStore();
    const ANON = 60;
    const STAFF = 1800;
    // Ordinary work — a save, a category fetch, a media page, a POST per photo
    // — passes 60 in a couple of minutes. It must not pass a staff ceiling.
    for (let i = 0; i < ANON; i += 1) store.consume('user:manager', 60_000, STAFF);
    const past = store.consume('user:manager', 60_000, STAFF);
    check('a staff principal past the ANONYMOUS ceiling is still allowed', past.allowed);
    check('and is measured against the staff limit', past.limit === STAFF);

    // THE DEFAULTS THEMSELVES, read from the middleware rather than retyped.
    //
    // The constants above are a local copy of two numbers, so on their own they
    // prove the STORE works and say nothing about what the product ships. The
    // default was raised from 600 to 1800 and not one test noticed — the same
    // shape as a setting nothing reads. Comments are stripped first: this file
    // explains both numbers in prose directly above the code, so an unstripped
    // search would match the explanation instead of the value.
    const mw = (await fs.readFile(path.join(here, '..', 'src/middleware.ts'), 'utf8'))
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    check('the shipped STAFF default is the generous one',
      /STAFF_RATE_LIMIT_PER_MIN\)\s*\n?\s*:\s*1800;/.test(mw)
      || /:\s*1800;/.test(mw.slice(mw.indexOf('STAFF_RATE_LIMIT'))));
    check('...and the ANONYMOUS ceiling was NOT raised with it',
      /:\s*60;/.test(mw.slice(mw.indexOf('const RATE_LIMIT'))));
    check('the comment stripper actually stripped',
      mw.length < 1000 || !/runaway-script backstop/.test(mw));

    // Anonymous traffic keeps the conservative default.
    const anon = new MemoryRateLimitStore();
    for (let i = 0; i < ANON; i += 1) anon.consume('api:1.2.3.4', 60_000, ANON);
    check('anonymous traffic is still capped at its own ceiling',
      !anon.consume('api:1.2.3.4', 60_000, ANON).allowed);
  }

  /* ---- namespaces cannot collide ---- */
  {
    const store = new MemoryRateLimitStore();
    for (let i = 0; i < 3; i += 1) store.consume('api:1.2.3.4', 60_000, 3);
    check('an IP bucket does not spend a user bucket', store.consume('user:1.2.3.4', 60_000, 3).allowed);
    check('nor an api-key bucket', store.consume('apikey:1.2.3.4', 60_000, 3).allowed);
    // Login throttling shares the store and must be untouched by any of this.
    check('nor the login bucket', store.consume('login:1.2.3.4|a@b.c', 900_000, 10).allowed);
  }

  /* ---- the credential throttles are NOT relaxed ---- */
  {
    const store = new MemoryRateLimitStore();
    const LOGIN_LIMIT = 10;
    let allowed = 0;
    for (let i = 0; i < 12; i += 1) {
      if (store.consume('login:1.2.3.4|a@b.c', 15 * 60_000, LOGIN_LIMIT).allowed) allowed += 1;
    }
    // These protect credentials, not convenience. A generous staff ceiling must
    // never leak into them.
    check('login still stops at exactly 10 attempts', allowed === LOGIN_LIMIT);
    let forgot = 0;
    for (let i = 0; i < 8; i += 1) {
      if (store.consume('forgot:1.2.3.4|a@b.c', 15 * 60_000, 5).allowed) forgot += 1;
    }
    check('forgot-password still stops at 5', forgot === 5);
  }

  /* ---- hit() still means what it always meant ---- */
  {
    const store = new MemoryRateLimitStore();
    check('hit() returns a boolean', store.hit('legacy', 60_000, 1) === true);
    check('and refuses past the limit', store.hit('legacy', 60_000, 1) === false);
  }

  /* ---- the shaping helper ---- */
  {
    const now = 1_000_000;
    const r = toResult(3, 10, now + 5_500, now);
    check('remaining is limit minus count', r.remaining === 7);
    check('retryAfter rounds UP to whole seconds', r.retryAfterSeconds === 6);
    check('over-limit is not allowed', !toResult(11, 10, now + 1000, now).allowed);
    check('and reports zero remaining', toResult(11, 10, now + 1000, now).remaining === 0);
  }

  /* ---- consumeOnce: single-use that a token replay cannot beat ---- *
   *
   * This is what a magic link and a solved captcha rely on. The bug it fixes
   * was libSQL-specific — a floored-window marker vanished at a wall-clock
   * boundary while the token stayed valid — so the libSQL store is tested too,
   * on an in-memory database, proving the marker is keyed to an ABSOLUTE
   * expiry and survives inside its TTL. */
  {
    const mem = new MemoryRateLimitStore();
    check('memory: first claim wins', mem.consumeOnce('jti-1', 60_000) === true);
    check('memory: the replay is refused', mem.consumeOnce('jti-1', 60_000) === false);
    check('memory: a different token is unaffected', mem.consumeOnce('jti-2', 60_000) === true);

    // A tiny TTL, then a real wait, proves the marker re-claims only AFTER it
    // has genuinely expired — never within its life.
    check('memory: short-TTL marker is claimed once', mem.consumeOnce('jti-short', 40) === true);
    check('memory: and refuses the immediate replay', mem.consumeOnce('jti-short', 40) === false);
    await new Promise((r) => setTimeout(r, 70));
    check('memory: re-claimable only after the TTL expires', mem.consumeOnce('jti-short', 40) === true);
  }

  {
    // The libSQL store on an in-memory database — the backend the bug lived on.
    const store = new LibsqlRateLimitStore(':memory:');
    check('libsql: first claim wins', (await store.consumeOnce('jti-a', 60_000)) === true);
    check('libsql: the replay is refused (no floored-window escape)',
      (await store.consumeOnce('jti-a', 60_000)) === false);
    // Even a SECOND replay stays refused — the marker is not a per-window count.
    check('libsql: still refused on a third attempt',
      (await store.consumeOnce('jti-a', 60_000)) === false);
    check('libsql: an independent token still claims', (await store.consumeOnce('jti-b', 60_000)) === true);

    check('libsql: short-TTL marker claimed once', (await store.consumeOnce('jti-exp', 40)) === true);
    check('libsql: refuses the immediate replay', (await store.consumeOnce('jti-exp', 40)) === false);
    await new Promise((r) => setTimeout(r, 70));
    check('libsql: re-claimable only after the TTL expires', (await store.consumeOnce('jti-exp', 40)) === true);
  }
}

/* ================================================================== *
 * S3.1 — a full memory store evicts; it never forgets everything
 *
 * The store used to CLEAR both maps once it held 50,000 keys. The same store
 * holds the login throttles and the single-use markers for magic links and
 * captcha proofs, so flooding it with fresh keys wiped every throttle and
 * re-opened every spent token. Tested with a cap of five, through the same
 * code path the 50,000 cap uses.
 * ================================================================== */
{
  const { MEMORY_STORE_MAX_KEYS } = RL;
  check('the shipped cap is still 50,000 keys per map', MEMORY_STORE_MAX_KEYS === 50_000);
  check('a store with no options uses it', new MemoryRateLimitStore().sizes().buckets === 0);

  /* ---- THE BUG: a flood must not reset a live throttle ---- */
  {
    const s = new MemoryRateLimitStore({ maxKeys: 5 });
    // A spent login throttle with a LONG window: the thing an attacker wants gone.
    for (let i = 0; i < 10; i += 1) s.consume('login:1.2.3.4|owner@shop', 15 * 60_000, 10);
    check('setup: the login throttle is spent', !s.consume('login:1.2.3.4|owner@shop', 15 * 60_000, 10).allowed);
    // The flood: hundreds of fresh one-minute keys.
    for (let i = 0; i < 500; i += 1) s.consume(`api:flood-${i}`, 60_000, 60);
    check('the map never grows past its cap', s.sizes().buckets <= 5);
    check('THE BUG: the spent login throttle SURVIVES the flood',
      !s.consume('login:1.2.3.4|owner@shop', 15 * 60_000, 10).allowed);
    check('...and still counts from where it was (12th attempt)',
      s.consume('login:1.2.3.4|owner@shop', 15 * 60_000, 10).remaining === 0);
    check('the newest flood key is live (the insert that asked was served)',
      s.consume('api:flood-499', 60_000, 60).remaining === 58);
  }

  /* ---- expired entries go first, and only as many live ones as needed ---- */
  {
    const s = new MemoryRateLimitStore({ maxKeys: 5 });
    s.consume('short-1', 5, 100);
    s.consume('short-2', 5, 100);
    s.consume('long-1', 60_000, 100);
    s.consume('long-2', 60_000, 100);
    s.consume('long-3', 60_000, 100);
    await new Promise((r) => setTimeout(r, 20));
    s.consume('new-1', 60_000, 100); // at cap → the two expired go, nothing live
    const live = ['long-1', 'long-2', 'long-3'].map((k) => s.peek(k, 60_000));
    check('expired entries are evicted first', JSON.stringify(live) === JSON.stringify([1, 1, 1]));
    check('...and nothing live was dropped to make room', s.sizes().buckets === 4);
  }

  /* ---- among live entries, the soonest to expire goes first ---- */
  {
    const s = new MemoryRateLimitStore({ maxKeys: 3 });
    s.consume('login-a', 15 * 60_000, 10);    // oldest insert, LONGEST life
    s.consume('api-b', 60_000, 10);           // expires soonest
    s.consume('login-c', 15 * 60_000, 10);
    s.consume('api-d', 60_000, 10);           // at cap → evict the soonest
    check('the entry closest to expiring is evicted, not the oldest insert',
      s.peek('api-b', 60_000) === 0 && s.peek('login-a', 15 * 60_000) === 1);
    check('...and the rest survive', s.peek('login-c', 15 * 60_000) === 1 && s.peek('api-d', 60_000) === 1);
  }

  /* ---- a key renewed after expiry is treated as new, not as old ---- */
  {
    const s = new MemoryRateLimitStore({ maxKeys: 2 });
    s.consume('renewed', 5, 10);
    await new Promise((r) => setTimeout(r, 15));
    const r = s.consume('renewed', 60_000, 10);
    check('a renewed window starts at one', r.remaining === 9);
  }

  /* ---- single-use markers: THE REPLAY BUG ---- */
  {
    const s = new MemoryRateLimitStore({ maxKeys: 5 });
    check('setup: a magic link is claimed', s.consumeOnce('magic:jti-victim', 15 * 60_000) === true);
    // A flood of short-lived captcha claims.
    for (let i = 0; i < 200; i += 1) s.consumeOnce(`captcha-used:${i}`, 10 * 60_000);
    check('the marker map never grows past its cap', s.sizes().once <= 5);
    check('THE BUG: the spent magic link is still refused after the flood',
      s.consumeOnce('magic:jti-victim', 15 * 60_000) === false);
  }
  {
    const s = new MemoryRateLimitStore({ maxKeys: 3 });
    s.consumeOnce('a', 5);
    s.consumeOnce('b', 60_000);
    s.consumeOnce('c', 60_000);
    await new Promise((r) => setTimeout(r, 15));
    s.consumeOnce('d', 60_000); // at cap → only the expired marker goes
    check('an expired marker is evicted before any live one',
      s.consumeOnce('b', 60_000) === false && s.consumeOnce('c', 60_000) === false && s.consumeOnce('d', 60_000) === false);
  }

  /* ---- peek: reads without counting ---- */
  {
    const s = new MemoryRateLimitStore();
    check('peek of an unknown key is 0', s.peek('nobody', 60_000) === 0);
    s.consume('k', 60_000, 5);
    s.consume('k', 60_000, 5);
    check('peek reports the current count', s.peek('k', 60_000) === 2);
    check('...and does not add to it', s.peek('k', 60_000) === 2 && s.consume('k', 60_000, 5).remaining === 2);
    s.consume('gone', 5, 5);
    await new Promise((r) => setTimeout(r, 15));
    check('peek of an expired window is 0', s.peek('gone', 5) === 0);
  }
}

/* ================================================================== *
 * S3.2 — the libSQL table is swept for EVERY key, not just the one hit
 *
 * The old cleanup deleted stale windows of the key that had just been hit, so
 * a key that was never hit again — one visitor, one typed email — stayed in
 * the table forever.
 * ================================================================== */
{
  const { LIBSQL_SWEEP_INTERVAL_MS } = RL;
  const { createClient } = await import('@libsql/client');
  check('the sweep runs at most once a minute by default', LIBSQL_SWEEP_INTERVAL_MS === 60_000);

  const count = async (client, table) => Number((await client.execute(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);
  // A sweep that THROWS is a failed assertion, not a crashed test file: a
  // broken schema upgrade must read as a ✗ naming the property.
  const sweep = async (store) => {
    try { await store.sweepExpired(); return true; } catch (err) { return String(err?.message ?? err); }
  };

  /* ---- rotating keys do not accumulate ---- */
  {
    const dbFile = path.join(os.tmpdir(), `astrobaas-rl-sweep-${process.pid}.db`);
    await fs.rm(dbFile, { force: true });
    const store = new LibsqlRateLimitStore(`file:${dbFile}`, undefined, { sweepIntervalMs: 0 });
    const raw = createClient({ url: `file:${dbFile}` });
    // 60 visitors, each seen once, on a 10 ms window.
    for (let i = 0; i < 60; i += 1) await store.consume(`api:visitor-${i}`, 10, 60);
    await new Promise((r) => setTimeout(r, 30));
    // One more request from somebody else — the sweep rides on it.
    await store.consume('api:latecomer', 60_000, 60);
    await new Promise((r) => setTimeout(r, 50));
    const left = await count(raw, 'rate_limits');
    check('THE BUG: expired rows for keys never hit again are swept', left <= 1);
    check('...and the live one is kept', (await store.peek('api:latecomer', 60_000)) === 1);

    /* ---- sweepExpired is callable directly, and spares live rows ---- */
    await store.consume('api:live', 60_000, 60);
    await store.consume('api:dying', 10, 60);
    await new Promise((r) => setTimeout(r, 30));
    check('a direct sweep runs', (await sweep(store)) === true);
    const keys = (await raw.execute('SELECT k FROM rate_limits ORDER BY k')).rows.map((r) => String(r.k));
    check('a direct sweep removes only expired rows', !keys.includes('api:dying') && keys.includes('api:live'));

    /* ---- single-use markers are swept too ---- */
    await store.consumeOnce('jti-short', 10);
    await store.consumeOnce('jti-long', 60_000);
    await new Promise((r) => setTimeout(r, 30));
    await sweep(store);
    const markers =(await raw.execute('SELECT k FROM single_use')).rows.map((r) => String(r.k));
    check('expired single-use markers are swept, live ones kept',
      !markers.includes('jti-short') && markers.includes('jti-long'));
    check('...and the live marker still refuses its replay', (await store.consumeOnce('jti-long', 60_000)) === false);

    raw.close();
    await fs.rm(dbFile, { force: true });
  }

  /* ---- the sweep is throttled, not run on every hit ---- */
  {
    const dbFile = path.join(os.tmpdir(), `astrobaas-rl-throttle-${process.pid}.db`);
    await fs.rm(dbFile, { force: true });
    const store = new LibsqlRateLimitStore(`file:${dbFile}`, undefined, { sweepIntervalMs: 60_000 });
    const raw = createClient({ url: `file:${dbFile}` });
    await store.consume('first', 10, 5); // runs the first sweep (nothing to do)
    await store.consume('second', 10, 5);
    await new Promise((r) => setTimeout(r, 30));
    await store.consume('third', 60_000, 5); // inside the interval → no sweep
    await new Promise((r) => setTimeout(r, 30));
    check('inside the interval, expired rows wait for the next sweep', (await count(raw, 'rate_limits')) === 3);
    raw.close();
    await fs.rm(dbFile, { force: true });
  }

  /* ---- an EXISTING table (no expires_at) is upgraded in place ---- */
  {
    const dbFile = path.join(os.tmpdir(), `astrobaas-rl-legacy-${process.pid}.db`);
    await fs.rm(dbFile, { force: true });
    const raw = createClient({ url: `file:${dbFile}` });
    // The shape every live libSQL install has today, with rows it never cleaned.
    await raw.execute('CREATE TABLE rate_limits (k TEXT NOT NULL, window_start INTEGER NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (k, window_start))');
    for (let i = 0; i < 25; i += 1) {
      await raw.execute({ sql: 'INSERT INTO rate_limits (k, window_start, count) VALUES (?, ?, 1)', args: [`api:ghost-${i}`, 1000 + i] });
    }
    const store = new LibsqlRateLimitStore(`file:${dbFile}`, undefined, { sweepIntervalMs: 0 });
    const r = await store.consume('api:after-upgrade', 60_000, 3);
    check('an old table keeps working after the upgrade', r.allowed && r.remaining === 2);
    const cols = (await raw.execute('PRAGMA table_info(rate_limits)')).rows.map((c) => String(c.name));
    check('...and gains expires_at', cols.includes('expires_at'));
    await new Promise((res) => setTimeout(res, 50));
    const swept = await sweep(store);
    check(`...and can be swept${swept === true ? '' : ` (${swept})`}`, swept === true);
    check('...and the rows it never cleaned are finally swept', (await count(raw, 'rate_limits')) === 1);
    // A second store on the same file (another replica) must not fail on the
    // column that now exists.
    const replica = new LibsqlRateLimitStore(`file:${dbFile}`);
    check('a second replica starts cleanly on the upgraded table',
      (await replica.consume('api:after-upgrade', 60_000, 3)).remaining === 1);
    raw.close();
    await fs.rm(dbFile, { force: true });
  }

  /* ---- peek on libSQL ---- */
  {
    const store = new LibsqlRateLimitStore(':memory:');
    check('libsql peek of an unknown key is 0', (await store.peek('none', 60_000)) === 0);
    await store.consume('p', 60_000, 5);
    await store.consume('p', 60_000, 5);
    check('libsql peek reports the count without adding to it',
      (await store.peek('p', 60_000)) === 2 && (await store.peek('p', 60_000)) === 2);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
