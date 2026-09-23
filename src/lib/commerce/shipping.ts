/**
 * Shipping methods, zones and rate calculation.
 *
 * Pure. A shipping cost is money the customer is charged, so it is decided
 * server-side and quoted from the same code that later charges it — a
 * storefront that computes its own postage can be edited in devtools.
 *
 * ## Zones need postcodes, not just countries
 *
 * The obvious model is "a list of countries per zone", and it is wrong for the
 * actual shop this was built for: Greece is one country whose island postcodes
 * carry a surcharge and whose remote islands sometimes cannot be served at all.
 * A country-only model forces an operator to either overcharge Athens or
 * undercharge Rhodes. So a zone matches on country AND an optional set of
 * postcode patterns, and the most specific matching zone wins.
 */

/** How a method prices a basket. */
export type ShippingRate =
  /** One price, whatever the basket. */
  | { kind: 'flat'; amount_cents: number }
  /**
   * Base plus a per-kilogram component, using the products' own weights.
   * Weight is summed in grams and billed per STARTED kilogram — couriers bill
   * that way, and billing fractional kilos would under-recover on every parcel.
   */
  | { kind: 'weight'; base_cents: number; per_kg_cents: number }
  /** Free once the basket reaches a threshold, otherwise a flat price. */
  | { kind: 'free_over'; threshold_cents: number; otherwise_cents: number };

export interface ShippingZone {
  /** ISO-3166 alpha-2, upper-case. `['*']` matches anywhere. */
  countries: string[];
  /**
   * Optional postcode patterns. Absent = the whole country.
   *   "84600"        exact
   *   "846*"         prefix
   *   "84000-84999"  inclusive numeric range
   */
  postcodes?: string[];
}

export interface ShippingMethod {
  id: string;
  name: string;
  enabled: boolean;
  zone: ShippingZone;
  rate: ShippingRate;
  /** Tax class for the shipping line. Falls back to the configured default. */
  tax_class?: string;
  /** Optional weight bounds in grams — a courier that will not take 30 kg. */
  min_weight_grams?: number | null;
  max_weight_grams?: number | null;
  /** Lower sorts first in the storefront's list. */
  position?: number;
  /** Shown under the name at checkout ("2–4 working days"). */
  description?: string;
  created_at: string;
  updated_at: string;
}

/** A destination, as much as a storefront knows before the address form. */
export interface ShippingDestination {
  /** ISO-3166 alpha-2. Case-insensitive on the way in. */
  country?: string;
  postcode?: string;
}

/** Normalise a postcode for matching: strip spaces/dashes, upper-case. */
export function normalizePostcode(raw: unknown): string {
  return typeof raw === 'string' ? raw.replace(/[\s-]/g, '').toUpperCase() : '';
}

/**
 * Does `postcode` match one pattern?
 *
 * Range matching is NUMERIC, not lexicographic: "84000-84999" must include
 * "84600", and a string compare would also wrongly include "8412345".
 */
export function postcodeMatches(pattern: string, postcode: string): boolean {
  // The RANGE form is parsed before normalisation, because normalisation strips
  // dashes — it has to, so "846 00" and "846-00" match a stored "84600" — and
  // stripping the dash out of "84000-84999" first would turn the range into the
  // nonsense literal "8400084999". (Caught by a test, not by reading.)
  const rawPattern = typeof pattern === 'string' ? pattern.trim().toUpperCase() : '';
  const pc = normalizePostcode(postcode);
  if (!rawPattern || !pc) return false;

  const range = /^(\d+)\s*-\s*(\d+)$/.exec(rawPattern);
  if (range) {
    if (!/^\d+$/.test(pc)) return false;
    const lo = Number(range[1]);
    const hi = Number(range[2]);
    const n = Number(pc);
    // Tolerate a reversed range rather than silently matching nothing.
    return n >= Math.min(lo, hi) && n <= Math.max(lo, hi);
  }

  const pat = normalizePostcode(rawPattern);
  if (!pat) return false;
  if (pat.endsWith('*')) return pc.startsWith(pat.slice(0, -1));
  return pc === pat;
}

export function zoneMatches(zone: ShippingZone, dest: ShippingDestination): boolean {
  const country = (dest.country ?? '').trim().toUpperCase();
  const countries = (zone.countries ?? []).map((c) => c.trim().toUpperCase());
  const countryOk = countries.includes('*') || (!!country && countries.includes(country));
  if (!countryOk) return false;

  const patterns = zone.postcodes ?? [];
  if (!patterns.length) return true; // whole country
  const pc = normalizePostcode(dest.postcode);
  // A postcode-restricted zone cannot match a destination with no postcode —
  // guessing here would quote an island rate for an Athens address, or worse.
  if (!pc) return false;
  return patterns.some((p) => postcodeMatches(p, pc));
}

/**
 * How specific is this zone? Higher wins when several match.
 *
 * Without this, an "all of Greece" method and an "islands surcharge" method
 * both match a Rhodes postcode and the winner depends on insertion order.
 */
export function zoneSpecificity(zone: ShippingZone): number {
  const countries = (zone.countries ?? []).map((c) => c.trim().toUpperCase());
  let score = countries.includes('*') ? 0 : 10;
  if ((zone.postcodes ?? []).length) score += 100;
  return score;
}

export interface ShippableBasket {
  /** Sum of the goods, in the same tax convention as the caller's prices. */
  subtotal_cents: number;
  /** Total weight of items that require shipping, in grams. */
  weight_grams: number;
  /** False when nothing in the basket is a physical good. */
  requiresShipping: boolean;
}

/** Cost of one method for one basket, or null when it does not apply. */
export function rateFor(method: ShippingMethod, basket: ShippableBasket): number | null {
  if (!method.enabled) return null;
  if (!basket.requiresShipping) return null;

  const w = basket.weight_grams;
  if (method.min_weight_grams != null && w < method.min_weight_grams) return null;
  if (method.max_weight_grams != null && w > method.max_weight_grams) return null;

  const r = method.rate;
  switch (r.kind) {
    case 'flat':
      return Math.max(0, Math.round(r.amount_cents));
    case 'weight': {
      // Per STARTED kilogram: 1200 g is billed as 2 kg, like a courier does.
      const kg = Math.ceil(Math.max(0, w) / 1000);
      return Math.max(0, Math.round(r.base_cents) + Math.round(r.per_kg_cents) * kg);
    }
    case 'free_over':
      return basket.subtotal_cents >= r.threshold_cents ? 0 : Math.max(0, Math.round(r.otherwise_cents));
    default:
      return null;
  }
}

export interface AvailableMethod {
  id: string;
  name: string;
  description?: string;
  cost_cents: number;
  tax_class?: string;
}

/**
 * Methods a customer may choose, cheapest-looking order preserved by position.
 *
 * Only the most specific matching zone's methods are offered. Returning both a
 * national and an island method for the same address would let a customer pick
 * the mainland price for a Rhodes delivery.
 */
export function availableMethods(
  methods: readonly ShippingMethod[],
  dest: ShippingDestination,
  basket: ShippableBasket,
): AvailableMethod[] {
  if (!basket.requiresShipping) return [];

  const matching = methods.filter((m) => m.enabled && zoneMatches(m.zone, dest));
  if (!matching.length) return [];

  const best = Math.max(...matching.map((m) => zoneSpecificity(m.zone)));
  const out: AvailableMethod[] = [];
  for (const m of matching) {
    if (zoneSpecificity(m.zone) !== best) continue;
    const cost = rateFor(m, basket);
    if (cost === null) continue; // weight bounds excluded it
    out.push({
      id: m.id,
      name: m.name,
      description: m.description,
      cost_cents: cost,
      tax_class: m.tax_class,
    });
  }

  const positionOf = (id: string) =>
    methods.find((m) => m.id === id)?.position ?? Number.MAX_SAFE_INTEGER;
  return out.sort((a, b) => {
    const pa = positionOf(a.id);
    const pb = positionOf(b.id);
    return pa !== pb ? pa - pb : a.cost_cents - b.cost_cents;
  });
}

/**
 * Resolve the customer's chosen method to a cost, server-side.
 *
 * The client sends an ID, never an amount. This re-derives the price from the
 * stored method and the actual basket, so a tampered request cannot pay 1 cent
 * of postage — and a stale method id (deleted, or no longer serving that
 * postcode) is rejected rather than falling back to free.
 */
export function resolveChosenMethod(
  methods: readonly ShippingMethod[],
  chosenId: string | undefined | null,
  dest: ShippingDestination,
  basket: ShippableBasket,
): { ok: true; method: AvailableMethod | null } | { ok: false; reason: string } {
  if (!basket.requiresShipping) return { ok: true, method: null };

  const options = availableMethods(methods, dest, basket);
  if (!chosenId) {
    // No choice made: only acceptable when there is genuinely nothing to choose.
    if (!options.length) return { ok: true, method: null };
    return { ok: false, reason: 'A shipping method must be selected for this destination' };
  }

  const picked = options.find((m) => m.id === chosenId);
  if (!picked) {
    return { ok: false, reason: 'That shipping method is not available for this destination or basket' };
  }
  return { ok: true, method: picked };
}
