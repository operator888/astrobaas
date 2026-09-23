import type { APIRoute } from 'astro';
import { LocalDB } from '../../../../lib/localdb';
import { ApiResponseBuilder } from '../../../../lib/api-response';
import { resolvePostRef, updatePost, postErrorResponse } from '../../../../lib/post-service';
import { canManageAllPosts } from '../../../../lib/auth';
import { recordAudit, AUDIT } from '../../../../lib/audit';

/**
 * Restore a post to an earlier revision.
 *
 * POST /api/posts/<ref>/restore  { revision_id }
 *
 * Restoring goes through the SAME updatePost() path as a normal edit, which
 * means it re-sanitizes the content and snapshots the current state first — so
 * a restore is itself undoable, and a revision written before content
 * sanitization rules tightened can't reintroduce unsafe HTML.
 */
export const POST: APIRoute = async ({ params, request, locals }) => {
  try {
    await LocalDB.init();
    const session = locals.user;
    if (!session) return ApiResponseBuilder.unauthorized();

    const post = await resolvePostRef(String(params.slug || ''));
    if (!post) return ApiResponseBuilder.notFound('Post');
    if (!canManageAllPosts(session.role) && post.author_id !== session.id) {
      return ApiResponseBuilder.forbidden('You can only restore your own posts');
    }

    const body = await request.json().catch(() => null);
    const revisionId = String((body as any)?.revision_id ?? '').trim();
    if (!revisionId) return ApiResponseBuilder.badRequest('Missing `revision_id`.');

    const revision = await LocalDB.getPostRevision(revisionId);
    if (!revision) return ApiResponseBuilder.notFound('Revision');
    // A revision id from ANOTHER post must not be restorable onto this one.
    if (revision.post_id !== post.id) {
      return ApiResponseBuilder.badRequest('That revision belongs to a different post.');
    }

    const result = await updatePost(
      post.id,
      { title: revision.title, content: revision.content, excerpt: revision.excerpt ?? '' },
      session,
    );
    if (!result.ok) return postErrorResponse(result);

    recordAudit(AUDIT.POST_RESTORE, {
      actor: session.id,
      target: post.id,
      ip: locals.ip,
      metadata: { revision_id: revision.id, revision_created_at: revision.created_at },
    });

    return ApiResponseBuilder.success(result.data, 'Post restored from revision');
  } catch (err) {
    console.error('Restore error:', err);
    return ApiResponseBuilder.serverError('Failed to restore revision');
  }
};
