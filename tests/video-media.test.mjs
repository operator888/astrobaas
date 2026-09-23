#!/usr/bin/env node
/**
 * Self-hosted video: sniffing, ceilings, and the markup that gets stored.
 *
 * The three things that decide whether this works at all:
 *
 *  1. The file is identified from its MAGIC BYTES, never its name or the
 *     client's MIME. An .mp4 that is really a script must not become a video.
 *  2. Video gets its own size ceiling. Sharing the 10 MB image cap would refuse
 *     almost every real clip; sharing the 100 MB video cap would let somebody
 *     store a 90 MB PNG.
 *  3. The `<video>` markup must survive the sanitizer BYTE FOR BYTE. This
 *     codebase has shipped an editor that inserted markup storage then threw
 *     away more than once, and the failure looks like "the video disappeared".
 *
 * Run with:  node tests/video-media.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The ingester WRITES, so it gets a scratch directory of its own rather than
// whatever UPLOADS_DIR happens to be set to — a test that appends to the
// developer's real library is a test nobody runs twice. Set before the module
// graph is imported, because getUploadsDir reads the env at call time.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'astrobaas-video-test-'));
process.env.UPLOADS_DIR = scratch;

// AND THE DATABASE, which the first version of this file forgot.
//
// ingestMedia does two writes, not one: the file to UPLOADS_DIR, and a row
// through LocalDB.createMediaFile. Isolating only the directory meant the
// files went to scratch while the ROWS went to the developer's real db.json —
// so every run left five media entries pointing at paths that had just been
// deleted, and they accumulated. Found by opening the media library after six
// runs and finding thirty-one broken thumbnails in it.
//
// The lesson generalises past this file: isolating one of a function's outputs
// reads as isolation, and the test passes either way, so nothing says which
// half was missed. tests/smoke.mjs already had both. This did not.
process.env.DB_PATH = path.join(scratch, 'db.json');

import { loadTs } from './lib/load.mjs';

const E = await loadTs('src/lib/media-embed.ts');
const S = await loadTs('src/lib/sanitize.ts');

let pass = 0;
let fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };

/* ------------------------------------------------ what counts as a video */
{
  const v = (mime) => E.isVideo({ mime_type: mime, url: '/uploads/2026/06/a.mp4' });
  check('mp4 and webm are video', v('video/mp4') && v('video/webm'));
  check('an image is not', !v('image/png') && !v('image/webp'));
  check('a pdf is not', !v('application/pdf'));
  check('a missing type is not', !v(undefined) && !v(''));
}

/* --------------------------------------------- the markup that is stored */
{
  const html = E.mediaInsertHtml({
    url: '/uploads/2026/06/clip.mp4', mime_type: 'video/mp4',
    original_name: 'unboxing.mp4',
  });

  check('a video inserts a <video> element', html.includes('<video'));
  check('...with controls, or the visitor cannot stop it', html.includes('controls'));
  check('...and a <source> carrying the type', html.includes('<source') && html.includes('type="video/mp4"'));

  // preload=auto would pull the whole file on page load for every visitor,
  // whether or not they press play — the operator's bandwidth and the
  // visitor's data plan.
  check('...preloading only METADATA, never the whole file',
    html.includes('preload="metadata"') && !html.includes('preload="auto"'));

  // The single most complained-about thing a page can do.
  check('...and never autoplay or loop', !html.includes('autoplay') && !html.includes('loop'));

  /*
   * NO TEXT INSIDE <video>, which is what makes the two insert paths agree.
   *
   * The version this replaces asserted that a fallback `<a>` was present, and
   * it was — in the BUILDER's output. It never covered the path that matters:
   * MediaLibrary inserts through `document.execCommand('insertHTML')` when the
   * caret is in the editor, and that sanitiser strips text nodes out of <video>
   * fallback content. So the same click stored `<a href="…">clip.mp4</a>` or
   * `<a href="…"></a>` depending on where the caret happened to be, and this
   * assertion passed for both because it only ever looked at the string the
   * builder returned.
   *
   * Asserting on the builder's output was not wrong, it was too early. This
   * asserts the property that makes the editor's two paths produce the same
   * bytes: there is no text for execCommand to take away.
   */
  const insideVideo = html.slice(html.indexOf('<video'), html.indexOf('</video>'));
  check('...carrying no fallback TEXT for execCommand to strip',
    !/>[^<>]*[^\s<>][^<>]*</.test(insideVideo + '<'));
  check('...and no fallback anchor at all', !insideVideo.includes('<a '));

  check('an IMAGE still inserts an <img>, unchanged',
    E.mediaInsertHtml({ url: '/u/a.png', mime_type: 'image/png' }).includes('<img'));
  check('a PDF still inserts a link',
    E.mediaInsertHtml({ url: '/u/a.pdf', mime_type: 'application/pdf', original_name: 'spec.pdf' })
      .includes('<a href='));
}

/* ---- THE ROUND TRIP. Inserted markup must come back out of the sanitizer. */
{
  const html = E.mediaInsertHtml({
    url: '/uploads/2026/06/clip.webm', mime_type: 'video/webm', original_name: 'demo.webm',
  });
  const clean = S.sanitizeHtml(html);

  check('the inserted video SURVIVES the sanitizer', clean.includes('<video'));
  check('...keeping its source', clean.includes('<source') && clean.includes('clip.webm'));
  check('...and its controls', clean.includes('controls'));

  // Byte-for-byte, because "mostly survives" is how an editor and its storage
  // drift apart until somebody notices a video is a blank box.
  check('...byte for byte', clean === html);
}

/* ---------------------------- what the sanitizer must REFUSE on a video */
{
  const strip = (h) => S.sanitizeHtml(h);

  check('autoplay is stripped even if somebody writes it',
    !strip('<video controls autoplay src="https://x/a.mp4"></video>').includes('autoplay'));
  check('loop is stripped', !strip('<video controls loop src="https://x/a.mp4"></video>').includes('loop'));
  check('an event handler is stripped',
    !strip('<video controls onerror="alert(1)" src="https://x/a.mp4"></video>').includes('onerror'));

  // `controlslist` exists to take controls AWAY from a visitor.
  check('controlslist is stripped',
    !strip('<video controls controlslist="nodownload" src="https://x/a.mp4"></video>').includes('controlslist'));

  // A data: URI video is megabytes of base64 inside the post body.
  check('a data: video source is refused',
    !strip('<video controls><source src="data:video/mp4;base64,AAAA" /></video>').includes('data:'));
  check('a javascript: video source is refused',
    !strip('<video controls src="javascript:alert(1)"></video>').includes('javascript:'));

  // ...while an image keeps data:, which it is allowed.
  check('an image keeps its data: URI, unchanged by this',
    strip('<img src="data:image/png;base64,AAAA" alt="x" />').includes('data:image/png'));
}

/* ------------------------- the sniffer decides from BYTES, not from names */
{
  const I = await loadTs('src/lib/media/ingest.ts');

  // An MP4 is a size field, the literal 'ftyp', then a brand. Built by hand so
  // the test states exactly which bytes are being claimed.
  const mp4 = (brand) => Buffer.concat([
    Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftyp', 'latin1'),
    Buffer.from(brand, 'latin1'), Buffer.alloc(16),
  ]);
  // WebM is EBML; so is Matroska. Only the DocType tells them apart.
  const ebml = (doctype) => Buffer.concat([
    Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
    Buffer.from(`\u0000\u0000${doctype}`, 'latin1'), Buffer.alloc(64),
  ]);

  const kindOf = async (buf, name, type) => {
    const r = await I.ingestMedia(buf, { originalName: name, declaredType: type });
    return r.ok ? r.media.mime_type : `REFUSED: ${r.error}`;
  };

  check('an mp4 is recognised from its ftyp brand',
    (await kindOf(mp4('isom'), 'a.mp4', 'video/mp4')) === 'video/mp4');
  check('...and so are the other playable brands',
    (await kindOf(mp4('mp42'), 'a.mp4', 'video/mp4')) === 'video/mp4'
    && (await kindOf(mp4('avc1'), 'a.mp4', 'video/mp4')) === 'video/mp4');

  // HEIC photos carry an ftyp box too. Waving anything with `ftyp` through
  // would store a file most browsers cannot show.
  check('an ftyp brand no browser plays is REFUSED, not stored',
    String(await kindOf(mp4('heic'), 'a.mp4', 'video/mp4')).startsWith('REFUSED'));

  check('a webm is recognised by its DocType', (await kindOf(ebml('webm'), 'a.webm', 'video/webm')) === 'video/webm');

  // THE ONE THE MAGIC BYTES CANNOT ANSWER. An .mkv served as video/webm is a
  // file the browser refuses, so the DocType has to be read.
  check('a Matroska file is NOT accepted as webm',
    String(await kindOf(ebml('matroska'), 'a.mkv', 'video/webm')).startsWith('REFUSED'));

  // The whole point of sniffing: the name and the declared type are claims.
  check('a script named .mp4 is refused whatever it calls itself',
    String(await kindOf(Buffer.from('#!/bin/sh\nrm -rf /', 'utf8'), 'evil.mp4', 'video/mp4'))
      .startsWith('REFUSED'));

  // The ceilings are per-kind: a huge PNG is still refused, a huge MP4 is not.
  check('video has its own, larger ceiling', I.MAX_VIDEO_SIZE > I.MAX_MEDIA_SIZE);
  check('...and it is 100 MB by default', I.MAX_VIDEO_SIZE === 100 * 1024 * 1024);
  const bigPng = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(I.MAX_MEDIA_SIZE + 1024),
  ]);
  const refusal = await I.ingestMedia(bigPng, { originalName: 'huge.png', declaredType: 'image/png' });
  check('an oversized IMAGE is still refused at the image ceiling',
    !refusal.ok && /10 MB/.test(refusal.error));
}

fs.rmSync(scratch, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
