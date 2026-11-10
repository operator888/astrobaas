#!/usr/bin/env node
/**
 * `host.catalog` and `host.money` — the product reads a compiled plugin gets.
 *
 * ## What must hold
 *
 *   - the contract: `catalog.listProducts`, `catalog.iterateProducts`,
 *     `catalog.listBrands` and `money.currencyExponent`, handed to a factory by
 *     the REAL loader (`loadExternalPlugins`), not a hand-built host;
 *   - every product in every status: drafts, archived and hidden included;
 *   - copies, never the cached rows: mutate every nested part of a result,
 *     re-read, and nothing has moved — in storage or in the next read;
 *   - `stock_status` derived, on the product and on each variant;
 *   - the PUBLIC custom-field projection: a `public` field stays, a `staff`
 *     one and an undeclared one go — and storage keeps all three;
 *   - iteration yields the same products, in the same order, in bounded batches;
 *   - all of it on lowdb, libSQL and relational.
 *
 * Run with:  node tests/plugin-host-catalog.test.mjs
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
if (process.env.HOST_CATALOG_CHILD) {
  const entry = path.join(ROOT, 'node_modules', '.cache', `host-catalog-entry-${process.pid}.ts`);
  await fs.mkdir(path.dirname(entry), { recursive: true });
  const abs = (rel) => JSON.stringify(path.join(ROOT, rel));
  await fs.writeFile(entry, [
    `export { LocalDB } from ${abs('src/lib/localdb.ts')};`,
    `export { saveProduct } from ${abs('src/lib/commerce-service.ts')};`,
    `export { loadExternalPlugins } from ${abs('src/plugins/external.ts')};`,
    `export { GET as listGET } from ${abs('src/pages/api/products/index.ts')};`,
    `export { GET as brandsGET } from ${abs('src/pages/api/brands/index.ts')};`,
  ].join('\n'));
  let M;
  try {
    M = await loadTs(path.relative(ROOT, entry), 'hostcatalog');
  } finally {
    await fs.rm(entry, { force: true });
  }
  const { LocalDB } = M;
  await LocalDB.init();

  // A factory plugin that keeps the host it was handed.
  const probe = path.join(process.env.HOST_CATALOG_DIR, 'probe-plugin.mjs');
  await fs.writeFile(probe, [
    'export default (host) => {',
    '  globalThis.__catalogHost = host;',
    "  return host.definePlugin({ id: 'catalog-probe', name: 'Catalog probe', version: '1.0.0' });",
    '};',
  ].join('\n'));
  const loaded = await M.loadExternalPlugins({ ASTROBAAS_PLUGINS: probe });
  const host = globalThis.__catalogHost;

  const out = { failed: loaded.failed, loadedIds: loaded.plugins.map((p) => p.id) };
  out.shape = {
    listProducts: typeof host?.catalog?.listProducts,
    iterateProducts: typeof host?.catalog?.iterateProducts,
    listBrands: typeof host?.catalog?.listBrands,
    currencyExponent: typeof host?.money?.currencyExponent,
  };
  out.exponents = ['EUR', 'JPY', 'KWD', 'jpy'].map((c) => host.money.currencyExponent(c));

  // Merchant field definitions: one public, one staff-only.
  await LocalDB.updateSetting('product_fields', [
    { name: 'mpn', rule: { type: 'string', max: 70 }, visibility: 'public' },
    { name: 'cost_note', rule: { type: 'string', max: 200 }, visibility: 'staff' },
  ]);

  // Through the REAL writer, so the rows are what the shop actually stores.
  const make = async (input) => {
    const r = await M.saveProduct({ status: 'active', price_cents: 1000, categories: [], ...input });
    if (!r.ok) throw new Error(`saveProduct failed: ${r.message} ${JSON.stringify(r.errors ?? {})}`);
    return r.value;
  };
  const plain = await make({
    name: 'Plain', slug: 'plain', stock: 3, brand: 'Ray-Ban',
    custom: { mpn: 'MPN-1', cost_note: 'buy at 4.10' },
    attributes: [{ name: 'Colour', values: ['Red'], visible: true }],
    images: [{ src: '/uploads/plain.jpg', alt: 'Plain' }, { src: '/uploads/plain.mp4' }],
    tags: ['one'],
  });
  // An undeclared key can only reach storage past the validator — an import,
  // an old definition since deleted. Storage keeps it; the projection must not.
  await LocalDB.updateProduct(plain.id, { custom: { mpn: 'MPN-1', cost_note: 'buy at 4.10', legacy_key: 'old' } });
  const draft = await make({ name: 'Draft', slug: 'draft', stock: 5, status: 'draft', brand: 'Draft Only Maker' });
  const archived = await make({ name: 'Archived', slug: 'archived', stock: 5, status: 'archived' });
  const hidden = await make({ name: 'Hidden', slug: 'hidden', stock: 50, catalog_visibility: 'hidden', brand: 'RAYBAN' });
  const shirt = await make({
    // The brand as the WooCommerce importer stored it: a lossy slug, with the
    // brand record carrying the real name (see lib/commerce/brand.ts).
    name: 'Shirt', slug: 'shirt', stock: null, brand: 'rgreen',
    attributes: [{ name: 'Size', values: ['S', 'M'], visible: true }],
    variants: [{ options: { Size: 'S' }, stock: 0 }, { options: { Size: 'M' }, stock: 0 }],
  });
  await LocalDB.createBrand({ name: 'Ørgreen', slug: 'rgreen', logo: '/uploads/o.png' });

  const before = JSON.stringify(await LocalDB.getProduct(plain.id));
  const list = await host.catalog.listProducts();
  const byId = Object.fromEntries(list.map((p) => [p.id, p]));
  out.ids = list.map((p) => p.id);
  out.expectIds = [plain.id, draft.id, archived.id, hidden.id, shirt.id];
  out.statuses = Object.fromEntries(list.map((p) => [p.slug, [p.status, p.catalog_visibility ?? 'visible']]));
  out.stock = {
    plain: byId[plain.id].stock_status?.status,
    hidden: byId[hidden.id].stock_status?.status,
    shirt: byId[shirt.id].stock_status?.status,
    shirtPurchasable: byId[shirt.id].stock_status?.purchasable,
    shirtVariants: byId[shirt.id].variants?.map((v) => v.stock_status?.status),
  };
  // Snapshots: the objects themselves are mutated below.
  out.custom = structuredClone(byId[plain.id].custom ?? null);
  out.media = byId[plain.id].images.map((i) => i.kind);
  out.photos = byId[plain.id].photos?.length;
  out.reference = 'reference_price_cents' in byId[plain.id];

  // The anonymous API's custom bag, for the same product: the two must agree.
  {
    const url = new URL('http://cms.test/api/products?limit=50');
    const res = await M.listGET({ url, params: {}, locals: { user: null, ip: '10.0.0.1' }, request: new Request(url) });
    const body = await res.json();
    out.apiCustom = (body.data ?? []).find((p) => p.id === plain.id)?.custom ?? null;
  }

  // Mutate every nested part of the result the plugin was handed.
  const p = byId[plain.id];
  p.name = 'HACKED';
  p.custom.mpn = 'HACKED';
  p.attributes[0].values.push('HACKED');
  p.attributes.push({ name: 'X', values: [], visible: true });
  p.images[0].src = '/HACKED.jpg';
  p.photos[0].alt = 'HACKED';
  p.tags.push('HACKED');
  p.categories.push('HACKED');
  const s = byId[shirt.id];
  s.variants[0].options.Size = 'HACKED';
  s.variants[0].stock = 999;
  s.variants.pop();
  list.length = 0;

  const afterRaw = await LocalDB.getProduct(plain.id);
  out.storageUnchanged = JSON.stringify(afterRaw) === before;
  out.storageKeepsStaffField = afterRaw?.custom?.cost_note === 'buy at 4.10' && afterRaw?.custom?.legacy_key === 'old';
  const shirtRaw = await LocalDB.getProduct(shirt.id);
  out.shirtStorageUnchanged = shirtRaw.variants.length === 2
    && shirtRaw.variants[0].options.Size === 'S' && shirtRaw.variants[0].stock === 0;
  const again = await host.catalog.listProducts();
  const p2 = again.find((x) => x.id === plain.id);
  out.rereadUnchanged = again.length === 5 && p2.name === 'Plain' && p2.custom?.mpn === 'MPN-1'
    && p2.attributes.length === 1 && p2.attributes[0].values.join() === 'Red'
    && p2.images[0].src === '/uploads/plain.jpg' && !p2.tags.includes('HACKED')
    && !p2.categories.includes('HACKED');
  const s2 = again.find((x) => x.id === shirt.id);
  out.rereadShirtUnchanged = s2.variants.length === 2 && s2.variants[0].options.Size === 'S' && s2.variants[0].stock === 0;
  // Two reads never hand out the same object.
  const third = await host.catalog.listProducts();
  out.distinctReads = third.find((x) => x.id === plain.id) !== p2;

  // Iteration.
  const batches = [];
  for await (const batch of host.catalog.iterateProducts({ batchSize: 2 })) batches.push(batch.map((x) => x.id));
  out.batches = batches;
  const defaults = [];
  for await (const batch of host.catalog.iterateProducts()) defaults.push(batch.length);
  out.defaultBatches = defaults;
  // A batch is a copy too.
  for await (const batch of host.catalog.iterateProducts({ batchSize: 1 })) { batch[0].name = 'HACKED'; break; }
  out.iterCopy = (await LocalDB.getProduct(out.expectIds[0])).name === 'Plain';

  // Brands: the directory GET /api/brands lists, and a copy.
  const brands = await host.catalog.listBrands();
  out.brands = structuredClone(brands);
  {
    const url = new URL('http://cms.test/api/brands');
    const res = await M.brandsGET({ url, params: {}, locals: { user: null, ip: '10.0.0.1' }, request: new Request(url) });
    const body = await res.json();
    out.apiBrands = (body.data ?? []).map((b) => ({ slug: b.slug, name: b.name }));
  }
  for (const b of brands) { b.name = 'HACKED'; b.spellings.push('HACKED'); }
  out.brandUnchanged = (await LocalDB.getBrands())[0].name === 'Ørgreen'
    && (await host.catalog.listBrands()).every((b) => b.name !== 'HACKED' && !b.spellings.includes('HACKED'));

  console.log(`__RESULT__${JSON.stringify(out)}`);
  process.exit(0);
}

/* ------------------------------------------------------- pure helpers ----- */
const C = await loadTs('src/lib/plugin-platform/catalog.ts');

check('batch size defaults to 500', C.catalogBatchSize(undefined) === 500 && C.catalogBatchSize('x') === 500);
check('batch size below 1 falls back to the default', C.catalogBatchSize(0) === 500 && C.catalogBatchSize(-3) === 500);
check('batch size is capped at 5,000', C.catalogBatchSize(1e9) === 5000);
check('batch size is an integer', C.catalogBatchSize(7.9) === 7);

{
  const source = {
    id: 'p1', name: 'P', slug: 'p', price_cents: 1000, stock: 2, status: 'draft',
    custom: { mpn: 'A', cost: 3, stray: 1 },
    variants: [{ id: 'v1', options: { Size: 'S' }, stock: 0 }],
    images: [{ src: '/a.jpg' }],
    dimensions: { length_mm: 1, width_mm: 2, height_mm: 3 },
  };
  const snapshot = JSON.stringify(source);
  const ctx = {
    threshold: 5,
    fields: [
      { name: 'mpn', rule: { type: 'string' }, visibility: 'public' },
      { name: 'cost', rule: { type: 'number' } },
    ],
    mediaIndex: undefined,
    now: Date.now(),
  };
  const out = C.projectCatalogProduct(source, ctx);
  // A product with variants is judged on its variants (one sold out here).
  check('pure: stock_status is derived from the variants', out.stock_status?.status === 'out-of-stock');
  const simple = C.projectCatalogProduct({ id: 'p2', name: 'S', slug: 's', price_cents: 1, stock: 2 }, ctx);
  check('pure: a simple product with 2 under 5 is low', simple.stock_status?.status === 'low-stock');
  check('pure: each variant carries its own status', out.variants[0].stock_status?.status === 'out-of-stock');
  check('pure: only the public custom field survives', JSON.stringify(out.custom) === '{"mpn":"A"}');
  check('pure: status is not filtered — a draft is projected, not dropped', out.status === 'draft');
  out.dimensions.length_mm = 99;
  out.variants[0].options.Size = 'X';
  check('pure: the result shares nothing with the source', JSON.stringify(source) === snapshot);
}

/* ------------------------------------------- the host, per storage driver -- */
const here = path.dirname(fileURLToPath(import.meta.url));
const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'astrobaas-host-catalog-'));
const DRIVERS = [
  { name: 'lowdb', env: (d) => ({ DB_PATH: path.join(d, 'db.json') }) },
  { name: 'libsql', env: (d) => ({ DATABASE_URL: `file:${path.join(d, 'db.sqlite')}` }) },
  { name: 'relational', env: (d) => ({ DATABASE_URL: `file:${path.join(d, 'db.sqlite')}`, DATABASE_DRIVER: 'relational' }) },
];

for (const driver of DRIVERS) {
  const dir = path.join(tmpRoot, driver.name);
  await fs.mkdir(path.join(dir, 'uploads'), { recursive: true });
  const run = spawnSync(process.execPath, [path.join(here, 'plugin-host-catalog.test.mjs')], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 180_000,
    env: {
      ...process.env, HOST_CATALOG_CHILD: '1', HOST_CATALOG_DIR: dir, NODE_ENV: 'test',
      SITE_URL: 'https://shop.example.com', AUTH_SECRET: 'test-secret-'.padEnd(40, 'x'),
      UPLOADS_DIR: path.join(dir, 'uploads'), ASTROBAAS_PLUGINS: '', ...driver.env(dir),
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

  t('the real loader hands the factory a host and loads the plugin',
    o.failed.length === 0 && o.loadedIds.join() === 'catalog-probe');
  t('contract: catalog.listProducts / iterateProducts / listBrands and money.currencyExponent are functions',
    o.shape.listProducts === 'function' && o.shape.iterateProducts === 'function'
    && o.shape.listBrands === 'function' && o.shape.currencyExponent === 'function');
  t('money.currencyExponent is the core table (EUR 2, JPY 0, KWD 3, lower-case jpy 0)',
    o.exponents.join() === '2,0,3,0');
  t('every product, every status, in storage order',
    JSON.stringify(o.ids) === JSON.stringify(o.expectIds));
  t('drafts, archived and hidden products are included',
    o.statuses.draft?.[0] === 'draft' && o.statuses.archived?.[0] === 'archived'
    && o.statuses.hidden?.[1] === 'hidden');
  t('stock_status is applied: 3 units under the default 5 is low', o.stock.plain === 'low-stock');
  t('...50 units is in stock', o.stock.hidden === 'in-stock');
  t('...a shirt with every size sold out is out of stock and not purchasable',
    o.stock.shirt === 'out-of-stock' && o.stock.shirtPurchasable === false);
  t('...and each variant carries its own status', o.stock.shirtVariants?.join() === 'out-of-stock,out-of-stock');
  t('projection: the public field stays, the staff-only and undeclared ones go',
    JSON.stringify(o.custom) === '{"mpn":"MPN-1"}');
  t('projection: identical to what an anonymous GET /api/products returns',
    JSON.stringify(o.custom) === JSON.stringify(o.apiCustom));
  t('projection: storage still holds the staff-only and undeclared values', o.storageKeepsStaffField);
  t('media kind is derived on read (photo, video) with photos split out',
    o.media.join() === 'image,video' && o.photos === 1);
  t('the Omnibus reference price is present', o.reference === true);
  t('copies: mutating every nested part of a result leaves storage unchanged', o.storageUnchanged);
  t('copies: ...including a variant\'s options and stock, and the variants array', o.shirtStorageUnchanged);
  t('copies: ...and the next read is unchanged', o.rereadUnchanged && o.rereadShirtUnchanged);
  t('copies: two reads never hand out the same object', o.distinctReads);
  t('iteration: batches of 2 cover every product once, in order',
    JSON.stringify(o.batches) === JSON.stringify([o.expectIds.slice(0, 2), o.expectIds.slice(2, 4), o.expectIds.slice(4)]));
  t('iteration: the default batch holds a small catalogue in one batch', o.defaultBatches.join() === '5');
  t('iteration: a batch is a copy too', o.iterCopy);
  const pair = (b) => `${b.slug}|${b.name}`;
  t('brands: the same makers, slugs and names GET /api/brands lists',
    o.brands.map(pair).sort().join() === o.apiBrands.map(pair).sort().join() && o.brands.length === 2);
  t('brands: two typings of one maker are one entry carrying both exact spellings', (() => {
    const rb = o.brands.find((b) => b.spellings.includes('Ray-Ban'));
    return !!rb && rb.spellings.includes('RAYBAN') && rb.spellings.length === 2;
  })());
  t('brands: the importer\'s lossy slug maps to the record\'s real name', (() => {
    const og = o.brands.find((b) => b.spellings.includes('rgreen'));
    return og?.name === 'Ørgreen' && og.slug === 'rgreen';
  })());
  t('brands: a maker with only draft products is not listed',
    !o.brands.some((b) => b.spellings.includes('Draft Only Maker')));
  t('brands: exactly slug, name, key, spellings',
    o.brands.every((b) => Object.keys(b).sort().join() === 'key,name,slug,spellings'));
  t('brands: a copy', o.brandUnchanged);
}

await fs.rm(tmpRoot, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
