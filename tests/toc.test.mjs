#!/usr/bin/env node
/**
 * Heading anchors and the table of contents (src/lib/toc.ts).
 *
 * The cases that matter are the ones where a plausible implementation silently
 * points the reader at the wrong place:
 *
 *   · two sections called "Examples" — every anchor after the first collides;
 *   · an id the author wrote, renamed, breaking links that already exist;
 *   · a Greek heading slugifying to nothing;
 *   · an anchor colliding with an id that is not a heading at all.
 *
 * Run with:  node tests/toc.test.mjs
 */
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const cacheDir = path.join(root, 'node_modules', '.cache');
await fs.mkdir(cacheDir, { recursive: true });
const out = path.join(cacheDir, `astrobaas-toc-${process.pid}.mjs`);
await build({
  entryPoints: [path.join(root, 'src/lib/toc.ts')],
  bundle: true, format: 'esm', platform: 'node', packages: 'external',
  outfile: out, logLevel: 'silent',
});
const T = await import(pathToFileURL(out).href);

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
function has(hay, needle, what = '') {
  if (!String(hay).includes(needle)) throw new Error(`${what} expected to contain ${JSON.stringify(needle)}, got ${JSON.stringify(String(hay).slice(0, 200))}`);
}

// ------------------------------------------------------------------ the basics

check('an id is added, as a BARE slug', () => {
  const r = T.buildToc('<h2>How it works</h2>');
  has(r.html, '<h2 id="how-it-works">How it works</h2>');
  eq(r.items, [{ id: 'how-it-works', text: 'How it works', level: 2, depth: 0 }]);
});

check('h1, h5 and h6 are left alone', () => {
  const src = '<h1>Title</h1><h5>Aside</h5><h6>Fine print</h6>';
  const r = T.buildToc(src);
  eq(r.html, src, 'html untouched');
  eq(r.items, []);
});

check('empty input is not an error', () => {
  eq(T.buildToc('').items, []);
  eq(T.buildToc('').html, '');
});

check('content with no headings is returned byte-identical', () => {
  const src = '<p>Just a paragraph, with <em>markup</em>.</p>';
  eq(T.buildToc(src).html, src);
});

// -------------------------------------------------------------- deduplication

check('two headings with the SAME text get distinct anchors', () => {
  // Without this, every "Examples" link in the ToC scrolls to the first one.
  const r = T.buildToc('<h2>Examples</h2><h2>Examples</h2><h2>Examples</h2>');
  eq(r.items.map((i) => i.id), ['examples', 'examples-2', 'examples-3']);
  has(r.html, 'id="examples-2"');
  has(r.html, 'id="examples-3"');
});

check('an anchor never collides with a NON-heading id already in the document', () => {
  // The reader would simply be taken to the figure instead, with nothing to
  // show it went wrong.
  const r = T.buildToc('<figure id="summary"><img src="/a.png" alt=""></figure><h2>Summary</h2>');
  eq(r.items[0].id, 'summary-2');
});

check("an id the AUTHOR wrote is preserved, never regenerated", () => {
  // Links to it exist. Renaming it breaks them silently — the page still loads.
  const r = T.buildToc('<h2 id="legacy-anchor">How it works</h2>');
  eq(r.items[0].id, 'legacy-anchor');
  has(r.html, 'id="legacy-anchor"');
  if (r.html.includes('how-it-works')) throw new Error('regenerated an author id');
});

check('a preserved author id still blocks a later collision', () => {
  const r = T.buildToc('<h2 id="intro">First</h2><h2>Intro</h2>');
  eq(r.items.map((i) => i.id), ['intro', 'intro-2']);
});

// ---------------------------------------------------------------------- text

check('tags inside a heading are stripped for the label and the slug', () => {
  const r = T.buildToc('<h2>How <em>it</em> <strong>works</strong></h2>');
  eq(r.items[0].text, 'How it works');
  eq(r.items[0].id, 'how-it-works');
  has(r.html, '<em>it</em>', 'the heading markup itself survives');
});

check('entities are decoded for the label and the slug', () => {
  const r = T.buildToc('<h2>Sales &amp; Support</h2>');
  eq(r.items[0].text, 'Sales & Support');
  eq(r.items[0].id, 'sales-support', 'not sales-amp-support');
});

check('a double-escaped entity decodes exactly once', () => {
  // &amp;lt; is the TEXT "&lt;", not the character "<". Decoding & first would
  // turn it into a tag-looking string in the ToC label.
  eq(T.buildToc('<h2>&amp;lt;div&amp;gt;</h2>').items[0].text, '&lt;div&gt;');
});

check('an EMPTY heading gets no anchor and no entry', () => {
  // An entry with no label reads as a rendering fault.
  const src = '<h2></h2><h2>  </h2><h2><em></em></h2>';
  eq(T.buildToc(src).items, []);
  eq(T.buildToc(src).html, src);
});

check('a Greek heading gets a usable Latin anchor, not an empty one', () => {
  // slugify transliterates; the version that kept only [a-z0-9] produced ''.
  const r = T.buildToc('<h2>Πώς λειτουργεί</h2>');
  if (!/^[a-z0-9-]+$/.test(r.items[0].id)) throw new Error(`unusable id ${r.items[0].id}`);
  if (r.items[0].id.length < 3) throw new Error(`degenerate id ${r.items[0].id}`);
  eq(r.items[0].text, 'Πώς λειτουργεί', 'the LABEL stays Greek');
});

// --------------------------------------------------------------------- depth

check('depth counts STEPS, so a skipped level does not leave a hole', () => {
  // h2 → h4 is ordinary sloppy authoring. Indenting by two would render a gap
  // where the missing h3 would have been.
  const r = T.buildToc('<h2>A</h2><h4>B</h4>');
  eq(r.items.map((i) => i.depth), [0, 1]);
  eq(r.items.map((i) => i.level), [2, 4]);
});

check('depth returns to zero when the level does', () => {
  const r = T.buildToc('<h2>A</h2><h3>a1</h3><h4>a1a</h4><h2>B</h2><h3>b1</h3>');
  eq(r.items.map((i) => i.depth), [0, 1, 2, 0, 1]);
});

check('a document that STARTS at h3 still starts at depth 0', () => {
  eq(T.buildToc('<h3>A</h3><h3>B</h3>').items.map((i) => i.depth), [0, 0]);
});

// ------------------------------------------------------------------ attributes

check('other attributes on the heading survive the rewrite', () => {
  const r = T.buildToc('<h2 class="lead" data-x="1">Title</h2>');
  has(r.html, 'class="lead"');
  has(r.html, 'data-x="1"');
  has(r.html, 'id="title"');
});

check('an author id is escaped on the way back out', () => {
  // Cannot arise from sanitized input; this function must not be the reason.
  const r = T.buildToc(`<h2 id='a"b'>T</h2>`);
  eq(r.items[0].id, 'a"b');
  if (/id="a"b"/.test(r.html)) throw new Error('unescaped quote written back');
});

check('headings are matched case-insensitively and with odd whitespace', () => {
  const r = T.buildToc('<H2>Upper</H2><h2 >Spaced</h2 >');
  eq(r.items.map((i) => i.id), ['upper', 'spaced']);
});

check('a heading inside a code block is NOT anchored', () => {
  // After sanitizing, markup shown as an example is escaped text, so it must
  // not match — an anchor inside <pre> is invisible and unreachable.
  const src = '<pre><code>&lt;h2&gt;Not a heading&lt;/h2&gt;</code></pre>';
  eq(T.buildToc(src).items, []);
  eq(T.buildToc(src).html, src);
});

// ------------------------------------------------------------------ threshold

check('tocThreshold: 0 means OFF and is the default', () => {
  eq(T.tocThreshold(undefined), 0, 'an install that never set it gets no ToC');
  eq(T.tocThreshold(null), 0);
  eq(T.tocThreshold(''), 0, 'a CLEARED settings field means not set');
  eq(T.tocThreshold(0), 0, 'and an explicit 0 also means off');
  eq(T.tocThreshold('0'), 0);
});

check('tocThreshold clamps rather than trusting stored junk', () => {
  eq(T.tocThreshold(3), 3);
  eq(T.tocThreshold('5'), 5);
  eq(T.tocThreshold(1), 2, 'a one-entry ToC is never useful');
  eq(T.tocThreshold(-4), 0, 'less than none is none');
  eq(T.tocThreshold(999), 20);
  eq(T.tocThreshold(3.9), 3, 'truncated, not rounded up');
  eq(T.tocThreshold('abc'), 0, 'falls back');
  eq(T.tocThreshold('abc', 3), 3, 'to whatever the caller says');
});

// ------------------------------------------------------------------ stability

check('running twice is a no-op — ids are not re-suffixed', () => {
  // The pipeline runs per render. If a second pass saw its own ids as taken and
  // appended -2, every anchor would change on every request.
  const once = T.buildToc('<h2>Examples</h2><h2>Examples</h2>');
  const twice = T.buildToc(once.html);
  eq(twice.html, once.html);
  eq(twice.items.map((i) => i.id), once.items.map((i) => i.id));
});

if (failures.length) {
  console.error(`\n✗ toc: ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error(`  · ${f}`);
  process.exit(1);
}
console.log(`✓ toc: ${passed} passed`);
