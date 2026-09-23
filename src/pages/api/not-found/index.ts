import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { canManageCatalog } from '../../../lib/auth';
import { sortRecords, type NotFoundSort } from '../../../lib/legacy/not-found-log';
import { flushCounters } from '../../../lib/legacy/redirect-store';

/**
 * GET /api/not-found — which dead URLs are costing the shop money.
 *
 * Sorted by PAID hits by default, because that is the question a shop has.
 * Ordering by raw count puts a crawler hammering one bad path above a Shopping
 * URL that lost twelve real buyers.
 */
export const prerender = false;

export const GET: APIRoute = async ({ url, locals }) => {
  try {
    if (!canManageCatalog(locals.user?.role)) {
      return ApiResponseBuilder.forbidden('Your role cannot see the 404 report');
    }
    await LocalDB.init();
    // Counters are buffered and flushed on a timer, so a report opened
    // immediately after a hit would otherwise be missing it — and the operator
    // would conclude the logging does not work.
    await flushCounters();

    const records = await LocalDB.getNotFound();
    const sortParam = String(url.searchParams.get('sort') ?? 'paid');
    const sort: NotFoundSort =
      sortParam === 'hits' || sortParam === 'recent' ? sortParam : 'paid';
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 50) || 50, 1), 500);

    const sorted = sortRecords(records, sort);
    const paidTotal = records.reduce((n, r) => n + r.paid_hits, 0);

    return ApiResponseBuilder.success(sorted.slice(0, limit), undefined, {
      total: records.length,
      total_hits: records.reduce((n, r) => n + r.hits, 0),
      // The headline number: requests that arrived with ad money behind them.
      total_paid_hits: paidTotal,
      sort,
    });
  } catch (err) {
    console.error('404 report error:', err);
    return ApiResponseBuilder.serverError('Failed to load the 404 report');
  }
};

/** DELETE /api/not-found — clear the log, e.g. after a round of fixes. */
export const DELETE: APIRoute = async ({ locals }) => {
  try {
    if (!canManageCatalog(locals.user?.role)) {
      return ApiResponseBuilder.forbidden('Your role cannot clear the 404 report');
    }
    await LocalDB.init();
    await LocalDB.putNotFound([]);
    return ApiResponseBuilder.success({ cleared: true }, '404 report cleared');
  } catch (err) {
    console.error('404 clear error:', err);
    return ApiResponseBuilder.serverError('Failed to clear the 404 report');
  }
};
