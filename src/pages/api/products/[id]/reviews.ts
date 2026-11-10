import type { APIRoute } from 'astro';
import { LocalDB } from '../../../../lib/localdb';
import { ApiResponseBuilder } from '../../../../lib/api-response';
import { publicSubmissionGate, spamFields } from '../../../../lib/public-submission';
import { settingsMap, settingBool } from '../../../../lib/settings-map';
import { contentLocale } from '../../../../lib/i18n/resolve';
import { fireEvent } from '../../../../lib/webhooks';
import { pluginManager, PLUGIN_HOOKS } from '../../../../lib/plugin-system';
import { STATUS_KEY } from '../../../../core/moderation';
import { ensurePluginsBootstrapped } from '../../../../plugins';
import {
  REVIEWS_TYPE, REVIEW_AUTO_APPROVE_SETTING, reviewsOpenFor, verifiedPurchase, alreadyReviewed,
  validateReviewSubmission, reviewAggregate, parsePublicReviewQuery, publicReviewList, toPublicReview,
  sanitiseReviewMedia, reviewRowsIfEnabled, type ReviewRow,
} from '../../../../lib/reviews';

/**
 * `GET|POST /api/products/{ref}/reviews` — a product's reviews (C-35).
 *
 * `{ref}` is the product's id or its slug, like `GET /api/products/{ref}`.
 * An inactive or unknown product is a 404 on read — the same 404 the product
 * route gives — so this route cannot confirm a draft exists.
 */
export const prerender = false;

async function resolveProduct(ref: string) {
  if (!ref) return undefined;
  return (await LocalDB.getProduct(ref)) ?? (await LocalDB.getProductBySlug(ref));
}

async function loadSettings(): Promise<Record<string, unknown>> {
  return settingsMap((await LocalDB.getSettings()) as never);
}

/**
 * The approved reviews of one product, paged, with the aggregate.
 *
 * Public and anonymous. Only APPROVED rows, and only the allow-listed fields of
 * them (`toPublicReview`): no email, no order number, no spam score, no
 * moderation state. The aggregate is computed over EVERY approved review of
 * the product, not the page, and is what `GET /api/products/{ref}` puts in
 * its `aggregateRating` — the same function, so the two cannot disagree.
 */
export const GET: APIRoute = async ({ params, url }) => {
  try {
    await LocalDB.init();
    // The media seam below is a plugin filter; the registry must be populated
    // before it is asked.
    await ensurePluginsBootstrapped();
    const product = await resolveProduct(String(params.id ?? ''));
    if (!product || product.status !== 'active') return ApiResponseBuilder.notFound('Product');

    const settings = await loadSettings();
    const open = reviewsOpenFor(settings, product);
    // With the site switch off there is no review collection at all, and the
    // answer is the empty one rather than a 404: a storefront renders the same
    // product page whether or not the shop takes reviews.
    const rows = await reviewRowsIfEnabled(settings, (t) => LocalDB.getCustomEntities(t));

    const q = parsePublicReviewQuery(new URL(url).searchParams);
    const { total, items } = publicReviewList(rows, product.id, q);
    const reviews = items.map((row) => {
      const pub = toPublicReview(row);
      // The paid seam: a media module may attach photos or video. Initial
      // value [] and attached only when non-empty, so without a module this is
      // byte-identical to a text-only response.
      const media = sanitiseReviewMedia(
        pluginManager.applyFilters(PLUGIN_HOOKS.REVIEW_MEDIA, [], { review: pub, productId: product.id }),
      );
      return media.length ? { ...pub, media } : pub;
    });

    return ApiResponseBuilder.success({
      product_id: product.id,
      // Whether a storefront should show the form at all.
      accepting_reviews: open,
      aggregate: reviewAggregate(rows, product.id),
      reviews,
    }, 'Reviews retrieved', {
      total,
      count: reviews.length,
      limit: q.limit,
      offset: q.offset,
      page: Math.floor(q.offset / q.limit) + 1,
    });
  } catch (err) {
    console.error('Product reviews read error:', err);
    return ApiResponseBuilder.serverError('Could not read the reviews');
  }
};

/**
 * One answer for every outcome a stranger is not entitled to tell apart.
 *
 * Stored-and-pending, stored-and-auto-approved, a duplicate that was dropped,
 * a honeypot hit — all of these are `201 { received: true }`. Distinguishing
 * them would be an oracle:
 *  - "approved at once" means "this address bought this product" whenever the
 *    shop auto-approves verified buyers — anyone could type a neighbour's
 *    address and learn what they ordered;
 *  - "you have already reviewed this" confirms an address reviewed a product.
 * So the response never carries the id, the state or the verified flag.
 */
function received(): Response {
  return ApiResponseBuilder.created({ received: true }, 'Thank you — your review has been received');
}

/**
 * Submit a review. Public, cookie-less, and behind the shared public gate:
 * per-IP rate limit, honeypot (`hp_url`), the proof of work — ALWAYS required
 * here (`reviews` is an always-on captcha surface; fetch a challenge from
 * `/api/captcha/challenge?surface=reviews`) — and the structural spam score,
 * which flags and never refuses.
 *
 * Then: the product must exist, be active and take reviews; the body must pass
 * the REVIEW_TYPE rules; `verified_buyer` is computed HERE from the orders and
 * never read from the body; the review is `pending` unless the operator turned
 * on auto-approval for verified buyers and the score did not flag it.
 */
export const POST: APIRoute = async ({ params, request, locals }) => {
  try {
    const raw = await request.json().catch(() => null);
    const body = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw as Record<string, unknown> : {};

    const gate = await publicSubmissionGate({
      // Its own rate-limit bucket: a burst of reviews must not close the
      // contact form, and the other way round.
      surface: 'reviews', ip: locals.ip ?? 'unknown', body, captchaSurface: 'reviews',
    });
    if (gate.kind === 'rate-limited') {
      return ApiResponseBuilder.error(429, 'Too many submissions. Please try again later.');
    }
    if (gate.kind === 'silent') return received();
    if (gate.kind === 'challenge-failed') {
      return ApiResponseBuilder.forbidden('Please try again (anti-spam check failed)');
    }

    await LocalDB.init();
    const product = await resolveProduct(String(params.id ?? ''));
    const settings = await loadSettings();
    // A product that does not exist, is not active, or does not take reviews
    // is the SAME 404 — a review form is not a way to ask which drafts exist.
    if (!product || !reviewsOpenFor(settings, product)) return ApiResponseBuilder.notFound('Product');

    const checked = validateReviewSubmission(body, product.id);
    // Field errors ARE named: the reviewer mistyped and can fix it, and the
    // rules (a rating of 1–5, a body of 2–4000 characters) are public anyway.
    if (!checked.ok) return ApiResponseBuilder.validationError('Invalid review', checked.errors);
    const value = checked.value;
    const email = String(value.author_email);

    // The order lookup runs BEFORE the duplicate check, so a dropped duplicate
    // costs the same work as a stored review and cannot be told apart by how
    // fast it answers.
    let verified = false;
    try {
      verified = verifiedPurchase(await LocalDB.getOrders(), email, product.id);
    } catch {
      // A commerce read that fails must not lose the review. Unstamped is the
      // honest fallback: it claims nothing.
      verified = false;
    }

    const rows = await LocalDB.getCustomEntities(REVIEWS_TYPE) as ReviewRow[];
    if (alreadyReviewed(rows, email, product.id)) return received();

    const autoApprove = verified && !gate.spam.flagged
      && settingBool(settings[REVIEW_AUTO_APPROVE_SETTING], false);

    const created = await LocalDB.createCustomEntity(REVIEWS_TYPE, {
      ...value,
      // The language it was written in, as one of THIS site's locales — an
      // unknown value becomes the default rather than being stored verbatim.
      locale: contentLocale(null, typeof body.locale === 'string' ? body.locale : null),
      submitted_at: new Date().toISOString(),
      [STATUS_KEY]: autoApprove ? 'approved' : 'pending',
      // Stamped by the server, from the orders. Only when true: a column of
      // `false` makes the true ones no easier to find.
      ...(verified ? { verified_buyer: true } : {}),
      ...spamFields(gate.spam),
    });
    if (!created) return ApiResponseBuilder.serverError('Could not save your review');

    // The same event every other public submission fires, so an operator's
    // existing "new form submission" webhook sees reviews too. Staff-facing:
    // webhook endpoints are the operator's own.
    fireEvent('content.submitted', { type: REVIEWS_TYPE, entity: created }).catch(() => {});
    return received();
  } catch (err) {
    console.error('Product review submit error:', err);
    return ApiResponseBuilder.serverError('Could not save your review');
  }
};
