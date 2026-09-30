import type { APIRoute } from 'astro';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { LocalDB } from '../../../lib/localdb';
import { recordAudit, AUDIT } from '../../../lib/audit';
import { clearPopular } from '../../../lib/search/popular-store';

/**
 * DELETE /api/search/popular — forget every counted search (admin).
 *
 * The operator's way to start popular-search suggestions again from nothing —
 * after a campaign that skewed them, or simply because they want the counts
 * gone. Audited.
 */
export const DELETE: APIRoute = async ({ locals }) => {
  if (locals.user?.role !== 'admin') return ApiResponseBuilder.forbidden('Only an administrator can clear the search counts');
  await LocalDB.init();
  await clearPopular();
  recordAudit(AUDIT.SEARCH_POPULAR_CLEAR, { actor: locals.user.id, target: 'popular searches', ip: locals.ip });
  return ApiResponseBuilder.success({ cleared: true });
};
