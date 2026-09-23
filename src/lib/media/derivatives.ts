/**
 * Web-ready image derivatives, generated once at upload.
 *
 * ## What this replaces, and what it cost
 *
 * A media record used to carry the original and a single 400px thumbnail. Every
 * storefront therefore needed a runtime image optimizer, and two shops paid for
 * it in different ways:
 *
 *   - another live shop accumulated 632 MB across 31,349 runtime-generated variants
 *     and sat permanently against a 1 GB memory ceiling, hitting it 58,695
 *     times. Every distinct width any component ever asked for became a file.
 *   - a live shop served full-size originals for weeks because the
 *     optimizer's native module failed to load — a failure with no user-visible
 *     symptom at all.
 *
 * A FIXED, SMALL set of widths generated at upload fixes both. The count is
 * bounded by this file rather than by whatever widths a designer types into a
 * component, and the work happens once, on a request that is already slow and
 * already has the bytes in memory.
 *
 * ## Why these widths
 *
 *   400  — grid tiles and the admin media library (this is the old thumb)
 *   800  — a single product card, and the 400 tile on a 2× screen
 *   1600 — the product detail image, and the 800 card on a 2× screen
 *
 * Three covers a catalogue shop's real layouts with 2× headroom. Anything wider
 * is what `original_url` is for. Changing the list changes only NEW uploads;
 * existing records keep the variants they were built with, which is why each
 * variant records its own width rather than being looked up by position.
 *
 * ## Why WebP and not AVIF
 *
 * AVIF files are smaller, and AVIF encoding is an order of magnitude slower —
 * seconds of CPU per image, in the request that an editor is waiting on, on the
 * same box that is serving the shop. On a 1 GB VPS that is how an upload becomes
 * a site-wide stall. WebP is supported by every browser these shops see, and it
 * is what the existing thumbnail already uses.
 */

/** The widths generated for every uploaded image, smallest first. */
export const DERIVATIVE_WIDTHS = [400, 800, 1600] as const;

/** Quality per width. Small images are viewed small; they can afford less. */
const QUALITY: Record<number, number> = { 400: 78, 800: 80, 1600: 82 };
const DEFAULT_QUALITY = 80;

/**
 * A refusal to decode anything absurd.
 *
 * sharp's default is 268 megapixels. A "decompression bomb" — a small file that
 * decodes to a gigantic bitmap — would allocate that as raw pixels: 268 MP is
 * about 1 GB at 4 bytes a pixel, which is the entire memory ceiling of the box
 * these shops run on. 40 MP is more than any camera an optician owns.
 */
export const MAX_INPUT_PIXELS = 40_000_000;

export interface DerivativePlan {
  width: number;
  /** `<hash>-w800.webp` — content-addressed like everything else in uploads. */
  filename: string;
}

/**
 * Which derivatives to generate for an image of this width.
 *
 * NEVER UPSCALES. A 300px logo blown up to 1600 is three files that are all
 * blurrier than the source and collectively larger than it — the storage bill
 * for making an image worse. So widths at or above the original are dropped, and
 * an image smaller than the smallest width gets exactly one derivative at its
 * own size, so that every image still has at least one modern-format variant to
 * serve and no consumer has to special-case "this one has none".
 */
export function planDerivatives(
  originalWidth: number,
  hash: string,
  widths: readonly number[] = DERIVATIVE_WIDTHS,
): DerivativePlan[] {
  if (!Number.isFinite(originalWidth) || originalWidth <= 0) return [];
  const original = Math.round(originalWidth);
  const cap = Math.max(...widths);

  // The largest derivative is CAPPED at the widest configured size, never the
  // image's own width. Generating a 4000px WebP of a 4000px camera original
  // would double the storage and hand a storefront a 3 MB image — which is the
  // "served full-size originals" failure this whole file exists to end. The
  // untouched original is still there under `original_url` for anyone who
  // genuinely needs it.
  //
  // Below the cap the image's own width IS included, so a 1200px catalogue
  // photo still has a 1200px variant and a detail view is not silently
  // downgraded to 800.
  const planned = new Set<number>(widths.filter((w) => w < original));
  planned.add(Math.min(original, cap));

  return [...planned]
    .sort((a, b) => a - b)
    .map((w) => ({ width: w, filename: `${hash}-w${w}.webp` }));
}

/** What a generated derivative looks like once it is on disk. */
export interface Derivative {
  width: number;
  height: number;
  url: string;
  size: number;
  format: 'webp';
}

export interface GenerateOptions {
  /** The loaded sharp module. Passed in so this file imports nothing native. */
  sharp: any;
  buf: Buffer;
  /** Absolute directory the files are written to. */
  dir: string;
  /** Site-relative prefix the urls are built from, e.g. `/uploads/2026/08`. */
  urlPrefix: string;
  hash: string;
  originalWidth: number;
  widths?: readonly number[];
}

/**
 * Generate the derivatives and return what actually landed on disk.
 *
 * ## Partial success is a success
 *
 * Each width is written independently and a failure on one does NOT abandon the
 * others. The previous pipeline wrapped the whole image stage in a single
 * try/catch, so a thumbnail failure discarded the dimensions that had already
 * been read — one broken step lost work that had succeeded. Here a width that
 * fails is reported in `failed` and the rest still ship.
 */
export async function generateDerivatives(
  opts: GenerateOptions,
): Promise<{ derivatives: Derivative[]; failed: { width: number; reason: string }[] }> {
  const { sharp, buf, dir, urlPrefix, hash, originalWidth, widths } = opts;
  const path = await import('node:path');
  const fs = await import('node:fs/promises');

  const derivatives: Derivative[] = [];
  const failed: { width: number; reason: string }[] = [];

  for (const plan of planDerivatives(originalWidth, hash, widths)) {
    try {
      const target = path.join(dir, plan.filename);
      const info = await sharp(buf, { failOn: 'truncated', limitInputPixels: MAX_INPUT_PIXELS })
        // `withoutEnlargement` belts the braces on planDerivatives: even if a
        // caller passes a width above the original, sharp will not upscale.
        .resize({ width: plan.width, withoutEnlargement: true })
        // Strip EXIF. A phone photo carries GPS coordinates, and an optician
        // photographing stock in the shop would be publishing the shop's
        // address and their own device id with every product image.
        .rotate()
        .webp({ quality: QUALITY[plan.width] ?? DEFAULT_QUALITY })
        .toFile(target);
      const stat = await fs.stat(target);
      derivatives.push({
        width: info.width,
        height: info.height,
        url: `${urlPrefix}/${plan.filename}`,
        size: stat.size,
        format: 'webp',
      });
    } catch (err) {
      failed.push({ width: plan.width, reason: (err as Error).message });
    }
  }

  // Ascending, so `variants[0]` is the smallest and the last is the largest.
  derivatives.sort((a, b) => a.width - b.width);
  return { derivatives, failed };
}

/**
 * Bound sharp's own resource use.
 *
 * libvips keeps an operation cache and a thread pool, both sized for a machine
 * doing nothing else. On a 1 GB VPS also running the shop, the cache is memory
 * the shop needed and the threads are CPU the shop needed. Called once per
 * process, before the first encode.
 */
export function configureSharp(sharp: any): void {
  try {
    // No operation cache: every upload is a different image, so the cache never
    // hits and only ever holds memory.
    sharp.cache(false);
    // One encode at a time. An upload is not latency-critical; a stalled shop is.
    sharp.concurrency(1);
  } catch {
    // An older or stubbed sharp without these knobs still encodes correctly.
  }
}
