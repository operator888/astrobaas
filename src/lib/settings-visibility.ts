import { isStagingEnv } from './indexing';
/**
 * Which settings an ANONYMOUS caller may read.
 *
 * The settings table is a schemaless key/value bucket: `POST /api/settings/update`
 * accepts any identifier-shaped key, so whatever an operator, a plugin, or an
 * agent decides to store lands in it. `GET /api/settings/get` used to return the
 * whole table to the public, which meant the first person to keep an SMTP
 * password or a provider secret there published it — with no error, no warning,
 * and no obvious way to notice.
 *
 * So the read is deny-by-default. A key is public only if it is a core key the
 * public site genuinely needs, or if it is deliberately named `public_*`. The
 * naming convention matters: it puts the security decision at the point where
 * the key is written, where whoever writes it can see it, rather than in a list
 * they will never read. Staff sessions still get the full table.
 *
 * (This is WordPress's `show_in_rest` lesson: a settings store that is public by
 * default eventually leaks something, because the store outlives the assumption.)
 */

/** Prefixes that mark a setting as intentionally world-readable. */
export const PUBLIC_SETTING_PREFIX = 'public_';
/**
 * Analytics tracking IDs.
 *
 * These are public by nature — a GA measurement ID or a Meta pixel ID ships in
 * the page source of every site that uses one, so exposing them here adds no
 * disclosure. A decoupled storefront rendering its own tags legitimately needs
 * to read them. (Anything that is *not* an id — a provider API secret — belongs
 * in an environment variable, not in settings at all.)
 */
export const ANALYTICS_SETTING_PREFIX = 'analytics_';

/**
 * Keys that are NEVER public, whatever prefix rule might otherwise match.
 *
 * A deny-list on top of a deny-by-default allow-list looks redundant, and today
 * it is. It exists because the allow-list is a *prefix* rule: the moment
 * somebody adds `assistant_` to the public prefixes to expose a title, the API
 * key beside it would go public too. This makes that mistake impossible rather
 * than merely unlikely.
 */
export const NEVER_PUBLIC_SETTING_KEYS: ReadonlySet<string> = new Set([
  'assistant_api_key',
  'assistant_system_prompt',
  // Redacted, but still operator diagnostics: provider errors name accounts,
  // quotas and model ids that nobody outside the business needs.
  'assistant_last_error',
]);

/**
 * Core keys the public site and decoupled storefronts read. Everything here is
 * presentation or policy that is already visible in the rendered output.
 */
export const PUBLIC_SETTING_KEYS: ReadonlySet<string> = new Set([
  'site_title',
  'site_tagline',
  // The commerce master switch. A decoupled storefront needs one cheap answer
  // to "is there a shop to render?", and the fact is already public — every
  // commerce endpoint 404s when it is off.
  'commerce_enabled',
  'posts_per_page',
  'feed_items',
  'feed_format',
  'discourage_indexing',
  // Both are presentation facts already visible in the rendered output, and a
  // decoupled storefront rendering its own article page needs them to make the
  // same call this CMS makes. `content_rendered` already carries the heading
  // anchors, so without `toc_min_headings` a storefront has the ids and no way
  // to know whether the operator wanted a list built from them.
  // A decoupled storefront serves robots.txt from its OWN origin, so it needs
  // the rules the operator wrote here. The file is world-readable by
  // definition — publishing its source discloses nothing.
  // A decoupled storefront runs its own search box over /api/search, but a
  // storefront that ranks locally needs the same table or its results differ
  // from the CMS's for the same query.
  'search_synonyms',
  'robots_txt',
  'toc_min_headings',
  'related_posts_count',
  // Which Page serves as the site root. A decoupled storefront rendering its
  // own homepage needs to know which document that is, and the answer is
  // already visible to anyone who loads `/`.
  'home_page_slug',
  // Byline identity: already visible in the rendered byline of every post, so
  // a decoupled storefront rendering its own article page needs it too.
  'site_author_name',
  'site_author_url',
  // Order caps: a storefront must know them to render a valid quantity
  // selector, and they are already advertised in GET /api/products meta.
  // The CMS's own public address. It is `public_`-prefixed, so it would be
  // world-readable by the prefix rule anyway — listed here explicitly so that
  // is a decision rather than a side effect of the name. It discloses nothing:
  // it is the origin every media URL already contains, and any caller reading
  // this endpoint is already talking to that host.
  'public_site_url',
  'order_max_qty_per_product',
  'order_max_items_per_order',
  // NOTE: withdrawal/trader details are deliberately NOT here. They are public
  // information the Directive requires a trader to publish, but they get a
  // purpose-built endpoint (/api/legal/withdrawal) that returns them in a
  // structured shape with the generated notice. Widening the settings dump to
  // carry them would trade a specific contract for a general one.
]);

/** True if `key` may be disclosed without a session. */
export function isPublicSetting(key: string): boolean {
  if (NEVER_PUBLIC_SETTING_KEYS.has(key)) return false;
  return (
    PUBLIC_SETTING_KEYS.has(key) ||
    key.startsWith(PUBLIC_SETTING_PREFIX) ||
    (
    // Not on a staging clone. `configuredAnalytics` already refuses to RENDER a
    // tag there, but a decoupled storefront reads its provider ids from here
    // and loads them itself — so the gate had to be on both sides or staging
    // traffic still lands in production's property.
    !isStagingEnv() && key.startsWith(ANALYTICS_SETTING_PREFIX)
  )
  );
}

/**
 * Narrow a settings map to what an anonymous caller may see. PURE, so the rule
 * that gates a public endpoint is unit-testable without a database.
 *
 * @param settings the full key/value map
 * @param isStaff  whether the caller holds a staff session (admin or editor)
 */
/**
 * Keys whose NAME says they hold a credential.
 *
 * The explicit deny-set above only listed three assistant keys, because
 * `smtp_password` and `stripe_secret_key` were never in the public allow-list
 * and so never reached an anonymous caller. That protected the public and left
 * every staff session reading them — an `editor`, a role that cannot reach most
 * of the admin, could read the SMTP password and the Stripe secret key.
 *
 * Enumerating every credential a plugin might ever store is a list somebody has
 * to remember to update, and the failure mode is silent disclosure. Matching on
 * the shape of the name fails the other way: a new `foo_api_key` from a plugin
 * nobody reviewed is withheld by default, and the cost of a false positive is
 * an operator seeing `__is_set` instead of a value they did not need.
 *
 * `publishable` is carved out deliberately — a Stripe publishable key is meant
 * to be public, and withholding it would break a storefront.
 */
const SECRET_NAME_PATTERN = /(password|secret|token|credential|private_key|api_key|apikey|access_key)/i;
const NOT_SECRET_PATTERN = /(publishable|public_key|__is_set)/i;

/** Credentials and tokens: never returned to any caller, at any role. */
export function isNeverPublicSetting(key: string): boolean {
  if (NEVER_PUBLIC_SETTING_KEYS.has(key)) return true;
  if (NOT_SECRET_PATTERN.test(key)) return false;
  return SECRET_NAME_PATTERN.test(key);
}

export function visibleSettings<T>(
  settings: Record<string, T>,
  isStaff: boolean,
): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [key, value] of Object.entries(settings)) {
    // The deny-list applies to EVERYONE. `if (isStaff) return settings` meant an
    // editor — a role that cannot even reach most of the admin — could read
    // smtp_password, stripe_secret_key and every API token by calling a route
    // that is in the public allow-list. A secret that is never returned cannot
    // be leaked by the next routing mistake.
    //
    // The admin UI does not need the VALUES to manage them: it needs to know a
    // key is set. Settings that hold credentials are surfaced as a
    // `<key>__is_set` boolean instead.
    if (isNeverPublicSetting(key)) {
      if (isStaff) (out as Record<string, unknown>)[`${key}__is_set`] =
        value !== undefined && value !== null && value !== '';
      continue;
    }
    if (isStaff || isPublicSetting(key)) out[key] = value;
  }
  return out;
}
