# Maintenance mode

Two different outages need two different answers, and only one of them can be
served by the application.

| | Process | Served by | Covers |
|---|---|---|---|
| **In-app** | running | AstroBaaS | migrations, plugin installs, planned windows |
| **Static** | stopped | your reverse proxy | the redeploy itself |

An in-app maintenance page cannot cover a redeploy, because during a redeploy
there is no app. Shipping only the first would be a comforting thing to have and
useless in the minute it was bought for.

---

## 1. In-app

### The emergency switch

```bash
MAINTENANCE_MODE=1
MAINTENANCE_MESSAGE="Upgrading the shop — back shortly."   # optional
MAINTENANCE_UNTIL=2026-08-25T18:00:00Z                     # optional
```

An **environment variable**, deliberately, because the commonest reason to need
this page is that the database is migrating, busy, or unreachable — and a flag
stored in the database would be unreadable exactly when it is needed. The check
runs before anything touches storage or loads a plugin.

### The scheduled window

**Admin → Settings → Maintenance mode.** A checkbox, a message, and an optional
"expected back". Use this for planned work; it needs a healthy database, which a
planned window has by definition.

The difference that matters: during a scheduled window **staff still see the
real site**, so you can check it before reopening. The emergency switch cannot
offer that — it answers before any session is read, which is the whole point.

### What visitors get

`503 Service Unavailable`, with `Retry-After` and `Cache-Control: no-store`.

**Not 200.** A success status tells a crawler that this *is* your content now;
sites have lost rankings to a maintenance notice served with 200. `503` says
"temporarily unavailable, come back", which is both true and the thing search
engines are built to handle. API callers get the same status as JSON with
`code: "MAINTENANCE"`, so a headless storefront does not have to parse HTML to
find out.

### What stays open, and why each one has to

| Path | Because |
|---|---|
| `/healthz`, `/readyz`, `/metrics` | a host that cannot health-check the process pulls it out of rotation, and your holding page becomes a connection error |
| `/api/health/*` | a deploy turns maintenance on, deploys, then asserts the deep check before turning it off. A gate whose own exit condition cannot pass it is a gate nobody opens |
| `/api/payments/webhook/*` | **the one that costs money.** A shopper who paid a minute before the window opened is still being confirmed by Stripe, PayPal or Klarna. Answered 503, the capture waits for the provider's retry schedule — hours, for some — and the order sits "pending" with the money already taken. Each webhook authenticates itself by signature or credentialled fetch-back, so letting it through exposes nothing the closed shop was hiding |
| `/admin` | an operator locked out of the admin cannot turn maintenance **off** |
| `/login`, `/logout`, `/forgot-password`, `/reset-password`, `/api/auth/*` | logging in is how you reach the admin — including for the operator who has to reset a password to get there |
| `/_astro/`, `/favicon*` | the admin behind the page is a real application |

The list is `ALWAYS_OPEN_PATHS` in `src/lib/maintenance.ts:158-194`. Matching is
exact or up to a `/` boundary, so `/administrators-guide` and
`/logins-explained` are *not* open — a loose `startsWith` would have left them
serving normally through the window.

---

## 2. Static, for the redeploy itself

Generate the page from the same source as the in-app one, so a visitor sees the
same screen mid-deploy as mid-migration:

```bash
npm run build:maintenance-page
```

It writes `public/maintenance.html` — self-contained, no CSS file, no fonts, no
JavaScript, because it has to render when nothing else is available.

### nginx

The reference vhost (`deploy/nginx/astrobaas.conf`) already does this. Copy
that file and edit it — the shape below is reduced to the two locations that
matter and is **not** a drop-in: `astrobaas_cms_example_com` is an `upstream`
block the full vhost declares, and `nginx -t` refuses a `proxy_pass` to a name
nothing defines.

```nginx
location / {
    proxy_pass http://astrobaas_cms_example_com;
    proxy_intercept_errors on;
    # 502 and 504 only — NOT 503. See below.
    error_page 502 504 =503 /maintenance.html;
}

location = /maintenance.html {
    root /var/www/cms-example-com/shared/maintenance;   # outside the release
    internal;
    add_header Retry-After 120 always;
    add_header Cache-Control "no-store" always;
}
```

`=503` on the `error_page` line is what makes the page a 503. An earlier version
of this snippet put `return 503;` after `rewrite … break;` in a named location
instead — but `break` stops the rewrite module's directives, `return` is one of
them, so it never ran, and `error_page … = @name` then passed on the named
location's own status: the holding page went out as a **200**.

It also intercepted **503**. nginx cannot tell its own errors from the app's, and
the app answers 503 on purpose — this in-app maintenance window, a failing
`/api/health/deep`, `/readyz` while it drains for a restart. Intercepting 503
replaces all of them with the static page, so a deploy script asserting the
health check gets HTML instead of the JSON that names what failed. An app that is
really down gives nginx a 502 (connection refused) or 504 (timeout); those are
the ones to replace.

`deploy.sh` builds the page into the release; `deploy/remote-activate.sh` is
what copies it into `shared/maintenance/`, before the restart it exists for
(`deploy/remote-activate.sh:110-116`).

### Caddy

As in `deploy/caddy/Caddyfile`:

```
handle_errors {
    @app_down expression `{err.status_code} in [502, 504]`
    handle @app_down {
        root * /var/www/cms-example-com/shared/maintenance
        rewrite * /maintenance.html
        header Retry-After 120
        header Cache-Control "no-store"
        file_server {
            status 503
        }
    }
}
```

`handle_errors` only sees errors Caddy itself produced (the app unreachable), so
the app's own 503s pass through untouched either way. `status 503` is needed
because `file_server` would otherwise answer with the error's own 502/504.

---

## A deploy with no visible downtime at all

The page above is the fallback. If you would rather visitors saw nothing:

1. `SCHEDULER_DISABLED=1` on the old process, so it stops sweeping: no
   scheduled publishing, no newsletter batch, no abandoned-order cancellation
   and no off-site backup running on a timer through a schema that is about to
   change (`src/lib/scheduler.ts:5`).
2. Deploy alongside, let the new process boot and pass `/readyz`.
3. Switch the proxy over, stop the old one.

AstroBaaS runs migrations at boot, so the new process is the one that migrates.
Step 1 is what keeps the old one from writing through that schema change on a
timer while it happens.

**`MAINTENANCE_MODE=1` is not the instruction for step 1, and there is no
read-only mode.** The environment switch is checked before anything else, and it
answers 503 to every path outside the always-open list from the very next
request (`src/middleware.ts:719-729`) — which is precisely the downtime this
section promises to avoid. It would not do the job either: it gates requests
coming *in*, not the writes the process makes itself, and the scheduler is
switched off by `SCHEDULER_DISABLED` alone.

What step 1 does not stop is a write driven by a request the old process is
still serving — a checkout, an admin save. If the migration you are shipping
cannot tolerate one, this is not the ordering to use: take the window, and use
the page above.
