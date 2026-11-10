import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { canManageCatalog } from '../../../lib/auth';
import { recordAudit, AUDIT } from '../../../lib/audit';
import { fireEvent } from '../../../lib/webhooks';
import { ensurePluginsBootstrapped } from '../../../plugins';
import {
  REVIEWS_TYPE, REVIEW_ACTIONS, REVIEW_BULK_MAX, stateForAction, reviewModerationPatch,
  announceReviewRemoved, type ReviewAction, type ReviewRow,
} from '../../../lib/reviews';

/**
 * `POST /api/reviews/moderate` — approve, reject, mark as spam, send back to
 * pending, or delete one or more reviews (C-35). Staff only.
 *
 * Body: `{ ids: string[], action: 'approve' | 'reject' | 'spam' | 'pending' | 'delete' }`.
 *
 * One request moderates up to REVIEW_BULK_MAX reviews, so "approve the
 * selected" is one call rather than a loop of PUTs, and it is ONE audit entry
 * naming the actor, the action and every id. Unknown ids are reported in
 * `missing` rather than failing the batch: two moderators working the same
 * queue will delete each other's rows, and the second must not lose the rest
 * of their selection to it.
 */
export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const session = locals.user;
    if (!session) return ApiResponseBuilder.unauthorized();
    if (!canManageCatalog(session.role)) {
      return ApiResponseBuilder.forbidden('You do not have permission to moderate reviews');
    }
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const action = body?.action;
    if (typeof action !== 'string' || !(REVIEW_ACTIONS as readonly string[]).includes(action)) {
      return ApiResponseBuilder.validationError('Invalid moderation request', {
        action: `must be one of: ${REVIEW_ACTIONS.join(', ')}`,
      });
    }
    const rawIds = Array.isArray(body?.ids) ? body.ids : [];
    const ids = [...new Set(rawIds.filter((v): v is string => typeof v === 'string' && v.length > 0 && v.length <= 100))];
    if (ids.length === 0 || ids.length > REVIEW_BULK_MAX || ids.length !== rawIds.length) {
      return ApiResponseBuilder.validationError('Invalid moderation request', {
        ids: `must be 1–${REVIEW_BULK_MAX} distinct review ids`,
      });
    }

    await LocalDB.init();
    await ensurePluginsBootstrapped();
    const next = stateForAction(action as ReviewAction);
    const now = new Date().toISOString();
    const done: string[] = [];
    const missing: string[] = [];

    for (const id of ids) {
      const row = await LocalDB.getCustomEntity(REVIEWS_TYPE, id) as ReviewRow | null | undefined;
      if (!row) { missing.push(id); continue; }
      if (next === null) {
        const ok = await LocalDB.deleteCustomEntity(REVIEWS_TYPE, id);
        if (!ok) { missing.push(id); continue; }
        announceReviewRemoved(row, 'deleted');
        fireEvent('content.deleted', { type: REVIEWS_TYPE, id }).catch(() => {});
        done.push(id);
        continue;
      }
      const patch = reviewModerationPatch(row.data, next, now);
      if (Object.keys(patch).length === 0) { done.push(id); continue; }
      const updated = await LocalDB.updateCustomEntity(REVIEWS_TYPE, id, patch);
      if (!updated) { missing.push(id); continue; }
      fireEvent('content.updated', { type: REVIEWS_TYPE, entity: updated }).catch(() => {});
      done.push(id);
    }

    recordAudit(AUDIT.REVIEW_MODERATE, {
      actor: session.id,
      target: `${done.length} review${done.length === 1 ? '' : 's'}`,
      ip: locals.ip,
      metadata: { action, ids: done, missing },
    });

    return ApiResponseBuilder.success({ action, updated: done, missing },
      `${done.length} review${done.length === 1 ? '' : 's'} updated`);
  } catch (err) {
    console.error('Review moderation error:', err);
    return ApiResponseBuilder.serverError('Could not moderate the reviews');
  }
};
