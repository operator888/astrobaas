/**
 * The tax settings EVERY pricing path uses: the operator's, plus whatever a
 * `PLUGIN_HOOKS.TAX_RATES` filter supplies.
 *
 * One function, so the quote, the order and the tax override cannot disagree
 * about the same sale. `priceBasket` (quote + order) and
 * `POST /api/orders/{id}/tax-override` call this; nothing that prices calls
 * `resolveTaxSettings` directly. (`commerce-service`'s origin-country read
 * does, and needs no rates.)
 *
 * Kept out of `tax.ts` so that module stays pure — no plugin registry, no
 * logging — and can be bundled on its own by tests and by paid packages'
 * contract tests.
 */
import { pluginManager as defaultManager, PLUGIN_HOOKS, type PluginManager } from '../plugin-system';
import { mergeSuppliedTaxRates, resolveTaxSettings, type TaxRateDrop, type TaxSettings } from './tax';

/*
 * Each distinct drop is logged once per process. A cart re-quotes on every
 * change, and the same overridden row on every quote would bury the log; a
 * restart logs them again. Bounded: after MAX_LOGGED distinct lines one
 * notice says so and the rest are not logged until a restart, so a plugin
 * producing endless distinct garbage can neither grow the set nor flood the log.
 */
const MAX_LOGGED = 1000;
const logged = new Set<string>();
function logDrop(d: TaxRateDrop): void {
  let row: string;
  try { row = JSON.stringify(d.row) ?? String(d.row); } catch { row = String(d.row); }
  const msg = `[astrobaas] TAX_RATES: a plugin-supplied rate row was not used (${d.reason}): ${row.slice(0, 300)}`;
  if (logged.has(msg)) return;
  if (logged.size >= MAX_LOGGED) return;
  logged.add(msg);
  console.warn(msg);
  if (logged.size === MAX_LOGGED) {
    console.warn(`[astrobaas] TAX_RATES: ${MAX_LOGGED} distinct dropped rows logged; further ones are not logged until a restart.`);
  }
}

/**
 * A deep copy of the settings for the filter, so a plugin that edits
 * `ctx.settings` cannot change what the rest of this pricing reads (the
 * TAX_ID_VERDICT filter is handed the same map). Settings are JSON values.
 */
function copySettings(settings: Record<string, unknown> | null | undefined): Record<string, unknown> {
  try { return structuredClone(settings ?? {}); } catch { return { ...(settings ?? {}) }; }
}

export function resolveTaxSettingsWithPlugins(
  settings: Record<string, unknown> | null | undefined,
  manager: Pick<PluginManager, 'hasFilter' | 'applyFiltersReporting'> = defaultManager,
): TaxSettings {
  const base = resolveTaxSettings(settings);
  if (!manager.hasFilter(PLUGIN_HOOKS.TAX_RATES)) return base;
  // Tax off: no rate is ever charged. No shop_country: every sale is
  // domestic, the domestic ladder is the operator's, and without an origin
  // the core cannot tell a foreign row from a home one — so nothing to add.
  if (!base.enabled || !base.originCountry) return base;

  // A COPY, rows included: a filter that edits what it is handed must not be
  // able to rewrite the operator's rows.
  const handed = base.rates.map((r) => ({ ...r, ...(r.postcodes ? { postcodes: [...r.postcodes] } : {}) }));
  const { value, threw } = manager.applyFiltersReporting(
    PLUGIN_HOOKS.TAX_RATES, handed, { settings: copySettings(settings) },
  );
  // Fail closed. `applyFiltersReporting` has already logged the error.
  if (threw) return base;
  if (value === handed) return base;
  if (value && typeof (value as Promise<unknown>).then === 'function') {
    // Swallow a rejection here, once: unobserved, it would surface as an
    // unhandledRejection on every quote.
    Promise.resolve(value).catch(() => {});
    logDrop({ row: '[Promise]', reason: 'the filter is async; TAX_RATES filters must be synchronous. The operator\'s rates are used alone' });
    return base;
  }
  const rates = mergeSuppliedTaxRates(base, value, logDrop);
  return rates === base.rates ? base : { ...base, rates };
}
