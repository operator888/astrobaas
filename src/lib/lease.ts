/**
 * Leases: "exactly one process does this", across every process on one
 * database.
 *
 * ## Why this exists
 *
 * Two jobs in this application must not run twice at once:
 *
 *  - the scheduler's sweep (src/lib/scheduler.ts). It sends newsletter
 *    batches, recovery reminders and back-in-stock notices, cancels abandoned
 *    orders and pushes off-site backups. It ran in EVERY process, so a second
 *    replica meant every customer email twice and a second full backup;
 *  - the schema migrations at boot (src/lib/migrations.ts). Two replicas
 *    starting together both saw the old version and both migrated.
 *
 * A lease is a named row that says who is doing the job and until when. The
 * holder renews it while it works; anybody may take it once it has lapsed. A
 * holder that crashes therefore blocks the job for at most one TTL — never
 * forever, which is what a plain lock would do.
 *
 * ## One primitive, two backends
 *
 * libSQL (the doc-blob driver AND the relational driver). A small `leases`
 * table in the same database, beside whatever else is there. NOT a field in
 * the doc-blob document: that document is last-write-wins across processes,
 * so a lease inside it would be a lease anybody's unrelated write could
 * overwrite. The table gets real SQLite semantics — every decision is ONE
 * conditional upsert:
 *
 *     INSERT … ON CONFLICT(name) DO UPDATE …
 *       WHERE leases.holder = excluded.holder OR leases.expires_at <= now
 *     RETURNING holder
 *
 * A row back means we hold it; nothing back means somebody else holds a live
 * lease. There is no read-then-write for two processes to interleave.
 *
 * "now" is the DATABASE's clock (`julianday('now')`), not the caller's. Every
 * replica of a remote libSQL/Turso database therefore compares expiry against
 * the same clock, and skew between the application hosts cannot make one of
 * them think a live lease has lapsed. For a `file:` database the database's
 * clock is the host's clock, and every process is on that host anyway.
 *
 * lowdb (one JSON file). The driver is single-host by construction, so the
 * lease is a file beside the database: `<db>.<name>.lease`, holding
 * `{holder, pid, host, expires_at}`. Every change to it — create, renew, take
 * over, release — happens under a short-lived mutex file created with O_EXCL,
 * and the lease itself is always replaced by an atomic rename, so no process
 * ever reads a half-written lease. A lease whose `pid` is dead on this host is
 * taken over at once rather than after its TTL. The critical sections are
 * SYNCHRONOUS file calls, so nothing else in this process can run inside one.
 *
 * ## What a holder may believe
 *
 * `Leadership` (below) is what the scheduler uses. It remembers when its last
 * successful acquire was SENT, on the monotonic clock, and believes itself the
 * leader only until that moment + TTL − a safety margin. The database sets the
 * expiry when the statement EXECUTES, which is later, so the holder always
 * stops believing before the database stops agreeing. A holder whose database
 * becomes unreachable keeps leading only until that belief runs out — it never
 * leads on a lease nobody could confirm.
 *
 * ## Failure modes, stated plainly
 *
 *  - A holder that crashes: its lease lapses after the TTL and the next
 *    contender's tick takes it. On lowdb, a dead pid on this host is taken over
 *    at the next tick.
 *  - A holder that STALLS for longer than its TTL (a stopped VM, a debugger, a
 *    multi-minute GC pause): somebody else takes the lease and both may run
 *    for the remainder of whatever the stalled one was already doing. It
 *    notices at its next check and stops. The jobs guarded here are written to
 *    survive that overlap (the campaign claim, the backup attempt marker).
 *  - Remote libSQL and a network partition: a leader cut off from the
 *    database stops believing at the end of its TTL; followers cut off from it
 *    cannot acquire. The job pauses rather than doubling. A leader whose
 *    renewals are silently delayed longer than the safety margin is the
 *    stalled-holder case above.
 *  - Clock skew: libSQL uses the database's clock (above). The lowdb file uses
 *    the host clock, which every process shares; a wall-clock STEP forward by
 *    more than the margin can end a lease early, and the stalled-holder case
 *    applies.
 *  - A mutex file left by a process killed inside its microseconds-long
 *    critical section: ignored once it is 10 s old or its pid is dead.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { Client } from '@libsql/client';
import { getDbPath } from './paths';
import {
  openSqlite, applyLocalSqlitePragmas, registerLocalSqlite, type LocalSqliteHolder,
} from './storage/local-sqlite';

/** What an acquire concluded. `holder`/`expiresAt` describe the row as it now stands. */
export interface LeaseResult {
  acquired: boolean;
  /** Who holds it now. Null when nobody does or the store could not say. */
  holder: string | null;
  /** When the current holder's lease lapses (epoch ms, the store's clock). */
  expiresAt: number | null;
}

export interface LeaseInfo {
  name: string;
  holder: string;
  expiresAt: number;
  acquiredAt: number;
  /** The store's own "now" at the time of the read, so expiry can be judged on ITS clock. */
  now: number;
}

export interface LeaseStore {
  readonly kind: 'libsql' | 'file';
  /** Take the lease, or extend it if we already hold it. Atomic. */
  acquire(name: string, holder: string, ttlMs: number): Promise<LeaseResult>;
  /** Extend a lease we hold. False when the row no longer names us. Never takes a lease. */
  renew(name: string, holder: string, ttlMs: number): Promise<boolean>;
  /** Give it up. False when it was not ours (lapsed and taken, or already gone). */
  release(name: string, holder: string): Promise<boolean>;
  read(name: string): Promise<LeaseInfo | null>;
}

const NAME_RE = /^[a-z0-9][a-z0-9_.:-]{0,63}$/i;

function checkName(name: string): void {
  // The name becomes part of a FILE NAME on lowdb. Refusing anything else here
  // is what keeps `../` out of it.
  if (!NAME_RE.test(name)) throw new Error(`Invalid lease name: ${JSON.stringify(name)}`);
}

function checkTtl(ttlMs: number): number {
  if (!Number.isFinite(ttlMs) || ttlMs < 1) throw new Error(`Invalid lease TTL: ${ttlMs}`);
  return Math.floor(ttlMs);
}

/**
 * A holder id that is unique per process AND per call site that asks for one.
 *
 * Host and pid so a person reading the operations screen can tell which
 * machine is doing the work; the random suffix because pids are reused (every
 * container's server is pid 1) and a restarted process must not inherit its
 * predecessor's lease by accident.
 */
export function makeHolderId(): string {
  return `${os.hostname()}:${process.pid}:${crypto.randomBytes(4).toString('hex')}`;
}

/* ------------------------------------------------------------------ *
 * libSQL
 * ------------------------------------------------------------------ */

/**
 * Epoch milliseconds on the DATABASE's clock. julianday('now') is fixed for
 * the duration of one statement, so every use of this inside a statement sees
 * the same instant.
 */
const DB_NOW_MS = "CAST(ROUND((julianday('now') - 2440587.5) * 86400000.0) AS INTEGER)";

/** SQLITE_BUSY is contention, not failure: worth a short retry before giving up. */
const isBusy = (err: unknown): boolean =>
  /SQLITE_BUSY|database is locked/i.test(String((err as { code?: string; message?: string })?.code ?? '')
    + ' ' + String((err as { message?: string })?.message ?? ''));

async function retryBusy<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      if (!isBusy(err)) throw err;
      last = err;
      await new Promise((r) => setTimeout(r, 25 * (i + 1)));
    }
  }
  throw last;
}

/**
 * Every statement below is ONE statement, never an interactive
 * `client.transaction()`. The shared opener gives a local file a
 * one-connection pool, and a transaction holding that connection would make
 * every other statement in the process fail with TRANSACTION_ACTIVE — the
 * trap written down in storage/local-sqlite.ts.
 */
export class LibsqlLeaseStore implements LeaseStore, LocalSqliteHolder {
  readonly kind = 'libsql' as const;
  private client: Client;
  private ready: Promise<void> | null = null;

  constructor(private readonly url: string, private readonly authToken?: string) {
    // The shared opener: the busy timeout on every connection, one-connection
    // pool (storage/local-sqlite.ts). A lease that cannot wait for another
    // process's write lock would fail exactly when two processes are busy.
    this.client = openSqlite(url, authToken);
    // A restore replaces the database file, lease table included; without
    // this, this process would go on renewing a lease in the replaced file.
    registerLocalSqlite(url, this);
  }

  /** For swapLocalSqliteFile only. Lease calls fail until reopened; a holder keeps only the belief it had. */
  closeForSwap(): void {
    this.client.close();
  }

  /** For swapLocalSqliteFile only: a new client on the restored file; the table is re-created on next use. */
  reopenAfterSwap(): void {
    this.client = openSqlite(this.url, this.authToken);
    this.ready = null;
  }

  private ensure(): Promise<void> {
    if (!this.ready) {
      this.ready = (async () => {
        // Never throws; a no-op for a remote URL.
        await applyLocalSqlitePragmas(this.client, this.url);
        await retryBusy(() => this.client.execute(
          'CREATE TABLE IF NOT EXISTS leases ('
          + 'name TEXT PRIMARY KEY, holder TEXT NOT NULL, '
          + 'expires_at INTEGER NOT NULL, acquired_at INTEGER NOT NULL)',
        ));
      })().catch((err) => {
        // Not memoised as a failure: the next call tries again.
        this.ready = null;
        throw err;
      });
    }
    return this.ready;
  }

  async acquire(name: string, holder: string, ttlMs: number): Promise<LeaseResult> {
    checkName(name);
    const ttl = checkTtl(ttlMs);
    await this.ensure();
    // ONE statement decides. `acquired_at` survives a renewal by the same
    // holder so "leader since" means since, not since the last tick.
    const res = await retryBusy(() => this.client.execute({
      sql: `INSERT INTO leases (name, holder, expires_at, acquired_at)
              VALUES (?, ?, ${DB_NOW_MS} + ?, ${DB_NOW_MS})
            ON CONFLICT(name) DO UPDATE SET
              holder = excluded.holder,
              expires_at = excluded.expires_at,
              acquired_at = CASE WHEN leases.holder = excluded.holder
                                 THEN leases.acquired_at ELSE excluded.acquired_at END
            WHERE leases.holder = excluded.holder OR leases.expires_at <= ${DB_NOW_MS}
            RETURNING holder, expires_at`,
      args: [name, holder, ttl],
    }));
    const row = res.rows[0];
    if (row && String(row.holder) === holder) {
      return { acquired: true, holder, expiresAt: Number(row.expires_at) };
    }
    // Informational only — the decision above is already made. A failed read
    // here must not turn "somebody else holds it" into an error.
    const current = await this.read(name).catch(() => null);
    return { acquired: false, holder: current?.holder ?? null, expiresAt: current?.expiresAt ?? null };
  }

  async renew(name: string, holder: string, ttlMs: number): Promise<boolean> {
    checkName(name);
    const ttl = checkTtl(ttlMs);
    await this.ensure();
    const res = await retryBusy(() => this.client.execute({
      sql: `UPDATE leases SET expires_at = ${DB_NOW_MS} + ? WHERE name = ? AND holder = ? RETURNING holder`,
      args: [ttl, name, holder],
    }));
    return res.rows.length > 0;
  }

  async release(name: string, holder: string): Promise<boolean> {
    checkName(name);
    await this.ensure();
    const res = await retryBusy(() => this.client.execute({
      sql: 'DELETE FROM leases WHERE name = ? AND holder = ?',
      args: [name, holder],
    }));
    return Number(res.rowsAffected ?? 0) > 0;
  }

  async read(name: string): Promise<LeaseInfo | null> {
    checkName(name);
    await this.ensure();
    const res = await this.client.execute({
      sql: `SELECT holder, expires_at, acquired_at, ${DB_NOW_MS} AS now FROM leases WHERE name = ?`,
      args: [name],
    });
    const row = res.rows[0];
    if (!row) return null;
    return {
      name,
      holder: String(row.holder),
      expiresAt: Number(row.expires_at),
      acquiredAt: Number(row.acquired_at),
      now: Number(row.now),
    };
  }
}

/* ------------------------------------------------------------------ *
 * lowdb: a lease file beside the database
 * ------------------------------------------------------------------ */

interface LeaseFile {
  name: string;
  holder: string;
  pid: number;
  host: string;
  expires_at: number;
  acquired_at: number;
}

/** A mutex file older than this belongs to a process that died inside a critical section. */
const MUTEX_STALE_MS = 10_000;
const BUSY = Symbol('busy');

function pidAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists, it is just not ours to signal.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Dead on THIS host. A pid from another host (a shared volume) says nothing
 * about our process table, and neither does one from another pid namespace
 * that happens to report the same hostname — in which case the pid we check is
 * some unrelated live process, and the answer is the conservative "alive".
 */
function deadHere(rec: { pid?: unknown; host?: unknown }): boolean {
  return rec.host === os.hostname() && !pidAlive(rec.pid);
}

export class FileLeaseStore implements LeaseStore {
  readonly kind = 'file' as const;

  constructor(private readonly dir: string, private readonly base: string) {}

  /** `<db file>.<name>.lease` — beside the database, so it lives on the same volume. */
  fileFor(name: string): string {
    checkName(name);
    return path.join(this.dir, `${this.base}.${name}.lease`);
  }

  private readLease(file: string): { rec: LeaseFile | null; corrupt: boolean; mtimeMs: number } | null {
    let raw: string;
    let mtimeMs = 0;
    try {
      raw = fs.readFileSync(file, 'utf8');
      mtimeMs = fs.statSync(file).mtimeMs;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    try {
      const rec = JSON.parse(raw) as LeaseFile;
      if (rec && typeof rec.holder === 'string' && Number.isFinite(rec.expires_at)) {
        return { rec, corrupt: false, mtimeMs };
      }
    } catch {
      /* fall through */
    }
    return { rec: null, corrupt: true, mtimeMs };
  }

  private writeLease(file: string, rec: LeaseFile): void {
    // Written whole to a private temp name, then renamed over the lease: a
    // reader sees the old lease or the new one, never half of either.
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(rec));
    try {
      fs.renameSync(tmp, file);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch { /* already gone */ }
      throw err;
    }
  }

  /**
   * Run `fn` holding `<lease>.lock`. SYNCHRONOUS on purpose: nothing else in
   * this process can interleave, and another process is held off by O_EXCL.
   */
  private mutexOnce<T>(file: string, fn: () => T): T | typeof BUSY {
    const mutex = `${file}.lock`;
    let fd: number;
    try {
      fd = fs.openSync(mutex, 'wx');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      try {
        const st = fs.statSync(mutex);
        let owner: { pid?: unknown; host?: unknown } = {};
        try { owner = JSON.parse(fs.readFileSync(mutex, 'utf8')); } catch { /* being written */ }
        const stale = Date.now() - st.mtimeMs > MUTEX_STALE_MS || (owner.pid !== undefined && deadHere(owner));
        if (stale) fs.unlinkSync(mutex);
      } catch {
        /* vanished meanwhile — the retry will see */
      }
      return BUSY;
    }
    try {
      try {
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, host: os.hostname(), at: Date.now() }));
      } finally {
        fs.closeSync(fd);
      }
      return fn();
    } finally {
      try { fs.unlinkSync(mutex); } catch { /* broken as stale by somebody: nothing to undo */ }
    }
  }

  private async withMutex<T>(file: string, fn: () => T): Promise<T> {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Contention lasts microseconds; a handful of short waits is plenty. Still
    // busy after that is reported as an error, which every caller treats as
    // "could not confirm" rather than as a decision.
    for (let i = 0; i < 8; i++) {
      const out = this.mutexOnce(file, fn);
      if (out !== BUSY) return out as T;
      await new Promise((r) => setTimeout(r, 5 + i * 10));
    }
    throw new Error(`lease file busy: ${path.basename(file)}`);
  }

  async acquire(name: string, holder: string, ttlMs: number): Promise<LeaseResult> {
    const ttl = checkTtl(ttlMs);
    const file = this.fileFor(name);
    return this.withMutex(file, () => {
      const now = Date.now();
      const cur = this.readLease(file);
      if (cur?.rec && cur.rec.holder !== holder && cur.rec.expires_at > now && !deadHere(cur.rec)) {
        return { acquired: false, holder: cur.rec.holder, expiresAt: cur.rec.expires_at };
      }
      // An unreadable lease is not ours to trust or to ignore at once: every
      // write is a rename, so this is damage rather than a writer mid-way.
      // Give it one TTL, then replace it.
      if (cur?.corrupt && now - cur.mtimeMs < ttl) {
        return { acquired: false, holder: null, expiresAt: null };
      }
      const rec: LeaseFile = {
        name,
        holder,
        pid: process.pid,
        host: os.hostname(),
        expires_at: now + ttl,
        acquired_at: cur?.rec?.holder === holder ? cur.rec.acquired_at : now,
      };
      this.writeLease(file, rec);
      return { acquired: true, holder, expiresAt: rec.expires_at };
    });
  }

  async renew(name: string, holder: string, ttlMs: number): Promise<boolean> {
    const ttl = checkTtl(ttlMs);
    const file = this.fileFor(name);
    return this.withMutex(file, () => {
      const cur = this.readLease(file);
      if (!cur?.rec || cur.rec.holder !== holder) return false;
      this.writeLease(file, { ...cur.rec, pid: process.pid, host: os.hostname(), expires_at: Date.now() + ttl });
      return true;
    });
  }

  async release(name: string, holder: string): Promise<boolean> {
    const file = this.fileFor(name);
    return this.withMutex(file, () => {
      const cur = this.readLease(file);
      if (!cur?.rec || cur.rec.holder !== holder) return false;
      fs.unlinkSync(file);
      return true;
    });
  }

  async read(name: string): Promise<LeaseInfo | null> {
    const cur = this.readLease(this.fileFor(name));
    if (!cur?.rec) return null;
    return {
      name,
      holder: cur.rec.holder,
      // A dead holder's lease is as good as lapsed; say so rather than
      // reporting a leader that no longer exists.
      expiresAt: deadHere(cur.rec) ? Math.min(cur.rec.expires_at, Date.now()) : cur.rec.expires_at,
      acquiredAt: cur.rec.acquired_at,
      now: Date.now(),
    };
  }
}

/* ------------------------------------------------------------------ *
 * Choosing, sharing
 * ------------------------------------------------------------------ */

/** The store for the configured driver. Both libSQL drivers share the table form. */
export function selectLeaseStore(env: NodeJS.ProcessEnv = process.env): LeaseStore {
  const url = env.DATABASE_URL?.trim();
  if (url) return new LibsqlLeaseStore(url, env.DATABASE_AUTH_TOKEN);
  const dbPath = env === process.env
    ? getDbPath()
    : env.DB_PATH ? path.resolve(env.DB_PATH) : path.resolve(process.cwd(), 'db.json');
  return new FileLeaseStore(path.dirname(dbPath), path.basename(dbPath));
}

let shared: LeaseStore | null = null;

/** The ONE store this process uses — a libSQL store opens a client, so never one per call. */
export function sharedLeaseStore(): LeaseStore {
  if (!shared) shared = selectLeaseStore();
  return shared;
}

export const acquireLease = (name: string, holder: string, ttlMs: number) =>
  sharedLeaseStore().acquire(name, holder, ttlMs);
export const renewLease = (name: string, holder: string, ttlMs: number) =>
  sharedLeaseStore().renew(name, holder, ttlMs);
export const releaseLease = (name: string, holder: string) =>
  sharedLeaseStore().release(name, holder);

/* ------------------------------------------------------------------ *
 * Leadership: a lease held across ticks
 * ------------------------------------------------------------------ */

export interface LeadershipOptions {
  name: string;
  ttlMs: number;
  holder?: string;
  store?: LeaseStore;
  /** Monotonic milliseconds. Injectable for tests. */
  clock?: () => number;
}

export interface LeadershipState {
  name: string;
  holder: string;
  leading: boolean;
  ttlMs: number;
  /** Who holds the lease, as of our last attempt. Us when leading. */
  currentHolder: string | null;
  /** When that lease lapses, ISO, on the store's clock. */
  expiresAt: string | null;
  /** When this process last became the leader. */
  since: string | null;
  lastAttemptAt: string | null;
  /** The last store error, if the last attempt could not reach it. */
  lastError: string | null;
}

export class Leadership {
  readonly name: string;
  readonly holder: string;
  readonly ttlMs: number;
  private readonly store: () => LeaseStore;
  private readonly clock: () => number;
  /** Believe we lead until this monotonic instant. */
  private believedUntil = 0;
  private leading = false;
  private inFlight: Promise<boolean> | null = null;
  private state: Omit<LeadershipState, 'leading'>;

  constructor(opts: LeadershipOptions) {
    this.name = opts.name;
    this.ttlMs = checkTtl(opts.ttlMs);
    this.holder = opts.holder ?? makeHolderId();
    this.store = opts.store ? () => opts.store! : sharedLeaseStore;
    this.clock = opts.clock ?? (() => performance.now());
    this.state = {
      name: this.name, holder: this.holder, ttlMs: this.ttlMs,
      currentHolder: null, expiresAt: null, since: null, lastAttemptAt: null, lastError: null,
    };
  }

  /**
   * How long before the lease's own expiry we stop believing in it. A tenth of
   * the TTL, capped at 5 s — room for the round trip and a busy event loop.
   */
  private get margin(): number {
    return Math.min(5_000, Math.max(1, Math.floor(this.ttlMs / 10)));
  }

  /** Do we lead right now? No I/O: the belief from the last successful tick. */
  isLeader(): boolean {
    return this.leading && this.clock() < this.believedUntil;
  }

  /**
   * Acquire or renew. Never throws. Returns whether we lead after it.
   *
   * Concurrent calls share one attempt, so a slow store cannot pile up
   * overlapping upserts from one process.
   */
  tick(): Promise<boolean> {
    if (!this.inFlight) {
      this.inFlight = this.attempt().finally(() => { this.inFlight = null; });
    }
    return this.inFlight;
  }

  private async attempt(): Promise<boolean> {
    const sentAt = this.clock();
    this.state.lastAttemptAt = new Date().toISOString();
    try {
      const res = await this.store().acquire(this.name, this.holder, this.ttlMs);
      this.state.lastError = null;
      this.state.currentHolder = res.holder;
      this.state.expiresAt = res.expiresAt !== null ? new Date(res.expiresAt).toISOString() : null;
      if (res.acquired) {
        if (!this.leading) this.state.since = new Date().toISOString();
        this.leading = true;
        this.believedUntil = sentAt + this.ttlMs - this.margin;
      } else {
        this.stepDown();
      }
    } catch (err) {
      this.state.lastError = err instanceof Error ? err.message : String(err);
      // Could not confirm either way. Keep leading only on the belief we
      // already had — a lease nobody could renew is not extended by hoping.
      if (!this.isLeader()) this.stepDown();
    }
    return this.isLeader();
  }

  private stepDown(): void {
    this.leading = false;
    this.believedUntil = 0;
    this.state.since = null;
  }

  /** Give the lease up. Never throws; returns whether a lease of ours was removed. */
  async release(): Promise<boolean> {
    // Wait for an attempt in flight, or it could re-acquire right after this.
    await this.inFlight?.catch(() => false);
    const was = this.leading;
    this.stepDown();
    try {
      const removed = await this.store().release(this.name, this.holder);
      if (removed || was) {
        this.state.currentHolder = null;
        this.state.expiresAt = null;
      }
      return removed;
    } catch (err) {
      this.state.lastError = err instanceof Error ? err.message : String(err);
      return false;
    }
  }

  snapshot(): LeadershipState {
    return { ...this.state, leading: this.isLeader() };
  }
}

/* ------------------------------------------------------------------ *
 * Run once, exclusively (migrations)
 * ------------------------------------------------------------------ */

export class LeaseWaitTimeout extends Error {
  constructor(name: string, waitedMs: number, readonly holder: string | null) {
    super(
      `Could not take the "${name}" lease within ${Math.round(waitedMs / 1000)} s`
      + (holder ? ` — it is held by ${holder}` : '')
      + '. Another process is probably doing the same work; this one will try again.',
    );
    this.name = 'LeaseWaitTimeout';
  }
}

export interface ExclusiveOptions {
  ttlMs: number;
  /** How long to wait for somebody else's lease before giving up. */
  waitMs: number;
  pollMs?: number;
  store?: LeaseStore;
  holder?: string;
  log?: (msg: string) => void;
  /** Called when waiting begins — tests use it to see that we waited. */
  onWait?: (holder: string | null) => void;
}

/**
 * Run `fn` while holding `name`, renewing the lease as it runs.
 *
 * Waits (bounded) for another holder to finish; throws LeaseWaitTimeout when
 * the wait runs out. `fn` should re-read whatever it is about to change — the
 * process we waited for may already have done it.
 *
 * A store that cannot be reached at all (as opposed to a lease held by
 * somebody else) runs `fn` WITHOUT the lease, loudly: the store is the same
 * database the work needs, so the work is about to fail on its own, and a
 * lease backend problem must not be what stops a single-process install from
 * booting.
 */
export async function runExclusive<T>(name: string, fn: () => Promise<T>, opts: ExclusiveOptions): Promise<T> {
  const store = opts.store ?? sharedLeaseStore();
  const holder = opts.holder ?? makeHolderId();
  const ttl = checkTtl(opts.ttlMs);
  const poll = Math.max(10, opts.pollMs ?? 500);
  const started = Date.now();
  let waiting = false;

  for (;;) {
    let res: LeaseResult;
    try {
      res = await store.acquire(name, holder, ttl);
    } catch (err) {
      opts.log?.(`[astrobaas] "${name}" lease unavailable (${err instanceof Error ? err.message : err}); running without it`);
      return fn();
    }
    if (res.acquired) break;
    if (!waiting) {
      waiting = true;
      opts.onWait?.(res.holder);
      opts.log?.(`[astrobaas] waiting for "${name}" — held by ${res.holder ?? 'another process'}`);
    }
    const waited = Date.now() - started;
    if (waited >= opts.waitMs) throw new LeaseWaitTimeout(name, waited, res.holder);
    await new Promise((r) => setTimeout(r, Math.min(poll, Math.max(1, opts.waitMs - waited))));
  }

  // Renew at a third of the TTL, so two missed renewals still leave the lease
  // standing. unref: a heartbeat must never be what keeps a process alive.
  const heartbeat = setInterval(() => {
    store.renew(name, holder, ttl).then((ok) => {
      if (!ok) opts.log?.(`[astrobaas] lost the "${name}" lease while still working — another process may start the same work`);
    }, () => { /* transient; the next beat tries again */ });
  }, Math.max(10, Math.floor(ttl / 3)));
  if (typeof heartbeat.unref === 'function') heartbeat.unref();

  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    await store.release(name, holder).catch(() => false);
  }
}
