#!/usr/bin/env node
/**
 * Repeaters and flexible-content layouts (C-123 + C-126).
 *
 * These arrived as two roadmap rows and are one rule: a repeater whose items
 * all share a shape, or a repeater whose items each pick a NAMED shape and
 * carry a `_layout` tag. The second is ACF's flexible content, and building it
 * as its own feature would have meant a second nesting mechanism.
 *
 * The row that mattered most is not in either description. Three places filter
 * a definition's fields flat — the ref checker, the media resolver, and the
 * GDPR sweep that FINDS a data subject. The moment an item can hold an email,
 * a flat sweep answers a subject-access request with "we hold nothing about
 * you" while holding it. So the walker was written before the rule was.
 *
 * Run with:  node tests/repeater.test.mjs
 */
import { loadTs } from './lib/load.mjs';

const V = await loadTs('src/lib/validate.ts');
const C = await loadTs('src/core/content-types.ts');
const M = await loadTs('src/core/manifest.ts');
const W = await loadTs('src/lib/field-walk.ts');

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

const REPEATER = {
  type: 'repeater',
  fields: [
    { name: 'label', rule: { type: 'string', max: 60 } },
    { name: 'contact', rule: { type: 'email', optional: true } },
  ],
};
const LAYOUTS = {
  type: 'repeater',
  layouts: [
    { name: 'quote', label: 'Quote', fields: [{ name: 'text', rule: { type: 'string' } }] },
    { name: 'stat', label: 'Stat', fields: [{ name: 'value', rule: { type: 'number' } }] },
  ],
};

// ──────────────────────────────────────────────────────────── validation

check('a well-formed list of items validates, and the values survive', () => {
  const r = V.validate({ team: [{ label: 'Anna' }, { label: 'Bo', contact: 'bo@x.gr' }] },
    { team: { ...REPEATER } });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  eq(r.value.team, [{ label: 'Anna' }, { label: 'Bo', contact: 'bo@x.gr' }]);
});

check('an item with an UNDECLARED key has it dropped', () => {
  // The nested validate() does the same job the outer one does — a key nobody
  // declared is not stored, so a caller cannot smuggle fields into an item.
  const r = V.validate({ team: [{ label: 'Anna', secret: 'x' }] }, { team: { ...REPEATER } });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  eq(r.value.team, [{ label: 'Anna' }]);
});

check('an item missing a REQUIRED sub-field names the item AND the field', () => {
  // "invalid" tells an operator with a twelve-item list nothing at all.
  const r = V.validate({ team: [{ label: 'ok' }, { contact: 'b@x.gr' }] }, { team: { ...REPEATER } });
  if (r.ok) throw new Error('accepted an incomplete item');
  const key = Object.keys(r.errors).find((k) => k.startsWith('team[1]'));
  if (!key) throw new Error(JSON.stringify(r.errors));
  if (!/label/.test(key)) throw new Error(key);
});

check('a sub-field is validated by its OWN rule', () => {
  const r = V.validate({ team: [{ label: 'a', contact: 'not-an-email' }] }, { team: { ...REPEATER } });
  if (r.ok) throw new Error('accepted a bad email inside an item');
});

check('a non-array is refused', () => {
  if (V.validate({ team: 'Anna' }, { team: { ...REPEATER } }).ok) throw new Error('accepted a string');
  if (V.validate({ team: { label: 'x' } }, { team: { ...REPEATER } }).ok) throw new Error('accepted an object');
});

check('an item that is not an object is refused', () => {
  const r = V.validate({ team: ['Anna'] }, { team: { ...REPEATER } });
  if (r.ok) throw new Error('accepted a bare string as an item');
});

check('min and max are enforced', () => {
  const bounded = { ...REPEATER, min: 1, max: 2 };
  if (V.validate({ team: [] }, { team: bounded }).ok) throw new Error('accepted below min');
  if (V.validate({ team: [{ label: 'a' }, { label: 'b' }, { label: 'c' }] }, { team: bounded }).ok) {
    throw new Error('accepted above max');
  }
  if (!V.validate({ team: [{ label: 'a' }] }, { team: bounded }).ok) throw new Error('rejected a valid list');
});

check('THE SERVER CEILING holds whatever the definition asks', () => {
  // The definition's max is the operator's editorial limit. This is the
  // server's, and without it the only bound is the 2 MB body cap — which ten
  // thousand one-field items fit inside comfortably, each costing a nested
  // validate().
  const many = Array.from({ length: V.MAX_REPEATER_ITEMS + 1 }, () => ({ label: 'x' }));
  const r = V.validate({ team: many }, { team: { ...REPEATER, max: 100000 } });
  if (r.ok) throw new Error('no server ceiling');
});

check('an optional repeater may be absent', () => {
  const r = V.validate({}, { team: { ...REPEATER, optional: true } });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
});

// ──────────────────────────────────────────── flexible content (layouts)

check('an item picks its layout, and keeps the tag', () => {
  const r = V.validate({ blocks: [{ _layout: 'quote', text: 'hi' }, { _layout: 'stat', value: 3 }] },
    { blocks: { ...LAYOUTS } });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  eq(r.value.blocks, [{ _layout: 'quote', text: 'hi' }, { _layout: 'stat', value: 3 }]);
});

check('an UNKNOWN layout is refused, and the message lists the real ones', () => {
  const r = V.validate({ blocks: [{ _layout: 'hero', text: 'hi' }] }, { blocks: { ...LAYOUTS } });
  if (r.ok) throw new Error('accepted an unknown layout');
  if (!/quote, stat/.test(Object.values(r.errors).join())) throw new Error(JSON.stringify(r.errors));
});

check('an item with NO layout is refused rather than guessed', () => {
  // Guessing a shape would store fields nobody declared under a name nobody
  // chose.
  if (V.validate({ blocks: [{ text: 'hi' }] }, { blocks: { ...LAYOUTS } }).ok) {
    throw new Error('guessed a layout');
  }
});

check('a layout validates against ITS OWN fields, not another layout\'s', () => {
  // `value` belongs to `stat`; on a `quote` item it is an undeclared key.
  const r = V.validate({ blocks: [{ _layout: 'quote', value: 3 }] }, { blocks: { ...LAYOUTS } });
  if (r.ok) throw new Error('a quote accepted a stat field as its content');
});

// ───────────────────────────────────────────────── the definition doors

const adminDef = (fields) => ([{ name: 'thing', label: 'Thing', fields }]);
const v = (fields) => C.validateContentTypeDefinitions(adminDef(fields));

check('a repeater is accepted and its sub-fields REBUILT', () => {
  const r = v([{ name: 'team', rule: { ...REPEATER, evil: 1,
    fields: [{ name: 'label', rule: { type: 'string', max: 60, evil: 2 } }] } }]);
  if (!r.ok) throw new Error(r.errors.join());
  eq(r.defs[0].fields[0].rule, { type: 'repeater', fields: [{ name: 'label', rule: { type: 'string', max: 60 } }] });
});

check('A REPEATER INSIDE A REPEATER IS REFUSED', () => {
  // One level is the decision that removes the recursion-depth question, the
  // cycle question and the "how deep does the GDPR sweep walk" question.
  const r = v([{ name: 'a', rule: { type: 'repeater', fields: [
    { name: 'b', rule: { type: 'repeater', fields: [{ name: 'c', rule: { type: 'string' } }] } },
  ] } }]);
  if (r.ok) throw new Error('accepted nesting two levels deep');
  if (!/cannot contain a repeater/.test(r.errors.join())) throw new Error(r.errors.join());
});

check('a repeater with NO fields is refused', () => {
  if (v([{ name: 'a', rule: { type: 'repeater', fields: [] } }]).ok) throw new Error('accepted an empty shape');
  if (v([{ name: 'a', rule: { type: 'repeater' } }]).ok) throw new Error('accepted no shape at all');
});

check('fields AND layouts together is refused', () => {
  // An item would have two shapes and no rule for picking.
  const r = v([{ name: 'a', rule: { type: 'repeater', fields: [{ name: 'x', rule: { type: 'string' } }],
    layouts: [{ name: 'q', label: 'Q', fields: [{ name: 'y', rule: { type: 'string' } }] }] } }]);
  if (r.ok) throw new Error('accepted both');
});

check('`_layout` cannot be a declared sub-field name', () => {
  // It is the discriminator the writer sets; a declared field of that name
  // would be clobbered and the item would become unreadable.
  const r = v([{ name: 'a', rule: { type: 'repeater', fields: [{ name: '_layout', rule: { type: 'string' } }] } }]);
  if (r.ok) throw new Error('accepted the discriminator as a field');
});

check('the form meta-fields are reserved INSIDE an item too', () => {
  for (const name of ['hp_url', 'pow_token']) {
    if (v([{ name: 'a', rule: { type: 'repeater', fields: [{ name, rule: { type: 'string' } }] } }]).ok) {
      throw new Error(`accepted ${name} as a sub-field`);
    }
  }
});

check('THE DOORS AGREE about the repeater', () => {
  const fields = [{ name: 'team', rule: REPEATER }];
  const manifest = M.validateManifest({
    id: 'test-plugin', name: 'P', version: '1.0.0',
    capabilities: { contentTypes: [{ name: 'thing', label: 'Thing', fields }] },
  });
  if (!manifest.ok) throw new Error(JSON.stringify(manifest.errors));
  if (!v(fields).ok) throw new Error('admin door refused it');
});

check('THE DOORS AGREE: nesting is refused by the manifest door too', () => {
  const fields = [{ name: 'a', rule: { type: 'repeater', fields: [
    { name: 'b', rule: { type: 'repeater', fields: [{ name: 'c', rule: { type: 'string' } }] } },
  ] } }];
  const manifest = M.validateManifest({
    id: 'test-plugin', name: 'P', version: '1.0.0',
    capabilities: { contentTypes: [{ name: 'thing', label: 'Thing', fields }] },
  });
  if (manifest.ok) throw new Error('the manifest door accepted two levels');
});

// ───────────────────────────────────────────────────────── the walker

const DEF = {
  name: 'page', label: 'Page',
  fields: [
    { name: 'title', rule: { type: 'string' } },
    { name: 'owner_email', rule: { type: 'email' } },
    { name: 'team', rule: { type: 'repeater', fields: [
      { name: 'person_email', rule: { type: 'email' } },
      { name: 'photo', rule: { type: 'media' } },
    ] } },
  ],
};

check('THE ONE THAT MATTERS: the sweep sees a NESTED email', () => {
  // Flat, this returns one field and a data subject inside a repeater item is
  // invisible — a subject-access request that answers "we hold nothing about
  // you" while holding it.
  eq(W.fieldsOfType(DEF, 'email').map((w) => w.path), ['owner_email', 'team[].person_email']);
});

check('valuesAt flattens a nested field across every item', () => {
  const data = { owner_email: 'a@x.gr', team: [{ person_email: 'b@x.gr' }, { person_email: 'c@x.gr' }] };
  const nested = W.fieldsOfType(DEF, 'email').find((w) => w.parent);
  eq(W.valuesAt(nested, data), ['b@x.gr', 'c@x.gr']);
});

check('valuesAt on a missing or wrongly-shaped list returns nothing', () => {
  const nested = W.fieldsOfType(DEF, 'email').find((w) => w.parent);
  eq(W.valuesAt(nested, {}), []);
  eq(W.valuesAt(nested, { team: 'not a list' }), []);
  eq(W.valuesAt(nested, { team: [null, 'x', { other: 1 }] }), []);
});

check('a layout-tagged item only answers for ITS OWN layout', () => {
  const def = { name: 'p', label: 'P', fields: [{ name: 'blocks', rule: {
    type: 'repeater',
    layouts: [
      { name: 'a', label: 'A', fields: [{ name: 'who', rule: { type: 'email' } }] },
      { name: 'b', label: 'B', fields: [{ name: 'who', rule: { type: 'email' } }] },
    ],
  } }] };
  const walked = W.fieldsOfType(def, 'email');
  eq(walked.map((w) => w.layout), ['a', 'b']);
  const data = { blocks: [{ _layout: 'a', who: 'x@y.gr' }, { _layout: 'b', who: 'z@y.gr' }] };
  eq(W.valuesAt(walked[0], data), ['x@y.gr']);
  eq(W.valuesAt(walked[1], data), ['z@y.gr']);
});

check('walkFields yields the repeater itself as well as its children', () => {
  eq(W.walkFields(DEF).map((w) => w.path),
    ['title', 'owner_email', 'team', 'team[].person_email', 'team[].photo']);
});

check('setAt enriches every item, and only the matching layout', () => {
  const walked = W.fieldsOfType(DEF, 'media')[0];
  const data = { team: [{ photo: 'm1' }, { photo: 'm2' }] };
  W.setAt(walked, data, (id) => (id ? { photo_url: `/uploads/${id}.webp` } : undefined));
  eq(data.team, [
    { photo: 'm1', photo_url: '/uploads/m1.webp' },
    { photo: 'm2', photo_url: '/uploads/m2.webp' },
  ]);
});

if (failures.length) {
  console.error(`\n✗ repeater: ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error(`  · ${f}`);
  process.exit(1);
}
console.log(`✓ repeater: ${passed} passed`);
