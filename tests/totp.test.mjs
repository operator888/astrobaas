#!/usr/bin/env node
/**
 * TOTP/HOTP correctness (src/lib/totp.ts) — validated against the official
 * RFC 6238 Appendix B test vectors (SHA1, key "12345678901234567890"). If this
 * passes, the codes AstroBaaS generates interoperate with any authenticator app.
 *
 * Run with:  node tests/totp.test.mjs
 */
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cacheDir = path.join(here, '..', 'node_modules', '.cache');
await fs.mkdir(cacheDir, { recursive: true });

// Bundle so a module's own cross-imports (e.g. twofactor.ts → totp.ts) resolve;
// node: built-ins stay external.
async function load(rel) {
  const tmp = path.join(cacheDir, `astrobaas-${path.basename(rel)}-${process.pid}.mjs`);
  await build({
    entryPoints: [path.join(here, '..', rel)],
    bundle: true,
    format: 'esm',
    platform: 'node',
    packages: 'external',
    outfile: tmp,
    logLevel: 'silent',
  });
  const mod = await import(pathToFileURL(tmp).href);
  await fs.rm(tmp, { force: true });
  return mod;
}

const totpMod = await load('src/lib/totp.ts');
const { base32Encode, base32Decode, hotp, totp, verifyTotp, otpauthUri, generateTotpSecret } = totpMod;
const { generateBackupCodes, hashBackupCode, matchBackupCode } = await load('src/lib/twofactor.ts');

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) pass++;
  else {
    fail++;
    console.error(`✗ ${name}`);
  }
}

// ---- RFC 6238 Appendix B (SHA1) via HOTP on the raw ASCII key ----
{
  const key = Buffer.from('12345678901234567890', 'ascii');
  // (time, expected 8-digit TOTP) — counter = floor(time / 30).
  const vectors = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];
  let allHotp = true;
  let allTotp = true;
  const secret = base32Encode(key);
  for (const [time, expected8] of vectors) {
    const counter = Math.floor(time / 30);
    if (hotp(key, counter, 8) !== expected8) allHotp = false;
    // Full path: base32 secret → totp() at that time, 8 digits.
    if (totp(secret, { t: time * 1000, digits: 8 }) !== expected8) allTotp = false;
    // Default 6-digit is the last 6 of the vector.
    if (totp(secret, { t: time * 1000 }) !== expected8.slice(-6)) allTotp = false;
  }
  check('HOTP matches all RFC 6238 vectors (8-digit)', allHotp);
  check('totp() end-to-end matches RFC vectors (8- and 6-digit)', allTotp);
}

// ---- base32 round-trips ----
{
  check('base32 round-trips arbitrary bytes', (() => {
    for (const s of ['', 'f', 'fo', 'foo', 'foob', 'fooba', 'foobar']) {
      const b = Buffer.from(s);
      if (Buffer.compare(base32Decode(base32Encode(b)), b) !== 0) return false;
    }
    return true;
  })());
  check('base32Decode ignores spaces/hyphens', Buffer.compare(base32Decode('MFRGG ZDF-MZTWQ'), base32Decode('MFRGGZDFMZTWQ')) === 0);
  check('generateTotpSecret makes a 32-char base32 string (20 bytes)', /^[A-Z2-7]{32}$/.test(generateTotpSecret()));
}

// ---- verifyTotp: skew window + rejection ----
{
  const secret = generateTotpSecret();
  const now = 1_700_000_000_000;
  const good = totp(secret, { t: now });
  check('verifyTotp accepts the current code', verifyTotp(secret, good, { t: now }) === true);
  check('verifyTotp accepts a code from the previous step (±30s skew)', verifyTotp(secret, totp(secret, { t: now - 30_000 }), { t: now }) === true);
  check('verifyTotp accepts a code from the next step', verifyTotp(secret, totp(secret, { t: now + 30_000 }), { t: now }) === true);
  check('verifyTotp rejects a code two steps away (outside window)', verifyTotp(secret, totp(secret, { t: now + 90_000 }), { t: now }) === false);
  // The `|| good === '000000'` escape hatch that used to close this line meant
  // a verifyTotp that ACCEPTED EVERYTHING still passed whenever the real code
  // happened to be 000000. One in a million is not the problem — the problem is
  // that the assertion's truth no longer depended on the function under test.
  // A deterministically-wrong code removes the need for the escape hatch.
  const wrong = good === '000000' ? '111111' : '000000';
  check('verifyTotp rejects a wrong code', verifyTotp(secret, wrong, { t: now }) === false);
  check('verifyTotp rejects non-numeric / wrong length', !verifyTotp(secret, 'abcdef', { t: now }) && !verifyTotp(secret, '12345', { t: now }) && !verifyTotp(secret, '', { t: now }));
}

// ---- otpauth URI ----
{
  const uri = otpauthUri('JBSWY3DPEHPK3PXP', { label: 'admin@local', issuer: 'AstroBaaS' });
  check('otpauth URI is well-formed', uri.startsWith('otpauth://totp/AstroBaaS:admin%40local?') && /secret=JBSWY3DPEHPK3PXP/.test(uri) && /issuer=AstroBaaS/.test(uri) && /period=30/.test(uri) && /digits=6/.test(uri));
}

// ---- backup codes ----
{
  const { plain, hashed } = generateBackupCodes(10);
  check('generateBackupCodes makes 10 distinct codes + matching hashes', plain.length === 10 && hashed.length === 10 && new Set(plain).size === 10 && new Set(hashed).size === 10);
  check('backup codes look like xxxxx-xxxxx', plain.every((c) => /^[0-9a-f]{5}-[0-9a-f]{5}$/.test(c)));
  check('hashBackupCode is stable + case/hyphen-insensitive', hashBackupCode(plain[0]) === hashed[0] && hashBackupCode(plain[0].toUpperCase().replace('-', '')) === hashed[0]);
  const idx = matchBackupCode(plain[3], hashed);
  check('matchBackupCode finds the right index', idx === 3);
  // Same shape, and this one could essentially never fail: the second clause
  // ("that hash is not in the list") is true by construction for a code the
  // generator did not produce, so `matchBackupCode` returning 0 instead of -1
  // still passed. Pick a code PROVEN absent, then assert only the return value.
  let unknown = 'fffff-fffff';
  for (let i = 0; plain.includes(unknown); i += 1) unknown = `fffff-fff${String(i).padStart(2, '0')}`;
  check('the probe code really is not one of the generated ones', !plain.includes(unknown));
  check('matchBackupCode returns -1 for an unknown code', matchBackupCode(unknown, hashed) === -1);
  check('matchBackupCode rejects garbage', matchBackupCode('nope', hashed) === -1);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
