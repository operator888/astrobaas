/**
 * The finance module's outbound webhook events.
 *
 * Every event is fired with its name written out literally, on purpose:
 * tests/webhook-events.test.mjs scans the source for literal fireEvent calls to
 * prove each event in WEBHOOK_EVENTS can actually fire. A computed name would
 * hide an event from that check — and a subscription to an event that never
 * fires waits forever.
 */
import { fireEvent } from '../../../lib/webhooks';

export type FinanceEvent =
  | 'invoice.finalized' | 'invoice.paid' | 'invoice.cancelled' | 'invoice.dunned'
  | 'credit_note.finalized' | 'quote.finalized' | 'quote.accepted' | 'quote.rejected'
  | 'document.sent' | 'expense.created';

export function emitFinanceEvent(event: string, data: unknown): Promise<void> {
  switch (event as FinanceEvent) {
    case 'invoice.finalized': return fireEvent('invoice.finalized', data);
    case 'invoice.paid': return fireEvent('invoice.paid', data);
    case 'invoice.cancelled': return fireEvent('invoice.cancelled', data);
    case 'invoice.dunned': return fireEvent('invoice.dunned', data);
    case 'credit_note.finalized': return fireEvent('credit_note.finalized', data);
    case 'quote.finalized': return fireEvent('quote.finalized', data);
    case 'quote.accepted': return fireEvent('quote.accepted', data);
    case 'quote.rejected': return fireEvent('quote.rejected', data);
    case 'document.sent': return fireEvent('document.sent', data);
    case 'expense.created': return fireEvent('expense.created', data);
    default:
      // An event the module emits but did not declare is a bug, not a webhook.
      console.error(`[finance] undeclared event "${event}" was not fired`);
      return Promise.resolve();
  }
}
