#!/usr/bin/env node
/**
 * The deep health check WARNS when payment return URLs would land on the CMS.
 *
 * ## Why (S4.17)
 *
 * Stripe, PayPal and Klarna send the buyer back to
 * `<site>/checkout/success?order=…`. `<site>` is the Site URL setting, then
 * SITE_URL, then — only if neither is set — the address the request came in
 * on. This CMS serves no /checkout/success page: the storefront does. So a
 * headless shop with Site URL empty, or with Site URL set to the CMS's own
 * address, sends every paying buyer to a 404 — after they have paid.
 *
 * Nothing about that is a failure of the CMS itself, so it is a WARNING, never
 * a fail: /api/health/deep must keep answering 200 for it.
 *
 * Asserted against the real route handler (one bundle, a lowdb database per
 * state) and against the pure verdict.
 *
 * Run with:  node tests/payment-return-url.test.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, loadTs } from './lib/load.mjs';

const TOKEN = 'return-url-health-token-0123456789abcdef';
const j = JSON.stringify;

/* ---------------------------------------------------------------- child --- */
if (process.env.RETURN_URL_CHILD) {
  const M = await loadTs('tests/fixtures/health-entry.ts', 'returnurl');
  await M.LocalDB.init();
  const settings = JSON.parse(process.env.RETURN_URL_SETTINGS || '{}');
  for (const [k, v] of Object.entries(settings)) await M.LocalDB.updateSetting(k, v);
  // A settings read that fails: the other checks may fail on it, but this one
  // is advice and must stay a warning.
  if (process.env.RETURN_URL_BREAK) {
    M.LocalDB.getSettings = async () => { throw new Error('settings unavailable'); };
  }
  const res = await M.deepHealth({
    request: new Request('https://cms.example.com/api/health/deep?write=0', {
      headers: { authorization: `Bearer ${TOKEN}` },
    }),
    locals: { user: null },
    url: new URL('https://cms.example.com/api/health/deep?write=0'),
    site: undefined,
  });
  const body = await res.json().catch(() => null);
  const check = body?.checks?.find((c) => c.name === 'payment_return_urls') ?? null;
  console.log('__RESULT__' + JSON.stringify({
    code: res.status, check, failed: body?.failed ?? null, warnings: body?.warnings ?? null,
  }));
  process.exit(0);
}

/* --------------------------------------------------------------- parent --- */
let pass = 0;
let fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };

const tmpRoot = path.join(os.tmpdir(), `astrobaas-return-url-${process.pid}`);
await fs.mkdir(tmpRoot, { recursive: true });
let n = 0;

function probe({ settings = {}, env = {} } = {}) {
  const dir = path.join(tmpRoot, `s${++n}`);
  return fs.mkdir(path.join(dir, 'uploads'), { recursive: true }).then(() => {
    const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env, RETURN_URL_CHILD: '1', NODE_ENV: 'test',
        AUTH_SECRET: 'return-url-secret-0123456789abcdef', HEALTH_TOKEN: TOKEN,
        DB_PATH: path.join(dir, 'db.json'), UPLOADS_DIR: path.join(dir, 'uploads'),
        DATABASE_URL: '', DATABASE_DRIVER: '', SITE_URL: '',
        PAYMENTS_ENABLED: '', STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: '',
        RETURN_URL_SETTINGS: JSON.stringify(settings),
        ...env,
      },
    });
    const line = (run.stdout || '').split('\n').find((l) => l.startsWith('__RESULT__'));
    if (!line) {
      check(`child produced no result\n${(run.stderr || '').slice(-1500)}`, false);
      return null;
    }
    return JSON.parse(line.slice('__RESULT__'.length));
  });
}

const STRIPE = { PAYMENTS_ENABLED: 'stripe', STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_x' };
const neverFails = (r) => r && !(r.failed ?? []).includes('payment_return_urls') && r.check?.status !== 'fail';

// 1. A shop taking card payments with no Site URL at all.
{
  const r = await probe({ env: STRIPE });
  check(`the deep check reports payment return URLs (${j(r?.check)})`, !!r?.check);
  check(`no Site URL with an online provider on → WARN (${r?.check?.status})`, r?.check?.status === 'warn');
  check(`...listed among the warnings, never the failures (${j(r?.warnings)})`,
    (r?.warnings ?? []).includes('payment_return_urls') && neverFails(r));
  check(`...and the detail says what to do (${r?.check?.detail})`, /Site URL/i.test(r?.check?.detail ?? '') && /storefront/i.test(r?.check?.detail ?? ''));
}

// 2. Site URL set to the CMS's own address (the public_site_url).
{
  const r = await probe({
    env: STRIPE,
    settings: { site_url: 'https://cms.example.com/', public_site_url: 'https://cms.example.com' },
  });
  check(`Site URL equal to the CMS address → WARN (${r?.check?.status}: ${r?.check?.detail})`,
    r?.check?.status === 'warn' && /CMS/.test(r?.check?.detail ?? '') && neverFails(r));
}

// 3. Site URL on the host this request reached, with public_site_url unset.
{
  const r = await probe({ env: STRIPE, settings: { site_url: 'https://cms.example.com' } });
  check(`Site URL equal to the address the CMS answers on → WARN (${r?.check?.status})`,
    r?.check?.status === 'warn' && neverFails(r));
}

// 4. SITE_URL pointing at the CMS, setting empty.
{
  const r = await probe({ env: { ...STRIPE, SITE_URL: 'https://cms.example.com' }, settings: { public_site_url: 'https://cms.example.com' } });
  check(`SITE_URL pointing at the CMS, no setting → WARN (${r?.check?.status})`,
    r?.check?.status === 'warn' && /SITE_URL/.test(r?.check?.detail ?? '') && neverFails(r));
}

// 5. The storefront configured: no warning.
{
  const r = await probe({
    env: STRIPE,
    settings: { site_url: 'https://shop.example.com', public_site_url: 'https://cms.example.com' },
  });
  check(`Site URL = the storefront → OK (${r?.check?.status}: ${r?.check?.detail})`,
    r?.check?.status === 'ok' && !(r?.warnings ?? []).includes('payment_return_urls'));
  check(`...and the check says where buyers go (${j(r?.check?.data)})`, r?.check?.data?.return_base === 'https://shop.example.com');
}

// 6. No online provider: return URLs are never used, so nothing to warn about.
{
  const r = await probe({ settings: {} });
  check(`no online provider → OK, whatever Site URL is (${r?.check?.status})`,
    r?.check?.status === 'ok' && !(r?.warnings ?? []).includes('payment_return_urls'));
}

// 7. Setting empty, SITE_URL set to what may well be the storefront: still a
//    warning — nothing says it is, and a redeploy with another environment
//    would silently change where buyers go.
{
  const r = await probe({ env: { ...STRIPE, SITE_URL: 'https://shop.example.com' }, settings: { public_site_url: 'https://cms.example.com' } });
  check(`Site URL empty with SITE_URL set elsewhere → still WARN (${r?.check?.status})`,
    r?.check?.status === 'warn' && neverFails(r) && r?.check?.data?.return_base === 'https://shop.example.com');
}

// 8. The settings cannot be read: this check warns, it does not fail.
{
  const r = await probe({ env: { ...STRIPE, RETURN_URL_BREAK: '1' } });
  check(`a settings failure leaves this check a WARNING, not a failure (${j(r?.check)})`,
    r?.check?.status === 'warn' && !(r?.failed ?? []).includes('payment_return_urls'));
}

/* ---- the pure verdict ---- */
try {
  const V = await loadTs('src/lib/payments/return-url-check.ts');
  const v = (f) => V.returnUrlVerdict({ onlineProviders: ['stripe'], ...f });
  check('pure: never "fail", for any input',
    [{}, { siteUrlSetting: 'nope' }, { siteUrlSetting: 42 }, { publicSiteUrl: {} }, { onlineProviders: [] }]
      .every((f) => ['ok', 'warn'].includes(v(f).status)));
  check('pure: an unusable Site URL is treated as unset → warn', v({ siteUrlSetting: 'shop.example.com' }).status === 'warn');
  check('pure: the CMS match is by ORIGIN — a path on the CMS host still warns',
    v({ siteUrlSetting: 'https://cms.example.com/shop', publicSiteUrl: 'https://cms.example.com' }).status === 'warn');
  check('pure: a different host is fine',
    v({ siteUrlSetting: 'https://www.example.com', publicSiteUrl: 'https://cms.example.com', requestOrigin: 'https://cms.example.com' }).status === 'ok');
  check('pure: a different scheme on the same host is still the CMS',
    v({ siteUrlSetting: 'http://cms.example.com', publicSiteUrl: 'https://cms.example.com' }).status === 'warn');
  check('pure: no setting but a storefront SITE_URL still warns', v({ siteUrlEnv: 'https://shop.example.com' }).status === 'warn');
  check('pure: no online provider is ok even with nothing set', v({ onlineProviders: [] }).status === 'ok');
  check('pure: the setting wins over SITE_URL',
    v({ siteUrlSetting: 'https://shop.example.com', siteUrlEnv: 'https://cms.example.com', publicSiteUrl: 'https://cms.example.com' }).status === 'ok');
} catch (err) {
  check(`pure verdict module (threw: ${String(err?.message || err).slice(0, 200)})`, false);
}

await fs.rm(tmpRoot, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
