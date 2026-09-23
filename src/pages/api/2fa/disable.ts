import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { checkSecondFactor } from '../../../lib/twofactor';
import { recordAudit, AUDIT } from '../../../lib/audit';

// Turn 2FA off. Requires proof-of-possession — a current TOTP code or an unused
// backup code — so a hijacked (but 2FA-protected) session can't silently strip
// the second factor. Requires a session + CSRF.
export const POST: APIRoute = async ({ request, locals }) => {
  try {
    await LocalDB.init();
    const session = locals.user;
    if (!session) return ApiResponseBuilder.unauthorized();

    const body = await request.json().catch(() => null);
    const code = String((body as any)?.code ?? '').trim();

    const user = await LocalDB.getUser(session.id);
    if (!user) return ApiResponseBuilder.unauthorized();
    if (!user.two_factor?.enabled) {
      return ApiResponseBuilder.badRequest('Two-factor is not enabled.');
    }

    const chk = checkSecondFactor(user.two_factor, code);
    if (!chk.ok) {
      recordAudit(AUDIT.TWOFA_FAILED, { actor: user.id, ip: locals.ip, metadata: { phase: 'disable' } });
      return ApiResponseBuilder.badRequest('Invalid code. A current authenticator code or a backup code is required to disable 2FA.');
    }

    // Clear the whole 2FA config.
    await LocalDB.updateUser(user.id, { two_factor: undefined });
    recordAudit(AUDIT.TWOFA_DISABLED, { actor: user.id, ip: locals.ip });

    return ApiResponseBuilder.success({ enabled: false }, 'Two-factor disabled.');
  } catch (err) {
    console.error('2FA disable error:', err);
    return ApiResponseBuilder.serverError('Could not disable two-factor');
  }
};
