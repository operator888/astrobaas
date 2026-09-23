#!/usr/bin/env node
/**
 * /metrics: a latency histogram and a 429 counter, still valid Prometheus text.
 *
 * ## What was missing
 *
 * Four series — requests, requests by class, 5xx, uptime. They say whether the
 * process answers; nothing said how FAST, and a rate limit that was refusing
 * real customers hid inside `4xx` next to every 404.
 *
 * ## What this checks
 *
 *  - the histogram lands each request in the right bucket, is cumulative, and
 *    its `+Inf` bucket equals `_count` (a scraper computes quantiles from the
 *    differences; a non-cumulative histogram gives wrong percentiles that
 *    look plausible);
 *  - 429s have their own counter;
 *  - the whole exposition parses: every sample belongs to a family declared
 *    with HELP and TYPE, before its samples, and no family is declared twice;
 *  - the wrapper in src/middleware.ts actually feeds it (see
 *    tests/observe-wrapper.test.mjs).
 *
 * Run with:  node tests/metrics.test.mjs
 */
import { loadTs, readRepo } from './lib/load.mjs';

let pass = 0;
let fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };

const O = await loadTs('src/lib/observability.ts');

/** Parse the exposition format strictly enough to catch what a scraper rejects. */
function parse(text) {
  const families = new Map(); // name -> { help, type, samples: [] }
  const errors = [];
  const order = [];
  for (const line of text.split('\n')) {
    if (line === '') continue;
    let m = line.match(/^# (HELP|TYPE) ([a-zA-Z_:][a-zA-Z0-9_:]*) (.+)$/);
    if (m) {
      const f = families.get(m[2]) ?? { samples: [] };
      const key = m[1].toLowerCase();
      if (f[key] !== undefined) errors.push(`duplicate ${m[1]} for ${m[2]}`);
      if (f.samples.length) errors.push(`${m[1]} for ${m[2]} after its samples`);
      f[key] = m[3];
      families.set(m[2], f);
      if (!order.includes(m[2])) order.push(m[2]);
      continue;
    }
    m = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{([^}]*)\})? (-?[0-9.eE+-]+|\+Inf|NaN)$/);
    if (!m) { errors.push(`unparseable: ${line}`); continue; }
    const [, name, , labels, value] = m;
    if (labels !== undefined && !/^([a-zA-Z_][a-zA-Z0-9_]*="[^"\\]*")(,[a-zA-Z_][a-zA-Z0-9_]*="[^"\\]*")*$/.test(labels)) {
      errors.push(`bad labels: ${line}`);
    }
    const base = families.has(name) ? name : name.replace(/_(bucket|sum|count)$/, '');
    const f = families.get(base);
    if (!f || !f.type) { errors.push(`sample before TYPE: ${line}`); continue; }
    if (base !== name && f.type !== 'histogram' && f.type !== 'summary') errors.push(`suffix on a ${f.type}: ${line}`);
    f.samples.push({ name, labels: labels ?? '', value: Number(value === '+Inf' ? Infinity : value) });
  }
  for (const [name, f] of families) {
    if (!f.help) errors.push(`no HELP for ${name}`);
    if (!['counter', 'gauge', 'histogram', 'summary', 'untyped'].includes(f.type)) errors.push(`bad TYPE for ${name}: ${f.type}`);
  }
  return { families, errors };
}

/* ---- a known set of requests ---- */
O.recordRequest(200, 3);       // 0.003 s
O.recordRequest(429, 5);       // exactly on the 0.005 bound — `le` is inclusive
O.recordRequest(429, 4);
O.recordRequest(404, 30);      // 0.03 s
O.recordRequest(500, 12_000);  // 12 s — beyond the last bound, +Inf only
O.recordRequest(200);          // no duration: counted, not timed
O.recordRequest(200, Number.NaN);
O.recordRequest(200, -5);      // a clock step: dropped, not recorded as 0 ms

const text = O.renderMetrics();
const { families, errors } = parse(text);

check('the exposition parses with no errors' + (errors.length ? ` (${errors.slice(0, 3).join('; ')})` : ''),
  errors.length === 0);
check('it ends with a newline, as the format requires', text.endsWith('\n'));

const value = (name, labels = '') =>
  [...families.values()].flatMap((f) => f.samples).find((s) => s.name === name && s.labels === labels)?.value;

/* ---- the existing series did not change ---- */
check('existing: requests_total counts everything, timed or not', value('astrobaas_requests_total') === 8);
check('existing: by-class counters still there', value('astrobaas_requests_by_class', 'class="4xx"') === 3
  && value('astrobaas_requests_by_class', 'class="2xx"') === 4);
check('existing: errors_total', value('astrobaas_errors_total') === 1);
check('existing: uptime gauge', families.get('astrobaas_uptime_seconds')?.type === 'gauge');

/* ---- the 429 counter ---- */
check('429s have a counter of their own', families.get('astrobaas_rate_limited_total')?.type === 'counter'
  && value('astrobaas_rate_limited_total') === 2);

/* ---- the histogram ---- */
const h = families.get('astrobaas_request_duration_seconds');
check('the latency histogram is declared as a histogram', h?.type === 'histogram');
const buckets = (h?.samples ?? []).filter((s) => s.name.endsWith('_bucket'));
const le = (b) => b.labels.match(/^le="([^"]+)"$/)?.[1];
const bound = (b) => (le(b) === '+Inf' ? Infinity : Number(le(b)));
check('every bucket has exactly one `le` label', buckets.length > 2 && buckets.every((b) => le(b) !== undefined));
check('bounds ascend and end at +Inf',
  buckets.every((b, i) => i === 0 || bound(b) > bound(buckets[i - 1])) && le(buckets.at(-1)) === '+Inf');
check('bounds match the exported list', buckets.length === O.LATENCY_BUCKETS_SECONDS.length + 1
  && O.LATENCY_BUCKETS_SECONDS.every((b, i) => bound(buckets[i]) === b));
check('counts are CUMULATIVE (never decrease)', buckets.every((b, i) => i === 0 || b.value >= buckets[i - 1].value));
const at = (x) => buckets.find((b) => le(b) === x)?.value;
check('le="0.005" holds the 3, 4 and 5 ms requests (the bound is inclusive)', at('0.005') === 3);
check('le="0.025" still 3 — the 30 ms request is above it', at('0.025') === 3);
check('le="0.05" picks up the 30 ms request', at('0.05') === 4);
check('le="10" does not include the 12 s request', at('10') === 4);
check('+Inf equals _count', at('+Inf') === value('astrobaas_request_duration_seconds_count'));
check('_count is the TIMED requests only (5): no-duration, NaN and negative are left out',
  value('astrobaas_request_duration_seconds_count') === 5);
check('_sum is in seconds', Math.abs(value('astrobaas_request_duration_seconds_sum') - 12.042) < 1e-9);

/* ---- in-flight and draining ---- */
check('in-flight gauge starts at 0', families.get('astrobaas_inflight_requests')?.type === 'gauge'
  && value('astrobaas_inflight_requests') === 0);
O.requestStarted();
O.requestStarted();
O.requestFinished();
O.markDraining();
const after = parse(O.renderMetrics());
const v2 = (name) => [...after.families.values()].flatMap((f) => f.samples).find((s) => s.name === name)?.value;
check('in-flight gauge follows started/finished', v2('astrobaas_inflight_requests') === 1);
check('draining gauge flips to 1', v2('astrobaas_draining') === 1 && O.isDraining() === true);

/* ---- the route still serves the text format ---- */
const route = await readRepo('src/pages/metrics.ts');
check('/metrics still declares the Prometheus text content type',
  route.includes("'Content-Type': 'text/plain; version=0.0.4; charset=utf-8'"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
