import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { canAuthorPosts, canManageAllPosts } from '../../../lib/auth';
import { cleanAltText } from '../../../lib/media/ingest';
import { cleanFolderName } from '../../../lib/media/folders';

/**
 * PATCH /api/media/update — edit a media record's descriptive fields.
 *
 * ## Why this route exists
 *
 * `alt_text` had exactly ONE writer: the upload ingester, fed from a form field
 * that no interface ever sent. So the column was real, the reader was real, and
 * every row was empty — a feature that existed only in the schema.
 *
 * ## What it will not do
 *
 * It does not touch the FILE. `url`, `filename`, `mime_type`, `width`,
 * `height` and the derivative list are facts about bytes on disk, and a route
 * that let them be edited would let a record describe a picture it is not.
 * Replacing an image is `media/replace`, which re-runs the pipeline.
 *
 * Alt text is per-file, so a bulk patch may not set it: describing forty
 * pictures with one sentence is worse than describing none, because a screen
 * reader then reads the same wrong caption forty times.
 */
export const PATCH: APIRoute = async ({ request, locals }) => {
  // The SAME gate the upload route uses (api/media/upload.ts:25). Whoever may
  // put a picture in the library may describe it; a separate rule here would be
  // a second answer to one question.
  if (!canAuthorPosts(locals.user?.role)) {
    return ApiResponseBuilder.forbidden('Your role cannot edit media');
  }
  try {
    const body = await request.json().catch(() => null);
    const ids = Array.isArray(body?.ids) ? body.ids.filter((v: unknown) => typeof v === 'string') : [];
    if (ids.length === 0) return ApiResponseBuilder.badRequest('ids is required');
    if (ids.length > 200) return ApiResponseBuilder.badRequest('At most 200 files at a time');

    const patch = body?.patch && typeof body.patch === 'object' ? body.patch : {};
    const hasAlt = Object.prototype.hasOwnProperty.call(patch, 'alt_text');
    if (hasAlt && ids.length > 1) {
      return ApiResponseBuilder.badRequest('Alt text describes one picture; set it per file');
    }

    // An AUTHOR may only describe their own uploads. `canAuthorPosts` is the
    // right gate for "may put a picture in the library"; it is the wrong one for
    // "may rewrite every other author's descriptions", which is what the first
    // version allowed. Editors and admins manage the whole library, exactly as
    // they manage everyone's posts (canManageAllPosts).
    const mayEditAny = canManageAllPosts(locals.user?.role);
    const updated: string[] = [];
    const refused: string[] = [];
    for (const id of ids) {
      const existing = await LocalDB.getMediaFile(id);
      if (!existing) continue;
      if (!mayEditAny && existing.uploaded_by && existing.uploaded_by !== locals.user?.id) {
        refused.push(id);
        continue;
      }
      const next: Record<string, unknown> = {};
      if (hasAlt) next.alt_text = cleanAltText(patch.alt_text);
      // cleanFolderName, not an inline trim. The filter in media/get.ts uses
      // the same function, so a folder that was patched cannot be invisible to
      // the filter meant to find it — which is what two spellings of one rule
      // reliably produce here.
      if (typeof patch.folder === 'string') next.folder = cleanFolderName(patch.folder);
      if (Object.keys(next).length === 0) continue;
      const row = await LocalDB.updateMediaFile(id, next);
      if (row) updated.push(id);
    }

    // `refused` is reported rather than silently dropped: an author who patched
    // ten files and changed four needs to know which six, or they will assume
    // the whole call worked.
    return ApiResponseBuilder.success(
      { updated, count: updated.length, refused },
      refused.length
        ? `Updated ${updated.length}; ${refused.length} belong to someone else`
        : 'Media updated',
    );
  } catch (err) {
    console.error('Media update error:', err);
    return ApiResponseBuilder.serverError('Failed to update media');
  }
};
