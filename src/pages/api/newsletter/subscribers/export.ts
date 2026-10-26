import type { APIRoute } from 'astro';
import { ApiResponseBuilder } from '../../../../lib/api-response';
import { newsletterExport } from '../../../../lib/consent-service';

/**
 * The subscriber export — what an operator hands to an ESP or keeps as a list.
 *
 * Read from the CONSENT LEDGER, not from the subscriber rows: it contains ONLY
 * contacts whose newsletter consent is granted AND confirmed, and not withdrawn
 * since. Each line carries the proof — when it was confirmed, under which
 * wording (version + text hash), recorded by what — so a list that leaves this
 * install can still be defended.
 *
 * Subscribers from before the ledger existed are in it: migration 16 recorded
 * each one as a `source: 'migration'` confirmation.
 *
 * Staff only (the same predicate as campaigns). `?format=csv` for a file.
 */
export const prerender = false;

const staff = (locals: App.Locals) =>
  locals.user?.role === 'admin' || locals.user?.role === 'editor';

/** RFC 4180 field, and never a formula: a leading = + - @ is defused for spreadsheets. */
function csvField(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export const GET: APIRoute = async ({ locals, url }) => {
  try {
    if (!staff(locals)) return ApiResponseBuilder.forbidden('Staff only');
    const contacts = await newsletterExport();
    if (new URL(url).searchParams.get('format') === 'csv') {
      const head = ['email', 'confirmed_at', 'version', 'text_hash', 'source'];
      const lines = [head.join(',')].concat(
        contacts.map((c) => [c.email, c.confirmed_at, c.version, c.text_hash, c.source].map(csvField).join(',')),
      );
      return new Response(`${lines.join('\r\n')}\r\n`, {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="newsletter-subscribers.csv"',
          'Cache-Control': 'no-store',
        },
      });
    }
    return ApiResponseBuilder.success({ subscribers: contacts, count: contacts.length }, 'Newsletter subscribers');
  } catch (err) {
    console.error('Subscriber export error:', err);
    return ApiResponseBuilder.serverError('Could not export the subscribers');
  }
};
