/**
 * Replacing the file behind a media record, in place.
 *
 * ## Why this is not "overwrite the file"
 *
 * Uploads are content-addressed — the path is a hash of the bytes — and served
 * with `Cache-Control: immutable, max-age=31536000`. Writing new bytes to the
 * same path would therefore leave every browser and CDN that has ever seen it
 * serving the OLD file for up to a year. The operator would replace a logo,
 * see the new one in the media library, and every visitor would keep seeing
 * the old one. That is the worst possible shape for a bug: invisible to the
 * person who made the change.
 *
 * So the new bytes get their own address, like any upload, and:
 *
 *  - the RECORD keeps its id, alt text, uploader and creation date, so
 *    everything that references it by id shows the new picture immediately;
 *  - every stored REFERENCE to the old URLs is rewritten — post and page
 *    content and featured images, product images (variant overrides and every
 *    translated description included) and brand logos — because a replace
 *    that leaves the old picture on every page is a replace in name only;
 *  - the old files are unlinked, but only the ones no other record points at.
 *
 * ## What is deliberately not automatic
 *
 * Nothing outside this database is rewritten: a hard-coded URL in a theme's
 * source, or in a page built elsewhere against the API, keeps pointing at the
 * old file. The old file is gone, so that reference breaks visibly rather than
 * silently showing the wrong image — which is the better of the two failures,
 * and the report says how many references were found so an operator can tell
 * whether they should go looking.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { LocalDB } from '../localdb';
import { getUploadsDir } from '../paths';
import { mediaFilePaths, legacyDerivedPaths } from './files';
import { ingestMedia, type IngestInput } from './ingest';
import type { Brand, MediaFile, Post, Product } from '../../core/models';

export interface ReplaceResult {
  ok: true;
  media: MediaFile;
  /** old URL → new URL, for every path the record owned. */
  rewrote: Record<string, string>;
  /** How many stored records had a reference updated. */
  updated: { posts: number; products: number };
  /** Files removed from disk. */
  removedFiles: number;
  /** Old files kept because another record still points at them. */
  keptShared: number;
}

export type ReplaceOutcome = ReplaceResult | { ok: false; error: string };

/**
 * Pair up the paths of the old record with the new one's.
 *
 * Paired by ROLE — main to main, thumbnail to thumbnail, and each width to the
 * same width — rather than by position, because the two records can have
 * different numbers of derivatives: replacing a 2000px photo with a 500px one
 * legitimately produces fewer. A width with no counterpart falls back to the
 * new main image, so a page that embedded the 1200px version shows the new
 * picture at whatever size exists rather than a 404.
 */
export function pairUrls(oldRec: MediaFile, newRec: MediaFile): Record<string, string> {
  const out: Record<string, string> = {};
  const put = (from: unknown, to: unknown) => {
    if (typeof from === 'string' && typeof to === 'string' && from && to && from !== to) {
      out[from] = to;
    }
  };
  const o = oldRec as MediaFile & { thumb_url?: string; original_url?: string; variants?: { width: number; url: string }[] };
  const n = newRec as MediaFile & { thumb_url?: string; original_url?: string; variants?: { width: number; url: string }[] };

  put(o.url, n.url);
  // `thumb_url` normally points at one of the variants, which the loop below
  // would map anyway. Named explicitly because "normally" is not a guarantee,
  // and an unmapped URL is a broken image on a live page.
  put(o.thumb_url, n.thumb_url ?? n.url);
  put(o.original_url, n.original_url ?? n.url);

  const byWidth = new Map((n.variants ?? []).map((v) => [v.width, v.url]));
  for (const v of o.variants ?? []) {
    put(v.url, byWidth.get(v.width) ?? n.url);
  }
  return out;
}

/**
 * Swap every occurrence of the old URLs for the new ones in a block of text.
 *
 * Whole-URL matches only, and longest-first. Without the ordering a shorter
 * path that is a prefix of a longer one — `/uploads/2026/01/ab.webp` inside
 * `/uploads/2026/01/ab.webp?v=2` is fine, but `…/ab.webp` and `…/ab.webp` for
 * a 400 vs 1400 variant are not — would be replaced first and corrupt the
 * longer one.
 */
export function rewriteUrls(text: string, map: Record<string, string>): string {
  const keys = Object.keys(map).sort((a, b) => b.length - a.length);
  let out = text;
  for (const from of keys) {
    if (!out.includes(from)) continue;
    out = out.split(from).join(map[from]);
  }
  return out;
}

/** Rewrite every stored reference. Returns how many records changed. */
async function rewriteReferences(map: Record<string, string>): Promise<{ posts: number; products: number }> {
  if (Object.keys(map).length === 0) return { posts: 0, products: 0 };
  const counts = { posts: 0, products: 0 };

  // Posts and pages: the URL lives inside stored HTML.
  const posts = (await LocalDB.getPosts()) as Post[];
  for (const p of posts) {
    const before = p.content ?? '';
    const after = rewriteUrls(before, map);
    // The featured image is a URL field of its own, not part of the content.
    // The field is `featured_image` — the first version wrote `cover_image`,
    // a name that exists nowhere in the model, so featured images silently
    // kept pointing at the deleted file while everything else moved.
    const beforeCover = p.featured_image ?? '';
    const afterCover = beforeCover ? rewriteUrls(beforeCover, map) : beforeCover;
    if (after === before && afterCover === beforeCover) continue;
    await LocalDB.updatePost(p.id, {
      ...(after !== before ? { content: after } : {}),
      ...(afterCover !== beforeCover ? { featured_image: afterCover } : {}),
    } as Partial<Post>);
    counts.posts += 1;
  }

  // Products carry image URLs in an array, plus their own description HTML —
  // and a URL can also hide in two places the first version missed: a
  // VARIANT's image override, and every TRANSLATED description in the i18n
  // sidecar. Missing the latter meant a bilingual shop's non-default pages
  // kept the URL of the file the replace had just unlinked.
  const products = (await LocalDB.getProducts()) as Product[];
  for (const prod of products) {
    const images = prod.images ?? [];
    const nextImages = images.map((img) => {
      const src = rewriteUrls(String(img.src ?? ''), map);
      return src === img.src ? img : { ...img, src };
    });
    const desc = prod.description ?? '';
    const nextDesc = desc ? rewriteUrls(desc, map) : desc;

    const variants = (prod as Product & { variants?: { image?: string }[] }).variants;
    let variantsChanged = false;
    const nextVariants = variants?.map((v) => {
      if (typeof v.image !== 'string' || !v.image) return v;
      const image = rewriteUrls(v.image, map);
      if (image === v.image) return v;
      variantsChanged = true;
      return { ...v, image };
    });

    const i18n = prod.i18n;
    let i18nChanged = false;
    let nextI18n: Record<string, Record<string, string>> | undefined;
    if (i18n && typeof i18n === 'object') {
      const outMap: Record<string, Record<string, string>> = {};
      for (const [locale, fields] of Object.entries(i18n)) {
        const outFields: Record<string, string> = {};
        for (const [field, value] of Object.entries(fields ?? {})) {
          const next = typeof value === 'string' ? rewriteUrls(value, map) : value;
          if (next !== value) i18nChanged = true;
          outFields[field] = next as string;
        }
        outMap[locale] = outFields;
      }
      nextI18n = outMap;
    }

    const changed = nextImages.some((img, i) => img !== images[i])
      || nextDesc !== desc || variantsChanged || i18nChanged;
    if (!changed) continue;
    await LocalDB.updateProduct(prod.id, {
      images: nextImages,
      ...(nextDesc !== desc ? { description: nextDesc } : {}),
      ...(variantsChanged ? { variants: nextVariants } : {}),
      ...(i18nChanged ? { i18n: nextI18n } : {}),
    } as Partial<Product>);
    counts.products += 1;
  }

  // Brand logos are media paths of their own.
  const brands = (await LocalDB.getBrands()) as { id: string; logo?: string }[];
  for (const b of brands) {
    if (typeof b.logo !== 'string' || !b.logo) continue;
    const logo = rewriteUrls(b.logo, map);
    if (logo === b.logo) continue;
    await LocalDB.updateBrand(b.id, { logo } as Partial<Brand>);
  }

  return counts;
}

/**
 * Remove the old files, unless something else still points at them.
 *
 * Two uploads of identical bytes share one path — that is what
 * content-addressing means — so a blind unlink here would delete a file a
 * different record is still serving. The same check the delete route makes.
 */
async function unlinkUnshared(paths: string[], keepForId: string): Promise<{ removed: number; kept: number }> {
  const all = (await LocalDB.getMedia()) as MediaFile[];
  const stillUsed = new Set<string>();
  for (const rec of all) {
    // EVERY record protects its paths — including the one being kept. The
    // first version excluded the kept record, and by the time this runs its
    // row already carries the NEW paths: any path in both the old and the new
    // set (identical bytes, same month, a different pipeline outcome) was
    // unlinked out from under the record just updated to serve it. Its OLD
    // paths are no longer on the row, so they stay deletable.
    for (const p of mediaFilePaths(rec)) stillUsed.add(p);
    // The delete route also protects legacy pre-derivative thumbnails other
    // records may still be serving; the same rule applies here.
    if (rec.id !== keepForId) {
      for (const p of legacyDerivedPaths(rec)) stillUsed.add(p);
    }
  }

  let removed = 0;
  let kept = 0;
  const root = getUploadsDir();
  for (const rel of paths) {
    if (stillUsed.has(rel)) { kept += 1; continue; }
    const abs = path.join(root, rel.replace(/^\/uploads\//, ''));
    // The paths come from our own records, but a traversal here would delete
    // outside the uploads directory, so it is checked rather than trusted.
    if (!abs.startsWith(root + path.sep)) { kept += 1; continue; }
    try {
      await fs.unlink(abs);
      removed += 1;
    } catch {
      // Already gone is the same outcome as removed, from here.
    }
  }
  return { removed, kept };
}

/**
 * Replace the file behind `id` with new bytes.
 *
 * The new file goes through `ingestMedia` — the same magic-byte sniffing, SVG
 * sanitization, EXIF stripping and derivative generation an upload gets. A
 * replacement is an upload; it must not be a second, weaker path into the
 * media library.
 */
export async function replaceMediaFile(
  id: string,
  buf: Buffer,
  input: Omit<IngestInput, 'altText'>,
): Promise<ReplaceOutcome> {
  await LocalDB.init();
  const existing = ((await LocalDB.getMedia()) as MediaFile[]).find((m) => m.id === id) ?? null;
  if (!existing) return { ok: false, error: 'No such media file' };

  const ingested = await ingestMedia(buf, input);
  if (!ingested.ok) return { ok: false, error: ingested.error };

  const incoming = ingested.media as MediaFile & Record<string, unknown>;

  // The identical file. Nothing to do, and everything below would be
  // destructive: the "old" paths are the new ones, so unlinking them would
  // delete the file that was just uploaded.
  if (incoming.url === existing.url) {
    await LocalDB.deleteMediaFile(incoming.id);
    return {
      ok: true,
      media: existing,
      rewrote: {},
      updated: { posts: 0, products: 0 },
      removedFiles: 0,
      keptShared: 0,
    };
  }

  const map = pairUrls(existing, incoming);
  // The record's named paths PLUS the legacy pre-derivative candidates the
  // delete route also cleans — guesses to try, never mistaken for facts, and
  // still checked against every other record before unlinking.
  const oldPaths = [...new Set([...mediaFilePaths(existing), ...legacyDerivedPaths(existing)])];

  // Drop the record ingest created FIRST, then move the new file's identity
  // onto the existing record. In this order a crash between the two leaves an
  // orphaned FILE on disk (invisible, and reclaimed the next time the same
  // bytes are ingested); the old order left an orphaned RECORD — a stray
  // duplicate sitting in the media library with no cleanup anywhere. The id
  // is what every reference elsewhere uses, and keeping it is the entire
  // point of replacing rather than re-uploading.
  await LocalDB.deleteMediaFile(incoming.id);
  // The fields listed here are the ones that describe the FILE. Everything
  // else on the record describes the picture or its history — `alt_text`,
  // `uploaded_by`, `created_at` — and survives precisely because it is not
  // named: replacing a logo with a better scan of the same logo must not
  // silently blank the alt text somebody wrote for it.
  const updated = await LocalDB.updateMediaFile(id, {
    filename: incoming.filename,
    mime_type: incoming.mime_type,
    size: incoming.size,
    url: incoming.url,
    thumb_url: incoming.thumb_url ?? null,
    original_url: incoming.original_url ?? null,
    width: incoming.width ?? null,
    height: incoming.height ?? null,
    variants: incoming.variants ?? null,
    pipeline: incoming.pipeline ?? null,
    original_name: incoming.original_name,
  } as Partial<MediaFile>);

  // References first, files second. If the process dies between the two, the
  // site points at files that exist; the other order points at files that do
  // not.
  const counts = await rewriteReferences(map);
  const { removed, kept } = await unlinkUnshared(oldPaths, id);

  return {
    ok: true,
    media: (updated ?? existing) as MediaFile,
    rewrote: map,
    updated: counts,
    removedFiles: removed,
    keptShared: kept,
  };
}
