/**
 * API-key least-privilege scopes + expiry — pure helpers, no storage/network
 * imports, so they're unit-testable in isolation and reusable by the middleware.
 *
 * Scope model: coarse `resource:action` capabilities enforced centrally in the
 * middleware against the request path + method. A key with NO scopes is
 * unrestricted (governed only by its role) — so scopes are strictly opt-in,
 * additive, and backward compatible.
 *
 *   resources: see SCOPED_RESOURCES below (the one list)
 *   actions:   read | write | *        (plus the global "*" = everything)
 *   examples:  ["posts:read"]  ["content:*"]  ["posts:write","media:write"]  ["*"]
 */

/** Resources that are scope-gated. Other endpoints are governed by role only. */
export const SCOPED_RESOURCES = [
  'posts', 'content', 'media', 'products', 'orders', 'customers', 'messages',
] as const;

/**
 * Validate a single scope token (for the mint endpoint).
 *
 * BUILT from `SCOPED_RESOURCES`, as is the error text below (S3.12). The two
 * used to be separate literals: the regex grew products, orders, customers and
 * messages while the mint endpoint's error message still said
 * `<posts|content|media>`, so an operator who mistyped `order:read` was told
 * the only valid resources were three that had nothing to do with a shop.
 */
const SCOPE_RE = new RegExp(`^(\\*|(${SCOPED_RESOURCES.join('|')}):(read|write|\\*))$`);
export function isValidScope(s: unknown): s is string {
  return typeof s === 'string' && SCOPE_RE.test(s);
}

/** What the mint endpoint tells an operator when a scope is malformed. */
export const SCOPE_FORMAT_HINT =
  `each scope must be "*" or "<${SCOPED_RESOURCES.join('|')}>:<read|write|*>"`;

/** True once a key's `expires_at` (ISO) is in the past. No expiry → never expires. */
export function apiKeyExpired(key: { expires_at?: string }, now: number = Date.now()): boolean {
  if (!key.expires_at) return false;
  const t = Date.parse(key.expires_at);
  return Number.isFinite(t) && t < now;
}

/**
 * The scope a request requires, or null when the endpoint isn't scope-gated.
 * Writes (non-GET/HEAD/OPTIONS) need `:write`, reads need `:read`.
 */
export function requiredScopeFor(method: string, pathname: string): string | null {
  const action = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS' ? 'write' : 'read';
  // Commerce utility endpoints (bulk import, …) act on the catalogue, so they
  // are governed by the `products` scope.
  if (pathname.startsWith('/api/commerce/')) return `products:${action}`;
  // Shipping methods and coupons are catalogue configuration: they decide what
  // a product costs to receive, so they ride the `products` scope rather than
  // needing two more nouns a storefront would have to learn.
  if (pathname.startsWith('/api/shipping-methods')) return `products:${action}`;
  if (pathname.startsWith('/api/coupons')) return `products:${action}`;
  // The contact form. A headless storefront should be able to POST it with a
  // scoped key instead of performing the CSRF-cookie handshake.
  if (pathname === '/api/contact' || pathname.startsWith('/api/contact/')) return `messages:${action}`;
  for (const res of SCOPED_RESOURCES) {
    if (pathname === `/api/${res}` || pathname.startsWith(`/api/${res}/`)) {
      return `${res}:${action}`;
    }
  }
  return null;
}

/**
 * Does a key's scope list satisfy `required`? An empty/absent list = unscoped =
 * always satisfied (role still applies). `*` grants all; `posts:*` grants both
 * read and write on posts.
 */
export function scopeSatisfied(scopes: string[] | undefined | null, required: string | null): boolean {
  if (!required) return true;
  if (!scopes || scopes.length === 0) return true;
  if (scopes.includes('*') || scopes.includes(required)) return true;
  const resource = required.split(':')[0];
  return scopes.includes(`${resource}:*`);
}

/**
 * Full authorization decision for a SCOPED bearer key: deny-by-default.
 *
 * A key that carries scopes is a least-privilege credential — it may ONLY touch
 * the resources its scopes name (plus `GET /api/auth/me` for introspection).
 * Without this, a scoped key would fall through to full role power on every
 * endpoint outside the scoped resources (keys, webhooks, users, backup, …),
 * which defeats the point of scoping. Unscoped keys (and cookie sessions) are
 * unaffected — they remain governed by role alone.
 */
export function scopedKeyAllowed(
  scopes: string[] | undefined | null,
  method: string,
  pathname: string,
  /**
   * Scope declared by a PLUGIN route for this path.
   *
   * Core's map cannot know about a path a plugin added at runtime, and
   * `requiredScopeFor` returning null means deny — correct by default, but it
   * would put every plugin route permanently out of reach of the scoped keys a
   * headless storefront uses. A plugin declaring its scope opts in; passing
   * nothing leaves the deny in place.
   */
  pluginScope?: string | null,
): boolean {
  if (!scopes || scopes.length === 0) return true; // unscoped → role governs
  if (scopes.includes('*')) return true; // explicit full grant
  if (method === 'GET' && pathname === '/api/auth/me') return true; // introspection
  // Core's map first: a plugin claiming a path core already scopes must not be
  // able to loosen it by declaring a weaker scope of its own.
  const required = requiredScopeFor(method, pathname) ?? (pluginScope || null);
  if (!required) return false; // outside every scoped resource → deny
  return scopeSatisfied(scopes, required);
}
