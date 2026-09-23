import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { recordAudit, AUDIT } from '../../../lib/audit';

// Admin-only. Unregister (delete) a webhook by id.
export const DELETE: APIRoute = async ({ params, locals }) => {
  try {
    await LocalDB.init();
    const session = locals.user;
    if (!session || session.role !== 'admin') return ApiResponseBuilder.forbidden('Admin only');
    const ok = await LocalDB.deleteWebhook(String(params.id));
    if (!ok) return ApiResponseBuilder.notFound('Webhook');
    recordAudit(AUDIT.WEBHOOK_DELETE, { actor: session.id, target: String(params.id), ip: locals.ip });
    return ApiResponseBuilder.deleted();
  } catch (err) {
    console.error('Webhook delete error:', err);
    return ApiResponseBuilder.serverError('Failed to delete webhook');
  }
};
