/**
 * Money on the page. The CMS stores and sends integer MINOR units in the shop's
 * currency; this only formats. It never adds anything up — every total a buyer
 * sees comes from the CMS quote, so the page and the order cannot disagree.
 *
 * The minor-unit tables match the CMS's own (src/lib/money-format.ts): a
 * currency with no minor unit is sent as whole units, and the dinars below are
 * sent in thousandths. Getting this wrong shows a Hungarian shop's prices a
 * hundred times too small, or a Kuwaiti one's ten times too large.
 */

const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'HUF', 'XOF', 'XAF', 'XPF']);
const THREE_DECIMAL = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);

/** How many minor units make one whole unit. */
export function minorUnits(currency: string): number {
  if (ZERO_DECIMAL.has(currency)) return 1;
  if (THREE_DECIMAL.has(currency)) return 1000;
  return 100;
}

export function formatMoney(minor: number, currency: string, locale = 'en'): string {
  const code = /^[A-Z]{3}$/.test(currency) ? currency : 'EUR';
  const per = minorUnits(code);
  const digits = per === 1 ? 0 : per === 1000 ? 3 : 2;
  const amount = minor / per;
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency', currency: code, minimumFractionDigits: digits, maximumFractionDigits: digits,
    }).format(amount);
  } catch {
    return `${amount.toFixed(digits)} ${code}`;
  }
}
