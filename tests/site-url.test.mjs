#!/usr/bin/env node
/**
 * Canonical site URL resolution.
 *
 * The admin's "Site URL" field was stored and read by nothing — the sitemap,
 * RSS feed and robots.txt all used Astro's build-time `site`. A self-hoster who
 * filled the field in got no effect whatsoever. Same inert-field shape as the
 * theme tokens and the SEO meta fields, and the third instance of it found in
 * this codebase.
 *
 * The values this produces end up inside `<loc>` in a sitemap, `<link rel=
 * "canonical">`, and JSON-LD — all places a search engine follows — so the
 * parsing is as much about refusing junk as about precedence.
 *
 * Run with:  node tests/site-url.test.mjs
 */
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const cacheDir = path.join(root, 'node_modules', '.cache');
await fs.mkdir(cacheDir, { recursive: true });

const out = path.join(cacheDir, `astrobaas-siteurl-${process.pid}.mjs`);
await build({
  entryPoints: [path.join(root, 'src/lib/site-url.ts')],
  bundle: true, format: 'esm', platform: 'node', packages: 'external',
  outfile: out, logLevel: 'silent',
});
const { resolveSiteUrl, absoluteUrl, viewSiteHref } = await import(pathToFileURL(out).href);
await fs.rm(out, { force: true });

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) pass++;
  else { fail++; console.error(`✗ ${name}`); }
}

/* ---------------- precedence ---------------- */
{
  // The setting is editable at RUNTIME; SITE_URL is baked in at BUILD time. A
  // self-hoster who moves domains, or runs a prebuilt image, can only change
  // one of them — so the runtime value has to win.
  check('the setting beats the build-time site', resolveSiteUrl({
    setting: 'https://shop.example.com',
    astroSite: 'https://built-in.example.org',
    requestUrl: 'https://request.example.net/blog',
  }) === 'https://shop.example.com');

  check('the build-time site is used when no setting exists', resolveSiteUrl({
    astroSite: 'https://built-in.example.org',
    requestUrl: 'https://request.example.net/blog',
  }) === 'https://built-in.example.org');

  check('the request origin is the last resort', resolveSiteUrl({
    requestUrl: 'https://request.example.net/blog/a-post?x=1',
  }) === 'https://request.example.net');

  // Nothing configured must yield NOTHING, not a localhost guess — a search
  // engine will happily index http://localhost:4321 if you emit it.
  check('nothing configured resolves to null', resolveSiteUrl({}) === null);
  check('an empty setting falls through rather than winning',
    resolveSiteUrl({ setting: '   ', astroSite: 'https://a.example.com' }) === 'https://a.example.com');
}

/* ---------------- these strings reach a search engine ---------------- */
{
  const rejected = [
    ['javascript: scheme', 'javascript:alert(1)'],
    ['data: scheme', 'data:text/html,<script>alert(1)</script>'],
    ['file: scheme', 'file:///etc/passwd'],
    ['not a url at all', 'shop.example.com'],
    ['empty string', ''],
    ['a number', 42],
    ['an object', {}],
    ['null', null],
  ];
  for (const [label, value] of rejected) {
    check(`a ${label} setting is refused`, resolveSiteUrl({ setting: value }) === null);
  }

  // And a refused setting must not poison the fallback chain.
  check('a hostile setting falls back to the build-time site',
    resolveSiteUrl({ setting: 'javascript:alert(1)', astroSite: 'https://safe.example.com' })
      === 'https://safe.example.com');
}

/* ---------------- normalisation ---------------- */
{
  check('a trailing slash is trimmed',
    resolveSiteUrl({ setting: 'https://a.example.com/' }) === 'https://a.example.com');
  check('surrounding whitespace is trimmed',
    resolveSiteUrl({ setting: '  https://a.example.com  ' }) === 'https://a.example.com');
  check('a sub-path is preserved (sites hosted under a prefix)',
    resolveSiteUrl({ setting: 'https://a.example.com/shop' }) === 'https://a.example.com/shop');
  check('a sub-path keeps its slash trimmed',
    resolveSiteUrl({ setting: 'https://a.example.com/shop/' }) === 'https://a.example.com/shop');
  check('http is allowed (self-hosters behind a proxy)',
    resolveSiteUrl({ setting: 'http://localhost:3000' }) === 'http://localhost:3000');
  check('a port survives',
    resolveSiteUrl({ setting: 'https://a.example.com:8443' }) === 'https://a.example.com:8443');

  // Astro hands `site` over as a URL object, not a string.
  check('an Astro URL object is accepted',
    resolveSiteUrl({ astroSite: new URL('https://from-astro.example.com/') })
      === 'https://from-astro.example.com');
}

/* ---------------- absoluteUrl ---------------- */
{
  check('a path becomes absolute', absoluteUrl('/blog/x', 'https://a.example.com') === 'https://a.example.com/blog/x');
  check('a missing leading slash is added', absoluteUrl('blog/x', 'https://a.example.com') === 'https://a.example.com/blog/x');
  // Better a relative URL than one rooted at a wrong origin.
  check('an unresolvable site leaves the path relative', absoluteUrl('/blog/x', null) === '/blog/x');
}

/* ---- The admin's "View site" button ---------------------------------- */
{
  // THE BUG: it was a hard-coded "/", so on a headless install it opened the
  // CMS's built-in site instead of the storefront visitors see.
  check('View site opens the configured site', viewSiteHref('https://shop.example.com') === 'https://shop.example.com');
  check('...without a trailing slash', viewSiteHref('https://shop.example.com/') === 'https://shop.example.com');
  check('...and falls back to "/" when nothing is set', viewSiteHref(undefined) === '/' && viewSiteHref('  ') === '/');
  check('...and never follows a javascript: URL', viewSiteHref('javascript:alert(1)') === '/');

  // The header must USE it. A helper nobody calls is how the Site URL field
  // was inert the first time.
  const header = await fs.readFile(path.join(root, 'src/components/admin/AdminHeader.astro'), 'utf8');
  check('the admin header links View site through viewSiteHref',
    /viewSiteHref\(/.test(header) && /href=\{viewSite\}/.test(header));
  check('...and no longer hard-codes href="/" on it', !/href="\/"\s+target="_blank"/.test(header));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
