#!/usr/bin/env node
/**
 * SMTP2GO transport.
 *
 * The interesting failure here is silent: SMTP2GO answers HTTP 200 even when it
 * accepted nothing, so a transport that only checks `res.ok` drops mail without
 * an error anywhere. Password resets vanish and nobody finds out. Most of these
 * assertions exist for that.
 *
 * Run with:  node tests/smtp2go.test.mjs
 */
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cacheDir = path.join(here, '..', 'node_modules', '.cache');
await fs.mkdir(cacheDir, { recursive: true });

const out = path.join(cacheDir, `astrobaas-smtp2go-${process.pid}.mjs`);
await build({
  entryPoints: [path.join(here, '..', 'src/lib/email-smtp2go.ts')],
  bundle: true, format: 'esm', platform: 'node', packages: 'external',
  outfile: out, logLevel: 'silent',
});
const { smtp2goTransport, smtp2goFromEnv, SMTP2GO_ENV } = await import(pathToFileURL(out).href);
await fs.rm(out, { force: true });

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) pass++;
  else {
    fail++;
    console.error(`✗ ${name}`);
  }
}

/** A fake fetch that records the request and replays a canned response. */
function stub(status, body) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    };
  };
  return { calls, fetchImpl };
}

const msg = { to: 'buyer@example.com', subject: 'Your order', text: 'Thanks!', html: '<p>Thanks!</p>' };
const okBody = { data: { succeeded: 1, failed: 0 } };

/* ---- request shape ---- */
{
  const { calls, fetchImpl } = stub(200, okBody);
  const t = smtp2goTransport({ apiKey: 'api-KEY', sender: 'Shop <no-reply@example.com>', fetchImpl });
  await t.send(msg);

  const [call] = calls;
  const sent = JSON.parse(call.init.body);
  check('transport is named smtp2go', t.name === 'smtp2go');
  check('posts to the v3 send endpoint', /api\.smtp2go\.com\/v3\/email\/send$/.test(call.url) && call.init.method === 'POST');

  // The credential must travel in a header, not the payload: a body ends up in
  // request logs and error dumps far more readily than a header does.
  check('the API key is sent as a HEADER', call.init.headers['X-Smtp2go-Api-Key'] === 'api-KEY');
  check('the API key is NOT in the request body', !JSON.stringify(sent).includes('api-KEY'));

  check('sender comes from config, never from the message', sent.sender === 'Shop <no-reply@example.com>');
  check('recipient is sent as an array', Array.isArray(sent.to) && sent.to[0] === 'buyer@example.com');
  check('subject and text map to the API fields', sent.subject === 'Your order' && sent.text_body === 'Thanks!');
  check('html is included when present', sent.html_body === '<p>Thanks!</p>');
}

{
  const { calls, fetchImpl } = stub(200, okBody);
  await smtp2goTransport({ apiKey: 'k', sender: 's', fetchImpl }).send({ to: 'a@b.c', subject: 's', text: 't' });
  check('html_body is omitted entirely when there is no html', !('html_body' in JSON.parse(calls[0].init.body)));
}

/* ---- THE failure mode: 200 that sent nothing ---- */
{
  const cases = [
    ['succeeded 0', { data: { succeeded: 0, failed: 1, failures: ['bad recipient'] } }],
    ['failed > 0', { data: { succeeded: 1, failed: 1, failures: ['one bounced'] } }],
    ['empty data', { data: {} }],
    ['no body at all', null],
  ];
  for (const [label, body] of cases) {
    const { fetchImpl } = stub(200, body);
    const t = smtp2goTransport({ apiKey: 'k', sender: 's', fetchImpl });
    let threw = false;
    try {
      await t.send(msg);
    } catch {
      threw = true;
    }
    check(`HTTP 200 with ${label} still THROWS (mail must not be silently dropped)`, threw);
  }
}

{
  const { fetchImpl } = stub(200, { data: { succeeded: 1, failed: 0 } });
  let threw = false;
  try {
    await smtp2goTransport({ apiKey: 'k', sender: 's', fetchImpl }).send(msg);
  } catch {
    threw = true;
  }
  check('a genuine success does NOT throw', !threw);
}

/* ---- HTTP-level failures ---- */
{
  const SECRET_KEY = 'api-SUPERSECRET123';
  const { fetchImpl } = stub(401, { data: { error: 'invalid api key' } });
  let message = '';
  try {
    await smtp2goTransport({ apiKey: SECRET_KEY, sender: 's', fetchImpl }).send(msg);
  } catch (err) {
    message = String(err.message);
  }
  check('a 401 throws', message.length > 0);
  check("the error surfaces the provider's reason", /invalid api key/.test(message));
  // Errors get logged. This one must carry neither the credential nor the
  // recipient's address into the log.
  check('the thrown error does not contain the API key', !message.includes(SECRET_KEY));
  check('the thrown error does not contain the recipient address', !message.includes('buyer@example.com'));
}

/* ---- env wiring ---- */
{
  check('the required env vars are declared',
    SMTP2GO_ENV.includes('SMTP2GO_API_KEY') && SMTP2GO_ENV.includes('SMTP2GO_SENDER'));

  const good = smtp2goFromEnv({ SMTP2GO_API_KEY: 'api-x', SMTP2GO_SENDER: 'a@b.c' });
  check('a complete environment builds a transport', good.ok === true && good.transport.name === 'smtp2go');

  const none = smtp2goFromEnv({});
  check('an empty environment reports BOTH missing names', !none.ok && none.missing.length === 2);

  const partial = smtp2goFromEnv({ SMTP2GO_API_KEY: 'api-x' });
  check('a half-configured environment is refused, naming what is missing',
    !partial.ok && partial.missing.includes('SMTP2GO_SENDER') && !partial.missing.includes('SMTP2GO_API_KEY'));

  const blank = smtp2goFromEnv({ SMTP2GO_API_KEY: '   ', SMTP2GO_SENDER: 'a@b.c' });
  check('a whitespace-only credential counts as missing, not as configured',
    !blank.ok && blank.missing.includes('SMTP2GO_API_KEY'));

  const padded = smtp2goFromEnv({ SMTP2GO_API_KEY: '  api-x  ', SMTP2GO_SENDER: '  a@b.c ' });
  check('surrounding whitespace is trimmed rather than sent', padded.ok === true);
}

/* ---- headers: Reply-To and List-Unsubscribe reach the API ---- */
{
  // This transport used to send NO headers, so a Reply-To configured for the
  // site silently vanished here, and a campaign lost its List-Unsubscribe.
  // SMTP2GO's API has no Reply-To field; `custom_headers` is how it is set.
  const { calls, fetchImpl } = stub(200, okBody);
  await smtp2goTransport({ apiKey: 'k', sender: 's', fetchImpl }).send({
    to: 'a@b.c', subject: 's', text: 't',
    replyTo: 'Εξυπηρέτηση <info@example.gr>',
    headers: {
      'List-Unsubscribe': '<https://example.gr/u>',
      'Reply-To': 'attacker@evil.example',
      'X-Ok': 'one\r\nInjected: two',
    },
  });
  const custom = JSON.parse(calls[0].init.body).custom_headers ?? [];
  const find = (n) => custom.filter((h) => h.header.toLowerCase() === n.toLowerCase());
  check('custom_headers is an array of { header, value }',
    Array.isArray(custom) && custom.every((h) => typeof h.header === 'string' && typeof h.value === 'string'));
  check('Reply-To is sent', find('Reply-To').length === 1);
  // A Greek name this long is FOLDED by the encoder — CRLF plus a space — which
  // belongs in a raw message and nowhere in a JSON header value.
  check('...on one line, even for a long encoded name', await (async () => {
    const { calls: c2, fetchImpl: f2 } = stub(200, okBody);
    await smtp2goTransport({ apiKey: 'k', sender: 's', fetchImpl: f2 }).send({
      to: 'a@b.c', subject: 's', text: 't', replyTo: 'Τμήμα Εξυπηρέτησης Πελατών Οπτικών <info@example.gr>' });
    const v = (JSON.parse(c2[0].init.body).custom_headers ?? []).find((h) => h.header === 'Reply-To')?.value ?? '';
    return v.endsWith(' <info@example.gr>') && !/[\r\n]/.test(v) && v.includes('=?UTF-8?B?');
  })());
  check('...from the field, with only the name encoded', find('Reply-To')[0]?.value.endsWith(' <info@example.gr>'));
  check('...and a Reply-To smuggled in `headers` is dropped', !JSON.stringify(custom).includes('attacker@evil.example'));
  check('List-Unsubscribe is sent', find('List-Unsubscribe')[0]?.value === '<https://example.gr/u>');
  check('a CRLF in a header value is flattened', !/[\r\n]/.test(find('X-Ok')[0]?.value ?? '\n'));

  // No headers: the request is exactly what it always was.
  const plain = stub(200, okBody);
  await smtp2goTransport({ apiKey: 'k', sender: 's', fetchImpl: plain.fetchImpl }).send({ to: 'a@b.c', subject: 's', text: 't' });
  check('custom_headers is omitted when there is nothing to send', !('custom_headers' in JSON.parse(plain.calls[0].init.body)));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
