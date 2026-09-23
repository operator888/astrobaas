# Storage & deployment

AstroBaaS persists through a pluggable adapter chosen at boot from the
environment. All application code depends on the `Storage` contract
(`src/core/storage.ts`), so the engine is swappable without touching routes,
plugins, or the admin.

## Drivers

| `DATABASE_URL` | `DATABASE_DRIVER` | Driver | Use for |
| --- | --- | --- | --- |
| *(unset)* | — | **lowdb** (JSON file at `DB_PATH`) | Zero-config local dev. |
| `file:./data/astrobaas.db` | *(unset)* | **libSQL doc-blob** (local SQLite) | Durable single-host / VPS. |
| `libsql://<db>.turso.io` (+ `DATABASE_AUTH_TOKEN`) | *(unset)* | **libSQL doc-blob** (remote / Turso) | Durable, deploy-portable. |
| `file:` or `libsql://…` | `relational` | **relational libSQL** (per-entity rows) | **Production multi-writer / multi-host.** |

All three are exercised by the smoke suite: `npm run smoke` (lowdb),
`npm run smoke:libsql` (doc-blob), `npm run smoke:relational` (relational) — and
all three run in CI.

## The relational driver (recommended for production)

Set `DATABASE_DRIVER=relational` (with a `file:` or `libsql://` `DATABASE_URL`)
to use the **per-entity** engine (`src/lib/storage/sql-storage.ts`): each
collection is its own table of `(id, data)` rows. Versus the doc-blob adapter
this gives:

- **Row-level concurrency** — two writers touching different rows never clobber
  each other (the doc-blob model is whole-document last-write-wins).
- **Partial updates** — a write touches one row, not the entire dataset.
- **Queryability** — indexed columns / `json_extract` filters instead of loading
  everything into memory.

It implements the same `Storage` surface, so `LocalDB` delegates to it with no
route/plugin/admin changes. Entities are stored as JSON in a `data` column — real
per-row storage without hand-maintaining a column per field while the alpha schema
still moves; hot lookups (by email, key hash, slug, setting key) use `json_extract`.

**The content change feed is capped at 1,000 entries on every driver.** The
document drivers always kept a 1,000-entry ring; the relational
`content_changes` table now keeps the same number, pruned in the same batch as
each insert (never more than 200 rows of a backlog per write). A database
created before that is pruned in the background after its first boot: the
instance serves from the moment its schema exists and the prune runs behind it
in 1,000-row steps, yielding to requests in between — it does not hold the boot
up, and reads stay bounded by their own limit while it runs. Reads are served by
a `(ts, id)` index, built by that same background step after the prune. What
retention evicts is recorded per entity type in `content_changes_pruned`, which
is where the feed's `meta.truncated` comes from. The file does not shrink until
you `VACUUM`. See `src/core/change-feed.ts` and INTEGRATION.md §5.

Local `file:` databases wait up to 5 seconds for a lock held by another process
before a statement fails with `SQLITE_BUSY` (libsql's own default is to fail at
once). Two instances writing one file — an overlapping deploy, several workers
on one host — queue behind each other instead of failing.

```bash
# Production example (Turso, relational)
DATABASE_URL=libsql://my-app.turso.io
DATABASE_AUTH_TOKEN=...           # from `turso db tokens create`
DATABASE_DRIVER=relational
AUTH_SECRET=$(openssl rand -hex 32)
NODE_ENV=production
```

## Why this matters for deployment

The lowdb JSON file lives on local disk, so it can't be shared across instances
and is wiped on ephemeral/serverless filesystems. Pointing `DATABASE_URL` at a
**remote libSQL/Turso** database gives durable, network-attached storage that
survives redeploys and works when more than one instance is running — which is
what a hosted/serverless deployment of a vibe-coded frontend needs.

```bash
# Production example (Turso)
DATABASE_URL=libsql://my-app.turso.io
DATABASE_AUTH_TOKEN=...           # from `turso db tokens create`
AUTH_SECRET=$(openssl rand -hex 32)
NODE_ENV=production
```

On first boot against an empty database, AstroBaaS seeds the schema defaults and
the `admin@local` account automatically (same as the JSON path) — no migration
step to run.

## Choosing between the libSQL drivers

- **doc-blob** (`DATABASE_URL` only): the whole dataset is one JSON row. Durable
  and deploy-portable, but writes are last-write-wins across instances (fine for
  a single long-lived process; risky for multi-instance write traffic). The
  scheduler and migration leases (a separate `leases` table) and the newsletter
  batch claim (a compare-and-swap of the whole document) are the only writes on
  this driver that are safe across processes.
- **relational** (`+ DATABASE_DRIVER=relational`): per-entity rows with row-level
  writes — the right choice for multi-writer / multi-host. Recommended for
  production.

The relational engine stores each entity as a JSON `data` column rather than a
fully-normalized column-per-field schema. That's a deliberate alpha trade-off
(real per-row concurrency now, without freezing the still-evolving field set);
a fully-normalized schema with typed columns + foreign keys is a future
refinement and, because everything goes through the `Storage` interface, drops in
without touching application code.

## Local SQLite files: WAL, a second process, and backups

When `DATABASE_URL` is a `file:` URL, every client that opens it — the
relational driver, the doc-blob driver and the shared rate-limit store — goes
through one opener (`src/lib/storage/local-sqlite.ts`), which sets:

| Setting | Value | Why |
| --- | --- | --- |
| `journal_mode` | `WAL` | Readers no longer block the writer, nor the writer readers. Stored in the file, so it holds for every process that opens it afterwards. |
| `busy_timeout` | 5000 ms, on every connection | A second process that meets the lock **waits** instead of failing with `SQLITE_BUSY` at once. On the **relational** driver that makes a second writer (an ERP sync, `npm run import:woo`, a second replica) safe: each write is one statement on one row. On **doc-blob** it only removes the error — see below. |
| `synchronous` | `NORMAL` | No fsync per commit. Cannot corrupt the file in WAL mode; a commit made in the moments before a power loss (not a process crash) can roll back. |

Remote `libsql://` / Turso URLs are left exactly as they were.

**A second writer on the doc-blob driver loses data silently.** Doc-blob keeps
the whole site in one row, and every write replaces that row with the writing
process's copy. Two processes writing at once each overwrite the other's
changes — no error, just rows missing afterwards. Before the busy timeout that
collision failed loudly with `database is locked`; now it succeeds and loses.
On doc-blob, **stop the site before running anything that writes** to the
database, or move the shop to `DATABASE_DRIVER=relational`, where a writing CLI
can run beside it. `npm run import:woo -- <dir> --apply` refuses a doc-blob
`DATABASE_URL` unless you pass `--site-stopped`. (`npm run reset-password` does
not apply: it edits `db.json` only and refuses to run with a `DATABASE_URL`.)
Readers, backups and the shared rate-limit store are safe beside a running site
on either driver.

**Backups under WAL.** In WAL mode the newest commits live in the `-wal` file
beside the database until a checkpoint folds them in, so copying the main file
alone loses them. The admin export and the scheduled off-site backup take a
`VACUUM INTO` snapshot instead: one consistent, self-contained file. If you back
the database up yourself, do the same — `sqlite3 data/astrobaas.db
"VACUUM INTO '/backups/astrobaas.db'"` or `.backup` — and never `cp` the `.db`
file on its own while the site is running.

## Moving between drivers

**The backup tools will not do this.** Export is driver-aware and restore is
same-driver only, in both directions — deliberately, because the alternative is
a restore that reports success and changes nothing the site reads.

What `/api/backup/export` produces (`src/lib/backup/offsite.ts:197-225`):

| Install | Archive |
| --- | --- |
| lowdb (no `DATABASE_URL`) | JSON: `{db, uploads}` |
| a `file:` `DATABASE_URL` (doc-blob or relational) | a `VACUUM INTO` snapshot of the SQLite file, `kind: 'libsql-file'` |
| a remote `libsql://` / Turso database | **refused** — there is no local file to copy. Use `turso db dump` and that provider's tooling |

What `/api/backup/import` accepts (`src/pages/api/backup/import.ts`):

| Archive | Site running on | Result |
| --- | --- | --- |
| JSON | lowdb | restored |
| JSON | any `DATABASE_URL` | **400** — libSQL would ignore the file (`:123-127`) |
| SQLite snapshot | a `file:` `DATABASE_URL` | the database file is replaced, and the site **must be restarted**: this process reads the restored database, other processes and in-memory caches still hold the old site (`:95-118`) |
| SQLite snapshot | lowdb, or a remote `libsql://` | **400** (`:242-256`) |

### How to move content across drivers instead

There is no one-button migration, and each of these is a different job:

- **Through the API.** Every route goes through the same `Storage` contract
  whichever driver is underneath, so reading from the old install and writing
  into the new one is driver-agnostic — and it is the only route that works
  while both are running.
- **Through the importers.** `npm run import:wp` and `npm run import:woo` go
  through `LocalDB` too, so they write to whatever `DATABASE_URL` and
  `DATABASE_DRIVER` say. If the content came from WordPress or WooCommerce in
  the first place, re-running the import against the new install is usually
  less work than moving rows. (`npm run import:md` is the exception: it goes
  through `scripts/lib/db-target.mjs` and refuses when `DATABASE_URL` is set,
  like `npm run setup` and `npm run reset-password`.)
- **Between two libSQL databases on the same `DATABASE_DRIVER`** — a `file:`
  one and Turso, either direction — nothing has to be translated: it is the same
  schema. Use the database's own tooling (`turso db dump`, `VACUUM INTO` for a
  file). Changing `DATABASE_DRIVER` is not this case: doc-blob and relational
  are different schemas.
- **Uploads travel separately** in every case: `rsync` `UPLOADS_DIR` and
  `PRIVATE_UPLOADS_DIR`. File records store paths relative to the directory, so
  moving each one whole is all that is needed.
