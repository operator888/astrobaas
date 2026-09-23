import type { APIRoute } from 'astro';
import { resolveSiteUrl } from '../lib/site-url';
import { LocalDB } from '../lib/localdb';
import { articlesOnly } from '../lib/post-kind';
import { localePath, recordLocale } from '../lib/i18n';
import { resolveDiscourageIndexing } from '../lib/indexing';
import { escapeXml as xmlEscape } from '../lib/escape-html';
import { localizedSettings } from '../lib/settings-i18n';
import { withPublicCache } from '../lib/http-cache';


export const GET: APIRoute = async ({ site, url, locals, request }) => {
  await LocalDB.init();
  const settings = await LocalDB.getSettings();
  const map: Record<string, any> = {};
  settings.forEach(s => (map[s.key] = s.value));
  // The admin's "Site URL" setting wins over the build-time SITE_URL: the
  // setting is editable at runtime, which is the one a self-hoster who moved
  // domains (or deployed a prebuilt image) can actually change. It was stored
  // and read by nothing until now.
  const origin = resolveSiteUrl({ setting: map.site_url, astroSite: site, requestUrl: url })
    ?? 'http://localhost:4321';
  // Per-locale (C-136). The feed is served per locale — it links
  // `localePath(...)` two dozen lines down — so a German feed carrying the
  // Greek site title was the exact symptom that row named. Wiring
  // `getSiteSettings` alone did not reach here, because this route reads its
  // own settings map.
  const localized = localizedSettings(map, locals?.locale);
  const title = localized.site_title || 'AstroBaaS';
  const tagline = localized.site_tagline || 'A modern CMS built with Astro';

  const limitRaw = Number(map.feed_items ?? 20);
  const limit = Math.min(200, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 20));
  const feedFormat = map.feed_format === 'full' ? 'full' : 'excerpt';

  // A hidden site publishes no feed. The sitemap already honoured
  // `discourage_indexing` and this did not — so a staging site told search
  // engines nothing and then handed the same content to every feed reader and
  // aggregator anyway, which is the same disclosure through a different door.
  // See sitemap.xml.ts: the same helper, so this file cannot drift from it a
  // second time. Its own comment above records the first time it did.
  const discourage = resolveDiscourageIndexing(map.discourage_indexing);

  // Articles only. A Page has no date and no author byline; pushing one into a
  // subscriber's reader as a new item would be wrong on both counts. A post
  // marked `noindex` is excluded too: an author hiding a piece from search
  // does not mean "publish it to every aggregator instead".
  const posts = discourage ? [] : articlesOnly(await LocalDB.getPosts())
    .filter(p => p.status === 'published' && !p.noindex)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, limit);

  const items = posts
    .map(p => {
      // The record's OWN locale decides the URL. A German post linked at the
      // unprefixed /blog/x sends every subscriber to a page the site serves in
      // the default language, and makes the feed's guid — a permalink — an
      // address hreflang does not recognise for that document.
      const link = `${origin}${localePath(`/blog/${p.slug}`, recordLocale(p))}`;
      const pub = new Date(p.publish_date || p.created_at).toUTCString();
      const body = feedFormat === 'full' ? (p.content || p.excerpt || '') : (p.excerpt || '');
      return `    <item>
      <title>${xmlEscape(p.title)}</title>
      <link>${xmlEscape(link)}</link>
      <guid isPermaLink="true">${xmlEscape(link)}</guid>
      <pubDate>${pub}</pubDate>
      <description>${xmlEscape(body)}</description>
    </item>`;
    })
    .join('\n');

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${xmlEscape(title)}</title>
    <link>${xmlEscape(origin)}</link>
    <description>${xmlEscape(tagline)}</description>
${items}
  </channel>
</rss>
`;

  // Feed readers poll; an ETag turns most polls into a bodiless 304. The feed
  // is the same for everybody, but a signed-in editor's copy still goes out
  // `private` — one rule for every public read, see lib/http-cache.ts.
  return withPublicCache(new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' },
  }), { request, locals });
};
