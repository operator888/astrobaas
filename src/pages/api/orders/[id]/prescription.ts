import type { APIRoute } from 'astro';
import { LocalDB } from '../../../../lib/localdb';
import { ApiResponseBuilder } from '../../../../lib/api-response';
import { canWriteCommerce } from '../../../../lib/auth';
import { recordAudit, AUDIT } from '../../../../lib/audit';

/**
 * `DELETE /api/orders/{id}/prescription?line=<n>` — remove one γνωμάτευση.
 *
 * ## Why this is a deliberate act and not part of the erasure
 *
 * A prescription frozen onto an order line is Article 9 health data, and this
 * system RETAINS it through a data-subject erasure: an optician has a
 * professional obligation to keep the practitioner's prescription, and it is
 * the record that settles a later dispute about a remake. Article 17(3)(b)
 * covers that.
 *
 * A retention obligation is not forever, though, and it is the optician — not
 * the person who asked to be forgotten, and not a sweep — who knows when a
 * particular prescription has outlived it. So removal is one person, one
 * record, one decision, on the order they are looking at.
 *
 * ## What it does and does not touch
 *
 * ONLY the `prescription` field of the named line. The line keeps its name,
 * quantity and money, because those are the books; nothing else about the order
 * changes. There is no bulk endpoint on purpose — "delete every prescription
 * older than N" is a policy decision that belongs to a person, and a route that
 * does it in one call is a route that does it by accident.
 *
 * Audited, because this is the one action that destroys data the erasure keeps.
 * The audit entry names the order and the line, never the values.
 */
export const prerender = false;

export const DELETE: APIRoute = async ({ params, locals, url }) => {
  try {
    const user = locals.user;
    if (!user) return ApiResponseBuilder.unauthorized();
    if (!canWriteCommerce(user.role)) {
      return ApiResponseBuilder.forbidden('You do not have permission to change orders');
    }

    await LocalDB.init();
    const id = String((params as { id: string }).id ?? '');
    const orders = await LocalDB.getOrders();
    const order = (orders as { id: string; number?: string; items?: unknown[] }[])
      .find((o) => o.id === id);
    if (!order) return ApiResponseBuilder.notFound('Order');

    const raw = url.searchParams.get('line');
    const index = Number(raw);
    // `Number('')` is 0 and 0 is a valid line, so the empty case is checked
    // FIRST — otherwise a missing parameter would silently delete line one.
    if (raw === null || raw.trim() === '' || !Number.isInteger(index) || index < 0) {
      return ApiResponseBuilder.badRequest('line must be a whole number, 0 or greater');
    }
    const items = Array.isArray(order.items) ? [...order.items] : [];
    if (index >= items.length) return ApiResponseBuilder.notFound('Order line');

    const line = items[index] as Record<string, unknown>;
    if (!('prescription' in line) || !line.prescription) {
      // 404 rather than a cheerful 200: an operator pressing this twice should
      // learn the second press did nothing, not believe it worked.
      return ApiResponseBuilder.notFound('Prescription');
    }

    // A NEW object, not a mutation of the stored one: the storage layer merges,
    // and editing the array in place would leave the caller holding a
    // half-updated order if the write failed.
    items[index] = { ...line, prescription: undefined };
    await LocalDB.updateOrder(id, { items: items as never });

    // The order and the line, never the measurements — an audit trail that
    // copied the prescription in would recreate exactly what was deleted.
    recordAudit(AUDIT.ORDER_RX_DELETE, {
      actor: user.id,
      target: `${order.number ?? id}#${index}`,
      ip: locals.ip,
      // The line, never the measurements: an audit trail that copied the
      // prescription in would recreate exactly what was just deleted.
      metadata: { line: index },
    });

    return ApiResponseBuilder.success({ id, line: index });
  } catch (err) {
    console.error('Prescription delete error:', err);
    return ApiResponseBuilder.serverError('Could not remove the prescription');
  }
};
