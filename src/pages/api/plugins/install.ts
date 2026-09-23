import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { validateManifest } from '../../../core/manifest';
import { checkManifestSections } from '../../../lib/manifest-sections';
import {
  collectInstalledPlugins, unmetDependencies, activeDependentsOf, blockedByDependentsMessage,
} from '../../../lib/plugin-dependencies';
import { satisfies } from '../../../core/semver-range';
import { checkWebhookUrl } from '../../../lib/url-guard';
import {
  isDeclarativeRecord,
  syncManifestWebhooks,
  removeManifestWebhooks,
} from '../../../lib/manifest-runtime';
import { reloadPlugins, BUNDLED_PLUGINS } from '../../../plugins';
import { recordAudit, AUDIT } from '../../../lib/audit';

/**
 * Install / uninstall a DECLARATIVE plugin (a JSON manifest).
 *
 * This is the only route that accepts plugin "packages" from outside, so it is
 * the trust boundary for the runtime tier. It is deliberately narrow:
 *   - admin-only, CSRF-protected (middleware), body-size-capped (middleware);
 *   - the payload is DATA and is fully validated before anything is stored —
 *     nothing is ever evaluated, imported, or written to disk;
 *   - a manifest may not shadow a bundled plugin id;
 *   - webhook targets are re-checked against the SSRF guard at install time.
 *
 * POST   { manifest }  → install (or upgrade an existing declarative plugin)
 * DELETE { id }        → uninstall (declarative only; bundled ids are refused)
 */
export const POST: APIRoute = async ({ request, locals }) => {
  try {
    await LocalDB.init();
    const session = locals.user;
    if (!session || session.role !== 'admin') return ApiResponseBuilder.forbidden('Admin only');

    const body = await request.json().catch(() => null);
    const raw = (body as any)?.manifest;
    if (raw === undefined) return ApiResponseBuilder.badRequest('Missing `manifest`.');

    const result = validateManifest(raw, { checkWebhookUrl });
    if (!result.ok || !result.manifest) {
      return ApiResponseBuilder.validationError('Invalid plugin manifest', { errors: result.errors });
    }
    const manifest = result.manifest;

    // The sanitizer round-trip. The validator checked that every class is
    // namespaced and every selector scoped; it cannot check whether the
    // template actually survives the content sanitizer, and a section that does
    // not is the worst kind of broken — it renders in the editor and loses part
    // of itself on save. The rejection carries the sanitized output next to the
    // submitted markup, because "rejected" is not something an author can act
    // on and a diff is.
    const sectionProblems = checkManifestSections(manifest.id, manifest.capabilities.sections);
    if (sectionProblems.length) {
      return ApiResponseBuilder.validationError('Plugin sections were refused', {
        errors: sectionProblems.map((p) => `sections.${p.section}: ${p.reason}`),
        sections: sectionProblems,
      });
    }

    // A manifest must never shadow a compiled-in plugin: that would let an
    // upload silently replace reviewed code in the admin UI's eyes.
    if (BUNDLED_PLUGINS.some((p) => p.id === manifest.id)) {
      return ApiResponseBuilder.badRequest(
        `"${manifest.id}" is a bundled plugin and cannot be replaced by a manifest.`,
      );
    }

    // Refuse to overwrite a record that exists but is NOT declarative.
    const existing = (await LocalDB.getPlugins()).find((p) => p.id === manifest.id);
    if (existing && !isDeclarativeRecord(existing.settings)) {
      return ApiResponseBuilder.badRequest(`"${manifest.id}" already exists and is not a declarative plugin.`);
    }

    const source = typeof (body as any)?.source === 'string' ? String((body as any).source).slice(0, 100) : 'upload';

    // An UPGRADE is a third mutation point, and it was enforcing none of the
    // dependency contract — so it silently produced exactly the states that
    // activate and uninstall exist to prevent. The record is overwritten in
    // place and `reloadPlugins()` re-activates it from the still-true `active`
    // flag, so nothing ever passes through the activation check.
    //
    // Both directions had to be closed, because they fail differently:
    if (existing?.active) {
      const installedBefore = await collectInstalledPlugins();

      // 1. The plugin ITSELF. A new version that declares a dependency the site
      //    cannot satisfy would come straight back up running against it, while
      //    the response cheerfully said "cannot be activated yet".
      const wouldBeUnmet = unmetDependencies(manifest.dependencies, installedBefore);
      if (wouldBeUnmet.length) {
        return ApiResponseBuilder.badRequest(
          `Cannot upgrade "${manifest.name}" while it is active: the new version ${wouldBeUnmet.map(u => u.message).join('; ')}. `
          + 'Deactivate it first, upgrade, then satisfy the dependency and activate.',
          { dependencies: wouldBeUnmet },
        );
      }

      // 2. Its DEPENDENTS. Uninstalling a depended-upon plugin is refused;
      //    upgrading it out from under the same dependents was not, so
      //    commerce 2.x could become 3.0.0 beneath a pack that requires ^2.0.0
      //    with nothing raised anywhere.
      const brokenDependents = activeDependentsOf(manifest.id, installedBefore)
        .filter((d) => !satisfies(manifest.version, d.range));
      if (brokenDependents.length) {
        return ApiResponseBuilder.badRequest(
          `Cannot upgrade "${manifest.name}" to ${manifest.version}: `
          + brokenDependents.map(d => `"${d.name}" requires ${d.range}`).join(', ')
          + '. Deactivate the dependent first, or upgrade it too.',
          { dependents: brokenDependents },
        );
      }
    }

    await LocalDB.ensurePlugins([manifest.id]);
    await LocalDB.updatePluginSettings(manifest.id, {
      manifest,
      source,
      installed_at: existing ? (existing.settings as any)?.installed_at ?? new Date().toISOString() : new Date().toISOString(),
    });

    // Declared webhooks become real subscriptions (idempotent).
    const webhooksCreated = await syncManifestWebhooks(manifest);

    // Make it live in this process without a restart.
    await reloadPlugins();

    recordAudit(AUDIT.PLUGIN_INSTALL, {
      actor: session.id,
      target: manifest.id,
      ip: locals.ip,
      metadata: { version: manifest.version, source, capabilities: Object.keys(manifest.capabilities) },
    });

    // Install deliberately succeeds with dependencies unmet: an operator cannot
    // be made to install in topological order, and refusing would make a
    // two-plugin bundle uninstallable. But it must be visible, or the plugin
    // looks installed and ready when activation will refuse it.
    const pendingDeps = unmetDependencies(manifest.dependencies, await collectInstalledPlugins());

    return ApiResponseBuilder.created(
      {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        capabilities: Object.keys(manifest.capabilities),
        webhooks_created: webhooksCreated,
        unmet_dependencies: pendingDeps,
        upgraded: !!existing,
      },
      pendingDeps.length
        ? `Plugin installed, but it cannot be activated yet: it ${pendingDeps.map(d => d.message).join('; ')}.`
        : existing
          ? 'Plugin upgraded. Activate it from the plugins list.'
          : 'Plugin installed. Activate it from the plugins list.',
    );
  } catch (err) {
    console.error('Plugin install error:', err);
    return ApiResponseBuilder.serverError('Failed to install plugin');
  }
};

export const DELETE: APIRoute = async ({ request, locals }) => {
  try {
    await LocalDB.init();
    const session = locals.user;
    if (!session || session.role !== 'admin') return ApiResponseBuilder.forbidden('Admin only');

    const body = await request.json().catch(() => null);
    const id = String((body as any)?.id ?? '').trim();
    if (!id) return ApiResponseBuilder.badRequest('Missing `id`.');

    if (BUNDLED_PLUGINS.some((p) => p.id === id)) {
      return ApiResponseBuilder.badRequest('Bundled plugins cannot be uninstalled — remove the import and rebuild.');
    }

    const rec = (await LocalDB.getPlugins()).find((p) => p.id === id);
    if (!rec) return ApiResponseBuilder.notFound('Plugin');
    if (!isDeclarativeRecord(rec.settings)) {
      return ApiResponseBuilder.badRequest('Only declarative (manifest) plugins can be uninstalled here.');
    }

    // Removing something a RUNNING plugin depends on breaks the dependent with
    // no error at the point of the change — the failure surfaces somewhere
    // else entirely. An inactive dependent does not block: it simply cannot
    // activate until this comes back, which the activation check explains.
    const installedNow = await collectInstalledPlugins();
    const blockers = activeDependentsOf(id, installedNow);
    if (blockers.length) {
      return ApiResponseBuilder.badRequest(
        blockedByDependentsMessage(rec.settings.manifest.name, blockers, 'uninstall'),
        { dependents: blockers },
      );
    }

    const webhooksRemoved = await removeManifestWebhooks(id);
    // Drop everything the plugin stored. Uninstall used to delete exactly one
    // row from the plugins table, leaving every record the plugin had written
    // orphaned in the database — invisible in the admin, unreadable by anything
    // (the store is namespaced to a plugin that no longer exists), and still
    // counting against the shop's storage. Reinstalling then silently inherited
    // the old data, including its schema version, so migrations did not re-run.
    const dataRemoved = await LocalDB.deletePluginData(id);
    const deleted = await LocalDB.deletePlugin(id);
    await reloadPlugins();

    recordAudit(AUDIT.PLUGIN_UNINSTALL, {
      actor: session.id,
      target: id,
      ip: locals.ip,
      metadata: { webhooks_removed: webhooksRemoved, records_removed: dataRemoved },
    });

    return ApiResponseBuilder.success(
      { id, deleted, webhooks_removed: webhooksRemoved, records_removed: dataRemoved },
      'Plugin uninstalled.',
    );
  } catch (err) {
    console.error('Plugin uninstall error:', err);
    return ApiResponseBuilder.serverError('Failed to uninstall plugin');
  }
};
