#!/usr/bin/env node
/**
 * EU reverse charge at CHECKOUT, the TAX_ID_VERDICT seam, and host.createStore.
 *
 * The bug this file exists for: `placeOrder` and `POST /api/orders/quote` called
 * `priceBasket` without the buyer's VAT id, so `resolveTaxTreatment` never saw
 * one and the core's own reverse charge could not apply to a real order — a
 * German business buying from a Greek shop was charged German VAT it does not
 * owe, by the quote and by the order alike.
 *
 * Everything runs once per storage driver in a child process with its own
 * database, through the REAL route handlers: the response a storefront gets
 * and the order read back from storage are the contract.
 *
 *  R1  a cross-border EU B2B buyer (billing tax_id) pays 0 VAT — order AND quote
 *  R2  the same buyer without a tax id pays the destination's VAT
 *  R3  the delivery address's tax_id is the fallback when billing has none
 *  R4  reverse charge switched OFF: the tax id changes nothing (conditions kept)
 *  R5  a Greek EL… number from a German shop is reverse-charged (EL == GR)
 *  R6  TAX_ID_VERDICT: verified → 0; invalid / unverified → VAT charged; none refuses
 *  R7  unverified + no destination rate on file is NEVER a refusal
 *  R8  the verdict is asked with the id, the billing-country hint and the settings
 *  R9  a malformed address on a quote is ignored, not refused
 *  R10 host.createStore: a namespaced store outside a route, the same records
 *      ctx.store and migrations see; an "@scope/name" id is refused at the call
 *
 * Run with:  node tests/reverse-charge-checkout.test.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, loadTs } from './lib/load.mjs';

const SECRET = 'reverse-charge-secret-0123456789abcdef';

/* ---------------------------------------------------------------- child --- */

async function child(M) {
  const { LocalDB, pluginManager, PLUGIN_HOOKS } = M;
  const out = {};
  const guard = async (key, fn) => {
    try { out[key] = await fn(); } catch (err) { out[key] = { error: String(err?.stack || err).slice(0, 600) }; }
  };
  let seq = 0;
  const product = () => LocalDB.createProduct({
    status: 'active', price_cents: 10000, categories: [], images: [], on_sale: false,
    name: `rc-${++seq}`, slug: `rc-${seq}`, stock: 100, in_stock: true, requires_shipping: false,
  });
  const setting = (k, v) => LocalDB.updateSetting(k, v);
  let ipSeq = 0;
  const nextIp = () => `100.65.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`;
  const call = async (handler, url, body) => {
    const res = await handler({
      request: new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      locals: { user: null, ip: nextIp() },
      url: new URL(url),
      params: {},
    });
    const json = await res.json().catch(() => null);
    return { code: res.status, data: json?.data, error: json?.error ?? null };
  };
  let mail = 0;
  const buyer = () => `rc${++mail}@example.com`;

  // A Greek shop, OSS destination mode, reverse charge ON, prices NET so the
  // VAT figure is easy to read: 10000 net at DE 19% is 1900.
  const shop = async (over = {}) => {
    const base = {
      tax_enabled: true, shop_country: 'GR', tax_destination_mode: 'oss',
      tax_reverse_charge_enabled: true, tax_prices_include_tax: false,
      tax_rates: [
        { class: 'standard', label: 'Standard', rate_bp: 2400 },
        { class: 'standard', label: 'DE', rate_bp: 1900, country: 'DE' },
        { class: 'standard', label: 'GR', rate_bp: 2400, country: 'GR' },
      ],
      ...over,
    };
    for (const [k, v] of Object.entries(base)) await setting(k, v);
  };
  const p = await product();
  const items = [{ product_id: p.id, qty: 1 }];

  const place = async (extra) => {
    const r = await call(M.postOrder, 'http://localhost/api/orders', { items, email: buyer(), name: 'B2B Buyer', ...extra });
    const number = r.data?.order?.number ?? r.data?.number;
    const stored = number ? (await LocalDB.getOrders()).find((o) => o.number === number) : undefined;
    return {
      code: r.code, err: r.error?.message ?? null,
      tax: stored?.tax_cents ?? null,
      treatment: stored?.line_totals?.[0]?.tax_treatment ?? null,
      billingTaxId: stored?.billing_address?.tax_id ?? null,
    };
  };
  const quote = async (extra) => {
    const r = await call(M.postQuote, 'http://localhost/api/orders/quote', { items, ...extra });
    return { code: r.code, tax: r.data?.tax_cents ?? null, treatment: r.data?.lines?.[0]?.tax_treatment ?? null, err: r.error?.message ?? null };
  };
  const de = (tax_id) => ({ country: 'DE', line1: 'Hauptstr. 1', city: 'Berlin', postcode: '10115', ...(tax_id ? { tax_id } : {}) });

  await guard('core', async () => {
    await shop();
    const r = {};
    // R1
    r.b2bOrder = await place({ shipping_address: de(), billing_address: de('DE123456789') });
    r.b2bQuote = await quote({ shipping_country: 'DE', billing_address: de('DE123456789') });
    r.b2bQuoteStructured = await quote({ shipping_address: de(), billing_address: de('DE 123 456 789') });
    // R2
    r.b2cOrder = await place({ shipping_address: de(), billing_address: de() });
    r.b2cQuote = await quote({ shipping_country: 'DE' });
    // R3: billing sent without a tax id; the delivery address carries it.
    r.fallback = await place({ shipping_address: de('DE123456789'), billing_address: { ...de(), line1: 'Rechnung 2' } });
    r.fallbackNoBilling = await place({ shipping_address: de('DE123456789') });
    // R9
    r.badAddressQuote = await quote({ shipping_country: 'DE', billing_address: { country: 'Germany', tax_id: 'DE123456789' } });
    // R4
    await setting('tax_reverse_charge_enabled', false);
    r.offOrder = await place({ shipping_address: de(), billing_address: de('DE123456789') });
    r.offQuote = await quote({ shipping_country: 'DE', billing_address: de('DE123456789') });
    await setting('tax_reverse_charge_enabled', true);
    return r;
  });

  await guard('greek', async () => {
    // R5: a GERMAN shop selling to a Greek business that wrote EL…
    await shop({
      shop_country: 'DE',
      tax_rates: [
        { class: 'standard', label: 'Standard', rate_bp: 1900 },
        { class: 'standard', label: 'GR', rate_bp: 2400, country: 'GR' },
      ],
    });
    const gr = (tax_id) => ({ country: 'GR', line1: 'Ερμού 1', city: 'Αθήνα', postcode: '10563', ...(tax_id ? { tax_id } : {}) });
    const r = {
      el: await place({ shipping_address: gr(), billing_address: gr('EL094019245') }),
      elQuote: await quote({ shipping_address: gr(), billing_address: gr('EL094019245') }),
      consumer: await place({ shipping_address: gr(), billing_address: gr() }),
    };
    await shop();
    return r;
  });

  await guard('verdict', async () => {
    await shop();
    let answer = { status: 'unchecked' };
    const seen = [];
    pluginManager.registerPlugin({
      id: 'test-verifier', name: 'Test verifier', version: '1.0.0', description: '', author: 'test',
      filters: {
        [PLUGIN_HOOKS.TAX_ID_VERDICT]: (current, ctx) => {
          seen.push({ current, taxId: ctx?.taxId, country: ctx?.country, shop: ctx?.settings?.shop_country, destination: ctx?.destination });
          return answer;
        },
      },
    });
    pluginManager.activatePlugin('test-verifier');
    const body = { shipping_address: de(), billing_address: de('DE123456789') };
    const r = { hook: PLUGIN_HOOKS.TAX_ID_VERDICT ?? null };
    // R6
    answer = { status: 'unchecked' };
    r.unchecked = await place(body);
    answer = { status: 'verified', country: 'DE' };
    r.verified = await place(body);
    r.verifiedQuote = await quote(body);
    answer = { status: 'invalid', reason: 'not-registered' };
    r.invalid = await place(body);
    r.invalidQuote = await quote(body);
    answer = { status: 'unverified', reason: 'timeout' };
    r.unverified = await place(body);
    // R7: France has NO rate on file. A consumer there is refused (409,
    // not-configured) — a business whose number could not be checked is not.
    const fr = (tax_id) => ({ country: 'FR', line1: '1 rue X', city: 'Paris', postcode: '75001', ...(tax_id ? { tax_id } : {}) });
    r.unverifiedFr = await place({ shipping_address: fr(), billing_address: fr('FR12345678901') });
    r.consumerFr = await place({ shipping_address: fr(), billing_address: fr() });
    r.unverifiedFrQuote = await quote({ shipping_address: fr(), billing_address: fr('FR12345678901') });
    // An async filter hands back a Promise: no opinion, never a change.
    answer = Promise.resolve({ status: 'invalid' });
    r.promise = await place(body);
    answer = { status: 'unchecked' };
    // R8
    seen.length = 0;
    answer = { status: 'verified' };
    await place(body);
    r.seen = seen.slice();
    // Not asked where it cannot matter: a domestic Greek sale.
    seen.length = 0;
    const grAddr = { country: 'GR', line1: 'Ερμού 1', city: 'Αθήνα', postcode: '10563', tax_id: 'EL094019245' };
    await place({ shipping_address: grAddr, billing_address: grAddr });
    r.askedDomestic = seen.length;
    pluginManager.deactivatePlugin('test-verifier');
    return r;
  });

  await guard('store', async () => {
    const r = {};
    const build = M.externalPlugins?.buildPluginHost;
    r.hasBuilder = typeof build === 'function';
    if (!r.hasBuilder) return r;
    const host = build();
    r.hasCreateStore = typeof host.createStore === 'function';
    if (!r.hasCreateStore) return r;
    const store = host.createStore('vat');
    await store.put('evidence', 'ord-1', { status: 'verified', vat_id: 'DE123456789' });
    r.get = await store.get('evidence', 'ord-1');
    // The SAME records a route's ctx.store and a migration's store see.
    const routeStore = M.createPluginStore('vat', LocalDB);
    r.seenByRouteStore = await routeStore.get('evidence', 'ord-1');
    await routeStore.put('evidence', 'ord-2', { status: 'unverified' });
    r.list = (await store.list('evidence')).map((x) => x.id).sort();
    // Namespaced: another plugin's store cannot see it.
    r.otherPlugin = await host.createStore('search').get('evidence', 'ord-1');
    r.deleted = await store.delete('evidence', 'ord-1');
    r.afterDelete = await store.get('evidence', 'ord-1');
    r.cleared = await store.clear('evidence');
    // A package name is not a plugin id: refused at the call, not on first use.
    try { host.createStore('@astrobaas/vat'); r.atRefused = false; } catch (e) { r.atRefused = /invalid plugin id/i.test(String(e?.message)); }
    r.metaRefused = await Promise.resolve()
      .then(() => host.createStore('vat').get('_meta', 'schema'))
      .then(() => false, () => true);
    // Synchronous: built without touching storage.
    r.sync = !(host.createStore('vat') instanceof Promise);
    return r;
  });

  return out;
}

if (process.env.REVERSE_CHARGE_CHILD) {
  const M = await loadTs('tests/fixtures/checkout-entry.ts', 'reversecharge');
  await M.LocalDB.init();
  const result = await child(M);
  console.log('__RESULT__' + JSON.stringify(result));
  process.exit(0);
}

/* --------------------------------------------------------------- parent --- */
let pass = 0;
let fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };
const j = JSON.stringify;

const tmpRoot = path.join(os.tmpdir(), `astrobaas-reverse-charge-${process.pid}`);
await fs.mkdir(tmpRoot, { recursive: true });

const DRIVERS = [
  { name: 'lowdb', env: (d) => ({ DB_PATH: path.join(d, 'db.json') }) },
  { name: 'libsql', env: (d) => ({ DATABASE_URL: `file:${path.join(d, 'db.sqlite')}` }) },
  { name: 'relational', env: (d) => ({ DATABASE_URL: `file:${path.join(d, 'db.sqlite')}`, DATABASE_DRIVER: 'relational' }) },
];

async function runChild(driver) {
  const dir = path.join(tmpRoot, driver.name);
  await fs.mkdir(path.join(dir, 'uploads'), { recursive: true });
  const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env, REVERSE_CHARGE_CHILD: '1', NODE_ENV: 'test', AUTH_SECRET: SECRET,
      STAGING: '', ASTROBAAS_STAGING: '', RATE_LIMIT_STORE: '', SITE_URL: '', EMAIL_TRANSPORT: '', SMTP_HOST: '',
      DB_PATH: '', DATABASE_URL: '', DATABASE_DRIVER: '',
      UPLOADS_DIR: path.join(dir, 'uploads'), ...driver.env(dir),
    },
  });
  const line = (run.stdout || '').split('\n').find((l) => l.startsWith('__RESULT__'));
  if (!line) {
    fail++;
    console.error(`✗ [${driver.name}] child produced no result\n${(run.stderr || '').slice(-2000)}`);
    return null;
  }
  return JSON.parse(line.slice('__RESULT__'.length));
}

const results = {};
for (const driver of DRIVERS) {
  const r = await runChild(driver);
  if (!r) continue;
  results[driver.name] = r;
  const t = (n, c) => check(`[${driver.name}] ${n}`, c);
  for (const [k, v] of Object.entries(r)) {
    if (v && v.error) t(`${k}: scenario threw — ${v.error}`, false);
  }

  const c = r.core && !r.core.error ? r.core : null;
  if (c) {
    t(`R1: a DE business buying from a GR shop pays 0 VAT on the ORDER (${j(c.b2bOrder)})`,
      c.b2bOrder.code === 201 && c.b2bOrder.tax === 0 && c.b2bOrder.treatment === 'reverse-charge');
    t('R1: ...and the tax id is still captured on the order, unchanged', c.b2bOrder.billingTaxId === 'DE123456789');
    t(`R1: ...and 0 VAT on the QUOTE (${j(c.b2bQuote)})`, c.b2bQuote.code === 200 && c.b2bQuote.tax === 0 && c.b2bQuote.treatment === 'reverse-charge');
    t(`R1: ...including a quote sending only structured addresses (${j(c.b2bQuoteStructured)})`,
      c.b2bQuoteStructured.code === 200 && c.b2bQuoteStructured.tax === 0);
    t(`R2: the same sale to a consumer pays DE VAT (${j(c.b2cOrder)})`, c.b2cOrder.code === 201 && c.b2cOrder.tax === 1900 && c.b2cOrder.treatment === 'destination');
    t(`R2: ...on the quote too (${j(c.b2cQuote)})`, c.b2cQuote.code === 200 && c.b2cQuote.tax === 1900);
    t(`R3: the delivery address's tax id is the fallback (${j(c.fallback)})`, c.fallback.code === 201 && c.fallback.tax === 0);
    t(`R3: ...and with no billing address at all (${j(c.fallbackNoBilling)})`, c.fallbackNoBilling.code === 201 && c.fallbackNoBilling.tax === 0);
    t(`R9: a malformed billing address on a quote is ignored, not refused (${j(c.badAddressQuote)})`,
      c.badAddressQuote.code === 200 && c.badAddressQuote.tax === 1900);
    t(`R4: reverse charge OFF — the tax id changes nothing on the order (${j(c.offOrder)})`,
      c.offOrder.code === 201 && c.offOrder.tax === 1900);
    t(`R4: ...or the quote (${j(c.offQuote)})`, c.offQuote.code === 200 && c.offQuote.tax === 1900);
  }

  const g = r.greek && !r.greek.error ? r.greek : null;
  if (g) {
    t(`R5: a Greek business writing EL… is reverse-charged by a DE shop (${j(g.el)})`, g.el.code === 201 && g.el.tax === 0);
    t(`R5: ...on the quote too (${j(g.elQuote)})`, g.elQuote.code === 200 && g.elQuote.tax === 0);
    t(`R5: ...and a Greek consumer pays Greek VAT (${j(g.consumer)})`, g.consumer.code === 201 && g.consumer.tax === 2400);
  }

  const v = r.verdict && !r.verdict.error ? r.verdict : null;
  if (v) {
    t(`R6: the hook exists as PLUGIN_HOOKS.TAX_ID_VERDICT = 'tax_id_verdict' (${v.hook})`, v.hook === 'tax_id_verdict');
    t(`R6: unchecked = today's behaviour, 0 VAT (${j(v.unchecked)})`, v.unchecked.code === 201 && v.unchecked.tax === 0);
    t(`R6: verified → 0 VAT on the order (${j(v.verified)})`, v.verified.code === 201 && v.verified.tax === 0);
    t(`R6: ...and the quote (${j(v.verifiedQuote)})`, v.verifiedQuote.code === 200 && v.verifiedQuote.tax === 0);
    t(`R6: invalid → VAT charged, order PLACED (${j(v.invalid)})`, v.invalid.code === 201 && v.invalid.tax === 1900);
    t(`R6: ...and quoted with VAT (${j(v.invalidQuote)})`, v.invalidQuote.code === 200 && v.invalidQuote.tax === 1900);
    t(`R6: unverified → VAT charged, order PLACED (${j(v.unverified)})`, v.unverified.code === 201 && v.unverified.tax === 1900);
    t(`R7: unverified with no destination rate on file is NOT refused (${j(v.unverifiedFr)})`,
      v.unverifiedFr.code === 201 && v.unverifiedFr.tax === 0);
    t(`R7: ...while a consumer there is, exactly as before (${j(v.consumerFr)})`, v.consumerFr.code === 409);
    t(`R7: ...and the quote agrees with the order (${j(v.unverifiedFrQuote)})`,
      v.unverifiedFrQuote.code === 200 && v.unverifiedFrQuote.tax === 0);
    t(`R6: a filter returning a Promise is no opinion (${j(v.promise)})`, v.promise.code === 201 && v.promise.tax === 0);
    const s = v.seen?.[0];
    t(`R8: asked once per pricing, starting from { status: 'unchecked' } (${j(v.seen)})`,
      v.seen?.length === 1 && s.current?.status === 'unchecked');
    t('R8: ...with the tax id, the billing country and the destination',
      s?.taxId === 'DE123456789' && s?.country === 'DE' && s?.destination === 'DE');
    t('R8: ...and the settings, read by the call site', s?.shop === 'GR');
    t(`R8: never asked for a domestic sale (${v.askedDomestic})`, v.askedDomestic === 0);
  }

  const s = r.store && !r.store.error ? r.store : null;
  if (s) {
    t(`R10: the plugin host has createStore (${j({ b: s.hasBuilder, c: s.hasCreateStore })})`, s.hasBuilder && s.hasCreateStore);
    if (s.hasCreateStore) {
      t(`R10: put then get round-trips (${j(s.get)})`, s.get?.status === 'verified' && s.get?.vat_id === 'DE123456789');
      t('R10: ...in the SAME namespace a route\'s ctx.store reads', s.seenByRouteStore?.vat_id === 'DE123456789');
      t(`R10: ...and the route store's writes are visible to it (${j(s.list)})`, j(s.list) === j(['ord-1', 'ord-2']));
      t('R10: another plugin\'s store cannot see it', s.otherPlugin === undefined || s.otherPlugin === null);
      t('R10: delete and clear work', s.deleted === true && (s.afterDelete === undefined || s.afterDelete === null) && s.cleared === 1);
      t(`R10: "@astrobaas/vat" is refused at the call (${s.atRefused})`, s.atRefused === true);
      t(`R10: the platform's _meta collection stays out of reach (${s.metaRefused})`, !!s.metaRefused);
      t('R10: createStore is synchronous', s.sync === true);
    }
  }
}

// The three drivers must AGREE, not merely each pass.
const names = Object.keys(results);
if (names.length === 3) {
  const shape = (r) => j({
    core: r.core && Object.fromEntries(Object.entries(r.core).map(([k, x]) => [k, [x.code, x.tax]])),
    greek: r.greek && Object.fromEntries(Object.entries(r.greek).map(([k, x]) => [k, [x.code, x.tax]])),
    verdict: r.verdict && Object.fromEntries(Object.entries(r.verdict)
      .filter(([, x]) => x && typeof x === 'object' && 'code' in x).map(([k, x]) => [k, [x.code, x.tax]])),
    store: r.store,
  });
  check(`the three drivers produce identical results (${names.map((n) => n).join(', ')})`,
    shape(results.lowdb) === shape(results.libsql) && shape(results.libsql) === shape(results.relational));
}

await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
