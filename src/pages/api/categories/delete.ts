import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { validate } from '../../../lib/validate';

export const DELETE: APIRoute = async ({ request, locals }) => {
  try {
    await LocalDB.init();
    const session = locals.user;
    if (!session || (session.role !== 'admin' && session.role !== 'editor')) {
      return ApiResponseBuilder.forbidden('Only admins and editors can manage categories');
    }

    const body = await request.json().catch(() => null);
    const result = validate<{ id: string }>(body, { id: { type: 'id' } });
    if (!result.ok) return ApiResponseBuilder.validationError('Invalid payload', result.errors);

    const deleted = await LocalDB.deleteCategory(result.value.id);
    if (!deleted) return ApiResponseBuilder.notFound('Category');

    return ApiResponseBuilder.success(null, 'Category deleted successfully');
  } catch (error) {
    console.error('Error deleting category:', error);
    return ApiResponseBuilder.serverError('Failed to delete category');
  }
};
