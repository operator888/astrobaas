/**
 * Locale configuration.
 *
 * AstroBaaS delegates ROUTING to Astro's built-in i18n (`i18n.locales` in
 * astro.config.ts gives us `/de/...` URLs, locale detection, and
 * `Astro.currentLocale` for free). This module owns the CONTENT side: which
 * locales exist, which is the default, and how to normalize untrusted input.
 *
 * Configured with two env vars, read at build time (routing) and at runtime
 * (content filtering):
 *
 *   SITE_LOCALES=en,de,fr     # first entry is the default unless SITE_DEFAULT_LOCALE is set
 *   SITE_DEFAULT_LOCALE=en
 *
 * Unset means single-locale mode: everything is "en", no /xx/ prefixes are
 * generated, and the admin hides the locale UI. Existing installs therefore see
 * no behavioural change until they opt in.
 */

/** BCP-47-ish: "en", "de", "pt-BR". Deliberately narrow — these become URL segments. */
const LOCALE_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;

export const DEFAULT_LOCALE_FALLBACK = 'en';

export function parseLocaleList(raw: string | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(/[\s,]+/)) {
    const v = part.trim();
    if (v && LOCALE_RE.test(v) && !out.includes(v)) out.push(v);
  }
  return out;
}

/** Every configured locale. Always non-empty (falls back to ["en"]). */
export function locales(env: NodeJS.ProcessEnv = process.env): string[] {
  const list = parseLocaleList(env.SITE_LOCALES);
  return list.length ? list : [DEFAULT_LOCALE_FALLBACK];
}

/** The default locale: SITE_DEFAULT_LOCALE if valid and configured, else the first. */
export function defaultLocale(env: NodeJS.ProcessEnv = process.env): string {
  const all = locales(env);
  const explicit = (env.SITE_DEFAULT_LOCALE || '').trim();
  return explicit && all.includes(explicit) ? explicit : all[0];
}

/** True when more than one locale is configured (drives admin UI + routing). */
export function isMultilingual(env: NodeJS.ProcessEnv = process.env): boolean {
  return locales(env).length > 1;
}

/** True when `value` is a configured locale. */
export function isKnownLocale(value: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  return typeof value === 'string' && locales(env).includes(value);
}

/**
 * Coerce untrusted input (query string, request body) to a usable locale.
 * Returns the default for anything unknown, so a bad `?locale=` can never
 * produce an empty result set or leak that a locale is unconfigured.
 */
export function normalizeLocale(value: unknown, env: NodeJS.ProcessEnv = process.env): string {
  return isKnownLocale(value, env) ? (value as string) : defaultLocale(env);
}

/**
 * The locale a stored record belongs to. Records written before i18n existed
 * have no `locale`, so they are treated as the default — which keeps every
 * pre-existing post visible without a migration having to run first.
 */
export function recordLocale(rec: { locale?: string } | null | undefined, env: NodeJS.ProcessEnv = process.env): string {
  return isKnownLocale(rec?.locale, env) ? (rec!.locale as string) : defaultLocale(env);
}

/**
 * Filter records to one locale. Records with no locale count as the default, so
 * an install that never opts into i18n behaves exactly as before.
 */
export function filterByLocale<T extends { locale?: string }>(
  records: T[],
  locale: string,
  env: NodeJS.ProcessEnv = process.env,
): T[] {
  return records.filter((r) => recordLocale(r, env) === locale);
}

/**
 * Split a leading locale segment off a URL path.
 *
 * `/de/blog` → `{ locale: 'de', rest: '/blog', prefixed: true }`
 * `/blog`    → `{ locale: <default>, rest: '/blog', prefixed: false }`
 *
 * Why we do this ourselves rather than using Astro's built-in i18n routing:
 * Astro's `i18n.fallback` assumes a per-locale PAGE DIRECTORY layout
 * (`src/pages/de/about.astro`). AstroBaaS deliberately ships ONE set of
 * templates whose *content* varies by locale, so there is nothing to fall back
 * to and `/de/*` would 404. The middleware rewrites the prefix away instead, so
 * every existing route serves every locale with no duplicated page files.
 *
 * The default locale is never prefixed, so enabling i18n cannot break existing
 * URLs. An unknown first segment is left alone (it's a normal route or a 404).
 */
/**
 * The path a locale is actually served at.
 *
 * The default locale is NEVER prefixed — that is what makes enabling i18n
 * unable to break an existing URL — so a link built for it must not gain a
 * prefix either, or every one of them 404s.
 *
 * Shared by hreflang alternates and breadcrumb trails: they build links for
 * the same routes, and a trail whose LABELS are German while its HREFS point
 * at the English site is the exact bug two implementations produce.
 */
export function localePath(basePath: string, locale: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  const loc = normalizeLocale(locale, env);
  if (loc === defaultLocale(env)) return basePath;
  return `/${loc}${basePath === '/' ? '' : basePath}`;
}

export function splitLocaleFromPath(
  pathname: string,
  env: NodeJS.ProcessEnv = process.env,
): { locale: string; rest: string; prefixed: boolean } {
  const def = defaultLocale(env);
  if (!isMultilingual(env)) return { locale: def, rest: pathname, prefixed: false };

  const m = /^\/([^/]+)(\/.*)?$/.exec(pathname);
  const first = m?.[1];
  // Only a configured, NON-default locale is treated as a prefix: the default
  // locale is served un-prefixed, so /en/... is not a special route.
  if (first && first !== def && isKnownLocale(first, env)) {
    return { locale: first, rest: m![2] || '/', prefixed: true };
  }
  return { locale: def, rest: pathname, prefixed: false };
}
