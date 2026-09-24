# Headless integration guide

How to use AstroBaaS as a backend for a separate frontend (Astro/React/Vue/an
AI-vibe-coded app) or from an AI agent. For running it as a classic CMS, the
[README](./README.md) is enough; this guide is the headless/BaaS path.

- [1. Mint an API key](#1-mint-an-api-key)
- [2. Allow your origin (CORS)](#2-allow-your-origin-cors)
- [3. Call the API](#3-call-the-api)
- [4. The typed SDK (`astrobaas/client`)](#4-the-typed-sdk-astrobaasclient)
- [5. Webhooks](#5-webhooks)
  - [Or poll: the change feed (ISR / revalidation)](#or-poll-the-change-feed-isr--revalidation)
- [6. AI agents (MCP + llms.txt)](#6-ai-agents-mcp--llmstxt)
- [7. Embeddable AI assistant widget](#7-embeddable-ai-assistant-widget)
- [8. The CLI](#8-the-cli)

---

## 1. Mint an API key

Keys authenticate headless/cross-origin callers and act with a **role**
(`admin` | `editor` | `author` | `viewer`). Create one as an admin:

```bash
curl -X POST https://cms.example.com/api/keys \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -d '{"name":"my-frontend","role":"editor"}'
# → { "success": true, "data": { "id": "...", "prefix": "abk_…", "key": "abk_…" } }
```

The full `key` is shown **once** — store it as a secret (it's SHA-256 hashed at
rest). Revoke with `DELETE /api/keys/{id}`. You can also mint the first key from
the admin UI while signed in with the cookie session.

**Least-privilege + lifecycle (optional):**
- `scopes`: restrict a key to `resource:action` capabilities, e.g.
  `{"scopes":["posts:write","content:read"]}` (resources: `posts`/`content`/
  `media`/`products`/`orders`/`customers`/`messages`; actions: `read`/`write`/`*`;
  or the global `*`). A scoped key is denied (`403 INSUFFICIENT_SCOPE`) on
  anything outside its scopes; omit `scopes` for full role-based access.
- `expires_in_days`: set an expiry — expired keys are rejected (`401`).
- **Rotate** a key's secret without changing its id/role/scopes:
  `POST /api/keys/{id}/rotate` (the old secret stops working immediately). With
  the SDK: `baas.keys.rotate(id)`.

Send it on every request:

```
Authorization: Bearer abk_xxx
```

Bearer requests are **CSRF-exempt** (no cookie, no ambient authority). Reads
(`GET`) work anonymously too, but only return published content.

### Rate limits: whose budget a request spends

Every `/api` response carries `RateLimit-Limit`, `RateLimit-Remaining` and
`RateLimit-Reset`, describing the budget **closest to refusing** that caller.
A `429` adds `Retry-After`.

| caller | general budget (per minute) | route budgets |
|---|---|---|
| anonymous | 60 per address (`RATE_LIMIT_PER_MIN`) | yes, per address |
| API key | 6000 per key (`RATE_LIMIT_API_KEY_PER_MIN`) | only with client-IP forwarding (below) |
| signed-in staff | 1800 per person (`STAFF_RATE_LIMIT_PER_MIN`) | no |

The route budgets are **in addition to** the general one, per address, per
minute:

| route | default | env |
|---|---|---|
| `POST /api/orders` | 10 | `RATE_LIMIT_CHECKOUT_PER_MIN` |
| `POST /api/orders/quote` | 30 | `RATE_LIMIT_QUOTE_PER_MIN` |
| `POST /api/payments/start` | 10 | `RATE_LIMIT_PAYMENT_START_PER_MIN` |
| `GET /api/search`, `GET /api/products?search=` | 30 | `RATE_LIMIT_SEARCH_PER_MIN` |
| `POST /api/payments/webhook/*` | 600 | `RATE_LIMIT_WEBHOOK_PER_MIN` |

Payment webhooks do **not** spend the anonymous 60/min — a provider sends
bursts, and a 429 there is a payment the shop hears about late. Their own
budget is generous; the signature check is what protects them.

An IPv6 caller is counted per **/64** (one subscriber's allocation), and an
IPv4-mapped address (`::ffff:1.2.3.4`) is counted as the IPv4 address.

### A storefront SERVER calling for a shopper (the BFF pattern)

When a server-rendered storefront (Next.js route handlers, a BFF) calls this
API with its key, every shopper arrives from the **server's** address. The
per-address checkout budget would then be one budget for the whole shop, order
risk scoring would see one customer, and the audit trail would record the
server. So a key's own requests are never charged per route — and, if you want
per-shopper limits and per-shopper risk scores, the server can say which shopper
it is calling for.

1. An admin marks the key as a forwarding key — when minting it:

   ```bash
   curl -X POST https://cms.example.com/api/keys \
     -H 'Content-Type: application/json' -H "Authorization: Bearer $ADMIN_KEY" \
     -d '{"name":"storefront-bff","role":"editor","scopes":["products:read","orders:write"],"forward_client_ip":true}'
   ```

   or on an existing key, without rotating it:

   ```bash
   curl -X PATCH https://cms.example.com/api/keys/$KEY_ID \
     -H 'Content-Type: application/json' -H "Authorization: Bearer $ADMIN_KEY" \
     -d '{"forward_client_ip":true}'
   ```

2. The storefront server sends the shopper's address, **one address**, on each
   call it makes for that shopper:

   ```ts
   await fetch(`${CMS}/api/orders`, {
     method: 'POST',
     headers: {
       Authorization: `Bearer ${process.env.ASTROBAAS_KEY}`,
       'Content-Type': 'application/json',
       // The address YOUR edge saw for the shopper — never a value the browser sent you.
       'X-AstroBaaS-Client-IP': shopperIp,
     },
     body: JSON.stringify(order),
   });
   ```

For those requests that address is the caller's address everywhere downstream:
the checkout/quote/payment/search budgets, order risk, and the audit trail. The
key keeps its own 6000/min budget as well, and is not charged the anonymous
60/min (a server makes several calls per page).

What it does **not** do:

- It is ignored on every request that is not authenticated by a key marked
  `forward_client_ip` — anonymous callers, cookie sessions and ordinary keys
  cannot use it to pick an address.
- A list (`1.2.3.4, 5.6.7.8`) or anything that is not a single IP is ignored,
  not picked from, and the server's own address is used.
- It is not offered to browsers (it is absent from the CORS allow-headers). The
  key is a server secret; if it ever reaches a browser, revoke it — a
  forwarding key in the wrong hands can choose which address its requests are
  counted against.

Where the shopper's address comes from is the storefront's responsibility: take
it from your own edge (`x-forwarded-for` as appended by *your* proxy or CDN,
`request.ip` on Vercel/Next.js middleware), never from a header the browser
could set.

### Request bodies need a length

A `POST`/`PUT`/`PATCH`/`DELETE` to `/api` that carries `Transfer-Encoding`
without `Content-Length` (a chunked or streamed body) is refused with
`411 LENGTH_REQUIRED` — the per-route body-size ceilings are checked from
`Content-Length` before anything is read. `fetch`, XHR, form posts, `curl -d`
and the SDK all send it. Stream uploads (`ReadableStream` bodies) do not; buffer
the body first.

## 2. Allow your origin (CORS)

If your frontend runs on a **different origin**, start the backend with the
origins allow-listed:

```bash
CORS_ORIGINS="https://app.example.com http://localhost:3000" npm run start
```

Credentials are never allowed (auth is a header token, not a cookie), so no page
can read a signed-in admin's data through CORS, even with `CORS_ORIGINS=*`.
Same-origin frontends need nothing.

**The allow-list does a second job, and `*` switches it off.** A shopper's
browser on your storefront places orders, starts payments, posts contact and
newsletter forms and submits your own public forms (any content type with
`writable: 'public'`, file fields included) **without** the CSRF cookie (it
cannot read one cross-site).
That is allowed only for requests that carry **no session cookie** and whose
`Origin` is on this list. With `CORS_ORIGINS=*`, any website can make a
visitor's browser do those things. No session is involved, so nothing is taken
from the visitor — but you lose the ability to say "only our storefront embeds
our checkout". The server logs a warning at startup and `GET /api/health/deep`
reports `cors_origins: warn` while the wildcard is set. List your storefront
origins instead.

**`Origin` is not a security boundary for cookie-less requests.** Browsers set
it and page JavaScript cannot forge it, which is why it can decide which sites
may embed a checkout. Anything that is not a browser — `curl`, a script, a bot —
sends whatever `Origin` it likes. The endpoints this gate opens are public
anyway; what limits a non-browser caller is the rate limits above, the input
bounds, and server-side pricing.

**The CSRF cookie is set on HTML pages only.** A same-origin page gets
`astrobaas_csrf` when it loads and sends it back as `X-CSRF-Token`; a JSON
sign-in (`POST /api/auth/login`) also sets it for a script that never loads a
page. API responses (including every anonymous `GET`) no longer set any cookie,
so a CDN can cache them. Cookie-less cross-origin storefront calls never needed
the token.

**Refusals are readable too.** Every `/api` answer to an allow-listed origin
carries the CORS headers, errors included: a `401`, `403 CSRF_FAILED`,
`403 INSUFFICIENT_SCOPE`, `411`, `413`, `429` or maintenance `503` reaches your
code with its status and `error.code`. So if your browser console says a
request was *blocked by CORS policy*, look first at `CORS_ORIGINS` (is this
exact origin, scheme and port included, on the list?) and at the request's
headers (a custom header outside `Content-Type`, `Authorization`,
`X-CSRF-Token` and `Idempotency-Key` fails the preflight). An unexpected server
error (500) is the one answer that can still arrive without CORS headers.

## 3. Call the API

All responses share one envelope:

```jsonc
{ "success": true,  "data": <T>, "message"?: "...", "meta"?: { ... } }
{ "success": false, "error": { "message": "...", "code"?: "..." } }
```

Core endpoints (full list in [`/openapi.json`](#6-ai-agents-mcp--llmstxt)):

| Method & path | Purpose | Min role |
| --- | --- | --- |
| `GET /api/posts?status=&category=&kind=&limit=` | List posts (published when anonymous) | – |
| `GET /api/posts/{slug}` | One post (article or page) | – |
| `GET /api/posts/{slug}/related` | Related articles for the strip under a post | – |
| `GET /api/products` | The catalogue (`search`, `category`, `brand`, `featured`, `on_sale`) | – |
| `GET /api/products/{ref}` | One product, by id or slug | – |
| `POST /api/products/{ref}/notify-me` | "Tell me when it's back" | – |
| `POST /api/orders/quote` | Price a basket, server-side | – |
| `POST /api/orders` | Place an order — **no account needed** | – |
| `POST /api/payments/start` | Open a payment session for an order | – |
| `POST /api/orders/{id}/ship` | Record tracking; emails the customer once | staff |
| `GET /api/orders` | List orders | staff |
| `GET /api/customers` | List customers | staff |
| `GET/POST /api/coupons` | Coupons and automatic cart rules | staff |
| `POST /api/posts` | Create a post or page | author |
| `GET /api/content/{type}` | List custom-type entities | – |
| `POST /api/content/{type}` | Create one (schema-validated) | editor |
| `PUT /api/content/{type}/{id}` | Update one | editor |
| `DELETE /api/content/{type}/{id}` | Delete one | editor |
| `GET /api/auth/me` | Who the credential resolves to | – |

The typed client covers all of these:

```ts
import { createClient } from 'astrobaas/client';
const baas = createClient('https://cms.example.com');

const frames = await baas.products.list({ category: 'frames', on_sale: true });
const quote  = await baas.orders.quote({ items: [{ product_id: frames[0].id, qty: 1 }] });
const order  = await baas.orders.place({ email: 'buyer@example.com', items: [...] });
```

A shopper never needs an account: `orders.place` is public, and prices are
computed server-side from the ids and quantities, so a basket total sent by a
client is ignored.

### Checkout from a storefront

`POST /api/orders` is public, so it carries its own abuse controls. What a
storefront has to do about each:

**Send an `Idempotency-Key`.** Generate one per checkout attempt (a UUID) and
send it with every retry of that attempt:

```ts
const key = crypto.randomUUID();           // once per "Place order" click
const res = await fetch(`${CMS}/api/orders`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
  body: JSON.stringify(order),
});
```

| Answer | Meaning | Do |
| --- | --- | --- |
| `201` + `Idempotent-Replayed: true` | This key already placed an order. The body is the original one. | Treat as success. |
| `409`, `reason: IDEMPOTENCY_IN_PROGRESS` | The first request with this key is still running. | Wait `Retry-After`, retry with the same key. |
| `422`, `reason: IDEMPOTENCY_KEY_REUSED` | The key was used for a different body. | Generate a new key. |
| `400`, `reason: IDEMPOTENCY_KEY_INVALID` | The key is not 1–255 printable ASCII characters. | Fix the client. |

A refused order (out of stock, bad coupon, …) does not burn the key: fix the
cause and retry with it. Keys are kept for 24 h and are scoped to the caller: an
anonymous browser, or your API key. The typed client sends one automatically on
`orders.place()`, and keeps it across its own retries.

**Proof-of-work, if the shop switches it on.** Settings → Anti-spam check →
"Checkout". It is off by default. When it is on, an anonymous `POST /api/orders`
must carry a solved challenge in `pow_token`, or it is refused with `403`
`reason: checkout.captcha_failed`. Staff sessions and API keys are not asked. A
browser storefront solves it the way the CMS's own forms do:

```ts
async function powToken(surface: 'checkout' | 'magic-link'): Promise<string | undefined> {
  const r = await fetch(`${CMS}/api/captcha/challenge?surface=${surface}`);
  const { data } = await r.json();
  if (!data?.enabled) return undefined;               // not switched on: send nothing
  const enc = new TextEncoder();
  for (let n = 0; ; n++) {
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(`${data.token}.${n}`)));
    let bits = data.bits, ok = true;                   // `bits` leading zero bits
    for (let i = 0; bits > 0; i++, bits -= 8) {
      if (d[i] >>> (8 - Math.min(8, bits)) !== 0) { ok = false; break; }
    }
    if (ok) return `${data.token}::${n}`;
  }
}
// … body: JSON.stringify({ ...order, pow_token: await powToken('checkout') })
```

A token is single-use, valid for ten minutes, and bound to its surface. Fetch
and solve a new one for every order; a retry with the same `Idempotency-Key`
may carry a new token. `POST /api/auth/magic-link` has the same opt-in
`magic-link` surface.

**Other refusals a checkout page should handle:**

| Answer | Meaning |
| --- | --- |
| `429`, `reason: checkout.too_many_unpaid`, `params.max` | This buyer already has `max` unpaid orders waiting. The cap counts by email; for anonymous shoppers it also counts by network address, over the last couple of hours. Ask them to pay or cancel one. `Retry-After` is set. A server-side storefront calling with an API key is capped by email only. |
| `400`, `reason: checkout.coupon_invalid` | The code was refused. Callers who are not staff get one generic message. `params.shortfall_cents` is present only when the basket is below the code's minimum spend. |
| `409`, `reason: checkout.promotion_unavailable` | An automatic cart rule in the quote has been used up. Re-quote and show the new total. |
| `422` on `email` | The address is not a single well-formed address. |

`POST /api/orders/quote` reports a refused coupon as
`coupon: { ok: false, reason: "invalid", message }` to anyone but staff. The
exception is `reason: "minimum-not-met"`, which comes with `shortfall_cents`.

Every specific code is in `error.reason`, with its values in `error.params`.
`error.code` is still the HTTP-derived code. The typed client exposes them as
`AstroBaasError.reason` and `AstroBaasError.params`, and keeps
`AstroBaasError.code` as it was.

### Paying for an order

`POST /api/payments/start` with `{ order_number, email, provider }` returns the
provider's `redirect_url`. What changed for storefronts:

- **Return URLs use the shop's configured Site URL** (Settings → General →
  Site URL, then `SITE_URL`). The request's own origin is used only when
  neither is set. On a headless shop, set Site URL to the **storefront's**
  origin. The provider sends the buyer back to
  `<site>/checkout/success?order=…` and `<site>/checkout/cancelled?order=…`.
- **Online payments have a time limit.** An unpaid order paid through Stripe,
  PayPal or Klarna is cancelled once the shop's payment hold runs out (default
  120 minutes from placing it), and its stock goes back on sale. After that,
  `payments/start` answers `409` `reason: payment.window_closed`: ask the buyer
  to order again. Stripe's page closes at the same moment. See COMMERCE.md for
  PayPal and Klarna.
- **A declined card does not end the order.** The buyer can try another card
  on the provider's page. Only the session expiring, or the buyer abandoning
  it, cancels the order.
- **PayPal is captured by the CMS.** After the buyer approves, the CMS captures
  the payment when PayPal's webhook arrives, so the order becomes paid a few
  seconds after the buyer returns. A storefront should poll or re-read the
  order rather than assume. If the order was cancelled meanwhile and its items
  have been sold, nothing is captured and the buyer is not charged.
- `GET /api/health/deep` warns (`payment_return_urls`) while Site URL is
  empty, or points at the CMS rather than the storefront.
- Order state still comes only from the **webhook**, never from the buyer
  landing on the success page.

### Articles vs. pages (`kind`)

A **page** is a `Post` with `kind: "page"`. Same record, same endpoints — it is
routed at `/{slug}` instead of `/blog/{slug}` and carries no date or author
byline. Records created before this field exists have no `kind` at all, and an
absent value means "article".

`GET /api/posts` **returns articles only by default.** That is deliberate: an
existing storefront calling this endpoint to render its blog must not start
receiving `About`-style pages the day someone writes one. Opt in explicitly:

| Query | Returns |
| --- | --- |
| `GET /api/posts` | Articles only (the default; unchanged from before pages existed) |
| `GET /api/posts?kind=page` | Pages only |
| `GET /api/posts?kind=all` | Both |

An unrecognised `kind` falls back to the default rather than erroring, so a typo
cannot empty a production listing.

### Paging lists (`limit`, `offset`, `page`)

`GET /api/posts` and `GET /api/content/{type}` page the same way:

| Query | Meaning |
| --- | --- |
| `?limit=N` | At most `N` rows, capped at **200** |
| `?offset=N` | Skip `N` rows (works with or without `limit`) |
| `?page=N` | 1-based page, only together with `limit` |

**With no `limit`, at most 1000 rows come back.** Before, "no limit" meant the
whole collection on every request. 1000 is above what either live shop holds,
so below it nothing changes: every row, `meta.limit: null`,
`meta.hasMore: false`. Above it, `meta.total` is the full count,
`meta.hasMore` is `true`, and `?offset=1000` returns the next slice. A client
that renders a long archive should page with `limit` anyway.

`meta` always carries `total`, `count`, `limit`, `offset`, `page` and `hasMore`.

Which page (if any) serves as the site root is published as the `home_page_slug`
setting via `GET /api/settings/get`, so a decoupled front end can render the same
home document the CMS does.

### Searching

Two endpoints search, and they cover different things. There is no single
endpoint that searches the whole site.

| Endpoint | Covers | Minimum query |
| --- | --- | --- |
| `GET /api/products?search=` | Products | none |
| `GET /api/search?q=` | Published **articles** only — no products, no pages | 2 characters |

If you want one search box over a shop, call `GET /api/products?search=`. A box
wired only to `/api/search` returns zero products, however many you have.

**What a product search matches.** Five fields, weighted, most important first:

| Field | Weight |
| --- | ---: |
| `name` | 6 |
| `sku` | 5 |
| `gtin` | 5 |
| `brand` | 3 |
| `tags` | 2 |

`description` and `short_description` are **not** searched, and neither are
variant SKUs. Barcodes and tags are, because both are things people paste and
both are short enough not to flood the results the way free text would.

Results are **ranked, not merely filtered**, and the ranking is stable — equally
relevant products keep the merchandising order the shop chose (`position`, then
newest).

**Case and accents don't matter.** Queries and stored text are folded the same
way: Unicode NFD, combining marks stripped, lowercased, whitespace collapsed,
and Greek final sigma `ς` unified with `σ`. So `ΑΛΥΣΙΔΑ`, `αλυσίδα` and
`Αλυσίδα` are one query, and `Σκελετός` is found by `σκελετοσ`. Folding is
**not** NFKD, so `ß`, ligatures and full-width characters do not fold.

**What it will not do is translate.** A Greek shopper typing `Ρέι Μπαν` will not
find `Ray-Ban`: that is a phonetic rendering, not an accent difference, and no
folding rule can bridge it. Nothing in the core guesses. The mechanism for it is
the operator's own synonym table — Settings → search synonyms — which the
catalogue and the blog both read.

**Queries are bounded.** Every search — `/api/products?search=`,
`/api/search?q=` and `/blog?q=` — reads at most the first **200 characters** of
the query and at most **12 distinct words**; a repeated word counts once.
Ranking costs `words × fields × items`, so an unbounded query was a way to make
one request do thousands of passes over the catalogue. `/api/search` echoes the
clipped query in `meta.q`, so a client can see what was actually searched.
`/api/recovery/match?path=` likewise reads the first 1024 characters of a path
and matches on at most 12 meaningful words.

### Brands

`GET /api/brands` returns every maker with active products, plus any curated
brand record:

```json
{ "name": "Ray-Ban", "slug": "ray-ban", "count": 17, "key": "rayban",
  "spellings": [{ "name": "Rayban", "count": 16 }, { "name": "RAYBAN", "count": 1 }],
  "curated": false }
```

`count` is a promise about `?brand=`: it is exactly what
`GET /api/products?brand=<slug>` returns. Render a brands menu or an A–Z page
from this rather than downloading the catalogue to derive one.

**Link by `slug`.** A published slug leads to its own brand, whatever script or
spelling the brand uses: `Straße` publishes `strasse`, `Γυαλιά Όψη` publishes
`gyalia-opsi`, and a curated record keeps the slug it was given (`rb` for
Ray-Ban) — and `?brand=` with any of those returns exactly `count` products.
Take slugs from this endpoint rather than building them yourself.

Slugs are unique across the listing. When two makers slugify alike (`Straße`
and `Strasse`), the one the slug spells keeps it and the other publishes a
suffixed slug (`strasse-1hdqgjn`). A suffixed slug keeps working after the
clash is gone, and so does a slug from an older spelling of the same brand, so
a cached link does not break. A plain slug, though, moves to the maker it
spells once that maker has products, so re-read this listing when you rebuild
brand pages. A value that is not a published slug is matched by the
brand's name, as described next. Automatic-collection rules on `brand` resolve
their value the same way.

**Brand matching ignores case, spacing and punctuation.** A product's `brand` is
free text typed by whoever added it, and real catalogues accumulate spellings —
one live shop held 72 strings for 62 makers. So `?brand=` matches on identity,
not on the exact string: `Ray-Ban`, `Rayban`, `RAYBAN` and `ray-ban` (the slug
older WooCommerce imports stored on products) all return the same products, and
the listing shows them as one entry.

It never merges across a **word**, which is the distinction that matters:
`Solano Clips` and `SOLANO` stay separate, and so do `Tipi Diversi` and
`Tipi Diversi Clip`. Brands that merely look related are reported to the
operator in the admin, never merged automatically.

A **curated** entry (`curated: true`) is a row in the brands table, which adds a
logo, a stable `id` and translations. A derived entry has none of those — it is
not a record, and no id is invented for it. Both carry `count`. A curated record
describes the products its name names or, when its name names none, the
products its slug names — the shape older versions of the WooCommerce importer
wrote (`{ "name": "Ørgreen", "slug": "rgreen" }` over products branded
`rgreen`), which shops imported by them still hold.

The WooCommerce importer (`npm run import:woo`) stores each product's brand as
the shop spells it, in any script, and gives each brand record a transliterated
slug: `Όψη Οπτικά` arrives as products branded `Όψη Οπτικά` and a record with
the slug `opsi-optika`. WordPress's percent-encoded term slugs are decoded
first, so no brand is published as hex. Re-importing a shop imported the older
way creates no second record for a brand it already has, gives back the Greek
brands the older import left off its products, and files new products of a
brand under the slug the shop already uses for it — so each brand is still
listed once, and its published slug does not change.

### Caching

The public read endpoints send shared-cache headers to **anonymous** callers:

| Endpoint |
| --- |
| `GET /api/products`, `GET /api/products/{ref}` |
| `GET /api/brands`, `GET /api/product-categories` |
| `GET /api/search` |
| `GET /sitemap.xml`, `GET /rss.xml` |

```
Cache-Control: public, max-age=0, s-maxage=30, stale-while-revalidate=300
Vary: Cookie, Authorization
ETag: W/"…"
```

- `s-maxage` applies to **shared** caches (a CDN, nginx `proxy_cache`) only.
  `max-age=0` makes a browser revalidate every time, and the ETag turns that
  into a bodiless `304` when nothing changed. Send `If-None-Match` from a
  server-side fetch too — it saves the body on every unchanged list.
- **A signed-in session or an API key** gets `Cache-Control: private, no-store`
  and no ETag. Those responses can include drafts and staff-only fields, and
  must never be stored where someone else could be served them.
- Errors (`4xx`/`5xx`) get no caching headers.
- `?locale=` is part of the URL, so it is already part of every cache key.
  Nothing on these routes varies on `Accept-Language`.

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `PUBLIC_API_CACHE_SECONDS` | `30` | `s-maxage`. **`0` turns shared caching off** (`private, no-cache`; the ETag still works). Max 86400. |
| `PUBLIC_API_CACHE_SWR_SECONDS` | `300` | `stale-while-revalidate`. `0` omits it. |

**Configure the CDN to bypass its cache** for any request that carries the
session cookie (`astrobaas_session`) or an `Authorization` header. Many CDNs
(Cloudflare among them) ignore `Vary: Cookie`, and on allow-listed cross-origin
requests the CORS step replaces `Vary` with `Origin`. A bypass rule is the only
thing that holds on every CDN.

If neither `public_site_url` nor `site_url` is set, `meta.media_base` is derived
from the request's host and scheme. Every CDN keys on those already, but set one
of the two settings before putting a shared cache in front of the API.

**OG cards** (`/og/{slug}.png`) keep `Cache-Control: public, max-age=86400` and
now carry an ETag. They are rendered once per picture and kept in memory (the
100 most recent), so a query string on the URL costs nothing — but it still
makes a separate CDN entry, so link the card without one. A draft's card, which
only its author can see, is `private, no-store`.

### Email-capture forms and per-address limits

`POST /api/newsletter` and `POST /api/products/{ref}/notify-me` are anonymous,
and both are limited **per address** as well as per IP:

- **Newsletter:** at most **one confirmation email per address per day**. A
  second signup the same day answers exactly like the first (`201`, "Check your
  email…") and sends nothing — the link in the first email is valid for a week.
- **Notify-me:** at most **ten signups per address per day**; past that the
  answer is the same `200` and nothing is stored. Notify-me also has its own
  per-IP bucket now, so it no longer shares one with the newsletter form.

An address is counted under one spelling: case, a `+tag`, and — at Gmail — dots
do not make a new address. The mail still goes to the address as typed.
Back-in-stock emails go out in batches (50 per scheduler tick by default,
oldest request first); the rest follow on later ticks.

## 4. The typed SDK (`astrobaas/client`)

> **Not installable from npm yet.** `astrobaas` is not published to the
> registry, so `npm install astrobaas` in a separate frontend project will 404.
> Two things work today:
>
> - **Inside this repo**, `astrobaas/client` resolves to source via tsconfig
>   paths — every example below runs as written.
> - **From another project**, either call the REST API directly (§2 and §3; it
>   is plain HTTP and JSON, and `/openapi.json` describes all of it), or build a
>   local tarball: `npm run build:pkg && npm pack`, then
>   `npm install ../astrobaas/astrobaas-0.1.0.tgz`.
>
> The SDK is a convenience over the same endpoints, not a requirement — nothing
> in the API needs it.

The package ships built JS + `.d.ts` for `astrobaas/client` (and `/core`,
`/plugins`); the client bundle is dependency-free. Skip hand-rolling fetch +
envelope unwrapping + error handling:

```ts
import { createClient, AstroBaasError } from 'astrobaas/client';

const baas = createClient('https://cms.example.com', {
  apiKey: process.env.ASTROBAAS_KEY,        // omit for anonymous reads
  timeoutMs: 10_000,                         // abort slow requests (optional)
  retries: 2,                                // retry 429/5xx with backoff (optional)
});

// Pagination + auto-pagination
const page = await baas.posts.page({ limit: 20, page: 2 });   // { items, total, hasMore, … }
const everyPublished = await baas.posts.listAll({ status: 'published' });

// Reads
const posts = await baas.posts.list({ status: 'published', limit: 10 });
const post  = await baas.posts.get('hello-world');

// Writes (needs a key with the right role)
const draft = await baas.posts.create({ title: 'From the SDK', status: 'draft' });
await baas.posts.update(draft.id, { status: 'published' });   // by id or slug
await baas.posts.remove(draft.id);

// Custom content types
const products = baas.content('product');
await products.create({ name: 'Widget', price: 9 });
await products.update(id, { name: 'Widget v2', price: 12 });

// Introspect / admin
const me = await baas.auth.me();             // { id, role, type: 'apikey' | 'user' }

try {
  await baas.posts.create({ title: 'x' });
} catch (e) {
  if (e instanceof AstroBaasError) console.error(e.status, e.code, e.message);
}
```

Each method returns the unwrapped `data` and throws `AstroBaasError(status,
code, details)` on failure. The client is isomorphic (global `fetch`; Node 18+,
Deno, browsers) and dependency-free; pass `options.fetch` for SSR/tests, and
`setApiKey(key)` to rotate the credential at runtime.

## 5. Webhooks

Get notified when content changes instead of polling. Register a receiver
(admin):

```bash
curl -X POST https://cms.example.com/api/webhooks \
  -H "Authorization: Bearer $ADMIN_KEY" -H 'Content-Type: application/json' \
  -d '{"url":"https://hooks.example.com/astrobaas","events":["post.*","content.created"]}'
# → data.secret is returned ONCE — store it to verify deliveries.
```

Events: `post.created`, `post.updated`, `post.deleted`, `content.created`,
`content.updated`, `content.deleted`. Subscribe to `"*"` for all or a
`"prefix.*"` wildcard. With the SDK: `baas.webhooks.register({ url, events })`.

Each delivery is a `POST` with headers `X-AstroBaaS-Event`,
`X-AstroBaaS-Timestamp`, and `X-AstroBaaS-Signature: sha256=<hex>` where
`hex = HMAC-SHA256(secret, rawBody)`. Verify it with the SDK helper (universal /
WebCrypto, constant-time) — pass the **raw** body bytes:

```ts
import { verifyWebhookSignature } from 'astrobaas/client';

// e.g. in an Express handler with the raw body captured
const ok = await verifyWebhookSignature(secret, rawBody, req.header('x-astrobaas-signature'));
if (!ok) return res.status(401).end();
// Optionally reject stale deliveries using the X-AstroBaaS-Timestamp header.
```

**Durability.** A failed delivery is retried with backoff
(`WEBHOOK_RETRY_DELAYS_MS`, default 30s/2m/10m) and every attempt is recorded in
a delivery log. Inspect it at `GET /api/webhooks/deliveries` (or
`baas.webhooks.deliveries()`), and re-send any delivery with
`POST /api/webhooks/deliveries/{id}/redeliver` (`baas.webhooks.redeliver(id)`).
Retries run on in-process timers, so they don't survive a restart — use
redelivery to recover anything left `pending`/`failed`.

### Or poll: the change feed (ISR / revalidation)

Webhooks need a receiver that is always up. A statically generated storefront
usually has a scheduled job instead, and for that there is a feed:
`GET /api/content/changes` — **anonymous**, newest first, one bounded page at a
time. Poll it, and revalidate what it lists.

| Parameter | Meaning |
| --- | --- |
| `since` | Only changes strictly **after** this instant. Any ISO-8601 form; one with no zone designator (`2026-09-11T10:00:00`) is UTC. Optional — omit it and you get the newest page, never a 400. |
| `limit` | Page size, `1`–`1000`. Defaults to `1000`. Out-of-range values are clamped, not refused. |
| `cursor` | `meta.next_cursor` from the previous page, passed back **unchanged**. A malformed cursor is a `400`. |

Each entry, as an anonymous caller (or any non-editorial role) sees it:

```jsonc
{ "id": "…", "entity_type": "product", "entity_id": "…", "action": "update",
  "timestamp": "2026-09-11T10:04:05.123Z",
  "fields": ["price_cents", "stock"] }   // updates only, when known
```

and `meta` carries `since` (as you sent it), `count`, `now`, `limit`,
`has_more`, `next_cursor` (`null` on the last page) and `truncated`.

**The contract.**

- **Order is `(timestamp, id)`, descending.** The id breaks ties, so the order is
  total even when a bulk import writes hundreds of changes in one millisecond,
  and the same request returns the same order every time.
- **Pages walk older.** Follow `next_cursor` while `has_more` is true. Within one
  walk no change appears twice. Changes recorded *during* the walk are newer
  than page one, so your next poll picks them up. Retention does not pause for
  you, though: every write evicts the oldest entry, so on a busy install entries
  at the **old end** of your window can be pruned while you walk, before you
  reach them. `truncated` on the last page tells you when that happened.
- **Use the newest `timestamp` you processed as your next `since`** — not
  `meta.now`. A change stamped a moment before `now` can commit a moment after
  the read. And overlap a little (a second is plenty): revalidating something
  twice costs nothing, missing a change that landed in the same millisecond as
  your bound leaves a stale page nobody notices.
- **At most 1,000 changes are retained**, on every storage driver — counting
  every type, including the ones you are not shown. A job that has been down
  long enough for more than that to happen, or that runs after a bulk import
  larger than that, cannot catch up from the feed, and **`meta.truncated` is
  how it finds out**: `true` when retention has evicted a change you would have
  been shown that falls inside your window — after your `since`, or anywhere in
  history when you sent none (so without `since` it is `true` on any install
  that has ever evicted something you could see: poll with `since`). Read it
  from the **last page** of a walk — it is evaluated on every page, so the last
  one also covers pruning during the walk — and when it is `true`, revalidate
  everything. Counting what you received cannot tell you: the 1,000 includes
  types hidden from you, so a window that overflowed can hand you far fewer
  than 1,000, or none at all.
- **`fields` absent means "unknown", never "nothing".** Treat it as "assume
  everything changed". It is only ever recorded on updates, and is never shown
  for users.
- **Orders are not in the public feed.** An anonymous or non-editorial caller
  never sees an `order` entry, not even its id: the ids and timestamps alone are
  the shop's order volume, and nothing a storefront renders depends on an order.
  Staff with an editorial role still see them.
- **A client that has never heard of paging keeps working.** The default page is
  the whole retention window, so a poller that sends only `since` and ignores
  `meta` receives exactly what it received before paging existed.

**What an anonymous caller sees, and does not.** Metadata only — never the
record's content. Only types it could read anyway: posts, pages, categories,
themes and settings; products and orders **while the shop is switched on**; and
custom collections declared `visibility: "public"`. A staff-only collection — a
public *form*, which anyone may submit and only staff may read — never appears,
not even as an id and a timestamp, because the timing and volume of submissions
is exactly what its visibility withholds. An `editor` or `admin` key sees every
type and each entry's `changes` snapshot too.

A worked Next.js example — a route your scheduler calls, revalidating by tag:

```ts
// app/api/cms-revalidate/route.ts — call it from Vercel Cron or any scheduler.
import { revalidatePath, revalidateTag } from 'next/cache';

const CMS = process.env.ASTROBAAS_URL!;
// Persist this (KV, a file, your database) — a module variable is lost on
// every cold start, which only means one wider-than-needed first poll.
let since: string | undefined;

export async function GET() {
  // Ask from a second earlier than the newest change already handled.
  const from = since ? new Date(Date.parse(since) - 1000).toISOString() : undefined;
  let newest = since;
  let cursor: string | null = null;
  let truncated = false;
  // No page cap: at most 1,000 changes are retained, so this is at most five
  // requests, and changes recorded meanwhile land ahead of the cursor, never
  // behind it.
  do {
    const qs = new URLSearchParams({ limit: '200' });
    if (from) qs.set('since', from);
    if (cursor) qs.set('cursor', cursor);
    const res = await fetch(`${CMS}/api/content/changes?${qs}`, { cache: 'no-store' });
    // A failed page — a 429 from the per-IP rate limit, a deploy — ends this
    // run WITHOUT moving `since`. Pages walk newest to oldest, so the pages not
    // read yet are older than `newest`: advancing past them would skip them
    // for good. The next run walks again; revalidating twice is harmless.
    if (!res.ok) return Response.json({ ok: false, status: res.status }, { status: 502 });
    const { data, meta } = await res.json();
    for (const change of data) {
      revalidateTag(`${change.entity_type}:${change.entity_id}`);
      if (!newest || change.timestamp > newest) newest = change.timestamp;
    }
    truncated = meta.truncated === true; // the last page's value is the one that counts
    cursor = meta.has_more ? meta.next_cursor : null;
  } while (cursor);
  // Retention evicted something inside the window, and the feed cannot say what.
  if (truncated) revalidatePath('/', 'layout');
  // Only now, after a complete walk, does `since` move.
  since = newest;
  return Response.json({ ok: true, since, truncated });
}
```

…with the storefront's own reads tagged to match:

```ts
const product = await fetch(`${CMS}/api/products/${slug}`, {
  next: { tags: [`product:${id}`] },
});
```

## 6. AI agents (MCP + llms.txt)

Two ways an AI agent can use AstroBaaS:

- **Just read the contract.** `GET /llms.txt` is a plain-text brief (base URL,
  auth schemes, endpoints); `GET /openapi.json` is the OpenAPI 3.1 spec with a
  `bearerApiKey` scheme. Both are public.
- **Operate it as MCP tools.** Run the bundled MCP server so an agent can call
  **33 tools** covering posts, custom content, the catalogue, orders, customers,
  media, settings and plugins — `whoami`, the `*_post` and `*_content` CRUD
  sets, `list_products`/`create_product`/`update_product`/`delete_product`,
  `list_orders`/`get_order`/`set_order_status`, `get_settings`/`update_settings`
  and `search` among them — and browse **published posts as MCP resources** (`astrobaas://post/<slug>`). On startup it probes the key and logs
  the resolved role (or a warning) to stderr. Example Claude Desktop config:

  ```jsonc
  {
    "mcpServers": {
      "astrobaas": {
        "command": "npx",
        "args": ["-y", "astrobaas-mcp"],
        "env": {
          "ASTROBAAS_URL": "https://cms.example.com",
          "ASTROBAAS_KEY": "abk_..."
        }
      }
    }
  }
  ```

  It speaks stdio JSON-RPC (the MCP standard) and is dependency-free.

## 7. Embeddable AI assistant widget

Put the chat bubble on **any** site with one script tag — no build step, no
framework, no npm install:

```html
<script src="https://cms.example.com/assistant-widget.js"
        data-color="#e11d48"
        data-position="bottom-left"
        data-title="Ask us"
        data-greeting="Hi! What are you looking for?"
        defer></script>
```

| Attribute | Default | Notes |
| --- | --- | --- |
| `data-color` | `#2563eb` | Launcher, header and sent bubbles |
| `data-text-color` | `#ffffff` | Text on `data-color` |
| `data-position` | `bottom-right` | or `bottom-left` |
| `data-title` | from Settings | Header text |
| `data-greeting` | from Settings | First message |
| `data-launcher` | `💬` | Any character or emoji |
| `data-z-index` | `2147483000` | Raise if your header covers it |
| `data-require-consent` | `false` | Do not mount until you call the API below |

The host page keeps control:

```js
AstroBaaSAssistant.mount();    // after your own consent tool resolves
AstroBaaSAssistant.open();     // e.g. from your own "Chat with us" button
AstroBaaSAssistant.close();
AstroBaaSAssistant.destroy();
```

**Allow-list the host origin** in `CORS_ORIGINS` (see §2) — the widget will not
work otherwise, by design.

### Why this is safe to expose cross-origin

The widget never holds your API key. It POSTs to `/api/assistant/chat` on the
AstroBaaS origin, and the server forwards the request with the credential.

That POST is exempt from the usual CSRF double-submit check, which is worth
spelling out because "we turned off CSRF for this endpoint" deserves scrutiny.
The exemption applies only when **both** hold:

1. **The request carries no session cookie.** The widget sends
   `credentials: 'omit'`, so there is no ambient authority to ride — an attacker
   gains nothing they could not already do with `curl`. If a session cookie *is*
   present, CSRF applies in full, so no page can drive this endpoint using a
   signed-in admin's session.
2. **`Origin` is in `CORS_ORIGINS`.** Browsers set this on cross-origin POSTs
   and page JavaScript cannot forge it, so embedding stays limited to sites you
   named.

Condition 1 is the load-bearing one; this is the same reasoning that already
exempts bearer-token requests. The endpoint remains public, rate-limited per IP,
and length-bounded either way. The smoke suite asserts all four cases —
allow-listed, non-allow-listed, no-Origin, and cookie-bearing.

### Consent

The widget does **not** render a consent banner on your site — that is yours to
run, and a second banner would collide with it. Set
`data-require-consent="true"` and call `AstroBaaSAssistant.mount()` when your own
tool grants the relevant category.

(The bubble on AstroBaaS's *own* pages is a separate, first-party path: activate
the **AI Assistant** plugin, and it honours the built-in consent banner.)

### CSP on the host site

Nothing is inlined as script and no inline `style=` attributes are used, so a
strict host policy needs only:

```
script-src https://cms.example.com;
connect-src https://cms.example.com;
```

Styles are injected into one `<style>` element the widget creates (an external
page never loads `/plugins.css`), so a host with a strict `style-src` needs
`'unsafe-inline'` there or the element's hash.

### Daily limits

Every message is billed to your provider account, so the public chat has two
daily ceilings, set in Settings (keys shown):

| Setting | Default | Meaning |
| --- | --- | --- |
| `assistant_daily_message_cap` | `500` | Messages per day across the whole site |
| `assistant_daily_ip_cap` | `50` | Messages per day from one client IP |

`0` switches a ceiling off. Past either one the chat answers `429` in its usual
error envelope, with a `Retry-After`, and the widget shows the message
("The assistant has answered all the questions it can for today…"). The
provider is not called. Each message is already bounded (4000 characters, 20
turns of history, an 800-token reply), so a message ceiling is a token ceiling.

### When it says "unavailable"

Provider failures are logged server-side with the status and the provider's own
message, credentials redacted — `grep '\[assistant\]'` in your logs. The most
recent failure is also shown in **Settings → AI assistant**, and clears on the
next successful reply.

## 8. The CLI

Inside the clone, npx resolves these from this package's own `bin` entries.
Anywhere else, npx fetches them from npm: `astrobaas` is published under the
`alpha` tag (`npx astrobaas@alpha …`), and the MCP server is its own
zero-dependency package, `astrobaas-mcp`, so an MCP client config can name it
on a machine with no AstroBaaS installed.

```bash
npx astrobaas init      # write .env with a CSPRNG AUTH_SECRET (then: npm install)
npx astrobaas secret    # print a fresh 32-byte secret to stdout
npx astrobaas setup      # create/replace the admin account
npx astrobaas-mcp        # start the MCP server (configure via env, see above)
```

`init` refuses to overwrite an existing `.env` without `--force`.

---

See [STABILITY.md](./STABILITY.md) for what's covered by the API-stability
promise, [STORAGE.md](./STORAGE.md) for durable persistence, and
[SECURITY.md](./SECURITY.md) for the security model.
