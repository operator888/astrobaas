#!/usr/bin/env node
/**
 * Accessibility rules that can be checked without a browser.
 *
 * tests/e2e/a11y.spec.ts runs axe-core against the built site and is the real
 * check. It only sees the pages it visits, though, with the seed data it has.
 * These rules hold for EVERY file, and they fail in seconds instead of after
 * a build:
 *
 *  - the skip link points at something that exists;
 *  - the default palette passes WCAG 2.1 AA, computed rather than assumed —
 *    the previous one was 3.67:1, and every primary button on a fresh install
 *    failed;
 *  - no button is an icon with no name, which a screen reader announces as
 *    just "button".
 *
 * Run with:  node tests/accessibility-static.test.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadTs, ROOT } from './lib/load.mjs';

const read = (rel) => fs.readFile(path.join(ROOT, rel), 'utf8');

let passed = 0;
const failures = [];
async function check(name, fn) {
  try { await fn(); passed += 1; } catch (err) { failures.push(`${name}: ${err.message}`); }
}
function ok(cond, msg) { if (!cond) throw new Error(msg); }

async function astroFiles(dir) {
  const out = [];
  for (const e of await fs.readdir(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await astroFiles(rel));
    else if (rel.endsWith('.astro')) out.push(rel);
  }
  return out;
}

// WCAG relative luminance and contrast ratio.
function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

// ───────────────────────────────────────────────────── the skip link

const base = await read('src/layouts/BaseLayout.astro');
await check('the skip link is the first thing in <body>, and only when a layout asks for it', () => {
  ok(/<body>\s*\{skipLabel && <a href="#main-content" class="ab-skip-link">\{skipLabel\}<\/a>\}/.test(base),
    'BaseLayout does not open <body> with the skip link');
});

const files = [...await astroFiles('src/layouts'), ...await astroFiles('src/pages'), ...await astroFiles('src/themes')];
for (const rel of files) {
  const src = await read(rel);
  if (!/\bskipLabel=\{/.test(src) || rel.endsWith('BaseLayout.astro')) continue;
  await check(`${rel} passes a skip link, so it renders exactly one <main id="main-content">`, () => {
    const n = (src.match(/<main\b[^>]*\bid="main-content"/g) ?? []).length;
    ok(n === 1, `found ${n}; a skip link to nothing is worse than no skip link`);
    ok(/<main\b[^>]*\btabindex="-1"/.test(src), 'the <main> is not focusable, so following the link would not move focus in Safari');
  });
}

await check('both shells actually use the skip link', async () => {
  ok(/skipLabel=\{publicStrings\(locale\)\.skipToContent\}/.test(await read('src/layouts/PublicLayout.astro')), 'PublicLayout does not');
  ok(/skipLabel=\{Astro\.locals\.t\('admin\.chrome\.skipToContent'\)\}/.test(await read('src/layouts/AdminLayout.astro')), 'AdminLayout does not');
});

await check('the skip link is off-screen until focused, and then on it', async () => {
  const css = await read('src/styles/global.css');
  ok(/\.ab-skip-link \{[^}]*top: -100px/.test(css), 'not moved off-screen');
  ok(/\.ab-skip-link:focus \{[^}]*top: 0\.5rem/.test(css), 'not brought back on focus');
  // display:none or visibility:hidden would take it out of the tab order.
  ok(!/\.ab-skip-link \{[^}]*(display: none|visibility: hidden)/.test(css), 'hidden in a way that removes it from the tab order');
});

await check('the skip link speaks the reader\'s language, on the public side and in the admin', async () => {
  const { publicStrings } = await loadTs('src/lib/i18n/public-strings.ts');
  const seen = new Set();
  for (const l of ['en', 'el', 'de']) {
    const s = publicStrings(l).skipToContent;
    ok(typeof s === 'string' && s.trim(), `no public skip text for ${l}`);
    seen.add(s);
    ok(new RegExp(`'admin\\.chrome\\.skipToContent': '[^']+'`).test(await read(`src/locales/${l}/chrome.ts`)), `no admin skip text for ${l}`);
  }
  ok(seen.size === 3, 'the three languages share a string, so at least one is untranslated');
});

// ───────────────────────────────────────────────────── the palette

const AA = 4.5;
for (const [rel, re] of [
  ['src/themes/default/index.ts', /primary: '(#[0-9A-Fa-f]{6})',\s*secondary: '(#[0-9A-Fa-f]{6})',\s*accent: '(#[0-9A-Fa-f]{6})'/],
  ['src/lib/seed-data.ts', /colors: \{ primary: '(#[0-9A-Fa-f]{6})', secondary: '(#[0-9A-Fa-f]{6})', accent: '(#[0-9A-Fa-f]{6})'/],
]) {
  await check(`${rel}: the default colours pass AA as white-text buttons and as text on white`, async () => {
    const m = (await read(rel)).match(re);
    ok(m, 'could not find the default colours');
    for (const [name, hex] of [['primary', m[1]], ['secondary', m[2]], ['accent', m[3]]]) {
      const r = contrast(hex, '#ffffff');
      ok(r >= AA, `${name} ${hex} is ${r.toFixed(2)}:1 against white`);
    }
  });
}

await check('the muted text colour passes AA on white and on the grey page', async () => {
  const css = await read('src/styles/global.css');
  const tokens = await read('src/pages/theme.css.ts');
  const muted = css.match(/--muted-color: (#[0-9a-f]{6});/)?.[1];
  const fallback = tokens.match(/'--muted-color': safe\(c\.muted\) \|\| '(#[0-9a-f]{6})'/)?.[1];
  ok(muted && fallback, 'could not find the muted colour');
  ok(muted === fallback, `global.css says ${muted}, /theme.css falls back to ${fallback}`);
  // bg-gray-100 is 6% of the default text colour over white: #f2f2f3.
  for (const bg of ['#ffffff', '#f2f2f3']) {
    const r = contrast(muted, bg);
    ok(r >= AA, `${muted} on ${bg} is ${r.toFixed(2)}:1`);
  }
});

await check('gray-400 text is darkened on light surfaces but left alone on the dark footer', async () => {
  const css = await read('src/styles/global.css');
  ok(/@layer utilities \{\s*\.text-gray-400:where\(:not\(\.bg-gray-800 \*, \.bg-gray-900 \*\)\) \{ color: var\(--muted-color\); \}/.test(css),
    'the gray-400 remap is missing, no longer spares dark surfaces, or is back outside the utilities layer');
  ok(!/\.text-gray-400[^{]*\{[^}]*!important/.test(css), 'the gray-400 remap is !important again — it would beat hover colours');
});

await check('links inside running text are underlined, not marked by colour alone', async () => {
  const css = await read('src/styles/global.css');
  ok(/:where\(p, li, dd, figcaption, blockquote\) a:is\(\.text-blue-600, \.text-blue-700\):not\(:where\(nav a\)\) \{\s*text-decoration: underline;/.test(css), 'rule missing');
  ok(!/a\[class\*="text-blue-"\]/.test(css), 'a substring match is back — it catches hover:text-blue-600 on every menu link');
});

// ───────────────────────────────────────────────────── names

await check('no <button> in any component is an icon with no name', async () => {
  const bad = [];
  for (const rel of [...files, ...await astroFiles('src/components')]) {
    const src = await read(rel);
    for (const m of src.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
      if (/\baria-label(ledby)?=|\btitle=/.test(m[1])) continue;
      const text = m[2]
        .replace(/<svg[\s\S]*?<\/svg>/g, '')
        .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<[^>]+>/g, '')
        .trim();
      if (!text) bad.push(`${rel}:${src.slice(0, m.index).split('\n').length}`);
    }
  }
  ok(bad.length === 0, `unnamed: ${bad.join(', ')}`);
});

await check('the share links on an article say where they go', async () => {
  const src = await read('src/components/public/PostArticle.astro');
  for (const net of ['X', 'Facebook', 'LinkedIn']) {
    ok(new RegExp(`aria-label="Share on ${net} \\(opens in a new tab\\)"`).test(src), `${net} share link has no name`);
  }
  ok(!/target="_blank" \n/.test(src), 'a share link opens a new tab without rel="noopener"');
});

await check('the fake notifications bell is gone', async () => {
  const src = await read('src/components/admin/AdminHeader.astro');
  ok(!/<!-- Notifications -->/.test(src) && !/bg-red-500 rounded-full/.test(src), 'it is back');
});

if (failures.length) {
  console.error(`\n✗ accessibility-static: ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error(`  · ${f}`);
  process.exit(1);
}
console.log(`✓ accessibility-static: ${passed} passed`);
