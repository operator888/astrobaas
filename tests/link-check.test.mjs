#!/usr/bin/env node
/**
 * Broken link checking (src/lib/link-check.ts).
 *
 * The asymmetry that shapes every assertion here: a FALSE POSITIVE is worse than
 * a miss. An editor sent hunting for a link that works twice will never open the
 * report again, and then the real broken links go unfixed too. So the cases
 * below lean hard on "must NOT be reported".
 *
 * Run with:  node tests/link-check.test.mjs
 */
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const cacheDir = path.join(root, 'node_modules', '.cache');
await fs.mkdir(cacheDir, { recursive: true });
const out = path.join(cacheDir, `astrobaas-linkcheck-${process.pid}.mjs`);
await build({
  entryPoints: [path.join(root, 'src/lib/link-check.ts')],
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
function eq(a, b, what = '') {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${what} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
}

const ORIGIN = 'https://shop.example.com';
const TARGETS = {
  articleSlugs: new Set(['hello', 'guide']),
  pageSlugs: new Set(['about', 'shipping']),
  builtinRoutes: new Set(['blog', 'admin', 'api', 'contact', 'legal', 'uploads']),
  redirected: (p) => p === '/old-url' || p.startsWith('/legacy/'),
  mediaPaths: new Set(['/uploads/2026/01/spec.pdf']),
};
const post = (over = {}) => ({
  id: 'p1', slug: 'p1', title: 'Post', status: 'published', content: '', ...over,
});

// ------------------------------------------------------------- classifyHref

check('a root-relative link is internal', () => {
  eq(L.classifyHref('/blog/hello').kind, 'internal');
  eq(L.classifyHref('/blog/hello').path, '/blog/hello');
});

check('query and fragment are stripped from the path', () => {
  eq(L.classifyHref('/blog/hello?utm=x#top').path, '/blog/hello');
});

check("the site's OWN absolute URL is internal", () => {
  // The form most likely to break, because an author copies it from the address
  // bar and it survives being pasted anywhere.
  eq(L.classifyHref(`${ORIGIN}/blog/hello`, ORIGIN).kind, 'internal');
  eq(L.classifyHref(`${ORIGIN}/blog/hello`, ORIGIN).path, '/blog/hello');
});

check('origins are compared, not string prefixes', () => {
  // `https://shop.example.com.evil.test` starts with the origin as a string.
  eq(L.classifyHref('https://shop.example.com.evil.test/x', ORIGIN).kind, 'external');
});

check('a default port is the same origin', () => {
  eq(L.classifyHref('https://shop.example.com:443/blog/hello', ORIGIN).kind, 'internal');
});

check('without a known origin, absolute URLs are EXTERNAL', () => {
  // The safe direction: an unchecked live link is harmless, calling our own
  // page broken because we could not tell it was ours is not.
  eq(L.classifyHref(`${ORIGIN}/blog/hello`).kind, 'external');
  eq(L.classifyHref(`${ORIGIN}/blog/hello`, null).kind, 'external');
});

check('anchors, mail and tel are their own kinds — never fetched, never resolved', () => {
  eq(L.classifyHref('#section').kind, 'anchor');
  eq(L.classifyHref('mailto:a@b.test').kind, 'mail');
  eq(L.classifyHref('MAILTO:a@b.test').kind, 'mail');
  eq(L.classifyHref('tel:+302101234567').kind, 'tel');
});

check('unusual schemes are "other", so nothing tries to fetch them', () => {
  for (const h of ['javascript:alert(1)', 'data:text/html,x', 'ftp://x.test/f']) {
    eq(L.classifyHref(h).kind, 'other', h);
  }
});

check('a protocol-relative link is external', () => {
  eq(L.classifyHref('//cdn.example.com/a.js').kind, 'external');
});

check('a relative link is "other" rather than guessed at', () => {
  // It resolves against whichever page renders it, which for a post that also
  // appears in a feed is more than one place.
  eq(L.classifyHref('sibling-page').kind, 'other');
});

check('an empty or malformed href does not throw', () => {
  eq(L.classifyHref('').kind, 'other');
  eq(L.classifyHref('http://[').kind, 'other');
  eq(L.classifyHref(undefined).kind, 'other');
});

// ------------------------------------------------------------ extractLinks

check('links are extracted with their visible text', () => {
  const links = L.extractLinks('<p>See <a href="/about">our <em>story</em></a>.</p>');
  eq(links.length, 1);
  eq(links[0].text, 'our story');
  eq(links[0].href, '/about');
});

check('several links, single quotes, and odd attribute order all work', () => {
  const links = L.extractLinks(`<a class="x" href='/a'>A</a><a href="/b" rel="nofollow">B</a>`);
  eq(links.map((l) => l.href), ['/a', '/b']);
});

check('content with no links costs nothing', () => {
  eq(L.extractLinks('<p>plain</p>'), []);
  eq(L.extractLinks(''), []);
});

check('an anchor with no href is skipped, not reported as empty', () => {
  eq(L.extractLinks('<a name="old-style">x</a>'), []);
});

// ------------------------------------------------------ resolvesInternally

check('the site root always resolves', () => {
  for (const p of ['/', '', '/?x=1']) {
    if (!L.resolvesInternally(p, TARGETS)) throw new Error(`root ${JSON.stringify(p)} reported broken`);
  }
});

check('a published article and a published page resolve', () => {
  eq(L.resolvesInternally('/blog/hello', TARGETS), true);
  eq(L.resolvesInternally('/about', TARGETS), true);
});

check('a LOCALE-PREFIXED link resolves — it is a live URL, not a broken one', () => {
  // The whole site emits these now (lib/locale-links.ts), so authors copy them
  // out of the address bar into content. Without stripping the prefix,
  // `/de/blog/hello` is three segments with `de` as the first — no route, no
  // page — and every one of them was reported broken. A false positive here is
  // the failure this module is arranged to avoid.
  const before = process.env.SITE_LOCALES;
  process.env.SITE_LOCALES = 'en,de,el';
  try {
    eq(L.resolvesInternally('/de/blog/hello', TARGETS), true, 'a German article');
    eq(L.resolvesInternally('/el/about', TARGETS), true, 'a Greek page');
    eq(L.resolvesInternally('/de/blog', TARGETS), true, 'the German archive');
    eq(L.resolvesInternally('/de/', TARGETS), true, 'the German home page');
    // Still broken when the thing behind the prefix is genuinely missing.
    eq(L.resolvesInternally('/de/blog/no-such-post', TARGETS), false);
    eq(L.resolvesInternally('/de/no-such-page', TARGETS), false);
  } finally {
    if (before === undefined) delete process.env.SITE_LOCALES;
    else process.env.SITE_LOCALES = before;
  }
});

check('an unconfigured prefix is NOT treated as a locale', () => {
  // `/fr/about` on a site with no French is a 404 and must be reported. The
  // strip has to know the configured list, not "anything two letters long".
  const before = process.env.SITE_LOCALES;
  process.env.SITE_LOCALES = 'en,de';
  try {
    eq(L.resolvesInternally('/fr/about', TARGETS), false);
  } finally {
    if (before === undefined) delete process.env.SITE_LOCALES;
    else process.env.SITE_LOCALES = before;
  }
});

check('the DEFAULT locale is not a prefix — /en/about is genuinely not a route', () => {
  // The default locale is served unprefixed, so `/en/...` is not a URL this
  // site answers. Treating it as a prefix would hide a real broken link.
  const before = process.env.SITE_LOCALES;
  process.env.SITE_LOCALES = 'en,de';
  try {
    eq(L.resolvesInternally('/en/about', TARGETS), false);
  } finally {
    if (before === undefined) delete process.env.SITE_LOCALES;
    else process.env.SITE_LOCALES = before;
  }
});

check('a missing article and a missing page do NOT', () => {
  eq(L.resolvesInternally('/blog/nope', TARGETS), false);
  eq(L.resolvesInternally('/nope', TARGETS), false);
});

check('a trailing slash is the same URL', () => {
  eq(L.resolvesInternally('/about/', TARGETS), true);
  eq(L.resolvesInternally('/blog/hello/', TARGETS), true);
});

check('a REDIRECTED path is not broken', () => {
  // The link works. Reporting it would send an editor to "fix" a URL that is
  // deliberately preserved.
  eq(L.resolvesInternally('/old-url', TARGETS), true);
});

check('a PREFIX redirect rule rescues everything under it', () => {
  // The reason this takes a predicate rather than a set: rules can be prefix or
  // wildcard patterns, and an exact-value set would miss most of them. Every
  // miss is a working link reported as broken.
  eq(L.resolvesInternally('/legacy/anything/deep', TARGETS), true);
});

check('an uploaded file resolves', () => {
  eq(L.resolvesInternally('/uploads/2026/01/spec.pdf', TARGETS), true);
});

check('a built-in route and anything under it resolves', () => {
  // Not enumerable from here — /admin alone has dozens of sub-paths — so a
  // prefix match is the honest limit of what this check can assert.
  eq(L.resolvesInternally('/blog', TARGETS), true);
  eq(L.resolvesInternally('/contact', TARGETS), true);
  eq(L.resolvesInternally('/admin/posts/123/edit', TARGETS), true);
});

check('a path DEEPER than /blog/<slug> does not resolve', () => {
  eq(L.resolvesInternally('/blog/hello/extra', TARGETS), false);
});

check('a two-segment path that is not a built-in route does not resolve', () => {
  // Pages live at one segment. /about/team is a 404.
  eq(L.resolvesInternally('/about/team', TARGETS), false);
});

// ------------------------------------------------------ scanInternalLinks

check('a broken internal link is reported with the post that holds it', () => {
  const rows = L.scanInternalLinks(
    [post({ id: 'a', title: 'Guide', content: '<a href="/blog/gone">old</a>' })],
    { origin: ORIGIN, targets: TARGETS },
  );
  eq(rows.length, 1);
  eq(rows[0].postId, 'a');
  eq(rows[0].postTitle, 'Guide');
  eq(rows[0].href, '/blog/gone');
  eq(rows[0].text, 'old');
});

check('a DRAFT is not scanned', () => {
  // A link to a page not written yet is work in progress, not a defect —
  // reporting it teaches the author to ignore the report.
  const rows = L.scanInternalLinks(
    [post({ status: 'draft', content: '<a href="/blog/gone">x</a>' })],
    { origin: ORIGIN, targets: TARGETS },
  );
  eq(rows, []);
});

check('external, mail, tel and anchor links are NOT reported by the internal scan', () => {
  const rows = L.scanInternalLinks(
    [post({ content: '<a href="https://x.test/gone">a</a><a href="mailto:a@b.test">b</a><a href="#top">c</a><a href="tel:+30210">d</a>' })],
    { origin: ORIGIN, targets: TARGETS },
  );
  eq(rows, []);
});

check("the site's own absolute URL IS scanned", () => {
  const rows = L.scanInternalLinks(
    [post({ content: `<a href="${ORIGIN}/blog/gone">x</a>` })],
    { origin: ORIGIN, targets: TARGETS },
  );
  eq(rows.length, 1);
});

check('a working link is never reported', () => {
  const rows = L.scanInternalLinks(
    [post({ content: '<a href="/blog/hello">a</a><a href="/about">b</a><a href="/old-url">c</a><a href="/">d</a>' })],
    { origin: ORIGIN, targets: TARGETS },
  );
  eq(rows, []);
});

check('the report has a stable total order', () => {
  const rows = L.scanInternalLinks([
    post({ id: 'z', title: 'Same', content: '<a href="/b-gone">x</a>' }),
    post({ id: 'a', title: 'Same', content: '<a href="/a-gone">y</a>' }),
  ], { origin: ORIGIN, targets: TARGETS });
  eq(rows.map((r) => r.href), ['/a-gone', '/b-gone']);
});

// -------------------------------------------------- collectExternalLinks

check('external links are collected once, with every place they appear', () => {
  const map = L.collectExternalLinks([
    post({ id: 'a', title: 'A', content: '<a href="https://x.test/p">one</a>' }),
    post({ id: 'b', title: 'B', content: '<a href="https://x.test/p">two</a><a href="https://y.test/">three</a>' }),
  ], ORIGIN);
  eq([...map.keys()].sort(), ['https://x.test/p', 'https://y.test/']);
  eq(map.get('https://x.test/p').length, 2);
  eq(map.get('https://x.test/p').map((r) => r.postId), ['a', 'b']);
});

check('drafts and internal links stay out of the external set', () => {
  const map = L.collectExternalLinks([
    post({ status: 'draft', content: '<a href="https://d.test/">d</a>' }),
    post({ content: `<a href="${ORIGIN}/about">own</a><a href="mailto:a@b.test">m</a>` }),
  ], ORIGIN);
  eq(map.size, 0);
});

if (failures.length) {
  console.error(`\n✗ link-check: ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error(`  · ${f}`);
  process.exit(1);
}
console.log(`✓ link-check: ${passed} passed`);
