import type { APIRoute } from 'astro';
import { LocalDB } from '../../lib/localdb';
import { ApiResponseBuilder } from '../../lib/api-response';
import { rankBy, POST_WEIGHTS, clipQuery } from '../../lib/search/rank';
import { comparePostsForListing } from '../../core/post-query';
import { plainText } from '../../lib/html-text';
import { expanderFromSetting } from '../../lib/search/expander';
import { settingsMap } from '../../lib/settings-map';
import { pluginManager, PLUGIN_HOOKS } from '../../lib/plugin-system';
import type { TermExpander } from '../../lib/search/rank';
import { articlesOnly } from '../../lib/post-kind';
import { filterByLocale } from '../../lib/i18n';
import { withPublicCache } from '../../lib/http-cache';

/**
 * Site search over published posts.
 *
 * Relevance lives in `lib/search/rank.ts`, not here, because product search
 * needs the same answer to the same question. The previous version scored
 * `title ? 3 : 0` plus `body ? 1 : 0` over a bare `String.includes`, which
 * meant a shopper typing the words in the other order got nothing at all, and
 * a page repeating a word out-ranked the page titled with it.
 *
 * Results are sorted newest-first BEFORE ranking. Ranking is stable, so two
 * equally-relevant posts come back with the newer one first rather than in
 * whatever order storage happened to hold them — a difference a reader notices
 * and no score can express.
 */
export const GET: APIRoute = async ({ url, request, locals }) => {
  try {
    await LocalDB.init();
    // Clipped at the door as well as inside the scorer. rank.ts bounds the WORK
    // for every caller; this bounds what the route hands on — to the plugin
    // hook's context and back to the client in `meta.q`. Echoing an unclipped
    // query would return the payload of an amplification attempt verbatim, and
    // `meta.q` now tells a client truthfully what was searched.
    const q = clipQuery(new URL(url).searchParams.get('q') || '');
    if (q.trim().length < 2) {
      return withPublicCache(
        ApiResponseBuilder.success([], 'Query too short', { q, count: 0 }),
        { request, locals },
      );
    }

    // articlesOnly + !noindex, matching /blog exactly. This endpoint returned
    // Pages (the privacy policy answering a search for "privacy") and posts an
    // author had hidden — every other surface excludes both, and the response
    // strips `kind` so a client could not filter them out either.
    // `?locale=` is OPT-IN, and absent means every language. A headless
    // storefront asks for the language its reader is on; a site-wide search box
    // asks for everything. Defaulting to one locale would silently hide half a
    // bilingual shop's articles from any client that had not read this file.
    const locale = new URL(url).searchParams.get('locale');
    const posts = await LocalDB.getPosts();
    const articles = articlesOnly(posts);
    const published = (locale ? filterByLocale(articles, locale) : articles)
      .filter((p) => p.status === 'published' && !p.noindex)
      // The SAME comparator the archive uses. rankBy is stable, so this decides
      // the order of equally-relevant results — and the archive's own comment
      // says the two surfaces must not answer one query differently. A pin is
      // the editor's stated priority; it breaks a relevance TIE, it never
      // outranks relevance.
      .sort((a, b) => comparePostsForListing(a, b));

    // The expander seam, which POST search never consulted — it had exactly one
    // consumer, product search, so a shop's synonyms worked in the catalogue
    // and not in the blog. Core fills it with the operator's synonym table; the
    // paid module's index-based expansion arrives through the same hook.
    const settingsRows = await LocalDB.getSettings();
    const expand = pluginManager.applyFilters(
      PLUGIN_HOOKS.SEARCH_EXPAND,
      expanderFromSetting(settingsMap(settingsRows).search_synonyms),
      { query: q, settings: settingsMap(settingsRows) },
    ) as TermExpander | null;

    const matches = rankBy(
      published,
      q,
      (p) => [
        { text: p.title, weight: POST_WEIGHTS.title },
        { text: p.excerpt, weight: POST_WEIGHTS.excerpt },
        // Tags are stripped rather than searched: a query would otherwise match
        // the markup ("div", "href") instead of anything the author wrote.
        // plainText, not a local strip: this is the sixth place that wanted one
        // and the shared implementation is the only one that treats a tag
        // boundary as a word boundary.
        { text: plainText(p.content), weight: POST_WEIGHTS.body },
      ],
      { expand: expand ?? undefined },
    )
      .slice(0, 20)
      .map((r) => ({
        id: r.item.id,
        title: r.item.title,
        slug: r.item.slug,
        excerpt: r.item.excerpt ?? '',
        created_at: r.item.created_at,
      }));

    // Shared-cache headers for anonymous callers — see lib/http-cache.ts. A
    // search is the most repeated GET a storefront makes, and each one is a
    // full ranking pass over the blog.
    return withPublicCache(
      ApiResponseBuilder.success(matches, 'Search complete', { q, count: matches.length }),
      { request, locals },
    );
  } catch (err) {
    console.error('Search error:', err);
    return ApiResponseBuilder.serverError('Search failed');
  }
};
