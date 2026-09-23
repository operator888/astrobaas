#!/usr/bin/env node
/**
 * Locale configuration + content filtering (src/lib/i18n.ts).
 *
 * The property that matters most here: an install that never sets SITE_LOCALES
 * must behave EXACTLY as it did before i18n existed — same URLs, same posts, no
 * locale UI. Several cases below exist purely to pin that down.
 *
 * Run with:  node tests/i18n.test.mjs
 */
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cacheDir = path.join(here, '..', 'node_modules', '.cache');
await fs.mkdir(cacheDir, { recursive: true });

const tmp = path.join(cacheDir, `astrobaas-i18n-${process.pid}.mjs`);
await build({
  entryPoints: [path.join(here, '..', 'src/lib/i18n.ts')],
  bundle: true, format: 'esm', platform: 'node', packages: 'external',
  outfile: tmp, logLevel: 'silent',
});
const {
  parseLocaleList, locales, defaultLocale, isMultilingual, isKnownLocale,
  normalizeLocale, recordLocale, filterByLocale, splitLocaleFromPath,
} = await import(pathToFileURL(tmp).href);
await fs.rm(tmp, { force: true });

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) pass++;
  else {
    fail++;
    console.error(`✗ ${name}`);
  }
}

const multi = { SITE_LOCALES: 'en,de,fr' };
const withDefault = { SITE_LOCALES: 'en,de,fr', SITE_DEFAULT_LOCALE: 'de' };

// ---- parsing ----
{
  check('parses a comma list', JSON.stringify(parseLocaleList('en,de,fr')) === JSON.stringify(['en', 'de', 'fr']));
  check('parses whitespace + mixed separators', JSON.stringify(parseLocaleList(' en , de   fr ')) === JSON.stringify(['en', 'de', 'fr']));
  check('accepts region subtags', JSON.stringify(parseLocaleList('en,pt-BR')) === JSON.stringify(['en', 'pt-BR']));
  check('drops invalid entries', JSON.stringify(parseLocaleList('en,,../etc/passwd,de,<script>')) === JSON.stringify(['en', 'de']));
  check('dedupes', JSON.stringify(parseLocaleList('en,en,de')) === JSON.stringify(['en', 'de']));
  check('empty input → empty list', parseLocaleList(undefined).length === 0 && parseLocaleList('').length === 0);
}

// ---- single-locale (unconfigured) must be a no-op ----
{
  check('unset SITE_LOCALES → ["en"]', JSON.stringify(locales({})) === JSON.stringify(['en']));
  check('unset → default "en"', defaultLocale({}) === 'en');
  check('unset → NOT multilingual', isMultilingual({}) === false);
  check('unset → a /de/ path is NOT treated as a locale prefix', splitLocaleFromPath('/de/blog', {}).prefixed === false);
  check('single configured locale is still not multilingual', isMultilingual({ SITE_LOCALES: 'en' }) === false);
}

// ---- multi-locale ----
{
  check('reads the configured list', JSON.stringify(locales(multi)) === JSON.stringify(['en', 'de', 'fr']));
  check('default is the first entry', defaultLocale(multi) === 'en');
  check('SITE_DEFAULT_LOCALE overrides', defaultLocale(withDefault) === 'de');
  check('an unlisted SITE_DEFAULT_LOCALE is ignored', defaultLocale({ SITE_LOCALES: 'en,de', SITE_DEFAULT_LOCALE: 'zz' }) === 'en');
  check('is multilingual', isMultilingual(multi) === true);

  // Path prefixes
  const de = splitLocaleFromPath('/de/blog', multi);
  check('strips a known non-default locale prefix', de.locale === 'de' && de.rest === '/blog' && de.prefixed === true);
  check('bare /de → /', JSON.stringify(splitLocaleFromPath('/de', multi)) === JSON.stringify({ locale: 'de', rest: '/', prefixed: true }));
  check('default locale is NOT a prefix (existing URLs keep working)', splitLocaleFromPath('/en/blog', multi).prefixed === false);
  check('unprefixed path keeps the default locale', JSON.stringify(splitLocaleFromPath('/blog', multi)) === JSON.stringify({ locale: 'en', rest: '/blog', prefixed: false }));
  check('an unknown first segment is left alone', splitLocaleFromPath('/deutsch/blog', multi).prefixed === false && splitLocaleFromPath('/zz/x', multi).prefixed === false);
  check('root path is unprefixed', splitLocaleFromPath('/', multi).prefixed === false);
  check('nested path keeps its remainder', splitLocaleFromPath('/fr/blog/hello-world', multi).rest === '/blog/hello-world');
}

// ---- untrusted input ----
{
  check('isKnownLocale accepts configured', isKnownLocale('de', multi) === true);
  check('isKnownLocale rejects unconfigured', isKnownLocale('zz', multi) === false);
  check('isKnownLocale rejects non-strings', !isKnownLocale(null, multi) && !isKnownLocale(42, multi) && !isKnownLocale({}, multi));
  check('normalizeLocale passes through a known locale', normalizeLocale('fr', multi) === 'fr');
  check('normalizeLocale falls back for garbage', normalizeLocale('../../etc', multi) === 'en' && normalizeLocale(undefined, multi) === 'en');
}

// ---- record locale + filtering ----
{
  const posts = [
    { id: '1', locale: 'en' },
    { id: '2', locale: 'de' },
    { id: '3' },              // pre-i18n record: counts as default
    { id: '4', locale: 'zz' }, // stale/unconfigured: counts as default
  ];
  check('recordLocale reads a valid locale', recordLocale({ locale: 'de' }, multi) === 'de');
  check('recordLocale treats a missing locale as default', recordLocale({}, multi) === 'en');
  check('recordLocale treats an unconfigured locale as default', recordLocale({ locale: 'zz' }, multi) === 'en');
  check('recordLocale handles null/undefined', recordLocale(null, multi) === 'en' && recordLocale(undefined, multi) === 'en');

  const en = filterByLocale(posts, 'en', multi).map((p) => p.id);
  check('filtering en includes legacy + unconfigured records', JSON.stringify(en) === JSON.stringify(['1', '3', '4']));
  check('filtering de is exact', JSON.stringify(filterByLocale(posts, 'de', multi).map((p) => p.id)) === JSON.stringify(['2']));
  check('filtering an unused locale yields none', filterByLocale(posts, 'fr', multi).length === 0);

  // The no-op property: with i18n unconfigured, every post is visible.
  check('single-locale install sees ALL posts', filterByLocale(posts, defaultLocale({}), {}).length === posts.length);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
