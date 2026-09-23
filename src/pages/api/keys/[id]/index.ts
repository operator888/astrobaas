import type { APIRoute } from 'astro';
import { LocalDB } from '../../../../lib/localdb';
import { ApiResponseBuilder } from '../../../../lib/api-response';
import { validate } from '../../../../lib/validate';
import { recordAudit, AUDIT } from '../../../../lib/audit';

// Admin-only. Revoke (delete) an API key by id.
export const DELETE: APIRoute = async ({ params, locals }) => {
  try {
    await LocalDB.init();
    const session = locals.user;
    if (!session || session.role !== 'admin') return ApiResponseBuilder.forbidden('Admin only');
    const ok = await LocalDB.deleteApiKey(String(params.id));
    if (!ok) return ApiResponseBuilder.notFound('API key');
    recordAudit(AUDIT.APIKEY_REVOKE, { actor: session.id, target: String(params.id), ip: locals.ip });
    return ApiResponseBuilder.deleted();
  } catch (err) {
    console.error('API key delete error:', err);
    return ApiResponseBuilder.serverError('Failed to revoke API key');
  }
};

/**
 * PATCH /api/keys/{id}  { forward_client_ip: boolean }   — admin only.
 *
 * Turns trusted client-IP forwarding (S3.6) on or off for a key that already
 * exists. Both live storefronts already hold a key in their server's
 * environment; making them rotate it — and redeploy — just to opt in would be
 * the kind of friction that keeps a safety feature switched off.
 *
 * Deliberately the ONLY field this accepts. Role and scopes change what a key
 * may do, and changing those in place is a different decision (mint a new key,
 * revoke the old one) with its own audit trail.
 */
export const PATCH: APIRoute = async ({ params, request, locals }) => {
  try {
    await LocalDB.init();
    const session = locals.user;
    if (!session || session.role !== 'admin') return ApiResponseBuilder.forbidden('Admin only');

    const body = await request.json().catch(() => null);
    const result = validate<{ forward_client_ip: boolean }>(body, {
      forward_client_ip: { type: 'boolean' },
    });
    if (!result.ok) return ApiResponseBuilder.validationError('Invalid payload', result.errors);

    const id = String(params.id);
    const updated = await LocalDB.updateApiKey(id, { forward_client_ip: result.value.forward_client_ip });
    if (!updated) return ApiResponseBuilder.notFound('API key');
    // Granting a key the right to name its callers' addresses is a trust
    // decision, so it is audited like minting one.
    recordAudit(AUDIT.APIKEY_UPDATE, {
      actor: session.id, target: id, ip: locals.ip,
      metadata: { change: 'forward_client_ip', value: updated.forward_client_ip === true },
    });
    const { key_hash, ...safe } = updated;
    void key_hash;
    return ApiResponseBuilder.success(
      { ...safe, forward_client_ip: updated.forward_client_ip === true },
      'API key updated',
    );
  } catch (err) {
    console.error('API key update error:', err);
    return ApiResponseBuilder.serverError('Failed to update API key');
  }
};
