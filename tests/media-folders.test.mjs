#!/usr/bin/env node
/**
 * Media folders (C-61), branding (C-159) and the table/video sections (C-45, C-64).
 *
 * The folder half is a WRITE-ONLY PHANTOM being finished: `PATCH
 * /api/media/update` has accepted and stored a `folder` since it was written,
 * and nothing ever read it — the field was absent from `MediaFile`, so it was
 * invisible to every typed reader, and no filter existed to find it. That is
 * the schema-versus-reader shape this codebase keeps producing, so the writer
 * and the filter now share one normaliser rather than spelling the rule twice.
 *
 * Run with:  node tests/media-folders.test.mjs
 */
import { loadTs } from './lib/load.mjs';

const F = await loadTs('src/lib/media/folders.ts');
const B = await loadTs('src/lib/branding.ts');
const S = await loadTs('src/lib/sanitize.ts');
const SEC = await loadTs('src/core/sections.ts');

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

// ───────────────────────────────────────────────────────────── folders

check('the writer and the filter agree, because they are one function', () => {
  // The rule cannot be spelled twice, so a patched folder cannot be invisible
  // to the filter meant to find it.
  const stored = F.cleanFolderName('  Product   shots  ');
  eq(stored, 'Product shots');
  eq(F.inFolder([{ folder: stored }], '  Product   shots  ').length, 1);
});

check('a label is not a path', () => {
  // A slash reads as a directory, and this is a label on a record — the file
  // never moves on disk.
  eq(F.cleanFolderName('a/b'), 'a b');
  eq(F.cleanFolderName('..\\..\\etc'), '.. .. etc');
});

check('markup characters are removed — the label is rendered in the admin', () => {
  // The slash goes to a space too, and consecutive spaces collapse.
  eq(F.cleanFolderName('<b>x</b>'), 'b x b');
  if (F.cleanFolderName('a"b').includes('"')) throw new Error('kept a quote');
});

check('a non-string is not a folder', () => {
  for (const v of [null, undefined, 42, {}, []]) eq(F.cleanFolderName(v), '');
});

check('a long label is cut, not refused', () => {
  eq(F.cleanFolderName('x'.repeat(500)).length, F.MAX_FOLDER_NAME);
});

check('THE UNFILED BUCKET is a real answer, not the absence of one', () => {
  // `?folder=` with an empty value means "show me what is unfiled", which is
  // not the same request as "show me everything".
  const lib = [{ folder: 'Shots' }, { folder: '' }, {}];
  eq(F.inFolder(lib, '').length, 2);
  eq(F.inFolder(lib, 'Shots').length, 1);
});

check('folderCounts puts the unfiled bucket first and sorts the rest', () => {
  const lib = [{ folder: 'Zebra' }, {}, { folder: 'Apple' }, { folder: 'Apple' }];
  eq(F.folderCounts(lib), [
    { name: '', count: 1 },
    { name: 'Apple', count: 2 },
    { name: 'Zebra', count: 1 },
  ]);
});

check('a library with everything filed shows no unfiled bucket', () => {
  eq(F.folderCounts([{ folder: 'A' }]), [{ name: 'A', count: 1 }]);
  eq(F.folderCounts([]), []);
});

// ──────────────────────────────────────────────────────────── branding

check('an install that configured nothing is byte-identical', () => {
  eq(B.resolveBranding({}), { name: 'AstroBaaS', logo: null });
  eq(B.resolveBranding(null).name, 'AstroBaaS');
});

check('the fallback chain is admin_name, then site_title, then the product', () => {
  // An install that set only a site title gets that, rather than a second
  // field to fill in with the same word.
  eq(B.resolveBranding({ site_title: 'Οπτική Γωνία' }).name, 'Οπτική Γωνία');
  eq(B.resolveBranding({ site_title: 'Οπτική Γωνία', admin_name: 'Back office' }).name, 'Back office');
});

check('a THIRD-PARTY logo url is refused', () => {
  // A settings value that pulls an image from another server puts a request
  // the operator never made on a screen behind their staff's login.
  eq(B.resolveBranding({ admin_logo: 'https://evil.example/logo.png' }).logo, null);
  eq(B.resolveBranding({ admin_logo: '//evil.example/logo.png' }).logo, null);
  eq(B.resolveBranding({ admin_logo: 'logo.png' }).logo, null);
  eq(B.resolveBranding({ admin_logo: '/uploads/2026/01/logo.png' }).logo, '/uploads/2026/01/logo.png');
});

// ─────────────────────────────────────────────────────── tables (C-45)

check('a table keeps its CAPTION', () => {
  // Without `caption` on the allow-list the element was DISCARDED and its text
  // kept — a bare text node inside <table>, which every browser foster-parents
  // OUT, so the caption silently reappeared above the table as loose text.
  const html = '<table><caption>Prices</caption><tbody><tr><td>1</td></tr></tbody></table>';
  if (!S.sanitizeHtml(html).includes('<caption>Prices</caption>')) {
    throw new Error(S.sanitizeHtml(html));
  }
});

check('colgroup, col and tfoot survive', () => {
  const html = '<table><colgroup><col /></colgroup><tfoot><tr><td>t</td></tr></tfoot></table>';
  const out = S.sanitizeHtml(html);
  for (const tag of ['colgroup', 'col', 'tfoot']) {
    if (!out.includes(`<${tag}`)) throw new Error(`${tag} lost: ${out}`);
  }
});

check('scope and headers survive, so a screen reader can navigate', () => {
  const out = S.sanitizeHtml('<table><tr><th scope="col" headers="a">A</th></tr></table>');
  if (!out.includes('scope="col"')) throw new Error(out);
});

check('AN ABSURD SPAN IS CLAMPED, not dropped', () => {
  // A pasted colspan="100000" reserves the columns and makes the page
  // unusable. Clamping keeps a genuine merge and makes an absurd one sane;
  // dropping would silently unmerge a table somebody built.
  const out = S.sanitizeHtml('<table><tr><td colspan="100000">x</td></tr></table>');
  if (!/colspan="100"/.test(out)) throw new Error(out);
  const ok = S.sanitizeHtml('<table><tr><td colspan="3">x</td></tr></table>');
  if (!/colspan="3"/.test(ok)) throw new Error(ok);
});

check('a nonsense span is removed', () => {
  for (const v of ['abc', '-1', '0']) {
    const out = S.sanitizeHtml(`<table><tr><td colspan="${v}">x</td></tr></table>`);
    if (/colspan/.test(out)) throw new Error(`${v}: ${out}`);
  }
});

check('colspan is NOT allowed on a div — the wildcard was not widened', () => {
  // Widening `'*'` is how an allow-list rots.
  if (/colspan/.test(S.sanitizeHtml('<div colspan="2">x</div>'))) throw new Error('leaked onto a div');
});

// ──────────────────────────────────────── the new sections round-trip

check('every section template survives the sanitizer BYTE-IDENTICALLY', () => {
  // The invariant the whole vocabulary rests on: a section the palette can
  // insert must not be altered on save, or the editor and the page disagree
  // about what the author chose.
  for (const s of SEC.SECTIONS) {
    const out = S.sanitizeHtml(s.template);
    if (out !== s.template) throw new Error(`${s.name}:\n  in:  ${s.template}\n  out: ${out}`);
  }
});

check('the table and video sections exist and are in the class allow-list', () => {
  const names = SEC.SECTIONS.map((s) => s.name);
  for (const want of ['table', 'video']) {
    if (!names.includes(want)) throw new Error(`no ${want} section`);
  }
  const classes = SEC.sectionClassList();
  for (const want of ['ab-table', 'ab-video', 'ab-table-striped', 'ab-video-16x9']) {
    if (!classes.includes(want)) throw new Error(`${want} is not allow-listed`);
  }
});

check('the vocabulary VERSION moved, so a stale theme can be told', () => {
  // A theme compiled against version 1 has no styles for ab-table or ab-video,
  // and a version that never moves cannot say so.
  if (SEC.SECTION_VOCAB_VERSION < 2) throw new Error(String(SEC.SECTION_VOCAB_VERSION));
});

if (failures.length) {
  console.error(`\n✗ media-folders: ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error(`  · ${f}`);
  process.exit(1);
}
console.log(`✓ media-folders: ${passed} passed`);
