# Changelog

All notable changes to AstroBaaS will be documented here. Format inspired by
[Keep a Changelog](https://keepachangelog.com/); we don't follow strict
semver yet because the API surface is pre-alpha.

## [Unreleased]

Nothing yet.

## [0.1.1] — 2026-09-23

### The published types work under `moduleResolution: nodenext`

0.1.0's declarations imported each other without file extensions
(`from '../core/models'`) — 116 such imports in 94 `.d.ts` files. That is fine
for a bundler, but under `nodenext`, which `tsc --init` chooses for an ESM Node
project, every one is TS2834 inside `node_modules/astrobaas` for anyone who does
not set `skipLibCheck`. Found by installing 0.1.0 from npm in a clean container.

- `scripts/build-pkg.mjs` now rewrites each relative import in the emitted
  declarations to the file it resolves to (`x.js`, or `x/index.js`).
- `tests/package-types.test.mjs` (in `test:pkg`) packs the real tarball,
  installs it into an empty project and type-checks it with `skipLibCheck: false`
  under `nodenext` and `bundler`: a Node project using all three entrypoints, and
  a frontend that uses only `astrobaas/client` and has no Node types. Without
  the rewrite, both `nodenext` cases fail.

### Also

- **The MCP server reports its real version.** It said `0.1.0` from a literal;
  it now reads the `package.json` of whichever package it shipped in, and
  `tests/mcp-package.test.mjs` checks both copies against the release version.
- **Dependabot PRs can pass the checklist check.** The PR-checklist workflow
  failed every Dependabot PR (it cannot tick boxes), and the check is required,
  so none could merge. It now passes `dependabot[bot]` by exact login; everyone
  else still needs the boxes ticked.

## [0.1.0] — 2026-09-23

The first public release. Published to npm under the `alpha` dist-tag
(`npm install astrobaas@alpha`); see PUBLISHING.md for why it is not `latest`.

### `npx astrobaas-mcp` works

`npx` resolves a package name, not a bin name, so the `astrobaas-mcp` binary
inside `astrobaas` was unreachable from an MCP client config — which runs on a
machine with no AstroBaaS installed. It is now also its own package,
`astrobaas-mcp`: zero dependencies, staged verbatim from `bin/` by
`scripts/build-mcp-pkg.mjs` and published by the same workflow, on `latest` so
the bare `npx astrobaas-mcp` finds it. `tests/mcp-package.test.mjs` packs the
real tarball, installs it offline into an empty project and checks that it
lists the same tools as the in-repo server; leaving the server's one import out
of the package fails it. README and INTEGRATION.md now show
`npx -y astrobaas-mcp` instead of an absolute path into a clone.

### Pre-publication review

- **A production build refuses the `.env.example` placeholder as `AUTH_SECRET`.**
  It is 40 characters, so it passed the only check (16 or more), and sessions
  are stateless HMAC tokens: an install that copied the file without editing it
  signed its admin cookies with a key anyone could read on GitHub. It is now
  refused like a missing secret, as is the dev-only fallback, and the server
  says so once at startup instead of only failing the first sign-in.
  `tests/prod-gates.test.mjs` reads the placeholder out of `.env.example`, so
  changing one without the other fails the build.
- **The public 500 page no longer shows the error to visitors when `NODE_ENV`
  is unset.** It tested `NODE_ENV` directly, which `node dist/server/entry.mjs`
  under systemd or PM2 does not set; it now asks `isProductionRuntime()`, like
  the other production gates.
- **The Docker image carries `LICENSE`, `NOTICE` and `THIRD-PARTY-NOTICES.md`.**
  It bundles libvips, and the notices file makes keeping its notice with such a
  distribution a condition.
- **`npm test` passes on a copy without `.git`** (a "Download ZIP" or a
  tarball): `tests/docs-links.test.mjs` walks the tree when `git ls-files` is
  unavailable.
- `devalue` 5.9.1 and `fast-uri` 3.1.8: `npm audit` reports nothing.
- `.env.example` and the README say what really happens without a usable
  secret, and that `npm start` does not read `.env`.


### What the public API promises, now checked by a test

STABILITY.md says the public API is "everything exported from
`astrobaas/core`, `astrobaas/plugins` and `astrobaas/client`" — and nothing
verified that its tables said the same. They had drifted: sixty-odd exports had
no row, among them every commerce model, the payment-provider contract, the
theme-slot props added after v1, and the text helpers the bundled
`reading-time` plugin already imports. An author reading the document could not
tell a promise from an accident, which is the one question it exists to answer.

- **The tables now match the barrels**, and `tests/stability.test.mjs` asserts
  it in both directions: nothing is exported in silence, and nothing is
  promised that is not there. The test fails with the offending names, so the
  fix is always obvious.
- **"Exported, but not part of the promise"** is a new section, because some
  names are exported only so the application can import them across files.
  `ensurePluginsBootstrapped` and the rest of the plugin bootstrap are called
  by the middleware and a dozen routes; a plugin must not call them. Naming
  them is more honest than leaving them undocumented and hoping.
- **`redeliver` is no longer exported from `astrobaas/core`.** Re-sending a
  logged webhook delivery is an operator action, and it already has an
  authenticated route (`POST /api/webhooks/deliveries/{id}/redeliver`) and a
  client method (`baas.webhooks.redeliver(id)`) that check the caller's role.
  Both are unchanged; only the unguarded server-side export is gone, and the
  test now keeps it off the barrel.

### deploy.sh releases start, and the post-deploy mail test runs on one

Both found by the first real `deploy.sh` run onto an existing install
(a live site, 2026-09-18).

- **A deploy.sh release could not be entered by the app, and the service
  stayed down.** The release is staged in `mktemp -d`, which is `0700`, and
  `rsync -a "$STAGE/" host:$RELEASE/` copies the stage's own mode onto the
  release root. `remote-activate.sh` then handed the release to root, flipped
  `current` and restarted: systemd failed every start with `200/CHDIR` until its
  start limit gave up, and the readiness loop could only report it. On
  that site that was 1 min 35 s of downtime, ended by hand with `chmod 0755`.
  deploy.sh now opens the stage to `0755`, and `remote-activate.sh` sets the
  release root to `0755` and everything under it group-readable (never
  group-writable) before it points `current` at it, so a release that arrives by
  any other route is safe as well. "Never group-writable" is enforced, not just
  intended: `chmod -R g+rX,g-w`, because `g+rX` alone only adds bits and a
  release built under umask 002 (the Debian/Ubuntu default for a user with their
  own group) kept `0775`/`0664`, which after the chown let the app rewrite its
  own code. `tests/deploy-artifacts.test.mjs` activates a release that arrives
  `0700`, and one that arrives group-writable.
- **The mail test ships with the build.** Step 5b of deploy/README.md ran
  `scripts/mail-test.mjs` inside `current`, but a release carries `dist/`,
  `package.json` and a production `node_modules` — no `scripts/`, no `src/`, no
  esbuild — so the one check prescribed after every deploy could not run.
  `npm run build` now also compiles the test into `dist/mail-test.mjs`
  (`scripts/build-mail-test.mjs`); deploy.sh refuses a build without it, the
  Dockerfile builds with `npm run build` so the image has it too
  (`docker compose exec app node dist/mail-test.mjs you@example.com`), and the
  docs run that file. `npm run mail:test` is unchanged for a checkout: both run
  the same code (`scripts/lib/mail-test-main.mjs`). `tests/email-smtp.test.mjs`
  runs its whole end-to-end CLI suite against both, the bundle from a directory
  with no `src/`, and holds every package the bundle imports to `dependencies`.

### The SMTP transport meets a strict transactional mail server's rules

Pointing AstroBaaS at your own or your host's mail server now works against a
server that enforces the rules, not only a lenient one. Every new key is
optional; an install that sets none of them keeps sending. Upgrade notes are in
UPGRADE.md, U-21.

- **Retries, by default.** A transient failure — a `4xx` reply, a dropped
  connection, a timeout — is retried on a fresh connection after ~2 s, then
  ~6 s (`SMTP_RETRIES`, default 2, at most 2). A `5xx`, a failed login and a
  certificate error never are. A retry carries the same `Message-ID`. (As first
  written this also retried a reply lost after the final `.`; see the entry
  above — that is now never retried.)
- **No send can hang.** The STARTTLS handshake had no timer: a server that
  answered `220` and then went silent held the send open forever. It now times
  out like every other wait, and one attempt as a whole is capped at
  3 × `SMTP_TIMEOUT_MS`. Worst case for one message: ~99 s at 10000.
- **Every message has a `Message-ID`** on the From domain. There was none.
- **EHLO gives the client's name** (`SMTP_HELO_NAME`, default this machine's
  FQDN, else `EMAIL_FROM`'s domain). It used to give `SMTP_HOST` — the server's
  own name, which a strict server refuses.
- **Reply-To** (`EMAIL_REPLY_TO`) on every message and every transport, SMTP2GO
  included. Form notifications (contact form, content types with an email
  field) reply to the submitter; a submitted value that is not an address is
  dropped, never written into a header. An unusable `EMAIL_REPLY_TO` does not
  stop mail: it goes without the header, and the startup log and the deep
  health check say so.
- **One log line per message**: `[email] smtp sent to=i***@example.com
  attempts=1: 250 …`, or one `smtp failed` line with the attempts and the
  server's reply — logged by the transport, so it is there whoever the caller
  is. The email log stores the server's reply (the queue id), and Operations
  shows it.
- **The credential cannot leak through the server.** A reply that echoes the
  AUTH token or the password is scrubbed before it reaches an error, a log
  line, the email log or an endpoint. A test drives a failing and a
  succeeding send through the real path and searches everything they left.
- **`EMAIL_CAMPAIGNS=0`** (or false/no/off) refuses newsletter campaigns at
  Send with the reason, and a queued one waits with nobody marked failed — for
  a mailbox licensed for one-to-one mail only.
- **A non-ASCII From name no longer hides the address.** The whole `From`
  value was RFC 2047-encoded, address included; only the name is now. An ASCII
  name is written byte for byte as before.
- **SMTP2GO sent no headers at all**, so it also dropped List-Unsubscribe on
  campaigns. It now sends them, with Reply-To, as `custom_headers`.
- **The health check names the variable.** A mistyped `EMAIL_TRANSPORT` used
  to be treated silently as `console`; a broken SMTP config used to be answered
  with a suggestion to use another product.
- **`npm run mail:test -- [--env-file=…] you@example.com`** sends one message
  through the app's own mail code and prints the SMTP conversation (AUTH
  masked) and the server's reply; exit 0 on acceptance. It warns when
  `SMTP_PASS` is not single-quoted and contains a character systemd and Node
  read differently.
- `package.json` defined `test:unit` twice; JSON keeps the last, which was a
  strict superset, so nothing was lost. The duplicate is gone and
  `tests/suite-registration.test.mjs` now fails on any npm script defined twice.

### More than one process on one database

Everything below was written for one process and quietly did something wrong
with two — a second replica, a PM2 cluster, a CLI import running beside the
server, or simply two processes overlapping during a deploy.
`tests/multi-instance.test.mjs` runs real processes against one database on all
three drivers. Upgrade notes are in UPGRADE.md, U-19.

- **The scheduler ran in every process.** Every newsletter batch, recovery
  reminder and back-in-stock notice went out once per replica, every abandoned
  order was cancelled by each of them, and each pushed its own full off-site
  backup. A process now sweeps only while it holds the `scheduler` lease: a
  `leases` table on the libSQL drivers (one conditional upsert, judged on the
  database's clock), a `<db>.scheduler.lease` file beside a lowdb database.
  The others stand by and take over within one lease TTL (three intervals,
  3 min by default) if the leader dies, or at their next tick if it shut down
  cleanly. The operations screen says which process is running the sweeps.
  `SCHEDULER_LEASE=0` restores the old every-process behaviour;
  `SCHEDULER_DISABLED=1` still turns the scheduler off.
- **Every restart pushed a full off-site backup, and a crash during one was a
  backup loop.** The last attempt and its result lived only in memory. They are
  now kept in the `offsite_backup_state` setting (not public): an attempt is
  marked before it starts and cleared when it records its outcome, so a
  restarted process does not back up until one is due, and a process that comes
  up after a crash mid-backup waits an hour (`BACKUP_ATTEMPT_TIMEOUT_MS`) before
  trying that backup again. The operations screen shows the record, including
  the last success and an attempt in progress; the deep health check gains an
  `offsite_backup` check (warning only). "Back up now" is recorded the same way.
- **Two processes booting together both ran the migrations.** They now run
  under a `migrations` lease; a process that cannot take it waits up to two
  minutes (`MIGRATION_LOCK_WAIT_MS`) and then finds the work done. A database
  that is already current never touches the lease.
- **A newsletter batch could be sent twice.** The cursor was read, the batch
  sent, then the cursor written. The batch is now claimed first, with a
  compare-and-set on the cursor (one conditional UPDATE on the relational
  driver, a compare-and-swap of the document on doc-blob). The trade is stated:
  a process killed mid-batch now leaves up to 25 addresses possibly unsent
  (counted in the campaign's new `unconfirmed_count`) instead of sending them
  twice on restart.
- **A shutdown did not wait for a sweep in flight.** The drain now waits for it
  within the same budget (a sweep stops at its next check once the drain has
  begun, so it does not start a backup or a campaign batch on its way out),
  writes the buffered views, and only then releases the scheduler lease. The
  shutdown log line gains `sweep_abandoned` and `lease_released`.
- **Caches were refreshed only by the process that took the write.** The media
  base now expires after 5 s, the redirect map is re-read in the background
  after 15 s, and the plugin registry (active plugins, their routes, admin
  pages and payment gateways, comments/reviews and admin content types) is
  re-checked every 15 s and rebuilt when another process changed it. The theme
  already had a 5 s TTL.
- **`LocalDB.init()` rewrote the whole document on every call** — every API
  request — on the lowdb and doc-blob drivers. With two doc-blob replicas that
  was a request-sized window, on every request, in which one replica's write
  could be overwritten by the other's unchanged copy. It now writes only when it
  actually repaired something.
- **The lease table goes through the shared SQLite opener**
  (`storage/local-sqlite.ts`, below): the 5 s busy timeout, WAL, one connection,
  and a restore moves it onto the restored file like the other clients. Every
  lease and claim statement is a single statement — none uses an interactive
  transaction, which would hold the one connection.

### Checkout can no longer be used to hoard stock, replay payments or probe coupons (hardening step 4)

Found by a review of the public, anonymous checkout and payment surface. Every
race was **reproduced before it was fixed** — `tests/checkout-race.test.mjs`
forces the interleavings on all three drivers — and every behaviour change is
pinned in `tests/checkout-abuse.test.mjs`.

**Stock hoarding.** One IP could place 60 orders a minute, each reserving stock,
and an unpaid order held it for days.
- **Payment hold** — `orders_payment_hold_minutes`, **default 120**, `0` = off,
  clamped 30–1440. An unpaid order whose payment method is an online provider
  (any id in the payment registry) is cancelled when the hold runs out, and its
  stock is returned. A new scheduler sweep does this through `setOrderStatus`,
  with the decision re-checked at the write. It records
  `cancelled_reason: "hold-expired"` and audits `order.hold_expired`.
  Bank transfer and cash on delivery keep the day-based sweep. Stripe Checkout
  sessions now expire with the hold (clamped to Stripe's 30 min – 24 h).
  `POST /api/payments/start` answers `409 payment.window_closed` once the hold
  is over.
- **Unpaid cap** — `orders_max_unpaid_per_buyer`, **default 5**, `0` = off. The
  limit counts open unpaid orders by normalised email over the abandonment
  window, and by hashed client IP over the hold window. The next order is
  `429 checkout.too_many_unpaid`, with `Retry-After`. API keys are capped by
  email only; staff sessions are not capped. Loopback and private addresses
  are never counted (they mean an untrusted proxy, not a shopper), and neither
  are they webhook-throttled.
- **Declined cards no longer cancel.** Stripe `payment_intent.payment_failed`
  is a new `declined` outcome: counted on the order (`payment_declines`), and
  flagged `card_testing` at five. Before, the first declined card cancelled the
  order and released its stock, so card testing cycled the shop's inventory.
  Session expiry still cancels.
- **A payment after a cancellation** reopens the order and re-reserves its
  stock. If the stock is gone, the order stays cancelled with
  `needs_refund: true`, a `payment.needs_refund` audit entry, and an email to
  the owner.

- **PayPal approvals are captured (S4.16).** Orders were created with
  `intent=CAPTURE`, and nothing ever called capture: an approved PayPal order
  read back as "ignored", was never paid, and the hold then cancelled it.
  `CHECKOUT.ORDER.APPROVED` is now an `approved` outcome. Its amount is checked
  first. Then the payment layer captures it through the new
  `PaymentProvider.captureApproved`, with a `PayPal-Request-Id` derived from
  both order ids, and applies the **capture response**, including the amount
  check. `ORDER_ALREADY_CAPTURED` is read back. Other refusals count as
  declines; an outage answers 500 so PayPal redelivers. An order the hold
  cancelled is reopened (stock taken back) **before** capturing, and put back if
  the capture fails. An order cancelled by staff, or whose stock is gone, is
  never captured (`payment.approval_not_captured`). A
  `payment_capture_started_at` lease keeps the hold sweep off an order while
  its capture runs.
- **A cancellation's reason no longer outlives it (S4.18).** The sweeps
  wrote `cancelled_reason` after their cancel, and nothing ever removed it. An
  order the hold cancelled and staff reopened still read "hold-expired" once
  staff cancelled it, so a redelivered PayPal approval reopened and charged an
  order staff had cancelled.
  - `setOrderStatus` now sets the reason, or removes it, in the same write as
    any move into or out of cancelled/refunded. `transitionOrderStatus` takes
    the fields to write with the move.
  - The sweeps pass their reason through it.
  - Putting an order back after a failed capture restores the reason.
  - The "payment time ran out" badge shows only on cancelled orders.
  - Orders reopened before this change are corrected the next time they are
    cancelled.
- **Return-URL deploy check (S4.17).** `/api/health/deep` has a new
  `payment_return_urls` check, also shown under Settings → Site URL. It
  **warns** (never fails) when an online provider is enabled and Site URL is
  empty, or buyers would be sent back to the CMS's own address.
- **Dashboard attention feed (after merging #65).**
  - New `orders-need-refund` card: broken, cannot be dismissed, aged from when
    the flag was set.
  - New `payment-return-urls` card: unfinished, same verdict as the health
    check.
  - `flagged-orders` now also counts risk-held `on-hold` orders.
  - The new cards are translated in en, el and de.

**Races (S4.4, S4.7, S4.9, S4.10).**
- A **one-use coupon** could be used twice, and five checkouts used a two-use
  code five times while the counter read 1. Uses are now claimed atomically
  before the order is written (`claimCouponUse`) and handed back on rollback.
- **One webhook event delivered twice** was captured twice. Worse, a failure
  decided on a stale read overwrote `paid` and **cancelled a paid order,
  releasing its stock**. Events are now claimed atomically, together with the
  payment status they were decided on (`claimPaymentEvent`).
- **Two partial refunds at once** lost one refund record, and a double-clicked
  refund was audited twice. Refunds are now appended atomically
  (`appendRefund`).
- **POST /api/orders accepts `Idempotency-Key`.** A retry returns the original
  201 (`Idempotent-Replayed: true`). A concurrent retry gets
  `409 IDEMPOTENCY_IN_PROGRESS`, and a different body under the same key gets
  `422 IDEMPOTENCY_KEY_REUSED`. Keys are durable on all three drivers. The typed
  client sends one on `orders.place()` and keeps it across its retries.

**Abuse.**
- Two new proof-of-work surfaces, `checkout` and `magic-link`, both **off by
  default**.
- Coupon refusals collapse to `reason: "invalid"` for anyone but staff (API
  keys included). `minimum-not-met` and its shortfall are kept. A checkout
  refused for its coupon is `400 checkout.coupon_invalid`.
- Checkout validates the email anchored (the old pattern accepted
  `a@b.co\r\nBcc: …`). Order confirmations are capped at 5 per recipient per
  hour.
- PayPal OAuth tokens are cached until expiry.
- Forged webhooks are throttled per IP (20 failures per 10 min, then 429)
  **before** any outbound verification call, and their audit rows are
  aggregated.
- Payment and refund return URLs come from the configured Site URL, and payment
  start finds the order by number instead of loading every order.
- Risk velocity is no longer blind past the newest 200 orders.
- **Opt-in risk hold** (`orders_risk_hold_enabled`, off): a high-scoring order is
  placed `on-hold`, and paying does not move it on.

New storage methods (all three drivers): `getRecentOrders`, `getOrderByNumber`,
`claimCouponUse`, `releaseCouponUse`, `claimPaymentEvent`, `appendRefund`,
`claimIdempotencyKey`, `completeIdempotencyKey`, `releaseIdempotencyKey`. The
relational driver adds the `idempotency_keys` table and two expression indexes
on `orders`. See UPGRADE.md U-20.
### Deploy and ops: the shipped artifacts now do what they say

Every item here was in a file no test read, and each looked fine until it ran.
`tests/deploy-artifacts.test.mjs` now reads all of them, and runs the server half
of `deploy.sh` against a scratch tree. Upgrade steps are in UPGRADE.md, U-18.

- **`deploy.sh` could never finish.** Its health check URL still said
  `http://127.0.0.1:<port>/healthz`; curl refused it on every deploy and `set -e`
  skipped the release clean-up. The server half is now a real file,
  `deploy/remote-activate.sh`: it reads the port and the run-as user from the
  unit (it used to chown to `site-<slug>` while the reference unit runs as
  www-data, and chowned `shared/.env` to the app too), creates
  `shared/data/uploads`, `shared/data/private-uploads` and `shared/maintenance`,
  ships the maintenance page, waits for **`/readyz`** rather than `/healthz`, and
  on failure prints the rollback command instead of pruning the release you would
  roll back to.
- **`docker build` failed on a clean clone** — the Dockerfile copied a
  `db.seed.json` the project no longer ships.
- **Form attachments were written to the wrong place.** `PRIVATE_UPLOADS_DIR`
  defaulted to `private-uploads/` in the working directory: under the reference
  unit, the read-only release (every upload failed); in Docker, outside the data
  volume (lost on rebuild). It now defaults to beside the database, and the unit,
  image, compose file and `.env.example` all set it. An install with files at the
  old location keeps using it and logs how to move them.
- **docker-compose published the app on every interface** while advising
  `TRUST_PROXY=1`, which let anyone reaching the port forge their client IP. It
  binds to 127.0.0.1 now. The file was also not valid YAML (an unquoted
  `${AUTH_SECRET:?… with: …}` contains `: `), so `docker compose up` refused it
  before starting anything; the value is quoted now.
- **Graceful shutdown.** Nothing handled SIGTERM, so every restart dropped
  in-flight requests (a checkout mid-write) and up to a minute of buffered view
  counts. Now: `/readyz` answers 503, the scheduler stops, in-flight requests
  finish (bounded by `SHUTDOWN_TIMEOUT_MS`, default 25 s), views are written, the
  process exits 0; a second signal exits at once. Opt out with
  `GRACEFUL_SHUTDOWN=0`.
- **/healthz read every post on every probe** — and, on lowdb, rewrote the whole
  database through `init()` — and published the post count. It now does one
  cached schema-version read at most every two seconds; `posts` is always
  `null`. **/readyz echoed storage error messages** (paths, hosts) to anyone; the
  reason goes to the log and the response says `unavailable`.
- **HEALTH_TOKEN**: the code accepted 16+ characters, the docs said 32+. A short
  token still works and the deep check now reports a `health_token` warning; one
  under 16 (silently ignored, as before) is reported too.
- **/metrics** gains `astrobaas_request_duration_seconds` (histogram),
  `astrobaas_rate_limited_total`, `astrobaas_inflight_requests` and
  `astrobaas_draining`. Nothing was removed or renamed.
- **nginx reference**: edge rejections answer 429 (was nginx's default 503);
  gzip; slow-client timeouts; an upstream with keep-alive; proxy headers set
  once at server level (a location that set its own silently dropped the rest);
  TLS 1.2+ with `server_tokens off`; the backup restore, WordPress import and
  `/healthz` rate limited by a new `astrobaas_rare` zone; `/readyz` loopback
  only; commented CDN real-IP and admin IP-restriction blocks.
- **Caddy reference**: `/metrics` and `/readyz` refused to anyone but loopback, a
  maintenance page on 502/504 served as 503, the rate-limit gap stated (core
  Caddy has none; `mholt/caddy-ratelimit` named, with an example), and
  `trusted_proxies` guidance including the `X-Forwarded-For` fix a CDN needs.
- **systemd reference**: `LimitNOFILE`, `TimeoutStopSec=30` (above the drain),
  a V8 heap ceiling sized against `MemoryMax`, and `PRIVATE_UPLOADS_DIR`.
- **deploy/README.md** gains a *Hardening* section — Cloudflare real IP and an
  origin firewalled to it, admin restriction, fail2ban/CrowdSec (example filter
  and jails in `deploy/fail2ban/`), off-box backups, uptime monitoring — which
  the parity roadmap had claimed existed.
- **MAINTENANCE.md**'s nginx snippet served the holding page as **200** (its
  `return 503` came after `rewrite … break`, which stops it running) and
  intercepted the app's own 503s. It now matches the reference vhost.
### The change feed is bounded, paged and pruned — on every driver

`GET /api/content/changes` is anonymous and public: the headless storefronts
poll it to learn what to revalidate. It read the WHOLE feed on every request
and filtered afterwards. On lowdb and the libSQL doc-blob that was bounded by
accident, by the 1,000-entry ring. The relational driver had no ring: it never
deleted a row, and every product and order save wrote a full snapshot. So on
the driver recommended for production, one anonymous request was a read of
every save the shop had ever made, every snapshot parsed into memory — on a
600K-product catalogue, a memory exhaustion anybody could trigger — and the
table grew on every edit, forever. The admin dashboard loaded the same whole
feed to render six rows.

Three bounds now, defined once in `src/core/change-feed.ts` so the drivers
cannot disagree:

- **Retention.** 1,000 entries on every driver. The relational driver prunes on
  every write (in the same batch as the insert: one round trip, one
  transaction; never more than 200 rows of a backlog per write), and prunes an
  existing table in the BACKGROUND after the first boot of this version — the
  instance serves meanwhile, instead of freezing until a backlog of millions of
  rows is gone. The `(ts, id)` index is built after that prune, over at most
  1,000 rows. The document drivers also trim an oversized document at boot,
  instead of waiting for the next write.
- **A hard limit per read**, because retention is not one: an install that has
  not pruned yet, or a restored backup, can hold more. Even the old
  whole-window `getContentChanges()` now carries it.
- **Keyset paging** on `(timestamp, id)`. The id is the tie-break: a bulk
  import writes hundreds of changes in one millisecond, and without it two reads
  could order a tie differently and a cursor could skip or repeat an entry. The
  relational `(ts)` index became `(ts, id)`, which serves the page, the cursor
  range and the prune.

**Nothing an existing client does changes.** The default page is the whole
retention window, so a storefront that never heard of paging receives exactly
what the document drivers always gave it; `limit`, `has_more`, `next_cursor`
and per-entry `fields` are additive. Omitting `since` is still the newest page,
never a 400. The public-visibility rules are the same two rules, unchanged —
the commerce switch and `contentTypeIsPublic` — but applied INSIDE the read
now, so a page is full of rows the caller may see, and `has_more` is not a
count of somebody's hidden form submissions.

**`meta.truncated` says when a window was cut short.** Retention counts every
type and an anonymous poller is shown only some, so the advice "a walk that
returned 1,000 may have overflowed" could never fire for it: a full window hands
it 700 on the test fixture, and none at all when a public form is what filled
it. Every driver now records, per entity type, the newest change retention
evicted — the document drivers in the document, the relational driver in a new
`content_changes_pruned` table, in the transaction that deletes — and the route
reports `truncated` when an eviction of a type the caller is shown falls inside
its window. Per type on purpose: one global mark would let anyone binary-search
`since` for the volume of staff-only writes. The paging contract no longer
promises "no gaps" during a walk (retention keeps evicting the old end while you
walk; `truncated` on the last page reports it), and the Next.js example no
longer moves `since` past pages it failed to read. A `since` with no zone
designator is read as UTC, not as the server's local time.

**Lock contention on a shared file database.** A statement that failed with
`SQLITE_BUSY` could leave its connection holding a lock, and the next save on it
was silently lost; the failure paths now drop the connections. A failed boot is
retried by the next call instead of failing every call until a restart, and a
database already at the cap no longer asks for the write lock at boot at all.
(The 5 s busy timeout itself is the SQLite-settings entry below.)

Public callers get metadata and, for updates, the changed field NAMES — never
for users. Order events are not public at all any more: even stripped to an id
and a timestamp they told anyone who polled the shop's order volume, sale by
sale, and no storefront renders anything from an order. Staff still see them.
On the relational driver the snapshot column is not even selected for public
callers.

The GDPR export counts feed entries in SQL now, by the same rule the erasure
deletes by, instead of loading every retained snapshot to count a handful.
`tests/change-feed.test.mjs` drives the real route and the storage layer on all
three drivers, seeded with a history larger than the cap and full of equal
timestamps.

### Public reads are bounded, cacheable, and cannot be used to mail strangers (S5)

Ten ways one anonymous request did far more work than it looked like, or made
the shop send mail nobody asked for. Each fix keeps the existing response shape.

**Search is bounded (S5.1).** Every ranked search — `/api/search?q=`,
`/api/products?search=`, `/blog?q=` — reads the first 200 characters of the
query and at most 12 distinct words. Ranking costs `words × fields × items`, so
a query of thousands of words was thousands of passes over the catalogue from
one GET. The caps live in `lib/search/rank.ts`, the one scorer every caller
uses, so no caller can forget them. A repeated word now counts once:
`ray ray ray` used to add its score three times. `/api/search` echoes the
clipped query in `meta.q`.

**Lists without `limit` stop at 1000 rows (S5.2).** `GET /api/posts` and
`GET /api/content/{type}` rendered the whole collection when no limit was sent.
The ceiling is 1000 — above either live shop — so their responses are
unchanged; past it `meta.hasMore` is `true` and `?offset=1000` continues. An
explicit `limit` keeps its 200 cap. See UPGRADE U-17.

**Byte ranges are streamed (S5.3).** `/uploads/**` read the whole file before
looking at `Range`, so Safari's two-byte probe of a 400 MB video allocated
400 MB. The route now opens the file once and streams exactly the range (or the
whole file) with a stated `Content-Length`; HEAD opens nothing. ETag,
Last-Modified, 206/416 and suffix ranges are unchanged.

**OG cards are rendered once per picture (S5.4).** `/og/{slug}.png` ran sharp on
every request, and a query string defeated every cache in front of it. Cards
are now kept in a bounded in-memory LRU (100 entries, 32 MB) keyed by the slug
and a digest of the SVG — so an edit to the title, the author's name, the site
title or the theme renders a new card, and nothing else does. Concurrent
requests for an uncached card share one render. Cards carry an ETag. A DRAFT's
card, which only its author can see, is now `private, no-store`: it used to go
out `public, max-age=86400`, which let a CDN hand the draft's title to the next
visitor.

**Shared-cache headers for anonymous reads (S5.5).** `/api/products`,
`/api/products/{ref}`, `/api/brands`, `/api/product-categories`, `/api/search`,
`/sitemap.xml` and `/rss.xml` sent no caching headers at all. Anonymous callers
now get `public, max-age=0, s-maxage=30, stale-while-revalidate=300`,
`Vary: Cookie, Authorization` and a weak ETag (with `304` on a match); a signed-in
or keyed caller gets `private, no-store`. `PUBLIC_API_CACHE_SECONDS` (default 30,
`0` = off) and `PUBLIC_API_CACHE_SWR_SECONDS` (default 300) tune it. One helper,
`lib/http-cache.ts`. A CDN will mostly pass these through until the CSRF cookie
stops being set on cookieless API GETs (S3.13).

**One newsletter confirmation per address per day (S5.6).** `POST
/api/newsletter` sent a confirmation on every call, to any address, from any
number of IPs. The second signup of the day answers the same `201` and sends
nothing. The address is counted case-, `+tag`- and (at Gmail) dot-insensitively,
and only an HMAC of it reaches the rate-limit store.

**Notify-me has its own bucket and a per-address limit; restocks are batched
(S5.7).** The form shared the newsletter's per-IP bucket, so either could close
the other; it now has its own, plus at most ten signups per address per day
(silently ignored past that). The restock sweep sends at most
`stock_waitlist_batch_size` (default 50, env `STOCK_WAITLIST_BATCH_SIZE`)
notices per tick, oldest request first, and the rest wait for the next tick. A
row is only mailed when deleting it actually removed it, so a storage error no
longer turns into the same notice every minute, and a row someone else already
took is not mailed twice. Double opt-in for the waitlist was not added.

**Form uploads have a quota and are cleaned up (S5.8).** An upload not named by
any submission is deleted after `form_upload_orphan_hours` (default 24) by an
hourly sweep on the scheduler (first run an hour after boot, once plugin forms
are registered). Each form's uploads are capped at
`form_upload_quota_mb` (default 1024, `0` = no quota); past it the upload answers
`413` with `error.reason: "forms.upload_quota_exceeded"`. The sweep is
deliberately conservative: it looks for the file id anywhere in the stored
records of the form it came through (and of every registered form with a file
field), keeps anything younger than the grace period, keeps files uploaded
before forms were recorded, and deletes nothing if the lookup fails.

**The AI assistant has a daily spend ceiling (S5.9).** `assistant_daily_message_cap`
(default 500 a day, site-wide) and `assistant_daily_ip_cap` (default 50 a day per
IP). Past either, the chat answers `429` with a `Retry-After` and the provider
is not called. `0` switches a ceiling off.

**Recovery matching is bounded (S5.10).** `/api/recovery/match?path=` reads at
most 1024 characters of a path and at most 12 meaningful words, without ever
cutting a percent-encoded Greek letter in half.

Tests: `tests/http-cache`, `list-paging`, `uploads-range`, `og-cache`,
`email-abuse`, `form-uploads`, `assistant-budget` (new), and additions to
`search-rank` and `legacy-urls`. The storage-touching ones run on all three
drivers. New smoke assertions cover the headers, the 304s, the OG query
variant, the newsletter repeat, HEAD on a video and the two query caps.

### Request limits and sign-in hardening (S3.1–S3.14)

Fourteen findings from the public-surface review, fixed together because most
of them meet in the middleware. Upgrade notes: UPGRADE.md U-16.

- **The memory rate-limit store no longer forgets everything at 50,000 keys.**
  It cleared both maps wholesale, which reset every login throttle and
  re-opened every spent magic link and captcha proof for anyone who could mint
  enough keys. It now evicts expired entries, then the live ones closest to
  expiring. (S3.1)
- **The libSQL `rate_limits` table is swept for every key**, at most once a
  minute, via a new `expires_at` column added in place. The old cleanup only
  touched the key just hit, so the table grew with every caller ever seen.
  (S3.2)
- **IPv6 is limited per /64** and IPv4-mapped addresses are unwrapped, in
  `locals.ip` itself so every per-IP budget downstream groups the same way.
  (S3.3)
- **Checkout, quote, payment start and search have their own per-address
  budgets** (10/30/10/30 per minute, env-tunable). **Payment webhooks** leave
  the anonymous bucket for a generous one of their own. `RateLimit-*` now names
  whichever budget is closest to refusing. (S3.4)
- **Maintenance mode no longer holds payment webhooks.** (S3.5)
- **Trusted client-IP forwarding** for a storefront server: an API key an admin
  marks `forward_client_ip` may name the shopper in `X-AstroBaaS-Client-IP`,
  which then drives the per-address budgets, order risk and the audit trail.
  New `PATCH /api/keys/{id}` to switch it on an existing key. (S3.6)
- **Chunked `/api` writes are refused with 411.** The body ceiling is read from
  `Content-Length`, so a body without one used to be buffered unmeasured.
  (S3.7)
- **PBKDF2 runs on the thread pool.** Same parameters, same bytes; a login
  burst no longer stalls the process. Every caller awaits it, including the
  timing-equaliser, and a test fails the build if one does not. (S3.8)
- **Credential stuffing is limited per address; account guessing forces
  proof-of-work instead of locking the owner out.** The admin sign-in page
  solves the challenge in the background; JSON clients get `POW_REQUIRED`
  with a challenge. (S3.9)
- **The two-factor step is throttled per account** on both paths. (S3.10)
- **Signing out revokes the token.** Per-token ids, remembered on the account
  until expiry; pre-upgrade tokens fall back to signing out everywhere. (S3.11)
- **The API-key scope error lists every resource**, built from the same list
  as the validator. (S3.12)
- **The CSRF cookie is set only on HTML pages** (and on a JSON sign-in), so
  anonymous API responses are cacheable. (S3.13)
- **`CORS_ORIGINS=*` is reported** at startup and by the deep health check,
  and INTEGRATION.md says what `Origin` does and does not protect. (S3.14)

### Two status changes at once no longer hand an order's stock back twice

**The oversell, reproduced before it was fixed.** `setOrderStatus` read the
order, released or re-took its stock according to the status it read, and wrote
the new status last. Its comment said guarding on the previous status made
re-cancelling idempotent, which held for two requests in a row and not for two
at once: both read `processing`, both released. An admin double-clicking the
status select, an admin cancel meeting the provider's refund webhook, one
failure event delivered twice, the abandoned-order sweep reaching an order staff
were cancelling — each credited the order's units twice, and the shop sold
stock it did not have. lowdb's `locked()` covers each storage call, not the
sequence, so all three drivers had it. `tests/order-status-race.test.mjs` runs
the callers concurrently, forces the interleavings at the storage boundary on
every driver and at the SQL statement on relational, and on the code as shipped
two cancels of a 2-unit order credited 4, two reopens took 6, and a cancel
racing a refund answered 200 to both.

**Now.** The status move is a compare-and-set:
`Storage.transitionOrderStatus(id, from, to)` — one conditional
`UPDATE … WHERE json_extract(data, '$.status') = ? RETURNING data` on relational,
one `locked()` hold on lowdb and doc-blob — and only the request it returns an
order to moves stock or records the change (plugin action, `order.status_changed`
webhook, audit entry, change-feed entry). Entering cancelled/refunded claims
first and releases after; leaving them reserves first and claims after, so the
status never says an order holds stock it has not retaken. The loser re-reads
and answers what a second request in sequence answers: 200 with the order for a
repeat, the state machine's 409 for a contradiction — never a 500, never a
second stock movement. Response bodies are unchanged.

**The sweep and payment events decide on the order as it is now.** Both act on
an order they read earlier. `setOrderStatus` takes an optional `when` check,
asked on every fresh read, with the payment status pinned in the claim. The
sweep no longer cancels (and releases the stock of) an order paid after it read
its list, and no longer records a staff cancel as an abandonment; a payment
failure no longer cancels an order whose success landed a moment before it.

**API:** `Storage` gains `transitionOrderStatus` (and `OrderTransitionGuard`) —
an addition to the `@alpha` contract that a third-party driver must implement.
`setOrderStatus` gains an optional fourth argument. HTTP responses are
unchanged. One case is narrowed rather than closed: of two concurrent reopens of
an order whose stock covers only one, the loser used to be refused with the
"insufficient stock" 409 every time; it now answers 200 unless its reservation
fails while the winner is still between reserving and claiming.

### The WooCommerce importer keeps brand names, in every script

`npm run import:woo` put each product's brand and each brand record's slug
through a slugifier that keeps only `[a-z0-9]` and does not transliterate. So a
Greek, Cyrillic or CJK brand became nothing: its products were imported with
**no brand** and its record was skipped. A Latin name lost letters on the
product itself — `Ørgreen` was stored as `rgreen`, `Straße` as `stra-e`. And a
WordPress term slug, which WordPress keeps percent-encoded for non-Latin names,
was published as hex (`ce-b3-cf-85-…`). Both live shops write Greek.

Products now keep the brand as the shop spells it, and a brand record gets its
slug from the same transliterating `slugify` the admin uses (`Όψη Οπτικά` →
`opsi-optika`), after the WordPress slug is decoded; a slug that will not
decode is ignored in favour of the name. Two spellings of one maker in a dump
plan one record, and the others are reported. Two makers that now slugify
alike (`Straße`, `Strasse`) both get a record: the one the slug spells keeps
it, the other takes the same stable suffix the brands listing would give it. A
record is never given a slug that another brand in the dump or in the shop
already answers to.

Shops imported the old way keep working, and re-importing them is safe:

- no second record is made for a brand the shop already has, whatever its old
  slug was (this matched on the exact slug alone);
- products an earlier run imported are left as they are, except that a brand
  the earlier run **dropped** — its name had no Latin letter or digit — is
  given back, by name. The CLI reports how many;
- a new product of a brand the shop keeps under an old lossy slug is stored
  under that slug, so the brand stays one entry in `GET /api/brands` and its
  published slug does not move. Rewriting the old products would have changed
  the key storefront links and collection rules resolve to.

`tests/woo-plan.test.mjs` and `tests/woo-apply.test.mjs` (all three drivers)
cover a fresh shop, a shop filled by the old importer (as it actually wrote
it), its re-import, and a shop where the old slug and the name both occur.

### A product save no longer hands back stock that checkout sold, the admin editor's included — and SQLite waits for a second writer

**The oversell, reproduced before it was fixed.** On the relational driver
`updateProduct` read the product row, merged the patch in JavaScript and wrote
the whole row back. Checkout reserves stock with its own atomic conditional
UPDATE on that same row, so a reservation landing between the save's read and
its write was overwritten by the stale copy: the unit went back on sale while it
sat in an order. An admin editing a description, an ERP pushing a price and the
scheduler opening a sale are all `updateProduct`. `tests/stock-race.test.mjs`
forces the interleaving — the reservation runs at the instant the save issues
its write — and on the code as shipped a simple product ended at stock 5 instead
of 4, a variant saved through `saveProduct` (the PUT path) at 3 instead of 2,
and the last unit sold mid-save came back as `stock: 1, in_stock: true`.

`updateProduct`, `updateOrder` and `updateCustomer` now apply the patch in ONE
statement — `json_set` for each supplied key, `json_remove` for one supplied as
`undefined`, `RETURNING data` — so a field the caller did not send is never
written, and so never written back stale. The semantics are the old shallow
merge minus the window. The same mechanism was losing whole fields on orders (a
payment webhook marking an order paid while staff added a note: one of the two
vanished) and customers; both are reproduced and fixed.

**The admin editor's save, on every driver.** Writing only the keys a patch
carries does not help when the patch carries the counts — and the admin product
editor sends `stock` and the whole `variants` array on every save, at the
numbers it loaded when its dialog opened. Open it at stock 5 and Black 3, sell
one of each, fix a typo, save: 5 and 3, on lowdb, doc-blob and relational alike,
in a window as long as the dialog stays open. The editor now also sends what it
loaded, as `stock_base` beside `stock` and on each variant. A count equal to its
base is one the operator left alone, and is taken from the stored row at write
time: inside the UPDATE on relational, inside the `locked()` hold on lowdb and
doc-blob (`UpdateProductOptions.keepVariantStock`). A count that differs is the
operator recounting, and is written as typed. **API:** `PUT /api/products/{id}`
accepts an optional `stock_base`, top level and per variant; nothing stores it,
and a client that sends none — an ERP pushing absolute counts — is saved exactly
as before.

**The variant index (ABA).** A variant reservation located the variant by array
index and guarded the write only on "the count at that index is unchanged".
Reorder two colours that both have 2 left and the wrong colour was sold; delete
one and its neighbour paid for it; a cancellation credited the wrong one. The
write is now guarded on the variant's id at that index, and the count is
decremented in SQL behind a `>= qty` guard like a simple product's — so two
checkouts of the same colour no longer collide, where the old compare-exact
guard lost each collision and, after ten, refused a buyer as out of stock with
units on the shelf.

**Smaller, found on the way.** `saveProduct` no longer rewrites `in_stock` from
the copy it read when the save does not change the count (it still corrects a
stored flag that disagrees with the stored count). And the relational
`releaseStock` derives `in_stock` from the new count, as lowdb always did,
instead of setting a flat `true` for a backordered product still below zero.

**SQLite settings, on every connection.** Nothing set a PRAGMA, so a `file:`
database ran with `journal_mode=delete`, `busy_timeout=0`, `synchronous=FULL`:
a second process (an ERP sync, `npm run import:woo`, a replica) failed with
`SQLITE_BUSY` in zero milliseconds, and a long reader could fail a writer's
COMMIT. Every opener — the relational driver, the doc-blob driver and the shared
rate-limit store, which on a busy lock silently stopped limiting — now goes
through `src/lib/storage/local-sqlite.ts`: WAL (persistent, set once), a 5 s busy
timeout through the client's own `timeout` option, and `synchronous=NORMAL`.
A PRAGMA run once would not have held: @libsql/client keeps a pool and opens a
fresh connection whenever every existing one is borrowed (measured: four
parallel reads after `PRAGMA synchronous=NORMAL` returned 1, 2, 2, 2). The
option reaches every connection, and the pool is held to one connection so the
per-connection PRAGMA covers every statement — which costs nothing, because
every statement already ran synchronously on the one JS thread. Remote
`libsql://` URLs are configured exactly as before.

**On the doc-blob driver the timeout makes a second writer quiet, not safe.**
Doc-blob keeps the whole site in one row and every write replaces it, so two
writer processes silently overwrite each other — and the lock error that used to
make that collision loud is gone. STORAGE.md now says so beside the settings,
and `npm run import:woo -- <dir> --apply` refuses a doc-blob `DATABASE_URL`
unless given `--site-stopped`. The relational driver is unaffected: each of its
writes is one statement on one row.

**Backups under WAL.** The newest commits now live in the `-wal` file. The
backup read the main file and then the `-wal` in two reads, so a checkpoint
between them lost the newest commits from both — the new test forces that
checkpoint and shows the write made just before the backup surviving the round
trip only with the fix. Backups are a `VACUUM INTO` snapshot: one consistent,
self-contained file. The restore folds an older archive's `-wal` into the
restored file instead of writing it back beside it (the previous process deletes
`-wal` by name when it closes its last connection), runs `PRAGMA quick_check`
so a truncated archive is refused before it replaces a working database, and
resolves the file from `DATABASE_URL` with the same function as the writer. A
`DATABASE_URL` naming a missing file now fails the backup instead of creating
and archiving an empty database. **If you copy the database yourself, use
`VACUUM INTO` or `sqlite3 .backup`, never `cp` of the `.db` file alone.**

**A backup that cannot fit is refused before it is copied, and not retried
every minute.** The archive is one JSON string, which V8 caps near 512 MiB. A
database past that budget used to be found out only after a full `VACUUM INTO`
— synchronous on the JS thread, about a second of frozen requests per 200 MB —
and then again on every 60-second scheduler tick. The snapshot now measures the
live data from the page count first and refuses without copying (and refuses
when the disk has no room for the copy). The base64 is built inside the size
guard, which now also recognises Node's `ERR_STRING_TOO_LONG` — a plain Error,
not the RangeError it tested for. A build that throws is recorded as the run's
outcome instead of escaping it. And a failure to BUILD waits `min(everyHours,
1 h)` for the next attempt, while a refused upload is still retried on the next
tick (`BackupOutcome.transient`, additive).

**After a restore, the running site moves onto the restored file.** The restore
renames the restored file over the database, and every client the site held
kept the previous file's inode. In rollback-journal mode their next write failed
loudly; under WAL it succeeded, into a log nothing reads again — a checkout
taken between the restore and the restart it asks for was confirmed and then
gone. The storage driver, the doc-blob adapter and the rate-limit store now
register their clients, and the restore closes them before the rename and
reopens them on the restored file after it (`swapLocalSqliteFile`).
`restartRequired` stays true, for other processes and the in-memory caches.

**An interrupted backup no longer leaves a database copy behind.** A snapshot
or a restore killed part-way left its database-sized staging file beside the
live one, one per interruption, forever. Opening a database now removes such
leftovers when the process that wrote them is gone, and nothing else.

`tests/rate-limit.test.mjs` moved to the shared loader — it transpiled without
bundling and could not load a module with a relative import — and so leaves the
grandfathered list. Section 5 of `tests/offsite-backup.test.mjs` asserted that a
fake `-wal` was copied beside the file; it now runs against a real WAL database
and asserts the snapshot holds the commit that was only in the log.

`tests/stock-race.test.mjs` runs the admin editor's save (D6–D8) through the
real PUT route on all three drivers. Its concurrent storm now yields between
statements on the relational driver — without that it stayed green with the old
read-then-write `updateProduct` put back — and on lowdb and doc-blob it is
labelled for what it is there, an arithmetic guard serialised by `locked()`.
`tests/sqlite-concurrency.test.mjs` runs the backup-and-restore round trip on the
relational and doc-blob drivers, writes after the restore, and covers the
leftover sweep and the importer's doc-blob guard. The smoke suite's save race
PUTs back the editor's whole body with `stock_base` instead of a description
patch.

### The staff rate limit is 1800/min, not 600

600 was still sized like a limit on traffic rather than a backstop on a runaway
script. A catalogue screen is not one request: opening the products list, paging
through it, opening a product, going back and refreshing is hundreds of calls,
and the media picker adds one per thumbnail. A staff member doing nothing
unusual could reach 600 inside a minute and be told, with no explanation, that
they were making too many requests.

The bucket is keyed on `user:<id>`, so the only thing on the other side of it is
somebody already holding a session you issued and can revoke. It was never a
defence against crawlers or scanners — those are anonymous and stay at
`RATE_LIMIT_PER_MIN`, 60/min per IP, unchanged. A limit that fires during normal
work teaches people to distrust the alert, which costs more than the runaway
request it was meant to catch. Thirty requests a second sustained for a minute
is still far beyond anything a person produces.

Nothing had pinned the shipped value: `tests/rate-limit.test.mjs` used a local
`const STAFF = 600`, which proves the STORE works and says nothing about what
the product ships — so the default could have drifted in either direction
silently. The test now reads both defaults out of `src/middleware.ts` with
comments stripped, and asserts specifically that the ANONYMOUS ceiling was not
raised along with the staff one.


### The last open row: a receipt that does not pretend to be an invoice (C-39)

C-39 was the only in-scope row still open, and it was open for a decision rather
than for work. The decision: ship a **non-fiscal printable receipt** in core, and
leave anything claiming fiscal status in the commercial track. That closes the
board at **153 of 153 in scope**.

The distinction is the whole feature. In Greece a retail invoice is not a document
you generate — it is a document the tax authority issues you a MARK for, through
myDATA. A PDF that looks like an invoice and was never transmitted is a liability
with a logo on it. So the page says what it is, in the buyer's own language, in all
three shipped languages, and never numbers itself as anything fiscal. No headless
Chromium either: the print stylesheet already ships, and the reader's own browser
makes the PDF with the reader's own paper size — the same answer C-152 reached.

Three things about it were not obvious going in:

**The buyer is authorised by a signed token, not by an order number and an email in
a query string.** Those are personal data, and a URL is the one part of a request
that lands in an access log, a proxy, a `Referer` header and a browser history. The
token names one order, lives two years — a receipt that expires before the EU
conformity window is not a receipt — and travels only in the confirmation email. It
is its own signing purpose, so no other link in that inbox can be replayed as one.

**An erased order is refused, however valid the token.** The token was signed before
the erasure and nothing revokes it. A bad token, an unknown order and an erased one
all return byte-identical 404s, so the page is not the order-number oracle that
`order-lookup.ts` exists to prevent. The unit test proves the predicate refuses; the
smoke test creates an order, opens its receipt, erases the subject and re-opens the
SAME link expecting a 404 — because only that proves the page actually asks.

**There is no VAT-analysis-by-rate table, and that is a finding rather than a
shortcut.** It is the obvious thing to want and the data looks present: `line_totals`
carries `tax_rate_bp` and `tax_cents` per line. It is not. `tax_cents` on the order is
`goods tax + shipping tax`, and `shipping_tax_cents` is never persisted. A per-rate
table would therefore fail to add up to the VAT total printed beneath it on every
order with taxed shipping, and a document whose own numbers disagree is worse than
one that says less. Per-line rate is shown instead, with a single reconciling total.

### The bootstrap admin could be silently duplicated

`admin@local` cannot receive mail, so the account that owns an install had nowhere
for a password reset to go. **`ADMIN_EMAIL`** now names it, beside the `ADMIN_NAME`
and `ADMIN_PASSWORD` that already existed. When it is set, `/login` stops prefilling
the address and stops printing the seed-credentials hint — that convenience is only
harmless while the address is an obvious placeholder; printing a real one on a
public, unauthenticated page hands a scanner half of a valid login.

Fixing that surfaced a worse bug underneath it. The first-boot check asked *"is there
a user called `admin@local`?"* rather than *"does this install have an
administrator?"* — so an operator who **renamed** the seeded account got a brand-new
`admin@local` on the next boot, carrying the published default password and re-using
the seed's fixed id. An install the operator believed they had secured quietly grew a
second door. The check now tests for any administrator. The renaming that makes this
reachable was itself only fixed a commit earlier, so the two ship together.

### A test file could be written, committed, and never run again

`test:unit` is an explicit `&&` chain rather than a glob, deliberately: the order
matters and a glob would swallow a file that crashes on import. The cost of that
choice is a test that passes when run by hand and never runs in CI — which reads as
covered and catches nothing, the same shape as an assertion that cannot fail.
`tests/suite-registration.test.mjs` now fails the gate on any test file no npm script
names. It found exactly one file when it was written: the receipt suite above.

### Every remaining roadmap row, except one

Twenty rows closed in one stretch, and the pattern across them is worth stating
before the list: **an unfinished roadmap note rots faster than a finished one.**
Four of these notes were wrong about the code they described, and in two cases
the note's premise was the reason the feature had not been built.

**Embeds were never going to work the way the note assumed.** It said embeds
worked and only wanted a privacy facade. They did not: `iframe` is not in the
sanitizer's allow-list and `disallowedTagsMode` is `discard`, so a pasted
YouTube embed was destroyed on save — deliberately, and it is much of what
keeps the CSP intact. So nothing stores a frame. A placeholder carries a
provider id and a video id, the sanitizer validates the id against that
provider's own shape, and the URL is built from the pair at render and again in
the browser. The worst an attacker with write access to post HTML can express
is a different YouTube video. The facade makes no third-party request before a
click — not even a thumbnail, because a YouTube poster is served by Google and
fetching one tells them who is reading the article.

**Right-to-left did not exist at all.** The note called it a theme-token
concern. The theme tokens are FLEX directions, and there was no `dir` attribute
anywhere in the codebase — so an Arabic install rendered left-to-right and
nothing an operator could touch would change it. `dir` now derives from the
reader's locale, and a generator reads the physical Tailwind utilities the
source actually uses and fails the gate on any the stylesheet does not flip. It
found six missing the first time it ran, including three variant-prefixed ones
a bare selector could never have matched.

**"Webhooks cover 80% of ESP sync" covered none of it.** There was no
subscriber event of any kind. There are two now, and which two is the design:
`subscriber.confirmed` fires on the double-opt-in click and only the first
time, there is deliberately no event for an unconfirmed signup — an ESP
receiving that is importing an address nobody consented with — and
`subscriber.unsubscribed` is the one that must fire, because an unsubscribe
this site honours and Mailchimp does not ends in a spam complaint.

**"REST covers export" is true of a developer with a bearer token** and false
of an operator with four hundred products and a spreadsheet. One route now
handles `post`, `page` and every content type; it previews before it writes,
matches rows on slug or id rather than position, defuses formula cells so
opening your own export in Excel is not an attack surface, and carries a BOM
without which every Greek title becomes mojibake.

The rest, briefly. **A writing assistant and draft translation** as six tasks
in one module, authenticated and capability-gated because every call spends the
operator's own credit, and never writing — the answer lands in a read-only box
and a person presses apply, which is the only thing that makes offering a
machine translation safe. **Editable email wording** where each template
declares the placeholders it cannot do without, so a password reset that would
send, look fine and be useless is refused with the reason. **Opt-in popups** as
a plugin, frequency-capped, remembering a signup so nobody is asked twice, and
waiting for a consent decision so it cannot stack on the cookie banner.
**Upload virus scanning** that fails closed and runs at both upload doors —
including a stranger's file on a public form, which matters more than the admin
upload rather than less. **A deploy integrity manifest** whose limitation is
printed by the command itself rather than glossed. **Per-request timings** with
per-path totals, because ninety 200 ms requests is the thing to fix and it is
invisible in a list sorted by duration. **User switching**, admin only, never
onto another admin, audited at both ends — and what is not claimed is written
down: actions taken while switched are audited as the impersonated user.
**Themes from npm and child themes**, where an omitted slot inherits rather
than erases and a missing parent renders the child with a badge rather than a
blank page. **Custom taxonomies**, additive and destructive of nothing:
removing one rewrites no records, the assignment simply stops being read.

Four of my own guards caught four of my own mistakes during this stretch — a
second strip-tags implementation, a smoke assertion that used the admin session
to "prove" an anonymous caller was refused, a capability check that passed with
the gate deleted because it matched the other handler's, and a BOM assertion
made through `fetch().text()`, which strips a leading BOM by specification and
so could never have failed. Two more were caught only by mutation testing. They
are listed here because a test suite that has never rejected its author's work
has not been tested either.

### Marketing modules, named as commercial

Four rows added to the commercial track rather than the core: a newsletter
studio, campaign landing pages with UTM capture, affiliate marketing, and
self-hosted analytics heatmaps. The heatmap row carries a hard constraint —
first-party capture on the operator's own infrastructure, no Clarity, no
Hotjar, no third-party recorder. Those ship a recording of a shop's customers
to somebody else, which contradicts every line of the consent work in this
core. If it cannot be built without a third-party service, it does not ship.


### Missing images

Beside the broken-link report, and answering the same kind of question one level
down: a picture in a published article that the media library cannot account for.
Usually a file somebody deleted after it had been used — and nothing logs that,
because serving a 404 for a file is not an error. The request was answered.

Resolved against the library, never fetched. Scoped to `/uploads/`, so an image
shipped with your theme is not in the library and is not reported as missing: a
report with entries in it that are fine is one you learn to close. A missing
FEATURED image is called out separately, because it is visible in four places
you never open — the archive, the card, the Open Graph tag and the feed.

The other direction is offered too, folded away: files no published post links
to. It reads post content, so it cannot see a file used from a settings value or
a theme, and it says “nothing links to these” rather than “safe to delete”.

### The six large ones — and three of them were repairs

**The command line you install did not work.** `astrobaas plugin new` and
`astrobaas theme new` — the two commands a new user runs first — failed from an
installed package, because one file they need was never in the published
tarball. Every test ran from a source checkout, where that file exists, so
nothing could catch it. The tests now pack the real package and run against it.

**Two setup tools wrote to a file nothing reads.** `npm run setup` and the
password reset wrote a `db.json` beside the code — ignoring the path a
containerised install configures, and ignoring entirely that a libSQL install
has no such file. On those, creating an admin account printed success and the
account went nowhere. They now refuse and say which setting stopped them.

**Backups could not be downloaded on the drivers people actually run.** The
download button read the JSON file directly and refused whenever a real database
was configured. Meanwhile the RESTORE side already understood the archive the
scheduled off-site backup was writing on those very installs — one half could
read a format the other could not write. One builder now, and a libSQL install
downloads and restores its own archive. There is also a "back up now" button,
which runs the same job the schedule runs, and `astrobaas clone` to copy a whole
site between servers.

**Comments and product reviews** arrive as ordinary collections, off by default,
each held for approval before anyone else sees it. A review by somebody who
actually paid for that product is marked as a verified purchase — set by the
server, never sendable by the reviewer — and a product's star rating is
published to search engines only when there are real reviews behind it.

**What each role may do** is now editable, for the five roles that exist.
Admin is fixed: an admin who switched off their own last permission would be
locked out of the screen that restores it. New role *names* are deliberately
not part of this — a name the rest of the app has never heard would silently
mean "no" everywhere, producing a role that can sign in and do nothing.

**Newsletters** can be composed and sent, a batch at a time, resuming after a
restart rather than sending twice. Every message carries the header that makes
mail clients show a one-click unsubscribe — without it, readers reach for the
spam button instead, and that costs the same domain your order confirmations
leave from. It is not a mailing service: there is no bounce handling, and the
screen says so.

### The second marathon — fourteen more, and two big rows that were one small gap

**Comments and product reviews were never two features.** The roadmap
carried each as a large row proposing its own table, its own storage on three
drivers, its own migration, its own GDPR registration and its own screen. What
was actually missing was a single primitive: a collection's read policy is
collection-WIDE, so "public" published every row including one posted thirty
seconds ago by a bot. A type can now hold public submissions for approval, and
one queue serves every type that does.

**Conditional and multi-step forms.** A field can say "only show me when an
earlier field holds this", and a type can be split into steps. The half that
matters is the server one: a hidden required field becomes optional (without it
the form is unsubmittable and complains about a box nobody was shown) and a
hidden field's submitted value is dropped, because a browser is not the only
thing that can post.

**Repeating groups**, one level deep, with an optional choice of named layouts
per item. And the walker for them was written first, because three places read
a type's fields flat — one of them being the sweep that finds a person in a
subject-access request.

**File uploads on public forms, kept private.** A CV or a prescription sent
through a form does not land in the public uploads folder. It goes somewhere no
static handler is told about, is named after its own contents so the link
cannot be guessed, and is readable only by signed-in staff. An erasure request
deletes the file before the record.

**Settings you declare yourself** — fields the product does not have, validated
against the type you chose, and readable by a decoupled storefront when you
mark the group public.

**Tables** keep their caption, their column groups, their footer and their
merged cells. They were losing all of it silently; the caption in particular
reappeared above the table as loose text, which looked like a formatting bug
and was a discarded element.

**Media folders**, which had been half-built for months: the folder you set was
stored and nothing could read it back.

**Your own name in the admin**, on the sidebar and the sign-in screens.

**Printing** works on a fresh install. The good rules were in a plugin that
ships switched off, and the "do not print this" class was applied to nothing —
so the navigation and the footer printed on every article.

**Local spam scoring** on public submissions, with no third-party service and
no word list: every signal is structural, because a list of spam words is a
list in one language. Nothing is ever rejected on the score — it is flagged for
a person, since rejecting on a heuristic loses the one enquiry that mattered
and tells its sender it went through.

### What the audit of all of the above found

Everything in this release was then audited against itself. Twenty-six findings
survived an independent attempt to refute them; all twenty-six are fixed. The
four worth naming here, because each one shipped in a release before this one:

- **The API rendered post bodies without the sanitizer.** `sanitizeHtml` on
  write protects stored content; a `post_content` filter runs on READ and can
  return anything. The SSR pages passed filter output through the sanitizer and
  the two API routes did not — while both carried a comment promising a
  decoupled storefront "exactly the markup this CMS would have served". For an
  install that is headless, those routes are the whole product.

- **New Post saved a one-letter meta title.** The slug generator runs on every
  keystroke, and the rule was "fill the meta title if it is empty" — so it
  filled on the first character and never again. That single letter is what
  `<title>` and `og:title` rendered.

- **Search answered with pages nobody asked it about.** `/api/search` returned
  Pages and `noindex` posts, which `/blog`, the sitemap, the feed and related
  posts all exclude — and it strips `kind` from the response, so a client could
  not filter them out either. The home page listed `noindex` posts too: a post
  an author had hidden was the lead item on the site's most visited page.

- **The EU withdrawal notice ignored its own off switch.** The relational driver
  stores settings as TEXT, so a switched-off notice came back as the string
  `"false"`, which is not `false`. The notice published anyway.

The rest were smaller: a character counter that wiped the layout classes off the
element it counted for, a synonym table whose tail was dropped between the
validator and the parser, an alignment button that threw, a preview that threw
after it had already worked.

### The shared vocabulary — 17 duplications removed

Before adding anything else, four modules that should always have existed:

- **`lib/html-text.ts`** — turning content HTML into text. There were five
  copies of the strip-tags regex and **two of them disagreed**: one replaced a
  tag with nothing, the rest with a space. So `<b>ten</b><b>words</b>` was one
  word to one caller and two to another, and the byline's read time was computed
  from different text than the search excerpt. A tag boundary is a word boundary.

  Its sentence splitter knows Greek punctuation. Greek writes a question mark as
  `;` and a semicolon as `·`, so a Latin-only splitter sees a Greek article as a
  handful of enormous sentences and reports "far too long" on ordinary prose.

- **`lib/settings-map.ts`** — eleven copies in three incompatible spellings. The
  difference is not cosmetic: settings keys are operator-supplied, so a plain
  `{}` inherits `Object.prototype` and `map.constructor` is truthy on every
  install. Half the copies used a null prototype and half did not.

- **`lib/money-format.ts`** — five admin screens hardcoded `el-GR`, and
  disagreed with the sale email (`€89.00` against `89,00 €`). The screen and the
  receipt stated the same total two ways. Currency formatting belongs to the
  reader, not to the shop.

- **`lib/admin-ui.ts`** — seven copies of the notice class-string builder, one of
  which had already drifted. Also the character counters, which disagreed: the
  edit screen turned an over-long meta title red, the create screen did not.

Every call site was swept, and three of those sweeps are now permanent tests. A
helper nobody calls removes no duplication.

### Alt text: a writer, a reader on the page, and an audit

`alt_text` had exactly one writer — the upload ingester, fed from a form field
no interface ever sent — and no reader on any public page. Every row was empty
and the column existed only in the schema.

Now: **PATCH /api/media/update** writes it (refused on a bulk patch, because
describing forty pictures with one sentence makes a screen reader read the same
wrong caption forty times); the render pipeline fills a **missing** alt from the
library; and Insights lists the images an author still has to describe.

An explicitly empty `alt=""` is **never** filled. That is how correct markup
marks a decorative image, and overwriting it makes a screen reader announce a
caption on every spacer — an accessibility regression dressed as a fix.

### Pinned posts and manual ordering

Posts gain `pinned` and `menu_order`. One comparator defines the order
everywhere: pinned first, then manual position with unset sorting **last**, then
date, then id for a total order.

Both fields are absent on every existing row, so the ordering is byte-identical
to what it was until you pin something. That is why it is the default rather
than an opt-in sort a headless storefront would never send.

### The green dot in the editor

A content-analysis panel that re-runs on every keystroke — no endpoint, no round
trip, and it works while the post is still an unsaved draft.

It **refuses two things** Yoast ships. There is no reading-ease score outside
English, because the syllable model has no validated Greek or German port and a
number from an English counter over Greek text is a figure nobody can trace to a
fact. And there is no passive-voice detection, because that needs a curated word
list per language and no Greek one exists here.

A false alarm is the failure that matters: an author told twice that a correct
page is wrong stops reading the panel. So a blank meta title on a page that
renders the post title is not "missing", a post with no keyphrase skips those
checks rather than failing them, and a 120-word note is not told off for having
no subheadings.

### The media picker can finally insert

It has dispatched a selection event since it was written, and the only listeners
set the featured image — so the library was browsable and unusable for the one
thing people open it for.

### Search synonyms

The relevance scorer has always had a seam for alternative spellings and nothing
in the free core filled it: it had exactly one consumer, product search. So a
shop's synonyms worked in the catalogue and not in the blog.

Now **Settings → Reading → Search synonyms** takes a table you maintain.
`σκελετός, μοντούρα, frame` makes all three find each other; `iphone => phone`
is one-way for when direction is genuinely meant.

Typo tolerance and Greeklish stay in the paid module, because both need an index
of your own catalogue — a correction against a dictionary suggests words you do
not stock, so acting on it lands the shopper on an empty page.

### Staging is enforced, not documented

`STAGING=1` forces noindex, silences webhooks, and loads no analytics.

The three switches that make a staging clone safe live in the **database**, so
they arrive with the clone: a fresh copy of a live shop starts out indexable,
pointed at production's webhook endpoints, and reporting into production's
analytics property. A checklist fixes that, and a checklist gets skipped on the
third refresh.

One-way on purpose: it can force a site to hide, and nothing in the environment
can force one to be indexed. See `docs/STAGING.md`.

### robots.txt, editable

Add `Disallow: /search`, block a named AI crawler, or point at a second sitemap.
Your rules are appended to the managed block, so `Disallow: /admin` and the
`Sitemap:` line cannot be deleted by accident — and an `Allow:` still overrides
them, because robots.txt matches by specificity rather than by order.

### Broken links

Internal links are resolved against the database: instant, exact, and incapable
of a false positive. Outbound links are opt-in and checked slowly, one site at a
time — and **only 404 and 410 count as broken**. A site that blocks bots, rate-
limits us or times out is reported as unchecked, because sending you to fix a
working link twice is how a report like this stops being read.


### A cookie declaration that cannot go stale

Every consent product ships a cookie *scanner*: it loads your site in a headless
browser, watches what gets set, and writes a table. That table then drifts. A
scan sees one page load, in one consent state, from one country, on the day it
ran — it misses the marketing tag that only fires at checkout, and it keeps
declaring the vendor you removed last month. A stale legal declaration is worse
than none, because it is a specific, dated claim about what you do with people's
data and it is wrong.

AstroBaaS knows the answer without looking. The first-party cookies are set by
code in this repo, so they are listed beside the constants that define their
lifetimes — change the session TTL and the declaration changes with it. The
third-party ones come from your analytics settings, so switching a tool off
removes its rows on the very next request, with nobody remembering to re-run
anything.

Where a vendor controls its own cookie list, the table says so and links the
vendor's documentation rather than pretending to a completeness it cannot
verify. Tag Manager gets its own sentence: it sets nothing itself, and this CMS
cannot see what you loaded through it. Plausible, Fathom and Umami are listed as
setting no cookies at all — which is the single most useful line a declaration
can contain.

At `/cookies`, in the admin under Data requests, and at
`GET /api/consent/cookies` for decoupled storefronts, which render their own
privacy pages. The caveats travel with the data.

### An insights report that shows only what was recorded

New screen at **Insights**, and it is split in two on purpose.

**Reading is totals and rankings, and the page says so.** `post.views` is a
running counter; nothing anywhere records *when* a view happened. So "this week
versus last" is a question the data cannot answer, and every way of faking it
has a plausible shape — spreading a total across days, charting `publish_date`
and labelling it traffic, dividing 404 hits by their first/last bounds. None of
those are drawn.

**Outcomes are genuine series.** Paid orders, contact submissions and newsletter
signups each carry a per-event timestamp, so the 30-day charts of those are
traceable to recorded facts one row at a time. A day with nothing on it is a real
zero, not a gap. Where a store evicts old rows, the chart says the earliest days
may be short.

The most actionable section is neither: **dead URLs people are paying to reach**
— requests that arrived with an ad or Shopping click parameter and hit a 404,
ordered by cost rather than by volume.

Charts are inline SVG. Not a preference: the CSP has no `'unsafe-inline'` for
styles, so `style="width:62%"` on a div is dropped silently, while `width` on a
`<rect>` is a presentation attribute that survives. The one existing bar in the
admin, on the translations screen, was broken for the neighbouring reason — its
rules lived in a scoped `<style>`, which Astro compiles to an attribute selector
the script-created element never carried — and is fixed here.


### i18n now reaches the visible site, not just the `<head>`

The locale prefix used to be a one-way door. You could reach `/de/blog` by
typing it, and the first link you clicked took you back to English — every nav
item, footer link and post card carried a hardcoded `href`. The sitemap and
hreflang tags were advertising `/de/…` URLs that nothing on the site linked to.

Now every link in the nav, footer, post cards and breadcrumbs carries the
locale, and a **language switcher** renders in the header of all three themes.
It is plain `<a>` markup with no JavaScript, because the whole point is that a
crawler can follow it. Where a translation of what you are reading exists it
links straight to it; where none does it links to that language's home page and
marks the entry, rather than pointing at a URL that would 404.

Not yet converted: the stock marketing home page's own "View Blog" and "Learn
More" buttons.

The **canonical URL now follows the content's language, not the URL's**. A
German post is served at `/blog/<slug>` as readily as at `/de/blog/<slug>` —
the middleware only ever strips a prefix — and the sitemap has always listed it
under the prefixed form. The canonical built from the request path therefore
contradicted the sitemap entry for the same document. Both now derive it the
same way.

The home page respects the locale as well: its article list is filtered, and a
Page designated as the home page resolves to its translation when one exists.

Single-language installs are byte-identical: the switcher renders nothing and
every helper returns its input unchanged.

### Table of contents, and the anchors underneath it

Every `h2`–`h4` **with text** in a post or page now carries a stable anchor
built from that text (`#how-it-works`), so a link to a section keeps working. A
heading made only of an image gets none, because there is nothing to build one
from. An id you wrote
yourself is never renamed. Duplicate headings get distinct anchors, and Greek
headings transliterate rather than producing an empty one.

The anchors are always there. The rendered contents list is optional: set
**Reading → Table of contents** to the number of headings an article needs
before one appears, or 0 (the default) for never. `TableOfContents` is a theme
slot, so a theme can place or replace it.

Setting that up surfaced that **related posts** were being read from a setting
no screen could write — a feature that existed only in the code. Both now have
controls in Reading settings.

### Body images carry their dimensions (CLS)

Image dimensions were recorded at upload and never rendered, so every image in
an article reserved zero height and the text below it jumped when the file
arrived. Body images now carry the file's own `width`/`height`, matched through
absolute URLs, cache-busting queries and generated derivatives.

Theme images are deliberately left alone: they are sized by CSS (`object-cover`),
so an attribute there would set a ratio the stylesheet immediately overrides.
An image you sized yourself is also left alone — pairing your width with the
file's height would distort it.

All of it reaches `content_rendered` on both post API routes — anchors,
dimensions, alt text and the lazy-loading hints — because the two API routes and
the two SSR pages now run one function (`lib/content-render.ts`) rather than
four rememberings of the same four steps. A decoupled storefront gets the body
markup this CMS would have served, byte for byte. The rendered contents *list*
is still a theme slot rather than an API field; the anchors it links to are in
the body, so a storefront can build its own from the same ids.


### Plugin sections can offer variants too

A plugin that contributes an editor section — a pricing table, a testimonial
block — can now declare variants for it, the way the built-in sections have
always been able to. Declare `modifiers: { tone: ['light', 'dark'] }` in the
manifest and the editor shows a dropdown next to the move and duplicate
buttons.

The class it applies belongs to your plugin (`ab-x-yourplugin-tone-dark`), so
your stylesheet can target it and it can never collide with — or borrow the
styling of — anything the CMS or another plugin owns.


### Backups that leave the machine

A backup on the same disk as the site is not a backup. Point the site at any
S3-compatible bucket — Backblaze B2, Cloudflare R2, Wasabi, Hetzner, or MinIO on
a second machine — and it uploads one on its own, every day by default, keeping
the last fourteen.

Four settings in your environment file get you there:
`BACKUP_S3_ENDPOINT`, `BACKUP_S3_BUCKET`, `BACKUP_S3_KEY_ID`,
`BACKUP_S3_SECRET`. The rest have sensible defaults, and `.env.example`
explains each one. Progress, and any failure, appear under
**Admin → Background jobs**.

The credentials go in the environment and nowhere near your settings, on
purpose — the settings table is partly readable without logging in.

Two things it deliberately will not do:

- **Old backups are only removed after a new one has landed**, and never the one
  just written. The day uploads start failing should not be the day your last
  good backup disappears.
- **On a hosted Turso database it refuses**, and says why. There is no local
  file to copy, and uploading a stale `db.json` would give you an archive that
  looks fine and restores an empty site. Use `turso db dump` there.


### See what is still to translate

**Admin → Translations.** One page answering "what is missing in German?" for
your articles and your products at once — they are stored differently, which is
why that question was previously impossible to answer without checking two
places and doing the arithmetic yourself.

Each language gets a bar, a count and the first few titles to start on. An
article you wrote directly in German is not counted as a missing English one.

The section worth reading is **Half translated**: products where the name has
been translated and the description has not. Those look finished everywhere
else, and the page ends up showing English body text under a German heading.

Open to editors and authors, not just administrators — the people who do the
translating are usually the ones who cannot see a backlog they can't open.


### You can finally see what the background jobs are doing

**Admin → Background jobs.** Two questions that used to need someone with
server access:

**"Why hasn't my scheduled post gone live?"** The screen says whether the
scheduler is actually running on this server — which is not the same as being
switched on — how many posts are waiting, how many are past their time, and
what the last sweep did. If a sweep failed, the error is there.

**"Did that email actually get sent?"** A log of what went out: who to, the
subject, which mail service carried it, and whether it worked. Failures say
why.

The log does **not** record the contents of your emails, and that is deliberate:
password-reset links and sign-in links go through the same sender, so a log
holding message bodies would be a list of working credentials that every
administrator could read.

Because the log does hold recipient addresses, it counts as personal data — so
**Data requests** searches it and erases it along with everything else.


### Replace a file without breaking the pages that use it

Media → hover an item → **Replace**. Pick a new file and it takes the old one's
place: the same entry in your library, the same alt text, and every page and
product that used the old picture now shows the new one.

It has to work that way. Uploaded files are cached by browsers for a year, so
writing new content to the same address would leave your visitors seeing the old
picture — and you seeing the new one — for months. The new file gets its own
address and everything that pointed at the old one is updated to match. You are
told how many pages and products were changed.

The old file is deleted, unless another item in your library happens to be the
identical file, in which case it stays.


### Proof that consent was given, without recording who gave it

The law asks you to be able to demonstrate that a visitor consented. The usual
way to do that is to log their IP address and browser with every decision —
which answers a privacy obligation by collecting more personal data, and leaves
you with a table that is itself subject to access and deletion requests.

This does not do that. Every decision is recorded as: which categories, which
version of your consent text, and when — under an opaque id that the visitor's
own browser generated and keeps in their own cookie. There is no address, no
browser fingerprint, and nothing that can be traced back to a person. If
somebody disputes what they agreed to, they can quote their receipt and you can
look it up under **Admin → Data requests → Consent receipts**.


### Google Consent Mode v2

If you use Google Analytics, Ads or Tag Manager, the consent banner now speaks
Google's own protocol — including `ad_user_data` and `ad_personalization`, the
two signals added in March 2024 that a site is non-compliant for EEA ad traffic
without.

**Nothing about when scripts load has changed.** Google's guidance is to load
its tag on every page and let the signals decide what it does. This does not do
that: no third-party script is fetched until a visitor says yes. The signals are
queued locally instead — which sets no cookies and contacts nobody — and the tag
reads the whole history the moment it is allowed to load.


### Answering a data request, in one screen

**Admin → Data requests.** Type an email address and see everything the site
holds about that person: their customer record, every order they placed —
including ones placed as a guest, before they had an account — their contact
messages, their newsletter subscription, and any form submissions. Download it
as a file and send it to them.

Erasure is on the same screen, behind a typed confirmation, and it does the
thing that is easy to get wrong:

- The customer record, messages, newsletter subscription and form submissions
  are **deleted**.
- Orders are **kept and anonymised**. The totals, line items and dates stay, so
  your books still add up; the name, email, phone and address are replaced. A
  shop has to be able to produce its accounts for years, and the right to
  erasure does not override that — but keeping their name on the invoice is not
  erasure either.
- A **staff account** with that address is never removed automatically. You are
  told it exists and you decide.

Both the lookup and the erasure are written to the audit log, so "when did you
action that request?" has an answer that is not somebody's memory.

The screen does not verify identity, and says so. Confirm who you are dealing
with through a channel you trust first — a self-serve delete button that
anybody who knows an address can press is not a compliance feature.


### Fixed: four field types were throwing your data away

If you built a content type with a **Slug**, **Email**, **URL** or **Date**
field, filled it in and saved, the value was accepted, the record saved — and
that field was empty afterwards. The validator had no rule for those four
types, and a field it does not recognise was being dropped without a word.

All four work now, and validate what they claim to: an email needs an @ and a
domain, a URL must be `http` or `https` (a `javascript:` link is refused —
these get rendered), a date must be a day that exists, so 31 February is no
longer quietly stored as 2 March.

**Check any content types you built with those field types**; entries saved
before this release are missing those values, and nothing recorded that they
were lost. Re-entering them is the only way back.

The underlying cause is gone too: a field type the server does not understand
is now an error on that one record instead of a silent hole in all of them.

### Two new field types: links and images

**Link to another type** points one collection at another — an event at its
venue — and a link to something that does not exist is refused rather than
saved and rendered blank. It is checked when you create a record and when you
edit one.

**Image / file** stores the media id, not a URL, so records survive the site
moving domain or a file being replaced. Readers get a resolved `_url` alongside
it, from the list and the single-record endpoint alike.


### Forms, without a plugin

A content type can now say `writable: 'public'`, and that turns it into a form.
Define the fields in **Content types**, and the form is live at
`/forms/<name>` — no theme edit, no JavaScript, no third-party service. The
same `SubmissionForm` component can be dropped anywhere a theme wants it.

Submissions are protected by a honeypot, a per-address limit of 10 in 15
minutes, and — when you switch it on under **Anti-spam check → Public forms** —
the local proof-of-work check that runs entirely on your own server.

**Who can read and who can write are separate settings, and both start closed.**
A form people fill in privately is written by anyone and read by staff, which
is the default pairing the builder nudges you toward. If you set both to
public, the screen says plainly that everyone can read what everyone submits —
right for a guestbook, wrong for a job application.

A submitter gets back the fact that it arrived and nothing else. Fields your
type never declared are dropped rather than stored, and the "submitted at"
stamp is the server's, not theirs.

Tick **Email me when someone submits** to be told, when you have an email
channel configured.


### Leaving WordPress actually works now

`npm run import:wp -- export.xml` reads a WordPress export and tells you what
it would do. Nothing is written until you add `--apply` — same in the admin
(**Import a site**, admin only) and at `POST /api/import/wordpress`, where a
rehearsal is what you get unless you send `dry_run=false`.

It brings across posts, pages, categories, tags, publish dates, and — if you
ask — the media library, through the same pipeline an upload goes through. Old
addresses keep working: every permalink that moved gets a 301 into the existing
redirect engine, so `/2024/03/how-to-choose-a-frame/` still lands somewhere.

**Every item is either imported or listed with a reason.** "23 posts are
missing" should never be something you discover weeks later with no evidence.

**Running it twice is safe.** Each record remembers the WordPress id it came
from, so an interrupted import can simply be run again — including after you
have renamed things.

Two decisions worth knowing about:

- WordPress `private` posts arrive as **drafts**, not published. There it means
  "logged-in visitors only"; there is no such state here, and guessing wrong
  puts a deliberately non-public page on the open web during a migration.
- **Author accounts are not created.** The logins and emails in your export are
  shown so you can invite the real people yourself. Creating accounts — or
  sending invitations — from an uploaded file would make this server a way to
  email thousands of strangers.

Shops come across too: `npm run import:woo -- ./dump` imports products,
categories, brands, customers and orders, and **turns the shop on if it was
off** — never off. A price that is not a whole number of cents is refused
rather than rounded, and WordPress administrators are not imported as
customers.

The importer this replaces wrote `db.json` directly, which meant it did nothing
useful on the libSQL and relational drivers, skipped HTML sanitization, and
handled posts only.


### `/api/media/get` now pages — and the old call still works

**API change, staff-only endpoint.** It accepts `limit` (default 48, max 200),
`offset`, and `q` (server-side search over `original_name`, `alt_text`,
`filename`), and reports `meta.total`, `meta.limit`, `meta.offset` and
`meta.has_more`.

**A call with no parameters still returns the whole library**, exactly as
before. The endpoint has two callers in this repo and unknown ones outside it,
and a caller that asks for everything must not silently receive a first page it
cannot detect. Opting in is passing a parameter.

Why: it returned the entire library with no way to ask for less. On the
production shop that is 948 items, which the admin then rendered *twice* — grid
and list from the same array, ~1,900 `<img>` elements for ~950 thumbnails. One
manager opening the picker produced 33 HTTP 503s in a minute.

`/uploads/*` now sends `ETag` and `Last-Modified` and honours `If-None-Match` /
`If-Modified-Since`. The responses already said `immutable`, which covers the
common case and not the ones that hurt — a hard refresh, an evicted cache, a new
device — where there was nothing to revalidate against and every full-size
thumbnail came down again.

### Rate limits are counted per principal, not per address

A logged-in staff member is now counted as `user:<id>` against
`STAFF_RATE_LIMIT_PER_MIN` (default 600). An API key keeps its own bucket.
Only anonymous traffic falls back to `api:<ip>` at the unchanged
`RATE_LIMIT_PER_MIN` (60).

Two people in one office no longer share a bucket — an IP identifies a building,
not a person, and charging one colleague's work to another's budget is what made
this a production incident.

Every `/api` response now carries `RateLimit-Limit`, `RateLimit-Remaining` and
`RateLimit-Reset`, and a 429 adds `Retry-After` plus `retry_after` in the body.
They are listed in `Access-Control-Expose-Headers`, without which a cross-origin
storefront cannot read them from JavaScript at all.

**Login (10 / 15 min) and forgot-password (5 / 15 min) are unchanged.** Those
protect credentials, not convenience.


### The optical module is now a module

Everything AstroBaaS knows about selling glasses moved into
`src/plugins/optical/` — a bundled, compiled-in plugin. Core used to validate
prescriptions **inline in checkout**: `commerce-service.ts` knew what a cylinder
axis was. It now asks one generic question, `PLUGIN_HOOKS.ORDER_LINE_EXTRAS`
("does this vertical accept this order line, and does it want to attach
anything?"), and the plugin makes the answer optical. A future vertical answers
the same question its own way rather than carving a second hole in checkout.

The DATA stays in core — `requires_prescription`, `prescription_type`, and the
`Prescription` on an order line. Shape is data, and data has to outlive the
plugin that understood it: deactivating a module must never rewrite what a
customer already bought.

**Degradation is the contract, and it is tested on all three storage drivers.**
With the module off, both schema endpoints 404, an Rx product sells without a
prescription (the flag becomes inert, nothing 500s), and a prescription frozen
onto a past order is still there.

**Upgrade safety.** Bundled plugins seed *inactive*, so this nearly shipped a
silent regression: an existing optical shop would have stopped validating
prescriptions, and a spectacle lens would have sold with no prescription at all.
Migration **v11** switches the module on for any install with evidence it was
already selling optical goods — a product flagged `requires_prescription`, or a
historical order line carrying one. A general shop is left alone.

The migration also seeds its own plugin record, which is the actual fix:
migrations run inside `LocalDB.init()`, which the plugin bootstrap calls *before*
it seeds bundled plugins, so at migration time there is normally no `optical`
record to find. The first version bailed on "no record" and did nothing. Caught
by booting a real pre-upgrade database with the new build and watching an Rx lens
sell with no prescription; verified fixed on lowdb, libSQL doc-blob and
relational.

### Frame sizing — the eyewear vertical's other half

New in the module: `frame-size.ts` models frame geometry (lens width, bridge,
temple, lens height, total width), face measurement, and the fit between them.

- **Two units, and every field name says which.** `*_mm` is whole millimetres —
  frame geometry, because that is how eyewear is manufactured and printed on the
  temple arm. `*_tenths` is tenths of a millimetre, for anything measured off a
  person, matching the convention the prescription already uses for PD. A silent
  10x recommends a frame for a doll or a horse, so the crossing is a pair of
  functions with a round-trip test.
- **Estimated vs measured is load-bearing.** Most suppliers do not publish a
  total frame width, so it gets estimated - and the estimate carries a few
  millimetres, which is the entire fitting tolerance. `totalFrameWidthMm()`
  returns the flag alongside the number so a caller cannot present a guess as a
  measurement.
- **Recommendations round INWARD**, so a recommended frame is always one the fit
  badge on the same page calls a good fit. Rounding both ends outward looked
  natural and made the recommender contradict the badge beside it; a sweep of
  every face width from 120mm to 160mm caught it.
- **Card-scale photo measurement** works from an ISO/IEC 7810 ID-1 card - every
  bank card in the world, to a tenth of a millimetre. The API takes marker
  COORDINATES, never image data: a face photo is personal data the shop would be
  holding and defending, a face width in tenths of a millimetre is not. An
  implausible result is refused rather than clamped.
- **A photo-derived PD is not lab grade**, and `pdIsLabGrade()` plus the public
  schema both say so. 1-2mm of PD error puts the optical centre off the pupil,
  and the remake costs more than the return this feature exists to prevent.

`GET /api/commerce/frame-schema` publishes all of it, so a decoupled storefront
builds its size guide without hard-coding a millimetre.


### The product form can finally file a product into a category

`src/pages/admin/products.astro` loaded the category list and used it for
nothing but a count in the page subtitle. There was **no form control for
`categories` at all** — Brand had one, categories did not. The API accepted them
the whole time, so no HTTP test could see it: a shop manager simply could not
put a new product into a category, and the storefront builds its entire menu
from that tree, so the product was reachable at `/shop` and in no menu category
at all.

**Checked first, because it was the frightening half of the report: an edit does
NOT silently unfile a product.** Verified on all three storage drivers by
replaying the exact payload the form submits — `pickWritableProductFields()`
keys on `k in body`, so an absent `categories` never enters the patch and the
stored value survives. An explicit `categories: []` still clears, so a real
"remove all" keeps working.

The new control is a hierarchical checkbox list: parents with their children
indented beneath, built from `parent_slug`, guarded against a cycle (an operator
can point `parent_slug` anywhere, including at itself) and against an orphan (a
`parent_slug` naming a deleted category would otherwise make that category
vanish from the form). Pre-selected when editing.

Emptying the list on an existing product asks for confirmation rather than doing
it silently — and rather than silently *ignoring* it, which was the other option
considered and is the same class of bug as the missing field.

### Prices accept a comma

`Regular price` and `Sale price` were `type="number"`, which cannot represent
`159,00`. The browser sanitises an unparseable value to the empty string, so the
field visibly read `159,00` while its value was `""`. On the required regular
price that produced "Please fill out this field" pointing at a filled-in field.
On the sale price — optional, so nothing validated it — **the value silently
vanished and no sale was saved**.

Both are now `type="text"` with `inputmode="decimal"`, and a comma or a dot is
accepted. A thousands separator is refused with a clear message rather than
interpreted: `1.159` is €1.159 to a Greek reader and €1,159 to an English one,
and guessing wrong about a price is a mispriced product.

### A sale priced through the API never showed as a sale

`on_sale` is documented as server-derived, and nothing on the products API
derived it. It was computed only in the CSV import path and hardcoded `false` on
create, so a product priced in the admin or over REST stored `on_sale: false`
forever.

The storefront reads that flag directly — it decides the strikethrough original
price and the sale badge, and `?on_sale=true` filters on it. A shop manager
could put 400 products on sale and no customer would see a single discount, on
the product page or in the promo listing. Nothing errored, which is what made it
expensive.

The rule now lives in one place, `deriveSaleState()`, called by `saveProduct()`
— so every writer gets it: REST create and update, the admin form, the MCP
server, the bulk importer and any plugin. A test asserts the API path and the
import path produce identical `on_sale` **and** `price_cents` for the same
input, which is what stops them drifting apart again.

Three things came out of the fix that were not in the original report:

- **`on_sale` was accepted as client input on POST** (but ignored on PUT), so a
  client could create a full-price product flagged as discounted — an advertised
  saving that does not exist. It is now derived on both, and dropped from the
  POST schema.
- **`in_stock` had the identical bug**, named in the same doc comment: hardcoded
  `true` on create and never recomputed, so a product edited down to `stock: 0`
  still reported itself in stock. Display only — `availableFor()` gates checkout
  on `stock`, so nothing was oversold — but a shopper could add a sold-out item
  and be refused at checkout.
- **The scheduled sale window was never read.** `sale_starts_at` /
  `sale_ends_at` were stored, validated and unit-tested, and `saleActiveAt()`
  had no production caller. Deriving `on_sale` from price alone would have taken
  every sale scheduled for next month and made it live immediately — and
  `price_cents` follows `on_sale`, so that charges the sale price early. The
  window is now honoured. Note it is evaluated on WRITE: a sale that becomes due
  tomorrow goes live the next time the product is saved, not at midnight. There
  is still no sale scheduler.

### Astro 7 — and `npm audit` down to zero

`npm audit` reported 2 high and 2 low. All four traced to one root, Astro
6.4.8, and all four are gone at 7.2.0: three XSS advisories in Astro itself, a
nested `sharp@0.34.5` with four libvips CVEs (Astro 7 has no `sharp` dependency
at all), an `esbuild` advisory the new range steps past, and `@astrojs/node`,
fixed in 11.1.0 which requires Astro 7.

None of the Astro advisories were reachable here — no View Transitions, no
attribute spreads, no `astro:assets`. But "unreachable" is an argument every
visitor has to take on trust after running `npm audit` and seeing red. Now there
is nothing to explain.

Two v7 behaviour changes are pinned rather than inherited:

- **`compressHTML: true`.** The v7 default became `'jsx'`, which strips
  whitespace *between* inline elements — `<span>a</span> <em>b</em>` renders as
  "ab". On a CMS that is content corruption, not a formatting preference.
- **`markdown.syntaxHighlight: 'prism'`.** Shiki highlights with inline styles,
  which the hash-based CSP blocks. Nothing renders through Astro's markdown
  pipeline today, so this changes no output — it means the first person to add a
  `.md` page gets a styleable code block instead of one the browser refuses to
  paint.

Verified rendering-neutral rather than assumed: 13 URLs captured from the
production build before and after. Status codes and response headers (including
the CSP) identical; visible text identical on all 13.

### Custom content types are private by default — BREAKING

A type registered by a plugin used to be world-readable at
`GET /api/content/<name>` with no way to opt out. Fine for `event` or `doc`; a
data breach for `job-application` or `enquiry` — and the leak landed on the
plugin author who never considered visibility, i.e. the one most likely to get
it wrong.

Types now require `visibility: 'public'` to be readable anonymously. **If you
register a content type a storefront reads without credentials, add that line**
— see [UPGRADE.md](./UPGRADE.md) U-12. Writes are unchanged (admin/editor), and
authenticated reads are unchanged.

### Security: the last four Phase D2 items

- **A scoped API key could read every unpublished draft.** The scope gate was
  skipped for public GETs, which looked harmless — but bearer auth also
  *identifies* the caller, and `/api/posts` widens its results for an identified
  viewer. A key scoped to `products:read` read a draft that the same request
  without credentials could not see. On a public GET, an out-of-scope key is now
  treated as anonymous: it keeps the access, loses the elevation.
- **The revisions endpoint was a slug oracle.** 404 for "no such post", 403 for
  "not yours", so any author could enumerate slugs from the status code. Both
  are now the same 404.
- **The production password gates failed open.** `seed-data.ts` and `login.ts`
  keyed on `process.env.NODE_ENV`, which `npm start` sets but
  `node ./dist/server/entry.mjs` under systemd, Docker or PM2 does not. Those
  installs seeded `admin`/`admin` and accepted it at `/login`. Both now key on
  the build via `isProductionRuntime()`.

### `assistant.js` no longer ships to installs without an assistant

The homepage says the client JavaScript is a consent manager "and the AI
assistant if you enable it". The feature was conditional; the download was not.
Public pages now carry **10.7 KB in one file, down from 15.5 KB in two**.

### Contributor License Agreement

Pull requests are now gated on [CLA.md](./CLA.md). Contributors keep their
copyright and grant the right to relicense, including commercially — which is
what makes a paid module on a GPL core possible. §4 states what the maintainer
gives back, including a commitment that merged contributions stay in the
open-source edition.

### "Unknown Author" is gone

Three surfaces resolved a byline as
`users.find(u => u.id === post.author_id)?.name || 'Unknown Author'`. That
fallback fires whenever the id does not resolve — a deleted contributor, a
WordPress import, a restore from a backup predating the account. None of those
mean "unknown": the site owner knows perfectly well who publishes their site,
and "Unknown Author" on a real business page reads as broken software.

The fallback is now a cascade, each step true when reached: the post's actual
author → the site's configured author (`site_author_name`, new in Settings →
General) → the site title. There is no step that says "unknown", because at
least one of those is always available. When `site_author_url` is set the name
becomes a link; only `http(s)` is accepted, so a stored `javascript:` cannot
reach an `href`.

Both settings default to EMPTY. This ships to everyone, and baking a name into
the source would put one person's identity on every install of an
open-source CMS.

### hreflang (Phase E complete)

Translated pages now advertise each other. The rule that decides whether this
works at all is reciprocity — every URL in a set must list every URL in that
set, itself included, or search engines discard the lot — so one function
returns the whole set for any member. An unpublished translation, a translation
in an unconfigured locale, and a duplicated locale are each excluded, because
every one of them would hand a crawler a URL that does not resolve or a
conflicting tag. A single-language install emits nothing.

### The paid boundary is settled

**Commerce stays in the core** and is not sold separately — it is woven through
the storage contract every driver implements. The paid boundary moves up to the
**optometry / eyewear vertical**, which is genuinely separable. Decided, not
built. The rules any future paid module must follow — the core behaves the same
without it, and there is never a licence check on the request path — are in
[LICENSING.md](./LICENSING.md).
### A `manager` role for shop staff

`manager` joins the Role union: shop staff who run the catalogue, but who
cannot change how the site is built, who can log in, or where money goes.

**A manager may** create, edit and **delete** products (deletion was admin-only),
manage product categories and brands, **read** orders and customers, write and
edit their own blog posts, and upload media and delete their own uploads.

**A manager may not** touch themes, plugins, users, settings, API keys,
webhooks, the audit log, backup/tools, refunds, coupons, shipping methods,
`POST /api/commerce/import`, order status, or customer records.

### The admin sidebar is role-aware

It had empty frontmatter and rendered all sixteen links to everyone, so a
restricted user clicked "Users", got bounced to the dashboard, and learned only
that the product looked broken. Every link now goes through the same function
the middleware enforces with.

Access was previously expressed three separate times — a regex in the
middleware, a hand-written `role !== 'admin'` per page, and nothing in the
sidebar. That is now one map in `src/lib/admin-access.ts`, which all three ask.
Hiding a link is still presentation: the middleware remains the enforcement
point, and an **unknown** admin screen denies everyone but admin, so a page
added later is admin-only until someone deliberately opens it.

Also: the dashboard server-rendered `LocalDB.getUsers()` for every staff role
just to print a count. It is now fetched only for admins, and the stat is hidden
rather than shown as "0 authors" — a wrong number is worse than no number.
### Fixed — from an adversarial review of the two previous commits

- **A deactivated plugin kept POSTing site content to its webhook URL.**
  `syncPluginWebhooks` passed the whole `PluginRecord` to `isDeclarativeRecord`,
  which tests `.manifest` — and a record keeps its manifest at
  `settings.manifest`. The guard was therefore always false and the function
  always returned 0 without doing anything, so turning a plugin off never
  removed its subscriptions. Every other call site in the codebase passes
  `.settings`; this was the one sibling that was missed. Pre-existing, reachable
  from the plugin toggle.

- **`?locale=` silently dropped posts with a stale locale.** The route this
  replaced folded ANY unconfigured locale value to the default (via
  `filterByLocale` → `recordLocale`); the new filter folded only `null`. A post
  carrying `''` or a language that was later switched off used to be served
  under the default and instead vanished from every list. Both implementations
  had the same defect in the same direction, so the cross-driver test could not
  see it. Now both compute the effective locale the way `recordLocale` does.

- **Upgrading a plugin in place enforced none of the dependency contract.**
  Install-as-upgrade is a third mutation point, and it neither checked the new
  version's own dependencies nor its dependents' ranges — so a plugin could be
  upgraded into a dependency it declares incompatible and come straight back up
  running (the record is overwritten and `reloadPlugins()` re-activates it from
  the still-true `active` flag, so activation's check never runs), and a
  dependency could be upgraded out from under a running dependent. Uninstalling
  it was refused for that exact reason; upgrading was not.

- **`dependentsOf` used `in`**, which walks the prototype chain, so a plugin id
  of `constructor` or `toString` matched every plugin declaring any dependency
  and would have blocked their removal.

### Removed

- **`search` from the storage query contract.** I shipped it twice and it was
  wrong both times. SQLite's `LOWER()` is ASCII-only — `lower('ΓΥΑΛΙΑ')` returns
  it unchanged — so on the two live Greek shops, where all-caps titles are
  routine, a search would have worked on the doc drivers and silently returned
  nothing on the relational one. The repo already solved this once
  (`foldForSearch()` in lib/text-search.ts, written for exactly this Greek
  capital/accent problem) and no SQL expression can reproduce it: honouring it
  needs a folded column written at save time. Unescaped `%`/`_` in the LIKE
  pattern disagreed with the pure version too. Nothing called it. A filter whose
  meaning depends on the driver is worse than no filter, so text search waits
  for the folded-index work where it can be correct.

### Filtered, paginated reads in the storage contract (Phase K)

`getPosts()` returned every row, and eighteen callers used it to render one
page. On the doc drivers that is a full parse of the collection; on the
relational driver it was `SELECT data FROM posts` into memory followed by
`.slice()`. Fine at a few hundred posts, wrong in shape, and the shape that
stops this working at size.

`Storage.queryPosts(query)` now takes filters, a sort and limit/offset and
returns `{ items, total }`. `getPosts()` stays for the callers that genuinely
need everything — export, backup, the change feed.

The interesting part is that this needs TWO implementations, and two
implementations of a filter is two chances to disagree silently — a driver that
orders differently, or counts `total` after the slice instead of before, gives
pagination that skips rows while nothing throws. So the SEMANTICS live in one
pure function (`src/core/post-query.ts`) which the doc drivers run directly and
which the relational driver's SQL must agree with, and the smoke suite runs the
same queries on all three drivers as a differential test. Two properties it
pins: `total` counts matches BEFORE limit/offset, and the sort is TOTAL — `id`
breaks `created_at` ties, or two posts written in the same millisecond swap
between pages and one is served twice while another is never served at all.

`GET /api/posts` now uses it. The response is unchanged in shape and in every
`meta` field. One honest correction to an earlier claim of "byte-identical":
posts sharing a `created_at` now order by `id` as a tiebreak, where before they
kept insertion order. That is the fix for pagination skipping rows, not an
accident — but it IS an observable difference and the original wording
overstated it. One narrowed contract: the `api_posts_get` plugin hook receives
the page rather than the whole collection. Nothing implements it — it is
declared in `plugin-system.ts` and called from exactly one place — so no
behaviour changes today, and PLUGIN_DEVELOPMENT now says so.

### Plugin dependencies

A manifest can now declare `dependencies: { "commerce": "^2.0.0" }`. This is
what makes verticals sellable: a generic commerce plugin for everyone, and an
optical pack — prescriptions, dioptres, lens configurators — sold on top of it.
Without it the pack installs happily with nothing to attach to, does nothing,
and blames the host; and removing commerce breaks it with no warning anywhere.

Each rule is enforced at the point where it is actionable:

- **Install with a dependency unmet is allowed** — an operator cannot be made to
  install in topological order, and refusing would make a two-plugin bundle
  impossible to install at all. The 201 carries `unmet_dependencies` and the
  message says it cannot be activated yet.
- **Activation is refused**, naming which dependency is missing, inactive or
  out of range. That is when a plugin starts contributing content types,
  sections and webhooks, so it is when its assumptions must hold.
- **Deactivating or uninstalling something an ACTIVE plugin depends on is
  refused**, naming the dependents. An inactive dependent does not block; it
  simply cannot activate until the dependency returns.

Version matching is a deliberate subset (`^`, `~`, `>=`, `>`, `<`, `<=`, exact,
`*`) that **refuses ranges it does not understand** rather than returning a
silent `false` — an author who wrote `1.x` is told, instead of watching a
dependency never resolve. `^0.2.3` correctly treats a minor bump as breaking,
and a pre-release only satisfies a range that names one at the same version, so
`^2.0.0` will not quietly accept `2.1.0-alpha.1` in a live shop.

### Runtime theme installation, and three defects a multi-agent audit found

**Themes are now installable at runtime**, which they were not. A theme used to
mean Astro components, and Astro bundles at build time — markup genuinely cannot
be installed at runtime, so themes were compiled in and the README said so.
Sections changed that: the substance of a theme is now expressible as data, so
there are two tiers, mirroring plugins.

- **Declarative themes.** `POST /api/themes/install` takes a JSON manifest —
  design tokens, a stylesheet, section patterns. No rebuild, no code execution.
  Install, activate, upgrade and uninstall from Admin → Themes.
- **Bundled themes** keep the one thing the declarative tier cannot do: replace
  the Header/Footer/Sidebar/PostCard/PostArticle components.
- Token values are validated as values, not strings: colours must match a hex
  pattern and `style` entries must be token KEYS, so a stored value can *select*
  CSS but can never *be* CSS — `"primary": "red; } body { display:none } .x{"`
  is refused. A theme cannot write the operator's `customCSS`. Upgrading
  preserves the operator's customized tokens and the active flag.

### Fixed

- **A Page slugged `about` was permanently unreachable.** The design comment
  claimed a rest-parameter catch-all yields to explicit routes "until someone
  creates a Page with that slug". The opposite is true: Astro's route order is
  static and no database row changes it, so the built-in `/about` always won.
  The Page saved (201), listed with an `/about` permalink, and its "View" link
  opened the built-in page — while `/sitemap.xml` advertised `/about` with the
  *Page's* `lastmod`, telling crawlers content had changed when the served bytes
  had not. Nothing 404'd and nothing logged. `about` and `contact` are the two
  likeliest first uses of the entire feature. Such slugs are now refused at
  write time with an explanation, on create AND on update — the latter covers
  both renaming a page onto a reserved slug and converting an existing post that
  already has one. The reserved list is a plain array guarded by a test that
  reads `src/pages/` from disk, so it cannot drift.

- **A plugin could ship `body { display: none }`.** `unscopedSelectors()` — the
  scanner that confines plugin CSS to its own `ab-x-<pluginId>-` namespace —
  stripped comments with a regex before counting braces, which is blind to CSS
  strings. `content:"/*"` … `content:"*/"` made the regex swallow the rules
  between them, so the scanner saw one scoped rule and the browser saw three.
  `/plugins.css` is linked from `BaseLayout`, which backs the ADMIN as well as
  the public site, so this was defacement of the live storefronts and a
  UI-redress surface over CSRF-bearing forms. Replaced with a single-pass state
  machine that treats strings as first-class: comments are recognised only
  outside strings, braces only outside both, and an unterminated string or
  comment fails closed.

- **The serve-time guard was not one.** `manifestSectionCss()` documented itself
  as re-checking scoping "because a row can be edited in the database", but did
  `if (!scrubbed.includes(prefix)) continue` — a substring test. Any block that
  mentioned the prefix once was served whole, unscoped rules included, which is
  why the bypass above reached the browser with nothing in its way. It now runs
  the real scanner and drops the block with a warning.

All three were found by an adversarial multi-agent audit of the branch and each
was reproduced by hand before being fixed. The first two are cases where a
comment asserted a directional fact backwards and code was built on it.

### Patterns, a section toolbar, and plugin-contributed sections (Phases H–I)

- **Patterns** — named arrangements of sections ("hero, three features, a call
  to action") offered in the editor. A pattern is plain markup: nothing links a
  post back to it, deliberately, because a live reference would let a theme
  update silently rewrite published pages.
- **A section toolbar** — move up/down, duplicate, delete, acting on the section
  under the caret.
- **`ThemeDefinition.css` and `.patterns`** — a theme can ship a stylesheet and
  its own patterns. The stylesheet is appended to `/theme.css` after the tokens
  and before operator CSS.
- **Plugin sections.** A manifest can declare `capabilities.sections`. The class
  is `ab-x-<pluginId>-<name>`, derived by the host, so a plugin cannot shadow a
  core section or another plugin's. Plugin CSS must be scoped to that namespace;
  `body {}`, `*` and `@font-face` are refused, which bounds a plugin's styling
  to the markup it contributed rather than the whole document.
- **Section health** in Admin → Tools: which stored records carry `ab-` classes
  this build can no longer style, and which patterns were refused and why.

Everything above shares one rule, enforced rather than documented: **what the
editor offers must be exactly what the save path keeps.** A pattern or section
whose markup the sanitizer rewrites is refused — at install, for a plugin, with
the sanitized output shown beside the submitted markup, because "rejected" is
not actionable and a diff is. A block that renders in the editor and loses part
of itself on save is the most expensive failure this system can have: the author
finds out on a published page.

**Removing a plugin never destroys content.** Its sections leave the palette and
its styles stop being served, but the markup stays and degrades to plain
readable HTML; reinstalling restores the styling. The content sanitizer matches
the `ab-x-*` namespace by shape rather than by looking up installed plugins,
precisely so that saving a page while a plugin is disabled cannot strip it out.
`SANITIZE_STRICT_CLASSES=1` opts out for operators who want a closed allow-list.

Fixed on the way: `validateManifest` checked a capability and then built its
normalized output from a second, hand-maintained list — so `sections` validated
correctly and was silently dropped before anything could use it. Both now derive
from one `KNOWN_CAPABILITIES` list. This is the same "the schema names it, the
copy forgets it" bug as the missing `kind` on post creation, and the fourth time
this codebase has hit it; deriving one from the other retires the class rather
than the instance.

### Pages, sections and a choosable home page (Phase G)

The editor could produce a post and nothing else. You could not write an "About"
page, and you could not put anything you wrote at `/`. Both are table stakes for
a CMS, and both are now here — built as **one optional field on `Post`**, not a
second content type.

- **Pages.** `Post.kind: 'post' | 'page'`. A page is the same record with a
  different route — `/{slug}` instead of `/blog/{slug}`, no date or author
  byline — so it inherits revisions, autosave, i18n, sanitization, the editor
  and the permission model without a line of new storage code. The catch-all
  route sits below every explicit route, so `/about` keeps resolving to the
  built-in page until someone creates a page with that slug.
- **Sections.** A palette of eight pre-designed blocks (hero, columns, card,
  CTA, note, media, gallery, spacer) inserted into the existing editor as
  **allow-listed CSS classes**, not a parallel block tree. `content` stays the
  sanitized HTML string every downstream consumer already reads. The
  sanitizer's class allow-list is now *generated* from the palette
  (`src/core/sections.ts`), so a section can never be offered in the editor and
  then silently stripped on save — the failure mode that already shipped here
  once, as alignment buttons emitting an inline `style`.
- **A choosable home page.** The `home_page_slug` setting serves any page at the
  site root. If it names a slug that has been renamed, unpublished or deleted,
  the stock welcome page renders instead — a typo in a settings field cannot
  take a live site's front door down.
- **A truthful preview.** Both editors previously opened `about:blank` and
  `document.write`'d the raw editor HTML: a self-XSS surface (no CSP on
  `about:blank`, content interpolated unsanitised) that also showed something
  the published page would never look like. Preview is now a real page running
  the real pipeline — `applyFilters('post_content')` then `sanitizeHtml`, inside
  the site layout — submitted over POST so drafts stay out of URLs, history and
  `Referer`. Staff only.

**Behaviour for existing sites is unchanged.** Every record written before this
field has no `kind`, and absent means "article" — so the blog archive, the RSS
feed, the sitemap and `GET /api/posts` all return exactly what they returned
before. Pages are *excluded* from those surfaces rather than added to them, so
creating one cannot push a dateless entry into a subscriber's reader or a
storefront's blog listing. `GET /api/posts?kind=page|all` opts in.

Fixed along the way: `POST /api/posts` accepted no `kind` at all, so a page
created through the API was stored as a post — it 404'd at its own URL and
appeared under `/blog`. The admin post list showed `/{slug}` as every row's
public path, naming a URL that 404s for every blog post on the site.

### Honesty pass — every homepage claim measured against the code

An end-to-end audit measured all seven homepage claims against the running app.
Every one came back PARTIAL or FALSE, and the fixes below are the result. The
governing rule is recorded in the project's audit notes: **a claim is true when a stranger
can verify it**, not when the code "supports it".

- **Removed two false claims.** "Row-level security" does not exist here —
  authorization is enforced in middleware and route handlers over an
  identity-blind storage layer, and the term is a promise of database-level
  isolation this project does not make. "Thousands of developers" was written
  for a private, unreleased, zero-user repo.
- **Deleted a poller that never worked.** It compared `changes.length` against a
  response envelope — `undefined > 0` — so it had been false on every tick since
  it was written, while shipping 3.2 KB to every reader and burning CPU per open
  tab. `src/lib/sync-service.ts` went with it, taking a dead theming channel
  that had zero consumers.

### Security

- **Read-side visibility model** (`src/lib/visibility.ts`). The check used to be
  `if (!user)`, so any authenticated caller — including `viewer` — read every
  unpublished body. Now: anonymous/`viewer` see published only, `author` sees
  their own drafts, `editor`/`admin` see everything. Deny-by-default, and a
  hidden record 404s rather than 403s.
- **Credential-shaped settings are withheld from every role**, staff included.
  An `editor` could previously read `smtp_password` and `stripe_secret_key` from
  a route in the public allow-list.
- **2FA secrets no longer leave the server.** `GET /api/users/get` and
  `POST /api/users/update` each hand-rolled a sanitiser and one forgot
  `two_factor` — the TOTP secret and backup-code hashes. All user-returning
  routes now share `toPublicUser`.
- **`GET /api/media/get` is no longer public.** It enumerated every uploaded
  file to anonymous callers.
- **`GET /api/content/changes` no longer hands out entity snapshots** (draft
  bodies, order PII) to any authenticated principal.
- **Production refuses the seeded password.** A fresh production install
  generates a random one and prints it once; login rejects `admin` outright.
- **JSON in `<script>` is escaped through one helper.** `JSON.stringify` does
  not escape `<`, so a post title containing `</script>` closed the JSON-LD
  element and the rest parsed as markup — in `<head>`, on every public post
  page, authored by the lowest role that can write a post.
- **HSTS** available via `HSTS_MAX_AGE` (opt-in on purpose), and
  **`frame-ancestors`** added to the CSP — it had been omitted on the mistaken
  belief that Astro emitted a `<meta>` CSP, when `output: 'server'` means it is
  a real response header.

### Data integrity

- **Media deletes are refcounted.** Filenames are content-addressed, so deleting
  one record unlinked a file another record still pointed at. It was also a
  privilege escalation: an `author` could destroy an admin's file by
  re-uploading it and deleting their own copy.
- **A WebP upload no longer deletes its own stored file.** For a WebP input the
  raw and derived paths are identical, so the "remove the original" unlink
  removed the file the record points at.
- **The lowdb read cache** (`withReadCache`). lowdb re-parsed the entire JSON
  document on every getter — measured at ~159 ms per parse on a 26.5 MB database
  and ~9 parses per request. Validated on inode + size + mtime so another
  process's write is still seen. **17× fewer parses** on a 3.8 MB database.
- **Copy-on-read for every collection getter**, so `(await getOrders()).sort()`
  can no longer reorder the stored document — which, with the cache, would have
  been persisted.
- **The change feed no longer sorts its own cached array**, which had made the
  1000-record ring buffer evict its *newest* entries.
- **Plugin filter output is no longer stored as post content.** `GET` returned
  rendered text under the same key `PUT` writes back, so opening a post and
  saving baked the plugin's output into it, cumulatively and permanently.

### Theming

- **~30 design tokens** replacing 8: semantic colours, a typography scale, and
  enum-driven radius, density, shadow, container width, button and header
  styles. Enum values resolve through an allow-list, so a stored value can
  *select* CSS but never *be* CSS.
- **Dark mode** with a working toggle. The preference persists to a cookie the
  server reads, so `data-theme` is in the first byte of HTML — no flash, and no
  inline script, which the CSP would refuse.
- **Eight one-click presets**, each asserted to keep body text at WCAG AA
  contrast.
- Fixed the tokens that saved successfully and changed nothing:
  `backgroundColor`/`textColor` had no consumers, `fontSize` was never emitted,
  and the chosen webfont was never fetched.

### SEO

- `meta_title` / `meta_description` are **rendered** — they were declared,
  validated, stored, and read by nothing.
- **Article + BreadcrumbList JSON-LD**.
- The admin's **Site URL** setting now drives the sitemap, feed, `robots.txt`,
  canonical tags and structured data, through one resolver.
- Fixed `PublicLayout` never forwarding a head slot, which had silently dropped
  anything any public page tried to put in `<head>`.

### Mobile

- The admin drawer scrolls, closes on backdrop tap and Escape, locks body
  scroll, and returns focus. Previously nav items below the fold were
  unreachable and tapping outside did nothing.
- 44px minimum touch targets on coarse pointers — row actions were ~25×20px
  beside a destructive Delete.

### Commerce

- **Optical prescriptions**: per-eye lens powers captured at checkout, stored as
  integer hundredths of a dioptre, validated against clinical rules (axis
  required with a cylinder and refused without one, ADD positive, both eyes
  required). Refused before stock is reserved.

### Repository

- **Real customer data removed from git history.** `data/import/` held 24
  records of real people — names, emails, phones, addresses. Replaced with
  synthetic fixtures on RFC 2606 reserved domains; history rewritten and
  verified against a fresh clone.
- **CI restored.** It had not executed a test since PR #3 — `npm ci` died at
  install on a lockfile that no longer satisfied `fdir`'s `picomatch` range.
- `UPGRADE.md` added, documenting every behaviour change with remediation.



### Extensibility, i18n, and editorial (Tracks A–E)
- **Declarative plugins.** Runtime-installable JSON manifests that execute
  nothing — capabilities (`headTags`, `css`, `contentTypes`, `webhooks`) are
  interpreted onto existing engines. Curated registry with SHA-256 verification,
  `astrobaas plugin validate` (same validator as the install endpoint), and an
  admin install/uninstall UI. Code plugins and themes remain build-time.
- **Theme template overrides.** Themes can replace `Header`, `Footer`,
  `PostCard`, `PostArticle`, and `Sidebar`, inheriting the built-in default for
  every slot they don't override (so new slots can be added without breaking
  existing themes). Bundled `editorial` theme demonstrates it. Theme catalog now
  comes from the code registry; the DB holds activation + customized tokens.
- **i18n.** `SITE_LOCALES` enables multilingual content: posts carry `locale` and
  `translation_of`, `/de/blog` serves German from the same templates, the API
  takes `?locale=`, and the admin gains a language picker + filter. Unset =
  identical behaviour and URLs to before.
- **Post revisions + autosave.** Every save snapshots the previous content,
  drafts autosave without publishing, restore is undoable, retention is capped
  (`REVISIONS_KEEP`), and deleting a post removes its revisions. Stored in a
  dedicated collection (not `CustomEntity`) because they hold unpublished drafts.
- **Extension scaffolding.** `astrobaas plugin new`, `theme new`, and
  `plugin manifest` generate complete, compiling templates; `/llms.txt` now
  documents how to extend the server, not just how to call it.
- `GET /api/content/<type>/<id>` (fetch one custom entity) — previously missing;
  `GET /api/locales`; and the OpenAPI spec now covers every agent-facing route,
  with a test that fails if a new route is left undocumented.

### Security & auth (hardening pass)
- **Two-factor authentication (TOTP).** Optional per-account 2FA using any
  authenticator app (RFC 6238, implemented with `node:crypto` — no dependency),
  confirmed against the RFC test vectors. One-time backup codes (stored hashed),
  and a two-step login via a short-lived pending token so the code step never
  re-asks for the password. Manage it in Profile; `POST /api/2fa/{setup,enable,
  disable}` + SDK `auth.twoFactor.*`. TOTP secrets/backup hashes are stripped
  from every API/page via `toPublicUser()`.
- **Adversarial security review.** Fixed deny-by-default for scoped API keys,
  DB-revalidated admin-page gating, webhook SSRF guard, request-body size caps,
  open-redirect hardening, media role/ownership checks, and backup-driver
  guards. See the `security:` commit for the full list.
- **Shared multi-node rate limiting.** `RATE_LIMIT_STORE=libsql` shares API +
  login + password-reset counters across replicas (atomic SQL); startup logs
  the active store and warns on the silent per-process foot-gun.
- **Versioned schema migrations.** The DB records a schema version and pending
  migrations run automatically at startup across all three storage drivers;
  `/readyz` reports `schema_version` and holds traffic if an upgrade is behind.
- **Hash-based CSP.** The production build emits a Content-Security-Policy where
  `script-src` is `'self'` + the SHA-256 hash of every bundled script (via
  Astro's built-in CSP) — `'unsafe-inline'` is dropped for scripts *and* styles.
  Theme tokens moved from an inline `<html style>` to an external `/theme.css`;
  remaining dynamic styling uses CSSOM. CSP source allow-lists are now build-time
  env knobs (`src/lib/csp-config.ts`). Config moved to `astro.config.ts`.
- Added a `CODE_OF_CONDUCT.md` (Contributor Covenant).

### Repositioned as AstroBaaS
- Rebranded from AstroCMS to **AstroBaaS** and repositioned from "CMS" to a
  TypeScript-native, self-hostable backend (auth + data + API + storage) for
  Astro/React/Vue frontends — admin included, not required.
  Functional renames: package `astrobaas`, import path `astrobaas/core`, cookies
  `astrobaas_*`, `window.__ASTROBAAS__`. (Repo URL unchanged.)

### Database / storage
- **Pluggable persistence.** `DATABASE_URL` selects the engine: unset → lowdb
  JSON file (zero-config dev); `file:`/`libsql://` → SQLite or remote Turso via
  libSQL (durable, deploy-portable, serverless/multi-host capable). Implemented
  as a lowdb-compatible adapter so every storage method is identical across
  drivers. See [STORAGE.md](./STORAGE.md).
- **Relational libSQL driver** (`DATABASE_DRIVER=relational`): a per-entity
  storage engine (one `(id, data)` table per collection) giving row-level
  concurrency, partial updates, and `json_extract` queryability — the
  recommended engine for production multi-writer / multi-host (vs. the doc-blob
  default's last-write-wins). `LocalDB` delegates to it through the same
  `Storage` interface, so no route/plugin/admin code changes. All three engines
  (lowdb, doc-blob, relational) run the full smoke suite in CI
  (`npm run smoke` / `smoke:libsql` / `smoke:relational`).

### BaaS / headless integration
- **API-key / bearer auth.** Mint keys at `POST /api/keys` (admin; secret shown
  once, SHA-256 at rest, constant-time compare). Send `Authorization: Bearer
  <abk_…>` to authenticate cross-origin/headless callers; bearer requests are
  CSRF-exempt and act with the key's role. Revoke at `DELETE /api/keys/{id}`.
- **Configurable CORS.** `CORS_ORIGINS` allow-lists origins (or `*`) for
  `/api/*`. Credentials are never allowed (token auth in a header, not a cookie),
  so the API stays CSRF-safe even with a wildcard origin.
- **Agent-readable contract.** `/llms.txt` (plain-text brief: base URL, auth
  schemes, endpoints) and `/openapi.json` (OpenAPI 3.1 with a `bearerApiKey`
  scheme) — both public, no auth.
- **Typed client SDK** (`astrobaas/client`): `createClient(url, { apiKey })` →
  typed `posts` / `content(type)` / `keys` / `webhooks` / `auth`; returns
  unwrapped `data`, throws `AstroBaasError(status, code)`. Isomorphic, zero-dep.
- **`astrobaas` CLI:** `init` (scaffold `.env` with a CSPRNG `AUTH_SECRET`),
  `secret`, `setup`. Zero-dep, runs under `npx`.
- **MCP server** (`astrobaas-mcp`): a zero-dependency stdio JSON-RPC server so AI
  agents can operate the backend. Tools cover the full CRUD surface (`whoami`;
  posts list/get/create/update/delete; content list/create/update/delete), and
  published posts are exposed as **resources** (`astrobaas://post/<slug>`). It
  probes the configured key at startup and logs the resolved role to stderr.
- **Outbound webhooks.** Register URLs at `POST /api/webhooks` (admin; signing
  secret returned once) to receive signed POSTs on `post.*` / `content.*`
  lifecycle events. Signature: `X-AstroBaaS-Signature: sha256=HMAC-SHA256(secret,
  rawBody)`. `GET`/`DELETE /api/webhooks[/{id}]` to manage. Fire-and-forget,
  never blocks the triggering request.
- **Webhook delivery durability.** Failed deliveries retry with backoff
  (`WEBHOOK_RETRY_DELAYS_MS`) and every attempt is recorded in a persisted
  delivery log: `GET /api/webhooks/deliveries` (admin) and manual re-send at
  `POST /api/webhooks/deliveries/{id}/redeliver`. The SDK adds
  `webhooks.deliveries()/redeliver()` and a receiver-side
  `verifyWebhookSignature()` (WebCrypto, constant-time).
- `/api/auth/me` is now auth-scheme-aware: returns a `type:'user'` principal for
  cookie sessions and `type:'apikey'` for bearer keys.
- **List pagination.** `/api/posts` and `/api/content/{type}` accept
  `?limit=&offset=&page=` and return `meta: { total, count, limit, offset, page,
  hasMore }`. The SDK adds `posts.page()` / `content(type).page()` returning a
  typed `Page<T>`, plus `listAll()` auto-paginators.
- **SDK resilience.** `createClient` accepts `timeoutMs` (abort), `retries` +
  `retryBackoffMs` (exponential retry on 429/5xx/network, honoring `Retry-After`),
  and per-call `signal`.
- **Pluggable rate-limiter.** `RATE_LIMIT_STORE=libsql` shares rate-limit
  counters across replicas via an atomic libSQL windowed counter (correct behind
  a load balancer); the in-process store stays the default. Both the API limit
  and the login throttle route through it; it fails open on a store error.
- **Security audit log.** Records logins (success/failed/throttled), API-key
  lifecycle (create/revoke/rotate), webhook create/delete, role/status changes,
  and password resets — with actor + client IP, never secrets. Admin
  `GET /api/audit?action=&limit=`, SDK `audit.list()`, and a `recordAudit()`
  helper exported from `astrobaas/core` for plugins/custom routes.
- **Admin screens** for the headless features (previously API-only):
  `/admin/api-keys` (mint with role/scopes/expiry, copy-once secret, rotate,
  revoke), `/admin/webhooks` (register, delete, delivery log + redeliver), and a
  read-only `/admin/audit`. New sidebar nav entries.
- **Publishable package.** `npm run build:pkg` (esbuild bundle +
  `tsc --emitDeclarationOnly`) emits self-contained `.js` + `.d.ts` for
  `astrobaas/core`, `/client`, and `/plugins` into `pkg/`; the published
  `exports` point there (in-repo dev still resolves TS source via tsconfig
  `paths`). `files` allowlist + `prepublishOnly` make it `npm publish`-ready, and
  `npm run test:pkg` imports the BUILT artifacts in plain Node ESM (in CI). The
  client bundle is dependency-free.

### Platform / extensibility
- **Public `astrobaas/core` API** — a stable barrel (mapped via package `exports`
  + tsconfig paths) re-exporting domain models, the `Storage` interface,
  `PluginManager`/`PLUGIN_HOOKS`, `definePlugin`/`defineTheme`, custom
  content-type helpers, `sanitizeHtml`, `validate`, `ApiResponseBuilder`, and the
  API client. Themes/plugins import from this, never internal paths. See
  [STABILITY.md](./STABILITY.md) and [PLATFORM.md](./PLATFORM.md).
- Domain models extracted to `src/core/models.ts` (storage-independent); the
  `Storage` contract (`src/core/storage.ts`) is implemented by LocalDB with a
  compile-time conformance check.
- Hook catalog expanded with `before_post_save` and `head_tags` (both fired +
  tested); `after_post_save` now also fires on update.
- **Custom content types** via `registerContentType()` + generic, schema-
  validated CRUD at `/api/content/<type>`; example `product-catalog` plugin.
- `apiClient` CSRF source is configurable (`configureApiClient`).

### Added
- **Scheduled-post worker.** An in-process interval sweep auto-publishes
  `status:'scheduled'` posts once their `publish_date` passes (firing a
  `post.updated` webhook). Tune with `SCHEDULER_INTERVAL_MS`, disable with
  `SCHEDULER_DISABLED`.
- **Observability.** `/readyz` readiness probe (200 only when storage is
  reachable, distinct from `/healthz` liveness); `/metrics` Prometheus counters
  (requests by status class, 5xx errors, uptime) behind `METRICS_ENABLED`; opt-in
  structured JSON request logging (`LOG_REQUESTS=1`) via a `sequence()` wrapper;
  and a `reportError()` shim exported from `astrobaas/core`.
- `/healthz` endpoint for container orchestration.
- `src/pages/500.astro` error page.
- `scripts/reset-password.mjs` — CLI to reset an admin's password without
  database access.
- `/admin/tools` page with backup export + restore import.
- `/api/backup/export` (zips `db.json` + uploads) and `/api/backup/import`
  endpoints.
- `scripts/import-md.mjs` — import a directory of `.md` files (frontmatter
  parsed for title/slug/status/tags).
- `scripts/import-wp.mjs` — import a WordPress WXR export.
- Image optimization on upload — Sharp pipeline generates `.webp` +
  thumbnail variants.
- `/og/[slug].png` — auto-generated Open Graph images for every published
  post.
- `SECURITY.md`, `CHANGELOG.md`, GitHub issue templates.
- One-click deploy buttons for Render + Railway in the README.
- Screenshots in the README.

### Changed
- README rewritten with a clearer pitch and a "Why AstroBaaS" section.
- Settings page: removed tabs that didn't persist (SMTP, Custom CSS/JS,
  allowed file types). Only General + Reading actually save now.
- Soft-delete: `/admin/posts` adds a "Trash" filter via the existing
  `trashed` status.
- Data layer serializes reads/writes through a mutex to prevent concurrent
  read-modify-write data loss (single-node).
- Database path and uploads dir are configurable via `DB_PATH` / `UPLOADS_DIR`;
  the Docker image stores both under a persistent `/app/data` volume.
- `astro.config.mjs` `site` is read from `SITE_URL` (was a placeholder URL),
  and `RATE_LIMIT_PER_MIN` now actually applies.

### Security
- **Post access control:** `PUT /api/posts/update` and `DELETE /api/posts/delete`
  enforce ownership/role — editors/admins may modify any post, authors only
  their own, viewers none (previously any logged-in user could edit/delete any
  post).
- **Unguessable IDs:** entity IDs are now `crypto.randomUUID()` instead of
  `Date.now()+Math.random()`.
- **No draft/trashed leakage:** `GET /api/posts` and `/api/posts/[slug]` return
  only published content to anonymous callers; `/api/content/changes` strips
  entity snapshots for unauthenticated pollers.
- **Upload hardening:** uploads are validated by magic bytes (not the client
  Content-Type or filename); SVG is rejected; allow-list is
  PNG/JPEG/GIF/WebP/PDF/text. A `/uploads/[...path]` route serves them with
  `X-Content-Type-Options: nosniff` (and works in the standalone build).
- **RBAC:** category/settings/theme writes and the user directory now require
  admin (or editor) roles; the last active admin can't be deleted, demoted, or
  deactivated.
- **Cookies:** session + CSRF cookies are `Secure` in production (override with
  `COOKIE_SECURE`).
- **Proxy spoofing:** `X-Forwarded-For`/`X-Real-IP` are trusted only when
  `TRUST_PROXY=1`; otherwise the socket address is used for rate limiting.
- **Backup restore** sanitizes imported post HTML.
- HTML sanitizer hardened against entity/whitespace-encoded `javascript:` URLs
  and dangerous container tags; `data:` URLs limited to raster images.

### Fixed
- Docker now declares a `/app/data` volume + `HEALTHCHECK`; `db.json` and
  uploads no longer reset on redeploy.

### Removed
- Stale planning docs (`security-assesment.md`, `nextsteps.md`, `AUDIT.md`) and
  dead Supabase env typings — they described a pre-LowDB, no-auth codebase.

## [0.0.1] — internal pre-alpha (not released)

The state before this changelog existed. Roughly:

- Astro 5 SSR with the Node standalone adapter.
- LowDB-backed CRUD for posts, categories, users, media, settings.
- Session auth (PBKDF2 + signed cookies), CSRF, security headers,
  per-IP rate limit.
- Public blog with `/sitemap.xml`, `/rss.xml`, `/robots.txt`.
- HTML sanitization on post save.

The phased plan that produced this state is kept outside this repository.
