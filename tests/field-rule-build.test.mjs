#!/usr/bin/env node
/**
 * The field-rule builder — src/core/field-rule-build.ts.
 *
 * A content type arrives two ways: an operator builds one at
 * /admin/content-types, or a plugin declares one in its manifest. Those doors
 * were two pieces of code and they had already drifted:
 *
 *   · the manifest's own field-type list lacked `ref` and `media`, so a plugin
 *     could not declare the two kinds that make a collection real;
 *   · the manifest PROJECTOR cast rather than rebuilt, so everything on a
 *     rule except its `type` reached validate() unexamined.
 *
 * So this file asserts the builder, and then asserts the two doors AGREE.
 *
 * Run with:  node tests/field-rule-build.test.mjs
 */
import { loadTs } from './lib/load.mjs';

const B = await loadTs('src/core/field-rule-build.ts');
const C = await loadTs('src/core/content-types.ts');
const M = await loadTs('src/core/manifest.ts');

const NUL = String.fromCharCode(0);
const BEL = String.fromCharCode(7);
const DEL = String.fromCharCode(127);

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
const build = (raw) => {
  const errs = [];
  const rule = B.buildFieldRule(raw, 'f', (m) => errs.push(m));
  return { rule, errs };
};

// ───────────────────────────────────────────────────────── the rebuild

check('an unknown key is DROPPED, not carried into the schema', () => {
  // The whole point of rebuilding rather than casting.
  const { rule } = build({ type: 'string', max: 10, evil: 'yes' });
  eq(rule, { type: 'string', max: 10 });
});

check('optional survives only as the literal true', () => {
  eq(build({ type: 'string', optional: true }).rule, { type: 'string', optional: true });
  eq(build({ type: 'string', optional: 'yes' }).rule, { type: 'string' });
  eq(build({ type: 'string', optional: 1 }).rule, { type: 'string' });
});

check('min above max is refused', () => {
  const { rule, errs } = build({ type: 'number', min: 10, max: 3 });
  eq(rule, null);
  if (!/min exceeds max/.test(errs.join())) throw new Error(errs.join());
});

check('a non-numeric min is refused rather than coerced', () => {
  eq(build({ type: 'number', min: '3' }).rule, null);
  eq(build({ type: 'number', min: NaN }).rule, null);
  eq(build({ type: 'number', min: Infinity }).rule, null);
});

check('min/max are ignored on types that have no length', () => {
  // A `min` on a boolean is nonsense, and carrying it would make validate()
  // read a key its boolean branch never examines.
  eq(build({ type: 'boolean', min: 3 }).rule, { type: 'boolean' });
  eq(build({ type: 'email', max: 5 }).rule, { type: 'email' });
});

check('an enum needs values, and they are COPIED', () => {
  const values = ['a', 'b'];
  const { rule } = build({ type: 'enum', values });
  eq(rule, { type: 'enum', values: ['a', 'b'] });
  values.push('c');
  eq(rule.values, ['a', 'b'], 'the caller cannot mutate the stored rule afterwards');
});

check('an enum value with a control character is refused', () => {
  // validate()'s enum branch checks MEMBERSHIP, so a NUL baked into a declared
  // value would be stored through it without ever being examined.
  eq(build({ type: 'enum', values: ['ok', 'b' + NUL + 'd'] }).rule, null, 'NUL');
  eq(build({ type: 'enum', values: ['ok', 'b' + BEL + 'd'] }).rule, null, 'BEL');
  eq(build({ type: 'enum', values: ['ok', 'b' + DEL + 'd'] }).rule, null, 'DEL');
  // A newline and a tab are ordinary text in a label and stay allowed.
  eq(build({ type: 'enum', values: ['a\nb'] }).rule, { type: 'enum', values: ['a\nb'] });
});

check('an empty or oversized enum is refused', () => {
  eq(build({ type: 'enum', values: [] }).rule, null);
  eq(build({ type: 'enum', values: Array.from({ length: 51 }, (_, i) => `v${i}`) }).rule, null);
  eq(build({ type: 'enum', values: ['x'.repeat(121)] }).rule, null);
  eq(build({ type: 'enum' }).rule, null);
});

check('a ref needs a collection-shaped target', () => {
  eq(build({ type: 'ref', to: 'venue' }).rule, { type: 'ref', to: 'venue' });
  eq(build({ type: 'ref' }).rule, null);
  eq(build({ type: 'ref', to: 'Venue' }).rule, null, 'not kebab-case');
  eq(build({ type: 'ref', to: '../etc' }).rule, null);
  eq(build({ type: 'ref', to: 42 }).rule, null);
});

check('an array always gets an `of`, defaulting to string', () => {
  // Without it validate()'s array branch has nothing to check items against.
  eq(build({ type: 'array' }).rule, { type: 'array', of: 'string' });
  eq(build({ type: 'array', of: 'number' }).rule, { type: 'array', of: 'number' });
  eq(build({ type: 'array', of: 'object' }).rule, { type: 'array', of: 'string' });
  eq(build({ type: 'array', max: 3 }).rule, { type: 'array', of: 'string', max: 3 });
});

check('an unknown type is refused and NAMES the accepted set', () => {
  const { rule, errs } = build({ type: 'wysiwyg' });
  eq(rule, null);
  if (!/string, number/.test(errs.join())) throw new Error(errs.join());
});

check('a non-object rule does not throw', () => {
  for (const raw of [null, undefined, 'string', 42, []]) eq(build(raw).rule, null, String(raw));
});

check('media and ref ARE in the vocabulary', () => {
  // The manifest door rejected exactly these two.
  eq(build({ type: 'media' }).rule, { type: 'media' });
  if (!B.FIELD_TYPE_SET.has('ref') || !B.FIELD_TYPE_SET.has('media')) throw new Error('missing');
});

// ─────────────────────────────────────────── the two doors must AGREE

const adminDef = (fields) => ([{ name: 'thing', label: 'Thing', fields }]);
const manifestOf = (fields) => ({
  id: 'test-plugin', name: 'P', version: '1.0.0',
  capabilities: { contentTypes: [{ name: 'thing', label: 'Thing', fields }] },
});

check('THE DOORS AGREE: every field kind accepted by one is accepted by the other', () => {
  for (const type of B.FIELD_TYPES) {
    const rule = type === 'enum' ? { type, values: ['a'] }
      : type === 'ref' ? { type, to: 'other' }
      // A repeater is defined by the shape of its items; an empty one has
      // nothing to validate an item against and is refused by both doors.
      : type === 'repeater' ? { type, fields: [{ name: 'label', rule: { type: 'string' } }] }
      : { type };
    const fields = [{ name: 'f', rule }];
    const admin = C.validateContentTypeDefinitions(adminDef(fields));
    const manifest = M.validateManifest(manifestOf(fields));
    if (!admin.ok) throw new Error(`admin door refused ${type}: ${admin.errors.join()}`);
    if (!manifest.ok) throw new Error(`manifest door refused ${type}: ${JSON.stringify(manifest.errors)}`);
  }
});

check('THE DOORS AGREE: a bad enum is refused by BOTH', () => {
  const fields = [{ name: 'f', rule: { type: 'enum', values: ['a' + NUL + 'b'] } }];
  if (C.validateContentTypeDefinitions(adminDef(fields)).ok) throw new Error('admin door accepted it');
  if (M.validateManifest(manifestOf(fields)).ok) throw new Error('manifest door accepted it');
});

check('THE DOORS AGREE: a ref with no target is refused by BOTH', () => {
  const fields = [{ name: 'f', rule: { type: 'ref' } }];
  if (C.validateContentTypeDefinitions(adminDef(fields)).ok) throw new Error('admin door accepted it');
  if (M.validateManifest(manifestOf(fields)).ok) throw new Error('manifest door accepted it');
});

check('THE MANIFEST PROJECTOR REBUILDS: an unknown key never reaches the registry', () => {
  // This is the hole the cast left. The manifest is valid, so it projects —
  // and the projected rule must not carry `evil`.
  const m = manifestOf([{ name: 'f', rule: { type: 'string', max: 10, evil: 'yes' } }]);
  const defs = M.manifestContentTypes(m);
  eq(defs[0].fields[0].rule, { type: 'string', max: 10 });
});

check('THE MANIFEST PROJECTOR REBUILDS: an array gets its `of`', () => {
  const defs = M.manifestContentTypes(manifestOf([{ name: 'f', rule: { type: 'array' } }]));
  eq(defs[0].fields[0].rule, { type: 'array', of: 'string' });
});

if (failures.length) {
  console.error(`\n✗ field-rule-build: ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error(`  · ${f}`);
  process.exit(1);
}
console.log(`✓ field-rule-build: ${passed} passed`);
