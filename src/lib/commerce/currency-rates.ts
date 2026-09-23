/**
 * Exchange rates — operator-entered, integer, and never fetched.
 *
 * Pure and dependency-free, like tax.ts beside it, which is the precedent this
 * follows: a rate table lives in the settings bucket, a normaliser rebuilds it
 * on read, and the lookup is one function everything else calls.
 *
 * ## Why the operator types the rate
 *
 * There is no FX API here and there will not be one in core. Every rate source
 * worth trusting needs a credential, and this project's rule is that anything
 * needing a credential lives behind a seam — so a rates PACK can push updates
 * through this same table, and the core stays honest with a number a human
 * entered. A hardcoded "live" rate would be invented data with a timestamp on
 * it, which is worse than no rate at all.
 *
 * The cost of that choice is staleness, so staleness is made VISIBLE rather
 * than hidden: every rate carries when it was saved, `resolveCurrencySettings`
 * computes its age, and the operator decides whether an old rate may still take
 * an order.
 *
 * ## Why parts per million, as an integer
 *
 * A float rate re-introduces exactly the error that storing money as integer
 * minor units exists to prevent. `rate_ppm` is millionths of a major unit per
 * major unit: 1 EUR = 1.087 USD is 1_087_000. Six digits is finer than any
 * published FX rate and multiplies into a JPY total without losing a yen.
 */
import { minorUnits } from '../money-format';

export const CURRENCY_KEYS = {
  rates: 'shop_currencies',
  maxAgeHours: 'shop_currency_rate_max_age_hours',
  staleBlocksCheckout: 'shop_currency_stale_blocks_checkout',
} as const;

export interface CurrencyRate {
  /** ISO 4217, upper case. Never the base currency. */
  code: string;
  /** Millionths of one unit of THIS currency per one unit of the base. */
  rate_ppm: number;
  /**
   * An operator who stops trusting a rate turns the currency OFF rather than
   * deleting it, so the number and the date it was set survive for the orders
   * that were priced with it.
   */
  enabled: boolean;
  /** ISO timestamp, stamped server-side when saved. Never client-supplied. */
  updated_at: string;
  /** Who saved it. A money change with no attribution is a gap in the trail. */
  updated_by?: string;
}

/** 0.000001× — a currency worth a millionth of the base. */
export const MIN_RATE_PPM = 1;
/** 1,000,000× — the other end. Beyond this someone typed cents as units. */
export const MAX_RATE_PPM = 1_000_000_000_000;
export const MAX_CURRENCIES = 25;
/** A week. Long enough not to nag, short enough that nobody quotes a year-old rate. */
export const RATE_MAX_AGE_HOURS_DEFAULT = 168;

const RATE_PPM_SCALE = 1_000_000n;

/**
 * Rebuild the stored rate list.
 *
 * A malformed row is DROPPED, never defaulted — the same rule and the same
 * reason as `normalizeTaxRates`. A rate that silently became 1.0 would quote
 * every foreign buyer the base-currency number and look completely plausible
 * while doing it.
 */
export function normalizeCurrencyRates(raw: unknown, baseCurrency: string): CurrencyRate[] {
  if (!Array.isArray(raw)) return [];
  const base = String(baseCurrency || '').toUpperCase();
  const out: CurrencyRate[] = [];
  const seen = new Set<string>();

  for (const row of raw.slice(0, MAX_CURRENCIES)) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;

    const code = String(r.code ?? '').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(code)) continue;
    // The base needs no rate, and storing one invites two answers to
    // "what is one euro worth in euros".
    if (code === base) continue;
    if (seen.has(code)) continue;

    const ppm = typeof r.rate_ppm === 'string' ? Number(r.rate_ppm) : r.rate_ppm;
    if (typeof ppm !== 'number' || !Number.isFinite(ppm)) continue;
    const rounded = Math.round(ppm);
    if (rounded < MIN_RATE_PPM || rounded > MAX_RATE_PPM) continue;

    const updated_at = typeof r.updated_at === 'string' && !Number.isNaN(Date.parse(r.updated_at))
      ? r.updated_at
      : new Date(0).toISOString();

    seen.add(code);
    const entry: CurrencyRate = {
      code,
      rate_ppm: rounded,
      // Absent means ON: a row somebody added is a row they meant to offer, and
      // requiring an explicit `true` would make a hand-written setting silently
      // do nothing.
      enabled: r.enabled !== false,
      updated_at,
    };
    if (typeof r.updated_by === 'string' && r.updated_by) entry.updated_by = r.updated_by.slice(0, 64);
    out.push(entry);
  }
  return out;
}

export interface ResolvedCurrency extends CurrencyRate {
  /** Older than the configured limit, right now. */
  stale: boolean;
  age_seconds: number;
}

export interface CurrencySettings {
  /** The shop's own currency: what it banks, prices and keeps books in. */
  base: string;
  rates: ResolvedCurrency[];
  maxAgeHours: number;
  /** Refuse an order priced on a stale rate, rather than merely flagging it. */
  staleBlocksCheckout: boolean;
}

function num(v: unknown, fallback: number): number {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Read the whole currency configuration out of the settings bucket.
 *
 * `nowMs` is a parameter so staleness is testable without waiting a week — the
 * same trick the scheduler sweeps use.
 */
export function resolveCurrencySettings(
  settings: Record<string, unknown> | null | undefined,
  base: string,
  nowMs: number = Date.now(),
): CurrencySettings {
  const map = settings ?? {};
  const maxAgeHours = num(map[CURRENCY_KEYS.maxAgeHours], RATE_MAX_AGE_HOURS_DEFAULT);
  const maxAgeMs = maxAgeHours * 3600_000;

  const rates = normalizeCurrencyRates(map[CURRENCY_KEYS.rates], base).map((r) => {
    const age = Math.max(0, Math.floor((nowMs - Date.parse(r.updated_at)) / 1000));
    return { ...r, age_seconds: age, stale: age * 1000 > maxAgeMs };
  });

  return {
    base: String(base || '').toUpperCase(),
    rates,
    maxAgeHours,
    // A string "false" is a real thing here: POST /api/settings/update accepts
    // arbitrary JSON and only coerces the known BOOLEAN_KEYS, so `=== true`
    // would read a stored "true" as off. Compare against the strings too.
    staleBlocksCheckout: map[CURRENCY_KEYS.staleBlocksCheckout] === true
      || map[CURRENCY_KEYS.staleBlocksCheckout] === 'true',
  };
}

/**
 * The rate for one presentment currency, or null.
 *
 * Null for an unknown code, a disabled one, or the base itself — three
 * different situations with the same correct answer: do not convert.
 */
export function rateFor(s: CurrencySettings, code: unknown): ResolvedCurrency | null {
  const want = String(code ?? '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(want) || want === s.base) return null;
  return s.rates.find((r) => r.code === want && r.enabled) ?? null;
}

/** Every code a storefront may ask for, base first. */
export function offeredCurrencies(s: CurrencySettings): string[] {
  return [s.base, ...s.rates.filter((r) => r.enabled).map((r) => r.code)];
}

/**
 * Convert an integer amount from the base currency into a presentment one.
 *
 * BigInt throughout, and this is the whole reason the function exists rather
 * than a one-line multiply at each call site. `Math.round(cents * rate / 1e6)`
 * loses precision above 2^53 and — much sooner — produces a different answer
 * depending on the order of the multiply and the divide. BigInt has neither
 * problem, and the single rounding happens once, at the end, on a value that is
 * already in the target currency's minor units.
 *
 * The two exponents matter: 1000 JPY is 1000 minor units and 10.00 EUR is 1000
 * minor units, so converting minor-to-minor without them is wrong by a factor
 * of a hundred. Convert through MAJOR units, which is what a rate describes.
 */
export function convertMinorUnits(
  amountMinor: number,
  fromCurrency: string,
  toCurrency: string,
  ratePpm: number,
): number {
  if (!Number.isFinite(amountMinor)) return 0;
  const from = minorUnits(fromCurrency);
  const to = minorUnits(toCurrency);
  const amount = BigInt(Math.round(amountMinor));
  const ppm = BigInt(Math.round(ratePpm));

  // amountMinor / fromUnits  ->  major
  //   * ppm / 1e6            ->  target major
  //   * toUnits              ->  target minor
  const numerator = amount * ppm * BigInt(to);
  const denominator = RATE_PPM_SCALE * BigInt(from);

  // Round half away from zero, matching Math.round's behaviour for positives
  // and staying symmetric for the refund/credit-note case.
  const negative = numerator < 0n;
  const abs = negative ? -numerator : numerator;
  const rounded = (abs * 2n + denominator) / (denominator * 2n);
  const result = negative ? -rounded : rounded;
  return Number(result);
}

/**
 * Restate a priced basket in another currency.
 *
 * **Only ATOMIC amounts are converted; every aggregate is DERIVED.** That is
 * the whole design, and it is what makes `totalsReconcile()` hold in the
 * presented currency by construction rather than by luck.
 *
 * Converting `total_cents` directly would be the obvious thing and it is wrong:
 * each independent conversion rounds, so a total converted on its own can miss
 * the sum of its converted parts by a cent or two. The invoice would then show
 * lines that do not add up to the amount charged — the exact failure
 * `totalsReconcile` exists to catch, and the kind an accountant finds months
 * later.
 *
 * So: per-line `net` and `tax` convert, and the line total is their sum.
 * Shipping and shipping-tax convert, and the shipping total is their sum. Order
 * tax is the sum of the line taxes plus shipping tax. The order total is the
 * sum of the line totals plus the shipping total. The buyer is charged exactly
 * what the invoice shows, because it is computed from what the invoice shows.
 *
 * `subtotal` and `discount` are display figures that no reconciliation rule
 * binds, so they convert directly.
 */
export function convertTotals<T extends {
  lines: Array<{ net_cents: number; tax_cents: number; total_cents: number;
    unit_price_cents: number; line_subtotal_cents: number; discount_cents: number }>;
  subtotal_cents: number;
  discount_cents: number;
  shipping_cents: number;
  shipping_tax_cents: number;
  shipping_total_cents: number;
  tax_cents: number;
  total_cents: number;
  prices_include_tax: boolean;
}>(totals: T, from: string, to: string, ratePpm: number): T {
  const c = (n: number) => convertMinorUnits(n, from, to, ratePpm);

  const lines = totals.lines.map((l) => {
    const net = c(l.net_cents);
    const tax = c(l.tax_cents);
    return {
      ...l,
      unit_price_cents: c(l.unit_price_cents),
      line_subtotal_cents: c(l.line_subtotal_cents),
      discount_cents: c(l.discount_cents),
      net_cents: net,
      tax_cents: tax,
      // DERIVED, not converted — see the note above.
      total_cents: net + tax,
    };
  });

  const shipping_cents = c(totals.shipping_cents);
  const shipping_tax_cents = c(totals.shipping_tax_cents);
  const shipping_total_cents = totals.prices_include_tax
    ? shipping_cents
    : shipping_cents + shipping_tax_cents;

  return {
    ...totals,
    lines,
    subtotal_cents: c(totals.subtotal_cents),
    discount_cents: c(totals.discount_cents),
    shipping_cents,
    shipping_tax_cents,
    shipping_total_cents,
    tax_cents: lines.reduce((s, l) => s + l.tax_cents, 0) + shipping_tax_cents,
    total_cents: lines.reduce((s, l) => s + l.total_cents, 0) + shipping_total_cents,
  };
}
