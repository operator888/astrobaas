import type { APIRoute } from 'astro';
import { LocalDB } from '../../../../lib/localdb';
import { ApiResponseBuilder } from '../../../../lib/api-response';
import { canWriteCommerce } from '../../../../lib/auth';
import { recordAudit, AUDIT } from '../../../../lib/audit';
import { buildShippedNotice, safeTrackingUrl } from '../../../../lib/commerce/shipped-notice';
import type { Order } from '../../../../core/models';

/**
 * `POST /api/orders/{id}/ship` — record tracking, and tell the customer once.
 *
 * "Where is my order" is the most common message a small shop receives, and it
 * arrives because nothing told the customer the parcel had left. The order
 * status machine, the email layer and operator-editable templates all already
 * existed; what was missing was a place to put a tracking number.
 *
 * ## Deliberately not a status change
 *
 * `OrderStatus` governs money and stock. Dispatch is neither, and an order can
 * be `processing` and already posted, or `completed` and collected in person.
 * So this writes tracking fields beside the status and leaves it alone.
 *
 * ## The email sends once
 *
 * `shipped_at` is set on the first successful call and guards the send.
 * Correcting a typo in a tracking number updates the order and does NOT email
 * the customer a second "on its way" — the correction is for the shop's records
 * and for anyone who follows the link later.
 */
export const prerender = false;

export const POST: APIRoute = async ({ params, request, locals }) => {
  try {
    const user = locals.user;
    if (!user) return ApiResponseBuilder.unauthorized();
    if (!canWriteCommerce(user.role)) {
      return ApiResponseBuilder.forbidden('You do not have permission to change orders');
    }

    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const number = String(body?.tracking_number ?? '').trim().slice(0, 120);
    const carrier = String(body?.tracking_carrier ?? '').trim().slice(0, 80);
    const url = safeTrackingUrl(body?.tracking_url);

    // A notice with nothing to track is not a notice. Refuse rather than send
    // "your order is on its way" with an empty where.
    if (!number && !url) {
      return ApiResponseBuilder.badRequest('A tracking number or a tracking URL is required');
    }
    // A URL that was supplied but is not http(s) is a mistake worth naming,
    // not one to drop silently — the operator pasted something.
    if (body?.tracking_url && !url) {
      return ApiResponseBuilder.badRequest('tracking_url must be an http or https address');
    }

    await LocalDB.init();
    const id = String((params as { id: string }).id ?? '');
    const orders = await LocalDB.getOrders() as Order[];
    const order = orders.find((o) => o.id === id);
    if (!order) return ApiResponseBuilder.notFound('Order');

    const firstTime = !order.shipped_at;
    const patch: Partial<Order> = {
      tracking_number: number || undefined,
      tracking_carrier: carrier || undefined,
      tracking_url: url,
    };
    if (firstTime) patch.shipped_at = new Date().toISOString();
    const saved = await LocalDB.updateOrder(id, patch);
    if (!saved) return ApiResponseBuilder.serverError('Could not save the tracking details');

    recordAudit(AUDIT.ORDER_SHIPPED, {
      actor: user.id,
      target: order.number ?? id,
      ip: locals.ip,
      metadata: { carrier: carrier || null, notified: firstTime },
    });

    // Fire-and-forget, exactly like the order confirmation: a mail transport
    // that is down must never fail a dispatch the operator has already made.
    let notified = false;
    if (firstTime) {
      notified = true;
      void (async () => {
        try {
          const [{ sendEmail }, { renderEmailTemplate, emailTemplateKey }, { receiptUrl }] =
            await Promise.all([
              import('../../../../lib/email'),
              import('../../../../lib/email-templates'),
              import('../../../../lib/commerce/receipt'),
            ]);
          const rows = await LocalDB.getSettings();
          const settings: Record<string, unknown> = {};
          for (const r of rows) settings[r.key] = r.value;
          const siteTitle = typeof settings.site_title === 'string' ? settings.site_title : undefined;
          const origin = typeof settings.site_url === 'string' && settings.site_url.trim()
            ? settings.site_url.trim()
            : process.env.SITE_URL;

          const rendered = renderEmailTemplate('order_shipped', {
            site_title: siteTitle ?? 'Your order',
            order_number: String(order.number ?? id),
            carrier: carrier || '—',
            tracking_number: number || '—',
          }, settings[emailTemplateKey('order_shipped')]);

          const msg = buildShippedNotice({ ...order, ...patch }, {
            siteTitle,
            subject: rendered?.subject,
            receiptLink: origin ? receiptUrl(origin, id) : undefined,
          });
          if (msg) await sendEmail(msg);
        } catch (err) {
          console.error('Shipped notice failed:', err instanceof Error ? err.message : err);
        }
      })();
    }

    return ApiResponseBuilder.success({ id, notified });
  } catch (err) {
    console.error('Ship order error:', err);
    return ApiResponseBuilder.serverError('Could not record the shipment');
  }
};
