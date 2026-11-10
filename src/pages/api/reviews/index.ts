import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { canManageCatalog } from '../../../lib/auth';
import {
  REVIEWS_TYPE, parseAdminReviewQuery, adminReviewList, reviewStatusCounts, type ReviewRow,
} from '../../../lib/reviews';

/**
 * `GET /api/reviews` — the moderation queue (C-35). Staff only.
 *
 * Every state, including rejected and spam: a queue that hides what it
 * rejected cannot be reviewed. Filters: `status` (pending by default, or
 * approved | rejected | spam | all), `rating`, `verified=yes|no`,
 * `product_id`, `q` (name, email, title or body), `limit`/`offset`.
 *
 * Unlike the public read this DOES return the reviewer's email — the people
 * who may moderate (the `manage_catalog` capability: admin, editor and manager
 * by default) need it to recognise a repeat sender, and it is the same set
 * that already reads customers' orders.
 *
 * `meta.counts` holds the per-state totals across the whole collection, for the
 * queue's tabs and the dashboard card; `meta.products` maps each product id on
 * the page to its name, so the screen does not need the whole catalogue.
 */
export const prerender = false;

export const GET: APIRoute = async ({ url, locals }) => {
  try {
    if (!locals.user) return ApiResponseBuilder.unauthorized();
    if (!canManageCatalog(locals.user.role)) {
      return ApiResponseBuilder.forbidden('You do not have permission to moderate reviews');
    }
    await LocalDB.init();
    const rows = await LocalDB.getCustomEntities(REVIEWS_TYPE) as ReviewRow[];
    const q = parseAdminReviewQuery(new URL(url).searchParams);
    const { total, items } = adminReviewList(rows, q);

    const products: Record<string, string> = {};
    for (const id of new Set(items.map((r) => String(r.data?.product_id ?? '')).filter(Boolean))) {
      const p = await LocalDB.getProduct(id).catch(() => undefined);
      products[id] = p?.name ?? '';
    }

    return ApiResponseBuilder.success(items, 'Reviews retrieved', {
      total,
      count: items.length,
      limit: q.limit,
      offset: q.offset,
      status: q.status,
      counts: reviewStatusCounts(rows),
      products,
    });
  } catch (err) {
    console.error('Review queue read error:', err);
    return ApiResponseBuilder.serverError('Could not read the reviews');
  }
};
