import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { normalizeCoupon } from '../../../lib/commerce/admin-normalize';

/**
 * Coupons are STAFF-ONLY to list.
 *
 * Unlike shipping methods, the set of live discount codes is exactly the thing
 * an attacker wants: publishing it hands out every promotion, including the
 * ones meant for one customer. A shopper validates a code they already know by
 * quoting a basket with it, which reveals nothing they did not already have.
 */
export const GET: APIRoute = async ({ locals }) => {
  try {
    await LocalDB.init();
    const role = locals.user?.role;
    if (role !== 'admin' && role !== 'editor') {
      return ApiResponseBuilder.forbidden('Only staff can list coupons');
    }
    const coupons = await LocalDB.getCoupons();
    return ApiResponseBuilder.success(coupons, undefined, { total: coupons.length });
  } catch (err) {
    console.error('Coupons list error:', err);
    return ApiResponseBuilder.serverError('Failed to list coupons');
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    await LocalDB.init();
    if (locals.user?.role !== 'admin') return ApiResponseBuilder.forbidden('Admin only');
    const body = await request.json().catch(() => null);
    const parsed = normalizeCoupon(body);
    if (!parsed.ok) return ApiResponseBuilder.badRequest(parsed.error);

    const existing = await LocalDB.getCoupons();
    if (existing.some((c) => c.code === (parsed.value as any).code)) {
      return ApiResponseBuilder.badRequest('A coupon with that code already exists');
    }
    const created = await LocalDB.createCoupon(parsed.value as any);
    return ApiResponseBuilder.created(created, 'Coupon created');
  } catch (err) {
    console.error('Coupon create error:', err);
    return ApiResponseBuilder.serverError('Failed to create coupon');
  }
};
