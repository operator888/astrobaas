import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { validate, slugify } from '../../../lib/validate';
import { canManageCatalog } from '../../../lib/auth';
import { normalizeCollectionRule } from '../../../lib/commerce/collections';
import { projectAll, TRANSLATABLE_TAXONOMY_FIELDS } from '../../../lib/i18n/catalogue-translations';
import { contentLocale } from '../../../lib/i18n/resolve';
import { withPublicCache } from '../../../lib/http-cache';

/** GET /api/product-categories — public. Ordered by position, with counts. */
export const GET: APIRoute = async ({ url, request, locals }) => {
  try {
    await LocalDB.init();
    const [cats, products] = await Promise.all([
      LocalDB.getProductCategories(),
      LocalDB.getProducts(),
    ]);
    const counts = new Map<string, number>();
    for (const p of products) {
      if (p.status !== 'active') continue;
      // A row written around saveProduct can lack `categories`; iterating
      // undefined turned the public category menu into a 500.
      for (const slug of p.categories ?? []) counts.set(slug, (counts.get(slug) ?? 0) + 1);
    }
    const data = cats
      .map((c) => ({
        id: c.id,
        name: c.name,
        slug: c.slug,
        parent_slug: c.parent_slug ?? null,
        position: c.position ?? 0,
        product_count: counts.get(c.slug) ?? 0,
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
    const slug = result.value.slug || slugify(result.value.name);
    const existing = await LocalDB.getProductCategories();
    if (existing.some(c => c.slug === slug)) {
      return ApiResponseBuilder.badRequest('A product category with that slug already exists');
    }
    /*
     * The rule goes through its own normaliser rather than the `validate`
     * schema above — deny-by-default, rebuilt condition by condition, and a
     * condition naming a field the catalogue does not have is DROPPED. Left in,
     * it would silently never match, which reads as "the collection is broken"
     * long after the typo was made.
     */
    const rule = normalizeCollectionRule((body as { rule?: unknown })?.rule);
    const cat = await LocalDB.createProductCategory({
      name: result.value.name, slug, parent_slug: result.value.parent_slug,
      ...(rule ? { rule, rule_mode: (body as { rule_mode?: string })?.rule_mode === 'only' ? 'only' as const : 'add' as const } : {}),
    });
    return ApiResponseBuilder.created(cat, 'Product category created');
  } catch (err) {
    console.error('Product category create error:', err);
    return ApiResponseBuilder.serverError('Failed to create product category');
  }
};
