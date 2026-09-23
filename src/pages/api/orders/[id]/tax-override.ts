import type { APIRoute } from 'astro';
import { LocalDB } from '../../../../lib/localdb';
import { ApiResponseBuilder } from '../../../../lib/api-response';
import { canOverrideTax } from '../../../../lib/auth';
import { resolveTaxSettings } from '../../../../lib/commerce/tax';
import { applyTaxOverride } from '../../../../lib/commerce/tax-override';
import { recordAudit, AUDIT } from '../../../../lib/audit';

/**
 * POST /api/orders/{id}/tax-override — depart from the engine's answer.
 *
 * Its own route rather than a field on `PUT /api/orders/{id}`, and the reason is
 * the audit trail: that route takes `status`, `note` and `staff_note`, and none
 * of them changes money. Folding a tax change into it would make "what did this
 * request do?" depend on which fields happened to be present, and would put a
 * money change behind the same permission as a note.
 *
 * Requires the `override_tax` capability, which `manager` has by default —
 * a shop manager settles a VAT question at the counter. It deliberately does
 * NOT require `write_commerce`, because that also gates refunds.
 *
 * APPEND-ONLY. Each call adds a record and rewrites `line_totals`; the engine's
 * original breakdown is preserved on the FIRST override and never touched
 * again, so "what did the rules say before anyone intervened" always has an
 * answer.
 */
export const prerender = false;

export const POST: APIRoute = async ({ params, request, locals }) => {
  try {
    await LocalDB.init();
    const user = locals.user;
    if (!user || !canOverrideTax(user.role)) {
      return ApiResponseBuilder.forbidden('You do not have permission to override tax');
    }

    const order = await LocalDB.getOrder(params.id!);
    if (!order) return ApiResponseBuilder.notFound('Order');

    // An erased order is not a thing staff may re-price: its identifying data
    // is gone and re-opening it would put a money change on a record that
    // exists only as an accounting figure.
    if (order.erased_at) {
      return ApiResponseBuilder.badRequest('This order has been erased and cannot be re-priced');
    }
    if (!order.line_totals?.length) {
      return ApiResponseBuilder.badRequest(
        'This order has no stored line breakdown, so its tax cannot be recomputed',
      );
    }

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const rows = await LocalDB.getSettings();
    const map: Record<string, unknown> = {};
    for (const r of rows) map[r.key] = r.value;
    const settings = resolveTaxSettings(map);

    const result = applyTaxOverride(
      order.line_totals,
      settings,
      {
        scope: body?.scope === 'line' ? 'line' : 'order',
        line_index: typeof body?.line_index === 'number' ? body.line_index : undefined,
        tax_class: typeof body?.tax_class === 'string' ? body.tax_class : undefined,
        exempt: body?.exempt === true,
        reason: typeof body?.reason === 'string' ? body.reason : undefined,
      },
      user.id,
    );
    if (!result.ok) return ApiResponseBuilder.badRequest(result.error);

    /*
     * The shipping tax is NOT recomputed.
     *
     * Shipping follows the goods for place of supply, but an override is a
     * decision about THIS customer's goods — a charity exemption or a verified
     * ΑΦΜ — and silently re-rating the postage as well would change a figure
     * the operator did not look at. `tax_cents` therefore keeps the stored
     * shipping half, which is why persisting `shipping_tax_cents` had to come
     * first: without it this line could not be written correctly at all.
     */
    const shippingTax = order.shipping_tax_cents ?? 0;
    const shippingNet = order.shipping_cents ?? 0;
    /*
     * The shipping LINE, reconstructed the way `totalsReconcile` defines it:
     * inclusive pricing means the tax is already inside `shipping_cents`,
     * exclusive means it is added. Getting this wrong would break the stored
     * order's reconciliation in exactly the direction nobody checks — the
     * total would still look like a plausible number.
     */
    const shippingTotal = order.prices_include_tax === false
      ? shippingNet + shippingTax
      : shippingNet;
    const patch = {
      line_totals: result.lines,
      tax_cents: result.tax_cents + shippingTax,
      total_cents: result.total_cents + shippingTotal,
      tax_overrides: [...(order.tax_overrides ?? []), result.record],
      // Written ONCE. `?? order.line_totals` captures the engine's answer the
      // first time and every later override leaves it alone.
      line_totals_original: order.line_totals_original ?? order.line_totals,
    };

    const saved = await LocalDB.updateOrder(order.id, patch);

    recordAudit(AUDIT.ORDER_TAX_OVERRIDE, {
      actor: user.id,
      target: order.number,
      metadata: {
        scope: result.record.scope,
        line_index: result.record.line_index,
        was_rate_bp: result.record.was_rate_bp,
        now_rate_bp: result.record.now_rate_bp,
        reason: result.record.reason,
      },
    });

    return ApiResponseBuilder.success(saved, 'Tax overridden');
  } catch (err) {
    console.error('Tax override error:', err);
    return ApiResponseBuilder.serverError('Failed to override tax');
  }
};
