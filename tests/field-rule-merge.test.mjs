#!/usr/bin/env node
/**
 * What the Content types builder saves for a field it shows.
 *
 * The builder rebuilt each rule from its few controls, so opening a type and
 * pressing Save dropped everything else: `max: 400` (the textarea, and the
 * length limit), `min`/`max`/`int` on numbers, a list's `of: 'number'`, and a
 * group's `layouts` (which made the save fail outright). Themes and plugins
 * define all of these. lib/field-rule-merge.ts keeps them; the builder calls it
 * per field and per sub-field. tests/e2e/cms.spec.ts drives the real screen.
 *
 * Run with:  node tests/field-rule-merge.test.mjs
 */
import { loadTs } from './lib/load.mjs';

const { mergeFieldRule } = await loadTs('src/lib/field-rule-merge.ts');
const B = await loadTs('src/core/field-rule-build.ts');

let passed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed += 1; } catch (err) { failures.push(`${name}: ${err.message}`); }
}
function eq(a, b, what = '') {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
/** What the server keeps of a rule (the same rebuild the save goes through). */
const server = (rule) => B.buildFieldRule(rule, 'f', (m) => { throw new Error(m); });

check('an untouched text field keeps its length limits', () => {
  // `max: 400` is what makes the entries screen and the public form offer a
  // textarea. The builder has no length control, so it used to vanish.
  const stored = { type: 'string', min: 2, max: 400 };
  eq(mergeFieldRule(stored, { type: 'string' }), { type: 'string', min: 2, max: 400 });
});

check('an untouched number keeps min, max and whole-number', () => {
  const stored = { type: 'number', int: true, min: 1, max: 12, optional: true };
  eq(mergeFieldRule(stored, { type: 'number', optional: true }), stored);
});

check('the controls still win: ticking "required" removes optional', () => {
  const out = mergeFieldRule({ type: 'number', int: true, optional: true }, { type: 'number' });
  eq(out, { type: 'number', int: true });
});

check('...and unticking it adds optional, keeping the rest', () => {
  eq(mergeFieldRule({ type: 'string', max: 80 }, { type: 'string', optional: true }), { type: 'string', max: 80, optional: true });
});

check('edited enum choices replace the stored ones', () => {
  eq(mergeFieldRule({ type: 'enum', values: ['a', 'b'] }, { type: 'enum', values: ['a', 'b', 'c'] }).values, ['a', 'b', 'c']);
});

check('an edited link target replaces the stored one', () => {
  eq(mergeFieldRule({ type: 'ref', to: 'venue' }, { type: 'ref', to: 'place' }).to, 'place');
});

check("a list keeps of: 'number' (the builder used to force 'string')", () => {
  eq(mergeFieldRule({ type: 'array', of: 'number', max: 5 }, { type: 'array' }), { type: 'array', of: 'number', max: 5 });
});

check('a new list says it holds text', () => {
  eq(mergeFieldRule(undefined, { type: 'array' }), { type: 'array', of: 'string' });
});

check('changing the kind starts clean: no bounds carried from the old kind', () => {
  // `max` on text is characters and on a number is a value; carrying it
  // across would be a guess.
  eq(mergeFieldRule({ type: 'string', max: 400 }, { type: 'number' }), { type: 'number' });
});

check('a group with layouts keeps them and sends no fields', () => {
  const layouts = [{ name: 'quote', label: 'Quote', fields: [{ name: 'text', rule: { type: 'string' } }] }];
  const out = mergeFieldRule({ type: 'repeater', layouts, max: 6 }, { type: 'repeater', fields: [] });
  eq(out, { type: 'repeater', layouts, max: 6 });
  server(out); // accepted, where `fields: []` was refused
});

check('a plain group takes its fields from the controls and keeps its bounds', () => {
  const edited = { type: 'repeater', fields: [{ name: 'day', rule: { type: 'string', max: 20 } }] };
  eq(mergeFieldRule({ type: 'repeater', fields: [{ name: 'old', rule: { type: 'string' } }], min: 1, max: 7 }, edited),
    { type: 'repeater', fields: edited.fields, min: 1, max: 7 });
});

check('a brand-new field is exactly what the controls say', () => {
  eq(mergeFieldRule(undefined, { type: 'string', optional: true }), { type: 'string', optional: true });
});

check('every merged rule is one the server accepts unchanged', () => {
  // The round trip that matters: what the builder sends is what gets stored.
  for (const [stored, edited] of [
    [{ type: 'string', min: 2, max: 400 }, { type: 'string' }],
    [{ type: 'number', int: true, min: 0, max: 99, optional: true }, { type: 'number', optional: true }],
    [{ type: 'array', of: 'number', max: 5 }, { type: 'array' }],
  ]) {
    const out = mergeFieldRule(stored, edited);
    // Same keys and values; the server rebuilds in its own key order.
    const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
    eq(sorted(server(out)), sorted(out), JSON.stringify(stored));
  }
});

if (failures.length) {
  console.error(`\n✗ field-rule-merge: ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error(`  · ${f}`);
  process.exit(1);
}
console.log(`✓ field-rule-merge: ${passed} passed`);
