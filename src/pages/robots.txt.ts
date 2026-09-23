import type { APIRoute } from 'astro';
import { LocalDB } from '../lib/localdb';
import { resolveSiteUrl } from '../lib/site-url';
import {
  buildRobotsTxt, policyToGroups, CRAWLER_POLICY_SETTING, type RobotsGroup,
} from '../lib/robots-txt';
import { pluginManager, PLUGIN_HOOKS } from '../lib/plugin-system';
import { resolveDiscourageIndexing } from '../lib/indexing';

export const GET: APIRoute = async ({ site, url }) => {
  await LocalDB.init();
  const setting = await LocalDB.getSetting('discourage_indexing');
  const discourage = resolveDiscourageIndexing(setting?.value);
  // Through the same resolver as the sitemap and feed. site-url.ts's own header
  // lists robots.txt among the routes that ignored the admin's Site URL, and
  // then only the sitemap and feed were converted — so this file kept emitting
  // a `Sitemap:` line pointing at a different origin from the one the pages
  // canonicalised to.
  const siteUrlSetting = await LocalDB.getSetting('site_url');
  const origin = resolveSiteUrl({
    setting: siteUrlSetting?.value,
    astroSite: site,
    requestUrl: url,
  }) ?? 'http://localhost:4321';

  // The operator's own rules, appended to the managed block by buildRobotsTxt.
  // Read unconditionally rather than inside the non-discourage branch, so the
  // two settings are fetched the same way whatever the answer is.
  const custom = await LocalDB.getSetting('robots_txt');

  /*
   * Per-crawler groups: the operator's own choices first, then whatever a pack
   * contributes through ROBOTS_GROUPS.
   *
   * Read even when `discourage` is set, and then thrown away by
   * buildRobotsTxt's short-circuit. Doing the reads unconditionally keeps the
   * two branches fetching the same things — the comment above `custom` records
   * why that matters — and the kill switch stays the one rule that cannot be
   * outranked by anything, including a plugin.
   */
  const policy = await LocalDB.getSetting(CRAWLER_POLICY_SETTING);
  const groups = pluginManager.applyFilters(
    PLUGIN_HOOKS.ROBOTS_GROUPS,
    policyToGroups(policy?.value),
    { origin },
  ) as RobotsGroup[];

  const body = buildRobotsTxt({ custom: custom?.value, discourage, origin, groups });

  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};
