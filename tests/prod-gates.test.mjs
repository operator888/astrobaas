/**
 * Security gates that only exist on a PRODUCTION BUILD.
 *
 * ## Why this file exists rather than a case in another suite
 *
 * Two gates key on `isProductionRuntime()` (src/lib/auth.ts), which is true for
 * `astro build` output and false under `astro dev`:
 *
 *   1. `makeSeedAdmin()` refuses to seed the published default password and
 *      generates a random one instead.
 *   2. `POST /api/auth/login` refuses the published default even when that IS
 *      the stored password — which protects installs that seeded `admin`
 *      before this rule existed.
 *
 * Neither can be asserted anywhere else:
 *
 *   - `tests/smoke.mjs` drives `astro dev`, where both gates are deliberately
 *     off, so a fresh install is usable without ceremony.
 *   - `tests/e2e` drives a built server, but ONE server shared by every test.
 *     Gate 2 only fires when the account's password IS `admin`, so asserting it
 *     there would mean seeding `admin` — and then no other test could log in.
 *
 * Each case below therefore boots its own short-lived server with its own
 * database, which is the only way to observe a BOOT-TIME decision.
 *
 * Requires `dist/` — run after `astro build` (npm run e2e does this).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = path.join(REPO, 'dist/server/entry.mjs');

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`✓ ${name}`);
  } else {
    failed++;
    console.error(`✗ ${name}${detail ? `: ${detail}` : ''}`);
  }
}

if (!existsSync(ENTRY)) {
  console.error(
    `\nCannot run: ${ENTRY} does not exist.\n` +
    'These gates only exist on a built artefact. Run `npm run build` first ' +
    '(npm run e2e does it for you).\n',
  );
  process.exit(2);
}

let port = 41960;

/**
 * Boot the built server on a fresh database, run `fn`, then kill it.
 * Returns whatever `fn` returns, plus everything the server printed.
 */
async function withServer(env, fn) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'abprod-'));
  const p = ++port;
  const base = `http://127.0.0.1:${p}`;
  const proc = spawn('node', [ENTRY], {
    cwd: REPO,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(p),
      AUTH_SECRET: 'prod-gates-secret-at-least-32-characters',
      DB_PATH: path.join(tmp, 'db.json'),
      UPLOADS_DIR: path.join(tmp, 'uploads'),
      RATE_LIMIT_PER_MIN: '100000',
      // Inherited NODE_ENV must not decide anything here — the point of the
      // change under test is that the BUILD decides, not the environment.
      NODE_ENV: '',
      ADMIN_PASSWORD: '',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let out = '';
  proc.stdout.on('data', (c) => (out += c));
  proc.stderr.on('data', (c) => (out += c));

  const kill = () => { try { process.kill(-proc.pid, 'SIGKILL'); } catch { /* already gone */ } };
  try {
    let up = false;
    for (let i = 0; i < 150; i++) {
      try { await fetch(`${base}/`, { redirect: 'manual' }); up = true; break; } catch { /* not yet */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!up) throw new Error(`server never came up:\n${out}`);
    // The seed banner is printed during first-boot seeding, which happens on
    // the first request that touches the database.
    await fetch(`${base}/login`);
    const result = await fn(base);
    return { ...result, out };
  } finally {
    kill();
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

const login = (base, password) =>
  fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@local', password }),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

// --- Gate 1: no ADMIN_PASSWORD on a production build → generated, not 'admin' ---
{
  const { seedAdmin, out } = await withServer({}, async (base) => ({
    seedAdmin: await login(base, 'admin'),
  }));

  check(
    'a built server does NOT seed the published default password',
    seedAdmin.status !== 200,
    `login with "admin" returned ${seedAdmin.status}; it must not succeed`,
  );
  check(
    'the generated password is printed once, on first boot',
    /generated an admin password/i.test(out),
    'expected the first-boot banner in server output',
  );
  check(
    'the generated password is not the seed string',
    !/\badmin\b\s*$/m.test(out.split('generated an admin password')[1] ?? ''),
    'banner appears to contain the literal seed password',
  );
}

// --- Gate 2: an install that ALREADY has the seed password is refused login ---
//
// This is the case that protects existing deployments: changing what gets
// seeded cannot help someone who seeded 'admin' months ago, so /login refuses
// it outright. Reproduced by explicitly seeding 'admin' via ADMIN_PASSWORD.
{
  const { asSeed, asReal } = await withServer({ ADMIN_PASSWORD: 'admin' }, async (base) => ({
    asSeed: await login(base, 'admin'),
    asReal: await login(base, 'definitely-not-the-seed-password'),
  }));

  check(
    'login with the published default is refused with 403',
    asSeed.status === 403,
    `got ${asSeed.status}`,
  );
  check(
    'the refusal names itself so an operator can act on it',
    asSeed.body?.error?.code === 'SEED_PASSWORD_REFUSED',
    `got code=${asSeed.body?.error?.code}`,
  );
  check(
    'the refusal is specific: a merely wrong password is still 401, not 403',
    asReal.status === 401,
    `got ${asReal.status}`,
  );
}

// --- The escape hatch still works for a trusted private deployment ---
{
  const { asSeed } = await withServer(
    { ADMIN_PASSWORD: 'admin', ALLOW_SEED_PASSWORD: '1' },
    async (base) => ({ asSeed: await login(base, 'admin') }),
  );
  check(
    'ALLOW_SEED_PASSWORD=1 re-permits the default for a private deployment',
    asSeed.status === 200,
    `got ${asSeed.status}`,
  );
}

// --- Gate 3: a PUBLISHED AUTH_SECRET is refused like a missing one ---
//
// `.env.example` ships a placeholder long enough to pass the length check, and
// sessions are stateless HMAC tokens: an install that copied the file without
// editing it would sign its admin cookies with a key printed on GitHub. The
// placeholder is read from the file itself, so changing it there without
// changing auth.ts's list fails here.
{
  const example = await fs.readFile(path.join(REPO, '.env.example'), 'utf8');
  const placeholder = example.match(/^AUTH_SECRET=(.+)$/m)?.[1]?.trim();
  check('.env.example still ships an AUTH_SECRET placeholder', !!placeholder && placeholder.length >= 16,
    `found ${JSON.stringify(placeholder)}`);

  for (const [label, secret] of [
    ['the .env.example placeholder', placeholder],
    ['the dev-only fallback', 'dev-only-insecure-secret-change-me'],
  ]) {
    const { asOwner, errorPage, out } = await withServer(
      { AUTH_SECRET: secret, ADMIN_PASSWORD: 'a-real-password-for-this-test' },
      async (base) => ({
        asOwner: await login(base, 'a-real-password-for-this-test'),
        // /login needs a CSRF cookie, so a refused secret is a real 500 —
        // rendered by 500.astro on a server with no NODE_ENV (withServer
        // blanks it), which is exactly the systemd/PM2 shape.
        errorPage: await fetch(`${base}/login`).then(async (r) => ({ status: r.status, html: await r.text() })),
      }),
    );
    check(
      `a built server refuses to sign sessions with ${label}`,
      asOwner.status !== 200 && asOwner.status !== 303,
      `the correct password signed in (${asOwner.status}) with a public AUTH_SECRET`,
    );
    check(
      `${label} is reported at startup, naming the fix`,
      /AUTH_SECRET is the placeholder from \.env\.example/.test(out),
      'expected the startup error in server output',
    );
    check(
      `the public 500 page shows no error details without NODE_ENV (${label})`,
      errorPage.status === 500 && !/Error details|AUTH_SECRET|at \S+ \(/.test(errorPage.html),
      `status ${errorPage.status}; the page leaked the error text or a stack`,
    );
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
