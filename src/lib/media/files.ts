/**
 * Which files on disk one media record owns.
 *
 * A record used to own at most two paths — the image and its thumbnail — and
 * delete.ts handled the second one with a "derive the sibling" string
 * substitution. With a fixed set of derivatives plus a preserved original, a
 * record owns up to six, so the set has to be READ from the record rather than
 * guessed from its main url.
 *
 * Guessing is not a stylistic complaint: every path this function fails to
 * return is a file that survives a delete at a mechanically derivable URL, which
 * is "deleted" media anyone can still fetch. That exact bug has already been
 * fixed once here, for thumbnails.
 */

/** Every uploads-relative path a record points at, deduplicated. */
export function mediaFilePaths(record: unknown): string[] {
  const r = record as {
    url?: unknown;
    thumb_url?: unknown;
    original_url?: unknown;
    variants?: unknown;
  } | null;
  if (!r || typeof r !== 'object') return [];

  const out = new Set<string>();
  const add = (v: unknown) => {
    // Only paths under /uploads/ are ours to delete. An imported catalogue's
    // absolute URL points at somebody else's server.
    if (typeof v === 'string' && v.startsWith('/uploads/')) out.add(v);
  };

  add(r.url);
  add(r.thumb_url);
  add(r.original_url);
  if (Array.isArray(r.variants)) {
    for (const v of r.variants) add((v as { url?: unknown })?.url);
  }
  return [...out];
}

/**
 * Paths a record written BEFORE derivatives existed would have on disk.
 *
 * Old rows carry no `variants`, so their 400px derivative is only findable by
 * reconstructing the name the old upload path produced. Kept separate from
 * mediaFilePaths so that a guess can never be mistaken for a fact: these are
 * candidates to try, not paths we know exist.
 *
 * Returned even when the record DOES name a thumbnail, as long as it names a
 * different one. The backfill script repoints `thumb_url` from the old
 * `<hash>-thumb.webp` to the new `<hash>-w400.webp`, and a row that had been
 * through it would otherwise leave the old file on disk forever — publicly
 * fetchable media that a delete was supposed to remove. Unlinking a guess is
 * safe because the caller still checks it against every other record's paths
 * first.
 */
export function legacyDerivedPaths(record: unknown): string[] {
  const r = record as { url?: unknown; thumb_url?: unknown } | null;
  if (!r || typeof r.url !== 'string' || !r.url.startsWith('/uploads/')) return [];
  const guess = r.url.replace(/\.[^./]+$/, '-thumb.webp');
  // Nothing to guess if the record already points at that exact file.
  if (r.thumb_url === guess) return [];
  return [guess];
}
