#!/usr/bin/env node
/**
 * Inserting media into a post body (C-40) — src/lib/media-embed.ts and
 * src/lib/editor-insert.ts.
 *
 * Two failure modes shape everything here:
 *
 *   · markup the SANITIZER rejects. The output is re-sanitized at the render
 *     boundary, so anything outside the allow-list is silently dropped —
 *     visible in the editor, missing on the page, nothing logged.
 *   · an insert that skips the hidden-textarea sync. The change is visible, the
 *     author carries on, and it is gone after save.
 *
 * Run with:  node tests/media-embed.test.mjs
 */
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const cacheDir = path.join(root, 'node_modules', '.cache');
await fs.mkdir(cacheDir, { recursive: true });
async function load(rel, tag) {
  const out = path.join(cacheDir, `astrobaas-${tag}-${process.pid}.mjs`);
  await build({
    entryPoints: [path.join(root, rel)],
    bundle: true, format: 'esm', platform: 'node', packages: 'external',
    outfile: out, logLevel: 'silent',
  });
  return import(pathToFileURL(out).href);
}
const E = await load('src/lib/media-embed.ts', 'mediaembed');
const I = await load('src/lib/editor-insert.ts', 'editorinsert');
const S = await load('src/lib/sanitize.ts', 'sanitize-for-embed');
const D = await load('src/lib/image-dimensions.ts', 'imgdim-for-embed');

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

const IMG = { url: '/uploads/a.webp', mime_type: 'image/webp', original_name: 'a.webp' };

// ───────────────────────────────────────────────────────── mediaInsertHtml

check('an UNDESCRIBED image gets NO alt attribute at all', () => {
  // Not alt="". An empty alt is correct markup for a DECORATIVE image, so
  // applyImageAltText treats it as a decision and never fills it — writing one
  // here would permanently block the render-time filler, and describing the
  // file later would never reach a post that already embedded it.
  eq(E.mediaInsertHtml(IMG), '<figure><img src="/uploads/a.webp" /></figure>');
});

check('THE ROUND TRIP: the sanitizer returns it byte-identical', () => {
  // The whole reason the img is written self-closed and the wrapper is <figure>.
  // If the sanitizer normalises the output to something else, the editor and
  // the page disagree about what the author inserted.
  for (const item of [
    IMG,
    { ...IMG, alt_text: 'A cat on a windowsill' },
    { url: '/uploads/spec.pdf', mime_type: 'application/pdf', original_name: 'spec.pdf' },
  ]) {
    const html = E.mediaInsertHtml(item);
    eq(S.sanitizeHtml(html), html, JSON.stringify(item.mime_type));
  }
});

check('the ORIGINAL is used, never the thumbnail', () => {
  // A 400px grid derivative in an article body ships a blurry picture, and the
  // dimensions pipeline then reserves the wrong box for it.
  const html = E.mediaInsertHtml({ ...IMG, thumb_url: '/uploads/a-400.webp' });
  if (html.includes('a-400')) throw new Error(html);
  if (!html.includes('/uploads/a.webp')) throw new Error(html);
});

check('a described image carries its description', () => {
  const html = E.mediaInsertHtml({ ...IMG, alt_text: 'A cat on a windowsill' });
  if (!html.includes('alt="A cat on a windowsill"')) throw new Error(html);
});

check('a filename is NEVER used as a description', () => {
  // "IMG_4821.jpg" read aloud by a screen reader is worse than silence.
  const html = E.mediaInsertHtml({ ...IMG, original_name: 'IMG_4821.jpg' });
  if (/alt=/.test(html)) throw new Error(`invented an alt: ${html}`);
});

check('END TO END: an inserted image is later filled by the render pipeline', () => {
  // The whole point of omitting the attribute. This is the sequence an author
  // actually performs: insert the picture, describe it in the library later.
  const inserted = E.mediaInsertHtml(IMG);
  const filled = D.applyImageAltText(inserted, new Map([['/uploads/a.webp', 'A cat']]));
  if (!filled.includes('alt="A cat"')) throw new Error(filled);
});

check('a NON-image we cannot show becomes a link, not a broken embed', () => {
  // The rule has not changed — a file in an <img> is a broken image — but the
  // example has. This used a PDF, and a PDF is now shown in place (see
  // `tests/pdf-viewer.test.mjs`). A .zip still has nothing to show, which is
  // what makes it the honest example of the rule.
  const html = E.mediaInsertHtml({ url: '/uploads/archive.zip', mime_type: 'application/zip', original_name: 'Archive.zip' });
  eq(html, '<p><a href="/uploads/archive.zip">Archive.zip</a></p>');
});

check('a PDF this app serves becomes a viewer figure', () => {
  // Only the shape is asserted here, because this module's job ends at what it
  // inserts. What the figure turns into, and every URL that must NOT be framed,
  // are in tests/pdf-viewer.test.mjs.
  const html = E.mediaInsertHtml({ url: '/uploads/spec.pdf', mime_type: 'application/pdf', original_name: 'Spec sheet.pdf' });
  eq(html, '<figure class="ab-pdf"><a href="/uploads/spec.pdf">Spec sheet.pdf</a></figure>');
});

check('a PDF on an origin we do not control stays a link', () => {
  // We cannot set X-Frame-Options on someone else's CDN, so framing it would
  // give the reader a blank box instead of a document.
  const html = E.mediaInsertHtml({ url: 'https://cdn.example.com/spec.pdf', mime_type: 'application/pdf', original_name: 'Spec sheet.pdf' });
  eq(html, '<p><a href="https://cdn.example.com/spec.pdf">Spec sheet.pdf</a></p>');
});

check('a non-image with no name falls back to its url', () => {
  const html = E.mediaInsertHtml({ url: '/uploads/x.zip', mime_type: 'application/zip' });
  if (!html.includes('>/uploads/x.zip<')) throw new Error(html);
});

check('a record with NO url inserts nothing', () => {
  // An <img src=""> renders a broken-image icon the author then has to find.
  eq(E.mediaInsertHtml({ mime_type: 'image/webp' }), '');
  eq(E.mediaInsertHtml({ url: '   ', mime_type: 'image/webp' }), '');
  eq(E.mediaInsertHtml({}), '');
});

check('quotes and angle brackets in a name or alt are escaped', () => {
  const html = E.mediaInsertHtml({ ...IMG, alt_text: 'He said "hi" & <left>' });
  if (html.includes('<left>')) throw new Error(html);
  if (!html.includes('&quot;')) throw new Error(html);
  eq(S.sanitizeHtml(html), html, 'and it still round-trips');
});

// ──────────────────────────────────────────────────────── insertIntoEditor

function fakeSurface(initial = '') {
  const textarea = { value: '' };
  const events = [];
  return {
    innerHTML: initial,
    focused: false,
    events,
    textarea,
    focus() { this.focused = true; },
    contains() { return true; },
    insertAdjacentHTML(pos, html) { this.innerHTML += html; },
    closest() { return { querySelector: () => textarea }; },
    dispatchEvent(e) { events.push(e?.type ?? 'event'); return true; },
  };
}

check('appending when the caret is OUTSIDE the editor', () => {
  // The author clicked the media grid first, so the selection is somewhere else
  // entirely — possibly another field. execCommand would put the picture there.
  const s = fakeSurface('<p>before</p>');
  I.insertIntoEditor(s, '<figure>x</figure>', { selectionIsInside: () => false });
  eq(s.innerHTML, '<p>before</p><figure>x</figure>');
});

check('inserting at the caret when it IS inside', () => {
  const s = fakeSurface('<p>before</p>');
  let got = '';
  I.insertIntoEditor(s, '<figure>x</figure>', {
    selectionIsInside: () => true,
    execInsert: (h) => { got = h; },
  });
  eq(got, '<figure>x</figure>');
  eq(s.innerHTML, '<p>before</p>', 'the surface was not also appended to');
});

check('the hidden textarea is ALWAYS synced', () => {
  // It is what the form posts. Skipping it means the change is visible and gone
  // after save — the worst possible outcome.
  const s = fakeSurface('<p>a</p>');
  I.insertIntoEditor(s, '<p>b</p>', { selectionIsInside: () => false });
  eq(s.textarea.value, '<p>a</p><p>b</p>');
});

check('an input event is dispatched, so autosave and the analysis panel hear it', () => {
  const s = fakeSurface();
  I.insertIntoEditor(s, '<p>x</p>', { selectionIsInside: () => false });
  eq(s.events, ['input']);
});

check('the surface is focused before anything is inserted', () => {
  const s = fakeSurface();
  I.insertIntoEditor(s, '<p>x</p>', { selectionIsInside: () => false });
  eq(s.focused, true);
});

check('inserting nothing is a no-op — no sync, no event', () => {
  const s = fakeSurface('<p>a</p>');
  I.insertIntoEditor(s, '', { selectionIsInside: () => false });
  eq(s.innerHTML, '<p>a</p>');
  eq(s.events, []);
});

check('syncEditorSurface works on its own', () => {
  const s = fakeSurface('<p>only</p>');
  I.syncEditorSurface(s);
  eq(s.textarea.value, '<p>only</p>');
  eq(s.events, ['input']);
});

check('a surface with no textarea does not throw', () => {
  const s = { ...fakeSurface(), closest: () => null };
  I.syncEditorSurface(s);
  eq(s.events, ['input']);
});

// ──────────────────────────────────────────────── galleries (C-63)

check('a gallery is built from the SAME img form as a single insert', () => {
  // Self-closed, so the sanitizer returns it byte-identical — the invariant the
  // whole section vocabulary rests on.
  const html = E.galleryHtml([IMG, { ...IMG, url: '/uploads/b.webp', alt_text: 'A cat' }]);
  eq(S.sanitizeHtml(html), html, 'round trip');
  if (!html.startsWith('<div class="ab-gallery">')) throw new Error(html);
  eq((html.match(/ab-gallery-item/g) ?? []).length, 2);
});

check('PICK ORDER is gallery order', () => {
  // An author who wants a sequence must be able to express one; library order
  // would make that impossible.
  const html = E.galleryHtml([
    { ...IMG, url: '/uploads/second.webp' },
    { ...IMG, url: '/uploads/first.webp' },
  ]);
  if (html.indexOf('second.webp') > html.indexOf('first.webp')) throw new Error(html);
});

check('an undescribed image in a gallery still omits alt entirely', () => {
  // So applyImageAltText can fill it later — the same rule as a single insert,
  // because it is the same function underneath.
  const html = E.galleryHtml([IMG]);
  if (/alt=/.test(html)) throw new Error(html);
});

check('a NON-image is left out rather than made into a broken tile', () => {
  const html = E.galleryHtml([
    IMG,
    { url: '/uploads/spec.pdf', mime_type: 'application/pdf', original_name: 'spec.pdf' },
  ]);
  eq((html.match(/ab-gallery-item/g) ?? []).length, 1);
  if (html.includes('spec.pdf')) throw new Error(html);
});

check('nothing usable produces NOTHING, not an empty grid', () => {
  // An empty grid renders as a mysterious gap the author has to find and delete.
  eq(E.galleryHtml([]), '');
  eq(E.galleryHtml([{ mime_type: 'image/webp' }]), '');
  eq(E.galleryHtml([{ url: '/uploads/x.pdf', mime_type: 'application/pdf' }]), '');
});

check('the gallery classes are the ones the SECTION vocabulary allows', () => {
  // A class the sanitizer does not know is stripped on save, and the gallery
  // renders as a stack of full-width images with nothing saying why.
  const html = E.galleryHtml([IMG]);
  for (const cls of ['ab-gallery', 'ab-gallery-item']) {
    if (!html.includes(cls)) throw new Error(`${cls} missing`);
  }
  eq(S.sanitizeHtml(html), html);
});

if (failures.length) {
  console.error(`\n✗ media-embed: ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error(`  · ${f}`);
  process.exit(1);
}
console.log(`✓ media-embed: ${passed} passed`);
