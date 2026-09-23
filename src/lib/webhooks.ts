/**
 * Outbound webhooks: deliver content lifecycle events to operator-registered
 * URLs, signed with HMAC-SHA256 so receivers can verify authenticity.
 *
 * Delivery is fire-and-forget — `fireEvent()` never throws and never blocks the
 * request that triggered it (this app runs as a long-lived Node server, so the
 * first attempt + any background retries complete after the response is sent).
 *
 * Durability: each delivery is recorded in a persisted log (so operators can see
 * failures and re-send), and a failed delivery is RETRIED with backoff
 * (WEBHOOK_RETRY_DELAYS_MS, default 30s/2m/10m). Retries run on in-process timers,
 * so they don't survive a restart — a delivery still marked `pending`/`failed`
 * can be re-sent from the admin (POST /api/webhooks/deliveries/{id}/redeliver).
 *
 * Signature: `X-AstroBaaS-Signature: sha256=<hex>` where hex =
 *   HMAC-SHA256(webhook.secret, rawRequestBody)
 * Receivers recompute the HMAC over the exact bytes received and constant-time
 * compare. The body embeds `event`, `timestamp`, and `data`.
 */
import { LocalDB } from './localdb';
import { isStagingEnv } from './indexing';
import { signWebhook } from './auth';
import { webhookMatches, webhookBody, WEBHOOK_EVENTS } from './webhook-util';
import type { Webhook, WebhookDelivery } from '../core/models';

const DELIVERY_TIMEOUT_MS = 5000;

// Re-export the pure helpers so consumers can import everything from one place.
export { webhookMatches, webhookBody, WEBHOOK_EVENTS };

/** Backoff delays (ms) between retries. Length = number of retries after the first try. */
function retryDelays(env: NodeJS.ProcessEnv = process.env): number[] {
  const raw = env.WEBHOOK_RETRY_DELAYS_MS;
  if (raw) return raw.split(/[\s,]+/).map(Number).filter((n) => Number.isFinite(n) && n >= 0);
  return [30_000, 120_000, 600_000];
}

interface AttemptResult {
  ok: boolean;
  status?: number;
  error?: string;
}

/** One POST attempt. Resolves with the outcome; never throws. */
async function attempt(url: string, event: string, body: string, timestamp: string, secret: string): Promise<AttemptResult> {
  const signature = signWebhook(secret, body);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'AstroBaaS-Webhook/1',
        'X-AstroBaaS-Event': event,
        'X-AstroBaaS-Timestamp': timestamp,
        'X-AstroBaaS-Signature': `sha256=${signature}`,
      },
      body,
      signal: controller.signal,
    });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Drive a single delivery to completion, updating its log row after each attempt
 * and scheduling backoff retries on failure. Resolves after the FIRST attempt;
 * retries continue on background timers.
 */
async function runWithRetries(deliveryId: string, wh: Webhook, event: string, body: string, timestamp: string): Promise<void> {
  const delays = retryDelays();
  const maxAttempts = 1 + delays.length;
  let attemptNo = 0;

  const tryOnce = async (): Promise<void> => {
    attemptNo += 1;
    const r = await attempt(wh.url, event, body, timestamp, wh.secret);
    if (r.ok) {
      await LocalDB.updateWebhookDelivery(deliveryId, { status: 'success', attempts: attemptNo, last_status: r.status }).catch(() => {});
      return;
    }
    const final = attemptNo >= maxAttempts;
    await LocalDB.updateWebhookDelivery(deliveryId, {
      status: final ? 'failed' : 'pending',
      attempts: attemptNo,
      last_status: r.status,
      last_error: r.error,
    }).catch(() => {});
    if (final) {
      console.error(`Webhook ${wh.url} (${event}) failed after ${attemptNo} attempts`);
      return;
    }
    const delay = delays[attemptNo - 1] ?? 0;
    setTimeout(() => {
      tryOnce().catch(() => {});
    }, delay);
  };

  await tryOnce();
}

/**
 * Deliver `event`+`data` to every active subscribed webhook. Fire-and-forget:
 * resolves once each target's FIRST attempt settles (retries run in background).
 * Callers should NOT await it before responding. No-op when nothing subscribes.
 */
export async function fireEvent(event: string, data: unknown, now: number = Date.now()): Promise<void> {
  // A staging clone arrives with production's webhook rows, because they are
  // DATA and the clone is a copy of the database. Refreshing staging would then
  // fire `order.created` at the real fulfilment partner from a test order —
  // which is a phone call, not a bug report. The environment says whether this
  // deployment may talk to anyone.
  if (isStagingEnv()) return;
  let hooks: Webhook[];
  try {
    hooks = await LocalDB.getWebhooks();
  } catch {
    return; // storage not ready / unavailable — never surface to the caller
  }
  // Defence in depth: a plugin-owned subscription must never fire while its
  // plugin is inactive. The lifecycle is now fixed at the source (toggle syncs
  // subscriptions), but a delivery path that exfiltrates site content to a
  // third-party URL should not depend on every future caller getting the
  // lifecycle right — a stale row from an older install must stay inert.
  //
  // Deny-by-default when the plugin table cannot be read: firing a plugin hook
  // we cannot attribute is the failure that leaks data, and staying silent is
  // the recoverable one.
  let blockedSources: Set<string> | null = null;
  if (hooks.some((wh) => wh.source?.startsWith('plugin:'))) {
    try {
      const plugins = await LocalDB.getPlugins();
      blockedSources = new Set(
        plugins.filter((p: any) => !p.active).map((p: any) => `plugin:${p.id}`),
      );
      // A subscription whose plugin no longer exists at all is also blocked.
      const known = new Set(plugins.map((p: any) => `plugin:${p.id}`));
      for (const wh of hooks) {
        if (wh.source?.startsWith('plugin:') && !known.has(wh.source)) blockedSources.add(wh.source);
      }
    } catch {
      blockedSources = null; // signals "could not tell" — handled below
    }
  }

  const targets = hooks.filter((wh) => {
    if (!webhookMatches(wh, event)) return false;
    if (!wh.source?.startsWith('plugin:')) return true;
    if (blockedSources === null) return false; // could not verify -> do not fire
    return !blockedSources.has(wh.source);
  });
  if (targets.length === 0) return;
  const timestamp = String(now);
  const body = webhookBody(event, data, timestamp);

  await Promise.all(
    targets.map(async (wh) => {
      const delivery = await LocalDB.createWebhookDelivery({
        webhook_id: wh.id,
        url: wh.url,
        event,
        payload: body,
        status: 'pending',
        attempts: 0,
      }).catch(() => null);
      if (!delivery) {
        // Log unavailable — still attempt a one-shot delivery so events aren't lost.
        await attempt(wh.url, event, body, timestamp, wh.secret);
        return;
      }
      await runWithRetries(delivery.id, wh, event, body, timestamp);
    }),
  );
}

/**
 * Re-send a recorded delivery (the exact stored, signed payload) to its webhook,
 * as a NEW delivery-log entry. Returns the new delivery, or null if the original
 * delivery or its webhook no longer exists.
 */
export async function redeliver(deliveryId: string): Promise<WebhookDelivery | null> {
  // The SAME gate fireEvent has. A staging clone arrives with production's
  // webhook rows AND its delivery history, so the admin's Redeliver button
  // would POST a real signed production event at the real partner from a test
  // copy. Putting the gate only in fireEvent covered the automatic path and
  // left the manual one — the exact "fixed one of several" shape.
  if (isStagingEnv()) return null;

  const original = await LocalDB.getWebhookDelivery(deliveryId);
  if (!original) return null;
  const hooks = await LocalDB.getWebhooks();
  const wh = hooks.find((h) => h.id === original.webhook_id);
  if (!wh) return null;

  const fresh = await LocalDB.createWebhookDelivery({
    webhook_id: wh.id,
    url: wh.url,
    event: original.event,
    payload: original.payload,
    status: 'pending',
    attempts: 0,
  });
  if (!fresh) return null;

  // Re-use the timestamp embedded in the stored body so the header matches the
  // signature (signature is HMAC over the exact payload).
  let timestamp = String(Date.now());
  try {
    const parsed = JSON.parse(original.payload);
    if (parsed?.timestamp) timestamp = String(parsed.timestamp);
  } catch {
    /* keep default */
  }
  await runWithRetries(fresh.id, wh, original.event, original.payload, timestamp);
  return (await LocalDB.getWebhookDelivery(fresh.id)) ?? fresh;
}
