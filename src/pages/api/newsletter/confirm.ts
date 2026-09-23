import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { readConfirmToken, makeUnsubscribeToken } from '../../../lib/newsletter-confirm';
import { fireEvent } from '../../../lib/webhooks';

/**
 * Complete a double opt-in.
 *
 * GET, not POST, because it is opened from an email client by clicking a link,
 * and it is exempt from CSRF for the same reason a magic link is: there is no
 * ambient authority to protect. The token IS the authorisation, it is
 * single-purpose, it expires, and it only ever reached the address it names.
 *
 * Redirects rather than returning JSON — a person is looking at this in a
 * browser, and a page of JSON is not an answer to "did that work?".
 */
export const prerender = false;

export const GET: APIRoute = async ({ url, redirect }) => {
  try {
    await LocalDB.init();
    const email = readConfirmToken(new URL(url).searchParams.get('token'));
    // One outcome for every kind of bad token — expired, forged, malformed.
    // Distinguishing them tells a prober something about the signing key and
    // changes nothing for the person holding a link that does not work.
    if (!email) return redirect('/newsletter/confirmed?ok=0', 302);

    // Idempotent: a link clicked twice, or a prefetching mail client that opens
    // it before the human does, must not create a second row. There is no
    // unique index on any driver, so uniqueness lives in the write.
    const existing = await LocalDB.getSubscribers();
    const already = (existing as { email?: string }[]).some(
      (s) => typeof s?.email === 'string' && s.email.trim().toLowerCase() === email,
    );
    if (!already) {
      await LocalDB.createSubscriber(email);
      // ESP sync (C-113). Fired only on a FIRST confirmation: a second click
      // must not re-import the address, and the double-opt-in click is the
      // only moment at which forwarding it to a third party is lawful.
      // Fire-and-forget, like every other event — a subscriber must not fail
      // to be recorded because somebody's automation is down.
      void fireEvent('subscriber.confirmed', { email, confirmed_at: new Date().toISOString() });
    }

    // The way out, handed over at the moment they join. This is what makes the
    // page's own promise about unsubscribe links TRUE — before this, nothing in
    // the codebase produced one and the function had zero callers.
    const leave = encodeURIComponent(makeUnsubscribeToken(email));
    return redirect(`/newsletter/confirmed?ok=1&u=${leave}`, 302);
  } catch (err) {
    console.error('Newsletter confirm error:', err);
    return redirect('/newsletter/confirmed?ok=0', 302);
  }
};
