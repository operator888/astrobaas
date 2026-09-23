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

/** Parse + clamp a stored rate table. Rejects rows that cannot be trusted. */
export function normalizeTaxRates(raw: unknown): TaxRate[] {
  if (!Array.isArray(raw)) return [...DEFAULT_TAX_RATES];
  const out: TaxRate[] = [];
  const seen = new Set<string>();
  for (const row of raw.slice(0, 50)) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const cls = typeof r.class === 'string' ? r.class.trim().toLowerCase() : '';
    if (!cls) continue;

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
      if (!/^[A-Z]{2}$/.test(c)) continue;
      country = c;
    }

    // The key is the PAIR. 'standard' in GR and 'standard' in DE are two rows,
    // and de-duplicating on the class alone would have kept only the first.
    const key = `${country ?? ''}|${cls}`;
    if (seen.has(key)) continue;

    const bp = toInt(r.rate_bp, NaN);
    // A NaN or negative rate must not become 0% silently — that would
    // under-charge tax without anyone noticing. Drop the row instead.
    if (!Number.isFinite(bp) || bp < 0 || bp > MAX_RATE_BP) continue;

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

    seen.add(key);
    const entry: TaxRate = {
      class: cls,
      label: typeof r.label === 'string' && r.label.trim() ? r.label.trim().slice(0, 60) : cls,
      rate_bp: bp,
    };
    if (country) entry.country = country;
    if (postcodes?.length) entry.postcodes = postcodes;
    out.push(entry);
  }
  // Falls back to the seed ladder only when NOTHING survived. An operator who
  // configured rates and lost them all to validation is better served by a
  // working domestic ladder than by a shop that charges no tax at all.
  return out.length ? out : [...DEFAULT_TAX_RATES];
}

export function resolveTaxSettings(settings: Record<string, unknown> | null | undefined): TaxSettings {
  const map = settings ?? {};
  const rates = normalizeTaxRates(map[TAX_KEYS.rates]);
  const rawOrigin = typeof map[TAX_KEYS.originCountry] === 'string'
    ? (map[TAX_KEYS.originCountry] as string).trim().toUpperCase()
    : '';
  // No default, deliberately. See the note on TAX_KEYS.originCountry.
  const originCountry = /^[A-Z]{2}$/.test(rawOrigin) ? rawOrigin : undefined;
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
    .map((c) => c.trim().toUpperCase())
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
 */
export function rateForClass(settings: TaxSettings, taxClass: string | undefined | null): number {
  if (!settings.enabled) return 0;
  const wanted = (taxClass ?? '').trim().toLowerCase();
  const hit = wanted ? settings.rates.find((r) => r.class === wanted) : undefined;
  if (hit) return hit.rate_bp;
  const fallback = settings.rates.find((r) => r.class === settings.defaultClass);
  return fallback ? fallback.rate_bp : 0;
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
export function looksLikeVatId(raw: unknown): { ok: boolean; country?: string; normalised?: string } {
  if (typeof raw !== 'string') return { ok: false };
  const t = raw.replace(/[\s.-]/g, '').toUpperCase();
  const m = /^([A-Z]{2})([A-Z0-9]{2,12})$/.exec(t);
  if (!m) return { ok: false };
  return { ok: true, country: m[1], normalised: t };
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
  /** Classes this basket needs a rate for — used to report what is missing. */
  classes?: string[];
}): TaxTreatment {
  const { settings } = input;
  const origin = settings.originCountry;

  // Tax off, or no origin configured: everything is domestic and the existing
  // class ladder answers. This is the behaviour every install has today.
  if (!settings.enabled || settings.destinationMode !== 'oss' || !origin) {
    return { kind: 'domestic', jurisdiction: origin };
  }

  const dest = String(input.destination?.country ?? '').trim().toUpperCase();
  // No destination yet — a cart page asks for totals before an address exists.
  // Domestic is the right provisional answer AND the one the shop mostly makes.
  if (!/^[A-Z]{2}$/.test(dest)) return { kind: 'domestic', jurisdiction: origin };

  if (dest === origin) return { kind: 'domestic', jurisdiction: origin };

  const inEu = settings.euCountries.includes(dest);
  // Outside the EU VAT territory: no EU VAT is due.
  if (!inEu) return { kind: 'export' };

  // EU B2B: the customer accounts for the VAT. Only when the operator has
  // switched it on, and only for a VAT id from a DIFFERENT member state —
  // a domestic sale to a domestic business is still domestically taxed.
  if (settings.reverseCharge) {
    const vat = looksLikeVatId(input.customerTaxId);
    if (vat.ok && vat.country && vat.country !== origin && settings.euCountries.includes(vat.country)) {
      return { kind: 'reverse-charge' };
    }
  }

  // EU B2C: the destination's rate. Refuse rather than guess when it is absent.
  const wanted = (input.classes?.length ? input.classes : [settings.defaultClass])
    .map((c) => (c || settings.defaultClass).trim().toLowerCase());
  const missing = [...new Set(wanted.filter((c) => !hasRate(settings, dest, c)))];
  if (missing.length) {
    return { kind: 'not-configured', jurisdiction: dest, missing: { country: dest, classes: missing } };
  }
  return { kind: 'destination', jurisdiction: dest };
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
    case 'destination': {
      const country = treatment.jurisdiction;
      const wanted = (taxClass ?? '').trim().toLowerCase() || settings.defaultClass;
      const inCountry = settings.rates.filter(
        (r) => (r.country ?? settings.originCountry) === country,
      );
      // A postcode row wins over a country-wide one — that is what makes a
      // special territory expressible without a second table.
      const territorial = postcode
        ? inCountry.find((r) => r.class === wanted && r.postcodes?.some((p) => postcodeMatches(p, postcode)))
        : undefined;
      if (territorial) return territorial.rate_bp;
      const plain = inCountry.find((r) => r.class === wanted && !r.postcodes);
      if (plain) return plain.rate_bp;
      // Domestic keeps its historical fallback to the default class, which is
      // what `rateForClass` has always done. A DESTINATION with no row is the
      // not-configured case and must not borrow the origin's number.
      if (treatment.kind === 'domestic') return rateForClass(settings, taxClass);
      return null;
    }
    default:
      return null;
  }
}
