import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { ensurePluginsBootstrapped, reloadPlugins } from '../../../plugins';
import {
  getContentTypes, validateContentTypeDefinitions, ADMIN_CONTENT_TYPES_SETTING,
} from '../../../core/content-types';
import { recordAudit, AUDIT } from '../../../lib/audit';

/**
 * Content-type definitions — the ACF-shaped admin capability.
 *
 * GET  — every REGISTERED type (plugin- and admin-defined), with its field
 *        schema, so the entries screen can render a form without a second
 *        vocabulary. Staff-only: a field schema is a map of what the business
 *        stores, which is reconnaissance if it leaks.
 * PUT  — replace the full set of ADMIN-DEFINED types. Admin only. The whole
 *        set rather than per-type patches, because the builder edits the whole
 *        set and a partial write can express neither a rename nor a delete.
 *
 * Writes re-run the plugin bootstrap, so a new type answers on
 * `/api/content/<name>` on the very next request — no restart, which is the
 * difference between "the admin can define types" and "the admin can define
 * types after calling whoever restarts the server".
 */
export const prerender = false;

export const GET: APIRoute = async ({ locals }) => {
  try {
    const role = locals.user?.role;
    if (!role) return ApiResponseBuilder.unauthorized();
    await LocalDB.init();
    await ensurePluginsBootstrapped();

    const stored = (await LocalDB.getSetting(ADMIN_CONTENT_TYPES_SETTING))?.value;
    const adminNames = new Set(
      Array.isArray(stored) ? stored.map((d: { name?: unknown }) => String(d?.name ?? '')) : [],
    );

    const types = getContentTypes().map((t) => ({
      name: t.name,
      label: t.label,
      labelPlural: t.labelPlural,
      visibility: t.visibility ?? 'staff',
      // writable and notifyOnSubmission MUST be projected: the admin builder
      // rebuilds its whole editable set from this GET and PUTs it straight
      // back, so anything omitted here is silently stripped on the next save.
      // Omitting `writable` turned every form back into a staff-only type the
      // moment the operator edited anything — the feature quietly uninstalling
      // itself.
      writable: t.writable ?? 'staff',
      notifyOnSubmission: t.notifyOnSubmission === true,
      fields: t.fields,
      // Which door it came in through. The builder may only edit its own;
      // plugin types render read-only with the plugin named as the owner.
      source: adminNames.has(t.name) ? 'admin' : 'plugin',
    }));

    return ApiResponseBuilder.success(types, undefined, { total: types.length });
  } catch (err) {
    console.error('Content types list error:', err);
    return ApiResponseBuilder.serverError('Failed to list content types');
  }
};

export const PUT: APIRoute = async ({ request, locals }) => {
  try {
    if (locals.user?.role !== 'admin') return ApiResponseBuilder.forbidden('Admin only');
    await LocalDB.init();
    await ensurePluginsBootstrapped();

    const body = await request.json().catch(() => null);
    const checked = validateContentTypeDefinitions(body);
    if (!checked.ok) {
      return ApiResponseBuilder.validationError(
        'These definitions would not work',
        Object.fromEntries(checked.errors.map((e, i) => [String(i), e])),
      );
    }

    await LocalDB.updateSetting(ADMIN_CONTENT_TYPES_SETTING, checked.defs);
    // Re-register NOW. A definition that needs a restart to exist is a builder
    // the admin will correctly conclude is broken.
    await reloadPlugins();

    recordAudit(AUDIT.CONTENT_TYPES_UPDATE, {
      actor: locals.user?.id ?? 'unknown',
      target: ADMIN_CONTENT_TYPES_SETTING,
      ip: locals.ip,
      metadata: { types: checked.defs.map((d) => d.name) },
    });
    return ApiResponseBuilder.success(checked.defs, 'Content types saved');
  } catch (err) {
    console.error('Content types update error:', err);
    return ApiResponseBuilder.serverError('Failed to save content types');
  }
};
