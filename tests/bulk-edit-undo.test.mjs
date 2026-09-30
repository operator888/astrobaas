#!/usr/bin/env node
/**
 * Bulk edit, second round: conditions, CSV updates, and undo.
 *
 *  - a condition narrows a change to the products that meet it;
 *  - a CSV row changes exactly the cells it fills in, finds variants by their
 *    SKU, and a file with a bad row is refused as a whole;
 *  - undo puts back only what still holds the batch's value — never stock a
 *    checkout sold afterwards, never a price someone edited since.
 *
 * The undo cases run against real storage through saveProduct.
 *
 * Run with:  node tests/bulk-edit-undo.test.mjs
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadTs, loadTogether, ROOT } from './lib/load.mjs';

const B = await loadTs('src/lib/commerce/bulk-edit.ts');
const C = await loadTs('src/lib/commerce/bulk-csv.ts');
const H = await loadTs('src/lib/commerce/bulk-history.ts');
const CSV = await loadTs('src/lib/csv.ts');
const read = (rel) => fs.readFile(path.join(ROOT, rel), 'utf8');

let passed = 0;
const failures = [];
async function check(name, fn) {
  try { await fn(); passed += 1; } catch (err) { failures.push(`${name}: ${err.message}`); }
}
function ok(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, what = '') {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

const product = (over = {}) => ({
  id: 'p1', name: 'Linen shirt', slug: 'linen-shirt', sku: 'LS-1', status: 'active', featured: false,
  categories: ['shirts'], tags: [], price_cents: 4900, regular_price_cents: 4900, sale_price_cents: null,
  on_sale: false, stock: 10, variants: [], ...over,
});
const cats = [{ slug: 'clothing' }, { slug: 'shirts', parent_slug: 'clothing' }, { slug: 'shoes' }];

// ─────────────────────────────────────────────────────── conditions

await check('a condition narrows the change; the rest are counted as not matching', () => {
  const plan = B.planBulkEdit([product(), product({ id: 'p2', status: 'draft' })], { featured: true }, { where: { status: ['draft'] } });
  eq(plan.map((p) => [p.id, !!p.unmatched, p.changes.length]), [['p1', true, 0], ['p2', false, 1]]);
});

await check('a category condition includes its subcategories', () => {
  ok(B.matchesWhere(product(), { category: 'clothing' }, cats), 'a shirt is not "in clothing"');
  ok(!B.matchesWhere(product(), { category: 'shoes' }, cats), 'a shirt is "in shoes"');
});

await check('stock, sale and price-range conditions', () => {
  ok(B.matchesWhere(product({ stock: 0 }), { stock: 'out' }), 'sold out');
  ok(B.matchesWhere(product({ stock: null }), { stock: 'untracked' }), 'untracked');
  ok(!B.matchesWhere(product(), { on_sale: true }), 'not on sale');
  ok(B.matchesWhere(product(), { price_min: 4900, price_max: 4900 }), 'inclusive bounds');
  ok(!B.matchesWhere(product(), { price_max: 4899 }), 'above the range');
});

await check('a malformed condition is refused', () => {
  ok(B.whereProblem({ status: [] }), 'an empty status list');
  ok(B.whereProblem({ stock: 'lots' }), 'an unknown stock state');
  ok(B.whereProblem({ price_min: 500, price_max: 100 }), 'an inverted range');
  ok(B.whereProblem({ owner: 'x' }), 'an unknown key');
  eq(B.whereProblem(undefined), null);
});

// ───────────────────────────────────────────────────────────── CSV

const variantProduct = product({
  id: 'p2', name: 'Frame', slug: 'frame', sku: 'FR', stock: null,
  variants: [
    { id: 'v1', sku: 'FR-52', options: { Size: '52' }, price_cents: 9000, regular_price_cents: 9000, stock: 3, in_stock: true, enabled: true },
    { id: 'v2', sku: 'FR-54', options: { Size: '54' }, price_cents: 9000, regular_price_cents: 9000, stock: 4, in_stock: true, enabled: true },
  ],
});
const catalogue = [product(), variantProduct, product({ id: 'p3', name: 'No SKU', slug: 'no-sku', sku: undefined })];
const plan = (text) => C.planCsvUpdate(CSV.parseCsv(text), catalogue, { minor: 100 });

await check('an empty cell changes nothing; a filled one changes only that field', () => {
  const r = plan('sku,price,stock\nLS-1,52.00,\n');
  eq(r.rowErrors, []);
  eq(r.products[0].patch, { regular_price_cents: 5200 });
});

await check('a variant\'s SKU updates that variant, and stock too', () => {
  const r = plan('sku,price,stock\nFR-52,95.00,7\n');
  const v1 = r.products[0].patch.variants.find((v) => v.id === 'v1');
  eq([v1.regular_price_cents, v1.price_cents, v1.stock], [9500, 9500, 7]);
  eq(r.products[0].patch.variants.find((v) => v.id === 'v2').stock, 4, 'the other size moved');
});

await check('each row uses the first key it fills in, so SKU-less products work by slug', () => {
  const r = plan('sku,slug,status\n,no-sku,draft\nLS-1,,archived\n');
  eq(r.rowErrors, []);
  eq(r.products.map((p) => [p.id, p.patch.status]).sort(), [['p1', 'archived'], ['p3', 'draft']]);
});

await check('bad rows are reported with their row numbers', () => {
  const r = plan('sku,price,status,featured\nLS-1,"1,000",,\nNOPE,1,,\nFR-52,,active,\nLS-1,,,maybe\n');
  const byRow = Object.fromEntries(r.rowErrors.map((e) => [e.row, e.message]));
  ok(/thousands separator/.test(byRow[2] ?? ''), `"1,000" was read as a number: ${byRow[2]}`);
  ok(/No product with sku "NOPE"/.test(byRow[3] ?? ''), 'an unknown SKU passed');
  ok(/belongs to the product/.test(byRow[4] ?? ''), 'status was set on a variant');
  ok(/not yes or no/.test(byRow[5] ?? ''), '"maybe" passed as featured');
});

await check('"1.000" is refused in euros (a thousand, or one?) but is a price in dinars', () => {
  ok(plan('sku,price\nLS-1,1.000\n').rowErrors.length, '"1.000" read as a euro price');
  const kwd = C.planCsvUpdate(CSV.parseCsv('sku,price\nLS-1,1.250\n'), catalogue, { minor: 1000 });
  eq(kwd.rowErrors, []);
  eq(kwd.products[0].patch.regular_price_cents, 1250);
});

await check('two rows setting one field differently is an error, not "last row wins"', () => {
  const r = plan('sku,price\nLS-1,10\nLS-1,11\n');
  ok(r.rowErrors.some((e) => /Rows 2 and 3 set price differently/.test(e.message)), JSON.stringify(r.rowErrors));
});

await check('a product-level price where variants have their own is a row error, so the file cannot apply', () => {
  const r = plan('sku,price\nFR,50\nFR-52,95\n');
  ok(r.rowErrors.some((e) => e.row === 2 && /own prices/.test(e.message)), JSON.stringify(r.rowErrors));
});

await check('a semicolon-separated file gets a sentence that says so', () => {
  ok(/semicolons/.test(plan('sku;price\nLS-1;49\n').rowErrors[0]?.message ?? ''), 'unhelpful message');
});

await check('a file needs a key column and something to change', () => {
  ok(plan('name,price\nx,1\n').rowErrors.length, 'no key column accepted');
  ok(plan('sku,name\nLS-1,x\n').rowErrors.length, 'nothing to change accepted');
  eq(plan('sku,price,name\nLS-1,49.00,Linen\n').ignoredColumns, ['name']);
});

await check('the template, uploaded unchanged, changes nothing', () => {
  const template = CSV.parseCsv(CSV.toCsv(C.CSV_TEMPLATE_COLUMNS, C.csvTemplateRows(catalogue, 100)));
  const r = C.planCsvUpdate(template, catalogue, { minor: 100 });
  eq(r.rowErrors, []);
  eq(r.products.filter((p) => p.changes.length).map((p) => p.changes), []);
});

// ─────────────────────────────────────────────────── undo, planned

await check('undo restores a field only while it still holds the batch\'s value', () => {
  const record = { id: 'b-1', at: '', actor: 'a', kind: 'bulk', label: 'x', products: {
    p1: { name: 'Linen shirt', changes: [
      { path: 'regular_price_cents', before: 4900, after: 5390 },
      { path: 'stock', before: 10, after: 50 },
    ] },
  } };
  // Since the batch: the price is untouched, but 3 sold (50 → 47).
  const now = new Map([['p1', product({ regular_price_cents: 5390, price_cents: 5390, stock: 47 })]]);
  const [u] = H.planUndo(record, now);
  eq(u.patch, { regular_price_cents: 4900 }, 'the stock a checkout sold would come back');
  ok(u.kept.some((k) => /^stock: changed since/.test(k)), 'the kept field is not reported');
});

await check('variant fields are undone by variant id', () => {
  const record = { id: 'b-2', at: '', actor: 'a', kind: 'csv', label: 'x', products: {
    p2: { name: 'Frame', changes: [{ path: 'variants.v1.regular_price_cents', before: 9000, after: 9500 }] },
  } };
  const now = new Map([['p2', { ...variantProduct, variants: variantProduct.variants.map((v) => (v.id === 'v1' ? { ...v, regular_price_cents: 9500 } : v)) }]]);
  const [u] = H.planUndo(record, now);
  eq(u.patch.variants.find((v) => v.id === 'v1').regular_price_cents, 9000);
});

// ───────────────────────────── apply and undo, against real storage

{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ab-bulk-undo-'));
  process.env.DB_PATH = path.join(dir, 'db.json');
  process.env.UPLOADS_DIR = path.join(dir, 'uploads');
  process.env.AUTH_SECRET ||= 'bulk-undo-test-secret-0123456789abcdef0123';
  const [{ LocalDB }, A, Hist] = await loadTogether(
    ['src/lib/localdb.ts', 'src/lib/commerce/bulk-apply.ts', 'src/lib/commerce/bulk-history.ts'], 'bulkundo');
  await LocalDB.init();
  const p = await LocalDB.createProduct({ name: 'Mug', slug: 'mug', status: 'active', price_cents: 1000, regular_price_cents: 1000, stock: 10, in_stock: true, categories: [], images: [], on_sale: false });
  const snapshot = structuredClone(await LocalDB.getProduct(p.id));
  const applied = await A.applyPlannedUpdates(
    [{ id: p.id, name: 'Mug', patch: { regular_price_cents: 1200, stock: 50 } }],
    new Map([[p.id, snapshot]]),
    { actor: 'tester', kind: 'bulk', label: 'price and stock' },
  );
  await check('applying records the batch with before and after', async () => {
    eq(applied.updated, 1);
    const rec = (await A.recentBatches())[0];
    ok(rec && rec.id === applied.batch, 'no history record');
    const paths = rec.products[p.id].changes.map((c) => c.path).sort();
    ok(paths.includes('regular_price_cents') && paths.includes('stock'), paths.join());
  });

  // A checkout sells 3 after the batch.
  await LocalDB.reserveStock(p.id, 3);
  const rec = (await A.recentBatches())[0];
  const now = new Map([[p.id, await LocalDB.getProduct(p.id)]]);
  const [undo] = Hist.planUndo(rec, now);
  // Two claims at once (a double click): exactly one may win.
  const [claimed, claimedTwice] = await Promise.all([A.claimUndo(rec, 'tester'), A.claimUndo(rec, 'tester')]);
  const undone = await A.applyPlannedUpdates([undo], now, { actor: 'tester', kind: 'undo', label: 'Undo' });
  await A.releaseUndo(rec, true);
  const after = await LocalDB.getProduct(p.id);
  await check('undo restored the price, and kept the stock the checkout sold', () => {
    eq(undone.updated, 1);
    eq(after.regular_price_cents, 1000);
    eq(after.price_cents, 1000, 'the effective price did not follow');
    eq(after.stock, 47, 'undo gave back sold stock (or lost the sale)');
  });
  await check('an undo is claimed once: a second claim (a double click) is refused', () => {
    ok(claimed === true && claimedTwice === false, `claims: ${claimed}, ${claimedTwice}`);
  });
  await check('a batch is marked undone, and the undo is itself in the history', async () => {
    const all = await A.recentBatches();
    ok(all.find((b) => b.id === rec.id)?.undone_at, 'not marked undone');
    ok(all.some((b) => b.kind === 'undo'), 'the undo is not recorded');
  });
}

// ─────────── what the record holds: only the fields the batch set
{
  const [{ LocalDB }, A, Hist] = await loadTogether(
    ['src/lib/localdb.ts', 'src/lib/commerce/bulk-apply.ts', 'src/lib/commerce/bulk-history.ts'], 'bulkundo2');
  await LocalDB.init();

  // A long batch: the snapshot is read, then a checkout sells one, then the
  // price change is saved. The sale must not become part of the batch.
  const q = await LocalDB.createProduct({ name: 'Cup', slug: 'cup', status: 'active', price_cents: 800, regular_price_cents: 800, stock: 10, in_stock: true, categories: [], images: [], on_sale: false });
  // A copy, as the routes take one: on lowdb the getter returns the live object.
  const snap = structuredClone(await LocalDB.getProduct(q.id));
  await LocalDB.reserveStock(q.id, 1);
  const r1 = await A.applyPlannedUpdates([{ id: q.id, name: 'Cup', patch: { regular_price_cents: 880 } }], new Map([[q.id, snap]]), { actor: 't', kind: 'bulk', label: 'cup' });
  const rec1 = (await A.recentBatches()).find((b) => b.id === r1.batch);
  await check('a sale made during a batch is not recorded as part of it', () => {
    eq(rec1.products[q.id].changes.map((c) => c.path), ['regular_price_cents']);
  });
  const now1 = new Map([[q.id, await LocalDB.getProduct(q.id)]]);
  await A.applyPlannedUpdates(Hist.planUndo(rec1, now1), now1, { actor: 't', kind: 'undo', label: 'u' });
  const cup = await LocalDB.getProduct(q.id);
  await check('...so undoing the batch keeps that sale', () => {
    eq([cup.regular_price_cents, cup.stock], [800, 9]);
  });

  // A product stored with only price_cents (the WooCommerce import's shape).
  const w = await LocalDB.createProduct({ name: 'Bowl', slug: 'bowl', status: 'active', price_cents: 1000, stock: 5, in_stock: true, categories: [], images: [], on_sale: false });
  const wSnap = structuredClone(await LocalDB.getProduct(w.id));
  const r2 = await A.applyPlannedUpdates([{ id: w.id, name: 'Bowl', patch: { regular_price_cents: 1100 } }], new Map([[w.id, wSnap]]), { actor: 't', kind: 'bulk', label: 'bowl' });
  const rec2 = (await A.recentBatches()).find((b) => b.id === r2.batch);
  const now2 = new Map([[w.id, await LocalDB.getProduct(w.id)]]);
  await A.applyPlannedUpdates(Hist.planUndo(rec2, now2), now2, { actor: 't', kind: 'undo', label: 'u' });
  const bowl = await LocalDB.getProduct(w.id);
  await check('undo restores the price of a product stored without a regular price', () => {
    eq(bowl.price_cents, 1000, 'undo reported success and left the new price');
  });
}

// ──── the real route, on the JSON driver, with a sale mid-batch
{
  const [{ LocalDB }, route] = await loadTogether(
    ['src/lib/localdb.ts', 'src/pages/api/product-bulk.ts'], 'bulkroute');
  await LocalDB.init();
  const variants = [
    { id: 'v-black', sku: 'RB-B', options: { Colour: 'Black' }, price_cents: 5000, regular_price_cents: 5000, stock: 3, in_stock: true, enabled: true },
    { id: 'v-tort', sku: 'RB-T', options: { Colour: 'Tortoise' }, price_cents: 5000, regular_price_cents: 5000, stock: 3, in_stock: true, enabled: true },
  ];
  const mk = (name, slug) => LocalDB.createProduct({ name, slug, status: 'active', type: 'variable', price_cents: 5000, stock: null, in_stock: true, categories: [], images: [], on_sale: false, variants: structuredClone(variants) });
  const first = await mk('Route frame A', 'route-frame-a');
  const second = await mk('Route frame B', 'route-frame-b');
  // The batch saves A, then B. While it is saving A, a checkout sells one Black
  // of B. On lowdb the route's read was the LIVE cached object, so B's stock
  // base then showed the sale while B's planned patch still carried the count
  // from planning time — and the stale count was written back: an oversell.
  let sold = false;
  const getProduct = LocalDB.getProduct.bind(LocalDB);
  LocalDB.getProduct = async (id) => {
    if (!sold && id === first.id) { sold = true; await LocalDB.reserveStock(second.id, 1, { variantId: 'v-black' }); }
    return getProduct(id);
  };
  const res = await route.POST({
    request: new Request('http://localhost/api/product-bulk', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [first.id, second.id], ops: { price: { mode: 'percent', value: 10 } }, apply: true }),
    }),
    locals: { user: { id: 'route-admin', role: 'admin' }, ip: '127.0.0.1' },
  });
  LocalDB.getProduct = getProduct;
  const black = (await LocalDB.getProduct(second.id)).variants.find((v) => v.id === 'v-black');
  await check('through the real route on lowdb, a unit sold while the batch runs stays sold', () => {
    ok(sold, 'the sale did not happen during the batch — the test proves nothing');
    eq(res.status, 200);
    eq([black.stock, black.regular_price_cents], [2, 5500], 'the sold unit came back (oversell), or the price did not move');
  });
}

// ─────────────────────────────────────────────────── the routes

{
  const undoRoute = await read('src/pages/api/product-bulk/undo.ts');
  const csvRoute = await read('src/pages/api/product-bulk/csv.ts');
  const bulkRoute = await read('src/pages/api/product-bulk.ts');
  await check('undo refuses a batch already undone', () => {
    ok(/if \(record\.undone_at\) return ApiResponseBuilder\.error\(409/.test(undoRoute), 'a batch can be undone twice');
  });
  await check('a CSV with any row error is never applied', () => {
    ok(/if \(plan\.rowErrors\.length\) \{\s*return ApiResponseBuilder\.badRequest/.test(csvRoute), 'half a file can be applied');
  });
  await check('"all matching" resolves with the list\'s own filter, and is bounded', () => {
    ok(/productListMatches\(all, q\)/.test(bulkRoute), 'a second filter could disagree with the list');
    ok(/ids\.length > MAX_BULK/.test(bulkRoute), 'unbounded');
  });
  await check('every route is staff-only', () => {
    ok([undoRoute, csvRoute, bulkRoute].every((s) => /canManageCatalog\(session\.role\)/.test(s)), 'a route without the role check');
  });
}
{
  const hist = await read('src/pages/api/product-bulk/history.ts');
  const tpl = await read('src/pages/api/product-bulk/template.ts');
  await check('history and template are staff-only too', () => {
    ok([hist, tpl].every((s) => /canManageCatalog\(session\.role\)/.test(s)), 'readable by anyone');
  });
}

if (failures.length) {
  console.error(`\n✗ bulk-edit-undo: ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error(`  · ${f}`);
  process.exit(1);
}
console.log(`✓ bulk-edit-undo: ${passed} passed`);
process.exit(0);
