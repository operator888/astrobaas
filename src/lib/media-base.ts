/**
 * The media base, resolved once per process rather than once per request.
 *
 * Every API response that can carry a media path publishes this, and a single
 * catalogue page view on a 400-product shop is ~450 requests. Reading two
 * settings rows on each of those is a cost nobody would choose deliberately, so
 * the resolved value is memoised.
 *
 * Memoised on the SETTINGS half only. The request origin is part of the answer
 * (see resolveMediaBase) and changes per request, so it is applied on top of the
 * cached settings rather than baked into the cache — otherwise the first caller
 * after a restart would decide the media base for everybody, which on a CMS
 * reachable at two hostnames is a bug that only appears under real traffic.
 *
 * Invalidated explicitly when settings are written, so an operator who fixes the
 * setting sees the fix on the very next request rather than "after a while".
 *
 * ## ...and after MEDIA_BASE_TTL_MS anyway
 *
 * The explicit invalidation only reaches THIS process. With two replicas, the
 * one that did not take the settings write kept publishing the old media base
 * until it restarted — for as long as it ran, with nothing to say why half the
 * API responses carried one origin and half the other. So the memo also
 * expires: another process's write is picked up within 5 seconds. At ~450
 * requests per catalogue page view that is still one settings read per five
 * seconds per process, not one per request.
 */

import { LocalDB } from './localdb';
import { resolveMediaBase } from './media-url';

interface CachedSettings {
  publicSiteUrl: unknown;
  siteUrl: unknown;
}

/** How stale the memo may get when ANOTHER process wrote the settings. */
export const MEDIA_BASE_TTL_MS = 5_000;

let cached: CachedSettings | null = null;
/** When `cached` was loaded (Date.now()). */
let cachedAt = 0;
let inFlight: Promise<CachedSettings> | null = null;
/**
 * Bumped on every invalidation.
 *
 * Clearing `cached` and `inFlight` is not enough on its own: a load that was
 * ALREADY running when the operator saved still resolves afterwards and writes
 * its now-stale snapshot into the cache. The operator would see "Settings
 * saved", the very next request would serve the old base, and a retry would
 * fix it — the worst kind of bug to be told about.
 */
let generation = 0;

/** Drop the memo. Called by every path that writes settings. */
export function invalidateMediaBase(): void {
  cached = null;
  cachedAt = 0;
  inFlight = null;
  generation += 1;
}

async function loadSettings(): Promise<CachedSettings> {
  const rows = await LocalDB.getSettings();
  const map = new Map(rows.map((r) => [r.key, r.value]));
  return {
    publicSiteUrl: map.get('public_site_url'),
    siteUrl: map.get('site_url'),
  };
}

async function settings(): Promise<CachedSettings> {
  if (cached && Date.now() - cachedAt < MEDIA_BASE_TTL_MS) return cached;
  // Memoised on the PROMISE: a boolean check lets every concurrent request past
  // while the first read is still running, and they all hit the database at
  // once — the stampede this cache exists to prevent.
  if (!inFlight) {
    const startedAt = generation;
    inFlight = loadSettings()
      .then((s) => {
        // Only adopt the result if nothing invalidated while it was loading.
        if (generation === startedAt) {
          cached = s;
          cachedAt = Date.now();
        }
        return s;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

/**
 * The origin to join `/uploads/...` to for THIS request.
 *
 * Returns null when nothing usable is configured, exactly like resolveSiteUrl:
 * a null tells the caller to publish only the relative path, which is what
 * every existing consumer already reads. Inventing `http://localhost:4321` and
 * shipping it to a storefront would be worse than saying nothing.
 */
export async function mediaBaseFor(request?: { url?: string; headers?: Headers } | string): Promise<string | null> {
  const requestUrl = typeof request === 'string' ? request : request?.url;
  // Believe the proxy only where the deployment says to, using the SAME switch
  // the middleware uses to decide whether X-Forwarded-For is trustworthy. One
  // rule about trusting the edge, in one place.
  const trustProxy = process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true';
  const forwardedProto = trustProxy && typeof request !== 'string'
    ? request?.headers?.get('x-forwarded-proto') ?? undefined
    : undefined;

  try {
    const s = await settings();
    return resolveMediaBase({
      publicSiteUrl: s.publicSiteUrl,
      siteUrl: s.siteUrl,
      // The build-time SITE_URL, read at RUNTIME from the environment. Astro's
      // own `site` is baked into the bundle, so a unit that sets SITE_URL after
      // a build cannot change it — but the variable is still the operator's
      // declaration of where this install lives, and the precedence documented
      // in resolveMediaBase names it. Passing undefined here made that line a
      // lie.
      astroSite: process.env.SITE_URL,
      requestUrl,
      forwardedProto,
    });
  } catch {
    // A settings read that fails must not take an API response with it. Fall
    // back to what the request itself tells us.
    return resolveMediaBase({ requestUrl, forwardedProto });
  }
}

/** Test seam. Never called by production code. */
export function _resetMediaBaseCache(): void {
  invalidateMediaBase();
}
