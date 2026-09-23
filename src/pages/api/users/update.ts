import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { validate } from '../../../lib/validate';
import { recordAudit, AUDIT } from '../../../lib/audit';
import { ROLES } from '../../../core/models';
import {
  hashPassword,
  signSession,
  serializeCookie,
  cookieSecure,
  SESSION_COOKIE,
  sessionTtlMs,
  toPublicUser,
} from '../../../lib/auth';

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    await LocalDB.init();
    const session = locals.user;
    if (!session) return ApiResponseBuilder.unauthorized();

    const body = await request.json().catch(() => null);

    // AN UNCHANGED ADDRESS IS NOT AN EDIT.
    //
    // The admin's user form posts every field it renders, including the email,
    // whether or not the operator touched it. So a stored address that does not
    // satisfy today's shape rule made the whole record uneditable: the seeded
    // `admin@local` — an address this software CREATES — could not be renamed,
    // re-roled or deactivated, and the message was "email has invalid format"
    // about a value the operator had not typed.
    //
    // Dropped BEFORE validation rather than loosening the rule, because the
    // rule is right for the places that matter: the newsletter form and the
    // contact form, where requiring a dot in the domain catches a real typo.
    // Grandfathering an address somebody already has is a different question
    // from accepting a new one.
    if (body && typeof body === 'object') {
      const bag = body as Record<string, unknown>;
      const id = typeof bag.id === 'string' ? bag.id : '';
      if (id && typeof bag.email === 'string') {
        const existing = await LocalDB.getUser(id);
        if (existing && existing.email.trim().toLowerCase() === bag.email.trim().toLowerCase()) {
          delete bag.email;
        }
      }
    }

    const result = validate<{
      id: string;
      name?: string;
      email?: string;
      role?: 'admin' | 'editor' | 'author' | 'viewer';
      status?: 'active' | 'inactive';
      password?: string;
      avatar?: string;
      /** Opt in to a public author archive (C-153). The person's own choice. */
      public_archive?: boolean;
    }>(body, {
      id: { type: 'id' },
      name: { type: 'string', min: 1, max: 100, optional: true },
      email: {
        type: 'string',
        min: 3,
        max: 200,
        pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
        optional: true,
      },
      role: { type: 'enum', values: ROLES as unknown as string[], optional: true },
      status: { type: 'enum', values: ['active', 'inactive'], optional: true },
      password: { type: 'string', min: 8, max: 200, optional: true },
      avatar: { type: 'string', max: 500, optional: true },
      // Declared, so it is validated and stored — a flag the profile screen
      // wrote and the schema did not declare would be dropped by validate() and
      // the checkbox would never stick.
      public_archive: { type: 'boolean', optional: true },
    });
    if (!result.ok) return ApiResponseBuilder.validationError('Invalid user payload', result.errors);

    const { id, password, ...rest } = result.value;
    // Non-admin can only update themselves and cannot change their role/status.
    if (session.role !== 'admin' && session.id !== id) {
      return ApiResponseBuilder.forbidden('Cannot edit other users');
    }
    if (session.role !== 'admin') {
      delete (rest as any).role;
      delete (rest as any).status;
    }

    // Never let the last active admin be demoted or deactivated — it would
    // lock everyone out of admin-only functions.
    const target = await LocalDB.getUser(id);
    if (!target) return ApiResponseBuilder.notFound('User');
    const demoting = (rest as any).role && (rest as any).role !== 'admin' && target.role === 'admin';
    const deactivating =
      (rest as any).status === 'inactive' && target.status === 'active' && target.role === 'admin';
    if (demoting || deactivating) {
      const activeAdmins = (await LocalDB.getUsers()).filter(
        u => u.role === 'admin' && u.status === 'active',
      );
      if (activeAdmins.length <= 1 && activeAdmins.some(u => u.id === id)) {
        return ApiResponseBuilder.badRequest('Cannot demote or deactivate the last active admin');
      }
    }

    const updates: Record<string, any> = { ...rest };
    if (password) {
      const { hash, salt } = await hashPassword(password);
      updates.password_hash = hash;
      updates.password_salt = salt;
    }

    // Revoke existing sessions when a security-relevant field changes: password,
    // role, or deactivation. Bumping session_version invalidates outstanding
    // tokens (middleware compares the token's sv against this).
    const roleChanged = (rest as any).role && (rest as any).role !== target.role;
    const deactivated = (rest as any).status === 'inactive' && target.status === 'active';
    if (password || roleChanged || deactivated) {
      updates.session_version = (target.session_version ?? 0) + 1;
    }

    const user = await LocalDB.updateUser(id, updates);
    if (!user) return ApiResponseBuilder.notFound('User');
    // Audit security-relevant user changes (role/status/password), never the values.
    if (roleChanged || deactivated || password) {
      recordAudit(AUDIT.USER_UPDATE, {
        actor: session.id,
        target: id,
        ip: locals.ip,
        metadata: {
          role_changed: !!roleChanged,
          ...(roleChanged ? { new_role: (rest as any).role } : {}),
          deactivated: !!deactivated,
          password_changed: !!password,
        },
      });
    }
    // Was `const { password_hash, password_salt, ...safe } = user` — which left
    // `two_factor` (TOTP secret + backup-code hashes) in the response. Same
    // shared sanitiser as every other user-returning route.
    const safe = toPublicUser(user as any);
    const res = ApiResponseBuilder.success(safe, 'User updated successfully');

    // If the acting user bumped their OWN session_version (e.g. self password
    // change), re-issue their cookie so they aren't logged out of this session.
    if (updates.session_version !== undefined && session.id === id) {
      const token = signSession({ uid: user.id, role: user.role, sv: updates.session_version });
      res.headers.append(
        'Set-Cookie',
        serializeCookie(SESSION_COOKIE, token, {
          maxAgeMs: sessionTtlMs,
          sameSite: 'Lax',
          secure: cookieSecure(),
        }),
      );
    }
    return res;
  } catch (err) {
    console.error('User update error:', err);
    return ApiResponseBuilder.serverError('Failed to update user');
  }
};
