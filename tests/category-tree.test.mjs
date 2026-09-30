#!/usr/bin/env node
/**
 * Product categories as a tree (src/lib/commerce/category-tree.ts).
 *
 * The three things that were wrong, each pinned here:
 *
 *  - browsing a parent showed none of its subcategories' products;
 *  - a parent was never checked, so a category could name one that did not
 *    exist, or — once moving became possible — sit inside its own subtree;
 *  - the product form and the new categories screen each needed a tree walk,
 *    and two walkers can disagree about exactly the cases (a loop, an orphan)
 *    that user data produces.
 *
 * Every walk must TERMINATE on a loop. Data written before these checks may
 * already contain one, and a hung walk is a hung admin page.
 *
 * Run with:  node tests/category-tree.test.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadTs, ROOT } from './lib/load.mjs';

const T = await loadTs('src/lib/commerce/category-tree.ts');
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
const sorted = (set) => [...set].sort();

// Clothing › Shirts › Linen, Clothing › Trousers, and a separate Shoes.
const shop = [
  { slug: 'clothing', name: 'Clothing' },
  { slug: 'shirts', name: 'Shirts', parent_slug: 'clothing' },
  { slug: 'linen', name: 'Linen', parent_slug: 'shirts' },
  { slug: 'trousers', name: 'Trousers', parent_slug: 'clothing' },
  { slug: 'shoes', name: 'Shoes' },
];

// ─────────────────────────────────────────────────── descendants

check('a category includes everything beneath it, at every depth', () => {
  eq(sorted(T.descendantSlugs('clothing', shop)), ['clothing', 'linen', 'shirts', 'trousers']);
});

check('a leaf is just itself', () => {
  eq(sorted(T.descendantSlugs('linen', shop)), ['linen']);
});

check('a slug with no category behind it still means that slug — the old behaviour', () => {
  eq(sorted(T.descendantSlugs('not-a-category', shop)), ['not-a-category']);
});

check('a loop in stored data terminates instead of hanging', () => {
  const loop = [{ slug: 'a', parent_slug: 'b' }, { slug: 'b', parent_slug: 'a' }];
  eq(sorted(T.descendantSlugs('a', loop)), ['a', 'b']);
});

// ─────────────────────────────────────────────────────── depth

check('depth counts levels from the top', () => {
  eq(T.categoryDepth('clothing', shop), 1);
  eq(T.categoryDepth('linen', shop), 3);
});

check('depth terminates on a loop', () => {
  const loop = [{ slug: 'a', parent_slug: 'b' }, { slug: 'b', parent_slug: 'a' }];
  ok(T.categoryDepth('a', loop) <= 2, 'depth walked forever');
});

// ───────────────────────────────────────────────────── moving

check('the top level is always allowed', () => {
  eq(T.parentProblem('shirts', null, shop), null);
  eq(T.parentProblem('shirts', '', shop), null);
});

check('an ordinary move is allowed', () => {
  eq(T.parentProblem('shoes', 'clothing', shop), null);
});

check('a new category may go under an existing one', () => {
  eq(T.parentProblem('boots', 'shoes', shop), null);
});

check('a category cannot be its own parent', () => {
  ok(T.parentProblem('shirts', 'shirts', shop), 'accepted itself');
});

check('a parent that does not exist is refused — it used to be any string', () => {
  ok(/no category "clohting"/.test(T.parentProblem('shoes', 'clohting', shop) ?? ''), 'accepted a typo');
});

check('moving a category into its own subtree is refused — that is a loop', () => {
  const msg = T.parentProblem('clothing', 'linen', shop);
  ok(msg && /loop/.test(msg), `accepted: ${msg}`);
});

check('a move that would go past the depth limit counts the subtree that moves with it', () => {
  // A chain 1..4 deep, and a category with two levels beneath it: putting that
  // category under level 4 makes 4 + 1 + 2 = 7 levels.
  const deep = [
    { slug: 'l1' }, { slug: 'l2', parent_slug: 'l1' }, { slug: 'l3', parent_slug: 'l2' }, { slug: 'l4', parent_slug: 'l3' },
    { slug: 'mover' }, { slug: 'm1', parent_slug: 'mover' }, { slug: 'm2', parent_slug: 'm1' },
  ];
  ok(T.parentProblem('mover', 'l4', deep), 'accepted a tree deeper than the limit');
  eq(T.parentProblem('mover', 'l1', deep), null, 'refused a move that fits');
});

// ────────────────────────────────────────────── one walker, for display

check('parents come before their children, children indented', () => {
  const out = T.flattenTree(shop.map((c) => ({ ...c })));
  const at = (slug) => out.findIndex((r) => r.cat.slug === slug);
  ok(at('clothing') < at('shirts') && at('shirts') < at('linen'), 'order broken');
  eq(out.find((r) => r.cat.slug === 'linen').depth, 2);
});

check('a category with no position sorts after the positioned ones', () => {
  const out = T.flattenTree([
    { slug: 'z', name: 'Zeta', position: 1 },
    { slug: 'a', name: 'Alpha' },
    { slug: 'b', name: 'Beta', position: 0 },
  ]);
  eq(out.map((r) => r.cat.slug), ['b', 'z', 'a']);
});

check('an orphan is shown at the top with its own subtree intact', () => {
  const out = T.flattenTree([
    { slug: 'orphan', name: 'Orphan', parent_slug: 'deleted-long-ago' },
    { slug: 'kid', name: 'Kid', parent_slug: 'orphan' },
  ]);
  eq(out.map((r) => [r.cat.slug, r.depth]), [['orphan', 0], ['kid', 1]]);
});

check('loop data: every category appears exactly once, and nothing hangs', () => {
  const out = T.flattenTree([
    { slug: 'a', name: 'A', parent_slug: 'b' },
    { slug: 'b', name: 'B', parent_slug: 'a' },
    { slug: 'c', name: 'C' },
  ]);
  eq(out.map((r) => r.cat.slug).sort(), ['a', 'b', 'c']);
});

// ───────────────────────────────────────────────── wired where it counts

{
  const service = await read('src/lib/commerce-service.ts');
  check('the product filter includes subcategories', () => {
    ok(/descendantSlugs\(cat, allCategories\)/.test(service), 'the filter does not expand the category');
    ok(/\.some\(\(s\) => wanted\.has\(s\)\)/.test(service), 'products are not matched against the expanded set');
    ok(!/\.includes\(cat\)\)/.test(service), 'an exact-match filter is still in there');
  });

  const form = await read('src/pages/admin/products.astro');
  check('the product form uses the shared walker, not a second one', () => {
    ok(/flattenTree\(categories/.test(form), 'products.astro does not call flattenTree');
    ok(!/const walk = \(parent: string, depth: number\)/.test(form), 'a private walker is still in products.astro');
  });
  check('the product form sends managers to PRODUCT categories, not blog ones', () => {
    ok(/href="\/admin\/product-categories"/.test(form), 'the link still points somewhere else');
    ok(!/href="\/admin\/categories"/.test(form), 'the blog-categories link is still there');
  });

  const route = await read('src/pages/api/product-categories/[id].ts');
  check('moves are checked on the server, not only in the picker', () => {
    ok(/parentProblem\(existing\.slug/.test(route), 'PUT does not check the parent');
  });
  const create = await read('src/pages/api/product-categories/index.ts');
  check('creating a category checks its parent too', () => {
    ok(/parentProblem\(slug, parent, existing\)/.test(create), 'POST does not check the parent');
  });
  check('deleting a category untags products through saveProduct, so hooks and webhooks fire', () => {
    ok(/saveProduct\(\{ categories: cats\.filter/.test(route), 'DELETE does not untag through saveProduct');
    ok(!/LocalDB\.updateProduct\(/.test(route), 'a raw storage write is still in the route');
    ok(route.indexOf('saveProduct({ categories') < route.indexOf('LocalDB.deleteProductCategory('), 'the category is deleted before its products are untagged');
  });
  const counter = await read('src/lib/commerce/category-counts.ts');
  check('the public counts are one pass over the products, by effective membership', () => {
    ok(/countProductsByCategory\(/.test(create), 'the category list does not use the shared counter');
    ok(/effectiveCategories\(p, withRules, now, brands\)/.test(counter), 'counts ignore automatic collection rules');
    ok(!/descendantSlugs\(/.test(create) && !/descendantSlugs\(/.test(counter), 'the per-category tree walk (categories x products) is back');
  });
  check('a name of spaces is refused on create and rename', () => {
    ok(/if \(!result\.value\.name\.trim\(\)\) return/.test(create), 'POST accepts a blank name');
    ok(/if \(!b\.name\.trim\(\)\) return/.test(route), 'PUT accepts a blank name');
  });
  check('creating a category is audited, like renaming and deleting', () => {
    ok(/recordAudit\(AUDIT\.PRODUCT_CATEGORY_CREATE/.test(create), 'POST writes no audit entry');
  });
}

if (failures.length) {
  console.error(`\n✗ category-tree: ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error(`  · ${f}`);
  process.exit(1);
}
console.log(`✓ category-tree: ${passed} passed`);
