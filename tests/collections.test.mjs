#!/usr/bin/env node
/**
 * Automatic collections — a category whose membership is a rule.
 *
 * Two properties are worth more than the rest:
 *
 *  1. **An unknown field, a bad operator or an empty rule matches NOTHING.**
 *     Never everything. A rule that matched everything because of a typo would
 *     publish the whole catalogue into a collection, and on a storefront that
 *     is indistinguishable from a merchandising decision somebody made on
 *     purpose — so nobody investigates.
 *  2. **`'add'` never removes.** An automatic collection must not un-file a
 *     product a human deliberately placed, or a merchant's manual curation
 *     silently evaporates the first time a price changes.
 *
 * Run with:  node tests/collections.test.mjs
 */
import { loadTs } from './lib/load.mjs';

const C = await loadTs('src/lib/commerce/collections.ts');

let pass = 0;
let fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };

const NOW = Date.parse('2026-09-06T12:00:00.000Z');
const product = (over = {}) => ({
  id: 'p1', name: 'Frame', slug: 'frame', price_cents: 12000, stock: 5,
  on_sale: false, in_stock: true, categories: ['manual-cat'], tags: ['new'],
  brand: 'tommy', status: 'active', created_at: '2026-09-01T00:00:00.000Z',
  custom: { material: 'titanium', frame_width_mm: 52 },
  ...over,
});

/* ---------------------------------------------------- conditions */
{
  const p = product();
  const holds = (field, op, value) => C.conditionHolds(p, { field, op, value }, NOW);

  check('price lt', holds('price_cents', 'lt', 20000) === true);
  check('price gte, false side', holds('price_cents', 'gte', 20000) === false);
  check('brand in', holds('brand', 'in', ['tommy', 'rayban']) === true);
  check('brand not-in', holds('brand', 'not-in', ['rayban']) === true);
  check('a LIST field matches when any member is in the list',
    holds('tags', 'in', ['new', 'clearance']) === true);
  check('a boolean is', holds('in_stock', 'is', true) === true);
  check('...and its false side', holds('on_sale', 'is', true) === false);
  check('stock gte', holds('stock', 'gte', 5) === true);
  check('created within days', holds('created_at', 'within-days', 30) === true);
  check('...and outside them', holds('created_at', 'within-days', 2) === false);
  check('contains on a string', holds('name', 'contains', 'ram') === true);

  // The merchant's own declared fields, from row 24's bag.
  check('a MERCHANT-declared field can be compared',
    holds('custom.material', 'eq', 'titanium') === true);
  check('...numerically too', holds('custom.frame_width_mm', 'gte', 50) === true);
  check('...and a missing one does not match', holds('custom.nope', 'eq', 'x') === false);

  /* THE FAIL-CLOSED SET. Every one of these must be false. */
  check('an unknown field matches NOTHING', holds('invented_field', 'eq', 'x') === false);
  check('an unusable numeric value matches nothing', holds('price_cents', 'lt', 'cheap') === false);
  check('a non-numeric field compared numerically matches nothing',
    holds('brand', 'lt', 5) === false);
  check('a bad date matches nothing', holds('brand', 'within-days', 30) === false);
  check('a zero/negative day window matches nothing',
    holds('created_at', 'within-days', 0) === false);
  // A stringy "false" must not read as true — settings and hand-written rules
  // both produce these.
  check('a stringy "false" on an `is` reads as false',
    C.conditionHolds(product({ on_sale: true }), { field: 'on_sale', op: 'is', value: 'false' }, NOW) === false);
}

/* ---------------------------------------------------- rules */
{
  const p = product();
  const all = { match: 'all', conditions: [
    { field: 'price_cents', op: 'lt', value: 20000 },
    { field: 'brand', op: 'in', value: ['tommy'] },
  ] };
  const anyOf = { match: 'any', conditions: [
    { field: 'price_cents', op: 'gt', value: 99999 },
    { field: 'brand', op: 'in', value: ['tommy'] },
  ] };
  check('match:all needs every condition', C.ruleMatches(p, all, NOW) === true);
  check('...and fails when one fails',
    C.ruleMatches(p, { ...all, conditions: [...all.conditions, { field: 'stock', op: 'gte', value: 999 }] }, NOW) === false);
  check('match:any needs one', C.ruleMatches(p, anyOf, NOW) === true);

  // THE ONE THAT MATTERS.
  check('an EMPTY rule matches nothing, not everything',
    C.ruleMatches(p, { match: 'all', conditions: [] }, NOW) === false);
  check('an absent rule matches nothing', C.ruleMatches(p, undefined, NOW) === false);
  check('a rule whose conditions are all unknown fields matches nothing',
    C.ruleMatches(p, { match: 'any', conditions: [{ field: 'nope', op: 'eq', value: 1 }] }, NOW) === false);
}

/* ---------------------------------------------------- effective membership */
{
  const p = product({ categories: ['manual-cat'] });
  const cheap = { id: 'c1', slug: 'under-200', name: 'Under 200', created_at: '', updated_at: '',
    rule: { match: 'all', conditions: [{ field: 'price_cents', op: 'lt', value: 20000 }] } };
  const pricey = { id: 'c2', slug: 'premium', name: 'Premium', created_at: '', updated_at: '',
    rule: { match: 'all', conditions: [{ field: 'price_cents', op: 'gte', value: 20000 }] } };

  const eff = C.effectiveCategories(p, [cheap, pricey], NOW);
  check('a matching rule adds the collection', eff.includes('under-200'));
  check('a non-matching one does not', !eff.includes('premium'));
  check('the MANUAL category survives', eff.includes('manual-cat'));

  // 'add' must never remove — a merchant's deliberate filing is not the rule's
  // to undo.
  const manualInRuled = product({ categories: ['premium'] });
  const eff2 = C.effectiveCategories(manualInRuled, [pricey], NOW);
  check("mode 'add' never removes a hand-filed product that fails the rule",
    eff2.includes('premium'));

  // 'only' is the destructive mode, and it must be asked for explicitly.
  const eff3 = C.effectiveCategories(manualInRuled, [{ ...pricey, rule_mode: 'only' }], NOW);
  check("mode 'only' does drop a hand-filed product that fails the rule",
    !eff3.includes('premium'));

  check('a category with NO rule is left entirely alone',
    C.effectiveCategories(p, [{ id: 'c3', slug: 'plain', name: 'Plain', created_at: '', updated_at: '' }], NOW)
      .join(',') === 'manual-cat');
  check('no duplicates when a rule matches a category already filed by hand',
    C.effectiveCategories(product({ categories: ['under-200'] }), [cheap], NOW)
      .filter((s) => s === 'under-200').length === 1);
}

/* ---------------------------------------------------- explanation */
{
  const p = product();
  const rule = { match: 'all', conditions: [
    { field: 'price_cents', op: 'lt', value: 20000 },
    { field: 'stock', op: 'gte', value: 999 },
  ] };
  const ex = C.explainMembership(p, rule, NOW);
  check('an explanation says whether it matches', ex.matches === false);
  check('...with one line per condition', ex.reasons.length === 2);
  check('...marking which held and which did not',
    ex.reasons[0].startsWith('✓') && ex.reasons[1].startsWith('✗'));
  check('...and showing the ACTUAL value, which is what a merchant needs',
    ex.reasons[1].includes('5'));
  check('a category with no rule explains that rather than throwing',
    C.explainMembership(p, undefined, NOW).reasons[0].includes('no rule'));
}

/* ---------------------------------------------------- normalisation */
{
  const good = C.normalizeCollectionRule({ match: 'any', conditions: [
    { field: 'price_cents', op: 'lt', value: 100 },
    { field: 'custom.material', op: 'eq', value: 'titanium' },
    // each of these must be DROPPED
    { field: 'invented', op: 'eq', value: 1 },
    { field: 'price_cents', op: 'sideways', value: 1 },
    { field: '', op: 'eq', value: 1 },
    { field: 'price_cents', op: 'lt' },
  ] });
  check('a good rule survives normalisation', good?.conditions.length === 2);
  check('...keeping the match mode', good?.match === 'any');
  check('an unknown field is dropped', !good?.conditions.some((c) => c.field === 'invented'));
  check('an unknown operator is dropped', !good?.conditions.some((c) => c.op === 'sideways'));
  check('a condition with no value is dropped',
    good?.conditions.filter((c) => c.field === 'price_cents').length === 1);

  check('a rule left with NO valid conditions becomes undefined, not empty',
    C.normalizeCollectionRule({ match: 'all', conditions: [{ field: 'nope', op: 'eq', value: 1 }] }) === undefined);
  check('a non-object is undefined', C.normalizeCollectionRule('rule') === undefined);
  check('an unknown match mode falls back to all, the stricter one',
    C.normalizeCollectionRule({ match: 'sometimes', conditions: [{ field: 'stock', op: 'gte', value: 1 }] })?.match === 'all');

  const many = C.normalizeCollectionRule({
    match: 'all',
    conditions: Array.from({ length: 40 }, () => ({ field: 'stock', op: 'gte', value: 1 })),
  });
  check('the condition count is bounded', many.conditions.length === C.MAX_CONDITIONS);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
