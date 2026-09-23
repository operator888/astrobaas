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

    const ok = await LocalDB.deleteMessage(result.value.id);
    if (!ok) return ApiResponseBuilder.notFound('Message');
    return ApiResponseBuilder.deleted();
  } catch (err) {
    console.error('Message delete error:', err);
    return ApiResponseBuilder.serverError('Failed to delete message');
  }
};
