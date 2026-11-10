/**
 * Product reviews (C-35) — the rules, in one place.
 *
 * ## What this module is for
 *
 * Reviews are the built-in `review` collection (core/builtin-collections.ts),
 * stored like every other custom entity and moderated by the `_status`
 * primitive (core/moderation.ts). What that generic machinery does NOT know is
 * that a review belongs to a PRODUCT. Everything that depends on that fact
 * lives here, so the public route, the admin queue, the product route's
 * `aggregateRating` and the GDPR sweep ask one module and cannot disagree:
 *
 *  - may this product be reviewed right now;
 *  - was this address a buyer (computed by the server, never accepted);
 *  - which rows a stranger may see, and which FIELDS of them;
 *  - the aggregate (average and count per star);
 *  - the admin filters and the per-state counts.
 *
 * ## TEXT only
 *
 * Photos and video are the paid part. Core reserves the seam —
 * `PLUGIN_HOOKS.REVIEW_MEDIA` and `AFTER_REVIEW_DELETE` — and implements no
 * upload, no storage and no media moderation. `sanitiseReviewMedia` is the only
 * media code here, and it exists so a module cannot publish a `javascript:` URL
 * through core's response.
 */
import type { Order, Product } from '../core/models';
import {
  REVIEWS_TYPE, REVIEW_TYPE, REVIEWS_ENABLED_SETTING, summariseRatings, type RatingSummary,
} from '../core/builtin-collections';
import { schemaForContentType } from '../core/content-types';
import {
  statusOf, isModerationState, MODERATION_STATES, STATUS_KEY, type ModerationState,
} from '../core/moderation';
import { pluginManager, PLUGIN_HOOKS } from './plugin-system';
import { boughtProduct } from './commerce/order-lookup';
import { settingBool } from './settings-map';
import { validate } from './validate';

export { REVIEWS_TYPE };

/**
 * Publish a verified buyer's review without waiting for a moderator.
 *
 * OFF by default. Verification proves the ADDRESS bought the product, not that
 * the person typing owns the address (there is no confirmation email yet — see
 * the PR notes for Part 2). With this off, a moderator sees every review
 * before the public does, which is the only safe default for a check that can
 * be borrowed.
 */
export const REVIEW_AUTO_APPROVE_SETTING = 'reviews_auto_approve_verified';

/** A stored review, as the custom-entity store returns it. */
export interface ReviewRow {
  id: string;
  data?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

/** One item a media module may attach. See `sanitiseReviewMedia`. */
export interface ReviewMedia {
  kind: 'image' | 'video';
  url: string;
  alt?: string;
  thumbnail_url?: string;
}

/**
 * What a stranger receives for one review — an ALLOW-LIST, built fresh.
 *
 * Built field by field rather than by deleting the private ones from a copy, so
 * a key added to the stored record later (a spam score, a moderator's note)
 * is absent here until somebody decides it is public. The email, the order
 * number, the spam signals and the moderation state are never on it.
 */
export interface PublicReview {
  id: string;
  product_id: string;
  rating: number;
  title?: string;
  body: string;
  author_name: string;
  verified_buyer: boolean;
  locale?: string;
  created_at: string;
  media?: ReviewMedia[];
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/* -------------------------------------------------------------- gates --- */

/**
 * May this product be reviewed?
 *
 * Both switches: the SITE's (`reviews_enabled`, off by default — the
 * collection is not even registered without it) and the PRODUCT's own
 * `reviews_enabled` (on unless the merchant unticked it, which is what the
 * product editor and the v-migration write). An inactive product is not
 * reviewable: a draft is not public, and accepting a review for it would
 * confirm it exists.
 */
export function reviewsOpenFor(
  settings: Record<string, unknown>,
  product: Pick<Product, 'status' | 'reviews_enabled'> | null | undefined,
): boolean {
  if (!settingBool(settings[REVIEWS_ENABLED_SETTING], false)) return false;
  if (!product || product.status !== 'active') return false;
  return product.reviews_enabled !== false;
}

/**
 * Was this address a buyer of this product? Server-side, at submission.
 *
 * Delegates to `boughtProduct`, the one rule (paid AND processing or completed,
 * never an erased order) — the stamp is computed once, when the review is
 * written, and never recomputed: a review written before a later refund was
 * true when written.
 */
export function verifiedPurchase(orders: readonly Order[], email: unknown, productId: string): boolean {
  return boughtProduct(orders, email, productId);
}

/** Lower-cased, trimmed — the comparison every email match in this codebase uses. */
export function normaliseReviewEmail(raw: unknown): string {
  return str(raw).trim().toLowerCase();
}

/**
 * Has this address already reviewed this product?
 *
 * Any review that is not REJECTED counts — pending, approved and spam alike. A
 * rejected review may be rewritten (the shop said no to that text, not to the
 * person); a pending one may not be duplicated, which is the race the plan
 * names: two submissions before the first is moderated would otherwise both be
 * approved.
 */
export function alreadyReviewed(rows: readonly ReviewRow[], email: string, productId: string): boolean {
  if (!email) return false;
  return rows.some((r) => str(r.data?.product_id) === productId
    && normaliseReviewEmail(r.data?.author_email) === email
    && statusOf(r.data) !== 'rejected');
}

/**
 * Validate a public submission against the REVIEW_TYPE rules.
 *
 * The product id comes from the PATH, never the body, so a review cannot be
 * filed against a product other than the one the route resolved. The email is
 * REQUIRED here although the type marks it optional (a staff member typing a
 * review in the admin may not have one): it is what verification, the
 * duplicate check and a GDPR request all key on.
 */
export function validateReviewSubmission(
  body: Record<string, unknown>,
  productId: string,
): { ok: true; value: Record<string, unknown> } | { ok: false; errors: Record<string, string> } {
  const schema = schemaForContentType(REVIEW_TYPE);
  // Trimmed BEFORE the email rule sees it: a phone keyboard's trailing space is
  // not a reason to refuse the customer.
  const email = typeof body.author_email === 'string' ? body.author_email.trim() : body.author_email;
  const result = validate({ ...body, author_email: email, product_id: productId }, schema);
  if (!result.ok) return { ok: false, errors: result.errors as Record<string, string> };
  const value = { ...(result.value as Record<string, unknown>) };
  if (!normaliseReviewEmail(value.author_email)) {
    return { ok: false, errors: { author_email: 'is required' } };
  }
  value.author_email = normaliseReviewEmail(value.author_email);
  return { ok: true, value };
}

/* ------------------------------------------------------------- reading --- */

/** Has this review been through a data-subject erasure (rating kept, text gone)? */
export function isErasedReview(row: ReviewRow): boolean {
  return typeof row.data?.erased_at === 'string';
}

/**
 * The approved reviews of one product — what the aggregate is computed over.
 *
 * Erased-and-anonymised reviews ARE counted here: erasure keeps the rating
 * precisely so the shop's average does not silently move when a customer asks
 * to be forgotten. They are left out of the LIST (`publicReviewList`), because
 * a review with no author and no text is not something to show.
 */
export function approvedReviewsFor(rows: readonly ReviewRow[], productId: string): ReviewRow[] {
  return rows.filter((r) => str(r.data?.product_id) === productId && statusOf(r.data) === 'approved');
}

/**
 * The stored review rows, or none when the SITE switch is off.
 *
 * `getCustomEntities` returns stored rows whether or not the type is
 * registered, so a shop that collected reviews and then switched them off
 * would otherwise keep emitting stars from one route while another said
 * "no reviews". Every public reader goes through this.
 */
export async function reviewRowsIfEnabled(
  settings: Record<string, unknown>,
  read: (type: string) => Promise<unknown[]>,
): Promise<ReviewRow[]> {
  if (!settingBool(settings[REVIEWS_ENABLED_SETTING], false)) return [];
  return (await read(REVIEWS_TYPE)) as ReviewRow[];
}

/** The aggregate for one product: average to one decimal and the count per star. */
export function reviewAggregate(rows: readonly ReviewRow[], productId: string): RatingSummary {
  return summariseRatings(approvedReviewsFor(rows, productId));
}

/** One stored review as a stranger may see it. */
export function toPublicReview(row: ReviewRow): PublicReview {
  const d = row.data ?? {};
  const out: PublicReview = {
    id: row.id,
    product_id: str(d.product_id),
    rating: Number(d.rating),
    body: str(d.body),
    author_name: str(d.author_name),
    verified_buyer: d.verified_buyer === true,
    created_at: str(d.submitted_at) || str(row.created_at),
  };
  if (str(d.title)) out.title = str(d.title);
  if (str(d.locale)) out.locale = str(d.locale);
  return out;
}

export type PublicReviewSort = 'recent' | 'rating_desc' | 'rating_asc';
export const PUBLIC_REVIEW_SORTS: readonly PublicReviewSort[] = ['recent', 'rating_desc', 'rating_asc'];
export const PUBLIC_REVIEW_PAGE_DEFAULT = 10;
export const PUBLIC_REVIEW_PAGE_MAX = 50;

export interface PublicReviewQuery {
  rating?: number;
  locale?: string;
  verifiedOnly?: boolean;
  sort: PublicReviewSort;
  limit: number;
  offset: number;
}

/**
 * Read the public list's query string. Nonsense is IGNORED, never a 400: a
 * storefront that sends a stale filter should get the unfiltered page, not a
 * product page with its reviews missing.
 */
export function parsePublicReviewQuery(sp: URLSearchParams): PublicReviewQuery {
  const ratingRaw = Number(sp.get('rating'));
  const rating = Number.isInteger(ratingRaw) && ratingRaw >= 1 && ratingRaw <= 5 ? ratingRaw : undefined;
  const sortRaw = sp.get('sort') ?? '';
  const sort = (PUBLIC_REVIEW_SORTS as readonly string[]).includes(sortRaw) ? sortRaw as PublicReviewSort : 'recent';
  const limitRaw = parseInt(sp.get('limit') ?? '', 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0
    ? Math.min(limitRaw, PUBLIC_REVIEW_PAGE_MAX)
    : PUBLIC_REVIEW_PAGE_DEFAULT;
  let offset = Math.max(parseInt(sp.get('offset') ?? '', 10) || 0, 0);
  const page = parseInt(sp.get('page') ?? '', 10);
  if (Number.isFinite(page) && page > 1) offset = (page - 1) * limit;
  const locale = (sp.get('locale') ?? '').trim();
  const verified = sp.get('verified');
  return {
    ...(rating ? { rating } : {}),
    ...(locale ? { locale } : {}),
    ...(verified === '1' || verified === 'true' ? { verifiedOnly: true } : {}),
    sort,
    limit,
    offset,
  };
}

const byRecent = (a: ReviewRow, b: ReviewRow) =>
  (str(b.data?.submitted_at) || str(b.created_at)).localeCompare(str(a.data?.submitted_at) || str(a.created_at));

/**
 * The approved, non-erased reviews of one product, filtered and sorted, plus
 * the total BEFORE paging (for `meta.total`).
 */
export function publicReviewList(
  rows: readonly ReviewRow[],
  productId: string,
  q: PublicReviewQuery,
): { total: number; items: ReviewRow[] } {
  let list = approvedReviewsFor(rows, productId).filter((r) => !isErasedReview(r));
  if (q.rating) list = list.filter((r) => Number(r.data?.rating) === q.rating);
  if (q.locale) list = list.filter((r) => str(r.data?.locale) === q.locale);
  if (q.verifiedOnly) list = list.filter((r) => r.data?.verified_buyer === true);
  list = [...list].sort((a, b) => {
    if (q.sort === 'rating_desc' || q.sort === 'rating_asc') {
      const d = Number(a.data?.rating) - Number(b.data?.rating);
      if (d !== 0) return q.sort === 'rating_desc' ? -d : d;
    }
    return byRecent(a, b);
  });
  return { total: list.length, items: list.slice(q.offset, q.offset + q.limit) };
}

/* --------------------------------------------------------------- media --- */

const MEDIA_MAX = 12;

/** A URL a page may render: http(s), or root-relative. Nothing else. */
function safeUrl(raw: unknown): string | null {
  const s = str(raw).trim();
  if (!s || s.length > 2000) return null;
  if (s.startsWith('/') && !s.startsWith('//')) return s;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Whatever a REVIEW_MEDIA filter returned, reduced to what core will publish.
 *
 * Not an implementation of media — a bouncer at core's door. Unknown kinds,
 * unsafe URLs and anything that is not an object are dropped, and the list is
 * capped, so a misbehaving module degrades to "no photos" rather than to a
 * script URL in a storefront's `<img src>`.
 */
export function sanitiseReviewMedia(raw: unknown): ReviewMedia[] {
  if (!Array.isArray(raw)) return [];
  const out: ReviewMedia[] = [];
  for (const item of raw) {
    if (out.length >= MEDIA_MAX) break;
    if (!item || typeof item !== 'object') continue;
    const m = item as Record<string, unknown>;
    if (m.kind !== 'image' && m.kind !== 'video') continue;
    const url = safeUrl(m.url);
    if (!url) continue;
    const media: ReviewMedia = { kind: m.kind, url };
    const alt = str(m.alt).trim().slice(0, 200);
    if (alt) media.alt = alt;
    const thumb = safeUrl(m.thumbnail_url);
    if (thumb) media.thumbnail_url = thumb;
    out.push(media);
  }
  return out;
}

/* --------------------------------------------------------------- admin --- */

export type AdminStatusFilter = ModerationState | 'all';

export interface AdminReviewQuery {
  status: AdminStatusFilter;
  rating?: number;
  verified?: 'yes' | 'no';
  productId?: string;
  q?: string;
  limit: number;
  offset: number;
}

export const ADMIN_REVIEW_PAGE_DEFAULT = 50;
export const ADMIN_REVIEW_PAGE_MAX = 200;

/**
 * The moderation queue's filters. Defaults to PENDING — the queue opens on
 * what is waiting, which is the question an operator arrives with.
 */
export function parseAdminReviewQuery(sp: URLSearchParams): AdminReviewQuery {
  const s = sp.get('status') ?? 'pending';
  const status: AdminStatusFilter = s === 'all' || isModerationState(s) ? s as AdminStatusFilter : 'pending';
  const ratingRaw = Number(sp.get('rating'));
  const rating = Number.isInteger(ratingRaw) && ratingRaw >= 1 && ratingRaw <= 5 ? ratingRaw : undefined;
  const v = sp.get('verified');
  const productId = (sp.get('product_id') ?? '').trim();
  const q = (sp.get('q') ?? '').trim().slice(0, 100);
  const limitRaw = parseInt(sp.get('limit') ?? '', 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0
    ? Math.min(limitRaw, ADMIN_REVIEW_PAGE_MAX)
    : ADMIN_REVIEW_PAGE_DEFAULT;
  const offset = Math.max(parseInt(sp.get('offset') ?? '', 10) || 0, 0);
  return {
    status,
    ...(rating ? { rating } : {}),
    ...(v === 'yes' || v === 'no' ? { verified: v } : {}),
    ...(productId ? { productId } : {}),
    ...(q ? { q } : {}),
    limit,
    offset,
  };
}

/** How many reviews are in each state — the queue's tab counts and the dashboard card. */
export function reviewStatusCounts(rows: readonly ReviewRow[]): Record<ModerationState, number> {
  const counts = Object.fromEntries(MODERATION_STATES.map((s) => [s, 0])) as Record<ModerationState, number>;
  for (const r of rows) counts[statusOf(r.data)] += 1;
  return counts;
}

/** The oldest pending review's submission time, for an attention card that ages honestly. */
export function oldestPending(rows: readonly ReviewRow[]): string | undefined {
  return rows
    .filter((r) => statusOf(r.data) === 'pending')
    .map((r) => str(r.data?.submitted_at) || str(r.created_at))
    .filter(Boolean)
    .sort()[0];
}

/** The staff queue: every state, filtered, newest first, plus the total before paging. */
export function adminReviewList(
  rows: readonly ReviewRow[],
  q: AdminReviewQuery,
): { total: number; items: ReviewRow[] } {
  const needle = (q.q ?? '').toLowerCase();
  const list = rows.filter((r) => {
    const d = r.data ?? {};
    if (q.status !== 'all' && statusOf(d) !== q.status) return false;
    if (q.rating && Number(d.rating) !== q.rating) return false;
    if (q.verified === 'yes' && d.verified_buyer !== true) return false;
    if (q.verified === 'no' && d.verified_buyer === true) return false;
    if (q.productId && str(d.product_id) !== q.productId) return false;
    if (needle) {
      const hay = [d.author_name, d.author_email, d.title, d.body].map((x) => str(x).toLowerCase()).join('\n');
      if (!hay.includes(needle)) return false;
    }
    return true;
  }).sort(byRecent);
  return { total: list.length, items: list.slice(q.offset, q.offset + q.limit) };
}

/** The bulk actions the queue offers. `delete` removes the row; the rest set a state. */
export const REVIEW_ACTIONS = ['approve', 'reject', 'spam', 'pending', 'delete'] as const;
export type ReviewAction = (typeof REVIEW_ACTIONS)[number];

/** The state an action moves a review to, or `null` for delete. */
export function stateForAction(action: ReviewAction): ModerationState | null {
  switch (action) {
    case 'approve': return 'approved';
    case 'reject': return 'rejected';
    case 'spam': return 'spam';
    case 'pending': return 'pending';
    case 'delete': return null;
    default: {
      // Fail closed: an action added to the list without a case here must not
      // fall through to "delete".
      const never: never = action;
      throw new Error(`Unknown review action: ${String(never)}`);
    }
  }
}

/**
 * The patch that moves a review to `next`, with its timestamps.
 *
 * `moderated_at` on every change of state; `published_at` the FIRST time it is
 * approved and never again, so un-publishing and re-publishing a review does
 * not make an old review look new. One function, called by the queue's bulk
 * route AND the generic content PUT, so approving from either screen stamps
 * the same way.
 */
export function reviewModerationPatch(
  prev: Record<string, unknown> | undefined,
  next: ModerationState,
  nowIso: string,
): Record<string, unknown> {
  if (statusOf(prev) === next && prev?.[STATUS_KEY] === next) return {};
  return {
    [STATUS_KEY]: next,
    moderated_at: nowIso,
    ...(next === 'approved' && !str(prev?.published_at) ? { published_at: nowIso } : {}),
  };
}

/**
 * Tell a media module (the paid seam) that a review is gone or anonymised.
 * See PLUGIN_HOOKS.AFTER_REVIEW_DELETE.
 */
export function announceReviewRemoved(row: ReviewRow, reason: 'deleted' | 'erased'): void {
  pluginManager.doAction(
    PLUGIN_HOOKS.AFTER_REVIEW_DELETE,
    { id: row.id, product_id: str(row.data?.product_id) },
    { reason },
  );
}

/** Bounded bulk size: one request moderates a page, not the whole table. */
export const REVIEW_BULK_MAX = 200;

/* ---------------------------------------------------------------- GDPR --- */

/**
 * What an approved review keeps when its author is erased: the RATING, the
 * product and the verified flag (facts about a sale, no longer about a person),
 * and the moderation state. Name, email, order number, title and body go — the
 * text is the person's own words and may name them.
 *
 * Returned as a PATCH for `updateCustomEntity`, which merges: `undefined`
 * removes a key on every driver.
 */
export function anonymisedReviewPatch(nowIso: string): Record<string, unknown> {
  return {
    author_name: undefined,
    author_email: undefined,
    order_number: undefined,
    title: undefined,
    body: undefined,
    spam_score: undefined,
    spam_flagged: undefined,
    spam_reasons: undefined,
    erased_at: nowIso,
  };
}

/** Reviews written from this (already normalised) address. */
export function reviewsByEmail(rows: readonly ReviewRow[], email: string): ReviewRow[] {
  if (!email) return [];
  return rows.filter((r) => normaliseReviewEmail(r.data?.author_email) === email);
}
