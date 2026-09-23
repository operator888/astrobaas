/**
 * What the admin and the sign-in pages call themselves (C-159).
 *
 * ## Scope, and the licence
 *
 * The wordmark and a logo. Nothing else — and deliberately not the legal
 * notices: GPL-3.0 §7(b) lets the licence require "preservation of specified
 * reasonable legal notices or author attributions", and this project keeps
 * them. A white-label install may put its own name on the admin; it may not
 * strip the plugin author's name off a plugin or the theme author's off a
 * theme, and the settings help text says so rather than leaving an operator to
 * discover it in a licence file.
 *
 * ## Why this is not `getSiteSettings`
 *
 * `siteTitle` is the name of the SITE — it goes in `<title>`, the feed, the
 * Open Graph tags. This is the name of the PRODUCT as it appears to whoever
 * signs in to run it, and a shop called "Οπτική Γωνία" does not necessarily
 * want that word on its login screen. They are the same value on most installs
 * and different on the ones that care, which is exactly when a second setting
 * is worth having.
 */
import { settingStr } from './settings-map';

/** The name shown on the sidebar and the sign-in pages when nothing is set. */
export const DEFAULT_ADMIN_NAME = 'AstroBaaS';

export const BRANDING_KEYS = {
  /** A media path (`/uploads/…`) shown instead of the built-in mark. */
  logo: 'admin_logo',
  /** The wordmark beside it. Falls back to the site title, then to the product name. */
  name: 'admin_name',
} as const;

export interface Branding {
  /** Never empty. */
  name: string;
  /** A path, or `null` for the built-in mark. */
  logo: string | null;
}

/**
 * Resolve the branding from a settings map.
 *
 * Pure, so the rule is testable without a database — and there is a rule worth
 * testing: the fallback chain is `admin_name` → `site_title` → the product
 * name, so an install that has set neither is byte-identical to before this
 * existed, and one that set only a site title gets that rather than a second
 * field to fill in.
 */
export function resolveBranding(settings: Record<string, unknown> | null | undefined): Branding {
  const map = settings ?? {};
  const name = settingStr(map[BRANDING_KEYS.name])
    || settingStr(map.site_title)
    || DEFAULT_ADMIN_NAME;

  const raw = settingStr(map[BRANDING_KEYS.logo]);
  // Only a site-relative path. An absolute URL here would let a settings value
  // pull an image from a third party into every admin page load — a request
  // the operator did not make, on a screen behind their login.
  const logo = raw.startsWith('/') && !raw.startsWith('//') ? raw : null;

  return { name, logo };
}
