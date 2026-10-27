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
 *
 * ## Named actions (NAMED_SCOPE_ACTIONS)
 *
 * Some capabilities are not "read or write a resource" but ONE thing a
 * storefront may do: play a campaign game, validate a coupon in a quote, read a
 * public counter. Those get a resource with its own short list of actions —
 * `game:play`, `coupons:validate`, `stats:read` — and nothing else.
 *
 * The actions are PER RESOURCE, and that is the decision: `game:read` is NOT a
 * valid scope, because nothing defines a read on `game`. A grammar that
 * accepted any `<resource>:<word>` would let an operator mint `game:read`, be
 * told "created", and hold a key that can do nothing at all — the silent
 * accept-and-discard shape. `<resource>:*` is valid for a named resource and
 * means "every action defined for it", exactly as `posts:*` does.
 *
 * A named resource is never path-mapped by `requiredScopeFor`'s resource loop.
 * `/api/game/…` belongs to whatever plugin serves it, and the route's own
 * declared `scope` governs it. Were `game` in that loop, core's map would
 * answer `game:write` for a POST first (core's map wins over a plugin's
 * declaration), and a `game:play` route could never be reached by the key it
 * was declared for.
 */

/** Resources that are scope-gated. Other endpoints are governed by role only. */
export const SCOPED_RESOURCES = [
  'posts', 'content', 'media', 'products', 'orders', 'customers', 'messages',
  // The finance module's routes (/api/plugin/finance/…) declare finance:read /
  // finance:write, so a website or agent can hold a key that touches invoices
  // and nothing else. Listed here so such a key can be minted.
  'finance',
  // The EWS ERP external plugin (/api/plugin/erp/…) declares erp:read /
  // erp:write, so an agent can hold a key that reaches the ERP and nothing
  // else on the site.
  'erp',
] as const;

/**
 * Resources whose actions are NAMED rather than read/write. See the module
 * comment for why each action is per resource and why these are not
 * path-mapped. Adding an action here is how a new capability becomes
 * mintable; a plugin route may then declare it as its `scope`.
 *
 * Disjoint from SCOPED_RESOURCES (a test holds that): one resource with both
 * grammars would make `stats:write` mean something on one list and nothing
 * on the other.
 */
export const NAMED_SCOPE_ACTIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  // The paid campaign-games module's storefront routes (`/api/game/…`).
  game: Object.freeze(['play']),
  // Validating a coupon by pricing a basket: `POST /api/orders/quote` and
  // nothing else. A storefront key that only answers "your code works" must
  // not need `orders:write`, which also places orders.
  coupons: Object.freeze(['validate']),
  // Opt-in public counters (`GET /api/stats/…`). Read-only by construction.
  stats: Object.freeze(['read']),
});

/**
 * Every token the mint endpoint accepts.
 *
 * BUILT from `SCOPED_RESOURCES` and `NAMED_SCOPE_ACTIONS`, as is the error
 * text below (S3.12). The two used to be separate literals: the regex grew
 * products, orders, customers and messages while the mint endpoint's error
 * message still said `<posts|content|media>`, so an operator who mistyped
 * `order:read` was told the only valid resources were three that had nothing
 * to do with a shop.
 */
const VALID_SCOPES: ReadonlySet<string> = (() => {
  const out = new Set<string>(['*']);
  for (const res of SCOPED_RESOURCES) for (const a of ['read', 'write', '*']) out.add(`${res}:${a}`);
  for (const [res, actions] of Object.entries(NAMED_SCOPE_ACTIONS)) {
    for (const a of actions) out.add(`${res}:${a}`);
    out.add(`${res}:*`);
  }
  return out;
})();

/** Validate a single scope token (for the mint endpoint, and a plugin route's declared `scope`). */
export function isValidScope(s: unknown): s is string {
  return typeof s === 'string' && VALID_SCOPES.has(s);
}

/** What the mint endpoint tells an operator when a scope is malformed. */
export const SCOPE_FORMAT_HINT =
  `each scope must be "*" or "<${SCOPED_RESOURCES.join('|')}>:<read|write|*>", or one of `
  + Object.entries(NAMED_SCOPE_ACTIONS)
    .map(([res, actions]) => `"${res}:<${[...actions, '*'].join('|')}>"`)
    .join(', ');

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
  // Bulk product edit is N product edits in one request: the same scope.
  if (pathname === '/api/product-bulk' || pathname.startsWith('/api/product-bulk/')) return `products:${action}`;
  // The contact form. A headless storefront should be able to POST it with a
  // scoped key instead of performing the CSRF-cookie handshake.
  if (pathname === '/api/contact' || pathname.startsWith('/api/contact/')) return `messages:${action}`;
  // An invoice record is part of an order (its PDF names the buyer), so it is
  // governed by the `orders` scope — a `posts:read` key must not open one.
  if (pathname.startsWith('/api/invoice-records/')) return `orders:${action}`;
  // Opt-in public counters: a read, or nothing. A write under /api/stats has
  // no scope that could grant it, so a scoped key is denied (null → deny).
  if (pathname === '/api/stats' || pathname.startsWith('/api/stats/')) {
    return action === 'read' ? 'stats:read' : null;
  }
  for (const res of SCOPED_RESOURCES) {
    if (pathname === `/api/${res}` || pathname.startsWith(`/api/${res}/`)) {
      return `${res}:${action}`;
    }
  }
  return null;
}

/**
 * A NARROWER scope that also grants one specific endpoint.
 *
 * `requiredScopeFor` answers with the one scope that governs a resource, and
 * for `POST /api/orders/quote` that is `orders:write` — which also places
 * orders. A storefront that only checks "does this coupon work on this basket"
 * should be able to hold far less, so the quote also accepts
 * `coupons:validate`. Keyed on method AND exact path: it widens nothing else,
 * and in particular not `POST /api/orders`.
 */
const ALTERNATIVE_SCOPES: readonly { method: string; path: RegExp; scope: string }[] = [
  { method: 'POST', path: /^\/api\/orders\/quote\/?$/, scope: 'coupons:validate' },
];

/** The narrower scope that also grants this request, or null. */
export function alternativeScopeFor(method: string, pathname: string): string | null {
  const m = String(method ?? '').toUpperCase();
  const hit = ALTERNATIVE_SCOPES.find((a) => a.method === m && a.path.test(pathname));
  return hit ? hit.scope : null;
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
  if (scopeSatisfied(scopes, required)) return true;
  // A narrower capability for this exact endpoint (coupons:validate → quote).
  const alt = alternativeScopeFor(method, pathname);
  return alt !== null && scopeSatisfied(scopes, alt);
}
