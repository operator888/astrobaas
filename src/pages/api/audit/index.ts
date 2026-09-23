import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';

// Admin-only. The security audit trail (logins, API-key / webhook lifecycle,
// role/status changes, password resets), most recent first.
//   GET /api/audit?action=&actor=&from=&to=&limit=
//
// Filtering is SERVER-side on purpose. The store holds thousands of events and
// this response is capped at 500, so a filter applied in the browser would
// search only the page it was handed — answering "everything this user did"
// with "…of the most recent 500", which looks like an answer and is not one.
//
// `meta.actors` carries the distinct actors present, each with a display name,
// so the admin can filter by a person instead of memorising user ids. Names
// come from the user list, which is already admin-only on this route.
export const GET: APIRoute = async ({ url, locals }) => {
  try {
    await LocalDB.init();
    const session = locals.user;
    if (!session || session.role !== 'admin') return ApiResponseBuilder.forbidden('Admin only');
    const sp = new URL(url).searchParams;
    const str = (k: string) => sp.get(k)?.trim() || undefined;
    const limitRaw = sp.get('limit');
    const limit = limitRaw ? Math.min(parseInt(limitRaw, 10) || 0, 500) : 100;
    const events = await LocalDB.getAuditEvents({
      action: str('action'),
      actor: str('actor'),
      from: str('from'),
      to: str('to'),
      limit,
    });

    // Resolve ids to names for DISPLAY only — the stored actor is untouched, so
    // the trail still says exactly who acted even after a user is renamed or
    // deleted. An id with no matching user resolves to itself rather than to
    // "Unknown", which would erase information the row actually has.
    const users = await LocalDB.getUsers();
    const nameById = new Map(users.map((u) => [u.id, u.name || u.email]));
    const label = (actor: string) => {
      if (actor?.startsWith('apikey:')) return `API key ${actor.slice(7, 15)}…`;
      return nameById.get(actor) ?? actor;
    };
    const decorated = events.map((e) => ({ ...e, actor_label: label(String(e.actor ?? '')) }));

    const actors = [...new Set(events.map((e) => String(e.actor ?? '')).filter(Boolean))]
      .sort()
      .map((id) => ({ id, label: label(id) }));

    return ApiResponseBuilder.success(decorated, 'Audit events retrieved', { actors, count: decorated.length });
  } catch (err) {
    console.error('Audit list error:', err);
    return ApiResponseBuilder.serverError('Failed to fetch audit events');
  }
};
