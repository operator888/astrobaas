# API stability

This document defines what AstroBaaS promises to theme and plugin authors, and
what it doesn't — so you can build on it without being surprised by an upgrade.

## TL;DR

- The **public API** is everything exported from **`astrobaas/core`**,
  **`astrobaas/plugins`**, and **`astrobaas/client`**. Build against those import
  paths only.
- AstroBaaS is **pre-1.0 (`@alpha`)**. The public API may still change, but every
  breaking change to it is called out in [CHANGELOG.md](./CHANGELOG.md) under a
  **Breaking** heading.
- Anything under `src/lib/*`, `src/pages/*`, `src/components/*` is **internal**
  and can change in any release with no notice. Don't import it directly.

## The public surface

Covered by the stability policy below.

### `astrobaas/plugins` (bundled plugins)

| Export | Kind | Notes |
| --- | --- | --- |
| `BUNDLED_PLUGINS` | const | The plugins that ship with AstroBaaS, in load order. Add your own entry here when you vendor a plugin into a fork; a plugin loaded from `ASTROBAAS_PLUGINS` does not need it. |

### `astrobaas/core` (server + shared)

| Export | Kind | Notes |
| --- | --- | --- |
| `Post`, `Category`, `User`, `MediaFile`, `Theme`, `ThemeConfig`, `ThemeSettings`, `Setting`, `ContentChange`, `PluginRecord`, `CustomEntity`, `ContactMessage`, `Subscriber`, `ApiKey`, `Webhook`, `WebhookDelivery`, `AuditEvent`, `PostRevision`, `TwoFactor`, `Role`, `PostStatus`, `EntityType`, `DatabaseSchema` | types | Domain models. |
| `Product`, `ProductImage`, `Brand`, `ProductCategory`, `Order`, `OrderItem`, `OrderStatus`, `Customer` | types | Commerce models. Commerce is off by default, but the types are always exported: a storefront types its catalogue against them whether or not this install serves one. |
| `Storage` | type | The storage contract the app depends on. |
| `Plugin`, `FilterFn`, `ActionFn`, `PluginSettings`, `OrderLineExtras` | types | Plugin shapes. `OrderLineExtras` is what an `order_line` filter may add to a line. |
| `PluginManager`, `pluginManager` | class/value | Hook registry + the shared instance. |
| `PLUGIN_HOOKS` | const | The canonical hook-name catalog. Always reference these constants, never raw strings. |
| `definePlugin`, `defineTheme`, `ThemeDefinition` | fn/type | Author helpers (type inference). `ThemeDefinition` is a union: a root theme carries a complete `settings`, a theme with `extends` carries a partial one. |
| `registerContentType`, `getContentTypes`, `getContentType`, `schemaForContentType`, `ContentTypeDefinition`, `ContentTypeField` | fn/registry/types | Custom content types. |
| `THEME_SLOTS`, `ThemeSlotName`, `ThemeSlotProps`, `ThemeComponents`, `HeaderProps`, `FooterProps`, `PostCardProps`, `PostCardData`, `PostArticleProps`, `PageArticleProps`, `HomeProps`, `SidebarProps`, `BreadcrumbsProps`, `BreadcrumbItem`, `TableOfContentsProps`, `TocItem`, `isThemeSlot`, `overriddenSlots` | const/types/fn | Theme template-override contract. Adding a NEW slot is additive: themes that don't know about it inherit the default, so it is not a breaking change. |
| `validateManifest`, `renderHeadTags`, `manifestContentTypes`, `apiRangeSatisfied`, `MANIFEST_API_VERSION`, `MANIFEST_LIMITS`, `PluginManifest`, `ManifestCapabilities`, `ManifestHeadTag`, `ManifestWebhook`, `ManifestValidationResult` | fn/const/types | Declarative plugin manifests. `MANIFEST_API_VERSION` is its own semver line: a manifest declares the major it targets via `astrobaasApi`, and a mismatched major is refused rather than half-honoured. Adding a capability is additive; removing or changing one is a MAJOR bump. |
| `sanitizeHtml` | fn | Allow-list HTML sanitizer; run on any author HTML before `set:html`. |
| `validate`, `slugify`, `Schema`, `FieldRule`, `ValidateOk`, `ValidateErr` | fn/types | Input validation. `validate` returns the `ValidateOk` \| `ValidateErr` union — narrow on `ok` rather than reading `.data` blind. |
| `ApiResponseBuilder`, `ApiResponse`, `ApiSuccessResponse`, `ApiErrorResponse` | class/types | The house response shape for custom endpoints. Preserve the service layer's status at the route boundary — 400 and 409 mean different things to a client. |
| `fireEvent`, `webhookMatches`, `webhookBody`, `WEBHOOK_EVENTS` | fn/const | Outbound webhook dispatch + helpers. |
| `signWebhook`, `newWebhookSecret` | fn | HMAC signing for webhook payloads (also for verifying receivers). |
| `sendEmail`, `getEmailTransport`, `setEmailTransport`, `consoleTransport`, `webhookTransport`, `EmailMessage`, `EmailTransport` | fn/type | Pluggable email transport. |
| `recordAudit`, `AUDIT`, `AuditDetails` | fn/const/type | Security audit log — record sensitive actions from plugins/custom routes. |
| `reportError` | fn | Structured error reporting from a plugin or custom route. Never throws, so it is safe on an error path. |
| `plainText`, `countWords`, `sentences`, `decodeEntities`, `truncateWords` | fn | Text extraction from stored HTML. Exported so a plugin computing a read time or an excerpt uses the same stripper as the byline and the editor's analysis panel — five private copies once existed and two disagreed about whether a tag boundary is a word boundary. The bundled `reading-time` plugin is the worked example. |
| `organizationNode`, `webSiteNode`, `articleNode`, `webPageNode`, `collectionPageNode`, `productNode`, `siteIdentityNodes`, `structuredData`, `SdContext`, `ArticleInput`, `ProductInput` | fn/types | schema.org builders. Pure functions, no I/O — a decoupled storefront that renders its own product pages emits the same nodes the built-in front end does. |
| `createPluginStore`, `PluginStore`, `LocalDB` | fn/type/value | Namespaced plugin storage for use OUTSIDE a route handler (filters, actions, scheduled work); inside one prefer `ctx.store`, already bound to the owning plugin. `LocalDB` is promised **only** as the backend argument to `createPluginStore` — its own wider surface is internal and may change. |
| `getPluginSettings`, `getPluginSetting` | fn | A plugin's own settings — the record an operator edits on its admin screen. Scoped to a plugin id, so a plugin cannot read its neighbour's. Read where you use the value, not once at `activate()`: an operator who changes a setting does not restart the site. |
| `PaymentProvider`, `PaymentOutcome`, `PaymentStatus`, `WebhookVerificationError`, `ManualMethodDef` | types/class | The payment-gateway contract, so a gateway can be shipped as a plugin without reading `src/lib/payments/*`. A provider's own verification error must merely END in `VerificationError` for the platform to answer 401 rather than 500. |
| `api`, `apiFetch`, `configureApiClient`, `ApiResult`, `ApiFetchOptions` | fn/types | CSRF-aware browser fetch helper, for client-side scripts a theme or a plugin admin page ships. Server-side callers want `astrobaas/client` instead. |

### `astrobaas/client` (frontend SDK)

| Export | Kind | Notes |
| --- | --- | --- |
| `createClient`, `AstroBaasClient` | fn/class | Typed REST client over bearer auth. |
| `AstroBaasError` | class | Thrown on non-2xx / `{success:false}`; carries `status`, `code`, `details`. |
| `verifyWebhookSignature` | fn | Receiver-side HMAC verifier (WebCrypto, constant-time). |
| `ClientOptions`, `ListPostsOptions`, `ListProductsOptions`, `ListOrdersOptions`, `Page`, `PageMeta`, `CreatePostInput`, `UpdatePostInput`, `RelatedPostSummary`, `BasketLine`, `CheckoutAddress`, `CheckoutInput`, `CreateKeyInput`, `CreatedKey`, `ApiKeyInfo`, `RegisterWebhookInput`, `RegisteredWebhook`, `WebhookInfo`, `WebhookDeliveryInfo`, `AuditEventInfo`, `LocaleConfig`, `ContentApi`, `CurrentPrincipal`, `ApiKeyPrincipal` | types | SDK input/output shapes. |

## Exported, but not part of the promise

A module can export something because the application itself imports it across
files. That is not a promise to anyone outside. These names are reachable and
are **not** covered:

| Export | Where | Why it is not promised |
| --- | --- | --- |
| `ensurePluginsBootstrapped`, `reloadPlugins`, `pluginBootstrapReport`, `PluginBootstrapReport` | `astrobaas/plugins` | The bundled-plugin loading mechanism. The middleware and a dozen routes call these; a plugin must not, because when they run and what they rebuild is exactly the internal detail this document reserves the right to change. |
| `redeliver` | `src/lib/webhooks.ts` | Re-sending a logged delivery is an operator action with its own authenticated route (`POST /api/webhooks/deliveries/{id}/redeliver`) and client method (`baas.webhooks.redeliver(id)`). Go through those, so the role check runs. |

`tests/stability.test.mjs` asserts this list is exhaustive: every export of the
three public barrels is either documented above or named here, so the document
cannot drift behind the code again.

## Policy

**While pre-1.0:**

- Additive changes (new exports, new optional fields, new hooks) can land in any
  minor release.
- Breaking changes to the public surface are allowed but will be:
  1. listed under **Breaking** in the CHANGELOG, and
  2. accompanied by the reason and a migration note.
- Hook names in `PLUGIN_HOOKS` will not be silently renamed or removed — a
  removed hook is a documented breaking change.

**At 1.0 and after** the public surface follows semver: breaking changes only in
major versions.

## What is explicitly *not* covered

- Internal modules (`src/lib/*`, `src/middleware.ts`, route files, components).
- The on-disk `db.json` format (it's seeded/migrated by the app; don't write it
  directly — go through `Storage`).
- The admin UI markup/DOM structure.
- The bundled-plugin loading mechanism's internals (use the documented
  `BUNDLED_PLUGINS` registry).

## Hook contract

Each hook in `PLUGIN_HOOKS` documents its kind (filter/action) and payload in
[PLUGIN_DEVELOPMENT.md](./PLUGIN_DEVELOPMENT.md). Filters must return the same
type they receive. `post_content` filter output is re-sanitized at the render
boundary, so a content filter cannot introduce XSS.
