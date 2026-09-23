#!/usr/bin/env node
/**
 * The bootstrap admin: its address, and when a second one must NOT be created.
 *
 * Two things are under test, and the second is a security property.
 *
 *  1. `ADMIN_EMAIL` gives the account that owns the install a REAL address, so
 *     a password reset can reach somebody. `admin@local` cannot receive mail.
 *
 *  2. An install that already has an administrator must never be given another
 *     one. The old check asked "is there a user called admin@local", so an
 *     operator who renamed the seeded account — which the users API now allows
 *     — got a fresh admin@local on the next boot, carrying the PUBLISHED
 *     default password and re-using the seed's fixed id.
 *
 * Run with:  node tests/seed-admin.test.mjs
 */
import { loadTs, readRepo } from './lib/load.mjs';

const S = await loadTs('src/lib/seed-data.ts');

let pass = 0;
let fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };

const withEnv = (value, fn) => {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'ADMIN_EMAIL');
  const prev = process.env.ADMIN_EMAIL;
  if (value === undefined) delete process.env.ADMIN_EMAIL;
  else process.env.ADMIN_EMAIL = value;
  try { return fn(); } finally {
    if (had) process.env.ADMIN_EMAIL = prev; else delete process.env.ADMIN_EMAIL;
  }
};

/* -------------------------------------------------- the configured address */
{
  check('unset falls back to the placeholder',
    withEnv(undefined, () => S.seedAdminEmail()) === S.DEFAULT_ADMIN_EMAIL);
  check('the placeholder is the documented one', S.DEFAULT_ADMIN_EMAIL === 'admin@local');
  check('a real address is used', withEnv('theo@example.com', () => S.seedAdminEmail()) === 'theo@example.com');
  check('it is lower-cased and trimmed',
    withEnv('  Theo@Example.COM  ', () => S.seedAdminEmail()) === 'theo@example.com');
  check('an empty value is not an address',
    withEnv('   ', () => S.seedAdminEmail()) === S.DEFAULT_ADMIN_EMAIL);

  // A typo must not brick the install with an unusable admin account.
  const warned = [];
  const realWarn = console.warn;
  console.warn = (...a) => warned.push(a.join(' '));
  const bad = withEnv('not-an-address', () => S.seedAdminEmail());
  console.warn = realWarn;
  check('a malformed address falls back rather than throwing', bad === S.DEFAULT_ADMIN_EMAIL);
  check('...and says so, instead of failing silently',
    warned.some((w) => w.includes('ADMIN_EMAIL') && w.includes('not-an-address')));

  // Read at CALL time: a module-level constant would freeze the value at import.
  check('the value is read per call, not frozen at import',
    withEnv('a@b.co', () => S.seedAdminEmail()) === 'a@b.co'
    && withEnv('c@d.co', () => S.seedAdminEmail()) === 'c@d.co');
}

/* ------------------------------------------------------ the seeded account */
{
  const admin = withEnv('owner@example.com', () => S.makeSeedAdmin());
  check('the seeded admin carries the configured address', admin.email === 'owner@example.com');
  check('...is an admin', admin.role === 'admin');
  check('...and keeps the stable seed id', admin.id === S.SEED_ADMIN_ID);
}

/* ------------------------------------------- never a second bootstrap admin */
{
  // The predicate localdb.ts uses, stated here so a change to it has to change
  // this test too. "Any administrator" — NOT "a user with the seed address".
  const needsSeed = (users) => !users.some((u) => u.role === 'admin');

  check('a genuinely empty install is seeded', needsSeed([]) === true);
  check('an install with only non-admins is seeded',
    needsSeed([{ id: 'u1', email: 'ed@example.com', role: 'editor' }]) === true);

  // THE regression.
  const renamed = [{ id: S.SEED_ADMIN_ID, email: 'theo@example.com', role: 'admin' }];
  check('a RENAMED seeded admin is not re-seeded', needsSeed(renamed) === false);
  const oldPredicate = !renamed.some((u) => u.email === 'admin@local');
  check('...and the old address-matching predicate would have re-seeded it', oldPredicate === true);

  check('an install whose admin was always custom is not re-seeded',
    needsSeed([{ id: 'other', email: 'boss@example.com', role: 'admin' }]) === false);
  check('the untouched seeded admin is not duplicated',
    needsSeed([{ id: S.SEED_ADMIN_ID, email: 'admin@local', role: 'admin' }]) === false);
}

/* ------------------- ...and that localdb.ts really uses that predicate ------ */
{
  // The block above states the rule; without this, it states it about a copy
  // and would keep passing after localdb.ts reverted. Comments are stripped
  // first — an assertion satisfied by the prose explaining it is the exact
  // failure this suite is meant to prevent.
  const raw = await readRepo('src/lib/localdb.ts');
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  check('localdb seeds on "no administrator", not on the seed address',
    code.includes("users.some(u => u.role === 'admin')"));
  check('...and no longer matches the bootstrap address',
    !code.includes("u.email === 'admin@local'"));
  // The stripper must be doing something, or the two checks above are vacuous.
  check('the comment stripper actually strips', code.length < raw.length
    && raw.includes('published default password') && !code.includes('published default password'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
