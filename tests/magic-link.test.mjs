#!/usr/bin/env node
/**
 * Magic-link tokens + the email-channel gate (src/lib/auth.ts, src/lib/email.ts).
 *
 * The token is a bearer credential in an inbox, so the properties under test
 * are its bindings: purpose (no other signed token may pass), expiry, and
 * session_version. The gate's property is honesty: "console" is not an email
 * channel, and a webhook with no URL silently IS console.
 *
 * Run with:  node tests/magic-link.test.mjs
 */
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cacheDir = path.join(here, '..', 'node_modules', '.cache');
await fs.mkdir(cacheDir, { recursive: true });

const entry = path.join(cacheDir, `astrobaas-magic-entry-${process.pid}.ts`);
const outFile = path.join(cacheDir, `astrobaas-magic-${process.pid}.mjs`);
const root = path.join(here, '..');
await fs.writeFile(entry, [
  `export { makeMagicLinkToken, verifyMagicLinkToken, signPurposeToken, signPending2fa, makeResetToken } from ${JSON.stringify(path.join(root, 'src/lib/auth.ts'))};`,
  `export * from ${JSON.stringify(path.join(root, 'src/lib/email.ts'))};`,
].join('\n'));
await build({
  entryPoints: [entry], bundle: true, format: 'esm', platform: 'node',
  packages: 'external', outfile: outFile, logLevel: 'silent',
});
const M = await import(pathToFileURL(outFile).href);
await fs.rm(entry, { force: true });
await fs.rm(outFile, { force: true });

let pass = 0;
let fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };

/* ---- the token and its bindings ---- */
{
  const user = { id: 'u1', session_version: 3 };
  const token = M.makeMagicLinkToken(user);
  const p = M.verifyMagicLinkToken(token);
  check('roundtrip: uid, sv and a jti come back',
    p && p.uid === 'u1' && p.sv === 3 && typeof p.jti === 'string' && p.jti.length > 8);

  check('two tokens for the same user differ (random jti)',
    M.makeMagicLinkToken(user) !== M.makeMagicLinkToken(user));

  check('missing session_version binds to 0',
    M.verifyMagicLinkToken(M.makeMagicLinkToken({ id: 'u2' }))?.sv === 0);

  const tampered = token.slice(0, 6) + (token[6] === 'A' ? 'B' : 'A') + token.slice(7);
  check('a tampered token dies on the signature', M.verifyMagicLinkToken(tampered) === null);

  check('expired dies', M.verifyMagicLinkToken(
    M.signPurposeToken('magic', { uid: 'u1', sv: 0, jti: 'x' }, -1000),
  ) === null);

  check('garbage inputs are null, never throws',
    M.verifyMagicLinkToken(null) === null
    && M.verifyMagicLinkToken('') === null
    && M.verifyMagicLinkToken('a.b.c') === null
    && M.verifyMagicLinkToken('x'.repeat(5000)) === null);

  // Purpose confusion, both directions: nothing else this process signs may
  // sign someone in, and a magic token must not pass other verifiers.
  check('a pending-2FA token is not a magic link',
    M.verifyMagicLinkToken(M.signPending2fa('u1')) === null);
  check('a reset token is not a magic link',
    M.verifyMagicLinkToken(M.makeResetToken({ id: 'u1', password_salt: 'salt', password_hash: 'h' })) === null);
  check('a token signed for another purpose with the SAME payload shape is refused',
    M.verifyMagicLinkToken(M.signPurposeToken('pow', { uid: 'u1', sv: 0, jti: 'x' }, 60000)) === null);
}

/* ---- the email-channel gate ---- */
{
  delete process.env.EMAIL_TRANSPORT;
  delete process.env.EMAIL_WEBHOOK_URL;
  check('console default is NOT an active channel', M.emailChannelActive() === false);

  process.env.EMAIL_TRANSPORT = 'webhook';
  check('webhook with no URL falls back to console → not active', M.emailChannelActive() === false);

  process.env.EMAIL_WEBHOOK_URL = 'https://mail.example/hook';
  check('webhook with a URL IS active', M.emailChannelActive() === true);
  delete process.env.EMAIL_TRANSPORT;
  delete process.env.EMAIL_WEBHOOK_URL;

  const sent = [];
  M.setEmailTransport({ name: 'fake', async send(msg) { sent.push(msg); } });
  check('an injected transport (the plugin path) is active', M.emailChannelActive() === true);

  await M.sendEmail({ to: 'a@b.c', subject: 's', text: 't' });
  const last = M.lastSendOutcome();
  check('a successful send is recorded', last && last.ok === true && last.transport === 'fake' && sent.length === 1);

  M.setEmailTransport({ name: 'broken', async send() { throw new Error('smtp exploded'); } });
  let threw = false;
  try { await M.sendEmail({ to: 'a@b.c', subject: 's', text: 't' }); } catch { threw = true; }
  const failedLast = M.lastSendOutcome();
  check('a failed send is recorded AND still thrown',
    threw && failedLast && failedLast.ok === false && failedLast.error === 'smtp exploded');
  check('the failure record names no recipient',
    !JSON.stringify(failedLast).includes('a@b.c'));

  M.setEmailTransport(null);
  check('reverting the override closes the gate again', M.emailChannelActive() === false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
