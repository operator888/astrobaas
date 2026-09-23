/**
 * Where uploaded files can actually be fetched from.
 *
 * ## The incident
 *
 * A media record stores `url: "/uploads/2026/08/11c0996e.webp"` and the API
 * returned it verbatim. That is a path relative to the CMS — and in a headless
 * install the storefront is a DIFFERENT host. A storefront rendering it with
 * `next/image` resolves it against its own origin, finds nothing, and answers
 * 400 "The requested resource isn't a valid image". Broken images on the shop.
 *
 * What made it expensive was the delay. An IMPORTED catalogue stores absolute
 * URLs (`https://old-shop.gr/...`), which resolve fine, so a migrated shop looks
 * healthy for weeks — until the first time the owner uploads a photo themselves,
 * and then only THAT product breaks. It was found on a live shop from a
 * customer complaint.
 *
 * ## Two different addresses
 *
 * `site_url` is where the SITE lives: it goes in canonical tags, the sitemap and
 * the feed, so on a headless install a shop may legitimately point it at the
 * storefront. `public_site_url` is where this CMS itself answers — where
 * `/uploads` and `/api` are. Coupled installs never need the second one; that is
 * why it may be unset, and why the deep health check says so out loud instead of
 * letting the fallback below be mistaken for configuration.
 */

import { normaliseOrigin } from './site-url';

/** A host nobody outside this machine can reach. */
function isLocal(origin: string): boolean {
  try {
    const h = new URL(origin).hostname.toLowerCase();
    return (
      h === 'localhost'
      || h === '::1'
      || h === '[::1]'
      || h.endsWith('.localhost')
      || /^127\./.test(h)
      || /^10\./.test(h)
      || /^192\.168\./.test(h)
      || /^172\.(1[6-9]|2\d|3[01])\./.test(h)
      || h.endsWith('.internal')
    );
  } catch {
    return false;
  }
}

/**
 * Re-apply the scheme the EDGE served, when we are allowed to believe it.
 *
 * Only ever upgrades http to https, never the reverse: a forged
 * `X-Forwarded-Proto: http` on a genuinely-https deployment could otherwise
 * downgrade every image URL the API publishes.
 *
 * ## The LEFT-most entry, unlike X-Forwarded-For
 *
 * The middleware deliberately reads the RIGHT-most `X-Forwarded-For` entry,
 * because the left of that list is whatever the client claimed. The rule is
 * inverted here and that is not an oversight: for `X-Forwarded-Proto` the
 * left-most entry is the OUTERMOST proxy — the edge that actually terminated
 * TLS and the only hop whose scheme the visitor saw. The right-most is the last
 * internal hop, which is plain HTTP by design.
 *
 * The reference vhost sets this header rather than appending to it, so in that
 * deployment there is exactly one value either way; and because this can only
 * ever upgrade, the worst a forged value achieves is https:// URLs in the
 * forger's own response.
 */
function applyProto(origin: string, forwardedProto: unknown): string {
  if (typeof forwardedProto !== 'string') return origin;
  // A proxy chain sends a comma-separated list; the first entry is the client's.
  const proto = forwardedProto.split(',')[0].trim().toLowerCase();
  if (proto !== 'https') return origin;
  return origin.replace(/^http:/, 'https:');
}

export interface MediaBaseSources {
  /**
   * The `X-Forwarded-Proto` header, when the deployment is configured to trust
   * its proxy (TRUST_PROXY).
   *
   * ## Why this is not optional polish
   *
   * Astro's Node adapter only honours `X-Forwarded-Proto` when
   * `security.allowedDomains` is configured, and this app does not configure it.
   * So behind nginx terminating TLS and proxying over plain HTTP — the normal
   * production shape, and exactly what deploy/nginx/astrobaas.conf describes —
   * `request.url` comes out as `http://cms.example.com/...`.
   *
   * Publishing that as the media base would put `http://` image URLs on an
   * `https://` storefront page. Browsers block mixed content outright, so the
   * images would not merely be wrong, they would not load at all — a new way to
   * break the exact thing this file exists to fix.
   */
  forwardedProto?: unknown;
  /** The `public_site_url` setting — this CMS's own public address. */
  publicSiteUrl?: unknown;
  /** The `site_url` setting. May point at a storefront on a headless install. */
  siteUrl?: unknown;
  /** Astro's build-time `site` (from SITE_URL). */
  astroSite?: unknown;
  /** The current request's URL. */
  requestUrl?: unknown;
}

/**
 * Resolve the origin that `/uploads/...` should be joined to, or null.
 *
 * Precedence, and the reasoning for the unusual middle step:
 *
 *   1. `public_site_url` — declared, unambiguous, and the only answer that is
 *      right by construction. Everything below is a guess.
 *   2. The REQUEST's own origin, when it is externally reachable. This ranks
 *      above the declared `site_url` because it is OBSERVED rather than
 *      declared: the caller reached this CMS at that origin, so `<origin>/uploads`
 *      is reachable by that caller by construction. A headless shop that points
 *      `site_url` at its storefront would otherwise get media URLs on a host
 *      that has never served an upload — the original bug, restored.
 *   3. `site_url`, then the build-time `SITE_URL`. Declared values, used when
 *      there is no request context (a worker, a CLI) or when the request origin
 *      is a private address.
 *   4. A loopback/private request origin, last. Better than nothing for local
 *      development, and useless in production — which is what the health check
 *      is for.
 */
export function resolveMediaBase(
  { publicSiteUrl, siteUrl, astroSite, requestUrl, forwardedProto }: MediaBaseSources,
): string | null {
  const declaredPublic = normaliseOrigin(publicSiteUrl);
  if (declaredPublic) return declaredPublic;

  const fromRequest = requestUrl ? normaliseOrigin(applyProto(new URL(String(requestUrl)).origin, forwardedProto)) : null;
  if (fromRequest && !isLocal(fromRequest)) return fromRequest;

  return (
    normaliseOrigin(siteUrl)
    ?? normaliseOrigin(typeof astroSite === 'object' && astroSite !== null ? String(astroSite) : astroSite)
    ?? fromRequest
  );
}

/**
 * Join a stored media path to the base.
 *
 * Leaves an ALREADY-ABSOLUTE url alone, which is not a nicety: an imported
 * WooCommerce catalogue stores `https://old-shop.gr/wp-content/...`, those rows
 * work today, and prefixing them would break the images that currently render —
 * turning a fix for new uploads into a regression for the whole imported
 * catalogue. Protocol-relative `//host/path` counts as absolute for the same
 * reason.
 */
export function absoluteMediaUrl(url: unknown, base: string | null): string | null {
  if (typeof url !== 'string') return null;
  const raw = url.trim();
  if (!raw) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) return raw;
  if (!base) return null;
  return `${base}${raw.startsWith('/') ? raw : `/${raw}`}`;
}

/** One derivative of an uploaded image. */
export interface MediaVariantView {
  width: number;
  height: number;
  url: string;
  url_absolute?: string | null;
  size: number;
  format: string;
}

/**
 * A media record as the API returns it.
 *
 * The relative fields are UNCHANGED and always present. Absolute ones are added
 * alongside — see the note on backwards compatibility in api/media/get.ts.
 */
export interface MediaView {
  [key: string]: unknown;
  url: string;
  url_absolute?: string | null;
  thumb_url?: string;
  thumb_absolute?: string | null;
  original_url?: string;
  original_absolute?: string | null;
  variants?: MediaVariantView[];
}

/**
 * Add the absolute forms to one media record.
 *
 * Never mutates the stored record: absolute URLs are a VIEW, computed per
 * request from whichever origin that request arrived on. Persisting them would
 * bake a hostname into the database and break the day the shop moves domain —
 * which is exactly the class of bug this file exists to fix.
 */
export function withAbsoluteMedia<T extends { url: string }>(
  record: T,
  base: string | null,
): T & MediaView {
  const r = record as T & MediaView;
  const out: T & MediaView = {
    ...r,
    url_absolute: absoluteMediaUrl(r.url, base),
  };
  if (r.thumb_url) out.thumb_absolute = absoluteMediaUrl(r.thumb_url, base);
  if (r.original_url) out.original_absolute = absoluteMediaUrl(r.original_url, base);
  if (Array.isArray(r.variants)) {
    out.variants = r.variants.map((v) => ({ ...v, url_absolute: absoluteMediaUrl(v.url, base) }));
  }
  return out;
}
