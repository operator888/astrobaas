/**
 * Webhook events a PLUGIN declares and emits.
 *
 * A plugin declares the events it can send:
 *
 *   definePlugin({ id: 'campaign-games', webhookEvents: ['game.verified'], … })
 *
 * and sends one with `host.webhooks.emit('game.verified', data)`. Delivery is
 * the core's own — the same `X-AstroBaaS-Signature` HMAC, the same delivery
 * log, the same retry schedule and redeliver button, the same staging gate —
 * because it goes through `deliverWebhookEvent` in src/lib/webhooks.ts, which
 * is what `fireEvent` uses. A plugin never signs or POSTs anything itself.
 *
 * ## What a plugin cannot do, and why
 *
 * - **Emit an event it did not declare.** The declaration is what an operator
 *   sees on the webhook screen and subscribes to. An undeclared event is one
 *   nobody chose to receive, and `*` subscriptions would forward it anyway.
 * - **Declare or emit a core event name.** `order.created` from a plugin would
 *   be indistinguishable from the real one at the receiver — a fulfilment
 *   partner shipping goods for an order that does not exist. Every namespace
 *   core uses (`order.*`, `coupon.*`, …) is refused, by prefix, so a plugin
 *   cannot squat a name core adds tomorrow inside one of them either.
 * - **Emit another plugin's event.** Each event has exactly one owner; a
 *   second plugin declaring it is refused at boot, as duplicate routes are.
 *   `emit` is bound to the plugins a module produced (see buildPluginHost).
 * - **Emit while inactive.** The registry holds ACTIVE plugins only, rebuilt
 *   on every bootstrap, so a deactivated plugin's events stop being
 *   emittable — and stop being listed — at once.
 */
import { WEBHOOK_EVENTS } from '../webhook-util';

/** Lower-case dotted name, at least two parts: `game.verified`, `loyalty.tier_changed`. */
const EVENT_NAME_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const EVENT_NAME_MAX = 64;
/** How large one event's `data` may be once serialised. A webhook is a notification, not a transfer. */
export const PLUGIN_EVENT_DATA_MAX_BYTES = 64 * 1024;

/**
 * Namespaces core owns. Derived from WEBHOOK_EVENTS — so a core event added
 * there reserves its namespace with no second edit (`coupon.redeemed` and
 * `newsletter.subscribed` are in it) — plus namespaces core uses for records
 * and may use for events, which are not in that list (`consent.*`).
 */
export const CORE_EVENT_NAMESPACES: ReadonlySet<string> = new Set([
  ...WEBHOOK_EVENTS.map((e) => e.split('.')[0]),
  'coupon', 'coupons', 'newsletter', 'consent', 'order', 'orders', 'payment', 'payments', 'refund',
  'customer', 'subscriber', 'product', 'review', 'stock', 'inventory', 'shipment', 'checkout',
  'cart', 'user', 'auth', 'session', 'webhook', 'plugin', 'media', 'post', 'content', 'gdpr',
  'invoice', 'stats', 'settings', 'system',
]);

/** Why `event` cannot be a plugin event, or null when it can. */
export function pluginEventNameProblem(event: unknown): string | null {
  if (typeof event !== 'string' || !event) return 'an event name must be a non-empty string';
  if (event.length > EVENT_NAME_MAX) return `"${event.slice(0, 20)}…" is longer than ${EVENT_NAME_MAX} characters`;
  if (!EVENT_NAME_RE.test(event)) {
    return `"${event}" must be lower-case dotted words, like "game.verified" (no "*", spaces or capitals)`;
  }
  const ns = event.split('.')[0];
  if (CORE_EVENT_NAMESPACES.has(ns)) {
    return `"${event}" is in the "${ns}.*" namespace, which core owns — a receiver could not tell it from a core event`;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * The registry
 * ------------------------------------------------------------------ */

let owners: ReadonlyMap<string, string> = new Map();

/**
 * Replace the whole set from the ACTIVE plugins' declarations. Called once
 * per bootstrap. A bad name, or one another plugin already declared, is
 * refused loudly and skipped; the rest of that plugin's events still register.
 */
export function setPluginWebhookEvents(
  declared: readonly { pluginId: string; events: readonly unknown[] }[],
): void {
  const next = new Map<string, string>();
  for (const { pluginId, events } of declared) {
    for (const event of events) {
      const problem = pluginEventNameProblem(event);
      if (problem) {
        console.error(`[astrobaas] plugin "${pluginId}" declared webhook event ${problem}; ignoring it`);
        continue;
      }
      const name = event as string;
      const owner = next.get(name);
      if (owner && owner !== pluginId) {
        console.error(
          `[astrobaas] plugin "${pluginId}" declared webhook event "${name}", already declared by "${owner}". `
          + 'Ignoring it — one event, one sender.',
        );
        continue;
      }
      next.set(name, pluginId);
    }
  }
  owners = next;
}

/** Every declared plugin event and its plugin, sorted by name — for the admin and the docs. */
export function allPluginWebhookEvents(): { event: string; pluginId: string }[] {
  return [...owners.entries()]
    .map(([event, pluginId]) => ({ event, pluginId }))
    .sort((a, b) => a.event.localeCompare(b.event));
}

/** The ACTIVE plugin that declared `event`, or null. */
export function pluginWebhookEventOwner(event: string): string | null {
  return owners.get(event) ?? null;
}

/** Delivers a checked event. The real one is `deliverWebhookEvent`; tests pass their own. */
export type EventDeliverer = (event: string, data: unknown) => Promise<void>;

const coreDeliver: EventDeliverer = async (event, data) => {
  // Imported lazily: webhooks.ts pulls in storage, and this module is loaded
  // by the plugin host while plugins are still being imported.
  const { deliverWebhookEvent } = await import('../webhooks');
  await deliverWebhookEvent(event, data);
};

/**
 * Send `event` on behalf of one of `emitters` (plugin ids).
 *
 * REJECTS — loudly, at the call — when the event is a core name, is not
 * declared by an active plugin, is declared by a plugin outside `emitters`,
 * or `data` is not JSON or larger than PLUGIN_EVENT_DATA_MAX_BYTES. Those are
 * programming errors in the plugin, and a silent no-op is how an integration
 * waits forever for an event that is never sent.
 *
 * RESOLVES once the event is accepted, without waiting for any delivery:
 * delivery and its retries run in the background, exactly as core events do,
 * so a slow receiver can never slow down the plugin's request.
 */
export async function emitPluginWebhookEvent(
  emitters: ReadonlySet<string> | string,
  event: string,
  data: unknown,
  deliver: EventDeliverer = coreDeliver,
): Promise<void> {
  const allowed = typeof emitters === 'string' ? new Set([emitters]) : emitters;
  const problem = pluginEventNameProblem(event);
  if (problem) throw new Error(`webhooks.emit: ${problem}`);
  const owner = pluginWebhookEventOwner(event);
  if (!owner) {
    throw new Error(
      `webhooks.emit: "${event}" is not declared by any active plugin — add it to the plugin's webhookEvents`,
    );
  }
  if (!allowed.has(owner)) {
    throw new Error(`webhooks.emit: "${event}" belongs to plugin "${owner}", not to this one`);
  }
  let body: string | undefined;
  try {
    body = JSON.stringify(data ?? null);
  } catch (err) {
    throw new Error(`webhooks.emit: data for "${event}" is not JSON-serialisable (${err instanceof Error ? err.message : err})`);
  }
  if (body === undefined) throw new Error(`webhooks.emit: data for "${event}" is not JSON-serialisable`);
  if (Buffer.byteLength(body, 'utf8') > PLUGIN_EVENT_DATA_MAX_BYTES) {
    throw new Error(`webhooks.emit: data for "${event}" is larger than ${PLUGIN_EVENT_DATA_MAX_BYTES} bytes`);
  }
  // A copy, so the plugin mutating its object after emit cannot change what is sent.
  const frozen = JSON.parse(body);
  void deliver(event, frozen).catch((err) => {
    console.error(`[astrobaas] plugin "${owner}" webhook event "${event}" could not be delivered:`, err);
  });
}
