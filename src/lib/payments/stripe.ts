/**
 * Stripe — hosted Checkout Session.
 *
 * Flow: we create a Checkout Session server-side and redirect the buyer to
 * Stripe's own page. Card details are entered on Stripe's domain and never
 * reach this server, which is what keeps the install out of PCI scope.
 *
 * Verification style: signed payload (see signatures.ts). Stripe HMACs the raw
 * request body, so the webhook route must pass `request.text()` verbatim.
 *
 * Env:
 *   STRIPE_SECRET_KEY       sk_live_… / sk_test_…
 *   STRIPE_WEBHOOK_SECRET   whsec_…  (Stripe shows this when you add the endpoint)
 */

import type { Order } from '../../core/models';
import type { PaymentProvider, PaymentSession, ProviderContext, VerifiedEvent, PaymentOutcome, RefundResult } from './types';
import { WebhookVerificationError } from './types';
import { verifyStripeSignature } from './signatures';
import { stripeSessionExpiry } from '../commerce/payment-hold';

const API = 'https://api.stripe.com/v1';

/** Stripe's API is form-encoded with bracketed paths, not JSON. */
function form(params: Record<string, string | number>): string {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) body.set(k, String(v));
  return body.toString();
}

/**
 * Map a Stripe event to our outcome vocabulary.
 *
 * Anything not listed is deliberately 'ignored' rather than guessed at: Stripe
 * emits dozens of event types, and treating an unrecognised one as a state
 * change is how orders get marked paid by a dispute notification.
 */
function outcomeFor(type: string, obj: any): PaymentOutcome {
  switch (type) {
    case 'checkout.session.completed':
      // An async method (bank debit) completes the session while still pending.
      return obj?.payment_status === 'paid' ? 'paid' : 'ignored';
    case 'checkout.session.async_payment_succeeded':
    case 'payment_intent.succeeded':
      return 'paid';
    // The SESSION ended unpaid: the order is over.
    case 'checkout.session.async_payment_failed':
    case 'checkout.session.expired':
      return 'failed';
    // ONE card was refused. Checkout keeps the page open and the buyer can
    // try another, so this is an attempt, not an ending — mapping it to
    // 'failed' cancelled the order and released its stock on the first
    // decline, and a card-testing run churned the shop's inventory. The
    // session's own expiry (set to the payment hold below) still ends it.
    case 'payment_intent.payment_failed':
      return 'declined';
    case 'charge.refunded':
      return 'refunded';
    default:
      return 'ignored';
  }
}

export const stripeProvider: PaymentProvider = {
  id: 'stripe',
  label: 'Card (Stripe)',
  requiredEnv: ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'],

  async createSession(order: Order, ctx: ProviderContext): Promise<PaymentSession> {
    const key = ctx.env('STRIPE_SECRET_KEY');
    const currency = order.currency.toLowerCase();

    const params: Record<string, string | number> = {
      mode: 'payment',
      success_url: `${ctx.siteUrl}/checkout/success?order=${encodeURIComponent(order.number)}`,
      cancel_url: `${ctx.siteUrl}/checkout/cancelled?order=${encodeURIComponent(order.number)}`,
      customer_email: order.email,
      // Our id travels in three places so every event shape carries it back:
      // the session, and — via payment_intent_data — the PaymentIntent and the
      // Charge, which is what a refund event is about.
      client_reference_id: order.id,
      'metadata[order_id]': order.id,
      'payment_intent_data[metadata][order_id]': order.id,
    };
    // Close the page when the shop stops holding the stock. Without this the
    // session lives Stripe's default 24 h, and a buyer could pay for an order
    // the hold sweep cancelled hours earlier.
    //
    // STABLE across retries. The create call carries a fixed Idempotency-Key
    // per order, and Stripe refuses a replayed key whose parameters differ —
    // so once a session exists, its accepted expiry (stored on the order by
    // startPayment) is sent again rather than recomputed from a clock that
    // has moved. A hold with over 31 minutes left computes the same value
    // every time anyway; only the clamped, late case would drift.
    const known = Date.parse(order.payment_expires_at ?? '');
    if (Number.isFinite(known)) {
      params.expires_at = Math.floor(known / 1000);
    } else if (typeof ctx.holdUntil === 'number' && Number.isFinite(ctx.holdUntil)) {
      params.expires_at = stripeSessionExpiry(ctx.holdUntil, ctx.now());
    }

    // One line per order item, priced from OUR stored totals.
    order.items.forEach((item, i) => {
      params[`line_items[${i}][quantity]`] = item.qty;
      params[`line_items[${i}][price_data][currency]`] = currency;
      params[`line_items[${i}][price_data][product_data][name]`] = item.name.slice(0, 250);
      // total_cents is the line total; Stripe wants the unit price.
      params[`line_items[${i}][price_data][unit_amount]`] = Math.round(item.total_cents / item.qty);
    });

    const res = await ctx.fetch(`${API}/checkout/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        // Retrying a create must not open a second session for one order.
        'Idempotency-Key': `astrobaas-order-${order.id}`,
      },
      body: form(params),
    });

    const json: any = await res.json().catch(() => null);
    if (!res.ok || !json?.id || !json?.url) {
      throw new Error(json?.error?.message || `Stripe session creation failed (HTTP ${res.status})`);
    }
    // Stripe echoes the expiry it accepted (epoch seconds).
    const expires = Number(json.expires_at);
    return {
      reference: String(json.id),
      redirectUrl: String(json.url),
      ...(Number.isInteger(expires) && expires > 0 ? { expiresAt: new Date(expires * 1000).toISOString() } : {}),
    };
  },

  async refund(order, amountCents, idempotencyKey, ctx): Promise<RefundResult> {
    const key = ctx.env('STRIPE_SECRET_KEY');
    // The stored reference is a Checkout Session; a refund is against the
    // PaymentIntent behind it, so resolve that first rather than guessing.
    const sessionRes = await ctx.fetch(
      `${API}/checkout/sessions/${encodeURIComponent(order.payment_reference ?? '')}`,
      { headers: { Authorization: `Bearer ${key}` } },
    );
    const session: any = await sessionRes.json().catch(() => null);
    const intent = session?.payment_intent;
    if (!sessionRes.ok || !intent) {
      throw new Error('Could not resolve the Stripe payment for this order');
    }

    const res = await ctx.fetch(`${API}/refunds`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        // Stripe honours this for 24h: a retried or double-clicked refund
        // returns the ORIGINAL refund instead of sending the money twice.
        'Idempotency-Key': idempotencyKey,
      },
      // Always an explicit amount. Omitting it means "refund everything", which
      // would turn a partial refund into a full one.
      body: form({ payment_intent: String(intent), amount: amountCents }),
    });
    const json: any = await res.json().catch(() => null);
    if (!res.ok || !json?.id) {
      throw new Error(json?.error?.message || `Stripe refund failed (HTTP ${res.status})`);
    }
    return { refundId: String(json.id), amountCents: Number(json.amount ?? amountCents) };
  },

  async verifyWebhook(rawBody: string, headers: Headers, ctx: ProviderContext): Promise<VerifiedEvent> {
    const secret = ctx.env('STRIPE_WEBHOOK_SECRET');
    const ok = verifyStripeSignature({
      rawBody,
      header: headers.get('stripe-signature'),
      secret,
      nowMs: ctx.now(),
    });
    // One generic message: distinguishing "no header" from "bad MAC" from
    // "stale timestamp" only helps someone probing the endpoint.
    if (!ok) throw new WebhookVerificationError('Stripe signature verification failed');

    let event: any;
    try {
      event = JSON.parse(rawBody);
    } catch {
      throw new WebhookVerificationError('Stripe webhook body is not JSON');
    }

    const obj = event?.data?.object ?? {};
    const type = String(event?.type ?? '');
    // Prefer our own id (present on every shape because of payment_intent_data)
    // and fall back to the session id.
    const reference =
      obj?.metadata?.order_id || obj?.client_reference_id || obj?.id || '';

    const outcome = outcomeFor(type, obj);
    // A refund event is a Charge: `amount_refunded`, not `amount_total`.
    const amount =
      outcome === 'refunded'
        ? obj?.amount_refunded
        : obj?.amount_total ?? obj?.amount_received ?? obj?.amount;

    return {
      eventId: String(event?.id ?? ''),
      reference: String(reference),
      outcome,
      amountCents: Number.isInteger(amount) ? Number(amount) : null,
      currency: obj?.currency ? String(obj.currency).toUpperCase() : null,
      rawType: type,
    };
  },
};
