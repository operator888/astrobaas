#!/usr/bin/env node
/**
 * Catalogue translations.
 *
 * Two shops are live with 436 products and real order history, so the rules
 * that matter most are the ones about NOT breaking them:
 *
 *   1. no `?locale=` → byte-identical output to before this existed
 *   2. a partly-translated record falls back FIELD BY FIELD, never to empty
 *   3. an incoming translation cannot get past a rule the base field enforces
 *
 * Run with:  node tests/catalogue-i18n.test.mjs
 */
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cacheDir = path.join(here, '..', 'node_modules', '.cache');
await fs.mkdir(cacheDir, { recursive: true });
const out = path.join(cacheDir, `astrobaas-cat-i18n-${process.pid}.mjs`);
await build({
  entryPoints: [path.join(here, '..', 'src/lib/i18n/catalogue-translations.ts')],
  bundle: true, format: 'esm', platform: 'node', packages: 'external',
  outfile: out, logLevel: 'silent',
});
const C = await import(pathToFileURL(out).href);
await fs.rm(out, { force: true });

const {
  projectTranslations, projectAll, normaliseTranslations, translatedIn, searchableText,
  TRANSLATABLE_PRODUCT_FIELDS,
} = C;

let pass = 0, fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };

const F = TRANSLATABLE_PRODUCT_FIELDS;
const product = (over = {}) => ({
  id: 'p1', sku: 'SKU-1', stock: 5, price_cents: 8900, slug: 'frame-x',
  name: 'Frame X', description: '<p>An English description</p>',
  short_description: 'Short EN', purchase_note: 'Thanks',
  i18n: {
    de: { name: 'Fassung X', description: '<p>Eine deutsche Beschreibung</p>' },
    el: { name: 'Σκελετός Χ' },
  },
  ...over,
});

/* ================= projection ================= */
{
  // THE compatibility rule. Both live storefronts call this with no locale.
  const base = projectTranslations(product(), undefined, F);
  check('no locale returns the base text', base.name === 'Frame X');
  check('and strips the i18n sidecar, so the wire shape never changes', base.i18n === undefined);
  check('non-text fields are untouched',
    base.stock === 5 && base.price_cents === 8900 && base.sku === 'SKU-1');

  const de = projectTranslations(product(), 'de', F);
  check('a translated field is projected down', de.name === 'Fassung X');
  check('and so is a second one', de.description.includes('deutsche'));
  check('the sidecar is gone from the result too', de.i18n === undefined);
  check('identity fields are NEVER translated',
    de.id === 'p1' && de.sku === 'SKU-1' && de.slug === 'frame-x' && de.stock === 5);

  // The rule whose failure blanks a product name on a live shop.
  const el = projectTranslations(product(), 'el', F);
  check('a partly-translated locale gets its translated field', el.name === 'Σκελετός Χ');
  check('and the BASE value for what it has not translated',
    el.description === '<p>An English description</p>');
  check('never an empty string', el.short_description === 'Short EN');

  check('an unknown locale falls back entirely', projectTranslations(product(), 'fr', F).name === 'Frame X');
  check('an empty locale behaves like none', projectTranslations(product(), '', F).name === 'Frame X');
  check('locale matching is case-insensitive', projectTranslations(product(), 'DE', F).name === 'Fassung X');

  // A blank stored translation is an ABSENT one, not an empty one.
  const blanked = product({ i18n: { de: { name: '   ', description: 'ok' } } });
  check('a whitespace-only translation does not blank the base', projectTranslations(blanked, 'de', F).name === 'Frame X');
  check('while its sibling still projects', projectTranslations(blanked, 'de', F).description === 'ok');

  // A record with no translations at all must survive untouched.
  const plain = { id: 'p2', name: 'Plain' };
  check('a record with no i18n key is returned as-is', projectTranslations(plain, 'de', F).name === 'Plain');
  for (const bad of [null, undefined, 42, 'str']) {
    let threw = false;
    try { projectTranslations(bad, 'de', F); } catch { threw = true; }
    check(`a ${typeof bad} record does not throw`, !threw);
  }

  check('projectAll maps a list', projectAll([product(), product()], 'de', F).every((p) => p.name === 'Fassung X'));
  check('and an empty list is fine', projectAll([], 'de', F).length === 0);
}

/* ================= normalisation on the way IN ================= */
{
  const opts = {
    allowed: ['en', 'el', 'de'],
    fields: F,
    limits: { name: 200, description: 20000, short_description: 2000, purchase_note: 2000 },
    sanitize: (h) => String(h).replace(/<script[\s\S]*?<\/script>/gi, ''),
  };

  const clean = normaliseTranslations({ de: { name: 'Fassung' } }, opts);
  check('a good translation survives', clean.de.name === 'Fassung');

  // A locale the site does not serve must not be storable — otherwise the
  // catalogue grows languages nobody chose to offer.
  check('an unserved locale is dropped', normaliseTranslations({ fr: { name: 'x' } }, opts) === undefined);
  check('locale keys are lower-cased', normaliseTranslations({ DE: { name: 'x' } }, opts).de.name === 'x');

  // A field nobody translates must not become a back door for writing
  // arbitrary keys onto a product.
  const sneaky = normaliseTranslations({ de: { name: 'ok', price_cents: 1, stock: 999, id: 'other' } }, opts);
  check('a non-translatable field is dropped', sneaky.de.price_cents === undefined);
  check('...including stock', sneaky.de.stock === undefined);
  check('...and id', sneaky.de.id === undefined);
  check('while the real field stays', sneaky.de.name === 'ok');

  // The base fields sanitise HTML; a translation must not be the way around it.
  const xss = normaliseTranslations(
    { de: { description: '<p>ok</p><script>alert(1)</script>' } }, opts,
  );
  check('HTML is sanitised in a translated field', !xss.de.description.includes('<script>'));
  check('and the safe part survives', xss.de.description.includes('<p>ok</p>'));

  const long = normaliseTranslations({ de: { name: 'x'.repeat(500) } }, opts);
  check('a translated field obeys the base field limit', long.de.name.length === 200);

  check('a blank translation is not stored', normaliseTranslations({ de: { name: '   ' } }, opts) === undefined);
  check('an empty map is undefined, never {}', normaliseTranslations({}, opts) === undefined);
  for (const bad of [null, undefined, 'str', 42, [], [{ de: {} }]]) {
    check(`${JSON.stringify(bad) ?? 'undefined'} normalises to undefined`,
      normaliseTranslations(bad, opts) === undefined);
  }
  check('a non-object locale value is dropped', normaliseTranslations({ de: 'x' }, opts) === undefined);
  check('a non-string field value is dropped',
    normaliseTranslations({ de: { name: 42 } }, opts) === undefined);
}

/* ================= admin helpers ================= */
{
  check('translatedIn lists the locales', translatedIn(product()).join() === 'de,el');
  check('and is empty for an untranslated record', translatedIn({ id: 'x' }).length === 0);
  check('and survives nothing at all', translatedIn(null).length === 0);

  // Staff look a product up by whatever name they have to hand — often the one
  // the admin is NOT currently showing.
  const hay = searchableText(product(), F);
  check('search text spans every language', hay.includes('Frame X') && hay.includes('Fassung X') && hay.includes('Σκελετός Χ'));
  check('and survives a record with no translations', searchableText({ name: 'Only' }, F) === 'Only');
  check('and nothing at all', searchableText(null, F) === '');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
