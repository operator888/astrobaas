/**
 * Klarna — Hosted Payment Page (HPP).
 *
 * Flow: create a Payments session, then an HPP session on top of it, and
 * redirect the buyer to Klarna's hosted page. Klarna collects everything; this
 * server sees only the outcome.
 *
 * Verification style: **fetch-back, and only fetch-back.**
 *
 * Klarna's push notification is a plain callback carrying an id — historically
 * unsigned, and the scheme varies by product and region. Rather than guess at a
 * signature format (guessing is how you ship a verification that always passes),
 * the push is treated as a pure hint: it says "look at this session", and we
 * then read the authoritative order from Klarna's API using our Basic-auth
 * credentials. Someone who can forge the push still cannot forge that answer.
 *
 * The practical consequence: the webhook body is never trusted for money. Only
 * the API response sets an amount.
 *
 * Env:
 *   KLARNA_USERNAME     API credential (Basic auth username, "PK…")
 *   KLARNA_PASSWORD     API credential
 *   KLARNA_REGION       'eu' | 'na' | 'oc'   (default 'eu')
 *   KLARNA_ENV          'live' | 'playground' (default 'playground')
 */

import type { Order } from '../../core/models';
import type { PaymentProvider, PaymentSession, ProviderContext, VerifiedEvent, PaymentOutcome, RefundResult } from './types';
import { WebhookVerificationError } from './types';

function optionalEnv(ctx: ProviderContext, name: string, fallback: string): string {
  try {
    return ctx.env(name) || fallback;
  } catch {
    return fallback;
  }
}

function apiBase(ctx: ProviderContext): string {
  const region = optionalEnv(ctx, 'KLARNA_REGION', 'eu').toLowerCase();
  const live = optionalEnv(ctx, 'KLARNA_ENV', 'playground').toLowerCase() === 'live';
  const regionPart = region === 'eu' ? '' : `-${region}`;
  const envPart = live ? '' : '.playground';
  return `https://api${regionPart}${envPart}.klarna.com`;
}

function authHeader(ctx: ProviderContext): string {
  const user = ctx.env('KLARNA_USERNAME');
  const pass = ctx.env('KLARNA_PASSWORD');
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

function outcomeForStatus(status: string): PaymentOutcome {
  switch (status.toUpperCase()) {
    case 'AUTHORIZED':
    case 'CAPTURED':
    case 'PART_CAPTURED':
      return 'paid';
    case 'CANCELLED':
    case 'EXPIRED':
      return 'failed';
    case 'REFUNDED':
      return 'refunded';
    default:
      return 'ignored';
  }
}

export const klarnaProvider: PaymentProvider = {
  id: 'klarna',
  label: 'Klarna',
  requiredEnv: ['KLARNA_USERNAME', 'KLARNA_PASSWORD'],

  async createSession(order: Order, ctx: ProviderContext): Promise<PaymentSession> {
    const base = apiBase(ctx);
    const auth = authHeader(ctx);
    const currency = order.currency.toUpperCase();

    // 1. Payments session — describes what is being bought, priced by us.
    const sessionRes = await ctx.fetch(`${base}/payments/v1/sessions`, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        purchase_country: optionalEnv(ctx, 'KLARNA_COUNTRY', 'DE'),
        purchase_currency: currency,
        locale: optionalEnv(ctx, 'KLARNA_LOCALE', 'en-DE'),
        order_amount: order.total_cents,
        merchant_reference1: order.number,
        merchant_reference2: order.id,
        order_lines: order.items.map((item) => ({
          name: item.name.slice(0, 255),
          quantity: item.qty,
          unit_price: Math.round(item.total_cents / item.qty),
          total_amount: item.total_cents,
          // The tax IS computed (commerce/tax.ts) but not itemised per line into the
          // session; Klarna requires the fields to be present, so they are sent as 0.
          total_tax_amount: 0,
          tax_rate: 0,
        })),
      }),
    });
    const session: any = await sessionRes.json().catch(() => null);
    if (!sessionRes.ok || !session?.session_id) {
      throw new Error(session?.error_messages?.join('; ') || `Klarna session creation failed (HTTP ${sessionRes.status})`);
    }

    // 2. Hosted Payment Page on top of that session.
    const hppRes = await ctx.fetch(`${base}/hpp/v1/sessions`, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        payment_session_url: `${base}/payments/v1/sessions/${session.session_id}`,
        merchant_urls: {
          success: `${ctx.siteUrl}/checkout/success?order=${encodeURIComponent(order.number)}`,
          cancel: `${ctx.siteUrl}/checkout/cancelled?order=${encodeURIComponent(order.number)}`,
          back: `${ctx.siteUrl}/checkout/cancelled?order=${encodeURIComponent(order.number)}`,
          failure: `${ctx.siteUrl}/checkout/cancelled?order=${encodeURIComponent(order.number)}`,
          error: `${ctx.siteUrl}/checkout/cancelled?order=${encodeURIComponent(order.number)}`,
        },
      }),
    });
    const hpp: any = await hppRes.json().catch(() => null);
    if (!hppRes.ok || !hpp?.redirect_url) {
      throw new Error(`Klarna hosted page creation failed (HTTP ${hppRes.status})`);
    }

    return { reference: String(session.session_id), redirectUrl: String(hpp.redirect_url) };
  },

  async refund(order, amountCents, idempotencyKey, ctx): Promise<RefundResult> {
    const reference = order.payment_reference ?? '';
    if (!reference) throw new Error('This order has no Klarna reference to refund against');

    const res = await ctx.fetch(
      `${apiBase(ctx)}/ordermanagement/v1/orders/${encodeURIComponent(reference)}/refunds`,
      {
        method: 'POST',
        headers: {
          Authorization: authHeader(ctx),
          'Content-Type': 'application/json',
          // Klarna's idempotency header, so a retry does not refund twice.
          'Klarna-Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({ refunded_amount: amountCents }),
      },
    );

    if (!res.ok) {
      const detail: any = await res.json().catch(() => null);
      throw new Error(detail?.error_messages?.join('; ') || `Klarna refund failed (HTTP ${res.status})`);
    }
    // Klarna answers 201 with a Refund-ID header and no body.
    const refundId = res.headers?.get?.('refund-id') || `klarna-refund-${idempotencyKey}`;
    return { refundId: String(refundId), amountCents };
  },

  async verifyWebhook(rawBody: string, headers: Headers, ctx: ProviderContext): Promise<VerifiedEvent> {
    let push: any;
    try {
      push = JSON.parse(rawBody);
    } catch {
      throw new WebhookVerificationError('Klarna push body is not JSON');
    }

    // The push is a hint only. Everything below comes from Klarna's API.
    const orderId = push?.order_id || push?.session_id || '';
    if (!orderId) throw new WebhookVerificationError('Klarna push carries no order id');

    const res = await ctx.fetch(`${apiBase(ctx)}/ordermanagement/v1/orders/${encodeURIComponent(String(orderId))}`, {
      headers: { Authorization: authHeader(ctx) },
    });
    if (res.status === 401 || res.status === 403) {
      throw new WebhookVerificationError('Klarna credentials rejected on fetch-back');
    }
    const order: any = await res.json().catch(() => null);
    if (!res.ok || !order) {
      // A push about an id Klarna does not know is either a forgery or noise.
      throw new WebhookVerificationError('Klarna order fetch-back failed');
    }

    const refunded = Number(order.refunded_amount ?? 0) > 0;
    const outcome: PaymentOutcome = refunded ? 'refunded' : outcomeForStatus(String(order.status ?? ''));
    const amount = refunded ? order.refunded_amount : (order.captured_amount || order.order_amount);

    return {
      // Klarna pushes carry no event id; the order id plus status is the
      // idempotency key the caller will use.
      eventId: `klarna:${orderId}:${String(order.status ?? '')}`,
      // merchant_reference2 is our own order id, set at session creation.
      reference: String(order.merchant_reference2 || orderId),
      outcome,
      amountCents: Number.isInteger(amount) ? Number(amount) : null,
      currency: order.purchase_currency ? String(order.purchase_currency).toUpperCase() : null,
      rawType: String(order.status ?? 'unknown'),
    };
  },
};
