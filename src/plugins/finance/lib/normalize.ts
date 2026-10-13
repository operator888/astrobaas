/**
 * Input validation for everything the API accepts.
 *
 * Copy-in, never spread-in: each normaliser builds a fresh object from the
 * fields it knows, so a caller cannot set `status`, `number`, `paid_cents` or
 * `totals` on a document by including them in a POST body. Totals are always
 * recomputed; numbers are only ever assigned at finalization.
 */
import type {
  Address, Article, CompanyProfile, Contact, ExpenseLine, LineItem, RecurringTemplate, SkontoTerms, TaxTreatment,
} from './types';
import { parseAmountToCents, parseDate } from './format';
import { categoryByKey, EXPENSE_CATEGORIES } from './accounts';

export class FinanceError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'FinanceError';
    this.status = status;
  }
}

type Obj = Record<string, unknown>;

export function asObj(v: unknown): Obj {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {};
}

export function str(v: unknown, max = 500): string | undefined {
  if (typeof v === 'number') v = String(v);
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  if (!s) return undefined;
  if (s.length > max) throw new FinanceError(`A text field is longer than ${max} characters.`);
  return s;
}

function bool(v: unknown, fallback = false): boolean {
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === '1' || v === 1) return true;
  if (v === 'false' || v === '0' || v === 0) return false;
  return fallback;
}

function num(v: unknown, fallback: number, min = -Infinity, max = Infinity): number {
  const n = typeof v === 'string' ? Number(v.replace(',', '.')) : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Accept cents as an integer, or `amount` as a decimal/string. */
function cents(obj: Obj, key: string, fallback = 0): number {
  const c = obj[`${key}_cents`];
  if (typeof c === 'number' && Number.isInteger(c)) return c;
  if (obj[key] !== undefined) {
    const parsed = parseAmountToCents(obj[key]);
    if (parsed === null) throw new FinanceError(`"${key}" is not a valid amount.`);
    return parsed;
  }
  return fallback;
}

function date(v: unknown, field: string): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const d = parseDate(String(v));
  if (!d) throw new FinanceError(`"${field}" is not a valid date (use YYYY-MM-DD).`);
  return d;
}

function country(v: unknown): string | undefined {
  const s = str(v, 2)?.toUpperCase();
  if (s && !/^[A-Z]{2}$/.test(s)) throw new FinanceError('Country must be a 2-letter ISO code (DE, GR, AT…).');
  return s;
}

function email(v: unknown): string | undefined {
  const s = str(v, 254);
  if (s && !/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(s)) throw new FinanceError(`"${s}" is not a valid email address.`);
  return s;
}

export function normAddress(v: unknown): Address {
  const a = asObj(v);
  return {
    name: str(a.name, 200), supplement: str(a.supplement, 200), street: str(a.street, 200),
    zip: str(a.zip, 20), city: str(a.city, 100), country: country(a.country) ?? 'DE',
  };
}

const TREATMENTS: TaxTreatment[] = ['domestic', 'small_business', 'reverse_charge_eu', 'intra_community_supply', 'third_country_service', 'export'];

export function treatment(v: unknown): TaxTreatment | undefined {
  return TREATMENTS.includes(v as TaxTreatment) ? (v as TaxTreatment) : undefined;
}

export function normContact(input: unknown, existing?: Contact): Omit<Contact, 'id' | 'created_at' | 'updated_at'> {
  const i = asObj(input);
  const base = existing ?? ({} as Partial<Contact>);
  const pick = <K extends keyof Contact>(k: K, fn: (v: unknown) => Contact[K]): Contact[K] => (k in i ? fn(i[k as string]) : base[k] as Contact[K]);
  const roles = asObj(i.roles);
  const out = {
    customer_number: pick('customer_number', (v) => str(v, 40)),
    vendor_number: pick('vendor_number', (v) => str(v, 40)),
    roles: 'roles' in i
      ? { customer: bool(roles.customer, true), vendor: bool(roles.vendor, false) }
      : base.roles ?? { customer: true, vendor: false },
    kind: pick('kind', (v) => (v === 'person' ? 'person' : 'company')) ?? 'company',
    company_name: pick('company_name', (v) => str(v, 200)),
    salutation: pick('salutation', (v) => str(v, 40)),
    first_name: pick('first_name', (v) => str(v, 100)),
    last_name: pick('last_name', (v) => str(v, 100)),
    email: pick('email', email),
    invoice_email: pick('invoice_email', email),
    phone: pick('phone', (v) => str(v, 40)),
    billing_address: 'billing_address' in i ? normAddress(i.billing_address) : base.billing_address ?? { country: 'DE' },
    vat_id: pick('vat_id', (v) => str(v, 20)?.replace(/\s+/g, '').toUpperCase()),
    tax_number: pick('tax_number', (v) => str(v, 30)),
    buyer_reference: pick('buyer_reference', (v) => str(v, 100)),
    einvoice_format: pick('einvoice_format', (v) => (v === 'xrechnung' || v === 'zugferd' || v === 'pdf' ? v : undefined)),
    payment_days: pick('payment_days', (v) => (v === undefined || v === null || v === '' ? undefined : num(v, 14, 0, 365))),
    skonto: pick('skonto', normSkonto),
    datev_account: pick('datev_account', (v) => (v ? Math.round(num(v, 0, 0, 999999999)) || undefined : undefined)),
    notes: pick('notes', (v) => str(v, 4000)),
    tags: pick('tags', (v) => (Array.isArray(v) ? v.map((t) => str(t, 40)).filter(Boolean).slice(0, 20) as string[] : undefined)),
    source: base.source ?? str(i.source, 60),
    external_ids: base.external_ids ?? (i.external_ids ? Object.fromEntries(Object.entries(asObj(i.external_ids)).map(([k, v]) => [k.slice(0, 40), String(v).slice(0, 100)])) : undefined),
    archived: pick('archived', (v) => bool(v)),
  };
  if (!out.company_name && !out.last_name && !out.first_name) {
    throw new FinanceError('A contact needs a company name or a person\'s name.');
  }
  return out;
}

export function normArticle(input: unknown, existing?: Article): Omit<Article, 'id' | 'created_at' | 'updated_at'> {
  const i = asObj(input);
  const b = existing ?? ({} as Partial<Article>);
  const title = 'title' in i ? str(i.title, 300) : b.title;
  if (!title) throw new FinanceError('An article needs a title.');
  return {
    number: 'number' in i ? str(i.number, 40) : b.number,
    title,
    description: 'description' in i ? str(i.description, 4000) : b.description,
    type: ('type' in i ? (i.type === 'product' ? 'product' : 'service') : b.type) ?? 'service',
    unit: ('unit' in i ? str(i.unit, 8)?.toUpperCase() : b.unit) ?? 'C62',
    unit_price_cents: 'unit_price_cents' in i || 'unit_price' in i ? cents(i, 'unit_price') : b.unit_price_cents ?? 0,
    tax_rate: 'tax_rate' in i ? num(i.tax_rate, 19, 0, 100) : b.tax_rate ?? 19,
    archived: 'archived' in i ? bool(i.archived) : b.archived,
    source: b.source ?? str(i.source, 60),
    external_ids: b.external_ids,
  };
}

let lineCounter = 0;
export function lineId(): string {
  lineCounter = (lineCounter + 1) % 1e6;
  return `ln_${Date.now().toString(36)}${lineCounter.toString(36)}`;
}

/** Skonto terms, or undefined for "none" (empty, 0 %, or 0 days). */
export function normSkonto(v: unknown): SkontoTerms | undefined {
  if (v === null || v === undefined || v === '' || v === false) return undefined;
  const o = asObj(v);
  const percent = Math.round(num(o.percent, 0, 0, 10) * 100) / 100;
  const days = Math.round(num(o.days, 0, 0, 90));
  return percent > 0 && days > 0 ? { percent, days } : undefined;
}

export function normLines(v: unknown): LineItem[] {
  if (!Array.isArray(v)) return [];
  if (v.length > 500) throw new FinanceError('A document can have at most 500 lines.');
  return v.map((raw) => {
    const l = asObj(raw);
    const type = l.type === 'text' ? 'text' : 'item';
    const name = str(l.name, 500) ?? str(l.title, 500) ?? '';
    if (type === 'item' && !name) throw new FinanceError('Every line needs a name.');
    const qty = num(l.quantity ?? l.qty, 1, -1e9, 1e9);
    return {
      id: str(l.id, 40) ?? lineId(),
      type,
      article_id: str(l.article_id, 60),
      name,
      description: str(l.description, 4000),
      quantity: type === 'text' ? 0 : Math.round(qty * 1000) / 1000,
      unit: str(l.unit, 8)?.toUpperCase() ?? 'C62',
      unit_price_cents: type === 'text' ? 0 : cents(l, 'unit_price'),
      discount_percent: l.discount_percent !== undefined ? num(l.discount_percent, 0, 0, 100) : undefined,
      optional: type === 'item' && bool(l.optional) ? true : undefined,
      alternative: type === 'item' && bool(l.alternative) ? true : undefined,
      tax_rate: num(l.tax_rate, 19, 0, 100),
      period_start: date(l.period_start, 'period_start'),
      period_end: date(l.period_end, 'period_end'),
    } satisfies LineItem;
  });
}

export function normExpenseLines(v: unknown, fallbackCategory = 'other'): ExpenseLine[] {
  if (!Array.isArray(v) || !v.length) return [];
  return v.slice(0, 100).map((raw) => {
    const l = asObj(raw);
    const cat = EXPENSE_CATEGORIES.some((c) => c.key === l.category) ? String(l.category) : fallbackCategory;
    const rate = num(l.tax_rate, categoryByKey(cat).default_rate, 0, 100);
    let net = 'net_cents' in l || 'net' in l ? cents(l, 'net') : undefined;
    let tax = 'tax_cents' in l || 'tax' in l ? cents(l, 'tax') : undefined;
    if (net === undefined && ('gross_cents' in l || 'gross' in l)) {
      const gross = cents(l, 'gross');
      net = Math.round((gross * 100) / (100 + rate));
      tax = gross - net;
    }
    net = net ?? 0;
    tax = tax ?? Math.round((net * rate) / 100);
    return { category: cat, description: str(l.description, 300), net_cents: net, tax_rate: rate, tax_cents: tax };
  });
}

export function normCompany(input: unknown, existing: CompanyProfile): CompanyProfile {
  const i = asObj(input);
  const s = (k: keyof CompanyProfile, max = 200) => (k in i ? str(i[k], max) : existing[k]) as string | undefined;
  const logo = 'logo_data_url' in i ? (typeof i.logo_data_url === 'string' ? i.logo_data_url : undefined) : existing.logo_data_url;
  if (logo && (!/^data:image\/(png|jpe?g);base64,[A-Za-z0-9+/=]+$/.test(logo) || logo.length > 700_000)) {
    throw new FinanceError('The logo must be a PNG or JPEG under ~500 KB.');
  }
  const accent = s('accent_color', 9);
  if (accent && !/^#[0-9a-f]{6}$/i.test(accent)) throw new FinanceError('Accent colour must be a hex colour like #1d4ed8.');
  return {
    name: s('name') ?? '',
    tagline: s('tagline'),
    legal_form: s('legal_form', 60),
    street: s('street') ?? '',
    zip: s('zip', 20) ?? '',
    city: s('city', 100) ?? '',
    country: ('country' in i ? country(i.country) : existing.country) ?? 'DE',
    managing_directors: s('managing_directors'),
    register_court: s('register_court'),
    register_number: s('register_number', 60),
    vat_id: ('vat_id' in i ? str(i.vat_id, 20)?.replace(/\s+/g, '').toUpperCase() : existing.vat_id),
    tax_number: s('tax_number', 30),
    email: ('email' in i ? email(i.email) : existing.email) ?? '',
    einvoice_email: 'einvoice_email' in i ? email(i.einvoice_email) : existing.einvoice_email,
    phone: s('phone', 40) ?? '',
    contact_person: s('contact_person', 100) ?? '',
    website: s('website'),
    bank_name: s('bank_name'),
    iban: 'iban' in i ? str(i.iban, 40)?.replace(/\s+/g, '').toUpperCase() : existing.iban,
    bic: 'bic' in i ? str(i.bic, 11)?.replace(/\s+/g, '').toUpperCase() : existing.bic,
    account_holder: s('account_holder'),
    small_business: 'small_business' in i ? bool(i.small_business) : existing.small_business,
    vat_basis: ('vat_basis' in i ? (i.vat_basis === 'ist' ? 'ist' : 'soll') : existing.vat_basis) ?? 'soll',
    chart: ('chart' in i ? (i.chart === 'SKR04' ? 'SKR04' : 'SKR03') : existing.chart) ?? 'SKR03',
    datev_consultant_number: 'datev_consultant_number' in i ? (num(i.datev_consultant_number, 0, 0, 9999999) || undefined) : existing.datev_consultant_number,
    datev_client_number: 'datev_client_number' in i ? (num(i.datev_client_number, 0, 0, 99999) || undefined) : existing.datev_client_number,
    fiscal_year_start_month: 'fiscal_year_start_month' in i ? Math.round(num(i.fiscal_year_start_month, 1, 1, 12)) : existing.fiscal_year_start_month,
    default_payment_days: 'default_payment_days' in i ? Math.round(num(i.default_payment_days, 14, 0, 365)) : existing.default_payment_days,
    default_skonto: 'default_skonto' in i ? normSkonto(i.default_skonto) : existing.default_skonto,
    paypal_me: 'paypal_me' in i ? (str(i.paypal_me, 60)?.replace(/^https?:\/\/(www\.)?paypal\.me\//i, '').replace(/[^A-Za-z0-9_.-]/g, '') || undefined) : existing.paypal_me,
    default_currency: ('default_currency' in i ? str(i.default_currency, 3)?.toUpperCase() : existing.default_currency) ?? 'EUR',
    logo_data_url: logo,
    accent_color: accent,
    document_language: ('document_language' in i ? (i.document_language === 'en' ? 'en' : 'de') : existing.document_language) ?? 'de',
  };
}

export function normRecurring(input: unknown, existing?: RecurringTemplate): Omit<RecurringTemplate, 'id' | 'created_at' | 'updated_at' | 'last_document_id'> {
  const i = asObj(input);
  const b = existing ?? ({} as Partial<RecurringTemplate>);
  const contact_id = ('contact_id' in i ? str(i.contact_id, 60) : b.contact_id);
  if (!contact_id) throw new FinanceError('A recurring invoice needs a contact.');
  const lines = 'lines' in i ? normLines(i.lines) : b.lines ?? [];
  if (!lines.some((l) => l.type === 'item')) throw new FinanceError('A recurring invoice needs at least one billable line.');
  const next = 'next_date' in i ? date(i.next_date, 'next_date') : b.next_date;
  if (!next) throw new FinanceError('A recurring invoice needs a next_date.');
  const interval = ('interval' in i ? i.interval : b.interval) as RecurringTemplate['interval'];
  return {
    name: ('name' in i ? str(i.name, 200) : b.name) ?? 'Recurring invoice',
    active: 'active' in i ? bool(i.active, true) : b.active ?? true,
    contact_id,
    interval: interval === 'quarterly' || interval === 'yearly' ? interval : 'monthly',
    next_date: next,
    end_date: 'end_date' in i ? date(i.end_date, 'end_date') : b.end_date,
    auto_finalize: 'auto_finalize' in i ? bool(i.auto_finalize) : b.auto_finalize ?? false,
    auto_send: 'auto_send' in i ? bool(i.auto_send) : b.auto_send ?? false,
    lines,
    title: 'title' in i ? str(i.title, 200) : b.title,
    intro: 'intro' in i ? str(i.intro, 4000) : b.intro,
    closing: 'closing' in i ? str(i.closing, 4000) : b.closing,
    price_mode: ('price_mode' in i ? (i.price_mode === 'gross' ? 'gross' : 'net') : b.price_mode) ?? 'net',
    bill_period: 'bill_period' in i ? bool(i.bill_period, true) : b.bill_period ?? true,
    tax_treatment: 'tax_treatment' in i ? treatment(i.tax_treatment) : b.tax_treatment,
    payment_days: 'payment_days' in i ? (i.payment_days === null || i.payment_days === '' ? undefined : num(i.payment_days, 14, 0, 365)) : b.payment_days,
    // Re-anchored whenever the operator moves the next date, kept otherwise.
    anchor_day: Number(next.slice(8, 10)) === b.anchor_day || !('next_date' in i) ? b.anchor_day ?? Number(next.slice(8, 10)) : Number(next.slice(8, 10)),
  };
}

export { cents as readCents, date as readDate, bool as readBool, num as readNum, email as readEmail };
