/**
 * Security response headers.
 *
 * The Content-Security-Policy is NO LONGER emitted here — it is produced by
 * Astro's built-in hash-based CSP (`security.csp` in astro.config, configured
 * via src/lib/csp-config.ts), whose script-src lists the hashes of every
 * bundled script. That let us drop `'unsafe-inline'` from script-src, which a
 * hand-written static header could not do (Astro inlines its own
 * island-hydration scripts).
 *
 * CORRECTION: this comment used to say Astro emits a per-page `<meta>` tag and
 * that `frame-ancestors` is therefore ignored. That is wrong for this project.
 * Astro uses `<meta>` only for PRERENDERED pages; for on-demand pages it sends
 * a real response header, and `astro.config.ts` sets `output: 'server'`, so
 * every page here gets the header. Verified against a production build:
 *
 *   $ curl -D - http://127.0.0.1:PORT/ | grep -i content-security-policy
 *   content-security-policy: default-src 'self'; …
 *   $ curl -s http://127.0.0.1:PORT/ | grep -c 'http-equiv="content-security-policy"'
 *   0
 *
 * The mistake mattered: `frame-ancestors` was left out because of it, and the
 * belief spread from this comment into review notes and docs. `frame-ancestors`
 * is now set in csp-config.ts. X-Frame-Options stays as belt-and-braces for
 * anything that does not read CSP.
 */

function tokens(envVal: string | undefined): string[] {
  if (!envVal) return [];
  return envVal.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
}

/* ---------- CORS ---------- */

/**
 * CORS for the JSON API so headless frontends on another origin can call it.
 * Origins are allow-listed via CORS_ORIGINS (space/comma-separated, or "*").
 * Credentials are intentionally NOT allowed — auth is a bearer token in a
 * header, never an ambient cookie — which keeps the API CSRF-safe even with
 * a wildcard origin.
 */
export function corsOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  return tokens(env.CORS_ORIGINS);
}

/** Resolve the Access-Control-Allow-Origin value for a request Origin, or null. */
export function corsAllowOrigin(
  requestOrigin: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const allow = corsOrigins(env);
  if (!allow.length || !requestOrigin) return null;
  if (allow.includes('*')) return '*';
  return allow.includes(requestOrigin) ? requestOrigin : null;
}

/**
 * What CORS_ORIGINS means for the cookie-less public writes, as one sentence an
 * operator can act on (S3.14). Side-effect free; logged once at startup and
 * reported by the deep health check.
 *
 * ## Why a wildcard is worth a warning and not a refusal
 *
 * `*` is safe for what CORS is FOR: credentials are never allowed, so no page
 * can read a signed-in admin's data through it. But the middleware also uses
 * the allow-list for a second decision — which sites' pages may make a
 * shopper's browser place an order, start a payment, or post a contact form
 * without the CSRF cookie. With `*` that is every site on the internet. Those
 * requests carry no session, so nothing is stolen; what is lost is the ability
 * to say "only our storefront embeds our checkout".
 *
 * And the header this gate reads is set by the BROWSER. It is not a security
 * boundary against anything that is not a browser: curl, a script or a bot
 * sends whatever Origin it likes, or none. The real limits on those endpoints
 * are the rate limits, the input bounds and the server-side pricing.
 *
 * Changing the behaviour would break both live storefronts if either relies on
 * the wildcard, so this only warns.
 */
export function describeCorsPosture(env: NodeJS.ProcessEnv = process.env): {
  origins: string[];
  wildcard: boolean;
  warning?: string;
} {
  const origins = corsOrigins(env);
  const wildcard = origins.includes('*');
  return {
    origins: wildcard ? ['*'] : origins,
    wildcard,
    ...(wildcard
      ? {
          warning:
            'CORS_ORIGINS=* — ANY website can make a visitor\'s browser place orders, start payments and send '
            + 'contact/newsletter posts, or submit your public forms and upload files to them, without a CSRF '
            + 'token. No session is exposed, but the origin allow-list '
            + 'no longer limits which sites embed your checkout. List your storefront origins instead '
            + '(e.g. CORS_ORIGINS=https://shop.example.com).',
        }
      : {}),
  };
}

/** CORS headers for an allowed cross-origin API request (empty if not allowed). */
export function corsHeaders(
  requestOrigin: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const origin = corsAllowOrigin(requestOrigin, env);
  if (!origin) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    // Idempotency-Key is here because the typed client sends it on every
    // orders.place() (client/index.ts): without it a storefront on another
    // origin fails the preflight and cannot place an order at all.
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-CSRF-Token, Idempotency-Key',
    // Without this a cross-origin caller cannot READ these from JavaScript —
    // the browser hides every response header except a short safelist. Both
    // production storefronts are separate Next.js origins, so publishing a
    // rate-limit budget they cannot see would be publishing it to nobody.
    'Access-Control-Expose-Headers':
      'RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset, Retry-After, Idempotent-Replayed',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

/**
 * Add tokens to a `Vary` header without dropping the ones already there.
 *
 * A route that is cacheable by a shared cache says what its body varies on —
 * `Vary: Cookie, Authorization` (see src/lib/http-cache.ts). The CORS echo used
 * to `set` its own `Vary: Origin` over it, so an allow-listed cross-origin
 * response told a CDN it varied on Origin ONLY, and the cache could hand one
 * caller's copy to a caller with a different session. Tokens are compared
 * case-insensitively and kept in first-seen order; `*` wins outright.
 */
export function mergeVary(existing: string | null | undefined, add: string): string {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const token of `${existing ?? ''},${add}`.split(',')) {
    const t = token.trim();
    if (!t) continue;
    if (t === '*') return '*';
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out.join(', ');
}

/**
 * Static security headers for every response. CSP is emitted separately by
 * Astro (see the module comment). `env` is accepted for signature stability and
 * future per-env tuning.
 */
/**
 * `X-Frame-Options` for one path, because one path needs to be framed.
 *
 * DENY everywhere is right: this app has an admin, and clickjacking it is the
 * attack the header exists for. But the inline PDF viewer frames an uploaded
 * PDF from this same origin, and DENY refuses that too — DENY means nobody,
 * including us.
 *
 * So the exception is as narrow as it can be written: a GET of a path under
 * `/uploads/` that ends in `.pdf`, relaxed to SAMEORIGIN, which still refuses
 * every other site on the internet. Nothing else moves — not the admin, not an
 * API route, not an image, not an SVG (markup, and a far better thing to frame
 * from an attacker's point of view).
 *
 * The rule lives here rather than in the uploads route because `/uploads` has
 * more than one handler: `astro dev` serves it through Vite, a production build
 * serves build-time files through the adapter's static handler and runtime
 * uploads through `src/pages/uploads/[...path].ts`. A rule written in one of
 * those three is a viewer that works on the developer's machine and is blank on
 * the server.
 */
export function frameOptionsFor(pathname: string): 'DENY' | 'SAMEORIGIN' {
  const [path] = String(pathname ?? '').split(/[?#]/);
  const framable = /^\/uploads\/.+\.pdf$/i.test(path) && !path.split('/').includes('..');
  return framable ? 'SAMEORIGIN' : 'DENY';
}

export function securityHeaders(_env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const headers: Record<string, string> = {
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
  };

  // HSTS, but only where it is safe to send.
  //
  // Sent over plain HTTP it is ignored; sent from a host that is NOT fully
  // HTTPS it locks users out of that host for `max-age`, and there is no way to
  // undo it from the client. So it is opt-in via HSTS_MAX_AGE rather than on by
  // default: a self-hoster on http://localhost or mid-migration must not be
  // bricked by a CMS being helpful. Set it once TLS is real.
  const hstsMaxAge = (_env.HSTS_MAX_AGE || '').trim();
  if (hstsMaxAge && /^\d+$/.test(hstsMaxAge) && Number(hstsMaxAge) > 0) {
    const parts = [`max-age=${hstsMaxAge}`];
    if (_env.HSTS_INCLUDE_SUBDOMAINS === '1') parts.push('includeSubDomains');
    if (_env.HSTS_PRELOAD === '1') parts.push('preload');
    headers['Strict-Transport-Security'] = parts.join('; ');
  }

  return headers;
}
