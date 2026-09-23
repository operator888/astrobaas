/**
 * Double opt-in for the mailing list.
 *
 * ## What was there
 *
 * `POST /api/newsletter` validated the address, ran the anti-spam checks, and
 * called `createSubscriber` — so the address was on the list at that instant.
 * Anyone could therefore subscribe anyone: type a stranger's address into the
 * blog footer and they are on a Greek shop's mailing list without ever having
 * asked. That is a spam complaint waiting to happen, and under GDPR it is
 * processing personal data with no lawful basis at all, because the person the
 * data belongs to never did anything.
 *
 * ## Nothing is stored until they say yes
 *
 * The obvious implementation adds `confirmed_at` and a token column to
 * Subscriber and stores an unconfirmed row. This does not, for two reasons:
 *
 *   1. **Holding it is the problem.** An unconfirmed address is a record about
 *      a person who never consented. Storing one and hoping to clean it up
 *      later is the same mistake in a smaller font. Nothing is written until
 *      the person clicks.
 *   2. **Three drivers.** A new persisted shape has to work on lowdb, libSQL
 *      and the relational storage alike, with no unique index anywhere to lean
 *      on. Not storing anything needs none of that.
 *
 * So the confirmation link CARRIES the address, signed. The token is an HMAC
 * over `{ email, purpose, exp }` using the same `signPurposeToken` primitive the
 * magic-link and password-reset flows use — one signing implementation, already
 * reviewed, rather than a second one written for this.
 *
 * ## The address is in a URL, and that is a deliberate trade
 *
 * A signed token containing an email lands in the recipient's browser history
 * and in any referrer the confirmation page leaks. The mitigations are that the
 * link is single-purpose, expires, goes only to the address it names — nobody
 * receives a token for an address that is not theirs — and the confirmation
 * page must not link anywhere off-site. Storing an unconfirmed row instead
 * would trade that for holding data about someone who never consented, which is
 * worse.
 */
import { signPurposeToken, verifyPurposeToken } from './auth';
import { renderEmailTemplate } from './email-templates';

/**
 * How long a confirmation link is good for.
 *
 * Long enough to survive a weekend and a spam folder; short enough that a
 * forwarded old email cannot enrol somebody months later.
 */
export const CONFIRM_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Sign a confirmation for this address. */
export function makeConfirmToken(email: string): string {
  return signPurposeToken('newsletter', { em: email.trim().toLowerCase() }, CONFIRM_TTL_MS);
}

/**
 * Read the address out of a token, or null.
 *
 * Null covers every failure the same way — bad signature, wrong purpose,
 * expired, malformed — because distinguishing them for the caller would let
 * someone probe the signing key's behaviour, and none of the differences change
 * what the endpoint does.
 */
export function readConfirmToken(token: string | undefined | null): string | null {
  const payload = verifyPurposeToken('newsletter', token);
  if (!payload) return null;
  const email = payload.em;
  if (typeof email !== 'string') return null;
  const trimmed = email.trim().toLowerCase();
  // Re-validated after decoding. A token is signed by us, but "signed" only
  // means it was not tampered with — if a malformed address ever got signed,
  // this is the last place to catch it before it reaches storage.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed) && trimmed.length <= 200 ? trimmed : null;
}

/** The link that goes in the email. */
export function confirmUrl(origin: string, token: string): string {
  return `${origin.replace(/\/$/, '')}/api/newsletter/confirm?token=${encodeURIComponent(token)}`;
}

/**
 * The message. Plain text: a subscription confirmation needs no markup.
 *
 * `stored` is the operator's template override (C-112), passed in rather than
 * read here so this function stays pure and its tests need no database. The
 * template definition requires `{{confirm_link}}`: double opt-in without one
 * gives a subscriber who can never be mailed and a list that looks broken.
 */
export function confirmEmail(
  email: string,
  url: string,
  siteTitle?: string,
  stored?: unknown,
): { to: string; subject: string; text: string } {
  const shop = (siteTitle || 'our newsletter').replace(/[\r\n]+/g, ' ').trim();
  const rendered = renderEmailTemplate('newsletter_confirm', { site_title: shop, confirm_link: url }, stored);
  return { to: email, subject: rendered!.subject, text: rendered!.text };
}


/* ---------- Leaving ---------- */

/**
 * How long an unsubscribe link is good for.
 *
 * A year, and deliberately long. An unsubscribe link that has expired is worse
 * than useless: the person is trying to leave, cannot, and their only remaining
 * option is to mark the message as spam — which costs the shop its
 * deliverability for everyone.
 */
export const UNSUBSCRIBE_TTL_MS = 365 * 24 * 60 * 60 * 1000;

/** Sign a leave-link for this address. */
export function makeUnsubscribeToken(email: string): string {
  return signPurposeToken('unsub', { em: email.trim().toLowerCase() }, UNSUBSCRIBE_TTL_MS);
}

/**
 * Read the address out of an unsubscribe token, or null.
 *
 * A SEPARATE purpose from the confirmation token, so one cannot be replayed as
 * the other. Signing them the same way would mean a confirmation link — which
 * an attacker who guessed an address could cause to be sent — doubled as a way
 * to unsubscribe somebody.
 */
export function readUnsubscribeToken(token: string | undefined | null): string | null {
  const payload = verifyPurposeToken('unsub', token);
  if (!payload) return null;
  const email = payload.em;
  if (typeof email !== 'string') return null;
  const trimmed = email.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed) && trimmed.length <= 200 ? trimmed : null;
}

/** The link every outgoing newsletter must carry. */
export function unsubscribeUrl(origin: string, email: string): string {
  return `${origin.replace(/\/$/, '')}/api/newsletter/unsubscribe`
    + `?token=${encodeURIComponent(makeUnsubscribeToken(email))}`;
}
