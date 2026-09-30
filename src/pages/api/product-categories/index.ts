import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { validate, slugify } from '../../../lib/validate';
import { canManageCatalog } from '../../../lib/auth';
import { normalizeCollectionRule } from '../../../lib/commerce/collections';
import { projectAll, TRANSLATABLE_TAXONOMY_FIELDS } from '../../../lib/i18n/catalogue-translations';
import { contentLocale } from '../../../lib/i18n/resolve';
import { withPublicCache } from '../../../lib/http-cache';
import { parentProblem } from '../../../lib/commerce/category-tree';
import { countProductsByCategory } from '../../../lib/commerce/category-counts';
import { recordAudit, AUDIT } from '../../../lib/audit';

/** GET /api/product-categories — public. Ordered by position, with counts. */
export const GET: APIRoute = async ({ url, request, locals }) => {
  try {
    await LocalDB.init();
    const [cats, products] = await Promise.all([
      LocalDB.getProductCategories(),
      LocalDB.getProducts(),
    ]);
    // One pass, by the membership the listing uses — see category-counts.ts.
    const { direct: counts, total: totals } = await countProductsByCategory(products, cats, () => LocalDB.getBrands());
    const countWithin = (slug: string): number => totals.get(slug) ?? 0;
    const data = cats
      .map((c) => ({
        id: c.id,
        name: c.name,
        slug: c.slug,
        parent_slug: c.parent_slug ?? null,
        position: c.position ?? 0,
        product_count: counts.get(c.slug) ?? 0,
        // Including every subcategory — the number a storefront menu wants
        // beside "Clothing", now that ?category=clothing includes the shirts.
        // `product_count` keeps its old meaning (tagged directly) so nothing
        // that already reads it changes.
        product_count_total: countWithin(c.slug),
        // Carried through explicitly. This response is REBUILT field by field
        // rather than spread, so a sidecar that is not named here is silently
        // dropped and every translation vanishes with it — the same
        // rebuild-drops-it hazard that applies to plugin filters.
        i18n: c.i18n,
      }));

    const locale = contentLocale(null, url.searchParams.get('locale'));
    // Project BEFORE sorting. Sorting first would order German categories by
    // their English names, which reads as an unsorted list to the only people
    // who can tell.
    const localised = projectAll(data, locale, TRANSLATABLE_TAXONOMY_FIELDS)
      .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name, locale));

    return withPublicCache(ApiResponseBuilder.success(localised), { request, locals });
  } catch (err) {
    console.error('Product categories list error:', err);
    return ApiResponseBuilder.serverError('Failed to list product categories');
  }
};

/** POST /api/product-categories — create (admin/editor). */
export const POST: APIRoute = async ({ request, locals }) => {
  try {
    await LocalDB.init();
    const session = locals.user;
    if (!session || !canManageCatalog(session.role)) {
      return ApiResponseBuilder.forbidden('Your role cannot manage product categories');
    }
    const body = await request.json().catch(() => null);
    const result = validate<{ name: string; slug?: string; parent_slug?: string }>(body, {
      name: { type: 'string', min: 1, max: 120 },
      slug: { type: 'string', min: 1, max: 120, pattern: /^[a-z0-9-]+$/, optional: true },
      parent_slug: { type: 'string', max: 120, optional: true },
    });
    if (!result.ok) return ApiResponseBuilder.validationError('Invalid category payload', result.errors);
    // `min: 1` counts spaces; a name of spaces is no name.
    if (!result.value.name.trim()) return ApiResponseBuilder.badRequest('A category needs a name');
    const slug = result.value.slug || slugify(result.value.name);
    const existing = await LocalDB.getProductCategories();
    if (existing.some(c => c.slug === slug)) {
      return ApiResponseBuilder.badRequest('A product category with that slug already exists');
    }
    // The parent must exist and the tree must stay shallow enough to browse.
    // It used to be any string at all, so a typo created a category whose
    // parent did not exist — invisible in every storefront menu built from
    // parent_slug, and shown by the admin only as an orphan at the top.
    const parent = result.value.parent_slug?.trim() || undefined;
    const problem = parentProblem(slug, parent, existing);
    if (problem) return ApiResponseBuilder.badRequest(problem);
    /*
     * The rule goes through its own normaliser rather than the `validate`
     * schema above — deny-by-default, rebuilt condition by condition, and a
     * condition naming a field the catalogue does not have is DROPPED. Left in,
     * it would silently never match, which reads as "the collection is broken"
     * long after the typo was made.
     */
    const rule = normalizeCollectionRule((body as { rule?: unknown })?.rule);
    const cat = await LocalDB.createProductCategory({
      name: result.value.name.trim(), slug, parent_slug: parent,
      ...(rule ? { rule, rule_mode: (body as { rule_mode?: string })?.rule_mode === 'only' ? 'only' as const : 'add' as const } : {}),
    });
    recordAudit(AUDIT.PRODUCT_CATEGORY_CREATE, {
      actor: session.id,
      target: cat.id,
      ip: locals.ip,
      metadata: { slug: cat.slug, name: cat.name, parent: parent ?? null },
    });
    return ApiResponseBuilder.created(cat, 'Product category created');
  } catch (err) {
    console.error('Product category create error:', err);
    return ApiResponseBuilder.serverError('Failed to create product category');
  }
};
