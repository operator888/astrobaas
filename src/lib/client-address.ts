/**
 * Who a request is FOR — the shopper's address and browser — in one place.
 *
 * ## Why this exists
 *
 * A headless storefront calls this API from its own server, so every request
 * arrives from one address with the server's own User-Agent. A plugin that
 * records consent, rate-limits a game per visitor or scores an order needs the
 * SHOPPER, and the storefront knows who that is. It says so in two headers:
 *
 *   X-Client-IP: 203.0.113.7
 *   X-Client-UA: Mozilla/5.0 (…)
 *
 * ## The trust rule (owner decision, 2026-10-26)
 *
 * Those headers are honoured ONLY on a request authenticated by an API key.
 * Anonymous callers and cookie sessions have them ignored, because for them the
 * header is just something the caller typed — anyone can send it.
 *
 * Even on a keyed request a value is used only when it is usable: the IP must
 * parse as exactly one IPv4 or IPv6 address (`forwardedClientIp`, the same
 * validator S3.6's header uses), and anything else falls back to the real
 * address rather than becoming a value someone downstream trusts.
 *
 * ## "The real address" has ONE definition
 *
 * The fallback is `locals.ip` — the identity the middleware's rate limiter
 * charges, resolved by `resolveClientIp` (TRUST_PROXY, right-most
 * X-Forwarded-For, IPv6 grouped to its /64) and, for a key an admin marked
 * `forward_client_ip`, the S3.6 `X-AstroBaaS-Client-IP`. This module never
 * looks at the socket or at a proxy header itself, so it cannot disagree with
 * the limiter about who the caller is. A forwarded `X-Client-IP` is put
 * through the SAME normalisation (`clientIdentity`), so a plugin gets one shape
 * of address whichever path it came from.
 *
 * `X-Client-IP` deliberately does NOT feed `locals.ip`. That would change the
 * core limiter's per-address buckets for every key, which is the S3.6 decision
 * (an admin flag per key) and not this one.
 *
 * Pure: no storage, no network, no Astro imports.
 */
import { forwardedClientIp } from './request-limits';

/** What a plugin route (`ctx.client`) and a core route (`requestClient(locals)`) are handed. */
export interface RequestClient {
  /**
   * The client identity: an IPv4 address, or an IPv6 address grouped to its
   * /64 (`2001:db8:1:2::/64`) — the shape `locals.ip` and every per-IP bucket
   * use. `null` when no address is known at all.
   */
  ip: string | null;
  /** The User-Agent, control characters removed, at most CLIENT_UA_MAX characters. `null` when absent. */
  ua: string | null;
  /** True when `ip` or `ua` came from a forwarding header rather than the request itself. */
  forwarded: boolean;
}

/** The storefront's shopper-address header. Lower-case: `Headers.get` is case-insensitive anyway. */
export const X_CLIENT_IP_HEADER = 'x-client-ip';
/** The storefront's shopper User-Agent header. */
export const X_CLIENT_UA_HEADER = 'x-client-ua';
/** A User-Agent longer than this is truncated, from whichever source. */
export const CLIENT_UA_MAX = 512;

/**
 * A User-Agent fit to store: control characters (CR/LF included, so it cannot
 * split a log line) replaced by spaces, trimmed, capped. `null` for empty.
 */
export function capUserAgent(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const clean = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  if (!clean) return null;
  return clean.length > CLIENT_UA_MAX ? clean.slice(0, CLIENT_UA_MAX) : clean;
}

/** Anything with a case-insensitive `get` — a `Headers`, or a test double. */
interface HeaderSource {
  get(name: string): string | null;
}

/**
 * The whole decision, given what the middleware already knows.
 *
 * - `viaApiKey`: the request was authenticated by an API key (bearer). The
 *   ONLY condition under which X-Client-IP / X-Client-UA are read.
 * - `address`: `locals.ip`, the rate limiter's identity. `'unknown'` and empty
 *   mean no address.
 * - `addressForwarded`: `address` itself came from S3.6's trusted header.
 */
export function resolveRequestClient(input: {
  headers: HeaderSource;
  viaApiKey: boolean;
  address: string | null | undefined;
  addressForwarded?: boolean;
}): RequestClient {
  const real = typeof input.address === 'string' && input.address && input.address !== 'unknown'
    ? input.address
    : null;
  const ownUa = capUserAgent(input.headers.get('user-agent'));

  if (input.viaApiKey !== true) {
    return { ip: real, ua: ownUa, forwarded: input.addressForwarded === true };
  }

  const claimedIp = forwardedClientIp(input.headers.get(X_CLIENT_IP_HEADER));
  const claimedUa = capUserAgent(input.headers.get(X_CLIENT_UA_HEADER));
  return {
    ip: claimedIp ?? real,
    ua: claimedUa ?? ownUa,
    forwarded: claimedIp !== null || claimedUa !== null || input.addressForwarded === true,
  };
}

/**
 * The client of the current request, for a CORE route: `requestClient(Astro.locals)`.
 *
 * The middleware resolves it once per request into `locals.client`. A caller
 * running outside the middleware (a test, a script) gets the address-only
 * answer from `locals.ip` — never a forwarded value, because nothing has
 * established that the request carried a key.
 */
export function requestClient(locals: unknown): RequestClient {
  const bag = (locals && typeof locals === 'object' ? locals : {}) as {
    client?: RequestClient;
    ip?: unknown;
  };
  const c = bag.client;
  if (c && typeof c === 'object' && 'ip' in c && 'ua' in c) {
    return { ip: c.ip ?? null, ua: c.ua ?? null, forwarded: c.forwarded === true };
  }
  const ip = typeof bag.ip === 'string' && bag.ip && bag.ip !== 'unknown' ? bag.ip : null;
  return { ip, ua: null, forwarded: false };
}
