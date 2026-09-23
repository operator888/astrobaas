#!/usr/bin/env node
/**
 * Unit tests for the HTML sanitizer (src/lib/sanitize.ts). Self-contained:
 * transpiles the TS source with esbuild in-process, then asserts that known
 * XSS bypasses are neutralized and legitimate markup is preserved.
 *
 * Run with:  npm run test:sanitize
 */
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcPath = path.join(here, '..', 'src', 'lib', 'sanitize.ts');
const cacheDir = path.join(here, '..', 'node_modules', '.cache');
await fs.mkdir(cacheDir, { recursive: true });
const tmp = path.join(cacheDir, `astrocms-sanitize-${process.pid}.mjs`);
// BUNDLE rather than transpile: the sanitizer's allow-list is generated from
// src/core/sections.ts, and a bare transpile leaves that relative import
// pointing at a path that does not exist beside the temp file. `packages:
// 'external'` keeps `sanitize-html` resolving against the real node_modules.
await build({
  entryPoints: [srcPath],
  bundle: true, format: 'esm', platform: 'node', packages: 'external',
  outfile: tmp, logLevel: 'silent',
});
const { sanitizeHtml, sanitizeHeadHtml, lazyLoadContentImages } = await import(pathToFileURL(tmp).href);
await fs.rm(tmp, { force: true });

let pass = 0;
let fail = 0;
function check(name, input, predicate) {
  const out = sanitizeHtml(input);
  if (predicate(out)) {
    pass++;
  } else {
    fail++;
    console.error(`✗ ${name}\n   in:  ${JSON.stringify(input)}\n   out: ${JSON.stringify(out)}`);
  }
}
const noJs = s => !/javascript:/i.test(s) && !/on(error|click|load)/i.test(s);

// --- XSS must be neutralized ---
check('plain javascript: href', '<a href="javascript:alert(1)">x</a>', noJs);
check('tab-split scheme', '<a href="java\tscript:alert(1)">x</a>', noJs);
check('newline-split scheme', '<a href="java\nscript:alert(1)">x</a>', noJs);
check('numeric-entity scheme', '<a href="&#106;avascript:alert(1)">x</a>', noJs);
check('hex-entity scheme', '<a href="&#x6a;avascript:alert(1)">x</a>', noJs);
check('leading-space scheme', '<a href="  javascript:alert(1)">x</a>', noJs);
check('vbscript scheme', '<a href="vbscript:msgbox(1)">x</a>', s => !/vbscript:/i.test(s));
check('onclick attr dropped', '<p onclick="alert(1)">hi</p>', s => s === '<p>hi</p>');
check('onerror img dropped', '<img src=x onerror="alert(1)">', s => noJs(s) && !/onerror/i.test(s));
check('script block removed', '<script>alert(1)</script><p>ok</p>', s => s === '<p>ok</p>');
check('svg+script contents removed', '<svg><script>alert(1)</script></svg><p>hi</p>', s => /<p>hi<\/p>/.test(s) && !/alert/.test(s));
check('iframe removed', '<iframe src="javascript:alert(1)"></iframe><p>x</p>', s => /<p>x<\/p>/.test(s) && !/iframe/i.test(s) && noJs(s));
check('html comment removed', '<!-- <script>alert(1)</script> --><p>ok</p>', s => /<p>ok<\/p>/.test(s) && !/alert/.test(s));
check('data:svg image blocked', '<img src="data:image/svg+xml;base64,PHN2Zz4=">', s => !/data:image\/svg/i.test(s));

// --- Legitimate content must survive ---
check('basic formatting kept', '<p>Hello <strong>world</strong></p>', s => s === '<p>Hello <strong>world</strong></p>');
check('relative link kept', '<a href="/about">About</a>', s => /href="\/about"/.test(s));
check('https link kept', '<a href="https://example.com">e</a>', s => /href="https:\/\/example\.com"/.test(s));
check('data:png image kept', '<img src="data:image/png;base64,iVBORw0KGgo=" alt="x">', s => /data:image\/png/.test(s));
check('list kept', '<ul><li>a</li><li>b</li></ul>', s => s === '<ul><li>a</li><li>b</li></ul>');
check('mailto kept', '<a href="mailto:a@b.com">mail</a>', s => /href="mailto:a@b\.com"/.test(s));

// --- sanitizeHeadHtml (plugin head_tags output) ---
function checkHead(name, input, predicate) {
  const out = sanitizeHeadHtml(input);
  if (predicate(out)) { pass++; }
  else { fail++; console.error(`✗ ${name}\n   in:  ${JSON.stringify(input)}\n   out: ${JSON.stringify(out)}`); }
}
checkHead('head: keeps meta', '<meta name="x" content="y">', s => /<meta[^>]*name="x"/.test(s));
checkHead('head: keeps preconnect link', '<link rel="preconnect" href="https://fonts.gstatic.com">', s => /<link[^>]*preconnect/.test(s));
checkHead('head: strips script', '<script>alert(1)</script><meta name="ok" content="1">', s => !/script/i.test(s) && /name="ok"/.test(s));
checkHead('head: strips onload/handlers', '<meta name="x" content="y" onload="alert(1)">', s => !/onload/i.test(s));
checkHead('head: drops protocol-relative link href', '<link rel="x" href="//evil.com/x.css">', s => !/evil\.com/.test(s));

// ---- GHSA-vccv-cmxp-4j9h: sanitize-html <=2.17.4 let `javascript:` through
// action/formaction/data/poster/background, which its URI check did not cover.
// We run a patched version, but the real defence is the strict allow-list: none
// of those attributes — nor the tags that carry them — are permitted. Pinning
// the advisory's own vectors here means a later "just allow <form>" or a
// widened attribute list fails loudly instead of quietly reopening stored XSS.
{
  const vectors = [
    ['form action', '<form action="javascript:alert(1)"><p>x</p></form>'],
    ['button formaction', '<button formaction="javascript:alert(1)">x</button>'],
    ['object data', '<object data="javascript:alert(1)"></object>'],
    ['video poster', '<video poster="javascript:alert(1)"></video>'],
    ['body background', '<div background="javascript:alert(1)">x</div>'],
    ['input formaction', '<input type="submit" formaction="javascript:alert(1)">'],
    // Same trick with the entity/whitespace obfuscation the advisory relies on.
    ['obfuscated formaction', '<button formaction="  java\tscript:alert(1)">x</button>'],
  ];
  for (const [name, html] of vectors) {
    check(`GHSA-vccv-cmxp-4j9h: ${name}`, html, (out) =>
      !/javascript:/i.test(out) &&
      !/\b(formaction|action|poster|background)\s*=/i.test(out));
  }
}

/* ---------------- what the editor emits must survive the save ---------------- */
{
  // Two of thirteen toolbar buttons silently destroyed their own output: the
  // alignment buttons emitted style="text-align:..." (stripped), and sub/sup
  // were not in the allowed tags, so "10 m2" lost its superscript on a live
  // optical site. An editor that shows the author one thing and stores another
  // is broken regardless of what the homepage claims.
  //
  // These assert the ROUND TRIP: what the toolbar produces is what comes back.
  const unchanged = (input) => (out) => out === input;

  const roundTrips = [
    ['centre alignment survives a save', '<p class="ab-text-center">centred</p>'],
    ['right alignment survives a save', '<p class="ab-text-right">right</p>'],
    ['left alignment survives a save', '<p class="ab-text-left">left</p>'],
    ['superscript survives (m2, footnotes)', '<p>10 m<sup>2</sup></p>'],
    ['subscript survives (H2O, formulae)', '<p>H<sub>2</sub>O</p>'],
    ['highlight survives', '<p><mark>note</mark></p>'],
  ];
  for (const [name, html] of roundTrips) check(name, html, unchanged(html));

  // The old behaviour, pinned so nobody reintroduces it: inline style and the
  // legacy align attribute are still refused. The fix was to change what the
  // EDITOR emits, not to weaken the sanitizer.
  check('inline text-align is still stripped', '<p style="text-align:center">x</p>',
    (out) => out === '<p>x</p>');
  check('the legacy align attribute is still stripped', '<div align="center">x</div>',
    (out) => out === '<div>x</div>');

  // The class allow-list must not become a general class channel: a pasted
  // utility class could otherwise cover the page.
  check('an unlisted class is dropped', '<p class="fixed inset-0 z-50">x</p>',
    (out) => out === '<p>x</p>');
  check('an unlisted class is dropped even beside an allowed one',
    '<p class="ab-text-center fixed inset-0">x</p>',
    (out) => out === '<p class="ab-text-center">x</p>');
  check('a script is still refused outright',
    '<p class="ab-text-center">x</p><script>alert(1)</script>',
    (out) => !/script/i.test(out));
}

/* ---- content images get loading hints, and the first one does NOT ---- */
{
  // This file's `check` sanitizes its input for you, which is not what these
  // assertions are about, so they use a plain boolean helper.
  const is = (name, cond) => {
    if (cond) pass++;
    else { fail++; console.error(`\u2717 ${name}`); }
  };

  const two = lazyLoadContentImages('<p>a</p><img src="/a.png" alt="a"><p>b</p><img src="/b.png" alt="b">');
  const cut = two.indexOf('<p>b</p>');
  const first = two.slice(0, cut);
  const second = two.slice(cut);
  // The first image in a body is usually just below the fold and is often the
  // LCP element on a page with no featured image. Lazy-loading the LCP delays
  // the very measurement it looks like it is helping.
  is('the first content image is NOT lazy', !first.includes('loading="lazy"'));
  is('...but is decoded off the main thread', first.includes('decoding="async"'));
  is('the second IS lazy', second.includes('loading="lazy"'));

  // An author or importer that set loading explicitly knew what it wanted.
  const explicit = lazyLoadContentImages('<img src="/1.png"><img src="/2.png" loading="eager">');
  is('an explicit loading attribute is never overridden',
    (explicit.match(/loading="eager"/g) || []).length === 1);
  is('...and is not doubled up', !/loading="[^"]*"\s+loading=/.test(explicit));

  is('self-closing tags stay well formed',
    lazyLoadContentImages('<img src="/1.png" /><img src="/2.png" />').includes('/>'));
  is('content with no images is returned untouched',
    lazyLoadContentImages('<p>hello</p>') === '<p>hello</p>');
  is('empty input does not throw', lazyLoadContentImages('') === '');

  // THE MUTATION THAT MATTERS: the hints are only useful if the sanitizer keeps
  // them. Allowing an attribute the sanitizer strips is the editor-shows-it /
  // storage-drops-it split, and it would look like it worked.
  const survives = sanitizeHtml('<img src="/a.png" alt="a" loading="lazy" decoding="async">');
  is('the sanitizer PRESERVES loading', survives.includes('loading="lazy"'));
  is('the sanitizer PRESERVES decoding', survives.includes('decoding="async"'));
  is('...while onerror is still stripped',
    !sanitizeHtml('<img src="/a.png" onerror="alert(1)">').includes('onerror'));
  is('...and a javascript: src is still refused',
    !sanitizeHtml('<img src="javascript:alert(1)">').includes('javascript:'));
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
