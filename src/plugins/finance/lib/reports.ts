/**
 * Reports and the bookkeeping export, as pure functions over records.
 *
 * Everything here reads the CACHED totals on documents and expenses, which
 * `computeTotals` wrote — so a report can never compute a different VAT
 * amount than the invoice printed.
 *
 * Accrual vs cash: a UG/GmbH keeps double-entry books (Bilanzierung), so the
 * profit view is accrual by default (invoice date). The VAT return follows
 * the company's VAT basis: Soll (by invoice date, the default) or Ist (by
 * payment date, if the Finanzamt granted it).
 */
import type {
  BankTransaction, ChartOfAccounts, Contact, Expense, FinanceDocument, FinanceSettings, Payment, TaxGroup, VatBasis,
} from './types';
import { accountFor, categoryByKey, inputTaxKey, revenueKey } from './accounts';
import { bookingGroups, dueCents, isEu, splitByGroups } from './tax';
import { latinize, type DatevBooking } from './datev';
import { daysBetween } from './format';

export interface Period { from: string; to: string }

const inPeriod = (d: string | undefined, p: Period) => !!d && d >= p.from && d <= p.to;

/** Documents that count for accounting: finalized invoices and credit notes. */
export function bookedDocuments(docs: readonly FinanceDocument[]): FinanceDocument[] {
  return docs.filter((d) => (d.type === 'invoice' || d.type === 'credit_note') && d.status !== 'draft' && !!d.number);
}

const sign = (d: FinanceDocument) => (d.type === 'credit_note' ? -1 : 1);

/* ------------------------------ VAT return ------------------------------ */

export interface VatReturn {
  period: Period;
  basis: VatBasis;
  /** Kennzahlen of the German Umsatzsteuer-Voranmeldung, in cents. */
  kz: Record<string, number>;
  /** Tax owed (positive) or refund (negative) — Kz 83. */
  payable_cents: number;
  notes: string[];
}

export function vatReturn(
  period: Period,
  basis: VatBasis,
  docs: readonly FinanceDocument[],
  payments: readonly Payment[],
  expenses: readonly Expense[],
  smallBusiness = false,
): VatReturn {
  const kz: Record<string, number> = {
    '81': 0, '81_tax': 0, '86': 0, '86_tax': 0, '41': 0, '21': 0, '45': 0, '43': 0,
    '46': 0, '47': 0, '84': 0, '85': 0, '66': 0, '67': 0,
  };
  const notes: string[] = [];
  let foreignVat = 0;
  const add = (doc: FinanceDocument, factor: number, groups: readonly TaxGroup[] = bookingGroups(doc)) => {
    for (const g of groups) {
      const net = Math.round(g.net_cents * factor) * sign(doc);
      const tax = Math.round(g.tax_cents * factor) * sign(doc);
      switch (doc.tax_treatment) {
        case 'domestic':
          if (g.rate === 19) { kz['81'] += net; kz['81_tax'] += tax; }
          else if (g.rate === 7) { kz['86'] += net; kz['86_tax'] += tax; }
          break;
        case 'reverse_charge_eu': kz['21'] += net; break;
        case 'intra_community_supply': kz['41'] += net; break;
        case 'third_country_service': kz['45'] += net; break;
        case 'export': kz['43'] += net; break;
        default: break;
      }
    }
  };
  const booked = bookedDocuments(docs);
  if (basis === 'soll') {
    for (const d of booked) if (inPeriod(d.issue_date, period)) add(d, 1);
    // Skonto and written-off differences reduce the taxable amount in the
    // period they happen (§ 17 Abs. 1 UStG), split across the invoice's rates.
    const byId = new Map(booked.map((d) => [d.id, d]));
    for (const p of payments) {
      if (p.method !== 'discount' || !inPeriod(p.date, period)) continue;
      const d = byId.get(p.document_id);
      if (!d) continue;
      add(d, -1, splitByGroups(p.amount_cents, bookingGroups(d)).map((x) => ({ ...x.group, net_cents: x.net_cents, tax_cents: x.tax_cents })));
    }
  } else {
    // Ist: the share of each document paid inside the period.
    const byId = new Map(booked.map((d) => [d.id, d]));
    for (const p of payments) {
      // A discount is money never received: under Ist it is simply never taxed.
      if (!inPeriod(p.date, period) || p.method === 'discount') continue;
      const d = byId.get(p.document_id);
      if (!d || dueCents(d) === 0) continue;
      // Signed: a refund (negative payment) takes the VAT back out again.
      add(d, p.amount_cents / dueCents(d));
    }
  }
  // Input tax always follows the invoice date (§15 UStG needs the invoice and
  // the supply, not the payment — except for prepayments, out of scope here).
  for (const e of expenses) {
    if (e.status === 'draft' || !inPeriod(e.date, period)) continue;
    if (e.reverse_charge) {
      // §13b: we owe the VAT and deduct it again. 19 % on the net amount.
      const net = e.net_cents;
      const tax = Math.round((net * 19) / 100);
      if (isEu(e.supplier_country) && e.supplier_country !== 'DE') { kz['46'] += net; kz['47'] += tax; }
      else { kz['84'] += net; kz['85'] += tax; }
      kz['67'] += tax;
    } else if (e.supplier_country && e.supplier_country !== 'DE' && e.tax_cents) {
      // Foreign VAT (a Greek hotel, an Austrian conference) is not German
      // input tax — it can only be refunded through the EU refund procedure.
      foreignVat += e.tax_cents;
    } else {
      kz['66'] += e.tax_cents;
    }
  }
  if (foreignVat) notes.push(`Foreign VAT of ${(foreignVat / 100).toFixed(2)} € on expenses from suppliers outside Germany is not deductible here (Vorsteuer-Vergütungsverfahren via BZSt).`);
  if (smallBusiness) notes.push('Kleinunternehmer: no VAT return is normally due; figures are for information only.');
  if (kz['84'] > 0) notes.push('Reverse-charge purchases from outside the EU (Kz 84/85): check the supplier\'s country on each expense.');
  const payable = kz['81_tax'] + kz['86_tax'] + kz['47'] + kz['85'] - kz['66'] - kz['67'];
  // The form asks for whole euros on the bases; taxes keep cents.
  return { period, basis, kz, payable_cents: payable, notes };
}

/* ------------------------------ Zusammenfassende Meldung ------------------------------ */

export interface ZmRow {
  /** Country prefix of the customer's VAT id. */
  country: string;
  vat_id: string;
  name: string;
  /** L = Lieferung (goods), S = sonstige Leistung (services, § 18b). */
  kind: 'L' | 'S';
  amount_cents: number;
}

export interface ZusammenfassendeMeldung {
  period: Period;
  rows: ZmRow[];
  total_cents: number;
  notes: string[];
}

/**
 * The figures for the Zusammenfassende Meldung (§ 18a UStG): every
 * intra-Community supply of goods and every § 13b service to an EU business,
 * summed per customer VAT id. Due by the 25th after the quarter (monthly above
 * the threshold). The BZSt portal takes whole euros per line, so the amounts
 * are shown in cents here and rounded when entered. Credit notes reduce the
 * customer's figure; always by invoice date — the ZM does not follow Ist-basis.
 */
export function zusammenfassendeMeldung(period: Period, docs: readonly FinanceDocument[]): ZusammenfassendeMeldung {
  const map = new Map<string, ZmRow>();
  const notes: string[] = [];
  for (const d of bookedDocuments(docs)) {
    if (!inPeriod(d.issue_date, period)) continue;
    if (d.tax_treatment !== 'intra_community_supply' && d.tax_treatment !== 'reverse_charge_eu') continue;
    const vat = (d.recipient.vat_id ?? '').replace(/\s+/g, '').toUpperCase();
    if (!vat) { notes.push(`${d.number}: the customer has no VAT id — it cannot be reported.`); continue; }
    const kind: 'L' | 'S' = d.tax_treatment === 'intra_community_supply' ? 'L' : 'S';
    const key = `${vat}|${kind}`;
    const row = map.get(key) ?? { country: vat.slice(0, 2), vat_id: vat, name: d.recipient.name ?? '', kind, amount_cents: 0 };
    row.amount_cents += bookingGroups(d).reduce((t, g) => t + g.net_cents, 0) * sign(d);
    map.set(key, row);
  }
  const rows = [...map.values()].sort((a, b) => a.vat_id.localeCompare(b.vat_id) || a.kind.localeCompare(b.kind));
  return { period, rows, total_cents: rows.reduce((t, r) => t + r.amount_cents, 0), notes };
}

/* ------------------------------ Profit & loss ------------------------------ */

export interface ProfitLoss {
  period: Period;
  revenue_net_cents: number;
  revenue_by_month: Record<string, number>;
  expenses_net_cents: number;
  expenses_by_category: Record<string, number>;
  result_cents: number;
  top_customers: { name: string; net_cents: number }[];
}

export function profitLoss(period: Period, docs: readonly FinanceDocument[], expenses: readonly Expense[], bankTx: readonly BankTransaction[] = [], payments: readonly Payment[] = []): ProfitLoss {
  const byMonth: Record<string, number> = {};
  const byCustomer = new Map<string, number>();
  let revenue = 0;
  for (const d of bookedDocuments(docs)) {
    if (!inPeriod(d.issue_date, period)) continue;
    const net = bookingGroups(d).reduce((t, g) => t + g.net_cents, 0) * sign(d);
    revenue += net;
    const m = d.issue_date!.slice(0, 7);
    byMonth[m] = (byMonth[m] ?? 0) + net;
    const name = d.recipient.name || '—';
    byCustomer.set(name, (byCustomer.get(name) ?? 0) + net);
  }
  // Skonto / write-offs lower revenue when they are granted.
  const docById = new Map(docs.map((d) => [d.id, d]));
  for (const p of payments) {
    if (p.method !== 'discount' || !inPeriod(p.date, period)) continue;
    const d = docById.get(p.document_id);
    if (!d) continue;
    const net = splitByGroups(p.amount_cents, bookingGroups(d)).reduce((t, x) => t + x.net_cents, 0);
    revenue -= net;
    const m = p.date.slice(0, 7);
    byMonth[m] = (byMonth[m] ?? 0) - net;
    const name = d.recipient.name || '—';
    byCustomer.set(name, (byCustomer.get(name) ?? 0) - net);
  }
  const byCat: Record<string, number> = {};
  let exp = 0;
  for (const e of expenses) {
    if (e.status === 'draft' || !inPeriod(e.date, period)) continue;
    for (const l of e.lines) {
      byCat[l.category] = (byCat[l.category] ?? 0) + l.net_cents;
      exp += l.net_cents;
    }
  }
  // Bank lines booked to a category without a receipt (bank fees): a cost at
  // their full amount, with no input tax — there is no invoice to claim it on.
  for (const t of bankTx) {
    if (!t.category || t.matches?.length || !inPeriod(t.booking_date, period)) continue;
    byCat[t.category] = (byCat[t.category] ?? 0) - t.amount_cents;
    exp -= t.amount_cents;
  }
  return {
    period,
    revenue_net_cents: revenue,
    revenue_by_month: byMonth,
    expenses_net_cents: exp,
    expenses_by_category: byCat,
    result_cents: revenue - exp,
    top_customers: [...byCustomer].map(([name, net_cents]) => ({ name, net_cents }))
      .sort((a, b) => b.net_cents - a.net_cents).slice(0, 10),
  };
}

/* ------------------------------ Open items ------------------------------ */

export interface OpenItemRow {
  kind: 'receivable' | 'payable';
  id: string;
  number?: string;
  name: string;
  date: string;
  due_date?: string;
  open_cents: number;
  days_overdue: number;
}

export function openItems(docs: readonly FinanceDocument[], expenses: readonly Expense[], today: string): OpenItemRow[] {
  const rows: OpenItemRow[] = [];
  for (const d of bookedDocuments(docs)) {
    if (d.type !== 'invoice' || d.status === 'cancelled' || d.status === 'paid') continue;
    const open = dueCents(d) - d.paid_cents;
    if (open <= 0) continue;
    rows.push({
      kind: 'receivable', id: d.id, number: d.number, name: d.recipient.name || '—', date: d.issue_date!,
      due_date: d.due_date, open_cents: open,
      days_overdue: d.due_date ? Math.max(0, daysBetween(d.due_date, today)) : 0,
    });
  }
  for (const e of expenses) {
    if (e.status !== 'open') continue;
    const open = e.gross_cents - e.paid_cents;
    if (open <= 0) continue;
    rows.push({
      kind: 'payable', id: e.id, number: e.invoice_number, name: e.supplier_name, date: e.date,
      due_date: e.due_date, open_cents: open,
      days_overdue: e.due_date ? Math.max(0, daysBetween(e.due_date, today)) : 0,
    });
  }
  return rows.sort((a, b) => b.days_overdue - a.days_overdue || a.date.localeCompare(b.date));
}

/* ------------------------------ DATEV bookings ------------------------------ */

export interface BookingContext {
  chart: ChartOfAccounts;
  settings: Pick<FinanceSettings, 'account_overrides' | 'datev_use_personal_accounts'>;
  contacts: ReadonlyMap<string, Contact>;
  /** DATEV ledger account per bank account id. */
  bankAccounts: ReadonlyMap<string, number>;
}

/*
 * Personal accounts: debtors live in 10000–69999, creditors in 70000–99999.
 * A contact that is both customer and supplier has one number of each, so
 * the account is chosen by role — never the customer account for a purchase.
 */
const inRange = (n: unknown, lo: number, hi: number): number | undefined => {
  const v = Number(n);
  return Number.isInteger(v) && v >= lo && v <= hi ? v : undefined;
};

function debitor(ctx: BookingContext, contactId?: string): number {
  const c = contactId ? ctx.contacts.get(contactId) : undefined;
  const own = c && (inRange(c.customer_number, 10000, 69999) ?? inRange(c.datev_account, 10000, 69999));
  if (ctx.settings.datev_use_personal_accounts && own) return own;
  return accountFor('ledger', 'debitor_default', ctx.chart, ctx.settings.account_overrides).account;
}

function kreditor(ctx: BookingContext, contactId?: string): number {
  const c = contactId ? ctx.contacts.get(contactId) : undefined;
  const own = c && (inRange(c.vendor_number, 70000, 99999) ?? inRange(c.datev_account, 70000, 99999));
  if (ctx.settings.datev_use_personal_accounts && own) return own;
  return accountFor('ledger', 'kreditor_default', ctx.chart, ctx.settings.account_overrides).account;
}

export interface BookingsResult {
  bookings: DatevBooking[];
  warnings: string[];
}

export function datevBookings(
  period: Period,
  ctx: BookingContext,
  docs: readonly FinanceDocument[],
  payments: readonly Payment[],
  expenses: readonly Expense[],
  bankTx: readonly BankTransaction[],
): BookingsResult {
  const out: DatevBooking[] = [];
  const warnings: string[] = [];
  const ov = ctx.settings.account_overrides;
  const docById = new Map(docs.map((d) => [d.id, d]));

  // Outgoing invoices and credit notes — one booking per tax group.
  for (const d of bookedDocuments(docs)) {
    if (!inPeriod(d.issue_date, period)) continue;
    const deb = debitor(ctx, d.contact_id);
    if (d.invoice_kind === 'partial') warnings.push(`${d.number}: down-payment invoice booked as revenue — your Steuerberater may move it to "erhaltene Anzahlungen".`);
    for (const g of bookingGroups(d)) {
      let rev: number;
      let automatic: boolean;
      try {
        ({ account: rev, automatic } = accountFor('rev', revenueKey(d.tax_treatment, g.rate), ctx.chart, ov));
      } catch {
        // A rate this chart has no revenue account for (it should have been
        // refused at finalize): export it on the 19 % account, flagged, rather
        // than failing the whole year's export.
        ({ account: rev, automatic } = accountFor('rev', 'domestic:19', ctx.chart, ov));
        warnings.push(`${d.number}: no revenue account for ${d.tax_treatment} ${g.rate} % — booked on ${rev}, please correct.`);
      }
      const gross = g.net_cents + g.tax_cents;
      if (!gross) continue;
      if (!automatic && g.tax_cents) warnings.push(`${d.number}: revenue account ${rev} is not an Automatikkonto; VAT may be missing in DATEV.`);
      out.push({
        amount_cents: Math.abs(gross),
        sh: (d.type === 'credit_note') !== (gross < 0) ? 'H' : 'S',
        account: deb,
        contra: rev,
        date: d.issue_date!,
        doc_no: d.number!,
        text: latinize(`${d.type === 'credit_note' ? 'GS' : 'RE'} ${d.recipient.name ?? ''}`),
        service_date: d.service_date,
        due_date: d.due_date,
        eu_vat_id: d.tax_treatment === 'reverse_charge_eu' || d.tax_treatment === 'intra_community_supply' ? d.recipient.vat_id : undefined,
      });
    }
  }

  // Skonto / written-off differences: revenue reduction against the debtor,
  // per VAT rate on the "Gewährte Skonti" Automatikkonten.
  for (const p of payments) {
    if (p.method !== 'discount' || !inPeriod(p.date, period)) continue;
    const d = docById.get(p.document_id);
    if (!d) continue;
    for (const part of splitByGroups(p.amount_cents, bookingGroups(d))) {
      if (!part.gross_cents) continue;
      const key = d.tax_treatment === 'domestic' && (part.group.rate === 19 || part.group.rate === 7) ? `discount:${part.group.rate}` : 'discount:0';
      const { account } = accountFor('rev', key, ctx.chart, ov);
      out.push({
        amount_cents: Math.abs(part.gross_cents), sh: part.gross_cents >= 0 ? 'S' : 'H', account, contra: debitor(ctx, d.contact_id),
        date: p.date, doc_no: d.number ?? '', text: latinize(`${p.discount_kind === 'skonto' ? 'Skonto' : 'Differenz'} ${d.recipient.name ?? ''}`),
      });
    }
  }

  // Payments received / refunded.
  for (const p of payments) {
    if (!inPeriod(p.date, period) || p.method === 'offset' || p.method === 'discount') continue;
    const d = docById.get(p.document_id);
    if (!d) continue;
    const bank = p.bank_tx_id
      ? (ctx.bankAccounts.get(bankTx.find((t) => t.id === p.bank_tx_id)?.account_id ?? '') ?? accountFor('ledger', 'bank', ctx.chart, ov).account)
      : accountFor('ledger', p.method === 'cash' ? 'cash' : p.method === 'bank' ? 'bank' : 'transit', ctx.chart, ov).account;
    out.push({
      amount_cents: Math.abs(p.amount_cents),
      // Positive = settles the document: money IN for an invoice, OUT for a
      // credit note (a refund). The bank is debited only when money came in.
      sh: (p.amount_cents >= 0) !== (d.type === 'credit_note') ? 'S' : 'H',
      account: bank,
      contra: debitor(ctx, d.contact_id),
      date: p.date,
      doc_no: d.number ?? '',
      text: latinize(`Zahlung ${d.recipient.name ?? ''}`),
    });
  }

  // Expenses — one booking per line.
  for (const e of expenses) {
    if (e.status === 'draft' || !inPeriod(e.date, period)) continue;
    const kred = kreditor(ctx, e.contact_id);
    const docNo = e.invoice_number || e.id.slice(0, 12);
    for (const l of e.lines) {
      const { account, automatic } = accountFor('exp', l.category, ctx.chart, ov);
      const gross = e.reverse_charge ? l.net_cents : l.net_cents + l.tax_cents;
      if (!gross) continue;
      out.push({
        amount_cents: Math.abs(gross),
        sh: gross >= 0 ? 'S' : 'H',
        account,
        contra: kred,
        bu: automatic ? '' : inputTaxKey(l.tax_rate, !!e.reverse_charge, ov),
        date: e.date,
        doc_no: docNo,
        text: latinize(`${e.supplier_name} ${l.description ?? categoryByKey(l.category).de}`),
        service_date: e.service_date,
        due_date: e.due_date,
      });
    }
    if (e.reverse_charge) warnings.push(`${docNo} (${e.supplier_name}): reverse-charge purchase exported with BU key ${inputTaxKey(19, true, ov)} — confirm the key with your Steuerberater.`);
    if (e.status === 'paid' && e.paid_date && inPeriod(e.paid_date, period) && !e.bank_tx_id) {
      out.push({
        // A supplier credit note (negative gross) paid back to us flips the side.
        amount_cents: Math.abs(e.gross_cents), sh: e.gross_cents >= 0 ? 'S' : 'H', account: kred,
        contra: accountFor('ledger', 'bank', ctx.chart, ov).account,
        date: e.paid_date, doc_no: docNo, text: latinize(`Zahlung ${e.supplier_name}`),
      });
    }
  }

  // Bank transactions: expense payments matched through the bank, and direct
  // bookings (bank fees) that have no document.
  for (const t of bankTx) {
    if (!inPeriod(t.booking_date, period)) continue;
    const bank = ctx.bankAccounts.get(t.account_id) ?? accountFor('ledger', 'bank', ctx.chart, ov).account;
    for (const m of t.matches ?? []) {
      if (m.kind !== 'expense') continue;
      const e = expenses.find((x) => x.id === m.id);
      out.push({
        amount_cents: Math.abs(m.amount_cents), sh: t.amount_cents < 0 ? 'S' : 'H', account: kreditor(ctx, e?.contact_id), contra: bank,
        date: t.booking_date, doc_no: e?.invoice_number || m.id.slice(0, 12), text: latinize(`Zahlung ${e?.supplier_name ?? t.counterparty_name ?? ''}`),
      });
    }
    if (t.category && !(t.matches?.length)) {
      const { account, automatic } = accountFor('exp', t.category, ctx.chart, ov);
      out.push({
        amount_cents: Math.abs(t.amount_cents),
        sh: t.amount_cents < 0 ? 'S' : 'H',
        account,
        contra: bank,
        // No receipt, no input tax (§15 UStG): booked gross, without a key.
        bu: '',
        date: t.booking_date,
        doc_no: t.bank_reference || t.id.slice(0, 12),
        text: latinize(`${t.counterparty_name ?? ''} ${t.purpose}`.trim()),
      });
    }
  }
  out.sort((a, b) => a.date.localeCompare(b.date) || a.doc_no.localeCompare(b.doc_no));
  return { bookings: out, warnings };
}
