# Running a staging copy

A staging site is a clone of production, and that is exactly what makes it
dangerous: **the switches that ought to make it safe live in the database, so
they arrive with the clone.** A fresh copy of a live shop starts out
indexable, pointed at production's webhook endpoints, and reporting into
production's analytics property.

A checklist would fix that. A checklist also gets skipped on the third refresh,
which is why the three that matter are enforced by the environment instead.

## Set one variable

```bash
STAGING=1
```

That is the whole switch. With it set, this deployment:

| | |
|---|---|
| **Stays out of search** | `noindex` on every page, `Disallow: /` in `robots.txt`, an empty `sitemap.xml`, and an empty feed. (`llms.txt` and `openapi.json` are *not* covered — neither route knows anything about staging. They describe the site as usual, so treat them as public if that matters.) |
| **Fires no webhooks** | `fireEvent` returns immediately. A test order cannot call the real fulfilment partner. |
| **Loads no analytics** | `configuredAnalytics` returns nothing, so production's GA4 or Plausible property never sees test traffic. |

It is deliberately **one-way**. `STAGING=1` can force a site to hide; nothing in
the environment can force a site to be *indexed*. A variable that could un-hide a
site the operator deliberately hid would be a way to publish a private site by
editing a deploy config.

The admin's **Settings → Reading** screen says so in words when it is on, rather
than showing a ticked box the operator never ticked — the checkbox keeps showing
the *stored* value, and a note explains who is overriding whom.

## The rest of the environment

`STAGING=1` covers the three that travel in the database. These are separate
because they are environment to begin with, and getting them wrong is quieter:

```bash
# Its own everything. Sharing any of these with production is the whole risk.
AUTH_SECRET=<a different secret>        # sharing it makes production sessions valid here
DATABASE_URL=<its own database>         # or DB_PATH for the lowdb driver
UPLOADS_DIR=/var/www/shop-staging/shared/uploads

# Off, or pointed somewhere harmless.
SCHEDULER_DISABLED=1                    # no scheduled publishing, no off-site backup
# EMAIL_TRANSPORT unset  → falls back to console; nothing reaches a real inbox
# BACKUP_S3_* unset      → staging must never write to production's bucket
# PAYMENTS_ENABLED unset → no live payment session can be created
```

**`AUTH_SECRET` is the one people share by accident.** It signs session cookies,
so a shared secret means a session minted on staging is valid on production and
the other way round — including one minted for a test admin account.

## Refreshing from production

```bash
# 1. On production: export.
curl -sS -X GET https://shop.example.com/api/backup/export \
  -H "Cookie: $ADMIN_COOKIE" -o backup.json

# 2. On staging: import.
curl -sS -X POST https://staging.example.com/api/backup/import \
  -H "Cookie: $STAGING_COOKIE" -H 'Content-Type: application/json' \
  --data-binary @backup.json
```

**That pair works when production and staging are on the same driver, and only
then.** Export is driver-aware: a lowdb install gets the JSON archive above, an
install with a `file:` `DATABASE_URL` gets a `VACUUM INTO` snapshot of the
SQLite file, and a remote Turso database is refused outright — there is no local
file to copy (`src/lib/backup/offsite.ts:197-225`). Restore then accepts only
the shape the target itself runs: JSON onto lowdb, a SQLite snapshot onto a
`file:` `DATABASE_URL`, everything else a 400
(`src/pages/api/backup/import.ts:95-127`, `:242-256`). A restored SQLite file
also needs the staging site restarted before it is really the live one.

Across drivers, or from a Turso production database, copy it with the provider's
own tooling (`turso db dump`, or `VACUUM INTO` for a file) and `rsync`
`UPLOADS_DIR`. STORAGE.md has the full table.

### After every refresh

The import brings production's settings back, so re-do the things that are
*data* rather than environment. `STAGING=1` already neutralises indexing,
webhooks and analytics — these are the rest:

- **Customer email addresses are now on staging.** They are personal data in a
  second place. Either accept that and secure it like production, or scrub the
  customers, orders and subscribers collections after the import.
- Re-check **Settings → Payments**: a stored provider key is data and travelled
  with the clone.

### Assert it, do not assume it

Commands rather than prose, because a checklist item you cannot run is a
checklist item nobody runs:

```bash
curl -s https://staging.example.com/robots.txt | grep -q '^Disallow: /$' && echo "hidden OK"
curl -s https://staging.example.com/ | grep -q 'name="robots" content="noindex' && echo "noindex OK"
curl -s -o /dev/null -w '%{http_code}\n' https://staging.example.com/healthz  # expect 200
curl -s https://staging.example.com/sitemap.xml | grep -c '<url>'   # expect 0
```

`/healthz`, not `/readyz`: the shipped nginx vhost and Caddyfile both restrict
`/readyz` to loopback (`deploy/nginx/astrobaas.conf:480-484`,
`deploy/caddy/Caddyfile:182`), so over the public hostname it prints 403 on a
perfectly healthy site. Check readiness on the box itself:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:<port>/readyz
```

If the first two do not print `OK`, `STAGING=1` is not reaching the process —
check the unit's `EnvironmentFile` rather than editing settings in the admin,
because the admin cannot fix this one.

## Why the environment and not a setting

Because a setting is data, and data is what a refresh overwrites. The failure
this design prevents is specific and it has happened to other people: a staging
clone of a live shop enters the index, ranks for the shop's own product names,
and splits its traffic — discovered weeks later, from Search Console, by
somebody wondering why sales dipped.
