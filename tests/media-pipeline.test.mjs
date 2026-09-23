#!/usr/bin/env node
/**
 * Media URLs and the image pipeline.
 *
 * The two production failures these rules come from:
 *
 *   1. The CMS returned `/uploads/2026/08/x.webp` and nothing else. A storefront
 *      on a different host resolved that against ITSELF, found nothing, and
 *      rendered broken product images. It stayed hidden for weeks because an
 *      imported catalogue stores ABSOLUTE urls, which work — so only the
 *      products the owner uploaded themselves were broken.
 *
 *   2. Every storefront had to run its own image optimizer, because a media
 *      record had one 400px thumbnail and no dimensions. One shop accumulated
 *      632 MB across 31,349 generated variants against a 1 GB ceiling.
 *
 * So the rules with teeth here are: never prefix an already-absolute url (that
 * would break the imported catalogue that currently works), never upscale, and
 * never generate a derivative wider than the cap (that is the full-size image
 * coming back through the front door).
 *
 * Run with:  node tests/media-pipeline.test.mjs
 */
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cacheDir = path.join(here, '..', 'node_modules', '.cache');
await fs.mkdir(cacheDir, { recursive: true });

async function load(rel, tag) {
  const out = path.join(cacheDir, `astrobaas-${tag}-${process.pid}.mjs`);
  await build({
    entryPoints: [path.join(here, '..', rel)],
    bundle: true, format: 'esm', platform: 'node', packages: 'external',
    outfile: out, logLevel: 'silent',
  });
  const mod = await import(pathToFileURL(out).href);
  await fs.rm(out, { force: true });
  return mod;
}

const U = await load('src/lib/media-url.ts', 'mediaurl');
const D = await load('src/lib/media/derivatives.ts', 'derivs');
const F = await load('src/lib/media/files.ts', 'mediafiles');
const S = await load('src/lib/settings-validate.ts', 'setvalidate');
const X = await load('src/lib/media/strip-metadata.ts', 'strip');

let pass = 0, fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };

/* ------------------------------------------------------------------ *
 * 1. Which origin media URLs are built from
 * ------------------------------------------------------------------ */

const base = (sources) => U.resolveMediaBase(sources);

check('the declared public_site_url wins',
  base({ publicSiteUrl: 'https://cms.example.com', siteUrl: 'https://shop.example.com', requestUrl: 'https://other.test/x' })
  === 'https://cms.example.com');

check('a trailing slash is normalised away',
  base({ publicSiteUrl: 'https://cms.example.com/' }) === 'https://cms.example.com');

// The headless case that produced the bug. site_url legitimately points at the
// STOREFRONT; joining /uploads to it gives a host that has never served an
// upload. The observed request origin is right by construction.
check('an externally reachable request origin beats a declared site_url',
  base({ siteUrl: 'https://shop.example.com', requestUrl: 'https://cms.example.com/api/products' })
  === 'https://cms.example.com');

// ...but a loopback origin proves nothing about how the outside world reaches
// this CMS, so a declared value is better than that.
check('a loopback request origin loses to a declared site_url',
  base({ siteUrl: 'https://cms.example.com', requestUrl: 'http://127.0.0.1:3002/api/products' })
  === 'https://cms.example.com');
check('a private LAN origin loses too',
  base({ siteUrl: 'https://cms.example.com', requestUrl: 'http://192.168.1.9:3002/x' })
  === 'https://cms.example.com');
check('...and is still used when nothing at all is declared',
  base({ requestUrl: 'http://127.0.0.1:3002/x' }) === 'http://127.0.0.1:3002');

check('nothing configured and no request means no answer', base({}) === null);

/* --- the mixed-content trap ---------------------------------------------
 * Astro's Node adapter only honours X-Forwarded-Proto when
 * security.allowedDomains is configured, and this app does not configure it.
 * So behind nginx terminating TLS and proxying over plain HTTP — the normal
 * production shape — request.url arrives as http://. Publishing that as the
 * media base puts http:// image URLs on an https:// page, which browsers block
 * outright: the images do not merely point at the wrong place, they do not
 * load at all.
 */
check('a forwarded https scheme upgrades the request origin',
  base({ requestUrl: 'http://cms.example.com/api/products', forwardedProto: 'https' })
  === 'https://cms.example.com');
check('a proxy chain uses the first entry',
  base({ requestUrl: 'http://cms.example.com/x', forwardedProto: 'https, http' })
  === 'https://cms.example.com');
// Only ever an upgrade. A forged `X-Forwarded-Proto: http` on a genuinely
// https deployment must not be able to downgrade every image URL the API
// publishes.
check('a forwarded http scheme cannot downgrade https',
  base({ requestUrl: 'https://cms.example.com/x', forwardedProto: 'http' })
  === 'https://cms.example.com');
check('a junk forwarded proto is ignored',
  base({ requestUrl: 'http://cms.example.com/x', forwardedProto: 'javascript' })
  === 'http://cms.example.com');
check('a non-string forwarded proto is ignored',
  base({ requestUrl: 'http://cms.example.com/x', forwardedProto: 42 })
  === 'http://cms.example.com');
// A declared setting is already explicit about its scheme and must win outright.
check('a forwarded proto never overrides the declared setting',
  base({ publicSiteUrl: 'http://cms.internal:3002', requestUrl: 'http://x.test/', forwardedProto: 'https' })
  === 'http://cms.internal:3002');

// A stored value lands in URLs that reach browsers.
check('javascript: is refused', base({ publicSiteUrl: 'javascript:alert(1)' }) === null);
check('file: is refused', base({ publicSiteUrl: 'file:///etc/passwd' }) === null);
check('a bare hostname is refused', base({ publicSiteUrl: 'cms.example.com' }) === null);
check('empty is refused', base({ publicSiteUrl: '   ' }) === null);
check('a non-string is refused', base({ publicSiteUrl: { url: 'https://x.test' } }) === null);
check('build-time astroSite is used when the settings are empty',
  base({ astroSite: 'https://built.example.com' }) === 'https://built.example.com');

/* ------------------------------------------------------------------ *
 * 2. Joining a path to it
 * ------------------------------------------------------------------ */

const abs = (u, b) => U.absoluteMediaUrl(u, b);

check('a relative path is joined', abs('/uploads/a.webp', 'https://cms.test') === 'https://cms.test/uploads/a.webp');
check('a path without a leading slash still joins',
  abs('uploads/a.webp', 'https://cms.test') === 'https://cms.test/uploads/a.webp');

// THE regression risk. An imported WooCommerce catalogue stores absolute urls,
// those images render today, and prefixing them would break the entire imported
// catalogue while fixing new uploads.
check('an already-absolute https url is left alone',
  abs('https://old-shop.gr/wp-content/x.jpg', 'https://cms.test') === 'https://old-shop.gr/wp-content/x.jpg');
check('an already-absolute http url is left alone',
  abs('http://old-shop.gr/x.jpg', 'https://cms.test') === 'http://old-shop.gr/x.jpg');
check('a protocol-relative url is left alone',
  abs('//cdn.example.com/x.jpg', 'https://cms.test') === '//cdn.example.com/x.jpg');
check('a data: url is left alone',
  abs('data:image/png;base64,AAAA', 'https://cms.test') === 'data:image/png;base64,AAAA');

check('no base means no absolute url', abs('/uploads/a.webp', null) === null);
check('an empty path yields null', abs('', 'https://cms.test') === null);
check('a non-string yields null', abs(null, 'https://cms.test') === null);

/* ------------------------------------------------------------------ *
 * 3. The record view
 * ------------------------------------------------------------------ */

{
  const record = {
    url: '/uploads/2026/08/a-w1600.webp',
    thumb_url: '/uploads/2026/08/a-w400.webp',
    original_url: '/uploads/2026/08/a.jpg',
    variants: [
      { width: 400, height: 300, url: '/uploads/2026/08/a-w400.webp', size: 1, format: 'webp' },
      { width: 1600, height: 1200, url: '/uploads/2026/08/a-w1600.webp', size: 2, format: 'webp' },
    ],
  };
  const view = U.withAbsoluteMedia(record, 'https://cms.test');
  check('the relative url is UNCHANGED', view.url === '/uploads/2026/08/a-w1600.webp');
  check('the relative thumb_url is UNCHANGED', view.thumb_url === '/uploads/2026/08/a-w400.webp');
  check('url_absolute is added', view.url_absolute === 'https://cms.test/uploads/2026/08/a-w1600.webp');
  check('thumb_absolute is added', view.thumb_absolute === 'https://cms.test/uploads/2026/08/a-w400.webp');
  check('original_absolute is added', view.original_absolute === 'https://cms.test/uploads/2026/08/a.jpg');
  check('every variant gets an absolute url',
    view.variants.every((v) => String(v.url_absolute).startsWith('https://cms.test/')));
  check('the stored record was not mutated', record.url_absolute === undefined);

  const none = U.withAbsoluteMedia(record, null);
  check('with no base, absolute fields are null and relative ones survive',
    none.url_absolute === null && none.url === '/uploads/2026/08/a-w1600.webp');
}

/* ------------------------------------------------------------------ *
 * 4. Which derivatives get made
 * ------------------------------------------------------------------ */

const widths = (w) => D.planDerivatives(w, 'h').map((p) => p.width);

check('a big camera original is capped at 1600, not reproduced at 4000',
  JSON.stringify(widths(4000)) === JSON.stringify([400, 800, 1600]));
check('a 2000px image is also capped', JSON.stringify(widths(2000)) === JSON.stringify([400, 800, 1600]));
check('exactly at the cap', JSON.stringify(widths(1600)) === JSON.stringify([400, 800, 1600]));
// Below the cap the native width IS included, so a detail view is not silently
// downgraded to 800.
check('a 1200px image keeps its own width', JSON.stringify(widths(1200)) === JSON.stringify([400, 800, 1200]));
check('a 600px image', JSON.stringify(widths(600)) === JSON.stringify([400, 600]));

// NEVER UPSCALE. Three blurry files larger than the source is a storage bill for
// making an image worse.
check('a 300px logo gets one variant at its own size',
  JSON.stringify(widths(300)) === JSON.stringify([300]));
check('a 1px image gets one variant', JSON.stringify(widths(1)) === JSON.stringify([1]));
check('no width is ever above the original', widths(500).every((w) => w <= 500));
check('no width is ever above the cap', widths(9000).every((w) => w <= 1600));

check('a zero width plans nothing', widths(0).length === 0);
check('a negative width plans nothing', widths(-5).length === 0);
check('NaN plans nothing', widths(Number.NaN).length === 0);

check('filenames are content-addressed and name their width',
  D.planDerivatives(4000, 'abc123')[0].filename === 'abc123-w400.webp');
check('the count is bounded by the configured widths',
  D.planDerivatives(99999, 'x').length <= D.DERIVATIVE_WIDTHS.length);

/* ------------------------------------------------------------------ *
 * 5. Which files a record owns (what delete must remove)
 * ------------------------------------------------------------------ */

{
  const rec = {
    url: '/uploads/a-w1600.webp',
    thumb_url: '/uploads/a-w400.webp',
    original_url: '/uploads/a.jpg',
    variants: [
      { url: '/uploads/a-w400.webp' },
      { url: '/uploads/a-w800.webp' },
      { url: '/uploads/a-w1600.webp' },
    ],
  };
  const paths = F.mediaFilePaths(rec);
  // Every path missed here is a file that survives a delete at a guessable URL:
  // "deleted" media anyone can still fetch.
  check('every owned file is listed', paths.length === 4);
  check('the original is listed', paths.includes('/uploads/a.jpg'));
  check('every derivative is listed',
    ['a-w400', 'a-w800', 'a-w1600'].every((n) => paths.includes(`/uploads/${n}.webp`)));
  check('aliases are deduplicated', new Set(paths).size === paths.length);
}
check('an imported absolute url is not ours to delete',
  F.mediaFilePaths({ url: 'https://old-shop.gr/x.jpg' }).length === 0);
check('a path outside /uploads is not ours to delete',
  F.mediaFilePaths({ url: '/etc/passwd' }).length === 0);
check('a null record is handled', F.mediaFilePaths(null).length === 0);
check('a legacy row derives its old thumbnail name',
  JSON.stringify(F.legacyDerivedPaths({ url: '/uploads/a.webp' })) === JSON.stringify(['/uploads/a-thumb.webp']));
check('a row already pointing at the guessed name needs no guess',
  F.legacyDerivedPaths({ url: '/uploads/a.webp', thumb_url: '/uploads/a-thumb.webp' }).length === 0);
// A backfilled row points thumb_url at the NEW derivative, so the old
// -thumb.webp is still on disk and still fetchable. Delete must reach it, or
// "deleted" media stays public forever.
check('a backfilled row still surrenders its old thumbnail',
  JSON.stringify(F.legacyDerivedPaths({ url: '/uploads/a.webp', thumb_url: '/uploads/a-w400.webp' }))
  === JSON.stringify(['/uploads/a-thumb.webp']));

/* ------------------------------------------------------------------ *
 * 6. The setting cannot be saved wrong
 * ------------------------------------------------------------------ */

const bad = (k, v) => S.validateSetting(k, v) !== null;

check('a bare hostname is refused', bad('public_site_url', 'cms.example.com'));
check('...and the message says what to type',
  String(S.validateSetting('public_site_url', 'cms.example.com')).includes('https://cms.example.com'));
check('a path-only value is refused', bad('public_site_url', '/uploads'));
check('javascript: is refused', bad('public_site_url', 'javascript:alert(1)'));
check('a non-string is refused', bad('public_site_url', 42));
check('a proper origin is accepted', !bad('public_site_url', 'https://cms.example.com'));
check('http is accepted (a LAN install has no certificate)', !bad('public_site_url', 'http://cms.internal:3002'));
// Clearing a setting is how an operator says "use the default".
check('empty is accepted', !bad('public_site_url', ''));
check('undefined is accepted', !bad('public_site_url', undefined));
check('site_url is validated by the same rule', bad('site_url', 'example.com'));
check('an unrelated key is not touched', !bad('site_title', 'anything at all'));

check('a stored value is canonicalised',
  S.normaliseSettingValue('public_site_url', 'https://cms.example.com/') === 'https://cms.example.com');
check('an unrelated key is left alone',
  S.normaliseSettingValue('site_title', 'My Shop/') === 'My Shop/');

/* ------------------------------------------------------------------ *
 * 7. Actually generating them
 * ------------------------------------------------------------------ *
 * Everything above is arithmetic about widths. This encodes real images,
 * because "the module is present" is not the same claim as "the pipeline
 * works" — and the difference between those two claims is what served
 * full-size originals on a live shop for weeks.
 */

let sharp = null;
try {
  const m = await import('sharp');
  sharp = m.default ?? m;
} catch (err) {
  // NOT a skip. A missing image pipeline is the production incident this file
  // exists for; a suite that shrugs at it is the same silence in a new place.
  fail += 1;
  console.error(
    `✗ sharp is not installed, so the image pipeline is UNTESTED and will not run in production either.\n`
    + `    ${err.message}\n`
    + '    Fix with: npm install --include=optional sharp',
  );
}

if (sharp) {
  const os = await import('node:os');
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'astrobaas-derivs-'));

  const makeImage = (w, h) => sharp({
    create: { width: w, height: h, channels: 3, background: { r: 30, g: 90, b: 160 } },
  }).jpeg({ quality: 90 }).toBuffer();

  {
    const buf = await makeImage(2400, 1800);
    const { derivatives, failed } = await D.generateDerivatives({
      sharp, buf, dir: tmp, urlPrefix: '/uploads/2026/08', hash: 'big', originalWidth: 2400,
    });
    check('a large image produces the three configured widths', derivatives.length === 3);
    check('nothing failed', failed.length === 0);
    check('they are ascending', derivatives.map((d) => d.width).join() === '400,800,1600');
    check('the largest is the cap, not the original width',
      derivatives[derivatives.length - 1].width === 1600);
    check('each records its own height', derivatives.every((d) => d.height > 0));
    check('the aspect ratio is preserved',
      derivatives.every((d) => Math.abs(d.width / d.height - 2400 / 1800) < 0.02));
    check('each records its own byte size', derivatives.every((d) => d.size > 0));
    check('urls are site-relative under the dated prefix',
      derivatives.every((d) => d.url.startsWith('/uploads/2026/08/big-w')));

    // The files really exist, and really are WebP.
    for (const d of derivatives) {
      const onDisk = await fs.readFile(path.join(tmp, path.basename(d.url)));
      const isWebp = onDisk.toString('ascii', 0, 4) === 'RIFF' && onDisk.toString('ascii', 8, 12) === 'WEBP';
      check(`the ${d.width}px file exists and is WebP`, isWebp && onDisk.length === d.size);
    }

    // The bound that matters for the disk: derivatives never approach the
    // original, however large the original is.
    const total = derivatives.reduce((n, d) => n + d.size, 0);
    check('all derivatives together stay well under a megabyte for a 2400px image', total < 1024 * 1024);
  }

  {
    // A logo. Upscaling it would produce files that are both larger and worse.
    const buf = await makeImage(300, 300);
    const { derivatives } = await D.generateDerivatives({
      sharp, buf, dir: tmp, urlPrefix: '/uploads/2026/08', hash: 'small', originalWidth: 300,
    });
    check('a small image gets exactly one derivative', derivatives.length === 1);
    check('...at its own size, never upscaled', derivatives[0].width === 300);
  }

  {
    // Partial failure must not discard the widths that worked.
    const buf = await makeImage(1200, 900);
    let calls = 0;
    const flaky = (input, opts) => {
      const chain = sharp(input, opts);
      const realResize = chain.resize.bind(chain);
      chain.resize = (args) => {
        calls += 1;
        if (calls === 2) throw new Error('simulated encoder failure');
        return realResize(args);
      };
      return chain;
    };
    const { derivatives, failed } = await D.generateDerivatives({
      sharp: flaky, buf, dir: tmp, urlPrefix: '/uploads/2026/08', hash: 'flaky', originalWidth: 1200,
    });
    check('one failed width does not abandon the others', derivatives.length === 2);
    check('the failure is reported, not swallowed', failed.length === 1);
    check('the report names the width', typeof failed[0].width === 'number');
  }

  {
    // A file that is not an image at all reaches here only via a broken sniff,
    // but it must report rather than throw out of the request.
    const { derivatives, failed } = await D.generateDerivatives({
      sharp, buf: Buffer.from('this is not an image'), dir: tmp,
      urlPrefix: '/uploads/2026/08', hash: 'junk', originalWidth: 800,
    });
    check('undecodable input produces no derivatives', derivatives.length === 0);
    check('...and is reported as failures', failed.length > 0);
  }

  /* ---- the retained original must not publish the shop's GPS ---- */
  {
    // A JPEG with a real EXIF block, written by sharp.
    const withExif = await sharp({
      create: { width: 60, height: 40, channels: 3, background: { r: 200, g: 40, b: 40 } },
    })
      .withMetadata({
        exif: {
          IFD0: { Copyright: 'Test Shop', Make: 'TestPhone', Model: 'TP-1' },
          GPS: { GPSLatitudeRef: 'N', GPSLongitudeRef: 'E' },
        },
      })
      .jpeg({ quality: 92 })
      .toBuffer();

    const before = await sharp(withExif).metadata();
    check('the fixture really has EXIF to remove', !!before.exif && before.exif.length > 0);

    const res = X.stripImageMetadata(withExif, 'jpeg');
    check('the EXIF segment is removed', res.dropped.includes('APP1'));
    check('...and the file got smaller', res.removed > 0);

    const after = await sharp(res.buf).metadata();
    check('no EXIF survives', !after.exif);
    check('the dimensions are unchanged', after.width === before.width && after.height === before.height);

    // THE point: it is lossless. Decode both and compare every pixel. A
    // re-encode would pass every check above and still degrade the master copy.
    const a = await sharp(withExif).raw().toBuffer();
    const b = await sharp(res.buf).raw().toBuffer();
    check('every pixel is identical — the strip is lossless', Buffer.compare(a, b) === 0);
  }

  {
    // PNG metadata chunks.
    const png = await sharp({
      create: { width: 32, height: 32, channels: 3, background: { r: 10, g: 200, b: 90 } },
    }).withMetadata({ exif: { IFD0: { Copyright: 'Test Shop' } } }).png().toBuffer();
    const res = X.stripImageMetadata(png, 'png');
    const a = await sharp(png).raw().toBuffer();
    const b = await sharp(res.buf).raw().toBuffer();
    check('a stripped PNG still decodes to identical pixels', Buffer.compare(a, b) === 0);
    const after = await sharp(res.buf).metadata();
    check('no PNG EXIF survives', !after.exif);
  }

  {
    // WebP is what this pipeline itself emits, and the upload route explicitly
    // handles re-uploading a previously downloaded asset — so a WebP carrying
    // metadata is a real input, not a theoretical one.
    const webpExif = await sharp({
      create: { width: 48, height: 24, channels: 3, background: { r: 90, g: 90, b: 220 } },
    }).withMetadata({ exif: { IFD0: { Copyright: 'Test Shop' } } }).webp({ quality: 90 }).toBuffer();
    const beforeW = await sharp(webpExif).metadata();
    if (beforeW.exif) {
      const res = X.stripImageMetadata(webpExif, 'webp');
      check('the WebP EXIF chunk is removed', res.dropped.includes('EXIF'));
      const afterW = await sharp(res.buf).metadata();
      check('no WebP EXIF survives', !afterW.exif);
      check('the WebP still decodes at the same size',
        afterW.width === beforeW.width && afterW.height === beforeW.height);
      const a = await sharp(webpExif).raw().toBuffer();
      const b = await sharp(res.buf).raw().toBuffer();
      check('the stripped WebP decodes to identical pixels', Buffer.compare(a, b) === 0);
    } else {
      // sharp did not attach EXIF to the WebP on this platform; assert the
      // no-op path instead of quietly asserting nothing.
      check('a WebP with no metadata is returned unchanged',
        X.stripImageMetadata(webpExif, 'webp').removed === 0);
    }
  }

  {
    // A JPEG with no metadata at all must come back byte-identical, not merely
    // equivalent: rewriting a file that needed no change is a way to corrupt it.
    const plain = await sharp({
      create: { width: 20, height: 20, channels: 3, background: { r: 1, g: 2, b: 3 } },
    }).jpeg().toBuffer();
    const res = X.stripImageMetadata(plain, 'jpeg');
    check('a JPEG with nothing to strip is returned byte-identical',
      res.removed === 0 && Buffer.compare(res.buf, plain) === 0);
  }

  await fs.rm(tmp, { recursive: true, force: true });
}

/* Formats this deliberately does not touch, and inputs it must not throw on. */
{
  // A truncated/odd RIFF must be returned untouched rather than rebuilt wrongly.
  const webp = Buffer.from('RIFF____WEBPVP8 ');
  check('a malformed WebP is left alone', X.stripImageMetadata(webp, 'webp').removed === 0);
  check('a GIF is left alone', X.stripImageMetadata(Buffer.from('GIF89a......'), 'gif').removed === 0);
  check('a PDF is left alone', X.stripImageMetadata(Buffer.from('%PDF-1.4'), 'pdf').removed === 0);
  check('an empty buffer does not throw', X.stripImageMetadata(Buffer.alloc(0), 'jpeg').removed === 0);
  // A truncated JPEG reaches this from a broken client; it must be returned, not thrown on.
  const truncated = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff]);
  check('a truncated JPEG is returned unchanged', X.stripImageMetadata(truncated, 'jpeg').removed === 0);
  check('junk bytes are returned unchanged',
    X.stripImageMetadata(Buffer.from('not an image at all'), 'jpeg').removed === 0);
}

// The switch, and its default.
{
  const prev = process.env.MEDIA_ORIGINAL_EXIF;
  delete process.env.MEDIA_ORIGINAL_EXIF;
  check('stripping is on by default', X.shouldStripOriginalMetadata() === true);
  process.env.MEDIA_ORIGINAL_EXIF = 'keep';
  check('MEDIA_ORIGINAL_EXIF=keep turns it off', X.shouldStripOriginalMetadata() === false);
  if (prev === undefined) delete process.env.MEDIA_ORIGINAL_EXIF;
  else process.env.MEDIA_ORIGINAL_EXIF = prev;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
