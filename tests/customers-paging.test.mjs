#!/usr/bin/env node
/**
 * `GET /api/customers` pages like `GET /api/orders`.
 *
 * ## The bug
 *
 * The typed client's `customers.list()` and `customers.page()` send `limit`
 * and `offset`, and the route ignored both: it answered every customer with no
 * `meta`, so `page({ limit: 10 })` came back as one "page" holding the whole
 * list, `hasMore: false`, and an offset walk returned the first rows again.
 *
 * ## What it must do now
 *
 * The same parser, defaults (50), ceiling (200) and `meta` shape as the orders
 * route — asserted by calling BOTH routes and comparing, so the two cannot
 * drift apart silently. `?search=` filters before paging, so `meta.total` is
 * the size of the filtered list.
 *
 * The route handlers are called for real against all three drivers, and the
 * typed client is driven through a fetch that dispatches into the handler, so
 * the client's own query building is part of what is tested.
 *
 * Run with:  node tests/customers-paging.test.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTs, ROOT } from './lib/load.mjs';

const N = 120;

/* ---------------------------------------------------------------- child --- */
if (process.env.CUSTOMERS_PAGING_CHILD) {
  // ONE bundle so the routes and the test share a single LocalDB. Absolute
  // specifiers: a relative one would resolve through a symlinked
  // node_modules into another checkout.
  const entryDir = path.join(ROOT, 'node_modules', '.cache');
  await fs.mkdir(entryDir, { recursive: true });
  const entry = path.join(entryDir, `customers-paging-entry-${process.pid}.ts`);
  const abs = (rel) => JSON.stringify(path.join(ROOT, rel));
  await fs.writeFile(entry, [
    `export { LocalDB } from ${abs('src/lib/localdb.ts')};`,
    `export { GET as customersGET } from ${abs('src/pages/api/customers/index.ts')};`,
    `export { GET as ordersGET } from ${abs('src/pages/api/orders/index.ts')};`,
    `export { createClient } from ${abs('src/client/index.ts')};`,
  ].join('\n'));
  let M;
  try {
    M = await loadTs(path.relative(ROOT, entry), 'customers-paging');
  } finally {
    await fs.rm(entry, { force: true });
  }
  const { LocalDB } = M;
  await LocalDB.init();

  const staff = { id: 'u-admin', role: 'admin', email: 'admin@example.com' };
  const call = async (GET, pathname, user = staff) => {
    const url = new URL(`http://cms.test${pathname}`);
    const res = await GET({ url, params: {}, request: new Request(url), locals: { user, ip: '127.0.0.1' } });
    const body = await res.json().catch(() => null);
    return { status: res.status, data: body?.data, meta: body?.meta };
  };

  // Distinct created_at, so "newest first" has one right answer.
  for (let i = 0; i < N; i++) {
    await LocalDB.createCustomer({ email: `c${String(i).padStart(3, '0')}@example.com`, name: i % 10 === 0 ? `Ανδρέας ${i}` : `Person ${i}` });
    await new Promise((r) => setTimeout(r, 2));
  }

  const out = {};
  const summarise = (r) => ({ status: r.status, emails: (r.data ?? []).map((c) => c.email), meta: r.meta ?? null });
  out.unpaged = summarise(await call(M.customersGET, '/api/customers'));
  out.limited = summarise(await call(M.customersGET, '/api/customers?limit=10&offset=20'));
  out.last = summarise(await call(M.customersGET, '/api/customers?limit=10&offset=115'));
  out.tooBig = summarise(await call(M.customersGET, '/api/customers?limit=5000'));
  out.junk = summarise(await call(M.customersGET, '/api/customers?limit=abc&offset=-4'));
  out.search = summarise(await call(M.customersGET, `/api/customers?search=${encodeURIComponent('ΑΝΔΡΕΑΣ')}&limit=5`));
  out.anon = (await call(M.customersGET, '/api/customers', null)).status;
  out.ordersMeta = (await call(M.ordersGET, '/api/orders?limit=10&offset=20')).meta ?? null;
  out.ordersMetaDefault = (await call(M.ordersGET, '/api/orders')).meta ?? null;
  out.limitedForOrdersCompare = (await call(M.customersGET, '/api/customers?limit=10&offset=20')).meta ?? null;

  // Walk every page the way a client would.
  const walked = [];
  for (let offset = 0; offset < 1000; offset += 50) {
    const r = await call(M.customersGET, `/api/customers?limit=50&offset=${offset}`);
    walked.push(...(r.data ?? []).map((c) => c.email));
    if (!r.meta?.hasMore) break;
  }
  out.walked = walked;

  // The typed client, through a fetch that dispatches into the real handler.
  const sent = [];
  const fetchIntoRoute = async (input, init = {}) => {
    const url = new URL(String(input));
    sent.push(url.pathname + url.search);
    const request = new Request(url, init);
    return M.customersGET({ url, params: {}, request, locals: { user: staff, ip: '127.0.0.1' } });
  };
  const client = M.createClient('http://cms.test', { apiKey: 'abk_test', fetch: fetchIntoRoute });
  const page = await client.customers.page({ limit: 10, offset: 10 });
  const list = await client.customers.list({ limit: 7 });
  out.client = {
    sent,
    page: { n: page.items.length, total: page.total, hasMore: page.hasMore, limit: page.limit, offset: page.offset, page: page.page, first: page.items[0]?.email },
    listN: list.length,
  };

  console.log('__RESULT__' + JSON.stringify(out));
  process.exit(0);
}

/* --------------------------------------------------------------- parent --- */
let pass = 0;
let fail = 0;
const check = (n, c, detail = '') => {
  if (c) pass++;
  else { fail++; console.error(`✗ ${n}${detail ? `\n    ${detail}` : ''}`); }
};

const here = path.dirname(fileURLToPath(import.meta.url));
const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'astrobaas-customers-paging-'));
const DRIVERS = [
  { name: 'lowdb', env: (d) => ({ DB_PATH: path.join(d, 'db.json') }) },
  { name: 'libsql', env: (d) => ({ DATABASE_URL: `file:${path.join(d, 'db.sqlite')}` }) },
  { name: 'relational', env: (d) => ({ DATABASE_URL: `file:${path.join(d, 'db.sqlite')}`, DATABASE_DRIVER: 'relational' }) },
];

// Newest first: the last one created is c119.
const email = (i) => `c${String(i).padStart(3, '0')}@example.com`;
const newestFirst = Array.from({ length: N }, (_, k) => email(N - 1 - k));
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const results = {};
for (const driver of DRIVERS) {
  const dir = path.join(tmpRoot, driver.name);
  await fs.mkdir(path.join(dir, 'uploads'), { recursive: true });
  const env = { ...process.env, CUSTOMERS_PAGING_CHILD: '1', NODE_ENV: 'test', UPLOADS_DIR: path.join(dir, 'uploads') };
  // The child must pick its driver from THIS row only.
  delete env.DATABASE_URL; delete env.DATABASE_DRIVER; delete env.DB_PATH;
  const run = spawnSync(process.execPath, [path.join(here, 'customers-paging.test.mjs')], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 300_000,
    env: { ...env, ...driver.env(dir) },
  });
  const line = (run.stdout || '').split('\n').find((l) => l.startsWith('__RESULT__'));
  if (!line) {
    fail++;
    console.error(`✗ [${driver.name}] child produced no result\n${(run.stderr || '').slice(-1500)}`);
    continue;
  }
  const r = JSON.parse(line.slice('__RESULT__'.length));
  results[driver.name] = r;
  const t = (n, c, d) => check(`[${driver.name}] ${n}`, c, d);

  // THE BUG: no limit returned all N with no meta.
  t('no limit answers the default page of 50, not everyone', r.unpaged.status === 200 && r.unpaged.emails.length === 50,
    `got ${r.unpaged.emails.length}`);
  t('...newest first', eq(r.unpaged.emails, newestFirst.slice(0, 50)));
  t('...with the orders meta: total, count, limit, offset, page, hasMore',
    eq(r.unpaged.meta, { total: N, count: 50, limit: 50, offset: 0, page: 1, hasMore: true }), JSON.stringify(r.unpaged.meta));
  t('?limit=10&offset=20 is rows 20–29', eq(r.limited.emails, newestFirst.slice(20, 30)), JSON.stringify(r.limited.emails.slice(0, 3)));
  t('...page 3, more to come', r.limited.meta?.page === 3 && r.limited.meta?.hasMore === true && r.limited.meta?.total === N);
  t('the last page is short and says there is no more',
    eq(r.last.emails, newestFirst.slice(115)) && r.last.meta?.hasMore === false && r.last.meta?.count === 5);
  t('an oversized limit is clamped to 200, like orders', r.tooBig.meta?.limit === 200 && r.tooBig.emails.length === N);
  t('nonsense paging reads as the defaults, not as an empty page',
    r.junk.emails.length === 50 && r.junk.meta?.limit === 50 && r.junk.meta?.offset === 0);
  // Search filters BEFORE paging: total is the filtered count.
  t('?search= pages the filtered list (accent- and case-folded), total is the match count',
    r.search.status === 200 && r.search.emails.length === 5 && r.search.meta?.total === N / 10
      && r.search.meta?.hasMore === true, JSON.stringify(r.search.meta));
  t('anonymous is still refused', r.anon === 401 || r.anon === 403, String(r.anon));
  t('an offset walk reaches every customer exactly once, in order', eq(r.walked, newestFirst),
    `walked ${r.walked.length}, distinct ${new Set(r.walked).size}`);
  // Same shape as the sibling route, compared rather than retyped.
  t('meta has exactly the keys GET /api/orders publishes',
    eq(Object.keys(r.limitedForOrdersCompare ?? {}).sort(), Object.keys(r.ordersMeta ?? {}).sort())
      && Object.keys(r.ordersMeta ?? {}).length > 0, `${JSON.stringify(r.limitedForOrdersCompare)} vs ${JSON.stringify(r.ordersMeta)}`);
  t('...and the same default page size as orders', r.unpaged.meta?.limit === r.ordersMetaDefault?.limit);
  // The typed client.
  t('client.customers.page sends limit and offset', r.client.sent.includes('/api/customers?limit=10&offset=10'), JSON.stringify(r.client.sent));
  t('client.customers.page gets a real page with total and hasMore',
    eq(r.client.page, { n: 10, total: N, hasMore: true, limit: 10, offset: 10, page: 2, first: newestFirst[10] }), JSON.stringify(r.client.page));
  t('client.customers.list honours limit', r.client.listN === 7);
}

// The three drivers must give the same answers.
const names = Object.keys(results);
if (names.length === DRIVERS.length) {
  const norm = (r) => JSON.stringify({ ...r, client: { ...r.client } });
  check('lowdb, libsql and relational agree on every answer',
    names.every((n) => norm(results[n]) === norm(results[names[0]])));
}

await fs.rm(tmpRoot, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
