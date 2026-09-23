/**
 * The audit-log filter spec — defined once, honoured by every storage driver.
 *
 * ## Why this is a module and not two `if`s
 *
 * The same shape as `core/post-query.ts`, for the same reason. The lowdb driver
 * filters an array in JavaScript; the relational driver builds SQL. Two
 * implementations of one rule is how they drift, and drift in a filter is
 * invisible: the query returns *some* rows, they look plausible, and nobody
 * notices the ones that are missing. That already happened here once with
 * `?locale=`, where both implementations were wrong in the same direction so
 * the differential test could not see it.
 *
 * So the rule lives here as a pure function, the document drivers call it, and
 * the relational driver's SQL is asserted against it row-for-row.
 *
 * ## Why filtering cannot be done in the browser
 *
 * The store keeps thousands of events and the API caps a response at 500. A
 * filter applied client-side would search only the page it was given, so
 * "show me everything this user did" would quietly answer "…of the most recent
 * 500 events", which is worse than refusing: it looks like an answer.
 */
import type { AuditEvent } from './models';

export interface AuditQuery {
  /**
   * Action match, by PREFIX.
   *
   * Actions are dotted and hierarchical (`auth.login.failed`,
   * `payment.refund.issued`), so a prefix is the natural unit: `auth.` is every
   * authentication event, `auth.login.` is every login attempt, and the full
   * string still matches exactly itself. An exact-only match forced an admin to
   * know the whole vocabulary before they could look at anything.
   */
  action?: string;
  /**
   * Actor, case-insensitive SUBSTRING.
   *
   * Substring rather than exact because an actor is not always a user id: API
   * keys record `apikey:<id>`, and a partial id is what someone actually has to
   * hand when following up on one line in the table.
   */
  actor?: string;
  /** Inclusive lower bound, ISO. A date-only value means 00:00:00 that day. */
  from?: string;
  /** Inclusive upper bound, ISO. A date-only value means the END of that day. */
  to?: string;
  /** Cap on rows returned, newest first. */
  limit?: number;
}

/**
 * Normalise a bound supplied by a date input.
 *
 * `<input type="date">` yields `2026-08-24`, which as an ISO instant is
 * midnight. Used as an upper bound unchanged, "to 24 August" excludes almost
 * all of 24 August — the single most common way a date filter lies to someone.
 * A date-only upper bound is therefore pushed to the last millisecond of that
 * day; a lower bound already means midnight and is left alone.
 */
export function normalizeBound(raw: string | undefined, edge: 'start' | 'end'): string | undefined {
  const s = (raw ?? '').trim();
  if (!s) return undefined;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(s);
  if (!dateOnly) return s;
  return edge === 'start' ? `${s}T00:00:00.000Z` : `${s}T23:59:59.999Z`;
}

/** Does one event satisfy the query? Exported so the drivers share the predicate. */
export function auditEventMatches(event: AuditEvent, q: AuditQuery): boolean {
  if (q.action) {
    const want = q.action.trim();
    // Prefix, not equality — see the field docs.
    if (want && !String(event.action ?? '').startsWith(want)) return false;
  }
  if (q.actor) {
    const want = q.actor.trim().toLowerCase();
    if (want && !String(event.actor ?? '').toLowerCase().includes(want)) return false;
  }
  const from = normalizeBound(q.from, 'start');
  const to = normalizeBound(q.to, 'end');
  const at = String(event.created_at ?? '');
  // Timestamps are ISO-8601 UTC, so lexicographic comparison IS chronological
  // comparison — the same property the change feed relies on. It stops being
  // true the moment an offset like `+03:00` is stored, which is why
  // `created_at` is written with `toISOString()` everywhere.
  if (from && at < from) return false;
  if (to && at > to) return false;
  return true;
}

/**
 * Filter and order audit events: newest first, then capped.
 *
 * Ordering before the cap is the whole point — capping first would return an
 * arbitrary 500 and then sort them, which looks identical and is wrong.
 */
export function applyAuditQuery(events: readonly AuditEvent[], q: AuditQuery = {}): AuditEvent[] {
  const out = events.filter((e) => auditEventMatches(e, q));
  out.sort((a, b) => {
    const t = String(b.created_at ?? '').localeCompare(String(a.created_at ?? ''));
    // Ties broken by id so two events in the same millisecond come back in a
    // stable order across drivers — otherwise the cross-driver test compares
    // two correct answers and calls them different.
    return t !== 0 ? t : String(b.id ?? '').localeCompare(String(a.id ?? ''));
  });
  const limit = q.limit;
  return limit && limit > 0 ? out.slice(0, limit) : out;
}
