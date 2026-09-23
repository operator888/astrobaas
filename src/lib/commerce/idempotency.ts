/**
 * `Idempotency-Key` for POST /api/orders.
 *
 * A client that times out waiting for a checkout does not know whether the
 * order was placed, and retrying used to place it twice — two orders, two
 * stock reservations, two confirmation emails. The typed client retries 5xx
 * and network failures on its own, so this was not only a hand-written-retry
 * problem.
 *
 * With the header:
 *  - the first request CLAIMS the key (Storage.claimIdempotencyKey — atomic,
 *    durable, and shared across processes on the relational driver) for a
 *    short lease while it runs;
 *  - a retry while it runs gets 409, reason `IDEMPOTENCY_IN_PROGRESS`;
 *  - a retry after it SUCCEEDED gets the same 201 body back, with
 *    `Idempotent-Replayed: true`, for 24 hours;
 *  - a retry after it was REFUSED (out of stock, bad coupon…) runs again: a
 *    refusal releases the key, so fixing the cause and retrying works;
 *  - the same key with a different body is a client bug: 422, reason
 *    `IDEMPOTENCY_KEY_REUSED`.
 *
 * Keys are scoped to the caller (the API key or staff user, or "public") and
 * to the route, and stored only as a hash. The body fingerprint ignores
 * `pow_token`: a proof-of-work token is single-use, so a genuine retry may
 * carry a fresh one.
 *
 * Why storage and not the rate-limit store's `consumeOnce`: that primitive is
 * single-use until its TTL runs out and cannot be released, so a refused
 * checkout would have burned its key for the whole window; on the default
 * in-memory store it is also per-process and forgotten on restart — exactly
 * when a client is most likely to be retrying.
 */
import crypto from 'node:crypto';

/** How long a running request holds its key. Past this a retry may run it again. */
export const IDEMPOTENCY_LEASE_MS = 120_000;
/** How long a finished request's answer is replayed. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000;

/** Printable ASCII, no spaces, 1–255 characters — what every client library generates. */
export function validIdempotencyKey(raw: string): boolean {
  return /^[\x21-\x7e]{1,255}$/.test(raw);
}

export function idempotencyStorageKey(route: string, principal: string, key: string): string {
  return crypto.createHash('sha256').update(`${route}\n${principal}\n${key}`).digest('hex');
}

/** JSON with object keys sorted, so `{a,b}` and `{b,a}` are one body. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = canonical((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

export function bodyFingerprint(body: unknown): string {
  const copy = body && typeof body === 'object' && !Array.isArray(body)
    ? { ...(body as Record<string, unknown>) }
    : body;
  if (copy && typeof copy === 'object' && !Array.isArray(copy)) delete (copy as Record<string, unknown>).pow_token;
  return crypto.createHash('sha256').update(JSON.stringify(canonical(copy ?? null))).digest('hex');
}
