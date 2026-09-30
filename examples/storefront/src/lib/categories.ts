/**
 * The category tree, for the shop's side navigation and breadcrumbs.
 *
 * The CMS sends a flat list with `parent_slug`, and already expands a category
 * to include its subcategories when asked for products — so this file is only
 * about DISPLAY: nesting, order, and the path from the top to one category.
 *
 * Every walk carries a visited set. The CMS refuses loops on write, but data
 * written by an older version may still hold one, and a build that hangs on a
 * loop is a shop that cannot be deployed.
 */

export interface CategoryLike {
  slug: string;
  name: string;
  parent_slug?: string | null;
  position?: number;
  product_count_total?: number;
}

export interface CategoryNode<T extends CategoryLike = CategoryLike> {
  cat: T;
  children: CategoryNode<T>[];
}

const order = (a: CategoryLike, b: CategoryLike) =>
  (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER) || a.name.localeCompare(b.name);

/**
 * Nest the flat list. A category whose parent is missing is shown at the top
 * rather than dropped — hidden is worse than misplaced.
 */
export function buildTree<T extends CategoryLike>(cats: readonly T[]): CategoryNode<T>[] {
  const bySlug = new Map(cats.map((c) => [c.slug, c]));
  const kids = new Map<string, T[]>();
  for (const c of cats) {
    const parent = c.parent_slug && bySlug.has(c.parent_slug) ? c.parent_slug : '';
    kids.set(parent, [...(kids.get(parent) ?? []), c]);
  }
  const placed = new Set<string>();
  const walk = (parent: string): CategoryNode<T>[] =>
    [...(kids.get(parent) ?? [])].sort(order).flatMap((c) => {
      if (placed.has(c.slug)) return [];
      placed.add(c.slug);
      return [{ cat: c, children: walk(c.slug) }];
    });
  const roots = walk('');
  // Anything a loop kept unreachable from the top.
  for (const c of [...cats].sort(order)) {
    if (!placed.has(c.slug)) { placed.add(c.slug); roots.push({ cat: c, children: walk(c.slug) }); }
  }
  return roots;
}

/** Top-level first, ending with the category itself. Empty when unknown. */
export function pathTo<T extends CategoryLike>(slug: string, cats: readonly T[]): T[] {
  const bySlug = new Map(cats.map((c) => [c.slug, c]));
  const out: T[] = [];
  const seen = new Set<string>();
  let cur = bySlug.get(slug);
  while (cur && !seen.has(cur.slug)) {
    seen.add(cur.slug);
    out.unshift(cur);
    cur = cur.parent_slug ? bySlug.get(cur.parent_slug) : undefined;
  }
  return out;
}
