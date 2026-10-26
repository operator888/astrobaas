/**
 * Stock status: "in stock", "low stock" or "out of stock", decided in ONE place.
 *
 * Pure — no I/O — so the rule that a public badge shows is unit-testable and
 * the API and the storefront starter cannot disagree about it.
 *
 * ## Why this exists
 *
 * The catalogue already answered "can it be bought" (`availableFor`) and kept a
 * stored boolean, `in_stock`. Neither answers "how worried should the shopper
 * be", and the stored boolean is wrong for any product that has variants: it is
 * derived from the PRODUCT's own count, which a variable product does not use,
 * so a shirt whose every size has sold out still reported `in_stock: true`.
 *
 * ## One vocabulary — nothing new is invented
 *
 * - the count is `stock` (null = untracked, as everywhere else);
 * - the per-product warning level is the EXISTING `low_stock_threshold`;
 * - whether a sale is still possible at zero is the EXISTING `backorders`
 *   policy, and "purchasable" is answered by the EXISTING `availableFor`, not
 *   by a second implementation of it.
 *
 * The only new setting is the shop-wide default for the threshold, which a
 * product with no threshold of its own inherits.
 *
 * ## Derived on READ
 *
 * Nothing here is stored. `in_stock` is a fact about when a row was last
 * written; this is a fact about the row as it is now, computed from `stock`
 * and `variants[].stock` on every response (see recurring-bug-patterns, 7).
 */

import type {
  BackorderPolicy, Product, ProductVariant, StockStatus, StockStatusInfo,
} from '../../core/models';
import { availableFor, normalizeBackorders } from '../product-fields';
import { buyableVariants, isVariable } from './variants';

/** The shop-wide default warning level. Merchants set it in Settings → Shop. */
export const LOW_STOCK_THRESHOLD_KEY = 'inventory_low_stock_threshold_qty';

/** Units at or below which a tracked product reads "low stock" by default. */
export const LOW_STOCK_THRESHOLD_DEFAULT = 5;

/** Hard ceiling; matches the per-product field's clamp in `commerce-service`. */
export const LOW_STOCK_THRESHOLD_MAX = 1_000_000;

function whole(v: unknown): number | null {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null;
  return Math.min(Math.floor(n), LOW_STOCK_THRESHOLD_MAX);
}

/**
 * The shop-wide threshold from a settings map. Absent, empty or junk is the
 * default; `0` is a decision ("never show low stock") and is kept.
 */
export function resolveLowStockThreshold(settings: Record<string, unknown> | null | undefined): number {
  const raw = (settings ?? {})[LOW_STOCK_THRESHOLD_KEY];
  if (raw === null || raw === undefined || raw === '') return LOW_STOCK_THRESHOLD_DEFAULT;
  return whole(raw) ?? LOW_STOCK_THRESHOLD_DEFAULT;
}

/** The threshold that applies to a product: its own override, else the default. */
export function effectiveThreshold(
  product: { low_stock_threshold?: number | null },
  defaultThreshold: number,
): number {
  return whole(product.low_stock_threshold) ?? defaultThreshold;
}

interface CountInput {
  stock: number | null | undefined;
  backorders?: BackorderPolicy | string;
}

function classify(
  qty: number | null,
  threshold: number,
  policy: BackorderPolicy,
  purchasable: boolean,
): StockStatusInfo {
  const tracked = qty !== null;
  let status: StockStatus;
  if (!tracked) status = 'in-stock';
  else if (qty <= 0) status = 'out-of-stock';
  else if (qty <= threshold) status = 'low-stock';
  else status = 'in-stock';
  return {
    status,
    tracked,
    // A backorder can drive the stored count below zero; a shopper is told 0.
    available_qty: qty === null ? null : Math.max(0, qty),
    threshold_qty: threshold,
    // Only while an order would actually go through: a variable product with
    // no enabled variant takes no orders whatever its policy says.
    backorderable: qty !== null && qty <= 0 && purchasable && policy !== 'no',
    purchasable,
  };
}

function countOf(stock: unknown): number | null {
  return typeof stock === 'number' && Number.isFinite(stock) ? Math.trunc(stock) : null;
}

/**
 * The status of ONE count — a simple product, or a single variant.
 *
 * Precedence: untracked is always in stock; a count of zero or less is out of
 * stock whatever the threshold says (a threshold of 5 must not make 0 read
 * "low"); `0 < qty <= threshold` is low; anything above is in stock. A
 * threshold of 0 therefore means "never low".
 */
export function stockStatusOf(input: CountInput, threshold: number): StockStatusInfo {
  const qty = countOf(input.stock);
  const policy = normalizeBackorders(input.backorders);
  // `availableFor` is the checkout's own rule, so "purchasable" here cannot
  // drift from what an order will actually be allowed to do.
  const purchasable = availableFor({ stock: qty, backorders: policy }, 1).ok;
  return classify(qty, threshold, policy, purchasable);
}

type ProductLike = Pick<Product, 'stock' | 'backorders' | 'low_stock_threshold' | 'variants'>;

/**
 * The status of a product as a shopper sees it.
 *
 * A product with variants is judged on its BUYABLE (enabled) variants:
 *
 * - the quantity is their sum, and `null` — untracked — as soon as one of them
 *   is untracked (reporting a number would understate it; the same rule as
 *   `totalVariantStock`);
 * - it is purchasable when any of them is;
 * - the product's own `stock` is ignored, because a variable product does not
 *   sell from it.
 *
 * A variable product with no enabled variant cannot be bought at all.
 */
export function productStockStatus(product: ProductLike, defaultThreshold: number): StockStatusInfo {
  const threshold = effectiveThreshold(product, defaultThreshold);
  if (!isVariable(product)) return stockStatusOf(product, threshold);

  const policy = normalizeBackorders(product.backorders);
  const buyable = buyableVariants(product as Pick<Product, 'variants'>);
  if (buyable.length === 0) return classify(0, threshold, policy, false);

  const infos = buyable.map((v) => stockStatusOf({ stock: v.stock, backorders: policy }, threshold));
  const untracked = infos.some((i) => !i.tracked);
  const total = untracked ? null : infos.reduce((n, i) => n + (i.available_qty ?? 0), 0);
  return classify(total, threshold, policy, infos.some((i) => i.purchasable));
}

/**
 * A product, plus the derived `stock_status` on it and on each variant.
 *
 * Read-only on the wire: `stock_status` is on no write allow-list, so a client
 * that reads a product and PUTs it back has it dropped, never stored.
 */
export function withStockStatus<T extends ProductLike>(
  product: T,
  defaultThreshold: number,
): T & { stock_status: StockStatusInfo } {
  const out = { ...product, stock_status: productStockStatus(product, defaultThreshold) } as T & {
    stock_status: StockStatusInfo;
  };
  if (Array.isArray(product.variants)) {
    const threshold = effectiveThreshold(product, defaultThreshold);
    const policy = normalizeBackorders(product.backorders);
    (out as { variants?: unknown }).variants = product.variants.map((v: ProductVariant) => ({
      ...v,
      stock_status: stockStatusOf({ stock: v.stock, backorders: policy }, threshold),
    }));
  }
  return out;
}

/** The body of `GET /api/products/{ref}/stock-status`. */
export function stockStatusResponse(product: ProductLike & { id: string }, defaultThreshold: number) {
  const info = productStockStatus(product, defaultThreshold);
  const threshold = effectiveThreshold(product, defaultThreshold);
  const policy = normalizeBackorders(product.backorders);
  return {
    product_id: product.id,
    ...info,
    ...(isVariable(product)
      ? {
          variants: buyableVariants(product as Pick<Product, 'variants'>).map((v) => ({
            id: v.id,
            options: v.options,
            ...stockStatusOf({ stock: v.stock, backorders: policy }, threshold),
          })),
        }
      : {}),
  };
}

/** Best first: the order a group's members are compared in. */
const STATUS_RANK: Record<StockStatus, number> = { 'in-stock': 0, 'low-stock': 1, 'out-of-stock': 2 };

/**
 * The status of a GROUPED product, judged on the members a shopper can see.
 *
 * A group has no stock of its own and is never bought itself — each member is
 * its own cart line (see `lib/commerce/grouped.ts`). So the group reads as the
 * BEST of its members: it is purchasable while any member is, and its status
 * is the best member's. The per-member answers travel beside it, and that is
 * where a shopper sees which item is sold out.
 *
 * - `tracked` is false and `available_qty` null: a sum of different products'
 *   counts is not a number anything can act on;
 * - `backorderable` only when nothing is on hand and a backorder is what keeps
 *   the group buyable;
 * - no members at all is out of stock and not purchasable — there is nothing
 *   on the page to buy.
 */
export function groupStockStatus(members: StockStatusInfo[], threshold: number): StockStatusInfo {
  if (members.length === 0) {
    return {
      status: 'out-of-stock', tracked: false, available_qty: null,
      threshold_qty: threshold, backorderable: false, purchasable: false,
    };
  }
  const best = members.reduce((a, b) => (STATUS_RANK[b.status] < STATUS_RANK[a.status] ? b : a));
  const purchasable = members.some((m) => m.purchasable);
  return {
    status: best.status,
    tracked: false,
    available_qty: null,
    threshold_qty: threshold,
    backorderable: best.status === 'out-of-stock' && members.some((m) => m.backorderable),
    purchasable,
  };
}
