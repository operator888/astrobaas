import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { canManageAllPosts, canAuthorPosts } from '../../../lib/auth';
import { mediaBaseFor } from '../../../lib/media-base';
import { withAbsoluteMedia } from '../../../lib/media-url';
import { MAX_MEDIA_SIZE } from '../../../lib/media/ingest';
import { replaceMediaFile } from '../../../lib/media/replace';
import { recordAudit, AUDIT } from '../../../lib/audit';
import type { MediaFile } from '../../../core/models';

/**
 * Swap the file behind a media record, keeping the record.
 *
 * The point is the ID: a cropped logo, a corrected product photo, a re-scanned
 * PDF — replace the file and everything that pointed at it keeps pointing at
 * it. Re-uploading gives a new id and leaves the operator to find every page
 * that used the old one.
 *
 * Same permission rule as deleting: an editor or admin may replace anything, a
 * manager or author only their own uploads. Replacing somebody else's file
 * changes what their pages show, which is the same act as deleting it and then
 * putting something in its place.
 *
 * Audited, because it rewrites stored post and product content — that is a
 * content migration, and the operator should be able to see when one ran.
 */
export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    await LocalDB.init();
    const session = locals.user;
    if (!session) return ApiResponseBuilder.unauthorized();
    if (!canAuthorPosts(session.role)) {
      return ApiResponseBuilder.forbidden('Your role cannot manage media');
    }

    const form = await request.formData();
    const id = String(form.get('id') ?? '').trim();
    const file = form.get('file');
    if (!id) return ApiResponseBuilder.badRequest('Which file should be replaced?');
    if (!(file instanceof File)) return ApiResponseBuilder.badRequest('No replacement file provided');
    if (file.size === 0) return ApiResponseBuilder.badRequest('The replacement file is empty');
    if (file.size > MAX_MEDIA_SIZE) {
      return ApiResponseBuilder.badRequest(`File too large (max ${MAX_MEDIA_SIZE / 1024 / 1024} MB)`);
    }

    const existing = ((await LocalDB.getMedia()) as MediaFile[]).find((m) => m.id === id);
    if (!existing) return ApiResponseBuilder.notFound('Media file');
    if (!canManageAllPosts(session.role) && existing.uploaded_by !== session.id) {
      return ApiResponseBuilder.forbidden('You can only replace media you uploaded');
    }

    const result = await replaceMediaFile(id, Buffer.from(await file.arrayBuffer()), {
      originalName: file.name,
      declaredType: file.type,
      uploadedBy: session.id,
    });
    if (!result.ok) return ApiResponseBuilder.badRequest(result.error);

    recordAudit(AUDIT.MEDIA_REPLACE, {
      actor: session.id,
      target: id,
      ip: locals.ip,
      metadata: {
        posts_updated: result.updated.posts,
        products_updated: result.updated.products,
        files_removed: result.removedFiles,
        files_kept_shared: result.keptShared,
      },
    });

    const base = await mediaBaseFor(request);
    return ApiResponseBuilder.success(
      {
        ...(withAbsoluteMedia(result.media as any, base) as Record<string, unknown>),
        replaced: {
          posts_updated: result.updated.posts,
          products_updated: result.updated.products,
          files_removed: result.removedFiles,
          files_kept_shared: result.keptShared,
        },
      },
      'File replaced',
      { media_base: base },
    );
  } catch (err) {
    console.error('Media replace error:', err);
    return ApiResponseBuilder.serverError('Failed to replace the file');
  }
};
