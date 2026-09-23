# AstroBaaS as a platform

AstroBaaS is built so theme and plugin authors have **stable contracts** to build
against. This doc summarizes the extensibility surface and what's intentionally
deferred. For the stability guarantee see [STABILITY.md](./STABILITY.md); for
hands-on plugin docs see [PLUGIN_DEVELOPMENT.md](./PLUGIN_DEVELOPMENT.md).

## Architecture seams

The codebase is layered so the expensive-to-change parts are isolated behind
interfaces:

```
astrobaas/core (public barrel)  ← authors import only this
        │
        ├── models        pure domain types (Post, User, Theme, ...)
        ├── Storage       storage contract; LocalDB implements it
        ├── PluginManager filters/actions + PLUGIN_HOOKS catalog
        ├── content-types registerContentType() for custom collections
        ├── sanitizeHtml  allow-list HTML sanitizer
        └── validate      schema validation
                │
        src/lib/*  (internal: lowdb engine, middleware, routes — may change)
```

- **Models are storage-independent** (`src/core/models.ts`) — the data model
  doesn't depend on the database engine.
- **`Storage` is an interface** (`src/core/storage.ts`); `LocalDB` conforms via
  a compile-time check. A different backend is a drop-in.
- **Plugins/themes import from `astrobaas/core`**, never internal paths.

## What authors can do today

| Capability | Mechanism |
| --- | --- |
| Transform post content/title/list | `POST_CONTENT`, `POST_TITLE`, `API_POSTS_GET` filters |
| Validate/mutate posts before save | `BEFORE_POST_SAVE` filter |
| React to post create/update/delete | `AFTER_POST_SAVE`, `AFTER_POST_DELETE` actions |
| Inject `<head>` markup | `HEAD_TAGS` filter (sanitized) |
| Add custom content types | `registerContentType()` → generic `/api/content/<type>` CRUD |
| Customize theme tokens | `defineTheme()` + the `ThemeConfig` model (SSR-applied) |
| Reuse core utilities | `sanitizeHtml`, `validate`, `slugify`, `ApiResponseBuilder`, `api` client |

Persisted plugin activation survives restarts; the model is single-node,
trusted, in-process (no sandbox) — appropriate for self-hosting.

## Deferred (planned, contracts not yet frozen)

These are intentionally **not** in the alpha — documented so the boundary is
clear, not hidden:

1. **Installable npm package / Astro integration.** Today AstroBaaS is a repo you
   clone and run. Becoming `npm i astrobaas` that drops into an existing Astro
   project (injectable routes, adapter-agnostic middleware) is a larger change
   gated on real-world usage.
2. **Field-rich content types** — relations, media fields, repeatable groups,
   and an admin UI for custom types. The current `registerContentType()` proves
   the primitive (scalar fields + generic CRUD API); richer schemas layer on
   without changing the registration contract.
3. **Theme/plugin marketplace + dynamic loading from npm.** The static bundled
   registry (`src/plugins/index.ts`) is the alpha model: explicit, reviewable,
   safe.
4. **Multi-process / clustered deployment.** Partly there: the scheduler and
   the migrations run in one process at a time under a database lease, and
   settings, redirect and plugin changes reach every process within seconds
   (UPGRADE.md U-19). Still single-node on the DEFAULTS: the lowdb file and
   the in-memory rate limiter, both replaceable (`DATABASE_URL`,
   `RATE_LIMIT_STORE=libsql`), and local-disk uploads, which are not (see
   SECURITY.md, STORAGE.md).

## Stability promise (short version)

Everything exported from `astrobaas/core` is the public API. Pre-1.0 it may
change, but breaking changes are always called out under **Breaking** in
[CHANGELOG.md](./CHANGELOG.md), and hook names are never silently renamed.
