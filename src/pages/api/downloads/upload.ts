/**
 * POST /api/downloads/upload — a merchant uploads a file to SELL (multipart,
 * field `file`). Staff with catalogue rights only.
 *
 * The bytes go to the PRIVATE uploads directory (lib/media/private-files.ts),
 * not to `public/uploads`: a file in `public/uploads` is readable at its URL by
 * anyone, which is exactly what a paid download must not be. The answer is a
 * reference, `private:pf_<id>`, to paste into the product's Downloads list —
 * no URL, because there is none: the file is only ever served through a
 * buyer's signed link (/api/downloads/{token}).
 *
 * Type is decided by magic bytes (PDF, ZIP, EPUB, MP3, PNG, JPEG, GIF, WebP),
 * the size cap is MAX_PRODUCT_FILE_SIZE (100 MB, `DOWNLOAD_MAX_FILE_MB`), and
 * the virus scan runs as on every other upload door. No form is recorded, so
 * the orphan sweep for abandoned form uploads never touches these.
 */
import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { canManageCatalog } from '../../../lib/auth';
import { storePrivateFile, MAX_PRODUCT_FILE_SIZE } from '../../../lib/media/private-files';
import { PRIVATE_DOWNLOAD_PREFIX } from '../../../lib/product-fields';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    await LocalDB.init();
    const user = locals.user as { role?: string } | null | undefined;
    if (!user) return ApiResponseBuilder.unauthorized();
    if (!canManageCatalog(user.role)) return ApiResponseBuilder.forbidden('Your role cannot manage products');

    const form = await request.formData().catch(() => null);
    if (!form) return ApiResponseBuilder.badRequest('Expected a file upload');
    const file = form.get('file');
    if (!file || typeof file === 'string') return ApiResponseBuilder.badRequest('No file was sent');
    if (file.size > MAX_PRODUCT_FILE_SIZE) {
      return ApiResponseBuilder.error(413, `Files must be under ${Math.floor(MAX_PRODUCT_FILE_SIZE / (1024 * 1024))} MB.`);
    }
    const stored = await storePrivateFile(Buffer.from(await file.arrayBuffer()), file.name, { purpose: 'product' });
    if (!stored.ok) return ApiResponseBuilder.badRequest(stored.error);
    return ApiResponseBuilder.created({
      url: `${PRIVATE_DOWNLOAD_PREFIX}${stored.file.id}`,
      original_name: stored.file.original_name,
      mime_type: stored.file.mime_type,
      size: stored.file.size,
    }, 'File stored privately');
  } catch (err) {
    console.error('Download upload error:', err);
    return ApiResponseBuilder.serverError('Could not store the file');
  }
};
