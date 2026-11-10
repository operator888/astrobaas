import type { APIRoute } from 'astro';
import { LocalDB } from '../../../../lib/localdb';
import { ApiResponseBuilder } from '../../../../lib/api-response';
import { canReadCommerce, canWriteCommerce } from '../../../../lib/auth';
import { recordAudit, AUDIT } from '../../../../lib/audit';
import {
  orderTagsOf, orderTagColor, addOrderTags, removeOrderTag, ORDER_TAG_MAX_PER_ORDER,
  type OrderTagResult,
} from '../../../../lib/commerce/order-tags';

/**
 * `/api/orders/{id}/tags` — one order's staff tags.
 *
 *  GET     the order's tags
 *  POST    { tag } or { tags: [...] } — add (an order has at most 10)
 *  DELETE  ?tag=… — remove one
 *
 * There is no "set the whole list" verb on purpose: it is a blind overwrite,
 * and two staff editing one order would erase each other. Adding and removing
 * are decided against the list as it is when they are written.
 *
 * Tags never appear on anything a buyer can reach; this route is staff only.
 */
export const prerender = false;

const shape = (tags: string[]) => ({
  tags: tags.map((tag) => ({ tag, color: orderTagColor(tag) })),
  max: ORDER_TAG_MAX_PER_ORDER,
});

function respond(r: OrderTagResult, message: string): Response {
  if (r.ok) return ApiResponseBuilder.success({ id: r.order.id, ...shape(r.tags) }, message);
  switch (r.code) {
    case 'invalid':
      return ApiResponseBuilder.error(422, r.message, undefined, { code: 'order_tags.invalid', params: { reason: r.reason } });
    case 'too_many':
      return ApiResponseBuilder.error(422, r.message, undefined, { code: 'order_tags.too_many' });
    case 'busy':
      return ApiResponseBuilder.error(409, r.message, undefined, { code: 'order_tags.busy' });
    default:
      return ApiResponseBuilder.notFound('Order');
  }
}

export const GET: APIRoute = async ({ params, locals }) => {
  try {
    const user = locals.user;
    if (!user) return ApiResponseBuilder.unauthorized();
    if (!canReadCommerce(user.role)) return ApiResponseBuilder.forbidden('Your role cannot view orders');
    await LocalDB.init();
    const order = await LocalDB.getOrder(params.id!);
    if (!order) return ApiResponseBuilder.notFound('Order');
    return ApiResponseBuilder.success({ id: order.id, ...shape(orderTagsOf(order)) });
  } catch (err) {
    console.error('Order tags get error:', err);
    return ApiResponseBuilder.serverError('Failed to load order tags');
  }
};

export const POST: APIRoute = async ({ params, request, locals }) => {
  try {
    const user = locals.user;
    if (!user) return ApiResponseBuilder.unauthorized();
    if (!canWriteCommerce(user.role)) return ApiResponseBuilder.forbidden('Your role cannot update orders');
    await LocalDB.init();
    const body = (await request.json().catch(() => null)) as { tag?: unknown; tags?: unknown } | null;
    const list = Array.isArray(body?.tags) ? body!.tags : body && 'tag' in body ? [body.tag] : null;
    if (!list) return ApiResponseBuilder.error(422, 'Send { "tag": "VIP" } or { "tags": ["VIP"] }', undefined, { code: 'order_tags.invalid' });
    // Bounded BEFORE the work: a list longer than any order may hold cannot
    // succeed, so it is refused without being normalised one by one.
    if (list.length > ORDER_TAG_MAX_PER_ORDER) {
      return ApiResponseBuilder.error(422, `An order can have at most ${ORDER_TAG_MAX_PER_ORDER} tags`, undefined, { code: 'order_tags.too_many' });
    }
    const r = await addOrderTags(params.id!, list, user.id);
    if (r.ok && r.changed) {
      recordAudit(AUDIT.ORDER_TAGS_UPDATE, {
        actor: user.id, ip: locals.ip, target: r.order.number ?? r.order.id, metadata: { added: list.length },
      });
    }
    return respond(r, 'Tags updated');
  } catch (err) {
    console.error('Order tags add error:', err);
    return ApiResponseBuilder.serverError('Failed to add the tag');
  }
};

export const DELETE: APIRoute = async ({ params, url, locals }) => {
  try {
    const user = locals.user;
    if (!user) return ApiResponseBuilder.unauthorized();
    if (!canWriteCommerce(user.role)) return ApiResponseBuilder.forbidden('Your role cannot update orders');
    await LocalDB.init();
    const r = await removeOrderTag(params.id!, url.searchParams.get('tag'), user.id);
    if (r.ok && r.changed) {
      recordAudit(AUDIT.ORDER_TAGS_UPDATE, {
        actor: user.id, ip: locals.ip, target: r.order.number ?? r.order.id, metadata: { removed: 1 },
      });
    }
    return respond(r, 'Tag removed');
  } catch (err) {
    console.error('Order tags remove error:', err);
    return ApiResponseBuilder.serverError('Failed to remove the tag');
  }
};
