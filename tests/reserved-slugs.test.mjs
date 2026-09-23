#!/usr/bin/env node
/**
 * Reserved slugs, and the CSS scoping scanner.
 *
 * Both of these guard properties I got WRONG in the first implementation, and
 * in both cases the failure was silent — which is why the tests here are shaped
 * around the specific wrong belief rather than around the happy path.
 *
 * 1. **Route order.** I wrote that a rest-parameter catch-all yields to explicit
 *    routes "until someone creates a Page with that slug". Astro's route order
 *    is static and comes from the filesystem; a database row cannot change it.
 *    So a Page slugged `about` saved fine, listed fine, linked fine — and was
 *    permanently unreachable, while the sitemap advertised the URL with the
 *    Page's `lastmod`.
 *
 * 2. **CSS comment stripping.** `unscopedSelectors` removed comments with a
 *    regex before counting braces. A `/*` inside a CSS STRING made the regex
 *    swallow the rules between two such strings, so `body{display:none}` passed
 *    validation and was served on `/plugins.css` — which BaseLayout links from
 *    the admin as well as the public site.
 *
 * The first test in this file is a DRIFT test: it reads `src/pages/` from disk
 * and fails if the reserved list and the real routes disagree. That is the
 * guard that lets the list be a plain array instead of a Vite-only glob.
 *
 * Run with:  node tests/reserved-slugs.test.mjs
 */
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const cacheDir = path.join(root, 'node_modules', '.cache');
await fs.mkdir(cacheDir, { recursive: true });

async function load(rel, name) {
  const out = path.join(cacheDir, `astrobaas-${name}-${process.pid}.mjs`);
  await build({
    entryPoints: [path.join(root, rel)],
    bundle: true, format: 'esm', platform: 'node', packages: 'external',
    outfile: out, logLevel: 'silent',
  });
  const mod = await import(pathToFileURL(out).href);
  await fs.rm(out, { force: true });
  return mod;
}

const { isReservedSlug, reservedSlugs, builtInRouteSlugs, reservedSlugMessage } =
  await load('src/lib/reserved-slugs.ts', 'reserved-slugs');
const { unscopedSelectors, validateManifest } = await load('src/core/manifest.ts', 'manifest-scanner');
const { manifestSectionCss } = await load('src/lib/manifest-sections.ts', 'manifest-sections-scan');

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) pass++;
  else { fail++; console.error(`✗ ${name}`); }
}

/* ---------------- THE drift test ---------------- */
{
  // Read the real routes. If this disagrees with the hand-written list, the
  // list is stale and a Page could claim a slug a built-in route serves.
  const entries = await fs.readdir(path.join(root, 'src/pages'), { withFileTypes: true });
  const actual = new Set();
  for (const e of entries) {
    if (e.name.startsWith('[')) continue;          // dynamic/rest routes claim no fixed segment
    if (e.name.startsWith('.')) continue;          // .DS_Store and friends are not routes
    const seg = e.isDirectory() ? e.name : e.name.replace(/\.(astro|ts|js)$/, '');
    if (!seg || seg === 'index') continue;          // `index` is `/`, not a slug
    actual.add(seg.toLowerCase());
  }

  const declared = new Set(builtInRouteSlugs());
  const missing = [...actual].filter((s) => !declared.has(s)).sort();
  const extra = [...declared].filter((s) => !actual.has(s)).sort();

  check(`every real route is reserved (missing: ${missing.join(', ') || 'none'})`, missing.length === 0);
  check(`no reserved slug names a route that does not exist (extra: ${extra.join(', ') || 'none'})`, extra.length === 0);
  check('the list is non-trivial', declared.size > 10);
}

/* ---------------- the reservation itself ---------------- */
{
  // The two that matter most: they are the likeliest first use of Pages.
  check('`about` is reserved', isReservedSlug('about'));
  check('`contact` is reserved', isReservedSlug('contact'));
  check('`blog` is reserved', isReservedSlug('blog'));
  check('`admin` is reserved', isReservedSlug('admin'));
  check('`api` is reserved', isReservedSlug('api'));
  check('`login` is reserved', isReservedSlug('login'));
  // Not route files, but served by the adapter/middleware.
  check('`uploads` is reserved', isReservedSlug('uploads'));
  check('`_astro` is reserved', isReservedSlug('_astro'));

  check('an ordinary slug is free', !isReservedSlug('our-story'));
  check('a slug that merely CONTAINS a reserved word is free', !isReservedSlug('about-us'));
  check('...and one that is a prefix of it', !isReservedSlug('cont'));

  // Slugs are lowercased upstream, but a caller that skipped that must not slip
  // past — the filesystem check would still resolve `/About` on a case-
  // insensitive filesystem.
  check('the check is case-insensitive', isReservedSlug('About') && isReservedSlug('ADMIN'));
  check('surrounding whitespace does not evade it', isReservedSlug('  about  '));
  check('empty and nullish inputs are safe',
    !isReservedSlug('') && !isReservedSlug(null) && !isReservedSlug(undefined));

  check('the message names the URL and says what to do',
    reservedSlugMessage('about').includes('/about') && /different slug/i.test(reservedSlugMessage('about')));
  check('reservedSlugs() is sorted and complete',
    reservedSlugs().includes('about') && reservedSlugs().join() === [...reservedSlugs()].sort().join());
}

/* ---------------- the CSS scanner: the bypass that shipped ---------------- */
{
  const P = '.ab-x-evil-';
  const reports = (css) => unscopedSelectors(css, P).length > 0;

  // THE regression. A `/*` inside a CSS string used to make the comment-strip
  // regex swallow everything up to a `*/` in a later string, hiding the rules
  // between them from the scanner while the browser still parsed them.
  check('a /* inside a CSS string cannot hide an unscoped rule',
    reports('.ab-x-evil-a{content:"/*"}\nbody{display:none}\n.ab-x-evil-a{content:"*/"}'));
  check('...the same trick via url()',
    reports('.ab-x-evil-a{background:url("/*")}\nbody{display:none}\n.ab-x-evil-a{background:url("*/")}'));
  check('...and with single quotes',
    reports(".ab-x-evil-a{content:'/*'}\nbody{display:none}\n.ab-x-evil-a{content:'*/'}"));
  check('...and with an escaped quote inside the string',
    reports('.ab-x-evil-a{content:"\\"/*"}\nbody{display:none}'));

  // The cases that already worked must keep working.
  check('a bare unscoped selector is reported', reports('body{display:none}'));
  check('an unscoped selector inside @media is reported', reports('@media screen{body{display:none}}'));
  check('one unscoped selector in a group is reported', reports('.ab-x-evil-a, body{color:red}'));
  check('@font-face is reported (it is not scopable)', reports('@font-face{font-family:x;src:url(/x.woff2)}'));
  check('@keyframes is reported', reports('@keyframes spin{from{transform:none}}'));
  check('a real comment can still hide nothing',
    reports('/* .ab-x-evil-a { */ body{display:none} /* } */'));

  // ...and legitimate CSS must not be rejected, or the feature is unusable.
  check('a scoped rule is clean', !reports('.ab-x-evil-a{padding:1rem}'));
  check('a scoped descendant is clean', !reports('.ab-x-evil-a h3{margin:0}'));
  check('a scoped rule inside @media is clean',
    !reports('@media (max-width:40rem){.ab-x-evil-a{padding:0}}'));
  check('braces inside a string are data, not structure',
    !reports('.ab-x-evil-a{content:"{}"}'));
  check('a comment between scoped rules is fine',
    !reports('.ab-x-evil-a{color:red} /* note */ .ab-x-evil-b{color:blue}'));
  check('nested rules inherit the parent scope and are not re-flagged',
    !reports('.ab-x-evil-a{color:red; & span{color:blue}}'));

  // Malformed input must fail closed rather than be guessed at.
  check('an unterminated string is refused', reports('.ab-x-evil-a{content:"oops}'));
  check('an unterminated comment is refused', reports('.ab-x-evil-a{color:red} /* oops'));
  check('empty CSS is clean', !reports(''));
}

/* ---------------- and the bypass is refused end to end ---------------- */
{
  const evilCss = '.ab-x-evil-hero{content:"/*"}\nbody{display:none!important}\n.ab-x-evil-hero{content:"*/"}';
  const mk = (css) => ({
    id: 'evil', name: 'E', version: '1.0.0',
    capabilities: { sections: [{ name: 'hero', label: 'H',
      template: '<div class="ab-x-evil-hero"><p>x</p></div>', css }] },
  });

  const res = validateManifest(mk(evilCss));
  check('the manifest validator now refuses the bypass', res.ok === false);
  check('...naming the selector that escaped', res.errors.some((e) => e.includes('body')));

  // The serve-time guard was a substring test (`includes(prefix)`), so a block
  // that mentioned the prefix once was served whole. It must now actually scan.
  const served = manifestSectionCss({
    id: 'evil', name: 'E', version: '1.0.0',
    capabilities: { sections: [{ name: 'hero', label: 'H',
      template: '<div class="ab-x-evil-hero"><p>x</p></div>',
      css: '.ab-x-evil-hero{color:red}\nbody{display:none}' }] },
  });
  check('a hand-edited row with an unscoped rule is not served', !/body\s*\{/.test(served));
  check('...and the scoped part is dropped with it rather than half-served',
    !served.includes('.ab-x-evil-hero'));

  const clean = manifestSectionCss({
    id: 'good', name: 'G', version: '1.0.0',
    capabilities: { sections: [{ name: 'hero', label: 'H',
      template: '<div class="ab-x-good-hero"><p>x</p></div>',
      css: '.ab-x-good-hero{padding:1rem}' }] },
  });
  check('a properly scoped stylesheet is still served', clean.includes('.ab-x-good-hero'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
