import type { APIRoute } from 'astro';
import { createPluginStore } from '../../lib/plugin-platform/store';
import { getPluginSettings } from '../../lib/plugin-platform/settings';
import { LocalDB } from '../../lib/localdb';
import { ensurePluginsBootstrapped } from '../../plugins';
import { resolvePluginRoute, pluginRouteExistsAtPath } from '../../lib/plugin-platform/routes';

/**
 * Dispatch to a plugin-owned API route.
 *
 * ## Why this file cannot shadow anything
 *
 * Astro sorts routes once at build time, and a static segment always sorts
 * before a spread (`astro/dist/core/routing/priority.js`). This pattern is
 * therefore BELOW every real route file, and the router returns the first
 * match. `/api/orders` reaches `src/pages/api/orders/index.ts`; only paths no
 * file claims arrive here. It is the same argument `src/pages/[...slug].astro`
 * already relies on.
 *
 * That is what makes runtime-registered routes safe: a plugin cannot take a
 * core endpoint even by claiming its exact path.
 *
 * ## The middleware has already decided whether this caller may be here
 *
 * Authentication, CSRF, rate limiting and API-key scoping all run in
 * middleware, before routing. An unknown `/api` path is denied to anonymous
 * callers there, and a plugin route escapes that only by declaring
 * `access: 'public'`. So a request arriving here has passed the gate its own
 * route asked for.
 *
 * This file does not re-authenticate. What it does is refuse to run a handler
 * the middleware could not have vetted — see the access re-check below, which
 * makes a mismatch fail closed rather than open.
 */
export const prerender = false;

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Mirrors the STAFF list in lib/admin-access.ts. `viewer` is deliberately absent. */
const STAFF_ROLES = new Set(['admin', 'editor', 'author', 'manager']);

const notFound = () =>
  json({ success: false, error: { message: 'Not found', code: 'NOT_FOUND' } }, 404);

async function dispatch(context: Parameters<APIRoute>[0]): Promise<Response> {
  const { request, url, locals } = context;
  const method = request.method.toUpperCase();

  await LocalDB.init();
  // Awaits the memoized bootstrap promise, so a request arriving mid-reload
  // queues rather than racing past into an empty registry.
  await ensurePluginsBootstrapped();

  const hit = resolvePluginRoute(method, url.pathname);
  if (!hit) {
    // A path a plugin owns for a DIFFERENT verb is 405, not 404. The difference
    // between "you used the wrong method" and "this does not exist" is the
    // difference between a five-minute fix and an afternoon.
    if (pluginRouteExistsAtPath(url.pathname)) {
      return json(
        { success: false, error: { message: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' } },
        405,
      );
    }
    return notFound();
  }

  const { route, params } = hit;
  // `Locals` is a declared interface, so a direct cast to Record is rejected;
  // going through `unknown` is the documented way and is what every consumer of
  // an open-ended bag has to do.
  const bag = locals as unknown as Record<string, unknown>;
  const user = (bag.user as { id: string; role: string; email?: string } | undefined) ?? null;

  // Fail closed on a mismatch between what the middleware enforced and what the
  // route asks for. Both read the same registry, so they agree unless it
  // changed between the two reads — a reload landing mid-request. Refusing is
  // the safe side of that race; running an admin-only handler for whoever
  // happened to be in flight is not.
  //
  // 404, not 403: whether a private plugin endpoint exists is itself
  // information, and the same reasoning core already applies to private
  // content types.
  if (route.access === 'admin' && user?.role !== 'admin') return notFound();
  // 'staff' means the roles this codebase already calls staff. `viewer` can log
  // in but is not one of them — admin-access.ts has always excluded it — so
  // treating "has a session" as "is staff" would quietly hand a read-only
  // account every plugin endpoint.
  if (route.access === 'staff' && !STAFF_ROLES.has(user?.role ?? '')) return notFound();

  try {
    const res = await route.handler({
      request, url, params, user, locals: bag,
      // Namespaced to the plugin that OWNS the route — see PluginRouteContext.
      store: createPluginStore(route.pluginId, LocalDB),
      settings: () => getPluginSettings(route.pluginId),
    });
    if (!(res instanceof Response)) {
      console.error(
        `[astrobaas] plugin "${route.pluginId}" route ${route.method} ${route.path} did not return a Response`,
      );
      return json({ success: false, error: { message: 'Plugin route failed', code: 'PLUGIN_ERROR' } }, 500);
    }
    return res;
  } catch (err) {
    // Never surface a plugin's raw error: it can carry credentials, queries and
    // paths. Named in the log, generic on the wire.
    console.error(`[astrobaas] plugin "${route.pluginId}" route ${route.method} ${route.path} threw:`, err);
    return json({ success: false, error: { message: 'Plugin route failed', code: 'PLUGIN_ERROR' } }, 500);
  }
}

export const GET: APIRoute = (ctx) => dispatch(ctx);
export const POST: APIRoute = (ctx) => dispatch(ctx);
export const PUT: APIRoute = (ctx) => dispatch(ctx);
export const PATCH: APIRoute = (ctx) => dispatch(ctx);
export const DELETE: APIRoute = (ctx) => dispatch(ctx);
