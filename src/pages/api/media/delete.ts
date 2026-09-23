import type { APIRoute } from 'astro';
import fs from 'node:fs/promises';
import path from 'node:path';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { validate } from '../../../lib/validate';
import { getUploadsDir } from '../../../lib/paths';
import { mediaFilePaths, legacyDerivedPaths } from '../../../lib/media/files';
import { canManageAllPosts } from '../../../lib/auth';

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    await LocalDB.init();
    const session = locals.user;
    if (!session) return ApiResponseBuilder.unauthorized();

    const body = await request.json().catch(() => null);
    const result = validate<{ id: string }>(body, { id: { type: 'id' } });
    if (!result.ok) return ApiResponseBuilder.validationError('Invalid payload', result.errors);

    const file = await LocalDB.getMediaFile(result.value.id);
    if (!file) return ApiResponseBuilder.notFound('Media');

    // Ownership: editors/admins may delete any file; authors only their own
    // uploads; read-only viewers none at all.
    if (!canManageAllPosts(session.role) && file.uploaded_by !== session.id) {
      return ApiResponseBuilder.forbidden('You can only delete media you uploaded');
    }

    const deleted = await LocalDB.deleteMediaFile(result.value.id);
    if (!deleted) return ApiResponseBuilder.notFound('Media');

    // Remove the underlying file ONLY if no other record still points at it.
    //
    // Filenames are content-addressed (sha1 of the bytes), so two uploads of
    // the same image are two records sharing ONE file. Unlinking
    // unconditionally therefore broke the other record's image permanently,
    // with no warning and no way back — the record still existed, its `url`
    // still looked fine, and the bytes were gone.
    //
    // It was also a privilege escalation: an `author` could re-upload an
    // admin's image (identical bytes -> identical path), delete their OWN copy,
    // and destroy the admin's file. The ownership check above passes, because
    // they really do own the record they are deleting.
    // Remove the underlying files ONLY where no other record still points at
    // them, path by path.
    //
    // Filenames are content-addressed (sha1 of the bytes), so two uploads of
    // the same image are two records sharing ONE set of files. Unlinking
    // unconditionally therefore broke the other record's image permanently,
    // with no warning and no way back — the record still existed, its `url`
    // still looked fine, and the bytes were gone.
    //
    // It was also a privilege escalation: an `author` could re-upload an
    // admin's image (identical bytes -> identical path), delete their OWN copy,
    // and destroy the admin's file. The ownership check above passes, because
    // they really do own the record they are deleting.
    //
    // A record now owns up to six files (original + up to three derivatives,
    // and the aliases `url`/`thumb_url` that point into that set), so the check
    // is per PATH rather than per record: two records may share the original
    // and not the derivatives, or the reverse, once the configured widths
    // change between two uploads of the same photo.
    const owned = mediaFilePaths(file);
    if (owned.length > 0) {
      const remaining = (await LocalDB.getMedia()).filter((m) => m.id !== file.id);
      const stillReferenced = new Set<string>();
      for (const m of remaining) {
        for (const p of mediaFilePaths(m)) stillReferenced.add(p);
        for (const p of legacyDerivedPaths(m)) stillReferenced.add(p);
      }

      const uploadsRoot = getUploadsDir();
      const unlinkInsideUploads = async (webPath: string) => {
        const target = path.resolve(uploadsRoot, webPath.replace(/^\/uploads\//, ''));
        // Path containment: a crafted url must not reach outside the dir.
        if (target.startsWith(uploadsRoot + path.sep)) {
          await fs.unlink(target).catch(() => {});
        }
      };

      for (const p of owned) {
        if (!stillReferenced.has(p)) await unlinkInsideUploads(p);
      }

      // Rows written before thumb_url was persisted: the 400px derivative is
      // only findable by reconstructing the name the old upload path produced.
      for (const p of legacyDerivedPaths(file)) {
        if (!stillReferenced.has(p)) await unlinkInsideUploads(p);
      }
    }

    return ApiResponseBuilder.deleted();
  } catch (err) {
    console.error('Media delete error:', err);
    return ApiResponseBuilder.serverError('Failed to delete media');
  }
};
