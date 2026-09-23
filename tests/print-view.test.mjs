#!/usr/bin/env node
/**
 * The print affordance (C-152).
 *
 * The stylesheet half shipped earlier. What was missing was any way for a
 * reader to find it — and the failure mode of the first half was exactly that:
 * the rules sat in a bundled plugin `ensurePlugins` seeds INACTIVE, so a fresh
 * install printed its whole navigation while the fix waited in a list nobody
 * had opened. These tests exist so the button cannot repeat it.
 *
 * Run with:  node tests/print-view.test.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadTs, ROOT } from './lib/load.mjs';

const P = await loadTs('src/lib/print-view.ts');
const read = (rel) => fs.readFile(path.join(ROOT, rel), 'utf8');
const css = await read('src/styles/global.css');
const button = await read('src/components/public/PrintButton.astro');
const postRoute = await read('src/pages/blog/[slug].astro');
const pageRoute = await read('src/pages/[...slug].astro');
const coreArticle = await read('src/components/public/PostArticle.astro');
const settings = await read('src/pages/admin/settings/index.astro');

/** The chrome that must carry `no-print`, read once. */
const NO_PRINT = new Map();
for (const f of [
  'src/components/public/PublicHeader.astro',
  'src/components/public/PublicFooter.astro',
  'src/components/public/TableOfContents.astro',
  'src/components/public/LocaleSwitcher.astro',
  'src/themes/editorial/Header.astro',
  'src/themes/marquee/Footer.astro',
]) NO_PRINT.set(f, await read(f).catch(() => ''));

let passed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed += 1; } catch (err) { failures.push(`${name}: ${err.message}`); }
}
function ok(cond, msg) { if (!cond) throw new Error(msg); }

/**
 * Source text with its comments removed.
 *
 * "The file must not contain X" is a check that fails on the comment EXPLAINING
 * why the file must not contain X. That has now happened three times in this
 * suite, so it is a helper rather than a lesson each new check re-learns.
 */
function code(src) {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')  // JSX
    .replace(/<!--[\s\S]*?-->/g, '')          // HTML
    .replace(/\/\*[\s\S]*?\*\//g, '')        // block
    .replace(/^\s*(?:\/\/|\s\*).*$/gm, '');    // line, and JSDoc bodies
}

// ───────────────────────────────────────────────────────── the switch

check('DEFAULT ON, and the default lives in exactly one place', () => {
  ok(P.PRINT_BUTTON_DEFAULT === true, 'the default is not on');
  ok(P.printButtonEnabled(undefined) === true, 'an install that never set it gets no button');
  ok(P.printButtonEnabled(null) === true, 'null is not a decision');
});

check('an operator who switches it off gets it off — through TEXT storage too', () => {
  // The relational driver stores settings as TEXT, so `false` comes back as the
  // STRING "false", which is truthy. This has bitten the assistant toggle.
  ok(P.printButtonEnabled(false) === false, 'boolean false');
  ok(P.printButtonEnabled('false') === false, 'the string "false" from SqlStorage');
  ok(P.printButtonEnabled('0') === false, 'the string "0"');
  ok(P.printButtonEnabled(true) === true, 'boolean true');
  ok(P.printButtonEnabled('true') === true, 'the string "true"');
});

check('one key and one default, read through the helper at every call site', () => {
  // `includes('PRINT_BUTTON_SETTING')` and `includes('printButtonEnabled')`
  // are both satisfied by the IMPORT LINE, forever. An audit replaced the
  // helper call with a hand-spelled key and a re-derived default — which also
  // broke the `'0'` case the pure-function test checks so carefully — and this
  // file stayed green.
  //
  // Asserted on the CALL SHAPE, against import-stripped source.
  ok(P.PRINT_BUTTON_SETTING === 'print_button', P.PRINT_BUTTON_SETTING);
  const body = (src) => src.split('\n').filter((l) => !l.trimStart().startsWith('import ')).join('\n');
  for (const [what, src] of [['post route', postRoute], ['page route', pageRoute]]) {
    ok(/printButtonEnabled\(\(await LocalDB\.getSetting\(PRINT_BUTTON_SETTING\)\)\?\.value\)/.test(body(src)),
      `${what} does not read the setting through the helper`);
  }
  ok(/printButtonEnabled\(map\[PRINT_BUTTON_SETTING\]\)/.test(body(settings)),
    'the settings screen re-derives the default itself');
});

check('THE CHROME IS ACTUALLY MARKED no-print', () => {
  // `.no-print` was asserted in exactly ONE component. An audit stripped it
  // from the header, the footer, the contents list, the locale switcher and
  // two theme components — reproducing the original bug, where a fresh install
  // printed its whole navigation — and this file still reported 16 passed.
  //
  // The class does nothing on its own; what matters is that it is ON the
  // chrome. Enumerated, because the failure is one component quietly losing it.
  for (const [what, file] of [
    ['the public header', 'src/components/public/PublicHeader.astro'],
    ['the public footer', 'src/components/public/PublicFooter.astro'],
    ['the contents list', 'src/components/public/TableOfContents.astro'],
    ['the locale switcher', 'src/components/public/LocaleSwitcher.astro'],
    ['the editorial theme header', 'src/themes/editorial/Header.astro'],
    ['the marquee theme footer', 'src/themes/marquee/Footer.astro'],
  ]) {
    ok(NO_PRINT.get(file)?.includes('no-print'), `${what} would print`);
  }
});

// ──────────────────────────────────────────── it reaches every theme

check('THE ROUTES render it, not the article components', () => {
  // Three PostArticle implementations exist (core, editorial, marquee) and only
  // one of them had a share footer. A theme that forgets the button is a theme
  // whose readers cannot print; rendering it outside the slot removes the
  // question.
  ok(/\{printButton && <PrintButton \/>\}/.test(postRoute), 'the post route does not render it');
  ok(/\{printButton && <PrintButton \/>\}/.test(pageRoute), 'the page route does not render it');
});

check('both article routes are covered, and no article route is missed', () => {
  ok(postRoute.includes("from '../../components/public/PrintButton.astro'"), 'post route import');
  ok(pageRoute.includes("from '../components/public/PrintButton.astro'"), 'page route import');
});

// ──────────────────────────────────────────────── the button itself

check('the button removes ITSELF from the printout', () => {
  ok(/class="no-print/.test(button), 'the print button would appear on the paper');
});

check('NO INLINE HANDLER: the CSP has no unsafe-inline', () => {
  // An onclick attribute is dropped by the policy, and the button would then
  // look right and do nothing.
  ok(!/onclick=/i.test(code(button)), 'uses an inline handler');
  ok(button.includes('addEventListener'), 'no listener attached');
  ok(button.includes('window.print()'), 'nothing calls print');
});

check('NO INLINE STYLE either — presentation attributes on the SVG', () => {
  ok(!/\sstyle="/.test(code(button)), 'has a style attribute the CSP will drop');
});

check('the label says PDF, because that is what a reader is looking for', () => {
  ok(/Save as PDF/.test(button), 'the label does not mention PDF');
});

check('THE LABEL IS IN THE PAGE\'S OWN LANGUAGE', () => {
  // The `label` prop existed and NOTHING EVER PASSED IT — a write-only
  // interface, and every Greek and German article carried an English button on
  // both of this project's live installs.
  ok(/publicStrings\(Astro\.locals\.locale\)/.test(button), 'the label is a hardcoded English literal');
  // The CONTENT locale, never `locals.t` — that is the staff member's admin
  // language, and two visitors must get the same bytes for the same URL.
  ok(!/locals\.t\b/.test(code(button)), 'a public string keyed on the admin language');
});

// ──────────────────────────────────────────── the rules it relies on

check('chrome is dropped, and the share row is chrome', () => {
  ok(/<footer class="no-print/.test(coreArticle), 'the share footer still prints');
});

check('the print rules exist and drop .no-print', () => {
  const block = css.slice(css.indexOf('@media print'));
  ok(/\.no-print\s*\{\s*display:\s*none\s*!important/.test(block), 'no-print does not hide');
});

check('EXTERNAL links print their address; internal ones do not', () => {
  const block = css.slice(css.indexOf('@media print'), css.indexOf('@media print') + 2000);
  ok(/a\[href\^="http"\]::after/.test(block), 'external links lose their address on paper');
  ok(/a\[href\^="\/"\]::after[\s\S]{0,80}content:\s*""/.test(block), 'internal hrefs print as noise');
});

check('no server-side PDF, and the reason is written down', () => {
  // A headless Chromium is ~300 MB on every self-host, to produce a file the
  // reader's own browser already makes from this stylesheet.
  ok(/300 MB|Chromium/.test(button), 'the decision is not recorded where the next reader will look');
  for (const bad of ['puppeteer', 'playwright', 'pdfkit', 'wkhtmltopdf']) {
    ok(!code(button).toLowerCase().includes(bad), `${bad} crept in`);
  }
});

// ────────────────────────────────────────────────── it is reachable

check('the setting is on a screen AND survives the save', () => {
  ok(/name="print_button"/.test(settings), 'no checkbox');
  // The save() call lists the fields it posts; a checkbox missing from that
  // list renders, ticks, and silently never saves.
  const saveLine = settings.split('\n').find((l) => l.includes("save(e.target, ['posts_per_page'"));
  ok(saveLine && saveLine.includes("'print_button'"), 'the checkbox is not in the save list');
});

if (failures.length) {
  console.error(`\n✗ print-view: ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error(`  · ${f}`);
  process.exit(1);
}
console.log(`✓ print-view: ${passed} passed`);
