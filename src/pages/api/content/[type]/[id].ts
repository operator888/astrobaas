import type { APIRoute } from 'astro';
import { LocalDB } from '../../../../lib/localdb';
import { checkReferences, resolveMediaUrls } from '../../../../lib/content-refs';
import { ApiResponseBuilder } from '../../../../lib/api-response';
import { validate } from '../../../../lib/validate';
import { getContentType, schemaForContentType, contentTypeIsPublic } from '../../../../core/content-types';
import { ensurePluginsBootstrapped } from '../../../../plugins';
import { fireEvent } from '../../../../lib/webhooks';
import { isPubliclyVisible, isModerationState, MODERATION_STATES, STATUS_KEY } from '../../../../core/moderation';

// GET    /api/content/<type>/<id> — fetch one (public read, like the list).
// PUT    /api/content/<type>/<id> — update (admin/editor).
// DELETE /api/content/<type>/<id> — delete (admin/editor).

/**
 * Fetch a single entity, under the SAME read policy as the list endpoint.
 *
 * The two must agree: a collection private at `/api/content/enquiry` and
 * readable at `/api/content/enquiry/<id>` is not private, it just requires
 * guessing an id — and ids are handed out by anything that ever leaks one.
 * Both routes therefore ask `contentTypeIsPublic()` rather than each carrying
 * their own rule.
 */
import {
  TAXONOMIES_SETTING, TERMS_FIELD, validateTaxonomies, cleanTerms,
} from '../../../../core/taxonomy';

export const GET: APIRoute = async ({ params, locals }) => {
  try {
    await LocalDB.init();
    await ensurePluginsBootstrapped();
    const type = String(params.type || '');
    // Unregistered types 404 rather than exposing raw storage.
    const def = getContentType(type);
    if (!def) return ApiResponseBuilder.notFound('Content type');

    // D2-4: private unless the type declares `visibility: 'public'`. Same 404
    // as an unregistered type — existence is information.
    if (!contentTypeIsPublic(def) && !locals.user) {
      return ApiResponseBuilder.notFound('Content type');
    }

    const entity = await LocalDB.getCustomEntity(type, String(params.id || ''));
    if (!entity) return ApiResponseBuilder.notFound('Entity');
    // A record awaiting approval is not public, and it 404s rather than 403s:
    // "that comment exists but you may not see it" is still a disclosure that
    // it exists. The LIST endpoint filters the same way, from the same module.
    if (def.moderated && !locals.user && !isPubliclyVisible((entity as { data?: Record<string, unknown> }).data)) {
      return ApiResponseBuilder.notFound('Entity');
    }
    // The same resolution the list does, from the same function: a reader must
    // not get a picture on one endpoint and a bare id on the other.
    const [resolved] = await resolveMediaUrls(def, [entity as { data?: Record<string, unknown> }]);
    return ApiResponseBuilder.success(resolved, 'Entity retrieved successfully');
  } catch (err) {
    console.error('Custom content get error:', err);
    return ApiResponseBuilder.serverError('Failed to fetch entity');
  }
};

export const PUT: APIRoute = async ({ params, request, locals }) => {
  try {
    await LocalDB.init();
    await ensurePluginsBootstrapped();
    const session = locals.user;
    if (!session || (session.role !== 'admin' && session.role !== 'editor')) {
      return ApiResponseBuilder.forbidden('Only admins and editors can edit content');
    }
    const type = String(params.type || '');
    const def = getContentType(type);
    if (!def) return ApiResponseBuilder.notFound('Content type');

    const body = await request.json().catch(() => null);
    const schema = schemaForContentType(def);
    // All fields optional on update: reuse the schema but tolerate partials by
    // validating only the provided keys.
    const partialSchema = Object.fromEntries(
      Object.entries(schema).map(([k, rule]) => [k, { ...rule, optional: true }]),
    );
    const result = validate(body, partialSchema);
    if (!result.ok) return ApiResponseBuilder.validationError(`Invalid ${def.label}`, result.errors);

    // Moving a record between approval states (C-142, C-35). Read from the
    // body EXPLICITLY rather than through the field schema, because `_status`
    // is not a declared field — it is set by the server and read as authority,
    // and a declared field of that name would let a submitter post their own
    // approval. Only staff reach this handler at all.
    const requestedStatus = (body as Record<string, unknown> | null)?.[STATUS_KEY];
    if (requestedStatus !== undefined && !isModerationState(requestedStatus)) {
      return ApiResponseBuilder.validationError(`Invalid ${def.label}`, {
        [STATUS_KEY]: `must be one of: ${MODERATION_STATES.join(', ')}`,
      });
    }

    // CLEARING an optional field. validate() treats '' and null as absent and
    // the update MERGES, so there was no way to empty a field once set — a
    // typo in an optional URL was permanent. An explicit null (or empty
    // string) for a declared OPTIONAL field is taken as "remove it": the key
    // is set to undefined so the merge drops it. A required field cannot be
    // cleared this way — validate() already refused the empty value above,
    // except it is optional-in-the-partial, so we re-check against the real
    // schema's optional flag.
    const value = result.value as Record<string, unknown>;
    if (body && typeof body === 'object') {
      for (const [k, rule] of Object.entries(schema)) {
        const provided = (body as Record<string, unknown>)[k];
        const isClear = provided === null || provided === '';
        if (isClear && (rule as { optional?: boolean }).optional && !(k in value)) {
          value[k] = undefined;
        }
      }
    }

    // Only what this write actually sets is checked — the body is partial, and
    // a reference nobody touched is not this request's business.
    const dangling = await checkReferences(def, value);
    if (dangling) return ApiResponseBuilder.validationError(`Invalid ${def.label}`, dangling);

    // Custom taxonomies (C-128), on the UPDATE path as well as create — the
    // sibling gap this codebase keeps paying for. A present-but-empty map means
    // "remove them all", so `undefined` is written rather than the key being
    // skipped: the storage layer merges, and an absent key would silently keep
    // the old assignment.
    const rawTerms = (body as Record<string, unknown> | null)?.[TERMS_FIELD];
    let termPatch: Record<string, unknown> = {};
    if (rawTerms !== undefined) {
      const taxonomyDefs = validateTaxonomies((await LocalDB.getSetting(TAXONOMIES_SETTING))?.value).defs;
      termPatch = { [TERMS_FIELD]: cleanTerms(rawTerms, taxonomyDefs, type) };
    }

    const updated = await LocalDB.updateCustomEntity(type, String(params.id), {
      ...(value as Record<string, any>),
      ...termPatch,
      ...(requestedStatus !== undefined ? { [STATUS_KEY]: requestedStatus } : {}),
    });
    if (!updated) return ApiResponseBuilder.notFound(def.label);
    fireEvent('content.updated', { type, entity: updated }).catch(() => {});
    return ApiResponseBuilder.success(updated, `${def.label} updated successfully`);
  } catch (err) {
    console.error('Custom content update error:', err);
    return ApiResponseBuilder.serverError('Failed to update entity');
  }
};

export const DELETE: APIRoute = async ({ params, locals }) => {
  try {
    await LocalDB.init();
    await ensurePluginsBootstrapped();
    const session = locals.user;
    if (!session || (session.role !== 'admin' && session.role !== 'editor')) {
      return ApiResponseBuilder.forbidden('Only admins and editors can delete content');
    }
    const type = String(params.type || '');
    const def = getContentType(type);
    if (!def) return ApiResponseBuilder.notFound('Content type');

    const ok = await LocalDB.deleteCustomEntity(type, String(params.id));
    if (!ok) return ApiResponseBuilder.notFound(def.label);
    fireEvent('content.deleted', { type, id: String(params.id) }).catch(() => {});
    return ApiResponseBuilder.deleted();
  } catch (err) {
    console.error('Custom content delete error:', err);
    return ApiResponseBuilder.serverError('Failed to delete entity');
  }
};
