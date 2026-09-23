import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { saveProduct, removeProduct, getProductFieldDefs } from '../../../lib/commerce-service';
import {
  pickWritableProductFields, projectProductForReader, withMediaKind, buildMediaKindIndex, readStockBases,
} from '../../../lib/product-fields';
import { canManageCatalog, canDeleteProducts } from '../../../lib/auth';
import { projectTranslations, TRANSLATABLE_PRODUCT_FIELDS } from '../../../lib/i18n/catalogue-translations';
import { contentLocale } from '../../../lib/i18n/resolve';
import { productNode, structuredData } from '../../../lib/structured-data';
import { mediaBaseFor } from '../../../lib/media-base';
import { resolveSiteUrl } from '../../../lib/site-url';
import { REVIEWS_TYPE, summariseRatings } from '../../../core/builtin-collections';
import { isPubliclyVisible } from '../../../core/moderation';
import { withProductEmbeds } from '../../../lib/embeds';
import { resolveShopCurrency } from '../../../lib/commerce-settings';
import { withOmnibusReference } from '../../../lib/commerce/price-history';
import { withPublicCache } from '../../../lib/http-cache';

/** GET /api/products/[id] — public; accepts an id or a slug. */
export const GET: APIRoute = async ({ params, url, request, locals }) => {
  try {
    await LocalDB.init();
    const key = params.id!;
    const product = (await LocalDB.getProduct(key)) ?? (await LocalDB.getProductBySlug(key));
    /*
     * This route had no staff notion at all, and it needs one now.
     *
     * The admin edit dialog LOADS a product through here and saves what it
     * loaded. Stripping the merchant's staff-only fields for every caller would
     * mean the form fetched a stripped bag and wrote the stripping back over
     * the product — a data-loss bug of exactly the shape the e2e regression
     * guard for variants and images was written after.
     */
    const isStaff = !!locals.user && canManageCatalog(locals.user.role);
    if (!product || product.status !== 'active') return ApiResponseBuilder.notFound('Product');
    // The SLUG stays global and untranslated: it is a lookup key here, not a
    // URL. Both storefronts mint their own URLs, and nothing in this repo
    // renders a product page — so per-locale slugs would buy nothing today and
    // cost a new uniqueness scope, a resolution rule for two locales
    // disagreeing, and a change to the importer. Purely additive later.
    const view = projectTranslations(
      product,
      contentLocale(null, url.searchParams.get('locale')),
      TRANSLATABLE_PRODUCT_FIELDS,
    );

    // The storefront renders the product page, so the storefront needs the
    // schema.org Product — and price and availability are exactly the two
    // fields Google validates and the two a storefront gets wrong when it
    // reimplements them. Money is integer cents in this API and a decimal
    // string in schema.org; that conversion happens here, once, rather than
    // in every consumer.
    //
    // `url` is deliberately absent: only the storefront knows its own product
    // URL. A consumer adds it, or omits it — an absent url is valid, an
    // invented one is not.
    const settings = await LocalDB.getSettings();
    const map: Record<string, unknown> = {};
    for (const row of settings) map[row.key] = row.value;
    // Approved reviews for this product (C-35), for the aggregate rating.
    //
    // Only APPROVED ones, and only when the collection is registered at all —
    // `getCustomEntities` on an unknown type returns nothing, so an install
    // with reviews switched off costs one empty read and emits no rating node.
    //
    // Emitting `aggregateRating` asks Google to show STARS against this shop's
    // name, so the number has to be one the shop can stand behind.
    const ratings = await (async () => {
      try {
        const rows = await LocalDB.getCustomEntities(REVIEWS_TYPE) as { data?: Record<string, unknown> }[];
        return summariseRatings(rows.filter(
          (r) => String(r.data?.product_id ?? '') === String(view.id) && isPubliclyVisible(r.data),
        ));
      } catch {
        return { count: 0, average: null, histogram: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } };
      }
    })();

    const jsonld = structuredData([productNode({
      name: view.name,
      description: view.description,
      sku: view.sku,
      gtin: (view as { gtin?: string }).gtin,
      brand: typeof view.brand === 'string' ? view.brand : (view.brand as { name?: string } | undefined)?.name,
      // ProductImage[] here, plain URLs in schema.org — and PHOTOGRAPHS only.
      //
      // schema.org/Product `image` is an ImageObject or a URL to one, and this
      // node is what Google reads to decide whether to show this product in
      // results. Putting an mp4 in it is a structured-data error on a public
      // surface that nobody would see until search stopped rendering the
      // product. Video belongs in `video` as a VideoObject, which Google
      // requires a name, description, thumbnailUrl and uploadDate for — a
      // thumbnail this CMS does not generate for video. Emitting the property
      // half-filled would be worse than omitting it, and inventing the missing
      // fields is not on the table, so video is left out of the node until
      // there is something true to say.
      // The filter now lives INSIDE productNode, so every caller gets it —
      // themes and plugins included, not just this route.
      images: (view.images ?? []).map((i) => i.src),
      priceCents: view.price_cents,
      // The shop's currency. The field existed on the node's input type and
      // NOTHING EVER PASSED IT, so `p.currency || 'EUR'` made every install
      // publish euro prices in its product schema — a field Google reads and
      // shows in results. A write-only interface, the same shape as the
      // PrintButton label before it was wired.
      currency: resolveShopCurrency(map),
      inStock: view.in_stock,
      status: view.status,
      ratingCount: ratings.count,
      ratingAverage: ratings.average,
    }, {
      origin: resolveSiteUrl({ setting: map.site_url, requestUrl: url }),
      mediaBase: await mediaBaseFor(request),
    })]);
    // Wrapped, not bare: a storefront embeds this straight into a
    // <script type="application/ld+json">, and a node without @context is a
    // graph fragment that every validator ignores. Shipping something that
    // looks embeddable but is not is worse than shipping nothing.

    // The summary travels in the envelope too, so a storefront rendering its
    // own star widget does not have to fetch and count the reviews itself.
    // Same helper as the list route (C-44).
    // The Omnibus reference travels with the product, computed here rather
    // than left to the storefront — see `withOmnibusReference` for why the
    // calculation is the half worth exposing.
    // Anonymous copies are shareable; the staff copy (the admin edit dialog
    // loads through here, with staff-only fields) is `private, no-store`.
    return withPublicCache(ApiResponseBuilder.success(
      withMediaKind(
        projectProductForReader(
          withOmnibusReference(withProductEmbeds(view)),
          await getProductFieldDefs(),
          isStaff,
        ),
        buildMediaKindIndex(await LocalDB.getMedia()),
      ),
      undefined, {
        jsonld,
        ratings,
        /*
         * `media_base` was in the LIST meta and not here.
         *
         * It matters more for video than it ever did for a photo: a storefront
         * rendering `<video src="/uploads/…">` has no image proxy to absorb a
         * relative path the way next/image did, so an unresolvable src is a
         * player that shows nothing.
         */
        media_base: await mediaBaseFor(request),
      }), { request, locals });
  } catch (err) {
    console.error('Product get error:', err);
    return ApiResponseBuilder.serverError('Failed to load product');
  }
};

/** PUT /api/products/[id] — update (admin/editor). */
export const PUT: APIRoute = async ({ params, request, locals }) => {
  try {
    await LocalDB.init();
    const session = locals.user;
    if (!session || !canManageCatalog(session.role)) {
      return ApiResponseBuilder.forbidden('Your role cannot manage products');
    }
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') return ApiResponseBuilder.badRequest('Invalid payload');
    // The counts the client LOADED, beside the ones it sends. Read from the
    // RAW body and before the allow-list, which drops `stock_base` along with
    // every other key it does not store — read after it, this would always be
    // empty and a stale editor save would hand sold stock back again. A client
    // that sends no base is saved exactly as before. See readStockBases.
    const bases = readStockBases(body);
    // Whitelist updatable fields; ignore everything else.
    // Shared allow-list — see product-fields.ts. `on_sale`/`in_stock` are
    // derived server-side and deliberately not accepted from a client.
    const updates = pickWritableProductFields(body);
    const saved = await saveProduct(updates, params.id!, session.id, bases);
    if (!saved.ok) return ApiResponseBuilder.error(saved.status, saved.message);
    return ApiResponseBuilder.success(saved.value, 'Product updated');
  } catch (err) {
    console.error('Product update error:', err);
    return ApiResponseBuilder.serverError('Failed to update product');
  }
};

/** DELETE /api/products/[id] — delete (admin only). */
export const DELETE: APIRoute = async ({ params, locals }) => {
  try {
    await LocalDB.init();
    const session = locals.user;
    if (!session || !canDeleteProducts(session.role)) {
      return ApiResponseBuilder.forbidden('Your role cannot delete products');
    }
    const res = await removeProduct(params.id!, session.id);
    if (!res.ok) return ApiResponseBuilder.notFound('Product');
    return ApiResponseBuilder.deleted('Product deleted');
  } catch (err) {
    console.error('Product delete error:', err);
    return ApiResponseBuilder.serverError('Failed to delete product');
  }
};
