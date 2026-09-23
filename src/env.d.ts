/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />

declare namespace App {
  interface Locals {
    /** Authenticated user for this request, or null. Set by src/middleware.ts. */
    user: { id: string; role: import('./lib/auth').Role } | null;
    /**
     * The ADMIN interface language for this request, and a translator bound to
     * it. Set by src/middleware.ts.
     *
     * Separate from `locale`, which is the language the CONTENT is in. A Greek
     * editor writing German product copy wants Greek buttons — the admin is
     * their tool, not their content.
     */
    uiLocale: string;
    t: import('./lib/i18n/translate').Translator;
    /** Double-submit CSRF token for this request. */
    csrf: string;
    /** Login brute-force throttle: resolves false once the IP+email limit is hit. */
    loginRateCheck?: (email: string) => boolean | Promise<boolean>;
    /** Password-reset request throttle (anti email-bombing): false when over the limit. */
    forgotRateCheck?: (email: string) => boolean | Promise<boolean>;
    /**
     * Resolved client identity for this request (for audit logging / rate
     * limiting / order risk): an IPv4 address, or an IPv6 address grouped to
     * its /64 (`2001:db8:1:2::/64`). For a request from an API key marked
     * `forward_client_ip`, the shopper address its server forwarded.
     */
    ip?: string;
    /**
     * Locale for this request, from a /<locale>/ path prefix (stripped by the
     * middleware) or the site default. Always set; equals the default locale on
     * single-locale installs.
     */
    locale: string;
    /**
     * The path the VISITOR asked for, before the locale prefix was stripped by
     * the internal rewrite. Use this for anything the outside world sees — a
     * canonical URL, an alternate link, an analytics path — and `Astro.url`
     * for routing. On an unprefixed request the two are identical.
     */
    requestPath: string;
  }
}
