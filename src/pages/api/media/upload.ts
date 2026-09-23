import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { canAuthorPosts } from '../../../lib/auth';
import { mediaBaseFor } from '../../../lib/media-base';
import { withAbsoluteMedia } from '../../../lib/media-url';
import { ingestMedia, MAX_VIDEO_SIZE } from '../../../lib/media/ingest';

/**
 * Upload a file into the media library.
 *
 * The route now does what a route should: authenticate, read the request, and
 * report. Everything that decides what a file IS — magic-byte sniffing, SVG
 * sanitization, EXIF stripping, derivative generation, the content-addressed
 * write — lives in `lib/media/ingest.ts`, because the WordPress importer needs
 * exactly the same rules for a file it fetched from an old site, and a second
 * implementation of a security boundary is a second thing to get wrong.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  try {
    await LocalDB.init();
    const session = locals.user;
    if (!session) return ApiResponseBuilder.unauthorized();
    // Content-producing roles only — read-only `viewer` accounts cannot upload.
    if (!canAuthorPosts(session.role)) {
      return ApiResponseBuilder.forbidden('Your role cannot upload media');
    }

    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File)) {
      return ApiResponseBuilder.badRequest('No file provided');
    }
    // The ROUTE cannot know what the file is — only its bytes can say, and the
    // ingester is what reads them. So this is the outer bound only, and the
    // precise per-kind refusal (10 MB for an image, 100 MB for a video) comes
    // back from `ingestMedia` with the right number in it. Checking
    // MAX_MEDIA_SIZE here would have refused every video before the ingester
    // that allows them ever ran.
    if (file.size > MAX_VIDEO_SIZE) {
      return ApiResponseBuilder.badRequest(`File too large (max ${Math.round(MAX_VIDEO_SIZE / 1024 / 1024)} MB)`);
    }

    const stored = await ingestMedia(Buffer.from(await file.arrayBuffer()), {
      originalName: file.name,
      declaredType: file.type,
      altText: String(form.get('alt_text') ?? ''),
      uploadedBy: session.id,
    });
    if (!stored.ok) return ApiResponseBuilder.badRequest(stored.error);
    const media = stored.media;

    // Absolute URLs are added to the RESPONSE, never to the stored record: they
    // depend on the origin this request arrived on, and baking a hostname into
    // the database breaks the day the shop moves domain.
    const base = await mediaBaseFor(request);
    return ApiResponseBuilder.created(
      withAbsoluteMedia(media as any, base),
      'Media uploaded successfully',
      { media_base: base },
    );
  } catch (err) {
    console.error('Media upload error:', err);
    return ApiResponseBuilder.serverError('Failed to upload media');
  }
};
