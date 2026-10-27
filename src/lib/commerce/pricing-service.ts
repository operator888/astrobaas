/**
 * Storage-backed pricing: resolve a basket, then price it.
 *
 * The thin seam between the pure calculators and the database. `quote` and
 * `placeOrder` BOTH call `priceBasket()`; neither computes anything itself.
 * That is the guarantee the storefront needs — the number shown on the cart
 * page and the number charged come from one function, so they cannot drift.
 */

import { LocalDB } from '../localdb';
import { pluginManager, PLUGIN_HOOKS } from '../plugin-system';
import type { Address, OrderLineAddon } from '../../core/models';
import { priceLineAddons, COUPONS_DISCOUNT_ADDONS } from './line-addons';
import {
  resolveTaxTreatment, rateForTreatment, productIsTaxable,
  type TaxSettings, type TaxTreatment,
} from './tax';
import { resolveTaxSettingsWithPlugins } from './tax-plugins';
import {
  availableMethods, resolveChosenMethod,
  type AvailableMethod, type ShippingDestination, type ShippableBasket,
} from './shipping';
import { applyCoupon, normalizeCouponCode, type Coupon, type CouponResult } from './coupons';
import { couponEmailKey } from './coupon-service';
import { buildBrandDirectory, type BrandDirectory } from './brand';
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
  /**
   * Priced add-on selections, keyed by namespace (`{ lens: ['ar'] }`), as the
   * client sent them. Checked and priced by PLUGIN_HOOKS.ORDER_LINE_ADDONS —
   * see lib/commerce/line-addons.ts.
   */
  addons?: unknown;
  /**
   * The line's prescription AS POSTED (display units). Not validated here —
   * ORDER_LINE_EXTRAS does that at checkout — only handed to the add-on
   * filter, which may price by power.
   */
  prescription?: unknown;
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
  /** The country the tax id was entered next to (billing). A hint only. */
  customer_tax_country?: string;
  shipping_method_id?: string | null;
  coupon_code?: string | null;
  /** Used for per-customer coupon limits. */
  email?: string | null;
  /** Injected so validity windows are testable. */
  nowMs?: number;
}

export type PriceFailure =
  | { ok: false; status: number; message: string; code?: string; params?: Record<string, string | number> };

export interface PricedBasket {
  /** Whose tax rules were applied. Recorded so an order can state it. */
  treatment: TaxTreatment;
  ok: true;
  totals: OrderTotals;
  /** Products resolved from storage, aligned with `totals.lines`. */
  products: Product[];
  /** What each line actually resolved to (variant price, name, stock). */
  resolved: ResolvedPurchasable[];
  /**
   * The add-ons priced into each line, aligned with `totals.lines`; `[]` for
   * a line with none. Their `unit_price_cents` are already inside the line's
   * `unit_price_cents` — an order freezes these, it never re-prices them.
   */
  addons: OrderLineAddon[][];
  shipping: AvailableMethod | null;
  availableShipping: AvailableMethod[];
  coupon: CouponResult | null;
  /**
   * Index in `totals.lines` of the free unit a `gift_product` coupon added —
   * always the LAST line — or null. Every other line is one of the request's
   * items, in order.
   */
  giftLineIndex: number | null;
  tax: TaxSettings;
}

export type PriceResult = PricedBasket | PriceFailure;

const fail = (
  status: number, message: string, code?: string, params?: Record<string, string | number>,
): PriceFailure => ({ ok: false, status, message, code, ...(params ? { params } : {}) });

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
  // The operator's rows plus any PLUGIN_HOOKS.TAX_RATES rows — the same
  // table the tax-override route uses. See lib/commerce/tax-plugins.ts.
  const tax = resolveTaxSettingsWithPlugins(settingsMap);

  // --- resolve products ---
  const products: Product[] = [];
  const resolvedLines: ResolvedPurchasable[] = [];
  const lines: TotalsLine[] = [];
  const lineAddons: OrderLineAddon[][] = [];
  /** Per-unit add-on cents of each line, for the coupon decision below. */
  const addonUnits: number[] = [];
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

    /*
     * THE unit price, decided HERE and nowhere else.
     *
     * PLUGIN_HOOKS.PRODUCT_PRICE used to be applied only by placeOrder, to
     * each stored line's `total_cents`, while the order's totals came from
     * this function at the catalogue price: as soon as a plugin used the hook,
     * a quote disagreed with its order and an order's lines disagreed with its
     * own total. Applied here, the quote, the totals and the frozen lines all
     * read one number.
     */
    const unit = pluginManager.applyFilters(
      PLUGIN_HOOKS.PRODUCT_PRICE, resolved.price_cents, product, { qty, variant: resolved },
    ) as number;
    if (!Number.isInteger(unit) || unit < 0) {
      return fail(500, 'Price hook returned an invalid price', 'checkout.price_invalid');
    }

    // Priced add-ons, ON TOP of that unit price and BEFORE coupons, the
    // free-shipping threshold and tax, so every total below sees them.
    const priced = priceLineAddons({
      line: item as unknown as Record<string, unknown>,
      product,
      variant: resolved,
      qty,
      name: resolved.name,
      settings: settingsMap,
    });
    if (!priced.ok) return fail(priced.status, priced.message, priced.code, priced.params);

    products.push(product);
    resolvedLines.push(resolved);
    lineAddons.push(priced.addons);
    addonUnits.push(priced.unit_cents);
    lines.push({
      product_id: product.id,
      variant_id: resolved.variant_id,
      name: resolved.name,
      qty,
      unit_price_cents: unit + priced.unit_cents,
      tax_class: product.tax_class,
      tax_status: product.tax_status,
      weight_grams: resolved.weight_grams ?? 0,
      requires_shipping: product.requires_shipping !== false && product.virtual !== true,
      categories: product.categories,
    });
  }

  // --- coupon (before shipping, because it may waive shipping) ---
  const nowMs = input.nowMs ?? Date.now();
  // What a coupon may discount, per line. COUPONS_DISCOUNT_ADDONS is the
  // owner's decision on add-ons; see lib/commerce/line-addons.ts.
  const couponAmount = (l: TotalsLine, i: number) =>
    Math.round(l.unit_price_cents) * l.qty - (COUPONS_DISCOUNT_ADDONS ? 0 : addonUnits[i] * l.qty);
  const subtotalForCoupon = lines.reduce((s, l, i) => s + couponAmount(l, i), 0);
  const subtotalAll = lines.reduce(
    (s, l) => s + Math.round(l.unit_price_cents) * l.qty, 0,
  );
  let coupon: CouponResult | null = null;
  const code = normalizeCouponCode(input.coupon_code);

  // The lines a coupon is judged against, built once: an automatic rule and a
  // typed code must be measured against exactly the same basket, or the two
  // paths would eventually disagree about what a discount is worth. `qty` is
  // there for bogo50, which pairs units; `brand` for brand-restricted codes.
  const couponLines = lines.map((l, i) => ({
    product_id: l.product_id,
    categories: products[i].categories,
    brand: typeof products[i].brand === 'string' ? products[i].brand : undefined,
    amount_cents: couponAmount(l, i),
    qty: l.qty,
  }));

  /*
   * What a coupon needs from storage besides the basket, loaded only for the
   * coupons that will actually be judged — so a shop without brand-restricted
   * or gift coupons pays nothing for either.
   *
   * BRANDS go through the same directory `?brand=` uses (buildBrandDirectory
   * over the stored products and curated brands), so a coupon naming
   * `ray-ban` means exactly the products that link shows.
   *
   * A GIFT is available when its product is active, a simple product, and has
   * a unit free beyond what this basket already takes of it. No backorders: a
   * gift the shop does not have is not a gift. Checked on the quote as well as
   * the order, so a quote never promises a gift the order would refuse.
   */
  const couponContextFor = async (candidates: readonly Coupon[]) => {
    let brandDirectory: Pick<BrandDirectory, 'keyFor'> | undefined;
    if (candidates.some((c) => (c.brands ?? []).length > 0)) {
      brandDirectory = buildBrandDirectory(await LocalDB.getProducts(), await LocalDB.getBrands());
    }
    const gifts = new Map<string, boolean>();
    for (const c of candidates) {
      const id = c.kind === 'gift_product' && typeof c.gift_product_id === 'string' ? c.gift_product_id : '';
      if (!id || gifts.has(id)) continue;
      const product = await LocalDB.getProduct(id);
      const resolved = product && product.status === 'active' ? resolvePurchasable(product, null) : null;
      // When ORDERING, placeOrder has already reserved the basket's own units
      // before pricing, so the stock read here is net of them; counting them
      // again refused a gift the shop had (quote yes, order no). When QUOTING
      // nothing is reserved, so the basket's units are taken off here.
      const inBasket = opts.checkAvailability
        ? 0
        : lines.reduce((s, l) => s + (l.product_id === id && !l.variant_id ? l.qty : 0), 0);
      gifts.set(id, !!resolved && (resolved.stock === null || resolved.stock === undefined || resolved.stock >= inBasket + 1));
    }
    return { brandDirectory, giftAvailable: (id: string) => gifts.get(id) === true };
  };

  if (code) {
    const all = await LocalDB.getCoupons();
    const found = all.find((c) => normalizeCouponCode(c.code) === code);

    /*
     * Per-customer uses. Only counted when the coupon actually sets a limit —
     * otherwise every quote would scan orders.
     *
     * Two sources, and the larger wins. The ORDER SCAN is what this always
     * was, and is the only history a coupon redeemed before per-email counting
     * existed has. The COUNTER (`redemptions_by_email`, kept atomically by
     * claimCouponUse) is what two concurrent checkouts by one buyer cannot
     * both slip past — the scan alone cannot see an order that is being
     * written at the same moment.
     */
    let customerUses = 0;
    if (found?.usage_limit_per_customer != null && input.email) {
      const email = input.email.trim().toLowerCase();
      const orders = await LocalDB.getOrders();
      const scanned = orders.filter(
        (o) => o.email?.toLowerCase() === email &&
          normalizeCouponCode(o.coupon_code) === code &&
          o.status !== 'cancelled',
      ).length;
      const key = couponEmailKey(email);
      const counted = key ? Number(found.redemptions_by_email?.[key]) || 0 : 0;
      customerUses = Math.max(scanned, counted);
    }

    coupon = applyCoupon(found, {
      lines: couponLines,
      subtotal_cents: subtotalForCoupon,
      nowMs,
      customerUses,
      email: input.email,
      ...(found ? await couponContextFor([found]) : {}),
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
    const extra = automatic.length ? await couponContextFor(automatic) : {};
    let best: CouponResult | null = null;
    for (const rule of automatic) {
      // Per-customer limits are NOT counted for automatic rules: doing so would
      // scan every order on every quote, for every rule, on a path that runs on
      // each cart change. A rule that needs per-customer limits needs a code.
      const result = applyCoupon(rule, {
        lines: couponLines,
        subtotal_cents: subtotalForCoupon,
        nowMs,
        email: input.email,
        ...extra,
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

  /*
   * --- the gift, when the coupon is a gift_product ---
   *
   * One unit, priced 0, appended as the LAST line so every array aligned with
   * `lines` (products, resolved, addons) stays aligned and the basket's own
   * lines keep their indexes. Added AFTER the coupon was judged, so the gift
   * never counts towards its own minimum spend, and BEFORE shipping, so its
   * weight is shipped. At price 0 it carries no tax and no share of the
   * discount (allocateDiscount gives a 0 line nothing).
   */
  let giftLineIndex: number | null = null;
  if (coupon?.ok && coupon.gift_product_id) {
    const gift = await LocalDB.getProduct(coupon.gift_product_id);
    const resolved = gift ? resolvePurchasable(gift, null) : null;
    if (gift && resolved) {
      giftLineIndex = lines.length;
      products.push(gift);
      resolvedLines.push(resolved);
      lineAddons.push([]);
      addonUnits.push(0);
      lines.push({
        product_id: gift.id,
        name: resolved.name,
        qty: 1,
        unit_price_cents: 0,
        tax_class: gift.tax_class,
        // 'none', not the product's own status: at price 0 the line owes no
        // tax either way, and a taxable status would make the sale need a VAT
        // rate for the gift's class — refusing a checkout over a free unit —
        // and could decide on its own whether SHIPPING is taxed.
        tax_status: 'none',
        weight_grams: resolved.weight_grams ?? 0,
        requires_shipping: gift.requires_shipping !== false && gift.virtual !== true,
        categories: gift.categories,
      });
    }
  }

  // --- shipping ---
  const requiresShipping = lines.some((l) => l.requires_shipping !== false);
  const weight_grams = lines.reduce(
    (s, l) => s + (l.requires_shipping === false ? 0 : Math.max(0, l.weight_grams ?? 0) * l.qty), 0,
  );
  const basket: ShippableBasket = {
    // The free-shipping threshold is judged AFTER the discount: a coupon that
    // drops a basket below the threshold should also drop the free shipping,
    // or the two promotions stack in a way nobody intended.
    subtotal_cents: Math.max(0, subtotalAll - discount_cents),
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
    customerCountry: input.customer_tax_country,
    // PLUGIN_HOOKS.TAX_ID_VERDICT. resolveTaxTreatment calls this only where
    // the answer could change the sale's tax, so a shop without reverse
    // charge — or without a verifier — pays nothing for it. Settings are read
    // here (async) and handed in, because the filter is synchronous.
    taxIdVerdict: ({ taxId, country }) => pluginManager.applyFilters(
      PLUGIN_HOOKS.TAX_ID_VERDICT,
      { status: 'unchecked' },
      { taxId, ...(country ? { country } : {}), destination: dest.country, settings: { ...settingsMap } },
    ),
    // Only lines that are TAXED need a rate. A `tax_status: 'none'` product
    // owes no VAT anywhere, so a missing row for its class must not refuse
    // the sale (domestic or destination).
    classes: [...new Set(lines.filter((l) => productIsTaxable(l.tax_status))
      .map((l) => l.tax_class ?? tax.defaultClass))],
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
      + (m?.country && m.country === tax.originCountry
        ? 'Add a rate for it to your own country\'s rows in the tax settings.'
        : 'Add a rate for it in the tax settings before selling there.'),
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
    addons: lineAddons,
    shipping: shipping ? { ...shipping, cost_cents: shippingCost } : null,
    availableShipping: offered,
    coupon,
    giftLineIndex,
    tax,
  };
}

/**
 * The buyer's tax id for pricing, from the order's addresses.
 *
 * ONE reader for `placeOrder` and the quote route, so the two cannot disagree
 * about which number a sale was priced on. The billing address wins (it is
 * the invoice's counterparty); the delivery address is the fallback, which is
 * also what `placeOrder` stores as billing when none was sent.
 *
 * Captured, never validated (see `Address.tax_id`): whatever is here only
 * ever feeds reverse charge, and nothing about it can refuse an order.
 */
export function buyerTaxId(
  billing?: Pick<Address, 'tax_id' | 'country'> | null,
  shipping?: Pick<Address, 'tax_id' | 'country'> | null,
): { customer_tax_id?: string; customer_tax_country?: string } {
  for (const a of [billing, shipping]) {
    const id = typeof a?.tax_id === 'string' ? a.tax_id.trim() : '';
    if (!id) continue;
    const country = typeof a?.country === 'string' && a.country.trim() ? a.country.trim() : undefined;
    return { customer_tax_id: id, ...(country ? { customer_tax_country: country } : {}) };
  }
  return {};
}

/** Allocate the next order number atomically. */
export async function nextOrderNumber(prefix = 'AB'): Promise<string> {
  const n = await LocalDB.nextSequence('order_number');
  return `${prefix}-${n}`;
}
