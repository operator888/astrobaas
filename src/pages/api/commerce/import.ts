import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { importCatalogue } from '../../../lib/commerce-service';
import { recordAudit } from '../../../lib/audit';

/**
 * POST /api/commerce/import — bulk catalogue upsert (categories + products).
 *
 * Body: { categories?: [...], products?: [...], replace?: boolean }
 * Auth: admin/editor session, or a bearer key with the `products:write` scope
 * (the middleware maps /api/commerce/* onto the products resource).
 * Rows are matched by slug; bad rows are skipped and reported, not fatal.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  try {
    await LocalDB.init();
    const session = locals.user;
    if (!session || (session.role !== 'admin' && session.role !== 'editor')) {
      return ApiResponseBuilder.forbidden('Only admins and editors can import the catalogue');
    }
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return ApiResponseBuilder.badRequest('Invalid payload');
    }
    const categories = Array.isArray((body as any).categories) ? (body as any).categories : [];
    const products = Array.isArray((body as any).products) ? (body as any).products : [];
    if (categories.length > 1000 || products.length > 10000) {
      return ApiResponseBuilder.badRequest('Import too large (max 1000 categories / 10000 products)');
    }
    const replace = (body as any).replace === true;

    const result = await importCatalogue({ categories, products, replace });

    recordAudit('commerce.import', {
      actor: session.id,
      metadata: {
        replace,
        categories: result.categories,
        products: result.products,
        skipped: result.skipped,
      },
    });

    const message =
      `Imported ${result.categories.created + result.categories.updated} categories ` +
      `(${result.categories.created} new) and ` +
      `${result.products.created + result.products.updated} products ` +
      `(${result.products.created} new)` +
      (result.skipped > 0 ? `, skipped ${result.skipped}` : '');

    return ApiResponseBuilder.success(result, message);
  } catch (err) {
    console.error('Catalogue import error:', err);
    return ApiResponseBuilder.serverError('Catalogue import failed');
  }
};
