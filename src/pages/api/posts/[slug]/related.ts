import type { APIRoute } from 'astro';
import { withFeaturedMediaKind, buildMediaKindIndex } from '../../../../lib/media-kind';
import { LocalDB } from '../../../../lib/localdb';
import { ApiResponseBuilder } from '../../../../lib/api-response';
import { visibleOne, visibleContent } from '../../../../lib/visibility';
import { resolvePostRef } from '../../../../lib/post-service';
import { relatedPosts } from '../../../../lib/related';
import { relatedCount } from '../../../../lib/related-count';

/**
 * `GET /api/posts/{ref}/related` — the related-articles strip, for a front end
 * this CMS does not render.
 *
 * ## Why this exists
 *
 * `lib/related.ts` was reachable from exactly one place: the server-rendered
 * blog permalink. That is fine for a site this CMS renders and useless for the
 * two live shops, which are headless Next.js storefronts — so the internal
 * linking and session depth the feature exists to create were available to the
 * demo blog and to nobody who actually ships. A decoupled front end had no way
 * to ask for related posts short of reimplementing the scoring itself, and
 * nothing in the OpenAPI document or the client package hinted it existed.
 *
 * The SSR route keeps its own call; both now resolve the limit through
 * `relatedCount`, so the two cannot answer differently.
 *
 * ## Three things this route deliberately does NOT do
 *
 * **It does not count a view.** `GET /api/posts/{ref}` records one for an
 * API-key caller, because a headless storefront rendering an article is a read.
 * Copying that here would credit a view to every article merely LISTED as a
 * suggestion, silently inflating the analytics on both shops.
 *
 * **It does not return rendered bodies.** A related strip needs a title, a slug
 * and an image. Rendering three article bodies through the sanitizer to build a
 * list of links is three sanitizer passes per request for markup nobody shows.
 *
 * **It does not fall back to the latest posts.** An empty result is the correct
 * answer when nothing shares a category or a tag, and the SSR route honours
 * that by rendering no section at all. "Related" that quietly means "recent" is
 * a worse recommendation than none, and the caller cannot tell the difference.
 */
export const prerender = false;

export const GET: APIRoute = async ({ params, locals, url }) => {
  try {
    await LocalDB.init();
    const ref = String((params as { slug: string }).slug ?? '');
    const found = await resolvePostRef(ref);
    // 404 for "no such post" AND for "you may not see it", the same rule the
    // sibling GET uses: a 403 on a draft would confirm the draft exists.
    if (!found) return ApiResponseBuilder.notFound('Post');
    const user = locals.user ?? null;
    if (!visibleOne(found, user)) return ApiResponseBuilder.notFound('Post');

    const all = await LocalDB.getPosts();

    // The FULL list goes to relatedPosts, not a pre-filtered published-only
    // one: it resolves translation roots across `all`, so a chain passing
    // through an unpublished root still collapses. Pre-filtering here would
    // reintroduce "the same article in another language" as a suggestion.
    // The viewer filter is applied to the RESULT instead.
    const limitParam = url.searchParams.get('limit');
    const limit = limitParam !== null
      ? relatedCount(limitParam)
      : relatedCount((await LocalDB.getSetting('related_posts_count'))?.value);

    const scored = relatedPosts(found, all as Parameters<typeof relatedPosts>[1], { limit });
    const visible = visibleContent(scored.map((r) => r.post), user);
    const keep = new Set(visible.map((p) => p.id));

    const mediaIndex = buildMediaKindIndex(await LocalDB.getMedia());
    return ApiResponseBuilder.success(
      scored
        .filter((r) => keep.has(r.post.id))
        .map(({ post, score }) => ({
          id: post.id,
          slug: post.slug,
          title: post.title,
          excerpt: post.excerpt,
          // A related-posts strip is a grid of thumbnails, so this is exactly
          // the surface that renders an <img> without asking what it got.
          ...withFeaturedMediaKind({ featured_image: post.featured_image }, mediaIndex),
          publish_date: post.publish_date,
          locale: post.locale,
          score,
        })),
    );
  } catch (err) {
    console.error('Related posts error:', err);
    return ApiResponseBuilder.serverError('Could not load related posts');
  }
};
