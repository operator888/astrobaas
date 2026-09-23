/**
 * What a verified payment event should DO to an order.
 *
 * Split out as a pure function because this is where money meets state, and
 * every rule here is one an attacker would like to bend:
 *
 *   - replay the same success event to trigger fulfilment twice
 *   - send a real, correctly-signed event about a 1-cent order to release a
 *     500-euro one
 *   - refund an order that was never paid, to release stock for free
 *   - race two deliveries of the same event
 *
 * Keeping the decision separate from the persistence means all of that is
 * testable without a database, a network, or a provider account.
 */

import type { Order } from '../../core/models';
import type { PaymentStatus, VerifiedEvent } from './types';
import { amountMatches } from './signatures';

export type PaymentAction = 'capture' | 'fail' | 'decline' | 'approve' | 'refund' | 'ignore' | 'reject';

export interface PaymentDecision {
  action: PaymentAction;
  /** Payment status to write. Absent when the action changes nothing. */
  paymentStatus?: PaymentStatus;
  /**
   * Order status to move to, when the payment outcome implies one. Absent means
   * leave fulfilment alone.
   */
  orderStatus?: 'processing' | 'cancelled' | 'refunded';
  /** Human-readable why, recorded in the audit log. */
  reason: string;
  /**
   * True when this decision should be logged as a security event: the event
   * verified as genuinely from the provider, but did not describe the order we
   * were asked to apply it to. That is either a serious misconfiguration or an
   * attack, and it must never be silent.
   */
  suspicious?: boolean;
}

/** How many processed event ids to remember per order. */
export const PAYMENT_EVENT_HISTORY = 50;

/**
 * Declined attempts on ONE order at which it is flagged as card testing.
 *
 * A buyer whose card is refused tries another, maybe two. Five refusals on
 * one basket is somebody running a list of stolen numbers against the shop's
 * payment page — which costs the shop fees and its standing with the
 * acquirer, so staff should see it without reading the provider dashboard.
 */
export const CARD_TESTING_DECLINES = 5;

export interface OrderPaymentState {
  total_cents: number;
  currency: string;
  payment_status?: PaymentStatus;
  /** Ids of events already applied — the idempotency ledger. */
  payment_events?: string[];
}

/**
 * Decide what a verified event does to an order.
 *
 * Deliberately conservative: anything not clearly understood ends as 'ignore',
 * never as a state change. The cost of ignoring a real event is a support
 * ticket; the cost of acting on a misread one is shipped goods or lost money.
 */
export function decidePaymentEvent(
  order: OrderPaymentState,
  event: VerifiedEvent,
): PaymentDecision {
  const current: PaymentStatus = order.payment_status ?? 'unpaid';

  // 1. Idempotency first. Providers retry on any non-2xx, and a slow response
  //    is a normal reason to receive the same event several times.
  if (event.eventId && (order.payment_events ?? []).includes(event.eventId)) {
    return { action: 'ignore', reason: `Event ${event.eventId} already applied` };
  }

  if (event.outcome === 'ignored') {
    return { action: 'ignore', reason: `No action for provider event "${event.rawType}"` };
  }

  if (event.outcome === 'paid') {
    if (current === 'paid') {
      return { action: 'ignore', reason: 'Order is already paid' };
    }
    if (current === 'refunded') {
      // A success arriving after a refund is out-of-order delivery, not a new
      // payment. Refusing it keeps a refunded order refunded.
      return { action: 'ignore', reason: 'Order was already refunded; ignoring a late success' };
    }
    // 2. The amount gate. A valid signature proves provenance, not relevance.
    if (!amountMatches(order.total_cents, order.currency, event.amountCents, event.currency)) {
      return {
        action: 'reject',
        reason:
          `Amount mismatch: order is ${order.total_cents} ${order.currency}, ` +
          `event reports ${event.amountCents} ${event.currency}`,
        suspicious: true,
      };
    }
    return {
      action: 'capture',
      paymentStatus: 'paid',
      // Paid means it can be worked on. Fulfilment stays a human decision from
      // there; we never jump an order to 'completed'.
      orderStatus: 'processing',
      reason: 'Payment confirmed by provider',
    };
  }

  if (event.outcome === 'failed') {
    if (current === 'paid') {
      // A failure after a success is almost always late/duplicate delivery.
      // Cancelling here would release stock on a paid order.
      return { action: 'ignore', reason: 'Order is already paid; ignoring a late failure' };
    }
    if (current === 'failed') {
      return { action: 'ignore', reason: 'Payment already marked failed' };
    }
    return {
      action: 'fail',
      paymentStatus: 'failed',
      // Cancelling returns the reserved stock through the existing lifecycle.
      orderStatus: 'cancelled',
      reason: `Payment failed or expired (${event.rawType})`,
    };
  }

  if (event.outcome === 'approved') {
    // The buyer approved; no money has moved. Capturing is the caller's job
    // (payments/service.ts), and only for an order that can still ship.
    if (current === 'paid' || current === 'refunded') {
      return { action: 'ignore', reason: `Order is already ${current}; not capturing another approval` };
    }
    // The amount gate BEFORE any money is taken. The capture response is
    // checked again afterwards, but a capture for the wrong amount that is
    // then rejected has still taken the buyer's money.
    if (!amountMatches(order.total_cents, order.currency, event.amountCents, event.currency)) {
      return {
        action: 'reject',
        reason:
          `Approval amount mismatch: order is ${order.total_cents} ${order.currency}, `
          + `approval is for ${event.amountCents} ${event.currency}; not captured`,
        suspicious: true,
      };
    }
    return { action: 'approve', reason: `Payment approved by the buyer; to be captured (${event.rawType})` };
  }

  if (event.outcome === 'declined') {
    // One refused card, on a payment page that is still open: the buyer can
    // try again, so the order and its stock stay exactly as they are. The
    // attempt is COUNTED (applyVerifiedEvent) so card testing is visible.
    // Cancelling here — what `failed` does — let a card-testing run hand
    // back, and then re-reserve, the stock of every order it touched.
    if (current === 'paid' || current === 'refunded') {
      return { action: 'ignore', reason: `Order is already ${current}; ignoring a late decline` };
    }
    return {
      action: 'decline',
      reason: `Payment attempt declined; the buyer may retry (${event.rawType})`,
    };
  }

  if (event.outcome === 'refunded') {
    if (current !== 'paid') {
      // Refunding something never paid would release stock without money ever
      // having moved.
      return {
        action: 'reject',
        reason: `Refund for an order that is "${current}", not paid`,
        suspicious: true,
      };
    }
    return {
      action: 'refund',
      paymentStatus: 'refunded',
      orderStatus: 'refunded',
      reason: 'Refund confirmed by provider',
    };
  }

  return { action: 'ignore', reason: 'Unrecognised outcome' };
}

/** Append an event id to the ledger, keeping it bounded. */
export function recordEvent(existing: string[] | undefined, eventId: string): string[] {
  if (!eventId) return existing ?? [];
  const next = [...(existing ?? []), eventId];
  return next.length > PAYMENT_EVENT_HISTORY ? next.slice(-PAYMENT_EVENT_HISTORY) : next;
}

/** Does this order still need money before it should be worked on? */
export function awaitingPayment(order: Pick<Order, 'payment_method'> & OrderPaymentState): boolean {
  const status = order.payment_status ?? 'unpaid';
  return status === 'pending';
}
