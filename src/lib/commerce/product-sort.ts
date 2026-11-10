/**
 * Sorting search and listing results — the one vocabulary and the one sorter.
 *
 * ## Why this is its own module
 *
 * `GET /api/products` (catalogue and `?search=`) and `GET /api/search` (blog
 * posts) both need "order these by …". Two hand-written switches would drift
 * the first time one learned a value, and a storefront's sort menu would then
 * mean different things on two endpoints. The VALUES live here once, and each
 * route says which of them it can honour.
 *
 * ## The vocabulary
 *
 *   relevance   the default. With a search query: the ranked order (core's
 *               `rank.ts`, plus whatever a search module's expander widened).
 *               Without one: the shop's own merchandising order — explicit
 *               `position`, then newest.
 *   price_asc   cheapest first.
 *   price_desc  dearest first.
 *   newest      most recently created first.
 *   name_asc    A to Z, in the reader's language.
 *   name_desc   Z to A.
 *
 * ## What a "price" is
 *
 * The price a buyer would be CHARGED, i.e. the sale price while a sale is live
 * and the regular price otherwise — `price_cents`, which `deriveSaleState`
 * keeps equal to the charged amount on every write.
 *
 * The sort key is `price_from_cents`, which every product response now
 * carries (`withPriceRange` below): `price_cents` for a simple product, the
 * cheapest BUYABLE variant for a variable one. A variable product's own
 * `price_cents` is the parent's fallback and is not what is sold, so sorting
 * by it would be wrong and sorting by anything the response does not show
 * would be unverifiable. The key is exactly the field a client can read, which
 * is what the "sorted by the response's own price_from_cents" test checks.
 * Ascending and descending use the same key: ranking a variable product by its
 * dearest variant in one direction would put the same card at two unrelated
 * heights depending on the arrow.
 *
 * An unpriced product is STORED as 0 (`price_cents` is a required number), so
 * it sorts first on `price_asc`, as a free item would. "No price last" applies
 * only to a row with no finite figure at all (a row written around saveProduct).
 *
 * Prices are stored once, in the shop's base currency. A presentment currency
 * is that figure multiplied by one positive rate and rounded, which is
 * monotonic, so the ORDER is the same in every currency a storefront may show.
 * (Two products a cent apart can display the same converted amount; they then
 * keep the tie-break order below rather than flipping.)
 *
 * A product with no usable price sorts LAST in both directions. Putting it
 * first on "cheapest" would advertise a free item.
 *
 * ## Determinism
 *
 * Paging is only honest if the same query gives the same order every time. The
 * sort is stable: items whose key is equal keep the order they arrived in,
 * which for a search is relevance and then the shop's merchandising order, and
 * the caller finishes that order with the product id. Sorting by price over
 * `limit`/`offset` therefore never repeats or drops a product between pages.
 *
 * ## What is deliberately NOT here
 *
 * Popularity and rating: nothing in the catalogue records either, and a sort
 * key invented from nothing would be a ranking with a plausible name and no
 * meaning. They arrive with the data, not before it.
 */
import type { Product } from '../../core/models';
import { priceRange } from './variants';

/** Every value `?sort=` may carry. Order is the order a menu should list them. */
export const SORT_VALUES = ['relevance', 'price_asc', 'price_desc', 'newest', 'name_asc', 'name_desc'] as const;
export type SortValue = (typeof SORT_VALUES)[number];

export const DEFAULT_SORT: SortValue = 'relevance';

export type SortParse =
  | { ok: true; sort: SortValue }
  | { ok: false; allowed: readonly SortValue[] };

/**
 * Read a `?sort=` value.
 *
 * Absent or empty means the default; anything else must match a value EXACTLY
 * (lower case, as published) and be one of `allowed`. An unknown value is a
 * refusal, not a fallback: a storefront whose menu sends `price-asc` would
 * otherwise show an unsorted list under a "Price: low to high" label and never
 * find out.
 */
export function parseSort(
  raw: string | null | undefined,
  allowed: readonly SortValue[] = SORT_VALUES,
): SortParse {
  if (raw === null || raw === undefined || raw === '') return { ok: true, sort: DEFAULT_SORT };
  const hit = SORT_VALUES.find((v) => v === raw);
  if (hit && allowed.includes(hit)) return { ok: true, sort: hit };
  return { ok: false, allowed };
}

/** What a buyer is charged for this product, or null when there is no usable figure. */
export function sortPriceCents(
  product: Pick<Product, 'price_cents' | 'variants'>,
): number | null {
  return withPriceRange(product).price_from_cents;
}

/**
 * Add the read-only, derived-on-read price band to a product response.
 *
 * `price_from_cents` is the sort key; `price_to_cents` is the dearest buyable
 * variant, so a card can say "from €8" only when there is a range. Both are
 * recomputed on every read — never stored, never accepted from a client — so
 * they cannot be stale or forged. For a simple product both equal `price_cents`.
 */
export function withPriceRange<T extends Pick<Product, 'price_cents' | 'variants'>>(
  product: T,
): T & { price_from_cents: number | null; price_to_cents: number | null } {
  // A grouped product has no price of its own: withGroup (commerce/grouped.ts)
  // has already set its "from" price to the cheapest visible member, or null
  // when none is visible. Re-deriving it here from `price_cents` would turn
  // that null into 0 and sort an empty group as free.
  if ((product as { type?: string }).type === 'grouped' && 'price_from_cents' in product) {
    const from = (product as { price_from_cents?: number | null }).price_from_cents ?? null;
    return { ...product, price_from_cents: from, price_to_cents: from };
  }
  const range = priceRange(product as unknown as Product);
  const fallback = typeof product.price_cents === 'number' && Number.isFinite(product.price_cents)
    ? product.price_cents : null;
  return {
    ...product,
    price_from_cents: range ? range.min : fallback,
    price_to_cents: range ? range.max : fallback,
  };
}

/** How a caller tells the sorter where to read each key from. */
export interface SortKeys<T> {
  price?: (item: T) => number | null;
  /** ISO timestamp. Missing sorts last. */
  created?: (item: T) => string | undefined | null;
  name?: (item: T) => string | undefined | null;
}

function collatorFor(locale?: string): Intl.Collator {
  const options = { numeric: true, sensitivity: 'base' } as const;
  try {
    return new Intl.Collator(locale || undefined, options);
  } catch {
    // An unrecognisable tag must not 500 a public listing.
    return new Intl.Collator(undefined, options);
  }
}

/**
 * Reorder `items` by `sort`. Pure; returns a new array.
 *
 * `relevance` returns the input order untouched — the caller's ranking IS the
 * relevance order, and a paid search module's wider matches have already been
 * ranked by the time they reach here.
 */
export function sortItems<T>(
  items: readonly T[],
  sort: SortValue,
  keys: SortKeys<T>,
  locale?: string,
): T[] {
  if (sort === 'relevance') return items.slice();
  const collator = sort === 'name_asc' || sort === 'name_desc' ? collatorFor(locale) : null;
  // Keys are read ONCE per item, not once per comparison: the name key can run
  // a translation projection, and a comparator calls it O(n log n) times.
  const decorated = items.map((item, index) => ({
    item,
    index,
    price: sort === 'price_asc' || sort === 'price_desc' ? keys.price?.(item) ?? null : null,
    created: sort === 'newest' ? keys.created?.(item) ?? '' : '',
    name: collator ? keys.name?.(item) ?? '' : '',
  }));

  decorated.sort((a, b) => {
    let delta = 0;
    if (sort === 'price_asc' || sort === 'price_desc') {
      const pa = a.price;
      const pb = b.price;
      // No price: last, whichever way the list runs.
      if (pa === null || pb === null) {
        if (pa === pb) delta = 0; else return pa === null ? 1 : -1;
      } else {
        delta = sort === 'price_asc' ? pa - pb : pb - pa;
      }
    } else if (sort === 'newest') {
      const ca = a.created;
      const cb = b.created;
      if (!ca || !cb) {
        if (ca === cb) delta = 0; else return ca ? -1 : 1;
      } else {
        delta = ca < cb ? 1 : ca > cb ? -1 : 0;
      }
    } else if (collator) {
      const na = a.name;
      const nb = b.name;
      if (!na || !nb) {
        if (na === nb) delta = 0; else return na ? -1 : 1;
      } else {
        delta = collator.compare(na, nb);
        if (sort === 'name_desc') delta = -delta;
      }
    }
    return delta !== 0 ? delta : a.index - b.index;
  });
  return decorated.map((d) => d.item);
}

/** The product keys, in one place so the route and the tests read the same. */
export const PRODUCT_SORT_KEYS: SortKeys<Product> = {
  price: sortPriceCents,
  created: (p) => p.created_at,
  name: (p) => p.name,
};
