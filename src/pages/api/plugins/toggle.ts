import type { APIRoute } from 'astro';
import { reloadPlugins, ensurePluginsBootstrapped } from '../../../plugins';
import { syncPluginWebhooks } from '../../../lib/manifest-runtime';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { validate } from '../../../lib/validate';
import { pluginManager } from '../../../lib/plugin-system';
import {
  collectInstalledPlugins, unmetDependencies, activeDependentsOf, blockedByDependentsMessage,
} from '../../../lib/plugin-dependencies';

// Admin-only. Activates/deactivates a plugin, persisting the choice (survives
// restart via bootstrap) and updating the live manager immediately.
export const POST: APIRoute = async ({ request, locals }) => {
  try {
    await LocalDB.init();
    await ensurePluginsBootstrapped();
    const session = locals.user;
    if (!session || session.role !== 'admin') return ApiResponseBuilder.forbidden('Admin only');

    const body = await request.json().catch(() => null);
    const result = validate<{ id: string; active: boolean }>(body, {
      id: { type: 'id' },
      active: { type: 'boolean' },
    });
    if (!result.ok) return ApiResponseBuilder.validationError('Invalid payload', result.errors);

    const { id, active } = result.value;
    const target = pluginManager.getPlugins().find(p => p.id === id);
    if (!target) return ApiResponseBuilder.notFound('Plugin');

    const installed = await collectInstalledPlugins();

    if (active) {
      // Activation is the moment a plugin starts contributing content types,
      // sections and webhooks, so it is the moment its assumptions must hold.
      // Letting it through with a missing dependency produces a plugin that is
      // "on" and quietly broken, which surfaces somewhere else entirely.
      const self = installed.find(p => p.id === id);
      const unmet = unmetDependencies(self?.dependencies, installed);
      if (unmet.length) {
        return ApiResponseBuilder.badRequest(
          `Cannot activate "${target.name}": it ${unmet.map(u => u.message).join('; ')}.`,
          { dependencies: unmet },
        );
      }
    } else {
      // Turning off something another running plugin depends on breaks the
      // dependent with no error at the point of the change.
      const blockers = activeDependentsOf(id, installed);
      if (blockers.length) {
        return ApiResponseBuilder.badRequest(
          blockedByDependentsMessage(target.name, blockers, 'deactivate'),
          { dependents: blockers },
        );
      }
    }

    await LocalDB.setPluginActive(id, active);
    if (active) pluginManager.activatePlugin(id);
    else pluginManager.deactivatePlugin(id);

    // Rebuild from the persisted records.
    //
    // activatePlugin/deactivatePlugin only touch PluginManager state, which
    // owns css and headTags — those revoked correctly. Content types live in a
    // separate registry (src/core/content-types.ts) that has no unregister, and
    // manifest-backed plugins define no deactivate(), so a deactivated plugin's
    // collections stayed queryable and WRITEABLE until the next restart.
    //
    // Bootstrap already implements the right semantics (it registers types only
    // for active plugins), so the fix is to run it again rather than invent a
    // second teardown path that can drift from it.
    await reloadPlugins();

    // Plugin-declared webhooks were bound to INSTALL, not activation, so they
    // kept delivering site content to a third-party URL from a plugin the
    // operator had switched off — and fired even from a plugin that was never
    // activated at all.
    await syncPluginWebhooks(id, active);

    return ApiResponseBuilder.success({ id, active }, `Plugin ${active ? 'activated' : 'deactivated'}`);
  } catch (err) {
    console.error('Plugin toggle error:', err);
    return ApiResponseBuilder.serverError('Failed to toggle plugin');
  }
};
