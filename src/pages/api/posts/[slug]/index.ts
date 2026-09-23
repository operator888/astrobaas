import type { APIRoute } from 'astro';
import { visibleOne } from '../../../../lib/visibility';
import { LocalDB } from '../../../../lib/localdb';
import { recordView, isCountableAgent, isReaderRequest } from '../../../../lib/views';
import { renderPost } from '../../../../lib/content-render';
import { ApiResponseBuilder } from '../../../../lib/api-response';
import { resolvePostRef, updatePost, deletePost, postErrorResponse } from '../../../../lib/post-service';
import { withFeaturedMediaKind, buildMediaKindIndex } from '../../../../lib/media-kind';

// The canonical single-post resource. The path segment is a post *reference* —
// either its slug (public, human-friendly) or its id — resolved uniformly for
// all methods.
//   GET    /api/posts/{ref}   read one (anonymous callers see published only)
//   PUT    /api/posts/{ref}   update (author+, ownership enforced)
//   DELETE /api/posts/{ref}   delete (author+, ownership enforced)

export const GET: APIRoute = async ({ params, locals, request }) => {
  try {
    await LocalDB.init();
    const { slug } = params as { slug: string };
    const found = await resolvePostRef(slug);
    if (!found) return ApiResponseBuilder.notFound('Post');
    // Public callers can only read published posts; unpublished ones 404 to
    // avoid leaking draft/trashed content (and their existence) to anonymous users.
    const user = locals.user;
    // Same rule as the list, from the same helper. A 404 rather than a 403:
    // "this exists but you may not see it" confirms the slug, which is exactly
    // what withholding it is for.
    if (!visibleOne(found, user)) return ApiResponseBuilder.notFound('Post');

    // Count the read. This is where a HEADLESS storefront's views happen — it
    // fetches one article to render it, exactly as the server-rendered page
    // would. Counting only rendered pages measured zero on every headless
    // install, which is both live shops.
    //
    // isReaderRequest, not `!user`: an API-KEY caller is a headless storefront
    // fetching this article to render it for a visitor, which is a read. Only a
    // signed-in human — an editor opening the admin editor, which GETs this
    // same route — is excluded.
    if (isReaderRequest(user) && isCountableAgent(request.headers.get('user-agent'))) {
      recordView(found.id);
    }
    // `content`/`title` stay RAW — they are the stored resource, and the admin
    // editor GETs this then PUTs it back. Returning the FILTERED text here made
    // a normal edit persist plugin output as the source of truth: activate a
    // plugin, open a post, save, and its injected markup is baked into the post
    // forever, cumulatively, surviving deactivation.
    //
    // That is the same shape as the variants data-loss bug — a derived view
    // read back and saved as if it were the record. A GET must round-trip
    // through PUT without changing the resource.
    //
    // The rendered view is still available, under names that cannot be written
    // back by accident.
    // The SAME pipeline the article page runs — filters, SANITIZER, lazy
    // hints, anchors, media facts. This route used to skip the sanitizer and
    // the hints while its comment promised "exactly the markup this CMS would
    // have served": a post_content filter's output reached a headless
    // storefront unsanitized, and its images shipped without loading="lazy".
    // The record's own locale: this route serves one post, and its language
    // is a property of the record rather than of the request.
    const rendered = await renderPost(found, (found as { locale?: string }).locale);
    // A post's featured image is chosen from the SAME picker a product's
    // gallery is, so it can be a video — and it went out as a bare string with
    // no type information, which is the product bug on a second content type.
    // `featured_photo` is absent when it is a video, so a card thumbnail or an
    // og:image reading that field cannot render an <img> around an .mp4.
    const post = withFeaturedMediaKind({
      ...found,
      // Same anchors AND the same width/height the SSR page publishes. A
      // storefront rendering this html has exactly the markup this CMS would
      // have served, so its Core Web Vitals are not worse for being decoupled.
      content_rendered: rendered.html,
      title_rendered: rendered.title,
    }, buildMediaKindIndex(await LocalDB.getMedia()));
    return ApiResponseBuilder.success(post, 'Post retrieved successfully');
  } catch (err) {
    console.error('Post by ref error:', err);
    return ApiResponseBuilder.serverError('Failed to fetch post');
  }
};

export const PUT: APIRoute = async ({ params, request, locals }) => {
  try {
    await LocalDB.init();
    const found = await resolvePostRef(String((params as { slug: string }).slug));
    if (!found) return ApiResponseBuilder.notFound('Post');
    const body = await request.json().catch(() => null);
    const result = await updatePost(found.id, body, locals.user);
    if (!result.ok) return postErrorResponse(result);
    return ApiResponseBuilder.success(result.data, 'Post updated successfully');
  } catch (err) {
    console.error('Post update error:', err);
    return ApiResponseBuilder.serverError('Failed to update post');
  }
};

export const DELETE: APIRoute = async ({ params, locals }) => {
  try {
    await LocalDB.init();
    const found = await resolvePostRef(String((params as { slug: string }).slug));
    if (!found) return ApiResponseBuilder.notFound('Post');
    const result = await deletePost(found.id, locals.user);
    if (!result.ok) return postErrorResponse(result);
    return ApiResponseBuilder.deleted();
  } catch (err) {
    console.error('Post delete error:', err);
    return ApiResponseBuilder.serverError('Failed to delete post');
  }
};
