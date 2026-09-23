#!/usr/bin/env node
/**
 * Performing a WooCommerce import, against a real database, on every driver.
 *
 * The properties this pins down:
 *
 *   1. The commerce switch moves in ONE direction. Importing a shop turns it
 *      on; nothing here ever turns it off. Two live shops run on this code,
 *      and an import that silently closed their catalogue would be the worst
 *      possible outcome of a feature meant to help people migrate.
 *   2. An import that creates nothing does not turn the shop on. "Somebody ran
 *      an importer once" is not evidence that this install sells anything.
 *   3. Re-running does not duplicate products, customers or orders.
 *   4. References resolve: an order points at the customer and the products it
 *      actually names, and never at a dry-run placeholder.
 *   5. Product copy is sanitized on the way in.
 *   6. Brands arrive as the shop spells them, in any script, and the published
 *      listing lists each ONCE with a slug that returns its products — on a
 *      fresh shop, on a shop an EARLIER version of the importer filled (which
 *      stored a lossy slug on each product, and nothing at all for a Greek
 *      brand), and when that shop is imported again.
 *
 * Each driver runs in a child process with its own throwaway database — one
 * per scenario.
 *
 * Run with:  node tests/woo-apply.test.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTogether } from './lib/load.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

const DUMP = {
  brands: [{ name: 'Ray Ban' }],
  categories: [{ name: 'Frames & Lenses', slug: 'frames' }],
  products: [
    {
      wp_id: '1', name: 'Titanium frame', slug: 'titanium-frame',
      description: '<p>Light.<script>alert(1)</script></p>',
      price_cents: 19900, regular_price_cents: 24900, sale_price_cents: 19900,
      on_sale: 'yes', in_stock: 'yes', stock: 4, categories: ['Frames'], brand: 'Ray Ban',
      images: [{ rel: '2024/03/frame.jpg' }],
    },
    { wp_id: '2', name: 'Unpriceable', price_cents: 19.99 },
  ],
  customers: [
    { wp_id: '10', email: 'maria@example.com', name: 'Maria', city: 'Athens' },
    { wp_id: '11', email: 'owner@shop.gr', role: 'admin' },
  ],
  orders: [{
    wp_id: '500', status: 'wc-completed', currency: 'eur', total_cents: 19900,
    customer_wp_id: '10', email: 'maria@example.com', created_at: '2024-03-05 09:30:00',
    items: [{ product_wp_id: '1', name: 'Titanium frame', qty: 1, total_cents: 19900 }],
  }],
  blog: [
    { wp_id: '900', title: 'Shop news', slug: 'shop-news', content: '<p>Open.</p>', status: 'publish' },
    { wp_id: '901', title: 'Unfinished thoughts', slug: 'unfinished', content: '<p>secret</p>', status: 'draft' },
  ],
};

/* ------------------------------------------------------------------ *
 * Brands.                                                             *
 * ------------------------------------------------------------------ */

// What WordPress stores in wp_terms.slug for a non-Latin term name:
// `sanitize_title` → `utf8_uri_encode`, lowercase hex.
const wpSlug = (name) => encodeURIComponent(name.toLowerCase().replace(/\s+/g, '-')).toLowerCase();
const frame = (wpId, brand) => ({
  wp_id: wpId, name: `Frame ${wpId}`, slug: `frame-${wpId}`, price_cents: 1000, in_stock: 'yes', stock: 3, brand,
});

// A fresh shop that already sells a hand-made `Strasse`, importing makers
// whose names the old planner could not slugify, or slugified lossily.
const FRESH_DUMP = {
  brands: [
    { name: 'Όψη Οπτικά' }, { name: 'Straße' }, { name: 'Ørgreen' },
    { name: 'Γυαλιά Ηλίου', slug: wpSlug('Γυαλιά Ηλίου') }, { name: 'Ray Ban' },
  ],
  products: [
    frame('1', 'Όψη Οπτικά'), frame('2', 'Όψη Οπτικά'), frame('3', 'Straße'),
    frame('4', 'Ørgreen'), frame('5', 'Γυαλιά Ηλίου'), frame('6', 'Ray Ban'),
  ],
};

/*
 * A shop the PREVIOUS importer filled, exactly as it wrote it. Not invented:
 * these are the values planWooImport + applyWooImport at 325ae28 stored for
 * this dump on all three drivers (see the PR) — `slugifyImported` of each name
 * on the product, NO brand where that was '' (every Greek name), and a record
 * `{ name, slug }` for every name that had a slug, with WordPress's encoded
 * slug turned into hex. Then an operator's afterwards: Æsir's record deleted,
 * Persol cleared from its product, and a Greek product given a brand by hand.
 */
const LEGACY_PRODUCTS = [
  ['1', undefined], // Όψη Οπτικά — lost
  ['2', 'stra-e'], // Straße
  ['3', 'rgreen'], // Ørgreen
  ['4', undefined], // Γυαλιά Ηλίου — lost
  ['5', 'ray-ban'], // Ray Ban
  ['6', 'sir'], // Æsir, whose record the operator deleted
  ['7', undefined], // Persol, which the operator removed from this product
  ['8', 'Opsi'], // Όψη Οπτικά — lost, then set by hand
];
const LEGACY_RECORDS = [
  { name: 'Straße', slug: 'stra-e' },
  { name: 'Ørgreen', slug: 'rgreen' },
  { name: 'Γυαλιά Ηλίου', slug: 'ce-b3-cf-85-ce-b1-ce-bb-ce-b9-ce-ac-ce-b7-ce-bb-ce-af-ce-bf-cf-85' },
  { name: 'Ray Ban', slug: 'ray-ban' },
  { name: 'Persol', slug: 'persol' },
];
// The same shop's dump, re-imported with a few products added since.
const LEGACY_DUMP = {
  brands: [
    { name: 'Όψη Οπτικά' }, { name: 'Straße' }, { name: 'Ørgreen' },
    { name: 'Γυαλιά Ηλίου', slug: wpSlug('Γυαλιά Ηλίου') }, { name: 'Ray Ban' },
    { name: 'Æsir' }, { name: 'Persol' },
  ],
  products: [
    frame('1', 'Όψη Οπτικά'), frame('2', 'Straße'), frame('3', 'Ørgreen'), frame('4', 'Γυαλιά Ηλίου'),
    frame('5', 'Ray Ban'), frame('6', 'Æsir'), frame('7', 'Persol'), frame('8', 'Όψη Οπτικά'),
    // New since the first import.
    frame('9', 'Ørgreen'), frame('10', 'Straße'), frame('11', 'Æsir'), frame('12', 'Όψη Οπτικά'),
    frame('13', 'Ray Ban'),
  ],
};

// A shop where the old slug is not the whole story: an earlier import stored
// `odz-optyk` for Łódź Optyk (ł does not survive slugifyImported), and then
// somebody added a product under the real name — so the record is listed by
// that name. And a hand-made maker really called SIR, whose `sir` is exactly
// what the old importer would have made of Æsir, but which it never wrote.
const MIXED_DUMP = {
  brands: [{ name: 'Łódź Optyk' }, { name: 'Æsir' }],
  products: [frame('1', 'Łódź Optyk'), frame('2', 'Łódź Optyk'), frame('3', 'Æsir')],
};

if (['brands-fresh', 'brands-legacy', 'brands-mixed'].includes(process.env.WOO_TEST_CHILD)) {
  const { build } = await import('esbuild');
  const { pathToFileURL } = await import('node:url');
  const cacheDir = path.join(root, 'node_modules', '.cache');
  await fs.mkdir(cacheDir, { recursive: true });
  // ONE bundle, so the importer, the brands route and listProducts share one
  // LocalDB. ABSOLUTE specifiers: esbuild resolves through symlinks, and a
  // relative import from node_modules/.cache would reach whichever checkout a
  // symlinked node_modules points at.
  const entry = path.join(cacheDir, `astrobaas-woobrands-entry-${process.pid}.ts`);
  const out = path.join(cacheDir, `astrobaas-woobrands-${process.pid}.mjs`);
  const src = (rel) => JSON.stringify(path.join(root, rel));
  await fs.writeFile(entry, [
    `export { LocalDB } from ${src('src/lib/localdb.ts')};`,
    `export { listProducts } from ${src('src/lib/commerce-service.ts')};`,
    `export { GET as brandsGET } from ${src('src/pages/api/brands/index.ts')};`,
    `export { planWooImport } from ${src('src/lib/import/woo.ts')};`,
    `export { applyWooImport } from ${src('src/lib/import/woo-apply.ts')};`,
  ].join('\n'));
  let R;
  try {
    await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', packages: 'external', outfile: out, logLevel: 'silent' });
    R = await import(pathToFileURL(out).href);
  } finally {
    await fs.rm(entry, { force: true });
    await fs.rm(out, { force: true });
  }
  await R.LocalDB.init();

  /** The published listing, with what `?brand=<slug>` returns for each entry. */
  const listing = async () => {
    const u = new URL('http://t/api/brands');
    const res = await R.brandsGET({ url: u, request: new Request(u), locals: {} });
    const data = (await res.json().catch(() => null))?.data ?? [];
    const rows = [];
    for (const b of data) {
      rows.push({
        name: b.name, slug: b.slug, key: b.key, count: b.count, curated: b.curated,
        filtered: (await R.listProducts({ brand: b.slug, limit: 1 }))?.meta?.total,
      });
    }
    return rows;
  };
  const total = async (brand) => (await R.listProducts({ brand, limit: 1 }))?.meta?.total;
  const brandsByWpId = async () =>
    Object.fromEntries((await R.LocalDB.getProducts()).filter((p) => p.wp_id).map((p) => [p.wp_id, p.brand ?? null]));
  const records = async () => (await R.LocalDB.getBrands()).map((b) => [b.name, b.slug]);
  const summary = (res) => ({
    createdBrands: res.createdBrands, createdProducts: res.createdProducts,
    restoredBrands: res.restoredBrands, failed: res.failed,
    brandSkips: res.skipped.filter((s) => !/^Frame /.test(s.label)),
  });

  if (process.env.WOO_TEST_CHILD === 'brands-fresh') {
    await R.LocalDB.createProduct({ name: 'Hand-made', slug: 'hand-made', status: 'active', brand: 'Strasse', price_cents: 1000, stock: 3 });
    const first = await R.applyWooImport(R.planWooImport(FRESH_DUMP), 'u1', { dryRun: false, includePosts: false });
    const afterFirst = { brands: await brandsByWpId(), records: await records(), listing: await listing(), strasse: await total('strasse') };
    const again = await R.applyWooImport(R.planWooImport(FRESH_DUMP), 'u1', { dryRun: false, includePosts: false });
    console.log(JSON.stringify({
      first: summary(first), again: summary(again), ...afterFirst,
      recordsAfterAgain: (await records()).length,
    }));
    process.exit(0);
  }

  if (process.env.WOO_TEST_CHILD === 'brands-mixed') {
    const product = (slug, brand, wpId) => R.LocalDB.createProduct({
      name: slug, slug, price_cents: 1000, sale_price_cents: null, on_sale: false, stock: 3, in_stock: true,
      categories: [], images: [], status: 'active', brand, ...(wpId ? { wp_id: wpId } : {}),
    });
    await product('frame-1', 'odz-optyk', '1');
    await product('hand-lodz', 'Łódź Optyk');
    await product('hand-sir', 'SIR');
    await R.LocalDB.createBrand({ name: 'Łódź Optyk', slug: 'odz-optyk' });
    const res = await R.applyWooImport(R.planWooImport(MIXED_DUMP), 'u1', { dryRun: false, includePosts: false });
    console.log(JSON.stringify({
      run: summary(res), brands: await brandsByWpId(), records: await records(), listing: await listing(), sir: await total('sir'),
    }));
    process.exit(0);
  }

  // brands-legacy
  for (const [wpId, brand] of LEGACY_PRODUCTS) {
    // The fields the previous applyWooImport wrote for this dump, and no others.
    await R.LocalDB.createProduct({
      name: `Frame ${wpId}`, slug: `frame-${wpId}`, price_cents: 1000, sale_price_cents: null, on_sale: false,
      stock: 3, in_stock: true, categories: [], images: [], status: 'active', wp_id: wpId, ...(brand ? { brand } : {}),
    });
  }
  for (const r of LEGACY_RECORDS) await R.LocalDB.createBrand(r);
  const before = { listing: await listing(), rgreen: await total('rgreen'), orgreenName: await total('Ørgreen') };

  const rehearsal = await R.applyWooImport(R.planWooImport(LEGACY_DUMP), 'u1', { dryRun: true, includePosts: false });
  const afterRehearsal = await brandsByWpId();
  const reimport = await R.applyWooImport(R.planWooImport(LEGACY_DUMP), 'u1', { dryRun: false, includePosts: false });
  const after = { brands: await brandsByWpId(), records: await records(), listing: await listing() };
  const again = await R.applyWooImport(R.planWooImport(LEGACY_DUMP), 'u1', { dryRun: false, includePosts: false });
  console.log(JSON.stringify({
    before, rehearsal: summary(rehearsal), afterRehearsal, reimport: summary(reimport), after,
    again: summary(again), recordsAfterAgain: (await records()).length, brandsAfterAgain: await brandsByWpId(),
  }));
  process.exit(0);
}

/* ------------------------------------------------------------------ *
 * The child: one driver, one database.                                *
 * ------------------------------------------------------------------ */
if (process.env.WOO_TEST_CHILD) {
  const { build } = await import('esbuild');
  const { pathToFileURL } = await import('node:url');

  const cacheDir = path.join(root, 'node_modules', '.cache');
  await fs.mkdir(cacheDir, { recursive: true });

  const [
    { planWooImport },
    { applyWooImport },
    { LocalDB },
    { COMMERCE_ENABLED_KEY, resolveCommerceEnabled },
  ] = await loadTogether([
    'src/lib/import/woo.ts',
    'src/lib/import/woo-apply.ts',
    'src/lib/localdb.ts',
    'src/lib/commerce-settings.ts',
  ]);

  await LocalDB.init();
  const admin = (await LocalDB.getUsers()).find((u) => u.role === 'admin');
  if (!admin) {
    console.log(JSON.stringify({ fatal: 'no admin in a fresh install' }));
    process.exit(0);
  }

  const commerceNow = async () =>
    resolveCommerceEnabled({
      [COMMERCE_ENABLED_KEY]: (await LocalDB.getSetting(COMMERCE_ENABLED_KEY))?.value,
    });

  const plan = planWooImport(DUMP_JSON);

  const commerceAtStart = await commerceNow();

  // An import that creates nothing, run while the shop is still OFF. This has
  // to happen HERE: run after a real import it proves nothing, because the
  // switch is already on and "did not turn it on" is true either way.
  const empty = await applyWooImport(planWooImport({}), admin.id, { dryRun: false });
  const commerceAfterEmpty = await commerceNow();

  // A rehearsal must not write, and must not touch the switch.
  const dry = await applyWooImport(plan, admin.id, { dryRun: true });
  const commerceAfterDry = await commerceNow();
  const productsAfterDry = (await LocalDB.getProducts()).length;

  const first = await applyWooImport(plan, admin.id, { dryRun: false });
  const commerceAfterFirst = await commerceNow();

  const second = await applyWooImport(plan, admin.id, { dryRun: false });
  const commerceAfterSecond = await commerceNow();

  // The scenario the WooCommerce-id stamp actually exists for: the shop owner
  // renames an imported product, which changes its slug, and then re-runs the
  // import. Without the stamp the slug check no longer recognises the record
  // and the product is created a second time — the shop ends up with two of
  // everything it has tidied up since the migration.
  // The operator corrects an imported customer's email, then re-runs. The
  // wp_id stamp — not the email — must be what recognises the record.
  const mariaRec = (await LocalDB.getCustomers()).find((c) => c.email === 'maria@example.com');
  if (mariaRec) await LocalDB.updateCustomer(mariaRec.id, { email: 'maria.new@example.com' });
  const afterEmailEdit = await applyWooImport(plan, admin.id, { dryRun: false });
  const customersAfterEdit = (await LocalDB.getCustomers()).length;

  const renamed = (await LocalDB.getProducts()).find((p) => p.slug === 'titanium-frame');
  if (renamed) await LocalDB.updateProduct(renamed.id, { slug: 'titanium-frame-renamed' });
  const afterRename = await applyWooImport(plan, admin.id, { dryRun: false });
  const productsAfterRename = (await LocalDB.getProducts()).length;

  const products = await LocalDB.getProducts();
  const orders = await LocalDB.getOrders();
  const customers = await LocalDB.getCustomers();
  const posts = await LocalDB.getPosts();
  const brands = await LocalDB.getBrands();
  const cats = await LocalDB.getProductCategories();

  const frame = products.find((p) => p.wp_id === '1');
  const order = orders.find((o) => o.number === 'WC-500');
  const maria = customers.find((c) => c.email === 'maria.new@example.com');

  console.log(JSON.stringify({
    commerceAtStart,
    commerceAfterDry,
    commerceAfterFirst,
    commerceAfterSecond,
    commerceAfterEmpty,
    dryCreatedProducts: dry.createdProducts,
    dryEnabledCommerce: dry.enabledCommerce,
    productsAfterDry,
    firstCreatedProducts: first.createdProducts,
    firstEnabledCommerce: first.enabledCommerce,
    secondCreatedProducts: second.createdProducts,
    secondEnabledCommerce: second.enabledCommerce,
    renameCreatedProducts: afterRename.createdProducts,
    productsAfterRename,
    renameSkippedAsImported: afterRename.skipped.filter((x) => /already imported/.test(x.reason)).length,
    emptyEnabledCommerce: empty.enabledCommerce,
    failed: first.failed,
    counts: {
      products: products.length, orders: orders.length, customers: customers.length,
      brands: brands.length, cats: cats.length,
    },
    frame: frame && {
      price: frame.price_cents,
      regular: frame.regular_price_cents,
      onSale: frame.on_sale,
      stock: frame.stock,
      hasScript: /<script/i.test(frame.description ?? ''),
      keepsText: /Light\./.test(frame.description ?? ''),
      categories: frame.categories,
      brand: frame.brand,
      wpId: frame.wp_id,
    },
    order: order && {
      status: order.status,
      currency: order.currency,
      total: order.total_cents,
      linksCustomer: order.customer_id === maria?.id,
      customerIdIsReal: typeof order.customer_id === 'string' && !order.customer_id.startsWith('dry-run:'),
      itemLinksProduct: order.items?.[0]?.product_id === frame?.id,
      created: order.created_at,
    },
    ownerImportedAsCustomer: customers.some((c) => c.email === 'owner@shop.gr'),
    postSlugs: posts.filter((p) => p.wp_id === '900').map((p) => p.slug),
    draftStatus: posts.find((p) => p.wp_id === '901')?.status ?? null,
    orderCreatedAt: order?.created_at ?? null,
    customersAfterEdit,
    editRunCreatedCustomers: afterEmailEdit.createdCustomers,
    catNames: cats.map((c) => c.name),
  }));
  process.exit(0);
}

/* ------------------------------------------------------------------ *
 * The parent.                                                         *
 * ------------------------------------------------------------------ */
let pass = 0;
let fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };

const tmpRoot = path.join(os.tmpdir(), `astrobaas-woo-test-${process.pid}`);
await fs.mkdir(tmpRoot, { recursive: true });

const DRIVERS = [
  { name: 'lowdb', env: (dir) => ({ DB_PATH: path.join(dir, 'db.json') }) },
  { name: 'libsql', env: (dir) => ({ DATABASE_URL: `file:${path.join(dir, 'db.sqlite')}` }) },
  {
    name: 'relational',
    env: (dir) => ({
      DATABASE_URL: `file:${path.join(dir, 'db.sqlite')}`,
      DATABASE_DRIVER: 'relational',
    }),
  },
];

/** Run one brand scenario on a fresh database; the parsed result, or null (already reported). */
async function brandChild(driver, mode) {
  const dir = path.join(tmpRoot, `${driver.name}-${mode}`);
  await fs.mkdir(path.join(dir, 'uploads'), { recursive: true });
  const env = { ...process.env };
  // Only the driver under test may choose the database.
  delete env.DATABASE_URL; delete env.DATABASE_DRIVER; delete env.DB_PATH;
  const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    cwd: root,
    encoding: 'utf8',
    env: { ...env, WOO_TEST_CHILD: mode, UPLOADS_DIR: path.join(dir, 'uploads'), NODE_ENV: 'test', SITE_LOCALES: 'en,el', ...driver.env(dir) },
    maxBuffer: 32 * 1024 * 1024,
  });
  const line = (run.stdout ?? '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
  if (!line) {
    fail++;
    console.error(`✗ [${driver.name}] the ${mode} child produced no result`);
    console.error((run.stderr ?? '').split('\n').slice(-15).join('\n'));
    return null;
  }
  return JSON.parse(line);
}

const hasRecord = (records, name, slug) => (records ?? []).some(([n, s]) => n === name && s === slug);
const recordsNamed = (records, name) => (records ?? []).filter(([n]) => n === name).length;
const everySlugReturnsItsCount = (listing) => (listing ?? []).length > 0 && listing.every((e) => e.filtered === e.count);

for (const driver of DRIVERS) {
  const t = (n, c) => check(`[${driver.name}] ${n}`, c);

  /* --- brands, on a fresh shop --- */
  const fresh = await brandChild(driver, 'brands-fresh');
  if (fresh) {
    const b = fresh.brands ?? {};
    const L = fresh.listing ?? [];
    const one = (key) => L.filter((e) => e.key === key);
    t('fresh: a Greek brand arrives on its products, in Greek — not as no brand',
      b['1'] === 'Όψη Οπτικά' && b['2'] === 'Όψη Οπτικά');
    t('fresh: Straße and Ørgreen keep every letter on the product', b['3'] === 'Straße' && b['4'] === 'Ørgreen');
    t('fresh: a brand WordPress gave an encoded slug keeps its name', b['5'] === 'Γυαλιά Ηλίου');
    t('fresh: brand records get transliterated slugs, never hex',
      hasRecord(fresh.records, 'Όψη Οπτικά', 'opsi-optika') && hasRecord(fresh.records, 'Ørgreen', 'orgreen')
        && hasRecord(fresh.records, 'Γυαλιά Ηλίου', 'gyalia-iliou') && hasRecord(fresh.records, 'Ray Ban', 'ray-ban'));
    t('fresh: no record takes "strasse" from the Strasse the shop already sells, and the skip says so',
      !(fresh.records ?? []).some(([, s]) => s === 'strasse')
        && (fresh.first?.brandSkips ?? []).some((s) => s.label === 'Straße' && /"strasse".*"Strasse"/.test(s.reason)));
    t('fresh: ...so ?brand=strasse still returns only Strasse', fresh.strasse === 1);
    t('fresh: every maker is listed ONCE',
      L.length === 6 && ['οψηοπτικα', 'straße', 'strasse', 'ørgreen', 'γυαλιαηλιου', 'rayban'].every((k) => one(k).length === 1));
    t('fresh: ...with all its products counted',
      one('οψηοπτικα')[0]?.count === 2 && one('straße')[0]?.count === 1 && one('ørgreen')[0]?.count === 1
        && one('γυαλιαηλιου')[0]?.count === 1 && one('rayban')[0]?.count === 1);
    t(`fresh: for EVERY listed brand, ?brand=<slug> returns exactly its count${everySlugReturnsItsCount(L) ? '' : ` — ${JSON.stringify(L)}`}`,
      everySlugReturnsItsCount(L));
    t('fresh: every published slug is unique', L.length > 0 && new Set(L.map((e) => e.slug)).size === L.length);
    t('fresh: re-running creates no record and restores nothing',
      fresh.again?.createdBrands === 0 && fresh.again?.restoredBrands === 0 && fresh.recordsAfterAgain === (fresh.records ?? []).length);
    t('fresh: nothing failed', fresh.first?.failed?.length === 0 && fresh.again?.failed?.length === 0);
  }

  /* --- brands, on a shop the previous importer filled, then re-imported --- */
  const legacy = await brandChild(driver, 'brands-legacy');
  if (legacy) {
    const B = legacy.before?.listing ?? [];
    const named = (list, n) => list.filter((e) => e.name === n);
    // The attach rule in buildBrandDirectory is what serves this shop; these
    // pin that it keeps doing so.
    t('old shop: Ørgreen is listed ONCE, under its name, and its slug "rgreen" returns its product',
      named(B, 'Ørgreen').length === 1 && !B.some((e) => e.name === 'rgreen')
        && named(B, 'Ørgreen')[0]?.slug === 'rgreen' && named(B, 'Ørgreen')[0]?.count === 1 && legacy.before?.rgreen === 1);
    t('old shop: ...and so is Straße, under "stra-e"',
      named(B, 'Straße').length === 1 && named(B, 'Straße')[0]?.slug === 'stra-e' && named(B, 'Straße')[0]?.filtered === 1);
    t('old shop: ?brand= by the name a brand is shown under finds its products too', legacy.before?.orgreenName === 1);
    t('old shop: no maker is listed twice', B.length === 7 && new Set(B.map((e) => e.key)).size === 7);
    t(`old shop: for EVERY listed brand, ?brand=<slug> returns exactly its count${everySlugReturnsItsCount(B) ? '' : ` — ${JSON.stringify(B)}`}`,
      everySlugReturnsItsCount(B));

    t('re-import rehearsal: reports the two dropped brands it would give back', legacy.rehearsal?.restoredBrands === 2);
    t('...and writes none', legacy.afterRehearsal?.['1'] === null && legacy.afterRehearsal?.['4'] === null);

    const rec = legacy.after?.records ?? [];
    t('re-import: no second record for any maker the shop already has',
      ['Straße', 'Ørgreen', 'Γυαλιά Ηλίου', 'Ray Ban', 'Persol'].every((n) => recordsNamed(rec, n) === 1));
    t('re-import: ...and the skip names the record it already is',
      (legacy.reimport?.brandSkips ?? []).some((s) => s.label === 'Ørgreen' && /already here, as "Ørgreen" \(slug "rgreen"\)/.test(s.reason)));
    t('re-import: records only for the makers that had none — Æsir under the slug its products already use',
      legacy.reimport?.createdBrands === 2 && hasRecord(rec, 'Όψη Οπτικά', 'opsi-optika') && hasRecord(rec, 'Æsir', 'sir'));

    const a = legacy.after?.brands ?? {};
    t('re-import: a Greek brand the old import dropped is given back, by name',
      a['1'] === 'Όψη Οπτικά' && a['4'] === 'Γυαλιά Ηλίου' && legacy.reimport?.restoredBrands === 2);
    t('re-import: a brand the old import DID store is left exactly as it is',
      a['2'] === 'stra-e' && a['3'] === 'rgreen' && a['5'] === 'ray-ban' && a['6'] === 'sir');
    t('re-import: a brand the operator removed stays removed', a['7'] === null);
    t('re-import: a brand the operator set by hand is kept', a['8'] === 'Opsi');
    t('re-import: a NEW product joins its maker where the shop already keeps it',
      a['9'] === 'rgreen' && a['10'] === 'stra-e' && a['11'] === 'sir');
    t('re-import: ...and a new product of any other maker carries the name', a['12'] === 'Όψη Οπτικά' && a['13'] === 'Ray Ban');

    const A = legacy.after?.listing ?? [];
    const expected = { 'Ørgreen': 2, 'Straße': 2, 'Æsir': 2, 'Όψη Οπτικά': 2, 'Ray Ban': 2, 'Γυαλιά Ηλίου': 1, 'Persol': 0, 'Opsi': 1 };
    t(`re-import: every maker is still listed ONCE, with all its products${A.length === 8 ? '' : ` — ${JSON.stringify(A.map((e) => [e.name, e.count]))}`}`,
      A.length === 8 && new Set(A.map((e) => e.key)).size === 8
        && Object.entries(expected).every(([n, c]) => named(A, n).length === 1 && named(A, n)[0]?.count === c));
    t('re-import: the slugs the shop already published still lead to their brands',
      named(A, 'Ørgreen')[0]?.slug === 'rgreen' && named(A, 'Straße')[0]?.slug === 'stra-e' && named(A, 'Æsir')[0]?.slug === 'sir');
    t(`re-import: for EVERY listed brand, ?brand=<slug> returns exactly its count${everySlugReturnsItsCount(A) ? '' : ` — ${JSON.stringify(A)}`}`,
      everySlugReturnsItsCount(A));
    t('re-import: nothing failed', legacy.reimport?.failed?.length === 0);
    t('a second re-import creates nothing, gives back nothing and changes no brand',
      legacy.again?.createdBrands === 0 && legacy.again?.restoredBrands === 0 && legacy.again?.createdProducts === 0
        && legacy.recordsAfterAgain === rec.length
        && JSON.stringify(legacy.brandsAfterAgain) === JSON.stringify(legacy.after?.brands));
  }

  /* --- brands, where the old slug is not the whole story --- */
  const mixed = await brandChild(driver, 'brands-mixed');
  if (mixed) {
    const L = mixed.listing ?? [];
    const lodz = L.filter((e) => e.name === 'Łódź Optyk');
    const sir = L.filter((e) => e.key === 'sir');
    t('mixed: a new product joins the NAME the shop already sells a maker under, where its record is listed',
      mixed.brands?.['2'] === 'Łódź Optyk' && lodz.length === 1 && lodz[0]?.curated === true && lodz[0]?.count === 2);
    t('mixed: ...the product an earlier run wrote keeps its old slug, and no second record is made',
      mixed.brands?.['1'] === 'odz-optyk' && recordsNamed(mixed.records, 'Łódź Optyk') === 1);
    t('mixed: an old-style slug that only a hand-made maker carries is never borrowed',
      mixed.brands?.['3'] === 'Æsir' && hasRecord(mixed.records, 'Æsir', 'aesir'));
    t('mixed: ...so SIR keeps "sir", and ?brand=sir still returns only SIR',
      sir.length === 1 && sir[0]?.slug === 'sir' && sir[0]?.count === 1 && mixed.sir === 1);
    t(`mixed: for EVERY listed brand, ?brand=<slug> returns exactly its count${everySlugReturnsItsCount(L) ? '' : ` — ${JSON.stringify(L)}`}`,
      everySlugReturnsItsCount(L));
    t('mixed: nothing failed', mixed.run?.failed?.length === 0);
  }

  /* --- the shop --- */
  const dir = path.join(tmpRoot, driver.name);
  await fs.mkdir(path.join(dir, 'uploads'), { recursive: true });

  const run = spawnSync(process.execPath, [
    '--input-type=module',
    '-e',
    `globalThis.DUMP_JSON = ${JSON.stringify(DUMP)};\n`
    + `await import(${JSON.stringify(fileURLToPath(import.meta.url))});`,
  ], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      WOO_TEST_CHILD: '1',
      UPLOADS_DIR: path.join(dir, 'uploads'),
      NODE_ENV: 'test',
      ...driver.env(dir),
    },
    maxBuffer: 32 * 1024 * 1024,
  });

  const line = (run.stdout ?? '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
  if (!line) {
    fail++;
    console.error(`✗ [${driver.name}] the import child produced no result`);
    console.error((run.stderr ?? '').split('\n').slice(-15).join('\n'));
    continue;
  }
  const r = JSON.parse(line);
  if (r.fatal) { fail++; console.error(`✗ [${driver.name}] ${r.fatal}`); continue; }

  /* --- the commerce switch, in one direction only --- */
  t('a fresh install starts with the shop off', r.commerceAtStart === false);
  t('a REHEARSAL does not touch the switch', r.commerceAfterDry === false);
  t('...and reports that it did not', r.dryEnabledCommerce === false);
  t('importing a shop turns the shop on', r.commerceAfterFirst === true);
  t('...and says so, so the operator is not surprised', r.firstEnabledCommerce === true);
  t('a second import leaves it on', r.commerceAfterSecond === true);
  t('...and does not claim to have enabled it twice', r.secondEnabledCommerce === false);
  // The one that protects the two live shops.
  // Run on the fresh install, before anything else: an importer that somebody
  // pointed at an empty folder is not evidence that this install is a shop.
  t('an import that creates NOTHING does not turn the shop on',
    r.commerceAfterEmpty === false && r.emptyEnabledCommerce === false);

  /* --- a rehearsal is a rehearsal --- */
  t('a rehearsal reports the product it would create', r.dryCreatedProducts === 1);
  t('...and writes none', r.productsAfterDry === 0);

  /* --- idempotency --- */
  t('the import creates the one well-formed product', r.firstCreatedProducts === 1);
  t('a second run creates no products', r.secondCreatedProducts === 0);
  // The stamp, not the slug, is what recognises the record here.
  t('re-importing after the owner RENAMED a product creates no duplicate',
    r.renameCreatedProducts === 0 && r.productsAfterRename === 1);
  t('...and the skip says it was already imported, not that the slug was taken',
    r.renameSkippedAsImported >= 1);
  t('nothing failed', Array.isArray(r.failed) && r.failed.length === 0);
  t('there is exactly one product, one order and one customer after two runs',
    r.counts.products === 1 && r.counts.orders === 1 && r.counts.customers === 1);
  t('and one brand and one category', r.counts.brands === 1 && r.counts.cats === 1);

  /* --- the product --- */
  t('the price is stored as cents', r.frame?.price === 19900);
  t('the regular price is kept so the discount can be shown', r.frame?.regular === 24900);
  t('the sale flag survives', r.frame?.onSale === true);
  t('the stock count survives', r.frame?.stock === 4);
  t('script in product copy is stripped', r.frame?.hasScript === false);
  t('...while the actual copy survives', r.frame?.keepsText === true);
  t('the category slug is attached', r.frame?.categories?.includes('frames') === true);
  t('the brand is stored as the shop spells it, not as a slug', r.frame?.brand === 'Ray Ban');
  t('the WooCommerce id is stamped, which is what makes a re-run safe', r.frame?.wpId === '1');
  t('the category keeps its display name from the dump',
    r.catNames.includes('Frames & Lenses'));

  /* --- the order and its references --- */
  t('the order arrives completed', r.order?.status === 'completed');
  t('the currency is an uppercase code', r.order?.currency === 'EUR');
  t('the total is cents', r.order?.total === 19900);
  t('the order points at the customer it names', r.order?.linksCustomer === true);
  t('...with a real id, never a dry-run placeholder', r.order?.customerIdIsReal === true);
  t('the line points at the product it names', r.order?.itemLinksProduct === true);

  /* --- what must NOT have happened --- */
  t('the shop OWNER is not imported as a customer', r.ownerImportedAsCustomer === false);
  t('the blog post came across once', r.postSlugs.length === 1);
  t('a DRAFT blog post arrives as a draft, not on the open web',
    r.draftStatus === 'draft');
  // The dump said 2024; every driver's create() stamps NOW, so the historical
  // date has to survive the write-after-create pass.
  t('the order keeps its HISTORICAL date, not the import day',
    r.orderCreatedAt === '2024-03-05T09:30:00.000Z');
  t('a re-run after the operator corrected an email creates no duplicate customer',
    r.editRunCreatedCustomers === 0 && r.customersAfterEdit === 1);
}

await fs.rm(tmpRoot, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
