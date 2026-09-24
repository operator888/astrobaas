#!/usr/bin/env node
/**
 * No executable inline script may get its text at request time.
 *
 * Production sends a hash-based Content-Security-Policy with no
 * 'unsafe-inline' (lib/csp-config.ts): script-src lists the hash of every
 * script Astro could see at BUILD time. A `<script set:html={…}>` or
 * `<script define:vars={…}>` is written per request, so nothing can hash it,
 * and the browser refuses to run it.
 *
 * The dev server sends no CSP, so such a page works in development and is dead
 * in production. That is exactly how the collection entries screen
 * (admin/content/[type].astro) shipped: it handed the collection's definition
 * to the page as `window.__CT_DEF__ = …`, and in production the form never
 * rendered and the list sat on "Loading…".
 *
 * Data for a page goes in a NON-executable block instead, which CSP does not
 * govern: `<script type="application/json" set:html={jsonForScript(x)}>`, read
 * with JSON.parse. External scripts (`src=`) are fine too.
 *
 * List-free on purpose: it scans every .astro file, so a new page cannot opt
 * out by not being on a list.
 *
 * Run with:  node tests/csp-inline-scripts.test.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function walk(dir) {
  const out = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(p));
    else if (e.name.endsWith('.astro')) out.push(p);
  }
  return out;
}

/** Opening `<script …>` tags, attributes included (they may span lines). */
function scriptTags(src) {
  const tags = [];
  const re = /<script\b([^>]*)>/g;
  let m;
  while ((m = re.exec(src))) {
    const line = src.slice(0, m.index).split('\n').length;
    tags.push({ attrs: m[1], line });
  }
  return tags;
}

const DATA_TYPE = /\btype\s*=\s*["'](application\/(ld\+)?json)["']/;
const RUNTIME_TEXT = /\b(set:html|set:text|define:vars)\s*=/;

export function offenders(files) {
  const bad = [];
  for (const { file, src } of files) {
    for (const t of scriptTags(src)) {
      if (DATA_TYPE.test(t.attrs)) continue; // not executed: CSP does not apply
      if (RUNTIME_TEXT.test(t.attrs)) bad.push(`${file}:${t.line}  <script${t.attrs.replace(/\s+/g, ' ').slice(0, 90)}>`);
    }
  }
  return bad;
}

let failed = 0;
const ok = (msg) => console.log(`  ✓ ${msg}`);
const fail = (msg) => { failed++; console.log(`  ✗ ${msg}`); };

// The detector itself, on the shapes that matter.
{
  const sample = (src) => offenders([{ file: 'x.astro', src }]).length;
  sample('<script is:inline set:html={`window.__CT_DEF__ = ${x};`}></script>') === 1
    ? ok('flags an inline script whose text is set at request time')
    : fail('missed set:html on an executable script');
  sample('<script define:vars={{ a }}>console.log(a)</script>') === 1
    ? ok('flags define:vars (Astro turns it into an inline script)')
    : fail('missed define:vars');
  sample('<script\n  is:inline\n  set:html={code}\n></script>') === 1
    ? ok('flags it when the attributes span lines')
    : fail('missed a multi-line tag');
  sample('<script id="d" type="application/json" set:html={jsonForScript(x)}></script>') === 0
    ? ok('allows a JSON data block')
    : fail('flagged a JSON data block, which CSP does not govern');
  sample('<script type="application/ld+json" set:html={jsonForScript(x)} />') === 0
    ? ok('allows JSON-LD')
    : fail('flagged JSON-LD');
  sample('<script is:inline src="/captcha.js" defer></script>') === 0
    ? ok('allows an external script')
    : fail('flagged an external script');
}

// The real tree.
const files = await Promise.all((await walk(path.join(ROOT, 'src'))).map(async (f) => ({
  file: path.relative(ROOT, f), src: await fs.readFile(f, 'utf8'),
})));
const bad = offenders(files);
if (bad.length) {
  fail(`${bad.length} executable script(s) get their text at request time; production CSP blocks them:`);
  for (const b of bad) console.log(`      ${b}`);
  console.log('    Put the data in <script type="application/json" set:html={jsonForScript(x)}> and JSON.parse it.');
} else ok(`no executable script gets its text at request time (${files.length} .astro files)`);

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
