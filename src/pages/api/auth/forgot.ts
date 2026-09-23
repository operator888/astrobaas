import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { makeResetToken, dummyVerifyPassword } from '../../../lib/auth';
import { sendEmail } from '../../../lib/email';
import { captchaCheck } from '../../../lib/captcha';
import { renderStoredTemplate } from '../../../lib/email-templates';

// Public. Start a password reset. ALWAYS returns the same generic success
// response whether or not the email exists, so it can't be used to enumerate
// accounts. Rate-limited by the middleware. CSRF-exempt (it's an /api/auth/ flow
// with its own single-use token sent out-of-band by email).
export const POST: APIRoute = async ({ request, locals }) => {
  try {
    await LocalDB.init();
    const body = await request.json().catch(() => null);
    const email = String((body as any)?.email ?? '').trim().toLowerCase();

    const generic = ApiResponseBuilder.success(
      null,
      'If that email is registered, a password-reset link has been sent.',
    );
    if (!email) return generic;

    // Proof-of-work, when enabled for this form. A failed check is an HONEST
    // 403 — it reveals only that a hash was not computed, nothing about
    // accounts — while everything below stays deliberately generic. The
    // untouchable forgot-password limiter still stands behind it.
    const pow = await captchaCheck(String((body as any)?.pow_token ?? '') || undefined, 'forgot');
    if (!pow.ok) {
      return ApiResponseBuilder.forbidden('Anti-spam check failed — reload the page and try again');
    }

    // Anti email-bombing: over the per-IP+email limit we silently skip sending
    // but STILL return the generic response (no throttle signal to probe with).
    const allow = locals.forgotRateCheck;
    if (allow && !(await allow(email))) return generic;

    const user = await LocalDB.getUserByEmail(email);
    const eligible = !!(user && user.status === 'active' && user.password_salt);

    // Equalize timing the way /api/auth/magic-link does. The eligible path
    // signs a token and dispatches an email; without compensation an unknown
    // address returns visibly faster — a latency oracle for "is this a real
    // account?". So the miss path burns an equivalent PBKDF2, and the send is
    // FIRE-AND-FORGET so its network I/O never colours the response. The first
    // version awaited the send inline, which is exactly the oracle the
    // magic-link path documents avoiding.
    if (!eligible) {
      // Awaited: the hash runs off the event loop now (S3.8), so an un-awaited
      // call would return at once and bring the latency oracle back.
      await dummyVerifyPassword(email);
      return generic;
    }

    const token = makeResetToken(user!);
    const origin = process.env.SITE_URL?.replace(/\/$/, '') || new URL(request.url).origin;
    const link = `${origin}/reset-password?token=${encodeURIComponent(token)}`;
    // Operator-editable wording (C-112). `{{reset_link}}` is required by the
    // template definition: an email that sends, looks fine and cannot reset
    // anything is a support ticket the operator never sees coming.
    const siteTitle = (await LocalDB.getSetting('site_title'))?.value;
    const mail = await renderStoredTemplate('password_reset', {
      site_title: siteTitle ?? 'this site',
      reset_link: link,
      expires_in: 'one hour',
    }, (key) => LocalDB.getSetting(key));
    void sendEmail({
      to: user!.email,
      subject: mail!.subject,
      text: mail!.text,
    }).catch((err) => {
      // Never reveal delivery success/failure to the caller (no enumeration).
      console.error('Password-reset email failed to send:', err instanceof Error ? err.message : err);
    });
    return generic;
  } catch (err) {
    console.error('Password forgot error:', err);
    // Still generic — don't leak internal state.
    return ApiResponseBuilder.success(null, 'If that email is registered, a password-reset link has been sent.');
  }
};
