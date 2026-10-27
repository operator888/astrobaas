#!/usr/bin/env node
/**
 * Coupons v2: three new types, conditions, email binding, plugin-issued codes.
 *
 * PURE (this process) — the maths of every type, with its edge cases:
 *  M1  percent: rounding half-up once over the eligible amount
 *  M2  fixed: larger than the subtotal is clamped to it
 *  M3  bogo50: pairs across lines by price, odd quantities, mixed prices,
 *      one unit (refused, not a zero discount), rounding once
 *  M4  free_shipping: no money off the goods, shipping waived
 *  M5  gift_product: available / out of stock / no gift id
 *  M6  conditions: categories, brands (directory-matched), min subtotal, and a
 *      code whose conditions exclude every line
 *  M7  email binding (case-insensitive), single_use, per-email limit, and the
 *      contract refusal code of every reason
 *  M8  admin normalizer: the contract's aliases, new fields, refusals
 *
 * THROUGH THE REAL ROUTES, once per storage driver in a child process:
 *  R1  an email-bound single-use code issued by host.coupons.issue: quote and
 *      order refuse another email, accept the bound one in any case, then
 *      refuse a second use (refusal codes for staff, collapsed for strangers)
 *  R2  two concurrent orders with the same single-use code: exactly one wins
 *      (forced interleaving through the route, and five at once)
 *  R3  max_redemptions_per_email under concurrency: one per buyer, atomically
 *  R4  the identical basket through quote and order, for every type
 *  R5  discount before tax; reverse charge with a coupon
 *  R6  coupons discount priced add-ons, per COUPONS_DISCOUNT_ADDONS
 *  R7  gift: added at 0, stock taken, refused when out of stock
 *  R8  cancelled before payment hands the use back once; paid keeps it;
 *      reopening counts it again
 *  R9  coupon.redeemed webhook: { code, coupon_id, order_id, email_hash }, no
 *      raw email
 *  R10 host.coupons.status / revoke; a staff coupon cannot be revoked by a plugin
 *  R11 a coupon stored in the OLD shape keeps working (no migration)
 *  R12 issue() refusals; code format
 *
 * Run with:  node tests/coupons-v2.test.mjs
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, loadTs } from './lib/load.mjs';

const SECRET = 'coupons-v2-secret-0123456789abcdef';
const j = JSON.stringify;

/* ---------------------------------------------------------------- child --- */

async function child(M) {
  const { LocalDB, pluginManager, PLUGIN_HOOKS } = M;
  const out = {};
  const guard = async (key, fn) => {
    try { out[key] = await fn(); } catch (err) { out[key] = { error: String(err?.stack || err).slice(0, 900) }; }
  };
  const host = M.externalPlugins.buildPluginHost();
  const setting = (k, v) => LocalDB.updateSetting(k, v);
  // The unpaid-order cap would refuse a buyer's third order before any coupon
  // rule is reached; it is not what these tests are about.
  await setting('orders_max_unpaid_per_buyer', 0);

  let seq = 0;
  const product = (over = {}) => LocalDB.createProduct({
    status: 'active', price_cents: 1000, categories: [], images: [], on_sale: false,
    name: `cv2-${++seq}`, slug: `cv2-${seq}`, stock: 100, in_stock: true, requires_shipping: false, ...over,
  });
  const stockOf = async (id) => (await LocalDB.getProduct(id))?.stock;
  const couponOf = async (id) => (await LocalDB.getCoupons()).find((c) => c.id === id);
  const later = (h = 48) => new Date(Date.now() + h * 3_600_000).toISOString();
  const SRC = { plugin: 'campaign-games', ref: 'lead' };

  let ipSeq = 0;
  const nextIp = () => `100.66.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`;
  const STAFF = { id: 'staff-1', role: 'admin', email: 'staff@example.com' };
  const call = async (handler, url, body, user = null) => {
    const res = await handler({
      request: new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      locals: { user, ip: nextIp() },
      url: new URL(url),
      params: {},
    });
    const json = await res.json().catch(() => null);
    return { code: res.status, data: json?.data ?? null, error: json?.error ?? null };
  };
  const quote = async (body, user = null) => {
    const r = await call(M.postQuote, 'http://localhost/api/orders/quote', body, user);
    const d = r.data;
    return {
      code: r.code,
      coupon: d?.coupon ?? null,
      totals: d ? { subtotal: d.subtotal_cents, discount: d.discount_cents, shipping: d.shipping_cents, tax: d.tax_cents, total: d.total_cents } : null,
      lines: d ? d.lines.map((l) => ({ product_id: l.product_id, qty: l.qty, unit: l.unit_price_cents, gift: l.coupon_gift === true })) : null,
    };
  };
  const order = async (body, user = null) => {
    const r = await call(M.postOrder, 'http://localhost/api/orders', { name: 'Buyer', ...body }, user);
    const number = r.data?.order?.number ?? r.data?.number ?? null;
    const stored = number ? (await LocalDB.getOrders()).find((o) => o.number === number) : null;
    return {
      code: r.code,
      // The service's code travels as `error.reason` (ApiResponseBuilder.error).
      errCode: r.error?.reason ?? r.error?.code ?? null,
      params: r.error?.params ?? null,
      id: stored?.id ?? null,
      totals: stored ? { subtotal: stored.subtotal_cents, discount: stored.discount_cents, shipping: stored.shipping_cents, tax: stored.tax_cents, total: stored.total_cents } : null,
      items: stored ? stored.items.map((i) => ({ product_id: i.product_id, qty: i.qty, total: i.total_cents, gift: i.coupon_gift === true })) : null,
      redemption: stored?.coupon_redemption ?? null,
      coupon_code: stored?.coupon_code ?? null,
    };
  };

  /* Forced interleaving, as tests/checkout-race.test.mjs does it: wrap a
   * LocalDB static so `run` executes immediately before the first matching
   * call. Proves the hook fired, so nothing below is vacuous. */
  let pending = null;
  let fired = 0;
  for (const name of ['claimCouponUse', 'createOrder', 'createWebhookDelivery']) {
    const original = LocalDB[name];
    LocalDB[name] = async function hooked(...args) {
      if (pending && pending.match(name, args)) {
        const p = pending;
        pending = null;
        fired += 1;
        await p.run();
      }
      return original.apply(this, args);
    };
  }
  const before = (match, run) => { const at = fired; pending = { match, run }; return () => fired > at; };

  // Every webhook delivery this child records, captured where it is created.
  const deliveries = [];
  {
    const original = LocalDB.createWebhookDelivery;
    LocalDB.createWebhookDelivery = async function (rec) {
      deliveries.push(rec);
      return original.call(this, rec);
    };
  }

  /* ---- R12: issue() refusals and the code it generates ---- */
  await guard('issue', async () => {
    const r = {};
    const tryIssue = async (input) => {
      try { return { ok: true, value: await host.coupons.issue(input) }; } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
    };
    const base = { type: 'percent', value: 1000, expires_at: later(), source: SRC };
    r.plain = await tryIssue(base);
    r.prefixed = await tryIssue({ ...base, prefix: 'game' });
    r.noSource = await tryIssue({ ...base, source: undefined });
    r.badPlugin = await tryIssue({ ...base, source: { plugin: '@acme/x', ref: 'r' } });
    r.noExpiry = await tryIssue({ ...base, expires_at: undefined });
    r.pastExpiry = await tryIssue({ ...base, expires_at: new Date(Date.now() - 1000).toISOString() });
    r.badType = await tryIssue({ ...base, type: 'bogus' });
    r.noValue = await tryIssue({ ...base, value: undefined });
    r.overPercent = await tryIssue({ ...base, value: 10001 });
    r.badEmail = await tryIssue({ ...base, email: 'not an email' });
    r.badPrefix = await tryIssue({ ...base, prefix: 'GA-ME' });
    r.giftMissing = await tryIssue({ type: 'gift_product', expires_at: later(), source: SRC });
    r.giftUnknown = await tryIssue({ type: 'gift_product', gift_product_id: 'nope', expires_at: later(), source: SRC });
    const variable = await product({ variants: [{ id: 'v1', options: { color: 'red' }, price_cents: 1000, stock: 3, enabled: true }], attributes: [{ name: 'color', values: ['red'] }] });
    r.giftVariable = await tryIssue({ type: 'gift_product', gift_product_id: variable.id, expires_at: later(), source: SRC });
    // An attempt to set what only the core may set is not copied through.
    const sneaky = await tryIssue({ ...base, automatic: true, used_count: -5, product_ids: ['x'] });
    const stored = sneaky.ok ? await couponOf(sneaky.value.id) : null;
    r.sneaky = { ok: sneaky.ok, automatic: stored?.automatic ?? null, used: stored?.used_count ?? null, products: stored?.product_ids ?? null, source: stored?.source ?? null };
    const codes = new Set();
    for (let i = 0; i < 20; i++) codes.add((await host.coupons.issue(base)).code);
    r.unique = codes.size;
    r.hostMembers = Object.keys(host.coupons).sort();
    return r;
  });

  /* ---- R1: email-bound single-use, through the REAL quote and order routes ---- */
  await guard('bound', async () => {
    const r = {};
    const p = await product({ price_cents: 5000 });
    const items = [{ product_id: p.id, qty: 1 }];
    const issued = await host.coupons.issue({
      type: 'percent', value: 1000, email: 'Winner@Example.com', single_use: true,
      expires_at: later(), prefix: 'GAME', source: { plugin: 'campaign-games', ref: 'lead-1' },
    });
    r.issued = issued;
    const code = issued.code.toLowerCase(); // codes are case-insensitive
    r.quoteNoEmailStaff = (await quote({ items, coupon_code: code }, STAFF)).coupon;
    r.quoteOtherStaff = (await quote({ items, coupon_code: code, email: 'other@example.com' }, STAFF)).coupon;
    r.quoteOtherPublic = (await quote({ items, coupon_code: code, email: 'other@example.com' })).coupon;
    r.quoteMine = await quote({ items, coupon_code: code, email: 'winner@example.com' });
    r.orderOther = await order({ items, coupon_code: code, email: 'other@example.com' });
    r.orderMine = await order({ items, coupon_code: code, email: 'WINNER@example.COM' });
    r.orderAgain = await order({ items, coupon_code: code, email: 'winner@example.com' });
    r.orderAgainStaff = await order({ items, coupon_code: code, email: 'winner@example.com' }, STAFF);
    r.quoteAgainStaff = (await quote({ items, coupon_code: code, email: 'winner@example.com' }, STAFF)).coupon;
    r.status = await host.coupons.status(issued.code);
    return r;
  });

  /* ---- R2: two concurrent orders with one single-use code ---- */
  await guard('race', async () => {
    const r = {};
    const p = await product({ stock: 50 });
    const items = [{ product_id: p.id, qty: 1 }];
    // (a) forced: the second order runs to completion inside the first,
    //     immediately before the first claims the use.
    const a = await host.coupons.issue({ type: 'fixed', value: 300, email: 'racer@example.com', single_use: true, expires_at: later(), source: SRC });
    let second = null;
    const hit = before((name) => name === 'claimCouponUse',
      async () => { second = await order({ items, coupon_code: a.code, email: 'racer@example.com' }); });
    const first = await order({ items, coupon_code: a.code, email: 'racer@example.com' });
    r.forced = {
      fired: hit(),
      codes: [first.code, second?.code],
      loserErr: [first, second].find((x) => x && x.code !== 201)?.errCode ?? null,
      withCode: (await LocalDB.getOrders()).filter((o) => o.coupon_code === a.code).length,
      used: (await couponOf(a.id))?.used_count,
    };
    // (b) five at once, any interleaving.
    const b = await host.coupons.issue({ type: 'fixed', value: 300, email: 'five@example.com', single_use: true, expires_at: later(), source: SRC });
    const stock0 = await stockOf(p.id);
    const res = await Promise.all(Array.from({ length: 5 }, () => order({ items, coupon_code: b.code, email: 'five@example.com' })));
    r.five = {
      placed: res.filter((x) => x.code === 201).length,
      refused: res.filter((x) => x.code === 400 && x.errCode === 'checkout.coupon_invalid').length,
      withCode: (await LocalDB.getOrders()).filter((o) => o.coupon_code === b.code).length,
      used: (await couponOf(b.id))?.used_count,
      stockTaken: stock0 - (await stockOf(p.id)),
    };
    return r;
  });

  /* ---- R3: one per buyer (max_redemptions_per_email), atomically ---- */
  await guard('perEmail', async () => {
    const r = {};
    const p = await product({ stock: 50 });
    const items = [{ product_id: p.id, qty: 1 }];
    const c = await host.coupons.issue({ type: 'percent', value: 500, max_redemptions_per_email: 1, expires_at: later(), source: SRC });
    let second = null;
    const hit = before((name) => name === 'claimCouponUse',
      async () => { second = await order({ items, coupon_code: c.code, email: 'Same@example.com' }); });
    const first = await order({ items, coupon_code: c.code, email: 'same@example.com' });
    r.fired = hit();
    r.sameBuyer = [first.code, second?.code];
    r.sameLoser = [first, second].find((x) => x && x.code !== 201)?.params ?? null;
    r.otherBuyer = (await order({ items, coupon_code: c.code, email: 'other-buyer@example.com' })).code;
    const stored = await couponOf(c.id);
    r.used = stored?.used_count;
    r.keys = Object.keys(stored?.redemptions_by_email ?? {});
    r.keyIsHash = r.keys.every((k) => /^[a-f0-9]{64}$/.test(k));
    r.noRawEmail = !JSON.stringify(stored).includes('same@example.com');
    r.quoteAgainStaff = (await quote({ items, coupon_code: c.code, email: 'SAME@example.com' }, STAFF)).coupon;
    return r;
  });

  /* ---- R4: one basket, quote and order, every type ---- */
  await guard('parity', async () => {
    const r = {};
    const ship = await LocalDB.createShippingMethod({ name: 'Courier', enabled: true, zone: { countries: ['GR'] }, rate: { kind: 'flat', amount_cents: 350 } });
    const a = await product({ price_cents: 1999, requires_shipping: true, stock: 50 });
    const b = await product({ price_cents: 1250, requires_shipping: true, stock: 50 });
    const gift = await product({ price_cents: 900, requires_shipping: true, stock: 50 });
    const items = [{ product_id: a.id, qty: 3 }, { product_id: b.id, qty: 2 }];
    const where = { shipping_country: 'GR', shipping_method_id: ship.id };
    const kinds = {
      percent: { type: 'percent', value: 1250 },
      fixed: { type: 'fixed', value: 700 },
      bogo50: { type: 'bogo50' },
      free_shipping: { type: 'free_shipping' },
      gift_product: { type: 'gift_product', gift_product_id: gift.id },
    };
    for (const [kind, spec] of Object.entries(kinds)) {
      const c = await host.coupons.issue({ ...spec, expires_at: later(), source: SRC });
      const email = `parity-${kind}@example.com`;
      const q = await quote({ items, coupon_code: c.code, email, ...where });
      const o = await order({ items, coupon_code: c.code, email, ...where });
      r[kind] = { quote: q.totals, order: o.totals, qCode: q.code, oCode: o.code, qLines: q.lines?.length, oItems: o.items?.length, coupon: q.coupon };
    }
    // Free shipping when shipping is ALREADY 0 (nothing ships): valid, changes
    // nothing, and the order agrees.
    const digital = await product({ price_cents: 2500 });
    const fs0 = await host.coupons.issue({ type: 'free_shipping', single_use: true, expires_at: later(), source: SRC });
    const q0 = await quote({ items: [{ product_id: digital.id, qty: 1 }], coupon_code: fs0.code });
    const o0 = await order({ items: [{ product_id: digital.id, qty: 1 }], coupon_code: fs0.code, email: 'fs0@example.com' });
    r.freeShipZero = { quote: q0.totals, order: o0.totals, coupon: q0.coupon, oCode: o0.code };
    return r;
  });

  /* ---- R5: discount before tax; reverse charge with a coupon ---- */
  await guard('tax', async () => {
    const r = {};
    for (const [k, v] of Object.entries({
      tax_enabled: true, shop_country: 'GR', tax_destination_mode: 'oss',
      tax_reverse_charge_enabled: true, tax_prices_include_tax: false,
      tax_rates: [
        { class: 'standard', label: 'Standard', rate_bp: 2400 },
        { class: 'standard', label: 'DE', rate_bp: 1900, country: 'DE' },
        { class: 'standard', label: 'GR', rate_bp: 2400, country: 'GR' },
      ],
    })) await setting(k, v);
    const p = await product({ price_cents: 10000 });
    const items = [{ product_id: p.id, qty: 1 }];
    const c = await host.coupons.issue({ type: 'percent', value: 1000, expires_at: later(), source: SRC });
    r.domesticQuote = (await quote({ items, coupon_code: c.code, shipping_country: 'GR' })).totals;
    r.domesticOrder = (await order({ items, coupon_code: c.code, email: 'tax1@example.com', shipping_country: 'GR' })).totals;
    const de = (tax_id) => ({ country: 'DE', line1: 'Hauptstr. 1', city: 'Berlin', postcode: '10115', ...(tax_id ? { tax_id } : {}) });
    r.rcQuote = (await quote({ items, coupon_code: c.code, shipping_address: de(), billing_address: de('DE123456789') })).totals;
    r.rcOrder = (await order({ items, coupon_code: c.code, email: 'tax2@example.com', shipping_address: de(), billing_address: de('DE123456789') })).totals;
    await setting('tax_enabled', false);
    return r;
  });

  /* ---- R6: coupons and priced add-ons ---- */
  await guard('addons', async () => {
    const r = { flag: M.lineAddons.COUPONS_DISCOUNT_ADDONS };
    pluginManager.registerPlugin({
      id: 'cv2-engrave', name: 'cv2', version: '1.0.0', description: '', author: 'test',
      filters: {
        [PLUGIN_HOOKS.ORDER_LINE_ADDONS]: (current, ctx) => {
          if (!current.ok || ctx?.line?.addons?.engrave == null) return current;
          return { ok: true, addons: [...current.addons, { id: 'engrave', label: 'Engraving', unit_price_cents: 500, source: 'cv2-engrave', kind: 'service' }] };
        },
      },
    });
    pluginManager.activatePlugin('cv2-engrave');
    const p = await product({ price_cents: 2000 });
    const items = [{ product_id: p.id, qty: 2, addons: { engrave: ['engrave'] } }];
    const pct = await host.coupons.issue({ type: 'percent', value: 1000, expires_at: later(), source: SRC });
    const bogo = await host.coupons.issue({ type: 'bogo50', expires_at: later(), source: SRC });
    r.pctQuote = (await quote({ items, coupon_code: pct.code })).totals;
    r.pctOrder = (await order({ items, coupon_code: pct.code, email: 'addon1@example.com' })).totals;
    r.bogoQuote = (await quote({ items, coupon_code: bogo.code })).totals;
    r.bogoOrder = (await order({ items, coupon_code: bogo.code, email: 'addon2@example.com' })).totals;
    pluginManager.deactivatePlugin('cv2-engrave');
    return r;
  });

  /* ---- R7: the gift ---- */
  await guard('gift', async () => {
    const r = {};
    const p = await product({ price_cents: 3000 });
    const g = await product({ price_cents: 1500, stock: 1, name: 'Gift case' });
    const c = await host.coupons.issue({ type: 'gift_product', gift_product_id: g.id, expires_at: later(), source: SRC });
    const items = [{ product_id: p.id, qty: 1 }];
    // The basket already takes the only unit: no gift.
    r.basketTakesIt = (await quote({ items: [...items, { product_id: g.id, qty: 1 }], coupon_code: c.code }, STAFF)).coupon;
    r.quote = await quote({ items, coupon_code: c.code });
    r.order = await order({ items, coupon_code: c.code, email: 'gift1@example.com' });
    r.giftStock = await stockOf(g.id);
    // Out of stock now: the quote and the order refuse it the same way.
    r.quoteOut = (await quote({ items, coupon_code: c.code }, STAFF)).coupon;
    r.orderOut = await order({ items, coupon_code: c.code, email: 'gift2@example.com' }, STAFF);
    r.orderOutPublic = await order({ items, coupon_code: c.code, email: 'gift3@example.com' });
    // Cancelling the order returns the gift's unit with the rest.
    await M.setOrderStatus(r.order.id, 'cancelled');
    r.giftStockAfterCancel = await stockOf(g.id);
    // The gift product is ALSO in the basket, with enough stock for both: the
    // quote and the order must agree (the order prices after reserving the
    // basket's own units, so they must not be counted twice).
    const g2 = await product({ price_cents: 800, stock: 2, name: 'Gift cloth' });
    const c2 = await host.coupons.issue({ type: 'gift_product', gift_product_id: g2.id, expires_at: later(), source: SRC });
    const both = [{ product_id: g2.id, qty: 1 }];
    r.alsoInBasketQuote = await quote({ items: both, coupon_code: c2.code });
    r.alsoInBasketOrder = await order({ items: both, coupon_code: c2.code, email: 'gift4@example.com' });
    r.alsoInBasketStock = await stockOf(g2.id);
    return r;
  });

  /* ---- R8: cancellation before payment ---- */
  await guard('cancel', async () => {
    const r = {};
    const p = await product({ stock: 20 });
    const items = [{ product_id: p.id, qty: 1 }];
    const c = await host.coupons.issue({ type: 'fixed', value: 100, email: 'cancel@example.com', single_use: true, expires_at: later(), source: SRC });
    const o1 = await order({ items, coupon_code: c.code, email: 'cancel@example.com' });
    r.placed = o1.code;
    r.usedAfterOrder = (await couponOf(c.id))?.used_count;
    r.refusedWhileHeld = (await quote({ items, coupon_code: c.code, email: 'cancel@example.com' }, STAFF)).coupon?.refusal ?? null;
    // Two cancels at once: the use goes back ONCE.
    await Promise.all([M.setOrderStatus(o1.id, 'cancelled'), M.setOrderStatus(o1.id, 'cancelled')]);
    r.usedAfterCancel = (await couponOf(c.id))?.used_count;
    r.releasedAt = !!(await LocalDB.getOrder(o1.id))?.coupon_redemption?.released_at;
    r.worksAgain = (await quote({ items, coupon_code: c.code, email: 'cancel@example.com' })).coupon?.ok ?? null;
    // Reopened: counted again, without a limit check.
    await M.setOrderStatus(o1.id, 'pending');
    r.usedAfterReopen = (await couponOf(c.id))?.used_count;
    r.releasedAfterReopen = !!(await LocalDB.getOrder(o1.id))?.coupon_redemption?.released_at;

    // A PAID order that is cancelled keeps the use.
    const c2 = await host.coupons.issue({ type: 'fixed', value: 100, single_use: true, expires_at: later(), source: SRC });
    const o2 = await order({ items, coupon_code: c2.code, email: 'paid@example.com' });
    await LocalDB.updateOrder(o2.id, { payment_status: 'paid' });
    await M.setOrderStatus(o2.id, 'processing');
    await M.setOrderStatus(o2.id, 'cancelled');
    r.paidKeeps = (await couponOf(c2.id))?.used_count;

    // A per-email count goes back with the total.
    const c3 = await host.coupons.issue({ type: 'fixed', value: 100, max_redemptions_per_email: 1, expires_at: later(), source: SRC });
    const o3 = await order({ items, coupon_code: c3.code, email: 'per@example.com' });
    await M.setOrderStatus(o3.id, 'cancelled');
    const s3 = await couponOf(c3.id);
    r.perEmailBack = { used: s3?.used_count, counts: Object.values(s3?.redemptions_by_email ?? {}) };
    r.perEmailAgain = (await order({ items, coupon_code: c3.code, email: 'per@example.com' })).code;

    // The rule, asked directly.
    const red = { coupon_id: 'c' };
    r.rule = {
      unpaid: M.couponMove({ status: 'pending', payment_status: 'unpaid', coupon_redemption: red }, 'cancelled'),
      pendingPay: M.couponMove({ status: 'on-hold', payment_status: 'pending', coupon_redemption: red }, 'cancelled'),
      paid: M.couponMove({ status: 'processing', payment_status: 'paid', coupon_redemption: red }, 'cancelled'),
      refundedPay: M.couponMove({ status: 'processing', payment_status: 'refunded', coupon_redemption: red }, 'cancelled'),
      refund: M.couponMove({ status: 'processing', payment_status: 'unpaid', coupon_redemption: red }, 'refunded'),
      again: M.couponMove({ status: 'pending', payment_status: 'unpaid', coupon_redemption: { ...red, released_at: 'x' } }, 'cancelled'),
      reopen: M.couponMove({ status: 'cancelled', payment_status: 'unpaid', coupon_redemption: { ...red, released_at: 'x' } }, 'pending'),
      reopenNotReleased: M.couponMove({ status: 'cancelled', payment_status: 'paid', coupon_redemption: red }, 'processing'),
      none: M.couponMove({ status: 'pending', payment_status: 'unpaid' }, 'cancelled'),
    };
    return r;
  });

  /* ---- R9: the coupon.redeemed webhook ---- */
  await guard('webhook', async () => {
    await LocalDB.createWebhook({ url: 'http://127.0.0.1:9/hook', events: ['coupon.redeemed'], secret: 'whsec-test', active: true });
    const p = await product();
    const c = await host.coupons.issue({ type: 'percent', value: 1000, expires_at: later(), source: SRC });
    deliveries.length = 0;
    const o = await order({ items: [{ product_id: p.id, qty: 1 }], coupon_code: c.code, email: 'Hook.Buyer@Example.com' });
    // fireEvent is fire-and-forget: give it a moment to record the delivery.
    for (let i = 0; i < 40 && !deliveries.some((d) => d.event === 'coupon.redeemed'); i++) await new Promise((res) => setTimeout(res, 50));
    const d = deliveries.find((x) => x.event === 'coupon.redeemed');
    const body = d ? (typeof d.payload === 'string' ? JSON.parse(d.payload) : d.payload) : null;
    return { orderId: o.id, couponId: c.id, code: c.code, body, raw: d ? JSON.stringify(d.payload) : null };
  });

  /* ---- R10: status and revoke ---- */
  await guard('revoke', async () => {
    const r = {};
    const p = await product();
    const items = [{ product_id: p.id, qty: 1 }];
    const c = await host.coupons.issue({ type: 'percent', value: 1000, expires_at: later(), source: SRC });
    r.before = await host.coupons.status(c.code);
    r.revoked = await host.coupons.revoke(c.code.toLowerCase());
    r.revokedAgain = await host.coupons.revoke(c.code);
    r.after = await host.coupons.status(c.code);
    r.quoteStaff = (await quote({ items, coupon_code: c.code }, STAFF)).coupon;
    r.unknown = await host.coupons.status('NOPE-NOPE-NOPE');
    r.notACode = await host.coupons.status('');
    r.revokeUnknown = await host.coupons.revoke('NOPE-NOPE-NOPE');
    const staffMade = await LocalDB.createCoupon({ code: 'STAFF10', kind: 'percent', value: 1000, enabled: true, used_count: 0 });
    r.revokeStaff = await host.coupons.revoke('STAFF10');
    r.staffStillOn = (await couponOf(staffMade.id))?.enabled === true;
    const expiring = await host.coupons.issue({ type: 'fixed', value: 100, expires_at: new Date(Date.now() + 1500).toISOString(), source: SRC });
    await new Promise((res) => setTimeout(res, 1700));
    r.expired = await host.coupons.status(expiring.code);
    return r;
  });

  /* ---- R11: a coupon stored in the old shape ---- */
  await guard('legacy', async () => {
    const r = {};
    const p = await product({ price_cents: 4000 });
    const items = [{ product_id: p.id, qty: 1 }];
    // Exactly what a pre-v2 build wrote: no single_use, email, brands, source.
    const old = await LocalDB.createCoupon({
      code: 'OLDTEN', kind: 'percent', value: 1000, enabled: true, used_count: 0,
      usage_limit: 5, usage_limit_per_customer: 1, category_slugs: [], product_ids: [],
    });
    r.quote = (await quote({ items, coupon_code: 'oldten', email: 'legacy@example.com' })).totals;
    r.order = await order({ items, coupon_code: 'OLDTEN', email: 'legacy@example.com' });
    r.again = await order({ items, coupon_code: 'OLDTEN', email: 'legacy@example.com' }, STAFF);
    r.other = (await order({ items, coupon_code: 'OLDTEN', email: 'legacy2@example.com' })).code;
    r.used = (await couponOf(old.id))?.used_count;
    // An old order placed BEFORE per-email counting (no counter on the
    // coupon) still counts against its buyer through the order scan.
    const scanned = await LocalDB.createCoupon({ code: 'SCANNED', kind: 'fixed', value: 100, enabled: true, used_count: 1, usage_limit_per_customer: 1 });
    await LocalDB.createOrder({
      number: `LEG-${process.pid}`, status: 'pending', payment_status: 'unpaid', email: 'history@example.com', currency: 'EUR',
      items: [{ product_id: p.id, name: 'x', qty: 1, total_cents: 4000 }], subtotal_cents: 4000, total_cents: 3900, coupon_code: 'SCANNED',
    });
    r.history = (await quote({ items, coupon_code: 'SCANNED', email: 'History@example.com' }, STAFF)).coupon;
    void scanned;
    // An AUTOMATIC rule with a per-customer limit: pricing never judged that
    // limit for automatic rules, so checkout must not enforce it either — or a
    // buyer's second order is refused forever while every quote offers it.
    const ap = await product({ price_cents: 2000 });
    const auto = await LocalDB.createCoupon({
      code: 'AUTO5', kind: 'percent', value: 500, enabled: true, used_count: 0, automatic: true,
      usage_limit_per_customer: 1, product_ids: [ap.id],
    });
    const autoItems = [{ product_id: ap.id, qty: 1 }];
    r.auto1 = (await order({ items: autoItems, email: 'auto@example.com' })).code;
    r.auto2 = await order({ items: autoItems, email: 'auto@example.com' });
    r.autoQuote = (await quote({ items: autoItems, email: 'auto@example.com' })).coupon;
    await LocalDB.updateCoupon(auto.id, { enabled: false });
    return r;
  });

  /* ---- the admin API: whole-record checks on a partial edit ---- */
  await guard('admin', async () => {
    const r = {};
    const ADMIN = { id: 'admin-1', role: 'admin', email: 'admin@example.com' };
    const send = async (handler, method, url, body, params = {}) => {
      const res = await handler({
        request: new Request(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
        locals: { user: ADMIN, ip: nextIp() }, url: new URL(url), params,
      });
      const json = await res.json().catch(() => null);
      return { code: res.status, data: json?.data ?? null, message: json?.error?.message ?? null };
    };
    const post = (body) => send(M.postCoupon, 'POST', 'http://localhost/api/coupons', body);
    const put = (id, body) => send(M.putCoupon, 'PUT', `http://localhost/api/coupons/${id}`, body, { id });
    r.giftUnknown = await post({ code: 'GIFTX', kind: 'gift_product', gift_product_id: 'no-such-product' });
    const fixed = await post({ code: 'FIX15', type: 'fixed', value: 1500, max_redemptions: 3 });
    r.fixedCreated = { code: fixed.code, kind: fixed.data?.kind, limit: fixed.data?.usage_limit };
    // A value-only edit of a FIXED coupon is cents, not basis points: 15000 is fine.
    r.valueOnly = (await put(fixed.data.id, { value: 15000 })).code;
    // Switching fixed -> percent without a value would turn 150.00 into 1.5%.
    r.kindNoValue = await put(fixed.data.id, { kind: 'percent' });
    r.toGiftNoGift = await put(fixed.data.id, { kind: 'gift_product' });
    // A revoked (plugin) coupon switched back on by the admin is live again.
    const issued = await host.coupons.issue({ type: 'percent', value: 1000, expires_at: later(), source: SRC });
    await host.coupons.revoke(issued.code);
    const revived = await put(issued.id, { enabled: true });
    r.revived = { code: revived.code, revoked_at: revived.data?.revoked_at ?? null, status: await host.coupons.status(issued.code) };
    return r;
  });

  /* ---- conditions through the route: brands, categories ---- */
  await guard('conditions', async () => {
    const r = {};
    const rb = await product({ price_cents: 10000, brand: 'Ray-Ban', categories: ['sunglasses'] });
    const other = await product({ price_cents: 5000, brand: 'Other', categories: ['frames'] });
    const items = [{ product_id: rb.id, qty: 1 }, { product_id: other.id, qty: 1 }];
    const byBrand = await host.coupons.issue({ type: 'percent', value: 1000, conditions: { brands: ['RAYBAN'] }, expires_at: later(), source: SRC });
    const bySlug = await host.coupons.issue({ type: 'percent', value: 1000, conditions: { brands: ['ray-ban'] }, expires_at: later(), source: SRC });
    const nobody = await host.coupons.issue({ type: 'percent', value: 1000, conditions: { brands: ['Nobody'] }, expires_at: later(), source: SRC });
    const both = await host.coupons.issue({ type: 'percent', value: 1000, conditions: { categories: ['frames'], brands: ['Ray-Ban'] }, expires_at: later(), source: SRC });
    const min = await host.coupons.issue({ type: 'fixed', value: 500, conditions: { min_subtotal_cents: 20000 }, expires_at: later(), source: SRC });
    r.byBrand = (await quote({ items, coupon_code: byBrand.code })).totals?.discount;
    r.bySlug = (await quote({ items, coupon_code: bySlug.code })).totals?.discount;
    r.nobody = (await quote({ items, coupon_code: nobody.code }, STAFF)).coupon;
    r.both = (await quote({ items, coupon_code: both.code }, STAFF)).coupon;
    r.minStaff = (await quote({ items, coupon_code: min.code }, STAFF)).coupon;
    r.minPublic = (await quote({ items, coupon_code: min.code })).coupon;
    r.minOrder = await order({ items, coupon_code: min.code, email: 'min@example.com' });
    return r;
  });

  return out;
}

if (process.env.COUPONS_V2_CHILD) {
  const M = await loadTs('tests/fixtures/checkout-entry.ts', 'couponsv2');
  await M.LocalDB.init();
  const result = await child(M);
  console.log('__RESULT__' + JSON.stringify(result));
  process.exit(0);
}

/* --------------------------------------------------------------- parent --- */
let pass = 0;
let fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };

/* ============================== PURE ============================== */
const C = await loadTs('src/lib/commerce/coupons.ts', 'couponsv2');
const N = await loadTs('src/lib/commerce/admin-normalize.ts', 'couponsv2');
const NOW = Date.parse('2026-10-26T12:00:00Z');
const coupon = (over = {}) => ({ id: 'c1', code: 'X', kind: 'percent', value: 1000, enabled: true, used_count: 0, created_at: '', updated_at: '', ...over });
const ctx = (over = {}) => ({ lines: [{ product_id: 'p1', amount_cents: 6000, qty: 1 }], subtotal_cents: 6000, nowMs: NOW, ...over });
const lineOf = (product_id, unit, qty, extra = {}) => ({ product_id, amount_cents: unit * qty, qty, ...extra });
const basket = (...lines) => ({ lines, subtotal_cents: lines.reduce((s, l) => s + l.amount_cents, 0) });

// M1 percent rounding: once, half-up, over the eligible total.
{
  const r = C.applyCoupon(coupon({ value: 1250 }), ctx(basket(lineOf('a', 333, 1), lineOf('b', 333, 1), lineOf('c', 334, 1))));
  check(`M1: 12.5% of 10.00 is 1.25 (${r.discount_cents})`, r.ok && r.discount_cents === 125);
  const half = C.applyCoupon(coupon({ value: 1500 }), ctx(basket(lineOf('a', 999, 1))));
  check(`M1: 15% of 9.99 = 149.85 rounds to 150 (${half.discount_cents})`, half.ok && half.discount_cents === 150);
  const down = C.applyCoupon(coupon({ value: 1000 }), ctx(basket(lineOf('a', 1004, 1))));
  check(`M1: 10% of 10.04 = 100.4 rounds to 100 (${down.discount_cents})`, down.ok && down.discount_cents === 100);
  const per = C.applyCoupon(coupon({ value: 3333 }), ctx(basket(lineOf('a', 1, 1), lineOf('b', 1, 1), lineOf('c', 1, 1))));
  check(`M1: rounded once over the total, not per line (33.33% of 3 x 1c = ${per.discount_cents}, per-line would be 0)`, per.ok && per.discount_cents === 1);
  check('M1: 100% takes everything and no more', C.applyCoupon(coupon({ value: 10000 }), ctx()).discount_cents === 6000);
}
// M2 fixed larger than the subtotal.
{
  const r = C.applyCoupon(coupon({ kind: 'fixed', value: 99999 }), ctx(basket(lineOf('a', 1500, 2))));
  check(`M2: a fixed 999.99 on a 30.00 basket takes 30.00 (${r.discount_cents})`, r.ok && r.discount_cents === 3000);
  const elig = C.applyCoupon(coupon({ kind: 'fixed', value: 5000, product_ids: ['a'] }), ctx(basket(lineOf('a', 1000, 1), lineOf('b', 9000, 1))));
  check(`M2: ...clamped to the ELIGIBLE lines, not the basket (${elig.discount_cents})`, elig.ok && elig.discount_cents === 1000);
}
// M3 bogo50.
{
  const bogo = (b) => C.applyCoupon(coupon({ kind: 'bogo50', value: 0 }), ctx(b));
  const one = bogo(basket(lineOf('a', 1000, 1)));
  check(`M3: a single unit is refused, not discounted by 0 (${one.reason}/${one.refusal})`, !one.ok && one.reason === 'needs-more-items' && one.refusal === 'coupon.not_applicable');
  const two = bogo(basket(lineOf('a', 1000, 2)));
  check(`M3: two of one product: the second half price (${two.discount_cents})`, two.ok && two.discount_cents === 500);
  const odd = bogo(basket(lineOf('a', 1000, 3)));
  check(`M3: an odd quantity leaves the last unit full price (3 x 10.00 -> ${odd.discount_cents})`, odd.ok && odd.discount_cents === 500);
  const five = bogo(basket(lineOf('a', 1000, 5)));
  check(`M3: five units are two pairs (${five.discount_cents})`, five.ok && five.discount_cents === 1000);
  const mixed = bogo(basket(lineOf('a', 10000, 2), lineOf('b', 4000, 2)));
  check(`M3: mixed prices pair by price across lines: (100,100)+(40,40) -> 50+20 (${mixed.discount_cents})`, mixed.ok && mixed.discount_cents === 7000);
  const cross = bogo(basket(lineOf('a', 3000, 1), lineOf('b', 1000, 1), lineOf('c', 2000, 1)));
  check(`M3: three single lines 30/10/20: pair (30,20), 10 left -> 10.00 (${cross.discount_cents})`, cross.ok && cross.discount_cents === 1000);
  const order = bogo(basket(lineOf('cheap', 500, 1), lineOf('dear', 5000, 1)));
  check(`M3: basket order does not matter, the cheaper unit is the discounted one (${order.discount_cents})`, order.ok && order.discount_cents === 250);
  const rounding = bogo(basket(lineOf('a', 999, 2)));
  check(`M3: half of 9.99 rounds once, half-up (${rounding.discount_cents})`, rounding.ok && rounding.discount_cents === 500);
  const twoPairsOdd = bogo(basket(lineOf('a', 999, 2), lineOf('b', 999, 2)));
  check(`M3: two pairs of 9.99 = half of 19.98, not 2 x 5.00 (${twoPairsOdd.discount_cents})`, twoPairsOdd.ok && twoPairsOdd.discount_cents === 999);
  const restricted = C.applyCoupon(coupon({ kind: 'bogo50', value: 0, product_ids: ['a'] }), ctx(basket(lineOf('a', 1000, 1), lineOf('b', 1000, 1))));
  check(`M3: units of non-qualifying lines do not make a pair (${restricted.reason})`, !restricted.ok && restricted.reason === 'needs-more-items');
  const uneven = C.bogoDiscount([{ amount_cents: 1001, qty: 2 }]);
  check(`M3: a line whose amount does not split evenly still sums to itself (${j(uneven)})`, uneven.pairs === 1 && uneven.discount_cents === 250);
  check('M3: value is ignored', bogo(basket(lineOf('a', 1000, 2))).discount_cents === C.applyCoupon(coupon({ kind: 'bogo50', value: 9999 }), ctx(basket(lineOf('a', 1000, 2)))).discount_cents);
}
// M4 free shipping.
{
  const r = C.applyCoupon(coupon({ kind: 'free_shipping', value: 0 }), ctx());
  check(`M4: free_shipping takes no money off the goods and waives shipping (${j({ d: r.discount_cents, f: r.freeShipping })})`, r.ok && r.discount_cents === 0 && r.freeShipping === true);
  const none = C.applyCoupon(coupon({ kind: 'free_shipping', value: 0, category_slugs: ['x'] }), ctx());
  check('M4: ...and still needs a qualifying line', !none.ok && none.reason === 'no-eligible-items');
  check('M4: percent with free_shipping: both', (() => { const x = C.applyCoupon(coupon({ free_shipping: true }), ctx()); return x.ok && x.discount_cents === 600 && x.freeShipping; })());
}
// M5 gift.
{
  const g = (over, avail) => C.applyCoupon(coupon({ kind: 'gift_product', value: 0, gift_product_id: 'g1', ...over }), ctx({ giftAvailable: avail }));
  const ok = g({}, (id) => id === 'g1');
  check(`M5: an available gift is added, at no discount (${j(ok)})`, ok.ok && ok.gift_product_id === 'g1' && ok.discount_cents === 0);
  const out = g({}, () => false);
  check(`M5: an out-of-stock gift is refused as not applicable (${out.reason}/${out.refusal})`, !out.ok && out.reason === 'gift-unavailable' && out.refusal === 'coupon.not_applicable');
  check('M5: no availability answer means unavailable (fail closed)', !g({}, undefined).ok);
  check('M5: a gift coupon with no gift id is refused', !g({ gift_product_id: null }, () => true).ok);
}
// M6 conditions.
{
  const lines = [
    { product_id: 'rb', amount_cents: 10000, qty: 1, categories: ['sunglasses'], brand: 'Ray-Ban' },
    { product_id: 'o', amount_cents: 5000, qty: 1, categories: ['frames'], brand: 'Other' },
  ];
  const b = { lines, subtotal_cents: 15000 };
  const byBrand = C.applyCoupon(coupon({ brands: ['RAYBAN'] }), ctx(b));
  check(`M6: brands match however spelled (Ray-Ban vs RAYBAN) (${byBrand.eligible_cents})`, byBrand.ok && byBrand.eligible_cents === 10000);
  const dir = { keyFor: (v) => (v === 'rb-slug' ? 'rayban' : String(v).toLowerCase().replace(/[^a-z0-9]/g, '')) };
  const bySlug = C.applyCoupon(coupon({ brands: ['rb-slug'] }), ctx({ ...b, brandDirectory: dir }));
  check(`M6: a published brand slug resolves through the directory (${bySlug.eligible_cents})`, bySlug.ok && bySlug.eligible_cents === 10000);
  const and = C.applyCoupon(coupon({ category_slugs: ['frames'], brands: ['Ray-Ban'] }), ctx(b));
  check(`M6: category AND brand must both hold (${and.reason})`, !and.ok && and.reason === 'no-eligible-items' && and.refusal === 'coupon.not_applicable');
  const cat = C.applyCoupon(coupon({ category_slugs: ['FRAMES'] }), ctx(b));
  check('M6: categories compare case-insensitively', cat.ok && cat.eligible_cents === 5000);
  const none = C.applyCoupon(coupon({ product_ids: ['zzz'], category_slugs: ['zzz'] }), ctx(b));
  check(`M6: conditions that exclude every line are refused (${none.refusal})`, !none.ok && none.refusal === 'coupon.not_applicable');
  const min = C.applyCoupon(coupon({ min_subtotal_cents: 20000 }), ctx(b));
  check(`M6: min_subtotal refusal carries the shortfall (${min.refusal}, ${min.shortfall_cents})`, !min.ok && min.refusal === 'coupon.min_subtotal' && min.shortfall_cents === 5000);
}
// M7 email binding, single use, codes.
{
  const bound = coupon({ email: 'winner@example.com' });
  check('M7: email-bound: the right email in any case validates', C.applyCoupon(bound, ctx({ email: '  WINNER@Example.com ' })).ok);
  const wrong = C.applyCoupon(bound, ctx({ email: 'other@example.com' }));
  check(`M7: another email is refused (${wrong.refusal})`, !wrong.ok && wrong.refusal === 'coupon.email_mismatch');
  check('M7: no email at all is refused the same way', C.applyCoupon(bound, ctx()).refusal === 'coupon.email_mismatch');
  const single = C.applyCoupon(coupon({ single_use: true, used_count: 1 }), ctx());
  check(`M7: single_use after one use is exhausted (${single.refusal})`, !single.ok && single.refusal === 'coupon.exhausted');
  const singleBound = C.applyCoupon(coupon({ single_use: true, used_count: 1, email: 'w@example.com' }), ctx({ email: 'w@example.com' }));
  check(`M7: ...and for an email-bound code it is "already redeemed" (${singleBound.refusal})`, singleBound.refusal === 'coupon.already_redeemed');
  check('M7: single_use beats a larger usage_limit', !C.applyCoupon(coupon({ single_use: true, usage_limit: 10, used_count: 1 }), ctx()).ok);
  check('M7: single_use is effectiveUsageLimit 1', C.effectiveUsageLimit({ single_use: true, usage_limit: 10 }) === 1 && C.effectiveUsageLimit({ usage_limit: null }) === null);
  const perEmail = C.applyCoupon(coupon({ usage_limit_per_customer: 1 }), ctx({ customerUses: 1 }));
  check(`M7: per-email limit is "already redeemed" (${perEmail.refusal})`, perEmail.refusal === 'coupon.already_redeemed');
  const expected = {
    'not-found': 'coupon.not_found', disabled: 'coupon.expired', revoked: 'coupon.expired', 'not-started': 'coupon.not_started',
    expired: 'coupon.expired', 'email-mismatch': 'coupon.email_mismatch', 'minimum-not-met': 'coupon.min_subtotal',
    'usage-limit-reached': 'coupon.exhausted', 'customer-limit-reached': 'coupon.already_redeemed',
    'no-eligible-items': 'coupon.not_applicable', 'needs-more-items': 'coupon.not_applicable', 'gift-unavailable': 'coupon.not_applicable',
    invalid: 'coupon.not_found',
  };
  for (const [reason, code] of Object.entries(expected)) {
    check(`M7: reason "${reason}" is ${code}`, C.refusalCodeFor(reason) === code);
    check(`M7: ${code} is a published refusal code`, C.COUPON_REFUSAL_CODES.includes(code));
  }
  check('M7: an unknown reason fails closed and vague', C.refusalCodeFor('whatever') === 'coupon.not_found' && C.refusalCodeFor(undefined) === 'coupon.not_found');
  check('M7: revoked beats enabled', C.applyCoupon(coupon({ revoked_at: '2026-01-01' }), ctx()).reason === 'revoked');
  check('M7: an unknown stored kind is refused, never priced as something else', !C.applyCoupon(coupon({ kind: 'mystery', value: 5000 }), ctx()).ok);
  check('M7: expired / not started carry their codes',
    C.applyCoupon(coupon({ ends_at: '2026-01-01' }), ctx()).refusal === 'coupon.expired'
    && C.applyCoupon(coupon({ starts_at: '2027-01-01' }), ctx()).refusal === 'coupon.not_started');
  const pub = C.publicCouponRejection(C.applyCoupon(bound, ctx({ email: 'x@example.com' })));
  check(`M7: a stranger sees coupon.not_found for an email mismatch (${j(pub)})`, pub.refusal === 'coupon.not_found' && pub.reason === 'invalid');
  const pubMin = C.publicCouponRejection(C.applyCoupon(coupon({ min_subtotal_cents: 9000 }), ctx()));
  check('M7: ...but keeps the minimum-spend code and shortfall', pubMin.refusal === 'coupon.min_subtotal' && pubMin.shortfall_cents === 3000);
}
// M8 admin normalizer.
{
  const n = (b, o) => N.normalizeCoupon(b, o);
  for (const kind of C.COUPON_KINDS) {
    const body = { code: `K${kind.length}`, kind, value: 500, ...(kind === 'gift_product' ? { gift_product_id: 'g1' } : {}) };
    const r = n(body);
    check(`M8: kind "${kind}" is accepted and survives (${j(r)})`, r.ok && r.value.kind === kind);
    if (r.ok && !C.VALUED_COUPON_KINDS.includes(kind)) check(`M8: "${kind}" stores value 0`, r.value.value === 0);
  }
  const aliased = n({
    code: 'alias', type: 'fixed', value: 250, expires_at: '2026-12-31T00:00:00Z', max_redemptions: 3, max_redemptions_per_email: 1,
    conditions: { min_subtotal_cents: 1000, categories: ['Sun'], brands: [' Ray-Ban ', 'Ray-Ban'] }, email: 'A@B.co', single_use: true,
  });
  check(`M8: the contract's names map onto the stored ones (${j(aliased)})`, aliased.ok
    && aliased.value.kind === 'fixed' && aliased.value.ends_at === '2026-12-31T00:00:00.000Z'
    && aliased.value.usage_limit === 3 && aliased.value.usage_limit_per_customer === 1
    && aliased.value.min_subtotal_cents === 1000 && j(aliased.value.category_slugs) === j(['sun'])
    && j(aliased.value.brands) === j(['Ray-Ban']) && aliased.value.email === 'a@b.co' && aliased.value.single_use === true);
  check('M8: a gift coupon without a gift is refused', !n({ code: 'G1', kind: 'gift_product' }).ok);
  check('M8: a bad email is refused', !n({ code: 'E1', kind: 'percent', value: 100, email: 'nope' }).ok);
  check('M8: email null clears the binding', n({ email: null }, { partial: true }).value.email === null);
  check('M8: unknown kinds are refused', !n({ code: 'U1', kind: 'bogo100', value: 1 }).ok);
  check('M8: source / revoked_at / redemptions are never copied from a body', (() => {
    const r = n({ code: 'S1', kind: 'percent', value: 1, source: { plugin: 'x', ref: 'y' }, revoked_at: 'now', redemptions_by_email: { a: 1 } });
    return r.ok && !('source' in r.value) && !('revoked_at' in r.value) && !('redemptions_by_email' in r.value);
  })());
  check('M8: checkCouponRecord catches a merged gift coupon with no gift', N.checkCouponRecord({ kind: 'gift_product' }) !== null && N.checkCouponRecord({ kind: 'gift_product', gift_product_id: 'g' }) === null);
  check('M8: checkCouponRecord catches an inverted window', N.checkCouponRecord({ kind: 'percent', value: 1, starts_at: '2027-01-01', ends_at: '2026-01-01' }) !== null);
}

// The plugin author's documentation names the seam, its members and the event.
{
  const doc = await fs.readFile(path.join(ROOT, 'PLUGIN_DEVELOPMENT.md'), 'utf8');
  check('PLUGIN_DEVELOPMENT.md lists host.coupons in the host table', /^\| `coupons` \|/m.test(doc));
  for (const m of ['issue(input)', 'status(code)', 'revoke(code)', 'coupon.redeemed', 'coupons:validate']) {
    check(`PLUGIN_DEVELOPMENT.md documents ${m}`, doc.includes(m));
  }
  for (const code of C.COUPON_REFUSAL_CODES) check(`PLUGIN_DEVELOPMENT.md names refusal ${code}`, doc.includes(code));
  const W = await loadTs('src/lib/webhook-util.ts', 'couponsv2');
  check('coupon.redeemed is a published webhook event', W.WEBHOOK_EVENTS.includes('coupon.redeemed'));
}

/* ============================== ROUTES, per driver ============================== */
const tmpRoot = path.join(os.tmpdir(), `astrobaas-coupons-v2-${process.pid}`);
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
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 300_000,
    env: {
      ...process.env, COUPONS_V2_CHILD: '1', NODE_ENV: 'test', AUTH_SECRET: SECRET,
      STAGING: '', ASTROBAAS_STAGING: '', RATE_LIMIT_STORE: '', SITE_URL: '', DATABASE_URL: '', DATABASE_DRIVER: '',
      UPLOADS_DIR: path.join(dir, 'uploads'), ...driver.env(dir),
    },
  });
  const line = (run.stdout || '').split('\n').find((l) => l.startsWith('__RESULT__'));
  if (!line) {
    fail++;
    console.error(`✗ [${driver.name}] child produced no result\n${(run.stderr || '').slice(-3000)}`);
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
  for (const [k, v] of Object.entries(r)) t(`${k}: ran without throwing${v?.error ? ` — ${v.error}` : ''}`, !v?.error);

  // R12
  {
    const x = r.issue;
    t(`R12: a code is 12 symbols of an unambiguous alphabet (${x.plain?.value?.code})`, /^[0-9A-HJKMNP-TV-Z]{12}$/.test(x.plain?.value?.code ?? ''));
    t(`R12: a prefix is upper-cased and joined with a dash (${x.prefixed?.value?.code})`, /^GAME-[0-9A-HJKMNP-TV-Z]{12}$/.test(x.prefixed?.value?.code ?? ''));
    t('R12: issue returns the id and the ISO expiry', !!x.plain?.value?.id && !Number.isNaN(Date.parse(x.plain?.value?.expires_at)));
    for (const k of ['noSource', 'badPlugin', 'noExpiry', 'pastExpiry', 'badType', 'noValue', 'overPercent', 'badEmail', 'badPrefix', 'giftMissing', 'giftUnknown', 'giftVariable']) {
      t(`R12: issue refuses ${k} with a named reason (${x[k]?.error})`, x[k]?.ok === false && /^coupons\.issue: /.test(x[k]?.error ?? ''));
    }
    t(`R12: fields only the core sets are not taken from a plugin (${j(x.sneaky)})`,
      x.sneaky.ok && x.sneaky.automatic !== true && x.sneaky.used === 0 && (x.sneaky.products ?? []).length === 0 && x.sneaky.source?.plugin === 'campaign-games');
    t(`R12: twenty codes, twenty different (${x.unique})`, x.unique === 20);
    t(`R12: host.coupons is exactly issue/status/revoke (${j(x.hostMembers)})`, j(x.hostMembers) === j(['issue', 'revoke', 'status']));
  }

  // R1
  {
    const x = r.bound;
    t(`R1: no email at checkout: email mismatch for staff (${j(x.quoteNoEmailStaff)})`, x.quoteNoEmailStaff?.ok === false && x.quoteNoEmailStaff?.refusal === 'coupon.email_mismatch');
    t(`R1: another email: email mismatch for staff (${x.quoteOtherStaff?.refusal})`, x.quoteOtherStaff?.refusal === 'coupon.email_mismatch');
    t(`R1: ...and the generic not_found for a stranger (${j(x.quoteOtherPublic)})`, x.quoteOtherPublic?.refusal === 'coupon.not_found' && x.quoteOtherPublic?.reason === 'invalid');
    t(`R1: the bound email (lower-case) is accepted by the quote (${j(x.quoteMine.coupon)})`, x.quoteMine.coupon?.ok === true && x.quoteMine.totals?.discount === 500);
    t(`R1: the order refuses another email (${x.orderOther.code} ${x.orderOther.errCode} ${j(x.orderOther.params)})`,
      x.orderOther.code === 400 && x.orderOther.errCode === 'checkout.coupon_invalid' && x.orderOther.params?.refusal === 'coupon.not_found');
    t(`R1: the order accepts the bound email in another case (${x.orderMine.code})`, x.orderMine.code === 201);
    t(`R1: ...with the discount the quote showed (${j(x.orderMine.totals)} vs ${j(x.quoteMine.totals)})`, j(x.orderMine.totals) === j(x.quoteMine.totals));
    t(`R1: ...and records the use it holds (${j(x.orderMine.redemption)})`, x.orderMine.redemption?.coupon_id === x.issued.id);
    t(`R1: a second use is refused (${x.orderAgain.code})`, x.orderAgain.code === 400 && x.orderAgain.errCode === 'checkout.coupon_invalid');
    t(`R1: ...as already_redeemed for staff, on the order (${j(x.orderAgainStaff.params)}) and the quote (${x.quoteAgainStaff?.refusal})`,
      x.orderAgainStaff.params?.refusal === 'coupon.already_redeemed' && x.quoteAgainStaff?.refusal === 'coupon.already_redeemed');
    t(`R1: status says redeemed once (${j(x.status)})`, x.status?.exists === true && x.status?.redeemed_count === 1 && x.status?.expired === false && x.status?.revoked === false);
  }

  // R2
  {
    const f = r.race.forced;
    t(`R2: the second order really ran inside the first (${f.fired})`, f.fired === true);
    t(`R2: of two overlapping orders with one single-use code, exactly one is placed (${j(f.codes)})`, f.codes.filter((c) => c === 201).length === 1 && f.withCode === 1);
    t(`R2: ...the loser is a coupon refusal, not a 500 (${f.loserErr})`, f.loserErr === 'checkout.coupon_invalid');
    t(`R2: ...and the counter says one (${f.used})`, f.used === 1);
    const v = r.race.five;
    t(`R2: five at once: one placed, four refused (${j(v)})`, v.placed === 1 && v.refused === 4 && v.withCode === 1 && v.used === 1);
    t(`R2: ...and the refused ones hold no stock (${v.stockTaken})`, v.stockTaken === 1);
  }

  // R3
  {
    const x = r.perEmail;
    t(`R3: the same buyer's second order ran inside the first (${x.fired})`, x.fired === true);
    t(`R3: one per buyer holds under concurrency, whatever the case of the address (${j(x.sameBuyer)})`, x.sameBuyer.filter((c) => c === 201).length === 1);
    t(`R3: ...the loser is told it already used it — to staff it would read already_redeemed (${j(x.sameLoser)})`, x.sameLoser?.refusal === 'coupon.not_found' || x.sameLoser?.refusal === 'coupon.already_redeemed');
    t(`R3: another buyer still can (${x.otherBuyer})`, x.otherBuyer === 201);
    t(`R3: counts: two uses, two buyers, keyed by hash only (${j({ used: x.used, keys: x.keys.length, hash: x.keyIsHash })})`, x.used === 2 && x.keys.length === 2 && x.keyIsHash);
    t('R3: no address is stored on the coupon', x.noRawEmail === true);
    t(`R3: a quote for that buyer now says already_redeemed (${x.quoteAgainStaff?.refusal})`, x.quoteAgainStaff?.refusal === 'coupon.already_redeemed');
  }

  // R4
  {
    // 3 x 19.99 + 2 x 12.50 = 84.97, shipping 3.50.
    const expect = {
      percent: { discount: Math.round(8497 * 1250 / 10000), shipping: 350 },
      fixed: { discount: 700, shipping: 350 },
      // units 19.99,19.99,19.99,12.50,12.50: pairs (19.99,19.99)(19.99,12.50), 12.50 left -> half of 32.49
      bogo50: { discount: Math.round((1999 + 1250) / 2), shipping: 350 },
      free_shipping: { discount: 0, shipping: 0 },
      gift_product: { discount: 0, shipping: 350 },
    };
    for (const [kind, e] of Object.entries(expect)) {
      const x = r.parity[kind];
      t(`R4 ${kind}: quote 200 and order 201 (${x?.qCode}/${x?.oCode})`, x?.qCode === 200 && x?.oCode === 201);
      t(`R4 ${kind}: the identical basket costs the same through both (${j(x?.quote)} vs ${j(x?.order)})`, j(x?.quote) === j(x?.order));
      t(`R4 ${kind}: discount ${e.discount}, shipping ${e.shipping} (${x?.quote?.discount}, ${x?.quote?.shipping})`, x?.quote?.discount === e.discount && x?.quote?.shipping === e.shipping);
      t(`R4 ${kind}: total = subtotal - discount + shipping (tax off) (${j(x?.quote)})`, x?.quote?.total === x?.quote?.subtotal - x?.quote?.discount + x?.quote?.shipping);
    }
    t(`R4 gift_product: one more line on both sides (${r.parity.gift_product?.qLines}/${r.parity.gift_product?.oItems})`, r.parity.gift_product?.qLines === 3 && r.parity.gift_product?.oItems === 3);
    t(`R4: the quote names the kind it applied (${r.parity.bogo50?.coupon?.kind})`, r.parity.bogo50?.coupon?.kind === 'bogo50');
    const z = r.parity.freeShipZero;
    t(`R4: free shipping when shipping is already 0 is accepted and changes nothing (${j(z)})`,
      z?.coupon?.ok === true && z?.coupon?.free_shipping === true && z?.quote?.shipping === 0 && z?.quote?.discount === 0
      && z?.quote?.total === 2500 && z?.oCode === 201 && j(z?.order) === j(z?.quote));
  }

  // R5
  {
    const x = r.tax;
    t(`R5: 10% off 100.00 net, 24% VAT on the DISCOUNTED 90.00 = 21.60 (${j(x.domesticQuote)})`, x.domesticQuote?.discount === 1000 && x.domesticQuote?.tax === 2160 && x.domesticQuote?.total === 11160);
    t(`R5: ...the order agrees (${j(x.domesticOrder)})`, j(x.domesticOrder) === j(x.domesticQuote));
    t(`R5: reverse charge with a coupon: 0 VAT on 90.00 (${j(x.rcQuote)})`, x.rcQuote?.tax === 0 && x.rcQuote?.total === 9000 && x.rcQuote?.discount === 1000);
    t(`R5: ...the order agrees (${j(x.rcOrder)})`, j(x.rcOrder) === j(x.rcQuote));
  }

  // R6
  {
    const x = r.addons;
    // 2 x (20.00 + 5.00 engraving)
    const base = x.flag ? 2500 : 2000;
    t(`R6: priced add-ons are inside the subtotal (${x.pctQuote?.subtotal})`, x.pctQuote?.subtotal === 5000);
    t(`R6: percent discounts ${x.flag ? 'the add-on too' : 'the product only'} (COUPONS_DISCOUNT_ADDONS=${x.flag}; ${x.pctQuote?.discount})`, x.pctQuote?.discount === Math.round(base * 2 * 0.1));
    t(`R6: bogo50 halves the second unit ${x.flag ? 'with' : 'without'} its add-on (${x.bogoQuote?.discount})`, x.bogoQuote?.discount === Math.round(base / 2));
    t('R6: quote and order agree with add-ons', j(x.pctQuote) === j(x.pctOrder) && j(x.bogoQuote) === j(x.bogoOrder));
  }

  // R7
  {
    const x = r.gift;
    t(`R7: a gift whose last unit the basket already takes is refused (${x.basketTakesIt?.reason})`, x.basketTakesIt?.reason === 'gift-unavailable' && x.basketTakesIt?.refusal === 'coupon.not_applicable');
    const gl = x.quote.lines?.at(-1);
    t(`R7: the quote adds the gift as the last line, at 0, marked (${j(gl)})`, x.quote.lines?.length === 2 && gl?.unit === 0 && gl?.gift === true && gl?.qty === 1);
    t(`R7: the gift adds nothing to the price (${j(x.quote.totals)})`, x.quote.totals?.subtotal === 3000 && x.quote.totals?.total === 3000 && x.quote.coupon?.gift_product_id);
    const oi = x.order.items?.at(-1);
    t(`R7: the order holds the gift line at 0 (${j(x.order.items)})`, x.order.code === 201 && oi?.gift === true && oi?.total === 0 && oi?.qty === 1);
    t(`R7: ...and took its unit (stock ${x.giftStock})`, x.giftStock === 0);
    t(`R7: out of stock: the quote refuses it (${x.quoteOut?.refusal})`, x.quoteOut?.ok === false && x.quoteOut?.refusal === 'coupon.not_applicable');
    t(`R7: ...and so does the order, with the same code (${j(x.orderOut.params)})`, x.orderOut.code === 400 && x.orderOut.params?.refusal === 'coupon.not_applicable');
    t(`R7: ...collapsed for a stranger (${j(x.orderOutPublic.params)})`, x.orderOutPublic.code === 400 && x.orderOutPublic.params?.refusal === 'coupon.not_found');
    t(`R7: cancelling the order returns the gift's unit (${x.giftStockAfterCancel})`, x.giftStockAfterCancel === 1);
    t(`R7: gift product also in the basket, stock for both: the quote accepts (${j(x.alsoInBasketQuote.coupon)})`,
      x.alsoInBasketQuote.coupon?.ok === true && x.alsoInBasketQuote.lines?.length === 2);
    t(`R7: ...and so does the order (${x.alsoInBasketOrder.code} ${j(x.alsoInBasketOrder.params)}), taking both units (stock ${x.alsoInBasketStock})`,
      x.alsoInBasketOrder.code === 201 && x.alsoInBasketStock === 0 && j(x.alsoInBasketOrder.totals) === j(x.alsoInBasketQuote.totals));
  }

  // R8
  {
    const x = r.cancel;
    t(`R8: placed, counted, held (${x.placed}, ${x.usedAfterOrder}, ${x.refusedWhileHeld})`, x.placed === 201 && x.usedAfterOrder === 1 && x.refusedWhileHeld === 'coupon.already_redeemed');
    t(`R8: two concurrent cancels before payment hand the use back ONCE (${x.usedAfterCancel})`, x.usedAfterCancel === 0 && x.releasedAt === true);
    t(`R8: ...and the code works again (${x.worksAgain})`, x.worksAgain === true);
    t(`R8: reopening counts it again (${x.usedAfterReopen}, released=${x.releasedAfterReopen})`, x.usedAfterReopen === 1 && x.releasedAfterReopen === false);
    t(`R8: a PAID order that is cancelled keeps the use (${x.paidKeeps})`, x.paidKeeps === 1);
    t(`R8: the buyer's per-email count goes back too (${j(x.perEmailBack)})`, x.perEmailBack.used === 0 && x.perEmailBack.counts.every((n) => n === 0));
    t(`R8: ...so the buyer can use it again (${x.perEmailAgain})`, x.perEmailAgain === 201);
    t(`R8: the rule (${j(x.rule)})`, j(x.rule) === j({
      unpaid: 'release', pendingPay: 'release', paid: null, refundedPay: null, refund: null,
      again: null, reopen: 'recount', reopenNotReleased: null, none: null,
    }));
  }

  // R9
  {
    const x = r.webhook;
    const data = x.body?.data ?? x.body;
    const hash = createHash('sha256').update('hook.buyer@example.com').digest('hex');
    t(`R9: coupon.redeemed fired (${x.raw?.slice(0, 200)})`, !!x.body);
    t(`R9: payload is { code, coupon_id, order_id, email_hash } (${j(data)})`,
      j(Object.keys(data ?? {}).sort()) === j(['code', 'coupon_id', 'email_hash', 'order_id'])
      && data.code === x.code && data.coupon_id === x.couponId && data.order_id === x.orderId);
    t(`R9: email_hash is SHA-256 of the lower-cased address (${data?.email_hash})`, data?.email_hash === hash);
    t('R9: the raw address appears nowhere in the delivery', !!x.raw && !/hook\.buyer@example\.com/i.test(x.raw));
  }

  // R10
  {
    const x = r.revoke;
    t(`R10: status before (${j(x.before)})`, j(x.before) === j({ exists: true, redeemed_count: 0, expired: false, revoked: false }));
    t(`R10: revoke (any case) is true, and idempotent (${x.revoked}, ${x.revokedAgain})`, x.revoked === true && x.revokedAgain === true);
    t(`R10: status after (${j(x.after)})`, x.after?.revoked === true && x.after?.exists === true);
    t(`R10: a revoked code is refused (${j(x.quoteStaff)})`, x.quoteStaff?.ok === false && x.quoteStaff?.reason === 'revoked' && x.quoteStaff?.refusal === 'coupon.expired');
    t(`R10: an unknown code: exists false (${j(x.unknown)})`, j(x.unknown) === j({ exists: false, redeemed_count: 0, expired: false, revoked: false }));
    t(`R10: not a code at all: null (${j(x.notACode)})`, x.notACode === null);
    t(`R10: revoking an unknown code is false (${x.revokeUnknown})`, x.revokeUnknown === false);
    t(`R10: a plugin cannot revoke a staff coupon (${x.revokeStaff}, still on: ${x.staffStillOn})`, x.revokeStaff === false && x.staffStillOn === true);
    t(`R10: status reports expiry (${j(x.expired)})`, x.expired?.expired === true);
  }

  // R11
  {
    const x = r.legacy;
    t(`R11: an old-shape coupon still quotes (${j(x.quote)})`, x.quote?.discount === 400);
    t(`R11: ...and still orders (${x.order.code}, ${j(x.order.totals)})`, x.order.code === 201 && j(x.order.totals) === j(x.quote));
    t(`R11: its per-customer limit still holds (${j(x.again.params)})`, x.again.code === 400 && x.again.params?.refusal === 'coupon.already_redeemed');
    t(`R11: ...for that customer only (${x.other}); counted twice (${x.used})`, x.other === 201 && x.used === 2);
    t(`R11: history from before per-email counting still counts, through the order scan (${j(x.history)})`, x.history?.refusal === 'coupon.already_redeemed');
    t(`R11: an automatic rule with a per-customer limit does not refuse the buyer's second order (${x.auto1}, ${x.auto2.code} ${x.auto2.errCode})`,
      x.auto1 === 201 && x.auto2.code === 201);
    t(`R11: ...and the quote agrees it still applies (${j(x.autoQuote)})`, x.autoQuote?.ok === true);
  }

  // Admin API
  {
    const x = r.admin;
    t(`A: a gift coupon naming no real product is refused (${x.giftUnknown.code} ${x.giftUnknown.message})`, x.giftUnknown.code === 400);
    t(`A: the contract's names work on POST (${j(x.fixedCreated)})`, x.fixedCreated.code === 201 && x.fixedCreated.kind === 'fixed' && x.fixedCreated.limit === 3);
    t(`A: a value-only edit of a fixed coupon is bounded as cents (${x.valueOnly})`, x.valueOnly === 200);
    t(`A: changing the kind without a value is refused (${x.kindNoValue.code} ${x.kindNoValue.message})`, x.kindNoValue.code === 400);
    t(`A: switching to gift_product without a gift is refused (${x.toGiftNoGift.code})`, x.toGiftNoGift.code === 400);
    t(`A: an admin switching a revoked coupon on revives it (${j(x.revived)})`, x.revived.code === 200 && x.revived.revoked_at === null && x.revived.status?.revoked === false);
  }

  // Conditions through the route
  {
    const x = r.conditions;
    t(`C: brand condition matches RAYBAN to Ray-Ban (${x.byBrand})`, x.byBrand === 1000);
    t(`C: ...and the published slug ray-ban (${x.bySlug})`, x.bySlug === 1000);
    t(`C: a brand nobody sells: not applicable (${x.nobody?.refusal})`, x.nobody?.refusal === 'coupon.not_applicable');
    t(`C: category AND brand that no line meets: not applicable (${x.both?.refusal})`, x.both?.refusal === 'coupon.not_applicable');
    t(`C: min subtotal: staff and strangers both see min_subtotal with the shortfall (${j(x.minStaff)} / ${j(x.minPublic)})`,
      x.minStaff?.refusal === 'coupon.min_subtotal' && x.minPublic?.refusal === 'coupon.min_subtotal' && x.minPublic?.shortfall_cents === 5000);
    t(`C: the order refuses it with the same code (${j(x.minOrder.params)})`, x.minOrder.code === 400 && x.minOrder.params?.refusal === 'coupon.min_subtotal');
  }
}

// The three drivers give the same answers (ids and codes differ; amounts may not).
{
  const names = Object.keys(results);
  const shape = (r) => j({
    parity: Object.fromEntries(Object.entries(r.parity ?? {}).map(([k, v]) => [k, v?.quote])),
    tax: r.tax, addons: r.addons, five: r.race?.five, rule: r.cancel?.rule,
    gift: r.gift?.quote?.totals, legacy: r.legacy?.quote,
  });
  check(`all three drivers ran (${names.join(', ')})`, names.length === 3);
  for (const n of names.slice(1)) check(`${n} agrees with ${names[0]} on every amount`, shape(results[n]) === shape(results[names[0]]));
}

await fs.rm(tmpRoot, { recursive: true, force: true });
console.log(`coupons-v2: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
