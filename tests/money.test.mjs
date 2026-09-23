#!/usr/bin/env node
/**
 * Order money maths: VAT, shipping rates, coupons, and the single calculation
 * that `quote` and `placeOrder` share.
 *
 * Every assertion here is about a number a customer is charged, so the bar is
 * higher than "it runs". The two properties that matter most:
 *
 *   1. **The parts reconcile to the whole, exactly.** An invoice whose lines do
 *      not sum to the charge is rejected by an accountant and queried by a tax
 *      authority. `totalsReconcile()` is asserted on every scenario, plus a
 *      randomised sweep, because a one-cent rounding drift is invisible until
 *      it is not.
 *   2. **Tax is charged on what is actually paid.** Taxing the pre-discount
 *      amount over-collects VAT on every discounted order.
 *
 * Run with:  node tests/money.test.mjs
 */
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cacheDir = path.join(here, '..', 'node_modules', '.cache');
await fs.mkdir(cacheDir, { recursive: true });

async function load(rel, tag) {
  const out = path.join(cacheDir, `astrobaas-${tag}-${process.pid}.mjs`);
  await build({
    entryPoints: [path.join(here, '..', rel)],
    bundle: true, format: 'esm', platform: 'node', packages: 'external',
    outfile: out, logLevel: 'silent',
  });
  const mod = await import(pathToFileURL(out).href);
  await fs.rm(out, { force: true });
  return mod;
}

const TAX = await load('src/lib/commerce/tax.ts', 'tax');
const SHIP = await load('src/lib/commerce/shipping.ts', 'ship');
const COUP = await load('src/lib/commerce/coupons.ts', 'coup');
const TOT = await load('src/lib/commerce/totals.ts', 'tot');
const OS = await load('src/lib/commerce/order-status.ts', 'ostat');
const NORM = await load('src/lib/commerce/admin-normalize.ts', 'anorm');
const VAR = await load('src/lib/commerce/variants.ts', 'variants');
const ABD = await load('src/lib/commerce/abandonment.ts', 'abandon');
const SN = await load('src/lib/commerce/sale-notify.ts', 'salenotify');

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) pass++;
  else {
    fail++;
    console.error(`✗ ${name}`);
  }
}

/* ================================================================ *
 * VAT
 * ================================================================ */
{
  const { splitTax, rateForClass, resolveTaxSettings, normalizeTaxRates,
    productIsTaxable, shippingIsTaxableFor, TAX_KEYS: K, MAX_RATE_BP } = TAX;

  // --- the invariant, first ---
  check('inclusive: net + tax === gross, exactly', (() => {
    for (let gross = 1; gross <= 3000; gross++) {
      const s = splitTax(gross, 2400, true);
      if (s.net_cents + s.tax_cents !== s.gross_cents) return false;
      if (s.gross_cents !== gross) return false;
    }
    return true;
  })());
  check('exclusive: net + tax === gross, exactly', (() => {
    for (let net = 1; net <= 3000; net++) {
      const s = splitTax(net, 2400, false);
      if (s.net_cents + s.tax_cents !== s.gross_cents) return false;
      if (s.net_cents !== net) return false;
    }
    return true;
  })());

  // --- extraction vs addition, the ~19% error if swapped ---
  // 24.80 incl. 24% VAT -> net 20.00, tax 4.80
  const incl = splitTax(2480, 2400, true);
  check('inclusive 24%: 24.80 extracts to 20.00 + 4.80',
    incl.net_cents === 2000 && incl.tax_cents === 480);
  // 20.00 excl. 24% VAT -> tax 4.80, gross 24.80
  const excl = splitTax(2000, 2400, false);
  check('exclusive 24%: 20.00 becomes 24.80', excl.tax_cents === 480 && excl.gross_cents === 2480);
  check('the two conventions are NOT the same operation',
    splitTax(2480, 2400, true).tax_cents !== splitTax(2480, 2400, false).tax_cents);

  check('Greek reduced 13% extracts correctly', (() => {
    const s = splitTax(1130, 1300, true);
    return s.net_cents === 1000 && s.tax_cents === 130;
  })());
  check('a zero rate is a no-op', (() => {
    const s = splitTax(1234, 0, true);
    return s.net_cents === 1234 && s.tax_cents === 0 && s.gross_cents === 1234;
  })());
  check('a negative rate cannot create negative tax', splitTax(1000, -500, true).tax_cents === 0);
  check('zero amount stays zero', splitTax(0, 2400, true).tax_cents === 0);

  // --- the rate table is DATA ---
  const settings = resolveTaxSettings({
    [K.enabled]: true,
    [K.rates]: [
      { class: 'standard', label: 'Standard', rate_bp: 2400 },
      { class: 'optical', label: 'Optical', rate_bp: 1300 },
    ],
    [K.defaultClass]: 'standard',
  });
  check('a configured class resolves to its rate', rateForClass(settings, 'optical') === 1300);
  check('class matching is case-insensitive', rateForClass(settings, 'OPTICAL') === 1300);
  // An unknown class must NOT silently become 0% — a typo would stop charging VAT.
  check('an UNKNOWN class falls back to the default rate, never to zero',
    rateForClass(settings, 'typo') === 2400 && rateForClass(settings, undefined) === 2400);
  check('tax disabled means no rate at all', rateForClass(resolveTaxSettings({}), 'standard') === 0);

  check('tax is OFF unless explicitly enabled', resolveTaxSettings({}).enabled === false);
  check('prices are inclusive by default (EU retail)', resolveTaxSettings({}).pricesIncludeTax === true);
  check('exclusive can be selected', resolveTaxSettings({ [K.pricesIncludeTax]: false }).pricesIncludeTax === false);

  // THE STRING FORMS. `POST /api/settings/update` stores whatever JSON a caller
  // sends, so an operator scripting their setup holds strings — and both of
  // these reads were strict. The second is the expensive one: `"false" !==
  // false` is TRUE, so a shop that chose tax-EXCLUSIVE pricing was charged
  // tax-INCLUSIVE, wrong by the whole VAT rate on every line of every order.
  check('the STRING "true" enables tax', resolveTaxSettings({ [K.enabled]: 'true' }).enabled === true);
  check('...and "false" does not', resolveTaxSettings({ [K.enabled]: 'false' }).enabled === false);
  check('the STRING "false" really selects EXCLUSIVE pricing',
    resolveTaxSettings({ [K.pricesIncludeTax]: 'false' }).pricesIncludeTax === false);
  check('...and "true" selects inclusive',
    resolveTaxSettings({ [K.pricesIncludeTax]: 'true' }).pricesIncludeTax === true);
  check('an unset inclusive flag still defaults to inclusive',
    resolveTaxSettings({ [K.pricesIncludeTax]: '' }).pricesIncludeTax === true);

  // A bad row must be DROPPED, not coerced to 0% (which under-charges silently).
  const cleaned = normalizeTaxRates([
    { class: 'ok', rate_bp: 2400 },
    { class: 'bad', rate_bp: -1 },
    { class: 'nan', rate_bp: 'lots' },
    { class: 'huge', rate_bp: MAX_RATE_BP + 1 },
    { class: 'ok', rate_bp: 999 },      // duplicate
    'not an object',
  ]);
  check('malformed rate rows are dropped, not zeroed', cleaned.length === 1 && cleaned[0].rate_bp === 2400);
  check('a completely invalid table falls back to defaults', normalizeTaxRates('nope').length > 0);

  // --- tax_status vocabulary ---
  check('taxable goods are taxed', productIsTaxable('taxable') && productIsTaxable(undefined));
  check("'none' means the goods are untaxed", !productIsTaxable('none'));
  check("'shipping' means the GOODS are untaxed", !productIsTaxable('shipping'));
  check("...but 'shipping' still taxes the delivery charge",
    shippingIsTaxableFor('shipping') && shippingIsTaxableFor('taxable') && !shippingIsTaxableFor('none'));
}

/* ================================================================ *
 * Shipping
 * ================================================================ */
{
  const { postcodeMatches, zoneMatches, rateFor, availableMethods,
    resolveChosenMethod, zoneSpecificity } = SHIP;

  // --- postcode patterns, incl. the Greek island case ---
  check('exact postcode', postcodeMatches('84600', '84600') && !postcodeMatches('84600', '84601'));
  check('prefix pattern', postcodeMatches('846*', '84600') && !postcodeMatches('846*', '10431'));
  check('numeric RANGE matches inside', postcodeMatches('84000-84999', '84600'));
  check('numeric range excludes outside', !postcodeMatches('84000-84999', '10431'));
  // A string compare would wrongly accept this; the match must be numeric.
  check('a longer number is not inside the range', !postcodeMatches('84000-84999', '8412345'));
  check('spaces and dashes are ignored', postcodeMatches('84600', '846 00') && postcodeMatches('84600', '846-00'));
  check('a reversed range still works', postcodeMatches('84999-84000', '84600'));
  check('empty input never matches', !postcodeMatches('', '84600') && !postcodeMatches('846*', ''));

  const mainland = { countries: ['GR'] };
  const islands = { countries: ['GR'], postcodes: ['84000-84999', '85*'] };
  check('a country zone matches any postcode in it', zoneMatches(mainland, { country: 'GR', postcode: '10431' }));
  check('a country zone rejects another country', !zoneMatches(mainland, { country: 'DE', postcode: '10115' }));
  check('an island zone matches an island postcode', zoneMatches(islands, { country: 'GR', postcode: '84600' }));
  check('an island zone rejects a mainland postcode', !zoneMatches(islands, { country: 'GR', postcode: '10431' }));
  // Guessing here would quote the wrong price for a real address.
  check('a postcode-restricted zone needs a postcode', !zoneMatches(islands, { country: 'GR' }));
  check('a wildcard zone matches anywhere', zoneMatches({ countries: ['*'] }, { country: 'JP' }));
  check('a more specific zone outranks a country-wide one',
    zoneSpecificity(islands) > zoneSpecificity(mainland) && zoneSpecificity(mainland) > zoneSpecificity({ countries: ['*'] }));

  const basket = (over = {}) => ({ subtotal_cents: 5000, weight_grams: 800, requiresShipping: true, ...over });
  const method = (over = {}) => ({
    id: 'm1', name: 'Courier', enabled: true, zone: mainland,
    rate: { kind: 'flat', amount_cents: 350 }, created_at: '', updated_at: '', ...over,
  });

  check('flat rate', rateFor(method(), basket()) === 350);
  check('a disabled method is unavailable', rateFor(method({ enabled: false }), basket()) === null);
  check('nothing to ship means no rate', rateFor(method(), basket({ requiresShipping: false })) === null);

  // Per STARTED kilogram, like a courier bills.
  const byWeight = method({ rate: { kind: 'weight', base_cents: 200, per_kg_cents: 100 } });
  check('weight: 800 g bills as 1 kg', rateFor(byWeight, basket({ weight_grams: 800 })) === 300);
  check('weight: 1200 g bills as 2 kg', rateFor(byWeight, basket({ weight_grams: 1200 })) === 400);
  check('weight: exactly 1000 g bills as 1 kg', rateFor(byWeight, basket({ weight_grams: 1000 })) === 300);
  check('weight: 0 g bills the base only', rateFor(byWeight, basket({ weight_grams: 0 })) === 200);

  const freeOver = method({ rate: { kind: 'free_over', threshold_cents: 5000, otherwise_cents: 400 } });
  check('free-shipping threshold: at the threshold it is free', rateFor(freeOver, basket({ subtotal_cents: 5000 })) === 0);
  check('free-shipping threshold: above it is free', rateFor(freeOver, basket({ subtotal_cents: 9999 })) === 0);
  check('free-shipping threshold: below it charges', rateFor(freeOver, basket({ subtotal_cents: 4999 })) === 400);

  check('weight bounds exclude a too-heavy basket',
    rateFor(method({ max_weight_grams: 500 }), basket({ weight_grams: 800 })) === null);
  check('weight bounds exclude a too-light basket',
    rateFor(method({ min_weight_grams: 1000 }), basket({ weight_grams: 800 })) === null);

  // --- the island-surcharge scenario end to end ---
  const methods = [
    method({ id: 'gr', name: 'Greece', zone: mainland, rate: { kind: 'flat', amount_cents: 350 }, position: 1 }),
    method({ id: 'isl', name: 'Islands', zone: islands, rate: { kind: 'flat', amount_cents: 750 }, position: 1 }),
  ];
  const athens = availableMethods(methods, { country: 'GR', postcode: '10431' }, basket());
  const rhodes = availableMethods(methods, { country: 'GR', postcode: '85100' }, basket());
  check('Athens is offered the mainland method only',
    athens.length === 1 && athens[0].id === 'gr' && athens[0].cost_cents === 350);
  // The important half: a customer must NOT be able to pick the cheap mainland
  // method for an island address.
  check('an island address is offered the ISLAND method only',
    rhodes.length === 1 && rhodes[0].id === 'isl' && rhodes[0].cost_cents === 750);
  check('a virtual-only basket is offered nothing',
    availableMethods(methods, { country: 'GR', postcode: '10431' }, basket({ requiresShipping: false })).length === 0);
  check('an unserved country is offered nothing',
    availableMethods(methods, { country: 'JP', postcode: '1000001' }, basket()).length === 0);

  // --- server-side validation of the customer's choice ---
  const dest = { country: 'GR', postcode: '10431' };
  check('a valid choice resolves to its server-side price', (() => {
    const r = resolveChosenMethod(methods, 'gr', dest, basket());
    return r.ok && r.method.cost_cents === 350;
  })());
  // The attack: pick the island-only method for a mainland address, or a
  // deleted one, hoping it falls back to free.
  check('a method not available for this destination is REFUSED',
    resolveChosenMethod(methods, 'isl', dest, basket()).ok === false);
  check('an unknown method id is REFUSED', resolveChosenMethod(methods, 'nope', dest, basket()).ok === false);
  check('omitting the choice when options exist is refused',
    resolveChosenMethod(methods, null, dest, basket()).ok === false);
  check('omitting the choice is fine when nothing ships', (() => {
    const r = resolveChosenMethod(methods, null, dest, basket({ requiresShipping: false }));
    return r.ok && r.method === null;
  })());
}

/* ================================================================ *
 * Coupons
 * ================================================================ */
{
  const { applyCoupon, allocateDiscount, normalizeCouponCode } = COUP;

  const NOW = Date.parse('2026-06-15T12:00:00Z');
  const ctx = (over = {}) => ({
    lines: [{ product_id: 'p1', amount_cents: 6000, categories: ['sun'] }],
    subtotal_cents: 6000,
    nowMs: NOW,
    ...over,
  });
  const coupon = (over = {}) => ({
    id: 'c1', code: 'SUMMER', kind: 'percent', value: 1000, enabled: true,
    used_count: 0, created_at: '', updated_at: '', ...over,
  });

  check('code matching is case- and space-insensitive',
    normalizeCouponCode(' summer ') === 'SUMMER' && normalizeCouponCode('sum mer') === 'SUMMER');

  check('10% off 60.00 is 6.00', (() => {
    const r = applyCoupon(coupon(), ctx());
    return r.ok && r.discount_cents === 600;
  })());
  check('a fixed coupon takes its amount', (() => {
    const r = applyCoupon(coupon({ kind: 'fixed', value: 500 }), ctx());
    return r.ok && r.discount_cents === 500;
  })());
  // Without the clamp this yields a NEGATIVE total downstream.
  check('a fixed coupon can never exceed the basket', (() => {
    const r = applyCoupon(coupon({ kind: 'fixed', value: 99999 }), ctx());
    return r.ok && r.discount_cents === 6000;
  })());

  // --- every rejection names its reason ---
  const rejects = [
    ['not-found', applyCoupon(null, ctx())],
    ['disabled', applyCoupon(coupon({ enabled: false }), ctx())],
    ['not-started', applyCoupon(coupon({ starts_at: '2026-07-01' }), ctx())],
    ['expired', applyCoupon(coupon({ ends_at: '2026-01-01' }), ctx())],
    ['minimum-not-met', applyCoupon(coupon({ min_subtotal_cents: 10000 }), ctx())],
    ['usage-limit-reached', applyCoupon(coupon({ usage_limit: 5, used_count: 5 }), ctx())],
    ['customer-limit-reached', applyCoupon(coupon({ usage_limit_per_customer: 1 }), ctx({ customerUses: 1 }))],
    ['no-eligible-items', applyCoupon(coupon({ product_ids: ['other'] }), ctx())],
  ];
  for (const [reason, r] of rejects) {
    check(`rejection "${reason}" is reported with that reason`, r.ok === false && r.reason === reason);
    check(`rejection "${reason}" carries a customer-facing message`, !r.ok && typeof r.message === 'string' && r.message.length > 5);
  }
  check('the minimum rejection says HOW MUCH more is needed', (() => {
    const r = applyCoupon(coupon({ min_subtotal_cents: 10000 }), ctx());
    return !r.ok && r.shortfall_cents === 4000;
  })());
  // Deliberately vague, so codes cannot be enumerated.
  check('"not found" does not confirm which codes exist',
    !/expired|disabled|limit/i.test(applyCoupon(null, ctx()).message));

  check('a validity window that is open on both sides is fine',
    applyCoupon(coupon({ starts_at: '2026-01-01', ends_at: '2026-12-31' }), ctx()).ok);

  // --- restrictions ---
  check('a product-restricted coupon applies to only that product', (() => {
    const r = applyCoupon(coupon({ kind: 'fixed', value: 1000, product_ids: ['p1'] }), ctx({
      lines: [
        { product_id: 'p1', amount_cents: 4000 },
        { product_id: 'p2', amount_cents: 2000 },
      ],
      subtotal_cents: 6000,
    }));
    return r.ok && r.eligible_cents === 4000;
  })());
  check('a category-restricted coupon matches by category', (() => {
    const r = applyCoupon(coupon({ category_slugs: ['sun'] }), ctx());
    return r.ok && r.eligible_cents === 6000;
  })());
  check('free_shipping is surfaced', applyCoupon(coupon({ free_shipping: true }), ctx()).freeShipping === true);

  /* --- discount allocation: the parts must sum to the whole --- */
  check('allocation sums exactly to the discount', (() => {
    for (const [amounts, disc] of [
      [[100, 100, 100], 10],
      [[333, 333, 334], 100],
      [[1, 1, 1], 2],
      [[999, 1], 500],
      [[7, 11, 13, 17], 23],
    ]) {
      const alloc = allocateDiscount(amounts, disc);
      if (alloc.reduce((s, n) => s + n, 0) !== Math.min(disc, amounts.reduce((s, n) => s + n, 0))) return false;
    }
    return true;
  })());
  check('no line is discounted below zero', (() => {
    const alloc = allocateDiscount([100, 50], 1000);
    return alloc[0] <= 100 && alloc[1] <= 50;
  })());
  check('allocation is deterministic', (() => {
    const a = allocateDiscount([333, 333, 334], 100);
    const b = allocateDiscount([333, 333, 334], 100);
    return a.join() === b.join();
  })());
  check('a zero discount allocates nothing', allocateDiscount([100, 200], 0).every((n) => n === 0));
  check('an empty basket allocates nothing', allocateDiscount([], 100).length === 0);
}

/* ================================================================ *
 * calculateTotals — the shared spine
 * ================================================================ */
{
  const { calculateTotals, totalsReconcile } = TOT;
  const { resolveTaxSettings, TAX_KEYS: K } = TAX;

  const taxOn = (inclusive = true) => resolveTaxSettings({
    [K.enabled]: true,
    [K.pricesIncludeTax]: inclusive,
    [K.rates]: [
      { class: 'standard', rate_bp: 2400 },
      { class: 'optical', rate_bp: 1300 },
    ],
    [K.defaultClass]: 'standard',
  });

  const line = (over = {}) => ({
    product_id: 'p1', name: 'Frame', qty: 1, unit_price_cents: 2480,
    tax_class: 'standard', tax_status: 'taxable', weight_grams: 100,
    requires_shipping: true, ...over,
  });

  // --- inclusive: extract ---
  const inc = calculateTotals({ lines: [line()], tax: taxOn(true) });
  check('inclusive: the customer pays the shelf price', inc.total_cents === 2480);
  check('inclusive: VAT is EXTRACTED, not added', inc.tax_cents === 480 && inc.lines[0].net_cents === 2000);
  check('inclusive: reconciles', totalsReconcile(inc));

  // --- exclusive: add ---
  const exc = calculateTotals({ lines: [line({ unit_price_cents: 2000 })], tax: taxOn(false) });
  check('exclusive: VAT is ADDED', exc.total_cents === 2480 && exc.tax_cents === 480);
  check('exclusive: reconciles', totalsReconcile(exc));

  // --- tax off ---
  const off = calculateTotals({ lines: [line()], tax: resolveTaxSettings({}) });
  check('tax disabled: no tax, total is the sum of lines', off.tax_cents === 0 && off.total_cents === 2480);
  check('tax disabled: reconciles', totalsReconcile(off));

  // --- per-product tax status ---
  const mixed = calculateTotals({
    lines: [line(), line({ product_id: 'p2', tax_status: 'none', unit_price_cents: 1000 })],
    tax: taxOn(true),
  });
  check("a 'none' line carries no tax", mixed.lines[1].tax_cents === 0);
  check('a taxable line beside it still does', mixed.lines[0].tax_cents === 480);
  check('mixed statuses reconcile', totalsReconcile(mixed));

  const optical = calculateTotals({ lines: [line({ tax_class: 'optical', unit_price_cents: 1130 })], tax: taxOn(true) });
  check('a per-product tax CLASS is honoured', optical.tax_cents === 130);

  // --- THE legal one: tax on the discounted amount ---
  const discounted = calculateTotals({ lines: [line()], tax: taxOn(true), discount_cents: 480 });
  check('a discount reduces the total', discounted.total_cents === 2000);
  check('VAT is charged on what is PAID, not on the pre-discount price',
    discounted.tax_cents === splitTaxRef(2000, 2400));
  check('discounted order reconciles', totalsReconcile(discounted));
  function splitTaxRef(gross, bp) { return gross - Math.round((gross * 10000) / (10000 + bp)); }

  // --- shipping ---
  const shipped = calculateTotals({ lines: [line()], tax: taxOn(true), shipping_cents: 500 });
  check('shipping is added to the total', shipped.total_cents === 2980);
  check('shipping carries its own tax', shipped.shipping_tax_cents > 0);
  check('shipping tax is included in the tax figure',
    shipped.tax_cents === shipped.lines[0].tax_cents + shipped.shipping_tax_cents);
  check('shipping reconciles', totalsReconcile(shipped));

  // A basket of untaxed goods must not attract VAT on its postage.
  const noTaxGoods = calculateTotals({
    lines: [line({ tax_status: 'none' })], tax: taxOn(true), shipping_cents: 500,
  });
  check('untaxed goods do not tax the shipping either', noTaxGoods.shipping_tax_cents === 0);
  // ...but 'shipping only' does tax it.
  const shipOnly = calculateTotals({
    lines: [line({ tax_status: 'shipping' })], tax: taxOn(true), shipping_cents: 500,
  });
  check("'shipping only' taxes the postage but not the goods",
    shipOnly.lines[0].tax_cents === 0 && shipOnly.shipping_tax_cents > 0);

  // --- virtual goods ---
  const virtual = calculateTotals({ lines: [line({ requires_shipping: false })], tax: taxOn(true) });
  check('a virtual-only basket requires no shipping', virtual.requires_shipping === false);
  check('a virtual line contributes no weight', virtual.weight_grams === 0);

  check('weight is summed across quantities',
    calculateTotals({ lines: [line({ qty: 3, weight_grams: 150 })], tax: taxOn(true) }).weight_grams === 450);

  // --- multi-line with an awkward discount: the parts MUST still add up ---
  const awkward = calculateTotals({
    lines: [
      line({ product_id: 'a', unit_price_cents: 333 }),
      line({ product_id: 'b', unit_price_cents: 333 }),
      line({ product_id: 'c', unit_price_cents: 334 }),
    ],
    tax: taxOn(true),
    discount_cents: 100,
    shipping_cents: 350,
  });
  check('an awkward 3-way discount still reconciles', totalsReconcile(awkward));
  check('the allocated discount sums to what was asked', awkward.discount_cents === 100);
  check('per-line discounts sum to the order discount',
    awkward.lines.reduce((s, l) => s + l.discount_cents, 0) === awkward.discount_cents);

  // --- randomised sweep: reconciliation is a PROPERTY, not a few examples ---
  check('reconciles across 2000 random baskets', (() => {
    let seed = 12345;
    const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    for (let i = 0; i < 2000; i++) {
      const inclusive = rnd(2) === 0;
      const n = 1 + rnd(4);
      const lines = Array.from({ length: n }, (_, j) => line({
        product_id: `p${j}`,
        qty: 1 + rnd(4),
        unit_price_cents: 1 + rnd(9999),
        tax_class: ['standard', 'optical', 'unknown'][rnd(3)],
        tax_status: ['taxable', 'none', 'shipping'][rnd(3)],
      }));
      const t = calculateTotals({
        lines,
        tax: taxOn(inclusive),
        discount_cents: rnd(3) === 0 ? rnd(2000) : 0,
        shipping_cents: rnd(3) === 0 ? rnd(1500) : 0,
      });
      if (!totalsReconcile(t)) return false;
      if (t.total_cents < 0) return false;
    }
    return true;
  })());

  // --- degenerate inputs ---
  check('an empty basket totals zero', (() => {
    const t = calculateTotals({ lines: [], tax: taxOn(true) });
    return t.total_cents === 0 && t.tax_cents === 0 && totalsReconcile(t);
  })());
  check('a zero-quantity line contributes nothing',
    calculateTotals({ lines: [line({ qty: 0 })], tax: taxOn(true) }).total_cents === 0);
  check('a discount larger than the basket cannot go negative', (() => {
    const t = calculateTotals({ lines: [line()], tax: taxOn(true), discount_cents: 999999 });
    return t.total_cents >= 0 && totalsReconcile(t);
  })());
  check('the convention is recorded on the result',
    calculateTotals({ lines: [line()], tax: taxOn(true) }).prices_include_tax === true &&
    calculateTotals({ lines: [line()], tax: taxOn(false) }).prices_include_tax === false);
}

/* ================================================================ *
 * Order state machine
 * ================================================================ */
{
  const { canTransition, allowedNextStatuses, ORDER_TRANSITIONS } = OS;

  check('the same status is always allowed (idempotent updates)',
    canTransition('pending', 'pending').ok && canTransition('refunded', 'refunded').ok);
  check('normal progress is allowed',
    canTransition('pending', 'processing').ok && canTransition('processing', 'completed').ok);
  check('a cancelled order can be reopened', canTransition('cancelled', 'processing').ok);
  check('a completed order can still be refunded (returns happen)',
    canTransition('completed', 'refunded').ok);

  // The one COMMERCE.md called out.
  check('refunded -> pending is REFUSED', !canTransition('refunded', 'pending').ok);
  check('refunded is terminal in every direction',
    ['pending', 'processing', 'completed', 'cancelled', 'on-hold', 'failed']
      .every((to) => !canTransition('refunded', to).ok));
  check('the refusal explains why', /already been returned/i.test(canTransition('refunded', 'pending').reason));
  check('a completed order cannot be un-shipped', !canTransition('completed', 'pending').ok);
  check('a failed payment cannot jump straight to completed', !canTransition('failed', 'completed').ok);
  check('a failed payment can be retried', canTransition('failed', 'pending').ok);

  check('every status has a transition list', ['pending', 'processing', 'on-hold', 'completed', 'cancelled', 'refunded', 'failed']
    .every((st) => Array.isArray(ORDER_TRANSITIONS[st])));
  check('allowedNextStatuses includes staying put', allowedNextStatuses('pending').includes('pending'));

  // The payment layer drives these; if any were refused, capture would break.
  check('the payment paths are all permitted transitions',
    canTransition('pending', 'processing').ok &&   // captured
    canTransition('pending', 'cancelled').ok &&    // failed
    canTransition('processing', 'refunded').ok);   // refunded
}

/* ================================================================ *
 * Operator input validation
 * ================================================================ */
{
  const { normalizeShippingMethod, normalizeCoupon } = NORM;

  const okMethod = {
    name: 'Courier', zone: { countries: ['GR'] }, rate: { kind: 'flat', amount_cents: 350 },
  };
  check('a valid method parses', normalizeShippingMethod(okMethod).ok);
  check('a method needs a name', !normalizeShippingMethod({ ...okMethod, name: '' }).ok);
  check('a method needs a zone with real countries',
    !normalizeShippingMethod({ ...okMethod, zone: { countries: [] } }).ok &&
    !normalizeShippingMethod({ ...okMethod, zone: { countries: ['GREECE'] } }).ok);
  check('the wildcard zone is accepted', normalizeShippingMethod({ ...okMethod, zone: { countries: ['*'] } }).ok);
  check('an unknown rate kind is REFUSED, not defaulted',
    !normalizeShippingMethod({ ...okMethod, rate: { kind: 'magic' } }).ok);
  // Coercing this to 0 would ship the catalogue free until someone noticed.
  check('a non-numeric amount is refused rather than zeroed',
    !normalizeShippingMethod({ ...okMethod, rate: { kind: 'flat', amount_cents: 'free' } }).ok);
  check('an inverted weight range is refused', !normalizeShippingMethod({
    ...okMethod, min_weight_grams: 5000, max_weight_grams: 1000,
  }).ok);
  check('valid postcode patterns survive', (() => {
    const r = normalizeShippingMethod({ ...okMethod, zone: { countries: ['GR'], postcodes: ['84000-84999', '85*', '10431'] } });
    return r.ok && r.value.zone.postcodes.length === 3;
  })());
  check('a nonsense postcode pattern is dropped', (() => {
    const r = normalizeShippingMethod({ ...okMethod, zone: { countries: ['GR'], postcodes: ['<script>'] } });
    return r.ok && !r.value.zone.postcodes;
  })());

  const okCoupon = { code: 'SUMMER10', kind: 'percent', value: 1000 };
  check('a valid coupon parses', normalizeCoupon(okCoupon).ok);
  check('the code is upper-cased', normalizeCoupon({ ...okCoupon, code: 'summer10' }).value.code === 'SUMMER10');
  check('a code with punctuation is refused', !normalizeCoupon({ ...okCoupon, code: 'SUM MER!' }).ok);
  check('kind must be percent or fixed', !normalizeCoupon({ ...okCoupon, kind: 'bogus' }).ok);
  check('a percentage above 100% is refused', !normalizeCoupon({ ...okCoupon, value: 10001 }).ok);
  check('100% exactly is allowed', normalizeCoupon({ ...okCoupon, value: 10000 }).ok);
  check('a fixed coupon may exceed 10000 (it is cents)', normalizeCoupon({ code: 'X1', kind: 'fixed', value: 50000 }).ok);
  // "no limit" is exactly the wrong reading of a typo'd date.
  check('an unparseable date is refused, not treated as no-limit',
    !normalizeCoupon({ ...okCoupon, ends_at: 'next tuesday' }).ok);
  check('an explicit null date clears the bound', normalizeCoupon({ ...okCoupon, ends_at: null }).value.ends_at === null);
  check('starts_at after ends_at is refused',
    !normalizeCoupon({ ...okCoupon, starts_at: '2026-12-01', ends_at: '2026-01-01' }).ok);
  check('a new coupon starts with zero uses', normalizeCoupon(okCoupon).value.used_count === 0);
  check('a partial update need not resend everything', normalizeCoupon({ enabled: false }, { partial: true }).ok);
}

/* ================================================================ *
 * Variants — eyewear needs colour x size, and stock is PER variant
 * ================================================================ */
{
  const { resolvePurchasable, explainResolveFailure, variantAvailability,
    isVariable, priceRange, totalVariantStock, optionsLabel } = VAR;

  const simple = {
    id: 'p1', name: 'Cloth', price_cents: 500, regular_price_cents: 500,
    sale_price_cents: null, on_sale: false, stock: 10, sku: 'CL-1',
    images: [{ src: '/a.jpg' }],
  };
  const frame = {
    id: 'p2', name: 'Aviator', price_cents: 12000, regular_price_cents: 12000,
    sale_price_cents: null, on_sale: false, stock: null, weight_grams: 30,
    images: [{ src: '/frame.jpg' }],
    variants: [
      { id: 'v-black', options: { Colour: 'Black', Size: '52' }, stock: 3, in_stock: true, enabled: true },
      { id: 'v-tort', options: { Colour: 'Tortoise', Size: '52' }, stock: 0, in_stock: false, enabled: true,
        price_cents: 13000, sku: 'AV-TORT', weight_grams: 34 },
      { id: 'v-off', options: { Colour: 'Gold', Size: '52' }, stock: 5, in_stock: true, enabled: false },
    ],
  };

  check('a product with variants is variable', isVariable(frame) && !isVariable(simple));

  // --- simple products still work exactly as before ---
  const s1 = resolvePurchasable(simple);
  check('a simple product resolves to itself', s1 && s1.price_cents === 500 && s1.stock === 10);
  // Sending a variant for a simple product is a client bug, not a fallback.
  check('a variant_id on a SIMPLE product is refused', resolvePurchasable(simple, 'v-black') === null);

  // --- variable products REQUIRE a choice ---
  check('a variable product with NO variant is refused', resolvePurchasable(frame) === null);
  check('the refusal names what must be chosen', (() => {
    const e = explainResolveFailure(frame, null);
    return e.code === 'variant-required' && /Colour/.test(e.message) && /Size/.test(e.message);
  })());
  check('an unknown variant is refused', resolvePurchasable(frame, 'v-nope') === null);
  check('a DISABLED variant is refused', resolvePurchasable(frame, 'v-off') === null);

  // --- inheritance ---
  const black = resolvePurchasable(frame, 'v-black');
  check('a variant inherits the parent price when it sets none', black.price_cents === 12000);
  check('a variant inherits the parent weight', black.weight_grams === 30);
  check('the resolved name carries the options', black.name === 'Aviator (Black / 52)');
  const tort = resolvePurchasable(frame, 'v-tort');
  check('a variant OVERRIDES the price when it sets one', tort.price_cents === 13000);
  check('a variant overrides sku and weight', tort.sku === 'AV-TORT' && tort.weight_grams === 34);

  // Stock must NEVER inherit — "how many black ones" is the whole question.
  check('stock comes from the VARIANT, not the parent',
    black.stock === 3 && tort.stock === 0 && frame.stock === null);

  check('optionsLabel is stable regardless of key order',
    optionsLabel({ Size: '52', Colour: 'Black' }) === optionsLabel({ Colour: 'Black', Size: '52' }));

  // --- availability reads the variant's count ---
  check('enough variant stock is available', variantAvailability(black, frame, 3).ok);
  check('too little variant stock is refused', !variantAvailability(black, frame, 4).ok);
  check('an out-of-stock variant is refused even though the parent is untracked',
    !variantAvailability(tort, frame, 1).ok);
  check('the refusal is a CONFLICT, not a bad request',
    variantAvailability(black, frame, 9).code === 'insufficient-stock');
  check('sold_individually still caps at 1',
    !variantAvailability(black, { ...frame, sold_individually: true }, 2).ok);
  check('backorders still override an empty variant',
    variantAvailability(tort, { ...frame, backorders: 'yes' }, 2).ok);

  // --- listing helpers ---
  const range = priceRange(frame);
  check('the price range spans the enabled variants', range.min === 12000 && range.max === 13000);
  check('a disabled variant is excluded from the range', range.max !== 12000 || range.min !== 13000);
  check('total stock sums the enabled variants', totalVariantStock(frame) === 3);
  check('an untracked variant makes the total unknown, not zero',
    totalVariantStock({ ...frame, variants: [{ id: 'a', options: { C: 'x' }, stock: null, in_stock: true, enabled: true }] }) === null);
}

/* ================================================================ *
 * Variant normalisation on write
 * ================================================================ */
{
  const PF = await load('src/lib/product-fields.ts', 'pf-var');
  const { normalizeVariants } = PF;

  const out = normalizeVariants([
    { options: { Colour: 'Black' }, stock: 3 },
    { options: { Colour: 'Black' }, stock: 9 },          // duplicate combo
    { options: {}, stock: 1 },                            // varies nothing
    { options: { Colour: 'Gold' }, stock: 2, enabled: false },
    'not an object',
  ]);
  check('valid variants survive', out.length === 2);
  check('a duplicate option combination is dropped', out.filter((v) => v.options.Colour === 'Black').length === 1);
  check('a variant with no options is dropped', !out.some((v) => Object.keys(v.options).length === 0));
  check('ids are generated when absent', out.every((v) => /^[A-Za-z0-9_-]+$/.test(v.id)));
  check('disabled is preserved', out.find((v) => v.options.Colour === 'Gold').enabled === false);
  check('in_stock is derived from stock', out.find((v) => v.options.Colour === 'Black').in_stock === true);
  check('untracked stock stays null', normalizeVariants([{ options: { C: 'x' }, stock: null }])[0].stock === null);

  // THE one that protects order history.
  const existing = [{ id: 'v-keepme', options: { Colour: 'Black' }, stock: 3, in_stock: true, enabled: true }];
  const edited = normalizeVariants([{ options: { Colour: 'Black' }, stock: 5 }], existing);
  check('editing a product REUSES the id for an unchanged option combo (order history)',
    edited[0].id === 'v-keepme');
  check('...and still applies the new stock', edited[0].stock === 5);
}

/* ================================================================ *
 * Abandonment — cancelling the wrong order takes goods from a payer
 * ================================================================ */
{
  const { shouldAbandon, selectAbandoned, resolveAbandonmentSettings,
    ABANDONMENT_KEYS: K, DEFAULT_ABANDON_DAYS, MIN_ABANDON_DAYS } = ABD;

  const NOW = Date.parse('2026-06-15T12:00:00Z');
  const daysAgo = (d) => new Date(NOW - d * 86_400_000).toISOString();
  const cfg = resolveAbandonmentSettings({});
  const order = (over = {}) => ({
    id: 'o1', status: 'pending', payment_status: 'unpaid',
    payment_method: 'bank-transfer', created_at: daysAgo(5), ...over,
  });

  check('the default window is 3 days', DEFAULT_ABANDON_DAYS === 3 && cfg.days === 3);

  // An IMPORTED order is never abandoned, whatever its status or age. It was
  // not placed through this checkout: no stock was held for it here, so
  // "cancel and return the stock" would CREDIT inventory for goods sold on the
  // old site years ago — and its historical dates make it look maximally
  // stale on day one.
  check('an imported order (wp_id stamp) is untouchable, even pending+unpaid+ancient',
    shouldAbandon(order({ wp_id: '500', created_at: daysAgo(2000) }), cfg, NOW).abandon === false);
  check('...with the reason naming the import',
    shouldAbandon(order({ wp_id: '500' }), cfg, NOW).reason === 'imported');
  check('an empty stamp does not exempt — only a real one',
    shouldAbandon(order({ wp_id: '' }), cfg, NOW).abandon === true);
  check('it is on by default', cfg.enabled === true);
  check('it can be switched off', resolveAbandonmentSettings({ [K.enabled]: false }).enabled === false);
  check('the window clamps to a sane range',
    resolveAbandonmentSettings({ [K.days]: 0 }).days === MIN_ABANDON_DAYS &&
    resolveAbandonmentSettings({ [K.days]: 9999 }).days === 90 &&
    resolveAbandonmentSettings({ [K.days]: 'soon' }).days === 3);

  check('a 5-day-old unpaid order IS abandoned', shouldAbandon(order(), cfg, NOW).abandon);
  check('a 2-day-old order is NOT yet', !shouldAbandon(order({ created_at: daysAgo(2) }), cfg, NOW).abandon);
  check('exactly at the window it qualifies', shouldAbandon(order({ created_at: daysAgo(3) }), cfg, NOW).abandon);

  // Every guard below exists because cancelling wrongly takes goods back from
  // someone who paid.
  check('a PAID order is never abandoned, however old',
    !shouldAbandon(order({ payment_status: 'paid' }), cfg, NOW).abandon);
  check('a processing order is never abandoned (a human moved it)',
    !shouldAbandon(order({ status: 'processing' }), cfg, NOW).abandon);
  check('an already-cancelled order is left alone',
    !shouldAbandon(order({ status: 'cancelled' }), cfg, NOW).abandon);
  check('a completed order is left alone', !shouldAbandon(order({ status: 'completed' }), cfg, NOW).abandon);
  check('a refunded order is left alone', !shouldAbandon(order({ status: 'refunded' }), cfg, NOW).abandon);
  check('a pending-payment order still counts as unpaid',
    shouldAbandon(order({ payment_status: 'pending' }), cfg, NOW).abandon);
  check('a FAILED payment is abandoned (the stock should come back)',
    shouldAbandon(order({ payment_status: 'failed' }), cfg, NOW).abandon);
  check('an order with an unparseable date is skipped, not assumed old',
    !shouldAbandon(order({ created_at: 'not a date' }), cfg, NOW).abandon);
  check('a FUTURE-dated order is not stale (clock skew, bad import)',
    !shouldAbandon(order({ created_at: new Date(NOW + 86_400_000).toISOString() }), cfg, NOW).abandon);
  check('disabled means nothing is abandoned',
    !shouldAbandon(order(), { enabled: false, days: 3 }, NOW).abandon);

  check('selectAbandoned picks only the qualifying orders', (() => {
    const picked = selectAbandoned([
      order({ id: 'stale' }),
      order({ id: 'fresh', created_at: daysAgo(1) }),
      order({ id: 'paid', payment_status: 'paid' }),
    ], cfg, NOW);
    return picked.length === 1 && picked[0].id === 'stale';
  })());
}

/* ------------------------------------------------------------------ *
 * New-sale notifications
 *
 * It runs on the checkout path, so the rule that matters most is that nothing
 * here can cost a sale. After that: an owner must never be told an order is
 * paid when it is not, and a customer's name must never be able to write mail
 * headers.
 * ------------------------------------------------------------------ */
{
  const {
    parseRecipients, resolveSaleNotifySettings, buildSaleNotification, notifyNewSale,
    formatMoney, SALE_NOTIFY_KEYS, MAX_SALE_RECIPIENTS,
  } = SN;
  const K = SALE_NOTIFY_KEYS;

  /* ---- recipients ---- */
  check('a single address parses', parseRecipients('a@b.gr').join() === 'a@b.gr');
  check('commas, spaces and newlines all separate',
    parseRecipients('a@b.gr, c@d.gr\ne@f.gr;g@h.gr').length === 4);
  check('duplicates collapse case-insensitively',
    parseRecipients('A@B.gr, a@b.gr').length === 1);
  check('the list is capped',
    parseRecipients(Array.from({ length: 30 }, (_, i) => `a${i}@b.gr`).join(',')).length
      === MAX_SALE_RECIPIENTS);

  for (const bad of ['notanemail', '@b.gr', 'a@', 'a@b', '', '   ']) {
    check(`"${bad}" is not accepted as a recipient`, parseRecipients(bad).length === 0);
  }
  // Whitespace SEPARATES, so this is one junk token and one address, not one
  // malformed address — the junk is dropped and the real one kept.
  check('junk beside a valid address drops only the junk',
    parseRecipients('a b@c.gr').join() === 'b@c.gr');
  // Header injection: a "recipient" carrying CRLF could add headers of its own.
  check('an address with a newline is refused',
    parseRecipients('a@b.gr\nBcc: evil@x.gr').filter((r) => r.includes('Bcc')).length === 0);
  check('an address with a comma-quote is refused', parseRecipients('"a"@b.gr').length === 0);
  for (const bad of [null, undefined, 42, [], {}]) {
    check(`${JSON.stringify(bad) ?? 'undefined'} yields no recipients`, parseRecipients(bad).length === 0);
  }

  /* ---- the toggle ---- */
  check('off by default', resolveSaleNotifySettings({}).enabled === false);
  check('on needs BOTH the switch and somebody to tell',
    resolveSaleNotifySettings({ [K.enabled]: true }).enabled === false
    && resolveSaleNotifySettings({ [K.recipients]: 'a@b.gr' }).enabled === false
    && resolveSaleNotifySettings({ [K.enabled]: true, [K.recipients]: 'a@b.gr' }).enabled === true);
  // THE REGRESSION THIS ASSERTION USED TO ENSHRINE.
  //
  // It read "a truthy-but-not-true value does not switch it on", asserting
  // `'yes'` stayed off — which sounds strict and was the bug. The relational
  // driver stores settings as TEXT, so a shop that switched this on holds the
  // STRING "true", and `=== true` read that as OFF: the toggle showed on in
  // every readback and the shop was never told about a single sale.
  //
  // The rule is `settingBool`'s vocabulary, the same one every other setting
  // uses: true/1/on/yes are on, false/0/off/no are off, anything else is the
  // default. Strictness belongs at the WRITE door (BOOLEAN_KEYS in
  // settings-validate.ts), not in a reader that has to cope with what three
  // storage drivers actually hand back.
  check('the STRING "true" switches it on — the TEXT drivers store nothing else',
    resolveSaleNotifySettings({ [K.enabled]: 'true', [K.recipients]: 'a@b.gr' }).enabled === true);
  check('...and so does every other affirmative settingBool accepts',
    resolveSaleNotifySettings({ [K.enabled]: 'yes', [K.recipients]: 'a@b.gr' }).enabled === true
    && resolveSaleNotifySettings({ [K.enabled]: '1', [K.recipients]: 'a@b.gr' }).enabled === true
    && resolveSaleNotifySettings({ [K.enabled]: 'on', [K.recipients]: 'a@b.gr' }).enabled === true);
  check('the STRING "false" is still off, which is the other half of the same bug',
    resolveSaleNotifySettings({ [K.enabled]: 'false', [K.recipients]: 'a@b.gr' }).enabled === false
    && resolveSaleNotifySettings({ [K.enabled]: '0', [K.recipients]: 'a@b.gr' }).enabled === false);
  check('genuine nonsense still does not switch it on',
    resolveSaleNotifySettings({ [K.enabled]: 'banana', [K.recipients]: 'a@b.gr' }).enabled === false);
  check('and a missing switch is still off however many recipients there are',
    resolveSaleNotifySettings({ [K.recipients]: 'a@b.gr, c@d.gr' }).enabled === false);

  /* ---- money ----
   * This is now a one-line delegation to lib/money-format.ts. It was the
   * divergence that module was written to end — this file produced "€89.00"
   * while five admin screens produced "89,00 €" — and it was the one caller
   * that never got converted.
   *
   * The assertions state the PROPERTIES that matter to an email rather than a
   * byte-exact string, because the exact placement of a currency code is
   * Intl's business and varies by locale and ICU version. The old local
   * version wrote "89.00 CHF"; Intl writes "CHF 89.00". Both keep the code,
   * which is the thing a reader needs.
   */
  check('euro formats with a symbol', formatMoney(8900, 'EUR').includes('€')
    && /89[.,]00/.test(formatMoney(8900, 'EUR')));
  check('an unknown currency keeps its CODE, wherever Intl puts it',
    formatMoney(8900, 'CHF').includes('CHF') && /89[.,]00/.test(formatMoney(8900, 'CHF')));
  check('zero formats', /0[.,]00/.test(formatMoney(0, 'EUR')) && formatMoney(0, 'EUR').includes('€'));
  check('a missing currency falls back to euro', formatMoney(150, '').includes('€')
    && /1[.,]50/.test(formatMoney(150, '')));
  check('a zero-decimal currency is NOT divided by 100 — the old local copy was',
    /8,?900/.test(formatMoney(8900, 'JPY')));

  /* ---- the message ---- */
  const order = (over = {}) => ({
    id: 'o1', number: '1042', total_cents: 8900, currency: 'EUR',
    email: 'buyer@example.gr', payment_method: 'iris-direct', payment_status: 'unpaid',
    created_at: '2026-08-25T09:00:00.000Z',
    items: [{ name: 'Σκελετός Α', qty: 1 }, { name: 'Φακοί', qty: 2 }],
    ...over,
  });

  const unpaid = buildSaleNotification(order(), { siteTitle: 'Οπτική Γωνία' });
  check('the subject carries the amount', unpaid.subject.includes('€89.00'));
  check('and the shop name', unpaid.subject.includes('Οπτική Γωνία'));
  // The distinction a shop owner acts on, before opening anything.
  check('an unpaid order says so in the SUBJECT', unpaid.subject.includes('NOT YET PAID'));
  check('and warns in the body against shipping it',
    /not marked paid/i.test(unpaid.text) && /not marked paid/i.test(unpaid.html));
  check('the items are listed', unpaid.text.includes('2 × Φακοί'));
  check('the customer is named', unpaid.text.includes('buyer@example.gr'));

  const paid = buildSaleNotification(order({ payment_status: 'paid' }));
  check('a paid order says PAID', paid.subject.includes('PAID'));
  check('and carries no shipping warning', !/not marked paid/i.test(paid.text));
  check('a pending order is neither', buildSaleNotification(order({ payment_status: 'pending' }))
    .subject.includes('awaiting confirmation'));

  /* ---- injection ---- */
  const nasty = buildSaleNotification(order({
    number: '10\r\nBcc: evil@x.gr',
    email: '<script>alert(1)</script>@x.gr',
    items: [{ name: '<img src=x onerror=alert(1)>', qty: 1 }],
  }), { siteTitle: 'Shop\nX-Header: bad' });
  check('CRLF cannot reach the subject line', !/[\r\n]/.test(nasty.subject));
  check('nor can a header be smuggled through the shop title',
    !nasty.subject.includes('X-Header:') || !/[\r\n]/.test(nasty.subject));
  check('HTML in an item name is escaped', !nasty.html.includes('<img src=x'));
  check('HTML in a customer address is escaped', !nasty.html.includes('<script>'));
  check('the escaped form is still readable', nasty.html.includes('&lt;img'));

  /* ---- an order with nothing in it must not throw ---- */
  for (const weird of [{ items: undefined }, { items: [] }, { items: 'nope' },
                       { total_cents: undefined }, { number: undefined }, { currency: undefined }]) {
    let threw = false;
    try { buildSaleNotification(order(weird)); } catch { threw = true; }
    check(`a malformed order (${Object.keys(weird)[0]}) builds rather than throws`, !threw);
  }

  /* ---- sending ---- */
  const sender = () => {
    const sent = [];
    return { sent, send: async (m) => { sent.push(m); } };
  };

  {
    const s1 = sender();
    const r = await notifyNewSale(order(), {
      readSettings: async () => ({ [K.enabled]: true, [K.recipients]: 'a@b.gr, c@d.gr' }),
      send: s1.send,
      siteUrl: 'https://shop.gr/',
    });
    check('every recipient is notified', r.sent === 2 && s1.sent.length === 2);
    // One `to:` per message — ten shop addresses in one header would show each
    // of them to all the others.
    check('each is mailed separately', s1.sent[0].to === 'a@b.gr' && s1.sent[1].to === 'c@d.gr');
    check('a link to the order is included', s1.sent[0].html.includes('/admin/orders?order=o1'));
    check('the trailing slash on siteUrl is not doubled', !s1.sent[0].html.includes('gr//admin'));
  }

  {
    const s2 = sender();
    const r = await notifyNewSale(order(), {
      readSettings: async () => ({}), send: s2.send,
    });
    check('nothing is sent when the setting is off', r.sent === 0 && s2.sent.length === 0);
    check('and the reason is reported', r.skipped === 'disabled');
  }

  // The rule that outranks the feature: a broken mail path must not cost a sale.
  {
    const errs = [];
    const r = await notifyNewSale(order(), {
      readSettings: async () => ({ [K.enabled]: true, [K.recipients]: 'a@b.gr, c@d.gr' }),
      send: async (m) => { if (m.to === 'a@b.gr') throw new Error('mailbox full'); },
      log: (msg) => errs.push(msg),
    });
    check('one failing address does not stop the others', r.sent === 1);
    check('and the failure is logged, not thrown', errs.length === 1);
  }
  {
    const errs = [];
    let threw = false;
    try {
      const r = await notifyNewSale(order(), {
        readSettings: async () => { throw new Error('db down'); },
        send: async () => {},
        log: (m) => errs.push(m),
      });
      check('an unreadable settings table is survived', r.sent === 0 && r.skipped === 'settings-unreadable');
    } catch { threw = true; }
    check('reading settings can fail without throwing', !threw && errs.length === 1);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);