import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { getContentType } from '../../../core/content-types';
import { ensurePluginsBootstrapped } from '../../../plugins';
import { recordAudit, AUDIT } from '../../../lib/audit';
import { canAuthorPosts } from '../../../lib/auth';
import { hasCapability, normaliseOverrides, ROLE_OVERRIDES_SETTING } from '../../../lib/capabilities';
import { isPage } from '../../../lib/post-kind';
import { visibleContent } from '../../../lib/visibility';
import {
  collectionKind, transferColumns, exportCsv, rowsForExport,
  planContentImport, readImportRows, MAX_IMPORT_ROWS,
} from '../../../lib/content-transfer';

export const prerender = false;

/**
 * GET  /api/transfer/<collection>  — export
 * POST /api/transfer/<collection>  — import (preview or apply)
 *
 * `<collection>` is `post`, `page`, or the name of any registered content type.
 *
 * ## One route, three collections, on purpose
 *
 * The roadmap phrased C-91 as CSV import "for content types", which reads like
 * a feature for custom types only. Two routes would have meant two exporters,
 * two importers, and two answers to "what does a boolean look like in a
 * spreadsheet" — and a rule fixed in one place and missed in its sibling is
 * this codebase's most reliable bug shape. The collection is a parameter.
 *
 * ## Export is what an operator can leave with
 *
 * That is the point of the row: a CMS you cannot get your content out of is one
 * you cannot leave. Both formats are lossless in the round trip, and the CSV
 * writer defuses formula cells so opening your own export in Excel is not an
 * attack surface.
 *
 * ## Import previews by default
 *
 * `POST` with no `apply` returns the PLAN — what each row would do and why any
 * row would be skipped — computed by the identical function that then performs
 * it. An operator sees "12 updates, 3 creates, 1 skipped: row 7 has no slug"
 * before anything is written.
 */

/** Import writes site-wide content. Same gate the WordPress importer uses. */
async function mayImport(locals: App.Locals): Promise<boolean> {
  const overrides = normaliseOverrides((await LocalDB.getSetting(ROLE_OVERRIDES_SETTING))?.value);
  return hasCapability(locals.user?.role, 'import_content', overrides);
}

/**
 * The collection, as THIS viewer is allowed to see it.
 *
 * `viewer` is not optional and the filter is not skippable. The first version
 * of this function read every post regardless — which handed any `author` the
 * full body of every colleague's draft, every embargoed announcement and every
 * trashed post, through a route whose own comment said "anyone who may write
 * content may take it away".
 *
 * That is the same defect `/api/posts` fixed and left a comment about:
 * "Authentication is not authorization." An export is the widest possible read,
 * so it is the last place to re-decide visibility for itself — it asks
 * `visibleContent`, the module the codebase designated as the single decider.
 */
async function loadCollection(
  name: string,
  viewer: App.Locals['user'],
): Promise<Record<string, unknown>[] | null> {
  const kind = collectionKind(name);
  if (kind === 'custom') {
    const def = getContentType(name);
    if (!def) return null;
    const rows = await LocalDB.getCustomEntities(name);
    // Stored as { id, type, data }, exported as the record an operator edits.
    return rows.map((r: any) => ({ id: r.id, ...(r.data ?? {}) }));
  }
  const posts = visibleContent(await LocalDB.getPosts(), viewer);
  return posts.filter((p) => (kind === 'page') === isPage(p)) as unknown as Record<string, unknown>[];
}

export const GET: APIRoute = async ({ params, url, locals }) => {
  try {
    if (!locals.user) return ApiResponseBuilder.unauthorized();
    // Reading everything a collection holds is an export of the whole site's
    // content. Anyone who may write content may take it away; nobody else.
    if (!canAuthorPosts(locals.user.role)) {
      return ApiResponseBuilder.forbidden('Your role cannot export content');
    }
    await LocalDB.init();
    await ensurePluginsBootstrapped();

    const name = String(params.collection || '');
    const records = await loadCollection(name, locals.user);
    if (!records) return ApiResponseBuilder.notFound('Collection');
    const def = collectionKind(name) === 'custom' ? getContentType(name) : undefined;

    const format = new URL(url).searchParams.get('format') === 'json' ? 'json' : 'csv';
    const stamp = new Date().toISOString().slice(0, 10);
    const filename = `${name}-${stamp}.${format}`;

    if (format === 'json') {
      return new Response(JSON.stringify({ collection: name, columns: transferColumns(name, def), rows: rowsForExport(name, records, def) }, null, 2), {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename="${filename}"`,
        },
      });
    }

    // The BOM is not decoration: without it Excel reads a UTF-8 export as the
    // system code page, and every Greek title in it becomes mojibake.
    return new Response('﻿' + exportCsv(name, records, def), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    console.error('Content export error:', err);
    return ApiResponseBuilder.serverError('Could not export that collection');
  }
};

export const POST: APIRoute = async ({ params, request, locals }) => {
  try {
    if (!locals.user) return ApiResponseBuilder.unauthorized();
    await LocalDB.init();
    if (!(await mayImport(locals))) {
      return ApiResponseBuilder.forbidden('Your role cannot import content');
    }
    await ensurePluginsBootstrapped();

    const name = String(params.collection || '');
    // The IMPORT side sees the same slice. Matching against a record the
    // caller cannot see would let them overwrite it by guessing a slug — and
    // report it as an update they can then read back.
    const existing = await loadCollection(name, locals.user);
    if (!existing) return ApiResponseBuilder.notFound('Collection');
    const def = collectionKind(name) === 'custom' ? getContentType(name) : undefined;

    const body = await request.json().catch(() => null) as
      { body?: unknown; format?: unknown; apply?: unknown } | null;
    const text = typeof body?.body === 'string' ? body.body : '';
    if (!text.trim()) return ApiResponseBuilder.badRequest('The file is empty.');
    const format = body?.format === 'json' ? 'json' : 'csv';

    let rows: Record<string, string>[];
    try {
      rows = readImportRows(text, format);
    } catch (err) {
      return ApiResponseBuilder.badRequest(err instanceof Error ? err.message : 'Could not read that file.');
    }
    if (rows.length > MAX_IMPORT_ROWS) {
      return ApiResponseBuilder.badRequest(`That file has ${rows.length} rows; the limit is ${MAX_IMPORT_ROWS}.`);
    }

    const plan = planContentImport(name, rows, existing, def);
    if (body?.apply !== true) {
      // The preview. Same function, nothing written.
      return ApiResponseBuilder.success(plan, 'Import preview');
    }

    let created = 0, updated = 0;
    const failures: string[] = [];
    for (const row of plan.rows) {
      if (row.action === 'skip') continue;
      try {
        if (collectionKind(name) === 'custom') {
          if (row.action === 'create') { await LocalDB.createCustomEntity(name, row.values); created += 1; }
          else { await LocalDB.updateCustomEntity(name, row.id!, row.values); updated += 1; }
        } else if (row.action === 'create') {
          await LocalDB.createPost({
            title: '', slug: '', content: '', status: 'draft',
            // The KIND comes from the route, not from the file: a page imported
            // through /api/transfer/post would otherwise appear at /blog/<slug>
            // and be unreachable at its own address.
            kind: name === 'page' ? 'page' : 'post',
            author_id: locals.user!.id,
            views: 0,
            ...row.values,
          } as any);
          created += 1;
        } else {
          await LocalDB.updatePost(row.id!, row.values as any);
          updated += 1;
        }
      } catch (err) {
        failures.push(`row ${row.line}: ${err instanceof Error ? err.message : 'failed'}`);
      }
    }

    // Audited for the same reason the WordPress import is: it writes content
    // site-wide in one call and cannot be undone.
    recordAudit(AUDIT.CONTENT_IMPORT, {
      actor: locals.user!.id,
      metadata: { collection: name, format, created, updated, skipped: plan.skipped, failures: failures.length },
    });

    return ApiResponseBuilder.success(
      { collection: name, created, updated, skipped: plan.skipped, failures },
      `Imported ${created + updated} record${created + updated === 1 ? '' : 's'}`,
    );
  } catch (err) {
    console.error('Content import error:', err);
    return ApiResponseBuilder.serverError('Could not import that file');
  }
};
