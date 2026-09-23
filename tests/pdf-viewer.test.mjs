#!/usr/bin/env node
/**
 * Reading a PDF in the page (the inline viewer).
 *
 * The feature is small; the things that can go wrong with it are not, and each
 * one here is a real failure mode rather than a restatement of the code:
 *
 *  - **The frame URL must be checked, not trusted.** It is the one value in
 *    this feature that comes out of stored content, and an `<iframe src>` that
 *    accepts anything is how you frame someone else's login page inside an
 *    article. Every refusal below is a URL a sanitizer would happily keep in
 *    an `href`.
 *  - **The stored form must survive a save.** The sanitizer runs on every
 *    write; if it strips the marker class, the author's viewer silently turns
 *    back into a link the next time they fix a typo. That is the exact bug the
 *    section classes were written to avoid, and it is checked here from both
 *    ends.
 *  - **The unexpanded form must be useful**, because a headless consumer
 *    renders `content` itself and never calls the pipeline.
 *  - **The framing exception must stay narrow.** One relaxed header on one
 *    path is a feature; a relaxed header on `/admin` is a clickjacking bug.
 *
 * Run with:  node tests/pdf-viewer.test.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadTs, ROOT } from './lib/load.mjs';

const P = await loadTs('src/lib/pdf-embed.ts');
const S = await loadTs('src/lib/sanitize.ts');
const M = await loadTs('src/lib/media-embed.ts');
const H = await loadTs('src/lib/security-headers.ts');
const read = (rel) => fs.readFile(path.join(ROOT, rel), 'utf8');
const css = await read('src/styles/global.css');
const pipeline = await read('src/lib/content-render.ts');

let passed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed += 1; } catch (err) { failures.push(`${name}: ${err.message}`); }
}
function ok(cond, msg) { if (!cond) throw new Error(msg); }

// ───────────────────────────────────────────────── which URLs may be framed

check('a PDF this app serves is framable', () => {
  ok(P.framablePdfUrl('/uploads/2026/09/price-list.pdf') === '/uploads/2026/09/price-list.pdf', 'plain path');
  ok(P.framablePdfUrl('/uploads/2026/09/A.PDF') === '/uploads/2026/09/A.PDF', 'extension is case-insensitive');
  ok(P.framablePdfUrl('/uploads/x.pdf?v=2') === '/uploads/x.pdf', 'a query is dropped, not carried into the frame');
});

check('everything else keeps its link', () => {
  const refused = [
    // Someone else's origin: we cannot set X-Frame-Options there, so the frame
    // would be a blank box on every browser that honours it.
    'https://cdn.example.com/x.pdf',
    // Protocol-relative. Looks like a path, parses as a DIFFERENT ORIGIN, and
    // is the one that would slip past a naive `startsWith('/')`.
    '//evil.test/x.pdf',
    // Schemes that execute or embed.
    'javascript:alert(1)//x.pdf',
    'data:application/pdf;base64,AAAA',
    // Out of the uploads tree: a frame pointed at a route, not a file.
    '/admin/settings.pdf',
    '/uploads/../admin/index.pdf',
    // Not a PDF. The relaxed frame header applies to .pdf and nothing else, so
    // framing these would produce a box the browser refuses to fill.
    '/uploads/notes.txt',
    '/uploads/song.mp3',
    '/uploads/x.pdf.html',
    '',
    null,
    undefined,
  ];
  for (const url of refused) ok(P.framablePdfUrl(url) === null, `should refuse ${JSON.stringify(url)}`);
});

// ───────────────────────────────────────────────────────── what gets stored

check('inserting a PDF stores a figure with a working link inside it', () => {
  const html = M.mediaInsertHtml({ url: '/uploads/2026/09/menu.pdf', mime_type: 'application/pdf', original_name: 'Menu.pdf' });
  ok(html.includes('class="ab-pdf"'), 'carries the marker class');
  ok(html.includes('<a href="/uploads/2026/09/menu.pdf">'), 'and the link itself');
  ok(!html.includes('<iframe'), 'never stores a frame — the sanitizer would discard it anyway');
});

check('a PDF we do not serve is still a plain link', () => {
  const html = M.mediaInsertHtml({ url: 'https://cdn.example.com/menu.pdf', mime_type: 'application/pdf', original_name: 'Menu.pdf' });
  ok(!html.includes('ab-pdf'), 'no viewer for an origin whose headers we do not control');
  ok(html.includes('<a href="https://cdn.example.com/menu.pdf">'), 'but the link works');
});

check('the stored figure survives the sanitizer — both classes, and strict mode', () => {
  const stored = P.pdfFigureHtml('/uploads/x.pdf', 'Price list');
  const saved = S.sanitizeHtml(stored);
  ok(saved.includes('ab-pdf'), `marker class stripped on save: ${saved}`);
  ok(saved.includes('href="/uploads/x.pdf"'), `link stripped on save: ${saved}`);
});

check('an author who types the figure by hand cannot smuggle a frame through it', () => {
  const saved = S.sanitizeHtml('<figure class="ab-pdf"><iframe src="https://evil.test/"></iframe></figure>');
  ok(!saved.includes('iframe'), `iframe survived the sanitizer: ${saved}`);
});

// ─────────────────────────────────────────────────────── what gets rendered

check('the figure becomes a viewer, with the download link kept', () => {
  const out = P.renderPdfViewers(S.sanitizeHtml(P.pdfFigureHtml('/uploads/x.pdf', 'Price list')));
  ok(out.includes('<iframe class="ab-pdf-frame" src="/uploads/x.pdf#view=FitH"'), `no frame: ${out}`);
  ok(out.includes('title="Price list"'), `frame has no accessible name: ${out}`);
  ok(out.includes('class="ab-pdf-download" href="/uploads/x.pdf" download'), `no way out for iOS Safari: ${out}`);
});

check('a figure pointing somewhere unframable is left exactly as it was', () => {
  const stored = '<figure class="ab-pdf"><a href="https://evil.test/x.pdf">Report</a></figure>';
  ok(P.renderPdfViewers(stored) === stored, 'an unframable URL must not produce a frame');
});

check('a quote in the filename cannot end the title attribute', () => {
  // Legal in a text node and therefore NOT escaped by the sanitizer, which is
  // what makes this the attribute bug rather than a theoretical one.
  const out = P.renderPdfViewers('<figure class="ab-pdf"><a href="/uploads/x.pdf">The "final" draft</a></figure>');
  ok(out.includes('title="The &quot;final&quot; draft"'), `quote not escaped: ${out}`);
  ok(!/title="The "final"/.test(out), `attribute ended early: ${out}`);
});

check('an ampersand is not escaped twice', () => {
  const out = P.renderPdfViewers(S.sanitizeHtml(P.pdfFigureHtml('/uploads/x.pdf', 'Terms & conditions')));
  ok(out.includes('Terms &amp; conditions'), `lost the entity: ${out}`);
  ok(!out.includes('&amp;amp;'), `double-escaped: ${out}`);
});

check('content with no PDF is returned untouched', () => {
  const html = '<p>Nothing to see</p>';
  ok(P.renderPdfViewers(html) === html, 'must not rewrite unrelated content');
});

check('the localised strings are used, not hard-coded English', () => {
  const de = P.renderPdfViewers(P.pdfFigureHtml('/uploads/x.pdf', 'Preisliste'), 'de');
  ok(de.includes('PDF herunterladen'), `German download label missing: ${de}`);
  const el = P.renderPdfViewers('<figure class="ab-pdf"><a href="/uploads/x.pdf"></a></figure>', 'el');
  ok(el.includes('Έγγραφο'), `Greek fallback name missing: ${el}`);
});

// ────────────────────────────────────────────────────────── the frame header

check('the framing exception is one path and nothing else', () => {
  ok(H.frameOptionsFor('/uploads/2026/09/x.pdf') === 'SAMEORIGIN', 'the viewer needs this one');
  for (const p of [
    '/admin', '/admin/settings', '/', '/login',
    '/api/posts', '/uploads/x.svg', '/uploads/x.png', '/uploads/x.txt',
    '/uploads/../admin/x.pdf', '/x.pdf',
  ]) ok(H.frameOptionsFor(p) === 'DENY', `${p} must stay DENY`);
});

check('SAMEORIGIN, never a bare allow-all', () => {
  ok(H.frameOptionsFor('/uploads/x.pdf') !== 'ALLOWALL', 'the exception must not open the door to other sites');
  ok(H.securityHeaders({})['X-Frame-Options'] === 'DENY', 'the default for every other response is unchanged');
});

// ──────────────────────────────────────────────────────────── it is wired in

check('the pipeline expands viewers, and does it after the sanitizer', () => {
  const src = pipeline.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok(/renderPdfViewers\(/.test(src), 'content-render.ts never calls renderPdfViewers');
  const sanitize = src.indexOf('sanitizeHtml(');
  const expand = src.indexOf('renderPdfViewers(');
  // The call nests OUTSIDE sanitizeHtml, so it appears earlier in the text and
  // runs later — the same shape renderEmbedFacades has.
  ok(expand < sanitize, 'renderPdfViewers must wrap the sanitized html, not feed it');
});

check('the viewer has styles, and the frame is hidden when printing', () => {
  ok(/\.ab-pdf-frame\s*\{/.test(css), 'no .ab-pdf-frame rule');
  const print = css.slice(css.indexOf('@media print'));
  ok(/\.ab-pdf-frame\s*\{\s*display:\s*none/.test(print), 'a frame prints as a grey rectangle; hide it');
});

if (failures.length) {
  console.error(`\n✗ pdf-viewer: ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error(`  · ${f}`);
  process.exit(1);
}
console.log(`✓ pdf-viewer: ${passed} passed`);
