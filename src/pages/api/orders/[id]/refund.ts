import type { APIRoute } from 'astro';
import { LocalDB } from '../../../../lib/localdb';
import { ApiResponseBuilder } from '../../../../lib/api-response';
import { refundOrder } from '../../../../lib/payments/service';
import { paymentSiteUrl } from '../../../../lib/payments/site-url';
import { refundableRemaining, refundedTotal } from '../../../../lib/payments/refunds';

/**
 * GET  /api/orders/:id/refund — how much is still refundable.
 * POST /api/orders/:id/refund — send money back.
 *
 * **Admin only, not editor.** Everything else in commerce is editor+, but this
 * one moves money out of the business. Listing orders is a job; issuing refunds
 * is a financial control, and the two do not belong to the same role by default.
 *
 * `amount_cents` is optional — omit it to refund everything still outstanding.
 * That "everything" is resolved from OUR records, never by asking the provider
 * to refund the remainder, so a partial refund cannot quietly become a full one
 * because the two sides disagree about the balance.
 */
export const GET: APIRoute = async ({ params, locals }) => {
  try {
    await LocalDB.init();
    if (locals.user?.role !== 'admin') return ApiResponseBuilder.forbidden('Admin only');

    const order = await LocalDB.getOrder(params.id!);
    if (!order) return ApiResponseBuilder.notFound('Order');

    return ApiResponseBuilder.success({
      total_cents: order.total_cents,
      refunded_cents: refundedTotal(order),
      refundable_cents: refundableRemaining(order),
      currency: order.currency,
      payment_status: order.payment_status ?? 'unpaid',
      payment_provider: order.payment_provider ?? null,
      refunds: order.refunds ?? [],
    });
  } catch (err) {
    console.error('Refund status error:', err);
    return ApiResponseBuilder.serverError('Failed to read refund status');
  }
};

export const POST: APIRoute = async ({ params, request, url, locals, site }) => {
  try {
    await LocalDB.init();
    const user = locals.user;
    if (user?.role !== 'admin') return ApiResponseBuilder.forbidden('Admin only');

    const body = await request.json().catch(() => null);
    const raw = (body as any)?.amount_cents;
    // Absent/null means "the rest". Anything present must be a real number —
    // a string like "50" would otherwise sail into the amount comparison.
    if (raw !== undefined && raw !== null && typeof raw !== 'number') {
      return ApiResponseBuilder.badRequest('amount_cents must be a number of cents, or omitted for the full remaining amount');
    }
    const amount = raw === undefined || raw === null ? null : raw;

    // The configured site, as for payment start — never the request's Host.
    const siteUrl = await paymentSiteUrl({ astroSite: site, requestUrl: url });
    const result = await refundOrder(params.id!, amount, user.id, siteUrl);
    if (!result.ok) {
      return ApiResponseBuilder.error(result.status, result.message ?? 'Refund failed');
    }

    return ApiResponseBuilder.success(
      { refund: result.refund, remaining_cents: result.remainingCents },
      result.remainingCents === 0 ? 'Order fully refunded' : 'Partial refund issued',
    );
  } catch (err) {
    console.error('Refund error:', err);
    return ApiResponseBuilder.serverError('Failed to issue refund');
  }
};
