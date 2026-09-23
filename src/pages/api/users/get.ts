import type { APIRoute } from 'astro';
import { toPublicUser } from '../../../lib/auth';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';

export const GET: APIRoute = async ({ locals }) => {
  try {
    await LocalDB.init();
    const session = locals.user;
    if (!session || session.role !== 'admin') {
      return ApiResponseBuilder.forbidden('Admin only');
    }
    const users = await LocalDB.getUsers();
    // Strip secrets from every returned user.
    // One sanitiser for every route that returns a user (src/lib/auth.ts).
    //
    // This route and users/update.ts each hand-rolled their own destructuring.
    // Both stripped the password fields; only one remembered `two_factor`, so
    // the TOTP secret and backup-code hashes left the server from the other —
    // an admin who reads another admin's second factor can enrol it, which
    // makes 2FA a second copy of the first factor rather than a second factor.
    //
    // Duplicating a sanitiser is how one copy drifts. There is now one.
    const safe = users.map((u: any) => toPublicUser(u));
    return ApiResponseBuilder.success(safe, 'Users retrieved successfully');
  } catch (err) {
    console.error('Users list error:', err);
    return ApiResponseBuilder.serverError('Failed to fetch users');
  }
};
