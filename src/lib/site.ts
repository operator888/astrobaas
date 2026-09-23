/**
 * Resolved site-wide settings for the public frontend. Reads the LocalDB
 * `settings` table once and maps it to a typed shape with sensible defaults so
 * layouts/components don't each hand-roll setting lookups (and so admin edits
 * to site_title / site_tagline / site_url actually surface on the site).
 */
import { LocalDB } from './localdb';
import { resolveSiteUrl } from './site-url';
import { localizedSettings } from './settings-i18n';

export interface SiteSettings {
  siteTitle: string;
  siteTagline: string;
  /** Who publishes here — the byline fallback and the footer credit. */
  siteAuthorName: string;
  /**
   * Profile URLs for the author — LinkedIn, GitHub, a company site.
   *
   * These become `sameAs` on the Person node, which is the whole reason the
   * node is worth emitting: a NAME resolves to nothing on its own, and it is
   * these links that let a search engine or an assistant connect a byline to a
   * real person with a history.
   */
  siteAuthorProfiles: string[];
  /** Free text, e.g. "Founder". Becomes Person.jobTitle. */
  siteAuthorTitle: string;
  /** https URL for that name. Empty means the name renders unlinked. */
  siteAuthorUrl: string;
  /** Absolute base URL (no trailing slash), e.g. https://cms.example.com. '' if unset. */
  siteUrl: string;
  social: {
    twitter?: string;
    github?: string;
    linkedin?: string;
    facebook?: string;
    instagram?: string;
    youtube?: string;
  };
}

const DEFAULTS: SiteSettings = {
  siteTitle: 'AstroBaaS',
  siteTagline: 'A modern CMS built with Astro',
  siteAuthorName: '',
  siteAuthorProfiles: [],
  siteAuthorTitle: '',
  siteAuthorUrl: '',
  siteUrl: '',
  social: {},
};

/**
 * The fallback sources only a request can supply.
 *
 * Optional so a caller with no request context still works — it just gets the
 * setting-only answer, which is what every caller got before this existed.
 */
export interface SiteUrlContext {
  /** Astro's build-time `site` (from SITE_URL). */
  astroSite?: unknown;
  /** The current request URL, as a last-resort origin. */
  requestUrl?: unknown;
}

export async function getSiteSettings(
  ctx: SiteUrlContext & {
    /**
     * The READER's locale (C-136). Omitted, the result is byte-identical to
     * what this returned before per-locale settings existed.
     */
    locale?: string;
  } = {},
): Promise<SiteSettings> {
  try {
    await LocalDB.init();
    const rows = await LocalDB.getSettings();
    const raw: Record<string, any> = {};
    for (const s of rows) raw[s.key] = s.value;
    // Per-locale operator strings (C-136). With no locale on the context this
    // is byte-identical to reading the flat map, so every existing caller is
    // unchanged — and a caller that DOES pass one gets the site's own name in
    // the language the reader is on, in the <title>, the feed and the OG tags.
    const map: Record<string, any> = localizedSettings(raw, (ctx as { locale?: string }).locale);
    const str = (v: any): string => (typeof v === 'string' ? v.trim() : '');
    return {
      siteTitle: str(map.site_title) || DEFAULTS.siteTitle,
      siteTagline: str(map.site_tagline) || DEFAULTS.siteTagline,
      // Deliberately no default: an unset author means "fall back to the site
      // title", not somebody else's name on an open-source install.
      siteAuthorName: str(map.site_author_name),
      // One URL per line is what an operator actually types into a textarea;
      // splitting on commas too would break a URL that legitimately has one.
      siteAuthorProfiles: String(map.site_author_profiles ?? '')
        .split('\n')
        .map((u) => u.trim())
        .filter((u) => /^https?:\/\//i.test(u))
        .slice(0, 25),
      siteAuthorTitle: str(map.site_author_title),
      siteAuthorUrl: str(map.site_author_url),
      // Through the same resolver the sitemap, feed and JSON-LD use, so a
      // canonical tag can never disagree with a sitemap entry about where this
      // site lives. It also validates: this value lands in
      // `<link rel="canonical">` and `og:url`, and a raw trim would happily
      // pass `javascript:...` straight into them.
      // All THREE sources, matching every other call site. Passing only the
      // setting made the comment above false: with `site_url` unset but
      // SITE_URL set at build — the normal production shape — the canonical tag
      // fell through to the request origin while the sitemap, feed and JSON-LD
      // used SITE_URL. One resolver called with two different argument sets is
      // not one resolver.
      siteUrl: resolveSiteUrl({
        setting: map.site_url,
        astroSite: ctx.astroSite,
        requestUrl: ctx.requestUrl,
      }) ?? '',
      social: {
        twitter: str(map.social_twitter) || undefined,
        github: str(map.social_github) || undefined,
        linkedin: str(map.social_linkedin) || undefined,
        facebook: str(map.social_facebook) || undefined,
        instagram: str(map.social_instagram) || undefined,
        youtube: str(map.social_youtube) || undefined,
      },
    };
  } catch {
    // DB may be mid-seed on first boot; fall back to defaults.
    return { ...DEFAULTS };
  }
}
