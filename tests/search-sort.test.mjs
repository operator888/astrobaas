#!/usr/bin/env node
/**
 * Sorting search results (`?sort=` on GET /api/products and GET /api/search).
 *
 * Two layers:
 *
 *  1. The pure sorter and its vocabulary (`src/lib/commerce/product-sort.ts`),
 *     in-process.
 *  2. The real routes over real storage, on ALL THREE drivers — a sort that
 *     held on lowdb and not on the relational driver would be the disagreement
 *     this repository has had before. The fixture is written through
 *     `LocalDB`, and the products are read back through the route handlers.
 *
 * What is pinned, each of which fails if the change is reverted:
 *   - price_asc / price_desc / newest / name_asc / name_desc order a SEARCH;
 *   - a sale price counts, a variable product sorts by its cheapest variant,
 *     a product with no price is last in both directions;
 *   - sort composes with category, on_sale and paging (pages concatenate to
 *     the full order; total and hasMore describe the same set);
 *   - equal keys fall back to relevance, then the shop's order, then id, and
 *     the same query answers in the same order twice;
 *   - an unknown sort is a 422 (products and posts), price_* is a 422 on posts;
 *   - the sort key is on the response itself (`price_from_cents`), so sorting
 *     the response client-side reproduces the server order;
 *   - no `sort` keeps the original order, INCLUDING storage order among rows
 *     tied on position and date (the id tie-break is for explicit sorts only).
 *
 * Run with:  node tests/search-sort.test.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTs, ROOT } from './lib/load.mjs';

/* ---------------------------------------------------------------- child --- */
if (process.env.SEARCH_SORT_CHILD) {
  const src = (rel) => JSON.stringify(path.join(ROOT, rel));
  const entryRel = `node_modules/.cache/astrobaas-search-sort-${process.pid}.ts`;
  await fs.mkdir(path.join(ROOT, 'node_modules', '.cache'), { recursive: true });
  await fs.writeFile(path.join(ROOT, entryRel), [
    `export { LocalDB } from ${src('src/lib/localdb.ts')};`,
    `export { GET as productsGET } from ${src('src/pages/api/products/index.ts')};`,
    `export { GET as searchGET } from ${src('src/pages/api/search.ts')};`,
    `export { GET as productGET } from ${src('src/pages/api/products/[id].ts')};`,
  ].join('\n'));
  let M;
  try { M = await loadTs(entryRel, 'search-sort'); } finally {
    await fs.rm(path.join(ROOT, entryRel), { force: true });
  }
  const { LocalDB, productsGET, searchGET, productGET } = M;
  await LocalDB.init();

  const make = async (over) => {
    const row = await LocalDB.createProduct({
      status: 'active', stock: 5, categories: [], images: [], on_sale: false,
      regular_price_cents: over.price_cents, ...over,
    });
    // Pin the creation time. createProduct stamps "now", which makes every
    // fixture row a tie on the key `newest` sorts by.
    if (over.created_at) await LocalDB.updateProduct(row.id, { created_at: over.created_at });
    return row;
  };

  await LocalDB.createProductCategory({ name: 'Frames', slug: 'frames', position: 0 });
  const frames = ['frames'];
  // Search term "frame" matches all of these by NAME, so relevance is a tie and
  // the interesting orders are the sort ones.
  await make({ name: 'Alpha frame', slug: 'alpha', price_cents: 3000, created_at: '2026-01-03T10:00:00.000Z', categories: frames });
  // On sale: regular 2000, charged 900. `price_cents` is the charged amount.
  await make({
    name: 'Beta frame', slug: 'beta', price_cents: 900, regular_price_cents: 2000, sale_price_cents: 900,
    on_sale: true, created_at: '2026-01-02T10:00:00.000Z', categories: frames,
  });
  // Variable: parent price 5000, variants 4000 and 800. Sorts by 800.
  await make({
    name: 'Gamma frame', slug: 'gamma', price_cents: 5000, type: 'variable', created_at: '2026-01-05T10:00:00.000Z',
    categories: frames,
    variants: [
      { id: 'g-big', options: { Size: 'L' }, price_cents: 4000, stock: 3, in_stock: true, enabled: true },
      { id: 'g-small', options: { Size: 'S' }, price_cents: 800, stock: 3, in_stock: true, enabled: true },
      // Cheaper, but not buyable: must NOT drag the product to the front.
      { id: 'g-off', options: { Size: 'XS' }, price_cents: 10, stock: 3, in_stock: true, enabled: false },
    ],
  });
  // Same charged price as Beta, older, outside the category.
  await make({ name: 'Delta frame', slug: 'delta', price_cents: 900, created_at: '2026-01-01T10:00:00.000Z' });
  // Two rows that tie on EVERYTHING a sort looks at: only the id can order them.
  await make({ name: 'Twin frame', slug: 'twin-one', price_cents: 1500, created_at: '2026-01-04T10:00:00.000Z' });
  await make({ name: 'Twin frame', slug: 'twin-two', price_cents: 1500, created_at: '2026-01-04T10:00:00.000Z' });
  // A German name that sorts FIRST in German and last in the stored English.
  await make({
    name: 'Zulu frame', slug: 'zulu', price_cents: 2500, created_at: '2026-01-06T10:00:00.000Z',
    i18n: { de: { name: 'Aaa Rahmen frame' } },
  });
  // Six rows tied on position AND date: only storage order (no sort) or id
  // (explicit sort) can order them. Older than everything else.
  for (let k = 1; k <= 6; k += 1) {
    await make({ name: `Tiebreak ${k}`, slug: `tie-${k}`, price_cents: 700, created_at: '2025-12-01T10:00:00.000Z' });
  }
  // Never listed to a shopper, whatever the sort.
  await make({ name: 'Hidden draft frame', slug: 'draft', price_cents: 1, status: 'draft', created_at: '2026-01-07T10:00:00.000Z' });
  // Does not match the search at all.
  await make({ name: 'Plain sunglasses', slug: 'sun', price_cents: 100, created_at: '2026-01-08T10:00:00.000Z' });
  // Grouped products (#149) under their own search term, so the "frame" set
  // above is untouched. A group STORES price_cents 0 and shows its cheapest
  // public member as price_from_cents; a price sort must use the shown figure.
  // Older than everything, so "sun first" (newest) still holds.
  const old = '2025-06-01T10:00:00.000Z';
  const monoA = await make({ name: 'Mono lens A', slug: 'mono-a', price_cents: 4000, created_at: old });
  const monoB = await make({ name: 'Mono lens B', slug: 'mono-b', price_cents: 6000, created_at: old });
  const monoDraft = await make({ name: 'Mono lens draft', slug: 'mono-draft', price_cents: 10, status: 'draft', created_at: old });
  await make({ name: 'Bundle set', slug: 'bundle-set', type: 'grouped', price_cents: 0, grouped_product_ids: [monoA.id, monoB.id], created_at: old });
  // Its only member is a draft: no public price at all, so it sorts LAST both ways.
  await make({ name: 'Bundle empty', slug: 'bundle-empty', type: 'grouped', price_cents: 0, grouped_product_ids: [monoDraft.id], created_at: old });
  await make({ name: 'Bundle cheap', slug: 'bundle-cheap', price_cents: 100, created_at: old });
  await make({ name: 'Bundle dear', slug: 'bundle-dear', price_cents: 5000, created_at: old });

  const call = async (handler, query) => {
    const url = new URL(`http://t/api/x${query}`);
    const res = await handler({ url, request: new Request(url), locals: {}, clientAddress: '127.0.0.1' });
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  };
  const slugs = (r) => (r.body?.data ?? []).map((p) => p.slug);
  const list = async (query) => {
    const r = await call(productsGET, `?${query}`);
    return { status: r.status, slugs: slugs(r), meta: r.body?.meta, error: r.body?.error };
  };

  const out = {};
  // The two rows that tie on every key. Ids are random, so what is pinned is
  // that the tie is broken BY id, not which of the two happens to be first.
  const twinRows = (await LocalDB.getProducts()).filter((p) => p.slug.startsWith('twin-'));
  out.twinOrder = twinRows.sort((a, b) => String(a.id).localeCompare(String(b.id))).map((p) => p.slug);
  out.tieStorage = (await LocalDB.getProducts()).filter((p) => p.slug.startsWith('tie-')).map((p) => p.slug);
  out.tieIdOrder = (await LocalDB.getProducts()).filter((p) => p.slug.startsWith('tie-'))
    .sort((a, b) => String(a.id).localeCompare(String(b.id))).map((p) => p.slug);
  out.twinStorage = (await LocalDB.getProducts()).filter((p) => p.slug.startsWith('twin-')).map((p) => p.slug);
  out.tieDef = await list('search=tiebreak&limit=50');
  out.tieNewest = await list('search=tiebreak&sort=newest&limit=50');
  out.tiePrice = await list('search=tiebreak&sort=price_asc&limit=50');
  // Full rows, for the derivability check.
  const full = async (query) => (await call(productsGET, `?${query}`)).body?.data ?? [];
  out.rowsDef = (await full('search=frame&limit=50')).map((p) => ({ slug: p.slug, price_cents: p.price_cents, from: p.price_from_cents, to: p.price_to_cents }));
  out.rowsAsc = (await full('search=frame&sort=price_asc&limit=50')).map((p) => p.slug);
  out.rowsDesc = (await full('search=frame&sort=price_desc&limit=50')).map((p) => p.slug);
  const gammaRes = await productGET({ params: { id: 'gamma' }, url: new URL('http://t/api/products/gamma'), request: new Request('http://t/api/products/gamma'), locals: {} });
  const gammaBody = await gammaRes.json().catch(() => null);
  out.detail = { status: gammaRes.status, from: gammaBody?.data?.price_from_cents, to: gammaBody?.data?.price_to_cents, price: gammaBody?.data?.price_cents };
  const band = async (query) => (await full(query)).map((p) => ({ slug: p.slug, from: p.price_from_cents, price: p.price_cents }));
  out.groupAsc = await band('search=bundle&sort=price_asc&limit=50');
  out.groupDesc = await band('search=bundle&sort=price_desc&limit=50');
  out.groupPage1 = (await list('search=bundle&sort=price_asc&limit=2&offset=0')).slugs;
  out.def = await list('search=frame&limit=50');
  out.defNoSearch = await list('limit=50');
  out.asc = await list('search=frame&sort=price_asc&limit=50');
  out.desc = await list('search=frame&sort=price_desc&limit=50');
  out.newest = await list('search=frame&sort=newest&limit=50');
  out.nameAsc = await list('search=frame&sort=name_asc&limit=50');
  out.nameDesc = await list('search=frame&sort=name_desc&limit=50');
  out.nameAscDe = await list('search=frame&sort=name_asc&locale=de&limit=50');
  out.ascAgain = await list('search=frame&sort=price_asc&limit=50');
  out.relevance = await list('search=frame&sort=relevance&limit=50');
  // Paging over the sorted set.
  out.p1 = await list('search=frame&sort=price_asc&limit=3&offset=0');
  out.p2 = await list('search=frame&sort=price_asc&limit=3&offset=3');
  out.p3 = await list('search=frame&sort=price_asc&limit=3&offset=6');
  // Composition with filters.
  out.cat = await list('category=frames&sort=price_desc&limit=50');
  out.sale = await list('search=frame&on_sale=1&sort=price_asc&limit=50');
  out.saleTrue = await list('search=frame&on_sale=true&limit=50');
  out.catPaged = await list('category=frames&sort=newest&limit=2&offset=2');
  // Refusals.
  out.bad = await list('search=frame&sort=price-asc');
  out.badCase = await list('search=frame&sort=PRICE_ASC');
  out.empty = await list('search=frame&sort=');
  out.noMatch = await list('search=zzzz&sort=price_asc');

  // Blog search.
  const post = (title, created_at, extra = {}) => LocalDB.createPost({
    title, slug: title.toLowerCase().replace(/\W+/g, '-'), content: `<p>${title} about glasses</p>`, excerpt: '',
    status: 'published', kind: 'post', ...extra, created_at,
  });
  const mk = async (title, created) => {
    const row = await post(title, created);
    await LocalDB.updatePost(row.id, { created_at: created });
    return row;
  };
  await mk('Glasses oldest', '2026-02-01T10:00:00.000Z');
  await mk('Glasses newest', '2026-02-09T10:00:00.000Z');
  await mk('Glasses middle', '2026-02-05T10:00:00.000Z');
  const titles = async (query) => {
    const r = await call(searchGET, `?${query}`);
    return { status: r.status, titles: (r.body?.data ?? []).map((p) => p.title), meta: r.body?.meta };
  };
  out.postNewest = await titles('q=glasses&sort=newest');
  out.postName = await titles('q=glasses&sort=name_asc');
  out.postPrice = await titles('q=glasses&sort=price_asc');
  out.postBad = await titles('q=glasses&sort=bogus');
  out.postDef = await titles('q=glasses');

  console.log(`__RESULT__${JSON.stringify(out)}`);
  process.exit(0);
}

/* --------------------------------------------------------------- parent --- */
let pass = 0;
let fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ---- 1. the pure sorter ------------------------------------------------- */
{
  const S = await loadTs('src/lib/commerce/product-sort.ts', 'search-sort-pure');
  const P = (name, price, created, extra = {}) => ({ name, price_cents: price, created_at: created, ...extra });
  const items = [
    P('b', 200, '2026-01-02'), P('a', 100, '2026-01-01'), P('c', 300, '2026-01-03'),
    P('nop', undefined, '2026-01-04'),
  ];
  const names = (sort, locale) => S.sortItems(items, sort, S.PRODUCT_SORT_KEYS, locale).map((p) => p.name);

  check('the vocabulary is exactly the six documented values',
    same(S.SORT_VALUES, ['relevance', 'price_asc', 'price_desc', 'newest', 'name_asc', 'name_desc']));
  check('price_asc: cheapest first, no-price LAST', same(names('price_asc'), ['a', 'b', 'c', 'nop']));
  check('price_desc: dearest first, no-price STILL last', same(names('price_desc'), ['c', 'b', 'a', 'nop']));
  check('newest: latest created_at first', same(names('newest'), ['nop', 'c', 'b', 'a']));
  check('name_asc / name_desc', same(names('name_asc'), ['a', 'b', 'c', 'nop']) && same(names('name_desc'), ['nop', 'c', 'b', 'a']));
  check('relevance is the input order, untouched', same(names('relevance'), ['b', 'a', 'c', 'nop']));
  check('sorting does not mutate its input', same(items.map((p) => p.name), ['b', 'a', 'c', 'nop']));

  const ties = [P('x', 100, '2026-01-01'), P('y', 100, '2026-01-01'), P('z', 50, '2026-01-01')];
  check('equal keys keep their incoming order (stable)',
    same(S.sortItems(ties, 'price_asc', S.PRODUCT_SORT_KEYS).map((p) => p.name), ['z', 'x', 'y']));

  const numeric = [P('Frame 10', 1, 'x'), P('Frame 2', 1, 'x'), P('frame 1', 1, 'x')];
  check('names compare naturally and ignore case',
    same(S.sortItems(numeric, 'name_asc', S.PRODUCT_SORT_KEYS).map((p) => p.name), ['frame 1', 'Frame 2', 'Frame 10']));

  const variable = { price_cents: 5000, variants: [
    { id: 'a', options: {}, price_cents: 4000, stock: 1, in_stock: true, enabled: true },
    { id: 'b', options: {}, price_cents: 800, stock: 1, in_stock: true, enabled: true },
    { id: 'c', options: {}, price_cents: 10, stock: 1, in_stock: true, enabled: false },
  ] };
  check('a variable product is priced by its cheapest BUYABLE variant', S.sortPriceCents(variable) === 800);
  check('a simple product is priced by price_cents', S.sortPriceCents({ price_cents: 1234 }) === 1234);
  check('NaN is no price', S.sortPriceCents({ price_cents: Number.NaN }) === null);

  check('absent and empty mean the default', S.parseSort(undefined).sort === 'relevance' && S.parseSort('').sort === 'relevance' && S.parseSort(null).ok);
  check('a known value parses', S.parseSort('price_desc').sort === 'price_desc');
  check('an unknown value is refused, with what is allowed',
    S.parseSort('price-desc').ok === false && S.parseSort('price-desc').allowed.length === 6);
  check('case is not folded', S.parseSort('NEWEST').ok === false);
  check('a value outside `allowed` is refused', S.parseSort('price_asc', ['relevance', 'newest']).ok === false);
}

/* ---- 1b. the places that publish the vocabulary ------------------------- */
{
  const S = await loadTs('src/lib/commerce/product-sort.ts', 'search-sort-docs');
  const read = (rel) => fs.readFile(path.join(ROOT, rel), 'utf8');
  const openapi = await read('src/pages/openapi.json.ts');
  const llms = await read('src/pages/llms.txt.ts');
  const client = await read('src/client/index.ts');
  const starter = await read('examples/storefront/src/pages/search.astro');
  const missing = (text) => S.SORT_VALUES.filter((v) => !text.includes(v));

  check('openapi.json documents every sort value', missing(openapi).length === 0);
  check('llms.txt lists every sort value', missing(llms).length === 0);
  check('the typed client exposes ?sort= on products.list', /sort\?: ProductSort/.test(client));

  // The starter's menu may only offer values the CMS documents, and must not
  // sort anything itself: the server decides the order.
  const offered = [...starter.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
  check('the starter storefront has a sort menu', offered.length >= 3);
  check('...offering only documented values', offered.every((v) => S.SORT_VALUES.includes(v)));
  check('...and never re-sorts results in the browser', !/\.sort\(|\.toSorted\(/.test(starter));
}

/* ---- 2. the routes, on every driver ------------------------------------- */
const here = path.dirname(fileURLToPath(import.meta.url));
const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'astrobaas-search-sort-'));

const DRIVERS = [
  { name: 'lowdb', env: (d) => ({ DB_PATH: path.join(d, 'db.json') }) },
  { name: 'libsql', env: (d) => ({ DATABASE_URL: `file:${path.join(d, 'db.sqlite')}` }) },
  { name: 'relational', env: (d) => ({ DATABASE_URL: `file:${path.join(d, 'db.sqlite')}`, DATABASE_DRIVER: 'relational' }) },
];

for (const driver of DRIVERS) {
  const dir = path.join(tmpRoot, driver.name);
  await fs.mkdir(path.join(dir, 'uploads'), { recursive: true });
  const env = { ...process.env, SEARCH_SORT_CHILD: '1', SITE_LOCALES: 'en,de', NODE_ENV: 'test', UPLOADS_DIR: path.join(dir, 'uploads') };
  delete env.DATABASE_URL;
  delete env.DATABASE_DRIVER;
  delete env.DB_PATH;
  const run = spawnSync(process.execPath, [path.join(here, 'search-sort.test.mjs')], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    env: { ...env, ...driver.env(dir) },
  });
  const t = (n, c) => check(`[${driver.name}] ${n}`, c);
  const line = (run.stdout || '').split('\n').find((l) => l.startsWith('__RESULT__'));
  if (!line) {
    t(`the child produced a result\n${(run.stderr || '').slice(-900)}`, false);
    continue;
  }
  const r = JSON.parse(line.slice('__RESULT__'.length));
  const order = (x) => x.slugs;

  // The merchandising order (position, newest, id) among the matching rows:
  // zulu(01-06) gamma(01-05) the twins by id (01-04) alpha(01-03) beta(01-02) delta(01-01).
  const [t1, t2] = r.twinOrder;
  const merch = ['zulu', 'gamma', t1, t2, 'alpha', 'beta', 'delta'];
  // With no explicit sort, ties keep STORAGE order (as before this change).
  const merchDefault = ['zulu', 'gamma', ...r.twinStorage, 'alpha', 'beta', 'delta'];
  t('a search with no sort returns the merchandising order, unchanged', same(order(r.def), merchDefault));
  t('...and relevance explicitly is the same', same(order(r.relevance), merchDefault));
  t('...`meta.sort` says so', r.def.meta?.sort === 'relevance' && r.relevance.meta?.sort === 'relevance');
  t('the draft and the non-matching product are never listed',
    !order(r.asc).includes('draft') && !order(r.asc).includes('sun'));

  // Charged prices: gamma 800 (cheapest variant), beta 900, delta 900,
  // twin 1500 x2, zulu 2500, alpha 3000.
  t('price_asc: sale price and cheapest variant count; ties keep merchandising order',
    same(order(r.asc), ['gamma', 'beta', 'delta', t1, t2, 'zulu', 'alpha']));
  t('price_desc: dearest first; the variable product still counts at its cheapest variant (last)',
    same(order(r.desc), ['alpha', 'zulu', t1, t2, 'beta', 'delta', 'gamma']));
  t('newest: by creation date', same(order(r.newest), merch));
  t('name_asc: A to Z in the stored language',
    same(order(r.nameAsc), ['alpha', 'beta', 'delta', 'gamma', t1, t2, 'zulu']));
  t('name_desc: Z to A', same(order(r.nameDesc), ['zulu', t1, t2, 'gamma', 'delta', 'beta', 'alpha']));
  t('name_asc with ?locale=de compares the TRANSLATED name (zulu is "Aaa Rahmen frame")',
    order(r.nameAscDe)[0] === 'zulu');
  t('the same query answers in the same order twice', same(order(r.asc), order(r.ascAgain)));
  t('meta.sort echoes the order applied', r.asc.meta?.sort === 'price_asc' && r.desc.meta?.sort === 'price_desc');
  t('every sort returns the same SET and total as relevance',
    [r.asc, r.desc, r.newest, r.nameAsc, r.nameDesc].every((x) => same([...order(x)].sort(), [...merch].sort())
      && x.meta?.total === 7));

  // The key is on the response: re-sorting the response's own price_from_cents
  // client-side (stable, over the default order) must equal the server's order.
  // Base order: the explicit-sort tie order (merch, twins by id).
  const base = merch.map((s) => r.rowsDef.find((p) => p.slug === s));
  const byFrom = (dir) => base.map((p, i) => ({ p, i }))
    .sort((a, b) => (dir * (a.p.from - b.p.from)) || (a.i - b.i)).map((x) => x.p.slug);
  t('every product response carries price_from_cents / price_to_cents',
    r.rowsDef.length === 7 && r.rowsDef.every((p) => Number.isInteger(p.from) && Number.isInteger(p.to)));
  t('simple products: from = to = price_cents; the variable one: 800 / 4000 while price_cents says 5000',
    r.rowsDef.every((p) => p.slug === 'gamma' || (p.from === p.price_cents && p.to === p.price_cents))
    && r.rowsDef.find((p) => p.slug === 'gamma')?.from === 800
    && r.rowsDef.find((p) => p.slug === 'gamma')?.to === 4000
    && r.rowsDef.find((p) => p.slug === 'gamma')?.price_cents === 5000);
  t('price_asc order == sorting the response by its own price_from_cents', same(r.rowsAsc, byFrom(1)));
  t('price_desc order == sorting the response by its own price_from_cents', same(r.rowsDesc, byFrom(-1)));
  t('the single-product route carries the same band', r.detail.status === 200 && r.detail.from === 800 && r.detail.to === 4000 && r.detail.price === 5000);

  // Grouped products sort by the "from" price they SHOW, not the 0 they store.
  t('a grouped product sorts by its shown "from" price (4000), not its stored 0',
    same(r.groupAsc.map((p) => p.slug), ['bundle-cheap', 'bundle-set', 'bundle-dear', 'bundle-empty'])
    && r.groupAsc.find((p) => p.slug === 'bundle-set')?.from === 4000);
  t('...price_desc likewise; a group with no public member sorts last both ways',
    same(r.groupDesc.map((p) => p.slug), ['bundle-dear', 'bundle-set', 'bundle-cheap', 'bundle-empty'])
    && r.groupDesc.find((p) => p.slug === 'bundle-empty')?.from === null);
  t('...and the order equals the response\'s own price_from_cents (nulls last)',
    [r.groupAsc, r.groupDesc].every((rows, k) => rows.every((p, i) => i === 0 || p.from === null
      || (rows[i - 1].from !== null && (k === 0 ? rows[i - 1].from <= p.from : rows[i - 1].from >= p.from)))));
  t('...and the first page of price_asc is cut AFTER the group is priced',
    same(r.groupPage1, ['bundle-cheap', 'bundle-set']));

  // Default order is untouched, including ties: storage order, NOT id order.
  t('no sort: rows tied on position and date keep STORAGE order', same(order(r.tieDef), r.tieStorage));
  t('explicit sort: the same tie is broken by id, deterministically',
    same(order(r.tieNewest), r.tieIdOrder) && same(order(r.tiePrice), r.tieIdOrder));

  // Paging.
  t('pages of a sorted list concatenate to the full order',
    same([...order(r.p1), ...order(r.p2), ...order(r.p3)], order(r.asc)));
  t('...with no repeated product', new Set([...order(r.p1), ...order(r.p2), ...order(r.p3)]).size === 7);
  t('total is the whole set on every page; hasMore is true until the last',
    r.p1.meta?.total === 7 && r.p2.meta?.total === 7 && r.p3.meta?.total === 7
    && r.p1.meta?.hasMore === true && r.p2.meta?.hasMore === true && r.p3.meta?.hasMore === false);
  t('...and the last page holds the remainder', order(r.p3).length === 1);

  // Composition.
  t('category + price_desc filters first, then sorts', same(order(r.cat), ['alpha', 'beta', 'gamma']) && r.cat.meta?.total === 3);
  t('on_sale=1 (what the typed client sends) filters, then sorts', same(order(r.sale), ['beta']) && r.sale.meta?.total === 1);
  t('on_sale=true still works', same(order(r.saleTrue), ['beta']));
  t('category + newest + paging: page 2 is the continuation and says it is the last',
    same(order(r.catPaged), ['beta']) && r.catPaged.meta?.total === 3 && r.catPaged.meta?.hasMore === false
    && r.catPaged.meta?.page === 2);

  // Refusals.
  t('an unknown sort is a 422 naming the allowed values',
    r.bad.status === 422 && r.bad.error?.code === 'VALIDATION_ERROR'
    && Array.isArray(r.bad.error?.details?.sort) && r.bad.error.details.sort.includes('price_asc'));
  t('sort is case-sensitive: PRICE_ASC is a 422', r.badCase.status === 422);
  t('an empty sort is the default, not an error', r.empty.status === 200 && same(order(r.empty), merchDefault));
  t('a sort over zero matches is an empty 200', r.noMatch.status === 200 && order(r.noMatch).length === 0 && r.noMatch.meta?.total === 0);
  t('with no search, the catalogue lists in merchandising order (sun first: newest)',
    order(r.defNoSearch)[0] === 'sun');

  // Blog search.
  t('posts: default order is not asserted to change', r.postDef.status === 200 && r.postDef.titles.length === 3);
  t('posts: newest', same(r.postNewest.titles, ['Glasses newest', 'Glasses middle', 'Glasses oldest']));
  t('posts: name_asc', same(r.postName.titles, ['Glasses middle', 'Glasses newest', 'Glasses oldest']));
  t('posts: price_asc is a 422, not silently ignored', r.postPrice.status === 422);
  t('posts: an unknown sort is a 422', r.postBad.status === 422);
  t('posts: meta.sort echoes', r.postNewest.meta?.sort === 'newest');
}

await fs.rm(tmpRoot, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
