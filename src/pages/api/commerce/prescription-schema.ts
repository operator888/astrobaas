import type { APIRoute } from 'astro';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { LocalDB } from '../../../lib/localdb';
import { ensurePluginsBootstrapped } from '../../../plugins';
import { pluginManager, PLUGIN_HOOKS } from '../../../lib/plugin-system';

/**
 * GET /api/commerce/prescription-schema
 *
 * The clinical rules, as data, so a storefront can render and pre-validate the
 * Rx form without hard-coding a single dioptre range.
 *
 * Public and unauthenticated on purpose: these are the same limits any customer
 * discovers by submitting the form, they contain nothing about the shop, and a
 * headless storefront fetches them before anyone has logged in. Publishing them
 * also removes the incentive to guess — a client that guesses the grid wrong
 * builds a form that rejects valid prescriptions.
 *
 * The server re-validates everything regardless. This is a convenience for the
 * client, never the enforcement point.
 */
export const GET: APIRoute = async ({ url }) => {
  await LocalDB.init();
  await ensurePluginsBootstrapped();

  // Deny-by-default: anything that is not exactly "contacts" is spectacles.
  const type = url.searchParams.get('type') === 'contacts' ? 'contacts' : 'spectacles';

  // Core does not know what a dioptre is. It asks whichever vertical is
  // installed and active; `null` back means none is, and 404 is then the honest
  // answer — publishing a clinical schema the checkout will not enforce
  // advertises a capability that does not exist.
  const schema = pluginManager.applyFilters(
    PLUGIN_HOOKS.COMMERCE_SCHEMA, null, { name: 'prescription', variant: type },
  );
  if (schema == null) return ApiResponseBuilder.notFound('Prescription schema');
  const body = JSON.stringify(schema);
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      // Rules change when optometry does, i.e. never. Let a CDN hold it.
      'Cache-Control': 'public, max-age=3600',
      Vary: 'Accept-Encoding',
    },
  });
};

export const ALL: APIRoute = () =>
  ApiResponseBuilder.error(405, 'Method not allowed');
