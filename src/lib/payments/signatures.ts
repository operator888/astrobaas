/**
 * Webhook verification primitives. Pure — `node:crypto` only, no network, no
 * clock of its own — so the security-critical logic is unit-testable offline.
 *
 * Two verification styles appear in this codebase, and the distinction matters:
 *
 * - **Signed payload** (Stripe): the provider HMACs the exact request body with
 *   a shared secret. Verify the MAC and the body is authentic. Cheap, no extra
 *   round trip, but it depends on getting the canonical string and a
 *   constant-time compare right — hence this module.
 *
 * - **Fetch-back** (PayPal, Klarna): treat the webhook as an untrusted *hint*
 *   that something happened, then ask the provider's API — with our own
 *   credentials — what the authoritative state is. Slower, but it cannot be
 *   forged by anyone who does not already hold our API credentials, and it does
 *   not depend on reconstructing a signing string correctly.
 *
 * Fetch-back is the safer default when a provider's signing scheme is anything
 * less than unambiguous. Never invent a signature scheme.
 */

import crypto from 'node:crypto';

/**
 * Constant-time string compare that does not leak length through early exit.
 *
 * `crypto.timingSafeEqual` throws on length mismatch, which would itself be an
 * oracle, so both sides are hashed to a fixed 32 bytes first. Comparing digests
 * is safe: finding two inputs with the same SHA-256 is the thing SHA-256 is for.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a, 'utf8').digest();
  const hb = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Lower-case hex HMAC-SHA256. */
export function hmacSha256Hex(secret: string, payload: string): string {
  return crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

/** Base64 HMAC-SHA256 (some providers encode the MAC this way). */
export function hmacSha256Base64(secret: string, payload: string): string {
  return crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('base64');
}

export interface StripeSignatureHeader {
  timestamp: number;
  /** Every v1 signature present. Stripe sends more than one during a secret roll. */
  signatures: string[];
}

/**
 * Parse a `Stripe-Signature` header: `t=<unix>,v1=<hex>[,v1=<hex>…]`.
 *
 * Returns null for anything malformed rather than throwing, so the caller can
 * answer with one generic failure and not distinguish "no header" from "bad
 * header" to an attacker probing the endpoint.
 */
export function parseStripeSignature(header: string | null): StripeSignatureHeader | null {
  if (!header) return null;
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't') {
      const n = Number(value);
      // Reject non-integers up front: a float or NaN timestamp would otherwise
      // sail through the tolerance check as a comparison against NaN.
      if (Number.isInteger(n) && n > 0) timestamp = n;
    } else if (key === 'v1' && /^[a-f0-9]{64}$/i.test(value)) {
      signatures.push(value.toLowerCase());
    }
  }
  if (timestamp === null || signatures.length === 0) return null;
  return { timestamp, signatures };
}

/** Default replay window. Stripe's own recommendation is five minutes. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

export interface StripeVerifyInput {
  rawBody: string;
  header: string | null;
  secret: string;
  /** Epoch ms. Injected so tests are deterministic. */
  nowMs: number;
  toleranceSeconds?: number;
}

/**
 * Verify a Stripe webhook signature.
 *
 * Signed payload is `${timestamp}.${rawBody}` — the RAW body, byte for byte.
 * Re-serialising parsed JSON produces a different string and fails, which is
 * why the route reads `request.text()` and never `request.json()`.
 *
 * The timestamp check is not decoration: without it, a signature stays valid
 * forever, and anyone who captures one request can replay it indefinitely.
 * Future-dated stamps are rejected on the same tolerance, so a skewed or
 * attacker-chosen clock cannot buy an extended window.
 */
export function verifyStripeSignature(input: StripeVerifyInput): boolean {
  const parsed = parseStripeSignature(input.header);
  if (!parsed) return false;
  if (!input.secret) return false;

  const tolerance = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const ageSeconds = Math.abs(input.nowMs / 1000 - parsed.timestamp);
  if (!Number.isFinite(ageSeconds) || ageSeconds > tolerance) return false;

  const expected = hmacSha256Hex(input.secret, `${parsed.timestamp}.${input.rawBody}`);
  // Compare against every v1 present so a secret rotation does not drop events.
  return parsed.signatures.some((sig) => timingSafeEqual(sig, expected));
}

/**
 * Do the amounts line up?
 *
 * A verified signature proves the provider sent the message. It does NOT prove
 * the message concerns the order we are about to mark paid, at the price we
 * expect. Confusing those two is how "paid 1 cent, received a laptop" happens,
 * so capture is gated on this as well.
 */
export function amountMatches(
  orderTotalCents: number,
  orderCurrency: string,
  paidCents: number | null,
  paidCurrency: string | null,
): boolean {
  if (paidCents === null || paidCurrency === null) return false;
  if (!Number.isInteger(paidCents)) return false;
  if (paidCents !== orderTotalCents) return false;
  return paidCurrency.toUpperCase() === orderCurrency.toUpperCase();
}
