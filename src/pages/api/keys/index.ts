import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { validate } from '../../../lib/validate';
import { generateApiKey } from '../../../lib/auth';
import { isValidScope, SCOPE_FORMAT_HINT } from '../../../lib/api-key-scopes';
import { recordAudit, AUDIT } from '../../../lib/audit';
import { ROLES } from '../../../core/models';

// Admin-only management of API keys for headless / cross-origin / agent access.
// GET  /api/keys  → list (metadata only; never the secret)
// POST /api/keys  → mint a key; the full secret is returned ONCE here.

export const GET: APIRoute = async ({ locals }) => {
  try {
    await LocalDB.init();
    const session = locals.user;
    if (!session || session.role !== 'admin') return ApiResponseBuilder.forbidden('Admin only');
    const keys = await LocalDB.getApiKeys();
    // Strip the hash; expose only safe metadata.
    const safe = keys.map(({ key_hash, ...rest }) => rest);
    return ApiResponseBuilder.success(safe, 'API keys retrieved');
  } catch (err) {
    console.error('API keys list error:', err);
    return ApiResponseBuilder.serverError('Failed to fetch API keys');
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    await LocalDB.init();
    const session = locals.user;
    if (!session || session.role !== 'admin') return ApiResponseBuilder.forbidden('Admin only');

    const body = await request.json().catch(() => null);
    const result = validate<{
      name: string;
      role?: 'admin' | 'editor' | 'author' | 'viewer';
      scopes?: string[];
      expires_in_days?: number;
      forward_client_ip?: boolean;
    }>(body, {
      name: { type: 'string', min: 1, max: 100 },
      role: { type: 'enum', values: ROLES as unknown as string[], optional: true },
      scopes: { type: 'array', of: 'string', max: 20, optional: true },
      expires_in_days: { type: 'number', int: true, min: 1, max: 3650, optional: true },
      // S3.6: this key's server may name the shopper it is calling for. The
      // route is admin-only above, so only an admin can grant that trust.
      forward_client_ip: { type: 'boolean', optional: true },
    });
    if (!result.ok) return ApiResponseBuilder.validationError('Invalid payload', result.errors);

    // Validate each scope token against the known vocabulary (resource:action).
    const scopes = result.value.scopes;
    if (scopes && scopes.some(s => !isValidScope(s))) {
      return ApiResponseBuilder.validationError('Invalid payload', {
        // Built from the same list the validator is (S3.12) — it used to name
        // three of the seven resources a key can be scoped to.
        scopes: SCOPE_FORMAT_HINT,
      });
    }

    const expires_at = result.value.expires_in_days
      ? new Date(Date.now() + result.value.expires_in_days * 86_400_000).toISOString()
      : undefined;
    const forward = result.value.forward_client_ip === true;

    const { key, prefix, hash } = generateApiKey();
    const rec = await LocalDB.createApiKey({
      name: result.value.name,
      prefix,
      key_hash: hash,
      role: result.value.role ?? 'editor',
      ...(scopes && scopes.length ? { scopes } : {}),
      ...(expires_at ? { expires_at } : {}),
      ...(forward ? { forward_client_ip: true } : {}),
    });
    if (!rec) return ApiResponseBuilder.serverError('Could not create key');
    recordAudit(AUDIT.APIKEY_CREATE, {
      actor: session.id, target: rec.id, ip: locals.ip,
      metadata: { name: rec.name, role: rec.role, scopes: rec.scopes ?? null, forward_client_ip: rec.forward_client_ip === true },
    });
    // The plaintext key is returned ONCE — it is never recoverable afterwards.
    return ApiResponseBuilder.created(
      {
        id: rec.id, name: rec.name, role: rec.role, scopes: rec.scopes ?? null,
        expires_at: rec.expires_at ?? null, forward_client_ip: rec.forward_client_ip === true,
        prefix: rec.prefix, key,
      },
      'API key created — copy it now; it will not be shown again.',
    );
  } catch (err) {
    console.error('API key create error:', err);
    return ApiResponseBuilder.serverError('Failed to create API key');
  }
};
