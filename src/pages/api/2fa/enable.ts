import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { verifyTotp } from '../../../lib/totp';
import { generateBackupCodes } from '../../../lib/twofactor';
import { recordAudit, AUDIT } from '../../../lib/audit';

// Confirm TOTP enrollment: verify a code against the pending secret from
// /api/2fa/setup, then turn 2FA on and return one-time backup codes (shown
// once). Requires a session + CSRF.
export const POST: APIRoute = async ({ request, locals }) => {
  try {
    await LocalDB.init();
    const session = locals.user;
    if (!session) return ApiResponseBuilder.unauthorized();

    const body = await request.json().catch(() => null);
    const code = String((body as any)?.code ?? '').trim();

    const user = await LocalDB.getUser(session.id);
    if (!user) return ApiResponseBuilder.unauthorized();
    if (!user.two_factor || !user.two_factor.secret) {
      return ApiResponseBuilder.badRequest('No pending two-factor setup. Call /api/2fa/setup first.');
    }
    if (user.two_factor.enabled) {
      return ApiResponseBuilder.badRequest('Two-factor is already enabled.');
    }
    if (!verifyTotp(user.two_factor.secret, code)) {
      recordAudit(AUDIT.TWOFA_FAILED, { actor: user.id, ip: locals.ip, metadata: { phase: 'enable' } });
      return ApiResponseBuilder.badRequest('Invalid code. Check your authenticator app and try again.');
    }

    const { plain, hashed } = generateBackupCodes();
    await LocalDB.updateUser(user.id, {
      two_factor: { enabled: true, secret: user.two_factor.secret, backup_codes: hashed, enrolled_at: new Date().toISOString() },
    });
    recordAudit(AUDIT.TWOFA_ENABLED, { actor: user.id, ip: locals.ip });

    return ApiResponseBuilder.success(
      { enabled: true, backup_codes: plain },
      'Two-factor enabled. Save these backup codes somewhere safe — they are shown only once and each works once.',
    );
  } catch (err) {
    console.error('2FA enable error:', err);
    return ApiResponseBuilder.serverError('Could not enable two-factor');
  }
};
