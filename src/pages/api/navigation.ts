import type { APIRoute } from 'astro';
import { LocalDB } from '../../lib/localdb';
import { ApiResponseBuilder } from '../../lib/api-response';
import { contentLocale } from '../../lib/i18n/resolve';
import { withPublicCache } from '../../lib/http-cache';
import { NAVIGATION_SETTING, readNavigation, resolveNavigation } from '../../lib/navigation';

/**
 * `GET /api/navigation` — the site menu, for a storefront that renders its own
 * header.
 *
 * Public, because the menu IS public: it renders on every page of the built-in
 * site. A headless storefront is the other half of what AstroBaaS is for, and a
 * menu only the server-rendered theme could read would leave that half editing
 * its navigation in code — the exact thing /admin/navigation exists to end.
 *
 * `?locale=de` returns German labels where the operator gave them, and internal
 * links prefixed the way this CMS prefixes its own. `items` is empty when no
 * menu was ever saved; a storefront should then show its own default links,
 * the same contract the bundled themes follow.
 *
 * Nothing here is the setting's raw storage: it is re-read through
 * `readNavigation`, so a malformed stored value answers `items: []` rather
 * than handing a storefront something it would render as a broken link.
 */
export const GET: APIRoute = async ({ url, request, locals }) => {
  try {
    await LocalDB.init();
    const locale = contentLocale(null, url.searchParams.get('locale'));
    const stored = (await LocalDB.getSetting(NAVIGATION_SETTING))?.value;
    const items = resolveNavigation(readNavigation(stored), { locale });
    return withPublicCache(ApiResponseBuilder.success({ items }, undefined, { locale }), { request, locals });
  } catch (err) {
    console.error('Navigation read error:', err);
    return ApiResponseBuilder.serverError('Failed to read the navigation');
  }
};
