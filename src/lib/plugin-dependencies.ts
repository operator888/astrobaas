/**
 * Plugin dependencies — "this pack needs commerce ≥2.0".
 *
 * The business model this exists for: a generic ecommerce plugin sold to
 * everyone, and vertical packs (optical prescriptions, lens configurators) sold
 * on top of it. Without dependencies the vertical installs happily with nothing
 * to attach to, does nothing, and blames the host; and uninstalling commerce
 * silently breaks it with no warning anywhere.
 *
 * ## Where each rule is enforced, and why there
 *
 * **Install is permitted with unmet dependencies.** You cannot force an
 * operator to install in topological order, and refusing here would make a
 * two-plugin bundle impossible to install at all. The response reports what is
 * still needed.
 *
 * **Activation is refused.** This is the moment a plugin starts contributing
 * content types, sections and webhooks, so it is the moment its assumptions have
 * to hold. Refusing here is a message an operator can act on; letting it through
 * produces a plugin that is "on" and quietly broken.
 *
 * **Deactivating or uninstalling something depended upon is refused** while a
 * dependent is ACTIVE. Otherwise the dependent keeps running against a plugin
 * that is no longer there — the failure appears somewhere else entirely, which
 * is the worst kind to debug. An INACTIVE dependent does not block: it simply
 * will not be able to activate until the dependency comes back, which the
 * activation check already explains.
 *
 * ## Version comparison
 *
 * `src/core/semver-range.ts`, a deliberate subset that refuses ranges it does
 * not understand rather than silently never matching them.
 */
import type { PluginManifest } from '../core/manifest';
import { satisfies } from '../core/semver-range';

/** What the host knows about one installed plugin, from either tier. */
export interface InstalledPluginInfo {
  id: string;
  name: string;
  version: string;
  active: boolean;
  /** Declared dependencies, if it is a manifest plugin. */
  dependencies?: Record<string, string>;
}

export type DependencyProblemReason = 'missing' | 'inactive' | 'incompatible';

export interface DependencyProblem {
  /** The plugin id that is required. */
  dependency: string;
  /** The range that was asked for. */
  range: string;
  reason: DependencyProblemReason;
  /** Present when the plugin is installed but wrong-versioned or off. */
  installedVersion?: string;
  /** Operator-facing, names the fix. */
  message: string;
}

/**
 * Which declared dependencies are not satisfied.
 *
 * An empty array means it is safe to activate. Order follows the manifest so
 * the report reads the way the author wrote it.
 */
export function unmetDependencies(
  dependencies: Record<string, string> | undefined,
  installed: readonly InstalledPluginInfo[],
): DependencyProblem[] {
  const problems: DependencyProblem[] = [];
  if (!dependencies) return problems;

  for (const [id, range] of Object.entries(dependencies)) {
    const found = installed.find((p) => p.id === id);

    if (!found) {
      problems.push({
        dependency: id, range, reason: 'missing',
        message: `requires "${id}" ${range}, which is not installed`,
      });
      continue;
    }
    // Version is checked before activity: telling someone to activate a plugin
    // that would still be the wrong version wastes a round trip.
    if (!satisfies(found.version, range)) {
      problems.push({
        dependency: id, range, reason: 'incompatible', installedVersion: found.version,
        message: `requires "${id}" ${range}, but ${found.version} is installed`,
      });
      continue;
    }
    if (!found.active) {
      problems.push({
        dependency: id, range, reason: 'inactive', installedVersion: found.version,
        message: `requires "${id}" ${range}, which is installed (${found.version}) but not active`,
      });
    }
  }
  return problems;
}

/** Convenience wrapper for a whole manifest. */
export const unmetForManifest = (
  manifest: Pick<PluginManifest, 'dependencies'>,
  installed: readonly InstalledPluginInfo[],
): DependencyProblem[] => unmetDependencies(manifest.dependencies, installed);

export interface Dependent {
  id: string;
  name: string;
  active: boolean;
  range: string;
}

/**
 * Plugins that declare a dependency on `pluginId`.
 *
 * The version range is NOT consulted. Whether the dependent's range currently
 * matches is irrelevant to the question being asked — "will removing this break
 * something that is running?" — and a dependent whose range has drifted is
 * exactly the case where a silent removal hurts most.
 */
export function dependentsOf(
  pluginId: string,
  installed: readonly InstalledPluginInfo[],
): Dependent[] {
  return installed
    // `hasOwnProperty`, not `in`: `in` walks the prototype chain, so a plugin
    // id of `constructor`, `toString` or `valueOf` would match EVERY plugin
    // that declares any dependency at all — and then block its removal. The
    // dependencies object comes from JSON.parse, so it has Object.prototype.
    .filter((p) => p.id !== pluginId && p.dependencies
      && Object.prototype.hasOwnProperty.call(p.dependencies, pluginId))
    .map((p) => ({ id: p.id, name: p.name, active: p.active, range: p.dependencies![pluginId] }));
}

/** Only the dependents that are running — the ones that block removal. */
export const activeDependentsOf = (
  pluginId: string,
  installed: readonly InstalledPluginInfo[],
): Dependent[] => dependentsOf(pluginId, installed).filter((d) => d.active);

/**
 * One sentence explaining why a plugin cannot be turned off or removed.
 *
 * Names the dependents, because "in use" without saying by what leaves an
 * operator with nothing to do next.
 */
export function blockedByDependentsMessage(
  pluginName: string,
  dependents: readonly Dependent[],
  verb: 'deactivate' | 'uninstall',
): string {
  const names = dependents.map((d) => `"${d.name}"`).join(', ');
  const plural = dependents.length === 1 ? 'it' : 'them';
  return `Cannot ${verb} "${pluginName}": ${names} ${dependents.length === 1 ? 'depends' : 'depend'} on it. `
    + `Deactivate ${plural} first.`;
}

/**
 * The current installed-plugin picture, from both tiers.
 *
 * Lives here rather than in each route because activate, deactivate and
 * uninstall all need exactly this and must agree on it. Three copies of a
 * "gather the state" loop is how the three checks drift apart — the sibling-gap
 * failure this codebase keeps repeating.
 *
 * The bundled registry supplies id/name/version for every plugin (both tiers,
 * since a manifest is registered into it at install); the DB records supply
 * `active` and, for declarative ones, the manifest that declares dependencies.
 */
export async function collectInstalledPlugins(): Promise<InstalledPluginInfo[]> {
  const [{ pluginManager }, { LocalDB }, { isDeclarativeRecord }] = await Promise.all([
    import('./plugin-system'),
    import('./localdb'),
    import('./manifest-runtime'),
  ]);

  const records = await LocalDB.getPlugins();
  return pluginManager.getPlugins().map((p) => {
    const rec = records.find((r) => r.id === p.id);
    const manifest = rec && isDeclarativeRecord(rec.settings) ? rec.settings.manifest : undefined;
    return {
      id: p.id,
      name: p.name,
      version: p.version,
      active: rec?.active ?? false,
      ...(manifest?.dependencies ? { dependencies: manifest.dependencies } : {}),
    };
  });
}
