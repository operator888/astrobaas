/**
 * Plugin registry — two tiers.
 *
 * 1. **Bundled (code) plugins.** Astro SSR bundles at build time, so these are
 *    explicit imports rather than runtime filesystem discovery. To add one: drop
 *    a folder under src/plugins/<id>/ that default-exports a Plugin, then add one
 *    import + array entry here.
 * 2. **Declarative plugins.** Installed at runtime from a JSON manifest (upload
 *    or curated registry), stored in the DB, and compiled to the same Plugin
 *    shape by manifestToPlugin(). No code is executed — see src/core/manifest.ts.
 *
 * Both tiers share one PluginManager, so hooks, activation state, and the admin
 * UI treat them identically.
 */
import type { Plugin } from 'astrobaas/core';
import { pluginManager, PLUGIN_HOOKS } from 'astrobaas/core';
import {
  clearContentTypes, registerContentType, getContentType,
  validateContentTypeDefinitions, ADMIN_CONTENT_TYPES_SETTING,
} from '../core/content-types';
import { LocalDB } from '../lib/localdb';
import {
  setPluginProviders, setPluginManualMethods, paymentConfigReport,
} from '../lib/payments/registry';
import type { PaymentProvider } from '../lib/payments/types';
import type { ManualMethodDef } from '../lib/payments/registry';
import type { PluginRoute, PluginAdminPage, PluginMigration } from '../lib/plugin-system';
import { setPluginRoutes } from '../lib/plugin-platform/routes';
import { setPluginAdminPages, pluginAdminPageRoles } from '../lib/plugin-platform/admin-pages';
import { setPluginAdminRoleResolver } from '../lib/admin-access';
import { createPluginStore, runPluginMigrations } from '../lib/plugin-platform/store';
import { isDeclarativeRecord, manifestToPlugin } from '../lib/manifest-runtime';
import readingTime from './reading-time';
import draftWatermark from './draft-watermark';
import productCatalog from './product-catalog';
import printStyles from './print-styles';
import smtp2go from './smtp2go';
import consentBanner from './consent-banner';
import aiAssistant from './ai-assistant';
import popups from './popups';
import { loadExternalPlugins, parsePluginSpecifiers } from './external';
import { enabledBuiltinCollections } from '../core/builtin-collections';
import { settingBool } from '../lib/settings-map';
import { span } from '../lib/request-profile';
import { RegistryRecheck, pluginRegistryFingerprint } from '../lib/plugin-platform/registry-recheck';

export const BUNDLED_PLUGINS: Plugin[] = [readingTime, draftWatermark, productCatalog, printStyles, smtp2go, consentBanner, aiAssistant, popups];

/**
 * The in-flight (or completed) bootstrap.
 *
 * A PROMISE, not a boolean. The boolean version set `bootstrapped = true`
 * before its first `await`, so every request arriving during the hundreds of
 * milliseconds a bootstrap takes — external module imports, a network libSQL
 * round trip, manifest compilation — returned immediately into a registry that
 * was still EMPTY.
 *
 * That was survivable while plugins only filtered content: a post rendered
 * without a plugin's decoration. It stops being survivable now that a plugin
 * can own an API route and an admin page, because the same window turns into a
 * 404 on a live endpoint. An admin toggling one plugin could 404 a shopper
 * mid-checkout on an unrelated one.
 *
 * Awaiting the same promise means concurrent callers queue behind the first
 * rather than racing past it. Same pattern as the migration promise in
 * localdb.ts.
 */
let bootstrapPromise: Promise<void> | null = null;

/**
 * Idempotently register bundled + declarative plugins and activate those
 * persisted as active. Safe to call on every request; only does work once per
 * process (until reloadPlugins() invalidates it).
 */
export async function ensurePluginsBootstrapped(): Promise<void> {
  // Profiled (C-157): the first request of a process pays for the whole
  // registry, and "the homepage is slow, but only sometimes" is exactly the
  // question a per-request breakdown is meant to answer.
  await span('plugins.bootstrap', () => bootstrapPlugins());
  // Another replica may have changed the plugin set since this registry was
  // built. Checked in the background, at most every 15 s (registry-recheck.ts).
  registryRecheck.poke();
}

/** Read what a bootstrap depends on, as a fingerprint. */
async function readRegistryFingerprint(): Promise<string> {
  const [records, rows] = await Promise.all([LocalDB.getPlugins(), LocalDB.getSettings()]);
  const settings: Record<string, unknown> = {};
  for (const r of rows) settings[r.key] = r.value;
  return pluginRegistryFingerprint(records, settings);
}

const registryRecheck = new RegistryRecheck({
  read: readRegistryFingerprint,
  reload: () => reloadPlugins(),
  log: (m) => console.log(m),
});

async function bootstrapPlugins(): Promise<void> {
  if (!bootstrapPromise) {
    // Capture the promise we create, and clear the slot only if it still holds
    // THIS one. Without the identity check a failure could null out a NEWER
    // bootstrap started by a concurrent reload, and the next request would
    // start a second one alongside it.
    const mine: Promise<void> = doBootstrap().catch((err) => {
      // A failed bootstrap must not be cached as "done": the next request
      // should try again rather than serve a permanently empty registry for
      // the life of the process.
      if (bootstrapPromise === mine) bootstrapPromise = null;
      throw err;
    });
    bootstrapPromise = mine;
  }
  return bootstrapPromise;
}

/**
 * What the last bootstrap concluded, kept so something other than the log can
 * read it.
 *
 * Every fact below was already computed at boot and then printed and dropped.
 * Printing is not reporting: on a shop where the optical module failed to load,
 * the console line scrolled past during a deploy and the only symptom was that
 * prescription validation stopped happening. The deep health check reads this
 * instead, so "a plugin the operator paid for is not running" is something a
 * deploy script can fail on.
 */
export interface PluginBootstrapReport {
  /** Specifiers from ASTROBAAS_PLUGINS, verbatim. */
  requested: string[];
  /** Specifiers that would not import, with the reason. */
  failed: { specifier: string; reason: string }[];
  /** Ids the operator forced on with ASTROBAAS_PLUGINS_ACTIVATE. */
  force_activate: string[];
  /** Forced ids that are not installed at all. */
  force_activate_unknown: string[];
  /** Active in the database with no implementation registered. */
  active_without_implementation: string[];
  /** Ids with a registered implementation, active or not. */
  registered: string[];
  /** Ids the database says are on. */
  active: string[];
  /** When this ran. Null until the first bootstrap completes. */
  at: string | null;
}

let report: PluginBootstrapReport = {
  requested: [], failed: [], force_activate: [], force_activate_unknown: [],
  active_without_implementation: [], registered: [], active: [], at: null,
};

/** The last bootstrap's findings. Empty-but-present before the first boot. */
export function pluginBootstrapReport(): PluginBootstrapReport {
  return { ...report };
}

async function doBootstrap(): Promise<void> {
  await LocalDB.init();

  // External modules are loaded FIRST so their ids can be seeded alongside the
  // bundled ones. They used to be loaded after seeding, which left them with no
  // plugin record at all — so they could never be marked active, never appeared
  // in Admin -> Plugins, and their filters never registered. A paid gateway
  // simply did not exist, and nothing said why.
  const external = await loadExternalPlugins();
  report = {
    ...report,
    requested: parsePluginSpecifiers(process.env.ASTROBAAS_PLUGINS),
    failed: external.failed.map((f) => ({ ...f })),
  };

  // Seed a record for any plugin we know about (default inactive).
  await LocalDB.ensurePlugins([
    ...BUNDLED_PLUGINS.map((p) => p.id),
    ...external.plugins.map((p) => p.id),
  ]);
  let records = await LocalDB.getPlugins();

  // Compile every stored manifest into a Plugin. A manifest that fails to
  // compile is skipped with a log rather than breaking the whole boot.
  const declarative: Plugin[] = [];
  for (const rec of records) {
    if (!isDeclarativeRecord(rec.settings)) continue;
    try {
      declarative.push(manifestToPlugin(rec.settings.manifest));
    } catch (err) {
      console.error(`Skipping declarative plugin "${rec.id}":`, err instanceof Error ? err.message : err);
    }
  }

  // Plugins the OPERATOR has declared should be on. Without this, a module
  // shipped in a release still has to be switched on by hand in every
  // environment — which for a shop that already paid for it is a step that adds
  // nothing but an opportunity to forget.
  //
  // Deliberately an explicit env list rather than a flag a plugin sets about
  // itself: a plugin that could activate itself on install would be a plugin
  // that can start intercepting checkout without anyone deciding to let it.
  const forceActive = parsePluginSpecifiers(process.env.ASTROBAAS_PLUGINS_ACTIVATE);
  report.force_activate = [...forceActive];
  report.force_activate_unknown = [];
  if (forceActive.length) {
    const known = new Set(records.map((r) => r.id));
    for (const id of forceActive) {
      const rec = records.find((r) => r.id === id);
      if (rec && !rec.active) await LocalDB.setPluginActive(id, true);
      else if (!known.has(id)) {
        report.force_activate_unknown.push(id);
        console.error(
          `[astrobaas] ASTROBAAS_PLUGINS_ACTIVATE names "${id}", which is not installed. `
          + 'Nothing was activated — check ASTROBAAS_PLUGINS.',
        );
      }
    }
    if (forceActive.some((id) => records.find((r) => r.id === id && !r.active))) {
      records = await LocalDB.getPlugins();
    }
  }

  const activeIds = new Set(records.filter((r) => r.active).map((r) => r.id));
  // Fingerprinted from the records this registry is built from (plus the
  // settings as they stand now), so a change made on another process from
  // here on is noticed by the next re-check.
  try {
    registryRecheck.markBuilt(pluginRegistryFingerprint(records, await settingsForFingerprint()));
  } catch {
    /* no fingerprint: the re-check stays idle until the next bootstrap */
  }
  await pluginManager.bootstrap(
    [...BUNDLED_PLUGINS, ...declarative, ...external.plugins],
    async () => activeIds,
  );

  // A module that failed to load is a configuration error, and on an optician's
  // shop a silent one means prescription validation stops and lenses sell with
  // nothing to grind. Say so on every boot, loudly, naming the specifier.
  for (const f of external.failed) {
    console.error(`[astrobaas] ASTROBAAS_PLUGINS: could not load "${f.specifier}" — ${f.reason}`);
  }

  // The sharper case: a plugin the DATABASE says is active, with no
  // implementation registered. That is what an install looks like after a paid
  // module is removed or fails to load — the admin still shows it switched on,
  // and nothing it does happens. Nothing else would ever report it.
  const registered = new Set(pluginManager.getPlugins?.().map((p: Plugin) => p.id) ?? []);
  // Payment gateways contributed by ACTIVE plugins. Collected after bootstrap so
  // only plugins the operator switched on can take money.
  setPluginProviders(
    pluginManager.applyFilters(PLUGIN_HOOKS.PAYMENT_PROVIDERS, [] as PaymentProvider[]) as PaymentProvider[],
  );
  // Manual methods AFTER providers: the registry refuses a manual id that
  // shadows a gateway, and it can only do that once it knows the gateways.
  setPluginManualMethods(
    pluginManager.applyFilters(PLUGIN_HOOKS.MANUAL_METHODS, [] as ManualMethodDef[]) as ManualMethodDef[],
  );

  // Routes, admin pages and data migrations, from ACTIVE plugins only.
  //
  // Read from the plugin OBJECTS rather than through a filter hook: a route is
  // a declaration about the plugin itself, not a contribution to a shared
  // value, and going through applyFilters would let any plugin rewrite another
  // plugin's routes on the way past.
  const activePlugins = (pluginManager.getPlugins?.() ?? []).filter((p: Plugin) => activeIds.has(p.id));

  // Array.isArray, not `?? []`. A plugin whose `routes` is an object rather
  // than an array makes `.map` throw — inside doBootstrap, which the middleware
  // awaits on EVERY request. One malformed third-party module would 500 the
  // entire site, permanently, with a TypeError nobody could place.
  const declared = <T,>(value: unknown, id: string, field: string): readonly T[] => {
    if (value === undefined || value === null) return [];
    if (Array.isArray(value)) return value as T[];
    console.error(`[astrobaas] plugin "${id}" declared a non-array "${field}"; ignoring it`);
    return [];
  };

  setPluginRoutes(
    activePlugins.flatMap((p: Plugin) =>
      declared<PluginRoute>(p.routes, p.id, 'routes').map((route) => ({ pluginId: p.id, route }))),
  );
  setPluginAdminPages(
    activePlugins.flatMap((p: Plugin) =>
      declared<PluginAdminPage>(p.adminPages, p.id, 'adminPages').map((page) => ({ pluginId: p.id, page }))),
  );
  // Let admin-access ask the registry. Registered once the pages are in, so
  // there is never a window where a page exists but its rule does not.
  setPluginAdminRoleResolver(pluginAdminPageRoles);

  // Data migrations run INSIDE the bootstrap promise, so concurrent requests
  // queue behind them rather than reading half-migrated records. Per-process
  // only — the same guarantee core's own migration runner gives — which is why
  // a plugin's up() must be idempotent.
  for (const p of activePlugins) {
    const migrations = declared<PluginMigration>(p.migrations, p.id, 'migrations');
    if (!migrations.length) continue;
    try {
      const store = createPluginStore(p.id, LocalDB);
      await runPluginMigrations(p.id, migrations, store, LocalDB);
    } catch (err) {
      // A plugin whose migrations cannot run is a plugin whose data is in an
      // unknown state. Loud, named, and it does not stop the other plugins.
      console.error(`[astrobaas] plugin "${p.id}" data migrations failed:`, err);
    }
  }

  report.registered = [...registered];
  report.active = [...activeIds];
  report.active_without_implementation = [...activeIds].filter((id) => !registered.has(id));
  report.at = new Date().toISOString();

  for (const id of activeIds) {
    if (!registered.has(id)) {
      const pkg = SEPARATELY_LICENSED_MODULES[id];
      console.error(
        `[astrobaas] plugin "${id}" is ACTIVE in the database but no implementation is loaded. `
        + 'Anything it provides is silently not happening. '
        + (pkg
          ? `${pkg.what} ships separately: install ${pkg.package} and add it to ASTROBAAS_PLUGINS.`
          : 'Check ASTROBAAS_PLUGINS.'),
      );
    }
  }

  /*
   * Admin-defined content types — the ACF-shaped capability.
   *
   * Registered LAST, so a name a plugin already claimed stays the plugin's: a
   * paid module's collection must not be shadowable from a settings field. The
   * shadowed definition is reported loudly rather than silently skipped,
   * because the admin who built it will otherwise stare at a working builder
   * and a missing API wondering which half is lying.
   *
   * Stored definitions are validated as hard as a hostile manifest — the
   * settings value outlives the screen that wrote it (restores, API writes,
   * hand edits), so trust in the UI buys nothing here.
   */
  try {
    // The built-in collections (C-142 comments, C-35 reviews), when the
    // operator switched them on. Registered BEFORE the admin-defined types, so
    // the existing shadow check reports an operator's clashing type rather
    // than silently replacing a core collection — though `comment` and
    // `review` are also in the reserved-name set, so it cannot happen.
    //
    // Off by default: a site that has never wanted comments must not grow a
    // public write endpoint because it upgraded.
    try {
      const settingRows = await LocalDB.getSettings();
      const settings: Record<string, unknown> = {};
      for (const s of settingRows) settings[s.key] = s.value;
      for (const def of enabledBuiltinCollections(settings, (v) => settingBool(v, false))) {
        if (!getContentType(def.name)) registerContentType(def, { builtin: true });
      }
    } catch (err) {
      console.error('[astrobaas] built-in collections failed to load:', err);
    }

    const raw = (await LocalDB.getSetting(ADMIN_CONTENT_TYPES_SETTING))?.value;
    if (raw !== undefined && raw !== null) {
      const checked = validateContentTypeDefinitions(raw);
      for (const e of checked.errors) {
        console.error(`[astrobaas] admin content types: ${e} — that definition was NOT registered`);
      }
      for (const def of checked.defs) {
        if (getContentType(def.name)) {
          console.error(
            `[astrobaas] admin content type "${def.name}" is shadowed by a plugin's type of the same name and was NOT registered.`,
          );
          continue;
        }
        registerContentType(def);
      }
    }
  } catch (err) {
    // A broken definition must not take the boot down; the rest of the site
    // works and the error above says what to fix.
    console.error('[astrobaas] admin content types failed to load:', err);
  }

  reportPaymentMisconfiguration();
}

async function settingsForFingerprint(): Promise<Record<string, unknown>> {
  const settings: Record<string, unknown> = {};
  for (const r of await LocalDB.getSettings()) settings[r.key] = r.value;
  return settings;
}

/**
 * Modules that are not in this repository, so "active but missing" has a fix
 * worth naming.
 *
 * Only ids and package names — nothing here couples core to what those modules
 * do, and an install without them behaves exactly like one that never had them.
 * The point is purely that an operator who sees the error above should not have
 * to guess which package went missing.
 */
const SEPARATELY_LICENSED_MODULES: Record<string, { package: string; what: string }> = {
  optical: { package: '@astrobaas/optical', what: 'The optical module' },
  iris: { package: '@astrobaas/iris', what: 'The IRIS payments module' },
};

/**
 * Say at BOOT which payment providers were asked for and cannot work.
 *
 * The admin settings screen already shows this, which is worth exactly as much
 * as how often someone opens it. A gateway that quietly stopped being offered —
 * a rotated secret, a typo in a redeploy — otherwise announces itself as
 * customers not paying, and the shop notices through its revenue.
 *
 * Names only. `paymentConfigReport` never puts a value in what it returns, so
 * this cannot leak a credential into a log.
 */
function reportPaymentMisconfiguration(): void {
  const env = process.env as Record<string, string | undefined>;
  for (const r of paymentConfigReport(env)) {
    if (!r.requested || r.enabled) continue;
    const why = r.missingEnv.length > 0
      ? `not set: ${r.missingEnv.join(', ')}`
      : r.problems.join('; ');
    console.error(
      `[astrobaas] payment provider "${r.id}" is listed in PAYMENTS_ENABLED but is NOT `
      + `being offered at checkout — ${why}`,
    );
  }
}

/**
 * Re-read the plugin set from storage. Call after installing or uninstalling a
 * declarative plugin so the change takes effect without a restart.
 *
 * Other replicas notice within PLUGIN_REGISTRY_RECHECK_MS of their next
 * request and run this themselves (see registry-recheck.ts).
 */
export async function reloadPlugins(): Promise<void> {
  // Build the new registry BEFORE tearing down the old one.
  //
  // The previous order cleared everything synchronously and then re-entered
  // bootstrap, leaving a window in which the process served requests against no
  // plugins at all. Requests arriving during a reload now queue on the new
  // bootstrap and see either the old registry or the new one — never neither.
  const previous = bootstrapPromise;
  const mine: Promise<void> = (async () => {
    // Wait for any in-flight bootstrap so two reloads cannot interleave their
    // reset/register steps.
    await previous?.catch(() => {});
    pluginManager.reset();
    // Content types are registered by activate(); clear so an uninstalled
    // plugin's collections don't linger in this process.
    clearContentTypes();
    await doBootstrap();
  })().catch((err) => {
    if (bootstrapPromise === mine) bootstrapPromise = null;
    throw err;
  });
  bootstrapPromise = mine;
  return mine;
}
