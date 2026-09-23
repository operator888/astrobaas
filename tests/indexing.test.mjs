#!/usr/bin/env node
/**
 * The discourage-indexing memory (src/lib/indexing.ts) and the settings guard
 * that protects it (src/lib/settings-validate.ts).
 *
 * This is the one part of C-16 that had NO coverage at all, which is how the
 * site-wide half of a "hide this site" switch can rot without anyone noticing:
 * nothing about it is visible in a rendered page unless you go looking.
 *
 * The property under test is the awkward one. The setting is read live on
 * every render, so the read CAN fail on a healthy install — and both simple
 * error policies are wrong in opposite directions (fail-open briefly indexes a
 * staging site; fail-closed briefly delists a live shop). The module answers
 * by remembering, and these assertions pin that behaviour in both directions.
 *
 * Run with:  node tests/indexing.test.mjs
 */
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cacheDir = path.join(here, '..', 'node_modules', '.cache');
await fs.mkdir(cacheDir, { recursive: true });

const entry = path.join(cacheDir, `astrobaas-idx-entry-${process.pid}.ts`);
const outFile = path.join(cacheDir, `astrobaas-idx-${process.pid}.mjs`);
const root = path.join(here, '..');
await fs.writeFile(entry, [
  `export * from ${JSON.stringify(path.join(root, 'src/lib/indexing.ts'))};`,
  `export { validateSetting, normaliseSettingValue } from ${JSON.stringify(path.join(root, 'src/lib/settings-validate.ts'))};`,
].join('\n'));
await build({
  entryPoints: [entry], bundle: true, format: 'esm', platform: 'node',
  packages: 'external', outfile: outFile, logLevel: 'silent',
});
const I = await import(pathToFileURL(outFile).href);
await fs.rm(entry, { force: true });
await fs.rm(outFile, { force: true });

let pass = 0;
let fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };

/* ---- the truthiness rule, shared with every other reader ---- */
{
  check('true and truthy values hide the site',
    I.resolveDiscourageIndexing(true) === true && I.resolveDiscourageIndexing('yes') === true);
  check('absent, false and empty leave it published',
    I.resolveDiscourageIndexing(undefined) === false
    && I.resolveDiscourageIndexing(false) === false
    && I.resolveDiscourageIndexing('') === false
    && I.resolveDiscourageIndexing(null) === false);
}

/* ---- the settings guard: the string "false" must never be storable ----
 *
 * Every reader uses `!!value`, so a stored "false" is TRUE — an operator
 * turning the toggle off through the API would hide their whole site and be
 * told it succeeded. The guard is what makes the loose read safe.
 */
{
  // What actually protects the site is the pipeline the update route runs:
  // validate, then NORMALISE, then store. So the assertion is about what can
  // end up in storage, not about which half refuses it.
  const stored = (v) => (I.validateSetting('discourage_indexing', v) === null
    ? I.normaliseSettingValue('discourage_indexing', v)
    : Symbol('refused'));
  check('the string "false" can never be STORED as a truthy value',
    stored('false') === false && I.resolveDiscourageIndexing(stored('false')) === false);
  check('...nor "0"', stored('0') === false && I.resolveDiscourageIndexing(stored('0')) === false);
  check('the string "true" stores as a real boolean, not a string',
    stored('true') === true && typeof stored('true') === 'boolean');
  check('a value that is neither is refused outright',
    typeof I.validateSetting('discourage_indexing', 'nope') === 'string'
    && typeof I.validateSetting('discourage_indexing', 42) === 'string');
  check('real booleans are accepted',
    I.validateSetting('discourage_indexing', true) === null
    && I.validateSetting('discourage_indexing', false) === null);
  check('clearing is accepted (it means "use the default")',
    I.validateSetting('discourage_indexing', '') === null
    && I.validateSetting('discourage_indexing', null) === null);
  check('the accepted spellings normalise to real booleans',
    I.normaliseSettingValue('discourage_indexing', '1') === true
    && I.normaliseSettingValue('discourage_indexing', '0') === false);
  check('an unrelated key is untouched by this guard',
    I.validateSetting('site_title', 'false') === null);
}

/* ---- the memory: a failed read must not change the answer ----
 *
 * This is the reason the module exists, so it is driven for real: the reader
 * is injectable, and these cases exercise the FAILURE branch in both
 * directions. An earlier version of this block asserted nothing and could not
 * have failed — which is exactly the shape it is here to catch.
 */
{
  const ok = (v) => async () => v;
  const boom = async () => { throw new Error('database unreachable'); };

  I._resetDiscourageMemory();
  check('a cold process that has never read anything assumes PUBLISHED',
    I.lastKnownDiscourageIndexing().value === false
    && I.lastKnownDiscourageIndexing().everRead === false);

  // Cold + failing read: still published. A process that never learned the
  // answer must not invent a reason to delist a live site.
  check('a cold process whose FIRST read fails stays published',
    (await I.discourageIndexing(boom)) === false
    && I.lastKnownDiscourageIndexing().everRead === false);

  // A staging site that read `true` keeps hiding through a blip.
  I._resetDiscourageMemory();
  check('a hidden site reads hidden', (await I.discourageIndexing(ok(true))) === true);
  check('...and STAYS hidden when the next read throws',
    (await I.discourageIndexing(boom)) === true);
  check('...and is published again once a read succeeds with false',
    (await I.discourageIndexing(ok(false))) === false);

  // A live shop that read `false` is never delisted by a blip — the direction
  // that costs weeks of search traffic to recover from.
  check('a published site STAYS published when a read throws',
    (await I.discourageIndexing(boom)) === false);
  check('the memory records that a read has succeeded',
    I.lastKnownDiscourageIndexing().everRead === true);

  // Set the memory to TRUE first, so the reset has something to undo — with a
  // remembered `false` the value half of this assertion could not fail.
  await I.discourageIndexing(ok(true));
  I._resetDiscourageMemory();
  check('reset returns the module to its cold state',
    I.lastKnownDiscourageIndexing().everRead === false
    && I.lastKnownDiscourageIndexing().value === false);
}


// ─────────────────────────── the staging override (C-89)
{
  const on = { STAGING: '1' };
  check('STAGING=1 forces noindex even when the setting says otherwise',
    I.resolveDiscourageIndexing(false, on) === true);
  check('without it the stored setting decides',
    I.resolveDiscourageIndexing(false, {}) === false && I.resolveDiscourageIndexing(true, {}) === true);

  // ONE-WAY on purpose. A variable that could un-hide a site the operator hid
  // would be a way to publish a private site by editing a deploy config.
  check('nothing in the environment can force indexing ON',
    I.resolveDiscourageIndexing(true, { STAGING: '0' }) === true);

  check('isStagingEnv accepts every spelling envFlagOn does',
    ['1', 'true', 'on', 'yes', 'YES'].every((v) => I.isStagingEnv({ STAGING: v })));
  check('and rejects the rest',
    !I.isStagingEnv({}) && !I.isStagingEnv({ STAGING: '0' }) && !I.isStagingEnv({ STAGING: 'false' })
    && !I.isStagingEnv({ STAGING: '' }));
  check('the alternate variable name works too',
    I.isStagingEnv({ ASTROBAAS_STAGING: '1' }));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
