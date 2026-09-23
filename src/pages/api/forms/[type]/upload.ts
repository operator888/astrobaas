/**
 * A file attached to a public form submission (C-23).
 *
 * ## Where the bytes go, and why it is not `/uploads`
 *
 * Somewhere no static handler is told about — see `lib/media/private-files.ts`.
 * The one-line version: `public/uploads` is world-readable at its URL whatever
 * the record's read policy says, so a type marked `visibility: 'staff'`
 * collecting CVs would have been publishing them.
 *
 * ## The answer carries an id and nothing else
 *
 * Not a URL. An endpoint that answered with a fetchable link would be a public
 * file host with an upload form, and the first thing it would host is somebody
 * else's malware.
 *
 * ## Gates
 *
 * The same order as every other anonymous write — rate limit, honeypot,
 * proof of work — through the shared gate, with a TIGHTER limit than a text
 * submission: bytes cost disk and a text field does not.
 */
import type { APIRoute } from 'astro';
import { LocalDB } from '../../../../lib/localdb';
import { ApiResponseBuilder } from '../../../../lib/api-response';
import { getContentType, contentTypeAcceptsPublicWrites } from '../../../../core/content-types';
import { ensurePluginsBootstrapped } from '../../../../plugins';
import { sharedRateLimitStore } from '../../../../lib/rate-limit';
import { captchaCheck } from '../../../../lib/captcha';
import {
  storePrivateFile, MAX_SUBMISSION_FILE_SIZE, resolveFormUploadQuota, FORM_UPLOAD_QUOTA_KEY,
  QUOTA_EXCEEDED_REASON,
} from '../../../../lib/media/private-files';
import { fieldsOfType } from '../../../../lib/field-walk';
import { POW_FIELD } from '../../../../lib/public-submission';

export const prerender = false;

/** Tighter than a text submission's ten: each of these costs disk. */
const UPLOAD_WINDOW_MS = 15 * 60 * 1000;
const UPLOAD_LIMIT = 5;

export const POST: APIRoute = async ({ params, request, locals }) => {
  try {
    await LocalDB.init();
    await ensurePluginsBootstrapped();

    const type = String((params as { type?: string }).type || '');
    const def = getContentType(type);
    // One 404 for "no such type", "that type takes no public submissions" and
    // "that type has no file field". Telling them apart is an oracle for what
    // a site stores — the same discipline /api/forms/<type> follows.
    if (!def || !contentTypeAcceptsPublicWrites(def)) return ApiResponseBuilder.notFound('Form');
    if (fieldsOfType(def, 'file').length === 0) return ApiResponseBuilder.notFound('Form');

    const allowed = await sharedRateLimitStore().hit(
      `upload:${type}|${locals.ip ?? 'unknown'}`, UPLOAD_WINDOW_MS, UPLOAD_LIMIT,
    );
    if (!allowed) {
      return ApiResponseBuilder.error(429, 'Too many uploads. Please try again later.');
    }

    const form = await request.formData().catch(() => null);
    if (!form) return ApiResponseBuilder.badRequest('Expected a file upload');

    // The honeypot travels with the upload too: a bot that posts the form also
    // posts the file, and catching it here saves the disk write.
    const hp = form.get('hp_url');
    if (typeof hp === 'string' && hp.trim() !== '') {
      // Same lie the text path tells — a plausible id that points at nothing.
      return ApiResponseBuilder.created({ id: null }, 'Received');
    }

    const pow = await captchaCheck(form.get(POW_FIELD), 'forms');
    if (!pow.ok) return ApiResponseBuilder.forbidden('Please try again (anti-spam check failed)');

    const file = form.get('file');
    if (!file || typeof file === 'string') return ApiResponseBuilder.badRequest('No file was sent');
    if (file.size > MAX_SUBMISSION_FILE_SIZE) {
      return ApiResponseBuilder.badRequest(
        `Files must be under ${Math.floor(MAX_SUBMISSION_FILE_SIZE / (1024 * 1024))} MB.`,
      );
    }

    // The form is recorded with the file, which is what the per-form quota adds
    // up and what the orphan sweep looks in — see lib/media/private-files.ts.
    const quotaBytes = resolveFormUploadQuota({
      [FORM_UPLOAD_QUOTA_KEY]: (await LocalDB.getSetting(FORM_UPLOAD_QUOTA_KEY))?.value,
    });
    const stored = await storePrivateFile(Buffer.from(await file.arrayBuffer()), file.name, {
      form: type,
      quotaBytes,
    });
    if (!stored.ok && stored.reason === 'quota') {
      // 413, not 507: 507 would be reported as INTERNAL_SERVER_ERROR by the
      // shared envelope, and nothing is broken — this form is full. The reason
      // code tells a storefront it is not the file's size.
      return ApiResponseBuilder.error(413, stored.error, undefined, { code: QUOTA_EXCEEDED_REASON });
    }
    if (!stored.ok) return ApiResponseBuilder.badRequest(stored.error);

    // The id, the name and the size. No URL, and nothing about where on disk.
    return ApiResponseBuilder.created({
      id: stored.file.id,
      original_name: stored.file.original_name,
      size: stored.file.size,
    }, 'File received');
  } catch (err) {
    console.error('Submission upload error:', err);
    return ApiResponseBuilder.serverError('Could not accept the file');
  }
};
