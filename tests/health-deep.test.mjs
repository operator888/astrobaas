#!/usr/bin/env node
/**
 * The deep health check, exercised against installs that are actually BROKEN.
 *
 * The smoke suite can only prove the endpoint answers 200 on a healthy server.
 * That is the half that does not matter: a health check whose failure path is
 * never exercised is a health check nobody has tested, and this one exists
 * BECAUSE every production problem last month looked healthy from outside.
 *
 * So each case here boots a server with one thing genuinely wrong — an
 * unwritable uploads directory, a plugin that cannot be imported — and asserts
 * the endpoint answers 503 and names the reason.
 *
 * Run with:  node tests/health-deep.test.mjs
 * (Part of `npm run e2e`; it boots several servers and takes about a minute.)
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n) => { console.log(`✓ ${n}`); pass++; };
const bad = (n, m) => { console.error(`✗ ${n}: ${m}`); fail++; };

const TOKEN = 'health-token-for-this-test-only-32chars';

/**
 * A port that is free right now. The four servers used to sit on fixed
 * ports 4341–4344: with anything else on the machine holding one (another
 * checkout's dev server, a stray http.server), Vite silently moved to the next
 * port, this polled the old one for a minute, failed "server never started" —
 * and left the servers it had started running (2026-09-24).
 */
const canBind = (port) => new Promise((resolve) => {
  const srv = net.createServer();
  srv.once('error', () => resolve(false));
  srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
});
// Below the OS's ephemeral range (49152+ on macOS, 32768+ on Linux): a port
// the OS hands out for "any free port" is also one it may give the server's
// own outgoing connections a moment later — which is exactly what happened.
async function freePort() {
  for (let i = 0; i < 50; i++) {
    const port = 20000 + Math.floor(Math.random() * 12000);
    if (await canBind(port)) return port;
  }
  throw new Error('no free port found in 20000–31999');
}

async function boot(port, env) {
  const p = spawn('npx', ['astro', 'dev', '--port', String(port), '--host', '127.0.0.1', '--ignore-lock'], {
    env: { ...process.env, AUTH_SECRET: 'health-fail-secret-abcdefghijkl', HEALTH_TOKEN: TOKEN,
           ASTRO_DEV_BACKGROUND: '0', RATE_LIMIT_PER_MIN: '100000', ...env },
    stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  });
  let log = '';
  p.stdout.on('data', (c) => (log += c)); p.stderr.on('data', (c) => (log += c));
  const stop = () => { try { process.kill(-p.pid, 'SIGTERM'); } catch { /* gone */ } };
  for (let i = 0; i < 120; i++) {
    // Taken between freePort() and the bind: say so now, not after a minute
    // of polling a port nobody is listening on.
    if (/Port \d+ is in use/.test(log)) { stop(); throw new Error(`port ${port} was taken before the server bound it\n${log}`); }
    try { const r = await fetch(`http://127.0.0.1:${port}/login`); if (r.ok) return { p, log: () => log }; }
    catch { /* not yet */ }
    await wait(500);
  }
  stop(); // a server that never answered must not outlive the test
  throw new Error('server never started\n' + log);
}
const kill = (s) => { try { process.kill(-s.p.pid, 'SIGTERM'); } catch { /* gone */ } };
const get = (port, q = '') =>
  fetch(`http://127.0.0.1:${port}/api/health/deep${q}`, { headers: { Authorization: `Bearer ${TOKEN}` } });

/* --- 1. A HEALTHY install answers 200 and the token works without a session --- */
{
  const db = path.join(os.tmpdir(), `hf-ok-${process.pid}.json`);
  const up = path.join(os.tmpdir(), `hf-ok-up-${process.pid}`);
  await fs.rm(db, { force: true });
  const port1 = await freePort();
  const s = await boot(port1, { DB_PATH: db, UPLOADS_DIR: up });
  const r = await get(port1);
  const j = await r.json();
  if (r.status === 200 && j.ok === true) ok('a healthy install answers 200 to a bearer token, with no session');
  else bad('healthy 200', `status=${r.status} failed=${JSON.stringify(j.failed)}`);
  if (j.status === 'warn' && j.warnings.includes('public_site_url'))
    ok('...and still WARNS that public_site_url is unset');
  else bad('unset warning', JSON.stringify({ status: j.status, warnings: j.warnings }));
  kill(s); await wait(1200);
  await fs.rm(db, { force: true }); await fs.rm(up, { recursive: true, force: true });
}

/* --- 2. An UNWRITABLE uploads directory must be a 503 --- */
{
  const db = path.join(os.tmpdir(), `hf-ro-${process.pid}.json`);
  const up = path.join(os.tmpdir(), `hf-ro-up-${process.pid}`);
  await fs.rm(db, { force: true });
  await fs.mkdir(up, { recursive: true });
  await fs.chmod(up, 0o500); // r-x, not writable
  const port2 = await freePort();
  const s = await boot(port2, { DB_PATH: db, UPLOADS_DIR: up });
  const r = await get(port2);
  const j = await r.json();
  if (r.status === 503) ok('an unwritable uploads directory answers 503');
  else bad('unwritable 503', `status=${r.status} ${JSON.stringify(j.checks?.find((c) => c.name === 'uploads_writable'))}`);
  if (j.failed?.includes('uploads_writable')) ok('...and names uploads_writable as the reason');
  else bad('unwritable reason', JSON.stringify(j.failed));
  const c = j.checks?.find((x) => x.name === 'uploads_writable');
  if (c?.data?.uploads_dir === up) ok('...and reports which directory');
  else bad('uploads dir reported', JSON.stringify(c?.data));
  kill(s); await wait(1200);
  await fs.chmod(up, 0o700);
  await fs.rm(db, { force: true }); await fs.rm(up, { recursive: true, force: true });
}

/* --- 3. A plugin the operator asked for that cannot load must be a 503 --- */
{
  const db = path.join(os.tmpdir(), `hf-pl-${process.pid}.json`);
  const up = path.join(os.tmpdir(), `hf-pl-up-${process.pid}`);
  await fs.rm(db, { force: true });
  const port3 = await freePort();
  const s = await boot(port3, {
    DB_PATH: db, UPLOADS_DIR: up,
    ASTROBAAS_PLUGINS: './definitely-not-a-real-module.mjs',
  });
  const r = await get(port3);
  const j = await r.json();
  if (r.status === 503) ok('a plugin that will not load answers 503');
  else bad('plugin 503', `status=${r.status}`);
  const c = j.checks?.find((x) => x.name === 'plugins');
  if (c?.status === 'fail' && /definitely-not-a-real-module/.test(JSON.stringify(c)))
    ok('...and names the specifier that failed');
  else bad('plugin reason', JSON.stringify(c)?.slice(0, 250));
  kill(s); await wait(1200);
  await fs.rm(db, { force: true }); await fs.rm(up, { recursive: true, force: true });
}

/* --- 4. Configuring public_site_url clears the warning and reaches the API --- */
{
  const db = path.join(os.tmpdir(), `hf-cfg-${process.pid}.json`);
  const up = path.join(os.tmpdir(), `hf-cfg-up-${process.pid}`);
  await fs.rm(db, { force: true });
  const port4 = await freePort();
  const s = await boot(port4, { DB_PATH: db, UPLOADS_DIR: up });

  // Log in so a setting can be written.
  const login = await fetch(`http://127.0.0.1:${port4}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@local', password: 'admin' }),
  });
  const cookies = login.headers.getSetCookie?.() ?? [];
  const session = cookies.map((c) => c.split(';')[0]).find((c) => c.startsWith('astrobaas_session='));
  const csrf = cookies.map((c) => c.split(';')[0]).find((c) => c.startsWith('astrobaas_csrf='));
  const token = csrf ? decodeURIComponent(csrf.split('=')[1]) : '';

  await fetch(`http://127.0.0.1:${port4}/api/settings/update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: `${session}; ${csrf}`, 'X-CSRF-Token': token },
    body: JSON.stringify({
      public_site_url: 'https://cms.configured.test',
      // Commerce is opt-in, so a FRESH install 404s the whole shop surface —
      // including the anonymous /api/products call below, which is the one
      // this fixture uses to prove a storefront receives the configured media
      // base. Turn the shop on, because that is the install being described:
      // a decoupled storefront reading a catalogue. Without this the
      // assertion measured the master switch, not the media base.
      commerce_enabled: true,
    }),
  });

  const r = await get(port4, '?write=0');
  const j = await r.json();
  const c = j.checks?.find((x) => x.name === 'public_site_url');
  if (c?.status === 'ok' && c.data?.media_base === 'https://cms.configured.test')
    ok('a configured public_site_url is reported as the media base');
  else bad('configured base', JSON.stringify(c));

  // And an ANONYMOUS storefront request gets that base, not the request origin.
  const prods = await fetch(`http://127.0.0.1:${port4}/api/products?limit=1`);
  const pj = await prods.json();
  if (pj?.meta?.media_base === 'https://cms.configured.test')
    ok('...and an anonymous storefront call gets it, not the 127.0.0.1 it connected to');
  else bad('anonymous base', `status=${prods.status} meta=${JSON.stringify(pj?.meta)}`);

  kill(s); await wait(1200);
  await fs.rm(db, { force: true }); await fs.rm(up, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
