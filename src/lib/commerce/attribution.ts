/**
 * Conversion attribution: which campaign brought the order.
 *
 * Pure — no storage, no DOM, no clock unless one is passed — so the route, the
 * served `/consent.js`, the orders screen and the Insights report all read ONE
 * definition, and every rule is testable on its own.
 *
 * ## Privacy is the design, not a feature of it
 *
 *  1. **Marketing consent first, or nothing.** A campaign tag and an ad click id
 *     (`gclid`, `fbclid`, `msclkid`) are identifiers an advertising platform can
 *     join back to a person. Keeping them is storage for a marketing purpose,
 *     so ePrivacy Art. 5(3) needs PRIOR consent. The browser keeps them only
 *     after the visitor granted the `marketing` category (`/consent.js`), and
 *     the server re-checks the consent cookie before it reads them at checkout.
 *     No consent means no cookie and an order with no `attribution` at all —
 *     never an empty object, never a guess.
 *  2. **First-party only.** One cookie on this site's own domain. Nothing is
 *     sent anywhere; the ad platforms' own pixels are a separate, separately
 *     consented thing (lib/analytics.ts).
 *  3. **Known keys only.** Eight URL parameters and a timestamp. No referrer,
 *     no landing URL, no user agent, no free-form "custom" bag: a referrer or a
 *     full URL routinely carries an email address or a reset token in its query
 *     string, and a bag of arbitrary keys is where that would end up. The same
 *     reasoning that makes popular searches store only what is needed
 *     (lib/search/popular.ts).
 *  4. **Bounded.** Every value has a length cap and a character rule, the
 *     cookie expires (`ATTRIBUTION_MAX_AGE_DAYS`), and a touch older than that
 *     is refused rather than trusted.
 *  5. **Part of the order's personal data.** A data-subject export includes it
 *     (it is a field on the order) and an erasure removes it (lib/gdpr.ts).
 *
 * ## First touch and last touch
 *
 * `first` is the first campaign visit the browser remembers, `last` the most
 * recent. Both carry the time they happened. That is the whole model the core
 * offers: splitting credit across touches is the paid multi-touch module's job.
 */
import { CONSENT_COOKIE, decodeConsent, hasConsent } from '../consent';
import { settingBool } from '../settings-map';
import { resolveCommerceEnabled } from '../commerce-settings';

/** The five campaign tags, in the order they are shown. */
export const ATTRIBUTION_UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'] as const;
/** Ad-platform click ids: Google Ads, Meta, Microsoft Ads. */
export const ATTRIBUTION_CLICK_KEYS = ['gclid', 'fbclid', 'msclkid'] as const;
/** Every parameter a touch may carry. Anything else is refused. */
export const ATTRIBUTION_KEYS = [...ATTRIBUTION_UTM_KEYS, ...ATTRIBUTION_CLICK_KEYS] as const;
export type AttributionKey = (typeof ATTRIBUTION_KEYS)[number];

/** The first-party cookie. Set only with marketing consent. */
export const ATTRIBUTION_COOKIE = 'astrobaas_attribution';
/** Cookie format version, inside the value. */
export const ATTRIBUTION_COOKIE_VERSION = 1;
/**
 * How long a campaign visit is remembered. Ninety days is the usual click
 * window of the ad platforms whose ids this keeps, and well inside the consent
 * record's own lifetime.
 */
export const ATTRIBUTION_MAX_AGE_DAYS = 90;
/** A campaign tag longer than this is not a tag. */
export const MAX_UTM_LENGTH = 100;
/** gclid/fbclid/msclkid are opaque tokens of well under 200 characters. */
export const MAX_CLICK_ID_LENGTH = 200;
/** Clock skew tolerated on a touch's time before it counts as "in the future". */
export const FUTURE_SKEW_MS = 5 * 60 * 1000;

/** The merchant's switch. ON by default: it still needs each visitor's consent. */
export const ATTRIBUTION_SETTING = 'attribution_enabled';

/** Click ids are opaque URL-safe tokens. */
export const CLICK_ID_PATTERN = /^[A-Za-z0-9._~-]+$/;
/**
 * Campaign tags are free text written by a marketer, so letters in any script
 * are fine ("καλοκαίρι-2026"). What is refused is what has no business in a
 * tag and every business in an attack: control characters, markup, quotes and
 * backslashes.
 */
export const UTM_FORBIDDEN = /[\u0000-\u001f\u007f<>"'`\\]/;
/** Lower-cased, because "Google" and "google" are one source to a merchant. */
const LOWERCASED: ReadonlySet<string> = new Set(['utm_source', 'utm_medium']);

export type AttributionTouch = Partial<Record<AttributionKey, string>> & {
  /** ISO time of the visit. */
  at: string;
};

export interface OrderAttribution {
  first: AttributionTouch;
  last: AttributionTouch;
}

export function isAttributionKey(k: unknown): k is AttributionKey {
  return typeof k === 'string' && (ATTRIBUTION_KEYS as readonly string[]).includes(k);
}

function isClickKey(k: string): boolean {
  return (ATTRIBUTION_CLICK_KEYS as readonly string[]).includes(k);
}

/**
 * One parameter value, cleaned. `undefined` for "not present" (absent or
 * blank); an error string when present and unacceptable.
 */
export function cleanAttributionValue(
  key: AttributionKey,
  raw: unknown,
): { ok: true; value: string | undefined } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== 'string') return { ok: false, error: 'must be text' };
  const v = raw.trim();
  if (!v) return { ok: true, value: undefined };
  if (isClickKey(key)) {
    if (v.length > MAX_CLICK_ID_LENGTH) return { ok: false, error: `must be at most ${MAX_CLICK_ID_LENGTH} characters` };
    if (!CLICK_ID_PATTERN.test(v)) return { ok: false, error: 'may contain only letters, digits, . _ ~ and -' };
    return { ok: true, value: v };
  }
  if (v.length > MAX_UTM_LENGTH) return { ok: false, error: `must be at most ${MAX_UTM_LENGTH} characters` };
  if (UTM_FORBIDDEN.test(v)) return { ok: false, error: 'must be plain text without quotes, markup or control characters' };
  return { ok: true, value: LOWERCASED.has(key) ? v.toLowerCase() : v };
}

/**
 * A touch built from a landing URL's query string.
 *
 * LENIENT on purpose, because the input is a link someone else wrote: a
 * malformed value is dropped and the good ones kept. `null` when the URL
 * carries no usable parameter — an ordinary visit is not a campaign touch.
 *
 * `/consent.js` runs the same rules in the browser; a test drives both with the
 * same table so they cannot drift.
 */
export function touchFromParams(
  params: URLSearchParams | Record<string, string | undefined>,
  nowIso: string,
): AttributionTouch | null {
  const get = (k: string): string | null => (params instanceof URLSearchParams
    ? params.get(k)
    : (typeof params[k] === 'string' ? params[k]! : null));
  const touch: Partial<Record<AttributionKey, string>> = {};
  let any = false;
  for (const key of ATTRIBUTION_KEYS) {
    const checked = cleanAttributionValue(key, get(key));
    if (checked.ok && checked.value !== undefined) {
      touch[key] = checked.value;
      any = true;
    }
  }
  return any ? { ...touch, at: nowIso } : null;
}

/** A new visit: the remembered first touch stays, the last touch moves. */
export function mergeTouch(existing: OrderAttribution | null, touch: AttributionTouch): OrderAttribution {
  return { first: existing?.first ?? touch, last: touch };
}

type FieldErrors = Record<string, string>;

function parseTouch(
  raw: unknown, nowMs: number, path: string, errors: FieldErrors, lenientClock = false,
): AttributionTouch | 'stale' | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors[path] = 'must be an object';
    return null;
  }
  const out: Partial<Record<AttributionKey, string>> = {};
  let any = false;
  let bad = false;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k === 'at') continue;
    if (!isAttributionKey(k)) {
      errors[`${path}.${k}`] = 'is not an attribution parameter';
      bad = true;
      continue;
    }
    const checked = cleanAttributionValue(k, v);
    if (!checked.ok) {
      errors[`${path}.${k}`] = checked.error;
      bad = true;
    } else if (checked.value !== undefined) {
      out[k] = checked.value;
      any = true;
    }
  }
  const at = (raw as { at?: unknown }).at;
  let t = typeof at === 'string' && at.length <= 40 ? Date.parse(at) : NaN;
  let stale = false;
  if (!Number.isFinite(t)) {
    errors[`${path}.at`] = 'must be an ISO 8601 time';
    bad = true;
  } else if (t > nowMs + FUTURE_SKEW_MS) {
    // A shopper's fast clock is not the storefront's bug and must never cost
    // the sale: with a lenient clock the time is clamped to the server's now.
    if (lenientClock) t = nowMs;
    else {
      errors[`${path}.at`] = 'must not be in the future';
      bad = true;
    }
  } else if (nowMs - t > ATTRIBUTION_MAX_AGE_DAYS * 86_400_000) {
    // ...and a touch that aged out by the server's clock is simply not kept.
    if (lenientClock) stale = true;
    else {
      errors[`${path}.at`] = `must be within the last ${ATTRIBUTION_MAX_AGE_DAYS} days`;
      bad = true;
    }
  }
  if (!bad && !any) {
    errors[path] = 'must carry at least one utm_* parameter or click id';
    bad = true;
  }
  if (bad) return null;
  if (stale) return 'stale';
  return { ...out, at: new Date(t).toISOString() };
}

/**
 * STRICT parser for `attribution` as a client sends it to `POST /api/orders`.
 *
 * `{ first?, last? }` with at least one of the two; a missing one is copied
 * from the other (a single campaign visit is both the first and the last).
 * Unknown keys anywhere, a non-string value, an over-long value, a bad time,
 * or a first touch newer than the last are REFUSED with a message per field —
 * a headless storefront has to hear that it is sending something wrong, rather
 * than have it quietly dropped.
 *
 * `lenientClock` (what `POST /api/orders` uses): the SHAPE stays strict, but
 * the time window is judged gently, because `at` was stamped by the shopper's
 * device and a wrong device clock is nobody's bug to refuse a sale over. A
 * future time is clamped to now, a touch older than the window is dropped (both
 * dropped means no attribution), and a first touch later than the last gives
 * way to the last. A time that does not parse is still refused.
 */
export function parseAttribution(
  raw: unknown,
  nowMs: number,
  opts: { lenientClock?: boolean } = {},
): { ok: true; value: OrderAttribution | undefined } | { ok: false; errors: FieldErrors } {
  const lenient = opts.lenientClock === true;
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  const errors: FieldErrors = {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: { attribution: 'must be an object with "first" and/or "last"' } };
  }
  const obj = raw as Record<string, unknown>;
  for (const k of Object.keys(obj)) {
    if (k !== 'first' && k !== 'last') errors[`attribution.${k}`] = 'is not allowed (only "first" and "last")';
  }
  if (obj.first === undefined && obj.last === undefined) {
    errors.attribution = 'must carry "first" and/or "last"';
  }
  const p1 = obj.first === undefined ? null : parseTouch(obj.first, nowMs, 'attribution.first', errors, lenient);
  const p2 = obj.last === undefined ? null : parseTouch(obj.last, nowMs, 'attribution.last', errors, lenient);
  if (Object.keys(errors).length) return { ok: false, errors };
  const first = p1 === 'stale' ? null : p1;
  const last = p2 === 'stale' ? null : p2;
  if (!first && !last) return { ok: true, value: undefined }; // everything aged out
  let f = first ?? last!;
  const l = last ?? first!;
  if (Date.parse(f.at) > Date.parse(l.at)) {
    if (!lenient) {
      return { ok: false, errors: { 'attribution.first.at': 'must not be later than attribution.last.at' } };
    }
    f = l;
  }
  return { ok: true, value: { first: f, last: l } };
}

/** The cookie value. URL-encoded JSON, the same encoding the consent cookie uses. */
export function encodeAttributionCookie(rec: OrderAttribution): string {
  return encodeURIComponent(JSON.stringify({ v: ATTRIBUTION_COOKIE_VERSION, first: rec.first, last: rec.last }));
}

/**
 * Read the cookie back. LENIENT: anything malformed, stale or from another
 * version is `null` — a cookie is not a client that can be told it is wrong,
 * and an order must never fail because of one.
 */
export function decodeAttributionCookie(raw: string | null | undefined, nowMs: number): OrderAttribution | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeURIComponent(raw));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const p = parsed as { v?: unknown; first?: unknown; last?: unknown };
  if (p.v !== ATTRIBUTION_COOKIE_VERSION) return null;
  const res = parseAttribution({ first: p.first, last: p.last }, nowMs);
  if (res.ok && res.value) return res.value;
  // Each new visit refreshes the cookie, so it can outlive its first touch. A
  // first touch that has aged out of the window is dropped and the last one
  // stands for both: the earliest visit still INSIDE the window. Better than
  // losing a valid recent touch because an old one expired.
  if (p.last === undefined) return null;
  const lastOnly = parseAttribution({ last: p.last }, nowMs);
  return lastOnly.ok && lastOnly.value ? lastOnly.value : null;
}

/** One cookie from a `Cookie:` header, undecoded. */
export function cookieFromHeader(header: string | null | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/**
 * Attribution from the visitor's own cookies, for a checkout placed from this
 * site's pages.
 *
 * The CONSENT cookie is re-checked here, not trusted from the browser's
 * behaviour: if the visitor has since withdrawn marketing consent (or it has
 * expired, or was given under an older version of the categories) the
 * attribution cookie is ignored even if it is still sitting there.
 */
export function attributionFromCookies(cookieHeader: string | null | undefined, nowMs: number): OrderAttribution | null {
  const consentRaw = cookieFromHeader(cookieHeader, CONSENT_COOKIE);
  let consentValue: string | null = null;
  try {
    consentValue = consentRaw === null ? null : decodeURIComponent(consentRaw);
  } catch {
    consentValue = null;
  }
  if (!hasConsent(decodeConsent(consentValue, nowMs), 'marketing')) return null;
  return decodeAttributionCookie(cookieFromHeader(cookieHeader, ATTRIBUTION_COOKIE), nowMs);
}

/**
 * True when the request carries a VALID consent record from this site that
 * does NOT grant marketing — an explicit, current "no". A storefront's body
 * attribution is then ignored too: the visitor's own answer on this origin
 * outranks what a client claims. No cookie at all says nothing either way
 * (a headless storefront's visitors have their consent on another origin).
 */
export function consentCookieRefusesMarketing(cookieHeader: string | null | undefined, nowMs: number): boolean {
  const raw = cookieFromHeader(cookieHeader, CONSENT_COOKIE);
  if (raw === null) return false;
  let value: string | null;
  try { value = decodeURIComponent(raw); } catch { return false; }
  const rec = decodeConsent(value, nowMs);
  return !!rec && !hasConsent(rec, 'marketing');
}

/** Whether this install keeps attribution at all: the shop is on AND the merchant has not switched it off. */
export function resolveAttributionEnabled(settings: Record<string, unknown> | null | undefined): boolean {
  const map = settings ?? {};
  return resolveCommerceEnabled(map) && settingBool(map[ATTRIBUTION_SETTING], true);
}

/* ------------------------------------------------------------------ *
 * The report                                                          *
 * ------------------------------------------------------------------ */

export type AttributionModel = 'first' | 'last';
export const ATTRIBUTION_MODELS: readonly AttributionModel[] = ['first', 'last'];

/** Shown for a dimension the touch did not carry. */
export const NOT_SET = '(not set)';

export interface AttributionRow {
  source: string;
  medium: string;
  campaign: string;
  /** The currency `revenue_cents` is in: the shop's base currency at the time of each order. */
  currency: string;
  orders: number;
  revenue_cents: number;
}

export interface AttributionReport {
  model: AttributionModel;
  /** Inclusive UTC days, `YYYY-MM-DD`. */
  from: string;
  to: string;
  rows: AttributionRow[];
  /** Paid orders in the range. */
  orders: number;
  /** Of those, how many carry attribution. The rest are listed as one row in the UI. */
  attributed: number;
  /** Paid orders in the range with no attribution: no consent, no campaign, or older than this feature. */
  unattributed: number;
  unattributed_revenue: Record<string, number>;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** A report longer than this is refused — two years is plenty for a campaign question. */
export const MAX_REPORT_DAYS = 731;

function isDay(s: string): boolean {
  if (!DAY_RE.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00.000Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
}

/**
 * The date range and model from a query string. Defaults: the last 30 days
 * ending today (UTC), last-touch.
 */
export function parseReportQuery(
  params: URLSearchParams,
  nowMs: number,
): { ok: true; value: { from: string; to: string; model: AttributionModel } } | { ok: false; error: string } {
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const to = (params.get('to') || '').trim() || today;
  if (!isDay(to)) return { ok: false, error: '"to" must be a date as YYYY-MM-DD' };
  const from = (params.get('from') || '').trim()
    || new Date(Date.parse(`${to}T00:00:00.000Z`) - 29 * 86_400_000).toISOString().slice(0, 10);
  if (!isDay(from)) return { ok: false, error: '"from" must be a date as YYYY-MM-DD' };
  if (from > to) return { ok: false, error: '"from" must not be after "to"' };
  const span = (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000 + 1;
  if (span > MAX_REPORT_DAYS) return { ok: false, error: `the range must be at most ${MAX_REPORT_DAYS} days` };
  const rawModel = (params.get('model') || 'last').trim();
  if (rawModel !== 'first' && rawModel !== 'last') return { ok: false, error: '"model" must be "first" or "last"' };
  return { ok: true, value: { from, to, model: rawModel } };
}

/** The order fields the report reads. Structural, so a test can pass plain records. */
export interface ReportOrder {
  created_at?: string;
  payment_status?: string;
  currency?: string;
  total_cents?: number;
  base_currency?: string;
  base_total_cents?: number;
  attribution?: OrderAttribution;
}

/**
 * Orders and revenue by source, medium and campaign.
 *
 * PAID orders only — the rule the dashboard and Insights already apply, reused
 * rather than re-decided: an unpaid order is not revenue. Revenue is in the
 * shop's BASE currency (`base_total_cents ?? total_cents`), so a shop quoting
 * several currencies still sums like with like, and a row is per currency in
 * the rare case the base itself changed inside the range.
 */
export function attributionReport(
  orders: readonly ReportOrder[],
  opts: { from: string; to: string; model: AttributionModel },
): AttributionReport {
  const start = Date.parse(`${opts.from}T00:00:00.000Z`);
  const end = Date.parse(`${opts.to}T00:00:00.000Z`) + 86_400_000;
  const rows = new Map<string, AttributionRow>();
  let count = 0;
  let attributed = 0;
  const unattributedRevenue: Record<string, number> = {};
  for (const o of orders) {
    if ((o.payment_status ?? 'unpaid') !== 'paid') continue;
    const t = Date.parse(String(o.created_at ?? ''));
    if (!Number.isFinite(t) || t < start || t >= end) continue;
    count += 1;
    const currency = String(o.base_currency || o.currency || '').toUpperCase() || 'EUR';
    const cents = Number(o.base_total_cents ?? o.total_cents) || 0;
    const touch = o.attribution?.[opts.model];
    if (!touch) {
      unattributedRevenue[currency] = (unattributedRevenue[currency] ?? 0) + cents;
      continue;
    }
    attributed += 1;
    const source = touch.utm_source || NOT_SET;
    const medium = touch.utm_medium || NOT_SET;
    const campaign = touch.utm_campaign || NOT_SET;
    const key = JSON.stringify([source, medium, campaign, currency]);
    const row = rows.get(key) ?? { source, medium, campaign, currency, orders: 0, revenue_cents: 0 };
    row.orders += 1;
    row.revenue_cents += cents;
    rows.set(key, row);
  }
  const sorted = [...rows.values()].sort((a, b) => (b.revenue_cents - a.revenue_cents)
    || (b.orders - a.orders)
    || a.source.localeCompare(b.source)
    || a.medium.localeCompare(b.medium)
    || a.campaign.localeCompare(b.campaign));
  return {
    model: opts.model,
    from: opts.from,
    to: opts.to,
    rows: sorted,
    orders: count,
    attributed,
    unattributed: count - attributed,
    unattributed_revenue: unattributedRevenue,
  };
}

/** The CSV columns, in order. Revenue is a plain decimal in `currency`. */
export const ATTRIBUTION_CSV_COLUMNS = ['model', 'from', 'to', 'source', 'medium', 'campaign', 'orders', 'revenue', 'currency'] as const;

/**
 * One touch, as the orders screen prints it: `source / medium · campaign`,
 * then whatever else it carried. Pure so the screen has no logic of its own.
 */
export function touchSummary(touch: AttributionTouch): { headline: string; details: string[]; at: string } {
  const headline = `${touch.utm_source || NOT_SET} / ${touch.utm_medium || NOT_SET}`
    + (touch.utm_campaign ? ` · ${touch.utm_campaign}` : '');
  const details: string[] = [];
  if (touch.utm_term) details.push(`term: ${touch.utm_term}`);
  if (touch.utm_content) details.push(`content: ${touch.utm_content}`);
  for (const k of ATTRIBUTION_CLICK_KEYS) if (touch[k]) details.push(`${k}: ${touch[k]}`);
  return { headline, details, at: touch.at };
}
