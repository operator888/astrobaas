import type { APIRoute } from 'astro';
import { LocalDB } from '../../lib/localdb';
import { ApiResponseBuilder } from '../../lib/api-response';
import { canManageCatalog } from '../../lib/auth';
import { saveProduct, getShopCurrency } from '../../lib/commerce-service';
import { recordAudit, AUDIT } from '../../lib/audit';
import { formatMoney } from '../../lib/money-format';
import { bulkOpsProblem, planBulkEdit, MAX_BULK, type BulkOps } from '../../lib/commerce/bulk-edit';

/**
 * POST /api/product-bulk — change many products at once (catalogue staff).
 *
 *   { ids: string[], ops: BulkOps, apply?: boolean }
 *
 * Without `apply: true` it is a PREVIEW: it answers what each product would
 * become and changes nothing. The admin screen always previews first, and an
 * API client can do the same — a bulk price change is exactly the edit worth
 * seeing before it happens.
 *
 * Applying saves each product through `saveProduct`, one at a time, so a bulk
 * edit is N ordinary edits: validation, the after-save hooks, `product.updated`
 * webhooks, price history and per-product audit all happen as for a single
 * edit. One `product.bulk_edit` audit entry records the batch itself — who, which
 * products, which operations, and how it went.
 *
 * Not a transaction: storage has none across rows. A product that fails to save
 * is reported with its reason and the rest still apply; re-running the same
 * edit is safe, because an operation that is already true changes nothing.
 *
 * Lives beside `/api/products` rather than under it: `/api/products/bulk`
 * would shadow a product whose slug is "bulk".
 */
export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const session = locals.user;
    if (!session || !canManageCatalog(session.role)) {
      return ApiResponseBuilder.forbidden('Your role cannot edit products');
    }
    const body = await request.json().catch(() => null) as { ids?: unknown; ops?: unknown; apply?: unknown } | null;
    const ids = Array.isArray(body?.ids) ? [...new Set(body!.ids.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 200))] : [];
    if (!ids.length) return ApiResponseBuilder.badRequest('Select at least one product.');
    if (ids.length > MAX_BULK) return ApiResponseBuilder.badRequest(`At most ${MAX_BULK} products in one change.`);
    const problem = bulkOpsProblem(body?.ops);
    if (problem) return ApiResponseBuilder.badRequest(problem);
    const ops = body!.ops as BulkOps;

    await LocalDB.init();
    // A category that does not exist would be stored as a tag pointing at
    // nothing — invisible in every menu. Refuse it, as creating one would.
    if (ops.addCategories?.length) {
      const cats = await LocalDB.getProductCategories();
      const known = new Set(cats.map((c) => c.slug));
      const missing = ops.addCategories.filter((slug) => !known.has(slug));
      if (missing.length) return ApiResponseBuilder.badRequest(`No such category: ${missing.join(', ')}.`);
    }

    const all = await LocalDB.getProducts();
    const byId = new Map(all.map((p) => [String(p.id), p]));
    const found = ids.map((id) => byId.get(id)).filter((p): p is NonNullable<typeof p> => !!p);
    const notFound = ids.filter((id) => !byId.has(id));
    const currency = await getShopCurrency();
    const plan = planBulkEdit(found, ops, { money: (c) => formatMoney(c, { currency }) });

    const summary = {
      selected: ids.length,
      not_found: notFound,
      will_change: plan.filter((p) => !p.skipped && p.changes.length).length,
      unchanged: plan.filter((p) => !p.skipped && !p.changes.length).length,
      skipped: plan.filter((p) => p.skipped).length,
    };
    if (body?.apply !== true) {
      return ApiResponseBuilder.success({ preview: true, ...summary, products: plan.map(({ patch: _p, ...rest }) => rest) });
    }

    const failed: { id: string; name: string; message: string }[] = [];
    let updated = 0;
    for (const item of plan) {
      if (item.skipped || !item.changes.length) continue;
      // The stock counts this batch READ, as bases: saveProduct leaves any
      // count that still equals its base untouched. Without them, a variants
      // array built from the snapshot above would write back stock that a
      // checkout sold while the batch was running — an oversell.
      const read = byId.get(item.id)!;
      const bases = {
        stock: read.stock ?? null,
        variants: new Map((read.variants ?? []).map((v) => [v.id, v.stock ?? null] as [string, number | null])),
      };
      const saved = await saveProduct(item.patch, item.id, String(session.id), bases);
      if (saved.ok) updated++;
      else failed.push({ id: item.id, name: item.name, message: saved.message });
    }
    recordAudit(AUDIT.PRODUCT_BULK_EDIT, {
      actor: session.id,
      target: `${ids.length} products`,
      ip: locals.ip,
      metadata: { ids, ops, updated, failed: failed.map((f) => f.id), skipped: summary.skipped },
    });
    return ApiResponseBuilder.success({ preview: false, ...summary, updated, failed });
  } catch (err) {
    console.error('Bulk product edit error:', err);
    return ApiResponseBuilder.serverError('Failed to apply the bulk edit');
  }
};
