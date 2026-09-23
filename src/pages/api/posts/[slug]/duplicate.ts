import type { APIRoute } from 'astro';
import { LocalDB } from '../../../../lib/localdb';
import { ApiResponseBuilder } from '../../../../lib/api-response';
import { resolvePostRef, uniqueSlug } from '../../../../lib/post-service';
import { canAuthorPosts, canManageAllPosts } from '../../../../lib/auth';
import { recordAudit, AUDIT } from '../../../../lib/audit';
import { pluginManager } from '../../../../lib/plugin-system';
import { sanitizeHtml } from '../../../../lib/sanitize';
import { isReservedSlug, reservedSlugMessage } from '../../../../lib/reserved-slugs';
import { fireEvent } from '../../../../lib/webhooks';

/**
 * Copy a post or page.
 *
 * POST /api/posts/<ref>/duplicate → 201 with the new DRAFT.
 *
 * "Start from a copy of that one" is the most-installed workflow WordPress
 * has no core answer for (Yoast Duplicate Post: 4M installs), and the reason
 * is small: authors build a shape once — a product-launch post, a service
 * page, a newsletter — and want the next one to start where the last one
 * ended, not from an empty editor.
 *
 * What the copy is, and what it deliberately is NOT:
 *
 *  - **A draft, always.** Duplicating a published post must not publish a
 *    second copy of it: two URLs with the same body is the duplicate-content
 *    problem the sitemap code goes out of its way to avoid, and it would
 *    happen the instant someone clicked the button on a live article.
 *  - **Owned by whoever clicked.** `author_id` is the session, not the
 *    source's author — the same rule POST /api/posts enforces after the
 *    plugin filter, so an author cannot mint posts owned by someone else.
 *  - **Its own record.** No revisions are copied (they key on post_id, and
 *    copying them would graft another post's history onto this one), views
 *    reset to 0, and `translation_of` is dropped — carrying it would file the
 *    copy as a second translation of the same original and give the language
 *    switcher two entries for one language.
 *
 * Ownership matches update and delete: editors and admins may copy anything,
 * an author only their own. Reading a post is not permission to copy it —
 * an author's unpublished draft is exactly what a copy would expose.
 */
export const POST: APIRoute = async ({ params, locals }) => {
  try {
    await LocalDB.init();
    const session = locals.user;
    if (!session) return ApiResponseBuilder.unauthorized();
    if (!canAuthorPosts(session.role)) {
      return ApiResponseBuilder.forbidden('You do not have permission to create posts');
    }

    const post = await resolvePostRef(String(params.slug || ''));
    if (!post) return ApiResponseBuilder.notFound('Post');
    if (!canManageAllPosts(session.role) && post.author_id !== session.id) {
      return ApiResponseBuilder.forbidden('You can only duplicate your own posts');
    }

    // The title is built SERVER-side from the stored value. Reading it from
    // the admin table would capture whatever the `post_title` plugin filter
    // rendered — the derived-view-saved-as-source bug this codebase has
    // already paid for once.
    // Truncate the SOURCE, not the suffix. 200 is exactly the title ceiling,
    // so slicing the concatenation drops "(Copy)" off any title at the cap and
    // the copy comes out byte-identical to its original — indistinguishable in
    // the admin list, and identical again on the next duplicate.
    const MARKER = ' (Copy)';
    const title = `${post.title.slice(0, 200 - MARKER.length)}${MARKER}`;
    const slug = await uniqueSlug(`${post.slug}-copy`);

    // The copy inherits `kind`, so a Page copy has to clear the same bar a new
    // Page does: a built-in route always wins over a Page slug, and a Page
    // parked on one is permanently unreachable while looking saved.
    if (post.kind === 'page' && isReservedSlug(slug)) {
      return ApiResponseBuilder.validationError('Cannot duplicate', {
        slug: reservedSlugMessage(slug),
      });
    }

    const draft = pluginManager.applyFilters('before_post_save', {
      title,
      slug,
      content: post.content ?? '',
      excerpt: post.excerpt,
      featured_image: post.featured_image,
      // Never inherit the source's status. See the header.
      status: 'draft' as const,
      ...(post.kind ? { kind: post.kind } : {}),
      author_id: session.id,
      category_id: post.category_id,
      // A fresh array: sharing the reference would let a later edit of one
      // post's tags mutate the other's.
      tags: [...(post.tags ?? [])],
      meta_title: post.meta_title,
      meta_description: post.meta_description,
      ...(post.noindex ? { noindex: true } : {}),
      locale: post.locale,
      views: 0,
    }, { isNew: true });

    const created = await LocalDB.createPost({
      ...draft,
      // Sanitize AFTER the filter, exactly as the create route does — a plugin
      // that returns markup must pass the sanitizer too.
      content: sanitizeHtml(draft.content ?? ''),
      // Never overridable by a plugin.
      author_id: session.id,
      status: 'draft',
    } as any);

    recordAudit(AUDIT.POST_DUPLICATE, {
      actor: session.id,
      target: created.slug || created.id,
      ip: locals.ip,
      metadata: {
        source: post.id,
        source_slug: post.slug,
        title: created.title,
        kind: created.kind ?? 'post',
      },
    });
    pluginManager.doAction('after_post_save', created);
    // A duplicate IS a creation — subscribers to post.created want to know a
    // new record exists, and inventing a second event name would silently
    // exclude every existing subscription.
    fireEvent('post.created', created).catch(() => {});

    return ApiResponseBuilder.created(created, 'Copy created as a draft');
  } catch (err) {
    console.error('Post duplicate error:', err);
    return ApiResponseBuilder.serverError('Failed to duplicate post');
  }
};
