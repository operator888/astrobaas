import type { APIRoute } from 'astro';
import { isCommerceEnabled } from '../lib/commerce-service';
import { LocalDB } from '../lib/localdb';
import { getSiteSettings } from '../lib/site';

/**
 * /llms.txt — a plain-text brief for AI coding agents wiring a frontend to this
 * AstroBaaS backend. Tells the agent the base URL, auth scheme, and the exact
 * endpoints, so it doesn't have to guess. Public, no auth.
 */
export const prerender = false;

/**
 * The shop chapters, kept out of the brief when the commerce switch is off.
 * This file describes THIS install, not the product: a brief that sends an
 * agent to endpoints that answer 404 is a brief that teaches it to distrust
 * the rest of the file.
 */
const COMMERCE_SECTION = `## Commerce (first-class)
GET    /api/products              List products (public; active only unless staff &all=true).
                                  Query: ?category= ?brand= ?search= ?on_sale= ?limit= ?offset=
GET    /api/products/{id}         One product by id or slug (public).
POST   /api/products              Create a product.                        [editor+]
PUT    /api/products/{id}         Update a product (partial).              [editor+]
DELETE /api/products/{id}         Delete a product.                        [admin]
GET    /api/brands                List brands (public).
POST   /api/brands                Create a brand.                          [editor+]
GET    /api/product-categories    List product categories (public).
POST   /api/product-categories    Create a product category.               [editor+]
POST   /api/orders                Checkout: { email, name?, items:[{product_id,qty}] }.
                                  Anonymous OK (same-origin CSRF or bearer key);
                                  totals computed server-side; stock decremented.
GET    /api/orders                List orders.                             [editor+]
GET    /api/orders/{id}           One order.                               [editor+]
PUT    /api/orders/{id}           Update status/note.                      [editor+]
GET    /api/customers             List customers.                          [editor+]
POST   /api/customers             Create a customer.                       [editor+]
                                  Money is integer cents everywhere. API-key scopes:
                                  products/orders/customers (read|write|*).
                                  Hooks: before/after_product_save, product_price,
                                  before_order_save, after_order_create,
                                  after_order_status_change.
                                  Order caps: read meta.max_qty_per_product and
                                  meta.max_items_per_order from GET /api/products
                                  rather than assuming — operators change them.
                                  Checkout returns 400 for a bad request and 409
                                  when another buyer took the stock (retryable).

## Payments
GET    /api/payments              Methods this install can take (public). Check
                                  before offering one — an unconfigured provider
                                  is refused at checkout. Staff also get
                                  meta.providers naming missing credentials.
POST   /api/payments/start        { order_number, email, provider } -> redirect_url.
                                  Anonymous OK. The email must match the order:
                                  order numbers are sequential, so number alone
                                  would let anyone open other people's payments.
POST   /api/payments/webhook/{provider}
                                  Provider -> server only. Not for clients.
                                  Signature/fetch-back verified; unverifiable
                                  events are 401 and change nothing.
                                  Order state: "status" = fulfilment,
                                  "payment_status" = money (unpaid|pending|paid|
                                  failed|refunded). A paid order moves to
                                  "processing", never straight to "completed".
                                  Providers: stripe, paypal, klarna + manual
                                  bank-transfer/cod. Card data never touches this
                                  server (hosted checkout only).

`;

/**
 * The CONTENT brief, for a site that publishes rather than serves an API.
 *
 * The API brief below tells a coding agent how to call this backend. That is
 * the right document for a headless install and the wrong one for a blog: an
 * assistant asked "who is Theodoros and what does he write about?" gets a list
 * of REST endpoints.
 *
 * So the two are prepended, not swapped. A single install can legitimately be
 * both — this repo's own site is a blog AND a backend — and picking one would
 * make the other invisible. Everything here comes from what the operator has
 * already written: the site title, the tagline, the author settings, and the
 * newest published posts. Nothing is generated, invented or summarised.
 */
async function contentBrief(base: string, ctx: { astroSite?: URL; requestUrl: URL }): Promise<string> {
  const site = await getSiteSettings({ astroSite: ctx.astroSite, requestUrl: ctx.requestUrl });
  if (!site.siteTitle) return '';

  const posts = (await LocalDB.getPosts())
    .filter((p) => p.status === 'published' && !p.noindex)
    .sort((a, b) => String(b.publish_date ?? b.created_at).localeCompare(String(a.publish_date ?? a.created_at)))
    .slice(0, 10);

  const lines: string[] = [`# ${site.siteTitle}`, ''];
  if (site.siteTagline) lines.push(site.siteTagline, '');
  if (site.siteAuthorName) {
    const who = [`Published by ${site.siteAuthorName}`];
    if (site.siteAuthorTitle) who.push(site.siteAuthorTitle);
    lines.push(who.join(' — '));
    for (const u of site.siteAuthorProfiles) lines.push(`  ${u}`);
    lines.push('');
  }
  lines.push(`Site:    ${base}`, `Feed:    ${base}/rss.xml`, `Sitemap: ${base}/sitemap.xml`, '');

  if (posts.length) {
    lines.push('## Recent writing', '');
    for (const p of posts) {
      // The excerpt as WRITTEN. Generating a summary here would put words in
      // the author's mouth in the one file an assistant is most likely to quote.
      const excerpt = String(p.excerpt ?? '').trim().replace(/\s+/g, ' ').slice(0, 200);
      lines.push(`- ${p.title} — ${base}/blog/${p.slug}`);
      if (excerpt) lines.push(`  ${excerpt}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export const GET: APIRoute = async ({ site, url }) => {
  const base = (site?.toString() || url.origin).replace(/\/$/, '');

  const content = await contentBrief(base, { astroSite: site, requestUrl: url }).catch(() => '');
  const commerceOn = await isCommerceEnabled();
  const body = `${content}# AstroBaaS

A TypeScript-native, self-hostable backend (auth, data, API, storage) for
Astro/React/Vue frontends. This file tells AI agents how to use the HTTP API.

Base URL: ${base}
OpenAPI:  ${base}/openapi.json

## Authentication
Two schemes:
- Bearer API key (recommended for headless/cross-origin/agent use). Send:
    Authorization: Bearer <key>
  Keys are minted by an admin at POST ${base}/api/keys and act with a role
  (admin|editor|author|manager|viewer). Bearer requests are exempt from CSRF.
- Session cookie + double-submit CSRF (for the same-origin admin UI). Writes
  require the X-CSRF-Token header matching the astrobaas_csrf cookie.

Cross-origin browsers: the server must be started with CORS_ORIGINS including
your frontend's origin.

## Response shape
All endpoints return JSON:
  success:  { "success": true, "data": <T>, "message"?: string, "meta"?: object }
  error:    { "success": false, "error": { "message": string, "code"?: string } }

## Core endpoints
GET    /api/posts                 List published posts (all statuses if authed).
                                  Query: ?status= ?category= ?limit= ?offset= ?page=
                                  Response meta: { total, count, limit, offset, page, hasMore }.
GET    /api/posts/{ref}           One post by slug or id (published unless authed).
POST   /api/posts                 Create a post.            [author+]
PUT    /api/posts/{ref}           Update a post (partial; ref = slug or id). [author+/owner]
DELETE /api/posts/{ref}           Delete a post.                             [author+/owner]
                                  (Legacy body-based /api/posts/update and
                                   /api/posts/delete still work but are deprecated.)
GET    /api/categories/get        List categories (with post counts).
GET    /api/search?q=             Full-text search published posts.
GET    /api/media/get             List media.
POST   /api/media/upload          Upload a file (multipart 'file').        [any session]

${commerceOn ? COMMERCE_SECTION : ''}## Custom content types (plugin- or admin-defined collections)
GET    /api/content/{type}        List entities of a custom type.
POST   /api/content/{type}        Create one (schema-validated).           [editor+]
PUT    /api/content/{type}/{id}   Update one.                              [editor+]
DELETE /api/content/{type}/{id}   Delete one.                              [editor+]
GET    /api/content-types         List registered types + schemas.         [staff]

## Auth + keys
POST   /api/auth/login            { email, password } → sets session (or JSON).
POST   /api/auth/forgot           { email } → emails a reset link (always 200).
POST   /api/auth/reset            { token, password } → set a new password.
GET    /api/auth/me               Current user.
GET    /api/audit                 Security audit log (logins, key/webhook/role  [admin]
                                  changes). Query: ?action= ?limit=
POST   /api/keys                  Mint an API key (returned once).         [admin]
                                  Optional: scopes (e.g. ["posts:write"]) for
                                  least-privilege; expires_in_days for expiry.
GET    /api/keys                  List key metadata.                       [admin]
DELETE /api/keys/{id}             Revoke a key.                            [admin]
POST   /api/keys/{id}/rotate      Rotate a key's secret in place.          [admin]
Scopes: "<posts|content|media>:<read|write|*>" or "*". A scoped key is denied
        (403 INSUFFICIENT_SCOPE) on resources/actions it lacks; an unscoped key
        is governed only by its role. Expired keys are rejected (401).

## Webhooks (outbound events)
POST   /api/webhooks              Register { url, events[], active? }; the
                                  signing secret is returned ONCE.          [admin]
GET    /api/webhooks              List hooks (without secrets).             [admin]
DELETE /api/webhooks/{id}         Unregister a hook.                        [admin]
GET    /api/webhooks/deliveries   Delivery log (attempts/status).          [admin]
POST   /api/webhooks/deliveries/{id}/redeliver   Re-send a delivery.       [admin]
Events: post.created, post.updated, post.deleted, content.created,
        content.updated, content.deleted. Subscribe to "*" for all or
        "post.*" for a prefix. Each delivery is a POST with headers
        X-AstroBaaS-Event, X-AstroBaaS-Timestamp, and
        X-AstroBaaS-Signature: sha256=<hex>, where hex =
        HMAC-SHA256(secret, rawBody). Verify by recomputing over the exact
        received bytes (SDK: verifyWebhookSignature). Failed deliveries retry
        with backoff and are recorded in the delivery log for manual re-send.

## Public forms (anonymous, CSRF-protected, rate-limited)
POST   /api/contact               { name, email, subject?, message }
POST   /api/newsletter            { email }

## i18n
GET    /api/locales               which languages this site serves (public)
       Add ?locale=<code> to list endpoints to filter by language. Posts carry "locale"
       and "translation_of" (translations of one piece share a value).
       /<locale>/... URLs serve that language; the default locale is unprefixed.

## Post revisions (session required — these hold unpublished drafts)
GET    /api/posts/<ref>/revisions          history, newest first
POST   /api/posts/<ref>/revisions          autosave a draft (does NOT publish)
POST   /api/posts/<ref>/restore            { revision_id } — restore (undoable)

## Extending this server
Two tiers. Pick by whether you can redeploy.

1. DECLARATIVE PLUGIN — a JSON manifest, installable at RUNTIME, executes nothing.
   Use when you cannot rebuild, or when the capability set below is enough.
     POST /api/plugins/install    { manifest }     (admin)
     DELETE /api/plugins/install  { id }           (admin)
     GET  /api/plugins/registry                    browse the curated registry
   Capabilities: headTags (meta/link only), css (served from /plugins.css),
   contentTypes (generic CRUD at /api/content/<type>), webhooks (https, SSRF-checked).
   Scaffold + validate one locally:
     npx astrobaas plugin manifest <id> && npx astrobaas plugin validate <id>.manifest.json
   The validator is the SAME code the install endpoint runs, so "valid" means
   "installable". Unknown capabilities are a hard error, never ignored.

2. CODE PLUGIN or THEME — TypeScript compiled in at BUILD time. Use for real
   logic (plugins) or template overrides (themes).
     npx astrobaas plugin new <id>     -> src/plugins/<id>/index.ts
     npx astrobaas theme new <id>      -> src/themes/<id>/
   Then add one import + array entry to src/plugins/index.ts or src/themes/index.ts
   and rebuild. Import ONLY from 'astrobaas/core' (types, hooks, slot props).
   Theme slots: Header, Footer, Home, PostCard, PostArticle, PageArticle,
   Sidebar — override any subset; the rest inherit the built-in defaults.

   Constraint that trips people up: the production CSP is hash-based with no
   'unsafe-inline'. Inline <style> and style="..." are silently dropped by the
   browser. Use classes, a scoped <style> in an .astro component, or CSSOM.

## Notes
- Rate limit: 60 req/min/IP by default (RATE_LIMIT_PER_MIN).
- Post HTML is server-sanitized on write and at render.
- See ${base}/openapi.json for the full machine-readable spec.
`;
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
  });
};
