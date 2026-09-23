#!/usr/bin/env node
/**
 * Comments and product reviews (C-142, C-35).
 *
 * The roadmap carried each as a LARGE row proposing its own table, its own
 * storage on three drivers, its own migration, its own GDPR registration and
 * its own admin screen. Once per-record approval existed and collections could
 * be filtered by field, the remaining difference between "a comment" and "an
 * enquiry" was the FIELDS — so they are content types, and they inherit the
 * REST surface, the moderation queue, the GDPR sweep, storage parity and the
 * backup without any of it being written twice.
 *
 * Run with:  node tests/builtin-collections.test.mjs
 */
import { loadTs } from './lib/load.mjs';

const B = await loadTs('src/core/builtin-collections.ts');
const C = await loadTs('src/core/content-types.ts');
const V = await loadTs('src/lib/validate.ts');
const O = await loadTs('src/lib/commerce/order-lookup.ts');
const SD = await loadTs('src/lib/structured-data.ts');
const L = await loadTs('src/lib/commerce/order-lookup.ts');
const G = await loadTs('src/lib/gdpr.ts');

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
const truthy = (v) => v === true || v === 'true';

// ────────────────────────────────────────────────────── off by default

check('NEITHER collection exists unless the operator asked', () => {
  // A site that has never wanted comments must not grow a public write
  // endpoint because it upgraded.
  eq(B.enabledBuiltinCollections({}, truthy), []);
  eq(B.enabledBuiltinCollections(null, truthy), []);
});

check('each switch registers exactly its own collection', () => {
  eq(B.enabledBuiltinCollections({ comments_enabled: true }, truthy).map((d) => d.name), ['comment']);
  eq(B.enabledBuiltinCollections({ reviews_enabled: true }, truthy).map((d) => d.name), ['review']);
  eq(B.enabledBuiltinCollections({ comments_enabled: true, reviews_enabled: true }, truthy)
    .map((d) => d.name), ['comment', 'review']);
});

// ─────────────────────────────────────── the definitions are well-formed

check('both definitions survive the field validator, under a non-reserved name', () => {
  // The NAMES are reserved against an operator, so the shipped definitions
  // cannot go through the admin door as they stand — that is the point. What
  // must still hold is that their FIELDS are ordinary and would pass any door:
  // a shipped definition the validators would refuse is a definition that only
  // works because nothing checks it.
  const r = C.validateContentTypeDefinitions([
    { ...B.COMMENT_TYPE, name: 'not-a-comment' },
    { ...B.REVIEW_TYPE, name: 'not-a-review' },
  ]);
  if (!r.ok) throw new Error(r.errors.join());
  eq(r.defs[0].moderated, true);
  eq(r.defs[1].fields.length, B.REVIEW_TYPE.fields.length);
});

check('CORE can register a reserved name, and nobody else can', () => {
  C.clearContentTypes();
  // The flag is the only way past the list.
  C.registerContentType(B.COMMENT_TYPE, { builtin: true });
  if (!C.getContentType('comment')) throw new Error('core could not register its own collection');
  let threw = false;
  try { C.registerContentType({ ...B.REVIEW_TYPE }); } catch { threw = true; }
  if (!threw) throw new Error('a plugin could register a reserved name');
  C.clearContentTypes();
});

check('both are PUBLIC to read and MODERATED to write', () => {
  // The pair is the point: the collection is readable, and a row is not, until
  // somebody approves it. Either half alone is wrong — public and unmoderated
  // publishes spam on arrival; moderated and staff-only is a form nobody reads.
  for (const def of [B.COMMENT_TYPE, B.REVIEW_TYPE]) {
    eq(def.visibility, 'public', def.name);
    eq(def.writable, 'public', def.name);
    eq(def.moderated, true, def.name);
  }
});

check('AN ERASED ORDER PROVES NOTHING — no lookup, no verified stamp', () => {
  // The erasure used to write ONE shared address onto every erased order of
  // every install — `erased@erased.invalid`, written in a public repository,
  // which makes it a published credential. Both public lookups match on the
  // stored address, so that constant plus an order number returned somebody's
  // erased order (still carrying the basket and the total), and the same
  // constant plus any product an erased customer had bought stamped a review as
  // a VERIFIED purchase.
  //
  // The token is per-order now, and this gate makes that belt-and-braces: an
  // erased order is unreachable whatever address is offered.
  const erased = {
    number: 'A-1', email: 'erased+deadbeefdeadbeef@invalid', erased_at: '2026-09-02',
    payment_status: 'paid', items: [{ product_id: 'p1' }],
  };
  if (L.findOrderForEmail([erased], 'A-1', erased.email)) throw new Error('its own token opened it');
  if (L.findOrderForEmail([erased], 'A-1', 'erased@erased.invalid')) throw new Error('the old constant opened it');
  if (L.boughtProduct([erased], erased.email, 'p1')) throw new Error('an erased order stamped a verified review');
});

check('...while a real order is unaffected', () => {
  // The gate must not cost a genuine buyer their lookup or their stamp.
  const live = {
    number: 'A-2', email: 'maria@example.com',
    payment_status: 'paid', items: [{ product_id: 'p1' }],
  };
  if (!L.findOrderForEmail([live], 'A-2', 'maria@example.com')) throw new Error('a real lookup broke');
  if (!L.boughtProduct([live], 'maria@example.com', 'p1')) throw new Error('a real buyer lost their stamp');
  // ...and the wrong address still opens nothing.
  if (L.findOrderForEmail([live], 'A-2', 'someone@else.com')) throw new Error('any address opens an order');
});

check('the erasure writes a DIFFERENT token per order', () => {
  // A shared value re-links a subject's orders to each other, which is the
  // opposite of what an erasure is for.
  const a = G.anonymisedOrderFields({ items: [] });
  const b = G.anonymisedOrderFields({ items: [] });
  if (a.email === b.email) throw new Error(`both orders got ${a.email}`);
  if (!/@invalid$/.test(a.email)) throw new Error(`not an inert address: ${a.email}`);
  // RFC 2606 reserves `.invalid`, so the token can never receive mail.
  if (/erased\.invalid$/.test(a.email)) throw new Error('the shared constant is back');
});

check('the erasure blanks the POSTCODE and keeps the COUNTRY', () => {
  // The postcode prices nothing that is not retained as a figure, and on a
  // record carrying the exact basket, total and timestamp it is the strongest
  // re-identification handle left. The country is the VAT place of supply and
  // `tax_cents` cannot be explained without it.
  const f = G.anonymisedOrderFields({ items: [], shipping_postcode: '15124', shipping_country: 'GR' });
  // The KEY MUST BE PRESENT and undefined, not absent.
  //
  // The storage layer MERGES (`{...existing, ...updates}`), so an absent key
  // means "leave it alone" and the postcode survives. `f.shipping_postcode !==
  // undefined` cannot tell those apart — it passed with the line deleted, which
  // a mutation caught. This is the same present-but-undefined rule the post
  // update path documents for clearing a field.
  if (!('shipping_postcode' in f)) throw new Error('the key is absent, so the merge keeps the old postcode');
  if (f.shipping_postcode !== undefined) throw new Error(`the postcode survived as ${f.shipping_postcode}`);
  if ('shipping_country' in f) throw new Error('the country was erased — VAT cannot be explained');
});

check('...and the same is true of every field the erasure CLEARS', () => {
  // Each of these must be a present key holding undefined, or the merge keeps
  // the old value and the erasure silently does nothing for that field.
  const f = G.anonymisedOrderFields({ items: [], customer_id: 'c1', shipping_postcode: '15124' });
  for (const key of ['customer_id', 'shipping_postcode']) {
    if (!(key in f)) throw new Error(`${key} is absent, so the storage merge keeps the old value`);
  }
});

check('the erasure marks the order with a DATE, not a timestamp', () => {
  // An exact time makes every order of one subject share a second, re-linking
  // the set the erasure just unlinked.
  const f = G.anonymisedOrderFields({ items: [] });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(f.erased_at))) throw new Error(`erased_at is ${f.erased_at}`);
});

check('the money and the payment trail are untouched', () => {
  // The whole justification for keeping the order is that the books add up and
  // a chargeback can be answered.
  const f = G.anonymisedOrderFields({ items: [], total_cents: 19900, payment_reference: 'pi_123' });
  for (const kept of ['total_cents', 'payment_reference', 'tax_cents', 'created_at', 'number']) {
    if (kept in f) throw new Error(`the erasure writes ${kept}, which must be left alone`);
  }
});

check('`verified_buyer` is NOT a declared field', () => {
  // That is what makes the server stamp safe: validate() copies nothing it was
  // not asked for, so a posted `verified_buyer: true` is gone before any route
  // logic runs. Declaring it would invert the only field on a review that
  // means anything.
  const names = B.REVIEW_TYPE.fields.map((f) => f.name);
  if (names.includes('verified_buyer')) throw new Error('declared — a reviewer could set it');
});

check('a submitted verified_buyer is DROPPED by the schema', () => {
  const schema = C.schemaForContentType(B.REVIEW_TYPE);
  const r = V.validate({
    product_id: 'p1', author_name: 'A', rating: 5, body: 'Good', verified_buyer: true,
  }, schema);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  if ('verified_buyer' in r.value) throw new Error('it survived validation');
});

check('a rating outside 1-5, or fractional, is refused by the RULE', () => {
  const schema = C.schemaForContentType(B.REVIEW_TYPE);
  const base = { product_id: 'p1', author_name: 'A', body: 'Good' };
  for (const rating of [0, 6, 4.5, -1, 'five']) {
    if (V.validate({ ...base, rating }, schema).ok) throw new Error(`accepted ${rating}`);
  }
  if (!V.validate({ ...base, rating: 4 }, schema).ok) throw new Error('rejected a valid rating');
});

check('a comment needs a post and a body', () => {
  const schema = C.schemaForContentType(B.COMMENT_TYPE);
  if (V.validate({ author_name: 'A', body: 'Hello there' }, schema).ok) throw new Error('no post_id');
  if (V.validate({ post_id: 'p', author_name: 'A' }, schema).ok) throw new Error('no body');
  if (!V.validate({ post_id: 'p', author_name: 'A', body: 'Hello there' }, schema).ok) {
    throw new Error('rejected a valid comment');
  }
});

// ─────────────────────────────────────────────────────── the aggregate

const review = (rating, status = 'approved') => ({ data: { rating, _status: status } });

check('a product with no reviews has NO average, not a zero', () => {
  // `aggregateRating` with reviewCount 0 is a structured-data error, and a shop
  // that emits it is asking for a manual action.
  eq(B.summariseRatings([]), { count: 0, average: null, histogram: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } });
});

check('the mean is rounded to ONE decimal', () => {
  // Two would imply a precision six reviews do not have, and a bare 4.666… in
  // full is the kind of number that makes a shop look automated.
  eq(B.summariseRatings([review(5), review(5), review(4)]).average, 4.7);
});

check('a nonsense rating is not counted', () => {
  const s = B.summariseRatings([review(5), { data: { rating: 'five' } }, { data: {} }, review(3)]);
  eq(s.count, 2);
  eq(s.average, 4);
});

check('the histogram is what a star breakdown needs', () => {
  eq(B.summariseRatings([review(5), review(5), review(1)]).histogram,
    { 1: 1, 2: 0, 3: 0, 4: 0, 5: 2 });
});

check('THE PRODUCT NODE emits a rating only when there is one', () => {
  const withNone = SD.productNode({ name: 'Frames', ratingCount: 0, ratingAverage: null }, { origin: 'https://x.gr' });
  if ('aggregateRating' in withNone) throw new Error('emitted an empty rating');
  const withSome = SD.productNode({ name: 'Frames', ratingCount: 3, ratingAverage: 4.7 }, { origin: 'https://x.gr' });
  eq(withSome.aggregateRating, {
    '@type': 'AggregateRating', ratingValue: '4.7', reviewCount: 3, bestRating: '5', worstRating: '1',
  });
});

// ───────────────────────────────────────────────── proving a purchase

const ORDERS = [
  { number: '1042', email: 'Anna@Example.GR', payment_status: 'paid', items: [{ product_id: 'p1' }] },
  { number: '1043', email: 'bo@example.gr', payment_status: 'unpaid', items: [{ product_id: 'p2' }] },
];

check('an order lookup answers the SAME for a wrong number and a wrong email', () => {
  // Telling them apart turns the endpoint into an order-number oracle: a script
  // walks the number space and learns how many orders a shop takes a day.
  eq(O.findOrderForEmail(ORDERS, '9999', 'anna@example.gr'), null);
  eq(O.findOrderForEmail(ORDERS, '1042', 'someone@else.gr'), null);
});

check('the address comparison survives capitals and spaces', () => {
  // An address typed on a phone arrives capitalised differently from one typed
  // at checkout on a laptop, and refusing that is refusing the actual customer.
  const found = O.findOrderForEmail(ORDERS, ' 1042 ', '  anna@example.gr ');
  if (!found) throw new Error('rejected the real customer');
});

check('VERIFIED BUYER: only a PAID order counts', () => {
  // Somebody who put a product in a basket and never paid is not a verified
  // buyer, and treating them as one is the cheapest way to fake a review.
  eq(O.boughtProduct(ORDERS, 'anna@example.gr', 'p1'), true);
  eq(O.boughtProduct(ORDERS, 'bo@example.gr', 'p2'), false, 'unpaid');
  eq(O.boughtProduct(ORDERS, 'anna@example.gr', 'p2'), false, 'never bought it');
  eq(O.boughtProduct(ORDERS, '', 'p1'), false);
  eq(O.boughtProduct(ORDERS, 'anna@example.gr', ''), false);
});

// ────────────────────────────────────────────── the names are reserved

check('an operator cannot define their own `comment` or `review` type', () => {
  // Otherwise a custom type would shadow a core collection, and the shadow
  // check would report it as a plugin clash nobody could act on.
  for (const name of ['comment', 'review', 'comments', 'reviews']) {
    const r = C.validateContentTypeDefinitions([{ name, label: 'X', fields: [{ name: 'a', rule: { type: 'string' } }] }]);
    if (r.ok) throw new Error(`accepted "${name}"`);
  }
});

if (failures.length) {
  console.error(`\n✗ builtin-collections: ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error(`  · ${f}`);
  process.exit(1);
}
console.log(`✓ builtin-collections: ${passed} passed`);
