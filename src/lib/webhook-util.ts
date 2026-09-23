/**
 * Pure webhook helpers — no storage/network imports, so they're unit-testable
 * in isolation. The delivery side (fireEvent) lives in webhooks.ts.
 */
import type { Webhook } from '../core/models';

/** Standard event names fired by the core. Plugins/custom types add more. */
export const WEBHOOK_EVENTS = [
  'post.created',
  'post.updated',
  'post.deleted',
  'content.created',
  'content.updated',
  'content.deleted',
  'product.created',
  'product.updated',
  'product.deleted',
  'order.created',
  'order.updated',
  'order.status_changed',
  'customer.created',
  /**
   * The newsletter list (C-113).
   *
   * The roadmap's old note said "webhook out covers 80% of ESP sync today". It
   * covered none of it: there was no subscriber event of any kind, so nothing
   * could be forwarded to Mailchimp, Brevo or anything else.
   *
   * `subscriber.confirmed` rather than `subscriber.created` because that is the
   * moment with meaning: the address only exists here once somebody has clicked
   * the double-opt-in link, and it is the only moment at which forwarding it to
   * an ESP is lawful. There is deliberately no event for the unconfirmed
   * signup — an ESP receiving that would be importing an address nobody
   * consented with.
   *
   * `subscriber.unsubscribed` is the one that MUST fire. An unsubscribe this
   * site honours and the ESP does not is the shape that ends in a spam
   * complaint, and it is why an integration built on `confirmed` alone would
   * be worse than none.
   */
  'subscriber.confirmed',
  'subscriber.unsubscribed',
] as const;

/**
 * Does `wh` subscribe to `event`? Inactive hooks never match. Supports exact
 * names, the `'*'` catch-all, and `'prefix.*'` wildcards (e.g. `'post.*'`).
 */
export function webhookMatches(wh: Pick<Webhook, 'events' | 'active'>, event: string): boolean {
  if (!wh.active || !Array.isArray(wh.events)) return false;
  return wh.events.some(
    e => e === '*' || e === event || (e.endsWith('.*') && event.startsWith(e.slice(0, -1))),
  );
}

/** Build the exact request body for a delivery (also what gets signed). */
export function webhookBody(event: string, data: unknown, timestamp: string): string {
  return JSON.stringify({ event, timestamp, data });
}
