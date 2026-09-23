/**
 * How often one mailbox may be written to by an anonymous form.
 *
 * ## The abuse this bounds
 *
 * The anonymous forms that send mail — the newsletter's confirmation, the
 * "tell me when it's back" signup — were limited per IP and per nothing else.
 * An IP limit protects the SHOP from one noisy client. It does nothing for the
 * person whose address is being typed: a botnet, or one patient script,
 * could send the same stranger a confirmation email every few seconds, from
 * the shop's own domain. The victim marks them as spam, and the shop's sending
 * reputation — shared with every order confirmation it sends — pays for it.
 *
 * So the second key is the RECIPIENT. A form that is over the recipient's
 * budget still answers exactly as if it had sent: the response must not become
 * a way to ask "has somebody signed this address up recently?".
 *
 * ## Normalised, so the budget cannot be dodged by spelling
 *
 * `Victim@Example.com`, `victim+1@example.com` and — at Gmail — `v.i.c.t.i.m`
 * all land in one inbox. The throttle key folds all of them together. This is
 * ONLY the key: the mail still goes to the address as typed, because a
 * provider that does not treat `+` as a tag would otherwise be sent mail for a
 * different person.
 *
 * ## Hashed before it reaches the store
 *
 * The rate-limit store is a table (`rate_limits`, on libSQL) that nobody
 * treats as holding personal data — it is not in the GDPR export, the erasure
 * sweep or the backup notes. So the address never goes into it: the key is an
 * HMAC keyed with the install's AUTH_SECRET, which a stolen table cannot be
 * reversed from with a list of likely addresses.
 *
 * ## Fails open, like every counter
 *
 * `consume` on the shared store fails OPEN when the store is down. For a
 * throttle that is the house rule (a limiter outage must not take a form
 * down), and the per-IP gate in front of this still applies.
 */
import crypto from 'node:crypto';
import { sharedRateLimitStore, type RateLimitStore } from './rate-limit';

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Domains whose local part ignores dots, and their canonical spelling. */
const DOTLESS_DOMAINS: Record<string, string> = {
  'gmail.com': 'gmail.com',
  'googlemail.com': 'gmail.com',
};

/**
 * The one spelling a mailbox is counted under, or null when it is not an
 * address at all.
 *
 * Lower-cased and trimmed; a `+tag` is dropped from the local part on every
 * domain (the common sub-addressing convention); dots are dropped where the
 * provider ignores them.
 */
export function canonicalMailbox(raw: unknown): string | null {
  const s = String(raw ?? '').trim().toLowerCase();
  if (s.length === 0 || s.length > 320) return null;
  const at = s.lastIndexOf('@');
  if (at <= 0 || at === s.length - 1) return null;
  let local = s.slice(0, at);
  let domain = s.slice(at + 1);
  const plus = local.indexOf('+');
  if (plus > 0) local = local.slice(0, plus);
  const dotless = DOTLESS_DOMAINS[domain];
  if (dotless) {
    domain = dotless;
    local = local.replace(/\./g, '');
  }
  if (!local) return null;
  return `${local}@${domain}`;
}

/**
 * The store key for `scope` and a mailbox. Never contains the address.
 *
 * Without a usable secret (a dev install), a plain SHA-256 — still not the
 * address in the clear, and production refuses to boot without AUTH_SECRET
 * anyway.
 */
export function recipientKey(
  scope: string,
  mailbox: string,
  secret: string | undefined = process.env.AUTH_SECRET,
): string {
  const key = String(secret ?? '');
  const digest = key.length >= 16
    ? crypto.createHmac('sha256', key).update(`${scope}\n${mailbox}`).digest('base64url')
    : crypto.createHash('sha256').update(`${scope}\n${mailbox}`).digest('base64url');
  return `rcpt:${scope}:${digest.slice(0, 32)}`;
}

export interface RecipientBudget {
  /** A name for the budget, so two forms do not share one. */
  scope: string;
  windowMs: number;
  /** Sends allowed per window, per mailbox. */
  limit: number;
}

/**
 * Count one send to `email` against `budget`. True when it may go out.
 *
 * An address that does not normalise is refused (false): every caller has
 * already validated the address, so reaching here with nonsense is a bug, and
 * a bug should not send mail.
 */
export async function allowRecipient(
  budget: RecipientBudget,
  email: unknown,
  store: RateLimitStore = sharedRateLimitStore(),
): Promise<boolean> {
  const mailbox = canonicalMailbox(email);
  if (!mailbox) return false;
  const result = await store.consume(recipientKey(budget.scope, mailbox), budget.windowMs, budget.limit);
  return result.allowed;
}

/**
 * The newsletter's confirmation: ONE per mailbox per day.
 *
 * A confirmation link is valid for a week (`CONFIRM_TTL_MS`), so a second one
 * inside a day adds nothing the first did not — a person who lost the first
 * email finds it in their spam folder, or asks again tomorrow. One per day is
 * also the most a stranger can make this shop send to somebody else.
 *
 * On the shared libSQL store the window is the UTC calendar day (that store
 * buckets by a floored window index), so the worst case is one either side of
 * midnight.
 */
export const NEWSLETTER_CONFIRM_BUDGET: RecipientBudget = {
  scope: 'newsletter-confirm',
  windowMs: DAY_MS,
  limit: 1,
};

/**
 * Back-in-stock signups: ten per mailbox per day.
 *
 * No mail is sent at signup — the cost is deferred: each signup is one email
 * on the day that product returns. Ten a day is a shopper watching a handful
 * of sold-out sizes; five thousand (the per-product ceiling) signed up to one
 * victim across a catalogue is five thousand emails the day stock arrives.
 */
export const WAITLIST_SIGNUP_BUDGET: RecipientBudget = {
  scope: 'notify-me',
  windowMs: DAY_MS,
  limit: 10,
};
