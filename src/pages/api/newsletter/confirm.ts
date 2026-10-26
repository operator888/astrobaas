import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { readConfirmToken, readConfirmConsent, makeUnsubscribeToken } from '../../../lib/newsletter-confirm';
import { confirmNewsletterSignup } from '../../../lib/consent-service';

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
 *
 * The click writes the consent ledger: the grant the signup made (with the
 * wording's version and hash, carried in the signed link) and its confirmation.
 * The confirmation is what puts the address on the list — in consent-service.ts,
 * the one place that decides it for core's forms and for plugins alike, and
 * idempotently: a link clicked twice, or a prefetching mail client, adds no
 * second row and fires no second `subscriber.confirmed`. A link minted before
 * the person last unsubscribed no longer works.
 */
export const prerender = false;

export const GET: APIRoute = async ({ url, redirect }) => {
  try {
    await LocalDB.init();
    const token = new URL(url).searchParams.get('token');
    const email = readConfirmToken(token);
    const consent = readConfirmConsent(token);
    // One outcome for every kind of bad token — expired, forged, malformed.
    // Distinguishing them tells a prober something about the signing key and
    // changes nothing for the person holding a link that does not work.
    if (!email || !consent) return redirect('/newsletter/confirmed?ok=0', 302);

    // A link minted before the person unsubscribed is dead — the same failure
    // page, and nothing written (consent-service.ts says why).
    const { confirmed } = await confirmNewsletterSignup(email, consent);
    if (!confirmed) return redirect('/newsletter/confirmed?ok=0', 302);

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
