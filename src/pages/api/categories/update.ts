import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { validate } from '../../../lib/validate';

export const PUT: APIRoute = async ({ request, locals }) => {
  try {
    await LocalDB.init();
    const session = locals.user;
    if (!session || (session.role !== 'admin' && session.role !== 'editor')) {
      return ApiResponseBuilder.forbidden('Only admins and editors can manage categories');
    }

    const body = await request.json().catch(() => null);
    // Validate + whitelist: never pass the raw body to the store (it would let
    // a caller overwrite id/created_at and inject arbitrary fields).
    const result = validate<{ id: string; name?: string; slug?: string; description?: string }>(body, {
      id: { type: 'id' },
      name: { type: 'string', min: 1, max: 100, optional: true },
      slug: { type: 'string', min: 1, max: 80, pattern: /^[a-z0-9-]+$/, optional: true },
      description: { type: 'string', max: 500, optional: true },
    });
    if (!result.ok) return ApiResponseBuilder.validationError('Invalid category payload', result.errors);

    const { id, ...updates } = result.value;
    const updatedCategory = await LocalDB.updateCategory(id, updates);
    if (!updatedCategory) return ApiResponseBuilder.notFound('Category');

    return ApiResponseBuilder.success(updatedCategory, 'Category updated successfully');
  } catch (error) {
    console.error('Error updating category:', error);
    return ApiResponseBuilder.serverError('Failed to update category');
  }
};
