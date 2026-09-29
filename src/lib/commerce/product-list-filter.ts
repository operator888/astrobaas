/**
 * The admin product list's search, as one function.
 *
 * The list page filters with it, and bulk edit's "select all N matching" asks
 * the server for exactly the same set — two copies would disagree the first
 * time one of them learned a new field, and "all matching" would then change
 * products the operator never saw in the list.
 *
 * Newest first; `q` is matched against name, SKU, brand, GTIN and tags, folded
 * the way the browser folds ("cafe" finds "Café").
 */
import { foldForSearch } from '../text-search';

interface Listable {
  name: string;
  sku?: string;
  brand?: string;
  gtin?: string;
  tags?: string[];
  created_at?: string;
}

export function productListMatches<T extends Listable>(products: readonly T[], q: string): T[] {
  const newestFirst = products.slice().sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));
  const folded = foldForSearch(q.trim());
  if (!folded) return newestFirst;
  return newestFirst.filter((p) =>
    foldForSearch(`${p.name} ${p.sku ?? ''} ${p.brand ?? ''} ${p.gtin ?? ''} ${(p.tags ?? []).join(' ')}`).includes(folded));
}
