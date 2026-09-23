import type { APIRoute } from 'astro';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ApiResponseBuilder } from '../../../lib/api-response';
import { getDbPath, getUploadsDir } from '../../../lib/paths';
import { MAX_ARCHIVE_BYTES } from '../../../lib/backup/offsite';
import { localSqlitePath, openSqlite, sqliteFileUrl, swapLocalSqliteFile } from '../../../lib/storage/local-sqlite';
import type { Client } from '@libsql/client';
import { sanitizeHtml } from '../../../lib/sanitize';
import { sanitizeSvg } from '../../../lib/media/svg-sanitize';
import { invalidateMediaBase } from '../../../lib/media-base';

/**
 * Restore from a backup JSON.
 *
 * ## Two archive shapes, and the defect that made one of them unrestorable
 *
 * `/api/backup/export` writes `version: 1` — `{ db, uploads }`, the lowdb
 * document inline. The scheduled off-site backup added in Phase 2 writes
 * `version: 2`, which is the SAME shape for a lowdb install (`kind: 'lowdb'`)
 * and a different one for a file-backed libSQL install (`kind: 'libsql-file'`,
 * carrying `sqlite_base64` and its `-wal`/`-shm` siblings instead of `db`).
 *
 * This route accepted `version === 1` and nothing else. So every archive the
 * off-site scheduler had been uploading was refused on restore — including the
 * lowdb ones, whose payload is byte-for-byte what a v1 restore already knows
 * how to read, rejected purely on the version number. A backup that cannot be
 * restored is not a backup, and nothing said so: the upload succeeded, the
 * operations screen reported success, and the failure only existed on the day
 * someone needed it.
 *
 * Both versions are accepted now, and the libSQL shape has an actual restore
 * path rather than being written by one half of the codebase and understood by
 * neither.
 *
 * ## Why a SQLite restore deletes the WAL siblings
 *
 * SQLite's `-wal` holds committed pages not yet folded into the main file. Drop
 * a restored `.sqlite` next to the RUNNING install's stale `-wal` and the
 * engine replays those pages over data they know nothing about: the restore
 * appears to succeed and the database silently ends up as neither the backup
 * nor what was there before. The siblings are therefore removed after the swap.
 *
 * An archive's OWN `-wal` (archives written before backups became snapshots
 * carry one) is folded into the restored file before it goes live, rather than
 * written back beside it — `foldAndCheck` explains what used to delete it.
 */
/**
 * Matches the writer.
 *
 * offsite.ts budgets 256 MB for the uploads it packs into an archive, and this
 * refused anything over 50 — so a shop whose backup the scheduler produced
 * happily could be told, at restore time, that its own archive was too large.
 * The reader and the writer have to agree about what fits or the archive is
 * decorative.
 */
const MAX_BODY = MAX_ARCHIVE_BYTES;

/** Archive versions this route can actually read. */
const SUPPORTED_VERSIONS = [1, 2] as const;

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const session = locals.user;
    if (!session || session.role !== 'admin') {
      return ApiResponseBuilder.forbidden('Admin only');
    }

    const ct = request.headers.get('content-type') || '';
    if (!ct.includes('application/json')) {
      return ApiResponseBuilder.badRequest('Content-Type must be application/json');
    }
    const cl = Number(request.headers.get('content-length') || '0');
    if (cl && cl > MAX_BODY) {
      return ApiResponseBuilder.badRequest(`Backup too large (>${MAX_BODY / 1024 / 1024} MB)`);
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object' || (body as any).format !== 'astrobaas-backup') {
      return ApiResponseBuilder.badRequest('Not an AstroBaaS backup file');
    }
    const version = (body as any).version;
    if (!SUPPORTED_VERSIONS.includes(version)) {
      return ApiResponseBuilder.badRequest(
        `Unsupported backup version: ${version}. This build reads versions ${SUPPORTED_VERSIONS.join(' and ')}.`,
      );
    }

    const uploadsRoot = getUploadsDir();
    const dbUrl = process.env.DATABASE_URL?.trim() || '';

    // A libSQL archive carries SQLite BYTES, not a JSON document, and restoring
    // it means replacing a file rather than rewriting one. Handled first,
    // because the checks it needs are different from every other case.
    if ((body as any).kind === 'libsql-file') {
      const restoreErr = await restoreSqlite(body as any, dbUrl);
      if (restoreErr) return ApiResponseBuilder.badRequest(restoreErr);
      invalidateMediaBase();
      const media = await restoreUploads(body, uploadsRoot);
      // The archive's own notes travel back to the operator. offsite.ts writes
      // things there that change what a restore MEANS — "the uploads were NOT
      // included", "the database was copied live, so this is best-effort" — and
      // they were written by one half of the codebase and read by neither.
      const notes = archiveNotes(body);
      return ApiResponseBuilder.success(
        {
          ...media,
          database: 'sqlite',
          // Structured, not only in the message: the UI can render this, and a
          // restart instruction buried in a toast is one nobody follows.
          restartRequired: true,
          notes,
        },
        'Database file and uploads restored. This process now reads and writes the restored '
        + 'database, but other processes and in-memory caches still hold the previous site — '
        + 'RESTART the site to finish.'
        + (notes.length ? ` Notes from the archive: ${notes.join(' ')}` : ''),
      );
    }

    // Everything else writes the lowdb JSON document. On a libSQL install that
    // file is ignored, so a "successful" restore would silently change nothing.
    if (dbUrl) {
      return ApiResponseBuilder.badRequest(
        'This archive holds a JSON document, but the site is running on libSQL, which would ignore it. Restore with your database tooling, or use an archive taken from this install.',
      );
    }

    const dbPath = getDbPath();

    // Restore db.json — sanitize post content so a hostile or stale backup
    // can't smuggle unsanitized HTML into the published site on restore.
    const incoming = (body as any).db;
    if (incoming) {
      if (Array.isArray(incoming.posts)) {
        for (const p of incoming.posts) {
          if (p && typeof p.content === 'string') p.content = sanitizeHtml(p.content);
        }
      }
      await fs.mkdir(path.dirname(dbPath), { recursive: true });
      await fs.writeFile(dbPath, JSON.stringify(incoming, null, 2) + '\n');
    // A restore rewrites the settings rows behind LocalDB's back, so the
    // memoised media base would keep serving the OLD site's origin in every
    // media URL until the process restarted. Restoring one shop's backup onto
    // another is exactly when that matters.
    invalidateMediaBase();
    }

    const { restored, skipped } = await restoreUploads(body, uploadsRoot);
    // The archive's notes travel back on EVERY branch, not just the libSQL one.
    // lowdb is the driver the note about missing uploads is most likely to
    // appear on, and it was the branch that dropped them.
    const notes = archiveNotes(body);
    return ApiResponseBuilder.success(
      { restored, skipped, restartRequired: false, notes },
      'Backup restored. Reload the page to see the new data.'
      + (notes.length ? ` Notes from the archive: ${notes.join(' ')}` : ''),
    );
  } catch (err) {
    console.error('Backup import error:', err);
    return ApiResponseBuilder.serverError('Restore failed');
  }
};


/**
 * Write the archive's uploads under public/uploads.
 *
 * Shared by both restore paths rather than copied, so the traversal guard and
 * the extension allow-list cannot end up enforced on one path and not the
 * other — a divergence that would be invisible until someone restored the
 * wrong kind of archive.
 */
async function restoreUploads(
  body: unknown,
  uploadsRoot: string,
): Promise<{ restored: number; skipped: number }> {
  let restored = 0;
  let skipped = 0;
  const uploads = Array.isArray((body as any)?.uploads) ? (body as any).uploads : [];
  for (const u of uploads) {
    if (!u || typeof u.path !== 'string' || typeof u.base64 !== 'string') {
      skipped += 1;
      continue;
    }
    // Sanitize the path: collapse, reject absolute or traversal.
    const rel = u.path.replace(/\\/g, '/').replace(/^\/+/, '');
    if (rel.includes('..') || rel.startsWith('/')) {
      skipped += 1;
      continue;
    }
    // Enforce the same content policy as live uploads: a hostile backup must
    // not be able to plant executable-in-browser files (.html, .js, …) under
    // /uploads, which is served same-origin. Unknown extensions are skipped.
    //
    // SVG is on this list because ingest ACCEPTS it — and the first version of
    // this allow-list omitted it, so restoring your own backup silently deleted
    // every logo and icon from disk while their media records survived. The
    // media library then showed rows whose files 404. Dropping data to avoid a
    // risk the upload path already handles is not a safe default, it is a
    // different bug.
    if (!/\.(png|jpe?g|gif|webp|svg|pdf|txt|md)$/i.test(rel)) {
      skipped += 1;
      continue;
    }
    const target = path.resolve(uploadsRoot, rel);
    if (!target.startsWith(uploadsRoot + path.sep)) {
      skipped += 1;
      continue;
    }

    let bytes = Buffer.from(u.base64, 'base64');
    if (/\.svg$/i.test(rel)) {
      // Re-sanitised on the way back in, not trusted because it came from a
      // backup. An archive is an untrusted input: it may be old (written before
      // the sanitiser learned about an attribute), it may be another shop's, or
      // it may have been edited. Running it through the SAME sanitiser the
      // upload path uses is what makes accepting the extension safe.
      const cleaned = sanitizeSvg(bytes.toString('utf8'));
      if (!cleaned) {
        skipped += 1;
        continue;
      }
      bytes = Buffer.from(cleaned, 'utf8');
    }

    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes);
    restored += 1;
  }
  return { restored, skipped };
}

/**
 * Restore a `kind: 'libsql-file'` archive over the local SQLite file.
 *
 * Returns an error STRING when it cannot proceed, null on success — the caller
 * turns that into a 400. Refusing loudly matters more here than anywhere else
 * in the codebase: a restore that half-works leaves a database that is neither
 * the backup nor what was there before.
 */
async function restoreSqlite(
  body: { sqlite_base64?: unknown; wal_base64?: unknown; shm_base64?: unknown },
  dbUrl: string,
): Promise<string | null> {
  if (typeof body.sqlite_base64 !== 'string' || body.sqlite_base64 === '') {
    return 'This archive says it holds a SQLite database but carries no database bytes.';
  }
  if (!dbUrl.startsWith('file:')) {
    // A remote Turso URL has no local file to replace. Writing one would create
    // a file the running site never reads, and report success for a restore
    // that did nothing.
    return dbUrl
      ? 'This site runs on a REMOTE libSQL database. A file archive cannot be restored into it — use your provider\'s own restore tooling.'
      : 'This archive holds a SQLite database, but the site is running on the JSON driver. Point DATABASE_URL at a file: URL before restoring it.';
  }

  // Resolved by the SAME function the live connection's opener and the backup
  // writer use (lib/storage/local-sqlite.ts). It used to be spelled here and
  // in offsite.ts separately. They agreed on `file:./data/site.sqlite` —
  // requiring an absolute path once refused that ordinary configuration, so a
  // shop could take an off-site backup it was then told it could not restore —
  // but not on `file://localhost/…` or a query string. The reader and the
  // writer must agree about what a file: URL means or the archive is
  // decorative.
  const target = localSqlitePath(dbUrl);
  if (!target) return `DATABASE_URL names no file: ${dbUrl}`;

  const bytes = Buffer.from(body.sqlite_base64, 'base64');
  // Every SQLite file begins with this exact 16-byte string. Checking it costs
  // nothing and stops a wrong-format archive from replacing a working database
  // with rubbish. (A TRUNCATED SQLite file passes it; foldAndCheck does not.)
  if (!bytes.subarray(0, 15).toString('latin1').startsWith('SQLite format 3')) {
    return 'The archived database is not a SQLite file — refusing to overwrite the live one.';
  }

  // Stage beside the target, make the staged file self-contained and check it,
  // and only then rename it into place — so neither a crash mid-write nor a bad
  // archive can leave anything but a working database at the target.
  const staging = `${target}.restore-${process.pid}`;
  const clearStaging = async () => {
    for (const f of [staging, `${staging}-wal`, `${staging}-shm`, `${staging}-journal`]) {
      await fs.rm(f, { force: true }).catch(() => {});
    }
  };
  try {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await clearStaging();
    await fs.writeFile(staging, bytes);
    // An archive from before snapshots carries the live `-wal` beside the main
    // file. It is replayed INTO the staged file, never written back beside the
    // target. The `-shm` is not restored at all: it is an index SQLite
    // rebuilds from the WAL, not data.
    if (typeof body.wal_base64 === 'string' && body.wal_base64 !== '') {
      await fs.writeFile(`${staging}-wal`, Buffer.from(body.wal_base64, 'base64'));
    }
    const problem = await foldAndCheck(staging);
    if (problem) {
      await clearStaging();
      return problem;
    }
    // The swap moves THIS process onto the restored file. The rename alone
    // did not: every client the site holds kept the previous file's inode,
    // and under WAL their writes after a 200 OK restore SUCCEEDED — into a log
    // nothing reads again — and were gone at the restart this route asks for
    // (it used to fail loudly, in rollback-journal mode). swapLocalSqliteFile
    // closes the storage driver's, the doc-blob adapter's and the rate-limit
    // store's clients before the rename and reopens them on the path after,
    // and explains why that order and no other.
    await swapLocalSqliteFile(target, async () => {
      await fs.rename(staging, target);
      // The RUNNING install's siblings MUST go. A restored main file next to
      // the previous database's -wal makes SQLite replay committed pages over
      // data they know nothing about, which corrupts the restore silently.
      // Removed while every client here is closed, so none of them can recreate
      // them against the old file in between.
      await fs.rm(`${target}-wal`, { force: true }).catch(() => {});
      await fs.rm(`${target}-shm`, { force: true }).catch(() => {});
    });
  } catch (err) {
    await clearStaging();
    return `Could not write the database file: ${(err as Error).message}`;
  }
  return null;
}

/**
 * Make a staged database file self-contained, and prove it is a database.
 * Returns an error string, or null when the file is ready to swap in.
 *
 * ## Why the WAL is folded in rather than restored beside the file
 *
 * Writing an archive's `-wal` back next to the restored file — what this route
 * did — makes the restore depend on a sidecar it does not control. The running
 * process still has the PREVIOUS database open, and when SQLite closes the last
 * connection to a WAL database it checkpoints into the file it has open and
 * then deletes the `-wal` BY NAME: the restored one, by then. A graceful
 * restart after a restore would have thrown away every commit the archive's
 * WAL carried, and the restore had already reported success.
 *
 * Opening the staged file replays its `-wal`; `wal_checkpoint(TRUNCATE)` folds
 * every frame into the main file; closing removes the log. What gets renamed
 * into place is ONE file with everything in it. A snapshot archive (no WAL)
 * goes through the same door, and the checkpoint is a no-op.
 *
 * ## Why quick_check
 *
 * The header check in restoreSqlite catches the wrong kind of file, not a
 * truncated one — which SQLite opens happily and fails on later, after it has
 * replaced a working database. `PRAGMA quick_check` reads every page once. A
 * restore is the one place where refusing is always better than trying.
 */
async function foldAndCheck(file: string): Promise<string | null> {
  let client: Client | null = null;
  try {
    client = openSqlite(sqliteFileUrl(file));
    await client.execute('PRAGMA wal_checkpoint(TRUNCATE)');
    const verdict = String((await client.execute('PRAGMA quick_check')).rows[0]?.[0] ?? '');
    if (verdict !== 'ok') {
      return `The archived database failed SQLite's integrity check (${verdict.slice(0, 200)}) — refusing to overwrite the live one.`;
    }
    return null;
  } catch (err) {
    return `The archived database could not be opened (${(err as Error).message}) — refusing to overwrite the live one.`;
  } finally {
    client?.close();
  }
}


/**
 * The archive's own notes, bounded.
 *
 * offsite.ts writes things here that change what a restore MEANS — "the uploads
 * were NOT included", "the database was copied live, so this is best-effort".
 * They were written by one half of the codebase and read by neither. One helper
 * so both restore branches surface them, because the branch that dropped them
 * was the one most shops are on.
 */
function archiveNotes(body: unknown): string[] {
  const raw = (body as { notes?: unknown })?.notes;
  if (!Array.isArray(raw)) return [];
  return raw.filter((n): n is string => typeof n === 'string' && n.length <= 500).slice(0, 10);
}
