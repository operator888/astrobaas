/**
 * Comments and product reviews (C-142, C-35), as first-class collections.
 *
 * ## Why these are content types and not two bespoke tables
 *
 * The roadmap carried each as a large row proposing its own table, its own
 * storage on three drivers, its own migration, its own GDPR registration and
 * its own admin screen. Once per-record approval existed
 * (`core/moderation.ts`) and collections could be filtered by field, the
 * remaining difference between "a comment" and "an enquiry" was the FIELDS.
 *
 * So they ride the rails everything else rides, and get for free: the REST
 * surface a headless storefront reads, the moderation queue, the GDPR export
 * and erasure sweep (both walk every registered type), storage parity across
 * the three drivers, and the backup.
 *
 * ## Off by default
 *
 * A site that has never wanted comments must not grow a public write endpoint
 * because it upgraded. Each collection is registered only when its setting says
 * so, and both default to off.
 *
 * ## What is deliberately not here
 *
 * Threading beyond one level, reactions, editing by the author, and reviewer
 * replies. A comment thread that can nest arbitrarily is a moderation problem
 * before it is a rendering one, and none of the four is what a shop asks for
 * when it asks for comments.
 */
import type { ContentTypeDefinition } from './content-types';

/** Settings that switch each collection on. Both default to OFF. */
export const COMMENTS_ENABLED_SETTING = 'comments_enabled';
export const REVIEWS_ENABLED_SETTING = 'reviews_enabled';

export const COMMENTS_TYPE = 'comment';
export const REVIEWS_TYPE = 'review';

/**
 * Comments on a post.
 *
 * `post_id` is an `id` rather than a `ref`, because `ref` resolves against
 * registered CUSTOM collections and a post is not one. The field filter
 * (`?where.post_id=`) is what makes it useful, and the SSR page and a headless
 * storefront both use the same query.
 *
 * The email is OPTIONAL and never rendered — it exists so an operator can reply
 * to somebody and so the GDPR sweep can find them. `visibility: 'public'` plus
 * `moderated: true` is the pair that matters: the collection is readable, and a
 * row is not, until somebody approves it.
 */
export const COMMENT_TYPE: ContentTypeDefinition = {
  name: COMMENTS_TYPE,
  label: 'Comment',
  labelPlural: 'Comments',
  visibility: 'public',
  writable: 'public',
  moderated: true,
  fields: [
    { name: 'post_id', rule: { type: 'id' } },
    { name: 'author_name', rule: { type: 'string', min: 1, max: 80 } },
    { name: 'author_email', rule: { type: 'email', optional: true } },
    { name: 'body', rule: { type: 'string', min: 2, max: 4000 } },
  ],
};

/**
 * A review of a product.
 *
 * `rating` is an integer 1–5, bounded in the rule rather than checked by the
 * route, so the admin door, the manifest door and the public form all enforce
 * it from one place.
 *
 * `verified_buyer` is NOT a field a submitter can set — it is stamped by the
 * server when the review carries an order the address actually placed. Being
 * absent from the declared list is what makes that true: `validate()` copies
 * nothing it was not asked for, so a posted `verified_buyer: true` is dropped.
 */
export const REVIEW_TYPE: ContentTypeDefinition = {
  name: REVIEWS_TYPE,
  label: 'Review',
  labelPlural: 'Reviews',
  visibility: 'public',
  writable: 'public',
  moderated: true,
  fields: [
    { name: 'product_id', rule: { type: 'id' } },
    { name: 'author_name', rule: { type: 'string', min: 1, max: 80 } },
    { name: 'author_email', rule: { type: 'email', optional: true } },
    { name: 'rating', rule: { type: 'number', min: 1, max: 5, int: true } },
    { name: 'title', rule: { type: 'string', max: 120, optional: true } },
    { name: 'body', rule: { type: 'string', min: 2, max: 4000 } },
    /** The order this review is attached to, if the reviewer gave one. */
    { name: 'order_number', rule: { type: 'string', max: 40, optional: true } },
  ],
};

/** Which built-in collections an install has switched on. */
export function enabledBuiltinCollections(
  settings: Record<string, unknown> | null | undefined,
  isTrue: (v: unknown) => boolean,
): ContentTypeDefinition[] {
  const map = settings ?? {};
  const out: ContentTypeDefinition[] = [];
  if (isTrue(map[COMMENTS_ENABLED_SETTING])) out.push(COMMENT_TYPE);
  if (isTrue(map[REVIEWS_ENABLED_SETTING])) out.push(REVIEW_TYPE);
  return out;
}

/* ---------------------------------------------------------------- ratings */

export interface RatingSummary {
  count: number;
  /** Mean to one decimal, or `null` when there is nothing to average. */
  average: number | null;
  /** How many reviews gave each score, 1 to 5. */
  histogram: Record<1 | 2 | 3 | 4 | 5, number>;
}

/**
 * Summarise a set of APPROVED reviews.
 *
 * Pure, and it takes the rows the caller already has rather than reading — the
 * product page has them, and a second read per product is how a catalogue page
 * becomes N+1 queries.
 *
 * Rounded to ONE decimal. Two would imply a precision six reviews do not have,
 * and a bare mean of 4.666… printed in full is the kind of number that makes a
 * shop look automated.
 */
export function summariseRatings(
  reviews: readonly { data?: Record<string, unknown> }[],
): RatingSummary {
  const histogram: Record<1 | 2 | 3 | 4 | 5, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let total = 0;
  let count = 0;
  for (const r of reviews) {
    const raw = Number(r.data?.rating);
    if (!Number.isInteger(raw) || raw < 1 || raw > 5) continue;
    histogram[raw as 1 | 2 | 3 | 4 | 5] += 1;
    total += raw;
    count += 1;
  }
  return {
    count,
    average: count === 0 ? null : Math.round((total / count) * 10) / 10,
    histogram,
  };
}
