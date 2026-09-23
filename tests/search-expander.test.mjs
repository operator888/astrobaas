#!/usr/bin/env node
/**
 * Search synonyms (src/lib/search/expander.ts) — the core implementation behind
 * the `TermExpander` seam.
 *
 * The seam has existed since the scorer was written and nothing in core filled
 * it: `SEARCH_EXPAND` had exactly one consumer, product search, so a shop's
 * synonyms worked in the catalogue and not in the blog.
 *
 * The cases below are the ones an operator actually hits: a line that reads
 * both ways, a line that must not, a comment, a typo, and Greek.
 *
 * Run with:  node tests/search-expander.test.mjs
 */
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const cacheDir = path.join(root, 'node_modules', '.cache');
await fs.mkdir(cacheDir, { recursive: true });
async function load(rel, tag) {
  const out = path.join(cacheDir, `astrobaas-${tag}-${process.pid}.mjs`);
  await build({
    entryPoints: [path.join(root, rel)],
    bundle: true, format: 'esm', platform: 'node', packages: 'external',
    outfile: out, logLevel: 'silent',
  });
  return import(pathToFileURL(out).href);
}
const E = await load('src/lib/search/expander.ts', 'expander');
const R = await load('src/lib/search/rank.ts', 'rank-for-expander');

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
const sorted = (fn, t) => [...(fn(t) ?? [])].sort();

// ───────────────────────────────────────────────────────────── parsing

check('a comma line is BIDIRECTIONAL — every term finds every other', () => {
  // An operator writing a synonym line is saying these words mean the same
  // thing, not declaring a direction. A one-way table is the shape where
  // somebody tests the word they typed first and never notices the other half.
  const x = E.expanderFromSetting('frame, mount, rim');
  eq(sorted(x, 'frame'), ['mount', 'rim']);
  eq(sorted(x, 'mount'), ['frame', 'rim']);
  eq(sorted(x, 'rim'), ['frame', 'mount']);
});

check('the `=` form reads the same as the comma form', () => {
  eq(sorted(E.expanderFromSetting('frame = mount, rim'), 'mount'), ['frame', 'rim']);
});

check('`=>` is ONE-WAY, for when direction is genuinely meant', () => {
  // `iphone => phone` must not make every phone an iPhone.
  const x = E.expanderFromSetting('iphone => phone');
  eq(sorted(x, 'iphone'), ['phone']);
  eq(sorted(x, 'phone'), []);
});

check('comments and blank lines are skipped', () => {
  const x = E.expanderFromSetting('# what customers call things\n\nframe, mount\n  \n# done');
  eq(sorted(x, 'frame'), ['mount']);
});

check('a trailing comment on a rule line still leaves the rule', () => {
  eq(sorted(E.expanderFromSetting('frame, mount  # asked for weekly'), 'frame'), ['mount']);
});

check('an unreadable line is DROPPED, never thrown', () => {
  // This is a free-text settings field. One bad line must not take search down.
  const x = E.expanderFromSetting('frame, mount\nnonsense-with-no-comma\n=> orphan\nalso, fine');
  eq(sorted(x, 'frame'), ['mount']);
  eq(sorted(x, 'also'), ['fine']);
});

check('accents and capitals do not make a different term', () => {
  // A Greek shop types «Σκελετός» in the table and «σκελετος» in the search box.
  // foldForSearch folds case and accents; it does NOT transliterate — Greeklish
  // is the paid module's job, and it needs an index of the shop's own words.
  const x = E.expanderFromSetting('Σκελετός, μοντούρα');
  eq(sorted(x, 'σκελετος'), ['μοντουρα']);
  eq(sorted(x, 'ΣΚΕΛΕΤΟΣ'), ['μοντουρα']);
  // σκελετοσ, not σκελετος: the fold normalises the final sigma ς to σ, which
  // is what makes «σκελετός» and «σκελετoς» one term.
  eq(sorted(x, 'Μοντούρα'), ['σκελετοσ']);
});

check('a line with one distinct term is NOT a rule', () => {
  // `frame, frame, FRAME` folds to a single term. A rule that expands a word to
  // itself would make rankBy do the expansion walk for nothing on every query.
  eq(E.expanderFromSetting('frame, frame, FRAME'), null);
});

check('a term never appears in its own expansion', () => {
  const x = E.expanderFromSetting('frame, mount, FRAME');
  eq(sorted(x, 'frame'), ['mount']);
});

check('duplicates across rules merge rather than repeating', () => {
  const x = E.expanderFromSetting('frame, mount\nframe, mount\nframe, rim');
  eq(sorted(x, 'frame'), ['mount', 'rim']);
});

// ─────────────────────────────────────────────────────────── the seam

check('an empty table produces NULL, not an empty expander', () => {
  // rankBy then skips the whole expansion path rather than calling a function
  // that always returns nothing, per candidate, per term.
  eq(E.expanderFromSetting(''), null);
  eq(E.expanderFromSetting(null), null);
  eq(E.expanderFromSetting('# only a comment'), null);
  eq(E.expanderFromSetting(42), null);
});

check('an unknown term expands to nothing', () => {
  eq(sorted(E.expanderFromSetting('frame, mount'), 'sunglasses'), []);
});

check('END TO END: the scorer finds a post through a synonym', () => {
  // The whole point. Without the expander this query scores zero.
  const posts = [{ id: 'a', title: 'Choosing a mount', body: 'about mounts' }];
  const fields = (p) => [{ text: p.title, weight: 6 }, { text: p.body, weight: 1 }];

  eq(R.rankBy(posts, 'frame', fields).length, 0, 'without the expander');
  const withSyn = R.rankBy(posts, 'frame', fields, { expand: E.expanderFromSetting('frame, mount') });
  eq(withSyn.length, 1, 'with it');
});

check('a synonym match ranks BELOW a literal one', () => {
  // A match reached through a guess must never outrank what the shopper typed.
  const posts = [
    { id: 'syn', title: 'A mount for every face', body: '' },
    { id: 'lit', title: 'A frame for every face', body: '' },
  ];
  const fields = (p) => [{ text: p.title, weight: 6 }, { text: p.body, weight: 1 }];
  const out = R.rankBy(posts, 'frame', fields, { expand: E.expanderFromSetting('frame, mount') });
  eq(out.map((r) => r.item.id), ['lit', 'syn']);
});

// ────────────────────────────────────────────────────────── validation

check('an ordinary table validates', () => {
  eq(E.validateSynonyms('frame, mount\niphone => phone\n# note'), null);
  eq(E.validateSynonyms(''), null);
  eq(E.validateSynonyms(null), null);
});

check('a dictionary-length list is refused, and the message says why', () => {
  const msg = E.validateSynonyms(Array.from({ length: E.MAX_SYNONYM_LINES + 5 }, (_, i) => `a${i}, b${i}`).join('\n'));
  if (!msg) throw new Error('accepted a dictionary');
  if (!/index/.test(msg)) throw new Error(`unhelpful: ${msg}`);
});

check('pasted HTML is refused', () => {
  if (!E.validateSynonyms('<!doctype html><html>')) throw new Error('accepted HTML');
});

check('a non-string is refused', () => {
  if (!E.validateSynonyms(42)) throw new Error('accepted a number');
});

check('COMMENTS do not count against the line limit', () => {
  // The parser sliced the RAW array while the validator counted rule lines, so
  // a well-commented table the API had just accepted lost its tail here — the
  // operator sees every rule saved in the field and some never reach a search.
  const commented = [];
  for (let i = 0; i < 40; i += 1) commented.push(`# rule ${i}`, '', `a${i}, b${i}`);
  const rules = E.parseSynonyms(commented.join('\n'));
  eq(rules.length, 40, 'all 40 rules survive 80 lines of noise');
  eq(E.validateSynonyms(commented.join('\n')), null, 'and the validator agrees');
});

check('the line limit is still enforced, counted the same way', () => {
  const many = Array.from({ length: E.MAX_SYNONYM_LINES + 20 }, (_, i) => `a${i}, b${i}`).join('\n');
  eq(E.parseSynonyms(many).length, E.MAX_SYNONYM_LINES);
  if (!E.validateSynonyms(many)) throw new Error('the validator let it through');
});

check('a term with more alternatives than search KEEPS is refused at save time', () => {
  // rankBy keeps MAX_VARIANTS_PER_TERM per term — a guard against a paid
  // module returning a dictionary, and it stays. But the operator's own table
  // must not lose rules silently, so the excess is reported when they save.
  const wide = 'frame, ' + Array.from({ length: 20 }, (_, i) => `alt${i}`).join(', ');
  const msg = E.validateSynonyms(wide);
  if (!msg) throw new Error('accepted a table search would truncate');
  if (!/frame/.test(msg)) throw new Error(`does not name the term: ${msg}`);
});

check('alternatives accumulated ACROSS lines are counted too', () => {
  // The per-line cap does not bound this: rules merge, so fifteen two-term
  // lines sharing a word give that word fifteen alternatives.
  const spread = Array.from({ length: 15 }, (_, i) => `frame, alt${i}`).join('\n');
  if (!E.validateSynonyms(spread)) throw new Error('missed the merged total');
});

check('a table search can serve completely is accepted', () => {
  eq(E.validateSynonyms('frame, ' + Array.from({ length: 11 }, (_, i) => `alt${i}`).join(', ')), null);
});

check('everything the validator accepts, the parser can read', () => {
  // A value accepted by the API and then dropped by the parser would show the
  // operator a saved rule that never reaches a search.
  for (const table of ['frame, mount', 'a => b', 'a = b, c', '# c\na, b']) {
    eq(E.validateSynonyms(table), null, table);
    if (E.parseSynonyms(table).length === 0) throw new Error(`parser dropped an accepted table: ${table}`);
  }
});

if (failures.length) {
  console.error(`\n✗ search-expander: ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error(`  · ${f}`);
  process.exit(1);
}
console.log(`✓ search-expander: ${passed} passed`);
