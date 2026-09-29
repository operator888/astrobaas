import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { clipQuery, type TermExpander } from '../../../lib/search/rank';
import { suggest, parseTypes, SUGGEST_TYPES, MIN_QUERY, type SuggestType } from '../../../lib/search/suggest';
import { expanderFromSetting } from '../../../lib/search/expander';
import { settingsMap } from '../../../lib/settings-map';
import { pluginManager, PLUGIN_HOOKS } from '../../../lib/plugin-system';
import { filterByLocale } from '../../../lib/i18n';
import { withPublicCache } from '../../../lib/http-cache';
import { resolveCommerceEnabled } from '../../../lib/commerce-settings';
import { countProductsByCategory } from '../../../lib/commerce/category-counts';

/**
 * GET /api/search/suggest?q=&types=&limit=&locale= — public.
 *
 * What a search box offers while someone is still typing: a few posts, pages,
 * products and categories whose titles match. The rules — who sees what, and
 * why there is no typo tolerance here — are in lib/search/suggest.ts.
 *
 * `types` narrows the answer (`?types=products,categories` for a shop's box);
 * the default is everything the site has. Products and categories are offered
 * only while the shop is switched on.
 *
 * Cached like search: a suggestion list is the most repeated request a public
 * site gets, and each one is a ranking pass.
 */
export const GET: APIRoute = async ({ url, request, locals }) => {
  try {
    const sp = url.searchParams;
    const q = clipQuery(sp.get('q') || '');
    const empty = { posts: [], pages: [], products: [], categories: [] };
    if (q.trim().length < MIN_QUERY) {
      return withPublicCache(ApiResponseBuilder.success(empty, 'Query too short', { q }), { request, locals });
    }

    await LocalDB.init();
    const settings = settingsMap(await LocalDB.getSettings());
    const shop = resolveCommerceEnabled(settings);
    const allowed: SuggestType[] = shop ? [...SUGGEST_TYPES] : ['posts', 'pages'];
    const types = parseTypes(sp.get('types'), allowed);
    const limit = Number(sp.get('limit') ?? 5);

    const expand = pluginManager.applyFilters(
      PLUGIN_HOOKS.SEARCH_EXPAND,
      expanderFromSetting(settings.search_synonyms),
      { query: q, settings },
    ) as TermExpander | null;

    const locale = sp.get('locale');
    const wantPosts = types.includes('posts') || types.includes('pages');
    const wantShop = types.includes('products') || types.includes('categories');
    const posts = wantPosts ? await LocalDB.getPosts() : [];
    const [products, categories] = wantShop
      ? await Promise.all([LocalDB.getProducts(), LocalDB.getProductCategories()])
      : [[], []];
    const counts = types.includes('categories')
      ? (await countProductsByCategory(products, categories, () => LocalDB.getBrands())).total
      : undefined;

    const data = suggest({
      q,
      types,
      limit,
      posts: locale ? filterByLocale(posts, locale) : posts,
      products,
      categories,
      categoryCounts: counts,
      expand: expand ?? undefined,
    });
    return withPublicCache(ApiResponseBuilder.success(data, 'Suggestions', { q, types }), { request, locals });
  } catch (err) {
    console.error('Suggest error:', err);
    return ApiResponseBuilder.serverError('Suggestions failed');
  }
};
