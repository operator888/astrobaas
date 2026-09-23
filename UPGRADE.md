# Upgrading AstroBaaS

Behaviour changes that an existing deployment needs to know about, newest
first. Everything here was verified against a running instance, not inferred
from the diff.

If you run a **headless storefront** against AstroBaaS, read §"Headless
storefronts" first — it is the short version.

---

## Headless storefronts — the short version

Everything a storefront needs to *render* is unchanged and still anonymous:

| What | Status |
|---|---|
| Image files under `/uploads/**` | **public, 200** — unchanged |
| `GET /api/products` | **public, 200** — unchanged |
| `GET /api/posts` | **public, 200** — unchanged |
| `GET /api/posts/{slug}` | **public, 200** — unchanged |
| `GET /api/categories/get` | **public, 200** — unchanged |
| `POST /api/orders`, `/api/orders/quote` | same shapes, new refusals (U-20) and a per-address budget (U-16) |
| `GET /rss.xml`, `/sitemap.xml` | unchanged |

**One thing changed for API keys:** `GET /api/media/get` is no longer public,
so a key now needs a `media:read` scope. See U-2.

**One field changed shape:** `content` on a post is now the RAW stored HTML;
the plugin-rendered version moved to `content_rendered`. See U-1.

**One field was added, and it is opt-in:** posts gained `kind` to distinguish
articles from standalone pages. `GET /api/posts` still returns articles only, so
your response is byte-identical until you ask for pages. See U-11.

**Custom content types are now private by default.** If your storefront reads
`GET /api/content/<type>` anonymously, the plugin that registers that type must
declare `visibility: 'public'` or the read starts returning 404. See U-12.

**Checkout has new refusals, and online payments a time limit.** A buyer with
five unpaid orders gets `429`, a coupon refusal says only `invalid`, an unpaid
card order is released after two hours, and `Idempotency-Key` is supported. See
U-20.

---

## U-21 — SMTP: retries by default, a new EHLO name, Reply-To, one log line per message

Nothing to do if you are happy with the defaults. What an existing install will
notice:

| Before | After | To keep the old behaviour |
|---|---|---|
| One SMTP attempt | Up to 3 on a transient failure, ~2 s then ~6 s apart | `SMTP_RETRIES=0` |
| EHLO gave `SMTP_HOST` | EHLO gives this machine's FQDN, else `EMAIL_FROM`'s domain | `SMTP_HELO_NAME=<your SMTP_HOST>` |
| No `Message-ID` header | One per message, on the From domain | — |
| No log line on success | `[email] smtp sent to=i***@… attempts=N: 250 …` | — |
| A send could hang on a silent STARTTLS server | Cut off after `SMTP_TIMEOUT_MS`; each attempt capped at 3× | — |
| The reply to the final `.` waited `SMTP_TIMEOUT_MS`, and a lost one was retried (duplicates) | Waits `SMTP_DATA_TIMEOUT_MS` (default 10 min; scheduler batches 1 min); never retried once `.` is sent — logged as "outcome unknown" | a shorter `SMTP_DATA_TIMEOUT_MS` (it still never retries) |
| STARTTLS checked the certificate against `localhost` when `SMTP_HOST` was an IP | Checked against `SMTP_HOST`, as implicit TLS already was | — (fix the certificate, or trust its CA with `NODE_EXTRA_CA_CERTS`) |
| No Reply-To | `EMAIL_REPLY_TO` on every message, if set | leave it unset |
| Form notifications replied to the site | They reply to the submitter's address | — |
| Newsletter campaigns always allowed | Still allowed; `EMAIL_CAMPAIGNS=0` refuses them | — |

- **Plugins:** `EmailMessage` gains optional `replyTo` and `category`. A plugin
  that set `headers['Reply-To']` keeps working — it is read into `replyTo` under
  the same checks — but the field is now the way to set it.
- **Webhook transport:** the JSON body can carry two new optional fields,
  `replyTo` and `category` (`"bulk"` on campaign mail). A receiver that
  rejects unknown fields needs to allow them.
- **SMTP2GO:** requests now carry `custom_headers` (Reply-To, and
  List-Unsubscribe on campaigns).
- **`/api/health/deep`:** `email_channel.data` gains `reply_to` and
  `campaigns`, and warns when `EMAIL_REPLY_TO` is set but unusable.
  `data.last_send` (and `/api/operations`' `email.lastSend`) can carry
  `outcome: "unknown"` beside `ok: false` — see the email log below.
- **Email log:** entries gain an optional `response` (the server's final
  reply), and an optional `outcome: "unknown"` (with `ok: false`) for a message
  that was sent and never answered: it may have been delivered, and was not
  resent. A consumer reading only `ok` sees it as not-OK, as before. Stored
  inside the existing JSON; no migration.
- **A STARTTLS server reached by IP address** now needs a certificate that
  names that address. One that named only a host name used to be accepted.
- **`SMTP_PASS`:** single-quote it in the env file (`SMTP_PASS='…'`). Unquoted,
  systemd drops a backslash and Node's loader stops at a `#`. Check with
  `npm run mail:test -- --env-file=… you@example.com`.

---

## U-20 — checkout and payment hardening

**Affects:** every shop. The response SHAPES are unchanged. What changes is
which requests are refused, and when unpaid orders let go of their stock.

> **BEFORE DEPLOYING (every shop taking Stripe, PayPal or Klarna):** open
> Settings → General and set **Site URL to the storefront's address** (for
> example `https://www.example.gr`), not the CMS's. Payment providers now send
> paying buyers back to `<Site URL>/checkout/success`. With Site URL empty they
> go to `SITE_URL`, or to whatever host the payment request reached. The CMS
> has no such page, so a buyer who has just paid lands on a 404. After
> deploying, `GET /api/health/deep` shows a `payment_return_urls` **warning**
> while this is wrong (it never fails the check), and so do the settings
> screen and the dashboard's attention feed.

*Verified by* `tests/checkout-abuse.test.mjs`, `tests/checkout-race.test.mjs`
and `tests/paypal-capture.test.mjs` on all three storage drivers, and by
`tests/payment-return-url.test.mjs`, all calling the real route handlers. Unlike the entries below, this one has **not** yet been checked
against a running instance: the HTTP-level assertions are in `tests/smoke.mjs`
("8k. CHECKOUT ABUSE") and need a smoke run.

| Change | Default | What a live shop or storefront notices | To keep the old behaviour |
| --- | --- | --- | --- |
| Payment hold for online methods | **120 min** | An unpaid Stripe/PayPal/Klarna order is cancelled 2 h after it was placed (was: after `orders_abandon_after_days`, 3 days by default). Stripe's page closes at the same time. `payments/start` answers `409 payment.window_closed` after that. | `orders_payment_hold_minutes: 0` |
| Unpaid orders per buyer | **5** | The 6th open unpaid order from one email (abandonment window) is `429` `reason: checkout.too_many_unpaid`. For anonymous shoppers the same applies per client address, over the hold window only. Staff are exempt; API keys are capped by email only. Loopback and private addresses are never counted. **Behind a reverse proxy, check that `TRUST_PROXY=1` is set**, or the per-address count is silently off. | `orders_max_unpaid_per_buyer: 0` |
| Declined card (Stripe `payment_intent.payment_failed`) | always | The order stays `pending` with its stock, and `payment_declines` counts the attempts. It used to be cancelled on the first decline. The session expiring still cancels it. | none. The old behaviour was the bug. |
| Coupon refusal reasons | always | Anonymous callers and **API keys** get `coupon.reason: "invalid"` from `quote`, and a generic message plus `reason: checkout.coupon_invalid` from `orders`. `minimum-not-met` with `shortfall_cents` is unchanged. Staff sessions see the specific reason. | none. A storefront that showed "expired" now shows its generic text. |
| Checkout email | always | A value that is not exactly one address (`"name <a@b.co>"`, anything with a line break) is `422` on `email`, as `a@b` already was. Surrounding whitespace is still accepted. | none |
| Confirmation emails | 5 / recipient / hour | A sixth confirmation to one address within an hour is not sent. The order is placed normally. | none |
| Payment return URLs | always | Built from Settings → Site URL, then `SITE_URL`. The request `Host` is used only if neither is set. **Set Site URL to the storefront origin before deploying** (see the box above). `/api/health/deep` warns (`payment_return_urls`) while it is empty or points at the CMS. | set Site URL |
| PayPal approvals are **captured** | always | A buyer-approved PayPal order is now captured and becomes paid. It used to stay unpaid forever, and the new hold would then cancel it. An order the hold already cancelled is reopened first, and captured only if its stock is still there. A staff-cancelled order is never captured. New audit actions: `payment.capture_failed`, `payment.approval_not_captured`. | none. The old behaviour was the bug. |
| Forged webhooks | 20 failures / 10 min / IP | After that, `429` before verification. Far fewer `payment.webhook.invalid` audit rows are written. Loopback and private addresses are never throttled. | none |
| `checkout` / `magic-link` proof-of-work | **off** | Nothing, until an operator ticks them. A storefront must then send `pow_token` (INTEGRATION.md). | leave them off |
| Risk hold | **off** | With it on, a high-risk order is created `on-hold`, the 201 body says `status: "on-hold"`, and a payment leaves it on hold. | leave it off |
| `Idempotency-Key` on `POST /api/orders` | optional | Nothing unless the header is sent. The typed client now sends one on `orders.place()`. | none |

**Storage.** No migration is needed. On the relational driver the first start
creates `idempotency_keys` and two expression indexes on `orders`
(`created_at`, `number`); on a large order table that takes a moment once. On
lowdb and the libSQL doc driver, idempotency records live in the document under
`idempotencyKeys` and expire after 24 h. A custom `Storage` implementation must
add the nine new methods listed in CHANGELOG.

**The `order.hold_expired`, `payment.needs_refund` and `payment.declined` audit
actions** are new. A `needs_refund` order shows a red badge in Admin → Orders
and a "Needs fixing" card on the dashboard, which cannot be dismissed until
the refund is made. It also emails the sale-notification recipients (else
`admin_email`). The dashboard's "flagged orders" card now also counts orders
the risk hold put on hold.

**Lists with no `limit` stop at 1000 rows, and public reads now send caching
headers.** Below 1000 rows nothing changes. See U-17.

---

## U-17 — public reads are bounded and cacheable; email forms are limited per address

**Affects:** every install. **Action:** none for a storefront under 1000 posts
per listing; review the CDN note if you run one.

**1. `GET /api/posts` and `GET /api/content/{type}` with no `limit` return at
most 1000 rows.** Before, they returned the whole collection. Below 1000 the
response is byte-identical (`meta.limit: null`, `meta.hasMore: false`). Above
it, `meta.total` is the full count, `meta.hasMore` is `true`, and
`?offset=1000` returns the rest. An explicit `limit` is unchanged (max 200).

**2. Anonymous reads carry shared-cache headers.** `/api/products`,
`/api/products/{ref}`, `/api/brands`, `/api/product-categories`, `/api/search`,
`/sitemap.xml` and `/rss.xml` now send
`Cache-Control: public, max-age=0, s-maxage=30, stale-while-revalidate=300`,
`Vary: Cookie, Authorization` and an ETag (`If-None-Match` → `304`). A browser
still revalidates on every use; only a shared cache may serve a copy for up to
30 s, so a price or stock edit can take that long to show through a CDN.
Signed-in and API-key responses are `private, no-store`.

- To turn shared caching off: `PUBLIC_API_CACHE_SECONDS=0`.
- To shorten or lengthen it: `PUBLIC_API_CACHE_SECONDS=<s>`,
  `PUBLIC_API_CACHE_SWR_SECONDS=<s>`.
- **If a CDN sits in front of the API, add a rule that bypasses its cache for
  requests carrying the `astrobaas_session` cookie or an `Authorization`
  header.** Many CDNs ignore `Vary: Cookie`.

**3. `/og/{slug}.png`** is now rendered once per picture and cached in memory;
it carries an ETag. A draft's card (visible only to its author) is now
`private, no-store` instead of `public, max-age=86400`.

**4. Search and recovery matching read a bounded query.** The first 200
characters and 12 distinct words of a search; the first 1024 characters and 12
words of a recovery path. `/api/search`'s `meta.q` is the clipped query.

**5. Per-address limits on anonymous email forms.**

| Form | Limit | Past it |
| --- | --- | --- |
| `POST /api/newsletter` | 1 confirmation per address per day | same `201`, no email |
| `POST /api/products/{ref}/notify-me` | 10 signups per address per day | same `200`, nothing stored |

A visitor who asks for a second confirmation the same day receives nothing
new; the first link stays valid for a week. Notify-me also has its own per-IP
bucket now instead of sharing the newsletter's. On the shared libSQL
rate-limit store (`RATE_LIMIT_STORE=libsql`) "per day" is the UTC calendar day.

**6. Back-in-stock emails are batched.** At most 50 per scheduler tick
(`stock_waitlist_batch_size` setting, or `STOCK_WAITLIST_BATCH_SIZE`), oldest
request first; the rest go on following ticks. A large restock now takes a few
minutes to announce instead of going out in one burst.

**7. Form uploads: quota and clean-up.** Each form's uploads are capped at
`form_upload_quota_mb` (default **1024**, `0` = none); past it the upload
answers `413` with `error.reason: "forms.upload_quota_exceeded"`. An upload no
submission names is deleted after `form_upload_orphan_hours` (default **24**),
checked hourly. Files uploaded before this release carry no form and are never
swept or counted.

**8. AI assistant daily ceilings.** `assistant_daily_message_cap` (default
**500**) and `assistant_daily_ip_cap` (default **50**). Past either, the chat
answers `429`. A site with more than 500 assistant messages a day should raise
the first before upgrading. `0` removes a ceiling.

**Shoppers' browsers are now counted per route** (checkout, quote, payment
start, search) and **API responses no longer set a cookie.** If your storefront
SERVER calls the API for shoppers, nothing changes unless you opt in to
forwarding their addresses. See U-16.

---

## U-19 — one scheduler per database; backups and migrations survive restarts

No API response loses a field. A single-process install needs to do nothing;
this section is about what you will SEE, and what changes when you run more
than one process.

### What you will notice

- **The operations screen** says either "Running on this server…" (this process
  holds the scheduler lease) or "Standing by on this server: <host:pid:…> is
  running the sweeps". `GET /api/operations` gains `scheduler.role`
  (`leader` | `follower` | `standalone` | `stopped` | null), `scheduler.sweeps`
  and `scheduler.lease`, and `backup.lastSuccess` and `backup.inProgress`.
  `backup.last` now comes from the database, so it survives a restart.
- **After a deploy, no off-site backup** unless one is due. The first backup
  after upgrading happens on the first sweep, as before (there is no record
  yet); from then on the interval counts from the last recorded backup.
- **A backup interrupted by a crash or a deploy is retried after an hour**, not
  straight away (`BACKUP_ATTEMPT_TIMEOUT_MS`, minimum 1 s, never longer than
  `BACKUP_EVERY_HOURS`). A failed upload is still retried on the next sweep,
  and a failure to build the archive still waits up to an hour — both now
  judged from the stored record, so a restart does not reset either.
- **A lowdb install gets lease files** beside its database while it runs:
  `db.json.scheduler.lease` (and `db.json.migrations.lease` during an upgrade,
  plus a `.lock` for microseconds at a time). They hold host, pid and an expiry,
  nothing else. `.gitignore` and `.dockerignore` list them. Do not put them in a
  backup; deleting one only lets another process take over sooner.
- **The libSQL drivers get a `leases` table** in the same database, created on
  first use. No migration step.
- **The shutdown log line** has two more fields, `sweep_abandoned` and
  `lease_released`. A drain now also waits (within `SHUTDOWN_TIMEOUT_MS`) for a
  sweep that was already running.
- **The deep health check** has one more check, `offsite_backup`. It is only
  ever `ok` or `warn`, so a deploy script asserting a 200 is unaffected.
- **Newsletter campaigns** record `unconfirmed_count`: addresses in a batch
  whose sender stopped before it could record the result. A process killed
  mid-batch no longer resends that batch on restart; those addresses may simply
  not have received it.

### Running more than one process

1. Use the relational driver (`DATABASE_DRIVER=relational`) for more than one
   writer. The lease keeps the SCHEDULER to one process on every driver, but the
   doc-blob driver's ordinary writes are still whole-document last-write-wins,
   and lowdb is one process by design.
2. Every process ticks; one sweeps. If the leader is killed, another takes over
   within `SCHEDULER_LEASE_TTL_MS` (default three intervals — 3 minutes at the
   default 60 s interval; never less than two intervals plus a second). A clean
   stop hands over at the next tick.
3. Settings, redirects and plugin changes made on one process reach the others
   within 5–15 seconds (see CHANGELOG). Before this they did not reach them at
   all until a restart.
4. `SCHEDULER_LEASE=0` is an escape hatch for a single-process install whose
   database directory cannot hold a lock file. It makes every process sweep —
   never set it with two processes.

### New environment variables (all optional)

| Variable | Default | What it does |
| --- | --- | --- |
| `SCHEDULER_LEASE` | on | `0` = every process sweeps (the old behaviour). |
| `SCHEDULER_LEASE_TTL_MS` | 3 × interval | How long a dead leader blocks the sweeps. Floor: 2 × interval + 1 s. |
| `MIGRATION_LOCK_WAIT_MS` | 120000 | How long a booting process waits for another's migration before failing its init (the next request tries again). |
| `BACKUP_ATTEMPT_TIMEOUT_MS` | 3600000 | How long an unfinished backup attempt blocks a new one. |

---

## U-16 — request limits and sign-in hardening

**Affects:** every install. Most of it is invisible; the items marked
**CHECK** can change what a live shop sees.

**CHECK — per-address budgets on the expensive routes.** In addition to the
general 60/min per address, anonymous callers now have, per address, per minute:

| route | default | env |
|---|---|---|
| `POST /api/orders` | 10 | `RATE_LIMIT_CHECKOUT_PER_MIN` |
| `POST /api/orders/quote` | 30 | `RATE_LIMIT_QUOTE_PER_MIN` |
| `POST /api/payments/start` | 10 | `RATE_LIMIT_PAYMENT_START_PER_MIN` |
| `GET /api/search`, `GET /api/products?search=` | 30 | `RATE_LIMIT_SEARCH_PER_MIN` |

A storefront whose **browsers** call these directly is affected when many
shoppers share one address (an office, a mobile carrier's NAT) or when a
search box fires a request per keystroke without debouncing. Raise the env
value if you see `429` with `RateLimit-Limit` equal to one of these numbers.
Requests made with an **API key** are not charged to these budgets unless the
key is marked for client-IP forwarding, and **staff sessions** never are.

**Payment webhooks** (`/api/payments/webhook/*`) no longer spend the anonymous
60/min; they have their own 600/min per address (`RATE_LIMIT_WEBHOOK_PER_MIN`),
and they are **no longer held by maintenance mode**.

**CHECK — a write body must have a length.** An `/api` write carrying
`Transfer-Encoding` without `Content-Length` now gets `411 LENGTH_REQUIRED`.
Browsers and ordinary HTTP clients always send the length; a client that
streams a request body does not. Behind **Caddy**, which streams request bodies
by default, such a client is refused — buffer the body in the client.

**CHECK — API responses no longer set the CSRF cookie.** It is set when an HTML
page loads, and on a successful `POST /api/auth/login` for a client that had
none. A script that obtained `astrobaas_csrf` from some OTHER API response must
now sign in, or load a page, first. Cookie-less cross-origin storefront writes
never used it.

**IPv6 callers are counted per /64**, and `::ffff:a.b.c.d` as `a.b.c.d`. The
address stored in audit entries and used for order risk is that grouped
identity, so an IPv6 client's audit line now shows its /64.

**New: trusted client-IP forwarding for a storefront server.** Mark the key
(`POST /api/keys` with `"forward_client_ip": true`, or
`PATCH /api/keys/{id}` on an existing one) and send
`X-AstroBaaS-Client-IP: <shopper address>`. See INTEGRATION.md, "A storefront
SERVER calling for a shopper". Off by default.

**Sign-in.**

- After 5 failed sign-ins for one account within 15 minutes, **from any
  address**, that account's password is only checked together with a solved
  proof-of-work. The admin sign-in page does this in the background; a JSON
  client receives `403` with `error.code: "POW_REQUIRED"` and a challenge in
  `error.details.challenge` (see the OpenAPI description of
  `POST /api/auth/login`). Tune with `LOGIN_ACCOUNT_POW_AFTER`.
- 30 failed sign-ins from one address within 15 minutes, across any emails,
  refuse further sign-ins from that address (`429`) until the window rolls over
  (`LOGIN_IP_FAILURE_LIMIT`). Successful sign-ins do not count.
- The two-factor code step allows 10 attempts per account per 15 minutes
  (`TWOFA_ATTEMPT_LIMIT`).

**CHECK — signing out now revokes the token.** Replaying a signed-out session
cookie is refused. For the first 24 hours after the upgrade, signing out with a
session that was issued BEFORE the upgrade signs that person out on **every**
device (those tokens carry no id to revoke individually); after that, signing
out ends only the session it was done from. `npm run reset-password` now signs
the account out everywhere, as the web reset already did.

**`CORS_ORIGINS=*`** is unchanged in behaviour, but now logs a warning at
startup and makes `GET /api/health/deep` report `cors_origins: warn`. A deploy
script that fails on any warning will notice.

**libSQL rate-limit store:** the `rate_limits` table gains an `expires_at`
column on first use (added in place; rows from before the upgrade are swept),
and expired rows are removed for all keys once a minute.

**The change feed pages now — additively.** `GET /api/content/changes` returns
the same newest-first list as before, capped at 1,000, with `has_more`,
`next_cursor` and `truncated` added to `meta` and `fields` added to update
entries. A poller that ignores them keeps working unchanged. See U-15.

---

## U-15 — the change feed is paged, bounded, and pruned on every driver

**Affects:** anything polling `GET /api/content/changes`, and every install on
the relational driver (`DATABASE_DRIVER=relational`).

**Why.** The feed is an anonymous public read, and it read the whole feed on
every request. On lowdb and the libSQL doc-blob that was 1,000 entries at most —
the ring always capped it. On the relational driver nothing was ever pruned, and
every product and order save stored a full snapshot: one anonymous request was a
read of every save the shop ever made, parsed into memory, and the table grew on
every edit.

**What changed in the response — all additive:**

- `meta` gains `limit`, `has_more` and `next_cursor`. Follow `next_cursor` while
  `has_more` is true; see INTEGRATION.md §5 for the contract.
- `meta` gains `truncated`: `true` when retention has evicted a change you
  would have been shown, inside the window you asked for. It is the only way to
  know a poller fell behind — see "What to do" below.
- Update entries gain `fields`: the names of the fields the update touched, when
  the write path knew them. Anonymous callers get it too, except for orders and
  users.
- A request returns at most **1,000** entries, and that is also the default. On
  the document drivers that is everything the feed ever held, so a poller that
  ignores `meta` gets exactly what it got before. On the relational driver it is
  a bound that did not exist.
- Entries with the same `timestamp` are ordered by `id`. They used to come back
  in insertion order (document drivers) or no particular order (relational).
- `since` is compared as an instant. A bound without milliseconds
  (`…T10:00:00Z`) or with an offset (`+02:00`) used to be compared as a string,
  which dropped up to a second of changes after it. A bound with no zone at all
  (`2026-09-11T10:00:00`) is read as UTC — which is what the old string
  comparison effectively did — and never as the server's local time. You may
  now see changes you used to miss; revalidating them again is harmless.

**What changed on the relational driver:**

- The feed keeps the newest 1,000 changes, like the other two drivers. Each
  write prunes as it goes, but never more than 200 rows of a backlog.
- **The first boot of this version prunes an existing feed in the
  background.** The instance serves as soon as its schema is in place; the
  prune runs behind it, 1,000 rows a step, yielding to requests between steps.
  On a large catalogue that has never been pruned it takes a while, once, and
  reads stay bounded by their own limit meanwhile. If it cannot finish — a
  second process holding the lock, say — it logs that and the next boot carries
  on. The database file does not shrink until you `VACUUM` it; the pages are
  reused either way.
- The `content_changes (ts)` index is replaced by `(ts, id)`, built by that same
  background step **after** the prune, so over at most 1,000 rows.
- A new table, `content_changes_pruned` (one row per entity type), records what
  retention has evicted; `meta.truncated` is computed from it. It is created by
  the first boot. If that boot meets a lock it cannot wait out, the next request
  boots again rather than every request failing until a restart.
- Local `file:` databases now wait up to 5 seconds for a lock another process
  holds, instead of failing at once with `SQLITE_BUSY`. Remote (`libsql://`)
  databases are unaffected.

**What to do:** nothing, to keep working. To know when your revalidation job
fell behind retention — it was down, or it ran after a bulk import larger than
1,000 changes — read `meta.truncated` on the last page of each walk and
revalidate everything when it is `true` (INTEGRATION.md §5 has a worked
example). Do not count entries instead: the 1,000 counts every type, including
the ones your poller is never shown, so an overflowed window can hand it far
fewer. That was always true on the document drivers; they just never said so.

---

## U-18 — deploy and ops hardening (ACTION REQUIRED for self-hosted nginx/systemd/Docker)

Nothing in the API changes shape. What changes is how the process stops, where
form attachments are written, what the probes return, and the reference
configs. Do the steps in this order.

### 1. nginx: zones file FIRST, then the vhost

The vhost now names a new zone, `astrobaas_rare`. Copy the zones file again
before the vhost, or `nginx -t` refuses the vhost with
`zero size shared memory zone "astrobaas_rare"` (it keeps serving the old
config, so this is loud rather than an outage):

```bash
sudo cp deploy/nginx/astrobaas-zones.conf /etc/nginx/conf.d/00-astrobaas-zones.conf
# merge deploy/nginx/astrobaas.conf into your vhost, then:
sudo nginx -t && sudo systemctl reload nginx
```

When merging:

- **the `upstream` name must be unique per vhost.** Two AstroBaaS sites on one
  box that both keep `astrobaas_cms_example_com` stop nginx from starting.
- **`proxy_set_header` lines moved to server level.** Delete them from your
  locations — a location that keeps even one loses all the server-level ones.
- nginx < 1.25.1 (Debian 12, Ubuntu 24.04): keep `listen 443 ssl http2;` instead
  of `http2 on;`.
- If the server block includes certbot's `options-ssl-nginx.conf`, drop the
  vhost's own `ssl_*` lines — the same directive twice is a hard error.

Visible effects: a request refused by nginx's limiter now gets **429** instead
of 503; `/readyz` through nginx is loopback-only (403 elsewhere — probe it on
`127.0.0.1:<port>` as `deploy.sh` does, or add your balancer to its `allow`
list); `/healthz`, `/api/backup/import` and `/api/import/wordpress` are limited
to 10 a minute per address with a small burst.

### 2. systemd: new keys, then daemon-reload

Add from `deploy/systemd/astrobaas.service`: `PRIVATE_UPLOADS_DIR`,
`NODE_OPTIONS=--max-old-space-size=512`, `SHUTDOWN_TIMEOUT_MS=25000`,
`KillSignal=SIGTERM`, `TimeoutStopSec=30`, `LimitNOFILE=65536`. The heap ceiling
is sized for `MemoryMax=1G`; raise both together on a bigger unit.

```bash
sudo systemctl daemon-reload && sudo systemctl restart cms-example-com
```

A restart can now take up to 25 s: it waits for in-flight requests. That is the
point. `GRACEFUL_SHUTDOWN=0` restores the old immediate exit.

### 3. Form attachments: check where yours are

`PRIVATE_UPLOADS_DIR` used to default to `./private-uploads` in the working
directory. It now defaults to `private-uploads/` beside the database
(`shared/data/private-uploads` in the reference layout), and the reference unit
and Docker image set it explicitly.

- **Nothing stored yet, or `PRIVATE_UPLOADS_DIR` already set:** nothing to do.
- **Files in the old place:** the app keeps using it and logs
  `[private-uploads] Using the OLD location …` with the exact `mv` command. Stop
  the app, move the directory, start it. (Under the reference unit the old place
  was inside a read-only release, so on those installs uploads were failing
  anyway; look in older release directories for any that were written.)
- **Docker:** attachments written before this release are in the container's
  own layer at `/app/private-uploads` and are lost when the container is
  recreated. Copy them out first:
  `docker compose cp astrocms:/app/private-uploads ./private-uploads-backup`,
  then into the volume at `/app/data/private-uploads`.

### 4. Docker and compose

- The image builds again (the missing `db.seed.json` COPY is gone), and
  `docker-compose.yml` parses again (its `AUTH_SECRET` line was invalid YAML).
- `docker-compose.yml` publishes **`127.0.0.1:4321`** only. If something on
  another host reached the container through the published port, put a reverse
  proxy on this host or a shared Docker network in between — do not re-open
  `0.0.0.0` with `TRUST_PROXY=1`.
- The image sets `SHUTDOWN_TIMEOUT_MS=8000` (inside `docker stop`'s 10 s); the
  compose file raises it to 25 s with `stop_grace_period: 30s`, and runs an init
  as PID 1.

### 5. Probes and monitors

| | Before | Now |
|---|---|---|
| `/healthz` `posts` | the number of posts | always `null` |
| `/healthz` cost | read every post (and, on lowdb, a full rewrite) | one cached read per 2 s |
| `/readyz` `error` | the storage error message | always `"unavailable"` (the reason is in the log) |
| `/readyz` while stopping | 200 | 503, `{"ready":false,"draining":true}` |
| deep check | — | new `health_token` entry; a 16–31 character token turns `status` into `"warn"` (still 200) |

A monitor asserting `status == "ok"` on the deep check with a short
`HEALTH_TOKEN` will now see `"warn"`: rotate the token to 32+ characters
(`openssl rand -hex 32`).

### 6. deploy.sh

It now needs to know the app's port: `Environment=PORT=` in the unit (the
reference unit has it), `PORT=` in `shared/.env`, or `DEPLOY_PORT=`. It reads the
run-as user from the unit's `User=` (override with `DEPLOY_RUN_USER=`), and no
longer changes the owner of `shared/.env`. If you keep a private copy of the
script (e.g. `deploy.local.sh`), re-base it on the new one — the old body carries
the same bugs.

### 7. /metrics

Four new series, nothing renamed: `astrobaas_request_duration_seconds`
(histogram), `astrobaas_rate_limited_total`, `astrobaas_inflight_requests`,
`astrobaas_draining`.

---

## U-14 — the optical module now ships separately (ACTION REQUIRED for eyewear shops)

**Affects:** installs that licensed the optical module and ran it from this
repository before it moved out. **No one else** — a new install never had it,
and nothing in the core depends on it.

**What changed.** `src/plugins/optical/` has left this repository. The eyewear
vertical is a separate proprietary package, `@astrobaas/optical`, because a file
committed to a GPL-3.0 repository is GPL-licensed permanently and could not then
be licensed commercially. It is **not on the public npm registry**: installs
that licensed it receive it directly from the maintainer (see
[LICENSING.md](./LICENSING.md)).

**If you sell prescription eyewear, a deploy of the core alone will stop
validating prescriptions.** The order still completes — that is the core's
documented behaviour without a vertical — so a lens sells with nothing to grind
and no customer-facing error appears.

The server reports it on every boot:

```
[astrobaas] plugin "optical" is ACTIVE in the database but no implementation is
loaded. Anything it provides is silently not happening. The optical module ships
separately: install @astrobaas/optical and set ASTROBAAS_PLUGINS.
```

**To restore it**, install the package you received and name it:

```bash
npm install ./astrobaas-optical-<version>.tgz
ASTROBAAS_PLUGINS=@astrobaas/optical
```

Restart. The plugin's stored record is already active, so it resumes where it
left off. Verify with
`curl -s -o /dev/null -w '%{http_code}' <site>/api/commerce/prescription-schema`
— 200 means loaded, 404 means not.

**Not affected:** every install that does not sell eyewear. And **no stored data
changes**: prescriptions frozen onto past order lines are untouched and still
render in the admin, with or without the module. `Prescription` and
`summarisePrescription()` moved INTO `src/core/models.ts` precisely so that
stays true.

**New for everyone:** `ASTROBAAS_PLUGINS` loads compiled plugins from outside
this repository — paid modules and per-client integrations — without editing
`BUNDLED_PLUGINS`. See `src/plugins/external.ts`.

---

## U-13 — optical features moved into a module; existing optical shops keep working

**Affects:** installs selling prescription eyewear, and anything reading
`/api/commerce/prescription-schema`.

**What changed.** Prescription validation moved out of core checkout into a
bundled plugin, `optical` (`src/plugins/optical/`). Core now exposes one generic
hook, `PLUGIN_HOOKS.ORDER_LINE_EXTRAS`, and the plugin is what makes the answer
optical. Frame geometry, face measurement and fit arrived in the same module.

**You do not need to do anything.** Migration **v11** switches the module on for
any install with evidence it was already selling optical goods — a product
flagged `requires_prescription`, or a historical order line carrying a
prescription. Verified on lowdb, libSQL doc-blob and relational by booting a
real pre-upgrade database and confirming an Rx lens still cannot be bought
without a prescription.

A **general shop is left alone**: the module stays inactive, because turning an
eyewear vertical on for a shop that sells shoes would be the migration inventing
a decision you never made. Switch it on under **Admin → Plugins** if you want it.

**With the module inactive**, the install behaves like one that never had it:

- `/api/commerce/prescription-schema` and `/api/commerce/frame-schema` return
  **404**;
- `requires_prescription` becomes an inert flag — the product sells without a
  prescription, and nothing errors;
- prescriptions already frozen onto past order lines are **untouched** and still
  render. Deactivating a module never rewrites what a customer bought.

**New:** `GET /api/commerce/frame-schema` publishes frame geometry limits, face
measurement limits, the ISO/IEC 7810 ID-1 card dimensions and the fit tolerance,
shaped like the prescription schema. It also publishes `pd_lab_grade_methods` —
**a PD measured from a photo is for choosing a frame, never for a lens order.**

---

## U-12 — custom content types are private unless they say `visibility: 'public'`

**Affects:** plugins that call `registerContentType()`, declarative manifests
with a `contentTypes` capability, and any storefront reading
`GET /api/content/<type>` **without credentials**.

**What changed.** A registered content type used to be world-readable at
`GET /api/content/<name>` and `GET /api/content/<name>/<id>`, with no way to say
otherwise. It is now **private unless it opts in**:

```diff
 registerContentType({
   name: 'event',
   label: 'Event',
+  visibility: 'public',     // omit -> staff only
   fields: [ /* … */ ],
 });
```

Same key in a declarative manifest:

```jsonc
"contentTypes": [
  { "name": "event", "label": "Event", "visibility": "public", "fields": [ /* … */ ] }
]
```

**Why.** The old default was fine for `event` or `doc` and a data breach for
`job-application` or `enquiry` — and it fell on the plugin author who never
considered visibility, which is exactly the author most likely to get it wrong.
Deny-by-default costs one line and puts the decision where the answer is known.
This is audit item D2-4.

**Symptom if you are affected.** An anonymous `GET /api/content/<type>` returns
`404` where it used to return `200` with a list. It is `404` and not `403` on
purpose: whether a private collection exists is itself information, so it is
indistinguishable from a type that was never registered.

**Not affected:**

- **Writes.** `POST`/`PUT`/`DELETE` were always admin/editor and are unchanged.
- **Authenticated reads.** A session, or an API key scoped to `content`, reads
  private types exactly as before.
- **The bundled `product-catalog` plugin**, which now declares
  `visibility: 'public'` — a demo catalogue is shop-window data.
- **The built-in `/api/products`, `/api/posts`, `/api/categories/get`** and every
  other core endpoint. This applies only to plugin-registered custom types.

**Fixing it** is one line in the plugin that registers the type. An unrecognised
value (`"publik"`) is rejected at registration and at manifest validation rather
than falling back, because both possible fallbacks are wrong: one leaks the
collection, the other breaks a storefront with no message saying why.

---

## U-1 — `content` is the source of truth again; rendered output moved

**Affects:** anything reading `content` or `title` from `GET /api/posts` or
`GET /api/posts/{ref}`.

`GET` used to return `content: applyFilters('post_content', …)` — the RENDERED
text — under the same key the editor writes back. So opening a post in the
admin and pressing Save persisted the plugin's output as the stored content:
cumulative on every save, and it survived deactivating the plugin.

Now:

```jsonc
{
  "content":          "<p>What you actually wrote.</p>",   // raw, safe to PUT back
  "content_rendered": "<p class=\"reading-time\">⏱ 1 min read</p><p>What you actually wrote.</p>",
  "title":            "Raw title",
  "title_rendered":   "Filtered title"
}
```

**What to do:** if your storefront renders plugin output (reading time, badges),
switch to `content_rendered`. If it just renders the post body, `content` is
what you want and nothing needs to change — it is valid HTML either way.

**Why this direction:** a `GET` must round-trip through a `PUT` without changing
the resource. Returning a derived value under the stored field's name is what
corrupted posts.

---

## U-2 — `GET /api/media/get` is no longer public

**Affects:** API keys that list the media library. **Not** image rendering.

The route was in the public allow-list, so anyone could enumerate every
uploaded file — original filenames, sizes, upload dates. For a real shop that
means things like `price-list-2026.pdf`, or a customer's prescription scan,
where the filename alone leaks.

Two consequences:

1. Anonymous callers get `401`.
2. Because it left the allow-list, it also left the scope-gate exemption — a
   bearer key now needs `media:read`. **An existing storefront key minted before
   this will get `403` on this route.**

**What to do:** nothing, unless your storefront calls `/api/media/get`. Images
render from `/uploads/**`, which is still public, and product image URLs are
embedded in the product record. If you do need the list, re-mint the key —
`scripts/mint-storefront-key.mjs` now includes `media:read`.

---

## U-3 — credential-shaped settings are never returned

**Affects:** anything reading secrets back out of `GET /api/settings/get`.

`visibleSettings` began `if (isStaff) return settings`, so the deny-list never
ran for staff: an **editor** — a role that cannot reach most of the admin —
could read `smtp_password` and `stripe_secret_key` from a route in the public
allow-list.

Keys whose NAME looks like a credential (`password`, `secret`, `token`,
`api_key`, `private_key`, …) are now withheld at **every** role and reported as
a boolean instead:

```jsonc
{ "smtp_password__is_set": true, "stripe_publishable_key": "pk_live_…" }
```

`publishable` and `public_key` are deliberately exempt — a Stripe publishable
key is meant to be public and withholding it would break checkout.

**What to do:** nothing for a storefront. The admin UI reads settings
server-side and is unaffected. If you have tooling that read a secret back out
of the API, it must now get it from the environment instead — which is where a
secret should have come from.

---

## U-4 — read-side ownership on posts

**Affects:** callers authenticated as `author` or `viewer`.

The check was `if (!user)`, so **any** authenticated caller saw every
unpublished body — embargoed announcements, unreleased pricing, other people's
drafts. Now:

| role | published | own drafts | others' drafts |
|---|---|---|---|
| anonymous / `viewer` | yes | — | no |
| `author` | yes | yes | **no** |
| `editor` / `admin` | yes | yes | yes |

**What to do:** nothing if your key is `editor` (the default from the mint
script) — it sees everything as before. Note that this also means a storefront
key with `editor` role can read drafts; if your storefront renders whatever the
API returns, consider minting it as `viewer` so unpublished content cannot
appear on a live site.

---

## U-5 — the change feed no longer hands out snapshots

**Affects:** anything polling `GET /api/content/changes`.

The feed stores FULL entity snapshots — draft bodies, and orders with customer
name, email, phone and address — and gated on `if (user)`. Any session, or any
scoped key, read all of it.

Snapshots now require `editor`/`admin`. Everyone else gets the timeline: what
changed and when, never what it said.

**What to do:** nothing for an `editor` key. If you polled this as a lower role,
you now get metadata and must fetch the entity itself.

---

## U-6 — production refuses the seeded password

**Affects:** deployments still using `admin@local` / `admin`.

Once this project is public, `admin` is not a default — it is a published
credential, and every install that kept it is one `/login` scan away.

- A fresh **production** boot with no `ADMIN_PASSWORD` generates a random one
  and prints it **once** to stdout.
- Login **refuses** the seeded password when `NODE_ENV=production`, with a
  distinct `SEED_PASSWORD_REFUSED` error.

**What to do:** set `ADMIN_PASSWORD` before first boot, or run
`npm run reset-password` on an existing install. `ALLOW_SEED_PASSWORD=1`
overrides for a trusted private deployment. Development is unchanged — zero
config local dev is the point of the lowdb driver.

---

## U-6b — the Site URL setting now wins over `SITE_URL`

**Affects:** any deployment where the admin's "Site URL" field and the
build-time `SITE_URL` differ.

The field was stored and read by nothing: `sitemap.xml`, `rss.xml`,
`robots.txt`, the canonical tag and the JSON-LD all used Astro's build-time
`site`. Filling it in had no effect.

It is now the highest-precedence source (setting → build-time `SITE_URL` →
request origin), because the setting is editable at runtime and `SITE_URL` is
baked in at build — the setting is the one an operator who moved domains, or who
runs a prebuilt image, can actually change.

**What to do:** if your admin "Site URL" contains a stale or placeholder value
while `SITE_URL` is correct, the absolute URLs in your sitemap, feed, canonical
tags and structured data **will change to the stored value**. Check the field
before upgrading, or clear it to fall back to `SITE_URL` as before. Values that
are not valid `http(s)` URLs are ignored rather than emitted.

---

## U-7 — 2FA material never leaves the server

`GET /api/users/get` stripped the password fields and not `two_factor`, so the
TOTP secret and backup-code hashes were returned. `POST /api/users/update` did
the same. An admin able to read another admin's second factor can enrol it,
which makes 2FA a second copy of the first factor.

All user-returning routes now use one sanitiser and expose
`two_factor_enabled: boolean` only.

---

## U-8 — media deletes are refcounted (data-loss fix)

Filenames are content-addressed, so two uploads of identical bytes are two
records sharing one file. Delete unlinked unconditionally, so removing one
record permanently broke the other — the row survived, its `url` still looked
right, the bytes were gone.

It was also an escalation: an `author` could re-upload an admin's image and
delete their own copy to destroy the admin's file.

Deletes now remove the file only when no other record points at it, and clean
up the `-thumb.webp` derivative, which was previously left readable forever at
a derivable URL.

**No action needed.** Existing data is unaffected; this only changes what
happens on future deletes.

---

## U-9 — thumbnails are persisted (performance)

`thumb_url`/`width`/`height` were attached to the upload RESPONSE after the
record was created, so the database never held them and the library rendered
full-resolution originals as 200px tiles.

**Migration v10** backfills existing rows by deriving the sibling filename. It
records a pointer only — it never creates or deletes a file — so a row whose
derivative is missing simply keeps falling back to the original, exactly as
today.

---

## U-10 — the lowdb read cache

lowdb's `read()` re-parses the whole JSON document on every call, and every
getter calls it. Measured: 158.7 ms per parse on a 26.5 MB database, ~9 parses
to serve one `/blog` request.

Reads are now cached and validated on inode + size + mtime, so a write from any
other process — an import CLI, a restore, a second replica — is still picked
up. Benchmarked at **17× fewer parses** on a 3.8 MB database.

Only the lowdb driver is cached. The libSQL drivers are untouched, because
there is no file to stat and a cache there would have to assume no other
replica has written.

**No action needed.** This is the change most likely to be felt as "the admin
got faster".


---

## U-11 — posts gained a `kind`, and pages are excluded by default

`Post` now has an optional `kind: 'post' | 'page'`. A **page** is the same
record routed at `/{slug}` instead of `/blog/{slug}`, with no date or author
byline — an "About" or "Contact" document rather than an article.

**Every record you already have has no `kind` at all, and absent means
"article".** Nothing was migrated and nothing needed to be: the classifier tests
`kind !== 'page'`, so a row written years ago is still an article on every
surface it appears on.

### What a headless storefront sees

Nothing, unless it asks. Pages are **excluded** from the article surfaces rather
than added to them:

| Surface | Behaviour |
|---|---|
| `GET /api/posts` | Articles only — **unchanged**, byte-for-byte, until you opt in |
| `GET /api/posts?kind=page` | Pages only |
| `GET /api/posts?kind=all` | Both |
| `GET /api/posts/{slug}` | Returns either — unchanged |
| `/blog` and `/rss.xml` | Articles only |
| `/sitemap.xml` | Pages at `/{slug}`, articles under `/blog/{slug}` |

Excluding rather than including is the deliberate choice. Had pages simply been
added to the list, the day an operator wrote an "About" page it would have
appeared at the top of a storefront's blog listing and in every RSS
subscriber's reader — a content change nobody made. An unrecognised `kind=`
value falls back to the default rather than erroring, so a typo in a query
string cannot empty a production listing.

### If you want a CMS page as your home page

Set `home_page_slug` in Settings → General (a picklist of your pages). The
setting is published through `GET /api/settings`, so a decoupled front end can
render the same document. If the named page is later renamed, unpublished or
deleted, the stock welcome page renders instead — the front door cannot go down
because of a stale setting.

**No action needed.** This section exists so that when you *do* create a page
and it does not appear in `/api/posts`, you know that is the design.
