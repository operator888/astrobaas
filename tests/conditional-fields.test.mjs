#!/usr/bin/env node
/**
 * Conditional fields and multi-step forms (C-22, C-125).
 *
 * These arrived as two roadmap rows and one mechanism. The recon found two
 * separate plans for the same `showIf: {field, equals}` shape — one calling it
 * `visibleFields`, the other `visibleSchemaFor` — which is exactly how the
 * client and the server come to disagree about whether a field was required.
 *
 * The half that matters is the SERVER half, and it is the half a browser test
 * cannot cover:
 *
 *   · a hidden required field must become OPTIONAL, or the form the operator
 *     built is unsubmittable and reports "x is required" about a box nobody
 *     was shown;
 *   · a hidden field's submitted value must be DROPPED, because a browser is
 *     not the only thing that can POST.
 *
 * Run with:  node tests/conditional-fields.test.mjs
 */
import { loadTs } from './lib/load.mjs';

const C = await loadTs('src/core/content-types.ts');
const V = await loadTs('src/lib/validate.ts');

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

// A support form: "is this about an order?" reveals the order number.
const DEF = {
  name: 'enquiry',
  label: 'Enquiry',
  fields: [
    { name: 'email', rule: { type: 'email' } },
    { name: 'about_order', rule: { type: 'enum', values: ['yes', 'no'] } },
    { name: 'order_number', rule: { type: 'string' }, showIf: { field: 'about_order', equals: 'yes' } },
    { name: 'message', rule: { type: 'string', max: 500 } },
  ],
};

// ────────────────────────────────────────────────────────── conditionHolds

check('an absent parent value never satisfies a condition', () => {
  // A field whose parent has not been answered yet is not shown. The
  // alternative — showing it — makes a form open with every branch expanded.
  eq(C.conditionHolds({ field: 'a', equals: 'yes' }, {}), false);
  eq(C.conditionHolds({ field: 'a', equals: 'yes' }, { a: null }), false);
});

check('no condition means always shown', () => {
  eq(C.conditionHolds(undefined, {}), true);
});

check('the comparison is by STRING, on both sides', () => {
  // A browser sends "true" from a checkbox and "1" from some selects; a
  // definition may hold the boolean true or the number 1. A strict comparison
  // would make a condition that plainly reads as satisfied evaluate false, and
  // an operator would have no way to tell which spelling the code wanted.
  eq(C.conditionHolds({ field: 'a', equals: true }, { a: 'true' }), true);
  eq(C.conditionHolds({ field: 'a', equals: 'true' }, { a: true }), true);
  eq(C.conditionHolds({ field: 'a', equals: 1 }, { a: '1' }), true);
  eq(C.conditionHolds({ field: 'a', equals: 'yes' }, { a: 'no' }), false);
});

// ────────────────────────────────────────────────────────── visibleFields

check('a field whose condition is unmet is not in play', () => {
  eq(C.visibleFields(DEF, { about_order: 'no' }).map((f) => f.name),
    ['email', 'about_order', 'message']);
  eq(C.visibleFields(DEF, { about_order: 'yes' }).map((f) => f.name),
    ['email', 'about_order', 'order_number', 'message']);
});

// ───────────────────────────────────────────────────── schemaForSubmission

check('THE ONE THAT MATTERS: a hidden REQUIRED field becomes optional', () => {
  // Without this the form is unsubmittable: the visitor answered "no", the
  // browser hid the box, and the server says "order_number is required".
  const { schema, values } = C.schemaForSubmission(DEF, { email: 'a@b.gr', about_order: 'no', message: 'hi' });
  eq(schema.order_number.optional, true);
  const r = V.validate(values, schema);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
});

check('THE OTHER ONE: a hidden field\'s VALUE is dropped', () => {
  // A browser is not the only thing that can POST here. Without this a bot
  // fills in the branch it never took, and the record carries an answer to a
  // question that was never asked.
  const { values } = C.schemaForSubmission(DEF, {
    email: 'a@b.gr', about_order: 'no', order_number: 'INJECTED', message: 'hi',
  });
  if ('order_number' in values) throw new Error(JSON.stringify(values));
});

check('a SHOWN field keeps its value and its requirement', () => {
  const { schema, values } = C.schemaForSubmission(DEF, {
    email: 'a@b.gr', about_order: 'yes', order_number: '1042', message: 'hi',
  });
  eq(schema.order_number.optional, undefined);
  eq(values.order_number, '1042');
  if (!V.validate(values, schema).ok) throw new Error('rejected a complete submission');
});

check('a shown-but-empty required field is STILL refused', () => {
  // The relaxation must be exactly as wide as the condition. If answering
  // "yes" and leaving the box empty passed, the condition would have made the
  // field optional rather than conditional.
  const { schema, values } = C.schemaForSubmission(DEF, { email: 'a@b.gr', about_order: 'yes', message: 'hi' });
  const r = V.validate(values, schema);
  if (r.ok) throw new Error('accepted a submission missing a visible required field');
  if (!r.errors.order_number) throw new Error(JSON.stringify(r.errors));
});

check('the form\'s own meta-fields pass through untouched', () => {
  // hp_url (honeypot) and pow_token (anti-spam) are not declared fields, and
  // the caller reads them off the raw body AFTER this runs.
  const { values } = C.schemaForSubmission(DEF, {
    email: 'a@b.gr', about_order: 'no', message: 'hi', hp_url: '', pow_token: 'abc',
  });
  eq(values.hp_url, '');
  eq(values.pow_token, 'abc');
});

check('a type with no conditions is unchanged', () => {
  // The overwhelmingly common case must cost nothing and change nothing.
  const plain = { name: 'x', label: 'X', fields: [{ name: 'a', rule: { type: 'string' } }] };
  const { schema, values } = C.schemaForSubmission(plain, { a: 'hi', b: 'stray' });
  eq(schema, { a: { type: 'string' } });
  eq(values, { a: 'hi', b: 'stray' }, 'an undeclared key is left for validate() to drop');
});

check('a CHAIN settles: b depends on a, c depends on b', () => {
  const chain = {
    name: 'c', label: 'C',
    fields: [
      { name: 'a', rule: { type: 'string' } },
      { name: 'b', rule: { type: 'string' }, showIf: { field: 'a', equals: 'go' } },
      { name: 'c', rule: { type: 'string' }, showIf: { field: 'b', equals: 'on' } },
    ],
  };
  eq(C.visibleFields(chain, { a: 'stop' }).map((f) => f.name), ['a']);
  eq(C.visibleFields(chain, { a: 'go' }).map((f) => f.name), ['a', 'b']);
  eq(C.visibleFields(chain, { a: 'go', b: 'on' }).map((f) => f.name), ['a', 'b', 'c']);
  // And c's value is dropped while b is unanswered, even though c was sent.
  const { values } = C.schemaForSubmission(chain, { a: 'stop', b: 'on', c: 'sneaky' });
  eq(Object.keys(values), ['a']);
});

// ───────────────────────────────────────────────────────────────── steps

check('a type with no steps has one', () => {
  eq(C.stepCount(DEF), 1);
  eq(C.stepCount({ ...DEF, steps: [] }), 1);
});

check('stepCount counts the titles', () => {
  eq(C.stepCount({ ...DEF, steps: [{ title: 'A' }, { title: 'B' }] }), 2);
});

// ────────────────────────────────────────────── the definition validator

const def = (over) => ([{ name: 'thing', label: 'Thing', fields: [], ...over }]);
const v = (defs) => C.validateContentTypeDefinitions(defs);

check('a condition naming a LATER field is refused', () => {
  // Two fields each waiting on the other is a form where neither ever appears,
  // and it looks perfectly correct in the builder. Requiring an EARLIER target
  // makes the cycle impossible rather than merely unlikely.
  const r = v(def({ fields: [
    { name: 'a', rule: { type: 'string' }, showIf: { field: 'b', equals: 'x' } },
    { name: 'b', rule: { type: 'string' } },
  ] }));
  if (r.ok) throw new Error('accepted a forward reference');
  if (!/BEFORE/.test(r.errors.join())) throw new Error(r.errors.join());
});

check('a condition naming ITSELF is refused', () => {
  const r = v(def({ fields: [
    { name: 'a', rule: { type: 'string' }, showIf: { field: 'a', equals: 'x' } },
  ] }));
  if (r.ok) throw new Error('accepted a self reference');
});

check('a condition naming a field that does not exist is refused', () => {
  const r = v(def({ fields: [
    { name: 'a', rule: { type: 'string' }, showIf: { field: 'ghost', equals: 'x' } },
  ] }));
  if (r.ok) throw new Error('accepted a dangling reference');
});

check('a valid backward condition is kept, rebuilt', () => {
  const r = v(def({ fields: [
    { name: 'a', rule: { type: 'string' } },
    { name: 'b', rule: { type: 'string' }, showIf: { field: 'a', equals: 'x', evil: 1 } },
  ] }));
  if (!r.ok) throw new Error(r.errors.join());
  eq(r.defs[0].fields[1].showIf, { field: 'a', equals: 'x' }, 'the unknown key is dropped');
});

check('a step beyond the declared list is refused', () => {
  const r = v(def({ steps: [{ title: 'One' }, { title: 'Two' }], fields: [
    { name: 'a', rule: { type: 'string' }, step: 3 },
  ] }));
  if (r.ok) throw new Error('accepted a step nobody can reach');
});

check('step 1 is not stored, so an old definition is byte-identical', () => {
  const r = v(def({ steps: [{ title: 'One' }, { title: 'Two' }], fields: [
    { name: 'a', rule: { type: 'string' }, step: 1 },
  ] }));
  if (!r.ok) throw new Error(r.errors.join());
  if ('step' in r.defs[0].fields[0]) throw new Error(JSON.stringify(r.defs[0].fields[0]));
});

check('ONE step is the same as none', () => {
  const r = v(def({ steps: [{ title: 'Only' }], fields: [{ name: 'a', rule: { type: 'string' } }] }));
  if (!r.ok) throw new Error(r.errors.join());
  eq(r.defs[0].steps, undefined);
});

check('a step with no title is refused', () => {
  if (v(def({ steps: [{ title: 'A' }, { title: '  ' }], fields: [{ name: 'a', rule: { type: 'string' } }] })).ok) {
    throw new Error('accepted a blank step title');
  }
});

// ─────────────────────────────────────────────── field labels (presentation)
//
// A field's `label` used to be dropped on save, so a theme or plugin that sent
// "Seats left" got `seats_left` on the admin screen and the public form alike.

check('a field label is kept, trimmed', () => {
  const r = v(def({ fields: [{ name: 'seats_left', label: '  Seats left ', rule: { type: 'number' } }] }));
  if (!r.ok) throw new Error(r.errors.join());
  eq(r.defs[0].fields[0].label, 'Seats left');
});

check('a field label is capped and loses control characters', () => {
  const r = v(def({ fields: [{ name: 'a', label: `Line\nbreak\u0000${'x'.repeat(200)}`, rule: { type: 'string' } }] }));
  if (!r.ok) throw new Error(r.errors.join());
  const label = r.defs[0].fields[0].label;
  if (/[\u0000-\u001f]/.test(label)) throw new Error('control characters kept');
  eq(label.length, 80, 'length');
});

check('an empty field label is not stored', () => {
  const r = v(def({ fields: [{ name: 'a', label: '   ', rule: { type: 'string' } }] }));
  if (!r.ok) throw new Error(r.errors.join());
  eq('label' in r.defs[0].fields[0], false);
});

check('a field label that is not a string is refused', () => {
  const r = v(def({ fields: [{ name: 'a', label: { html: '<b>x</b>' }, rule: { type: 'string' } }] }));
  if (r.ok) throw new Error('accepted an object label');
  if (!/label must be a string/.test(r.errors.join())) throw new Error(r.errors.join());
});

check('a definition with neither steps nor conditions is unchanged', () => {
  const r = v(def({ fields: [{ name: 'a', rule: { type: 'string' } }] }));
  if (!r.ok) throw new Error(r.errors.join());
  eq(r.defs[0].fields[0], { name: 'a', rule: { type: 'string' } });
  eq(r.defs[0].steps, undefined);
});

if (failures.length) {
  console.error(`\n✗ conditional-fields: ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error(`  · ${f}`);
  process.exit(1);
}
console.log(`✓ conditional-fields: ${passed} passed`);
