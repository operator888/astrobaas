/**
 * Admin screens owned by plugins.
 *
 * ## Why these are namespaced when routes are not
 *
 * An API route may claim any path, because Astro's file routes structurally win
 * and a module taking over a surface core used to own is a real requirement.
 * Admin pages have no such requirement and a much sharper hazard:
 * `canOpenAdminPage` resolves LONGEST-PREFIX-WINS over one shared rule table
 * (`lib/admin-access.ts`). A plugin inserting `/admin/products/bulk` into that
 * table would not merely add a screen — it would out-specify the `/admin/products`
 * rule and decide who may open everything beneath it.
 *
 * So every plugin screen lives under `/admin/plugin/<plugin-id>/…`, which
 * cannot out-specify any core prefix because it shares none.
 *
 * ## Access is deny-by-default, and that is inherited, not re-implemented
 *
 * `canOpenAdminPage` already denies an unknown `/admin` path to everything but
 * an administrator. A plugin screen with no declared roles is therefore
 * admin-only for free, and a plugin can only ever WIDEN that deliberately.
 *
 * ## Scripts
 *
 * The app ships a hash-based CSP with no `unsafe-inline`, so a plugin cannot
 * put a `<script>` in its markup — the browser would drop it silently, which is
 * the worst kind of broken. A page declares `script` instead and core serves it
 * same-origin from `/plugin-admin.js`, exactly as plugin CSS is served from
 * `/plugins.css`.
 */

import type { Role } from '../../core/models';

export interface PluginAdminPageContext {
  /** Path parameters after the page's own path, if it declared `:name` parts. */
  params: Record<string, string>;
  url: URL;
  user: { id: string; role: string; email?: string } | null;
  /** CSRF token, for forms and fetches the page renders. */
  csrf: string;
}

export interface PluginAdminPage {
  /**
   * Path under the plugin's namespace. `'orders'` becomes
   * `/admin/plugin/<plugin-id>/orders`. `''` is the plugin's index page.
   */
  path: string;
  /** Browser title and heading. */
  title: string;
  /** Shown in the sidebar when set. Omit for a page reachable only by link. */
  nav?: { label: string; order?: number };
  /**
   * Roles allowed to open it. Omitted means ADMIN ONLY — the same default an
   * unknown admin path already gets, so forgetting is safe rather than silent.
   */
  roles?: readonly Role[];
  /** Return the page body as HTML. */
  render(ctx: PluginAdminPageContext): Promise<string> | string;
  /**
   * Optional client-side JavaScript, served from /plugin-admin.js under the
   * CSP. Plain script text — no module imports, no bundler.
   */
  script?: string;
}

export interface RegisteredAdminPage extends PluginAdminPage {
  pluginId: string;
  /** Absolute href: /admin/plugin/<plugin-id>/<path>. */
  href: string;
  roles: readonly Role[];
}

export const PLUGIN_ADMIN_PREFIX = '/admin/plugin';

const SEGMENT = /^[a-z0-9][a-z0-9_-]*$/i;

/** Validate one declared page. Returns the problem rather than throwing. */
export function validateAdminPage(
  pluginId: string,
  page: PluginAdminPage,
): { ok: boolean; page?: RegisteredAdminPage; problem?: string } {
  const where = `plugin "${pluginId}"`;
  if (!page || typeof page !== 'object') return { ok: false, problem: `${where} declared a non-object admin page` };
  if (typeof page.render !== 'function') {
    return { ok: false, problem: `${where} declared admin page "${page.path}" with no render()` };
  }
  if (typeof page.title !== 'string' || !page.title.trim()) {
    return { ok: false, problem: `${where} declared an admin page with no title` };
  }

  const raw = String(page.path ?? '').replace(/^\/+|\/+$/g, '');
  const parts = raw ? raw.split('/') : [];
  // No traversal, no empty segments, no parameters: an admin path is a place,
  // not a pattern. Anything that needs an id belongs in the query string.
  for (const p of parts) {
    if (!SEGMENT.test(p)) {
      return { ok: false, problem: `${where} declared an unusable admin page path "${page.path}"` };
    }
  }

  const href = `${PLUGIN_ADMIN_PREFIX}/${pluginId}${parts.length ? `/${parts.join('/')}` : ''}`;
  const roles: readonly Role[] = Array.isArray(page.roles) && page.roles.length
    ? page.roles.filter((r): r is Role => typeof r === 'string')
    : ['admin'];

  return { ok: true, page: { ...page, path: parts.join('/'), pluginId, href, roles } };
}

let pages: readonly RegisteredAdminPage[] = [];

/** Replace the whole set, from ACTIVE plugins only. */
export function setPluginAdminPages(
  declared: readonly { pluginId: string; page: PluginAdminPage }[],
): void {
  const kept: RegisteredAdminPage[] = [];
  const seen = new Set<string>();
  for (const { pluginId, page } of declared) {
    const check = validateAdminPage(pluginId, page);
    if (!check.ok || !check.page) {
      console.error(`[astrobaas] ${check.problem}`);
      continue;
    }
    if (seen.has(check.page.href)) {
      console.error(`[astrobaas] ${pluginId} declared two admin pages at ${check.page.href}; keeping the first`);
      continue;
    }
    seen.add(check.page.href);
    kept.push(check.page);
  }
  pages = kept;
}

export function allPluginAdminPages(): readonly RegisteredAdminPage[] {
  return pages;
}

/** Resolve an /admin/plugin/... pathname to a page. */
export function resolveAdminPage(pathname: string): RegisteredAdminPage | null {
  const clean = pathname.replace(/\/+$/, '') || pathname;
  return pages.find((p) => p.href === clean) ?? null;
}

/**
 * Roles allowed at this admin path, or undefined when no plugin owns it.
 *
 * `admin-access.ts` consults this BEFORE its own table, so a plugin page is
 * governed by its own declaration and an unclaimed `/admin/plugin/...` path
 * falls through to the deny-by-default rule.
 */
export function pluginAdminPageRoles(pathname: string): readonly Role[] | undefined {
  return resolveAdminPage(pathname)?.roles;
}

/** Sidebar entries this role should see, in declared order. */
export function pluginNavFor(role: string | undefined): { href: string; label: string }[] {
  if (!role) return [];
  return pages
    .filter((p) => p.nav && p.roles.includes(role as Role))
    .sort((a, b) => (a.nav?.order ?? 100) - (b.nav?.order ?? 100))
    .map((p) => ({ href: p.href, label: p.nav!.label }));
}

/** Every page's script, concatenated for /plugin-admin.js. */
export function adminScriptFor(pathname: string): string | null {
  const page = resolveAdminPage(pathname);
  return page?.script ? page.script : null;
}
