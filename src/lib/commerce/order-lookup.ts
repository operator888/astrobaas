/**
 * Proving a stranger owns an order.
 *
 * ## One rule, because the wrong shape is an oracle
 *
 * A caller gives an order NUMBER and an EMAIL. Either both match a stored order
 * or they do not, and the caller is told the same thing in both cases.
 *
 * The comment on the one inline copy this replaces states why, and it is worth
 * repeating because it is the whole design: telling "no such order" apart from
 * "wrong email" turns the endpoint into an order-number oracle — a script walks
 * the number space and learns exactly which orders exist and how many a shop
 * takes a day.
 *
 * ## Why this is a module and not an inline check
 *
 * Two more callers arrived at once: the verified-buyer stamp on a product
 * review (C-35), and the receipt lookup. Three copies of a rule whose failure
 * mode is silent leakage is three chances to write the friendly version of the
 * error message.
 */
import type { Order } from '../../core/models';

/**
 * The order, or `null` — and `null` means BOTH "no such number" and "that is
 * not the address that placed it". Callers must not distinguish them.
 *
 * The email comparison is case-insensitive and trimmed: an address typed into
 * a form on a phone arrives with different capitalisation than the one typed at
 * checkout on a laptop, and refusing that is refusing the actual customer.
 */
export function findOrderForEmail(
  orders: readonly Order[],
  orderNumber: unknown,
  email: unknown,
): Order | null {
  const number = typeof orderNumber === 'string' ? orderNumber.trim() : '';
  const addr = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!number || !addr) return null;
  const found = orders.find((o) => String(o.number) === number);
  if (!found) return null;
  // AN ERASED ORDER IS NOT REACHABLE, whatever address is offered.
  //
  // The address on an erased order is a token this software wrote, not one the
  // buyer chose — so matching against it is matching against ourselves. When
  // that token was a shared constant (`erased@erased.invalid`, in a public
  // repository) it was a published credential: the constant plus an order
  // number returned somebody's erased order, which still carries the basket and
  // the total.
  //
  // The token is per-order now, and this check makes that belt-and-braces: even
  // a leaked token opens nothing. A person who asked to be erased has asked not
  // to be looked up.
  if (isErased(found)) return null;
  return String(found.email ?? '').trim().toLowerCase() === addr ? found : null;
}

/** Has this order been through a data-subject erasure? */
export function isErased(order: unknown): boolean {
  return typeof (order as { erased_at?: unknown } | null)?.erased_at === 'string';
}

/**
 * Did this address buy this product? — the verified-buyer test (C-35).
 *
 * `verified_buyer` is the only field on a review that means anything on its
 * own: a rating without it is a stranger's opinion, and a shop that shows stars
 * without distinguishing the two is asking search engines to repeat a number it
 * cannot stand behind.
 *
 * Any order the address placed counts, not only the one the reviewer named —
 * somebody who bought the frames in March and reviews them in June should not
 * have to find the order number to be believed. The named order, when given,
 * only has to be theirs.
 */
export function boughtProduct(
  orders: readonly Order[],
  email: unknown,
  productId: unknown,
): boolean {
  const addr = typeof email === 'string' ? email.trim().toLowerCase() : '';
  const pid = typeof productId === 'string' ? productId : '';
  if (!addr || !pid) return false;
  return orders.some((o) => {
    // Same rule as the lookup above: an erased order proves nothing about
    // anybody. With a shared placeholder address this was worse than a leak —
    // that one constant plus any product an erased customer had ever bought
    // stamped a review as a VERIFIED purchase.
    if (isErased(o)) return false;
    if (String(o.email ?? '').trim().toLowerCase() !== addr) return false;
    // An unpaid order is not a purchase. Somebody who put a product in a basket
    // and never paid is not a verified buyer, and treating them as one is the
    // cheapest way to fake a verified review.
    if ((o.payment_status ?? 'unpaid') !== 'paid') return false;
    const items = Array.isArray(o.items) ? o.items : [];
    return items.some((i) => String((i as { product_id?: unknown }).product_id ?? '') === pid);
  });
}
