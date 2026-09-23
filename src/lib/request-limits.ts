/**
 * The pure half of the middleware's request limits: who the caller IS for the
 * purpose of a per-IP limit, which buckets a request is charged to, and which
 * write requests are refused before a handler reads a byte.
 *
 * Pure (no Astro, no storage) so every rule below is unit-tested directly —
 * the middleware imports `astro:middleware` and cannot be loaded by a test.
 * tests/request-limits.test.mjs covers this file.
 */
import net from 'node:net';
import type { RateLimitResult } from './rate-limit';

/* ================================================================== *
 * Client identity (S3.3)
 * ================================================================== */

type ParsedIp = { v4: string } | { v6: number[] };

/** Expand a (valid) IPv6 literal into its eight 16-bit groups. */
function expandV6(addr: string): number[] | null {
  let head = addr;
  const groups: number[] = [];
  // An embedded dotted quad (`::ffff:1.2.3.4`, `64:ff9b::1.2.3.4`) is the last
  // 32 bits written the IPv4 way; turn it into two hextets first.
  const lastColon = head.lastIndexOf(':');
  const tail = head.slice(lastColon + 1);
  if (tail.includes('.')) {
    const o = tail.split('.').map(Number);
    head = `${head.slice(0, lastColon + 1)}${((o[0]! << 8) | o[1]!).toString(16)}:${((o[2]! << 8) | o[3]!).toString(16)}`;
  }
  const dbl = head.indexOf('::');
  const left = dbl >= 0 ? head.slice(0, dbl) : head;
  const right = dbl >= 0 ? head.slice(dbl + 2) : '';
  const l = left ? left.split(':') : [];
  const r = right ? right.split(':') : [];
  const missing = 8 - l.length - r.length;
  if (dbl < 0 && missing !== 0) return null;
  if (dbl >= 0 && missing < 1) return null;
  for (const g of l) groups.push(parseInt(g, 16));
  for (let i = 0; i < (dbl >= 0 ? missing : 0); i += 1) groups.push(0);
  for (const g of r) groups.push(parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/**
 * Parse one address as a proxy or a socket might present it: bracketed
 * (`[2001:db8::1]:443`), with a port (`1.2.3.4:5678`), or with a zone id
 * (`fe80::1%eth0`). Anything else that is not an IP is refused.
 */
function parseIp(raw: string | null | undefined): ParsedIp | null {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  if (!s || s.length > 64) return null;
  const bracket = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(s);
  if (bracket) s = bracket[1]!;
  else if (/^\d{1,3}(\.\d{1,3}){3}:\d{1,5}$/.test(s)) s = s.slice(0, s.lastIndexOf(':'));
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  const family = net.isIP(s);
  if (family === 4) return { v4: s };
  if (family !== 6) return null;
  const groups = expandV6(s.toLowerCase());
  if (!groups) return null;
  // IPv4-MAPPED (`::ffff:a.b.c.d`) is an IPv4 client on a dual-stack socket.
  // Left as IPv6 it would be a DIFFERENT bucket from the same client arriving
  // over plain IPv4 — and, grouped by /64, every IPv4 client on the internet
  // would share `0:0:0:0::/64`.
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return { v4: `${groups[6]! >> 8}.${groups[6]! & 0xff}.${groups[7]! >> 8}.${groups[7]! & 0xff}` };
  }
  return { v6: groups };
}

/**
 * The identity a per-IP limit counts: an IPv4 address as-is, an IPv6 address
 * as its /64 prefix. `null` when `raw` is not an address.
 *
 * ## Why /64
 *
 * A single IPv6 subscriber is handed at least a /64 — 18 quintillion
 * addresses — and most operating systems rotate a temporary address inside it
 * on their own (RFC 4941). Counting per full address gave every such client a
 * fresh bucket for the asking: an unlimited supply of "different" callers from
 * one line. The /64 is the unit an ISP actually assigns to one customer, so it
 * is the unit that behaves like one IPv4 address.
 *
 * This is ALSO what `locals.ip` holds. Every per-IP bucket downstream — the
 * public-form gate, the upload and consent throttles, magic links, order risk
 * — reads `locals.ip`, and a grouping applied only in the middleware would
 * have left each of them keyed on the rotating address. Loopback stays `::1`:
 * it is one host, and `0:0:0:0::/64` in a dev log helps nobody.
 */
export function clientIdentity(raw: string | null | undefined): string | null {
  const p = parseIp(raw);
  if (!p) return null;
  if ('v4' in p) return p.v4;
  const g = p.v6;
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return '::1';
  return `${g.slice(0, 4).map((x) => x.toString(16)).join(':')}::/64`;
}

/**
 * The per-request client identity, from the socket or — only when the
 * operator said a proxy is in front — from that proxy's header.
 *
 * Moved here from the middleware unchanged in its trust rules: only the
 * RIGHT-most X-Forwarded-For entry is honoured (it is the hop our own proxy
 * appended; everything to its left is client-supplied), then X-Real-IP, and
 * nothing at all without TRUST_PROXY. What is new is that every candidate is
 * parsed and grouped, and a header that is not an address falls back to the
 * socket rather than becoming a bucket name.
 */
export function resolveClientIp(input: {
  forwardedFor?: string | null;
  realIp?: string | null;
  directAddr?: string | null;
  trustProxy: boolean;
}): string {
  if (input.trustProxy) {
    if (input.forwardedFor) {
      const parts = input.forwardedFor.split(',').map((s) => s.trim()).filter(Boolean);
      const hop = parts.length ? clientIdentity(parts[parts.length - 1]) : null;
      if (hop) return hop;
    }
    const real = clientIdentity(input.realIp);
    if (real) return real;
  }
  return clientIdentity(input.directAddr) ?? 'unknown';
}

/* ================================================================== *
 * Trusted client-IP forwarding (S3.6)
 * ================================================================== */

/**
 * The header a BFF uses to say which shopper a request is for.
 *
 * Honoured ONLY on a request authenticated by an API key whose record carries
 * `forward_client_ip: true` — a flag only an admin can set. Anonymous callers,
 * cookie sessions, and keys without the flag are all ignored, because for
 * them this header is just something the caller typed.
 */
export const CLIENT_IP_HEADER = 'x-astrobaas-client-ip';

/**
 * Validate the forwarded value: exactly ONE address, nothing else. A list is
 * refused rather than picked from — there is no "right" entry to trust in a
 * header whose whole contract is that the sender already chose one.
 */
export function forwardedClientIp(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (!v || v.includes(',') || /\s/.test(v)) return null;
  return clientIdentity(v);
}

/**
 * The whole trust decision, in one place: the shopper's address when — and
 * only when — the request was authenticated by a key that an admin marked as a
 * forwarding BFF, and the header holds one valid address. `null` otherwise,
 * and the caller keeps the socket's address.
 *
 * `=== true`, not truthiness: a key record is operator data, and the string
 * "false" is truthy.
 */
export function trustedForwardedIp(
  key: { forward_client_ip?: unknown } | null | undefined,
  headerValue: string | null | undefined,
): string | null {
  if (!key || key.forward_client_ip !== true) return null;
  return forwardedClientIp(headerValue);
}

/* ================================================================== *
 * Route buckets (S3.4)
 * ================================================================== */

export type RouteBucket = 'checkout' | 'quote' | 'payment-start' | 'search' | 'webhook';

export type RouteLimits = Record<RouteBucket, number>;

/**
 * Per-IP, per-minute ceilings for the routes that cost the most per call.
 *
 * Each sits BELOW the general anonymous 60/min, because each route is a
 * multiple of an ordinary request's cost: an order reserves stock and writes
 * two records, a quote prices a whole basket, a payment start calls out to a
 * provider, and a search scores the catalogue. They are also in ADDITION to
 * the general bucket, never instead of it.
 *
 * The numbers are sized for a shopper, not a shop. Ten orders a minute from one
 * address is not a customer. A quote is re-requested on every basket change,
 * so it gets three times as many. A shared address (an office, a mobile
 * carrier's NAT) is the case these are most likely to pinch, which is why each
 * one is an environment variable.
 *
 * Webhooks are the exception in the other direction: a payment provider sends
 * bursts from a handful of addresses, and a 429 there is a payment the shop
 * learns about late. They are taken OUT of the anonymous bucket and given a
 * generous one of their own. The handler's signature check is what protects
 * them; this bucket only bounds how fast a forger can make it run.
 */
export const DEFAULT_ROUTE_LIMITS: Readonly<RouteLimits> = Object.freeze({
  checkout: 10,
  quote: 30,
  'payment-start': 10,
  search: 30,
  webhook: 600,
});

const ROUTE_LIMIT_ENV: Record<RouteBucket, string> = {
  checkout: 'RATE_LIMIT_CHECKOUT_PER_MIN',
  quote: 'RATE_LIMIT_QUOTE_PER_MIN',
  'payment-start': 'RATE_LIMIT_PAYMENT_START_PER_MIN',
  search: 'RATE_LIMIT_SEARCH_PER_MIN',
  webhook: 'RATE_LIMIT_WEBHOOK_PER_MIN',
};

/** The configured ceilings. A missing, zero or unparseable value keeps the default. */
export function resolveRouteLimits(env: Record<string, string | undefined> = process.env): RouteLimits {
  const out = { ...DEFAULT_ROUTE_LIMITS } as RouteLimits;
  for (const name of Object.keys(ROUTE_LIMIT_ENV) as RouteBucket[]) {
    const n = Number(env[ROUTE_LIMIT_ENV[name]]);
    if (Number.isFinite(n) && n > 0) out[name] = Math.floor(n);
  }
  return out;
}

/** Payment-provider webhooks. The same shape the middleware's public-write list uses. */
export const WEBHOOK_PATH = /^\/api\/payments\/webhook\/[a-z0-9-]+\/?$/;

/**
 * Which route bucket, if any, a request is charged to.
 *
 * Exact paths only — `/api/orders/quote` is a quote and `/api/orders/123` is
 * not a checkout. A catalogue listing is a SEARCH only when it actually
 * searches: `GET /api/products` is the storefront's everyday category page and
 * stays in the general bucket.
 */
export function routeBucketFor(
  method: string,
  pathname: string,
  searchParams?: URLSearchParams | null,
): RouteBucket | null {
  const m = method.toUpperCase();
  if (m === 'POST') {
    if (/^\/api\/orders\/?$/.test(pathname)) return 'checkout';
    if (/^\/api\/orders\/quote\/?$/.test(pathname)) return 'quote';
    if (/^\/api\/payments\/start\/?$/.test(pathname)) return 'payment-start';
    if (WEBHOOK_PATH.test(pathname)) return 'webhook';
    return null;
  }
  if (m === 'GET') {
    if (/^\/api\/search\/?$/.test(pathname)) return 'search';
    if (/^\/api\/products\/?$/.test(pathname) && (searchParams?.get('search') ?? '').trim() !== '') {
      return 'search';
    }
  }
  return null;
}

export interface RateBucketPlan {
  key: string;
  limit: number;
  windowMs: number;
}

export interface RatePlanInput {
  method: string;
  pathname: string;
  searchParams?: URLSearchParams | null;
  /** `locals.ip` — already grouped, and already the forwarded shopper when one was trusted. */
  ip: string;
  /** Set when an API key authenticated the request. */
  apiKeyId?: string | null;
  /** Set when a cookie session authenticated the request. */
  userId?: string | null;
  /** True when `ip` came from a trusted `X-AstroBaaS-Client-IP`. */
  forwarded?: boolean;
  limits: {
    windowMs: number;
    anonymous: number;
    apiKey: number;
    staff: number;
    routes: RouteLimits;
  };
}

/**
 * The buckets one /api request is charged to, in the order they are checked.
 *
 * 1. The PRINCIPAL's bucket — the key, else the person, else the address.
 *    Unchanged from before, except that an anonymous webhook skips it.
 * 2. The ROUTE's bucket, per address — but only when the address means a
 *    shopper: an anonymous caller, or a key that forwarded one.
 *
 * Why a key without forwarding is NOT charged per route: its address is the
 * storefront server's, shared by every shopper on the site. Ten checkouts a
 * minute for the whole shop would be an outage, not a limit. Such a key keeps
 * its own (large, revocable) bucket, which is what it had before.
 */
export function planRateBuckets(input: RatePlanInput): RateBucketPlan[] {
  const { limits } = input;
  const w = limits.windowMs;
  const route = routeBucketFor(input.method, input.pathname, input.searchParams);
  const plan: RateBucketPlan[] = [];
  if (input.apiKeyId) plan.push({ key: `apikey:${input.apiKeyId}`, limit: limits.apiKey, windowMs: w });
  else if (input.userId) plan.push({ key: `user:${input.userId}`, limit: limits.staff, windowMs: w });
  else if (route !== 'webhook') plan.push({ key: `api:${input.ip}`, limit: limits.anonymous, windowMs: w });

  const shopper = !!input.forwarded || (!input.apiKeyId && !input.userId);
  if (route && shopper) {
    plan.push({ key: `route:${route}:${input.ip}`, limit: limits.routes[route], windowMs: w });
  }
  return plan;
}

/**
 * The one budget to publish when a request was charged to several.
 *
 * RateLimit-* describes the policy closest to refusing this client. A refusal
 * wins outright (the longest wait among them, so a client does not come back
 * into a second refusal); otherwise the bucket with the least left, and on a
 * tie the tighter ceiling. Publishing the general 60/min on a checkout that has
 * three of its ten left would tell a well-behaved client it may keep going.
 */
export function mostRestrictive(results: RateLimitResult[]): RateLimitResult {
  const refused = results.filter((r) => !r.allowed);
  if (refused.length) {
    return refused.reduce((a, b) => (b.retryAfterSeconds > a.retryAfterSeconds ? b : a));
  }
  return results.reduce((a, b) => {
    if (b.remaining !== a.remaining) return b.remaining < a.remaining ? b : a;
    return b.limit < a.limit ? b : a;
  });
}

/* ================================================================== *
 * Unframed write bodies (S3.7)
 * ================================================================== */

/**
 * Is this a write whose body length the server was not told?
 *
 * The body-size ceiling is enforced from Content-Length BEFORE any handler
 * buffers the body. A chunked request has no Content-Length, so it walked
 * past that check and `request.json()` buffered however much was sent.
 *
 * Refused (411) rather than capped while streaming, because an Astro
 * middleware cannot hand the route a length-limited body — the handler reads
 * `context.request` directly. What that refusal costs, checked:
 *
 *  - Browsers always send Content-Length for fetch/XHR/form bodies. The only
 *    browser request without one is a STREAMING upload (a ReadableStream body
 *    with `duplex: 'half'`), which is exactly the case being refused.
 *  - nginx, with the default `proxy_request_buffering on` (the shipped config
 *    never turns it off), reads a chunked client body in full and re-sends it
 *    upstream with Content-Length and no Transfer-Encoding.
 *  - Caddy streams request bodies by default, so a chunked client request is
 *    forwarded chunked and refused here — see SECURITY.md for the one-line
 *    `request_buffers` setting that makes Caddy behave like nginx.
 *
 * With both headers present Node's parser already rejects the request, so only
 * "Transfer-Encoding and no Content-Length" reaches this check.
 */
export function isUnframedWrite(method: string, headers: Headers): boolean {
  const m = method.toUpperCase();
  if (m !== 'POST' && m !== 'PUT' && m !== 'PATCH' && m !== 'DELETE') return false;
  return headers.has('transfer-encoding') && !headers.has('content-length');
}
