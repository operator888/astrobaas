# Architecture

How AstroBaaS is put together, and why. For what the API looks like from
outside, read [INTEGRATION.md](./INTEGRATION.md); for the extension seams,
[PLATFORM.md](./PLATFORM.md).

## The shape

One Astro application, server-rendered on the Node adapter
(`output: 'server'`, `astro.config.ts`), serving three things from the same
process:

- **an admin** under `/admin` — the screens an operator works in;
- **a JSON API** under `/api` — what a headless storefront, a script or an
  agent talks to;
- **public pages** — blog, catalogue, feeds, sitemap, OG images — for installs
  that use the built-in front end rather than their own.

There is no build step between writing a post and serving it. A request reads
the database and renders; publishing is a write, not a deploy.

## A request

```
request → observe → main middleware → route → storage
```

`src/middleware.ts` is the single gate, composed as `sequence(observe, main)`.
In order, it: counts the request for metrics and the in-flight gauge, answers
maintenance mode, applies CORS and security headers, resolves the caller
(cookie session, bearer API key, or anonymous) and their role, enforces rate
limits and body limits, and only then hands off to the route. Everything that
must be true of *every* request lives there, so a new route cannot forget it.

Routes are Astro endpoints under `src/pages`. API routes return one envelope
shape (`src/lib/api-response.ts`): `{ success, data, meta }` or
`{ success: false, error: { message, code } }`.

## Storage

Routes never talk to a database driver. They call `LocalDB`
(`src/lib/localdb.ts`), which implements the `Storage` interface
(`src/core/storage.ts`) over one of three drivers, chosen at boot from the
environment (`src/lib/storage/select-adapter.ts`):

| Driver | Selected by | Shape |
| --- | --- | --- |
| lowdb JSON | default | one JSON document; zero configuration |
| libSQL doc-blob | `DATABASE_URL` | the same document in one SQLite row |
| relational | `DATABASE_URL` + `DATABASE_DRIVER=relational` | one row per entity, partial updates, real concurrency |

The interface is the seam: the smoke suite runs against all three in CI, so a
driver that disagrees with the others fails the build rather than a customer's
site. Local SQLite files are opened through one place
(`src/lib/storage/local-sqlite.ts`) that sets WAL, a busy timeout and
`synchronous=NORMAL` on every connection — see [STORAGE.md](./STORAGE.md).

## Extension seams

- **Plugins** (`src/lib/plugin-system.ts`) register filters and actions on
  named hooks, can serve their own API routes and admin screens, and get a
  namespaced store. Bundled ones live in `src/plugins`; third-party ones load
  from `ASTROBAAS_PLUGINS`.
- **Themes** (`src/core/theme-slots.ts`) replace named template slots. A theme
  supplies what it wants and inherits the rest, so adding a slot never breaks
  an existing theme.
- **Content types** registered by a plugin get CRUD at `/api/content/<type>`
  with the same auth and validation as built-in types.
- **Payment providers** implement one interface (`src/lib/payments/types.ts`)
  and are discovered from the registry, from core or from a plugin.

See [PLUGIN_DEVELOPMENT.md](./PLUGIN_DEVELOPMENT.md) and
[THEME_DEVELOPMENT.md](./THEME_DEVELOPMENT.md).

## Background work

A scheduler (`src/lib/scheduler.ts`) runs the periodic work: publishing
scheduled posts, expiring payment holds, cancelling abandoned orders, sending
back-in-stock notices and newsletter batches, sweeping old uploads, pushing
off-site backups. With more than one process on one database, exactly one
sweeps at a time, decided by a lease (`src/lib/lease.ts`); migrations take a
lease of their own. See `deploy/README.md` §2c.

## Content pipeline

Stored post content is raw HTML. It is sanitised on save
(`src/lib/sanitize.ts`), and rendered through plugin filters on read, so
`content` is the source of truth and `content_rendered` is derived. Media is
ingested once into a fixed set of derivative widths
(`src/lib/media/derivatives.ts`) rather than transformed per request.

## What this deliberately is not

- **Not a static site generator.** Content is read per request.
- **Not multi-tenant.** One install serves one site.
- **Not clustered by default.** Several processes can share a libSQL database
  and the shared rate-limit store; uploads are still local disk.
