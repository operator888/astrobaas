/**
 * The mail test itself — see scripts/mail-test.mjs for what it does and why.
 *
 * It lives here, apart from its two launchers, because it has to run in two
 * places that have nothing in common:
 *
 *   a checkout          scripts/mail-test.mjs compiles this file on the fly
 *                       (esbuild, via lib/load-ts.mjs) and runs it — that is
 *                       `npm run mail:test`
 *   a built release     `npm run build` compiles it ahead of time into
 *                       dist/mail-test.mjs (scripts/build-mail-test.mjs), because
 *                       a deployed release has dist/, package.json and a
 *                       production node_modules, and no src/, no scripts/ and no
 *                       esbuild to compile anything with
 *
 * Not runnable as it stands: it imports the app's TypeScript by path, which
 * only a bundler resolves. Both launchers bundle it.
 *
 * `main` RETURNS the exit code rather than exiting, so a launcher can finish its
 * own clean-up first: load-ts.mjs deletes its compiled copy in a `finally` that
 * a `process.exit()` in here would skip.
 */
import fs from 'node:fs';
import os from 'node:os';
import process from 'node:process';
import {
  campaignsEnabled,
  deliverEmail,
  emailConfigProblem,
  getEmailTransport,
  resolveReplyTo,
} from '../../src/lib/email.ts';
import { isSendableAddress } from '../../src/lib/email-mime.ts';
import { resolveSmtpConfig } from '../../src/lib/email-smtp.ts';

const USAGE = [
  'Usage: npm run mail:test -- [--env-file=<path>] <recipient>      (in a checkout)',
  '       node dist/mail-test.mjs [--env-file=<path>] <recipient>   (in a built or deployed release)',
].join('\n');

/**
 * Would systemd and Node read this SMTP_PASS line differently?
 *
 * Measured: unquoted, systemd's EnvironmentFile drops a backslash and Node's
 * loader stops at a `#`; double-quoted, they disagree on escapes. Single-quoted,
 * both read it byte for byte. So anything else carrying one of those characters
 * means this test may pass with a password the service will not see — the
 * `535` that only happens in production.
 */
export function passwordQuotingRisk(fileText) {
  const line = fileText.split(/\r?\n/).find((l) => /^\s*(export\s+)?SMTP_PASS\s*=/.test(l));
  if (!line) return null;
  const value = line.slice(line.indexOf('=') + 1).trim();
  if (value === '' || /^'[^']*'$/.test(value)) return null;
  if (!/[#\\"'$`\s]/.test(value)) return null;
  return 'SMTP_PASS is not single-quoted and contains a character (# \\ " \' $ ` or a space) that systemd and '
    + 'Node read differently — this test may use a different password than the service does. '
    + "Write it as SMTP_PASS='…'.";
}

/** Run the test. Returns the process exit code: 0 only when the server accepted. */
export async function main(args) {
  const envFileArg = args.find((a) => a.startsWith('--env-file='));
  const positional = args.filter((a) => !a.startsWith('--'));

  if (args.includes('--help') || args.includes('-h') || positional.length !== 1) {
    console.error(USAGE);
    return 64;
  }
  const to = positional[0];

  if (envFileArg) {
    const file = envFileArg.slice('--env-file='.length);
    try {
      process.loadEnvFile(file);
    } catch (err) {
      console.error(`✗ could not read ${file}: ${err instanceof Error ? err.message : err}`);
      return 66;
    }
    try {
      const risk = passwordQuotingRisk(fs.readFileSync(file, 'utf8'));
      if (risk) console.warn(`! ${risk}\n`);
    } catch { /* already read once above; nothing more to say */ }
  }

  if (!isSendableAddress(to)) {
    console.error(`✗ not a usable recipient address: ${to}`);
    return 64;
  }

  const env = process.env;
  const kind = (env.EMAIL_TRANSPORT || 'console').toLowerCase();
  const replyTo = resolveReplyTo(env);

  // What is configured, as the app reads it. The password is only ever reported
  // as present or absent.
  console.log('Mail configuration');
  console.log(`  transport       ${kind}`);
  if (kind === 'smtp') {
    const secure = /^(1|true|yes)$/i.test((env.SMTP_SECURE || '').trim());
    console.log(`  server          ${env.SMTP_HOST || '(SMTP_HOST not set)'}:${env.SMTP_PORT || (secure ? 465 : 587)}`
      + ` (${secure ? 'implicit TLS' : 'STARTTLS'})`);
    console.log(`  user            ${env.SMTP_USER || '(none — no authentication)'}`);
    console.log(`  password        ${env.SMTP_PASS ? 'set (not shown)' : 'NOT SET'}`);
    // The RESOLVED values — defaults applied — so what is printed is what the
    // server will do, not what the file happens to say.
    const cfg = resolveSmtpConfig(env);
    if (!('error' in cfg)) {
      console.log(`  timeout         ${cfg.timeoutMs} ms per network wait, ${cfg.timeoutMs * 3} ms per attempt`);
      console.log(`  retries         ${cfg.retries}${env.SMTP_RETRIES ? '' : ' (default)'}`);
      console.log(`  HELO name       ${cfg.heloName}${env.SMTP_HELO_NAME ? '' : ' (default)'}`);
    }
  }
  console.log(`  from            ${env.EMAIL_FROM || '(EMAIL_FROM not set)'}`);
  console.log(`  reply-to        ${'error' in replyTo ? `INVALID — ${replyTo.error}; mail goes WITHOUT a Reply-To` : (replyTo.replyTo ?? '(none)')}`);
  console.log(`  campaigns       ${campaignsEnabled(env) ? 'allowed' : 'off (EMAIL_CAMPAIGNS=0; bulk mail refused)'}`);
  console.log('');

  // A console transport "succeeds" by printing, so a green result from it would
  // be a lie. Say why nothing real is configured and stop.
  const transport = getEmailTransport(env);
  if (transport.name === 'console') {
    const problem = emailConfigProblem(env);
    console.error(problem
      ? `✗ mail is not configured: ${problem}`
      : '✗ no mail transport is configured (EMAIL_TRANSPORT is unset or "console"), so nothing would be sent.');
    return 2;
  }

  const now = new Date();
  const msg = {
    to,
    subject: 'AstroBaaS mail test',
    category: 'transactional',
    text: [
      'This is a test message from AstroBaaS, sent by its mail test',
      '(`npm run mail:test` in a checkout, `node dist/mail-test.mjs` in a release).',
      '',
      `Sent:      ${now.toISOString()}`,
      `From host: ${os.hostname()}`,
      `Transport: ${transport.name}${kind === 'smtp' ? ` via ${env.SMTP_HOST}` : ''}`,
      '',
      'If you can read this, outbound mail from this install works.',
      ...('replyTo' in replyTo && replyTo.replyTo
        ? ['', `Replying to it should go to ${replyTo.replyTo} — check that too.`]
        : []),
    ].join('\n'),
  };

  console.log(`Sending to ${to} …`);
  console.log('');
  try {
    const result = await deliverEmail(msg, {
      record: false,
      onTranscript: (line) => console.log(`  ${line}`),
    });
    console.log('');
    if (result?.response) {
      console.log(`✓ accepted by the server: ${result.response}`);
      if (result.attempts && result.attempts > 1) console.log(`  (after ${result.attempts} attempts)`);
    } else {
      // webhook and plugin transports have no protocol reply to show.
      console.log(`✓ handed to the ${transport.name} transport without error (it reports no server reply).`);
    }
    console.log('  Acceptance is not delivery: check the inbox, and the spam folder.');
    return 0;
  } catch (err) {
    console.log('');
    console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
