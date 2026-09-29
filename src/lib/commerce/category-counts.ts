/**
 * How many products each category holds — once, for every reader.
 *
 * The public category list and search suggestions both show these numbers, and
 * two counters would disagree the first time one of them learned a new rule.
 *
 * One pass over the products. Membership is what the listing uses —
 * `effectiveCategories`, so a category's automatic rule (and its "rule only"
 * mode) counts the same products `?category=` returns. `direct` is membership
 * itself; `total` adds every ancestor, so "Clothing" includes the shirts, and a
 * product in two subcategories of one parent counts once there.
 *
 * Only active products count: a draft is not something a shopper can find.
 */
import type { Product, ProductCategory } from '../../core/models';
import { effectiveCategories } from './collections';
import { buildBrandDirectory } from './brand';

export interface CategoryCounts {
  direct: Map<string, number>;
  total: Map<string, number>;
}

export async function countProductsByCategory(
  products: readonly Product[],
  cats: readonly ProductCategory[],
  loadBrands: () => Promise<Parameters<typeof buildBrandDirectory>[1]>,
  now = Date.now(),
): Promise<CategoryCounts> {
  const withRules = cats.filter((c) => (c as { rule?: unknown }).rule);
  const needsBrands = withRules.some((c) => ((c as { rule?: { conditions?: { field?: unknown }[] } }).rule?.conditions ?? [])
    .some((k) => k?.field === 'brand'));
  const brands = needsBrands ? buildBrandDirectory(products as Product[], await loadBrands()) : undefined;
  const parentOf = new Map(cats.map((c) => [c.slug, c.parent_slug || '']));
  const direct = new Map<string, number>();
  const total = new Map<string, number>();
  for (const p of products) {
    if (p.status !== 'active') continue;
    // A row written around saveProduct can lack `categories`; iterating
    // undefined turned the public category menu into a 500.
    const own = withRules.length ? effectiveCategories(p, withRules, now, brands) : (p.categories ?? []);
    const within = new Set<string>();
    for (const slug of own) {
      direct.set(slug, (direct.get(slug) ?? 0) + 1);
      // Up the tree, stopping at the top or at a loop in old data.
      let cur: string | undefined = slug;
      while (cur && !within.has(cur)) {
        within.add(cur);
        cur = parentOf.get(cur) || undefined;
      }
    }
    for (const slug of within) total.set(slug, (total.get(slug) ?? 0) + 1);
  }
  return { direct, total };
}
