import type { APIRoute } from 'astro';
import { SEED_PASSWORD } from '../../../lib/seed-data';
import { LocalDB } from '../../../lib/localdb';
import {
  verifyPassword,
  dummyVerifyPassword,
  signSession,
  serializeCookie,
  clearCookie,
  cookieSecure,
  csrfCookie,
  SESSION_COOKIE,
  CSRF_COOKIE,
  sessionTtlMs,
  safeRedirectPath,
  signPending2fa,
  verifyPending2fa,
  PENDING_2FA_COOKIE,
  isProductionRuntime,
} from '../../../lib/auth';
import { checkSecondFactor } from '../../../lib/twofactor';
import { captchaEnabledFor, makeChallenge, verifyPow } from '../../../lib/captcha';
import { sharedRateLimitStore } from '../../../lib/rate-limit';
import {
  accountNeedsProof, recordLoginFailure, secondFactorAttemptAllowed, resolveLoginLimits,
  POW_REQUIRED_CODE,
} from '../../../lib/login-guard';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { recordAudit, AUDIT } from '../../../lib/audit';
import type { User } from '../../../core/models';

export const POST: APIRoute = async ({ request, cookies, locals }) => {
  try {
    await LocalDB.init();
    const ct = request.headers.get('content-type') || '';
    const isForm = !ct.includes('application/json');
    let email = '';
    let password = '';
    let code = '';
    let next = '/admin';
    let powToken = '';

    if (!isForm) {
      const body = await request.json();
      email = String(body?.email ?? '').trim();
      password = String(body?.password ?? '');
      code = String(body?.code ?? body?.totp ?? '').trim();
      next = String(body?.next ?? '/admin') || '/admin';
      powToken = String(body?.pow_token ?? '');
    } else {
      const form = await request.formData();
      email = String(form.get('email') ?? '').trim();
      password = String(form.get('password') ?? '');
      code = String(form.get('code') ?? '').trim();
      next = String(form.get('next') ?? '/admin') || '/admin';
      powToken = String(form.get('pow_token') ?? '');
    }

    const safeNext = safeRedirectPath(next);
    const store = sharedRateLimitStore();
    const limits = resolveLoginLimits();
    const ip = locals.ip ?? 'unknown';

    const bad = (msg: string) =>
      isForm
        ? new Response(null, { status: 303, headers: { Location: `/login?error=bad&next=${encodeURIComponent(next)}` } })
        : ApiResponseBuilder.unauthorized(msg);

    const tooMany = (form303: string) => {
      const msg = 'Too many login attempts. Try again later.';
      return isForm
        ? new Response(null, { status: 303, headers: { Location: `${form303}&next=${encodeURIComponent(next)}` } })
        : new Response(JSON.stringify({ success: false, error: { message: msg, code: 'RATE_LIMITED' } }), { status: 429, headers: { 'Content-Type': 'application/json' } });
    };

    // Proof-of-work FIRST, before credentials are even looked at: when the
    // operator turns it on for login, a credential-stuffing run must pay the
    // hash cost per attempt before it gets to spend the login throttle's
    // budget. Distinct error so a human with JavaScript off learns what is
    // actually wrong instead of "bad password".
    //
    // `captchaCheck` spelled out as its two halves, because the per-account
    // rule below needs to know which one applied: a proof this check already
    // consumed must not be verified a second time and refused as a replay.
    const surfaceOn = await captchaEnabledFor('login');
    const pow = surfaceOn ? await verifyPow(powToken || undefined, 'login') : { ok: true as const };
    if (!pow.ok) {
      return isForm
        ? new Response(null, { status: 303, headers: { Location: `/login?error=captcha&next=${encodeURIComponent(next)}` } })
        : ApiResponseBuilder.forbidden('Anti-spam check failed — reload the page and try again');
    }

    // Issue the session cookie + success response for a fully-authenticated user.
    // Also clears any pending-2FA cookie left over from a two-step login.
    const succeed = async (user: User) => {
      await LocalDB.touchLogin(user.id);
      recordAudit(AUDIT.LOGIN_SUCCESS, { actor: user.id, target: user.email, ip: locals.ip });
      const token = signSession({ uid: user.id, role: user.role, sv: user.session_version ?? 0 });
      const cookie = serializeCookie(SESSION_COOKIE, token, { maxAgeMs: sessionTtlMs, sameSite: 'Lax', secure: cookieSecure() });
      // S3.13: the middleware now sets the CSRF cookie only on HTML pages. A
      // browser signing in has already loaded /login and holds one; a script
      // signing in over JSON never loads a page, so the response that starts
      // its session hands it the token its first write will need. A sign-in
      // response already sets a cookie, so this costs no cacheability.
      const needsCsrf = !cookies.get(CSRF_COOKIE)?.value && !!locals.csrf;
      if (!isForm) {
        const res = ApiResponseBuilder.success(
          { id: user.id, email: user.email, name: user.name, role: user.role },
          'Logged in',
        );
        res.headers.append('Set-Cookie', cookie);
        res.headers.append('Set-Cookie', clearCookie(PENDING_2FA_COOKIE));
        if (needsCsrf) res.headers.append('Set-Cookie', csrfCookie(locals.csrf));
        return res;
      }
      const res = new Response(null, { status: 303, headers: { Location: safeNext } });
      res.headers.append('Set-Cookie', cookie);
      res.headers.append('Set-Cookie', clearCookie(PENDING_2FA_COOKIE));
      if (needsCsrf) res.headers.append('Set-Cookie', csrfCookie(locals.csrf));
      return res;
    };

    // Consume a backup code (if one was used) so it can't be replayed.
    const consumeBackupIfUsed = async (user: User, idx: number) => {
      if (idx < 0 || !user.two_factor) return;
      const remaining = (user.two_factor.backup_codes ?? []).filter((_, i) => i !== idx);
      await LocalDB.updateUser(user.id, { two_factor: { ...user.two_factor, backup_codes: remaining } });
      recordAudit(AUDIT.TWOFA_BACKUP_USED, { actor: user.id, ip: locals.ip });
    };

    const twoFactorFailResponse = () =>
      isForm
        ? new Response(null, { status: 303, headers: { Location: `/login?twofa=1&error=code&next=${encodeURIComponent(next)}` } })
        : new Response(JSON.stringify({ success: false, error: { message: 'Invalid two-factor code', code: 'TOTP_INVALID' } }), { status: 401, headers: { 'Content-Type': 'application/json' } });

    /**
     * S3.10: every code check is counted per account BEFORE it runs. The
     * pending-2FA path below used to sit in front of every throttle and count
     * nothing, so one pending cookie was an unlimited supply of guesses.
     */
    const secondFactor = async (user: User, submitted: string): Promise<Response> => {
      if (!(await secondFactorAttemptAllowed(store, user.id, limits))) {
        recordAudit(AUDIT.LOGIN_THROTTLED, { actor: user.id, ip: locals.ip, metadata: { step: '2fa' } });
        return tooMany('/login?twofa=1&error=rate');
      }
      const chk = checkSecondFactor(user.two_factor, submitted);
      if (!chk.ok) {
        recordAudit(AUDIT.TWOFA_FAILED, { actor: user.id, ip: locals.ip });
        return twoFactorFailResponse();
      }
      await consumeBackupIfUsed(user, chk.consumedBackupIndex);
      return succeed(user);
    };

    // ---- Step 2: a pending-2FA cookie + a code (no password re-entry) ----
    const pending = verifyPending2fa(cookies.get(PENDING_2FA_COOKIE)?.value);
    if (pending && code && !password) {
      const user = await LocalDB.getUser(pending.uid);
      if (!user || user.status !== 'active' || !user.two_factor?.enabled) return bad('Invalid credentials');
      return secondFactor(user, code);
    }

    // ---- Step 1: email + password ----
    if (!email || !password) return bad('Email and password are required');

    const loginFailed = async () => {
      recordAudit(AUDIT.LOGIN_FAILED, { actor: email || 'anonymous', ip: locals.ip });
      // Counted for ANY submitted email, registered or not — see login-guard.
      await recordLoginFailure(store, ip, email, limits);
      return bad('Invalid credentials');
    };

    const allow = locals.loginRateCheck;
    if (allow && !(await allow(email))) {
      recordAudit(AUDIT.LOGIN_THROTTLED, { actor: email || 'anonymous', ip: locals.ip });
      return tooMany('/login?error=rate');
    }

    // ---- S3.9: an account under attack requires proof-of-work ----
    //
    // After enough failures for this email from ANYWHERE, a password is only
    // looked at when it arrives with a solved challenge — even if the operator
    // has not switched the login captcha on. Checked BEFORE the hash, so a
    // guessing run cannot learn anything without paying. When the operator's
    // switch IS on, `captchaCheck` above already demanded and consumed a proof.
    //
    // Never a lock: the admin sign-in page embeds a challenge and solves it in
    // the background, so the owner signs in exactly as before.
    if (!surfaceOn && await accountNeedsProof(store, email, limits)) {
      const proof = await verifyPow(powToken || undefined, 'login');
      if (!proof.ok) {
        recordAudit(AUDIT.LOGIN_THROTTLED, {
          actor: email || 'anonymous', ip: locals.ip, metadata: { reason: 'proof-of-work-required', proof: proof.reason },
        });
        if (isForm) {
          return new Response(null, { status: 303, headers: { Location: `/login?error=pow&next=${encodeURIComponent(next)}` } });
        }
        const challenge = makeChallenge('login');
        return new Response(JSON.stringify({
          success: false,
          error: {
            message: 'This account has had too many failed sign-ins. Solve the included proof-of-work challenge and send it as pow_token.',
            code: POW_REQUIRED_CODE,
            reason: 'login.proof_of_work_required',
            details: { surface: 'login', challenge },
          },
        }), { status: 403, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
      }
    }

    const user = await LocalDB.getUserByEmail(email);
    // Constant-time on the not-found / inactive paths (same PBKDF2 work) so the
    // response timing doesn't reveal whether an email is registered. AWAITED:
    // the hash is async now (S3.8), and an un-awaited dummy would answer at
    // once — the very timing difference it exists to hide.
    if (!user || !user.password_hash || !user.password_salt) {
      await dummyVerifyPassword(password);
      return loginFailed();
    }
    if (user.status !== 'active') {
      await dummyVerifyPassword(password);
      return loginFailed();
    }
    if (!(await verifyPassword(password, user.password_hash, user.password_salt))) {
      return loginFailed();
    }

    // Refuse the seeded password in production.
    //
    // `admin` was a convenient default while this repo was private. Once it is
    // public it is not a default, it is a PUBLISHED credential — every install
    // that kept it is one /login scan away from takeover. Rejecting it here
    // protects deployments that already exist, which changing the seed alone
    // cannot do.
    //
    // Deliberately a distinct error rather than a generic failure: the operator
    // is not an attacker, they are someone who needs to be told what to do. An
    // attacker learns only that the install is not using the default, which is
    // exactly what we want them to conclude.
    //
    // D2-7: keyed on isProductionRuntime(), not NODE_ENV. The refusal has to
    // hold for `node ./dist/server/entry.mjs` — the bare-metal path that never
    // sets NODE_ENV and is precisely where an unattended install would still be
    // answering to the published default.
    if (
      isProductionRuntime()
      && password === SEED_PASSWORD
      && !process.env.ALLOW_SEED_PASSWORD
    ) {
      recordAudit(AUDIT.LOGIN_FAILED, { actor: user.id, ip: locals.ip, metadata: { reason: 'seed-password-refused' } });
      return new Response(JSON.stringify({
        success: false,
        error: {
          message:
            'This install is still using the default password. Set a new one with '
            + '`npm run reset-password` before signing in. (To override for a trusted '
            + 'private deployment, set ALLOW_SEED_PASSWORD=1.)',
          code: 'SEED_PASSWORD_REFUSED',
        },
      }), { status: 403, headers: { 'Content-Type': 'application/json' } });
    }

    // Password OK. If 2FA is on, require the second factor.
    if (user.two_factor?.enabled) {
      if (code) {
        // Inline (single-shot) — the SDK/API can submit password + code together.
        return secondFactor(user, code);
      }
      // No code yet → issue the short-lived pending cookie and ask for it.
      const pendingCookie = serializeCookie(PENDING_2FA_COOKIE, signPending2fa(user.id), { maxAgeMs: 5 * 60 * 1000, sameSite: 'Lax', secure: cookieSecure() });
      if (isForm) {
        const res = new Response(null, { status: 303, headers: { Location: `/login?twofa=1&next=${encodeURIComponent(next)}` } });
        res.headers.append('Set-Cookie', pendingCookie);
        return res;
      }
      const res = new Response(JSON.stringify({ success: false, error: { message: 'Two-factor code required', code: 'TOTP_REQUIRED' } }), { status: 401, headers: { 'Content-Type': 'application/json' } });
      res.headers.append('Set-Cookie', pendingCookie);
      return res;
    }

    return succeed(user);
  } catch (err) {
    console.error('Login error:', err);
    return ApiResponseBuilder.serverError('Login failed');
  }
};
