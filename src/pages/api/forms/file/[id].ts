/**
 * Downloading a file a stranger attached to a submission (C-23).
 *
 * STAFF ONLY, and that is the entire reason the file was written outside
 * `public/uploads` in the first place. If this route were public the private
 * directory would be an elaborate way of achieving nothing.
 *
 * Served as an ATTACHMENT with a nosniff header: a PDF a stranger uploaded is
 * not something to render inline in a staff browser session, and an image that
 * turns out to be something else must not be interpreted at all.
 */
import type { APIRoute } from 'astro';
import { LocalDB } from '../../../../lib/localdb';
import { ApiResponseBuilder } from '../../../../lib/api-response';
import { readPrivateFileMeta, readPrivateFile } from '../../../../lib/media/private-files';

export const prerender = false;

export const GET: APIRoute = async ({ params, locals }) => {
  try {
    await LocalDB.init();

    // Any signed-in staff member. Narrower than "anyone with the link", which
    // is what it was before this route existed; not narrowed per content type,
    // because the id does not say which type it belongs to and inventing a
    // lookup for that would mean scanning every collection on every download.
    const user = locals.user as { role?: string } | null | undefined;
    if (!user) return ApiResponseBuilder.notFound('File');

    const meta = await readPrivateFileMeta(String((params as { id?: string }).id || ''));
    if (!meta) return ApiResponseBuilder.notFound('File');
    const bytes = await readPrivateFile(meta);
    if (!bytes) return ApiResponseBuilder.notFound('File');

    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        'Content-Type': meta.mime_type,
        'Content-Length': String(bytes.length),
        // Attachment, always. A staff browser must not render a stranger's PDF
        // in the same origin as the admin.
        'Content-Disposition': `attachment; filename="${meta.original_name}"`,
        'X-Content-Type-Options': 'nosniff',
        // Never cached by a proxy: this is somebody's personal document.
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (err) {
    console.error('Submission file error:', err);
    return ApiResponseBuilder.serverError('Could not read the file');
  }
};
