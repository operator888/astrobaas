/**
 * The finance module's data model.
 *
 * ## Money
 *
 * Every amount is an integer number of CENTS, exactly like the rest of
 * AstroBaaS. Quantities and percentages are plain numbers (a quantity may be
 * 1.5 hours; a tax rate may be 19 or 7). Nothing here stores a float euro
 * amount, because a float euro amount is how a VAT return ends up a cent off.
 *
 * ## Documents are records, not views
 *
 * A finalized invoice is an accounting record (§14 UStG, GoBD). Its seller and
 * buyer blocks are FROZEN COPIES taken at finalization, so editing a contact's
 * address later never rewrites an invoice that already went out. The same rule
 * the shop's orders follow for addresses (see `Order.shipping_address`).
 */

export type ISODate = string; // YYYY-MM-DD
export type ISODateTime = string; // full ISO timestamp

/* ------------------------------------------------------------------ *
 * Company profile (the seller)
 * ------------------------------------------------------------------ */

export type ChartOfAccounts = 'SKR03' | 'SKR04';

/** How VAT is owed to the tax office: on invoicing (Soll) or on payment (Ist). */
export type VatBasis = 'soll' | 'ist';

export interface CompanyProfile {
  name: string;
  /** Second line under the name, e.g. "Digital Agency". */
  tagline?: string;
  legal_form?: string;
  street: string;
  zip: string;
  city: string;
  country: string; // ISO 3166-1 alpha-2
  /** Managing director(s) — a GmbH/UG must print them (§35a GmbHG). */
  managing_directors?: string;
  register_court?: string; // e.g. "Amtsgericht Augsburg"
  register_number?: string; // e.g. "HRB 12345"
  vat_id?: string; // USt-IdNr., DE…
  tax_number?: string; // Steuernummer
  email: string;
  /** Where e-invoices are sent from / replied to (BT-34). Defaults to `email`. */
  einvoice_email?: string;
  phone: string;
  /** Contact person shown in e-invoices (BR-DE-5). */
  contact_person: string;
  website?: string;
  bank_name?: string;
  iban?: string;
  bic?: string;
  account_holder?: string;
  /** Kleinunternehmer under §19 UStG — no VAT is charged. */
  small_business: boolean;
  vat_basis: VatBasis;
  chart: ChartOfAccounts;
  /** DATEV header fields, from the Steuerberater. */
  datev_consultant_number?: number;
  datev_client_number?: number;
  /** First month of the fiscal year, 1–12. */
  fiscal_year_start_month: number;
  default_payment_days: number;
  /** Default Skonto offered on new invoices (none when unset). */
  default_skonto?: SkontoTerms;
  /** PayPal.Me name (paypal.me/<name>) printed as a payment option. */
  paypal_me?: string;
  default_currency: string;
  /** Logo as a data: URL (PNG/JPEG), drawn on PDFs. Optional. */
  logo_data_url?: string;
  /** Accent colour for PDFs, hex. */
  accent_color?: string;
  /** Language of generated documents. */
  document_language: 'de' | 'en';
}

/* ------------------------------------------------------------------ *
 * Contacts
 * ------------------------------------------------------------------ */

export interface Address {
  name?: string;
  supplement?: string;
  street?: string;
  zip?: string;
  city?: string;
  country?: string; // alpha-2
}

export interface Contact {
  id: string;
  /** Customer number (Kundennummer) and/or vendor number (Lieferantennummer). */
  customer_number?: string;
  vendor_number?: string;
  roles: { customer: boolean; vendor: boolean };
  kind: 'company' | 'person';
  company_name?: string;
  salutation?: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  /** Separate address for invoices, if accounting wants them elsewhere. */
  invoice_email?: string;
  phone?: string;
  billing_address: Address;
  vat_id?: string;
  tax_number?: string;
  /**
   * The buyer reference (BT-10). For public-sector customers this is the
   * Leitweg-ID and is MANDATORY on an XRechnung.
   */
  buyer_reference?: string;
  /** Preferred e-invoice format for this customer. */
  einvoice_format?: 'pdf' | 'zugferd' | 'xrechnung';
  payment_days?: number;
  skonto?: SkontoTerms;
  /** DATEV personal account (Debitor 10000–69999, Kreditor 70000–99999). */
  datev_account?: number;
  notes?: string;
  tags?: string[];
  /** Where the record came from — 'lexware', 'shop', 'inbound:<source>'… */
  source?: string;
  external_ids?: Record<string, string>;
  archived?: boolean;
  created_at: ISODateTime;
  updated_at: ISODateTime;
}

/* ------------------------------------------------------------------ *
 * Articles (products & services)
 * ------------------------------------------------------------------ */

export interface Article {
  id: string;
  number?: string;
  title: string;
  description?: string;
  type: 'service' | 'product';
  /** UN/ECE Rec 20 unit code — HUR (hour), DAY, C62 (piece), MON (month), LS (lump sum). */
  unit: string;
  unit_price_cents: number; // net
  tax_rate: number;
  archived?: boolean;
  source?: string;
  external_ids?: Record<string, string>;
  created_at: ISODateTime;
  updated_at: ISODateTime;
}

/* ------------------------------------------------------------------ *
 * Tax
 * ------------------------------------------------------------------ */

/**
 * How a whole document is taxed. Derived from the seller and buyer, and
 * stored on the document so the PDF, the XML, the VAT report and the DATEV
 * export all read ONE answer instead of re-deriving four.
 */
export type TaxTreatment =
  /** Normal German VAT, 19/7/0. */
  | 'domestic'
  /** §19 UStG — seller charges no VAT. */
  | 'small_business'
  /** B2B service to a business in another EU state — §3a(2), recipient owes VAT. */
  | 'reverse_charge_eu'
  /** Goods to a VAT-registered business in another EU state — §4 Nr.1b. */
  | 'intra_community_supply'
  /** Service to a customer outside the EU — not taxable in Germany. */
  | 'third_country_service'
  /** Goods exported outside the EU — §4 Nr.1a. */
  | 'export';

/** EN 16931 VAT category code (BT-151 / BT-118). */
export type VatCategory = 'S' | 'Z' | 'E' | 'AE' | 'K' | 'G' | 'O';

export interface TaxGroup {
  category: VatCategory;
  rate: number;
  net_cents: number;
  tax_cents: number;
  exemption_reason?: string;
  exemption_code?: string;
}

/* ------------------------------------------------------------------ *
 * Documents: quotes, invoices, credit notes
 * ------------------------------------------------------------------ */

export type DocumentType = 'quote' | 'invoice' | 'credit_note';

export type DocumentStatus =
  /** Editable. No number, no legal effect. */
  | 'draft'
  /** Quote sent / invoice finalized and unpaid. */
  | 'open'
  | 'partially_paid'
  | 'paid'
  /** Invoice cancelled by a credit note, or quote withdrawn. */
  | 'cancelled'
  /** Quote outcomes. */
  | 'accepted'
  | 'rejected'
  /** Quote turned into an invoice. */
  | 'invoiced';

export interface LineItem {
  id: string;
  /** 'text' lines carry no amount — headings and notes inside the table. */
  type: 'item' | 'text';
  article_id?: string;
  name: string;
  description?: string;
  quantity: number;
  unit: string;
  /** Net unit price, or gross when the document's price_mode is 'gross'. */
  unit_price_cents: number;
  /** Line discount in percent, 0–100. */
  discount_percent?: number;
  /**
   * Quotes only. An optional line ("auf Wunsch") or an alternative to
   * another line is shown with its price but is not part of the total; the
   * customer can pick optional lines when accepting the quote online.
   */
  optional?: boolean;
  alternative?: boolean;
  tax_rate: number;
  /** Optional service period for this line. */
  period_start?: ISODate;
  period_end?: ISODate;
}

export interface ComputedLine {
  id: string;
  net_cents: number;
  category: VatCategory;
  rate: number;
  /** Optional / alternative quote line: priced, but not in the total. */
  excluded?: boolean;
}

export interface DocumentTotals {
  net_cents: number;
  tax_cents: number;
  gross_cents: number;
  groups: TaxGroup[];
  lines: ComputedLine[];
  /** Final invoice: gross of the down-payment invoices it deducts. */
  prepaid_cents?: number;
  /** What the customer still has to pay: gross − prepaid. */
  due_cents?: number;
}

export interface SkontoTerms {
  percent: number;
  days: number;
}

export interface PartySnapshot {
  name: string;
  address: Address;
  vat_id?: string;
  tax_number?: string;
  email?: string;
  phone?: string;
  contact_person?: string;
}

export interface FinanceDocument {
  id: string;
  type: DocumentType;
  status: DocumentStatus;
  /** Assigned at finalization. Drafts have none. */
  number?: string;
  contact_id?: string;
  /** Live address while draft; frozen at finalization. */
  recipient: Address & { email?: string; vat_id?: string; tax_number?: string; buyer_reference?: string };
  /** Frozen at finalization. */
  seller?: CompanyProfile;
  title?: string;
  /** The customer's own reference — their order or purchase-order number (EN 16931 BT-13). */
  reference?: string;
  /** Free text above the lines ("Vielen Dank für Ihren Auftrag…"). */
  intro?: string;
  /** Free text below the totals. */
  closing?: string;
  currency: string;
  price_mode: 'net' | 'gross';
  tax_treatment: TaxTreatment;
  lines: LineItem[];
  issue_date?: ISODate;
  /** Leistungsdatum, or the start of a service period. */
  service_date?: ISODate;
  service_date_end?: ISODate;
  due_date?: ISODate;
  /** Quotes: valid until. */
  valid_until?: ISODate;
  payment_days?: number;
  payment_terms_text?: string;
  /** Cash discount for early payment (Skonto), e.g. 2 % within 7 days. */
  skonto?: SkontoTerms;
  /**
   * Down-payment / final invoices. 'partial' is an Abschlagsrechnung; 'final'
   * is the Schlussrechnung that deducts the listed down payments.
   */
  invoice_kind?: 'standard' | 'partial' | 'final';
  /** Final invoice: the down-payment invoices it settles (ids). */
  deducts?: { id: string; number: string; net_cents: number; tax_cents: number; gross_cents: number; groups: TaxGroup[] }[];
  /** Quotes accepted online: which optional lines the customer chose. */
  accepted_options?: string[];
  /** Quotes: the order confirmation (Auftragsbestätigung) issued for it. */
  order_confirmation?: { pdf_id: string; date: ISODate; sent_to?: string };
  /** Who accepted / rejected a quote online, and when. */
  quote_response?: { status: 'accepted' | 'rejected'; at: ISODateTime; name?: string; note?: string; via: 'portal' | 'admin' };
  /** Cached totals — recomputed on every write, never trusted from input. */
  totals: DocumentTotals;
  paid_cents: number;
  /** For credit notes: the invoice this corrects. */
  refers_to_id?: string;
  refers_to_number?: string;
  /** For invoices created from a quote. */
  from_quote_id?: string;
  /** For the quote: which invoice it became. */
  invoice_id?: string;
  /** Set when a credit note cancels this invoice. */
  cancelled_by_id?: string;
  einvoice_format: 'pdf' | 'zugferd' | 'xrechnung';
  /** Private-file ids of the archived artefacts (GoBD: keep what was sent). */
  archived_pdf_id?: string;
  archived_xml_id?: string;
  /** SHA-256 of the canonical finalized content, for tamper evidence. */
  content_hash?: string;
  /** Random token for the customer-facing view/download link. */
  public_token?: string;
  dunning_level?: number;
  last_dunning_at?: ISODate;
  sent_at?: ISODateTime;
  finalized_at?: ISODateTime;
  /** Not printed. */
  internal_note?: string;
  tags?: string[];
  source?: string;
  /** Idempotency key from an integration: `<source>:<external id>`. */
  external_ref?: string;
  /** Imported from another system: the number came from there. */
  imported?: boolean;
  recurring_id?: string;
  created_at: ISODateTime;
  updated_at: ISODateTime;
}

/* ------------------------------------------------------------------ *
 * Payments
 * ------------------------------------------------------------------ */

export interface Payment {
  id: string;
  document_id: string;
  /** Positive = money received. A refund on a credit note is negative. */
  amount_cents: number;
  date: ISODate;
  /**
   * 'discount' is not money: it settles the rest of an invoice as an
   * Erlösschmälerung — Skonto taken by the customer, or a small difference
   * written off. It lowers revenue and VAT (§ 17 UStG).
   */
  method: 'bank' | 'cash' | 'stripe' | 'paypal' | 'card' | 'offset' | 'discount' | 'other';
  discount_kind?: 'skonto' | 'difference';
  reference?: string;
  bank_tx_id?: string;
  note?: string;
  created_at: ISODateTime;
}

/* ------------------------------------------------------------------ *
 * Expenses (incoming invoices / receipts)
 * ------------------------------------------------------------------ */

export interface ExpenseLine {
  category: string; // key in CATEGORIES
  description?: string;
  net_cents: number;
  tax_rate: number;
  tax_cents: number;
}

export interface Expense {
  id: string;
  status: 'draft' | 'open' | 'paid';
  contact_id?: string;
  supplier_name: string;
  supplier_vat_id?: string;
  /** Alpha-2. Decides the VAT-return line for reverse-charge purchases. */
  supplier_country?: string;
  invoice_number?: string;
  date: ISODate;
  due_date?: ISODate;
  service_date?: ISODate;
  currency: string;
  lines: ExpenseLine[];
  net_cents: number;
  tax_cents: number;
  gross_cents: number;
  paid_cents: number;
  paid_date?: ISODate;
  /**
   * Services bought from a business abroad (§13b UStG): the invoice shows no
   * VAT, and WE owe it — and may deduct it again as input tax.
   */
  reverse_charge?: boolean;
  /** Receipt file (PDF/image/XML) in private storage. */
  file_id?: string;
  file_name?: string;
  /** The structured XML, when the expense came in as an e-invoice. */
  xml_file_id?: string;
  source: 'manual' | 'upload' | 'einvoice' | 'ai' | 'bank' | 'inbound' | 'lexware' | 'recurring';
  note?: string;
  bank_tx_id?: string;
  external_ref?: string;
  created_at: ISODateTime;
  updated_at: ISODateTime;
}

/* ------------------------------------------------------------------ *
 * Bank
 * ------------------------------------------------------------------ */

export interface BankAccount {
  id: string;
  name: string;
  iban?: string;
  bic?: string;
  currency: string;
  /** DATEV account for this bank (default 1200 / 1800). */
  ledger_account?: number;
  opening_balance_cents?: number;
  opening_balance_date?: ISODate;
  created_at: ISODateTime;
}

export type BankTxStatus = 'unmatched' | 'matched' | 'ignored';

export interface BankTransaction {
  id: string;
  account_id: string;
  booking_date: ISODate;
  value_date?: ISODate;
  /** Signed: positive = money in. */
  amount_cents: number;
  currency: string;
  counterparty_name?: string;
  counterparty_iban?: string;
  purpose: string;
  end_to_end_id?: string;
  bank_reference?: string;
  /** Dedupe fingerprint — re-importing the same statement adds nothing. */
  fingerprint: string;
  status: BankTxStatus;
  /** What it was matched to. */
  matches?: { kind: 'document' | 'expense'; id: string; amount_cents: number }[];
  /** A direct booking without a document, e.g. bank fees. */
  category?: string;
  imported_at: ISODateTime;
}

export interface MatchSuggestion {
  kind: 'document' | 'expense';
  id: string;
  label: string;
  open_cents: number;
  score: number;
  reasons: string[];
}

/* ------------------------------------------------------------------ *
 * Recurring invoices (retainers, licences, hosting)
 * ------------------------------------------------------------------ */

/**
 * A standing cost (Dauerbeleg): rent, a server, an insurance premium. The
 * contract is the receipt; each period an open expense is booked from it.
 */
export interface RecurringExpense {
  id: string;
  name: string;
  active: boolean;
  supplier_name: string;
  contact_id?: string;
  category: string;
  gross_cents: number;
  tax_rate: number;
  description?: string;
  interval: 'monthly' | 'quarterly' | 'yearly';
  next_date: ISODate;
  end_date?: ISODate;
  anchor_day?: number;
  /** Book it as already paid (a direct debit you do not want to match by hand). */
  book_as_paid: boolean;
  last_expense_id?: string;
  created_at: ISODateTime;
  updated_at: ISODateTime;
}

export interface RecurringTemplate {
  id: string;
  name: string;
  active: boolean;
  contact_id: string;
  interval: 'monthly' | 'quarterly' | 'yearly';
  /** Next date an invoice is due to be created. */
  next_date: ISODate;
  end_date?: ISODate;
  /** Finalize automatically, or leave a draft for review. */
  auto_finalize: boolean;
  /** Email it automatically after finalizing. */
  auto_send: boolean;
  lines: LineItem[];
  title?: string;
  intro?: string;
  closing?: string;
  price_mode: 'net' | 'gross';
  /** Print the billed period on each line. */
  bill_period: boolean;
  /** Tax case for every invoice; blank = derived from the customer, as for a hand-made invoice. */
  tax_treatment?: TaxTreatment;
  /** Payment term in days; blank = the company default. */
  payment_days?: number;
  /**
   * Day of the month the schedule is anchored to. Without it, a template that
   * starts on the 31st drifts to the 28th after February and stays there.
   */
  anchor_day?: number;
  last_document_id?: string;
  created_at: ISODateTime;
  updated_at: ISODateTime;
}

/* ------------------------------------------------------------------ *
 * Number series
 * ------------------------------------------------------------------ */

export interface NumberSeries {
  /** Pattern with tokens {YYYY} {YY} {MM} {SEQ} {SEQ:n}. */
  pattern: string;
  /** Restart the counter each year / month / never. */
  reset: 'yearly' | 'monthly' | 'never';
}

export interface Counter {
  /** The period key the counter belongs to, e.g. "2026" or "2026-10". */
  period: string;
  value: number;
}

/* ------------------------------------------------------------------ *
 * Audit log (GoBD)
 * ------------------------------------------------------------------ */

export interface LogEntry {
  id: string;
  /** Position in the chain — orders entries even within one millisecond. */
  seq: number;
  at: ISODateTime;
  actor: string;
  action: string;
  entity: string;
  entity_id: string;
  summary?: string;
  /** Before/after for edits of finalized-adjacent data. */
  diff?: Record<string, { from: unknown; to: unknown }>;
  /** Hash chain: sha256(prev_hash + this entry without hash). */
  prev_hash: string;
  hash: string;
}

/* ------------------------------------------------------------------ *
 * Settings stored by the module (not the company profile)
 * ------------------------------------------------------------------ */

export interface FinanceSettings {
  series: Record<DocumentType, NumberSeries>;
  /** Default texts. */
  texts: {
    invoice_intro: string;
    invoice_closing: string;
    quote_intro: string;
    quote_closing: string;
    credit_note_intro: string;
    email_subject: string;
    email_body: string;
  };
  dunning: {
    /** Days after due before each level is suggested. */
    level_days: [number, number, number];
    fees_cents: [number, number, number];
    titles: [string, string, string];
    texts: [string, string, string];
    /** Charge statutory default interest (§288 BGB) on level ≥ 2. */
    charge_interest: boolean;
    base_rate_percent: number;
  };
  /** Create an invoice automatically when a shop order is completed. */
  auto_invoice_shop_orders: boolean;
  /** Create due recurring invoices from the scheduler, without anyone opening the page. */
  auto_run_recurring: boolean;
  /** Override SKR account numbers per category / purpose. */
  account_overrides: Record<string, number>;
  /** Debitor/Kreditor account ranges (DATEV personal accounts). */
  datev_use_personal_accounts: boolean;
  next_debitor: number;
  next_kreditor: number;
}
