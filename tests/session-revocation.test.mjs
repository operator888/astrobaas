#!/usr/bin/env node
/**
 * Signing out revokes the token (S3.11), and a key's forwarding flag survives
 * storage (S3.6) — on every driver.
 *
 * ## The choice, and why
 *
 * Signing out used to clear the cookie and nothing else, so a copied token was
 * good for its remaining 24 hours. Two fixes were possible:
 *
 *   - bump `session_version`: durable, but signs the person out on EVERY
 *     device — and, while an admin is acting as a colleague, throws the real
 *     colleague out of all their sessions too;
 *   - give each token an id and remember the ids that were signed out.
 *
 * The second is what shipped. A user is one JSON document on all three
 * drivers, and the middleware already loads it on every request, so the list
 * costs no extra read and holds across restarts and replicas. Tokens minted
 * before ids existed have none; for those — for the one day it takes them to
 * expire — signing out falls back to the version bump.
 *
 * The parent runs pure checks, then one child per driver for the round trip.
 *
 * Run with:  node tests/session-revocation.test.mjs
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTs, readRepo, ROOT } from './lib/load.mjs';

process.env.AUTH_SECRET = 'session-revocation-test-secret-0123456789';

/* ------------------------------------------------------------------ *
 * The child: one driver, one database.
 * ------------------------------------------------------------------ */
if (process.env.SESSION_REVOCATION_CHILD) {
  const { LocalDB } = await loadTs('src/lib/localdb.ts', 'srdb');
  const A = await loadTs('src/lib/auth.ts', 'srauth');
  await LocalDB.init();

  const created = await LocalDB.createUser({
    name: 'Bob', email: 'bob@example.com', role: 'editor', status: 'active',
    password_hash: 'x', password_salt: 'y', posts_count: 0,
  });
  const token = A.signSession({ uid: created.id, role: 'editor', sv: 0 });
  const other = A.signSession({ uid: created.id, role: 'editor', sv: 0 });
  const payload = A.verifySession(token);
  const otherPayload = A.verifySession(other);

  const before = await LocalDB.getUser(created.id);
  await LocalDB.updateUser(created.id, A.revocationPatch(before, payload));
  // Read out at once, for the same live-object reason as the keys below.
  const after = structuredClone(await LocalDB.getUser(created.id));
  // An unrelated write afterwards must not drop the list (patch semantics).
  // The list is cleared in memory first, so only a real re-read can pass.
  await LocalDB.updateUser(created.id, { name: 'Bob B.' });
  const later = structuredClone(await LocalDB.getUser(created.id));

  const key = await LocalDB.createApiKey({
    name: 'bff', prefix: 'abk_x', key_hash: crypto.randomBytes(8).toString('hex'), role: 'editor', forward_client_ip: true,
  });
  const plain = await LocalDB.createApiKey({
    name: 'plain', prefix: 'abk_y', key_hash: crypto.randomBytes(8).toString('hex'), role: 'editor',
  });
  // Values are read out IMMEDIATELY: lowdb hands back live objects, so a
  // record captured before the next update would show that update's value.
  const keyFlag = (await LocalDB.findApiKeyByHash(key.key_hash))?.forward_client_ip;
  await LocalDB.updateApiKey(plain.id, { forward_client_ip: true });
  const toggledOn = (await LocalDB.getApiKeys()).find((k) => k.id === plain.id)?.forward_client_ip;
  await LocalDB.updateApiKey(plain.id, { forward_client_ip: false });
  const toggledOff = (await LocalDB.getApiKeys()).find((k) => k.id === plain.id)?.forward_client_ip;

  console.log(JSON.stringify({
    revokedAfterWrite: A.isSessionRevoked(after, payload),
    otherStillValid: !A.isSessionRevoked(after, otherPayload),
    survivesUnrelatedWrite: A.isSessionRevoked(later, payload),
    svUnchanged: (later.session_version ?? 0) === 0,
    publicHidesList: !('revoked_sessions' in A.toPublicUser(later)),
    keyFlag,
    toggledOn,
    toggledOff,
  }));
  process.exit(0);
}

/* ------------------------------------------------------------------ *
 * The parent.
 * ------------------------------------------------------------------ */
let pass = 0;
let fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };
const code = (src) => src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

const A = await loadTs('src/lib/auth.ts');

/* ---------------------------------------------- tokens carry an id */
{
  const t1 = A.verifySession(A.signSession({ uid: 'u1', role: 'admin' }));
  const t2 = A.verifySession(A.signSession({ uid: 'u1', role: 'admin' }));
  check('a new session token carries an id', typeof t1?.jti === 'string' && t1.jti.length >= 16);
  check('...a different one per sign-in', t1.jti !== t2.jti);

  // A token minted BEFORE ids existed: same secret, no jti. It must keep
  // working, or every live shop's staff are signed out by the deploy.
  const body = Buffer.from(JSON.stringify({ uid: 'u1', role: 'admin', sv: 0, iat: Date.now(), exp: Date.now() + 60_000 })).toString('base64url');
  const sig = crypto.createHmac('sha256', process.env.AUTH_SECRET).update(body).digest('base64url');
  const legacy = A.verifySession(`${body}.${sig}`);
  check('a legacy token with no id still verifies', legacy?.uid === 'u1' && legacy.jti === undefined);
  check('...and is not "revoked" by an unrelated list', !A.isSessionRevoked({ revoked_sessions: [{ jti: 'x', exp: Date.now() + 1000 }] }, legacy));
}

/* ---------------------------------------------- the patch */
{
  const now = Date.now();
  const p = { jti: 'tok-1', exp: now + 60_000 };
  const first = A.revocationPatch({}, p, now);
  check('signing out notes the token', JSON.stringify(first.revoked_sessions) === JSON.stringify([{ jti: 'tok-1', exp: now + 60_000 }]));
  check('...and does NOT sign the person out elsewhere', first.session_version === undefined);
  check('the noted token is revoked', A.isSessionRevoked(first, p));
  check('...and a sibling token is not', !A.isSessionRevoked(first, { jti: 'tok-2' }));

  const again = A.revocationPatch(first, p, now);
  check('signing out twice does not duplicate the note', again.revoked_sessions.length === 1);

  const pruned = A.revocationPatch({ revoked_sessions: [{ jti: 'old', exp: now - 1 }, { jti: 'live', exp: now + 5 }] }, p, now);
  check('expired notes are pruned on the next write',
    JSON.stringify(pruned.revoked_sessions.map((r) => r.jti)) === JSON.stringify(['live', 'tok-1']));
  const junk = A.revocationPatch({ revoked_sessions: [null, { jti: 5, exp: now + 5 }, { jti: 'ok', exp: 'soon' }] }, p, now);
  check('malformed notes are dropped, not trusted', junk.revoked_sessions.length === 1);

  // Fallbacks: toward MORE revocation, never less.
  const legacy = A.revocationPatch({ session_version: 3, revoked_sessions: [{ jti: 'k', exp: now + 5 }] }, { exp: now + 5 }, now);
  check('a legacy token (no id) falls back to signing out everywhere',
    legacy.session_version === 4 && legacy.revoked_sessions.length === 0);
  const full = Array.from({ length: A.MAX_REVOKED_SESSIONS }, (_, i) => ({ jti: `j${i}`, exp: now + 60_000 }));
  const overflow = A.revocationPatch({ session_version: 1, revoked_sessions: full }, p, now);
  check('a full list falls back to signing out everywhere', overflow.session_version === 2 && overflow.revoked_sessions.length === 0);
  check('the list is bounded at fifty', A.MAX_REVOKED_SESSIONS === 50);
}

/* ---------------------------------------------- the wiring */
{
  const mw = code(await readRepo('src/middleware.ts'));
  check('the middleware refuses a revoked token',
    /\(dbUser\.session_version \?\? 0\) === session\.sv &&\s*\n?\s*!isSessionRevoked\(dbUser, session\)/.test(mw));
  const out = code(await readRepo('src/pages/api/auth/logout.ts'));
  // Each handler's own body, so a match cannot run on into the other one.
  const postBody = out.slice(out.indexOf('export const POST'), out.indexOf('export const GET'));
  const getBody = out.slice(out.indexOf('export const GET'));
  check('POST logout revokes before clearing',
    /await revokePresented\(cookies\.get\(SESSION_COOKIE\)\?\.value\)[\s\S]*?clearBoth\(\)/.test(postBody));
  check('GET logout revokes too',
    /await revokePresented\(cookies\.get\(SESSION_COOKIE\)\?\.value\)[\s\S]*?clearBoth\(\)/.test(getBody));
  check('the revocation is read back, and a lost one becomes a version bump',
    /const after = await LocalDB\.getUser\(user\.id\)/.test(out)
    && /!isSessionRevoked\(after, payload\)[\s\S]*?session_version: \(after\.session_version \?\? 0\) \+ 1/.test(out));
  check('a storage error never keeps the cookie alive', /catch \(err\) \{\s*console\.error\('Logout revocation error/.test(out));
  check('the list never leaves the server', /revoked_sessions, \.\.\.rest/.test(code(await readRepo('src/lib/auth.ts'))));
}

/* ---------------------------------------------- the drivers */
const tmpRoot = path.join(os.tmpdir(), `astrobaas-session-rev-${process.pid}`);
await fs.mkdir(tmpRoot, { recursive: true });
const DRIVERS = [
  { name: 'lowdb', env: (dir) => ({ DB_PATH: path.join(dir, 'db.json') }) },
  { name: 'libsql', env: (dir) => ({ DATABASE_URL: `file:${path.join(dir, 'db.sqlite')}` }) },
  { name: 'relational', env: (dir) => ({ DATABASE_URL: `file:${path.join(dir, 'db.sqlite')}`, DATABASE_DRIVER: 'relational' }) },
];
for (const driver of DRIVERS) {
  const dir = path.join(tmpRoot, driver.name);
  await fs.mkdir(path.join(dir, 'uploads'), { recursive: true });
  const env = { ...process.env, SESSION_REVOCATION_CHILD: '1', UPLOADS_DIR: path.join(dir, 'uploads'), NODE_ENV: 'test', ...driver.env(dir) };
  if (driver.name === 'lowdb') { delete env.DATABASE_URL; delete env.DATABASE_DRIVER; }
  const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    cwd: ROOT, encoding: 'utf8', env, maxBuffer: 16 * 1024 * 1024,
  });
  const line = (run.stdout ?? '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
  if (!line) {
    fail++;
    console.error(`✗ [${driver.name}] the child produced no result`);
    console.error((run.stderr ?? '').split('\n').slice(-15).join('\n'));
    continue;
  }
  const r = JSON.parse(line);
  const t = (n, c) => check(`[${driver.name}] ${n}`, c);
  t('a signed-out token is revoked after the write', r.revokedAfterWrite === true);
  t('...the same person\'s other token is not', r.otherStillValid === true);
  t('...the note survives an unrelated update', r.survivesUnrelatedWrite === true);
  t('...and nobody was signed out everywhere', r.svUnchanged === true);
  t('the list is stripped from the public user', r.publicHidesList === true);
  t('an API key keeps forward_client_ip through storage', r.keyFlag === true);
  t('...can be switched on in place', r.toggledOn === true);
  t('...and off again', r.toggledOff === false);
}
await fs.rm(tmpRoot, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
