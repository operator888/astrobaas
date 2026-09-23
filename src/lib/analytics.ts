/**
 * Analytics connectors — ID-based, not script-paste.
 *
 * ## Why you paste an ID here and not a `<script>` snippet
 *
 * Every vendor hands out a copy-paste snippet, and every CMS has a "paste your
 * tracking code" box. This one deliberately does not, for three reasons:
 *
 * 1. **It would be stored XSS with extra steps.** A field whose contents become
 *    executable script on every public page is the single most valuable target
 *    in the admin. Anyone who reaches it once owns every visitor thereafter.
 * 2. **It would break the CSP.** The production build ships a hash-based
 *    Content-Security-Policy with no `'unsafe-inline'`. A pasted inline snippet
 *    has no build-time hash, so the browser silently drops it — the operator
 *    sees a "saved" toast, the tag never fires, and nothing anywhere says why.
 * 3. **The ID is what actually varies.** Snippets are boilerplate around one
 *    identifier. Asking for the identifier is *less* work for the operator and
 *    lets us emit a loader we can reason about.
 *
 * So: the operator pastes `G-XXXXXXX`, and AstroBaaS builds the loader. Each
 * connector declares the origins it talks to, which feeds the build-time CSP
 * (see csp-config.ts) so the policy stays exact instead of being widened to
 * "https:".
 *
 * ## Consent
 *
 * Every connector declares a consent category. Nothing loads before the visitor
 * has opted in to that category — that is the ePrivacy requirement (prior
 * consent for non-essential storage), and it is enforced in the served loader,
 * not merely documented here.
 *
 * ## Adding one
 *
 * Append to `ANALYTICS_PROVIDERS`. Give it a strict `idPattern` — the ID is
 * interpolated into a URL and a script, so a permissive pattern is an injection
 * hole. Prefer `^[A-Z0-9-]{n,m}$`-shaped patterns over `.*`.
 */

import type { ConsentCategory } from './consent';
import { isStagingEnv } from './indexing';

export interface AnalyticsProvider {
  id: string;
  label: string;
  /** Which consent category gates it. */
  category: ConsentCategory;
  /** What the operator pastes, e.g. "G-XXXXXXXXXX". */
  idLabel: string;
  idPlaceholder: string;
  /**
   * STRICT validation. The value ends up in a script URL and a JS string
   * literal, so anything not matching is refused rather than escaped.
   */
  idPattern: RegExp;
  /** Origins the connector loads script from → CSP script-src. */
  scriptOrigins: string[];
  /** Origins it beacons to → CSP connect-src. */
  connectOrigins?: string[];
  /** Origins it loads tracking pixels from → CSP img-src. */
  imgOrigins?: string[];
  /** Origins it embeds frames from → CSP frame-src. */
  frameOrigins?: string[];
  /** Docs link shown in the admin so the operator can find their ID. */
  helpUrl: string;
}

const GTM = 'https://www.googletagmanager.com';

/**
 * The catalogue. Order is the order shown in the admin.
 *
 * Patterns are anchored and character-classed on purpose — see the note above
 * about IDs reaching a URL and a script.
 */
export const ANALYTICS_PROVIDERS: readonly AnalyticsProvider[] = [
  {
    id: 'ga4',
    label: 'Google Analytics 4',
    category: 'analytics',
    idLabel: 'Measurement ID',
    idPlaceholder: 'G-XXXXXXXXXX',
    idPattern: /^G-[A-Z0-9]{4,20}$/,
    scriptOrigins: [GTM],
    connectOrigins: [GTM, 'https://www.google-analytics.com', 'https://analytics.google.com'],
    imgOrigins: ['https://www.google-analytics.com'],
    helpUrl: 'https://support.google.com/analytics/answer/12270356',
  },
  {
    id: 'gtm',
    label: 'Google Tag Manager',
    category: 'analytics',
    idLabel: 'Container ID',
    idPlaceholder: 'GTM-XXXXXXX',
    idPattern: /^GTM-[A-Z0-9]{4,20}$/,
    scriptOrigins: [GTM],
    connectOrigins: [GTM, 'https://www.google-analytics.com'],
    imgOrigins: ['https://www.google-analytics.com', 'https://www.googletagmanager.com'],
    frameOrigins: [GTM],
    helpUrl: 'https://support.google.com/tagmanager/answer/6103696',
  },
  {
    id: 'meta-pixel',
    label: 'Meta (Facebook) Pixel',
    category: 'marketing',
    idLabel: 'Pixel ID',
    idPlaceholder: '1234567890123456',
    idPattern: /^\d{8,20}$/,
    scriptOrigins: ['https://connect.facebook.net'],
    connectOrigins: ['https://www.facebook.com'],
    imgOrigins: ['https://www.facebook.com'],
    helpUrl: 'https://www.facebook.com/business/help/952192354843755',
  },
  {
    id: 'linkedin',
    label: 'LinkedIn Insight Tag',
    category: 'marketing',
    idLabel: 'Partner ID',
    idPlaceholder: '1234567',
    idPattern: /^\d{4,12}$/,
    scriptOrigins: ['https://snap.licdn.com'],
    connectOrigins: ['https://px.ads.linkedin.com'],
    imgOrigins: ['https://px.ads.linkedin.com'],
    helpUrl: 'https://www.linkedin.com/help/lms/answer/a418880',
  },
  {
    id: 'tiktok',
    label: 'TikTok Pixel',
    category: 'marketing',
    idLabel: 'Pixel ID',
    idPlaceholder: 'CXXXXXXXXXXXXXXXXXXX',
    idPattern: /^[A-Z0-9]{10,30}$/,
    scriptOrigins: ['https://analytics.tiktok.com'],
    connectOrigins: ['https://analytics.tiktok.com'],
    helpUrl: 'https://ads.tiktok.com/help/article/get-started-pixel',
  },
  {
    id: 'pinterest',
    label: 'Pinterest Tag',
    category: 'marketing',
    idLabel: 'Tag ID',
    idPlaceholder: '2612345678901',
    idPattern: /^\d{10,20}$/,
    scriptOrigins: ['https://s.pinimg.com'],
    connectOrigins: ['https://ct.pinterest.com'],
    imgOrigins: ['https://ct.pinterest.com'],
    helpUrl: 'https://help.pinterest.com/en/business/article/install-the-pinterest-tag',
  },
  {
    id: 'clarity',
    label: 'Microsoft Clarity',
    category: 'analytics',
    idLabel: 'Project ID',
    idPlaceholder: 'abcdefghij',
    idPattern: /^[a-z0-9]{8,15}$/,
    scriptOrigins: ['https://www.clarity.ms'],
    connectOrigins: ['https://www.clarity.ms', 'https://c.clarity.ms'],
    helpUrl: 'https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-setup',
  },
  {
    id: 'hotjar',
    label: 'Hotjar',
    category: 'analytics',
    idLabel: 'Site ID',
    idPlaceholder: '1234567',
    idPattern: /^\d{5,10}$/,
    scriptOrigins: ['https://static.hotjar.com', 'https://script.hotjar.com'],
    connectOrigins: ['https://in.hotjar.com', 'https://vc.hotjar.io', 'wss://ws.hotjar.com'],
    helpUrl: 'https://help.hotjar.com/hc/en-us/articles/115009336727',
  },
  {
    id: 'plausible',
    label: 'Plausible',
    category: 'analytics',
    idLabel: 'Domain',
    idPlaceholder: 'example.com',
    // A hostname, not an arbitrary string: it goes into a query parameter.
    idPattern: /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i,
    scriptOrigins: ['https://plausible.io'],
    connectOrigins: ['https://plausible.io'],
    helpUrl: 'https://plausible.io/docs/plausible-script',
  },
  {
    id: 'fathom',
    label: 'Fathom Analytics',
    category: 'analytics',
    idLabel: 'Site ID',
    idPlaceholder: 'ABCDEFGH',
    idPattern: /^[A-Z]{6,12}$/,
    scriptOrigins: ['https://cdn.usefathom.com'],
    connectOrigins: ['https://cdn.usefathom.com'],
    helpUrl: 'https://usefathom.com/docs/script/script',
  },
  {
    id: 'umami',
    label: 'Umami',
    category: 'analytics',
    idLabel: 'Website ID (UUID)',
    idPlaceholder: '00000000-0000-0000-0000-000000000000',
    idPattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    // Self-hosted: the operator also sets UMAMI_HOST at build time for the CSP.
    scriptOrigins: [],
    helpUrl: 'https://umami.is/docs/collect-data',
  },
] as const;

export function getAnalyticsProvider(id: string): AnalyticsProvider | undefined {
  return ANALYTICS_PROVIDERS.find((p) => p.id === id);
}

/** Settings key for a provider's ID. Namespaced so it cannot collide. */
export function analyticsSettingKey(providerId: string): string {
  return `analytics_${providerId}_id`;
}

/**
 * Validate a pasted ID.
 *
 * Returns a normalised value (trimmed, and upper-cased for the providers whose
 * IDs are canonically upper-case) or an error naming the expected shape, so the
 * admin can say what is wrong instead of silently storing something that will
 * never fire.
 */
export function validateAnalyticsId(
  providerId: string,
  raw: unknown,
): { ok: true; value: string } | { ok: false; error: string } {
  const provider = getAnalyticsProvider(providerId);
  if (!provider) return { ok: false, error: `Unknown analytics provider "${providerId}"` };
  if (typeof raw !== 'string') return { ok: false, error: 'ID must be text' };

  const trimmed = raw.trim();
  if (trimmed === '') return { ok: true, value: '' }; // empty = disabled

  // Case-normalise only where the vendor's IDs are genuinely case-insensitive
  // prefixed codes. Domains and UUIDs keep their case handling in the pattern.
  const normalised = /^(ga4|gtm|tiktok|fathom)$/.test(provider.id) ? trimmed.toUpperCase() : trimmed;

  if (!provider.idPattern.test(normalised)) {
    return { ok: false, error: `${provider.label} ${provider.idLabel} should look like "${provider.idPlaceholder}"` };
  }
  return { ok: true, value: normalised };
}

export interface ConfiguredAnalytics {
  provider: AnalyticsProvider;
  trackingId: string;
}

/**
 * Which connectors are configured, from a settings map.
 *
 * Re-validates on read. A value that was written before a pattern tightened —
 * or straight into the database — must not reach a script tag just because it
 * is in the table.
 */
export function configuredAnalytics(
  settings: Record<string, unknown> | null | undefined,
): ConfiguredAnalytics[] {
  // Same reason as the webhooks: the tracking ids are DATA, so a staging clone
  // arrives with production's GA4 property and starts polluting its numbers
  // with test traffic. Nobody notices for a month, and then a quarter of the
  // data is unusable.
  if (isStagingEnv()) return [];
  const map = settings ?? {};
  const out: ConfiguredAnalytics[] = [];
  for (const provider of ANALYTICS_PROVIDERS) {
    const raw = map[analyticsSettingKey(provider.id)];
    const checked = validateAnalyticsId(provider.id, typeof raw === 'string' ? raw : '');
    if (checked.ok && checked.value) out.push({ provider, trackingId: checked.value });
  }
  return out;
}

/** Every origin a set of providers needs, grouped by CSP directive. */
export function analyticsCspOrigins(providerIds: readonly string[]): {
  script: string[];
  connect: string[];
  img: string[];
  frame: string[];
} {
  const script = new Set<string>();
  const connect = new Set<string>();
  const img = new Set<string>();
  const frame = new Set<string>();
  for (const id of providerIds) {
    const p = getAnalyticsProvider(id);
    if (!p) continue;
    p.scriptOrigins.forEach((o) => script.add(o));
    (p.connectOrigins ?? []).forEach((o) => connect.add(o));
    (p.imgOrigins ?? []).forEach((o) => img.add(o));
    (p.frameOrigins ?? []).forEach((o) => frame.add(o));
  }
  return {
    script: [...script].sort(),
    connect: [...connect].sort(),
    img: [...img].sort(),
    frame: [...frame].sort(),
  };
}
