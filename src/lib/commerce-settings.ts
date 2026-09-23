import { DEFAULT_CURRENCY } from './money-format';
/**
 * Operator-configurable order limits.
 *
 * Checkout is a PUBLIC, anonymous endpoint, so "how much can one request ask
 * for" is a real abuse control, not just a UX preference: without a cap, a
 * single request can drain a product's inventory or inflate an order to an
 * absurd size. The defaults are deliberately conservative — a shop that wants
 * bulk orders opts in, rather than every shop being exposed by default.
 *
 * Values live in the settings table so they are changeable from the admin
 * without a redeploy. Resolution is pure and clamped, so a corrupt or hostile
 * settings row can never widen the limit beyond the hard ceiling or disable it.
 */

/** Shipping defaults: 3 units of any one product, 50 distinct lines per order. */
export const ORDER_LIMIT_DEFAULTS = {
  maxQtyPerProduct: 3,
  maxItemsPerOrder: 50,
} as const;

/** Hard ceilings. A settings row can tune within these, never past them. */
export const ORDER_LIMIT_BOUNDS = {
  maxQtyPerProduct: { min: 1, max: 1000 },
  maxItemsPerOrder: { min: 1, max: 200 },
} as const;

export interface OrderLimits {
  /** Max units of a single product allowed in one order line. */
  maxQtyPerProduct: number;
  /** Max distinct line items in one order. */
  maxItemsPerOrder: number;
}

/** Setting keys, exported so the admin form and the reader can't drift apart. */
export const ORDER_LIMIT_KEYS = {
  maxQtyPerProduct: 'order_max_qty_per_product',
  maxItemsPerOrder: 'order_max_items_per_order',
} as const;

function clampInt(value: unknown, def: number, bounds: { min: number; max: number }): number {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return def;
  const i = Math.floor(n);
  if (i < bounds.min) return bounds.min;
  if (i > bounds.max) return bounds.max;
  return i;
}

/**
 * Resolve limits from a settings map. PURE — no I/O — so the clamping rules that
 * gate a public endpoint are unit-testable. Anything missing, non-numeric, or
 * out of range falls back to the default or the nearest bound; the limit can
 * never end up absent or zero.
 */
export function resolveOrderLimits(settings: Record<string, unknown> | null | undefined): OrderLimits {
  const map = settings ?? {};
  return {
    maxQtyPerProduct: clampInt(
      map[ORDER_LIMIT_KEYS.maxQtyPerProduct],
      ORDER_LIMIT_DEFAULTS.maxQtyPerProduct,
      ORDER_LIMIT_BOUNDS.maxQtyPerProduct,
    ),
    maxItemsPerOrder: clampInt(
      map[ORDER_LIMIT_KEYS.maxItemsPerOrder],
      ORDER_LIMIT_DEFAULTS.maxItemsPerOrder,
      ORDER_LIMIT_BOUNDS.maxItemsPerOrder,
    ),
  };
}

/**
 * The commerce master switch.
 *
 * AstroBaaS installs are mostly not shops: a blog with a public, empty
 * `/api/products` is advertising a capability the operator never chose. So
 * commerce is opt-in — the setting ABSENT means off, which is what makes
 * "fresh installs have no shop" true without seeding anything (fresh installs
 * are stamped at the latest schema version and never run migrations).
 *
 * Existing shops are the other half of the contract: migration v12 turns the
 * switch on wherever commerce data already exists, so an upgrade changes
 * nothing for them. See `src/lib/migrations.ts`.
 */
export const COMMERCE_ENABLED_KEY = 'commerce_enabled';

/**
 * PURE resolver, strict about truth. Booleans elsewhere are read with `!!`,
 * which would make the stored STRING "false" enable the shop — this is a
 * switch that opens public write endpoints, so only deliberate spellings of
 * "on" count and everything else (absent, corrupt, hostile) resolves to off.
 */
export function resolveCommerceEnabled(settings: Record<string, unknown> | null | undefined): boolean {
  const v = (settings ?? {})[COMMERCE_ENABLED_KEY];
  return v === true || v === 'true' || v === '1' || v === 1;
}

/** The shop's currency, as an ISO 4217 code. */
export const SHOP_CURRENCY_KEY = 'shop_currency';

/**
 * The currency a NEW order or quote is priced in.
 *
 * ## Why this is a setting and not a constant
 *
 * `placeOrder()` wrote `currency: 'EUR'` as a literal, and so did the quote
 * endpoint. The money formatter has always handled arbitrary currencies —
 * including the zero-decimal ones — which made the platform look far more
 * multi-currency than it was: every shop on earth was a euro shop, and a
 * merchant in Sofia or London had no way to say otherwise.
 *
 * ## What this does NOT do
 *
 * It converts nothing by itself. This is the shop's BASE currency: prices are
 * entered in it and every order stores `base_total_cents` in it. Quoting a
 * buyer in another currency is a separate mechanism (commerce/currency-rates.ts)
 * with its own stored rates and rounding, and the order keeps both figures —
 * formatting one integer with two symbols would be a lie about money.
 *
 * ## Existing orders keep the currency they were placed in
 *
 * The code is FROZEN onto the order at checkout, exactly like the line items
 * and the prescription. Changing this setting changes what the NEXT order is
 * priced in and rewrites nothing — an invoice must always say what was actually
 * charged, and a shop that switched from GBP to EUR must not retroactively
 * restate last year's books.
 */
export function resolveShopCurrency(settings: Record<string, unknown> | null | undefined): string {
  const raw = (settings ?? {})[SHOP_CURRENCY_KEY];
  if (typeof raw !== 'string') return DEFAULT_CURRENCY;
  const code = raw.trim().toUpperCase();
  // ISO 4217 is exactly three letters. Anything else is a typo or a symbol —
  // an operator typing "€" is the likely case — and a bad code would be frozen
  // onto every future order, so the fallback is the safe answer.
  return /^[A-Z]{3}$/.test(code) ? code : DEFAULT_CURRENCY;
}
