import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { validate, parsePaging } from '../../../lib/validate';
import { placeOrder } from '../../../lib/commerce-service';
import { isAcceptedMethod } from '../../../lib/payments/registry';
import { canReadCommerce, canWriteCommerce } from '../../../lib/auth';
import { captchaCheck } from '../../../lib/captcha';
import { isCheckoutEmail } from '../../../lib/commerce/checkout-email';
import { publicCouponRejection } from '../../../lib/commerce/coupons';
import {
  validIdempotencyKey, idempotencyStorageKey, bodyFingerprint, IDEMPOTENCY_LEASE_MS, IDEMPOTENCY_TTL_MS,
} from '../../../lib/commerce/idempotency';

/** GET /api/orders — staff only (orders contain PII). */
export const GET: APIRoute = async ({ url, locals }) => {
  try {
    await LocalDB.init();
    const session = locals.user;
    if (!session || !canReadCommerce(session.role)) {
      return ApiResponseBuilder.forbidden('Your role cannot list orders');
    }
    let orders = await LocalDB.getOrders();
    const status = url.searchParams.get('status');
    if (status) orders = orders.filter(o => o.status === status);
    orders.sort((a, b) => b.created_at.localeCompare(a.created_at));
    // Shared parser: `?limit=abc` used to become NaN and silently return an
    // empty page, which reads as "no orders" to whoever is debugging.
    const limit = parsePaging(url.searchParams.get('limit'), { fallback: 50, min: 1, max: 200 });
    const offset = parsePaging(url.searchParams.get('offset'), { fallback: 0, min: 0, max: 1_000_000 });
    const page = orders.slice(offset, offset + limit);
    return ApiResponseBuilder.success(page, undefined, {
      total: orders.length, count: page.length, limit, offset,
      page: Math.floor(offset / limit) + 1, hasMore: offset + page.length < orders.length,
    });
  } catch (err) {
    console.error('Orders list error:', err);
    return ApiResponseBuilder.serverError('Failed to list orders');
  }
};

/**
 * POST /api/orders — checkout. Public (anonymous buyers), rate-limited by the
 * middleware like every write. Prices/totals are computed server-side from the
 * stored products; the client only sends product ids + quantities.
 *
 * Who is asking changes four things, and nothing else:
 *
 *  |                       | anonymous | API key | staff session |
 *  | proof-of-work (opt-in) | asked     | —       | —             |
 *  | unpaid cap by email   | yes       | yes     | —             |
 *  | unpaid cap by address | yes       | —       | —             |
 *  | coupon refusal reason | generic   | generic | specific      |
 *
 * An API key is a storefront's SERVER: every shopper behind it shares its
 * address, so capping by address would cap the whole shop, and whatever it is
 * told it may repeat to a shopper, so it is told what a shopper would be.
 * Staff are placing orders for somebody on the phone.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  let idem: { key: string; token: string } | null = null;
  const release = async () => {
    if (!idem) return;
    const held = idem;
    idem = null;
    await LocalDB.releaseIdempotencyKey(held.key, held.token).catch(() => {});
  };
  try {
    await LocalDB.init();
    const body = await request.json().catch(() => null);

    const user = locals.user;
    const isKey = !!user && String(user.id).startsWith('apikey:');
    const isStaff = !!user && !isKey && canWriteCommerce(user.role);
    const seesCouponReasons = !!user && !isKey && canReadCommerce(user.role);

    // ---- Idempotency-Key: before anything that has an effect. A replay of a
    // placed order must not be refused by the unpaid cap it now counts
    // towards, or by a proof-of-work token it already spent.
    const rawKey = request.headers.get('idempotency-key');
    if (rawKey !== null) {
      if (!validIdempotencyKey(rawKey)) {
        return ApiResponseBuilder.error(400, 'Idempotency-Key must be 1–255 printable ASCII characters with no spaces', undefined, {
          code: 'IDEMPOTENCY_KEY_INVALID',
        });
      }
      const key = idempotencyStorageKey('POST /api/orders', user ? String(user.id) : 'public', rawKey);
      const fingerprint = bodyFingerprint(body);
      const claim = await LocalDB.claimIdempotencyKey(key, fingerprint, IDEMPOTENCY_LEASE_MS);
      if (claim.state !== 'claimed' && claim.fingerprint !== fingerprint) {
        return ApiResponseBuilder.error(422, 'This Idempotency-Key was already used for a different order', undefined, {
          code: 'IDEMPOTENCY_KEY_REUSED',
        });
      }
      if (claim.state === 'pending') {
        const res = ApiResponseBuilder.error(409, 'An order with this Idempotency-Key is still being placed; retry shortly', undefined, {
          code: 'IDEMPOTENCY_IN_PROGRESS',
        });
        res.headers.set('Retry-After', '1');
        return res;
      }
      if (claim.state === 'done') {
        const res = ApiResponseBuilder.created(claim.response, 'Order placed');
        res.headers.set('Idempotent-Replayed', 'true');
        return res;
      }
      idem = { key, token: claim.token };
    }

    // ---- Proof-of-work, when the operator switched it on for checkout.
    // Before validation, so a script pays the hash cost before it learns
    // anything about its payload.
    if (!user) {
      const pow = await captchaCheck((body as any)?.pow_token, 'checkout');
      if (!pow.ok) {
        await release();
        return ApiResponseBuilder.error(403, 'Anti-spam check failed — reload the page and try again', undefined, {
          code: 'checkout.captcha_failed',
        });
      }
    }

    const result = validate<{ email: string; name?: string; phone?: string; address?: string; note?: string }>(body, {
      // Anchored, one address, no header characters — see
      // commerce/checkout-email.ts. The old `/.+@.+\..+/` matched anything
      // CONTAINING an address, a line break and a Bcc: included. Duck-typed
      // as a pattern so a bad address is the same 422 it always was.
      email: { type: 'string', min: 3, max: 200, pattern: { test: (v: string) => isCheckoutEmail(String(v).trim()) } as unknown as RegExp },
      name: { type: 'string', max: 200, optional: true },
      phone: { type: 'string', max: 40, optional: true },
      address: { type: 'string', max: 500, optional: true },
      note: { type: 'string', max: 1000, optional: true },
      // Validated against the live registry below, not a fixed enum — the set
      // of methods depends on which providers are configured.
      payment_method: { type: 'string', max: 40, optional: true },
    });
    if (!result.ok) {
      await release();
      return ApiResponseBuilder.validationError('Invalid order payload', result.errors);
    }
    // A method the install cannot actually take must be refused at checkout,
    // not discovered when the buyer tries to pay.
    const method = (result.value as any).payment_method;
    if (method && !isAcceptedMethod(method, process.env as Record<string, string | undefined>)) {
      await release();
      return ApiResponseBuilder.badRequest(`Payment method "${method}" is not available`);
    }

    const rawItems = (body as any)?.items;
    if (!Array.isArray(rawItems) || rawItems.length === 0) {
      await release();
      // Refused HERE, before placeOrder, so it needs its own reason — a
      // customer-facing refusal is no less translatable for being caught early.
      return ApiResponseBuilder.error(400, 'Order needs at least one item', undefined, {
        code: 'checkout.no_items',
      });
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
        // Passed through unvalidated ON PURPOSE: validatePrescription is
        // deny-by-default and rebuilds the value field by field, so nothing the
        // client sends survives except the fields the clinical rules accept.
        prescription: i.prescription,
        qty: Number(i.qty),
      }));
    // Destination, shipping choice and coupon travel to the service, which
    // re-derives every amount from them. Note what is NOT read from the body:
    // shipping_cents, tax_cents, total_cents. A client names a shipping METHOD
    // and a coupon CODE; it never names a price.
    const b = body as any;
    const placed = await placeOrder({
      ...result.value,
      items,
      shipping_country: typeof b?.shipping_country === 'string' ? b.shipping_country : undefined,
      shipping_postcode: typeof b?.shipping_postcode === 'string' ? b.shipping_postcode : undefined,
      shipping_method_id: typeof b?.shipping_method_id === 'string' ? b.shipping_method_id : undefined,
      coupon_code: typeof b?.coupon_code === 'string' ? b.coupon_code : undefined,
      // Structured addresses go through UNVALIDATED here, on purpose and for
      // the same reason `prescription` above does: normalizeAddress is
      // deny-by-default and rebuilds the value key by key, so nothing a client
      // sends survives except the ten fields an address has. Declaring them in
      // the `validate` schema above would mean describing that shape twice, and
      // the copy that drifts is the one that decides what gets stored.
      shipping_address: b?.shipping_address,
      billing_address: b?.billing_address,
      // A CODE, never an amount. The server decides whether it is on offer and
      // applies the operator's own rate — a client naming a currency can no
      // more set a price than one naming a shipping method can.
      currency: typeof b?.currency === 'string' ? b.currency : undefined,
      // From the middleware, which already resolves proxy trust correctly.
      // Hashed before storage — the raw address is never kept.
      client_ip: locals.ip,
      buyer_limits: isStaff ? {} : { email: true, ip: !user },
    });
    // Forward the service's status: 409 tells the buyer the last unit went to
    // someone else (refresh and retry), 400 that the request itself was wrong.
    if (!placed.ok) {
      await release();
      let message = placed.message;
      let params = placed.params;
      if (placed.code === 'checkout.coupon_invalid' && !seesCouponReasons) {
        const shown = publicCouponRejection({
          ok: false,
          reason: String(placed.params?.reason ?? 'not-found') as never,
          message: placed.message,
          ...(typeof placed.params?.shortfall_cents === 'number' ? { shortfall_cents: placed.params.shortfall_cents } : {}),
        });
        message = shown.message;
        params = shown.reason === 'minimum-not-met'
          ? { reason: shown.reason, shortfall_cents: shown.shortfall_cents ?? 0 }
          : undefined;
      }
      // The CODE is what a storefront translates; the message is the fallback
      // for clients that do not know it. Sent together so neither kind of
      // client has to change on the same day.
      const res = ApiResponseBuilder.error(placed.status, message, undefined, {
        code: placed.code,
        params,
      });
      // The unpaid cap clears when an order is paid, cancelled or expires —
      // the hold is the longest a well-behaved client should wait.
      if (placed.status === 429) res.headers.set('Retry-After', '600');
      return res;
    }
    // Buyer-facing response: no internal ids beyond the order number.
    const { value } = placed;
    const publicBody = {
      number: value.number,
      subtotal_cents: value.subtotal_cents,
      discount_cents: value.discount_cents,
      shipping_cents: value.shipping_cents,
      tax_cents: value.tax_cents,
      total_cents: value.total_cents,
      currency: value.currency,
      status: value.status,
    };
    if (idem) {
      const held = idem;
      idem = null;
      // The order exists whatever happens here. A failure to store the answer
      // only means a retry after the lease runs out is not recognised.
      await LocalDB.completeIdempotencyKey(held.key, held.token, publicBody, IDEMPOTENCY_TTL_MS)
        .catch((err) => console.error('Idempotency record not saved:', err instanceof Error ? err.message : err));
    }
    return ApiResponseBuilder.created(publicBody, 'Order placed');
  } catch (err) {
    await release();
    console.error('Order create error:', err);
    return ApiResponseBuilder.serverError('Failed to place order');
  }
};
