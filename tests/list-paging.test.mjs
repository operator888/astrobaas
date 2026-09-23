#!/usr/bin/env node
/**
 * Unpaged list reads are capped (S5.2): `GET /api/posts` and
 * `GET /api/content/{type}` with no `limit`.
 *
 * ## The bug
 *
 * No `limit` meant "everything": one anonymous request with no query string
 * rendered, sanitised and serialised the whole blog, or resolved the whole
 * comments collection, and the next request did it again.
 *
 * ## What must NOT change
 *
 * The live storefronts may call both endpoints with no limit. Below the ceiling
 * the response must be what it always was — every row, `limit: null`,
 * `hasMore: false` — and an EXPLICIT limit keeps its old ceiling of 200.
 *
 * The route handlers are called for real, against all three drivers, because
 * the posts route now always hands the storage layer a limit and the
 * relational driver pages in SQL.
 *
 * Run with:  node tests/list-paging.test.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTs, ROOT } from './lib/load.mjs';

/* ---------------------------------------------------------------- child --- */
if (process.env.PAGING_TEST_CHILD) {
  // ONE bundle for the routes, the registry and the database, so they share a
  // module graph — two bundles would be two LocalDBs and two registries.
  const entryDir = path.join(ROOT, 'node_modules', '.cache');
  await fs.mkdir(entryDir, { recursive: true });
  const entry = path.join(entryDir, `paging-entry-${process.pid}.ts`);
  const abs = (rel) => JSON.stringify(path.join(ROOT, rel));
  await fs.writeFile(entry, [
    `export { LocalDB } from ${abs('src/lib/localdb.ts')};`,
    `export { GET as postsGET } from ${abs('src/pages/api/posts/index.ts')};`,
    `export { GET as contentGET } from ${abs('src/pages/api/content/[type]/index.ts')};`,
    `export { GET as searchGET } from ${abs('src/pages/api/search.ts')};`,
    `export { registerContentType } from ${abs('src/core/content-types.ts')};`,
    `export { MAX_UNPAGED_ITEMS, MAX_PAGE_SIZE } from ${abs('src/lib/list-paging.ts')};`,
  ].join('\n'));
  let M;
  try {
    M = await loadTs(path.relative(ROOT, entry), 'paging');
  } finally {
    await fs.rm(entry, { force: true });
  }
  const { LocalDB } = M;
  await LocalDB.init();

  const call = async (GET, pathname, params = {}) => {
    const url = new URL(`http://cms.test${pathname}`);
    const res = await GET({
      url, params, request: new Request(url), locals: { user: null, ip: '127.0.0.1' },
    });
    const body = await res.json();
    return { status: res.status, n: body.data?.length ?? -1, meta: body.meta ?? {} };
  };

  // A fresh database is seeded with sample posts; count them rather than
  // assume, so the totals below are exact.
  const seeded = (await call(M.postsGET, '/api/posts?limit=1')).meta.total ?? 0;

  const ADDED = M.MAX_UNPAGED_ITEMS + 5;
  for (let i = 0; i < ADDED; i += 1) {
    await LocalDB.createPost({
      title: `P${i}`, slug: `p-${i}`, content: '', status: 'published', tags: [],
      author_id: 'nobody', locale: 'en', views: 0,
    });
    await LocalDB.createCustomEntity('paging-note', { body: `n${i}` });
  }
  const N = seeded + ADDED;

  M.registerContentType({
    name: 'paging-note', label: 'Note', visibility: 'public',
    fields: [{ name: 'body', rule: { type: 'string', max: 50, optional: true } }],
  });

  const posts = {
    unpaged: await call(M.postsGET, '/api/posts'),
    second: await call(M.postsGET, `/api/posts?offset=${M.MAX_UNPAGED_ITEMS}`),
    limited: await call(M.postsGET, '/api/posts?limit=5'),
    tooBig: await call(M.postsGET, '/api/posts?limit=100000'),
    lastPage: await call(M.postsGET, `/api/posts?limit=200&page=6`),
  };
  const content = {
    unpaged: await call(M.contentGET, '/api/content/paging-note', { type: 'paging-note' }),
    second: await call(M.contentGET, `/api/content/paging-note?offset=${M.MAX_UNPAGED_ITEMS}`, { type: 'paging-note' }),
    limited: await call(M.contentGET, '/api/content/paging-note?limit=5', { type: 'paging-note' }),
    tooBig: await call(M.contentGET, '/api/content/paging-note?limit=100000', { type: 'paging-note' }),
  };
  // S5.1 at the route: the query it echoes, and hands to the plugin hook, is
  // the CLIPPED one. The scorer's own bound is tested in search-rank.test.mjs.
  const hugeQ = Array.from({ length: 3000 }, (_, i) => `p${i}`).join(' ');
  const searchUrl = new URL(`http://cms.test/api/search?q=${encodeURIComponent(hugeQ)}`);
  const searchRes = await M.searchGET({
    url: searchUrl, params: {}, request: new Request(searchUrl), locals: { user: null },
  });
  const searchBody = await searchRes.json();
  const search = {
    status: searchRes.status,
    qLength: typeof searchBody?.meta?.q === 'string' ? searchBody.meta.q.length : -1,
    cacheControl: searchRes.headers.get('cache-control'),
    etag: searchRes.headers.get('etag'),
  };

  console.log('__RESULT__' + JSON.stringify({
    search,
    posts: { ...posts, N }, content: { ...content, N: ADDED },
    cap: M.MAX_UNPAGED_ITEMS, max: M.MAX_PAGE_SIZE,
  }));
  process.exit(0);
}

/* --------------------------------------------------------------- parent --- */
let pass = 0;
let fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };

// Pure helper first: the "below the ceiling nothing changes" half.
{
  const P = await loadTs('src/lib/list-paging.ts');
  const sp = (q) => new URLSearchParams(q);
  const none = P.parseListPaging(sp(''));
  check('no limit: limit is undefined, take is the ceiling',
    none.limit === undefined && none.take === P.MAX_UNPAGED_ITEMS && none.offset === 0);
  check('the ceiling is 1000', P.MAX_UNPAGED_ITEMS === 1000);
  const small = Array.from({ length: 7 }, (_, i) => i);
  const m = P.pagingMeta(none, P.takePage(small, none).length, small.length);
  check('below the ceiling the envelope is exactly the old one',
    JSON.stringify(m) === JSON.stringify({ total: 7, count: 7, limit: null, offset: 0, page: 1, hasMore: false }));
  const lim = P.parseListPaging(sp('limit=2&page=3'));
  check('?page= still computes the offset from the limit', lim.offset === 4 && lim.limit === 2);
  check('an explicit limit keeps its 200 ceiling', P.parseListPaging(sp('limit=999')).limit === 200);
  check('limit=0 is still a zero-row page', P.parseListPaging(sp('limit=0')).take === 0);
  check('nonsense offset reads as 0', P.parseListPaging(sp('offset=abc')).offset === 0);
  check('negative offset reads as 0', P.parseListPaging(sp('offset=-4')).offset === 0);
  const big = Array.from({ length: 1003 }, (_, i) => i);
  const page = P.takePage(big, none);
  check('takePage stops at the ceiling', page.length === 1000);
  check('...and hasMore says so', P.pagingMeta(none, page.length, big.length).hasMore === true);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'astrobaas-paging-'));
const DRIVERS = [
  { name: 'lowdb', env: (d) => ({ DB_PATH: path.join(d, 'db.json') }) },
  { name: 'libsql', env: (d) => ({ DATABASE_URL: `file:${path.join(d, 'db.sqlite')}` }) },
  { name: 'relational', env: (d) => ({ DATABASE_URL: `file:${path.join(d, 'db.sqlite')}`, DATABASE_DRIVER: 'relational' }) },
];

for (const driver of DRIVERS) {
  const dir = path.join(tmpRoot, driver.name);
  await fs.mkdir(path.join(dir, 'uploads'), { recursive: true });
  const run = spawnSync(process.execPath, [path.join(here, 'list-paging.test.mjs')], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 300_000,
    env: {
      ...process.env, PAGING_TEST_CHILD: '1', NODE_ENV: 'test',
      UPLOADS_DIR: path.join(dir, 'uploads'), ...driver.env(dir),
    },
  });
  const line = (run.stdout || '').split('\n').find((l) => l.startsWith('__RESULT__'));
  if (!line) {
    fail++;
    console.error(`✗ [${driver.name}] child produced no result\n${(run.stderr || '').slice(-900)}`);
    continue;
  }
  const r = JSON.parse(line.slice('__RESULT__'.length));
  const t = (n, c) => check(`[${driver.name}] ${n}`, c);

  for (const [label, x] of [['posts', r.posts], ['content', r.content]]) {
    // THE BUG: no limit used to return all N.
    t(`${label}: no limit returns at most the ceiling`, x.unpaged.status === 200 && x.unpaged.n === r.cap);
    t(`${label}: ...and says there is more`, x.unpaged.meta.hasMore === true);
    t(`${label}: ...with the true total`, x.unpaged.meta.total === x.N);
    t(`${label}: ...and limit still null, as before`, x.unpaged.meta.limit === null);
    // The way to the rest is the one that always existed.
    t(`${label}: ?offset= without a limit reaches the rest`, x.second.n === x.N - r.cap);
    t(`${label}: ...and the last slice has no more`, x.second.meta.hasMore === false);
    // An explicit limit is untouched.
    t(`${label}: ?limit=5 is a page of 5`, x.limited.n === 5 && x.limited.meta.limit === 5
      && x.limited.meta.hasMore === true);
    t(`${label}: an oversized limit is still clamped to ${r.max}`, x.tooBig.n === r.max
      && x.tooBig.meta.limit === r.max);
  }
  t('search: a 3000-word query answers 200', r.search.status === 200);
  t('search: THE BUG — meta.q echoes only the clipped 200 characters', r.search.qLength > 0 && r.search.qLength <= 200);
  t('search: anonymous results are shareable with an ETag',
    /s-maxage=/.test(r.search.cacheControl ?? '') && /^W\//.test(r.search.etag ?? ''));
  t('posts: ?page= on the last page', r.posts.lastPage.n === r.posts.N - 1000
    && r.posts.lastPage.meta.page === 6 && r.posts.lastPage.meta.hasMore === false);
}

await fs.rm(tmpRoot, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
