/**
 * AstroBaaS shop orders → invoices.
 *
 * Pure mapping from a completed order to the same "sale" payload every other
 * integration sends, so the shop gets no special path through the service:
 * same idempotency (source "shop" + order id), same contact matching, same
 * finalize-and-mark-paid.
 *
 * Amounts come from the order's frozen line breakdown — the prices the buyer
 * actually agreed to — never from the current catalogue.
 */
import type { Order } from '../../../core/models';

export function orderToSale(order: Order): Record<string, unknown> | null {
  const lines = order.line_totals ?? [];
  if (!lines.length) return null;
  const out: Record<string, unknown>[] = [];
  let sumLines = 0;
  for (const l of lines) {
    const rate = Math.round((l.tax_rate_bp ?? 0) / 100);
    const qty = l.qty || 1;
    sumLines += l.total_cents;
    if (l.total_cents % qty === 0) {
      out.push({ name: l.name, quantity: qty, unit: 'C62', unit_price_cents: l.total_cents / qty, tax_rate: rate });
    } else {
      out.push({ name: `${qty} × ${l.name}`, quantity: 1, unit: 'C62', unit_price_cents: l.total_cents, tax_rate: rate });
    }
  }
  // Whatever the order total holds beyond its lines is shipping (gross).
  const shipping = order.total_cents - sumLines;
  if (shipping > 0) {
    const tax = order.shipping_tax_cents ?? 0;
    const net = shipping - tax;
    const raw = net > 0 ? (tax * 100) / net : 0;
    const rate = [19, 7, 0].reduce((best, r) => (Math.abs(r - raw) < Math.abs(best - raw) ? r : best), 19);
    out.push({ name: order.shipping_method_name ? `Versand (${order.shipping_method_name})` : 'Versand', quantity: 1, unit: 'LS', unit_price_cents: shipping, tax_rate: tax ? rate : 0 });
  }
  const treatments = new Set(lines.map((l) => l.tax_treatment ?? 'domestic'));
  // The shop sells goods: an EU business buyer is an intra-Community supply
  // (§4 Nr. 1b), not a §13b service. A 'destination' line is OSS, which the
  // module does not support yet — finalize refuses its foreign rate loudly.
  const tax_treatment = treatments.has('reverse-charge') ? 'intra_community_supply' : treatments.has('export') ? 'export' : 'domestic';
  const a = order.billing_address ?? order.shipping_address ?? {};
  const [first, ...rest] = String(order.name ?? a.name ?? '').trim().split(/\s+/);
  return {
    source: 'shop',
    external_id: order.id,
    price_mode: 'gross',
    tax_treatment,
    currency: order.currency,
    title: undefined,
    customer: {
      external_id: order.customer_id,
      company_name: a.company,
      first_name: a.company ? undefined : first,
      last_name: a.company ? undefined : rest.join(' ') || first,
      name: order.name,
      email: order.email,
      phone: order.phone ?? a.phone,
      vat_id: a.tax_id,
      address: { street: [a.line1, a.line2].filter(Boolean).join(', '), zip: a.postcode, city: a.city, country: (a.country ?? 'DE').toUpperCase().slice(0, 2) },
    },
    lines: out,
    paid: { amount_cents: order.total_cents, method: order.payment_provider === 'stripe' ? 'stripe' : order.payment_provider === 'paypal' ? 'paypal' : 'other', reference: order.payment_reference ?? order.number },
    intro: `Ihre Bestellung ${order.number}`,
  };
}
