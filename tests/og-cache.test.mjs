#!/usr/bin/env node
/**
 * The OG card is rendered once per picture, not once per request (S5.4).
 *
 * ## The bug
 *
 * `/og/{slug}.png` ran sharp on every request, and a query string defeats any
 * cache in front of it — `/og/x.png?1`, `?2`, … each reached sharp. A CPU
 * exhaustion attack that needed nothing but a published slug.
 *
 * ## What is asserted
 *
 *   - the cache itself: bounded by entries AND bytes, least-recently-used out
 *     first, one render per key under concurrency, failures not cached;
 *   - the route, for real, on a temporary database: a burst of requests (with
 *     and without query strings) renders ONCE; an edit to the title renders
 *     again; a draft card is never marked public; a revalidation gets a 304.
 *
 * Run with:  node tests/og-cache.test.mjs
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadTs, ROOT } from './lib/load.mjs';

let pass = 0;
let fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };

/* ------------------------------------------------------------ the cache --- */
{
  const C = await loadTs('src/lib/og-cache.ts');
  check('the default bound is 100 entries', C.OG_CACHE_MAX_ENTRIES === 100);

  const k1 = C.ogCacheKey('post', '<svg>a</svg>');
  check('the key keeps the slug readable', k1.startsWith('post:'));
  check('the same picture, the same key', k1 === C.ogCacheKey('post', '<svg>a</svg>'));
  check('a different picture, a different key', k1 !== C.ogCacheKey('post', '<svg>b</svg>'));
  check('a different slug, a different key', k1 !== C.ogCacheKey('other', '<svg>a</svg>'));

  const buf = (n, fill = 1) => Buffer.alloc(n, fill);

  // Entry bound + LRU order.
  {
    const cache = new C.RenderCache(3, 1024 * 1024);
    for (const k of ['a', 'b', 'c']) await cache.getOrRender(k, async () => buf(10));
    await cache.getOrRender('a', async () => buf(10)); // touch a
    await cache.getOrRender('d', async () => buf(10)); // evicts b (least recent)
    check('never more than maxEntries', cache.size === 3);
    check('the least recently USED goes first', !cache.has('b') && cache.has('a') && cache.has('c') && cache.has('d'));
    check('a hit does not render', cache.renders === 4);
  }

  // Byte bound.
  {
    const cache = new C.RenderCache(100, 100);
    await cache.getOrRender('x', async () => buf(60));
    await cache.getOrRender('y', async () => buf(60));
    check('never more than maxBytes', cache.totalBytes <= 100 && cache.size === 1 && cache.has('y'));
    const huge = await cache.getOrRender('z', async () => buf(500));
    check('a value bigger than the budget is served but not kept', huge.length === 500 && !cache.has('z'));
    check('...and does not evict what fits', cache.has('y'));
  }

  // One render per key at a time.
  {
    const cache = new C.RenderCache();
    let release;
    const gate = new Promise((r) => { release = r; });
    const slow = async () => { await gate; return buf(5); };
    const burst = Array.from({ length: 50 }, () => cache.getOrRender('k', slow));
    release();
    const results = await Promise.all(burst);
    check('fifty concurrent requests, ONE render', cache.renders === 1);
    check('...and all fifty get the picture', results.every((r) => r && r.length === 5));
  }

  // Failures are not remembered.
  {
    const cache = new C.RenderCache();
    const miss = await cache.getOrRender('n', async () => null);
    check('a null render is returned', miss === null);
    check('...and not cached', !cache.has('n'));
    let threw = false;
    try { await cache.getOrRender('t', async () => { throw new Error('sharp died'); }); }
    catch { threw = true; }
    check('a throwing render propagates', threw);
    const retry = await cache.getOrRender('t', async () => buf(3));
    check('...and the next request renders again', retry?.length === 3 && cache.has('t'));
  }
}

/* ------------------------------------------------------------ the route --- */
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astrobaas-og-'));
process.env.DB_PATH = path.join(dir, 'db.json');
process.env.UPLOADS_DIR = path.join(dir, 'uploads');
await fs.mkdir(process.env.UPLOADS_DIR, { recursive: true });

const entry = path.join(ROOT, 'node_modules', '.cache', `og-entry-${process.pid}.ts`);
await fs.mkdir(path.dirname(entry), { recursive: true });
const abs = (rel) => JSON.stringify(path.join(ROOT, rel));
await fs.writeFile(entry, [
  `export { LocalDB } from ${abs('src/lib/localdb.ts')};`,
  `export { GET } from ${abs('src/pages/og/[slug].png.ts')};`,
  `export { ogCache } from ${abs('src/lib/og-cache.ts')};`,
].join('\n'));
let M;
try {
  M = await loadTs(path.relative(ROOT, entry), 'og');
} finally {
  await fs.rm(entry, { force: true });
}
const { LocalDB, GET, ogCache } = M;
await LocalDB.init();

const author = await LocalDB.createUser({
  email: 'og@example.com', name: 'Ada Writer', role: 'author', status: 'active',
  password_hash: 'x', password_salt: 'x',
});
const pub = await LocalDB.createPost({
  title: 'A card worth caching', slug: 'og-cached', content: '', status: 'published',
  tags: [], author_id: author.id, locale: 'en', views: 0,
});
const draft = await LocalDB.createPost({
  title: 'Secret launch', slug: 'og-draft', content: '', status: 'draft',
  tags: [], author_id: author.id, locale: 'en', views: 0,
});

const og = (slug, { query = '', user = null, headers = {} } = {}) => GET({
  params: { slug },
  locals: { user, locale: 'en' },
  request: new Request(`http://cms.test/og/${slug}.png${query}`, { headers }),
});

{
  const first = await og('og-cached');
  const png = Buffer.from(await first.arrayBuffer());
  check('a published card renders as a PNG', first.status === 200
    && first.headers.get('content-type') === 'image/png' && png.subarray(1, 4).toString() === 'PNG');
  check('...with the day-long public Cache-Control kept', first.headers.get('cache-control') === 'public, max-age=86400');
  const etag = first.headers.get('etag');
  check('...and a validator', !!etag && etag.startsWith('W/"'));
  const rendersAfterFirst = ogCache.renders;

  // THE BUG: a burst, half of it with cache-busting query strings.
  const burst = await Promise.all(Array.from({ length: 30 }, (_, i) =>
    og('og-cached', { query: i % 2 ? `?v=${i}` : '' })));
  const bodies = await Promise.all(burst.map((r) => r.arrayBuffer()));
  check('thirty more requests, query strings included, render NOTHING new',
    ogCache.renders === rendersAfterFirst);
  check('...and every one gets the same bytes',
    bodies.every((b) => Buffer.from(b).equals(png)));

  const cond = await og('og-cached', { headers: { 'If-None-Match': etag } });
  check('a matching If-None-Match is a bodiless 304', cond.status === 304 && (await cond.text()) === '');

  // An edit is a new picture.
  await LocalDB.updatePost(pub.id, { title: 'A card that changed' });
  const edited = await og('og-cached');
  const editedPng = Buffer.from(await edited.arrayBuffer());
  check('an edited title renders again', ogCache.renders === rendersAfterFirst + 1);
  check('...into different bytes', !editedPng.equals(png));
  check('...under a different validator', edited.headers.get('etag') !== etag);
  const staleCond = await og('og-cached', { headers: { 'If-None-Match': etag } });
  check('the old validator no longer matches', staleCond.status === 200);
  await staleCond.arrayBuffer();

  // An author rename changes the card too — a key of slug + updated_at would miss it.
  const before = ogCache.renders;
  await LocalDB.updateUser(author.id, { name: 'Ada Renamed' });
  await (await og('og-cached')).arrayBuffer();
  check('renaming the author renders again (the key is the picture, not the post)',
    ogCache.renders === before + 1);
}

{
  // Drafts: invisible to strangers, private to their author.
  const anon = await og('og-draft');
  check('a draft is 404 to an anonymous caller', anon.status === 404);
  const mine = await og('og-draft', { user: { id: author.id, role: 'author' } });
  await mine.arrayBuffer();
  check('its author can see the card', mine.status === 200);
  check('...but it is NEVER marked shareable', mine.headers.get('cache-control') === 'private, no-store');
  const mineCond = await og('og-draft', {
    user: { id: author.id, role: 'author' }, headers: { 'If-None-Match': '*' },
  });
  check('...and never short-circuits to a 304', mineCond.status === 200);
  await mineCond.arrayBuffer();
  check('an unknown slug is 404', (await og('no-such-post')).status === 404);
}

await fs.rm(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
