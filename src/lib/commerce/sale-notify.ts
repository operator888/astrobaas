/**
 * Tell the shop owner when a sale comes in.
 *
 * ## Why this is not the webhook system
 *
 * AstroBaaS already fires `order.created` to configured webhooks, with HMAC
 * signing, delivery logs and redelivery. That is the right pipe for *machines*
 * — an ERP, a courier, a Make/Zapier flow that ends in a Viber or WhatsApp
 * message — and this module does not duplicate it.
 *
 * What it does not do is reach a person. A shop owner who wants to know a sale
 * happened is not going to stand up a webhook receiver, and asking them to is
 * how a shop finds out about its own orders by refreshing the admin.
 *
 * ## Why the toggle is a setting and the credentials are not
 *
 * `sale_notify_enabled` and the recipient list are settings: an operator
 * decision, changed from the admin, with no secret in them. Anything that
 * authenticates — an API key, a signed webhook URL — stays in the environment,
 * because the settings table is a schemaless bucket with a public read path and
 * this codebase has already had to fix that mistake once.
 *
 * The recipient list is staff-only either way: it is not `public_`-prefixed, so
 * `settings-visibility.ts` denies it to anonymous callers by default.
 *
 * ## Why nothing here may throw
 *
 * It runs on the checkout path. A mail server that is down, a DNS blip, a
 * mistyped address — none of them may cost the shop a sale. Every failure is
 * logged and swallowed, and the order is already committed before this runs.
 */

import type { Order } from '../../core/models';
import { formatMoney as sharedFormatMoney } from '../money-format';
import { defaultLocale } from '../i18n';
import { escapeHtml as esc } from '../escape-html';
import { settingBool } from '../settings-map';

/**
 * Money for a human to read.
 *
 * This WAS the local implementation, and it is the reason `lib/money-format.ts`
 * exists: it produced `€89.00` while five admin screens produced `89,00 €`, so
 * the sale email and the orders screen stated the same total two ways. The
 * shared module was written, the screens were converted, and this one was not —
 * which left the divergence its own docblock claims to have ended.
 *
 * Kept as a named export with the same signature because the order confirmation
 * imports it from here and the tests call it directly; the body is now one line
 * of delegation. Emails are addressed to the shop's own default locale — there
 * is no reader locale on the checkout path, and picking the shop's is at least
 * a decision rather than a hardcode.
 *
 * The shared module also handles zero-decimal currencies, which this did not:
 * a JPY total was quietly divided by 100.
 */
export function formatMoney(cents: number, currency: string): string {
  return sharedFormatMoney(cents, { currency, locale: defaultLocale() });
}

/** Settings keys, exported so the admin form and the reader cannot drift. */
export const SALE_NOTIFY_KEYS = {
  enabled: 'sale_notify_enabled',
  recipients: 'sale_notify_recipients',
} as const;

/** How many addresses one shop may notify. */
export const MAX_SALE_RECIPIENTS = 10;

export interface SaleNotifySettings {
  enabled: boolean;
  recipients: string[];
}

/**
 * Split a recipient list.
 *
 * Commas, semicolons, newlines and spaces all separate, because a person
 * pasting three addresses into a textarea uses whichever they think of, and
 * refusing the other two teaches them the field is broken.
 *
 * Deliberately a SHAPE check rather than a full RFC 5322 parse: the cost of
 * accepting something odd is one bounced mail, and the cost of rejecting a
 * valid address is a shop that silently never hears about its orders. What it
 * must catch is the input that is not an address at all.
 */
export function parseRecipients(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  const parts = raw.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    // One @, something either side, a dot in the domain, and no whitespace or
    // characters that would let a header be injected.
    if (!/^[^\s@<>"',;:\\]+@[^\s@<>"',;:\\]+\.[A-Za-z]{2,}$/.test(p)) continue;
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
    if (out.length >= MAX_SALE_RECIPIENTS) break;
  }
  return out;
}

/**
 * Read the settings map.
 *
 * Off by default. A CMS that started mailing an address it inferred from
 * somewhere the first time anyone bought something would be a surprise, and the
 * surprise would arrive at a real person's inbox.
 */
export function resolveSaleNotifySettings(
  map: Record<string, unknown>,
): SaleNotifySettings {
  const recipients = parseRecipients(map[SALE_NOTIFY_KEYS.recipients]);
  return {
    // Enabled AND someone to tell. A toggle that is on with an empty list is
    // not enabled, it is a shop that thinks it is being notified.
    //
    // `settingBool`, not `=== true`.
    //
    // NOT because a driver stringifies the value — that is a claim this
    // codebase repeated for a while and it is false. All three drivers store a
    // Setting as a JSON document and parse it back, so a boolean written stays
    // a boolean; I round-tripped all four combinations through lowdb, the
    // libSQL doc-blob and the relational driver to check.
    //
    // The string arrives because `POST /api/settings/update` takes arbitrary
    // JSON, and only the keys named in `BOOLEAN_KEYS` are coerced at the door.
    // An operator automating their setup — the documented way to configure an
    // install — sends `{"sale_notify_enabled": "true"}`, which is stored and
    // read back as the STRING "true". That is not `true`, so the toggle read
    // as ON in every readback and the shop was never told about a single sale.
    //
    // Both halves are fixed: this reader is lenient, and the key is now in
    // BOOLEAN_KEYS so new writes are coerced. The reader fix is the one that
    // repairs installs that already hold a string.
    enabled: settingBool(map[SALE_NOTIFY_KEYS.enabled], false) && recipients.length > 0,
    recipients,
  };
}

export interface SaleNotification {
  subject: string;
  text: string;
  html: string;
}


/**
 * Strip CR/LF from anything that lands in a header.
 *
 * A subject line is a header. An order whose number or customer name carried a
 * newline could otherwise append headers of its own — the classic mail-header
 * injection — and both of those values originate outside this system.
 */
function headerSafe(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

const PAYMENT_STATE: Record<string, string> = {
  paid: 'PAID',
  pending: 'awaiting confirmation',
  unpaid: 'NOT YET PAID',
  failed: 'payment failed',
  refunded: 'refunded',
};

/**
 * Build the message.
 *
 * Pure, so the wording and every escaping rule are testable without a mail
 * server. The subject leads with the amount and the payment state because that
 * is what a shop owner reads on a phone notification without opening anything:
 * a sale that is already paid and one that is waiting for a bank transfer need
 * different reactions.
 */
export function buildSaleNotification(
  order: Order,
  opts: { siteTitle?: string; adminUrl?: string } = {},
): SaleNotification {
  const shop = headerSafe(opts.siteTitle?.trim() || 'Your shop');
  const total = formatMoney(order.total_cents ?? 0, order.currency ?? 'EUR');
  const state = PAYMENT_STATE[order.payment_status ?? 'unpaid'] ?? String(order.payment_status);
  const number = headerSafe(String(order.number ?? '—'));

  const items = Array.isArray(order.items) ? order.items : [];
  const lines = items.map((i) => {
    const qty = Number((i as { qty?: unknown }).qty ?? 1);
    const name = String((i as { name?: unknown }).name ?? 'item');
    return { qty, name };
  });

  const method = String(order.payment_method ?? 'unknown');
  const subject = headerSafe(`${shop}: new order ${number} — ${total} (${state})`);

  const text = [
    `New order ${number}`,
    '',
    `Total:    ${total}`,
    `Payment:  ${method} — ${state}`,
    `Customer: ${order.email ?? '—'}`,
    `Placed:   ${order.created_at ?? '—'}`,
    '',
    'Items:',
    ...(lines.length ? lines.map((l) => `  ${l.qty} × ${l.name}`) : ['  (none recorded)']),
    ...(opts.adminUrl ? ['', `Open it: ${opts.adminUrl}`] : []),
    '',
    // The one line that turns a notification into an action, and the reason
    // manual methods exist at all: nobody has confirmed this money arrived.
    ...(order.payment_status === 'paid'
      ? []
      : ['This order is not marked paid. Confirm the payment before you ship it.']),
  ].join('\n');

  const html = [
    `<h2 style="margin:0 0 12px">New order ${esc(number)}</h2>`,
    '<table cellpadding="4" style="border-collapse:collapse;font-family:system-ui,sans-serif">',
    `<tr><td><strong>Total</strong></td><td>${esc(total)}</td></tr>`,
    `<tr><td><strong>Payment</strong></td><td>${esc(method)} — ${esc(state)}</td></tr>`,
    `<tr><td><strong>Customer</strong></td><td>${esc(order.email ?? '—')}</td></tr>`,
    `<tr><td><strong>Placed</strong></td><td>${esc(order.created_at ?? '—')}</td></tr>`,
    '</table>',
    '<h3 style="margin:16px 0 4px">Items</h3>',
    '<ul style="margin:0;padding-left:20px">',
    ...(lines.length
      ? lines.map((l) => `<li>${esc(l.qty)} × ${esc(l.name)}</li>`)
      : ['<li>(none recorded)</li>']),
    '</ul>',
    ...(opts.adminUrl
      ? [`<p><a href="${esc(opts.adminUrl)}">Open this order in the admin</a></p>`]
      : []),
    ...(order.payment_status === 'paid'
      ? []
      : ['<p style="color:#b91c1c"><strong>This order is not marked paid.</strong> '
        + 'Confirm the payment before you ship it.</p>']),
  ].join('');

  return { subject, text, html };
}

/* ------------------------------------------------------------------ *
 * Sending
 * ------------------------------------------------------------------ */

/**
 * Notify the owner that an order came in. Never throws, never blocks a sale.
 *
 * Deliberately takes its dependencies as arguments rather than importing them:
 * this is the only impure function in the module, and injecting the settings
 * read and the send lets the whole thing be driven in a unit test without a
 * database or a mail server. The one real caller wires the real two.
 *
 * Recipients are mailed one at a time. Putting ten shop addresses in a single
 * `to:` would show each of them to all the others, and a shop's staff list is
 * not something to publish to its own accountant.
 */
export async function notifyNewSale(
  order: Order,
  deps: {
    readSettings: () => Promise<Record<string, unknown>>;
    send: (msg: { to: string; subject: string; text: string; html?: string }) => Promise<void>;
    siteUrl?: string;
    log?: (message: string, err?: unknown) => void;
  },
): Promise<{ sent: number; skipped?: string }> {
  const log = deps.log ?? ((m: string, e?: unknown) => console.error(`[sale-notify] ${m}`, e ?? ''));

  let settings: SaleNotifySettings;
  let siteTitle: string | undefined;
  try {
    const map = await deps.readSettings();
    settings = resolveSaleNotifySettings(map);
    const t = map.site_title;
    siteTitle = typeof t === 'string' ? t : undefined;
  } catch (err) {
    log('could not read settings; no notification sent', err);
    return { sent: 0, skipped: 'settings-unreadable' };
  }

  if (!settings.enabled) return { sent: 0, skipped: 'disabled' };

  const base = (deps.siteUrl ?? '').replace(/\/+$/, '');
  const message = buildSaleNotification(order, {
    siteTitle,
    adminUrl: base && order.id ? `${base}/admin/orders?order=${encodeURIComponent(order.id)}` : undefined,
  });

  let sent = 0;
  for (const to of settings.recipients) {
    try {
      await deps.send({ to, ...message });
      sent += 1;
    } catch (err) {
      // One bad address must not cost the others their notification, and none
      // of them may cost the shop the order — which is already committed.
      log(`could not notify ${to} about order ${order.number}`, err);
    }
  }
  return { sent };
}
