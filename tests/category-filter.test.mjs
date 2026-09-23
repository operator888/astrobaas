#!/usr/bin/env node
/**
 * A product with no `categories` array must not take the catalogue down.
 *
 * `Product.categories` is typed as always present, and saveProduct always
 * writes one — but not every row goes through saveProduct. A plugin, an MCP or
 * API client that writes storage directly, an importer, or a row older than the
 * field can all leave it out. Two PUBLIC routes then threw on such a row:
 *
 *  - `GET /api/products?category=<slug>` — listProducts filtered with
 *    `p.categories.includes(cat)` whenever no category has an automatic rule;
 *  - `GET /api/product-categories` — the per-category count iterated
 *    `for (const slug of p.categories)`.
 *
 * One odd row was enough to answer 500 to every shopper browsing a category,
 * and to every storefront building its category menu. The rule-based branch
 * beside the first one already read `product.categories ?? []`.
 *
 * Run on all three drivers, because the row reaches the routes through
 * storage, and each driver hands a missing field back in its own way.
 *
 * Run with:  node tests/category-filter.test.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTs, ROOT } from './lib/load.mjs';

/* ---------------------------------------------------------------- child --- */
if (process.env.CATEGORY_FILTER_CHILD) {
  // One bundle, so the routes and the fixture share ONE LocalDB. Absolute
  // specifiers: a relative import from node_modules/.cache would resolve
  // through a symlinked node_modules into another checkout.
  const src = (rel) => JSON.stringify(path.join(ROOT, rel));
  const entryRel = `node_modules/.cache/astrobaas-category-filter-${process.pid}.ts`;
  await fs.mkdir(path.join(ROOT, 'node_modules', '.cache'), { recursive: true });
  await fs.writeFile(path.join(ROOT, entryRel), [
    `export { LocalDB } from ${src('src/lib/localdb.ts')};`,
    `export { listProducts } from ${src('src/lib/commerce-service.ts')};`,
    `export { GET as categoriesGET } from ${src('src/pages/api/product-categories/index.ts')};`,
  ].join('\n'));
  let M;
  try { M = await loadTs(entryRel, 'category-filter'); } finally {
    await fs.rm(path.join(ROOT, entryRel), { force: true });
  }
  const { LocalDB, listProducts, categoriesGET } = M;
  await LocalDB.init();

  await LocalDB.createProductCategory({ name: 'Frames', slug: 'frames', position: 0 });
  const filed = await LocalDB.createProduct({
    name: 'Filed frame', slug: 'filed-frame', status: 'active',
    price_cents: 1000, stock: 3, categories: ['frames'],
  });
  // No `categories` key at all — the row the routes choked on.
  const bare = await LocalDB.createProduct({
    name: 'Bare row', slug: 'bare-row', status: 'active', price_cents: 900, stock: 2,
  });
  const stored = bare?.id ? await LocalDB.getProduct(bare.id) : null;

  const outcome = async (fn) => {
    try { return { ok: true, value: await fn() }; } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  };

  const byCategory = await outcome(async () => {
    const { products, meta } = await listProducts({ category: 'frames', limit: 50 });
    return { slugs: products.map((p) => p.slug), total: meta.total };
  });
  const unfiltered = await outcome(async () => (await listProducts({ limit: 50 })).meta.total);
  const menu = await outcome(async () => {
    const u = new URL('http://t/api/product-categories');
    const res = await categoriesGET({ url: u, request: new Request(u), locals: {} });
    const body = await res.json().catch(() => null);
    return { status: res.status, frames: (body?.data ?? []).find((c) => c.slug === 'frames')?.product_count };
  });

  console.log(`__RESULT__${JSON.stringify({
    created: Boolean(filed?.id && bare?.id),
    bareHasNoCategories: stored ? !Array.isArray(stored.categories) : null,
    byCategory, unfiltered, menu,
  })}`);
  process.exit(0);
}

/* --------------------------------------------------------------- parent --- */
let pass = 0;
let fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };

const here = path.dirname(fileURLToPath(import.meta.url));
const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'astrobaas-category-filter-'));

const DRIVERS = [
  { name: 'lowdb', env: (d) => ({ DB_PATH: path.join(d, 'db.json') }) },
  { name: 'libsql', env: (d) => ({ DATABASE_URL: `file:${path.join(d, 'db.sqlite')}` }) },
  { name: 'relational', env: (d) => ({ DATABASE_URL: `file:${path.join(d, 'db.sqlite')}`, DATABASE_DRIVER: 'relational' }) },
];

for (const driver of DRIVERS) {
  const dir = path.join(tmpRoot, driver.name);
  await fs.mkdir(path.join(dir, 'uploads'), { recursive: true });
  const env = { ...process.env, CATEGORY_FILTER_CHILD: '1', NODE_ENV: 'test', UPLOADS_DIR: path.join(dir, 'uploads') };
  delete env.DATABASE_URL;
  delete env.DATABASE_DRIVER;
  delete env.DB_PATH;
  const run = spawnSync(process.execPath, [path.join(here, 'category-filter.test.mjs')], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    env: { ...env, ...driver.env(dir) },
  });
  const t = (n, c) => check(`[${driver.name}] ${n}`, c);
  const line = (run.stdout || '').split('\n').find((l) => l.startsWith('__RESULT__'));
  if (!line) {
    t(`the child produced a result\n${(run.stderr || '').slice(-700)}`, false);
    continue;
  }
  const r = JSON.parse(line.slice('__RESULT__'.length));

  t('both fixture products were created', r.created === true);
  // The fixture is only evidence if the row really lacks the array.
  t('the bare row is stored WITHOUT a categories array', r.bareHasNoCategories === true);

  t(`?category= does not throw on a row with no categories${r.byCategory?.ok ? '' : ` (threw: ${r.byCategory?.error})`}`,
    r.byCategory?.ok === true);
  t('...returns the product filed in that category',
    r.byCategory?.value?.slugs?.includes('filed-frame') === true);
  t('...and not the row with no categories',
    r.byCategory?.value?.slugs?.includes('bare-row') === false && r.byCategory?.value?.total === 1);
  t('the unfiltered catalogue still lists both', r.unfiltered?.ok === true && r.unfiltered.value === 2);

  t(`GET /api/product-categories does not fail on that row${r.menu?.ok ? '' : ` (threw: ${r.menu?.error})`}`,
    r.menu?.ok === true && r.menu.value?.status === 200);
  t('...and counts only the product that is really in the category',
    r.menu?.value?.frames === 1);
}

await fs.rm(tmpRoot, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
