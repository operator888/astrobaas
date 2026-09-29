import type { APIRoute } from 'astro';
import { LocalDB } from '../../lib/localdb';
import { ApiResponseBuilder } from '../../lib/api-response';
import { canManageCatalog } from '../../lib/auth';
import { getShopCurrency } from '../../lib/commerce-service';
import { recordAudit, AUDIT } from '../../lib/audit';
import { formatMoney } from '../../lib/money-format';
import { bulkOpsProblem, whereProblem, planBulkEdit, MAX_BULK, type BulkOps, type BulkWhere } from '../../lib/commerce/bulk-edit';
import { productListMatches } from '../../lib/commerce/product-list-filter';
import { applyPlannedUpdates } from '../../lib/commerce/bulk-apply';

/**
 * POST /api/product-bulk — change many products at once (catalogue staff).
 *
 *   { ids: string[] | filter: { q }, ops: BulkOps, where?: BulkWhere, apply?: boolean }
 *
 * - `ids` are the products ticked in the list; `filter: { q }` is "every
 *   product matching this search" — resolved here with the list's OWN filter
 *   (product-list-filter.ts), so it is exactly the set the list shows.
 * - `ops` may combine several changes; `where` restricts them to the products
 *   that meet a condition ("only the drafts", "only what is in stock").
 * - Without `apply: true` it is a PREVIEW and changes nothing.
 *
 * Applying goes through applyPlannedUpdates: every product through
 * `saveProduct` with its stock as bases, and the batch recorded so it can be
 * undone (POST /api/product-bulk/undo). One `product.bulk_edit` audit entry
 * records who, what and how it went.
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
    const body = await request.json().catch(() => null) as { ids?: unknown; filter?: unknown; ops?: unknown; where?: unknown; apply?: unknown } | null;
    const problem = bulkOpsProblem(body?.ops) ?? whereProblem(body?.where);
    if (problem) return ApiResponseBuilder.badRequest(problem);
    const ops = body!.ops as BulkOps;
    const where = (body?.where ?? undefined) as BulkWhere | undefined;

    await LocalDB.init();
    // A DEEP COPY: on the JSON driver the getters hand out the live cached
    // objects, so a "snapshot" would change under us as checkouts sell — and
    // the stock bases saveProduct compares against would then match the new
    // count, letting a planned (stale) variant stock be written back.
    const [stored, cats] = await Promise.all([LocalDB.getProducts(), LocalDB.getProductCategories()]);
    const all = structuredClone(stored);

    let ids: string[];
    const filter = body?.filter as { q?: unknown } | undefined;
    if (filter && typeof filter === 'object') {
      const q = typeof filter.q === 'string' ? filter.q.slice(0, 200) : '';
      ids = productListMatches(all, q).map((p) => String(p.id));
    } else {
      ids = Array.isArray(body?.ids) ? [...new Set(body!.ids.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 200))] : [];
    }
    if (!ids.length) return ApiResponseBuilder.badRequest('Select at least one product.');
    if (ids.length > MAX_BULK) {
      return ApiResponseBuilder.badRequest(`That is ${ids.length} products; at most ${MAX_BULK} in one change. Narrow the search, or add a condition.`);
    }

    // A category that does not exist would be stored as a tag pointing at
    // nothing — invisible in every menu. Refuse it, as creating one would.
    const known = new Set(cats.map((c) => c.slug));
    const missing = [...(ops.addCategories ?? []), ...(where?.category ? [where.category] : [])].filter((slug) => !known.has(slug));
    if (missing.length) return ApiResponseBuilder.badRequest(`No such category: ${missing.join(', ')}.`);

    const byId = new Map(all.map((p) => [String(p.id), p]));
    const found = ids.map((id) => byId.get(id)).filter((p): p is NonNullable<typeof p> => !!p);
    const notFound = ids.filter((id) => !byId.has(id));
    const currency = await getShopCurrency();
    const plan = planBulkEdit(found, ops, { money: (c) => formatMoney(c, { currency }), where, categories: cats });

    const live = plan.filter((p) => !p.unmatched);
    const summary = {
      selected: ids.length,
      not_found: notFound,
      not_matching: plan.length - live.length,
      will_change: live.filter((p) => !p.skipped && p.changes.length).length,
      unchanged: live.filter((p) => !p.skipped && !p.changes.length).length,
      skipped: live.filter((p) => p.skipped).length,
    };
    if (body?.apply !== true) {
      return ApiResponseBuilder.success({
        preview: true, ...summary,
        products: live.filter((p) => p.skipped || p.changes.length).map(({ patch: _p, ...rest }) => rest),
      });
    }

    const toApply = live.filter((p) => !p.skipped && p.changes.length);
    const result = await applyPlannedUpdates(toApply, byId, {
      actor: String(session.id),
      kind: 'bulk',
      label: `${describeOps(ops)} on ${toApply.length} product${toApply.length === 1 ? '' : 's'}${where ? ' (with a condition)' : ''}`,
    });
    recordAudit(AUDIT.PRODUCT_BULK_EDIT, {
      actor: session.id,
      target: `${ids.length} products`,
      ip: locals.ip,
      metadata: { ids, ops, where: where ?? null, updated: result.updated, failed: result.failed.map((f) => f.id), skipped: summary.skipped, batch: result.batch },
    });
    return ApiResponseBuilder.success({ preview: false, ...summary, ...result });
  } catch (err) {
    console.error('Bulk product edit error:', err);
    return ApiResponseBuilder.serverError('Failed to apply the bulk edit');
  }
};

/** A few words for the history list. */
function describeOps(ops: BulkOps): string {
  const parts: string[] = [];
  if (ops.status) parts.push(`status → ${ops.status}`);
  if (ops.featured !== undefined) parts.push(ops.featured ? 'featured' : 'unfeatured');
  if (ops.addCategories?.length) parts.push(`+ category ${ops.addCategories.join(', ')}`);
  if (ops.removeCategories?.length) parts.push(`− category ${ops.removeCategories.join(', ')}`);
  if (ops.addTags?.length) parts.push(`+ tag ${ops.addTags.join(', ')}`);
  if (ops.removeTags?.length) parts.push(`− tag ${ops.removeTags.join(', ')}`);
  if (ops.price) parts.push(ops.price.mode === 'percent' ? `price ${ops.price.value >= 0 ? '+' : ''}${ops.price.value}%` : ops.price.mode === 'amount' ? 'price changed by an amount' : 'price set');
  if (ops.sale) parts.push(ops.sale.mode === 'clear' ? 'sale ended' : `sale ${ops.sale.value}% off`);
  if (ops.stock !== undefined) parts.push('stock set');
  return parts.join(', ') || 'no change';
}
