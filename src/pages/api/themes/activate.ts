import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { invalidateThemeCache } from '../../../lib/theme-runtime';
import { validate } from '../../../lib/validate';

// Admin-only. Activates a theme by id (deactivates the others). CSRF enforced
// by middleware.
export const POST: APIRoute = async ({ request, locals }) => {
  try {
    await LocalDB.init();
    const session = locals.user;
    if (!session || session.role !== 'admin') return ApiResponseBuilder.forbidden('Admin only');

    const body = await request.json().catch(() => null);
    const result = validate<{ id: string }>(body, { id: { type: 'id' } });
    if (!result.ok) return ApiResponseBuilder.validationError('Invalid payload', result.errors);

    const theme = await LocalDB.activateTheme(result.value.id);
    if (!theme) return ApiResponseBuilder.notFound('Theme');
    // Which slots render is cached per process — drop it so the very next page
    // render picks up the new theme instead of waiting for the TTL.
    invalidateThemeCache();
    return ApiResponseBuilder.success({ id: theme.id, name: theme.name }, 'Theme activated');
  } catch (err) {
    console.error('Theme activate error:', err);
    return ApiResponseBuilder.serverError('Failed to activate theme');
  }
};
