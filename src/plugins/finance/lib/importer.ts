/**
 * Import jobs: Lexware Office (API) and contacts from CSV.
 *
 * A Lexware import of a few years of invoices takes minutes at 2 requests per
 * second, so it runs as a background job whose progress is stored and polled.
 * Re-running is safe: everything imported carries `external_ids.lexware` /
 * `external_ref = lexware:<id>` and is skipped the second time.
 */
import crypto from 'node:crypto';
import type { Contact, FinanceDocument } from './types';
import { COL, type Finance } from './service';
import { computeTotals } from './tax';
import { archiveFile } from './archive';
import {
  LexwareClient, mapArticle, mapContact, mapInvoiceAddress, mapInvoiceLines, mapTaxType, mapVoucherStatus,
  type LxArticle, type LxContact, type LxInvoice, type LxVoucher,
} from './lexware';
import { parseCsv } from './bank-parse';

export interface Job {
  id: string;
  kind: 'lexware';
  status: 'running' | 'done' | 'failed';
  started_at: string;
  finished_at?: string;
  progress: Record<string, number>;
  messages: string[];
  error?: string;
}

export interface LexwareImportOptions {
  apiKey: string;
  contacts?: boolean;
  articles?: boolean;
  invoices?: boolean;
  /** Only vouchers on/after this date (YYYY-MM-DD). */
  since?: string;
  fetch?: typeof fetch;
  pace?: number;
}

export async function startLexwareImport(fin: Finance, opts: LexwareImportOptions, actor: string): Promise<Job> {
  const job: Job = {
    id: `job_${crypto.randomBytes(6).toString('hex')}`, kind: 'lexware', status: 'running',
    started_at: new Date().toISOString(), progress: {}, messages: [],
  };
  await fin.store.put(COL.jobs, job.id, job as unknown as Record<string, unknown>);
  // Detached on purpose — the HTTP request returns the job id at once.
  void runLexwareImport(fin, opts, actor, job).catch(async (e) => {
    job.status = 'failed';
    job.error = (e as Error).message;
    job.finished_at = new Date().toISOString();
    await fin.store.put(COL.jobs, job.id, job as unknown as Record<string, unknown>);
  });
  return job;
}

export async function runLexwareImport(fin: Finance, opts: LexwareImportOptions, actor: string, job: Job): Promise<Job> {
  const client = new LexwareClient({ apiKey: opts.apiKey, fetch: opts.fetch, pace: opts.pace });
  const save = () => fin.store.put(COL.jobs, job.id, job as unknown as Record<string, unknown>);
  const bump = (k: string) => { job.progress[k] = (job.progress[k] ?? 0) + 1; };

  // Contacts first: invoices link to them.
  const byLexId = new Map<string, Contact>();
  for (const c of await fin.listContacts()) if (c.external_ids?.lexware) byLexId.set(c.external_ids.lexware, c);
  if (opts.contacts !== false) {
    for await (const lx of client.paged<LxContact>('/contacts')) {
      if (byLexId.has(lx.id)) { bump('contacts_skipped'); continue; }
      try {
        const c = await fin.createContact({ ...mapContact(lx), source: 'lexware', external_ids: { lexware: lx.id } }, actor);
        byLexId.set(lx.id, c);
        bump('contacts');
      } catch (e) {
        job.messages.push(`Contact ${lx.id}: ${(e as Error).message}`);
      }
      if ((job.progress.contacts ?? 0) % 25 === 0) await save();
    }
    await save();
  }

  if (opts.articles !== false) {
    const known = new Set((await fin.listArticles()).map((a) => a.external_ids?.lexware).filter(Boolean));
    for await (const a of client.paged<LxArticle>('/articles')) {
      if (known.has(a.id)) { bump('articles_skipped'); continue; }
      try {
        const saved = await fin.saveArticle(null, { ...mapArticle(a), source: 'lexware' }, actor);
        await fin.store.put(COL.articles, saved.id, { ...saved, external_ids: { lexware: a.id } });
        bump('articles');
      } catch (e) {
        job.messages.push(`Article ${a.title}: ${(e as Error).message}`);
      }
    }
    await save();
  }

  if (opts.invoices !== false) {
    const since = opts.since ? `&voucherDateFrom=${encodeURIComponent(opts.since)}` : '';
    const vouchers: LxVoucher[] = [];
    for await (const v of client.paged<LxVoucher>(`/voucherlist?voucherType=invoice,creditnote&voucherStatus=open,paid,paidoff,voided,transferred,sepadebit${since}`)) {
      vouchers.push(v);
    }
    job.progress.invoices_found = vouchers.length;
    await save();
    for (const v of vouchers) {
      const ref = `lexware:${v.id}`;
      if (await fin.store.get(COL.refs, ref)) { bump('invoices_skipped'); continue; }
      try {
        await importOneVoucher(fin, client, v, byLexId);
        bump('invoices');
      } catch (e) {
        job.messages.push(`${v.voucherNumber}: ${(e as Error).message}`);
      }
      if ((job.progress.invoices ?? 0) % 10 === 0) await save();
    }
  }
  job.status = 'done';
  job.finished_at = new Date().toISOString();
  await save();
  await fin.log(actor, 'import.lexware', 'import', job.id, JSON.stringify(job.progress));
  return job;
}

async function importOneVoucher(fin: Finance, client: LexwareClient, v: LxVoucher, contacts: Map<string, Contact>) {
  const path = v.voucherType === 'creditnote' ? `/credit-notes/${v.id}` : `/invoices/${v.id}`;
  const inv = await client.json<LxInvoice & { taxConditions?: { taxType?: string } }>(path);
  const treatment = mapTaxType(inv.taxConditions?.taxType);
  const gross = inv.taxConditions?.taxType === 'gross';
  const lines = mapInvoiceLines(inv, gross);
  const company = await fin.company();
  const totals = computeTotals(lines, treatment, gross ? 'gross' : 'net', company.document_language);
  const lxGross = Math.round((inv.totalPrice?.totalGrossAmount ?? v.totalAmount ?? 0) * 100);
  const contact = v.contactId ? contacts.get(v.contactId) : undefined;
  // Lexware's rounding is authoritative for its own invoices: keep its totals.
  if (lxGross && Math.abs(lxGross - totals.gross_cents) > 0) {
    totals.gross_cents = lxGross;
    totals.tax_cents = Math.round((inv.totalPrice?.totalTaxAmount ?? 0) * 100);
    totals.net_cents = Math.round((inv.totalPrice?.totalNetAmount ?? 0) * 100);
  }
  let pdfId: string | undefined;
  const fileRes = await client.request(`${path}/file`, 'application/pdf');
  if (fileRes.ok) {
    const bytes = new Uint8Array(await fileRes.arrayBuffer());
    pdfId = (await archiveFile(bytes, `${v.voucherNumber}.pdf`, 'pdf')).id;
  }
  const status = mapVoucherStatus(v.voucherStatus);
  const now = new Date().toISOString();
  const doc: FinanceDocument = {
    id: `doc_lx${v.id.replace(/-/g, '').slice(0, 20)}`,
    type: v.voucherType === 'creditnote' ? 'credit_note' : 'invoice',
    status: status === 'cancelled' ? 'cancelled' : status,
    number: v.voucherNumber,
    contact_id: contact?.id,
    recipient: { ...mapInvoiceAddress(inv), email: contact?.email },
    seller: company,
    title: inv.title,
    intro: inv.introduction,
    closing: inv.remark,
    currency: inv.totalPrice?.currency ?? v.currency ?? 'EUR',
    price_mode: gross ? 'gross' : 'net',
    tax_treatment: treatment,
    lines,
    issue_date: inv.voucherDate.slice(0, 10),
    service_date: inv.shippingConditions?.shippingDate?.slice(0, 10),
    service_date_end: inv.shippingConditions?.shippingEndDate?.slice(0, 10),
    due_date: (inv.dueDate ?? v.dueDate)?.slice(0, 10),
    totals,
    paid_cents: 0,
    einvoice_format: 'pdf',
    archived_pdf_id: pdfId,
    imported: true,
    source: 'lexware',
    external_ref: `lexware:${v.id}`,
    public_token: crypto.randomBytes(24).toString('base64url'),
    finalized_at: now,
    created_at: now,
    updated_at: now,
  };
  await fin.store.put(COL.documents, doc.id, doc as unknown as Record<string, unknown>);
  await fin.store.put(COL.numbers, v.voucherNumber, { document_id: doc.id, imported: true });
  await fin.store.put(COL.refs, doc.external_ref!, { document_id: doc.id });
  const open = Math.round((v.openAmount ?? 0) * 100);
  const paid = status === 'paid' ? totals.gross_cents : Math.max(0, totals.gross_cents - open);
  if (paid > 0 && status !== 'cancelled') {
    // The payment date is not in the voucher list; the voucher date stands in.
    // That matters only for Ist-Versteuerung — flagged in the job messages.
    await fin.store.put(COL.payments, `pay_lx${v.id.slice(0, 18)}`, {
      id: `pay_lx${v.id.slice(0, 18)}`, document_id: doc.id, amount_cents: paid, date: doc.issue_date!, method: 'other',
      note: 'Imported from Lexware (payment date unknown)', created_at: now,
    });
    await fin.store.put(COL.documents, doc.id, { ...doc, paid_cents: paid } as unknown as Record<string, unknown>);
  }
}

/* ------------------------------ CSV contacts ------------------------------ */

const CONTACT_HEADERS: Record<string, string[]> = {
  company_name: ['firma', 'firmenname', 'unternehmen', 'company', 'company name', 'name'],
  first_name: ['vorname', 'first name', 'firstname'],
  last_name: ['nachname', 'last name', 'lastname', 'name 2'],
  email: ['e-mail', 'email', 'e-mail-adresse', 'mail'],
  phone: ['telefon', 'phone', 'tel', 'telefonnummer'],
  street: ['straße', 'strasse', 'street', 'adresse', 'anschrift'],
  zip: ['plz', 'postleitzahl', 'zip', 'postal code'],
  city: ['ort', 'stadt', 'city'],
  country: ['land', 'country', 'ländercode', 'country code'],
  vat_id: ['ust-idnr.', 'ust-idnr', 'ustid', 'ust-id', 'vat id', 'vat'],
  customer_number: ['kundennummer', 'kunden-nr.', 'kundennr', 'customer number'],
};

export async function importContactsCsv(fin: Finance, content: string, actor: string): Promise<{ created: number; skipped: number; errors: string[] }> {
  const rows = parseCsv(content);
  if (rows.length < 2) return { created: 0, skipped: 0, errors: ['The file has no data rows.'] };
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (k: string) => CONTACT_HEADERS[k].map((a) => header.indexOf(a)).find((i) => i >= 0) ?? -1;
  const idx = Object.fromEntries(Object.keys(CONTACT_HEADERS).map((k) => [k, col(k)]));
  const existing = await fin.listContacts();
  const seen = new Set(existing.map((c) => (c.email ?? '').toLowerCase()).filter(Boolean));
  let created = 0;
  let skipped = 0;
  const errors: string[] = [];
  for (const [n, r] of rows.slice(1).entries()) {
    const g = (k: string) => (idx[k] >= 0 ? (r[idx[k]] ?? '').trim() : '');
    const email = g('email').toLowerCase();
    if (email && seen.has(email)) { skipped++; continue; }
    try {
      const country = g('country').toUpperCase();
      await fin.createContact({
        kind: g('company_name') ? 'company' : 'person', company_name: g('company_name') || undefined,
        first_name: g('first_name') || undefined, last_name: g('last_name') || undefined, email: email || undefined,
        phone: g('phone') || undefined, vat_id: g('vat_id') || undefined, customer_number: g('customer_number') || undefined,
        billing_address: { street: g('street'), zip: g('zip'), city: g('city'), country: /^[A-Z]{2}$/.test(country) ? country : 'DE' },
        source: 'csv',
      }, actor);
      if (email) seen.add(email);
      created++;
    } catch (e) {
      errors.push(`Row ${n + 2}: ${(e as Error).message}`);
    }
  }
  return { created, skipped, errors };
}

