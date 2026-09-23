import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { canImportContent } from '../../../lib/auth';
import { sharedRateLimitStore } from '../../../lib/rate-limit';
import { recordAudit, AUDIT } from '../../../lib/audit';
import { parseWxr, WxrParseError } from '../../../lib/import/wxr';
import { planImport, summarisePlan } from '../../../lib/import/plan';
import { applyImport } from '../../../lib/import/apply';
import { MAX_HTTP_WXR_BYTES, HTTP_MEDIA_CAP } from '../../../lib/import/limits';

/**
 * Import a WordPress site.
 *
 * The whole reason someone tries this CMS at all is that they have a
 * WordPress site and want off it. That makes this the first thing many people
 * will run, against their real content, once — which is why it is built the
 * way it is:
 *
 *  - **Dry run by default.** Sending the file reports what WOULD happen and
 *    writes nothing. Performing an import takes an explicit `dry_run=false`.
 *    Nobody should discover what this tool decided by finding out afterwards.
 *  - **Admin only.** See `canImportContent` — this writes site-wide redirects
 *    and cannot be undone.
 *  - **Throttled.** An import is the most expensive operation this server
 *    offers; it parses tens of megabytes and can fetch hundreds of files.
 *
 * Large exports belong on the CLI (`node scripts/import-wp.mjs`), which has no
 * HTTP timeout to lose against and no upload cap. This endpoint exists so the
 * common case — a small blog, an operator with no shell — works from the admin.
 */
export const prerender = false;


const WINDOW_MS = 60 * 60 * 1000;
const LIMIT = 10;

/** A form field that is only true when it says so. */
function flag(form: FormData, name: string, dflt: boolean): boolean {
  const raw = form.get(name);
  if (raw === null) return dflt;
  const v = String(raw).trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes' || v === 'on') return true;
  if (v === 'false' || v === '0' || v === 'no' || v === 'off') return false;
  return dflt;
}

/**
 * Custom post types the operator asked for, as a strict allow-list.
 *
 * WordPress type names are `[a-z0-9_-]` by its own register_post_type rules,
 * so anything else in this field is either a mistake or someone probing. It is
 * rejected rather than sanitized: silently accepting `portfolio; drop` as
 * `portfolio` teaches an operator that the field is forgiving, and the next
 * field they try it on might be.
 */
function parseExtraTypes(raw: string): { types: string[] } | { error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { types: [] };
  const types = trimmed.split(',').map((t) => t.trim()).filter(Boolean);
  if (types.length > 20) return { error: 'Too many custom post types (max 20)' };
  for (const t of types) {
    if (!/^[a-z0-9_-]{1,32}$/.test(t)) {
      return { error: `"${t}" is not a valid WordPress post type name` };
    }
  }
  return { types };
}

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const user = locals.user;
    if (!user) return ApiResponseBuilder.unauthorized();
    if (!canImportContent(user.role)) {
      return ApiResponseBuilder.forbidden('Only an administrator can import a site');
    }

    const allowed = await sharedRateLimitStore().hit(`import:${user.id}`, WINDOW_MS, LIMIT);
    if (!allowed) {
      return ApiResponseBuilder.error(429, 'Too many imports. Try again later.');
    }

    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File)) {
      return ApiResponseBuilder.badRequest('No export file provided');
    }
    if (file.size === 0) {
      return ApiResponseBuilder.badRequest('The export file is empty');
    }
    if (file.size > MAX_HTTP_WXR_BYTES) {
      return ApiResponseBuilder.badRequest(
        `That export is larger than ${Math.round(MAX_HTTP_WXR_BYTES / 1024 / 1024)} MB. `
        + 'Run it from the command line instead: node scripts/import-wp.mjs <file.xml>',
      );
    }

    const extra = parseExtraTypes(String(form.get('extra_types') ?? ''));
    if ('error' in extra) return ApiResponseBuilder.badRequest(extra.error);

    let doc;
    try {
      doc = parseWxr(await file.text());
    } catch (err) {
      if (err instanceof WxrParseError) return ApiResponseBuilder.badRequest(err.message);
      throw err;
    }

    const plan = planImport(doc, {
      includePages: flag(form, 'include_pages', true),
      includeMedia: flag(form, 'include_media', true),
      includeTrash: flag(form, 'include_trash', false),
      extraTypes: extra.types,
    });

    // The default. Performing an import is the exception, and has to be asked
    // for in as many words.
    const dryRun = flag(form, 'dry_run', true);
    const fetchMedia = flag(form, 'fetch_media', false);

    await LocalDB.init();
    const result = await applyImport(plan, user.id, {
      dryRun,
      fetchMedia,
      maxMedia: HTTP_MEDIA_CAP,
    });

    if (!dryRun) {
      recordAudit(AUDIT.CONTENT_IMPORT, {
        actor: user.id,
        target: doc.siteUrl ?? 'wordpress-export',
        ip: locals.ip,
        metadata: {
          posts: result.createdPosts,
          pages: result.createdPages,
          categories: result.createdCategories,
          redirects: result.createdRedirects,
          media: result.importedMedia,
          skipped: result.skipped.length,
          failed: result.failed.length,
        },
      });
    }

    return ApiResponseBuilder.success(
      {
        ...result,
        summary: summarisePlan(plan),
        // Reported, never acted on: the operator invites these people
        // themselves. See the note in applyImport.
        authors: plan.authors,
        source_site: doc.siteUrl,
      },
      dryRun
        ? 'Dry run — nothing was written. Send dry_run=false to perform the import.'
        : 'Import complete',
    );
  } catch (err) {
    console.error('WordPress import error:', err);
    return ApiResponseBuilder.serverError('Failed to import the export file');
  }
};
