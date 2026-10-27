/**
 * Order timeline — one chronological answer to "what happened to this order?".
 *
 * ## Derived where it can be, stored only where it must be
 *
 * An order already records a lot about itself: when it was placed, when it was
 * posted (and with what), each refund with its amount and actor, each tax
 * override, when it was abandoned, when a payment was declined. Copying those
 * into a second list would create a second answer that can disagree with the
 * first, and every order placed before the list existed would have an empty
 * one. So those are DERIVED, every time the timeline is read, from the fields
 * that own them (`derivedItems`).
 *
 * What no field records is stored, on the order, in `Order.timeline`:
 *
 *   status.changed       who moved it from what to what (there is no status
 *                        history anywhere else; the audit log is capped on the
 *                        document drivers and not indexed by order)
 *   payment.captured / payment.failed / payment.refunded
 *                        a provider's verdict, with when (the order keeps only
 *                        the resulting `payment_status`)
 *   note.staff_updated / note.staff_cleared / note.customer_edited
 *   note.comment         a staff comment added to the timeline
 *   tags.changed         what was added and removed
 *   shipment.shipped / shipment.tracking_updated   with the staff member
 *   bulk.<action>        any later bulk action (see `recordOrderEvent`)
 *
 * ## Staff only
 *
 * Like tags and `staff_note`, nothing a buyer can reach reads this. The order
 * endpoints strip `timeline` (`withoutTimeline`); the one reader is
 * `GET /api/orders/{id}/timeline`. `tests/order-timeline.test.mjs` scans the
 * source for importers so a new reader has to be added on purpose.
 *
 * ## Appends are atomic
 *
 * An append is read-modify-write, so it goes through
 * `LocalDB.compareAndSetOrderTimeline` and is decided again when it loses a
 * race — the pattern `order-tags.ts` uses. Two writers appending at once both
 * land, on all three drivers.
 *
 * ## Free text, and erasure
 *
 * `text`, `added` and `removed` are things a person typed and may name a
 * customer. They are rendered as text everywhere, and `scrubOrderTimeline`
 * (called by an erasure) clears exactly those three fields, keeping the fact
 * that a note was written, by whom and when.
 *
 * ## Bounded
 *
 * At most `ORDER_TIMELINE_MAX_STORED` stored entries per order; the oldest go
 * first. Derived items are never dropped, so "placed" and every refund are
 * always there.
 */
import { LocalDB } from '../localdb';
import type { Order, OrderTimelineEntry } from '../../core/models';

/** Stored entries kept per order. */
export const ORDER_TIMELINE_MAX_STORED = 100;
/** Characters in one note, comment or reason. */
export const ORDER_TIMELINE_TEXT_MAX = 1000;
/** Tags listed on one tag entry (an order has at most 10 anyway). */
const MAX_TAGS_PER_ENTRY = 10;
const TAG_MAX = 80;
const REF_MAX = 120;

export const TIMELINE_FILTERS = ['status', 'payments', 'shipments', 'notes', 'other'] as const;
export type TimelineFilter = (typeof TIMELINE_FILTERS)[number];

/** Every event code this module itself writes or derives. Bulk actions add `bulk.*`. */
export const TIMELINE_EVENTS = [
  // derived
  'order.placed', 'order.abandoned', 'order.hold_expired',
  'payment.started', 'payment.declined', 'payment.needs_refund',
  'refund.issued', 'tax.override', 'email.recovery_sent',
  'consent.terms_accepted', 'consent.privacy_accepted',
  // stored
  'status.changed',
  'payment.captured', 'payment.failed', 'payment.refunded',
  'note.staff_updated', 'note.staff_cleared', 'note.customer_edited', 'note.comment',
  'tags.changed',
  'shipment.shipped', 'shipment.tracking_updated',
] as const;

/** Which dropdown entry an event belongs to. One rule, used by every reader. */
export function timelineCategory(event: string): TimelineFilter {
  if (event.startsWith('status.') || event.startsWith('order.')) return 'status';
  if (event.startsWith('payment.') || event.startsWith('refund.')) return 'payments';
  if (event.startsWith('shipment.')) return 'shipments';
  if (event.startsWith('note.')) return 'notes';
  return 'other';
}

export function parseTimelineFilter(raw: unknown): TimelineFilter | null | 'invalid' {
  if (raw === null || raw === undefined || raw === '' || raw === 'all') return null;
  return typeof raw === 'string' && (TIMELINE_FILTERS as readonly string[]).includes(raw) ? (raw as TimelineFilter) : 'invalid';
}

/* ---------------------------------------------------------------- shape -- */

const EVENT_CODE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+){0,3}$/;
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** Free text → what is stored: no control, format or bidi characters (newlines kept), bounded. */
export function cleanTimelineText(raw: unknown, max = ORDER_TIMELINE_TEXT_MAX): string | null {
  if (typeof raw !== 'string') return null;
  const lines = raw.normalize('NFC').replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(HIDDEN, ''));
  const text = lines.join('\n').trim();
  return [...text].length > max ? [...text].slice(0, max).join('') : text;
}

function isoOrNull(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function cleanTagList(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  for (const t of raw) {
    const c = cleanTimelineText(t, TAG_MAX);
    if (c) out.push(c);
    if (out.length >= MAX_TAGS_PER_ENTRY) break;
  }
  return out;
}

export interface NewTimelineEntry {
  /** A dotted code, e.g. `bulk.status`. Lower case, at most four segments. */
  event: string;
  /** A user id, `provider` or `system[:job]`. Never a display name. */
  actor: string;
  /** Defaults to now. Must be an ISO instant when given. */
  at?: string;
  from?: string;
  to?: string;
  amount_cents?: number;
  text?: string;
  added?: string[];
  removed?: string[];
  ref?: string;
}

/**
 * One value → a stored entry, or null. Used when WRITING (so a caller cannot
 * store a shape the reader would drop) and when READING (so a row written by a
 * hand edit or an older build never puts junk on a screen).
 */
export function normalizeTimelineEntry(raw: unknown, now = new Date()): (OrderTimelineEntry) | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.event !== 'string' || r.event.length > 48 || !EVENT_CODE.test(r.event)) return null;
  const at = r.at === undefined ? now.toISOString() : isoOrNull(r.at);
  if (!at) return null;
  const actor = typeof r.actor === 'string' && r.actor.trim() ? r.actor.trim().slice(0, 80) : 'system';
  const out: OrderTimelineEntry = {
    id: typeof r.id === 'string' && r.id && r.id.length <= 64 ? r.id : crypto.randomUUID(),
    at, event: r.event, actor,
  };
  for (const k of ['from', 'to'] as const) {
    const v = cleanTimelineText(r[k], 40);
    if (v) out[k] = v;
  }
  if (typeof r.amount_cents === 'number' && Number.isSafeInteger(r.amount_cents)) out.amount_cents = r.amount_cents;
  const text = cleanTimelineText(r.text);
  if (text) out.text = text;
  const ref = cleanTimelineText(r.ref, REF_MAX);
  if (ref) out.ref = ref;
  const added = cleanTagList(r.added);
  if (added?.length) out.added = added;
  const removed = cleanTagList(r.removed);
  if (removed?.length) out.removed = removed;
  return out;
}

/**
 * Keep at most `max`, evicting the entries a dispute needs LAST.
 *
 * Status moves and payment verdicts are the record of what happened to the
 * money and the goods; a note, a comment, a tag edit or a bulk-action line is
 * context. So when the list is full the OLDEST of the context entries go
 * first, and only when there are none does the oldest of everything.
 */
export function boundTimeline<T extends { event: string }>(list: readonly T[], max = ORDER_TIMELINE_MAX_STORED): T[] {
  const out = [...list];
  const precious = (e: T) => e.event.startsWith('status.') || e.event.startsWith('payment.');
  while (out.length > max) {
    const i = out.findIndex((e) => !precious(e));
    out.splice(i >= 0 ? i : 0, 1);
  }
  return out;
}

/** The stored entries of an order, defensively, oldest first (storage order). */
export function storedTimelineOf(order: { timeline?: unknown } | null | undefined): Array<OrderTimelineEntry> {
  const raw = order?.timeline;
  if (!Array.isArray(raw)) return [];
  const out: Array<OrderTimelineEntry> = [];
  for (const item of raw) {
    const e = normalizeTimelineEntry(item);
    if (e) out.push(e);
  }
  return boundTimeline(out);
}

/** An order without its stored timeline: what the order endpoints return. */
export function withoutTimeline<T extends { timeline?: unknown }>(order: T): Omit<T, 'timeline'> {
  if (!order || typeof order !== 'object' || !('timeline' in order)) return order;
  const { timeline: _drop, ...rest } = order;
  return rest;
}

/* ------------------------------------------------------------- reading -- */

export interface TimelineItem {
  id: string;
  at: string;
  event: string;
  category: TimelineFilter;
  /** The raw actor: a user id, `provider`, `system…`, `customer`, or null when the order does not record one. */
  actor: string | null;
  from?: string;
  to?: string;
  amount_cents?: number;
  currency?: string;
  text?: string;
  added?: string[];
  removed?: string[];
  ref?: string;
  count?: number;
  /** True when computed from the order's own fields rather than stored. */
  derived: boolean;
}

/** Everything the order's own fields say, as items. Pure. */
export function derivedItems(order: Order): TimelineItem[] {
  const items: TimelineItem[] = [];
  const cur = typeof order.currency === 'string' ? order.currency : undefined;
  const add = (id: string, at: unknown, event: string, extra: Partial<TimelineItem> = {}) => {
    const iso = isoOrNull(at);
    if (!iso) return;
    items.push({ id: `d:${id}`, at: iso, event, category: timelineCategory(event), actor: null, derived: true, ...extra });
  };

  add('placed', order.created_at, 'order.placed', {
    actor: 'customer',
    amount_cents: Number.isSafeInteger(order.total_cents) ? order.total_cents : undefined,
    currency: cur,
    ...(order.payment_method ? { text: order.payment_method } : {}),
  });
  add('terms', order.terms_accepted === true ? order.terms_accepted_at : null, 'consent.terms_accepted', { actor: 'customer' });
  add('privacy', order.privacy_accepted === true ? order.privacy_accepted_at : null, 'consent.privacy_accepted', { actor: 'customer' });
  add('pay-started', order.payment_started_at, 'payment.started', {
    ...(order.payment_provider ? { text: order.payment_provider } : {}),
  });
  add('declined', order.payment_declined_at, 'payment.declined', {
    actor: 'provider',
    ...(Number(order.payment_declines) > 0 ? { count: Number(order.payment_declines) } : {}),
  });
  add('abandoned', order.abandoned_at, 'order.abandoned', { actor: 'system' });
  add('hold-expired', order.hold_expired_at, 'order.hold_expired', { actor: 'system' });
  add('needs-refund', order.needs_refund_at, 'payment.needs_refund', { actor: 'system' });
  add('recovery', order.recovery_sent_at, 'email.recovery_sent', { actor: 'system' });

  (Array.isArray(order.refunds) ? order.refunds : []).forEach((r, i) => {
    if (!r || typeof r !== 'object') return;
    add(`refund-${r.id ?? i}`, r.at, 'refund.issued', {
      actor: typeof r.actor === 'string' ? r.actor : null,
      amount_cents: Number.isSafeInteger(r.amount_cents) ? r.amount_cents : undefined,
      currency: cur,
      ref: typeof r.id === 'string' ? r.id.slice(0, REF_MAX) : undefined,
    });
  });
  (Array.isArray(order.tax_overrides) ? order.tax_overrides : []).forEach((o, i) => {
    if (!o || typeof o !== 'object') return;
    add(`tax-${i}`, o.at, 'tax.override', {
      actor: typeof o.actor === 'string' ? o.actor : null,
      ...(typeof o.reason === 'string' && o.reason ? { text: cleanTimelineText(o.reason) ?? undefined } : {}),
    });
  });
  return items;
}

/**
 * The whole timeline, newest first.
 *
 * Ties (two events in one millisecond) keep a fixed order — stored entries by
 * the order they were appended, newest append first — so a re-render never
 * shuffles them.
 */
export function buildOrderTimeline(order: Order): TimelineItem[] {
  const stored = storedTimelineOf(order);
  const cur = typeof order.currency === 'string' ? order.currency : undefined;
  const items: TimelineItem[] = [];
  const hasStored = (event: string) => stored.some((e) => e.event === event);

  stored.forEach((e) => {
    const isMoney = e.amount_cents !== undefined;
    items.push({
      id: e.id, at: e.at, event: e.event, category: timelineCategory(e.event), actor: e.actor,
      ...(e.from !== undefined ? { from: e.from } : {}),
      ...(e.to !== undefined ? { to: e.to } : {}),
      ...(isMoney ? { amount_cents: e.amount_cents, currency: cur } : {}),
      ...(e.text !== undefined ? { text: e.text } : {}),
      ...(e.added ? { added: e.added } : {}),
      ...(e.removed ? { removed: e.removed } : {}),
      ...(e.ref !== undefined ? { ref: e.ref } : {}),
      derived: false,
    });
  });
  for (const d of derivedItems(order)) items.push(d);

  // An order posted before shipments were recorded here: its own fields still
  // say when, and with what. Once a stored shipment event exists it is the
  // better answer (it knows who), so the derived one steps aside.
  if (!hasStored('shipment.shipped')) {
    const at = isoOrNull(order.shipped_at);
    if (at) {
      items.push({
        id: 'd:shipped', at, event: 'shipment.shipped', category: 'shipments', actor: null, derived: true,
        ...(order.tracking_number ? { ref: String(order.tracking_number).slice(0, REF_MAX) } : {}),
        ...(order.tracking_carrier ? { text: String(order.tracking_carrier).slice(0, 80) } : {}),
      });
    }
  }

  const rank = new Map(items.map((it, i) => [it, i] as const));
  items.sort((a, b) => {
    const t = b.at.localeCompare(a.at);
    if (t !== 0) return t;
    // Stored before derived is arbitrary but stable; within stored, newest append first.
    return (rank.get(b) ?? 0) - (rank.get(a) ?? 0);
  });
  return items;
}

export function filterTimeline(items: readonly TimelineItem[], filter: TimelineFilter | null): TimelineItem[] {
  return filter ? items.filter((i) => i.category === filter) : [...items];
}

export type ActorKind = 'staff' | 'system' | 'provider' | 'customer' | 'unknown';

/** Who an actor string is, and the name to show. Users are matched by id. */
export function describeActor(
  actor: string | null, users: ReadonlyMap<string, { name?: string; email?: string }>,
): { kind: ActorKind; name: string | null } {
  if (!actor) return { kind: 'unknown', name: null };
  if (actor === 'provider') return { kind: 'provider', name: null };
  if (actor === 'customer') return { kind: 'customer', name: null };
  if (actor === 'system' || actor.startsWith('system:')) return { kind: 'system', name: null };
  const u = users.get(actor);
  if (u) return { kind: 'staff', name: (u.name || u.email || actor) as string };
  // A user id that no longer resolves (account removed): still staff, and the
  // id is all there is. API keys record `apikey:<id>`.
  return { kind: 'staff', name: actor };
}

/* -------------------------------------------------------------- writing -- */

const MAX_ATTEMPTS = 10;

export type TimelineWriteResult =
  | { ok: true; entries: Array<OrderTimelineEntry> }
  | { ok: false; code: 'not_found' }
  | { ok: false; code: 'invalid'; message: string }
  /** Every attempt lost a race; nothing was written. Safe to retry. */
  | { ok: false; code: 'busy'; message: string };

/**
 * Append entries to an order's stored timeline, atomically.
 *
 * The list is re-read and the append re-decided every time a concurrent write
 * wins, so two requests appending at once both land. Fails as a whole — and
 * writes nothing — when an entry is not valid.
 *
 * This is THE seam for later features (bulk order actions): call it, or the
 * never-throwing `recordOrderEvent`, with an event code of the form
 * `bulk.<action>`; do not write `Order.timeline` any other way.
 */
export async function appendOrderTimeline(orderId: string, raw: readonly NewTimelineEntry[]): Promise<TimelineWriteResult> {
  const now = new Date();
  const built: Array<OrderTimelineEntry> = [];
  for (const r of raw) {
    // A new entry is never given an id by its caller: ids are ours.
    const e = normalizeTimelineEntry({ ...r, id: undefined }, now);
    if (!e) return { ok: false, code: 'invalid', message: 'Not a valid timeline entry' };
    built.push(e);
  }
  if (built.length === 0) return { ok: false, code: 'invalid', message: 'Nothing to record' };

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const order = await LocalDB.getOrder(orderId);
    if (!order) return { ok: false, code: 'not_found' };
    const stored = (order as { timeline?: unknown }).timeline;
    const current = storedTimelineOf(order);
    const next = [...current, ...built];
    const bounded = boundTimeline(next);
    const written = await LocalDB.compareAndSetOrderTimeline(orderId, stored, bounded);
    if (written.outcome === 'applied') return { ok: true, entries: built };
    if (written.outcome === 'missing') return { ok: false, code: 'not_found' };
    // 'changed': go round again with a fresh read.
  }
  return { ok: false, code: 'busy', message: 'The order was being edited at the same time; try again' };
}

/**
 * `appendOrderTimeline` for a caller that is doing something else and must not
 * fail because the history could not be written (a status change, a payment
 * webhook). Never throws; a failure is logged, once, with the order id and the
 * event code and nothing a person typed.
 */
export async function recordOrderEvent(orderId: string, entry: NewTimelineEntry): Promise<boolean> {
  // A few more rounds, with a small jittered pause, when a burst of writers
  // exhausted the inner retry loop or the store threw: a payment verdict is
  // recorded once (its idempotency claim is consumed) and is never offered
  // again, so one transient miss would otherwise lose it for good.
  const EXTRA_ROUNDS = 3;
  let last = 'unknown';
  for (let round = 0; round <= EXTRA_ROUNDS; round++) {
    try {
      const r = await appendOrderTimeline(orderId, [entry]);
      if (r.ok) return true;
      if (r.code === 'not_found' || r.code === 'invalid') { last = r.code; break; }
      last = r.code;
    } catch (err) {
      last = err instanceof Error ? err.message.slice(0, 120) : 'error';
    }
    if (round < EXTRA_ROUNDS) await new Promise((res) => setTimeout(res, 20 + Math.random() * 80 * (round + 1)));
  }
  if (last !== 'not_found') {
    // Findable: the order id and the event code, nothing a person typed.
    console.error(`[order-timeline] LOST ${entry.event} on order ${orderId} (${last}); the order itself is correct, only its timeline misses this line`);
  }
  return false;
}

/** The stored entries with every free-text field removed. Pure. */
export function scrubbedTimeline(timeline: unknown): OrderTimelineEntry[] {
  return storedTimelineOf({ timeline }).map((e) => {
    const { text: _t, added: _a, removed: _r, ...rest } = e;
    return rest;
  });
}

/**
 * Clear the free text from an order's stored timeline (a data-subject
 * erasure). Decided from a fresh read and written with the same
 * compare-and-set as an append, so an entry appended while the erasure runs is
 * scrubbed too rather than lost. Returns true when nothing is left to clear.
 */
export async function scrubOrderTimeline(orderId: string): Promise<boolean> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const order = await LocalDB.getOrder(orderId);
    if (!order) return true;
    const stored = (order as { timeline?: unknown }).timeline;
    if (stored === undefined) return true;
    const clean = scrubbedTimeline(stored);
    if (JSON.stringify(clean) === JSON.stringify(stored)) return true;
    const written = await LocalDB.compareAndSetOrderTimeline(orderId, stored, clean);
    if (written.outcome === 'applied' || written.outcome === 'missing') return true;
  }
  return false;
}
