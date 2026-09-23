import type { APIRoute } from 'astro';
import { LocalDB } from '../../../../lib/localdb';
import { ApiResponseBuilder } from '../../../../lib/api-response';
import { fireEvent } from '../../../../lib/webhooks';

/**
 * Take ONE person off the mailing list, as the operator.
 *
 * ## Why this exists separately from the erasure
 *
 * Before this, the only code path in the product that removed a subscriber was
 * the GDPR erasure — and that also deletes the person's customer record, every
 * contact message they ever sent, and their entry in the email log, and
 * pseudonymises their orders. So an operator asked "please stop emailing me" on
 * the phone had two options: destroy that person's entire order-adjacent
 * history, or refuse and leave them on the list. Neither is the right answer to
 * a request that means one thing.
 *
 * The public page at `/newsletter/unsubscribed` explicitly tells readers they
 * may reply to any message to be removed by hand, which nobody could action.
 *
 * ## Staff-gated, and deliberately NOT token-gated
 *
 * The public one-click route authorises a stranger with a signed token. This
 * one authorises a logged-in staff member the ordinary way, and must never
 * appear in `PUBLIC_API_WRITE` or `CSRF_EXEMPT_WRITE`: it takes an id, so
 * without a session it would let anyone remove anyone.
 */
export const prerender = false;

/** The same predicate `campaigns.ts` uses — whoever may send to the list may prune it. */
const staff = (locals: App.Locals) =>
  locals.user?.role === 'admin' || locals.user?.role === 'editor';

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    if (!staff(locals)) return ApiResponseBuilder.forbidden('Staff only');

    const body = await request.json().catch(() => null) as { id?: unknown } | null;
    const id = typeof body?.id === 'string' ? body.id.trim() : '';
    if (!id) return ApiResponseBuilder.badRequest('id is required');

    await LocalDB.init();
    const all = await LocalDB.getSubscribers() as { id?: string; email?: string }[];
    const row = all.find((s) => s.id === id);
    // 404 rather than a silent success: unlike the public route there is no
    // enumeration concern here — the caller is staff and is already looking at
    // the list — and an operator pressing Remove twice should be told the
    // second press did nothing rather than believe it worked.
    if (!row) return ApiResponseBuilder.notFound('Subscriber');

    const email = String(row.email ?? '').trim().toLowerCase();
    await LocalDB.deleteSubscriber(id);

    // The SAME event the public unsubscribe fires. An address removed here but
    // left live at the ESP is exactly the "honoured on this site, not at the
    // provider" shape that ends in a spam complaint — and the person would
    // rightly say they asked and nothing happened.
    void fireEvent('subscriber.unsubscribed', { email, unsubscribed_at: new Date().toISOString() });

    return ApiResponseBuilder.success({ id, email });
  } catch (err) {
    console.error('Subscriber delete error:', err);
    return ApiResponseBuilder.serverError('Could not remove the subscriber');
  }
};
