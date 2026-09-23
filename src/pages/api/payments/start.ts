import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { getProvider, enabledProviders } from '../../../lib/payments/registry';
import { startPayment } from '../../../lib/payments/service';
import { findOrderForEmail } from '../../../lib/commerce/order-lookup';
import { paymentSiteUrl } from '../../../lib/payments/site-url';

/**
 * POST /api/payments/start — open a hosted-checkout session for an order.
 *
 * Public (anonymous buyers), CSRF-protected and rate-limited like every write.
 *
 * The caller identifies the order by its NUMBER, not its internal id, and must
 * also present the email the order was placed with. That pairing is the
 * authorisation: order numbers are sequential, so number alone would let anyone
 * walk the sequence and open payment links for other people's orders — which
 * leaks the basket contents and totals through the provider's checkout page.
 *
 * The amount charged is never taken from this request. It comes from the stored
 * order, which was priced server-side at checkout.
 */
export const POST: APIRoute = async ({ request, url, site }) => {
  try {
    await LocalDB.init();
    const body = await request.json().catch(() => null);
    const number = typeof (body as any)?.order_number === 'string' ? (body as any).order_number.trim() : '';
    const email = typeof (body as any)?.email === 'string' ? (body as any).email.trim() : '';
    const providerId = typeof (body as any)?.provider === 'string' ? (body as any).provider.trim() : '';

    if (!number || !email || !providerId) {
      return ApiResponseBuilder.badRequest('order_number, email and provider are required');
    }

    const provider = getProvider(providerId);
    const env = process.env as Record<string, string | undefined>;
    // Check enablement, not just existence: a provider whose credentials are
    // missing must not be reachable, or the buyer meets a 502 mid-checkout.
    if (!provider || !enabledProviders(env).some((p) => p.id === provider.id)) {
      return ApiResponseBuilder.badRequest('Unknown or disabled payment provider');
    }

    // findOrderForEmail, shared with the verified-buyer stamp on a review.
    // One generic answer whether the order is missing or the email is wrong —
    // otherwise this endpoint confirms which order numbers exist, and a script
    // walks the number space to learn how many orders a shop takes a day.
    //
    // A TARGETED lookup by number (it used to load every order to find one),
    // then the same shared rule on the one it found.
    const candidate = await LocalDB.getOrderByNumber(number);
    const order = candidate ? findOrderForEmail([candidate], number, email) : null;
    if (!order) return ApiResponseBuilder.notFound('Order');

    // Where the provider sends the buyer back to. From the CONFIGURED site
    // (the admin's Site URL, then SITE_URL), and only failing both from this
    // request — whose Host header the client chose. A forged Host used to
    // become the return address on a real Stripe or PayPal page.
    const siteUrl = await paymentSiteUrl({ astroSite: site, requestUrl: url });
    const result = await startPayment(order.id, provider, siteUrl, env);
    if (!result.ok) {
      return ApiResponseBuilder.error(result.status, result.message ?? 'Could not start payment', undefined, {
        code: result.code,
      });
    }

    return ApiResponseBuilder.success(
      { redirect_url: result.redirectUrl, provider: provider.id },
      'Payment session created',
    );
  } catch (err) {
    console.error('Payment start error:', err);
    return ApiResponseBuilder.serverError('Failed to start payment');
  }
};
