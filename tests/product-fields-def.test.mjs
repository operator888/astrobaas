#!/usr/bin/env node
/**
 * Merchant-definable product fields: the definition layer and the read
 * projection.
 *
 * The property that matters most is not "can a merchant add a field". It is
 * that the projection FAILS CLOSED:
 *
 *  - a field with no `visibility` is staff-only, because the first field a
 *    merchant adds is usually a cost price;
 *  - a MIS-SPELLED visibility ('Public', 'publik') is staff-only, not public;
 *  - flipping a field from public to staff hides it on the very NEXT read,
 *    which is the whole reason the values live in one bag with a read-time
 *    projection rather than in a public bag and a private bag.
 *
 * The last one is the design argument, so it is asserted directly: the same
 * stored product is projected under two different definition sets.
 *
 * Run with:  node tests/product-fields-def.test.mjs
 */
import { loadTs } from './lib/load.mjs';

const D = await loadTs('src/core/product-fields-def.ts');
const P = await loadTs('src/lib/product-fields.ts');

let pass = 0;
let fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };

const num = { type: 'number', optional: true };
const text = { type: 'string', optional: true, max: 100 };

/* ---------------------------------------------------- definitions */
{
  const ok = D.validateProductFieldDefs([
    { name: 'frame_width_mm', label: 'Frame width (mm)', rule: num, visibility: 'public' },
    { name: 'cost_price', rule: num },
  ]);
  check('a good definition list validates', ok.ok === true && ok.fields.length === 2);
  check('...keeping the label', ok.fields[0].label === 'Frame width (mm)');
  check('...and the public marking', ok.fields[0].visibility === 'public');
  check('...while an unmarked field stores NO visibility (absent means staff)',
    ok.fields[1].visibility === undefined);

  const dup = D.validateProductFieldDefs([{ name: 'a', rule: num }, { name: 'a', rule: num }]);
  check('a duplicate name is refused', dup.ok === false);

  const badName = D.validateProductFieldDefs([{ name: '9lives', rule: num }]);
  check('a name that does not start with a letter is refused', badName.ok === false);

  for (const reserved of ['sku', 'price_cents', 'custom', '__proto__', 'images']) {
    const r = D.validateProductFieldDefs([{ name: reserved, rule: num }]);
    check(`"${reserved}" cannot be redefined as a custom field`, r.ok === false);
  }

  const badVis = D.validateProductFieldDefs([{ name: 'x', rule: num, visibility: 'Public' }]);
  check('a MIS-SPELLED visibility is refused rather than coerced', badVis.ok === false);
  check('...naming the field so the admin can fix it',
    badVis.errors.some((e) => /visibility/.test(e)));

  const file = D.validateProductFieldDefs([{ name: 'x', rule: { type: 'file' } }]);
  check('a file upload is refused on a product, with a reason', file.ok === false
    && file.errors.some((e) => /media/.test(e)));

  const many = D.validateProductFieldDefs(
    Array.from({ length: D.MAX_PRODUCT_FIELDS + 1 }, (_, i) => ({ name: `f${i}`, rule: num })));
  check('the field count is bounded', many.ok === false);

  check('an absent definition list is valid and empty',
    D.validateProductFieldDefs(undefined).ok === true
    && D.validateProductFieldDefs(undefined).fields.length === 0);
  check('a non-array is refused', D.validateProductFieldDefs({ name: 'x' }).ok === false);

  // A rejected list yields NO fields — a partial save would silently drop the
  // rows the admin could not see were wrong.
  const partial = D.validateProductFieldDefs([{ name: 'good', rule: num }, { name: '9bad', rule: num }]);
  check('one bad field rejects the whole list rather than saving a partial one',
    partial.ok === false && partial.fields.length === 0);
}

/* ---------------------------------------------------- fails closed */
{
  const defs = D.validateProductFieldDefs([
    { name: 'frame_width_mm', rule: num, visibility: 'public' },
    { name: 'cost_price', rule: num },
    { name: 'supplier', rule: text, visibility: 'staff' },
  ]).fields;

  const custom = { frame_width_mm: 52, cost_price: 3000, supplier: 'ACME', legacy_note: 'x' };

  const pub = D.publicCustomFields(custom, defs);
  check('a public field is published', pub.frame_width_mm === 52);
  check('an UNMARKED field is withheld', !('cost_price' in pub));
  check('an explicitly staff field is withheld', !('supplier' in pub));
  check('an UNDECLARED key is withheld from the public view', !('legacy_note' in pub));

  check('productFieldIsPublic is exact-word', D.productFieldIsPublic({ visibility: 'public' }) === true
    && D.productFieldIsPublic({ visibility: 'staff' }) === false
    && D.productFieldIsPublic({}) === false
    && D.productFieldIsPublic(undefined) === false);

  /* THE DESIGN ARGUMENT, asserted.
   * The same stored product, projected under a definition set where the field
   * has been flipped to staff. One bag + read-time projection means it stops
   * being published immediately; a stored public bag would keep publishing it
   * until every product was re-saved. */
  const flipped = D.validateProductFieldDefs([
    { name: 'frame_width_mm', rule: num, visibility: 'staff' },
  ]).fields;
  const after = D.publicCustomFields(custom, flipped);
  check('flipping a field to staff hides it on the very NEXT read, with no re-save',
    after === undefined || !('frame_width_mm' in after));
}

/* ---------------------------------------------------- the reader projection */
{
  const defs = D.validateProductFieldDefs([
    { name: 'frame_width_mm', rule: num, visibility: 'public' },
    { name: 'cost_price', rule: num },
  ]).fields;
  const product = { id: 'p1', name: 'Frame', custom: { frame_width_mm: 52, cost_price: 3000 } };

  const anon = P.projectProductForReader(product, defs, false);
  check('an anonymous reader sees only public custom fields',
    anon.custom.frame_width_mm === 52 && !('cost_price' in anon.custom));

  const staff = P.projectProductForReader(product, defs, true);
  check('STAFF see the whole bag — the admin form loads through this route and saves what it loaded',
    staff.custom.cost_price === 3000);

  const allPrivate = P.projectProductForReader(
    { id: 'p', custom: { cost_price: 1 } },
    D.validateProductFieldDefs([{ name: 'cost_price', rule: num }]).fields,
    false,
  );
  check('a product whose every field is private exposes no empty custom object',
    !('custom' in allPrivate));

  const none = P.projectProductForReader({ id: 'p', name: 'x' }, defs, false);
  check('a product with no custom bag is untouched', none.custom === undefined);
  check('...and the original object is not mutated', product.custom.cost_price === 3000);
}

/* ---------------------------------------------------- write-path normalisation */
{
  const defs = D.validateProductFieldDefs([
    { name: 'frame_width_mm', rule: { type: 'number', optional: true } },
    { name: 'material', rule: { type: 'enum', values: ['acetate', 'titanium'], optional: true } },
  ]).fields;

  const good = P.normalizeCustomFields({ frame_width_mm: 52, material: 'titanium' }, undefined, defs);
  check('declared values validate and are kept', good.ok && good.value.frame_width_mm === 52);

  const bad = P.normalizeCustomFields({ material: 'wood' }, undefined, defs);
  check('a value outside the merchant\'s own enum is REFUSED, not dropped', bad.ok === false);

  const badType = P.normalizeCustomFields({ frame_width_mm: 'wide' }, undefined, defs);
  check('a value of the wrong type is refused', badType.ok === false);

  // THE ONE THAT PROTECTS DATA: deleting a definition must not delete values.
  const carried = P.normalizeCustomFields(
    { frame_width_mm: 50 }, { frame_width_mm: 52, retired_field: 'keep me' }, defs);
  check('a value whose DEFINITION was deleted survives a save',
    carried.ok && carried.value.retired_field === 'keep me');
  check('...while the declared one still updates', carried.ok && carried.value.frame_width_mm === 50);

  const untouched = P.normalizeCustomFields(undefined, { a: 1 }, defs);
  check('omitting custom entirely leaves the existing bag alone',
    untouched.ok && untouched.value.a === 1);

  const cleared = P.normalizeCustomFields(null, { a: 1 }, defs);
  check('an explicit null clears the bag', cleared.ok && cleared.value === undefined);

  const notObject = P.normalizeCustomFields('nope', undefined, defs);
  check('a non-object custom is refused', notObject.ok === false);

  const undeclaredIn = P.normalizeCustomFields({ sneaky: 'x' }, undefined, defs);
  check('an UNDECLARED key sent by a client is not stored',
    undeclaredIn.ok && (undeclaredIn.value === undefined || !('sneaky' in undeclaredIn.value)));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
