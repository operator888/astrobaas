/**
 * Media folders (C-61) — labels, not directories.
 *
 * ## What was there, and what was missing
 *
 * `PATCH /api/media/update` has accepted and stored a `folder` since it was
 * written. Nothing ever read it: `folder` was absent from the `MediaFile`
 * interface, so it was invisible to every typed reader, and the library route
 * had no way to filter by one. A write-only phantom — the exact
 * schema-versus-reader shape this codebase keeps finding.
 *
 * ## Labels, deliberately
 *
 * Files do not move on disk. They stay content-addressed under
 * `/uploads/yyyy/mm/<hash>.<ext>`, and a folder is a label on the record.
 *
 * Real directories would mean rewriting a URL that is already embedded in
 * published posts, in a feed somebody's reader cached, and in whatever a
 * headless storefront rendered last week. A rename would silently break every
 * one of them, and nothing in the product would say so. A label renames for
 * free and breaks nothing.
 */

/** Longer than this is a sentence, not a label. */
export const MAX_FOLDER_NAME = 120;

/**
 * Normalise a folder label.
 *
 * ONE implementation, called by the writer AND by the filter. They used to be
 * two: the writer trimmed and truncated inline, and the filter did not exist —
 * so the first version of the filter would have had to guess the writer's rule
 * and would eventually have guessed differently, which is how a patched folder
 * becomes invisible to the filter meant to find it.
 *
 * A slash is stripped rather than kept, because a label containing one reads as
 * a path and this is not one; angle brackets and quotes because the value is
 * rendered in the library UI.
 */
export function cleanFolderName(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[/\\<>"']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_FOLDER_NAME);
}

export interface FolderCount {
  /** `''` is the unfiled bucket. */
  name: string;
  count: number;
}

/**
 * Every folder in use, with how many files are in it.
 *
 * The unfiled bucket is counted too and comes first: on a library that has
 * never used folders it is the whole list, and a sidebar that showed nothing
 * would look broken rather than empty.
 */
export function folderCounts(
  media: readonly { folder?: string }[],
): FolderCount[] {
  const counts = new Map<string, number>();
  for (const m of media) {
    const name = cleanFolderName(m.folder);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const unfiled = counts.get('') ?? 0;
  counts.delete('');
  const named = [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return unfiled > 0 ? [{ name: '', count: unfiled }, ...named] : named;
}

/**
 * Narrow a library to one folder.
 *
 * `wanted` is what the caller asked for, cleaned by the same function the
 * writer used. An EMPTY string means the unfiled bucket, which is a real
 * request and not the same as "no filter" — the caller distinguishes them by
 * whether the parameter was present at all.
 */
export function inFolder<T extends { folder?: string }>(
  media: readonly T[],
  wanted: string,
): T[] {
  const want = cleanFolderName(wanted);
  return media.filter((m) => cleanFolderName(m.folder) === want);
}
