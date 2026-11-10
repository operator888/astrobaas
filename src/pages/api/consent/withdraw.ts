import type { APIRoute } from 'astro';
import { readConsentWithdrawToken } from '../../../lib/newsletter-confirm';
import { withdrawConsent } from '../../../lib/consent-service';

/**
 * Withdraw a consent from a link — public, token-signed.
 *
 * `/api/consent/withdraw?token=…`. The token is minted by
 * `consentWithdrawUrl(origin, email, purpose)` — for plugins,
 * `host.consent.withdrawUrl({ email, purpose })` — and names ONE address and
 * ONE purpose; it is signed with its own purpose tag (`consent-wd`), so neither
 * a newsletter confirmation link nor an unsubscribe link can be replayed here.
 * The newsletter's own way out stays `/api/newsletter/unsubscribe`.
 *
 * Two verbs, like the unsubscribe route:
 *  - GET is the link a person clicks in an email: it withdraws and redirects to
 *    `/consent/withdrawn`, a page that links nowhere off-site (the URL carries
 *    the token).
 *  - POST is RFC 8058-shaped for a machine: no session, token in the QUERY, and
 *    the SAME bare `200 {"success":true}` for a good token, a bad one and none —
 *    distinguishing them would say whether an address had consented.
 *
 * Either way a withdrawal APPENDS a row (`source: 'withdraw_link'`); it never
 * edits one.
 */
export const prerender = false;

async function withdrawByToken(token: string | null): Promise<boolean> {
  const named = readConsentWithdrawToken(token);
  if (!named) return false;
  await withdrawConsent({ email: named.email, purpose: named.purpose, source: 'withdraw_link' });
  return true;
}

export const GET: APIRoute = async ({ url, redirect }) => {
  try {
    const done = await withdrawByToken(new URL(url).searchParams.get('token'));
    return redirect(`/consent/withdrawn?ok=${done ? 1 : 0}`, 302);
  } catch (err) {
    console.error('Consent withdraw (link) error:', err);
    return redirect('/consent/withdrawn?ok=0', 302);
  }
};

export const POST: APIRoute = async ({ url }) => {
  try {
    await withdrawByToken(new URL(url).searchParams.get('token'));
  } catch (err) {
    console.error('Consent withdraw (link) error:', err);
  }
  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
};
