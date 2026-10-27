import type { APIRoute } from 'astro';
import { LocalDB } from '../../../../lib/localdb';
import { ApiResponseBuilder } from '../../../../lib/api-response';
import { parsePaging } from '../../../../lib/validate';
import { canReadCommerce, canWriteCommerce } from '../../../../lib/auth';
import { recordAudit, AUDIT } from '../../../../lib/audit';
import { toCsv } from '../../../../lib/csv';
import {
  buildOrderTimeline, filterTimeline, parseTimelineFilter, describeActor, appendOrderTimeline,
  cleanTimelineText, TIMELINE_FILTERS, ORDER_TIMELINE_TEXT_MAX, ORDER_TIMELINE_MAX_STORED,
  type TimelineItem,
} from '../../../../lib/commerce/order-timeline';

/**
 * `/api/orders/{id}/timeline` — everything that happened to one order. Staff only.
 *
 *  GET   newest first. `?filter=status|payments|shipments|notes|other`,
 *        `?limit=` (default 50, at most 200) and `?offset=`; `?format=csv`
 *        exports the whole filtered list for accounting or a dispute.
 *  POST  { text } — add a staff comment to the timeline.
 *
 * Part of it is derived from the order's own fields and part is stored on the
 * order; see lib/commerce/order-timeline.ts. Nothing here is ever shown to a
 * buyer.
 */
export const prerender = false;

async function shape(items: TimelineItem[]) {
  const ids = new Set<string>();
  for (const i of items) if (i.actor && i.actor !== 'provider' && i.actor !== 'customer' && !i.actor.startsWith('system')) ids.add(i.actor);
  const users = new Map<string, { name?: string; email?: string }>();
  if (ids.size > 0) {
    for (const u of await LocalDB.getUsers()) if (ids.has(u.id)) users.set(u.id, { name: u.name, email: u.email });
  }
  return items.map((i) => {
    const who = describeActor(i.actor, users);
    return { ...i, actor_kind: who.kind, actor_name: who.name };
  });
}

export const GET: APIRoute = async ({ params, url, locals }) => {
  try {
    const user = locals.user;
    if (!user) return ApiResponseBuilder.unauthorized();
    if (!canReadCommerce(user.role)) return ApiResponseBuilder.forbidden('Your role cannot view orders');
    await LocalDB.init();
    const order = await LocalDB.getOrder(params.id!);
    if (!order) return ApiResponseBuilder.notFound('Order');

    const filter = parseTimelineFilter(url.searchParams.get('filter'));
    if (filter === 'invalid') {
      return ApiResponseBuilder.error(422, `filter must be one of: all, ${TIMELINE_FILTERS.join(', ')}`, undefined, { code: 'order_timeline.invalid_filter' });
    }
    const all = buildOrderTimeline(order);
    const filtered = filterTimeline(all, filter);

    if (url.searchParams.get('format') === 'csv') {
      const rows = (await shape(filtered)).map((i) => ({
        at: i.at, event: i.event, category: i.category,
        actor: i.actor_name ?? i.actor ?? '', actor_kind: i.actor_kind,
        from: i.from ?? '', to: i.to ?? '',
        amount: i.amount_cents === undefined ? '' : (i.amount_cents / 100).toFixed(2),
        currency: i.currency ?? '',
        detail: [i.text, i.ref, i.added?.length ? `+${i.added.join(', ')}` : '', i.removed?.length ? `-${i.removed.join(', ')}` : '']
          .filter(Boolean).join(' | '),
      }));
      const csv = toCsv(['at', 'event', 'category', 'actor', 'actor_kind', 'from', 'to', 'amount', 'currency', 'detail'], rows);
      const safe = String(order.number ?? order.id).replace(/[^A-Za-z0-9._-]/g, '_');
      return new Response(csv, {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="order-${safe}-timeline.csv"`,
          'Cache-Control': 'no-store',
        },
      });
    }

    const limit = parsePaging(url.searchParams.get('limit'), { fallback: 50, min: 1, max: 200 });
    const offset = parsePaging(url.searchParams.get('offset'), { fallback: 0, min: 0, max: 1_000_000 });
    const page = filtered.slice(offset, offset + limit);
    return ApiResponseBuilder.success(await shape(page), undefined, {
      total: all.length, filtered: filtered.length, count: page.length, limit, offset,
      hasMore: offset + page.length < filtered.length,
      filters: [...TIMELINE_FILTERS],
      stored_max: ORDER_TIMELINE_MAX_STORED,
    });
  } catch (err) {
    console.error('Order timeline get error:', err);
    return ApiResponseBuilder.serverError('Failed to load the order timeline');
  }
};

export const POST: APIRoute = async ({ params, request, locals }) => {
  try {
    const user = locals.user;
    if (!user) return ApiResponseBuilder.unauthorized();
    if (!canWriteCommerce(user.role)) return ApiResponseBuilder.forbidden('Your role cannot update orders');
    await LocalDB.init();
    const body = (await request.json().catch(() => null)) as { text?: unknown } | null;
    const text = cleanTimelineText(body?.text);
    if (typeof body?.text !== 'string' || !text) {
      return ApiResponseBuilder.error(422, 'Send { "text": "…" } with the comment', undefined, { code: 'order_timeline.invalid' });
    }
    if ([...body.text.trim()].length > ORDER_TIMELINE_TEXT_MAX) {
      return ApiResponseBuilder.error(422, `A comment can be at most ${ORDER_TIMELINE_TEXT_MAX} characters`, undefined, { code: 'order_timeline.too_long' });
    }
    const order = await LocalDB.getOrder(params.id!);
    if (!order) return ApiResponseBuilder.notFound('Order');
    const r = await appendOrderTimeline(order.id, [{ event: 'note.comment', actor: user.id, text }]);
    if (!r.ok) {
      if (r.code === 'not_found') return ApiResponseBuilder.notFound('Order');
      if (r.code === 'busy') return ApiResponseBuilder.error(409, r.message, undefined, { code: 'order_timeline.busy' });
      return ApiResponseBuilder.error(422, r.message, undefined, { code: 'order_timeline.invalid' });
    }
    recordAudit(AUDIT.ORDER_TIMELINE_COMMENT, { actor: user.id, ip: locals.ip, target: order.number ?? order.id });
    const [entry] = await shape(buildOrderTimeline({ ...order, timeline: r.entries }).filter((i) => i.id === r.entries[0].id));
    return ApiResponseBuilder.success(entry, 'Comment added');
  } catch (err) {
    console.error('Order timeline add error:', err);
    return ApiResponseBuilder.serverError('Failed to add the comment');
  }
};
