/**
 * VAT: which treatment a document gets, and what its totals are.
 *
 * Pure — no storage, no clock. Everything that prints, exports or reports an
 * amount calls `computeTotals`, so the PDF, the e-invoice XML, the VAT return
 * and the DATEV export cannot disagree by a cent.
 *
 * ## Rounding follows EN 16931, not intuition
 *
 * Line net amounts are rounded per line. VAT is then computed ONCE per
 * (category, rate) group on the SUM of those line nets — never per line and
 * summed. That is what the e-invoice validators check (BR-CO-17, BR-S-08/09),
 * and per-line VAT drifts a cent on any invoice with a few lines.
 *
 * In gross mode the entered unit price includes VAT: the line net is derived
 * per line (gross·100/(100+rate), rounded), then the same group rule applies.
 * The gross total can therefore differ from the sum of the typed gross prices
 * by a cent — the alternative is an XML that fails validation.
 */
import type {
  CompanyProfile, DocumentTotals, LineItem, TaxGroup, TaxTreatment, VatCategory,
} from './types';

/** EU member states (alpha-2). Greece is "GR" in ISO but "EL" in VAT ids. */
export const EU_COUNTRIES = new Set([
  'AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'HU',
  'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK',
]);

export const GERMAN_VAT_RATES = [19, 7, 0] as const;

export function isEu(country: string | undefined): boolean {
  return !!country && EU_COUNTRIES.has(country.toUpperCase());
}

/**
 * Suggest a treatment for a customer. A suggestion — the user can override it
 * on the document, because only they know whether a sale is goods or a
 * service, and that decides between two of the answers.
 */
export function suggestTreatment(
  seller: Pick<CompanyProfile, 'small_business' | 'country'>,
  buyer: { country?: string; vat_id?: string },
  kind: 'service' | 'goods' = 'service',
): TaxTreatment {
  if (seller.small_business) return 'small_business';
  const country = (buyer.country || seller.country || 'DE').toUpperCase();
  const home = (seller.country || 'DE').toUpperCase();
  if (country === home) return 'domestic';
  if (isEu(country)) {
    // B2B needs the buyer's VAT id. B2C inside the EU is domestic VAT here
    // (below the €10k OSS threshold) — OSS is out of scope for this module.
    if (!buyer.vat_id) return 'domestic';
    return kind === 'goods' ? 'intra_community_supply' : 'reverse_charge_eu';
  }
  return kind === 'goods' ? 'export' : 'third_country_service';
}

interface CategoryInfo {
  category: VatCategory;
  /** Forced rate — exempt categories are always 0. */
  forceZero: boolean;
  reason?: { de: string; en: string };
  code?: string;
}

export function treatmentCategory(t: TaxTreatment): CategoryInfo {
  switch (t) {
    case 'small_business':
      return {
        category: 'E', forceZero: true,
        reason: {
          de: 'Gemäß § 19 Abs. 1 UStG wird keine Umsatzsteuer berechnet (Kleinunternehmerregelung).',
          en: 'No VAT charged pursuant to § 19 (1) UStG (small business exemption).',
        },
      };
    case 'reverse_charge_eu':
      return {
        category: 'AE', forceZero: true, code: 'VATEX-EU-AE',
        reason: {
          de: 'Steuerschuldnerschaft des Leistungsempfängers (Reverse Charge).',
          en: 'Reverse charge: VAT is owed by the recipient (Steuerschuldnerschaft des Leistungsempfängers).',
        },
      };
    case 'intra_community_supply':
      return {
        category: 'K', forceZero: true, code: 'VATEX-EU-IC',
        reason: {
          de: 'Steuerfreie innergemeinschaftliche Lieferung gemäß § 4 Nr. 1b UStG.',
          en: 'VAT-exempt intra-Community supply pursuant to § 4 No. 1b UStG.',
        },
      };
    case 'export':
      return {
        category: 'G', forceZero: true, code: 'VATEX-EU-G',
        reason: {
          de: 'Steuerfreie Ausfuhrlieferung gemäß § 4 Nr. 1a UStG.',
          en: 'VAT-exempt export delivery pursuant to § 4 No. 1a UStG.',
        },
      };
    case 'third_country_service':
      return {
        category: 'O', forceZero: true, code: 'VATEX-EU-O',
        reason: {
          de: 'Nicht im Inland steuerbare Leistung (Leistungsort im Drittland, § 3a Abs. 2 UStG).',
          en: 'Not subject to German VAT (place of supply outside the EU, § 3a (2) UStG).',
        },
      };
    default:
      return { category: 'S', forceZero: false };
  }
}

/** The VAT note printed on a document, or '' for plain domestic VAT. */
export function treatmentNote(t: TaxTreatment, lang: 'de' | 'en'): string {
  return treatmentCategory(t).reason?.[lang] ?? '';
}

/** Round half away from zero, on a value that is already in cents. */
export function roundCents(x: number): number {
  // Number.EPSILON guards 1.005-style representation error before rounding.
  const r = Math.round(Math.abs(x) + Number.EPSILON * Math.abs(x));
  return x < 0 ? -r : r;
}

/** Net amount of one line, in cents, before VAT. */
export function lineNetCents(line: LineItem, priceMode: 'net' | 'gross', rate: number): number {
  if (line.type === 'text') return 0;
  const qty = Number(line.quantity) || 0;
  const discount = Math.min(100, Math.max(0, Number(line.discount_percent) || 0));
  const raw = qty * (Number(line.unit_price_cents) || 0) * (1 - discount / 100);
  if (priceMode === 'gross') {
    const gross = roundCents(raw);
    return roundCents((gross * 100) / (100 + rate));
  }
  return roundCents(raw);
}

/**
 * Totals for a list of lines under one treatment.
 *
 * Under every treatment except `domestic` the rate is forced to 0 and the
 * category comes from the treatment — a reverse-charge invoice with a line
 * still saying 19 % is a typo, and printing VAT on it would make the seller
 * owe it (§14c UStG).
 */
export function computeTotals(
  lines: readonly LineItem[],
  treatment: TaxTreatment,
  priceMode: 'net' | 'gross' = 'net',
  lang: 'de' | 'en' = 'de',
): DocumentTotals {
  const info = treatmentCategory(treatment);
  const computed = [];
  const groups = new Map<string, TaxGroup>();
  for (const line of lines) {
    if (line.type === 'text') continue;
    const rate = info.forceZero ? 0 : Math.max(0, Number(line.tax_rate) || 0);
    const category: VatCategory = info.forceZero ? info.category : rate === 0 ? 'Z' : 'S';
    // In gross mode a forced-zero treatment still treats the typed price as
    // the final price: dividing by (100+0)/100 is the identity.
    const net = lineNetCents(line, priceMode, rate);
    if (line.optional || line.alternative) {
      // Shown with its price on the quote, but not part of the sum.
      computed.push({ id: line.id, net_cents: net, category, rate, excluded: true });
      continue;
    }
    computed.push({ id: line.id, net_cents: net, category, rate });
    const key = `${category}:${rate}`;
    const g = groups.get(key) ?? {
      category, rate, net_cents: 0, tax_cents: 0,
      ...(info.reason ? { exemption_reason: info.reason[lang] } : {}),
      ...(info.code ? { exemption_code: info.code } : {}),
    };
    g.net_cents += net;
    groups.set(key, g);
  }
  let net = 0;
  let tax = 0;
  const out: TaxGroup[] = [];
  for (const g of groups.values()) {
    g.tax_cents = g.rate > 0 ? roundCents((g.net_cents * g.rate) / 100) : 0;
    net += g.net_cents;
    tax += g.tax_cents;
    out.push(g);
  }
  // Stable order: highest rate first, as invoices conventionally print it.
  out.sort((a, b) => b.rate - a.rate || a.category.localeCompare(b.category));
  return { net_cents: net, tax_cents: tax, gross_cents: net + tax, groups: out, lines: computed };
}

/** What is still payable on a document, before payments: gross − down payments. */
export function dueCents(d: { totals: DocumentTotals }): number {
  return d.totals.due_cents ?? d.totals.gross_cents;
}

/**
 * Final invoice (Schlussrechnung): the full work is invoiced, the down
 * payments already invoiced are deducted from what is payable. The VAT
 * groups stay those of the full work — the deduction is shown below them.
 */
export function withDeductions(t: DocumentTotals, deducts: readonly { gross_cents: number }[] | undefined): DocumentTotals {
  if (!deducts?.length) return { ...t, prepaid_cents: undefined, due_cents: undefined };
  const prepaid = deducts.reduce((s, d) => s + d.gross_cents, 0);
  return { ...t, prepaid_cents: prepaid, due_cents: t.gross_cents - prepaid };
}

/**
 * The VAT groups a document contributes to the books: a final invoice
 * contributes only what its down payments have not already declared.
 */
export function bookingGroups(d: { totals: DocumentTotals; deducts?: { groups: TaxGroup[] }[] }): TaxGroup[] {
  if (!d.deducts?.length) return d.totals.groups;
  const out = new Map(d.totals.groups.map((g) => [`${g.category}:${g.rate}`, { ...g }]));
  for (const p of d.deducts) {
    for (const g of p.groups) {
      const key = `${g.category}:${g.rate}`;
      const cur = out.get(key) ?? { ...g, net_cents: 0, tax_cents: 0 };
      cur.net_cents -= g.net_cents;
      cur.tax_cents -= g.tax_cents;
      out.set(key, cur);
    }
  }
  return [...out.values()].filter((g) => g.net_cents || g.tax_cents);
}

/** Skonto on one invoice: the deadline, the discount and what to pay then. */
export function skontoFor(d: { type: string; issue_date?: string; skonto?: { percent: number; days: number }; totals: DocumentTotals }):
  { percent: number; days: number; until: string; discount_cents: number; pay_cents: number } | null {
  if (d.type !== 'invoice' || !d.skonto || !d.issue_date) return null;
  const base = dueCents(d);
  if (base <= 0) return null;
  const discount = roundCents((base * d.skonto.percent) / 100);
  const until = new Date(`${d.issue_date}T12:00:00Z`);
  until.setUTCDate(until.getUTCDate() + d.skonto.days);
  return { percent: d.skonto.percent, days: d.skonto.days, until: until.toISOString().slice(0, 10), discount_cents: discount, pay_cents: base - discount };
}

/**
 * Split an amount across a document's VAT groups in proportion to their
 * gross — how a Skonto or a written-off difference reduces each rate.
 * The parts add up exactly to `amount`.
 */
export function splitByGroups(amount: number, groups: readonly TaxGroup[]): { group: TaxGroup; gross_cents: number; net_cents: number; tax_cents: number }[] {
  const total = groups.reduce((s, g) => s + g.net_cents + g.tax_cents, 0);
  if (!total) return [];
  let left = amount;
  return groups.map((g, i) => {
    const gross = i === groups.length - 1 ? left : roundCents((amount * (g.net_cents + g.tax_cents)) / total);
    left -= gross;
    const tax = g.rate > 0 ? gross - roundCents((gross * 100) / (100 + g.rate)) : 0;
    return { group: g, gross_cents: gross, net_cents: gross - tax, tax_cents: tax };
  });
}

/**
 * Split a gross amount into net + tax at a rate. For expenses, where a receipt
 * says "€11.90 incl. 19 %" and nothing else.
 */
export function splitGross(grossCents: number, rate: number): { net_cents: number; tax_cents: number } {
  const net = roundCents((grossCents * 100) / (100 + rate));
  return { net_cents: net, tax_cents: grossCents - net };
}

/** Basic shape check for an EU VAT id. Not a VIES lookup. */
export function looksLikeVatId(v: string | undefined): boolean {
  if (!v) return false;
  return /^(ATU\d{8}|BE[01]\d{9}|BG\d{9,10}|CY\d{8}[A-Z]|CZ\d{8,10}|DE\d{9}|DK\d{8}|EE\d{9}|EL\d{9}|ES[A-Z0-9]\d{7}[A-Z0-9]|FI\d{8}|FR[A-Z0-9]{2}\d{9}|HR\d{11}|HU\d{8}|IE\d[A-Z0-9+*]\d{5}[A-Z]{1,2}|IT\d{11}|LT(\d{9}|\d{12})|LU\d{8}|LV\d{11}|MT\d{8}|NL\d{9}B\d{2}|PL\d{10}|PT\d{9}|RO\d{2,10}|SE\d{12}|SI\d{8}|SK\d{10}|XI\d{9,12}|CHE\d{9}(MWST|TVA|IVA)?|GB\d{9,12})$/
    .test(v.replace(/[\s.-]/g, '').toUpperCase());
}

/**
 * Leitweg-ID shape and check digits (KoSIT format spec 2.0.2: ISO/IEC 7064
 * MOD 97-10 over everything before the last two digits). `null` when the
 * value is not shaped like a Leitweg-ID at all — then it is some other buyer
 * reference and nothing can be said about it.
 */
export function leitwegIdValid(v: string | undefined): boolean | null {
  const s = (v ?? '').trim().toUpperCase();
  if (!/^\d{2,12}(-[A-Z0-9]{1,30})?-\d{2}$/.test(s)) return null;
  const digits = s.replace(/-/g, '').replace(/[A-Z]/g, (ch) => String(ch.charCodeAt(0) - 55));
  let rem = 0;
  for (const d of digits) rem = (rem * 10 + Number(d)) % 97;
  return rem === 1;
}

/** IBAN mod-97 check. */
export function validIban(iban: string | undefined): boolean {
  if (!iban) return false;
  const s = iban.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(s)) return false;
  const rearranged = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of rearranged) {
    const v = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of v) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem === 1;
}
