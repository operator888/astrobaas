import type { APIRoute } from 'astro';
import { LocalDB } from '../../lib/localdb';
import { ApiResponseBuilder } from '../../lib/api-response';
import { validate } from '../../lib/validate';
import { publicSubmissionGate, spamFields } from '../../lib/public-submission';
import { notifySubmission } from '../../lib/submission-notify';

// Public endpoint (anonymous). Middleware still enforces CSRF + rate limiting.
export const POST: APIRoute = async ({ request, locals }) => {
  try {
    await LocalDB.init();
    const body = await request.json().catch(() => null);
    const result = validate<{
      name: string;
      email: string;
      subject?: string;
      message: string;
      hp_url?: string;
      pow_token?: string;
    }>(body, {
      name: { type: 'string', min: 1, max: 100 },
      email: { type: 'string', min: 3, max: 200, pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/ },
      subject: { type: 'string', max: 200, optional: true },
      message: { type: 'string', min: 1, max: 5000 },
      hp_url: { type: 'string', max: 200, optional: true }, // honeypot
      pow_token: { type: 'string', max: 5000, optional: true }, // proof-of-work, if enabled
    });
    if (!result.ok) return ApiResponseBuilder.validationError('Invalid message', result.errors);

    // The SHARED gate. Before this, contact had a honeypot and a proof of work
    // and NO form-shaped rate limit — only the middleware's generic per-IP
    // write limit, which is set for an API client rather than for a person
    // filling in a form. So the door a stranger is most likely to find was the
    // least protected of the three, and nothing said so.
    const gate = await publicSubmissionGate({
      surface: 'contact', ip: locals.ip ?? 'unknown', body, captchaSurface: 'contact',
    });
    if (gate.kind === 'rate-limited') {
      return ApiResponseBuilder.error(429, 'Too many messages. Please try again later.');
    }
    // Honeypot: humans leave it empty; bots fill it. Pretend success.
    if (gate.kind === 'silent') return ApiResponseBuilder.success(null, 'Message received');
    if (gate.kind === 'challenge-failed') {
      return ApiResponseBuilder.forbidden('Please try again (anti-spam check failed)');
    }

    const saved = await LocalDB.createMessage({
      name: result.value.name,
      email: result.value.email,
      subject: result.value.subject,
      message: result.value.message,
      // Scored, never rejected (C-79) — see lib/spam-score.ts.
      ...spamFields(gate.spam),
    });
    if (!saved) return ApiResponseBuilder.serverError('Could not save message');

    // Tell the shop. This did not happen at all: the endpoint stored the message
    // and returned, so a shop using the built-in contact form heard nothing
    // until somebody opened the admin inbox — while the content-type form path
    // DID send. Same helper for both now, so the two cannot drift again.
    //
    // Fire-and-forget: the message is stored, and a mail server having a bad
    // afternoon must not return an error to a visitor who would then submit
    // again, leaving the shop with two copies and still no email.
    void notifySubmission({
      what: 'contact message',
      fields: [
        { name: 'Name', value: result.value.name },
        { name: 'Email', value: result.value.email },
        { name: 'Subject', value: result.value.subject },
        { name: 'Message', value: result.value.message },
      ],
      whereToFind: 'See it in the admin under Messages.',
      // The visitor's address, already checked by the schema above — so the
      // shop answers by pressing Reply. sendEmail re-checks it before it goes
      // into a header, and falls back to EMAIL_REPLY_TO if it would not do.
      replyTo: result.value.email,
    });

    return ApiResponseBuilder.created({ id: saved.id }, 'Message received');
  } catch (err) {
    console.error('Contact submit error:', err);
    return ApiResponseBuilder.serverError('Failed to submit message');
  }
};
