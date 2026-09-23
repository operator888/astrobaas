import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { normalizeShippingMethod } from '../../../lib/commerce/admin-normalize';

export const PUT: APIRoute = async ({ params, request, locals }) => {
  try {
    await LocalDB.init();
    if (locals.user?.role !== 'admin') return ApiResponseBuilder.forbidden('Admin only');
    const body = await request.json().catch(() => null);
    const parsed = normalizeShippingMethod(body, { partial: true });
    if (!parsed.ok) return ApiResponseBuilder.badRequest(parsed.error);
    const updated = await LocalDB.updateShippingMethod(params.id!, parsed.value as any);
    if (!updated) return ApiResponseBuilder.notFound('Shipping method');
    return ApiResponseBuilder.success(updated, 'Shipping method updated');
  } catch (err) {
    console.error('Shipping method update error:', err);
    return ApiResponseBuilder.serverError('Failed to update shipping method');
  }
};

export const DELETE: APIRoute = async ({ params, locals }) => {
  try {
    await LocalDB.init();
    if (locals.user?.role !== 'admin') return ApiResponseBuilder.forbidden('Admin only');
    const ok = await LocalDB.deleteShippingMethod(params.id!);
    if (!ok) return ApiResponseBuilder.notFound('Shipping method');
    return ApiResponseBuilder.deleted('Shipping method deleted');
  } catch (err) {
    console.error('Shipping method delete error:', err);
    return ApiResponseBuilder.serverError('Failed to delete shipping method');
  }
};
