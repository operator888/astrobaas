/**
 * Order fulfilment state machine.
 *
 * COMMERCE.md listed "any status may move to any other" as a known limit, with
 * the note that stock accounting stays correct either way. Stock does — the
 * release/re-take logic keys on the PREVIOUS status, and only the request that
 * atomically moves the order off that status moves stock (setOrderStatus;
 * guarding on the previous status alone let two concurrent cancels both
 * release) — but the audit trail does not: `refunded → pending` reads as a
 * shop un-refunding a customer, and `completed → pending` erases the fact
 * that goods left the building.
 *
 * So transitions are constrained. Deliberately permissive where a human might
 * genuinely need to correct a mistake, and closed only where the transition is
 * meaningless or would misrepresent what happened.
 */

import type { OrderStatus } from '../../core/models';

/**
 * Allowed next states for each status.
 *
 * The terminal pair is `refunded` and `completed`:
 *   - `refunded` is terminal because money went back; anything after it is a
 *     new order, not a state change.
 *   - `completed` may still be cancelled or refunded (returns happen), but
 *     cannot go back to pending/processing — the goods already shipped.
 */
export const ORDER_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  pending: ['processing', 'on-hold', 'completed', 'cancelled'],
  processing: ['pending', 'on-hold', 'completed', 'cancelled', 'refunded'],
  'on-hold': ['pending', 'processing', 'completed', 'cancelled'],
  // A shipped order can still be returned or refunded, but not un-shipped.
  completed: ['refunded', 'cancelled'],
  // A cancelled order can be reopened — customers change their minds, and the
  // re-take path already refuses when the stock has gone.
  cancelled: ['pending', 'processing'],
  // Terminal: money has been returned.
  refunded: [],
  // A failed payment can be retried (back to pending) or written off. It is
  // NOT a route to completed — goods must not ship on a payment that failed.
  failed: ['pending', 'cancelled'],
};

export interface TransitionCheck {
  ok: boolean;
  reason?: string;
}

/** May an order move from `from` to `to`? Same-state is always a no-op yes. */
export function canTransition(from: OrderStatus, to: OrderStatus): TransitionCheck {
  if (from === to) return { ok: true };
  const allowed = ORDER_TRANSITIONS[from];
  if (!allowed) return { ok: false, reason: `Unknown current status "${from}"` };
  if (allowed.includes(to)) return { ok: true };
  return {
    ok: false,
    reason:
      from === 'refunded'
        ? 'A refunded order is final — its money has already been returned.'
        : `An order cannot go from "${from}" to "${to}".`,
  };
}

/** States an admin UI should offer, given where the order is now. */
export function allowedNextStatuses(from: OrderStatus): OrderStatus[] {
  return [from, ...(ORDER_TRANSITIONS[from] ?? [])];
}
