/**
 * Search suggestions: what a search box offers while someone is still typing.
 *
 * A PURE function over what the route has already loaded, so every rule is
 * testable without a database. It reuses the site search's own ranking
 * (`rankBy`): the same accent and case folding, the same Greek-matches-Latin
 * behaviour, the same synonym expander. A suggestion list that disagreed with
 * the results page it leads to would be worse than none.
 *
 * ## Deliberately small
 *
 * A handful per type, titles and slugs only. It runs on every keystroke that
 * survives the debounce, so it must be cheap to compute and cheap to send.
 * There is no typo tolerance here: that belongs to the paid Advanced Search
 * module, which reaches this list through the same expander hook as search.
 *
 * ## Who sees what
 *
 * Only what the same visitor could open:
 *  - posts and pages that are published and not hidden from search;
 *  - products that are active AND listed for search. A product's catalogue
 *    visibility decides it: `visible` and `search` appear, `catalog` (shelves
 *    only) and `hidden` (link only) do not;
 *  - product categories, each with the number of products it holds.
 * Products and categories are included only when the route says the shop is
 * switched on — a site that is not a shop has no shop to suggest.
 */
import { rankBy, PRODUCT_WEIGHTS, POST_WEIGHTS, queryTerms, type TermExpander } from './rank';

export const SUGGEST_TYPES = ['searches', 'posts', 'pages', 'products', 'categories'] as const;
export type SuggestType = (typeof SUGGEST_TYPES)[number];

/** The most of one type a request may ask for. */
export const MAX_PER_TYPE = 8;
/** A query shorter than this suggests nothing: one letter matches half the catalogue. */
export const MIN_QUERY = 2;

interface PostLike { id: string; title: string; slug: string; excerpt?: string; status: string; kind?: string; noindex?: boolean; featured_image?: string }
interface ProductLike { id: string; name: string; slug: string; sku?: string; brand?: string; tags?: string[]; status: string; catalog_visibility?: string; price_cents: number; images?: { src: string; alt?: string; kind?: string }[] }
interface CategoryLike { slug: string; name: string }

export interface Suggestions {
  /** Popular searches that start with what was typed — see popular.ts for who may appear here. */
  searches: string[];
  posts: { title: string; slug: string }[];
  pages: { title: string; slug: string }[];
  products: { name: string; slug: string; price_cents: number; image: string | null }[];
  categories: { name: string; slug: string; count: number }[];
}

export function searchableProduct(p: ProductLike): boolean {
  if (p.status !== 'active') return false;
  const v = p.catalog_visibility ?? 'visible';
  return v === 'visible' || v === 'search';
}

export function suggest(input: {
  q: string;
  types: readonly SuggestType[];
  limit: number;
  posts?: readonly PostLike[];
  products?: readonly ProductLike[];
  categories?: readonly CategoryLike[];
  /** Products per category slug, from the same counting the category list uses. */
  categoryCounts?: ReadonlyMap<string, number>;
  expand?: TermExpander;
  /** Popular searches already chosen for this query (popularFor), most searched first. */
  popular?: readonly string[];
}): Suggestions {
  const out: Suggestions = { searches: [], posts: [], pages: [], products: [], categories: [] };
  if (queryTerms(input.q).join('').length < MIN_QUERY) return out;
  const limit = Math.max(1, Math.min(MAX_PER_TYPE, Math.trunc(input.limit) || 5));
  const want = new Set(input.types);
  const opts = { expand: input.expand };

  if (want.has('searches')) out.searches = (input.popular ?? []).slice(0, limit);

  const visiblePosts = (input.posts ?? []).filter((p) => p.status === 'published' && !p.noindex);
  if (want.has('posts')) {
    out.posts = rankBy(visiblePosts.filter((p) => (p.kind ?? 'post') === 'post'), input.q,
      (p) => [{ text: p.title, weight: POST_WEIGHTS.title }, { text: p.excerpt ?? '', weight: POST_WEIGHTS.excerpt }], opts)
      .slice(0, limit).map(({ item }) => ({ title: item.title, slug: item.slug }));
  }
  if (want.has('pages')) {
    out.pages = rankBy(visiblePosts.filter((p) => p.kind === 'page'), input.q,
      (p) => [{ text: p.title, weight: POST_WEIGHTS.title }], opts)
      .slice(0, limit).map(({ item }) => ({ title: item.title, slug: item.slug }));
  }
  if (want.has('products')) {
    out.products = rankBy((input.products ?? []).filter(searchableProduct), input.q, (p) => [
      { text: p.name, weight: PRODUCT_WEIGHTS.name },
      { text: p.sku ?? '', weight: PRODUCT_WEIGHTS.sku },
      { text: p.brand ?? '', weight: PRODUCT_WEIGHTS.brand },
      { text: (p.tags ?? []).join(' '), weight: PRODUCT_WEIGHTS.tags },
    ], opts)
      .slice(0, limit)
      .map(({ item }) => ({
        name: item.name,
        slug: item.slug,
        price_cents: item.price_cents,
        image: item.images?.find((i) => (i.kind ?? 'image') === 'image')?.src ?? null,
      }));
  }
  if (want.has('categories')) {
    out.categories = rankBy(input.categories ?? [], input.q, (c) => [{ text: c.name, weight: 6 }], opts)
      .slice(0, limit)
      .map(({ item }) => ({ name: item.name, slug: item.slug, count: input.categoryCounts?.get(item.slug) ?? 0 }));
  }
  return out;
}

/** `?types=posts,products` → the known ones, in a fixed order; unknown names are ignored. */
export function parseTypes(raw: string | null, allowed: readonly SuggestType[]): SuggestType[] {
  if (!raw) return [...allowed];
  const asked = new Set(raw.split(',').map((s) => s.trim()));
  return allowed.filter((t) => asked.has(t));
}
