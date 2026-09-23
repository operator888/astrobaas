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
| `PRODUCT_PRICE` | filter | `(priceCents, product, ctx: { qty, variant }) => number` | Final unit price at checkout — sales rules, volume discounts, member pricing. `ctx.variant` is the `ResolvedPurchasable` this line is buying (`price_cents`, `sku`, `stock`, and `variant_id` / `options` on a variable product), so a rule can price one size differently from another. `priceCents` is already `ctx.variant.price_cents`. Must return **integer cents**; anything else fails the checkout with a 500 rather than charging a guess. |
| `BEFORE_ORDER_SAVE` | filter | `(order, ctx: { isNew }) => order` | Before an order persists (checkout or admin edit). Validation runs **before** this hook; totals are re-checked **after** it. |
| `AFTER_ORDER_CREATE` | action | `(order: Order) => void` | Checkout completed. The hook the new-sale notifier uses. |
| `AFTER_ORDER_STATUS_CHANGE` | action | `(order, previousStatus) => void` | After a status change, with the status it left. |
| `ORDER_LINE_EXTRAS` | filter | `(result, ctx: { line, product, name }) => result` | **The vertical's extension point.** Return `{ ok: true, patch }` to accept (patch is frozen onto the stored line) or `{ ok: false, message, code?, params? }` to refuse the whole order with a 400. `message` is the English fallback; `code` is a stable machine-readable reason (`optical.prescription_required`) and `params` the values a storefront needs to build its own sentence — both optional, so a plugin built before they existed keeps working, and both are how a refusal gets translated at all (core returns `message` verbatim and the plugin is not in this repository). **If the incoming value is already `ok: false`, return it unchanged** — a refusal must survive later plugins. With no plugin registered the initial value passes through, so an install without your module accepts the order and stores the raw data instead of 500ing. |
| `COMMERCE_SCHEMA` | filter | `(schema, ctx: { name, variant? }) => schema` | Publish a machine-readable schema for a storefront form (this is how the optical module serves `/api/commerce/prescription-schema`). Initial value is `null`; return it **unchanged** for names you don't recognise. Core answers 404 while it stays null — which is also what an install without the module should look like. |
| `PAYMENT_PROVIDERS` | filter | `(providers: PaymentProvider[]) => PaymentProvider[]` | Contribute payment gateways. Collected once at bootstrap from **active** plugins only. See "Payment providers from a plugin" below. |
| `MANUAL_METHODS` | filter | `(methods: ManualMethodDef[]) => ManualMethodDef[]` | Contribute manual (offline) payment methods. A manual id that shadows a gateway id is **refused** — otherwise a shop could accept as unpaid what it believes was charged. |

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

`host` carries four things, and the set is additive — a module that destructures
only the first two keeps working:

| Key | What it is |
| --- | --- |
| `definePlugin` | This host's identity helper, with this host's hook typing. |
| `PLUGIN_HOOKS` | This host's hook-name constants. Never hard-code the strings. |
| `text` | `{ fold, transliterate }` — the core's own text utilities, exposed so a module cannot fold search terms differently from the core that ranks them. |
| `getSettings` | `() => Promise<Record<string, unknown>>` — every setting as a **map**, not the row array. **Async, so it is usable from an admin page's `render` but not from a synchronous filter** — a filter that needs its own configuration must be handed it by its call site, the way `SEARCH_EXPAND` passes `ctx.settings`. |

```ts
export default function create({ definePlugin, PLUGIN_HOOKS, text, getSettings }) {
  return definePlugin({ /* … */ });
}
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
import nothing (see "Storage" below). Outside handlers, the factory pattern
still applies: do the work inside hooks and routes, which is where the host
hands you what you need.

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

### Widening a gate requires the `/api/plugin/` namespace

`access: 'public'`, `csrf: 'exempt'` and `scope` are **refused outside
`/api/plugin/`**, and the reason is a real hole that this closed.

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

### What a handler gets

`{ request, url, params, user, locals, store }`. Return a `Response`. `store` is
your plugin's own namespaced store, already bound to your id — you import
nothing, and a handler cannot reach another plugin's records by passing a
different id (see "Storage" below). Anything a handler throws is logged with the
plugin's name and answered `500` with no detail — a plugin's raw error can carry
credentials, queries and paths.

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

Outside a handler — in a filter, an action, or setup code — build it yourself
from the stable barrel:

```ts
import { createPluginStore, LocalDB } from 'astrobaas/core';

const store = createPluginStore('shop', LocalDB);

await store.put('orders', 'ord_1', { total_cents: 8900 });
await store.get('orders', 'ord_1');
await store.list('orders');            // capped; see below
await store.delete('orders', 'ord_1');
await store.clear('orders');
```

Migrations receive the same store as their argument (see below), so all three
paths read and write the same namespaced records.

Deliberately small: no query language, no joins, no indexes beyond the
namespace. `list()` filters in-process and is **capped at 5,000 records**. Past
that it returns the first 5,000 and logs a `console.warn` — the caller gets a
prefix with no error and no flag to check, so a plugin that can grow past the
cap must page or count some other way rather than trusting the array it got
back. A plugin regularly hitting it has outgrown this store.

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
