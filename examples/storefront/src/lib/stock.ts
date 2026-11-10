/**
 * What to tell a shopper about availability.
 *
 * This file decides NOTHING about stock. The CMS derives `stock_status` on every
 * product (and every variant) from the count, the low-stock threshold and the
 * backorder policy, and the storefront only chooses words and a colour for it.
 * A threshold or a backorder rule written here would be a second copy that
 * drifts from the shop's settings.
 *
 * A CMS older than the field sends no `stock_status`; then the stored `in_stock`
 * flag is all there is, and the badge says only what that flag says.
 */

/** The wire shape of `stock_status` — see GET /api/products/{ref}/stock-status. */
export interface StockInfo {
  status: 'in-stock' | 'low-stock' | 'out-of-stock';
  available_qty?: number | null;
  backorderable?: boolean;
  purchasable?: boolean;
}

/** Anything the CMS sends that carries availability: a product or a variant. */
export interface Stocked {
  stock_status?: StockInfo | null;
  in_stock?: boolean;
}

export interface StockBadge {
  /** A CSS modifier: `in`, `low` or `out`. */
  tone: 'in' | 'low' | 'out';
  label: string;
  /** A short suffix for a <select> option: "" when in stock, else "3 left", "backorder", "sold out". */
  note: string;
  /** Can one unit be ordered now? Drives the buy button — not the colour. */
  buyable: boolean;
}

export function stockBadge(item: Stocked): StockBadge {
  const s = item.stock_status;
  if (!s) {
    // Older CMS: the flag is the whole truth available.
    return item.in_stock !== false
      ? { tone: 'in', label: 'In stock', note: '', buyable: true }
      : { tone: 'out', label: 'Out of stock', note: 'sold out', buyable: false };
  }
  const buyable = s.purchasable !== false;
  if (s.status === 'out-of-stock') {
    return s.backorderable && buyable
      ? { tone: 'out', label: 'Out of stock \u2013 backorder available', note: 'backorder', buyable }
      : { tone: 'out', label: 'Out of stock', note: 'sold out', buyable };
  }
  if (s.status === 'low-stock') {
    const n = typeof s.available_qty === 'number' ? s.available_qty : null;
    return {
      tone: 'low',
      label: n !== null ? `Low stock \u2013 ${n} left` : 'Low stock',
      note: n !== null ? `${n} left` : 'low stock',
      buyable,
    };
  }
  return { tone: 'in', label: 'In stock', note: '', buyable };
}
