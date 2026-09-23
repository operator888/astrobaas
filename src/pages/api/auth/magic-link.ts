import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { makeMagicLinkToken, verifyPassword, dummyVerifyPassword, isProductionRuntime } from '../../../lib/auth';
import { SEED_PASSWORD } from '../../../lib/seed-data';
import { sendEmail, emailChannelActive } from '../../../lib/email';
import { sharedRateLimitStore } from '../../../lib/rate-limit';
import { renderStoredTemplate } from '../../../lib/email-templates';
import { captchaCheck } from '../../../lib/captcha';

/**
 * Request a sign-in link by email — the Shopify-style passwordless option.
 *
 * Modeled line for line on /api/auth/forgot, because it has the same threat
 * model: a public endpoint that turns an email address into an email. Same
 * rules, same reasons:
 *
 *  - ALWAYS the same generic 200 — unknown address, inactive account,
 *    throttled, send failure, even "this install has no email channel".
 *    Anything else is an account-enumeration oracle.
 *  - Its own per-IP+email throttle (same budget as forgot-password), so it
 *    cannot be used to bomb an inbox.
 *  - Gated on emailChannelActive(): with the console transport the link
 *    would land in a server log — an unusable product surface AND
 *    credentials printed where logs are shipped. The login page hides the
 *    option for the same reason; this is the enforcement behind the curtain.
 *  - In production, an account still wearing the seeded password gets no
 *    link (matching the login endpoint's refusal): a magic link must not
 *    become the side door into an install whose front door is barred for
 *    being on default credentials.
 *
 * Accepts JSON and form posts; the form path answers 303 back to /login
 * with the same neutral "sent" notice either way.
 */
export const prerender = false;

const WINDOW_MS = 15 * 60 * 1000;
const LIMIT = 5;

export const POST: APIRoute = async ({ request, locals }) => {
  const ct = request.headers.get('content-type') || '';
  const isForm = !ct.includes('application/json');

  const generic = () => isForm
    ? new Response(null, { status: 303, headers: { Location: '/login?sent=1' } })
    : ApiResponseBuilder.success(null, 'If that email is registered, a sign-in link has been sent.');

  try {
    await LocalDB.init();
    let email = '';
    let powToken = '';
    if (isForm) {
      const form = await request.formData();
      email = String(form.get('email') ?? '').trim().toLowerCase();
      powToken = String(form.get('pow_token') ?? '');
    } else {
      const body = await request.json().catch(() => null);
      email = String((body as any)?.email ?? '').trim().toLowerCase();
      powToken = String((body as any)?.pow_token ?? '');
    }

    // Proof-of-work, when the operator switched it on for this form (the
    // `magic-link` surface). Checked before anything about the address, as
    // /api/auth/forgot does: a failed check is an honest refusal that says
    // only that a hash was not computed, and every answer after it stays
    // generic. The per-address throttle below still stands behind it.
    const pow = await captchaCheck(powToken || undefined, 'magic-link');
    if (!pow.ok) {
      return isForm
        ? new Response(null, { status: 303, headers: { Location: '/login?error=captcha' } })
        : ApiResponseBuilder.forbidden('Anti-spam check failed — reload the page and try again');
    }

    if (!email || email.length > 200) return generic();

    if (!emailChannelActive()) return generic();

    const allowed = await sharedRateLimitStore().hit(
      `magiclink:${locals.ip}|${email}`, WINDOW_MS, LIMIT,
    );
    if (!allowed) return generic();

    const user = await LocalDB.getUserByEmail(email);
    const eligible = !!(user && user.status === 'active' && user.password_hash && user.password_salt);

    // Equalize timing between a real account and an unknown one, the way
    // login.ts does. The eligible path runs a PBKDF2 (the seed-password check)
    // and, without compensation, an unknown email would return visibly faster
    // — a latency oracle for "is this a real active account?". So the miss
    // path burns an equivalent PBKDF2 too, and the email send is dispatched
    // fire-and-forget so its network latency never colours the response.
    if (!eligible) {
      // Awaited (S3.8): un-awaited, the async hash would not slow this path.
      await dummyVerifyPassword(email);
      return generic();
    }

    if (
      isProductionRuntime()
      && !process.env.ALLOW_SEED_PASSWORD
      // Awaited (S3.8): a bare Promise is truthy, so without it this refused
      // every account in production.
      && (await verifyPassword(SEED_PASSWORD, user!.password_hash!, user!.password_salt!))
    ) {
      return generic();
    }
    const token = makeMagicLinkToken(user!);
    const origin = process.env.SITE_URL?.replace(/\/$/, '') || new URL(request.url).origin;
    const link = `${origin}/api/auth/magic?token=${encodeURIComponent(token)}`;
    // Fire-and-forget: the send's I/O latency must not distinguish this
    // response from the miss path's. Delivery failures are swallowed, as on
    // /api/auth/forgot, so nothing leaks whether the address exists.
    // Operator-editable wording (C-112), with the built-in text as the
    // fallback. The LINK is required by the template definition, so an operator
    // cannot save a version of this email that cannot sign anybody in.
    const site = (await LocalDB.getSetting('site_title'))?.value;
    const mail = await renderStoredTemplate('magic_link', {
      site_title: site ?? 'this site',
      sign_in_link: link,
      expires_in: '15 minutes',
    }, (key) => LocalDB.getSetting(key));
    void sendEmail({
      to: user!.email,
      subject: mail!.subject,
      text: mail!.text,
    }).catch((err) => console.error('Magic-link email failed to send:', err instanceof Error ? err.message : err));

    return generic();
  } catch (err) {
    console.error('Magic-link request error:', err);
    return generic();
  }
};
