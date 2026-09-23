/**
 * Where a slow request spent its time (C-157).
 *
 * ## What existed, and why it was not this
 *
 * `observability.ts` counts requests and can log one line per request with a
 * total duration. That answers "is it slow", and an operator staring at
 * `ms: 812` has no next step. The roadmap called the missing half a
 * "per-request breakdown", and the useful shape of that is: the slowest recent
 * requests, each broken into named spans, on a screen — not a log format
 * somebody has to grep.
 *
 * ## A ring buffer, in memory, off by default
 *
 * In memory because a profiler that writes to the database makes every request
 * a write, on the exact install already too slow. A ring buffer because
 * unbounded is a memory leak with a nice name. Off by default because the cost
 * is small but not zero, and because a list of recent URLs with timings is
 * information an operator should opt into keeping.
 *
 * Per process, like the counters beside it. Two Node processes behind a load
 * balancer have two buffers, and the screen says so rather than pretending to
 * a fleet-wide view it cannot have.
 *
 * ## Spans are recorded by whoever knows
 *
 * `span()` wraps a promise and records how long it took under a name. The
 * middleware opens a profile, the pieces that do real work time themselves, and
 * anything that never calls `span` simply contributes to the unaccounted
 * remainder — which is itself the useful signal when a page is slow and no span
 * explains it.
 */
export interface ProfileSpan {
  name: string;
  ms: number;
  /** How many times this span ran — 40 × 2 ms of database is the interesting shape. */
  count: number;
}

export interface RequestProfile {
  at: string;
  method: string;
  path: string;
  status: number;
  ms: number;
  spans: ProfileSpan[];
  /** `ms` minus the spans, i.e. the part nothing claimed. */
  unaccounted: number;
}

/** How many requests to keep. Small on purpose: this is a live view, not a store. */
export const PROFILE_BUFFER = 100;

const truthy = (v: string | undefined) => v === '1' || v === 'true';

export function profilingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return truthy(env.PROFILE_REQUESTS);
}

const ring: RequestProfile[] = [];

/**
 * The spans of the request currently being handled.
 *
 * A module-level slot rather than AsyncLocalStorage. That is a real limitation
 * and it is stated rather than hidden: under concurrency a span can land on a
 * neighbouring request's profile. It is acceptable HERE because the numbers are
 * a diagnostic pointing at which page to look at, not an accounting record —
 * and AsyncLocalStorage costs something on every request, on a feature whose
 * purpose is measuring cost. If this ever needs to be exact, that is the
 * change to make, and this comment is where to start.
 */
let current: Map<string, ProfileSpan> | null = null;

export function beginProfile(): void {
  if (!profilingEnabled()) return;
  // NOT re-entrant. `src/middleware.ts` calls `rewrite()` for every
  // locale-prefixed path, which re-enters the middleware — so `/de/blog` opened
  // a profile twice, the inner `endProfile` cleared it, and the OUTER one
  // returned null. Every localised request was therefore missing from the ring
  // buffer and from its own Server-Timing header, on a multilingual install:
  // the profiler was blind to exactly the pages worth profiling.
  if (current) return;
  current = new Map();
}

/** Record a span by hand, in milliseconds. */
export function addSpan(name: string, ms: number): void {
  if (!current) return;
  const existing = current.get(name);
  if (existing) { existing.ms += ms; existing.count += 1; }
  else current.set(name, { name, ms, count: 1 });
}

/**
 * Time a promise under a name.
 *
 * Returns the promise's own result and re-throws its error, so wrapping a call
 * in `span()` can never change what the caller sees — a profiler that swallows
 * an exception is worse than no profiler.
 */
export async function span<T>(name: string, work: () => Promise<T>): Promise<T> {
  if (!current) return work();
  const t0 = Date.now();
  try {
    return await work();
  } finally {
    addSpan(name, Date.now() - t0);
  }
}

/** Closes the profile and RETURNS it, so the caller can build a header from the same object. */
export function endProfile(info: { method: string; path: string; status: number; ms: number }): RequestProfile | null {
  if (!current) return null;
  const spans = [...current.values()].sort((a, b) => b.ms - a.ms);
  const accounted = spans.reduce((sum, s) => sum + s.ms, 0);
  current = null;
  const profile: RequestProfile = {
    at: new Date().toISOString(),
    ...info,
    spans,
    // Clamped at zero: overlapping spans can exceed the wall clock, and a
    // negative "unaccounted" on a screen reads as a bug in the page rather
    // than in the arithmetic.
    unaccounted: Math.max(0, info.ms - accounted),
  };
  ring.push(profile);
  while (ring.length > PROFILE_BUFFER) ring.shift();
  return profile;
}

/** Newest first, which is the order somebody debugging wants. */
export function recentProfiles(): RequestProfile[] {
  return [...ring].reverse();
}

/** The slowest kept requests. */
export function slowestProfiles(limit = 10): RequestProfile[] {
  return [...ring].sort((a, b) => b.ms - a.ms).slice(0, limit);
}

/**
 * Per-path totals, which is where a real problem shows up.
 *
 * One 900 ms request is a cold cache. Ninety 200 ms requests to the same path
 * is the thing to fix, and it is invisible in a list sorted by duration.
 */
export function profileSummary(): { path: string; count: number; totalMs: number; avgMs: number; maxMs: number }[] {
  const byPath = new Map<string, { path: string; count: number; totalMs: number; maxMs: number }>();
  for (const p of ring) {
    const row = byPath.get(p.path) ?? { path: p.path, count: 0, totalMs: 0, maxMs: 0 };
    row.count += 1;
    row.totalMs += p.ms;
    row.maxMs = Math.max(row.maxMs, p.ms);
    byPath.set(p.path, row);
  }
  return [...byPath.values()]
    .map((r) => ({ ...r, avgMs: Math.round(r.totalMs / r.count) }))
    .sort((a, b) => b.totalMs - a.totalMs);
}

/** For tests, and for an operator who wants to start a fresh measurement. */
export function clearProfiles(): void {
  ring.length = 0;
  current = null;
}

/**
 * `Server-Timing`, so the breakdown is in the browser's own network panel.
 *
 * The same numbers as the admin screen, delivered where a developer is already
 * looking. Names are sanitised to the token characters the header grammar
 * allows: a span called `db (posts)` would produce a header a browser drops
 * silently, taking the rest of the timings with it.
 */
export function serverTimingHeader(spans: readonly ProfileSpan[], totalMs: number): string {
  const parts = spans.slice(0, 10).map((s) => `${s.name.replace(/[^A-Za-z0-9_-]/g, '_')};dur=${s.ms}`);
  parts.push(`total;dur=${totalMs}`);
  return parts.join(', ');
}
