/**
 * Campaign attribution for a headless storefront: remember which campaign link
 * brought the shopper, and send it with the order.
 *
 * The CMS does this by itself for pages it serves (its `/consent.js` and a
 * first-party cookie). A storefront on its own domain has its own visitors,
 * its own consent banner and its own storage, so it does the same here and
 * passes the result as `attribution` on `POST /api/orders`.
 *
 * ## Consent, and why it fails closed
 *
 * Campaign tags and ad click ids are kept ONLY when the shopper granted the
 * MARKETING category. This starter ships no banner of its own, so it asks
 * `hasMarketingConsent()` — by default, the CMS consent API
 * (`window.astrobaasConsent.has('marketing')`) if your storefront loads the
 * CMS's `/consent.js`, and otherwise NO. Wire it to your own banner if you use
 * another one. Without consent nothing is stored, anything stored earlier is
 * deleted, and the order goes out with no `attribution` at all.
 *
 * ## What is kept
 *
 * The eight parameters the CMS accepts and a time. No referrer, no landing
 * URL: those carry whatever was in somebody's query string. The CMS validates
 * strictly and refuses an order carrying anything else, so the rules here
 * mirror its own (lib/commerce/attribution.ts in the CMS).
 */

export const ATTRIBUTION_STORAGE_KEY = 'shop:attribution';
export const ATTRIBUTION_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'fbclid', 'msclkid'] as const;
const CLICK_KEYS = new Set(['gclid', 'fbclid', 'msclkid']);
const LOWERCASE = new Set(['utm_source', 'utm_medium']);
/** The CMS refuses a touch older than this. */
export const ATTRIBUTION_MAX_AGE_DAYS = 90;
const MAX_UTM = 100;
const MAX_CLICK = 200;
const CLICK_ID = /^[A-Za-z0-9._~-]+$/;
const UTM_FORBIDDEN = /[\u0000-\u001f\u007f<>"'`\\]/;

export type Touch = Partial<Record<(typeof ATTRIBUTION_KEYS)[number], string>> & { at: string };
export interface Attribution { first: Touch; last: Touch }

interface Store { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }

/** The default consent check: the CMS consent API, if this page loaded it. Otherwise no. */
export function cmsMarketingConsent(): boolean {
  try {
    const api = (globalThis as { astrobaasConsent?: { has?: (c: string) => boolean } }).astrobaasConsent;
    return typeof api?.has === 'function' && api.has('marketing') === true;
  } catch {
    return false;
  }
}

function clean(key: string, raw: string | null): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  if (!v) return null;
  if (CLICK_KEYS.has(key)) return v.length <= MAX_CLICK && CLICK_ID.test(v) ? v : null;
  if (v.length > MAX_UTM || UTM_FORBIDDEN.test(v)) return null;
  return LOWERCASE.has(key) ? v.toLowerCase() : v;
}

function fresh(t: unknown, nowMs: number): t is Touch {
  if (!t || typeof t !== 'object' || typeof (t as Touch).at !== 'string') return false;
  const ms = Date.parse((t as Touch).at);
  return Number.isFinite(ms) && ms <= nowMs + 5 * 60_000 && nowMs - ms <= ATTRIBUTION_MAX_AGE_DAYS * 86_400_000;
}

/** What is stored, if it is still usable. A stale first touch gives way to the last one. */
export function readAttribution(store: Store, nowMs = Date.now()): Attribution | null {
  let parsed: unknown;
  try { parsed = JSON.parse(store.getItem(ATTRIBUTION_STORAGE_KEY) || 'null'); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  const { first, last } = parsed as { first?: unknown; last?: unknown };
  if (!fresh(last, nowMs)) return null;
  return { first: fresh(first, nowMs) && Date.parse(first.at) <= Date.parse(last.at) ? first : last, last };
}

/**
 * Call on every page load. Keeps a touch when the URL carries campaign
 * parameters AND the shopper consented to marketing; deletes what is stored
 * when they have not.
 */
export function captureAttribution(
  store: Store,
  search: string,
  hasMarketingConsent: () => boolean = cmsMarketingConsent,
  nowMs = Date.now(),
): Attribution | null {
  if (!hasMarketingConsent()) {
    store.removeItem(ATTRIBUTION_STORAGE_KEY);
    return null;
  }
  const params = new URLSearchParams(search);
  const touch: Record<string, string> = {};
  for (const k of ATTRIBUTION_KEYS) {
    const v = clean(k, params.get(k));
    if (v !== null) touch[k] = v;
  }
  if (!Object.keys(touch).length) {
    const kept = readAttribution(store, nowMs);
    // Past its 90 days (or unreadable): forget it rather than carry a click
    // id in storage forever.
    if (!kept) store.removeItem(ATTRIBUTION_STORAGE_KEY);
    return kept;
  }
  const next: Touch = { ...touch, at: new Date(nowMs).toISOString() };
  const existing = readAttribution(store, nowMs);
  const rec: Attribution = { first: existing?.first ?? next, last: next };
  try { store.setItem(ATTRIBUTION_STORAGE_KEY, JSON.stringify(rec)); } catch { /* storage full or blocked: keep nothing */ }
  return rec;
}

/**
 * The `attribution` field for `POST /api/orders`, or nothing. Re-checks consent
 * at the moment of checkout: a shopper who withdrew it since landing sends
 * nothing.
 */
export function attributionForOrder(
  store: Store,
  hasMarketingConsent: () => boolean = cmsMarketingConsent,
  nowMs = Date.now(),
): { attribution: Attribution } | Record<string, never> {
  if (!hasMarketingConsent()) {
    store.removeItem(ATTRIBUTION_STORAGE_KEY);
    return {};
  }
  const rec = readAttribution(store, nowMs);
  if (!rec) store.removeItem(ATTRIBUTION_STORAGE_KEY);
  return rec ? { attribution: rec } : {};
}
