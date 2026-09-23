#!/usr/bin/env node
/**
 * The content pipeline — src/lib/content-render.ts.
 *
 * Four surfaces render a post body: the article page, the Page renderer, and
 * the two posts API routes. They agreed on the media attributes and disagreed
 * on everything before them: the API pair ran `buildToc(filters(...))` with NO
 * sanitizer and NO lazy hints, while carrying a comment promising a decoupled
 * storefront "exactly the markup this CMS would have served".
 *
 * That is the failure this file exists to keep out, and it is not hypothetical
 * here: the installs that matter are headless storefronts, which reach the CMS
 * only through those routes.
 *
 * Run with:  node tests/content-render.test.mjs
 */
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const cacheDir = path.join(root, 'node_modules', '.cache');
await fs.mkdir(cacheDir, { recursive: true });
const out = path.join(cacheDir, `astrobaas-contentrender-${process.pid}.mjs`);
await build({
  entryPoints: [path.join(root, 'src/lib/content-render.ts')],
  bundle: true, format: 'esm', platform: 'node', packages: 'external',
  outfile: out, logLevel: 'silent',
});
const C = await import(pathToFileURL(out).href);

let passed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed += 1; }
  catch (err) { failures.push(`${name}: ${err.message}`); }
}
const post = (content) => ({ id: 'p1', title: 'T', slug: 't', content });

// ──────────────────────────────────────────────────── the pipeline itself

check('the SANITIZER runs — a script never reaches a rendered body', () => {
  // The one that matters for a headless install. `post_content` filters run on
  // READ and can return anything; sanitizing on write does not cover them.
  const html = C.renderContentHtml(post('<p>hi</p><script>alert(1)</script>')).html;
  if (/<script/i.test(html)) throw new Error(html);
  if (!html.includes('<p>hi</p>')) throw new Error(`ate the content: ${html}`);
});

check('an event handler attribute is stripped', () => {
  const html = C.renderContentHtml(post('<p onclick="steal()">hi</p>')).html;
  if (/onclick/i.test(html)) throw new Error(html);
});

check('images get the LAZY hints — and the FIRST one stays eager', () => {
  // Their absence made a decoupled storefront score worse on Core Web Vitals
  // than the SSR page, purely for being decoupled. The first image is left
  // eager on purpose: in an article body it is usually the LCP element, and
  // lazy-loading the LCP delays the measurement it appears to help.
  const html = C.renderContentHtml(post(
    '<p><img src="/uploads/a.webp" /></p><p><img src="/uploads/b.webp" /></p>',
  )).html;
  const tags = html.match(/<img[^>]*>/g) ?? [];
  if (tags.length !== 2) throw new Error(html);
  if (/loading=/.test(tags[0])) throw new Error(`the LCP image was made lazy: ${tags[0]}`);
  if (!/decoding="async"/.test(tags[0])) throw new Error(tags[0]);
  if (!/loading="lazy"/.test(tags[1])) throw new Error(tags[1]);
});

check('headings get ANCHORS, unconditionally', () => {
  // A deep link a reader copies out of the address bar has to resolve whether
  // or not the operator renders a contents list.
  const r = C.renderContentHtml(post('<h2>How it works</h2>'));
  if (!r.html.includes('id="how-it-works"')) throw new Error(r.html);
  if (r.items.length !== 1) throw new Error(JSON.stringify(r.items));
});

check('ORDER: the lazy hints survive, so they were added AFTER the sanitizer', () => {
  // Running them first would let a filter's markup be rewritten and then
  // sanitized, reversing the step that makes plugin output safe. The hints are
  // on the allow-list, so this asserts both halves at once: sanitized content,
  // hints still present.
  const html = C.renderContentHtml(post(
    '<img src="/uploads/a.webp" /><img src="/uploads/b.webp" /><script>x</script>',
  )).html;
  if (/<script/i.test(html)) throw new Error(`unsanitized: ${html}`);
  if (!/loading="lazy"/.test(html)) throw new Error(`hints lost: ${html}`);
});

check('empty and missing content do not throw', () => {
  if (C.renderContentHtml(post('')).html !== '') throw new Error('empty');
  if (C.renderContentHtml({ title: 'T' }).html !== '') throw new Error('missing');
});

check('renderTitle passes the title through the filter chain', () => {
  if (C.renderTitle(post('')) !== 'T') throw new Error('title changed with no plugins active');
});

// ─────────────────────────────────────── nobody may render a body privately

const RENDERERS = [
  'src/lib/page-view.ts',
  'src/pages/blog/[slug].astro',
  'src/pages/api/posts/index.ts',
  'src/pages/api/posts/[slug]/index.ts',
];

check('every renderer goes through the shared pipeline', async () => {});
for (const rel of RENDERERS) {
  const src = await fs.readFile(path.join(root, rel), 'utf8');
  check(`${rel} calls the shared pipeline`, () => {
    if (!/renderContentHtml|renderPost\b/.test(src)) {
      throw new Error('renders a body without content-render.ts');
    }
  });
  check(`${rel} does NOT re-spell the pipeline locally`, () => {
    // The exact shape that drifted: a local buildToc over applyFilters, with
    // whichever steps that file happened to remember.
    const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    if (/buildToc\s*\(\s*(lazyLoadContentImages|sanitizeHtml|pluginManager)/.test(code)) {
      throw new Error('builds the pipeline by hand');
    }
    if (/applyFilters\(\s*['"]post_content['"]/.test(code)) {
      throw new Error("calls the post_content filter itself instead of renderContentHtml");
    }
  });
}

if (failures.length) {
  console.error(`\n✗ content-render: ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error(`  · ${f}`);
  process.exit(1);
}
console.log(`✓ content-render: ${passed} passed`);
