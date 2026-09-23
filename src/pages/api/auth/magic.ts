import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import {
  verifyMagicLinkToken,
  signSession,
  serializeCookie,
  clearCookie,
  cookieSecure,
  SESSION_COOKIE,
  sessionTtlMs,
  signPending2fa,
  PENDING_2FA_COOKIE,
  MAGIC_LINK_TTL_MS,
} from '../../../lib/auth';
import { recordAudit, AUDIT } from '../../../lib/audit';
import { sharedRateLimitStore } from '../../../lib/rate-limit';

/**
 * Consume a sign-in link. GET, because it arrives as a link in an inbox.
 *
 * The token already proves control of the mailbox within the last fifteen
 * minutes; this route adds the checks the token cannot carry:
 *
 *  - SINGLE USE: the token's jti is marked consumed through the shared
 *    rate-limit store before any cookie is issued. Clicked twice — or
 *    replayed from a forwarded email — the second click lands on the login
 *    page, not in a session.
 *  - The account must still exist, still be active, and its
 *    `session_version` must match the one minted into the token: a password
 *    change or forced logout kills outstanding links exactly as it kills
 *    sessions.
 *  - 2FA IS NOT BYPASSED. Mailbox control is one factor; an account that
 *    enrolled a second one gets the same pending-2FA step as a password
 *    login, and the session only exists after the code.
 *
 * Every failure is the same neutral redirect. The visitor holding a dead
 * link needs "request a new one", not a taxonomy of what went wrong — and
 * an attacker probing tokens gets nothing to measure.
 */
export const prerender = false;

export const GET: APIRoute = async ({ url, locals }) => {
  const dead = () => new Response(null, { status: 303, headers: { Location: '/login?error=magic' } });
  try {
    await LocalDB.init();
    const payload = verifyMagicLinkToken(url.searchParams.get('token'));
    if (!payload) return dead();

    // Mark used FIRST — a race of two clicks must not both win, and a marker
    // must outlive the token regardless of rate-limit window boundaries.
    const claimed = await sharedRateLimitStore().consumeOnce(
      `magic-used:${payload.jti}`, MAGIC_LINK_TTL_MS,
    );
    if (!claimed) return dead();

    const user = await LocalDB.getUser(payload.uid);
    if (!user || user.status !== 'active') return dead();
    if ((user.session_version ?? 0) !== payload.sv) return dead();

    if (user.two_factor?.enabled) {
      // One factor down, one to go — the identical second step a password
      // login gets, carried by the identical purpose-tagged cookie.
      const pendingCookie = serializeCookie(PENDING_2FA_COOKIE, signPending2fa(user.id), {
        maxAgeMs: 5 * 60 * 1000, sameSite: 'Lax', secure: cookieSecure(),
      });
      const res = new Response(null, { status: 303, headers: { Location: '/login?twofa=1' } });
      res.headers.append('Set-Cookie', pendingCookie);
      return res;
    }

    await LocalDB.touchLogin(user.id);
    recordAudit(AUDIT.LOGIN_SUCCESS, {
      actor: user.id, target: user.email, ip: locals.ip, metadata: { method: 'magic-link' },
    });
    const token = signSession({ uid: user.id, role: user.role, sv: user.session_version ?? 0 });
    const cookie = serializeCookie(SESSION_COOKIE, token, {
      maxAgeMs: sessionTtlMs, sameSite: 'Lax', secure: cookieSecure(),
    });
    const res = new Response(null, { status: 303, headers: { Location: '/admin' } });
    res.headers.append('Set-Cookie', cookie);
    res.headers.append('Set-Cookie', clearCookie(PENDING_2FA_COOKIE));
    return res;
  } catch (err) {
    console.error('Magic-link consume error:', err);
    return dead();
  }
};
