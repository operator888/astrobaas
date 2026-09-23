/**
 * One reminder, before the sweep cancels an unpaid order.
 *
 * ## Why this is worth so little code
 *
 * The abandonment sweep already runs on a timer and already cancels unpaid
 * orders, returning their stock. Everything it needs to decide WHICH orders is
 * already computed. What was missing was a message: the customer's order simply
 * vanished after three days, and on a bank-transfer order that is the most
 * likely outcome of all, because paying takes a deliberate second visit.
 *
 * ## What it says, and what it must not
 *
 * It carries the payment instructions — for a bank transfer that is the IBAN
 * and the reference, which is the whole reason the order is unpaid. It never
 * carries a discount or a "last chance" claim: this is a transactional reminder
 * about the customer's own order, not marketing, and dressing it as an offer is
 * what turns a reminder into something a recipient reports.
 *
 * Pure, like the confirmation and the shipped notice.
 */
import { formatMoney } from '../money-format';
import { escapeHtml as esc } from '../escape-html';
import type { Order } from '../../core/models';

function headerSafe(s: string): string {
  return s.replace(/[\r\n]+/g, ' ').trim();
}

export interface RecoveryNotice {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface RecoveryOptions {
  siteTitle?: string;
  /** Already resolved to the buyer's locale by the caller. Plain text. */
  instructions?: string;
  /** Whole days left before the order is cancelled, when known. */
  daysLeft?: number;
  /** Operator's subject wording (C-112), already rendered. */
  subject?: string;
}

export function buildRecoveryNotice(
  order: Order,
  opts: RecoveryOptions = {},
): RecoveryNotice | null {
  const to = String(order.email ?? '').trim();
  if (!to || !to.includes('@')) return null;

  const shop = headerSafe(opts.siteTitle?.trim() || 'Your order');
  const number = headerSafe(String(order.number ?? order.id ?? '—'));
  const total = formatMoney(order.total_cents ?? 0, { currency: order.currency });
  const instructions = opts.instructions?.trim() || '';

  const items = (Array.isArray(order.items) ? order.items : []).map((i) => {
    const raw = i as { qty?: unknown; name?: unknown; total_cents?: unknown };
    return {
      qty: Number(raw.qty ?? 1) || 1,
      name: String(raw.name ?? 'item'),
      money: formatMoney(Number(raw.total_cents) || 0, { currency: order.currency }),
    };
  });

  const lines: string[] = [
    `Your order ${number} is still waiting for payment.`,
    '',
    ...items.map((i) => `  ${i.qty} × ${i.name} — ${i.money}`),
    '',
    `Total: ${total}`,
  ];
  if (instructions) {
    lines.push('', 'Payment details', instructions, '', `Reference: ${number}`);
  }
  // Said plainly rather than as urgency. A customer is entitled to know their
  // order will not sit there forever, and "act now" would be a sales line on a
  // message that is not a sales message.
  if (typeof opts.daysLeft === 'number' && opts.daysLeft > 0) {
    lines.push('', opts.daysLeft === 1
      ? 'If it is not paid, the order will be cancelled tomorrow and the items released.'
      : `If it is not paid, the order will be cancelled in ${opts.daysLeft} days and the items released.`);
  }
  lines.push('', shop);

  const rows = items
    .map((i) => `<tr><td>${esc(i.qty)} × ${esc(i.name)}</td><td align="right">${esc(i.money)}</td></tr>`)
    .join('');
  const html = [
    `<p>Your order <strong>${esc(number)}</strong> is still waiting for payment.</p>`,
    `<table cellpadding="6" cellspacing="0" border="0">${rows}`,
    `<tr><td><strong>Total</strong></td><td align="right"><strong>${esc(total)}</strong></td></tr></table>`,
    instructions
      // Inline style, for the same reason the confirmation uses one: a mail
      // client renders this, not a page with a CSP.
      ? `<h3>Payment details</h3><pre style="white-space:pre-wrap;font-family:inherit">${esc(instructions)}</pre>`
        + `<p>Reference: <strong>${esc(number)}</strong></p>`
      : '',
    typeof opts.daysLeft === 'number' && opts.daysLeft > 0
      ? `<p>If it is not paid, the order will be cancelled in ${esc(opts.daysLeft)} day(s) and the items released.</p>`
      : '',
    `<p>${esc(shop)}</p>`,
  ].filter(Boolean).join('\n');

  return {
    to,
    subject: opts.subject?.trim() || `${shop} — your order ${number} is waiting`,
    text: lines.join('\n'),
    html,
  };
}
