import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { validate, parsePaging } from '../../../lib/validate';
import { matchesSearch } from '../../../lib/text-search';
import { canReadCommerce, canWriteCommerce } from '../../../lib/auth';

/** GET /api/customers — staff only (PII). `?search=`, `?limit=` (default 50, max 200), `?offset=`. */
export const GET: APIRoute = async ({ url, locals }) => {
  try {
    await LocalDB.init();
    const session = locals.user;
    if (!session || !canReadCommerce(session.role)) {
      return ApiResponseBuilder.forbidden('Your role cannot list customers');
    }
    let customers = await LocalDB.getCustomers();
    // Customer names are the MOST likely place for accented text in a shop —
    // staff look people up by name far more than by email.
    const q = url.searchParams.get('search');
    if (q) {
      customers = customers.filter(c => matchesSearch([c.email, c.name, c.phone], q));
    }
    customers.sort((a, b) => b.created_at.localeCompare(a.created_at));
    // Paged exactly like GET /api/orders — same parser, defaults, ceiling and
    // meta. Before this the route ignored the limit/offset the typed client's
    // customers.list()/page() send and answered every customer, with no meta,
    // so page() reported one page holding the whole list. Callers that need
    // every customer in-process (admin screen, GDPR, importer) read
    // LocalDB.getCustomers() directly, never this route.
    const limit = parsePaging(url.searchParams.get('limit'), { fallback: 50, min: 1, max: 200 });
    const offset = parsePaging(url.searchParams.get('offset'), { fallback: 0, min: 0, max: 1_000_000 });
    const page = customers.slice(offset, offset + limit);
    return ApiResponseBuilder.success(page, undefined, {
      total: customers.length, count: page.length, limit, offset,
      page: Math.floor(offset / limit) + 1, hasMore: offset + page.length < customers.length,
    });
  } catch (err) {
    console.error('Customers list error:', err);
    return ApiResponseBuilder.serverError('Failed to list customers');
  }
};

/** POST /api/customers — create (staff). */
export const POST: APIRoute = async ({ request, locals }) => {
  try {
    await LocalDB.init();
    const session = locals.user;
    // WRITE, not read: a manager is read-only on customer records because they
    // are personal data. canWriteCommerce deliberately excludes manager.
    if (!session || !canWriteCommerce(session.role)) {
      return ApiResponseBuilder.forbidden('Your role cannot create customers');
    }
    const body = await request.json().catch(() => null);
    const result = validate<{ email: string; name?: string; phone?: string; address?: string; city?: string; postcode?: string; country?: string }>(body, {
      email: { type: 'string', min: 3, max: 200, pattern: /.+@.+\..+/ },
      name: { type: 'string', max: 200, optional: true },
      phone: { type: 'string', max: 40, optional: true },
      address: { type: 'string', max: 500, optional: true },
      city: { type: 'string', max: 120, optional: true },
      postcode: { type: 'string', max: 20, optional: true },
      country: { type: 'string', max: 60, optional: true },
    });
    if (!result.ok) return ApiResponseBuilder.validationError('Invalid customer payload', result.errors);
    if (await LocalDB.getCustomerByEmail(result.value.email)) {
      return ApiResponseBuilder.badRequest('A customer with that email already exists');
    }
    const customer = await LocalDB.createCustomer(result.value);
    return ApiResponseBuilder.created(customer, 'Customer created');
  } catch (err) {
    console.error('Customer create error:', err);
    return ApiResponseBuilder.serverError('Failed to create customer');
  }
};
