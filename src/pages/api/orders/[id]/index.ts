import type { APIRoute } from 'astro';
import { LocalDB } from '../../../../lib/localdb';
import { ApiResponseBuilder } from '../../../../lib/api-response';
import { validate } from '../../../../lib/validate';
import { setOrderStatus, ORDER_STATUSES } from '../../../../lib/commerce-service';
import { canReadCommerce, canWriteCommerce } from '../../../../lib/auth';

/** GET /api/orders/[id] — staff only. */
export const GET: APIRoute = async ({ params, locals }) => {
  try {
    await LocalDB.init();
    const session = locals.user;
    if (!session || !canReadCommerce(session.role)) {
      return ApiResponseBuilder.forbidden('Your role cannot view orders');
    }
    const order = await LocalDB.getOrder(params.id!);
    if (!order) return ApiResponseBuilder.notFound('Order');
    return ApiResponseBuilder.success(order);
  } catch (err) {
    console.error('Order get error:', err);
    return ApiResponseBuilder.serverError('Failed to load order');
  }
};

/** PUT /api/orders/[id] — status transitions, the buyer's note, and the shop's own (staff). */
export const PUT: APIRoute = async ({ params, request, locals }) => {
  try {
    await LocalDB.init();
    const session = locals.user;
    // Status transitions drive fulfilment, so this stays narrower than the GET
    // above: a manager may READ every order and change none of them.
    if (!session || !canWriteCommerce(session.role)) {
      return ApiResponseBuilder.forbidden('Your role cannot update orders');
    }
    const body = await request.json().catch(() => null);
    const result = validate<{ status?: string; note?: string; staff_note?: string }>(body, {
      status: { type: 'enum', values: ORDER_STATUSES as unknown as string[], optional: true },
      note: { type: 'string', max: 1000, optional: true },
      // The SHOP's note, separate from the buyer's.
      //
      // `note` above is what the customer typed at checkout. Staff had nowhere
      // else to write, so recording "called, collecting Tuesday" meant editing
      // the customer's own words — losing what they actually said, and putting
      // the shop's handling notes inside a field a data-subject erasure clears.
      staff_note: { type: 'string', max: 2000, optional: true },
    });
    if (!result.ok) return ApiResponseBuilder.validationError('Invalid order update', result.errors);
    if (result.value.note !== undefined) {
      await LocalDB.updateOrder(params.id!, { note: result.value.note });
    }
    if (result.value.staff_note !== undefined) {
      await LocalDB.updateOrder(params.id!, { staff_note: result.value.staff_note });
    }
    if (result.value.status) {
      const res = await setOrderStatus(params.id!, result.value.status as any, session.id);
      // 409 here means the stock a reopened order needs is gone — a real
      // conflict the caller can act on, not a malformed request.
      if (!res.ok) return ApiResponseBuilder.error(res.status, res.message);
      return ApiResponseBuilder.success(res.value, 'Order updated');
    }
    const order = await LocalDB.getOrder(params.id!);
    if (!order) return ApiResponseBuilder.notFound('Order');
    return ApiResponseBuilder.success(order, 'Order updated');
  } catch (err) {
    console.error('Order update error:', err);
    return ApiResponseBuilder.serverError('Failed to update order');
  }
};
