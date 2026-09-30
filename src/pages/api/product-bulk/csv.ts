import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { canManageCatalog } from '../../../lib/auth';
import { getShopCurrency } from '../../../lib/commerce-service';
import { recordAudit, AUDIT } from '../../../lib/audit';
import { formatMoney, minorUnits } from '../../../lib/money-format';
import { parseCsv } from '../../../lib/csv';
import { planCsvUpdate } from '../../../lib/commerce/bulk-csv';
import { applyPlannedUpdates } from '../../../lib/commerce/bulk-apply';

/**
 * The most text one upload may carry — 1,000 rows of a price list is far less.
 * Kept under the server's 2 MB JSON body limit (lib/body-limits.ts) with room
 * for JSON escaping, so an oversized file gets THIS sentence rather than a
 * bare 413 from the layer before.
 */
const MAX_CSV_BYTES = 1.5 * 1024 * 1024;

/**
 * POST /api/product-bulk/csv — update products from a spreadsheet (catalogue staff).
 *
 *   { csv: string, apply?: boolean }
 *
 * The columns and rules are in lib/commerce/bulk-csv.ts. Without `apply: true`
 * it previews: per product what would change, rows it could not use and why,
 * and columns it ignored. Applying is the same path as every bulk change —
 * saveProduct per product, stock sold meanwhile kept, the batch undoable.
 *
 * A file with ANY row error cannot be applied: half a price list applied is
 * how a shop ends up with some prices from this season and some from the last.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const session = locals.user;
    if (!session || !canManageCatalog(session.role)) return ApiResponseBuilder.forbidden('Your role cannot edit products');
    const body = await request.json().catch(() => null) as { csv?: unknown; apply?: unknown } | null;
    if (typeof body?.csv !== 'string' || !body.csv.trim()) return ApiResponseBuilder.badRequest('Choose a CSV file.');
    if (Buffer.byteLength(body.csv) > MAX_CSV_BYTES) return ApiResponseBuilder.badRequest('The file is too large — at most 1.5 MB (about 1,000 rows fit easily).');

    await LocalDB.init();
    // A deep copy — on the JSON driver the getters return live objects; see product-bulk.ts.
    const all = structuredClone(await LocalDB.getProducts());
    const currency = await getShopCurrency();
    const plan = planCsvUpdate(parseCsv(body.csv), all, {
      minor: minorUnits(currency),
      money: (c) => formatMoney(c, { currency }),
    });
    const changing = plan.products.filter((p) => !p.skipped && p.changes.length);
    const summary = {
      keys: plan.keys,
      ignored_columns: plan.ignoredColumns,
      row_errors: plan.rowErrors,
      will_change: changing.length,
      unchanged: plan.products.filter((p) => !p.skipped && !p.changes.length).length,
      skipped: plan.products.filter((p) => p.skipped).length,
    };
    if (body.apply !== true) {
      return ApiResponseBuilder.success({
        preview: true, ...summary,
        products: plan.products.filter((p) => p.skipped || p.changes.length).map(({ patch: _p, ...rest }) => rest),
      });
    }
    if (plan.rowErrors.length) {
      return ApiResponseBuilder.badRequest(`Fix the ${plan.rowErrors.length} row problem${plan.rowErrors.length === 1 ? '' : 's'} first — nothing was changed.`);
    }
    const byId = new Map(all.map((p) => [String(p.id), p]));
    const result = await applyPlannedUpdates(changing, byId, {
      actor: String(session.id), kind: 'csv', label: `CSV update of ${changing.length} product${changing.length === 1 ? '' : 's'}`,
    });
    recordAudit(AUDIT.PRODUCT_BULK_EDIT, {
      actor: session.id, target: `${changing.length} products`, ip: locals.ip,
      metadata: { source: 'csv', ids: changing.map((p) => p.id), updated: result.updated, failed: result.failed.map((f) => f.id), batch: result.batch },
    });
    return ApiResponseBuilder.success({ preview: false, ...summary, ...result });
  } catch (err) {
    console.error('CSV product update error:', err);
    return ApiResponseBuilder.serverError('Failed to apply the CSV update');
  }
};
