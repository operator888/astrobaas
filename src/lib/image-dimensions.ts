import { escapeHtml as escapeAttr } from './escape-html';
/**
 * `width` and `height` on content images — the CLS fix (C-58).
 *
 * ## Where the layout shift actually is
 *
 * Not in the theme's images. `PostCard` and the article hero are sized entirely
 * by CSS (`h-48 object-cover`), so the browser knows the box before the file
 * arrives and nothing moves — adding attributes there would set an intrinsic
 * ratio that CSS immediately overrides, which is why `PostCard` says in so many
 * words that it would be wrong.
 *
 * It is in the BODY. An `<img>` the author dropped into a paragraph is styled by
 * the prose defaults with `height: auto`, so until the file loads the browser
 * reserves zero height and every paragraph below it jumps down when it arrives.
 * That is the shift readers feel and the one Core Web Vitals measures.
 *
 * ## Why the dimensions are handed in rather than looked up
 *
 * This module is pure and synchronous, like `lazyLoadContentImages` beside it in
 * the pipeline. Every settings and media read in this codebase is async, and
 * `applyFilters` is not — so the rule that has held everywhere else holds here:
 * the async call site does the reading and hands the result to the filter. A
 * module that reached for the database would also have to be awaited from four
 * call sites, one of which is a plugin filter chain that cannot await.
 *
 * ## The ratio is the point, not the pixels
 *
 * The attributes are the file's OWN dimensions. CSS still decides the rendered
 * width (`max-width: 100%`), and the browser uses the ratio of the two
 * attributes to reserve the right height for whatever width it lands on. So
 * publishing a 3000px-wide file's real numbers is correct and does not make the
 * image render at 3000px.
 */

/** A `<img …>` tag, whole. Matching the tag rather than parsing: the html is sanitized. */
const IMG_TAG = /<img\b[^>]*>/gi;
const SRC_ATTR = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i;

export interface ImageSize {
  width: number;
  height: number;
}

/**
 * Normalise a src to the key both sides of the lookup agree on.
 *
 * A body image can be written as `/uploads/x.webp`, as an absolute URL on the
 * CMS's own origin (which is what a decoupled storefront's editor produces),
 * or with a cache-busting query. All three name one file, and a map keyed by
 * the raw attribute would miss two of them.
 *
 * Returns `''` for anything that is not a path we can key on — a `data:` URI,
 * or a remote host, whose dimensions we do not know and must not guess at.
 */
export function normaliseImageKey(src: string): string {
  if (!src) return '';
  const raw = src.trim();
  if (/^data:/i.test(raw)) return '';
  let path = raw;
  if (/^https?:\/\//i.test(raw)) {
    try {
      path = new URL(raw).pathname;
    } catch {
      return '';
    }
  } else if (/^\/\//.test(raw)) {
    // Protocol-relative — a remote host, not ours.
    return '';
  }
  // Drop query and fragment: `?v=2` is a cache-buster, not a different image.
  path = path.split('#')[0].split('?')[0];
  if (!path.startsWith('/')) return '';
  try {
    // An editor may store the path percent-encoded; the media record does not.
    path = decodeURI(path);
  } catch {
    /* malformed escape — key on the raw path rather than throwing */
  }
  return path;
}

/**
 * Every image source in `html`, normalised and deduplicated.
 *
 * Called before the media lookup so the caller fetches dimensions for the
 * handful of images this document actually uses, rather than loading the whole
 * media library to answer a question about three files.
 */
export function collectImageSources(html: string): string[] {
  if (!html || !html.includes('<img')) return [];
  const out = new Set<string>();
  for (const tag of html.match(IMG_TAG) ?? []) {
    const m = SRC_ATTR.exec(tag);
    const key = normaliseImageKey(m ? (m[1] ?? m[2] ?? '') : '');
    if (key) out.add(key);
  }
  return [...out];
}

/**
 * Add `width` and `height` to body images that have neither.
 *
 * An image carrying EITHER attribute is left alone entirely. Adding the missing
 * one would combine an author's deliberate number with the file's own and
 * produce a ratio that matches nothing — a distorted image is worse than an
 * unreserved box, because it looks like a broken upload rather than a slow one.
 */
export function applyImageDimensions(
  html: string,
  sizes: ReadonlyMap<string, ImageSize>,
): string {
  if (!html || !html.includes('<img') || sizes.size === 0) return html;
  return html.replace(IMG_TAG, (tag) => {
    if (/\b(width|height)\s*=/i.test(tag)) return tag;
    const m = SRC_ATTR.exec(tag);
    const key = normaliseImageKey(m ? (m[1] ?? m[2] ?? '') : '');
    if (!key) return tag;
    const size = sizes.get(key);
    // Both, and both positive. A record with a width and no height — which
    // happens when sharp was unavailable at upload — gives a ratio of
    // width/0, and the browser reserves a box of infinite height.
    if (!size || !(size.width > 0) || !(size.height > 0)) return tag;
    return tag.replace(
      /\s*\/?>$/,
      (end) => ` width="${Math.round(size.width)}" height="${Math.round(size.height)}"${end.trim() === '/>' ? ' />' : '>'}`,
    );
  });
}

/**
 * Fill in a missing `alt` on body images from the media library.
 *
 * ## Only a MISSING attribute, never an empty one
 *
 * `alt=""` is correct, deliberate markup: it marks an image as decorative so a
 * screen reader skips it. Filling that from the media record makes every spacer
 * and divider announce a filename-derived caption — an accessibility
 * REGRESSION dressed as an improvement. So the guard is the presence of the
 * attribute, not the emptiness of its value, which is the same distinction
 * `applyImageDimensions` makes one function up and for the same reason.
 *
 * ## Why here rather than in a module of its own
 *
 * `IMG_TAG`, `SRC_ATTR` and `normaliseImageKey` all live in this file. A second
 * pass over `<img>` tags somewhere else would be a fourth img regex in the tree
 * and would drift from this one the first time a src form changed.
 */
export function applyImageAltText(
  html: string,
  altByKey: ReadonlyMap<string, string>,
): string {
  if (!html || !html.includes('<img') || altByKey.size === 0) return html;
  return html.replace(IMG_TAG, (tag) => {
    if (/\balt\s*=/i.test(tag)) return tag;
    const m = SRC_ATTR.exec(tag);
    const key = normaliseImageKey(m ? (m[1] ?? m[2] ?? '') : '');
    if (!key) return tag;
    const alt = altByKey.get(key);
    if (!alt) return tag;
    return tag.replace(
      /\s*\/?>$/,
      (end) => ` alt="${escapeAttr(alt)}"${end.trim() === '/>' ? ' />' : '>'}`,
    );
  });
}

/**
 * Escape a value for an HTML attribute.
 *
 * Alt text is operator-typed and reaches this as a raw string. `ingestMedia`
 * already strips `<>"'` on write, but a row written before that rule existed —
 * or straight into the database — has not been through it, and this function
 * writes an attribute.
 */

/**
 * Body images carrying no `alt` attribute at all — the audit half of C-62.
 *
 * `alt=""` is NOT reported: it is a decision, and a report that flags correct
 * markup teaches its reader to ignore it. Returns the sources so a caller can
 * say which image, and the count so it can say how many.
 */
export function imagesMissingAlt(html: string): string[] {
  if (!html || !html.includes('<img')) return [];
  const out: string[] = [];
  for (const tag of html.match(IMG_TAG) ?? []) {
    if (/\balt\s*=/i.test(tag)) continue;
    const m = SRC_ATTR.exec(tag);
    out.push((m ? (m[1] ?? m[2] ?? '') : '').trim() || '(no src)');
  }
  return out;
}

/**
 * Build the lookup from media records.
 *
 * Keyed by BOTH the record's own url and its thumbnail/derivative urls, because
 * an author who inserted a smaller derivative into the body gets that file's
 * dimensions rather than the original's — the ratio is usually the same, but
 * "usually" is how a rounded thumbnail ends up reserving the wrong box.
 */
export function altFromMedia(
  media: readonly {
    url?: string;
    alt_text?: string;
    thumb_url?: string;
    variants?: readonly { url?: string }[];
  }[],
  wanted?: ReadonlySet<string>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of media) {
    const alt = typeof m.alt_text === 'string' ? m.alt_text.trim() : '';
    if (!alt) continue;
    // Every url this record answers to — the original, the thumbnail and every
    // derivative — because an author who inserted a 400px variant into the body
    // described the same picture.
    for (const key of mediaRecordKeys(m)) {
      if (out.has(key)) continue;
      if (wanted && !wanted.has(key)) continue;
      out.set(key, alt);
    }
  }
  return out;
}

/**
 * Every normalised key ONE media record answers to — the original, the
 * thumbnail and every derivative.
 *
 * Extracted because three callers need exactly this walk (dimensions, alt text
 * and the broken-media report) and a fourth would have written a fourth
 * spelling of it. An author who inserted a 400px variant into the body is
 * looking at the same picture as the one who inserted the original, so a
 * lookup that only knew `url` would answer "unknown" for two thirds of them.
 */
export function mediaRecordKeys(m: {
  url?: string;
  thumb_url?: string;
  variants?: readonly { url?: string }[];
}): string[] {
  const out: string[] = [];
  for (const url of [m.url, m.thumb_url, ...(m.variants ?? []).map((v) => v.url)]) {
    if (typeof url !== 'string') continue;
    const key = normaliseImageKey(url);
    if (key && !out.includes(key)) out.push(key);
  }
  return out;
}

export function sizesFromMedia(
  media: readonly {
    url?: string;
    width?: number;
    height?: number;
    variants?: readonly { url?: string; width?: number; height?: number }[];
  }[],
  wanted?: ReadonlySet<string>,
): Map<string, ImageSize> {
  const out = new Map<string, ImageSize>();
  const add = (url: unknown, width: unknown, height: unknown) => {
    if (typeof url !== 'string') return;
    const key = normaliseImageKey(url);
    if (!key || out.has(key)) return;
    if (wanted && !wanted.has(key)) return;
    const w = Number(width);
    const h = Number(height);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return;
    out.set(key, { width: w, height: h });
  };
  for (const m of media) {
    add(m.url, m.width, m.height);
    for (const v of m.variants ?? []) add(v.url, v.width, v.height);
  }
  return out;
}
