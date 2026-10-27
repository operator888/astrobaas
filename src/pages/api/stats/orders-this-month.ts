import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { settingsMap, settingBool } from '../../../lib/settings-map';
import { resolveCommerceEnabled } from '../../../lib/commerce-settings';
import {
  PUBLIC_ORDER_STATS_KEY, resolveShopTimeZone, paidOrdersThisMonth, monthInZone,
} from '../../../lib/commerce/order-stats';

/**
 * GET /api/stats/orders-this-month → `{ success, data: { count, month } }`
 *
 * "N orders this month" for a storefront's social proof. OFF unless the
 * operator turns on `public_order_stats_enabled`; while off — or while the shop
 * itself is off — the answer is the same 404 an unknown path gets, so the
 * endpoint does not even reveal that the switch exists.
 *
 * Public when on (it is a number the operator chose to publish); a SCOPED API
 * key needs `stats:read`. Paid orders only, counted by the month they were
 * placed in the shop's timezone — see lib/commerce/order-stats.ts. Never an
 * amount, never anything per order or customer.
 *
 * ## Cached for a minute, two ways
 *
 * The body is identical for every caller, so — unlike the catalogue reads,
 * which differ for staff — it may be shared: `Cache-Control: public,
 * max-age=60`. And the count itself is memoised in-process for the same
 * minute, because a storefront renders it on every page and each miss reads
 * the whole order book. A new paid order shows up within a minute.
 */
export const prerender = false;

const CACHE_SECONDS = 60;

let memo: { key: string; at: number; value: { count: number; month: string } } | null = null;

/** Same body as the catch-all's 404, so "switched off" and "does not exist" look alike. */
function notFound(): Response {
  return new Response(
    JSON.stringify({ success: false, error: { message: 'Not found', code: 'NOT_FOUND' } }),
    { status: 404, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } },
  );
}

export const GET: APIRoute = async () => {
  try {
    await LocalDB.init();
    const settings = settingsMap(await LocalDB.getSettings());
    if (!settingBool(settings[PUBLIC_ORDER_STATS_KEY], false)) return notFound();
    if (!resolveCommerceEnabled(settings)) return notFound();

    const tz = resolveShopTimeZone(settings);
    const now = Date.now();
    // Keyed on the zone AND the current month, so a memo taken at 23:59:30 on
    // the 31st is never served as next month's count.
    const key = `${tz}|${monthInZone(now, tz)}`;
    let value: { count: number; month: string };
    if (memo && memo.key === key && now - memo.at < CACHE_SECONDS * 1000) {
      value = memo.value;
    } else {
      value = paidOrdersThisMonth(await LocalDB.getOrders(), now, tz);
      memo = { key, at: now, value };
    }

    return new Response(JSON.stringify({ success: true, data: { count: value.count, month: value.month } }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': `public, max-age=${CACHE_SECONDS}, s-maxage=${CACHE_SECONDS}`,
      },
    });
  } catch (err) {
    console.error('Order stats error:', err);
    return new Response(
      JSON.stringify({ success: false, error: { message: 'Could not read order stats', code: 'SERVER_ERROR' } }),
      { status: 500, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } },
    );
  }
};
