import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { readUnsubscribeToken } from '../../../lib/newsletter-confirm';
import { withdrawConsent } from '../../../lib/consent-service';
import { NEWSLETTER_PURPOSE } from '../../../lib/consent-ledger';

/**
 * Leave the mailing list.
 *
 * The confirmation page promises that "every email we send has an unsubscribe
 * link", and for a while that was a lie: there was no way to leave and no way
 * to remove a single subscriber at all. Under GDPR the right to withdraw
 * consent has to be as easy as giving it, and commercially an unsubscribe that
 * does not work costs the shop its deliverability — the only remaining option a
 * trapped recipient has is to mark the message as spam.
 *
 * GET and public for the same reasons as the confirmation route: it is opened
 * from a mail client, there is no session to protect, and the signed
 * single-purpose token IS the authorisation. The token's purpose differs from
 * the confirmation one, so neither can be replayed as the other.
 *
 * Idempotent, and answers the same way whether the address was on the list or
 * not: telling a caller "that address was not subscribed" would turn this into
 * a way to ask who is.
 */
export const prerender = false;

/**
 * Remove the address a token names. Returns false for a bad or expired token.
 *
 * Shared by the GET a human clicks and the POST a mail client sends, because
 * two copies of "delete every matching row and fire exactly one event" is two
 * chances to fix one of them.
 */
async function unsubscribeByToken(token: string | null, source: string): Promise<boolean> {
  await LocalDB.init();
  const email = readUnsubscribeToken(token);
  if (!email) return false;
  // A WITHDRAWAL in the consent ledger, which also removes every subscriber row
  // for the address and fires `subscriber.unsubscribed` exactly once — even when
  // no row was left to delete (consent-service.ts `unsubscribeAll` says why).
  await withdrawConsent({ email, purpose: NEWSLETTER_PURPOSE, source });
  return true;
}

export const GET: APIRoute = async ({ url, redirect }) => {
  try {
    const done = await unsubscribeByToken(new URL(url).searchParams.get('token'), 'unsubscribe_link');
    return redirect(`/newsletter/unsubscribed?ok=${done ? 1 : 0}`, 302);
  } catch (err) {
    console.error('Newsletter unsubscribe error:', err);
    return redirect('/newsletter/unsubscribed?ok=0', 302);
  }
};

/**
 * RFC 8058 one-click, and the button readers actually press.
 *
 * Every campaign message carries `List-Unsubscribe-Post: List-Unsubscribe=One-Click`
 * (newsletter-campaign.ts), which is what makes Gmail and Outlook show their own
 * Unsubscribe control at the top of the message. Pressing it sends a POST — and
 * this route had only a GET, so the mail client got a 405, nothing was removed,
 * and the reader's next move is the spam button. That costs the shop the
 * deliverability of its ORDER CONFIRMATIONS too, which is why the header is
 * called the load-bearing part where it is set.
 *
 * Three things RFC 8058 requires, and each is a deliberate difference from the
 * GET above:
 *
 *  * The token stays in the QUERY STRING. A one-click sender POSTs the URL from
 *    the header verbatim and puts only `List-Unsubscribe=One-Click` in the body,
 *    so parsing the body for a token would find nothing.
 *  * A bare 2xx, never a redirect. No human is looking; a 302 to an HTML page
 *    is at best ignored and at worst read as a failure.
 *  * The same answer for a bad token as for a good one — 200 either way. A
 *    machine cannot act on the difference, and distinguishing them would say
 *    whether an address was on the list.
 */
export const POST: APIRoute = async ({ url }) => {
  try {
    await unsubscribeByToken(new URL(url).searchParams.get('token'), 'one_click');
  } catch (err) {
    console.error('Newsletter one-click unsubscribe error:', err);
  }
  return new Response(null, { status: 200 });
};
