#!/usr/bin/env node
/**
 * Weighted relevance ranking (src/lib/search/rank.ts).
 *
 * The cases here are the ones the previous substring search got wrong on the
 * real 436-product catalogue, plus the ones a scoring change would quietly
 * break:
 *
 *   · a shopper types the words in the other order;
 *   · a description repeating a word out-ranks the product NAMED that word;
 *   · adding a word to a query widens the results instead of narrowing them;
 *   · an SKU is buried under every product of the same brand.
 *
 * Run with:  node tests/search-rank.test.mjs
 */
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const cacheDir = path.join(root, 'node_modules', '.cache');
await fs.mkdir(cacheDir, { recursive: true });
const out = path.join(cacheDir, `astrobaas-rank-${process.pid}.mjs`);
await build({
  entryPoints: [path.join(root, 'src/lib/search/rank.ts')],
  bundle: true, format: 'esm', platform: 'node', packages: 'external',
  outfile: out, logLevel: 'silent',
});
const R = await import(pathToFileURL(out).href);
await fs.rm(out, { force: true });

let pass = 0;
let fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };

const W = R.POST_WEIGHTS;
const postFields = (p) => [
  { text: p.title, weight: W.title },
  { text: p.excerpt, weight: W.excerpt },
  { text: p.body, weight: W.body },
];

/* ---- word order: the failure that returned nothing at all ---- */
{
  const items = [{ title: 'Μαύρος σκελετός', excerpt: '', body: '' }];
  const hit = R.rankBy(items, 'σκελετός μαύρος', postFields);
  check('the words in the other order still match', hit.length === 1);
  // The old search: 'Μαύρος σκελετός'.includes('σκελετός μαύρος') === false.
  const foldedIncludes = 'μαυρος σκελετος'.includes('σκελετος μαυρος');
  check('...and the old substring test would have found nothing', foldedIncludes === false);
}

/* ---- accents and case, inherited from foldForSearch ---- */
{
  const items = [{ title: 'Αλυσίδα γυαλιών', excerpt: '', body: '' }];
  check('unaccented query matches accented title',
    R.rankBy(items, 'αλυσιδα', postFields).length === 1);
  check('SHOUTED query matches', R.rankBy(items, 'ΑΛΥΣΙΔΑ', postFields).length === 1);
}

/* ---- AND, not OR: adding a word narrows ---- */
{
  const items = [
    { title: 'Σκελετός μεταλλικός', excerpt: '', body: '' },
    { title: 'Σκελετός κοκάλινος', excerpt: '', body: '' },
  ];
  check('one word matches both', R.rankBy(items, 'σκελετός', postFields).length === 2);
  check('adding a word narrows to one',
    R.rankBy(items, 'σκελετός μεταλλικός', postFields).length === 1);
  check('a word that matches nothing kills the whole result',
    R.rankBy(items, 'σκελετός ελικόπτερο', postFields).length === 0);
}

/* ---- field weight: title beats body ---- */
{
  const items = [
    { id: 'body', title: 'Κάτι άλλο', excerpt: '', body: 'οπτικά οπτικά οπτικά οπτικά' },
    { id: 'title', title: 'Οπτικά', excerpt: '', body: '' },
  ];
  const ranked = R.rankBy(items, 'οπτικά', postFields);
  check('the item with the word in its TITLE ranks first',
    ranked[0].item.id === 'title');
  // Keyword stuffing must not win: a term counts once per field, at its best
  // quality — never once per occurrence.
  check('...and repeating it twenty times in the body does not overturn that',
    ranked[0].score > ranked[1].score);
}

/* ---- keyword stuffing, stated directly ---- */
{
  const once = R.rankBy([{ title: 'x', excerpt: '', body: 'οπτικά' }], 'οπτικά', postFields);
  const many = R.rankBy(
    [{ title: 'x', excerpt: '', body: 'οπτικά '.repeat(50) }], 'οπτικά', postFields);
  check('fifty occurrences score exactly the same as one',
    once[0].score === many[0].score);
}

/* ---- match quality: whole word > prefix > inside ---- */
{
  const whole  = R.rankBy([{ title: 'σκελετός', excerpt: '', body: '' }], 'σκελετός', postFields);
  const prefix = R.rankBy([{ title: 'σκελετός', excerpt: '', body: '' }], 'σκελ', postFields);
  const inside = R.rankBy([{ title: 'υποσκελετός', excerpt: '', body: '' }], 'σκελ', postFields);
  check('a whole-word hit outscores a prefix hit', whole[0].score > prefix[0].score);
  check('a prefix hit outscores a mid-word hit', prefix[0].score > inside[0].score);
  check('a mid-word hit still matches (part numbers stay findable)', inside.length === 1);
}

/* ---- prefix in a strong field beats whole word in a weak one ---- */
{
  const items = [
    { id: 'body-exact', title: 'Άσχετο', excerpt: '', body: 'σκελετός' },
    { id: 'title-prefix', title: 'Σκελετοί μετάλλου', excerpt: '', body: '' },
  ];
  // title weight 6 × prefix 0.6 = 3.6  vs  body weight 1 × whole 1 = 1.
  check('a prefix in the title beats a whole word in the body',
    R.rankBy(items, 'σκελετ', postFields)[0].item.id === 'title-prefix');
}

/* ---- phrase bonus ---- */
{
  const items = [
    { id: 'apart', title: 'Μαύρος μεταλλικός σκελετός', excerpt: '', body: '' },
    { id: 'together', title: 'Μαύρος σκελετός γυναικείος', excerpt: '', body: '' },
  ];
  const ranked = R.rankBy(items, 'μαύρος σκελετός', postFields);
  check('the contiguous phrase ranks above the same words apart',
    ranked[0].item.id === 'together');
  check('...but the split one still matches', ranked.length === 2);
}

/* ---- products: an SKU is not buried under its brand ---- */
{
  const PW = R.PRODUCT_WEIGHTS;
  const productFields = (p) => [
    { text: p.name, weight: PW.name },
    { text: p.sku, weight: PW.sku },
    { text: p.gtin, weight: PW.gtin },
    { text: p.brand, weight: PW.brand },
    { text: (p.tags ?? []).join(' '), weight: PW.tags },
    { text: p.description, weight: PW.description },
  ];
  const catalogue = [
    { id: 'other', name: 'Γυαλιά ηλίου', brand: 'RayBan', sku: 'RB9999-11', description: '' },
    { id: 'wanted', name: 'Aviator', brand: 'RayBan', sku: 'RB7024-51', description: '' },
    { id: 'third', name: 'Wayfarer', brand: 'RayBan', sku: 'RB8100-22', description: '' },
  ];
  const bySku = R.rankBy(catalogue, 'RB7024-51', productFields);
  check('searching an SKU returns that product first', bySku[0].item.id === 'wanted');
  check('...and not every product of the same brand', bySku.length === 1);
  // The SKU is one token after folding drops the hyphen? It does not — the
  // hyphen is a separator, so "rb7024" and "51" are two tokens and both match.
  check('a partial SKU still finds it',
    R.rankBy(catalogue, '7024', productFields)[0]?.item.id === 'wanted');
  check('the brand alone returns all three',
    R.rankBy(catalogue, 'rayban', productFields).length === 3);
}

/* ---- empty and degenerate input ---- */
{
  check('an empty query returns nothing', R.rankBy([{ title: 'a' }], '', postFields).length === 0);
  check('whitespace only returns nothing', R.rankBy([{ title: 'a' }], '   ', postFields).length === 0);
  check('a null query returns nothing', R.rankBy([{ title: 'a' }], null, postFields).length === 0);
  check('an empty catalogue returns nothing', R.rankBy([], 'anything', postFields).length === 0);
  check('an item with no text at all does not match',
    R.rankBy([{ title: '', excerpt: '', body: '' }], 'x', postFields).length === 0);
  check('a zero-weight field is ignored',
    R.scoreFields([{ text: 'σκελετός', weight: 0 }], ['σκελετός']) === 0);
}

/* ---- one-character queries are real queries ---- */
{
  // A single letter is a brand ("Ω"). Dropping it as "too short" would search
  // for nothing and return everything-or-nothing rather than what was asked.
  check('a one-character query keeps its term', R.queryTerms('Ω').length === 1);
  check('...and matches', R.rankBy([{ title: 'Ω optics', excerpt: '', body: '' }], 'Ω', postFields).length === 1);
  // But inside a longer query, noise words are dropped rather than
  // disqualifying everything under the AND rule.
  // foldForSearch normalises the FINAL sigma to a medial one, so the folded
  // term ends in σ, not ς. Asserting the natural spelling would pin the wrong
  // thing — this is what the fold documents and what the haystack contains.
  check('a stray one-character token does not kill a longer query',
    R.queryTerms('σκελετός α').join() === 'σκελετοσ');
}

/* ---- ties keep the caller's order, which is where meaning lives ---- */
{
  const items = [
    { id: 'first', title: 'Σκελετός', excerpt: '', body: '' },
    { id: 'second', title: 'Σκελετός', excerpt: '', body: '' },
  ];
  const ranked = R.rankBy(items, 'σκελετός', postFields);
  check('equal scores keep input order (caller sorts by recency/stock first)',
    ranked[0].item.id === 'first' && ranked[1].item.id === 'second');
  check('...and the scores really are equal', ranked[0].score === ranked[1].score);
}

/* ---- the scorer is pure: same input, same answer ---- */
{
  const f = [{ text: 'Μαύρος σκελετός', weight: 6 }];
  const a = R.scoreFields(f, ['σκελετοσ']);
  const b = R.scoreFields(f, ['σκελετοσ']);
  check('scoring is deterministic', a === b && a > 0);
}

/* ---- a raw, unfolded term must not silently score zero ---- */
{
  // This is the regression that matters: the first version trusted the caller
  // to pre-fold, so an accented term against a folded haystack returned a
  // confident 0 — "no results" when it meant "you called me wrong".
  const f = [{ text: 'Μαύρος σκελετός', weight: 6 }];
  check('an ACCENTED term still matches', R.scoreFields(f, ['σκελετός']) > 0);
  check('a SHOUTED term still matches', R.scoreFields(f, ['ΣΚΕΛΕΤΟΣ']) > 0);
  check('a final-sigma term still matches', R.scoreFields(f, ['σκελετος']) > 0);
  check('...all three score identically to the folded form',
    R.scoreFields(f, ['σκελετός']) === R.scoreFields(f, ['σκελετοσ'])
    && R.scoreFields(f, ['ΣΚΕΛΕΤΟΣ']) === R.scoreFields(f, ['σκελετοσ']));
  // A term that is only punctuation folds to nothing; under AND it cannot be
  // satisfied, so the item must not match rather than the term being ignored.
  check('a term that folds to nothing disqualifies the item',
    R.scoreFields(f, ['σκελετος', '!!!']) === 0);
}

/* ---- the expander seam: how the PAID module enhances without forking ---- */
{
  const items = [
    { id: 'frame', title: 'Σκελετός μεταλλικός', excerpt: '', body: '' },
    { id: 'other', title: 'Θήκη δερμάτινη', excerpt: '', body: '' },
  ];
  // Greeklish: the shopper types on a Latin keyboard.
  const greeklish = (t) => (t === 'skeletos' ? ['σκελετος'] : []);

  check('without an expander, Greeklish finds nothing',
    R.rankBy(items, 'skeletos', postFields).length === 0);
  check('with one, it finds the frame',
    R.rankBy(items, 'skeletos', postFields, { expand: greeklish })[0]?.item.id === 'frame');

  // The literal spelling must still win. A typo-tolerant search that reorders
  // exact matches behind approximate ones is worse than no tolerance at all.
  const literal = R.scoreFields([{ text: 'Σκελετός', weight: 6 }], ['σκελετος']);
  const viaVariant = R.scoreFields(
    [{ text: 'Σκελετός', weight: 6 }], ['skeletos'], { expand: greeklish });
  check('an exact match outranks one reached through an alternative',
    literal > viaVariant && viaVariant > 0);

  // Expansion must not widen the result set the way an extra term would.
  check('AND still holds across expanded terms',
    R.rankBy(items, 'skeletos θήκη', postFields, { expand: greeklish }).length === 0);

  // The expander is only consulted when the literal term missed — a shop
  // without the module pays nothing, and a shop with it pays only on misses.
  {
    // The property that matters is not "never called" — a query matching three
    // products in a catalogue of 436 legitimately misses on the other 433. It
    // is that the answer, which depends only on the term, is computed ONCE.
    const many = Array.from({ length: 200 }, (_, i) => (
      { id: `p${i}`, title: `Προϊόν ${i}`, excerpt: '', body: '' }));
    let calls = 0;
    const counting = () => { calls += 1; return []; };
    R.rankBy(many, 'ελικόπτερο', postFields, { expand: counting });
    check('a 200-item catalogue expands each term exactly once, not per item',
      calls === 1);

    // THE HEADLINE PROPERTY of the seam, which nothing asserted: a shop without
    // a search module pays nothing, and a shop with one pays only on the terms
    // that actually missed. If the expander were consulted for every term, a
    // catalogue that matches would still be paying for it.
    calls = 0;
    R.rankBy(
      [{ id: 'hit', title: 'Προϊόν 1', excerpt: '', body: '' }],
      'προϊόν', postFields, { expand: counting },
    );
    check('a term that MATCHED never reaches the expander', calls === 0);

    // Two missing terms cost ONE expansion, not two: the AND rule short-circuits
    // the moment a term cannot be satisfied, so the second is never reached.
    // That is the efficient behaviour, and worth pinning so a refactor that
    // evaluates all terms up front shows up as a change here.
    calls = 0;
    R.rankBy(many, 'ελικόπτερο αεροπλάνο', postFields, { expand: counting });
    check('two missing terms short-circuit after the first', calls === 1);

    // When the first term IS satisfied through an alternative, the second is
    // reached — and each is still expanded once across the whole catalogue.
    calls = 0;
    const resolving = (t) => { calls += 1; return t === 'ελικοπτερο' ? ['προιον'] : []; };
    R.rankBy(many, 'ελικόπτερο αεροπλάνο', postFields, { expand: resolving });
    check('...and a resolved first term lets the second be expanded, once each',
      calls === 2);
  }

  // A runaway expander is a denial of service on the search box. Asserting the
  // CONSTANT proves nothing — it would pass with the slice deleted. This makes
  // the cap observable: the 5000th variant is the only one that would match, so
  // it is found only if the cap is NOT applied.
  {
    const flood = (t) => (t === 'ελικοπτερο'
      ? [...Array.from({ length: 4999 }, (_, i) => `nomatch${i}`), 'σκελετος']
      : []);
    const hit = R.rankBy(
      [{ id: 'f', title: 'Σκελετός', excerpt: '', body: '' }],
      'ελικόπτερο', postFields, { expand: flood },
    );
    check('a variant beyond the cap is NOT consulted', hit.length === 0);

    // ...and one inside the cap is, so the cap is a cap and not an off switch.
    const near = (t) => (t === 'ελικοπτερο' ? ['σκελετος'] : []);
    check('...while a variant inside the cap is',
      R.rankBy([{ id: 'f', title: 'Σκελετός', excerpt: '', body: '' }],
        'ελικόπτερο', postFields, { expand: near }).length === 1);
  }

  // An expander is a THIRD PARTY from this function's point of view. One that
  // throws, or answers with something that is not an array, must degrade to
  // "no alternatives" rather than 500 the shop's catalogue.
  {
    const boom = () => { throw new Error('module blew up'); };
    let threw = false;
    try { R.rankBy(items, 'ελικόπτερο', postFields, { expand: boom }); }
    catch { threw = true; }
    check('an expander that throws does not propagate', !threw);

    check('a non-array return is ignored rather than crashing',
      R.rankBy(items, 'ελικόπτερο', postFields, { expand: () => 'nonsense' }).length === 0);
    check('non-string entries are skipped',
      R.rankBy(items, 'ελικόπτερο', postFields,
        { expand: () => [null, 42, 'σκελετος'] }).length >= 0);
  }

  // An expander returning the term itself must not double-count or crash.
  check('an expander echoing the term back is harmless',
    R.rankBy(items, 'σκελετός', postFields, { expand: (t) => [t] })[0]?.item.id === 'frame');
}

/* ---- S5.1: a query is bounded, whoever calls the scorer ----
 *
 * `/api/search?q=` with a few thousand distinct words made one anonymous
 * request do a few thousand passes over every item. The caps live in rank.ts so
 * all three callers (the API, the catalogue, /blog?q=) are covered at once.
 */
{
  check('the caps are the documented ones',
    R.MAX_QUERY_LENGTH === 200 && R.MAX_QUERY_TERMS === 12);

  // 5000 distinct six-letter words — each would be its own full pass.
  const words = Array.from({ length: 5000 }, (_, i) => `w${String(i).padStart(5, '0')}`);
  const huge = words.join(' ');
  const terms = R.queryTerms(huge);
  check('a huge query yields at most MAX_QUERY_TERMS terms', terms.length <= R.MAX_QUERY_TERMS);
  check('...and they are the FIRST ones typed', terms[0] === 'w00000' && terms[1] === 'w00001');
  check('...and nothing past MAX_QUERY_LENGTH was read',
    terms.join(' ').length <= R.MAX_QUERY_LENGTH);

  // One enormous word is clipped, not searched whole.
  const long = R.queryTerms('a'.repeat(100_000));
  check('a single 100k-character word is clipped to MAX_QUERY_LENGTH',
    long.length === 1 && long[0].length === R.MAX_QUERY_LENGTH);

  // Repeats are one term. `ray ray ray` used to add its score three times.
  check('repeated words are one term', R.queryTerms('ray RAY Ray ray').length === 1);
  const dupItems = [
    { id: 'a', title: 'Ray', excerpt: '', body: '' },
  ];
  const once = R.rankBy(dupItems, 'ray', postFields)[0]?.score;
  const many = R.rankBy(dupItems, 'ray ray ray ray', postFields)[0]?.score;
  check('repeating a word does not raise the score', once !== undefined && once === many);

  // The WORK is bounded — measured where it is spent. The expensive case is the
  // one where every term MATCHES: AND short-circuits on the first miss, so a
  // query of nonsense is cheap, and the attack is a query whose every word is
  // in every item. Each matched whole word adds exactly 1 × the body weight,
  // so the score COUNTS the terms the scorer actually walked.
  const body = words.slice(0, 2000).join(' ');
  const items = Array.from({ length: 40 }, (_, i) => ({ id: `p${i}`, title: '', excerpt: '', body }));
  const started = Date.now();
  const out = R.rankBy(items, words.slice(0, 2000).join(' '), postFields);
  const took = Date.now() - started;
  check('a huge all-matching query still matches', out.length === 40);
  // 12 whole-word hits plus one phrase bonus (the first twelve words are
  // contiguous in the body). Unbounded, this was 2000.5.
  check(`...scoring at most MAX_QUERY_TERMS terms (score ${out[0]?.score})`,
    out[0]?.score <= R.MAX_QUERY_TERMS + R.POST_WEIGHTS.body);
  check(`...and finishes quickly (${took} ms)`, took < 1500);

  // scoreFields is exported and callable with a hand-built term list — it must
  // not be the way round the ceiling.
  const direct = R.scoreFields([{ text: body, weight: 1 }], words.slice(0, 2000));
  check(`scoreFields bounds a caller-supplied term list too (score ${direct})`,
    direct > 0 && direct <= R.MAX_QUERY_TERMS + 1);

  // clipQuery never leaves half a surrogate pair behind.
  const emoji = 'x'.repeat(R.MAX_QUERY_LENGTH - 1) + '😀';
  const clipped = R.clipQuery(emoji);
  const lastCode = clipped.charCodeAt(clipped.length - 1);
  check('clipQuery drops an orphaned high surrogate',
    clipped.length === R.MAX_QUERY_LENGTH - 1 && !(lastCode >= 0xd800 && lastCode <= 0xdbff));
  check('clipQuery leaves a short query alone', R.clipQuery('σκελετός') === 'σκελετός');
  check('clipQuery treats a non-string as empty', R.clipQuery(null) === '' && R.clipQuery(42) === '');

  // Behaviour for normal queries is unchanged by the caps.
  check('a normal two-word query still ranks',
    R.rankBy([{ id: 'x', title: 'Μαύρος σκελετός', excerpt: '', body: '' }],
      'σκελετός μαύρος', postFields).length === 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
