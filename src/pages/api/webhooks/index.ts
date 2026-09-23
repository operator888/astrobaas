import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { validate } from '../../../lib/validate';
import { newWebhookSecret } from '../../../lib/auth';
import { recordAudit, AUDIT } from '../../../lib/audit';
import { checkWebhookUrl } from '../../../lib/url-guard';

// Admin-only management of outbound webhooks.
// GET  /api/webhooks  → list (metadata only; never the signing secret)
// POST /api/webhooks  → register; the secret is returned ONCE here.

export const GET: APIRoute = async ({ locals }) => {
  try {
    await LocalDB.init();
    const session = locals.user;
    if (!session || session.role !== 'admin') return ApiResponseBuilder.forbidden('Admin only');
    const hooks = await LocalDB.getWebhooks();
    // Strip the signing secret; expose only safe metadata.
    const safe = hooks.map(({ secret, ...rest }) => rest);
    return ApiResponseBuilder.success(safe, 'Webhooks retrieved');
  } catch (err) {
    console.error('Webhooks list error:', err);
    return ApiResponseBuilder.serverError('Failed to fetch webhooks');
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    await LocalDB.init();
    const session = locals.user;
    if (!session || session.role !== 'admin') return ApiResponseBuilder.forbidden('Admin only');

    const body = await request.json().catch(() => null);
    const result = validate<{ url: string; events: string[]; active?: boolean }>(body, {
      url: { type: 'string', min: 8, max: 500, pattern: /^https?:\/\/.+/ },
      events: { type: 'array', of: 'string', max: 50 },
      active: { type: 'boolean', optional: true },
    });
    if (!result.ok) return ApiResponseBuilder.validationError('Invalid webhook payload', result.errors);
    if (result.value.events.length < 1) {
      return ApiResponseBuilder.validationError('Invalid webhook payload', {
        events: 'at least one event is required (use "*" for all)',
      });
    }

    // SSRF guard: refuse private/internal delivery targets (localhost, RFC-1918,
    // link-local/cloud-metadata, ULA…) unless WEBHOOK_ALLOW_PRIVATE=1. Without
    // this the server becomes an internal port-scanner whose delivery log even
    // reports status codes back to the caller.
    const guard = checkWebhookUrl(result.value.url);
    if (!guard.ok) {
      return ApiResponseBuilder.validationError('Invalid webhook payload', { url: guard.reason });
    }

    const secret = newWebhookSecret();
    const rec = await LocalDB.createWebhook({
      url: result.value.url,
      events: result.value.events,
      secret,
      active: result.value.active ?? true,
    });
    if (!rec) return ApiResponseBuilder.serverError('Could not register webhook');
    recordAudit(AUDIT.WEBHOOK_CREATE, { actor: session.id, target: rec.id, ip: locals.ip, metadata: { url: rec.url, events: rec.events } });
    // The signing secret is returned ONCE — store it on the receiver to verify
    // the X-AstroBaaS-Signature header.
    return ApiResponseBuilder.created(
      { id: rec.id, url: rec.url, events: rec.events, active: rec.active, secret },
      'Webhook registered — copy the secret now; it will not be shown again.',
    );
  } catch (err) {
    console.error('Webhook create error:', err);
    return ApiResponseBuilder.serverError('Failed to register webhook');
  }
};
