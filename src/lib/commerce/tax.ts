/**
 * VAT / sales tax.
 *
 * Rates are DATA, never constants. Greece alone has a standard rate, two
 * reduced rates, and product-specific treatment (prescription optical goods are
 * not all at the standard rate), and every one of those numbers has moved
 * within living memory. A rate compiled into the source is a rate that will be
 * wrong, in a way that under- or over-charges real customers.
 *
 * ## Two invariants, and why they are not negotiable
 *
 * **1. `net + tax === gross`, exactly, always.**
 * Computing net and tax independently and hoping they reconcile produces
 * invoices that are off by a cent, which an accountant will reject and a tax
 * authority will query. So one side is computed and the other is SUBTRACTED.
 *
 * **2. Money is integer minor units.** A rate is stored in basis points
 * (2400 = 24%) so the rate itself is an integer too — `0.24` would reintroduce
 * float error at the multiply.
 *
 * ## Inclusive vs exclusive
 *
 * Greek retail displays VAT-inclusive prices, so the common case here is
 * EXTRACTING the tax already inside the price, not adding to it. Both are
 * supported because a B2B install needs the other. Getting this backwards is a
 * ~19% error on every order, which is why it is a per-install flag with no
 * default that silently guesses.
 */
import { settingBool } from '../settings-map';
import { postcodeMatches } from './shipping';

/** Settings keys, exported so the admin form and the reader cannot drift. */
export const TAX_KEYS = {
  enabled: 'tax_enabled',
  pricesIncludeTax: 'tax_prices_include_tax',
  defaultClass: 'tax_default_class',
  rates: 'tax_rates',
  shippingClass: 'tax_shipping_class',
  /**
   * The seller's own country, ISO 3166-1 alpha-2.
   *
   * **It never defaults.** Not to 'GR', not to anything. Inventing the seller's
   * country invents a tax position, and the whole engine below is a function of
   * where the shop is — so an unset origin means destination resolution stays
   * OFF rather than quietly guessing.
   */
  originCountry: 'shop_country',
  /** 'off' (or absent) | 'oss'. Cannot be 'oss' while shop_country is unset. */
  destinationMode: 'tax_destination_mode',
  /** Absent = off. Zero-rate an EU B2B sale to a customer with a VAT id. */
  reverseCharge: 'tax_reverse_charge_enabled',
  /** Which countries are in the EU VAT territory. A SEED, operator-editable. */
  euCountries: 'tax_eu_countries',
} as const;

export interface TaxRate {
  /** Tax class slug. Matches `Product.tax_class`. */
  class: string;
  label: string;
  /** Basis points. 2400 = 24%. Integer by construction. */
  rate_bp: number;
  /**
   * ISO 3166-1 alpha-2 of the jurisdiction this rate belongs to.
   *
   * **ABSENT MEANS THE SHOP'S OWN COUNTRY** — which is every row that exists
   * today, and why this needed no migration.
   *
   * Core ships ZERO foreign rows. A member state's rates change continuously
   * and getting one wrong is the merchant's liability, so maintained rate
   * tables are a paid pack's job; what core owns is the RESOLUTION — deciding
   * whose rate applies — and a place to put the answer.
   */
  country?: string;
  /**
   * Optional postcode patterns, in the SAME grammar `ShippingZone.postcodes`
   * uses and matched by the SAME function (`postcodeMatches`).
   *
   * This is what lets one row express a special territory — Άγιο Όρος, the
   * Canaries, Livigno — without a second matcher that could disagree with the
   * shipping one about what counts as an island.
   */
  postcodes?: string[];
}

export interface TaxSettings {
  enabled: boolean;
  /** True when stored prices already contain tax (normal EU retail). */
  pricesIncludeTax: boolean;
  /** Class used when a product names none. */
  defaultClass: string;
  rates: TaxRate[];
  /** Class applied to the shipping line. */
  shippingClass: string;
  /** The seller's country, ISO-2. Undefined when the operator has not said —
   *  and that is why destination resolution stays off. */
  originCountry?: string;
  /** Destination resolution. 'off' unless the operator turned it on AND an
   *  origin country exists. */
  destinationMode: 'off' | 'oss';
  /** Zero-rate an EU B2B sale to a customer who supplied a VAT id. */
  reverseCharge: boolean;
  /** Countries treated as inside the EU VAT territory. */
  euCountries: string[];
}

/**
 * Seed rates.
 *
 * These are a STARTING POINT for a Greek shop, not an assertion about current
 * law: rates change, island regimes change, and which optical goods qualify for
 * a reduced rate is a question for the operator's accountant. The admin says so.
 */
export const DEFAULT_TAX_RATES: readonly TaxRate[] = [
  { class: 'standard', label: 'Standard', rate_bp: 2400 },
  { class: 'reduced', label: 'Reduced', rate_bp: 1300 },
  { class: 'super-reduced', label: 'Super-reduced', rate_bp: 600 },
  { class: 'zero', label: 'Zero-rated', rate_bp: 0 },
];

/** Basis points cannot exceed this. 100% tax is already absurd; 200% is a typo. */
/**
 * Countries in the EU VAT territory. A SEED, and operator-editable.
 *
 * This is a membership list, not a rate table, and the difference is what makes
 * it acceptable in core: ~27 entries that move roughly once a decade, against
 * 27x4 numbers that move continuously. The rates stay a paid pack's problem;
 * knowing that Germany is in the EU and Norway is not does not need a
 * subscription.
 *
 * Like DEFAULT_TAX_RATES, this is a starting point rather than an assertion
 * about current law — special territories inside these countries (the Canaries,
 * Livigno, Άγιο Όρος, Åland) sit outside the VAT area and are expressed as
 * postcode rows on the rate table, not by removing the country.
 */
export const EU_VAT_COUNTRIES_SEED: readonly string[] = [
  'AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR',
  'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK',
];

export const MAX_RATE_BP = 20_000;

function toInt(v: unknown, fallback: number): number {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
  return Math.round(n);
}

/**
 * How many rows the OPERATOR's `tax_rates` setting may hold.
 *
 * Why it exists: it came in with the table itself (3b1c23c, Aug 2026) as a
 * plain bound on admin-written JSON that is re-parsed on every quote; no
 * incident or other rationale is recorded. The settings endpoint already caps
 * a value at 64 KB, so this is a work bound, and it is KEPT for operator input
 * because raising it changes what an existing shop charges. What it must not
 * do is cut rows a plugin supplies: a maintained EU table is ~120 rows, and a
 * silent cut there drops whole countries. Plugin rows have their own, much
 * larger bound (`MAX_SUPPLIED_TAX_RATES`), and every row cut is logged.
 */
export const MAX_OPERATOR_TAX_RATES = 50;

/** Work bound for rows supplied through `PLUGIN_HOOKS.TAX_RATES`. */
export const MAX_SUPPLIED_TAX_RATES = 2000;

/** A row the normaliser refused, and why. Reported for plugin rows. */
export interface TaxRateDrop {
  row: unknown;
  reason: string;
}

/**
 * The identity of a rate row: jurisdiction, class AND postcodes.
 *
 * Postcodes are part of it because a special territory is a second row for
 * the same country and class (`ES standard 21%` and `ES standard 0%` for the
 * Canaries). Keyed on country and class alone, the territory was dropped as a
 * duplicate of the mainland. Sorted, so the same set written in another order
 * is still the same row.
 *
 * `origin` resolves a row without a country to the shop's own, so `GR` and
 * absent compare equal once the shop's country is known.
 */
export function taxRateKey(r: TaxRate, origin?: string): string {
  const pcs = r.postcodes?.length ? [...r.postcodes].sort().join(',') : '';
  return `${r.country ?? origin ?? ''}|${r.class}|${pcs}`;
}

/**
 * Parse rows without the seed fallback and with a caller-chosen bound.
 *
 * `onDrop` hears about every row refused, with the reason — the plugin path
 * logs them, because a supplied row that vanishes silently is a country whose
 * sales start being refused with nobody knowing why.
 */
export function normalizeTaxRateRows(
  raw: readonly unknown[],
  opts: { max: number; onDrop?: (d: TaxRateDrop) => void; dedupe?: boolean },
): TaxRate[] {
  const drop = opts.onDrop ?? (() => {});
  const out: TaxRate[] = [];
  const seen = new Set<string>();
  if (raw.length > opts.max) {
    // One report for the whole tail, not one per row: the tail is unbounded.
    drop({ row: `${raw.length - opts.max} rows`, reason: `over the ${opts.max}-row limit` });
  }
  for (const row of raw.slice(0, opts.max)) {
    if (!row || typeof row !== 'object') { drop({ row, reason: 'not an object' }); continue; }
    const r = row as Record<string, unknown>;
    const cls = typeof r.class === 'string' ? r.class.trim().toLowerCase() : '';
    if (!cls) { drop({ row, reason: 'no class' }); continue; }

    /*
     * The jurisdiction, and the one way it may fail.
     *
     * Absent is legal and means "the shop's own country". A country that is
     * PRESENT but unusable — 'Germany', 'D', '' — DROPS the row rather than
     * falling through to domestic. Falling through would silently add a foreign
     * rate to the home ladder, where it would be charged to local customers,
     * which is the same class of silent-wrong-number the rate check below
     * refuses.
     */
    let country: string | undefined;
    if (r.country !== undefined && r.country !== null && r.country !== '') {
      const c = String(r.country).trim().toUpperCase();
      if (!/^[A-Z]{2}$/.test(c)) { drop({ row, reason: 'country is not an ISO 3166-1 alpha-2 code' }); continue; }
      // `EL` is Greece's VAT prefix; every country here is ISO (`GR`).
      country = vatPrefixToIso(c);
    }

    const bp = toInt(r.rate_bp, NaN);
    // A NaN or negative rate must not become 0% silently — that would
    // under-charge tax without anyone noticing. Drop the row instead.
    if (!Number.isFinite(bp) || bp < 0 || bp > MAX_RATE_BP) {
      drop({ row, reason: `rate_bp must be an integer from 0 to ${MAX_RATE_BP}` });
      continue;
    }

    const hadPostcodes = Array.isArray(r.postcodes) && r.postcodes.length > 0;
    const postcodes = Array.isArray(r.postcodes)
      ? r.postcodes
          .filter((x): x is string => typeof x === 'string')
          .map((x) => x.trim().toUpperCase())
          // The same three documented forms shipping zones accept, matched by
          // the same function. An unrecognised pattern would never match and
          // would quietly disable the row it was meant to define.
          .filter((x) => /^[A-Z0-9]+\*?$/.test(x) || /^\d+\s*-\s*\d+$/.test(x))
          .slice(0, 500)
      : undefined;
    // A territory row whose every postcode was unusable is DROPPED. Kept, it
    // would lose its postcodes and become a country-wide row — charging the
    // territory's rate (often 0%) to the whole country.
    if (hadPostcodes && !postcodes?.length) {
      drop({ row, reason: 'none of its postcodes is a recognised pattern' });
      continue;
    }

    const entry: TaxRate = {
      class: cls,
      label: typeof r.label === 'string' && r.label.trim() ? r.label.trim().slice(0, 60) : cls,
      rate_bp: bp,
    };
    if (country) entry.country = country;
    if (postcodes?.length) entry.postcodes = postcodes;

    // The key is country, class AND postcodes: 'standard' in GR and in DE are
    // two rows, and so are mainland Spain and the Canaries. See taxRateKey.
    const key = taxRateKey(entry);
    if (opts.dedupe !== false && seen.has(key)) { drop({ row, reason: 'duplicate of an earlier row' }); continue; }
    seen.add(key);
    out.push(entry);
  }
  return out;
}

/** Parse + clamp the operator's stored rate table. Rejects rows that cannot be trusted. */
export function normalizeTaxRates(raw: unknown): TaxRate[] {
  if (!Array.isArray(raw)) return [...DEFAULT_TAX_RATES];
  const out = normalizeTaxRateRows(raw, { max: MAX_OPERATOR_TAX_RATES });
  // Falls back to the seed ladder only when NOTHING survived. An operator who
  // configured rates and lost them all to validation is better served by a
  // working domestic ladder than by a shop that charges no tax at all.
  return out.length ? out : [...DEFAULT_TAX_RATES];
}

/**
 * Add rows a plugin supplied (`PLUGIN_HOOKS.TAX_RATES`) to the operator's.
 *
 * PURE. The rules:
 *   - the operator's rows are kept, first and unchanged, whatever the plugin
 *     returned — a plugin that drops or rewrites them changes nothing;
 *   - a supplied row with the same identity (`taxRateKey`, the shop's own
 *     country resolved) as an operator row loses to it; at a different rate
 *     that is reported, at the same rate it is the operator's row handed back;
 *   - supplied rows go through the same normaliser, bounded by
 *     `MAX_SUPPLIED_TAX_RATES`, not the operator's cap;
 *   - anything that is not an array leaves the operator's rows in force.
 *
 * Every supplied row that is not used is reported through `onDrop`.
 */
export function mergeSuppliedTaxRates(
  base: TaxSettings,
  supplied: unknown,
  onDrop: (d: TaxRateDrop) => void = () => {},
): TaxRate[] {
  if (!Array.isArray(supplied)) {
    onDrop({ row: supplied, reason: 'the filter did not return an array; the operator\'s rates are used alone' });
    return base.rates;
  }
  const origin = base.originCountry;
  const own = new Map(base.rates.map((r) => [taxRateKey(r, origin), r]));
  const taken = new Set(own.keys());
  const out = [...base.rates];
  // De-duplicated HERE rather than by the normaliser, so a supplied row that
  // repeats an operator row is reported as losing to it, not as a duplicate.
  for (const r of normalizeTaxRateRows(supplied, { max: MAX_SUPPLIED_TAX_RATES, onDrop, dedupe: false })) {
    const key = taxRateKey(r, origin);
    const mine = own.get(key);
    if (mine) {
      if (mine.rate_bp !== r.rate_bp) onDrop({ row: r, reason: `the operator's own row wins (${mine.rate_bp} bp)` });
      continue;
    }
    if (taken.has(key)) { onDrop({ row: r, reason: 'duplicate of an earlier supplied row' }); continue; }
    taken.add(key);
    out.push(r);
  }
  return out.length === base.rates.length ? base.rates : out;
}

export function resolveTaxSettings(settings: Record<string, unknown> | null | undefined): TaxSettings {
  const map = settings ?? {};
  const rates = normalizeTaxRates(map[TAX_KEYS.rates]);
  const rawOrigin = typeof map[TAX_KEYS.originCountry] === 'string'
    ? (map[TAX_KEYS.originCountry] as string).trim().toUpperCase()
    : '';
  // No default, deliberately. See the note on TAX_KEYS.originCountry.
  // `EL` (Greece's VAT prefix) is stored as ISO `GR`, like every other list.
  const originCountry = /^[A-Z]{2}$/.test(rawOrigin) ? vatPrefixToIso(rawOrigin) : undefined;
  const defaultClass =
    typeof map[TAX_KEYS.defaultClass] === 'string' && (map[TAX_KEYS.defaultClass] as string).trim()
      ? (map[TAX_KEYS.defaultClass] as string).trim().toLowerCase()
      : rates[0].class;
  return {
    // Off unless switched on: a shop that has not configured tax must not have
    // amounts silently invented for it.
    //
    // `settingBool`, not `=== true` / `!== false`. `POST /api/settings/update`
    // accepts arbitrary JSON and coerces only the keys in BOOLEAN_KEYS, so an
    // operator scripting their setup stores the STRING they sent. Both halves
    // failed on it, and the second is much the worse:
    //
    //   `map[...] === true`    "true"  -> false: tax silently OFF on a shop
    //                          whose own admin screen says it is on.
    //   `map[...] !== false`   "false" -> TRUE, because a non-empty string is
    //                          not `false`. A shop that chose tax-EXCLUSIVE
    //                          pricing got tax-INCLUSIVE — VAT extracted out of
    //                          the price instead of added to it, wrong by the
    //                          whole rate on every line of every order.
    enabled: settingBool(map[TAX_KEYS.enabled], false),
    pricesIncludeTax: settingBool(map[TAX_KEYS.pricesIncludeTax], true), // EU retail default
    defaultClass,
    rates,
    shippingClass:
      typeof map[TAX_KEYS.shippingClass] === 'string' && (map[TAX_KEYS.shippingClass] as string).trim()
        ? (map[TAX_KEYS.shippingClass] as string).trim().toLowerCase()
        : defaultClass,
    originCountry,
    /*
     * Destination mode requires BOTH the switch and an origin country.
     *
     * Not a validation nicety — the whole engine is a comparison against where
     * the shop is. Turning it on without an origin would make every sale look
     * cross-border, which is the loudest possible wrong answer, and defaulting
     * the origin to 'GR' because the software was written in Greece would be
     * the quietest one.
     */
    destinationMode: originCountry && map[TAX_KEYS.destinationMode] === 'oss' ? 'oss' : 'off',
    reverseCharge: settingBool(map[TAX_KEYS.reverseCharge], false),
    euCountries: normalizeCountryList(map[TAX_KEYS.euCountries]) ?? [...EU_VAT_COUNTRIES_SEED],
  };
}

function normalizeCountryList(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const out = raw
    .filter((c): c is string => typeof c === 'string')
    // `EL` is Greece's VAT prefix, not its ISO code. An operator who typed it
    // into the EU list meant Greece, and every other list here is ISO.
    .map((c) => vatPrefixToIso(c.trim().toUpperCase()))
    .filter((c) => /^[A-Z]{2}$/.test(c));
  return out.length ? [...new Set(out)] : null;
}

/**
 * Rate for a class, in basis points.
 *
 * An unknown class falls back to the DEFAULT class rather than to zero. Zero
 * would mean a typo in a product's `tax_class` silently stops charging VAT on
 * it — an error that only surfaces at an audit.
 */
/**
 * The rate for a class, in the SHOP's own country — the domestic case.
 *
 * Crossing a border is not this function's decision: `resolveTaxTreatment`
 * below picks between domestic, destination (OSS), reverse charge and export,
 * and `rateForTreatment` then asks this for the rate that treatment needs. A
 * caller that reaches for this directly gets the home rate, which is right
 * only for a domestic sale.
 *
 * What is still the operator's own to supply is the NUMBERS for other
 * countries: core ships no foreign rate tables, and a destination with no row
 * refuses the sale (`checkout.tax_not_configured`) rather than guessing.
 *
 * Only the shop's own rows are consulted (`domesticTaxRates`), for the class
 * AND for the default-class fallback: a foreign row is never a domestic rate.
 * `postcode`, when given, lets a domestic territory row apply (Άγιο Όρος);
 * without one, territory rows are skipped.
 */
export function rateForClass(
  settings: TaxSettings,
  taxClass: string | undefined | null,
  postcode?: string,
): number {
  return domesticRate(settings, taxClass, postcode) ?? 0;
}

/**
 * The domestic rate, or `null` when the shop's own rows have neither the
 * class nor the default class.
 *
 * `null` is the refusal case, exactly as for a destination: with the shop's
 * country set and no home row to charge, every fallback is a silent wrong
 * number — 0% under-charges, and a foreign row charges another country's VAT
 * at home. `resolveTaxTreatment` turns it into `not-configured` (409), naming
 * the classes to add. `rateForClass` keeps its historical `?? 0` for callers
 * that have already checked the class exists.
 *
 * With NO `shop_country` nothing is refused and nothing is guessed: if the
 * rows without a country cannot answer, the whole table is searched as it
 * always was. That shop is told its country is missing by the attention feed,
 * and plugin rows are never merged without one, so only the operator's own
 * rows can be reached this way.
 */
export function domesticRate(
  settings: TaxSettings,
  taxClass: string | undefined | null,
  postcode?: string,
): number | null {
  if (!settings.enabled) return 0;
  const wanted = (taxClass ?? '').trim().toLowerCase();
  const find = (rows: readonly TaxRate[]) =>
    (wanted ? pickRate(rows, wanted, postcode) : undefined) ?? pickRate(rows, settings.defaultClass, postcode);
  const rows = domesticTaxRates(settings);
  let hit = find(rows);
  if (!hit && !settings.originCountry && rows !== settings.rates) hit = find(settings.rates);
  return hit ? hit.rate_bp : null;
}

/**
 * The shop's OWN rows: those whose country is the shop's, or absent.
 *
 * Every domestic lookup goes through this. It used to be the whole table, so
 * once any foreign row existed (an operator's, or a rate pack's) a domestic
 * product whose class the home ladder lacks took the FOREIGN rate: a Greek
 * `reduced-2` product, with Austria's 10% the only `reduced-2` row, cost Greek
 * buyers 10%. The fallback to the default class has to stay at home too.
 *
 * With no `shop_country` only rows without a country are home — nothing is
 * guessed. If every row names a country, the table cannot say which is home,
 * so it is used as it always was (that shop is already told by the attention
 * feed that its country is missing; plugin rows are not merged without one).
 * `domesticRate` applies the same rule when the country-less rows cannot
 * answer a lookup.
 */
export function domesticTaxRates(settings: TaxSettings): TaxRate[] {
  const origin = settings.originCountry;
  if (origin) return settings.rates.filter((r) => (r.country ?? origin) === origin);
  const plain = settings.rates.filter((r) => !r.country);
  return plain.length ? plain : settings.rates;
}

/**
 * One class's row among `rows`: a postcode row that matches wins over the
 * country-wide one; a postcode row never applies without a matching postcode.
 */
function pickRate(rows: readonly TaxRate[], cls: string, postcode?: string): TaxRate | undefined {
  const territorial = postcode
    ? rows.find((r) => r.class === cls && r.postcodes?.some((p) => postcodeMatches(p, postcode)))
    : undefined;
  return territorial ?? rows.find((r) => r.class === cls && !r.postcodes);
}

export interface TaxSplit {
  /** Amount excluding tax. */
  net_cents: number;
  tax_cents: number;
  /** Amount including tax. Always `net + tax`. */
  gross_cents: number;
  rate_bp: number;
}

/**
 * Split an amount into net + tax.
 *
 * `amountIncludesTax` says which side `amount_cents` is on. Whichever it is,
 * the OTHER two are derived so the three always reconcile exactly.
 */
export function splitTax(amount_cents: number, rate_bp: number, amountIncludesTax: boolean): TaxSplit {
  const amount = Math.round(amount_cents);
  if (!Number.isFinite(amount) || rate_bp <= 0) {
    return { net_cents: amount, tax_cents: 0, gross_cents: amount, rate_bp: Math.max(0, rate_bp) };
  }

  if (amountIncludesTax) {
    // gross known. net = gross / (1 + rate); tax is the remainder, so the two
    // cannot drift apart by a rounding cent.
    const net = Math.round((amount * 10_000) / (10_000 + rate_bp));
    return { net_cents: net, tax_cents: amount - net, gross_cents: amount, rate_bp };
  }

  // net known. tax rounds; gross is the sum, so again exact.
  const tax = Math.round((amount * rate_bp) / 10_000);
  return { net_cents: amount, tax_cents: tax, gross_cents: amount + tax, rate_bp };
}

/**
 * Is this product's own price taxed?
 *
 * WooCommerce's vocabulary, kept deliberately: `'shipping'` means "shipping
 * only" — the goods are untaxed but the delivery charge still is. Surprising
 * until you meet it, which is exactly why it is spelled out here rather than
 * inferred at the call site.
 */
export function productIsTaxable(taxStatus: string | undefined): boolean {
  return (taxStatus ?? 'taxable') === 'taxable';
}

/** Does this product's tax status mean shipping is taxed? */
export function shippingIsTaxableFor(taxStatus: string | undefined): boolean {
  const s = taxStatus ?? 'taxable';
  return s === 'taxable' || s === 'shipping';
}

/* ══════════════════════════════════════════════════════════════════════════
 * DESTINATION-BASED RESOLUTION
 *
 * The engine decides WHOSE rate applies. It does not decide what that rate is —
 * that is a number on the table above, which the operator or a paid rate pack
 * supplies. Core ships zero foreign rates, and this is the seam: resolution is
 * a rule that does not change, rate tables are data that changes constantly.
 * ═════════════════════════════════════════════════════════════════════════ */

export type TaxTreatmentKind =
  /** The shop's own country's rate for the class. */
  | 'domestic'
  /** The destination country's rate for the class (OSS). */
  | 'destination'
  /** 0%: an EU business customer accounts for the VAT itself. */
  | 'reverse-charge'
  /** 0%: outside the EU VAT territory. */
  | 'export'
  /**
   * A rate is OWED and none is on file.
   *
   * A distinct outcome rather than a fallback, because every plausible fallback
   * is wrong in a way nobody notices: 0% under-charges, and the origin rate
   * charges a German buyer Greek VAT. Checkout refuses instead, naming what is
   * missing, and the operator fixes the table.
   */
  | 'not-configured';

export interface TaxTreatment {
  kind: TaxTreatmentKind;
  /** Whose rate table is consulted. Absent for export and reverse-charge. */
  jurisdiction?: string;
  /** For 'not-configured': what the operator must add. */
  missing?: { country: string; classes: string[] };
  /**
   * What a TAX_ID_VERDICT plugin said about the buyer's tax id, when one was
   * asked. Absent when nobody was asked (no tax id, reverse charge off, a
   * domestic or non-EU sale, no plugin). Informational: `kind` is the decision.
   */
  tax_id_status?: TaxIdVerdictStatus;
}

/**
 * A plugin's opinion on a buyer's tax id — `PLUGIN_HOOKS.TAX_ID_VERDICT`.
 *
 *   `unchecked`   nobody has an opinion. The core's own shape check decides,
 *                 exactly as it does with no plugin installed.
 *   `verified`    a registry confirmed the number. Reverse charge may apply
 *                 (the shop's own rules still decide), using `country`.
 *   `invalid`     the number is not a registered business. No reverse charge:
 *                 the sale is taxed like any consumer's.
 *   `unverified`  nobody could tell (the registry was down, the cache cold).
 *                 VAT is charged when a rate for the destination is on file.
 *                 It is NEVER a refusal: with no destination rate on file the
 *                 core falls back to its shape-only reverse charge — the
 *                 policy the operator switched on — rather than block the
 *                 order over a lookup that did not answer.
 */
export type TaxIdVerdictStatus = 'unchecked' | 'verified' | 'invalid' | 'unverified';

export const TAX_ID_VERDICT_STATUSES: readonly TaxIdVerdictStatus[] =
  ['unchecked', 'verified', 'invalid', 'unverified'];

export interface TaxIdVerdict {
  status: TaxIdVerdictStatus;
  /** ISO country of the number (`GR`, not `EL`). Preferred over the prefix. */
  country?: string;
  vat_id?: string;
  reason?: string;
  source?: string;
  checked_at?: string;
  consultation_number?: string | null;
}

/** What `resolveTaxTreatment` asks when a verdict could change the answer. */
export type TaxIdVerdictFn = (ctx: { taxId: string; country?: string }) => unknown;

/**
 * Greece's VAT prefix is `EL`; its ISO 3166 code is `GR`.
 *
 * Every country list in this engine (the EU list, the origin, the rate table)
 * is ISO, so a VAT prefix is mapped before any comparison. Without this a
 * correctly written Greek number (`EL…`) was never in the EU list and so never
 * reverse-charged.
 */
export function vatPrefixToIso(code: string): string;
export function vatPrefixToIso(code: string | undefined): string | undefined;
export function vatPrefixToIso(code: string | undefined): string | undefined {
  return code === 'EL' ? 'GR' : code;
}

/**
 * A VAT identifier, by SHAPE only.
 *
 * Two letters then 2-12 alphanumerics is the common structure of every EU VAT
 * number. This deliberately does NOT check the per-country length rules, the
 * checksum, or — above all — whether the number is REGISTERED. That last one
 * needs VIES: a live, rate-limited external service whose answer must be kept
 * as an audit artefact for years and re-checked periodically, because a number
 * valid at order time can be invalid at audit time. That is a credential and a
 * standing obligation, so it lives behind the seam in a paid pack.
 *
 * What core does with the shape alone is the honest half: it can tell that
 * something is a VAT id rather than a phone number, and it records the claim.
 * `reverse-charge` on shape alone is a policy the operator switches ON
 * deliberately, and the admin says exactly what it does and does not verify.
 */
export function looksLikeVatId(
  raw: unknown,
): { ok: boolean; country?: string; prefix?: string; normalised?: string } {
  if (typeof raw !== 'string') return { ok: false };
  const t = raw.replace(/[\s.-]/g, '').toUpperCase();
  const m = /^([A-Z]{2})([A-Z0-9]{2,12})$/.exec(t);
  if (!m) return { ok: false };
  // `country` is ISO (`GR`); `prefix` is what was typed (`EL`); `normalised`
  // keeps the typed prefix, because that is the number as VIES knows it.
  return { ok: true, country: vatPrefixToIso(m[1]), prefix: m[1], normalised: t };
}

/**
 * A plugin's answer, or `null` ("no opinion") when it is not a verdict.
 *
 * A filter that returns garbage — a Promise from an async function, a bare
 * string — must not change a sale's tax, in either direction.
 */
export function normaliseTaxIdVerdict(raw: unknown): TaxIdVerdict | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as Partial<TaxIdVerdict>;
  if (!TAX_ID_VERDICT_STATUSES.includes(v.status as TaxIdVerdictStatus)) return null;
  const out: TaxIdVerdict = { ...(v as TaxIdVerdict) };
  const c = typeof v.country === 'string' ? v.country.trim().toUpperCase() : '';
  if (/^[A-Z]{2}$/.test(c)) out.country = vatPrefixToIso(c);
  else delete out.country;
  return out;
}

/** Does this jurisdiction have a rate for this class on file? */
function hasRate(settings: TaxSettings, country: string | undefined, cls: string): boolean {
  return settings.rates.some(
    (r) => (r.country ?? settings.originCountry) === country && r.class === cls,
  );
}

/**
 * Which rules apply to this sale.
 *
 * PURE: no storage, no clock, no network. The order of the branches is the
 * order the rules apply in, and it is the part worth reading twice.
 */
export function resolveTaxTreatment(input: {
  settings: TaxSettings;
  destination?: { country?: string; postcode?: string };
  /** The customer's VAT id, if they gave one. */
  customerTaxId?: string;
  /** The country the VAT id was entered next to (billing), as a hint. */
  customerCountry?: string;
  /**
   * Asked ONLY where a verdict could change the answer: reverse charge
   * switched on, an EU destination other than the origin, and a non-empty tax
   * id. Absent means nobody has an opinion, and the shape check decides as it
   * always has. See TaxIdVerdictStatus for what each answer does.
   */
  taxIdVerdict?: TaxIdVerdictFn;
  /** Classes this basket needs a rate for — used to report what is missing. */
  classes?: string[];
}): TaxTreatment {
  const { settings } = input;
  const origin = settings.originCountry;
  const wanted = (input.classes?.length ? input.classes : [settings.defaultClass])
    .map((c) => (c || settings.defaultClass).trim().toLowerCase());

  /*
   * A domestic sale, or a refusal when the shop's OWN rows cannot price it.
   *
   * Only once the shop's country is known: then a class with no home row and
   * no home default-class row has no honest rate — 0% under-charges and a
   * foreign row is another country's VAT. Refused like a destination with no
   * rate (`not-configured`, 409), naming the classes to add. Without a
   * country, `domesticRate` never refuses (see there).
   */
  const domestic = (): TaxTreatment => {
    if (settings.enabled && origin) {
      const postcode = input.destination?.postcode;
      const missing = [...new Set(wanted.filter((c) => domesticRate(settings, c, postcode) === null))];
      if (missing.length) {
        return { kind: 'not-configured', jurisdiction: origin, missing: { country: origin, classes: missing } };
      }
    }
    return { kind: 'domestic', jurisdiction: origin };
  };

  // Tax off, or no origin configured: everything is domestic and the existing
  // class ladder answers. This is the behaviour every install has today.
  if (!settings.enabled || settings.destinationMode !== 'oss' || !origin) {
    return domestic();
  }

  // ISO: a destination written `EL` is Greece, not a non-EU export.
  const dest = vatPrefixToIso(String(input.destination?.country ?? '').trim().toUpperCase());
  // No destination yet — a cart page asks for totals before an address exists.
  // Domestic is the right provisional answer AND the one the shop mostly makes.
  if (!/^[A-Z]{2}$/.test(dest)) return domestic();

  if (dest === origin) return domestic();

  const inEu = settings.euCountries.includes(dest);
  // Outside the EU VAT territory: no EU VAT is due.
  if (!inEu) return { kind: 'export' };

  // EU B2B: the customer accounts for the VAT. Only when the operator has
  // switched it on, and only for a VAT id from a DIFFERENT member state —
  // a domestic sale to a domestic business is still domestically taxed.
  //
  // Every side of the comparison is ISO: `EL` (Greece's VAT prefix) is `GR`
  // on the number (looksLikeVatId), the origin, the destination, the rate rows
  // and the EU list (resolveTaxSettings) alike.
  const isoOrigin = origin;
  const crossBorderEu = (country: string | undefined): boolean =>
    !!country && country !== isoOrigin && settings.euCountries.includes(country);

  // The core's own answer, from the SHAPE of the number. It is the whole of
  // reverse charge when no plugin has an opinion: the policy the operator
  // switched on, documented as checking nothing more than the shape.
  const taxId = typeof input.customerTaxId === 'string' ? input.customerTaxId.trim() : '';
  const shape = looksLikeVatId(taxId);
  const byShape = shape.ok && crossBorderEu(shape.country);

  let taxIdStatus: TaxIdVerdictStatus | undefined;
  if (settings.reverseCharge && taxId) {
    let verdict: TaxIdVerdict = { status: 'unchecked' };
    if (input.taxIdVerdict) {
      const hint = String(input.customerCountry ?? '').trim().toUpperCase();
      verdict = normaliseTaxIdVerdict(input.taxIdVerdict({
        taxId,
        ...(/^[A-Z]{2}$/.test(hint) ? { country: vatPrefixToIso(hint) } : {}),
      })) ?? { status: 'unchecked' };
      taxIdStatus = verdict.status;
    }
    const stamp = taxIdStatus ? { tax_id_status: taxIdStatus } : {};

    if (verdict.status === 'unchecked' && byShape) return { kind: 'reverse-charge', ...stamp };
    if (verdict.status === 'verified') {
      // The registry's country wins over the two letters the buyer typed —
      // they may not have typed a prefix at all.
      if (crossBorderEu(verdict.country ?? (shape.ok ? shape.country : undefined))) {
        return { kind: 'reverse-charge', ...stamp };
      }
    }
    // 'invalid' and 'unverified' fall through: VAT is charged.
  }
  const stamp = taxIdStatus ? { tax_id_status: taxIdStatus } : {};

  // EU B2C: the destination's rate. Refuse rather than guess when it is absent.
  const missing = [...new Set(wanted.filter((c) => !hasRate(settings, dest, c)))];
  if (missing.length) {
    // An UNVERIFIED number never blocks an order. Owner decision 2026-09-04:
    // the tax id is captured, never the reason a sale is refused. With no
    // destination rate on file the only alternative here is a 409 caused by a
    // registry that did not answer, so the operator's own shape-only reverse
    // charge applies — exactly what happens with no plugin installed. The
    // priced treatment's `tax_id_status` says it was not verified; it is NOT
    // stored on the order, so a verifier keeps its own evidence (the vat
    // module flags exactly this as `reverse-charge-not-verified`).
    if (taxIdStatus === 'unverified' && byShape) return { kind: 'reverse-charge', ...stamp };
    return { kind: 'not-configured', jurisdiction: dest, missing: { country: dest, classes: missing }, ...stamp };
  }
  return { kind: 'destination', jurisdiction: dest, ...stamp };
}

/**
 * The rate for one class under a resolved treatment.
 *
 * Returns `null` — never 0, never the origin rate — when a rate is owed and
 * missing. The caller must refuse. Zero would under-charge silently and the
 * origin rate would charge the wrong country's VAT; both look completely
 * plausible on the invoice, which is what makes them dangerous.
 */
export function rateForTreatment(
  settings: TaxSettings,
  treatment: TaxTreatment,
  taxClass: string | undefined | null,
  postcode?: string,
): number | null {
  if (!settings.enabled) return 0;
  switch (treatment.kind) {
    case 'export':
    case 'reverse-charge':
      return 0;
    case 'not-configured':
      return null;
    case 'domestic':
      // The shop's own rows only, with the historical fallback to the default
      // class — also at home. `null` when home has neither. See `domesticRate`.
      return domesticRate(settings, taxClass, postcode);
    case 'destination': {
      const country = treatment.jurisdiction;
      const wanted = (taxClass ?? '').trim().toLowerCase() || settings.defaultClass;
      const inCountry = settings.rates.filter(
        (r) => (r.country ?? settings.originCountry) === country,
      );
      // A postcode row wins over a country-wide one — that is what makes a
      // special territory expressible without a second table.
      const hit = pickRate(inCountry, wanted, postcode);
      // A DESTINATION with no row is the not-configured case and must not
      // borrow the origin's number, nor fall back to another class.
      return hit ? hit.rate_bp : null;
    }
    default:
      return null;
  }
}
