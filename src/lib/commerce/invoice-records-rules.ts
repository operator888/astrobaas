/**
 * Invoice and credit-memo RECORDS — the pure half: settings, what a record
 * holds, and how a refund becomes a credit memo. No storage, no I/O, so every
 * number here is testable exactly. The write path is `invoice-records.ts`.
 *
 * ## What a record is, and firmly what it is not
 *
 * A record is a FROZEN copy of what an order charged: the lines, the VAT per
 * rate, the seller and the buyer (with the buyer's `tax_id`), the currency. It
 * exists so that every issuer — a Greek provider through myDATA, a Peppol
 * access point, a bridge to the shop's own ΦΗΜ — attaches to one shape instead
 * of each rebuilding it from the order slightly differently, and so a shop
 * with no issuer still has a correct VAT breakdown per order.
 *
 * It is NOT an invoice. Owner decision, 2026-09-04 (see `Address.tax_id` in
 * core/models.ts): AstroBaaS is not a fiscal device and will not become one.
 * So core never numbers a record as a document — the only document number a
 * record carries is the one an issuer returned — and the optional internal
 * reference below is the shop's own bookkeeping counter, labelled as such
 * wherever it appears.
 *
 * ## Why the VAT analysis is possible now
 *
 * `receipt.ts` explains why the receipt shows no per-rate table: the shipping
 * half of `tax_cents` was never stored. It is now (`shipping_tax_cents`, on
 * every order placed since), so a record built from such an order reconciles
 * to the cent. An order from before has no stored shipping tax and no
 * per-line breakdown to trust; its record says so (`vat_complete: false`)
 * instead of inventing figures.
 */
import type {
  Address, CreditMemoRecord, InvoiceDocument, InvoiceLineTaxTreatment, InvoiceParty, InvoiceRecord,
  InvoiceRecordLine, InvoiceVatRow, Order, OrderLineBreakdown,
} from '../../core/models';

/* ---------------------------------------------------------------- settings -- */

/** The settings this feature reads. Import these; never retype the strings. */
export const INVOICE_SETTING_KEYS = {
  /** 'paid' | 'shipped' | 'manual' — when a record is created by itself. */
  recordOn: 'invoice_record_on',
  /**
   * Optional. The shop's own sequential reference, e.g. `REF-{year}-{n}`.
   * Empty = off. Only used while no issuer is configured.
   */
  referenceFormat: 'invoice_internal_reference_format',
  /** Which issuer plugin issues records, when more than one is active. */
  issuer: 'invoice_issuer',
} as const;

export const INVOICE_RECORD_TRIGGERS = ['paid', 'shipped', 'manual'] as const;
export type InvoiceRecordTrigger = (typeof INVOICE_RECORD_TRIGGERS)[number];

/** The sequence the internal reference counts on (`Storage.nextSequence`). */
export const INTERNAL_REFERENCE_SEQUENCE = 'invoice_internal_reference';

export const MAX_REFERENCE_FORMAT_LENGTH = 40;

export interface InvoiceSettings {
  recordOn: InvoiceRecordTrigger;
  /** Null when the shop has not switched an internal reference on. */
  referenceFormat: string | null;
  /** Null = no explicit choice. */
  issuerId: string | null;
}

/**
 * Is this a usable internal-reference format? `{n}` is required (a format
 * without it would give every record the same reference); `{year}` is
 * optional. A small character set, because the value is printed on a PDF and
 * shown in the admin, and has no business carrying markup.
 */
export function referenceFormatProblem(value: unknown): string | null {
  if (typeof value !== 'string') return 'must be text';
  const v = value.trim();
  if (v.length > MAX_REFERENCE_FORMAT_LENGTH) return `must be at most ${MAX_REFERENCE_FORMAT_LENGTH} characters`;
  if (!v.includes('{n}')) return 'must contain {n}, where the number goes';
  const rest = v.replace(/\{n\}|\{year\}/g, '');
  if (/[{}]/.test(rest)) return 'may use only {n} and {year} as placeholders';
  if (!/^[A-Za-z0-9 _./#-]*$/.test(rest)) return 'may use letters, digits, spaces and - _ . / #';
  return null;
}

const ISSUER_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** Is this a well-formed issuer id (the shape plugins must use)? */
export function isIssuerId(value: unknown): value is string {
  return typeof value === 'string' && ISSUER_ID_RE.test(value);
}

/**
 * `settings-validate.ts` asks this for every key it is handed. `undefined`
 * means "not one of mine"; `null` means valid; a string is the problem.
 */
export function validateInvoiceSetting(key: string, value: unknown): string | null | undefined {
  const empty = value === null || value === undefined || value === '';
  if (key === INVOICE_SETTING_KEYS.recordOn) {
    if (empty) return null;
    return typeof value === 'string' && (INVOICE_RECORD_TRIGGERS as readonly string[]).includes(value)
      ? null
      : `must be one of: ${INVOICE_RECORD_TRIGGERS.join(', ')}`;
  }
  if (key === INVOICE_SETTING_KEYS.referenceFormat) {
    if (empty) return null;
    return referenceFormatProblem(value);
  }
  if (key === INVOICE_SETTING_KEYS.issuer) {
    if (empty) return null;
    return isIssuerId(value) ? null : 'must be an issuer id (lower-case letters, digits and -)';
  }
  return undefined;
}

/**
 * The settings, as every reader must see them. Junk reads as the default:
 * `paid`, no internal reference, no explicit issuer.
 */
export function resolveInvoiceSettings(map: Record<string, unknown>): InvoiceSettings {
  const on = map[INVOICE_SETTING_KEYS.recordOn];
  const fmt = map[INVOICE_SETTING_KEYS.referenceFormat];
  const iss = map[INVOICE_SETTING_KEYS.issuer];
  return {
    recordOn: typeof on === 'string' && (INVOICE_RECORD_TRIGGERS as readonly string[]).includes(on)
      ? (on as InvoiceRecordTrigger) : 'paid',
    referenceFormat: typeof fmt === 'string' && fmt.trim() && referenceFormatProblem(fmt) === null ? fmt.trim() : null,
    issuerId: isIssuerId(iss) ? iss : null,
  };
}

/** `REF-{year}-{n}` with n = 7 → `REF-2026-7`. */
export function formatInternalReference(format: string, n: number, at: string): string {
  const year = String(at).slice(0, 4);
  return format.replace(/\{year\}/g, year).replace(/\{n\}/g, String(n));
}

/**
 * Has the order reached the moment the shop chose?
 *
 *  - paid: the money arrived. `refunded` counts too — it was paid, and the
 *    refund is then a credit memo against the record, which is how the books
 *    should read. `completed` counts as well: it is how a bank-transfer or
 *    cash-on-delivery order, which no provider ever marks paid, records that
 *    it was settled.
 *  - shipped: tracking was recorded (`shipped_at`), or the order is completed.
 *  - manual: never by itself.
 */
export function triggerReached(order: Pick<Order, 'payment_status' | 'status' | 'shipped_at'>, on: InvoiceRecordTrigger): boolean {
  if (on === 'manual') return false;
  if (order.status === 'completed') return true;
  if (on === 'paid') return order.payment_status === 'paid' || order.payment_status === 'refunded';
  return typeof order.shipped_at === 'string' && order.shipped_at.length > 0;
}

/* ------------------------------------------------------------- the record -- */

/** The stored records, with anything that is not a record dropped. */
export function invoiceDocumentsOf(order: Pick<Order, 'invoice_records'> | null | undefined): InvoiceDocument[] {
  const raw = (order as { invoice_records?: unknown } | null | undefined)?.invoice_records;
  if (!Array.isArray(raw)) return [];
  return raw.filter((d): d is InvoiceDocument => !!d && typeof d === 'object'
    && typeof (d as any).id === 'string'
    && ((d as any).kind === 'invoice' || (d as any).kind === 'credit_memo'));
}

export const invoicesOf = (docs: readonly InvoiceDocument[]): InvoiceRecord[] =>
  docs.filter((d): d is InvoiceRecord => d.kind === 'invoice');
export const memosOf = (docs: readonly InvoiceDocument[]): CreditMemoRecord[] =>
  docs.filter((d): d is CreditMemoRecord => d.kind === 'credit_memo');

/** How much of an invoice record its credit memos have already given back. */
export function creditedTotal(docs: readonly InvoiceDocument[], invoiceId: string): number {
  return memosOf(docs).filter((m) => m.invoice_record_id === invoiceId).reduce((s, m) => s + (Number(m.total_cents) || 0), 0);
}

/**
 * A record with nothing left to credit. A record of 0 (a 100% coupon) is
 * NEVER "fully credited": nothing was charged, nothing can be refunded, and
 * treating it as spent would let every click make another record.
 */
export function isFullyCredited(docs: readonly InvoiceDocument[], inv: InvoiceRecord): boolean {
  return inv.total_cents > 0 && creditedTotal(docs, inv.id) >= inv.total_cents;
}

/**
 * Invoice records a staff correction credited away ("credit in full", a memo
 * with no refund behind it) — to be replaced by a corrected record.
 */
export function supersededInvoiceIds(docs: readonly InvoiceDocument[]): Set<string> {
  return new Set(memosOf(docs).filter((m) => !m.refund_id).map((m) => m.invoice_record_id));
}

/**
 * May a person create a new invoice record on this order?
 *
 * Only when there is none yet, or when every final record was corrected away
 * (credited in full by staff). NOT when the refunds have credited it: a fully
 * refunded sale is a sale and its refund, and a second record there would
 * re-invoice money that went back.
 */
export function canCreateInvoice(docs: readonly InvoiceDocument[]): boolean {
  if (activeInvoice(docs)) return false;
  const gone = supersededInvoiceIds(docs);
  return invoicesOf(docs).every((d) => d.status === 'cancelled' || gone.has(d.id));
}

/**
 * The invoice record that is "the" record of this order now: a draft, or a
 * final one not yet fully credited. At most one exists, because creating one
 * is refused while one does. Null when there is none.
 */
export function activeInvoice(docs: readonly InvoiceDocument[]): InvoiceRecord | null {
  const live = invoicesOf(docs).filter((d) => d.status === 'draft' || (d.status === 'final' && !isFullyCredited(docs, d)));
  return live.length ? live[live.length - 1] : null;
}

/** `<order id>.inv-<n>` — it names its order, so the PDF route can find it. */
export function nextDocumentId(orderId: string, docs: readonly InvoiceDocument[], kind: InvoiceDocument['kind']): string {
  const tag = kind === 'invoice' ? 'inv' : 'cm';
  let max = 0;
  for (const d of docs) {
    const m = new RegExp(`\\.${tag}-(\\d+)$`).exec(d.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${orderId}.${tag}-${max + 1}`;
}

/** The order id a record id names, or null. Greedy, so an order id with dots still parses. */
export function orderIdOfDocument(id: unknown): string | null {
  if (typeof id !== 'string' || id.length > 260) return null;
  const m = /^(.+)\.(inv|cm)-(\d{1,6})$/.exec(id);
  return m ? m[1] : null;
}

/** Group lines by rate. Highest rate first, so 24% heads a Greek table. */
export function vatAnalysis(lines: readonly InvoiceRecordLine[]): InvoiceVatRow[] {
  const by = new Map<number, InvoiceVatRow>();
  for (const l of lines) {
    const row = by.get(l.tax_rate_bp) ?? { rate_bp: l.tax_rate_bp, base_cents: 0, tax_cents: 0 };
    row.base_cents += l.net_cents;
    row.tax_cents += l.tax_cents;
    by.set(l.tax_rate_bp, row);
  }
  return [...by.values()].sort((a, b) => b.rate_bp - a.rate_bp);
}

/** The inclusive split, the same arithmetic as tax.ts's splitTax. */
function splitGross(gross: number, rateBp: number): { net: number; tax: number } {
  if (rateBp <= 0) return { net: gross, tax: 0 };
  const net = Math.round((gross * 10_000) / (10_000 + rateBp));
  return { net, tax: gross - net };
}

/**
 * The shipping rate, which the order does not store.
 *
 * Shipping follows the goods (totals.ts), so the rate is almost always one of
 * the goods' rates — and the one that reproduces the stored shipping tax to
 * the cent is the one that was used. Failing that (a separate shipping tax
 * class), the rate implied by the two stored figures, rounded to a whole
 * percent, which is what every VAT table in this project's markets uses.
 */
export function inferShippingRate(netCents: number, taxCents: number, goodsRates: readonly number[]): number {
  if (taxCents <= 0 || netCents <= 0) return 0;
  for (const r of [...new Set(goodsRates)].filter((r) => r > 0)) {
    if (Math.round((netCents * r) / 10_000) === taxCents) return r;
    if (splitGross(netCents + taxCents, r).tax === taxCents) return r;
  }
  return Math.round((taxCents / netCents) * 100) * 100;
}

function line(o: Omit<InvoiceRecordLine, 'total_cents'>): InvoiceRecordLine {
  return { ...o, total_cents: o.net_cents + o.tax_cents };
}

/* ------------------------------------------------ frozen tax treatment -- */

/**
 * Each goods line's tax treatment, and the shipping line's, as the PRICED
 * order decided them. See `InvoiceRecordLine.tax_treatment` for the values.
 *
 * Read from what checkout froze, never re-derived from today's settings:
 *
 *  - `line_totals[i].tax_treatment` is the engine's answer (totals.ts stamps
 *    `reverse-charge`, `export` or `destination`; unstamped is domestic);
 *  - a line a person overrode (`tax_rate_source: 'override'`) follows the LAST
 *    override that reached it (`tax_overrides` is append-only): `exempt` is
 *    an exemption; a tax class is the normal rules at another rate.
 *
 * `standard` is claimed only where VAT was actually charged (rate > 0). A 0 %
 * line with nothing stamped is tax switched off, an untaxed product or a
 * zero-rated class, and the order does not say which — so it is left
 * UNKNOWN (undefined) rather than guessed. That is the guess an issuer used to
 * make from "0 % and a foreign country", which a shop with tax switched off
 * got wrong.
 *
 * Shipping is never overridden (tax-override route) and follows the goods
 * (totals.ts): it takes the engine's reverse-charge or export when every goods
 * line has it and no shipping VAT was charged; `standard` when shipping VAT
 * was charged; otherwise unknown.
 */
export function lineTaxTreatments(order: Pick<Order, 'line_totals' | 'line_totals_original' | 'tax_overrides' | 'shipping_tax_cents'>): {
  goods: (InvoiceLineTaxTreatment | undefined)[];
  shipping: InvoiceLineTaxTreatment | undefined;
} {
  const lines: OrderLineBreakdown[] = Array.isArray(order.line_totals) ? order.line_totals : [];
  const overrides = Array.isArray(order.tax_overrides) ? order.tax_overrides : [];
  const engine = (b: OrderLineBreakdown | undefined): InvoiceLineTaxTreatment | 'domestic' | undefined => {
    const t = b?.tax_treatment;
    if (t === 'reverse-charge' || t === 'export') return t;
    if (t === undefined || t === 'domestic' || t === 'destination') return 'domestic';
    return undefined; // a value this version does not know: unknown, not standard
  };
  const charged = (b: OrderLineBreakdown) => Math.round(Number(b.tax_rate_bp) || 0) > 0;

  const goods = lines.map((b, i): InvoiceLineTaxTreatment | undefined => {
    if (!b || typeof b !== 'object') return undefined;
    if (b.tax_rate_source === 'override') {
      let last: (typeof overrides)[number] | undefined;
      for (const o of overrides) {
        if (o && (o.scope === 'order' || (o.scope === 'line' && o.line_index === i))) last = o;
      }
      if (!last) return undefined; // overridden, but the decision is not on file
      if (last.exempt === true) return 'exempt';
      return charged(b) ? 'standard' : undefined;
    }
    const e = engine(b);
    if (e === 'reverse-charge' || e === 'export') return e;
    if (e === 'domestic') return charged(b) ? 'standard' : undefined;
    return undefined;
  });

  // The ENGINE's goods treatment, before any override: shipping was priced by
  // it, and an override never touches shipping.
  const original: OrderLineBreakdown[] = Array.isArray(order.line_totals_original) && order.line_totals_original.length
    ? order.line_totals_original : lines;
  const engineKinds = new Set(original.map((b) => engine(b)));
  const shippingTax = typeof order.shipping_tax_cents === 'number' ? Math.round(order.shipping_tax_cents) : null;
  let shipping: InvoiceLineTaxTreatment | undefined;
  if (shippingTax !== null && shippingTax > 0) shipping = 'standard';
  else if (shippingTax === 0 && engineKinds.size === 1) {
    const only = [...engineKinds][0];
    if (only === 'reverse-charge' || only === 'export') shipping = only;
  }
  return { goods, shipping };
}

/**
 * The lines and VAT exactly as the order charged them.
 *
 * `line_totals` is the per-line breakdown checkout froze (with any tax
 * override already applied — that IS what was charged). It is positional with
 * `items`, and used with the item's product and variant only when the two
 * agree on length; otherwise the breakdown's own names stand alone.
 */
export function chargedLines(order: Order): { lines: InvoiceRecordLine[]; complete: boolean } {
  const items = Array.isArray(order.items) ? order.items : [];
  const breakdown = Array.isArray(order.line_totals) ? order.line_totals : [];
  const lines: InvoiceRecordLine[] = [];
  let complete = breakdown.length > 0;

  const treatments = lineTaxTreatments(order);
  if (breakdown.length > 0) {
    const aligned = breakdown.length === items.length;
    breakdown.forEach((b, i) => {
      const treatment = treatments.goods[i];
      // An override re-rates from the shop's own table (rateForClass), so the
      // engine's jurisdiction no longer describes the rate charged.
      const jurisdiction = b.tax_rate_source !== 'override' && typeof b.tax_jurisdiction === 'string'
        && /^[A-Z]{2}$/.test(b.tax_jurisdiction) ? b.tax_jurisdiction : '';
      const item = aligned ? items[i] : undefined;
      const options = Object.entries(item?.variant_options ?? {}).map(([k, v]) => `${k}: ${v}`).join(' · ');
      lines.push(line({
        kind: 'goods',
        description: options ? `${b.name} (${options})` : String(b.name ?? item?.name ?? ''),
        qty: Number(b.qty) || 0,
        ...(b.product_id ? { product_id: String(b.product_id) } : item?.product_id ? { product_id: item.product_id } : {}),
        ...(item?.variant_id ? { variant_id: item.variant_id } : {}),
        net_cents: Math.round(Number(b.net_cents) || 0),
        tax_rate_bp: Math.max(0, Math.round(Number(b.tax_rate_bp) || 0)),
        tax_cents: Math.round(Number(b.tax_cents) || 0),
        ...(treatment ? { tax_treatment: treatment } : {}),
        ...(jurisdiction ? { tax_jurisdiction: jurisdiction } : {}),
      }));
    });
  } else {
    // No breakdown: the lines as sold, with no rate claimed.
    for (const item of items) {
      lines.push(line({
        kind: 'goods',
        description: String(item.name ?? ''),
        qty: Number(item.qty) || 0,
        ...(item.product_id ? { product_id: item.product_id } : {}),
        ...(item.variant_id ? { variant_id: item.variant_id } : {}),
        net_cents: Math.round(Number(item.total_cents) || 0),
        tax_rate_bp: 0,
        tax_cents: 0,
      }));
    }
  }

  const shipping = Math.round(Number(order.shipping_cents) || 0);
  if (shipping > 0) {
    const known = typeof order.shipping_tax_cents === 'number';
    if (!known) complete = false;
    const tax = known ? Math.round(order.shipping_tax_cents as number) : 0;
    // `shipping_cents` is in the install's own convention: the gross when
    // prices include tax, the net when they do not.
    const gross = order.prices_include_tax === true ? shipping : shipping + tax;
    const net = gross - tax;
    lines.push(line({
      kind: 'shipping',
      description: String(order.shipping_method_name ?? '') || 'Shipping',
      qty: 1,
      net_cents: net,
      tax_rate_bp: known ? inferShippingRate(net, tax, lines.map((l) => l.tax_rate_bp)) : 0,
      tax_cents: tax,
      // Only with a per-line breakdown: without one nothing about the sale's
      // treatment is on file, shipping included.
      ...(breakdown.length > 0 && treatments.shipping ? { tax_treatment: treatments.shipping } : {}),
    }));
  }

  // The record must add up to what was charged, or it is not the record of
  // the charge. If it does not (a hand-edited or imported order), the figures
  // are kept and flagged rather than "corrected" into something nobody charged.
  const total = lines.reduce((s, l) => s + l.total_cents, 0);
  const tax = lines.reduce((s, l) => s + l.tax_cents, 0);
  if (total !== Math.round(Number(order.total_cents) || 0)) complete = false;
  if (typeof order.tax_cents === 'number' && tax !== Math.round(order.tax_cents)) complete = false;
  return { lines, complete };
}

/** The buyer, frozen from the invoice address (falling back to delivery). */
export function buyerOf(order: Order, formatAddress: (a: Address) => string): InvoiceParty {
  const a = order.billing_address ?? order.shipping_address;
  const party: InvoiceParty = {};
  const name = (a?.name ?? '').trim() || (order.name ?? '').trim();
  if (name) party.name = name;
  if (a?.company?.trim()) party.company = a.company.trim();
  const addr = a ? formatAddress(a) : String(order.address ?? '').trim();
  if (addr) party.address = addr;
  const country = (a?.country ?? order.shipping_country ?? '').trim().toUpperCase();
  if (country) party.country = country;
  // As captured. Never checked here (owner decision): an issuer that needs a
  // valid ΑΦΜ says so on the record, and nothing ever refuses the order.
  if (a?.tax_id?.trim()) party.tax_id = a.tax_id.trim();
  if (order.email?.trim()) party.email = order.email.trim();
  return party;
}

/** The seller, frozen from the trader settings the receipt already prints. */
export function sellerOf(settings: Record<string, unknown>): InvoiceParty {
  const s = (k: string) => (typeof settings[k] === 'string' ? (settings[k] as string).trim() : '');
  const party: InvoiceParty = {};
  const name = s('trader_legal_name') || s('site_title');
  if (name) party.name = name;
  if (s('trader_address')) party.address = s('trader_address');
  if (s('shop_country')) party.country = s('shop_country').toUpperCase();
  if (s('trader_vat_number')) party.tax_id = s('trader_vat_number');
  return party;
}

export interface BuildInvoiceInput {
  id: string;
  order: Order;
  seller: InvoiceParty;
  buyer: InvoiceParty;
  trigger: InvoiceRecord['trigger'];
  status: 'draft' | 'final';
  now: string;
}

/** A new invoice record. Pure: everything it needs is passed in. */
export function buildInvoiceRecord(input: BuildInvoiceInput): InvoiceRecord {
  const { order, now } = input;
  const { lines, complete } = chargedLines(order);
  const hasRates = Array.isArray(order.line_totals) && order.line_totals.length > 0;
  const record: InvoiceRecord = {
    id: input.id,
    kind: 'invoice',
    order_id: order.id,
    status: input.status,
    trigger: input.trigger,
    created_at: now,
    ...(input.status === 'final' ? { finalised_at: now } : {}),
    currency: String(order.currency ?? ''),
    prices_include_tax: order.prices_include_tax === true,
    seller: input.seller,
    buyer: input.buyer,
    lines,
    vat: hasRates ? vatAnalysis(lines) : [],
    vat_complete: complete,
    net_cents: lines.reduce((s, l) => s + l.net_cents, 0),
    tax_cents: lines.reduce((s, l) => s + l.tax_cents, 0),
    total_cents: lines.reduce((s, l) => s + l.total_cents, 0),
  };
  // A document number the shop's POS already gave this sale: recorded as
  // issued elsewhere, so no issuer reports it a second time.
  const external = String(order.external_receipt_no ?? '').trim();
  if (external) record.issued_externally = { at: now, actor: 'order', number: external.slice(0, 100) };
  return record;
}

/* ------------------------------------------------------- the credit memo -- */

/** Largest-remainder split of `amount` over `weights`, never above a weight. */
export function allocate(amount: number, weights: readonly number[]): number[] {
  const total = weights.reduce((s, w) => s + Math.max(0, w), 0);
  if (total <= 0 || amount <= 0) return weights.map(() => 0);
  const target = Math.min(amount, total);
  const exact = weights.map((w) => (Math.max(0, w) * target) / total);
  const out = exact.map((x) => Math.floor(x));
  let left = target - out.reduce((s, n) => s + n, 0);
  const order = exact.map((x, i) => ({ i, frac: x - Math.floor(x) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    if (out[i] < Math.max(0, weights[i])) { out[i] += 1; left -= 1; }
  }
  return out;
}

export interface BuildMemoInput {
  id: string;
  invoice: InvoiceRecord;
  /** Every record on the order, so earlier memos against `invoice` are known. */
  docs: readonly InvoiceDocument[];
  /** What was refunded. Capped at what the record has left to credit. */
  amount_cents: number;
  /** The ledger entry this follows; absent for a staff correction. */
  refund_id?: string;
  now: string;
}

/**
 * A credit memo against `invoice` for `amount_cents`.
 *
 * The refund ledger records an AMOUNT, not lines (a provider refunds money,
 * and a partial refund is rarely "line 2"). So the refunded lines are the
 * record's lines in proportion: each line's share of what is still uncredited
 * on it, to the cent, by largest remainder; each share is split into net and
 * VAT at that line's rate. When the amount is everything that is left, the
 * memo is exactly the remainder of every line — so a record and its memos
 * always net to zero, with no rounding cent left over on either side.
 *
 * Null when nothing is left to credit.
 */
export function buildCreditMemo(input: BuildMemoInput): CreditMemoRecord | null {
  const { invoice, docs } = input;
  const prior = memosOf(docs).filter((m) => m.invoice_record_id === invoice.id);
  const left = invoice.lines.map((l, i) => {
    let net = l.net_cents;
    let tax = l.tax_cents;
    for (const m of prior) {
      for (const ml of m.lines) {
        if (ml.invoice_line === i) {
          net -= ml.net_cents;
          tax -= ml.tax_cents;
        }
      }
    }
    return { net: Math.max(0, net), tax: Math.max(0, tax), credited: net !== l.net_cents || tax !== l.tax_cents };
  });
  const remaining = left.reduce((s, x) => s + x.net + x.tax, 0);
  const amount = Math.min(Math.round(input.amount_cents), remaining);
  if (amount <= 0) return null;

  const lines: InvoiceRecordLine[] = [];
  if (amount === remaining) {
    invoice.lines.forEach((l, i) => {
      const x = left[i];
      if (x.net + x.tax === 0) return;
      // A whole line credited at once keeps its quantity; the remainder of a
      // line already partly credited is a share, and has none.
      const { qty, ...rest } = l;
      lines.push({
        ...rest, ...(x.credited || qty === undefined ? {} : { qty }), invoice_line: i,
        net_cents: x.net, tax_cents: x.tax, total_cents: x.net + x.tax,
      });
    });
  } else {
    const shares = allocate(amount, left.map((x) => x.net + x.tax));
    invoice.lines.forEach((l, i) => {
      const g = shares[i];
      if (g <= 0) return;
      let { net, tax } = splitGross(g, l.tax_rate_bp);
      // Never past what the line has left on either side.
      if (tax > left[i].tax) { net += tax - left[i].tax; tax = left[i].tax; }
      if (net > left[i].net) { tax += net - left[i].net; net = left[i].net; }
      const { qty: _qty, ...rest } = l;
      lines.push({ ...rest, invoice_line: i, net_cents: net, tax_cents: tax, total_cents: net + tax });
    });
  }

  return {
    id: input.id,
    kind: 'credit_memo',
    order_id: invoice.order_id,
    status: 'final',
    created_at: input.now,
    finalised_at: input.now,
    invoice_record_id: invoice.id,
    // A sale issued elsewhere (the POS) is credited elsewhere too: the memo
    // carries the mark, so no issuer here ever reports a credit for a sale
    // it never reported.
    ...(invoice.issued_externally
      ? { issued_externally: { at: input.now, actor: 'invoice', ...(invoice.issued_externally.number ? { number: invoice.issued_externally.number } : {}) } }
      : {}),
    ...(input.refund_id ? { refund_id: input.refund_id } : {}),
    currency: invoice.currency,
    prices_include_tax: invoice.prices_include_tax,
    lines,
    vat: invoice.vat.length ? vatAnalysis(lines) : [],
    net_cents: lines.reduce((s, l) => s + l.net_cents, 0),
    tax_cents: lines.reduce((s, l) => s + l.tax_cents, 0),
    total_cents: lines.reduce((s, l) => s + l.total_cents, 0),
  };
}

/* -------------------------------------------------------- display state -- */

/** One word for a record's state, as the admin and the API show it. */
export type InvoiceDocumentState =
  | 'draft' | 'final' | 'cancelled' | 'issuing' | 'issued' | 'issue_failed' | 'issued_elsewhere';

export function documentState(d: InvoiceDocument): InvoiceDocumentState {
  if (d.status === 'draft') return 'draft';
  if (d.status === 'cancelled') return 'cancelled';
  if (d.issued_externally) return 'issued_elsewhere';
  if (d.issuer?.status === 'issued') return 'issued';
  if (d.issuer?.status === 'issuing') return 'issuing';
  if (d.issuer?.status === 'failed') return 'issue_failed';
  // 'declined' — every issuer said "not mine" — is deliberately plain 'final':
  // the record is what it would be with no issuer at all, not a failure.
  return 'final';
}

/* ------------------------------------------------------- issue retries -- */

/** An `issuing` claim older than this may be retried (a crash mid-call). */
export const ISSUE_STALE_MS = 10 * 60_000;
/** The background sweep stops retrying a record after this many calls to its issuer. */
export const MAX_AUTO_ISSUE_ATTEMPTS = 10;
/** The wait after the first failed call; it doubles per call, up to the cap below. */
export const ISSUE_RETRY_BASE_MS = 2 * 60_000;
export const ISSUE_RETRY_MAX_MS = 6 * 60 * 60_000;

/**
 * The idempotency key of every attempt at one record. The record id names its
 * order and never repeats (a corrected record is a new id), so one key is one
 * document — the same on a retry, after a timeout, and from the sweep.
 */
export function issueKeyOf(recordId: string): string {
  return `astrobaas:${recordId}`;
}

/** How long to wait after the `attempts`-th call failed retryably: 2, 4, 8 … min, at most 6 h. */
export function issueRetryDelayMs(attempts: number): number {
  const n = Math.max(1, Math.floor(attempts));
  return Math.min(ISSUE_RETRY_BASE_MS * 2 ** Math.min(n - 1, 30), ISSUE_RETRY_MAX_MS);
}

/**
 * When the sweep should call again after `attempts` calls, or null when the
 * automatic attempts have run out (a person can still press "Issue again").
 */
export function nextIssueAttemptAt(attempts: number, nowMs: number): string | null {
  if (attempts >= MAX_AUTO_ISSUE_ATTEMPTS) return null;
  return new Date(nowMs + issueRetryDelayMs(attempts)).toISOString();
}

/**
 * Is this record the background sweep's to retry now?
 *
 *  - a retryable failure whose `next_attempt_at` has come, under the cap;
 *  - an `issuing` claim gone stale (the process died mid-call: the outcome is
 *    unknown, and a retry under the same key is how an idempotent issuer
 *    answers it).
 *
 * Never a record issued, issued elsewhere, declined, or failed for good.
 */
export function issueRetryDue(d: InvoiceDocument, nowMs: number): boolean {
  if (d.status !== 'final' || d.issued_externally) return false;
  const s = d.issuer;
  if (!s || !s.id) return false;
  if (s.status === 'failed') {
    if (s.retryable !== true || typeof s.next_attempt_at !== 'string') return false;
    if ((s.attempts ?? 1) >= MAX_AUTO_ISSUE_ATTEMPTS) return false;
    const at = Date.parse(s.next_attempt_at);
    return Number.isFinite(at) && at <= nowMs;
  }
  if (s.status === 'issuing') {
    // Capped too: an issuer that kills the process on every call is not
    // called every ten minutes for ever.
    if ((s.attempts ?? 1) >= MAX_AUTO_ISSUE_ATTEMPTS) return false;
    const at = Date.parse(s.attempted_at);
    return Number.isFinite(at) && nowMs - at > ISSUE_STALE_MS;
  }
  return false;
}

/**
 * Does the PDF of this record stand as a tax document? Only when an issuer
 * issued it — then it carries the issuer's number and identifiers. Every
 * other state prints the "not a tax document" line and no document number.
 */
export function isIssuedDocument(d: InvoiceDocument): boolean {
  return d.status === 'final' && !d.issued_externally && d.issuer?.status === 'issued';
}
