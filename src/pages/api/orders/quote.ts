import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { priceBasket, buyerTaxId } from '../../../lib/commerce/pricing-service';
import { normalizeAddress, isEmptyAddress } from '../../../lib/commerce/address';
import type { Address } from '../../../core/models';
import { getOrderLimits, resolvePresentment } from '../../../lib/commerce-service';
import { convertTotals, convertMinorUnits, offeredCurrencies } from '../../../lib/commerce/currency-rates';
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
        // The same two per-line fields checkout takes, so a quote prices what
        // the order will: add-ons (refused here exactly as there when the
        // shape is wrong or nothing handles them), and the prescription the
        // add-on filter may price by. Not validated here — checkout does.
        ...(i.addons !== undefined ? { addons: i.addons } : {}),
        ...(i.prescription !== undefined ? { prescription: i.prescription } : {}),
      }));
    if (!items.length) return ApiResponseBuilder.badRequest('No valid items');
    for (const i of items) {
      if (i.qty > limits.maxQtyPerProduct) {
        return ApiResponseBuilder.badRequest(`At most ${limits.maxQtyPerProduct} of any one product per order`);
      }
    }

    /*
     * The addresses, read the way `placeOrder` reads them, so a quote and the
     * order that follows it are priced on the same facts.
     *
     * The buyer's VAT id lives on `billing_address.tax_id` (delivery address as
     * fallback) — the SAME helper placeOrder uses. Without it a B2B buyer was
     * quoted VAT that reverse charge should have removed. And the destination
     * falls back to `shipping_address`, as an order's does.
     *
     * Lenient on purpose: a malformed address is ignored here rather than
     * refused. The order will refuse it with the reason; a cart page asking for
     * totals mid-typing should still get totals.
     */
    const addr = (raw: unknown): Address | undefined => {
      if (raw === undefined || raw === null) return undefined;
      const parsed = normalizeAddress(raw);
      return parsed.ok && !isEmptyAddress(parsed.value) ? parsed.value : undefined;
    };
    const shippingAddress = addr((body as any)?.shipping_address);
    const billingAddress = addr((body as any)?.billing_address);

    const priced = await priceBasket({
      items,
      destination: {
        country: typeof (body as any)?.shipping_country === 'string' ? (body as any).shipping_country : shippingAddress?.country,
        postcode: typeof (body as any)?.shipping_postcode === 'string' ? (body as any).shipping_postcode : shippingAddress?.postcode,
      },
      ...buyerTaxId(billingAddress, shippingAddress),
      shipping_method_id: typeof (body as any)?.shipping_method_id === 'string' ? (body as any).shipping_method_id : null,
      coupon_code: typeof (body as any)?.coupon_code === 'string' ? (body as any).coupon_code : null,
      email: typeof (body as any)?.email === 'string' ? (body as any).email : null,
    });

    // The code travels with the message, as checkout's does, so a storefront
    // can translate a refusal it got from the quote the same way.
    if (!priced.ok) {
      return ApiResponseBuilder.error(priced.status, priced.message, undefined, {
        ...(priced.code ? { code: priced.code } : {}),
        ...(priced.params ? { params: priced.params } : {}),
      });
    }

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
      // Each line with the add-ons priced into it (PLUGIN_HOOKS.ORDER_LINE_ADDONS),
      // in the quote's currency, so a cart can show what the line includes.
      // Their prices are already inside `unit_price_cents`; never add them again.
      lines: t.lines.map((l, i) => {
        // The free unit a gift_product coupon added (always the last line).
        if (i === priced.giftLineIndex) return { ...l, coupon_gift: true };
        const addons = priced.addons[i] ?? [];
        if (!addons.length) return l;
        const fx = (n: number) => presentment.rate
          ? convertMinorUnits(n, presentment.settings.base, presentment.currency, presentment.rate.rate_ppm)
          : n;
        return { ...l, addons: addons.map((a) => ({ ...a, unit_price_cents: fx(a.unit_price_cents) })) };
      }),
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
          ? {
              ok: true,
              code: priced.coupon.coupon.code,
              kind: priced.coupon.coupon.kind,
              discount_cents: priced.coupon.discount_cents,
              free_shipping: priced.coupon.freeShipping,
              ...(priced.coupon.gift_product_id && priced.giftLineIndex !== null
                ? { gift_product_id: priced.coupon.gift_product_id } : {}),
            }
          : {
              ok: false,
              reason: rejected!.reason,
              // The contract's stable code (coupon.not_found, coupon.min_subtotal, …),
              // collapsed for strangers exactly as `reason` is.
              refusal: rejected!.refusal,
              message: rejected!.message,
              shortfall_cents: rejected!.shortfall_cents,
            }
        : null,
    }, 'Quote');
  } catch (err) {
    console.error('Quote error:', err);
    return ApiResponseBuilder.serverError('Failed to price the basket');
  }
};
