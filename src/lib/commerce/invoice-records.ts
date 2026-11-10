/**
 * Invoice and credit-memo RECORDS — the write path, and the issuer seam.
 *
 * The rules (what a record holds, how a refund becomes a memo) are pure and
 * live in `invoice-records-rules.ts`. This module decides WHEN, and makes every
 * decision safe to take twice at once.
 *
 * ## Every write is a compare-and-set
 *
 * Creating a record, finalising one, adding a credit memo and claiming one for
 * an issuer are all read-decide-write: "there is no record yet, so make one".
 * A payment webhook and an admin click, or two clicks, decide that together.
 * So each write goes through `LocalDB.compareAndSetOrderInvoiceRecords`, which
 * lands only if the stored records are still the ones the decision was made
 * on (the same primitive order tags use). The loser re-reads, finds the
 * winner's record, and decides again from it — which for "finalise" means
 * "already final, nothing to do". Two concurrent finalisations make one final
 * record on every driver; `tests/invoice-records.test.mjs` forces the
 * interleaving on all three.
 *
 * ## The issuer is claimed before it is called
 *
 * An issuer reports to a tax authority. Calling it twice for one record is
 * double reporting, which is the risk the plan names. So a record is first
 * marked `issuing` by a compare-and-set, and only the request whose claim
 * landed calls the issuer; its answer is written only over its own claim. A
 * record marked `issued_externally` (the shop's POS already issued it) is never
 * claimed at all.
 *
 * ## Never in the way of a sale or a refund
 *
 * Records follow events that have already happened — a payment, a shipment, a
 * refund. `syncInvoiceRecordsSafely` is what those paths call, and it cannot
 * throw: a record that failed to write is logged and made on the next event or
 * by hand, while the payment or refund it follows stands. Nothing here ever
 * validates `tax_id` or refuses an order over it (owner decision, see
 * `Address.tax_id`); an issuer that rejects one says so on the record.
 */
import { LocalDB } from '../localdb';
import { pluginManager, PLUGIN_HOOKS } from '../plugin-system';
import { settingsMap } from '../settings-map';
import { formatAddressOneLine } from './address';
import { isErased } from './order-lookup';
import {
  INTERNAL_REFERENCE_SEQUENCE,
  activeInvoice,
  canCreateInvoice,
  supersededInvoiceIds,
  buildCreditMemo,
  buildInvoiceRecord,
  buyerOf,
  formatInternalReference,
  invoiceDocumentsOf,
  invoicesOf,
  isIssuerId,
  issueKeyOf,
  issueRetryDue,
  ISSUE_STALE_MS,
  memosOf,
  nextIssueAttemptAt,
  nextDocumentId,
  orderIdOfDocument,
  resolveInvoiceSettings,
  sellerOf,
  triggerReached,
  type InvoiceSettings,
} from './invoice-records-rules';
import type {
  CreditMemoRecord, InvoiceDocument, InvoiceIssuerState, InvoiceRecord, Order, RefundRecord,
} from '../../core/models';

/* ---------------------------------------------------------- the issuer -- */

/**
 * What an issuer answers. Exactly one of three:
 *
 *  - `{ ok: true, number?, identifiers? }` — issued;
 *  - `{ ok: false, error, retryable? }` — it tried and failed. `retryable:
 *    true` says a later call under the same key may succeed (the provider was
 *    down, a rate limit); the background sweep then retries with backoff;
 *  - `{ ok: false, declined: true, reason }` — "not mine": this issuer does
 *    not issue this record (a consumer sale while its retail switch is off, a
 *    country it does not serve). Nothing was sent anywhere. The next issuer in
 *    line is asked; when none is left the record is treated exactly as with
 *    no issuer — no "issue failed", and the internal reference applies.
 */
export type InvoiceIssueResult =
  | {
      ok: true;
      /** The LEGAL document number. Printed as the document number. */
      number?: string;
      /** Anything else to keep — ΜΑΡΚ, UID, a QR URL. String values only. */
      identifiers?: Record<string, string>;
    }
  | {
      ok: false;
      /** Shown to staff on the record, e.g. "ΑΦΜ 123 is not valid". */
      error: string;
      /**
       * A later call under the same key may succeed. Only say so when the
       * call is safe to repeat — `issue()` is idempotent on `ctx.key`.
       */
      retryable?: boolean;
    }
  | {
      ok: false;
      /** "Not mine" — this issuer does not issue this record. NOT a failure. */
      declined: true;
      /** Shown to staff beside the record, e.g. "retail is switched off". */
      reason: string;
    };

/** What core answers an issuer's late success with. */
export type LateIssueOutcome =
  | { ok: true; accepted: boolean; state: InvoiceIssuerState }
  | InvoiceFailure;

export interface InvoiceIssueContext {
  /** A copy of the order the record belongs to. */
  order: Order;
  /** For a credit memo: the invoice record it credits. */
  invoice?: InvoiceRecord;
  /**
   * Every setting, read by core and handed in (a copy) — the issuer's own
   * switches included, so it needs no cache of them.
   */
  settings: Record<string, unknown>;
  /**
   * The idempotency key: `astrobaas:<record id>`, the same on every attempt
   * at this record (a retry, the sweep, after a timeout). Send it to the
   * provider as its idempotency key.
   */
  key: string;
  /** 1 on the first call to this issuer for this record, 2 on the first retry … */
  attempt: number;
  /**
   * Report a success that arrived after core stopped waiting (a timeout).
   * Accepted only while the record is still unissued and still this issuer's
   * under this key — a compare-and-set, so it never overwrites a record that
   * was issued, issued elsewhere or handed to another issuer meanwhile. Never
   * throws. Usable for as long as this process runs; after a restart, the
   * sweep's retry under the same key collects the document instead.
   */
  reportLateSuccess(result: { number?: string; identifiers?: Record<string, string> }): Promise<LateIssueOutcome>;
}

/**
 * An issuer plugin: the myDATA provider pack, a Peppol pack, a ΦΗΜ bridge.
 * Registered through `PLUGIN_HOOKS.INVOICE_ISSUERS`.
 *
 * `issue()` MUST be idempotent on `ctx.key`. Core calls it once per record,
 * but a retry (by a person, or the background sweep after a retryable failure
 * or a timeout) sends the same key again, and the issuer is the only party
 * that can know whether the first call reached the authority.
 */
export interface InvoiceIssuer {
  /** Lower-case letters, digits and `-`, at most 40. Stored on every record. */
  id: string;
  label: string;
  issue(doc: InvoiceDocument, ctx: InvoiceIssueContext): Promise<InvoiceIssueResult>;
}

/** What the `INVOICE_ISSUERS` filter is handed as its second argument. */
export interface InvoiceIssuersFilterContext {
  /** Every setting, read by the call site (a copy). */
  settings: Record<string, unknown>;
}

/** How long an issuer may take before the attempt is recorded as failed (retryable). */
export const ISSUE_TIMEOUT_MS = 30_000;
export { ISSUE_STALE_MS, MAX_AUTO_ISSUE_ATTEMPTS } from './invoice-records-rules';

/**
 * The issuers active plugins register, malformed ones dropped and the first of
 * two with one id kept. Asked at each use, so activating or deactivating a
 * plugin — or flipping its own switch in settings — takes effect without a
 * restart. The filter is synchronous, so the settings are read by the caller
 * and handed in, as `TAX_ID_VERDICT` and `SEARCH_EXPAND` are.
 */
export function registeredInvoiceIssuers(settings: Record<string, unknown>): InvoiceIssuer[] {
  let raw: unknown;
  try {
    const ctx: InvoiceIssuersFilterContext = { settings: { ...settings } };
    raw = pluginManager.applyFilters(PLUGIN_HOOKS.INVOICE_ISSUERS, [], ctx);
  } catch (err) {
    console.error('[invoices] an INVOICE_ISSUERS filter threw; treating it as no issuer:', err);
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: InvoiceIssuer[] = [];
  for (const i of raw) {
    if (!i || typeof i !== 'object' || !isIssuerId((i as any).id) || typeof (i as any).issue !== 'function') {
      console.error('[invoices] a plugin offered an invalid invoice issuer; ignoring it');
      continue;
    }
    if (out.some((o) => o.id === (i as any).id)) {
      console.error(`[invoices] two plugins registered the invoice issuer "${(i as any).id}"; keeping the first`);
      continue;
    }
    out.push({ id: (i as any).id, label: String((i as any).label ?? (i as any).id), issue: (i as any).issue.bind(i) });
  }
  return out;
}

export type IssuerChain =
  | { kind: 'none' }
  /** The issuers to ask, in order. A decline passes the record to the next. */
  | { kind: 'chain'; issuers: InvoiceIssuer[] }
  /** An issuer should be used and none can be: said on the record. */
  | { kind: 'problem'; message: string };

/**
 * WHO is asked to issue an invoice record, and in what order — the precedence:
 *
 *  1. No issuer active: none (the internal reference applies).
 *  2. One active and no choice made: that one.
 *  3. More than one active and no choice made: no issuer is called, and the
 *     record says the shop must name one under Settings → Invoices
 *     (`invoice_issuer`). Which pack reports a sale is never left to plugin
 *     load order.
 *  4. With a choice: the chosen issuer FIRST, then every other active issuer
 *     in hook order (filter priority, then registration). The next one is
 *     asked only when the one before it DECLINED ("not mine"). A failure or a
 *     timeout is never passed on: it may have reached the authority, so the
 *     record stays with that issuer, and its retry goes to it alone.
 *  5. A chosen issuer that is not active: no issuer is called, and the record
 *     says so — the shop chose it deliberately.
 *
 * A record still has ONE issuer: the first that does not decline owns it.
 * Credit memos do not use this order: a credit goes to the issuer that issued
 * its sale (see `issueWith`).
 */
export function issuerChain(settings: InvoiceSettings, issuers: readonly InvoiceIssuer[]): IssuerChain {
  if (settings.issuerId) {
    const chosen = issuers.find((i) => i.id === settings.issuerId);
    return chosen
      ? { kind: 'chain', issuers: [chosen, ...issuers.filter((i) => i !== chosen)] }
      : { kind: 'problem', message: `The invoice issuer "${settings.issuerId}" chosen under Settings → Invoices is not active` };
  }
  if (issuers.length === 0) return { kind: 'none' };
  if (issuers.length === 1) return { kind: 'chain', issuers: [issuers[0]] };
  return { kind: 'problem', message: 'More than one invoice issuer is active; choose one under Settings → Invoices' };
}

export type IssuerChoice =
  | { kind: 'none' }
  | { kind: 'issuer'; issuer: InvoiceIssuer }
  | { kind: 'problem'; message: string };

/** The issuer asked FIRST — the head of `issuerChain` — for the screens that name one. */
export function chooseIssuer(settings: InvoiceSettings, issuers: readonly InvoiceIssuer[]): IssuerChoice {
  const c = issuerChain(settings, issuers);
  return c.kind === 'chain' ? { kind: 'issuer', issuer: c.issuers[0] } : c;
}

/* ------------------------------------------------------- the write loop -- */

export type InvoiceFailure =
  | { ok: false; code: 'not_found'; message: string }
  | { ok: false; code: 'conflict'; message: string }
  /** Every attempt lost a race; nothing was written. Safe to retry. */
  | { ok: false; code: 'busy'; message: string };

export type InvoiceResult<T> =
  | {
      ok: true; changed: boolean; order: Order; records: InvoiceDocument[]; value: T;
      /** The records the decision was taken on — what this write replaced. */
      before: InvoiceDocument[];
    }
  | InvoiceFailure;

type Decision<T> =
  | { write: InvoiceDocument[]; value: T }
  | { keep: true; value: T }
  | InvoiceFailure;

/** Each lost round means somebody else's write landed; ten is far past real contention. */
const MAX_ATTEMPTS = 10;

const notFound = (what = 'Order'): InvoiceFailure => ({ ok: false, code: 'not_found', message: `${what} not found` });
const conflict = (message: string): InvoiceFailure => ({ ok: false, code: 'conflict', message });

/**
 * Read, decide, write only if nobody wrote in between — and if somebody did,
 * decide again from what they wrote. The decision is re-made from the fresh
 * records on every attempt; that is what makes a second "finalise" find the
 * first one's record instead of writing its own.
 */
async function change<T>(orderId: string, decide: (order: Order, docs: InvoiceDocument[]) => Decision<T>): Promise<InvoiceResult<T>> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const order = await LocalDB.getOrder(orderId);
    if (!order) return notFound();
    const stored = (order as { invoice_records?: unknown }).invoice_records;
    const docs = invoiceDocumentsOf(order);
    const d = decide(order, docs);
    if ('ok' in d) return d;
    if ('keep' in d) return { ok: true, changed: false, order, records: docs, value: d.value, before: docs };
    const written = await LocalDB.compareAndSetOrderInvoiceRecords(orderId, stored, d.write);
    if (written.outcome === 'applied') {
      return {
        ok: true, changed: true, order: written.order, records: invoiceDocumentsOf(written.order), value: d.value, before: docs,
      };
    }
    if (written.outcome === 'missing') return notFound();
    // 'changed': go round again from a fresh read.
  }
  return { ok: false, code: 'busy', message: 'The order\'s records were being changed at the same time; try again' };
}

async function readSettings(): Promise<Record<string, unknown>> {
  return settingsMap((await LocalDB.getSettings()) as { key: string; value: unknown }[]);
}

const nowIso = () => new Date().toISOString();

/**
 * The id a refund made AT THE PROVIDER is credited under. The ledger never
 * hears of such a refund (the provider's webhook only moves the payment status
 * to `refunded`), so it is the part of the total the ledger does not cover.
 */
export const PROVIDER_REFUND_ID = 'provider-refund';

/**
 * The refunds a credit memo must follow: the ledger's, plus — once the
 * provider says the payment is refunded — whatever the ledger does not cover,
 * which can only have been refunded at the provider.
 */
function refundsOf(order: Order): RefundRecord[] {
  const ledger = (Array.isArray(order.refunds) ? order.refunds : [])
    .filter((r) => r && typeof r.id === 'string' && Number.isInteger(r.amount_cents) && r.amount_cents > 0);
  const covered = ledger.reduce((s, r) => s + r.amount_cents, 0);
  const total = Math.round(Number(order.total_cents) || 0);
  if (order.payment_status === 'refunded' && covered < total) {
    ledger.push({ id: PROVIDER_REFUND_ID, amount_cents: total - covered, at: order.updated_at, actor: 'provider' });
  }
  return ledger;
}

/**
 * An invoice record that a staff correction credited away ("credit in full"),
 * to be replaced by a corrected one. A refund credited against it has to be
 * credited again against the replacement, or the books would show the refund
 * as never having happened.
 */
const supersededIds = supersededInvoiceIds;

/**
 * Add a credit memo for every refund in the ledger that has none against a
 * live record. Mutates `next` (a working copy) and returns what it added.
 */
function addMissingMemos(order: Order, next: InvoiceDocument[], now: string): CreditMemoRecord[] {
  const added: CreditMemoRecord[] = [];
  for (const refund of refundsOf(order)) {
    const gone = supersededIds(next);
    const covered = memosOf(next).some((m) => m.refund_id === refund.id && !gone.has(m.invoice_record_id));
    if (covered) continue;
    const inv = activeInvoice(next);
    // No final record to credit (none yet, or only a draft): the memo is made
    // when one is finalised, by the sync that follows it.
    if (!inv || inv.status !== 'final') break;
    const memo = buildCreditMemo({
      id: nextDocumentId(order.id, next, 'credit_memo'),
      invoice: inv, docs: next, amount_cents: refund.amount_cents, refund_id: refund.id, now,
    });
    if (!memo) break;
    next.push(memo);
    added.push(memo);
  }
  return added;
}

/* ------------------------------------------------------- after "final" -- */

/**
 * What happens once a record is final: an issuer issues it, or — with none, or
 * when every issuer declined it — the shop's own internal reference is
 * attached, when it switched one on. Errors are logged, never thrown: the
 * record exists, and the admin shows what is missing and offers the retry.
 */
async function afterFinal(orderId: string, docId: string, map: Record<string, unknown>): Promise<void> {
  try {
    const settings = resolveInvoiceSettings(map);
    const chain = issuerChain(settings, registeredInvoiceIssuers(map));
    if (chain.kind === 'none') {
      // Local and fast: done in line.
      if (settings.referenceFormat) await assignInternalReference(orderId, docId, settings.referenceFormat);
      return;
    }
    await issueWith(orderId, docId, map, 'first');
  } catch (err) {
    console.error(`[invoices] after finalising ${docId}:`, err);
  }
}

/** Issuer calls running in the background (see afterFinal). */
const inFlight = new Set<Promise<void>>();
function track(p: Promise<void>): void {
  inFlight.add(p);
  void p.finally(() => inFlight.delete(p));
}

/**
 * Resolves once every background issuer call has finished. For tests, and for
 * a graceful shutdown that wants an issue in progress to land.
 */
export async function whenInvoiceIssuesSettled(): Promise<void> {
  while (inFlight.size) await Promise.all([...inFlight]);
}

/**
 * Attach the next internal reference to a record that has none. The number is
 * taken once, and only by the request that reaches here — the one whose
 * finalisation landed — so a race costs no number.
 *
 * A record every issuer DECLINED counts as one with no issuer: that is what
 * "not mine" means, and the shop's own bookkeeping still needs its number.
 */
async function assignInternalReference(orderId: string, docId: string, format: string): Promise<string | null> {
  const wants = (d: InvoiceDocument | undefined) =>
    !!d && d.status === 'final' && !d.internal_reference && !d.issued_externally
    && (!d.issuer || d.issuer.status === 'declined');
  const order = await LocalDB.getOrder(orderId);
  if (!wants(invoiceDocumentsOf(order).find((d) => d.id === docId))) return null;
  const n = await LocalDB.nextSequence(INTERNAL_REFERENCE_SEQUENCE);
  const r = await change<string | null>(orderId, (_order, docs) => {
    const doc = docs.find((d) => d.id === docId);
    if (!doc) return notFound('Record');
    if (!wants(doc)) return { keep: true, value: doc.internal_reference ?? null };
    const ref = formatInternalReference(format, n, doc.finalised_at ?? nowIso());
    return { write: replaceDoc(docs, { ...doc, internal_reference: ref } as InvoiceDocument), value: ref };
  });
  return r.ok ? r.value : null;
}

const replaceDoc = (docs: InvoiceDocument[], doc: InvoiceDocument): InvoiceDocument[] =>
  docs.map((d) => (d.id === doc.id ? doc : d));

/** Clip an issuer's identifiers to what a record may hold. */
function cleanIdentifiers(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const ids: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>).slice(0, 20)) {
    if (/^[A-Za-z0-9_.-]{1,40}$/.test(k) && typeof v === 'string') ids[k] = v.slice(0, 2000);
  }
  return Object.keys(ids).length ? ids : undefined;
}

/** Clip an issuer's answer to what a record may hold. */
function cleanIssueResult(r: unknown): InvoiceIssueResult {
  if (!r || typeof r !== 'object') return { ok: false, error: 'The issuer gave no answer' };
  const x = r as Record<string, unknown>;
  if (x.ok !== true) {
    if (x.declined === true) {
      // `error` too, so an issuer written for both contracts can say it once.
      const why = [x.reason, x.error].find((v) => typeof v === 'string' && v.trim()) as string | undefined;
      return { ok: false, declined: true, reason: (why?.trim() || 'The issuer does not issue this record').slice(0, 500) };
    }
    const e = typeof x.error === 'string' && x.error.trim() ? x.error.trim() : 'The issuer refused the record';
    return { ok: false, error: e.slice(0, 500), ...(x.retryable === true ? { retryable: true } : {}) };
  }
  const out: { ok: true; number?: string; identifiers?: Record<string, string> } = { ok: true };
  if (typeof x.number === 'string' && x.number.trim()) out.number = x.number.trim().slice(0, 100);
  const ids = cleanIdentifiers(x.identifiers);
  if (ids) out.identifiers = ids;
  return out;
}

export type IssueOutcome =
  | { ok: true; state: InvoiceIssuerState | null; called: boolean }
  | InvoiceFailure;

/**
 * Why an issue is being attempted, which decides what may be (re)tried:
 *
 *  - `first`:  the record was just finalised. Only a record no issuer has
 *              touched is sent.
 *  - `manual`: a person pressed "Issue again". A failure, a decline, or a
 *              stale claim may be retried.
 *  - `sweep`:  the background sweep. Only what `issueRetryDue` says is due.
 */
type IssueMode = 'first' | 'manual' | 'sweep';

/** An `issuing` claim nobody is answering any more (the process died mid-call). */
function staleClaim(s: InvoiceIssuerState | undefined, nowMs: number): boolean {
  return !!s && s.status === 'issuing' && nowMs - Date.parse(s.attempted_at) > ISSUE_STALE_MS;
}

/**
 * Is the record ALREADY an issuer's? Once an issuer has been called for it and
 * did not decline — it failed (retryably or not), or its claim went stale —
 * the record is that issuer's: every retry goes to it alone, under the same
 * key, because only it can say whether an earlier call reached the authority.
 * Sending it to another issuer could report the sale twice. A failure is
 * never passed down the chain, and a change of `invoice_issuer` does not move
 * it either; a person who knows better marks it issued elsewhere.
 */
function pinnedOwner(s: InvoiceIssuerState | undefined, nowMs: number): boolean {
  if (!s || !s.id) return false;
  if (s.status === 'failed') return true;
  return staleClaim(s, nowMs);
}

/** The fields of a state that describe one ROUND of asking, dropped when a new round starts. */
function freshState(base: Pick<InvoiceIssuerState, 'id' | 'attempted_at'> & Partial<InvoiceIssuerState>): InvoiceIssuerState {
  const out: InvoiceIssuerState = { id: base.id, status: base.status ?? 'issuing', attempted_at: base.attempted_at };
  for (const k of ['key', 'attempts', 'declined', 'number', 'identifiers', 'issued_at', 'error', 'retryable', 'next_attempt_at', 'late'] as const) {
    if (base[k] !== undefined) (out as any)[k] = base[k];
  }
  return out;
}

/**
 * Claim a record, ask its issuer(s), store the answer.
 *
 *  1. THE CLAIM. A compare-and-set marks the record `issuing` for the first
 *     issuer to ask. Only the request whose claim lands calls anybody.
 *  2. THE CALLS, by that request only, outside every checkout, refund and
 *     webhook request (the automatic path runs after the response; see
 *     `afterWrite`). A decline moves the claim to the next issuer in
 *     `issuerChain` — again by compare-and-set over our own claim — and asks
 *     it. Anything else ends the round.
 *  3. THE ANSWER, written only over our own claim (same issuer, same
 *     `attempted_at`). A late success, or a person, may have moved the record
 *     on meanwhile; then our answer is dropped.
 *
 * Every declined round ends as with no issuer at all: the internal reference
 * is attached when the shop switched one on.
 */
async function issueWith(
  orderId: string, docId: string, map: Record<string, unknown>, mode: IssueMode, nowMs: number = Date.now(),
): Promise<IssueOutcome> {
  const settings = resolveInvoiceSettings(map);
  const active = registeredInvoiceIssuers(map);
  const key = issueKeyOf(docId);
  const attemptedAt = new Date(nowMs).toISOString();

  // 1. The claim. `queue` is who to ask after the first, should it decline.
  let queue: InvoiceIssuer[] = [];
  const claim = await change<InvoiceIssuerState | null>(orderId, (_order, docs) => {
    queue = [];
    const doc = docs.find((d) => d.id === docId);
    if (!doc) return notFound('Record');
    if (doc.status !== 'final') return conflict('Only a final record is issued');
    if (doc.issued_externally) return conflict('This record was issued elsewhere; it is never sent to an issuer');
    const s = doc.issuer;
    if (s?.status === 'issued') return { keep: true, value: s };
    if (mode === 'sweep' && !issueRetryDue(doc, nowMs)) return { keep: true, value: s ?? null };
    if (mode === 'first' && s) return { keep: true, value: s };
    if (s?.status === 'issuing' && !staleClaim(s, nowMs)) return { keep: true, value: s };

    let chain: InvoiceIssuer[] = [];
    let problem: string | null = null;
    let declinedByCore: string | null = null;
    if (pinnedOwner(s, nowMs)) {
      // Pinned: only the issuer that may already have it.
      const owner = active.find((i) => i.id === s!.id);
      if (!owner) {
        if (mode === 'sweep') return { keep: true, value: s! };
        return conflict(`The issuer "${s!.id}" may already have issued this record (an earlier call to it failed or did not finish) `
          + 'and is not active. Activate it and try again, or mark the record issued elsewhere.');
      }
      chain = [owner];
    } else if (doc.kind === 'credit_memo') {
      // A credit is reported where its sale was. The invoice's issuer, and no
      // other: the authority must not receive a credit for a sale it never heard of.
      const inv = invoicesOf(docs).find((i) => i.id === doc.invoice_record_id);
      if (inv?.issuer?.status === 'issued') {
        const owner = active.find((i) => i.id === inv.issuer!.id);
        if (owner) chain = [owner];
        else problem = `The issuer "${inv.issuer.id}" that issued its invoice record is not active, so this credit is not sent. `
          + 'Activate it, or issue the credit where the sale was issued and mark it issued elsewhere.';
      } else if (inv?.issuer?.status === 'declined') {
        // Its sale was nobody's here, so its credit is nobody's either.
        declinedByCore = 'Its invoice record was declined by every issuer, so no issuer here reports this credit';
      } else {
        problem = 'Its invoice record was not issued through this issuer, so this credit is not sent to it. '
          + 'Issue the credit where the sale was issued, then mark it issued elsewhere.';
      }
    } else {
      const c = issuerChain(settings, active);
      if (c.kind === 'none') return conflict('No invoice issuer is active');
      if (c.kind === 'problem') problem = c.message;
      else chain = c.issuers;
    }

    let state: InvoiceIssuerState;
    if (declinedByCore !== null) {
      state = { id: '', status: 'declined', attempted_at: attemptedAt, declined: [{ id: '', reason: declinedByCore }] };
    } else if (problem !== null) {
      state = { id: '', status: 'failed', error: problem, attempted_at: attemptedAt };
    } else {
      const first = chain[0];
      const prior = s && s.id === first.id ? (s.attempts ?? 1) : 0;
      state = freshState({ id: first.id, status: 'issuing', attempted_at: attemptedAt, key, attempts: prior + 1 });
      queue = chain.slice(1);
    }
    return { write: replaceDoc(docs, { ...doc, issuer: state }), value: state };
  });
  if (!claim.ok) return claim;
  if (!claim.changed || claim.value?.status !== 'issuing') {
    if (claim.changed && claim.value?.status === 'declined' && settings.referenceFormat) {
      await assignInternalReference(orderId, docId, settings.referenceFormat);
    }
    return { ok: true, state: claim.value, called: false };
  }

  // 2. The calls — by the one request that holds the claim.
  let held: InvoiceIssuerState = claim.value;
  let records = claim.records;
  let order = claim.order;
  const declined: { id: string; reason: string }[] = [];
  let issuer = active.find((i) => i.id === held.id)!;
  for (;;) {
    const doc = records.find((d) => d.id === docId)!;
    const invoice = doc.kind === 'credit_memo' ? invoicesOf(records).find((i) => i.id === doc.invoice_record_id) : undefined;
    const answer = await callIssuer(issuer, doc, {
      order, ...(invoice ? { invoice } : {}), settings: map, key, attempt: held.attempts ?? 1,
    });

    if (!answer.ok && 'declined' in answer && doc.kind === 'credit_memo') {
      // The issuer of the SALE declining its credit is not harmless: the
      // authority would hold the sale and never the credit. Shown as a
      // failure, so a person deals with it.
      const state = freshState({
        id: issuer.id, status: 'failed', attempted_at: held.attempted_at, key, attempts: held.attempts ?? 1,
        error: `The issuer of its sale declined this credit: ${answer.reason}`,
      });
      const r = await writeOverClaim(orderId, docId, held, state);
      if (!r.ok) return r;
      return { ok: true, state: r.state, called: true };
    }
    if (!answer.ok && 'declined' in answer) {
      declined.push({ id: issuer.id, reason: answer.reason });
      const next = queue.shift();
      if (next) {
        // Hand the claim to the next issuer, over our own claim only.
        const moved = freshState({ id: next.id, status: 'issuing', attempted_at: new Date().toISOString(), key, attempts: 1, declined: [...declined] });
        const r = await writeOverClaim(orderId, docId, held, moved);
        if (!r.ok) return r;
        if (!r.mine) return { ok: true, state: r.state, called: true };
        held = moved;
        records = r.records;
        order = r.order;
        issuer = next;
        continue;
      }
      // Nobody's: exactly as with no issuer.
      const none: InvoiceIssuerState = { id: '', status: 'declined', attempted_at: held.attempted_at, key, declined: [...declined] };
      const r = await writeOverClaim(orderId, docId, held, none);
      if (!r.ok) return r;
      if (r.mine && settings.referenceFormat) await assignInternalReference(orderId, docId, settings.referenceFormat);
      return { ok: true, state: r.state, called: true };
    }

    // 3. The answer, written only over our own claim.
    const attempts = held.attempts ?? 1;
    const keep = { key, attempts, ...(declined.length ? { declined: [...declined] } : {}) };
    let state: InvoiceIssuerState;
    if (answer.ok) {
      state = freshState({
        id: issuer.id, status: 'issued', attempted_at: held.attempted_at, issued_at: nowIso(), ...keep,
        ...(answer.number ? { number: answer.number } : {}),
        ...(answer.identifiers ? { identifiers: answer.identifiers } : {}),
      });
    } else {
      const retryable = (answer as { retryable?: boolean }).retryable === true;
      const next = retryable ? nextIssueAttemptAt(attempts, nowMs) : null;
      state = freshState({
        id: issuer.id, status: 'failed', attempted_at: held.attempted_at, error: (answer as { error: string }).error, ...keep,
        ...(retryable ? { retryable: true as const } : {}),
        ...(next ? { next_attempt_at: next } : {}),
      });
    }
    const r = await writeOverClaim(orderId, docId, held, state);
    if (!r.ok) {
      console.error(`[invoices] could not store what issuer ${issuer.id} answered for ${docId}: ${r.message}`, answer);
      return r;
    }
    return { ok: true, state: r.state, called: true };
  }
}

/**
 * Call one issuer, bounded by ISSUE_TIMEOUT_MS. Never throws.
 *
 * A timeout is a RETRYABLE failure: the outcome is unknown, the issuer is
 * idempotent on the key, so asking again under it is exactly how to find out —
 * and if the answer lands later, `ctx.reportLateSuccess` records it at once.
 * A throw is a plain failure: an issuer that knows a call may be repeated says
 * so with `retryable: true`.
 */
async function callIssuer(
  issuer: InvoiceIssuer, doc: InvoiceDocument,
  base: { order: Order; invoice?: InvoiceRecord; settings: Record<string, unknown>; key: string; attempt: number },
): Promise<InvoiceIssueResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ctx: InvoiceIssueContext = {
    order: structuredClone(base.order),
    ...(base.invoice ? { invoice: structuredClone(base.invoice) } : {}),
    settings: { ...base.settings },
    key: base.key,
    attempt: base.attempt,
    reportLateSuccess: async (result) => {
      try {
        return await reportLateInvoiceIssue(doc.id, { issuer: issuer.id, key: base.key, ...(result ?? {}) });
      } catch (err) {
        return { ok: false, code: 'conflict', message: err instanceof Error ? err.message : String(err) };
      }
    },
  };
  try {
    const call = issuer.issue(structuredClone(doc), ctx);
    const timeout = new Promise<InvoiceIssueResult>((resolve) => {
      timer = setTimeout(() => resolve({
        ok: false, retryable: true,
        error: `The issuer did not answer within ${ISSUE_TIMEOUT_MS / 1000} s; it is asked again under the same key`,
      }), ISSUE_TIMEOUT_MS);
    });
    return cleanIssueResult(await Promise.race([call, timeout]));
  } catch (err) {
    // A throw says nothing about whether the request reached the authority
    // (a socket reset after the POST, say), so it is treated as unknown:
    // retried, under the same key, by this issuer alone.
    return { ok: false, retryable: true, error: (err instanceof Error ? err.message : String(err)).slice(0, 500) || 'The issuer failed' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Replace `held` (our claim) with `next` — only while the record still carries
 * exactly our claim. `mine: false` means somebody moved it on first (a late
 * success, a person); their state stands and is returned.
 */
async function writeOverClaim(
  orderId: string, docId: string, held: InvoiceIssuerState, next: InvoiceIssuerState,
): Promise<{ ok: true; mine: boolean; state: InvoiceIssuerState | null; records: InvoiceDocument[]; order: Order } | InvoiceFailure> {
  const r = await change<{ mine: boolean; state: InvoiceIssuerState | null }>(orderId, (_order, docs) => {
    const d = docs.find((x) => x.id === docId);
    if (!d) return notFound('Record');
    const s = d.issuer;
    if (s?.status !== 'issuing' || s.attempted_at !== held.attempted_at || s.id !== held.id) {
      return { keep: true, value: { mine: false, state: s ?? null } };
    }
    return { write: replaceDoc(docs, { ...d, issuer: next }), value: { mine: true, state: next } };
  });
  if (!r.ok) return r;
  return { ok: true, mine: r.value.mine, state: r.value.state, records: r.records, order: r.order };
}

/**
 * An issuer's success that arrived after core stopped waiting — a timeout, a
 * provider that answered on its own schedule.
 *
 * Accepted only while the record is still UNISSUED and still the reporting
 * issuer's under the same key: `failed` (the timeout core recorded) or
 * `issuing` (a retry under way) with `issuer.id` and `issuer.key` matching.
 * A compare-and-set, on every driver: it never overwrites a record that was
 * issued, marked issued elsewhere, declined, or handed to another issuer
 * meanwhile. Reporting the same success twice is answered `accepted: false`.
 *
 * Plugins reach this through `ctx.reportLateSuccess`, which binds the record,
 * the issuer and the key; nothing outside the issuer can call it.
 */
export async function reportLateInvoiceIssue(
  recordId: string,
  report: { issuer: string; key: string; number?: unknown; identifiers?: unknown },
): Promise<LateIssueOutcome> {
  const orderId = orderIdOfDocument(recordId);
  if (!orderId) return notFound('Record');
  const number = typeof report.number === 'string' && report.number.trim() ? report.number.trim().slice(0, 100) : undefined;
  const identifiers = cleanIdentifiers(report.identifiers);
  const r = await change<{ accepted: boolean; state: InvoiceIssuerState }>(orderId, (_order, docs) => {
    const doc = docs.find((d) => d.id === recordId);
    if (!doc) return notFound('Record');
    if (doc.status !== 'final') return conflict('Only a final record is issued');
    if (doc.issued_externally) return conflict('This record was issued elsewhere; a late success from an issuer is not recorded on it');
    const s = doc.issuer;
    const heldKey = s?.key ?? issueKeyOf(doc.id);
    if (!s || !s.id || s.id !== report.issuer || heldKey !== report.key) {
      return conflict('This record is not held by that issuer under that key');
    }
    if (s.status === 'issued') return { keep: true, value: { accepted: false, state: s } };
    if (s.status !== 'failed' && s.status !== 'issuing') return conflict('This record is not waiting for that issuer');
    const state = freshState({
      id: s.id, status: 'issued', attempted_at: s.attempted_at, issued_at: nowIso(), key: heldKey, late: true,
      ...(s.attempts ? { attempts: s.attempts } : {}),
      ...(s.declined?.length ? { declined: s.declined } : {}),
      ...(number ? { number } : {}),
      ...(identifiers ? { identifiers } : {}),
    });
    return { write: replaceDoc(docs, { ...doc, issuer: state }), value: { accepted: true, state } };
  });
  if (!r.ok) return r;
  return { ok: true, accepted: r.value.accepted, state: r.value.state };
}

/* ------------------------------------------------------------ the verbs -- */

/**
 * Bring an order's records up to date with what has happened to it:
 *
 *  - no invoice record yet, and the moment the shop chose has come (paid,
 *    shipped — `invoice_record_on`) → a FINAL record, frozen now;
 *  - a refund in the ledger with no credit memo → one, against the record.
 *
 * Idempotent: running it twice, or twice at once, changes nothing the second
 * time. An order a person has handled by hand (a draft, a cancelled record) is
 * never given a second record automatically.
 */
export async function syncInvoiceRecords(
  orderId: string, opts: { deferIssue?: boolean } = {},
): Promise<InvoiceResult<string[]>> {
  const map = await readSettings();
  const settings = resolveInvoiceSettings(map);
  const seller = sellerOf(map);
  const r = await change<string[]>(orderId, (order, docs) => {
    if (isErased(order)) return { keep: true, value: [] };
    const next = [...docs];
    const now = nowIso();
    const added: string[] = [];
    if (invoicesOf(next).length === 0 && triggerReached(order, settings.recordOn)) {
      const record = buildInvoiceRecord({
        id: nextDocumentId(order.id, next, 'invoice'), order, seller,
        buyer: buyerOf(order, (a) => formatAddressOneLine(a)),
        trigger: settings.recordOn, status: 'final', now,
      });
      next.push(record);
      added.push(record.id);
    }
    for (const m of addMissingMemos(order, next, now)) added.push(m.id);
    return added.length ? { write: next, value: added } : { keep: true, value: [] };
  });
  if (r.ok && r.changed) await afterWrite(orderId, r, map, opts.deferIssue === true);
  return r;
}

/**
 * What the payment, refund, shipping and status paths call. Never throws and
 * never fails the caller: the event it follows has happened either way.
 */
export async function syncInvoiceRecordsSafely(orderId: string): Promise<void> {
  try {
    const r = await syncInvoiceRecords(orderId, { deferIssue: true });
    if (!r.ok && r.code !== 'not_found') console.error(`[invoices] records for order ${orderId} not updated: ${r.message}`);
  } catch (err) {
    console.error(`[invoices] records for order ${orderId} not updated:`, err);
  }
}

/**
 * Create a record by hand: a draft, or straight to final.
 *
 * While the order has a live record (a draft, or a final one not fully
 * credited) this creates nothing and answers with that record — so a second
 * click, or a second request at the same moment, is the first one's answer.
 * A corrected record is made after the old one is credited in full.
 */
export async function createInvoiceRecord(orderId: string, opts: { finalise: boolean }): Promise<InvoiceResult<{ record: InvoiceRecord; created: boolean }>> {
  const map = await readSettings();
  const seller = sellerOf(map);
  const r = await change<{ record: InvoiceRecord; created: boolean }>(orderId, (order, docs) => {
    if (isErased(order)) return conflict('This order was erased at the customer\'s request; no new record is made');
    const live = activeInvoice(docs);
    if (live) {
      if (opts.finalise && live.status === 'draft') return finaliseDecision(order, docs, live, seller);
      return { keep: true, value: { record: live, created: false } };
    }
    // Credited by its REFUNDS is not "corrected": the sale and its refund are
    // both on the books, and a new record would invoice money that went back.
    if (!canCreateInvoice(docs)) {
      return conflict('This order\'s record has been credited by its refunds; there is nothing left to invoice');
    }
    const now = nowIso();
    const record = buildInvoiceRecord({
      id: nextDocumentId(order.id, docs, 'invoice'), order, seller,
      buyer: buyerOf(order, (a) => formatAddressOneLine(a)),
      trigger: 'manual', status: opts.finalise ? 'final' : 'draft', now,
    });
    const next = [...docs, record];
    if (record.status === 'final') addMissingMemos(order, next, now);
    return { write: next, value: { record, created: true } };
  });
  if (r.ok && r.changed) await afterWrite(orderId, r, map);
  return r;
}

/** The decision that turns a draft into a final record, re-frozen from the order NOW. */
function finaliseDecision(
  order: Order, docs: InvoiceDocument[], draft: InvoiceRecord, seller: InvoiceRecord['seller'],
): Decision<{ record: InvoiceRecord; created: boolean }> {
  const now = nowIso();
  const rebuilt = buildInvoiceRecord({
    id: draft.id, order, seller, buyer: buyerOf(order, (a) => formatAddressOneLine(a)),
    trigger: draft.trigger, status: 'final', now,
  });
  const record: InvoiceRecord = {
    ...rebuilt,
    created_at: draft.created_at,
    // A mark a person made on the draft survives finalising it.
    ...(draft.issued_externally ? { issued_externally: draft.issued_externally } : {}),
  };
  const next = replaceDoc(docs, record);
  addMissingMemos(order, next, now);
  return { write: next, value: { record, created: false } };
}

/**
 * Every record THIS write made final gets its issuer or internal reference —
 * and only those: a record finalised before an issuer was installed is not
 * reported because somebody later clicked something else on the order.
 */
async function afterWrite(
  orderId: string, r: { records: InvoiceDocument[]; before: InvoiceDocument[] }, map: Record<string, unknown>, defer = false,
): Promise<void> {
  const ids = r.records
    .filter((d) => d.status === 'final' && r.before.find((b) => b.id === d.id)?.status !== 'final')
    .map((d) => d.id);
  if (!ids.length) return;
  // In order — an invoice before the memos that credit it, because a memo is
  // issued only once its invoice was.
  const run = (async () => { for (const id of ids) await afterFinal(orderId, id, map); })();
  // An issuer is somebody else's server, and may take its 30 s. A payment
  // webhook, a buyer's return from checkout, a refund or a status change must
  // not wait on it: the record is already written, and the issue follows.
  if (defer) track(run);
  else await run;
}

/** Finalise a draft. Finalising a final record is a no-op success. */
export async function finaliseInvoiceRecord(orderId: string, recordId: string): Promise<InvoiceResult<{ record: InvoiceRecord; created: boolean }>> {
  const map = await readSettings();
  const seller = sellerOf(map);
  const r = await change<{ record: InvoiceRecord; created: boolean }>(orderId, (order, docs) => {
    const doc = invoicesOf(docs).find((d) => d.id === recordId);
    if (!doc) return notFound('Record');
    if (doc.status === 'final') return { keep: true, value: { record: doc, created: false } };
    if (doc.status === 'cancelled') return conflict('A cancelled record cannot be finalised; create a new one');
    if (isErased(order)) return conflict('This order was erased at the customer\'s request; the draft cannot be finalised');
    return finaliseDecision(order, docs, doc, seller);
  });
  if (r.ok && r.changed) await afterWrite(orderId, r, map);
  return r;
}

/** Cancel a DRAFT. A final record is corrected by a credit memo, never cancelled. */
export async function cancelInvoiceRecord(orderId: string, recordId: string): Promise<InvoiceResult<InvoiceRecord>> {
  return change<InvoiceRecord>(orderId, (_order, docs) => {
    const doc = invoicesOf(docs).find((d) => d.id === recordId);
    if (!doc) return notFound('Record');
    if (doc.status === 'cancelled') return { keep: true, value: doc };
    if (doc.status === 'final') return conflict('A final record is never edited or cancelled; credit it in full, then create a corrected one');
    const record: InvoiceRecord = { ...doc, status: 'cancelled', cancelled_at: nowIso() };
    return { write: replaceDoc(docs, record), value: record };
  });
}

/**
 * Record that a record was issued OUTSIDE AstroBaaS — on the shop's POS, by
 * its accountant — so no issuer is ever called for it. Refused once an issuer
 * has it (issuing or issued): that is the double report this mark exists to
 * prevent, the other way round.
 */
export async function markIssuedExternally(
  orderId: string, recordId: string, actor: string, number?: string,
): Promise<InvoiceResult<InvoiceDocument>> {
  const clean = typeof number === 'string' ? number.trim().slice(0, 100) : '';
  return change<InvoiceDocument>(orderId, (_order, docs) => {
    const doc = docs.find((d) => d.id === recordId);
    if (!doc) return notFound('Record');
    if (doc.status === 'cancelled') return conflict('The record is cancelled');
    if (doc.issued_externally) return { keep: true, value: doc };
    // A claim gone stale (the process died mid-call) may be marked: a person
    // who has checked with the provider is the only way out when its issuer
    // is gone.
    if (doc.issuer?.status === 'issued' || (doc.issuer?.status === 'issuing' && !staleClaim(doc.issuer, Date.now()))) {
      return conflict('An issuer has this record already; marking it issued elsewhere would report it twice');
    }
    const next = { ...doc, issued_externally: { at: nowIso(), actor, ...(clean ? { number: clean } : {}) } } as InvoiceDocument;
    return { write: replaceDoc(docs, next), value: next };
  });
}

/**
 * A staff correction: credit a final record in full (what its refunds have
 * not already credited), so a corrected record can be created. No money moves
 * — a refund is what the refund button is for.
 */
export async function creditInvoiceInFull(orderId: string, recordId: string): Promise<InvoiceResult<CreditMemoRecord>> {
  const map = await readSettings();
  const r = await change<CreditMemoRecord>(orderId, (order, docs) => {
    const inv = invoicesOf(docs).find((d) => d.id === recordId);
    if (!inv) return notFound('Record');
    if (inv.status !== 'final') return conflict('Only a final record is credited');
    if (supersededIds(docs).has(inv.id)) {
      const memo = memosOf(docs).find((m) => m.invoice_record_id === inv.id && !m.refund_id)!;
      return { keep: true, value: memo };
    }
    const memo = buildCreditMemo({
      id: nextDocumentId(order.id, docs, 'credit_memo'), invoice: inv, docs, amount_cents: inv.total_cents, now: nowIso(),
    });
    if (!memo) return conflict('Its refunds have already credited this record in full');
    return { write: [...docs, memo], value: memo };
  });
  if (r.ok && r.changed) await afterWrite(orderId, r, map);
  return r;
}

/**
 * Send a record to the issuer by hand: after a failure, or after an `issuing`
 * claim went stale (a crash mid-call). A record already issued, or issued
 * elsewhere, is never sent again.
 */
export async function issueInvoiceDocument(orderId: string, recordId: string): Promise<IssueOutcome> {
  const map = await readSettings();
  if (registeredInvoiceIssuers(map).length === 0) return conflict('No invoice issuer is active');
  return issueWith(orderId, recordId, map, 'manual');
}

/** How many records one sweep retries at most; the rest are the next tick's. */
export const ISSUE_RETRY_BATCH = 10;
/** How far back the sweep looks, by order creation date. */
export const ISSUE_RETRY_WINDOW_MS = 60 * 24 * 60 * 60_000;

/**
 * The background retry of issues whose outcome is unknown, run by the
 * scheduler (src/lib/scheduler.ts) on its own tick — never inside a checkout,
 * refund or webhook request.
 *
 * It retries what `issueRetryDue` says is due: a failure the issuer marked
 * `retryable` (or a timeout) once its `next_attempt_at` has come, and an
 * `issuing` claim gone stale after a crash. Each retry goes to the SAME issuer
 * under the SAME key (`ctx.key`), through the same compare-and-set claim as
 * every other issue, so:
 *
 *  - two sweeps (or a sweep and a person pressing "Issue again") at once call
 *    the issuer once — the second finds the first's claim;
 *  - a record issued, marked issued elsewhere or declined meanwhile is left
 *    alone, because the claim re-checks `issueRetryDue` on the fresh record;
 *  - the issuer, idempotent on the key, answers a retry of a document it
 *    already issued with that document.
 *
 * Backoff doubles from 2 minutes to at most 6 hours; after
 * MAX_AUTO_ISSUE_ATTEMPTS calls the record stays failed until a person acts.
 * At most ISSUE_RETRY_BATCH records per tick, called together, so one tick
 * waits at most one issuer timeout. Orders created within the last 60 days
 * are looked at; an older record is retried by hand.
 */
export async function sweepInvoiceIssueRetries(nowMs: number = Date.now()): Promise<{ retried: number; issued: number }> {
  const map = await readSettings();
  const activeIds = new Set(registeredInvoiceIssuers(map).map((i) => i.id));
  if (activeIds.size === 0) return { retried: 0, issued: 0 };
  const orders = await LocalDB.getRecentOrders({ since: new Date(nowMs - ISSUE_RETRY_WINDOW_MS).toISOString(), atMost: 20_000 });
  const due: [string, string][] = [];
  for (const order of orders) {
    for (const d of invoiceDocumentsOf(order)) {
      // Only records whose issuer is active: one that is switched off cannot
      // be retried, and must not hold a batch slot every tick.
      if (issueRetryDue(d, nowMs) && activeIds.has(d.issuer!.id)) due.push([order.id, d.id]);
    }
  }
  // Oldest order first, so a backlog drains in the order it built up.
  const batch = due.reverse().slice(0, ISSUE_RETRY_BATCH);
  const results = await Promise.all(batch.map(([o, d]) => issueWith(o, d, map, 'sweep', nowMs).catch((err) => {
    console.error(`[invoices] retrying ${d}:`, err);
    return null;
  })));
  const retried = results.filter((r) => r && r.ok && r.called).length;
  const issued = results.filter((r) => r && r.ok && r.called && r.state?.status === 'issued').length;
  if (retried) console.log(`[astrobaas] retried ${retried} invoice issue(s); ${issued} issued`);
  return { retried, issued };
}

/** What the orders screen says once, above every order's records. */
export async function invoiceAdminContext(): Promise<{ issuer: string | null; problem: string | null }> {
  const map = await readSettings();
  const chain = issuerChain(resolveInvoiceSettings(map), registeredInvoiceIssuers(map));
  return {
    // "A → B": B is asked when A declines.
    issuer: chain.kind === 'chain' ? chain.issuers.map((i) => i.label).join(' → ') : null,
    problem: chain.kind === 'problem' ? chain.message : null,
  };
}

/** Find a record by its id, which names its order. */
export async function findInvoiceDocument(recordId: string): Promise<{ order: Order; doc: InvoiceDocument; docs: InvoiceDocument[] } | null> {
  const orderId = orderIdOfDocument(recordId);
  if (!orderId) return null;
  const order = await LocalDB.getOrder(orderId);
  if (!order) return null;
  const docs = invoiceDocumentsOf(order);
  const doc = docs.find((d) => d.id === recordId);
  return doc ? { order, doc, docs } : null;
}
