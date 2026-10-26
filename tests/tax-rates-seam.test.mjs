#!/usr/bin/env node
/**
 * The TAX_RATES seam, and the core defects that had to be fixed before it
 * could be wired.
 *
 *  D1  THE DOMESTIC-RATE BUG. The domestic fallback (`rateForClass`, reached
 *      from `rateForTreatment` for a domestic sale) looked a class up in EVERY
 *      country's rows. A Greek shop whose only `reduced-2` row is Austria's 10%
 *      charged Greek buyers 10% on a `reduced-2` product. It must only ever
 *      look at the shop's own rows. Independent of any plugin: an operator who
 *      typed one foreign row was already exposed.
 *  D2  The tax override's class check was country-blind in the same way, so
 *      an override to a class only another country has was ACCEPTED, at that
 *      country's rate.
 *  D3  `normalizeTaxRates` de-duplicated on (country, class), so a territory
 *      row sharing a class with its mainland row was dropped.
 *  D4  Plugin rows are not cut at the operator's 50-row cap.
 *  S1  `PLUGIN_HOOKS.TAX_RATES`: operator rows win, a throwing or garbage
 *      filter leaves the operator's rows in force, every plugin row the core
 *      drops is logged.
 *  S2  Every pricing path sees the same table: the quote, the order and the
 *      tax-override route, through the REAL route handlers, on all three
 *      storage drivers — which must agree.
 *
 * Run with:  node tests/tax-rates-seam.test.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, loadTs } from './lib/load.mjs';

const SECRET = 'tax-rates-seam-secret-0123456789abcdef';

/* ---------------------------------------------------------------- child --- */

async function child(M) {
  const { LocalDB, pluginManager, PLUGIN_HOOKS } = M;
  const out = {};
  const guard = async (key, fn) => {
    try { out[key] = await fn(); } catch (err) { out[key] = { error: String(err?.stack || err).slice(0, 600) }; }
  };
  let seq = 0;
  const product = (tax_class, extra = {}) => LocalDB.createProduct({
    status: 'active', price_cents: 10000, categories: [], images: [], on_sale: false,
    name: `trs-${++seq}`, slug: `trs-${seq}`, stock: 100, in_stock: true, requires_shipping: false,
    ...(tax_class ? { tax_class } : {}), ...extra,
  });
  let ipSeq = 0;
  const nextIp = () => `100.66.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`;
  const call = async (handler, url, body, { user = null, params = {} } = {}) => {
    const res = await handler({
      request: new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      locals: { user, ip: nextIp() },
      url: new URL(url),
      params,
    });
    const json = await res.json().catch(() => null);
    return { code: res.status, data: json?.data, error: json?.error ?? null };
  };
  let mail = 0;

  // A Greek shop in OSS mode, NET prices so 10000 net at 19% reads as 1900.
  // The operator wrote NO German row, NO `books` class and no GREEK reduced-2.
  const settings = {
    tax_enabled: true, shop_country: 'GR', tax_destination_mode: 'oss',
    tax_prices_include_tax: false,
    tax_rates: [
      { class: 'standard', label: 'Standard', rate_bp: 2400 },
      { class: 'reduced', label: 'Reduced', rate_bp: 1300 },
      { class: 'standard', label: 'AT', rate_bp: 2000, country: 'AT' },
      // The operator's own Austrian reduced-2 row. Enough, with no plugin at
      // all, to leak 10% into a GREEK sale of a reduced-2 product (D1).
      { class: 'reduced-2', label: 'AT 10', rate_bp: 1000, country: 'AT' },
    ],
  };
  for (const [k, v] of Object.entries(settings)) await LocalDB.updateSetting(k, v);

  const std = await product();
  const r2 = await product('reduced-2');
  const de = { country: 'DE', line1: 'Hauptstr. 1', city: 'Berlin', postcode: '10115' };
  const gr = { country: 'GR', line1: 'Ερμού 1', city: 'Αθήνα', postcode: '10563' };
  const place = async (p, addr) => {
    const r = await call(M.postOrder, 'http://localhost/api/orders', {
      items: [{ product_id: p.id, qty: 1 }], email: `trs${++mail}@example.com`, name: 'Buyer',
      shipping_address: addr, billing_address: addr,
    });
    const id = r.data?.order?.id ?? r.data?.id;
    const number = r.data?.order?.number ?? r.data?.number;
    const stored = number ? (await LocalDB.getOrders()).find((o) => o.number === number) : undefined;
    return { code: r.code, tax: stored?.tax_cents ?? null, id: stored?.id ?? id ?? null, err: r.error?.code ?? r.error?.message ?? null };
  };
  const quote = async (p, addr) => {
    const r = await call(M.postQuote, 'http://localhost/api/orders/quote', {
      items: [{ product_id: p.id, qty: 1 }], shipping_address: addr,
    });
    return { code: r.code, tax: r.data?.tax_cents ?? null, err: r.error?.code ?? null };
  };
  const admin = { id: 'u-admin', role: 'admin', email: 'a@example.com' };
  const override = async (orderId, body) => {
    const r = await call(M.postTaxOverride, `http://localhost/api/orders/${orderId}/tax-override`,
      { reason: 'test', ...body }, { user: admin, params: { id: orderId } });
    return { code: r.code, tax: r.data?.tax_cents ?? null, rate: r.data?.line_totals?.[0]?.tax_rate_bp ?? null };
  };

  await guard('plain', async () => {
    const r = {};
    r.hook = PLUGIN_HOOKS.TAX_RATES ?? null;
    r.deQuote = await quote(std, de);
    r.deOrder = await place(std, de);
    r.domesticR2 = await place(r2, gr);
    return r;
  });

  await guard('plugin', async () => {
    const r = {};
    const seen = [];
    pluginManager.registerPlugin({
      id: 'test-rates', name: 'Test rates', version: '1.0.0', description: '', author: 'test',
      filters: {
        [PLUGIN_HOOKS.TAX_RATES ?? 'tax_rates']: (current, ctx) => {
          seen.push({ n: current?.length, shop: ctx?.settings?.shop_country });
          return [
            ...current,
            { class: 'standard', label: 'DE', rate_bp: 1900, country: 'DE' },
            // The operator has AT standard at 20%: theirs must win.
            { class: 'standard', label: 'AT', rate_bp: 2100, country: 'AT' },
            // Austria's reduced-2. Must never reach a GREEK buyer (D1).
            { class: 'reduced-2', label: 'AT 10', rate_bp: 1000, country: 'AT' },
            // A domestic class the operator lacks, supplied for GR.
            { class: 'books', label: 'Books', rate_bp: 600, country: 'GR' },
          ];
        },
      },
    });
    pluginManager.activatePlugin('test-rates');
    r.deQuote = await quote(std, de);
    r.deOrder = await place(std, de);
    r.atQuote = await quote(std, { ...de, country: 'AT', postcode: '1010' });
    r.domesticR2 = await place(r2, gr);
    r.domesticR2Quote = await quote(r2, gr);
    // A NON-taxable product whose class Germany has no row for owes no VAT:
    // it must not be refused for a missing rate.
    r.untaxedDe = await quote(await product('reduced-2', { tax_status: 'none' }), de);
    const dom = await place(std, gr);
    r.domestic = dom;
    // The override route sees the same table: `books` (plugin, GR) is a
    // domestic class; `reduced-2` exists only in Austria and must be refused.
    r.overrideBooks = dom.id ? await override(dom.id, { tax_class: 'books' }) : null;
    r.overrideR2 = dom.id ? await override(dom.id, { tax_class: 'reduced-2' }) : null;
    r.seen = seen.slice(0, 1);
    r.calls = seen.length;
    pluginManager.deactivatePlugin('test-rates');
    return r;
  });

  await guard('throws', async () => {
    const r = {};
    pluginManager.registerPlugin({
      id: 'test-throws', name: 'Throws', version: '1.0.0', description: '', author: 'test',
      filters: {
        [PLUGIN_HOOKS.TAX_RATES ?? 'tax_rates']: (current) => {
          current.push({ class: 'standard', rate_bp: 1900, country: 'DE' });
          throw new Error('boom');
        },
      },
    });
    pluginManager.activatePlugin('test-throws');
    // Fail closed: the operator's rows only, so Germany is refused again.
    r.deQuote = await quote(std, de);
    r.domestic = await quote(std, gr);
    pluginManager.deactivatePlugin('test-throws');
    return r;
  });

  return out;
}

if (process.env.TAX_RATES_SEAM_CHILD) {
  const M = await loadTs('tests/fixtures/checkout-entry.ts', 'taxratesseam');
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

const T = await loadTs('src/lib/commerce/tax.ts');
const O = await loadTs('src/lib/commerce/tax-override.ts');

/* ------------------------------------------------ D1: the domestic-rate bug */
{
  // A Greek shop, destination mode OFF (the bug needs no OSS at all), whose
  // only `reduced-2` row is Austria's.
  const s = T.resolveTaxSettings({
    tax_enabled: true, shop_country: 'GR',
    tax_rates: [
      { class: 'standard', rate_bp: 2400 },
      { class: 'reduced', rate_bp: 1300 },
      { class: 'reduced-2', rate_bp: 1000, country: 'AT' },
    ],
  });
  const dom = { kind: 'domestic', jurisdiction: 'GR' };
  check(`D1: a domestic reduced-2 product takes GR's default 24%, not Austria's 10% (rateForTreatment ${T.rateForTreatment(s, dom, 'reduced-2')})`,
    T.rateForTreatment(s, dom, 'reduced-2') === 2400);
  check(`D1: ...and rateForClass, the domestic rate, agrees (${T.rateForClass(s, 'reduced-2')})`,
    T.rateForClass(s, 'reduced-2') === 2400);
  check('D1: ...also for a domestic treatment with no jurisdiction stamped',
    T.rateForTreatment(s, { kind: 'domestic' }, 'reduced-2') === 2400);
  check('D1: the shop\'s own classes are unchanged',
    T.rateForTreatment(s, dom, 'standard') === 2400 && T.rateForTreatment(s, dom, 'reduced') === 1300);
  // Same with OSS on and the sale actually resolved by the engine.
  const oss = T.resolveTaxSettings({
    tax_enabled: true, shop_country: 'GR', tax_destination_mode: 'oss',
    tax_rates: [{ class: 'standard', rate_bp: 2400 }, { class: 'reduced-2', rate_bp: 1000, country: 'AT' }],
  });
  const t = T.resolveTaxTreatment({ settings: oss, destination: { country: 'GR' }, classes: ['reduced-2'] });
  check(`D1: through resolveTaxTreatment, a Greek buyer pays 24% (${t.kind} ${T.rateForTreatment(oss, t, 'reduced-2')})`,
    t.kind === 'domestic' && T.rateForTreatment(oss, t, 'reduced-2') === 2400);
  check('D1: ...while an Austrian buyer still gets Austria\'s reduced-2',
    T.rateForTreatment(oss, T.resolveTaxTreatment({ settings: oss, destination: { country: 'AT' }, classes: ['reduced-2'] }), 'reduced-2') === 1000);

  // The DEFAULT class must also come from home: a foreign row listed first for
  // the default class is not the shop's fallback.
  const first = T.resolveTaxSettings({
    tax_enabled: true, shop_country: 'GR', tax_default_class: 'standard',
    tax_rates: [{ class: 'standard', rate_bp: 1900, country: 'DE' }, { class: 'standard', rate_bp: 2400 }],
  });
  check(`D1: the default-class fallback is the shop's own row even when a foreign one is listed first (${T.rateForClass(first, 'typo')})`,
    T.rateForClass(first, 'typo') === 2400 && T.rateForTreatment(first, { kind: 'domestic', jurisdiction: 'GR' }, 'typo') === 2400);

  // ...and is not a special territory's row, unless the buyer is in it.
  const athosFirst = T.resolveTaxSettings({
    tax_enabled: true, shop_country: 'GR',
    tax_rates: [{ class: 'standard', rate_bp: 0, postcodes: ['63086'] }, { class: 'standard', rate_bp: 2400 }],
  });
  check(`D1: the fallback skips a territory row listed first (${T.rateForTreatment(athosFirst, { kind: 'domestic', jurisdiction: 'GR' }, 'typo', '10563')})`,
    T.rateForTreatment(athosFirst, { kind: 'domestic', jurisdiction: 'GR' }, 'typo', '10563') === 2400
    && T.rateForClass(athosFirst, 'typo') === 2400);
  check('D1: ...and applies it to a buyer inside the territory',
    T.rateForTreatment(athosFirst, { kind: 'domestic', jurisdiction: 'GR' }, 'typo', '63086') === 0);

  // A row written with the shop's own country explicitly is domestic too.
  const explicit = T.resolveTaxSettings({
    tax_enabled: true, shop_country: 'GR',
    tax_rates: [{ class: 'standard', rate_bp: 2400 }, { class: 'books', rate_bp: 600, country: 'GR' }],
  });
  check('D1: a row with country = the shop\'s own is domestic', T.rateForClass(explicit, 'books') === 600);

  // No shop_country: only rows without a country are home. Never a guess.
  const noOrigin = T.resolveTaxSettings({
    tax_enabled: true,
    tax_rates: [{ class: 'standard', rate_bp: 2400 }, { class: 'reduced-2', rate_bp: 1000, country: 'AT' }],
  });
  check(`D1: with no shop_country, a foreign row is still not domestic (${T.rateForClass(noOrigin, 'reduced-2')})`,
    T.rateForClass(noOrigin, 'reduced-2') === 2400);
  check('D1: tax off is still 0', T.rateForClass(T.resolveTaxSettings({ tax_rates: [{ class: 'a', rate_bp: 1 }] }), 'a') === 0);

  /*
   * D1b — never a SILENT 0% instead. Review blocker: scoping the lookup to
   * home must not turn "a foreign rate" into "no tax at all".
   */
  // No shop_country, the default class only on a country-tagged row: the
  // country-less rows cannot answer, so the table is searched as before.
  const A = T.resolveTaxSettings({ tax_enabled: true, tax_rates: [
    { class: 'standard', rate_bp: 2400, country: 'GR' }, { class: 'reduced', rate_bp: 1300 }] });
  check(`D1b: no shop_country, default class only on a tagged row: still 24%, not 0 (${T.rateForClass(A, 'standard')})`,
    T.rateForClass(A, 'standard') === 2400 && T.rateForTreatment(A, { kind: 'domestic' }, 'standard') === 2400);
  const A3 = T.resolveTaxSettings({ tax_enabled: true, tax_rates: [
    { class: 'standard', rate_bp: 0, postcodes: ['63086'] }, { class: 'standard', rate_bp: 2400, country: 'GR' }] });
  check(`D1b: no shop_country, only a territory row is country-less: a mainland buyer pays 24% (${T.rateForTreatment(A3, { kind: 'domestic' }, 'standard', '10563')})`,
    T.rateForTreatment(A3, { kind: 'domestic' }, 'standard', '10563') === 2400);
  check('D1b: ...and no refusal without a shop_country',
    T.resolveTaxTreatment({ settings: A, destination: { country: 'GR' }, classes: ['standard'] }).kind === 'domestic');
  // shop_country set and NO home row at all: refused, naming what to add —
  // never 0%, never the GR row's 24% charged in Cyprus.
  const K = T.resolveTaxSettings({ tax_enabled: true, shop_country: 'CY', tax_rates: [
    { class: 'standard', rate_bp: 2400, country: 'GR' }, { class: 'standard', rate_bp: 1900, country: 'DE' }] });
  const kt = T.resolveTaxTreatment({ settings: K, destination: { country: 'CY' }, classes: ['standard'] });
  check(`D1b: a shop with no row for its own country is refused (not-configured), not charged 0 or GR's rate (${j(kt)})`,
    kt.kind === 'not-configured' && kt.missing?.country === 'CY' && j(kt.missing?.classes) === j(['standard']));
  check('D1b: ...also before an address is known (cart page)',
    T.resolveTaxTreatment({ settings: K, classes: ['standard'] }).kind === 'not-configured');
  check('D1b: ...also with destination mode on and a domestic buyer',
    T.resolveTaxTreatment({ settings: { ...K, destinationMode: 'oss' }, destination: { country: 'CY' }, classes: ['standard'] }).kind === 'not-configured');
  check('D1b: rateForTreatment says null (refuse), not 0', T.rateForTreatment(K, { kind: 'domestic', jurisdiction: 'CY' }, 'standard') === null);
  // A home ladder that has the default class answers every class, as before.
  const ok = T.resolveTaxSettings({ tax_enabled: true, shop_country: 'GR', tax_rates: [{ class: 'standard', rate_bp: 2400 }] });
  check('D1b: a normal shop is never refused for an unknown class (default-class fallback)',
    T.resolveTaxTreatment({ settings: ok, destination: { country: 'GR' }, classes: ['typo', 'standard'] }).kind === 'domestic');
  check('D1b: tax off is never refused',
    T.resolveTaxTreatment({ settings: { ...K, enabled: false }, destination: { country: 'CY' }, classes: ['standard'] }).kind === 'domestic');
}

/* ------------------------------------------------ D2: the override class check */
{
  const s = T.resolveTaxSettings({
    tax_enabled: true, shop_country: 'GR',
    tax_rates: [
      { class: 'standard', rate_bp: 2400 },
      { class: 'reduced', rate_bp: 1300 },
      { class: 'reduced-2', rate_bp: 1000, country: 'AT' },
      { class: 'island', rate_bp: 1700, postcodes: ['84*'] },
    ],
  });
  const lines = [{ product_id: 'p', name: 'P', qty: 1, unit_price_cents: 10000, line_subtotal_cents: 10000,
    discount_cents: 0, net_cents: 10000, tax_cents: 2400, tax_rate_bp: 2400, total_cents: 12400 }];
  const r2 = O.applyTaxOverride(lines, s, { scope: 'order', tax_class: 'reduced-2', reason: 'x' }, 'u');
  check(`D2: an override to a class only Austria has is REFUSED, not charged at 10% (${j(r2.ok ? r2.record : r2.error)})`, r2.ok === false);
  const red = O.applyTaxOverride(lines, s, { scope: 'order', tax_class: 'reduced', reason: 'x' }, 'u');
  check('D2: a domestic class still overrides', red.ok === true && red.record.now_rate_bp === 1300);
  // A class that exists at home only as a territory row has no country-wide
  // rate to apply; the override must not fall through to the default.
  const isl = O.applyTaxOverride(lines, s, { scope: 'order', tax_class: 'island', reason: 'x' }, 'u');
  check(`D2: a class that exists only as a territory row is refused (${j(isl.ok ? isl.record : isl.error)})`, isl.ok === false);

  // A class override applies the HOME rate, so it is refused on a line taxed
  // under another treatment (review blocker B2): a German consumer's 19% line
  // must not silently become Greek 24%.
  const deLine = [{ ...lines[0], tax_rate_bp: 1900, tax_cents: 1900, total_cents: 11900, tax_treatment: 'destination', tax_jurisdiction: 'DE' }];
  const deStd = O.applyTaxOverride(deLine, s, { scope: 'order', tax_class: 'standard', reason: 'x' }, 'u');
  check(`D2: a class override on a destination line is refused (${j(deStd.ok ? deStd.record : deStd.error)})`, deStd.ok === false && /DE/.test(deStd.error));
  const deEx = O.applyTaxOverride(deLine, s, { scope: 'order', exempt: true, reason: 'x' }, 'u');
  check('D2: ...exempt is still allowed on it', deEx.ok === true && deEx.record.now_rate_bp === 0);
  const mixed = [lines[0], deLine[0]];
  const m0 = O.applyTaxOverride(mixed, s, { scope: 'line', line_index: 0, tax_class: 'reduced', reason: 'x' }, 'u');
  const m1 = O.applyTaxOverride(mixed, s, { scope: 'order', tax_class: 'reduced', reason: 'x' }, 'u');
  check('D2: ...a domestic line beside it can still be overridden alone, the whole order cannot', m0.ok === true && m1.ok === false);
  const rcLine = [{ ...lines[0], tax_rate_bp: 0, tax_cents: 0, total_cents: 10000, tax_treatment: 'reverse-charge' }];
  check('D2: ...and so is one on a reverse-charge line',
    O.applyTaxOverride(rcLine, s, { scope: 'order', tax_class: 'standard', reason: 'x' }, 'u').ok === false);
}

/* ------------------------------------------------ D3/D4: normalizeTaxRates */
{
  const es = T.normalizeTaxRates([
    { class: 'standard', rate_bp: 2100, country: 'ES' },
    { class: 'standard', rate_bp: 0, country: 'ES', postcodes: ['35*', '38*'] },
  ]);
  check(`D3: a territory row and its mainland row for the same class are both kept (${es.length})`, es.length === 2);
  const dup = T.normalizeTaxRates([
    { class: 'standard', rate_bp: 0, country: 'ES', postcodes: ['35*', '38*'] },
    { class: 'standard', rate_bp: 700, country: 'ES', postcodes: ['38*', '35*'] },
  ]);
  check('D3: the same postcodes in another order are still a duplicate', dup.length === 1 && dup[0].rate_bp === 0);
  // A territory row whose every postcode is unusable must NOT become a
  // country-wide row: that would charge the territory's rate to the whole country.
  const lost = T.normalizeTaxRates([
    { class: 'standard', rate_bp: 0, country: 'ES', postcodes: ['35 001!'] },
    { class: 'standard', rate_bp: 2100, country: 'ES' },
  ]);
  check(`D3: a territory row with no usable postcode is dropped, not widened to the whole country (${j(lost)})`,
    lost.length === 1 && lost[0].rate_bp === 2100);

  // The operator cap is kept (and documented); plugin rows are not cut by it.
  const sixty = Array.from({ length: 60 }, (_, i) => ({ class: `c${i}`, rate_bp: 100 }));
  check('D4: operator input keeps its 50-row cap', T.normalizeTaxRates(sixty).length === 50);
  check('D4: the cap is a named constant', T.MAX_OPERATOR_TAX_RATES === 50);
}

/* ------------------------------------------------ S1: the merge, pure */
let P = null;
try { P = await loadTs('src/lib/commerce/tax-plugins.ts'); } catch (err) { check(`S1: src/lib/commerce/tax-plugins.ts loads (${err.message.slice(0, 120)})`, false); }
const SYS = await loadTs('src/lib/plugin-system.ts');
check('S1: PLUGIN_HOOKS.TAX_RATES is the documented name', SYS.PLUGIN_HOOKS.TAX_RATES === 'tax_rates');

if (P) {
  const map = {
    tax_enabled: true, shop_country: 'GR', tax_destination_mode: 'oss',
    tax_rates: [
      { class: 'standard', rate_bp: 2400 },
      { class: 'reduced', rate_bp: 1300 },
      { class: 'standard', rate_bp: 2000, country: 'DE' },
    ],
  };
  const logs = [];
  const capture = async (fn) => {
    const warn = console.warn; const error = console.error;
    console.warn = (...a) => logs.push(a.map(String).join(' '));
    console.error = (...a) => logs.push(a.map(String).join(' '));
    try { return await fn(); } finally { console.warn = warn; console.error = error; }
  };
  const withFilter = (fn) => {
    const pm = new SYS.PluginManager();
    pm.registerPlugin({ id: 'f', name: 'f', version: '1', description: '', author: 't', filters: { [SYS.PLUGIN_HOOKS.TAX_RATES]: fn } });
    pm.activatePlugin('f');
    return pm;
  };
  const base = T.resolveTaxSettings(map);

  check('S1: no filter registered: identical to resolveTaxSettings',
    j(P.resolveTaxSettingsWithPlugins(map, new SYS.PluginManager())) === j(base));

  let ctxSeen = null;
  const added = Array.from({ length: 117 }, (_, i) => ({ class: `k${i}`, rate_bp: 500 + i, country: 'FR' }));
  logs.length = 0;
  const merged = await capture(() => P.resolveTaxSettingsWithPlugins(map, withFilter((rates, ctx) => {
    ctxSeen = ctx;
    rates[0].rate_bp = 1; // a sloppy plugin mutating what it was handed
    return [
      ...rates,
      { class: 'standard', rate_bp: 1900, country: 'DE' }, // operator has DE standard
      { class: 'standard', rate_bp: 2100, country: 'ES' },
      { class: 'standard', rate_bp: 0, country: 'ES', postcodes: ['35*'] },
      { class: 'bad', rate_bp: -1, country: 'ES' },
      { class: 'named', rate_bp: 1000, country: 'Germany' },
      ...added,
    ];
  })));
  const find = (c, k, pc) => merged.rates.find((r) => r.country === c && r.class === k && j(r.postcodes ?? null) === j(pc ?? null));
  check('S1: the filter is handed { settings } with the shop\'s settings', ctxSeen?.settings?.shop_country === 'GR');
  check('S1: operator rows come first and are untouched by a plugin mutating its copy',
    j(merged.rates.slice(0, 3)) === j(base.rates) && base.rates[0].rate_bp === 2400);
  check(`S1: the operator's DE row wins over the plugin's (${find('DE', 'standard')?.rate_bp})`, find('DE', 'standard')?.rate_bp === 2000
    && merged.rates.filter((r) => r.country === 'DE' && r.class === 'standard').length === 1);
  check('S1: plugin rows are added, territory and mainland both', find('ES', 'standard')?.rate_bp === 2100 && find('ES', 'standard', ['35*'])?.rate_bp === 0);
  check(`D4: all 117 bulk plugin rows survive (no 50-row cap): ${merged.rates.filter((r) => r.country === 'FR').length}`,
    merged.rates.filter((r) => r.country === 'FR').length === 117);
  check('S1: invalid plugin rows are dropped', !merged.rates.some((r) => r.class === 'bad' || r.class === 'named'));
  check(`S1: each dropped plugin row is logged — invalid rate, bad country, operator override (${j(logs)})`,
    logs.some((l) => /TAX_RATES/.test(l) && /bad/.test(l))
    && logs.some((l) => /TAX_RATES/.test(l) && /named/.test(l))
    && logs.some((l) => /TAX_RATES/.test(l) && /operator/.test(l) && /DE/.test(l)));
  check('S1: the operator\'s own rows passed back through are NOT logged as drops',
    !logs.some((l) => /"reduced"|\breduced\b/.test(l)));
  check('S1: defaultClass and shippingClass stay the operator\'s', merged.defaultClass === base.defaultClass && merged.shippingClass === base.shippingClass);

  // A plugin that drops the operator's rows cannot remove them.
  const dropped = P.resolveTaxSettingsWithPlugins(map, withFilter(() => [{ class: 'standard', rate_bp: 2100, country: 'ES' }]));
  check('S1: a plugin that returns only its own rows does not remove the operator\'s', j(dropped.rates.slice(0, 3)) === j(base.rates) && dropped.rates.length === 4);

  // Rows past the supplied bound, and a plugin repeating its own row, are
  // dropped AND logged — never silently.
  logs.length = 0;
  const huge = Array.from({ length: T.MAX_SUPPLIED_TAX_RATES + 3 }, (_, i) => ({ class: `h${i}`, rate_bp: 100, country: 'IT' }));
  const capped = await capture(() => P.resolveTaxSettingsWithPlugins(map, withFilter((r) => [
    ...r, { class: 'twice', rate_bp: 100, country: 'IT' }, { class: 'twice', rate_bp: 200, country: 'IT' }, ...huge,
  ])));
  check(`S1: supplied rows have their own bound, and the cut is logged (${capped.rates.length})`,
    // 2008 supplied (3 operator + 2 + 2003): 8 cut; of the 2000 kept, 3 are the
    // operator's and one is a repeat, so 3 + 1996 rows.
    capped.rates.length === T.MAX_SUPPLIED_TAX_RATES - 1
    && logs.some((l) => /8 rows/.test(l) && /row limit/.test(l)));
  check('S1: a plugin repeating its own row: the first wins, the second is logged',
    capped.rates.find((r) => r.class === 'twice')?.rate_bp === 100 && logs.some((l) => /twice/.test(l) && /duplicate/.test(l)));

  // Fail closed.
  logs.length = 0;
  const threw = await capture(() => P.resolveTaxSettingsWithPlugins(map, withFilter((rates) => {
    rates.push({ class: 'standard', rate_bp: 1900, country: 'FR' });
    throw new Error('boom');
  })));
  check(`S1: a throwing filter leaves exactly the operator's rows (${threw.rates.length})`, j(threw.rates) === j(base.rates));
  check('S1: ...and the error is logged', logs.some((l) => /boom/.test(l)));
  // ...even when another filter before it succeeded: one failure, no plugin rows.
  const pm2 = new SYS.PluginManager();
  pm2.registerPlugin({ id: 'a', name: 'a', version: '1', description: '', author: 't', filters: { tax_rates: (r) => [...r, { class: 'x', rate_bp: 1, country: 'FR' }] } });
  pm2.registerPlugin({ id: 'b', name: 'b', version: '1', description: '', author: 't', filters: { tax_rates: () => { throw new Error('second'); } } });
  pm2.activatePlugin('a'); pm2.activatePlugin('b');
  const second = await capture(() => P.resolveTaxSettingsWithPlugins(map, pm2));
  check('S1: any filter throwing discards every plugin row (fail closed)', j(second.rates) === j(base.rates));

  logs.length = 0;
  const promise = await capture(() => P.resolveTaxSettingsWithPlugins(map, withFilter(async (r) => [...r, { class: 'x', rate_bp: 1, country: 'FR' }])));
  check('S1: an async filter (a Promise) is ignored and logged AS async', j(promise.rates) === j(base.rates) && logs.some((l) => /TAX_RATES/.test(l) && /async/.test(l)));
  {
    // A rejecting async filter must not leave an unhandled rejection behind.
    let unhandled = 0;
    const on = () => { unhandled++; };
    process.on('unhandledRejection', on);
    await capture(() => P.resolveTaxSettingsWithPlugins(map, withFilter(async () => { throw new Error('async boom'); })));
    await new Promise((r) => setTimeout(r, 20));
    process.off('unhandledRejection', on);
    check(`S1: a rejecting async filter leaves no unhandledRejection (${unhandled})`, unhandled === 0);
  }
  {
    // ctx.settings is the filter's own copy, deep: what the rest of pricing
    // reads (TAX_ID_VERDICT gets the same map) cannot be edited through it.
    const m2 = JSON.parse(JSON.stringify(map));
    P.resolveTaxSettingsWithPlugins(m2, withFilter((r, ctx) => { ctx.settings.tax_rates.push({ class: 'x', rate_bp: 1 }); ctx.settings.shop_country = 'DE'; return r; }));
    check('S1: a filter editing ctx.settings does not change the caller\'s map', j(m2) === j(map));
  }
  const same = withFilter((r) => r);
  check('S1: a filter returning the array it was handed changes nothing', j(P.resolveTaxSettingsWithPlugins(map, same)) === j(base));

  // Not consulted where foreign rows cannot apply.
  let calls = 0;
  const counting = withFilter((r) => { calls++; return r; });
  P.resolveTaxSettingsWithPlugins({ ...map, tax_enabled: false }, counting);
  P.resolveTaxSettingsWithPlugins({ ...map, shop_country: undefined }, counting);
  check(`S1: not called with tax off or no shop_country (no origin = no "domestic" to protect) (${calls})`, calls === 0);

  // D1 again, through the seam: Austria's reduced-2 from a plugin.
  const leak = P.resolveTaxSettingsWithPlugins(map, withFilter((r) => [...r, { class: 'reduced-2', rate_bp: 1000, country: 'AT' }]));
  check('D1+S1: a plugin\'s foreign row never reaches a domestic sale',
    T.rateForTreatment(leak, { kind: 'domestic', jurisdiction: 'GR' }, 'reduced-2') === 2400);
}

/* ------------------------------------------------ S2: real routes, 3 drivers */
const tmpRoot = path.join(os.tmpdir(), `astrobaas-tax-rates-seam-${process.pid}`);
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
      ...process.env, TAX_RATES_SEAM_CHILD: '1', NODE_ENV: 'test', AUTH_SECRET: SECRET,
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
  for (const [k, v] of Object.entries(r)) if (v && v.error) t(`${k}: scenario threw — ${v.error}`, false);

  const a = r.plain && !r.plain.error ? r.plain : null;
  if (a) {
    t(`S2: no plugin — Germany has no rate on file and the quote refuses (${j(a.deQuote)})`, a.deQuote.code === 409);
    t(`S2: ...and so does the order (${j(a.deOrder)})`, a.deOrder.code === 409);
    t(`D1: no plugin — a domestic reduced-2 order pays GR's 24%, the operator's AT row is not used (${j(a.domesticR2)})`,
      a.domesticR2.code === 201 && a.domesticR2.tax === 2400);
  }
  const b = r.plugin && !r.plugin.error ? r.plugin : null;
  if (b) {
    t(`S2: with the plugin, the QUOTE charges Germany 19% (${j(b.deQuote)})`, b.deQuote.code === 200 && b.deQuote.tax === 1900);
    t(`S2: ...and the ORDER agrees (${j(b.deOrder)})`, b.deOrder.code === 201 && b.deOrder.tax === 1900);
    t(`S1: the operator's AT 20% wins over the plugin's 21% (${j(b.atQuote)})`, b.atQuote.code === 200 && b.atQuote.tax === 2000);
    t(`D1: a Greek buyer of a reduced-2 product pays 24%, never Austria's 10% — order (${j(b.domesticR2)})`,
      b.domesticR2.code === 201 && b.domesticR2.tax === 2400);
    t(`D1: ...and quote (${j(b.domesticR2Quote)})`, b.domesticR2Quote.code === 200 && b.domesticR2Quote.tax === 2400);
    t(`S2: a tax_status 'none' product is not refused for a rate it never needs (${j(b.untaxedDe)})`,
      b.untaxedDe.code === 200 && b.untaxedDe.tax === 0);
    t(`S2: the tax-override route sees the plugin's domestic class (${j(b.overrideBooks)})`,
      b.overrideBooks?.code === 200 && b.overrideBooks?.rate === 600);
    t(`D2: ...and refuses a class only Austria has (${j(b.overrideR2)})`, b.overrideR2?.code === 400);
    t(`S1: the filter is handed the operator rows and the settings (${j(b.seen)})`, b.seen?.[0]?.n === 4 && b.seen?.[0]?.shop === 'GR');
  }
  const c = r.throws && !r.throws.error ? r.throws : null;
  if (c) {
    t(`S1: a throwing filter — fail closed, Germany refused again (${j(c.deQuote)})`, c.deQuote.code === 409);
    t(`S1: ...domestic still priced (${j(c.domestic)})`, c.domestic.code === 200 && c.domestic.tax === 2400);
  }
}

const names = Object.keys(results);
const shape = (r) => j(Object.fromEntries(Object.entries(r).map(([k, v]) => [k,
  v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([, x]) => x && typeof x === 'object' && 'code' in x)
    .map(([kk, x]) => [kk, [x.code, x.tax ?? null, x.rate ?? null]])) : v])));
check(`the three drivers ran (${names.join(', ')})`, names.length === 3);
if (names.length === 3) {
  check('the three drivers produce identical results',
    shape(results.lowdb) === shape(results.libsql) && shape(results.libsql) === shape(results.relational));
}

await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
