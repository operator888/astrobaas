/**
 * The gate every anonymous write passes through.
 *
 * ## Why one gate
 *
 * There were three, written separately, and they had drifted in a way that
 * mattered: the content-type form had a FORM-SHAPED rate limit (ten per
 * fifteen minutes per IP), and `/api/contact` and `/api/newsletter` had none —
 * only the middleware's generic per-IP write limit, which is set for an API
 * client rather than for a person filling in a form. So the two doors a
 * stranger is most likely to find were the two least protected, and nothing
 * said so.
 *
 * The other two stages were also spelled three times, and one of them answered
 * differently: two copies replied "success" to a honeypot hit and one replied
 * "created", which is the difference between a bot learning nothing and a bot
 * learning it was caught.
 *
 * ## The order is the design
 *
 * Cheapest first, so the traffic most likely to be junk costs least:
 *
 *   1. **rate limit** — no parsing, no hashing, no database read;
 *   2. **honeypot** — a string comparison, and the answer is a LIE (a bot told
 *      it failed retries with the field removed);
 *   3. **proof of work** — a hash verification, and the answer is HONEST,
 *      because the widget needs the signal to recompute and "your proof was
 *      stale" reveals nothing about the site;
 *   4. **score** — structural signals only, and it never rejects. See
 *      `spam-score.ts` for why holding beats refusing.
 *
 * ## Shape
 *
 * Returns a DECISION rather than a Response, because the three callers phrase
 * their success differently ("Message received", "Subscribed", "<Label>
 * received") and a gate that owned the wording would make them all say the same
 * wrong thing.
 */
import { sharedRateLimitStore } from './rate-limit';
import { captchaCheck, type CaptchaSurface } from './captcha';
import { scoreSubmission, type SpamVerdict } from './spam-score';

/** The two meta-fields every public form carries. */
export const HONEYPOT_FIELD = 'hp_url';
export const POW_FIELD = 'pow_token';

/**
 * Per IP, per surface. Fifteen minutes is long enough that a burst is a script
 * and short enough that a person who mistyped their address twice is not
 * locked out of a shop for the afternoon.
 */
export const SUBMIT_WINDOW_MS = 15 * 60 * 1000;
export const SUBMIT_LIMIT = 10;

export type SubmissionDecision =
  /** Everything passed. `spam` carries the score, which the caller stores. */
  | { kind: 'ok'; spam: SpamVerdict }
  /** The honeypot was filled. Answer with SUCCESS and store nothing. */
  | { kind: 'silent' }
  /** Too many from this address. */
  | { kind: 'rate-limited' }
  /** The proof of work was missing or stale. Honest failure. */
  | { kind: 'challenge-failed' };

export interface SubmissionGateInput {
  /** Rate-limit bucket name — the form's own id, so one form cannot exhaust another. */
  surface: string;
  /** The caller's IP, from `locals.ip`. */
  ip: string;
  /** The parsed body. Non-objects are treated as empty rather than throwing. */
  body: unknown;
  /** Which captcha surface this form is, for the operator's per-form switch. */
  captchaSurface: CaptchaSurface;
  /** Skip the score — for a form whose values are not free text (an unsubscribe). */
  score?: boolean;
}

/**
 * Run the gate. The caller shapes the response from the decision.
 *
 * Never throws: every stage that could fail (the rate-limit store, the captcha
 * verifier) already degrades internally, and a gate that threw would turn a
 * transient storage blip into a 500 on a contact form.
 */
export async function publicSubmissionGate(
  input: SubmissionGateInput,
): Promise<SubmissionDecision> {
  const values = (input.body && typeof input.body === 'object' && !Array.isArray(input.body))
    ? input.body as Record<string, unknown>
    : {};

  const allowed = await sharedRateLimitStore().hit(
    `submit:${input.surface}|${input.ip}`, SUBMIT_WINDOW_MS, SUBMIT_LIMIT,
  );
  if (!allowed) return { kind: 'rate-limited' };

  // Humans leave it empty; bots fill every field they find.
  const hp = values[HONEYPOT_FIELD];
  if (typeof hp === 'string' && hp.trim() !== '') return { kind: 'silent' };

  const pow = await captchaCheck(values[POW_FIELD], input.captchaSurface);
  if (!pow.ok) return { kind: 'challenge-failed' };

  // The meta-fields are not content and must not be scored: a proof-of-work
  // token is a long run of characters, which is one of the signals.
  const scored: Record<string, unknown> = { ...values };
  delete scored[HONEYPOT_FIELD];
  delete scored[POW_FIELD];

  return {
    kind: 'ok',
    spam: input.score === false
      ? { score: 0, flagged: false, signals: [] }
      : scoreSubmission(scored),
  };
}

/** The two fields a stored record carries when a submission was scored. */
export function spamFields(spam: SpamVerdict): Record<string, unknown> {
  // Only written when there is something to say. A `spam_score: 0` on every
  // record is a column of zeroes that makes the flagged ones no easier to find.
  if (!spam.flagged) return {};
  return {
    spam_score: spam.score,
    spam_flagged: true,
    spam_reasons: spam.signals.map((s) => s.reason),
  };
}
