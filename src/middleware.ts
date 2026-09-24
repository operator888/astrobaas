import { defineMiddleware, sequence } from 'astro:middleware';
import {
  verifySession,
  isSessionRevoked,
  newCsrfToken,
  csrfEqual,
  csrfCookie,
  shouldSetCsrfCookie,
  bearerToken,
  hashApiKey,
  apiKeyMatches,
  SESSION_COOKIE,
  CSRF_COOKIE,
  canReadCommerce,
  setCapabilityOverrides,
  authSecretProblem,
} from './lib/auth';
import { resolveCommerceEnabled } from './lib/commerce-settings';
import { ensurePluginsBootstrapped } from './plugins';
import { pluginManager, PLUGIN_HOOKS } from './lib/plugin-system';
import { bodyLimitFor } from './lib/body-limits';
import { pluginRouteAccess } from './lib/plugin-platform/routes';
import {
  ensureRedirectsLoaded, matchRedirect, noteRedirectHit, noteNotFound,
} from './lib/legacy/redirect-store';
import { registerBundledCatalogues } from './locales';
import { translatorFor } from './lib/i18n/translate';
import { uiLocale as resolveUiLocale } from './lib/i18n/resolve';
import {
  resolveMaintenance, isAlwaysOpen, shouldHoldRequest,
  maintenanceResponse, maintenanceApiResponse,
} from './lib/maintenance';
import { LocalDB } from './lib/localdb';
import { securityHeaders, corsHeaders, corsAllowOrigin, describeCorsPosture, mergeVary, frameOptionsFor } from './lib/security-headers';
import { apiKeyExpired, scopedKeyAllowed } from './lib/api-key-scopes';
import { sharedRateLimitStore, describeRateLimitStore, type RateLimitResult } from './lib/rate-limit';
import {
  resolveClientIp, trustedForwardedIp, CLIENT_IP_HEADER,
  planRateBuckets, mostRestrictive, resolveRouteLimits, isUnframedWrite,
  type RateBucketPlan,
} from './lib/request-limits';
import { LOGIN_WINDOW_MS, loginAttemptAllowed, resolveLoginLimits } from './lib/login-guard';
import { recordRequest, logRequest } from './lib/observability';
import { trackRequest } from './lib/shutdown';
import { beginProfile, endProfile, serverTimingHeader } from './lib/request-profile';
import { startScheduler } from './lib/scheduler';
import { reportEmailConfig } from './lib/email';
import { splitLocaleFromPath, defaultLocale, isKnownLocale } from './lib/i18n';
import { canOpenAdminPage } from './lib/admin-access';
import type { Role } from './core/models';
import { resolveDiscourageIndexing } from './lib/indexing';
import { normaliseOverrides, ROLE_OVERRIDES_SETTING } from './lib/capabilities';

/**
 * Internal header used to carry the request locale across the rewrite that
 * strips a /<locale>/ prefix (rewrite() re-enters the middleware with the new
 * path, where the locale would otherwise be lost).
 */
const LOCALE_HEADER = 'x-astrobaas-locale';
/**
 * The path as the VISITOR asked for it, carried across the internal rewrite.
 *
 * A prefixed request is rewritten — /de/blog/x is served by blog/[slug].astro,
 * because Astro has no /de/ route files — and after that `Astro.url.pathname`
 * is the STRIPPED path. Every page then built its canonical from the stripped
 * form, so a page served at /de/blog/x declared /blog/x as its canonical while
 * hreflang declared /de/blog/x. The two disagreed about where the document
 * lives, which is exactly the ambiguity a canonical exists to remove.
 *
 * Reconstructing it from the locale would be wrong: a client may send the
 * locale header on an UNPREFIXED request and get German content at /blog/x, and
 * the canonical there is /blog/x. Only the original path knows.
 */
const ORIGINAL_PATH_HEADER = 'x-astrobaas-path';

// Kick off the scheduled-post worker once, at module load (first request).
startScheduler();
// Say what is wrong with the mail configuration but not stopping it (an
// unusable EMAIL_REPLY_TO) now, rather than at the first send.
reportEmailConfig();

/**
 * Rate limiting via a pluggable store (see lib/rate-limit.ts): in-process by
 * default, or a shared libSQL-backed store (RATE_LIMIT_STORE=libsql) so counts
 * are correct across multiple replicas.
 */
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = Number(process.env.RATE_LIMIT_PER_MIN) > 0 ? Number(process.env.RATE_LIMIT_PER_MIN) : 60;

/**
 * Budget for API-KEY authenticated requests, counted per key instead of per IP.
 *
 * A headless storefront is one server: every visitor's page view arrives from a
 * single address, so a 60/min per-IP bucket throttles the entire site at about
 * one page a second. Per-IP is the right shape for anonymous traffic and the
 * wrong shape for a trusted server-to-server integration.
 *
 * Keying on the key id also makes the limit useful in the other direction: one
 * misbehaving integration can be throttled without affecting the rest, which a
 * shared IP bucket cannot do. A key is a credential an operator issued and can
 * revoke, so the generous default is defensible in a way a generous IP default
 * would not be.
 */
const API_KEY_RATE_LIMIT =
  Number(process.env.RATE_LIMIT_API_KEY_PER_MIN) > 0
    ? Number(process.env.RATE_LIMIT_API_KEY_PER_MIN)
    : 6000;

/**
 * Budget for a LOGGED-IN staff member, counted per user rather than per IP.
 *
 * The anonymous ceiling is 60/min per IP, which is right for strangers and
 * wrong for the people who run the shop — and it was being applied to them.
 * Two consequences, both reported from production:
 *
 *   1. Everyone in one office shares one NAT address, so a shop's whole staff
 *      shared a single 60/min bucket. One person's bulk data entry throttled
 *      their colleagues.
 *   2. Adding one product is not one request. It is the save, the category
 *      fetch, the media picker, and a POST per photo — so ordinary work passed
 *      60 in a couple of minutes and simply stopped, with no explanation.
 *
 * A session is a credential an operator issued and can revoke, exactly like an
 * API key, so the generous default is defensible in a way a generous IP default
 * would not be. The limit still exists: it is a runaway-script backstop, not a
 * measure against the person logged in.
 *
 * Deliberately NOT applied to the login or forgot-password throttles. Those
 * protect credentials rather than convenience, and a caller has no session at
 * the point they run.
 *
 * ## Why 1800 and not 600
 *
 * 600 was still sized like a limit on traffic rather than a backstop on a
 * runaway script, and a catalogue screen is not one request. Opening the
 * products list, paging through it, opening a product, going back, and
 * refreshing — the ordinary shape of an hour's work — is hundreds of calls, and
 * the media picker adds one per thumbnail. A staff member doing nothing unusual
 * could reach 600 inside a minute and be told, with no explanation, that they
 * were making too many requests.
 *
 * This bucket is keyed on `user:<id>`, so the only thing on the other side of
 * it is a person who already holds a session the operator issued and can
 * revoke. It is not a defence against crawlers or scanners — those are
 * anonymous and stay at 60/min per IP, which is unchanged. A limit that fires
 * on normal work teaches people to distrust the alert, which costs more than
 * the runaway request it was meant to catch.
 *
 * 30 requests a second sustained for a minute is still far beyond anything a
 * human generates, so the backstop is intact.
 */
const STAFF_RATE_LIMIT =
  Number(process.env.STAFF_RATE_LIMIT_PER_MIN) > 0
    ? Number(process.env.STAFF_RATE_LIMIT_PER_MIN)
    : 1800;

/**
 * Per-IP ceilings for the expensive routes — checkout, quote, payment start,
 * search — and the separate webhook bucket (S3.4). Defaults and the reasoning
 * behind each number live in lib/request-limits.ts.
 */
const ROUTE_LIMITS = resolveRouteLimits();

// Credential throttles: 10 attempts per 15 min per IP+email (unchanged), plus
// the cross-account and per-account failure counters of S3.9. The rules and
// why none of them can lock an owner out are in lib/login-guard.ts.
const LOGIN_LIMITS = resolveLoginLimits();

const rateStore = sharedRateLimitStore();

// Announce the rate-limit posture once at startup so operators can confirm
// whether counters are shared, and warn on the silent multi-replica foot-gun.
{
  const rl = describeRateLimitStore();
  console.log(`[astrobaas] rate-limit store: ${rl.kind}${rl.shared ? ' (shared across replicas)' : ' (per-process)'}`);
  if (rl.warning) console.warn(`[astrobaas] ⚠ ${rl.warning}`);
  // S3.14: a warning, not a change — a live storefront may rely on the wildcard.
  const cors = describeCorsPosture();
  if (cors.warning) console.warn(`[astrobaas] ⚠ ${cors.warning}`);
  // Nobody can sign in until this is fixed; say so at boot, not at the first
  // failed login.
  const secretProblem = authSecretProblem();
  if (secretProblem) console.error(`[astrobaas] ✗ ${secretProblem} Sign-in will fail until it is fixed.`);
}

// Only honour proxy-supplied client IPs when explicitly trusted. Otherwise any
// client can spoof X-Forwarded-For to get a fresh rate-limit bucket per request
// (and forge the source IP seen by login throttling).
const TRUST_PROXY = process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true';

/**
 * Charge a request to each bucket `planRateBuckets` chose, in order, stopping
 * at the first refusal.
 *
 * The plan is keyed on the PRINCIPAL first, most specific first — an API key,
 * else a person, else an address. An IP is only a principal when nothing
 * better is known: it identifies an office, not a person, and charging one
 * person's work to their colleagues' budget was a production incident. Route
 * buckets (checkout, quote, payment start, search, webhooks) come second and
 * are per address. Namespaced so the login, IP, key and route counters cannot
 * collide.
 *
 * Stops at the first refusal so a request the general bucket already refused
 * is not ALSO charged to the checkout bucket — a client backing off should not
 * find a second budget spent on requests that never ran.
 */
async function chargeBuckets(plan: RateBucketPlan[]): Promise<{ allowed: boolean; result: RateLimitResult }> {
  const results: RateLimitResult[] = [];
  for (const b of plan) {
    const r = await rateStore.consume(b.key, b.windowMs, b.limit);
    if (!r.allowed) return { allowed: false, result: r };
    results.push(r);
  }
  // A plan is never empty — an anonymous webhook skips the general bucket only
  // because the webhook bucket replaces it, and tests/request-limits.test.mjs
  // pins that — but `mostRestrictive([])` would throw inside the middleware.
  if (!results.length) {
    const now = Date.now();
    return {
      allowed: true,
      result: { allowed: true, limit: RATE_LIMIT, remaining: RATE_LIMIT, resetAt: now + RATE_WINDOW_MS, retryAfterSeconds: Math.ceil(RATE_WINDOW_MS / 1000) },
    };
  }
  return { allowed: true, result: mostRestrictive(results) };
}

/**
 * The standard budget headers, on EVERY /api response — not only on a 429.
 *
 * A client that can only see its budget once it has been refused can only
 * discover the limit by hitting it. Sent always, a well-behaved client slows
 * down before it is throttled, which is the entire point of publishing them.
 */
function rateLimitHeaders(r: RateLimitResult): Record<string, string> {
  return {
    'RateLimit-Limit': String(r.limit),
    'RateLimit-Remaining': String(r.remaining),
    'RateLimit-Reset': String(r.retryAfterSeconds),
  };
}

/**
 * Stricter throttle for login POSTs: the per-address failure budget across all
 * emails, then IP + submitted email. The per-ACCOUNT rule needs the outcome of
 * the password check, so the login route applies it (see lib/login-guard.ts).
 */
function loginRateCheck(ip: string, email: string): Promise<boolean> {
  return loginAttemptAllowed(rateStore, ip, email, LOGIN_LIMITS);
}

/**
 * The whole commerce API surface, for the master switch. One regex, so a new
 * commerce directory added without touching this line is the review question
 * "why is your shop endpoint reachable on non-shops?".
 */
const COMMERCE_API =
  /^\/api\/(products|product-categories|brands|coupons|customers|orders|shipping-methods|payments|commerce)(\/|$)/;

/** Paths the public can read without a session. */
const PUBLIC_API_GET = [
  // The form SCHEMA for one type, and only when that type accepts public
  // writes — the route itself enforces that and 404s otherwise. Public because
  // the form builder is useless to a headless storefront without it: the
  // staff-only /api/content-types lists every collection including the private
  // ones, so it cannot be the answer.
  /^\/api\/forms\/[^/]+$/,
  /^\/api\/posts\/get(\/|$|\?)/,
  /^\/api\/posts\/?$/, // /api/posts (new RESTful index)
  /^\/api\/posts\/[^/]+$/, // /api/posts/[slug]
  // The related-articles strip for a headless storefront. As public as the
  // article it hangs off: it exposes a SUMMARY of posts the same anonymous
  // caller may already read one by one, and the handler runs each result
  // through `visibleContent` so a draft can never appear as a suggestion.
  // Narrow on purpose — this must not widen the sibling write routes
  // (/duplicate, /restore, /revisions) that share the prefix.
  /^\/api\/posts\/[^/]+\/related\/?$/,
  /^\/api\/categories\/get$/,
  /^\/api\/settings\/get$/,
  // The cookie declaration. Public because both live storefronts are decoupled
  // and render their own privacy pages; a declaration only this origin could
  // serve would be a legal document on the wrong domain. It discloses nothing
  // that devtools does not already show.
  /^\/api\/consent\/cookies\/?$/,
  /^\/api\/themes\/get$/,
  // NOT public. Listing every uploaded file is an inventory of the site: original
  // filenames, sizes and upload dates. Real libraries contain things like
  // "price-list-2026.pdf" or a customer's prescription scan, and the filename
  // alone leaks. Serving the FILES stays public (they are static under
  // /uploads and their URLs are embedded in published content) — enumerating
  // them does not. Only the admin UI ever called this.
  // /^\/api\/media\/get$/,
  /^\/api\/search\/?$/,
  // Completing a newsletter double opt-in. Opened from a mail client by
  // clicking a link, so there is no session by definition and none to protect:
  // the signed, expiring, single-purpose token IS the authorisation, exactly as
  // it is for a magic link. A GET that writes is unusual and deliberate — an
  // email client cannot POST — and the write it performs is idempotent.
  /^\/api\/newsletter\/confirm\/?$/,
  // Leaving the list. Public for the same reasons as confirming, and the right
  // to withdraw consent must be at least as easy as giving it.
  /^\/api\/newsletter\/unsubscribe\/?$/,
  /^\/api\/locales\/?$/, // which languages this site serves (also in the URLs)
  // Anti-spam challenges exist FOR anonymous visitors; a session requirement
  // here would protect the forms from exactly the people they serve.
  /^\/api\/captcha\/challenge\/?$/,
  /^\/api\/content\/changes\/?$/,
  /^\/api\/content\/[^/]+\/?$/, // custom content type list (GET)
  /^\/api\/content\/[^/]+\/[^/]+$/, // custom content entity (GET)
  // Commerce catalog is public read; orders/customers are staff-only (PII).
  /^\/api\/products\/?$/,
  /^\/api\/products\/[^/]+$/,
  /^\/api\/brands\/?$/,
  /^\/api\/product-categories\/?$/,
  /^\/api\/payments\/?$/, // which payment methods this install offers
  // A storefront must render shipping choices before checkout.
  /^\/api\/shipping-methods\/?$/,
  // The EU withdrawal notice is information a trader is REQUIRED to publish,
  // and a decoupled storefront has to render it before checkout.
  /^\/api\/legal\/withdrawal\/?$/,

  // The prescription rules a storefront needs to render its Rx form. Public
  // because the form is public and the rules describe optometry, not the shop.
  /^\/api\/commerce\/prescription-schema\/?$/,
  // Frame geometry, face-measurement limits and the fit tolerance, for the same
  // reason: a storefront builds its size guide from these before anyone logs in.
  // Both routes 404 when the optical module is inactive — being allow-listed
  // here decides only that no SESSION is required, not that the feature exists.
  /^\/api\/commerce\/frame-schema\/?$/,

  // The currency list and its rates. Public for the same reason
  // /api/shipping-methods is: a storefront must render a currency picker before
  // anyone signs in, and a rate is not a secret — the customer is about to be
  // quoted it. Read-only: PUT on the same path is admin-gated in the route, and
  // this entry governs GET alone.
  /^\/api\/commerce\/currencies\/?$/,

  // The merchant's PUBLIC product-field declarations. A headless storefront
  // cannot render "Frame width: 52mm" with a label and a type without the
  // schema. The route itself filters to the public half — being allow-listed
  // here decides only that no session is required, never what is disclosed.
  /^\/api\/commerce\/product-fields\/?$/,

  // "What might this dead address have meant?" — public because a decoupled
  // storefront renders its own recovery page for a visitor who is not logged in
  // and never will be. It returns only what the catalogue already publishes:
  // active product, category and brand names, slugs and URLs, the same fields
  // /api/products hands out anonymously one line above.
  //
  // Rate-limited like every other public GET, and it reads a cached candidate
  // list rather than the catalogue, so a crawler flood on a dead URL cannot be
  // turned into load on the shop's database.
  /^\/api\/recovery\/match\/?$/,

  // The deep health check. Allow-listed so the middleware lets it KNOCK — the
  // handler then requires an admin session or HEALTH_TOKEN and answers 404 to
  // everyone else. Without this a deploy script holding a valid HEALTH_TOKEN
  // would be refused by the middleware before its token was ever looked at.
  /^\/api\/health\/deep\/?$/,
];

const AUTH_API = /^\/api\/auth\//;

// Which admin screens each role may open now lives in lib/admin-access.ts, so
// the middleware, the sidebar and the pages themselves cannot disagree about
// it. Enforcement is still HERE: hiding a link is presentation, and a screen
// added later is denied to non-admins by default even if its author forgets a
// frontmatter check.

/**
 * Per-route request-body ceilings are enforced here, from `lib/body-limits.ts`.
 *
 * Enforced from Content-Length before a handler buffers anything: without it a
 * multi-GB JSON body would be buffered wholesale by request.json(), a trivial
 * memory-exhaustion DoS. A write that carries a body WITHOUT a Content-Length
 * (chunked) used to pass this check unmeasured; it is now refused with 411
 * before the check runs (S3.7, `isUnframedWrite` in lib/request-limits.ts).
 *
 * The TABLE lives in lib/body-limits.ts rather than here because a reverse
 * proxy in front of this app has its own cap and refuses the request before the
 * middleware ever sees it — so the numbers have to be readable by something
 * that can check the shipped nginx and Caddy configs against them. They are;
 * see tests/body-limits.test.mjs.
 */

function isPublicApi(method: string, pathname: string): boolean {
  if (method !== 'GET') return false;
  if (PUBLIC_API_GET.some(rx => rx.test(pathname))) return true;
  // A plugin route that declared itself public. Consulted AFTER the core list,
  // and only ever able to widen access to a path core does not own — a core
  // route file wins at the router, so a plugin cannot reach one of these paths
  // by claiming it.
  return pluginRouteAccess(method, pathname)?.access === 'public';
}

/** Endpoints that accept anonymous POST (public forms). Still CSRF-protected
 *  and rate-limited — just not session-gated. */
const PUBLIC_API_WRITE = [
  // A file attached to a public form. The route 404s unless the type accepts
  // public writes AND declares a file field, so this widens nothing on a site
  // that has not asked for it. Bytes land outside public/uploads and are
  // readable only through the staff-only download route.
  /^\/api\/forms\/[^/]+\/upload\/?$/,
  /^\/api\/contact\/?$/,
  /^\/api\/newsletter\/?$/,
  // "Tell me when it's back" — the storefront's button on a sold-out product.
  // Public and rate-limited through the same gate as the newsletter box.
  /^\/api\/products\/[^/]+\/notify-me\/?$/,
  // RFC 8058 one-click unsubscribe. The caller is Gmail's or Outlook's mail
  // infrastructure pressing the button shown at the top of a campaign message,
  // which has no session and no cookie. Authorised by the signed,
  // single-purpose, expiring token in the query string, checked in the handler
  // — with no token it removes nothing, exactly like the GET.
  /^\/api\/newsletter\/unsubscribe\/?$/,
  // Checkout: anonymous buyers place orders; totals are computed server-side
  // and the endpoint shares the same rate-limit + body-size ceilings.
  /^\/api\/orders\/?$/,
  // Totals preview. Creates nothing — no order, no customer, no stock hold —
  // so it is as public as the checkout it precedes.
  /^\/api\/orders\/quote\/?$/,
  // Anonymous buyers open a payment session for their own order (authorised by
  // order number + the email it was placed with, checked in the handler).
  /^\/api\/payments\/start\/?$/,
  // Provider webhooks. Public because Stripe/PayPal/Klarna call them; each one
  // authenticates itself by signature or credentialled fetch-back inside the
  // handler, which is a stronger check than a session would be.
  /^\/api\/payments\/webhook\/[a-z0-9-]+\/?$/,
  // The AI chat widget runs for anonymous visitors. It is a proxy so the
  // operator's API key stays server-side; the handler bounds every input and
  // the shared per-IP rate limit caps the spend.
  /^\/api\/assistant\/chat\/?$/,
  // The consent receipt. Written by the banner for a visitor who has no
  // session by definition, and it is the record that the decision was made.
  /^\/api\/consent\/receipt\/?$/,
  // A custom content type that declares `writable: 'public'` — an enquiry
  // form, a job application, an RSVP.
  //
  // The pattern is deliberately wider than the set of types that actually
  // accept submissions, because the middleware cannot know which those are
  // without loading the registry, and a second copy of that decision is how
  // the two drift apart. So this only gets the request PAST the session gate;
  // the handler asks the definition and answers 404 for every type that has
  // not said `public` — the same 404 an unregistered name gets. CSRF, the
  // per-IP ceiling and the body limit all still apply.
  /^\/api\/content\/[a-z][a-z0-9-]{1,40}\/?$/,
];
function isPublicWrite(method: string, pathname: string): boolean {
  if (method === 'POST' && PUBLIC_API_WRITE.some(rx => rx.test(pathname))) return true;
  // Plugin routes may be public on any write verb, not just POST: a checkout is
  // a POST but a webhook acknowledgement or an idempotent upsert is often a PUT,
  // and forcing everything through POST to get past this gate would be a worse
  // API shaped by an implementation detail.
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return false;
  return pluginRouteAccess(method, pathname)?.access === 'public';
}

/**
 * Endpoints exempt from CSRF because the caller is a MACHINE that cannot hold a
 * cookie, so the double-submit pattern is meaningless for them.
 *
 * This is a narrow list on purpose. Exempting an endpoint from CSRF is only
 * safe when it authenticates the request some other way — provider webhooks
 * verify a signature (Stripe) or re-read the authoritative state from the
 * provider's API with our own credentials (PayPal, Klarna) before changing
 * anything. An endpoint with no such check must never appear here.
 */
const CSRF_EXEMPT_WRITE = [
  /^\/api\/payments\/webhook\/[a-z0-9-]+\/?$/,
  // The consent receipt. It is written by the banner as the page unloads, via
  // navigator.sendBeacon, which CANNOT set an X-CSRF-Token header — so the
  // double-submit check would reject every real visitor and no receipt would
  // ever be recorded in production. Exempting it is safe because it carries no
  // ambient authority to protect: an anonymous POST of an opaque,
  // browser-generated id, rate-limited per address, that grants the caller
  // nothing. There is no victim cookie for a forged request to ride.
  /^\/api\/consent\/receipt\/?$/,
  // One-click unsubscribe, for the reason this list requires: the caller is a
  // MACHINE — a mail provider POSTing the List-Unsubscribe URL — so it can
  // neither hold the cookie nor set the header the double-submit check needs,
  // and every real reader's unsubscribe would be rejected.
  //
  // Safe under this list's own rule, which demands another form of
  // authentication: the signed single-purpose token IS it, and there is no
  // ambient authority for a forged request to ride. The worst a forgery can do
  // is unsubscribe an address whose valid token the forger already holds —
  // which is to say, remove somebody from a mailing list they can rejoin by
  // signing up again. Kept as an exact-path regex so it widens nothing else.
  /^\/api\/newsletter\/unsubscribe\/?$/,
];
function isCsrfExempt(pathname: string, method = 'POST'): boolean {
  if (CSRF_EXEMPT_WRITE.some(rx => rx.test(pathname))) return true;
  // A plugin route that declared `csrf: 'exempt'`. Same rule as the list above,
  // and it carries the same obligation: exemption is only safe when the request
  // authenticates itself some other way. A plugin gateway verifying a webhook
  // signature qualifies; a cookie-authenticated endpoint does not, and one that
  // does this is a cross-site request away from being called by any page on the
  // internet.
  return pluginRouteAccess(method, pathname)?.csrf === 'exempt';
}

/**
 * Endpoints a COOKIE-LESS browser on an allow-listed origin may POST to without
 * the double-submit cookie dance.
 *
 * Narrower than it looks, and the narrowness is the point — see
 * `isCrossOriginPublicWrite` for the two conditions that must BOTH hold.
 *
 * ## Why checkout is on this list, and why it had to be
 *
 * It held one entry, the assistant widget, and everything else public was
 * unreachable from a browser that is not on this origin. That included
 * CHECKOUT. Both live shops are headless storefronts on their own domains, so
 * a guest pressing Buy sent a cookie-less cross-origin POST and got
 * `403 CSRF_FAILED` — measured, not inferred. Guest checkout worked from curl
 * with a session and from the admin, which is why the smoke suite passed: it
 * sends an admin cookie and a CSRF token, so it was proving that an OPERATOR
 * can place an order, never that a shopper can.
 *
 * The double-submit dance is not available to that caller in the first place.
 * Reading the CSRF cookie cross-site needs `credentials: 'include'`, a
 * `SameSite=None; Secure` cookie and third-party cookie support — which
 * browsers are actively removing. Requiring it does not make checkout safer; it
 * makes checkout impossible.
 *
 * Exempting it is safe for the reason stated on `isCrossOriginPublicWrite`: a
 * request with NO SESSION COOKIE has no ambient authority to ride, so a forged
 * one achieves nothing curl could not already do. These endpoints stay public,
 * rate-limited, input-bounded and server-priced either way — a hostile POST to
 * `/api/orders` creates a pending order for a basket the attacker paid nothing
 * for, which is the same thing they could do by opening the shop.
 *
 * A storefront's SERVER should use an API key instead: bearer auth is already
 * CSRF-exempt, carries a role, and is the right credential for server-to-server.
 * This list is for the shopper's BROWSER.
 */
const CROSS_ORIGIN_PUBLIC_WRITE = [
  /^\/api\/assistant\/chat\/?$/,
  // Checkout, and the two steps either side of it: price the basket, place the
  // order, open the payment session. Guest checkout is all three or none.
  /^\/api\/orders\/?$/,
  /^\/api\/orders\/quote\/?$/,
  /^\/api\/payments\/start\/?$/,
  // The same defect, same fix: a headless storefront's contact form and
  // newsletter box are cookie-less cross-origin POSTs too. Fixing checkout and
  // leaving these is the "one sibling fixed, one not" shape this codebase keeps
  // finding.
  /^\/api\/contact\/?$/,
  /^\/api\/newsletter\/?$/,
  /^\/api\/products\/[^/]+\/notify-me\/?$/,
  // ...and the form builder's own forms, which were the sibling left behind:
  // a `writable: 'public'` type posted from a headless site (a table request,
  // an RSVP, an enquiry) got `403 CSRF_FAILED`, and its file field with it.
  // Measured on a live demo storefront, 2026-09-24. Widening the PATTERN to
  // every type name widens nothing real: the handler still answers 404 for a
  // type that has not said `public`, and the upload route 404s unless the
  // type is public AND declares a file field — the same doors PUBLIC_API_WRITE
  // already opened for same-origin visitors.
  //
  // The pattern also matches the STATIC routes under /api/content/. Today
  // that is `/api/content/changes`, whose POST requires an admin or editor —
  // which a cookie-less caller can only be through a bearer key, already
  // exempt — so it answers 403 either way. A new static POST route there that
  // serves ANONYMOUS callers would inherit this exemption: give it its own
  // decision here, not this one by accident.
  /^\/api\/content\/[a-z][a-z0-9-]{1,40}\/?$/,
  /^\/api\/forms\/[^/]+\/upload\/?$/,
];

/**
 * Is this a cookie-less POST from an allow-listed origin?
 *
 * CSRF exists to stop a malicious page making the victim's browser send a
 * request that rides ambient credentials. A request that carries **no session
 * cookie** has no ambient authority to ride: an attacker gains nothing they
 * could not already do with curl. That is precisely the reasoning this codebase
 * already applies to bearer requests.
 *
 * So both conditions are required, and the first is the load-bearing one:
 *
 *   1. **No session cookie.** If the caller IS carrying a session, CSRF still
 *      applies in full. Skipping it then would let any page trigger this
 *      endpoint using a signed-in admin's session — exactly the attack.
 *   2. **Origin is allow-listed.** Browsers set `Origin` on cross-origin POSTs
 *      and it cannot be forged by page JavaScript, so this keeps embedded
 *      storefronts and widgets to the sites an operator named in CORS_ORIGINS.
 *
 * Condition 2 is not a defence against curl — nothing here is, because a
 * non-browser client was never a CSRF vector. It bounds which *sites* may embed
 * the widget. The endpoint stays public, rate-limited, and input-bounded either
 * way.
 */
function isCrossOriginPublicWrite(
  method: string,
  pathname: string,
  request: Request,
  hasSessionCookie: boolean,
): boolean {
  if (method !== 'POST') return false;
  if (hasSessionCookie) return false; // a session is present -> CSRF applies
  if (!CROSS_ORIGIN_PUBLIC_WRITE.some(rx => rx.test(pathname))) return false;
  const origin = request.headers.get('origin');
  if (!origin) return false; // same-origin form posts omit it; they can do CSRF
  return corsAllowOrigin(origin) !== null;
}

/**
 * The caller's identity for per-IP limits. With TRUST_PROXY, the RIGHT-most
 * X-Forwarded-For entry — the hop our own reverse proxy appended; the entries
 * to its left are client-supplied and spoofable, and honouring them would let
 * an attacker reset rate-limit buckets per request. Assumes a single trusted
 * proxy. IPv6 is grouped by /64 and IPv4-mapped IPv6 is unwrapped (S3.3); see
 * `clientIdentity` in lib/request-limits.ts.
 */
function clientIp(request: Request, directAddr: string): string {
  return resolveClientIp({
    forwardedFor: request.headers.get('x-forwarded-for'),
    realIp: request.headers.get('x-real-ip'),
    directAddr,
    trustProxy: TRUST_PROXY,
  });
}

// Security headers (incl. an env-configurable CSP — see src/lib/security-headers.ts).
// Built once at module load; env is fixed for the life of the server process.
const SECURITY_HEADERS: Record<string, string> = securityHeaders();

/**
 * Observability wrapper: runs first so it sees the FINAL response of every
 * request (including the main middleware's early returns) for counting + logging.
 */
const observe = defineMiddleware(async (context, next) => {
  const started = Date.now();
  // No-op unless PROFILE_REQUESTS=1. Opened HERE, in the outermost wrapper, so
  // a span recorded by an early return in the main middleware still lands on
  // the right request (C-157).
  beginProfile();
  // Counted as in flight until the handler has produced its Response, so a
  // SIGTERM waits for it (src/lib/shutdown.ts). The first call also registers
  // the signal handlers. The decrement is in a `finally`: a handler that
  // throws must not leave the count above zero, or every later shutdown waits
  // out its whole timeout for a request that no longer exists.
  const finished = trackRequest();
  let res: Response;
  try {
    res = await next();
  } finally {
    finished();
  }
  try {
    const ms = Date.now() - started;
    const path = new URL(context.request.url).pathname;
    // The duration feeds the /metrics latency histogram; the status feeds the
    // class counters and the 429 counter.
    recordRequest(res.status, ms);
    logRequest({ method: context.request.method, path, status: res.status, ms, ip: context.locals.ip });
    const profile = endProfile({ method: context.request.method, path, status: res.status, ms });
    // Server-Timing puts the same breakdown in the browser's network panel,
    // where a developer is already looking. Only when profiling is on: the
    // header names internal work and is not something to publish by default.
    if (profile) {
      try {
        res.headers.set('Server-Timing', serverTimingHeader(profile.spans, profile.ms));
      } catch {
        /* a streamed response we do not own */
      }
    }
  } catch {
    /* observability must never break a request */
  }
  return res;
});

registerBundledCatalogues();

const main = defineMiddleware(async (context, next) => {
  const { request, url, cookies, redirect, locals, rewrite } = context;
  const method = request.method.toUpperCase();

  // ---- Locale prefix (/de/blog → /blog, locals.locale = 'de') ----
  // AstroBaaS ships one set of templates whose CONTENT varies by locale, so the
  // prefix is stripped here and every existing route serves every language with
  // no duplicated page files. The default locale is never prefixed, so a
  // single-locale install is completely unaffected. API routes are excluded:
  // clients select a language with ?locale=, not a path prefix.
  const { locale, rest, prefixed } = url.pathname.startsWith('/api/')
    ? { locale: defaultLocale(), rest: url.pathname, prefixed: false }
    : splitLocaleFromPath(url.pathname);

  // rewrite() re-enters this middleware with the NEW (unprefixed) path, where
  // the locale is no longer visible — so carry it on an internal header and
  // prefer that on the second pass.
  //
  // A client CAN send this header itself, but it grants nothing: it only picks
  // which public language to render, exactly like the /de/ prefix or ?locale=.
  // Locale is orthogonal to authorization and to post status, so an unpublished
  // post is no more visible in one language than another. The value is still
  // validated against the configured locales before use.
  const carried = request.headers.get(LOCALE_HEADER);
  locals.locale = prefixed ? locale : (isKnownLocale(carried) ? carried! : locale);

  // What the visitor's address bar says. On the second pass of a rewritten
  // request this is the prefixed path the header carried; otherwise it is just
  // this request's own path.
  //
  // The header is CLIENT-REACHABLE — anyone can send it — and its value becomes
  // the page's canonical URL, so it is verified rather than trusted: the only
  // value accepted is one that strips back to THIS request's pathname under a
  // known locale. That is exactly what our own rewrite produces, and it is a
  // shape a forged header cannot use to point the canonical anywhere else.
  const carriedPath = request.headers.get(ORIGINAL_PATH_HEADER);
  locals.requestPath = url.pathname;
  if (carriedPath && carriedPath.length <= 2048 && carriedPath.startsWith('/')) {
    const split = splitLocaleFromPath(carriedPath);
    if (split.prefixed && split.rest === url.pathname) {
      locals.requestPath = carriedPath;
    }
  }

  if (prefixed) {
    const target = new URL(url);
    target.pathname = rest;
    const headers = new Headers(request.headers);
    headers.set(LOCALE_HEADER, locale);
    headers.set(ORIGINAL_PATH_HEADER, url.pathname);
    return rewrite(new Request(target, { method: request.method, headers }));
  }

  const pathname = url.pathname;

  // ---- CORS preflight for the JSON API (headless cross-origin clients) ----
  //
  // First, before the maintenance fast path and anything that reads the
  // database: it depends only on the environment and the Origin header, and a
  // storefront has to be able to READ a maintenance 503 (and its Retry-After)
  // rather than see its preflight fail and report a CORS error.
  const cors: Record<string, string> = pathname.startsWith('/api/')
    ? corsHeaders(request.headers.get('origin'))
    : {};
  if (method === 'OPTIONS' && pathname.startsWith('/api/')) {
    return new Response(null, { status: 204, headers: cors });
  }
  // Every /api answer carries the same CORS headers, REFUSALS INCLUDED. An
  // early return below skips the decoration that runs after next(), and a
  // 401, 403 or 429 without Access-Control-Allow-Origin is unreadable to the
  // storefront that caused it: the browser withholds the status and the body
  // and reports only "blocked by CORS policy". Every integration bug then looks
  // like a CORS misconfiguration — which is how a CSRF refusal on a public form
  // went unrecognised. So each early /api return goes through this, and
  // tests/request-limits.test.mjs fails on one that does not.
  const withCors = (res: Response): Response => {
    for (const [k, v] of Object.entries(cors)) {
      if (k.toLowerCase() === 'vary') res.headers.set(k, mergeVary(res.headers.get(k), v));
      else res.headers.set(k, v);
    }
    return res;
  };

  // ---- Maintenance mode (env-only fast path) ----
  //
  // Deliberately BEFORE ensurePluginsBootstrapped and before anything that
  // touches the database. The commonest reason to need this page is that the
  // database is migrating, busy, or unreachable — so the check that decides
  // whether to serve it must not depend on the database, or on plugins, or on
  // anything that can be the thing that is broken.
  //
  // Only the environment variable is consulted here. The settings-backed
  // toggle, for a window an admin schedules from the UI, is checked further
  // down once a session has been attached — a planned window is by definition a
  // moment when the database is fine.
  const envMaintenance = resolveMaintenance(
    process.env as Record<string, string | undefined>, null, Date.now(),
  );
  if (envMaintenance.active && !isAlwaysOpen(pathname)) {
    // No session has been read yet, so staff preview cannot apply on this path.
    // That is the right trade: an env-var maintenance mode is the emergency
    // one, and it must answer without reading anything.
    return pathname.startsWith('/api/')
      ? withCors(maintenanceApiResponse(envMaintenance))
      : maintenanceResponse(envMaintenance);
  }

  // ---- Legacy-URL redirects ----
  //
  // Before routing, so a rule an operator wrote wins over a 404 — and before
  // the plugin bootstrap, because a redirect must not wait on anything it does
  // not need.
  //
  // Deliberately NOT applied to /api or /admin. validateRule refuses those
  // paths, and checking here too means a rule that somehow got stored cannot
  // redirect the admin away from the person trying to remove it.
  if (!pathname.startsWith('/api/') && !pathname.startsWith('/admin')) {
    await ensureRedirectsLoaded();
    const hit = matchRedirect(pathname, url.search);
    if (hit) {
      noteRedirectHit(hit.rule);
      if (hit.status === 410) {
        // GONE. Never turned into a redirect to the home page — that is a
        // soft-404 by another name, and these shops are already in trouble
        // with Google Merchant.
        return withCors(new Response('Gone', {
          status: 410,
          headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
        }));
      }
      return withCors(new Response(null, {
        status: hit.status,
        headers: {
          Location: hit.location,
          // A 301 is cached hard by browsers and intermediaries. A shop
          // correcting a mistake it made five minutes ago should not be
          // fighting a year of cached redirects, so say an hour.
          'Cache-Control': hit.status === 301 ? 'public, max-age=3600' : 'no-store',
        },
      }));
    }
  }

  // Register + activate persisted plugins once per process (idempotent).
  await ensurePluginsBootstrapped();

  // The operator's role-capability overrides (C-138), read ONCE per request and
  // handed to lib/auth's predicates.
  //
  // They stay synchronous — every caller is a route guard mid-request, and
  // seventy-five call sites would otherwise need an await for a settings read
  // that happens right here anyway. A failed read sets `null`, which means "the
  // built-in grants", so a database blip degrades to the SHIPPED policy rather
  // than to a lockout.
  try {
    const row = await LocalDB.getSetting(ROLE_OVERRIDES_SETTING);
    setCapabilityOverrides(normaliseOverrides(row?.value));
  } catch {
    setCapabilityOverrides(null);
  }


  // ---- Session attach (always) ----
  // The token is cryptographically verified, then revalidated against the DB so
  // deactivation, role change, and password/forced logout take effect within the
  // request (not only at token expiry). Mismatched session_version, inactive
  // status, or a deleted user invalidates the session immediately.
  const sessionCookie = cookies.get(SESSION_COOKIE)?.value;
  const session = verifySession(sessionCookie);
  let user: App.Locals['user'] = null;
  if (session) {
    try {
      await LocalDB.init();
      const dbUser = await LocalDB.getUser(session.uid);
      if (
        dbUser &&
        dbUser.status === 'active' &&
        (dbUser.session_version ?? 0) === session.sv &&
        // S3.11: a token its holder signed out of is dead, even though its
        // signature and expiry are still good. Read from the record already
        // loaded above, so this costs no extra query.
        !isSessionRevoked(dbUser, session)
      ) {
        // Trust the DB for the live role (immediate effect on role change).
        user = { id: dbUser.id, role: dbUser.role };
      }
    } catch {
      // DB unavailable: fail closed (treat as unauthenticated).
      user = null;
    }
  }
  // ---- API-key / bearer auth (headless, cross-origin, agents) ----
  // A valid `Authorization: Bearer <key>` authenticates the request as the
  // key's role. Bearer auth is NOT cookie-based, so it is exempt from CSRF
  // (the token itself is the credential an attacker cannot ambiently replay).
  let isBearer = false;
  let bearerScopes: string[] | undefined;
  // The authenticated key's record, kept for the client-IP trust decision.
  let bearerKey: { forward_client_ip?: unknown } | null = null;
  if (!user && pathname.startsWith('/api/')) {
    const token = bearerToken(request.headers.get('authorization'));
    if (token) {
      try {
        await LocalDB.init();
        const rec = await LocalDB.findApiKeyByHash(hashApiKey(token));
        // An expired key authenticates as nobody (→ 401 at the gate below).
        if (rec && apiKeyMatches(token, rec.key_hash) && !apiKeyExpired(rec)) {
          user = { id: `apikey:${rec.id}`, role: rec.role };
          isBearer = true;
          bearerScopes = rec.scopes;
          bearerKey = rec;
          // best-effort last-used stamp; don't block the request on it
          LocalDB.touchApiKey(rec.id).catch(() => {});
        }
      } catch {
        /* DB unavailable: fall through unauthenticated */
      }
    }
  }
  locals.user = user;

  // ---- CSRF token: ensure one exists ----
  //
  // Every request gets a token in `locals.csrf` — a page renders it into its
  // meta tag — but only an HTML page response SETS the cookie (S3.13, decided
  // after `next()` below, once the response's type is known). It used to be
  // set on every cookie-less response, including every anonymous API GET, and
  // a response that sets a cookie is one a shared cache refuses to store.
  let csrf = cookies.get(CSRF_COOKIE)?.value;
  const csrfIsNew = !csrf;
  if (!csrf) csrf = newCsrfToken();
  locals.csrf = csrf;

  // ---- Resolve client IP (used by rate limiting + login throttle) ----
  let directAddr = 'unknown';
  try {
    directAddr = (context as any).clientAddress || 'unknown';
  } catch {
    /* clientAddress unavailable in this context */
  }
  // ---- Trusted client-IP forwarding (S3.6) ----
  //
  // A storefront SERVER calls this API on behalf of many shoppers, so every
  // one of them arrives from the server's single address and the per-IP
  // limits, the order risk score and the audit trail all see one "customer".
  // A key an admin has marked `forward_client_ip` may name the shopper in
  // X-AstroBaaS-Client-IP, and that address becomes `locals.ip` for
  // everything downstream. Nobody else can: an anonymous caller, a cookie
  // session and an unmarked key all have the header ignored, because for them
  // it is only something the caller typed.
  const forwardedIp = isBearer ? trustedForwardedIp(bearerKey, request.headers.get(CLIENT_IP_HEADER)) : null;
  const ip = forwardedIp ?? clientIp(request, directAddr);
  locals.ip = ip;
  // Expose a login throttle the auth handler can call with the parsed email
  // (returns false when this address has failed too often across accounts, or
  // has exceeded the IP+email attempt limit).
  locals.loginRateCheck = (email: string) => loginRateCheck(ip, email);
  // Password-reset request throttle: 5 per 15 min per IP+email, so the forgot
  // endpoint can't be used to email-bomb a victim (the endpoint still returns
  // its generic 200 when throttled — no signal to the caller).
  locals.forgotRateCheck = (email: string) =>
    rateStore.hit(`forgot:${ip}|${email.toLowerCase()}`, LOGIN_WINDOW_MS, 5);

  /* ---- Crawler policy (the enforcement half of the seam) ----
   *
   * robots.txt is a REQUEST. A crawler that ignores it is exactly the crawler
   * an operator wanted to stop, so the only place a policy can actually be
   * enforced is here, against the User-Agent header.
   *
   * Core ships the SEAM and no blocklist. Blocking by User-Agent needs a
   * maintained catalogue, and a stale one turns away somebody's real customers
   * — a cost core must not impose on every install for a feature most do not
   * want. So this asks, and does nothing unless a pack answers.
   *
   * Deliberately NOT applied to /admin or /api: a blocked "crawler" string on
   * an admin session would lock a person out of their own site over a header,
   * and the API has its own key and rate-limit story. This governs the public
   * pages a crawler would actually be crawling.
   */
  if (!url.pathname.startsWith('/admin') && !url.pathname.startsWith('/api/')) {
    try {
      const ua = request.headers.get('user-agent') ?? '';
      const verdict = pluginManager.applyFilters(
        PLUGIN_HOOKS.CRAWLER_POLICY,
        { block: false } as { block: boolean; reason?: string },
        { userAgent: ua, path: url.pathname },
      ) as { block: boolean; reason?: string };
      if (verdict?.block) {
        // 403 rather than 404: a crawler that is being refused should learn
        // that the page exists and it is not welcome, so it stops retrying.
        // A 404 teaches it the URL is dead and can poison an index.
        return withCors(new Response(verdict.reason || 'Blocked by crawler policy', {
          status: 403,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        }));
      }
    } catch {
      /* A failing policy plugin must never take the site down. */
    }
  }

  // ---- Rate-limit API ----
  // Held here so the budget can be attached to the SUCCESS response too, not
  // only to a refusal.
  let rateHeaders: Record<string, string> = {};
  if (pathname.startsWith('/api/')) {
    // `user.id` is `apikey:<id>` for bearer requests — see the auth block above.
    const apiKeyId = isBearer && user?.id?.startsWith('apikey:') ? user.id.slice(7) : null;
    // A cookie session identifies a PERSON; only fall through to the IP when
    // nothing has authenticated the request.
    const sessionUserId = !isBearer && user?.id ? user.id : null;
    const plan = planRateBuckets({
      method,
      pathname,
      searchParams: url.searchParams,
      ip,
      apiKeyId,
      userId: sessionUserId,
      forwarded: forwardedIp !== null,
      limits: {
        windowMs: RATE_WINDOW_MS,
        anonymous: RATE_LIMIT,
        apiKey: API_KEY_RATE_LIMIT,
        staff: STAFF_RATE_LIMIT,
        routes: ROUTE_LIMITS,
      },
    });
    const { result: rl } = await chargeBuckets(plan);
    rateHeaders = rateLimitHeaders(rl);
    if (!rl.allowed) {
      return withCors(new Response(
        JSON.stringify({
          success: false,
          error: {
            message: 'Too many requests',
            code: 'RATE_LIMITED',
            // So a client can back off deliberately rather than guessing —
            // and guessing means retrying at once, from everything that was
            // just throttled.
            retry_after: rl.retryAfterSeconds,
          },
        }),
        {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': String(rl.retryAfterSeconds),
            ...rateHeaders,
          },
        },
      ));
    }
    // A write whose length we were not told (S3.7). The size check below reads
    // Content-Length, so a chunked body walked straight past it and was
    // buffered whole by the handler. 411 is the status that names the fix; the
    // proxies and browsers this app is deployed behind are covered in
    // `isUnframedWrite`.
    if (isUnframedWrite(method, request.headers)) {
      return withCors(new Response(
        JSON.stringify({
          success: false,
          error: {
            message: 'A request body must be sent with a Content-Length header',
            code: 'LENGTH_REQUIRED',
          },
        }),
        { status: 411, headers: { 'Content-Type': 'application/json', ...rateHeaders } },
      ));
    }
    // Reject oversized bodies BEFORE any handler buffers them (OOM DoS guard).
    if (method !== 'GET' && method !== 'HEAD') {
      const declared = Number(request.headers.get('content-length') || '0');
      if (declared > bodyLimitFor(pathname)) {
        return withCors(new Response(
          JSON.stringify({ success: false, error: { message: 'Request body too large', code: 'PAYLOAD_TOO_LARGE' } }),
          { status: 413, headers: { 'Content-Type': 'application/json' } },
        ));
      }
    }
  }

  // ---- Maintenance mode (admin-scheduled window) ----
  //
  // The second source, checked here because it needs two things the fast path
  // above deliberately does without: the settings table, and a resolved user.
  //
  // The user is the point. A window an admin schedules is a planned one, so
  // staff should still see the real site and be able to check it before
  // lifting — which is exactly what the emergency env-var path cannot offer,
  // because it answers before any session is read.
  //
  // A failure to read settings means NOT in maintenance. Refusing to serve a
  // site because the maintenance flag could not be read would turn a database
  // hiccup into an outage.
  if (!isAlwaysOpen(pathname)) {
    let settings: Record<string, unknown> | null = null;
    try {
      const rows = await LocalDB.getSettings();
      settings = {};
      for (const r of rows) settings[r.key] = r.value;
    } catch {
      settings = null;
    }
    const planned = resolveMaintenance(
      process.env as Record<string, string | undefined>, settings, Date.now(),
    );
    if (shouldHoldRequest(planned, pathname, user?.role)) {
      return pathname.startsWith('/api/')
        ? withCors(maintenanceApiResponse(planned))
        : maintenanceResponse(planned);
    }

    // ---- Commerce master switch ----
    //
    // An install that has not chosen to be a shop must look like one that
    // never had a shop (the frame-schema rule): the whole public commerce
    // surface answers 404, not 403. Three deliberate exemptions:
    //
    //  * staff sessions — an operator stocks the catalogue and test-drives
    //    the order book BEFORE opening the shop, so admin work keeps its
    //    honest answers;
    //  * payment webhooks — they authenticate by signature, and a provider
    //    retrying an in-flight payment must not be orphaned because the
    //    switch flipped mid-transaction;
    //  * settings that failed to load (`settings === null`) — the gate does
    //    not run, because turning a database hiccup into a storefront outage
    //    would be the maintenance-mode mistake in reverse. Fail-open is
    //    harmless here: the worst case is a blog briefly answering with
    //    empty catalogue lists.
    // ---- A hidden site hides its MACHINE-READABLE maps too ----
    //
    // `discourage_indexing` already covered the rendered pages, robots.txt,
    // the sitemap and the feed. `/llms.txt` and `/openapi.json` are the same
    // disclosure in the two formats a crawler most wants — a complete,
    // annotated map of the install's API — and neither read the setting.
    // robots.txt only stops crawlers that choose to obey it.
    //
    // Gated HERE rather than inside the routes so both stay pure data
    // functions: the OpenAPI contract test invokes that handler directly, and
    // a route that needs a database to describe itself is a route that cannot
    // be checked without one.
    if (
      // `settings === null` means the read FAILED, not that indexing is on. A
      // database blip used to un-hide these two documents — including on a
      // staging deployment, where the environment alone should have been
      // enough. resolveDiscourageIndexing answers correctly for a null value
      // when STAGING is set, so the null check moved inside it.
      (pathname === '/llms.txt' || pathname === '/openapi.json')
      // The fifth reader. Four of the five used to spell this `!!` inline, so
      // the staging override would have hidden the pages and left llms.txt and
      // the OpenAPI document advertising the site to every AI crawler.
      && resolveDiscourageIndexing(settings?.discourage_indexing)
    ) {
      const json = pathname === '/openapi.json';
      return new Response(
        json
          ? JSON.stringify({ openapi: '3.1.0', info: { title: 'Not published', version: '0' }, paths: {} }, null, 2)
          : '# This site is not published.\n\nThe operator has asked search engines and agents not to index it.\n',
        {
          status: 200,
          headers: {
            'Content-Type': json ? 'application/json' : 'text/plain; charset=utf-8',
            'Cache-Control': 'no-store',
            // An early return skips the decoration every other response gets
            // after next() — the commerce 404 below spreads these for the same
            // reason. A hidden site must not also be the one served without
            // nosniff and X-Frame-Options.
            ...SECURITY_HEADERS,
            ...cors,
          },
        },
      );
    }

    //
    // The exemption also has to survive the scope downgrade below. A bearer
    // key's ROLE is the key's role, but a key scoped away from commerce (say
    // `posts:read` on a headless blog) is downgraded to anonymous for the
    // actual read at line 777 — so exempting it here on role alone would let
    // it slip past the 404 and then be served the disabled catalogue as an
    // anonymous caller. The principal only earns the exemption if it may
    // ACTUALLY read this commerce resource: a cookie session on its role, a
    // bearer additionally on its scope.
    const mayReadCommerce =
      canReadCommerce(user?.role) &&
      (!isBearer || scopedKeyAllowed(bearerScopes, method, pathname, pluginRouteAccess(method, pathname)?.scope));
    if (
      settings !== null &&
      COMMERCE_API.test(pathname) &&
      !pathname.startsWith('/api/payments/webhook/') &&
      !resolveCommerceEnabled(settings) &&
      !mayReadCommerce
    ) {
      // Indistinguishable from a genuinely unknown path: same body as the
      // catch-all 404, AND the same decoration (security headers, CORS, the
      // RateLimit-* budget) that the catch-all picks up after next(). An
      // early return skips that decoration, so a bare 404 here would carry
      // NO RateLimit-* headers while `/api/does-not-exist` carries them —
      // and that difference alone fingerprints `/api/products` as a
      // real-but-disabled endpoint, i.e. leaks that this install is a shop.
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...SECURITY_HEADERS,
        ...cors,
        ...rateHeaders,
      };
      return withCors(new Response(
        JSON.stringify({ success: false, error: { message: 'Not found', code: 'NOT_FOUND' } }),
        { status: 404, headers },
      ));
    }
  }

  // ---- Admin interface language ----
  //
  // Resolved AFTER the session is attached, because a staff member's saved
  // preference is the first thing consulted. Anonymous requests get the site
  // default, which for a single-locale install is exactly what they got before
  // this existed — `t()` on a key that is not in a catalogue returns the key,
  // and every public template still uses literals today.
  const resolvedUiLocale = resolveUiLocale(
    user as { locale?: string } | null,
    request.headers.get('accept-language'),
  );
  locals.uiLocale = resolvedUiLocale;
  locals.t = translatorFor(resolvedUiLocale);

  // ---- Admin pages: gate on the DB-REVALIDATED user, not the raw token ----
  // Using `user` (not `session`) means deactivation / password change / forced
  // logout apply to admin PAGES immediately, same as the API — several admin
  // pages render data server-side, so a revoked-but-crypto-valid cookie must
  // not reach them. Role model: staff (author+) may enter /admin; read-only
  // `viewer` accounts have no admin UI; admin-only screens require admin.
  if (pathname.startsWith('/admin')) {
    if (!user) {
      return redirect(`/login?next=${encodeURIComponent(pathname)}`);
    }
    if (user.role === 'viewer') {
      return redirect('/');
    }
    if (!canOpenAdminPage(pathname, user.role as Role)) {
      return redirect('/admin');
    }
  }

  // ---- API auth: writes require a session (except /api/auth/*) ----
  if (pathname.startsWith('/api/') && !AUTH_API.test(pathname)) {
    const isWrite = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';

    // ---- D2-2: the scope gate runs on PUBLIC paths too ----
    //
    // It used to live inside the `isWrite || !isPublicApi(...)` block below,
    // which meant a public GET skipped it entirely. That looked harmless —
    // anyone may read a public path, so a scoped key reading one gains nothing.
    //
    // It was not harmless, because bearer auth does two things: it grants
    // access AND it establishes an identity. Several public GETs widen their
    // result set for an identified caller — `/api/posts` projects
    // `visibilityQuery(user)`, so an authenticated editor sees unpublished
    // drafts where an anonymous caller sees none. Driven with a real key: a
    // key scoped to `products:read` read a draft post titled
    // SECRET-UNPUBLISHED-DRAFT that the same request without credentials
    // could not see. A least-privilege credential was reading every embargoed
    // article in the system.
    //
    // The fix strips the ELEVATION and keeps the ACCESS: on a public GET, a
    // scoped key that does not name this resource is treated as anonymous. It
    // still gets the public view, which is exactly what it was entitled to.
    //
    // A blanket 403 was the obvious alternative and is wrong here.
    // `scopedKeyAllowed` is deny-by-default, and several public paths map to
    // NO scope at all — `/api/settings/get`, `/api/themes/get`,
    // `/api/locales`, `/api/categories/get`. There is no scope an operator
    // could grant to restore them, so 403 would break headless storefronts
    // with no fix available. Non-public paths still 403, unchanged.
    if (isBearer && !scopedKeyAllowed(bearerScopes, method, pathname, pluginRouteAccess(method, pathname)?.scope)) {
      if (!isWrite && isPublicApi(method, pathname)) {
        user = null;
        locals.user = null;
      } else {
        return withCors(new Response(
          JSON.stringify({ success: false, error: { message: 'This API key\'s scopes do not permit this endpoint', code: 'INSUFFICIENT_SCOPE' } }),
          { status: 403, headers: { 'Content-Type': 'application/json' } },
        ));
      }
    }

    if (isWrite || !isPublicApi(method, pathname)) {
      // `user` is set by either a cookie session OR a valid bearer API key.
      if (!user) {
        // Public GETs and public form POSTs are allowed; anything else
        // without auth is 401. (CSRF is still enforced below for writes.)
        if (!isPublicApi(method, pathname) && !isPublicWrite(method, pathname)) {
          return withCors(new Response(
            JSON.stringify({ success: false, error: { message: 'Unauthorized', code: 'UNAUTHORIZED' } }),
            { status: 401, headers: { 'Content-Type': 'application/json' } },
          ));
        }
      }
      // (The scope gate used to sit here. It now runs above, for every /api
      // path rather than only the non-public ones — see D2-2.)
      // CSRF: double-submit cookie pattern for non-GET requests. Bearer-token
      // (API-key) requests are exempt — they carry no ambient cookie, so CSRF
      // does not apply; the token is the credential.
      const cookielessPublic = isCrossOriginPublicWrite(method, pathname, request, !!sessionCookie);
      if (isWrite && !isBearer && !isCsrfExempt(pathname, method) && !cookielessPublic) {
        let token =
          request.headers.get('x-csrf-token') || request.headers.get('x-xsrf-token') || '';
        if (!token) {
          const ct = request.headers.get('content-type') || '';
          if (ct.includes('application/x-www-form-urlencoded') || ct.includes('multipart/form-data')) {
            try {
              const cloned = request.clone();
              const form = await cloned.formData();
              token = String(form.get('_csrf') ?? '');
            } catch {
              /* ignore */
            }
          }
        }
        if (!csrfEqual(token, csrf)) {
          return withCors(new Response(
            JSON.stringify({
              success: false,
              error: { message: 'Bad or missing CSRF token', code: 'CSRF_FAILED' },
            }),
            { status: 403, headers: { 'Content-Type': 'application/json' } },
          ));
        }
      }
    }
  }

  // ---- Continue & decorate response ----
  const res = await next();
  // Astro middleware can return a Response we don't own (streamed); only set
  // headers when we can.
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    res.headers.set(k, v);
  }
  // …except the one header that is per-path. SECURITY_HEADERS is computed once
  // at module load, so the frame rule cannot live in it; set after the loop so
  // there is exactly one place that decides and no chance of the loop putting
  // DENY back over it. See frameOptionsFor.
  res.headers.set('X-Frame-Options', frameOptionsFor(pathname));
  // Echo CORS headers on allowed cross-origin API responses. `Vary` is MERGED,
  // never replaced: a cacheable route has already said it varies on Cookie and
  // Authorization, and overwriting that with `Origin` alone would let a shared
  // cache serve one caller's copy to another.
  withCors(res);
  // Publish the remaining budget on every /api response. A client that can only
  // learn its limit by being refused can only discover it by hitting it.
  for (const [k, v] of Object.entries(rateHeaders)) {
    res.headers.set(k, v);
  }
  // The CSRF cookie, only where it is read: an HTML page outside /api (S3.13).
  // Every admin screen and every same-origin public form reads the token from
  // the page it was served with, and the sign-in response sets it for scripts
  // that never load a page. A headless storefront's cookie-less cross-origin
  // writes never needed it — they pass `isCrossOriginPublicWrite` instead.
  if (csrfIsNew && shouldSetCsrfCookie(pathname, res.headers.get('content-type'))) {
    res.headers.append('Set-Cookie', csrfCookie(csrf));
  }

  // Record a 404 once the REAL status is known.
  //
  // Here rather than in a catch-all route, because a 404 can come from a page,
  // an endpoint or Astro itself, and only the finished response knows which.
  // Buffered and flushed on a timer (see redirect-store.ts), so a crawler flood
  // costs no database writes.
  if (res.status === 404 && !pathname.startsWith('/api/') && !pathname.startsWith('/admin')) {
    noteNotFound(pathname, url.search, request.headers.get('referer') ?? undefined);
  }

  return res;
});

export const onRequest = sequence(observe, main);
