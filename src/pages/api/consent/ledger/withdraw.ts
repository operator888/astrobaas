import type { APIRoute } from 'astro';
import { ApiResponseBuilder } from '../../../../lib/api-response';
import { recordAudit, AUDIT } from '../../../../lib/audit';
import { withdrawConsent, consentStateFor } from '../../../../lib/consent-service';
import { ConsentInputError } from '../../../../lib/consent-ledger';

/**
 * Withdraw a person's consent, as the operator — `POST { email, purpose }`.
 *
 * For the phone call or the reply that says "stop": it APPENDS a withdrawal
 * row (`source: 'admin'`); it never edits or removes what was recorded before.
 * For `newsletter` the address also leaves the list and the ESP is told.
 *
 * Admin only, session-authenticated, and never in the public-write or
 * CSRF-exempt lists: it takes an address, so unguarded it would let anyone
 * withdraw anyone. The public way is `/api/consent/withdraw`, which needs a
 * signed token only the person was sent. Audited.
 */
export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    if (!locals.user) return ApiResponseBuilder.unauthorized();
    if (locals.user.role !== 'admin') {
      return ApiResponseBuilder.forbidden('Only an administrator can withdraw consent');
    }
    const body = await request.json().catch(() => null) as { email?: unknown; purpose?: unknown } | null;
    try {
      await withdrawConsent({ email: String(body?.email ?? ''), purpose: String(body?.purpose ?? ''), source: 'admin' });
    } catch (err) {
      if (err instanceof ConsentInputError) return ApiResponseBuilder.badRequest(err.message);
      throw err;
    }
    const state = await consentStateFor(String(body?.email ?? ''), String(body?.purpose ?? ''));
    recordAudit(AUDIT.CONSENT_WITHDRAW, {
      actor: locals.user.id,
      target: String(body?.email ?? '').trim().toLowerCase(),
      metadata: { purpose: String(body?.purpose ?? '') },
    });
    return ApiResponseBuilder.success({ purpose: String(body?.purpose ?? ''), withdrawn: state.withdrawn }, 'Consent withdrawn');
  } catch (err) {
    console.error('Consent withdraw (admin) error:', err);
    return ApiResponseBuilder.serverError('Could not withdraw the consent');
  }
};
