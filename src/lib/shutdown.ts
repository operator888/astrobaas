/**
 * Graceful shutdown: finish what is in flight, write what is buffered, then go.
 *
 * ## What happened without it
 *
 * Nothing in the app listened for SIGTERM. `systemctl restart`, `docker stop`
 * and every deploy therefore killed the process wherever it happened to be:
 *
 *  - a checkout half-way through `POST /api/orders` — stock reserved, the
 *    order not yet written, the customer shown a connection error and left
 *    wondering whether to pay again;
 *  - up to a minute of buffered article views (src/lib/views.ts), which exist
 *    ONLY in memory until the scheduler's next tick writes them;
 *  - the scheduler's interval, mid-way through deciding what to do next.
 *
 * ## What happens now
 *
 * On the first SIGTERM or SIGINT:
 *
 *  1. The process is marked DRAINING. /readyz answers 503 from this moment, so
 *     a load balancer or orchestrator stops sending new traffic here.
 *  2. The scheduler's interval is cleared, so no new sweep starts.
 *  3. We wait for the in-flight request count (kept by the outermost
 *     middleware wrapper) to reach zero — bounded by SHUTDOWN_TIMEOUT_MS.
 *     Requests that arrive meanwhile are still SERVED: behind a single-node
 *     nginx there is nowhere else for them to go, and refusing them would just
 *     move the error page earlier.
 *  4. A scheduler sweep that was already running is waited for, within what
 *     is left of the same budget. It stops at its next check once the
 *     scheduler is stopped, so this is normally the tail of one database
 *     pass, not a backup upload.
 *  5. Buffered views are written.
 *  6. The scheduler lease is released, so another process takes over the
 *     sweeps at its next tick instead of after the lease TTL. LAST, after
 *     the flush: on the libSQL doc-blob driver a write replaces the whole
 *     document, and a successor's first sweep must not interleave with this
 *     process's final write.
 *  7. The process exits 0, and logs one line saying what it did.
 *
 * A SECOND signal exits immediately. An operator pressing Ctrl-C twice, or a
 * supervisor that has run out of patience, means it.
 *
 * ## The time budget
 *
 * SHUTDOWN_TIMEOUT_MS (default 25 s) is the WHOLE budget: the wait for
 * in-flight requests gets all of it except a reserve kept back for the view
 * flush. It must be shorter than the supervisor's own stop timeout, or the
 * supervisor's SIGKILL arrives first and all of this is moot:
 *
 *   systemd   TimeoutStopSec=30 in deploy/systemd/astrobaas.service
 *   docker    `docker stop` waits 10 s by default — the Dockerfile sets 8 s,
 *             and docker-compose.yml raises both (stop_grace_period: 30s)
 *
 * ## What it does not do
 *
 * It does not close the listening socket: the adapter owns the HTTP server and
 * does not hand it to application code. That is why step 3 serves rather than
 * refuses, and why /readyz is the signal to stop routing here.
 *
 * It counts a request until its handler has produced a Response. For API
 * routes — every write, including checkout — that is when the work is done.
 * A streamed HTML page may still be rendering its body after that; losing the
 * tail of a page render at exit is a reload, not a lost order.
 */
import {
  inflightRequests,
  markDraining,
  isDraining,
  requestStarted,
  requestFinished,
  reportError,
} from './observability';
import { stopScheduler, awaitSchedulerSweep, releaseSchedulerLease } from './scheduler';
import { flushViewsBeforeExit, pendingViewCount } from './views';

const DEFAULT_TIMEOUT_MS = 25_000;
/** An hour is not a shutdown; it is a hang with extra steps. */
const MAX_TIMEOUT_MS = 10 * 60_000;
/** Kept back from the request wait so the view flush always gets a turn. */
const MAX_FLUSH_RESERVE_MS = 5_000;
/** The flush is given at least this long even when the request wait used everything. */
const MIN_FLUSH_MS = 1_000;
const POLL_MS = 50;

const falsy = (v: string | undefined) => v === '0' || v === 'false';

/** On unless GRACEFUL_SHUTDOWN=0. An escape hatch, not a tuning knob. */
export function gracefulShutdownEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !falsy(env.GRACEFUL_SHUTDOWN?.trim());
}

/** SHUTDOWN_TIMEOUT_MS, default 25 s, clamped to [0, 10 min]. */
export function shutdownTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.SHUTDOWN_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_TIMEOUT_MS;
  const n = Number(raw);
  // A typo must not become "wait forever" or "do not wait at all" silently —
  // it falls back to the default, which is what an unset value means too.
  if (!Number.isFinite(n) || n < 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.floor(n), MAX_TIMEOUT_MS);
}

/** What a drain did. Logged as one line; returned for tests. */
export interface DrainReport {
  signal: string;
  timeout_ms: number;
  waited_ms: number;
  scheduler_stopped: boolean;
  /** Requests still unfinished when the wait gave up. 0 on a clean drain. */
  abandoned_requests: number;
  views_written: number;
  /** Views still buffered after the flush — a failed write, or a late request. */
  views_lost: number;
  /** A scheduler sweep was still running when the wait for it ran out. */
  sweep_abandoned?: boolean;
  /** The scheduler lease was ours and has been given up. */
  lease_released?: boolean;
}

/** The pieces a drain touches, injectable so the sequence can be tested on its own. */
export interface DrainDeps {
  markDraining: () => void;
  stopScheduler: () => boolean;
  inflight: () => number;
  flushViews: () => Promise<number>;
  pendingViews: () => number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /**
   * Wait up to `ms` for a scheduler sweep already running; true when none is
   * left. Optional so a caller that has no scheduler need not fake one.
   */
  awaitSweep?: (ms: number) => Promise<boolean>;
  /** Give up the scheduler lease. Called after the flush. */
  releaseLease?: () => Promise<boolean>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const realDeps: DrainDeps = {
  markDraining,
  stopScheduler,
  inflight: inflightRequests,
  flushViews: flushViewsBeforeExit,
  pendingViews: pendingViewCount,
  now: () => Date.now(),
  sleep,
  awaitSweep: awaitSchedulerSweep,
  releaseLease: releaseSchedulerLease,
};

/** Resolve with `fallback` if `p` has not settled within `ms`. */
function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([p.catch(() => fallback), expired]).finally(() => clearTimeout(timer));
}

/**
 * Run the drain sequence. Never throws; never exits — the caller decides that.
 *
 * The ORDER is the point. Draining is announced before anything else so the
 * balancer starts moving traffic while we wait. The scheduler stops before the
 * wait so it cannot start a sweep we would then cut off. Views are flushed
 * AFTER the wait, because the requests we were waiting for are the ones
 * recording them.
 */
export async function drain(
  signal: string,
  timeoutMs: number,
  deps: DrainDeps = realDeps,
): Promise<DrainReport> {
  const started = deps.now();
  const deadline = started + timeoutMs;
  const flushReserve = Math.min(MAX_FLUSH_RESERVE_MS, Math.floor(timeoutMs / 5));
  const waitUntil = deadline - flushReserve;

  deps.markDraining();

  let schedulerStopped = false;
  try {
    schedulerStopped = deps.stopScheduler();
  } catch (err) {
    reportError(err, { where: 'shutdown.stopScheduler' });
  }

  while (deps.inflight() > 0 && deps.now() < waitUntil) {
    await deps.sleep(Math.min(POLL_MS, Math.max(1, waitUntil - deps.now())));
  }
  const waited = deps.now() - started;
  const abandoned = deps.inflight();

  // The sweep gets what is left of the request budget, not the flush reserve:
  // views that exist only in memory matter more than the tail of a sweep the
  // next leader will simply run again.
  let sweepAbandoned = false;
  if (deps.awaitSweep) {
    const budget = Math.max(0, waitUntil - deps.now());
    sweepAbandoned = !(await within(deps.awaitSweep(budget), budget + POLL_MS, false));
  }

  const flushBudget = Math.max(MIN_FLUSH_MS, deadline - deps.now());
  const written = await within(deps.flushViews(), flushBudget, 0);

  // Bounded like the flush. A lease that cannot be released lapses on its own
  // after its TTL; waiting longer for it would only delay the exit.
  let leaseReleased = false;
  if (deps.releaseLease) {
    leaseReleased = await within(deps.releaseLease(), MIN_FLUSH_MS, false);
  }

  return {
    signal,
    timeout_ms: timeoutMs,
    waited_ms: waited,
    scheduler_stopped: schedulerStopped,
    abandoned_requests: abandoned,
    views_written: written,
    views_lost: deps.pendingViews(),
    sweep_abandoned: sweepAbandoned,
    lease_released: leaseReleased,
  };
}

/** The conventional exit status for "killed by this signal": 128 + its number. */
function signalExitCode(signal: string): number {
  return signal === 'SIGINT' ? 130 : 143;
}

function logLine(fields: Record<string, unknown>): void {
  try {
    console.log(JSON.stringify({ t: new Date().toISOString(), type: 'shutdown', ...fields }));
  } catch {
    /* logging must never stand between a process and its exit */
  }
}

/**
 * Keyed on globalThis, not a module variable. The dev server re-evaluates the
 * middleware (and this module with it) on every edit; a module-level flag
 * would reset each time and stack another pair of handlers, each of which
 * would run its own drain on the next Ctrl-C.
 */
const INSTALLED = Symbol.for('astrobaas.gracefulShutdown.installed');

export interface InstallOptions {
  env?: NodeJS.ProcessEnv;
  /** Replaced in tests so the assertion can run before the process goes. */
  exit?: (code: number) => void;
}

/**
 * Register the SIGTERM/SIGINT handlers. Once per process; returns whether this
 * call was the one that registered them.
 *
 * Called from the outermost middleware wrapper, i.e. on the first request —
 * never at import time, so a unit test that loads this module (or anything
 * that imports it) does not have its Ctrl-C taken over. Before the first
 * request there is nothing in flight and nothing buffered, so a process
 * stopped then loses nothing by dying the default way.
 */
export function installGracefulShutdown(options: InstallOptions = {}): boolean {
  const env = options.env ?? process.env;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  if (!gracefulShutdownEnabled(env)) return false;
  const g = globalThis as Record<symbol, unknown>;
  if (g[INSTALLED]) return false;
  g[INSTALLED] = true;

  let stopping = false;
  const onSignal = (signal: NodeJS.Signals) => {
    if (stopping) {
      logLine({ level: 'warn', signal, msg: 'second signal: exiting now, without waiting' });
      exit(signalExitCode(signal));
      return;
    }
    stopping = true;
    const timeoutMs = shutdownTimeoutMs(env);
    logLine({ level: 'info', signal, msg: 'draining', inflight: inflightRequests(), timeout_ms: timeoutMs });

    // A backstop in case something in the drain never settles. `unref` so it
    // cannot itself be what keeps a finished process alive.
    const backstop = setTimeout(() => {
      logLine({ level: 'error', signal, msg: 'drain did not finish; forcing exit' });
      exit(1);
    }, timeoutMs + 2 * MIN_FLUSH_MS + 2_000);
    if (typeof backstop.unref === 'function') backstop.unref();

    void drain(signal, timeoutMs).then(
      (report) => {
        clearTimeout(backstop);
        logLine({
          level: report.abandoned_requests > 0 || report.views_lost > 0 ? 'warn' : 'info',
          msg: report.abandoned_requests > 0
            ? `timed out with ${report.abandoned_requests} request(s) still in flight`
            : 'drained',
          ...report,
        });
        exit(0);
      },
      (err) => {
        clearTimeout(backstop);
        reportError(err, { where: 'shutdown.drain' });
        exit(1);
      },
    );
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  return true;
}

/**
 * Count one request for the drain, registering the handlers on first use.
 *
 * Returns the matching "done" function, which is safe to call more than once:
 * the middleware calls it from a `finally`, and a double decrement would let
 * a drain exit under a request that is still running.
 */
export function trackRequest(): () => void {
  installGracefulShutdown();
  requestStarted();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    requestFinished();
  };
}

export { isDraining };
