/**
 * The content change feed's paging spec — defined once, honoured by every
 * storage driver.
 *
 * ## Why this exists
 *
 * `GET /api/content/changes` is an anonymous public read, polled by headless
 * storefronts to learn what to revalidate. It used to read the WHOLE feed and
 * filter afterwards. On the document drivers that was bounded by accident — the
 * ring in `localdb.ts` keeps 1,000 entries — but the relational driver never
 * pruned `content_changes` at all, and stored a full product or order snapshot
 * on every save. On a 600K-product catalogue one anonymous request was a full
 * table read with every snapshot parsed into memory, and the table grew on
 * every product edit, forever.
 *
 * So the feed now has three bounds, and all three are defined here so the
 * drivers cannot disagree about them:
 *
 *   - RETENTION — at most `CONTENT_CHANGE_CAP` entries are kept, on every
 *     driver. The doc drivers always did this; the relational driver now does
 *     the same thing, and prunes a database created before it did.
 *   - A HARD LIMIT per read — `CHANGE_PAGE_MAX`. Retention alone is not a
 *     bound on a read: an install that has not pruned yet (the first boot after
 *     an upgrade, a restored backup) can hold far more.
 *   - KEYSET PAGING — `(timestamp, id)`, newest first, with an opaque cursor.
 *     An OFFSET would re-read everything it skips and shift under concurrent
 *     writes; a keyset cursor does neither.
 *
 * ## Why the id is part of the order
 *
 * Timestamps collide. A bulk import writes hundreds of changes inside one
 * millisecond, and "newest first" alone does not say which of two equal
 * timestamps comes first — so two reads could order them differently, and a
 * cursor sitting on one of them would skip or repeat its twin. `(timestamp,
 * id)` is a total order, so a cursor names exactly one position.
 *
 * ## Why the default page is the whole retention window
 *
 * The live storefronts poll this feed without knowing about paging — some
 * without `since`. A default page smaller than what they received before would
 * silently drop changes from their revalidation, which is a stale storefront
 * that nothing reports. With the default equal to the retention cap, a client
 * that has never heard of `limit` receives exactly what the document drivers
 * always gave it, and still never more than the cap. Clients that want smaller
 * pages ask for them and follow `next_cursor`.
 *
 * ## Knowing when a window was cut short
 *
 * Retention means a poller that falls behind loses entries, and it has to be
 * TOLD — counting what it received cannot work, because the cap counts every
 * type and a caller is shown only some. So every driver records, per entity
 * type, the newest timestamp retention has evicted (`recordPrunedChanges`), a
 * page reports it for the caller's own types (`prunedThrough`), and the route
 * turns it into `meta.truncated` (`isChangeWindowTruncated`).
 */
import type { ContentChange, EntityType } from './models';

/**
 * How many change-feed entries any driver keeps.
 *
 * The number the document drivers' ring always used. It is small on purpose:
 * each entry carries a full entity snapshot for editorial callers, so the cap
 * is also a cap on how much of that the database holds.
 */
export const CONTENT_CHANGE_CAP = 1000;

/** The most entries one read may return, whoever asks and however. */
export const CHANGE_PAGE_MAX = CONTENT_CHANGE_CAP;

/** The page size when the caller does not name one. See the module comment. */
export const CHANGE_PAGE_DEFAULT = CHANGE_PAGE_MAX;

/**
 * Field names recorded per change. A patch naming more than this is recorded
 * as "unknown which fields" rather than truncated: a truncated list reads as a
 * complete one, and a storefront that skips revalidating because the field it
 * cares about was cut off the end is stale with nothing to show for it.
 */
export const MAX_CHANGE_FIELDS = 64;
const MAX_FIELD_NAME = 100;

/** A position in the feed: the `(timestamp, id)` of the last entry a page held. */
export interface ChangeCursor {
  ts: string;
  id: string;
}

export interface ContentChangeQuery {
  /** Exclusive lower bound on `timestamp`. Any ISO-8601 instant. */
  since?: string;
  /** Keyset cursor: only entries strictly OLDER than this position. */
  before?: ChangeCursor;
  /** Page size; clamped to `[1, CHANGE_PAGE_MAX]`, default `CHANGE_PAGE_DEFAULT`. */
  limit?: number;
  /**
   * Allow-list of entity types. Absent means every type. Pushed into the read
   * rather than applied afterwards, so a page is full and `hasMore` is true
   * only when there is more the caller may actually see.
   */
  types?: readonly string[];
  /**
   * Include each entry's `changes` snapshot. False returns metadata only, and
   * on the relational driver the snapshot never leaves the database.
   */
  snapshots?: boolean;
}

/** One entry without its snapshot: what changed and when, never what it said. */
export interface ContentChangeMeta {
  id: string;
  entity_type: EntityType;
  entity_id: string;
  action: ContentChange['action'];
  timestamp: string;
  /** Names of the fields an update touched, when the write path knew them. */
  fields?: string[];
}

export interface ContentChangePage {
  /** Newest first. Full entries when `snapshots`, metadata otherwise. */
  items: Array<ContentChange | ContentChangeMeta>;
  /** True when at least one more matching entry is older than the last item. */
  hasMore: boolean;
  /** Where the next page starts; null when `hasMore` is false. */
  nextCursor: ChangeCursor | null;
  /**
   * The newest `timestamp` retention has ever EVICTED among the types this
   * query covers (every type when `types` is absent), or null when none of
   * them has lost an entry. Only ever the query's own types: see
   * `recordPrunedChanges` for why that matters. `isChangeWindowTruncated`
   * turns it into `meta.truncated`.
   */
  prunedThrough: string | null;
}

/** A query with every default applied and every bound enforced. */
export interface NormalizedChangeQuery {
  since?: string;
  before?: ChangeCursor;
  limit: number;
  types: string[] | null;
  snapshots: boolean;
}

/**
 * The page size to use for a raw value from a query string or a caller.
 *
 * Never throws and never rejects: an absent or unreadable `limit` is the
 * default, and anything numeric is clamped into range. A storefront that sends
 * `limit=abc` should get a feed, not a 400.
 */
export function clampChangeLimit(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return CHANGE_PAGE_DEFAULT;
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n)) return CHANGE_PAGE_DEFAULT;
  return Math.min(CHANGE_PAGE_MAX, Math.max(1, Math.trunc(n)));
}

/** A date and a time with no zone designator: `2026-09-11T10:00[:00[.5]]`. */
const ZONELESS_DATE_TIME = /^(\d{4}-\d{2}-\d{2})[Tt ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/;

/**
 * `since` as the store compares it.
 *
 * Stored timestamps are `toISOString()` output and are compared as STRINGS, so
 * a bound written any other way compared wrongly: `2026-09-11T10:00:00Z` sorts
 * AFTER `2026-09-11T10:00:00.500Z` (`Z` is above `.`), which silently dropped
 * the first second of changes after it, and an offset like `+02:00` compared as
 * nonsense. Anything `Date` can read is rewritten into the stored shape.
 *
 * A date-time with NO zone designator (`2026-09-11T10:00:00`) is read as UTC.
 * `Date.parse` alone reads that form as the SERVER's local time, so one request
 * meant a different instant on a host in New York than on a host in UTC — and in
 * New York it moved the bound four hours later and dropped every change in
 * between, which the old string comparison had included. Every stored timestamp
 * is UTC, and the old comparison read the digits as UTC too; a feed whose answer
 * depends on the host's TZ is one nobody can reason about. The separator may be
 * a space or a lower-case `t` as well — V8 reads those as local time too, so
 * they are rebuilt with a `T` before the `Z` goes on. A date alone
 * (`2026-09-11`) already parses as UTC midnight, and is left to `Date.parse`.
 *
 * An unreadable value is passed through untouched — that is the comparison the
 * route always made, so a client sending one gets what it got before rather
 * than a new error.
 */
export function normalizeChangeSince(raw: string | null | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const zoneless = ZONELESS_DATE_TIME.exec(trimmed);
  const ms = Date.parse(zoneless ? `${zoneless[1]}T${zoneless[2]}Z` : trimmed);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : trimmed;
}

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(raw: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  try {
    const padded = raw.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (raw.length % 4)) % 4);
    const bin = atob(padded);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * The opaque `next_cursor` for a position.
 *
 * Opaque so clients pass it back rather than build one, and base64url so it
 * survives a query string without anybody having to remember to encode it.
 * Web APIs only (`btoa`, `TextEncoder`): this module is part of the public core
 * and must not assume Node.
 */
export function encodeChangeCursor(cursor: ChangeCursor): string {
  return toBase64Url(JSON.stringify([cursor.ts, cursor.id]));
}

/**
 * Read a cursor back, or null when it is not one this module wrote.
 *
 * Null rather than a throw: the route answers a malformed cursor with a 400,
 * and a paging client that is silently restarted from the top instead would
 * loop forever. The values are only ever bound as parameters, so this checks
 * shape, not safety.
 */
export function decodeChangeCursor(raw: string | null | undefined): ChangeCursor | null {
  if (typeof raw !== 'string' || !raw || raw.length > 512) return null;
  const text = fromBase64Url(raw);
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) return null;
  const [ts, id] = parsed;
  if (typeof ts !== 'string' || typeof id !== 'string') return null;
  if (!ts || ts.length > 64 || !Number.isFinite(Date.parse(ts))) return null;
  if (!id || id.length > 200) return null;
  return { ts, id };
}

/** Every default applied, every bound enforced. Both drivers read the result. */
export function normalizeChangeQuery(query: ContentChangeQuery = {}): NormalizedChangeQuery {
  const types = Array.isArray(query.types)
    ? [...new Set(query.types.filter((t): t is string => typeof t === 'string' && t.length > 0))]
    : null;
  const before = query.before && typeof query.before.ts === 'string' && typeof query.before.id === 'string'
    ? { ts: query.before.ts, id: query.before.id }
    : undefined;
  return {
    since: normalizeChangeSince(query.since),
    before,
    limit: clampChangeLimit(query.limit),
    types,
    snapshots: query.snapshots === true,
  };
}

/**
 * The names of the fields a patch touched, for the `fields` of an update.
 *
 * `updated_at` and `id` are left out: every update stamps the first and none
 * may change the second, so listing them says nothing. Undefined — "not known"
 * — for anything that is not a plain object, and for a patch too wide to list
 * honestly (see MAX_CHANGE_FIELDS). Sorted, so one edit always records the same
 * value whatever order the caller built the patch in.
 */
export function changedFieldNames(patch: unknown): string[] | undefined {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return undefined;
  const names = Object.keys(patch).filter((k) => k !== 'updated_at' && k !== 'id');
  if (names.length > MAX_CHANGE_FIELDS) return undefined;
  if (names.some((n) => n.length > MAX_FIELD_NAME)) return undefined;
  return names.sort();
}

/**
 * A stored `fields` value, validated.
 *
 * The relational driver hands back JSON text from `json_extract`, the document
 * drivers an array; a legacy entry has neither. Anything that is not a list of
 * short strings is treated as absent rather than passed on.
 */
export function parseStoredFields(raw: unknown): string[] | undefined {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (!Array.isArray(value) || value.length > MAX_CHANGE_FIELDS) return undefined;
  if (!value.every((f) => typeof f === 'string' && f.length > 0 && f.length <= MAX_FIELD_NAME)) return undefined;
  return value as string[];
}

/** An entry without its snapshot. The only shape a non-editorial caller sees. */
export function toChangeMeta(change: ContentChange): ContentChangeMeta {
  const meta: ContentChangeMeta = {
    id: change.id,
    entity_type: change.entity_type,
    entity_id: change.entity_id,
    action: change.action,
    timestamp: change.timestamp,
  };
  const fields = parseStoredFields(change.fields);
  if (fields) meta.fields = fields;
  return meta;
}

/** `(timestamp, id)` descending — the feed's one order, on every driver. */
export function compareChangesNewestFirst(
  a: Pick<ContentChange, 'timestamp' | 'id'>,
  b: Pick<ContentChange, 'timestamp' | 'id'>,
): number {
  if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? 1 : -1;
  if (a.id !== b.id) return a.id < b.id ? 1 : -1;
  return 0;
}

/** Is `change` strictly older than `cursor` in feed order? (SQL: `(ts, id) < (?, ?)`) */
export function isOlderThanCursor(change: Pick<ContentChange, 'timestamp' | 'id'>, cursor: ChangeCursor): boolean {
  return change.timestamp < cursor.ts || (change.timestamp === cursor.ts && change.id < cursor.id);
}

/**
 * Build a page from the rows a driver read, where it read `limit + 1`.
 *
 * Reading one extra is how `hasMore` is known without a COUNT: if the extra row
 * exists there is more, and it is not returned. The cursor is the last row that
 * IS returned, so the next page starts immediately after it.
 */
export function pageFromRows<T extends { id: string }>(
  rows: T[],
  limit: number,
  tsOf: (row: T) => string,
): { items: T[]; hasMore: boolean; nextCursor: ChangeCursor | null } {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return { items, hasMore, nextCursor: hasMore && last ? { ts: tsOf(last), id: last.id } : null };
}

/**
 * Fold evicted entries into the per-type record of what retention has evicted:
 * for each entity type, the newest `timestamp` that left the feed.
 *
 * ## Why the feed keeps this
 *
 * Retention keeps 1,000 entries of EVERY type, and a caller may be shown only
 * some types. A poller that fell behind — it was down, or a bulk import outran
 * it — could not tell from what it received. The rule it used to be given ("a
 * walk that returns 1,000 in total may have overflowed") never fires for an
 * anonymous poller, because the 1,000 includes staff-only types it is never
 * shown: on the fixture in tests/change-feed.test.mjs a full window hands an
 * anonymous caller 700. And a staff-only type that anyone may WRITE — a public
 * form — evicts visible entries as it grows.
 *
 * ## Why per type, and not one "oldest retained" mark
 *
 * A single mark moves with writes of every type, hidden ones included, and a
 * caller could binary-search `since` against it to recover exactly the volume
 * and timing of the hidden writes that `publicChangeTypes` withholds. Kept per
 * type and read only for the caller's own types, the mark a caller is told
 * about moves when an entry of a type it is SHOWN is evicted — an entry it could
 * read while it was retained, and whose disappearance it could already watch in
 * the feed itself.
 *
 * Every driver keeps it the same way. The document drivers fold each evicted
 * slice in here (the ring in appendChange, the boot trim, clearContentChanges);
 * the relational driver writes the same thing to `content_changes_pruned`, in
 * the transaction that deletes. An ERASURE (deleteContentChangesFor) is not
 * recorded: it is not retention, and a mark that moved when one customer's
 * order entries were erased would publish when the erasure happened.
 *
 * Returns a new null-prototype object. The keys are entity types, and on an
 * ordinary object a type called `__proto__` would be a prototype assignment
 * that silently records nothing.
 */
export function recordPrunedChanges(
  watermarks: Record<string, string> | undefined,
  evicted: readonly ContentChange[],
): Record<string, string> {
  const out: Record<string, string> = Object.assign(Object.create(null), watermarks ?? {});
  for (const c of evicted) {
    if (!c || typeof c.timestamp !== 'string') continue;
    const type = typeof c.entity_type === 'string' ? c.entity_type : '';
    const prev = Object.prototype.hasOwnProperty.call(out, type) ? out[type] : undefined;
    if (typeof prev !== 'string' || c.timestamp > prev) out[type] = c.timestamp;
  }
  return out;
}

/**
 * The newest eviction among `types` (every type when null) — what a page
 * reports as `prunedThrough`.
 *
 * Only own string values count: the document drivers read this map back from a
 * JSON file that anyone with shell access can edit, and an inherited
 * `constructor` is not an entity type.
 */
export function prunedThroughFor(watermarks: unknown, types: readonly string[] | null): string | null {
  if (!watermarks || typeof watermarks !== 'object') return null;
  const marks = watermarks as Record<string, unknown>;
  let newest: string | null = null;
  for (const type of types ?? Object.keys(marks)) {
    if (!Object.prototype.hasOwnProperty.call(marks, type)) continue;
    const ts = marks[type];
    if (typeof ts === 'string' && (newest === null || ts > newest)) newest = ts;
  }
  return newest;
}

/**
 * Did retention evict a change inside this caller's window? — `meta.truncated`.
 *
 * The window is everything after `since`, or all of history when there is no
 * `since`. It is truncated when the newest eviction among the caller's types
 * falls INSIDE it: strictly after the bound, because `since` is exclusive and
 * an entry stamped exactly at it was never asked for. The newest eviction is
 * all it takes: if it is inside the window, an entry the caller asked for is
 * gone; if it is not, no eviction of the caller's types can be. (Which excess
 * entry goes first differs by driver — the ring drops its head, the relational
 * prune walks down from the cap — and does not matter to that.)
 *
 * The route evaluates it on EVERY page, against the record as it stands at that
 * moment, so the last page of a walk also reports an eviction that happened
 * while the walk was in progress. `since` goes through the same normalisation
 * the store compares with, so the two cannot disagree about the boundary.
 */
export function isChangeWindowTruncated(prunedThrough: string | null, since: string | null | undefined): boolean {
  if (prunedThrough === null) return false;
  const bound = normalizeChangeSince(since);
  return bound === undefined || prunedThrough > bound;
}

/**
 * The feed query, applied to an in-memory list — the document drivers' whole
 * implementation, and the specification the relational SQL is tested against.
 *
 * `watermarks` is the driver's record of what retention has evicted (see
 * `recordPrunedChanges`); the page's `prunedThrough` is read from it for the
 * query's own types.
 *
 * Never mutates `changes`: the lowdb read cache hands out the live array, and a
 * sort in place is what once made the ring evict its NEWEST entries (see the
 * note on `LocalDB.getContentChanges`).
 */
export function applyChangeQuery(
  changes: readonly ContentChange[],
  query: ContentChangeQuery = {},
  watermarks?: unknown,
): ContentChangePage {
  const q = normalizeChangeQuery(query);
  const allowed = q.types ? new Set(q.types) : null;
  const matching = changes.filter((c) =>
    !!c
    && typeof c.timestamp === 'string'
    && typeof c.id === 'string'
    && (q.since === undefined || c.timestamp > q.since)
    && (q.before === undefined || isOlderThanCursor(c, q.before))
    && (allowed === null || allowed.has(c.entity_type)),
  );
  matching.sort(compareChangesNewestFirst);
  const page = pageFromRows(matching.slice(0, q.limit + 1), q.limit, (c) => c.timestamp);
  return {
    items: q.snapshots ? page.items : page.items.map(toChangeMeta),
    hasMore: page.hasMore,
    nextCursor: page.nextCursor,
    prunedThrough: prunedThroughFor(watermarks, q.types),
  };
}
