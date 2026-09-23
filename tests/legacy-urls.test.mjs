#!/usr/bin/env node
/**
 * Legacy-URL recovery: the rules an operator's redirect map lives by.
 *
 * The expensive mistakes this guards against, in order of how much they cost:
 *
 *   1. A 410 quietly becoming a 301. "Gone" is how a shop tells Google to DROP
 *      an address a hijacked feed invented. Turned into a redirect to the home
 *      page it becomes a soft 404 — the address stays indexed, keeps eating
 *      crawl budget, and the shop keeps paying for clicks that land nowhere.
 *   2. A rule that can capture /admin or /api. A redirect map is data an editor
 *      can write; if it can point /admin somewhere else, it is a way to lock
 *      the shop out of its own CMS, or to hand a session cookie to a stranger.
 *   3. Greek that does not match its own Latin slug. Half the indexed URLs on
 *      these shops are percent-encoded Greek and half are transliterated, and
 *      a recovery page that only handles one of them helps half the shoppers.
 *
 * Run with:  node tests/legacy-urls.test.mjs
 */
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cacheDir = path.join(here, '..', 'node_modules', '.cache');
await fs.mkdir(cacheDir, { recursive: true });

async function load(rel, tag) {
  const out = path.join(cacheDir, `astrobaas-${tag}-${process.pid}.mjs`);
  await build({
    entryPoints: [path.join(here, '..', rel)],
    bundle: true, format: 'esm', platform: 'node', packages: 'external',
    outfile: out, logLevel: 'silent',
  });
  const mod = await import(pathToFileURL(out).href);
  await fs.rm(out, { force: true });
  return mod;
}

const R = await load('src/lib/legacy/redirects.ts', 'redirects');
const L = await load('src/lib/legacy/not-found-log.ts', 'nflog');
const M = await load('src/lib/legacy/recovery-match.ts', 'recovery');

let pass = 0, fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };

const rule = (over = {}) => ({
  id: over.id ?? 'r1',
  match: '/old', target: '/new', status: 301, enabled: true, hits: 0,
  created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
  ...over,
});
const resolve = (rules, p, search = '') => R.resolveRedirect(R.buildIndex(rules), p, search);

/* ------------------------------------------------------------------ *
 * 1. An entry matches, and redirects with the status it was given
 * ------------------------------------------------------------------ */

{
  const hit = resolve([rule({ match: '/old-page', target: '/shop', status: 301 })], '/old-page');
  check('exact rule matches', hit !== null);
  check('exact rule keeps its 301', hit?.status === 301);
  check('exact rule sends to its target', hit?.location === '/shop');
}
{
  const hit = resolve([rule({ match: '/temp', target: '/shop', status: 302 })], '/temp');
  // A 302 must NOT be promoted to 301: a shop testing a move needs to be able
  // to undo it, and a 301 is cached by browsers for months.
  check('302 stays 302', hit?.status === 302);
}
{
  const rules = [rule({ match: '/product-category/*', target: '/shop', status: 301 })];
  check('prefix rule matches beneath itself', resolve(rules, '/product-category/gyalia') !== null);
  check('prefix rule does not match a sibling', resolve(rules, '/product-categories') === null);
}
{
  const hit = resolve([rule({ match: '/shop/*/reviews', target: '/shop/$1', status: 301 })], '/shop/rayban-3025/reviews');
  check('wildcard capture expands into $1', hit?.location === '/shop/rayban-3025');
}
{
  // Trailing slash and case are the two ways the same address arrives twice.
  const rules = [rule({ match: '/Old-Page/', target: '/shop' })];
  check('match is normalised on both sides', resolve(rules, '/old-page') !== null);
}
{
  const hit = resolve([rule({ match: '/old', target: '/new' })], '/old', '?srsltid=abc123');
  // The click id has to survive: it is how the shop attributes the recovered
  // sale to the ad it already paid for.
  check('query string carries over', hit?.location === '/new?srsltid=abc123');
}
{
  check('disabled rule does not fire', resolve([rule({ enabled: false })], '/old') === null);
}
{
  // Exact beats prefix beats wildcard, regardless of insertion order — an
  // operator adding a broad sweep must not shadow the precise fix they wrote
  // yesterday.
  const rules = [
    rule({ id: 'broad', match: '/shop/*', target: '/shop', status: 301 }),
    rule({ id: 'exact', match: '/shop/rayban', target: '/shop/ray-ban', status: 301 }),
  ];
  check('exact wins over prefix', resolve(rules, '/shop/rayban')?.rule.id === 'exact');
  check('prefix still catches the rest', resolve(rules, '/shop/anything')?.rule.id === 'broad');
}
{
  const long = [
    rule({ id: 'short', match: '/a/*', target: '/x' }),
    rule({ id: 'long', match: '/a/b/*', target: '/y' }),
  ];
  check('longest prefix wins', resolve(long, '/a/b/c')?.rule.id === 'long');
}

/* ------------------------------------------------------------------ *
 * 2. A 410 does not become a 301
 * ------------------------------------------------------------------ */

{
  const hit = resolve([rule({ match: '/spam-url', target: '', status: 410 })], '/spam-url');
  check('410 rule matches', hit !== null);
  check('410 stays 410', hit?.status === 410);
  // The dangerous shape: a 410 that carries a location is one careless
  // middleware branch away from being served as a redirect.
  check('410 carries no destination', hit?.location === '');
}
{
  // Even if a target was stored on a 410 rule — say the operator switched the
  // kind after typing one — resolution must not hand it back.
  const hit = resolve([rule({ match: '/spam', target: '/shop', status: 410 })], '/spam');
  check('410 ignores any stored target', hit?.status === 410 && hit?.location === '');
}
{
  const hit = resolve([rule({ match: '/spam/*', target: '', status: 410 })], '/spam/anything?gclid=x');
  check('410 prefix rule stays 410 with a query', hit?.status === 410 && hit?.location === '');
}

/* ------------------------------------------------------------------ *
 * 3. What a rule is not allowed to do
 * ------------------------------------------------------------------ */

const refuses = (input) => R.validateRule(input).length > 0;

check('refuses a rule matching /admin', refuses({ match: '/admin', target: '/x', status: 301 }));
check('refuses a rule matching under /admin', refuses({ match: '/admin/users', target: '/x', status: 301 }));
check('refuses a rule matching /api', refuses({ match: '/api/posts', target: '/x', status: 301 }));
check('refuses a rule sweeping /admin by prefix', refuses({ match: '/admin/*', target: '/x', status: 301 }));
check('refuses catch-all /*', refuses({ match: '/*', target: '/x', status: 301 }));
check('refuses an empty match', refuses({ match: '', target: '/x', status: 301 }));
check('refuses a self-loop', refuses({ match: '/loop', target: '/loop', status: 301 }));
// The star must be a whole segment. `/shop*` matches nothing, and a stored rule
// that can never fire lets an operator believe a dead URL is fixed.
check('refuses a star glued to a segment', refuses({ match: '/shop*', target: '/x', status: 301 }));
check('refuses a leading star', refuses({ match: '/*/reviews', target: '/x', status: 301 }));
// ...but an ordinary page whose name merely STARTS with "admin" is not reserved.
check('allows /administrators-guide', !refuses({ match: '/administrators-guide', target: '/guide', status: 301 }));
check('refuses an unsupported status', refuses({ match: '/a', target: '/b', status: 307 }));
check('refuses a 301 with no target', refuses({ match: '/a', target: '', status: 301 }));
check('accepts a plain 301', !refuses({ match: '/a', target: '/b', status: 301 }));
check('accepts a 410 with no target', !refuses({ match: '/a', target: '', status: 410 }));
{
  // A rule that somehow reached storage still must not be able to redirect the
  // admin. Belt and braces: validation refuses it, and resolution ignores it.
  const hit = resolve([rule({ match: '/admin/users', target: '/evil' })], '/admin/users');
  check('a stored /admin rule cannot resolve', hit === null);
  check('a stored /api rule cannot resolve', resolve([rule({ match: '/api/posts', target: '/evil' })], '/api/posts') === null);
  check('a stored /* rule cannot resolve', resolve([rule({ match: '/*', target: '/evil' })], '/anything') === null);
  check('a stored /*/x rule cannot resolve', resolve([rule({ match: '/*/users', target: '/evil' })], '/admin/users') === null);
  // And the page that merely looks like it still redirects.
  check('/administrators-guide still redirects', resolve([rule({ match: '/administrators-guide', target: '/guide' })], '/administrators-guide') !== null);
}

/* ------------------------------------------------------------------ *
 * 4. The dead-URL log
 * ------------------------------------------------------------------ */

{
  let recs = [];
  recs = L.recordHit(recs, { path: '/gone', at: '2026-01-01T00:00:00.000Z' });
  recs = L.recordHit(recs, { path: '/gone', search: '?srsltid=abc', at: '2026-01-02T00:00:00.000Z' });
  check('hits aggregate on one row', recs.length === 1 && recs[0].hits === 2);
  check('a Shopping click is counted as paid', recs[0].paid_hits === 1);
  check('first_seen is kept', recs[0].first_seen === '2026-01-01T00:00:00.000Z');
  check('last_seen advances', recs[0].last_seen === '2026-01-02T00:00:00.000Z');
}
{
  check('gclid counts as paid', L.hasAdClickParams('?gclid=1'));
  check('utm_source counts as paid', L.hasAdClickParams('?utm_source=newsletter'));
  check('an ordinary query does not', !L.hasAdClickParams('?page=2'));
  check('no query does not', !L.hasAdClickParams(''));
}
{
  // The flood case. A crawler inventing distinct junk paths must not be able to
  // evict the row that has paid clicks on it — that row is the entire report.
  const cap = 5;
  let recs = [{
    path: '/valuable', hits: 3, paid_hits: 9,
    first_seen: '2026-01-01T00:00:00.000Z', last_seen: '2026-01-01T00:00:00.000Z',
  }];
  for (let i = 0; i < 50; i += 1) {
    recs = L.recordHit(recs, { path: `/junk-${i}`, at: '2026-02-01T00:00:00.000Z' }, cap);
  }
  check('the log stays bounded under a flood', recs.length <= cap);
  check('a paid row survives a flood of junk', recs.some((r) => r.path === '/valuable'));
}
{
  const recs = [
    { path: '/a', hits: 100, paid_hits: 0, first_seen: 'x', last_seen: '2026-01-01T00:00:00.000Z' },
    { path: '/b', hits: 5, paid_hits: 4, first_seen: 'x', last_seen: '2026-01-02T00:00:00.000Z' },
  ];
  // A crawler hammering one bad path outranks a lost buyer on raw counts, which
  // is why the report does not sort that way by default.
  check('paid sorting puts the money first', L.sortRecords(recs, 'paid')[0].path === '/b');
  check('hits sorting is still available', L.sortRecords(recs, 'hits')[0].path === '/a');
  check('recent sorting is still available', L.sortRecords(recs, 'recent')[0].path === '/b');
}

/* ------------------------------------------------------------------ *
 * 5. Matching a dead path to something real — including Greek
 * ------------------------------------------------------------------ */

const catalogue = [
  { kind: 'category', id: 'c1', name: 'Γυναικεία γυαλιά ηλίου', slug: 'gynaikeia-gyalia-iliou', url: '/shop?category=gynaikeia-gyalia-iliou' },
  { kind: 'product', id: 'p1', name: 'Ray-Ban Aviator RB3025', slug: 'ray-ban-aviator-rb3025', url: '/shop/ray-ban-aviator-rb3025' },
  { kind: 'brand', id: 'b1', name: 'Oakley', slug: 'oakley', url: '/shop?brand=oakley' },
];
const match = (p) => M.matchPath(p, catalogue);

{
  const { results } = match('/product-category/gynaikeia-gyalia-iliou/');
  check('a Latin legacy path finds its category', results[0]?.id === 'c1');
}
{
  // The path as Google actually indexed it on the old WordPress shop: Greek,
  // percent-encoded. It must reach the Latin slug.
  const encoded = '/product-category/' + encodeURIComponent('γυναικεία') + '-' + encodeURIComponent('γυαλιά');
  const { results, tokens, latin } = M.matchPath(encoded, catalogue);
  check('percent-encoded Greek is decoded', tokens.includes('γυναικεια'));
  check('percent-encoded Greek is transliterated for comparison', latin.includes('gynaikeia'));
  check('percent-encoded Greek finds the Latin slug', results[0]?.id === 'c1');
}
{
  // The same words, unencoded and accented.
  const { results } = match('/κατηγορια/γυναικεια-γυαλια-ηλιου');
  check('unencoded accented Greek matches too', results[0]?.id === 'c1');
}
{
  const { results } = match('/shop/ray-ban-rb3025-aviator-sunglasses');
  check('a reordered product slug still matches', results[0]?.id === 'p1');
}
{
  // The honest-empty case. Padding this with three random products is how a
  // shop loses the shopper's trust AND earns a soft-404.
  check('nonsense matches nothing', match('/xyzzy-plugh-quux').results.length === 0);
  check('a bare stopword path matches nothing', match('/shop/page/2').results.length === 0);
}
{
  // A malformed escape arrives from broken feeds constantly. It must produce a
  // weak match, never an exception, on the page whose job is broken requests.
  let threw = false;
  try { M.matchPath('/%E0%A4%A', catalogue); } catch { threw = true; }
  check('a malformed escape does not throw', !threw);
}
{
  const { results } = match('/brands/oakley');
  check('a brand path matches its brand', results.some((r) => r.id === 'b1'));
}

/* ------------------------------------------------------------------ *
 * S5.10 — a dead path is bounded before it is matched
 *
 * `/api/recovery/match?path=` is public and costs tokens × catalogue. A path of
 * thousands of distinct words was thousands of passes per request.
 * ------------------------------------------------------------------ */
{
  check('the caps are the documented ones', M.MAX_PATH_TOKENS === 12 && M.MAX_PATH_LENGTH === 1024);

  const many = '/' + Array.from({ length: 3000 }, (_, i) => `word${i}`).join('-');
  const toks = M.tokenizePath(many);
  check('THE BUG: thousands of words become at most MAX_PATH_TOKENS tokens', toks.length <= M.MAX_PATH_TOKENS);
  check('...the FIRST ones', toks[0]?.folded === 'word0');

  // The ceiling counts meaningful tokens only: stopwords and repeats before a
  // real word must not use it up.
  const noisy = '/' + 'shop-'.repeat(50) + 'rayban-' + 'rayban-'.repeat(50) + 'aviator';
  const noisyToks = M.tokenizePath(noisy).map((t) => t.folded);
  check('stopwords and repeats do not use up the token budget',
    noisyToks.includes('rayban') && noisyToks.includes('aviator'));

  // A long path is clipped; the matcher's work stops growing with it.
  const huge = '/' + 'x'.repeat(200_000) + '-oakley';
  const hugeToks = M.tokenizePath(huge);
  check('a 200k-character path is clipped before it is read',
    hugeToks.every((t) => t.folded.length <= M.MAX_PATH_LENGTH) && !hugeToks.some((t) => t.folded === 'oakley'));

  // Clipping must never make a Greek URL undecodable. `%CE%B3` is γ: a cut
  // between its two bytes, or inside an escape, must drop the partial letter —
  // not fall back to matching the whole path as raw percent-escapes.
  const greekWord = encodeURIComponent('γυναικεια');
  for (const pad of [0, 1, 2, 3, 4, 5]) {
    const prefix = '/' + greekWord + '/' + 'a'.repeat(M.MAX_PATH_LENGTH - greekWord.length - 2 - pad);
    const tail = encodeURIComponent('γγγγ');
    const clipped = M.tokenizePath(prefix + tail);
    check(`a cut inside a Greek escape still decodes the rest (pad ${pad})`,
      clipped[0]?.folded === 'γυναικεια');
  }

  // And the whole matcher, end to end, still answers — within bounds.
  const { results, tokens } = M.matchPath(`${many}-oakley`, catalogue);
  check('matchPath on a huge path returns bounded tokens and no throw',
    Array.isArray(results) && tokens.length <= M.MAX_PATH_TOKENS);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
