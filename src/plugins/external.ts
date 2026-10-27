/**
 * Compiled plugins loaded from OUTSIDE this repository.
 *
 * ## Why this exists
 *
 * `BUNDLED_PLUGINS` is a static array in `src/plugins/index.ts`, so until now
 * the only way to ship a compiled plugin was to commit it here — which is fine
 * for the bundled examples and impossible for anything sold. A paid module
 * cannot live in a GPL-3.0 repository: once published there it is GPL forever,
 * and no later decision can withdraw that.
 *
 * It is also what a per-client integration needs. A bank-specific payment
 * gateway belongs to that bank's engagement, not in every install of the CMS.
 *
 * ## The contract
 *
 * `ASTROBAAS_PLUGINS` is a comma-separated list of module specifiers:
 *
 *   ASTROBAAS_PLUGINS=@astrobaas/optical,@acme/eurobank-gateway
 *
 * Each module default-exports EITHER a Plugin object, OR — preferred — a
 * FACTORY taking the host API:
 *
 *   export default (host) => host.definePlugin({ id: 'optical', … })
 *
 * The factory shape is preferred because an external module cannot resolve
 * `astrobaas/core`: inside this repo that is a tsconfig path alias, and in a
 * deployment installed from git there is no such package at all. A module that
 * imports the host therefore fails to load in exactly the deployments it is
 * sold to. Passing the API in removes the problem, and guarantees the module
 * gets THIS host's hooks rather than a copy that may have drifted.
 *
 * ## Failure is loud, and never silent
 *
 * A module named here that will not load is a configuration error with business
 * consequences — on an optician's shop it means prescription validation stops
 * and lenses sell with nothing to grind. So a failure is logged prominently and
 * the id is reported to the caller, which surfaces it again after bootstrap if
 * the plugin's stored record says it should be active.
 *
 * Boot is NOT aborted. A shop that cannot start sells nothing at all, which is
 * strictly worse than one running without a vertical; the operator gets a loud
 * error and a working till.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Plugin } from '../lib/plugin-system';
import { definePlugin, PLUGIN_HOOKS } from '../core/index';
import { foldForSearch, transliterate } from '../lib/text-search';
import { apiRangeSatisfied, MANIFEST_API_VERSION } from '../core/manifest';
import {
  createPluginStore, isValidPluginId,
  type PluginDataBackend, type PluginStore,
} from '../lib/plugin-platform/store';
import { createPluginCatalog, type PluginCatalog } from '../lib/plugin-platform/catalog';
import { createPluginCoupons, type PluginCoupons } from '../lib/plugin-platform/coupons';
import { currencyExponent } from '../lib/money-format';
import {
  createPluginConsent, createPluginMail, type PluginConsent, type PluginMail,
} from '../lib/plugin-platform/consent-mail';

/**
 * What a factory-style external plugin is handed.
 *
 * `text` is here rather than reimplemented inside each module on purpose. A
 * search module that folds accents with its OWN copy of `foldForSearch` will
 * drift from the core's the first time either changes, and the symptom is a
 * search that silently stops matching some words — the sibling-gap failure this
 * codebase keeps paying for. The host owns the definition; modules borrow it.
 *
 * Additive: a module that only destructures `definePlugin` and `PLUGIN_HOOKS`
 * (optical, iris) is unaffected.
 */
export interface PluginHost {
  definePlugin: typeof definePlugin;
  PLUGIN_HOOKS: typeof PLUGIN_HOOKS;
  /** The core's text utilities, so a module cannot fold differently to the core. */
  text: {
    fold: (input: unknown) => string;
    transliterate: (input: string) => string;
  };
  /**
   * Every setting, as a key/value map.
   *
   * ASYNC, and therefore usable from an admin page's `render` but NOT from a
   * synchronous filter. That asymmetry is deliberate: a filter needing its own
   * configuration must be handed it by its (async) call site, because the only
   * ways to read it inside a filter are to block or to cache, and a cache would
   * keep answering with a value the operator has since changed.
   *
   * Returns a MAP, not the rows getSettings() returns. Casting that array to a
   * record type-checks and then reads every key as undefined — a mistake this
   * codebase has now made twice, so the host does the conversion once.
   */
  getSettings: () => Promise<Record<string, unknown>>;
  /**
   * The settings stored on a plugin's own record — what the operator edits
   * on its admin screen. Pass your own id: the factory runs before any
   * plugin it returns has been registered, so the host cannot bind it for
   * you. Inside a route handler, prefer `ctx.settings()`, which is scoped
   * for you.
   *
   * Read it where you use it rather than caching at activate(): an operator
   * who changes a setting does not restart the site.
   */
  getPluginSettings: (pluginId: string) => Promise<Record<string, unknown>>;
  /**
   * Your plugin's namespaced store, usable OUTSIDE a route handler — from a
   * filter, an action, a timer. The same records `ctx.store` and your
   * migrations see (`createPluginStore(id, LocalDB)`), so all paths agree.
   *
   * Pass your own id, for the same reason as `getPluginSettings`. It must be a
   * valid plugin id (letters, digits, `-`, `_`; no `@` or `/`), and an invalid
   * one throws HERE, at the call, rather than on the first read.
   *
   * Synchronous: it returns the store at once and opens storage lazily on the
   * first call, so a factory may build it before the database is ready.
   */
  createStore: (pluginId: string) => PluginStore;
  /**
   * Read-only product and brand reads. Every product in every status, as
   * COPIES, with `stock_status` derived and staff-only custom fields removed.
   * See `src/lib/plugin-platform/catalog.ts` for each rule and its reason.
   */
  catalog: PluginCatalog;
  /**
   * Issue, inspect and revoke discount codes — checked, priced and counted by
   * the core's own coupon rules. See `src/lib/plugin-platform/coupons.ts`.
   */
  coupons: PluginCoupons;
  /** The core's money rules, so a module cannot format a price differently. */
  money: {
    /** Decimal places for an ISO 4217 code: 0 (JPY), 3 (KWD) or 2. */
    currencyExponent: (currency: string) => number;
  };
  /**
   * Send one of YOUR declared webhook events (`webhookEvents` on the plugin)
   * through the core's webhook delivery: same signature, log, retries and
   * redeliver button as a core event.
   *
   * Rejects for an undeclared event, a core namespace (`order.*`,
   * `coupon.*`, …), another plugin's event, an inactive plugin, or `data`
   * that is not JSON or over 64 KB. Resolves once accepted, without waiting
   * for delivery. Bound to the plugins THIS module returned: a module that
   * returns several plugins may emit any of their events.
   */
  webhooks: {
    emit: (event: string, data: unknown) => Promise<void>;
  };
  /**
   * The consent ledger: `record`, `confirm` (double opt-in — confirms only when
   * the latest row is a grant), `withdraw`. Append-only; a confirmed
   * `newsletter` consent subscribes. See `src/lib/plugin-platform/consent-mail.ts`.
   */
  consent: PluginConsent;
  /**
   * Send one email through the configured core transport — never raw SMTP.
   * `category: 'bulk'` only reaches confirmed newsletter contacts and always
   * carries RFC 8058 one-click unsubscribe. See `consent-mail.ts`.
   */
  mail: PluginMail;
}

/**
 * The host object every factory-style external plugin receives.
 *
 * Built in one place so the loader and the tests hand plugins the same thing.
 *
 * `owners` is filled by the loader AFTER the factory returns, with the ids of
 * the plugins it produced — the factory runs before any id is known, so the
 * host cannot be bound at construction. `webhooks.emit` reads it per call;
 * until it is filled (or for a host nobody bound), every emit is refused.
 */
export function buildPluginHost(owners: Set<string> = new Set()): PluginHost {
  return {
    definePlugin,
    PLUGIN_HOOKS,
    text: { fold: foldForSearch, transliterate },
    getPluginSettings: async (pluginId: string) => {
      const { getPluginSettings } = await import('../lib/plugin-platform/settings');
      return getPluginSettings(pluginId);
    },
    getSettings: async () => {
      const { LocalDB } = await import('../lib/localdb');
      const rows = await LocalDB.getSettings();
      const map: Record<string, unknown> = Object.create(null);
      for (const r of rows) map[r.key] = r.value;
      return map;
    },
    createStore: (pluginId: string) => {
      if (!isValidPluginId(pluginId)) {
        throw new Error(
          `createStore: invalid plugin id "${String(pluginId)}" — letters, digits, dash and underscore, `
          + 'starting with a letter or digit (a package name such as "@acme/x" is not a plugin id)',
        );
      }
      // LocalDB is imported lazily, as getSettings does: the factory runs while
      // plugins load, and this module must not pull storage in at import time.
      const db = () => import('../lib/localdb').then((m) => m.LocalDB);
      const backend: PluginDataBackend = {
        getPluginData: async (ns) => (await db()).getPluginData(ns),
        getPluginDataRecord: async (ns, id) => (await db()).getPluginDataRecord(ns, id),
        putPluginData: async (ns, id, data) => (await db()).putPluginData(ns, id, data),
        deletePluginDataRecord: async (ns, id) => (await db()).deletePluginDataRecord(ns, id),
        deletePluginData: async (ns) => (await db()).deletePluginData(ns),
      };
      return createPluginStore(pluginId, backend);
    },
    catalog: createPluginCatalog(),
    coupons: createPluginCoupons(),
    money: { currencyExponent },
    webhooks: {
      emit: async (event: string, data: unknown) => {
        const { emitPluginWebhookEvent } = await import('../lib/plugin-platform/webhook-events');
        return emitPluginWebhookEvent(owners, event, data);
      },
    },
    consent: createPluginConsent(),
    mail: createPluginMail(),
  };
}

export interface ExternalLoadResult {
  plugins: Plugin[];
  /** Specifiers that were requested but did not produce a usable plugin. */
  failed: { specifier: string; reason: string }[];
}

/** Split the env value; blank entries and stray whitespace are ignored. */
export function parsePluginSpecifiers(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function looksLikePlugin(v: unknown): v is Plugin {
  return !!v && typeof v === 'object'
    && typeof (v as { id?: unknown }).id === 'string'
    && (v as { id: string }).id.length > 0;
}

/**
 * Import every specifier in `ASTROBAAS_PLUGINS` and resolve it to a Plugin.
 *
 * Never throws: every failure is collected and returned. The caller decides how
 * loudly to complain, because only it knows which plugins are supposed to be
 * active.
 */
export async function loadExternalPlugins(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ExternalLoadResult> {
  const specifiers = parsePluginSpecifiers(env.ASTROBAAS_PLUGINS);
  const plugins: Plugin[] = [];
  const failed: { specifier: string; reason: string }[] = [];

  for (const specifier of specifiers) {
    try {
      // A PATH is resolved against the project root, not against this file.
      //
      // `import('./plugins/mine.mjs')` resolves relative to the module doing the
      // importing — which is this one, buried in the build output — so an
      // operator pointing at a path in their own project gets a confusing "not
      // found" for a file that is plainly there. A bare package name is left
      // alone so normal node resolution finds it in node_modules.
      const isPath = specifier.startsWith('.') || specifier.startsWith('/');
      const target = isPath
        ? pathToFileURL(path.resolve(process.cwd(), specifier)).href
        : specifier;

      // `@vite-ignore`: the specifier is only known at runtime, so the bundler
      // must leave this as a real import rather than trying to resolve it at
      // build time — which is the entire point of loading from outside.
      const mod: unknown = await import(/* @vite-ignore */ target);
      const entry = (mod as { default?: unknown })?.default ?? mod;

      // One host per module, bound below to the plugins this module returns.
      const owners = new Set<string>();
      const resolved = typeof entry === 'function'
        ? (entry as (host: PluginHost) => unknown)(buildPluginHost(owners))
        : entry;

      // One module may carry SEVERAL plugins. That is what lets a customer who
      // has licensed three modules name one package instead of three, and never
      // touch their environment again when a fourth is added — the alternative
      // is an env change on every server for every purchase.
      const candidates = Array.isArray(resolved) ? resolved : [resolved];
      let usable = candidates.filter(looksLikePlugin);

      // Compatibility, refused at the door. A plugin built against a future
      // plugin API would otherwise load fine and fail somewhere deep at
      // request time, with a stack trace instead of a sentence. Same version
      // and same range rules as declarative manifests (`astrobaasApi`), so
      // "what am I compatible with" has one answer across both plugin kinds.
      const incompatible = usable.filter((pl) => {
        const range = (pl as { requiresCore?: unknown }).requiresCore;
        return typeof range === 'string' && range.trim() !== '' && !apiRangeSatisfied(range);
      });
      for (const pl of incompatible) {
        failed.push({
          specifier,
          reason: `plugin "${(pl as { id?: string }).id}" requires core "${(pl as { requiresCore?: string }).requiresCore}", `
            + `but this host provides plugin API ${MANIFEST_API_VERSION}`,
        });
      }
      if (incompatible.length > 0) {
        usable = usable.filter((pl) => !incompatible.includes(pl));
      }
      if (usable.length !== candidates.length || usable.length === 0) {
        failed.push({
          specifier,
          reason: usable.length === 0
            ? 'default export is not a plugin, an array of plugins, or a factory returning either'
            : `${candidates.length - usable.length} of ${candidates.length} exported entries were not plugins`,
        });
        if (usable.length === 0) continue;
      }
      for (const pl of usable) owners.add(pl.id);
      plugins.push(...usable);
    } catch (err) {
      failed.push({ specifier, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  return { plugins, failed };
}
