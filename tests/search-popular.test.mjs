#!/usr/bin/env node
/**
 * Popular searches (src/lib/search/popular.ts, popular-store.ts,
 * suggest-settings.ts).
 *
 * A search box is where people type anything — their own name, an email, an
 * order number — and popular searches SHOW what was typed to strangers. So the
 * privacy rules are the point of this file: what is never stored, what one
 * visitor cannot do alone, and what the operator can always hide.
 *
 * Run with:  node tests/search-popular.test.mjs
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadTs, loadTogether, ROOT } from './lib/load.mjs';

const P = await loadTs('src/lib/search/popular.ts');
const SS = await loadTs('src/lib/search/suggest-settings.ts');
const read = (rel) => fs.readFile(path.join(ROOT, rel), 'utf8');

let passed = 0;
const failures = [];
async function check(name, fn) {
  try { await fn(); passed += 1; } catch (err) { failures.push(`${name}: ${err.message}`); }
}
function ok(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, what = '') {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

// ─────────────────────────────────────────── never stored at all

await check('anything that looks personal is never stored', () => {
  for (const q of [
    'maria@example.com', 'https://evil.example', 'www.example.com/x', '+30 210 123 4567',
    '4111 1111 1111 1111', 'order 100234', '69123', '<script>', 'a', 'x'.repeat(61), '',
  ]) eq(P.storableQuery(q), null, JSON.stringify(q));
});

await check('punctuation is not part of a query, so a blocklist entry catches every spelling', () => {
  eq(P.storableQuery('Idiot!'), 'idiot');
  eq(P.storableQuery('t-shirt'), 't shirt');
  ok(P.isBlocked('idiot shirt', P.parseBlocklist('idiot!')), 'the blocklist missed a punctuated spelling');
});

await check('crawlers are never counted — planted /blog?q= links cannot launder a phrase', () => {
  ok(P.looksLikeBot('Mozilla/5.0 (compatible; Googlebot/2.1)'), 'Googlebot counted');
  ok(P.looksLikeBot(''), 'no user agent counted');
  ok(!P.looksLikeBot('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Safari/605.1.15'), 'a browser refused');
});

await check('ordinary searches are stored, normalised', () => {
  eq(P.storableQuery('  Sun   Glasses '), 'sun glasses');
  eq(P.storableQuery('Σκελετός'), 'σκελετός');
  eq(P.storableQuery('size 52'), 'size 52', 'a short number inside a real query is fine');
});

// ─────────────────────────────────────────────── counting, pruning

await check('counts merge, and stale or rare queries fall off', () => {
  const at = '2026-09-29T10:00:00.000Z';
  let e = P.countQuery([], 'sunglasses', 1, at);
  e = P.countQuery(e, 'sunglasses', 2, at);
  eq(e, [{ query: 'sunglasses', count: 3, last: at }]);
  const old = [{ query: 'last year', count: 99, last: '2025-01-01T00:00:00.000Z' }];
  eq(P.prune(old, Date.parse(at)), [], 'a query unsearched for 90 days was kept');
  const many = Array.from({ length: P.MAX_TRACKED + 10 }, (_, i) => ({ query: `q${i}`, count: i, last: at }));
  eq(P.prune(many, Date.parse(at)).length, P.MAX_TRACKED);
  ok(!P.prune(many, Date.parse(at)).some((x) => x.query === 'q0'), 'the rarest survived instead of the most searched');
});

// ───────────────────────────────────────────────── what is shown

const entries = [
  { query: 'sunglasses', count: 40, last: 'x' },
  { query: 'sun hat', count: 12, last: 'x' },
  { query: 'polarised sunglasses', count: 9, last: 'x' },
  { query: 'sunscreen', count: 2, last: 'x' },
  { query: 'rivalshop sunglasses', count: 50, last: 'x' },
];
const show = (typed, over = {}) => P.popularFor(entries, typed, { minCount: 5, blocklist: [], limit: 5, ...over });

await check('only searches that reached the minimum count are shown', () => {
  ok(!show('sun').includes('sunscreen'), 'a search two people made was shown to everyone');
});

await check('a prefix of the query, or of any word in it, matches — most searched first', () => {
  eq(show('sung'), ['rivalshop sunglasses', 'sunglasses', 'polarised sunglasses']);
});

await check('the blocklist hides a word anywhere in a query, and a phrase', () => {
  eq(show('sung', { blocklist: P.parseBlocklist('RivalShop') }), ['sunglasses', 'polarised sunglasses']);
  ok(!show('sun', { blocklist: P.parseBlocklist('sun hat') }).includes('sun hat'), 'a blocked phrase was shown');
  ok(P.isBlocked('Rivalshop Sunglasses', P.parseBlocklist('rivalshop')), 'case or accents defeated the blocklist');
});

await check('exactly what was typed is not offered back', () => {
  ok(!show('sunglasses').includes('sunglasses'), 'suggested the query itself');
});

// ─────────────────────────────────────────────────────── settings

await check('defaults: suggestions on, 5 per kind, popular on, minimum 5', () => {
  const d = SS.resolveSuggestSettings({});
  eq([d.enabled, d.limit, d.popular, d.minCount], [true, 5, true, 5]);
  eq(SS.resolveSuggestSettings({ search_suggestions_enabled: false }).enabled, false);
});

await check('the minimum count can never go below 2 — one person alone is never shown', () => {
  ok(SS.validateSuggestSetting('search_popular_min_count', 1), 'accepted a minimum of 1');
  eq(SS.validateSuggestSetting('search_popular_min_count', 2), null);
  eq(SS.resolveSuggestSettings({ search_popular_min_count: 1 }).minCount, 5, 'a stored 1 was honoured');
  eq(SS.validateSuggestSetting('some_other_key', 1), undefined, 'claimed a key that is not ours');
});

// ─────────────────────────────── the store: real storage, one visitor

{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ab-popular-'));
  process.env.DB_PATH = path.join(dir, 'db.json');
  process.env.UPLOADS_DIR = path.join(dir, 'uploads');
  const [{ LocalDB }, store] = await loadTogether(['src/lib/localdb.ts', 'src/lib/search/popular-store.ts'], 'popular');
  await LocalDB.init();
  const day1 = new Date('2026-09-29T10:00:00Z');
  const day2 = new Date('2026-09-30T10:00:00Z');

  store.notePopularSearch('sunglasses', 3, '10.0.0.1', day1);
  store.notePopularSearch('sunglasses', 3, '10.0.0.1', day1); // same visitor, same day
  store.notePopularSearch('sunglasses', 3, '10.0.0.2', day1);
  store.notePopularSearch('sunglasses', 3, '10.0.0.1', day2); // same visitor, next day
  store.notePopularSearch('no such thing', 0, '10.0.0.3', day1); // found nothing
  store.notePopularSearch('me@example.com', 5, '10.0.0.4', day2); // personal
  store.notePopularSearch('crawled phrase', 5, '10.0.0.5', day2, 'Mozilla/5.0 (compatible; bingbot/2.0)'); // a bot
  await store.flushPopular(day2);
  const stored = await store.popularEntries();

  await check('one visitor counts once per query per day; a new day counts again', () => {
    eq(stored.find((e) => e.query === 'sunglasses')?.count, 3);
  });
  await check('a search that found nothing, or looked personal, never reached storage', () => {
    eq(stored.map((e) => e.query), ['sunglasses']);
  });
  await check('nothing that identifies a visitor is written', async () => {
    const raw = await fs.readFile(process.env.DB_PATH, 'utf8');
    ok(!/10\.0\.0\.\d/.test(raw), 'a visitor address is in the database file');
  });
  await check('clearing forgets every count', async () => {
    await store.clearPopular();
    eq(await store.popularEntries(), []);
  });
}

// ──────────────────────────────────────────── wired where it counts

{
  const api = await read('src/pages/api/search.ts');
  const products = await read('src/pages/api/products/index.ts');
  const blog = await read('src/pages/blog/index.astro');
  await check('each search point counts only non-staff searches, only when popular is on', () => {
    ok(/if \(!locals\.user && resolveSuggestSettings\(settingsMap\(settingsRows\)\)\.popular\) \{\s*notePopularSearch\(q, matches\.length, locals\.ip, new Date\(\), request\.headers\.get\('user-agent'\)\)/.test(api), '/api/search');
    ok(/if \(searched && !locals\.user && findable > 0\s*&& resolveSuggestSettings\(settingsMap\(await LocalDB\.getSettings\(\)\)\)\.popular\) \{\s*notePopularSearch\(searched, findable, locals\.ip, new Date\(\), request\.headers\.get\('user-agent'\)\)/.test(products), '/api/products?search=');
    ok(/const findable = products\.filter\(\(p\) => \['visible', 'search', undefined\]\.includes\(p\.catalog_visibility\)\)\.length;/.test(products), 'hidden products count toward a public suggestion');
    ok(/if \(!Astro\.locals\.user && resolveSuggestSettings\(searchSettings\)\.popular\) \{\s*notePopularSearch\(searchQuery, filteredPosts\.length, Astro\.locals\.ip, new Date\(\), Astro\.request\.headers\.get\('user-agent'\)\)/.test(blog), '/blog?q=');
  });
  const clear = await read('src/pages/api/search/popular.ts');
  await check('clearing is for administrators only, and audited', () => {
    ok(/locals\.user\?\.role !== 'admin'/.test(clear) && /recordAudit\(AUDIT\.SEARCH_POPULAR_CLEAR/.test(clear), 'unguarded or unaudited');
  });
}

if (failures.length) {
  console.error(`\n✗ search-popular: ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error(`  · ${f}`);
  process.exit(1);
}
console.log(`✓ search-popular: ${passed} passed`);
process.exit(0);
