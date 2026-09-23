/**
 * Off-site backups.
 *
 * A backup on the same disk as the thing it backs up is not a backup. This
 * pushes one to any S3-compatible bucket — Backblaze B2, Cloudflare R2, MinIO,
 * Hetzner, Wasabi, a second VPS running MinIO — on the schedule the site
 * already runs its other background work on.
 *
 * ## Credentials come from the environment, never from settings
 *
 * The settings table is partly readable by anonymous callers (a decoupled
 * storefront reads the site title from it), and it is schemaless. A bucket
 * secret stored there is one plugin, one careless projection or one backup
 * export away from being published. Everything secret is an env var; nothing
 * about the target is stored in the database at all.
 *
 * ## What actually gets backed up
 *
 * Whatever the ACTIVE DRIVER stores, which is not the same file in each case:
 *
 *  - **lowdb** — `db.json` plus the uploads directory, as the existing manual
 *    export produces.
 *  - **libSQL / relational with a `file:` URL** — a `VACUUM INTO` snapshot of
 *    the SQLite database, plus uploads. Reading `db.json` here would produce a
 *    stale or empty archive that LOOKS valid, which is the worst possible
 *    failure for a backup. Why a snapshot rather than the file: buildPayload.
 *  - **a remote libSQL/Turso URL** — refused, loudly. There is no local file to
 *    copy and this must not pretend otherwise; Turso's own tooling does it.
 *
 * That last case is a real limitation rather than an oversight, and it is
 * reported as one: an operator sees "not supported for this driver" on the
 * screen instead of a green tick over nothing.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { constants as bufferConstants } from 'node:buffer';
import { getDbPath, getUploadsDir } from '../paths';
import { s3, type S3Config } from './s3';
import { localSqlitePath, snapshotLocalSqlite } from '../storage/local-sqlite';

export interface OffsiteConfig extends S3Config {
  /** Key prefix inside the bucket, e.g. `astrobaas/myshop`. */
  prefix: string;
  /** How many archives to keep. Older ones are deleted after a successful upload. */
  keep: number;
  /** Hours between automatic backups. 0 disables the schedule. */
  everyHours: number;
}

/**
 * Read the target from the environment.
 *
 * Returns null when it is not configured, which is the normal state — off-site
 * backup is opt-in and a site with no bucket must not log an error every hour.
 */
export function offsiteConfig(env: NodeJS.ProcessEnv = process.env): OffsiteConfig | null {
  const endpoint = (env.BACKUP_S3_ENDPOINT || '').trim();
  const bucket = (env.BACKUP_S3_BUCKET || '').trim();
  const accessKeyId = (env.BACKUP_S3_KEY_ID || '').trim();
  const secretAccessKey = (env.BACKUP_S3_SECRET || '').trim();
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;

  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    return null;
  }
  // https only, unless the operator is pointing at a MinIO on their own
  // network and says so. Backups travel with everything the site knows.
  if (parsed.protocol !== 'https:' && env.BACKUP_S3_ALLOW_HTTP !== '1') return null;

  const keepRaw = Number(env.BACKUP_KEEP);
  const hoursRaw = Number(env.BACKUP_EVERY_HOURS);

  return {
    endpoint: parsed.origin,
    region: (env.BACKUP_S3_REGION || 'us-east-1').trim(),
    bucket,
    accessKeyId,
    secretAccessKey,
    forcePathStyle: env.BACKUP_S3_PATH_STYLE === '1',
    prefix: (env.BACKUP_S3_PREFIX || 'astrobaas').trim().replace(/^\/+|\/+$/g, ''),
    keep: Number.isInteger(keepRaw) && keepRaw > 0 ? Math.min(keepRaw, 365) : 14,
    everyHours: Number.isFinite(hoursRaw) && hoursRaw > 0 ? Math.min(hoursRaw, 24 * 30) : 24,
  };
}

export type PayloadOutcome =
  | { ok: true; body: Buffer; contentType: string; extension: string; kind: string; files: number; skipped: number }
  | { ok: false; error: string };

/** Files larger than this are left out, and SAID to be left out. */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/**
 * Total bound on the uploads folder for the SINGLE-JSON path.
 *
 * The whole archive is one JSON string built in memory, and V8 refuses a
 * string past ~512 MiB. base64 inflates by a third, so a photo-heavy shop of a
 * few hundred MB throws `RangeError: Invalid string length` on every attempt —
 * a backup that fails forever, silently, which is worse than no backup because
 * the screen says one is configured. When the folder is over this bound the
 * uploads are LEFT OUT with a loud note rather than crashing the run; the
 * database (the irreplaceable part) still goes, and the note tells the
 * operator to sync uploads separately (rsync, rclone).
 */
/**
 * The largest archive the RESTORE route will read.
 *
 * Lives here, beside the writer's own budget, because the two must agree: a
 * reader with a smaller ceiling than the writer means a shop's own archive is
 * refused at restore time. They HAD drifted — the route said 256 MB and the
 * middleware still said 60, so the request was rejected with a bare 413 before
 * the route it was raised in ever ran.
 */
export const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;

const MAX_UPLOADS_TOTAL_BYTES = 256 * 1024 * 1024;

/**
 * The longest string V8 will build — about 512 MiB of UTF-16 units. The whole
 * archive is ONE JSON string, so this is its ceiling whatever the disk holds.
 */
const MAX_ARCHIVE_CHARS = bufferConstants.MAX_STRING_LENGTH;
/** Room kept for the JSON around the base64: keys, notes, upload paths, quoting. */
const ARCHIVE_OVERHEAD_CHARS = 1_000_000;

export interface PayloadOptions {
  /**
   * The ceiling on the archive's JSON string, in characters. Defaults to V8's
   * own limit. A test passes a small one to reach the refusal path without a
   * half-gigabyte database.
   */
  maxArchiveChars?: number;
}

async function walk(dir: string, root: string, out: { rel: string; full: string }[]): Promise<void> {
  let entries: import('node:fs').Dirent[] = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  for (const e of entries) {
    if (e.name === '.gitkeep' || e.name.startsWith('.DS_')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full, root, out);
    else if (e.isFile()) out.push({ rel: path.relative(root, full), full });
  }
}

/**
 * The uploads directory as a list of base64 blobs, with a per-file AND a total
 * ceiling. `overBudget` means the folder is too large for the single-JSON
 * path; the caller then archives the database alone and says so.
 */
async function collectUploads(): Promise<{ uploads: { path: string; base64: string }[]; skipped: number; overBudget: boolean }> {
  const root = getUploadsDir();
  const files: { rel: string; full: string }[] = [];
  await walk(root, root, files);

  // Sum the eligible files first. If they blow the total budget, do not read a
  // single one into memory — return empty and let the caller decide.
  let total = 0;
  let skipped = 0;
  const eligible: { rel: string; full: string }[] = [];
  for (const f of files) {
    const stat = await fs.stat(f.full);
    if (stat.size > MAX_UPLOAD_BYTES) { skipped += 1; continue; }
    total += stat.size;
    eligible.push(f);
  }
  if (total > MAX_UPLOADS_TOTAL_BYTES) {
    return { uploads: [], skipped, overBudget: true };
  }

  const uploads: { path: string; base64: string }[] = [];
  for (const f of eligible) {
    uploads.push({
      path: f.rel.split(path.sep).join('/'),
      base64: (await fs.readFile(f.full)).toString('base64'),
    });
  }
  return { uploads, skipped, overBudget: false };
}

/**
 * Build the archive for whichever driver is running.
 *
 * The `kind` field is in the payload rather than only in the filename, so a
 * restore reads what it is holding instead of inferring it from a name somebody
 * may have changed.
 */
export async function buildPayload(
  env: NodeJS.ProcessEnv = process.env,
  opts: PayloadOptions = {},
): Promise<PayloadOutcome> {
  const databaseUrl = (env.DATABASE_URL || '').trim();

  if (databaseUrl && !databaseUrl.startsWith('file:')) {
    return {
      ok: false,
      error: 'This install uses a remote libSQL/Turso database. There is no local file to copy, '
        + 'so an off-site backup has to be taken with that provider\'s own tooling '
        + '(for example `turso db dump`). Uploads can still be synced separately.',
    };
  }

  const { uploads, skipped, overBudget } = await collectUploads();
  // When the uploads folder is too large for one in-memory JSON string, the
  // DATABASE still goes (it is the irreplaceable part); the note tells the
  // operator to sync the files separately.
  const notes: string[] = [];
  if (overBudget) {
    notes.push(
      `The uploads directory is larger than ${Math.round(MAX_UPLOADS_TOTAL_BYTES / 1024 / 1024)} MB `
      + 'and was NOT included — the whole archive is one JSON string held in memory, and it would '
      + 'overflow. The database is backed up; sync the uploads folder separately (rsync/rclone).',
    );
  }

  if (databaseUrl) {
    // A `file:` libSQL URL. The SQLite file IS the database; db.json is either
    // absent or stale, and copying it would produce an archive that looks fine
    // and restores nothing.
    //
    // ## A snapshot, not a copy of the file
    //
    // The database runs in WAL mode (lib/storage/local-sqlite.ts), and under
    // WAL the newest commits are not in the main file at all: they sit in the
    // `-wal` sibling until a checkpoint folds them in. A copy of the main file
    // alone therefore silently loses exactly the most recent orders.
    //
    // This used to read the main file and then the `-wal` in two separate
    // reads and archive both, which is worse than it sounds: a checkpoint
    // landing between the two reads — any request's commit can trigger one,
    // and the first read of a large shop takes seconds — moves the newest pages
    // INTO the main file after it was read and empties the WAL before it is
    // read, so the archive held them in neither.
    // tests/sqlite-concurrency.test.mjs forces that checkpoint at exactly that
    // moment.
    //
    // `VACUUM INTO` writes a complete copy from ONE read transaction: every
    // commit up to that instant, wherever it lives, and nothing torn by a
    // concurrent writer — whom, under WAL, it does not block. The archive
    // carries one self-contained file and no sidecars, so the restore has
    // nothing to replay and nothing lying beside it to lose. (`wal_base64` and
    // `shm_base64` are no longer written; the restore still reads older
    // archives that carry them.)
    //
    // ## Refused BEFORE the copy when it cannot fit
    //
    // The archive is one JSON string, base64 spends four characters on every
    // three bytes, and the uploads share the same string. A database past that
    // budget used to be found out only AFTER the snapshot — a VACUUM INTO that
    // freezes the process for its duration and writes a database-sized file —
    // and then again on every scheduler tick, because the failure was retried
    // each minute. snapshotLocalSqlite is told how many bytes can fit, measures
    // the live database from its page count, and refuses without copying.
    const uploadChars = uploads.reduce((n, u) => n + u.base64.length + u.path.length, 0);
    const roomChars = (opts.maxArchiveChars ?? MAX_ARCHIVE_CHARS) - ARCHIVE_OVERHEAD_CHARS - uploadChars;
    const maxBytes = Math.max(0, Math.floor((roomChars * 3) / 4));
    const where = localSqlitePath(databaseUrl) || databaseUrl;
    let sqlite: Buffer;
    try {
      sqlite = await snapshotLocalSqlite(databaseUrl, { maxBytes });
    } catch (err) {
      if ((err as { code?: unknown })?.code === 'SNAPSHOT_TOO_LARGE') {
        return {
          ok: false,
          error: `The database at ${where} is too large to archive as a single JSON blob `
            + `(${(err as Error).message}${uploads.length ? ', after the uploads' : ''}). `
            + 'Use SQLite\'s own tooling — `sqlite3 <db> ".backup <file>"` or VACUUM INTO — and sync uploads separately.',
        };
      }
      return { ok: false, error: `Could not snapshot the database at ${where}: ${(err as Error).message}` };
    }
    // The base64 is built INSIDE the guarded thunk. Built outside it, as it
    // was, a snapshot too large for a string threw straight past the guard:
    // Node's Buffer#toString throws a plain Error (ERR_STRING_TOO_LONG), not
    // the RangeError the guard looked for, and not inside its try either.
    const body = safeStringify(() => ({
      format: 'astrobaas-backup',
      version: 2,
      kind: 'libsql-file',
      created_at: new Date().toISOString(),
      sqlite_base64: sqlite.toString('base64'),
      uploads,
      notes,
    }));
    if (!body) return { ok: false, error: 'The database is too large to archive as a single JSON blob. Use the provider\'s own dump tooling.' };
    return { ok: true, body, contentType: 'application/json', extension: 'json', kind: 'libsql-file', files: uploads.length, skipped };
  }

  let db: unknown = null;
  try {
    db = JSON.parse(await fs.readFile(getDbPath(), 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { ok: false, error: `Could not read the database: ${(err as Error).message}` };
    }
  }
  const body = safeStringify(() => ({
    format: 'astrobaas-backup',
    version: 2,
    kind: 'lowdb',
    created_at: new Date().toISOString(),
    db,
    uploads,
    notes,
  }));
  if (!body) return { ok: false, error: 'The site is too large to archive as a single JSON blob. Reduce the uploads folder or use external backup tooling.' };
  return { ok: true, body, contentType: 'application/json', extension: 'json', kind: 'lowdb', files: uploads.length, skipped };
}

/**
 * Build the archive and JSON.stringify it into a Buffer, returning null instead
 * of throwing when a string would exceed V8's ~512 MiB limit. The uploads
 * total is already bounded, but the DATABASE itself could in principle be
 * enormous, and a backup path must fail with a message rather than an
 * uncaught exception.
 *
 * Takes a THUNK so that everything which builds a long string — the base64 of
 * the database included — runs inside the try. And it recognises both ways a
 * too-long string fails: JSON.stringify throws a RangeError ("Invalid string
 * length"), while Buffer#toString throws a plain Error with code
 * ERR_STRING_TOO_LONG (checked against Node 22).
 */
function safeStringify(build: () => unknown): Buffer | null {
  try {
    return Buffer.from(JSON.stringify(build()));
  } catch (err) {
    if (err instanceof RangeError || (err as { code?: unknown })?.code === 'ERR_STRING_TOO_LONG') return null;
    throw err;
  }
}

/** `astrobaas/2026-08-29T12-00-00-000Z.json` — sortable, so retention is a sort. */
export function backupKey(prefix: string, at: Date, extension: string): string {
  const stamp = at.toISOString().replace(/[:.]/g, '-');
  return `${prefix ? `${prefix}/` : ''}${stamp}.${extension}`;
}

export interface BackupOutcome {
  ok: boolean;
  key?: string;
  bytes?: number;
  files?: number;
  skipped?: number;
  /** Old archives removed by the retention rule. */
  pruned?: number;
  /** sha256 of what was uploaded, so an operator can verify a download. */
  sha256?: string;
  error?: string;
  /**
   * A failure worth retrying on the very next tick: the archive was built and
   * the BUCKET refused it or could not be reached. Absent on a failure to
   * build the archive — a database too large, a missing file, a full disk —
   * which will fail the same way a minute later; see backupDue.
   */
  transient?: boolean;
  at: string;
}

let lastOutcome: BackupOutcome | null = null;

/**
 * The last attempt THIS PROCESS made. In memory, so it describes this process
 * only — the operations screen and the scheduler read the persisted record in
 * backup/offsite-state.ts, which survives a restart and is shared by replicas.
 */
export function lastBackup(): BackupOutcome | null {
  return lastOutcome;
}

/**
 * Take one backup and push it.
 *
 * Retention runs only AFTER a successful upload, and never deletes the archive
 * it just wrote. A rotation that ran first would, on the day the upload starts
 * failing, quietly delete the last good backup and then fail — leaving nothing,
 * at exactly the moment somebody needs it.
 */
export async function runOffsiteBackup(
  cfg: OffsiteConfig,
  doFetch: typeof fetch = fetch,
  now: Date = new Date(),
): Promise<BackupOutcome> {
  const at = now.toISOString();
  const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
  // A failure to BUILD the archive is recorded like any other failure. It used
  // to escape as an exception, which left lastOutcome describing the attempt
  // BEFORE — so the schedule and the operations screen both believed that one.
  let payload: PayloadOutcome;
  try {
    payload = await buildPayload();
  } catch (err) {
    lastOutcome = { ok: false, error: `Could not build the archive: ${message(err)}`, at };
    return lastOutcome;
  }
  if (!payload.ok) {
    lastOutcome = { ok: false, error: payload.error, at };
    return lastOutcome;
  }

  // An UPLOAD failure is transient: the bucket may accept the same bytes a
  // minute from now, so backupDue retries it on the next tick. fetch rejects
  // outright when the endpoint cannot be reached, so that is caught here too.
  const key = backupKey(cfg.prefix, now, payload.extension);
  let put: Awaited<ReturnType<typeof s3.put>>;
  try {
    put = await s3.put(cfg, key, payload.body, payload.contentType, doFetch, now);
  } catch (err) {
    lastOutcome = { ok: false, error: `Upload failed: ${message(err)}`, transient: true, at };
    return lastOutcome;
  }
  if (!put.ok) {
    lastOutcome = { ok: false, error: `Upload failed: ${put.error ?? put.status}`, transient: true, at };
    return lastOutcome;
  }

  let pruned = 0;
  try {
    const listed = await s3.list(cfg, cfg.prefix ? `${cfg.prefix}/` : '', doFetch, now);
    if (listed.ok) {
      // Keys are ISO timestamps, so lexical order is chronological order.
      const ours = listed.keys.filter((k) => k !== key).sort();
      const excess = ours.slice(0, Math.max(0, ours.length - (cfg.keep - 1)));
      for (const old of excess) {
        const del = await s3.delete(cfg, old, doFetch, now);
        if (del.ok) pruned += 1;
      }
    }
  } catch {
    // Retention is housekeeping. The archive IS uploaded; a bucket that cannot
    // be listed right now is pruned by the next successful run.
  }

  lastOutcome = {
    ok: true,
    key,
    bytes: payload.body.byteLength,
    files: payload.files,
    skipped: payload.skipped,
    pruned,
    sha256: crypto.createHash('sha256').update(payload.body).digest('hex'),
    at,
  };
  return lastOutcome;
}

/**
 * What the database remembers about off-site backups (backup/offsite-state.ts).
 * Declared here, beside `backupDue`, because it is the other half of that
 * decision; the reading and writing live in offsite-state.ts so this module
 * stays free of storage imports.
 */
export interface PersistedBackupState {
  /** An attempt that STARTED and has not recorded an outcome. */
  attempt: { id: string; started_at: string; by: string } | null;
  /** The most recent attempt that finished, successful or not. */
  last: (BackupOutcome & { attempt_id?: string }) | null;
  /** The most recent successful one, kept even after later failures. */
  last_success: (BackupOutcome & { attempt_id?: string }) | null;
}

/**
 * How long an attempt with no recorded outcome blocks the next one.
 *
 * An attempt writes its marker BEFORE it builds the archive. If the process
 * dies part-way — out of memory on a large uploads folder, a deploy, a crash
 * loop — the marker stays, and every process that starts afterwards would
 * otherwise take one look at "no successful backup" and begin another full
 * backup straight away. That is how a crash loop turned into a backup loop.
 *
 * An hour by default (BACKUP_ATTEMPT_TIMEOUT_MS): longer than a large upload
 * over a modest link takes, short enough that a backup cut off by a deploy
 * is retried the same morning. Never longer than the schedule itself.
 */
export function attemptTimeoutMs(cfg: OffsiteConfig, env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.BACKUP_ATTEMPT_TIMEOUT_MS);
  const base = Number.isFinite(raw) && raw >= 1_000 ? Math.min(raw, 24 * 3600_000) : 3600_000;
  return cfg.everyHours > 0 ? Math.min(base, cfg.everyHours * 3600_000) : base;
}

const newer = <T extends { at: string }>(a: T | null | undefined, b: T | null | undefined): T | null => {
  if (!a) return b ?? null;
  if (!b) return a;
  return Date.parse(b.at) > Date.parse(a.at) ? b : a;
};

/**
 * The longest a backup that could not be BUILT waits for its next attempt.
 * A shorter schedule waits its own interval instead.
 */
export const FAILED_BUILD_RETRY_MS = 3600_000;

/**
 * Is a backup due?
 *
 * After a success: when the schedule says. After a TRANSIENT failure — the
 * bucket refused the upload or could not be reached — on the next tick, as
 * always: a bucket that has been refusing writes since midnight should be
 * retried now, not once a day.
 *
 * After a failure to BUILD the archive, not before min(everyHours, 1 h). Every
 * such attempt is a full VACUUM INTO — the process frozen for its duration,
 * a database-sized file written — and a database too large to archive, or a
 * disk too full for the copy, fails identically a minute later. Retried every
 * tick, as it was, that cost was paid sixty times an hour for nothing.
 *
 * `last` is this process's memory. `persisted`, when given, is what the
 * database remembers across restarts and replicas, and it wins where the two
 * differ: a restarted process has an empty memory, and treating that as "never
 * backed up" is what made every restart a full backup. It also carries the
 * attempt marker, so an attempt in progress — or one a crash cut off within
 * the last `attemptTimeoutMs` — is not started a second time.
 */
export function backupDue(
  cfg: OffsiteConfig,
  last: BackupOutcome | null,
  nowMs: number,
  persisted?: PersistedBackupState | null,
): boolean {
  if (cfg.everyHours <= 0) return false;
  if (persisted?.attempt) {
    const started = Date.parse(persisted.attempt.started_at);
    if (Number.isFinite(started) && nowMs - started < attemptTimeoutMs(cfg)) return false;
  }
  // The newest finished attempt, from either source, judged by the rules above.
  const latest = newer(last, persisted?.last);
  if (!latest) return true;
  const since = nowMs - new Date(latest.at).getTime();
  if (!Number.isFinite(since)) return true;
  if (latest.ok) return since >= cfg.everyHours * 3600_000;
  if (latest.transient) return true;
  return since >= Math.min(cfg.everyHours * 3600_000, FAILED_BUILD_RETRY_MS);
}

export interface BackupHealth {
  status: 'ok' | 'warn';
  detail: string;
  data: Record<string, unknown>;
}

/**
 * The off-site backup, as the deep health check reports it.
 *
 * Warn-level only, never a failure: a bucket refusing writes does not stop the
 * shop taking orders, and a deploy script should not roll back over it. But a
 * monitor should SEE it — a backup that has been failing for a week is
 * otherwise found on the day somebody needs it.
 *
 * Reads the persisted record, so every replica gives the same answer and a
 * restart does not turn "failing since Tuesday" into "nothing to report".
 */
export function backupHealth(
  cfg: OffsiteConfig | null,
  persisted: PersistedBackupState | null,
  mine: BackupOutcome | null,
  nowMs: number,
): BackupHealth {
  if (!cfg) {
    return { status: 'ok', detail: 'No off-site backup is configured.', data: { configured: false } };
  }
  const last = newer(mine, persisted?.last);
  const success = newer(mine?.ok ? mine : null, persisted?.last_success);
  const data: Record<string, unknown> = {
    configured: true,
    every_hours: cfg.everyHours,
    last_attempt_at: last?.at ?? null,
    last_ok: last ? last.ok : null,
    last_success_at: success?.at ?? null,
    in_progress_since: persisted?.attempt?.started_at ?? null,
  };
  if (persisted?.attempt) {
    const started = Date.parse(persisted.attempt.started_at);
    if (Number.isFinite(started) && nowMs - started >= attemptTimeoutMs(cfg)) {
      return {
        status: 'warn',
        detail: `A backup started at ${persisted.attempt.started_at} never recorded an outcome — `
          + 'the process running it probably stopped part-way. The next sweep retries it.',
        data,
      };
    }
  }
  if (last && !last.ok) {
    return { status: 'warn', detail: `The last off-site backup failed: ${last.error ?? 'unknown error'}`, data };
  }
  if (cfg.everyHours > 0 && success && nowMs - Date.parse(success.at) > 2 * cfg.everyHours * 3600_000) {
    return {
      status: 'warn',
      detail: `The last successful off-site backup was at ${success.at}, more than two intervals ago.`,
      data,
    };
  }
  return {
    status: 'ok',
    detail: success ? `Last successful off-site backup at ${success.at}.` : 'Configured; no backup has finished yet.',
    data,
  };
}
