#!/usr/bin/env node
/**
 * Locale-aware visible links (src/lib/locale-links.ts).
 *
 * The bug this module exists to prevent shipped once already and was invisible
 * on every single-language install: i18n reached the document head — canonical,
 * hreflang, sitemap, RSS — and nothing below it. A reader could get to
 * `/de/blog` only by typing it, and the first link they clicked dropped them
 * back into the default language.
 *
 * So the cases here are the ones a plausible implementation gets wrong:
 *
 *   · a record's link taking the READER's locale instead of the RECORD's;
 *   · a static route's link taking the record's locale instead of the reader's;
 *   · a switcher promising a translation that does not exist, and 404ing;
 *   · anything at all rendering on a single-language site.
 *
 * Run with:  node tests/locale-links.test.mjs
 */
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const cacheDir = path.join(root, 'node_modules', '.cache');
await fs.mkdir(cacheDir, { recursive: true });
const out = path.join(cacheDir, `astrobaas-locale-links-${process.pid}.mjs`);
await build({
  entryPoints: [path.join(root, 'src/lib/locale-links.ts')],
  bundle: true, format: 'esm', platform: 'node', packages: 'external',
  outfile: out, logLevel: 'silent',
});
const L = await import(pathToFileURL(out).href);

let passed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed += 1; }
  catch (err) { failures.push(`${name}: ${err.message}`); }
}
function eq(actual, expected, what = '') {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what} expected ${e}, got ${a}`);
}

/** A multilingual install: default `en`, plus `de` and `el`. */
const ML = { SITE_LOCALES: 'en,de,el', SITE_DEFAULT_LOCALE: 'en' };
/** The majority case: one language. */
const SL = { SITE_LOCALES: 'en', SITE_DEFAULT_LOCALE: 'en' };

const post = (id, over = {}) => ({
  id, slug: id, title: id, status: 'published', content: '', ...over,
});

// ---------------------------------------------------------------- routeHref

check('routeHref prefixes a non-default locale', () => {
  eq(L.routeHref('/blog', 'de', ML), '/de/blog');
  eq(L.routeHref('/about', 'el', ML), '/el/about');
});

check('routeHref leaves the DEFAULT locale unprefixed', () => {
  // This is what makes turning i18n on unable to break an existing URL. If it
  // ever prefixes the default, every link on every existing site 404s at once.
  eq(L.routeHref('/blog', 'en', ML), '/blog');
  eq(L.routeHref('/', 'en', ML), '/');
});

check('routeHref is inert on a single-language install', () => {
  eq(L.routeHref('/blog', 'de', SL), '/blog', 'unknown locale, single-language');
  eq(L.routeHref('/blog', undefined, SL), '/blog');
});

check('routeHref maps the site root to the bare prefix, not /de/', () => {
  // `/de/` and `/de` are different URLs to a crawler; the sitemap emits `/de`.
  eq(L.routeHref('/', 'de', ML), '/de');
});

// ----------------------------------------------------------------- postHref

check("postHref uses the RECORD's locale, not the reader's", () => {
  // The heart of it: a German article in a mixed listing must point at
  // /de/blog/..., because its slug is served under that prefix and no other.
  eq(L.postHref('/blog/x', { locale: 'de' }, ML), '/de/blog/x');
  eq(L.postHref('/blog/y', { locale: 'en' }, ML), '/blog/y');
});

check('postHref treats a record with NO locale as the default', () => {
  // Posts written before i18n existed have no `locale` field at all. Prefixing
  // them would move every URL on a site part-way through adopting i18n.
  eq(L.postHref('/blog/old', {}, ML), '/blog/old');
  eq(L.postHref('/blog/old', null, ML), '/blog/old');
  eq(L.postHref('/blog/old', undefined, ML), '/blog/old');
});

check('postHref ignores a locale the site does not have configured', () => {
  eq(L.postHref('/blog/x', { locale: 'fr' }, ML), '/blog/x');
});

// --------------------------------------------------------------- localeLabel

check('localeLabel names a language in its own language', () => {
  eq(L.localeLabel('de'), 'Deutsch');
  eq(L.localeLabel('el'), 'Ελληνικά');
});

check('localeLabel survives a malformed tag rather than throwing', () => {
  // A misconfigured SITE_LOCALES must not take the site header down.
  eq(L.localeLabel('not a tag'), 'NOT A TAG');
  eq(L.localeLabel(''), '');
});

// ----------------------------------------------------------- switcherOptions

check('switcherOptions renders NOTHING on a single-language install', () => {
  // The majority of installs. The component is placed unconditionally in three
  // headers, so an empty result here is what keeps it off those sites.
  eq(L.switcherOptions({ path: '/blog', current: 'en', env: SL }), []);
});

check('switcherOptions keeps the path on a STATIC route', () => {
  const opts = L.switcherOptions({ path: '/about', current: 'en', env: ML });
  eq(opts.map((o) => o.href), ['/about', '/de/about', '/el/about']);
  eq(opts.map((o) => o.locale), ['en', 'de', 'el']);
  eq(opts.map((o) => o.current), [true, false, false]);
  eq(opts.every((o) => o.translated), true, 'one template serves every locale');
});

check('switcherOptions marks the locale being read, whichever it is', () => {
  const opts = L.switcherOptions({ path: '/blog', current: 'el', env: ML });
  eq(opts.find((o) => o.current).locale, 'el');
  eq(opts.filter((o) => o.current).length, 1, 'exactly one current');
});

check('switcherOptions points at the actual TRANSLATION, with its own slug', () => {
  const en = post('en1', { slug: 'hello', locale: 'en' });
  const de = post('de1', { slug: 'hallo', locale: 'de', translation_of: 'en1' });
  const opts = L.switcherOptions({
    path: '/blog/hello', current: 'en', post: en, all: [en, de],
    pathFor: (p) => `/blog/${p.slug}`, env: ML,
  });
  const byLoc = Object.fromEntries(opts.map((o) => [o.locale, o]));
  eq(byLoc.de.href, '/de/blog/hallo', 'the German slug, not the English one');
  eq(byLoc.de.translated, true);
});

check('switcherOptions falls back to the locale HOME when no translation exists', () => {
  // The tempting bug: keep the path and change the prefix. `/el/blog/hello`
  // would 404 — the slug belongs to one record — so the reader is sent
  // somewhere real and told it is not a translation.
  const en = post('en1', { slug: 'hello', locale: 'en' });
  const de = post('de1', { slug: 'hallo', locale: 'de', translation_of: 'en1' });
  const opts = L.switcherOptions({
    path: '/blog/hello', current: 'en', post: en, all: [en, de],
    pathFor: (p) => `/blog/${p.slug}`, env: ML,
  });
  const el = opts.find((o) => o.locale === 'el');
  eq(el.href, '/el', 'the Greek home page');
  eq(el.translated, false, 'and it says so');
});

check('switcherOptions resolves a translation CHAIN, not just direct children', () => {
  // de → el → en. Starting from the German record, the English one is two hops
  // away; an implementation that only reads `translation_of` one level deep
  // offers the home page instead of the article.
  const en = post('en1', { slug: 'hello', locale: 'en' });
  const el = post('el1', { slug: 'geia', locale: 'el', translation_of: 'en1' });
  const de = post('de1', { slug: 'hallo', locale: 'de', translation_of: 'el1' });
  const opts = L.switcherOptions({
    path: '/blog/hallo', current: 'de', post: de, all: [en, el, de],
    pathFor: (p) => `/blog/${p.slug}`, env: ML,
  });
  const byLoc = Object.fromEntries(opts.map((o) => [o.locale, o]));
  eq(byLoc.en.href, '/blog/hello', 'two hops up the chain');
  eq(byLoc.el.href, '/el/blog/geia', 'the sibling, reached through the root');
});

check('switcherOptions terminates on a MUTUAL translation pair', () => {
  // a→b and b→a. No storage driver has a referential constraint on
  // `translation_of`, so an operator can create this from the admin screen; an
  // unguarded walk hangs the request.
  const a = post('a', { slug: 'a', locale: 'en', translation_of: 'b' });
  const b = post('b', { slug: 'b', locale: 'de', translation_of: 'a' });
  const opts = L.switcherOptions({
    path: '/blog/a', current: 'en', post: a, all: [a, b],
    pathFor: (p) => `/blog/${p.slug}`, env: ML,
  });
  eq(opts.length, 3, 'returned at all, i.e. did not hang');
});

check('switcherOptions never offers a DRAFT translation', () => {
  const en = post('en1', { slug: 'hello', locale: 'en' });
  const de = post('de1', { slug: 'hallo', locale: 'de', translation_of: 'en1', status: 'draft' });
  const opts = L.switcherOptions({
    path: '/blog/hello', current: 'en', post: en, all: [en, de],
    pathFor: (p) => `/blog/${p.slug}`, env: ML,
  });
  const d = opts.find((o) => o.locale === 'de');
  eq(d.href, '/de', 'the home page, not the unpublished article');
  eq(d.translated, false);
});

check('switcherOptions DOES offer a noindex translation', () => {
  // Deliberately unlike hreflangFor. `noindex` means "do not list this in
  // search results", not "do not serve this to a person who asked for it".
  const en = post('en1', { slug: 'hello', locale: 'en' });
  const de = post('de1', { slug: 'hallo', locale: 'de', translation_of: 'en1', noindex: true });
  const opts = L.switcherOptions({
    path: '/blog/hello', current: 'en', post: en, all: [en, de],
    pathFor: (p) => `/blog/${p.slug}`, env: ML,
  });
  eq(opts.find((o) => o.locale === 'de').translated, true);
});

check('switcherOptions treats a record as static when the caller omits `all`', () => {
  // A route that passes a post but forgets the corpus must not silently claim
  // every locale has a translation at this slug.
  const en = post('en1', { slug: 'hello', locale: 'en' });
  const opts = L.switcherOptions({ path: '/blog/hello', current: 'en', post: en, env: ML });
  eq(opts.find((o) => o.locale === 'de').href, '/de/blog/hello');
});

// ───────────────────── the two halves that were computed and then thrown away

// `switcherOptions` computed `translated` per entry from the day it was
// written, and the component rendered the list without it — so the switcher
// offered a real translation and a home-page fallback as if they were the same
// thing. The data was tested; the rendering was not. This is the missing half.
{
  const src = await fs.readFile(path.join(root, 'src/components/public/LocaleSwitcher.astro'), 'utf8');
  check('the switcher RENDERS the translated/not distinction, not just computes it', () => {
    if (!/opt\.translated|\.translated/.test(src)) {
      throw new Error('LocaleSwitcher never reads `translated` — the honest half is discarded again');
    }
  });
  check('an untranslated entry is explained, not merely marked', () => {
    // A bare asterisk with no legend and no title is decoration. A reader has
    // to be able to find out what it means without reading the source.
    if (!/title=/.test(src)) throw new Error('no title on the fallback links');
    if (!/not translated/i.test(src)) throw new Error('no legend explaining the marker');
  });
}

// Every public surface must build its internal links through the locale
// helpers. DefaultHome.astro — the page a FRESH INSTALL serves, and therefore
// the likeliest place for a reader to be standing — had `/blog` and `/about`
// hardcoded, which dropped them back into the default language.
{
  const PUBLIC_SURFACES = [
    'src/components/DefaultHome.astro',
    'src/components/public',
    'src/layouts',
    'src/pages/blog',
    'src/pages/index.astro',
  ];
  // Not localized routes: localePath would produce a 404 for these.
  const NOT_LOCALIZED = /^\/(admin|login|logout|forgot-password|reset-password|api)\b/;
  // Assets, not navigation.
  const ASSET = /\.(css|js|svg|png|jpe?g|webp|ico|xml|txt|json|webmanifest)$/;

  const files = [];
  for (const rel of PUBLIC_SURFACES) {
    const abs = path.join(root, rel);
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat) continue;
    if (stat.isDirectory()) {
      for (const name of await fs.readdir(abs)) {
        if (name.endsWith('.astro')) files.push(path.join(abs, name));
      }
    } else files.push(abs);
  }

  for (const abs of files) {
    const rel = path.relative(root, abs);
    const src = await fs.readFile(abs, 'utf8');
    check(`${rel} builds its internal links through the locale helpers`, () => {
      const offenders = [...src.matchAll(/href="(\/[^"#]*)"/g)]
        .map((m) => m[1])
        .filter((h) => !NOT_LOCALIZED.test(h) && !ASSET.test(h));
      if (offenders.length) {
        throw new Error(`hardcoded internal hrefs: ${[...new Set(offenders)].join(', ')}`);
      }
    });
  }
}

if (failures.length) {
  console.error(`\n✗ locale-links: ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error(`  · ${f}`);
  process.exit(1);
}
console.log(`✓ locale-links: ${passed} passed`);
