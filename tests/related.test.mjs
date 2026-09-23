#!/usr/bin/env node
/**
 * Related posts (src/lib/related.ts).
 *
 * The cases that matter are the ones where a plausible implementation quietly
 * does the wrong thing:
 *
 *   · a blog that publishes daily filling "related" with yesterday's unrelated posts;
 *   · the same article in another language offered as a recommendation;
 *   · a post tagged with everything out-ranking one that is actually on topic;
 *   · two storage drivers returning equal-scoring posts in different orders.
 *
 * Run with:  node tests/related.test.mjs
 */
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const cacheDir = path.join(root, 'node_modules', '.cache');
await fs.mkdir(cacheDir, { recursive: true });
const out = path.join(cacheDir, `astrobaas-related-${process.pid}.mjs`);
await build({
  entryPoints: [path.join(root, 'src/lib/related.ts')],
  bundle: true, format: 'esm', platform: 'node', packages: 'external',
  outfile: out, logLevel: 'silent',
});
const R = await import(pathToFileURL(out).href);
await fs.rm(out, { force: true });

let pass = 0;
let fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };

const NOW = Date.parse('2026-09-01T00:00:00Z');
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString();

/** A published post with sensible defaults, so each test states only what it means. */
const post = (o) => ({
  id: o.id, title: o.id, slug: o.id, content: '', status: 'published', kind: 'post',
  author_id: 'a1', views: 0, created_at: daysAgo(o.age ?? 10),
  publish_date: daysAgo(o.age ?? 10), updated_at: daysAgo(o.age ?? 10),
  ...o,
});

/* ---- topical overlap is the entry ticket ---- */
{
  const target = post({ id: 'target', category_id: 'optics', tags: ['frames'] });
  const all = [
    target,
    post({ id: 'same-cat', category_id: 'optics' }),
    // Brand new, published today, and about nothing in common.
    post({ id: 'fresh-unrelated', category_id: 'recipes', age: 0 }),
  ];
  const rel = R.relatedPosts(target, all, { now: NOW });
  check('a post sharing a category is related', rel.some((r) => r.post.id === 'same-cat'));
  // The failure this test exists for: a blog that publishes daily would fill
  // its "related" strip with yesterday's unrelated posts.
  check('a brand-new post with nothing in common is NOT related',
    !rel.some((r) => r.post.id === 'fresh-unrelated'));
  check('...so a blog with no categories or tags gets nothing rather than noise',
    R.relatedPosts(post({ id: 'bare' }), [post({ id: 'bare' }), post({ id: 'other' })],
      { now: NOW }).length === 0);
}

/* ---- tags, and the cap that stops a promiscuously-tagged post winning ---- */
{
  const target = post({ id: 'target', tags: ['a', 'b', 'c', 'd', 'e', 'f'] });
  const all = [
    target,
    post({ id: 'three-shared', tags: ['a', 'b', 'c'] }),
    // Tagged with everything the target has. Without a cap this wins on breadth
    // rather than on being related to anything — which is what happens to a
    // blog's tag vocabulary over a few years.
    post({ id: 'all-shared', tags: ['a', 'b', 'c', 'd', 'e', 'f'] }),
  ];
  const rel = R.relatedPosts(target, all, { now: NOW, limit: 5 });
  const s = (id) => rel.find((r) => r.post.id === id)?.score ?? 0;
  check('shared tags make a post related', s('three-shared') > 0);
  check('six shared tags score no more than three do',
    Math.abs(s('all-shared') - s('three-shared')) < 0.001);
  check('the cap is the documented one', R.RELATED_WEIGHTS.maxTags === 3);
}

/* ---- category vs tags ---- */
{
  const target = post({ id: 'target', category_id: 'optics', tags: ['x', 'y'] });
  const all = [
    target,
    post({ id: 'cat-only', category_id: 'optics' }),
    post({ id: 'two-tags', category_id: 'other', tags: ['x', 'y'] }),
  ];
  const rel = R.relatedPosts(target, all, { now: NOW, limit: 5 });
  const s = (id) => rel.find((r) => r.post.id === id)?.score ?? 0;
  // Two shared tags (4) is a stronger signal than one shared category (3).
  check('two shared tags outrank a shared category', s('two-tags') > s('cat-only'));
  check('both are still related', s('cat-only') > 0 && s('two-tags') > 0);
}

/* ---- recency orders, never promotes ---- */
{
  const target = post({ id: 'target', category_id: 'optics' });
  const all = [
    target,
    post({ id: 'old-related', category_id: 'optics', age: 900 }),
    post({ id: 'new-related', category_id: 'optics', age: 1 }),
  ];
  const rel = R.relatedPosts(target, all, { now: NOW, limit: 5 });
  check('among equally related posts, the newer one comes first',
    rel[0].post.id === 'new-related');
  check('...and the older one is still included', rel.length === 2);
  // The ceiling matters: recency must never let an unrelated post overtake a
  // related one, which is guaranteed because it is applied AFTER the zero check
  // and is worth less than one tag.
  check('the recency ceiling is below one tag',
    R.RELATED_WEIGHTS.recency < R.RELATED_WEIGHTS.tag);
}

/* ---- the same article in another language is not a recommendation ---- */
{
  const target = post({ id: 'en1', category_id: 'optics', locale: 'en' });
  const all = [
    target,
    // Same article, other language — and it shares the category, so it WOULD
    // score if nothing excluded it.
    post({ id: 'el1', category_id: 'optics', locale: 'en', translation_of: 'en1' }),
    post({ id: 'other', category_id: 'optics', locale: 'en' }),
  ];
  const rel = R.relatedPosts(target, all, { now: NOW, limit: 5 });
  check('a translation of the same article is excluded',
    !rel.some((r) => r.post.id === 'el1'));
  check('...but a genuinely different post is not', rel.some((r) => r.post.id === 'other'));
}

/* ---- a translation CHAIN collapses to one set ---- */
{
  // de points at el, which points at en. One-level grouping would treat de as a
  // different article and recommend it — the same defect the translation
  // dashboard had.
  const target = post({ id: 'en1', category_id: 'optics', locale: 'en' });
  const all = [
    target,
    post({ id: 'el1', category_id: 'optics', locale: 'en', translation_of: 'en1' }),
    post({ id: 'de1', category_id: 'optics', locale: 'en', translation_of: 'el1' }),
  ];
  const rel = R.relatedPosts(target, all, { now: NOW, limit: 5 });
  check('a chained translation is excluded too', rel.length === 0);
}

/* ---- a cycle in translation_of must not hang ---- */
{
  // Nothing in storage prevents two posts pointing at each other; the field is
  // operator-supplied. A naive walk loops forever and takes the site with it.
  const a = post({ id: 'a', category_id: 'optics', translation_of: 'b' });
  const b = post({ id: 'b', category_id: 'optics', translation_of: 'a' });
  const target = post({ id: 't', category_id: 'optics' });
  const t0 = Date.now();
  const rel = R.relatedPosts(target, [target, a, b], { now: NOW, limit: 5 });
  check('a translation_of cycle terminates', Date.now() - t0 < 1000);
  check('...and still returns something sensible', Array.isArray(rel));
  // A mutual pair is ONE article in two languages. Before, each resolved to a
  // different root and each was offered as related to the other — the same
  // piece twice, which is exactly what this exclusion exists to prevent.
  const pairRel = R.relatedPosts(a, [a, b], { now: NOW, limit: 5 });
  check('a MUTUAL translation pair does not recommend itself', pairRel.length === 0);
}

/* ---- noindex is not for finding ---- */
{
  const target = post({ id: 'target', category_id: 'optics' });
  const all = [
    target,
    post({ id: 'hidden', category_id: 'optics', noindex: true }),
    post({ id: 'visible', category_id: 'optics' }),
  ];
  const rel = R.relatedPosts(target, all, { now: NOW, limit: 5 });
  check('a noindex post is not promoted in the related strip',
    !rel.some((r) => r.post.id === 'hidden'));
  check('...and the visible one still is', rel.some((r) => r.post.id === 'visible'));
}

/* ---- a record written before i18n existed belongs to the default locale ---- */
{
  // The subtle one: comparing `post.locale || ''` would treat a post with NO
  // locale as different from one explicitly tagged with the default, so a site
  // part-way through adopting i18n would stop relating its older posts to its
  // newer ones — silently.
  const target = post({ id: 'target', category_id: 'optics' });  // no locale
  const all = [target, post({ id: 'tagged', category_id: 'optics', locale: 'en' })];
  const rel = R.relatedPosts(target, all, { now: NOW, limit: 5, env: {} });
  check('an untagged post relates to one tagged with the default locale',
    rel.length === 1 && rel[0].post.id === 'tagged');
}

/* ---- locale ---- */
{
  // SITE_LOCALES must be declared, because recordLocale folds any locale the
  // site does NOT run to the default one. That is the right behaviour — a
  // stray `locale: 'fr'` on a two-language site is data rot, not a third
  // language — and it means this test has to say which languages exist.
  const ML = { SITE_LOCALES: 'en,el,de', SITE_DEFAULT_LOCALE: 'en' };
  const target = post({ id: 'target', category_id: 'optics', locale: 'el' });
  const all = [
    target,
    post({ id: 'greek', category_id: 'optics', locale: 'el' }),
    post({ id: 'german', category_id: 'optics', locale: 'de' }),
  ];
  const rel = R.relatedPosts(target, all, { now: NOW, limit: 5, env: ML });
  check('a reader is not offered an article they cannot read',
    rel.length === 1 && rel[0].post.id === 'greek');

  // And a locale the site does not run folds to the default rather than
  // creating a phantom fourth language nobody can reach.
  const stray = R.relatedPosts(
    post({ id: 't2', category_id: 'optics' }),
    [post({ id: 't2', category_id: 'optics' }),
     post({ id: 'rot', category_id: 'optics', locale: 'fr' })],
    { now: NOW, limit: 5, env: ML });
  check('a locale the site does not run folds to the default',
    stray.length === 1 && stray[0].post.id === 'rot');
}

/* ---- what is excluded outright ---- */
{
  const target = post({ id: 'target', category_id: 'optics' });
  const all = [
    target,
    post({ id: 'draft', category_id: 'optics', status: 'draft' }),
    post({ id: 'trashed', category_id: 'optics', status: 'trash' }),
    // A reader finishing an article is not looking for the shipping policy.
    post({ id: 'page', category_id: 'optics', kind: 'page' }),
    post({ id: 'ok', category_id: 'optics' }),
  ];
  const rel = R.relatedPosts(target, all, { now: NOW, limit: 10 });
  check('drafts are excluded', !rel.some((r) => r.post.id === 'draft'));
  check('trashed posts are excluded', !rel.some((r) => r.post.id === 'trashed'));
  check('pages are excluded', !rel.some((r) => r.post.id === 'page'));
  check('the post itself is never its own related post',
    !rel.some((r) => r.post.id === 'target'));
  check('...and the real one survives all of that',
    rel.length === 1 && rel[0].post.id === 'ok');
}

/* ---- stable across storage order ---- */
{
  // Two drivers can return equal-scoring rows in different orders. Without a
  // final tiebreak that difference shows up as a flaking test long before
  // anyone notices it on the site.
  const target = post({ id: 'target', category_id: 'optics' });
  const p1 = post({ id: 'aaa', category_id: 'optics', age: 5 });
  const p2 = post({ id: 'bbb', category_id: 'optics', age: 5 });
  const forward = R.relatedPosts(target, [target, p1, p2], { now: NOW, limit: 5 });
  const backward = R.relatedPosts(target, [target, p2, p1], { now: NOW, limit: 5 });
  check('equal-scoring posts come back in the same order either way',
    forward.map((r) => r.post.id).join() === backward.map((r) => r.post.id).join());
}

/* ---- limits and degenerate input ---- */
{
  const target = post({ id: 'target', category_id: 'optics' });
  const many = [target, ...Array.from({ length: 20 }, (_, i) =>
    post({ id: `p${i}`, category_id: 'optics' }))];
  check('the limit is honoured', R.relatedPosts(target, many, { now: NOW, limit: 3 }).length === 3);
  check('a limit of zero returns nothing',
    R.relatedPosts(target, many, { now: NOW, limit: 0 }).length === 0);
  check('a negative limit returns nothing rather than throwing',
    R.relatedPosts(target, many, { now: NOW, limit: -5 }).length === 0);
  check('an empty list returns nothing', R.relatedPosts(target, [], { now: NOW }).length === 0);
  check('a missing date does not crash the sort',
    R.relatedPosts(target,
      [target, { ...post({ id: 'nodate', category_id: 'optics' }), publish_date: undefined, created_at: '' }],
      { now: NOW }).length === 1);
  check('the default limit is small enough for a sidebar',
    R.relatedPosts(target, many, { now: NOW }).length <= 4);
}

/* ---- pure: no clock, no hidden state ---- */
{
  const target = post({ id: 'target', category_id: 'optics' });
  const all = [target, post({ id: 'x', category_id: 'optics' })];
  const a = R.relatedPosts(target, all, { now: NOW });
  const b = R.relatedPosts(target, all, { now: NOW });
  check('the same inputs give the same scores',
    a[0].score === b[0].score && a[0].post.id === b[0].post.id);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
