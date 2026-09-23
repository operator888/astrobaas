import type { APIRoute } from 'astro';
import { resolveSiteUrl } from '../lib/site-url';
import { LocalDB } from '../lib/localdb';
import { articlesOnly, pagesOnly, isPage } from '../lib/post-kind';
import { isReservedSlug } from '../lib/reserved-slugs';
import { locales, localePath, recordLocale, defaultLocale } from '../lib/i18n';
import { resolveDiscourageIndexing } from '../lib/indexing';
import { escapeXml as xmlEscape } from '../lib/escape-html';
import { withPublicCache } from '../lib/http-cache';


export const GET: APIRoute = async ({ site, url, request, locals }) => {
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
  // `noindex` drops a record here as well as from its own <head>. A sitemap
  // that advertises a URL whose page then says "do not index me" is a
  // contradiction, and search engines answer contradictions by trusting the
  // whole sitemap less — so the two signals are kept in agreement at the
  // source rather than left to argue.
  const allRecords = await LocalDB.getPosts();
  const published = allRecords.filter(p => p.status === 'published' && !p.noindex);
  // Pages and posts are the same record with a different `kind`, so they are
  // separated here rather than in storage — using the shared classifier so this
  // route cannot drift from the archive, the feed and the API.
  const posts = articlesOnly(published);
  const pages = pagesOnly(published);

  // Built-in routes always WIN over a Page with the same slug — Astro's route
  // order is static and a database row cannot change it. `reserved-slugs.ts`
  // now refuses such a Page at write time, so a collision can only be a row
  // that predates that check.
  //
  // This used to drop the built-in entry whenever a Page claimed its slug,
  // which was exactly backwards: it advertised `/about` with the PAGE's
  // `lastmod`, telling crawlers content had changed when the bytes served had
  // not. The built-in is what actually renders, so the built-in is what is
  // listed, and the unreachable Page is dropped instead.
  const builtins = ['about', 'contact'];
  const reservedByBuiltins = new Set(builtins);

  // The Page designated as the home page is already advertised as `/`. Listing
  // it again under `/{slug}` would submit the same content twice under two
  // URLs, which is precisely the duplicate-content signal a sitemap exists to
  // avoid. `/` stays in the list either way, so nothing is lost by dropping it
  // here.
  const homeSlug = String(map.home_page_slug ?? '').trim();
  const routablePages = pages.filter(
    // A Page whose slug a built-in route serves is not reachable at that URL,
    // and the designated home page is already advertised as `/`. Listing either
    // would submit a URL whose content is not the Page's.
    p => p.slug !== homeSlug && !reservedByBuiltins.has(p.slug) && !isReservedSlug(p.slug),
  );

  // A staging site must not be indexed. The sitemap ignored this setting
  // entirely, which meant a "hidden" site still handed search engines a
  // complete map of itself.
  // resolveDiscourageIndexing, not `!!`: the env override that keeps a staging
  // clone out of the index lives there, and four of the five readers used to
  // bypass it — so STAGING=1 hid the pages and still submitted the sitemap.
  const discourage = resolveDiscourageIndexing(map.discourage_indexing);

  // The front door serves the designated home Page. If that Page is hidden,
  // listing `/` advertises a URL whose page then says "do not index me" — the
  // same contradiction the per-post filter above avoids, at the one URL the
  // filter cannot see because it is not keyed on a slug.
  // Is the page that ACTUALLY renders at `/` a hidden one?
  //
  // Looked up in the UNFILTERED list, because `pages` has already had
  // noindexed records removed — searching it returned undefined exactly when
  // the home Page was hidden, which made this guard silently always-false.
  //
  // But unfiltered means drafts too, and a draft designated as home does NOT
  // render at `/`: index.astro falls back to the stock homepage, which is
  // perfectly indexable. Dropping `/` for it would delist a live site's most
  // important URL because of a flag on a page nobody can see. So both
  // conditions have to hold — published AND noindex — which is exactly when
  // `/` serves that page and that page says not to index it.
  // Resolved the SAME way index.astro resolves it — `isPage`, published, that
  // slug — because the question is "is the record that actually renders at `/`
  // a hidden one?". Two resolvers that disagree pick different records when an
  // article and a Page share a slug (the post UPDATE path allows that), and
  // `find` takes whichever was created first.
  const homePageRecord = homeSlug
    ? allRecords.find(p => isPage(p) && p.slug === homeSlug && p.status === 'published')
    : undefined;
  const homeHidden = !!homePageRecord?.noindex;

  // Only ONE entry per record, whatever the locale — see the note on the blog
  // index below for the one place that is genuinely per-locale. Read here so
  // the home block and the blog block cannot drift apart.
  const siteLocales = locales();

  // Which locales have a home page of their own. Mirrors `index.astro`'s
  // resolution deliberately: a sitemap that lists a URL the route does not
  // serve distinctly is worse than one that lists too few.
  const localeHomes = siteLocales.filter((loc) => {
    if (loc === defaultLocale()) return true;
    // No designated page: the locale home is the theme's Home slot listing that
    // locale's articles — genuinely different content per locale.
    if (!homePageRecord) return true;
    // Designated page: only if it has a published translation in this locale.
    return allRecords.some(
      p => isPage(p)
        && p.status === 'published'
        && !p.noindex
        && p.translation_of === homePageRecord.id
        && recordLocale(p) === loc,
    );
  });

  // On a single-language install every list above is one entry and localePath
  // returns each path unchanged, so nothing about this output changes for the
  // shops that are not multilingual.
  const urls = discourage ? [] : [
    // The home page, once per locale that genuinely has one.
    //
    // This used to be a single entry, on the reasoning that every prefix served
    // the same document. That stopped being true when the home page became
    // locale-aware: `/de` now lists the German articles and renders the German
    // translation of a designated home Page when one exists, so it is a
    // different document and omitting it hid it from crawlers entirely.
    //
    // A locale is listed only when its home really differs — which is exactly
    // when `index.astro` resolves something for it. Where `home_page_slug`
    // names a record with no translation in that locale, the prefixed URL
    // serves the default-locale record and canonicalises back to `/`, so
    // listing it would advertise a URL that disowns itself.
    ...(homeHidden ? [] : localeHomes.map(loc => ({
      loc: `${origin}${localePath('/', loc)}`, changefreq: 'weekly', priority: '1.0',
    }))),
    // The BLOG INDEX is listed per locale, because its contents genuinely differ:
    // the archive is filtered by locale, so /de/blog and /blog are different
    // pages with different articles on them.
    ...siteLocales.map(loc => ({
      loc: `${origin}${localePath('/blog', loc)}`, changefreq: 'daily', priority: '0.9',
    })),
    // The built-in routes are NOT. /de/about and /about render the same page —
    // the chrome is translated, the content is one English document — so
    // listing both advertises duplicates and asks a crawler to choose between
    // two addresses for one thing. One entry, at the default locale, which is
    // also what the page's own canonical says.
    ...builtins.map(slug => ({
      loc: `${origin}/${slug}`, changefreq: 'monthly', priority: '0.5',
    })),
    ...routablePages.map(p => ({
      // localePath, not a bare origin + slug. A record carries the locale it
      // was written in, and the site SERVES it at a prefixed URL — /de/about,
      // not /about. Submitting the unprefixed form told search engines about a
      // URL that is not the one hreflang declares for that document, so the
      // sitemap and the alternates named different addresses for the same page
      // and neither signal could be trusted. Same defect in rss.xml.ts.
      loc: `${origin}${localePath(`/${p.slug}`, recordLocale(p))}`,
      lastmod: p.updated_at,
      changefreq: 'monthly',
      priority: '0.6',
    })),
    ...posts.map(p => ({
      loc: `${origin}${localePath(`/blog/${p.slug}`, recordLocale(p))}`,
      lastmod: p.updated_at,
      changefreq: 'weekly',
      priority: '0.7',
    })),
  ];

  const body =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls
      .map(u => {
        const parts = [
          `  <url>`,
          `    <loc>${xmlEscape(u.loc)}</loc>`,
          (u as any).lastmod ? `    <lastmod>${xmlEscape((u as any).lastmod)}</lastmod>` : '',
          `    <changefreq>${u.changefreq}</changefreq>`,
          `    <priority>${u.priority}</priority>`,
          `  </url>`,
        ];
        return parts.filter(Boolean).join('\n');
      })
      .join('\n') +
    `\n</urlset>\n`;

  // Crawlers fetch this far more often than it changes. Same helper as the
  // public API, so one env var tunes both — see lib/http-cache.ts.
  return withPublicCache(new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
  }), { request, locals });
};
