/**
 * Run the off-site backup NOW (C-87).
 *
 * ## Why an operator needs this
 *
 * The off-site backup runs on the scheduler's own cadence. Before a risky
 * change — a plugin install, an import, a migration — an operator wants one
 * taken at a moment they choose, and the only way to get it was to wait or to
 * restart the process at the right time.
 *
 * ## It is the SAME function the scheduler calls
 *
 * Not a second path that "does roughly the same thing": if the manual run
 * succeeded while the scheduled one had been failing for a month, the button
 * would be actively misleading. One function, one set of failures, one report
 * — and one persisted record (backup/offsite-state.ts), shared with the
 * schedule.
 */
import type { APIRoute } from 'astro';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { offsiteConfig } from '../../../lib/backup/offsite';
import { runRecordedBackup } from '../../../lib/backup/offsite-state';

export const prerender = false;

export const POST: APIRoute = async ({ locals }) => {
  try {
    const session = locals.user;
    if (!session || session.role !== 'admin') {
      return ApiResponseBuilder.forbidden('Admin only');
    }

    const config = offsiteConfig(process.env);
    if (!config) {
      // Not an error condition — nothing is configured. Saying so plainly beats
      // a 500 that an operator would read as "the backup is broken".
      return ApiResponseBuilder.badRequest(
        'No off-site destination is configured. Set the backup environment variables first — '
        + 'without a destination there is nowhere for an archive to go.',
      );
    }

    // Recorded like a scheduled run, so the operations screen shows it and the
    // schedule counts its interval from it, on every replica and after a
    // restart.
    const result = await runRecordedBackup(config);
    return ApiResponseBuilder.success(result, 'Off-site backup run');
  } catch (err) {
    console.error('Off-site backup run error:', err);
    return ApiResponseBuilder.serverError('The backup run failed');
  }
};
