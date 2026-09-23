/**
 * Will a paying buyer come back to a page that exists?
 *
 * Stripe, PayPal and Klarna send the buyer to `<site>/checkout/success?order=…`
 * (and `/checkout/cancelled`). `<site>` is resolved by payments/site-url.ts:
 * the Site URL SETTING, then SITE_URL, then the address the request arrived
 * on. This CMS serves no /checkout pages — on a headless shop the STOREFRONT
 * does — so when `<site>` is, or falls back to, the CMS's own address, every
 * buyer who has just paid lands on a 404.
 *
 * That is a deployment mistake, not a broken CMS, so the verdict is a WARNING
 * and never a failure: a health check that failed for it would page someone
 * at 3 a.m. about a setting, and a deploy script gating on it would refuse a
 * release that is otherwise fine.
 *
 * Warns, when an online provider is enabled, and:
 *  - the Site URL setting is empty (or unusable) — the return address is then
 *    SITE_URL, or the request's own Host, and nothing says it is the storefront;
 *  - or the address buyers are sent to is on the CMS's own ORIGIN: the
 *    `public_site_url` setting, or the origin this check was reached on.
 *
 * Pure: the route supplies the facts.
 */
import { normaliseOrigin } from '../site-url';

export interface ReturnUrlFacts {
  /** Ids of the ONLINE providers currently enabled (registry.enabledProviders). */
  onlineProviders: readonly string[];
  /** The `site_url` setting, raw. */
  siteUrlSetting?: unknown;
  /** Build-time `site` or the SITE_URL environment variable, raw. */
  siteUrlEnv?: unknown;
  /** The `public_site_url` setting — this CMS's own address — raw. */
  publicSiteUrl?: unknown;
  /** The origin the CMS was reached on for this check. */
  requestOrigin?: string;
}

export interface ReturnUrlVerdict {
  status: 'ok' | 'warn';
  detail: string;
  data: Record<string, unknown>;
}

const originOf = (value: unknown): string | null => {
  const normal = normaliseOrigin(value);
  if (!normal) return null;
  try {
    return new URL(normal).origin;
  } catch {
    return null;
  }
};

/** Same host and port, whatever the scheme: http and https on one host are one site. */
const sameHost = (a: string | null, b: string | null): boolean => {
  if (!a || !b) return false;
  try {
    return new URL(a).host === new URL(b).host;
  } catch {
    return false;
  }
};

const FIX = 'Set Settings → General → Site URL to your storefront\'s address (for example https://www.example.com) before taking payments.';

export function returnUrlVerdict(facts: ReturnUrlFacts): ReturnUrlVerdict {
  const providers = [...(facts.onlineProviders ?? [])];
  if (providers.length === 0) {
    return {
      status: 'ok',
      detail: 'no online payment provider is enabled, so no buyer is sent back from one',
      data: { providers },
    };
  }

  const setting = normaliseOrigin(facts.siteUrlSetting);
  const env = normaliseOrigin(facts.siteUrlEnv);
  const cmsOrigins = [originOf(facts.publicSiteUrl), originOf(facts.requestOrigin)].filter(Boolean) as string[];
  const onCms = (base: string | null) => cmsOrigins.some((cms) => sameHost(originOf(base), cms));
  const list = providers.join(', ');

  if (!setting) {
    if (!env) {
      return {
        status: 'warn',
        detail:
          `Site URL is not set, so ${list} will send buyers back to whatever address the payment request `
          + 'reached this CMS on — and the CMS serves no /checkout/success page. '
          + FIX,
        data: { providers, return_base: null, source: 'request origin' },
      };
    }
    if (onCms(env)) {
      return {
        status: 'warn',
        detail:
          `Site URL is not set and SITE_URL (${env}) is this CMS's own address, so ${list} will send paying `
          + 'buyers to a /checkout/success page the CMS does not have. ' + FIX,
        data: { providers, return_base: env, source: 'SITE_URL' },
      };
    }
    return {
      status: 'warn',
      detail:
        `Site URL is not set; ${list} return buyers to SITE_URL (${env}). If that is your storefront, `
        + 'set the Site URL setting to it too, so the choice is explicit and survives a redeploy with a different environment.',
      data: { providers, return_base: env, source: 'SITE_URL' },
    };
  }

  if (onCms(setting)) {
    return {
      status: 'warn',
      detail:
        `Site URL (${setting}) is the address of this CMS, so ${list} will send paying buyers to a `
        + '/checkout/success page the CMS does not have. ' + FIX,
      data: { providers, return_base: setting, source: 'site_url setting' },
    };
  }

  return {
    status: 'ok',
    detail: `${list} send buyers back to ${setting}/checkout/success`,
    data: { providers, return_base: setting, source: 'site_url setting' },
  };
}
