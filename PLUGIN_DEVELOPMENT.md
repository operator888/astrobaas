# Plugin development

AstroBaaS has **two plugin tiers**. Pick by what you need to do:

| | **Code plugins** (bundled) | **Declarative plugins** (manifest) |
|---|---|---|
| What it is | A TypeScript module | A JSON manifest |
| Installed by | Adding an import + rebuilding | Uploading / registry, **at runtime** |
| Can run logic | ✅ any filter/action | ❌ none — it is data |
| Can add | anything | meta/link tags, CSS, content types, webhooks |
| Privileges | full application privileges | **none** — nothing is executed |
| Best for | developers, AI agents | operators who can't redeploy |

Both tiers share one registry, one activation model, and one admin screen.

**Code plugins** are small, trusted, in-process TypeScript modules bundled with
the app. They extend behaviour through **filters** (transform a value) and
**actions** (fire-and-forget side effects). Activation state is persisted in the
database, so a server restart preserves what the operator turned on.

> Code plugins run with full application privileges — there is no sandbox. Only
> install ones you trust. This fits AstroBaaS's single-node, self-hosted model.
> Declarative plugins carry no such warning precisely because they cannot execute.

Jump to: [Declarative plugins](#declarative-plugins-runtime-installable).

## Anatomy of a plugin

Create a folder under `src/plugins/<your-id>/` with an `index.ts` that
default-exports a plugin via `definePlugin()`. Import everything from the stable
**`astrobaas/core`** barrel — never from internal `src/lib/*` paths:

```ts
import { definePlugin, PLUGIN_HOOKS } from 'astrobaas/core';
import type { Post } from 'astrobaas/core';

export default definePlugin({
  id: 'my-plugin',            // stable, unique, kebab-case
  name: 'My Plugin',
  version: '1.0.0',
  description: 'What it does.',
  author: 'You',
  filters: {
    [PLUGIN_HOOKS.POST_CONTENT]: (html: string, post?: Post) => html + '<p>Hi</p>',
  },
  actions: {
    [PLUGIN_HOOKS.AFTER_POST_SAVE]: (post: Post) => console.log('saved', post.id),
  },
  activate() {/* optional one-time setup */},
  deactivate() {/* optional teardown */},
});
```

Then register it in `src/plugins/index.ts` — **one import, one array entry**.
Do not paste the array over: it already carries every bundled plugin (eight at
the time of writing), and replacing it uninstalls the rest.

```ts
import myPlugin from './my-plugin';                    // add this line
export const BUNDLED_PLUGINS: Plugin[] = [
  readingTime, draftWatermark, productCatalog, printStyles, smtp2go,
  consentBanner, aiAssistant, popups,
  myPlugin,                                            // ...and this one
];
```

`definePlugin()` is an identity helper (like Astro's `defineConfig`) that gives
you full hook type-checking. `astrobaas/core` is the **only** import surface
covered by the project's stability guarantees — see [STABILITY.md](./STABILITY.md).

That's it — it appears under **Admin → Plugins**, where it can be activated. The
choice is saved to the `plugins` table and replayed on the next boot by
`pluginManager.bootstrap()`.

## Hook catalog

Hook names live in `PLUGIN_HOOKS` (exported from `astrobaas/core`) — always use the
constants, never raw strings, so they can't drift.

| Constant | Kind | Signature | Notes |
| --- | --- | --- | --- |
| `API_POSTS_GET` | filter | `(posts: Post[]) => Post[]` | **One page** of `GET /api/posts`, already filtered and paginated by the storage layer — visibility included. See "`api_posts_get` receives a PAGE" below. |
| `POST_CONTENT` | filter | `(html: string, post: Post) => string` | Post body HTML. **Re-sanitized after filters** before render, so you cannot inject script. |
| `POST_TITLE` | filter | `(title: string, post: Post) => string` | Post title (rendered as text). |
| `BEFORE_POST_SAVE` | filter | `(post, ctx: { isNew: boolean }) => post` | Mutate/validate post fields just before create or update. Content is sanitized **after** this hook; `author_id` is always overridden by the session. |
| `AFTER_POST_SAVE` | action | `(post: Post) => void` | Fires after a post is created **or** updated. |
| `AFTER_POST_DELETE` | action | `(post: Post) => void` | Fires after a post is deleted. |
| `ROBOTS_GROUPS` | filter | `(groups: RobotsGroup[], ctx: { origin: string }) => RobotsGroup[]` | Per-crawler groups for `robots.txt`. The initial value is the operator's own choices, built from the `crawler_policy` setting — **add to what you are handed**, because replacing the array discards them. `RobotsGroup` is `{ agents: string[], allow?, disallow?, crawlDelay?, source? }` (`src/lib/robots-txt.ts`). The `discourage` kill switch outranks everything, including this. |
| `CRAWLER_POLICY` | filter | `(verdict: { block: boolean; reason?: string }, ctx: { userAgent, path }) => verdict` | Enforcement, which `robots.txt` only requests. Called on every **public** page request (not `/admin`, not `/api/`); the initial value is `{ block: false }` and core ships no blocklist. Returning `{ block: true }` answers **403** with `reason` as the body. A filter that throws here is swallowed — a policy plugin must never take the site down. |
| `HEAD_TAGS` | filter | `(html: string, ctx: { pathname: string }) => string` | Append markup to `<head>` on public pages. Sanitized to `meta`/`link` only — **no `<script>`, and no `<style>`** (use `PLUGIN_STYLES`). |
| `PLUGIN_STYLES` | filter | `(css: string, ctx: { pathname: string }) => string` | Append CSS for public pages. All active plugins' CSS is concatenated and served from `/plugins.css`. |

Filters run in activation order; each receives the previous filter's output. A
filter that throws is skipped (its input passes through) and the error is logged.

### Commerce hooks

The same table, for shops. Everything money-shaped is integer **cents**.

| Constant | Kind | Signature | Notes |
| --- | --- | --- | --- |
| `API_PRODUCTS_GET` | filter | `(products: Product[]) => Product[]` | Full product list, before filtering and pagination. |
| `SEARCH_EXPAND` | filter | `(expander: TermExpander \| null, ctx: { products, query, settings }) => TermExpander \| null` | Contribute alternative spellings for a search term — Greeklish, typos, synonyms. The core keeps ownership of **relevance** (`lib/search/rank.ts`); this only says what a term may *also* mean, and is consulted **only when the literal term matched nothing**, memoised once per query. **The initial value is not `null`:** core seeds it with the operator's own synonym table from the `search_synonyms` setting (`src/lib/search/expander.ts`), so returning `null` throws that configuration away. **Compose with the expander you are handed** — fall back to it for terms you do not recognise, and return it unchanged when you have nothing to add. `null` is only correct when you were handed `null`. `ctx.settings` holds every `search_*` setting, read by the call site and passed in, because `applyFilters` is synchronous and settings reads are not. |
| `BEFORE_PRODUCT_SAVE` | filter | `(product, ctx: { isNew }) => product` | Just before persist. Description HTML is sanitized **after** this filter. |
| `AFTER_PRODUCT_SAVE` | action | `(product: Product) => void` | After create **or** update. |
| `AFTER_PRODUCT_DELETE` | action | `(product: Product) => void` | After delete. |
| `PRODUCT_PRICE` | filter | `(priceCents, product, ctx: { qty, variant }) => number` | The unit price — sales rules, volume discounts, member pricing. Applied in `priceBasket`, so the quote, the order's totals and its stored lines all use it (before 2026-10 only the stored lines did, and they disagreed with the order total). `ctx.variant` is the `ResolvedPurchasable` this line is buying (`price_cents`, `sku`, `stock`, and `variant_id` / `options` on a variable product), so a rule can price one size differently from another. `priceCents` is already `ctx.variant.price_cents`. Must return **integer cents**; anything else fails the checkout with a 500 rather than charging a guess. |
| `BEFORE_ORDER_SAVE` | filter | `(order, ctx: { isNew }) => order` | Before an order persists (checkout or admin edit). Validation runs **before** this hook; totals are re-checked **after** it. |
| `AFTER_ORDER_CREATE` | action | `(order: Order) => void` | Checkout completed. The hook the new-sale notifier uses. |
| `AFTER_ORDER_STATUS_CHANGE` | action | `(order, previousStatus) => void` | After a status change, with the status it left. |
| `SCHEDULER_TICK` | action | `({ now }) => void \| Promise<void>` | Once per scheduler sweep (about a minute) on the process holding the scheduler lease — once per database, not per replica. For work that is due on a **date** rather than a request: recurring invoices, expiring trials, digests. The sweep **awaits** every handler (errors isolated and logged), so a slow handler delays the next sweep instead of overlapping it; do real work only when it is due and make it idempotent. Active plugins only. |
| `ORDER_LINE_EXTRAS` | filter | `(result, ctx: { line, product, name }) => result` | **The vertical's extension point.** Return `{ ok: true, patch }` to accept (patch is frozen onto the stored line) or `{ ok: false, message, code?, params? }` to refuse the whole order with a 400. `message` is the English fallback; `code` is a stable machine-readable reason (`optical.prescription_required`) and `params` the values a storefront needs to build its own sentence — both optional, so a plugin built before they existed keeps working, and both are how a refusal gets translated at all (core returns `message` verbatim and the plugin is not in this repository). **If the incoming value is already `ok: false`, return it unchanged** — a refusal must survive later plugins. With no plugin registered the initial value passes through, so an install without your module accepts the order and stores the raw data instead of 500ing. |
| `COMMERCE_SCHEMA` | filter | `(schema, ctx: { name, variant? }) => schema` | Publish a machine-readable schema for a storefront form (this is how the optical module serves `/api/commerce/prescription-schema`). Initial value is `null`; return it **unchanged** for names you don't recognise. Core answers 404 while it stays null — which is also what an install without the module should look like. |
| `PAYMENT_PROVIDERS` | filter | `(providers: PaymentProvider[]) => PaymentProvider[]` | Contribute payment gateways. Collected once at bootstrap from **active** plugins only. See "Payment providers from a plugin" below. |
| `MANUAL_METHODS` | filter | `(methods: ManualMethodDef[]) => ManualMethodDef[]` | Contribute manual (offline) payment methods. A manual id that shadows a gateway id is **refused** — otherwise a shop could accept as unpaid what it believes was charged. |
| `PRODUCT_FIELD_DEFS` | filter | `(defs: unknown[]) => unknown[]` | Declare product fields, exactly like a merchant's under Settings → Product fields. Initial value `[]`; **append** to what you are handed. See "Product fields from a plugin" below. |
| `REVIEW_MEDIA` | filter | `(media: ReviewMedia[], ctx: { review: PublicReview; productId: string }) => ReviewMedia[]` | **The seam for photo and video reviews** — the paid part of product reviews. Core stores text only. Called once per APPROVED review in `GET /api/products/{ref}/reviews`, initial value `[]`; the result is attached as `media` only when non-empty. See "Product reviews: the media seam" below. |
| `AFTER_REVIEW_DELETE` | action | `(review: { id, product_id }, ctx: { reason: 'deleted' \| 'erased' }) => void` | A review was deleted by a moderator or deleted/anonymised by a GDPR erasure. A media module **must** drop what it stored for that id here. |

### Product reviews: the media seam

Product reviews (C-35) are a built-in collection, `review`, switched on with the
`reviews_enabled` setting. Core owns the text review: the public submit and read
routes (`/api/products/{ref}/reviews`), the server-computed `verified_buyer`
stamp, moderation (`/admin/reviews`, `/api/reviews`, `/api/reviews/moderate`) and
the GDPR export and erasure. **Photos and video are not in core** — no upload, no
storage, no transcoding, no media moderation. Two hooks are reserved for a paid
module that adds them:

- `REVIEW_MEDIA` (filter). Return the media for the review you are handed:
  `{ kind: 'image' | 'video', url, alt?, thumbnail_url? }[]`. Core passes your
  result through `sanitiseReviewMedia` (`src/lib/reviews.ts`): only `image` and
  `video`, only `http(s)` or root-relative URLs, at most 12 items, everything
  else dropped. Return what you were handed for a review that has no media.
- `AFTER_REVIEW_DELETE` (action). Delete your files for that review id. It fires
  for a moderator's delete AND for a data-subject erasure (`reason: 'erased'`),
  which anonymises a published review rather than deleting it — the photos of a
  person who asked to be forgotten must go either way.

Rules for the module:

- **Keep your own storage, keyed by review id.** Never write into the review
  record. The key `media` on a review is reserved; it is not a declared field,
  so nothing a submitter posts to the core route can land there.
- **Take uploads on your own route** (`/api/plugin/<id>/…`), behind the same
  public gate (`publicSubmissionGate`) and proof of work the core route uses,
  and keep anything not yet approved out of `REVIEW_MEDIA`'s answer — core only
  asks about approved reviews, but a module that publishes an unmoderated upload
  by another path bypasses the queue.
- **Every feature switchable on its own** in your settings, like every paid
  module.

### A field nobody outside staff may read: `private`

A field may declare `private: true` (in `registerContentType()`, a manifest's
`contentTypes[].fields[]`, or the admin builder's JSON). Its value is stored,
validated, exported in a subject-access request and erased like any other, but
it is **left out of every read by anyone who is not content staff** (admin or
editor), even when the collection is `visibility: 'public'`. The built-in
comment and review collections use it for the author's email address — before
it existed, the public list returned every commenter's address.
`projectEntityForReader()` in `src/core/content-types.ts` is the one projection
both content routes apply; use it in any route of yours that serves custom
entities.
| `TAX_ID_VERDICT` | filter | `(verdict: TaxIdVerdict, ctx: { taxId, country?, destination?, settings }) => TaxIdVerdict` | **Synchronous.** Say what you know about a buyer's VAT id so EU reverse charge can use it. Initial value `{ status: 'unchecked' }`. See "Tax-id verdicts" below. |
| `TAX_RATES` | filter | `(rates: TaxRate[], ctx: { settings }) => TaxRate[]` | **Synchronous.** Supply VAT rate rows (a maintained EU table, a regional pack). Handed a copy of the operator's rows; return them plus yours. The operator's rows always win. See "Tax rates from a plugin" below. |
| `ORDER_LINE_ADDONS` | filter | `(result: LineAddonsResult, ctx: { line, product, variant, qty, name, settings }) => LineAddonsResult` | **Synchronous.** Price add-ons on an order line (a lens coating, an engraving). Initial value `{ ok: true, addons: [] }`; append `{ id, label, unit_price_cents, source?, kind?, namespace? }`, or return `{ ok: false, message, code?, params? }` to refuse. Added to the unit price before coupons and tax, and frozen as `OrderItem.addons`. Fails closed. See "Priced add-ons on an order line" below. |

### Tax-id verdicts

`TAX_ID_VERDICT` is how a verifier — VIES, a national registry — tells the
core whether a buyer's VAT number is registered. The core never validates a tax
id itself (it is **captured, not validated**; see `Address.tax_id`), and no
verdict is itself a refusal. The only refusal reachable is the one any consumer
gets: `invalid` to a destination with no VAT rate on file (409).

A verdict can make a quote and the order after it differ: a cold cache answers
`unverified` (VAT quoted), and the order a few seconds later may find
`verified` (0 VAT). A storefront should re-quote after the buyer enters a VAT
number, and show the order's own totals as final.

**When it is called.** From `priceBasket`, so by `POST /api/orders/quote` and
by the order alike, once per pricing — and **only** where the answer could
change the tax: the shop has switched reverse charge on
(`tax_reverse_charge_enabled`), the destination is an EU country other than
the shop's (`shop_country`), and the buyer gave a non-empty tax id
(`billing_address.tax_id`, or the delivery address's as a fallback).

**What you are handed.** `ctx.taxId` is the number as the buyer entered it
(trimmed); `ctx.country` the ISO country it was entered next to (the billing
country), when there is one; `ctx.destination` the destination country;
`ctx.settings` every shop setting as a map, read by the call site because a
filter cannot await.

**What you return.**

```ts
type TaxIdVerdict = {
  status: 'unchecked' | 'verified' | 'invalid' | 'unverified';
  country?: string;            // ISO — 'GR', not 'EL'. Preferred over the typed prefix.
  vat_id?: string; reason?: string; source?: string;
  checked_at?: string; consultation_number?: string | null;
};
```

| Status | What the core does |
| --- | --- |
| `unchecked` | Nobody has an opinion: the core's shape check decides, exactly as with no plugin installed. |
| `verified` | Reverse charge, when `verdict.country` (or the typed prefix) is an EU state other than the shop's. |
| `invalid` | No reverse charge. The sale is taxed like a consumer's, and refused only if a consumer's would be (no rate on file for the destination). |
| `unverified` | No reverse charge where the destination's rate is on file. **Never a refusal:** where no rate is on file, the shape-only reverse charge applies instead of the 409 a consumer would get, because a lookup that did not answer is not a reason to lose a sale. |

Anything that is not one of those four (a Promise, a string, an unknown
status) is treated as `unchecked`. The verdict is recorded on the priced
treatment as `tax_id_status`; it is not written to the order — keep your own
evidence in your store (see `host.createStore`).

Rules:

- **It must be a cache read.** `applyFilters` is synchronous, and a checkout
  must not wait on a government web service even if it could. Start a lookup in
  the background on a miss and answer `unverified`; the order a few seconds
  later finds the result.
- **If the incoming value is already `invalid`, return it unchanged** — a
  refusal from one verifier must survive the next.
- Greek numbers are written `EL…`; the core compares on ISO `GR` everywhere
  (`EL` in the EU list or on a number is read as `GR`).

### Tax rates from a plugin

`TAX_RATES` is how a rate pack supplies the numbers the core's tax engine
looks up. The core decides WHOSE rate applies (domestic, destination, reverse
charge, export); the rows say what that rate is. Core ships no foreign rates.

**When it is called.** From `resolveTaxSettingsWithPlugins`
(`src/lib/commerce/tax-plugins.ts`), which every pricing path uses: the quote,
the order (both through `priceBasket`) and
`POST /api/orders/{id}/tax-override`. So the three cannot disagree about the
same sale. It is **not** called while tax is off or `shop_country` is unset:
without an origin every sale is domestic, and the domestic ladder is the
operator's.

**What you are handed.** A copy of the operator's normalised rows
(`TaxRate[]`: `class`, `label`, `rate_bp`, optional `country` and
`postcodes`), and `ctx.settings`, every shop setting as a map. Settings are
read by the call site because a filter cannot await.

**What you return.** The rows you were handed plus your own:

```ts
filters: {
  [PLUGIN_HOOKS.TAX_RATES]: (rates, ctx) =>
    enabled(ctx.settings) ? [...rates, { class: 'standard', label: 'DE', rate_bp: 1900, country: 'DE' }] : rates,
}
```

What the core does with it:

- **The operator's rows win.** They are kept, first and unchanged, even if
  you leave them out or edit your copy. A row of yours with the same country,
  class and postcodes as one of theirs is dropped.
- **Your rows go through the same normaliser** as the operator's: an invalid
  country (`Germany`), a rate outside 0 to 20000 bp, or a territory row none of
  whose postcodes is a recognised pattern is dropped. The operator's 50-row
  cap does not apply to plugin rows; their bound is 2000.
- **Every row of yours the core does not use is logged**, once per process,
  as `[astrobaas] TAX_RATES: a plugin-supplied rate row was not used (…)`.
- **Fail closed.** If any `TAX_RATES` filter throws, or the result is not an
  array (an `async` filter returns a Promise), the operator's rows are used
  alone and the error is logged. A destination with no row is then refused
  (409 `checkout.tax_not_configured`), never charged a guessed rate.
- **A foreign row is never a domestic rate.** Domestic lookups, including the
  fallback to the default class and the override's class check, read only the
  shop's own country's rows. A row for the shop's own country, **or a row with
  no `country` at all**, counts as domestic, so always set `country` and leave
  the shop's own country to the operator unless that is the point of your pack.
- Rows are matched on (country, class, postcodes). A special territory is a
  second row for the same country and class with `postcodes`, in the shipping
  zones' grammar (`35*`, `9000-9499`); a matching postcode row wins over the
  country-wide one.

Return the array you were handed, unchanged, when your pack is switched off.

### Priced add-ons on an order line

`ORDER_LINE_ADDONS` lets a plugin charge for options chosen on a line — the
optical module's coatings and lens index are the first user. The core does
not know what an option is; it checks the request's shape, asks you for a
price, and freezes what you answered.

**What the storefront sends.** A per-line `addons` object, keyed by a
namespace you own, on both `POST /api/orders/quote` and `POST /api/orders`:

```json
{ "product_id": "p1", "qty": 1, "addons": { "lens": ["ar", "index-160"] } }
```

Keys match `^[a-z][a-z0-9_-]{0,31}$`, at most 8 per line; each value is your
own format, JSON only, at most 4 levels deep, the whole object at most 2048
bytes. Anything else is refused with a 400 (`checkout.addons_invalid`) naming
the problem. `null`, `[]`, `{}` and `""` mean "nothing chosen".

**When it is called.** Once per line, inside `priceBasket`
(`src/lib/commerce/pricing-service.ts`), which both the quote and the order
use — so they price the same add-ons. `ctx.line` is a copy of the request line
as posted (its `prescription` in display units, never the stored-units copy
`ORDER_LINE_EXTRAS` returns); `ctx.product` and `ctx.variant` are what the
line resolved to; `ctx.settings` is every shop setting, read by the call site
because a filter cannot await. It is called for every line, with or without a
selection: return the incoming value unchanged when there is nothing for you.

**What you return.**

```ts
filters: {
  [PLUGIN_HOOKS.ORDER_LINE_ADDONS]: (current, ctx) => {
    if (!current.ok) return current;                 // a refusal must survive
    const ids = ctx.line?.addons?.engraving;
    if (!ids) return current;
    return { ok: true, addons: [...current.addons,
      { id: 'engrave', label: 'Engraving', unit_price_cents: 900, source: 'my-plugin', namespace: 'engraving' }] };
  },
}
```

What the core does with it:

- The sum of `unit_price_cents` is added to the line's unit price (after
  `PRODUCT_PRICE`) **before** coupons, the free-shipping threshold and tax, so
  every total sees it. Whether coupons may discount add-ons is one constant,
  `COUPONS_DISCOUNT_ADDONS` in `src/lib/commerce/line-addons.ts` (currently
  yes: an add-on is part of the line's price).
- The order freezes the line total **and** the add-ons from that same priced
  line: `OrderItem.addons` holds `{ id, label, unit_price_cents, source?,
  kind?, namespace? }` per add-on, in the order's currency, already inside
  `total_cents`. The receipt, its PDF, the confirmation email and the admin
  order list print them. The quote returns them on `lines[].addons`.
- `{ ok: false, message, code?, params? }` refuses the quote and the order
  with a 400 carrying your `code` and `params`.
- **Fail closed** — never charged without the add-on, never the add-on
  without the charge:
  - a selection sent while no plugin registers the hook: 400
    `checkout.addons_unsupported`;
  - a selection that came back with no add-on: 400 `checkout.addons_unpriced`
    (a filter that ignored it, or a selection of blank ids). Set `namespace`
    on your add-ons and the core checks
    each key of a multi-key selection separately; untagged add-ons answer the
    selection as a whole;
  - a filter that throws (which plain `applyFilters` would swallow, keeping
    the value from before it), returns a Promise, or returns a malformed result or
    add-on (an id or label missing, a price that is not a non-negative
    integer): 500 `checkout.addons_failed`, logged as
    `[astrobaas] ORDER_LINE_ADDONS: …`. Nothing is placed or reserved.
- `label` is printed on receipts and kept with the order through a GDPR
  erasure (order lines are accounting records). Never put personal data in
  it — not engraving text, not a name; keep that in your own store.
- An add-on priced at 0 is still an add-on: return it with `unit_price_cents:
  0`, so the selection is recorded rather than refused as unpriced.
| `INVOICE_ISSUERS` | filter | `(issuers: InvoiceIssuer[], ctx: { settings }) => InvoiceIssuer[]` | Register an invoice **issuer** (a myDATA provider, a Peppol access point, a ΦΗΜ bridge). Initial value `[]`; **append** to what you are handed. See "Invoice issuers from a plugin" below. |

### Invoice issuers from a plugin

Core keeps a frozen, **non-fiscal** invoice record per order and a credit-memo
record per refund (`src/lib/commerce/invoice-records.ts`): the lines, the VAT per
rate as charged, the seller and the buyer with `tax_id`, the currency. It never
issues a legal document — AstroBaaS is not a fiscal device. An issuer does:

```ts
import { PLUGIN_HOOKS, type Plugin, type InvoiceDocument, type InvoiceIssueContext } from 'astrobaas/core';

const myIssuer = {
  id: 'my-provider',            // lower-case letters, digits, '-'; stored on every record
  label: 'My Provider',
  // Called ONCE per final record (invoice or credit memo). MUST be idempotent on
  // ctx.key: a retry (a person, or the background sweep) sends the same key,
  // and only you can know whether the first call reached the authority.
  async issue(doc: InvoiceDocument, ctx: InvoiceIssueContext) {
    if (!servesThis(doc, ctx.settings)) return { ok: false, declined: true, reason: 'retail is switched off' };
    const res = await send(doc, { idempotencyKey: ctx.key });   // your API, your credentials
    if (res.unavailable) return { ok: false, error: res.message, retryable: true };
    if (!res.ok) return { ok: false, error: res.message };       // shown on the record
    return { ok: true, number: res.documentNumber, identifiers: { mark: res.mark, qr: res.qrUrl } };
  },
};

export default {
  id: 'my-provider-pack', name: 'My Provider', version: '1.0.0', description: '', author: '',
  filters: {
    // ctx.settings: every setting, read by core. Leave yourself off the list
    // while your own switch is off — no cache, no timer.
    [PLUGIN_HOOKS.INVOICE_ISSUERS]: (list, ctx) => (ctx?.settings?.my_provider_enabled === true ? [...list, myIssuer] : list),
  },
} satisfies Plugin;
```

**What `issue()` is handed** — `ctx: InvoiceIssueContext`:

| Field | What it is |
|---|---|
| `order` | A copy of the order. |
| `invoice` | For a credit memo: the invoice record it credits. |
| `settings` | Every setting, read by core (a copy). |
| `key` | `astrobaas:<record id>` — the same on every attempt at this record. Send it to your provider as its idempotency key. |
| `attempt` | 1 on the first call to you for this record, 2 on the first retry … |
| `reportLateSuccess({ number?, identifiers? })` | Tell core about a success that arrived after it stopped waiting. See below. |

**What it answers** — exactly one of:

| Answer | Meaning | What the record shows |
|---|---|---|
| `{ ok: true, number?, identifiers? }` | Issued. | `issued`, your number as the document number. |
| `{ ok: false, error, retryable?: true }` | You tried and failed. `retryable` says a later call under the same key may succeed. | `issue failed` with `error`; with `retryable`, the next automatic attempt. |
| `{ ok: false, declined: true, reason }` | **"Not mine."** You do not issue this record, and sent nothing anywhere. | Not a failure: see below. |

- Core **claims** the record (`issuer.status: 'issuing'`) with a compare-and-set
  before calling you, so two finalisations at once — or two sweeps — call you
  once; it stores your answer only over its own claim.
- `number` is printed on the PDF as the document number; it is the only invoice
  number a record ever shows. String `identifiers` (at most 20) are kept and
  printed beneath it.
- Issuing never runs inside a checkout, refund or webhook request: the
  automatic path runs after the response, and retries run on the scheduler.
- A record marked `issued_externally` (staff, or an order carrying
  `external_receipt_no`) is never sent to you.
- Report a bad buyer `tax_id` as `{ ok: false, error }`. Never block anything:
  the sale has already happened.

**Declining, and the order issuers are asked in.** A record is still issued by
ONE issuer; the first that does not decline owns it.

1. No issuer active: none; the shop's internal reference applies.
2. One active, none chosen: that one.
3. More than one active, none chosen under **Settings → Invoices**
   (`invoice_issuer`): nobody is called, and the record says the shop must
   choose. Plugin load order never decides who reports a sale.
4. One chosen: it is asked FIRST, then every other active issuer in hook order
   (filter priority, then registration) — each only when the one before it
   **declined**. A failure, a throw or a timeout is never passed on: it may
   have reached the authority, so the record stays with that issuer. Every
   later attempt — the sweep, or **Issue again** — goes to it alone, even if
   the shop's choice changed; if it is no longer active, **Issue again** says
   so, and a person marks the record issued elsewhere.
5. Every issuer declined: the record is treated exactly as with no issuer — its
   state stays `final` (not `issue failed`), the reasons are kept in
   `issuer.declined`, and the internal reference is attached when the shop
   switched one on. **Issue again** asks again (your switch may be on now).

A **credit memo** does not walk this order: it goes to the issuer that issued
its sale, and to no other. Against a sale every issuer declined, the credit is
declined too; against a sale nobody issued, it is not sent, and says why. If the issuer of
the sale DECLINES its credit, the memo shows as a failure — the authority would
otherwise hold the sale without its credit.

**Retries.** A failure you mark `retryable: true` — and core's own 30 s
timeout, or a throw, whose outcome is unknown — is retried by the scheduler's background
sweep (`sweepInvoiceIssueRetries`): with the same key, by you alone (never by
another issuer, even if the shop's choice changed), after 2, 4, 8 … minutes up
to 6 hours, 10 calls at most; then the record waits for a person. A claim left
`issuing` by a crash (older than 10 minutes) is retried the same way, under
the same cap, and may be marked issued elsewhere. A plain failure (no
`retryable`) is never retried automatically. Only records whose issuer is
active are picked, oldest order first, at most 10 per tick, from orders made in
the last 60 days (at most the newest 20,000). The
record carries `issuer.attempts`, `issuer.retryable` and
`issuer.next_attempt_at`.

**A late success.** When your provider answers after core gave up waiting, call
`ctx.reportLateSuccess({ number, identifiers })`. Core accepts it only while the
record is still unissued (`failed`, or `issuing` on a retry) AND still yours
under the same key — a compare-and-set on every storage driver, so it never
overwrites a record issued elsewhere, declined or issued meanwhile. It answers
`{ ok: true, accepted }` (`accepted: false` when you already reported it) or
`{ ok: false, code: 'conflict' }`, and never throws. It works for as long as the
process runs; after a restart, the sweep's retry under the same key is how you
hand the document over.

**Tax treatment on every line.** Each record line carries `tax_treatment`,
frozen from the priced order when the record was finalised (a credit memo
copies its invoice line's):

| Value | Meaning |
|---|---|
| `standard` | VAT charged under the normal rules, at `tax_rate_bp` (> 0). |
| `reverse-charge` | EU B2B: the buyer accounts for the VAT. |
| `export` | Outside the EU VAT territory: no EU VAT due. |
| `exempt` | Staff recorded an exemption on the order (a tax override, with its reason). |
| absent | Core cannot tell — e.g. a 0 % line the engine stamped nothing on (tax switched off, an untaxed product, a zero-rated class). Decide it yourself or refuse; never assume `standard`. |

`tax_jurisdiction` (ISO country) is there when another country's table priced
the line. Neither is ever re-derived from today's settings.

### Product fields from a plugin

A plugin that needs typed data on every product declares the fields itself
instead of asking the merchant to type the definitions in. Each definition has
the shape `PUT /api/commerce/product-fields` accepts —
`{ name, label?, help?, rule, visibility? }` — and goes through the same
validator, so the same field types and reserved names apply.

```ts
import { PLUGIN_HOOKS, type Plugin } from 'astrobaas/core';

const wine: Plugin = {
  id: 'wine',
  name: 'Wine',
  filters: {
    [PLUGIN_HOOKS.PRODUCT_FIELD_DEFS]: (defs: unknown[]) => [
      ...defs,
      {
        name: 'vintage_year',
        label: 'Vintage',
        help: 'The harvest year on the label.',
        rule: { type: 'number', optional: true, int: true, min: 1900, max: 2100 },
        visibility: 'public',
      },
    ],
  },
};
```

- **Values live in `Product.custom`**, next to the merchant's own fields:
  `{ "custom": { "vintage_year": 2019 } }`. Every writer — the admin form, the
  REST API, bulk edit and CSV — validates them against your rule on save.
- **Staff-only unless you say `visibility: 'public'`.** A public field is
  published on `GET /api/products` and in the public schema at
  `GET /api/commerce/product-fields`; a staff-only one never leaves the admin.
- **The merchant's own field wins a name collision.** If the shop already
  defined a field with your name, yours is inactive and **Settings → Product
  fields** tells the admin, who can rename or remove theirs to hand you the name.
  Your plugin must not assume its field exists — the shop's could be staff-only
  and typed differently, and installing a plugin never changes what an existing
  field publishes. Choose specific names. Otherwise the settings editor shows
  your fields read-only ("Provided by a plugin"), and the PUT refuses a new
  merchant definition that takes one of your names.
- **A bad definition is dropped on its own** and logged; the merchant's fields
  and your other fields keep working.
- **Removing the plugin** stops declaring the fields. Stored values stay in
  `Product.custom` and stop being published on the next read.

### Payment providers from a plugin

The contracts are exported from `astrobaas/core`:

```ts
import type { PaymentProvider, ManualMethodDef } from 'astrobaas/core';
import { WebhookVerificationError } from 'astrobaas/core';
```

### What the interface asks for

| Member | Required | What it does |
| --- | --- | --- |
| `id` | ✅ | Stable identifier, persisted on orders — renaming one is a migration. |
| `label` | ✅ | Human name for the admin and the storefront. |
| `requiredEnv` | ✅ | Env var names that must be present and non-empty. |
| `createSession(order, ctx)` | ✅ | Open a hosted-checkout session; returns `{ reference, redirectUrl, expiresAt? }`. |
| `verifyWebhook(rawBody, headers, ctx)` | ✅ | Verify and normalise an inbound webhook to a `VerifiedEvent`. **Throws** on any verification failure. |
| `validateEnv(env)` | optional | Deeper check on credentials that ARE set. Returns human-readable problems (variable names, never values); an empty array means usable. |
| `refund(order, amountCents, idempotencyKey, ctx)` | optional | Send money back. Without it the admin says refunds are unavailable rather than offering a button that fails. |
| `captureApproved(event, ctx)` | see below | Turn an `approved` event into money. |

Three rules the platform enforces, so build to them:

1. **A provider is only offered when it is listed in `PAYMENTS_ENABLED`, every
   name in its `requiredEnv` is set and non-empty, AND its optional
   `validateEnv()` reports no problems.** All three, because half-configured is
   the dangerous state: a gateway that appears at checkout and throws mid-flow
   has already reserved stock. Name variables; never read secrets from
   settings. The admin's payment report shows operators which names are missing
   and what `validateEnv` complained about — names and faults, never values.
   Reporting a problem disables the provider exactly as a missing variable does.
2. **A forged webhook must answer 401, not 500.** Throw an error whose class
   name ends in `VerificationError` from `verifyWebhook` — the platform
   matches on the name, so your own class works from any package:
   `class MyPspVerificationError extends Error { name = 'MyPspVerificationError' }`.
3. **Never trust an amount from the wire.** Verify the webhook, then compare
   the paid amount against the ORDER's total; mismatches are `ignored`, not
   `paid`.

### `captureApproved` — required if you can return `approved`

`approved` is the buyer saying yes on the provider's page with **no money moved
yet** — PayPal's Orders v2 with `intent: CAPTURE`, where the merchant must then
capture. It is never a reason to ship, and it is not something core can do for
you, so a provider whose `verifyWebhook` can return `approved` **must**
implement `captureApproved` (it is optional on the interface only so providers
that never produce an approval need not carry it). Without it the event is
recorded and ignored, and the buyer has agreed to pay for nothing.

```ts
captureApproved(event: VerifiedEvent, ctx: ProviderContext): Promise<VerifiedEvent>;
```

Four properties the payment layer depends on (`src/lib/payments/service.ts`,
implemented in `paypal.ts`):

1. **Core decides when.** It calls this only once it has judged the order still
   shippable — reserving stock first, and reopening an order that was
   auto-cancelled while the approval was in flight. Never capture from inside
   `verifyWebhook`: a provider cannot see stock.
2. **Return the event the CAPTURE produced**, with the outcome and amount taken
   from the capture response — not a copy of the approval. That is what keeps
   the ordinary amount check (rule 3) applying to the money that actually
   moved. `paid` when it went through, `declined` when the provider definitively
   refused, `ignored` when the money is not there yet.
3. **Throw on a transient failure** (network, 5xx). The webhook is then answered
   500 and redelivered, and an order reopened for the capture is cancelled again
   with its stock returned. Returning a non-`paid` outcome means "the provider
   answered"; throwing means "ask me again".
4. **Be idempotent per approval.** Delivery is at-least-once, so send the
   provider your own request id and let its response decide — two calls for one
   approval must charge once.



### Why plugin CSS is a hook and not a `<style>` tag

AstroBaaS ships a **hash-based CSP** with no `'unsafe-inline'`: the build hashes
every script and style it bundles, and the browser rejects anything else. Plugin
markup is produced *per request*, so it has no build-time hash — an inline
`<style>` would be **silently dropped** (the tag appears in the DOM, but
`styleTag.sheet` is `null` and the CSS simply never applies, with no console
error). Astro's CSP runtime API can't rescue it either, because the Node adapter
streams: the CSP header is finalized before your layout renders.

So CSS goes through `PLUGIN_STYLES` and is served same-origin from
`/plugins.css`, which satisfies `style-src 'self'`. The `<link>` is only emitted
when an active plugin actually contributes CSS. See `src/plugins/print-styles/`
for the reference implementation.

### `api_posts_get` receives a PAGE

`GET /api/posts` filters and paginates in the storage layer, so this hook is
handed the rows for the requested page — not every post in the database. That is
unavoidable once the database does the paging, and it means a filter here cannot
see or reorder rows outside the current page. Filtering rows OUT of the page
will also make `meta.total` disagree with what was returned, because the count
comes from the query.

**Visibility has already been applied** when the hook runs: who may see
unpublished posts is decided in `src/lib/visibility.ts` and projected onto the
query, so drafts the caller may not read are never in the array. This is not a
hook for enforcing read permissions, and it cannot restore rows the query
excluded.

If you need to influence which posts are returned, do it with the query
parameters (`status`, `kind`, `category`, `locale`) rather than by removing rows
after the fact.

## Safety notes

- `POST_CONTENT` output is re-run through the server sanitizer at the render
  boundary (`src/lib/sanitize.ts`), so a content filter cannot reintroduce
  `<script>` or `javascript:` URLs.
- Actions are isolated: a throwing action is logged and does not break the
  request.
- Plugins share the process — avoid blocking work and unbounded memory use.

## Admin-defined content types (no plugin required)

The same registry, through a screen: **Admin → Content types** lets an admin
define a collection — name, labels, read policy, fields with validation — and
it is real on the next request: REST at `/api/content/<name>`, an entries
screen generated from the schema, and the same deny-by-default visibility rule
plugin types get. No plugin, no deploy, no restart.

The precedence rule matters to plugin authors: **a name your plugin registered
stays yours.** An admin definition with the same name is refused loudly at
bootstrap rather than shadowing you — a paid module's collection must not be
hijackable from a settings field.

Definitions are validated exactly as hard as a hostile manifest (the stored
value outlives the screen that wrote it), and writes are audited: a collection
appearing, vanishing or going public is an API-surface change with a trail.

## Custom content types

Beyond filters/actions, a plugin can register an entirely new content
collection — products, events, docs, anything — with `registerContentType()`
(call it from the plugin's `activate()`):

```ts
import { definePlugin, registerContentType } from 'astrobaas/core';

export default definePlugin({
  id: 'product-catalog', name: 'Product Catalog', version: '1.0.0',
  description: 'Adds a product content type.', author: 'You',
  activate() {
    registerContentType({
      name: 'product',                 // -> /api/content/product
      label: 'Product',
      visibility: 'public',            // REQUIRED to be readable anonymously
      fields: [
        { name: 'name',  rule: { type: 'string', min: 1, max: 200 } },
        { name: 'price', rule: { type: 'number', min: 0 } },
        { name: 'sku',   rule: { type: 'string', max: 64, optional: true } },
      ],
    });
  },
});
```

### `visibility` — read it before you ship a type

**A content type is PRIVATE unless it declares `visibility: 'public'`.** Omit
the field and anonymous reads get `404`; only a signed-in user (or an API key
scoped to `content`) can list it.

| Value | Who can read |
| --- | --- |
| `'public'` | anyone, no credentials — site content a frontend renders |
| `'staff'` | any signed-in user (the **default** when the field is absent) |

**Both registration paths take the same key.** A code plugin passes it to
`registerContentType()`; a declarative manifest puts it in the
`contentTypes` entry (see the manifest example below). They are the same
field with the same default, and the manifest path is covered end-to-end by
the smoke suite — it previously accepted `visibility: "public"`, validated it,
and then registered the collection private, which is a silent failure with no
error for the author to find.

This is deliberately the annoying way round. Types used to be world-readable
with no way to opt out, which is fine for `event` or `doc` and a data breach for
`job-application` or `enquiry` — and the leak fell on the author who never
thought about visibility, i.e. the one most likely to get it wrong. Making you
type the word `public` costs one line and moves the decision to the person who
knows the answer.

A private type answers `404`, not `403`, and it is the *same* 404 an
unregistered type gets. Whether a collection exists is itself information:
`job-application` returning `403` while `nonsense` returns `404` tells a prober
which plugins you have installed.

### `writable` — the other half, and the one that opens a door

`visibility` answers "who may READ this collection". `writable` answers "who may
CREATE in it", and they are separate fields because the dangerous combination is
real.

| Value | Who can POST |
| --- | --- |
| `'staff'` | admins and editors, signed in (the **default** when the field is absent) |
| `'public'` | anyone, no credentials — this is what turns a content type into a **form** |

**`writable: 'public'` opens an anonymous POST endpoint on the internet.** That
is the point — an enquiry, a job application, an RSVP, a support request — and
it is never inferred: a type that says nothing accepts nothing from strangers.

A contact form is `writable: 'public'` with `visibility: 'staff'`: anyone may
send one, nobody may read the others. Declaring **both** public publishes every
submission to the open web, which is right for a guestbook and a data breach for
a job application. One field could not express that difference, which is why
there are two.

The handler does not take a public submission on trust. It applies, in the order
that spends least on the traffic most likely to be junk:

- a **per-IP rate limit** (before any parsing),
- a **honeypot** field — filled in, the response is a cheerful success and
  nothing is stored, because a bot told it failed just retries without the field,
- a local **proof-of-work** challenge,

and then validates against your declared `fields`, exactly like a staff write.
`validate()` copies nothing it was not asked for, so a submitter cannot
introduce a field, overwrite an id, or post their own status. Staff take the
normal authoring path and are never asked for a honeypot.

Two companions, both only meaningful with `writable: 'public'`:

- **`moderated: true`** — a submission is stored with a `pending` status and
  waits for a person. `visibility` is collection-wide and cannot express this:
  `'public'` publishes every row including one posted thirty seconds ago.
- **`notifyOnSubmission: true`** — email the site's admin address when one
  arrives, if an email channel is configured. A form nobody is told about is a
  form nobody answers.

AstroBaaS then exposes generic, schema-validated CRUD:

| Method | Path | Auth |
| --- | --- | --- |
| `GET` | `/api/content/<type>` | public **only if** `visibility: 'public'`; otherwise any session |
| `POST` | `/api/content/<type>` | admin/editor — **or anyone** when `writable: 'public'` (see above) |
| `PUT` | `/api/content/<type>/<id>` | admin/editor |
| `DELETE` | `/api/content/<type>/<id>` | admin/editor |

Every write is validated against the `fields` schema (same `validate()` the core
uses). Records are stored generically, and a type that declared
`visibility: 'public'` can be read by any Astro page with no credentials.
`name` must be kebab-case and not collide with a built-in collection.

## Bundled examples

- **`reading-time`** — a `POST_CONTENT` filter that prepends an estimated read
  time. Shows a simple value transform.
- **`draft-watermark`** — a `POST_CONTENT` filter that banners non-published
  posts. Shows a per-post conditional transform using the post argument.
- **`product-catalog`** — registers a `product` custom content type. Shows the
  `registerContentType()` primitive end-to-end.
- **`print-styles`** — contributes CSS via `PLUGIN_STYLES`, served from
  `/plugins.css`. The reference for adding styling.
- **`smtp2go`** — swaps the email transport. The reference for a **connector**:
  a plugin that replaces a core service rather than filtering content, and the
  reference for the `activate`/`deactivate` lifecycle. See below.
- **`consent-banner`** — granular prior-consent cookie control. Activating it is
  what makes the banner appear; deactivating it shows none, and because the
  loader treats "no record" as consent to nothing, that switches trackers *off*.
- **`ai-assistant`** — a chat bubble on every public page, backed by the
  operator's own provider under **Settings → AI assistant**. The widget never
  holds the API key: it posts to `/api/assistant/chat` on this origin.
- **`finance`** — invoicing and bookkeeping. The reference for a plugin that
  is a whole application: ~70 API routes, one admin screen with its own
  client app, namespaced storage with a hash-chained log, outbound events and
  MCP tools. See `src/plugins/finance/README.md`.
- **`popups`** — one opt-in overlay, on the operator's terms. Deactivating it
  does not set a flag; `/popup.js` stops being served at all.

The last three share a shape worth copying: each contributes only CSS through
`PLUGIN_STYLES`, and the browser behaviour lives in a file core serves
(`/consent.js`, `/assistant.js`, `/popup.js`). A plugin cannot ship executable
script to the browser under the hash-based CSP — see
["Why plugin CSS is a hook"](#why-plugin-css-is-a-hook-and-not-a-style-tag) above.

## SMTP2GO connector

Sends AstroBaaS mail — password resets, contact forms, order notifications —
through SMTP2GO's HTTP API. No SMTP socket handling, and it works from platforms
that block outbound port 587.

```bash
SMTP2GO_API_KEY=api-XXXXXXXXXXXX
SMTP2GO_SENDER="My Shop <no-reply@example.com>"
```

Then activate **SMTP2GO** under Admin → Plugins.

Three decisions in it are worth copying into your own connector:

1. **The credential comes from the environment, not from plugin settings.**
   Settings live in the database next to a public read path. A connector that
   stashed its API key there would repeat a bug this codebase already fixed.
2. **A missing credential disables the connector loudly and leaves the previous
   transport alone.** It does not fall back to swallowing mail — a half-configured
   mail connector that silently drops password resets is worse than no connector.
3. **HTTP 200 is not success.** SMTP2GO answers 200 with `succeeded`/`failed`
   counts, so the transport reads the body and throws when nothing was accepted.
   A transport that only checks `res.ok` drops undeliverable mail with no error
   anywhere — the user simply never receives it.

`deactivate()` passes `null` to `setEmailTransport()`, which restores the
env-configured default rather than pinning the console transport. Turning the
plugin off must not quietly disable a configured fallback.

---

# External / shippable plugins

The third kind, and the one a business ships: an npm package (or a single built
file) that a customer names in an environment variable. This is how the optical
and IRIS modules install on a customer's server without that server ever
holding their source.

```bash
# from your AstroBaaS checkout — the package is created in the current directory
npx astrobaas plugin package acme-stamps    # scaffold the whole shape
cd acme-stamps && npm install && npm run build
cd ..                                       # back to AstroBaaS: `dev` is its script
ASTROBAAS_PLUGINS="$PWD/acme-stamps/dist/index.mjs" \
ASTROBAAS_PLUGINS_ACTIVATE=acme-stamps npm run dev
```

Two details the scaffolder gets right and a hand-typed version usually does not:
the scaffolded package has **only** a `build` script, so `npm run dev` belongs to
the AstroBaaS checkout you came from; and a relative specifier is resolved
against the **server process's** working directory (`path.resolve(process.cwd(),
…)`), not against the file that names it, which is why `./acme-stamps/…` is
wrong the moment you are still inside `acme-stamps/`. `astrobaas plugin package`
prints both lines with the absolute path already filled in — follow what it
printed rather than this snippet if they ever differ.

## The contract

`ASTROBAAS_PLUGINS` is a comma-separated list of specifiers. A path (starting
with `.` or `/`) is imported from disk; anything else resolves as a package
name from node_modules. The module's default export may be:

- a **plugin object**,
- an **array** of plugin objects — one package can carry every module a
  customer licensed, so a fourth purchase never means another env change,
- or a **factory** `(host) => plugin | plugin[]`.

**Prefer the factory, and import nothing from the host at runtime.** Your file
is loaded INTO a running AstroBaaS: an `import ... from 'astrobaas/core'` in a
shipped bundle would resolve against the CUSTOMER'S node_modules — a version
you were never built with — or fail outright. The factory hands you the host's
own helpers, which is the same thing with none of the risk. Use `astrobaas` as a
**devDependency** for types while developing; `npm run build` (esbuild, bundled,
no externals) produces a file with zero imports.

`host` carries these, and the set is additive — a module that destructures
only the first two keeps working:

| Key | What it is |
| --- | --- |
| `definePlugin` | This host's identity helper, with this host's hook typing. |
| `PLUGIN_HOOKS` | This host's hook-name constants. Never hard-code the strings. |
| `text` | `{ fold, transliterate }` — the core's own text utilities, exposed so a module cannot fold search terms differently from the core that ranks them. |
| `getSettings` | `() => Promise<Record<string, unknown>>` — every setting as a **map**, not the row array. **Async, so it is usable from an admin page's `render` but not from a synchronous filter** — a filter that needs its own configuration must be handed it by its call site, the way `SEARCH_EXPAND` passes `ctx.settings`. |
| `getPluginSettings` | `(pluginId) => Promise<Record<string, unknown>>` — your plugin's own settings record. See "Your own settings". |
| `createStore` | `(pluginId) => PluginStore` — your namespaced store, usable **outside** a route handler: from a filter, an action, a timer. The same records `ctx.store` and your migrations see. Synchronous (storage is opened on first use); an invalid id — a package name like `@acme/x` is not a plugin id — throws at the call. See "Storage". |
| `catalog` | Read-only product and brand reads: `listProducts()`, `iterateProducts({ batchSize })`, `listBrands()`. See "Reading the catalogue" below. |
| `coupons` | Issue, inspect and revoke discount codes: `issue(input)`, `status(code)`, `revoke(code)`. See "Issuing coupons" below. |
| `money` | `{ currencyExponent(currency) }` — decimal places for an ISO 4217 code (`EUR` 2, `JPY` 0, `KWD` 3), from the same table the core formats prices with. |
| `webhooks` | `{ emit(event, data) => Promise<void> }` — send one of **your declared** `webhookEvents` through the core's webhook delivery. See "Webhook events from a plugin" below. |
| `consent` | `{ record, confirm, withdraw, withdrawUrl }` — the append-only consent ledger, and the newsletter double opt-in on top of it. See "Consent and mail" below. |
| `mail` | `{ send }` — one email through the configured core transport. Never open your own SMTP connection. See "Consent and mail" below. |

```ts
export default function create({ definePlugin, PLUGIN_HOOKS, text, getSettings, createStore }) {
  return definePlugin({ /* … */ });
}
```

### Reading the catalogue

`host.catalog` is how a feed, a marketplace sync or a price monitor reads
products without importing the host. Types: `PluginCatalog`, `CatalogProduct`,
`CatalogBrand` from `astrobaas/core` (types only — the values come from `host`).

| Member | Returns |
| --- | --- |
| `listProducts()` | `Promise<CatalogProduct[]>` — every product, in storage order. |
| `iterateProducts({ batchSize? })` | `AsyncIterable<CatalogProduct[]>` — the same products in the same order, in batches (default 500, max 5,000). |
| `listBrands()` | `Promise<{ slug, name, key, spellings }[]>` — every maker, exactly as `GET /api/brands` lists them (makers with active products plus every curated brand record). |

What every product read guarantees, on all three storage drivers:

- **Every status.** Drafts, archived products and `catalog_visibility: hidden`
  ones are all included, so a feed can report why it left one out. **Filter
  them yourself** before you publish anything.
- **Copies.** Each call returns fresh objects. Changing one changes nothing in
  the shop and nothing in the next read. (On the lowdb driver the storage
  layer hands out its cached rows; the host clones them before you see them.)
- **The derived read fields** that `GET /api/products` serves: `stock_status`
  on the product and on each variant, `reference_price_cents`, and each
  image's `kind` / `mime_type` with `photos` and `videos` split out.
- **Public custom fields only.** `custom` holds the fields the merchant marked
  **public** under Settings → Product fields — the same bag an anonymous
  `GET /api/products` returns. Staff-only fields (a cost price, a supplier
  code) and undeclared keys are removed. A plugin's output is usually public,
  so this is the safe default; if you need a field, the merchant marks it
  public.
- **Brands are free text.** `product.brand` is whatever was typed or
  imported ("Ray-Ban", "RAYBAN"), not a slug. To name a product's maker, find
  the `listBrands()` entry whose `spellings` contains `product.brand` exactly;
  its `name` is the one the shop shows.
- Not applied: embed facades and the `?locale=` projection. The `i18n`
  sidecar is left on the product, so you can read translations yourself.

**Size.** The storage layer has no paged product read, so each call reads the
whole product table once. `listProducts()` then holds a projected copy of all
of it at once — fine for a few thousand products. Past that, use
`iterateProducts()`: it still reads once (a snapshot taken when iteration
starts), but copies and projects one batch at a time, so a consumer that
writes as it goes keeps only one batch of copies alive. Iteration fixes which
products and their order when it starts; each batch is copied when it is
reached, so an edit saved mid-iteration may show in a later batch.

```ts
for await (const batch of host.catalog.iterateProducts({ batchSize: 1000 })) {
  for (const p of batch) {
    if (p.status !== 'active' || p.catalog_visibility === 'hidden') continue;
    write(item(p, host.money.currencyExponent(currency)));
  }
}
```

### Issuing coupons

`host.coupons` is how a prize wheel, a referral scheme or a loyalty plugin hands
a customer a code the checkout honours. The coupon it creates is an ordinary
coupon: validated by the admin API's own rules, priced by the same function the
quote and the order use, counted by the same atomic claim. Types:
`PluginCoupons`, `IssueCouponInput`, `IssuedCoupon`, `CouponStatus` from
`astrobaas/core` (types only).

| Member | Returns |
| --- | --- |
| `issue(input)` | `Promise<{ id, code, expires_at }>`. Throws `coupons.issue: <reason>` on input it refuses. |
| `status(code)` | `Promise<{ exists, redeemed_count, expired, revoked } \| null>` — `null` only when the argument is not a code at all; an unknown code is `{ exists: false, … }`. |
| `revoke(code)` | `Promise<boolean>` — true when the code is now revoked (idempotent). False for an unknown code, and for a coupon **staff** made: a plugin can revoke only codes a plugin issued. |

`issue` takes:

```ts
{
  type: 'percent' | 'fixed' | 'bogo50' | 'free_shipping' | 'gift_product',
  value?: number,            // percent: BASIS POINTS (1000 = 10%); fixed: minor units; others: ignored
  gift_product_id?: string,  // gift_product: an existing SIMPLE product
  conditions?: { min_subtotal_cents?: number, categories?: string[], brands?: string[] },
  email?: string,            // bind to one buyer (case-insensitive)
  single_use?: boolean,
  max_redemptions?: number,
  max_redemptions_per_email?: number,
  expires_at: string,        // ISO, required, in the future
  starts_at?: string,
  prefix?: string,           // 1–12 letters/digits: the code becomes PREFIX-XXXXXXXXXXXX
  source: { plugin: string, ref: string },  // your plugin id, and your own reference
}
```

The code is generated by the host: 12 symbols from an alphabet without `I`,
`L`, `O` or `U` (60 random bits), upper-case. A plugin cannot choose it, set
`automatic`, restrict by product id, or set a usage count.

**Trust.** `host` is one object shared by every plugin, as it is for
`createStore`: `source.plugin` is what you declare, and `revoke()` acts on any
plugin-issued code, not only yours. Pass your own id, and revoke only codes you
issued. Staff-made coupons are out of reach either way. An admin who switches a
revoked coupon back on in **Shop → Coupons** overrides the revocation.

```ts
const { code, expires_at } = await host.coupons.issue({
  type: 'percent', value: 1500, email, single_use: true,
  expires_at: new Date(Date.now() + 48 * 3600_000).toISOString(),
  prefix: 'WHEEL', source: { plugin: 'campaign-games', ref: leadId },
});
```

**Refusal codes.** A code that does not apply is reported by `POST
/api/orders/quote` as `coupon.refusal` and by `POST /api/orders` as
`error.params.refusal`, one of `coupon.not_found`, `coupon.expired`,
`coupon.not_started`, `coupon.min_subtotal`, `coupon.not_applicable`,
`coupon.email_mismatch`, `coupon.already_redeemed`, `coupon.exhausted`. A
caller that is not staff — including an API key — sees `coupon.not_found` for
every refusal except `coupon.min_subtotal`, so the endpoints cannot be used to
learn which codes exist.

**When a use counts.** Placing the order counts it, atomically. Cancelling the
order before it was paid hands it back; a paid-then-cancelled order and a
refund keep it. Reopening a cancelled order counts it again WITHOUT a limit
check (the order carries the discount whatever happened since), so a
single-use code released by a cancellation, used by someone else, and then
reopened shows two uses; no second webhook fires for the re-count. Each use
counted by a placed order fires the core webhook event
`coupon.redeemed` with `{ code, coupon_id, order_id, email_hash }`, where
`email_hash` is the SHA-256 (hex) of the trimmed, lower-cased address — never
the address.

**The `coupons:validate` scope.** A storefront key holding only this scope may
call `POST /api/orders/quote`, and nothing else — it cannot place the order.
See "Scopes: `resource:read|write|*`, and named actions" below for the grammar.

### Consent and mail

`host.consent` writes the **consent ledger**: one row per decision,
`{ id, email, purpose, granted, version, text_hash, at, ip?, ua?, source, confirmed_at? }`.
The ledger is **append-only**. A row is never edited: a confirmation is a new
row with `confirmed_at`, a withdrawal is a new row with `granted: false`, and
the current state of (email, purpose) is the latest row written. The only
rewrite is the GDPR erasure, which keeps the rows as proof of consent and
replaces the address with `sha256:<hex>` and removes `ip`/`ua`. Known purposes
are `game_terms` and `newsletter`; any lower-case identifier is accepted.

| Member | Returns |
| --- | --- |
| `host.consent.record({ email, purpose, granted, version, text, ip?, ua?, source })` | `Promise<{ id, text_hash, at }>`. Appends one row. `text` is the exact wording shown; only its sha256 (of the UTF-8 bytes, no normalisation) is stored. `granted` must be a real boolean. Throws an error with `name: 'ConsentInputError'` and a `.field` for input you must fix. A `granted: false` for `newsletter` also takes the address off the list. |
| `host.consent.confirm({ email, purpose, source, ip?, ua? })` | `Promise<{ confirmed }>`. The double opt-in. Confirms **only** when the latest row for (email, purpose) is a grant; otherwise it writes nothing and returns `{ confirmed: false }`. Already confirmed: `{ confirmed: true }`, nothing written. |
| `host.consent.withdraw({ email, purpose, source })` | `Promise<void>`. Appends a `granted: false` row (a repeat writes nothing more). For `newsletter`, the address leaves the list and `subscriber.unsubscribed` fires. |
| `host.consent.withdrawUrl({ email, purpose })` | `Promise<string>`. A signed public link (`/api/consent/withdraw?token=…`, valid a year) that withdraws ONE purpose for ONE address. Put it in the mail you send for that purpose — taking consent back must be as easy as giving it (Art. 7(3)). A click withdraws and shows a page; a POST answers a bare 200. Throws when no site URL is configured. *(Added beyond the original contract.)* |
| `host.mail.send({ to, subject, html, text, headers?, category })` | `Promise<{ ok, id?, error? }>`. Never throws. `category` is `'transactional'` or `'bulk'`. |

**A confirmed `newsletter` consent IS the subscription.** It adds the address
to the subscriber list and fires the core webhook event
`newsletter.subscribed` with `{ email_hash, source, at }` — `email_hash` is the
sha256 (hex) of the lower-cased address, never the address — alongside the
existing `subscriber.confirmed`. So a plugin that asks for newsletter consent
records the grant when the person ticks the box, and calls
`confirm({ purpose: 'newsletter' })` when they have proved the inbox is theirs.
Calling `confirm` for somebody who never ticked it subscribes nobody.

All three validate first and throw that same `ConsentInputError` for a
malformed address, purpose (`/^[a-z][a-z0-9_.:-]{0,63}$/`) or `source` — a
programming error, not a visitor's. Addresses are compared lower-cased.

Pass `ip`/`ua` from the core's client helper (`ctx.client`), never from a
request header you read yourself. A malformed IP is dropped; a user agent is
capped at 512 characters.

**`host.mail.send`** goes through whatever the operator configured — SMTP,
SMTP2GO, the webhook bridge — with the core's Reply-To rules, its delivery log,
its health reporting and its `EMAIL_CAMPAIGNS=0` refusal of bulk mail. One
recipient per call (`error: 'invalid_recipient'` otherwise). A failure is
`{ ok: false, error }`; `error` starting `outcome_unknown:` means the server
took the whole message and never answered, so it may have arrived — do not
resend a one-time code on that. `id` is the server's own reply when the
transport has one.

`category: 'bulk'` is newsletter mail, and the core enforces what that means:
it is sent only to an address whose `newsletter` consent is granted AND
confirmed AND not withdrawn (`error: 'no_newsletter_consent'` otherwise), and
the core sets the RFC 8058 one-click headers (`List-Unsubscribe`,
`List-Unsubscribe-Post: List-Unsubscribe=One-Click`) and adds an unsubscribe
link to the text and HTML. Your own values for those two headers are replaced.

`'transactional'` means one message the recipient triggered — a code, a
receipt, a reward. The core does not check consent for it and does not add
list headers, so it is on you not to send marketing under that label: a
promotional mail sent as `transactional` is still promotional mail in law, and
it is exactly what `'bulk'` exists to make safe.

```js
export default (host) => host.definePlugin({
  id: 'campaign-games',
  routes: [{
    method: 'POST', path: '/api/game/claim', access: 'public', scope: 'game:play',
    handler: async ({ request, client }) => {
      const { email, newsletter } = await request.json();
      await host.consent.record({ email, purpose: 'game_terms', granted: true,
        version: '3', text: TERMS_TEXT, ip: client?.ip, ua: client?.ua, source: 'campaign-games' });
      if (newsletter) {
        await host.consent.record({ email, purpose: 'newsletter', granted: true,
          version: 'n1', text: NEWSLETTER_TEXT, ip: client?.ip, ua: client?.ua, source: 'campaign-games' });
      }
      const sent = await host.mail.send({ to: email, subject: 'Your code', text: `Code: ${code}`,
        html: `<p>Code: <b>${code}</b></p>`, category: 'transactional' });
      return Response.json({ success: sent.ok });
    },
  }],
});
// …and once the code is verified:
await host.consent.confirm({ email, purpose: 'newsletter', source: 'campaign-games' }); // { confirmed: false } if not granted
```

## Compatibility

Declare the plugin-API range you were built against:

```ts
requiresCore: '^1.0.0',
```

An incompatible module is refused **at load**, with a sentence naming both
versions, instead of loading and failing somewhere deep at request time. The
host's version is the same `MANIFEST_API_VERSION` declarative manifests check,
so "what am I compatible with" has one answer across every plugin kind.

## What loading failure looks like

`loadExternalPlugins` never takes the boot down: every module that fails to
import, exports something that is not a plugin, or fails the compatibility
check is collected with its reason and reported — on the console at every
boot, and by `GET /api/health/deep` under `plugins.failed_to_load`, so a
deploy script can assert that what was requested actually loaded.

## Storage, from a route

Route handlers receive `ctx.store`, already namespaced to your plugin — you
import nothing (see "Storage" below). Outside handlers — a filter, an action, a
timer — call `host.createStore('<your-id>')` once in the factory and keep it:

```ts
export default function create({ definePlugin, PLUGIN_HOOKS, createStore }) {
  const store = createStore('vat');           // no storage touched yet
  return definePlugin({
    id: 'vat', /* … */
    actions: {
      [PLUGIN_HOOKS.AFTER_ORDER_CREATE]: async (order) => {
        await store.put('evidence', order.id, { at: new Date().toISOString() });
      },
    },
  });
}
```

## Your own settings

The object an operator edits on your plugin's admin screen lives on your
plugin's record. Read it scoped to you:

```ts
// In a route handler — no id to pass, and no way to read a neighbour's.
const { apiKey, retries = 3 } = await ctx.settings();
```

```ts
// Anywhere else, including from an external plugin's factory:
import { getPluginSettings, getPluginSetting } from 'astrobaas/core';

const settings = await getPluginSettings('acme-stamps');
const retries  = await getPluginSetting('acme-stamps', 'retries', 3);
```

An external plugin gets the same function from the host
(`getPluginSettings(pluginId)`); the factory runs before any plugin it returns
is registered, which is why that one takes your id and `ctx.settings()` does
not.

**Read it where you use it, not at `activate()`.** Activation runs once per
process, and an operator who changes a setting is not going to restart the site
for you — a value cached at boot is a value that goes stale. This is one
indexed read.

Both answer `{}` rather than throwing when the plugin has no record yet or
storage is unreachable, so a handler falls back to its defaults instead of
returning a 500. `getPluginSetting` also treats a `null` — the operator cleared
the field — as absent, and returns your fallback. What comes back is a copy:
mutating it changes nothing, for you or for the next reader.

# Declarative plugins (runtime-installable)

A declarative plugin is **data, not code**: a JSON manifest an operator installs
from the admin UI with no rebuild and no redeploy. It is validated, stored, and
then interpreted by subsystems that already exist. Nothing is `eval`'d,
`vm`'d, or dynamically imported — which is why this tier can be exposed to
operators while code plugins stay build-time only.

## Manifest format

```jsonc
{
  "id": "faq-and-seo",              // kebab-case, unique, may not shadow a bundled id
  "name": "FAQ + SEO Meta",
  "version": "1.0.0",               // semver
  "description": "…",
  "author": "You",
  "homepage": "https://…",          // https only
  "astrobaasApi": "^1.0.0",         // manifest API range; mismatched major is refused
  "capabilities": {
    "headTags": [                    // <meta>/<link> only, attribute-allow-listed
      { "tag": "meta", "attrs": { "name": "robots", "content": "index, follow" } }
    ],
    "css": ".faq-question { font-weight: 600 }",   // appended to /plugins.css
    "contentTypes": [                                // same shape registerContentType() takes
      {
        "name": "faq", "label": "FAQ", "labelPlural": "FAQs",
        "visibility": "public",                      // omit -> private (staff only)
        "fields": [
          { "name": "question", "rule": { "type": "string", "min": 3, "max": 300 } },
          { "name": "answer",   "rule": { "type": "string", "max": 5000 } }
        ]
      }
    ],
    "webhooks": [                                    // https + SSRF-guarded
      { "event": "post.published", "url": "https://hooks.example/notify" }
    ],
    "sections": [                                    // editor blocks, namespaced to you
      {
        "name": "promo",
        "label": "Promo band",
        "description": "A branded strip with a call to action.",
        "template": "<div class=\"ab-x-faq-and-seo-promo\"><h3>Promo</h3><p>Copy.</p></div>",
        "css": ".ab-x-faq-and-seo-promo { padding: 2rem; background: var(--surface-color); }",
        "modifiers": { "tone": ["quiet", "loud"] }   // optional variants; see below
      }
    ]
  }
}
```

A working example lives at
[`examples/plugins/faq-and-seo.manifest.json`](./examples/plugins/faq-and-seo.manifest.json).

### Dependencies

A plugin can require another. This is what makes verticals possible: a generic
`commerce` plugin sold to everyone, and an `optical` pack — prescriptions,
dioptres, lens configurators — sold on top of it.

```jsonc
{
  "id": "optical",
  "version": "1.0.0",
  "dependencies": { "commerce": "^2.0.0" },
  "capabilities": { /* … */ }
}
```

Ranges use a deliberate subset — `^1.2.3`, `~1.2.3`, `>=1.2.3`, `>1.2.3`,
`<=1.2.3`, `<1.2.3`, `=1.2.3`, `1.2.3` and `*` — and anything outside it is a
validation error rather than a dependency that silently never matches. `||`
unions, hyphen ranges and `1.x` wildcards are not supported. A pre-release
(`2.0.0-beta.1`) only satisfies a range that names a pre-release at the same
version, so `^2.0.0` will not quietly accept an unfinished build.

Where each rule bites:

| Action | Behaviour |
| --- | --- |
| **Install** with a dependency missing | **Allowed.** You cannot be made to install in topological order. The response lists what is still needed and says it cannot be activated yet. |
| **Activate** with any dependency missing, inactive or out of range | **Refused**, naming which and why. This is when a plugin starts contributing content types, sections and webhooks, so it is when its assumptions must hold. |
| **Deactivate / uninstall** a plugin an ACTIVE plugin depends on | **Refused**, naming the dependents. Otherwise the dependent keeps running against something that is gone and fails somewhere unrelated. |
| Same, but the dependent is INACTIVE | **Allowed.** It simply cannot activate until the dependency returns. |

A plugin cannot depend on itself, and a dependency on a *bundled* plugin works
the same way — both tiers carry an id and a version.

### Sections

A section is a block an author can insert from the editor's palette. Yours are
namespaced: the host derives the class as **`ab-x-<pluginId>-<name>`** and you
do not get to choose it. That is what stops two plugins colliding and stops
either shadowing a core section.

Four rules, all enforced at install rather than discovered later:

1. **Every `ab-` class in your template must be yours.** Reusing `ab-hero`
   would inherit core styling you do not control and break the moment that
   section changes.
2. **Every CSS selector must start with `.ab-x-<pluginId>-`.** Descendants are
   fine (`.ab-x-you-promo h3`), and so are `@media` / `@supports` /
   `@container` / `@layer` wrappers around scoped rules. `body {}`, `*  {}` and
   `@font-face` are refused — this is what bounds your CSS to the markup you
   contributed instead of the whole document.
3. **`modifiers` are variants, and they are namespaced too.** An optional
   `{ group: [values] }` map — the editor renders one `<select>` per group and
   applies `ab-x-<pluginId>-<group>-<value>`. That namespacing is why the values
   are validated rather than trusted: core's own sections turn
   `{ align: ['center'] }` into `ab-align-center`, and a plugin must not be able
   to mint a class styled by CSS it does not control. Up to 6 groups, 1–12
   values each, strict kebab-case (no leading, trailing or doubled hyphen) up to
   21 characters — a loose value like `tone-` composes into a class the content
   sanitizer strips on save, so it is refused up front instead.
4. **Your template must survive the content sanitizer byte-for-byte.** If it
   does not, the install fails and the response shows your markup next to what
   the sanitizer returned, so you can see exactly what was removed. A section
   that renders in the editor and loses part of itself on save is the worst
   failure this system can have, so it is refused up front rather than warned
   about.

Validate before uploading:

```bash
npx astrobaas plugin validate your-plugin.manifest.json
```

**What happens when your plugin is removed.** Its sections disappear from the
palette and its styles stop being served, but the markup stays in content and
degrades to plain, readable HTML. Re-installing brings the styling back. The
content sanitizer recognises the `ab-x-*` namespace by shape rather than by
looking up what is installed, precisely so that saving a page while your plugin
is disabled cannot strip it out permanently.

Operators who want a closed class allow-list with no namespace escape hatch can
set `SANITIZE_STRICT_CLASSES=1`, which strips plugin section classes on save.
It is off by default because turning it on is data loss for anyone using a
plugin that ships sections.

## Validate before you ship

```bash
npx astrobaas plugin validate examples/plugins/faq-and-seo.manifest.json
```

This runs the **same validator the install endpoint uses**, so "valid here"
means "installable there". It exits non-zero and lists every problem.

## Installing

- **Admin UI** — Plugins → *Install a plugin*: browse the curated registry, or
  paste a manifest. Then activate it like any other plugin.
- **API** — `POST /api/plugins/install { manifest }` (admin + CSRF),
  `DELETE /api/plugins/install { id }` to uninstall.

Installing takes effect **in the running process** at once. Other processes
on the same database notice within about 15 seconds of their next request and
rebuild their registry the same way (they compare a fingerprint of the plugin
records and the content-type settings; see
`src/lib/plugin-platform/registry-recheck.ts`). A plugin's own settings are
not part of that fingerprint: if your plugin caches its settings at
`activate()`, other processes keep the old values until their next rebuild.

## What the sandboxless guarantee rests on

Declarative plugins are safe to install because of what they *cannot express*:

- **No code.** There is no capability that carries JavaScript.
- **No arbitrary markup.** `headTags` takes structured `{tag, attrs}` objects
  restricted to `meta`/`link` with an attribute allow-list; values are escaped
  and then re-sanitized. A manifest cannot emit a `<script>`.
- **No inline styles.** `css` is served from `/plugins.css`, so the strict
  hash-based CSP applies unchanged.
- **No internal network access.** Webhook targets are re-checked against the
  SSRF guard at install time, so a manifest cannot point the server at
  `169.254.169.254` or an RFC-1918 host.
- **No shadowing.** A manifest may not take the id of a bundled plugin.
- **Bounded.** Size caps on CSS, tag counts, content types, and fields.

## The curated registry

Registry browsing is **on by default**, pointed at this repository's example
index ([`examples/registry/index.json`](./examples/registry/index.json)).
`PLUGIN_REGISTRY_URL` repoints it at your own — it does not switch the feature
on. Each entry carries a **SHA-256 of the manifest bytes**, verified *before*
parsing, so a tampered copy is refused even when served over valid TLS (and an
entry whose manifest has changed since the index was written fails to install
with a checksum mismatch until the index is updated). Set
`PLUGIN_REGISTRY_DISABLED=1` to turn registry browsing off entirely; uploads
still work.

This is checksum-pinning against an operator-chosen index, **not** author
signing — there is no public-key trust chain yet. Treat the registry as "content
reviewed by whoever runs that index".

### Listing kinds

An index entry declares a `kind`:

- **`declarative`** (the default) — a manifest the operator installs in one
  click. Requires `manifestUrl` + `sha256`; no checksum, no install.
- **`bundled`** — a **code** plugin that already ships inside AstroBaaS. Some
  things a manifest genuinely cannot express: a connector that swaps the email
  transport is an implementation, not data. Listing them keeps the registry an
  honest directory of everything available rather than only the installable
  subset — someone browsing for "how do I send email" should find the answer,
  and it happens to be one they already have.

A `bundled` entry carries **no** URL or checksum, and the install path refuses
it outright with a message pointing at Plugins. It is a pointer to code already
in the build; the registry can never deliver code, and a listing must not imply
otherwise.

## Capability ceiling (and the escape hatch)

Declarative (manifest) plugins deliberately cannot add request handlers, admin
screens, or business logic. **Code plugins can** — see
[The plugin platform](#the-plugin-platform-routes-screens-and-storage). When you hit that ceiling you have two options:

1. **Write a code plugin** and redeploy — the normal path for developers and AI
   agents, with full types and no restrictions.
2. **Rebuild-on-install** — for self-hosters who want operator-installable *code*
   plugins, drop the module into `src/plugins/`, add the import, and rebuild
   (`npm run build`) on the server. This keeps type safety and CSP hashing
   because the plugin genuinely becomes build-time code. It needs the build
   toolchain in production and does not suit immutable containers, so it is a
   documented escape hatch rather than a supported product feature.


---

# The plugin platform: routes, screens, and storage

A code plugin can own three things core used to own alone: **a URL, a screen,
and a table.** Together they are what makes a plugin a feature rather than a
filter on values core already had.

```ts
export default definePlugin({
  id: 'shop',
  name: 'Shop',
  version: '1.0.0',
  description: 'Sells things.',
  author: 'You',

  routes: [ /* API endpoints */ ],
  adminPages: [ /* admin screens */ ],
  migrations: [ /* data transforms */ ],
});
```

All three are read from **active** plugins at bootstrap and replaced wholesale
on reload, so deactivating a plugin genuinely stops serving its routes rather
than leaving them until a restart.

## Routes

```ts
routes: [
  {
    method: 'GET',
    path: '/api/plugin/shop/orders/:id',
    access: 'staff',            // 'staff' (default) | 'admin' | 'public'
    scope: 'orders:read',       // optional: which API-key scope governs it
    handler: async ({ params, user, request, url }) =>
      Response.json({ id: params.id }),
  },
]
```

**A plugin cannot shadow a core route.** Astro sorts routes once at build time
and a static path segment always sorts before a spread one
(`astro/dist/core/routing/priority.js`), so the catch-all that dispatches plugin
routes sits below every real route file. `/api/orders` reaches
`src/pages/api/orders/index.ts` no matter what any plugin claims. That is
structural, not a check that could be forgotten — and it is the same property
`src/pages/[...slug].astro` already relies on.

It also means claiming a path core currently owns is silently ineffective. That
is deliberate: it is what will let a module take over a surface core used to
serve, on the day core stops serving it, without breaking the storefronts
pointing at that URL in the meantime.

### Widening a gate requires a namespace core does not serve

`access: 'public'`, `csrf: 'exempt'` and `scope` are **refused outside
`/api/plugin/`** — or outside a first-level name no core route file uses
(`/api/game/…` is fine; `/api/orders/…`, `/api/stats/…` or `/api/finance/…`
are not) — and the reason is a real hole that this closed.

The bare form exists because a shipped storefront sometimes fixes the URL:
the campaign-games module must answer `POST /api/game/spin`. The list of names
core serves is `CORE_API_NAMESPACES` in `src/lib/plugin-platform/routes.ts`, and
`tests/plugin-game-seams.test.mjs` fails when a core directory is added under
`src/pages/api/` without being listed there — so a new core namespace can never
silently become one a plugin may open. Names are compared case-insensitively,
and a path that core's API-key scope map already answers for (its prefix rules
make `/api/coupons-plus/…` a `products:*` path) is not widenable either. A bare
route can never take over an existing core path: the core file wins at the
router, and the widening is refused at registration.

The middleware decides authentication and CSRF *before* routing, so it asks the
route registry about the raw request path. A plugin declaring
`{ path: '/api/media/upload', csrf: 'exempt' }` never serves that path — core's
file wins — but the middleware consulted the declaration anyway and stopped
checking CSRF on **core's** handler. A cross-site POST then uploaded a file with
nothing but a session cookie. (Reproduced, then fixed; `tests/smoke.mjs` keeps
it closed, and the fixture still declares it so the assertion has something to
catch.)

A `staff` or `admin` route may still claim any path, because it widens nothing:
an unknown `/api` path is already staff-gated, so the declaration changes no
gate.

For the same reason, the segment right after `/api` must be **literal**. A
parameter there (`/api/:x/me`) matches every namespace at once, including the
reserved ones the string check protects.

Paths under `/api/auth/`, `/api/2fa/`, `/api/keys`, `/api/users/`,
`/api/backup/`, `/api/plugins`, `/api/settings/` and `/api/webhooks` are
**refused at registration** (`RESERVED_API_PREFIXES` in
`src/lib/plugin-platform/routes.ts`). Everything there authenticates somebody,
hands out a credential, or changes who can log in — creating a webhook mints a
signing secret, which is the list's own criterion for being on it.

Two plugins claiming one URL is refused rather than resolved — otherwise
database row order would decide which plugin answers a live endpoint.

### Access is the security boundary

| `access` | Who reaches it |
|---|---|
| `'staff'` *(default)* | `admin`, `editor`, `author` or `manager` — **not** `viewer` |
| `'admin'` | administrators only |
| `'public'` | anyone, unauthenticated |

`'public'` means an unauthenticated endpoint — exactly what a checkout or a
provider webhook needs, and exactly what must never happen by accident. It is
declared per route, per method.

**Public does not mean unprotected.** Writes are still CSRF-checked and
rate-limited. `csrf: 'exempt'` exists for machine callers that authenticate
themselves another way — a signed provider webhook — and for nothing else. A
cookie-authenticated endpoint with CSRF off is a cross-site request away from
being called by any page on the internet.

A route that declares no `scope` is unreachable by a **scoped** API key, because
core's scope map cannot know about a path added at runtime and an unknown path
denies. Declare one to let a headless storefront call it.

### Scopes: `resource:read|write|*`, and named actions

A declared `scope` must be one an operator can **mint** — anything else is
refused at registration, because a route no key can reach is a route that
registered fine and then silently never works. Two grammars:

- `<resource>:<read|write|*>` for the resources core path-maps
  (`posts`, `content`, `media`, `products`, `orders`, `customers`, `messages`,
  `finance`);
- **named actions**, per resource (`NAMED_SCOPE_ACTIONS` in
  `src/lib/api-key-scopes.ts`):

| Scope | Grants |
|---|---|
| `game:play` | a plugin route that declares `scope: 'game:play'` (the campaign-games storefront routes) |
| `coupons:validate` | `POST /api/orders/quote` — pricing a basket with a `coupon_code` — and nothing else; not `POST /api/orders` |
| `stats:read` | `GET /api/stats/…` (the opt-in public order counter) |

`<resource>:*` grants every action defined for that resource. Actions are
**per resource**: `game:read`, `coupons:write` and `stats:write` are invalid,
because nothing defines them — the mint endpoint answers `422` and a route
declaring one is refused. A named resource is never path-mapped by core, so
`/api/game/…` is governed by the route's own declared scope. A key with no
scopes is unchanged: its role governs it, as before.

### `ctx.client` — who the request is for

A headless storefront calls the API from its own server, so every request
arrives from one address with the server's User-Agent. `ctx.client` is the
**shopper**:

```ts
handler: async ({ client }) => {
  // client: { ip: string | null, ua: string | null, forwarded: boolean }
  await rateLimit(`spin:${client.ip}`);
}
```

- On a request authenticated by an **API key**, `X-Client-IP` and
  `X-Client-UA` name the shopper. The IP must parse as exactly one IPv4 or
  IPv6 address; anything else falls back to the real address. The UA is
  capped at 512 characters, control characters removed.
- On an **anonymous** or **cookie-session** request those headers are
  **ignored** — anyone can send them. (So is a scoped key that the middleware
  downgraded to anonymous on a public GET.)
- `ip` is the same identity the core rate limiter counts (`locals.ip`: TRUST_PROXY
  rules, IPv6 grouped to its /64, IPv4-mapped unwrapped), so there is one notion
  of "the real address". A forwarded `X-Client-IP` goes through the same
  normalisation. `X-Client-IP` does **not** change the core limiter's buckets —
  that remains the per-key `forward_client_ip` flag and `X-AstroBaaS-Client-IP`.
- `forwarded` is `true` when either value came from a forwarding header.
- **`ip` is an identity, not always an address:** an IPv6 client is
  `2001:db8:1:2::/64`. Store it as such (a consent record keeps the /64, which
  is also the data-minimising choice).
- The headers are for **server-to-server** calls. CORS does not allow them, so
  a browser calling with a key cannot send them — by design.

Core routes get the same answer from `requestClient(Astro.locals)`
(`src/lib/client-address.ts`, also exported from `astrobaas/core`).

### What a handler gets

`{ request, url, params, user, locals, store, settings, client }`. Return a `Response`. `store` is
your plugin's own namespaced store, already bound to your id — you import
nothing, and a handler cannot reach another plugin's records by passing a
different id (see "Storage" below). Anything a handler throws is logged with the
plugin's name and answered `500` with no detail — a plugin's raw error can carry
credentials, queries and paths.

## Webhook events from a plugin

Declare the events your plugin sends, then send them with `host.webhooks.emit`:

```ts
export default function create({ definePlugin, webhooks }) {
  return definePlugin({
    id: 'campaign-games',
    webhookEvents: ['game.verified'],
    routes: [{
      method: 'POST', path: '/api/game/verify', access: 'staff', scope: 'game:play',
      handler: async (ctx) => {
        // …
        await webhooks.emit('game.verified', { campaign: id, email_hash });
        return Response.json({ success: true, data });
      },
    }],
  });
}
```

- **Delivery is the core's.** Same `X-AstroBaaS-Signature` HMAC, same delivery
  log, same retry schedule (`WEBHOOK_RETRY_DELAYS_MS`), same Redeliver button,
  same staging gate as `order.created` — `emit` hands the event to
  `deliverWebhookEvent` in `src/lib/webhooks.ts`, which `fireEvent` uses too.
  You never sign or POST anything yourself.
- **Operators subscribe to it** on Admin → Webhooks, which lists every event an
  active plugin declared, with the plugin's id, beside the core events.
- **`emit` rejects** (throws) for an event you did not declare, a name in a
  **core namespace** (`order.*`, `coupon.*`, `newsletter.*`, `consent.*`,
  `post.*`, … — `CORE_EVENT_NAMESPACES` in
  `src/lib/plugin-platform/webhook-events.ts`), another plugin's event, an
  inactive plugin, or `data` that is not JSON or is over 64 KB. A receiver
  cannot tell a plugin's `order.created` from core's, so those names are never
  a plugin's to send.
- **It resolves once the event is accepted**, without waiting for any delivery;
  retries run in the background.
- Names are lower-case dotted words (`game.verified`, `loyalty.tier_changed`).
  A bad name, a core name, or a name another plugin already declared is refused
  loudly at boot; the rest of your declaration still registers.
- `emit` is bound to the plugins your module returned. A module returning
  several plugins may emit any of their events. A **bundled** plugin (no host)
  calls `emitPluginWebhookEvent(pluginId, event, data)` from `astrobaas/core`.

Do not put personal data in an event — send a hash or an id, as core's own
events do.

**A key-only route is `access: 'staff'` plus a `scope`, not `'public'`.**
`scope` only narrows SCOPED keys; `'public'` lets an anonymous browser in (with
a CSRF token). For routes only a storefront server should call, declare
`access: 'staff'` with `scope: 'game:play'` and mint the storefront key at role
`author` or above, scoped to `game:play` alone — the scope then confines that
key to your routes.

**The guarantees above are the HOST's.** A bundled (in-tree) plugin can still
import `fireEvent` from `astrobaas/core`, which checks nothing; in-tree code is
core code. A compiled package imports nothing from the host, so
`host.webhooks.emit` is its only way to send an event.

## Admin screens

```ts
adminPages: [
  {
    path: 'orders',                    // → /admin/plugin/shop/orders
    title: 'Orders',
    nav: { label: 'Orders', order: 10 },
    roles: ['admin', 'manager'],       // omitted → ADMIN ONLY
    render: async ({ user, csrf, url }) => `<table>…</table>`,
    script: `document.querySelector('…').addEventListener(…)`,
  },
]
```

Screens are namespaced under `/admin/plugin/<plugin-id>/`. Unlike routes they
are **not** free-form, and the reason is specific: admin authorisation is
longest-prefix-wins over one shared table, so a plugin able to register
`/admin/products/bulk` would not merely add a screen — it would out-specify the
`/admin/products` rule and decide who may open everything beneath it.

Omitting `roles` means **admin only**, inherited from the rule that already
denies any unknown `/admin` path to everyone else. Forgetting is safe.

`render()` returns HTML that is inserted verbatim. A plugin is code already
running in this process, so sanitising its own UI would buy nothing and break
every real form — but **you must escape any data you interpolate.** A customer
name rendered unescaped is stored XSS aimed at your own admin.

`script` is served from `/plugin-admin.js`, same-origin, authorised with the same
rule as the page. It cannot be inline: the app ships a hash-based CSP with no
`unsafe-inline`, so an inline `<script>` is dropped by the browser silently.

## Storage

Every plugin gets a namespaced store. One plugin cannot read another's records —
that is a property of the API, not a rule to remember.

Inside a **route handler**, the store arrives on the context, already bound to
your plugin — you import nothing:

```ts
routes: [{
  method: 'GET', path: '/api/plugin/shop/orders/:id', access: 'staff',
  handler: async ({ params, store }) => {
    const order = await store.get('orders', params.id);
    return new Response(JSON.stringify({ success: true, data: order ?? null }), {
      status: order ? 200 : 404, headers: { 'Content-Type': 'application/json' },
    });
  },
}]
```

Outside a handler — in a filter, an action, a timer — a **compiled external
plugin** asks the host: `host.createStore('<your-id>')` (see "The contract").
It must import nothing from the host at runtime, so this is the only way it
gets a store there. A plugin bundled in this repository can build the same
store from the stable barrel:

```ts
import { createPluginStore, LocalDB } from 'astrobaas/core';

const store = createPluginStore('shop', LocalDB);

await store.put('orders', 'ord_1', { total_cents: 8900 });
await store.get('orders', 'ord_1');
await store.list('orders');            // capped; see below
await store.delete('orders', 'ord_1');
await store.clear('orders');
```

Migrations receive the same store as their argument (see below), so every
path — `ctx.store`, `host.createStore`, `createPluginStore`, migrations — reads
and writes the same namespaced records, on all three storage drivers.

Deliberately small: no query language, no joins, no indexes beyond the
namespace. `list()` filters in-process and is **capped at 5,000 records**. Past
that it returns the first 5,000 and logs a `console.warn` — the caller gets a
prefix with no error and no flag to check, so a plugin that can grow past the
cap must page or count some other way rather than trusting the array it got
back. A plugin regularly hitting it has outgrown this store. A plugin whose
records must never silently drop off the end (bookkeeping kept for ten years)
can pass `list(collection, { uncapped: true })` and accept the memory cost of
reading the whole collection.

Collection names may not begin with `_`; those are reserved for the platform.

Records are **not** fed to the content change feed and are exposed by no core
route. (Reusing `custom_entities` would have been less code and would have
published every plugin record at `/api/content/changes`.)

Uninstalling a plugin now deletes its data. It previously deleted one row from
the plugins table and orphaned everything the plugin had written — invisible,
unreadable, and silently inherited by a reinstall along with its schema version.

### Migrations

```ts
migrations: [
  { version: 1, name: 'add-status', up: async (store) => { /* … */ } },
]
```

Run at bootstrap, in version order, stamped after **each** one so a crash
halfway does not re-apply what already succeeded. A failure stops the run and
leaves the version at the last success — carrying on would apply v3 to data v2
never transformed.

Versioned per plugin, independently of core's schema version, so a plugin's
data model is its own.

**`up()` must be idempotent.** Migrations are serialised within a process but
not across replicas, which is the same guarantee core's own migration runner
gives.
