/**
 * The finance module's HTTP API, under /api/plugin/finance/.
 *
 * Who may call it:
 *  - signed-in admins and managers (the admin screens, with CSRF);
 *  - API keys belonging to an admin or manager — scope them to
 *    `finance:read` / `finance:write` so a website's key can create invoices
 *    and touch nothing else;
 *  - two deliberately public routes: the customer's document link (an
 *    unguessable token per document) and the signed inbound-sale webhook.
 *
 * Editors and authors are refused even though they are "staff": money is not
 * content.
 */
import crypto from 'node:crypto';
import type { PluginRoute } from '../../lib/plugin-platform/routes';
import type { PluginRouteContext } from '../../lib/plugin-platform/routes';
import { COL, Finance, publicDoc, type Deps } from './lib/service';
import { FinanceError, asObj } from './lib/normalize';
import { readArchived } from './lib/archive';
import { vatReturn, profitLoss, openItems, datevBookings, bookedDocuments, zusammenfassendeMeldung } from './lib/reports';
import { buildBuchungsstapel, encodeCp1252 } from './lib/datev';
import { buildZip, type ZipEntry } from './lib/zip';
import { EXPENSE_CATEGORIES } from './lib/accounts';
import { UNITS } from './lib/strings';
import { EU_COUNTRIES } from './lib/tax';
import { startLexwareImport, importContactsCsv } from './lib/importer';
import { contactDisplayName, addDays, addMonths } from './lib/format';
import type { BankTransaction, Contact, DocumentType, Expense, FinanceDocument } from './lib/types';
import { portalCsp, renderPortal } from './lib/portal';

const P = '/api/plugin/finance';

const PORTAL_ERRORS: Record<string, string> = {
  answered: 'Dieses Angebot wurde bereits beantwortet.',
  expired: 'Dieses Angebot ist abgelaufen.',
  name: 'Bitte geben Sie Ihren Namen an, um das Angebot anzunehmen.',
  invalid: 'Ihre Antwort konnte nicht verarbeitet werden. Bitte versuchen Sie es erneut.',
};
const FINANCE_ROLES = new Set(['admin', 'manager']);

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(status < 400 ? { success: true, data } : data), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra },
  });
}

function fail(message: string, status = 400, code = 'FINANCE_ERROR'): Response {
  return json({ success: false, error: { message, code } }, status);
}

function file(bytes: Uint8Array | string, type: string, filename: string, inline = false, warnings: string[] = []): Response {
  const safe = filename.replace(/[^A-Za-z0-9._-]/g, '_');
  const body = typeof bytes === 'string' ? bytes : Buffer.from(bytes);
  return new Response(body, {
    headers: {
      'Content-Type': type,
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${safe}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      ...(warnings.length ? { 'X-Finance-Warnings': String(warnings.length) } : {}),
    },
  });
}

async function body(request: Request): Promise<Record<string, unknown>> {
  if (request.method === 'GET') return {};
  const text = await request.text();
  if (!text) return {};
  try {
    return asObj(JSON.parse(text));
  } catch {
    throw new FinanceError('The request body is not valid JSON.');
  }
}

function actorOf(ctx: PluginRouteContext): string {
  const u = ctx.user;
  return u ? (u.email || u.id) : 'system';
}

type Handler = (ctx: PluginRouteContext & { fin: Finance; actor: string }) => Promise<Response>;

/**
 * Wrap a handler: role gate, a Finance instance bound to this request, and
 * FinanceError → JSON with its status. Anything else is a 500 the platform logs.
 */
export function makeRoutes(depsFor: (ctx: PluginRouteContext) => Deps) {
  const guarded = (h: Handler, roles = FINANCE_ROLES) => async (ctx: PluginRouteContext) => {
    if (!ctx.user || !roles.has(ctx.user.role)) return fail('Finance is limited to administrators and managers.', 403, 'FORBIDDEN');
    try {
      return await h({ ...ctx, fin: new Finance(ctx.store, depsFor(ctx)), actor: actorOf(ctx) });
    } catch (e) {
      if (e instanceof FinanceError) return fail(e.message, e.status);
      throw e;
    }
  };
  const adminOnly = new Set(['admin']);
  const r = (method: PluginRoute['method'], path: string, h: Handler, opts: { admin?: boolean; description?: string } = {}): PluginRoute => ({
    method,
    path: `${P}${path}`,
    access: 'staff',
    scope: method === 'GET' ? 'finance:read' : 'finance:write',
    description: opts.description,
    handler: guarded(h, opts.admin ? adminOnly : FINANCE_ROLES),
  });

  const routes: PluginRoute[] = [
    /* ------------------------------ meta & dashboard ------------------------------ */
    r('GET', '/meta', async ({ fin }) => json({
      email: fin.emailStatus(),
      categories: EXPENSE_CATEGORIES.map((c) => ({ key: c.key, de: c.de, en: c.en, default_rate: c.default_rate, note: c.note })),
      units: Object.entries(UNITS).map(([code, l]) => ({ code, ...l })),
      eu_countries: [...EU_COUNTRIES],
      treatments: ['domestic', 'small_business', 'reverse_charge_eu', 'intra_community_supply', 'third_country_service', 'export'],
    })),
    r('GET', '/summary', async ({ fin }) => {
      const today = fin.today();
      const year = today.slice(0, 4);
      const month = today.slice(0, 7);
      const [docs, expenses, company, payments] = await Promise.all([fin.listDocuments(), fin.listExpenses(), fin.company(), fin.listPayments()]);
      const bankYear = await fin.listBankTx(year);
      const pnlYear = profitLoss({ from: `${year}-01-01`, to: `${year}-12-31` }, docs, expenses, bankYear, payments);
      const pnlMonth = profitLoss({ from: `${month}-01`, to: `${month}-31` }, docs, expenses, bankYear, payments);
      const items = openItems(docs, expenses, today);
      const q = Math.floor((Number(today.slice(5, 7)) - 1) / 3);
      const qFrom = `${year}-${String(q * 3 + 1).padStart(2, '0')}-01`;
      const qTo = addMonths(qFrom, 3);
      const vat = vatReturn({ from: qFrom, to: prevDay(qTo) }, company.vat_basis, docs, payments, expenses, company.small_business);
      const unmatched = bankYear.filter((t) => t.status === 'unmatched').length;
      const dunning = await fin.dunningSuggestions();
      return json({
        company_ready: !!(company.name && company.street && (company.vat_id || company.tax_number)),
        currency: company.default_currency,
        revenue_month_cents: pnlMonth.revenue_net_cents,
        revenue_year_cents: pnlYear.revenue_net_cents,
        expenses_year_cents: pnlYear.expenses_net_cents,
        result_year_cents: pnlYear.result_cents,
        revenue_by_month: pnlYear.revenue_by_month,
        expenses_by_category: pnlYear.expenses_by_category,
        receivables_cents: items.filter((i) => i.kind === 'receivable').reduce((s, i) => s + i.open_cents, 0),
        overdue_cents: items.filter((i) => i.kind === 'receivable' && i.days_overdue > 0).reduce((s, i) => s + i.open_cents, 0),
        overdue_count: items.filter((i) => i.kind === 'receivable' && i.days_overdue > 0).length,
        payables_cents: items.filter((i) => i.kind === 'payable').reduce((s, i) => s + i.open_cents, 0),
        vat_quarter: { from: qFrom, payable_cents: vat.payable_cents },
        drafts: docs.filter((d) => d.status === 'draft').length,
        expense_drafts: expenses.filter((e) => e.status === 'draft').length,
        expenses_without_receipt: expenses.filter((e) => e.status !== 'draft' && !e.file_id && !e.xml_file_id && e.date >= `${year}-01-01`).length,
        quotes_expiring: docs.filter((d) => d.type === 'quote' && d.status === 'open' && d.valid_until && d.valid_until >= today && d.valid_until <= addDays(today, 7)).length,
        bank_accounts: (await fin.listBankAccounts()).length,
        email: fin.emailStatus(),
        has_logo: !!company.logo_data_url,
        datev_ready: !!(company.datev_consultant_number && company.datev_client_number),
        unmatched_bank: unmatched,
        dunning_due: dunning.length,
        top_customers: pnlYear.top_customers.slice(0, 5),
        recent: docs.slice(0, 8).map(publicDoc),
      });
    }),

    /* ------------------------------ company & settings ------------------------------ */
    r('GET', '/company', async ({ fin }) => json(await fin.company())),
    r('PUT', '/company', async ({ fin, request, actor }) => json(await fin.saveCompany(await body(request), actor)), { admin: true }),
    r('GET', '/settings', async ({ fin }) => json(await fin.settings())),
    r('PUT', '/settings', async ({ fin, request, actor }) => json(await fin.saveSettings(await body(request), actor)), { admin: true }),

    /* ------------------------------ contacts ------------------------------ */
    r('GET', '/contacts', async ({ fin, url }) => {
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      const role = url.searchParams.get('role');
      let list = await fin.listContacts();
      if (!url.searchParams.get('archived')) list = list.filter((c) => !c.archived);
      if (role === 'customer') list = list.filter((c) => c.roles.customer);
      if (role === 'vendor') list = list.filter((c) => c.roles.vendor);
      if (q) list = list.filter((c) => [contactDisplayName(c), c.email, c.customer_number, c.vendor_number, c.vat_id].some((v) => v?.toLowerCase().includes(q)));
      return json(list.sort((a, b) => contactDisplayName(a).localeCompare(contactDisplayName(b))));
    }),
    r('POST', '/contacts', async ({ fin, request, actor }) => json(await fin.createContact(await body(request), actor), 201)),
    r('GET', '/contacts/:id', async ({ fin, params }) => {
      const c = await fin.getContact(params.id);
      const docs = await fin.listDocuments({ contact_id: c.id });
      return json({ ...c, documents: docs.map(publicDoc) });
    }),
    r('PUT', '/contacts/:id', async ({ fin, params, request, actor }) => json(await fin.updateContact(params.id, await body(request), actor))),
    r('POST', '/upload/contacts', async ({ fin, request, actor }) => json(await importContactsCsv(fin, await request.text(), actor))),

    /* ------------------------------ articles ------------------------------ */
    r('GET', '/articles', async ({ fin }) => json((await fin.listArticles()).filter((a) => !a.archived).sort((a, b) => a.title.localeCompare(b.title)))),
    r('POST', '/articles', async ({ fin, request, actor }) => json(await fin.saveArticle(null, await body(request), actor), 201)),
    r('PUT', '/articles/:id', async ({ fin, params, request, actor }) => json(await fin.saveArticle(params.id, await body(request), actor))),
    r('DELETE', '/articles/:id', async ({ fin, params, actor }) => { await fin.deleteArticle(params.id, actor); return json({ deleted: true }); }),

    /* ------------------------------ documents ------------------------------ */
    r('GET', '/documents', async ({ fin, url }) => {
      const sp = url.searchParams;
      const type = (['invoice', 'quote', 'credit_note'].includes(sp.get('type') ?? '') ? sp.get('type') : undefined) as DocumentType | undefined;
      let list = await fin.listDocuments({ type, status: sp.get('status') ?? undefined, contact_id: sp.get('contact_id') ?? undefined });
      const q = (sp.get('q') ?? '').toLowerCase();
      if (q) list = list.filter((d) => [d.number, d.recipient.name, d.title, d.external_ref].some((v) => v?.toLowerCase().includes(q)));
      const from = sp.get('from');
      const to = sp.get('to');
      if (from) list = list.filter((d) => (d.issue_date ?? d.created_at) >= from);
      if (to) list = list.filter((d) => (d.issue_date ?? d.created_at).slice(0, 10) <= to);
      const today = fin.today();
      return json(list.map((d) => ({ ...publicDoc(d), title: d.title, invoice_kind: d.invoice_kind, overdue: fin.isOverdue(d), days_overdue: d.due_date && fin.isOverdue(d) ? Math.round((Date.parse(today) - Date.parse(d.due_date)) / 864e5) : 0, dunning_level: d.dunning_level ?? 0, sent_at: d.sent_at })));
    }),
    r('POST', '/documents', async ({ fin, request, actor }) => {
      const b = await body(request);
      const doc = await fin.createDocument(b, actor);
      return json(b.finalize ? await fin.finalize(doc.id, actor) : doc, 201);
    }),
    r('GET', '/documents/:id', async ({ fin, params }) => {
      const d = await fin.getDocument(params.id);
      return json({ ...d, payments: await fin.listPayments(d.id), dunnings: await fin.listDunnings(d.id), public_url: d.public_token ? await fin.publicLink(d) : undefined });
    }),
    r('PUT', '/documents/:id', async ({ fin, params, request, actor }) => json(await fin.updateDocument(params.id, await body(request), actor))),
    r('DELETE', '/documents/:id', async ({ fin, params, actor }) => { await fin.deleteDraft(params.id, actor); return json({ deleted: true }); }),
    r('GET', '/documents/:id/check', async ({ fin, params }) => json(await fin.check(params.id))),
    r('POST', '/documents/:id/finalize', async ({ fin, params, actor }) => json(await fin.finalize(params.id, actor))),
    r('GET', '/documents/:id/pdf', async ({ fin, params, url }) => {
      const { bytes, filename } = await fin.documentPdf(params.id);
      return file(bytes, 'application/pdf', filename, url.searchParams.get('inline') === '1');
    }),
    r('GET', '/documents/:id/xml', async ({ fin, params }) => {
      const { xml, filename } = await fin.documentXml(params.id);
      return file(xml, 'application/xml; charset=utf-8', filename);
    }),
    r('POST', '/documents/:id/send', async ({ fin, params, request, actor }) => json(await fin.sendDocument(params.id, await body(request), actor))),
    r('POST', '/documents/:id/payments', async ({ fin, params, request, actor }) => json(await fin.recordPayment(params.id, await body(request), actor), 201)),
    r('POST', '/documents/:id/cancel', async ({ fin, params, request, actor }) => json(await fin.cancelInvoice(params.id, actor, String((await body(request)).reason ?? '').slice(0, 500) || undefined))),
    r('POST', '/documents/:id/quote-status', async ({ fin, params, request, actor }) => {
      const b = await body(request);
      return json(await fin.setQuoteStatus(params.id, b.status === 'rejected' ? 'rejected' : 'accepted', actor));
    }),
    r('POST', '/documents/:id/order-confirmation', async ({ fin, params, request, actor }) => json(await fin.orderConfirmation(params.id, await body(request), actor))),
    r('POST', '/documents/:id/to-invoice', async ({ fin, params, actor }) => json(await fin.quoteToInvoice(params.id, actor), 201)),
    r('POST', '/documents/:id/dunning', async ({ fin, params, request, actor }) => json(await fin.createDunning(params.id, await body(request), actor), 201)),
    r('POST', '/documents/:id/duplicate', async ({ fin, params, actor }) => {
      const d = await fin.getDocument(params.id);
      return json(await fin.createDocument({
        type: d.type === 'credit_note' ? 'invoice' : d.type, contact_id: d.contact_id, recipient: d.contact_id ? undefined : d.recipient,
        lines: d.lines.map((l) => ({ ...l, id: undefined })), tax_treatment: d.tax_treatment, price_mode: d.price_mode,
        currency: d.currency, title: d.title, intro: d.intro, closing: d.closing, einvoice_format: d.einvoice_format,
      }, actor), 201);
    }),
    r('DELETE', '/payments/:id', async ({ fin, params, actor }) => json(await fin.deletePayment(params.id, actor))),
    r('GET', '/dunning', async ({ fin }) => json((await fin.dunningSuggestions()).map((s) => ({ ...publicDoc(s.document), next_level: s.next_level, days_overdue: s.days_overdue })))),
    r('GET', '/files/:id', async ({ params }) => {
      const a = await readArchived(params.id);
      if (!a) return fail('File not found.', 404);
      return file(a.bytes, a.meta.mime, a.meta.name, a.meta.kind !== 'xml');
    }),

    /* ------------------------------ expenses ------------------------------ */
    r('GET', '/expenses', async ({ fin, url }) => {
      let list = await fin.listExpenses();
      const status = url.searchParams.get('status');
      if (status) list = list.filter((e) => e.status === status);
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      if (q) list = list.filter((e) => [e.supplier_name, e.invoice_number, e.note].some((v) => v?.toLowerCase().includes(q)));
      return json(list);
    }),
    r('POST', '/expenses', async ({ fin, request, actor }) => json(await fin.saveExpense(null, await body(request), actor), 201)),
    r('GET', '/expenses/:id', async ({ fin, params }) => json(await fin.getExpense(params.id))),
    r('PUT', '/expenses/:id', async ({ fin, params, request, actor }) => json(await fin.saveExpense(params.id, await body(request), actor))),
    r('DELETE', '/expenses/:id', async ({ fin, params, actor }) => { await fin.deleteExpense(params.id, actor); return json({ deleted: true }); }),
    r('POST', '/upload/receipt', async ({ fin, request, url, actor }) => {
      const bytes = new Uint8Array(await request.arrayBuffer());
      const name = url.searchParams.get('filename') ?? 'beleg';
      const res = await fin.uploadReceipt(bytes, name, actor);
      return json(res, res.duplicate ? 200 : 201);
    }),

    /* ------------------------------ bank ------------------------------ */
    r('GET', '/bank/accounts', async ({ fin }) => json(await fin.listBankAccounts())),
    r('POST', '/bank/accounts', async ({ fin, request, actor }) => json(await fin.saveBankAccount(null, await body(request), actor), 201)),
    r('PUT', '/bank/accounts/:id', async ({ fin, params, request, actor }) => json(await fin.saveBankAccount(params.id, await body(request), actor))),
    r('POST', '/upload/statement', async ({ fin, request, url, actor }) => {
      const accountId = url.searchParams.get('account_id');
      if (!accountId) return fail('account_id is required.');
      const buf = Buffer.from(await request.arrayBuffer());
      // German bank CSVs are often Windows-1252; XML and UTF-8 files say so.
      const utf8 = buf.toString('utf8');
      const text = utf8.includes('�') ? buf.toString('latin1') : utf8;
      return json(await fin.importStatement(accountId, text, actor));
    }),
    r('POST', '/bank/accounts/:id/transactions', async ({ fin, params, request, actor }) => {
      const b = await body(request);
      if (!Array.isArray(b.transactions)) return fail('Send { transactions: [...] }.');
      return json(await fin.addBankTransactions(params.id, b.transactions, actor));
    }),
    r('GET', '/bank/transactions', async ({ fin, url }) => {
      const year = url.searchParams.get('year') ?? fin.today().slice(0, 4);
      let list: BankTransaction[] = await fin.listBankTx(year);
      const status = url.searchParams.get('status');
      const account = url.searchParams.get('account_id');
      if (status) list = list.filter((t) => t.status === status);
      if (account) list = list.filter((t) => t.account_id === account);
      return json(list);
    }),
    r('GET', '/bank/transactions/:id/suggestions', async ({ fin, params }) => json(await fin.suggestionsFor(params.id))),
    r('POST', '/bank/transactions/:id/match', async ({ fin, params, request, actor }) => json(await fin.matchBankTx(params.id, await body(request), actor))),
    r('POST', '/bank/transactions/:id/categorize', async ({ fin, params, request, actor }) => json(await fin.categorizeBankTx(params.id, await body(request), actor))),
    r('POST', '/bank/transactions/:id/create-expense', async ({ fin, params, request, actor }) => json(await fin.expenseFromBankTx(params.id, await body(request), actor), 201)),
    r('POST', '/bank/transactions/:id/unmatch', async ({ fin, params, actor }) => json(await fin.unmatchBankTx(params.id, actor))),

    /* ------------------------------ recurring ------------------------------ */
    r('GET', '/recurring', async ({ fin }) => json(await fin.listRecurring())),
    r('POST', '/recurring', async ({ fin, request, actor }) => json(await fin.saveRecurring(null, await body(request), actor), 201)),
    r('PUT', '/recurring/:id', async ({ fin, params, request, actor }) => json(await fin.saveRecurring(params.id, await body(request), actor))),
    r('DELETE', '/recurring/:id', async ({ fin, params, actor }) => { await fin.deleteRecurring(params.id, actor); return json({ deleted: true }); }),
    r('POST', '/recurring/run', async ({ fin, actor }) => json(await fin.runRecurring(actor))),
    r('GET', '/recurring-expenses', async ({ fin }) => json(await fin.listRecurringExpenses())),
    r('POST', '/recurring-expenses', async ({ fin, request, actor }) => json(await fin.saveRecurringExpense(null, await body(request), actor), 201)),
    r('PUT', '/recurring-expenses/:id', async ({ fin, params, request, actor }) => json(await fin.saveRecurringExpense(params.id, await body(request), actor))),
    r('DELETE', '/recurring-expenses/:id', async ({ fin, params, actor }) => { await fin.deleteRecurringExpense(params.id, actor); return json({ deleted: true }); }),

    /* ------------------------------ reports ------------------------------ */
    r('GET', '/reports/vat', async ({ fin, url }) => {
      const { from, to } = period(url, fin.today());
      const company = await fin.company();
      return json(vatReturn({ from, to }, company.vat_basis, await fin.listDocuments(), await fin.listPayments(), await fin.listExpenses(), company.small_business));
    }),
    r('GET', '/reports/zm', async ({ fin, url }) => {
      const { from, to } = period(url, fin.today());
      const zm = zusammenfassendeMeldung({ from, to }, await fin.listDocuments());
      if (url.searchParams.get('format') !== 'csv') return json(zm);
      const eur = (c: number) => (Math.round(c / 100)).toString();
      const csv = '\uFEFF' + ['Land;USt-IdNr.;Name;Art;Betrag EUR (gerundet);Betrag exakt']
        .concat(zm.rows.map((r) => [r.country, r.vat_id, `"${csvSafe(r.name).replace(/"/g, '""')}"`, r.kind, eur(r.amount_cents), (r.amount_cents / 100).toFixed(2).replace('.', ',')].join(';'))).join('\r\n') + '\r\n';
      return file(csv, 'text/csv; charset=utf-8', `ZM_${from}_${to}.csv`);
    }),
    r('GET', '/reports/pnl', async ({ fin, url }) => {
      const p = period(url, fin.today());
      // A period can span years; bank lines are stored per year.
      const bank: BankTransaction[] = [];
      for (let y = Number(p.from.slice(0, 4)); y <= Number(p.to.slice(0, 4)); y++) bank.push(...await fin.listBankTx(String(y)));
      return json(profitLoss(p, await fin.listDocuments(), await fin.listExpenses(), bank, await fin.listPayments()));
    }),
    r('GET', '/reports/open-items', async ({ fin }) => json(openItems(await fin.listDocuments(), await fin.listExpenses(), fin.today()))),

    /* ------------------------------ exports ------------------------------ */
    r('GET', '/export/datev', async ({ fin, url }) => {
      const { csv, from, to, warnings } = await datevExport(fin, url);
      return file(encodeCp1252(csv), 'text/csv; charset=windows-1252', `EXTF_Buchungsstapel_${from}_${to}.csv`, false, warnings);
    }),
    r('GET', '/export/package', async ({ fin, url }) => {
      const { csv, from, to, warnings } = await datevExport(fin, url);
      const entries: ZipEntry[] = [{ name: `EXTF_Buchungsstapel_${from}_${to}.csv`, data: encodeCp1252(csv) }];
      const index: string[] = ['Typ;Nummer;Datum;Partner;Netto;USt;Brutto;Datei'];
      const docs = bookedDocuments(await fin.listDocuments()).filter((d) => d.issue_date! >= from && d.issue_date! <= to);
      for (const d of docs) {
        for (const fid of [d.archived_pdf_id, d.archived_xml_id]) {
          if (!fid) continue;
          const a = await readArchived(fid);
          if (!a) { warnings.push(`${d.number}: archived file ${fid} is missing or altered.`); continue; }
          const name = `Ausgangsrechnungen/${d.number}.${a.meta.kind === 'xml' ? 'xml' : 'pdf'}`;
          entries.push({ name, data: a.bytes });
          index.push(row([d.type === 'credit_note' ? 'Gutschrift' : 'Rechnung', d.number, d.issue_date, d.recipient.name, cents(d.totals.net_cents * (d.type === 'credit_note' ? -1 : 1)), cents(d.totals.tax_cents * (d.type === 'credit_note' ? -1 : 1)), cents(d.totals.gross_cents * (d.type === 'credit_note' ? -1 : 1)), name]));
        }
      }
      const expenses: Expense[] = (await fin.listExpenses()).filter((e) => e.status !== 'draft' && e.date >= from && e.date <= to);
      for (const e of expenses) {
        let name = '';
        for (const fid of [e.file_id, e.xml_file_id]) {
          if (!fid) continue;
          const a = await readArchived(fid);
          if (!a) { warnings.push(`${e.supplier_name} ${e.invoice_number ?? ''}: receipt file missing or altered.`); continue; }
          name = `Eingangsrechnungen/${e.date}_${(e.supplier_name + '_' + (e.invoice_number ?? e.id)).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80)}.${a.meta.kind === 'jpeg' ? 'jpg' : a.meta.kind}`;
          entries.push({ name, data: a.bytes });
        }
        if (!e.file_id && !e.xml_file_id) warnings.push(`${e.supplier_name} ${e.invoice_number ?? ''} (${e.date}): no receipt attached.`);
        index.push(row(['Ausgabe', e.invoice_number ?? '', e.date, e.supplier_name, cents(e.net_cents), cents(e.tax_cents), cents(e.gross_cents), name]));
      }
      entries.push({ name: 'Belegliste.csv', data: encodeCp1252(index.join('\r\n') + '\r\n') });
      if (warnings.length) entries.push({ name: 'Hinweise.txt', data: new TextEncoder().encode(warnings.join('\n') + '\n') });
      return file(buildZip(entries), 'application/zip', `Steuerberater_${from}_${to}.zip`);
    }),

    /* ------------------------------ imports & log ------------------------------ */
    r('POST', '/import/lexware', async ({ fin, request, actor }) => {
      const b = await body(request);
      const apiKey = typeof b.api_key === 'string' ? b.api_key.trim() : '';
      if (!apiKey) return fail('Paste a Lexware Office API key (Lexware → Erweiterungen → Public API).');
      const job = await startLexwareImport(fin, {
        apiKey, since: typeof b.since === 'string' ? b.since : undefined,
        contacts: b.contacts !== false, articles: b.articles !== false, invoices: b.invoices !== false,
      }, actor);
      return json(job, 202);
    }, { admin: true }),
    r('GET', '/jobs/:id', async ({ fin, params }) => {
      const job = await fin.store.get(COL.jobs, params.id);
      return job ? json(job) : fail('Job not found.', 404);
    }),
    r('GET', '/log', async ({ fin, url }) => json(await fin.listLog(url.searchParams.get('year') ?? fin.today().slice(0, 4)))),
    r('GET', '/log/verify', async ({ fin, url }) => json(await fin.verifyLog(url.searchParams.get('year') ?? fin.today().slice(0, 4))), { admin: true }),

    /* ------------------------------ integrations ------------------------------ */
    r('POST', '/sales', async ({ fin, request, actor }) => {
      const res = await fin.inboundSale(await body(request), actor);
      return json({ ...publicDoc(res.document), created: res.created }, res.created ? 201 : 200);
    }, { description: 'Create (and optionally finalize/pay) an invoice for a sale from another system. Idempotent on source + external_id.' }),
  ];

  /* ------------------------------ public routes ------------------------------ */

  // The customer's link. The token is 192 random bits per document; a wrong
  // token and an unknown document answer the same 404.
  const publicDocRoute = (kind: 'pdf' | 'xml'): PluginRoute => ({
    method: 'GET',
    path: `${P}/public/:id/:token${kind === 'xml' ? '/xml' : ''}`,
    access: 'public',
    description: `The customer-facing ${kind.toUpperCase()} of a finalized document.`,
    handler: async (ctx) => {
      const fin = new Finance(ctx.store, depsFor(ctx));
      const d = await ctx.store.get<{ public_token?: string; status: string }>(COL.documents, ctx.params.id);
      const ok = !!d?.public_token && d.status !== 'draft' && safeEqual(d.public_token, ctx.params.token);
      if (!ok) return fail('Not found.', 404, 'NOT_FOUND');
      try {
        if (kind === 'xml') {
          const { xml, filename } = await fin.documentXml(ctx.params.id);
          return file(xml, 'application/xml; charset=utf-8', filename);
        }
        const { bytes, filename } = await fin.documentPdf(ctx.params.id);
        return file(bytes, 'application/pdf', filename, true);
      } catch (e) {
        if (e instanceof FinanceError) return fail(e.message, e.status);
        throw e;
      }
    },
  });
  routes.push(publicDocRoute('pdf'), publicDocRoute('xml'));

  // The customer portal page behind the email link, and the quote answer.
  const portalAuth = async (ctx: PluginRouteContext) => {
    const d = await ctx.store.get<FinanceDocument>(COL.documents, ctx.params.id);
    return d?.public_token && d.status !== 'draft' && safeEqual(d.public_token, ctx.params.token) ? d : null;
  };
  const portalPage = (html: string, status = 200) => new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': portalCsp(),
      'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow', 'X-Frame-Options': 'DENY',
    },
  });
  routes.push({
    method: 'GET',
    path: `${P}/public/:id/:token/view`,
    access: 'public',
    description: 'Customer portal page for a finalized document (view, download, pay, accept a quote).',
    handler: async (ctx) => {
      const d = await portalAuth(ctx);
      if (!d) return portalPage('<!doctype html><meta charset="utf-8"><title>Nicht gefunden</title><p>Dieser Link ist ungültig.</p>', 404);
      const fin = new Finance(ctx.store, depsFor(ctx));
      const base = `${P}/public/${encodeURIComponent(d.id)}/${encodeURIComponent(ctx.params.token)}`;
      const notice = ({ accepted: 'Vielen Dank — Ihre Annahme ist bei uns eingegangen.', rejected: 'Ihre Absage ist bei uns eingegangen. Vielen Dank für die Rückmeldung.' } as Record<string, string>)[ctx.url.searchParams.get('done') ?? '']
        // Only fixed texts: a message taken from the URL would let anyone put
        // their own words (another IBAN…) on this page.
        ?? PORTAL_ERRORS[ctx.url.searchParams.get('error') ?? ''];
      return portalPage(renderPortal(d, d.seller ?? await fin.company(), {
        pdf: base, xml: d.einvoice_format === 'xrechnung' && d.type !== 'quote' ? `${base}/xml` : undefined,
        respond: d.type === 'quote' ? `${base}/respond` : undefined,
      }, { today: fin.today(), notice }));
    },
  });
  routes.push({
    method: 'POST',
    path: `${P}/public/:id/:token/respond`,
    access: 'public',
    // The per-document token in the URL is the credential; the form is
    // served from our own origin (form-action 'self').
    csrf: 'exempt',
    description: 'A customer accepts or declines a quote from the portal.',
    handler: async (ctx) => {
      const d = await portalAuth(ctx);
      if (!d) return fail('Not found.', 404, 'NOT_FOUND');
      const view = `${P}/public/${encodeURIComponent(d.id)}/${encodeURIComponent(ctx.params.token)}/view`;
      const form = await ctx.request.formData().catch(() => null);
      const input = form ? { decision: form.get('decision'), name: form.get('name'), note: form.get('note'), options: form.getAll('option') } : await body(ctx.request);
      try {
        const res = await new Finance(ctx.store, depsFor(ctx)).respondToQuote(d.id, input);
        return new Response(null, { status: 303, headers: { Location: `${view}?done=${res.status}` } });
      } catch (e) {
        if (e instanceof FinanceError) {
          const code = /already been answered/.test(e.message) ? 'answered' : /expired/.test(e.message) ? 'expired' : /name/.test(e.message) ? 'name' : 'invalid';
          return new Response(null, { status: 303, headers: { Location: `${view}?error=${code}` } });
        }
        throw e;
      }
    },
  });

  // Signed webhook for sales from other backends that cannot hold an API key
  // safely (or prefer HMAC). Header: X-Finance-Signature: t=<unix>,v1=<hex>
  // where v1 = HMAC-SHA256(FINANCE_INBOUND_SECRET, `${t}.${rawBody}`).
  routes.push({
    method: 'POST',
    path: `${P}/inbound/sale`,
    access: 'public',
    csrf: 'exempt',
    description: 'HMAC-signed inbound sale (same body as POST /sales).',
    handler: async (ctx) => {
      const secret = process.env.FINANCE_INBOUND_SECRET;
      if (!secret) return fail('Inbound sales are not configured (FINANCE_INBOUND_SECRET).', 503, 'NOT_CONFIGURED');
      const raw = await ctx.request.text();
      const header = ctx.request.headers.get('x-finance-signature') ?? '';
      const parts = Object.fromEntries(header.split(',').map((p) => p.trim().split('=') as [string, string]));
      const t = Number(parts.t);
      if (!Number.isFinite(t) || Math.abs(Date.now() / 1000 - t) > 300) return fail('Signature timestamp missing or too old.', 401, 'BAD_SIGNATURE');
      const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.${raw}`).digest('hex');
      if (!safeEqual(String(parts.v1 ?? ''), expected)) {
        return fail('Bad signature.', 401, 'BAD_SIGNATURE');
      }
      let input: Record<string, unknown>;
      try { input = asObj(JSON.parse(raw)); } catch { return fail('Body is not JSON.'); }
      const fin = new Finance(ctx.store, depsFor(ctx));
      try {
        const res = await fin.inboundSale(input, `inbound:${String(input.source ?? 'unknown').slice(0, 40)}`);
        return json({ ...publicDoc(res.document), created: res.created }, res.created ? 201 : 200);
      } catch (e) {
        if (e instanceof FinanceError) return fail(e.message, e.status);
        throw e;
      }
    },
  });
  return routes;
}

/** Constant-time string compare that cannot throw on unequal byte lengths. */
function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb) && a === b;
}

function prevDay(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function period(url: URL, today: string): { from: string; to: string } {
  const from = url.searchParams.get('from') ?? `${today.slice(0, 4)}-01-01`;
  const to = url.searchParams.get('to') ?? today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) throw new FinanceError('Use ?from=YYYY-MM-DD&to=YYYY-MM-DD with from ≤ to.');
  return { from, to };
}

function cents(c: number): string {
  return (c / 100).toFixed(2).replace('.', ',');
}

/**
 * A spreadsheet cell that starts with = + - @ (or a tab / CR) is run as a
 * formula when the file is opened in Excel. Names come from uploaded
 * e-invoices, so they are untrusted: prefix those with an apostrophe.
 * Plain numbers ("-12,50") are left alone so amounts stay numeric.
 */
export function csvSafe(v: unknown): string {
  const s = String(v ?? '').replace(/[\r\n]+/g, ' ');
  if (/^-?\d+(?:[.,]\d+)?$/.test(s)) return s;
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

function row(cells: (string | undefined)[]): string {
  return cells.map((c) => `"${csvSafe(c).replace(/"/g, '""')}"`).join(';');
}

async function datevExport(fin: Finance, url: URL) {
  const { from, to } = period(url, fin.today());
  if (from.slice(0, 4) !== to.slice(0, 4)) throw new FinanceError('A DATEV export must stay inside one calendar year.');
  const company = await fin.company();
  const settings = await fin.settings();
  if (!company.datev_consultant_number || !company.datev_client_number) {
    throw new FinanceError('Set the DATEV Beraternummer and Mandantennummer in Settings → Company (ask your Steuerberater).');
  }
  const contacts = new Map<string, Contact>((await fin.listContacts()).map((c) => [c.id, c]));
  const bankAccounts = new Map<string, number>();
  for (const a of await fin.listBankAccounts()) if (a.ledger_account) bankAccounts.set(a.id, a.ledger_account);
  const tx = await fin.listBankTx(from.slice(0, 4));
  const { bookings, warnings } = datevBookings({ from, to }, { chart: company.chart, settings, contacts, bankAccounts },
    await fin.listDocuments(), await fin.listPayments(), await fin.listExpenses(), tx);
  const fyStart = `${from.slice(0, 4)}-${String(company.fiscal_year_start_month).padStart(2, '0')}-01`;
  const csv = buildBuchungsstapel({
    consultant: company.datev_consultant_number, client: company.datev_client_number,
    fiscalYearStart: fyStart <= from ? fyStart : `${Number(from.slice(0, 4)) - 1}${fyStart.slice(4)}`,
    accountLength: 4, from, to, label: `Finance ${from} bis ${to}`.slice(0, 30), chart: company.chart,
  }, bookings);
  await fin.log('export', 'export.datev', 'export', `${from}_${to}`, `${bookings.length} bookings`);
  return { csv, from, to, warnings };
}

