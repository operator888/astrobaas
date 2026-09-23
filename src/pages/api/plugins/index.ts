import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { pluginManager } from '../../../lib/plugin-system';
import { ensurePluginsBootstrapped } from '../../../plugins';
import { isDeclarativeRecord } from '../../../lib/manifest-runtime';

// Admin-only list of bundled plugins merged with their persisted state.
export const GET: APIRoute = async ({ locals }) => {
  try {
    await LocalDB.init();
    await ensurePluginsBootstrapped();
    const session = locals.user;
    if (!session || session.role !== 'admin') return ApiResponseBuilder.forbidden('Admin only');

    const records = await LocalDB.getPlugins();
    const byId = new Map(records.map(r => [r.id, r]));
    const plugins = pluginManager.getPlugins().map(p => {
      const rec = byId.get(p.id);
      const declarative = isDeclarativeRecord(rec?.settings);
      return {
        id: p.id,
        name: p.name,
        version: p.version,
        description: p.description,
        author: p.author,
        active: rec?.active ?? false,
        /** "bundled" = compiled in; "declarative" = installed at runtime. */
        kind: declarative ? 'declarative' : 'bundled',
        /** Declarative plugins can be uninstalled; bundled ones cannot. */
        removable: declarative,
        source: declarative ? (rec!.settings as any).source ?? 'upload' : undefined,
        capabilities: declarative ? Object.keys((rec!.settings as any).manifest?.capabilities ?? {}) : undefined,
        hooks: [
          ...Object.keys(p.filters ?? {}).map(h => ({ type: 'filter', name: h })),
          ...Object.keys(p.actions ?? {}).map(h => ({ type: 'action', name: h })),
        ],
      };
    });
    return ApiResponseBuilder.success(plugins, 'Plugins retrieved successfully');
  } catch (err) {
    console.error('Plugins list error:', err);
    return ApiResponseBuilder.serverError('Failed to fetch plugins');
  }
};
