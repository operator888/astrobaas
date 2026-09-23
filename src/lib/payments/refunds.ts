/**
 * Refund bounds — the arithmetic that decides how much money may leave.
 *
 * Pure, because every rule here is one that costs real money to get wrong:
 *
 *   - refunding more than was charged
 *   - refunding repeatedly until the total exceeds the order (each individually
 *     "valid", only wrong in aggregate)
 *   - refunding an order that was never paid, which also returns stock for free
 *   - a float or a rounding step turning 19.99 into 19.990000000000002
 *
 * Reasoning about that against a live provider account is not an option, so the
 * decision is separated from the API call and attacked in unit tests instead.
 */

import type { PaymentStatus, RefundRecord } from '../../core/models';

export type { RefundRecord };

export interface RefundableOrder {
  total_cents: number;
  currency: string;
  payment_status?: PaymentStatus;
  payment_provider?: string;
  refunds?: RefundRecord[];
}

export type RefundRejection =
  | 'not-paid'
  | 'no-provider'
  | 'invalid-amount'
  | 'exceeds-remaining'
  | 'nothing-remaining';

export type RefundPlan =
  | { ok: true; amountCents: number; remainingAfter: number; isFullRefund: boolean }
  | { ok: false; reason: RefundRejection; message: string; remaining: number };

/** Sum of refunds already executed. Ignores malformed rows rather than NaN-ing. */
export function refundedTotal(order: RefundableOrder): number {
  return (order.refunds ?? []).reduce((sum, r) => {
    const n = Number(r?.amount_cents);
    return Number.isInteger(n) && n > 0 ? sum + n : sum;
  }, 0);
}

/** How much of this order can still be sent back. Never negative. */
export function refundableRemaining(order: RefundableOrder): number {
  return Math.max(0, order.total_cents - refundedTotal(order));
}

/**
 * Decide whether a refund of `requestedCents` is allowed.
 *
 * Pass `null` to mean "everything still outstanding" — resolved HERE, from our
 * own records, rather than by asking the provider to refund "the rest". The
 * provider's idea of the remaining balance is not authoritative for us, and a
 * "full refund" flag that means different things on each side is how a partial
 * refund quietly becomes a full one.
 */
export function planRefund(
  order: RefundableOrder,
  requestedCents: number | null,
): RefundPlan {
  const remaining = refundableRemaining(order);

  // Only money that arrived can go back. Refunding an unpaid order would also
  // release its stock through the cancellation path — free goods.
  if ((order.payment_status ?? 'unpaid') !== 'paid') {
    return {
      ok: false,
      reason: 'not-paid',
      message: `Only a paid order can be refunded (this one is "${order.payment_status ?? 'unpaid'}")`,
      remaining,
    };
  }
  if (!order.payment_provider) {
    return {
      ok: false,
      reason: 'no-provider',
      message: 'This order was not paid through a payment provider, so there is nothing to refund automatically',
      remaining,
    };
  }
  if (remaining <= 0) {
    return { ok: false, reason: 'nothing-remaining', message: 'This order is already fully refunded', remaining };
  }

  const amount = requestedCents === null ? remaining : requestedCents;

  // Money is integer minor units, always. A float here is a bug upstream, not
  // something to round into shape.
  if (!Number.isInteger(amount) || amount <= 0) {
    return {
      ok: false,
      reason: 'invalid-amount',
      message: 'Refund amount must be a positive whole number of cents',
      remaining,
    };
  }
  if (amount > remaining) {
    return {
      ok: false,
      reason: 'exceeds-remaining',
      message: `Refund of ${amount} exceeds the ${remaining} still refundable on this order`,
      remaining,
    };
  }

  const remainingAfter = remaining - amount;
  return { ok: true, amountCents: amount, remainingAfter, isFullRefund: remainingAfter === 0 };
}

/**
 * Payment status after a refund lands.
 *
 * A partial refund leaves the order `paid` — money is still held for the
 * unrefunded part, and flipping to `refunded` would misreport that and, via the
 * order-status path, hand back stock for goods that were only partly returned.
 */
export function paymentStatusAfterRefund(remainingAfter: number): PaymentStatus {
  return remainingAfter === 0 ? 'refunded' : 'paid';
}

/**
 * Idempotency key for a refund attempt.
 *
 * Derived from the order and how much has already been returned, so a retry of
 * *the same* refund reuses the key while a genuinely new refund gets a fresh
 * one. Keying on the order alone would make a legitimate second partial refund
 * a silent no-op; keying on a timestamp would defeat the purpose entirely.
 */
export function refundIdempotencyKey(orderId: string, alreadyRefundedCents: number, amountCents: number): string {
  return `astrobaas-refund-${orderId}-${alreadyRefundedCents}-${amountCents}`;
}
