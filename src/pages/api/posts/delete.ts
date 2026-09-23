import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { validate } from '../../../lib/validate';
import { deletePost, postErrorResponse } from '../../../lib/post-service';

// DEPRECATED body-based shim. Prefer `DELETE /api/posts/{id}`.
// Kept for the admin UI and one release of backward compatibility; delegates to
// the same post-service so behaviour is identical.
export const DELETE: APIRoute = async ({ request, locals }) => {
  try {
    await LocalDB.init();
    const body = await request.json().catch(() => null);
    const result = validate<{ id: string }>(body, { id: { type: 'id' } });
    if (!result.ok) return ApiResponseBuilder.validationError('Invalid payload', result.errors);

    const svc = await deletePost(result.value.id, locals.user);
    if (!svc.ok) return postErrorResponse(svc);
    const res = ApiResponseBuilder.deleted();
    res.headers.set('Deprecation', 'true');
    res.headers.set('Link', '</api/posts/{id}>; rel="successor-version"');
    return res;
  } catch (err) {
    console.error('Post delete error:', err);
    return ApiResponseBuilder.serverError('Failed to delete post');
  }
};
