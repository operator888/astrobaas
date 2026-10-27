import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { canReadCommerce, canWriteCommerce } from '../../../lib/auth';
import { recordAudit, AUDIT } from '../../../lib/audit';
import {
  countOrderTags, renameOrderTag, deleteOrderTagEverywhere, ORDER_TAG_MAX_PER_ORDER, ORDER_TAG_MAX_LENGTH,
  type OrderTagFailure,
} from '../../../lib/commerce/order-tags';

/**
 * `/api/orders/tags` — the tags in use across all orders. Staff only.
 *
 *  GET     the list with the number of orders carrying each (autocomplete + the
 *          sidebar on the orders screen)
 *  PATCH   { from, to } — rename a tag on every order that has it
 *  DELETE  ?tag=… — remove a tag from every order that has it
 *
 * A static route beside `/api/orders/[id]`; Astro matches it first, as it does
 * `/api/orders/quote`. See lib/commerce/order-tags.ts for what the bulk writes
 * do and do not promise.
 */
export const prerender = false;

function refuse(f: OrderTagFailure): Response {
  switch (f.code) {
    case 'invalid':
      return ApiResponseBuilder.error(422, f.message, undefined, { code: 'order_tags.invalid', params: { reason: f.reason } });
    case 'too_many':
      return ApiResponseBuilder.error(422, f.message, undefined, { code: 'order_tags.too_many' });
    case 'busy':
      return ApiResponseBuilder.error(409, f.message, undefined, { code: 'order_tags.busy' });
    default:
      return ApiResponseBuilder.notFound('Order');
  }
}

export const GET: APIRoute = async ({ locals }) => {
  try {
    const user = locals.user;
    if (!user) return ApiResponseBuilder.unauthorized();
    if (!canReadCommerce(user.role)) return ApiResponseBuilder.forbidden('Your role cannot view orders');
    await LocalDB.init();
    const tags = countOrderTags(await LocalDB.getOrders());
    return ApiResponseBuilder.success(tags, undefined, {
      count: tags.length, max_per_order: ORDER_TAG_MAX_PER_ORDER, max_length: ORDER_TAG_MAX_LENGTH,
    });
  } catch (err) {
    console.error('Order tags list error:', err);
    return ApiResponseBuilder.serverError('Failed to list order tags');
  }
};

export const PATCH: APIRoute = async ({ request, locals }) => {
  try {
    const user = locals.user;
    if (!user) return ApiResponseBuilder.unauthorized();
    if (!canWriteCommerce(user.role)) return ApiResponseBuilder.forbidden('Your role cannot update orders');
    await LocalDB.init();
    const body = (await request.json().catch(() => null)) as { from?: unknown; to?: unknown } | null;
    const r = await renameOrderTag(body?.from, body?.to, user.id);
    if (!r.ok) return refuse(r);
    recordAudit(AUDIT.ORDER_TAGS_BULK, {
      actor: user.id, ip: locals.ip, target: 'rename',
      metadata: { changed: r.outcome.changed, failed: r.outcome.failed },
    });
    return ApiResponseBuilder.success({ tag: r.tag, ...r.outcome }, 'Tag renamed');
  } catch (err) {
    console.error('Order tag rename error:', err);
    return ApiResponseBuilder.serverError('Failed to rename the tag');
  }
};

export const DELETE: APIRoute = async ({ url, locals }) => {
  try {
    const user = locals.user;
    if (!user) return ApiResponseBuilder.unauthorized();
    if (!canWriteCommerce(user.role)) return ApiResponseBuilder.forbidden('Your role cannot update orders');
    await LocalDB.init();
    const r = await deleteOrderTagEverywhere(url.searchParams.get('tag'), user.id);
    if (!r.ok) return refuse(r);
    recordAudit(AUDIT.ORDER_TAGS_BULK, {
      actor: user.id, ip: locals.ip, target: 'delete',
      metadata: { changed: r.outcome.changed, failed: r.outcome.failed },
    });
    return ApiResponseBuilder.success(r.outcome, 'Tag removed');
  } catch (err) {
    console.error('Order tag delete error:', err);
    return ApiResponseBuilder.serverError('Failed to remove the tag');
  }
};
