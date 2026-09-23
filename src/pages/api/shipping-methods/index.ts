import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { normalizeShippingMethod } from '../../../lib/commerce/admin-normalize';

/**
 * GET  /api/shipping-methods — public. A storefront must render the choices,
 *      and a rate is not a secret: the customer is about to be quoted it.
 * POST /api/shipping-methods — admin. Rates decide what money is taken.
 */
export const GET: APIRoute = async () => {
  try {
    await LocalDB.init();
    const methods = await LocalDB.getShippingMethods();
    const sorted = [...methods].sort(
      (a, b) => (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER),
    );
    return ApiResponseBuilder.success(sorted, undefined, { total: sorted.length });
  } catch (err) {
    console.error('Shipping methods list error:', err);
    return ApiResponseBuilder.serverError('Failed to list shipping methods');
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    await LocalDB.init();
    if (locals.user?.role !== 'admin') return ApiResponseBuilder.forbidden('Admin only');
    const body = await request.json().catch(() => null);
    const parsed = normalizeShippingMethod(body);
    if (!parsed.ok) return ApiResponseBuilder.badRequest(parsed.error);
    const created = await LocalDB.createShippingMethod(parsed.value as any);
    return ApiResponseBuilder.created(created, 'Shipping method created');
  } catch (err) {
    console.error('Shipping method create error:', err);
    return ApiResponseBuilder.serverError('Failed to create shipping method');
  }
};
