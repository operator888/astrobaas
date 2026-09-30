#!/usr/bin/env node
/**
 * Search suggestions (src/lib/search/suggest.ts, GET /api/search/suggest).
 *
 * A suggestion list is public, cached and runs on every keystroke, so what it
 * may reveal is pinned here: nothing a visitor could not open themselves — no
 * drafts, no pages hidden from search, no product the merchant took off the
 * search results — and no shop at all on a site that is not a shop.
 *
 * Run with:  node tests/search-suggest.test.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadTs, ROOT } from './lib/load.mjs';

const S = await loadTs('src/lib/search/suggest.ts');
const read = (rel) => fs.readFile(path.join(ROOT, rel), 'utf8');

let passed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed += 1; } catch (err) { failures.push(`${name}: ${err.message}`); }
}
function ok(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, what = '') {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

const posts = [
  { id: '1', title: 'Summer sunglasses guide', slug: 'summer-guide', status: 'published', kind: 'post' },
  { id: '2', title: 'Sunglasses draft', slug: 'draft', status: 'draft', kind: 'post' },
  { id: '3', title: 'Sunglasses care', slug: 'care', status: 'published', kind: 'page' },
  { id: '4', title: 'Sunglasses secret', slug: 'secret', status: 'published', kind: 'post', noindex: true },
];
const product = (over) => ({ id: over.slug, status: 'active', price_cents: 1000, images: [], ...over });
const products = [
  product({ name: 'Polarised sunglasses', slug: 'polarised' }),
  product({ name: 'Sunglasses in search only', slug: 'search-only', catalog_visibility: 'search' }),
  product({ name: 'Sunglasses on shelves only', slug: 'shelf-only', catalog_visibility: 'catalog' }),
  product({ name: 'Hidden sunglasses', slug: 'hidden', catalog_visibility: 'hidden' }),
  product({ name: 'Draft sunglasses', slug: 'draft-p', status: 'draft' }),
  product({ name: 'Σκελετός γυαλιών', slug: 'frame-gr' }),
];
const categories = [{ slug: 'sunglasses', name: 'Sunglasses' }, { slug: 'frames', name: 'Σκελετοί' }];
const all = (q, extra = {}) => S.suggest({ q, types: S.SUGGEST_TYPES, limit: 8, posts, products, categories, ...extra });

check('only published posts not hidden from search, split into posts and pages', () => {
  const r = all('sungl');
  eq(r.posts.map((p) => p.slug), ['summer-guide'], 'posts');
  eq(r.pages.map((p) => p.slug), ['care'], 'pages');
});

check('products follow their catalogue visibility: "search" appears, "catalog" and "hidden" do not', () => {
  eq(all('sunglasses').products.map((p) => p.slug).sort(), ['polarised', 'search-only']);
});

check('draft products are never suggested', () => {
  ok(!all('draft').products.some((p) => p.slug === 'draft-p'), 'a draft product was suggested');
});

check('a partial last word matches — that is what suggestions are for', () => {
  eq(all('polar').products.map((p) => p.slug), ['polarised']);
});

check('Greek matches without accents or case, as the search page does', () => {
  eq(all('σκελετος').products.map((p) => p.slug), ['frame-gr']);
  eq(all('ΣΚΕΛΕΤΟΙ').categories.map((c) => c.slug), ['frames']);
});

check('a query shorter than two characters suggests nothing', () => {
  eq(all('s'), { searches: [], posts: [], pages: [], products: [], categories: [] });
});

check('at most eight of each type, however many are asked for', () => {
  const many = Array.from({ length: 20 }, (_, i) => product({ name: `Lens ${i}`, slug: `lens-${i}` }));
  eq(S.suggest({ q: 'lens', types: ['products'], limit: 100, products: many }).products.length, S.MAX_PER_TYPE);
});

check('categories carry the count they are given', () => {
  eq(all('sunglasses', { categoryCounts: new Map([['sunglasses', 7]]) }).categories, [{ name: 'Sunglasses', slug: 'sunglasses', count: 7 }]);
});

check('?types narrows to what is allowed, and ignores what is not', () => {
  eq(S.parseTypes('products,bogus,posts', S.SUGGEST_TYPES), ['posts', 'products']);
  eq(S.suggest({ q: 'sun', types: ['searches'], limit: 2, popular: ['sunglasses', 'sun hat', 'sunscreen'] }).searches, ['sunglasses', 'sun hat'], 'popular searches are not capped at the limit');
  eq(S.parseTypes('products', ['posts', 'pages']), [], 'a site that is not a shop offered products');
  eq(S.parseTypes(null, ['posts', 'pages']), ['posts', 'pages']);
});

{
  const route = await read('src/pages/api/search/suggest.ts');
  const mw = await read('src/middleware.ts');
  check('the route offers products and categories only while the shop is on', () => {
    ok(/\(shop \|\| \(t !== 'products' && t !== 'categories'\)\)/.test(route), 'the shop is suggested on a site that is not a shop');
    ok(/\(prefs\.popular \|\| t !== 'searches'\)/.test(route), 'popular searches are offered while switched off');
    ok(/if \(!prefs\.enabled\) \{\s*return withPublicCache\(ApiResponseBuilder\.success\(empty/.test(route), 'suggestions answer while switched off');
    ok(/Math\.min\(asked, prefs\.limit\)/.test(route), 'a client can ask for more than the operator allows');
  });
  const box = await read('src/components/public/SiteSearch.astro');
  check('a suggested page links to /el/slug, not /elslug', () => {
    ok(/const pageBase = routeHref\('\/', locale\)\.replace\(\/\\\/\?\$\/, '\/'\);/.test(box), 'the page base can lack its trailing slash on a locale');
  });
  const limits = await loadTs('src/lib/request-limits.ts');
  check('suggestions have a rate bucket of their own', () => {
    eq(limits.routeBucketFor('GET', '/api/search/suggest'), 'suggest');
    ok(limits.DEFAULT_ROUTE_LIMITS.suggest > 0, 'no limit set');
  });
  check('it is public and cached, like search', () => {
    ok(/\/\^\\\/api\\\/search\\\/suggest\\\/\?\$\//.test(mw), 'not on the public GET list');
    ok(/withPublicCache\(ApiResponseBuilder\.success\(data/.test(route), 'not cached');
  });
}

if (failures.length) {
  console.error(`\n✗ search-suggest: ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error(`  · ${f}`);
  process.exit(1);
}
console.log(`✓ search-suggest: ${passed} passed`);
