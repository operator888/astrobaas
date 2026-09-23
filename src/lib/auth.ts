/**
 * Server-side auth: PBKDF2 password hashing + signed cookie sessions.
 *
 * No third-party deps — uses node:crypto. Designed for alpha-grade single-node
 * deployments. Sessions are signed, opaque, and short-lived (24h by default).
 */
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import type { User, RevokedSession } from '../core/models';
import { hasCapability, type RoleOverrides } from './capabilities';

const PBKDF2_ITERATIONS = 120_000;
const PBKDF2_KEYLEN = 32;
const PBKDF2_DIGEST = 'sha256';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export const SESSION_COOKIE = 'astrobaas_session';
export const CSRF_COOKIE = 'astrobaas_csrf';

export type Role = 'admin' | 'editor' | 'author' | 'manager' | 'viewer';

/* ---------- role capabilities ----------
 *
 * These predicates are the ONE place every route asks "may this role do that?".
 * Their answers now come from `lib/capabilities.ts`, which was extracted with
 * the grants copied verbatim and pinned by a test against the hard-coded
 * bodies that used to live here — so an operator's overrides could be added
 * without a permissions change arriving mixed with a change in how permissions
 * are computed.
 *
 * They stay SYNCHRONOUS. Every caller is a route guard in the middle of a
 * request, and `pluginManager.applyFilters` is synchronous too; making them
 * async would mean touching seventy-five call sites for a settings read the
 * middleware has already done. The overrides are therefore handed to this
 * module once per request by the middleware — see `setCapabilityOverrides`.
 */

/**
 * The operator's overrides for THIS request.
 *
 * A module-level value, set by the middleware before any route runs and cleared
 * to `null` when the settings read fails. That is safe here in a way it would
 * not be in a threaded runtime: Node handles one request per tick of this
 * module's synchronous code, and every reader is inside a request the
 * middleware has already set up.
 *
 * `null` means "nobody has told us", and the built-in grants apply — which is
 * the same answer an install with no overrides gives, so a settings read that
 * fails degrades to the shipped policy rather than to a lockout.
 */
let currentOverrides: RoleOverrides | null = null;

/** Called by the middleware, once per request. */
export function setCapabilityOverrides(overrides: RoleOverrides | null): void {
  currentOverrides = overrides;
}

/** What the predicates below consult. Exported for tests, not for routes. */
export function capabilityOverrides(): RoleOverrides | null {
  return currentOverrides;
}

/**
 * Editors and admins may manage any post; authors and managers only their own.
 *
 * This predicate also governs media deletion (`api/media/delete.ts`), which is
 * why a manager can remove their own uploads but not somebody else's.
 */
export function canManageAllPosts(role: string | undefined): boolean {
  return hasCapability(role, 'manage_all_posts', capabilityOverrides());
}
/**
 * Run a content import.
 *
 * ADMIN ONLY, and deliberately narrower than every other content predicate. An
 * import is not "creating a post" repeated: it writes site-wide redirects that
 * change what every old URL resolves to, creates categories, and fetches files
 * from a third-party host on the server's behalf. It is also not undoable. An
 * editor can fix a bad post in a minute; nobody can un-import a site.
 */
export function canImportContent(role: string | undefined): boolean {
  return hasCapability(role, 'import_content', capabilityOverrides());
}

/**
 * May this role PUBLISH? (C-150)
 *
 * Separate from `canAuthorPosts`, which admits author and manager. Before this
 * there was no publish predicate anywhere: `updatePost` checked ownership and
 * never checked who may set `status: 'published'`, so an author went
 * draft → published in one click and the `review` status was decoration.
 *
 * Deliberately NOT a capability in the override table. Editorial policy is a
 * per-install decision behind its own setting, and mixing it into the role
 * matrix would let an operator grant "publish" to a role while the setting that
 * governs review is off — two switches for one rule, disagreeing.
 */
export function canPublishPosts(role: string | undefined): boolean {
  return role === 'admin' || role === 'editor';
}

/** Roles allowed to author posts and upload media at all (viewers are read-only). */
export function canAuthorPosts(role: string | undefined): boolean {
  return hasCapability(role, 'author_posts', capabilityOverrides());
}

/* ---------- commerce capabilities ----------
 *
 * These exist because the same question — "may this role touch the catalogue?"
 * — was previously answered by an inline `role !== 'admin' && role !== 'editor'`
 * copied across a dozen route files. Copies drift; the one that gets forgotten
 * is a hole nobody notices until someone finds it. One predicate per capability,
 * asked by every route that needs it.
 */

/** Create and edit products, product categories and brands. */
export function canManageCatalog(role: string | undefined): boolean {
  return hasCapability(role, 'manage_catalog', capabilityOverrides());
}

/**
 * DELETE a product.
 *
 * Deliberately narrower than `canManageCatalog`, and deliberately NOT the same
 * set: deleting a product is destructive in a way editing is not, and this was
 * admin-only before managers existed. Widening it to `editor` at the same time
 * would be a policy change nobody asked for, so editors still cannot delete.
 */
export function canDeleteProducts(role: string | undefined): boolean {
  return hasCapability(role, 'delete_products', capabilityOverrides());
}

/** Read orders and customers. A manager needs both to run the shop. */
export function canReadCommerce(role: string | undefined): boolean {
  return hasCapability(role, 'read_commerce', capabilityOverrides());
}

/**
 * Change an order or create a customer record.
 *
 * A manager is READ-ONLY here by design: order status drives fulfilment and
 * refunds, and customer records are personal data. Refunds are narrower still
 * (admin only, in `orders/[id]/refund.ts`) because moving money is its own
 * decision.
 */
export function canWriteCommerce(role: string | undefined): boolean {
  return hasCapability(role, 'write_commerce', capabilityOverrides());
}

/** May this role depart from the tax engine's answer on an order? */
export function canOverrideTax(role: string | undefined): boolean {
  return hasCapability(role, 'override_tax', capabilityOverrides());
}

/**
 * True when running a built/served app — `astro build` output, including
 * `npm run start` and a bare `node ./dist/server/entry.mjs` — and false under
 * `astro dev`. We key prod-only security on THIS, not on NODE_ENV alone, so the
 * documented bare-metal serve path can never boot with the insecure dev
 * fallback secret.
 *
 * `import.meta.env.PROD` MUST be written as this exact literal so Vite
 * statically replaces it (→ `true` in the build, `false` under `astro dev`).
 * Optional chaining or aliasing it defeats that replacement. Under the esbuild
 * unit-test transpile `import.meta.env` is undefined, so the access throws and
 * we fall back to NODE_ENV (the tests set their own AUTH_SECRET regardless).
 */
const BUILT_PROD: boolean = (() => {
  try {
    return import.meta.env.PROD === true;
  } catch {
    return false;
  }
})();

/**
 * The one answer to "is this a real deployment?" — exported because two other
 * security gates were asking the question themselves and getting it wrong.
 *
 * `seed-data.ts` (which password to seed) and `api/auth/login.ts` (whether to
 * refuse the published default password) both tested
 * `process.env.NODE_ENV === 'production'` directly. NODE_ENV is set by
 * `npm start`, but the documented bare-metal path — `node ./dist/server/entry.mjs`
 * under systemd, Docker CMD, PM2 — does not set it. Both gates therefore failed
 * OPEN on exactly the deployments they exist to protect: a real install would
 * seed `admin`/`admin` and then happily accept it at /login. Audit item D2-7.
 *
 * `BUILT_PROD` is the reliable half. It comes from the BUILD, not the
 * environment, so it cannot be forgotten at deploy time.
 */
export function isProductionRuntime(): boolean {
  return BUILT_PROD || process.env.NODE_ENV === 'production';
}

function isProd(): boolean {
  return isProductionRuntime();
}

/**
 * Whether auth/CSRF cookies should carry the `Secure` flag. On by default in a
 * built/served app (assumes HTTPS via a reverse proxy); force on/off with
 * COOKIE_SECURE=1/0 for non-standard setups (HTTPS in dev, or plain-HTTP
 * testing of a production build on localhost).
 */
export function cookieSecure(): boolean {
  const flag = process.env.COOKIE_SECURE;
  if (flag === '0' || flag === 'false') return false;
  if (flag === '1' || flag === 'true') return true;
  return isProd();
}

const DEV_FALLBACK_SECRET = 'dev-only-insecure-secret-change-me';

/**
 * Secrets that pass the length check but are printed in this repository, so
 * anyone can sign a session with them: the placeholder `.env.example` ships
 * (`cp .env.example .env` without editing it is the easiest mistake a new
 * install can make) and the dev fallback below. Sessions are stateless HMAC
 * tokens, so a known key is a forgeable admin cookie.
 * tests/prod-gates.test.mjs reads the placeholder out of `.env.example`, so
 * changing it there without changing it here fails the build.
 */
const PUBLISHED_SECRETS = new Set([
  'change-me-to-a-32-byte-random-hex-string',
  DEV_FALLBACK_SECRET,
]);

/**
 * Why the configured AUTH_SECRET cannot be used on this runtime, or null when
 * it can. One answer for both callers: `getSecret()` refuses to sign with it,
 * and the middleware prints it once at startup so the operator sees it in the
 * log before the first sign-in fails.
 */
export function authSecretProblem(): string | null {
  if (!isProd()) return null;
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 16) {
    return 'AUTH_SECRET env var is required (>=16 chars; generate with `openssl rand -hex 32`).';
  }
  if (PUBLISHED_SECRETS.has(secret.trim())) {
    return 'AUTH_SECRET is the placeholder from .env.example, which is public. '
      + 'Replace it with a value of your own (`openssl rand -hex 32`).';
  }
  return null;
}

function getSecret(): string {
  // In any built/served app (npm run start, bare node, Docker) a missing, weak
  // or published AUTH_SECRET is fatal — never sign with a key anyone can read.
  // The dev fallback is only for `astro dev`.
  const problem = authSecretProblem();
  if (problem) throw new Error(problem);
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 16) return DEV_FALLBACK_SECRET;
  return secret;
}

/* ---------- user serialization ---------- */

/** A user object safe to send over the API / embed in a page. */
export type PublicUser = Omit<User, 'password_hash' | 'password_salt' | 'two_factor' | 'revoked_sessions'> & {
  two_factor_enabled: boolean;
};

/**
 * Strip every server-only secret from a user before it leaves the process:
 * the password hash + salt AND the entire two_factor block (TOTP secret and
 * backup-code hashes). Callers get a boolean `two_factor_enabled` instead. Use
 * this anywhere a user is returned by an API or rendered into a page.
 *
 * The session revocation list goes too. A token id is not a credential, but it
 * is bookkeeping about the account's sign-ins that no client has a use for.
 */
export function toPublicUser(u: User): PublicUser {
  const { password_hash, password_salt, two_factor, revoked_sessions, ...rest } = u;
  void password_hash;
  void password_salt;
  void revoked_sessions;
  return { ...rest, two_factor_enabled: !!two_factor?.enabled };
}

/* ---------- password hashing ---------- */

/**
 * PBKDF2 on libuv's thread pool (S3.8).
 *
 * `pbkdf2Sync` at 120k iterations holds the event loop for tens of
 * milliseconds per call, and it ran on every sign-in, every forgot-password and
 * every magic-link request — including for unknown emails, where the dummy
 * hash below runs on purpose. A burst of anonymous login posts therefore
 * stalled EVERY request the process was serving, checkout included, for the
 * length of the burst. The async form does identical work off the main thread.
 *
 * The parameters are unchanged and the output is byte-for-byte the same, so
 * every stored hash still verifies. tests/password-hash.test.mjs pins that
 * against a hash computed with the old synchronous call.
 */
const pbkdf2 = promisify(crypto.pbkdf2);

async function derive(password: string, salt: string): Promise<Buffer> {
  return pbkdf2(password, salt, PBKDF2_ITERATIONS, PBKDF2_KEYLEN, PBKDF2_DIGEST);
}

export async function hashPassword(password: string): Promise<{ hash: string; salt: string }> {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = (await derive(password, salt)).toString('hex');
  return { hash, salt };
}

/**
 * The synchronous twin, for ONE caller: seeding the bootstrap admin when an
 * empty database is first opened. That runs once per install, before the
 * process serves anything, inside storage initialisation code that is
 * synchronous in three drivers. Blocking there costs nobody a request; making
 * it async would ripple through every driver's init for no benefit.
 *
 * Every request path must use `hashPassword`. tests/password-hash.test.mjs
 * fails if anything else imports this.
 */
export function hashPasswordSync(password: string): { hash: string; salt: string } {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto
    .pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, PBKDF2_KEYLEN, PBKDF2_DIGEST)
    .toString('hex');
  return { hash, salt };
}

/**
 * ALWAYS `await` this. It returns a Promise, and a Promise is truthy — so an
 * un-awaited `if (!verifyPassword(...))` never rejects anything. The test file
 * above scans every caller for exactly that.
 */
export async function verifyPassword(password: string, hash: string, salt: string): Promise<boolean> {
  if (!password || !hash || !salt) return false;
  const a = await derive(password, salt);
  // Constant-time compare
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Run the same PBKDF2 work as verifyPassword but against a throwaway salt and
 * always return false. Call this on the "user not found / inactive" path so an
 * attacker can't distinguish a registered email from an unregistered one by
 * response timing (the not-found path would otherwise skip the ~tens-of-ms
 * hash). Defends against username enumeration.
 *
 * Must be AWAITED like the real one: an un-awaited call starts the hash and
 * answers at once, which is the timing difference this exists to remove.
 */
export async function dummyVerifyPassword(password: string): Promise<false> {
  await derive(password || '', 'timing-equalizer-salt');
  return false;
}

/* ---------- session token ---------- */

export interface SessionPayload {
  uid: string;
  role: string;
  sv: number; // session version — bumped to revoke outstanding tokens
  iat: number; // issued-at ms
  exp: number; // expires-at ms
  /**
   * A random id for THIS token, so signing out can revoke exactly it (S3.11).
   *
   * Optional because tokens signed before it existed are still in browsers and
   * must keep working until they expire; a required field would have signed
   * every live shop's staff out on deploy.
   */
  jti?: string;
}

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64url');
}
function b64urlDecode(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

export function signSession(payload: Omit<SessionPayload, 'iat' | 'exp' | 'sv'> & { sv?: number }): string {
  const full: SessionPayload = {
    uid: payload.uid,
    role: payload.role,
    sv: payload.sv ?? 0,
    iat: Date.now(),
    exp: Date.now() + SESSION_TTL_MS,
    jti: crypto.randomBytes(12).toString('base64url'),
  };
  const body = b64url(JSON.stringify(full));
  const sig = crypto.createHmac('sha256', getSecret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifySession(token: string | undefined | null): SessionPayload | null {
  if (!token || typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', getSecret()).update(body).digest('base64url');
  if (
    expected.length !== sig.length ||
    !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
  ) {
    return null;
  }
  let payload: SessionPayload;
  try {
    payload = JSON.parse(b64urlDecode(body).toString('utf8'));
  } catch {
    return null;
  }
  if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
  if (!payload.uid || !payload.role) return null;
  if (typeof payload.sv !== 'number') payload.sv = 0; // legacy tokens
  if (payload.jti !== undefined && typeof payload.jti !== 'string') return null;
  return payload;
}

/* ---------- signing out: per-token revocation (S3.11) ---------- */

/**
 * The most revoked-but-unexpired tokens one account keeps a note of.
 *
 * Tokens live 24 hours, so this only fills for somebody signing out fifty
 * times in a day. When it does, the fallback below signs the account out
 * everywhere instead — never a silently dropped revocation.
 */
export const MAX_REVOKED_SESSIONS = 50;

/**
 * Has this token been signed out? Checked by the middleware on every request,
 * against the user record it already loads — so revocation costs no extra
 * read, holds across restarts, and holds across replicas, on all three drivers
 * (a user is one JSON document in each).
 */
export function isSessionRevoked(
  user: Pick<User, 'revoked_sessions'>,
  payload: Pick<SessionPayload, 'jti'>,
): boolean {
  if (!payload.jti) return false;
  return (user.revoked_sessions ?? []).some((r) => r.jti === payload.jti);
}

/**
 * The user patch that revokes `payload`.
 *
 * ## Why per-token, and the one case that is not
 *
 * Signing out used to clear the cookie and nothing else, so a copied token
 * stayed good for its full 24 hours. Bumping `session_version` would have
 * fixed that by signing the person out on EVERY device — and while an admin is
 * acting as someone else (C-141), signing out would have thrown the real Bob
 * out of all his sessions too. A token id revokes exactly the token presented.
 *
 * Tokens minted before ids existed have none, so for those — and only for the
 * day it takes them to expire — signing out bumps `session_version`, which is
 * the only lever that can reach them. So does a full revocation list. Both
 * fallbacks fail towards MORE revocation, never less.
 *
 * Expired entries are pruned on every write, so the list holds at most a day
 * of sign-outs.
 */
export function revocationPatch(
  user: Pick<User, 'revoked_sessions' | 'session_version'>,
  payload: Pick<SessionPayload, 'jti' | 'exp'>,
  now: number = Date.now(),
): Pick<User, 'revoked_sessions' | 'session_version'> {
  const live: RevokedSession[] = (user.revoked_sessions ?? []).filter(
    (r) => r && typeof r.jti === 'string' && typeof r.exp === 'number' && r.exp > now,
  );
  if (!payload.jti || live.length >= MAX_REVOKED_SESSIONS) {
    return { session_version: (user.session_version ?? 0) + 1, revoked_sessions: [] };
  }
  if (live.some((r) => r.jti === payload.jti)) return { revoked_sessions: live };
  return { revoked_sessions: [...live, { jti: payload.jti, exp: payload.exp }] };
}

/* ---------- user switching (C-141) ---------- */

/**
 * Acting as another user, for support and for debugging.
 *
 * ## Why a separate cookie rather than a field on the session
 *
 * The session token is verified in the middleware on every request and its
 * payload shape is relied on in several places. A new optional field there
 * means every verifier has to reason about a legacy token that lacks it. A
 * second, purpose-tagged token is the pattern this file already uses for the
 * pending-2FA challenge, and it has the property that matters: if the switch
 * cookie is dropped, forged or expired, the worst outcome is that the admin
 * cannot switch BACK in one click and has to log in again. It can never grant
 * anything.
 *
 * ## What it holds
 *
 * The original admin's id and session version, so switching back re-checks the
 * account exactly as a login would — an admin who was deactivated while
 * impersonating does not get their session handed back.
 *
 * AND the id of the account being impersonated. That second field is what makes
 * the token safe to honour: without it, a switch cookie left behind on a shared
 * browser is a one-click admin session for WHOEVER logs in next. An audit found
 * exactly that — admin switches to Bob, logs out (only the session cookie is
 * cleared), an editor logs in on the same machine within the hour, sees the
 * banner, presses "Back to my account", and is handed the admin's session.
 *
 * With `acting`, the return trip is only honoured for the session it was issued
 * for. The claim this file used to make — "it can never grant anything" — is
 * now true rather than merely intended.
 *
 * ## The limit of this feature, stated
 *
 * While switched, the request IS the other user: `locals.user` is them, and
 * anything audited inside that window records THEIR id. The switch is audited
 * at both ends, so the window is explicit and an investigator can attribute
 * what happened inside it — but an audit line written during it does not name
 * the admin. That is a real limitation, and the reason a switch is admin-only,
 * refused onto another admin, refused while already switched, and time-boxed.
 */
export const SWITCH_COOKIE = 'astrobaas_switch';

/**
 * An hour. Long enough to reproduce what a colleague is describing, short
 * enough that a forgotten switch expires rather than becoming a spare login.
 */
export const SWITCH_TTL_MS = 60 * 60 * 1000;

export function signSwitchBack(uid: string, sv: number, acting: string): string {
  const body = b64url(JSON.stringify({ uid, sv, acting, p: 'switch', exp: Date.now() + SWITCH_TTL_MS }));
  const sig = crypto.createHmac('sha256', getSecret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifySwitchBack(token: string | undefined | null): { uid: string; sv: number; acting: string } | null {
  if (!token || typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', getSecret()).update(body).digest('base64url');
  if (expected.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return null;
  }
  try {
    const p = JSON.parse(b64urlDecode(body).toString('utf8'));
    // The purpose tag is what stops a token minted for one job being replayed
    // as another. Without it a switch-back token and a 2FA token are the same
    // signed blob with different fields.
    if (p.p !== 'switch' || typeof p.exp !== 'number' || p.exp < Date.now() || !p.uid) return null;
    // `acting` is required, not optional. A token minted before this field
    // existed is exactly the token this check was added to stop honouring.
    if (!p.acting || typeof p.acting !== 'string') return null;
    return { uid: String(p.uid), sv: typeof p.sv === 'number' ? p.sv : 0, acting: String(p.acting) };
  } catch {
    return null;
  }
}

/* ---------- pending two-factor challenge ---------- */

// Short-lived signed token issued after a correct password when the account has
// 2FA on, so the second step (the TOTP code) needs neither the password again
// nor the email in the URL. Purpose-tagged + 5-min TTL so it can't be used as a
// session. Possessing one proves the password was already verified.
export const PENDING_2FA_COOKIE = 'astrobaas_2fa_pending';
const PENDING_2FA_TTL_MS = 5 * 60 * 1000;

export function signPending2fa(uid: string): string {
  const body = b64url(JSON.stringify({ uid, p: '2fa', exp: Date.now() + PENDING_2FA_TTL_MS }));
  const sig = crypto.createHmac('sha256', getSecret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyPending2fa(token: string | undefined | null): { uid: string } | null {
  if (!token || typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', getSecret()).update(body).digest('base64url');
  if (expected.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return null;
  }
  try {
    const p = JSON.parse(b64urlDecode(body).toString('utf8'));
    if (p.p !== '2fa' || typeof p.exp !== 'number' || p.exp < Date.now() || !p.uid) return null;
    return { uid: String(p.uid) };
  } catch {
    return null;
  }
}

/* ---------- purpose-tagged HMAC tokens (the shared shape) ---------- */

/**
 * The pending-2FA token's shape, generalized: `b64url(JSON body).sig` where
 * the body carries a PURPOSE TAG and an expiry, signed with AUTH_SECRET.
 *
 * The tag is the load-bearing part. This process now mints several kinds of
 * short-lived token (pending-2FA, captcha challenges, magic links), all
 * signed with the same secret — without a tag, any of them would verify as
 * any other, and a captcha challenge that a login endpoint accepts as proof
 * of identity is a vulnerability with a CVE number waiting. Every verifier
 * refuses a body whose `p` is not exactly its own.
 */
export function signPurposeToken(
  purpose: string,
  payload: Record<string, unknown>,
  ttlMs: number,
): string {
  const body = b64url(JSON.stringify({ ...payload, p: purpose, exp: Date.now() + ttlMs }));
  const sig = crypto.createHmac('sha256', getSecret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

/**
 * Verify signature, purpose and expiry; return the payload or null. Never
 * throws — a malformed token is an expected input, not an exception.
 */
export function verifyPurposeToken(
  purpose: string,
  token: string | undefined | null,
): Record<string, unknown> | null {
  if (!token || typeof token !== 'string' || token.length > 4096) return null;
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', getSecret()).update(body).digest('base64url');
  if (expected.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return null;
  }
  try {
    const p = JSON.parse(b64urlDecode(body).toString('utf8'));
    if (p.p !== purpose || typeof p.exp !== 'number' || p.exp < Date.now()) return null;
    return p;
  } catch {
    return null;
  }
}

/* ---------- magic-link login ---------- */

/**
 * Fifteen minutes: enough to walk to another device's inbox, short enough
 * that a link forwarded or leaked later is a dead letter.
 */
export const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;

/**
 * A magic link is a bearer credential in an inbox, so it gets every binding
 * we can give it without storing anything:
 *
 *  - purpose tag `magic` — can never verify as a session, a 2FA pending
 *    token, or a captcha challenge;
 *  - the user's `session_version` — changing the password, resetting it, or
 *    a forced logout bumps `sv`, and every outstanding link dies with it
 *    (the same lever that revokes sessions revokes links);
 *  - a random `jti`, which the consuming route marks used through the shared
 *    rate-limit store so the link works exactly once.
 */
export function makeMagicLinkToken(user: { id: string; session_version?: number }): string {
  return signPurposeToken('magic', {
    uid: user.id,
    sv: user.session_version ?? 0,
    jti: crypto.randomBytes(12).toString('base64url'),
  }, MAGIC_LINK_TTL_MS);
}

export function verifyMagicLinkToken(
  token: string | undefined | null,
): { uid: string; sv: number; jti: string } | null {
  const p = verifyPurposeToken('magic', token);
  if (!p || typeof p.uid !== 'string' || typeof p.jti !== 'string') return null;
  return { uid: p.uid, sv: typeof p.sv === 'number' ? p.sv : 0, jti: p.jti };
}

/* ---------- CSRF ---------- */

export function newCsrfToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}

export function csrfEqual(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * The Set-Cookie value for the double-submit token. One spelling, used by the
 * middleware (HTML pages) and by the sign-in response, so the two can never
 * disagree about the attributes.
 */
export function csrfCookie(token: string): string {
  return serializeCookie(CSRF_COOKIE, token, {
    httpOnly: false, // intentionally readable so forms can echo it
    sameSite: 'Lax',
    secure: cookieSecure(),
  });
}

/**
 * Does this response get the CSRF cookie, when the request had none? (S3.13)
 *
 * Only an HTML page outside /api. That is where the token is used: every
 * admin screen and every public form reads it from the page (a meta tag or
 * `document.cookie`) that was just served. Setting it on everything else —
 * every anonymous API GET, the sitemap, an image — put a Set-Cookie on
 * responses a CDN is supposed to cache, and a shared cache will not store a
 * response that sets a cookie.
 *
 * The sign-in response sets it separately (see `api/auth/login.ts`), because
 * a script that signs in over JSON and then writes never loads a page.
 */
export function shouldSetCsrfCookie(pathname: string, contentType: string | null | undefined): boolean {
  if (pathname === '/api' || pathname.startsWith('/api/')) return false;
  return /^\s*text\/html\b/i.test(contentType ?? '');
}

/* ---------- redirect safety ---------- */

/**
 * Validate a user-supplied post-login redirect path. Only same-origin absolute
 * paths survive; everything else falls back to `/admin`. Notably rejects:
 *   - `//evil.com`   (protocol-relative)
 *   - `/\evil.com`   (browsers normalize `\` to `/` → protocol-relative)
 *   - `javascript:…`, full URLs, control characters
 */
export function safeRedirectPath(next: string | null | undefined, fallback = '/admin'): string {
  if (!next || typeof next !== 'string') return fallback;
  if (!next.startsWith('/')) return fallback;
  if (next.startsWith('//')) return fallback;
  if (next.includes('\\')) return fallback;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(next)) return fallback;
  return next;
}

/* ---------- password-reset tokens ---------- */

const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Mint a single-use, time-limited password-reset token. The HMAC key is bound to
 * the user's current `password_salt`, so the token self-invalidates the moment
 * the password changes (single use) — no extra storage needed. Carries the uid
 * (so the verifier can load the user) and an expiry.
 */
export function makeResetToken(user: { id: string; password_salt?: string }): string {
  const body = b64url(JSON.stringify({ uid: user.id, exp: Date.now() + RESET_TTL_MS }));
  const key = getSecret() + (user.password_salt ?? '');
  const sig = crypto.createHmac('sha256', key).update(body).digest('base64url');
  return `${body}.${sig}`;
}

/** Read the uid embedded in a reset token WITHOUT verifying it (to load the user). */
export function readResetTokenUid(token: string | undefined | null): string | null {
  if (!token || typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  try {
    const payload = JSON.parse(b64urlDecode(token.slice(0, dot)).toString('utf8'));
    return typeof payload.uid === 'string' ? payload.uid : null;
  } catch {
    return null;
  }
}

/** Verify a reset token against the user's CURRENT salt and the expiry. */
export function verifyResetToken(
  token: string | undefined | null,
  user: { id: string; password_salt?: string },
): boolean {
  if (!token || typeof token !== 'string') return false;
  const dot = token.indexOf('.');
  if (dot < 0) return false;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const key = getSecret() + (user.password_salt ?? '');
  const expected = crypto.createHmac('sha256', key).update(body).digest('base64url');
  if (expected.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return false;
  }
  let payload: { uid?: string; exp?: number };
  try {
    payload = JSON.parse(b64urlDecode(body).toString('utf8'));
  } catch {
    return false;
  }
  if (payload.uid !== user.id) return false;
  if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return false;
  return true;
}

/* ---------- API keys (cross-origin / headless / agent auth) ---------- */

const API_KEY_PREFIX = 'abk_'; // AstroBaaS key

/**
 * Mint a new API key. Returns the full secret (shown to the operator ONCE), a
 * short display prefix, and the at-rest hash. The full key is never stored.
 */
export function generateApiKey(): { key: string; prefix: string; hash: string } {
  const secret = crypto.randomBytes(24).toString('base64url');
  const key = `${API_KEY_PREFIX}${secret}`;
  const prefix = key.slice(0, 12); // e.g. "abk_AbCdEf" — safe to display
  return { key, prefix, hash: hashApiKey(key) };
}

/** Hash an API key for storage/compare (SHA-256; keys are high-entropy). */
export function hashApiKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}

/** Constant-time check that a presented key matches a stored hash. */
export function apiKeyMatches(presented: string, storedHash: string): boolean {
  if (!presented || !storedHash) return false;
  const a = Buffer.from(hashApiKey(presented), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Extract a bearer token from an Authorization header, or null. */
export function bearerToken(header: string | null | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1]!.trim() : null;
}

/** HMAC-SHA256 hex signature for webhook payloads. */
export function signWebhook(secret: string, body: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

export function newWebhookSecret(): string {
  return crypto.randomBytes(24).toString('base64url');
}

/* ---------- cookie helpers ---------- */

export interface CookieOpts {
  maxAgeMs?: number;
  httpOnly?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  secure?: boolean;
  path?: string;
}

export function serializeCookie(name: string, value: string, opts: CookieOpts = {}): string {
  const parts = [`${name}=${value}`];
  parts.push(`Path=${opts.path ?? '/'}`);
  parts.push(`SameSite=${opts.sameSite ?? 'Lax'}`);
  if (opts.httpOnly !== false) parts.push('HttpOnly');
  if (opts.secure) parts.push('Secure');
  if (typeof opts.maxAgeMs === 'number') {
    parts.push(`Max-Age=${Math.floor(opts.maxAgeMs / 1000)}`);
  }
  return parts.join('; ');
}

export function clearCookie(name: string): string {
  const secure = cookieSecure() ? '; Secure' : '';
  return `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure}`;
}

export const sessionTtlMs = SESSION_TTL_MS;
