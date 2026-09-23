/**
 * A printable receipt the buyer can keep (C-39, the non-fiscal half).
 *
 * ## What this is, and firmly what it is not
 *
 * It is a **commercial document**: what you bought, what it cost, what VAT was
 * inside it, and who sold it to you. A buyer is entitled to keep that, an
 * accountant can read it, and no authority has to see it.
 *
 * It is **not a fiscal invoice**, and the distinction is the whole reason this
 * shipped and the rest did not. In Greece a retail invoice is not a document
 * you generate — it is a document the tax authority issues you a MARK for,
 * through myDATA. A PDF that looks like an invoice and was never transmitted is
 * a liability with a logo on it. So this page says what it is, in the buyer's
 * language, and never numbers itself as anything fiscal.
 *
 * That track — myDATA, sequential numbering with legal meaning, credit notes —
 * stays commercial, where a per-country obligation can be maintained properly.
 *
 * ## There IS a server-side PDF, and what changed
 *
 * The original conclusion was C-152's: no server-side PDF, because it meant a
 * headless Chromium at roughly 300 MB on every self-host to produce a file the
 * browser already makes from a stylesheet. That objection was to the BROWSER,
 * not to the file, and it still stands for articles.
 *
 * A receipt is different twice over. It is a fixed table, so it needs no layout
 * engine — `receipt-pdf.ts` draws it with pdf-lib and an embedded font, and the
 * whole cost is one MIT dependency and a 750 KB TTF, not a browser. And it is a
 * file somebody KEEPS: attached to an email, filed with an accountant, uploaded
 * to an expense tool. "Open this link and press print" is not a file, and a
 * link that stops working when the shop changes host is worse than no link.
 *
 * The print rules still ship, and `/receipt?token=…` is still the page. The PDF
 * at `/receipt.pdf?token=…` is built from the same `ReceiptView` this module
 * returns, so the file and the page cannot disagree about what was bought.
 *
 * ## How a stranger is allowed to see it
 *
 * A signed token in the confirmation email they already received. Not an order
 * number and an email in a query string: those are personal data, and a URL is
 * the one part of a request that ends up in an access log, a proxy, a Referer
 * header and somebody's browser history.
 *
 * The token names ONE order and proves nothing else. It is long-lived on
 * purpose — a receipt a customer cannot open in eighteen months is not a
 * receipt — and it is refused outright for an order that has been through a
 * data-subject erasure, whatever the token says.
 */
import { signPurposeToken, verifyPurposeToken } from '../auth';
import { isErased } from './order-lookup';
import type { Order } from '../../core/models';

/**
 * Two years.
 *
 * Long, deliberately. The receipt's whole job is to still work when somebody
 * digs out the confirmation email — and the EU conformity guarantee runs two
 * years, which is exactly the window in which a buyer needs to prove what they
 * bought and when. A thirty-day link would expire before the first time most
 * people want it.
 *
 * It is not a credential for anything else: it names one order and yields a
 * read-only page. The order itself is already in the buyer's inbox.
 */
export const RECEIPT_TTL_MS = 2 * 365 * 24 * 60 * 60 * 1000;

/** A link for ONE order. Its own purpose, so no other token can be replayed as one. */
export function makeReceiptToken(orderId: string): string {
  return signPurposeToken('receipt', { oid: String(orderId) }, RECEIPT_TTL_MS);
}

/** The order id a receipt token names, or null. Never throws. */
export function readReceiptToken(token: string | undefined | null): string | null {
  const payload = verifyPurposeToken('receipt', token);
  const id = payload?.oid;
  return typeof id === 'string' && id.length > 0 && id.length <= 200 ? id : null;
}

/** The absolute link that goes in the confirmation email. */
export function receiptUrl(origin: string, orderId: string): string {
  return `${origin.replace(/\/$/, '')}/receipt?token=${encodeURIComponent(makeReceiptToken(orderId))}`;
}

export interface ReceiptLine {
  name: string;
  qty: number;
  /** Already formatted for display. */
  total: string;
  /** "24%", when the order stored a per-line breakdown. Else null. */
  vatRate: string | null;
  /** The variation bought, e.g. "Colour: Black · Size: M". Empty when simple. */
  options: string;
}

export interface ReceiptView {
  number: string;
  date: string;
  lines: ReceiptLine[];
  subtotal: string | null;
  discount: string | null;
  shipping: string | null;
  tax: string | null;
  total: string;
  /** True when the shop's prices already contained the VAT. */
  taxIncluded: boolean;
  /** True when the VAT total covers shipping as well as the goods. */
  taxCoversShipping: boolean;
  paymentMethod: string;
  /**
   * `unknown` is a real answer, not a missing one.
   *
   * An order can carry no `payment_status` at all — the seeded and
   * operator-entered ones do. Reading absence as "unpaid" printed **Not yet
   * paid** across the bottom of a receipt for a COMPLETED order, which is a
   * false statement to a customer and a misleading one to their accountant.
   * The receipt now says nothing rather than something it cannot know.
   */
  paymentState: 'paid' | 'unpaid' | 'unknown';
}

/**
 * May this order be shown as a receipt?
 *
 * Erasure is the interesting case: the token is still signed and still names a
 * real order, and the answer is still no. The person asked to be erased, and a
 * link in an old email is not a reason to serve their basket back.
 */
export function receiptIsAvailable(order: Order | null | undefined): boolean {
  if (!order) return false;
  if (isErased(order)) return false;
  // A cancelled order is not a purchase, and a receipt for one would be a
  // document saying somebody bought something they did not.
  return order.status !== 'cancelled';
}

/**
 * The view, from the order and a money formatter.
 *
 * The formatter is INJECTED rather than imported so this stays pure and its
 * test can state the numbers exactly — and so the page can pass the shop's own
 * currency without this module reading settings.
 *
 * ## Why there is no VAT-analysis-by-rate table
 *
 * It is the obvious thing to want, an accountant would use it, and the data
 * looks like it is there: `line_totals` carries `tax_rate_bp` and `tax_cents`
 * per line. It is not there. `tax_cents` on the order is
 * `goods tax + shipping tax` (see totals.ts), and `shipping_tax_cents` is
 * NEVER STORED on the order — it exists only inside the totals calculation.
 *
 * So a per-rate table built from the lines would not add up to the VAT total
 * printed underneath it on every order with taxed shipping. A receipt whose own
 * numbers disagree is worse than one that says less, because the reader cannot
 * tell which half is wrong.
 *
 * What is shown instead is per-line RATE — true per line, and the part that
 * actually varies — with a single reconciling VAT total. Restoring the table
 * means persisting `shipping_tax_cents` on the order first.
 */
export function receiptView(
  order: Order,
  formatMoney: (cents: number) => string,
): ReceiptView {
  const items = Array.isArray(order.items) ? order.items : [];
  const breakdown = Array.isArray(order.line_totals) ? order.line_totals : [];
  return {
    number: String(order.number ?? order.id ?? '—'),
    date: String(order.created_at ?? '').slice(0, 10),
    lines: items.map((line, i) => {
      // `total_cents` on a line IS the line total, and it is required — there is
      // no unit price to multiply and no fallback to invent. An earlier draft
      // here fell back to a `price_cents` field that does not exist on the
      // model, which would have quietly printed 0,00 for every line.
      const cents = Number(line.total_cents) || 0;
      // Positional, because that is how `line_totals` is built (one per line, in
      // order) — but only trusted when the name agrees, so a mismatched or
      // partial breakdown shows no rate rather than the wrong line's rate.
      const b = breakdown[i];
      const rate = b && b.name === line.name && typeof b.tax_rate_bp === 'number'
        ? `${Math.round(b.tax_rate_bp / 100)}%`
        : null;
      return {
        name: String(line.name ?? 'item'),
        qty: Number(line.qty ?? 1) || 1,
        total: formatMoney(cents),
        vatRate: rate,
        // Frozen at purchase, so this is what they actually ordered.
        options: Object.entries(line.variant_options ?? {})
          .map(([k, v]) => `${k}: ${v}`).join(' · '),
      };
    }),
    // Shown only when they carry information. A "Discount: 0,00" row on every
    // receipt is noise that makes the one real discount harder to see.
    subtotal: typeof order.subtotal_cents === 'number' ? formatMoney(order.subtotal_cents) : null,
    discount: order.discount_cents ? formatMoney(order.discount_cents) : null,
    shipping: typeof order.shipping_cents === 'number' && order.shipping_cents > 0
      ? formatMoney(order.shipping_cents) : null,
    tax: typeof order.tax_cents === 'number' ? formatMoney(order.tax_cents) : null,
    total: formatMoney(order.total_cents ?? 0),
    taxIncluded: order.prices_include_tax === true,
    taxCoversShipping: typeof order.shipping_cents === 'number' && order.shipping_cents > 0,
    paymentMethod: String(order.payment_method ?? ''),
    paymentState: order.payment_status === 'paid' ? 'paid'
      : order.payment_status ? 'unpaid'
        : 'unknown',
  };
}
