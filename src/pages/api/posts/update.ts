import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { updatePost, postErrorResponse } from '../../../lib/post-service';

// DEPRECATED body-based shim. Prefer `PUT /api/posts/{id}`.
// Kept for the admin UI and one release of backward compatibility; delegates to
// the same post-service so behaviour is identical.
export const PUT: APIRoute = async ({ request, locals }) => {
  try {
    await LocalDB.init();
    const body = await request.json().catch(() => null);
    const id = body && typeof body === 'object' ? (body as Record<string, unknown>).id : undefined;
    if (typeof id !== 'string' || !id) {
      return ApiResponseBuilder.validationError('Invalid post payload', { id: 'id is required' });
    }
    const { id: _omit, ...updates } = body as Record<string, unknown>;
    const result = await updatePost(id, updates, locals.user);
    if (!result.ok) return postErrorResponse(result);
    const res = ApiResponseBuilder.success(result.data, 'Post updated successfully');
    res.headers.set('Deprecation', 'true');
    res.headers.set('Link', '</api/posts/{id}>; rel="successor-version"');
    return res;
  } catch (err) {
    console.error('Post update error:', err);
    return ApiResponseBuilder.serverError('Failed to update post');
  }
};
