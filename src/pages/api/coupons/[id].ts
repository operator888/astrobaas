import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { normalizeCoupon } from '../../../lib/commerce/admin-normalize';

export const PUT: APIRoute = async ({ params, request, locals }) => {
  try {
    await LocalDB.init();
    if (locals.user?.role !== 'admin') return ApiResponseBuilder.forbidden('Admin only');
    const body = await request.json().catch(() => null);
    const parsed = normalizeCoupon(body, { partial: true });
    if (!parsed.ok) return ApiResponseBuilder.badRequest(parsed.error);
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
