import type { APIRoute } from 'astro';
import { LocalDB } from '../../../../lib/localdb';
import { ApiResponseBuilder } from '../../../../lib/api-response';
import { resolvePostRef } from '../../../../lib/post-service';
import { canManageAllPosts } from '../../../../lib/auth';
import { captureRevision, revisionKeep, revisionsEnabled } from '../../../../lib/revisions';
import type { Post } from '../../../../core/models';

/**
 * Revision history for a post.
 *
 * GET  /api/posts/<ref>/revisions        — list (newest first)
 * POST /api/posts/<ref>/revisions        — autosave the editor's current draft
 *
 * Revisions contain UNPUBLISHED draft text, so every method here requires a
 * session and applies the same ownership rule as editing the post itself:
 * admins/editors see any post's history, authors only their own. There is no
 * public read path.
 */

/** Shared gate: resolve the post and check the caller may edit it. */
type Gate = { ok: true; post: Post } | { ok: false; response: Response };

async function authorize(
  ref: string,
  session: { id: string; role: string } | null | undefined,
): Promise<Gate> {
  if (!session) return { ok: false, response: ApiResponseBuilder.unauthorized() };
  const post = await resolvePostRef(ref);

  // D2-6: "no such post" and "not your post" must be INDISTINGUISHABLE.
  //
  // This used to answer 404 for the first and 403 for the second, which turns
  // the endpoint into a slug oracle: any author could walk a wordlist against
  // /api/posts/<guess>/revisions and read off which slugs exist from the status
  // code alone. On an editorial site the slugs themselves are the leak —
  // `acquisition-announcement`, `q3-layoffs`, `price-increase-2027` — and they
  // are readable before a word of the body is written.
  //
  // One 404 for both. An author learns nothing about posts that are not theirs,
  // including whether they exist. (Editors and admins are unaffected: they may
  // manage every post, so for them the only 404 left is a genuine miss.)
  if (!post || (!canManageAllPosts(session.role) && post.author_id !== session.id)) {
    return { ok: false, response: ApiResponseBuilder.notFound('Post') };
  }
  return { ok: true, post };
}

export const GET: APIRoute = async ({ params, url, locals }) => {
  try {
    await LocalDB.init();
    const gate = await authorize(String(params.slug || ''), locals.user);
    if (!gate.ok) return gate.response;

    const limitRaw = new URL(url).searchParams.get('limit');
    const limit = limitRaw ? Math.min(Math.max(parseInt(limitRaw, 10) || 0, 1), 200) : 50;
    const revisions = await LocalDB.getPostRevisions(gate.post.id, limit);

    return ApiResponseBuilder.success(revisions, 'Revisions retrieved', {
      count: revisions.length,
      post_id: gate.post.id,
      keep: revisionKeep(),
      enabled: revisionsEnabled(),
    });
  } catch (err) {
    console.error('Revisions list error:', err);
    return ApiResponseBuilder.serverError('Failed to fetch revisions');
  }
};

/**
 * Autosave. The editor posts its in-progress draft; we store it as a revision
 * WITHOUT touching the published post, so a crashed tab loses nothing.
 * Deliberately does not update the post itself — autosave must never publish.
 */
export const POST: APIRoute = async ({ params, request, locals }) => {
  try {
    await LocalDB.init();
    const gate = await authorize(String(params.slug || ''), locals.user);
    if (!gate.ok) return gate.response;

    if (!revisionsEnabled()) {
      return ApiResponseBuilder.badRequest('Revisions are disabled (REVISIONS_DISABLED=1).');
    }

    const body = await request.json().catch(() => null);
    const title = typeof (body as any)?.title === 'string' ? (body as any).title.slice(0, 200) : gate.post.title;
    const content = typeof (body as any)?.content === 'string' ? (body as any).content.slice(0, 200_000) : gate.post.content;
    const excerpt = typeof (body as any)?.excerpt === 'string' ? (body as any).excerpt.slice(0, 600) : gate.post.excerpt;

    // Stored verbatim: a revision is never rendered as HTML by the app, and
    // restoring one goes through the normal update path, which sanitizes.
    const rev = await captureRevision(
      { ...gate.post, title, content, excerpt },
      locals.user!.id,
      'autosave',
    );

    if (!rev) {
      // Nothing changed since the last snapshot — that's a success, not an error.
      return ApiResponseBuilder.success({ saved: false }, 'No changes since the last autosave');
    }
    return ApiResponseBuilder.created(
      { saved: true, id: rev.id, created_at: rev.created_at },
      'Draft autosaved',
    );
  } catch (err) {
    console.error('Autosave error:', err);
    return ApiResponseBuilder.serverError('Failed to autosave');
  }
};
