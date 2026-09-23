/**
 * Lightweight, dependency-free observability: in-process request counters
 * (exposed as Prometheus text at /metrics when METRICS_ENABLED=1), opt-in
 * structured request logging (LOG_REQUESTS=1), and a small reportError() shim.
 *
 * Counters are per-process (reset on restart) — for fleet-wide metrics, scrape
 * each instance. Good enough to answer "is it serving / erroring" without a
 * metrics dependency.
 *
 * Two pieces of process state live here as well, because they are read by the
 * cheapest routes in the app and must not drag the storage layer in with them:
 * how many requests are in flight right now, and whether the process has been
 * told to shut down (see src/lib/shutdown.ts). /readyz reads the second, the
 * drain loop reads the first, and /metrics publishes both.
 */
const startedAtMs = Date.now();

let totalRequests = 0;
let totalErrors = 0; // 5xx
const byClass: Record<string, number> = { '1xx': 0, '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 };

/**
 * 429s, counted on their own.
 *
 * They were folded into `4xx`, where a login flood, a misconfigured storefront
 * hammering the API and a scraper all look the same as a normal day's 404s. A
 * rate limit that fires is the one 4xx an operator has to act on — either the
 * limit is too tight for real traffic (and customers are being refused) or
 * something is attacking — so it gets a series an alert can be written against.
 */
let rateLimited = 0;

/**
 * Request latency, as a Prometheus histogram.
 *
 * The four counters above say whether the process is answering; none of them
 * says whether it is answering in 30 ms or in 8 s, which is the difference
 * between a shop and a shop nobody can check out on. Upper bounds in SECONDS,
 * as Prometheus expects, spanning a cached JSON read to an upload that is
 * about to hit the proxy's timeout.
 *
 * Deliberately UNLABELLED. A per-route label is what makes this useful in a
 * dashboard and also what makes it a cardinality bomb: every slug, id and
 * probe path a scanner invents would mint a new series in the scraper, held
 * forever. The access log already has the per-path detail.
 */
export const LATENCY_BUCKETS_SECONDS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] as const;
/** Per-bucket (NOT cumulative) counts; the last slot is the +Inf overflow. */
const latencyCounts: number[] = new Array(LATENCY_BUCKETS_SECONDS.length + 1).fill(0);
let latencySum = 0;
let latencyCount = 0;

/**
 * Requests that have entered the middleware and not yet produced a Response.
 *
 * Incremented and decremented ONLY by the outermost middleware wrapper (and
 * the decrement is in a `finally`, so a handler that throws cannot leave the
 * count stuck above zero and make every shutdown wait out its full timeout).
 */
let inflight = 0;
let draining = false;

const truthy = (v: string | undefined) => v === '1' || v === 'true';

/**
 * Tally one handled response by its status, and — when the caller knows it —
 * how long it took.
 *
 * `ms` is optional so that a caller written before the histogram existed still
 * compiles and still counts; it simply contributes nothing to the latency
 * series. A negative or non-finite duration (a clock step between the two
 * readings) is dropped rather than recorded as a 0 ms request, which would
 * drag the low buckets towards a speed nobody measured.
 */
export function recordRequest(status: number, ms?: number): void {
  totalRequests += 1;
  const cls = `${Math.floor(status / 100)}xx`;
  if (cls in byClass) byClass[cls] += 1;
  if (status >= 500) totalErrors += 1;
  if (status === 429) rateLimited += 1;
  if (typeof ms === 'number' && Number.isFinite(ms) && ms >= 0) {
    const seconds = ms / 1000;
    let i = LATENCY_BUCKETS_SECONDS.findIndex((le) => seconds <= le);
    if (i === -1) i = LATENCY_BUCKETS_SECONDS.length; // the +Inf slot
    latencyCounts[i] += 1;
    latencySum += seconds;
    latencyCount += 1;
  }
}

/** A request entered the outermost middleware. Pair every call with `requestFinished`. */
export function requestStarted(): void {
  inflight += 1;
}

/**
 * A request produced its Response (or threw).
 *
 * Clamped at zero. An unpaired call is a bug in the caller, but a NEGATIVE
 * count would be worse than the bug: the drain loop waits for `=== 0`, and a
 * count of -1 with one real request in flight reads as zero and exits under
 * it.
 */
export function requestFinished(): void {
  if (inflight > 0) inflight -= 1;
}

/** How many requests are being handled right now. */
export function inflightRequests(): number {
  return inflight;
}

/**
 * The process has been told to stop. One-way: nothing un-drains a process.
 *
 * Read by /readyz so a load balancer stops routing here while the requests
 * already in flight finish.
 */
export function markDraining(): void {
  draining = true;
}

export function isDraining(): boolean {
  return draining;
}

export function requestLoggingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return truthy(env.LOG_REQUESTS);
}

/** One structured JSON line per request (when LOG_REQUESTS=1). Never throws. */
export function logRequest(info: { method: string; path: string; status: number; ms: number; ip?: string }): void {
  if (!requestLoggingEnabled()) return;
  try {
    console.log(JSON.stringify({ t: new Date().toISOString(), type: 'request', ...info }));
  } catch {
    /* logging must never break the request */
  }
}

/** Structured error reporting shim — swap the sink here to wire Sentry/etc. */
export function reportError(err: unknown, context: Record<string, unknown> = {}): void {
  try {
    console.error(JSON.stringify({ t: new Date().toISOString(), level: 'error', message: err instanceof Error ? err.message : String(err), ...context }));
  } catch {
    console.error(err);
  }
}

export function metricsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return truthy(env.METRICS_ENABLED);
}

/**
 * The histogram block, CUMULATIVE as the exposition format requires: each
 * `le` bucket counts every request at or below it, and `+Inf` equals `_count`.
 * A scraper computes quantiles from the differences, so a per-bucket count
 * published as if it were cumulative produces percentiles that look plausible
 * and are wrong.
 */
function renderLatencyHistogram(): string[] {
  const out = [
    '# HELP astrobaas_request_duration_seconds Time from entering the middleware to producing the response.',
    '# TYPE astrobaas_request_duration_seconds histogram',
  ];
  let running = 0;
  LATENCY_BUCKETS_SECONDS.forEach((le, i) => {
    running += latencyCounts[i];
    out.push(`astrobaas_request_duration_seconds_bucket{le="${le}"} ${running}`);
  });
  running += latencyCounts[LATENCY_BUCKETS_SECONDS.length];
  out.push(`astrobaas_request_duration_seconds_bucket{le="+Inf"} ${running}`);
  // Summed in seconds as floats; nine significant figures is plenty for a
  // per-process total and stops a long uptime printing 17-digit noise.
  out.push(`astrobaas_request_duration_seconds_sum ${Number(latencySum.toPrecision(9))}`);
  out.push(`astrobaas_request_duration_seconds_count ${latencyCount}`);
  return out;
}

/** Render the current counters as Prometheus exposition text. */
export function renderMetrics(): string {
  const uptime = Math.floor((Date.now() - startedAtMs) / 1000);
  const lines = [
    '# HELP astrobaas_requests_total Total HTTP requests handled.',
    '# TYPE astrobaas_requests_total counter',
    `astrobaas_requests_total ${totalRequests}`,
    '# HELP astrobaas_requests_by_class Requests by status class.',
    '# TYPE astrobaas_requests_by_class counter',
    ...Object.entries(byClass).map(([k, v]) => `astrobaas_requests_by_class{class="${k}"} ${v}`),
    '# HELP astrobaas_errors_total 5xx responses.',
    '# TYPE astrobaas_errors_total counter',
    `astrobaas_errors_total ${totalErrors}`,
    '# HELP astrobaas_rate_limited_total 429 responses (a rate limit refused the request).',
    '# TYPE astrobaas_rate_limited_total counter',
    `astrobaas_rate_limited_total ${rateLimited}`,
    ...renderLatencyHistogram(),
    '# HELP astrobaas_inflight_requests Requests being handled right now.',
    '# TYPE astrobaas_inflight_requests gauge',
    `astrobaas_inflight_requests ${inflight}`,
    '# HELP astrobaas_draining 1 while the process is shutting down and finishing in-flight requests.',
    '# TYPE astrobaas_draining gauge',
    `astrobaas_draining ${draining ? 1 : 0}`,
    '# HELP astrobaas_uptime_seconds Process uptime in seconds.',
    '# TYPE astrobaas_uptime_seconds gauge',
    `astrobaas_uptime_seconds ${uptime}`,
    '',
  ];
  return lines.join('\n');
}
