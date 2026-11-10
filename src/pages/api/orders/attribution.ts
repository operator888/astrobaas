import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { canReadCommerce } from '../../../lib/auth';
import { toCsv } from '../../../lib/csv';
import { moneyPlain } from '../../../lib/money-format';
import {
  attributionReport, parseReportQuery, ATTRIBUTION_CSV_COLUMNS, NOT_SET,
} from '../../../lib/commerce/attribution';

/**
 * `GET /api/orders/attribution` — paid orders and revenue by campaign source,
 * medium and campaign over a date range (commerce/attribution.ts). Staff only:
 * it is built from orders, which are never public.
 *
 *   ?from=YYYY-MM-DD&to=YYYY-MM-DD   inclusive UTC days; default the last 30
 *   &model=first|last                which touch gets the credit; default last
 *   &format=csv                      a spreadsheet instead of JSON
 *
 * A static route beside `/api/orders/[id]`; Astro matches it first, as it does
 * `/api/orders/tags`.
 */
export const prerender = false;

export const GET: APIRoute = async ({ url, locals }) => {
  try {
    const user = locals.user;
    if (!user) return ApiResponseBuilder.unauthorized();
    if (!canReadCommerce(user.role)) return ApiResponseBuilder.forbidden('Your role cannot view orders');
    const q = parseReportQuery(url.searchParams, Date.now());
    if (!q.ok) return ApiResponseBuilder.badRequest(q.error);
    const format = (url.searchParams.get('format') || 'json').trim().toLowerCase();
    if (format !== 'json' && format !== 'csv') return ApiResponseBuilder.badRequest('"format" must be "json" or "csv"');

    await LocalDB.init();
    const report = attributionReport(await LocalDB.getOrders(), q.value);

    if (format === 'csv') {
      const base = { model: report.model, from: report.from, to: report.to };
      const rows: Record<string, unknown>[] = report.rows.map((r) => ({
        ...base, source: r.source, medium: r.medium, campaign: r.campaign,
        orders: r.orders, revenue: moneyPlain(r.revenue_cents, r.currency), currency: r.currency,
      }));
      // The orders nothing can be said about, as their own rows, so the CSV's
      // totals agree with the screen's.
      for (const [currency, cents] of Object.entries(report.unattributed_revenue)) {
        rows.push({
          ...base, source: '(no attribution)', medium: NOT_SET, campaign: NOT_SET,
          orders: null, revenue: moneyPlain(cents, currency), currency,
        });
      }
      // The unattributed count is per range, not per currency; put it on the
      // first such row so it is counted once.
      const firstNone = rows.find((r) => r.source === '(no attribution)');
      if (firstNone) firstNone.orders = report.unattributed;
      const name = `attribution-${report.model}-${report.from}-to-${report.to}.csv`;
      return new Response(toCsv(ATTRIBUTION_CSV_COLUMNS, rows), {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${name}"`,
          'Cache-Control': 'no-store',
        },
      });
    }
    return ApiResponseBuilder.success(report);
  } catch (err) {
    console.error('Attribution report error:', err);
    return ApiResponseBuilder.serverError('Failed to build the attribution report');
  }
};
