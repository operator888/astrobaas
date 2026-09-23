#!/usr/bin/env node
/**
 * Credential throttles (S3.9, S3.10), against the real memory store.
 *
 * The property that makes these correct rather than merely strict: NOTHING an
 * attacker can do from their own addresses may lock the OWNER out.
 *
 *   - One address guessing many accounts is refused (a hard limit on THAT
 *     address, counted in failures, so an office signing in is not).
 *   - Many addresses guessing one account make that account require
 *     proof-of-work — never refuse it. The owner's browser solves the
 *     challenge; the owner signs in.
 *   - The two-factor step is counted per account, so a pending cookie is no
 *     longer an unlimited supply of code guesses.
 *
 * The route's ORDER is checked by reading it (it needs a server to run), and
 * driven end to end in tests/smoke.mjs.
 *
 * Run with:  node tests/login-guard.test.mjs
 */
import { loadTs, readRepo } from './lib/load.mjs';

const G = await loadTs('src/lib/login-guard.ts');
const { MemoryRateLimitStore } = await loadTs('src/lib/rate-limit.ts');

let pass = 0;
let fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };
const code = (src) => src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

const L = G.DEFAULT_LOGIN_LIMITS;

/* ---------------------------------------------- the numbers */
{
  check('defaults: 10 per address+email, 30 failures per address, proof after 5, 10 code attempts',
    L.perIpEmail === 10 && L.perIpFailures === 30 && L.accountProofAfter === 5 && L.secondFactorAttempts === 10);
  check('the window is fifteen minutes', G.LOGIN_WINDOW_MS === 15 * 60_000);
  const e = G.resolveLoginLimits({ LOGIN_IP_FAILURE_LIMIT: '50', LOGIN_ACCOUNT_POW_AFTER: '0', TWOFA_ATTEMPT_LIMIT: 'x' });
  check('env tunes the address failure budget', e.perIpFailures === 50);
  check('...a zero or junk value keeps the default', e.accountProofAfter === 5 && e.secondFactorAttempts === 10);
  check('...and the original per address+email limit is not configurable',
    G.resolveLoginLimits({ LOGIN_IP_EMAIL_LIMIT: '1000' }).perIpEmail === 10);
  check('emails are counted case- and space-insensitively',
    G.loginKeys('ip', ' Owner@Shop.GR ').account === G.loginKeys('ip', 'owner@shop.gr').account);
  check('the stable code the login page understands', G.POW_REQUIRED_CODE === 'POW_REQUIRED');
}

/* ---------------------------------------------- the original throttle is unchanged */
{
  const s = new MemoryRateLimitStore();
  let ok = 0;
  for (let i = 0; i < 12; i += 1) if (await G.loginAttemptAllowed(s, '1.2.3.4', 'a@b.c')) ok += 1;
  check('one address, one email: still exactly 10 attempts', ok === 10);
  check('...and the same key as before, so a deploy does not reset it',
    s.peek('login:1.2.3.4|a@b.c', G.LOGIN_WINDOW_MS) === 12);
}

/* ---------------------------------------------- S3.9: one address, many accounts */
{
  const s = new MemoryRateLimitStore();
  const ip = '198.51.100.9';
  let refusedAt = -1;
  for (let i = 0; i < 40; i += 1) {
    const email = `victim-${i}@example.com`;
    if (!(await G.loginAttemptAllowed(s, ip, email))) { refusedAt = i; break; }
    await G.recordLoginFailure(s, ip, email);
  }
  check('credential stuffing from one address stops after 30 failures', refusedAt === 30);
  check('...for an email this address never tried before', !(await G.loginAttemptAllowed(s, ip, 'brand-new@example.com')));
  check('...and a refused address mints no new per-email keys',
    s.peek(`login:${ip}|brand-new@example.com`, G.LOGIN_WINDOW_MS) === 0);
  check('another address is unaffected', await G.loginAttemptAllowed(s, '198.51.100.10', 'victim-0@example.com'));

  // An office: one address, many SUCCESSFUL sign-ins. Successes are not
  // failures, so they never reach the budget.
  const office = new MemoryRateLimitStore();
  let allowed = 0;
  for (let i = 0; i < 100; i += 1) if (await G.loginAttemptAllowed(office, '203.0.113.1', `staff-${i % 20}@shop.gr`)) allowed += 1;
  check('a busy office signing in successfully is never refused by the failure budget', allowed === 100);
}

/* ---------------------------------------------- S3.9: many addresses, one account */
{
  const s = new MemoryRateLimitStore();
  const owner = 'owner@shop.gr';
  check('a fresh account needs no proof', !(await G.accountNeedsProof(s, owner)));
  for (let i = 0; i < 4; i += 1) await G.recordLoginFailure(s, `203.0.113.${i}`, owner);
  check('four failures: still no proof needed', !(await G.accountNeedsProof(s, owner)));
  await G.recordLoginFailure(s, '203.0.113.99', owner);
  check('the fifth failure, from ANY address, requires proof-of-work', await G.accountNeedsProof(s, owner));
  check('...spelled any way', await G.accountNeedsProof(s, 'OWNER@shop.gr '));
  check('...and only for that account', !(await G.accountNeedsProof(s, 'someone-else@shop.gr')));

  // THE LOCK-OUT PROPERTY. A thousand failures from a thousand addresses.
  for (let i = 0; i < 1000; i += 1) await G.recordLoginFailure(s, `10.${(i >> 8) & 255}.${i & 255}.1`, owner);
  check('after a thousand distributed failures the OWNER, from their own address, may still try',
    await G.loginAttemptAllowed(s, '192.0.2.200', owner));
  check('...and is asked for proof, not refused', await G.accountNeedsProof(s, owner));

  // Unknown accounts are counted exactly like real ones.
  const t = new MemoryRateLimitStore();
  for (let i = 0; i < 5; i += 1) await G.recordLoginFailure(t, `203.0.113.${i}`, 'nobody@nowhere.example');
  check('an email with no account is counted the same (no enumeration)', await G.accountNeedsProof(t, 'nobody@nowhere.example'));
}

/* ---------------------------------------------- S3.10: the two-factor step */
{
  const s = new MemoryRateLimitStore();
  let tries = 0;
  for (let i = 0; i < 15; i += 1) if (await G.secondFactorAttemptAllowed(s, 'user-1')) tries += 1;
  check('ten code attempts per account per window', tries === 10);
  check('...counted per ACCOUNT, not per pending token (a new token is only a re-login)',
    !(await G.secondFactorAttemptAllowed(s, 'user-1')));
  check('another account is unaffected', await G.secondFactorAttemptAllowed(s, 'user-2'));
}

/* ---------------------------------------------- the route applies them, in order */
{
  const login = code(await readRepo('src/pages/api/auth/login.ts'));
  const iThrottle = login.indexOf('await allow(email)');
  const iProof = login.indexOf('await accountNeedsProof(store, email, limits)');
  const iLookup = login.indexOf('LocalDB.getUserByEmail(email)');
  const iVerify = login.indexOf('await verifyPassword(password');
  check('the address throttles run first', iThrottle > -1 && iThrottle < iProof);
  check('the account proof is demanded BEFORE the password is looked at', iProof > -1 && iProof < iLookup && iLookup < iVerify);
  check('...only when the operator switch did not already demand one', /if \(!surfaceOn && await accountNeedsProof\(/.test(login));
  check('...verified with the login surface', /const proof = await verifyPow\(powToken \|\| undefined, 'login'\)/.test(login));
  check('a form sign-in is sent back to the page that solves it', /\/login\?error=pow&next=/.test(login));
  check('an API sign-in gets the stable code and a fresh challenge',
    /code:\s*POW_REQUIRED_CODE/.test(login) && /details:\s*\{\s*surface:\s*'login',\s*challenge\s*\}/.test(login));
  check('every failure path charges the failure counters',
    /const loginFailed = async \(\) => \{[\s\S]*?await recordLoginFailure\(store, ip, email, limits\)/.test(login)
    && (login.match(/return loginFailed\(\)/g) ?? []).length === 3);
  check('the operator switch still runs first, as before',
    login.indexOf("verifyPow(powToken || undefined, 'login') : { ok: true") < iThrottle);

  // S3.10: both code paths go through the counted helper.
  const iPending = login.indexOf('const pending = verifyPending2fa(');
  check('the pending-cookie step uses the counted second factor',
    /if \(pending && code && !password\) \{[\s\S]*?return secondFactor\(user, code\);/.test(login));
  check('...and so does the inline password+code path',
    /if \(code\) \{\s*return secondFactor\(user, code\);/.test(login));
  check('the counter is charged BEFORE the code is checked',
    /const secondFactor = async[\s\S]*?secondFactorAttemptAllowed\(store, user\.id, limits\)[\s\S]*?checkSecondFactor\(user\.two_factor, submitted\)/.test(login));
  check('checkSecondFactor is called nowhere else', (login.match(/checkSecondFactor\(/g) ?? []).length === 1);
  check('a refused code attempt says so on the two-factor form', /tooMany\('\/login\?twofa=1&error=rate'\)/.test(login));
  check('the pending step still sits where it did', iPending > -1 && iPending < iThrottle);

  // The middleware hands the route the combined address throttle.
  const mw = code(await readRepo('src/middleware.ts'));
  check('locals.loginRateCheck is the combined address throttle',
    /return loginAttemptAllowed\(rateStore, ip, email, LOGIN_LIMITS\)/.test(mw));

  // The sign-in page carries a challenge and says what the new error means.
  const page = await readRepo('src/pages/login.astro');
  check('the sign-in page embeds a login challenge for the widget',
    /const loginChallenge = twofa \? null : makeChallenge\('login'\)/.test(page)
    && /data-captcha-token=\{loginChallenge\?\.token\}/.test(page)
    && /data-captcha-bits=\{loginChallenge\?\.bits\}/.test(page));
  check('...and explains error=pow', /error === 'pow'/.test(page));
  const widget = await readRepo('src/pages/captcha.js.ts');
  check('the widget solves an embedded challenge before asking the endpoint',
    /getAttribute\('data-captcha-token'\)/.test(widget)
    && widget.indexOf("getAttribute('data-captcha-token')") < widget.indexOf("fetch('/api/captcha/challenge"));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
