/**
 * How long HEALTH_TOKEN has to be, said in one place.
 *
 * ## The disagreement this ends
 *
 * The deep health check accepted any token of 16 characters or more. README,
 * deploy/README.md and .env.example all told operators to use 32 or more. So
 * an operator who followed the docs was fine, and one who did not was never
 * told: a 16-character token worked, silently, and a 12-character one was
 * silently IGNORED — the check answered 404 as though no token were set, which
 * reads exactly like a typo in the deploy script.
 *
 * ## Why the floor stays at 16
 *
 * Raising it to 32 would make every deploy script holding a 16–31 character
 * token start failing on the next release, on live shops, for a credential
 * that only unlocks a read-only diagnostics page. That is a worse outcome than
 * the weakness it removes. So a short token keeps WORKING and the deep check
 * reports it as a warning — visible in `warnings`, which the post-deploy
 * checklist already asks operators to read — until someone rotates it.
 */

/** Below this the token is ignored entirely (unchanged behaviour). */
export const HEALTH_TOKEN_MIN_LENGTH = 16;
/** What the documentation asks for, and what stops the warning. */
export const HEALTH_TOKEN_RECOMMENDED_LENGTH = 32;

export type HealthTokenStrength = 'unset' | 'ignored' | 'short' | 'ok';

/** Classify a configured token. Whitespace-only counts as unset. */
export function healthTokenStrength(token: string | undefined): HealthTokenStrength {
  if (!token || token.trim() === '') return 'unset';
  if (token.length < HEALTH_TOKEN_MIN_LENGTH) return 'ignored';
  if (token.length < HEALTH_TOKEN_RECOMMENDED_LENGTH) return 'short';
  return 'ok';
}

/** Whether a configured token may be used at all. */
export function healthTokenUsable(token: string | undefined): token is string {
  const s = healthTokenStrength(token);
  return s === 'short' || s === 'ok';
}

/**
 * The operator-facing sentence for each state, for the deep check and the log.
 * Never includes the token or its characters — only its length.
 */
export function describeHealthToken(token: string | undefined): { level: 'ok' | 'warn'; detail: string } {
  const s = healthTokenStrength(token);
  const len = token?.length ?? 0;
  switch (s) {
    case 'unset':
      return { level: 'ok', detail: 'HEALTH_TOKEN is not set; only an admin session can read this check' };
    case 'ignored':
      return {
        level: 'warn',
        detail: `HEALTH_TOKEN is set but only ${len} characters, so it is IGNORED (minimum ${HEALTH_TOKEN_MIN_LENGTH}; use ${HEALTH_TOKEN_RECOMMENDED_LENGTH}+, e.g. openssl rand -hex 32)`,
      };
    case 'short':
      return {
        level: 'warn',
        detail: `HEALTH_TOKEN is ${len} characters; it works, but use ${HEALTH_TOKEN_RECOMMENDED_LENGTH}+ (e.g. openssl rand -hex 32)`,
      };
    default:
      return { level: 'ok', detail: `HEALTH_TOKEN is set (${HEALTH_TOKEN_RECOMMENDED_LENGTH}+ characters)` };
  }
}
