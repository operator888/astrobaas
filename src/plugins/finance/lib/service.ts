/**
 * The finance module's business logic, over the plugin's namespaced store.
 *
 * Every write goes through here, so the rules live in one place:
 *
 *  - drafts are freely editable; finalized documents are not (GoBD) — they
 *    are corrected with a credit note, never edited or deleted;
 *  - numbers are assigned at finalization, under a lock, from a per-period
 *    counter, and every issued number is recorded so it can never repeat;
 *  - totals are recomputed on every write from the lines — an API caller
 *    cannot send its own totals;
 *  - every change is appended to a hash-chained log.
 *
 * The store is a key/value store with a 5,000-record cap per `list()`.
 * Collections that grow without bound (bank transactions, the log) are
 * split per year to stay far below it; documents, contacts and expenses for a
 * one-person agency stay in the hundreds per year.
 */
import crypto from 'node:crypto';
import type { PluginStore } from 'astrobaas/core';
import type {
  Article, BankAccount, BankTransaction, CompanyProfile, Contact, Counter, DocumentType, Expense,
  FinanceDocument, FinanceSettings, LogEntry, Payment, RecurringExpense, RecurringTemplate, TaxTreatment,
} from './types';
import { computeTotals, dueCents, leitwegIdValid, skontoFor, splitByGroups, suggestTreatment, withDeductions } from './tax';
import { nextNumber, patternProblem, periodKey } from './numbering';
import { addDays, addMonthsAnchored, contactDisplayName, daysBetween, formatMoney, legalName, todayIso } from './format';
import {
  FinanceError, asObj, normArticle, normCompany, normContact, normExpenseLines, normLines, normRecurring,
  normSkonto, readCents, readDate, str, treatment as readTreatment,
} from './normalize';
import { DEFAULT_COMPANY, DEFAULT_SETTINGS } from './defaults';
import { buildCii, preflight } from './einvoice-cii';
import { renderDocumentPdf, renderDunningPdf, pdfFilename } from './pdf';
import { archiveFile, readArchived } from './archive';
import { autoMatch, suggestMatches, type OpenItem } from './matching';
import { parseStatement } from './bank-parse';
import { parseEInvoice, type ParsedEInvoice } from './einvoice-parse';
import { extractEmbeddedXml } from './facturx';
import { DOC_STRINGS } from './strings';

export const COL = {
  config: 'config',
  contacts: 'contacts',
  articles: 'articles',
  documents: 'documents',
  counters: 'counters',
  numbers: 'numbers',
  refs: 'refs',
  payments: 'payments',
  expenses: 'expenses',
  bankAccounts: 'bank_accounts',
  bankTx: (year: string) => `bank_tx_${year}`,
  recurring: 'recurring',
  recurringExpenses: 'recurring_expenses',
  log: (year: string) => `log_${year}`,
  dunnings: 'dunnings',
  jobs: 'jobs',
} as const;

export interface Deps {
  /** Embedded font for PDFs. */
  fontBytes: () => Promise<Uint8Array>;
  /** Fire an outbound webhook event. */
  fire?: (event: string, data: unknown) => void;
  /** Send an email (with optional attachments). */
  sendEmail?: (msg: { to: string; subject: string; text: string; replyTo?: string; attachments?: { filename: string; contentType: string; content: Uint8Array }[] }) => Promise<unknown>;
  /** Absolute origin for customer links, e.g. https://cms.example.com */
  siteUrl?: () => Promise<string>;
  /**
   * Does mail actually leave this server? False while it only goes to the
   * console, where "Sent" would be a lie the operator acts on.
   */
  emailStatus?: () => { active: boolean; label: string | null };
  now?: () => Date;
}

/* ------------------------------------------------------------------ *
 * A process-wide lock. Number assignment and payment bookkeeping are
 * read-modify-write on the store; serialising them is what keeps two
 * concurrent finalizations from drawing the same number.
 * ------------------------------------------------------------------ */
/**
 * Bookkeeping records are kept for ten years and must never silently drop
 * off the end of a list, so every finance list reads the whole collection.
 */
const ALL = { uncapped: true } as const;

let chain: Promise<unknown> = Promise.resolve();
export function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}

/**
 * A second, independent lock for bank matching. Matching calls
 * recordPayment, which takes the main lock — so it cannot run under the main
 * lock itself, but two matches of one transaction must still be serialised.
 */
let bankChain: Promise<unknown> = Promise.resolve();
function withBankLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = bankChain.then(fn, fn);
  bankChain = run.catch(() => undefined);
  return run;
}

/**
 * One run per key at a time, in this process. A second caller with the same
 * key waits for the first and gets its result — a retried webhook or a double
 * click must never issue a second invoice or a second credit note.
 */
const inflight = new Map<string, Promise<unknown>>();
export function singleFlight<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const running = inflight.get(key);
  if (running) return running as Promise<T>;
  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

function id(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(9).toString('base64url')}`;
}

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

/** Canonical JSON — sorted keys — so a hash is stable across key order. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

export class Finance {
  constructor(readonly store: PluginStore, readonly deps: Deps) {}

  now(): Date { return this.deps.now?.() ?? new Date(); }
  today(): string { return todayIso(this.now()); }
  stamp(): string { return this.now().toISOString(); }

  /* ----------------------------- config ----------------------------- */

  async company(): Promise<CompanyProfile> {
    const c = await this.store.get<CompanyProfile>(COL.config, 'company');
    return { ...DEFAULT_COMPANY, ...(c ?? {}) };
  }

  async saveCompany(input: unknown, actor: string): Promise<CompanyProfile> {
    const before = await this.company();
    const next = normCompany(input, before);
    await this.store.put(COL.config, 'company', next as unknown as Record<string, unknown>);
    await this.log(actor, 'company.update', 'company', 'company', 'Company profile updated');
    return next;
  }

  async settings(): Promise<FinanceSettings> {
    const s = await this.store.get<Partial<FinanceSettings>>(COL.config, 'settings');
    return {
      ...DEFAULT_SETTINGS,
      ...(s ?? {}),
      series: { ...DEFAULT_SETTINGS.series, ...(s?.series ?? {}) },
      texts: { ...DEFAULT_SETTINGS.texts, ...(s?.texts ?? {}) },
      dunning: { ...DEFAULT_SETTINGS.dunning, ...(s?.dunning ?? {}) },
      account_overrides: { ...(s?.account_overrides ?? {}) },
    };
  }

  async saveSettings(input: unknown, actor: string): Promise<FinanceSettings> {
    const cur = await this.settings();
    const i = asObj(input);
    const next: FinanceSettings = { ...cur };
    if (i.series) {
      const series = asObj(i.series);
      for (const t of ['invoice', 'credit_note', 'quote'] as DocumentType[]) {
        if (!series[t]) continue;
        const s = asObj(series[t]);
        const pattern = String(s.pattern ?? cur.series[t].pattern);
        const problem = patternProblem(pattern);
        if (problem) throw new FinanceError(`${t}: ${problem}`);
        next.series = { ...next.series, [t]: { pattern, reset: s.reset === 'monthly' || s.reset === 'never' ? s.reset : 'yearly' } };
      }
    }
    if (i.texts) {
      const t = asObj(i.texts);
      next.texts = { ...cur.texts };
      for (const k of Object.keys(cur.texts) as (keyof FinanceSettings['texts'])[]) {
        if (k in t) next.texts[k] = String(t[k] ?? '').slice(0, 4000);
      }
    }
    if (i.dunning) {
      const d = asObj(i.dunning);
      const tri = <T>(v: unknown, fb: [T, T, T], map: (x: unknown) => T): [T, T, T] =>
        Array.isArray(v) && v.length === 3 ? [map(v[0]), map(v[1]), map(v[2])] : fb;
      next.dunning = {
        level_days: tri(d.level_days, cur.dunning.level_days, (x) => Math.max(0, Math.round(Number(x) || 0))),
        fees_cents: tri(d.fees_cents, cur.dunning.fees_cents, (x) => Math.max(0, Math.round(Number(x) || 0))),
        titles: tri(d.titles, cur.dunning.titles, (x) => String(x ?? '').slice(0, 100)),
        texts: tri(d.texts, cur.dunning.texts, (x) => String(x ?? '').slice(0, 4000)),
        charge_interest: 'charge_interest' in d ? !!d.charge_interest : cur.dunning.charge_interest,
        base_rate_percent: 'base_rate_percent' in d ? Number(d.base_rate_percent) || 0 : cur.dunning.base_rate_percent,
      };
    }
    if ('auto_invoice_shop_orders' in i) next.auto_invoice_shop_orders = !!i.auto_invoice_shop_orders;
    if ('auto_run_recurring' in i) next.auto_run_recurring = !!i.auto_run_recurring;
    if ('datev_use_personal_accounts' in i) next.datev_use_personal_accounts = !!i.datev_use_personal_accounts;
    if (i.account_overrides) {
      const o: Record<string, number> = {};
      for (const [k, v] of Object.entries(asObj(i.account_overrides))) {
        const n = Math.round(Number(v));
        if (/^(rev|exp|ledger|bu):[a-z0-9_:]+$/.test(k) && n > 0) o[k] = n;
      }
      next.account_overrides = o;
    }
    await this.store.put(COL.config, 'settings', next as unknown as Record<string, unknown>);
    await this.log(actor, 'settings.update', 'settings', 'settings', 'Module settings updated');
    return next;
  }

  /* ----------------------------- audit log ----------------------------- */

  async log(actor: string, action: string, entity: string, entityId: string, summary?: string, diff?: LogEntry['diff']): Promise<void> {
    await withLockedLog(async () => {
      const head = await this.store.get<{ hash: string; seq?: number }>(COL.config, 'log_head');
      const at = this.stamp();
      // A sequence number, not the clock, orders the chain: two changes in
      // the same millisecond must still have one defined order.
      const seq = (head?.seq ?? 0) + 1;
      const entry: Omit<LogEntry, 'hash'> = {
        id: `log_${String(seq).padStart(9, '0')}`,
        seq, at, actor, action, entity, entity_id: entityId, summary, diff, prev_hash: head?.hash ?? '0'.repeat(64),
      };
      const hash = sha256(canonical(entry));
      await this.store.put(COL.log(at.slice(0, 4)), entry.id, { ...entry, hash });
      await this.store.put(COL.config, 'log_head', { hash, at, seq });
    });
  }

  async listLog(year: string): Promise<LogEntry[]> {
    const rows = await this.store.list<LogEntry>(COL.log(year), ALL);
    return rows.map((r) => r.data).sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Re-walk a year's chain. A broken link means a record was altered or removed. */
  async verifyLog(year: string): Promise<{ ok: boolean; entries: number; broken_at?: string }> {
    const entries = await this.listLog(year);
    // The chain continues across years: the first entry must point at the
    // last entry of the nearest earlier year that has any.
    let before: LogEntry[] = [];
    for (let y = Number(year) - 1; y >= Number(year) - 30 && !before.length; y--) before = await this.listLog(String(y));
    const last = before[before.length - 1];
    let prev: string = last ? last.hash : '0'.repeat(64);
    let prevSeq: number = last ? last.seq : 0;
    for (const e of entries) {
      const { hash, ...rest } = e;
      if (sha256(canonical(rest)) !== hash) return { ok: false, entries: entries.length, broken_at: e.id };
      // Hash link AND gap-free sequence: a removed first entry (or a removed
      // earlier year) leaves the hashes intact but the sequence jumps.
      if (e.prev_hash !== prev || e.seq !== prevSeq + 1) return { ok: false, entries: entries.length, broken_at: e.id };
      prev = hash;
      prevSeq = e.seq;
    }
    // Deleted newest entries leave the chain intact but behind the head.
    const head = await this.store.get<{ hash: string; seq?: number; at?: string }>(COL.config, 'log_head');
    if (head?.at?.slice(0, 4) === year && (!entries.length || head.hash !== entries[entries.length - 1].hash)) {
      return { ok: false, entries: entries.length, broken_at: 'head' };
    }
    return { ok: true, entries: entries.length };
  }

  /* ----------------------------- contacts ----------------------------- */

  async listContacts(): Promise<Contact[]> {
    return (await this.store.list<Contact>(COL.contacts, ALL)).map((r) => r.data);
  }

  async getContact(cid: string): Promise<Contact> {
    const c = await this.store.get<Contact>(COL.contacts, cid);
    if (!c) throw new FinanceError('Contact not found.', 404);
    return c;
  }

  async createContact(input: unknown, actor: string): Promise<Contact> {
    return withLock(async () => {
      const data = normContact(input);
      const settings = await this.settings();
      const contacts = await this.listContacts();
      const now = this.stamp();
      const contact: Contact = { ...data, id: id('ct'), created_at: now, updated_at: now };
      // Numbers and DATEV accounts are assigned here so they are stable.
      if (contact.roles.customer && !contact.customer_number) {
        const max = contacts.reduce((m, c) => Math.max(m, Number(c.customer_number) || 0), settings.next_debitor - 1);
        contact.customer_number = String(max + 1);
      }
      if (contact.roles.vendor && !contact.vendor_number) {
        const max = contacts.reduce((m, c) => Math.max(m, Number(c.vendor_number) || 0), settings.next_kreditor - 1);
        contact.vendor_number = String(max + 1);
      }
      if (!contact.datev_account) {
        const n = Number(contact.roles.customer ? contact.customer_number : contact.vendor_number);
        if (n >= 10000 && n <= 99999) contact.datev_account = n;
      }
      await this.store.put(COL.contacts, contact.id, contact as unknown as Record<string, unknown>);
      await this.log(actor, 'contact.create', 'contact', contact.id, contactDisplayName(contact));
      return contact;
    });
  }

  async updateContact(cid: string, input: unknown, actor: string): Promise<Contact> {
    const before = await this.getContact(cid);
    const data = normContact(input, before);
    const next: Contact = { ...before, ...data, id: cid, updated_at: this.stamp() };
    await this.store.put(COL.contacts, cid, next as unknown as Record<string, unknown>);
    await this.log(actor, 'contact.update', 'contact', cid, contactDisplayName(next));
    return next;
  }

  /** Find or create a contact by external id / email / VAT id — for integrations. */
  async upsertContact(input: unknown, source: string, externalId: string | undefined, actor: string): Promise<Contact> {
    const i = asObj(input);
    const contacts = await this.listContacts();
    const email = typeof i.email === 'string' ? i.email.trim().toLowerCase() : '';
    const vat = typeof i.vat_id === 'string' ? i.vat_id.replace(/\s+/g, '').toUpperCase() : '';
    const found = contacts.find((c) => (externalId && c.external_ids?.[source] === externalId))
      ?? contacts.find((c) => vat && c.vat_id === vat)
      ?? contacts.find((c) => email && (c.email?.toLowerCase() === email || c.invoice_email?.toLowerCase() === email));
    if (found) {
      if (externalId && found.external_ids?.[source] !== externalId) {
        const next = { ...found, external_ids: { ...(found.external_ids ?? {}), [source]: externalId }, updated_at: this.stamp() };
        await this.store.put(COL.contacts, found.id, next as unknown as Record<string, unknown>);
        return next;
      }
      return found;
    }
    return this.createContact({ ...i, source, external_ids: externalId ? { [source]: externalId } : undefined }, actor);
  }

  /* ----------------------------- articles ----------------------------- */

  async listArticles(): Promise<Article[]> {
    return (await this.store.list<Article>(COL.articles, ALL)).map((r) => r.data);
  }

  async saveArticle(aid: string | null, input: unknown, actor: string): Promise<Article> {
    const before = aid ? await this.store.get<Article>(COL.articles, aid) : undefined;
    if (aid && !before) throw new FinanceError('Article not found.', 404);
    const now = this.stamp();
    const a: Article = { ...normArticle(input, before), id: aid ?? id('ar'), created_at: before?.created_at ?? now, updated_at: now };
    await this.store.put(COL.articles, a.id, a as unknown as Record<string, unknown>);
    await this.log(actor, aid ? 'article.update' : 'article.create', 'article', a.id, a.title);
    return a;
  }

  async deleteArticle(aid: string, actor: string): Promise<void> {
    await this.store.delete(COL.articles, aid);
    await this.log(actor, 'article.delete', 'article', aid);
  }

  /* ----------------------------- documents ----------------------------- */

  async listDocuments(filter: { type?: DocumentType; status?: string; contact_id?: string } = {}): Promise<FinanceDocument[]> {
    const rows = (await this.store.list<FinanceDocument>(COL.documents, ALL)).map((r) => r.data);
    return rows
      .filter((d) => !filter.type || d.type === filter.type)
      .filter((d) => !filter.status || d.status === filter.status || (filter.status === 'overdue' && this.isOverdue(d)))
      .filter((d) => !filter.contact_id || d.contact_id === filter.contact_id)
      .sort((a, b) => (b.issue_date ?? b.created_at).localeCompare(a.issue_date ?? a.created_at));
  }

  /**
   * Refuse to "send" when nothing can deliver. With the default console
   * transport sendEmail succeeds by printing to a log, which would stamp an
   * invoice "sent" that the customer never received.
   */
  private requireRealEmail(): void {
    if (!this.deps.sendEmail) throw new FinanceError('Email is not configured on this server.', 503);
    const st = this.deps.emailStatus?.();
    if (st && !st.active) {
      throw new FinanceError('E-Mail-Versand ist nicht eingerichtet: Mails werden nur in die Server-Konsole geschrieben. Setze EMAIL_TRANSPORT=smtp (SMTP_HOST, SMTP_USER, SMTP_PASS, EMAIL_FROM) oder aktiviere das SMTP2GO-Plugin.', 503);
    }
  }

  /** Mail can really leave: a sender exists and the channel is not the console stub. */
  private canSendMail(): boolean {
    return !!this.deps.sendEmail && this.emailStatus().active;
  }

  /** Whether outgoing mail is real (see Deps.emailStatus). Unknown counts as not active. */
  emailStatus(): { active: boolean; label: string | null } {
    return this.deps.emailStatus?.() ?? { active: false, label: null };
  }

  isOverdue(d: FinanceDocument): boolean {
    return d.type === 'invoice' && (d.status === 'open' || d.status === 'partially_paid') && !!d.due_date && d.due_date < this.today();
  }

  async getDocument(did: string): Promise<FinanceDocument> {
    const d = await this.store.get<FinanceDocument>(COL.documents, did);
    if (!d) throw new FinanceError('Document not found.', 404);
    return d;
  }

  private async putDocument(d: FinanceDocument): Promise<void> {
    await this.store.put(COL.documents, d.id, d as unknown as Record<string, unknown>);
  }

  /**
   * Change a few fields of a stored document under the lock, on a FRESH read.
   * Slow work (PDF, SMTP) happens before; writing back a copy read before it
   * would overwrite a payment booked in the meantime.
   */
  private patchDocument(did: string, patch: (d: FinanceDocument) => Partial<FinanceDocument>): Promise<FinanceDocument> {
    return withLock(async () => {
      const cur = await this.getDocument(did);
      const next = { ...cur, ...patch(cur), updated_at: this.stamp() } as FinanceDocument;
      await this.putDocument(next);
      return next;
    });
  }

  /** Totals of a document as stored: lines → VAT groups, then down payments deducted. */
  private totalsOf(d: Pick<FinanceDocument, 'lines' | 'tax_treatment' | 'price_mode' | 'deducts'>, lang: 'de' | 'en'): FinanceDocument['totals'] {
    return withDeductions(computeTotals(d.lines, d.tax_treatment, d.price_mode, lang), d.deducts);
  }

  /**
   * The down-payment invoices a final invoice deducts, frozen as snapshots.
   * Each must be a finalized, uncancelled Abschlagsrechnung of the same
   * customer, and not already settled by another final invoice.
   */
  private async deductionsFor(ids: unknown, contactId: string | undefined, selfId?: string): Promise<FinanceDocument['deducts']> {
    if (!Array.isArray(ids) || !ids.length) return undefined;
    const all = await this.listDocuments({ type: 'invoice' });
    const out: NonNullable<FinanceDocument['deducts']> = [];
    for (const raw of ids.slice(0, 50)) {
      const p = all.find((d) => d.id === String(raw));
      if (!p || p.invoice_kind !== 'partial' || p.status === 'draft' || p.status === 'cancelled') {
        throw new FinanceError('A final invoice can only deduct finalized down-payment invoices (Abschlagsrechnungen).', 422);
      }
      if (contactId && p.contact_id !== contactId) throw new FinanceError(`Down-payment invoice ${p.number} belongs to another customer.`, 422);
      const taken = all.find((d) => d.id !== selfId && d.invoice_kind === 'final' && d.status !== 'cancelled' && d.deducts?.some((x) => x.id === p.id));
      if (taken) throw new FinanceError(`Down-payment invoice ${p.number} is already settled by ${taken.number ?? 'another final invoice draft'}.`, 409);
      out.push({ id: p.id, number: p.number!, net_cents: p.totals.net_cents, tax_cents: p.totals.tax_cents, gross_cents: p.totals.gross_cents, groups: p.totals.groups });
    }
    return out;
  }

  private recipientFromContact(c: Contact): FinanceDocument['recipient'] {
    return {
      name: contactDisplayName(c),
      ...c.billing_address,
      // A company with a named person: the person goes on the supplement line.
      supplement: c.billing_address.supplement ?? (c.company_name && c.last_name ? [c.salutation, c.first_name, c.last_name].filter(Boolean).join(' ') : undefined),
      email: c.invoice_email || c.email,
      vat_id: c.vat_id,
      tax_number: c.tax_number,
      buyer_reference: c.buyer_reference,
    };
  }

  /** Build a draft from API input. Shared by create and update. */
  private async draftFields(i: Record<string, unknown>, base: Partial<FinanceDocument>, type: DocumentType) {
    const company = await this.company();
    const settings = await this.settings();
    let contact: Contact | undefined;
    const contactId = 'contact_id' in i ? str(i.contact_id, 60) : base.contact_id;
    if (contactId) contact = await this.getContact(contactId);
    let recipient = base.recipient;
    if ('recipient' in i) {
      const r = asObj(i.recipient);
      recipient = {
        name: str(r.name, 200), supplement: str(r.supplement, 200), street: str(r.street, 200),
        zip: str(r.zip, 20), city: str(r.city, 100), country: (str(r.country, 2) ?? 'DE').toUpperCase(),
        email: str(r.email, 254), vat_id: str(r.vat_id, 20)?.replace(/\s+/g, '').toUpperCase(),
        tax_number: str(r.tax_number, 30), buyer_reference: str(r.buyer_reference, 100),
      };
    } else if (contact && (contactId !== base.contact_id || !recipient)) {
      recipient = this.recipientFromContact(contact);
    }
    if (!recipient?.name) throw new FinanceError('The document needs a recipient (contact_id or recipient.name).');
    const lines = 'lines' in i ? normLines(i.lines) : base.lines ?? [];
    const kind = i.supply_kind === 'goods' ? 'goods' : 'service';
    const tt: TaxTreatment = readTreatment(i.tax_treatment) ?? base.tax_treatment
      ?? suggestTreatment(company, { country: recipient.country, vat_id: recipient.vat_id }, kind);
    const priceMode = ('price_mode' in i ? (i.price_mode === 'gross' ? 'gross' : 'net') : base.price_mode) ?? 'net';
    const paymentDays = 'payment_days' in i ? Math.max(0, Math.round(Number(i.payment_days) || 0)) : base.payment_days ?? contact?.payment_days ?? company.default_payment_days;
    const invoiceKind: FinanceDocument['invoice_kind'] = type !== 'invoice' ? undefined
      : 'invoice_kind' in i ? (i.invoice_kind === 'partial' || i.invoice_kind === 'final' ? i.invoice_kind : 'standard') : base.invoice_kind;
    const deducts = invoiceKind === 'final'
      ? ('deducts' in i ? await this.deductionsFor(i.deducts, contactId, base.id) : base.deducts)
      : undefined;
    const skonto = type !== 'invoice' ? undefined
      : 'skonto' in i ? normSkonto(i.skonto) : base.id ? base.skonto : (contact?.skonto ?? company.default_skonto);
    const texts = settings.texts;
    const defaultIntro = type === 'quote' ? texts.quote_intro : type === 'credit_note' ? texts.credit_note_intro : texts.invoice_intro;
    const defaultClosing = type === 'quote' ? texts.quote_closing : texts.invoice_closing;
    return {
      contact_id: contactId,
      recipient,
      title: 'title' in i ? str(i.title, 200) : base.title,
      reference: 'reference' in i ? str(i.reference, 120) : base.reference,
      intro: 'intro' in i ? str(i.intro, 4000) : base.intro ?? defaultIntro,
      closing: 'closing' in i ? str(i.closing, 4000) : base.closing ?? defaultClosing,
      currency: ('currency' in i ? str(i.currency, 3)?.toUpperCase() : base.currency) ?? company.default_currency,
      price_mode: priceMode as 'net' | 'gross',
      tax_treatment: tt,
      lines,
      issue_date: 'issue_date' in i ? readDate(i.issue_date, 'issue_date') : base.issue_date,
      service_date: 'service_date' in i ? readDate(i.service_date, 'service_date') : base.service_date,
      service_date_end: 'service_date_end' in i ? readDate(i.service_date_end, 'service_date_end') : base.service_date_end,
      valid_until: 'valid_until' in i ? readDate(i.valid_until, 'valid_until') : base.valid_until,
      payment_days: paymentDays,
      payment_terms_text: 'payment_terms_text' in i ? str(i.payment_terms_text, 500) : base.payment_terms_text,
      einvoice_format: (['pdf', 'zugferd', 'xrechnung'].includes(String(i.einvoice_format)) ? i.einvoice_format : base.einvoice_format ?? contact?.einvoice_format ?? 'zugferd') as FinanceDocument['einvoice_format'],
      internal_note: 'internal_note' in i ? str(i.internal_note, 4000) : base.internal_note,
      tags: Array.isArray(i.tags) ? i.tags.map((t) => String(t).slice(0, 40)).slice(0, 20) : base.tags,
      skonto,
      invoice_kind: invoiceKind,
      deducts,
      totals: this.totalsOf({ lines, tax_treatment: tt, price_mode: priceMode as 'net' | 'gross', deducts }, company.document_language),
    };
  }

  async createDocument(input: unknown, actor: string, extra: Partial<FinanceDocument> = {}): Promise<FinanceDocument> {
    const i = asObj(input);
    const type: DocumentType = i.type === 'quote' || i.type === 'credit_note' ? i.type : 'invoice';
    const fields = await this.draftFields(i, {}, type);
    const now = this.stamp();
    const doc: FinanceDocument = {
      ...fields,
      id: id('doc'),
      type,
      status: 'draft',
      paid_cents: 0,
      source: extra.source ?? str(i.source, 60),
      external_ref: extra.external_ref,
      refers_to_id: extra.refers_to_id,
      refers_to_number: extra.refers_to_number,
      from_quote_id: extra.from_quote_id,
      recurring_id: extra.recurring_id,
      created_at: now,
      updated_at: now,
    };
    await this.putDocument(doc);
    if (doc.external_ref) await this.store.put(COL.refs, doc.external_ref, { document_id: doc.id });
    await this.log(actor, 'document.create', doc.type, doc.id, `${doc.type} draft for ${doc.recipient.name}`);
    return doc;
  }

  async updateDocument(did: string, input: unknown, actor: string): Promise<FinanceDocument> {
    // Under the lock: a draft edited while it is being finalized must not be
    // written back as a draft over the finalized document.
    return withLock(() => this.updateDocumentLocked(did, input, actor));
  }

  private async updateDocumentLocked(did: string, input: unknown, actor: string): Promise<FinanceDocument> {
    const before = await this.getDocument(did);
    const i = asObj(input);
    if (before.status !== 'draft') {
      // GoBD: a finalized document's content is frozen. Only bookkeeping notes
      // that never appear on the document may still change.
      const allowed = ['internal_note', 'tags'];
      const blocked = Object.keys(i).filter((k) => !allowed.includes(k));
      if (blocked.length) {
        throw new FinanceError(`This ${before.type} is finalized and can no longer be changed (${blocked.join(', ')}). Create a credit note to correct an invoice.`, 409);
      }
      const next = { ...before, internal_note: 'internal_note' in i ? str(i.internal_note, 4000) : before.internal_note, tags: Array.isArray(i.tags) ? i.tags.map(String).slice(0, 20) : before.tags, updated_at: this.stamp() };
      await this.putDocument(next);
      await this.log(actor, 'document.note', before.type, did, 'Internal note/tags changed');
      return next;
    }
    const fields = await this.draftFields(i, before, before.type);
    const next: FinanceDocument = { ...before, ...fields, updated_at: this.stamp() };
    await this.putDocument(next);
    await this.log(actor, 'document.update', before.type, did, 'Draft updated');
    return next;
  }

  async deleteDraft(did: string, actor: string): Promise<void> {
    return withLock(() => this.deleteDraftLocked(did, actor));
  }

  private async deleteDraftLocked(did: string, actor: string): Promise<void> {
    const d = await this.getDocument(did);
    if (d.status !== 'draft') throw new FinanceError('Only drafts can be deleted. Finalized documents are kept (GoBD); cancel an invoice with a credit note instead.', 409);
    await this.store.delete(COL.documents, did);
    if (d.external_ref) await this.store.delete(COL.refs, d.external_ref);
    await this.log(actor, 'document.delete', d.type, did, 'Draft deleted');
  }

  /** Validation the user sees BEFORE finalizing. */
  async check(did: string): Promise<{ errors: string[]; warnings: string[] }> {
    const stored = await this.getDocument(did);
    const company = await this.company();
    // Check what finalize will actually write: the contact's current address
    // fills whatever the draft left empty (it may have been fixed since).
    const contact = stored.status === 'draft' && stored.contact_id ? await this.store.get<Contact>(COL.contacts, stored.contact_id) : undefined;
    const d: FinanceDocument = contact ? { ...stored, recipient: { ...this.recipientFromContact(contact), ...pickDefined(stored.recipient) } } : stored;
    const probe: FinanceDocument = { ...d, seller: company, number: d.number ?? 'PREVIEW', issue_date: d.issue_date ?? this.today() };
    const errors: string[] = [];
    const warnings: string[] = [];
    if (!d.lines.some((l) => l.type === 'item')) errors.push('Add at least one billable line.');
    // EN 16931 BR-27: an item price is never negative. A discount or a
    // returned item goes in with a negative QUANTITY instead.
    d.lines.forEach((l, n) => {
      if (l.type === 'item' && l.unit_price_cents < 0) errors.push(`Line ${n + 1}: the unit price must not be negative — use a negative quantity for a deduction.`);
    });
    if (d.type !== 'quote' && d.lines.some((l) => l.optional || l.alternative)) {
      errors.push('Optional and alternative lines belong in quotes only — remove the flag or the line.');
    }
    if (d.invoice_kind === 'final') {
      if (!d.deducts?.length) warnings.push('This final invoice deducts no down payments — pick the Abschlagsrechnungen it settles.');
      else {
        try { await this.deductionsFor(d.deducts.map((x) => x.id), d.contact_id, d.id); } catch (e) { errors.push((e as Error).message); }
        if (dueCents(d) < 0) errors.push('The down payments exceed the final invoice total — correct the amounts or issue a credit note.');
      }
    }
    if (d.einvoice_format === 'xrechnung' && leitwegIdValid(d.recipient.buyer_reference) === false) {
      warnings.push(`The Leitweg-ID "${d.recipient.buyer_reference}" fails its check digits — the authority's portal would not route this invoice. Copy it again from the order.`);
    }
    if (d.skonto && d.skonto.days >= (d.payment_days ?? company.default_payment_days)) {
      warnings.push(`The Skonto period (${d.skonto.days} days) is not shorter than the payment term — customers will always deduct it.`);
    }
    if (d.type !== 'quote' && d.totals.gross_cents < 0) {
      errors.push(d.type === 'invoice'
        ? 'The invoice total is negative — issue a credit note instead.'
        : 'The credit note total is negative — enter the amounts as positive values.');
    }
    if (d.type !== 'quote' && d.einvoice_format !== 'pdf') {
      const pf = preflight(probe, d.einvoice_format === 'xrechnung' ? 'xrechnung' : 'en16931');
      errors.push(...pf.errors.filter((e) => !/finalize it first/.test(e)));
      warnings.push(...pf.warnings);
    } else {
      if (!company.name || !company.street) errors.push('Fill in the company profile first (Settings → Company).');
    }
    if (company.small_business && d.tax_treatment !== 'small_business') warnings.push('Your company is a Kleinunternehmer, but this document charges VAT — that VAT would be owed (§14c UStG).');
    if (!company.small_business && d.tax_treatment === 'small_business') errors.push('This document uses the Kleinunternehmer rule, but your company profile is not a Kleinunternehmer.');
    if (d.tax_treatment === 'domestic' && d.lines.some((l) => l.type === 'item' && ![19, 7, 0].includes(l.tax_rate))) {
      // Another EU state's rate (OSS) is not supported yet: it would vanish
      // from the VAT return and have no revenue account.
      errors.push('Only the German VAT rates 19 %, 7 % and 0 % are supported. Sales at another country\'s rate (OSS) are not supported yet.');
    }
    if (d.currency !== 'EUR') errors.push('Only EUR documents are supported for now (VAT return and DATEV are in EUR).');
    if (d.type !== 'quote') {
      // §14 Abs. 4 UStG applies whatever the file format.
      if (!company.vat_id && !company.tax_number) errors.push('Your company needs a tax number or VAT id (§14 Abs. 4 Nr. 2 UStG) — Settings → Company.');
      if (!d.recipient.name || !d.recipient.city) errors.push('The recipient needs a name and an address (§14 Abs. 4 Nr. 1 UStG).');
      if (d.tax_treatment === 'reverse_charge_eu' || d.tax_treatment === 'intra_community_supply') {
        if (!company.vat_id) errors.push('Reverse charge / intra-Community supply needs YOUR VAT id (§14a UStG).');
        if (!d.recipient.vat_id) errors.push('Reverse charge / intra-Community supply needs the CUSTOMER\'s VAT id (§14a UStG).');
      }
    }
    if (d.type === 'invoice' && d.issue_date && daysBetween(d.issue_date, this.today()) > 30) warnings.push('The issue date is more than 30 days in the past.');
    // A zero-priced line is legal (a free item, an included service) but far
    // more often an amount that was never typed — and a finalized invoice
    // cannot be corrected, only cancelled. Say so before the point of no return.
    d.lines.filter((l) => l.type === 'item').forEach((l, i) => {
      if (l.unit_price_cents === 0) warnings.push(`Line ${i + 1} ("${l.name || '—'}") has a price of 0,00 — check that this is intended.`);
    });
    return { errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
  }

  /**
   * Finalize: assign the number, freeze seller and buyer, archive the PDF and
   * XML exactly as they will be sent. Irreversible by design.
   */
  async finalize(did: string, actor: string): Promise<FinanceDocument> {
    const result = await withLock(async () => {
      const d = await this.getDocument(did);
      if (d.status !== 'draft') throw new FinanceError('Already finalized.', 409);
      const { errors } = await this.check(did);
      if (errors.length) throw new FinanceError(errors.join(' '), 422);
      const company = await this.company();
      const settings = await this.settings();
      const issue = d.issue_date ?? this.today();
      const series = settings.series[d.type];
      const period = periodKey(series, issue);
      const counterKey = `${d.type}:${period}`;
      const counter = await this.store.get<Counter>(COL.counters, counterKey);
      let { number, counter: nextCounter } = nextNumber(series, issue, counter);
      // Belt and braces: never reuse a number that was ever issued, even if a
      // counter was reset or a pattern changed into an older one.
      let guard = 0;
      while (await this.store.get(COL.numbers, number)) {
        if (++guard > 1000) throw new FinanceError('Could not find a free document number; check the number series.', 500);
        ({ number, counter: nextCounter } = nextNumber(series, issue, nextCounter));
      }
      const contact = d.contact_id ? await this.store.get<Contact>(COL.contacts, d.contact_id) : undefined;
      const recipient = contact ? { ...this.recipientFromContact(contact), ...pickDefined(d.recipient) } : d.recipient;
      // Down payments are re-read: one cancelled since the draft was saved
      // must not be deducted.
      const deducts = d.invoice_kind === 'final' ? await this.deductionsFor((d.deducts ?? []).map((x) => x.id), d.contact_id, d.id) : undefined;
      const totals = this.totalsOf({ ...d, deducts }, company.document_language);
      const finalized: FinanceDocument = {
        ...d,
        deducts,
        number,
        status: 'open',
        issue_date: issue,
        due_date: d.type === 'invoice' ? addDays(issue, d.payment_days ?? company.default_payment_days) : undefined,
        valid_until: d.type === 'quote' ? d.valid_until ?? addDays(issue, 30) : d.valid_until,
        service_date: d.type === 'quote' ? d.service_date : d.service_date ?? issue,
        seller: company,
        recipient,
        totals,
        public_token: crypto.randomBytes(24).toString('base64url'),
        finalized_at: this.stamp(),
        updated_at: this.stamp(),
      };
      // XRechnung cannot express an out-of-scope (category O) invoice.
      if (finalized.einvoice_format === 'xrechnung' && totals.groups.some((g) => g.category === 'O')) finalized.einvoice_format = 'zugferd';
      const artefacts = await this.renderArtefacts(finalized, contact);
      finalized.archived_pdf_id = artefacts.pdfId;
      finalized.archived_xml_id = artefacts.xmlId;
      finalized.content_hash = sha256(canonical({ number, issue: finalized.issue_date, recipient, seller: company, lines: d.lines, totals, treatment: d.tax_treatment, ...(d.reference ? { reference: d.reference } : {}) }));
      // Order: claim the number first, then write the document.
      await this.store.put(COL.numbers, number, { document_id: d.id, at: this.stamp() });
      await this.store.put(COL.counters, counterKey, nextCounter as unknown as Record<string, unknown>);
      await this.putDocument(finalized);
      await this.log(actor, 'document.finalize', d.type, d.id, `${number} finalized, ${formatMoney(totals.gross_cents, d.currency)}`);
      return finalized;
    });
    this.deps.fire?.(`${result.type === 'quote' ? 'quote' : result.type === 'credit_note' ? 'credit_note' : 'invoice'}.finalized`, publicDoc(result));
    return result;
  }

  private async renderArtefacts(d: FinanceDocument, contact?: Contact): Promise<{ pdfId?: string; xmlId?: string }> {
    const company = d.seller!;
    let xml: string | undefined;
    if (d.type !== 'quote' && d.einvoice_format !== 'pdf') {
      xml = buildCii(d, d.einvoice_format === 'xrechnung' ? 'xrechnung' : 'en16931');
    }
    const pdf = await renderDocumentPdf(d, company, {
      fontBytes: await this.deps.fontBytes(),
      customerNumber: contact?.customer_number,
      // ZUGFeRD embeds the EN 16931 XML; an XRechnung is sent as the XML
      // itself, with the PDF as a human-readable companion.
      xml: d.einvoice_format === 'zugferd' ? xml : undefined,
      level: 'EN 16931',
      now: this.now(),
    });
    const pdfMeta = await archiveFile(pdf, pdfFilename(d.type === 'quote' ? 'Angebot' : d.type === 'credit_note' ? 'Gutschrift' : 'Rechnung', d.number), 'pdf');
    let xmlId: string | undefined;
    if (xml && d.einvoice_format === 'xrechnung') {
      const meta = await archiveFile(new TextEncoder().encode(xml), `${d.number}.xml`, 'xml');
      xmlId = meta.id;
    }
    return { pdfId: pdfMeta.id, xmlId };
  }

  /** PDF bytes: the archived one for finalized documents, a fresh preview for drafts. */
  async documentPdf(did: string): Promise<{ bytes: Uint8Array; filename: string }> {
    const d = await this.getDocument(did);
    const prefix = d.type === 'quote' ? 'Angebot' : d.type === 'credit_note' ? 'Gutschrift' : 'Rechnung';
    if (d.archived_pdf_id) {
      const a = await readArchived(d.archived_pdf_id);
      if (a) return { bytes: a.bytes, filename: pdfFilename(prefix, d.number) };
    }
    const company = d.seller ?? await this.company();
    const contact = d.contact_id ? await this.store.get<Contact>(COL.contacts, d.contact_id) : undefined;
    const preview = { ...d, totals: this.totalsOf(d, company.document_language) };
    const bytes = await renderDocumentPdf(preview, company, { fontBytes: await this.deps.fontBytes(), customerNumber: contact?.customer_number, now: this.now() });
    return { bytes, filename: pdfFilename(`${prefix}-Entwurf`, d.number ?? d.id.slice(-6)) };
  }

  async documentXml(did: string): Promise<{ xml: string; filename: string }> {
    const d = await this.getDocument(did);
    if (d.status === 'draft' || !d.seller) throw new FinanceError('Finalize the document first.', 409);
    if (d.archived_xml_id) {
      const a = await readArchived(d.archived_xml_id);
      if (a) return { xml: a.bytes.toString('utf8'), filename: `${d.number}.xml` };
    }
    const profile = d.einvoice_format === 'xrechnung' ? 'xrechnung' : 'en16931';
    return { xml: buildCii(d, profile), filename: `${d.number}.xml` };
  }

  /* ----------------------------- quote flow ----------------------------- */

  async setQuoteStatus(did: string, status: 'accepted' | 'rejected', actor: string): Promise<FinanceDocument> {
    const d = await this.getDocument(did);
    if (d.type !== 'quote' || d.status === 'draft' || d.status === 'invoiced') throw new FinanceError('Only a sent quote can be accepted or rejected.', 409);
    const next = await this.patchDocument(did, () => ({ status, quote_response: { status, at: this.stamp(), via: 'admin' as const } }));
    await this.log(actor, `quote.${status}`, 'quote', did, d.number);
    this.deps.fire?.(`quote.${status}`, publicDoc(next));
    return next;
  }

  /** The lines a quote turns into once accepted: chosen options in, alternatives out. */
  private acceptedLines(q: FinanceDocument) {
    return q.lines
      .filter((l) => !l.alternative && (!l.optional || (q.accepted_options ?? []).includes(l.id)))
      .map((l) => ({ ...l, optional: undefined }));
  }

  /**
   * Auftragsbestätigung for an accepted quote: a PDF that confirms the order
   * with exactly the accepted scope, archived with the quote and optionally
   * emailed. It is a letter, not a tax document, so it takes no number of
   * its own — it refers to the quote.
   */
  async orderConfirmation(did: string, input: unknown, actor: string): Promise<{ document: FinanceDocument; pdf_id: string }> {
    const i = asObj(input);
    const q = await this.getDocument(did);
    if (q.type !== 'quote' || !(q.status === 'accepted' || q.status === 'invoiced')) throw new FinanceError('Only an accepted quote can be confirmed.', 409);
    const company = q.seller ?? await this.company();
    const lang = company.document_language || 'de';
    const lines = this.acceptedLines(q);
    const ab: FinanceDocument = {
      ...q,
      title: `${lang === 'de' ? 'Auftragsbestätigung zu Angebot' : 'Order confirmation for quote'} ${q.number}`,
      intro: lang === 'de'
        ? `vielen Dank für Ihren Auftrag${q.quote_response?.at ? ` vom ${q.quote_response.at.slice(0, 10).split('-').reverse().join('.')}` : ''}. Hiermit bestätigen wir die folgenden Leistungen:`
        : 'Thank you for your order. We confirm the following:',
      issue_date: this.today(),
      valid_until: undefined,
      lines,
      totals: this.totalsOf({ ...q, lines }, lang),
    };
    const contact = q.contact_id ? await this.store.get<Contact>(COL.contacts, q.contact_id) : undefined;
    const pdf = await renderDocumentPdf(ab, company, { fontBytes: await this.deps.fontBytes(), customerNumber: contact?.customer_number, now: this.now() });
    const name = `${lang === 'de' ? 'Auftragsbestaetigung' : 'Order-confirmation'}-${q.number}.pdf`;
    const meta = await archiveFile(pdf, name, 'pdf');
    let sentTo: string | undefined;
    if (i.send && q.recipient.email) {
      this.requireRealEmail();
      await this.deps.sendEmail!({
        to: q.recipient.email,
        subject: `${lang === 'de' ? 'Auftragsbestätigung' : 'Order confirmation'} — ${q.number}`,
        text: lang === 'de' ? `Guten Tag,\n\nvielen Dank für Ihren Auftrag. Anbei unsere Auftragsbestätigung zu Angebot ${q.number}.\n\nMit freundlichen Grüßen\n${legalName(company)}`
          : `Hello,\n\nthank you for your order. Please find our order confirmation for quote ${q.number} attached.\n\nKind regards\n${legalName(company)}`,
        replyTo: company.email || undefined,
        attachments: [{ filename: name, contentType: 'application/pdf', content: pdf }],
      });
      sentTo = q.recipient.email;
    }
    const document = await this.patchDocument(did, () => ({ order_confirmation: { pdf_id: meta.id, date: this.today(), sent_to: sentTo } }));
    await this.log(actor, 'quote.confirmed', 'quote', did, `Auftragsbestätigung${sentTo ? ` sent to ${sentTo}` : ''}`);
    return { document, pdf_id: meta.id };
  }

  async quoteToInvoice(did: string, actor: string): Promise<FinanceDocument> {
    const q = await this.getDocument(did);
    if (q.type !== 'quote' || q.status === 'draft') throw new FinanceError('Finalize the quote first.', 409);
    if (q.invoice_id) throw new FinanceError('This quote was already turned into an invoice.', 409);
    const inv = await this.createDocument({
      type: 'invoice', contact_id: q.contact_id, recipient: q.recipient, reference: q.reference,
      // Alternatives were for comparison; optional lines go over only when
      // the customer chose them when accepting.
      lines: this.acceptedLines(q).map((l) => ({ ...l, id: undefined })),
      tax_treatment: q.tax_treatment, price_mode: q.price_mode, currency: q.currency, title: undefined,
      einvoice_format: q.einvoice_format,
    }, actor, { from_quote_id: q.id });
    await this.patchDocument(q.id, () => ({ status: 'invoiced', invoice_id: inv.id }));
    await this.log(actor, 'quote.invoiced', 'quote', q.id, `→ invoice draft ${inv.id}`);
    return inv;
  }

  /* ----------------------------- credit notes ----------------------------- */

  /**
   * Cancel an invoice (Storno): a credit note for its full amount, finalized
   * at once, offset against whatever is still open.
   */
  cancelInvoice(did: string, actor: string, reason?: string): Promise<{ invoice: FinanceDocument; credit_note: FinanceDocument }> {
    return singleFlight(`cancel:${did}`, () => this.cancelInvoiceOnce(did, actor, reason));
  }

  private async cancelInvoiceOnce(did: string, actor: string, reason?: string): Promise<{ invoice: FinanceDocument; credit_note: FinanceDocument }> {
    const inv = await this.getDocument(did);
    if (inv.type !== 'invoice' || inv.status === 'draft') throw new FinanceError('Only a finalized invoice can be cancelled. Delete a draft instead.', 409);
    if (inv.status === 'cancelled') throw new FinanceError('Already cancelled.', 409);
    const settings = await this.settings();
    const cn = await this.createDocument({
      type: 'credit_note', contact_id: inv.contact_id, recipient: inv.recipient,
      lines: inv.lines.map((l) => ({ ...l, id: undefined })), tax_treatment: inv.tax_treatment, price_mode: inv.price_mode,
      currency: inv.currency, einvoice_format: inv.einvoice_format === 'xrechnung' ? 'xrechnung' : inv.einvoice_format,
      service_date: inv.service_date, service_date_end: inv.service_date_end,
      intro: `${settings.texts.credit_note_intro}${reason ? `\n${reason}` : ''}`,
      title: `${DOC_STRINGS[(inv.seller?.document_language) || 'de'].credit_note} zu ${inv.number}`,
    }, actor, { refers_to_id: inv.id, refers_to_number: inv.number });
    const finalCn = await this.finalize(cn.id, actor);
    return withLock(async () => {
      const fresh = await this.getDocument(did);
      const open = dueCents(fresh) - fresh.paid_cents;
      if (open > 0) {
        // Offset the open part of the invoice against the credit note.
        await this.addPaymentRecord({ document_id: fresh.id, amount_cents: open, method: 'offset', reference: finalCn.number, date: finalCn.issue_date! });
        await this.addPaymentRecord({ document_id: finalCn.id, amount_cents: open, method: 'offset', reference: fresh.number, date: finalCn.issue_date! });
      }
      const invNext = { ...(await this.recalcPaid(did)), status: 'cancelled' as const, cancelled_by_id: finalCn.id, updated_at: this.stamp() };
      await this.putDocument(invNext);
      const cnNext = await this.recalcPaid(finalCn.id);
      await this.log(actor, 'invoice.cancel', 'invoice', did, `Cancelled by ${finalCn.number}`);
      this.deps.fire?.('invoice.cancelled', publicDoc(invNext));
      return { invoice: invNext, credit_note: cnNext };
    });
  }

  /* ----------------------------- payments ----------------------------- */

  async listPayments(documentId?: string): Promise<Payment[]> {
    const rows = (await this.store.list<Payment>(COL.payments, ALL)).map((r) => r.data);
    return documentId ? rows.filter((p) => p.document_id === documentId) : rows;
  }

  private async addPaymentRecord(p: Omit<Payment, 'id' | 'created_at'>): Promise<Payment> {
    const pay: Payment = { ...p, id: id('pay'), created_at: this.stamp() };
    await this.store.put(COL.payments, pay.id, pay as unknown as Record<string, unknown>);
    return pay;
  }

  private async recalcPaid(did: string): Promise<FinanceDocument> {
    const d = await this.getDocument(did);
    const paid = (await this.listPayments(did)).reduce((s, p) => s + p.amount_cents, 0);
    let status = d.status;
    if (d.status !== 'cancelled' && d.status !== 'draft' && d.type !== 'quote') {
      status = paid >= dueCents(d) ? 'paid' : paid > 0 ? 'partially_paid' : 'open';
    }
    const next = { ...d, paid_cents: paid, status, updated_at: this.stamp() };
    await this.putDocument(next);
    return next;
  }

  async recordPayment(did: string, input: unknown, actor: string): Promise<{ payment: Payment; document: FinanceDocument }> {
    const i = asObj(input);
    const out = await withLock(async () => {
      const d = await this.getDocument(did);
      if (d.status === 'draft' || d.type === 'quote') throw new FinanceError('Payments can only be recorded on finalized invoices and credit notes.', 409);
      const open = dueCents(d) - d.paid_cents;
      const amount = 'amount' in i || 'amount_cents' in i ? readCents(i, 'amount') : open;
      if (!amount) throw new FinanceError('The payment amount is zero.');
      const method = (['bank', 'cash', 'stripe', 'paypal', 'card', 'other'].includes(String(i.method)) ? i.method : 'bank') as Payment['method'];
      const date = readDate(i.date, 'date') ?? this.today();
      const settle = i.settle === 'skonto' || i.settle === 'difference' ? i.settle : undefined;
      if (settle && d.type !== 'invoice') throw new FinanceError('Only an invoice can be settled with a Skonto or a written-off difference.', 409);
      const rest = open - amount;
      if (settle && rest <= 0) throw new FinanceError('Nothing is left to settle — the payment covers the whole amount.', 409);
      if (settle === 'skonto') {
        const sk = skontoFor(d);
        if (!sk) throw new FinanceError('This invoice offers no Skonto.', 409);
        // The customer may round; a cent more than the printed Skonto is fine.
        if (rest > sk.discount_cents + 1) throw new FinanceError(`The difference (${formatMoney(rest, d.currency)}) is larger than the Skonto (${formatMoney(sk.discount_cents, d.currency)}).`, 422);
      }
      const payment = await this.addPaymentRecord({
        document_id: did, amount_cents: amount, date, method,
        reference: str(i.reference, 200), bank_tx_id: str(i.bank_tx_id, 60), note: str(i.note, 500),
      });
      if (settle) {
        await this.addPaymentRecord({
          document_id: did, amount_cents: rest, date, method: 'discount', discount_kind: settle,
          note: settle === 'skonto' ? 'Skonto' : 'Differenz ausgebucht', bank_tx_id: str(i.bank_tx_id, 60),
        });
      }
      const document = await this.recalcPaid(did);
      await this.log(actor, 'payment.create', d.type, did, `${formatMoney(amount, d.currency)} via ${method}${settle ? ` + ${formatMoney(rest, d.currency)} ${settle}` : ''}`);
      return { payment, document };
    });
    if (out.document.status === 'paid') this.deps.fire?.('invoice.paid', publicDoc(out.document));
    return out;
  }

  async deletePayment(pid: string, actor: string): Promise<FinanceDocument> {
    return withLock(async () => {
      const p = await this.store.get<Payment>(COL.payments, pid);
      if (!p) throw new FinanceError('Payment not found.', 404);
      await this.store.delete(COL.payments, pid);
      if (p.bank_tx_id) await this.unlinkBankTx(p.bank_tx_id, 'document', p.document_id);
      const d = await this.recalcPaid(p.document_id);
      await this.log(actor, 'payment.delete', d.type, d.id, `Payment ${pid} removed (${formatMoney(p.amount_cents, d.currency)})`);
      return d;
    });
  }

  /* ----------------------------- sending ----------------------------- */

  async publicLink(d: FinanceDocument): Promise<string> {
    const origin = (await this.deps.siteUrl?.()) ?? '';
    return `${origin.replace(/\/+$/, '')}/api/plugin/finance/public/${d.id}/${d.public_token}/view`;
  }

  /**
   * A customer accepts or declines a quote in the portal. The token in the
   * link is the authorisation; the answer is final (a second click, or an
   * answer after the validity date, is refused) and goes into the log.
   */
  async respondToQuote(did: string, input: unknown): Promise<FinanceDocument> {
    const i = asObj(input);
    const decision = i.decision === 'accept' ? 'accepted' : i.decision === 'reject' ? 'rejected' : null;
    if (!decision) throw new FinanceError('Please choose to accept or decline.', 422);
    const name = str(i.name, 120);
    if (decision === 'accepted' && !name) throw new FinanceError('Please enter your name to accept the quote.', 422);
    const next = await withLock(async () => {
      const d = await this.getDocument(did);
      if (d.type !== 'quote' || d.status !== 'open') throw new FinanceError('This quote has already been answered.', 409);
      if (d.valid_until && d.valid_until < this.today()) throw new FinanceError('This quote has expired.', 409);
      const optionIds = new Set(d.lines.filter((l) => l.optional).map((l) => l.id));
      const chosen = (Array.isArray(i.options) ? i.options : i.options ? [i.options] : []).map(String).filter((x) => optionIds.has(x));
      const out: FinanceDocument = {
        ...d, status: decision,
        accepted_options: decision === 'accepted' ? chosen : undefined,
        quote_response: { status: decision, at: this.stamp(), name, note: str(i.note, 1000), via: 'portal' },
        updated_at: this.stamp(),
      };
      await this.putDocument(out);
      return out;
    });
    await this.log(`portal:${name ?? 'customer'}`, `quote.${decision}`, 'quote', did, `${next.number} ${decision} online${next.accepted_options?.length ? ` with ${next.accepted_options.length} option(s)` : ''}`);
    this.deps.fire?.(`quote.${decision}`, { ...publicDoc(next), accepted_options: next.accepted_options, response_note: next.quote_response?.note });
    return next;
  }

  async sendDocument(did: string, input: unknown, actor: string): Promise<FinanceDocument> {
    const i = asObj(input);
    const d = await this.getDocument(did);
    if (d.status === 'draft') throw new FinanceError('Finalize the document before sending it.', 409);
    this.requireRealEmail();
    const to = str(i.to, 254) ?? d.recipient.email;
    if (!to) throw new FinanceError('No recipient email address — add one to the contact or pass "to".');
    const company = d.seller ?? await this.company();
    const settings = await this.settings();
    const lang = company.document_language || 'de';
    const typeName = DOC_STRINGS[lang][d.type];
    const link = await this.publicLink(d);
    const fill = (tpl: string) => tpl
      .replace(/\{type\}/g, typeName).replace(/\{number\}/g, d.number ?? '')
      .replace(/\{company\}/g, legalName(company)).replace(/\{amount\}/g, formatMoney(dueCents(d), d.currency, lang))
      .replace(/\{link\}/g, link).replace(/\{due\}/g, d.due_date ?? '');
    const pdf = await this.documentPdf(did);
    const attachments = [{ filename: pdf.filename, contentType: 'application/pdf', content: pdf.bytes }];
    if (d.einvoice_format === 'xrechnung') {
      const x = await this.documentXml(did);
      attachments.push({ filename: x.filename, contentType: 'application/xml', content: new TextEncoder().encode(x.xml) });
    }
    await this.deps.sendEmail!({
      to,
      subject: str(i.subject, 300) ?? fill(settings.texts.email_subject),
      text: str(i.message, 8000) ?? fill(settings.texts.email_body),
      replyTo: company.email || undefined,
      attachments,
    });
    const next = await this.patchDocument(did, () => ({ sent_at: this.stamp() }));
    await this.log(actor, 'document.send', d.type, did, `Sent to ${to}`);
    this.deps.fire?.('document.sent', publicDoc(next));
    return next;
  }

  /* ----------------------------- dunning ----------------------------- */

  async dunningSuggestions(): Promise<{ document: FinanceDocument; next_level: number; days_overdue: number }[]> {
    const s = await this.settings();
    const today = this.today();
    const out = [];
    for (const d of await this.listDocuments({ type: 'invoice' })) {
      if (!this.isOverdue(d)) continue;
      const days = daysBetween(d.due_date!, today);
      const level = d.dunning_level ?? 0;
      if (level >= 3) continue;
      if (days >= s.dunning.level_days[level]) {
        // Leave at least a week between letters.
        if (d.last_dunning_at && daysBetween(d.last_dunning_at, today) < 7) continue;
        out.push({ document: d, next_level: level + 1, days_overdue: days });
      }
    }
    return out;
  }

  /** The letters already sent for one invoice, oldest first. */
  async listDunnings(did: string): Promise<{ id: string; document_id: string; level: number; date: string; fee_cents: number; interest_cents: number; pdf_id: string; sent_to?: string }[]> {
    const all = (await this.store.list<{ id: string; document_id: string; level: number; date: string; fee_cents: number; interest_cents: number; pdf_id: string; sent_to?: string }>(COL.dunnings, ALL)).map((r) => r.data);
    return all.filter((r) => r.document_id === did).sort((a, b) => a.level - b.level || a.date.localeCompare(b.date));
  }

  async createDunning(did: string, input: unknown, actor: string): Promise<{ document: FinanceDocument; pdf_id: string; fee_cents: number; interest_cents: number }> {
    const i = asObj(input);
    const d = await this.getDocument(did);
    if (d.type !== 'invoice' || !(d.status === 'open' || d.status === 'partially_paid')) throw new FinanceError('Only open invoices can be dunned.', 409);
    // A reminder before the due date is not a reminder: the debtor is not in
    // default (§ 286 BGB), and a letter claiming otherwise damages the
    // relationship and any later claim to fees or interest.
    if (!this.isOverdue(d)) throw new FinanceError(`Invoice ${d.number} is not overdue yet (due ${d.due_date ?? 'n/a'}) — it cannot be dunned.`, 409);
    const s = await this.settings();
    const level = Math.min(3, (d.dunning_level ?? 0) + 1);
    const idx = level - 1;
    const today = this.today();
    const payBy = addDays(today, 10);
    const open = dueCents(d) - d.paid_cents;
    let interest = 0;
    if (s.dunning.charge_interest && level >= 2 && d.due_date) {
      // §288 BGB: base rate + 9 points between businesses (Abs. 2), + 5 for a
      // consumer (Abs. 1). Only a known company or a VAT id counts as a
      // business — charging a consumer the business rate is an overcharge.
      const contactForRate = d.contact_id ? await this.store.get<Contact>(COL.contacts, d.contact_id) : undefined;
      const business = contactForRate?.kind === 'company' || !!contactForRate?.vat_id || !!d.recipient.vat_id;
      const consumer = !business;
      const days = Math.max(0, daysBetween(d.due_date, today));
      interest = Math.round((open * ((s.dunning.base_rate_percent + (consumer ? 5 : 9)) / 100) * days) / 365);
    }
    const fee = s.dunning.fees_cents[idx];
    const company = d.seller ?? await this.company();
    const contact = d.contact_id ? await this.store.get<Contact>(COL.contacts, d.contact_id) : undefined;
    const lang = company.document_language || 'de';
    const greeting = lang === 'de' ? 'Sehr geehrte Damen und Herren,' : 'Dear Sir or Madam,';
    const body = `${greeting}\n\n${s.dunning.texts[idx].replace(/\{pay_by\}/g, payBy.split('-').reverse().join('.'))}\n\n${lang === 'de' ? 'Mit freundlichen Grüßen' : 'Kind regards'}\n${company.contact_person || legalName(company)}`;
    const pdf = await renderDunningPdf({
      level, title: s.dunning.titles[idx], body, date: today, recipient: d.recipient,
      invoices: [{ number: d.number!, date: d.issue_date!, due_date: d.due_date, gross_cents: dueCents(d), paid_cents: d.paid_cents }],
      fee_cents: fee, interest_cents: interest, currency: d.currency, pay_by: payBy, customerNumber: contact?.customer_number,
    }, company, { fontBytes: await this.deps.fontBytes(), now: this.now() });
    const meta = await archiveFile(pdf, `${s.dunning.titles[idx]}-${d.number}.pdf`, 'pdf');
    const rec = { id: id('dun'), document_id: did, level, date: today, fee_cents: fee, interest_cents: interest, pdf_id: meta.id, sent_to: undefined as string | undefined };
    if (i.send && d.recipient.email) {
      this.requireRealEmail();
      await this.deps.sendEmail!({
        to: d.recipient.email,
        subject: `${s.dunning.titles[idx]}: ${d.number}`,
        text: body,
        replyTo: company.email || undefined,
        attachments: [{ filename: `${s.dunning.titles[idx]}-${d.number}.pdf`.replace(/[^A-Za-z0-9._-]/g, '_'), contentType: 'application/pdf', content: pdf }],
      });
      rec.sent_to = d.recipient.email;
    }
    await this.store.put(COL.dunnings, rec.id, rec as unknown as Record<string, unknown>);
    const next = await this.patchDocument(did, () => ({ dunning_level: level, last_dunning_at: today }));
    await this.log(actor, 'dunning.create', 'invoice', did, `Level ${level} (${s.dunning.titles[idx]})`);
    this.deps.fire?.('invoice.dunned', { ...publicDoc(next), dunning_level: level });
    return { document: next, pdf_id: meta.id, fee_cents: fee, interest_cents: interest };
  }

  /* ----------------------------- expenses ----------------------------- */

  async listExpenses(): Promise<Expense[]> {
    return (await this.store.list<Expense>(COL.expenses, ALL)).map((r) => r.data).sort((a, b) => b.date.localeCompare(a.date));
  }

  async getExpense(eid: string): Promise<Expense> {
    const e = await this.store.get<Expense>(COL.expenses, eid);
    if (!e) throw new FinanceError('Expense not found.', 404);
    return e;
  }

  async saveExpense(eid: string | null, input: unknown, actor: string, extra: Partial<Expense> = {}): Promise<Expense> {
    const i = asObj(input);
    const before = eid ? await this.getExpense(eid) : undefined;
    if (before && before.status !== 'draft') {
      const allowed = ['note', 'category', 'lines', 'status', 'paid_date', 'due_date', 'contact_id', 'supplier_country'];
      // Booked expenses may still be re-categorised; the receipt itself is immutable.
      const blocked = Object.keys(i).filter((k) => !allowed.includes(k));
      if (blocked.length) throw new FinanceError(`This expense is booked; only ${allowed.join(', ')} can change.`, 409);
      if (i.status === 'draft') throw new FinanceError('A booked expense cannot go back to draft (GoBD).', 409);
      if ('lines' in i) {
        // Categories and descriptions may change; the amounts are the receipt's.
        const next = normExpenseLines(i.lines);
        const same = next.length === before.lines.length && next.every((l, n) => {
          const b = before.lines[n];
          return l.net_cents === b.net_cents && l.tax_cents === b.tax_cents && l.tax_rate === b.tax_rate;
        });
        if (!same) throw new FinanceError('The amounts of a booked expense cannot change; book a correction instead.', 409);
      }
    }
    let lines = 'lines' in i ? normExpenseLines(i.lines) : before?.lines ?? [];
    if (!lines.length && ('gross' in i || 'gross_cents' in i)) {
      lines = normExpenseLines([{ category: i.category, gross_cents: readCents(i, 'gross'), tax_rate: i.tax_rate, description: i.description }]);
    }
    if (!lines.length) throw new FinanceError('An expense needs at least one amount line.');
    const supplier = str(i.supplier_name, 200) ?? before?.supplier_name;
    let contactId = 'contact_id' in i ? str(i.contact_id, 60) : before?.contact_id;
    let supplierName = supplier;
    if (contactId) {
      const c = await this.getContact(contactId);
      supplierName = supplierName ?? contactDisplayName(c);
    }
    if (!supplierName) throw new FinanceError('An expense needs a supplier.');
    if (!contactId && !before && i.create_contact !== false) {
      const vat = str(i.supplier_vat_id, 20);
      const contacts = await this.listContacts();
      const match = contacts.find((c) => (vat && c.vat_id === vat) || contactDisplayName(c).toLowerCase() === supplierName!.toLowerCase());
      contactId = match?.id;
    }
    const net = lines.reduce((s, l) => s + l.net_cents, 0);
    const reverse = 'reverse_charge' in i ? !!i.reverse_charge : before?.reverse_charge ?? false;
    const tax = reverse ? 0 : lines.reduce((s, l) => s + l.tax_cents, 0);
    if (reverse) lines = lines.map((l) => ({ ...l, tax_cents: 0 }));
    const now = this.stamp();
    const status = (['draft', 'open', 'paid'].includes(String(i.status)) ? i.status : before?.status ?? 'open') as Expense['status'];
    const exp: Expense = {
      id: before?.id ?? id('ex'),
      status,
      contact_id: contactId,
      supplier_name: supplierName,
      supplier_vat_id: 'supplier_vat_id' in i ? str(i.supplier_vat_id, 20) : before?.supplier_vat_id,
      supplier_country: 'supplier_country' in i ? str(i.supplier_country, 2)?.toUpperCase() : before?.supplier_country ?? extra.supplier_country,
      invoice_number: 'invoice_number' in i ? str(i.invoice_number, 100) : before?.invoice_number,
      date: readDate(i.date, 'date') ?? before?.date ?? this.today(),
      due_date: 'due_date' in i ? readDate(i.due_date, 'due_date') : before?.due_date,
      service_date: 'service_date' in i ? readDate(i.service_date, 'service_date') : before?.service_date,
      currency: (str(i.currency, 3) ?? before?.currency ?? 'EUR').toUpperCase(),
      lines,
      net_cents: net,
      tax_cents: tax,
      gross_cents: net + tax,
      paid_cents: status === 'paid' ? net + tax : before?.paid_cents ?? 0,
      paid_date: status === 'paid' ? (readDate(i.paid_date, 'paid_date') ?? before?.paid_date ?? this.today()) : undefined,
      reverse_charge: reverse,
      file_id: before?.file_id ?? extra.file_id,
      file_name: before?.file_name ?? extra.file_name,
      xml_file_id: before?.xml_file_id ?? extra.xml_file_id,
      source: before?.source ?? extra.source ?? 'manual',
      note: 'note' in i ? str(i.note, 2000) : before?.note,
      bank_tx_id: before?.bank_tx_id,
      external_ref: before?.external_ref ?? extra.external_ref,
      created_at: before?.created_at ?? now,
      updated_at: now,
    };
    await this.store.put(COL.expenses, exp.id, exp as unknown as Record<string, unknown>);
    await this.log(actor, before ? 'expense.update' : 'expense.create', 'expense', exp.id, `${exp.supplier_name} ${formatMoney(exp.gross_cents, exp.currency)}`);
    if (!before) this.deps.fire?.('expense.created', exp);
    return exp;
  }

  async deleteExpense(eid: string, actor: string): Promise<void> {
    const e = await this.getExpense(eid);
    if (e.status !== 'draft') throw new FinanceError('Booked expenses are kept (GoBD). Only drafts can be deleted.', 409);
    await this.store.delete(COL.expenses, eid);
    await this.log(actor, 'expense.delete', 'expense', eid);
  }

  /**
   * Upload a receipt. An e-invoice (XML, or a ZUGFeRD PDF with XML inside) is
   * READ into a complete expense; anything else becomes a draft with the file
   * attached, for the user (or the AI reader) to fill in.
   */
  async uploadReceipt(bytes: Uint8Array, filename: string, actor: string): Promise<{ expense: Expense; parsed?: ParsedEInvoice; duplicate?: boolean }> {
    // A file the archive or the XML reader refuses is the uploader's problem
    // (wrong type, too large, malformed) — answer 422, not a server error.
    const meta = await archiveFile(bytes, filename).catch((e: Error) => { throw new FinanceError(e.message, 422); });
    const existing = (await this.listExpenses()).find((e) => e.file_id === meta.id || e.xml_file_id === meta.id);
    if (existing) return { expense: existing, duplicate: true };
    let xml: string | null = null;
    if (meta.kind === 'xml') xml = Buffer.from(bytes).toString('utf8');
    else if (meta.kind === 'pdf') xml = await extractEmbeddedXml(bytes).catch(() => null);
    if (xml) {
      let parsed: ParsedEInvoice;
      try { parsed = parseEInvoice(xml); } catch (e) { throw new FinanceError(`The e-invoice could not be read: ${(e as Error).message}`, 422); }
      const company = await this.company();
      if (company.vat_id && parsed.seller.vat_id === company.vat_id) {
        throw new FinanceError('This e-invoice was issued BY your company — it is an outgoing invoice, not an expense.', 422);
      }
      const reverse = parsed.groups.some((g) => g.category === 'AE');
      const lines = parsed.groups.length
        ? parsed.groups.map((g) => ({ category: 'other', net_cents: g.net_cents, tax_rate: g.rate, tax_cents: g.tax_cents, description: parsed.lines[0]?.name }))
        : [{ category: 'other', net_cents: parsed.net_cents, tax_rate: 0, tax_cents: parsed.tax_cents }];
      const sign = parsed.type === 'credit_note' ? -1 : 1;
      const expense = await this.saveExpense(null, {
        supplier_name: parsed.seller.name, supplier_vat_id: parsed.seller.vat_id, supplier_country: parsed.seller.country,
        invoice_number: parsed.number, date: parsed.issue_date, due_date: parsed.due_date, service_date: parsed.service_date,
        currency: parsed.currency, reverse_charge: reverse, status: 'open',
        lines: lines.map((l) => ({ ...l, net_cents: l.net_cents * sign, tax_cents: l.tax_cents * sign })),
      }, actor, {
        source: 'einvoice', file_id: meta.kind === 'pdf' ? meta.id : undefined, file_name: meta.name,
        xml_file_id: meta.kind === 'xml' ? meta.id : (await archiveFile(new TextEncoder().encode(xml), `${parsed.number}.xml`, 'xml')).id,
      });
      // Gross from the document itself, never recomputed.
      if (!reverse && Math.abs(expense.gross_cents) !== Math.abs(parsed.gross_cents) && parsed.gross_cents) {
        await this.log(actor, 'expense.warning', 'expense', expense.id, `Sum of VAT groups differs from the invoice total (${parsed.gross_cents})`);
      }
      return { expense, parsed };
    }
    const expense = await this.saveExpense(null, {
      supplier_name: filename.replace(/\.[a-z0-9]+$/i, '').slice(0, 80) || 'Unbekannt',
      lines: [{ category: 'other', net_cents: 0, tax_rate: 19, tax_cents: 0 }], status: 'draft', create_contact: false,
    }, actor, { source: 'upload', file_id: meta.id, file_name: meta.name });
    return { expense };
  }

  /* ----------------------------- bank ----------------------------- */

  async listBankAccounts(): Promise<BankAccount[]> {
    return (await this.store.list<BankAccount>(COL.bankAccounts, ALL)).map((r) => r.data);
  }

  async saveBankAccount(aid: string | null, input: unknown, actor: string): Promise<BankAccount> {
    const i = asObj(input);
    const before = aid ? await this.store.get<BankAccount>(COL.bankAccounts, aid) : undefined;
    const acct: BankAccount = {
      id: before?.id ?? id('ba'),
      name: str(i.name, 100) ?? before?.name ?? 'Geschäftskonto',
      iban: 'iban' in i ? str(i.iban, 40)?.replace(/\s+/g, '').toUpperCase() : before?.iban,
      bic: 'bic' in i ? str(i.bic, 11) : before?.bic,
      currency: (str(i.currency, 3) ?? before?.currency ?? 'EUR').toUpperCase(),
      ledger_account: 'ledger_account' in i ? (Math.round(Number(i.ledger_account)) || undefined) : before?.ledger_account,
      opening_balance_cents: 'opening_balance' in i || 'opening_balance_cents' in i ? readCents(i, 'opening_balance') : before?.opening_balance_cents,
      opening_balance_date: 'opening_balance_date' in i ? readDate(i.opening_balance_date, 'opening_balance_date') : before?.opening_balance_date,
      created_at: before?.created_at ?? this.stamp(),
    };
    await this.store.put(COL.bankAccounts, acct.id, acct as unknown as Record<string, unknown>);
    await this.log(actor, before ? 'bank_account.update' : 'bank_account.create', 'bank_account', acct.id, acct.name);
    return acct;
  }

  async listBankTx(year: string): Promise<BankTransaction[]> {
    return (await this.store.list<BankTransaction>(COL.bankTx(year), ALL)).map((r) => r.data)
      .sort((a, b) => b.booking_date.localeCompare(a.booking_date));
  }

  private async findBankTx(txId: string): Promise<BankTransaction | undefined> {
    const year = txId.match(/^bt_(\d{4})_/)?.[1];
    if (year) return this.store.get<BankTransaction>(COL.bankTx(year), txId);
    return undefined;
  }

  private async putBankTx(t: BankTransaction): Promise<void> {
    await this.store.put(COL.bankTx(t.booking_date.slice(0, 4)), t.id, t as unknown as Record<string, unknown>);
  }

  async importStatement(accountId: string, content: string, actor: string): Promise<{ imported: number; duplicates: number; auto_matched: number; warnings: string[]; format: string }> {
    const acct = await this.store.get<BankAccount>(COL.bankAccounts, accountId);
    if (!acct) throw new FinanceError('Bank account not found.', 404);
    const parsed = parseStatement(content);
    if (parsed.iban && acct.iban && parsed.iban !== acct.iban) {
      throw new FinanceError(`This statement is for ${parsed.iban}, not for ${acct.iban}.`, 422);
    }
    let imported = 0;
    let duplicates = 0;
    const years = new Set(parsed.transactions.map((t) => t.booking_date.slice(0, 4)));
    const existing = new Set<string>();
    for (const y of years) for (const t of await this.listBankTx(y)) if (t.account_id === accountId) existing.add(t.fingerprint);
    const fresh: BankTransaction[] = [];
    for (const p of parsed.transactions) {
      // Only rows imported BEFORE count as duplicates; two identical rows in
      // one file already carry different fingerprints (see parseStatement).
      if (!p.booking_date || existing.has(p.fingerprint)) { duplicates++; continue; }
      const t: BankTransaction = {
        ...p, id: `bt_${p.booking_date.slice(0, 4)}_${crypto.randomBytes(8).toString('base64url')}`,
        account_id: accountId, status: 'unmatched', imported_at: this.stamp(),
      };
      await this.putBankTx(t);
      fresh.push(t);
      imported++;
    }
    await this.log(actor, 'bank.import', 'bank_account', accountId, `${parsed.format}: ${imported} new, ${duplicates} already known`);
    let auto = 0;
    for (const t of fresh) if (await this.tryAutoMatch(t, actor)) auto++;
    return { imported, duplicates, auto_matched: auto, warnings: parsed.warnings, format: parsed.format };
  }

  /** Bank transactions pushed by an integration (Stripe payouts, a FinTS bridge…). */
  async addBankTransactions(accountId: string, txs: unknown[], actor: string) {
    const csv = ['Buchungstag;Valutadatum;Betrag;Währung;Name Zahlungsbeteiligter;IBAN Zahlungsbeteiligter;Verwendungszweck'];
    for (const raw of txs.slice(0, 5000)) {
      const t = asObj(raw);
      const cents = readCents(t, 'amount');
      const q = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      csv.push([q(t.booking_date), q(t.value_date ?? ''), q((cents / 100).toFixed(2).replace('.', ',')), q(t.currency ?? 'EUR'),
        q(t.counterparty_name ?? ''), q(t.counterparty_iban ?? ''), q(t.purpose ?? '')].join(';'));
    }
    return this.importStatement(accountId, csv.join('\n'), actor);
  }

  async openItemsForMatching(): Promise<OpenItem[]> {
    const items: OpenItem[] = [];
    for (const d of await this.listDocuments({ type: 'invoice' })) {
      if (d.status !== 'open' && d.status !== 'partially_paid') continue;
      items.push({ kind: 'document', id: d.id, number: d.number, name: d.recipient.name ?? '', open_cents: dueCents(d) - d.paid_cents, date: d.issue_date ?? '' });
    }
    for (const e of await this.listExpenses()) {
      if (e.status !== 'open') continue;
      items.push({ kind: 'expense', id: e.id, number: e.invoice_number, name: e.supplier_name, open_cents: e.gross_cents - e.paid_cents, date: e.date });
    }
    return items;
  }

  async suggestionsFor(txId: string) {
    const t = await this.findBankTx(txId);
    if (!t) throw new FinanceError('Bank transaction not found.', 404);
    return suggestMatches(t, await this.openItemsForMatching());
  }

  private async tryAutoMatch(t: BankTransaction, actor: string): Promise<boolean> {
    const best = autoMatch(suggestMatches(t, await this.openItemsForMatching()));
    if (!best) return false;
    await this.matchBankTx(t.id, { kind: best.kind, id: best.id }, actor);
    return true;
  }

  matchBankTx(txId: string, input: unknown, actor: string): Promise<BankTransaction> {
    return withBankLock(() => this.matchBankTxLocked(txId, input, actor));
  }

  private async matchBankTxLocked(txId: string, input: unknown, actor: string): Promise<BankTransaction> {
    const i = asObj(input);
    const t = await this.findBankTx(txId);
    if (!t) throw new FinanceError('Bank transaction not found.', 404);
    const kind = i.kind === 'expense' ? 'expense' : 'document';
    const target = str(i.id, 60);
    if (!target) throw new FinanceError('Say what to match: { kind, id }.');
    const already = (t.matches ?? []).reduce((s, m) => s + Math.abs(m.amount_cents), 0);
    const remaining = Math.abs(t.amount_cents) - already;
    if (remaining <= 0) throw new FinanceError('This transaction is already fully matched.', 409);
    let amount: number;
    if (kind === 'document') {
      const d = await this.getDocument(target);
      const open = dueCents(d) - d.paid_cents;
      amount = 'amount_cents' in i || 'amount' in i ? Math.abs(readCents(i, 'amount')) : Math.min(remaining, open > 0 ? open : remaining);
      if (amount > remaining) throw new FinanceError(`Only ${formatMoney(remaining, d.currency)} of this transaction is still unassigned.`, 422);
      if (!amount) throw new FinanceError('The amount to assign is zero.');
      // Positive = settles the document: money in for an invoice, money out
      // for a credit note. The other direction undoes a settlement.
      const settles = (t.amount_cents > 0) === (d.type !== 'credit_note');
      const signed = settles ? amount : -amount;
      // A customer who paid the Skonto amount in time settles the invoice:
      // the missing few percent are booked as Skonto, not left open.
      const sk = skontoFor(d);
      const takesSkonto = settles && !!sk && amount < open && t.booking_date <= addDays(sk.until, 3)
        && Math.abs(open - amount - sk.discount_cents) <= 1 && i.settle !== false;
      await this.recordPayment(target, {
        amount_cents: signed, date: t.booking_date, method: 'bank', reference: t.purpose.slice(0, 200), bank_tx_id: t.id,
        ...(takesSkonto ? { settle: 'skonto' } : i.settle === 'skonto' || i.settle === 'difference' ? { settle: i.settle } : {}),
      }, actor);
    } else {
      const e = await this.getExpense(target);
      amount = 'amount_cents' in i || 'amount' in i ? Math.abs(readCents(i, 'amount')) : Math.min(remaining, e.gross_cents - e.paid_cents);
      if (amount > remaining) throw new FinanceError(`Only ${formatMoney(remaining, 'EUR')} of this transaction is still unassigned.`, 422);
      if (!amount) throw new FinanceError('The amount to assign is zero.');
      const paid = e.paid_cents + amount;
      await this.store.put(COL.expenses, e.id, {
        ...e, paid_cents: paid, status: paid >= e.gross_cents ? 'paid' : 'open', paid_date: t.booking_date, bank_tx_id: t.id, updated_at: this.stamp(),
      } as unknown as Record<string, unknown>);
    }
    const matches = [...(t.matches ?? []), { kind, id: target, amount_cents: amount } as const];
    const next: BankTransaction = { ...t, matches, status: matches.reduce((s, m) => s + Math.abs(m.amount_cents), 0) >= Math.abs(t.amount_cents) ? 'matched' : 'unmatched' };
    await this.putBankTx(next);
    await this.log(actor, 'bank.match', 'bank_tx', t.id, `→ ${kind} ${target}`);
    return next;
  }

  /**
   * A bank debit with no receipt yet becomes a booked, paid expense — the
   * quick way to turn "Hetzner −45,80 €" into something with input VAT. The
   * receipt can be attached afterwards; until then it shows as "kein Beleg" and
   * is listed as missing in the accountant package.
   */
  expenseFromBankTx(txId: string, input: unknown, actor: string): Promise<{ expense: Expense; transaction: BankTransaction }> {
    return withBankLock(() => this.expenseFromBankTxLocked(txId, input, actor));
  }

  private async expenseFromBankTxLocked(txId: string, input: unknown, actor: string): Promise<{ expense: Expense; transaction: BankTransaction }> {
    const i = asObj(input);
    const t = await this.findBankTx(txId);
    if (!t) throw new FinanceError('Bank transaction not found.', 404);
    if (t.amount_cents >= 0) throw new FinanceError('Only money going out can become an expense.', 409);
    if (t.status !== 'unmatched' || (t.matches?.length ?? 0) > 0) throw new FinanceError('This transaction is already booked.', 409);
    const rate = [19, 7, 0].includes(Number(i.tax_rate)) ? Number(i.tax_rate) : 19;
    const expense = await this.saveExpense(null, {
      supplier_name: str(i.supplier_name, 200) ?? t.counterparty_name ?? 'Unbekannt',
      invoice_number: str(i.invoice_number, 100),
      date: t.booking_date,
      status: 'open',
      category: str(i.category, 40) ?? 'other',
      gross_cents: -t.amount_cents,
      tax_rate: rate,
      description: t.purpose.slice(0, 200),
      note: 'Aus Bankumsatz angelegt — Beleg nachreichen.',
    }, actor, { source: 'bank' });
    const transaction = await this.matchBankTxLocked(txId, { kind: 'expense', id: expense.id }, actor);
    return { expense: await this.getExpense(expense.id), transaction };
  }

  async categorizeBankTx(txId: string, input: unknown, actor: string): Promise<BankTransaction> {
    const i = asObj(input);
    const t = await this.findBankTx(txId);
    if (!t) throw new FinanceError('Bank transaction not found.', 404);
    const status = i.ignore ? 'ignored' : i.category ? 'matched' : 'unmatched';
    const next: BankTransaction = { ...t, category: str(i.category, 40), status };
    await this.putBankTx(next);
    await this.log(actor, 'bank.categorize', 'bank_tx', t.id, i.ignore ? 'ignored' : `category ${next.category ?? '—'}`);
    return next;
  }

  unmatchBankTx(txId: string, actor: string): Promise<BankTransaction> {
    return withBankLock(() => this.unmatchBankTxLocked(txId, actor));
  }

  private async unmatchBankTxLocked(txId: string, actor: string): Promise<BankTransaction> {
    const t = await this.findBankTx(txId);
    if (!t) throw new FinanceError('Bank transaction not found.', 404);
    for (const p of (await this.listPayments()).filter((p) => p.bank_tx_id === t.id)) {
      await withLock(async () => {
        await this.store.delete(COL.payments, p.id);
        await this.recalcPaid(p.document_id);
      });
    }
    for (const m of t.matches ?? []) {
      if (m.kind !== 'expense') continue;
      const e = await this.store.get<Expense>(COL.expenses, m.id);
      if (e) {
        const paid = Math.max(0, e.paid_cents - m.amount_cents);
        await this.store.put(COL.expenses, e.id, { ...e, paid_cents: paid, status: paid >= e.gross_cents ? 'paid' : 'open', bank_tx_id: undefined, paid_date: paid ? e.paid_date : undefined } as unknown as Record<string, unknown>);
      }
    }
    const next: BankTransaction = { ...t, matches: [], category: undefined, status: 'unmatched' };
    await this.putBankTx(next);
    await this.log(actor, 'bank.unmatch', 'bank_tx', t.id);
    return next;
  }

  private async unlinkBankTx(txId: string, kind: 'document' | 'expense', targetId: string) {
    const t = await this.findBankTx(txId);
    if (!t) return;
    const matches = (t.matches ?? []).filter((m) => !(m.kind === kind && m.id === targetId));
    await this.putBankTx({ ...t, matches, status: matches.length ? t.status : 'unmatched' });
  }

  /* ----------------------------- recurring ----------------------------- */

  async listRecurring(): Promise<RecurringTemplate[]> {
    return (await this.store.list<RecurringTemplate>(COL.recurring, ALL)).map((r) => r.data);
  }

  async saveRecurring(rid: string | null, input: unknown, actor: string): Promise<RecurringTemplate> {
    const before = rid ? await this.store.get<RecurringTemplate>(COL.recurring, rid) : undefined;
    if (rid && !before) throw new FinanceError('Recurring invoice not found.', 404);
    await this.getContact(String(asObj(input).contact_id ?? before?.contact_id ?? ''));
    const now = this.stamp();
    const r: RecurringTemplate = { ...normRecurring(input, before), id: before?.id ?? id('rc'), last_document_id: before?.last_document_id, created_at: before?.created_at ?? now, updated_at: now };
    await this.store.put(COL.recurring, r.id, r as unknown as Record<string, unknown>);
    await this.log(actor, rid ? 'recurring.update' : 'recurring.create', 'recurring', r.id, r.name);
    return r;
  }

  async deleteRecurring(rid: string, actor: string) {
    await this.store.delete(COL.recurring, rid);
    await this.log(actor, 'recurring.delete', 'recurring', rid);
  }

  /** Create every invoice and standing expense that is due today or earlier. Idempotent per period. */
  runRecurring(actor: string): Promise<{ created: string[]; errors: string[]; expenses: string[] }> {
    return singleFlight('recurring', async () => {
      const inv = await this.runRecurringOnce(actor);
      const exp = await this.runRecurringExpensesOnce(actor);
      return { created: inv.created, errors: [...inv.errors, ...exp.errors], expenses: exp.created };
    });
  }

  /* ----------------------------- standing expenses (Dauerbelege) ----------------------------- */

  async listRecurringExpenses(): Promise<RecurringExpense[]> {
    return (await this.store.list<RecurringExpense>(COL.recurringExpenses, ALL)).map((r) => r.data);
  }

  async saveRecurringExpense(rid: string | null, input: unknown, actor: string): Promise<RecurringExpense> {
    const i = asObj(input);
    const before = rid ? await this.store.get<RecurringExpense>(COL.recurringExpenses, rid) : undefined;
    if (rid && !before) throw new FinanceError('Standing expense not found.', 404);
    const pick = <K extends keyof RecurringExpense>(k: K, fn: (v: unknown) => RecurringExpense[K] | undefined): RecurringExpense[K] | undefined => (k in i ? fn(i[k as string]) : before?.[k]);
    const contactId = pick('contact_id', (v) => str(v, 60));
    if (contactId) await this.getContact(contactId);
    const nextDate = pick('next_date', (v) => readDate(v, 'next_date')) ?? this.today();
    const r: RecurringExpense = {
      id: before?.id ?? id('rx'),
      name: pick('name', (v) => str(v, 120)) ?? '',
      active: pick('active', (v) => v !== false && v !== 'false') ?? true,
      supplier_name: pick('supplier_name', (v) => str(v, 200)) ?? '',
      contact_id: contactId,
      category: pick('category', (v) => str(v, 40)) ?? 'other',
      gross_cents: 'gross' in i || 'gross_cents' in i ? readCents(i, 'gross') : before?.gross_cents ?? 0,
      tax_rate: pick('tax_rate', (v) => ([19, 7, 0].includes(Number(v)) ? Number(v) : 19)) ?? 19,
      description: pick('description', (v) => str(v, 300)),
      interval: pick('interval', (v) => (v === 'quarterly' || v === 'yearly' ? v : 'monthly')) ?? 'monthly',
      next_date: nextDate,
      end_date: pick('end_date', (v) => readDate(v, 'end_date')),
      anchor_day: pick('anchor_day', (v) => (v ? Math.min(31, Math.max(1, Math.round(Number(v)))) : undefined)) ?? Number(nextDate.slice(8, 10)),
      book_as_paid: pick('book_as_paid', (v) => v === true || v === 'true') ?? false,
      last_expense_id: before?.last_expense_id,
      created_at: before?.created_at ?? this.stamp(),
      updated_at: this.stamp(),
    };
    if (!r.supplier_name && !r.contact_id) throw new FinanceError('A standing expense needs a supplier.');
    if (!r.name) r.name = r.supplier_name;
    if (r.gross_cents <= 0) throw new FinanceError('A standing expense needs a positive amount.');
    await this.store.put(COL.recurringExpenses, r.id, r as unknown as Record<string, unknown>);
    await this.log(actor, rid ? 'recurring_expense.update' : 'recurring_expense.create', 'recurring_expense', r.id, r.name);
    return r;
  }

  async deleteRecurringExpense(rid: string, actor: string): Promise<void> {
    await this.store.delete(COL.recurringExpenses, rid);
    await this.log(actor, 'recurring_expense.delete', 'recurring_expense', rid);
  }

  private async runRecurringExpensesOnce(actor: string): Promise<{ created: string[]; errors: string[] }> {
    const today = this.today();
    const created: string[] = [];
    const errors: string[] = [];
    for (const r of await this.listRecurringExpenses()) {
      let tpl = r;
      let guard = 0;
      while (tpl.active && tpl.next_date <= today && (!tpl.end_date || tpl.next_date <= tpl.end_date) && guard++ < 24) {
        const ref = `recurring_expense:${tpl.id}:${tpl.next_date}`;
        const months = tpl.interval === 'yearly' ? 12 : tpl.interval === 'quarterly' ? 3 : 1;
        try {
          if (!(await this.store.get(COL.refs, ref))) {
            const e = await this.saveExpense(null, {
              supplier_name: tpl.supplier_name || undefined, contact_id: tpl.contact_id, date: tpl.next_date,
              gross_cents: tpl.gross_cents, tax_rate: tpl.tax_rate, category: tpl.category,
              description: tpl.description ?? tpl.name, status: tpl.book_as_paid ? 'paid' : 'open',
              ...(tpl.book_as_paid ? { paid_date: tpl.next_date } : {}),
              note: `Dauerbeleg „${tpl.name}“ — Vertrag/Dauerrechnung als Beleg.`,
            }, actor, { source: 'recurring' });
            await this.store.put(COL.refs, ref, { expense_id: e.id });
            created.push(e.id);
            tpl = { ...tpl, last_expense_id: e.id };
          }
        } catch (e) {
          errors.push(`${tpl.name}: ${(e as Error).message}`);
          break;
        }
        tpl = { ...tpl, next_date: addMonthsAnchored(tpl.next_date, months, tpl.anchor_day ?? Number(tpl.next_date.slice(8, 10))), updated_at: this.stamp() };
        await this.store.put(COL.recurringExpenses, tpl.id, tpl as unknown as Record<string, unknown>);
      }
    }
    return { created, errors };
  }

  private async runRecurringOnce(actor: string): Promise<{ created: string[]; errors: string[] }> {
    const today = this.today();
    const created: string[] = [];
    const errors: string[] = [];
    for (const r of await this.listRecurring()) {
      let tpl = r;
      let guard = 0;
      while (tpl.active && tpl.next_date <= today && (!tpl.end_date || tpl.next_date <= tpl.end_date) && guard++ < 24) {
        const ref = `recurring:${tpl.id}:${tpl.next_date}`;
        const months = tpl.interval === 'yearly' ? 12 : tpl.interval === 'quarterly' ? 3 : 1;
        const periodEnd = addDays(addMonthsAnchored(tpl.next_date, months, tpl.anchor_day ?? Number(tpl.next_date.slice(8, 10))), -1);
        try {
          // A ref already exists when an earlier run created the draft but
          // failed to finalize or send it: resume that document instead of
          // silently moving on (and leaving the period unbilled).
          const existing = await this.store.get<{ document_id: string }>(COL.refs, ref);
          const prior = existing ? await this.store.get<FinanceDocument>(COL.documents, existing.document_id) : undefined;
          if (prior) {
            let final = prior;
            if (tpl.auto_finalize && final.status === 'draft') final = await this.finalize(final.id, actor);
            if (tpl.auto_finalize && tpl.auto_send && final.status !== 'draft' && !final.sent_at && final.recipient.email && this.canSendMail()) await this.sendDocument(final.id, {}, actor);
            if (final !== prior) created.push(final.id);
          } else {
            const doc = await this.createDocument({
              type: 'invoice', contact_id: tpl.contact_id, title: tpl.title, intro: tpl.intro, closing: tpl.closing,
              price_mode: tpl.price_mode, issue_date: tpl.next_date,
              ...(tpl.tax_treatment ? { tax_treatment: tpl.tax_treatment } : {}),
              ...(tpl.payment_days !== undefined ? { payment_days: tpl.payment_days } : {}),
              service_date: tpl.next_date, service_date_end: periodEnd,
              lines: tpl.lines.map((l) => ({ ...l, id: undefined, ...(tpl.bill_period && l.type === 'item' ? { period_start: tpl.next_date, period_end: periodEnd } : {}) })),
            }, actor, { recurring_id: tpl.id, external_ref: ref, source: 'recurring' });
            let final = doc;
            if (tpl.auto_finalize) {
              final = await this.finalize(doc.id, actor);
              if (tpl.auto_send && final.recipient.email && this.canSendMail()) await this.sendDocument(final.id, {}, actor);
            }
            created.push(final.id);
            tpl = { ...tpl, last_document_id: final.id };
          }
        } catch (e) {
          errors.push(`${tpl.name}: ${(e as Error).message}`);
          break;
        }
        tpl = { ...tpl, next_date: addMonthsAnchored(tpl.next_date, months, tpl.anchor_day ?? Number(tpl.next_date.slice(8, 10))), updated_at: this.stamp() };
        await this.store.put(COL.recurring, tpl.id, tpl as unknown as Record<string, unknown>);
      }
    }
    return { created, errors };
  }

  /* ----------------------------- integrations ----------------------------- */

  /**
   * One sale from an outside system (a website checkout, the licence centre,
   * Shopify…) → contact upsert + invoice, optionally finalized and paid.
   * Idempotent on `source` + `external_id`: a webhook delivered twice creates
   * one invoice.
   */
  async inboundSale(input: unknown, actor: string): Promise<{ document: FinanceDocument; created: boolean }> {
    const i = asObj(input);
    const source = str(i.source, 40);
    const externalId = str(i.external_id, 120);
    if (!source || !externalId) throw new FinanceError('"source" and "external_id" are required for idempotency.');
    const ref = `${source}:${externalId}`;
    let first = false;
    const result = await singleFlight(`sale:${ref}`, () => { first = true; return this.inboundSaleOnce(i, ref, source, actor); });
    // A concurrent duplicate waited for the first and reports it as not created.
    return first ? result : { document: result.document, created: false };
  }

  private async inboundSaleOnce(i: Record<string, unknown>, ref: string, source: string, actor: string): Promise<{ document: FinanceDocument; created: boolean }> {
    const existing = await this.store.get<{ document_id: string }>(COL.refs, ref);
    if (existing) return { document: await this.getDocument(existing.document_id), created: false };
    const cust = asObj(i.customer);
    const contact = await this.upsertContact({
      kind: cust.company_name ? 'company' : 'person',
      company_name: cust.company_name, first_name: cust.first_name, last_name: cust.last_name ?? cust.name,
      email: cust.email, vat_id: cust.vat_id, billing_address: cust.address ?? cust.billing_address, phone: cust.phone,
    }, source, str(cust.external_id, 120), actor);
    const doc = await this.createDocument({
      type: 'invoice', contact_id: contact.id, lines: i.lines, price_mode: i.price_mode ?? 'gross',
      tax_treatment: i.tax_treatment, issue_date: i.issue_date, service_date: i.service_date,
      intro: i.intro, title: i.title, einvoice_format: i.einvoice_format, currency: i.currency,
    }, actor, { source, external_ref: ref });
    let final = doc;
    if (i.finalize !== false) {
      final = await this.finalize(doc.id, actor);
      const paid = asObj(i.paid);
      if (i.paid) {
        const paidCents = 'amount_cents' in paid || 'amount' in paid ? readCents(paid, 'amount') : dueCents(final);
        // Gross prices re-split into net + VAT per rate can land a cent or two
        // above what the checkout charged. That is a rounding difference, not
        // an open receivable to dun: write it off.
        const diff = dueCents(final) - paidCents;
        const roundingOnly = diff > 0 && diff <= Math.max(2, final.lines.length);
        const r = await this.recordPayment(final.id, {
          ...(roundingOnly ? { settle: 'difference' } : {}),
          amount_cents: paidCents,
          date: paid.date, method: paid.method ?? 'other', reference: paid.reference,
        }, actor);
        final = r.document;
      }
      if (i.send_email && final.recipient.email && this.deps.sendEmail) final = await this.sendDocument(final.id, {}, actor);
    }
    return { document: final, created: true };
  }
}

/* A second, tiny lock for the log head only — logging happens inside other
   locked sections, and re-entering the main lock would deadlock. */
let logChain: Promise<unknown> = Promise.resolve();
function withLockedLog<T>(fn: () => Promise<T>): Promise<T> {
  const run = logChain.then(fn, fn);
  logChain = run.catch(() => undefined);
  return run;
}

function pickDefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== '')) as Partial<T>;
}

/** What leaves the building in a webhook: no token, no internal note. */
export function publicDoc(d: FinanceDocument) {
  return {
    id: d.id, type: d.type, status: d.status, number: d.number, contact_id: d.contact_id,
    recipient: { name: d.recipient.name, email: d.recipient.email, country: d.recipient.country },
    issue_date: d.issue_date, due_date: d.due_date, currency: d.currency,
    net_cents: d.totals.net_cents, tax_cents: d.totals.tax_cents, gross_cents: d.totals.gross_cents, due_cents: dueCents(d),
    paid_cents: d.paid_cents, external_ref: d.external_ref, source: d.source,
  };
}
