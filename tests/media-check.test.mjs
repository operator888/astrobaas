#!/usr/bin/env node
/**
 * The broken-media report (C-151) — src/lib/media-check.ts.
 *
 * The sibling of the broken-link report, and it fails the same way if it is
 * careless: a report with entries in it that are FINE is one an author learns
 * to close. So most of what follows is about what must NOT be listed.
 *
 * Run with:  node tests/media-check.test.mjs
 */
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const cacheDir = path.join(root, 'node_modules', '.cache');
await fs.mkdir(cacheDir, { recursive: true });
const out = path.join(cacheDir, `astrobaas-mediacheck-${process.pid}.mjs`);
await build({
  entryPoints: [path.join(root, 'src/lib/media-check.ts')],
  bundle: true, format: 'esm', platform: 'node', packages: 'external',
  outfile: out, logLevel: 'silent',
});
const M = await import(pathToFileURL(out).href);

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

const post = (over = {}) => ({
  id: 'p1', title: 'A post', slug: 'a-post', status: 'published', content: '', ...over,
});
const LIBRARY = [
  {
    id: 'm1', url: '/uploads/2026/08/cat.webp', original_name: 'cat.webp',
    thumb_url: '/uploads/2026/08/cat-400.webp',
    variants: [{ url: '/uploads/2026/08/cat-800.webp' }],
  },
];

// ─────────────────────────────────────────────────── what MUST be reported

check('a deleted file leaves a listed reference behind', () => {
  // The case that actually happens: it was in the library, it went into an
  // article, somebody deleted it. Nothing logs this — serving 404 for a file
  // is not an error, the request was answered.
  const r = M.scanBrokenMedia([post({ content: '<img src="/uploads/2026/08/gone.webp" />' })], LIBRARY);
  eq(r.length, 1);
  eq(r[0].src, '/uploads/2026/08/gone.webp');
  eq(r[0].where, 'body');
});

check('a missing FEATURED image is reported separately', () => {
  const r = M.scanBrokenMedia([post({ featured_image: '/uploads/gone.webp' })], LIBRARY);
  eq(r.length, 1);
  eq(r[0].where, 'featured');
});

check('one broken file used twice in a post is listed once', () => {
  const r = M.scanBrokenMedia([post({
    content: '<img src="/uploads/gone.webp" /><p>x</p><img src="/uploads/gone.webp?v=2" />',
  })], LIBRARY);
  eq(r.length, 1, 'the cache-buster is the same file');
});

// ───────────────────────────────────────────── what must NOT be reported

check('a THEME asset outside /uploads/ is not "missing"', () => {
  // The library knows nothing about public/. Reporting it would fill the list
  // with entries that are fine, which is how a report stops being read.
  eq(M.scanBrokenMedia([post({ content: '<img src="/images/hero.jpg" />' })], LIBRARY), []);
});

check('a REMOTE image is not answered for', () => {
  // Answering means fetching, which is the external checker's problem and
  // carries the external checker's caveats.
  eq(M.scanBrokenMedia([post({ content: '<img src="https://cdn.example.com/a.jpg" />' })], LIBRARY), []);
  eq(M.scanBrokenMedia([post({ content: '<img src="data:image/gif;base64,R0lGOD" />' })], LIBRARY), []);
});

check('a DRAFT is not scanned', () => {
  // A draft pointing at a file not uploaded yet is work in progress.
  eq(M.scanBrokenMedia([post({ status: 'draft', content: '<img src="/uploads/gone.webp" />' })], LIBRARY), []);
});

check('a THUMBNAIL or a derivative resolves, not just the original', () => {
  // An author who inserted the 400px variant is looking at the same picture.
  const content = '<img src="/uploads/2026/08/cat-400.webp" /><img src="/uploads/2026/08/cat-800.webp" />';
  eq(M.scanBrokenMedia([post({ content })], LIBRARY), []);
});

check('an absolute URL on our own origin resolves', () => {
  const content = '<img src="https://shop.gr/uploads/2026/08/cat.webp" />';
  eq(M.scanBrokenMedia([post({ content })], LIBRARY), []);
});

check('a percent-encoded path resolves', () => {
  const lib = [{ id: 'm', url: '/uploads/my file.webp' }];
  eq(M.scanBrokenMedia([post({ content: '<img src="/uploads/my%20file.webp" />' })], lib), []);
});

check('an empty library reports nothing for a post with no images', () => {
  eq(M.scanBrokenMedia([post({ content: '<p>words</p>' })], []), []);
});

// ─────────────────────────────────────────────────────── stable ordering

check('the same input gives the same report, whichever driver returned it', () => {
  const posts = [
    post({ id: 'b', title: 'Zebra', content: '<img src="/uploads/z.webp" />' }),
    post({ id: 'a', title: 'Aardvark', content: '<img src="/uploads/a.webp" />' }),
  ];
  const forward = M.scanBrokenMedia(posts, []).map((r) => r.postTitle);
  const backward = M.scanBrokenMedia([...posts].reverse(), []).map((r) => r.postTitle);
  eq(forward, ['Aardvark', 'Zebra']);
  eq(forward, backward);
});

// ──────────────────────────────────────────────────── the other direction

check('a file nothing links to is listed', () => {
  const r = M.unreferencedMedia([post({ content: '<p>no pictures</p>' })], LIBRARY);
  eq(r.length, 1);
  eq(r[0].name, 'cat.webp');
});

check('a file referenced by its THUMBNAIL counts as used', () => {
  // Otherwise the report offers to delete a file that is on the front page.
  const r = M.unreferencedMedia([post({ content: '<img src="/uploads/2026/08/cat-400.webp" />' })], LIBRARY);
  eq(r, []);
});

check('a file used only as a FEATURED image counts as used', () => {
  const r = M.unreferencedMedia([post({ featured_image: '/uploads/2026/08/cat.webp' })], LIBRARY);
  eq(r, []);
});

check('a DRAFT does not keep a file alive in this report', () => {
  // Consistent with the broken half, which also reads published records only.
  // Stated rather than assumed, because the two halves reading different sets
  // would make one report contradict the other.
  const r = M.unreferencedMedia([post({ status: 'draft', content: '<img src="/uploads/2026/08/cat.webp" />' })], LIBRARY);
  eq(r.length, 1);
});

check('servedMediaKeys knows every url a record answers to', () => {
  const keys = [...M.servedMediaKeys(LIBRARY)].sort();
  eq(keys, [
    '/uploads/2026/08/cat-400.webp',
    '/uploads/2026/08/cat-800.webp',
    '/uploads/2026/08/cat.webp',
  ]);
});

if (failures.length) {
  console.error(`\n✗ media-check: ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error(`  · ${f}`);
  process.exit(1);
}
console.log(`✓ media-check: ${passed} passed`);
