import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { normalizeCoupon, checkCouponRecord } from '../../../lib/commerce/admin-normalize';
import { checkGiftProduct } from '../../../lib/commerce/coupon-service';
import { normalizeCouponCode } from '../../../lib/commerce/coupons';

export const PUT: APIRoute = async ({ params, request, locals }) => {
  try {
    await LocalDB.init();
    if (locals.user?.role !== 'admin') return ApiResponseBuilder.forbidden('Admin only');
    const body = await request.json().catch(() => null);
    const all = await LocalDB.getCoupons();
    const current = all.find((c) => c.id === params.id);
    if (!current) return ApiResponseBuilder.notFound('Coupon');
    // The stored kind, so a value-only edit is bounded as what it is (cents
    // for a fixed coupon, not basis points).
    const parsed = normalizeCoupon(body, { partial: true, kind: current.kind });
    if (!parsed.ok) return ApiResponseBuilder.badRequest(parsed.error);

    // An admin switching a REVOKED coupon back on means it: the revocation is
    // a plugin's, and the shop's own decision overrides it. Without this the
    // switch saved and changed nothing (applyCoupon refuses on revoked_at).
    if (parsed.value.enabled === true && current.revoked_at) parsed.value.revoked_at = null;

    // A partial edit is checked as the WHOLE coupon it produces: changing the
    // kind to gift_product without a gift, or moving ends_at before the stored
    // starts_at, is only visible once merged with what is stored.
    const merged = { ...current, ...parsed.value };
    const whole = checkCouponRecord(merged) ?? await checkGiftProduct(merged);
    if (whole) return ApiResponseBuilder.badRequest(whole);
    if (parsed.value.code && all.some((c) => c.id !== current.id && normalizeCouponCode(c.code) === parsed.value.code)) {
      return ApiResponseBuilder.badRequest('A coupon with that code already exists');
    }

    const updated = await LocalDB.updateCoupon(params.id!, parsed.value as any);
    if (!updated) return ApiResponseBuilder.notFound('Coupon');
    return ApiResponseBuilder.success(updated, 'Coupon updated');
  } catch (err) {
    console.error('Coupon update error:', err);
    return ApiResponseBuilder.serverError('Failed to update coupon');
  }
};

export const DELETE: APIRoute = async ({ params, locals }) => {
  try {
    await LocalDB.init();
    if (locals.user?.role !== 'admin') return ApiResponseBuilder.forbidden('Admin only');
    const ok = await LocalDB.deleteCoupon(params.id!);
    if (!ok) return ApiResponseBuilder.notFound('Coupon');
    return ApiResponseBuilder.deleted('Coupon deleted');
  } catch (err) {
    console.error('Coupon delete error:', err);
    return ApiResponseBuilder.serverError('Failed to delete coupon');
  }
};
