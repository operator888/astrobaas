/**
 * Discount codes.
 *
 * Pure validation + amount calculation. Applied server-side in both `quote` and
 * `placeOrder`, from the same code, so a quoted discount and a charged discount
 * cannot differ.
 *
 * ## Rejections say WHY
 *
 * "Invalid code" is the default a shop reaches for and it is a bad answer: a
 * customer whose code expired yesterday, whose basket is 2 euro under the
 * minimum, or who already used it will all retype the same code and then email
 * support. Every rejection carries a machine-readable reason so the storefront
 * can say the useful thing.
 *
 * `not-found` stays vague on purpose — enumerating which codes exist is how
 * people find the 50%-off staff code. And since every OTHER reason also says
 * the code exists, only staff get them: the routes pass every rejection a
 * non-staff caller will see through `publicCouponRejection` below, which keeps
 * the minimum-spend shortfall and nothing else.
 */

export type CouponKind = 'percent' | 'fixed';

export interface Coupon {
  id: string;
  /** Stored upper-case; matching is case-insensitive. */
  code: string;
  kind: CouponKind;
  /** Basis points for `percent` (1000 = 10%), minor units for `fixed`. */
  value: number;
  description?: string;
  enabled: boolean;
  /** Basket must reach this (before discount) to qualify. */
  min_subtotal_cents?: number | null;
  /** ISO timestamps. Absent = open-ended on that side. */
  starts_at?: string | null;
  ends_at?: string | null;
  /** Total redemptions allowed across all customers. */
  usage_limit?: number | null;
  /** Redemptions allowed per customer email. */
  usage_limit_per_customer?: number | null;
  /** Incremented when an order using it is placed. */
  used_count: number;
  /** Restrict to these product ids. Empty = any product. */
  product_ids?: string[];
  /** Restrict to these product-category slugs. Empty = any category. */
  category_slugs?: string[];
  /** Also waives the shipping cost. */
  free_shipping?: boolean;
  /**
   * Applies WITHOUT a code — "spend €50, free shipping".
   *
   * The whole rule is the existing coupon: the same window, the same minimum,
   * the same product and category restrictions, the same usage limits, judged
   * by the same `applyCoupon`. A cart rule is not a second discount engine with
   * its own opinions; it is a coupon nobody has to know the name of. Roughly
   * half of what shops want from promotions needs no code at all, and every one
   * of those was unreachable.
   *
   * An automatic coupon still HAS a code — the model requires one and the
   * admin needs something to call it — but nothing asks the customer for it.
   */
  automatic?: boolean;
  created_at: string;
  updated_at: string;
}

export type CouponRejection =
  | 'not-found'
  | 'disabled'
  | 'not-started'
  | 'expired'
  | 'minimum-not-met'
  | 'usage-limit-reached'
  | 'customer-limit-reached'
  | 'no-eligible-items'
  /** Only ever produced by publicCouponRejection — what a non-staff caller sees. */
  | 'invalid';

export interface CouponContext {
  /** Basket lines the discount may apply to. */
  lines: readonly { product_id: string; categories?: string[]; amount_cents: number }[];
  /** Basket total before discount. */
  subtotal_cents: number;
  /** Epoch ms. Injected so validity windows are testable. */
  nowMs: number;
  /** How many times THIS customer has already redeemed it. */
  customerUses?: number;
}

export interface CouponRejected {
  ok: false;
  reason: CouponRejection;
  /** Customer-facing sentence. Safe to display verbatim. */
  message: string;
  /** For 'minimum-not-met', how much more is needed. */
  shortfall_cents?: number;
}

export interface CouponAccepted {
  ok: true;
  coupon: Coupon;
  /** Discount to apply, in minor units. Never exceeds the eligible amount. */
  discount_cents: number;
  /** Amount the discount was computed against (may be a subset of the basket). */
  eligible_cents: number;
  freeShipping: boolean;
}

export type CouponResult = CouponAccepted | CouponRejected;

/** Codes are compared case- and whitespace-insensitively. */
export function normalizeCouponCode(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().toUpperCase().replace(/\s+/g, '') : '';
}

function reject(reason: CouponRejection, message: string, extra?: Partial<CouponRejected>): CouponRejected {
  return { ok: false, reason, message, ...extra };
}

/** Lines this coupon may discount. Empty restriction lists mean "everything". */
function eligibleLines(coupon: Coupon, ctx: CouponContext) {
  const products = coupon.product_ids ?? [];
  const cats = (coupon.category_slugs ?? []).map((c) => c.toLowerCase());
  if (!products.length && !cats.length) return ctx.lines;
  return ctx.lines.filter((l) => {
    if (products.length && products.includes(l.product_id)) return true;
    if (cats.length && (l.categories ?? []).some((c) => cats.includes(c.toLowerCase()))) return true;
    return false;
  });
}

/**
 * Validate a coupon against a basket and compute its discount.
 *
 * Order of checks matters for the message the customer sees: identity and
 * validity window first (nothing they can do), then the minimum (something they
 * CAN do — "spend 3 euro more"), then limits.
 */
export function applyCoupon(coupon: Coupon | undefined | null, ctx: CouponContext): CouponResult {
  if (!coupon) {
    // Deliberately vague — see the module note about code enumeration.
    return reject('not-found', PUBLIC_COUPON_MESSAGE);
  }
  if (!coupon.enabled) {
    return reject('disabled', 'That code is no longer active.');
  }

  if (coupon.starts_at) {
    const start = Date.parse(coupon.starts_at);
    if (Number.isFinite(start) && ctx.nowMs < start) {
      return reject('not-started', 'That code is not active yet.');
    }
  }
  if (coupon.ends_at) {
    const end = Date.parse(coupon.ends_at);
    if (Number.isFinite(end) && ctx.nowMs > end) {
      return reject('expired', 'That code has expired.');
    }
  }

  const min = coupon.min_subtotal_cents ?? 0;
  if (min > 0 && ctx.subtotal_cents < min) {
    const shortfall = min - ctx.subtotal_cents;
    return reject(
      'minimum-not-met',
      `Spend ${(shortfall / 100).toFixed(2)} more to use this code.`,
      { shortfall_cents: shortfall },
    );
  }

  if (coupon.usage_limit != null && coupon.used_count >= coupon.usage_limit) {
    return reject('usage-limit-reached', 'That code has reached its usage limit.');
  }
  if (
    coupon.usage_limit_per_customer != null &&
    (ctx.customerUses ?? 0) >= coupon.usage_limit_per_customer
  ) {
    return reject('customer-limit-reached', 'You have already used that code.');
  }

  const lines = eligibleLines(coupon, ctx);
  const eligible = lines.reduce((sum, l) => sum + Math.max(0, l.amount_cents), 0);
  if (eligible <= 0) {
    return reject('no-eligible-items', 'That code does not apply to anything in your basket.');
  }

  let discount =
    coupon.kind === 'percent'
      ? Math.round((eligible * coupon.value) / 10_000)
      : Math.round(coupon.value);

  // A discount can never exceed what it applies to. Without this clamp a
  // 50-euro fixed coupon on a 20-euro basket yields a NEGATIVE total, which
  // downstream becomes a payment request for a negative amount.
  discount = Math.max(0, Math.min(discount, eligible));

  return {
    ok: true,
    coupon,
    discount_cents: discount,
    eligible_cents: eligible,
    freeShipping: coupon.free_shipping === true,
  };
}

/**
 * What a STRANGER is told about a rejected code.
 *
 * The module note above says every rejection names its reason, so a customer
 * can act on it — and that `not-found` alone stays vague, because enumerating
 * which codes exist is how people find the staff code. But "expired",
 * "disabled", "not started", "used up" and "already used by you" all say the
 * code EXISTS, so an anonymous quote endpoint answered exactly the question
 * `not-found` was vague to avoid: a script trying codes learned which ones
 * were real, and which were merely spent.
 *
 * So anyone who is not staff sees one reason, `invalid`, with the sentence a
 * missing code gets. The exception is `minimum-not-met`: "spend 3 euro more"
 * is the one rejection a buyer can act on, and it is kept with its shortfall.
 * Staff previewing a basket in the admin still get the real reason.
 */
export const PUBLIC_COUPON_MESSAGE = 'That code is not valid.';

export function publicCouponRejection(rejected: CouponRejected): CouponRejected {
  if (rejected.reason === 'minimum-not-met') return rejected;
  return { ok: false, reason: 'invalid', message: PUBLIC_COUPON_MESSAGE };
}

/**
 * Split a discount across lines, in integer minor units, summing EXACTLY.
 *
 * Needed because tax is computed per line: a 10% discount has to reduce each
 * line's taxable amount, and naive per-line rounding loses or gains cents so
 * the parts stop adding up to the whole.
 *
 * Largest-remainder: floor every share, then hand the leftover cents to the
 * lines with the biggest fractional parts. Deterministic, and the result always
 * sums to `discount_cents`.
 */
export function allocateDiscount(
  amounts: readonly number[],
  discount_cents: number,
): number[] {
  const total = amounts.reduce((s, a) => s + Math.max(0, a), 0);
  if (total <= 0 || discount_cents <= 0) return amounts.map(() => 0);
  const capped = Math.min(discount_cents, total);

  const exact = amounts.map((a) => (Math.max(0, a) * capped) / total);
  const floors = exact.map((x) => Math.floor(x));
  let remainder = capped - floors.reduce((s, f) => s + f, 0);

  // Hand out the leftover to the largest fractional parts, tie-broken by index
  // so the same basket always allocates the same way.
  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => (b.frac !== a.frac ? b.frac - a.frac : a.i - b.i));

  const out = [...floors];
  for (const { i } of order) {
    if (remainder <= 0) break;
    // Never allocate more to a line than the line is worth.
    if (out[i] < Math.max(0, amounts[i])) {
      out[i] += 1;
      remainder -= 1;
    }
  }
  return out;
}
