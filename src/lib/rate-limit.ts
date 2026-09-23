/**
 * Pluggable rate-limit store.
 *
 * Default is an in-process fixed-window limiter (zero-config, single-node). For
 * multi-replica deploys where each instance would otherwise under-count, set
 * RATE_LIMIT_STORE=libsql (with a libSQL DATABASE_URL) to share counters across
 * instances via an atomic SQL increment. Both implement the same `RateLimitStore`
 * interface, so the middleware doesn't care which is active.
 *
 * Fixed-window semantics: a key may make up to `limit` hits per `windowMs`.
 */
import type { Client } from '@libsql/client';
import {
  openSqlite, applyLocalSqlitePragmas, registerLocalSqlite, type LocalSqliteHolder,
} from './storage/local-sqlite';

/**
 * What a limiter knows after counting a request.
 *
 * `hit()` returning a bare boolean was enough to REFUSE a request and not
 * enough to tell the caller anything useful about it — so a 429 went out with
 * no Retry-After and no budget, and a client could only guess when to come
 * back. Guessing means retrying immediately, which is the worst possible
 * behaviour from something that has just been told to slow down.
 */
export interface RateLimitResult {
  allowed: boolean;
  /** The ceiling that applied — which varies by principal. */
  limit: number;
  /** Requests left in this window. Never negative. */
  remaining: number;
  /** Epoch ms when the window rolls over. */
  resetAt: number;
  /** Whole seconds until reset, at least 1. For `Retry-After`. */
  retryAfterSeconds: number;
}

export interface RateLimitStore {
  /** Record a hit for `key`; return true if still within `limit` for this window. */
  hit(key: string, windowMs: number, limit: number): boolean | Promise<boolean>;
  /** Record a hit and report the full budget, for the response headers. */
  consume(key: string, windowMs: number, limit: number): RateLimitResult | Promise<RateLimitResult>;
  /**
   * Claim a SINGLE-USE token. Returns true EXACTLY once for `key` within
   * `ttlMs`, and false on every later call inside that window (a replay).
   *
   * This is a DIFFERENT primitive from the counters above, and the difference
   * is load-bearing. `consume(key, ttl, 1)` was used for single-use once and
   * was wrong on the libSQL backend: that store buckets by a FLOORED window
   * index and deletes prior buckets, so a marker created near a window
   * boundary vanished at the boundary while the signed token it guarded stayed
   * valid — a one-time magic link or a solved captcha was redeemable twice,
   * once on each side of the boundary. `consumeOnce` keys the marker to an
   * ABSOLUTE expiry (`now + ttlMs`), so it outlives the token regardless of
   * where wall-clock boundaries fall.
   *
   * Failure mode is also inverted: the counters fail OPEN (a limiter outage
   * must not take the API down), but this fails CLOSED — a credential check
   * that cannot prove a token is unused must refuse it, never wave it through.
   * The cost of a false refusal is one retry with a fresh token; the cost of a
   * false accept is a replayed credential.
   */
  consumeOnce(key: string, ttlMs: number): boolean | Promise<boolean>;
  /**
   * How many hits `key` has in its CURRENT window, without adding one.
   *
   * Needed by throttles that count only FAILURES: the login gate asks "has
   * this account already failed N times?" before it spends a password hash,
   * and counts the attempt only once it has actually failed. A consume-first
   * counter would charge the owner's successful sign-ins to the same budget
   * an attacker is burning.
   *
   * Fails OPEN like the counters (0 on a store error): a limiter outage must
   * not lock anybody out.
   */
  peek(key: string, windowMs: number): number | Promise<number>;
}

/** Shared shaping so both stores report identically. */
export function toResult(count: number, limit: number, resetAt: number, now: number): RateLimitResult {
  return {
    allowed: count <= limit,
    limit,
    remaining: Math.max(0, limit - count),
    resetAt,
    // At least one second: a Retry-After of 0 invites an immediate retry from
    // every throttled client at once.
    retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now) / 1000)),
  };
}

/**
 * The most keys the in-process store holds in EACH of its two maps (counters,
 * single-use markers). Exported so a test can name the shipped value.
 *
 * ## What happens at the cap, and why it changed (S3.1)
 *
 * It used to CLEAR the whole map. That looked like a harmless fail-open on
 * counting and was not: the same store holds the login throttles and the
 * single-use markers for magic links and solved captchas. Anyone who could
 * mint 50,000 keys — rotating addresses, or rotating the email half of a login
 * key — wiped every throttle in the process at once, and re-opened every spent
 * magic link and captcha proof for a second use.
 *
 * Now it evicts in two stages and never wholesale:
 *
 *   1. everything already EXPIRED — forgetting it changes no answer;
 *   2. if that was not enough, the live entries that EXPIRE SOONEST, down to
 *      90% of the cap so the very next insert does not trigger another scan.
 *
 * "Soonest to expire" rather than "first inserted" is deliberate. A flood is
 * made of fresh one-minute API buckets; the entries worth keeping are the
 * fifteen-minute login throttles and magic-link markers. Evicting by expiry
 * drops the flood's own oldest keys first and leaves the long-lived credential
 * guards standing — what goes first is what was about to be forgotten anyway.
 */
export const MEMORY_STORE_MAX_KEYS = 50_000;

/** After an eviction the map is brought down to this share of the cap. */
const EVICT_TO_RATIO = 0.9;

/**
 * Bring `map` under `cap`: expired entries first, then the soonest-expiring
 * live ones. `expiry` reads an entry's absolute expiry (ms).
 *
 * O(n log n) when it has to sort, but it only runs when the map is AT the cap
 * and each run frees a tenth of it — so a flood pays for one scan per few
 * thousand new keys, not one per request.
 */
function evictToFit<V>(map: Map<string, V>, cap: number, now: number, expiry: (v: V) => number): void {
  for (const [k, v] of map) if (expiry(v) <= now) map.delete(k);
  if (map.size < cap) return;
  const target = Math.floor(cap * EVICT_TO_RATIO);
  // `cap - 1` at the very least, so there is always room for the insert that
  // asked — a cap of 1 would otherwise compute a target of 0 and still fit.
  const excess = map.size - Math.min(target, cap - 1);
  if (excess <= 0) return;
  const byExpiry = [...map.entries()].sort((a, b) => expiry(a[1]) - expiry(b[1]));
  for (let i = 0; i < excess; i += 1) map.delete(byExpiry[i]![0]);
}

/** In-process fixed-window limiter. Default; single-node only. */
export class MemoryRateLimitStore implements RateLimitStore {
  private buckets = new Map<string, { count: number; resetAt: number }>();
  /** Single-use markers: key → absolute expiry (ms). Separate from counters. */
  private once = new Map<string, number>();
  private readonly maxKeys: number;

  /**
   * `maxKeys` exists for tests: proving the eviction order against a cap of
   * five is a test, proving it against fifty thousand is a benchmark.
   */
  constructor(opts: { maxKeys?: number } = {}) {
    this.maxKeys = opts.maxKeys && opts.maxKeys > 0 ? Math.floor(opts.maxKeys) : MEMORY_STORE_MAX_KEYS;
  }

  /** Current map sizes. For tests and diagnostics only. */
  sizes(): { buckets: number; once: number } {
    return { buckets: this.buckets.size, once: this.once.size };
  }

  hit(key: string, windowMs: number, limit: number): boolean {
    return this.consume(key, windowMs, limit).allowed;
  }

  consume(key: string, windowMs: number, limit: number): RateLimitResult {
    const now = Date.now();
    const b = this.buckets.get(key);
    if (b && b.resetAt >= now) {
      b.count += 1;
      return toResult(b.count, limit, b.resetAt, now);
    }
    // A NEW window. Room is made only here, for a key that is not already
    // live — so an eviction can never drop the bucket being incremented.
    // Deleting first also moves a renewed key to the end of the map, keeping
    // insertion order meaningful.
    if (b) this.buckets.delete(key);
    if (this.buckets.size >= this.maxKeys) {
      evictToFit(this.buckets, this.maxKeys, now, (v) => v.resetAt);
    }
    const resetAt = now + windowMs;
    this.buckets.set(key, { count: 1, resetAt });
    return toResult(1, limit, resetAt, now);
  }

  peek(key: string, _windowMs: number): number {
    const b = this.buckets.get(key);
    return b && b.resetAt >= Date.now() ? b.count : 0;
  }

  consumeOnce(key: string, ttlMs: number): boolean {
    const now = Date.now();
    const exp = this.once.get(key);
    // A still-valid marker means this key was already claimed: refuse the replay.
    if (exp !== undefined && exp > now) return false;
    if (exp !== undefined) this.once.delete(key);
    if (this.once.size >= this.maxKeys) {
      evictToFit(this.once, this.maxKeys, now, (v) => v);
    }
    this.once.set(key, now + ttlMs);
    return true;
  }
}

/**
 * How often the libSQL store sweeps EVERY expired counter, at most (S3.2).
 *
 * The per-key delete this replaced only ever removed old windows of the key
 * that had just been hit. A key that is never hit again — a visitor's address,
 * an email somebody typed once into the login form — kept its row forever, so
 * the table grew with the number of distinct callers the site had EVER seen.
 */
export const LIBSQL_SWEEP_INTERVAL_MS = 60_000;

/** Shared, durable limiter backed by libSQL/SQLite — correct across replicas. */
export class LibsqlRateLimitStore implements RateLimitStore, LocalSqliteHolder {
  private client: Client;
  private url: string;
  private authToken?: string;
  private ready: Promise<void> | null = null;
  private readonly sweepIntervalMs: number;
  private lastSweep = 0;

  constructor(url: string, authToken?: string, opts: { sweepIntervalMs?: number } = {}) {
    // The shared opener (storage/local-sqlite.ts). This store writes on EVERY
    // request into the same file the site's data lives in, so it is the
    // likeliest caller of all to meet another process's write lock — and with
    // a zero busy timeout it met it as an error, which `consume` turns into
    // "allow": the limiter quietly stopped limiting exactly when a second
    // process was busy.
    this.client = openSqlite(url, authToken);
    this.url = url;
    this.authToken = authToken;
    this.sweepIntervalMs = opts.sweepIntervalMs ?? LIBSQL_SWEEP_INTERVAL_MS;
    // It shares the site's file, so a restore replaces it too — see
    // swapLocalSqliteFile.
    registerLocalSqlite(url, this);
  }

  /** For swapLocalSqliteFile only. `consume` fails open and `consumeOnce` closed until reopened. */
  closeForSwap(): void {
    this.client.close();
  }

  /** For swapLocalSqliteFile only: a new client on the restored file; tables re-created on next use. */
  reopenAfterSwap(): void {
    this.client = openSqlite(this.url, this.authToken);
    this.ready = null;
  }

  /**
   * Create the tables, and bring an OLDER `rate_limits` table up to date.
   *
   * `expires_at` is what makes a global sweep possible. `window_start` alone
   * cannot be compared across keys: it is a window INDEX, `floor(now /
   * windowMs)`, and the login throttle's fifteen-minute index and the API's
   * one-minute index are different numbers for the same moment.
   *
   * Existing installs already have the table without the column, so it is
   * added in place with a default of 0 — which makes every pre-upgrade row
   * immediately sweepable. That is the cleanup the old code never did; the only
   * cost is that the counters live at the moment of the upgrade start again
   * from zero, which a restart does to the memory store anyway.
   *
   * Two replicas starting together can both try the ALTER; the loser's
   * "duplicate column" error is the expected outcome, not a failure.
   */
  private ensure(): Promise<void> {
    if (!this.ready) {
      this.ready = (async () => {
        await applyLocalSqlitePragmas(this.client, this.url);
        await this.client.execute(
          'CREATE TABLE IF NOT EXISTS rate_limits (k TEXT NOT NULL, window_start INTEGER NOT NULL, count INTEGER NOT NULL, expires_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (k, window_start))',
        );
        const cols = await this.client.execute('PRAGMA table_info(rate_limits)');
        if (!cols.rows.some((r) => String(r.name) === 'expires_at')) {
          try {
            await this.client.execute('ALTER TABLE rate_limits ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0');
          } catch (err) {
            if (!/duplicate column/i.test(err instanceof Error ? err.message : String(err))) throw err;
          }
        }
        await this.client.execute('CREATE INDEX IF NOT EXISTS rate_limits_expires_at ON rate_limits (expires_at)');
        await this.client.execute('CREATE TABLE IF NOT EXISTS single_use (k TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)');
      })().catch((err) => {
        // A failed setup is retried on the next call rather than cached for the
        // life of the process as a rejected promise — which would make every
        // counter fail open until a restart.
        this.ready = null;
        throw err;
      });
    }
    return this.ready;
  }

  /**
   * Delete every expired counter and single-use marker, for ALL keys.
   *
   * Public so a test can call it directly. In production it runs from
   * `consume()`/`consumeOnce()` at most once per `sweepIntervalMs`, not awaited.
   * There is no timer: an idle process adds no rows and so has nothing to
   * sweep, and a timer is one more thing holding a process open at shutdown.
   */
  async sweepExpired(now: number = Date.now()): Promise<void> {
    await this.ensure();
    await this.client.execute({ sql: 'DELETE FROM rate_limits WHERE expires_at <= ?', args: [now] });
    await this.client.execute({ sql: 'DELETE FROM single_use WHERE expires_at <= ?', args: [now] });
  }

  private maybeSweep(now: number): void {
    if (now - this.lastSweep < this.sweepIntervalMs) return;
    this.lastSweep = now;
    this.sweepExpired(now).catch(() => { /* best effort; the next interval retries */ });
  }

  async hit(key: string, windowMs: number, limit: number): Promise<boolean> {
    return (await this.consume(key, windowMs, limit)).allowed;
  }

  async consume(key: string, windowMs: number, limit: number): Promise<RateLimitResult> {
    const now = Date.now();
    try {
      await this.ensure();
      const windowStart = Math.floor(now / windowMs);
      // This store buckets by FLOORED window index, so the reset is the start
      // of the next index — not now+windowMs, which would drift a client's
      // backoff a whole window late. The same instant is the row's expiry.
      const resetAt = (windowStart + 1) * windowMs;
      // Atomic increment of this window's counter; RETURNING gives the new count.
      const res = await this.client.execute({
        sql: 'INSERT INTO rate_limits (k, window_start, count, expires_at) VALUES (?, ?, 1, ?) ON CONFLICT(k, window_start) DO UPDATE SET count = count + 1 RETURNING count',
        args: [key, windowStart, resetAt],
      });
      const count = Number(res.rows[0]?.count ?? 1);
      this.maybeSweep(now);
      return toResult(count, limit, resetAt, now);
    } catch (err) {
      // Fail OPEN — a rate-limit store outage must not take down the API.
      console.error('Rate-limit store error (allowing request):', err instanceof Error ? err.message : err);
      return { allowed: true, limit, remaining: limit, resetAt: now + windowMs, retryAfterSeconds: 1 };
    }
  }

  async peek(key: string, windowMs: number): Promise<number> {
    try {
      await this.ensure();
      const res = await this.client.execute({
        sql: 'SELECT count FROM rate_limits WHERE k = ? AND window_start = ?',
        args: [key, Math.floor(Date.now() / windowMs)],
      });
      return Number(res.rows[0]?.count ?? 0);
    } catch (err) {
      console.error('Rate-limit store error (peek reads 0):', err instanceof Error ? err.message : err);
      return 0;
    }
  }

  async consumeOnce(key: string, ttlMs: number): Promise<boolean> {
    const now = Date.now();
    try {
      await this.ensure();
      // Absolute expiry, never a floored window: the marker outlives the token
      // it guards regardless of wall-clock boundaries. The upsert claims in one
      // atomic statement — INSERT when the key is new, re-claim only when an
      // older marker has already expired (`expires_at <= now`), and a no-op
      // (RETURNING nothing) when a live marker is present, which is the replay.
      const res = await this.client.execute({
        sql: 'INSERT INTO single_use (k, expires_at) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET expires_at = excluded.expires_at WHERE single_use.expires_at <= ? RETURNING k',
        args: [key, now + ttlMs, now],
      });
      // Expired markers go in the same throttled sweep as the counters. This
      // used to be a full-table DELETE on every single claim.
      this.maybeSweep(now);
      return res.rows.length > 0;
    } catch (err) {
      // Fail CLOSED — the opposite of the counters. A single-use check that
      // cannot reach its store cannot prove the token is unused, so it must
      // refuse; the caller retries with a fresh token.
      console.error('Single-use store error (refusing token):', err instanceof Error ? err.message : err);
      return false;
    }
  }
}

/** Choose the store from the environment. */
export function selectRateLimitStore(env: NodeJS.ProcessEnv = process.env): RateLimitStore {
  const mode = (env.RATE_LIMIT_STORE || '').toLowerCase();
  const url = env.DATABASE_URL?.trim();
  if ((mode === 'libsql' || mode === 'shared') && url) {
    return new LibsqlRateLimitStore(url, env.DATABASE_AUTH_TOKEN);
  }
  return new MemoryRateLimitStore();
}

let shared: RateLimitStore | null = null;

/**
 * The ONE store this process limits with.
 *
 * `selectRateLimitStore()` CONSTRUCTS a store, and on a libSQL deployment that
 * means opening a database client. Calling it per request — as a health check
 * that wanted to test the limiter did — leaks a client per call.
 *
 * It is also the only way to test the right thing. A freshly constructed store
 * counts perfectly even when the store the application is actually using has
 * failed; the limiter fails OPEN on error, so "a new store works" and "requests
 * are being limited" are different claims. Anything probing the limiter has to
 * probe THIS instance.
 */
export function sharedRateLimitStore(): RateLimitStore {
  if (!shared) shared = selectRateLimitStore();
  return shared;
}

/**
 * A one-line, side-effect-free description of the rate-limit posture for the
 * given env — used for a startup log so operators can see at a glance whether
 * counters are shared. Crucially it flags the silent foot-gun: a multi-driver
 * (libSQL) deployment that left RATE_LIMIT_STORE unset still gets the in-process
 * limiter, which UNDER-COUNTS across replicas.
 */
export function describeRateLimitStore(env: NodeJS.ProcessEnv = process.env): {
  kind: 'memory' | 'libsql';
  shared: boolean;
  warning?: string;
} {
  const mode = (env.RATE_LIMIT_STORE || '').toLowerCase();
  const url = env.DATABASE_URL?.trim();
  if ((mode === 'libsql' || mode === 'shared') && url) {
    return { kind: 'libsql', shared: true };
  }
  const warning =
    url && !mode
      ? 'DATABASE_URL is set but RATE_LIMIT_STORE is not — rate limits are per-process and will UNDER-COUNT across multiple replicas. Set RATE_LIMIT_STORE=libsql to share counters.'
      : undefined;
  return { kind: 'memory', shared: false, warning };
}
