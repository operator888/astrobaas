# Security policy

## Supported versions

AstroBaaS is **pre-alpha**. `0.1.0` is the first public release.

Security fixes land on `main` and go out in the next release. Only the current
`main` and the most recent release are supported; nothing is backported to an
earlier version, so upgrading is the fix.

| Version          | Supported |
| ---------------- | --------- |
| `main` (HEAD)    | ✅        |
| Latest release   | ✅        |
| Anything earlier | ❌        |

## Reporting a vulnerability

If you find a security issue, **please do not open a public issue.** Instead,
use GitHub's private vulnerability reporting:
[**Report a vulnerability**](https://github.com/operator888/astrobaas/security/advisories/new).
Please include:

- A description of the issue and impact.
- A minimal reproduction (URL, payload, expected vs actual behaviour).
- Whether you intend to publish a CVE/blog post — we'd like to coordinate.

We aim to acknowledge within **3 business days**. After that: this is one
maintainer, so we will not promise you a fix by a date we might miss. What we
do promise is a **status update at least once a week** until the issue is fixed
or we have agreed with you that it will not be, and that high-severity issues
are worked before anything else. We will credit you in the changelog unless you
ask us not to.

## Threat model and known limitations

AstroBaaS is designed for **single-node, self-hosted, low-traffic** use. It
is not yet hardened for multi-tenant or high-traffic deployments. In
particular:

- **No HTTPS termination.** Run AstroBaaS behind a reverse proxy (Caddy,
  Nginx, Traefik) that provides TLS. Cookies are `HttpOnly` and
  `SameSite=Lax`, and in production (`NODE_ENV=production`) also `Secure`, so
  you must serve over HTTPS. Force the flag on/off with `COOKIE_SECURE=1/0`.
- **Rate limiting is per-process by default.** The zero-config limiter keeps
  per-IP counters in memory, so a multi-replica deployment under-counts. For
  multi-node, set `RATE_LIMIT_STORE=libsql` (with a libSQL `DATABASE_URL`) to
  share counters across instances via atomic SQL — the API, login, and
  password-reset throttles all use it. The server logs which store is active at
  startup and warns if a libSQL DB is configured but the shared store wasn't
  enabled. You can still put an edge limiter (Cloudflare, nginx-limit-req) in
  front as defence in depth.

  A full in-memory store (50,000 keys per map) evicts expired entries first,
  then the live ones closest to expiring — it never clears itself, so flooding
  it with fresh keys cannot reset a login throttle or re-open a spent magic
  link or captcha proof. The libSQL store sweeps expired rows for **all** keys
  at most once a minute, so the `rate_limits` table no longer grows with every
  address that ever called.
- **Per-IP limits count an IPv6 /64 as one caller** and an IPv4-mapped IPv6
  address as its IPv4 address. `locals.ip` — and therefore every per-IP budget,
  order-risk hash and audit entry — holds that grouped identity, so an IPv6
  client's audit line shows its /64, not the full address.
- **Expensive routes have their own per-IP budgets** (checkout, quote, payment
  start, search), below the general 60/min; payment webhooks are taken out of
  the anonymous budget and given a generous one. Defaults and env overrides are
  in INTEGRATION.md.
- **Trusted client-IP forwarding is a trust grant.** An API key an admin marks
  `forward_client_ip` may name, in `X-AstroBaaS-Client-IP`, the shopper a
  request is for; that address then drives the per-IP route budgets, order risk
  and the audit trail. The header is ignored for anonymous callers, cookie
  sessions and unmarked keys. A LEAKED forwarding key can therefore rotate the
  address it is counted against — it stays inside its own per-key budget
  (6000/min by default), and revoking the key ends it. Mark only keys that live
  on a server.
- **Sign-in throttles cannot be used to lock an owner out.** Three counters,
  fifteen-minute windows:
  - 10 attempts per address + email — a hard `429`, as before;
  - 30 *failed* sign-ins per address across all emails (credential stuffing) —
    a hard `429` for that address only (`LOGIN_IP_FAILURE_LIMIT`);
  - 5 failed sign-ins per account from **any** address — not a lock: from then
    on that account's password is only checked together with a solved
    proof-of-work (`403 POW_REQUIRED`, challenge included;
    `LOGIN_ACCOUNT_POW_AFTER`). The admin sign-in page solves it in the
    background, so the owner signs in as usual. Unknown emails are counted the
    same way, so the counter reveals nothing about which accounts exist.

  The two-factor step allows 10 code attempts per account per window
  (`TWOFA_ATTEMPT_LIMIT`), on both the pending-cookie and the password+code
  paths. Reaching it requires the password, so only someone who already has
  the password can spend that budget.
- **Signing out revokes the token on the server.** Each session token carries an
  id; signing out records it on the account until the token would have expired,
  and the middleware refuses it — across restarts and replicas, on every driver.
  Other devices stay signed in. Two fallbacks sign the account out
  **everywhere** instead (bumping `session_version`): a token issued before this
  release (it has no id — this lasts at most the 24-hour token lifetime after
  upgrading), and an account with more than 50 unexpired signed-out tokens.
  `npm run reset-password` now signs the account out everywhere too, as the web
  reset always did.
- **Password hashing runs off the event loop.** PBKDF2 (120,000 iterations,
  SHA-256) is computed on libuv's thread pool, so a burst of sign-in or
  forgot-password requests no longer stalls every other request in the process.
  The output is unchanged; existing hashes verify.
- **A write without a length is refused.** The per-route body ceilings are read
  from `Content-Length` before a handler buffers anything, so an `/api` write
  that carries `Transfer-Encoding` and no `Content-Length` gets `411`. Browsers
  always send the length. nginx with its default `proxy_request_buffering on`
  (the shipped config) buffers a chunked client body and re-sends it with
  `Content-Length`. **Caddy streams request bodies by default**, so a streaming
  API client behind Caddy is refused; buffer in the client, or at the proxy
  (`request_buffers` in `reverse_proxy` — check on your Caddy version that it
  re-sends the length).
- **`CORS_ORIGINS=*` widens who may embed your checkout.** Credentials are
  never allowed cross-origin, so no data is exposed, but cookie-less checkout,
  payment-start, contact and newsletter posts are accepted from any site's
  pages. The server warns at startup and the deep health check reports
  `cors_origins: warn`. `Origin` is set by browsers and is **not** a boundary
  against non-browser clients; those are bounded by the rate limits and input
  validation, not by the allow-list.
- **The CSRF cookie is set on HTML pages only** (and on a JSON sign-in), never
  on `/api` responses or non-HTML files, so public API responses carry no
  `Set-Cookie` and can be cached by a CDN.
- **Maintenance mode leaves payment webhooks open.** A provider confirming a
  payment made just before the window is answered by the handler (which still
  verifies the signature), not by a `503`.
- **Background work runs in one process per database.** The scheduler (email
  sends, order cancellation, off-site backups) and the schema migrations take a
  lease first (`leases` table on libSQL, a lock file beside a lowdb database).
  `SCHEDULER_LEASE=0` removes that guard and must only be used with a single
  process. Lease files and rows hold a hostname and a pid, nothing else.
- **CSP is hash-based (no `'unsafe-inline'` for scripts).** The production build
  emits a Content-Security-Policy response header via Astro's built-in CSP:
  `script-src 'self'` plus the SHA-256 hash of every bundled script (including
  Astro's own island-hydration scripts) — `'unsafe-inline'` is gone, closing the
  main inline-XSS foothold. The app authors no inline styles either (theme tokens
  are served from `/theme.css`; other dynamic styling uses CSSOM), so `style-src`
  is hash-based too. CSP source allow-lists (e.g. a CDN for 3D assets) are now
  **build-time** env knobs read by `astro.config.ts` (`CSP_IMG_SRC`,
  `CSP_SCRIPT_SRC`, `CSP_ALLOW_WASM`, …; see `src/lib/csp-config.ts`) — set them
  before `npm run build`. Note: the CSP header is emitted by the **build**, so
  `astro dev` does not send it; test CSP against the built server.
- **SVG uploads are sanitized, not refused.** SVG is the one image format that
  is also a program, so it is handled apart from the raster pipeline: it never
  goes near sharp, and what was uploaded is never what is stored. The file is
  parsed and rebuilt through an allow-list (`src/lib/media/svg-sanitize.ts`, the
  same `sanitize-html` engine that guards rich text, in XML mode), so only
  known-inert elements and attributes survive re-serialization. `<script>` and
  event handlers are not on the list; neither are `<foreignObject>` (HTML
  smuggling), `<image>` and `feImage` (external fetch), `<animate>`/`<set>`
  (they can rewrite an attribute after sanitization) or `<a>`. `href` and
  `xlink:href` are dropped unless they point at a `#fragment` in the same
  document, which takes out external references, `javascript:` and SSRF in one
  rule; the same test is applied to any attribute carrying a `url(...)`.
  CSS is scrubbed of `url()`, `@import`, `expression(` and `-moz-binding` in
  both `<style>` text and `style=""` attributes, **after** CSS escape sequences
  are decoded, so `\75 rl(...)` is caught with `url(...)`. The parser does no
  DTD processing, so custom entities never expand and the DOCTYPE is dropped.
  Only the sanitized bytes are written to disk (and the file is
  content-addressed by them), so a hostile original never sits at a guessable
  URL, and an SVG that does not survive as a usable document is refused rather
  than stored. On serve, `src/pages/uploads/[...path].ts` adds a per-file
  `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'` —
  defence in depth for the address-bar case, not the defence.
  `tests/svg-sanitize.test.mjs` pins the vectors.
- **Webhook SSRF guard is name/literal-based, not DNS-resolving.** Registering
  a webhook target that resolves to a private IP is refused when the URL *names*
  an internal host (localhost, RFC-1918, link-local/cloud-metadata `169.254.169.254`,
  IPv6 ULA/loopback, CGNAT). It does **not** resolve DNS, so a public hostname
  that resolves to a private address (DNS rebinding) is out of scope; set
  `WEBHOOK_ALLOW_PRIVATE=1` to disable the guard for trusted internal use.
- **Backup export/import is lowdb-only.** On the libSQL/Turso drivers the
  built-in JSON backup endpoints refuse to run (they'd read/write the wrong
  store); back up the database with your DB tooling instead.
- **Settings are public only by explicit opt-in.** `GET /api/settings/get` is an
  unauthenticated endpoint (decoupled storefronts read the site title from it),
  but settings are a *schemaless* key/value bucket — `POST /api/settings/update`
  accepts any identifier-shaped key. It therefore returns an **allow-list**, not
  the table: core presentation keys plus anything named `public_*`.

  **Credential-shaped keys are withheld from every role, staff included.** A key
  whose name matches `password`, `secret`, `token`, `api_key`, `private_key` and
  similar is never returned as a value — only as `<key>__is_set: true`, so the
  admin can manage a credential it can never read back. `publishable` and
  `public_key` are exempt, because a Stripe publishable key is meant to be
  public and withholding it would break checkout.

  This is deliberately a rule about the *shape of the name* rather than a list
  of known keys: a list is something someone must remember to update, and its
  failure mode is silent disclosure. An unreviewed plugin's `foo_api_key` is
  withheld by default.

  (This endpoint once returned the whole table to anonymous callers, and later
  still returned credentials to any staff session — an `editor` could read
  `smtp_password`. Both are fixed, and the smoke suite asserts on all three
  storage drivers that a non-public key is invisible anonymously and that a
  credential-shaped key is withheld even from an admin.)
- **Known dependency advisories.** Most open `npm audit` findings are in the
  **Astro build/dev toolchain** — `vite`, `esbuild`, `postcss`, `js-yaml`, `svgo`
  — pulled in transitively by `astro`. Those are scoped to the dev server, the
  build step, or `astro check`, and several are Windows-only; the built
  `dist/server/entry.mjs` does not run Vite or esbuild. They surface under
  `npm audit --omit=dev` only because Astro declares Vite as a runtime dependency.

  **Not everything is build-only, and we do not claim otherwise.** Three
  categories need judgement, and we re-check them on every dependency bump:

  1. **`sharp` (image decoding) IS runtime-reachable.** `POST /api/media/upload`
     feeds uploaded bytes to sharp/libvips to re-encode images, so a decoder CVE
     is reachable by any account with a content-producing role. We therefore
     track sharp directly and keep it patched — currently **sharp 0.35.4 /
     libvips 8.18.6**, which is past the GHSA-f88m-g3jw-g9cj libvips CVEs.
     Uploads are additionally magic-byte sniffed before decoding and decoded
     with `failOn: 'truncated'` and a pixel ceiling. SVG never reaches sharp at
     all — see the SVG bullet above. Astro bundles its *own*
     nested sharp for `astro:assets`; we do not use `astro:assets`, so that copy
     is not on a request path.
  2. **`sanitize-html` IS runtime-reachable.** It sanitizes every stored HTML
     field — post bodies, product descriptions, imported WordPress/WooCommerce
     content — so a bypass there is stored XSS. GHSA-vccv-cmxp-4j9h (`javascript:`
     URIs surviving in `action`, `formaction`, `data`, `poster`, `background`)
     affected `<=2.17.4`; we run **2.17.7**. The bypass was never reachable with
     our configuration anyway — the allow-list permits none of those attributes,
     and none of the tags that carry them — and `tests/sanitize.test.mjs` now
     pins the advisory's own vectors so widening the allow-list fails loudly.
     Note the hash-based CSP is a third layer: with no `'unsafe-inline'` in
     `script-src`, a surviving `javascript:` URI would not execute.
  3. **Astro's own XSS advisories** (View Transitions, `transition:*` directives,
     spread attributes in `renderHTMLElement`) are render-path issues, not
     build-only. They do not apply here because the codebase uses none of those
     features — verified by grep, not assumed. If you add View Transitions or
     spread attributes to a fork, re-evaluate and upgrade Astro first.

  Advisory counts shift as the registry publishes new CVEs; re-run
  `npm audit --omit=dev` and check whether anything new sits on a request path.

## What is *not* a vulnerability

- Using the development seed credentials (`admin@local` / `admin`) on a
  **development** install. Zero-config local dev is the point of the lowdb
  driver.

  This is no longer merely "warned about" in production: with
  `NODE_ENV=production`, a fresh install generates a random admin password
  instead of seeding the known one, and login *refuses* the seeded password
  outright. Once this repo is public, `admin` is not a default — it is a
  published credential.
- Exposing `/admin` without auth in a development environment with
  `AUTH_SECRET` unset. Set `NODE_ENV=production` to make `AUTH_SECRET`
  mandatory at startup.
- Bypassing CSRF using a browser extension or with the user's explicit
  cooperation. CSRF protections defend against cross-origin attackers, not
  same-origin tooling.

## Who can read what

Authorization is enforced in middleware and route handlers over a storage layer
that is **identity-blind**: `getPosts()` takes no caller, and the relational
driver runs `SELECT data FROM posts` with no predicate. That is a deliberate
design for a single-tenant CMS, and it has one failure mode worth stating
plainly: where database-enforced row-level security makes a forgotten check
return *nothing*, this design makes a forgotten check return *everything*.

**AstroBaaS does not implement row-level security**, and no document here should
be read as claiming it does. What it has instead is one module,
`src/lib/visibility.ts`, that decides content visibility, so the rule is written
once and reviewed once:

| role | published | own drafts | others' drafts |
|---|---|---|---|
| anonymous / `viewer` | yes | — | no |
| `author` | yes | yes | **no** |
| `editor` / `admin` | yes | yes | yes |

Deny-by-default: an unrecognised role sees published content only, so a role
added to the union without being considered here *loses* access rather than
gaining it. A record you may not see returns **404, not 403** — distinguishing
"exists but forbidden" from "does not exist" confirms the slug, which is what
withholding it is for.

Applied at: `GET /api/posts`, `GET /api/posts/{ref}`, `/og/{slug}.png`,
`/admin/posts`, `/admin/posts/{id}/edit`. Snapshot bodies in
`GET /api/content/changes` are restricted to the editorial roles for the same
reason.

If you are deploying multi-tenant — several unrelated businesses on one
instance — **this is not the isolation you want.** Run separate instances.

## Hardening checklist for operators

Before exposing AstroBaaS to the public internet:

- [ ] Generated a strong `AUTH_SECRET` (`openssl rand -hex 32`).
- [ ] Set `ADMIN_PASSWORD` before first boot, or captured the random password
      printed once to stdout. With `NODE_ENV=production` and no
      `ADMIN_PASSWORD`, AstroBaaS generates one rather than seeding the
      well-known `admin` — because in a public repo a default credential is a
      *published* credential. Login also **refuses** the seeded password in
      production (`SEED_PASSWORD_REFUSED`); `ALLOW_SEED_PASSWORD=1` overrides it
      for a trusted private deployment.
- [ ] Enabled two-factor auth on admin accounts (Profile → Two-factor).
- [ ] Set `NODE_ENV=production`.
- [ ] Set `HSTS_MAX_AGE` once TLS is genuinely in front of every request
      (`HSTS_INCLUDE_SUBDOMAINS=1`, `HSTS_PRELOAD=1` optional). It is **off by
      default on purpose**: sent from a host that is not fully HTTPS it locks
      visitors out for the whole max-age with no client-side undo, and a
      self-hoster mid-migration must not be bricked by a CMS being helpful.
- [ ] Set `RATE_LIMIT_STORE=libsql` if running more than one replica.
- [ ] Put it behind HTTPS via a reverse proxy.
- [ ] Mounted `db.json` and `public/uploads/` to persistent volumes that are
      backed up off-host.
- [ ] Set `TRUST_PROXY=1` if (and only if) you're behind a proxy you control.
- [ ] Listed your storefront origins in `CORS_ORIGINS` rather than `*`
      (`GET /api/health/deep` warns about the wildcard).
- [ ] Marked `forward_client_ip` only on API keys that live on a server.
- [ ] Reviewed the Content-Security-Policy (`src/lib/csp-config.ts`, emitted by
      Astro at build) and added any CDN/asset origins your frontend needs via the
      `CSP_*` build-time env vars.
