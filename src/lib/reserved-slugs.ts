/**
 * Slugs a Page may not claim, because a built-in route already serves them.
 *
 * ## The bug this exists to prevent
 *
 * Pages are served by `src/pages/[...slug].astro`, a rest-parameter catch-all.
 * The original design comment asserted that a catch-all "sits BELOW every
 * explicit route … so `/about` keeps resolving to its own `.astro` file until
 * someone creates a Page with that slug."
 *
 * The first half is right; the second half is exactly backwards. Astro orders
 * routes statically, from the filesystem — a static segment always outranks a
 * rest parameter, and nothing in the database can change that. So a Page slugged
 * `about` is not a shadow, it is **unreachable**, permanently and silently:
 *
 *  - the API accepted it (201) and the admin listed it with an `/about` permalink,
 *  - visiting `/about` rendered the built-in marketing page instead,
 *  - the "View" link opened that same page, so it looked almost right,
 *  - and `/sitemap.xml` advertised `/about` with the PAGE's `lastmod`, telling
 *    crawlers content had changed when the served bytes had not.
 *
 * Nothing 404'd and nothing logged. `about` and `contact` are the two most
 * likely first uses of the entire Pages feature, so this would have been most
 * people's first experience of it.
 *
 * ## Why this is a plain list and not generated
 *
 * The obvious move is `import.meta.glob('/src/pages/*')`, which cannot drift.
 * But that is a Vite transform: the unit suite bundles modules with esbuild and
 * the published packages are built the same way, so a glob here would break both
 * for a list that changes a few times a year.
 *
 * Instead the list is written out and `tests/reserved-slugs.test.mjs` reads
 * `src/pages/` from disk and fails if the two disagree. The drift guard is real,
 * it just runs in CI rather than in the bundler — and it reports the difference,
 * which a glob would silently absorb.
 */

/**
 * First path segment of every built-in top-level route.
 *
 * Keep in sync with `src/pages/` — the test enforces it.
 * `index` is deliberately absent: that is `/`, which a slug cannot collide with,
 * because a Page reaches the root through the `home_page_slug` setting rather
 * than by being named `index`.
 */
const BUILT_IN_ROUTES = [
  '404', '500', 'about', 'admin', 'admin-i18n.js', 'api',
  'assistant-widget.js', 'assistant.js',
  'blog', 'captcha.js', 'consent.js', 'contact', 'cookies', 'forgot-password', 'forms', 'healthz', 'legal',
  'llms.txt', 'login', 'metrics', 'newsletter', 'og', 'openapi.json', 'plugin-admin.js',
  'plugins.css', 'popup.js',
  'readyz', 'receipt', 'receipt.pdf', 'reset-password', 'robots.txt', 'rss.xml', 'showcase',
  'sitemap.xml', 't', 'theme.css', 'uploads',
] as const;

/**
 * Not route files, but still unavailable.
 *
 * These are served by the Node adapter, the middleware, or Astro's own internal
 * prefixes, so a Page claiming one would collide just as silently.
 */
const NON_FILE_ROUTES = [
  '_astro', '_image', '_server-islands', '_actions',
  // Conventional, near-certain to become routes, and cheap to reserve now:
  // reclaiming one later means breaking somebody's published URL.
  'assets', 'static', 'public',
] as const;

const RESERVED: ReadonlySet<string> = new Set<string>([...BUILT_IN_ROUTES, ...NON_FILE_ROUTES]);

/** Route segments derived from files, for the drift test to compare against. */
export const builtInRouteSlugs = (): string[] => [...BUILT_IN_ROUTES].sort();

/** Every reserved slug, sorted — for error messages and tests. */
export const reservedSlugs = (): string[] => [...RESERVED].sort();

/**
 * Whether a built-in route would win over a Page with this slug.
 *
 * Case-insensitive. Slugs are validated as lowercase elsewhere, but a caller
 * that skipped that must not slip past this.
 */
export function isReservedSlug(slug: string): boolean {
  return RESERVED.has(String(slug ?? '').trim().toLowerCase());
}

/**
 * The message an author sees. Names the conflict and what to do about it,
 * because "invalid slug" for a slug that looks perfectly valid is worse than
 * no error at all.
 */
export function reservedSlugMessage(slug: string): string {
  return `"/${slug}" is already served by a built-in page, so a Page with that slug would never be reachable. Choose a different slug.`;
}
