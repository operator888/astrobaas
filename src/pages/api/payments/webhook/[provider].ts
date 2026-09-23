import type { APIRoute } from 'astro';
import { LocalDB } from '../../../../lib/localdb';
import { getProvider, providerContext, enabledProviders } from '../../../../lib/payments/registry';
import { applyVerifiedEvent } from '../../../../lib/payments/service';
import { isWebhookVerificationError } from '../../../../lib/payments/types';
import { webhookThrottled, recordWebhookFailure } from '../../../../lib/payments/webhook-guard';
import { paymentSiteUrl } from '../../../../lib/payments/site-url';

/**
 * POST /api/payments/webhook/<provider> — inbound provider notifications.
 *
 * This is the most attacker-exposed endpoint in the application: it is public,
 * unauthenticated by design, and its whole job is to change the payment state
 * of orders. Everything below exists because of that.
 *
 * - The body is read with `request.text()` and passed through byte-for-byte.
 *   Stripe signs the exact bytes; re-serialising parsed JSON changes them and
 *   every signature fails.
 * - Verification is delegated to the provider and has NO bypass. There is no
 *   "skip in development" flag, because that is the flag that ends up set in
 *   production.
 * - A verification failure answers 401 with no detail. Telling a prober which
 *   part failed helps only them.
 * - An address that keeps failing verification is refused with 429 BEFORE
 *   anything is verified — PayPal and Klarna verification are outbound calls
 *   on the shop's credentials — and its failures are audited in aggregate,
 *   not one row each (lib/payments/webhook-guard.ts).
 * - Anything that verifies is answered **200 even when we take no action**.
 *   Providers retry non-2xx with backoff and eventually disable the endpoint;
 *   an event about another install's order is not our error to report.
 *
 * Responses are deliberately terse — the provider is a machine.
 */
export const prerender = false;

export const POST: APIRoute = async ({ request, params, url, locals, site }) => {
  const providerId = String(params.provider ?? '');
  const provider = getProvider(providerId);
  const env = process.env as Record<string, string | undefined>;

  // An unknown or disabled provider gets 404: without credentials configured we
  // cannot verify anything, so accepting the request would be theatre.
  if (!provider || !enabledProviders(env).some((p) => p.id === provider.id)) {
    return new Response('Unknown provider', { status: 404 });
  }

  const ip = locals.ip || 'unknown';
  const throttle = webhookThrottled(provider.id, ip);
  if (throttle.throttled) {
    return new Response('Too many failed verifications', {
      status: 429,
      headers: { 'Retry-After': String(throttle.retryAfterSeconds) },
    });
  }

  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return new Response('Unreadable body', { status: 400 });
  }

  try {
    await LocalDB.init();
    const ctx = providerContext({ env, siteUrl: await paymentSiteUrl({ astroSite: site, requestUrl: url }) });
    const event = await provider.verifyWebhook(rawBody, request.headers, ctx);
    // The provider and its context travel with the event: an APPROVED payment
    // (PayPal) is captured by the payment layer, through the same provider.
    const result = await applyVerifiedEvent(event, { provider, ctx });

    return new Response(
      JSON.stringify({ received: true, applied: result.applied, action: result.decision.action }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    if (isWebhookVerificationError(err)) {
      // Someone is sending us unverifiable payment events. Recorded — this is
      // the signal that distinguishes a misconfigured endpoint from an attack
      // — but aggregated per address, so a flood cannot bury the audit log.
      await recordWebhookFailure(provider.id, ip, err instanceof Error ? err.message : 'unverifiable')
        .catch(() => {});
      return new Response('Signature verification failed', { status: 401 });
    }
    console.error(`[payments] ${providerId} webhook error:`, err);
    // 500 so the provider retries — a transient failure on our side should not
    // silently drop a real payment confirmation.
    return new Response('Webhook processing failed', { status: 500 });
  }
};
