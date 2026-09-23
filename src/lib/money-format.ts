/**
 * Rendering money — the one implementation.
 *
 * ## Why this file exists
 *
 * Five admin screens each carried
 * `(cents / 100).toLocaleString('el-GR', { style: 'currency', currency: 'EUR' })`,
 * and `formatMoney` in `commerce/sale-notify.ts` produced a *different* string
 * (`€89.00` against `89,00 €`). So the sale email and the orders screen stated
 * the same total two ways, and every new screen made it six.
 *
 * The el-GR hardcode was also wrong on its own terms: this CMS ships in three
 * languages and its shop can be configured in any currency.
 *
 * ## The locale is derived, never hardcoded
 *
 * A currency's conventional formatting belongs to the READER's locale, not to
 * the shop's. €89.00 and 89,00 € are the same amount written for two different
 * people. So the caller passes the locale it already has — `Astro.locals.locale`
 * on a page, `defaultLocale()` in an email — and gets the right one.
 *
 * ## Cents are integers, everywhere
 *
 * Every stored amount in this codebase is an integer number of minor units, and
 * this module never returns a number — only a string for display. That is
 * deliberate: the moment a formatted value can be parsed back, someone
 * round-trips a total through a locale and loses a cent.
 */

/** Shops that price in a currency with no minor unit. Dividing by 100 there is wrong. */
const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'HUF', 'XOF', 'XAF', 'XPF']);

/**
 * The currencies with THREE decimal places.
 *
 * This list is the half that was missing. `minorUnits` could previously answer
 * only 1 or 100, so a shop pricing in Bahraini dinar stored 1000 fils and
 * displayed "10.00 BHD" — off by a factor of ten, silently, in the direction
 * that under-charges. ISO 4217 has exactly these at exponent 3, and it is a
 * short, stable list rather than a dataset to maintain.
 */
const THREE_DECIMAL = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);

/** Fallback when the shop has not said. Both live shops are in the euro area. */
export const DEFAULT_CURRENCY = 'EUR';

/**
 * How many minor units make one major unit of this currency.
 *
 * Exported because it is no longer only a formatting concern: converting a
 * price between currencies has to know both exponents, and a second copy of
 * this table living in the converter is the drift this codebase keeps paying
 * for. One table, two readers.
 */
export function minorUnits(currency: string): number {
  const c = String(currency || '').toUpperCase();
  if (ZERO_DECIMAL.has(c)) return 1;
  if (THREE_DECIMAL.has(c)) return 1000;
  return 100;
}

/** Decimal places for this currency: 0, 2 or 3. */
export function currencyExponent(currency: string): number {
  const u = minorUnits(currency);
  return u === 1 ? 0 : u === 1000 ? 3 : 2;
}

export interface MoneyOptions {
  /** ISO 4217, e.g. `EUR`. Falls back to `DEFAULT_CURRENCY`. */
  currency?: string | null;
  /** BCP-47 tag of the READER. Falls back to the site default. */
  locale?: string | null;
}

/**
 * An integer number of minor units, as a string for a person to read.
 *
 * Never throws: an unusable currency or locale falls back rather than taking a
 * page down over a formatting call. A shop that stored `currency: "€"` instead
 * of `"EUR"` should see a slightly wrong symbol, not a 500.
 */
export function formatMoney(cents: unknown, opts: MoneyOptions = {}): string {
  const n = Number(cents);
  const amount = Number.isFinite(n) ? n : 0;
  const currency = String(opts.currency || DEFAULT_CURRENCY).toUpperCase();
  const locale = opts.locale || undefined;
  const value = amount / minorUnits(currency);
  try {
    return value.toLocaleString(locale, { style: 'currency', currency });
  } catch {
    try {
      // A bad LOCALE is much more likely than a bad currency — it comes from a
      // URL prefix. Retry with the runtime default before giving up on symbols.
      return value.toLocaleString(undefined, { style: 'currency', currency });
    } catch {
      return `${value.toFixed(currencyExponent(currency))} ${currency}`;
    }
  }
}

/**
 * The amount alone, no symbol — for a CSV column or an input's value.
 *
 * Grouping separators are omitted deliberately: a spreadsheet reading `1.234,56`
 * as a currency string is a support ticket, and a CSV is read by software before
 * it is read by a person.
 */
export function moneyPlain(cents: unknown, currency: string = DEFAULT_CURRENCY): string {
  const n = Number(cents);
  const cur = String(currency).toUpperCase();
  const units = minorUnits(cur);
  return (Number.isFinite(n) ? n / units : 0).toFixed(currencyExponent(cur));
}
