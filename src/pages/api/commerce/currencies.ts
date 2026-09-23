import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { getShopCurrency } from '../../../lib/commerce-service';
import {
  CURRENCY_KEYS, resolveCurrencySettings, normalizeCurrencyRates, offeredCurrencies,
} from '../../../lib/commerce/currency-rates';
import { recordAudit, AUDIT } from '../../../lib/audit';

/**
 * The shop's currencies and the rates it quotes them at.
 *
 * GET is PUBLIC. A storefront has to render a currency picker before anyone has
 * signed in, and a rate is not a secret — the customer is about to be quoted
 * it. The same reasoning `/api/shipping-methods` already applies to postage.
 *
 * PUT is ADMIN, and it exists as a dedicated route rather than going through
 * `POST /api/settings/update` for one reason: **`updated_at` must be stamped by
 * the server.** Staleness is the entire safety mechanism here — the operator
 * types the rate, so the only defence against quoting a year-old number is
 * knowing when it was typed. A client-settable timestamp defeats that
 * completely, and the generic settings endpoint cannot stamp it.
 */
export const prerender = false;

export const GET: APIRoute = async () => {
  try {
    await LocalDB.init();
    const rows = await LocalDB.getSettings();
    const map: Record<string, unknown> = {};
    for (const r of rows) map[r.key] = r.value;
    const settings = resolveCurrencySettings(map, await getShopCurrency());

    return ApiResponseBuilder.success({
      base: settings.base,
      available: offeredCurrencies(settings),
      // Disabled rates are omitted from the PUBLIC view: a currency the shop
      // has switched off is not on offer, and listing it invites a storefront
      // to render a picker entry that checkout will silently ignore.
      rates: settings.rates
        .filter((r) => r.enabled)
        .map((r) => ({
          code: r.code,
          rate_ppm: r.rate_ppm,
          updated_at: r.updated_at,
          // Published deliberately. A storefront may want to mark a price
          // "indicative" rather than pretend a stale rate is current.
          stale: r.stale,
        })),
    });
  } catch (err) {
    console.error('Currencies list error:', err);
    return ApiResponseBuilder.serverError('Failed to list currencies');
  }
};

export const PUT: APIRoute = async ({ request, locals }) => {
  try {
    await LocalDB.init();
    if (locals.user?.role !== 'admin') return ApiResponseBuilder.forbidden('Admin only');

    const body = await request.json().catch(() => null);
    const incoming = (body as { rates?: unknown })?.rates;
    if (!Array.isArray(incoming)) {
      return ApiResponseBuilder.badRequest('rates must be an array');
    }

    const base = await getShopCurrency();
    const rows = await LocalDB.getSettings();
    const map: Record<string, unknown> = {};
    for (const r of rows) map[r.key] = r.value;
    const existing = normalizeCurrencyRates(map[CURRENCY_KEYS.rates], base);
    const previous = new Map(existing.map((r) => [r.code, r]));

    const now = new Date().toISOString();
    const cleaned = normalizeCurrencyRates(incoming, base).map((r) => {
      const before = previous.get(r.code);
      /*
       * The timestamp moves only when the NUMBER moves.
       *
       * Re-stamping every row on every save would make "when was this rate
       * set?" mean "when did somebody last open this screen", and a stale rate
       * would be laundered into a fresh one by an unrelated edit — toggling a
       * different currency off would silently vouch for all of them.
       */
      const unchanged = before && before.rate_ppm === r.rate_ppm;
      return {
        ...r,
        updated_at: unchanged ? before.updated_at : now,
        updated_by: unchanged ? before.updated_by : (locals.user?.id ?? undefined),
      };
    });

    await LocalDB.updateSetting(CURRENCY_KEYS.rates, cleaned);

    // A money change with no trail is a gap. Record WHICH rates moved, not just
    // that the screen was saved.
    const changed = cleaned
      .filter((r) => previous.get(r.code)?.rate_ppm !== r.rate_ppm)
      .map((r) => `${r.code}=${r.rate_ppm}`);
    const removed = existing.filter((r) => !cleaned.some((c) => c.code === r.code)).map((r) => r.code);
    recordAudit(AUDIT.CURRENCY_RATES_UPDATE, {
      actor: locals.user?.id,
      target: CURRENCY_KEYS.rates,
      metadata: { changed, removed, count: cleaned.length },
    });

    const settings = resolveCurrencySettings(
      { ...map, [CURRENCY_KEYS.rates]: cleaned }, base,
    );
    return ApiResponseBuilder.success(
      { base: settings.base, rates: settings.rates },
      'Currency rates saved',
    );
  } catch (err) {
    console.error('Currencies save error:', err);
    return ApiResponseBuilder.serverError('Failed to save currency rates');
  }
};
