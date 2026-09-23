import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { validate } from '../../../lib/validate';

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    await LocalDB.init();
    const session = locals.user;
    if (!session || session.role !== 'admin') return ApiResponseBuilder.forbidden('Admin only');

    const body = await request.json().catch(() => null);
    const result = validate<{ id: string }>(body, { id: { type: 'id' } });
    if (!result.ok) return ApiResponseBuilder.validationError('Invalid payload', result.errors);
    if (result.value.id === session.id) {
      return ApiResponseBuilder.badRequest('Cannot delete the currently signed-in user');
    }

    // Never let the last active admin be deleted.
    const target = await LocalDB.getUser(result.value.id);
    if (!target) return ApiResponseBuilder.notFound('User');
    if (target.role === 'admin' && target.status === 'active') {
      const activeAdmins = (await LocalDB.getUsers()).filter(
        u => u.role === 'admin' && u.status === 'active',
      );
      if (activeAdmins.length <= 1) {
        return ApiResponseBuilder.badRequest('Cannot delete the last active admin');
      }
    }

    const ok = await LocalDB.deleteUser(result.value.id);
    if (!ok) return ApiResponseBuilder.notFound('User');
    return ApiResponseBuilder.deleted();
  } catch (err) {
    console.error('User delete error:', err);
    return ApiResponseBuilder.serverError('Failed to delete user');
  }
};
