#!/usr/bin/env node
/**
 * Structured addresses: normalisation, completeness, the one-line projection,
 * and the address-book invariants.
 *
 * The properties worth defending here are not "does it copy strings":
 *
 *  1. The projection is ONE-WAY. Structured fields render down to a line;
 *     nothing parses a line back into fields. A test that only checked the
 *     rendering would pass in a world where somebody added a parser next week,
 *     so the parse-direction is asserted by its ABSENCE from the module.
 *  2. A bad country is REFUSED, not dropped. Dropping it stores an address that
 *     looks complete and ships nowhere.
 *  3. The address book has at most one default of each kind, enforced on write.
 *     A read-time "first one wins" drifts the moment the array is reordered.
 *
 * Run with:  node tests/address.test.mjs
 */
import { loadTs } from './lib/load.mjs';

const A = await loadTs('src/lib/commerce/address.ts');

let pass = 0;
let fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };

/* ---------------------------------------------------- country codes */
{
  check('a two-letter code is accepted and upper-cased', A.normalizeCountryCode('gr') === 'GR');
  check('surrounding space is trimmed', A.normalizeCountryCode('  de ') === 'DE');
  // The whole reason the migration refuses to write a country it cannot verify.
  check('a country NAME is not guessed into a code', A.normalizeCountryCode('Greece') === null);
  check('a three-letter code is refused', A.normalizeCountryCode('GRC') === null);
  check('empty and non-strings are null',
    A.normalizeCountryCode('') === null && A.normalizeCountryCode(undefined) === null
    && A.normalizeCountryCode(42) === null);
}

/* ---------------------------------------------------- normalisation */
{
  const r = A.normalizeAddress({
    name: '  Θεόδωρος  ', line1: 'Ερμού 15', city: 'Αθήνα', postcode: '10563', country: 'gr',
  });
  check('a good address parses', r.ok === true);
  check('...trimming as it goes', r.ok && r.value.name === 'Θεόδωρος');
  check('...and upper-casing the country', r.ok && r.value.country === 'GR');

  // Deny-by-default: the value is rebuilt key by key, never spread.
  const inj = A.normalizeAddress({ line1: 'x', evil: 'payload', total_cents: 1 });
  check('an undeclared key does not survive',
    inj.ok && !('evil' in inj.value) && !('total_cents' in inj.value));

  // A bad country is a refusal, not a silent drop — see the module note.
  const badCountry = A.normalizeAddress({ line1: 'x', country: 'Greece' });
  check('a country that is not ISO-2 is REFUSED', badCountry.ok === false);
  check('...with a reason naming the field',
    !badCountry.ok && /country/i.test(badCountry.error));

  check('a non-object is refused', A.normalizeAddress('Ερμού 15').ok === false);
  check('an array is refused', A.normalizeAddress(['Ερμού 15']).ok === false);

  const long = A.normalizeAddress({ line1: 'x'.repeat(500), postcode: '9'.repeat(90) });
  check('fields are capped', long.ok && long.value.line1.length === 200 && long.value.postcode.length === 20);

  const blank = A.normalizeAddress({ name: '   ', line1: '' });
  check('whitespace-only fields are absent, not empty strings',
    blank.ok && !('name' in blank.value) && !('line1' in blank.value));
  check('...which is what isEmptyAddress reports', blank.ok && A.isEmptyAddress(blank.value));
}

/* ---------------------------------------------------- completeness */
{
  const full = { name: 'A', line1: 'B', city: 'C', postcode: 'D', country: 'GR' };
  check('a full address is complete', A.isCompleteAddress(full) === true);
  for (const k of ['name', 'line1', 'city', 'postcode', 'country']) {
    const missing = { ...full };
    delete missing[k];
    check(`...and is not complete without ${k}`, A.isCompleteAddress(missing) === false);
  }
  // region is deliberately NOT required: mandatory for a US label, meaningless
  // for a Greek one, and a core rule demanding it would block this very shop.
  check('region is not required for completeness', A.isCompleteAddress(full) === true);
  check('undefined is not complete', A.isCompleteAddress(undefined) === false);
}

/* ---------------------------------------------------- the one-line projection */
{
  const a = {
    name: 'Θεόδωρος', company: 'ECW', line1: 'Ερμού 15', line2: '3ος όροφος',
    city: 'Αθήνα', postcode: '10563', country: 'GR', phone: '2101234567', tax_id: '123456789',
  };
  const line = A.formatAddressOneLine(a, 'en');

  check('the line carries the street', line.includes('Ερμού 15'));
  check('...the second line', line.includes('3ος όροφος'));
  check('...the company', line.includes('ECW'));
  check('...postcode and city together', line.includes('10563 Αθήνα'));

  // The three deliberate exclusions. Each has a reason in the module.
  check('the NAME is excluded (every renderer prints order.name above it)',
    !line.includes('Θεόδωρος'));
  check('the PHONE is excluded (it is Order.phone, not part of an address)',
    !line.includes('2101234567'));
  check('the TAX ID is excluded (an invoice header, not a parcel)',
    !line.includes('123456789'));

  // No stray separators from absent fields.
  const sparse = A.formatAddressOneLine({ line1: 'Ερμού 15', country: 'GR' }, 'en');
  check('absent fields leave no empty separators',
    !sparse.includes(', ,') && !sparse.startsWith(',') && !sparse.endsWith(','));

  check('an absent address renders as empty', A.formatAddressOneLine(undefined) === '');
  check('the line is capped at the legacy field width',
    A.formatAddressOneLine({ line1: 'x'.repeat(200), line2: 'y'.repeat(200), city: 'z'.repeat(120) }).length <= 500);
}

/* ---------------------------------------------------- one-way, asserted */
{
  // The module must not grow a parser. This is the assertion that keeps the
  // "we never guess a postcode" promise honest against a future edit — a
  // rendering test alone would pass either way.
  const src = await (await import('node:fs/promises')).readFile('src/lib/commerce/address.ts', 'utf8');
  check('the module exports no address PARSER',
    !/export function parseAddress|export function addressFromLine|fromOneLine/.test(src));
  check('...and the one-way rule is written down, not just practised',
    /never parses|one-way|NEVER parse/i.test(src));
}

/* ---------------------------------------------------- equality */
{
  check('absent and empty compare equal',
    A.addressesEqual({ line1: 'x' }, { line1: 'x', line2: '' }) === true);
  check('a real difference is not equal',
    A.addressesEqual({ line1: 'x' }, { line1: 'y' }) === false);
  check('a difference in tax_id counts',
    A.addressesEqual({ line1: 'x', tax_id: '1' }, { line1: 'x' }) === false);
}

/* ---------------------------------------------------- the address book */
{
  let n = 0;
  const makeId = () => `id-${++n}`;

  const { addresses } = A.normalizeSavedAddresses([
    { line1: 'Home', default_shipping: true, default_billing: true },
    { line1: 'Work', default_shipping: true },
  ], makeId);

  check('every entry is kept', addresses.length === 2);
  check('ids are assigned', addresses.every((a) => typeof a.id === 'string' && a.id));

  // The invariant, enforced on WRITE. Two rows claimed default_shipping.
  check('at most one default_shipping survives',
    addresses.filter((a) => a.default_shipping).length === 1);
  check('...and it is the LAST claimant (the row just edited)',
    addresses[1].default_shipping === true && addresses[0].default_shipping === undefined);
  check('the other default is independent',
    addresses.filter((a) => a.default_billing).length === 1 && addresses[0].default_billing === true);

  const withBlank = A.normalizeSavedAddresses(
    [{ line1: 'Home' }, { label: 'abandoned' }], makeId);
  check('an entry with no address content is dropped', withBlank.addresses.length === 1);

  const overflow = A.normalizeSavedAddresses(
    Array.from({ length: 50 }, (_, i) => ({ line1: `Street ${i}` })), makeId);
  check('the book is bounded', overflow.addresses.length === A.MAX_SAVED_ADDRESSES);

  const kept = A.normalizeSavedAddresses([{ id: 'stable-1', line1: 'Home' }], makeId);
  check('an existing id is preserved, so an edit does not re-key the row',
    kept.addresses[0].id === 'stable-1');

  const bad = A.normalizeSavedAddresses([{ line1: 'x', country: 'Greece' }], makeId);
  check('a bad row is reported rather than silently stored',
    bad.addresses.length === 0 && bad.errors.length === 1);

  check('defaultAddress finds the shipping default',
    A.defaultAddress(addresses, 'shipping')?.line1 === 'Work');
  check('...and the billing one', A.defaultAddress(addresses, 'billing')?.line1 === 'Home');
  check('...and copes with no book', A.defaultAddress(undefined, 'shipping') === undefined);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
