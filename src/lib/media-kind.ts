/**
 * What a piece of media IS, and how that fact reaches a client.
 *
 * ## Why this is its own module
 *
 * It began inside `product-fields.ts`, because products were where the bug was
 * found: a manager uploaded two videos, they were appended to the product's one
 * `images` array like photographs, and the API returned `{ src, alt }` with no
 * type information at all. The storefront handed the array to an image
 * optimiser, which answered 400 for an .mp4 — a broken `<img>`, no player. The
 * same file was then eligible to become the JSON-LD `image`, the og:image and
 * the listing thumbnail.
 *
 * Products were only where it was NOTICED. A post's `featured_image` is the
 * same bare string, chosen from the same picker, returned by the same kind of
 * API to the same headless storefront. So the rule lives here, where a post
 * route can use it without importing a module named for products.
 *
 * ## The rule
 *
 * **A client must never have to infer the kind from a filename.** Everything
 * that returns media says what it is. That is one property, and these are its
 * three consequences:
 *
 *  1. Kind is derived on READ, never trusted from storage. A stored flag is a
 *     fact about when the row was last saved; every row written before the
 *     field existed, and every row written by an import, would be silently
 *     wrong — and a storefront told to trust the flag would regress on exactly
 *     those. Storage may carry the flag as a convenience; the reader re-derives
 *     it regardless.
 *  2. The media table wins. Its `mime_type` comes from the upload sniffer,
 *     which reads magic bytes. The extension is the fallback — good, because
 *     the ingester NAMES files from the sniffed type, so for anything this CMS
 *     ingested the two cannot disagree — and it is the only answer available
 *     for a src pointing at somebody else's CDN.
 *  3. A field that means "a picture" should be structurally incapable of
 *     holding a video. Filtering correctly at every consumer is a thing
 *     consumers do not do.
 */

/**
 * Extensions this CMS will call video.
 *
 * Deliberately short. A longer list would classify as playable a file that
 * never got past the uploader, or — for an imported catalogue pointing at
 * somebody else's CDN — one most browsers cannot play. Naming two formats that
 * work beats implying support for six that do not.
 */
export const VIDEO_EXTENSIONS = ['.mp4', '.webm'] as const;

/**
 * What a src IS, decided by its own extension.
 *
 * The extension rather than a stored flag, because a src can arrive three ways
 * — uploaded here, picked from the library, or pasted as somebody else's URL —
 * and only the last could carry a flag a client set.
 *
 * The uploader's sniffer remains the security boundary: it reads magic bytes,
 * and an extension proves nothing. This is a RENDERING hint over values that
 * have already been through it, or over a remote URL this CMS never controlled
 * either way.
 */
export function mediaKindOf(src: string): 'image' | 'video' {
  const path = String(src || '').split(/[?#]/, 1)[0].toLowerCase();
  return VIDEO_EXTENSIONS.some((ext) => path.endsWith(ext)) ? 'video' : 'image';
}

/** True when this entry should be rendered with a `<video>` element. */
export function isVideoMedia(img: { src?: string; kind?: string } | undefined): boolean {
  if (!img) return false;
  return img.kind === 'video' || mediaKindOf(String(img.src ?? '')) === 'video';
}

/**
 * `url -> mime_type`, built once per request from the media table.
 *
 * A Map rather than a lookup per entry: a catalogue page resolves hundreds of
 * srcs, and the alternative is hundreds of scans of the media list.
 */
export type MediaKindIndex = Map<string, string>;

export function buildMediaKindIndex(
  rows: readonly { url?: string; mime_type?: string }[],
): MediaKindIndex {
  const index: MediaKindIndex = new Map();
  for (const row of rows ?? []) {
    if (typeof row?.url === 'string' && typeof row.mime_type === 'string') {
      index.set(row.url, row.mime_type);
    }
  }
  return index;
}

/** What one src is, and its mime type when the media table knows it. */
export interface ResolvedMedia {
  src: string;
  kind: 'image' | 'video';
  /**
   * The media library's own `mime_type`, present only when the src resolves to
   * a media record. Never invented — absent means "this CMS did not ingest
   * this file", which is a different statement from "it is an image".
   */
  mime_type?: string;
}

/**
 * Resolve one src. The single place the precedence in rule 2 is expressed.
 */
export function resolveMedia(src: string, index?: MediaKindIndex): ResolvedMedia {
  const mime = index?.get(src);
  const kind: 'image' | 'video' = mime
    ? (mime.startsWith('video/') ? 'video' : 'image')
    : mediaKindOf(src);
  return { src, kind, ...(mime ? { mime_type: mime } : {}) };
}

/**
 * A post's featured media, described rather than assumed.
 *
 * Returns undefined for a post with no featured image, so "there is none" and
 * "there is one and it is a photograph" stay distinguishable — a caller that
 * collapses them renders an empty `<img>`.
 */
export function resolveFeaturedMedia(
  src: string | undefined | null,
  index?: MediaKindIndex,
): ResolvedMedia | undefined {
  const s = String(src ?? '').trim();
  return s ? resolveMedia(s, index) : undefined;
}

/**
 * Project a post for a reader, so a storefront never guesses.
 *
 * ADDITIVE: `featured_image` is left exactly as stored, because it is the write
 * field and an editor form round-trips it. What is added is the description of
 * it, plus the pair of fields that make the common case correct by
 * construction:
 *
 *  - `featured_photo` — the picture, ABSENT when the featured media is a video.
 *    This is the field a card thumbnail, an og:image or a JSON-LD `image`
 *    should read. It cannot hold a video, so a consumer that reads it cannot
 *    make the mistake this module exists to prevent.
 *  - `featured_video` — set only when it IS a video, so a storefront that wants
 *    to render a player has somewhere honest to look.
 */
export function withFeaturedMediaKind<T extends { featured_image?: string | null }>(
  post: T,
  index?: MediaKindIndex,
): T & {
  featured_media?: ResolvedMedia;
  featured_photo?: string;
  featured_video?: string;
} {
  const media = resolveFeaturedMedia(post.featured_image, index);
  if (!media) return post;
  return {
    ...post,
    featured_media: media,
    ...(media.kind === 'video' ? { featured_video: media.src } : { featured_photo: media.src }),
  };
}
