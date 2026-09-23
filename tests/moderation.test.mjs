#!/usr/bin/env node
/**
 * Per-record approval (C-142, C-35).
 *
 * The roadmap carried comments and product reviews as two LARGE rows, each
 * proposing its own table, its own storage on three drivers, its own migration,
 * its own GDPR registration and its own admin screen. They are one missing
 * primitive and two sets of fields.
 *
 * The primitive: `ContentTypeDefinition.visibility` is collection-WIDE, so
 * `'public'` publishes every row including one posted thirty seconds ago by a
 * bot. Nothing could express "the approved rows and not the pending ones",
 * which is the whole of comment and review moderation.
 *
 * Run with:  node tests/moderation.test.mjs
 */
import { loadTs } from './lib/load.mjs';

const M = await loadTs('src/core/moderation.ts');
const C = await loadTs('src/core/content-types.ts');

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
const entry = (status) => ({ id: status ?? 'legacy', data: status ? { _status: status } : {} });

// ───────────────────────────────────────────────────────────── the states

check('BACKWARD COMPATIBILITY: a row with no status counts as approved', () => {
  // Rows written before a type became moderated were already public under the
  // old rule. Retroactively hiding a shop's existing entries because somebody
  // ticked a box is a data-loss-shaped surprise; turning moderation on governs
  // what arrives NEXT.
  eq(M.statusOf({}), 'approved');
  eq(M.statusOf(undefined), 'approved');
  eq(M.statusOf({ _status: 'nonsense' }), 'approved');
});

check('a stored state is read back', () => {
  for (const s of M.MODERATION_STATES) eq(M.statusOf({ _status: s }), s);
});

check('only an approved record is publicly visible', () => {
  eq(M.isPubliclyVisible({ _status: 'approved' }), true);
  eq(M.isPubliclyVisible({ _status: 'pending' }), false);
  eq(M.isPubliclyVisible({ _status: 'rejected' }), false);
});

// ────────────────────────────────────────────────────────── the filter

const LIST = [entry('approved'), entry('pending'), entry('rejected'), entry(null)];

check('THE POINT: the public sees approved rows only', () => {
  eq(M.visibleEntries(LIST, { moderated: true, staff: false }).map((e) => e.id),
    ['approved', 'legacy']);
});

check('staff see everything, INCLUDING rejected', () => {
  // A queue that hides what it rejected cannot be reviewed, and "where did
  // that go?" is the question a queue exists to answer.
  eq(M.visibleEntries(LIST, { moderated: true, staff: true }).length, 4);
});

check('an UNMODERATED type is untouched, whoever is asking', () => {
  // The overwhelmingly common case must cost nothing and change nothing.
  eq(M.visibleEntries(LIST, { moderated: false, staff: false }).length, 4);
});

check('the filter copies rather than returning the caller\'s array', () => {
  const out = M.visibleEntries(LIST, { moderated: false, staff: true });
  out.push(entry('pending'));
  eq(LIST.length, 4);
});

// ─────────────────────────────────────────────────────── the initial state

check('a PUBLIC submission to a moderated type starts pending', () => {
  eq(M.initialStatus({ moderated: true, staff: false }), 'pending');
});

check('a STAFF entry starts approved — typing it IS the approval', () => {
  // Making staff approve their own entries adds a step that teaches people to
  // click through the queue without reading it.
  eq(M.initialStatus({ moderated: true, staff: true }), 'approved');
});

check('an unmoderated type stamps nothing at all', () => {
  eq(M.initialStatus({ moderated: false, staff: false }), undefined);
  eq(M.initialStatus({ moderated: false, staff: true }), undefined);
});

check('pendingCount is what a badge needs', () => {
  eq(M.pendingCount(LIST), 1);
  eq(M.pendingCount([]), 0);
});

// ─────────────────────────────────────────────── the definition validator

// NOT 'comment' — core ships a collection under that name and it is reserved
// against an operator's own type. See core/builtin-collections.ts.
const def = (over) => ([{ name: 'remark', label: 'Remark', fields: [{ name: 'body', rule: { type: 'string' } }], ...over }]);

check('a type may declare itself moderated', () => {
  const r = C.validateContentTypeDefinitions(def({ moderated: true, writable: 'public' }));
  if (!r.ok) throw new Error(r.errors.join());
  eq(r.defs[0].moderated, true);
});

check('absent stays absent — every existing type is byte-identical', () => {
  const r = C.validateContentTypeDefinitions(def({}));
  if (!r.ok) throw new Error(r.errors.join());
  eq(r.defs[0].moderated, undefined);
  eq('moderated' in r.defs[0], true, 'the key is present-and-undefined, per the mapped-type guard');
});

check('a non-boolean is refused rather than coerced', () => {
  if (C.validateContentTypeDefinitions(def({ moderated: 'yes' })).ok) throw new Error('accepted a string');
});

check('THE FIELD NAME IS RESERVED: `_status` cannot be declared', () => {
  // It is set by the server and read as authority. A declared field of that
  // name would let a submitter post their own approval — the feature exactly
  // inverted.
  const r = C.validateContentTypeDefinitions(def({
    fields: [{ name: '_status', rule: { type: 'string' } }],
  }));
  if (r.ok) throw new Error('accepted _status as a field');
  if (!/reserved/.test(r.errors.join())) throw new Error(r.errors.join());
});

check('`_status` is reserved INSIDE a repeater item too', () => {
  const r = C.validateContentTypeDefinitions(def({
    fields: [{ name: 'rows', rule: { type: 'repeater', fields: [{ name: '_status', rule: { type: 'string' } }] } }],
  }));
  if (r.ok) throw new Error('accepted _status as a sub-field');
});

if (failures.length) {
  console.error(`\n✗ moderation: ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error(`  · ${f}`);
  process.exit(1);
}
console.log(`✓ moderation: ${passed} passed`);
