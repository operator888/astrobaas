/**
 * Money that arrived for an order the shop had already cancelled.
 *
 * The payment hold and the abandonment sweep cancel unpaid orders and put
 * their stock back on sale. A provider page can outlive them — PayPal's order
 * stays payable for hours, Klarna's for most of two days — and a buyer who
 * pays there is charged for an order that no longer exists. applyVerifiedEvent
 * first tries to reopen the order and take its stock again; when the stock has
 * been sold meanwhile, the order stays cancelled, is marked `needs_refund`,
 * and the OWNER is told by email, because this is money that has to go back
 * and nothing else in the admin would make them look.
 *
 * Recipients: the sale-notification list when one is configured (whether or
 * not per-sale emails are switched on — this is not a sale notification, it is
 * a problem), else the operator's `admin_email`. A shop with neither gets the
 * admin flag and the audit entry only.
 *
 * The builder is pure; `notifyNeedsRefund` is the thin wiring.
 */
import type { Order } from '../../core/models';
import { formatMoney, parseRecipients, SALE_NOTIFY_KEYS } from '../commerce/sale-notify';

/** Strip CR/LF from anything that lands in a header. */
const headerSafe = (v: string) => v.replace(/[\r\n]+/g, ' ').trim();

export function needsRefundRecipients(settings: Record<string, unknown>): string[] {
  const listed = parseRecipients(settings[SALE_NOTIFY_KEYS.recipients]);
  if (listed.length) return listed;
  return parseRecipients(settings.admin_email);
}

export function buildNeedsRefundNotice(
  order: Pick<Order, 'id' | 'number' | 'total_cents' | 'currency' | 'payment_provider'>,
  opts: { siteTitle?: string; adminUrl?: string } = {},
): { subject: string; text: string } {
  const shop = headerSafe(opts.siteTitle?.trim() || 'Your shop');
  const number = headerSafe(String(order.number ?? order.id));
  const amount = formatMoney(order.total_cents ?? 0, order.currency ?? 'EUR');
  const lines = [
    `Order ${number} was PAID (${amount}${order.payment_provider ? ` via ${order.payment_provider}` : ''}) after it had been cancelled,`,
    'and its items have since been sold, so it could not be reopened.',
    '',
    'Nothing will be shipped for it. Refund the payment, or restock the items and reopen the order.',
  ];
  if (opts.adminUrl) lines.push('', opts.adminUrl);
  return {
    subject: `${shop} — action needed: order ${number} was paid after it was cancelled`,
    text: lines.join('\n'),
  };
}

/** Tell the owner. Never throws: the payment itself has already been recorded. */
export async function notifyNeedsRefund(order: Order): Promise<void> {
  try {
    const { LocalDB } = await import('../localdb');
    const { sendEmail } = await import('../email');
    const rows = await LocalDB.getSettings();
    const settings: Record<string, unknown> = {};
    for (const r of rows) settings[r.key] = r.value;
    const recipients = needsRefundRecipients(settings);
    if (!recipients.length) return;
    const base = typeof settings.public_site_url === 'string' && settings.public_site_url.trim()
      ? settings.public_site_url.trim().replace(/\/+$/, '')
      : (process.env.SITE_URL ?? '').replace(/\/+$/, '');
    const notice = buildNeedsRefundNotice(order, {
      siteTitle: typeof settings.site_title === 'string' ? settings.site_title : undefined,
      adminUrl: base ? `${base}/admin/orders?order=${encodeURIComponent(order.id)}` : undefined,
    });
    for (const to of recipients) {
      await sendEmail({ to, ...notice }).catch((err) => {
        console.error(`[payments] could not tell ${to} that order ${order.number} needs a refund:`, err instanceof Error ? err.message : err);
      });
    }
  } catch (err) {
    console.error('[payments] needs-refund notice failed:', err instanceof Error ? err.message : err);
  }
}
