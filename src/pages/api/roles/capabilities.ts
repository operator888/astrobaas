/**
 * Reading and editing what a role may do (C-138).
 *
 * ## Admin only, and audited
 *
 * Changing permissions is the kind of edit whose consequences show up somewhere
 * else, weeks later — "why can the shop manager suddenly delete products?" is a
 * question the audit log has to be able to answer, so every change writes one.
 *
 * ## What is not here
 *
 * New role NAMES. A custom role is not a row in a table: it is a value that has
 * to satisfy dozens of `role === 'admin'` comparisons scattered through the
 * routes, every one of which silently answers "no" for a name it has never
 * heard. Shipping that produces a role that can sign in and do nothing, with no
 * message anywhere saying why.
 */
import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { recordAudit, AUDIT } from '../../../lib/audit';
import {
  CAPABILITIES, CAPABILITY_LABELS, EDITABLE_ROLES, ALL_ROLES,
  ROLE_OVERRIDES_SETTING, normaliseOverrides, effectiveCapabilities, builtinCapabilities,
} from '../../../lib/capabilities';

export const prerender = false;

const isAdmin = (locals: App.Locals) => locals.user?.role === 'admin';

export const GET: APIRoute = async ({ locals }) => {
  try {
    if (!isAdmin(locals)) return ApiResponseBuilder.forbidden('Only an admin can read role capabilities');
    await LocalDB.init();
    const overrides = normaliseOverrides((await LocalDB.getSetting(ROLE_OVERRIDES_SETTING))?.value);

    return ApiResponseBuilder.success({
      capabilities: CAPABILITIES.map((c) => ({ id: c, label: CAPABILITY_LABELS[c] })),
      // `admin` is listed so the matrix can SHOW it as fixed rather than
      // leaving an operator wondering where it went — but it is not editable.
      roles: ALL_ROLES.map((role) => ({
        role,
        editable: EDITABLE_ROLES.includes(role),
        builtin: builtinCapabilities(role),
        effective: effectiveCapabilities(role, overrides),
      })),
      overrides,
    }, 'Role capabilities');
  } catch (err) {
    console.error('Role capabilities read error:', err);
    return ApiResponseBuilder.serverError('Could not read role capabilities');
  }
};

export const PUT: APIRoute = async ({ request, locals }) => {
  try {
    if (!isAdmin(locals)) return ApiResponseBuilder.forbidden('Only an admin can change role capabilities');
    await LocalDB.init();

    const body = await request.json().catch(() => null);
    // The WHOLE table, not a patch: the matrix edits the whole thing, and a
    // partial write can express a grant but not a revocation.
    const overrides = normaliseOverrides((body as { overrides?: unknown } | null)?.overrides);

    await LocalDB.updateSetting(ROLE_OVERRIDES_SETTING, overrides);

    // Recorded as the DIFFERENCES, which is what the table holds — a dump of
    // every role's full grant would bury the one line that changed.
    recordAudit(AUDIT.ROLE_CAPS_UPDATE, {
      actor: locals.user?.id ?? 'unknown',
      metadata: { overrides },
    });

    return ApiResponseBuilder.success({
      overrides,
      roles: ALL_ROLES.map((role) => ({ role, effective: effectiveCapabilities(role, overrides) })),
    }, 'Role capabilities updated');
  } catch (err) {
    console.error('Role capabilities write error:', err);
    return ApiResponseBuilder.serverError('Could not update role capabilities');
  }
};
