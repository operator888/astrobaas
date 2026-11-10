/**
 * Data safety: an integrity check over everything the books rest on, and a
 * complete export of the module's data.
 *
 * The integrity check answers one question — "is anything missing, altered
 * or inconsistent?" — without changing anything. It is cheap enough to run
 * on demand and from the dashboard.
 *
 * The full export is the "take it with you" copy: every record of every
 * collection as JSON, plus every archived file (invoice PDFs, e-invoice XML,
 * receipts, dunning letters), with a manifest of SHA-256 checksums. It is
 * independent of the site backup — keep one on a disk you own.
 */
import crypto from 'node:crypto';
import { COL, type Finance } from './service';
import { readArchived } from './archive';
import { dueCents } from './tax';
import { buildZip, type ZipEntry } from './zip';
import type { BankTransaction, Expense, FinanceDocument, LogEntry, Payment } from './types';

export interface IntegrityProblem {
  area: 'documents' | 'numbers' | 'payments' | 'files' | 'log' | 'bank' | 'expenses';
  severity: 'error' | 'warning';
  id?: string;
  message: string;
}

export interface IntegrityReport {
  ok: boolean;
  checked_at: string;
  counts: Record<string, number>;
  problems: IntegrityProblem[];
}

function sha256(s: string | Uint8Array): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/** Years that can hold records: from the oldest dated record to the clock's year. */
function yearsSpan(first: string | undefined, now: string): string[] {
  const from = Number((first ?? now).slice(0, 4));
  const to = Number(now.slice(0, 4));
  const out: string[] = [];
  for (let y = Math.max(2000, Math.min(from, to)); y <= to; y++) out.push(String(y));
  return out;
}

export async function integrityReport(fin: Finance): Promise<IntegrityReport> {
  const problems: IntegrityProblem[] = [];
  const err = (area: IntegrityProblem['area'], message: string, id?: string) => problems.push({ area, severity: 'error', id, message });
  const warn = (area: IntegrityProblem['area'], message: string, id?: string) => problems.push({ area, severity: 'warning', id, message });

  const docs = await fin.listDocuments();
  const payments = await fin.listPayments();
  const expenses = await fin.listExpenses();
  const numbers = new Map((await fin.store.list<{ document_id: string; imported?: boolean }>(COL.numbers, { uncapped: true })).map((r) => [r.id, r.data]));
  const byId = new Map(docs.map((d) => [d.id, d]));
  const paysBy = new Map<string, Payment[]>();
  for (const p of payments) paysBy.set(p.document_id, [...(paysBy.get(p.document_id) ?? []), p]);
  let files = 0;

  // Every number ever issued still has its document — the first sign of a
  // deleted invoice.
  for (const [num, ref] of numbers) {
    const d = byId.get(ref.document_id);
    if (!d) err('numbers', `Number ${num} was issued, but its document no longer exists.`, num);
    else if (d.number !== num) err('numbers', `Number ${num} points to a document that now carries ${d.number ?? 'no number'}.`, num);
  }

  // Gap-free numbering per series (only numbers this app issued).
  const series = new Map<string, number[]>();
  for (const d of docs) {
    if (!d.number || d.imported || d.status === 'draft') continue;
    const m = d.number.match(/^(.*?)(\d+)$/);
    if (!m) continue;
    series.set(m[1], [...(series.get(m[1]) ?? []), Number(m[2])]);
  }
  for (const [prefix, seqs] of series) {
    const sorted = [...new Set(seqs)].sort((a, b) => a - b);
    const missing: number[] = [];
    for (let i = 1; i < sorted.length; i++) for (let n = sorted[i - 1] + 1; n < sorted[i] && missing.length < 20; n++) missing.push(n);
    if (missing.length) warn('numbers', `Series ${prefix}: numbers ${missing.join(', ')} are missing between issued numbers. If a counter or pattern was changed this is expected; otherwise a document was lost.`);
  }

  for (const d of docs) {
    if (d.status === 'draft' || !d.number) continue;
    // Arithmetic.
    const t = d.totals;
    if (t.gross_cents !== t.net_cents + t.tax_cents) err('documents', `${d.number}: gross ≠ net + VAT.`, d.id);
    const gNet = t.groups.reduce((s, g) => s + g.net_cents, 0);
    const gTax = t.groups.reduce((s, g) => s + g.tax_cents, 0);
    if (gNet !== t.net_cents || gTax !== t.tax_cents) err('documents', `${d.number}: VAT groups do not add up to the totals.`, d.id);
    // Payments.
    const paid = (paysBy.get(d.id) ?? []).reduce((s, p) => s + p.amount_cents, 0);
    if (paid !== d.paid_cents) err('payments', `${d.number}: stored paid amount ${d.paid_cents} ≠ sum of its payments ${paid}.`, d.id);
    if (d.type !== 'quote' && d.status !== 'cancelled') {
      const due = dueCents(d);
      const expected = paid >= due ? 'paid' : paid > 0 ? 'partially_paid' : 'open';
      if (d.status !== expected) err('payments', `${d.number}: status "${d.status}" but payments say "${expected}".`, d.id);
    }
    // Tamper evidence.
    if (d.content_hash && !d.imported && d.seller) {
      const h = sha256(canonical({ number: d.number, issue: d.issue_date, recipient: d.recipient, seller: d.seller, lines: d.lines, totals: d.totals, treatment: d.tax_treatment, ...(d.reference ? { reference: d.reference } : {}) }));
      if (h !== d.content_hash) err('documents', `${d.number}: content no longer matches its finalization checksum — it was altered after it was issued.`, d.id);
    }
    // Archived artefacts.
    for (const [fid, what] of [[d.archived_pdf_id, 'PDF'], [d.archived_xml_id, 'XML']] as const) {
      if (!fid) continue;
      files++;
      if (!(await readArchived(fid))) err('files', `${d.number}: archived ${what} is missing or was altered on disk.`, d.id);
    }
    if (!d.archived_pdf_id && !d.imported) err('files', `${d.number}: no archived PDF.`, d.id);
    if (d.order_confirmation?.pdf_id) {
      files++;
      if (!(await readArchived(d.order_confirmation.pdf_id))) warn('files', `${d.number}: the order confirmation PDF is missing.`, d.id);
    }
  }

  for (const p of payments) if (!byId.has(p.document_id)) err('payments', `Payment ${p.id} belongs to a document that no longer exists.`, p.id);

  for (const e of expenses) {
    if (e.gross_cents !== e.net_cents + e.tax_cents) err('expenses', `Expense ${e.supplier_name} ${e.invoice_number ?? ''}: gross ≠ net + VAT.`, e.id);
    for (const fid of [e.file_id, e.xml_file_id]) {
      if (!fid) continue;
      files++;
      if (!(await readArchived(fid))) err('files', `Receipt of ${e.supplier_name} ${e.invoice_number ?? ''} (${e.date}) is missing or was altered on disk.`, e.id);
    }
  }
  for (const r of (await fin.store.list<{ id: string; pdf_id: string; document_id: string }>(COL.dunnings, { uncapped: true })).map((x) => x.data)) {
    files++;
    if (!(await readArchived(r.pdf_id))) warn('files', `A dunning letter PDF (${byId.get(r.document_id)?.number ?? r.document_id}) is missing.`, r.id);
  }

  // Bank: assignments never exceed the transaction; every bank payment is backed by a match.
  const today = fin.today();
  const firstDate = [...docs.map((d) => d.issue_date ?? d.created_at), ...expenses.map((e) => e.date)].filter(Boolean).sort()[0];
  const years = yearsSpan(firstDate, today);
  let bankTx = 0;
  for (const y of years) {
    for (const t of await fin.listBankTx(y)) {
      bankTx++;
      const assigned = (t.matches ?? []).reduce((s, m) => s + Math.abs(m.amount_cents), 0);
      if (assigned > Math.abs(t.amount_cents)) err('bank', `Bank line ${t.booking_date} ${t.counterparty_name ?? ''}: more assigned than the transaction amount.`, t.id);
      for (const m of t.matches ?? []) {
        if (m.kind === 'document' && !(paysBy.get(m.id) ?? []).some((p) => p.bank_tx_id === t.id)) {
          err('bank', `Bank line ${t.booking_date} ${t.counterparty_name ?? ''} is assigned to ${byId.get(m.id)?.number ?? m.id}, but that document has no payment from it.`, t.id);
        }
      }
    }
  }

  // The hash-chained change log, year by year.
  let logEntries = 0;
  for (const y of years) {
    const v = await fin.verifyLog(y);
    logEntries += v.entries;
    if (!v.ok) err('log', `Change log ${y}: the chain is broken at ${v.broken_at} — entries were altered or removed.`);
  }

  return {
    ok: !problems.some((p) => p.severity === 'error'),
    checked_at: new Date().toISOString(),
    counts: {
      documents: docs.filter((d) => d.status !== 'draft').length, payments: payments.length, expenses: expenses.length,
      archived_files: files, bank_transactions: bankTx, log_entries: logEntries, numbers: numbers.size,
    },
    problems,
  };
}

/** Everything the module holds, as one ZIP: records as JSON, archived files, checksums. */
export async function fullExport(fin: Finance): Promise<{ zip: Uint8Array; filename: string; manifest: { files: number; records: number } }> {
  const entries: ZipEntry[] = [];
  const manifest: { created_at: string; collections: Record<string, number>; files: { name: string; sha256: string; size: number; id: string }[] } = {
    created_at: new Date().toISOString(), collections: {}, files: [],
  };
  const enc = new TextEncoder();
  const put = (name: string, rows: unknown[]) => {
    manifest.collections[name] = rows.length;
    entries.push({ name: `data/${name}.json`, data: enc.encode(JSON.stringify(rows, null, 1)) });
  };
  const all = async <T>(col: string) => (await fin.store.list<T>(col, { uncapped: true })).map((r) => r.data);

  const docs = await all<FinanceDocument>(COL.documents);
  const expenses = await all<Expense>(COL.expenses);
  for (const c of [COL.config, COL.contacts, COL.articles, COL.counters, COL.numbers, COL.refs, COL.payments, COL.bankAccounts, COL.recurring, COL.recurringExpenses, COL.dunnings]) {
    // config holds secrets for nothing but integrations' own keys; settings
    // and the company profile are what a restore needs.
    put(c, (await fin.store.list(c, { uncapped: true })).map((r) => ({ id: r.id, ...r.data })));
  }
  put(COL.documents, docs);
  put(COL.expenses, expenses);
  const firstDate = [...docs.map((d) => d.issue_date ?? d.created_at), ...expenses.map((e) => e.date)].filter(Boolean).sort()[0];
  for (const y of yearsSpan(firstDate, fin.today())) {
    const tx = await all<BankTransaction>(COL.bankTx(y));
    if (tx.length) put(COL.bankTx(y), tx);
    const log = await all<LogEntry>(COL.log(y));
    if (log.length) put(COL.log(y), log);
  }

  // Every archived file referenced anywhere, once.
  const ids = new Set<string>();
  for (const d of docs) for (const f of [d.archived_pdf_id, d.archived_xml_id, d.order_confirmation?.pdf_id]) if (f) ids.add(f);
  for (const e of expenses) for (const f of [e.file_id, e.xml_file_id]) if (f) ids.add(f);
  for (const r of await all<{ pdf_id: string }>(COL.dunnings)) if (r.pdf_id) ids.add(r.pdf_id);
  const missing: string[] = [];
  for (const id of ids) {
    const a = await readArchived(id);
    if (!a) { missing.push(id); continue; }
    const ext = a.meta.kind === 'jpeg' ? 'jpg' : a.meta.kind;
    const name = `files/${id}.${ext}`;
    entries.push({ name, data: a.bytes });
    entries.push({ name: `files/${id}.json`, data: enc.encode(JSON.stringify(a.meta, null, 1)) });
    manifest.files.push({ name, sha256: a.meta.sha256, size: a.bytes.length, id });
  }
  entries.push({ name: 'manifest.json', data: enc.encode(JSON.stringify({ ...manifest, missing_files: missing }, null, 1)) });
  entries.push({
    name: 'LIESMICH.txt',
    data: enc.encode([
      'ECWS Billing — vollständiger Datenexport',
      `Erstellt: ${manifest.created_at}`,
      '',
      'data/   alle Datensätze als JSON (Belege, Zahlungen, Kontakte, Ausgaben, Bank, Änderungsprotokoll …)',
      'files/  alle archivierten Dateien (Rechnungs-PDFs, E-Rechnungen, Belege, Mahnungen) mit Metadaten',
      'manifest.json  Anzahl der Datensätze und SHA-256-Prüfsumme jeder Datei',
      '',
      'Bewahre diese Datei zusätzlich zur Server-Sicherung auf einem eigenen Datenträger auf.',
      missing.length ? `ACHTUNG: ${missing.length} archivierte Datei(en) fehlen oder sind beschädigt — siehe manifest.json (missing_files).` : 'Alle archivierten Dateien vollständig und unverändert.',
      '',
    ].join('\n')),
  });
  const stamp = fin.today();
  return {
    zip: buildZip(entries),
    filename: `ECWS-Billing-Datenexport_${stamp}.zip`,
    manifest: { files: manifest.files.length, records: Object.values(manifest.collections).reduce((a, b) => a + b, 0) },
  };
}
