/**
 * The email the CUSTOMER gets after ordering.
 *
 * ## Why this file exists
 *
 * It did not, and the scoreboard said it did. `notifyNewSale` mails the SHOP —
 * that is a staff notification, and it is off unless an admin configures
 * recipients. The buyer received nothing at all: no order number to quote, no
 * list of what they bought, no total, and — the sharp end — no bank details
 * when they chose a transfer. An order placed with `bank-transfer` on a shop
 * with no storefront-side confirmation was therefore unpayable: the customer
 * had no account number and no reference to put on it.
 *
 * Both live shops take bank transfers.
 *
 * ## Not a copy of the staff notification
 *
 * They read differently because they are read by different people for different
 * reasons. The shop's version leads with the amount and the payment state,
 * because an owner glancing at a phone needs to know whether to pack anything.
 * The customer's leads with the order number and what happens next, because
 * that is the question they actually have.
 *
 * ## Payment instructions come from the method, not from a new setting
 *
 * `ManualMethodDef.instructions` is already a locale-keyed map served publicly
 * at `/api/payments`, and already documented as holding only things a shop
 * publishes anyway — an IBAN, a VAT number. Reusing it means an operator
 * configures their bank details ONCE and both the checkout page and this email
 * read the same text. A second setting for the same fact is how the two end up
 * disagreeing.
 *
 * ## Pure
 *
 * The builder takes everything it needs and touches no database, no clock and
 * no mail transport, so every escaping rule and every wording decision is
 * testable. `sendOrderConfirmation` is the thin wiring.
 */
import type { Order } from '../../core/models';
import { formatMoney } from './sale-notify';
import { escapeHtml as esc } from '../escape-html';
import { settingBool } from '../settings-map';

/** Settings keys, exported so the admin form and the reader cannot drift. */
export const ORDER_EMAIL_KEYS = {
  /**
   * Default ON. A shop that takes an order and does not confirm it is broken,
   * so the safe default is to send — and an operator who genuinely does not
   * want it (because their storefront sends its own) can turn it off. Only an
   * explicit `false` disables it.
   */
  enabled: 'order_confirmation_enabled',
} as const;

export interface OrderConfirmation {
  to: string;
  subject: string;
  text: string;
  html: string;
}


/**
 * Strip CR/LF from anything that lands in a header.
 *
 * The subject carries the order number and the shop name. A newline in either
 * appends headers of its own — the classic mail-header injection — and the
 * order number is generated while the shop title is operator-authored, so
 * neither is trusted here.
 */
function headerSafe(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

/** What the buyer should expect next, in plain words rather than a status enum. */
function nextStep(order: Order, hasInstructions: boolean): string {
  const method = String(order.payment_method ?? '');
  const paid = order.payment_status === 'paid';
  if (paid) return 'We have your payment and are preparing your order.';
  if (method === 'cod') return 'You will pay when the order is delivered.';
  if (method === 'bank-transfer') {
    return hasInstructions
      ? 'Your order is reserved. Transfer the total using the details below, quoting the order number, and we will ship as soon as it arrives.'
      // Saying "we will be in touch" is the honest line when the shop has not
      // configured its bank details: promising details that are not in the
      // email would be worse than admitting a human has to follow up.
      : 'Your order is reserved. We will contact you with payment details shortly.';
  }
  return 'Your order is reserved. We will confirm as soon as the payment is settled.';
}

export interface ConfirmationOptions {
  siteTitle?: string;
  /** Public site origin, for a link back. Omitted means no link is rendered. */
  siteUrl?: string;
  /**
   * Payment instructions for the order's method, already resolved to the
   * buyer's locale by the caller. Plain text; rendered escaped.
   */
  instructions?: string;
  /**
   * The subject, already rendered from the operator's template (C-112).
   *
   * Passed IN rather than read here: this function is pure and its tests run
   * without a database, and the settings read belongs in the layer that
   * already does one.
   */
  subject?: string;
  /**
   * Absolute link to the buyer's printable receipt (C-39).
   *
   * Passed IN for the same reason `subject` is: building it needs the signing
   * secret, and this function is pure so its tests run without one. Omitted
   * means no receipt paragraph — which is the right behaviour when the origin
   * is unknown, because a receipt link that resolves to nothing is worse than
   * no link.
   */
  receiptLink?: string;
}

/**
 * Build the confirmation. Returns null when there is no address to send to.
 *
 * Null rather than throwing: an order can legitimately be created by an
 * operator on the phone with no email captured, and that is not an error worth
 * failing a checkout over.
 */
export function buildOrderConfirmation(
  order: Order,
  opts: ConfirmationOptions = {},
): OrderConfirmation | null {
  const to = String(order.email ?? '').trim();
  if (!to || !to.includes('@')) return null;

  const shop = headerSafe(opts.siteTitle?.trim() || 'Your order');
  const number = headerSafe(String(order.number ?? order.id ?? '—'));
  const currency = order.currency ?? 'EUR';
  const total = formatMoney(order.total_cents ?? 0, currency);
  const instructions = opts.instructions?.trim() || '';
  const step = nextStep(order, instructions !== '');

  const items = (Array.isArray(order.items) ? order.items : []).map((i) => {
    const raw = i as { qty?: unknown; name?: unknown; total_cents?: unknown; price_cents?: unknown };
    const qty = Number(raw.qty ?? 1) || 1;
    const name = String(raw.name ?? 'item');
    // A line total is preferred over a unit price: it is the number the customer
    // can add up and check against the total they were charged.
    const cents = Number(raw.total_cents ?? (Number(raw.price_cents ?? 0) * qty)) || 0;
    return { qty, name, money: formatMoney(cents, currency) };
  });

  /* ---- plain text ---- */
  const lines: string[] = [
    `Thank you for your order.`,
    ``,
    `Order ${number}`,
    ``,
    ...items.map((i) => `  ${i.qty} × ${i.name} — ${i.money}`),
    ``,
    `Total: ${total}`,
    ``,
    step,
  ];
  if (instructions) {
    lines.push(``, `Payment details`, instructions, ``, `Reference: ${number}`);
  }
  if (opts.receiptLink) {
    lines.push(``, `Your receipt: ${opts.receiptLink}`);
  }
  if (opts.siteUrl) lines.push(``, opts.siteUrl.replace(/\/$/, ''));
  lines.push(``, shop);

  /* ---- html ---- */
  const rows = items
    .map((i) => `<tr><td>${esc(i.qty)} × ${esc(i.name)}</td><td align="right">${esc(i.money)}</td></tr>`)
    .join('');
  const html = [
    `<p>Thank you for your order.</p>`,
    `<p><strong>Order ${esc(number)}</strong></p>`,
    `<table cellpadding="6" cellspacing="0" border="0">${rows}`,
    `<tr><td><strong>Total</strong></td><td align="right"><strong>${esc(total)}</strong></td></tr>`,
    `</table>`,
    `<p>${esc(step)}</p>`,
    instructions
      // An inline style, deliberately — and the ONE place in this codebase where
      // that is right. The CSP rule that forbids them applies to pages this app
      // serves; an email is rendered by a mail client, where inline styles are
      // the only ones that reliably survive. pre-wrap because an IBAN block is
      // written with line breaks that carry meaning. Escaped first, so the
      // operator's own text cannot inject markup.
      ? `<h3>Payment details</h3><pre style="white-space:pre-wrap;font-family:inherit">${esc(instructions)}</pre>`
        + `<p>Reference: <strong>${esc(number)}</strong></p>`
      : '',
    // The token is already URL-encoded by `receiptUrl`; `esc` here is the HTML
    // escape on top of that, which is the correct pair for an href.
    opts.receiptLink ? `<p><a href="${esc(opts.receiptLink)}">View or print your receipt</a></p>` : '',
    opts.siteUrl ? `<p><a href="${esc(opts.siteUrl.replace(/\/$/, ''))}">${esc(shop)}</a></p>` : `<p>${esc(shop)}</p>`,
  ].join('\n');

  return {
    to,
    // Operator-editable (C-112), subject only: the body below is a structured
    // document with a plain-text and an HTML rendering that have to agree, and
    // an operator retyping it would own reproducing the line items correctly.
    // `opts.subject` is rendered from the template by the caller, which is the
    // layer that can read settings — this function stays pure.
    subject: headerSafe(opts.subject || `${shop} — order ${number}`),
    text: lines.join('\n'),
    html,
  };
}

/** Everything the wiring needs, injected so the sender stays testable. */
export interface ConfirmationDeps {
  readSettings: () => Promise<Record<string, unknown>>;
  send: (msg: { to: string; subject: string; text: string; html?: string }) => Promise<void>;
  /** Payment instructions for this order's method, in the buyer's locale. */
  instructionsFor: (methodId: string) => string | undefined;
  siteUrl?: string;
  /**
   * May this address be mailed now? Asked just before the send.
   *
   * Guest checkout is public, and every order it accepts mails the address it
   * was given — so without a per-recipient budget, checkout is a way to send
   * a stranger's inbox as many "thank you for your order" emails as there are
   * orders a script can place, from the shop's own domain. The wiring
   * (commerce-service) spends a small hourly budget per recipient; absent
   * means no budget, which is what the pure tests use.
   */
  allowSend?: (to: string) => Promise<boolean>;
}

/**
 * Send it, swallowing every failure.
 *
 * A mail transport that is down, misconfigured or absent must never fail a
 * checkout. The order is already stored; the customer has already paid or
 * committed to pay. Losing the confirmation is bad, losing the order is worse,
 * and the email log records what was attempted either way.
 */
export async function sendOrderConfirmation(
  order: Order,
  deps: ConfirmationDeps,
): Promise<void> {
  try {
    const settings = await deps.readSettings();
    // `=== false` is the wrong test: the STRING "false" is not `false`, so the
    // operator's "do not email customers" switch did nothing at all.
    //
    // The reason it can BE a string was stated wrongly here for a while, and
    // the wrong reason then spread to other files. It is not that a driver
    // hands settings back as TEXT — all three store a Setting as a JSON
    // document and parse it back, so a boolean survives; that was measured
    // across lowdb, the libSQL doc-blob and the relational driver. It is that
    // `POST /api/settings/update` accepts arbitrary JSON and coerces only the
    // keys in `BOOLEAN_KEYS`, so an operator scripting their setup stores the
    // string they sent.
    if (settingBool(settings[ORDER_EMAIL_KEYS.enabled], true) === false) return;

    const siteTitle = typeof settings.site_title === 'string' ? settings.site_title : undefined;
    // The operator's subject wording, with the built-in as the fallback. Body
    // deliberately not templated — see the note on `subject` in
    // ConfirmationOptions.
    const { renderEmailTemplate, emailTemplateKey } = await import('../email-templates');
    const rendered = renderEmailTemplate('order_confirmation', {
      site_title: siteTitle ?? 'Your order',
      order_number: String(order.number ?? order.id ?? '—'),
      // Through the shared key builder, not a hand-spelled string: the two can
      // otherwise drift silently and the operator's wording stops being used
      // with nothing to indicate why.
    }, settings[emailTemplateKey('order_confirmation')]);

    const { receiptUrl } = await import('./receipt');
    const msg = buildOrderConfirmation(order, {
      siteTitle,
      siteUrl: deps.siteUrl,
      // Only when the origin is known — `receiptUrl` would otherwise build a
      // relative path that is not clickable from a mail client.
      receiptLink: deps.siteUrl ? receiptUrl(deps.siteUrl, String(order.id)) : undefined,
      instructions: deps.instructionsFor(String(order.payment_method ?? '')),
      subject: rendered?.subject,
    });
    if (!msg) return;

    if (deps.allowSend && !(await deps.allowSend(msg.to))) {
      // Logged without the address: the log is not a second recipient list.
      console.warn(`[order-confirmation] recipient over its hourly budget; not sending the confirmation for order ${String(order.number ?? order.id)}`);
      return;
    }
    await deps.send(msg);
  } catch (err) {
    console.error('Order confirmation email failed:', err instanceof Error ? err.message : err);
  }
}
