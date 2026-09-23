import type { APIRoute } from 'astro';
import {
  clearCookie, verifySession, isSessionRevoked, revocationPatch,
  SESSION_COOKIE, SWITCH_COOKIE,
} from '../../../lib/auth';
import { LocalDB } from '../../../lib/localdb';

/**
 * Sign out.
 *
 * BOTH cookies, and it has to be both. The switch cookie (C-141) outlives the
 * session it belongs to unless it is cleared here — and left on a shared
 * browser it renders the "you are acting as…" banner, with its way-back button,
 * for whoever signs in next.
 *
 * The route itself now refuses that token unless the current session is the one
 * it was issued for, so this is the second door rather than the only one. It is
 * still worth closing: a banner about somebody else's impersonation is
 * alarming, and an operator cannot tell from looking at it that pressing the
 * button would be refused.
 *
 * `headers.append`, not a `Set-Cookie` value in an object literal: an object
 * has one key, so the second cookie silently replaces the first. That is how
 * the first version of this fix left the switch cookie in place while looking
 * correct.
 */
function clearBoth(): Headers {
  const headers = new Headers();
  headers.append('Set-Cookie', clearCookie(SESSION_COOKIE));
  headers.append('Set-Cookie', clearCookie(SWITCH_COOKIE));
  return headers;
}

/**
 * Revoke the presented session token on the server (S3.11).
 *
 * Clearing the cookie only asks THIS browser to forget the token. Anybody who
 * copied it — from a shared machine, a proxy log, a stolen laptop's disk — kept
 * a working session for the rest of its 24 hours. Now the token's id is noted
 * on the account and the middleware refuses it from then on. See
 * `revocationPatch` in lib/auth.ts for why this is per token rather than
 * "sign out everywhere", and the one case where it falls back to that.
 *
 * Written, then READ BACK. `updateUser` is read-merge-write on the SQL
 * drivers, so a concurrent write to the same account (a sign-in stamping
 * `last_login`) can land between our read and our write and put the old list
 * back. A revocation that silently did not happen is the failure this exists
 * to prevent, so if the note is not there afterwards the account's
 * `session_version` is bumped instead — which no merge can undo.
 *
 * Best effort in one direction only: a storage error must not stop the cookie
 * being cleared, so the browser is always signed out.
 */
async function revokePresented(token: string | undefined): Promise<void> {
  const payload = verifySession(token);
  if (!payload) return;
  try {
    await LocalDB.init();
    const user = await LocalDB.getUser(payload.uid);
    // A token the middleware would already refuse needs no note.
    if (!user || (user.session_version ?? 0) !== payload.sv || isSessionRevoked(user, payload)) return;
    const patch = revocationPatch(user, payload);
    await LocalDB.updateUser(user.id, patch);
    if (patch.session_version !== undefined) return;
    const after = await LocalDB.getUser(user.id);
    if (after && (after.session_version ?? 0) === payload.sv && !isSessionRevoked(after, payload)) {
      await LocalDB.updateUser(user.id, { session_version: (after.session_version ?? 0) + 1, revoked_sessions: [] });
    }
  } catch (err) {
    console.error('Logout revocation error (cookie still cleared):', err instanceof Error ? err.message : err);
  }
}

export const POST: APIRoute = async ({ request, cookies }) => {
  await revokePresented(cookies.get(SESSION_COOKIE)?.value);
  const ct = request.headers.get('content-type') || '';
  const headers = clearBoth();

  if (ct.includes('application/json')) {
    headers.set('Content-Type', 'application/json');
    return new Response(JSON.stringify({ success: true, data: null, message: 'Logged out' }), {
      status: 200,
      headers,
    });
  }

  headers.set('Location', '/login');
  return new Response(null, { status: 303, headers });
};

export const GET: APIRoute = async ({ cookies }) => {
  // The same revocation as POST. A cross-site link can reach this — and could
  // already sign the visitor out by clearing the cookie — so revoking the
  // token as well gives such a link nothing it did not have.
  await revokePresented(cookies.get(SESSION_COOKIE)?.value);
  const headers = clearBoth();
  headers.set('Location', '/login');
  return new Response(null, { status: 303, headers });
};
