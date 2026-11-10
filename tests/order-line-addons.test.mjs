#!/usr/bin/env node
/**
 * PLUGIN_HOOKS.ORDER_LINE_ADDONS, and the PRODUCT_PRICE bug it had to fix first.
 *
 *  B1  THE PRODUCT_PRICE BUG. `priceBasket` never applied PRODUCT_PRICE, but
 *      `placeOrder` did, for each stored line's `total_cents`. With any plugin
 *      on the hook, the quote and the order total charged the catalogue price
 *      while the order's lines said the discounted one. No plugin needed for
 *      the defect beyond one using a documented hook.
 *  B2  The stored lines are frozen from the SAME priced lines as the totals,
 *      in the order's currency, and an ORDER_LINE_EXTRAS patch cannot set a
 *      line's price or add-ons.
 *  A1  Shape: an unknown `addons` shape is a 400 naming the problem, on the
 *      quote and the order alike, before any stock moves.
 *  A2  Pricing: the hook gets the raw line (prescription as posted) and the
 *      settings; add-ons go on the unit price before coupons and tax; the
 *      order freezes them as OrderItem.addons; quote = order.
 *  A3  Fail closed: a refusal is a 400 with the plugin's code; a selection
 *      nothing handles, or that came back unpriced, is a 400; a filter that
 *      throws, returns a Promise or returns garbage is a 500 — and nothing is
 *      placed or reserved.
 *  A4  Display: the receipt, the confirmation email and the shared reader.
 *  S   All of it through the REAL routes on all three storage drivers, which
 *      must agree.
 *
 * Run with:  node tests/order-line-addons.test.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, loadTs } from './lib/load.mjs';

const SECRET = 'order-line-addons-secret-0123456789abcdef';

/* ---------------------------------------------------------------- child --- */

async function child(M) {
  const { LocalDB, pluginManager, PLUGIN_HOOKS } = M;
  const out = {};
  const guard = async (key, fn) => {
    try { out[key] = await fn(); } catch (err) { out[key] = { error: String(err?.stack || err).slice(0, 600) }; }
  };
  let seq = 0;
  const product = (extra = {}) => LocalDB.createProduct({
    status: 'active', price_cents: 10000, categories: [], images: [], on_sale: false,
    name: `ola-${++seq}`, slug: `ola-${seq}`, stock: 50, in_stock: true, requires_shipping: false,
    ...extra,
  });
  let ipSeq = 0;
  const nextIp = () => `100.67.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`;
  const call = async (handler, url, body) => {
    const res = await handler({
      request: new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      locals: { user: null, ip: nextIp() },
      url: new URL(url),
      params: {},
    });
    const json = await res.json().catch(() => null);
    return { code: res.status, data: json?.data, reason: json?.error?.reason ?? null, message: json?.error?.message ?? null, params: json?.error?.params ?? null };
  };
  let mail = 0;
  const quote = async (items, extra = {}) => {
    const r = await call(M.postQuote, 'http://localhost/api/orders/quote', { items, ...extra });
    return {
      code: r.code, reason: r.reason, message: r.message, params: r.params,
      subtotal: r.data?.subtotal_cents ?? null, discount: r.data?.discount_cents ?? null,
      tax: r.data?.tax_cents ?? null, total: r.data?.total_cents ?? null,
      lineUnit: r.data?.lines?.[0]?.unit_price_cents ?? null,
      lineAddons: r.data?.lines?.[0]?.addons ?? null,
    };
  };
  const place = async (items, extra = {}) => {
    const r = await call(M.postOrder, 'http://localhost/api/orders', {
      items, email: `ola${++mail}@example.com`, name: 'Buyer', ...extra,
    });
    const number = r.data?.number;
    const stored = number ? (await LocalDB.getOrders()).find((o) => o.number === number) : undefined;
    return {
      code: r.code, reason: r.reason, message: r.message, params: r.params,
      subtotal: stored?.subtotal_cents ?? null, discount: stored?.discount_cents ?? null,
      tax: stored?.tax_cents ?? null, total: stored?.total_cents ?? null,
      items: stored?.items?.map((i) => ({ total: i.total_cents, addons: i.addons ?? null, rx: i.prescription ? 'yes' : null })) ?? null,
      lineSum: stored?.items?.reduce((s, i) => s + i.total_cents, 0) ?? null,
    };
  };
  const stockOf = async (id) => (await LocalDB.getProduct(id))?.stock;
  // Every stock reservation, counted: a refused selection must be refused
  // BEFORE any unit is taken, not taken and handed back (another buyer could
  // get a 409 in between). The end-state stock cannot show that; this can.
  let reserves = 0;
  const realReserve = LocalDB.reserveStock.bind(LocalDB);
  LocalDB.reserveStock = async (...a) => { reserves++; return realReserve(...a); };
  const reservesDuring = async (fn) => { const before = reserves; await fn(); return reserves - before; };
  const orderCount = async () => (await LocalDB.getOrders()).length;
  const register = (id, filters) => {
    pluginManager.registerPlugin({ id, name: id, version: '1.0.0', description: '', author: 'test', filters });
    pluginManager.activatePlugin(id);
  };

  // A Greek shop, NET prices so a 24% tax line is easy to read.
  const settings = {
    tax_enabled: true, shop_country: 'GR', tax_prices_include_tax: false,
    tax_rates: [{ class: 'standard', label: 'Standard', rate_bp: 2400 }],
    ola_marker: 'from-settings',
  };
  for (const [k, v] of Object.entries(settings)) await LocalDB.updateSetting(k, v);
  await LocalDB.createCoupon({ code: 'TENOFF', kind: 'percent', value: 1000, enabled: true, used_count: 0 });

  /* ---- B1: PRODUCT_PRICE alone ---- */
  await guard('price', async () => {
    const r = {};
    const p = await product();
    register('test-price', {
      [PLUGIN_HOOKS.PRODUCT_PRICE]: (cents) => Math.round(cents * 0.9),
    });
    const items = [{ product_id: p.id, qty: 2 }];
    r.quote = await quote(items);
    r.order = await place(items);
    pluginManager.deactivatePlugin('test-price');
    register('test-price-bad', { [PLUGIN_HOOKS.PRODUCT_PRICE]: () => 12.5 });
    r.badQuote = await quote(items);
    r.badOrder = await place(items);
    pluginManager.deactivatePlugin('test-price-bad');
    // An ORDER_LINE_EXTRAS patch that tries to set the money.
    register('test-patch', {
      [PLUGIN_HOOKS.ORDER_LINE_EXTRAS]: (cur) => (cur.ok ? { ok: true, patch: { total_cents: 1, addons: [{ id: 'x', label: 'Free money', unit_price_cents: 0 }], note_tag: 'kept' } } : cur),
    });
    r.patched = await place(items);
    const last = (await LocalDB.getOrders()).find((o) => o.items?.[0]?.note_tag === 'kept');
    r.patchedTotal = last?.items?.[0]?.total_cents ?? null;
    r.patchedAddons = last?.items?.[0]?.addons ?? null;
    pluginManager.deactivatePlugin('test-patch');
    return r;
  });

  /* ---- A3: a selection with NO add-on plugin installed ---- */
  await guard('unsupported', async () => {
    const r = {};
    const p = await product();
    r.hookName = PLUGIN_HOOKS.ORDER_LINE_ADDONS ?? null;
    const before = await orderCount();
    r.quote = await quote([{ product_id: p.id, qty: 1, addons: { lens: ['ar'] } }]);
    r.reservedWhileRefusing = await reservesDuring(async () => { r.order = await place([{ product_id: p.id, qty: 1, addons: { lens: ['ar'] } }]); });
    r.placedNothing = (await orderCount()) === before;
    r.stock = await stockOf(p.id);
    // "Nothing chosen" is not a selection.
    r.empty = await place([{ product_id: p.id, qty: 1, addons: { lens: [] } }]);
    r.nullAddons = await quote([{ product_id: p.id, qty: 1, addons: null }]);
    return r;
  });

  /* ---- A1: shapes, refused before anything moves ---- */
  await guard('shape', async () => {
    const r = {};
    const p = await product();
    const bad = {
      array: ['ar'],
      string: 'ar',
      number: 5,
      badKey: { 'Bad Key': ['ar'] },
      upperKey: { Lens: ['ar'] },
      tooMany: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, ['x']])),
      tooDeep: { lens: [[[[['x']]]]] },
      tooBig: { lens: ['x'.repeat(2100)] },
    };
    for (const [k, v] of Object.entries(bad)) {
      const q = await quote([{ product_id: p.id, qty: 1, addons: v }]);
      const o = await place([{ product_id: p.id, qty: 1, addons: v }]);
      r[k] = { q: [q.code, q.reason], o: [o.code, o.reason], named: typeof o.message === 'string' && /Add-ons for/.test(o.message) };
    }
    r.stock = await stockOf(p.id);
    return r;
  });

  /* ---- A2: the hook prices add-ons ---- */
  await guard('addons', async () => {
    const r = {};
    const seen = [];
    const CAT = { ar: { label: 'Anti-reflective', cents: 2500 }, idx: { label: 'Index 1.60', cents: 4000 }, zero: { label: 'Free case', cents: 0 } };
    register('test-lens', {
      [PLUGIN_HOOKS.ORDER_LINE_ADDONS ?? 'order_line_addons']: (current, ctx) => {
        seen.push({
          sph: ctx?.line?.prescription?.right?.sph ?? null,
          marker: ctx?.settings?.ola_marker ?? null,
          qty: ctx?.qty, name: ctx?.name, variant: !!ctx?.variant, product: ctx?.product?.id === p.id,
        });
        if (!current.ok) return current;
        const sel = ctx?.line?.addons?.lens;
        if (sel == null) return current;
        const out = [];
        for (const id of sel) {
          if (!CAT[id]) return { ok: false, message: `Unknown option ${id}`, code: 'test.unknown_option', params: { option: id } };
          out.push({ id, label: CAT[id].label, unit_price_cents: CAT[id].cents, source: 'test-lens', kind: 'coating' });
        }
        return { ok: true, addons: [...current.addons, ...out] };
      },
    });
    const p = await product({ stock: 20 });
    const rx = { right: { sph: '-2.50' }, left: { sph: '-2.00' } };
    const items = [{ product_id: p.id, qty: 2, addons: { lens: ['ar', 'idx'] }, prescription: rx }];
    seen.length = 0;
    r.quote = await quote(items);
    r.seenQuote = seen.slice(0, 1);
    seen.length = 0;
    r.order = await place(items);
    r.seenOrder = seen.slice(0, 1);
    r.coupon = await quote(items, { coupon_code: 'TENOFF' });
    r.couponOrder = await place(items, { coupon_code: 'TENOFF' });
    // A line without a selection is untouched.
    r.plain = await place([{ product_id: p.id, qty: 1 }]);
    // An add-on priced at 0 is recorded, not refused as unpriced.
    r.zero = await place([{ product_id: p.id, qty: 1, addons: { lens: ['zero'] } }]);
    // Refusal: the plugin's own code, on both routes.
    const stockBefore = await stockOf(p.id);
    const countBefore = await orderCount();
    r.refusedQuote = await quote([{ product_id: p.id, qty: 1, addons: { lens: ['nope'] } }]);
    // A key this plugin does not handle: unpriced, never dropped.
    r.unpricedQuote = await quote([{ product_id: p.id, qty: 1, addons: { engraving: ['x'] } }]);
    r.reservedWhileRefusing = await reservesDuring(async () => {
      r.refusedOrder = await place([{ product_id: p.id, qty: 1, addons: { lens: ['nope'] } }]);
      r.unpricedOrder = await place([{ product_id: p.id, qty: 1, addons: { engraving: ['x'] } }]);
    });
    // A second line in the same basket is refused as a whole.
    r.mixed = await place([{ product_id: p.id, qty: 1 }, { product_id: p.id, qty: 1, addons: { lens: ['nope'] } }]);
    r.stockKept = (await stockOf(p.id)) === stockBefore;
    r.nothingPlaced = (await orderCount()) === countBefore;
    // With PRODUCT_PRICE too: add-ons go on top of the hook's price.
    register('test-price2', { [PLUGIN_HOOKS.PRODUCT_PRICE]: (cents) => cents - 1000 });
    r.both = await quote([{ product_id: p.id, qty: 1, addons: { lens: ['ar'] } }]);
    r.bothOrder = await place([{ product_id: p.id, qty: 1, addons: { lens: ['ar'] } }]);
    pluginManager.deactivatePlugin('test-price2');
    // B2: a converted order freezes its lines and add-ons in ITS currency.
    await LocalDB.updateSetting('shop_currencies', [{ code: 'USD', rate_ppm: 1_100_000, enabled: true, updated_at: new Date().toISOString() }]);
    const fxItems = [{ product_id: p.id, qty: 1, addons: { lens: ['ar'] } }];
    r.fxQuote = await quote(fxItems, { currency: 'USD' });
    r.fxOrder = await place(fxItems, { currency: 'USD' });
    await LocalDB.updateSetting('shop_currencies', []);
    pluginManager.deactivatePlugin('test-lens');
    return r;
  });

  /* ---- A3: broken filters fail closed ---- */
  await guard('broken', async () => {
    const r = {};
    const hook = PLUGIN_HOOKS.ORDER_LINE_ADDONS ?? 'order_line_addons';
    const p = await product({ stock: 10 });
    const items = [{ product_id: p.id, qty: 1, addons: { lens: ['ar'] } }];
    const cases = {
      throws: () => { throw new Error('boom'); },
      promise: async (cur) => cur,
      garbage: () => 'yes',
      negative: (cur) => ({ ok: true, addons: [...cur.addons, { id: 'ar', label: 'AR', unit_price_cents: -100 }] }),
      fraction: (cur) => ({ ok: true, addons: [...cur.addons, { id: 'ar', label: 'AR', unit_price_cents: 10.5 }] }),
      noLabel: (cur) => ({ ok: true, addons: [...cur.addons, { id: 'ar', unit_price_cents: 100 }] }),
      ignores: (cur) => cur,
    };
    const before = await orderCount();
    for (const [k, fn] of Object.entries(cases)) {
      register(`test-broken-${k}`, { [hook]: fn });
      const q = await quote(items);
      let o;
      const held = await reservesDuring(async () => { o = await place(items); });
      r[k] = { q: [q.code, q.reason], o: [o.code, o.reason], held };
      pluginManager.deactivatePlugin(`test-broken-${k}`);
    }
    // A throwing filter AFTER one that priced: still refused (the price from
    // before the throw is not trusted).
    register('test-ok-first', { [hook]: (cur) => ({ ok: true, addons: [...cur.addons, { id: 'ar', label: 'AR', unit_price_cents: 100 }] }) });
    register('test-throws-after', { [hook]: () => { throw new Error('late boom'); } });
    const q = await quote(items);
    const o = await place(items);
    r.throwsAfter = { q: [q.code, q.reason], o: [o.code, o.reason] };
    pluginManager.deactivatePlugin('test-ok-first');
    pluginManager.deactivatePlugin('test-throws-after');
    r.nothingPlaced = (await orderCount()) === before;
    r.stock = await stockOf(p.id);
    return r;
  });

  return out;
}

if (process.env.ORDER_LINE_ADDONS_CHILD) {
  const M = await loadTs('tests/fixtures/checkout-entry.ts', 'orderlineaddons');
  await M.LocalDB.init();
  // Quiet the expected filter errors; the parent asserts on behaviour.
  console.error = () => {};
  const result = await child(M);
  console.log('__RESULT__' + JSON.stringify(result));
  process.exit(0);
}

/* --------------------------------------------------------------- parent --- */
let pass = 0;
let fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };
const j = JSON.stringify;

/* ---------------------------------------------- unit: parse + price (pure) */
const A = await loadTs('src/lib/commerce/line-addons.ts');
const SYS = await loadTs('src/lib/plugin-system.ts');
{
  check('A1: no addons is fine', j(A.parseLineAddons(undefined)) === j({ ok: true, value: undefined, selected: [] }));
  const ok = A.parseLineAddons({ lens: ['ar'], gift: null, engraving: [] });
  check(`A1: only real selections count as selected (${j(ok)})`, ok.ok && j(ok.selected) === j(['lens']));
  for (const [name, v] of [
    ['an array', ['ar']], ['a string', 'ar'], ['a Date', new Date()], ['a Map', new Map()],
    ['a bad key', { 'Bad Key': 1 }], ['an upper-case key', { Lens: 1 }], ['nine keys', Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, 1]))],
    ['too deep', { lens: [[[[1]]]] }], ['a function value', { lens: () => 1 }], ['NaN', { lens: [NaN] }], ['over 2048 bytes', { lens: 'x'.repeat(2100) }],
  ]) {
    const r = A.parseLineAddons(v, 'Frame X');
    check(`A1: ${name} is refused, 400 checkout.addons_invalid, naming the line (${j(r)})`,
      !r.ok && r.status === 400 && r.code === 'checkout.addons_invalid' && /Frame X/.test(r.message));
  }
  check('A1: exactly 4 levels is accepted', A.parseLineAddons({ lens: [[['x']]] }).ok);
  check('A1: isEmptySelection — null, [], {}, blank string', ['', '  ', null, [], {}].every(A.isEmptySelection) && ![0, false, ['x'], { a: 1 }, 'x'].some(A.isEmptySelection));

  const mk = (fns) => {
    const pm = new SYS.PluginManager();
    fns.forEach((fn, i) => { pm.registerPlugin({ id: `f${i}`, name: 'f', version: '1', description: '', author: 't', filters: { [SYS.PLUGIN_HOOKS.ORDER_LINE_ADDONS]: fn } }); pm.activatePlugin(`f${i}`); });
    return pm;
  };
  const base = { product: { id: 'p' }, variant: {}, qty: 1, name: 'Frame X', settings: { s: 1 } };
  const price = (line, fns) => {
    const err = console.error; console.error = () => {};
    try { return A.priceLineAddons({ ...base, line }, mk(fns)); } finally { console.error = err; }
  };
  check('A2: hook constant exists', SYS.PLUGIN_HOOKS.ORDER_LINE_ADDONS === 'order_line_addons');
  check('A3: no filter + no selection is fine', j(A.priceLineAddons({ ...base, line: {} }, new SYS.PluginManager())) === j({ ok: true, addons: [], unit_cents: 0 }));
  const unsup = A.priceLineAddons({ ...base, line: { addons: { lens: ['a'] } } }, new SYS.PluginManager());
  check(`A3: no filter + a selection: 400 checkout.addons_unsupported (${j(unsup)})`, !unsup.ok && unsup.status === 400 && unsup.code === 'checkout.addons_unsupported' && unsup.params?.namespace === 'lens');

  // Tagged add-ons: each key is checked separately.
  const tagged = (ns) => (cur) => ({ ok: true, addons: [...cur.addons, { id: 'a', label: 'A', unit_price_cents: 1, namespace: ns }] });
  const two = price({ addons: { lens: ['a'], gift: ['b'] } }, [tagged('lens')]);
  check(`A3: with tagged add-ons, an unpriced second key is refused (${j(two)})`, !two.ok && two.code === 'checkout.addons_unpriced' && two.params?.namespace === 'gift');
  const both = price({ addons: { lens: ['a'], gift: ['b'] } }, [tagged('lens'), tagged('gift')]);
  check('A3: ...and accepted when both keys are priced', both.ok && both.unit_cents === 2);
  const untaggedFn = (cur) => ({ ok: true, addons: [...cur.addons, { id: 'a', label: 'A', unit_price_cents: 7 }] });
  const untagged = price({ addons: { lens: ['a'] } }, [untaggedFn]);
  // The optical module's add-ons are untagged. A second key it does not
  // price (a typo, a module that is not installed) must not hide behind them.
  const typo = price({ addons: { lens: ['a'], lense: ['b'] } }, [untaggedFn]);
  check(`A3: untagged add-ons answer at most ONE key — a second, unpriced key is refused (${j(typo)})`,
    !typo.ok && typo.code === 'checkout.addons_unpriced' && typo.params?.namespace === 'lense');
  const taggedPlusUntagged = price({ addons: { lens: ['a'], gift: ['b'] } }, [untaggedFn, tagged('gift')]);
  check('A2: one untagged key plus one tagged key, both priced, is accepted', taggedPlusUntagged.ok && taggedPlusUntagged.unit_cents === 8);
  const taggedFails = price({ addons: { lens: ['a'], gift: ['b'], wrap: ['c'] } }, [untaggedFn, tagged('gift')]);
  check('A3: ...but a third, unpriced key is still refused', !taggedFails.ok && taggedFails.params?.namespace === 'wrap');
  check('A2: an untagged add-on answers a one-key selection', untagged.ok && untagged.unit_cents === 7);

  // The filter gets a COPY of the line, and only known add-on fields survive.
  const line = { addons: { lens: ['a'] }, prescription: { right: { sph: '-1.00' } } };
  const copied = price(line, [(cur, ctx) => { ctx.line.addons.lens.push('evil'); ctx.settings.s = 2; return { ok: true, addons: [{ id: ' a ', label: ' AR ', unit_price_cents: 5, extra: 'dropped', source: 'x' }] }; }]);
  check(`A2: a filter editing ctx.line does not change the caller's line (${j(line)})`, j(line.addons.lens) === j(['a']));
  check(`A2: returned add-ons are rebuilt field by field (${j(copied)})`, copied.ok && j(copied.addons) === j([{ id: 'a', label: 'AR', unit_price_cents: 5, source: 'x' }]));
  check('A2: ctx.settings is a copy', base.settings.s === 1);

  const refusal = price({ addons: { lens: ['a'] } }, [() => ({ ok: false, message: 'No', code: 'x.no', params: { a: 1, bad: { o: 1 } } })]);
  check(`A3: a refusal is a 400 with the plugin's code and scalar params only (${j(refusal)})`, !refusal.ok && refusal.status === 400 && refusal.code === 'x.no' && j(refusal.params) === j({ a: 1 }));
  const tooMany = price({}, [(cur) => ({ ok: true, addons: Array.from({ length: 33 }, (_, i) => ({ id: `a${i}`, label: 'A', unit_price_cents: 1 })) })]);
  check('A3: more than 32 add-ons on a line is a 500', !tooMany.ok && tooMany.status === 500);
  const huge = price({}, [() => ({ ok: true, addons: [{ id: 'a', label: 'A', unit_price_cents: 1_000_000_001 }] })]);
  check('A3: an absurd unit price is a 500', !huge.ok && huge.status === 500);
  {
    let unhandled = 0;
    const on = () => { unhandled++; };
    process.on('unhandledRejection', on);
    const rej = price({ addons: { lens: ['a'] } }, [async () => { throw new Error('async boom'); }]);
    await new Promise((r) => setTimeout(r, 20));
    process.off('unhandledRejection', on);
    check(`A3: a rejecting async filter is a 500 and leaves no unhandledRejection (${unhandled})`, !rej.ok && rej.status === 500 && unhandled === 0);
  }
  check('owner decision: COUPONS_DISCOUNT_ADDONS is exported and currently true', A.COUPONS_DISCOUNT_ADDONS === true);
}

/* ---------------------------------------------------- A4: display readers */
{
  const D = await loadTs('src/lib/commerce/line-addons-display.ts');
  const fmt = (c) => `€${(c / 100).toFixed(2)}`;
  const shown = D.lineAddonsForDisplay({ qty: 2, addons: [{ id: 'ar', label: 'Anti-reflective', unit_price_cents: 2500 }, { label: '', unit_price_cents: 1 }, { label: 'x', unit_price_cents: 'NaN' }, null] }, fmt);
  check(`A4: one row per well-formed add-on, amount = unit × qty (${j(shown)})`, j(shown) === j([{ label: 'Anti-reflective', amount: '€50.00' }]));
  check('A4: a line without add-ons shows none', j(D.lineAddonsForDisplay({ qty: 1 }, fmt)) === '[]');

  process.env.AUTH_SECRET ||= SECRET;
  const R = await loadTs('src/lib/commerce/receipt.ts');
  const order = {
    id: 'o1', number: 'OG-1', created_at: '2026-10-12T00:00:00Z', currency: 'EUR', status: 'pending',
    total_cents: 33000, subtotal_cents: 33000,
    items: [{ name: 'Frame', qty: 2, total_cents: 33000, addons: [{ id: 'ar', label: 'Anti-reflective', unit_price_cents: 2500 }] }],
  };
  const view = R.receiptView(order, fmt);
  check(`A4: the receipt view carries the add-ons (${j(view.lines[0].addons)})`, j(view.lines[0].addons) === j([{ label: 'Anti-reflective', amount: '€50.00' }]));
  check('A4: ...and the line total is the stored one, not re-added', view.lines[0].total === '€330.00');

  // The PDF draws the add-on rows (and still renders a view with none).
  {
    const P = await loadTs('src/lib/commerce/receipt-pdf.ts');
    const S = await loadTs('src/lib/i18n/public-strings.ts');
    const font = new Uint8Array(await fs.readFile(path.join(ROOT, 'public/fonts/DejaVuSans.ttf')));
    const parties = { seller: 'Shop', sellerAddress: '', sellerVat: '', buyer: 'B', buyerAddress: '' };
    const pdf = (v) => P.receiptPdfBytes(v, S.publicStrings('en').receipt, parties, font);
    try {
      const plain = await pdf({ ...view, lines: view.lines.map((l) => ({ ...l, addons: [] })) });
      const withAddons = await pdf(view);
      const many = await pdf({ ...view, lines: [{ ...view.lines[0], addons: Array.from({ length: 80 }, (_, i) => ({ label: `Option ${i} with a fairly long label that wraps onto a second line`, amount: '€1.00' })) }] });
      const { PDFDocument } = await import('pdf-lib');
      const pages = (await PDFDocument.load(many)).getPageCount();
      check(`A4: the receipt PDF draws the add-on rows (${plain.length} → ${withAddons.length} bytes) and paginates many (${pages} pages)`,
        withAddons.length > plain.length && pages > 1);
    } catch (err) {
      check(`A4: the receipt PDF renders add-ons (${err.message})`, false);
    }
  }

  const C = await loadTs('src/lib/commerce/order-confirmation.ts');
  const mail = C.buildOrderConfirmation({ ...order, email: 'b@example.com' }, {});
  check(`A4: the confirmation email lists the add-on, text and HTML (${j(mail?.text?.slice(0, 200))})`,
    /\+ Anti-reflective/.test(mail?.text ?? '') && /\+ Anti-reflective/.test(mail?.html ?? ''));
  const hostile = C.buildOrderConfirmation({ ...order, email: 'b@example.com', items: [{ ...order.items[0], addons: [{ id: 'x', label: '<script>x</script>', unit_price_cents: 1 }] }] }, {});
  check('A4: an add-on label is escaped in the email HTML', !/<script>x/.test(hostile?.html ?? '') && /&lt;script&gt;/.test(hostile?.html ?? ''));
}

/* --------------------------------------- S: real routes, three drivers */
const tmpRoot = path.join(os.tmpdir(), `astrobaas-order-line-addons-${process.pid}`);
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
      ...process.env, ORDER_LINE_ADDONS_CHILD: '1', NODE_ENV: 'test', AUTH_SECRET: SECRET,
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

  const pr = r.price && !r.price.error ? r.price : null;
  if (pr) {
    // 10000 × 0.9 = 9000, × 2 = 18000 net; 24% = 4320.
    t(`B1: the QUOTE applies PRODUCT_PRICE (${j(pr.quote)})`, pr.quote.code === 200 && pr.quote.subtotal === 18000 && pr.quote.tax === 4320 && pr.quote.total === 22320);
    t(`B1: the ORDER total applies it too (${j(pr.order)})`, pr.order.code === 201 && pr.order.subtotal === 18000 && pr.order.total === 22320);
    t(`B1: ...and the stored lines sum to the order subtotal (${j(pr.order.items)})`, pr.order.lineSum === pr.order.subtotal && pr.order.items?.[0]?.total === 18000);
    t(`B1: a non-integer PRODUCT_PRICE refuses the quote as well as the order (${j([pr.badQuote.code, pr.badOrder.code])})`,
      pr.badQuote.code === 500 && pr.badOrder.code === 500);
    t(`B2: an ORDER_LINE_EXTRAS patch cannot set the line price or add-ons (${j([pr.patchedTotal, pr.patchedAddons])})`,
      pr.patched.code === 201 && pr.patchedTotal === 20000 && pr.patchedAddons === null);
  }

  const un = r.unsupported && !r.unsupported.error ? r.unsupported : null;
  if (un) {
    t(`A3: no add-on plugin — the quote refuses a selection (${j(un.quote)})`, un.quote.code === 400 && un.quote.reason === 'checkout.addons_unsupported');
    t(`A3: ...and so does the order, placing and reserving nothing (${j(un.order)})`, un.order.code === 400 && un.order.reason === 'checkout.addons_unsupported' && un.placedNothing && un.stock === 50);
    t(`A3: ...without reserving any stock first (${un.reservedWhileRefusing})`, un.reservedWhileRefusing === 0);
    t(`A1: an empty selection is not a selection (${j([un.empty.code, un.nullAddons.code])})`, un.empty.code === 201 && un.nullAddons.code === 200);
  }

  const sh = r.shape && !r.shape.error ? r.shape : null;
  if (sh) {
    for (const k of ['array', 'string', 'number', 'badKey', 'upperKey', 'tooMany', 'tooDeep', 'tooBig']) {
      const c = sh[k];
      t(`A1: addons ${k} — 400 checkout.addons_invalid on quote and order, naming the problem (${j(c)})`,
        c && c.q[0] === 400 && c.q[1] === 'checkout.addons_invalid' && c.o[0] === 400 && c.o[1] === 'checkout.addons_invalid' && c.named);
    }
    t(`A1: no stock moved for a refused shape (${sh.stock})`, sh.stock === 50);
  }

  const ad = r.addons && !r.addons.error ? r.addons : null;
  if (ad) {
    // (10000 + 2500 + 4000) × 2 = 33000 net; 24% = 7920.
    t(`A2: the quote adds the add-ons to the unit price (${j(ad.quote)})`,
      ad.quote.code === 200 && ad.quote.lineUnit === 16500 && ad.quote.subtotal === 33000 && ad.quote.tax === 7920 && ad.quote.total === 40920);
    t(`A2: the quote lists the add-ons on the line (${j(ad.quote.lineAddons)})`,
      j(ad.quote.lineAddons?.map((a) => [a.id, a.label, a.unit_price_cents])) === j([['ar', 'Anti-reflective', 2500], ['idx', 'Index 1.60', 4000]]));
    t(`A2: the order charges exactly what the quote said (${j(ad.order)})`,
      ad.order.code === 201 && ad.order.subtotal === 33000 && ad.order.tax === 7920 && ad.order.total === 40920);
    t(`A2: the line freezes its total and its add-ons from the same priced line (${j(ad.order.items)})`,
      ad.order.items?.[0]?.total === 33000 && ad.order.lineSum === 33000
      && j(ad.order.items?.[0]?.addons?.map((a) => [a.id, a.label, a.unit_price_cents, a.source])) === j([['ar', 'Anti-reflective', 2500, 'test-lens'], ['idx', 'Index 1.60', 4000, 'test-lens']]));
    t(`A2: the hook gets the raw prescription, the settings, qty, product and variant — quote (${j(ad.seenQuote)})`,
      ad.seenQuote?.[0]?.sph === '-2.50' && ad.seenQuote?.[0]?.marker === 'from-settings' && ad.seenQuote?.[0]?.qty === 2 && ad.seenQuote?.[0]?.variant && !!ad.seenQuote?.[0]?.product);
    t(`A2: ...and order (${j(ad.seenOrder)})`, ad.seenOrder?.[0]?.sph === '-2.50' && ad.seenOrder?.[0]?.marker === 'from-settings');
    // Owner decision 1 = yes: 10% of 33000 = 3300, add-ons included.
    t(`A2: a coupon discounts the add-ons too (COUPONS_DISCOUNT_ADDONS) — quote (${j(ad.coupon)})`, ad.coupon.code === 200 && ad.coupon.discount === 3300);
    t(`A2: ...and order (${j(ad.couponOrder)})`, ad.couponOrder.code === 201 && ad.couponOrder.discount === 3300 && ad.couponOrder.total === ad.coupon.total);
    t(`A2: a line without a selection is priced as before (${j(ad.plain)})`, ad.plain.code === 201 && ad.plain.subtotal === 10000 && ad.plain.items?.[0]?.addons === null);
    t(`A2: a 0-cent add-on is recorded (${j(ad.zero.items)})`, ad.zero.code === 201 && ad.zero.items?.[0]?.addons?.[0]?.unit_price_cents === 0);
    t(`A3: a plugin refusal is a 400 with its code — quote (${j(ad.refusedQuote)})`, ad.refusedQuote.code === 400 && ad.refusedQuote.reason === 'test.unknown_option' && ad.refusedQuote.params?.option === 'nope');
    t(`A3: ...and order (${j(ad.refusedOrder)})`, ad.refusedOrder.code === 400 && ad.refusedOrder.reason === 'test.unknown_option');
    t(`A3: a key no plugin priced is refused, never dropped — quote (${j(ad.unpricedQuote)})`, ad.unpricedQuote.code === 400 && ad.unpricedQuote.reason === 'checkout.addons_unpriced');
    t(`A3: ...and order (${j(ad.unpricedOrder)})`, ad.unpricedOrder.code === 400 && ad.unpricedOrder.reason === 'checkout.addons_unpriced');
    t(`A3: one refused line refuses the basket (${j(ad.mixed.code)})`, ad.mixed.code === 400);
    t('A3: refusals placed nothing and released all stock', ad.nothingPlaced && ad.stockKept);
    t(`A3: a refused or unpriced selection reserves no stock at all, not even briefly (${ad.reservedWhileRefusing})`, ad.reservedWhileRefusing === 0);
    // (10000 + 2500) × 1.1 = 13750 USD; the add-on 2750 USD.
    t(`B2: a converted quote lists the add-on in the quote's currency (${j(ad.fxQuote)})`,
      ad.fxQuote.code === 200 && ad.fxQuote.subtotal === 13750 && ad.fxQuote.lineAddons?.[0]?.unit_price_cents === 2750);
    t(`B2: a converted order freezes its line and add-on in the order's currency, summing to its subtotal (${j(ad.fxOrder)})`,
      ad.fxOrder.code === 201 && ad.fxOrder.subtotal === 13750 && ad.fxOrder.items?.[0]?.total === 13750
      && ad.fxOrder.items?.[0]?.addons?.[0]?.unit_price_cents === 2750);
    // PRODUCT_PRICE 10000 → 9000, + 2500 = 11500.
    t(`A2+B1: add-ons go on top of the PRODUCT_PRICE price — quote (${j(ad.both)})`, ad.both.code === 200 && ad.both.subtotal === 11500);
    t(`A2+B1: ...and order (${j(ad.bothOrder)})`, ad.bothOrder.code === 201 && ad.bothOrder.subtotal === 11500 && ad.bothOrder.items?.[0]?.total === 11500);
  }

  const br = r.broken && !r.broken.error ? r.broken : null;
  if (br) {
    for (const k of ['throws', 'promise', 'garbage', 'negative', 'fraction', 'noLabel', 'throwsAfter']) {
      const c = br[k];
      t(`A3: a filter that ${k} — 500 checkout.addons_failed on quote and order (${j(c)})`,
        c && c.q[0] === 500 && c.q[1] === 'checkout.addons_failed' && c.o[0] === 500 && c.o[1] === 'checkout.addons_failed');
    }
    t(`A3: a filter that ignores the selection — 400 checkout.addons_unpriced (${j(br.ignores)})`,
      br.ignores && br.ignores.q[0] === 400 && br.ignores.q[1] === 'checkout.addons_unpriced' && br.ignores.o[1] === 'checkout.addons_unpriced');
    t(`A3: nothing placed, no stock held (${br.stock})`, br.nothingPlaced && br.stock === 10);
    t(`A3: a broken filter refuses BEFORE any stock is reserved (${j(['throws', 'promise', 'garbage', 'negative', 'fraction', 'noLabel', 'ignores'].map((k) => br[k]?.held))})`,
      ['throws', 'promise', 'garbage', 'negative', 'fraction', 'noLabel', 'ignores'].every((k) => br[k]?.held === 0));
  }
}

const names = Object.keys(results);
const shape = (r) => j(r, (k, v) => (k === 'message' ? undefined : v));
check(`the three drivers ran (${names.join(', ')})`, names.length === 3);
if (names.length === 3) {
  const same = shape(results.lowdb) === shape(results.libsql) && shape(results.libsql) === shape(results.relational);
  if (!same) {
    for (const n of ['libsql', 'relational']) {
      for (const k of Object.keys(results.lowdb)) {
        if (shape(results.lowdb[k]) !== shape(results[n][k])) console.error(`  differs [${n}] ${k}:\n    lowdb ${shape(results.lowdb[k]).slice(0, 600)}\n    ${n} ${shape(results[n][k]).slice(0, 600)}`);
      }
    }
  }
  check('the three drivers produce identical results', same);
}

await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
