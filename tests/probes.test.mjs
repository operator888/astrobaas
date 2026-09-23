#!/usr/bin/env node
/**
 * The public probes — /healthz and /readyz — and the HEALTH_TOKEN rule.
 *
 * ## What was wrong
 *
 *  - /healthz read EVERY post on every call, through an `init()` that on the
 *    lowdb driver rewrites the whole database, and published the post count.
 *    It is public and unauthenticated, so it was the cheapest way on the site
 *    to make the server do the most work — and it told anyone how big the
 *    content library was.
 *  - /readyz echoed the storage error message: a database host, an absolute
 *    data path, a driver version — to anyone.
 *  - /readyz had no idea the process was shutting down.
 *  - HEALTH_TOKEN: the code accepted 16+ characters, the docs demanded 32+, a
 *    short token was never mentioned and a too-short one was silently ignored.
 *
 * The routes are loaded for real, with the storage layer replaced by a stub
 * that counts calls, so "did it read every post" is a number, not a guess.
 *
 * Run with:  node tests/probes.test.mjs
 */
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadTs, ROOT, readRepo } from './lib/load.mjs';

let pass = 0;
let fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };

const cacheDir = path.join(ROOT, 'node_modules', '.cache');
await fs.mkdir(cacheDir, { recursive: true });

/** A LocalDB that counts, and fails on request. */
const STUB = `
export const __calls = { init: 0, getPosts: 0, getSchemaVersion: 0, getSettings: 0 };
export const __fail = { init: 0, read: null, settings: null };
export const LocalDB = {
  async init() {
    __calls.init += 1;
    if (__fail.init > 0) { __fail.init -= 1; throw new Error('init failed: /var/www/secret-path/db.json'); }
  },
  async getPosts() { __calls.getPosts += 1; return [{ id: 'a' }, { id: 'b' }, { id: 'c' }]; },
  async getSchemaVersion() {
    __calls.getSchemaVersion += 1;
    if (__fail.read) throw new Error(__fail.read);
    return 7;
  },
  async getSettings() {
    __calls.getSettings += 1;
    if (__fail.settings) throw new Error(__fail.settings);
    return [];
  },
};
export const getSchemaStatus = () => ({ version: 7, lastMigration: 'x' });
`;

let n = 0;
/** A fresh bundle — fresh module state — of both routes, the stub and observability. */
async function loadRoutes() {
  n += 1;
  const stub = path.join(cacheDir, `astrobaas-probes-stub-${process.pid}-${n}.ts`);
  const entry = path.join(cacheDir, `astrobaas-probes-entry-${process.pid}-${n}.ts`);
  const out = path.join(cacheDir, `astrobaas-probes-${process.pid}-${n}.mjs`);
  await fs.writeFile(stub, STUB);
  const src = (rel) => JSON.stringify(path.join(ROOT, rel));
  await fs.writeFile(entry, [
    `export * as healthz from ${src('src/pages/healthz.ts')};`,
    `export * as readyz from ${src('src/pages/readyz.ts')};`,
    `export * as obs from ${src('src/lib/observability.ts')};`,
    `export { __calls, __fail } from ${JSON.stringify(stub)};`,
  ].join('\n'));
  await build({
    entryPoints: [entry], bundle: true, format: 'esm', platform: 'node',
    packages: 'external', outfile: out, logLevel: 'silent',
    plugins: [{
      name: 'stub-localdb',
      setup(b) { b.onResolve({ filter: /(^|\/)localdb$/ }, () => ({ path: stub })); },
    }],
  });
  try {
    return await import(pathToFileURL(out).href);
  } finally {
    await fs.rm(out, { force: true });
    await fs.rm(entry, { force: true });
    await fs.rm(stub, { force: true });
  }
}

// The probe cache is keyed on Date.now(); move the clock instead of sleeping.
const realNow = Date.now;
let skew = 0;
Date.now = () => realNow() + skew;
const later = (ms) => { skew += ms; };

const get = async (route) => {
  const res = await route.GET({});
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* reported by the caller */ }
  return { status: res.status, text, body, cache: res.headers.get('cache-control') };
};

/* ------------------------------------------------------------- /healthz */
{
  const R = await loadRoutes();
  const TTL = R.healthz.PROBE_TTL_MS;
  check('the probe cache window is short (a real failure shows within seconds)', TTL > 0 && TTL <= 5000);

  const a = await get(R.healthz);
  check('healthz: a healthy store answers 200 ok', a.status === 200 && a.body?.ok === true && a.body?.db === 'ok');
  check('healthz: ...and keeps every field a monitor may read',
    ['ok', 'started_at', 'now', 'db', 'posts'].every((k) => k in (a.body ?? {})));
  check('healthz: ...but no longer publishes the post count', a.body?.posts === null && !/"posts":\s*\d/.test(a.text));
  check('healthz: THE BUG — it does not read the posts at all', R.__calls.getPosts === 0);
  check('healthz: it is never cached by anything in between', a.cache === 'no-store');

  for (let i = 0; i < 20; i++) await get(R.healthz);
  check('healthz: a burst of probes inside the window costs ONE storage read',
    R.__calls.getSchemaVersion === 1);
  check('healthz: init runs once per process, not per probe (lowdb init is a full write)',
    R.__calls.init === 1);

  later(TTL + 1);
  await Promise.all(Array.from({ length: 10 }, () => get(R.healthz)));
  check('healthz: after the window, ten concurrent probes share one new read',
    R.__calls.getSchemaVersion === 2);
  check('healthz: ...and still do not repeat init', R.__calls.init === 1);

  later(TTL + 1);
  R.__fail.read = 'SQLITE_BUSY: /var/www/secret-path/db.sqlite';
  const b = await get(R.healthz);
  check('healthz: a store that stops answering turns the probe 503 within one window',
    b.status === 503 && b.body?.ok === false && b.body?.db === 'error');
  check('healthz: ...without saying why to the public', !/secret-path|SQLITE/.test(b.text));

  later(TTL + 1);
  R.__fail.read = null;
  check('healthz: ...and 200 again once it recovers', (await get(R.healthz)).status === 200);
}
{
  // A database that is down AT BOOT must not be remembered as failed forever.
  const R = await loadRoutes();
  R.__fail.init = 1;
  const a = await get(R.healthz);
  check('healthz: an init failure is a 503', a.status === 503);
  later(R.healthz.PROBE_TTL_MS + 1);
  const b = await get(R.healthz);
  check('healthz: ...and a later probe retries init and recovers', b.status === 200 && R.__calls.init === 2);
}

/* -------------------------------------------------------------- /readyz */
{
  const R = await loadRoutes();
  const ok = await get(R.readyz);
  check('readyz: a healthy, migrated store is ready', ok.status === 200 && ok.body?.ready === true
    && ok.body?.schema_version === 7 && ok.body?.expected_schema_version === 7);

  const secret = 'SQLITE_CANTOPEN: unable to open /var/www/secret-path/shared/data/db.sqlite (libsql 0.5.1)';
  R.__fail.settings = secret;
  const logged = [];
  const origError = console.error;
  console.error = (...args) => { logged.push(args.join(' ')); };
  let bad;
  try {
    bad = await get(R.readyz);
  } finally {
    console.error = origError;
  }
  check('readyz: a storage failure is a 503', bad.status === 503 && bad.body?.ready === false);
  check('readyz: THE BUG — the error message is not published', !bad.text.includes('secret-path') && !/SQLITE|libsql/.test(bad.text));
  check('readyz: ...the `error` field is kept, with a fixed value', bad.body?.error === 'unavailable');
  check('readyz: ...and the operator still gets the reason, in the log', logged.some((l) => l.includes('secret-path')));

  R.__fail.settings = null;
  const before = { ...R.__calls };
  R.obs.markDraining();
  const draining = await get(R.readyz);
  check('readyz: a draining process is NOT ready, however healthy its store',
    draining.status === 503 && draining.body?.ready === false && draining.body?.draining === true);
  check('readyz: ...and says so without touching storage',
    R.__calls.init === before.init && R.__calls.getSettings === before.getSettings);

  const live = await get(R.healthz);
  check('healthz: liveness stays 200 while draining — the process is alive, a supervisor must not kill it',
    live.status === 200);
}

Date.now = realNow;

/* ---------------------------------------------------------- HEALTH_TOKEN */
{
  const H = await loadTs('src/lib/health-token.ts');
  const s = (len) => 'x'.repeat(len);
  check('token: unset / blank is "unset"', H.healthTokenStrength(undefined) === 'unset'
    && H.healthTokenStrength('') === 'unset' && H.healthTokenStrength('   ') === 'unset');
  check('token: under 16 is ignored (unchanged behaviour)', H.healthTokenStrength(s(15)) === 'ignored' && !H.healthTokenUsable(s(15)));
  check('token: 16 still WORKS — raising the floor would break live deploy scripts',
    H.healthTokenStrength(s(16)) === 'short' && H.healthTokenUsable(s(16)));
  check('token: 31 works but is short', H.healthTokenStrength(s(31)) === 'short' && H.healthTokenUsable(s(31)));
  check('token: 32 is what the docs ask for', H.healthTokenStrength(s(32)) === 'ok' && H.healthTokenUsable(s(32)));
  check('token: the documented and the enforced numbers are the constants',
    H.HEALTH_TOKEN_MIN_LENGTH === 16 && H.HEALTH_TOKEN_RECOMMENDED_LENGTH === 32);

  const secret = 'abcdefghijklmnopqrst'; // 20 chars
  const short = H.describeHealthToken(secret);
  check('token: a short token is a WARNING with a remedy', short.level === 'warn' && /32/.test(short.detail) && /openssl/.test(short.detail));
  check('token: ...that never contains the token itself', !short.detail.includes(secret) && !short.detail.includes('abcdef'));
  check('token: an ignored token says it is ignored', H.describeHealthToken(s(10)).level === 'warn'
    && /IGNORED/.test(H.describeHealthToken(s(10)).detail));
  check('token: unset and long are fine', H.describeHealthToken(undefined).level === 'ok' && H.describeHealthToken(s(40)).level === 'ok');

  // The route uses the helper for BOTH the gate and the report, so the two
  // cannot drift apart again.
  const deep = (await readRepo('src/pages/api/health/deep.ts')).replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '');
  check('deep check: the gate is healthTokenUsable, not a literal length',
    /const byToken = healthTokenUsable\(token\)/.test(deep) && !/token\.length\s*>=\s*\d+/.test(deep));
  check('deep check: the token strength is one of the reported checks',
    /run\('health_token', checkHealthToken\)/.test(deep) && /describeHealthToken\(process\.env\.HEALTH_TOKEN\)/.test(deep));

  const docs = [await readRepo('README.md'), await readRepo('deploy/README.md'), await readRepo('.env.example')];
  check('docs: every place that states the length says 32+',
    docs.every((d) => /HEALTH_TOKEN[\s\S]{0,200}32\+|32\+[\s\S]{0,200}HEALTH_TOKEN/.test(d)));
  check('docs: the operator doc says what a short token now does',
    /health_token/.test(docs[1]) && /health_token/.test(docs[2]));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
