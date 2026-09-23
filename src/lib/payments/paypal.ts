/**
 * PayPal — hosted Orders v2 checkout.
 *
 * Flow: create an order server-side with `intent=CAPTURE`, redirect the buyer to
 * the returned approval link. Payment happens on PayPal's domain.
 *
 * Under `intent=CAPTURE` the buyer's approval moves NO money: the merchant
 * has to capture the approved order. The `CHECKOUT.ORDER.APPROVED` webhook
 * reads back as `approved`, and the payment layer calls `captureApproved`
 * once it has checked that the order can still be shipped
 * (payments/service.ts). The capture's own response then decides whether the
 * order is paid. Before this, nothing captured, and a PayPal order the buyer
 * had paid for never became paid.
 *
 * Verification style: **fetch-back**. PayPal does publish a
 * `/v1/notifications/verify-webhook-signature` endpoint, and we call it — but we
 * do not stop there. After verification we re-read the order from PayPal's API
 * with our own credentials and take the status and amount from THAT response,
 * not from the webhook body. The webhook is treated as a hint that something
 * changed; the API answer is the authority. That way a forged or replayed
 * notification cannot move an order, because it never supplies the facts.
 *
 * Env:
 *   PAYPAL_CLIENT_ID
 *   PAYPAL_CLIENT_SECRET
 *   PAYPAL_WEBHOOK_ID     shown when you register the webhook
 *   PAYPAL_ENV            'live' | 'sandbox'   (default 'sandbox')
 */

import { createHash } from 'node:crypto';
import type { Order } from '../../core/models';
import type { PaymentProvider, PaymentSession, ProviderContext, VerifiedEvent, PaymentOutcome, RefundResult } from './types';
import { WebhookVerificationError } from './types';

function apiBase(ctx: ProviderContext): string {
  const env = (() => {
    try {
      return ctx.env('PAYPAL_ENV');
    } catch {
      return 'sandbox';
    }
  })();
  return env === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
}

/**
 * OAuth2 client-credentials tokens, reused until shortly before they expire.
 *
 * This used to fetch a new token for EVERY operation — including every
 * inbound webhook, before its signature was even checked. PayPal issues
 * tokens valid for hours (`expires_in`, typically 32400 s), so a burst of
 * forged notifications became a burst of OAuth calls from this server to
 * PayPal, on PayPal's rate limit for the shop's own credentials.
 *
 * Keyed by the transport, the API base and a hash of the credentials, so:
 *  - rotating PAYPAL_CLIENT_SECRET, or switching sandbox/live, is a new entry
 *    rather than a stale token;
 *  - an injected test `fetch` never sees another test's token (a WeakMap on
 *    the function; production always passes the same global `fetch`);
 *  - the secret itself is never a map key.
 * Concurrent callers share one in-flight request. A token PayPal rejects (401)
 * is dropped so the next call fetches a fresh one.
 */
interface CachedToken { token: string; expiresAt: number }
const tokenCache = new WeakMap<typeof globalThis.fetch, Map<string, CachedToken | Promise<CachedToken>>>();
/** Refresh this long before PayPal's stated expiry. */
const TOKEN_MARGIN_MS = 60_000;

function tokenKey(ctx: ProviderContext): string {
  const id = ctx.env('PAYPAL_CLIENT_ID');
  const secret = ctx.env('PAYPAL_CLIENT_SECRET');
  const digest = createHash('sha256').update(JSON.stringify([id, secret])).digest('hex');
  return `${apiBase(ctx)}|${digest}`;
}

function cacheFor(ctx: ProviderContext): Map<string, CachedToken | Promise<CachedToken>> {
  let map = tokenCache.get(ctx.fetch);
  if (!map) {
    map = new Map();
    tokenCache.set(ctx.fetch, map);
  }
  return map;
}

async function fetchToken(ctx: ProviderContext): Promise<CachedToken> {
  const id = ctx.env('PAYPAL_CLIENT_ID');
  const secret = ctx.env('PAYPAL_CLIENT_SECRET');
  const res = await ctx.fetch(`${apiBase(ctx)}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const json: any = await res.json().catch(() => null);
  if (!res.ok || !json?.access_token) {
    throw new Error(`PayPal auth failed (HTTP ${res.status})`);
  }
  // No usable lifetime: treat it as good for a minute rather than forever.
  const seconds = Number(json.expires_in);
  const lifetime = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 2 * TOKEN_MARGIN_MS;
  return { token: String(json.access_token), expiresAt: ctx.now() + lifetime - TOKEN_MARGIN_MS };
}

async function accessToken(ctx: ProviderContext): Promise<string> {
  const map = cacheFor(ctx);
  const key = tokenKey(ctx);
  const held = map.get(key);
  if (held && !(held instanceof Promise) && held.expiresAt > ctx.now()) return held.token;
  if (held instanceof Promise) return (await held).token;
  const pending = fetchToken(ctx);
  map.set(key, pending);
  try {
    const fresh = await pending;
    map.set(key, fresh);
    return fresh.token;
  } catch (err) {
    map.delete(key);
    throw err;
  }
}

/** Forget a token PayPal has just refused, so the next call asks again. */
function dropToken(ctx: ProviderContext): void {
  try {
    cacheFor(ctx).delete(tokenKey(ctx));
  } catch {
    /* credentials unreadable: nothing was cached under them */
  }
}

/** Minor units → PayPal's decimal string. EUR 1234 cents → "12.34". */
function toDecimal(cents: number): string {
  return (cents / 100).toFixed(2);
}

/**
 * A status → our outcome. Called with the CAPTURE's status when the order has
 * one, and with the ORDER's status otherwise.
 */
function outcomeForStatus(status: string, level: 'capture' | 'order'): PaymentOutcome {
  switch (status.toUpperCase()) {
    case 'COMPLETED':
      return 'paid';
    case 'VOIDED':
      return 'failed';
    // An ORDER the buyer approved, with nothing captured: under
    // `intent=CAPTURE` the money moves only when we capture it. Reported as
    // `approved` so the payment layer can capture it — it used to be
    // "ignored", nothing captured it, and a paid-for PayPal order was never
    // paid (and, with the payment hold, was then cancelled).
    case 'APPROVED':
      return level === 'order' ? 'approved' : 'ignored';
    // A capture PayPal refused: one failed attempt, counted, not an ending.
    case 'DECLINED':
    case 'FAILED':
      return level === 'capture' ? 'declined' : 'ignored';
    // PENDING (a capture under review, an eCheck), PAYER_ACTION_REQUIRED and
    // CREATED are mid-flight. None of them may release goods.
    default:
      return 'ignored';
  }
}

/**
 * Read an Orders v2 order — from a GET or from a capture response, which have
 * the same shape — into our event vocabulary. The money is the CAPTURE's when
 * there is one, the order's otherwise.
 */
function eventFromOrder(
  orderJson: any,
  base: { eventId: string; rawType: string; fallbackReference: string; paypalOrderId: string },
): VerifiedEvent {
  const unit = orderJson?.purchase_units?.[0] ?? {};
  const capture = unit.payments?.captures?.[0];
  const refunded = (unit.payments?.refunds ?? []).length > 0;
  const amountSource = capture?.amount ?? unit.amount ?? {};
  // "12.34" → 1234. Parse via the string to avoid float drift.
  const cents = amountSource?.value != null ? Math.round(Number(amountSource.value) * 100) : null;

  const outcome: PaymentOutcome = refunded
    ? 'refunded'
    : capture
      ? outcomeForStatus(String(capture.status ?? ''), 'capture')
      : outcomeForStatus(String(orderJson?.status ?? ''), 'order');

  return {
    // A capture is identified by its own id, so the capture response, the
    // read-back after ORDER_ALREADY_CAPTURED and any later delivery about the
    // same capture are one event to the idempotency ledger.
    eventId: capture?.id && outcome === 'paid' ? `paypal-capture:${capture.id}` : base.eventId,
    // custom_id is our own order id, set at creation. A capture response
    // carries it on the capture rather than on the unit.
    reference: String(unit.custom_id || capture?.custom_id || base.fallbackReference),
    outcome,
    amountCents: Number.isFinite(cents as number) ? (cents as number) : null,
    currency: amountSource?.currency_code ? String(amountSource.currency_code).toUpperCase() : null,
    rawType: base.rawType,
    providerReference: base.paypalOrderId,
  };
}

/**
 * The capture's idempotency key. PayPal returns the original response for a
 * repeated `PayPal-Request-Id`, so two deliveries of one approval — or a retry
 * after a timeout that actually succeeded — capture once. Derived from both
 * ids: ours, and PayPal's order (a new PayPal order for the same shop order is
 * a new capture). PayPal allows 108 characters.
 */
function captureRequestId(ourOrderId: string, paypalOrderId: string): string {
  return `astrobaas-capture-${ourOrderId}-${paypalOrderId}`.slice(0, 108);
}

/** A 4xx PayPal answers with this issue means the capture already happened. */
function alreadyCaptured(json: any): boolean {
  return Array.isArray(json?.details) && json.details.some((d: any) => d?.issue === 'ORDER_ALREADY_CAPTURED');
}

export const paypalProvider: PaymentProvider = {
  id: 'paypal',
  label: 'PayPal',
  requiredEnv: ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'PAYPAL_WEBHOOK_ID'],

  async createSession(order: Order, ctx: ProviderContext): Promise<PaymentSession> {
    const token = await accessToken(ctx);
    const res = await ctx.fetch(`${apiBase(ctx)}/v2/checkout/orders`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'PayPal-Request-Id': `astrobaas-order-${order.id}`, // idempotency
      },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [
          {
            // Our order id, echoed back on every webhook about this order.
            custom_id: order.id,
            invoice_id: order.number,
            amount: {
              currency_code: order.currency.toUpperCase(),
              value: toDecimal(order.total_cents),
            },
          },
        ],
        payment_source: {
          paypal: {
            experience_context: {
              user_action: 'PAY_NOW',
              return_url: `${ctx.siteUrl}/checkout/success?order=${encodeURIComponent(order.number)}`,
              cancel_url: `${ctx.siteUrl}/checkout/cancelled?order=${encodeURIComponent(order.number)}`,
            },
          },
        },
      }),
    });

    if (res.status === 401) dropToken(ctx);
    const json: any = await res.json().catch(() => null);
    if (!res.ok || !json?.id) {
      throw new Error(json?.message || `PayPal order creation failed (HTTP ${res.status})`);
    }
    const approve = (json.links || []).find((l: any) => l?.rel === 'payer-action' || l?.rel === 'approve');
    if (!approve?.href) throw new Error('PayPal returned no approval link');
    return { reference: String(json.id), redirectUrl: String(approve.href) };
  },

  async refund(order, amountCents, idempotencyKey, ctx): Promise<RefundResult> {
    const token = await accessToken(ctx);
    // A PayPal refund is against the CAPTURE, not the order, so resolve the
    // capture id from the stored order reference first.
    const orderRes = await ctx.fetch(
      `${apiBase(ctx)}/v2/checkout/orders/${encodeURIComponent(order.payment_reference ?? '')}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (orderRes.status === 401) dropToken(ctx);
    const paypalOrder: any = await orderRes.json().catch(() => null);
    const captureId = paypalOrder?.purchase_units?.[0]?.payments?.captures?.[0]?.id;
    if (!orderRes.ok || !captureId) {
      throw new Error('Could not resolve the PayPal capture for this order');
    }

    const res = await ctx.fetch(`${apiBase(ctx)}/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        // PayPal's idempotency header. A retry returns the original refund.
        'PayPal-Request-Id': idempotencyKey,
      },
      // Explicit amount always — an empty body means "refund in full".
      body: JSON.stringify({
        amount: { value: toDecimal(amountCents), currency_code: order.currency.toUpperCase() },
      }),
    });
    if (res.status === 401) dropToken(ctx);
    const json: any = await res.json().catch(() => null);
    if (!res.ok || !json?.id) {
      throw new Error(json?.message || `PayPal refund failed (HTTP ${res.status})`);
    }
    // Read back what PayPal says it refunded rather than echoing our request.
    const value = json?.amount?.value;
    const confirmed = value != null ? Math.round(Number(value) * 100) : amountCents;
    return { refundId: String(json.id), amountCents: Number.isFinite(confirmed) ? confirmed : amountCents };
  },

  async verifyWebhook(rawBody: string, headers: Headers, ctx: ProviderContext): Promise<VerifiedEvent> {
    let event: any;
    try {
      event = JSON.parse(rawBody);
    } catch {
      throw new WebhookVerificationError('PayPal webhook body is not JSON');
    }

    const certUrl = headers.get('paypal-cert-url') || '';
    // PayPal hands us a URL its own verifier fetches. Pin the host before it is
    // used for anything: an attacker-supplied cert URL is a classic SSRF and
    // signature-spoofing vector, and the check costs nothing.
    if (!/^https:\/\/[a-z0-9.-]*\.paypal\.com\//i.test(certUrl)) {
      throw new WebhookVerificationError('PayPal cert URL is not a paypal.com host');
    }

    const token = await accessToken(ctx);
    const verifyRes = await ctx.fetch(`${apiBase(ctx)}/v1/notifications/verify-webhook-signature`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        auth_algo: headers.get('paypal-auth-algo'),
        cert_url: certUrl,
        transmission_id: headers.get('paypal-transmission-id'),
        transmission_sig: headers.get('paypal-transmission-sig'),
        transmission_time: headers.get('paypal-transmission-time'),
        webhook_id: ctx.env('PAYPAL_WEBHOOK_ID'),
        webhook_event: event,
      }),
    });
    if (verifyRes.status === 401) dropToken(ctx);
    const verifyJson: any = await verifyRes.json().catch(() => null);
    if (!verifyRes.ok || verifyJson?.verification_status !== 'SUCCESS') {
      throw new WebhookVerificationError('PayPal signature verification failed');
    }

    // Verified — but still do not read money out of the notification. Ask the
    // API what the order actually is.
    const paypalOrderId =
      event?.resource?.supplementary_data?.related_ids?.order_id ??
      event?.resource?.id ??
      '';
    if (!paypalOrderId) {
      return { eventId: String(event?.id ?? ''), reference: '', outcome: 'ignored', amountCents: null, currency: null, rawType: String(event?.event_type ?? '') };
    }

    const orderRes = await ctx.fetch(`${apiBase(ctx)}/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (orderRes.status === 401) dropToken(ctx);
    const orderJson: any = await orderRes.json().catch(() => null);
    if (!orderRes.ok || !orderJson) {
      throw new WebhookVerificationError('PayPal order fetch-back failed');
    }

    return eventFromOrder(orderJson, {
      eventId: String(event?.id ?? ''),
      rawType: String(event?.event_type ?? ''),
      fallbackReference: String(paypalOrderId),
      paypalOrderId: String(paypalOrderId),
    });
  },

  /**
   * Capture an approved order: `POST /v2/checkout/orders/{id}/capture`.
   *
   * The outcome and the amount come from the CAPTURE RESPONSE, never from the
   * approval — so what is applied is what PayPal says it took, and the
   * payment layer's exact-amount check still stands between it and the order.
   *
   *  - 2xx: the captured order, read like any other.
   *  - `ORDER_ALREADY_CAPTURED`: a previous attempt (another delivery, a
   *    retry after a timeout) got there first. Read the order again and apply
   *    what it says.
   *  - any other 4xx: PayPal refused the funding source. A `declined`
   *    attempt — the buyer can go back to PayPal and choose another.
   *  - 401, 429, 5xx, no body: transient. THROWN, so the webhook is answered
   *    500 and PayPal delivers it again; the same PayPal-Request-Id makes the
   *    retry safe.
   */
  async captureApproved(approval: VerifiedEvent, ctx: ProviderContext): Promise<VerifiedEvent> {
    const paypalOrderId = approval.providerReference ?? '';
    if (!paypalOrderId) throw new Error('PayPal approval carries no PayPal order id to capture');
    const base = {
      rawType: 'PAYPAL.ORDER.CAPTURE',
      fallbackReference: approval.reference,
      paypalOrderId,
    };

    const token = await accessToken(ctx);
    const res = await ctx.fetch(`${apiBase(ctx)}/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}/capture`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'PayPal-Request-Id': captureRequestId(approval.reference, paypalOrderId),
      },
      body: '{}',
    });
    if (res.status === 401) dropToken(ctx);
    const json: any = await res.json().catch(() => null);

    if (res.ok && json) {
      return eventFromOrder(json, { ...base, eventId: `${approval.eventId}:capture` });
    }

    if (res.status >= 400 && res.status < 500 && alreadyCaptured(json)) {
      const again = await ctx.fetch(`${apiBase(ctx)}/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const orderJson: any = await again.json().catch(() => null);
      if (!again.ok || !orderJson) throw new Error(`PayPal order read-back after ORDER_ALREADY_CAPTURED failed (HTTP ${again.status})`);
      return eventFromOrder(orderJson, { ...base, rawType: 'PAYPAL.ORDER.ALREADY_CAPTURED', eventId: `${approval.eventId}:capture` });
    }

    if (res.status >= 400 && res.status < 500 && res.status !== 401 && res.status !== 429 && json) {
      const issue = Array.isArray(json?.details) && json.details[0]?.issue ? String(json.details[0].issue) : String(json?.name ?? res.status);
      return {
        eventId: `${approval.eventId}:capture-refused`,
        reference: approval.reference,
        outcome: 'declined',
        amountCents: null,
        currency: null,
        rawType: `PAYPAL.ORDER.CAPTURE.${issue}`.slice(0, 120),
        providerReference: paypalOrderId,
      };
    }

    throw new Error(`PayPal capture failed (HTTP ${res.status})`);
  },
};
