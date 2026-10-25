import { escapeHtml, escapeXml as sharedEscapeXml } from '../../../lib/escape-html';

/**
 * Formatting and parsing helpers shared by PDFs, exports and the admin.
 * Pure. Dates are ISO `YYYY-MM-DD` strings throughout — never Date objects
 * stored, because a Date carries a time zone and an invoice date does not.
 */

export function formatMoney(cents: number, currency = 'EUR', lang: 'de' | 'en' = 'de'): string {
  return new Intl.NumberFormat(lang === 'de' ? 'de-DE' : 'en-IE', {
    style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(cents / 100);
}

/** "1.234,50" (de) / "1,234.50" (en), no currency sign. */
export function formatAmount(cents: number, lang: 'de' | 'en' = 'de'): string {
  return new Intl.NumberFormat(lang === 'de' ? 'de-DE' : 'en-IE', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(cents / 100);
}

export function formatQty(q: number, lang: 'de' | 'en' = 'de'): string {
  return new Intl.NumberFormat(lang === 'de' ? 'de-DE' : 'en-IE', { maximumFractionDigits: 3 }).format(q);
}

export function formatDate(iso: string | undefined, lang: 'de' | 'en' = 'de'): string {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-');
  if (!y || !m || !d) return iso;
  return lang === 'de' ? `${d}.${m}.${y}` : `${d}/${m}/${y}`;
}

/**
 * Parse a human amount into cents: "1.234,56", "1234.56", "1,234.56", "-12,5",
 * "12 €". Returns null when it is not a number — never guesses.
 */
export function parseAmountToCents(input: unknown): number | null {
  if (typeof input === 'number') return Number.isFinite(input) ? Math.round(input * 100) : null;
  if (typeof input !== 'string') return null;
  let s = input.replace(/[\s€$£]|EUR/gi, '').trim();
  if (!s) return null;
  const neg = s.startsWith('-') || (s.startsWith('(') && s.endsWith(')'));
  s = s.replace(/^[-+(]|\)$/g, '');
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > lastDot) {
    // Comma is the decimal separator.
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (lastDot > lastComma && lastComma !== -1) {
    s = s.replace(/,/g, '');
  } else if (lastComma === -1 && (s.match(/\./g) || []).length > 1) {
    s = s.replace(/\./g, '');
  } else if (lastComma === -1 && /^\d{1,3}\.\d{3}$/.test(s)) {
    // "1.500" is one thousand five hundred to a German reader. Typed amounts
    // never carry three decimals, so the German reading is the safe one.
    s = s.replace('.', '');
  }
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const cents = Math.round(Number(s) * 100);
  return neg ? -cents : cents;
}

/**
 * A machine decimal ("1190.00", "-5.5", "0.125") — XML and camt amounts,
 * where the point is always the decimal separator. Never use
 * parseAmountToCents for these: it reads "1.500" the German way.
 */
export function decimalToCents(input: string): number | null {
  const s = input.trim();
  if (!/^[+-]?\d+(\.\d+)?$/.test(s)) return null;
  return Math.round(Number(s) * 100);
}

/** Parse a date in ISO, German (13.10.2026 / 13.10.26) or YYYYMMDD form. */
export function parseDate(input: unknown): string | null {
  const iso = parseDateLoose(input);
  if (!iso) return null;
  // Reject impossible calendar dates (31.02., month 13): they would reach a
  // finalized invoice, or make date arithmetic throw later on.
  const [y, mo, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (y < 1900 || y > 2999 || dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return iso;
}

function parseDateLoose(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})$/);
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

export function todayIso(now: Date = new Date(), tz = 'Europe/Berlin'): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function addMonths(iso: string, months: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1, 12));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0, 12)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}

/**
 * `months` after `iso`, landing on `day` of that month — or its last day when
 * the month is shorter. Unlike chaining addMonths, a schedule anchored on the
 * 31st goes Jan 31 → Feb 28 → Mar 31, not Mar 28.
 */
export function addMonthsAnchored(iso: string, months: number, day: number): string {
  const [y, m] = iso.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1, 12));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0, 12)).getUTCDate();
  target.setUTCDate(Math.min(Math.max(1, day), last));
  return target.toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);
}

export { escapeHtml };

/**
 * The shared XML escaper, after removing the control characters XML 1.0
 * forbids outright — a stray \u0007 pasted into a line description would
 * otherwise make the whole e-invoice unparseable.
 */
export function escapeXml(v: unknown): string {
  // eslint-disable-next-line no-control-regex
  return sharedEscapeXml(String(v ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ''));
}

/** Cents as a plain decimal string for XML: 119000 → "1190.00". */
export function centsToDecimal(cents: number): string {
  const neg = cents < 0;
  const abs = Math.abs(Math.round(cents));
  const s = `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
  return neg ? `-${s}` : s;
}

/**
 * The seller's name as it must appear on an invoice: the registered name WITH
 * its legal form (§ 14 Abs. 4 Nr. 1 UStG, § 35a GmbHG). A company is often
 * typed in two fields — "Dimitriou eCommerceWebServices UG" and "UG
 * (haftungsbeschränkt)" — and simply joining them printed the form twice.
 * Where the name already ends in the form's abbreviation, only the rest of the
 * form ("(haftungsbeschränkt)") is added.
 */
export function legalName(co: { name?: string; legal_form?: string }): string {
  const name = (co.name ?? '').trim();
  const form = (co.legal_form ?? '').trim();
  if (!form) return name;
  const squash = (v: string) => v.toLowerCase().replace(/\s+/g, ' ');
  if (squash(name).includes(squash(form))) return name;
  const m = form.match(/^(\S+)(\s+.*)?$/);
  const abbr = m?.[1] ?? form;
  const rest = (m?.[2] ?? '').trim();
  const endsWithAbbr = squash(name).endsWith(` ${squash(abbr)}`) || squash(name) === squash(abbr);
  if (endsWithAbbr) return rest ? `${name} ${rest}` : name;
  return `${name} ${form}`;
}

export function contactDisplayName(c: { kind?: string; company_name?: string; first_name?: string; last_name?: string }): string {
  if (c.company_name) return c.company_name;
  return [c.first_name, c.last_name].filter(Boolean).join(' ').trim() || '—';
}
