/**
 * The site address a payment provider is given — where it sends the buyer back.
 *
 * The payment routes built it from the REQUEST: `${url.protocol}//${url.host}`.
 * The Host header is the client's to choose (and, behind a proxy that does not
 * pin it, anyone's), so a request with a forged Host produced a real Stripe or
 * PayPal page whose "back to shop" and success links pointed wherever the
 * caller liked — a phishing redirect with the shop's own payment page in the
 * middle of it.
 *
 * Now the same resolver the sitemap, feed and canonical tags use
 * (lib/site-url.ts), with the same precedence: the admin's Site URL setting,
 * then SITE_URL, and the request's own origin only when neither is set — so a
 * fresh install still works, and a configured one cannot be steered.
 */
import { LocalDB } from '../localdb';
import { resolveSiteUrl } from '../site-url';

export async function paymentSiteUrl(opts: { astroSite?: unknown; requestUrl: URL }): Promise<string> {
  let setting: unknown;
  try {
    setting = (await LocalDB.getSetting('site_url'))?.value;
  } catch {
    setting = undefined;
  }
  return resolveSiteUrl({
    setting,
    // Astro's build-time `site`, and failing that the runtime variable the
    // auth emails already read — a prebuilt image is configured at run time.
    astroSite: opts.astroSite ?? process.env.SITE_URL,
    requestUrl: opts.requestUrl,
  }) ?? `${opts.requestUrl.protocol}//${opts.requestUrl.host}`;
}
