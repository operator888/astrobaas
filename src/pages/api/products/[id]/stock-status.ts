import type { APIRoute } from 'astro';
import { LocalDB } from '../../../../lib/localdb';
import { ApiResponseBuilder } from '../../../../lib/api-response';
import { settingsMap } from '../../../../lib/settings-map';
import { stockStatusResponse, resolveLowStockThreshold } from '../../../../lib/commerce/stock-status';
import { withPublicCache } from '../../../../lib/http-cache';
import { isGrouped, readGroup } from '../../../../lib/commerce/grouped';
import { loadGroupMembers } from '../../../../lib/commerce-service';

/**
 * `GET /api/products/{ref}/stock-status` — what to tell a shopper about
 * availability, for one product. Public; `ref` is an id or a slug, like
 * `GET /api/products/{ref}`.
 *
 * The same answer is already embedded as `stock_status` in every product the
 * catalogue returns. This route exists for the case where a storefront has a
 * product rendered and wants the CURRENT availability without re-fetching the
 * whole product — a product page that revalidates its badge, a cart line.
 *
 * Both are produced by `lib/commerce/stock-status.ts`; neither computes
 * anything of its own.
 *
 * ## Exposure
 *
 * `available_qty` is the number `GET /api/products/{ref}` already publishes as
 * `stock` and `variants[].stock`. This route adds no disclosure.
 *
 * ## Freshness
 *
 * Pull-based. Anonymous responses share the public read cache (30 s by default,
 * `PUBLIC_API_CACHE_SECONDS`), so a badge can lag an inventory change by that
 * long. Nothing here reserves stock: the answer can be stale by the time a
 * shopper clicks, and checkout re-checks atomically either way.
 */
export const prerender = false;

export const GET: APIRoute = async ({ params, request, locals }) => {
  try {
    await LocalDB.init();
    const key = String((params as { id?: string }).id ?? '');
    const product = (await LocalDB.getProduct(key)) ?? (await LocalDB.getProductBySlug(key));
    // Same visibility as the product route: only an active product exists to a
    // reader. A draft's stock level is not something to confirm to the public.
    if (!product || product.status !== 'active') return ApiResponseBuilder.notFound('Product');
    const threshold = resolveLowStockThreshold(settingsMap(await LocalDB.getSettings()));
    // A grouped product has no stock of its own: it is judged on the members a
    // shopper can see, and lists each one — the same answer its product read
    // embeds (lib/commerce/grouped.ts).
    if (isGrouped(product)) {
      const g = readGroup(product, await loadGroupMembers([product]), { publicOnly: true, defaultThreshold: threshold });
      return withPublicCache(ApiResponseBuilder.success({
        product_id: product.id,
        ...g.stock_status,
        members: g.members.map((m) => ({ id: m.id, ...m.stock_status })),
      }), { request, locals });
    }
    return withPublicCache(
      ApiResponseBuilder.success(stockStatusResponse(product, threshold)),
      { request, locals },
    );
  } catch (err) {
    console.error('Stock status error:', err);
    return ApiResponseBuilder.serverError('Failed to load stock status');
  }
};
