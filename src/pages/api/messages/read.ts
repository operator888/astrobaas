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
    const result = validate<{ id: string; read?: boolean }>(body, {
      id: { type: 'id' },
      read: { type: 'boolean', optional: true },
    });
    if (!result.ok) return ApiResponseBuilder.validationError('Invalid payload', result.errors);

    // Omitting `read` marks it read; pass read:false to mark unread.
    const updated = await LocalDB.markMessageRead(result.value.id, result.value.read !== false);
    if (!updated) return ApiResponseBuilder.notFound('Message');
    return ApiResponseBuilder.success(updated, 'Message updated');
  } catch (err) {
    console.error('Message read error:', err);
    return ApiResponseBuilder.serverError('Failed to update message');
  }
};
