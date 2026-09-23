/**
 * Interpreter for declarative plugin manifests.
 *
 * Turns validated manifest DATA into the same `Plugin` object shape a code
 * plugin exports, so a runtime-installed plugin flows through the existing hook
 * machinery unchanged — no separate execution path, no `eval`, no sandbox.
 *
 * Each capability maps onto a subsystem that already exists:
 *   headTags     → the `head_tags` filter (rendered + escaped, then sanitized)
 *   css          → the `plugin_styles` filter, served from /plugins.css
 *   contentTypes → registerContentType(), the same registry code plugins use
 *   webhooks     → real Webhook records, synced at install/uninstall (not here,
 *                  because activate() is not awaited — see syncManifestWebhooks)
 */
import type { Plugin, FilterFn } from './plugin-system';
import { PLUGIN_HOOKS } from './plugin-system';
import { registerContentType } from '../core/content-types';
import { renderHeadTags, manifestContentTypes, type PluginManifest } from '../core/manifest';
import { sanitizeCustomCss, sanitizeHeadHtml } from './sanitize';
import { LocalDB } from './localdb';
import { newWebhookSecret } from './auth';

/** Marker stored on a PluginRecord's settings for declaratively-installed plugins. */
export interface DeclarativePluginSettings {
  manifest: PluginManifest;
  /** Where it came from: "upload" or "registry:<name>". */
  source?: string;
  installed_at?: string;
}

/** True when a plugin record was installed from a manifest rather than bundled. */
export function isDeclarativeRecord(settings: unknown): settings is DeclarativePluginSettings {
  return !!settings && typeof settings === 'object' && !!(settings as any).manifest;
}

/** Provenance tag used on webhooks a manifest declared. */
export function pluginWebhookSource(id: string): string {
  return `plugin:${id}`;
}

/**
 * Compile a validated manifest into a Plugin. Pure and synchronous — safe to
 * call during bootstrap. Anything requiring I/O happens at install time instead.
 */
export function manifestToPlugin(manifest: PluginManifest): Plugin {
  const filters: Record<string, FilterFn> = {};

  if (manifest.capabilities.headTags?.length) {
    // Render → escape → sanitize. The manifest was already validated, so this is
    // the third independent layer; markup simply cannot originate from a manifest.
    const html = sanitizeHeadHtml(renderHeadTags(manifest.capabilities.headTags));
    if (html) {
      filters[PLUGIN_HOOKS.HEAD_TAGS] = (existing: string) => `${existing}${html}`;
    }
  }

  if (manifest.capabilities.css) {
    const css = sanitizeCustomCss(manifest.capabilities.css);
    if (css) {
      filters[PLUGIN_HOOKS.PLUGIN_STYLES] = (existing: string) => `${existing}\n/* ${manifest.id} */\n${css}`;
    }
  }

  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description ?? '',
    author: manifest.author ?? '',
    filters,
    activate() {
      // Content types register exactly like a code plugin's do.
      for (const ct of manifestContentTypes(manifest)) {
        try {
          registerContentType(ct);
        } catch (err) {
          // Validation already rejects reserved/invalid names; a collision with
          // another plugin is possible, so log rather than break activation.
          console.error(`[${manifest.id}] content type "${ct.name}" rejected:`, err instanceof Error ? err.message : err);
        }
      }
    },
  };
}

/**
 * Create the Webhook records a manifest declares. Idempotent: an existing
 * subscription with the same source+url+event is left alone. Called from the
 * install path (awaited), not from activate() — PluginManager does not await
 * lifecycle callbacks, so DB work there would float.
 */
export async function syncManifestWebhooks(manifest: PluginManifest): Promise<number> {
  const declared = manifest.capabilities.webhooks ?? [];
  if (!declared.length) return 0;

  const source = pluginWebhookSource(manifest.id);
  const existing = await LocalDB.getWebhooks();
  let created = 0;

  for (const w of declared) {
    const already = existing.some(
      (e) => e.source === source && e.url === w.url && e.events.includes(w.event),
    );
    if (already) continue;
    const rec = await LocalDB.createWebhook({
      url: w.url,
      events: [w.event],
      secret: newWebhookSecret(),
      active: true,
      source,
    });
    if (rec) created += 1;
  }
  return created;
}

/**
 * Bring a plugin's webhook subscriptions in line with its ACTIVE state.
 *
 * Webhooks used to be bound to install and uninstall only, so a manifest that
 * declared one started delivering site content to a third-party URL the moment
 * it was installed — before anyone activated it — and kept delivering after it
 * was switched off. Installing is presented in the UI as inert ("Activate it
 * from the plugins list"), which made this the least expected behaviour in the
 * plugin system.
 *
 * Deactivating removes the subscriptions rather than merely flagging them, so
 * there is no dormant row for a later bug to re-enable.
 */
export async function syncPluginWebhooks(pluginId: string, active: boolean): Promise<number> {
  const all = await LocalDB.getPlugins().catch(() => []);
  const rec = all.find((r: any) => r.id === pluginId);
  // `.settings`, not the record. `isDeclarativeRecord` tests `.manifest`, which
  // lives at `rec.settings.manifest` — a PluginRecord has no `manifest` key, so
  // passing `rec` made this guard ALWAYS false and the function always returned
  // 0 without doing anything.
  //
  // The consequence was not cosmetic: deactivating a manifest plugin did not
  // remove the webhooks it created, so a switched-off plugin kept POSTing site
  // content to its third-party URL — exactly what the comment above this
  // function says it prevents. Every other call site in the codebase passes
  // `.settings`; this was the one sibling that was missed.
  if (!rec || !isDeclarativeRecord(rec.settings)) return 0;
  return active
    ? syncManifestWebhooks(rec.settings.manifest)
    : removeManifestWebhooks(pluginId);
}

/** Remove every webhook a given plugin created. Returns how many were deleted. */
export async function removeManifestWebhooks(pluginId: string): Promise<number> {
  const source = pluginWebhookSource(pluginId);
  const all = await LocalDB.getWebhooks();
  let removed = 0;
  for (const w of all) {
    if (w.source === source) {
      if (await LocalDB.deleteWebhook(w.id)) removed += 1;
    }
  }
  return removed;
}
