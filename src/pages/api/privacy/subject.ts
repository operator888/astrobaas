import type { APIRoute } from 'astro';
import { LocalDB } from '../../../lib/localdb';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { recordAudit, AUDIT } from '../../../lib/audit';
import { ensurePluginsBootstrapped } from '../../../plugins';
import { collectSubjectData, eraseSubject, normaliseEmail } from '../../../lib/gdpr';

/**
 * Answering a data-subject request.
 *
 * `GET  ?email=…`  — everything this install holds about that address
 * `POST { email, confirm: 'ERASE' }` — erase it
 *
 * **Admin only.** This endpoint returns one person's complete record — orders,
 * addresses, messages — from an email address alone. That is the shape of a
 * data breach if the door is one step wider than it should be, so it is the
 * narrowest role there is, the same one that governs imports.
 *
 * Both operations are audited. A supervisory authority asking "when did you
 * action this request?" is answered by the log, not by memory.
 */
export const prerender = false;

function requireAdmin(locals: App.Locals): Response | null {
  if (!locals.user) return ApiResponseBuilder.unauthorized();
  if (locals.user.role !== 'admin') {
    return ApiResponseBuilder.forbidden('Only an administrator can action a data request');
  }
  return null;
}

/** The address, or a message saying why it is not one. */
function readEmail(raw: unknown): { email: string } | { error: string } {
  const email = normaliseEmail(raw);
  if (!email) return { error: 'An email address is required' };
  if (email.length > 200) return { error: 'That is not an email address' };
  if (!/^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(email)) return { error: 'That is not an email address' };
  return { email };
}

export const GET: APIRoute = async ({ url, locals }) => {
  try {
    const denied = requireAdmin(locals);
    if (denied) return denied;

    const parsed = readEmail(new URL(url).searchParams.get('email'));
    if ('error' in parsed) return ApiResponseBuilder.badRequest(parsed.error);

    await LocalDB.init();
    // Custom collections are searched too, and they only exist once the
    // registry is populated.
    await ensurePluginsBootstrapped();

    const data = await collectSubjectData(parsed.email);

    // Audited even though it only reads: looking up everything about a named
    // person is itself an act somebody may later need to account for.
    recordAudit(AUDIT.PRIVACY_EXPORT, {
      actor: locals.user!.id,
      target: parsed.email,
      ip: locals.ip,
      metadata: {
        orders: data.orders.length,
        messages: data.messages.length,
        has_customer: !!data.customer,
        submissions: data.submissions.reduce((n, g) => n + g.entries.length, 0),
      },
    });

    return ApiResponseBuilder.success(data, 'Data-subject record assembled');
  } catch (err) {
    console.error('Privacy export error:', err);
    return ApiResponseBuilder.serverError('Failed to assemble the record');
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const denied = requireAdmin(locals);
    if (denied) return denied;

    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const parsed = readEmail(body?.email);
    if ('error' in parsed) return ApiResponseBuilder.badRequest(parsed.error);

    // An erasure cannot be undone, so it cannot be something a mistyped
    // request performs. The literal word, sent deliberately.
    if (body?.confirm !== 'ERASE') {
      return ApiResponseBuilder.badRequest(
        'Erasure is permanent. Send confirm: "ERASE" to perform it.',
      );
    }

    await LocalDB.init();
    await ensurePluginsBootstrapped();

    const report = await eraseSubject(parsed.email);

    // The audit entry records the erased address as its target, on purpose and
    // NOT as a contradiction of the erasure. Article 5(2) requires the
    // controller to be able to DEMONSTRATE compliance, and "we erased X on
    // this date, by this admin" is unprovable without naming X. The GDPR's own
    // recital 74 accountability trumps erasure for the record OF the erasure:
    // a log that cannot say whom it was about is not an audit trail. This is
    // the one place the address deliberately survives, minimised to a single
    // dated line, and the subject is told so in the screen's copy.
    recordAudit(AUDIT.PRIVACY_ERASE, {
      actor: locals.user!.id,
      target: parsed.email,
      ip: locals.ip,
      metadata: {
        orders_anonymised: report.ordersAnonymised,
        customers: report.deleted.customers,
        messages: report.deleted.messages,
        newsletter: report.deleted.newsletter,
        submissions: report.deleted.submissions,
        change_feed: report.deleted.changeFeed,
        webhook_deliveries: report.deleted.webhookDeliveries,
        staff_account_found: report.staffAccountFound,
      },
    });

    return ApiResponseBuilder.success(report, 'Erasure complete');
  } catch (err) {
    console.error('Privacy erase error:', err);
    return ApiResponseBuilder.serverError('Failed to erase the record');
  }
};
