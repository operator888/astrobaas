import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { generateTotpSecret, otpauthUri } from '../../../lib/totp';
import { emailChannelActive } from '../../../lib/email';

// Begin TOTP enrollment: generate a fresh (unconfirmed) secret for the signed-in
// user and return it + an otpauth URI for the authenticator app. The secret is
// stored with enabled:false — 2FA only turns on once the user confirms a code
// via /api/2fa/enable. Requires a session + CSRF (enforced by middleware).
export const POST: APIRoute = async ({ locals }) => {
  try {
    await LocalDB.init();
    const session = locals.user;
    if (!session) return ApiResponseBuilder.unauthorized();

    const user = await LocalDB.getUser(session.id);
    if (!user) return ApiResponseBuilder.unauthorized();
    if (user.two_factor?.enabled) {
      return ApiResponseBuilder.badRequest('Two-factor is already enabled. Disable it first to re-enroll.');
    }

    // 2FA enrollment requires a working email channel FIRST. The lockout
    // story is why: backup codes get lost with the same phone the app was
    // on, and then email is the recovery path. Offering 2FA on an install
    // that cannot send email is offering a door that locks from both sides.
    if (!emailChannelActive()) {
      return ApiResponseBuilder.badRequest(
        'Two-factor needs a working email channel first (for account recovery). '
        + 'Configure email — for example the SMTP2GO plugin — and try again.',
      );
    }

    const secret = generateTotpSecret();
    await LocalDB.updateUser(user.id, { two_factor: { enabled: false, secret, backup_codes: [] } });

    return ApiResponseBuilder.success(
      {
        secret,
        otpauth_uri: otpauthUri(secret, { label: user.email, issuer: 'AstroBaaS' }),
      },
      'Scan the QR / enter the secret in your authenticator app, then confirm a code to enable.',
    );
  } catch (err) {
    console.error('2FA setup error:', err);
    return ApiResponseBuilder.serverError('Could not start two-factor setup');
  }
};
