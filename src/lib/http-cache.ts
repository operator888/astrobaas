/**
 * Shared-cache headers for the public read API, in one place.
 *
 * ## What was there
 *
 * Nothing. `GET /api/products`, `/api/products/{id}`, `/api/brands`,
 * `/api/product-categories`, `/api/search`, `/sitemap.xml` and `/rss.xml` sent
 * no `Cache-Control` and no validator. A CDN in front of the CMS had nothing to
 * go on, so every storefront page view reached Node, and every one of those
 * reads the whole catalogue. Both live shops render server-side on a
 * headless Next.js front end: a crawler walking the storefront was a crawler
 * walking this database, one full table scan per URL.
 *
 * ## The rule
 *
 * **Anonymous** — no session user and no API key, which is exactly
 * `locals.user === null` after the middleware — gets:
 *
 *     Cache-Control: public, max-age=0, s-maxage=30, stale-while-revalidate=300
 *     Vary: Cookie, Authorization
 *     ETag: W/"<digest of the body>"
 *
 * - `s-maxage` is for SHARED caches only. `max-age=0` keeps a browser
 *   revalidating on every use, which is cheap because of the ETag (a 304 has no
 *   body) and means a shopper never looks at a price older than the CDN's copy.
 * - `stale-while-revalidate` lets a CDN answer instantly with the previous copy
 *   while it refetches, so a burst after expiry costs Node one request, not one
 *   per visitor.
 * - 30 seconds is the default because a price edit, a stock change or an
 *   unpublish has to show up soon enough that an operator does not think the
 *   save failed. `PUBLIC_API_CACHE_SECONDS` tunes it; **0 turns shared caching
 *   off** (`private, no-cache` — browsers still revalidate with the ETag).
 *
 * **Anyone signed in or keyed** gets `Cache-Control: private, no-store` and no
 * ETag. Those responses can carry staff-only fields, drafts and unpublished
 * stock; one of them landing in a shared cache would serve an admin's view of
 * the catalogue to the next anonymous visitor. `no-store`, not merely
 * `private`, because an API key is often used from a server whose own HTTP
 * cache is shared.
 *
 * ## What the response varies on — checked, not assumed
 *
 * - **Cookie / Authorization** decide who the caller is, and therefore which
 *   of the two shapes above comes back.
 * - **`?locale=`** is in the URL, so it is already part of every cache key.
 *   `/de/rss.xml` likewise carries its locale in the path.
 * - **Accept-Language** is NOT listed: nothing on these routes reads it — the
 *   middleware uses it only for the admin's interface language, which no
 *   public response contains. Listing it anyway would split every cached
 *   object by browser language for no difference in bytes.
 * - **Host / scheme** feed `meta.media_base` when neither `public_site_url` nor
 *   `site_url` is set. Every CDN keys on both already; set one of the two
 *   settings anyway before enabling a shared cache (INTEGRATION.md §Caching).
 *
 * ## Two things this module cannot do on its own
 *
 * 1. **The CSRF cookie is no longer in the way.** It is set on HTML pages
 *    outside /api only (`shouldSetCsrfCookie`), so these responses carry no
 *    `Set-Cookie` and a shared cache will store them.
 * 2. **`Vary: Origin`.** The middleware's CORS step SETS `Vary: Origin`, which
 *    replaces the value written here on allow-listed cross-origin requests. A
 *    browser does not send cookies on those (no credentials are allowed), so
 *    the practical risk is small — but a CDN should still be told to bypass its
 *    cache for requests carrying the session cookie or an `Authorization`
 *    header, because many CDNs ignore `Vary` altogether. INTEGRATION.md says so.
 */
import crypto from 'node:crypto';

/** Request headers a public read response varies on. See the module comment. */
export const PUBLIC_CACHE_VARY = ['Cookie', 'Authorization'] as const;

export const DEFAULT_SHARED_MAX_AGE = 30;
export const DEFAULT_STALE_WHILE_REVALIDATE = 300;

/** A day. Past this an operator has built a static site and should say so. */
const MAX_SHARED_MAX_AGE = 86_400;
/** A week. */
const MAX_STALE_WHILE_REVALIDATE = 604_800;

export interface PublicCachePolicy {
  /** Seconds a shared cache may serve without asking. 0 = no shared caching. */
  sMaxAge: number;
  /** Seconds a shared cache may serve stale while it refetches. */
  staleWhileRevalidate: number;
}

/**
 * Whole seconds from an env var, or the default.
 *
 * Not-set and unparseable both mean "the default" — a typo in a unit file must
 * not silently turn a 30-second cache into a day, or caching off into on. An
 * explicit `0` is a decision and is kept.
 */
function seconds(raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(Math.trunc(n), max);
}

/** The policy for this process's environment. Pure. */
export function publicCachePolicy(env: NodeJS.ProcessEnv = process.env): PublicCachePolicy {
  return {
    sMaxAge: seconds(env.PUBLIC_API_CACHE_SECONDS, DEFAULT_SHARED_MAX_AGE, MAX_SHARED_MAX_AGE),
    staleWhileRevalidate: seconds(
      env.PUBLIC_API_CACHE_SWR_SECONDS, DEFAULT_STALE_WHILE_REVALIDATE, MAX_STALE_WHILE_REVALIDATE,
    ),
  };
}

/** The `Cache-Control` value for an anonymous response under `policy`. */
export function anonymousCacheControl(policy: PublicCachePolicy): string {
  if (policy.sMaxAge <= 0) return 'private, no-cache';
  const parts = ['public', 'max-age=0', `s-maxage=${policy.sMaxAge}`];
  if (policy.staleWhileRevalidate > 0) {
    parts.push(`stale-while-revalidate=${policy.staleWhileRevalidate}`);
  }
  return parts.join(', ');
}

/** What a signed-in or keyed caller gets. */
export const PRIVATE_CACHE_CONTROL = 'private, no-store';

/**
 * A WEAK validator derived from the bytes.
 *
 * Weak because that is the honest claim: two responses with this tag are the
 * same representation, and nothing here promises byte ranges over it. Derived
 * from the BODY rather than from `updated_at`s because a list response is built
 * from several tables, settings and the clock (a scheduled sale), and any
 * version number assembled from those would be one more thing to keep in step.
 * Hashing a few hundred kilobytes is far cheaper than the reads that produced
 * them, and it cannot be stale.
 */
export function weakEtag(body: Uint8Array | string): string {
  const digest = crypto.createHash('sha256').update(body).digest('base64url').slice(0, 27);
  return `W/"${digest}"`;
}

/**
 * Does an `If-None-Match` header match `etag`?
 *
 * The comparison is WEAK (RFC 9110 §13.1.2): a `W/` on either side is ignored.
 * A client may send a list, and `*` matches any current representation.
 */
export function etagMatches(ifNoneMatch: string | null | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const bare = (v: string) => v.trim().replace(/^W\//, '');
  if (ifNoneMatch.trim() === '*') return true;
  const want = bare(etag);
  return ifNoneMatch.split(',').some((candidate) => bare(candidate) === want);
}

/** Merge `extra` into an existing `Vary` value, case-insensitively, keeping order. */
export function mergeVary(existing: string | null | undefined, extra: readonly string[]): string {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of [...String(existing ?? '').split(','), ...extra]) {
    const t = v.trim();
    if (!t) continue;
    const k = t.toLowerCase();
    if (k === '*') return '*';
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out.join(', ');
}

export interface CacheContext {
  request: Request;
  /** `Astro.locals` / the endpoint's `locals`. Only `user` is read. */
  locals?: { user?: unknown } | null;
}

/**
 * Decorate a public read response with the headers above.
 *
 * Only a `200` to a `GET`/`HEAD` is touched. An error must never be cached
 * under a shared key — a 500 served for thirty seconds to everybody is an
 * outage the operator did not have — and a write has no business here.
 *
 * Returns a NEW response for the anonymous case, because the body has to be
 * read to be hashed. For a conditional request that matches, the answer is a
 * bodiless 304 carrying the validator, the caching policy and `Vary`, which is
 * what RFC 9110 §15.4.5 asks a 304 to repeat.
 */
export async function withPublicCache(
  response: Response,
  ctx: CacheContext,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Response> {
  const method = ctx.request.method.toUpperCase();
  if ((method !== 'GET' && method !== 'HEAD') || response.status !== 200) return response;

  const vary = mergeVary(response.headers.get('vary'), PUBLIC_CACHE_VARY);

  if (ctx.locals?.user) {
    // Signed in or keyed: never stored anywhere shared, never revalidated
    // against a tag an anonymous copy could also carry.
    response.headers.set('Cache-Control', PRIVATE_CACHE_CONTROL);
    response.headers.set('Vary', vary);
    return response;
  }

  const body = new Uint8Array(await response.arrayBuffer());
  const etag = weakEtag(body);
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', anonymousCacheControl(publicCachePolicy(env)));
  headers.set('Vary', vary);
  headers.set('ETag', etag);

  if (etagMatches(ctx.request.headers.get('if-none-match'), etag)) {
    const notModified = new Headers();
    for (const name of ['Cache-Control', 'ETag', 'Vary']) {
      const v = headers.get(name);
      if (v) notModified.set(name, v);
    }
    return new Response(null, { status: 304, headers: notModified });
  }

  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}
