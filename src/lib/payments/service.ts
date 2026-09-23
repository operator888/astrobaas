/**
 * Payment orchestration: the storage-touching half of the payments layer.
 *
 * The decisions live in capture.ts (pure) and the protocol details live in the
 * provider modules; this file is the seam that connects them to orders, stock,
 * and the audit log. Kept thin on purpose — logic that ends up here is logic
 * that cannot be unit-tested without a database.
 */

import { LocalDB } from '../localdb';
import { setOrderStatus, releasesStock } from '../commerce-service';
import { recordAudit, AUDIT } from '../audit';
import type { Order } from '../../core/models';
import type { PaymentProvider, ProviderContext, VerifiedEvent } from './types';
import { providerContext, getProvider, onlineMethodIds } from './registry';
import {
  decidePaymentEvent, PAYMENT_EVENT_HISTORY, CARD_TESTING_DECLINES, type PaymentDecision,
} from './capture';
import {
  planRefund, refundedTotal, refundableRemaining, refundIdempotencyKey,
} from './refunds';
import type { RefundRecord } from '../../core/models';
import {
  resolvePaymentHoldSettings, holdStartMs, holdDeadlineMs,
} from '../commerce/payment-hold';
import { notifyNeedsRefund } from './late-payment';

export interface StartPaymentResult {
  ok: boolean;
  status: number;
  message?: string;
  /** Stable machine-readable reason for a refusal, e.g. `payment.window_closed`. */
  code?: string;
  redirectUrl?: string;
}

async function readSettingsMap(): Promise<Record<string, unknown>> {
  try {
    const rows = await LocalDB.getSettings();
    const map: Record<string, unknown> = {};
    for (const r of rows) map[r.key] = r.value;
    return map;
  } catch {
    return {};
  }
}

/**
 * Open a checkout session for an existing order and remember the reference.
 *
 * The order is read from storage rather than taken from the caller: the amount
 * charged must come from what WE computed, never from the request that asked
 * for a payment link.
 *
 * ## The payment hold (commerce/payment-hold.ts)
 *
 * The provider is told when the shop stops holding this order's stock
 * (`ctx.holdUntil`), so a provider that can close its page then does. And once
 * the hold is over no new session is opened at all: the hold sweep is about to
 * cancel the order, and a page opened now would take money for it.
 */
export async function startPayment(
  orderId: string,
  provider: PaymentProvider,
  siteUrl: string,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
  fetchImpl?: typeof globalThis.fetch,
): Promise<StartPaymentResult> {
  const order = await LocalDB.getOrder(orderId);
  if (!order) return { ok: false, status: 404, message: 'Order not found' };

  const paymentStatus = order.payment_status ?? 'unpaid';
  if (paymentStatus === 'paid') {
    return { ok: false, status: 409, message: 'Order is already paid' };
  }
  if (order.status === 'cancelled' || order.status === 'refunded') {
    return { ok: false, status: 409, message: `Cannot pay a ${order.status} order` };
  }
  if (order.total_cents <= 0) {
    return { ok: false, status: 400, message: 'Order total must be positive to take payment' };
  }

  const now = Date.now();
  // The first start, fixed once: the hold clock of an order placed with a
  // manual method starts here (holdStartMs).
  const startedAt = order.payment_started_at ?? new Date(now).toISOString();
  const asStarted = { ...order, payment_started_at: startedAt, payment_provider: provider.id };
  const hold = resolvePaymentHoldSettings(await readSettingsMap());
  const ids = onlineMethodIds();
  let holdUntil: number | undefined;
  if (hold.holdMinutes > 0) {
    const deadline = holdDeadlineMs(asStarted, hold.holdMinutes, ids);
    if (deadline !== null && now >= deadline) {
      return {
        ok: false, status: 409, code: 'payment.window_closed',
        message: 'The time to pay for this order has run out. Please place the order again.',
      };
    }
    const start = holdStartMs(asStarted, ids);
    if (start !== null) holdUntil = start + hold.holdMinutes * 60_000;
  }

  const ctx = providerContext({ env, siteUrl, fetch: fetchImpl, holdUntil });
  let session;
  try {
    session = await provider.createSession(order, ctx);
  } catch (err) {
    console.error(`[payments] ${provider.id} session creation failed:`, err);
    // Never surface the provider's raw error to an anonymous buyer — it can
    // carry account or credential detail.
    return { ok: false, status: 502, message: 'Could not start payment with the provider' };
  }

  const expires = Date.parse(session.expiresAt ?? '');
  await LocalDB.updateOrder(order.id, {
    payment_provider: provider.id,
    payment_reference: session.reference,
    payment_status: 'pending',
    ...(order.payment_started_at ? {} : { payment_started_at: startedAt }),
    ...(Number.isFinite(expires) ? { payment_expires_at: new Date(expires).toISOString() } : {}),
  });

  return { ok: true, status: 200, redirectUrl: session.redirectUrl };
}

/** Resolve the order a verified event refers to, by our id or by reference. */
async function findOrderForEvent(event: VerifiedEvent): Promise<Order | undefined> {
  if (!event.reference) return undefined;
  // Providers echo our own order id back (Stripe metadata, PayPal custom_id,
  // Klarna merchant_reference2), so try that first.
  const direct = await LocalDB.getOrder(event.reference);
  if (direct) return direct;
  const orders = await LocalDB.getOrders();
  return orders.find((o) => o.payment_reference === event.reference);
}

export interface ApplyResult {
  applied: boolean;
  decision: PaymentDecision;
  orderNumber?: string;
}

/**
 * How many times an event that found its order changed under it re-reads and
 * decides again. Each retry means another event or staff moved the payment
 * status in between; running out is reported as an error so the provider
 * retries the delivery, rather than dropping the event.
 */
const EVENT_ATTEMPTS = 5;

export interface ApplyOptions {
  /**
   * The provider that verified the event, and its context. Needed only to act
   * on an `approved` event (capture it); without them an approval is ignored.
   */
  provider?: PaymentProvider;
  ctx?: ProviderContext;
  /** Internal: this event is a capture's own result — never capture again. */
  fromCapture?: boolean;
}

/** The refusal `when` gives for a risk-held order a payment must not move on. */
const HELD_FOR_REVIEW = 'The order is held for review; the payment is recorded and the order stays on hold';

/**
 * Apply a VERIFIED event to its order.
 *
 * Callers must have verified the event first — this function trusts its input,
 * which is precisely why the webhook route has no path that reaches it without
 * `provider.verifyWebhook` succeeding.
 *
 * ## The event is CLAIMED, not just recorded
 *
 * This used to check the event id against the ledger it read, then write the
 * payment status and the ledger. Two deliveries of one event (providers retry,
 * and a slow answer is reason enough) both passed the check and both recorded
 * "captured"; worse, a failure decided on a stale read wrote `failed` over a
 * `paid` that had landed in between, and the cancel that followed released the
 * stock of a paid order. tests/checkout-race.test.mjs (W1, W2) reproduces both.
 *
 * Now `LocalDB.claimPaymentEvent` appends the id and writes the payment status
 * in one step, only if the id is new AND the payment status is still the one
 * the decision was taken on. A duplicate is answered as already applied; a
 * changed status means decide again from the order as it now is.
 *
 * ## An approval is captured here
 *
 * An `approved` event (PayPal) moves no money by itself; captureApproval
 * decides whether to take it, with `opts.provider` and `opts.ctx`.
 */
export async function applyVerifiedEvent(event: VerifiedEvent, opts: ApplyOptions = {}): Promise<ApplyResult> {
  for (let attempt = 0; attempt < EVENT_ATTEMPTS; attempt++) {
    const order = await findOrderForEvent(event);
    if (!order) {
      // Not an error worth 500ing over — a provider may notify about sessions
      // from another install sharing the account. Recorded, not acted on.
      return {
        applied: false,
        decision: { action: 'ignore', reason: `No order matches reference ${event.reference}` },
      };
    }

    const decision = decidePaymentEvent(order, event);

    if (decision.action === 'ignore') {
      return { applied: false, decision, orderNumber: order.number };
    }

    if (decision.action === 'reject') {
      // Verified as genuinely from the provider, but wrong about this order.
      // Loud on purpose: this is either a serious misconfiguration or an attack.
      console.warn(`[payments] REJECTED event for order ${order.number}: ${decision.reason}`);
      recordAudit(AUDIT.PAYMENT_REJECTED, {
        actor: 'provider',
        target: order.id,
        metadata: {
          order: order.number,
          reason: decision.reason,
          provider_event: event.rawType,
          event_id: event.eventId,
        },
      });
      return { applied: false, decision, orderNumber: order.number };
    }

    if (decision.action === 'approve') {
      return captureApproval(order, event, decision, opts);
    }

    // Claim the event BEFORE acting. If the status move below fails midway, a
    // retry of a DIFFERENT delivery re-runs it; a duplicate of this one is
    // refused here rather than running the whole thing twice.
    const patch: Partial<Order> = {};
    if (decision.paymentStatus) patch.payment_status = decision.paymentStatus;
    if (decision.action === 'decline') patch.payment_declined_at = new Date().toISOString();
    const claim = await LocalDB.claimPaymentEvent(order.id, event.eventId, patch, {
      expectPaymentStatus: order.payment_status ?? null,
      countDecline: decision.action === 'decline',
      history: PAYMENT_EVENT_HISTORY,
    });
    if (claim.outcome === 'missing') {
      return {
        applied: false,
        decision: { action: 'ignore', reason: `No order matches reference ${event.reference}` },
      };
    }
    if (claim.outcome === 'duplicate') {
      return {
        applied: false,
        decision: { action: 'ignore', reason: `Event ${event.eventId} already applied` },
        orderNumber: order.number,
      };
    }
    if (claim.outcome === 'changed') continue; // decide again from the order as it now is

    if (decision.action === 'decline') {
      await afterDecline(claim.order, event);
      return { applied: true, decision, orderNumber: order.number };
    }

    if (decision.orderStatus) {
      // Route through setOrderStatus so stock release/re-take stays in ONE place
      // — cancelling here must return inventory exactly as an admin cancel does.
      //
      // The move is only right while the payment is still what this event
      // just made it: a different event for the same order can land between
      // the claim and this move. Asked on the fresh read, with the payment
      // status pinned in the write (see SetOrderStatusOptions.when).
      const target = decision.orderStatus;
      const res = await setOrderStatus(order.id, target, undefined, {
        when: (fresh) => {
          if ((fresh.payment_status ?? 'unpaid') !== decision.paymentStatus) {
            return `The payment status changed to "${fresh.payment_status ?? 'unpaid'}" while this event was being applied`;
          }
          // The opt-in risk hold: a person looks before anything ships, paid
          // or not. The payment is recorded; the order stays on hold.
          if (target === 'processing' && fresh.status === 'on-hold' && fresh.risk_held === true) {
            return HELD_FOR_REVIEW;
          }
          return null;
        },
      });
      if (!res.ok && res.message !== HELD_FOR_REVIEW) {
        console.error(`[payments] order ${order.number} status change failed: ${res.message}`);
        if (decision.action === 'capture') await flagIfPaidWithoutStock(order.id, event);
      }
    }

    const auditAction =
      decision.action === 'capture'
        ? AUDIT.PAYMENT_CAPTURED
        : decision.action === 'refund'
          ? AUDIT.PAYMENT_REFUNDED
          : AUDIT.PAYMENT_FAILED;
    recordAudit(auditAction, {
      actor: 'provider',
      target: order.id,
      metadata: {
        order: order.number,
        reason: decision.reason,
        provider_event: event.rawType,
        event_id: event.eventId,
        amount_cents: event.amountCents,
      },
    });

    return { applied: true, decision, orderNumber: order.number };
  }
  // Thrown, not returned: the webhook route answers 500 and the provider
  // delivers again later, instead of this event being acknowledged and lost.
  throw new Error(`Order for ${event.reference} kept changing while event ${event.eventId} was applied`);
}

/**
 * Cancellations a buyer's approval may undo: the ones the shop's own sweeps
 * made because nobody had paid yet. A cancel by STAFF is a decision about the
 * order (the customer asked, it looked fraudulent) and is never reversed by a
 * payment arriving.
 */
const AUTOMATIC_CANCEL_REASONS: ReadonlyArray<Order['cancelled_reason']> = ['hold-expired', 'abandoned'];

const CAPTURE_ACTOR = 'system:payment-capture';

/**
 * The buyer approved a payment that we must CAPTURE (PayPal, `intent=CAPTURE`).
 *
 * ## Stock first, money second
 *
 * S4.3 handles money that arrives for an order already cancelled: reopen it
 * if the stock is still there, otherwise keep it cancelled and flag a refund.
 * With a capture the shop has a better option than a refund — not taking the
 * money at all — so the order of operations is reversed:
 *
 *  1. If the order is cancelled, it must have been cancelled by a sweep (not
 *     staff), and its stock must be taken back NOW. If either fails, nothing
 *     is captured: the approval is left to lapse, and the reason is audited
 *     (`payment.approval_not_captured`). No money for goods we cannot ship.
 *  2. A capture lease is written (`payment_capture_started_at`), so the hold
 *     sweep leaves the order alone while the money moves.
 *  3. The provider captures. What it RETURNS is applied as an ordinary event
 *     — the exact-amount check included — so the order is paid only on what
 *     the provider says it took.
 *  4. If the capture did not produce `paid`, an order reopened in step 1 is
 *     cancelled again and its stock returned. A transient failure is re-thrown
 *     afterwards, so the webhook is answered 500 and redelivered.
 *
 * A duplicate delivery finds the order already paid (decidePaymentEvent
 * ignores it) or, if the two overlap, sends the same PayPal-Request-Id, and
 * the capture's own id makes the two results one event to the ledger.
 */
async function captureApproval(
  order: Order,
  event: VerifiedEvent,
  decision: PaymentDecision,
  opts: ApplyOptions,
): Promise<ApplyResult> {
  const provider = opts.provider;
  if (opts.fromCapture || !provider || typeof provider.captureApproved !== 'function' || !opts.ctx) {
    return {
      applied: false,
      decision: { action: 'ignore', reason: 'Payment approved, but nothing here can capture it' },
      orderNumber: order.number,
    };
  }

  // 1. Can this order still ship? Reserve before capturing.
  let reopened = false;
  if (releasesStock(order.status)) {
    if (order.status !== 'cancelled') {
      return approvalNotCaptured(order, event, `the order is ${order.status}`);
    }
    if (!AUTOMATIC_CANCEL_REASONS.includes(order.cancelled_reason)) {
      return approvalNotCaptured(order, event, 'the order was cancelled by staff');
    }
    await LocalDB.updateOrder(order.id, { payment_capture_started_at: new Date().toISOString() });
    const unpaid = order.payment_status ?? 'unpaid';
    const res = await setOrderStatus(order.id, 'pending', CAPTURE_ACTOR, {
      when: (fresh) => ((fresh.payment_status ?? 'unpaid') === unpaid
        ? null
        : `The payment status changed to "${fresh.payment_status ?? 'unpaid'}" meanwhile`),
    });
    if (!res.ok) {
      return approvalNotCaptured(order, event, `it was cancelled and could not be reopened: ${res.message}`);
    }
    reopened = true;
  } else {
    // 2. The lease, for an order that is still open.
    await LocalDB.updateOrder(order.id, { payment_capture_started_at: new Date().toISOString() });
  }

  // 3. Capture.
  let captured: VerifiedEvent;
  try {
    captured = await provider.captureApproved(event, opts.ctx);
  } catch (err) {
    console.error(`[payments] ${provider.id} capture failed for order ${order.number}:`, err);
    recordAudit('payment.capture_failed', {
      actor: 'provider',
      target: order.id,
      metadata: {
        order: order.number, provider: provider.id, provider_event: event.rawType, event_id: event.eventId,
        reason: err instanceof Error ? err.message.slice(0, 200) : 'capture failed',
      },
    });
    // 4. Nothing was taken: an order reopened for this capture goes back.
    if (reopened) await putBackAfterCapture(order.id, order.cancelled_reason);
    throw err;
  }

  const result = await applyVerifiedEvent(captured, { ...opts, fromCapture: true });
  if (captured.outcome !== 'paid' || result.decision.action === 'reject') {
    if (captured.outcome !== 'paid') {
      recordAudit('payment.capture_failed', {
        actor: 'provider',
        target: order.id,
        metadata: {
          order: order.number, provider: provider.id, provider_event: captured.rawType,
          event_id: event.eventId, outcome: captured.outcome,
        },
      });
    }
    // A capture that took nothing: put back what step 1 took. (A REJECTED
    // capture did take money, for the wrong amount; the order stays as it is
    // and the rejection is already audited as suspicious for staff.)
    if (reopened && captured.outcome !== 'paid') await putBackAfterCapture(order.id, order.cancelled_reason);
  }
  return { ...result, orderNumber: order.number };
}

/**
 * Undo step 1 of captureApproval: cancel again, unless the order was paid
 * meanwhile — and with the REASON it was cancelled for.
 *
 * Reopening removed that reason (SetOrderStatusOptions.cancelledReason). Put
 * back without it, the order would read as cancelled by staff, and PayPal's
 * redelivery after an outage — the reason a transient failure is answered 500
 * at all — would no longer be captured.
 */
async function putBackAfterCapture(orderId: string, reason: Order['cancelled_reason']): Promise<void> {
  const res = await setOrderStatus(orderId, 'cancelled', CAPTURE_ACTOR, {
    when: (fresh) => ((fresh.payment_status ?? 'unpaid') === 'paid' ? 'The order was paid meanwhile' : null),
    cancelledReason: reason,
  });
  if (!res.ok) console.error(`[payments] could not put order ${orderId} back after a failed capture: ${res.message}`);
}

/**
 * An approval this install will not capture. Recorded once per approval (the
 * event id goes into the ledger), so a provider redelivering it does not fill
 * the audit log; the approval itself lapses at the provider.
 */
async function approvalNotCaptured(order: Order, event: VerifiedEvent, why: string): Promise<ApplyResult> {
  const decision: PaymentDecision = {
    action: 'ignore',
    reason: `Approval not captured: ${why}. It will lapse at the provider; no money was taken`,
  };
  const claim = await LocalDB.claimPaymentEvent(order.id, event.eventId, {}, { history: PAYMENT_EVENT_HISTORY });
  if (claim.outcome === 'applied') {
    console.warn(`[payments] order ${order.number}: ${decision.reason}`);
    recordAudit('payment.approval_not_captured', {
      actor: 'provider',
      target: order.id,
      metadata: { order: order.number, reason: why, provider_event: event.rawType, event_id: event.eventId },
    });
  }
  return { applied: false, decision, orderNumber: order.number };
}

/**
 * A declined attempt was counted. The first one, and the one that crosses the
 * card-testing line, are audited; crossing the line also flags the order the
 * way order-risk flags one, so it shows up where staff already look.
 */
async function afterDecline(order: Order, event: VerifiedEvent): Promise<void> {
  const declines = Number(order.payment_declines) || 0;
  if (declines === 1 || declines === CARD_TESTING_DECLINES) {
    recordAudit('payment.declined', {
      actor: 'provider',
      target: order.id,
      metadata: { order: order.number, declines, provider_event: event.rawType, event_id: event.eventId },
    });
  }
  if (declines >= CARD_TESTING_DECLINES && !(order.risk_signals ?? []).includes('card_testing')) {
    await LocalDB.updateOrder(order.id, {
      risk_flagged: true,
      risk_score: (Number(order.risk_score) || 0) + CARD_TESTING_DECLINES,
      risk_signals: [...(order.risk_signals ?? []), 'card_testing'],
      risk_reasons: [...(order.risk_reasons ?? []), `${declines} card payments declined on this order — possible card testing`],
    }).catch((err) => console.error(`[payments] could not flag order ${order.number}:`, err));
  }
}

/**
 * The provider says PAID, and the order could not be moved to processing.
 *
 * If that is because the order had already been cancelled (the hold or the
 * abandonment sweep, or staff) and its stock is gone, the shop now holds money
 * for goods it cannot send. The order STAYS cancelled — nothing ships without
 * stock behind it — and is flagged, audited and reported to the owner. The
 * event claim above makes this run once per payment: a replayed success is a
 * duplicate, and a second success event finds the order already paid.
 */
async function flagIfPaidWithoutStock(orderId: string, event: VerifiedEvent): Promise<void> {
  const fresh = await LocalDB.getOrder(orderId);
  if (!fresh || fresh.needs_refund) return;
  if ((fresh.payment_status ?? 'unpaid') !== 'paid' || !releasesStock(fresh.status)) return;
  const flagged = await LocalDB.updateOrder(orderId, {
    needs_refund: true,
    needs_refund_at: new Date().toISOString(),
  });
  if (!flagged) return;
  console.warn(`[payments] order ${fresh.number} was PAID after it was cancelled and its stock is gone — it needs a refund`);
  recordAudit('payment.needs_refund', {
    actor: 'provider',
    target: orderId,
    metadata: {
      order: fresh.number,
      status: fresh.status,
      amount_cents: event.amountCents,
      provider_event: event.rawType,
      event_id: event.eventId,
    },
  });
  void notifyNeedsRefund(flagged);
}

/** Look up a provider by the id stored on an order. */
export function providerForOrder(order: Pick<Order, 'payment_provider'>): PaymentProvider | undefined {
  return order.payment_provider ? getProvider(order.payment_provider) : undefined;
}

/* ------------------------------------------------------------------ *
 * Refund initiation
 * ------------------------------------------------------------------ */

export interface RefundOutcome {
  ok: boolean;
  status: number;
  message?: string;
  refund?: RefundRecord;
  /** Still refundable after this, so a UI can show what is left. */
  remainingCents?: number;
}

/**
 * Ask the provider to send money back, then record it.
 *
 * Order of operations matters and is deliberate:
 *
 *   1. bound the amount against OUR records (planRefund, pure + tested),
 *   2. call the provider with an idempotency key derived from that plan,
 *   3. record what the PROVIDER confirmed — not what we asked for,
 *   4. only then move the order status.
 *
 * If step 2 fails, nothing was written and the operator can retry. If step 2
 * succeeded but the process died before step 3, the same key on retry returns
 * the original refund rather than sending the money a second time.
 *
 * Step 3 is an ATOMIC append (LocalDB.appendRefund). It used to write
 * `[...refunds read in step 1, new]`, so two partial refunds at once each
 * wrote a one-element array and the second erased the first — money went back
 * and the order forgot it — and a double-clicked full refund, which the
 * provider answers with the SAME refund both times, was recorded and audited
 * twice. Now a refund id already on the order is a no-op answered with the
 * order as it is, and the payment status comes from the stored refunds.
 *
 * What the append cannot do is stop two DIFFERENT partial refunds from both
 * reaching the provider when they are planned at the same instant against the
 * same balance; the provider's own check against the captured amount is what
 * refuses the excess. Both are recorded if it accepts both, because both
 * happened.
 */
export async function refundOrder(
  orderId: string,
  requestedCents: number | null,
  actor: string,
  siteUrl: string,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
  fetchImpl?: typeof globalThis.fetch,
): Promise<RefundOutcome> {
  const order = await LocalDB.getOrder(orderId);
  if (!order) return { ok: false, status: 404, message: 'Order not found' };

  const plan = planRefund(order, requestedCents);
  if (!plan.ok) {
    // 'nothing-remaining' is a conflict (the world moved on); a bad number from
    // the caller is a 400. Distinguishing them tells a client whether to retry.
    const status = plan.reason === 'invalid-amount' || plan.reason === 'exceeds-remaining' ? 400 : 409;
    return { ok: false, status, message: plan.message, remainingCents: plan.remaining };
  }

  const provider = providerForOrder(order);
  if (!provider) {
    return { ok: false, status: 409, message: `Unknown payment provider "${order.payment_provider}"` };
  }
  if (typeof provider.refund !== 'function') {
    // Say so plainly rather than failing at the API call — the admin uses this
    // to hide the button instead of offering one that cannot work.
    return {
      ok: false,
      status: 501,
      message: `${provider.label} does not support refunds from AstroBaaS — refund it in the provider's dashboard`,
    };
  }

  const alreadyRefunded = refundedTotal(order);
  const key = refundIdempotencyKey(order.id, alreadyRefunded, plan.amountCents);
  const ctx = providerContext({ env, siteUrl, fetch: fetchImpl });

  let result;
  try {
    result = await provider.refund(order, plan.amountCents, key, ctx);
  } catch (err) {
    console.error(`[payments] ${provider.id} refund failed for ${order.number}:`, err);
    recordAudit(AUDIT.REFUND_FAILED, {
      actor,
      target: order.id,
      metadata: { order: order.number, amount_cents: plan.amountCents, provider: provider.id },
    });
    return { ok: false, status: 502, message: 'The provider refused the refund' };
  }

  // Trust the provider's number over our request: if it refunded a different
  // amount, our records must match reality, not our intention.
  const confirmed = Number.isInteger(result.amountCents) && result.amountCents > 0
    ? result.amountCents
    : plan.amountCents;

  const record: RefundRecord = {
    id: result.refundId,
    amount_cents: confirmed,
    at: new Date().toISOString(),
    actor,
  };

  const appended = await LocalDB.appendRefund(order.id, record);
  if (appended.outcome === 'missing') return { ok: false, status: 404, message: 'Order not found' };
  const after = appended.order;
  const remainingAfter = refundableRemaining(after);

  if (appended.outcome === 'duplicate') {
    // Another request already recorded THIS refund — the provider answered
    // both with the same one. It moved the order and wrote the audit entry;
    // this one reports the same result and does neither again.
    const existing = (after.refunds ?? []).find((r) => r.id === record.id) ?? record;
    return { ok: true, status: 200, refund: existing, remainingCents: remainingAfter };
  }

  if (remainingAfter === 0) {
    if (after.needs_refund) {
      // The money that arrived for a cancelled order has gone back: nothing
      // left to act on. The order stays cancelled — the state machine has no
      // cancelled → refunded move, and it needs none.
      await LocalDB.updateOrder(order.id, { needs_refund: undefined, needs_refund_at: undefined })
        .catch((err) => console.error(`[payments] could not clear the refund flag on ${order.number}:`, err));
    }
    // Only a FULL refund moves the order, because that is what returns stock.
    // Doing it on a partial would hand back inventory for goods still sold.
    // A cancelled order has already handed its stock back.
    if (!releasesStock(after.status)) {
      const res = await setOrderStatus(order.id, 'refunded', actor);
      if (!res.ok) console.error(`[payments] order ${order.number} status change failed: ${res.message}`);
    }
  }

  recordAudit(AUDIT.REFUND_ISSUED, {
    actor,
    target: order.id,
    metadata: {
      order: order.number,
      provider: provider.id,
      refund_id: record.id,
      amount_cents: confirmed,
      remaining_cents: remainingAfter,
      full: remainingAfter === 0,
    },
  });

  return { ok: true, status: 200, refund: record, remainingCents: remainingAfter };
}
