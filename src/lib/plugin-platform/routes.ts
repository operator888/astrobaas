/**
 * API routes owned by plugins.
 *
 * ## Why this can exist safely
 *
 * Astro resolves routes from a list sorted once at build time, and a segment
 * that is static always sorts before one that is dynamic or a spread
 * (`astro/dist/core/routing/priority.js`). So a build-time catch-all at
 * `src/pages/api/[...pluginRoute].ts` sits BELOW every real route file, and the
 * router returns the first pattern that matches.
 *
 * That is the whole safety argument, and it is structural rather than
 * defensive: **a plugin cannot shadow a core route, because the core route is a
 * file and files win.** Nothing a plugin, a database row, or an environment
 * variable does can reorder that. It is also the same argument
 * `src/pages/[...slug].astro` already relies on.
 *
 * ## What is NOT structural, and is enforced here
 *
 * - Plugin-vs-plugin collisions. Two plugins claiming one path is resolved by
 *   activation order, which comes from database row order — so it is refused
 *   loudly instead, exactly as duplicate payment providers are.
 * - Reserved namespaces. `/api/auth/`, `/api/keys/`, `/api/users/` and friends
 *   are where sessions, credentials and accounts live. Core files already win
 *   *today*, but a core route deleted or renamed tomorrow would silently hand
 *   the path to a plugin. Refusing the prefix outright means that can never
 *   become true by omission.
 * - Access. The middleware authenticates BEFORE routing and denies unknown
 *   `/api` paths to anonymous callers. A plugin route is therefore staff-only
 *   unless it declares otherwise, and this module is what the middleware asks.
 *
 * ## The access declaration is the security boundary
 *
 * `access: 'public'` means an unauthenticated endpoint. That is exactly what a
 * checkout or a provider webhook needs, and exactly what must never happen by
 * accident — so it is explicit per route, per method, and visible in the admin.
 */

import { isValidScope, SCOPE_FORMAT_HINT, SCOPED_RESOURCES, requiredScopeFor } from '../api-key-scopes';
import type { RequestClient } from '../client-address';

/** Methods a plugin route may claim. */
export const PLUGIN_ROUTE_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type PluginRouteMethod = (typeof PLUGIN_ROUTE_METHODS)[number];

/**
 * Who may call this route.
 *
 *   'staff'   a logged-in staff session, or an API key with the right scope.
 *             The default, and the safe one.
 *   'admin'   an administrator only.
 *   'public'  anyone, unauthenticated. Writes are still CSRF-checked and
 *             rate-limited unless `csrf: 'exempt'` is also declared.
 */
export type PluginRouteAccess = 'staff' | 'admin' | 'public';

export interface PluginRoute {
  method: PluginRouteMethod;
  /**
   * Absolute path, starting `/api/`. May contain `:name` segments
   * (`/api/plugin/shop/orders/:id`) and one trailing `*` for a wildcard tail.
   *
   * The recommended shape is `/api/plugin/<plugin-id>/…`, which cannot collide
   * with anything. Claiming a bare path like `/api/orders` is allowed — it is
   * what lets a module take over a surface core used to own without breaking
   * every storefront pointing at it — but core files still win while they
   * exist, so the plugin's route is simply never reached until the file goes.
   */
  path: string;
  access?: PluginRouteAccess;
  /**
   * Skip CSRF on a write.
   *
   * Only ever correct when the request authenticates itself some other way — a
   * signed provider webhook. A cookie-authenticated endpoint with CSRF off is a
   * cross-site request away from being called by any page on the internet.
   */
  csrf?: 'required' | 'exempt';
  /**
   * API-key scope that governs this route, e.g. `'orders:read'`.
   *
   * Without one, a SCOPED key is denied: `requiredScopeFor` returns null for a
   * path it does not know and `scopedKeyAllowed` treats that as deny. That is
   * the right default — a key scoped to `posts` should not reach a new endpoint
   * just because a plugin added it — but it also means a headless storefront,
   * which is the main reason scoped keys exist, could never call a plugin route
   * at all. Declaring the scope is how a plugin opts in deliberately.
   *
   * Unscoped keys are unaffected: the user's role governs them, as before.
   */
  scope?: string;
  /** One-line description, shown in the admin. */
  description?: string;
  handler: PluginRouteHandler;
}

/** What a handler receives. Deliberately small and framework-neutral. */
export interface PluginRouteContext {
  request: Request;
  url: URL;
  /** Path parameters captured from `:name` segments. */
  params: Record<string, string>;
  /** The authenticated user, if any. Shape mirrors Astro's `locals.user`. */
  user?: { id: string; role: string; email?: string } | null;
  /** Everything Astro put on `locals`, for anything not covered above. */
  locals: Record<string, unknown>;
  /**
   * This plugin's own namespaced store — the same one its migrations receive.
   *
   * Handed in rather than imported, and that is a correctness decision as much
   * as convenience: the namespace is derived from the OWNING plugin's id by the
   * platform, so a handler cannot reach another plugin's records by passing a
   * different id — the same property the migrations path already has.
   *
   * It also closes a real gap for external authors: the storage documentation
   * showed `createPluginStore(id, LocalDB)`, but neither symbol was exported
   * from `astrobaas/core`, so an out-of-tree plugin could persist nothing from
   * a route without reaching into internals the docs forbid.
   */
  store: import('./store').PluginStore;
  /**
   * This plugin's own settings — the object an operator edits on its admin
   * screen — already scoped to this plugin's id.
   *
   * Called per request rather than cached at activation on purpose: an
   * operator who changes a setting does not restart the site, and a value
   * read once at boot is a value that goes stale. It is one indexed read,
   * and it never throws — an unreachable store answers `{}` so a handler
   * falls back to its defaults instead of 500ing.
   */
  settings: () => Promise<Record<string, unknown>>;
  /**
   * Who the request is FOR: the shopper's address and browser.
   *
   * On a request authenticated by an API key — a storefront server calling on
   * a shopper's behalf — `X-Client-IP` and `X-Client-UA` name that shopper.
   * Everywhere else (anonymous, a cookie session) those headers are ignored,
   * because anyone can send them. The IP must parse as one IPv4/IPv6 address
   * or the real address is used; the UA is capped at 512 characters.
   *
   * `ip` is the same identity the core rate limiter counts (`locals.ip`): an
   * IPv4 address as-is, an IPv6 address grouped to its /64. `null` only when
   * no address is known at all. `forwarded` is true when any value came from a
   * forwarding header. See src/lib/client-address.ts.
   */
  client: RequestClient;
}

export type PluginRouteHandler = (ctx: PluginRouteContext) => Promise<Response> | Response;

/** A route plus the plugin that owns it. */
export interface RegisteredRoute extends PluginRoute {
  pluginId: string;
  access: PluginRouteAccess;
  csrf: 'required' | 'exempt';
  /** Pre-compiled matcher, built once at registration rather than per request. */
  readonly matcher: RouteMatcher;
}

/**
 * Prefixes a plugin may never claim.
 *
 * Everything here either authenticates a caller, hands out a credential, or
 * changes who can log in. Core files already win over the catch-all, so today
 * this is belt-and-braces — but a core route deleted or renamed in a later
 * refactor would silently become available to whatever plugin asked for it, and
 * that is not a way to lose an authentication endpoint.
 */
export const RESERVED_API_PREFIXES: readonly string[] = [
  '/api/auth/',
  '/api/2fa/',
  '/api/keys',
  '/api/users/',
  '/api/backup/',
  '/api/plugins',
  '/api/settings/',
  // Creating a webhook mints a signing secret, which is the list's own
  // criterion for being here.
  '/api/webhooks',
];

/**
 * The namespace core will never serve.
 *
 * Widening access — `public`, `csrf: 'exempt'`, or a declared API-key scope —
 * is confined to it (and to first-level names no core file serves, see
 * CORE_API_NAMESPACES), and that restriction is load-bearing rather than tidy.
 *
 * The middleware decides CSRF and authentication BEFORE routing, so it asks
 * this registry about the raw request path. A plugin declaring
 * `{ path: '/api/media/upload', csrf: 'exempt' }` never serves that path — the
 * core route file wins — but the middleware consulted the declaration anyway
 * and stopped checking CSRF on core's real handler. That was reproduced: an
 * anonymous cross-site POST uploaded a file with a session cookie and no token,
 * where the same request is 403 without the plugin.
 *
 * A plugin may still CLAIM any path for a `staff` or `admin` route, because
 * those widen nothing: an unknown `/api` path is already staff-gated, so the
 * declaration changes no gate. That is what keeps the "a module takes over a
 * surface core used to own" story available.
 */
export const PLUGIN_ROUTE_NAMESPACE = '/api/plugin/';

/**
 * Every first-level name under `/api/` that a CORE route file serves.
 *
 * A storefront contract sometimes fixes bare paths — the campaign-games
 * module must answer `/api/game/spin`, not `/api/plugin/campaign-games/spin`,
 * because a shipped storefront already calls it. The reason widening is
 * confined to `/api/plugin/` is that the middleware's gate must never be
 * re-decided for a path CORE serves. A first segment no core file uses has
 * the same property: there is no core handler under it for the declaration
 * to loosen. So such a namespace may be widened too.
 *
 * Hand-kept, and checked against `src/pages/api/` by
 * tests/plugin-game-seams.test.mjs: a core directory added without being
 * listed here fails that test, rather than silently becoming a namespace a
 * plugin could open. Adding a name here is always the safe direction — it
 * only ever REFUSES a widening that used to be allowed, loudly, at boot.
 */
export const CORE_API_NAMESPACES: readonly string[] = Object.freeze([
  '2fa', 'assistant', 'audit', 'auth', 'backup', 'brands', 'captcha', 'categories', 'commerce',
  'consent', 'contact', 'content', 'content-types', 'coupons', 'customers', 'downloads',
  'email-templates', 'forms', 'health', 'i18n', 'import', 'invoice-records', 'keys', 'legal',
  'locales', 'media', 'messages', 'navigation', 'newsletter', 'not-found', 'operations', 'orders',
  'payments', 'plugins', 'posts', 'privacy', 'product-bulk', 'product-categories', 'products',
  'recovery', 'redirects', 'reviews', 'roles', 'search', 'settings', 'shipping-methods', 'stats',
  'taxonomies', 'themes', 'transfer', 'users', 'webhooks',
]);

/**
 * Names a plugin may never widen even though no core FILE uses them yet:
 * every resource the API-key scope map path-maps (`/api/finance/…` would be
 * answered `finance:write` by core's map, which wins over a plugin's declared
 * scope), and the plugin namespace's own parent.
 */
const NEVER_WIDENABLE: ReadonlySet<string> = new Set([
  ...CORE_API_NAMESPACES, ...SCOPED_RESOURCES, 'plugin',
].map((s) => s.toLowerCase()));

/** May this path be granted more than the default staff gate? */
export function canWidenAccess(path: string): boolean {
  if (typeof path !== 'string') return false;
  if (path.startsWith(PLUGIN_ROUTE_NAMESPACE)) return true;
  if (!path.startsWith('/api/')) return false;
  // A bare namespace no core file serves. Compared case-insensitively, so a
  // router that ever matched `/api/Orders` to the orders file could not be
  // used to open a core handler by spelling.
  const first = path.slice('/api/'.length).split('/')[0] ?? '';
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(first)) return false;
  if (NEVER_WIDENABLE.has(first.toLowerCase())) return false;
  // Asked of the scope map itself, not of a second list: some of its rules are
  // PREFIX matches (`/api/coupons…`, `/api/shipping-methods…`), so
  // `/api/coupons-plus/x` is answered `products:*` by core's map, which wins
  // over a plugin's declared scope. A path core's map already governs is not
  // a plugin's to widen.
  for (const m of ['GET', 'POST']) if (requiredScopeFor(m, path) !== null) return false;
  return true;
}

export interface RouteMatcher {
  /** Literal segments and `:name` placeholders, in order. */
  readonly segments: readonly { literal?: string; param?: string }[];
  /** True when the path ended in `*` — the tail is captured as `rest`. */
  readonly wildcard: boolean;
}

/**
 * Compile a declared path into a matcher.
 *
 * Split on `/` and keep the parts, rather than building a RegExp from an
 * operator-supplied string: a path is plugin-authored input, and turning it
 * into a pattern language is how a stray `(` becomes a crash and a `.*` becomes
 * an accidental wildcard over the whole API.
 */
export function compileRoutePath(path: string): RouteMatcher | null {
  if (typeof path !== 'string' || !path.startsWith('/api/')) return null;
  if (path.includes('//') || path.includes('..')) return null;
  const raw = path.split('?')[0].replace(/\/+$/, '') || '/api';
  const parts = raw.split('/').filter(Boolean);
  const segments: { literal?: string; param?: string }[] = [];
  let wildcard = false;
  for (let i = 0; i < parts.length; i += 1) {
    const p = parts[i];
    if (p === '*') {
      // Only meaningful as the final segment; `/a/*/b` would be a pattern
      // language, and this is deliberately not one.
      if (i !== parts.length - 1) return null;
      wildcard = true;
      break;
    }
    if (p.startsWith(':')) {
      const name = p.slice(1);
      if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name)) return null;
      segments.push({ param: name });
      continue;
    }
    if (!/^[A-Za-z0-9._~-]+$/.test(p)) return null;
    segments.push({ literal: p });
  }
  if (segments.length < 2) return null; // at least /api/<something>
  // The segment right after `api` must be LITERAL. A pattern there
  // (`/api/:x/me`) matches every first-level namespace at once, including the
  // reserved ones — and the reserved check is a string test on the declared
  // path, which `:x` sails straight past. Requiring a literal is what makes
  // that check sound rather than nearly sound.
  if (segments[1].literal === undefined) return null;
  return { segments, wildcard };
}

/**
 * Percent-decode, or give up.
 *
 * `decodeURIComponent('%')` throws a URIError. This runs inside the MIDDLEWARE,
 * on an unauthenticated request path, so an uncaught throw here is a 500 that
 * anyone can trigger with a single malformed character. A segment that cannot
 * be decoded simply does not match.
 */
function decodeSegment(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/** Match a request path against a compiled matcher. */
export function matchRoute(
  matcher: RouteMatcher,
  pathname: string,
): { params: Record<string, string> } | null {
  const parts = pathname.replace(/\/+$/, '').split('/').filter(Boolean);
  const { segments, wildcard } = matcher;
  if (wildcard ? parts.length < segments.length : parts.length !== segments.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    const got = parts[i];
    if (seg.literal !== undefined) {
      if (seg.literal !== got) return null;
    } else if (seg.param) {
      // An empty parameter would let `/api/x//y` match `/api/x/:id/y` with an
      // empty id, which handlers would then treat as "no filter".
      if (!got) return null;
      const decoded = decodeSegment(got);
      if (decoded === null) return null;
      params[seg.param] = decoded;
    }
  }
  if (wildcard) {
    const tail: string[] = [];
    for (const part of parts.slice(segments.length)) {
      const decoded = decodeSegment(part);
      if (decoded === null) return null;
      tail.push(decoded);
    }
    params.rest = tail.join('/');
  }
  return { params };
}

/** A path shape a matcher can be keyed on, for duplicate detection. */
export function routeKey(method: string, matcher: RouteMatcher): string {
  const shape = matcher.segments
    .map((s) => (s.literal !== undefined ? s.literal : ':'))
    .join('/');
  return `${method} /${shape}${matcher.wildcard ? '/*' : ''}`;
}

export interface RouteValidation {
  ok: boolean;
  route?: RegisteredRoute;
  problem?: string;
}

/** Validate one declared route from one plugin. */
export function validateRoute(pluginId: string, route: PluginRoute): RouteValidation {
  const where = `plugin "${pluginId}"`;
  if (!route || typeof route !== 'object') return { ok: false, problem: `${where} declared a non-object route` };

  const method = String(route.method ?? '').toUpperCase() as PluginRouteMethod;
  if (!(PLUGIN_ROUTE_METHODS as readonly string[]).includes(method)) {
    return { ok: false, problem: `${where} declared route with unsupported method "${route.method}"` };
  }
  if (typeof route.handler !== 'function') {
    return { ok: false, problem: `${where} declared route ${method} ${route.path} with no handler` };
  }

  const path = String(route.path ?? '');
  for (const reserved of RESERVED_API_PREFIXES) {
    if (path === reserved || path.startsWith(reserved)) {
      return {
        ok: false,
        problem: `${where} tried to claim "${path}", which is under the reserved prefix "${reserved}". `
          + 'Sessions, credentials and accounts live there.',
      };
    }
  }

  const matcher = compileRoutePath(path);
  if (!matcher) {
    return {
      ok: false,
      problem: `${where} declared an unusable route path "${path}". `
        + 'It must start with /api/, have at least one segment after it, and may contain '
        + ':name parameters and one trailing *.',
    };
  }

  const access: PluginRouteAccess =
    route.access === 'public' || route.access === 'admin' ? route.access : 'staff';
  const csrf: 'required' | 'exempt' = route.csrf === 'exempt' ? 'exempt' : 'required';
  const scope = typeof route.scope === 'string' && route.scope.trim() ? route.scope.trim() : undefined;

  // A declared scope must be one an operator can MINT. `game:read` (no such
  // action) or a typo would otherwise register fine and leave the route
  // permanently unreachable for every scoped key — accepted, then silently
  // useless. Refused here with the grammar named.
  if (scope !== undefined && !isValidScope(scope)) {
    return {
      ok: false,
      problem: `${where} declared scope "${scope}" on ${method} ${path}, which no API key can hold: ${SCOPE_FORMAT_HINT}.`,
    };
  }

  // Anything that widens a gate must live where core cannot own the path —
  // otherwise the declaration re-decides the gate on CORE's handler, which the
  // plugin never reaches. See PLUGIN_ROUTE_NAMESPACE.
  const widens = access === 'public' || csrf === 'exempt' || scope !== undefined;
  if (widens && !canWidenAccess(path)) {
    const asked = [
      access === 'public' ? "access: 'public'" : null,
      csrf === 'exempt' ? "csrf: 'exempt'" : null,
      scope ? `scope: '${scope}'` : null,
    ].filter(Boolean).join(', ');
    return {
      ok: false,
      problem: `${where} declared ${asked} on "${path}", which is outside `
        + `"${PLUGIN_ROUTE_NAMESPACE}" and under a namespace core serves. The middleware decides `
        + 'authentication and CSRF before routing, so that declaration would relax the gate on '
        + `whatever CORE serves at that path. Move the route under ${PLUGIN_ROUTE_NAMESPACE}${pluginId}/ `
        + "(or a first-level name core does not use), or declare it 'staff'.",
    };
  }

  return { ok: true, route: { ...route, method, path, pluginId, access, csrf, scope, matcher } };
}

/* ------------------------------------------------------------------ *
 * The registry
 * ------------------------------------------------------------------ */

let routes: readonly RegisteredRoute[] = [];

/**
 * Replace the whole set. Called once per bootstrap with the routes of every
 * ACTIVE plugin — replace rather than append, so a deactivated plugin's routes
 * genuinely stop being served instead of lingering until a restart.
 */
export function setPluginRoutes(declared: readonly { pluginId: string; route: PluginRoute }[]): void {
  const kept: RegisteredRoute[] = [];
  const seen = new Map<string, string>();
  for (const { pluginId, route } of declared) {
    const check = validateRoute(pluginId, route);
    if (!check.ok || !check.route) {
      console.error(`[astrobaas] ${check.problem}`);
      continue;
    }
    const key = routeKey(check.route.method, check.route.matcher);
    const owner = seen.get(key);
    if (owner) {
      // Resolving this by activation order would mean database row order
      // decides which plugin answers a live URL.
      console.error(
        `[astrobaas] plugin "${pluginId}" tried to claim ${key}, already owned by "${owner}". `
        + 'Ignoring it — two plugins answering one URL would be resolved by row order.',
      );
      continue;
    }
    seen.set(key, pluginId);
    kept.push(check.route);
  }
  // Most specific first: a literal segment beats a parameter at the same depth,
  // and a wildcard is always last. Without this, `/api/x/:id` registered before
  // `/api/x/summary` would swallow `/api/x/summary` as an id.
  routes = kept.sort((a, b) => {
    if (a.matcher.wildcard !== b.matcher.wildcard) return a.matcher.wildcard ? 1 : -1;
    if (a.matcher.segments.length !== b.matcher.segments.length) {
      return b.matcher.segments.length - a.matcher.segments.length;
    }
    const litsA = a.matcher.segments.filter((s) => s.literal !== undefined).length;
    const litsB = b.matcher.segments.filter((s) => s.literal !== undefined).length;
    return litsB - litsA;
  });
}

/** Every registered route, for the admin and for diagnostics. */
export function allPluginRoutes(): readonly RegisteredRoute[] {
  return routes;
}

/** Resolve a request to a route, or null. */
export function resolvePluginRoute(
  method: string,
  pathname: string,
): { route: RegisteredRoute; params: Record<string, string> } | null {
  const m = String(method ?? '').toUpperCase();
  for (const route of routes) {
    if (route.method !== m) continue;
    const hit = matchRoute(route.matcher, pathname);
    if (hit) return { route, params: hit.params };
  }
  return null;
}

/**
 * Does ANY plugin route exist at this path, whatever the method?
 *
 * The dispatcher needs it to answer 405 rather than 404 for a known path called
 * with the wrong verb — the difference between "you used the wrong method" and
 * "this does not exist", which is the difference between a five-minute fix and
 * an afternoon.
 */
export function pluginRouteExistsAtPath(pathname: string): boolean {
  return routes.some((r) => matchRoute(r.matcher, pathname) !== null);
}

/**
 * What the MIDDLEWARE needs to know, before routing, without running a handler.
 *
 * Returns null when no plugin owns the path, which the middleware must treat
 * exactly as it treats any other unknown `/api` path: deny.
 */
export function pluginRouteAccess(
  method: string,
  pathname: string,
): {
  access: PluginRouteAccess;
  csrf: 'required' | 'exempt';
  scope?: string;
  pluginId: string;
} | null {
  // Refuse to answer for anything outside the namespace, even though
  // validateRoute already refuses to register it. This function is the one the
  // middleware calls, and the cost of the two disagreeing is a core endpoint
  // with its CSRF check switched off.
  if (!canWidenAccess(pathname)) return null;
  const hit = resolvePluginRoute(method, pathname);
  if (!hit) return null;
  const { access, csrf, scope, pluginId } = hit.route;
  return { access, csrf, scope, pluginId };
}
