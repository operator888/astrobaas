import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { validate, slugify } from '../../../lib/validate';
import { getOrderLimits, listProducts, saveProduct, getProductFieldDefs } from '../../../lib/commerce-service';
import {
  pickWritableProductFields, projectProductForReader, withMediaKind, buildMediaKindIndex,
} from '../../../lib/product-fields';
import { canManageCatalog } from '../../../lib/auth';
import { mediaBaseFor } from '../../../lib/media-base';
import { projectAll, TRANSLATABLE_PRODUCT_FIELDS } from '../../../lib/i18n/catalogue-translations';
import { contentLocale } from '../../../lib/i18n/resolve';
import { withProductEmbeds } from '../../../lib/embeds';
import { withOmnibusReference } from '../../../lib/commerce/price-history';
import { withPublicCache } from '../../../lib/http-cache';

/** GET /api/products — public product listing with filters + pagination. */
export const GET: APIRoute = async ({ url, locals, request }) => {
  try {
    await LocalDB.init();
    const q = url.searchParams;
    // Staff see unpublished/out-of-stock rows the storefront must not.
    const isStaff = !!locals.user && canManageCatalog(locals.user.role);
    // Definitions decide what is public. Read once per request, not per product.
    const productFieldDefs = await getProductFieldDefs();
    // ONE media index for the whole response, not a lookup per gallery entry.
    const mediaIndex = buildMediaKindIndex(await LocalDB.getMedia());
    const { products, meta } = await listProducts({
      category: q.get('category') ?? undefined,
      brand: q.get('brand') ?? undefined,
      search: q.get('search') ?? undefined,
      onSale: q.get('on_sale') === 'true',
      featured: q.get('featured') === 'true',
      includeInactive: Boolean(isStaff && q.get('all') === 'true'),
      limit: Number(q.get('limit') ?? 24),
      offset: Number(q.get('offset') ?? 0),
    });
    // Publish the order limits alongside the catalogue so a storefront can
    // render a quantity selector that matches what checkout will actually
    // accept, instead of discovering the cap by getting a 400.
    const limits = await getOrderLimits();
    // Project per-locale text down into the scalar fields.
    //
    // With NO ?locale= this is a no-op that only strips the `i18n` sidecar, so
    // the response is byte-identical to what both live storefronts already
    // parse. With one, the same SHAPE comes back with different text — which is
    // what lets this ship without either Next.js app changing a line. Returning
    // `name` as {en, de} instead would render [object Object] in both, today.
    const localised = projectAll(
      products,
      contentLocale(null, q.get('locale')),
      TRANSLATABLE_PRODUCT_FIELDS,
    );
    // Embed facades (C-44). Applied on READ, like the post routes, because
    // what is STORED is an inert placeholder — see lib/embeds.ts. Both product
    // routes go through the same helper so they cannot drift.
    // Same helper as the single-product route, so a card in a grid and the
    // product page it links to cannot show different "was" prices.
    // Shared-cache headers for anonymous callers only — staff see drafts and
    // staff-only fields here, so their copy is `private, no-store`. See
    // lib/http-cache.ts.
    return withPublicCache(ApiResponseBuilder.success(
      localised.map((p) => withMediaKind(projectProductForReader(
        withOmnibusReference(withProductEmbeds(p)), productFieldDefs, isStaff,
      ), mediaIndex)), undefined, {
      ...meta,
      max_qty_per_product: limits.maxQtyPerProduct,
      max_items_per_order: limits.maxItemsPerOrder,
      // `images[].src` is a path relative to THIS CMS, and on a headless install
      // the storefront is a different host. Publishing the base it resolves
      // against is what stops a storefront joining it to its own origin, finding
      // nothing, and rendering a broken product — see lib/media-url.ts.
      //
      // The paths themselves are unchanged: an imported catalogue's already
      // absolute srcs must be left alone, so the join is the client's to make
      // with the guard in absoluteMediaUrl.
      media_base: await mediaBaseFor(request),
    }), { request, locals });
  } catch (err) {
    console.error('Products list error:', err);
    return ApiResponseBuilder.serverError('Failed to list products');
  }
};

/** POST /api/products — create (admin/editor). */
export const POST: APIRoute = async ({ request, locals }) => {
  try {
    await LocalDB.init();
    const session = locals.user;
    if (!session || !canManageCatalog(session.role)) {
      return ApiResponseBuilder.forbidden('Your role cannot manage products');
    }
    const body = await request.json().catch(() => null);
    const result = validate<Record<string, unknown>>(body, {
      name: { type: 'string', min: 1, max: 300 },
      slug: { type: 'string', min: 1, max: 200, pattern: /^[a-z0-9-]+$/, optional: true },
      sku: { type: 'string', max: 64, optional: true },
      description: { type: 'string', max: 20000, optional: true },
      short_description: { type: 'string', max: 2000, optional: true },
      price_cents: { type: 'number', min: 0 },
      regular_price_cents: { type: 'number', min: 0, optional: true },
      sale_price_cents: { type: 'number', min: 0, optional: true },
      stock: { type: 'number', min: 0, optional: true },
      // `on_sale` and `in_stock` are NOT accepted here. They used to be, which
      // made this route disagree with PUT (which never accepted them) and with
      // the allow-list in product-fields.ts that calls them server-owned. A
      // client could create a full-price product flagged as discounted — a
      // false advertised saving, which is a consumer-law problem before it is a
      // data problem. saveProduct derives both now, and would override a
      // client value anyway; dropping them from the schema is the honest
      // version of that.
      brand: { type: 'string', max: 120, optional: true },
      status: { type: 'enum', values: ['active', 'draft', 'archived'], optional: true },
    });
    if (!result.ok) return ApiResponseBuilder.validationError('Invalid product payload', result.errors);
    const v = result.value as any;
    // Everything else comes through the SHARED allow-list, so create and update
    // accept exactly the same field set. saveProduct normalises the non-scalar
    // ones (images, attributes, downloads, dimensions…) for every writer.
    const extra = pickWritableProductFields(body);
    const categories = Array.isArray((body as any)?.categories)
      ? (body as any).categories.filter((c: unknown) => typeof c === 'string').slice(0, 20)
      : [];
    const saved = await saveProduct({
      ...extra,
      ...v,
      slug: v.slug || slugify(v.name),
      categories,
    }, undefined, session.id);
    if (!saved.ok) return ApiResponseBuilder.error(saved.status, saved.message);
    return ApiResponseBuilder.created(saved.value, 'Product created');
  } catch (err) {
    console.error('Product create error:', err);
    return ApiResponseBuilder.serverError('Failed to create product');
  }
};
