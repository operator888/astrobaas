import type { APIRoute } from 'astro';
import crypto from 'node:crypto';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { canManageCatalog } from '../../../lib/auth';
import { validateRule, normalizePathPattern, type RedirectRule } from '../../../lib/legacy/redirects';
import { reloadRedirects } from '../../../lib/legacy/redirect-store';
import { recordAudit, AUDIT } from '../../../lib/audit';

/**
 * The redirect map, managed by the shop.
 *
 * Gated on `canManageCatalog` — the same predicate that governs products —
 * because a MANAGER is exactly who this is for. The whole point is that the
 * person who notices a dead URL can fix it without an ops person and a deploy.
 */
export const prerender = false;

/** See the check in POST for why the map is bounded. */
const MAX_RULES = 5000;

/** GET /api/redirects — the whole map. Staff-only; it is a small table. */
export const GET: APIRoute = async ({ locals }) => {
  try {
    if (!canManageCatalog(locals.user?.role)) {
      return ApiResponseBuilder.forbidden('Your role cannot manage redirects');
    }
    await LocalDB.init();
    const rules = await LocalDB.getRedirects();
    // Newest first: an operator working through a 404 report wants what they
    // just added at the top.
    rules.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    return ApiResponseBuilder.success(rules, undefined, { total: rules.length });
  } catch (err) {
    console.error('Redirect list error:', err);
    return ApiResponseBuilder.serverError('Failed to list redirects');
  }
};

/** POST /api/redirects — create one. */
export const POST: APIRoute = async ({ request, locals }) => {
  try {
    if (!canManageCatalog(locals.user?.role)) {
      return ApiResponseBuilder.forbidden('Your role cannot manage redirects');
    }
    await LocalDB.init();
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') return ApiResponseBuilder.badRequest('Invalid payload');

    const problems = validateRule(body as Partial<RedirectRule>);
    if (problems.length) {
      return ApiResponseBuilder.validationError(
        'This redirect would not work',
        Object.fromEntries(problems.map((p) => [p.field, p.message])),
      );
    }

    const now = new Date().toISOString();
    const status = Number((body as { status?: unknown }).status) as RedirectRule['status'];
    const rule: RedirectRule = {
      id: crypto.randomUUID(),
      match: normalizePathPattern(String((body as { match?: unknown }).match ?? '')),
      target: status === 410 ? '' : String((body as { target?: unknown }).target ?? '').trim(),
      status,
      enabled: (body as { enabled?: unknown }).enabled !== false,
      notes: typeof (body as { notes?: unknown }).notes === 'string'
        ? String((body as { notes?: unknown }).notes).slice(0, 500)
        : undefined,
      hits: 0,
      created_at: now,
      updated_at: now,
    };

    const existing = await LocalDB.getRedirects();
    // Bounded. Exact matches are a Map lookup, but PATTERN rules are walked in
    // order on every unmatched request — so an unbounded map turns a crawler
    // flood into a linear scan per request. No real shop needs more than this;
    // one that does wants a prefix rule, not five thousand exact ones.
    if (existing.length >= MAX_RULES) {
      return ApiResponseBuilder.badRequest(
        `This install is limited to ${MAX_RULES} redirects. Replace a batch of exact rules with a /old/* prefix rule.`,
      );
    }
    if (existing.some((r) => r.match === rule.match)) {
      return ApiResponseBuilder.badRequest(`A redirect for "${rule.match}" already exists`);
    }

    await LocalDB.saveRedirect(rule);
    // Rebuild the index NOW. A rule that needs a restart to take effect is a
    // rule the manager will assume is broken.
    await reloadRedirects();

    recordAudit(AUDIT.REDIRECT_CREATE, {
      actor: locals.user?.id ?? 'unknown',
      target: rule.id,
      ip: locals.ip,
      metadata: { redirect: rule.match, to: rule.target, status: rule.status },
    });
    return ApiResponseBuilder.created(rule, 'Redirect created');
  } catch (err) {
    console.error('Redirect create error:', err);
    return ApiResponseBuilder.serverError('Failed to create redirect');
  }
};
