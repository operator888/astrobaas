import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { canManageCatalog } from '../../../lib/auth';
import { validateRule, normalizePathPattern, type RedirectRule } from '../../../lib/legacy/redirects';
import { reloadRedirects } from '../../../lib/legacy/redirect-store';
import { recordAudit, AUDIT } from '../../../lib/audit';

export const prerender = false;

/** PUT /api/redirects/[id] — edit, including enabling and disabling. */
export const PUT: APIRoute = async ({ params, request, locals }) => {
  try {
    if (!canManageCatalog(locals.user?.role)) {
      return ApiResponseBuilder.forbidden('Your role cannot manage redirects');
    }
    await LocalDB.init();
    const rules = await LocalDB.getRedirects();
    const existing = rules.find((r) => r.id === params.id);
    if (!existing) return ApiResponseBuilder.notFound('Redirect');

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') return ApiResponseBuilder.badRequest('Invalid payload');
    const b = body as Partial<RedirectRule>;

    const merged: RedirectRule = {
      ...existing,
      match: b.match !== undefined ? normalizePathPattern(String(b.match)) : existing.match,
      target: b.target !== undefined ? String(b.target).trim() : existing.target,
      status: b.status !== undefined ? (Number(b.status) as RedirectRule['status']) : existing.status,
      enabled: b.enabled !== undefined ? b.enabled !== false : existing.enabled,
      notes: b.notes !== undefined ? String(b.notes).slice(0, 500) : existing.notes,
      updated_at: new Date().toISOString(),
    };
    // A 410 has no destination; clearing it here means switching an existing
    // 301 to 410 does not leave a stale target behind to confuse the next reader.
    if (merged.status === 410) merged.target = '';

    const problems = validateRule(merged);
    if (problems.length) {
      return ApiResponseBuilder.validationError(
        'This redirect would not work',
        Object.fromEntries(problems.map((p) => [p.field, p.message])),
      );
    }
    if (rules.some((r) => r.id !== merged.id && r.match === merged.match)) {
      return ApiResponseBuilder.badRequest(`A redirect for "${merged.match}" already exists`);
    }

    await LocalDB.saveRedirect(merged);
    await reloadRedirects();
    recordAudit(AUDIT.REDIRECT_UPDATE, {
      actor: locals.user?.id ?? 'unknown',
      target: merged.id,
      ip: locals.ip,
      metadata: { redirect: merged.match, to: merged.target, status: merged.status, enabled: merged.enabled },
    });
    return ApiResponseBuilder.success(merged, 'Redirect updated');
  } catch (err) {
    console.error('Redirect update error:', err);
    return ApiResponseBuilder.serverError('Failed to update redirect');
  }
};

/** DELETE /api/redirects/[id] */
export const DELETE: APIRoute = async ({ params, locals }) => {
  try {
    if (!canManageCatalog(locals.user?.role)) {
      return ApiResponseBuilder.forbidden('Your role cannot manage redirects');
    }
    await LocalDB.init();
    const removed = await LocalDB.deleteRedirect(String(params.id));
    if (!removed) return ApiResponseBuilder.notFound('Redirect');
    await reloadRedirects();
    recordAudit(AUDIT.REDIRECT_DELETE, {
      actor: locals.user?.id ?? 'unknown',
      target: String(params.id),
      ip: locals.ip,
      metadata: { redirect_deleted: true },
    });
    return ApiResponseBuilder.success({ id: params.id, deleted: true }, 'Redirect removed');
  } catch (err) {
    console.error('Redirect delete error:', err);
    return ApiResponseBuilder.serverError('Failed to delete redirect');
  }
};
