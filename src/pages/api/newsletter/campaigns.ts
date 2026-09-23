/**
 * Newsletter campaigns (C-111) — list, compose, send.
 *
 * ## Stored as an ordinary custom entity
 *
 * Not a new top-level table: that would mean a migration on three drivers, a
 * backup entry and a line in the GDPR sweep, for a collection with five fields
 * and one reader. `createCustomEntity` already works everywhere.
 *
 * ## Sending is a STATE CHANGE, not a loop
 *
 * This route sets `status: 'sending'` and returns. The scheduler's existing
 * tick sends a batch at a time from the cursor on the record. A request that
 * looped over the whole list would hold a connection open for minutes, would
 * lose everything if the client hung up, and would restart from the beginning
 * after a deploy — and sending a newsletter twice is the failure people
 * actually remember.
 */
import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { emailChannelActive, campaignsEnabled } from '../../../lib/email';
import { CAMPAIGN_TYPE, campaignProblem } from '../../../lib/newsletter-campaign';

export const prerender = false;

const staff = (locals: App.Locals) =>
  locals.user?.role === 'admin' || locals.user?.role === 'editor';

export const GET: APIRoute = async ({ locals }) => {
  try {
    if (!staff(locals)) return ApiResponseBuilder.forbidden('Staff only');
    await LocalDB.init();
    const rows = await LocalDB.getCustomEntities(CAMPAIGN_TYPE) as {
      id: string; data?: Record<string, unknown>; created_at?: string;
    }[];
    const subscribers = await LocalDB.getSubscribers();
    return ApiResponseBuilder.success({
      campaigns: rows
        .map((r) => ({ id: r.id, created_at: r.created_at, ...(r.data ?? {}) }))
        .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? ''))),
      subscriberCount: subscribers.length,
      // So the composer can say "this cannot be delivered" BEFORE somebody
      // writes a newsletter, rather than after they press Send.
      emailChannelReady: emailChannelActive(),
    }, 'Campaigns');
  } catch (err) {
    console.error('Campaign list error:', err);
    return ApiResponseBuilder.serverError('Could not load campaigns');
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    if (!staff(locals)) return ApiResponseBuilder.forbidden('Staff only');
    await LocalDB.init();

    const body = await request.json().catch(() => null) as {
      subject?: string; body?: string; send?: boolean;
    } | null;
    const subject = String(body?.subject ?? '').trim();
    const text = String(body?.body ?? '').trim();

    const subscribers = await LocalDB.getSubscribers();
    const problem = campaignProblem(
      { subject, body: text }, subscribers.length, emailChannelActive(), campaignsEnabled(),
    );
    // Checked BEFORE anything is queued, so an operator finds out at the moment
    // they press Send rather than from a half-delivered list.
    if (problem && body?.send) return ApiResponseBuilder.badRequest(problem);
    if (!subject) return ApiResponseBuilder.badRequest('A campaign needs a subject.');

    const created = await LocalDB.createCustomEntity(CAMPAIGN_TYPE, {
      subject,
      body: text,
      status: body?.send ? 'sending' : 'draft',
      cursor: 0,
      sent_count: 0,
      failed_count: 0,
      // Snapshotted so the report afterwards says how many it was AIMED at,
      // which a later count cannot reconstruct once people unsubscribe.
      audience: subscribers.length,
    });
    if (!created) return ApiResponseBuilder.serverError('Could not save the campaign');

    return ApiResponseBuilder.created({
      id: created.id,
      status: body?.send ? 'sending' : 'draft',
      audience: subscribers.length,
    }, body?.send
      ? `Sending to ${subscribers.length} subscriber${subscribers.length === 1 ? '' : 's'}, a batch at a time.`
      : 'Draft saved.');
  } catch (err) {
    console.error('Campaign create error:', err);
    return ApiResponseBuilder.serverError('Could not create the campaign');
  }
};
