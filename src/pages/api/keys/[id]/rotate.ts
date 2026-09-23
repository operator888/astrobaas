import type { APIRoute } from 'astro';
import { LocalDB } from '../../../../lib/localdb';
import { ApiResponseBuilder } from '../../../../lib/api-response';
import { generateApiKey } from '../../../../lib/auth';
import { recordAudit, AUDIT } from '../../../../lib/audit';

// Admin-only. Rotate an API key's secret in place: the id, name, role, scopes,
// and expiry are preserved, but a fresh secret is issued and the old one stops
// working immediately. The new plaintext secret is returned ONCE.
//   POST /api/keys/{id}/rotate
export const POST: APIRoute = async ({ params, locals }) => {
  try {
    await LocalDB.init();
    const session = locals.user;
    if (!session || session.role !== 'admin') return ApiResponseBuilder.forbidden('Admin only');

    const id = String(params.id);
    const keys = await LocalDB.getApiKeys();
    if (!keys.some(k => k.id === id)) return ApiResponseBuilder.notFound('API key');

    const { key, prefix, hash } = generateApiKey();
    // Reset last_used too — the new secret has no usage history.
    const updated = await LocalDB.updateApiKey(id, { key_hash: hash, prefix, last_used: undefined });
    if (!updated) return ApiResponseBuilder.notFound('API key');
    recordAudit(AUDIT.APIKEY_ROTATE, { actor: session.id, target: id, ip: locals.ip });

    return ApiResponseBuilder.success(
      { id: updated.id, name: updated.name, role: updated.role, prefix: updated.prefix, key },
      'API key rotated — copy the new secret now; the old one no longer works.',
    );
  } catch (err) {
    console.error('API key rotate error:', err);
    return ApiResponseBuilder.serverError('Failed to rotate API key');
  }
};
