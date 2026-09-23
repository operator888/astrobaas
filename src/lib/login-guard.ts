/**
 * Credential throttles: the sign-in form and the two-factor step (S3.9, S3.10).
 *
 * Pure over a `RateLimitStore`, so every rule is tested against the real
 * memory store without a server. The middleware binds the caller's address
 * into `locals.loginRateCheck`; the login route calls the account-level
 * helpers directly with the shared store.
 *
 * ## The four counters, and what each one is for
 *
 *   login:<ip>|<email>   ATTEMPTS, 10 per 15 min. One address guessing one
 *                        password. Unchanged from before; a hard 429.
 *   login-ipfail:<ip>    FAILURES, 30 per 15 min. One address trying many
 *                        accounts — credential stuffing. A hard 429 for that
 *                        address only.
 *   login-fail:<email>   FAILURES, 5 per 15 min, from ANY address. Many
 *                        addresses guessing one account. NOT a lock — see below.
 *   2fa:<uid>            ATTEMPTS, 10 per 15 min, at the code step.
 *
 * ## Why the per-account counter never refuses
 *
 * Every hard per-account limit is a lock-out button: anyone who knows the
 * owner's email can press it from anywhere, forever, for free. So crossing it
 * does not refuse — it requires the login proof-of-work (lib/captcha.ts) for
 * that account from then until the window rolls over, even when the operator
 * has not switched the login captcha on. The admin sign-in page solves that
 * challenge in the background, so the owner signs in exactly as before; a
 * guessing run from a thousand addresses pays a hash search per guess, and
 * still meets each address's own hard limits.
 *
 * FAILURES rather than attempts for the two cross-cutting counters, so a busy
 * office signing in every morning behind one address, or an owner who signs in
 * often, never spends the budget an attacker is burning. They are checked with
 * `peek` before the password is hashed and charged only once it has failed.
 * The emails are counted whether or not an account exists — a counter that
 * only moved for real accounts would answer "is this address registered?".
 */
import type { RateLimitStore } from './rate-limit';

export const LOGIN_WINDOW_MS = 15 * 60_000;

/**
 * The stable error code for "this account needs proof-of-work" (S3.9). JSON
 * callers get it with a fresh challenge in `error.details.challenge`; the form
 * sign-in is redirected to `/login?error=pow`, which re-renders the page with
 * a challenge the widget solves before the next submit.
 */
export const POW_REQUIRED_CODE = 'POW_REQUIRED';

export interface LoginLimits {
  /** Attempts per address+email per window (the original throttle). */
  perIpEmail: number;
  /** Failed sign-ins per address per window, across all emails. */
  perIpFailures: number;
  /** Failed sign-ins per account per window, from anywhere, before proof-of-work is required. */
  accountProofAfter: number;
  /** Code attempts per account per window at the two-factor step. */
  secondFactorAttempts: number;
}

export const DEFAULT_LOGIN_LIMITS: Readonly<LoginLimits> = Object.freeze({
  perIpEmail: 10,
  perIpFailures: 30,
  accountProofAfter: 5,
  secondFactorAttempts: 10,
});

/**
 * The configured limits. `perIpEmail` is not configurable: it is the original
 * throttle and the one the smoke suite pins. The other three are, because an
 * office behind one NAT address and a shop with one owner want different
 * numbers.
 */
export function resolveLoginLimits(env: Record<string, string | undefined> = process.env): LoginLimits {
  const pick = (name: string, dflt: number) => {
    const n = Number(env[name]);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
  };
  return {
    perIpEmail: DEFAULT_LOGIN_LIMITS.perIpEmail,
    perIpFailures: pick('LOGIN_IP_FAILURE_LIMIT', DEFAULT_LOGIN_LIMITS.perIpFailures),
    accountProofAfter: pick('LOGIN_ACCOUNT_POW_AFTER', DEFAULT_LOGIN_LIMITS.accountProofAfter),
    secondFactorAttempts: pick('TWOFA_ATTEMPT_LIMIT', DEFAULT_LOGIN_LIMITS.secondFactorAttempts),
  };
}

/** One spelling of an account's email for every counter. */
export function loginEmailKey(email: string): string {
  return String(email ?? '').trim().toLowerCase();
}

export function loginKeys(ip: string, email: string) {
  const e = loginEmailKey(email);
  return {
    ipEmail: `login:${ip}|${e}`,
    ipFailures: `login-ipfail:${ip}`,
    account: `login-fail:${e}`,
  };
}

/**
 * May this address try this email now? Checks the cross-account failure budget
 * FIRST and without writing, so an address that is already refused cannot keep
 * minting new `login:<ip>|<email>` keys — rotating the email half was the
 * cheapest way to fill the store.
 */
export async function loginAttemptAllowed(
  store: RateLimitStore,
  ip: string,
  email: string,
  limits: LoginLimits = DEFAULT_LOGIN_LIMITS,
): Promise<boolean> {
  const k = loginKeys(ip, email);
  if ((await store.peek(k.ipFailures, LOGIN_WINDOW_MS)) >= limits.perIpFailures) return false;
  const r = await store.consume(k.ipEmail, LOGIN_WINDOW_MS, limits.perIpEmail);
  return r.allowed;
}

/** Has this account failed often enough, from anywhere, to require proof-of-work? */
export async function accountNeedsProof(
  store: RateLimitStore,
  email: string,
  limits: LoginLimits = DEFAULT_LOGIN_LIMITS,
): Promise<boolean> {
  const k = loginKeys('', email);
  return (await store.peek(k.account, LOGIN_WINDOW_MS)) >= limits.accountProofAfter;
}

/** Charge one failed sign-in to the account and to the address. */
export async function recordLoginFailure(
  store: RateLimitStore,
  ip: string,
  email: string,
  limits: LoginLimits = DEFAULT_LOGIN_LIMITS,
): Promise<void> {
  const k = loginKeys(ip, email);
  // The limit passed here only shapes the returned budget; nothing refuses on
  // it. Both counters are read back with `peek`.
  await store.consume(k.account, LOGIN_WINDOW_MS, limits.accountProofAfter);
  await store.consume(k.ipFailures, LOGIN_WINDOW_MS, limits.perIpFailures);
}

/**
 * May this account try another two-factor code now? (S3.10)
 *
 * The code step used to run before any throttle and count nothing, so a
 * pending-2FA cookie was an unlimited supply of guesses at a six-digit code.
 * Keyed on the ACCOUNT, not the pending token: a fresh token costs only the
 * password again, so a per-token budget would reset on every re-login.
 *
 * A hard limit is acceptable here in a way it is not for the password step:
 * reaching the code step at all proves the password, so the only person who
 * can spend this budget already holds it.
 */
export async function secondFactorAttemptAllowed(
  store: RateLimitStore,
  uid: string,
  limits: LoginLimits = DEFAULT_LOGIN_LIMITS,
): Promise<boolean> {
  const r = await store.consume(`2fa:${uid}`, LOGIN_WINDOW_MS, limits.secondFactorAttempts);
  return r.allowed;
}
