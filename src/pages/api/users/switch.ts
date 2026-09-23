import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import {
  SESSION_COOKIE, SWITCH_COOKIE, SWITCH_TTL_MS,
  signSession, signSwitchBack, verifySwitchBack,
  serializeCookie, clearCookie, cookieSecure, sessionTtlMs,
} from '../../../lib/auth';
import { recordAudit, AUDIT } from '../../../lib/audit';

export const prerender = false;

/**
 * POST   /api/users/switch  { user_id }  — start acting as another user
 * DELETE /api/users/switch                — go back to being yourself
 *
 * ## The support case this exists for
 *
 * "The Publish button does nothing for me." An admin cannot see what a shop
 * manager sees, because the admin's own role changes what renders. The
 * alternative operators actually use is asking for the person's password,
 * which is worse in every way — including that it cannot be audited.
 *
 * ## The four rules that keep it from being a back door
 *
 *  1. **Admin only.** Anyone else gets 403.
 *  2. **Never onto another admin.** A switch that can reach admin turns one
 *     admin's compromise into every admin's, and gains a legitimate user
 *     nothing — an admin can already do anything an admin can do.
 *  3. **No chains.** Already switched? Switch back first. Nested impersonation
 *     makes "who was really acting" unanswerable, which is the one question
 *     this must always be able to answer.
 *  4. **Time-boxed and audited at both ends.** An hour, and both directions
 *     write an audit entry naming the real admin.
 *
 * ## What is NOT claimed
 *
 * Actions taken while switched are audited as the impersonated user — the
 * request genuinely is them. The two bracket entries are what attributes that
 * window to an admin. That is a real limitation and it is why the rules above
 * are strict rather than convenient.
 */

const isAdmin = (locals: App.Locals) => locals.user?.role === 'admin';

export const POST: APIRoute = async ({ request, locals, cookies }) => {
  try {
    if (!locals.user) return ApiResponseBuilder.unauthorized();
    if (!isAdmin(locals)) return ApiResponseBuilder.forbidden('Only an admin can switch user');
    // Rule 3, checked before anything else: a chain would make the audit
    // bracket ambiguous, and the switch-back cookie only holds one origin.
    if (verifySwitchBack(cookies.get(SWITCH_COOKIE)?.value)) {
      return ApiResponseBuilder.badRequest('You are already acting as someone else. Switch back first.');
    }

    await LocalDB.init();
    const body = await request.json().catch(() => null) as { user_id?: unknown } | null;
    const targetId = String(body?.user_id ?? '').trim();
    if (!targetId) return ApiResponseBuilder.badRequest('user_id is required');
    if (targetId === locals.user.id) return ApiResponseBuilder.badRequest('That is already you.');

    const target = await LocalDB.getUser(targetId);
    if (!target) return ApiResponseBuilder.notFound('User');
    if (target.status !== 'active') return ApiResponseBuilder.badRequest('That account is not active.');
    if (target.role === 'admin') {
      return ApiResponseBuilder.forbidden('You cannot act as another admin.');
    }

    const me = await LocalDB.getUser(locals.user.id);
    if (!me) return ApiResponseBuilder.unauthorized();

    const session = signSession({ uid: target.id, role: target.role, sv: target.session_version ?? 0 });
    // The way back is signed with OUR identity and session version, so the
    // return trip re-checks this admin's account exactly as a login would —
    // AND with the id being impersonated, so the token is only honoured for the
    // session it was issued for.
    const back = signSwitchBack(me.id, me.session_version ?? 0, target.id);

    recordAudit(AUDIT.USER_SWITCH_START, {
      actor: me.id,
      target: target.email,
      ip: locals.ip,
      metadata: { target_id: target.id, target_role: target.role, expires_in_ms: SWITCH_TTL_MS },
    });

    const res = ApiResponseBuilder.success(
      { id: target.id, name: target.name, role: target.role },
      `Acting as ${target.name || target.email}`,
    );
    // The impersonated session lives exactly as long as the switch does.
    // `sessionTtlMs` is 24 HOURS — using it here meant the switch cookie
    // expired after an hour, the banner vanished, the way back stopped
    // working, and the admin's browser stayed authenticated as somebody else
    // until the next day with nothing on screen to say so. That is the
    // "spare login" the hour was supposed to prevent, arrived at from the
    // other direction.
    res.headers.append('Set-Cookie', serializeCookie(SESSION_COOKIE, session, { maxAgeMs: SWITCH_TTL_MS, sameSite: 'Lax', secure: cookieSecure() }));
    res.headers.append('Set-Cookie', serializeCookie(SWITCH_COOKIE, back, { maxAgeMs: SWITCH_TTL_MS, sameSite: 'Lax', secure: cookieSecure() }));
    return res;
  } catch (err) {
    console.error('User switch error:', err);
    return ApiResponseBuilder.serverError('Could not switch user');
  }
};

export const DELETE: APIRoute = async ({ locals, cookies }) => {
  try {
    const back = verifySwitchBack(cookies.get(SWITCH_COOKIE)?.value);
    // Deliberately NOT admin-gated: the caller is currently the impersonated
    // user, whose role is not admin. Possession of a valid switch-back token is
    // the authorisation.
    if (!back) return ApiResponseBuilder.badRequest('You are not acting as anyone.');

    // ...but the token is only honoured for the SESSION it was issued for.
    //
    // Without this, a switch cookie left on a shared browser is a one-click
    // admin session for whoever signs in next: the admin switches to Bob, logs
    // out — which clears only the session cookie — an editor logs in within the
    // hour, sees the banner, presses "Back to my account", and is handed the
    // admin's session. An audit found exactly that path.
    //
    // Refused rather than ignored, and the stale cookie is cleared on the way
    // out so the banner stops appearing for somebody it was never about.
    if (!locals.user || locals.user.id !== back.acting) {
      const res = ApiResponseBuilder.forbidden('That is not your session to return from.');
      res.headers.append('Set-Cookie', clearCookie(SWITCH_COOKIE));
      return res;
    }

    await LocalDB.init();
    const admin = await LocalDB.getUser(back.uid);
    // Re-checked, not trusted: an admin deactivated or revoked while
    // impersonating does not get their session handed back.
    if (!admin || admin.status !== 'active' || (admin.session_version ?? 0) !== back.sv || admin.role !== 'admin') {
      const res = ApiResponseBuilder.forbidden('That session is no longer valid. Please log in again.');
      res.headers.append('Set-Cookie', clearCookie(SWITCH_COOKIE));
      res.headers.append('Set-Cookie', clearCookie(SESSION_COOKIE));
      return res;
    }

    recordAudit(AUDIT.USER_SWITCH_END, {
      actor: admin.id,
      ip: locals.ip,
      metadata: { was_acting_as: locals.user?.id ?? 'unknown' },
    });

    const session = signSession({ uid: admin.id, role: admin.role, sv: admin.session_version ?? 0 });
    const res = ApiResponseBuilder.success({ id: admin.id, role: admin.role }, 'Back to your own account');
    // A full session again — the admin is themselves from here.
    res.headers.append('Set-Cookie', serializeCookie(SESSION_COOKIE, session, { maxAgeMs: sessionTtlMs, sameSite: 'Lax', secure: cookieSecure() }));
    res.headers.append('Set-Cookie', clearCookie(SWITCH_COOKIE));
    return res;
  } catch (err) {
    console.error('Switch back error:', err);
    return ApiResponseBuilder.serverError('Could not switch back');
  }
};
