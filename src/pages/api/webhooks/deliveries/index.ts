import type { APIRoute } from 'astro';
import { LocalDB } from '../../../../lib/localdb';
import { ApiResponseBuilder } from '../../../../lib/api-response';

// Admin-only. List recent webhook deliveries (the attempt-tracked log), most
// recent first. Filter with ?webhook=<id> and cap with ?limit=.
//   GET /api/webhooks/deliveries
export const GET: APIRoute = async ({ url, locals }) => {
  try {
    await LocalDB.init();
    const session = locals.user;
    if (!session || session.role !== 'admin') return ApiResponseBuilder.forbidden('Admin only');
    const sp = new URL(url).searchParams;
    const webhookId = sp.get('webhook') || undefined;
    const limitRaw = sp.get('limit');
    const limit = limitRaw ? Math.min(parseInt(limitRaw, 10) || 0, 500) : 100;
    const deliveries = await LocalDB.getWebhookDeliveries({ webhookId, limit });
    return ApiResponseBuilder.success(deliveries, 'Webhook deliveries retrieved');
  } catch (err) {
    console.error('Webhook deliveries list error:', err);
    return ApiResponseBuilder.serverError('Failed to fetch webhook deliveries');
  }
};
