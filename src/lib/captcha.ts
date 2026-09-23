/**
 * Local proof-of-work CAPTCHA — anti-spam with no third party in the loop.
 *
 * The trade every hosted CAPTCHA makes (hand your visitors to Google or
 * Cloudflare in exchange for bot-filtering) is one a self-hosted, GDPR-first
 * CMS should not force. Proof-of-work makes the OTHER trade: no tracking, no
 * puzzles, no vendor — the browser must burn a fraction of a second of CPU
 * per submission. A human never notices; a spam run that used to cost
 * nothing per attempt now costs compute per attempt, which is the economics
 * spam actually responds to.
 *
 * Shape:
 *  1. The form's page fetches `GET /api/captcha/challenge?surface=<id>` and
 *     receives a signed challenge (purpose-tagged HMAC token carrying the
 *     surface, a random nonce and the difficulty — all inside the signature,
 *     so none of it can be tuned down by the client).
 *  2. The served `/captcha.js` widget finds a counter `n` such that
 *     SHA-256(`${challenge}.${n}`) starts with `bits` zero bits, and puts
 *     `challenge::n` in a hidden `pow_token` field.
 *  3. The protected endpoint calls `captchaCheck()`: signature, expiry,
 *     surface match, difficulty met, and SINGLE USE — the challenge is
 *     consumed through the shared rate-limit store, so one solution cannot
 *     be replayed across a spam batch. (The store fails open on backend
 *     error; the per-IP throttles behind it still stand. For multi-replica
 *     deployments RATE_LIMIT_STORE=libsql makes consumption global.)
 *
 * Enforcement is PER SURFACE and off by default — an operator opts each
 * form in from Settings → Security. When a surface is off, `captchaCheck`
 * approves without looking, so the call sites cost nothing to keep in place.
 */
import crypto from 'node:crypto';
import { signPurposeToken, verifyPurposeToken } from './auth';
import { sharedRateLimitStore } from './rate-limit';
import { LocalDB } from './localdb';

/** The forms that can be protected. Order is the settings-screen order. */
// `forms` covers every public-write content type at once rather than one id
// per collection: the setting is a list of surfaces an operator ticks, and a
// list that grows a checkbox each time somebody builds a form is a settings
// screen nobody reads. An operator who wants the check on their enquiry form
// but not on their RSVP has the per-type switch in the builder for that.
//
// `checkout` and `magic-link` are the two public endpoints that spend something
// real per request — a stock reservation, an email to any address — and were
// the only such endpoints with no bot check at all. Off by default like every
// surface: a storefront has to fetch and solve the challenge before it can
// send the token (INTEGRATION.md), so switching them on is the operator's
// call, made once their storefront does.
export const CAPTCHA_SURFACES = ['contact', 'newsletter', 'login', 'forgot', 'forms', 'checkout', 'magic-link'] as const;
export type CaptchaSurface = (typeof CAPTCHA_SURFACES)[number];

export const CAPTCHA_SETTING_KEY = 'captcha_surfaces';

/** Challenge lifetime. Long enough to write a message, short enough to expire a hoard. */
const CHALLENGE_TTL_MS = 10 * 60 * 1000;

/**
 * Difficulty in leading zero bits. 15 ≈ 32k hashes on average — well under a
 * second in a browser, invisible next to typing a message; tune with
 * CAPTCHA_BITS, clamped so a typo can neither disable the check (too low)
 * nor lock humans out (too high).
 */
export function difficultyBits(): number {
  const raw = Number(process.env.CAPTCHA_BITS ?? 15);
  if (!Number.isFinite(raw)) return 15;
  return Math.min(22, Math.max(8, Math.floor(raw)));
}

/** PURE resolver: which surfaces are enabled, unknown ids dropped. */
export function resolveCaptchaSurfaces(
  settings: Record<string, unknown> | null | undefined,
): Set<CaptchaSurface> {
  const raw = (settings ?? {})[CAPTCHA_SETTING_KEY];
  if (!Array.isArray(raw)) return new Set();
  return new Set(
    raw.filter((v): v is CaptchaSurface =>
      typeof v === 'string' && (CAPTCHA_SURFACES as readonly string[]).includes(v)),
  );
}

async function enabledSurfaces(): Promise<Set<CaptchaSurface>> {
  try {
    const rows = await LocalDB.getSettings();
    const map: Record<string, unknown> = {};
    for (const r of rows) map[r.key] = r.value;
    return resolveCaptchaSurfaces(map);
  } catch {
    // Settings unreadable → treat as off. The captcha is an ADDITIVE guard;
    // failing closed here would take four public forms down with the DB.
    return new Set();
  }
}

export async function captchaEnabledFor(surface: CaptchaSurface): Promise<boolean> {
  return (await enabledSurfaces()).has(surface);
}

/** Mint a challenge. Everything the verifier needs lives inside the signature. */
export function makeChallenge(surface: CaptchaSurface): { token: string; bits: number } {
  const bits = difficultyBits();
  const token = signPurposeToken('pow', {
    s: surface,
    r: crypto.randomBytes(16).toString('base64url'),
    d: bits,
  }, CHALLENGE_TTL_MS);
  return { token, bits };
}

/** Does this digest start with `bits` zero bits? */
function meetsDifficulty(digest: Buffer, bits: number): boolean {
  let remaining = bits;
  for (let i = 0; i < digest.length && remaining > 0; i++) {
    const take = Math.min(8, remaining);
    if (digest[i] >>> (8 - take) !== 0) return false;
    remaining -= take;
  }
  return remaining <= 0;
}

export type CaptchaVerdict =
  | { ok: true }
  | { ok: false; reason: 'missing' | 'invalid' | 'wrong-surface' | 'not-solved' | 'replayed' };

/**
 * Verify a `challenge::nonce` proof for a surface. Called only when the
 * surface is enabled; every failure is named so the caller can log without
 * guessing (the visitor still just sees "please try again").
 */
export async function verifyPow(provided: unknown, surface: CaptchaSurface): Promise<CaptchaVerdict> {
  if (typeof provided !== 'string' || provided.length === 0) return { ok: false, reason: 'missing' };
  if (provided.length > 5000) return { ok: false, reason: 'invalid' };
  const sep = provided.lastIndexOf('::');
  if (sep < 0) return { ok: false, reason: 'invalid' };
  const challenge = provided.slice(0, sep);
  const nonce = provided.slice(sep + 2);
  if (!nonce || nonce.length > 32) return { ok: false, reason: 'invalid' };

  const payload = verifyPurposeToken('pow', challenge);
  if (!payload) return { ok: false, reason: 'invalid' };
  if (payload.s !== surface) return { ok: false, reason: 'wrong-surface' };

  const bits = typeof payload.d === 'number' ? payload.d : NaN;
  // The difficulty came out of the signed body, but clamp anyway: defense in
  // depth against a future signer bug ever minting a d:0 challenge.
  if (!Number.isFinite(bits) || bits < 8) return { ok: false, reason: 'invalid' };

  const digest = crypto.createHash('sha256').update(`${challenge}.${nonce}`).digest();
  if (!meetsDifficulty(digest, bits)) return { ok: false, reason: 'not-solved' };

  // Single use. Key on the challenge hash, marker lifetime matching the
  // challenge's own TTL: the first claim wins and every replay is refused.
  // consumeOnce (not consume) so the marker outlives the challenge regardless
  // of rate-limit window boundaries — the challenge TTL equals the window
  // length, so a floored-window marker would let every challenge be spent
  // twice, once on each side of a boundary.
  const used = crypto.createHash('sha256').update(challenge).digest('hex').slice(0, 32);
  const claimed = await sharedRateLimitStore().consumeOnce(`captcha-used:${used}`, CHALLENGE_TTL_MS);
  if (!claimed) return { ok: false, reason: 'replayed' };

  return { ok: true };
}

/**
 * The one call a protected endpoint makes. Surface off → approve without
 * looking. Surface on → the proof must verify.
 */
export async function captchaCheck(provided: unknown, surface: CaptchaSurface): Promise<CaptchaVerdict> {
  if (!(await captchaEnabledFor(surface))) return { ok: true };
  return verifyPow(provided, surface);
}
