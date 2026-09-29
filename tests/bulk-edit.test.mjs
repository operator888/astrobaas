#!/usr/bin/env node
/**
 * Bulk product edit (src/lib/commerce/bulk-edit.ts, POST /api/product-bulk).
 *
 * A bulk edit is the one admin action that can quietly ruin a catalogue in a
 * single click, so the planner's rules are pinned here one by one: money is
 * integer arithmetic that never goes negative, a flat price never flattens
 * deliberately different variant prices, an operation that is already true
 * changes nothing, and the route previews unless it is told to apply.
 *
 * Run with:  node tests/bulk-edit.test.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadTs, ROOT } from './lib/load.mjs';

const B = await loadTs('src/lib/commerce/bulk-edit.ts');
const read = (rel) => fs.readFile(path.join(ROOT, rel), 'utf8');

let passed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed += 1; } catch (err) { failures.push(`${name}: ${err.message}`); }
}
function ok(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, what = '') {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

const product = (over = {}) => ({
  id: 'p1', name: 'Linen shirt', status: 'active', featured: false,
  categories: ['shirts'], tags: ['Summer'], price_cents: 4900, regular_price_cents: 4900,
  sale_price_cents: null, stock: 10, variants: [], ...over,
});
const one = (p, ops) => B.planBulkEdit([p], ops)[0];

// ───────────────────────────────────────────────────── validation

check('an empty or unknown change is refused', () => {
  ok(B.bulkOpsProblem({}), 'accepted nothing');
  ok(B.bulkOpsProblem(null), 'accepted null');
  ok(/Unknown change: delete/.test(B.bulkOpsProblem({ delete: true }) ?? ''), 'accepted an unknown op');
});

check('a percentage change is bounded — a typo of 1000% or −100% is refused', () => {
  ok(B.bulkOpsProblem({ price: { mode: 'percent', value: 1000 } }), 'accepted +1000%');
  ok(B.bulkOpsProblem({ price: { mode: 'percent', value: -100 } }), 'accepted −100%');
  eq(B.bulkOpsProblem({ price: { mode: 'percent', value: -30 } }), null);
});

check('a set price is whole, non-negative cents', () => {
  ok(B.bulkOpsProblem({ price: { mode: 'set', value: -1 } }), 'accepted a negative price');
  ok(B.bulkOpsProblem({ price: { mode: 'set', value: 12.5 } }), 'accepted fractional cents');
  ok(B.bulkOpsProblem({ price: { mode: 'amount', value: 0.5 } }), 'accepted a fractional amount');
});

check('a sale is strictly between 0% and 100% off', () => {
  ok(B.bulkOpsProblem({ sale: { mode: 'percent_off', value: 100 } }), 'accepted 100% off');
  ok(B.bulkOpsProblem({ sale: { mode: 'percent_off', value: 0 } }), 'accepted 0% off');
  eq(B.bulkOpsProblem({ sale: { mode: 'clear' } }), null);
});

// ───────────────────────────────────────────────────────── money

check('percentages round half away from zero, on integer cents', () => {
  eq(B.applyPrice(4900, { mode: 'percent', value: 10 }), 5390);
  eq(B.applyPrice(1005, { mode: 'percent', value: -50 }), 503, '502.5 rounds to 503');
});

check('no price goes below zero', () => {
  eq(B.applyPrice(300, { mode: 'amount', value: -500 }), 0);
});

check('a price change moves the REGULAR price and leaves the sale to saveProduct', () => {
  const r = one(product({ sale_price_cents: 3900, price_cents: 3900 }), { price: { mode: 'percent', value: 10 } });
  eq(r.patch, { regular_price_cents: 5390 });
});

check('a flat price is refused for a product whose variants have their own prices', () => {
  const r = one(product({ variants: [{ id: 'v1', options: { Size: 'M' }, price_cents: 5200, stock: 1, in_stock: true, enabled: true }] }),
    { price: { mode: 'set', value: 3000 } });
  ok(r.skipped && /own prices/.test(r.skipped), 'a flat price would flatten the variants');
  eq(r.patch, {}, 'a skipped product gets no changes at all');
});

check('a percentage moves variant prices too; the sale stays for checkout to derive', () => {
  const v = { id: 'v1', options: { Size: 'M' }, price_cents: 5000, regular_price_cents: 5000, sale_price_cents: 4000, stock: 1, in_stock: true, enabled: true };
  const inherit = { id: 'v2', options: { Size: 'L' }, stock: 1, in_stock: true, enabled: true };
  const r = one(product({ variants: [v, inherit] }), { price: { mode: 'percent', value: 10 } });
  eq(r.patch.variants[0].regular_price_cents, 5500);
  // price_cents is the REGULAR price: checkout applies sale_price_cents only
  // inside the product's sale window. Writing the sale price here charged it
  // before the sale started and after it ended.
  eq(r.patch.variants[0].price_cents, 5500, 'the sale price was baked into price_cents');
  eq(r.patch.variants[0].sale_price_cents, 4000, 'the variant lost its sale price');
  eq(r.patch.variants[1], inherit, 'a variant that inherits the price was touched');
});

check('a change that would make a product free is skipped, not clamped to 0', () => {
  const r = one(product({ regular_price_cents: 1500, price_cents: 1500 }), { price: { mode: 'amount', value: -2000 } });
  ok(r.skipped && /free/.test(r.skipped), '−20.00 made a 15.00 product free');
  eq(r.patch, {});
  eq(one(product(), { price: { mode: 'set', value: 0 } }).patch, { regular_price_cents: 0 }, 'setting 0 on purpose is allowed');
});

check('a product-level sale is refused where variants have their own prices — it would not reach them', () => {
  const v = { id: 'v1', options: {}, price_cents: 5000, stock: 1, in_stock: true, enabled: true };
  const r = one(product({ variants: [v] }), { sale: { mode: 'percent_off', value: 20 } });
  ok(r.skipped && /own prices/.test(r.skipped), 'a sale badge with full-price variants');
});

check('ending a sale ends variant sales too', () => {
  const v = { id: 'v1', options: {}, price_cents: 5000, sale_price_cents: 4000, stock: 1, in_stock: true, enabled: true };
  const r = one(product({ variants: [v] }), { sale: { mode: 'clear' } });
  eq(r.patch.variants[0].sale_price_cents, null);
});

check('a sale is a percentage off the regular price', () => {
  eq(one(product(), { sale: { mode: 'percent_off', value: 20 } }).patch, { sale_price_cents: 3920 });
  eq(one(product({ sale_price_cents: 3900 }), { sale: { mode: 'clear' } }).patch, { sale_price_cents: null });
  eq(one(product(), { sale: { mode: 'clear' } }).changes, [], 'ending a sale that does not exist is a change');
});

// ───────────────────────────────────────────────────── the rest

check('an operation that is already true changes nothing', () => {
  eq(one(product(), { status: 'active', featured: false, addCategories: ['shirts'], addTags: ['summer'] }).changes, []);
});

check('categories are added and removed without duplicates', () => {
  eq(one(product(), { addCategories: ['linen', 'shirts'], removeCategories: ['shirts'] }).patch.categories.sort(), ['linen', 'shirts'].sort(),
    'remove then add: shirts is re-added by the add list');
  eq(one(product(), { removeCategories: ['shirts'] }).patch.categories, []);
});

check('tags match without regard to case', () => {
  eq(one(product(), { removeTags: ['SUMMER'] }).patch.tags, []);
});

check('stock is refused for a product with variants, which keep their own', () => {
  const r = one(product({ variants: [{ id: 'v1', options: {}, stock: 3, in_stock: true, enabled: true }] }), { stock: 50 });
  ok(r.skipped && /variants/.test(r.skipped), 'stock was set over the variants');
  eq(one(product(), { stock: null }).patch, { stock: null }, '"not tracked" is a value');
});

// ───────────────────────────────────────────────── the route

const route = await read('src/pages/api/product-bulk.ts');
const apply = await read('src/lib/commerce/bulk-apply.ts');
check('the route previews unless told to apply', () => {
  ok(/if \(body\?\.apply !== true\) \{\s*return ApiResponseBuilder\.success\(\{\s*preview: true/.test(route), 'a request without apply:true changes products');
});
check('each product is saved through saveProduct, with the stock it read as bases, from a real copy', () => {
  ok(/applyPlannedUpdates\(toApply, byId,/.test(route), 'the route does not apply through the shared path');
  ok(/const all = structuredClone\(stored\);/.test(route), 'the route plans from live cached objects (lowdb) — bases would match a sale made meanwhile');
  ok(/await saveProduct\(plan\.patch, plan\.id, meta\.actor, bases\)/.test(apply), 'not through saveProduct with bases — a concurrent sale would be written back');
  ok(/variants: new Map\(\(before\.variants \?\? \[\]\)\.map\(\(v\) => \[v\.id, v\.stock \?\? null\]/.test(apply), 'variant stock is not passed as a base');
  ok(!/LocalDB\.updateProduct\(/.test(route), 'a raw storage write');
});
check('catalogue staff only, bounded, audited', () => {
  ok(/canManageCatalog\(session\.role\)/.test(route), 'no role check');
  ok(/ids\.length > MAX_BULK/.test(route), 'no size bound');
  ok(/recordAudit\(AUDIT\.PRODUCT_BULK_EDIT/.test(route), 'not audited');
});
{
  const mw = await read('src/middleware.ts');
  const scopes = await read('src/lib/api-key-scopes.ts');
  check('it is gated by the commerce master switch and the products API-key scope', () => {
    ok(/\(products\|product-categories\|product-bulk\|/.test(mw), 'reachable on a site that is not a shop');
    ok(/pathname === '\/api\/product-bulk'.*return `products:\$\{action\}`/.test(scopes), 'no API-key scope maps to it');
  });
}

if (failures.length) {
  console.error(`\n✗ bulk-edit: ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error(`  · ${f}`);
  process.exit(1);
}
console.log(`✓ bulk-edit: ${passed} passed`);
