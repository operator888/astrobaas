#!/usr/bin/env node
/**
 * The in-dashboard report's aggregation (src/lib/insights.ts).
 *
 * The owner's rule is absolute: no mock or invented data anywhere in the app.
 * For a report, "invented" has a specific shape — a number that looks derived
 * but is not traceable to a recorded fact. So these tests pin the places where a
 * plausible implementation would quietly manufacture one:
 *
 *   · a quiet day silently omitted, making a flat week look busy;
 *   · a ranking padded with zeros so it always shows ten rows;
 *   · a capped store charted as if it were the whole history;
 *   · a bar of width 0 for a post that genuinely has one view.
 *
 * Run with:  node tests/insights.test.mjs
 */
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const cacheDir = path.join(root, 'node_modules', '.cache');
await fs.mkdir(cacheDir, { recursive: true });
const out = path.join(cacheDir, `astrobaas-insights-${process.pid}.mjs`);
await build({
  entryPoints: [path.join(root, 'src/lib/insights.ts')],
  bundle: true, format: 'esm', platform: 'node', packages: 'external',
  outfile: out, logLevel: 'silent',
});
const I = await import(pathToFileURL(out).href);

let passed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed += 1; }
  catch (err) { failures.push(`${name}: ${err.message}`); }
}
function eq(a, b, what = '') {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${what} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
}

// A fixed clock. 2026-09-01T12:00:00Z.
const NOW = Date.UTC(2026, 8, 1, 12, 0, 0);
const day = (offset, h = 6) => new Date(NOW - offset * 86_400_000).toISOString().replace(/T.*/, `T0${h}:00:00.000Z`);

// -------------------------------------------------------------- dayKey

check('dayKey is UTC, not local', () => {
  // Local time would move every bucket for half the world, so two operators
  // reading the same dashboard would see different days.
  eq(I.dayKey('2026-09-01T23:30:00.000Z'), '2026-09-01');
  eq(I.dayKey('2026-09-01T00:30:00.000Z'), '2026-09-01');
});

check('dayKey refuses junk rather than returning a wrong day', () => {
  eq(I.dayKey('not a date'), null);
  eq(I.dayKey(''), null);
});

// ------------------------------------------------------------ daySeries

check('a quiet day is a ZERO bucket, not a missing one', () => {
  // Omitting empty days compresses a quiet fortnight into nothing and makes a
  // flat week look busy — a chart that is wrong about the thing it is for.
  const s = I.daySeries([{ at: day(0) }, { at: day(2) }], (r) => r.at, null, { days: 4, now: NOW });
  eq(s.buckets.length, 4);
  eq(s.buckets.map((b) => b.count), [0, 1, 0, 1]);
  eq(s.total, 2);
});

check('buckets run oldest → newest and end on today', () => {
  const s = I.daySeries([], (r) => r.at, null, { days: 3, now: NOW });
  eq(s.buckets.map((b) => b.day), ['2026-08-30', '2026-08-31', '2026-09-01']);
});

check('records OUTSIDE the window are ignored, not folded into the edge', () => {
  // Folding them into the first bucket is the classic way a 30-day chart grows
  // a spike on day one that represents four years of history.
  const s = I.daySeries(
    [{ at: day(0) }, { at: day(400) }, { at: day(31) }],
    (r) => r.at, null, { days: 7, now: NOW },
  );
  eq(s.total, 1);
  eq(s.buckets[0].count, 0);
});

check('a value function sums money alongside the count', () => {
  const s = I.daySeries(
    [{ at: day(0), cents: 1999 }, { at: day(0), cents: 500 }, { at: day(1), cents: 100 }],
    (r) => r.at, (r) => r.cents, { days: 2, now: NOW },
  );
  eq(s.buckets.map((b) => b.count), [1, 2]);
  eq(s.buckets.map((b) => b.cents), [100, 2499]);
  eq(s.totalCents, 2599);
});

check('peak is the largest bucket, for scaling without a second pass', () => {
  const s = I.daySeries(
    [{ at: day(0) }, { at: day(0) }, { at: day(0) }, { at: day(1) }],
    (r) => r.at, null, { days: 3, now: NOW },
  );
  eq(s.peak, 3);
});

check('an unparseable timestamp is skipped, not bucketed as today', () => {
  const s = I.daySeries([{ at: 'garbage' }, { at: null }, { at: day(0) }], (r) => r.at, null, { days: 2, now: NOW });
  eq(s.total, 1);
});

check('the window is clamped rather than trusted', () => {
  eq(I.daySeries([], (r) => r.at, null, { days: 0, now: NOW }).buckets.length, 1);
  eq(I.daySeries([], (r) => r.at, null, { days: 9999, now: NOW }).buckets.length, 365);
  eq(I.daySeries([], (r) => r.at, null, { days: -5, now: NOW }).buckets.length, 1);
});

// ------------------------------------------------------------- truncation

check('a capped store at its ceiling with no older rows is TRUNCATED', () => {
  // 5 rows, cap 5, all inside a 30-day window: the store evicted whatever came
  // before, so the early buckets are short and the UI must say so.
  const rows = [0, 1, 2, 3, 4].map((i) => ({ at: day(i) }));
  eq(I.daySeries(rows, (r) => r.at, null, { days: 30, now: NOW, cap: 5 }).truncated, true);
});

check('a capped store whose oldest row PREDATES the window is complete', () => {
  // At the ceiling, but we can see back past the window's start, so everything
  // being charted is present. Claiming truncation here would be a false warning.
  const rows = [{ at: day(0) }, { at: day(1) }, { at: day(2) }, { at: day(3) }, { at: day(90) }];
  eq(I.daySeries(rows, (r) => r.at, null, { days: 30, now: NOW, cap: 5 }).truncated, false);
});

check('a store below its ceiling is never truncated', () => {
  const rows = [{ at: day(0) }, { at: day(1) }];
  eq(I.daySeries(rows, (r) => r.at, null, { days: 30, now: NOW, cap: 5000 }).truncated, false);
});

check('an UNCAPPED store is never truncated', () => {
  const rows = [0, 1, 2].map((i) => ({ at: day(i) }));
  eq(I.daySeries(rows, (r) => r.at, null, { days: 30, now: NOW }).truncated, false);
});

// ----------------------------------------------------------------- topBy

check('zeros are dropped — a ranking is not the post list wearing a chart', () => {
  const posts = [
    { id: 'a', title: 'Read', views: 12 },
    { id: 'b', title: 'Unread', views: 0 },
    { id: 'c', title: 'Never', views: undefined },
  ];
  const rows = I.topBy(posts, (p) => p.views ?? 0, (p, v) => ({ id: p.id, label: p.title, value: v }));
  eq(rows.length, 1);
  eq(rows[0].label, 'Read');
});

check('topBy is a total order, so two drivers cannot disagree', () => {
  const posts = [
    { id: 'z', title: 'Same', views: 5 },
    { id: 'a', title: 'Same', views: 5 },
    { id: 'm', title: 'Alpha', views: 5 },
  ];
  const rows = I.topBy(posts, (p) => p.views, (p, v) => ({ id: p.id, label: p.title, value: v }));
  eq(rows.map((r) => r.id), ['m', 'a', 'z'], 'label then id');
});

check('topBy honours its limit and a limit of zero', () => {
  const posts = [1, 2, 3, 4, 5].map((n) => ({ id: `p${n}`, title: `P${n}`, views: n }));
  eq(I.topBy(posts, (p) => p.views, (p, v) => ({ id: p.id, label: p.title, value: v }), 2).map((r) => r.value), [5, 4]);
  eq(I.topBy(posts, (p) => p.views, (p, v) => ({ id: p.id, label: p.title, value: v }), 0), []);
});

check('topBy returns fewer than the limit rather than padding', () => {
  const posts = [{ id: 'a', title: 'A', views: 3 }];
  eq(I.topBy(posts, (p) => p.views, (p, v) => ({ id: p.id, label: p.title, value: v }), 10).length, 1);
});

// ----------------------------------------------------------- groupTotals

check('groupTotals sums into named groups, biggest first', () => {
  const posts = [
    { id: '1', cat: { id: 'g', label: 'Guides' }, views: 10 },
    { id: '2', cat: { id: 'g', label: 'Guides' }, views: 5 },
    { id: '3', cat: { id: 'n', label: 'News' }, views: 20 },
  ];
  const rows = I.groupTotals(posts, (p) => p.cat, (p) => p.views);
  eq(rows.map((r) => [r.label, r.value]), [['News', 20], ['Guides', 15]]);
});

check('records with NO group are shown, not silently dropped', () => {
  // A blog where half the posts have no category should see that, rather than
  // a chart quietly drawn over the other half.
  const posts = [
    { id: '1', cat: { id: 'g', label: 'Guides' }, views: 5 },
    { id: '2', cat: null, views: 40 },
  ];
  const rows = I.groupTotals(posts, (p) => p.cat, (p) => p.views);
  eq(rows.map((r) => [r.label, r.value]), [['Uncategorised', 40], ['Guides', 5]]);
});

check('groupTotals ignores zero and negative values', () => {
  const posts = [{ id: '1', cat: { id: 'a', label: 'A' }, views: 0 }, { id: '2', cat: { id: 'b', label: 'B' }, views: -3 }];
  eq(I.groupTotals(posts, (p) => p.cat, (p) => p.views), []);
});

// ----------------------------------------------------------------- sumBy

check('sumBy tolerates records written before the field existed', () => {
  eq(I.sumBy([{ v: 3 }, { v: undefined }, { v: 'x' }, { v: 4 }], (r) => r.v), 7);
  eq(I.sumBy([], (r) => r.v), 0);
});

// ------------------------------------------------------------ barWidths

check('bar widths are fractions of the viewBox, scaled to the largest', () => {
  eq(I.barWidths([10, 5, 0], 100), [100, 50, 0]);
});

check('a non-zero value never renders as an INVISIBLE bar', () => {
  // "One view" and "no views" are different facts; 0.05px reads as absent.
  const w = I.barWidths([1000, 1], 100);
  eq(w[0], 100);
  if (!(w[1] >= 0.8)) throw new Error(`one view rendered at ${w[1]}`);
});

check('zero is exactly zero — no minimum for a genuinely empty bar', () => {
  eq(I.barWidths([5, 0], 100)[1], 0);
});

check('all-zero input does not divide by zero', () => {
  eq(I.barWidths([0, 0, 0], 100), [0, 0, 0]);
  eq(I.barWidths([], 100), []);
});

check('non-finite values are treated as zero, not NaN width', () => {
  // A NaN in a width attribute makes the browser drop the whole rect.
  eq(I.barWidths([10, NaN, undefined, -4], 100), [100, 0, 0, 0]);
});

if (failures.length) {
  console.error(`\n✗ insights: ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error(`  · ${f}`);
  process.exit(1);
}
console.log(`✓ insights: ${passed} passed`);
