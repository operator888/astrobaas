import type { APIRoute } from 'astro';
import { LocalDB } from '../lib/localdb';
import { ensurePluginsBootstrapped } from '../plugins';
import { resolveAdminPage } from '../lib/plugin-platform/admin-pages';
import { canOpenAdminPage } from '../lib/admin-access';

/**
 * Serve one plugin admin screen's JavaScript, same-origin.
 *
 * The app ships a hash-based CSP with no `unsafe-inline`, so a plugin cannot
 * put a `<script>` in its markup — the browser drops it silently, which is the
 * worst kind of broken. This is the same answer `/plugins.css` gives for CSS.
 *
 * Authorised with the SAME rule as the page it belongs to. A plugin's admin
 * script is written for an operator and can name internal endpoints, field
 * shapes and record ids; serving it to anyone who guesses the URL would leak
 * the shape of a screen they cannot open.
 */
export const prerender = false;

export const GET: APIRoute = async ({ url, locals }) => {
  await LocalDB.init();
  await ensurePluginsBootstrapped();

  const href = url.searchParams.get('page') ?? '';
  const page = resolveAdminPage(href);
  const role = (locals.user as { role?: string } | undefined)?.role;

  // 404 for unknown AND unauthorised alike, for the same reason the page
  // redirects rather than explaining.
  if (!page || !page.script || !canOpenAdminPage(page.href, role as never)) {
    return new Response('// not found\n', {
      status: 404,
      headers: { 'Content-Type': 'application/javascript; charset=utf-8' },
    });
  }

  return new Response(page.script, {
    status: 200,
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      // Per-user authorisation decides this body, so a shared cache must never
      // hold it.
      'Cache-Control': 'private, no-store',
    },
  });
};
