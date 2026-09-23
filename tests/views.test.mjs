#!/usr/bin/env node
/**
 * The view counter (src/lib/views.ts).
 *
 * `Post.views` was written as 0 in five places, read in two admin displays, and
 * incremented nowhere — so the dashboard presented a permanent zero as
 * measurement. These assertions pin the properties that make a buffered counter
 * honest rather than merely fast.
 *
 * Run with:  node tests/views.test.mjs
 */
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const cacheDir = path.join(root, 'node_modules', '.cache');
await fs.mkdir(cacheDir, { recursive: true });

/* The module writes through LocalDB. Stub it at bundle time so the counter's
   own logic is what is under test, not a database. */
const stub = path.join(cacheDir, `astrobaas-localdb-stub-${process.pid}.ts`);
await fs.writeFile(stub, `
export const __store = new Map();
export const __fail = { bump: false, returnsZero: false, partialAfter: 0 };
export const __calls = { bump: 0 };
export const LocalDB = {
  async bumpPostViews(deltas) {
    __calls.bump += 1;
    if (__fail.bump) throw new Error('write failed');
    if (__fail.returnsZero) return 0;
    let written = 0;
    const landed = new Set();
    for (const [id, delta] of deltas) {
      if (__fail.partialAfter && landed.size >= __fail.partialAfter) {
        const e = new Error('write failed part-way');
        e.landed = landed;
        throw e;
      }
      landed.add(id);
      const p = __store.get(id);
      if (!p) continue;
      const cur = typeof p.views === 'number' && Number.isFinite(p.views) ? p.views : 0;
      // The real write touches ONLY the counter — no updated_at, no change feed.
      __store.set(id, { ...p, views: cur + delta });
      written += 1;
    }
    return written;
  },
};
`);

/* An entry that re-exports BOTH, so the test can reach the stub's state as well
   as the module under test. Bundling views.ts alone hides the stub entirely. */
const entry = path.join(cacheDir, `astrobaas-views-entry-${process.pid}.ts`);
await fs.writeFile(entry, `
export * from ${JSON.stringify(path.join(root, 'src/lib/views.ts'))};
export { __store, __fail, __calls } from ${JSON.stringify(stub)};
`);

const out = path.join(cacheDir, `astrobaas-views-${process.pid}.mjs`);
await build({
  entryPoints: [entry],
  bundle: true, format: 'esm', platform: 'node', packages: 'external',
  outfile: out, logLevel: 'silent',
  plugins: [{
    name: 'stub-localdb',
    setup(b) {
      b.onResolve({ filter: /(^|\/)localdb$/ }, () => ({ path: stub }));
    },
  }],
});
const V = await import(pathToFileURL(out).href);
await fs.rm(out, { force: true });
await fs.rm(entry, { force: true });
await fs.rm(stub, { force: true });

let pass = 0;
let fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };

/* The stub's state, reachable because esbuild bundled it in. */
const seed = (id, views) => V.__store.set(id, { id, views });

/* ---- bots are not readers ---- */
{
  const human = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36';
  check('a browser counts', V.isCountableAgent(human));
  check('Googlebot does not', !V.isCountableAgent('Mozilla/5.0 (compatible; Googlebot/2.1)'));
  check('a generic crawler does not', !V.isCountableAgent('SomeCrawler/1.0'));
  check('curl does not', !V.isCountableAgent('curl/8.4.0'));
  check('a headless browser does not', !V.isCountableAgent('HeadlessChrome/120'));
  check('facebook link preview does not', !V.isCountableAgent('facebookexternalhit/1.1'));
  // No agent at all is a script. A counter that includes them measures
  // enthusiasm rather than readership.
  check('a missing user agent does not count', !V.isCountableAgent(undefined));
  check('an empty user agent does not count', !V.isCountableAgent(''));
  check('a non-string does not count', !V.isCountableAgent(42));
  check('the match is case-insensitive', !V.isCountableAgent('GOOGLEBOT/2.1'));
}

/* ---- who counts as a reader ---- */
{
  // THE BUG: the first version excluded every request with a user, so an
  // API-key caller — a headless storefront rendering the article for a real
  // visitor — was excluded. Both live shops are headless, so this counted zero
  // on exactly the installs it existed to measure.
  check('an anonymous visitor is a reader', V.isReaderRequest(null));
  check('...and so is undefined', V.isReaderRequest(undefined));
  check('an API-KEY caller is a reader (headless storefronts are)',
    V.isReaderRequest({ id: 'apikey:abc123' }));
  check('a signed-in human is NOT (an editor previewing is not a read)',
    !V.isReaderRequest({ id: 'usr_1' }));
  check('a user with no id is not a reader', !V.isReaderRequest({}));
}

/* ---- buffering ---- */
{
  V.resetPendingViews();
  V.recordView('p1'); V.recordView('p1'); V.recordView('p2');
  check('views accumulate in memory', V.pendingViewCount() === 3);
  // Nothing was written yet: that is the whole point. An increment per request
  // on lowdb is a full document rewrite per visitor.
  check('...and nothing is written until a flush', !V.__store.has('p1'));

  V.resetPendingViews();
  check('reset clears the buffer', V.pendingViewCount() === 0);
}

/* ---- rubbish in does not corrupt the buffer ---- */
{
  V.resetPendingViews();
  V.recordView(''); V.recordView(null); V.recordView(undefined); V.recordView(123);
  check('only real post ids are buffered', V.pendingViewCount() === 0);
}

/* ---- flushing adds to what is already stored ---- */
{
  V.resetPendingViews();
  V.__store.clear();
  seed('p1', 10);
  seed('p2', 0);
  V.recordView('p1'); V.recordView('p1'); V.recordView('p1');
  V.recordView('p2');

  const written = await V.flushViews();
  check('both posts were written', written === 2);
  check('the count is ADDED to the existing value', V.__store.get('p1').views === 13);
  check('a post starting at zero is counted too', V.__store.get('p2').views === 1);
  check('the buffer is empty afterwards', V.pendingViewCount() === 0);

  // A second flush with nothing buffered must not rewrite anything.
  check('an empty flush writes nothing', (await V.flushViews()) === 0);
  check('...and leaves the stored value alone', V.__store.get('p1').views === 13);
}

/* ---- a post deleted between the view and the flush ---- */
{
  V.resetPendingViews();
  V.__store.clear();
  seed('alive', 5);
  V.recordView('alive');
  V.recordView('deleted-since');

  const written = await V.flushViews();
  // Skipped, not an error: reading an article that is removed a moment later is
  // a real thing, and it must not stop the other counts being written.
  check('a missing post is skipped', written === 1);
  check('...and the surviving post is still counted', V.__store.get('alive').views === 6);
  check('...and the missing one is not retried forever', V.pendingViewCount() === 0);
}

/* ---- a failed write is retried, not discarded ---- */
{
  V.resetPendingViews();
  V.__store.clear();
  seed('p1', 100);
  V.recordView('p1'); V.recordView('p1');

  V.__fail.bump = true;
  await V.flushViews();
  // The buffer is the ONLY copy of these counts. Dropping them on a transient
  // write failure loses data that cannot be recovered by running again.
  check('a throwing write puts the whole batch back', V.pendingViewCount() === 2);
  check('...and the stored value is unchanged', V.__store.get('p1').views === 100);

  V.__fail.bump = false;
  await V.flushViews();
  check('the retry lands', V.__store.get('p1').views === 102);
  check('...and the buffer drains', V.pendingViewCount() === 0);
}

/* ---- ONE write for the whole batch, not one per post ---- */
{
  // The point of buffering. Fifty articles counted must not become fifty
  // whole-document rewrites serialized behind the storage lock.
  V.resetPendingViews();
  V.__store.clear();
  for (let i = 0; i < 50; i += 1) {
    seed(`b${i}`, 0);
    V.recordView(`b${i}`);
    V.recordView(`b${i}`);
  }
  V.__calls.bump = 0;
  const written = await V.flushViews();
  check('fifty posts are written in ONE call', V.__calls.bump === 1);
  check('...and all fifty were counted', written === 50);
  check('...with the right totals', V.__store.get('b7').views === 2);
}

/* ---- a corrupt stored value does not produce NaN ---- */
{
  V.resetPendingViews();
  V.__store.clear();
  V.__store.set('bad', { id: 'bad', views: 'lots' });
  V.recordView('bad');
  await V.flushViews();
  // A record whose views field was never a number (an import, a hand edit)
  // must restart from zero rather than turning the tile into NaN forever.
  check('a non-numeric stored count restarts at zero', V.__store.get('bad').views === 1);

  V.__store.set('nan', { id: 'nan', views: NaN });
  V.recordView('nan');
  await V.flushViews();
  check('NaN is treated as zero', V.__store.get('nan').views === 1);
}

/* ---- the buffer is bounded ---- */
{
  // Unbounded growth fed by request handlers is a memory leak waiting for an
  // unusual afternoon.
  check('there is a documented cap', V.MAX_PENDING_POSTS > 0 && V.MAX_PENDING_POSTS <= 100_000);
}

/* ---- the counter writes itself out with the scheduler OFF ---- */
{
  // SCHEDULER_DISABLED=1 is documented and supported. With it set, nothing ever
  // called flushViews, so the counts accumulated in memory and were never
  // written — the permanently-zero dashboard, back again, with no way to tell.
  V.resetPendingViews();
  V.__store.clear();
  V.__calls.bump = 0;
  seed('auto', 0);
  // Views on ONE post, not one view each on many. The threshold compared
  // pending.size — the number of DISTINCT POSTS — so a blog with four articles
  // could accumulate a hundred thousand views and never trip it.
  for (let i = 0; i < V.FLUSH_AT_PENDING - 1; i += 1) V.recordView('auto');
  check('below the threshold nothing is written on its own', V.__calls.bump === 0);

  V.recordView('auto');
  // Fire-and-forget, so give the microtask a turn.
  await new Promise((r) => setTimeout(r, 20));
  check('crossing the threshold flushes without the scheduler', V.__calls.bump >= 1);
  check('...and the real post was counted', V.__store.get('auto').views === V.FLUSH_AT_PENDING);
}

/* ---- a partial failure must not double-count on the retry ---- */
{
  // A write that throws part-way has ALREADY committed some rows. Returning
  // those to the buffer counts them twice next time.
  V.resetPendingViews();
  V.__store.clear();
  seed('x1', 0); seed('x2', 0); seed('x3', 0);
  V.recordView('x1'); V.recordView('x2'); V.recordView('x3');

  V.__fail.partialAfter = 2;      // x1 and x2 land, then it throws
  await V.flushViews();
  V.__fail.partialAfter = 0;
  check('what landed is not buffered again', V.pendingViewCount() === 1);

  await V.flushViews();
  check('x1 is counted exactly once', V.__store.get('x1').views === 1);
  check('x2 is counted exactly once', V.__store.get('x2').views === 1);
  check('x3 lands on the retry', V.__store.get('x3').views === 1);
}

/* ---- two flushes cannot run at once ---- */
{
  // Each would swap out a batch; a failure in one would put back counts the
  // other had already written.
  V.resetPendingViews();
  V.__store.clear();
  seed('c1', 0);
  V.recordView('c1');
  V.__calls.bump = 0;
  const [a, b] = await Promise.all([V.flushViews(), V.flushViews()]);
  check('a concurrent flush is a no-op, not a double count',
    V.__calls.bump === 1 && V.__store.get('c1').views === 1);
  check('...and one of the two reports zero', a === 0 || b === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
