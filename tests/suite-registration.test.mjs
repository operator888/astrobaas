#!/usr/bin/env node
/**
 * Every test file is actually run by a script in package.json.
 *
 * `test:unit` is an explicit `&&` chain, not a glob — deliberately, because the
 * order matters and a glob would swallow a file that crashes on import. The
 * cost of that choice is this failure mode: a test file can be written,
 * committed, pass locally when run by hand, and never run in CI again. It reads
 * as covered on the scoreboard and catches nothing.
 *
 * That is the same shape as a test whose assertion cannot fail, which this
 * codebase has now hit several times. This is the cheap structural guard.
 *
 * Run with:  node tests/suite-registration.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const scripts = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts ?? {};
const commands = Object.values(scripts).join(' && ');

const files = fs.readdirSync(path.join(root, 'tests'))
  .filter((f) => f.endsWith('.test.mjs'))
  .sort();

let pass = 0;
let fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };

check('there are test files to check', files.length > 50);

const orphans = files.filter((f) => !commands.includes(`tests/${f}`));
check(
  orphans.length === 0
    ? 'every test file is wired into an npm script'
    : `every test file is wired into an npm script (never run: ${orphans.join(', ')})`,
  orphans.length === 0,
);

// The guard has to be able to see a miss, or it is the very thing it guards
// against. A name that is definitely absent must be reported as an orphan.
const wouldCatch = !commands.includes('tests/definitely-not-registered.test.mjs');
check('the check can actually detect an unregistered file', wouldCatch);

/**
 * Script names that appear more than once in package.json's `scripts`.
 *
 * JSON.parse cannot report this: it keeps the LAST copy of a key and discards
 * the rest without a word. That is exactly how main lost tests — merges
 * resolved a conflict on the one-line `test:unit` by keeping BOTH lines, so the
 * file carried two `test:unit` keys and only the last one ran (#80's merge lost
 * four checkout tests that way; #83 merged them back and its own merge of main
 * re-added a second key). The check above reads the parsed file, so it could
 * never see it. This one reads the text.
 *
 * A small tokenizer rather than a line regex, so it does not depend on how the
 * file happens to be indented.
 */
function duplicateScriptKeys(raw) {
  const start = raw.indexOf('"scripts"');
  if (start < 0) return [];
  const counts = new Map();
  let depth = 0;
  let expectKey = true;
  for (let i = raw.indexOf('{', start); i >= 0 && i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '"') {
      let j = i + 1;
      let s = '';
      while (j < raw.length && raw[j] !== '"') {
        if (raw[j] === '\\') { s += raw[j + 1]; j += 2; } else { s += raw[j++]; }
      }
      if (depth === 1 && expectKey) counts.set(s, (counts.get(s) ?? 0) + 1);
      i = j;
    } else if (ch === '{') { depth += 1; expectKey = true; }
    else if (ch === '}') { depth -= 1; if (depth === 0) break; }
    else if (ch === ':') expectKey = false;
    else if (ch === ',') expectKey = true;
  }
  return [...counts].filter(([, n]) => n > 1).map(([k]) => k);
}

const dupes = duplicateScriptKeys(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
check(
  dupes.length === 0
    ? 'no npm script is defined twice'
    : `no npm script is defined twice (duplicated, only the LAST copy runs: ${dupes.join(', ')})`,
  dupes.length === 0,
);

// And this guard must be able to fail too.
const planted = '{ "name": "x", "scripts": { "a": "1", "test:unit": "one", "b": "{\\"not\\": \\"a key\\"}", "test:unit": "two" } }';
check('the duplicate check can actually detect a duplicated key', duplicateScriptKeys(planted).join() === 'test:unit');
check('the duplicate check does not flag distinct keys', duplicateScriptKeys('{ "scripts": { "a": "1", "b": "2" } }').length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
