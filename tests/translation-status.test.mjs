#!/usr/bin/env node
/**
 * The translation status calculation (src/lib/i18n/status.ts).
 *
 * A multilingual site has TWO translation models — one record per language for
 * content, one record with a sidecar for the catalogue — and an operator has
 * to answer one question across both: what is missing in German?
 *
 * The numbers on that screen are the thing somebody acts on, so the awkward
 * cases are pinned here rather than eyeballed:
 *
 *   · an article written directly in German is not an English gap;
 *   · a record with no `translation_of` is its own set, which is what a site
 *     that has never been translated looks like;
 *   · a product with a German NAME and an English DESCRIPTION reads as
 *     translated to every check that only looks for the locale key — and
 *     ships a German page with English body text.
 *
 * Run with:  node tests/translation-status.test.mjs
 */
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const cacheDir = path.join(root, 'node_modules', '.cache');
await fs.mkdir(cacheDir, { recursive: true });
const out = path.join(cacheDir, `astrobaas-tstatus-${process.pid}.mjs`);
await build({
  entryPoints: [path.join(root, 'src/lib/i18n/status.ts')],
  bundle: true, format: 'esm', platform: 'node', packages: 'external',
  outfile: out, logLevel: 'silent',
});
const S = await import(pathToFileURL(out).href);
await fs.rm(out, { force: true });

let pass = 0;
let fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };

const LOCALES = ['en', 'el', 'de'];
const gapFor = (gaps, locale) => gaps.find((g) => g.locale === locale);

/* ---- content: one record per language ---- */
{
  const posts = [
    // Translated into Greek only.
    { id: 'p1', title: 'Frames', locale: 'en' },
    { id: 'p1-el', title: 'Σκελετοί', locale: 'el', translation_of: 'p1' },
    // Not translated at all.
    { id: 'p2', title: 'Lenses', locale: 'en' },
    // Written directly in German. NOT an English backlog item.
    { id: 'p3', title: 'Nur auf Deutsch', locale: 'de' },
  ];
  const gaps = S.postGaps(posts, LOCALES, 'en');

  check('the default locale is not reported as a gap against itself',
    !gaps.some((g) => g.locale === 'en'));
  check('every other locale is reported', gaps.length === 2);

  const el = gapFor(gaps, 'el');
  check('Greek has one translated and one missing', el.present === 1 && el.missing === 1);
  check('...and the missing one is named', el.examples[0]?.title === 'Lenses');
  check('...with a percentage a human can read', el.percent === 50);

  const de = gapFor(gaps, 'de');
  // The German-original article is its own set with no English record, so it
  // is not counted at all. Counting it would show a backlog that is not there.
  check('an article written directly in German is not an English gap',
    de.missing === 2 && de.present === 0);
  check('...and the German original is not itself listed as missing',
    !de.examples.some((e) => e.title === 'Nur auf Deutsch'));
}

/* ---- a site that has never been translated ---- */
{
  const posts = [
    { id: 'a', title: 'One', locale: 'en' },
    { id: 'b', title: 'Two', locale: 'en' },
    // No `locale` at all — a record written before the site was multilingual.
    { id: 'c', title: 'Three' },
  ];
  const gaps = S.postGaps(posts, LOCALES, 'en');
  check('a record with no locale counts as the default one', gapFor(gaps, 'el').missing === 3);
  check('...and nothing is reported as translated', gapFor(gaps, 'el').present === 0);
  check('...at zero percent', gapFor(gaps, 'el').percent === 0);
  check('examples are capped so the screen stays readable',
    gapFor(gaps, 'el').examples.length <= 8);
}

/* ---- the cap actually bites (more than 8 missing) ---- */
{
  const many = [];
  for (let i = 0; i < 20; i += 1) many.push({ id: `m${i}`, title: `Post ${i}`, locale: 'en' });
  const gaps = S.postGaps(many, LOCALES, 'en');
  const el = gapFor(gaps, 'el');
  check('with 20 missing, exactly 8 examples are shown', el.examples.length === 8);
  check('...but the missing COUNT is the true total', el.missing === 20);
}

/* ---- nothing to translate ---- */
{
  const gaps = S.postGaps([], LOCALES, 'en');
  // 100, not 0: an empty site is fully translated, and showing 0% would send
  // somebody looking for work that does not exist.
  check('an empty site reads as 100%, not 0%', gapFor(gaps, 'el').percent === 100);
  check('...with nothing missing', gapFor(gaps, 'el').missing === 0);
}

/* ---- status: trashed and draft records are not backlog ---- */
{
  const posts = [
    { id: 'p1', title: 'Live', locale: 'en', status: 'published' },
    // A TRASHED German translation must NOT report German as done.
    { id: 'p1-de', title: 'Müll', locale: 'de', translation_of: 'p1', status: 'trash' },
    // A draft English original is not something to translate yet.
    { id: 'p2', title: 'Draft', locale: 'en', status: 'draft' },
  ];
  const gaps = S.postGaps(posts, LOCALES, 'en');
  const de = gapFor(gaps, 'de');
  check('a trashed translation does NOT satisfy its language', de.missing === 1 && de.present === 0);
  check('a draft original is not counted as backlog', de.missing === 1);
}

/* ---- a chained translation_of set resolves to one root ---- */
{
  const posts = [
    { id: 'en1', title: 'Original', locale: 'en' },
    { id: 'el1', title: 'Greek', locale: 'el', translation_of: 'en1' },
    // de points at the EL record, not the EN root — a chain.
    { id: 'de1', title: 'German', locale: 'de', translation_of: 'el1' },
  ];
  const gaps = S.postGaps(posts, LOCALES, 'en');
  check('a chained translation counts its language as present, not missing',
    gapFor(gaps, 'de').present === 1 && gapFor(gaps, 'de').missing === 0);
  check('...and the whole set is one, not three', gapFor(gaps, 'el').present === 1);
}

/* ---- percent never rounds UP to a false 100 ---- */
{
  const posts = [];
  for (let i = 0; i < 200; i += 1) {
    posts.push({ id: `en${i}`, title: `P${i}`, locale: 'en' });
    if (i < 199) posts.push({ id: `el${i}`, title: `P${i} el`, locale: 'el', translation_of: `en${i}` });
  }
  const el = gapFor(S.postGaps(posts, LOCALES, 'en'), 'el');
  check('199/200 reads 99%, not a rounded-up 100', el.percent === 99 && el.missing === 1);
  const done = gapFor(S.postGaps(
    [{ id: 'a', locale: 'en' }, { id: 'a-el', locale: 'el', translation_of: 'a' }], LOCALES, 'en'), 'el');
  check('a genuinely complete set reads 100', done.percent === 100);
}

/* ---- the catalogue: one record with a sidecar ---- */
{
  const products = [
    { id: 'x', name: 'Titanium frame', i18n: { el: { name: 'Σκελετός τιτανίου' } } },
    { id: 'y', name: 'Lens cloth' },
    { id: 'z', name: 'Case', i18n: { el: { name: 'Θήκη' }, de: { name: 'Etui' } } },
  ];
  const gaps = S.catalogueGaps(products, LOCALES, 'en');
  const el = gapFor(gaps, 'el');
  const de = gapFor(gaps, 'de');
  check('a product with a Greek sidecar counts as present', el.present === 2);
  check('...and one without is missing', el.missing === 1 && el.examples[0]?.title === 'Lens cloth');
  check('German is counted separately', de.present === 1 && de.missing === 2);
  // Floors toward not-done: 2/3 is 66 (not a rounded 67), 1/3 is 33.
  check('the percentage is per locale and floored', el.percent === 66 && de.percent === 33);
}

/* ---- the silent one: part-translated ---- */
{
  const FIELDS = ['name', 'description', 'short_description'];
  const products = [
    {
      // The failure this exists for: a German name over an English
      // description. Every check that looks only for the locale KEY reports
      // this as translated.
      id: 'half', name: 'Titanium frame', description: 'Light and strong.',
      i18n: { de: { name: 'Titanrahmen' } },
    },
    {
      id: 'whole', name: 'Case', description: 'Hard shell.',
      i18n: { de: { name: 'Etui', description: 'Hartschale.' } },
    },
    {
      // No German at all: a whole-record gap, reported by catalogueGaps, and
      // NOT double-counted here.
      id: 'none', name: 'Cloth', description: 'Microfibre.',
    },
    {
      // No description in the source either, so there is no German one to
      // miss. Reporting this would send somebody to translate a blank field.
      id: 'sparse', name: 'Screws', i18n: { de: { name: 'Schrauben' } },
    },
    {
      // An empty string is not a translation.
      id: 'blank', name: 'Cord', description: 'Braided.',
      i18n: { de: { name: 'Kordel', description: '   ' } },
    },
  ];
  const partial = S.partialTranslations(products, LOCALES, 'en', FIELDS);
  const ids = partial.map((p) => p.id).sort();

  check('a record with a translated name and an untranslated description is flagged',
    ids.includes('half'));
  check('...naming the field that is missing',
    partial.find((p) => p.id === 'half')?.missingFields.join() === 'description');
  check('a fully translated record is not flagged', !ids.includes('whole'));
  check('a record with NO translation is not double-counted here', !ids.includes('none'));
  check('a field the source does not have is not reported as missing', !ids.includes('sparse'));
  check('whitespace is not a translation', ids.includes('blank'));
  check('the locale is named, so the screen can group by it',
    partial.every((p) => p.locale === 'de'));
  check('the default locale is never reported as partial',
    !partial.some((p) => p.locale === 'en'));
}

/* ---- one locale configured ---- */
{
  check('a single-language site has no gaps at all',
    S.postGaps([{ id: 'a', title: 'One', locale: 'en' }], ['en'], 'en').length === 0);
  check('...and no catalogue gaps either',
    S.catalogueGaps([{ id: 'x', name: 'A' }], ['en'], 'en').length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
