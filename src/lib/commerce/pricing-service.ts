/**
 * Storage-backed pricing: resolve a basket, then price it.
 *
 * The thin seam between the pure calculators and the database. `quote` and
 * `placeOrder` BOTH call `priceBasket()`; neither computes anything itself.
 * That is the guarantee the storefront needs — the number shown on the cart
 * page and the number charged come from one function, so they cannot drift.
 */

import { LocalDB } from '../localdb';
import {
  resolveTaxSettings, resolveTaxTreatment, rateForTreatment,
  type TaxSettings, type TaxTreatment,
} from './tax';
import {
  availableMethods, resolveChosenMethod,
  type AvailableMethod, type ShippingDestination, type ShippableBasket,
} from './shipping';
import { applyCoupon, normalizeCouponCode, type CouponResult } from './coupons';
import { calculateTotals, type OrderTotals, type TotalsLine } from './totals';
import {
  resolvePurchasable, explainResolveFailure, variantAvailability,
  type ResolvedPurchasable,
} from './variants';
import type { Product } from '../../core/models';

export interface BasketRequestLine {
  product_id: string;
  /** Required when the product is variable. */
  variant_id?: string | null;
  qty: number;
}

export interface PriceBasketInput {
  items: readonly BasketRequestLine[];
  destination?: ShippingDestination;
  /**
   * The customer's VAT id, if they gave one. A CLAIM, not a verified fact —
   * core checks its shape only; VIES lookup and evidence retention need a
   * credential and live behind the seam.
   */
  customer_tax_id?: string;
  shipping_method_id?: string | null;
  coupon_code?: string | null;
  /** Used for per-customer coupon limits. */
  email?: string | null;
  /** Injected so validity windows are testable. */
  nowMs?: number;
}

export type PriceFailure =
  | { ok: false; status: number; message: string; code?: string };

export interface PricedBasket {
  /** Whose tax rules were applied. Recorded so an order can state it. */
  treatment: TaxTreatment;
  ok: true;
  totals: OrderTotals;
  /** Products resolved from storage, aligned with `totals.lines`. */
  products: Product[];
  /** What each line actually resolved to (variant price, name, stock). */
  resolved: ResolvedPurchasable[];
  shipping: AvailableMethod | null;
  availableShipping: AvailableMethod[];
  coupon: CouponResult | null;
  tax: TaxSettings;
}

export type PriceResult = PricedBasket | PriceFailure;

const fail = (status: number, message: string, code?: string): PriceFailure =>
  ({ ok: false, status, message, code });

/**
 * Resolve + price a basket.
 *
 * `checkAvailability` is the one behavioural difference between quoting and
 * ordering: a quote should still price a basket whose stock ran out a moment
 * ago (so the cart can show it and say why), while an order must refuse. Stock
 * is NEVER reserved here — reservation stays in placeOrder, inside its
 * rollback, because a quote that reserved stock would let anyone empty a
 * catalogue by refreshing a cart page.
 */
export async function priceBasket(
  input: PriceBasketInput,
  opts: { checkAvailability: boolean } = { checkAvailability: false },
): Promise<PriceResult> {
  if (!Array.isArray(input.items) || input.items.length === 0) {
    return fail(400, 'Basket needs at least one item');
  }

  const settingsRows = await LocalDB.getSettings();
  const settingsMap: Record<string, unknown> = {};
  for (const r of settingsRows) settingsMap[r.key] = r.value;
  const tax = resolveTaxSettings(settingsMap);

  // --- resolve products ---
  const products: Product[] = [];
  const resolvedLines: ResolvedPurchasable[] = [];
  const lines: TotalsLine[] = [];
  for (const item of input.items) {
    const qty = Math.floor(Number(item.qty));
    if (!Number.isFinite(qty) || qty < 1) return fail(400, 'Invalid quantity');

    const product = await LocalDB.getProduct(item.product_id);
    if (!product || product.status !== 'active') {
      return fail(400, `Product unavailable: ${item.product_id}`);
    }

    // Resolve WHICH thing is being bought. A variable product without a valid
    // variant is refused rather than defaulted — an order for "the frame"
    // with no colour cannot be picked from a shelf.
    const resolved = resolvePurchasable(product, item.variant_id);
    if (!resolved) {
      const why = explainResolveFailure(product, item.variant_id);
      return fail(400, why.message, why.code);
    }

    if (opts.checkAvailability) {
      // Reads the VARIANT's own count when there is one.
      const allowed = variantAvailability(resolved, product, qty);
      // Only the POLICY refusals are decided here; the stock decision belongs
      // to the atomic reserve in placeOrder, which answers 409.
      if (!allowed.ok && allowed.code !== 'insufficient-stock') {
        return fail(400, `${allowed.reason}: ${resolved.name}`);
      }
    }

    products.push(product);
    resolvedLines.push(resolved);
    lines.push({
      product_id: product.id,
      variant_id: resolved.variant_id,
      name: resolved.name,
      qty,
      unit_price_cents: resolved.price_cents,
      tax_class: product.tax_class,
      tax_status: product.tax_status,
      weight_grams: resolved.weight_grams ?? 0,
      requires_shipping: product.requires_shipping !== false && product.virtual !== true,
      categories: product.categories,
    });
  }

  // --- coupon (before shipping, because it may waive shipping) ---
  const nowMs = input.nowMs ?? Date.now();
  const subtotalForCoupon = lines.reduce(
    (s, l) => s + Math.round(l.unit_price_cents) * l.qty, 0,
  );
  let coupon: CouponResult | null = null;
  const code = normalizeCouponCode(input.coupon_code);

  // The lines a coupon is judged against, built once: an automatic rule and a
  // typed code must be measured against exactly the same basket, or the two
  // paths would eventually disagree about what a discount is worth.
  const couponLines = lines.map((l, i) => ({
    product_id: l.product_id,
    categories: products[i].categories,
    amount_cents: Math.round(l.unit_price_cents) * l.qty,
  }));

  if (code) {
    const all = await LocalDB.getCoupons();
    const found = all.find((c) => normalizeCouponCode(c.code) === code);

    // Per-customer limit needs the customer's history. Only counted when the
    // coupon actually sets a limit — otherwise every quote would scan orders.
    let customerUses = 0;
    if (found?.usage_limit_per_customer != null && input.email) {
      const email = input.email.trim().toLowerCase();
      const orders = await LocalDB.getOrders();
      customerUses = orders.filter(
        (o) => o.email?.toLowerCase() === email &&
          normalizeCouponCode(o.coupon_code) === code &&
          o.status !== 'cancelled',
      ).length;
    }

    coupon = applyCoupon(found, {
      lines: couponLines,
      subtotal_cents: subtotalForCoupon,
      nowMs,
      customerUses,
    });
  } else {
    // AUTOMATIC RULES. No code was typed, so the shop's own rules apply —
    // "spend €50, free shipping" and its relatives, which is roughly half of
    // what a shop wants from promotions and needed no new engine.
    //
    // ONE discount per order, and the BEST one for the customer. Stacking is
    // not supported and is not an oversight: an order carries a single
    // `discount_cents` and a single `coupon_code`, so two stacked rules could
    // not be recorded, refunded or explained afterwards. Adding the model for
    // that is a real feature; quietly summing two rules into one number that
    // reconciles to neither is a bug.
    //
    // A typed code WINS over automatic rules — the branch above — because a
    // customer who entered a code chose it, and silently substituting something
    // else, even something better, is the kind of surprise that generates a
    // support message.
    const all = await LocalDB.getCoupons();
    // `enabled` here is a PRE-FILTER, not the guard: `applyCoupon` refuses a
    // disabled coupon on its own, which is what actually protects this — a
    // mutation removing `&& c.enabled` changes no behaviour. It is kept so a
    // shop with many switched-off promotions does not evaluate every one of
    // them on every cart change.
    const automatic = all.filter((c) => c.automatic === true && c.enabled);
    let best: CouponResult | null = null;
    for (const rule of automatic) {
      // Per-customer limits are NOT counted for automatic rules: doing so would
      // scan every order on every quote, for every rule, on a path that runs on
      // each cart change. A rule that needs per-customer limits needs a code.
      const result = applyCoupon(rule, {
        lines: couponLines,
        subtotal_cents: subtotalForCoupon,
        nowMs,
      });
      if (!result.ok) continue;
      const better = !best || !best.ok
        || result.discount_cents > best.discount_cents
        // A tie on money is broken by free shipping, which is worth something
        // the discount figure does not capture.
        || (result.discount_cents === best.discount_cents
            && result.freeShipping && !best.freeShipping);
      if (better) best = result;
    }
    coupon = best;
  }
  const discount_cents = coupon?.ok ? coupon.discount_cents : 0;

  // --- shipping ---
  const requiresShipping = lines.some((l) => l.requires_shipping !== false);
  const weight_grams = lines.reduce(
    (s, l) => s + (l.requires_shipping === false ? 0 : Math.max(0, l.weight_grams ?? 0) * l.qty), 0,
  );
  const basket: ShippableBasket = {
    // The free-shipping threshold is judged AFTER the discount: a coupon that
    // drops a basket below the threshold should also drop the free shipping,
    // or the two promotions stack in a way nobody intended.
    subtotal_cents: Math.max(0, subtotalForCoupon - discount_cents),
    weight_grams,
    requiresShipping,
  };

  const methods = await LocalDB.getShippingMethods();
  const dest = input.destination ?? {};
  const offered = availableMethods(methods, dest, basket);

  let shipping: AvailableMethod | null = null;
  if (requiresShipping) {
    if (opts.checkAvailability) {
      // Ordering: the choice must be valid. Quoting tolerates no choice yet,
      // because a cart page asks for totals before the customer has picked.
      const resolved = resolveChosenMethod(methods, input.shipping_method_id, dest, basket);
      if (!resolved.ok) return fail(400, resolved.reason, 'SHIPPING_REQUIRED');
      shipping = resolved.method;
    } else if (input.shipping_method_id) {
      shipping = offered.find((m) => m.id === input.shipping_method_id) ?? null;
    }
  }

  // A free-shipping coupon zeroes the cost but keeps the method, so the
  // customer still sees WHICH carrier is taking it.
  const shippingCost = coupon?.ok && coupon.freeShipping ? 0 : (shipping?.cost_cents ?? 0);

  /*
   * WHOSE tax rules apply, resolved ONCE for the whole basket.
   *
   * Place of supply for transport ancillary to a supply of goods follows the
   * goods, so shipping uses the SAME treatment at the shipping class rather
   * than a second ladder that could disagree with the first.
   *
   * Resolved here rather than inside calculateTotals so that stays pure and
   * storage-free — it takes the answer, it does not go looking for it.
   */
  const treatment = resolveTaxTreatment({
    settings: tax,
    destination: dest,
    customerTaxId: input.customer_tax_id,
    classes: [...new Set(lines.map((l) => l.tax_class ?? tax.defaultClass))],
  });

  /*
   * REFUSE rather than guess.
   *
   * Every fallback available here is wrong in a way nobody notices on the
   * invoice: 0% under-charges the buyer's own tax authority, and the origin
   * rate charges a German customer Greek VAT. So a destination whose rate is
   * not on file stops checkout and names exactly what the operator must add.
   */
  if (treatment.kind === 'not-configured') {
    const m = treatment.missing;
    return fail(
      409,
      `No VAT rate on file for ${m?.country} (${(m?.classes ?? []).join(', ')}). `
      + 'Add a rate for it in the tax settings before selling there.',
      'checkout.tax_not_configured',
    );
  }

  const totals = calculateTotals({
    lines,
    tax,
    treatment,
    destination_postcode: dest.postcode,
    discount_cents,
    shipping_cents: shippingCost,
    shipping_tax_class: shipping?.tax_class,
  });

  return {
    ok: true,
    treatment,
    totals,
    products,
    resolved: resolvedLines,
    shipping: shipping ? { ...shipping, cost_cents: shippingCost } : null,
    availableShipping: offered,
    coupon,
    tax,
  };
}

/** Allocate the next order number atomically. */
export async function nextOrderNumber(prefix = 'AB'): Promise<string> {
  const n = await LocalDB.nextSequence('order_number');
  return `${prefix}-${n}`;
}
