/**
 * Throttling FORGED payment webhooks, before they cost anything.
 *
 * The webhook route is public by design. Two things made an unverifiable POST
 * expensive:
 *
 *  - every failure wrote an audit row, so a loop of junk posts filled the
 *    audit log (and buried the entries it exists to keep);
 *  - PayPal and Klarna verify by calling the provider — an OAuth token and a
 *    verification call for PayPal, an order fetch for Klarna — so every junk
 *    post was also an outbound request on the shop's own credentials.
 *
 * So verification FAILURES are counted per provider and client address, and
 * after FAILURE_LIMIT in a window the address is refused with 429 BEFORE the
 * provider is asked anything. Successful deliveries are never counted: a real
 * provider that verifies is never slowed by this. (A misconfigured secret
 * makes real deliveries fail too; they are throttled like any failure, and the
 * provider's own retry delivers them once the secret is fixed and the window
 * has passed.)
 *
 * Loopback, private and unknown addresses are NEVER throttled (their failures
 * are still aggregated in the audit log). Behind a proxy that is not trusted,
 * every provider arrives from the proxy's address, and throttling it would let
 * twenty forged posts shut the real provider out — see isRoutableClientIp.
 *
 * The count goes through the shared rate-limit store, so with
 * RATE_LIMIT_STORE=libsql every replica sees it; the "refused until" and the
 * audit aggregation are per process. At most TWO audit entries per address per
 * window: the first failure, and the moment the address is throttled — each
 * with counts — plus, at the first failure of a later window, how many were
 * left unrecorded in the last one.
 */
import { sharedRateLimitStore } from '../rate-limit';
import { recordAudit, AUDIT } from '../audit';
import { isRoutableClientIp } from '../commerce/payment-hold';

export const WEBHOOK_FAILURE_WINDOW_MS = 10 * 60_000;
/** Failures one address may cause per window before it is refused outright. */
export const WEBHOOK_FAILURE_LIMIT = 20;
/** Addresses tracked in memory; the oldest are forgotten past this. */
const MAX_TRACKED = 10_000;

interface Entry {
  windowStart: number;
  failures: number;
  /** Failures in this window that wrote no audit entry. */
  unrecorded: number;
  blockedUntil: number;
}

const entries = new Map<string, Entry>();

const keyFor = (provider: string, ip: string) => `${provider}|${ip}`;

function evict(now: number): void {
  if (entries.size <= MAX_TRACKED) return;
  for (const [k, e] of entries) {
    if (e.blockedUntil <= now && now - e.windowStart >= WEBHOOK_FAILURE_WINDOW_MS) entries.delete(k);
  }
  // Still too many: forget the oldest. Map iteration is insertion order.
  for (const k of entries.keys()) {
    if (entries.size <= MAX_TRACKED) break;
    entries.delete(k);
  }
}

/** Is this address refused right now? Asked before anything is verified. */
export function webhookThrottled(
  provider: string, ip: string, now: number = Date.now(),
): { throttled: false } | { throttled: true; retryAfterSeconds: number } {
  // A non-routable address is never throttled: recordWebhookFailure never
  // sets a block for one, so there is nothing to find here.
  const e = entries.get(keyFor(provider, ip));
  if (!e || e.blockedUntil <= now) return { throttled: false };
  return { throttled: true, retryAfterSeconds: Math.max(1, Math.ceil((e.blockedUntil - now) / 1000)) };
}

/** Count one verification failure, audit it if it is the one to audit, and throttle when due. */
export async function recordWebhookFailure(
  provider: string, ip: string, reason: string, now: number = Date.now(),
): Promise<void> {
  const k = keyFor(provider, ip);
  let e = entries.get(k);
  if (!e || now - e.windowStart >= WEBHOOK_FAILURE_WINDOW_MS) {
    // A new window. Its first failure is always recorded, carrying what the
    // last window left unrecorded.
    const carried = e?.unrecorded ?? 0;
    e = { windowStart: now, failures: 0, unrecorded: 0, blockedUntil: e?.blockedUntil ?? 0 };
    entries.set(k, e);
    evict(now);
    recordAudit(AUDIT.PAYMENT_WEBHOOK_INVALID, {
      actor: 'anonymous',
      target: provider,
      ip,
      metadata: {
        reason,
        ...(carried > 0 ? { unrecorded_failures_in_previous_window: carried } : {}),
      },
    });
  } else {
    e.unrecorded += 1;
  }
  e.failures += 1;
  if (!isRoutableClientIp(ip)) return;

  const counted = await sharedRateLimitStore().consume(
    `webhook-fail:${provider}:${ip}`, WEBHOOK_FAILURE_WINDOW_MS, WEBHOOK_FAILURE_LIMIT,
  );
  if (counted.remaining === 0 && e.blockedUntil <= now) {
    e.blockedUntil = Math.max(counted.resetAt, now + 60_000);
    recordAudit(AUDIT.PAYMENT_WEBHOOK_INVALID, {
      actor: 'anonymous',
      target: provider,
      ip,
      metadata: {
        reason: 'too many verification failures; this address is refused until the window ends',
        throttled: true,
        failures: e.failures,
        window_minutes: WEBHOOK_FAILURE_WINDOW_MS / 60_000,
      },
    });
    // The throttle entry says it all; the failures that led to it are not
    // "unrecorded" any more.
    e.unrecorded = 0;
  }
}

/** For tests: forget everything. */
export function resetWebhookGuard(): void {
  entries.clear();
}
