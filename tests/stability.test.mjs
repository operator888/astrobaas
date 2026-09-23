#!/usr/bin/env node
/**
 * Contract test: STABILITY.md and the three published barrels must agree.
 *
 * STABILITY.md tells theme and plugin authors that "the public API is
 * everything exported from astrobaas/core, astrobaas/plugins and
 * astrobaas/client". That sentence is only true if the document lists what
 * those barrels actually export — and nothing was checking, so it drifted:
 * sixty-odd exports had accumulated with no row, including every commerce
 * model, the payment-provider contract and the text helpers a bundled plugin
 * already imports. An author reading the table could not tell a promise from
 * an accident, which is the one thing the document exists to answer.
 *
 * So, both directions:
 *
 *   1. every export of a barrel is either documented as public OR named in
 *      the "Exported, but not part of the promise" table — silence is not an
 *      option, because silence is how the drift happened;
 *   2. every name the document promises is really exported by the barrel it
 *      is filed under — a promise to a name that no longer exists is worse
 *      than no promise at all.
 *
 * Parsing is deliberately syntactic (the barrels are re-export lists, not
 * programs): importing them would drag in the storage layer and the whole
 * plugin registry for a question about their surface.
 *
 * Run with:  node tests/stability.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) pass++;
  else {
    fail++;
    console.error(`✗ ${name}`);
  }
}

/** The barrels, keyed by the import path an author writes. */
const BARRELS = {
  'astrobaas/core': 'src/core/index.ts',
  'astrobaas/plugins': 'src/plugins/index.ts',
  'astrobaas/client': 'src/client/index.ts',
};

/**
 * Exported names of one module.
 *
 * Comments are stripped first: this very file's barrel explains in prose why
 * `redeliver` is NOT exported, and a parser that counted words in comments
 * would read that as an export and pass a test it should fail.
 */
function exportsOf(rel) {
  const src = fs
    .readFileSync(path.join(root, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  const names = new Set();

  // export { a, b as c } / export type { … } — possibly across lines.
  for (const m of src.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) names.add(name);
    }
  }
  // export const/function/class/interface/type X
  const decl = /export\s+(?:declare\s+)?(?:async\s+)?(?:const|let|var|function|class|interface|enum|type)\s+([A-Za-z_$][\w$]*)/g;
  for (const m of src.matchAll(decl)) names.add(m[1]);

  return names;
}

/**
 * STABILITY.md's tables, read as data.
 *
 * Only the FIRST cell of a row is a list of exports; the Notes column is prose
 * and mentions names like `ctx.store` or `set:html` that are not exports at
 * all. Rows are attributed to whichever `### astrobaas/...` heading precedes
 * them, so a name documented under the wrong barrel is caught too.
 */
function readStability() {
  const lines = fs.readFileSync(path.join(root, 'STABILITY.md'), 'utf8').split('\n');
  const documented = new Map(Object.keys(BARRELS).map((k) => [k, new Set()]));
  // name -> the module it lives in, as the "Where" column gives it. A barrel
  // there means "reachable, but don't build on it"; anything else means the
  // name must not be on a barrel at all.
  const exempt = new Map();
  let barrel = null;
  let inExempt = false;

  for (const line of lines) {
    const heading = line.match(/^###\s+`(astrobaas\/[a-z]+)`/);
    if (heading) {
      barrel = heading[1];
      inExempt = false;
      continue;
    }
    if (/^##\s/.test(line)) {
      inExempt = /not part of the promise/i.test(line);
      barrel = null;
      continue;
    }
    if (!line.startsWith('|') || /^\|\s*-{2,}/.test(line)) continue;

    const first = line.split('|')[1] ?? '';
    if (/^\s*Export\s*$/.test(first)) continue; // header row
    const names = [...first.matchAll(/`([A-Za-z_$][\w$]*)`/g)].map((m) => m[1]);
    if (inExempt) {
      const where = (line.split('|')[2] ?? '').match(/`([^`]+)`/)?.[1] ?? '';
      names.forEach((n) => exempt.set(n, where));
    } else if (barrel) names.forEach((n) => documented.get(barrel).add(n));
  }
  return { documented, exempt };
}

const { documented, exempt } = readStability();

// The parser must actually find things — an empty set would make every
// assertion below vacuously true, which is the classic way a contract test
// keeps passing while it has stopped testing anything.
check('STABILITY.md yields documented exports for every barrel',
  [...documented.values()].every((s) => s.size > 0));
check('STABILITY.md names at least one deliberately-internal export', exempt.size > 0);

for (const [barrel, rel] of Object.entries(BARRELS)) {
  const actual = exportsOf(rel);
  const promised = documented.get(barrel);

  check(`${rel} has exports the parser can see`, actual.size > 0);

  // 1. Nothing exported in silence.
  const undocumented = [...actual]
    .filter((n) => !promised.has(n) && exempt.get(n) !== barrel)
    .sort();
  check(
    `every ${barrel} export is documented or declared internal` +
      (undocumented.length ? ` — missing: ${undocumented.join(', ')}` : ''),
    undocumented.length === 0,
  );

  // 2. Nothing promised that isn't there.
  const phantom = [...promised].filter((n) => !actual.has(n)).sort();
  check(
    `every name STABILITY.md files under ${barrel} is exported by it` +
      (phantom.length ? ` — absent: ${phantom.join(', ')}` : ''),
    phantom.length === 0,
  );
}

// An export cannot be promised and disowned at once: that reads as a promise
// to an author and as freedom to change it to a maintainer.
for (const [barrel, promised] of documented) {
  const both = [...promised].filter((n) => exempt.has(n)).sort();
  check(
    `no ${barrel} export is both documented and declared internal` +
      (both.length ? ` — both: ${both.join(', ')}` : ''),
    both.length === 0,
  );
}

// A name the document disowns while pointing at an internal module must not be
// on a barrel at all — otherwise the row is describing a file, not a promise,
// and an author importing it from `astrobaas/core` would be within their rights.
const everyBarrelExport = new Map();
for (const [barrel, rel] of Object.entries(BARRELS))
  for (const n of exportsOf(rel)) everyBarrelExport.set(n, barrel);
for (const [name, where] of exempt) {
  if (where in BARRELS) continue;
  const found = everyBarrelExport.get(name);
  check(
    `${name} is internal (${where}) and stays off the public barrels` +
      (found ? ` — but ${found} exports it` : ''),
    !found,
  );
}

console.log(`\nstability: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
