#!/usr/bin/env node
/**
 * The post query specification.
 *
 * `applyPostQuery` is not "the lowdb implementation" — it is the DEFINITION of
 * what these filters mean, which the relational driver's SQL has to agree with.
 * So this file pins the semantics precisely, especially the two places where a
 * second implementation drifts silently:
 *
 *  - **`total` counts matches BEFORE limit/offset.** Count after the slice and
 *    `hasMore` goes false one page early; the reader never sees the last page
 *    and nothing errors.
 *  - **The sort is TOTAL.** Ordering on `created_at` alone lets two posts
 *    written in the same millisecond swap between pages — one served twice,
 *    another never served at all. `id` is the tiebreak.
 *
 * The cross-driver agreement itself is asserted in the smoke suite, which is
 * the only place all three drivers actually run.
 *
 * Run with:  node tests/post-query.test.mjs
 */
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const cacheDir = path.join(root, 'node_modules', '.cache');
await fs.mkdir(cacheDir, { recursive: true });

const out = path.join(cacheDir, `astrobaas-postquery-${process.pid}.mjs`);
await build({
  entryPoints: [path.join(root, 'src/core/post-query.ts')],
  bundle: true, format: 'esm', platform: 'node', packages: 'external',
  outfile: out, logLevel: 'silent',
});
const { applyPostQuery, comparePostsForListing } = await import(pathToFileURL(out).href);
await fs.rm(out, { force: true });

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) pass++;
  else { fail++; console.error(`✗ ${name}`); }
}

let seq = 0;
const mk = (o = {}) => ({
  id: o.id ?? `id${++seq}`,
  title: o.title ?? 'Title',
  slug: o.slug ?? `slug-${seq}`,
  content: o.content ?? '<p>body</p>',
  status: o.status ?? 'published',
  author_id: o.author_id ?? 'u1',
  created_at: o.created_at ?? `2024-01-${String((seq % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
  ...o,
});
const ids = (r) => r.items.map((p) => p.id);

/* ---------------- kind: absent means article ---------------- */
{
  const posts = [mk({ id: 'a' }), mk({ id: 'b', kind: 'page' }), mk({ id: 'c', kind: 'post' })];
  check('the default is articles only', ids(applyPostQuery(posts, {})).sort().join() === 'a,c');
  check('kind:post is the same as the default',
    ids(applyPostQuery(posts, { kind: 'post' })).sort().join() === 'a,c');
  check('kind:page returns pages only', ids(applyPostQuery(posts, { kind: 'page' })).join() === 'b');
  check('kind:all returns everything', applyPostQuery(posts, { kind: 'all' }).total === 3);
}

/* ---------------- scalar filters ---------------- */
{
  const posts = [
    mk({ id: 'a', status: 'draft', category_id: 'c1', author_id: 'u1' }),
    mk({ id: 'b', status: 'published', category_id: 'c1', author_id: 'u2' }),
    mk({ id: 'c', status: 'published', category_id: 'c2', author_id: 'u1' }),
  ];
  check('status filters exactly', ids(applyPostQuery(posts, { kind: 'all', status: 'draft' })).join() === 'a');
  check('categoryId filters exactly',
    ids(applyPostQuery(posts, { kind: 'all', categoryId: 'c1' })).sort().join() === 'a,b');
  check('authorId filters exactly',
    ids(applyPostQuery(posts, { kind: 'all', authorId: 'u1' })).sort().join() === 'a,c');
  check('filters combine as AND',
    ids(applyPostQuery(posts, { kind: 'all', status: 'published', authorId: 'u1' })).join() === 'c');
  check('a filter matching nothing yields an empty page and zero total',
    applyPostQuery(posts, { kind: 'all', status: 'nope' }).total === 0);
}

/* ---------------- locale: the EFFECTIVE locale, not the stored one ---------------- */
{
  const posts = [
    mk({ id: 'none' }),                    // written before i18n
    mk({ id: 'en', locale: 'en' }),
    mk({ id: 'de', locale: 'de' }),
    mk({ id: 'stale', locale: 'fr' }),     // French was configured once, then removed
    mk({ id: 'empty', locale: '' }),       // a blank written by an old import
  ];
  const KNOWN = ['en', 'de'];

  check('a post with no locale matches the default',
    ids(applyPostQuery(posts, { kind: 'all', locale: 'en' }, 'en', KNOWN)).includes('none'));
  check('a post with an explicit locale matches it',
    ids(applyPostQuery(posts, { kind: 'all', locale: 'de' }, 'en', KNOWN)).includes('de'));
  check('...and does not match another locale',
    !ids(applyPostQuery(posts, { kind: 'all', locale: 'en' }, 'en', KNOWN)).includes('de'));

  // THE regression this pins. The route this replaced went through
  // `filterByLocale` -> `recordLocale`, which folds ANY unconfigured value to
  // the default. Folding only nullish values made these posts vanish from
  // every list with nothing logged.
  check('a stale locale that is no longer configured folds to the default',
    ids(applyPostQuery(posts, { kind: 'all', locale: 'en' }, 'en', KNOWN)).includes('stale'));
  check('an empty-string locale folds to the default',
    ids(applyPostQuery(posts, { kind: 'all', locale: 'en' }, 'en', KNOWN)).includes('empty'));
  check('...and neither is reachable under some other locale',
    !ids(applyPostQuery(posts, { kind: 'all', locale: 'de' }, 'en', KNOWN)).includes('stale'));
  check('no post is invisible under every configured locale',
    new Set([
      ...ids(applyPostQuery(posts, { kind: 'all', locale: 'en' }, 'en', KNOWN)),
      ...ids(applyPostQuery(posts, { kind: 'all', locale: 'de' }, 'en', KNOWN)),
    ]).size === posts.length);

  check('the default locale is honoured when it is not "en"',
    ids(applyPostQuery(posts, { kind: 'all', locale: 'de' }, 'de', KNOWN)).includes('none'));
}

/* ---------------- visibility ---------------- */
{
  const posts = [
    mk({ id: 'pub', status: 'published', author_id: 'u2' }),
    mk({ id: 'mine', status: 'draft', author_id: 'u1' }),
    mk({ id: 'theirs', status: 'draft', author_id: 'u2' }),
  ];
  check('no visibility clause returns everything', applyPostQuery(posts, { kind: 'all' }).total === 3);
  check('publishedOnly hides every draft',
    ids(applyPostQuery(posts, { kind: 'all', visibility: { publishedOnly: true } })).join() === 'pub');
  // The property that matters for an `author` role: their own drafts stay visible.
  check('orAuthorId keeps my own drafts and nobody else\'s',
    ids(applyPostQuery(posts, { kind: 'all', visibility: { publishedOnly: true, orAuthorId: 'u1' } }))
      .sort().join() === 'mine,pub');
}

/* ---------------- there is deliberately NO text search ---------------- */
{
  // Removed after shipping it twice. SQLite's LOWER() is ASCII-only, so a
  // Greek all-caps title folds in JS and not in SQL — the two drivers could
  // never agree, and the two live shops are Greek. Asserted here so that
  // re-adding it without a folded column fails loudly rather than quietly.
  const posts = [mk({ id: 'a', title: 'ΓΥΑΛΙΑ ΗΛΙΟΥ' })];
  const res = applyPostQuery(posts, { kind: 'all', search: 'γυαλια' });
  check('a `search` key in the query is ignored, not half-honoured',
    res.total === 1 && ids(res).join() === 'a');
}

/* ---------------- THE pagination properties ---------------- */
{
  const posts = Array.from({ length: 25 }, (_, i) => mk({
    id: `p${String(i).padStart(2, '0')}`,
    created_at: `2024-02-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
  }));

  const page1 = applyPostQuery(posts, { limit: 10, offset: 0 });
  check('a page returns exactly `limit` items', page1.items.length === 10);
  // Count BEFORE the slice, or hasMore goes false a page early and the reader
  // never sees the tail.
  check('total counts all matches, not the page', page1.total === 25);
  check('newest first by default', page1.items[0].id === 'p24');

  const page3 = applyPostQuery(posts, { limit: 10, offset: 20 });
  check('the last partial page returns the remainder', page3.items.length === 5);
  check('...with the same total', page3.total === 25);

  // Every row appears exactly once across the pages — the real pagination test.
  const walked = [
    ...applyPostQuery(posts, { limit: 10, offset: 0 }).items,
    ...applyPostQuery(posts, { limit: 10, offset: 10 }).items,
    ...applyPostQuery(posts, { limit: 10, offset: 20 }).items,
  ].map((p) => p.id);
  check('paging visits every row exactly once', new Set(walked).size === 25 && walked.length === 25);

  check('offset past the end yields an empty page, not an error',
    applyPostQuery(posts, { limit: 10, offset: 999 }).items.length === 0);
  check('no limit returns everything from the offset',
    applyPostQuery(posts, { offset: 20 }).items.length === 5);
  check('a negative offset is clamped', applyPostQuery(posts, { limit: 5, offset: -5 }).items.length === 5);
  check('asc sort reverses the order',
    applyPostQuery(posts, { limit: 1, sort: 'created_asc' }).items[0].id === 'p00');
}

/* ---------------- the sort must be TOTAL ---------------- */
{
  // Same timestamp on every row: without an `id` tiebreak the order is
  // whatever the engine felt like, and rows swap between pages.
  const same = ['c', 'a', 'b', 'e', 'd'].map((id) =>
    mk({ id, created_at: '2024-03-01T00:00:00.000Z' }));

  const first = applyPostQuery(same, { limit: 2 }).items.map((p) => p.id);
  const second = applyPostQuery(same, { limit: 2, offset: 2 }).items.map((p) => p.id);
  check('ties are broken deterministically', new Set([...first, ...second]).size === 4);
  check('...and repeating the query gives the same answer',
    applyPostQuery(same, { limit: 2 }).items.map((p) => p.id).join() === first.join());
  const all = applyPostQuery(same, {}).items.map((p) => p.id);
  check('...producing a stable total order', all.join() === 'e,d,c,b,a');
}

/* ---------------- it must not mutate what it was handed ---------------- */
{
  // Sorting the array a driver returned mutates its cache — the bug that let an
  // anonymous GET reorder the database.
  const posts = [mk({ id: 'a', created_at: '2024-01-01T00:00:00.000Z' }),
    mk({ id: 'b', created_at: '2024-06-01T00:00:00.000Z' })];
  const before = posts.map((p) => p.id).join();
  applyPostQuery(posts, {});
  check('the input array is not reordered', posts.map((p) => p.id).join() === before);
  check('an empty collection is handled', applyPostQuery([], { limit: 10 }).total === 0);
}


// ─────────────────────────────────── ordering (C-149)
{
  const P = (id, over = {}) => ({
    id, slug: id, title: id, status: 'published', kind: 'post',
    created_at: `2026-01-${String(over.day ?? 1).padStart(2, '0')}T00:00:00.000Z`,
    ...over,
  });
  const order = (rows, dir) => [...rows].sort((x, y) => comparePostsForListing(x, y, dir)).map((p) => p.id).join();

  // The whole reason the new comparator is safe as the DEFAULT rather than an
  // opt-in ?sort= a headless storefront would never send: every existing row
  // has neither field, so it must be byte-identical to date-descending.
  const plain = [P('a', { day: 1 }), P('b', { day: 3 }), P('c', { day: 2 })];
  const legacy = [...plain].sort((x, y) =>
    new Date(y.created_at).getTime() - new Date(x.created_at).getTime()
    || (x.id < y.id ? 1 : x.id > y.id ? -1 : 0)).map((p) => p.id).join();
  check('with no pins and no manual order, the order is EXACTLY as before', order(plain) === legacy);

  check('a pinned post leads, however old it is',
    order([P('new', { day: 9 }), P('old', { day: 1, pinned: true })]) === 'old,new');

  // An editor who positions three posts out of four hundred means "these three
  // at the front", not "these three, then chaos".
  check('manual position beats date, and ABSENT sorts LAST',
    order([P('none', { day: 9 }), P('second', { day: 1, menu_order: 2 }), P('first', { day: 1, menu_order: 1 })])
      === 'first,second,none');

  check('position 0 is the FRONT, not "unset"',
    order([P('a', { day: 9, menu_order: 5 }), P('b', { day: 1, menu_order: 0 })]) === 'b,a');

  check('pinned outranks manual position',
    order([P('ordered', { day: 9, menu_order: 1 }), P('pinned', { day: 1, pinned: true, menu_order: 99 })])
      === 'pinned,ordered');

  // "Oldest first" must not also mean "pinned last" — a pin is not a direction.
  check('created_asc flips the DATE only, never the pin',
    order([P('pin', { day: 5, pinned: true }), P('older', { day: 1 }), P('newer', { day: 9 })], 1)
      === 'pin,older,newer');

  const tied = [P('z', { day: 1 }), P('a', { day: 1 }), P('m', { day: 1 })];
  check('the order is TOTAL, so two drivers cannot disagree',
    order(tied) === order([...tied].reverse()));

  // NaN comparisons are all false, which silently makes the sort unstable.
  check('a non-numeric menu_order is treated as absent, not as NaN',
    order([P('junk', { day: 1, menu_order: 'x' }), P('real', { day: 1, menu_order: 3 })]) === 'real,junk');

  // ...and through the real query path, not just the comparator.
  const q = applyPostQuery([P('new', { day: 9 }), P('pin', { day: 1, pinned: true })], {});
  check('applyPostQuery uses it', q.items[0].id === 'pin');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
