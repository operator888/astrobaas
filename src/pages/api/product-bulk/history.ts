import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { canManageCatalog } from '../../../lib/auth';
import { recentBatches } from '../../../lib/commerce/bulk-apply';

/** GET /api/product-bulk/history — the recent bulk changes, newest first, for the Undo list (catalogue staff). */
export const GET: APIRoute = async ({ locals }) => {
  const session = locals.user;
  if (!session || !canManageCatalog(session.role)) return ApiResponseBuilder.forbidden('Your role cannot edit products');
  await LocalDB.init();
  const batches = (await recentBatches()).map((b) => ({
    id: b.id, at: b.at, actor: b.actor, kind: b.kind, label: b.label,
    products: Object.keys(b.products).length,
    undone_at: b.undone_at ?? null,
  }));
  return ApiResponseBuilder.success(batches);
};
