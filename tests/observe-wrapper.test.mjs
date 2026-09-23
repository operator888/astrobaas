#!/usr/bin/env node
/**
 * The outermost middleware wrapper (`observe` in src/middleware.ts) is what
 * feeds both the graceful drain and the latency histogram.
 *
 * The whole middleware cannot be loaded in a unit test — it imports Astro's
 * virtual modules and starts the scheduler at import. So this takes the
 * wrapper's OWN source out of the file, compiles just that, and runs it with
 * every collaborator replaced by a recorder. What runs is the code that ships,
 * not a copy of it.
 *
 * What it pins:
 *  - the request is counted in flight before the handler runs, and released
 *    exactly once after it — including when the handler THROWS (a missed
 *    decrement makes every later shutdown wait out its full timeout);
 *  - the error still propagates (the wrapper must not swallow it);
 *  - the duration reaches recordRequest, for the histogram.
 *
 * Run with:  node tests/observe-wrapper.test.mjs
 */
import { transform } from 'esbuild';
import { readRepo } from './lib/load.mjs';

let pass = 0;
let fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };

const src = await readRepo('src/middleware.ts');
const start = src.indexOf('const observe = defineMiddleware(');
const end = start === -1 ? -1 : src.indexOf('\n});', start);
check('the wrapper is where the test expects it', start !== -1 && end !== -1);
const snippet = src.slice(start, end + '\n});'.length);

check('the wrapper takes its counter from the shutdown module',
  /import \{ trackRequest \} from '\.\/lib\/shutdown';/.test(src));

const { code } = await transform(snippet, { loader: 'ts', format: 'esm' });

function instantiate() {
  const log = [];
  const deps = {
    defineMiddleware: (fn) => fn,
    beginProfile: () => log.push('beginProfile'),
    endProfile: () => null,
    serverTimingHeader: () => '',
    trackRequest: () => {
      log.push('track');
      return () => log.push('finished');
    },
    recordRequest: (status, ms) => log.push(['record', status, ms]),
    logRequest: () => log.push('log'),
  };
  // eslint-disable-next-line no-new-func
  const make = new Function(...Object.keys(deps), `${code}\nreturn observe;`);
  return { observe: make(...Object.values(deps)), log };
}

const context = { request: new Request('http://x.test/api/orders', { method: 'POST' }), locals: { ip: '203.0.113.9' } };

/* ---- a normal request ---- */
{
  const { observe, log } = instantiate();
  const res = await observe(context, async () => {
    log.push('handler');
    await new Promise((r) => setTimeout(r, 25));
    return new Response('{}', { status: 201 });
  });
  const names = log.map((e) => (Array.isArray(e) ? e[0] : e));
  check('ok: the response is returned unchanged', res.status === 201);
  check('ok: counted in flight BEFORE the handler runs', names.indexOf('track') !== -1 && names.indexOf('track') < names.indexOf('handler'));
  check('ok: released exactly once', names.filter((x) => x === 'finished').length === 1);
  check('ok: released after the handler, before the bookkeeping',
    names.indexOf('finished') > names.indexOf('handler') && names.indexOf('finished') < names.indexOf('record'));
  const rec = log.find((e) => Array.isArray(e) && e[0] === 'record');
  check('ok: recordRequest gets the status AND the duration', rec?.[1] === 201 && typeof rec?.[2] === 'number' && rec[2] >= 20);
}

/* ---- a handler that throws ---- */
{
  const { observe, log } = instantiate();
  const boom = new Error('handler exploded');
  let caught = null;
  try {
    await observe(context, async () => { log.push('handler'); throw boom; });
  } catch (err) {
    caught = err;
  }
  const names = log.map((e) => (Array.isArray(e) ? e[0] : e));
  check('throw: the error still propagates, unchanged', caught === boom);
  check('throw: THE POINT — the in-flight count is still released', names.filter((x) => x === 'finished').length === 1);
  check('throw: nothing is recorded for a response that does not exist', !names.includes('record'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
