import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { fetchRegistryIndex, fetchRegistryManifest, registryEnabled, registryUrl } from '../../../lib/registry';

/**
 * Browse the curated plugin registry (admin-only).
 *
 * GET  /api/plugins/registry            → the index
 * GET  /api/plugins/registry?id=<id>    → one entry's manifest, checksum-verified
 *
 * Installing is a separate, explicit POST to /api/plugins/install — this route
 * never installs anything, so browsing can never be a side-effect.
 */
export const GET: APIRoute = async ({ url, locals }) => {
  try {
    await LocalDB.init();
    const session = locals.user;
    if (!session || session.role !== 'admin') return ApiResponseBuilder.forbidden('Admin only');

    if (!registryEnabled()) {
      return ApiResponseBuilder.badRequest('Plugin registry is disabled (PLUGIN_REGISTRY_DISABLED=1).');
    }

    const wanted = new URL(url).searchParams.get('id');

    let index;
    try {
      index = await fetchRegistryIndex();
    } catch (err) {
      // A registry outage must read as "unavailable", not as a server bug.
      return ApiResponseBuilder.badRequest(
        `Could not read the plugin registry: ${err instanceof Error ? err.message : 'unavailable'}`,
      );
    }

    if (!wanted) {
      return ApiResponseBuilder.success(
        { registry: registryUrl(), name: index.name ?? null, plugins: index.plugins },
        'Registry index retrieved',
      );
    }

    const entry = index.plugins.find((p) => p.id === wanted);
    if (!entry) return ApiResponseBuilder.notFound('Registry entry');

    try {
      const manifest = await fetchRegistryManifest(entry);
      return ApiResponseBuilder.success({ entry, manifest }, 'Manifest retrieved and checksum-verified');
    } catch (err) {
      return ApiResponseBuilder.badRequest(err instanceof Error ? err.message : 'Could not fetch manifest');
    }
  } catch (err) {
    console.error('Plugin registry error:', err);
    return ApiResponseBuilder.serverError('Failed to read the plugin registry');
  }
};
