/**
 * The broken-media report (C-151).
 *
 * The sibling of the broken-link report, and it exists for the same reason: a
 * reference that stops resolving does not announce itself. A deleted media file
 * leaves an `<img>` behind in every post that used it, and what the reader sees
 * is a broken-image icon on an otherwise finished article. Nothing logs it,
 * because serving a 404 for a file is not an error — the request was answered.
 *
 * ## Resolved against the database, never fetched
 *
 * Exactly like the internal half of `link-check.ts`, and for the same three
 * reasons: it is instant, it is exact, and it cannot produce a false positive.
 * A media record is the authority on what the library serves.
 *
 * ## What is deliberately NOT reported
 *
 * - **Anything outside the uploads path.** `/images/hero.jpg` is a file in
 *   `public/`, shipped with the theme, and the database knows nothing about it.
 *   Calling it broken because no media record answers to it would fill the
 *   report with entries that are fine — and a report with false entries in it
 *   is one an author learns to close.
 * - **Remote and `data:` sources.** `normaliseImageKey` returns `''` for both.
 *   Answering for them means fetching them, which is the external half's
 *   problem and carries the external half's caveats.
 * - **Drafts.** A draft pointing at a file the author has not uploaded yet is
 *   work in progress, not a defect.
 *
 * What remains is the case that actually happens: a file was in the library,
 * an author put it in an article, and somebody deleted it from the library.
 */
import type { Post } from '../core/models';
import { collectImageSources, normaliseImageKey, mediaRecordKeys } from './image-dimensions';

/** The prefix the media pipeline writes and serves. See `lib/media-url.ts`. */
export const UPLOADS_PREFIX = '/uploads/';

export interface BrokenMedia {
  postId: string;
  postTitle: string;
  postSlug: string;
  /** The normalised path, which is what an author searches the library for. */
  src: string;
  /** Body image, or the post's featured image. */
  where: 'body' | 'featured';
  reason: string;
}

/**
 * Every key the library can answer for.
 *
 * Built once for the whole sweep: the alternative is a scan of the media list
 * per image, which on a site with a few hundred posts and a few hundred files
 * is the shape that makes an admin page time out.
 */
export function servedMediaKeys(
  media: readonly { url?: string; thumb_url?: string; variants?: readonly { url?: string }[] }[],
): Set<string> {
  const keys = new Set<string>();
  for (const m of media) for (const key of mediaRecordKeys(m)) keys.add(key);
  return keys;
}

/** True when this source is ours to answer for and nothing answers for it. */
function isBroken(src: string, served: ReadonlySet<string>): boolean {
  const key = normaliseImageKey(src);
  if (!key) return false;                       // remote, data:, unparseable
  if (!key.startsWith(UPLOADS_PREFIX)) return false;  // a theme asset, not ours
  return !served.has(key);
}

/**
 * Scan published records for media references the library cannot answer.
 *
 * Sorted by title then src so the same input produces the same report
 * whichever driver returned the rows — a report that reshuffles between loads
 * cannot be worked through from top to bottom.
 */
export function scanBrokenMedia(
  posts: readonly Post[],
  media: readonly { url?: string; thumb_url?: string; variants?: readonly { url?: string }[] }[],
): BrokenMedia[] {
  const served = servedMediaKeys(media);
  const out: BrokenMedia[] = [];

  for (const post of posts) {
    if (post.status !== 'published') continue;
    const seen = new Set<string>();

    for (const src of collectImageSources(post.content ?? '')) {
      if (!isBroken(src, served)) continue;
      const key = normaliseImageKey(src);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        postId: post.id,
        postTitle: post.title || post.slug,
        postSlug: post.slug,
        src: key,
        where: 'body',
        reason: 'No file in the media library answers this path.',
      });
    }

    // The featured image is the one that shows up in the archive, the card, the
    // Open Graph tag and the feed — so a broken one is visible in four places
    // the author never opens.
    const featured = typeof post.featured_image === 'string' ? post.featured_image : '';
    if (featured && isBroken(featured, served)) {
      out.push({
        postId: post.id,
        postTitle: post.title || post.slug,
        postSlug: post.slug,
        src: normaliseImageKey(featured),
        where: 'featured',
        reason: 'The featured image is not in the media library.',
      });
    }
  }

  out.sort((a, b) =>
    a.postTitle.localeCompare(b.postTitle)
    || a.src.localeCompare(b.src)
    || a.where.localeCompare(b.where)
    || a.postId.localeCompare(b.postId));
  return out;
}

/**
 * Library files no published record references.
 *
 * The other direction, and deliberately advisory: a file can be legitimately
 * unreferenced — a logo used in settings, a PDF linked from a theme, an image
 * held for next week. It is offered as "nothing links to these", never as
 * "these are safe to delete", because this scan reads post CONTENT and cannot
 * see a settings value or a hardcoded theme path.
 */
export function unreferencedMedia(
  posts: readonly Post[],
  media: readonly { id?: string; url?: string; original_name?: string; thumb_url?: string; variants?: readonly { url?: string }[] }[],
): { id: string; url: string; name: string }[] {
  const used = new Set<string>();
  for (const post of posts) {
    if (post.status !== 'published') continue;
    for (const src of collectImageSources(post.content ?? '')) used.add(src);
    const featured = typeof post.featured_image === 'string' ? normaliseImageKey(post.featured_image) : '';
    if (featured) used.add(featured);
  }

  const out: { id: string; url: string; name: string }[] = [];
  for (const m of media) {
    if (typeof m.url !== 'string' || !m.url) continue;
    // A record is referenced when ANY of its urls is — an author who inserted
    // the thumbnail is still using the file.
    if (mediaRecordKeys(m).some((key) => used.has(key))) continue;
    out.push({ id: String(m.id ?? ''), url: m.url, name: m.original_name || m.url });
  }
  out.sort((a, b) => a.name.localeCompare(b.name) || a.url.localeCompare(b.url));
  return out;
}
