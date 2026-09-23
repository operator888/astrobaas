/**
 * The cookie declaration table (C-103).
 *
 * ## Why this is not a "scanner"
 *
 * Every consent product advertises a cookie *scanner*: it loads your site in a
 * headless browser, watches what gets set, and writes a table. That approach is
 * wrong here for a reason worth stating, because it is the reason this file is
 * short.
 *
 * A scan sees what happened on ONE page load, with ONE consent state, from ONE
 * country, on the day it ran. It cannot see the marketing tag that only fires on
 * checkout, and it silently keeps declaring a vendor the operator removed last
 * month. So the table drifts away from the site, and a *stale* legal declaration
 * is worse than none — it is a specific, dated claim about what you do with
 * people's data, and it is wrong.
 *
 * This install already knows the answer without looking. The first-party cookies
 * are set by code in this repo, so they are enumerated here beside the constants
 * that define their lifetimes. The third-party ones come from
 * `ANALYTICS_PROVIDERS`, and a provider is only in the table when the operator
 * has actually configured its tracking ID. Turn a provider off and its rows
 * leave the declaration on the next request, with nobody remembering to re-run
 * anything.
 *
 * ## Honest about what we cannot know
 *
 * A vendor can change its own cookies without telling anyone, and several set
 * more than they document. So each provider declares the cookies we can state
 * with confidence and, where the full set is the vendor's to define, carries
 * `vendorControlled: true`. The rendered table says so in words and links the
 * vendor's own cookie documentation.
 *
 * Claiming a complete list we cannot verify would be the same failure as the
 * scanner, one step earlier.
 */
import type { ConsentCategory } from './consent';
import { CONSENT_COOKIE, CONSENT_MAX_AGE_DAYS } from './consent';
import { SESSION_COOKIE, CSRF_COOKIE, PENDING_2FA_COOKIE, sessionTtlMs } from './auth';
import { configuredAnalytics } from './analytics';
import type { AnalyticsProvider } from './analytics';

/** One row of the declaration. */
export interface CookieDeclarationEntry {
  /** The cookie name, or a pattern like `_ga_*` when the suffix is per-property. */
  name: string;
  /** Who sets it — the site itself, or a named vendor. */
  provider: string;
  /** Which consent category must be granted before it may be set. */
  category: ConsentCategory;
  /** Plain-language purpose. Written for a reader, not for a lawyer. */
  purpose: string;
  /**
   * How long it lasts, as a phrase. Where the value is defined in code, it is
   * DERIVED from that constant rather than typed here — a declaration that says
   * 24 hours while the session is 48 is a false statement about data retention.
   */
  lifetime: string;
  /** True when it is set on this site's own domain. */
  firstParty: boolean;
  /** True when the vendor may set more than we list. Drives the caveat in the UI. */
  vendorControlled?: boolean;
  /** The vendor's own cookie documentation, when there is one. */
  helpUrl?: string;
  /**
   * When this cookie exists at all. Several are conditional, and a declaration
   * that implies every visitor gets a session cookie is wrong about the one
   * thing a reader actually wants to know.
   */
  setWhen?: string;
}

/** Render a millisecond duration the way a person would say it. */
function humanMs(ms: number): string {
  const min = Math.round(ms / 60000);
  if (min < 60) return min === 1 ? '1 minute' : `${min} minutes`;
  const hours = Math.round(ms / 3_600_000);
  if (hours < 48) return hours === 1 ? '1 hour' : `${hours} hours`;
  const days = Math.round(ms / 86_400_000);
  if (days < 60) return days === 1 ? '1 day' : `${days} days`;
  const months = Math.round(days / 30);
  if (months < 24) return months === 1 ? '1 month' : `${months} months`;
  const years = Math.round(days / 365);
  return years === 1 ? '1 year' : `${years} years`;
}

/**
 * The cookies THIS application sets.
 *
 * A function rather than a constant so the lifetimes are read from the auth and
 * consent modules at call time. If someone changes `SESSION_TTL_MS`, this table
 * changes with it and cannot quietly become a false retention claim.
 *
 * Deliberately NOT here: `astrobaas_errors_total` and friends are Prometheus
 * metric names, not cookies, and the doc-store table `astrobaas_doc` is a
 * database table. All three match a naive `astrobaas_*` grep, which is exactly
 * how a hand-written declaration acquires rows for things that are not cookies.
 */
export function firstPartyCookies(): CookieDeclarationEntry[] {
  return [
    {
      name: CSRF_COOKIE,
      provider: 'This site',
      category: 'necessary',
      purpose:
        'Carries the token that proves a form submission came from this site rather than another one. '
        + 'Without it, any page on the internet could act on your behalf while you are signed in.',
      lifetime: 'Until the browser is closed',
      firstParty: true,
      setWhen: 'On every page, before you sign in or submit anything.',
    },
    {
      name: SESSION_COOKIE,
      provider: 'This site',
      category: 'necessary',
      purpose: 'Keeps you signed in to the admin area. Contains a signed token, not your password.',
      lifetime: humanMs(sessionTtlMs),
      firstParty: true,
      setWhen: 'Only after a successful sign-in. Visitors who never sign in never receive it.',
    },
    {
      name: PENDING_2FA_COOKIE,
      provider: 'This site',
      category: 'necessary',
      purpose:
        'Remembers, for the length of one login, that your password was accepted and only the '
        + 'second factor is outstanding — so the password is not asked for twice.',
      lifetime: humanMs(5 * 60 * 1000),
      firstParty: true,
      setWhen: 'Only between the two steps of a two-factor sign-in.',
    },
    {
      name: CONSENT_COOKIE,
      provider: 'This site',
      category: 'necessary',
      purpose:
        'Records which cookie categories you allowed, so you are not asked again on every page. '
        + 'It is what makes every other choice on this page take effect.',
      lifetime: humanMs(CONSENT_MAX_AGE_DAYS * 86_400_000),
      firstParty: true,
      setWhen: 'When you answer the cookie banner — including when you decline everything optional.',
    },
    {
      name: 'astrobaas_theme',
      provider: 'This site',
      category: 'preferences',
      purpose: 'Remembers whether you chose the light or dark appearance.',
      lifetime: humanMs(365 * 86_400_000),
      firstParty: true,
      setWhen: 'Only if you use the light/dark switch. It is never set otherwise.',
    },
  ];
}

/** Cookie facts attached to an analytics provider. See `PROVIDER_COOKIES`. */
export interface ProviderCookieFacts {
  cookies: { name: string; purpose: string; lifetime: string; firstParty: boolean }[];
  /** True when the vendor may set cookies beyond the ones listed. */
  vendorControlled: boolean;
  /** The vendor's own cookie documentation. Falls back to the provider's helpUrl. */
  cookieDocsUrl?: string;
  /** Stated when a provider genuinely sets none — a fact worth showing, not an omission. */
  cookieless?: boolean;
  /**
   * A tag CONTAINER: it sets nothing itself, and everything it loads is
   * configured inside it where this CMS cannot see it.
   *
   * An explicit flag, not inferred from "we listed no cookies". The first
   * version inferred it, and an audit caught the consequence: the LinkedIn
   * Insight Tag, whose cookies are simply not enumerated here, was being
   * described to visitors as a container that sets nothing — which is a false
   * statement in a legal document, and the more misleading direction of false.
   */
  container?: boolean;
}

/**
 * What each supported provider sets, as far as can be stated with confidence.
 *
 * The three cookieless entries are not padding. "This analytics tool sets no
 * cookies at all" is the single most useful line a declaration can contain, and
 * an operator choosing between GA4 and Plausible should be able to read it here.
 */
export const PROVIDER_COOKIES: Record<string, ProviderCookieFacts> = {
  ga4: {
    vendorControlled: true,
    cookieDocsUrl: 'https://business.safety.google/adscookies/',
    cookies: [
      { name: '_ga', purpose: 'Distinguishes one browser from another so repeat visits are not counted as new people.', lifetime: '2 years', firstParty: true },
      { name: '_ga_*', purpose: 'Holds the session state for one specific Analytics property. The suffix is that property’s id.', lifetime: '2 years', firstParty: true },
    ],
  },
  gtm: {
    vendorControlled: true,
    container: true,
    cookieDocsUrl: 'https://business.safety.google/adscookies/',
    // Worth being precise about: the container itself is a loader. Everything it
    // sets is set by the tags configured inside it, which this CMS cannot see —
    // so a declaration generated from this install alone is INCOMPLETE for GTM,
    // and the operator has to add whatever they put in the container.
    cookies: [],
    cookieless: false,
  },
  'meta-pixel': {
    vendorControlled: true,
    cookieDocsUrl: 'https://www.facebook.com/policies/cookies/',
    cookies: [
      { name: '_fbp', purpose: 'Identifies a browser to Meta for advertising measurement and audience building.', lifetime: '3 months', firstParty: true },
    ],
  },
  linkedin: {
    // NOT a container: the Insight Tag does set cookies, they are simply not
    // enumerated here. `vendorControlled` says so; `container` must not.
    vendorControlled: true,
    cookieDocsUrl: 'https://www.linkedin.com/legal/l/cookie-table',
    cookies: [],
  },
  tiktok: {
    vendorControlled: true,
    cookieDocsUrl: 'https://www.tiktok.com/legal/page/global/cookie-policy/en',
    cookies: [
      { name: '_ttp', purpose: 'Identifies a browser to TikTok for advertising measurement.', lifetime: '13 months', firstParty: true },
    ],
  },
  pinterest: {
    vendorControlled: true,
    cookieDocsUrl: 'https://policy.pinterest.com/en/cookies',
    cookies: [
      { name: '_epik', purpose: 'Identifies a browser to Pinterest for conversion measurement.', lifetime: '1 year', firstParty: true },
    ],
  },
  clarity: {
    vendorControlled: true,
    cookieDocsUrl: 'https://learn.microsoft.com/en-us/clarity/setup-and-installation/cookie-list',
    cookies: [
      { name: '_clck', purpose: 'Keeps one Clarity identifier for this browser so several visits can be joined into one recording history.', lifetime: '1 year', firstParty: true },
      { name: '_clsk', purpose: 'Joins the page views of a single visit into one session recording.', lifetime: '1 day', firstParty: true },
    ],
  },
  hotjar: {
    vendorControlled: true,
    cookieDocsUrl: 'https://help.hotjar.com/hc/en-us/articles/6952777582999',
    cookies: [
      { name: '_hjSessionUser_*', purpose: 'Identifies this browser across visits so Hotjar does not treat a returning visitor as a new one.', lifetime: '1 year', firstParty: true },
      { name: '_hjSession_*', purpose: 'Holds the current visit’s session data.', lifetime: '30 minutes', firstParty: true },
    ],
  },
  plausible: { vendorControlled: false, cookies: [], cookieless: true },
  fathom: { vendorControlled: false, cookies: [], cookieless: true },
  umami: { vendorControlled: false, cookies: [], cookieless: true },
};

/** A provider that is configured on this install, with its cookie facts. */
export interface DeclaredProvider {
  provider: AnalyticsProvider;
  facts: ProviderCookieFacts;
  entries: CookieDeclarationEntry[];
}

export interface CookieDeclaration {
  /** Cookies this application sets itself. Always present. */
  firstParty: CookieDeclarationEntry[];
  /** One entry per CONFIGURED provider. Empty when the operator has enabled none. */
  providers: DeclaredProvider[];
  /** Every row, first-party then third-party, for a caller that just wants a table. */
  all: CookieDeclarationEntry[];
  /**
   * True when at least one configured provider may set cookies beyond what is
   * listed — the caveat the rendered table must show. Computed rather than left
   * to each caller, because three of them render this and two would get it right.
   */
  incomplete: boolean;
  /**
   * Providers configured here whose cookies are defined entirely by what the
   * operator put inside them. Currently only Tag Manager. Named separately
   * because the honest sentence is different: not "there may be more" but
   * "this CMS cannot see what you loaded through it".
   */
  opaqueContainers: string[];
}

/**
 * Build the declaration for THIS install.
 *
 * `settings` is the raw settings list, so the caller passes what it already has
 * rather than this module reaching for the database — the same rule the rest of
 * the codebase follows for anything a synchronous filter might need.
 *
 * A provider whose stored tracking ID does not validate is EXCLUDED, because it
 * is excluded from the page too: `configuredAnalytics` re-validates on read, so
 * a malformed id means no script, no cookie, and therefore nothing to declare.
 */
export function buildCookieDeclaration(
  settings: readonly { key: string; value: unknown }[],
): CookieDeclaration {
  const map: Record<string, unknown> = {};
  for (const s of settings) map[s.key] = s.value;
  const firstParty = firstPartyCookies();
  const providers: DeclaredProvider[] = [];

  // `configuredAnalytics`, NOT a second reading of the same settings keys. It is
  // the function that decides whether a script tag is emitted at all, so routing
  // the declaration through it makes "declared" and "actually loaded" the same
  // question rather than two implementations of it that agree until one changes.
  // The first version of this file re-derived the check and got it wrong twice:
  // `validateAnalyticsId` returns a RESULT OBJECT, which is always truthy, and
  // an empty string validates as ok — so every provider was declared on every
  // install.
  for (const { provider } of configuredAnalytics(map)) {
    const facts = PROVIDER_COOKIES[provider.id] ?? { cookies: [], vendorControlled: true };
    const entries: CookieDeclarationEntry[] = facts.cookies.map((c) => ({
      name: c.name,
      provider: provider.label,
      category: provider.category,
      purpose: c.purpose,
      lifetime: c.lifetime,
      firstParty: c.firstParty,
      vendorControlled: facts.vendorControlled,
      helpUrl: facts.cookieDocsUrl ?? provider.helpUrl,
      setWhen: `Only after you allow the “${provider.category}” category.`,
    }));
    providers.push({ provider, facts, entries });
  }

  return {
    firstParty,
    providers,
    all: [...firstParty, ...providers.flatMap((p) => p.entries)],
    incomplete: providers.some((p) => p.facts.vendorControlled && !p.facts.cookieless),
    // The explicit flag, never "we listed none". See ProviderCookieFacts.container.
    opaqueContainers: providers.filter((p) => p.facts.container).map((p) => p.provider.label),
  };
}
