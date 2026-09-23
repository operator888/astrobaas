/**
 * "Your order is on its way" — the message that stops the most support email.
 *
 * ## Why fulfilment is not an order STATUS
 *
 * There is no `shipped` state and there deliberately is not one. `OrderStatus`
 * governs money and stock — cancelling returns inventory, refunding moves
 * money — and dispatch is neither. An order can be `processing` and already
 * posted, or `completed` and collected in person and never shipped at all. So
 * tracking lives beside the status, and `shipped_at` is what makes this send.
 *
 * ## Sends once
 *
 * `shipped_at` is set the first time tracking is recorded and is the guard: an
 * operator who corrects a typo in the tracking number must not send the
 * customer a second "on its way" email. Correcting the number updates the
 * order; it does not re-notify.
 *
 * Pure, like `buildOrderConfirmation`: no database, no transport, so its tests
 * state the exact bytes.
 */
import { formatMoney } from '../money-format';
import { escapeHtml as esc } from '../escape-html';
import type { Order } from '../../core/models';

/** Header injection is impossible if newlines never reach a header. */
function headerSafe(s: string): string {
  return s.replace(/[\r\n]+/g, ' ').trim();
}

export interface ShippedNotice {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface ShippedOptions {
  siteTitle?: string;
  /** Public origin, for the receipt link. Omitted means no link is rendered. */
  receiptLink?: string;
  /** Operator's subject wording (C-112), already rendered. */
  subject?: string;
}

/**
 * Build it, or null when there is nothing to send.
 *
 * Null rather than throwing for the same reason the confirmation does it: an
 * order can legitimately have no email (taken over the counter), and that is
 * not an error worth failing a dispatch over.
 */
export function buildShippedNotice(
  order: Order,
  opts: ShippedOptions = {},
): ShippedNotice | null {
  const to = String(order.email ?? '').trim();
  if (!to || !to.includes('@')) return null;
  // No tracking, no notice. The whole message is "here is where it is".
  if (!order.tracking_number && !order.tracking_url) return null;

  const shop = headerSafe(opts.siteTitle?.trim() || 'Your order');
  const number = headerSafe(String(order.number ?? order.id ?? '—'));
  const carrier = headerSafe(String(order.tracking_carrier ?? '').trim());
  const code = headerSafe(String(order.tracking_number ?? '').trim());
  const url = String(order.tracking_url ?? '').trim();

  const lines: string[] = [`Your order ${number} is on its way.`, ''];
  if (carrier) lines.push(`Carrier: ${carrier}`);
  if (code) lines.push(`Tracking number: ${code}`);
  if (url) lines.push(`Track it: ${url}`);
  lines.push('');
  // The line items, so the customer can see WHAT shipped without opening
  // anything — the second question after "where is it".
  const items = (Array.isArray(order.items) ? order.items : []).map((i) => {
    const raw = i as { qty?: unknown; name?: unknown; total_cents?: unknown };
    return {
      qty: Number(raw.qty ?? 1) || 1,
      name: String(raw.name ?? 'item'),
      money: formatMoney(Number(raw.total_cents) || 0, { currency: order.currency }),
    };
  });
  for (const i of items) lines.push(`  ${i.qty} × ${i.name} — ${i.money}`);
  if (opts.receiptLink) lines.push('', `Your receipt: ${opts.receiptLink}`);
  lines.push('', shop);

  const rows = items
    .map((i) => `<tr><td>${esc(i.qty)} × ${esc(i.name)}</td><td align="right">${esc(i.money)}</td></tr>`)
    .join('');
  const html = [
    `<p>Your order <strong>${esc(number)}</strong> is on its way.</p>`,
    carrier ? `<p>Carrier: ${esc(carrier)}</p>` : '',
    code ? `<p>Tracking number: <strong>${esc(code)}</strong></p>` : '',
    // Only an http(s) URL is ever stored (`safeTrackingUrl`), so this cannot
    // become a `javascript:` link in a mail client that follows one.
    url ? `<p><a href="${esc(url)}">Track your parcel</a></p>` : '',
    `<table cellpadding="6" cellspacing="0" border="0">${rows}</table>`,
    opts.receiptLink ? `<p><a href="${esc(opts.receiptLink)}">View or print your receipt</a></p>` : '',
    `<p>${esc(shop)}</p>`,
  ].filter(Boolean).join('\n');

  return {
    to,
    subject: opts.subject?.trim() || `${shop} — order ${number} is on its way`,
    text: lines.join('\n'),
    html,
  };
}

/**
 * A tracking URL we are willing to store and put in an email.
 *
 * Only http(s). A carrier's "URL" arriving from an operator paste or a feed can
 * be anything, and `javascript:` in an anchor is a live link in some mail
 * clients and in any storefront that renders it.
 */
export function safeTrackingUrl(raw: unknown): string | undefined {
  const s = String(raw ?? '').trim();
  if (!s) return undefined;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}
