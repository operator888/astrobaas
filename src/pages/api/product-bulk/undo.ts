import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { canManageCatalog } from '../../../lib/auth';
import { recordAudit, AUDIT } from '../../../lib/audit';
import { planUndo, HISTORY_NS, type BatchRecord } from '../../../lib/commerce/bulk-history';
import { applyPlannedUpdates, claimUndo, releaseUndo } from '../../../lib/commerce/bulk-apply';

/**
 * POST /api/product-bulk/undo — put a bulk change back (catalogue staff).
 *
 *   { batch: string, apply?: boolean }
 *
 * Restores each field only while it still holds the value the batch gave it;
 * anything changed since — a later edit, stock a checkout sold — is left as it
 * is and listed. Previews unless `apply: true`. A batch is undone once; the
 * undo is itself a batch, so it can in turn be undone.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const session = locals.user;
    if (!session || !canManageCatalog(session.role)) return ApiResponseBuilder.forbidden('Your role cannot edit products');
    const body = await request.json().catch(() => null) as { batch?: unknown; apply?: unknown } | null;
    if (typeof body?.batch !== 'string' || !/^b-[a-z0-9-]{1,40}$/.test(body.batch)) return ApiResponseBuilder.badRequest('Choose a change to undo.');

    await LocalDB.init();
    const row = await LocalDB.getPluginDataRecord(HISTORY_NS, body.batch);
    if (!row) return ApiResponseBuilder.notFound('Bulk change');
    const record = row.data as unknown as BatchRecord;
    if (record.undone_at) return ApiResponseBuilder.error(409, 'That change has already been undone.');

    // A deep copy — on the JSON driver the getters return live objects; see product-bulk.ts.
    const all = structuredClone(await LocalDB.getProducts());
    const byId = new Map(all.map((p) => [String(p.id), p]));
    const plans = planUndo(record, byId);
    const restoring = plans.filter((p) => p.restored.length);
    const summary = {
      label: record.label,
      will_restore: restoring.length,
      kept: plans.filter((p) => p.kept.length).length,
      missing: plans.filter((p) => p.missing).length,
    };
    if (body.apply !== true) {
      return ApiResponseBuilder.success({ preview: true, ...summary, products: plans.map(({ patch: _p, ...rest }) => rest) });
    }
    // Claimed first, so a double click or a second admin cannot run it twice.
    if (!(await claimUndo(record, String(session.id)))) return ApiResponseBuilder.error(409, 'That change is already being undone, or has been.');
    let result;
    try {
      result = await applyPlannedUpdates(restoring, byId, {
        actor: String(session.id), kind: 'undo', label: `Undo: ${record.label}`,
      });
    } catch (err) {
      await releaseUndo(record, false);
      throw err;
    }
    // If nothing could be put back, release the claim so it can be retried.
    await releaseUndo(record, result.updated > 0 || restoring.length === 0);
    recordAudit(AUDIT.PRODUCT_BULK_EDIT, {
      actor: session.id, target: `${restoring.length} products`, ip: locals.ip,
      metadata: { undo: record.id, updated: result.updated, failed: result.failed.map((f) => f.id), batch: result.batch },
    });
    return ApiResponseBuilder.success({ preview: false, ...summary, ...result });
  } catch (err) {
    console.error('Bulk undo error:', err);
    return ApiResponseBuilder.serverError('Failed to undo the bulk change');
  }
};
