/**
 * How a line's priced add-ons (`OrderItem.addons`) are SHOWN.
 *
 * Pure and dependency-free, so the receipt, its PDF, the confirmation email
 * and the admin order list can all use it and print the same thing.
 */

export interface ReceiptAddon {
  label: string;
  /** Unit price × the line's qty, formatted. */
  amount: string;
}

/**
 * The add-ons frozen on a line, for display. Shared by the receipt, the PDF,
 * the confirmation email and the admin order list, so all four print the same
 * thing. Anything that is not a well-formed add-on is skipped, never printed
 * as 0: a stored order is data, and an old or hand-edited one may be odd.
 */
export function lineAddonsForDisplay(
  line: { addons?: unknown; qty?: unknown },
  formatMoney: (cents: number) => string,
): ReceiptAddon[] {
  if (!Array.isArray(line.addons)) return [];
  const qty = Number(line.qty ?? 1) || 1;
  const out: ReceiptAddon[] = [];
  for (const a of line.addons as unknown[]) {
    if (!a || typeof a !== 'object') continue;
    const r = a as { label?: unknown; unit_price_cents?: unknown };
    const label = typeof r.label === 'string' ? r.label.trim() : '';
    const cents = r.unit_price_cents;
    if (!label || typeof cents !== 'number' || !Number.isInteger(cents)) continue;
    out.push({ label, amount: formatMoney(cents * qty) });
  }
  return out;
}
