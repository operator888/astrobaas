#!/usr/bin/env node
/**
 * Outbound link checking (src/lib/link-check-external.ts).
 *
 * Everything here defends one decision: **only 404 and 410 are called broken.**
 *
 * Bot protection answers 403 to anything without a browser. Rate limits answer
 * 429 because we asked too fast. Plenty of servers answer 405 to HEAD and 200 to
 * GET. A timeout is evidence about the network at that moment. A checker that
 * reports any of those as broken sends an editor to fix a working link, and
 * after two of those nobody opens the report again — so the genuinely broken
 * links go unfixed too, which is worse than never having built it.
 *
 * Run with:  node tests/link-check-external.test.mjs
 */
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const cacheDir = path.join(root, 'node_modules', '.cache');
await fs.mkdir(cacheDir, { recursive: true });
const out = path.join(cacheDir, `astrobaas-linkext-${process.pid}.mjs`);
await build({
  entryPoints: [path.join(root, 'src/lib/link-check-external.ts')],
  bundle: true, format: 'esm', platform: 'node', packages: 'external',
  outfile: out, logLevel: 'silent',
});
const E = await import(pathToFileURL(out).href);

let passed = 0;
const failures = [];
async function check(name, fn) {
  try { await fn(); passed += 1; }
  catch (err) { failures.push(`${name}: ${err.message}`); }
}
function eq(a, b, what = '') {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${what} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
}

const NOW = 1_800_000_000_000;

// ------------------------------------------------------------- verdictFor

await check('only 404 and 410 are BROKEN', () => {
  eq(E.verdictFor(404).verdict, 'broken');
  eq(E.verdictFor(410).verdict, 'broken');
});

await check('2xx and 3xx are OK', () => {
  for (const s of [200, 201, 204, 301, 302, 308]) eq(E.verdictFor(s).verdict, 'ok', String(s));
});

await check('403 is UNKNOWN, and the note says why', () => {
  // Bot protection. The link works perfectly for a reader.
  const v = E.verdictFor(403);
  eq(v.verdict, 'unknown');
  if (!/bot protection/i.test(v.note)) throw new Error(`unhelpful note: ${v.note}`);
});

await check('401, 429 and 5xx are UNKNOWN, never broken', () => {
  for (const s of [401, 429, 500, 502, 503]) eq(E.verdictFor(s).verdict, 'unknown', String(s));
});

await check('an unrecognised status is unknown rather than assumed', () => {
  eq(E.verdictFor(418).verdict, 'unknown');
  eq(E.verdictFor(451).verdict, 'unknown');
});

// ---------------------------------------------------------- selectForSweep

await check('never-checked URLs come first', () => {
  const known = new Map([['https://a.test/1', { url: 'https://a.test/1', verdict: 'ok', checkedAt: NOW - 1000, note: '' }]]);
  const picked = E.selectForSweep(['https://a.test/1', 'https://b.test/1'], known, NOW, 5);
  eq(picked, ['https://b.test/1']);
});

await check('ONE request per host per sweep', () => {
  // A shop with forty links to one domain would otherwise look exactly like a
  // small denial-of-service attempt from its own server.
  const urls = ['https://a.test/1', 'https://a.test/2', 'https://a.test/3', 'https://b.test/1'];
  const picked = E.selectForSweep(urls, new Map(), NOW, 10);
  eq(picked.length, 2);
  eq(new Set(picked.map((u) => new URL(u).host)).size, 2);
});

await check('a recent result is not rechecked', () => {
  const known = new Map([['https://a.test/1', { url: 'https://a.test/1', verdict: 'ok', checkedAt: NOW - 1000, note: '' }]]);
  eq(E.selectForSweep(['https://a.test/1'], known, NOW, 5), []);
});

await check('a stale result IS rechecked', () => {
  const known = new Map([['https://a.test/1', { url: 'https://a.test/1', verdict: 'ok', checkedAt: NOW - E.RECHECK_AFTER_MS - 1, note: '' }]]);
  eq(E.selectForSweep(['https://a.test/1'], known, NOW, 5), ['https://a.test/1']);
});

await check('the limit is honoured', () => {
  const urls = ['a', 'b', 'c', 'd', 'e'].map((h) => `https://${h}.test/1`);
  eq(E.selectForSweep(urls, new Map(), NOW, 2).length, 2);
});

await check('an unparseable URL is skipped rather than throwing', () => {
  eq(E.selectForSweep(['http://[', 'https://a.test/1'], new Map(), NOW, 5), ['https://a.test/1']);
});

await check('selection is deterministic across drivers', () => {
  const urls = ['https://b.test/1', 'https://a.test/1'];
  eq(E.selectForSweep(urls, new Map(), NOW, 5), E.selectForSweep([...urls].reverse(), new Map(), NOW, 5));
});

// ------------------------------------------------------ sweepExternalLinks

await check('a 404 is recorded as broken', async () => {
  E.resetExternalChecks();
  await E.sweepExternalLinks(['https://a.test/gone'], { now: NOW, fetcher: async () => ({ status: 404 }) });
  const r = E.externalCheckState().results;
  eq(r.length, 1);
  eq(r[0].verdict, 'broken');
  eq(r[0].status, 404);
});

await check('HEAD refusal falls back to GET', async () => {
  // Plenty of servers answer 405 to HEAD and 200 to GET. Without the fallback
  // every one of them fills the report with noise that hides the real 404s.
  E.resetExternalChecks();
  const seen = [];
  await E.sweepExternalLinks(['https://a.test/x'], {
    now: NOW,
    fetcher: async (_url, init) => {
      seen.push(init.method);
      return { status: init.method === 'HEAD' ? 405 : 200 };
    },
  });
  eq(seen, ['HEAD', 'GET']);
  eq(E.externalCheckState().results[0].verdict, 'ok');
});

await check('a thrown fetch is UNKNOWN, never broken', async () => {
  // A timeout is evidence about the network at that moment, not the link.
  E.resetExternalChecks();
  await E.sweepExternalLinks(['https://a.test/x'], {
    now: NOW, fetcher: async () => { throw new Error('timed out'); },
  });
  const r = E.externalCheckState().results[0];
  eq(r.verdict, 'unknown');
  if (!/network/i.test(r.note)) throw new Error(`note does not explain: ${r.note}`);
});

await check('a private address is SKIPPED, not fetched', async () => {
  // An author can paste any URL into a post, so this is a server-side request
  // to an attacker-influenceable address. Without the guard, a link to
  // http://169.254.169.254/ makes the checker a cloud-metadata reader.
  E.resetExternalChecks();
  let called = 0;
  await E.sweepExternalLinks(
    ['http://169.254.169.254/latest/meta-data/', 'http://127.0.0.1:8080/x', 'http://localhost/x'],
    { now: NOW, fetcher: async () => { called += 1; return { status: 200 }; } },
  );
  eq(called, 0, 'the guard let a request through');
  const r = E.externalCheckState().results;
  eq(r.length, 3);
  if (!r.every((x) => x.verdict === 'skipped')) throw new Error(JSON.stringify(r));
});

await check('results accumulate across sweeps', async () => {
  E.resetExternalChecks();
  await E.sweepExternalLinks(['https://a.test/1'], { now: NOW, fetcher: async () => ({ status: 200 }) });
  await E.sweepExternalLinks(['https://a.test/1', 'https://b.test/1'], { now: NOW + 1000, fetcher: async () => ({ status: 404 }) });
  const byUrl = Object.fromEntries(E.externalCheckState().results.map((r) => [r.url, r.verdict]));
  eq(byUrl['https://a.test/1'], 'ok', 'the fresh result was rechecked and overwritten');
  eq(byUrl['https://b.test/1'], 'broken');
});

await check('startedAt is set on the first sweep and then stays put', async () => {
  E.resetExternalChecks();
  eq(E.externalCheckState().startedAt, null);
  await E.sweepExternalLinks(['https://a.test/1'], { now: NOW, fetcher: async () => ({ status: 200 }) });
  eq(E.externalCheckState().startedAt, NOW);
  await E.sweepExternalLinks(['https://b.test/1'], { now: NOW + 5000, fetcher: async () => ({ status: 200 }) });
  eq(E.externalCheckState().startedAt, NOW, 'startedAt moved');
});

await check('an empty url list is a no-op', async () => {
  E.resetExternalChecks();
  eq(await E.sweepExternalLinks([], { now: NOW, fetcher: async () => ({ status: 200 }) }), 0);
});

// ------------------------------------------------------------ pendingCount

await check('pendingCount distinguishes "3 of 8" from "finished"', async () => {
  // A report showing three broken links out of eight checked, on a site with
  // four hundred, tells a very different story from one that has finished.
  E.resetExternalChecks();
  await E.sweepExternalLinks(['https://a.test/1'], { now: NOW, fetcher: async () => ({ status: 200 }) });
  eq(E.pendingCount(['https://a.test/1', 'https://b.test/1', 'https://c.test/1'], NOW), 2);
  eq(E.pendingCount(['https://a.test/1'], NOW), 0);
  eq(E.pendingCount(['https://a.test/1'], NOW + E.RECHECK_AFTER_MS + 1), 1);
});

if (failures.length) {
  console.error(`\n✗ link-check-external: ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error(`  · ${f}`);
  process.exit(1);
}
console.log(`✓ link-check-external: ${passed} passed`);
