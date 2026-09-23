#!/usr/bin/env node
/**
 * width/height on content images (src/lib/image-dimensions.ts) — the CLS fix.
 *
 * The failure this prevents is invisible in a screenshot: a body image with no
 * dimensions reserves zero height, so every paragraph below it jumps down when
 * the file arrives. The failures it must NOT introduce are visible and worse —
 * a distorted image, or a box of infinite height from a width/0 ratio.
 *
 * Run with:  node tests/image-dimensions.test.mjs
 */
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const cacheDir = path.join(root, 'node_modules', '.cache');
await fs.mkdir(cacheDir, { recursive: true });
const out = path.join(cacheDir, `astrobaas-imgdim-${process.pid}.mjs`);
await build({
  entryPoints: [path.join(root, 'src/lib/image-dimensions.ts')],
  bundle: true, format: 'esm', platform: 'node', packages: 'external',
  outfile: out, logLevel: 'silent',
});
const D = await import(pathToFileURL(out).href);

let passed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed += 1; }
  catch (err) { failures.push(`${name}: ${err.message}`); }
}
function eq(actual, expected, what = '') {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what} expected ${e}, got ${a}`);
}

const sizes = new Map([
  ['/uploads/photo.webp', { width: 1600, height: 900 }],
  ['/uploads/square.webp', { width: 800, height: 800 }],
]);

// --------------------------------------------------------- normaliseImageKey

check('a plain site-root path is its own key', () => {
  eq(D.normaliseImageKey('/uploads/a.webp'), '/uploads/a.webp');
});

check('an absolute URL on any host reduces to its path', () => {
  // A decoupled storefront's editor stores absolute URLs; the media record
  // stores paths. Keying on the raw attribute would miss every one of them.
  eq(D.normaliseImageKey('https://shop.example.com/uploads/a.webp'), '/uploads/a.webp');
});

check('a cache-busting query is not a different image', () => {
  eq(D.normaliseImageKey('/uploads/a.webp?v=2'), '/uploads/a.webp');
  eq(D.normaliseImageKey('/uploads/a.webp#top'), '/uploads/a.webp');
});

check('a percent-encoded path matches the record that stored it plainly', () => {
  eq(D.normaliseImageKey('/uploads/my%20photo.webp'), '/uploads/my photo.webp');
});

check('a malformed escape does not throw', () => {
  eq(D.normaliseImageKey('/uploads/%E0%A4%A.webp'), '/uploads/%E0%A4%A.webp');
});

check('data: URIs and protocol-relative hosts get NO key', () => {
  // We do not know their dimensions, and guessing distorts the image.
  eq(D.normaliseImageKey('data:image/png;base64,iVBOR'), '');
  eq(D.normaliseImageKey('//cdn.example.com/a.webp'), '');
  eq(D.normaliseImageKey(''), '');
  eq(D.normaliseImageKey('relative.webp'), '');
});

// ------------------------------------------------------ collectImageSources

check('sources are collected, normalised and deduplicated', () => {
  const html = '<img src="/uploads/a.webp"><p>x</p><img src="/uploads/a.webp?v=9"><img src="https://x.test/uploads/b.webp">';
  eq(D.collectImageSources(html), ['/uploads/a.webp', '/uploads/b.webp']);
});

check('html with no images costs nothing', () => {
  eq(D.collectImageSources('<p>no pictures here</p>'), []);
  eq(D.collectImageSources(''), []);
});

// ----------------------------------------------------- applyImageDimensions

check('a body image gets the file\'s own width and height', () => {
  const r = D.applyImageDimensions('<p><img src="/uploads/photo.webp" alt="x"></p>', sizes);
  eq(r, '<p><img src="/uploads/photo.webp" alt="x" width="1600" height="900"></p>');
});

check('a self-closing tag stays self-closing', () => {
  const r = D.applyImageDimensions('<img src="/uploads/square.webp" />', sizes);
  eq(r, '<img src="/uploads/square.webp" width="800" height="800" />');
});

check('an image the media library does not know is left alone', () => {
  const html = '<img src="/uploads/unknown.webp">';
  eq(D.applyImageDimensions(html, sizes), html);
});

check('an image that ALREADY has either attribute is left entirely alone', () => {
  // Combining the author's number with the file's own produces a ratio that
  // matches nothing — a distorted image, which reads as a broken upload.
  const a = '<img src="/uploads/photo.webp" width="300">';
  const b = '<img src="/uploads/photo.webp" height="200">';
  eq(D.applyImageDimensions(a, sizes), a);
  eq(D.applyImageDimensions(b, sizes), b);
});

check('an empty map is a no-op, not a rewrite', () => {
  const html = '<img src="/uploads/photo.webp">';
  eq(D.applyImageDimensions(html, new Map()), html);
});

check('single-quoted src is matched too', () => {
  const r = D.applyImageDimensions(`<img src='/uploads/photo.webp'>`, sizes);
  if (!r.includes('width="1600"')) throw new Error(r);
});

check('other attributes survive untouched', () => {
  const r = D.applyImageDimensions('<img src="/uploads/photo.webp" loading="lazy" decoding="async" class="rounded">', sizes);
  for (const bit of ['loading="lazy"', 'decoding="async"', 'class="rounded"', 'width="1600"', 'height="900"']) {
    if (!r.includes(bit)) throw new Error(`lost ${bit}: ${r}`);
  }
});

check('running twice changes nothing the second time', () => {
  const once = D.applyImageDimensions('<img src="/uploads/photo.webp">', sizes);
  eq(D.applyImageDimensions(once, sizes), once);
});

// ------------------------------------------------------------ sizesFromMedia

check('sizes come from the record AND its derivatives', () => {
  // An author who inserted a smaller derivative gets that file's dimensions,
  // not the original's.
  const m = D.sizesFromMedia([{
    url: '/uploads/a.webp', width: 1600, height: 900,
    variants: [{ url: '/uploads/a-400.webp', width: 400, height: 225 }],
  }]);
  eq(m.get('/uploads/a.webp'), { width: 1600, height: 900 });
  eq(m.get('/uploads/a-400.webp'), { width: 400, height: 225 });
});

check('a record with a width and NO height is skipped', () => {
  // Happens when sharp was unavailable at upload. width/0 makes the browser
  // reserve a box of infinite height — far worse than reserving none.
  const m = D.sizesFromMedia([
    { url: '/uploads/a.webp', width: 1600 },
    { url: '/uploads/b.webp', width: 1600, height: 0 },
    { url: '/uploads/c.webp', width: -5, height: 10 },
    { url: '/uploads/d.webp' },
  ]);
  eq(m.size, 0);
});

check('a non-image upload with no url is skipped rather than throwing', () => {
  const m = D.sizesFromMedia([{ width: 10, height: 10 }, null].filter(Boolean));
  eq(m.size, 0);
});

check('the `wanted` filter keeps the map to what the document actually uses', () => {
  // A shop with thousands of media rows must not build a map of all of them to
  // answer a question about three.
  const media = [
    { url: '/uploads/a.webp', width: 10, height: 10 },
    { url: '/uploads/b.webp', width: 20, height: 20 },
  ];
  const m = D.sizesFromMedia(media, new Set(['/uploads/b.webp']));
  eq([...m.keys()], ['/uploads/b.webp']);
});

check('end to end: collect, look up, apply', () => {
  const html = '<p>a</p><img src="https://cdn.test/uploads/a.webp?v=3" alt=""><p>b</p>';
  const media = [{ url: '/uploads/a.webp', width: 1200, height: 600 }];
  const wanted = new Set(D.collectImageSources(html));
  const r = D.applyImageDimensions(html, D.sizesFromMedia(media, wanted));
  if (!r.includes('width="1200" height="600"')) throw new Error(r);
  if (!r.includes('src="https://cdn.test/uploads/a.webp?v=3"')) throw new Error('rewrote the src');
});

// ─────────────────────────────────────────────── alt text (C-62)

const ALTS = new Map([['/uploads/photo.webp', 'A cat on a windowsill']]);

check('a missing alt is filled from the media library', () => {
  const r = D.applyImageAltText('<img src="/uploads/photo.webp">', ALTS);
  eq(r, '<img src="/uploads/photo.webp" alt="A cat on a windowsill">');
});

check('an EXPLICITLY EMPTY alt is never overwritten', () => {
  // alt="" marks a decorative image. Filling it makes a screen reader announce
  // a caption on every spacer — an accessibility regression dressed as a fix.
  const html = '<img src="/uploads/photo.webp" alt="">';
  eq(D.applyImageAltText(html, ALTS), html);
});

check("an author's own alt is never overwritten", () => {
  const html = '<img src="/uploads/photo.webp" alt="Their words">';
  eq(D.applyImageAltText(html, ALTS), html);
});

check('an image the library does not know is left alone', () => {
  const html = '<img src="/uploads/unknown.webp">';
  eq(D.applyImageAltText(html, ALTS), html);
});

check('alt text is escaped on the way into the attribute', () => {
  const r = D.applyImageAltText('<img src="/a.webp">', new Map([['/a.webp', 'He said "hi" & <left>']]));
  if (!r.includes('&quot;hi&quot;')) throw new Error(r);
  if (!r.includes('&amp;')) throw new Error(r);
  if (r.includes('<left>')) throw new Error(`unescaped angle bracket: ${r}`);
});

check('a self-closing tag stays self-closing', () => {
  eq(D.applyImageAltText('<img src="/uploads/photo.webp" />', ALTS),
     '<img src="/uploads/photo.webp" alt="A cat on a windowsill" />');
});

check('an empty map is a no-op', () => {
  const html = '<img src="/uploads/photo.webp">';
  eq(D.applyImageAltText(html, new Map()), html);
});

check('altFromMedia keys every url the record answers to', () => {
  // An author who inserted the 400px derivative described the same picture.
  const m = D.altFromMedia([{
    url: '/uploads/a.webp', thumb_url: '/uploads/a-400.webp', alt_text: 'A cat',
    variants: [{ url: '/uploads/a-800.webp' }],
  }]);
  eq(m.get('/uploads/a.webp'), 'A cat');
  eq(m.get('/uploads/a-400.webp'), 'A cat');
  eq(m.get('/uploads/a-800.webp'), 'A cat');
});

check('altFromMedia skips records with no description', () => {
  eq(D.altFromMedia([{ url: '/a.webp' }, { url: '/b.webp', alt_text: '   ' }]).size, 0);
});

check('imagesMissingAlt reports only a MISSING attribute', () => {
  const html = '<img src="/a.webp"><img src="/b.webp" alt=""><img src="/c.webp" alt="described">';
  eq(D.imagesMissingAlt(html), ['/a.webp']);
});

check('imagesMissingAlt names an image with no src at all', () => {
  eq(D.imagesMissingAlt('<img>'), ['(no src)']);
  eq(D.imagesMissingAlt('<p>no images</p>'), []);
});

check('dimensions and alt compose without fighting each other', () => {
  const r = D.applyImageAltText(D.applyImageDimensions('<img src="/uploads/photo.webp">', sizes), ALTS);
  if (!r.includes('width="1600"')) throw new Error(r);
  if (!r.includes('alt="A cat on a windowsill"')) throw new Error(r);
});

if (failures.length) {
  console.error(`\n✗ image-dimensions: ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error(`  · ${f}`);
  process.exit(1);
}
console.log(`✓ image-dimensions: ${passed} passed`);
