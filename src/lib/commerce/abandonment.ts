/**
 * Abandoned-order sweep.
 *
 * Checkout reserves stock so two buyers cannot take the last unit. The cost of
 * that guarantee is that an order which is never paid holds its reservation —
 * and with `bank-transfer`, where nobody ever clicks anything, it holds it
 * forever. A shop slowly runs out of sellable stock it physically has.
 *
 * So: an order that has not been paid within a window is cancelled, which
 * returns its stock through the SAME path an operator cancelling by hand would
 * use. Nothing new touches inventory.
 *
 * The decision is pure and separated from the sweep so the rules — which orders
 * qualify, and which must never be touched — are testable without a clock or a
 * database. Getting this wrong cancels orders customers actually paid for.
 */

import type { Order } from '../../core/models';
import { settingBool, settingInt } from '../settings-map';

/** Settings keys, exported so the admin form and the reader cannot drift. */
export const ABANDONMENT_KEYS = {
  /** Send one reminder before the sweep cancels. Off by default — see below. */
  recoveryEnabled: 'orders_recovery_enabled',
  /** Hours after the order before the reminder goes out. */
  recoveryAfterHours: 'orders_recovery_after_hours',
  enabled: 'orders_abandon_enabled',
  days: 'orders_abandon_after_days',
} as const;

/** Long enough for a bank transfer to clear, short enough to free stock. */
export const DEFAULT_ABANDON_DAYS = 3;

/**
 * One reminder, a day after the order, before the sweep cancels it.
 *
 * Long enough that somebody who is mid-bank-transfer is not nagged, short
 * enough to arrive while the purchase is still a live intention.
 */
export const DEFAULT_RECOVERY_HOURS = 24;
export const MIN_RECOVERY_HOURS = 1;
export const MAX_RECOVERY_HOURS = 24 * 30;
/** Below this the sweep would cancel orders mid-checkout. */
export const MIN_ABANDON_DAYS = 1;
export const MAX_ABANDON_DAYS = 90;

export interface RecoverySettings {
  enabled: boolean;
  afterHours: number;
}

export interface AbandonmentSettings {
  enabled: boolean;
  days: number;
}

export function resolveAbandonmentSettings(
  settings: Record<string, unknown> | null | undefined,
): AbandonmentSettings {
  const map = settings ?? {};
  const raw = map[ABANDONMENT_KEYS.days];
  const parsed = typeof raw === 'string' ? Number(raw) : raw;
  const days = typeof parsed === 'number' && Number.isFinite(parsed)
    ? Math.min(MAX_ABANDON_DAYS, Math.max(MIN_ABANDON_DAYS, Math.floor(parsed)))
    : DEFAULT_ABANDON_DAYS;
  return {
    // On by default: stock held forever is the worse failure, and an operator
    // who wants indefinite holds can say so.
    //
    // `settingBool`, not `!== false`: the string "false" is not `false`, so an
    // operator who switched the sweep off through the settings API kept having
    // their pending orders cancelled — the one outcome the switch exists to
    // prevent.
    enabled: settingBool(map[ABANDONMENT_KEYS.enabled], true),
    days,
  };
}

/**
 * Whether to send one recovery reminder, and when.
 *
 * ## Off by default, unlike the abandonment sweep itself
 *
 * Cancelling an unpaid order is housekeeping the shop does to its own records.
 * Emailing the customer is a message from the shop to a person, and an operator
 * has to choose to send it — an upgrade must not start mailing an existing
 * shop's customers because a new default said so.
 *
 * ## The reminder is clamped to arrive BEFORE the cancellation
 *
 * A reminder configured to go out after the order has already been cancelled is
 * not a reminder, it is a message about something that no longer exists. The
 * abandonment deadline is the ceiling, and the value is pulled below it rather
 * than refused, because an operator who shortens the abandonment window should
 * not silently lose their reminders.
 */
export function resolveRecoverySettings(
  map: Record<string, unknown> | null | undefined,
  abandonment: AbandonmentSettings,
): RecoverySettings {
  const m = map ?? {};
  const raw = m[ABANDONMENT_KEYS.recoveryAfterHours];
  const hours = settingInt(raw, DEFAULT_RECOVERY_HOURS, {
    min: MIN_RECOVERY_HOURS, max: MAX_RECOVERY_HOURS,
  });
  // Strictly before the cancellation, with an hour of daylight so a sweep that
  // runs a minute late still sends the reminder rather than skipping to cancel.
  const ceiling = Math.max(MIN_RECOVERY_HOURS, abandonment.days * 24 - 1);
  return {
    enabled: settingBool(m[ABANDONMENT_KEYS.recoveryEnabled], false),
    afterHours: Math.min(hours, ceiling),
  };
}

/**
 * Does this order deserve its one reminder now?
 *
 * Pure, and deliberately strict. Every `false` here is a message NOT sent to a
 * real person, so each reason is named rather than folded into one check.
 */
export function shouldRemind(
  order: Pick<Order, 'status' | 'payment_status' | 'created_at' | 'email'>
    & { recovery_sent_at?: string; wp_id?: unknown },
  abandonment: AbandonmentSettings,
  recovery: RecoverySettings,
  nowMs: number,
): boolean {
  if (!recovery.enabled) return false;
  // Once. `recovery_sent_at` is the guard, and it is set even when the send
  // fails — a transport that is down must not turn into a nightly reminder.
  if (order.recovery_sent_at) return false;
  // Nowhere to send it.
  if (!order.email || !String(order.email).includes('@')) return false;
  // Everything the cancellation sweep excludes, excluded here for the same
  // reasons — an imported order in particular, whose dates describe another
  // shop's history and would make every one of them look overdue.
  const decision = shouldAbandon(order as never, abandonment, nowMs);
  // Already due for cancellation: too late to ask for the money. Checked first,
  // because the decision is a union and `reason` only exists on the false arm.
  if (decision.abandon) return false;
  // Everything the cancellation sweep excludes, excluded here for the same
  // reasons — an imported order in particular, whose dates describe another
  // shop's history and would make every one of them look overdue on day one.
  // Only `not-yet-stale` means "a live order that simply is not old enough".
  if (decision.reason !== 'not-yet-stale') return false;

  const created = Date.parse(order.created_at ?? '');
  if (!Number.isFinite(created)) return false;
  const ageHours = (nowMs - created) / 3_600_000;
  if (ageHours < 0) return false; // clock skew
  return ageHours >= recovery.afterHours;
}

/** Orders due one reminder, at `nowMs`. */
export function selectForReminder<T extends Pick<Order, 'id' | 'status' | 'payment_status' | 'payment_method' | 'created_at' | 'email'> & { recovery_sent_at?: string }>(
  orders: readonly T[],
  abandonment: AbandonmentSettings,
  recovery: RecoverySettings,
  nowMs: number,
): T[] {
  return orders.filter((o) => shouldRemind(o as never, abandonment, recovery, nowMs));
}

export type AbandonSkipReason =
  | 'already-closed'
  | 'paid'
  | 'not-yet-stale'
  | 'no-date'
  | 'manual-method'
  | 'imported';

export type AbandonDecision =
  | { abandon: true; ageDays: number }
  | { abandon: false; reason: AbandonSkipReason };

/**
 * Should this order be abandoned?
 *
 * Deliberately conservative. Every guard below exists because cancelling the
 * wrong order takes goods back from someone who paid for them:
 *
 *  - anything already closed is left alone (idempotent, and re-cancelling
 *    would not credit stock twice but would rewrite history);
 *  - a PAID order is never touched, whatever its fulfilment status — payment
 *    is the whole question;
 *  - an order with an unparseable date is skipped rather than assumed old.
 */
export function shouldAbandon(
  order: Pick<Order, 'status' | 'payment_status' | 'payment_method' | 'created_at'> & { wp_id?: unknown; risk_held?: boolean },
  settings: AbandonmentSettings,
  nowMs: number,
): AbandonDecision {
  if (!settings.enabled) return { abandon: false, reason: 'not-yet-stale' };

  // An IMPORTED order is never abandoned. It was not placed through this
  // system's checkout: no stock was ever held for it here, so "cancel and
  // return the stock" would CREDIT inventory for goods that left the old
  // shop's shelves years ago — quiet stock inflation, order by order. And its
  // dates describe the old site's history, which is exactly what makes a
  // just-imported unpaid order look years stale to the age check below.
  if (typeof order.wp_id === 'string' && order.wp_id !== '') {
    return { abandon: false, reason: 'imported' };
  }

  // Closed already — cancelled, refunded, or fulfilled.
  if (order.status === 'cancelled' || order.status === 'refunded' || order.status === 'completed') {
    return { abandon: false, reason: 'already-closed' };
  }

  // THE guard. `paid` is definitive; so is an order that has moved beyond
  // pending, because a human put it there.
  const payment = order.payment_status ?? 'unpaid';
  if (payment === 'paid' || payment === 'refunded') return { abandon: false, reason: 'paid' };
  // One exception: an order the opt-in RISK hold placed on hold is waiting
  // for a person AND for its money. Unpaid, it must still expire — otherwise
  // the orders most likely to be a hoarding script would hold stock forever.
  const riskHeld = order.status === 'on-hold' && order.risk_held === true;
  if (order.status !== 'pending' && !riskHeld) return { abandon: false, reason: 'paid' };

  const created = Date.parse(order.created_at ?? '');
  if (!Number.isFinite(created)) return { abandon: false, reason: 'no-date' };

  const ageDays = (nowMs - created) / 86_400_000;
  // A future-dated order (clock skew, bad import) is not stale.
  if (ageDays < settings.days) return { abandon: false, reason: 'not-yet-stale' };

  return { abandon: true, ageDays };
}

/** Orders the sweep would cancel right now. Pure; the caller does the writing. */
export function selectAbandoned<T extends Pick<Order, 'id' | 'status' | 'payment_status' | 'payment_method' | 'created_at'>>(
  orders: readonly T[],
  settings: AbandonmentSettings,
  nowMs: number,
): T[] {
  return orders.filter((o) => shouldAbandon(o, settings, nowMs).abandon);
}
