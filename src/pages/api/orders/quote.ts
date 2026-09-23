import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { priceBasket } from '../../../lib/commerce/pricing-service';
import { getOrderLimits, resolvePresentment } from '../../../lib/commerce-service';
import { convertTotals, offeredCurrencies } from '../../../lib/commerce/currency-rates';
import { publicCouponRejection } from '../../../lib/commerce/coupons';
import { canReadCommerce } from '../../../lib/auth';

/**
 * POST /api/orders/quote — what would this basket cost?
 *
 * Same input shape as `POST /api/orders`, but creates NOTHING: no order, no
 * customer, and — importantly — no stock reservation. A cart page calls this on
 * every quantity change, and a quote that reserved stock would let anyone empty
 * a catalogue by holding refresh.
 *
 * It runs the same `priceBasket()` that `placeOrder()` runs. That is the point:
 * the number on the cart page and the number charged come from one function, so
 * they cannot drift.
 *
 * Public, like checkout, and bounded the same way (order limits, per-IP rate
 * limit, body size). Usable with an `orders:write` API key so a headless
 * storefront can call it server-to-server.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  try {
    await LocalDB.init();
    const body = await request.json().catch(() => null);
    const rawItems = (body as any)?.items;
    if (!Array.isArray(rawItems) || rawItems.length === 0) {
      return ApiResponseBuilder.badRequest('Quote needs at least one item');
    }

    // The same caps checkout applies. A quote endpoint without them is a free
    // way to make the server price a 10,000-line basket.
    const limits = await getOrderLimits();
    if (rawItems.length > limits.maxItemsPerOrder) {
      return ApiResponseBuilder.badRequest(`Too many items in one order (max ${limits.maxItemsPerOrder})`);
    }

    const items = rawItems
      .filter((i: any) => i && typeof i.product_id === 'string' && Number.isFinite(Number(i.qty)))
      .map((i: any) => ({
        product_id: i.product_id,
        // Which variation. Validated against the product server-side; an
        // unknown or absent one for a variable product is refused, never
        // defaulted to "the first colour".
        variant_id: typeof i.variant_id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(i.variant_id)
          ? i.variant_id : undefined,
        qty: Number(i.qty),
      }));
    if (!items.length) return ApiResponseBuilder.badRequest('No valid items');
    for (const i of items) {
      if (i.qty > limits.maxQtyPerProduct) {
        return ApiResponseBuilder.badRequest(`At most ${limits.maxQtyPerProduct} of any one product per order`);
      }
    }

    const priced = await priceBasket({
      items,
      destination: {
        country: typeof (body as any)?.shipping_country === 'string' ? (body as any).shipping_country : undefined,
        postcode: typeof (body as any)?.shipping_postcode === 'string' ? (body as any).shipping_postcode : undefined,
      },
      shipping_method_id: typeof (body as any)?.shipping_method_id === 'string' ? (body as any).shipping_method_id : null,
      coupon_code: typeof (body as any)?.coupon_code === 'string' ? (body as any).coupon_code : null,
      email: typeof (body as any)?.email === 'string' ? (body as any).email : null,
    });

    if (!priced.ok) return ApiResponseBuilder.error(priced.status, priced.message);

    /*
     * Who may learn WHY a code was refused. Staff previewing a basket in the
     * admin (a session with commerce access) see the real reason. Everyone
     * else — an anonymous cart page, and an API key, which is a storefront that
     * will repeat what it is told — sees what a code that does not exist
     * gets, except the minimum-spend shortfall. Otherwise this endpoint told a
     * script which of the codes it tried were real and merely expired or used
     * up; see publicCouponRejection.
     */
    const user = locals.user;
    const staffView = !!user && !String(user.id).startsWith('apikey:') && canReadCommerce(user.role);
    const rejected = priced.coupon && !priced.coupon.ok
      ? (staffView ? priced.coupon : publicCouponRejection(priced.coupon))
      : null;

    /*
     * Restate the quote in the buyer's currency, through the SAME resolver and
     * the SAME converter checkout uses.
     *
     * A quote in one currency and a charge in another is the worst shape of
     * this bug — every number is right and only the symbol is wrong, so nobody
     * notices until an invoice does. Sharing the code is the only way to be
     * sure the two agree; sharing a comment is not.
     */
    const presentment = await resolvePresentment((body as any)?.currency);
    const t = presentment.rate
      ? convertTotals(priced.totals, presentment.settings.base, presentment.currency, presentment.rate.rate_ppm)
      : priced.totals;
    return ApiResponseBuilder.success({
      subtotal_cents: t.subtotal_cents,
      discount_cents: t.discount_cents,
      shipping_cents: t.shipping_cents,
      shipping_tax_cents: t.shipping_tax_cents,
      tax_cents: t.tax_cents,
      total_cents: t.total_cents,
      // The SAME reader `placeOrder` uses. A basket quoted in one currency and
      // an order placed in another is the worst shape of this bug: every number
      // is right and only the symbol is wrong, so nobody notices until an
      // invoice does.
      currency: presentment.currency,
      /**
       * What the storefront needs to offer a currency picker, and to be honest
       * about the answer it got: `currency` is what this quote is IN, which is
       * the base currency when the requested one is not on offer rather than an
       * error. A client that asked for CAD and sees EUR knows immediately.
       */
      base_currency: presentment.settings.base,
      available_currencies: offeredCurrencies(presentment.settings),
      ...(presentment.rate
        ? {
            fx_rate_ppm: presentment.rate.rate_ppm,
            fx_rate_at: presentment.rate.updated_at,
            // Surfaced rather than hidden. A storefront may want to say
            // "indicative" next to a price the operator has not refreshed.
            fx_rate_stale: presentment.rate.stale,
          }
        : {}),
      prices_include_tax: t.prices_include_tax,
      requires_shipping: t.requires_shipping,
      weight_grams: t.weight_grams,
      lines: t.lines,
      /** Render these as the customer's choices. */
      available_shipping_methods: priced.availableShipping,
      selected_shipping_method: priced.shipping,
      /**
       * A rejected coupon is reported here rather than as an error: the rest of
       * the quote is still valid and the cart should show the totals AND the
       * reason the code did not apply.
       */
      coupon: priced.coupon
        ? priced.coupon.ok
          ? { ok: true, code: priced.coupon.coupon.code, discount_cents: priced.coupon.discount_cents, free_shipping: priced.coupon.freeShipping }
          : { ok: false, reason: rejected!.reason, message: rejected!.message, shortfall_cents: rejected!.shortfall_cents }
        : null,
    }, 'Quote');
  } catch (err) {
    console.error('Quote error:', err);
    return ApiResponseBuilder.serverError('Failed to price the basket');
  }
};
