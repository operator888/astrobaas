/**
 * Is this a plausible address to send an order confirmation to?
 *
 * POST /api/orders validated the buyer's email with `/.+@.+\..+/` — UNANCHORED,
 * so any string CONTAINING something address-shaped passed: "not an email
 * a@b.co", "<a@b.co>", and — the one that matters — an address followed by a
 * line break and a header. Checkout mails that field, so the pattern was the
 * only thing between a stranger and the confirmation's header block.
 *
 * Deliberately a SHAPE check, like `parseRecipients` in sale-notify.ts, and not
 * RFC 5322: refusing a real customer's address loses the sale, accepting an odd
 * one costs one bounce. What it must refuse is input that is not one address.
 *
 *  - anchored, one `@`, something either side;
 *  - no whitespace, no control characters, none of the characters that
 *    delimit or quote an address in a header (`<>()[],;:\"'`);
 *  - a domain of dot-separated non-empty labels, the last at least two
 *    characters — letters, digits and hyphens in any script, because both
 *    live shops are Greek and `.ελ` / `xn--qxam` are real TLDs;
 *  - at most 254 characters, the SMTP path limit.
 *
 * Internationalised local parts are accepted for the same reason.
 */
const LOCAL = /^[^\s@<>()[\],;:\\"']+$/u;
const LABEL = /^[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?$/u;

export const MAX_EMAIL_LENGTH = 254;

export function isCheckoutEmail(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (value.length < 3 || value.length > MAX_EMAIL_LENGTH) return false;
  // Any control character — CR and LF above all — is a header, not an address.
  if (/\p{Cc}/u.test(value)) return false;
  const at = value.indexOf('@');
  if (at <= 0 || at !== value.lastIndexOf('@')) return false;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (local.length > 64 || !LOCAL.test(local)) return false;
  const labels = domain.split('.');
  if (labels.length < 2) return false;
  if (!labels.every((l) => l.length > 0 && l.length <= 63 && LABEL.test(l))) return false;
  return labels[labels.length - 1].length >= 2;
}
