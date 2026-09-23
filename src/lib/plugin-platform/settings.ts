/**
 * A plugin's OWN settings — the record the admin writes, read back by the
 * plugin that owns it.
 *
 * ## Why this exists
 *
 * A plugin could already read the site's GLOBAL settings (the external host's
 * `getSettings()`), and it could store its own data in its namespaced store.
 * What it could not do was read the `settings` object on its own
 * `PluginRecord` — the one an operator edits on the plugin's admin screen —
 * even though PLUGIN_DEVELOPMENT.md talked about caching exactly that at
 * `activate()`. Every plugin that needed it reached for `LocalDB.getPlugins()`
 * and filtered, which means every plugin could also read (and was one typo
 * away from writing) every OTHER plugin's settings.
 *
 * So: one function, scoped to an id, returning a plain map.
 *
 * ## Reading it at the right moment
 *
 * `activate()` runs once per process. An operator who changes a setting after
 * that is not going to restart the site, so a value cached at activation is a
 * value that goes stale — the same shape as the caches the multi-process work
 * had to put TTLs on. Read it where you use it; this is one indexed lookup,
 * and the plugin registry re-check already re-reads records every 15 s.
 *
 * It never throws: a plugin that cannot read its settings should fall back to
 * its defaults, not take a request down with it.
 */
import { LocalDB } from '../localdb';

/**
 * The settings object stored on `pluginId`'s record, or `{}` when the plugin
 * has no record yet, has never been configured, or storage is unreachable.
 */
export async function getPluginSettings(pluginId: string): Promise<Record<string, unknown>> {
  try {
    const records = await LocalDB.getPlugins();
    const own = records.find((r) => r.id === pluginId);
    const settings = own?.settings;
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return {};
    // A copy: the caller must not be able to mutate what the next reader sees,
    // and on the document drivers that object IS the stored one.
    return { ...settings } as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * One setting, with a fallback — the shape most call sites actually want.
 *
 * `fallback` is returned when the key is absent OR stored as `null`, because
 * "the operator cleared the field" and "the operator never filled it in" are
 * the same thing to a plugin deciding whether to act.
 */
export async function getPluginSetting<T>(
  pluginId: string,
  key: string,
  fallback: T,
): Promise<T> {
  const settings = await getPluginSettings(pluginId);
  const value = settings[key];
  return value === undefined || value === null ? fallback : (value as T);
}
