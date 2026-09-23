#!/usr/bin/env node
/**
 * Shared-cache headers for the public read API (src/lib/http-cache.ts, S5.5).
 *
 * What would be expensive to get wrong, in order:
 *
 *   1. A STAFF response in a shared cache. The product routes return drafts
 *      and staff-only fields to a signed-in caller; one of those stored under a
 *      public key is the admin's catalogue served to the next stranger.
 *   2. An error cached. A 500 served for thirty seconds to everyone is an
 *      outage the operator did not have.
 *   3. A validator that never matches (so nothing is saved) or always matches
 *      (so an edit is never seen).
 *
 * Plus the wiring: every route the issue names must actually call the helper.
 *
 * Run with:  node tests/http-cache.test.mjs
 */
import { loadTs, readRepo } from './lib/load.mjs';

const H = await loadTs('src/lib/http-cache.ts');

let pass = 0;
let fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', ...headers },
});
const req = (headers = {}, method = 'GET') => new Request('http://cms.test/api/products', { method, headers });
const ANON = { user: null };
const STAFF = { user: { id: 'u1', role: 'admin' } };
const KEYED = { user: { id: 'apikey:k1', role: 'viewer' } };
const ENV = {}; // defaults

/* ---------------------------------------------------------------- policy --- */
{
  const p = H.publicCachePolicy({});
  check('default s-maxage is 30', p.sMaxAge === 30);
  check('default stale-while-revalidate is 300', p.staleWhileRevalidate === 300);
  check('the env var sets s-maxage', H.publicCachePolicy({ PUBLIC_API_CACHE_SECONDS: '120' }).sMaxAge === 120);
  check('0 is a decision, kept', H.publicCachePolicy({ PUBLIC_API_CACHE_SECONDS: '0' }).sMaxAge === 0);
  check('nonsense falls back to the default rather than to 0 or a day',
    H.publicCachePolicy({ PUBLIC_API_CACHE_SECONDS: 'soon' }).sMaxAge === 30
    && H.publicCachePolicy({ PUBLIC_API_CACHE_SECONDS: '-5' }).sMaxAge === 30);
  check('a huge value is clamped to a day',
    H.publicCachePolicy({ PUBLIC_API_CACHE_SECONDS: '99999999' }).sMaxAge === 86400);
  check('SWR is tunable', H.publicCachePolicy({ PUBLIC_API_CACHE_SWR_SECONDS: '10' }).staleWhileRevalidate === 10);

  check('anonymous Cache-Control names SHARED caches only',
    H.anonymousCacheControl(p) === 'public, max-age=0, s-maxage=30, stale-while-revalidate=300');
  check('s-maxage 0 turns shared caching OFF',
    H.anonymousCacheControl({ sMaxAge: 0, staleWhileRevalidate: 300 }) === 'private, no-cache');
  check('SWR 0 is omitted',
    H.anonymousCacheControl({ sMaxAge: 30, staleWhileRevalidate: 0 }) === 'public, max-age=0, s-maxage=30');
}

/* ------------------------------------------------------------ validators --- */
{
  const a = H.weakEtag('{"a":1}');
  check('the tag is weak', a.startsWith('W/"') && a.endsWith('"'));
  check('the same body, the same tag', a === H.weakEtag('{"a":1}'));
  check('a different body, a different tag', a !== H.weakEtag('{"a":2}'));
  check('bytes and string agree', a === H.weakEtag(new TextEncoder().encode('{"a":1}')));

  check('weak comparison ignores W/ on either side',
    H.etagMatches(a.slice(2), a) && H.etagMatches(a, a.slice(2)));
  check('a list matches if any member does', H.etagMatches(`W/"nope", ${a}`, a));
  check('* matches', H.etagMatches('*', a));
  check('a stale tag does not match', !H.etagMatches('W/"stale"', a));
  check('no header does not match', !H.etagMatches(null, a) && !H.etagMatches('', a));

  check('Vary merges without duplicates, keeping order',
    H.mergeVary('Origin, cookie', ['Cookie', 'Authorization']) === 'Origin, cookie, Authorization');
  check('Vary * stays *', H.mergeVary('*', ['Cookie']) === '*');
  check('Vary from nothing', H.mergeVary(null, ['Cookie', 'Authorization']) === 'Cookie, Authorization');
}

/* ------------------------------------------------------------- anonymous --- */
{
  const body = { success: true, data: [{ id: 'p1', name: 'Frame' }] };
  const res = await H.withPublicCache(json(body), { request: req(), locals: ANON }, ENV);
  check('anonymous: 200 kept', res.status === 200);
  check('anonymous: shared-cache headers',
    res.headers.get('cache-control') === 'public, max-age=0, s-maxage=30, stale-while-revalidate=300');
  check('anonymous: Vary names Cookie and Authorization',
    /Cookie/.test(res.headers.get('vary') ?? '') && /Authorization/.test(res.headers.get('vary') ?? ''));
  const etag = res.headers.get('etag');
  check('anonymous: an ETag', !!etag && etag.startsWith('W/"'));
  const text = await res.text();
  check('anonymous: the body is untouched', text === JSON.stringify(body));
  check('anonymous: the content type survives', res.headers.get('content-type') === 'application/json');
  check('the tag is the tag OF THE BODY', etag === H.weakEtag(text));

  // Revalidation.
  const cond = await H.withPublicCache(json(body), {
    request: req({ 'If-None-Match': etag }), locals: ANON,
  }, ENV);
  check('If-None-Match that matches → 304', cond.status === 304);
  check('...with no body', (await cond.text()) === '');
  check('...repeating the validator and the policy',
    cond.headers.get('etag') === etag && /s-maxage=30/.test(cond.headers.get('cache-control') ?? '')
    && /Cookie/.test(cond.headers.get('vary') ?? ''));
  check('...and not the content type of a body it does not have', !cond.headers.get('content-type'));

  // An edit changes the answer.
  const edited = await H.withPublicCache(json({ ...body, data: [{ id: 'p1', name: 'Frame v2' }] }), {
    request: req({ 'If-None-Match': etag }), locals: ANON,
  }, ENV);
  check('a changed body under an old tag → 200 with the new body', edited.status === 200
    && (await edited.text()).includes('Frame v2'));

  // HEAD behaves like GET.
  const head = await H.withPublicCache(json(body), { request: req({}, 'HEAD'), locals: ANON }, ENV);
  check('HEAD gets the same caching headers', /s-maxage/.test(head.headers.get('cache-control') ?? ''));

  // Existing Vary survives.
  const withVary = await H.withPublicCache(json(body, 200, { Vary: 'Accept-Encoding' }), { request: req(), locals: ANON }, ENV);
  check('an existing Vary is merged, not replaced',
    /Accept-Encoding/.test(withVary.headers.get('vary') ?? '') && /Cookie/.test(withVary.headers.get('vary') ?? ''));

  // Caching switched off.
  const off = await H.withPublicCache(json(body), { request: req(), locals: ANON }, { PUBLIC_API_CACHE_SECONDS: '0' });
  check('PUBLIC_API_CACHE_SECONDS=0 → private, no-cache', off.headers.get('cache-control') === 'private, no-cache');
  check('...but the ETag still saves the body', !!off.headers.get('etag'));

  // No locals at all (a page route with no middleware in a test) is anonymous.
  const bare = await H.withPublicCache(json(body), { request: req() }, ENV);
  check('missing locals reads as anonymous', /public/.test(bare.headers.get('cache-control') ?? ''));
}

/* ---------------------------------------------------- staff and API keys --- */
for (const [label, locals] of [['staff', STAFF], ['API key', KEYED]]) {
  const res = await H.withPublicCache(json({ secret: 'draft' }), {
    request: req({ 'If-None-Match': '*' }), locals,
  }, ENV);
  check(`${label}: private, no-store`, res.headers.get('cache-control') === 'private, no-store');
  check(`${label}: never public`, !/public|s-maxage/.test(res.headers.get('cache-control') ?? ''));
  check(`${label}: no ETag a shared copy could also carry`, !res.headers.get('etag'));
  check(`${label}: If-None-Match: * does not short-circuit to 304`, res.status === 200);
  check(`${label}: Vary still set`, /Cookie/.test(res.headers.get('vary') ?? ''));
  check(`${label}: body intact`, (await res.text()).includes('draft'));
}

/* ------------------------------------------------------- what is skipped --- */
{
  for (const status of [404, 500, 502]) {
    const res = await H.withPublicCache(json({ error: 'x' }, status), { request: req(), locals: ANON }, ENV);
    check(`a ${status} is never given a cache policy`, !res.headers.get('cache-control') && !res.headers.get('etag'));
  }
  const post = await H.withPublicCache(json({ ok: 1 }), { request: req({}, 'POST'), locals: ANON }, ENV);
  check('a POST is untouched', !post.headers.get('cache-control'));
}

/* ----------------------------------------------------------------- wiring ---
 * Every route S5.5 names must call the helper on its success path, and pass
 * `locals` — a call without it would treat staff as anonymous. Checked in the
 * source because these routes need a database to run.
 */
{
  const ROUTES = [
    'src/pages/api/products/index.ts',
    'src/pages/api/products/[id].ts',
    'src/pages/api/brands/index.ts',
    'src/pages/api/product-categories/index.ts',
    'src/pages/api/search.ts',
    'src/pages/sitemap.xml.ts',
    'src/pages/rss.xml.ts',
  ];
  for (const rel of ROUTES) {
    const src = (await readRepo(rel)).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    check(`${rel} imports the helper`, /from '[./]+\/lib\/http-cache'/.test(src));
    const calls = src.match(/withPublicCache\([\s\S]*?\{\s*request,\s*locals\s*\}\s*,?\s*\)/g) ?? [];
    check(`${rel} passes { request, locals }`, calls.length >= 1);
    check(`${rel} destructures locals in GET`, /GET: APIRoute = async \(\{[^}]*\blocals\b[^}]*\}\)/.test(src));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
