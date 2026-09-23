# Reference deployment

A bare-metal / VPS deployment of AstroBaaS behind nginx, and the checks worth
making after it.

```
deploy/
  nginx/astrobaas.conf              reference vhost
  nginx/astrobaas-zones.conf        its rate-limit zones (http{} level, copy first)
  caddy/Caddyfile                   the same shape for Caddy
  systemd/astrobaas.service         reference unit
  remote-activate.sh                the server half of ../deploy.sh
  fail2ban/filter.d/astrobaas-429.conf
  fail2ban/jail.d/astrobaas.local   example jails (see Hardening)
```

The configs are documentation, not automation: copy them, replace the hostnames
and paths, read the comments. They live in the repository so they are versioned
with the code that assumes them — three of three CMS hosts on one server were
hand-written, and all three reproduced the same rate-limit bug.
`tests/deploy-artifacts.test.mjs` reads every one of them and runs
`remote-activate.sh` against a scratch directory, so a change that breaks one
fails CI.

The numbers in the vhost are measured, not chosen. See the header of
`nginx/astrobaas.conf`.

## Validate before you reload

Every one of these refuses a broken file without touching what is running. Run
them after every edit, before the reload:

```bash
sudo nginx -t && sudo systemctl reload nginx
caddy validate --config /etc/caddy/Caddyfile
sudo systemd-analyze verify /etc/systemd/system/cms-example-com.service
sudo fail2ban-regex /var/log/nginx/cms.example.com.access.log /etc/fail2ban/filter.d/astrobaas-429.conf
```

`nginx -t` fails with `zero size shared memory zone "astrobaas_…"` when the vhost
names a zone that `astrobaas-zones.conf` does not declare — copy the zones file
first, and copy it again when upgrading.

On nginx older than 1.25.1 (Debian 12 ships 1.22, Ubuntu 24.04 ships 1.24),
`http2 on;` is an unknown directive: use `listen 443 ssl http2;` instead, as the
vhost's comment says.

## Layout

```
/var/www/<slug>/
  releases/<timestamp>/        one build
  current -> releases/<ts>/    symlink, flipped on deploy
  shared/.env                  secrets, 0640 root:www-data
  shared/data/                 database
  shared/data/uploads/         UPLOADS_DIR
  shared/data/private-uploads/ PRIVATE_UPLOADS_DIR — form attachments, 0750
  shared/maintenance/          maintenance.html, readable while the app is down
```

Everything the app writes lives in `shared/`. A deploy swaps `current`; if the
uploads directory moved with it, every image uploaded since the last build would
404.

A deploy is two scripts. `deploy.sh` runs on your machine: it builds, assembles
a release in a staging directory, and rsyncs it to `releases/<timestamp>/`.
`deploy/remote-activate.sh` runs on the server, and everything after the copy is
its half — the shared directories, the release's permissions, the maintenance
page, the `current` symlink, the restart, the readiness poll, and pruning old
releases.

`remote-activate.sh` creates any of the `shared/` directories that are missing
and gives `shared/data/` to the user the unit runs as (it reads `User=` from the
unit — it used to assume `site-<slug>`); `shared/.env` it leaves alone. It needs
to know the app's port: it reads `Environment=PORT=` from the unit, then `PORT=`
from `shared/.env`, or takes `DEPLOY_PORT` from `deploy.sh`. It then waits for
**`/readyz`** on that port — not `/healthz` — and fails the deploy, printing the
rollback command, if the new release never becomes ready.

### The release's own permissions, before the restart

A release the app user cannot enter is a release systemd cannot start. That is
not hypothetical: `deploy.sh` stages into `mktemp -d`, which is `0700`, and
`rsync -a` copied that mode onto the release root. Owned by root and `0700`, the
app user could not `cd` into it, every start failed with `200/CHDIR` until
systemd's start limit gave up, and the readiness poll could only report that it
had. It took a live site down.

So the mode is set explicitly, on both sides, and on the server it happens
**before** the symlink flip and the restart:

| Where | What | Why |
| --- | --- | --- |
| `deploy.sh:71`, on the stage | `chmod 0755 "$STAGE"` | so a release never leaves your machine at `0700` |
| `remote-activate.sh:94` | `chown -R root:<run group> "$RELEASE"` | the app must not be able to rewrite what it runs on the next boot |
| `remote-activate.sh:107` | `chmod 0755 "$RELEASE"` | the release root has to be enterable by the app user — this is the `200/CHDIR` one |
| `remote-activate.sh:108` | `chmod -R g+rX,g-w "$RELEASE"` | files group-readable, directories group-traversable, and never group-writable |

`g+rX` only ADDS bits, so a release built under `umask 002` (0775/0664, the
Debian/Ubuntu default for a user with their own group) keeps its group-write —
which is what the explicit `g-w` takes away.

**If you place a release by hand** — untarring into `releases/<timestamp>/`,
copying one from another host — run the three `remote-activate.sh` commands
yourself, in that order, before you move `current` and restart. A release that only becomes
enterable after the restart has already spent the service's start limit.

### Private uploads moved (existing installs)

`PRIVATE_UPLOADS_DIR` used to default to `private-uploads/` in the **working
directory** — under this unit, the release itself, which is read-only and
replaced on every deploy. It now defaults to beside the database and the unit
sets it explicitly. An install that already has files in the old place keeps
using it and logs, once at the first upload or download:

```
[private-uploads] Using the OLD location … To move them: stop the app, run  mv <old> <new>  and start it again.
```

Move the directory while the app is stopped. File records store paths relative
to the directory, so moving it whole is all that is needed.

## Post-deploy checklist

These are the things that **fail silently** — the deployment looks fine, the
pages return 200, and something is wrong. Each one has cost a real shop time.

### 1. Assert the deep health check, don't eyeball the site

```bash
curl -fsS -H "Authorization: Bearer $HEALTH_TOKEN" \
  https://cms.example.com/api/health/deep | jq '{ok, status, failed, warnings}'
```

`-f` makes a failure a non-zero exit, so this belongs in the deploy script
itself. It returns 503 when anything essential is broken. It checks the things
that have actually failed in production, and it EXERCISES them rather than
asking whether the module is present:

| check | what silently breaks without it |
| --- | --- |
| `image_pipeline` | sharp's native module fails to load → uploads get no dimensions and no derivatives, and the storefront is served full-size originals. No error anywhere. |
| `public_site_url` | the CMS does not know its own address → media URLs are guessed from whatever host the request arrived on. Works for the admin, breaks for a storefront on another domain. |
| `uploads_writable` | the first upload of the day fails, and only then. |
| `database` | a read-only filesystem or a half-finished migration reads perfectly and fails on the first write — which on a shop is the first order. |
| `rate_limit_store` | a misconfigured shared store fails OPEN: nothing is rate-limited at all, and the config still describes itself as working. |
| `plugins` | a paid module active in the database with no implementation loaded. The admin shows it switched on and nothing it provides happens. |
| `health_token` | a `HEALTH_TOKEN` shorter than the 32 characters asked for below. 16–31 still works and warns; under 16 is **ignored** — the check answers 404 as if no token were set, which used to look exactly like a typo in the deploy script. |

Set `HEALTH_TOKEN` (32+ random characters, `openssl rand -hex 32`) in
`shared/.env` so the deploy script can call it without a session. Without a
token, only an admin session gets in, and everyone else gets a 404.

Use `?write=0` for a monitor that polls frequently — the write probe rewrites the
whole document on the lowdb and libSQL doc drivers.

### 2. Poll `/readyz`, not `/healthz`, before switching traffic over

Migrations run at boot. `/healthz` answers 200 as soon as the database is
readable; `/readyz` stays 503 until the schema matches the build. Cutting over on
`/healthz` can put traffic on a half-migrated database.

```bash
for i in $(seq 30); do curl -fsS http://127.0.0.1:3002/readyz && break; sleep 2; done
```

`/readyz` also answers 503 while the process drains for a restart (below), and
it never includes a storage error message — the reason is in the journal. The
reference vhost only lets loopback reach it; `/healthz` stays public for uptime
monitors, rate limited, and no longer reads the content library or reports its
size.

To let something else in — a load balancer, an external monitor — uncomment the
`allow` line in `location = /readyz` (`deploy/nginx/astrobaas.conf:480-484`) and
put its address there; `deny all` below it keeps everyone else out. Caddy has
the same restriction on `/readyz` and `/metrics` together
(`deploy/caddy/Caddyfile:182`). A `curl` to `/readyz` over the public hostname
against an unedited config returns 403, which says nothing about the app.

### 2b. Restarts drain; they do not cut requests off

On SIGTERM (`systemctl restart`, `docker stop`, a deploy) the app answers
`/readyz` with 503, stops its scheduler, waits for in-flight requests — a
checkout half-way through — writes the view counts it holds in memory, and
exits 0. A second signal exits at once. The whole budget is
`SHUTDOWN_TIMEOUT_MS` (25 s here), which must stay below the unit's
`TimeoutStopSec` (30 s) or systemd's SIGKILL wins. Each restart leaves one line:

```bash
journalctl -u cms-example-com | grep '"type":"shutdown"' | tail -2
# {"type":"shutdown","msg":"drained","waited_ms":120,"abandoned_requests":0,"views_written":3,...}
```

`abandoned_requests` above 0 means a request outlived the budget; find it in the
access log before raising the timeout. `sweep_abandoned: true` means a scheduler
sweep (normally an off-site backup upload) was still running when the budget
ran out; that backup is retried an hour later. `lease_released: true` means
the process handed the scheduler to whichever process is standing by.

`GRACEFUL_SHUTDOWN=0` turns the whole thing off: the signal handlers are never
installed, so the process dies the default way — in-flight requests cut, the
buffered view counts lost (`src/lib/shutdown.ts:87-90`, `:264-267`). It is an
escape hatch for a host that needs the process gone at once, not a tuning knob;
`SHUTDOWN_TIMEOUT_MS` is the knob.

### 2c. More than one process on the database

The reference unit runs one process, and that is the tested shape. If you run
more (a second unit on the same host, PM2 cluster mode, a replica on another
host against a `libsql://` database):

- Only one of them runs the scheduler: the one holding the `scheduler` lease.
  The operations screen on each says which. A killed leader is replaced within
  `SCHEDULER_LEASE_TTL_MS` (3 minutes at the default interval); a restarted one
  hands over at once.
- Use `DATABASE_DRIVER=relational`. The lease keeps the sweeps to one process
  on every driver, but ordinary writes on the doc-blob driver still replace the
  whole document, and lowdb is a single-process file.
- Use a database every process reaches. Two processes on one host can share a
  `file:` database (each waits up to 5 s for the other's write lock); two hosts
  need `libsql://`, and shared uploads.
- Settings, redirects and plugin switches made through one process reach the
  others within 15 seconds.
- Two processes booting together do not run the same migrations twice: the
  migration runs under a `migrations` lease, and a process that cannot take it
  waits `MIGRATION_LOCK_WAIT_MS` (default 2 minutes) before giving up. Giving up
  is not fatal — the next request waits again
  (`src/lib/localdb.ts:225-239`).
- **Both leases leave something an operator can find**, and neither is
  self-explanatory. On libSQL (both drivers) they are rows in a `leases`
  table in the same database; on lowdb, a file beside the database named
  `<database>.<name>.lease`, holding `{holder, pid, host, expires_at}`
  (`src/lib/lease.ts:23-50`). There are two names, `scheduler` and `migrations`.
  Neither is something to delete by hand: a holder that dies blocks the job for
  at most one TTL, and on lowdb a lease whose `pid` is dead on this host is taken
  over at once.
- Never set `SCHEDULER_LEASE=0` with more than one process. The newsletter is
  the one sweep that is also safe without the lease — the campaign cursor moves
  FIRST, by a compare-and-set, so a batch one process claimed is not re-sent by
  another (`src/lib/scheduler.ts:375-460`, and
  `tests/multi-instance.test.mjs` §5 runs two senders side by side on all three
  drivers). Nothing else in the sweep is protected that way, so the rest of it
  runs once per process: recovery reminders, back-in-stock notices,
  abandoned-order cancellations, and off-site backup uploads — a second full
  archive pushed to the bucket every interval.

### 3. Capture the generated admin password on a first install

With no `ADMIN_PASSWORD` set, the first boot in production generates one and
prints it **once**, to stdout. Under systemd that is the journal and nowhere
else.

```bash
journalctl -u cms-example-com --since '5 minutes ago' | grep -A4 'admin password'
```

Better: set `ADMIN_PASSWORD` in `shared/.env` before the first start.

### 4. Read the rate-limit store line from the journal

```bash
journalctl -u cms-example-com | grep 'rate-limit store'
```

`memory (per-process)` is correct for a single node. On two replicas it means
each one keeps its own counters, so the effective limit is double what you
configured — set `RATE_LIMIT_STORE=libsql` with a `DATABASE_URL`.

### 5. Set the CMS's own address

Settings → **Address of this CMS** (`public_site_url`), e.g.
`https://cms.example.com`.

Leave it empty and media URLs are guessed from the host each request arrives on.
That is right for the admin and wrong for a storefront on another domain, a
worker, or anything calling the API server-to-server — which is why the deep
health check reports it as a warning rather than letting it pass for
configuration.

### 5b. Send one real email

Mail is configured in `shared/.env` (`EMAIL_TRANSPORT=smtp`, `SMTP_*`,
`EMAIL_FROM`, `EMAIL_REPLY_TO`; the full list and what each does is under
*Email* in the [main README](../README.md#email)). Edit it with `sudoedit` and
write the password single-quoted — `SMTP_PASS='…'` — because systemd and Node
read an unquoted one differently. Then send a test with exactly the environment
the service sees:

```bash
sudo systemd-run --pipe --wait --quiet --uid=www-data --gid=www-data \
  -p EnvironmentFile=/var/www/<site>/shared/.env \
  -p WorkingDirectory=/var/www/<site>/current \
  /usr/bin/node dist/mail-test.mjs you@example.com
```

`dist/mail-test.mjs` is the mail test compiled by `npm run build`. A release
carries only `dist/`, `package.json` and a production `node_modules` — no
`scripts/`, no `src/`, nothing to compile with — which is why this step used to
name a script no release had. `npm run mail:test` is the same test in a
checkout.

It exits 0 only when the server answered `250`, so a deploy script can assert
it. Until this passes, password resets, magic links and form notifications go
nowhere; `/api/health/deep` reports the reason under `email_channel`.

### 6. Check the body limits on EVERY large-body route, not just uploads

nginx's default is 1 MB, and a route without its own `location` inherits the
server-level `client_max_body_size`. Either way the request dies at the proxy:
the app never sees it, logs nothing, and cannot explain it in the admin.

This is not hypothetical. A production shop shipped self-hosted video with a
vhost that still said `client_max_body_size 12m` — correct back when the app
allowed 10 MB images, untouched when video raised the app's ceiling to 100 MB.
Every video upload returned a bare nginx 413. Three further routes had no
`location` at all and silently inherited 2 MB.

**Each cap is the app's own ceiling, rounded up to the next megabyte.** Never
round down: a proxy one byte below the app refuses a request the app would have
accepted, at the layer least able to say why.

| Route | Cap | Derived from | Env var |
| --- | ---: | --- | --- |
| `/api/media/upload` | 111m | `MAX_VIDEO_SIZE` × 1.1 — `src/lib/media/ingest.ts` | `MEDIA_MAX_VIDEO_MB` |
| `/api/media/replace` | 111m | `MAX_VIDEO_SIZE` × 1.1 — `src/lib/media/ingest.ts` | `MEDIA_MAX_VIDEO_MB` |
| `/api/backup/import` | 282m | `MAX_ARCHIVE_BYTES` × 1.1 — `src/lib/backup/offsite.ts` | — |
| `/api/import/wordpress` | 26m | `MAX_HTTP_WXR_BYTES` + 2 MB — `src/lib/import/limits.ts` | — |
| `/api/forms/*/upload` | 6m | `MAX_SUBMISSION_FILE_SIZE` × 1.2 — `src/lib/media/private-files.ts` | — |
| everything else | 2m | `BODY_LIMIT_DEFAULT` — `src/lib/body-limits.ts` | — |

The headroom above each file cap is multipart framing: boundary markers and the
other form fields count toward `Content-Length`. A ceiling equal to the file cap
refuses an upload of exactly the documented maximum.

The table is generated from nothing — it is maintained by hand, and
`tests/body-limits.test.mjs` fails the build if it stops matching
`src/lib/body-limits.ts`, or if either shipped proxy config would refuse
something the app accepts. So if you raise a limit, CI tells you which file you
forgot.

**Caddy is the opposite problem.** Caddy sets no request-body limit at all, so
nothing here is needed to make video work; the caps in `deploy/caddy/Caddyfile`
exist to stop an unbounded upload, not to permit a bounded one.

#### Probe it

```bash
curl -sk -o /dev/null -w '%{http_code}\n' -X POST \
  -F file=@some-4mb.jpg https://cms.example.com/api/media/upload
```

A `401` means it reached the app — the right answer from an unauthenticated
probe. To check the video ceiling specifically, send something past the old
limit:

```bash
head -c 40000000 /dev/urandom > /tmp/probe.bin
curl -sk -o /dev/null -w '%{http_code}\n' -X POST \
  -F file=@/tmp/probe.bin https://cms.example.com/api/media/upload
```

#### Telling an app 413 from a proxy 413

They mean opposite things and are fixed in different files. The body is the
tell:

| What comes back | Who refused it | What to do |
| --- | --- | --- |
| JSON, with `"code":"PAYLOAD_TOO_LARGE"` | the **app** | The file really is over the app's ceiling. Raise the constant (or `MEDIA_MAX_VIDEO_MB`) — **and the proxy cap with it**. |
| nginx's HTML `413 Request Entity Too Large` | the **proxy** | The vhost is below the app's ceiling, or the route has no `location`. Fix this file. Nothing will appear in the app's log. |
| `502` / connection reset mid-upload | a **timeout** | 100 MB over a domestic uplink outlasts a 60s `client_body_timeout`. The upload routes raise theirs to 300s. |

```bash
# Which one was it? The app answers in JSON; nginx answers in HTML.
curl -sk -X POST -F file=@big.mp4 https://cms.example.com/api/media/upload | head -c 200
```

An app 413 is also visible in the journal; a proxy 413 appears only in
`/var/log/nginx/*.error.log`. Silence in `journalctl -u astrobaas` with a 413 at
the client is conclusive: it was the proxy.

### 7. Ship the maintenance page, and check it is a 503

A deploy through `deploy.sh` already does this: the page is built into the
release, and `remote-activate.sh` copies it into `shared/maintenance/` before the
restart. Do it by hand on a server set up some other way, or before the first
deploy:

```bash
npm run build:maintenance-page   # writes public/maintenance.html
# copy it to shared/maintenance/maintenance.html — NOT inside a release
```

It is generated, not committed, so the vhost's `location = /maintenance.html`
(rooted at `shared/maintenance/`) 404s until something puts the file there. And
it must answer **503**, never 200: a holding page served as 200 tells a crawler
that this is the content now.

```bash
sudo systemctl stop cms-example-com
curl -sk -o /dev/null -w '%{http_code}\n' https://cms.example.com/   # expect 503
sudo systemctl start cms-example-com
```

### 8. Confirm the app is not reachable except through nginx

`TRUST_PROXY=1` tells the app to believe `X-Forwarded-For`. If the port is also
reachable directly, anyone can set that header themselves and get a forged
client IP — a fresh rate-limit bucket per request, and a login throttle counting
against somebody else's address.

```bash
ss -lntp | grep 3002        # expect 127.0.0.1:3002, never 0.0.0.0:3002
```

With Docker, the same rule is in `docker-compose.yml`: the port is published as
`127.0.0.1:4321:4321`. A bare `4321:4321` listens on every interface, and Docker
writes its own iptables rules — a host firewall such as ufw does **not** stop it.

### 9. Check the images come back as `https://`, not `http://`

```bash
curl -s https://cms.example.com/api/products?limit=1 | jq -r .meta.media_base
```

An `http://` answer on an https site means the app is not seeing
`X-Forwarded-Proto` — `TRUST_PROXY=1` is missing from the unit, or the vhost is
not setting the header. Those image URLs are mixed content and a browser will
refuse to load them, so the images fail on the storefront while looking correct
in the API.

Setting **Address of this CMS** removes the guesswork entirely: a declared value
wins over anything derived from the request.

### 10. Point nginx's `/uploads/` at the shared directory

Not at a release's `dist/client/uploads`. That is a build-time snapshot; every
file uploaded since the build would 404, and only for the images customers
actually look at.

A plain `curl -I` proves nothing here: `try_files` falls back to the app, so the
file is served either way and a 200 does not tell you WHO served it. Look at the
headers instead — nginx sets a strong `ETag` of the form `"<hex>-<hex>"` and the
app sets a weak one (`W/"…"`):

```bash
curl -skI https://cms.example.com/uploads/<a-recently-uploaded-file>.webp | grep -i etag
```

A weak `W/"…"` means nginx did not find the file and the app is serving every
image — usually because the alias points at a release's `dist/client/uploads`
instead of the shared directory.

### 11. Build-time variables have to be set at BUILD time

`SITE_URL` and every `CSP_*` variable are read by `astro.config.ts` when the
bundle is built. Putting them in the systemd unit or `shared/.env` does nothing.
A checklist step that says "set `CSP_IMG_SRC` and restart" is wrong.

The runtime `site_url` **setting** does win over the build-time `SITE_URL` for
canonical links, the sitemap and feeds — that one is editable in the admin.

### 12. `npm run setup` and `reset-password` follow your database configuration

They honour `DB_PATH`, and on an install configured with `DATABASE_URL` they
**refuse to run** — printing the configured URL and pointing at the admin
screens and the REST API, which do write to the configured database
(`scripts/lib/db-target.mjs:29-56`). `import:md` and `mint-storefront-key` go
through the same check.

The refusal is the feature, and it is what this step used to warn about. All
four scripts once resolved `./db.json` from the working directory: on a
containerised install they wrote a file next to the code while the server kept
reading the volume, and on libSQL they created a `db.json` nothing ever opens,
reported "Admin account written", and left the operator unable to sign in. Both
failures looked exactly like the tool working.

## Hardening

What sits in front of the app decides most of what an attacker can do to it.
The app limits requests per user, per API key and per IP, but every request it
refuses has still cost a TLS handshake and a Node round-trip. Everything below
is configuration for the box, not the app — neither deploy script touches any of
it, and none of it should be applied to a live server without reading it first.

### A CDN in front (Cloudflare), and the real client IP

A CDN absorbs volumetric floods and caches `/uploads/` images at the edge. It
also changes who the app thinks every visitor is: without further setup, every
request comes from a Cloudflare address, so

- one rate-limit bucket is shared by every visitor in a region, and a busy
  afternoon locks all of them out together;
- the login throttle counts every shopper as the same person;
- fail2ban bans Cloudflare.

Fix it in nginx with the commented block in `nginx/astrobaas.conf`
(`set_real_ip_from` for each range at <https://www.cloudflare.com/ips-v4> and
`/ips-v6`, then `real_ip_header CF-Connecting-IP;`). nginx then only believes
`CF-Connecting-IP` from Cloudflare's own ranges, and everything downstream —
`limit_req`, `X-Real-IP`, `X-Forwarded-For`, the app's `TRUST_PROXY` — sees the
visitor. For Caddy, the commented `trusted_proxies` block **and** the
`header_up X-Forwarded-For {client_ip}` line in the Caddyfile: Caddy appends the
edge's address to `X-Forwarded-For`, and the app reads the right-most entry.

Verify: `LOG_REQUESTS=1` logs `ip` per request; it must be your address, not
`172.64.x.x`.

**Then firewall the origin to the CDN.** Otherwise the CDN is optional for an
attacker who finds the server's address (old DNS records, certificate
transparency logs, a mail header):

```bash
# ufw: allow 443 only from Cloudflare, keep SSH open for yourself.
sudo ufw default deny incoming
sudo ufw allow from 203.0.113.10 to any port 22 proto tcp     # your address
for r in $(curl -fsS https://www.cloudflare.com/ips-v4) $(curl -fsS https://www.cloudflare.com/ips-v6); do
  sudo ufw allow from "$r" to any port 443 proto tcp
done
sudo ufw enable
```

Port 80 can stay closed if the certificate is renewed by DNS challenge, or open
to Cloudflare only if it uses HTTP-01 through the proxy. Refresh the ranges when
Cloudflare changes them. On a box that also runs Docker, published ports bypass
ufw — which is one more reason the compose file binds to 127.0.0.1.

Cloudflare's WAF managed rules, bot fight mode and rate-limiting rules sit on
top of this and need nothing from the app. Do **not** let the CDN cache `/api/`
or `/admin` responses (the default only caches static extensions; keep it that
way), and exempt `/api/payments/webhook/*` from any challenge — a payment
provider cannot solve one.

### Restricting the admin

If staff work from fixed addresses or a VPN, the admin does not need to be
reachable from anywhere else. `nginx/astrobaas.conf` has a commented
`location ^~ /admin` block with `allow`/`deny`. It is a second lock, not the
first: sessions, the login throttle and 2FA still apply. The `/api/` routes are
shared with the storefront and cannot be restricted wholesale. Behind a CDN this
only works with the real-IP block enabled. An alternative that needs no fixed
addresses is Cloudflare Access (or any identity-aware proxy) on `/admin*`.

### fail2ban (or CrowdSec) on repeated 429s

The limits refuse a flood; they do not stop it arriving. fail2ban moves a
persistent offender to the firewall. Examples in `deploy/fail2ban/`:

```bash
sudo apt install fail2ban
sudo cp deploy/fail2ban/filter.d/astrobaas-429.conf /etc/fail2ban/filter.d/
sudo cp deploy/fail2ban/jail.d/astrobaas.local      /etc/fail2ban/jail.d/
# edit the log paths and ignoreip, then:
sudo fail2ban-regex /var/log/nginx/cms.example.com.access.log /etc/fail2ban/filter.d/astrobaas-429.conf
sudo fail2ban-client reload && sudo fail2ban-client status astrobaas-429
```

- `astrobaas-429` reads the **access** log and counts 429s from either layer —
  nginx's edge limit (the vhost answers 429, not 503) and the app's own.
- `astrobaas-nginx-limit-req` and `astrobaas-login` use fail2ban's stock
  `nginx-limit-req` filter on the **error** log, restricted to the AstroBaaS
  zones.
- 503 is deliberately not a trigger: a deploy, the maintenance page and a
  draining process produce 503s for every visitor at once.
- The thresholds are loose on purpose (60 rejections in 2 minutes): one
  catalogue page view is ~450 requests.
- **Always** put the storefront server's address in `ignoreip`. It makes every
  API call for every shopper; banning it takes the shop down.
- **Behind Cloudflare**, enable the real-IP block first, and ban at Cloudflare
  (`action = cloudflare-token[...]`, fail2ban ≥ 1.0.1) — a local firewall rule
  never sees the visitor's address.

CrowdSec does the same job with shared blocklists: install the agent, then
`sudo cscli collections install crowdsecurity/nginx`, point its
acquisition at the vhost's access and error logs, and add a bouncer — the
firewall bouncer on a bare server, the Cloudflare bouncer behind Cloudflare.
Whitelist the storefront server the same way.

### Backups that live somewhere else

A backup on the same disk is a copy, not a backup. Keep at least one outside
this machine:

- the app's off-site backup (`BACKUP_S3_*` in `shared/.env`, any
  S3-compatible bucket) runs on the scheduler and reports its last result on
  the operations screen and in the deep check's `offsite_backup` entry — put
  the bucket in another provider or region. Its history is kept in the
  database, so a restart does not start a fresh backup, and a backup cut off by
  a crash is retried after an hour rather than by every restart;
- or a nightly copy of `shared/data/` — database, `uploads/` and
  `private-uploads/` — taken while it is consistent: for lowdb a copy of
  `db.json` is atomic enough; for SQLite use `sqlite3 db.sqlite ".backup …"`
  rather than copying a file with a live `-wal` beside it;
- `shared/.env` separately, and encrypted: without `AUTH_SECRET` the restored
  sessions are invalid, which is survivable, but the payment and SMTP keys in it
  are not re-creatable.

Restore one into a scratch install now and then. A backup nobody has restored is
a hope.

### Uptime and metrics

- An external monitor on `https://cms.example.com/healthz` (public, cheap,
  rate limited to 10/min per address — poll every 30–60 s). It says the process
  and its storage answer.
- The deep check, from a place that holds `HEALTH_TOKEN`, with `?write=0` if it
  polls: it says the shop can take an order. Alert on its `warnings` too:
  `offsite_backup` there means the last backup failed, or the last success is
  more than two intervals old.
- `METRICS_ENABLED=1` and a Prometheus scrape of `http://127.0.0.1:3002/metrics`
  on the box (the vhost and Caddyfile refuse it from anywhere else). Worth an
  alert: `rate(astrobaas_rate_limited_total[5m])` rising (customers refused, or
  an attack), the p95 of `astrobaas_request_duration_seconds` rising, and
  `astrobaas_errors_total` moving at all.
- `astrobaas_draining` and `astrobaas_inflight_requests`
  (`src/lib/observability.ts:197-202`) are §2b on a dashboard.
  `astrobaas_draining` goes to 1 for the length of every restart;
  `astrobaas_inflight_requests` should fall to 0 inside that window. A restart
  where it does not is the one whose shutdown line will report
  `abandoned_requests`. An alert on `astrobaas_draining` staying at 1 catches a
  process that never finished exiting.

## Also read

- `SECURITY.md` → *Hardening checklist for operators* — TLS, secrets, headers.
  This checklist deliberately does not repeat it.
- `MAINTENANCE.md` — the maintenance window mechanism and which paths must stay
  reachable so an operator can turn it back off.
