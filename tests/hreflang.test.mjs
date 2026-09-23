#!/usr/bin/env node
/**
 * `hreflang` — the last gap in Phase E.
 *
 * The property that decides whether this works at all is RECIPROCITY: every URL
 * in a translation set must list every URL in that set, itself included. A page
 * that names its sibling while the sibling stays silent is discarded by search
 * engines, so a partial set is not a smaller benefit — it is no benefit. Most
 * of this file is that one property, checked from several directions.
 *
 * The second property matters to the two live shops, which are single-language:
 * a one-locale install must emit NOTHING. A lone self-referential tag is noise,
 * and changing their markup for no gain is a regression.
 *
 * Run with:  node tests/hreflang.test.mjs
 */
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const cacheDir = path.join(root, 'node_modules', '.cache');
await fs.mkdir(cacheDir, { recursive: true });

const out = path.join(cacheDir, `astrobaas-hreflang-${process.pid}.mjs`);
await build({
  entryPoints: [path.join(root, 'src/lib/hreflang.ts')],
  bundle: true, format: 'esm', platform: 'node', packages: 'external',
  outfile: out, logLevel: 'silent',
});
const { hreflangFor, translationSet } = await import(pathToFileURL(out).href);
await fs.rm(out, { force: true });

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) pass++;
  else { fail++; console.error(`✗ ${name}`); }
}

const ORIGIN = 'https://shop.example.com';
const post = (o) => ({ status: 'published', title: 't', ...o });
/** i18n reads process.env, so locales are supplied per call. */
const ENV = (list, def) => ({ SITE_LOCALES: list, SITE_DEFAULT_LOCALE: def });
const blog = (p) => `/blog/${p.slug}`;
const call = (p, all, env, origin = ORIGIN) =>
  hreflangFor(p, all, { origin, pathFor: blog, env });

/* ---------------- single-language installs emit nothing ---------------- */
{
  // The two live shops. Their markup must not change.
  const one = [post({ id: '1', slug: 'a', locale: 'el' })];
  check('a single-locale install emits no hreflang',
    call(one[0], one, ENV('el', 'el')).length === 0);
  check('...even with several posts',
    call(one[0], [...one, post({ id: '2', slug: 'b', locale: 'el' })], ENV('el', 'el')).length === 0);

  // A multilingual install where THIS post has no translation yet.
  const lonely = [post({ id: '1', slug: 'a', locale: 'el' })];
  check('a post with no translation emits nothing',
    call(lonely[0], lonely, ENV('el,en', 'el')).length === 0);

  check('no resolvable origin emits nothing',
    call(lonely[0], lonely, ENV('el,en', 'el'), null).length === 0);
}

/* ---------------- THE reciprocity property ---------------- */
{
  const el = post({ id: '1', slug: 'gyalia', locale: 'el' });
  const en = post({ id: '2', slug: 'sunglasses', locale: 'en', translation_of: '1' });
  const all = [el, en];
  const env = ENV('el,en', 'el');

  const fromEl = call(el, all, env);
  const fromEn = call(en, all, env);

  check('both members produce links', fromEl.length > 0 && fromEn.length > 0);
  // THE assertion: the set is identical whichever member you ask.
  const norm = (ls) => ls.map((l) => `${l.hreflang}=${l.href}`).sort().join('|');
  check('every member advertises the IDENTICAL set (reciprocity)',
    norm(fromEl) === norm(fromEn));
  check('...and each set includes the page itself (self-reference)',
    fromEl.some((l) => l.href.endsWith('/blog/gyalia'))
    && fromEn.some((l) => l.href.endsWith('/blog/sunglasses')));

  // The default locale is served un-prefixed; anything else is prefixed. A tag
  // pointing at a prefixed default-locale URL would be a 404.
  check('the default locale is NOT prefixed',
    fromEl.find((l) => l.hreflang === 'el')?.href === `${ORIGIN}/blog/gyalia`);
  check('a non-default locale IS prefixed',
    fromEl.find((l) => l.hreflang === 'en')?.href === `${ORIGIN}/blog/sunglasses`.replace('/blog', '/en/blog'));

  check('x-default is emitted', fromEl.some((l) => l.hreflang === 'x-default'));
  check('...pointing at the default-locale URL',
    fromEl.find((l) => l.hreflang === 'x-default')?.href === `${ORIGIN}/blog/gyalia`);
  check('exactly one tag per locale, plus x-default', fromEl.length === 3);
}

/* ---------------- set membership ---------------- */
{
  const root_ = post({ id: '1', slug: 'a', locale: 'el' });
  const t1 = post({ id: '2', slug: 'b', locale: 'en', translation_of: '1' });
  const t2 = post({ id: '3', slug: 'c', locale: 'de', translation_of: '1' });
  const other = post({ id: '9', slug: 'z', locale: 'en' });
  const all = [root_, t1, t2, other];

  check('the set is the original plus everything pointing at it',
    translationSet(root_, all).length === 3);
  check('...and is the same set seen from a translation',
    translationSet(t2, all).length === 3);
  check('an unrelated post is not in the set',
    !translationSet(root_, all).some((p) => p.id === '9'));

  const links = call(t1, all, ENV('el,en,de', 'el'));
  check('a three-language set emits three locales + x-default', links.length === 4);
  check('links are sorted deterministically',
    links.slice(0, 3).map((l) => l.hreflang).join() === 'de,el,en');

  // An orphan whose original was deleted must still appear in its own set,
  // rather than vanishing from the page that is rendering it.
  const orphan = post({ id: '7', slug: 'o', locale: 'en', translation_of: 'deleted' });
  check('an orphaned translation still includes itself',
    translationSet(orphan, [orphan]).some((p) => p.id === '7'));
}

/* ---------------- what must never be advertised ---------------- */
{
  const el = post({ id: '1', slug: 'a', locale: 'el' });
  const draft = post({ id: '2', slug: 'b', locale: 'en', translation_of: '1', status: 'draft' });
  const env = ENV('el,en', 'el');

  // Advertising a draft hands a crawler a 404, and the set is judged whole.
  check('an unpublished translation is not advertised',
    call(el, [el, draft], env).length === 0);

  const published = post({ id: '3', slug: 'c', locale: 'en', translation_of: '1' });
  check('...while a published one is',
    call(el, [el, draft, published], env).some((l) => l.href.includes('/en/blog/c')));

  // A locale nobody configured cannot be advertised — the URL would not resolve.
  const stray = post({ id: '4', slug: 'd', locale: 'fr', translation_of: '1' });
  check('a translation in an unconfigured locale is skipped',
    !call(el, [el, published, stray], env).some((l) => l.hreflang === 'fr'));

  // Two records claiming one language would emit conflicting tags for a single
  // hreflang value, which search engines discard the whole set for.
  const dupe = post({ id: '5', slug: 'e', locale: 'en', translation_of: '1' });
  const links = call(el, [el, published, dupe], env);
  check('a duplicated locale yields exactly one tag for it',
    links.filter((l) => l.hreflang === 'en').length === 1);
  check('...chosen deterministically',
    call(el, [el, published, dupe], env).find((l) => l.hreflang === 'en')?.href
    === call(el, [el, published, dupe], env).find((l) => l.hreflang === 'en')?.href);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
