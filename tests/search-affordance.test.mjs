#!/usr/bin/env node
/**
 * A shopper must be able to REACH the search that already works.
 *
 * ## The gap this closes
 *
 * `GET /api/products?search=` and `/blog?q=` both work well, and both are
 * ranked server-side. Nothing in this CMS ever put a box on screen for either —
 * so a site built on AstroBaaS shipped with no way for a visitor to search
 * unless somebody remembered to build one. A live shop launched that way and
 * its owner reported it as a bug.
 *
 * Two details make this a source-level test rather than a rendering one, and
 * both are the kind of thing that decays silently:
 *
 *  1. **The box must not live inside a `Header`.** `Header` is an overridable
 *     theme slot, both shipped themes replace it wholesale, and the
 *     `astrobaas theme new` scaffold generates one that already drops the
 *     locale switcher. A search box in a header is a search box that vanishes
 *     the first time anyone themes the site — and declarative manifest themes,
 *     which cannot ship components at all, could never gain one.
 *  2. **Every search form must point at a route this app SERVES.** The 404 page
 *     shipped the repository's only search form, aimed at `/shop` — a path
 *     AstroBaaS has no page for. The page for people who took a wrong turn
 *     offered them a second one.
 *
 * Run with:  node tests/search-affordance.test.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';

let pass = 0;
let fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };

/**
 * Read a source file with its COMMENTS REMOVED.
 *
 * Every assertion here scans source text, and the first version of this file
 * failed three times over its own prose: the search box's header explains why
 * it has no `<script>` block (matching /<script/), and the 404 page's comment
 * quotes the `action="/shop"` it replaced (matching the very pattern asserting
 * that string is gone). A guard that a comment can satisfy — or break — is not
 * a guard.
 */
async function read(p) {
  return (await fs.readFile(p, 'utf8'))
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')   // .astro template comments
    .replace(/\/\*[\s\S]*?\*\//g, '');        // block comments, JSDoc included
}

/* ------------------------------------------------ the box exists, and where */
{
  const layout = await read('src/layouts/PublicLayout.astro');
  check('the public layout renders a site search box',
    /<SiteSearch/.test(layout) && /import SiteSearch/.test(layout));

  // PROPERTY 1 — rendered BESIDE the Header slot, never inside a Header.
  for (const header of [
    'src/components/public/PublicHeader.astro',
    'src/themes/editorial/Header.astro',
    'src/themes/marquee/Header.astro',
  ]) {
    const src = await read(header);
    check(`${path.basename(path.dirname(header))}/${path.basename(header)} does NOT own the search box — the layout does, so themes inherit it`,
      !/<SiteSearch/.test(src));
  }

  const box = await read('src/components/public/SiteSearch.astro');
  check('the box is a plain GET form — it works with scripting off',
    /method="get"/.test(box) && !/<script/.test(box));
  check('...with a real <label>, not a placeholder standing in for one',
    /<label[^>]*for="ab-site-search-q"/.test(box));
  check('...and a submit BUTTON, so nobody has to guess that Enter works',
    /type="submit"/.test(box));
  check('...named `q`, the parameter the search route actually reads',
    /name="q"/.test(box));
  check('...carrying the current query back, so the box is not blank on results',
    /value=\{value\}/.test(box));
  // A theme that genuinely wants it gone needs a stable hook.
  check('...under a stable class a theme can hide', /ab-site-search/.test(box));
  check('the form is locale-aware, so a Greek reader is not dropped into English',
    /routeHref\('\/blog', locale\)/.test(box));
}

/* ------------------------------------------------ every form goes somewhere */
{
  /*
   * PROPERTY 2, checked by ENUMERATING the routes this app serves rather than
   * by listing known-good paths: a form aimed at a page that was deleted later
   * should fail here too.
   */
  const pages = await fs.readdir('src/pages');
  const served = new Set(
    pages.filter((f) => f.endsWith('.astro')).map((f) => `/${f.replace(/\.astro$/, '')}`),
  );
  served.add('/'); // index.astro
  for (const dir of ['blog']) {
    try {
      await fs.stat(path.join('src/pages', dir));
      served.add(`/${dir}`);
    } catch { /* not present */ }
  }

  const withForms = [
    'src/pages/404.astro',
    'src/components/public/SiteSearch.astro',
  ];
  for (const file of withForms) {
    const src = await read(file);
    // Literal actions only — a routeHref(...) call is checked separately below.
    for (const m of src.matchAll(/<form[^>]*\baction="([^"{}]+)"/g)) {
      const target = m[1].split('?')[0].replace(/\/$/, '') || '/';
      check(`${path.basename(file)}: form action ${m[1]} is a route this app serves`,
        served.has(target));
    }
  }

  const notFound = await read('src/pages/404.astro');
  check('the 404 page no longer aims its search at /shop, which this CMS does not serve',
    !/action="\/shop"/.test(notFound));
  check('...and points at the search route instead',
    /<form[^>]*action=\{routeHref\('\/blog'/.test(notFound));
  check('/shop really is unserved, so the old action WAS broken',
    !served.has('/shop'));
}

/* ------------------------------------------------ the results page says so */
{
  const blog = await read('src/pages/blog/index.astro');
  check('a search tells the reader it searched, rather than silently shortening the list',
    /Search results/.test(blog));
  // The count itself, not the word: `{totalPosts} {…'results'} for “…”`.
  check('...how many matched', /\{totalPosts\}[\s\S]{0,120}results/.test(blog));
  check('...says plainly when nothing matched', /Nothing matched/.test(blog));
  check('...and offers a way back out', /Clear search/.test(blog));
}

/* ------------------------------------------------ the claim made to Google */
{
  // The home page advertises /blog?q= as this site's SearchAction, with a
  // comment insisting on "only claim a search endpoint that exists". It does
  // exist — but until now a reader could reach it only via the address bar.
  const home = await read('src/pages/index.astro');
  const searchPath = home.match(/searchPath:\s*'([^']+)'/)?.[1];
  check('the site advertises a search endpoint to Google', !!searchPath);
  const box = await read('src/components/public/SiteSearch.astro');
  check(`...and the on-page box points at the same place (${searchPath})`,
    !!searchPath && box.includes(`'${searchPath.split('?')[0]}'`));
  check('...using the same parameter name the advertised URL uses',
    !!searchPath && searchPath.includes('q=') && /name="q"/.test(box));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
