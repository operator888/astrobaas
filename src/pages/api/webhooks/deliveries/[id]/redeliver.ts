import type { APIRoute } from 'astro';
import { LocalDB } from '../../../../../lib/localdb';
import { ApiResponseBuilder } from '../../../../../lib/api-response';
import { redeliver } from '../../../../../lib/webhooks';

// Admin-only. Re-send a recorded delivery (the exact stored, signed payload) to
// its webhook as a new delivery-log entry. Useful when a receiver was down or a
// retry chain was lost on restart.
//   POST /api/webhooks/deliveries/{id}/redeliver
export const POST: APIRoute = async ({ params, locals }) => {
  try {
    await LocalDB.init();
    const session = locals.user;
    if (!session || session.role !== 'admin') return ApiResponseBuilder.forbidden('Admin only');
    const result = await redeliver(String(params.id));
    if (!result) return ApiResponseBuilder.notFound('Delivery');
    return ApiResponseBuilder.success(result, 'Webhook redelivery attempted');
  } catch (err) {
    console.error('Webhook redeliver error:', err);
    return ApiResponseBuilder.serverError('Failed to redeliver webhook');
  }
};
