#!/usr/bin/env node
/**
 * Stock status: the "In stock / Low stock / Out of stock" answer (core item
 * stock-status-badge).
 *
 * One pure helper (`src/lib/commerce/stock-status.ts`) decides it, the product
 * routes embed it, `GET /api/products/{ref}/stock-status` serves it, and the
 * storefront starter only chooses words for it.
 *
 * ## What must hold
 *
 *   - 0 or less is out of stock WHATEVER the threshold says (a threshold of 5
 *     must not make a count of 0 read "low");
 *   - `0 < count <= threshold` is low; above it is in stock; a threshold of 0
 *     means never low; no count at all is always in stock;
 *   - a product's own threshold beats the shop's, and an empty one inherits it;
 *   - a backorder policy keeps the product purchasable while it reads out of stock;
 *   - a product with variants is judged on its ENABLED variants — the product's
 *     own count is not consulted. This is the bug that motivated deriving on
 *     read: a shirt whose every size was sold out still said `in_stock: true`;
 *   - it is derived from the count as it is NOW, not from the stored flag;
 *   - the routes agree with each other and with the helper, on all three drivers.
 *
 * Run with:  node tests/stock-status.test.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTs, ROOT } from './lib/load.mjs';

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) pass += 1;
  else { fail += 1; console.error(`✗ ${name}`); }
}

/* ---------------------------------------------------------------- child --- */
if (process.env.STOCK_STATUS_CHILD) {
  const entry = path.join(ROOT, 'node_modules', '.cache', `stock-status-entry-${process.pid}.ts`);
  await fs.mkdir(path.dirname(entry), { recursive: true });
  const abs = (rel) => JSON.stringify(path.join(ROOT, rel));
  await fs.writeFile(entry, [
    `export { LocalDB } from ${abs('src/lib/localdb.ts')};`,
    `export { saveProduct } from ${abs('src/lib/commerce-service.ts')};`,
    `export { GET as productGET } from ${abs('src/pages/api/products/[id].ts')};`,
    `export { GET as listGET } from ${abs('src/pages/api/products/index.ts')};`,
    `export { POST as notifyPOST } from ${abs('src/pages/api/products/[id]/notify-me.ts')};`,
    `export { WAITLIST_TYPE } from ${abs('src/lib/commerce/stock-waitlist.ts')};`,
    `export { GET as statusGET } from ${abs('src/pages/api/products/[id]/stock-status.ts')};`,
  ].join('\n'));
  let M;
  try {
    M = await loadTs(path.relative(ROOT, entry), 'stockstatus');
  } finally {
    await fs.rm(entry, { force: true });
  }
  const { LocalDB } = M;
  await LocalDB.init();

  const get = async (handler, pathname, params = {}) => {
    const url = new URL(`http://cms.test${pathname}`);
    const res = await handler({
      url, params, locals: { user: null, ip: '10.0.0.1' },
      request: new Request(url, { method: 'GET' }),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  // Through the REAL writer, not a literal row: saveProduct normalises variants
  // and derives the stored flags, which is exactly what the routes then read.
  const make = async (input) => {
    const r = await M.saveProduct({ status: 'active', price_cents: 1000, categories: [], ...input });
    if (!r.ok) throw new Error(`saveProduct failed: ${r.message}`);
    return r.value;
  };

  const out = {};
  const simple = await make({ name: 'Plain', slug: 'plain', stock: 3 });
  const gone = await make({ name: 'Gone', slug: 'gone', stock: 0 });
  const untracked = await make({ name: 'Untracked', slug: 'untracked', stock: null });
  const own = await make({ name: 'Own', slug: 'own', stock: 10, low_stock_threshold: 20 });
  const back = await make({ name: 'Back', slug: 'back', stock: 0, backorders: 'yes' });
  const draft = await make({ name: 'Draft', slug: 'draft-one', stock: 3, status: 'draft' });
  // The headline bug: product-level stock null (so stored in_stock is true),
  // every variant sold out.
  const shirt = await make({
    name: 'Shirt', slug: 'shirt', stock: null,
    attributes: [{ name: 'Size', values: ['S', 'M', 'L'], visible: true }],
    variants: [
      { options: { Size: 'S' }, stock: 0 },
      { options: { Size: 'M' }, stock: 0 },
      { options: { Size: 'L' }, stock: 0, enabled: false },
    ],
  });
  const mixed = await make({
    name: 'Mixed', slug: 'mixed', stock: null,
    variants: [
      { options: { Size: 'S' }, stock: 4 },
      { options: { Size: 'M' }, stock: 0 },
    ],
  });

  const status = async (p) => (await get(M.statusGET, `/api/products/${p.slug}/stock-status`, { id: p.slug }));
  const single = async (p) => (await get(M.productGET, `/api/products/${p.slug}`, { id: p.slug }));

  out.shirtStoredFlag = shirt.in_stock; // what the OLD field claimed
  out.shirtStatus = (await status(shirt)).body?.data;
  out.shirtProduct = (await single(shirt)).body?.data;
  out.mixedStatus = (await status(mixed)).body?.data;
  out.mixedProduct = (await single(mixed)).body?.data;
  out.plain = (await status(simple)).body?.data;
  out.plainById = (await get(M.statusGET, `/api/products/${simple.id}/stock-status`, { id: simple.id })).body?.data;
  out.gone = (await status(gone)).body?.data;
  out.untracked = (await status(untracked)).body?.data;
  out.back = (await status(back)).body?.data;
  out.own = (await status(own)).body?.data;
  out.draft = await status(draft);
  out.ghost = await status({ slug: 'no-such-product' });

  // The list route embeds the same answer.
  const list = await get(M.listGET, '/api/products?limit=50');
  out.listStatuses = Object.fromEntries((list.body?.data ?? []).map((p) => [p.slug, p.stock_status?.status]));
  out.listShirtVariants = (list.body?.data ?? []).find((p) => p.slug === 'shirt')?.variants?.map((v) => v.stock_status?.status);

  // The shop-wide threshold is read from settings, on this driver.
  await LocalDB.updateSetting('inventory_low_stock_threshold_qty', 2);
  out.plainAt2 = (await status(simple)).body?.data;       // 3 > 2
  await LocalDB.updateSetting('inventory_low_stock_threshold_qty', 3);
  out.plainAt3 = (await status(simple)).body?.data;       // 3 <= 3
  out.ownAt3 = (await status(own)).body?.data;            // own 20 still wins
  await LocalDB.updateSetting('inventory_low_stock_threshold_qty', 0);
  out.plainAt0 = (await status(simple)).body?.data;       // never low
  out.goneAt0 = (await status(gone)).body?.data;

  // Derived on READ: edit the count with the stored flag left alone.
  await LocalDB.updateSetting('inventory_low_stock_threshold_qty', 5);
  await LocalDB.updateProduct(simple.id, { stock: 0, in_stock: true });
  out.staleFlag = (await status(simple)).body?.data;

  // A write-back of a read product never stores the derived field.
  const loaded = out.shirtProduct;
  const back2 = await M.saveProduct({ name: 'Shirt', stock_status: { status: 'in-stock' }, variants: loaded.variants }, shirt.id);
  const stored = await LocalDB.getProduct(shirt.id);
  out.storedKeys = {
    product: 'stock_status' in stored,
    variant: (stored.variants ?? []).some((v) => 'stock_status' in v),
    ok: back2.ok,
  };

  // Notify-me for the sold-out shirt (stored in_stock is true): the signup must
  // be STORED, not answered "we will let you know" and dropped.
  {
    const rows = async () => (await LocalDB.getCustomEntities(M.WAITLIST_TYPE))
      .filter((r) => r.data?.product_id === shirt.id).length;
    const url = new URL(`http://cms.test/api/products/${shirt.id}/notify-me`);
    const res = await M.notifyPOST({
      url, params: { id: shirt.id }, locals: { user: null, ip: '10.2.0.1' },
      request: new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'waiting@example.com' }) }),
    });
    out.notify = { status: res.status, stored: await rows() };
  }

  console.log(`__RESULT__${JSON.stringify(out)}`);
  process.exit(0);
}

/* ------------------------------------------------------- pure helper ------ */
const S = await loadTs('src/lib/commerce/stock-status.ts');
const D = 5;
const st = (stock, extra = {}, threshold = D) => S.productStockStatus({ stock, ...extra }, threshold);

// The threshold setting.
check('default threshold is 5', S.LOW_STOCK_THRESHOLD_DEFAULT === 5 && S.resolveLowStockThreshold({}) === 5);
check('the setting is read', S.resolveLowStockThreshold({ inventory_low_stock_threshold_qty: 12 }) === 12);
check('a numeric string is read (settings forms store strings)', S.resolveLowStockThreshold({ inventory_low_stock_threshold_qty: '7' }) === 7);
check('0 is a decision and is kept', S.resolveLowStockThreshold({ inventory_low_stock_threshold_qty: 0 }) === 0);
check('empty, junk and negative fall back to the default',
  [null, '', 'lots', -3, NaN, {}, []].every((v) => S.resolveLowStockThreshold({ inventory_low_stock_threshold_qty: v }) === 5));
check('absurdly large is clamped', S.resolveLowStockThreshold({ inventory_low_stock_threshold_qty: 1e12 }) === S.LOW_STOCK_THRESHOLD_MAX);
check('the settings key is the documented one', S.LOW_STOCK_THRESHOLD_KEY === 'inventory_low_stock_threshold_qty');

// Boundaries.
check('0 is out of stock', st(0).status === 'out-of-stock');
check('0 is OUT, not low, although 0 <= the threshold', st(0, {}, 100).status === 'out-of-stock');
check('1 is low', st(1).status === 'low-stock');
check('exactly the threshold is low', st(5).status === 'low-stock');
check('one above the threshold is in stock', st(6).status === 'in-stock');
check('threshold 0 means never low', st(1, {}, 0).status === 'in-stock' && st(0, {}, 0).status === 'out-of-stock');
check('untracked is in stock with no quantity', (() => {
  const s = st(null);
  return s.status === 'in-stock' && s.tracked === false && s.available_qty === null && s.purchasable === true;
})());
check('a missing count is untracked', st(undefined).status === 'in-stock' && st(undefined).available_qty === null);
check('a negative count (backordered) is out, and reports 0 units', (() => {
  const s = st(-4, { backorders: 'yes' });
  return s.status === 'out-of-stock' && s.available_qty === 0;
})());

// Per-product override.
check('the product\'s own threshold beats the shop\'s',
  st(10, { low_stock_threshold: 20 }).status === 'low-stock' && st(10, { low_stock_threshold: 20 }).threshold_qty === 20);
check('an empty product threshold inherits the shop\'s',
  st(4, { low_stock_threshold: null }).status === 'low-stock' && st(4, { low_stock_threshold: null }).threshold_qty === 5);
check('a product threshold of 0 overrides a shop threshold of 5 to "never low"',
  st(2, { low_stock_threshold: 0 }).status === 'in-stock');
check('a LOWER product threshold wins too', st(4, { low_stock_threshold: 2 }).status === 'in-stock');

// Backorders and purchasable.
check('out of stock with no backorders: not purchasable, not backorderable', (() => {
  const s = st(0, { backorders: 'no' });
  return s.status === 'out-of-stock' && !s.purchasable && !s.backorderable;
})());
check('out of stock with backorders allowed: out, but purchasable', (() => {
  const s = st(0, { backorders: 'yes' });
  return s.status === 'out-of-stock' && s.purchasable && s.backorderable;
})());
check('"notify" backorders count as allowed (same as checkout)', st(0, { backorders: 'notify' }).purchasable === true);
check('an unrecognised policy means no', st(0, { backorders: 'banana' }).purchasable === false);
check('purchasable agrees with availableFor for every case', await (async () => {
  const PF = await loadTs('src/lib/product-fields.ts');
  for (const stock of [null, -1, 0, 1, 9]) {
    for (const backorders of ['no', 'notify', 'yes', undefined]) {
      const a = PF.availableFor({ stock, backorders }, 1).ok;
      if (S.productStockStatus({ stock, backorders }, 5).purchasable !== a) return false;
    }
  }
  return true;
})());

// Variants.
const variants = (...stocks) => stocks.map((s, i) => ({
  id: `v${i}`, options: { Size: String(i) }, stock: s, in_stock: s === null || s > 0, enabled: true,
}));
check('THE BUG: every variant sold out reads out of stock although the product count is null',
  st(null, { variants: variants(0, 0) }).status === 'out-of-stock');
check('...and although the product count is large',
  st(100, { variants: variants(0, 0) }).status === 'out-of-stock');
check('one variant with stock makes the product buyable', st(null, { variants: variants(0, 4) }).purchasable === true);
check('variant counts are summed, then judged', (() => {
  const s = st(null, { variants: variants(2, 2, 2) }, 5);
  return s.available_qty === 6 && s.status === 'in-stock';
})());
check('...so the same three variants are low under a higher threshold',
  st(null, { variants: variants(2, 2, 2) }, 6).status === 'low-stock');
check('a disabled variant is not counted', (() => {
  const v = variants(0, 50); v[1].enabled = false;
  return st(null, { variants: v }).status === 'out-of-stock';
})());
check('one untracked variant makes the product untracked and in stock', (() => {
  const s = st(null, { variants: variants(0, null) });
  return s.status === 'in-stock' && s.available_qty === null && s.purchasable === true;
})());
check('a variable product with every variant disabled cannot be bought', (() => {
  const v = variants(5); v[0].enabled = false;
  const s = st(5, { variants: v });
  return s.status === 'out-of-stock' && s.purchasable === false;
})());
check('the product threshold applies to every variant', (() => {
  const w = S.withStockStatus({ stock: null, low_stock_threshold: 10, variants: variants(8, 12) }, 5);
  return w.variants[0].stock_status.status === 'low-stock' && w.variants[1].stock_status.status === 'in-stock'
    && w.variants.every((v) => v.stock_status.threshold_qty === 10);
})());
check('variants of a backorderable product are purchasable at 0', (() => {
  const w = S.withStockStatus({ stock: null, backorders: 'yes', variants: variants(0) }, 5);
  return w.variants[0].stock_status.purchasable && w.stock_status.purchasable;
})());

check('backorderable is false for a variable product with no enabled variant', (() => {
  const v = variants(5); v[0].enabled = false;
  const s = st(5, { backorders: 'yes', variants: v });
  return s.backorderable === false && s.purchasable === false;
})());
check('backorderable is false while units are on hand', st(3, { backorders: 'yes' }).backorderable === false);

// withStockStatus.
check('withStockStatus does not mutate its input', (() => {
  const input = { stock: 1, variants: variants(1) };
  const snap = JSON.stringify(input);
  S.withStockStatus(input, 5);
  return JSON.stringify(input) === snap;
})());
check('a product without variants gains no variants key', !('variants' in S.withStockStatus({ stock: 1 }, 5)));
check('it trusts the count, not the stored flag', (() => {
  const w = S.withStockStatus({ stock: 0, in_stock: true }, 5);
  return w.stock_status.status === 'out-of-stock';
})());
check('the status is one of exactly three values', (() => {
  const seen = new Set();
  for (const stock of [null, -1, 0, 1, 5, 6]) seen.add(st(stock).status);
  return [...seen].sort().join() === 'in-stock,low-stock,out-of-stock';
})());
check('available_qty is the stock the product already publishes, floored at 0',
  st(7).available_qty === 7 && st(-2).available_qty === 0);

// The response body.
check('the response lists enabled variants only, with their own status', (() => {
  const v = variants(0, 3); v.push({ ...variants(9)[0], id: 'vx', options: { Size: 'x' }, enabled: false });
  const r = S.stockStatusResponse({ id: 'p1', stock: null, variants: v }, 5);
  return r.product_id === 'p1' && r.variants.length === 2
    && r.variants[0].status === 'out-of-stock' && r.variants[1].status === 'low-stock';
})());
check('a simple product has no variants key', !('variants' in S.stockStatusResponse({ id: 'p', stock: 1 }, 5)));

/* ------------------------------------------- routes, per storage driver --- */
const here = path.dirname(fileURLToPath(import.meta.url));
const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'astrobaas-stock-status-'));
const DRIVERS = [
  { name: 'lowdb', env: (d) => ({ DB_PATH: path.join(d, 'db.json') }) },
  { name: 'libsql', env: (d) => ({ DATABASE_URL: `file:${path.join(d, 'db.sqlite')}` }) },
  { name: 'relational', env: (d) => ({ DATABASE_URL: `file:${path.join(d, 'db.sqlite')}`, DATABASE_DRIVER: 'relational' }) },
];

for (const driver of DRIVERS) {
  const dir = path.join(tmpRoot, driver.name);
  await fs.mkdir(path.join(dir, 'uploads'), { recursive: true });
  const run = spawnSync(process.execPath, [path.join(here, 'stock-status.test.mjs')], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 180_000,
    env: {
      ...process.env, STOCK_STATUS_CHILD: '1', NODE_ENV: 'test', SITE_URL: 'https://shop.example.com',
      AUTH_SECRET: 'test-secret-'.padEnd(40, 'x'), UPLOADS_DIR: path.join(dir, 'uploads'), ...driver.env(dir),
    },
  });
  const line = (run.stdout || '').split('\n').find((l) => l.startsWith('__RESULT__'));
  if (!line) {
    fail += 1;
    console.error(`✗ [${driver.name}] child produced no result\n${(run.stdout || '').slice(-800)}\n${(run.stderr || '').slice(-1500)}`);
    continue;
  }
  const o = JSON.parse(line.slice('__RESULT__'.length));
  const t = (n, c) => check(`[${driver.name}] ${n}`, c);

  t('THE BUG, as stored: the old flag says in stock for a shirt with every size sold out', o.shirtStoredFlag === true);
  t('...and the status route says out of stock', o.shirtStatus?.status === 'out-of-stock' && o.shirtStatus.purchasable === false);
  t('...and so does the product route, on the product and on each variant',
    o.shirtProduct?.stock_status?.status === 'out-of-stock'
    && o.shirtProduct.variants.every((v) => v.stock_status?.status === 'out-of-stock'));
  t('the list route embeds the same answer, variants included',
    o.listStatuses.shirt === 'out-of-stock' && o.listShirtVariants?.every((s) => s === 'out-of-stock'));
  t('a mixed product is buyable and judged on its enabled variants',
    o.mixedStatus?.status === 'low-stock' && o.mixedStatus.available_qty === 4 && o.mixedStatus.purchasable === true);
  t('...with each variant reported on its own',
    o.mixedStatus?.variants?.map((v) => v.status).join() === 'low-stock,out-of-stock'
    && o.mixedProduct?.variants?.map((v) => v.stock_status?.status).join() === 'low-stock,out-of-stock');
  t('stock 3 under the default threshold of 5 is low', o.plain?.status === 'low-stock' && o.plain.threshold_qty === 5);
  t('the same answer by id and by slug', JSON.stringify(o.plainById) === JSON.stringify(o.plain));
  t('stock 0 is out of stock', o.gone?.status === 'out-of-stock' && o.gone.available_qty === 0 && o.gone.purchasable === false);
  t('untracked is in stock', o.untracked?.status === 'in-stock' && o.untracked.available_qty === null);
  t('a backorderable product at 0 is out of stock but purchasable',
    o.back?.status === 'out-of-stock' && o.back.backorderable === true && o.back.purchasable === true);
  t('a product override (20) beats the default: 10 units is low', o.own?.status === 'low-stock' && o.own.threshold_qty === 20);
  t('the shop setting is read from the settings table (2: 3 units is in stock)',
    o.plainAt2?.status === 'in-stock' && o.plainAt2.threshold_qty === 2);
  t('...(3: 3 units is low)', o.plainAt3?.status === 'low-stock');
  t('...and the product override still wins over the setting', o.ownAt3?.threshold_qty === 20);
  t('a shop threshold of 0 shows no low state, and 0 units is still out',
    o.plainAt0?.status === 'in-stock' && o.goneAt0?.status === 'out-of-stock');
  t('derived on read: a stale stored flag does not override the count', o.staleFlag?.status === 'out-of-stock');
  t('notify-me for a sold-out variable product STORES the signup (it used to be dropped)',
    o.notify?.status === 200 && o.notify.stored === 1);
  t('a draft product is 404, like the product route', o.draft.status === 404);
  t('an unknown product is 404', o.ghost.status === 404);
  t('the derived fields are never stored, even when a client writes a read product back',
    o.storedKeys?.ok === true && o.storedKeys.product === false && o.storedKeys.variant === false);
}

await fs.rm(tmpRoot, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
