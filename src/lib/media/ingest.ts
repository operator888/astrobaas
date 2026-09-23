/**
 * Taking a file into the media library — the one implementation.
 *
 * This was the body of the upload route, which made it reachable only through
 * a multipart POST from a signed-in browser. The WordPress importer needs the
 * same thing for a file it fetched from an old site, and the alternative was a
 * second, weaker version of the rules that matter most here: what a file IS
 * (magic bytes, never the declared type or the extension), SVG sanitization,
 * EXIF stripping, derivative generation, and the content-addressed write.
 *
 * A second implementation of a security boundary is a second thing to get
 * wrong, so there is one. The route parses the request and checks permission;
 * this takes bytes and a name and does the rest.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { LocalDB } from '../localdb';
import { getUploadsDir } from '../paths';
import { loadSharp } from './sharp';
import { generateDerivatives, MAX_INPUT_PIXELS } from './derivatives';
import { mediaFilePaths } from './files';
import { stripImageMetadata, shouldStripOriginalMetadata } from './strip-metadata';
import { looksLikeSvg, sanitizeSvg, svgDimensions } from './svg-sanitize';
import type { MediaFile, MediaVariant, MediaPipelineReport } from '../../core/models';
import { refuseIfInfected } from './scan';

/** The largest file the library accepts, from any door. */
export const MAX_MEDIA_SIZE = 10 * 1024 * 1024;

/**
 * The ceiling for VIDEO, which is a different kind of file and needs one.
 *
 * 10 MB is generous for a product photo and useless for footage: thirty
 * seconds of 1080p is comfortably past it, so sharing the image ceiling would
 * have meant the feature refusing almost everything a shop actually has.
 *
 * 100 MB by default, `MEDIA_MAX_VIDEO_MB` to change it. It is a real cost —
 * the bytes sit on the operator's disk and leave on their bandwidth every time
 * somebody presses play, with no CDN in front unless they put one there — so
 * the number is theirs to raise, not ours to assume.
 *
 * The middleware's body limit is DERIVED from this (see `bodyLimitFor`), so
 * raising it here raises the request cap with it. Those two were hand-synced
 * for images and the codebase already carries a note about what that cost.
 */
export const MAX_VIDEO_SIZE = (() => {
  const raw = Number(process.env.MEDIA_MAX_VIDEO_MB);
  const mb = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 2048) : 100;
  return Math.round(mb) * 1024 * 1024;
})();

export interface IngestInput {
  /** The file's own name, for display only — never trusted for its type. */
  originalName: string;
  /** The uploader's declared MIME. Only ever consulted for plain-text types. */
  declaredType?: string;
  altText?: string;
  /** The user id recorded as the uploader. */
  uploadedBy: string;
}

export type IngestResult =
  | { ok: true; media: MediaFile }
  | { ok: false; error: string };

function keepOriginals(): boolean {
  const raw = String(process.env.MEDIA_KEEP_ORIGINALS ?? '').trim().toLowerCase();
  return raw !== '0' && raw !== 'false' && raw !== 'off';
}

// We decide what a file *is* from its magic bytes — never from the client's
// Content-Type or the filename extension (both are attacker-controlled). This
// is what blocks an SVG/HTML polyglot uploaded as "image/png".
type SniffKind = 'png' | 'jpeg' | 'gif' | 'webp' | 'pdf' | 'mp4' | 'webm';
function sniff(buf: Buffer): SniffKind | null {
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';

  // MP4 and its relatives: an `ftyp` box, which is a SIZE then the literal
  // 'ftyp' at offset 4. The brand that follows says what it really is, and the
  // list is an allow-list rather than "anything with ftyp": that same box
  // introduces HEIC photos and several formats no browser plays, so waving
  // them through would store a file the shop cannot show.
  if (buf.length >= 12 && buf.toString('latin1', 4, 8) === 'ftyp') {
    const brand = buf.toString('latin1', 8, 12);
    const PLAYABLE = new Set(['isom', 'iso2', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'dash', 'M4V ']);
    if (PLAYABLE.has(brand)) return 'mp4';
    return null;
  }

  // WebM is an EBML document, and so is Matroska — the magic bytes ALONE
  // cannot tell them apart, and an .mkv served as video/webm is a file the
  // browser will refuse. The DocType element carries the answer, so the header
  // is searched for the literal "webm" before this claims to be one.
  if (buf.length >= 4
      && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
    return buf.subarray(0, Math.min(buf.length, 1024)).includes(Buffer.from('webm', 'latin1'))
      ? 'webm'
      : null;
  }
  if (
    buf.length >= 6 &&
    buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38 &&
    (buf[4] === 0x37 || buf[4] === 0x39) && buf[5] === 0x61
  ) return 'gif';
  if (
    buf.length >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP'
  ) return 'webp';
  if (buf.length >= 5 && buf.toString('ascii', 0, 5) === '%PDF-') return 'pdf';
  return null;
}

const IMAGE_KINDS = new Set<SniffKind>(['png', 'jpeg', 'gif', 'webp']);
/**
 * The two containers every current browser plays, and nothing else.
 *
 * MP4/H.264 and WebM/VP9 between them cover every desktop and mobile browser in
 * use. MOV, AVI, MKV and WMV are deliberately absent: a shop that uploads a
 * 400 MB .mov gets a file most of its visitors cannot play, and accepting it
 * would mean either transcoding — which is ffmpeg, a second runtime, and
 * minutes of CPU per upload — or serving something broken. Refusing with a
 * sentence that names the two formats is the honest answer.
 */
const VIDEO_KINDS = new Set<SniffKind>(['mp4', 'webm']);
const KIND_EXT: Record<SniffKind, string> = { png: 'png', jpeg: 'jpg', gif: 'gif', webp: 'webp', pdf: 'pdf', mp4: 'mp4', webm: 'webm' };
const KIND_MIME: Record<SniffKind, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  mp4: 'video/mp4',
  webm: 'video/webm',
};
// Plain-text types have no magic bytes; allowed but always stored/served as
// text/plain (with nosniff) so they can never execute as HTML.
const TEXT_TYPES: Record<string, string> = { 'text/plain': 'txt', 'text/markdown': 'md' };

function cleanOriginalName(name: string): string {
  return (name || 'upload')
    .replace(/[^\w.\-() ]+/g, '_')
    .replace(/_{2,}/g, '_')
    .slice(0, 200) || 'upload';
}


/**
 * Store one file, with every rule the upload path applies.
 *
 * Returns a refusal rather than throwing: both callers — an HTTP handler and a
 * bulk importer walking hundreds of files — need to report the reason and keep
 * going, not unwind.
 */
/**
 * Clean operator-typed alt text.
 *
 * Exported because there are now two writers — this ingester and the media
 * library's edit route — and a rule applied on upload but not on edit means the
 * two paths store different things under the same field name.
 *
 * Angle brackets and quotes go server-side as defence in depth (the admin also
 * escapes on render, and `applyImageAltText` escapes again on the way into an
 * attribute). 300 characters because alt text longer than that is a caption,
 * and a screen reader reads every one of them before the next paragraph.
 */
export function cleanAltText(value: unknown): string {
  return String(value ?? '').replace(/[<>"']/g, '').trim().slice(0, 300);
}

export async function ingestMedia(buf: Buffer, input: IngestInput): Promise<IngestResult> {
  const { originalName, declaredType = '', altText, uploadedBy } = input;
  if (buf.byteLength === 0) return { ok: false, error: 'The file is empty.' };
  // The ceiling depends on WHAT this is, so the cheap structural check happens
  // first: a 90 MB PNG is still refused, a 90 MB MP4 is not. Sniffing reads a
  // few header bytes of a buffer already in memory, so ordering it before the
  // size test costs nothing.
  const earlyKind = sniff(buf);
  const sizeCap = earlyKind && VIDEO_KINDS.has(earlyKind) ? MAX_VIDEO_SIZE : MAX_MEDIA_SIZE;
  if (buf.byteLength > sizeCap) {
    return { ok: false, error: `File too large (max ${Math.round(sizeCap / 1024 / 1024)} MB)` };
  }

  // The virus scan (C-76), on the ORIGINAL bytes and BEFORE any re-encode.
  //
  // Order matters twice. Re-encoding a raster can destroy a signature while
  // leaving a polyglot's other half intact, so a scan after it would report
  // clean on a file that is not. And a PDF is never re-encoded at all, which is
  // the format an operator most wants scanned.
  //
  // No-op unless MEDIA_SCAN is configured; the fail policy lives in
  // refuseIfInfected so both upload doors answer it the same way.
  const infected = await refuseIfInfected(buf);
  if (infected) return { ok: false, error: infected };

  const sniffed = earlyKind;

  // Resolve the real type from content; reject anything we can't vouch for.
  let kind: 'image' | 'video' | 'pdf' | 'text' | 'svg';
  let ext: string;
  let storedMime: string;
  // For SVG the SANITIZED serialization is the file: hostile bytes are
  // never written to disk, so there is nothing to leak later. Set only in
  // the svg branch.
  let svgClean: Buffer | undefined;
  if (sniffed && IMAGE_KINDS.has(sniffed)) {
    kind = 'image';
    ext = KIND_EXT[sniffed];
    storedMime = KIND_MIME[sniffed];
  } else if (sniffed && VIDEO_KINDS.has(sniffed)) {
    kind = 'video';
    ext = KIND_EXT[sniffed];
    storedMime = KIND_MIME[sniffed];
  } else if (sniffed === 'pdf') {
    kind = 'pdf';
    ext = KIND_EXT.pdf;
    storedMime = KIND_MIME.pdf;
  } else if (!sniffed && looksLikeSvg(buf)) {
    // Ordered AFTER the magic-byte branches on purpose: a raster that
    // merely CLAIMS to be SVG stays a raster. Structure decides, never the
    // client MIME or the filename.
    const cleaned = sanitizeSvg(buf.toString('utf8'));
    if (!cleaned) {
      return { ok: false, error: 'That SVG could not be safely parsed. Re-export it from your editor and try again.' };
    }
    kind = 'svg';
    ext = 'svg';
    storedMime = 'image/svg+xml';
    svgClean = Buffer.from(cleaned, 'utf8');
  } else if (TEXT_TYPES[declaredType]) {
    kind = 'text';
    ext = TEXT_TYPES[declaredType];
    storedMime = declaredType;
  } else {
    return { ok: false, error: 'Unsupported or unrecognized file. Allowed: PNG, JPEG, GIF, WebP, SVG, PDF, MP4, WebM, plain text/markdown.' };
  }

  // Write to <uploads>/yyyy/mm/<hash>.<ext>
  const now = new Date();
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dir = path.join(getUploadsDir(), yyyy, mm);
  await fs.mkdir(dir, { recursive: true });

  // Identity is content-addressed. For SVG that identity is the SANITIZED
  // bytes — two uploads differing only in a stripped <script> are the same
  // image, and the shared-file unlink logic below assumes identical content
  // means identical path.
  const hash = crypto.createHash('sha1').update(svgClean ?? buf).digest('hex').slice(0, 16);
  const filename = `${hash}.${ext}`;
  const target = path.join(dir, filename);
  // Defence in depth: ensure the resolved path stays within the dated dir.
  if (!target.startsWith(dir + path.sep)) {
    return { ok: false, error: 'Invalid filename' };
  }
  /*
   * Write the upload, minus its camera metadata.
   *
   * A LOSSLESS container edit — the compressed image data is copied through
   * byte for byte, so this is still the master copy in every sense a shop
   * cares about. What goes is the EXIF block, which on a phone photo carries
   * GPS coordinates, the device serial and the owner's name.
   *
   * This matters BECAUSE the original is now retained. The old pipeline
   * deleted it after re-encoding, so nothing was ever published; keeping it
   * would otherwise publish an optician's home address at a guessable URL
   * with every product photo they shot there. `MEDIA_ORIGINAL_EXIF=keep`
   * turns it off for a shop that needs the capture data.
   */
  const stripped = shouldStripOriginalMetadata()
    ? stripImageMetadata(buf, sniffed ?? '')
    : { buf, removed: 0, dropped: [] as string[] };
  await fs.writeFile(target, svgClean ?? stripped.buf);

  const urlPrefix = `/uploads/${yyyy}/${mm}`;
  let url = `${urlPrefix}/${filename}`;
  let mime = storedMime;
  let size = buf.byteLength;
  let thumbUrl: string | undefined;
  let originalUrl: string | undefined;
  let width: number | undefined;
  let height: number | undefined;
  let variants: MediaVariant[] | undefined;
  let pipeline: MediaPipelineReport | undefined;

  /*
   * The image pipeline.
   *
   * Three things changed here after two production incidents, and each one is
   * a rule rather than a tweak:
   *
   * 1. THE ORIGINAL IS KEPT. It used to be unlinked after re-encoding, which
   *    threw away the master copy of a photo the shop owns. `url` still points
   *    at a re-encoded WebP — so ordinary rendering never touches the raw
   *    bytes, which is the property the re-encode was protecting — and
   *    `original_url` points at what was uploaded.
   *
   * 2. DERIVATIVES ARE GENERATED HERE, NOT BY A BATCH JOB. A backfill script
   *    exists for what is already stored, but if new uploads could bypass this
   *    the shop would silently regress to full-size images with nothing
   *    failing — which is precisely how the last regression lasted weeks.
   *
   * 3. FAILURE IS RECORDED, NEVER SWALLOWED. Missing sharp, or a width that
   *    would not encode, lands on the record as `pipeline` and is reported by
   *    the deep health check. The upload still succeeds: an editor with a
   *    photo to publish is not helped by a 500.
   */
  if (kind === 'svg') {
    // Vector: the raster pipeline (sharp, WebP derivatives) does not apply.
    // One file at every size, dimensions read from the markup when it
    // declares them. `size` reflects what is actually served — the
    // sanitized bytes, not the upload.
    size = (svgClean as Buffer).length;
    const dims = svgDimensions((svgClean as Buffer).toString('utf8'));
    width = dims.width;
    height = dims.height;
  }

  if (kind === 'image') {
    const sharp = await loadSharp();
    if (!sharp) {
      pipeline = {
        status: 'unavailable',
        reason: 'sharp is not installed on this host, so no dimensions or derivatives were generated',
      };
    } else {
      // Dimensions first, and OUTSIDE the try that wraps the writes. They are
      // the cheapest and most useful fact about the image, and the previous
      // all-or-nothing try/catch discarded them whenever a later step threw —
      // losing work that had already succeeded.
      try {
        const meta = await sharp(buf, { failOn: 'truncated', limitInputPixels: MAX_INPUT_PIXELS }).metadata();
        // EXIF orientation is not applied to `meta.width`. A portrait phone
        // photo reports landscape dimensions until it is rotated, and a
        // storefront sizing its layout from that gets the aspect ratio wrong
        // on exactly the images an owner shoots themselves.
        const swap = typeof meta.orientation === 'number' && meta.orientation >= 5;
        width = swap ? meta.height : meta.width;
        height = swap ? meta.width : meta.height;
      } catch (e) {
        pipeline = { status: 'degraded', reason: `could not read image dimensions: ${(e as Error).message}` };
      }

      if (width && height) {
        const { derivatives, failed } = await generateDerivatives({
          sharp, buf, dir, urlPrefix, hash, originalWidth: width,
        });

        if (derivatives.length > 0) {
          variants = derivatives;
          // The ORIGINAL stays where it was written, under its own extension.
          originalUrl = `${urlPrefix}/${filename}`;
          if (!keepOriginals()) {
            // Removing it is opt-in, and still needs the reference check that
            // this codebase has been bitten by twice: filenames are
            // content-addressed, so an identical upload by someone else
            // points at the SAME original, and an unconditional unlink would
            // silently destroy their copy.
            const others = (await LocalDB.getMedia()).some(
              (m) => mediaFilePaths(m).includes(originalUrl as string),
            );
            if (!others) await fs.unlink(target).catch(() => {});
            originalUrl = undefined;
          }
          // `url` is the largest derivative: a modern format, never an
          // upscale, and capped — so a consumer that ignores `variants`
          // entirely still stops being served a 4 MB camera original.
          const largest = derivatives[derivatives.length - 1];
          url = largest.url;
          mime = 'image/webp';
          size = largest.size;
          // Keep `thumb_url` pointing at the 400px variant. Every existing
          // consumer reads that field; removing it to "clean up" would blank
          // the media library and the product picker on day one.
          thumbUrl = (derivatives.find((d) => d.width === 400) ?? derivatives[0]).url;
        }

        if (failed.length > 0) {
          pipeline = {
            status: 'degraded',
            reason: `${failed.length} of ${failed.length + derivatives.length} image sizes could not be generated`,
            failed_widths: failed.map((f) => f.width),
          };
          console.error('[astrobaas] image derivatives failed:', failed);
        } else if (derivatives.length === 0) {
          pipeline = { status: 'degraded', reason: 'no derivatives could be generated for this image' };
        }
      }
    }
  }

  const media = await LocalDB.createMediaFile({
    filename: path.basename(url),
    original_name: cleanOriginalName(originalName),
    mime_type: mime,
    size,
    url,
    // Cap length and drop angle brackets/quotes server-side (defense in depth;
    // the admin UI also escapes on render). Keeps alt text human-readable.
    alt_text: cleanAltText(altText),
    uploaded_by: uploadedBy,
    // These go IN, not on. They used to be attached to the returned object
    // after createMediaFile(), so every response advertised a thumbnail that
    // the database had never heard of — and the grid fell back to the
    // full-resolution original for every tile.
    ...(thumbUrl ? { thumb_url: thumbUrl } : {}),
    ...(width ? { width } : {}),
    ...(height ? { height } : {}),
    ...(originalUrl ? { original_url: originalUrl } : {}),
    ...(variants ? { variants } : {}),
    ...(pipeline ? { pipeline } : {}),
  } as any);
  return { ok: true, media: media as MediaFile };
}
