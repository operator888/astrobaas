/**
 * Download a full backup.
 *
 * ## This route used to be a SECOND implementation
 *
 * It re-spelled the directory walk and the mime guess that
 * `lib/backup/offsite.ts` already had, read `db.json` directly, and
 * hard-refused whenever `DATABASE_URL` was set — with a message telling the
 * operator to go and use their database vendor's own tooling.
 *
 * So on the two drivers a real deployment runs, the Download button in the
 * admin did nothing but explain itself. Meanwhile the RESTORE route already
 * understood the `libsql-file` archive that the off-site backup was producing
 * on exactly those installs. One half of the pair could read a format the other
 * half could not write.
 *
 * Now there is one builder and one format. `buildPayload` is driver-aware: a
 * lowdb install gets `{db, uploads}`, a file-backed libSQL install gets a
 * `VACUUM INTO` snapshot of the SQLite database, and a REMOTE Turso database is
 * refused — because there genuinely is no local file to copy, which is a
 * different thing from "this driver is unsupported".
 *
 * ## What changed about the SQLite archive
 *
 * It used to be the live file read while a connection had it open, plus the
 * write-ahead log copied beside it, and this comment called it best-effort —
 * rightly: a checkpoint between the two reads lost the newest commits from
 * both. It is now a snapshot taken from one read transaction, consistent by
 * construction; `offsite.ts` describes the failure it replaced.
 */
import type { APIRoute } from 'astro';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { buildPayload } from '../../../lib/backup/offsite';

export const prerender = false;

export const GET: APIRoute = async ({ locals }) => {
  try {
    const session = locals.user;
    if (!session || session.role !== 'admin') {
      return ApiResponseBuilder.forbidden('Admin only');
    }

    const payload = await buildPayload(process.env);
    if (!payload.ok) {
      // The only remaining refusal is a REMOTE database, and the message
      // explains the actual reason rather than naming a driver.
      return ApiResponseBuilder.badRequest(payload.error);
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `astrobaas-backup-${stamp}.${payload.extension}`;
    return new Response(new Uint8Array(payload.body), {
      status: 200,
      headers: {
        'Content-Type': payload.contentType,
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': String(payload.body.length),
        // The archive holds the whole site including personal data. It must not
        // sit in a proxy cache on the way to the operator's laptop.
        'Cache-Control': 'private, no-store',
        // So a client can tell which shape it got without parsing it first.
        'X-Backup-Kind': payload.kind,
      },
    });
  } catch (err) {
    console.error('Backup export error:', err);
    return ApiResponseBuilder.serverError('Backup failed');
  }
};
