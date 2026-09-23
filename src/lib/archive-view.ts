/**
 * Assembling an archive listing (C-153) — author, date, category.
 *
 * ## Why this is one module
 *
 * `blog/index.astro` already held ~80 lines of exactly this: cards, breadcrumb
 * trail, the CollectionPage entity, the canonical URL and the pagination hrefs.
 * That page's own comments record THREE drifts that happened inside it — the
 * canonical said `/blog` while the CollectionPage entity said `/blog?page=2`,
 * and the category filter and the pagination disagreed about which parameters
 * survive a page change.
 *
 * Three more archive routes copying it would be three more chances to make the
 * same mistake in a different place.
 *
 * ## Author archives are OPT-IN
 *
 * An author archive publishes a staff member's DISPLAY NAME at a stable public
 * URL, and on the installs this runs the "authors" are shop staff rather than
 * bylined journalists. So a person is listed only when they have opted in, and
 * the default is off — the opposite default would publish a team roster the day
 * somebody upgraded.
 */
import type { Post, User } from '../core/models';
import { slugify } from './validate';

/** The setting that switches author archives on at all. */
export const AUTHOR_ARCHIVES_SETTING = 'author_archives_enabled';
/** The per-user opt-in, on the user record. */
export const AUTHOR_ARCHIVE_FLAG = 'public_archive';

export interface ArchivePage {
  /** Everything the listing needs to describe itself. */
  title: string;
  description: string;
  /** Site-relative, WITHOUT a page parameter — see `pageHref`. */
  basePath: string;
}

/**
 * The slug an author is reachable at.
 *
 * Derived at read time with the same `slugify` everything else uses, rather
 * than stored on the user — a stored field means a migration, and a second
 * place for the name and the slug to disagree.
 */
export function authorSlug(user: Pick<User, 'name' | 'email'>): string {
  return slugify(user.name?.trim() || String(user.email ?? '').split('@')[0] || 'author');
}

/**
 * Find the user an author slug names.
 *
 * Returns `null` when TWO users slug the same, rather than picking one: showing
 * the wrong person's posts under their colleague's name is worse than a 404,
 * and it is not something the reader could detect.
 */
export function authorBySlug<T extends Pick<User, 'name' | 'email'>>(
  users: readonly T[],
  slug: string,
): T | null {
  const matches = users.filter((u) => authorSlug(u) === slug);
  return matches.length === 1 ? matches[0] : null;
}

/** Has this person agreed to have a public archive? */
export function authorOptedIn(user: Record<string, unknown> | null | undefined): boolean {
  return user?.[AUTHOR_ARCHIVE_FLAG] === true;
}

/** Months present in a set of posts, newest first — for a date archive index. */
export function monthsOf(posts: readonly Post[]): { year: number; month: number; count: number }[] {
  const counts = new Map<string, number>();
  for (const p of posts) {
    const iso = p.publish_date || p.created_at;
    const at = iso ? new Date(iso) : null;
    if (!at || Number.isNaN(at.valueOf())) continue;
    const key = `${at.getUTCFullYear()}-${at.getUTCMonth() + 1}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => {
      const [year, month] = key.split('-').map(Number);
      return { year, month, count };
    })
    .sort((a, b) => b.year - a.year || b.month - a.month);
}

/**
 * Narrow posts to one month.
 *
 * Filtered in the route rather than pushed into `PostQuery`, deliberately: a
 * date range in the query means a second SQL implementation to keep in step
 * with the in-memory comparator, and an archive page is already bounded by the
 * posts a site has.
 */
export function inMonth(posts: readonly Post[], year: number, month: number): Post[] {
  return posts.filter((p) => {
    const iso = p.publish_date || p.created_at;
    const at = iso ? new Date(iso) : null;
    if (!at || Number.isNaN(at.valueOf())) return false;
    return at.getUTCFullYear() === year && at.getUTCMonth() + 1 === month;
  });
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** `2026-03` → `March 2026`. Falls back rather than throwing on a bad month. */
export function monthLabel(year: number, month: number): string {
  const name = MONTH_NAMES[month - 1];
  return name ? `${name} ${year}` : String(year);
}

/**
 * The href for one page of an archive.
 *
 * The base path carries no page parameter and page 1 adds none — so `/blog` and
 * `/blog?page=1` are not two URLs for one listing, which is the duplicate-content
 * shape a canonical then has to clean up after.
 */
export function pageHref(basePath: string, page: number): string {
  return page <= 1 ? basePath : `${basePath}?page=${page}`;
}

/** How many pages a listing has. At least one, so an empty archive still renders. */
export function pageCount(total: number, perPage: number): number {
  return Math.max(1, Math.ceil(total / Math.max(1, perPage)));
}
