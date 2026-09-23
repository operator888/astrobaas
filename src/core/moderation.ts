/**
 * Per-record approval (C-142, C-35) — the primitive the collection model lacked.
 *
 * ## What was missing, and why two features were blocked on it
 *
 * `ContentTypeDefinition.visibility` is a single collection-wide flag:
 * `'public'` publishes EVERY row, including one posted thirty seconds ago by a
 * bot. There was no per-record approval state anywhere in the custom-entity
 * model, so "comments as a public-write content type" would have published
 * spam the instant it arrived, and "reviews as a content type" would have
 * published a one-star review of a competitor before anyone read it.
 *
 * That single gap is why the roadmap carried comments and product reviews as
 * two large rows, each proposing its OWN table, its own storage on three
 * drivers, its own migration, its own GDPR registration and its own admin
 * screen. They are one missing primitive and two sets of fields.
 *
 * ## The rule
 *
 * A type may declare `moderated: true`. Then:
 *
 *  - a PUBLIC submission lands as `pending` and is invisible to the public;
 *  - a STAFF entry lands as `approved`, because a colleague typing it is the
 *    approval;
 *  - a public read returns only `approved` rows;
 *  - staff read everything, and move rows between states.
 *
 * The status lives in a RESERVED key on the record's data, `_status`, rather
 * than in a new column — so it works identically on all three storage drivers
 * with no migration, and the existing list, export, GDPR and backup paths carry
 * it without being told about it.
 *
 * ## Why `_status` cannot be a declared field
 *
 * It is set by the server and read as authority. A declared field of that name
 * would let a submitter post their own approval, which is the whole feature
 * inverted. `field-rule-build.ts` reserves it alongside `_layout`.
 */

/** The states a moderated record moves through. */
export const MODERATION_STATES = ['pending', 'approved', 'rejected'] as const;
export type ModerationState = (typeof MODERATION_STATES)[number];

/** The reserved key holding a record's approval state. */
export const STATUS_KEY = '_status';

export function isModerationState(value: unknown): value is ModerationState {
  return typeof value === 'string' && (MODERATION_STATES as readonly string[]).includes(value);
}

/**
 * The state a record is in.
 *
 * A row written before its type became moderated has no `_status` at all.
 * It counts as APPROVED: it was already public under the old rule, and
 * retroactively hiding a shop's existing entries because an operator ticked a
 * box is a data-loss-shaped surprise. Turning moderation on governs what
 * arrives next.
 */
export function statusOf(data: Record<string, unknown> | undefined): ModerationState {
  const raw = data?.[STATUS_KEY];
  return isModerationState(raw) ? raw : 'approved';
}

/** May an anonymous reader see this record? */
export function isPubliclyVisible(data: Record<string, unknown> | undefined): boolean {
  return statusOf(data) === 'approved';
}

/**
 * Narrow a list for a viewer.
 *
 * `staff` sees everything, including rejected rows — a moderation queue that
 * hides what it rejected cannot be reviewed, and "where did that go?" is the
 * question a queue exists to answer.
 */
export function visibleEntries<T extends { data?: Record<string, unknown> }>(
  entries: readonly T[],
  opts: { moderated: boolean; staff: boolean },
): T[] {
  if (!opts.moderated || opts.staff) return [...entries];
  return entries.filter((e) => isPubliclyVisible(e.data));
}

/** The state a new record starts in. */
export function initialStatus(opts: { moderated: boolean; staff: boolean }): ModerationState | undefined {
  if (!opts.moderated) return undefined;
  // A colleague typing an entry in the admin IS the approval. Making staff
  // approve their own entries adds a step that teaches people to click through
  // the queue without reading it.
  return opts.staff ? 'approved' : 'pending';
}

/** How many rows are waiting, for a badge that tells an operator to look. */
export function pendingCount(entries: readonly { data?: Record<string, unknown> }[]): number {
  return entries.reduce((n, e) => (statusOf(e.data) === 'pending' ? n + 1 : n), 0);
}
