import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { suggestForPath } from '../../../lib/legacy/suggest';

/**
 * GET /api/recovery/match?path=... — what might this dead URL have meant?
 *
 * PUBLIC, because a storefront renders its own recovery page for a visitor who
 * is not logged in and never will be. It exposes only what the catalogue
 * already publishes: active product and category names, slugs and URLs.
 *
 * ## An empty result is a real answer
 *
 * A shopper shown three random products trusts the shop less than one shown a
 * search box and an honest "we could not find that page". So a weak match is
 * dropped rather than padded, and `results: []` is returned without apology.
 *
 * ## This endpoint never decides the STATUS of the page that calls it
 *
 * It answers 200 because the lookup succeeded. The recovery PAGE must still
 * return 404 — see src/pages/404.astro. Helpful content and an error status
 * coexist, and conflating them is how a shop earns soft-404 penalties it can
 * least afford.
 */
export const prerender = false;

export const GET: APIRoute = async ({ url }) => {
  try {
    await LocalDB.init();
    const path = String(url.searchParams.get('path') ?? '').trim();
    if (!path) return ApiResponseBuilder.badRequest('path is required');

    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 8) || 8, 1), 24);

    // Same helper the storefront 404 page uses, so the two can never drift into
    // suggesting different things for the same URL.
    const { tokens, latin, results } = await suggestForPath(path, limit);

    return ApiResponseBuilder.success(results, undefined, {
      path,
      // What the URL was read as, in both scripts. Lets a storefront explain
      // the suggestions, and lets an operator see why a Greek path did or did
      // not find a Latin slug.
      tokens,
      latin,
      count: results.length,
    });
  } catch (err) {
    console.error('Recovery match error:', err);
    return ApiResponseBuilder.serverError('Failed to match the path');
  }
};
