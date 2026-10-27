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
 *
 * ## Two vocabularies for one refusal
 *
 * `reason` is the original kebab-case word (`usage-limit-reached`), kept
 * because storefronts already branch on it. `refusal` is the stable dotted
 * code (`coupon.exhausted`) the plugin contract names — see
 * `COUPON_REFUSAL_CODES`. Every reason maps to exactly one code through
 * `refusalCodeFor`, and both travel together.
 *
 * ## Types (`kind`)
 *
 * | kind | value | effect |
 * | --- | --- | --- |
 * | `percent` | basis points (1000 = 10%) | that share of the eligible lines, rounded half-up once |
 * | `fixed` | minor units | that amount, never more than the eligible lines |
 * | `bogo50` | ignored (0) | in each PAIR of eligible units, the cheaper one is half price — see `bogoDiscount` |
 * | `free_shipping` | ignored (0) | shipping costs nothing; no money off the goods |
 * | `gift_product` | ignored (0) | adds one unit of `gift_product_id` at price 0 — see pricing-service |
 *
 * The record keeps the field names it always had (`kind`, `ends_at`,
 * `usage_limit`, `usage_limit_per_customer`, `category_slugs`), so every coupon
 * a shop already stored keeps working with no migration. The plugin contract's
 * names (`type`, `expires_at`, `max_redemptions`, …) are ALIASES accepted at
 * the edges (admin-normalize.ts, the host seam) and mapped onto these.
 */

import type { BrandDirectory } from './brand';
import { brandMatches } from './brand';

export const COUPON_KINDS = ['percent', 'fixed', 'bogo50', 'free_shipping', 'gift_product'] as const;
export type CouponKind = (typeof COUPON_KINDS)[number];

/** Kinds whose `value` means something. The others store 0. */
export const VALUED_COUPON_KINDS: readonly CouponKind[] = ['percent', 'fixed'];

export interface Coupon {
  id: string;
  /** Stored upper-case; matching is case-insensitive. */
  code: string;
  kind: CouponKind;
  /** Basis points for `percent` (1000 = 10%), minor units for `fixed`; 0 for the other kinds. */
  value: number;
  description?: string;
  enabled: boolean;
  /** Basket must reach this (before discount) to qualify. */
  min_subtotal_cents?: number | null;
  /** ISO timestamps. Absent = open-ended on that side. (`ends_at` is the contract's `expires_at`.) */
  starts_at?: string | null;
  ends_at?: string | null;
  /** Total redemptions allowed across all customers (the contract's `max_redemptions`). */
  usage_limit?: number | null;
  /** Redemptions allowed per customer email (the contract's `max_redemptions_per_email`). */
  usage_limit_per_customer?: number | null;
  /** Incremented when an order using it is placed. */
  used_count: number;
  /** Restrict to these product ids. Empty = any product. */
  product_ids?: string[];
  /** Restrict to these product-category slugs. Empty = any category. (The contract's `categories`.) */
  category_slugs?: string[];
  /**
   * Restrict to products of these brands. Empty = any brand. Matched the way
   * `?brand=` matches (`brandMatches` through the brand directory), so
   * `Ray-Ban`, `RAYBAN` and the published slug `ray-ban` are one maker.
   */
  brands?: string[];
  /** Also waives the shipping cost. (Always true in effect for `kind: 'free_shipping'`.) */
  free_shipping?: boolean;
  /** For `kind: 'gift_product'`: the product added at price 0. A simple (non-variable) product. */
  gift_product_id?: string | null;
  /**
   * Bound to ONE buyer: the code validates only for this email, compared
   * case-insensitively. Stored lower-case.
   */
  email?: string | null;
  /** One redemption in total, whoever makes it. Enforced as a usage limit of 1. */
  single_use?: boolean;
  /**
   * Set when a plugin revoked it (`host.coupons.revoke`). A revoked coupon is
   * also disabled; the timestamp is what tells the two apart.
   */
  revoked_at?: string | null;
  /** Who issued it, when a plugin did (`host.coupons.issue`). Absent for staff-made coupons. */
  source?: { plugin: string; ref: string } | null;
  /**
   * Redemptions per buyer, keyed by `couponEmailKey(email)` (a SHA-256 of the
   * normalised address — never the address itself). Counted atomically by
   * `claimCouponUse` when the coupon has a per-email limit, so two concurrent
   * checkouts by one buyer cannot both pass it.
   */
  redemptions_by_email?: Record<string, number>;
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
  | 'revoked'
  | 'not-started'
  | 'expired'
  | 'email-mismatch'
  | 'minimum-not-met'
  | 'usage-limit-reached'
  | 'customer-limit-reached'
  | 'no-eligible-items'
  /** `bogo50` with fewer than two eligible units: there is no pair to discount. */
  | 'needs-more-items'
  /** `gift_product` whose gift is out of stock, unpublished or not a simple product. */
  | 'gift-unavailable'
  /** Only ever produced by publicCouponRejection — what a non-staff caller sees. */
  | 'invalid';

/** The stable refusal codes of the coupon contract. */
export const COUPON_REFUSAL_CODES = [
  'coupon.not_found',
  'coupon.expired',
  'coupon.not_started',
  'coupon.min_subtotal',
  'coupon.not_applicable',
  'coupon.email_mismatch',
  'coupon.already_redeemed',
  'coupon.exhausted',
] as const;
export type CouponRefusalCode = (typeof COUPON_REFUSAL_CODES)[number];

/**
 * Every reason's contract code. A `Record` over the whole union, so a reason
 * added without a code fails to compile rather than travelling as undefined.
 *
 * `disabled` and `revoked` read as `coupon.expired`: to the buyer both mean
 * "this code used to work and no longer does", which is what expired says.
 */
const REFUSAL_FOR: Record<CouponRejection, CouponRefusalCode> = {
  'not-found': 'coupon.not_found',
  invalid: 'coupon.not_found',
  disabled: 'coupon.expired',
  revoked: 'coupon.expired',
  'not-started': 'coupon.not_started',
  expired: 'coupon.expired',
  'email-mismatch': 'coupon.email_mismatch',
  'minimum-not-met': 'coupon.min_subtotal',
  'usage-limit-reached': 'coupon.exhausted',
  'customer-limit-reached': 'coupon.already_redeemed',
  'no-eligible-items': 'coupon.not_applicable',
  'needs-more-items': 'coupon.not_applicable',
  'gift-unavailable': 'coupon.not_applicable',
};

/** The contract code for a reason. Unknown input is `coupon.not_found` — fail closed and vague. */
export function refusalCodeFor(reason: unknown): CouponRefusalCode {
  return (typeof reason === 'string' && Object.prototype.hasOwnProperty.call(REFUSAL_FOR, reason))
    ? REFUSAL_FOR[reason as CouponRejection]
    : 'coupon.not_found';
}

export interface CouponLine {
  product_id: string;
  categories?: string[];
  /** The product's free-text brand, for `brands` restrictions. */
  brand?: string;
  /** What the coupon may discount on this line: qty × unit (add-ons included per COUPONS_DISCOUNT_ADDONS). */
  amount_cents: number;
  /** Units on the line. Absent = 1. `bogo50` pairs UNITS, so it needs this. */
  qty?: number;
}

export interface CouponContext {
  /** Basket lines the discount may apply to. */
  lines: readonly CouponLine[];
  /** Basket total before discount. */
  subtotal_cents: number;
  /** Epoch ms. Injected so validity windows are testable. */
  nowMs: number;
  /** How many times THIS customer has already redeemed it. */
  customerUses?: number;
  /** The buyer's email, for email-bound coupons. */
  email?: string | null;
  /**
   * Resolves a `brands` entry to a brand key — `BrandDirectory.keyFor`, so a
   * published slug means what `?brand=` means. Without it, brands match by
   * identity (`brandKey`) only.
   */
  brandDirectory?: Pick<BrandDirectory, 'keyFor'>;
  /**
   * For `gift_product`: is the gift purchasable right now (active, a simple
   * product, at least one unit free beyond what the basket already takes)?
   * Decided by the caller, which has storage; absent = not available.
   */
  giftAvailable?: (productId: string) => boolean;
}

export interface CouponRejected {
  ok: false;
  reason: CouponRejection;
  /** The stable contract code for `reason` (`refusalCodeFor`). */
  refusal: CouponRefusalCode;
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
  /** For `gift_product`: the product to add at price 0. */
  gift_product_id?: string;
}

export type CouponResult = CouponAccepted | CouponRejected;

/** Codes are compared case- and whitespace-insensitively. */
export function normalizeCouponCode(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().toUpperCase().replace(/\s+/g, '') : '';
}

/** Emails are compared case-insensitively, after trimming. '' when absent. */
export function normalizeCouponEmail(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

/**
 * The usage limit in force: `single_use` caps it at one, whatever
 * `usage_limit` says. null = unlimited.
 */
export function effectiveUsageLimit(coupon: Pick<Coupon, 'usage_limit' | 'single_use'>): number | null {
  const limit = coupon.usage_limit ?? null;
  if (coupon.single_use === true) return limit === null ? 1 : Math.min(1, limit);
  return limit;
}

function reject(reason: CouponRejection, message: string, extra?: Partial<CouponRejected>): CouponRejected {
  return { ok: false, reason, refusal: refusalCodeFor(reason), message, ...extra };
}

/**
 * Lines this coupon may discount.
 *
 * `product_ids` and `category_slugs` are ONE filter, either of which admits a
 * line (as they always were). `brands` is a second filter that must ALSO hold.
 * So "Ray-Ban sunglasses" is `category_slugs: ['sunglasses'], brands:
 * ['Ray-Ban']`, and a line must be both. Empty lists mean "no restriction".
 */
function eligibleLines(coupon: Coupon, ctx: CouponContext) {
  const products = coupon.product_ids ?? [];
  const cats = (coupon.category_slugs ?? []).map((c) => c.toLowerCase());
  const brands = (coupon.brands ?? []).filter((b) => typeof b === 'string' && b.trim());
  return ctx.lines.filter((l) => {
    if (products.length || cats.length) {
      const byProduct = products.length > 0 && products.includes(l.product_id);
      const byCategory = cats.length > 0 && (l.categories ?? []).some((c) => cats.includes(c.toLowerCase()));
      if (!byProduct && !byCategory) return false;
    }
    if (brands.length && !brands.some((b) => brandMatches(l.brand, b, ctx.brandDirectory))) return false;
    return true;
  });
}

/**
 * The `bogo50` discount: "buy one, get the second half price", in PAIRS.
 *
 * How pairs are formed, across lines:
 *  1. Every eligible line is split into its units, each at the line's unit
 *     amount (`amount_cents / qty`).
 *  2. All units are sorted from most to least expensive (ties keep basket
 *     order, so the same basket always pairs the same way).
 *  3. They are paired in that order — 1st with 2nd, 3rd with 4th, … — and the
 *     SECOND of each pair (the cheaper, or equal) is half price.
 *  4. An odd unit left over (the cheapest) is not discounted.
 *
 * Pairing neighbours in price order is the common retail rule and the one a
 * customer can check by hand: two 100s and two 40s are (100,100) and (40,40),
 * so 50 + 20 off — not (100,40) twice, which would be cheaper for the shop
 * and look like a trick.
 *
 * The half is taken ONCE, over the total of the discounted units, rounded
 * half-up: 2 × 999 → 499.5 → 500. Rounding each unit would drift by a cent per
 * pair.
 *
 * Returns the discount and the number of pairs (0 = nothing to discount).
 */
export function bogoDiscount(lines: readonly Pick<CouponLine, 'amount_cents' | 'qty'>[]): { discount_cents: number; pairs: number } {
  const units: number[] = [];
  for (const l of lines) {
    const qty = Math.max(1, Math.floor(Number(l.qty ?? 1)) || 1);
    const amount = Math.max(0, Math.round(l.amount_cents));
    // Spread a remainder across the first units so the units sum to the line.
    const base = Math.floor(amount / qty);
    let extra = amount - base * qty;
    for (let i = 0; i < qty; i++) {
      units.push(base + (extra > 0 ? 1 : 0));
      if (extra > 0) extra -= 1;
    }
  }
  // Stable sort: equal prices keep basket order.
  const sorted = units.map((u, i) => ({ u, i })).sort((a, b) => (b.u - a.u) || (a.i - b.i)).map((x) => x.u);
  let cheaper = 0;
  let pairs = 0;
  for (let i = 1; i < sorted.length; i += 2) {
    cheaper += sorted[i];
    pairs += 1;
  }
  return { discount_cents: Math.round(cheaper / 2), pairs };
}

/**
 * Validate a coupon against a basket and compute its discount.
 *
 * Order of checks matters for the message the customer sees: identity,
 * validity window and the email the code is bound to first (nothing they can
 * do), then the minimum (something they CAN do — "spend 3 euro more"), then
 * limits, then whether anything in the basket qualifies.
 */
export function applyCoupon(coupon: Coupon | undefined | null, ctx: CouponContext): CouponResult {
  if (!coupon) {
    // Deliberately vague — see the module note about code enumeration.
    return reject('not-found', PUBLIC_COUPON_MESSAGE);
  }
  // A kind this build does not know is refused, never priced as something
  // else: falling through to "fixed" would hand out a stored value as money.
  if (!(COUPON_KINDS as readonly string[]).includes(coupon.kind)) {
    return reject('not-found', PUBLIC_COUPON_MESSAGE);
  }
  if (coupon.revoked_at) {
    return reject('revoked', 'That code is no longer active.');
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

  const boundTo = normalizeCouponEmail(coupon.email);
  if (boundTo && normalizeCouponEmail(ctx.email) !== boundTo) {
    return reject('email-mismatch', 'That code belongs to a different email address.');
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

  const limit = effectiveUsageLimit(coupon);
  if (limit != null && (Number(coupon.used_count) || 0) >= limit) {
    // A code bound to one email can only have been used by that buyer, so
    // "already used by you" is the true sentence; anyone else's code is used up.
    return boundTo
      ? reject('customer-limit-reached', 'You have already used that code.')
      : reject('usage-limit-reached', 'That code has reached its usage limit.');
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

  let discount = 0;
  let gift: string | undefined;
  switch (coupon.kind) {
    case 'percent':
      discount = Math.round((eligible * coupon.value) / 10_000);
      break;
    case 'fixed':
      discount = Math.round(coupon.value);
      break;
    case 'bogo50': {
      const bogo = bogoDiscount(lines);
      if (bogo.pairs === 0) {
        return reject('needs-more-items', 'Add one more qualifying item to use this code.');
      }
      discount = bogo.discount_cents;
      break;
    }
    case 'free_shipping':
      discount = 0;
      break;
    case 'gift_product': {
      const id = typeof coupon.gift_product_id === 'string' ? coupon.gift_product_id : '';
      if (!id || !ctx.giftAvailable?.(id)) {
        return reject('gift-unavailable', 'The gift that comes with this code is not available right now.');
      }
      gift = id;
      discount = 0;
      break;
    }
    default:
      // Unreachable while COUPON_KINDS and this switch agree; the guard at the
      // top already refused anything else. Fail closed if they ever drift.
      return reject('not-found', PUBLIC_COUPON_MESSAGE);
  }

  // A discount can never exceed what it applies to. Without this clamp a
  // 50-euro fixed coupon on a 20-euro basket yields a NEGATIVE total, which
  // downstream becomes a payment request for a negative amount.
  discount = Math.max(0, Math.min(discount, eligible));

  return {
    ok: true,
    coupon,
    discount_cents: discount,
    eligible_cents: eligible,
    freeShipping: coupon.kind === 'free_shipping' || coupon.free_shipping === true,
    ...(gift ? { gift_product_id: gift } : {}),
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

export function publicCouponRejection(rejected: Omit<CouponRejected, 'refusal'> & { refusal?: CouponRefusalCode }): CouponRejected {
  if (rejected.reason === 'minimum-not-met') return { ...rejected, refusal: 'coupon.min_subtotal' };
  // `refusal` too: `coupon.email_mismatch` or `coupon.already_redeemed`
  // would say the code exists exactly as loudly as `reason` did.
  return { ok: false, reason: 'invalid', refusal: 'coupon.not_found', message: PUBLIC_COUPON_MESSAGE };
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
