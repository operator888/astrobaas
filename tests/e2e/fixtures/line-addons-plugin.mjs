/**
 * e2e fixture: a plugin pricing add-ons on PLUGIN_HOOKS.ORDER_LINE_ADDONS, for
 * tests/e2e/order-line-addons.spec.ts.
 *
 * Inert unless a line sends `addons: { "e2e-engrave": [...] }`, a namespace no
 * other spec uses, so loading it for the whole e2e server changes nothing for
 * any other test. Loaded through ASTROBAAS_PLUGINS in playwright.config.ts, the
 * same path a paid module takes.
 */
export default function ({ definePlugin, PLUGIN_HOOKS }) {
  const OPTIONS = {
    engrave: { label: 'Engraving', unit_price_cents: 900 },
    case: { label: 'Hard case', unit_price_cents: 1500 },
  };
  return definePlugin({
    id: 'e2e-line-addons',
    name: 'E2E line add-ons',
    version: '1.0.0',
    description: 'Test fixture: prices the e2e-engrave add-ons.',
    author: 'AstroBaaS tests',
    // Declared only so tests/e2e/plugin-game-seams.spec.ts can see a plugin
    // event listed on Admin → Webhooks. Nothing emits it.
    webhookEvents: ['e2e.engraved'],
    filters: PLUGIN_HOOKS.ORDER_LINE_ADDONS
      ? {
        [PLUGIN_HOOKS.ORDER_LINE_ADDONS]: (current, ctx) => {
          if (!current || !current.ok) return current;
          const sel = ctx?.line?.addons?.['e2e-engrave'];
          if (!Array.isArray(sel) || sel.length === 0) return current;
          const out = [];
          for (const id of sel) {
            const o = OPTIONS[id];
            if (!o) return { ok: false, message: `Unknown option ${id}`, code: 'e2e.unknown_option', params: { option: String(id) } };
            out.push({ id, ...o, source: 'e2e-line-addons', namespace: 'e2e-engrave' });
          }
          return { ok: true, addons: [...current.addons, ...out] };
        },
      }
      : {},
  });
}
