import type { APIRoute } from 'astro';
import { LocalDB } from '../../../../lib/localdb';
import { ApiResponseBuilder } from '../../../../lib/api-response';
import { canReadCommerce, canWriteCommerce } from '../../../../lib/auth';
import { recordAudit, AUDIT } from '../../../../lib/audit';
import {
  entitlementState, remainingDownloads, staffEntitlementAction, type StaffAction,
} from '../../../../lib/commerce/download-entitlements';
import type { DownloadEntitlement, Order } from '../../../../core/models';

/**
 * `/api/orders/{id}/downloads` — one order's download entitlements, for staff.
 *
 *  GET   every entitlement with its state, count, limit, expiry, files and
 *        download log (time, file, IP)
 *  POST  { action: 'revoke' | 'restore' | 'reset', entitlement_id }
 *        { action: 'grant' } — create what a paid order is owed (an order
 *        older than this feature, or one that reached a paid status by a path
 *        that did not grant)
 *
 * The buyer's own view is /api/downloads?receipt=…, which never shows the
 * log, the file locations or other people's addresses.
 */
export const prerender = false;

const ACTIONS: readonly StaffAction[] = ['revoke', 'restore', 'reset', 'grant'];

function shape(order: Order, ents: readonly DownloadEntitlement[]) {
  return {
    id: order.id,
    entitlements: ents.map((e) => ({
      ...e,
      state: entitlementState(e, order),
      remaining: remainingDownloads(e),
    })),
  };
}

export const GET: APIRoute = async ({ params, locals }) => {
  try {
    const user = locals.user;
    if (!user) return ApiResponseBuilder.unauthorized();
    if (!canReadCommerce(user.role)) return ApiResponseBuilder.forbidden('Your role cannot view orders');
    await LocalDB.init();
    const order = (await LocalDB.getOrder(params.id!)) as Order | null;
    if (!order) return ApiResponseBuilder.notFound('Order');
    return ApiResponseBuilder.success(shape(order, order.entitlements ?? []));
  } catch (err) {
    console.error('Order downloads get error:', err);
    return ApiResponseBuilder.serverError('Failed to load downloads');
  }
};

export const POST: APIRoute = async ({ params, request, locals }) => {
  try {
    const user = locals.user;
    if (!user) return ApiResponseBuilder.unauthorized();
    if (!canWriteCommerce(user.role)) return ApiResponseBuilder.forbidden('Your role cannot update orders');
    await LocalDB.init();
    const body = (await request.json().catch(() => null)) as { action?: unknown; entitlement_id?: unknown } | null;
    const action = body?.action;
    if (typeof action !== 'string' || !(ACTIONS as readonly string[]).includes(action)) {
      return ApiResponseBuilder.error(422, `action must be one of ${ACTIONS.join(', ')}`, undefined, { code: 'downloads.invalid_action' });
    }
    const entId = typeof body?.entitlement_id === 'string' ? body.entitlement_id : undefined;
    if (action !== 'grant' && !entId) {
      return ApiResponseBuilder.error(422, 'entitlement_id is required', undefined, { code: 'downloads.invalid_action' });
    }
    const r = await staffEntitlementAction(params.id!, action as StaffAction, entId);
    if (!r.ok) {
      if (r.status === 404) return ApiResponseBuilder.notFound(r.message.startsWith('Order') ? 'Order' : 'Entitlement');
      return ApiResponseBuilder.error(r.status, r.message);
    }
    recordAudit(AUDIT.ORDER_DOWNLOADS_UPDATE, {
      actor: user.id,
      target: r.order.id,
      metadata: { order: r.order.id, action, ...(entId ? { entitlement: entId } : {}) },
    });
    return ApiResponseBuilder.success(shape(r.order, r.entitlements), 'Downloads updated');
  } catch (err) {
    console.error('Order downloads action error:', err);
    return ApiResponseBuilder.serverError('Failed to update downloads');
  }
};
