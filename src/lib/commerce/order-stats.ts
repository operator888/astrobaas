/**
 * Opt-in public order counter: "N orders this month" for a storefront's
 * social proof.
 *
 * ## What it exposes, and what it never does
 *
 * ONE number and the month it is for. Never revenue, never an amount, never
 * anything per order or per customer — a count of orders is already a
 * business figure, and an operator decides whether to publish it
 * (`public_order_stats_enabled`, OFF by default; the route is a 404 while off).
 *
 * ## The rules
 *
 * - **Paid orders only**: `payment_status === 'paid'`, the rule the dashboard,
 *   Insights and attribution already apply. An unpaid basket is not a sale,
 *   and a counter that included them would be the easiest number on the site
 *   to inflate — place orders, never pay.
 * - **By the month it was placed** (`created_at`), in the SHOP'S timezone
 *   (`shop_timezone`, an IANA name, default UTC). An order placed at 00:30 on
 *   the 1st in Athens is 22:30 on the 31st in UTC; counted in UTC it would
 *   land in the wrong month for the shop that took it.
 *
 * Pure: the caller passes orders, settings and the clock.
 */

/** The opt-in switch. OFF unless an operator turns it on. */
export const PUBLIC_ORDER_STATS_KEY = 'public_order_stats_enabled';
/** The shop's IANA timezone, used for "this month". */
export const SHOP_TIMEZONE_KEY = 'shop_timezone';
export const DEFAULT_SHOP_TIMEZONE = 'UTC';

/** Is `tz` an IANA zone this runtime knows? */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz.trim() || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz.trim() });
    return true;
  } catch {
    return false;
  }
}

/** The shop's timezone from settings, or UTC when unset or unusable. */
export function resolveShopTimeZone(settings: Record<string, unknown>): string {
  const v = settings[SHOP_TIMEZONE_KEY];
  return isValidTimeZone(v) ? v.trim() : DEFAULT_SHOP_TIMEZONE;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** `YYYY-MM` of instant `t` as seen in `tz`. */
export function monthInZone(t: Date | number, tz: string): string {
  let fmt = formatters.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit' });
    formatters.set(tz, fmt);
  }
  const parts = fmt.formatToParts(typeof t === 'number' ? new Date(t) : t);
  const y = parts.find((p) => p.type === 'year')?.value ?? '0000';
  const m = parts.find((p) => p.type === 'month')?.value ?? '00';
  return `${y}-${m}`;
}

/** What the counter reads off an order. Nothing else is looked at. */
export interface CountableOrder {
  created_at?: string;
  payment_status?: string;
}

/**
 * `{ count, month }` for the month containing `now`, in `tz`.
 *
 * Linear in the order book, and that is fine for a number served behind a
 * shared cache: the route caches it for a minute.
 */
export function paidOrdersThisMonth(
  orders: readonly CountableOrder[],
  now: Date | number,
  tz: string,
): { count: number; month: string } {
  const month = monthInZone(now, tz);
  let count = 0;
  for (const o of orders) {
    if ((o?.payment_status ?? 'unpaid') !== 'paid') continue;
    const t = Date.parse(String(o.created_at ?? ''));
    if (!Number.isFinite(t)) continue;
    if (monthInZone(t, tz) === month) count += 1;
  }
  return { count, month };
}
