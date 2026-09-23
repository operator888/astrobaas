#!/usr/bin/env node
/**
 * Password hashing off the event loop (S3.8).
 *
 * `pbkdf2Sync` at 120,000 iterations held the whole process for tens of
 * milliseconds on every sign-in, forgot-password and magic-link request —
 * unknown emails included, by design. A burst of anonymous login posts stalled
 * every checkout the process was serving. The hash is async now.
 *
 * Three things matter, and each is pinned here:
 *
 *   1. THE SAME BYTES. Every live account's stored hash must still verify.
 *      The golden value below was computed with the old synchronous call.
 *   2. IT ACTUALLY YIELDS. An `async` wrapper around `pbkdf2Sync` would pass
 *      every equivalence check and block exactly as before.
 *   3. EVERY CALLER AWAITS. A Promise is truthy: an un-awaited
 *      `if (!verifyPassword(...))` accepts ANY password, and an un-awaited
 *      dummy hash answers at once — the timing oracle it exists to close.
 *
 * Run with:  node tests/password-hash.test.mjs
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadTs, readRepo, ROOT } from './lib/load.mjs';

process.env.AUTH_SECRET = 'password-hash-test-secret-0123456789';
const A = await loadTs('src/lib/auth.ts');

let pass = 0;
let fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };

const code = (src) => src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

/* ---------------------------------------------- 1. byte-identical output */
{
  // Computed ONCE with the pre-S3.8 code path:
  //   crypto.pbkdf2Sync(pw, salt, 120000, 32, 'sha256').toString('hex')
  // and pasted here, so a change to the iterations, key length or digest —
  // on either side — is caught against a value nothing in this run produced.
  const SALT = '0123456789abcdef0123456789abcdef';
  const GOLDEN = '58fd5b978ac606a4bcd254fb45362548f7a0f70a909280d4f87c1b2107d53077';
  check('an existing stored hash still verifies', (await A.verifyPassword('correct horse battery staple', GOLDEN, SALT)) === true);
  check('...and the wrong password still does not', (await A.verifyPassword('correct horse battery stapler', GOLDEN, SALT)) === false);

  const fresh = await A.hashPassword('Γυαλιά ηλίου #2026');
  const viaSync = crypto.pbkdf2Sync('Γυαλιά ηλίου #2026', fresh.salt, 120_000, 32, 'sha256').toString('hex');
  check('a NEW hash is exactly what the old synchronous call produces', fresh.hash === viaSync);
  check('...64 hex characters, with a 32-hex-character salt', /^[0-9a-f]{64}$/.test(fresh.hash) && /^[0-9a-f]{32}$/.test(fresh.salt));

  const seeded = A.hashPasswordSync('seed-me');
  check('the one synchronous helper agrees with the async verifier',
    (await A.verifyPassword('seed-me', seeded.hash, seeded.salt)) === true);

  check('empty inputs are refused without hashing', (await A.verifyPassword('', GOLDEN, SALT)) === false
    && (await A.verifyPassword('x', '', SALT)) === false && (await A.verifyPassword('x', GOLDEN, '')) === false);
  check('a malformed stored hash is refused, not thrown', (await A.verifyPassword('x', 'abc', SALT)) === false);

  check('the dummy hash resolves to false', (await A.dummyVerifyPassword('whatever')) === false);
  check('...even for an empty password', (await A.dummyVerifyPassword('')) === false);
}

/* ---------------------------------------------- 2. it does not block */
{
  // A synchronous hash finishes inside the call, so its `.then` is a
  // microtask that runs BEFORE any macrotask. A thread-pool hash finishes
  // later, so a setImmediate queued after the call runs first.
  const order = [];
  const p = A.verifyPassword('pw', '00'.repeat(32), 'ab'.repeat(16)).then(() => order.push('hash'));
  setImmediate(() => order.push('tick'));
  await p;
  check('the event loop turns while verifyPassword runs', order[0] === 'tick');

  const order2 = [];
  const q = A.dummyVerifyPassword('pw').then(() => order2.push('hash'));
  setImmediate(() => order2.push('tick'));
  await q;
  check('...and while the timing-equaliser runs', order2[0] === 'tick');

  const order3 = [];
  const r = A.hashPassword('pw').then(() => order3.push('hash'));
  setImmediate(() => order3.push('tick'));
  await r;
  check('...and while a new password is hashed', order3[0] === 'tick');

  // The equaliser must still do the REAL work: at least a large fraction of
  // what a real verification costs, or the not-found path is measurably faster.
  const time = async (fn) => { const t = process.hrtime.bigint(); await fn(); return Number(process.hrtime.bigint() - t) / 1e6; };
  const real = [];
  const dummy = [];
  for (let i = 0; i < 3; i += 1) {
    real.push(await time(() => A.verifyPassword('pw', '00'.repeat(32), 'ab'.repeat(16))));
    dummy.push(await time(() => A.dummyVerifyPassword('pw')));
  }
  const med = (a) => a.sort((x, y) => x - y)[1];
  check(`the timing-equaliser still costs a real hash (${med(dummy).toFixed(1)}ms vs ${med(real).toFixed(1)}ms)`,
    med(dummy) > med(real) * 0.5);
}

/* ---------------------------------------------- 3. every caller awaits */
{
  function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs, out);
      else if (/\.(ts|astro|mjs|js)$/.test(e.name)) out.push(abs);
    }
    return out;
  }
  const files = [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'scripts')), ...walk(path.join(ROOT, 'bin'))];
  const offenders = [];
  const callers = new Set();
  let calls = 0;
  for (const abs of files) {
    const rel = path.relative(ROOT, abs);
    if (rel === path.join('src', 'lib', 'auth.ts')) continue;
    const src = code(fs.readFileSync(abs, 'utf8'));
    for (const m of src.matchAll(/(\b(?:await|function)\s+)?\b(hashPassword|verifyPassword|dummyVerifyPassword)\s*\(/g)) {
      // A local DEFINITION (the CLIs carry their own) is not a call.
      if (m[1] && m[1].startsWith('function')) continue;
      const before = src.slice(Math.max(0, m.index - 12), m.index);
      if (/async\s+function\s*$/.test(before) || /function\s*$/.test(before)) continue;
      calls += 1;
      callers.add(rel);
      if (!m[1] || !m[1].startsWith('await')) offenders.push(`${rel}: ${m[2]}( not awaited`);
    }
  }
  check(`every hashPassword/verifyPassword/dummyVerifyPassword call is awaited${offenders.length ? ` — ${offenders.join('; ')}` : ''}`,
    offenders.length === 0);
  // The scan must actually have found the callers it is meant to police.
  for (const f of [
    'src/pages/api/auth/login.ts', 'src/pages/api/auth/forgot.ts', 'src/pages/api/auth/magic-link.ts',
    'src/pages/api/auth/reset.ts', 'src/pages/api/users/create.ts', 'src/pages/api/users/update.ts',
    'src/pages/admin/index.astro', 'scripts/setup.mjs', 'scripts/reset-password.mjs',
  ]) {
    check(`the scan covers ${f}`, callers.has(f.split('/').join(path.sep)));
  }
  check('the scan found a plausible number of calls', calls >= 12);

  // The synchronous helper has exactly one legitimate caller.
  const syncUsers = files
    .filter((abs) => path.relative(ROOT, abs) !== path.join('src', 'lib', 'auth.ts'))
    .filter((abs) => /\bhashPasswordSync\b/.test(code(fs.readFileSync(abs, 'utf8'))))
    .map((abs) => path.relative(ROOT, abs));
  check(`hashPasswordSync is used ONLY by the boot-time seed (${syncUsers.join(', ')})`,
    syncUsers.length === 1 && syncUsers[0] === path.join('src', 'lib', 'seed-data.ts'));
  const auth = code(await readRepo('src/lib/auth.ts'));
  check('no request-path helper in auth.ts calls pbkdf2Sync',
    (auth.match(/pbkdf2Sync\(/g) ?? []).length === 1
    && auth.indexOf('pbkdf2Sync(') > auth.indexOf('export function hashPasswordSync'));

  // The two CLIs keep their own copy of the derivation (they cannot import
  // TypeScript). Held to the server's three parameters, and to its output.
  const P = auth.match(/PBKDF2_ITERATIONS = ([\d_]+);[\s\S]*?PBKDF2_KEYLEN = (\d+);[\s\S]*?PBKDF2_DIGEST = '(\w+)'/);
  check('the server parameters are readable', !!P);
  const iters = Number(P?.[1].replace(/_/g, ''));
  for (const f of ['scripts/setup.mjs', 'scripts/reset-password.mjs']) {
    const src = code(await readRepo(f));
    const m = src.match(/await pbkdf2\(password, salt, ([\d_]+), (\d+), '(\w+)'\)/);
    check(`${f} derives with the server's parameters`,
      !!m && Number(m[1].replace(/_/g, '')) === iters && m[2] === P?.[2] && m[3] === P?.[3]);
    check(`${f} no longer blocks with pbkdf2Sync`, !/pbkdf2Sync/.test(src));
  }
  const reset = code(await readRepo('scripts/reset-password.mjs'));
  check('the CLI reset signs the account out everywhere, like the web reset',
    /session_version = \(users\[idx\]\.session_version \?\? 0\) \+ 1/.test(reset));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
