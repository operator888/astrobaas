import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { canManageCatalog } from '../../../lib/auth';
import { getShopCurrency } from '../../../lib/commerce-service';
import { minorUnits } from '../../../lib/money-format';
import { toCsv } from '../../../lib/csv';
import { csvTemplateRows, CSV_TEMPLATE_COLUMNS } from '../../../lib/commerce/bulk-csv';

/**
 * GET /api/product-bulk/template — every product and variant with its current
 * values, as the CSV that POST /api/product-bulk/csv reads (catalogue staff).
 * Edit the cells you want to change, clear the rest or leave them — an
 * unchanged value changes nothing — and upload it back.
 */
export const GET: APIRoute = async ({ locals }) => {
  const session = locals.user;
  if (!session || !canManageCatalog(session.role)) return ApiResponseBuilder.forbidden('Your role cannot edit products');
  await LocalDB.init();
  const currency = await getShopCurrency();
  const csv = toCsv(CSV_TEMPLATE_COLUMNS, csvTemplateRows(await LocalDB.getProducts(), minorUnits(currency)));
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="products.csv"',
      'Cache-Control': 'no-store',
    },
  });
};
