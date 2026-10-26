#!/usr/bin/env node
/**
 * Boolean query flags: `1` and `true` mean yes, on every API route.
 *
 * The typed client (`src/client/index.ts`, `commerceQuery`) sends a true
 * boolean as `1`. GET /api/products read `=== 'true'`, so
 * `products.list({ featured: true })` returned the whole catalogue and a staff
 * `products.list({ all: true })` never saw a draft. Nothing errored.
 *
 * Three layers, each of which fails if the fix is reverted:
 *
 *  1. `queryFlag` itself (`src/lib/http/query-flags.ts`).
 *  2. A source tripwire: no file under `src/pages/api` compares `.get(...)`
 *     to `'true'` / `'1'` or defines a local `isTrue`. It catches the shapes
 *     this bug actually had, not every possible spelling of one.
 *  3. The real product route over real storage, on all three drivers:
 *     `featured`, `on_sale` and `all` with `1`, `true`, `0`, `false` and
 *     absent; then the TYPED CLIENT driven against that same handler, so the
 *     wire form the client sends is the one the route is tested with.
 *
 * Run with:  node tests/query-flags.test.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTs, ROOT } from './lib/load.mjs';

/* ---------------------------------------------------------------- child --- */
if (process.env.QUERY_FLAGS_CHILD) {
  // Absolute specifiers: a relative import from node_modules/.cache would
  // resolve through a symlinked node_modules into ANOTHER checkout.
  const src = (rel) => JSON.stringify(path.join(ROOT, rel));
  const entryRel = `node_modules/.cache/astrobaas-query-flags-${process.pid}.ts`;
  await fs.mkdir(path.join(ROOT, 'node_modules', '.cache'), { recursive: true });
  await fs.writeFile(path.join(ROOT, entryRel), [
    `export { LocalDB } from ${src('src/lib/localdb.ts')};`,
    `export { GET as productsGET } from ${src('src/pages/api/products/index.ts')};`,
    `export { createClient } from ${src('src/client/index.ts')};`,
  ].join('\n'));
  let M;
  try { M = await loadTs(entryRel, 'query-flags'); } finally {
    await fs.rm(path.join(ROOT, entryRel), { force: true });
  }
  const { LocalDB, productsGET, createClient } = M;
  await LocalDB.init();

  const make = (over) => LocalDB.createProduct({
    status: 'active', stock: 5, categories: [], images: [], on_sale: false, featured: false,
    price_cents: 1000, regular_price_cents: 1000, ...over,
  });
  await make({ name: 'Featured frame', slug: 'feat', featured: true });
  await make({ name: 'Sale frame', slug: 'sale', price_cents: 500, sale_price_cents: 500, on_sale: true });
  await make({ name: 'Plain frame', slug: 'plain' });
  // A draft that is ALSO featured: only `all` (staff) may surface it.
  await make({ name: 'Draft frame', slug: 'draft', featured: true, status: 'draft' });

  const STAFF = { user: { id: 'u-staff', role: 'admin', email: 'a@example.com' } };
  const call = async (query, locals = {}) => {
    const url = new URL(`http://t/api/products${query}`);
    const res = await productsGET({ url, request: new Request(url), locals, clientAddress: '127.0.0.1' });
    const body = await res.json().catch(() => null);
    return { status: res.status, slugs: (body?.data ?? []).map((p) => p.slug).sort() };
  };

  const out = {};
  for (const v of ['1', 'true', '0', 'false', '', 'yes', 'TRUE']) {
    out[`featured=${v}`] = await call(`?featured=${v}`);
    out[`on_sale=${v}`] = await call(`?on_sale=${v}`);
    out[`staff all=${v}`] = await call(`?all=${v}`, STAFF);
  }
  out.absent = await call('');
  out.staffAbsent = await call('', STAFF);
  out.anonAll1 = await call('?all=1');
  out.anonAllTrue = await call('?all=true');
  out.featuredAndSale = await call('?featured=1&on_sale=1');
  out.staffAllFeatured = await call('?all=1&featured=1', STAFF);

  // The typed client, against the same handler. `locals` follows the API key
  // the client was created with, as the middleware would set it.
  const viaClient = (locals) => createClient('http://t', {
    fetch: async (input, init = {}) => {
      const url = new URL(String(input));
      out.wire ??= [];
      out.wire.push(url.search);
      return productsGET({ url, request: new Request(url, init), locals, clientAddress: '127.0.0.1' });
    },
  });
  const anon = viaClient({});
  const staff = viaClient(STAFF);
  const s = (rows) => rows.map((p) => p.slug).sort();
  out.clientFeatured = s(await anon.products.list({ featured: true }));
  out.clientNotFeatured = s(await anon.products.list({ featured: false }));
  out.clientSale = s(await anon.products.list({ on_sale: true }));
  out.clientStaffAll = s(await staff.products.list({ all: true }));
  out.clientAnonAll = s(await anon.products.list({ all: true }));
  out.clientPage = (await anon.products.page({ featured: true })).total;

  console.log(`__RESULT__${JSON.stringify(out)}`);
  process.exit(0);
}

/* --------------------------------------------------------------- parent --- */
let pass = 0;
let fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ---- 1. queryFlag ------------------------------------------------------- */
{
  const { queryFlag } = await loadTs('src/lib/http/query-flags.ts', 'query-flags-pure');
  const f = (qs, name = 'x') => queryFlag(new URLSearchParams(qs), name);
  check('`1` is true', f('x=1') === true);
  check('`true` is true', f('x=true') === true);
  check('absent is false', f('') === false && f('y=1') === false);
  check('`0` is false', f('x=0') === false);
  check('`false` is false', f('x=false') === false);
  check('empty (`?x=` and bare `?x`) is false', f('x=') === false && f('x') === false);
  check('other spellings are false, never a guess: yes, on, TRUE, True, 2, " 1"',
    ['yes', 'on', 'TRUE', 'True', '2', ' 1', '1 '].every((v) => queryFlag(new URLSearchParams([['x', v]]), 'x') === false));
  check('the FIRST value of a repeated flag decides', f('x=1&x=0') === true && f('x=0&x=1') === false);
  check('names are exact', f('X=1') === false && f('featured=1', 'featured') === true);
}

/* ---- 2. no route reads a flag on its own --------------------------------- */
{
  // List-free: every file under src/pages/api, not a named set of routes.
  const files = [];
  const walk = async (dir) => {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (/\.(ts|js|mjs)$/.test(e.name)) files.push(p);
    }
  };
  await walk(path.join(ROOT, 'src/pages/api'));
  // `.get('x') === 'true'`, `.get(name) !== '1'`, a local `isTrue` helper.
  const own = /\.get\([^)]*\)\s*[!=]==?\s*['"](true|1)['"]|\bisTrue\s*=/;
  const offenders = [];
  for (const file of files) {
    const text = await fs.readFile(file, 'utf8');
    text.split('\n').forEach((line, i) => {
      if (own.test(line)) offenders.push(`${path.relative(ROOT, file)}:${i + 1}: ${line.trim()}`);
    });
  }
  check(`no API route compares a query value to 'true' / '1' itself (use queryFlag)\n  ${offenders.join('\n  ')}`,
    files.length > 50 && offenders.length === 0);

  const route = await fs.readFile(path.join(ROOT, 'src/pages/api/products/index.ts'), 'utf8');
  check('the product route reads featured and on_sale through queryFlag',
    ['featured', 'on_sale'].every((n) => route.includes(`queryFlag(q, '${n}')`)));
  // `all` is a staff gate as well as a flag, so the list route asks the same
  // helper the single-product route does (#154). That helper must itself read
  // the flag through queryFlag, never with its own `=== 'true'`.
  check('the product route reads all through includesUnpublishedProducts (or queryFlag)',
    route.includes('includesUnpublishedProducts(locals.user, q)') || route.includes(`queryFlag(q, 'all')`));
  const auth = await fs.readFile(path.join(ROOT, 'src/lib/auth.ts'), 'utf8');
  const helper = auth.slice(auth.indexOf('export function includesUnpublishedProducts('));
  const body = helper.slice(0, helper.indexOf('\n}\n') + 3);
  check('includesUnpublishedProducts reads all through queryFlag, with no comparison of its own',
    body.length > 40 && body.includes(`queryFlag(params, 'all')`)
      && !/[!=]==?\s*['"](true|1)['"]/.test(body.replace(/\/\/.*$/gm, '')));
}

/* ---- 3. the route and the typed client, on every driver ------------------ */
const here = path.dirname(fileURLToPath(import.meta.url));
const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'astrobaas-query-flags-'));
const DRIVERS = [
  { name: 'lowdb', env: (d) => ({ DB_PATH: path.join(d, 'db.json') }) },
  { name: 'libsql', env: (d) => ({ DATABASE_URL: `file:${path.join(d, 'db.sqlite')}` }) },
  { name: 'relational', env: (d) => ({ DATABASE_URL: `file:${path.join(d, 'db.sqlite')}`, DATABASE_DRIVER: 'relational' }) },
];

const ALL_ACTIVE = ['feat', 'plain', 'sale'];
const WITH_DRAFT = ['draft', 'feat', 'plain', 'sale'];

for (const driver of DRIVERS) {
  const dir = path.join(tmpRoot, driver.name);
  await fs.mkdir(path.join(dir, 'uploads'), { recursive: true });
  const env = { ...process.env, QUERY_FLAGS_CHILD: '1', NODE_ENV: 'test', UPLOADS_DIR: path.join(dir, 'uploads') };
  delete env.DATABASE_URL;
  delete env.DATABASE_DRIVER;
  delete env.DB_PATH;
  const run = spawnSync(process.execPath, [path.join(here, 'query-flags.test.mjs')], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, env: { ...env, ...driver.env(dir) },
  });
  const t = (n, c) => check(`[${driver.name}] ${n}`, c);
  const line = (run.stdout || '').split('\n').find((l) => l.startsWith('__RESULT__'));
  if (!line) { t(`the child produced a result\n${(run.stderr || '').slice(-900)}`, false); continue; }
  const r = JSON.parse(line.slice('__RESULT__'.length));
  const slugs = (k) => r[k]?.slugs;

  t('fixture: no flag lists the three active products', same(slugs('absent'), ALL_ACTIVE));

  // featured
  t('featured=1 filters (what the typed client sends)', same(slugs('featured=1'), ['feat']));
  t('featured=true filters', same(slugs('featured=true'), ['feat']));
  for (const v of ['0', 'false', '', 'yes', 'TRUE']) {
    t(`featured=${v || '(empty)'} applies no filter`, same(slugs(`featured=${v}`), ALL_ACTIVE));
  }

  // on_sale
  t('on_sale=1 filters', same(slugs('on_sale=1'), ['sale']));
  t('on_sale=true filters', same(slugs('on_sale=true'), ['sale']));
  for (const v of ['0', 'false', '']) {
    t(`on_sale=${v || '(empty)'} applies no filter`, same(slugs(`on_sale=${v}`), ALL_ACTIVE));
  }
  t('featured=1&on_sale=1 is both filters (nothing here is both)', same(slugs('featuredAndSale'), []));

  // all (staff only)
  t('staff all=1 includes the draft', same(slugs('staff all=1'), WITH_DRAFT));
  t('staff all=true includes the draft', same(slugs('staff all=true'), WITH_DRAFT));
  for (const v of ['0', 'false', '', 'yes']) {
    t(`staff all=${v || '(empty)'} does not`, same(slugs(`staff all=${v}`), ALL_ACTIVE));
  }
  t('staff with no `all` does not', same(slugs('staffAbsent'), ALL_ACTIVE));
  t('anonymous all=1 and all=true never show the draft',
    same(slugs('anonAll1'), ALL_ACTIVE) && same(slugs('anonAllTrue'), ALL_ACTIVE));
  t('staff all=1&featured=1 is the featured rows INCLUDING the draft', same(slugs('staffAllFeatured'), ['draft', 'feat']));

  // The typed client end to end.
  t('the client sends a true boolean as `1`', (r.wire || []).some((q) => /[?&]featured=1(&|$)/.test(q)));
  t('client products.list({ featured: true }) returns only the featured product', same(r.clientFeatured, ['feat']));
  t('client products.list({ featured: false }) is unfiltered', same(r.clientNotFeatured, ALL_ACTIVE));
  t('client products.list({ on_sale: true }) returns only the sale product', same(r.clientSale, ['sale']));
  t('client products.list({ all: true }) as staff includes the draft', same(r.clientStaffAll, WITH_DRAFT));
  t('client products.list({ all: true }) anonymously does not', same(r.clientAnonAll, ALL_ACTIVE));
  t('client products.page({ featured: true }) totals the filtered set', r.clientPage === 1);
}

await fs.rm(tmpRoot, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
