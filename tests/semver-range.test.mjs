#!/usr/bin/env node
/**
 * The semver subset behind plugin dependencies.
 *
 * This is the piece everything else rests on: if `satisfies()` is wrong, an
 * optometry pack either activates against an incompatible commerce plugin (and
 * breaks at runtime in someone's shop) or refuses to activate against a
 * perfectly good one (and looks broken). Both are silent-ish and both are
 * expensive, so this file is deliberately exhaustive about the boundaries.
 *
 * Written BEFORE the dependency resolver so the resolver can be built on a
 * matcher that is already known-good, rather than debugging both at once.
 *
 * Run with:  node tests/semver-range.test.mjs
 */
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const cacheDir = path.join(root, 'node_modules', '.cache');
await fs.mkdir(cacheDir, { recursive: true });

const out = path.join(cacheDir, `astrobaas-semver-${process.pid}.mjs`);
await build({
  entryPoints: [path.join(root, 'src/core/semver-range.ts')],
  bundle: true, format: 'esm', platform: 'node', packages: 'external',
  outfile: out, logLevel: 'silent',
});
const { satisfies, isValidRange, parseVersion, compareVersions } = await import(pathToFileURL(out).href);
await fs.rm(out, { force: true });

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) pass++;
  else { fail++; console.error(`✗ ${name}`); }
}
/** Assert both directions at once — a matcher that says yes to everything passes half a suite. */
function match(version, range, expected) {
  const got = satisfies(version, range);
  check(`${version} ${expected ? 'satisfies' : 'does NOT satisfy'} ${range}`, got === expected);
}

/* ---------------- parsing ---------------- */
{
  check('a plain version parses', parseVersion('1.2.3')?.major === 1);
  check('a pre-release parses', parseVersion('2.0.0-beta.1')?.prerelease.length === 2);
  check('build metadata is ignored', parseVersion('1.2.3+build.5')?.patch === 3);
  check('surrounding whitespace is tolerated', parseVersion('  1.2.3 ')?.minor === 2);
  for (const junk of ['1.2', 'v1.2.3', '1.2.3.4', 'abc', '', null, undefined, '1.2.-3']) {
    check(`${JSON.stringify(junk)} does not parse`, parseVersion(junk) === null);
  }
  // Numeric pre-release identifiers must compare numerically, not as strings —
  // otherwise "10" sorts before "9".
  check('numeric pre-release ids compare numerically',
    compareVersions(parseVersion('1.0.0-alpha.10'), parseVersion('1.0.0-alpha.9')) > 0);
  check('a release outranks its own pre-release',
    compareVersions(parseVersion('1.0.0'), parseVersion('1.0.0-beta')) > 0);
  check('a longer pre-release outranks its prefix',
    compareVersions(parseVersion('1.0.0-alpha.1'), parseVersion('1.0.0-alpha')) > 0);
  check('numeric ids rank below alphanumeric ones',
    compareVersions(parseVersion('1.0.0-1'), parseVersion('1.0.0-alpha')) < 0);
  check('equal versions compare equal',
    compareVersions(parseVersion('1.2.3'), parseVersion('1.2.3')) === 0);
}

/* ---------------- caret: the one people actually use ---------------- */
{
  match('1.2.3', '^1.2.3', true);
  match('1.2.4', '^1.2.3', true);
  match('1.3.0', '^1.2.3', true);
  match('1.99.99', '^1.2.3', true);
  match('2.0.0', '^1.2.3', false);   // major bump breaks
  match('1.2.2', '^1.2.3', false);   // below the floor
  match('0.9.9', '^1.2.3', false);

  // 0.x is where a naive implementation goes wrong: for 0.x, MINOR is breaking.
  match('0.2.3', '^0.2.3', true);
  match('0.2.9', '^0.2.3', true);
  match('0.3.0', '^0.2.3', false);
  match('1.0.0', '^0.2.3', false);
  // ...and for 0.0.x, PATCH is breaking.
  match('0.0.3', '^0.0.3', true);
  match('0.0.4', '^0.0.3', false);
}

/* ---------------- tilde, comparators, exact, any ---------------- */
{
  match('1.2.3', '~1.2.3', true);
  match('1.2.9', '~1.2.3', true);
  match('1.3.0', '~1.2.3', false);   // minor bump is outside ~
  match('1.2.2', '~1.2.3', false);

  match('1.2.3', '1.2.3', true);
  match('1.2.4', '1.2.3', false);
  match('1.2.3', '=1.2.3', true);

  match('2.0.0', '>=2.0.0', true);
  match('3.5.1', '>=2.0.0', true);
  match('1.9.9', '>=2.0.0', false);
  match('2.0.1', '>2.0.0', true);
  match('2.0.0', '>2.0.0', false);
  match('1.0.0', '<2.0.0', true);
  match('2.0.0', '<2.0.0', false);
  match('2.0.0', '<=2.0.0', true);

  match('1.2.3', '*', true);
  match('99.0.0', '*', true);
  match('1.2.3', 'any', true);
  // A space after the operator is normal in hand-written manifests.
  match('2.1.0', '>= 2.0.0', true);
}

/* ---------------- pre-releases must not sneak in ---------------- */
{
  // THE rule worth having: `^2.0.0` accepting `2.1.0-alpha.1` would let a
  // dependent activate against an unfinished build in someone's live shop.
  match('2.1.0-alpha.1', '^2.0.0', false);
  match('2.0.0-beta.1', '^2.0.0', false);
  match('2.0.0-beta.1', '>=1.0.0', false);
  match('1.0.0-alpha', '*', false);
  // ...unless the range names a pre-release at the same tuple, which is how you
  // deliberately depend on one.
  match('2.0.0-beta.2', '^2.0.0-beta.1', true);
  match('2.0.0-beta.1', '^2.0.0-beta.1', true);
  match('2.0.0-alpha.1', '^2.0.0-beta.1', false);  // alpha < beta
  match('2.1.0-beta.1', '^2.0.0-beta.1', false);   // different tuple
  // A release still satisfies a pre-release range if it is at or above.
  match('2.0.0', '^2.0.0-beta.1', true);
}

/* ---------------- unparseable input fails closed and is REPORTED ---------------- */
{
  check('a valid range validates', isValidRange('^1.0.0') && isValidRange('*') && isValidRange('>=2.1.0'));
  for (const bad of ['1.x', '1.2.3 || 2.0.0', '>=1.0.0 <2.0.0', 'latest', '~>1.2', '', 'v1.2.3', null]) {
    check(`${JSON.stringify(bad)} is reported as an invalid range`, isValidRange(bad) === false);
  }
  // Unsupported ranges must be caught by the VALIDATOR (isValidRange), not
  // silently return false forever from satisfies() — an author whose `1.x`
  // never matched would have no idea why.
  check('an unsupported range does not silently match', satisfies('1.5.0', '1.x') === false);
  check('junk versions never satisfy anything', satisfies('not-a-version', '*') === false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
