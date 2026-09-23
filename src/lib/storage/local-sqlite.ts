/**
 * Opening a libSQL client on a LOCAL SQLite file — one way, for every caller.
 *
 * ## Why this exists
 *
 * Three things open the database file: the relational SqlStorage, the doc-blob
 * LibsqlAdapter and the shared rate-limit store. Every one of them called
 * `createClient({ url })` and nothing else, which on a `file:` URL means
 * SQLite's defaults, measured with this repo's own client:
 *
 *   journal_mode = delete   a reader's SHARED lock blocks a writer's COMMIT, and
 *                           a writer blocks every reader;
 *   busy_timeout = 0        the loser of any lock contention fails with
 *                           SQLITE_BUSY in zero milliseconds instead of waiting;
 *   synchronous  = FULL     an fsync on every commit.
 *
 * One process never shows it: native libsql calls run synchronously on the one
 * JS thread, so a process cannot contend with itself. A SECOND process is a
 * different story — an ERP sync CLI, `npm run import:woo`, a second replica —
 * and the first write it made while the site was writing failed outright with
 * "database is locked", in whichever direction the timing fell.
 *
 * ## What is set, and why each is set WHERE it is
 *
 *  - `busy_timeout` through the client's own `timeout` option, not a PRAGMA.
 *    It is per-connection, and @libsql/client (0.18) keeps a POOL: it opens a
 *    new connection whenever every existing one is borrowed — during an open
 *    `transaction()`, or when a burst of requests arrives in one tick. A PRAGMA
 *    run once at start-up lands on whichever connection happened to run it;
 *    every later connection silently has a zero timeout again. (Measured: after
 *    `PRAGMA synchronous = NORMAL`, four parallel reads returned 1, 2, 2, 2, and
 *    a connection opened during a transaction had busy_timeout 0.) The option
 *    is applied by the pool to every connection it ever opens.
 *
 *  - `journal_mode = WAL` as a PRAGMA, once. It is PERSISTENT — recorded in the
 *    file itself — so it holds for every connection in every process from then
 *    on, including the CLI that opens the file next. Readers stop blocking the
 *    writer and the writer stops blocking readers.
 *
 *  - `synchronous = NORMAL` as a PRAGMA, with the pool held to ONE connection so
 *    that the PRAGMA is the setting of every statement this client runs. There
 *    is no client option for it, and SQLite refuses to change it inside a
 *    transaction ("Safety level may not be changed inside a transaction"), so
 *    it cannot ride along with a batch either. One connection costs nothing:
 *    every statement already executes synchronously on the one JS thread, so a
 *    second connection in the same process never ran anything in parallel — it
 *    only held a second page cache.
 *
 *    WAL + NORMAL is SQLite's recommended pairing and cannot corrupt the file.
 *    What it gives up is the fsync per commit: a commit made in the moments
 *    before a POWER LOSS or kernel crash (not a process crash) can roll back.
 *
 * ## The one-connection trap, written down so nobody walks into it
 *
 * With one connection, an open interactive `client.transaction()` holds the
 * only connection, and every other statement the process issues before it
 * commits is REFUSED (TRANSACTION_ACTIVE) rather than queued. No storage code
 * uses `transaction()` — atomicity here comes from single-statement conditional
 * UPDATEs — and on this stack an interactive transaction is a trap anyway: a
 * second connection would sit in the busy handler, blocking the event loop,
 * waiting for a COMMIT that needs the event loop to run. Use `client.batch()`,
 * which runs start to finish without yielding.
 *
 * If the pool ever REPLACES its connection (it drops one it could not roll
 * back), the replacement still has the busy timeout — the option reaches every
 * connection — and runs at synchronous = FULL, the stricter setting. That
 * degradation costs speed, never safety.
 *
 * ## Remote databases are left alone
 *
 * `libsql://` / Turso is somebody else's server: its journal, durability and
 * locking are the provider's, and these PRAGMAs mean nothing over the wire.
 * Only a `file:` URL naming a real file is touched. An in-memory database has
 * no journal to put in WAL mode and only ever one connection.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClient, type Client, type Config, type ResultSet } from '@libsql/client';

/** How long a statement waits for another process's lock before SQLITE_BUSY. */
export const SQLITE_BUSY_TIMEOUT_MS = 5000;

/**
 * The absolute filesystem path a `file:` URL names, or '' when it names none
 * (not a `file:` URL, no path, or an in-memory database).
 *
 * Parsed the way @libsql/client parses it — an empty or `localhost` authority
 * (`file:///abs`, `file://localhost/abs`), the query and fragment dropped, the
 * path percent-decoded, a relative path resolved against the working directory
 * — so the live connection, the backup that snapshots the file and the restore
 * that replaces it all agree about WHICH file. They used to spell it three
 * times, and `file://localhost/…` resolved to a different file in each.
 */
export function localSqlitePath(url: string | undefined | null): string {
  const u = (url ?? '').trim();
  if (!/^file:/i.test(u)) return '';
  let rest = u.slice('file:'.length).split('#')[0].split('?')[0];
  if (rest.startsWith('//')) {
    const slash = rest.indexOf('/', 2);
    rest = slash === -1 ? '' : rest.slice(slash);
  }
  try {
    rest = decodeURIComponent(rest);
  } catch {
    // A malformed escape: libsql keeps it literally, and so does this.
  }
  if (!rest || rest.startsWith(':memory:')) return '';
  return path.resolve(rest);
}

/** True for a `file:` URL naming a file on this machine. */
export function isLocalSqliteFile(url: string | undefined | null): boolean {
  return localSqlitePath(url) !== '';
}

/** A `file:` URL for a path, escaped so libsql's percent-decoding gives the path back. */
export function sqliteFileUrl(file: string): string {
  return pathToFileURL(path.resolve(file)).href;
}

/**
 * `busyTimeoutMs` exists for the tests that drive the lock-contention paths: at
 * 0 they reach the failure branch without holding a lock for five seconds.
 * Production passes nothing and gets SQLITE_BUSY_TIMEOUT_MS.
 */
export interface SqliteOpenOptions {
  busyTimeoutMs?: number;
}

const busyTimeout = (opts: SqliteOpenOptions) => opts.busyTimeoutMs ?? SQLITE_BUSY_TIMEOUT_MS;

/**
 * The client configuration for `url`. Remote URLs get exactly what they got
 * before; a local file gets the busy timeout on every connection and a
 * one-connection pool (see the header for why each).
 */
export function sqliteClientConfig(url: string, authToken?: string, opts: SqliteOpenOptions = {}): Config {
  if (!isLocalSqliteFile(url)) return { url, authToken };
  return { url, authToken, timeout: busyTimeout(opts), concurrency: 1 };
}

/** `createClient`, configured for the kind of database `url` names. */
export function openSqlite(url: string, authToken?: string, opts: SqliteOpenOptions = {}): Client {
  return createClient(sqliteClientConfig(url, authToken, opts));
}

/** The three settings this module is about, as the connection reports them. */
export interface SqliteSettings {
  journal_mode: string;
  /** 0 OFF, 1 NORMAL, 2 FULL, 3 EXTRA. */
  synchronous: number;
  busy_timeout: number;
}

const firstValue = (res: ResultSet): unknown => {
  const row = res.rows[0];
  return row ? row[0] : undefined;
};

/** Read the settings back from the connection the client hands out. */
export async function readSqliteSettings(client: Client): Promise<SqliteSettings> {
  const journal = firstValue(await client.execute('PRAGMA journal_mode'));
  const sync = firstValue(await client.execute('PRAGMA synchronous'));
  const busy = firstValue(await client.execute('PRAGMA busy_timeout'));
  return {
    journal_mode: String(journal ?? '').toLowerCase(),
    synchronous: Number(sync),
    busy_timeout: Number(busy),
  };
}

/**
 * Put a LOCAL database into WAL mode and set the per-connection PRAGMAs.
 * A no-op (returning null) for anything that is not a local file.
 *
 * NEVER throws. Callers run this inside a memoised "ready" promise that every
 * storage call awaits, so a rejection here would fail every request for the
 * life of the process — over a performance setting. A filesystem that cannot
 * do WAL (NFS and SMB have no shared memory for the `-shm` index) keeps its
 * current journal mode, and says so in the log.
 */
export async function applyLocalSqlitePragmas(
  client: Client, url: string, opts: SqliteOpenOptions = {},
): Promise<SqliteSettings | null> {
  if (!isLocalSqliteFile(url)) return null;
  const where = localSqlitePath(url);
  const reason = (err: unknown) => (err instanceof Error ? err.message : String(err));

  // Copies an interrupted backup or restore left beside the file. Once per
  // file per process, first, and never fatal — see sweepLeftovers.
  await sweepLeftovers(where).catch(() => {});

  // The busy timeout FIRST: switching to WAL needs a brief exclusive lock, and
  // another process holding the file must be waited for, not failed on. The
  // client option already set it on this connection; this is belt and braces
  // for a client version that ignores the option.
  try {
    await client.execute(`PRAGMA busy_timeout = ${busyTimeout(opts)}`);
  } catch (err) {
    console.warn(`[sqlite] PRAGMA busy_timeout failed on ${where}: ${reason(err)}`);
  }
  try {
    const mode = String(firstValue(await client.execute('PRAGMA journal_mode = WAL')) ?? '').toLowerCase();
    if (mode !== 'wal') {
      console.warn(
        `[sqlite] ${where} stayed in journal_mode=${mode || 'unknown'} instead of WAL — the filesystem `
        + 'may not support it (network mounts do not). Readers will block writers.',
      );
    }
  } catch (err) {
    console.warn(`[sqlite] could not switch ${where} to WAL (${reason(err)}); it keeps its current journal mode.`);
  }
  try {
    await client.execute('PRAGMA synchronous = NORMAL');
  } catch (err) {
    console.warn(`[sqlite] PRAGMA synchronous failed on ${where}: ${reason(err)}`);
  }
  try {
    return await readSqliteSettings(client);
  } catch {
    return null;
  }
}

const mib = (n: number) => `${(n / 1048576).toFixed(1)} MiB`;

/**
 * Thrown by snapshotLocalSqlite when the copy would not fit where it is going.
 * Callers test `code`, not `instanceof`: the tests load this module in more
 * than one bundle, and a class identity does not survive that.
 */
export class SnapshotTooLargeError extends Error {
  readonly code = 'SNAPSHOT_TOO_LARGE';
  readonly bytes: number;
  readonly limit: number;
  constructor(bytes: number, limit: number) {
    super(`about ${mib(bytes)} of data, and room for ${mib(limit)}`);
    this.name = 'SnapshotTooLargeError';
    this.bytes = bytes;
    this.limit = limit;
  }
}

/**
 * A consistent, self-contained copy of a LOCAL database, as bytes.
 *
 * `VACUUM INTO` writes the whole database from ONE read transaction: every
 * commit up to that instant — including the ones still sitting in the `-wal`
 * sibling, which a copy of the main file does not have — and nothing torn by a
 * writer that commits while it runs. Under WAL it does not block those
 * writers. The output is a single rollback-journal file with no sidecars, so
 * whoever restores it has nothing to replay and nothing beside it to lose.
 *
 * ## What it costs, and what is refused before paying it
 *
 * libsql runs a statement synchronously on the one JS thread, so the VACUUM
 * freezes this process for its whole duration — about a second per 200 MB,
 * measured, with no request served meanwhile — and writes a database-sized
 * file. A copy that is going to be thrown away must not be paid for, least of
 * all once a minute by a scheduler retrying it. So, FIRST:
 *
 *  - `maxBytes`, the size the caller can use. The data is measured as
 *    (page_count − freelist_count) × page_size through a fresh connection,
 *    which counts the commits still in the `-wal`. NOT the file sizes: nothing
 *    truncates the `-wal` after a checkpoint, so after one large import
 *    main + wal can be several times the data and would refuse a backup that
 *    fits.
 *  - free disk space for the copy, where the filesystem can report it: a
 *    backup must not be what fills the disk the database lives on.
 *
 * The copy's real size is checked again afterwards, because a page count
 * estimates what VACUUM writes rather than promising it.
 *
 * Written beside the database rather than in the OS temp directory: that is a
 * disk known to hold a copy of this file, where /tmp may be a small tmpfs.
 * Removed on every path, success or failure — and one a killed process could
 * not remove is swept at the next start (sweepLeftovers).
 */
export async function snapshotLocalSqlite(url: string, opts: { maxBytes?: number } = {}): Promise<Buffer> {
  const file = localSqlitePath(url);
  if (!file) throw new Error(`Not a local SQLite file: ${url}`);
  // Opening a path that does not exist CREATES an empty database there, which
  // would then snapshot as a perfectly valid archive of nothing — and leave a
  // stray file behind. A misconfigured DATABASE_URL must fail the backup.
  await fs.access(file);
  const tmp = `${file}.snapshot-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const client = openSqlite(url);
  try {
    const dataBytes = await liveDataBytes(client);
    if (opts.maxBytes !== undefined && dataBytes > opts.maxBytes) {
      throw new SnapshotTooLargeError(dataBytes, opts.maxBytes);
    }
    await requireFreeSpace(path.dirname(file), dataBytes);
    await client.execute({ sql: 'VACUUM INTO ?', args: [tmp] });
    const bytes = await fs.readFile(tmp);
    if (opts.maxBytes !== undefined && bytes.length > opts.maxBytes) {
      throw new SnapshotTooLargeError(bytes.length, opts.maxBytes);
    }
    return bytes;
  } finally {
    client.close();
    await fs.rm(tmp, { force: true }).catch(() => {});
    await fs.rm(`${tmp}-journal`, { force: true }).catch(() => {});
  }
}

/** The bytes of live data: every page in use, commits still in the `-wal` included. */
async function liveDataBytes(client: Client): Promise<number> {
  const num = async (sql: string) => Number(firstValue(await client.execute(sql)) ?? 0);
  const pages = await num('PRAGMA page_count');
  const free = await num('PRAGMA freelist_count');
  const size = await num('PRAGMA page_size');
  return Math.max(0, pages - free) * size;
}

/** Room left on the disk after the copy, for the site's own writes while it runs. */
const FREE_SPACE_MARGIN_BYTES = 16 * 1024 * 1024;

async function requireFreeSpace(dir: string, bytes: number): Promise<void> {
  let free: number;
  try {
    const s = await fs.statfs(dir);
    free = Number(s.bavail) * Number(s.bsize);
  } catch {
    return; // A filesystem that cannot report it is not refused on a guess.
  }
  if (Number.isFinite(free) && free < bytes + FREE_SPACE_MARGIN_BYTES) {
    throw new Error(
      `not enough free disk space beside the database for its copy: ${mib(free)} free, `
      + `about ${mib(bytes + FREE_SPACE_MARGIN_BYTES)} needed`,
    );
  }
}

/* ------------------------------------------------------------------------ *
 * Leftovers of an interrupted snapshot or restore                           *
 * ------------------------------------------------------------------------ */

/** Files already swept beside, in this process — three openers, one sweep. */
const swept = new Set<string>();

/**
 * Remove the partial copies a killed backup or restore left beside `file`.
 *
 * snapshotLocalSqlite writes `<db>.snapshot-<pid>-<ms>-<rand>` and the restore
 * stages `<db>.restore-<pid>` (plus that file's -wal/-shm/-journal), both
 * beside the live database, and both remove them in a `finally` — which does
 * not run when the process is killed. Nothing handles SIGTERM, so a deploy
 * that restarts the site mid-backup left a partial database copy on the disk
 * (measured: 127 MB after SIGKILL and 149 MB after SIGTERM, 700 ms into the
 * VACUUM of a 205 MB database), one per interruption, forever.
 *
 * A leftover is removed only when the pid in its name is not THIS process and
 * no process with that pid exists (`kill(pid, 0)` answers ESRCH). A live pid —
 * including another replica's backup running right now — is left alone, and
 * so is anything the pattern does not describe exactly: a database's own
 * `-wal` and `-shm`, another database's snapshot, a file someone named by hand.
 *
 * The one case this can misjudge is two containers sharing the database's
 * volume with separate pid namespaces, where the other container's pid means
 * nothing here. The cost there is that container's in-flight backup or restore
 * failing loudly and being retried — its live database is never touched.
 */
async function sweepLeftovers(file: string): Promise<void> {
  if (!file || swept.has(file)) return;
  swept.add(file);
  const dir = path.dirname(file);
  const base = path.basename(file);
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const leftover = new RegExp(
    `^${escaped}\\.(?:snapshot-(\\d+)-\\d+-[a-z0-9]*|restore-(\\d+))(?:-(?:journal|wal|shm))?$`,
  );
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const m = leftover.exec(name);
    if (!m) continue;
    const pid = Number(m[1] ?? m[2]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid || processExists(pid)) continue;
    try {
      await fs.rm(path.join(dir, name), { force: true });
      console.warn(`[sqlite] removed ${name}: a partial copy beside ${base} left by process ${pid}, which is no longer running.`);
    } catch {
      // Left for the next start. A sweep must never stop the database opening.
    }
  }
}

/** False only when the OS says there is no such process. EPERM means there is one. */
function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/* ------------------------------------------------------------------------ *
 * Moving this process onto a file that was replaced (a restore)             *
 * ------------------------------------------------------------------------ */

/**
 * Something in this process that holds a client open on a local database
 * file: the relational SqlStorage, the doc-blob LibsqlAdapter and the shared
 * rate-limit store each register themselves when they open a `file:` URL.
 */
export interface LocalSqliteHolder {
  /** Close the client. Until reopenAfterSwap, its statements fail with CLIENT_CLOSED. */
  closeForSwap(): void;
  /** Open a new client on the same URL — the file now at that path — and redo its setup. */
  reopenAfterSwap(): void;
}

/**
 * Weakly held, so a holder that is otherwise gone (a test's throwaway
 * SqlStorage) is not kept alive by being registered.
 */
const holders: Array<{ file: string; ref: WeakRef<LocalSqliteHolder> }> = [];

export function registerLocalSqlite(url: string, holder: LocalSqliteHolder): void {
  const file = localSqlitePath(url);
  if (file) holders.push({ file, ref: new WeakRef(holder) });
}

/**
 * Replace the database file at `file` (inside `swap`) and move every holder in
 * this process onto the replacement. Returns how many holders were moved.
 *
 * ## Why a restore cannot just rename the file
 *
 * A rename swaps the NAME. Every connection already open keeps the previous
 * file's inode. In rollback-journal mode their next write failed ("attempt to
 * write a readonly database") — loud. In WAL mode it SUCCEEDS, into the old
 * inode's log, which nothing will read again: measured end to end through the
 * restore route, a product created after a 200 OK restore was listed by the
 * running site and gone after the restart the restore asks for. A checkout in
 * that window is confirmed to the customer and then vanishes.
 *
 * ## The order
 *
 *  1. Close every holder's client, BEFORE the rename. Otherwise a statement
 *     from another request can land in the old inode between the rename and
 *     the close. And closing the last connection to a WAL database deletes
 *     `-wal` and `-shm` BY NAME: harmless now, while those names still belong
 *     to the old file; destructive after the restored file has opened its own.
 *  2. `swap`: the rename, and the removal of any stale siblings.
 *  3. Reopen every holder — ALWAYS, in a `finally`, so a failed rename leaves
 *     the process on the file that is still there rather than closed.
 *
 * Between 1 and 3 (a rename and two unlinks) a statement fails with
 * CLIENT_CLOSED instead of succeeding somewhere invisible. A holder that
 * cannot reopen stays closed and fails every call until a restart — loud,
 * never silent. Other PROCESSES cannot be reached from here; the restore says
 * so with `restartRequired`.
 */
export async function swapLocalSqliteFile(file: string, swap: () => Promise<void>): Promise<number> {
  const target = path.resolve(file);
  const mine: LocalSqliteHolder[] = [];
  for (let i = holders.length - 1; i >= 0; i -= 1) {
    const holder = holders[i].ref.deref();
    if (!holder) holders.splice(i, 1);
    else if (holders[i].file === target) mine.push(holder);
  }
  const reason = (err: unknown) => (err instanceof Error ? err.message : String(err));
  for (const h of mine) {
    try {
      h.closeForSwap();
    } catch (err) {
      console.warn(`[sqlite] closing a client on ${target} before replacing it failed: ${reason(err)}`);
    }
  }
  try {
    await swap();
  } finally {
    for (const h of mine) {
      try {
        h.reopenAfterSwap();
      } catch (err) {
        console.error(
          `[sqlite] could not reopen ${target} after it was replaced (${reason(err)}); `
          + 'this process refuses database calls until it is restarted.',
        );
      }
    }
  }
  return mine.length;
}
