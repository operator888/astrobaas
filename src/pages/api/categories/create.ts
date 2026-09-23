import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { validate, slugify } from '../../../lib/validate';

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    await LocalDB.init();
    const session = locals.user;
    if (!session || (session.role !== 'admin' && session.role !== 'editor')) {
      return ApiResponseBuilder.forbidden('Only admins and editors can manage categories');
    }
    const body = await request.json().catch(() => null);
    const result = validate<{ name: string; slug?: string; description?: string }>(body, {
      name: { type: 'string', min: 1, max: 100 },
      slug: { type: 'string', min: 1, max: 80, pattern: /^[a-z0-9-]+$/, optional: true },
      description: { type: 'string', max: 500, optional: true },
    });
    if (!result.ok) {
      return ApiResponseBuilder.validationError('Invalid category payload', result.errors);
    }
    const slug = result.value.slug || slugify(result.value.name);
    const existing = await LocalDB.getCategories();
    if (existing.some(c => c.slug === slug)) {
      return ApiResponseBuilder.badRequest('A category with that slug already exists');
    }
    const category = await LocalDB.createCategory({
      name: result.value.name,
      slug,
      description: result.value.description,
    });
    return ApiResponseBuilder.created(category, 'Category created successfully');
  } catch (err) {
    console.error('Category create error:', err);
    return ApiResponseBuilder.serverError('Failed to create category');
  }
};
