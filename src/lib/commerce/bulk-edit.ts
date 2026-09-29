/**
 * Bulk product edit: what one batch change does to each product.
 *
 * A PURE planner. Given the selected products and the operations, it returns,
 * per product, the partial update to hand to `saveProduct` and a sentence per
 * change for the preview — or the reason the product is skipped. The route
 * previews by calling this and applying nothing, and applies by saving each
 * patch through `saveProduct`, so a bulk edit is exactly N ordinary edits:
 * every rule, hook, webhook, price-history entry and audit line a single edit
 * has, each product in the batch has too.
 *
 * ## Money
 *
 * Prices change on the REGULAR price. `saveProduct` then derives the effective
 * price, the sale state and the Omnibus history from it, as it does for any
 * edit — so a product on sale stays on sale, and a raise that lifts the regular
 * price above the sale price leaves the sale in place. Arithmetic is on integer
 * minor units: a percentage rounds half away from zero, and nothing goes below
 * zero.
 *
 * Variants that carry their OWN price move with the product for a percentage
 * or amount change. A flat "set every price to X" is refused for those
 * products, not applied: it would flatten deliberately different variant
 * prices (a 52 mm frame and a 58 mm frame) into one, which is almost never what
 * "set the price" meant for them.
 */
import type { Product, ProductVariant } from '../../core/models';
import { descendantSlugs } from './category-tree';

/**
 * Most products one request may touch. "Select all N matching" can reach it,
 * so it bounds the request too: every product is its own save, and on the JSON
 * driver every save rewrites the database file.
 */
export const MAX_BULK = 1000;

/**
 * "Only where…": a condition each selected product must meet to be changed.
 * Products that do not meet it are left alone and counted as not matching —
 * "publish the drafts among these", "discount what is in stock".
 */
export interface BulkWhere {
  status?: Array<'active' | 'draft' | 'archived'>;
  /** in = tracked and above 0; out = tracked and 0; untracked = no count kept. */
  stock?: 'in' | 'out' | 'untracked';
  on_sale?: boolean;
  featured?: boolean;
  /** A category slug; its subcategories count as inside it. Stored membership, not automatic rules. */
  category?: string;
  /** Effective price bounds, in minor units, inclusive. */
  price_min?: number;
  price_max?: number;
}

export function whereProblem(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) return 'The condition must be an object.';
  const w = raw as Record<string, unknown>;
  const known = ['status', 'stock', 'on_sale', 'featured', 'category', 'price_min', 'price_max'];
  const unknown = Object.keys(w).filter((k) => !known.includes(k));
  if (unknown.length) return `Unknown condition: ${unknown.join(', ')}.`;
  if (w.status !== undefined && (!Array.isArray(w.status) || !w.status.length || w.status.some((x) => !['active', 'draft', 'archived'].includes(x as string)))) {
    return 'A status condition lists active, draft or archived.';
  }
  if (w.stock !== undefined && !['in', 'out', 'untracked'].includes(w.stock as string)) return 'A stock condition is in, out or untracked.';
  for (const k of ['on_sale', 'featured']) if (w[k] !== undefined && typeof w[k] !== 'boolean') return `${k} must be true or false.`;
  if (w.category !== undefined && (typeof w.category !== 'string' || !w.category.trim())) return 'A category condition names one category.';
  for (const k of ['price_min', 'price_max']) {
    if (w[k] !== undefined && (!Number.isInteger(w[k]) || (w[k] as number) < 0)) return `${k} must be a whole, non-negative number of minor units.`;
  }
  if (typeof w.price_min === 'number' && typeof w.price_max === 'number' && w.price_min > w.price_max) return 'The lowest price is above the highest.';
  return null;
}

export function matchesWhere(p: Product, where: BulkWhere | undefined, categories: readonly { slug: string; parent_slug?: string | null }[] = []): boolean {
  if (!where) return true;
  if (where.status && !where.status.includes(p.status)) return false;
  if (where.stock) {
    const s = p.stock ?? null;
    const state = s === null ? 'untracked' : s > 0 ? 'in' : 'out';
    if (state !== where.stock) return false;
  }
  if (where.on_sale !== undefined && !!p.on_sale !== where.on_sale) return false;
  if (where.featured !== undefined && !!p.featured !== where.featured) return false;
  if (where.category) {
    const within = descendantSlugs(where.category, categories);
    if (!(p.categories ?? []).some((c) => within.has(c))) return false;
  }
  if (where.price_min !== undefined && p.price_cents < where.price_min) return false;
  if (where.price_max !== undefined && p.price_cents > where.price_max) return false;
  return true;
}

export type PriceOp =
  | { mode: 'set'; value: number }
  | { mode: 'percent'; value: number }
  | { mode: 'amount'; value: number };

export type SaleOp =
  | { mode: 'clear' }
  | { mode: 'percent_off'; value: number };

export interface BulkOps {
  status?: 'active' | 'draft' | 'archived';
  featured?: boolean;
  addCategories?: string[];
  removeCategories?: string[];
  addTags?: string[];
  removeTags?: string[];
  price?: PriceOp;
  sale?: SaleOp;
  /** Set the stock count. Only for products without variants (variants keep their own). */
  stock?: number | null;
}

export interface PlannedProduct {
  id: string;
  name: string;
  /** The partial update for saveProduct. Empty when nothing changes. */
  patch: Partial<Product>;
  /** One sentence per changed field, for the preview. */
  changes: string[];
  /** Why this product is left out, if it is. */
  skipped?: string;
  /** It does not meet the "only where" condition, so nothing happens to it. */
  unmatched?: boolean;
}

const uniq = (xs: readonly string[]) => [...new Set(xs)];
const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x) => b.includes(x));

/** Round half away from zero, the rounding a shop owner expects of "+10%". */
function roundHalfAway(x: number): number {
  return Math.sign(x) * Math.round(Math.abs(x));
}

export function applyPrice(cents: number, op: PriceOp): number {
  const next = op.mode === 'set' ? op.value
    : op.mode === 'percent' ? roundHalfAway(cents * (1 + op.value / 100))
    : cents + op.value;
  return Math.max(0, Math.trunc(next));
}

/**
 * Validate the operations, before any product is looked at. Null when they are
 * fine, otherwise a sentence for the admin screen.
 */
export function bulkOpsProblem(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'Choose at least one change.';
  const o = raw as Record<string, unknown>;
  const known = ['status', 'featured', 'addCategories', 'removeCategories', 'addTags', 'removeTags', 'price', 'sale', 'stock'];
  const unknown = Object.keys(o).filter((k) => !known.includes(k));
  if (unknown.length) return `Unknown change: ${unknown.join(', ')}.`;
  if (!Object.keys(o).length) return 'Choose at least one change.';
  if (o.status !== undefined && !['active', 'draft', 'archived'].includes(o.status as string)) return 'Status must be active, draft or archived.';
  if (o.featured !== undefined && typeof o.featured !== 'boolean') return 'Featured must be on or off.';
  for (const k of ['addCategories', 'removeCategories', 'addTags', 'removeTags']) {
    const v = o[k];
    if (v === undefined) continue;
    if (!Array.isArray(v) || v.length > 50 || v.some((s) => typeof s !== 'string' || !s.trim() || s.length > 120)) {
      return `${k} must be a list of up to 50 names.`;
    }
  }
  if (o.price !== undefined) {
    const p = o.price as Record<string, unknown>;
    if (!p || !['set', 'percent', 'amount'].includes(p.mode as string) || typeof p.value !== 'number' || !Number.isFinite(p.value)) {
      return 'A price change needs a mode (set, percent or amount) and a number.';
    }
    if (p.mode === 'set' && (!Number.isInteger(p.value) || p.value < 0)) return 'A price must be a whole, non-negative number of cents.';
    if (p.mode === 'amount' && !Number.isInteger(p.value)) return 'A price change must be a whole number of cents.';
    // A typo of 1000% is not a price rise anyone meant; -100% or less zeroes the catalogue.
    if (p.mode === 'percent' && (p.value <= -100 || p.value > 500)) return 'A percentage change must be above −100% and at most +500%.';
  }
  if (o.sale !== undefined) {
    const s = o.sale as Record<string, unknown>;
    if (!s || !['clear', 'percent_off'].includes(s.mode as string)) return 'A sale change must clear the sale or set a percentage off.';
    if (s.mode === 'percent_off' && (typeof s.value !== 'number' || !(s.value > 0 && s.value < 100))) return 'A sale must be more than 0% and less than 100% off.';
  }
  if (o.stock !== undefined && o.stock !== null && (!Number.isInteger(o.stock) || (o.stock as number) < 0 || (o.stock as number) > 1_000_000)) {
    return 'Stock must be a whole number from 0, or empty for "not tracked".';
  }
  return null;
}

/** The regular price a variant with its own price has, or null if it inherits. */
function variantRegular(v: ProductVariant): number | null {
  return v.regular_price_cents ?? v.price_cents ?? null;
}

export function planBulkEdit(
  products: readonly Product[],
  ops: BulkOps,
  opts: { money?: (cents: number) => string; where?: BulkWhere; categories?: readonly { slug: string; parent_slug?: string | null }[] } = {},
): PlannedProduct[] {
  const money = opts.money ?? ((c: number) => (c / 100).toFixed(2));
  return products.map((p) => {
    const patch: Partial<Product> = {};
    const changes: string[] = [];
    const out: PlannedProduct = { id: p.id, name: p.name, patch, changes };
    if (!matchesWhere(p, opts.where, opts.categories)) {
      out.unmatched = true;
      return out;
    }

    if (ops.status && ops.status !== p.status) {
      patch.status = ops.status;
      changes.push(`status ${p.status} → ${ops.status}`);
    }
    if (ops.featured !== undefined && ops.featured !== !!p.featured) {
      patch.featured = ops.featured;
      changes.push(ops.featured ? 'featured' : 'no longer featured');
    }

    const cats = p.categories ?? [];
    const nextCats = uniq([...cats.filter((c) => !(ops.removeCategories ?? []).includes(c)), ...(ops.addCategories ?? [])]);
    if (!sameSet(cats, nextCats)) {
      patch.categories = nextCats;
      const added = nextCats.filter((c) => !cats.includes(c));
      const removed = cats.filter((c) => !nextCats.includes(c));
      changes.push([added.length && `categories + ${added.join(', ')}`, removed.length && `categories − ${removed.join(', ')}`].filter(Boolean).join('; '));
    }

    const tags = p.tags ?? [];
    const lower = (xs: readonly string[]) => xs.map((t) => t.trim().toLowerCase());
    const drop = lower(ops.removeTags ?? []);
    const kept = tags.filter((t) => !drop.includes(t.trim().toLowerCase()));
    const nextTags = [...kept];
    for (const t of ops.addTags ?? []) {
      if (!lower(nextTags).includes(t.trim().toLowerCase())) nextTags.push(t.trim());
    }
    if (!sameSet(tags, nextTags)) {
      patch.tags = nextTags;
      changes.push(`tags → ${nextTags.join(', ') || '(none)'}`);
    }

    const variants = p.variants ?? [];
    const pricedVariants = variants.filter((v) => variantRegular(v) !== null);

    if (ops.price) {
      if (ops.price.mode === 'set' && pricedVariants.length) {
        out.skipped = `${pricedVariants.length} of its variants have their own prices; a single price would flatten them. Change it by a percentage or an amount instead, or edit it on its own.`;
        return out;
      }
      const regular = p.regular_price_cents ?? p.price_cents;
      const next = applyPrice(regular, ops.price);
      // Clamping at zero would quietly make a product FREE — "−20.00" across a
      // mixed selection gives away everything under 20. A price only becomes 0
      // when someone sets 0 on purpose.
      const hitsZero = (c: number) => ops.price!.mode !== 'set' && c > 0 && applyPrice(c, ops.price!) === 0;
      if (hitsZero(regular) || pricedVariants.some((v) => hitsZero(variantRegular(v)!))) {
        out.skipped = `the change would make it free (${money(regular)} → ${money(0)}). Set a price of 0 on purpose if that is meant.`;
        return out;
      }
      if (next !== regular) {
        patch.regular_price_cents = next;
        changes.push(`price ${money(regular)} → ${money(next)}`);
      }
      if (pricedVariants.length) {
        patch.variants = variants.map((v) => {
          const r = variantRegular(v);
          if (r === null) return v;
          const nr = applyPrice(r, ops.price!);
          // price_cents is the variant's REGULAR price. Checkout derives the sale
          // from sale_price_cents and the product's sale window; writing the sale
          // price here would charge it outside that window.
          return { ...v, regular_price_cents: nr, price_cents: nr };
        });
        changes.push(`${pricedVariants.length} variant price${pricedVariants.length === 1 ? '' : 's'} changed the same way`);
      }
    }

    if (ops.sale) {
      const regular = patch.regular_price_cents ?? p.regular_price_cents ?? p.price_cents;
      if (ops.sale.mode === 'clear') {
        if (p.sale_price_cents != null) {
          patch.sale_price_cents = null;
          changes.push('sale ended');
        }
        // Ending a sale ends it everywhere, including a variant's own sale price.
        const onSaleVariants = variants.filter((v) => v.sale_price_cents != null);
        if (onSaleVariants.length) {
          patch.variants = (patch.variants ?? variants).map((v) => (v.sale_price_cents != null ? { ...v, sale_price_cents: null } : v));
          changes.push(`sale ended on ${onSaleVariants.length} variant${onSaleVariants.length === 1 ? '' : 's'}`);
        }
      } else if (pricedVariants.length) {
        // A product-level sale price never reaches a variant that has its own
        // price, so the product would show a sale badge while every variant is
        // charged in full. Refused rather than advertised.
        out.skipped = `${pricedVariants.length} of its variants have their own prices, which a product-level sale does not reach. Put it on sale on the product itself.`;
        return out;
      } else {
        const sale = applyPrice(regular, { mode: 'percent', value: -ops.sale.value });
        if (sale !== p.sale_price_cents) {
          patch.sale_price_cents = sale;
          const dated = p.sale_starts_at || p.sale_ends_at;
          changes.push(`sale price ${money(sale)} (${ops.sale.value}% off ${money(regular)})${dated ? ', within the product\'s sale dates' : ''}`);
        }
      }
    }

    if (ops.stock !== undefined) {
      if (variants.length) {
        out.skipped = 'it has variants, which keep their own stock. Change it on the product.';
        return out;
      }
      if (ops.stock !== p.stock) {
        patch.stock = ops.stock;
        changes.push(`stock ${p.stock ?? 'not tracked'} → ${ops.stock ?? 'not tracked'}`);
      }
    }

    return out;
  });
}
