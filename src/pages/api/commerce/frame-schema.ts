import type { APIRoute } from 'astro';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { LocalDB } from '../../../lib/localdb';
import { ensurePluginsBootstrapped } from '../../../plugins';
import { pluginManager, PLUGIN_HOOKS } from '../../../lib/plugin-system';

/**
 * GET /api/commerce/frame-schema
 *
 * Frame geometry limits, face-measurement limits, the ID-1 card dimensions, and
 * the fit tolerance — as data, so a storefront can build its own size guide and
 * measurement UI without hard-coding a millimetre.
 *
 * Deliberately shaped like `/api/commerce/prescription-schema`, and public for
 * the same reasons: these are limits any customer discovers by submitting the
 * form, they say nothing about the shop, and a headless storefront fetches them
 * before anyone logs in. Publishing them removes the incentive to guess, and a
 * client that guesses the tolerance wrong builds a size guide that recommends
 * frames the product page then calls a poor fit.
 *
 * **The payload carries `pd_lab_grade_methods` on purpose.** A PD derived from
 * a photo is fine for choosing a frame and must never reach a lens order — 1–2mm
 * of PD error puts the optical centre off the pupil and the customer gets a
 * remake. A decoupled storefront that had to infer that rule would omit it, so
 * the rule travels with the schema.
 *
 * Gated on the optical module, like the prescription schema: an install without
 * it must look like a shop that never bought it.
 */
export const GET: APIRoute = async () => {
  await LocalDB.init();
  await ensurePluginsBootstrapped();

  // Core does not know what a frame measurement is. It asks whichever vertical
  // is installed and active; `null` back means none is, and 404 is then the
  // honest answer — an install without the module looks like one that never
  // had it.
  const schema = pluginManager.applyFilters(PLUGIN_HOOKS.COMMERCE_SCHEMA, null, { name: 'frame' });
  if (schema == null) return ApiResponseBuilder.notFound('Frame schema');

  return new Response(JSON.stringify(schema), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      // Frame geometry conventions change when eyewear manufacturing does,
      // i.e. never. Let a CDN hold it.
      'Cache-Control': 'public, max-age=3600',
      Vary: 'Accept-Encoding',
    },
  });
};

export const ALL: APIRoute = () =>
  ApiResponseBuilder.error(405, 'Method not allowed');
