/**
 * Where this site actually lives, resolved from one place.
 *
 * The admin has a "Site URL" field. It was stored and read by nothing: the
 * sitemap, RSS feed and robots.txt all used Astro's build-time `site` (from
 * `SITE_URL` at build), so a self-hoster who filled the field in got no effect
 * at all — the same inert-field shape as the theme tokens and the SEO meta
 * fields.
 *
 * That distinction matters more than it looks. `SITE_URL` is baked in at BUILD
 * time; the setting is editable at RUN time. A self-hoster who moves domains,
 * or who deploys a prebuilt image, can change one of those and not the other.
 * The runtime value should win, because it is the one they can actually reach.
 *
 * Precedence, most specific first:
 *   1. the `site_url` setting (runtime, editable in the admin)
 *   2. Astro's `site` (build-time `SITE_URL`)
 *   3. the request's own origin, so a fresh install still emits usable URLs
 */

/**
 * Trim a trailing slash and reject anything that is not an http(s) origin.
 *
 * Exported because the MEDIA base (lib/media-url.ts) and the SETTINGS validator
 * must agree with this on what a usable site address is, to the character. Three
 * copies of "is this a URL?" is three chances to accept something here that is
 * rejected there — and the symptom of that disagreement is a stored setting the
 * admin says is fine and the API silently ignores.
 */
export function normaliseOrigin(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const u = new URL(trimmed);
    // A stored value ends up inside XML and JSON-LD. Anything that is not
    // http(s) has no business being an absolute site URL, and `javascript:`
    // in a canonical tag is a real hazard.
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    // Strip EVERY trailing slash, not one: SITE_URL="https://x.com//" leaves a
    // pathname of "//", and one survivor doubles the separator in every URL
    // this resolver feeds — canonical, BreadcrumbList items, sitemap, feed.
    return u.origin + u.pathname.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

export interface SiteUrlSources {
  /** The `site_url` value from the settings table, if any. */
  setting?: unknown;
  /** Astro's build-time `site`. */
  astroSite?: unknown;
  /** The current request URL, used as a last resort. */
  requestUrl?: unknown;
}

/**
 * Resolve the canonical origin, or `null` when nothing usable is configured.
 *
 * `null` is deliberate rather than a localhost default: emitting
 * `http://localhost:4321` into a live sitemap is worse than emitting nothing,
 * because a search engine will happily index it.
 */
export function resolveSiteUrl({ setting, astroSite, requestUrl }: SiteUrlSources): string | null {
  return (
    normaliseOrigin(setting)
    ?? normaliseOrigin(typeof astroSite === 'object' && astroSite !== null ? String(astroSite) : astroSite)
    ?? normaliseOrigin(requestUrl ? new URL(String(requestUrl)).origin : null)
  );
}

/** Absolute URL for a site-relative path, or the path itself when unresolvable. */
export function absoluteUrl(path: string, siteUrl: string | null): string {
  if (!siteUrl) return path;
  return `${siteUrl}${path.startsWith('/') ? path : `/${path}`}`;
}
