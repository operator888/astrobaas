#!/usr/bin/env node
/**
 * Maintenance mode.
 *
 * Two of these rules exist because getting them wrong is expensive in a way
 * that is not obvious:
 *
 *   1. The page answers 503, never 200. A 200 tells a crawler this IS the
 *      content now; sites have lost rankings to a maintenance notice served
 *      with a success status.
 *   2. /admin and /api/auth stay open. An operator locked out of the admin
 *      cannot turn maintenance OFF, and the only way back is a redeploy.
 *
 * Run with:  node tests/maintenance.test.mjs
 */
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cacheDir = path.join(here, '..', 'node_modules', '.cache');
await fs.mkdir(cacheDir, { recursive: true });
const out = path.join(cacheDir, `astrobaas-maint-${process.pid}.mjs`);
await build({
  entryPoints: [path.join(here, '..', 'src/lib/maintenance.ts')],
  bundle: true, format: 'esm', platform: 'node', packages: 'external',
  outfile: out, logLevel: 'silent',
});
const M = await import(pathToFileURL(out).href);
await fs.rm(out, { force: true });

const {
  envFlagOn, retryAfterFor, resolveMaintenance, isAlwaysOpen,
  canPreviewDuringMaintenance, shouldHoldRequest, maintenanceHtml,
  maintenanceResponse, maintenanceApiResponse, MAINTENANCE_KEYS, DEFAULT_RETRY_AFTER,
} = M;

let pass = 0, fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };

const NOW = Date.parse('2026-08-25T12:00:00.000Z');
const K = MAINTENANCE_KEYS;

/* ---------------- the switch ---------------- */
{
  for (const on of ['1', 'true', 'on', 'yes', 'TRUE', ' On ']) {
    check(`"${on}" switches it on`, envFlagOn(on));
  }
  for (const off of ['0', 'false', 'off', 'no', '', '  ', undefined, null, 'maybe', '2']) {
    check(`${JSON.stringify(off) ?? 'undefined'} does not`, !envFlagOn(off));
  }

  check('off by default', !resolveMaintenance({}, null, NOW).active);
  check('the env var switches it on', resolveMaintenance({ MAINTENANCE_MODE: '1' }, null, NOW).active);
  check('so does the setting', resolveMaintenance({}, { [K.enabled]: true }, NOW).active);
  // THE ASSERTION THAT USED TO ENSHRINE THE BUG.
  //
  // It read "a truthy-but-not-true setting value does not [close the shop]",
  // pinning `'yes'` as inert. That sounds strict and was the defect: the
  // settings API stores whatever JSON a caller sends, so an operator who closed
  // the shop by script held the STRING "true" — and `"true" === true` is false,
  // so the shop stayed OPEN while every readback said closed. `envFlagOn` two
  // functions above already accepted this vocabulary; only the setting did not.
  check('the STRING "true" closes the shop, which is what an API caller stores',
    resolveMaintenance({}, { [K.enabled]: 'true' }, NOW).active);
  check('...and so does every other affirmative the rest of the product accepts',
    resolveMaintenance({}, { [K.enabled]: 'yes' }, NOW).active
    && resolveMaintenance({}, { [K.enabled]: '1' }, NOW).active
    && resolveMaintenance({}, { [K.enabled]: 'on' }, NOW).active);
  check('the STRING "false" leaves it open — the other half of the same bug',
    !resolveMaintenance({}, { [K.enabled]: 'false' }, NOW).active
    && !resolveMaintenance({}, { [K.enabled]: '0' }, NOW).active);
  check('genuine nonsense still does not close the shop',
    !resolveMaintenance({}, { [K.enabled]: 'maybe' }, NOW).active);
  check('null settings are survivable', !resolveMaintenance({}, null, NOW).active);

  // The env var is the emergency switch: it must win even if the database says
  // otherwise, because the database may be the reason it was thrown.
  check('the env var wins over a settings value of false',
    resolveMaintenance({ MAINTENANCE_MODE: '1' }, { [K.enabled]: false }, NOW).active);
}

/* ---------------- the message ---------------- */
{
  const dflt = resolveMaintenance({ MAINTENANCE_MODE: '1' }, null, NOW);
  check('there is always a message', dflt.message.length > 10);

  check('the setting supplies one',
    resolveMaintenance({}, { [K.enabled]: true, [K.message]: 'Upgrading the shop' }, NOW)
      .message === 'Upgrading the shop');
  // Mid-incident, an operator must be able to say something specific without a
  // database that may be the problem.
  check('the env var overrides the setting',
    resolveMaintenance({ MAINTENANCE_MODE: '1', MAINTENANCE_MESSAGE: 'from env' },
      { [K.enabled]: true, [K.message]: 'from db' }, NOW).message === 'from env');
  check('a blank env message falls back',
    resolveMaintenance({ MAINTENANCE_MODE: '1', MAINTENANCE_MESSAGE: '   ' },
      { [K.message]: 'from db' }, NOW).message === 'from db');
  check('the message is length-capped',
    resolveMaintenance({ MAINTENANCE_MODE: '1', MAINTENANCE_MESSAGE: 'x'.repeat(2000) }, null, NOW)
      .message.length === 500);
}

/* ---------------- Retry-After ---------------- */
{
  check('no end time gives the default', retryAfterFor(undefined, NOW) === DEFAULT_RETRY_AFTER);
  check('junk gives the default', retryAfterFor('not a date', NOW) === DEFAULT_RETRY_AFTER);
  check('a future time is counted', retryAfterFor('2026-08-25T12:10:00.000Z', NOW) === 600);

  // Bounded at both ends. A Retry-After of 0 invites every client to retry at
  // once, precisely when the server can least take it.
  check('a past time still yields a floor', retryAfterFor('2026-08-25T11:00:00.000Z', NOW) === 30);
  check('a very near time is floored', retryAfterFor('2026-08-25T12:00:05.000Z', NOW) === 30);
  // ...and a huge one would tell a crawler to stay away for a day.
  check('a far future time is capped at an hour',
    retryAfterFor('2027-01-01T00:00:00.000Z', NOW) === 3600);

  const s = resolveMaintenance({ MAINTENANCE_MODE: '1', MAINTENANCE_UNTIL: '2026-08-25T12:05:00.000Z' }, null, NOW);
  check('the state carries the end time', s.until === '2026-08-25T12:05:00.000Z');
  check('and the matching retry', s.retryAfter === 300);
  check('an unparseable end time is dropped, not shown',
    resolveMaintenance({ MAINTENANCE_MODE: '1', MAINTENANCE_UNTIL: 'soon' }, null, NOW).until === undefined);
}

/* ---------------- what stays reachable ---------------- */
{
  // Each of these is here because closing it breaks something worse than the
  // outage: the load balancer, or the way back in.
  for (const open of [
    '/healthz', '/readyz', '/metrics',
    '/admin', '/admin/settings', '/admin/plugins',
    '/login', '/logout', '/forgot-password', '/reset-password',
    '/api/auth/login', '/api/auth/me',
    '/_astro/app.js', '/favicon.ico',
  ]) {
    check(`${open} stays open`, isAlwaysOpen(open));
  }
  for (const closed of ['/', '/blog', '/products/x', '/api/products', '/api/orders', '/checkout']) {
    check(`${closed} is held`, !isAlwaysOpen(closed));
  }
  // A path that merely starts with the same letters must not sneak through.
  check('/administrator is not treated as /admin', !isAlwaysOpen('/administrators-blog-post'));
  check('/loginish is not treated as /login', !isAlwaysOpen('/logins-explained'));

  // S3.5: a payment that completed a minute before the window opened is still
  // being confirmed by the provider while it is open. A 503 there left the
  // order "pending" with the money taken until the provider's next retry.
  for (const hook of ['/api/payments/webhook/stripe', '/api/payments/webhook/paypal', '/api/payments/webhook/klarna', '/api/payments/webhook/test-gateway/']) {
    check(`${hook} stays open`, isAlwaysOpen(hook));
    check(`...and is not held even for an anonymous caller`,
      !shouldHoldRequest(resolveMaintenance({ MAINTENANCE_MODE: '1' }, null, NOW), hook, undefined));
  }
  // ...and ONLY the webhooks: the rest of payments is the shop, and stays shut.
  check('/api/payments/start is still held', !isAlwaysOpen('/api/payments/start'));
  check('/api/payments is still held', !isAlwaysOpen('/api/payments'));
  check('a lookalike prefix is still held', !isAlwaysOpen('/api/payments/webhooks-log'));
}

/* ---------------- staff preview ---------------- */
{
  for (const r of ['admin', 'editor', 'author', 'manager']) {
    check(`${r} can preview`, canPreviewDuringMaintenance(r));
  }
  // `viewer` is not staff anywhere else in this codebase either.
  check('viewer cannot preview', !canPreviewDuringMaintenance('viewer'));
  check('anonymous cannot preview', !canPreviewDuringMaintenance(undefined));
}

/* ---------------- the decision ---------------- */
{
  const off = resolveMaintenance({}, null, NOW);
  const on = resolveMaintenance({ MAINTENANCE_MODE: '1' }, null, NOW);

  check('nothing is held when it is off', !shouldHoldRequest(off, '/', undefined));
  check('a public page is held', shouldHoldRequest(on, '/', undefined));
  check('an API call is held', shouldHoldRequest(on, '/api/products', undefined));
  check('the admin is never held', !shouldHoldRequest(on, '/admin', undefined));
  check('login is never held', !shouldHoldRequest(on, '/api/auth/login', undefined));
  check('health is never held', !shouldHoldRequest(on, '/healthz', undefined));
  check('staff see the real site', !shouldHoldRequest(on, '/', 'admin'));
  check('a viewer does not', shouldHoldRequest(on, '/', 'viewer'));
}

/* ---------------- the responses ---------------- */
{
  const state = resolveMaintenance(
    { MAINTENANCE_MODE: '1', MAINTENANCE_UNTIL: '2026-08-25T12:05:00.000Z' }, null, NOW,
  );

  const res = maintenanceResponse(state, 'Οπτική Γωνία');
  // THE assertion. A 200 tells a crawler the content has been replaced.
  check('the page is 503, not 200', res.status === 503);
  check('it carries Retry-After', res.headers.get('retry-after') === '300');
  // A cached maintenance page outlives the maintenance.
  check('it is never cached', /no-store/.test(res.headers.get('cache-control') ?? ''));
  check('it is HTML', (res.headers.get('content-type') ?? '').includes('text/html'));

  const api = maintenanceApiResponse(state);
  check('the API answer is 503 too', api.status === 503);
  check('it is JSON', (api.headers.get('content-type') ?? '').includes('application/json'));
  const body = JSON.parse(await api.text());
  check('with a machine-readable code', body.error.code === 'MAINTENANCE');
  check('and the retry instant', body.error.retry_at === '2026-08-25T12:05:00.000Z');
  check('and never success:true', body.success === false);

  const html = maintenanceHtml(state, 'My Shop');
  check('the title names the site', html.includes('My Shop'));
  check('the message is shown', html.includes(state.message));
  check('crawlers are told not to index it', html.includes('noindex'));
  // It must render when everything else is unavailable.
  check('no external stylesheet', !html.includes('<link'));
  check('no script at all', !html.includes('<script'));
  check('the CSS is inline', html.includes('<style>'));

  // The message and the site title are operator-supplied, and land in HTML.
  const nasty = maintenanceHtml(
    resolveMaintenance({ MAINTENANCE_MODE: '1', MAINTENANCE_MESSAGE: '<img src=x onerror=alert(1)>' }, null, NOW),
    '</title><script>alert(1)</script>',
  );
  check('a message cannot inject markup', !nasty.includes('<img src=x'));
  check('nor can the site title', !nasty.includes('<script>alert(1)</script>'));
  check('the escaped form is still readable', nasty.includes('&lt;img'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
