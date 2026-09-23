#!/usr/bin/env node
/**
 * Proof-of-work captcha (src/lib/captcha.ts).
 *
 * The properties under test are the ones an attacker probes: a solution must
 * not verify twice (replay), for another form (surface confusion), with a
 * doctored difficulty (the bits live inside the signature), after tampering,
 * or by presenting some OTHER purpose-tagged token this process signs.
 *
 * Run with:  node tests/captcha.test.mjs
 */
import { build } from 'esbuild';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Low difficulty for test speed — the clamping test below proves the floor.
process.env.CAPTCHA_BITS = '10';

const here = path.dirname(fileURLToPath(import.meta.url));
const cacheDir = path.join(here, '..', 'node_modules', '.cache');
await fs.mkdir(cacheDir, { recursive: true });

const entry = path.join(cacheDir, `astrobaas-captcha-entry-${process.pid}.ts`);
const outFile = path.join(cacheDir, `astrobaas-captcha-${process.pid}.mjs`);
const root = path.join(here, '..');
await fs.writeFile(entry, [
  `export * from ${JSON.stringify(path.join(root, 'src/lib/captcha.ts'))};`,
  `export { signPurposeToken, signPending2fa } from ${JSON.stringify(path.join(root, 'src/lib/auth.ts'))};`,
].join('\n'));
await build({
  entryPoints: [entry], bundle: true, format: 'esm', platform: 'node',
  packages: 'external', outfile: outFile, logLevel: 'silent',
});
const C = await import(pathToFileURL(outFile).href);
await fs.rm(entry, { force: true });
await fs.rm(outFile, { force: true });

let pass = 0;
let fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };

function leadingZeroBits(digest, bits) {
  let remaining = bits;
  for (let i = 0; i < digest.length && remaining > 0; i++) {
    const take = Math.min(8, remaining);
    if (digest[i] >>> (8 - take) !== 0) return false;
    remaining -= take;
  }
  return remaining <= 0;
}

/** The honest solver — exactly what /captcha.js does, in Node. */
function solve(token, bits) {
  for (let n = 0; n < 10_000_000; n++) {
    const digest = crypto.createHash('sha256').update(`${token}.${n}`).digest();
    if (leadingZeroBits(digest, bits)) return String(n);
  }
  throw new Error('unsolvable at test difficulty');
}

/* ---- the pure resolver ---- */
{
  const r = C.resolveCaptchaSurfaces;
  check('absent setting → nothing protected', r({}).size === 0 && r(null).size === 0);
  check('a valid list resolves', [...r({ captcha_surfaces: ['login', 'contact'] })].sort().join() === 'contact,login');
  check('unknown ids are dropped, known survive',
    [...r({ captcha_surfaces: ['login', 'evil', 42] })].join() === 'login');
  check('non-array is nothing', r({ captcha_surfaces: 'login' }).size === 0);
}

/* ---- difficulty clamps ---- */
{
  check('test env difficulty applies', C.difficultyBits() === 10);
  process.env.CAPTCHA_BITS = '3';
  check('too low clamps to 8 (a typo cannot disable the check)', C.difficultyBits() === 8);
  process.env.CAPTCHA_BITS = '99';
  check('too high clamps to 22 (a typo cannot lock humans out)', C.difficultyBits() === 22);
  process.env.CAPTCHA_BITS = 'lots';
  check('garbage falls back to 15', C.difficultyBits() === 15);
  process.env.CAPTCHA_BITS = '10';
}

/* ---- the honest path, then every dishonest one ---- */
{
  const { token, bits } = C.makeChallenge('contact');
  const nonce = solve(token, bits);

  const first = await C.verifyPow(`${token}::${nonce}`, 'contact');
  check('a solved challenge verifies', first.ok === true);

  const replay = await C.verifyPow(`${token}::${nonce}`, 'contact');
  check('the SAME solution is refused the second time', !replay.ok && replay.reason === 'replayed');

  const other = C.makeChallenge('contact');
  const crossSurface = await C.verifyPow(`${other.token}::${solve(other.token, other.bits)}`, 'login');
  check('a contact challenge does not open the login door', !crossSurface.ok && crossSurface.reason === 'wrong-surface');

  const third = C.makeChallenge('newsletter');
  const wrongNonce = await C.verifyPow(`${third.token}::12345`, 'newsletter');
  check('an unsolved nonce is refused', !wrongNonce.ok && wrongNonce.reason === 'not-solved');

  const tampered = third.token.slice(0, 10) + (third.token[10] === 'A' ? 'B' : 'A') + third.token.slice(11);
  const tamperedRes = await C.verifyPow(`${tampered}::${solve(tampered, third.bits)}`, 'newsletter');
  check('a tampered challenge fails the signature, even solved', !tamperedRes.ok && tamperedRes.reason === 'invalid');

  check('missing and malformed inputs are named, not thrown', (
    (await C.verifyPow(undefined, 'contact')).reason === 'missing'
    && (await C.verifyPow('', 'contact')).reason === 'missing'
    && (await C.verifyPow('no-separator', 'contact')).reason === 'invalid'
    && (await C.verifyPow('a::' + 'n'.repeat(40), 'contact')).reason === 'invalid'
  ));

  // Purpose confusion: a token this process signs for ANOTHER purpose must
  // never verify as a challenge, however honestly it is solved.
  const twofa = C.signPending2fa('user-1');
  const confused = await C.verifyPow(`${twofa}::${solve(twofa, 10)}`, 'contact');
  check('a pending-2FA token is not a captcha challenge', !confused.ok && confused.reason === 'invalid');

  // Expiry: a challenge already past its exp fails as invalid even if solved.
  const expired = C.signPurposeToken('pow', { s: 'contact', r: 'x', d: 10 }, -1000);
  const expiredRes = await C.verifyPow(`${expired}::${solve(expired, 10)}`, 'contact');
  check('an expired challenge is dead, solved or not', !expiredRes.ok && expiredRes.reason === 'invalid');

  // A doctored difficulty cannot come from outside the signature: d lives in
  // the signed body, so the only way to "lower" it is to break the signature.
  const lowballBody = Buffer.from(JSON.stringify({ s: 'contact', r: 'y', d: 1, p: 'pow', exp: Date.now() + 60000 })).toString('base64url');
  const lowball = `${lowballBody}.forged-signature`;
  const lowballRes = await C.verifyPow(`${lowball}::${solve(lowball, 1)}`, 'contact');
  check('a forged low-difficulty challenge fails the signature', !lowballRes.ok && lowballRes.reason === 'invalid');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
