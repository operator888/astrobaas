/**
 * Product categories as a tree.
 *
 * Categories have carried `parent_slug` for a long time, and the product form
 * already drew them indented. Two things were missing, and together they meant
 * the tree existed only on screen:
 *
 * 1. **Browsing a parent showed none of its children's products.** A shop with
 *    Clothing › Shirts tags a shirt "shirts"; `?category=clothing` matched only
 *    products tagged "clothing" itself, so the Clothing page of the storefront
 *    was empty. Every commerce platform a merchant has used before includes the
 *    subcategories; `descendantSlugs` is how this one now does too.
 *
 * 2. **Nothing checked a parent on the way in.** `parent_slug` was a free-form
 *    string, so a category could name a parent that did not exist, or — once
 *    re-parenting became possible — its own descendant, which makes a loop that
 *    any tree walk would follow forever. The admin's DISPLAY guarded against
 *    both; the data did not. `parentProblem` refuses them at the door.
 *
 * Pure functions over the category list, so every rule is testable without a
 * database. Every walk carries a visited set: data written before these checks
 * existed may already contain a loop, and a tree walk must terminate on it.
 */
import type { ProductCategory } from '../../core/models';

/** How deep a tree may go. Past this a storefront menu stops being usable. */
export const MAX_CATEGORY_DEPTH = 5;

type Node = Pick<ProductCategory, 'slug'> & { parent_slug?: string | null; id?: string };

/** Children of each slug, built once per call. */
function childrenBySlug(categories: readonly Node[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const c of categories) {
    const parent = c.parent_slug || '';
    if (!parent) continue;
    const list = map.get(parent) ?? [];
    list.push(c.slug);
    map.set(parent, list);
  }
  return map;
}

/**
 * A category and every category beneath it, as a set of slugs.
 *
 * The set always contains `slug` itself, even when no category with that slug
 * exists — a storefront asking for `?category=x` must get "products tagged x",
 * exactly as it did before trees were followed, rather than nothing.
 */
export function descendantSlugs(slug: string, categories: readonly Node[]): Set<string> {
  const children = childrenBySlug(categories);
  const out = new Set<string>([slug]);
  const queue = [slug];
  while (queue.length) {
    const next = queue.shift()!;
    for (const child of children.get(next) ?? []) {
      if (out.has(child)) continue; // a loop in old data: stop, never spin
      out.add(child);
      queue.push(child);
    }
  }
  return out;
}

/** Depth of a category: 1 for a top-level one. Loops count as the depth reached. */
export function categoryDepth(slug: string, categories: readonly Node[]): number {
  const bySlug = new Map(categories.map((c) => [c.slug, c]));
  const seen = new Set<string>();
  let depth = 0;
  let cur: string | undefined = slug;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    depth++;
    cur = bySlug.get(cur)?.parent_slug || undefined;
  }
  return depth;
}

/** How many levels sit below a category (0 for a leaf). */
function heightBelow(slug: string, categories: readonly Node[]): number {
  const children = childrenBySlug(categories);
  const walk = (s: string, seen: Set<string>): number => {
    let best = 0;
    for (const c of children.get(s) ?? []) {
      if (seen.has(c)) continue;
      best = Math.max(best, 1 + walk(c, new Set(seen).add(c)));
    }
    return best;
  };
  return walk(slug, new Set([slug]));
}

/**
 * Can `slug` be placed under `parent`? Null when it can, otherwise a sentence
 * for the admin screen.
 *
 * `slug` may be a category that does not exist yet (creating one) — then only
 * the parent's existence and depth matter. An empty or null parent means "top
 * level", which is always allowed.
 */
export function parentProblem(
  slug: string,
  parent: string | null | undefined,
  categories: readonly Node[],
): string | null {
  if (!parent) return null;
  if (parent === slug) return 'A category cannot be its own parent.';
  const exists = categories.some((c) => c.slug === parent);
  if (!exists) return `There is no category "${parent}" to put it under.`;
  // Under one of its own descendants would close a loop.
  if (descendantSlugs(slug, categories).has(parent)) {
    return `"${parent}" is inside this category already — moving it there would make a loop.`;
  }
  const depth = categoryDepth(parent, categories) + 1 + heightBelow(slug, categories);
  if (depth > MAX_CATEGORY_DEPTH) {
    return `That would make the tree ${depth} levels deep; at most ${MAX_CATEGORY_DEPTH} are allowed.`;
  }
  return null;
}

/**
 * The categories in display order — parent, then its children, each level
 * sorted by position then name — with a depth for indenting.
 *
 * Orphans (a parent that was deleted) and anything caught in a loop are listed
 * at the top level rather than dropped: a category the operator cannot SEE is
 * one they cannot fix.
 */
export function flattenTree<T extends Node & { name: string; position?: number }>(
  categories: readonly T[],
  /** Collation for names at one level, e.g. 'el' so Greek sorts as Greek. */
  opts: { collation?: string } = {},
): { cat: T; depth: number }[] {
  const bySlug = new Map(categories.map((c) => [c.slug, c]));
  const byParent = new Map<string, T[]>();
  for (const c of categories) {
    const parent = c.parent_slug && bySlug.has(c.parent_slug) ? c.parent_slug : '';
    const list = byParent.get(parent) ?? [];
    list.push(c);
    byParent.set(parent, list);
  }
  // A category with no position sorts AFTER the positioned ones, not among
  // them at 0 — otherwise adding the first position to one category shoves
  // every unpositioned one above it.
  const pos = (c: T) => c.position ?? Number.MAX_SAFE_INTEGER;
  const order = (a: T, b: T) => pos(a) - pos(b) || a.name.localeCompare(b.name, opts.collation);
  const out: { cat: T; depth: number }[] = [];
  const placed = new Set<string>();
  const walk = (parent: string, depth: number) => {
    // Bounded as well as loop-guarded. Writes are capped at MAX_CATEGORY_DEPTH,
    // but a 50-deep chain in old data would still wreck the indentation; what
    // this skips is picked up at the top level by the pass below.
    if (depth > MAX_CATEGORY_DEPTH + 1) return;
    for (const c of (byParent.get(parent) ?? []).sort(order)) {
      if (placed.has(c.slug)) continue;
      placed.add(c.slug);
      out.push({ cat: c, depth });
      walk(c.slug, depth + 1);
    }
  };
  walk('', 0);
  // Whatever a loop kept unreachable from the top.
  for (const c of [...categories].sort(order)) {
    if (!placed.has(c.slug)) { placed.add(c.slug); out.push({ cat: c, depth: 0 }); walk(c.slug, 1); }
  }
  return out;
}
