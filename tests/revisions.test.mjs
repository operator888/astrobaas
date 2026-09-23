#!/usr/bin/env node
/**
 * Revision retention + dedupe logic (src/lib/revisions.ts).
 *
 * The live capture/prune/restore behaviour is covered end-to-end by the smoke
 * suite against all three drivers; this pins the pure decisions that decide
 * WHETHER a revision gets written and how many are kept — the parts that, if
 * wrong, either lose history or grow the store without bound.
 *
 * Run with:  node tests/revisions.test.mjs
 */
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cacheDir = path.join(here, '..', 'node_modules', '.cache');
await fs.mkdir(cacheDir, { recursive: true });

const tmp = path.join(cacheDir, `astrobaas-revisions-${process.pid}.mjs`);
await build({
  entryPoints: [path.join(here, '..', 'src/lib/revisions.ts')],
  bundle: true, format: 'esm', platform: 'node', packages: 'external',
  outfile: tmp, logLevel: 'silent',
});
const { revisionKeep, revisionsEnabled, sameContent } = await import(pathToFileURL(tmp).href);
await fs.rm(tmp, { force: true });

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) pass++;
  else {
    fail++;
    console.error(`✗ ${name}`);
  }
}

// ---- retention cap ----
{
  check('defaults to 20', revisionKeep({}) === 20);
  check('honours REVISIONS_KEEP', revisionKeep({ REVISIONS_KEEP: '5' }) === 5);
  check('floors fractional values', revisionKeep({ REVISIONS_KEEP: '7.9' }) === 7);
  check('rejects 0 / negative (would delete all history)', revisionKeep({ REVISIONS_KEEP: '0' }) === 20 && revisionKeep({ REVISIONS_KEEP: '-3' }) === 20);
  check('rejects non-numeric', revisionKeep({ REVISIONS_KEEP: 'lots' }) === 20 && revisionKeep({ REVISIONS_KEEP: '' }) === 20);
  check('caps at 500 (unbounded growth guard)', revisionKeep({ REVISIONS_KEEP: '100000' }) === 500);
}

// ---- kill switch ----
{
  check('enabled by default', revisionsEnabled({}) === true);
  check('REVISIONS_DISABLED=1 turns it off', revisionsEnabled({ REVISIONS_DISABLED: '1' }) === false);
  check('any other value stays enabled', revisionsEnabled({ REVISIONS_DISABLED: '0' }) === true && revisionsEnabled({ REVISIONS_DISABLED: 'false' }) === true);
}

// ---- dedupe: what counts as "no change" ----
{
  const base = { title: 'T', content: '<p>c</p>', excerpt: 'e' };
  check('identical snapshots match', sameContent(base, { ...base }));
  check('a title change is a change', !sameContent(base, { ...base, title: 'T2' }));
  check('a content change is a change', !sameContent(base, { ...base, content: '<p>d</p>' }));
  check('an excerpt change is a change', !sameContent(base, { ...base, excerpt: 'e2' }));
  // Missing vs empty excerpt must not look like an edit, or every autosave on a
  // post with no excerpt would write a new revision forever.
  check('undefined and empty excerpt are equivalent', sameContent({ title: 'T', content: 'c' }, { title: 'T', content: 'c', excerpt: '' }));
  check('whitespace IS a change (never silently discard an edit)', !sameContent(base, { ...base, content: '<p>c</p> ' }));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
