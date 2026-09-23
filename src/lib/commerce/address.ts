/**
 * Postal addresses — normalisation, completeness, and the one-line projection.
 *
 * Pure and dependency-free, like admin-normalize.ts beside it: no storage, no
 * settings, no clock. Everything here is a function of its arguments, which is
 * what lets checkout, the admin, the importer and the tests all reach the same
 * answer instead of each rolling their own.
 *
 * **The direction of travel is one-way.** Structured fields render DOWN to a
 * one-line string (`formatAddressOneLine`), and nothing here ever parses a
 * one-line string UP into fields. That is not an omission. Splitting
 * "Οδός Ερμού 15, 3ος, 10563 Αθήνα" into line1/line2/postcode/city is guessing,
 * and a guessed postcode is a courier label sent to the wrong depot or a VAT
 * figure re-derived against the wrong zone. An address we do not have is
 * `undefined`, which is a fact; an address we invented is a liability.
 */
import type { Address, SavedAddress } from '../../core/models';

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const bad = (error: string): { ok: false; error: string } => ({ ok: false, error });

/** Bounded so a stranger with an account cannot grow one record without limit. */
export const MAX_SAVED_ADDRESSES = 20;

/**
 * Per-field caps. Generous, because a real address in a language with long
 * words is longer than an English one, and stingy caps truncate silently.
 */
const CAPS = {
  name: 200,
  company: 200,
  line1: 200,
  line2: 200,
  city: 120,
  region: 120,
  postcode: 20,
  country: 2,
  phone: 40,
  tax_id: 40,
  label: 60,
} as const;

function str(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t === '' ? undefined : t.slice(0, max);
}

/**
 * ISO 3166-1 alpha-2, or null.
 *
 * The same rule shipping zones already use (admin-normalize.ts), so a country
 * that can be shipped to and a country that can be stored are the same
 * vocabulary. "Greece" returns null rather than 'GR': mapping a name to a code
 * needs a table that goes stale, and picking one by looking at the string is
 * invention. Null is the honest answer and the caller decides what to do with
 * it.
 */
export function normalizeCountryCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(t) ? t : null;
}

/**
 * Name a country in the reader's language.
 *
 * `Intl.DisplayNames` rather than a shipped dataset: the runtime already
 * carries every region name in every locale it supports, and a table checked
 * into this repo would be one more thing to update when a country changes its
 * name. Falls back to the raw code — the same try/catch shape locale-links.ts
 * uses for language names, and for the same reason: a runtime without full ICU
 * must degrade to something readable, not throw on a product page.
 */
export function countryName(code: string | undefined, locale?: string): string {
  if (!code) return '';
  try {
    return new Intl.DisplayNames([locale || 'en'], { type: 'region' }).of(code) || code;
  } catch {
    return code;
  }
}

/**
 * Clean one address.
 *
 * Rebuilt key by key rather than spread: the input is client JSON, and
 * `{ ...raw }` would carry whatever else was posted straight into storage.
 *
 * A bad country is REFUSED rather than dropped. Dropping it would store an
 * address that looks complete, ships nowhere, and gives the operator nothing to
 * act on — the failure would surface as a courier rejecting the parcel, not as
 * a form error where it can still be fixed.
 */
export function normalizeAddress(raw: unknown): Parsed<Address> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return bad('address must be an object');
  }
  const a = raw as Record<string, unknown>;

  let country: string | undefined;
  if (a.country !== undefined && a.country !== null && a.country !== '') {
    const code = normalizeCountryCode(a.country);
    if (!code) return bad('address.country must be a two-letter ISO country code, e.g. GR');
    country = code;
  }

  const out: Address = {};
  const put = (k: keyof typeof CAPS, v: string | undefined) => {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  };
  put('name', str(a.name, CAPS.name));
  put('company', str(a.company, CAPS.company));
  put('line1', str(a.line1, CAPS.line1));
  put('line2', str(a.line2, CAPS.line2));
  put('city', str(a.city, CAPS.city));
  put('region', str(a.region, CAPS.region));
  put('postcode', str(a.postcode, CAPS.postcode));
  if (country) out.country = country;
  put('phone', str(a.phone, CAPS.phone));
  put('tax_id', str(a.tax_id, CAPS.tax_id));

  return { ok: true, value: out };
}

/**
 * Is this enough to put on a parcel?
 *
 * ONE definition, so checkout's refusal and the admin's "ready to label" badge
 * can never disagree. `region` is not required: it is mandatory for a US or
 * Canadian label and meaningless for a Greek one, and a core rule that demanded
 * it would block the shop this is being built for.
 */
export function isCompleteAddress(a: Address | undefined): boolean {
  if (!a) return false;
  return Boolean(a.name && a.line1 && a.city && a.postcode && a.country);
}

/** True when every field matches, treating absent and empty as the same thing. */
export function addressesEqual(a: Address | undefined, b: Address | undefined): boolean {
  const A = a ?? {};
  const B = b ?? {};
  const keys: (keyof Address)[] = [
    'name', 'company', 'line1', 'line2', 'city', 'region', 'postcode', 'country', 'phone', 'tax_id',
  ];
  return keys.every((k) => (A[k] ?? '') === (B[k] ?? ''));
}

/** True when nothing was actually filled in. */
export function isEmptyAddress(a: Address | undefined): boolean {
  return addressesEqual(a, {});
}

/**
 * The compatibility projection: structured fields → the one-line string that
 * `Order.address` has always held.
 *
 * Both live storefronts read `Order.address`. Keeping it filled is what lets
 * structured addresses ship without a coordinated deploy of two Next.js apps.
 *
 * Excludes three things on purpose:
 *  - `name`, because every renderer that prints this string prints `order.name`
 *    on the line above it, and the receipt would say the name twice;
 *  - `phone`, which is `Order.phone` and is not part of a postal address;
 *  - `tax_id`, which belongs on an invoice header, not on a parcel.
 *
 * Absent fields leave no empty separators behind — ", , 10563" is how a
 * template betrays that it was built out of optional parts.
 */
export function formatAddressOneLine(a: Address | undefined, locale?: string): string {
  if (!a) return '';
  const parts = [
    a.company,
    a.line1,
    a.line2,
    [a.postcode, a.city].filter(Boolean).join(' '),
    a.region,
    countryName(a.country, locale),
  ].map((p) => (p ?? '').trim()).filter(Boolean);
  return parts.join(', ').slice(0, 500);
}

/**
 * Clean one saved address (an address in a customer's book).
 *
 * The defaults are two independent booleans rather than one
 * `type: 'billing' | 'shipping' | 'both'`, because "both" is not a third kind
 * of address — it is two answers to two questions, and the enum forces a
 * three-way choice on a two-boolean fact. `normalizeSavedAddresses` below is
 * what keeps at most one of each true.
 */
export function normalizeSavedAddress(raw: unknown, id: string): Parsed<SavedAddress> {
  const base = normalizeAddress(raw);
  if (!base.ok) return base;
  const a = (raw ?? {}) as Record<string, unknown>;
  const out: SavedAddress = { ...base.value, id };
  const label = str(a.label, CAPS.label);
  if (label) out.label = label;
  if (a.default_shipping === true) out.default_shipping = true;
  if (a.default_billing === true) out.default_billing = true;
  return { ok: true, value: out };
}

/**
 * Clean a whole address book, enforcing the one-default invariant.
 *
 * The invariant is enforced ON WRITE, here, and never re-derived on read as
 * "the first one with the flag". A read-time rule leaves two rows both claiming
 * to be the default, and which one wins then depends on array order — so the
 * same book answers differently after an unrelated edit reorders it.
 *
 * The LAST row claiming a default wins, because the row a person just edited is
 * appended or updated in place and is the one they meant.
 */
export function normalizeSavedAddresses(
  raw: unknown,
  makeId: () => string,
): { addresses: SavedAddress[]; errors: string[] } {
  if (!Array.isArray(raw)) return { addresses: [], errors: [] };
  const errors: string[] = [];
  const out: SavedAddress[] = [];

  for (const [i, row] of raw.slice(0, MAX_SAVED_ADDRESSES).entries()) {
    const existingId = typeof (row as { id?: unknown })?.id === 'string'
      ? String((row as { id: string }).id).slice(0, 64)
      : '';
    const parsed = normalizeSavedAddress(row, existingId || makeId());
    if (!parsed.ok) {
      errors.push(`addresses[${i}]: ${parsed.error}`);
      continue;
    }
    // An entry with nothing in it is a row somebody opened and abandoned, not
    // an address. Keeping it would put a blank line in every address picker.
    if (isEmptyAddress(parsed.value)) continue;
    out.push(parsed.value);
  }

  for (const flag of ['default_shipping', 'default_billing'] as const) {
    const last = out.map((a) => Boolean(a[flag])).lastIndexOf(true);
    out.forEach((a, i) => {
      if (i === last) a[flag] = true;
      else delete a[flag];
    });
  }

  return { addresses: out, errors };
}

/** The book's default for one purpose, or undefined when it has none. */
export function defaultAddress(
  addresses: SavedAddress[] | undefined,
  purpose: 'shipping' | 'billing',
): SavedAddress | undefined {
  const flag = purpose === 'shipping' ? 'default_shipping' : 'default_billing';
  return (addresses ?? []).find((a) => a[flag] === true);
}
