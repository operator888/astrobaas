/**
 * Priced per-line add-ons: `PLUGIN_HOOKS.ORDER_LINE_ADDONS`.
 *
 * A storefront sends a selection on a line, keyed by namespace:
 *
 *     { product_id, qty, addons: { lens: ['ar', 'index-160'] } }
 *
 * The core does not know what `lens` means. It checks the SHAPE strictly,
 * asks the plugins to price it inside `priceBasket` (so the quote and the
 * order price it identically), adds the result to the line's unit price
 * before coupons and tax, and freezes the add-ons onto the order line.
 *
 * Everything here FAILS CLOSED. The alternative to refusing is charging a
 * customer for a lens without the coating they chose, or shipping the coating
 * without charging for it, and neither is visible until somebody complains:
 *
 *  - an unknown shape is a 400 that names the problem;
 *  - a selection no installed plugin handles is a 400, never dropped;
 *  - a selection the plugins handled but priced as nothing is a 400 — this
 *    is also what catches a filter `applyFilters` would otherwise swallow;
 *  - a filter that throws, returns a Promise or returns garbage refuses the
 *    line (500), because the result can no longer be trusted.
 */

import type { OrderLineAddon, Product } from '../../core/models';
import { pluginManager as defaultPluginManager, PLUGIN_HOOKS, type PluginManager } from '../plugin-system';

/**
 * OWNER DECISION — do coupons discount add-ons?
 *
 * `true`: an add-on is part of the line's price, so a percentage coupon, a
 * category-restricted coupon (judged on the line's product) and a
 * minimum-spend threshold all see it. This is what the optical module's
 * contract assumes.
 *
 * `false`: coupons are judged on the product price alone — the add-on is
 * excluded from each line's coupon amount and from the minimum-spend
 * subtotal. The free-shipping threshold and tax still see the full price.
 *
 * Changing it changes the NEXT quote and order only; a placed order keeps
 * the discount it was charged.
 */
export const COUPONS_DISCOUNT_ADDONS = true;

/** Bounds on what a client may send, per line. */
export const ADDON_REQUEST_LIMITS = {
  /** Distinct namespaces on one line. */
  namespaces: 8,
  /** The whole `addons` value, serialised. */
  bytes: 2048,
  /** Nesting depth inside one namespace's value. */
  depth: 4,
} as const;

/** Bounds on what a plugin may return, per line. */
export const ADDON_RESULT_LIMITS = {
  addons: 32,
  idLength: 100,
  labelLength: 200,
  tagLength: 64,
  /** €10M per unit — far beyond any add-on, well inside safe integers. */
  maxUnitCents: 1_000_000_000,
} as const;

const NAMESPACE_RE = /^[a-z][a-z0-9_-]{0,31}$/;

export type AddonRefusal = {
  ok: false;
  status: number;
  message: string;
  code: string;
  params?: Record<string, string | number>;
};

const refuse = (
  status: number, code: string, message: string, params?: Record<string, string | number>,
): AddonRefusal => ({ ok: false, status, message, code, ...(params ? { params } : {}) });

/**
 * Whether a namespace's value is a SELECTION at all. `null`, `[]`, `{}` and
 * `''` mean "nothing chosen" — a cart that clears a choice sends one of them,
 * and refusing it as "unpriced" would punish the shopper for un-choosing.
 */
export function isEmptySelection(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v as object).length === 0;
  return false;
}

/** JSON-only values, bounded in depth. Returns the first problem, or null. */
function shapeProblem(v: unknown, depth: number): string | null {
  if (depth > ADDON_REQUEST_LIMITS.depth) return `is nested deeper than ${ADDON_REQUEST_LIMITS.depth} levels`;
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? null : 'contains a number that is not finite';
  if (Array.isArray(v)) {
    for (const x of v) {
      const p = shapeProblem(x, depth + 1);
      if (p) return p;
    }
    return null;
  }
  if (typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    for (const x of Object.values(v as Record<string, unknown>)) {
      const p = shapeProblem(x, depth + 1);
      if (p) return p;
    }
    return null;
  }
  return `contains a value of type ${typeof v}`;
}

export type ParsedAddons =
  | { ok: true; value: Record<string, unknown> | undefined; selected: string[] }
  | AddonRefusal;

/**
 * Check a line's `addons` value. STRICT: anything that is not an object of
 * namespaced, JSON-only, bounded selections is refused with a message naming
 * the problem — never coerced, never dropped.
 *
 * `selected` lists the namespaces that carry a real selection (see
 * `isEmptySelection`); only those must be priced.
 */
export function parseLineAddons(raw: unknown, lineName = 'this item'): ParsedAddons {
  if (raw === undefined || raw === null) return { ok: true, value: undefined, selected: [] };
  const bad = (problem: string, params: Record<string, string | number> = {}) =>
    refuse(400, 'checkout.addons_invalid', `Add-ons for ${lineName}: ${problem}`, { problem, ...params });

  if (typeof raw !== 'object' || Array.isArray(raw) || Object.getPrototypeOf(raw) !== Object.prototype) {
    return bad('must be an object keyed by add-on type, e.g. { "lens": ["ar"] }');
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > ADDON_REQUEST_LIMITS.namespaces) {
    return bad(`has more than ${ADDON_REQUEST_LIMITS.namespaces} add-on types`);
  }
  for (const [key, value] of entries) {
    if (!NAMESPACE_RE.test(key)) {
      return bad(`"${key.slice(0, 40)}" is not a valid add-on type (lower-case letters, digits, - and _, starting with a letter)`, { namespace: key.slice(0, 40) });
    }
    const p = shapeProblem(value, 1);
    if (p) return bad(`"${key}" ${p}`, { namespace: key });
  }
  let size = 0;
  try { size = JSON.stringify(raw).length; } catch { return bad('cannot be serialised'); }
  if (size > ADDON_REQUEST_LIMITS.bytes) {
    return bad(`are larger than ${ADDON_REQUEST_LIMITS.bytes} bytes`);
  }
  const selected = entries.filter(([, v]) => !isEmptySelection(v)).map(([k]) => k);
  return { ok: true, value: raw as Record<string, unknown>, selected };
}

const isTag = (v: unknown) => typeof v === 'string' && v.trim() !== '' && v.length <= ADDON_RESULT_LIMITS.tagLength;

/** Rebuild one returned add-on field by field, or say why it cannot be used. */
function cleanAddon(a: unknown): { ok: true; value: OrderLineAddon } | { ok: false; why: string } {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return { ok: false, why: 'an add-on is not an object' };
  const r = a as Record<string, unknown>;
  const id = typeof r.id === 'string' ? r.id.trim() : '';
  const label = typeof r.label === 'string' ? r.label.trim() : '';
  if (!id || id.length > ADDON_RESULT_LIMITS.idLength) return { ok: false, why: 'an add-on has no valid id' };
  if (!label || label.length > ADDON_RESULT_LIMITS.labelLength) return { ok: false, why: `add-on "${id}" has no valid label` };
  const cents = r.unit_price_cents;
  if (typeof cents !== 'number' || !Number.isInteger(cents) || cents < 0 || cents > ADDON_RESULT_LIMITS.maxUnitCents) {
    return { ok: false, why: `add-on "${id}" has an invalid unit_price_cents (integer cents, 0 or more)` };
  }
  for (const k of ['source', 'kind', 'namespace'] as const) {
    if (r[k] !== undefined && !isTag(r[k])) return { ok: false, why: `add-on "${id}" has an invalid ${k}` };
  }
  return {
    ok: true,
    value: {
      id, label, unit_price_cents: cents,
      ...(r.source !== undefined ? { source: String(r.source) } : {}),
      ...(r.kind !== undefined ? { kind: String(r.kind) } : {}),
      ...(r.namespace !== undefined ? { namespace: String(r.namespace) } : {}),
    },
  };
}

export type PricedAddons =
  | { ok: true; addons: OrderLineAddon[]; unit_cents: number }
  | AddonRefusal;

/**
 * Ask the plugins to price one line's add-ons. Called by `priceBasket` only.
 *
 * `line` is the request line exactly as the route passed it; the filter gets a
 * COPY, so one filter editing it cannot change what the next one, or the
 * rest of pricing, reads.
 */
export function priceLineAddons(
  input: {
    line: Record<string, unknown>;
    product: Product;
    variant: unknown;
    qty: number;
    name: string;
    settings: Record<string, unknown>;
  },
  pm: Pick<PluginManager, 'applyFiltersReporting' | 'hasFilter'> = defaultPluginManager,
): PricedAddons {
  const parsed = parseLineAddons(input.line.addons, input.name);
  if (!parsed.ok) return parsed;
  const hook = PLUGIN_HOOKS.ORDER_LINE_ADDONS;
  const handled = pm.hasFilter(hook);

  if (!handled) {
    if (parsed.selected.length) {
      const ns = parsed.selected[0];
      return refuse(400, 'checkout.addons_unsupported',
        `Add-ons of type "${ns}" for ${input.name} are not available in this shop. Please remove them and try again.`,
        { namespace: ns });
    }
    return { ok: true, addons: [], unit_cents: 0 };
  }

  let copy: Record<string, unknown>;
  try {
    copy = structuredClone(input.line);
  } catch {
    // A line that cannot be cloned did not come from JSON. parseLineAddons
    // already vetted `addons`; anything else on it is the caller's own.
    copy = { ...input.line };
  }
  const { value: result, threw } = pm.applyFiltersReporting(
    hook,
    { ok: true, addons: [] },
    {
      line: copy,
      product: input.product,
      variant: input.variant,
      qty: input.qty,
      name: input.name,
      settings: { ...input.settings },
    },
  );

  const broken = (why: string) => {
    console.error(`[astrobaas] ORDER_LINE_ADDONS: refused ${input.name}: ${why}`);
    return refuse(500, 'checkout.addons_failed',
      `The add-ons for ${input.name} could not be priced. Nothing was charged; please try again or contact the shop.`);
  };

  if (threw) return broken('a filter threw');
  if (result && typeof (result as { then?: unknown }).then === 'function') {
    // Swallow its outcome so a rejection is not an unhandled one.
    Promise.resolve(result).catch(() => {});
    return broken('a filter returned a Promise (filters are synchronous)');
  }
  if (!result || typeof result !== 'object' || typeof (result as { ok?: unknown }).ok !== 'boolean') {
    return broken('the result is not { ok, ... }');
  }
  if (result.ok === false) {
    const message = typeof result.message === 'string' && result.message.trim()
      ? result.message
      : `The add-ons for ${input.name} cannot be supplied`;
    const code = typeof result.code === 'string' && result.code.trim() ? result.code : 'checkout.addons_refused';
    const params: Record<string, string | number> = {};
    if (result.params && typeof result.params === 'object') {
      for (const [k, v] of Object.entries(result.params as Record<string, unknown>)) {
        if (typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))) params[k] = v;
      }
    }
    return refuse(400, code, message, Object.keys(params).length ? params : undefined);
  }
  if (!Array.isArray(result.addons)) return broken('`addons` is not an array');
  if (result.addons.length > ADDON_RESULT_LIMITS.addons) {
    return broken(`more than ${ADDON_RESULT_LIMITS.addons} add-ons on one line`);
  }
  const addons: OrderLineAddon[] = [];
  for (const a of result.addons) {
    const c = cleanAddon(a);
    if (!c.ok) return broken(c.why);
    addons.push(c.value);
  }

  /*
   * Every selection must have produced something.
   *
   * A tagged add-on (`namespace`) answers its own key. Untagged add-ons
   * answer AT MOST ONE key: exact for the usual one key per line, and a
   * second key (a typo, a module that is not installed) is still refused
   * rather than hidden behind another plugin's untagged add-on.
   */
  const untagged = addons.some((a) => a.namespace === undefined);
  const unpriced = parsed.selected.filter((ns) => !addons.some((a) => a.namespace === ns));
  if (unpriced.length > (untagged ? 1 : 0)) {
    const ns = unpriced[untagged ? 1 : 0];
    return refuse(400, 'checkout.addons_unpriced',
      `The "${ns}" add-ons chosen for ${input.name} could not be priced. Please choose again.`,
      { namespace: ns });
  }

  const unit_cents = addons.reduce((s, a) => s + a.unit_price_cents, 0);
  return { ok: true, addons, unit_cents };
}
