/**
 * Categories and their DATEV accounts (SKR03 / SKR04).
 *
 * The numbers are the standard-chart accounts as commonly used; a
 * Steuerberater may prefer others, which is what `account_overrides` in the
 * module settings is for. Every number used in an export goes through
 * `accountFor`, so an override applies everywhere at once.
 *
 * `automatic` marks DATEV Automatikkonten: book the GROSS amount against them
 * with an empty BU key and DATEV splits the tax out itself. Putting a tax key
 * on an automatic account double-counts the VAT, so the exporter must know.
 */
import type { ChartOfAccounts, TaxTreatment } from './types';

export interface AccountDef {
  SKR03: number;
  SKR04: number;
  automatic?: boolean;
}

export interface ExpenseCategory {
  key: string;
  de: string;
  en: string;
  account: AccountDef;
  default_rate: number;
  /** Only a share of the input tax / cost is deductible (Bewirtung: 70 %). */
  note?: string;
}

export const EXPENSE_CATEGORIES: readonly ExpenseCategory[] = [
  { key: 'software', de: 'Software & SaaS-Abos', en: 'Software & SaaS', account: { SKR03: 4806, SKR04: 6495 }, default_rate: 19 },
  { key: 'hosting', de: 'Hosting & Server', en: 'Hosting & servers', account: { SKR03: 4806, SKR04: 6495 }, default_rate: 19 },
  { key: 'subcontractors', de: 'Fremdleistungen', en: 'Subcontractors', account: { SKR03: 3100, SKR04: 5900 }, default_rate: 19 },
  { key: 'phone', de: 'Telefon', en: 'Telephone', account: { SKR03: 4920, SKR04: 6805 }, default_rate: 19 },
  { key: 'internet', de: 'Internet', en: 'Internet', account: { SKR03: 4925, SKR04: 6810 }, default_rate: 19 },
  { key: 'office', de: 'Bürobedarf', en: 'Office supplies', account: { SKR03: 4930, SKR04: 6815 }, default_rate: 19 },
  { key: 'literature', de: 'Fachliteratur & Weiterbildung', en: 'Books & training', account: { SKR03: 4940, SKR04: 6820 }, default_rate: 7 },
  { key: 'advertising', de: 'Werbung & Marketing', en: 'Advertising & marketing', account: { SKR03: 4600, SKR04: 6600 }, default_rate: 19 },
  { key: 'entertainment', de: 'Bewirtung', en: 'Business meals', account: { SKR03: 4650, SKR04: 6640 }, default_rate: 19, note: 'Only 70 % of the cost is deductible; input VAT 100 % with a proper receipt.' },
  { key: 'travel', de: 'Reisekosten', en: 'Travel', account: { SKR03: 4670, SKR04: 6670 }, default_rate: 19 },
  { key: 'vehicle', de: 'Kfz-Kosten', en: 'Vehicle costs', account: { SKR03: 4530, SKR04: 6530 }, default_rate: 19 },
  { key: 'consulting', de: 'Rechts- & Beratungskosten', en: 'Legal & consulting', account: { SKR03: 4950, SKR04: 6825 }, default_rate: 19 },
  { key: 'bookkeeping', de: 'Buchführung & Steuerberatung', en: 'Bookkeeping & tax advice', account: { SKR03: 4955, SKR04: 6830 }, default_rate: 19 },
  { key: 'bank_fees', de: 'Nebenkosten des Geldverkehrs', en: 'Bank fees', account: { SKR03: 4970, SKR04: 6855 }, default_rate: 0 },
  { key: 'other', de: 'Sonstige Kosten', en: 'Other costs', account: { SKR03: 4900, SKR04: 6300 }, default_rate: 19 },
];

export function categoryByKey(key: string | undefined): ExpenseCategory {
  return EXPENSE_CATEGORIES.find((c) => c.key === key) ?? EXPENSE_CATEGORIES[EXPENSE_CATEGORIES.length - 1];
}

/** Revenue accounts by treatment and rate. All Automatikkonten. */
export const REVENUE_ACCOUNTS: Record<string, AccountDef> = {
  'domestic:19': { SKR03: 8400, SKR04: 4400, automatic: true },
  'domestic:7': { SKR03: 8300, SKR04: 4300, automatic: true },
  'domestic:0': { SKR03: 8200, SKR04: 4200 },
  // 2026 charts; older charts used 8195 / 4185 — override `rev:small_business` if yours does.
  small_business: { SKR03: 8192, SKR04: 4184, automatic: true },
  reverse_charge_eu: { SKR03: 8336, SKR04: 4336, automatic: true },
  intra_community_supply: { SKR03: 8125, SKR04: 4125, automatic: true },
  third_country_service: { SKR03: 8338, SKR04: 4338, automatic: true },
  export: { SKR03: 8120, SKR04: 4120, automatic: true },
  // Gewährte Skonti — revenue reductions; 19 % / 7 % are Automatikkonten.
  'discount:19': { SKR03: 8736, SKR04: 4736, automatic: true },
  'discount:7': { SKR03: 8731, SKR04: 4731, automatic: true },
  'discount:0': { SKR03: 8730, SKR04: 4730 },
};

export const LEDGER: Record<string, AccountDef> = {
  bank: { SKR03: 1200, SKR04: 1800 },
  cash: { SKR03: 1000, SKR04: 1600 },
  transit: { SKR03: 1360, SKR04: 1460 },
  receivables: { SKR03: 1400, SKR04: 1200 },
  payables: { SKR03: 1600, SKR04: 3300 },
  /** Fallback personal accounts when personal accounts are off. */
  debitor_default: { SKR03: 10000, SKR04: 10000 },
  kreditor_default: { SKR03: 70000, SKR04: 70000 },
};

export function revenueKey(t: TaxTreatment, rate: number): string {
  return t === 'domestic' ? `domestic:${rate}` : t;
}

/**
 * The account for a purpose under a chart, honouring overrides. Override keys
 * are the same strings: `rev:domestic:19`, `exp:software`, `ledger:bank`.
 */
export function accountFor(
  kind: 'rev' | 'exp' | 'ledger',
  key: string,
  chart: ChartOfAccounts,
  overrides: Record<string, number> = {},
): { account: number; automatic: boolean } {
  const ov = overrides[`${kind}:${key}`];
  const def = kind === 'rev' ? REVENUE_ACCOUNTS[key]
    : kind === 'exp' ? categoryByKey(key).account
      : LEDGER[key];
  if (Number.isInteger(ov) && ov > 0) return { account: ov, automatic: !!def?.automatic };
  if (!def) throw new Error(`No account defined for ${kind}:${key}`);
  return { account: def[chart], automatic: !!def.automatic };
}

/**
 * DATEV BU keys (Steuerschlüssel) for posting gross amounts to a NON-automatic
 * expense account. 9 = 19 % input tax, 8 = 7 % input tax.
 *
 * §13b purchases (reverse charge received): key 94 is the common choice for
 * "services from an EU business, 19 % input tax and 19 % VAT" — but DATEV's
 * key semantics have changed over the years, so this is flagged in the export
 * notes and is overridable as `bu:rc19`.
 */
export function inputTaxKey(rate: number, reverseCharge: boolean, overrides: Record<string, number> = {}): string {
  if (reverseCharge) return String(overrides['bu:rc19'] ?? 94);
  if (rate === 19) return '9';
  if (rate === 7) return '8';
  return '';
}
