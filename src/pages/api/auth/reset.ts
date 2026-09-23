import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { validate } from '../../../lib/validate';
import { hashPassword, readResetTokenUid, verifyResetToken } from '../../../lib/auth';
import { recordAudit, AUDIT } from '../../../lib/audit';

// Public. Complete a password reset with a token from the email. On success the
// password is replaced and session_version is bumped (revoking every existing
// session for that user). The token is single-use: it's bound to the old salt,
// so it stops verifying the instant the password changes.
export const POST: APIRoute = async ({ request, locals }) => {
  try {
    await LocalDB.init();
    const body = await request.json().catch(() => null);
    const result = validate<{ token: string; password: string }>(body, {
      token: { type: 'string', min: 1, max: 2000 },
      password: { type: 'string', min: 8, max: 200 },
    });
    if (!result.ok) return ApiResponseBuilder.validationError('Invalid payload', result.errors);

    const invalid = () => ApiResponseBuilder.badRequest('This reset link is invalid or has expired.');

    const uid = readResetTokenUid(result.value.token);
    if (!uid) return invalid();
    const user = await LocalDB.getUser(uid);
    if (!user || !verifyResetToken(result.value.token, user)) return invalid();

    const { hash, salt } = await hashPassword(result.value.password);
    const updated = await LocalDB.updateUser(uid, {
      password_hash: hash,
      password_salt: salt,
      // Revoke all outstanding sessions for this user.
      session_version: (user.session_version ?? 0) + 1,
    });
    if (!updated) return invalid();
    recordAudit(AUDIT.PASSWORD_RESET, { actor: uid, target: user.email, ip: locals.ip });

    return ApiResponseBuilder.success(null, 'Your password has been reset. You can now sign in.');
  } catch (err) {
    console.error('Password reset error:', err);
    return ApiResponseBuilder.serverError('Failed to reset password');
  }
};
