#!/usr/bin/env node
/**
 * Unit tests for pure library modules: validate.ts and auth.ts (password
 * hashing, session signing/verification, CSRF, cookie serialization). Both are
 * transpiled in-process with esbuild; auth.ts uses node:crypto (a builtin, so
 * the bare import resolves at runtime).
 *
 * Run with:  npm run test:lib
 */
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/*
 * A scratch database, because one assertion in here WRITES to it.
 *
 * `sendEmail` logs every send, so the transport test near the bottom appended
 * a row to whatever DB_PATH pointed at — unset, that is the developer's real
 * repo-root db.json. One row per run, silently, for as long as this file has
 * existed. It never failed a test, which is exactly why it survived: a leak
 * into someone else's data is invisible from inside the assertion that causes
 * it. Set before the module graph loads — getDbPath reads the env at call
 * time.
 */
process.env.DB_PATH = path.join(
  fsSync.mkdtempSync(path.join(os.tmpdir(), 'astrobaas-lib-test-')),
  'db.json',
);

const here = path.dirname(fileURLToPath(import.meta.url));
const cacheDir = path.join(here, '..', 'node_modules', '.cache');
await fs.mkdir(cacheDir, { recursive: true });

/**
 * Every module this file tests, built ONCE, with code splitting.
 *
 * Bundle (not just transpile) so a module that imports a sibling resolves. But
 * one esbuild call per module gave each bundle its own copy of everything it
 * imports — including LocalDB, its lowdb instance and its atomic writer. Five
 * copies wrote the same DB_PATH, each with its own `.db.json.tmp`, and when two
 * writes overlapped one rename moved the other's temp file away: ENOENT on
 * rename, intermittently, on the public CI's Node 22 job (2026-09-23).
 * Reproduced deterministically: two separately bundled LocalDB copies, 10
 * concurrent writes each, 20 rounds → 20 ENOENT; one shared copy → 0.
 *
 * One build with `splitting: true` puts shared code in shared chunks, so there
 * is exactly one LocalDB however many entry points reach it — and
 * `tests/lib.test.mjs` asserts that below, so a new separate build fails here
 * rather than flaking in CI. The two custom entries re-export several modules
 * that must share instances (a transport override and the notifier that uses it).
 */
const LIB = path.join(here, '..', 'src/lib');
const outDir = path.join(cacheDir, `astrobaas-lib-test-${process.pid}`);
const entrySrc = path.join(cacheDir, `astrobaas-lib-test-entries-${process.pid}`);
await fs.mkdir(entrySrc, { recursive: true });
const customEntries = {
  notify: [
    `export { notifySubmission, submitterReplyTo } from ${JSON.stringify(path.join(LIB, 'submission-notify.ts'))};`,
    `export { setEmailTransport } from ${JSON.stringify(path.join(LIB, 'email.ts'))};`,
    `export { LocalDB } from ${JSON.stringify(path.join(LIB, 'localdb.ts'))};`,
  ],
  'sched-mail': [
    `export { sweepStockWaitlist, sweepRecoveryReminders, maybeSendCampaign } from ${JSON.stringify(path.join(LIB, 'scheduler.ts'))};`,
    `export * as email from ${JSON.stringify(path.join(LIB, 'email.ts'))};`,
    `export { LocalDB } from ${JSON.stringify(path.join(LIB, 'localdb.ts'))};`,
    `export { WAITLIST_TYPE } from ${JSON.stringify(path.join(LIB, 'commerce/stock-waitlist.ts'))};`,
    `export { CAMPAIGN_TYPE } from ${JSON.stringify(path.join(LIB, 'newsletter-campaign.ts'))};`,
    `export { ABANDONMENT_KEYS } from ${JSON.stringify(path.join(LIB, 'commerce/abandonment.ts'))};`,
  ],
  // Not a module under test: the probe for "is there exactly one LocalDB".
  localdb: [`export { LocalDB } from ${JSON.stringify(path.join(LIB, 'localdb.ts'))};`],
};
const entryPoints = {};
for (const f of ['validate', 'auth', 'settings-visibility', 'text-search', 'escape-html', 'security-headers',
  'csp-config', 'webhook-util', 'api-key-scopes', 'url-guard', 'email', 'observability', 'scheduler-util', 'seed-data']) {
  entryPoints[`lib/${f}`] = path.join(LIB, `${f}.ts`);
}
for (const [name, lines] of Object.entries(customEntries)) {
  const file = path.join(entrySrc, `${name}.ts`);
  await fs.writeFile(file, lines.join('\n'));
  entryPoints[`entry/${name}`] = file;
}
await build({
  entryPoints, outdir: outDir, bundle: true, splitting: true, format: 'esm',
  platform: 'node', packages: 'external', logLevel: 'silent',
});
await fs.rm(entrySrc, { recursive: true, force: true });
// Chunks can be imported lazily (dynamic import inside a module), so the build
// stays until the process ends.
process.on('exit', () => fsSync.rmSync(outDir, { recursive: true, force: true }));

const importBuilt = (name) => import(pathToFileURL(path.join(outDir, `${name}.js`)).href);
async function fromBuild(rel) {
  const name = `lib/${path.basename(rel, '.ts')}`;
  if (!entryPoints[name]) throw new Error(`${rel} is not in the lib.test.mjs build — add it to entryPoints.`);
  return importBuilt(name);
}

const { validate, slugify } = await fromBuild('src/lib/validate.ts');
const auth = await fromBuild('src/lib/auth.ts');
const { visibleSettings, isPublicSetting, PUBLIC_SETTING_KEYS } = await fromBuild('src/lib/settings-visibility.ts');
const { foldForSearch, matchesSearch, transliterate } = await fromBuild('src/lib/text-search.ts');
const { escapeHtml } = await fromBuild('src/lib/escape-html.ts');
const { securityHeaders, corsAllowOrigin, corsHeaders } = await fromBuild('src/lib/security-headers.ts');
const { cspDirectives, cspScriptResources, cspStyleResources } = await fromBuild('src/lib/csp-config.ts');
const { webhookMatches, webhookBody, WEBHOOK_EVENTS } = await fromBuild('src/lib/webhook-util.ts');
const { isValidScope, apiKeyExpired, requiredScopeFor, scopeSatisfied, scopedKeyAllowed } = await fromBuild('src/lib/api-key-scopes.ts');
const { isPrivateHostname, checkWebhookUrl } = await fromBuild('src/lib/url-guard.ts');
const email = await fromBuild('src/lib/email.ts');
const obs = await fromBuild('src/lib/observability.ts');
const sched = await fromBuild('src/lib/scheduler-util.ts');

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) pass++;
  else {
    fail++;
    console.error(`✗ ${name}`);
  }
}

// ---------------- validate ----------------
{
  const schema = {
    title: { type: 'string', min: 1, max: 10 },
    age: { type: 'number', int: true, min: 0, optional: true },
    role: { type: 'enum', values: ['a', 'b'] },
    tags: { type: 'array', of: 'string', max: 2, optional: true },
    id: { type: 'id' },
  };
  const okRes = validate({ title: 'hi', role: 'a', id: 'x1', age: 3, tags: ['t'] }, schema);
  check('validate accepts a valid object', okRes.ok === true && okRes.value.age === 3);

  const missing = validate({ title: 'hi' }, schema);
  check('validate flags missing required fields', missing.ok === false && !!missing.errors.role && !!missing.errors.id);

  const tooLong = validate({ title: 'waytoolongtitle', role: 'a', id: 'x' }, schema);
  check('validate enforces max length', tooLong.ok === false && !!tooLong.errors.title);

  const badEnum = validate({ title: 'hi', role: 'z', id: 'x' }, schema);
  check('validate enforces enum', badEnum.ok === false && !!badEnum.errors.role);

  const badArr = validate({ title: 'hi', role: 'a', id: 'x', tags: ['a', 'b', 'c'] }, schema);
  check('validate enforces array max', badArr.ok === false && !!badArr.errors.tags);

  const notObj = validate('nope', schema);
  check('validate rejects non-objects', notObj.ok === false);

  const coerced = validate({ title: 'hi', role: 'a', id: 'x', age: '5' }, schema);
  check('validate coerces numeric strings', coerced.ok === true && coerced.value.age === 5);
}

// ---------------- slugify ----------------
check('slugify lowercases + dashes', slugify('Hello World!') === 'hello-world');
check('slugify strips leading/trailing dashes', slugify('  --Hi--  ') === 'hi');
check('slugify handles diacritics', slugify('Café Crème') === 'cafe-creme');

// ---------------- password hashing ----------------
{
  // Async since S3.8 — see tests/password-hash.test.mjs for the equivalence
  // with the old synchronous hash and the event-loop proof.
  const { hash, salt } = await auth.hashPassword('correct horse');
  check('hashPassword returns hash + salt', typeof hash === 'string' && typeof salt === 'string' && hash.length > 0);
  check('verifyPassword accepts the right password', (await auth.verifyPassword('correct horse', hash, salt)) === true);
  check('verifyPassword rejects the wrong password', (await auth.verifyPassword('wrong', hash, salt)) === false);
  const second = await auth.hashPassword('correct horse');
  check('hashPassword salts (same input → different hash)', second.hash !== hash);
}

// ---------------- sessions ----------------
{
  process.env.AUTH_SECRET = 'unit-test-secret-key-1234567890';
  const token = auth.signSession({ uid: 'u1', role: 'admin' });
  const payload = auth.verifySession(token);
  check('signSession/verifySession round-trips', payload && payload.uid === 'u1' && payload.role === 'admin');
  check('verifySession rejects tampered token', auth.verifySession(token.slice(0, -2) + 'xy') === null);
  check('verifySession rejects garbage', auth.verifySession('not-a-token') === null && auth.verifySession(undefined) === null);

  // Forged signature with a different secret must fail.
  const good = auth.signSession({ uid: 'u2', role: 'viewer' });
  const body = good.split('.')[0];
  check('verifySession rejects body with bad sig', auth.verifySession(`${body}.deadbeef`) === null);
}

// ---------------- CSRF ----------------
{
  const a = auth.newCsrfToken();
  check('newCsrfToken is non-empty + unique', a.length > 0 && a !== auth.newCsrfToken());
  check('csrfEqual true for equal tokens', auth.csrfEqual(a, a) === true);
  check('csrfEqual false for different tokens', auth.csrfEqual(a, auth.newCsrfToken()) === false);
  check('csrfEqual false for undefined', auth.csrfEqual(undefined, a) === false);
}

// ---------------- cookies ----------------
{
  const c = auth.serializeCookie('sid', 'val', { httpOnly: true, sameSite: 'Lax', secure: true, maxAgeMs: 1000 });
  check('serializeCookie sets HttpOnly', /HttpOnly/.test(c));
  check('serializeCookie sets Secure when asked', /Secure/.test(c));
  check('serializeCookie converts maxAgeMs → Max-Age seconds', /Max-Age=1\b/.test(c));
  const insecure = auth.serializeCookie('sid', 'val', { secure: false });
  check('serializeCookie omits Secure when false', !/Secure/.test(insecure));
  check('clearCookie expires the cookie', /Max-Age=0/.test(auth.clearCookie('sid')));
}

// ---------------- escapeHtml (admin SPA XSS defense) ----------------
check('escapeHtml neutralizes a script tag', escapeHtml('<script>alert(1)</script>') === '&lt;script&gt;alert(1)&lt;/script&gt;');
check('escapeHtml escapes attribute breakouts', escapeHtml('"><img src=x onerror=alert(1)>') === '&quot;&gt;&lt;img src=x onerror=alert(1)&gt;');
check('escapeHtml escapes single quotes', escapeHtml("it's") === 'it&#39;s');
check('escapeHtml escapes ampersand first (no double-encode artifacts)', escapeHtml('a & b') === 'a &amp; b');
check('escapeHtml stringifies null/number safely', escapeHtml(null) === '' && escapeHtml(42) === '42');

// ---------------- CSP (Astro hash-based, via csp-config.ts) ----------------
{
  const base = cspDirectives({});
  const find = (dirs, name) => dirs.find((d) => d.startsWith(name + ' ')) || '';
  // Astro adds script-src/style-src (with hashes) itself — csp-config must NOT
  // emit them, and crucially must never reintroduce 'unsafe-inline' for scripts.
  check('cspDirectives omits script-src (Astro owns it, hashed)', !base.some((d) => d.startsWith('script-src')));
  check('cspDirectives omits style-src (Astro owns it, hashed)', !base.some((d) => d.startsWith('style-src ')));
  check('cspDirectives has no unsafe-inline anywhere near scripts', !base.join('; ').includes("script-src") && !/script[^;]*unsafe-inline/.test(base.join('; ')));
  check('default-src locks to self', find(base, 'default-src') === "default-src 'self'");
  check('img-src allows data: + https:', /img-src 'self' data: https:/.test(find(base, 'img-src')));
  check('worker-src present for 3D workers', /worker-src 'self' blob:/.test(find(base, 'worker-src')));
  check('object-src none + base-uri self (hardening)', find(base, 'object-src') === "object-src 'none'" && find(base, 'base-uri') === "base-uri 'self'");
  // No inline styles remain in the app (theme → external /theme.css; the rest →
  // classes/CSSOM), so style-src needs no 'unsafe-inline' escape hatch at all.
  check('no unsafe-inline anywhere in the directive set', !base.join('; ').includes("'unsafe-inline'"));

  const withCdn = cspDirectives({ CSP_IMG_SRC: 'https://images.cdn.example.com', CSP_CONNECT_SRC: 'https://api.example.com' });
  check('CSP_IMG_SRC appends to img-src', find(withCdn, 'img-src').includes('https://images.cdn.example.com'));
  check('CSP_CONNECT_SRC appends to connect-src', /connect-src 'self' https:\/\/api\.example\.com/.test(find(withCdn, 'connect-src')));

  // script/style extra sources feed Astro's scriptDirective/styleDirective.
  check('cspScriptResources undefined by default (Astro default self+hashes)', cspScriptResources({}) === undefined);
  const sr = cspScriptResources({ CSP_SCRIPT_SRC: 'https://cdn.jsdelivr.net', CSP_ALLOW_WASM: '1' });
  check('cspScriptResources includes self, CDN, wasm when set', sr.includes("'self'") && sr.includes('https://cdn.jsdelivr.net') && sr.includes("'wasm-unsafe-eval'") && !sr.includes("'unsafe-inline'"));
  const styleR = cspStyleResources({ CSP_STYLE_SRC: 'https://styles.cdn.example.com' });
  check('cspStyleResources has self + google fonts + extra, no unsafe-inline', styleR.includes("'self'") && styleR.includes('https://fonts.googleapis.com') && styleR.includes('https://styles.cdn.example.com') && !styleR.includes("'unsafe-inline'"));

  // securityHeaders no longer emits CSP (Astro's meta does) but keeps the rest.
  const h = securityHeaders({});
  check('securityHeaders omits CSP (Astro emits the meta)', !h['Content-Security-Policy'] && !h['Content-Security-Policy-Report-Only']);
  check('security headers include nosniff + frame-options', h['X-Content-Type-Options'] === 'nosniff' && h['X-Frame-Options'] === 'DENY');
}

// ---------------- CORS ----------------
{
  check('CORS off by default (no CORS_ORIGINS)', corsAllowOrigin('https://x.com', {}) === null);
  check('CORS allows a listed origin', corsAllowOrigin('https://x.com', { CORS_ORIGINS: 'https://x.com https://y.com' }) === 'https://x.com');
  check('CORS rejects an unlisted origin', corsAllowOrigin('https://evil.com', { CORS_ORIGINS: 'https://x.com' }) === null);
  check('CORS wildcard echoes *', corsAllowOrigin('https://anything.com', { CORS_ORIGINS: '*' }) === '*');
  const h = corsHeaders('https://x.com', { CORS_ORIGINS: 'https://x.com' });
  check('CORS headers set allow-origin + methods + Authorization', h['Access-Control-Allow-Origin'] === 'https://x.com' && /Authorization/.test(h['Access-Control-Allow-Headers']) && /POST/.test(h['Access-Control-Allow-Methods']));
  // The typed client sends Idempotency-Key on every orders.place(), and a
  // storefront branches on Idempotent-Replayed. Both must cross the origin.
  check('CORS allows Idempotency-Key, so a cross-origin checkout passes preflight',
    /Idempotency-Key/.test(h['Access-Control-Allow-Headers']));
  check('CORS exposes Idempotent-Replayed, so a storefront can read the replay',
    /Idempotent-Replayed/.test(h['Access-Control-Expose-Headers']));
  check('CORS never sets allow-credentials (token auth, CSRF-safe)', !('Access-Control-Allow-Credentials' in h));
  check('CORS headers empty for disallowed origin', Object.keys(corsHeaders('https://evil.com', { CORS_ORIGINS: 'https://x.com' })).length === 0);
}

// ---------------- webhooks (pure helpers + signature) ----------------
{
  const active = (events) => ({ active: true, events });
  check('webhookMatches: exact event', webhookMatches(active(['post.created']), 'post.created') === true);
  check('webhookMatches: non-subscribed event', webhookMatches(active(['post.created']), 'post.deleted') === false);
  check('webhookMatches: "*" catch-all', webhookMatches(active(['*']), 'anything.happened') === true);
  check('webhookMatches: "post.*" prefix wildcard', webhookMatches(active(['post.*']), 'post.updated') === true);
  check('webhookMatches: prefix wildcard does not over-match', webhookMatches(active(['post.*']), 'content.created') === false);
  check('webhookMatches: inactive never matches', webhookMatches({ active: false, events: ['*'] }, 'post.created') === false);
  check('webhookMatches: missing events array is safe', webhookMatches({ active: true, events: undefined }, 'post.created') === false);

  // Body is deterministic and embeds event/timestamp/data.
  const body = webhookBody('post.created', { id: 'p1' }, '123');
  const parsed = JSON.parse(body);
  check('webhookBody embeds event/timestamp/data', parsed.event === 'post.created' && parsed.timestamp === '123' && parsed.data.id === 'p1');

  // Signature: signing the exact body is stable and verifiable; tamper detection works.
  const sig = auth.signWebhook('shhh', body);
  check('signWebhook is deterministic', sig === auth.signWebhook('shhh', body));
  check('signWebhook differs for a different secret', sig !== auth.signWebhook('other', body));
  check('signWebhook differs if body is tampered', sig !== auth.signWebhook('shhh', body + ' '));
  check('newWebhookSecret returns high-entropy strings', auth.newWebhookSecret().length >= 24 && auth.newWebhookSecret() !== auth.newWebhookSecret());

  check('WEBHOOK_EVENTS lists the core events', WEBHOOK_EVENTS.includes('post.created') && WEBHOOK_EVENTS.includes('content.deleted'));
}

// ---------------- API-key scopes + expiry ----------------
{
  // Scope token validation.
  check('isValidScope accepts resource:action', isValidScope('posts:write') && isValidScope('content:read'));
  check('isValidScope accepts resource:* and *', isValidScope('media:*') && isValidScope('*'));
  check('isValidScope rejects junk', !isValidScope('posts') && !isValidScope('posts:delete') && !isValidScope('foo:read') && !isValidScope(5));

  // Required-scope mapping.
  check('requiredScopeFor write on posts', requiredScopeFor('POST', '/api/posts') === 'posts:write');
  check('requiredScopeFor read on posts/{id}', requiredScopeFor('GET', '/api/posts/abc') === 'posts:read');
  check('requiredScopeFor write on content', requiredScopeFor('PUT', '/api/content/product/1') === 'content:write');
  check('requiredScopeFor ungated endpoint is null', requiredScopeFor('POST', '/api/keys') === null);

  // Satisfaction.
  check('unscoped key satisfies anything', scopeSatisfied([], 'posts:write') && scopeSatisfied(undefined, 'content:read'));
  check('null requirement is always satisfied', scopeSatisfied(['posts:read'], null));
  check('exact scope satisfies', scopeSatisfied(['posts:write'], 'posts:write'));
  check('resource:* satisfies read and write', scopeSatisfied(['posts:*'], 'posts:write') && scopeSatisfied(['posts:*'], 'posts:read'));
  check('global * satisfies', scopeSatisfied(['*'], 'media:write'));
  check('read scope does NOT satisfy write', !scopeSatisfied(['posts:read'], 'posts:write'));
  check('wrong resource does NOT satisfy', !scopeSatisfied(['content:write'], 'posts:write'));

  // Expiry.
  const future = new Date(Date.now() + 86_400_000).toISOString();
  const past = new Date(Date.now() - 1000).toISOString();
  check('apiKeyExpired false without expiry', !apiKeyExpired({}));
  check('apiKeyExpired false for a future expiry', !apiKeyExpired({ expires_at: future }));
  check('apiKeyExpired true for a past expiry', apiKeyExpired({ expires_at: past }));
}

// ---------------- scoped-key deny-by-default ----------------
{
  check('scopedKeyAllowed: unscoped key passes everywhere', scopedKeyAllowed([], 'POST', '/api/keys') && scopedKeyAllowed(undefined, 'GET', '/api/webhooks'));
  check('scopedKeyAllowed: "*" passes everywhere', scopedKeyAllowed(['*'], 'POST', '/api/backup/import'));
  check('scopedKeyAllowed: matching scope allowed', scopedKeyAllowed(['posts:write'], 'POST', '/api/posts'));
  check('scopedKeyAllowed: read scope blocks a write', !scopedKeyAllowed(['posts:read'], 'POST', '/api/posts'));
  check('scopedKeyAllowed: DENIES endpoints outside the scoped resources', !scopedKeyAllowed(['posts:write'], 'GET', '/api/keys') && !scopedKeyAllowed(['posts:*'], 'POST', '/api/webhooks') && !scopedKeyAllowed(['content:*'], 'POST', '/api/backup/import') && !scopedKeyAllowed(['posts:write'], 'GET', '/api/users/get') && !scopedKeyAllowed(['posts:write'], 'GET', '/api/audit'));
  check('scopedKeyAllowed: GET /api/auth/me always allowed (introspection)', scopedKeyAllowed(['posts:read'], 'GET', '/api/auth/me') && !scopedKeyAllowed(['posts:read'], 'POST', '/api/auth/me'));
}

// ---------------- safe redirect (open-redirect defence) ----------------
{
  check('safeRedirectPath keeps a normal path', auth.safeRedirectPath('/admin/posts') === '/admin/posts');
  check('safeRedirectPath rejects protocol-relative //', auth.safeRedirectPath('//evil.com') === '/admin');
  check('safeRedirectPath rejects backslash variant /\\', auth.safeRedirectPath('/\\evil.com') === '/admin');
  check('safeRedirectPath rejects embedded backslash', auth.safeRedirectPath('/a\\b') === '/admin');
  check('safeRedirectPath rejects absolute URLs', auth.safeRedirectPath('https://evil.com') === '/admin');
  check('safeRedirectPath rejects javascript:', auth.safeRedirectPath('javascript:alert(1)') === '/admin');
  check('safeRedirectPath rejects control chars', auth.safeRedirectPath('/a\nb') === '/admin');
  check('safeRedirectPath rejects empty/null', auth.safeRedirectPath('') === '/admin' && auth.safeRedirectPath(null) === '/admin');
  check('safeRedirectPath honors a custom fallback', auth.safeRedirectPath('//x', '/') === '/');
}

// ---------------- webhook URL guard (SSRF defence) ----------------
{
  // Hostname classification.
  const priv = ['localhost', 'api.localhost', 'db.local', 'svc.internal', 'metadata.google.internal',
    '127.0.0.1', '10.0.0.5', '172.16.9.9', '172.31.255.1', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.1.1', '::1', 'fe80::1', 'fd12::1', '::ffff:10.0.0.1'];
  check('isPrivateHostname flags every internal form', priv.every((h) => isPrivateHostname(h)));
  const pub = ['example.com', 'hooks.example.com', '8.8.8.8', '172.15.0.1', '172.32.0.1', '100.63.0.1', '2606:4700::1111'];
  check('isPrivateHostname passes public hosts', pub.every((h) => !isPrivateHostname(h)));

  // Full URL checks (guard ON by default).
  check('checkWebhookUrl allows a public https target', checkWebhookUrl('https://hooks.example.com/x', {}).ok === true);
  check('checkWebhookUrl blocks localhost by default', checkWebhookUrl('http://127.0.0.1:8080/x', {}).ok === false);
  check('checkWebhookUrl blocks cloud metadata', checkWebhookUrl('http://169.254.169.254/latest/meta-data/', {}).ok === false);
  check('checkWebhookUrl blocks non-http schemes', checkWebhookUrl('ftp://example.com/x', {}).ok === false && checkWebhookUrl('file:///etc/passwd', {}).ok === false);
  check('checkWebhookUrl blocks URL credentials', checkWebhookUrl('https://user:pw@example.com/x', {}).ok === false);
  check('checkWebhookUrl rejects junk', checkWebhookUrl('not a url', {}).ok === false);
  check('WEBHOOK_ALLOW_PRIVATE=1 permits private targets (dev/test)', checkWebhookUrl('http://127.0.0.1:9999/x', { WEBHOOK_ALLOW_PRIVATE: '1' }).ok === true);
}

// ---------------- password-reset tokens ----------------
{
  const user = { id: 'u1', password_salt: 'saltA' };
  const token = auth.makeResetToken(user);
  check('reset token embeds the uid', auth.readResetTokenUid(token) === 'u1');
  check('reset token verifies for the same user/salt', auth.verifyResetToken(token, user) === true);
  // Single-use: once the password (salt) changes, the token no longer verifies.
  check('reset token is invalidated by a salt change (single-use)', auth.verifyResetToken(token, { id: 'u1', password_salt: 'saltB' }) === false);
  check('reset token rejects a different user', auth.verifyResetToken(token, { id: 'u2', password_salt: 'saltA' }) === false);
  check('reset token rejects a tampered signature', auth.verifyResetToken(token + 'x', user) === false);
  check('reset token rejects junk', auth.verifyResetToken('not-a-token', user) === false && auth.readResetTokenUid('') === null);
}

// ---------------- email transport selection ----------------
{
  email.setEmailTransport(null); // ensure no override leaks between checks
  check('default transport is console', email.getEmailTransport({}).name === 'console');
  check('EMAIL_TRANSPORT=webhook selects webhook when URL set', email.getEmailTransport({ EMAIL_TRANSPORT: 'webhook', EMAIL_WEBHOOK_URL: 'https://x' }).name === 'webhook');
  check('webhook without URL falls back to console', email.getEmailTransport({ EMAIL_TRANSPORT: 'webhook' }).name === 'console');

  // Injected override wins and receives the message.
  let captured = null;
  email.setEmailTransport({ name: 'test', async send(m) { captured = m; } });
  check('setEmailTransport override is selected', email.getEmailTransport({}).name === 'test');
  await email.sendEmail({ to: 'a@b.c', subject: 'Hi', text: 'body' });
  check('sendEmail routes to the active transport', captured && captured.to === 'a@b.c' && captured.subject === 'Hi');
  email.setEmailTransport(null);
}

// ---------------- Reply-To, bulk mail, and saying what is misconfigured ----------------
{
  const msg = { to: 'buyer@example.com', subject: 's', text: 't' };
  const P = (m, name, env) => email.prepareEmail(m, name, env);
  const throws = (fn) => { try { fn(); return ''; } catch (e) { return String(e.message); } };

  check('EMAIL_REPLY_TO is put on every message', P(msg, 'smtp', { EMAIL_REPLY_TO: 'info@example.gr' }).replyTo === 'info@example.gr');
  check('...unless the caller chose one', P({ ...msg, replyTo: 'x@y.gr' }, 'smtp', { EMAIL_REPLY_TO: 'info@example.gr' }).replyTo === 'x@y.gr');
  check('no EMAIL_REPLY_TO, no Reply-To', P(msg, 'smtp', {}).replyTo === undefined);
  // A caller's Reply-To is often a VISITOR's text (a contact form). One that is
  // not an address is dropped for the default, never written into a header.
  check('an unusable caller Reply-To falls back to EMAIL_REPLY_TO',
    P({ ...msg, replyTo: 'not an address' }, 'smtp', { EMAIL_REPLY_TO: 'info@example.gr' }).replyTo === 'info@example.gr');
  check('...a CRLF-carrying one too',
    P({ ...msg, replyTo: 'a@b.gr\r\nBcc: victim@example.gr' }, 'smtp', { EMAIL_REPLY_TO: 'info@example.gr' }).replyTo === 'info@example.gr');
  // Plugins written before `replyTo` set it as a header, which the builder now
  // refuses; it is read from there instead, under the same checks.
  check('a plugin\'s headers[\'Reply-To\'] still sets the Reply-To',
    P({ ...msg, headers: { 'reply-to': 'plugin@example.gr' } }, 'smtp', { EMAIL_REPLY_TO: 'info@example.gr' }).replyTo === 'plugin@example.gr');
  check('...unless the field is set, which wins',
    P({ ...msg, replyTo: 'x@y.gr', headers: { 'Reply-To': 'plugin@example.gr' } }, 'smtp', {}).replyTo === 'x@y.gr');
  check('...and an unusable one falls back like any other',
    P({ ...msg, headers: { 'Reply-To': 'a@b.gr\r\nBcc: v@x.gr' } }, 'smtp', { EMAIL_REPLY_TO: 'info@example.gr' }).replyTo === 'info@example.gr');
  check('...and with no default, the message goes without one',
    !('replyTo' in P({ ...msg, replyTo: 'nope' }, 'smtp', {})));
  // Set but unusable: mail STILL goes, without the header. Losing an order
  // confirmation to protect where the answer goes is the worse trade.
  check('an unusable EMAIL_REPLY_TO does not stop a real send',
    throws(() => P(msg, 'smtp', { EMAIL_REPLY_TO: 'not an address' })) === '');
  check('...the message goes without a Reply-To',
    P(msg, 'smtp', { EMAIL_REPLY_TO: 'not an address' }).replyTo === undefined);
  check('...and it is a warning, said in words',
    /EMAIL_REPLY_TO is not a usable address.*WITHOUT a Reply-To/.test(email.emailConfigWarnings({ EMAIL_REPLY_TO: 'nope' }).join(' ')));
  check('...but not a transport problem', email.emailConfigProblem({ EMAIL_REPLY_TO: 'nope' }) === null);
  check('a usable EMAIL_REPLY_TO warns about nothing', email.emailConfigWarnings({ EMAIL_REPLY_TO: 'info@example.gr' }).length === 0);

  const bulk = { ...msg, category: 'bulk' };
  check('bulk mail is refused when campaigns are off',
    /Refusing to send bulk mail.*EMAIL_CAMPAIGNS=0/.test(throws(() => P(bulk, 'smtp', { EMAIL_CAMPAIGNS: '0' }))));
  check('...allowed when the key is unset', throws(() => P(bulk, 'smtp', {})) === '');
  check('transactional mail passes with campaigns off',
    throws(() => P(msg, 'smtp', { EMAIL_CAMPAIGNS: '0' })) === '');
  check('EMAIL_CAMPAIGNS=0/false/no/off switches campaigns off',
    ['0', 'false', 'no', 'off', 'OFF', ' No '].every((v) => !email.campaignsEnabled({ EMAIL_CAMPAIGNS: v })));
  check('...and anything else, unset included, leaves them on',
    email.campaignsEnabled({}) && ['1', 'true', 'yes', ''].every((v) => email.campaignsEnabled({ EMAIL_CAMPAIGNS: v })));

  // The operator who set EMAIL_TRANSPORT=smtp and mistyped one variable is told
  // WHICH variable — the health check used to recommend a different product.
  const good = { EMAIL_TRANSPORT: 'smtp', SMTP_HOST: 'mail.example.gr', EMAIL_FROM: 'Shop <shop@example.gr>', SMTP_USER: 'u', SMTP_PASS: 'p' };
  const why = (env) => email.emailConfigProblem(env) ?? '';
  check('a complete SMTP configuration has no problem', email.emailConfigProblem(good) === null);
  check('a missing password is named', /SMTP_PASS is not/.test(why({ ...good, SMTP_PASS: '' })));
  check('a missing host is named', /SMTP_HOST/.test(why({ ...good, SMTP_HOST: '' })));
  check('a mistyped transport is named, not silently ignored', /smpt is not a transport/.test(why({ ...good, EMAIL_TRANSPORT: 'smpt' })));
  check('an unusable HELO name is named', /SMTP_HELO_NAME/.test(why({ ...good, SMTP_HELO_NAME: 'my host' })));
  check('an unconfigured install has no "problem" (console is a choice)', email.emailConfigProblem({}) === null);

  const realWarn = console.warn;
  const warnings = [];
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    check('a complete SMTP configuration selects SMTP', email.getEmailTransport(good).name === 'smtp');
    check('...and still does with an unusable Reply-To — mail keeps flowing',
      email.getEmailTransport({ ...good, EMAIL_REPLY_TO: 'nope@' }).name === 'smtp');
    email.getEmailTransport({ ...good, EMAIL_REPLY_TO: 'nope@' });
    email.reportEmailConfig({ ...good, EMAIL_REPLY_TO: 'nope@' });
    const loud = warnings.filter((w) => w.includes('WARNING') && w.includes('nope@'));
    check('the unusable Reply-To is warned about loudly', loud.length >= 1);
    check('...once per process, not once per send', loud.length === 1);
  } finally { console.warn = realWarn; }

  // End to end through the real sendEmail/deliverEmail, with the environment
  // they actually read.
  const saved = { r: process.env.EMAIL_REPLY_TO, c: process.env.EMAIL_CAMPAIGNS };
  try {
    process.env.EMAIL_REPLY_TO = 'info@example.gr';
    let got = null;
    email.setEmailTransport({ name: 'fake', async send(m, o) { got = m; o?.onResult?.({ response: '250 ok queued', attempts: 1 }); } });
    const result = await email.deliverEmail(msg);
    check('deliverEmail relays the transport\'s result', result?.response === '250 ok queued');
    check('the transport received the Reply-To default', got?.replyTo === 'info@example.gr');
    // Public plugin API: its contract is exactly what it was.
    check('sendEmail still resolves with nothing', (await email.sendEmail(msg)) === undefined);

    process.env.EMAIL_CAMPAIGNS = 'off';
    got = null;
    let refused = false;
    try { await email.sendEmail({ ...msg, category: 'bulk' }); } catch { refused = true; }
    check('sendEmail refuses bulk mail when campaigns are off', refused);
    check('...before the transport is ever called', got === null);
  } finally {
    email.setEmailTransport(null);
    if (saved.r === undefined) delete process.env.EMAIL_REPLY_TO; else process.env.EMAIL_REPLY_TO = saved.r;
    if (saved.c === undefined) delete process.env.EMAIL_CAMPAIGNS; else process.env.EMAIL_CAMPAIGNS = saved.c;
  }
}

// ---------------- a form notification's Reply-To is the person who wrote ----------------
{
  // The transport override, the settings store and the notifier are the SAME
  // module instances: one entry in the shared build (see the top of the file).
  const N = await importBuilt('entry/notify');

  const fields = [
    { name: 'name', rule: { type: 'string' } },
    { name: 'reply_address', rule: { type: 'email' } },
    { name: 'other_email', rule: { type: 'email' } },
  ];
  check('the first field DECLARED as email is the reply address',
    N.submitterReplyTo(fields, { name: 'x', reply_address: ' anna@example.gr ', other_email: 'b@example.gr' }) === 'anna@example.gr');
  check('...not a submitted key that merely looks like one',
    N.submitterReplyTo([{ name: 'name', rule: { type: 'string' } }], { name: 'x', email: 'evil@example.gr' }) === undefined);
  check('...and nothing when the field was left empty', N.submitterReplyTo(fields, { reply_address: '  ' }) === undefined);

  await N.LocalDB.init();
  await N.LocalDB.updateSetting('contact_notify_email', 'owner@example.gr');
  const sent = [];
  N.setEmailTransport({ name: 'fake', async send(m) { sent.push(m); } });
  try {
    await N.notifySubmission({ what: 'contact message', fields: [{ name: 'Email', value: 'anna@example.gr' }], whereToFind: 'x', replyTo: 'anna@example.gr' });
    await N.notifySubmission({ what: 'contact message', fields: [], whereToFind: 'x', replyTo: 'nonsense\r\nBcc: v@example.gr' });
  } finally { N.setEmailTransport(null); }
  check('the notification goes to the shop', sent[0]?.to === 'owner@example.gr');
  check('...with Reply-To set to the submitter', sent[0]?.replyTo === 'anna@example.gr');
  check('...and a submitter value that is not an address never reaches a header',
    sent.length === 2 && !String(sent[1]?.replyTo ?? '').includes('Bcc'));

  // The two routes that build a notice, swept: each passes the submitter on.
  const contactSrc = await fs.readFile(path.join(here, '..', 'src/pages/api/contact.ts'), 'utf8');
  const contentSrc = await fs.readFile(path.join(here, '..', 'src/pages/api/content/[type]/index.ts'), 'utf8');
  check('the contact route passes the visitor\'s address as replyTo', /replyTo: result\.value\.email/.test(contactSrc));
  check('the content-type route passes the declared email field as replyTo',
    /submitterReplyTo\(def\.fields/.test(contentSrc) && /replyTo: submitter/.test(contentSrc));
}

// ---------------- the SMTP credential never leaves the AUTH line ----------------
{
  /*
   * One failing and one succeeding send, through the REAL path — environment,
   * getEmailTransport, deliverEmail, the email log on disk — and then a search
   * of everything they left behind for the password and the AUTH token.
   *
   * The failing server is hostile on purpose: it ECHOES the AUTH token back in
   * its 535. A server can say anything, and everything this client repeats of
   * what a server said goes into the error, the log line, the email log and the
   * health endpoint.
   */
  const password = 'Pa ss#w"rd$x\\9';
  const user = 'noreply@example.gr';
  const token = Buffer.from(`\0${user}\0${password}`, 'utf8').toString('base64');
  const secrets = { password, token, passwordB64: Buffer.from(password, 'utf8').toString('base64') };

  let connections = 0;
  const server = net.createServer((sock) => {
    const n = ++connections;
    sock.setEncoding('utf8');
    sock.write('220 test.local ESMTP\r\n');
    let buf = ''; let dataMode = false;
    sock.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\r\n')) !== -1) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (dataMode) { if (line === '.') { dataMode = false; sock.write('250 2.0.0 Ok: queued as QID77\r\n'); } continue; }
        const verb = line.split(/[ :]/)[0].toUpperCase();
        if (verb === 'EHLO') sock.write('250-test.local\r\n250 AUTH PLAIN\r\n');
        else if (verb === 'AUTH') sock.write(n === 1 ? `535 5.7.8 bad credentials ${line.slice(11)} (${password})\r\n` : '235 2.7.0 ok\r\n');
        else if (verb === 'DATA') { dataMode = true; sock.write('354 go ahead\r\n'); }
        else if (verb === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
        else sock.write('250 ok\r\n');
      }
    });
    sock.on('error', () => {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  const keys = ['EMAIL_TRANSPORT', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_ALLOW_INSECURE_AUTH', 'EMAIL_FROM', 'SMTP_RETRIES', 'EMAIL_REPLY_TO'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, {
    EMAIL_TRANSPORT: 'smtp', SMTP_HOST: '127.0.0.1', SMTP_PORT: String(server.address().port),
    SMTP_USER: user, SMTP_PASS: password, SMTP_ALLOW_INSECURE_AUTH: '1',
    EMAIL_FROM: 'Shop <shop@example.gr>', SMTP_RETRIES: '2', EMAIL_REPLY_TO: 'info@example.gr',
  });
  const captured = [];
  const realConsole = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const k of Object.keys(realConsole)) console[k] = (...a) => captured.push(a.map(String).join(' '));
  let failure = null;
  let success = null;
  let lastAfterFailure = null;
  try {
    try { await email.deliverEmail({ to: 'first@example.com', subject: 'secret-test fail', text: 'x' }); }
    catch (e) { failure = e; }
    lastAfterFailure = email.lastSendOutcome();
    success = await email.deliverEmail({ to: 'second@example.com', subject: 'secret-test ok', text: 'x' });
  } catch (e) {
    captured.push(`unexpected: ${e?.message}`);
  } finally {
    Object.assign(console, realConsole);
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    await new Promise((r) => server.close(r));
  }

  // The log is written in the background; wait for both rows to land.
  const dbFile = process.env.DB_PATH;
  let onDisk = '';
  for (let i = 0; i < 60; i++) {
    onDisk = fsSync.existsSync(dbFile) ? fsSync.readFileSync(dbFile, 'utf8') : '';
    if (onDisk.includes('first@example.com') && onDisk.includes('second@example.com')) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const places = {
    'the console': captured.join('\n'),
    'the thrown error': String(failure?.message ?? ''),
    'the health endpoint\'s last-send record': JSON.stringify(lastAfterFailure),
    'the email log on disk': onDisk,
    'the success result': JSON.stringify(success),
  };
  check('the failing send failed, and was not retried (535)', !!failure && connections === 2 && /535/.test(failure.message));
  check('the succeeding send reported the server\'s reply', success?.response === '250 2.0.0 Ok: queued as QID77');
  check('both sends reached the email log on disk', onDisk.includes('first@example.com') && onDisk.includes('second@example.com'));
  check('the email log stores the server\'s reply for the one that went', onDisk.includes('queued as QID77'));
  for (const [where, text] of Object.entries(places)) {
    for (const [what, secret] of Object.entries(secrets)) {
      check(`no ${what} in ${where}`, !text.includes(secret));
    }
  }
  check('...and the echo was scrubbed rather than dropped, so the reply is still readable',
    /535 5\.7\.8 bad credentials \*{8}/.test(String(failure?.message)));
}

// ---------------- the reply to "." never came: "outcome unknown", end to end ----------------
{
  /*
   * The message went, the server's answer did not come back. The server may
   * have it — so it must not be sent again, and nothing downstream may call it
   * either "sent" or "failed". Through the REAL path: environment,
   * getEmailTransport, deliverEmail, lastSendOutcome, the email log on disk and
   * the health check's wording.
   */
  let connections = 0;
  let bodies = 0;
  const server = net.createServer((sock) => {
    const n = ++connections;
    sock.setEncoding('utf8');
    sock.write('220 test.local ESMTP\r\n');
    let buf = ''; let dataMode = false;
    sock.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\r\n')) !== -1) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (dataMode) {
          if (line === '.') {
            dataMode = false; bodies += 1;
            // The first connection takes the message and drops; any later one would accept.
            if (n === 1) { sock.destroy(); return; }
            sock.write('250 2.0.0 Ok: queued as QID88\r\n');
          }
          continue;
        }
        const verb = line.split(/[ :]/)[0].toUpperCase();
        if (verb === 'EHLO') sock.write('250 test.local\r\n');
        else if (verb === 'DATA') { dataMode = true; sock.write('354 go ahead\r\n'); }
        else if (verb === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
        else sock.write('250 ok\r\n');
      }
    });
    sock.on('error', () => {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  const keys = ['EMAIL_TRANSPORT', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'EMAIL_FROM', 'SMTP_RETRIES', 'SMTP_TIMEOUT_MS'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of ['SMTP_USER', 'SMTP_PASS']) delete process.env[k];
  Object.assign(process.env, {
    EMAIL_TRANSPORT: 'smtp', SMTP_HOST: '127.0.0.1', SMTP_PORT: String(server.address().port),
    EMAIL_FROM: 'Shop <shop@example.gr>', SMTP_RETRIES: '2', SMTP_TIMEOUT_MS: '3000',
  });
  const realConsole = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(realConsole)) console[k] = () => {};
  let err = null;
  let last = null;
  try {
    await email.deliverEmail({ to: 'unknown-outcome@example.com', subject: 'outcome test', text: 'x' });
  } catch (e) { err = e; } finally {
    last = email.lastSendOutcome();
    Object.assign(console, realConsole);
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    await new Promise((r) => server.close(r));
  }

  let row = null;
  for (let i = 0; i < 60 && !row; i++) {
    const disk = fsSync.existsSync(process.env.DB_PATH) ? JSON.parse(fsSync.readFileSync(process.env.DB_PATH, 'utf8')) : {};
    row = (disk.emailLog ?? []).find((e) => e.to === 'unknown-outcome@example.com') ?? null;
    if (!row) await new Promise((r) => setTimeout(r, 50));
  }
  const isUnknown = typeof email.isOutcomeUnknown === 'function' && email.isOutcomeUnknown(err);
  check('a reply lost after "." is not retried through the real path: one connection, one copy', connections === 1 && bodies === 1);
  check('deliverEmail rejects, and the error is recognisably "outcome unknown"', !!err && isUnknown);
  check('...while a plain failure is not', typeof email.isOutcomeUnknown === 'function' && !email.isOutcomeUnknown(new Error('SMTP RCPT TO failed: 550 x')));
  check('lastSendOutcome says ok:false, outcome:"unknown" — not a plain failure', last?.ok === false && last?.outcome === 'unknown');
  check('the email log row says the same', row?.ok === false && row?.outcome === 'unknown' && /outcome unknown/i.test(row?.error ?? ''));
  const warn = typeof email.lastSendWarning === 'function' ? email.lastSendWarning(last) : '';
  check('the health check says it may have been delivered — not that it failed',
    /may have been delivered/.test(warn ?? '') && !/tried to send failed/.test(warn ?? ''));
  check('...and still words a real failure exactly as before',
    typeof email.lastSendWarning === 'function'
    && email.lastSendWarning({ at: 'x', ok: false, transport: 'smtp', error: 'SMTP RCPT TO failed: 550 x' })
      === 'the last email this process tried to send failed (SMTP RCPT TO failed: 550 x)');
  check('...and has nothing to say about a send that went',
    typeof email.lastSendWarning === 'function' && email.lastSendWarning({ at: 'x', ok: true, transport: 'smtp' }) === null);
}

// ---------------- the scheduler's mail loops never wait ten minutes on one message ----------------
{
  /*
   * The reply to "." now waits up to SMTP_DATA_TIMEOUT_MS (ten minutes by
   * default). The sweep sends reminders, back-in-stock notices and campaign
   * batches ONE AT A TIME, and everything else on the tick — scheduled posts,
   * abandoned orders, payment holds — waits behind them. So each of those loops
   * must hand the transport the shorter background wait. Checked by running all
   * three against a capturing transport, not by reading the source.
   */
  const M = await importBuilt('entry/sched-mail');
  const BG = M.email.BACKGROUND_DATA_TIMEOUT_MS ?? 60_000;

  const { LocalDB } = M;
  await LocalDB.init();
  const sent = [];
  M.email.setEmailTransport({ name: 'capture', async send(msg, opts) { sent.push({ to: String(msg.to), dataTimeoutMs: opts?.dataTimeoutMs }); } });
  const realLog = console.log;
  console.log = () => {};
  try {
    // back in stock
    const product = await LocalDB.createProduct({
      name: 'Back again', slug: 'sched-mail-back', status: 'active', stock: 5,
      manage_stock: true, in_stock: true, price_cents: 1000, categories: [],
    });
    await LocalDB.createCustomEntity(M.WAITLIST_TYPE, {
      product_id: product.id, email: 'restock@example.com', created_at: new Date().toISOString(),
    });
    await M.sweepStockWaitlist();
    // an unpaid-order reminder, 30 hours on
    await LocalDB.updateSetting(M.ABANDONMENT_KEYS.recoveryEnabled, true);
    await LocalDB.createOrder({
      status: 'pending', payment_status: 'unpaid', payment_method: 'bank-transfer',
      email: 'remind@example.com', items: [], total_cents: 1000, currency: 'EUR',
    });
    await M.sweepRecoveryReminders(Date.now() + 30 * 3_600_000);
    // one campaign batch
    await LocalDB.createSubscriber('reader@example.com');
    await LocalDB.createCustomEntity(M.CAMPAIGN_TYPE, {
      subject: 'Spring', body: 'New frames.', status: 'sending', cursor: 0, sent_count: 0, failed_count: 0, audience: 1,
    });
    await M.maybeSendCampaign();
  } finally {
    console.log = realLog;
    M.email.setEmailTransport(null);
  }
  const to = (addr) => sent.filter((s) => s.to === addr);
  for (const [loop, addr] of [['back-in-stock', 'restock@example.com'], ['unpaid-order reminder', 'remind@example.com'], ['campaign batch', 'reader@example.com']]) {
    check(`the ${loop} loop sent its message`, to(addr).length === 1);
    check(`the ${loop} loop passes the short background wait for "." (${BG} ms), not the ten-minute one`,
      to(addr).length === 1 && to(addr).every((s) => s.dataTimeoutMs === BG) && BG < 600_000);
  }

  // A campaign message whose outcome is UNKNOWN is not a failure: it may have
  // arrived. It lands in the campaign's existing "unconfirmed" count — "may or
  // may not have received it, and not resent" — not in failed_count.
  const campaign = await LocalDB.createCustomEntity(M.CAMPAIGN_TYPE, {
    subject: 'Summer', body: 'More frames.', status: 'sending', cursor: 0, sent_count: 0, failed_count: 0, audience: 1,
  });
  M.email.setEmailTransport({
    name: 'capture',
    async send() { throw Object.assign(new Error('SMTP outcome unknown: no reply came within 60000ms'), { outcomeUnknown: true }); },
  });
  const realError = console.error;
  console.error = () => {};
  try { await M.maybeSendCampaign(); } finally { console.error = realError; M.email.setEmailTransport(null); }
  const after = (await LocalDB.getCustomEntity(M.CAMPAIGN_TYPE, campaign.id))?.data ?? {};
  check('a campaign message with an unknown outcome is counted unconfirmed, not failed',
    after.unconfirmed_count === 1 && after.failed_count === 0 && after.sent_count === 0);
}

// ---------------- observability ----------------
{
  obs.recordRequest(200);
  obs.recordRequest(404);
  obs.recordRequest(503);
  const m = obs.renderMetrics();
  check('renderMetrics emits a total counter', /astrobaas_requests_total \d+/.test(m));
  check('renderMetrics counts by status class', /astrobaas_requests_by_class\{class="2xx"\} [1-9]/.test(m) && /class="4xx"\} [1-9]/.test(m));
  check('renderMetrics counts 5xx as errors', /astrobaas_errors_total [1-9]/.test(m));
  check('renderMetrics includes an uptime gauge', m.includes('astrobaas_uptime_seconds'));
  check('metricsEnabled honors the env flag', obs.metricsEnabled({ METRICS_ENABLED: '1' }) === true && obs.metricsEnabled({}) === false);
  check('requestLoggingEnabled honors the env flag', obs.requestLoggingEnabled({ LOG_REQUESTS: '1' }) === true && obs.requestLoggingEnabled({}) === false);
  // reportError never throws.
  let threw = false;
  try { obs.reportError(new Error('x'), { where: 'test' }); } catch { threw = true; }
  check('reportError never throws', !threw);
}

// ---------------- scheduled-post worker (pure helpers) ----------------
{
  const past = new Date(Date.now() - 1000).toISOString();
  const future = new Date(Date.now() + 60_000).toISOString();
  check('isPostDue true for scheduled + past date', sched.isPostDue({ status: 'scheduled', publish_date: past }));
  check('isPostDue false for scheduled + future date', !sched.isPostDue({ status: 'scheduled', publish_date: future }));
  check('isPostDue false for scheduled with no date', !sched.isPostDue({ status: 'scheduled' }));
  check('isPostDue false for a draft (even past)', !sched.isPostDue({ status: 'draft', publish_date: past }));
  check('isPostDue false for already published', !sched.isPostDue({ status: 'published', publish_date: past }));
  check('schedulerEnabled honors SCHEDULER_DISABLED', sched.schedulerEnabled({}) === true && sched.schedulerEnabled({ SCHEDULER_DISABLED: '1' }) === false);
  check('schedulerIntervalMs default + floor', sched.schedulerIntervalMs({}) === 60_000 && sched.schedulerIntervalMs({ SCHEDULER_INTERVAL_MS: '50' }) === 60_000 && sched.schedulerIntervalMs({ SCHEDULER_INTERVAL_MS: '500' }) === 500);
}

// ---- settings visibility: the settings table is schemaless, so a public read
// must be deny-by-default or it eventually publishes whatever got stored ----
{
  const store = {
    site_title: 'My Site',
    posts_per_page: 10,
    smtp_password: 'hunter2',
    stripe_secret_key: 'sk_live_xxx',
    public_theme_accent: '#f00',
  };
  const anon = visibleSettings(store, false);
  const staff = visibleSettings(store, true);

  check('anonymous read exposes core public keys', anon.site_title === 'My Site' && anon.posts_per_page === 10);
  check('anonymous read HIDES an unknown key (deny-by-default)',
    !('smtp_password' in anon) && !('stripe_secret_key' in anon));
  check('a public_-prefixed key is opt-in visible', anon.public_theme_accent === '#f00');
  // Was `staff still see everything` — which is the behaviour a red-team pass
  // found to be a leak: `if (isStaff) return settings` meant an EDITOR, a role
  // that cannot reach most of the admin, read smtp_password and
  // stripe_secret_key from a route in the public allow-list.
  //
  // Credential-shaped names are now withheld at every role and reported as a
  // boolean instead, so the admin can still manage a key it can never read back.
  check('staff do NOT receive credential values',
    staff.smtp_password === undefined && staff.stripe_secret_key === undefined);
  check('...but are told the credential is set',
    staff.smtp_password__is_set === true);
  check('staff still see non-credential settings in full',
    staff.site_title === 'My Site' && staff.public_theme_accent === '#f00');
  check('the anonymous view is a copy, not the live map', anon !== store && Object.keys(store).length === 5);

  check('isPublicSetting agrees with the set',
    isPublicSetting('site_title') && isPublicSetting('public_anything') && !isPublicSetting('smtp_password'));
  // A near-miss must not slip through: only a real prefix counts.
  check('a key merely CONTAINING "public_" is not public',
    !isPublicSetting('not_public_key') && !isPublicSetting('mypublic_x'));
  check('no credential-shaped key is in the core allowlist',
    ![...PUBLIC_SETTING_KEYS].some((k) => /secret|password|token|key$|api_key|private/i.test(k)));
  check('empty + odd inputs are safe',
    Object.keys(visibleSettings({}, false)).length === 0 && Object.keys(visibleSettings({}, true)).length === 0);
}

// ---- accent-insensitive search ----
// Reported from a live Greek shop: searching "ΑΛΥΣΙΔΑ" or "αλυσιδα" found
// nothing for a product stored as "αλυσίδα". Reproduced against the real
// 436-product catalogue before fixing.
{
  const f = foldForSearch;

  const target = f('αλυσίδα ατσάλι');
  for (const typed of ['αλυσίδα', 'αλυσιδα', 'ΑΛΥΣΙΔΑ', 'Αλυσίδα', 'ΑΛΥΣΊΔΑ', '  αλυσιδα  ']) {
    check(`Greek: "${typed}" finds "αλυσίδα ατσάλι"`, target.includes(f(typed)));
  }

  // Final sigma. 'ΟΔΟΣ'.toLowerCase() yields a FINAL sigma (ς), which then fails
  // to match a stored medial σ — the trap that makes this more than an accent strip.
  check('word-final Σ lowercases to ς in JS (the reason the fold exists)',
    'ΟΔΟΣ'.toLowerCase().endsWith('ς'));
  check('final and medial sigma fold together', f('ΓΥΑΛΙΑ ΗΛΙΟΣ') === f('γυαλιά ήλιος'));
  check('lunate sigma folds too', f('ϲίγμα') === f('σιγμα'));

  check('precomposed and decomposed accents fold identically',
    f('\u0386') === f('\u0391\u0301') && f('\u0386') === 'α');
  check('dialytika + tonos folds to the bare letter', f('\u0390') === 'ι');
  check('polytonic Greek folds', f('ᾳ') === 'α' && f('ἀ') === 'α' && f('ῷ') === 'ω');

  check('French', f('CAFÉ') === f('cafe') && f('café') === 'cafe');
  check('German umlaut', f('MÜLLER') === f('muller'));
  check('Spanish', f('PIÑATA') === f('pinata'));
  check('Vietnamese', f('Tiếng Việt') === f('tieng viet'));

  check('whitespace is collapsed and trimmed', f('  γυαλιά   ηλίου ') === 'γυαλια ηλιου');
  check('non-strings fold to empty, never throw',
    f(null) === '' && f(undefined) === '' && f(42) === '' && f({}) === '');

  check('matchesSearch folds BOTH sides', matchesSearch(['αλυσίδα ατσάλι'], 'ΑΛΥΣΙΔΑ'));
  check('matchesSearch searches every field',
    matchesSearch(['x', null, 'Ραίη Μπαν'], 'ραιη') && !matchesSearch(['x', 'y'], 'ζζζ'));
  check('an empty query filters nothing', matchesSearch(['anything'], '') && matchesSearch([], '   '));
  check('nullish fields are skipped, not crashed', matchesSearch([null, undefined, 'ok'], 'ok'));

  check('the fold does not over-match', !f('γυαλιά').includes(f('ρολόι')));
  check('ASCII behaviour is unchanged', f('Ray-Ban Aviator') === 'ray-ban aviator');
}

// ---- slugify: non-Latin names must not produce an EMPTY slug ----
// An empty slug bypassed the product uniqueness check (`if (slug && …)`), so
// every Greek product created without a manual slug collided on '' and became
// unreachable by slug.
{
  check('a Greek name transliterates instead of vanishing',
    slugify('αλυσίδα ατσάλι') === 'alysida-atsali');
  check('ALL-CAPS Greek slugs the same as lower case',
    slugify('ΑΛΥΣΙΔΑ ΑΤΣΑΛΙ') === slugify('αλυσίδα ατσάλι'));
  check('the ου digraph reads as "ou", not "oy"', slugify('ΗΛΙΟΥ') === 'iliou');
  check('Cyrillic transliterates', slugify('Привет мир') === 'privet-mir');
  check('German ß becomes ss rather than disappearing', slugify('Straße') === 'strasse');
  check('ASCII slugs are unchanged', slugify('Ray-Ban Aviator') === 'ray-ban-aviator');
  check('accented Latin still folds', slugify('Café Crème') === 'cafe-creme');

  for (const name of ['日本語', '😀😀', '!!!', '—', '']) {
    const out = slugify(name);
    check(`"${name}" still yields a non-empty slug (${out})`, out.length > 0);
  }
  check('the fallback is deterministic', slugify('日本語') === slugify('日本語'));
  check('different unsluggable names get different slugs', slugify('日本語') !== slugify('中文'));
  check('a slug never ends with a dash', !slugify('γυαλιά!!!').endsWith('-'));
  check('slugs stay within the length cap', slugify('α'.repeat(300)).length <= 80);
}

// ---- input hardening: a field accepts its declared type and NOTHING adjacent ----
// JavaScript's coercions make "adjacent" wide: Number(true) is 1, Number([7]) is
// 7, Number('0x10') is 16. A `number` field that coerces takes all of them.
{
  const { parsePaging, DEFAULT_STRING_MAX } = await fromBuild('src/lib/validate.ts');

  const num = (v) => validate({ n: v }, { n: { type: 'number' } });
  check('a real number is accepted', num(5).ok && num(0).ok && num(-3.5).ok);
  check('a strictly-numeric string is accepted', num('5').ok && num('-3.5').ok && num('.5').ok);

  // These all used to be ACCEPTED, silently coerced.
  check('a boolean is REFUSED as a number', !num(true).ok && !num(false).ok);
  check('an array is REFUSED as a number', !num([]).ok && !num([7]).ok);
  check('a hex string is REFUSED', !num('0x10').ok);
  check('a whitespace-padded number is REFUSED', !num(' 7 ').ok);
  check('an exponent STRING is REFUSED', !num('1e3').ok);
  check('an object is refused', !num({}).ok);
  check('Infinity and NaN are refused', !num(Infinity).ok && !num(NaN).ok);
  // A real JSON number in exponent form parses to a plain number, so nothing
  // legitimate is lost by rejecting the string form.
  check('a real exponent NUMBER is still fine', num(1e3).ok && num(1e3).value.n === 1000);

  // --- ids ---
  const id = (v) => validate({ i: v }, { i: { type: 'id' } });
  check('a UUID is a valid id', id('3f7b1f42-8f6d-4a5e-9c11-2b7a8d9e0f31').ok);
  check('a kebab plugin id is valid', id('consent-banner').ok);
  check('a short numeric id is valid', id('1').ok);
  check('a path-traversal shape is REFUSED', !id('../../etc/passwd').ok);
  check('markup is REFUSED as an id', !id('<script>alert(1)</script>').ok);
  check('an embedded NUL is REFUSED', !id('a\u0000b').ok);
  check('a space is refused', !id('a b').ok);
  check('an over-long id is refused', !id('a'.repeat(65)).ok);
  check('an empty id is refused', !id('').ok);

  // --- strings ---
  const str = (v, rule = {}) => validate({ s: v }, { s: { type: 'string', ...rule } });
  check('a normal string passes', str('hello').ok);
  // A NUL truncates in C-backed libraries: "evil\0.jpg" can pass a .jpg check
  // and be written as "evil".
  check('a NUL byte is REFUSED', !str('evil\u0000.jpg').ok);
  check('other C0 controls are refused', !str('a\u0001b').ok && !str('a\u007fb').ok);
  check('tab/newline stay legal in prose', str('line one\nline two\tindented').ok);
  check('an unbounded string still gets a default cap',
    !str('x'.repeat(DEFAULT_STRING_MAX + 1)).ok && str('x'.repeat(100)).ok);
  check('an explicit max still wins', !str('abcdef', { max: 3 }).ok);

  // --- arrays ---
  const arr = (v) => validate({ a: v }, { a: { type: 'array', of: 'string', max: 10 } });
  check('an array of strings passes', arr(['a', 'b']).ok);
  check('a wrong item type is refused', !arr(['a', 5]).ok);
  // A 10-item cap on 1 MB strings is not a cap.
  check('an over-long ITEM is refused', !arr(['x'.repeat(DEFAULT_STRING_MAX + 1)]).ok);
  check('a control character inside an item is refused', !arr(['a\u0000b']).ok);
  check('a non-finite number item is refused',
    !validate({ a: [1, Infinity] }, { a: { type: 'array', of: 'number' } }).ok);

  // --- the allowlist property ---
  check('unknown keys are never carried through', (() => {
    const r = validate({ name: 'x', evil: 'y', admin: true }, { name: { type: 'string' } });
    return r.ok && Object.keys(r.value).join() === 'name';
  })());
  check('a __proto__ key does not pollute Object.prototype', (() => {
    validate(JSON.parse('{"__proto__":{"polluted":true},"name":"x"}'), { name: { type: 'string' } });
    return {}.polluted === undefined;
  })());
  check('enums stay strict', !validate({ e: 'other' }, { e: { type: 'enum', values: ['a', 'b'] } }).ok);
  check('booleans stay strict',
    !validate({ b: 'true' }, { b: { type: 'boolean' } }).ok &&
    !validate({ b: 1 }, { b: { type: 'boolean' } }).ok);

  // --- paging ---
  const page = (raw) => parsePaging(raw, { fallback: 50, min: 1, max: 200 });
  check('a valid limit is used', page('25') === 25);
  // These used to yield NaN, which slices to an empty list — a typo that looks
  // exactly like "no results".
  check('junk falls back rather than becoming NaN', page('abc') === 50 && page('') === 50 && page(null) === 50);
  check('hex is not silently honoured', page('0x10') === 50);
  check('out-of-range clamps', page('9999') === 200 && page('-5') === 1);
  check('a float floors', page('25.9') === 25);
}

/* ---------------- bootstrap credentials ---------------- */
{
  // `admin`/`admin` was fine while this repo was private. The day it is public
  // that is a PUBLISHED credential, and every install that kept it is one
  // /login scan away. These assertions pin the two halves of the fix: a fresh
  // production install never gets the known password, and an existing one
  // cannot keep using it.
  const seed = await fromBuild('src/lib/seed-data.ts');
  const auth = await fromBuild('src/lib/auth.ts');

  const prevEnv = process.env.NODE_ENV;
  const prevPw = process.env.ADMIN_PASSWORD;

  // Development keeps the convenient default — zero-config local dev is the
  // whole point of the lowdb driver.
  process.env.NODE_ENV = 'development';
  delete process.env.ADMIN_PASSWORD;
  const devAdmin = seed.makeSeedAdmin();
  check('dev seeds the well-known password (zero-config local dev)',
    (await auth.verifyPassword(seed.SEED_PASSWORD, devAdmin.password_hash, devAdmin.password_salt)) === true);

  // Production with no ADMIN_PASSWORD must NOT produce the known credential.
  process.env.NODE_ENV = 'production';
  const prodA = seed.makeSeedAdmin();
  const prodB = seed.makeSeedAdmin();
  // The property that matters: the seeded credential does NOT open the account.
  check('production does not accept the well-known password',
    (await auth.verifyPassword(seed.SEED_PASSWORD, prodA.password_hash, prodA.password_salt)) === false);
  check('...and generates a DIFFERENT one per install',
    prodA.password_hash !== prodB.password_hash);
  // A hash and a salt, and nothing that could be replayed as a password.
  check('only a hash and salt are stored',
    typeof prodA.password_hash === 'string' && prodA.password_hash.length >= 32
    && typeof prodA.password_salt === 'string' && prodA.password_salt.length >= 16);

  // An explicit ADMIN_PASSWORD always wins, in either environment.
  process.env.ADMIN_PASSWORD = 'chosen-by-the-operator';
  const chosen = seed.makeSeedAdmin();
  check('ADMIN_PASSWORD is honoured in production',
    (await auth.verifyPassword('chosen-by-the-operator', chosen.password_hash, chosen.password_salt)) === true);
  check('the chosen password is not echoed into the record',
    !JSON.stringify(chosen).includes('chosen-by-the-operator'));

  process.env.NODE_ENV = prevEnv;
  if (prevPw === undefined) delete process.env.ADMIN_PASSWORD;
  else process.env.ADMIN_PASSWORD = prevPw;
}

// ---------------- the harness itself: ONE LocalDB for the whole file ----------------
{
  // Every entry that reaches LocalDB must reach the SAME object. A separately
  // bundled copy would bring back the rename race described at the top.
  const probe = (await importBuilt('entry/localdb')).LocalDB;
  const copies = [
    (await importBuilt('entry/notify')).LocalDB,
    (await importBuilt('entry/sched-mail')).LocalDB,
  ];
  check('the whole file shares one LocalDB instance', copies.every((c) => c === probe));
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
