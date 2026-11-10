/**
 * The "Anfragen" inbox: requests and orders that arrive from outside — the
 * website's contact and quote forms, the cost calculator, orders and
 * requests placed in the customer portal.
 *
 * A request is not bookkeeping. It carries no number of ours and no tax
 * effect; it is a lead to answer. The outside system stays its owner: a
 * later delivery of the same `source` + `external_id` refreshes what that
 * system knows (its status, its items), and never touches what was decided
 * here (the inbox state, the note, the quote made from it).
 *
 * "→ Angebot" turns a request into a contact (found or created) and a quote
 * DRAFT with the requested items — priced where the request had prices,
 * at 0,00 where it was "on request" — to be checked and sent from the
 * normal quote screen.
 */
import crypto from 'node:crypto';
import type { FinanceDocument, TaxTreatment } from './types';
import { COL, singleFlight, type Finance } from './service';
import { FinanceError, asObj, str, treatment as readTreatment } from './normalize';

export const REQUEST_KINDS = ['order', 'request', 'inquiry', 'contact', 'quote', 'estimate'] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];
export const REQUEST_STATES = ['new', 'in_progress', 'quoted', 'done', 'dismissed'] as const;
export type RequestState = (typeof REQUEST_STATES)[number];

export interface RequestItem {
  name: string;
  quantity: number;
  /** Net unit price; null = "on request". */
  unit_net_cents: number | null;
  billing: 'one_off' | 'monthly' | 'yearly';
  price_is_from?: boolean;
}

export interface InboxRequest {
  id: string;
  source: string;
  external_id: string;
  kind: RequestKind;
  /** The outside system's own number (EC-2026-00012), if it has one. */
  number?: string;
  /** The outside system's status (submitted, paid, cancelled…), shown as is. */
  external_status?: string;
  subject?: string;
  message?: string;
  customer: {
    name?: string; company_name?: string; email?: string; phone?: string; vat_id?: string;
    address?: { street?: string; zip?: string; city?: string; country?: string };
    external_id?: string;
  };
  items: RequestItem[];
  currency: string;
  net_cents?: number;
  tax_cents?: number;
  gross_cents?: number;
  tax_rate?: number;
  tax_treatment?: TaxTreatment;
  /** Where to open it in the outside system (its admin), https only. */
  link?: string;
  /** The page it was sent from. */
  page?: string;
  extra?: Record<string, string>;
  external_created_at?: string;
  received_at: string;
  updated_at: string;
  /** Ours. */
  state: RequestState;
  note?: string;
  contact_id?: string;
  quote_id?: string;
}

const httpsUrl = (v: unknown) => {
  const s = str(v, 500);
  return s && /^https:\/\/[^\s"'<>]+$/.test(s) ? s : undefined;
};
const centsOrNull = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null);

function requestId(ref: string): string {
  return `req_${crypto.createHash('sha256').update(ref).digest('base64url').slice(0, 22)}`;
}

/** What the outside system knows about a request, from its delivery. */
function external(i: Record<string, unknown>): Omit<InboxRequest, 'id' | 'source' | 'external_id' | 'received_at' | 'updated_at' | 'state'> {
  const kind = (REQUEST_KINDS as readonly string[]).includes(String(i.kind)) ? (i.kind as RequestKind) : 'request';
  const c = asObj(i.customer);
  const a = asObj(c.address);
  const rawItems = Array.isArray(i.items) ? i.items : [];
  if (rawItems.length > 100) throw new FinanceError('A request can have at most 100 items.');
  const items: RequestItem[] = rawItems.map((raw, n) => {
    const it = asObj(raw);
    const name = str(it.name, 300);
    if (!name) throw new FinanceError(`Item ${n + 1} needs a name.`);
    const q = Number(it.quantity ?? 1);
    return {
      name,
      quantity: Number.isFinite(q) && q > 0 ? Math.round(q * 1000) / 1000 : 1,
      unit_net_cents: centsOrNull(it.unit_net_cents),
      billing: it.billing === 'monthly' || it.billing === 'yearly' ? it.billing : 'one_off',
      price_is_from: it.price_is_from === true ? true : undefined,
    };
  });
  const extra = asObj(i.extra);
  const rate = Number(i.tax_rate);
  return {
    kind,
    number: str(i.number, 40),
    external_status: str(i.status, 40),
    subject: str(i.subject, 300),
    message: str(i.message, 8000),
    customer: {
      name: str(c.name, 200), company_name: str(c.company_name, 200), email: str(c.email, 254)?.toLowerCase(),
      phone: str(c.phone, 60), vat_id: str(c.vat_id, 30),
      address: a && Object.keys(a).length ? {
        street: str(a.street, 200), zip: str(a.zip ?? a.postal_code, 20), city: str(a.city, 100),
        country: str(a.country, 2)?.toUpperCase(),
      } : undefined,
      external_id: str(c.external_id, 120),
    },
    items,
    currency: (str(i.currency, 3) ?? 'EUR').toUpperCase(),
    net_cents: centsOrNull(i.net_cents) ?? undefined,
    tax_cents: centsOrNull(i.tax_cents) ?? undefined,
    gross_cents: centsOrNull(i.gross_cents) ?? undefined,
    tax_rate: Number.isFinite(rate) ? rate : undefined,
    tax_treatment: readTreatment(i.tax_treatment),
    link: httpsUrl(i.link),
    page: str(i.page, 300),
    extra: Object.keys(extra).length
      ? Object.fromEntries(Object.entries(extra).slice(0, 20).map(([k, v]) => [k.slice(0, 40), String(v ?? '').slice(0, 300)]))
      : undefined,
    external_created_at: str(i.created_at, 40),
  };
}

/**
 * Create or refresh a request. Idempotent on source + external_id; the
 * inbox state, the note and the quote made from it are never overwritten.
 */
export async function upsertRequest(fin: Finance, input: unknown, actor: string): Promise<{ request: InboxRequest; created: boolean }> {
  const i = asObj(input);
  const source = str(i.source, 40);
  const externalId = str(i.external_id, 120);
  if (!source || !externalId) throw new FinanceError('"source" and "external_id" are required for idempotency.');
  const rid = requestId(`${source}:${externalId}`);
  const data = external(i);
  if (!data.customer.email && !data.customer.name && !data.customer.company_name) {
    throw new FinanceError('A request needs the customer\'s name or email.');
  }
  return singleFlight(`request:${rid}`, async () => {
    const before = await fin.store.get<InboxRequest>(COL.requests, rid);
    const now = fin.stamp();
    const next: InboxRequest = before
      ? { ...before, ...data, id: rid, source, external_id: externalId, updated_at: now }
      : { ...data, id: rid, source, external_id: externalId, received_at: now, updated_at: now, state: 'new' };
    await fin.store.put(COL.requests, rid, next as unknown as Record<string, unknown>);
    if (!before) await fin.log(actor, 'request.receive', 'request', rid, `${next.kind} ${next.number ?? externalId} from ${source}`);
    return { request: next, created: !before };
  });
}

export async function listRequests(fin: Finance, filter: { state?: string; q?: string } = {}): Promise<InboxRequest[]> {
  const q = (filter.q ?? '').trim().toLowerCase();
  return (await fin.store.list<InboxRequest>(COL.requests, { uncapped: true })).map((r) => r.data)
    .filter((r) => !filter.state || filter.state === 'all' || (filter.state === 'open' ? r.state === 'new' || r.state === 'in_progress' : r.state === filter.state))
    .filter((r) => !q || [r.number, r.subject, r.message, r.customer.name, r.customer.company_name, r.customer.email].some((v) => v?.toLowerCase().includes(q)))
    .sort((a, b) => (b.external_created_at ?? b.received_at).localeCompare(a.external_created_at ?? a.received_at));
}

export async function getRequest(fin: Finance, rid: string): Promise<InboxRequest> {
  const r = await fin.store.get<InboxRequest>(COL.requests, rid);
  if (!r) throw new FinanceError('Request not found.', 404);
  return r;
}

/** Ours to change: the inbox state and the note. */
export async function updateRequest(fin: Finance, rid: string, input: unknown, actor: string): Promise<InboxRequest> {
  const i = asObj(input);
  return singleFlight(`request:${rid}`, async () => {
    const r = await getRequest(fin, rid);
    const state = i.state === undefined ? r.state : (REQUEST_STATES as readonly string[]).includes(String(i.state)) ? (i.state as RequestState) : undefined;
    if (!state) throw new FinanceError(`state must be one of ${REQUEST_STATES.join(', ')}.`);
    const next: InboxRequest = { ...r, state, note: 'note' in i ? str(i.note, 4000) : r.note, updated_at: fin.stamp() };
    await fin.store.put(COL.requests, rid, next as unknown as Record<string, unknown>);
    if (state !== r.state) await fin.log(actor, 'request.state', 'request', rid, `${r.state} → ${state}`);
    return next;
  });
}

/**
 * A quote draft from a request: the customer as a contact (found by their
 * outside id, VAT id or email, else created) and the requested items as
 * lines. Once made, asking again returns the same quote.
 */
export async function requestToQuote(fin: Finance, rid: string, actor: string): Promise<{ request: InboxRequest; quote: FinanceDocument; created: boolean }> {
  return singleFlight(`request-quote:${rid}`, async () => {
    const r = await getRequest(fin, rid);
    if (r.quote_id) {
      const existing = await fin.store.get<FinanceDocument>(COL.documents, r.quote_id);
      if (existing) return { request: r, quote: existing, created: false };
    }
    const c = r.customer;
    const contact = await fin.upsertContact({
      kind: c.company_name ? 'company' : 'person',
      company_name: c.company_name, last_name: c.company_name ? undefined : (c.name ?? c.email),
      email: c.email, phone: c.phone, vat_id: c.vat_id,
      billing_address: c.address ? { ...c.address, country: c.address.country ?? 'DE' } : { country: 'DE' },
    }, r.source, c.external_id, actor);
    const rate = r.tax_treatment && r.tax_treatment !== 'domestic' ? 0 : 19;
    const per = { monthly: ' (monatlich)', yearly: ' (jährlich)', one_off: '' } as const;
    const lines = r.items.length
      ? r.items.map((it) => ({
        name: `${it.name}${per[it.billing]}`,
        description: it.unit_net_cents === null ? 'Preis auf Anfrage — bitte eintragen.' : it.price_is_from ? 'Ab-Preis — bitte prüfen.' : undefined,
        quantity: it.quantity, unit: it.billing === 'monthly' ? 'MON' : it.billing === 'yearly' ? 'ANN' : 'C62',
        unit_price_cents: it.unit_net_cents ?? 0, tax_rate: rate,
      }))
      : [{ name: r.subject ?? 'Leistung laut Anfrage', description: 'Bitte Leistung und Preis eintragen.', quantity: 1, unit_price_cents: 0, tax_rate: rate }];
    const quote = await fin.createDocument({
      type: 'quote', contact_id: contact.id, price_mode: 'net', lines,
      ...(r.tax_treatment ? { tax_treatment: r.tax_treatment } : {}),
      reference: r.number, title: r.subject ? `Angebot: ${r.subject}`.slice(0, 200) : undefined,
    }, actor, { source: r.source });
    const next: InboxRequest = { ...(await getRequest(fin, rid)), contact_id: contact.id, quote_id: quote.id, state: 'quoted', updated_at: fin.stamp() };
    await fin.store.put(COL.requests, rid, next as unknown as Record<string, unknown>);
    await fin.log(actor, 'request.quote', 'request', rid, `→ quote draft ${quote.id}`);
    return { request: next, quote, created: true };
  });
}
