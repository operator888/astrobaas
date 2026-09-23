import type { APIRoute } from 'astro';
import { LocalDB } from '../../lib/localdb';
import { ApiResponseBuilder } from '../../lib/api-response';
import { validate } from '../../lib/validate';
import { publicSubmissionGate } from '../../lib/public-submission';
import { makeConfirmToken, confirmUrl, confirmEmail } from '../../lib/newsletter-confirm';
import { sendEmail, emailChannelActive } from '../../lib/email';
import { emailTemplateKey } from '../../lib/email-templates';
import { allowRecipient, NEWSLETTER_CONFIRM_BUDGET } from '../../lib/recipient-throttle';

// Public endpoint (anonymous). Middleware still enforces CSRF + rate limiting.
export const POST: APIRoute = async ({ request, locals }) => {
  try {
    await LocalDB.init();
    const body = await request.json().catch(() => null);
    const result = validate<{ email: string; hp_url?: string; pow_token?: string }>(body, {
      email: { type: 'string', min: 3, max: 200, pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/ },
      hp_url: { type: 'string', max: 200, optional: true }, // honeypot
      pow_token: { type: 'string', max: 5000, optional: true }, // proof-of-work, if enabled
    });
    if (!result.ok) return ApiResponseBuilder.validationError('Invalid email', result.errors);

    // The SHARED gate, which is also where this form gains a form-shaped rate
    // limit it never had. A mailing list stuffed with fake addresses is a
    // deliverability problem that outlives the spam run — and the middleware's
    // generic per-IP write limit is sized for an API client, not for a person
    // typing an address into a footer.
    //
    // Not SCORED: the only value here is an email address, and every structural
    // signal the scorer looks for would be measuring the wrong thing.
    const gate = await publicSubmissionGate({
      surface: 'newsletter', ip: locals.ip ?? 'unknown', body,
      captchaSurface: 'newsletter', score: false,
    });
    if (gate.kind === 'rate-limited') {
      return ApiResponseBuilder.error(429, 'Too many signups. Please try again later.');
    }
    if (gate.kind === 'silent') return ApiResponseBuilder.success(null, 'Subscribed');
    if (gate.kind === 'challenge-failed') {
      return ApiResponseBuilder.forbidden('Please try again (anti-spam check failed)');
    }

    // DOUBLE OPT-IN. Nothing is stored here — the address only joins the list
    // when the person who owns it clicks the link. Before this, typing a
    // stranger's address into the blog footer put them on a Greek shop's
    // mailing list without their ever having asked.
    // With no mail channel there is no way to deliver the confirmation, so the
    // address could never join the list — and answering 201 "check your email"
    // would be a lie the visitor cannot act on. Refuse instead, and say why.
    if (!emailChannelActive()) {
      return ApiResponseBuilder.serverError(
        'The newsletter is not accepting signups right now. Please contact us directly.',
      );
    }

    const email = result.value.email.trim().toLowerCase();
    const origin = process.env.SITE_URL?.replace(/\/$/, '') || new URL(request.url).origin;
    const siteTitle = (await LocalDB.getSetting('site_title'))?.value;

    // The operator's template override (C-112), read here because this is the
    // layer with a database — `confirmEmail` stays pure.
    const tpl = (await LocalDB.getSetting(emailTemplateKey('newsletter_confirm')))?.value;

    // PER RECIPIENT, after the per-IP gate. The gate protects the shop from one
    // client; this protects the person whose address was typed. Without it, any
    // number of IPs could make this shop email the same stranger a confirmation
    // every few seconds — see lib/recipient-throttle.ts.
    //
    // One per mailbox per day, and the response below is the SAME 201 whether
    // or not a mail went out: "a confirmation is already pending for this
    // address" is exactly the fact this endpoint must not disclose. Checked
    // AFTER the settings reads above, so a throttled request does the same work
    // and does not answer measurably faster than one that sends.
    if (await allowRecipient(NEWSLETTER_CONFIRM_BUDGET, email)) {
      void sendEmail(confirmEmail(
        email,
        confirmUrl(origin, makeConfirmToken(email)),
        typeof siteTitle === 'string' ? siteTitle : undefined,
        tpl,
      )).catch((err) => {
        console.error('Newsletter confirmation email failed:', err instanceof Error ? err.message : err);
      });
    }

    // The SAME answer whether or not that address is already on the list, and
    // whether or not the mail went out. Anything else turns this endpoint into
    // a way to ask "is this person subscribed to your shop?".
    return ApiResponseBuilder.created(null, 'Check your email to confirm your subscription');
  } catch (err) {
    console.error('Newsletter submit error:', err);
    return ApiResponseBuilder.serverError('Failed to subscribe');
  }
};
