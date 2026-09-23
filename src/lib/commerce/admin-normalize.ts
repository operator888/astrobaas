/**
 * Validation for operator-supplied shipping methods and coupons.
 *
 * Pure, and deliberately strict. These records decide what a customer is
 * charged and what a discount is worth, so a malformed one is refused with a
 * reason rather than coerced into something plausible — a shipping method that
 * silently became "flat, 0 cents" because a field was mistyped ships the whole
 * catalogue for free until somebody notices the revenue.
 */

import type { ShippingMethod, ShippingRate, ShippingZone } from './shipping';
import type { Coupon, CouponKind } from './coupons';
import { normalizeCouponCode } from './coupons';

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const bad = (error: string): Parsed<never> => ({ ok: false, error });

function intIn(v: unknown, min: number, max: number): number | null {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  const i = Math.round(n);
  return i >= min && i <= max ? i : null;
}

function strIn(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t ? t.slice(0, max) : undefined;
}

/** Money bound: 1,000,000.00 in minor units. Anything larger is a typo. */
const MAX_MONEY = 100_000_000;

function parseRate(raw: unknown): Parsed<ShippingRate> {
  if (!raw || typeof raw !== 'object') return bad('rate is required');
  const r = raw as Record<string, unknown>;
  switch (r.kind) {
    case 'flat': {
      const amount = intIn(r.amount_cents, 0, MAX_MONEY);
      if (amount === null) return bad('rate.amount_cents must be a whole number of cents');
      return { ok: true, value: { kind: 'flat', amount_cents: amount } };
    }
    case 'weight': {
      const base = intIn(r.base_cents, 0, MAX_MONEY);
      const perKg = intIn(r.per_kg_cents, 0, MAX_MONEY);
      if (base === null || perKg === null) {
        return bad('rate.base_cents and rate.per_kg_cents must be whole numbers of cents');
      }
      return { ok: true, value: { kind: 'weight', base_cents: base, per_kg_cents: perKg } };
    }
    case 'free_over': {
      const threshold = intIn(r.threshold_cents, 0, MAX_MONEY);
      const otherwise = intIn(r.otherwise_cents, 0, MAX_MONEY);
      if (threshold === null || otherwise === null) {
        return bad('rate.threshold_cents and rate.otherwise_cents must be whole numbers of cents');
      }
      return { ok: true, value: { kind: 'free_over', threshold_cents: threshold, otherwise_cents: otherwise } };
    }
    default:
      return bad('rate.kind must be one of: flat, weight, free_over');
  }
}

function parseZone(raw: unknown): Parsed<ShippingZone> {
  if (!raw || typeof raw !== 'object') return bad('zone is required');
  const z = raw as Record<string, unknown>;
  const countries = Array.isArray(z.countries)
    ? z.countries
        .filter((c): c is string => typeof c === 'string')
        .map((c) => c.trim().toUpperCase())
        .filter((c) => c === '*' || /^[A-Z]{2}$/.test(c))
        .slice(0, 250)
    : [];
  if (!countries.length) {
    return bad('zone.countries must list ISO-2 country codes, or ["*"] for anywhere');
  }

  const postcodes = Array.isArray(z.postcodes)
    ? z.postcodes
        .filter((p): p is string => typeof p === 'string')
        .map((p) => p.trim().toUpperCase())
        // Accept only the three documented forms. An unrecognised pattern would
        // silently never match, quietly disabling the zone it was meant to define.
        .filter((p) => /^[A-Z0-9]+\*?$/.test(p) || /^\d+\s*-\s*\d+$/.test(p))
        .slice(0, 500)
    : undefined;

  return { ok: true, value: postcodes?.length ? { countries, postcodes } : { countries } };
}

export function normalizeShippingMethod(
  raw: unknown,
  opts: { partial?: boolean } = {},
): Parsed<Partial<ShippingMethod>> {
  if (!raw || typeof raw !== 'object') return bad('Body must be a JSON object');
  const b = raw as Record<string, unknown>;
  const out: Partial<ShippingMethod> = {};

  const name = strIn(b.name, 120);
  if (name) out.name = name;
  else if (!opts.partial) return bad('name is required');

  if ('zone' in b || !opts.partial) {
    const zone = parseZone(b.zone);
    if (!zone.ok) return zone;
    out.zone = zone.value;
  }
  if ('rate' in b || !opts.partial) {
    const rate = parseRate(b.rate);
    if (!rate.ok) return rate;
    out.rate = rate.value;
  }

  if ('enabled' in b) out.enabled = b.enabled === true;
  else if (!opts.partial) out.enabled = true;

  if ('description' in b) out.description = strIn(b.description, 300);
  if ('tax_class' in b) out.tax_class = strIn(b.tax_class, 64)?.toLowerCase();
  if ('position' in b) out.position = intIn(b.position, 0, 100_000) ?? undefined;
  if ('min_weight_grams' in b) out.min_weight_grams = intIn(b.min_weight_grams, 0, 10_000_000);
  if ('max_weight_grams' in b) out.max_weight_grams = intIn(b.max_weight_grams, 0, 10_000_000);

  if (
    out.min_weight_grams != null && out.max_weight_grams != null &&
    out.min_weight_grams > out.max_weight_grams
  ) {
    // An inverted range matches no basket at all, so the method would appear
    // configured and never be offered.
    return bad('min_weight_grams cannot exceed max_weight_grams');
  }

  return { ok: true, value: out };
}

export function normalizeCoupon(
  raw: unknown,
  opts: { partial?: boolean } = {},
): Parsed<Partial<Coupon>> {
  if (!raw || typeof raw !== 'object') return bad('Body must be a JSON object');
  const b = raw as Record<string, unknown>;
  const out: Partial<Coupon> = {};

  const code = normalizeCouponCode(b.code);
  if (code) {
    if (!/^[A-Z0-9_-]{2,40}$/.test(code)) {
      return bad('code may contain only letters, digits, dashes and underscores (2–40 chars)');
    }
    out.code = code;
  } else if (!opts.partial) {
    return bad('code is required');
  }

  if ('kind' in b || !opts.partial) {
    const kind = b.kind;
    if (kind !== 'percent' && kind !== 'fixed') return bad('kind must be "percent" or "fixed"');
    out.kind = kind as CouponKind;
  }

  if ('value' in b || !opts.partial) {
    const kind = out.kind ?? 'percent';
    // A percentage is basis points and cannot exceed 100%; a fixed amount is
    // minor units. Sharing one field keeps the record small, so the bound
    // depends on the kind.
    const max = kind === 'percent' ? 10_000 : MAX_MONEY;
    const value = intIn(b.value, 0, max);
    if (value === null) {
      return bad(
        kind === 'percent'
          ? 'value must be basis points between 0 and 10000 (1000 = 10%)'
          : 'value must be a whole number of cents',
      );
    }
    out.value = value;
  }

  if ('enabled' in b) out.enabled = b.enabled === true;
  else if (!opts.partial) out.enabled = true;

  if ('description' in b) out.description = strIn(b.description, 300);
  if ('min_subtotal_cents' in b) out.min_subtotal_cents = intIn(b.min_subtotal_cents, 0, MAX_MONEY);
  if ('usage_limit' in b) out.usage_limit = intIn(b.usage_limit, 1, 1_000_000);
  if ('usage_limit_per_customer' in b) out.usage_limit_per_customer = intIn(b.usage_limit_per_customer, 1, 10_000);
  if ('free_shipping' in b) out.free_shipping = b.free_shipping === true;
  // An AUTOMATIC rule applies with no code typed. `=== true` is right here and
  // not the settings-style leniency: this arrives as JSON from an admin form,
  // not from the settings table, so there is no string to tolerate — and the
  // safe default for "discount everybody without being asked" is off.
  if ('automatic' in b) out.automatic = b.automatic === true;

  for (const key of ['starts_at', 'ends_at'] as const) {
    if (!(key in b)) continue;
    const v = b[key];
    if (v === null || v === '') { out[key] = null; continue; }
    const t = typeof v === 'string' ? Date.parse(v) : NaN;
    // An unparseable date must not become "no limit" — that would make an
    // expired coupon eternal.
    if (!Number.isFinite(t)) return bad(`${key} must be an ISO date`);
    out[key] = new Date(t).toISOString();
  }
  if (out.starts_at && out.ends_at && Date.parse(out.starts_at) > Date.parse(out.ends_at)) {
    return bad('starts_at cannot be after ends_at');
  }

  const idList = (v: unknown) =>
    Array.isArray(v)
      ? v.filter((x): x is string => typeof x === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(x.trim()))
         .map((x) => x.trim()).slice(0, 200)
      : [];
  if ('product_ids' in b) out.product_ids = idList(b.product_ids);
  if ('category_slugs' in b) {
    out.category_slugs = Array.isArray(b.category_slugs)
      ? b.category_slugs.filter((x): x is string => typeof x === 'string')
         .map((x) => x.trim().toLowerCase()).filter(Boolean).slice(0, 200)
      : [];
  }

  if (!opts.partial) out.used_count = 0;
  return { ok: true, value: out };
}
