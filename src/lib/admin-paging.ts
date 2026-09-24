/**
 * Pagination for the admin's list screens (products, posts and pages).
 *
 * The products screen rendered EVERY product into one page and filtered them
 * in the browser, so its cost grew with the catalogue — a few thousand rows is
 * already a slow first paint, and the Enterprise target is hundreds of
 * thousands. Posts and pages were paged, ten at a time with only Previous /
 * Next, and the controls vanished below eleven rows. Both screens now share
 * this module and `components/admin/Pagination.astro`.
 *
 * Everything here is pure: the page reads the query string, filters its own
 * list, and asks for the slice. The URL is the state, so a page is linkable,
 * survives a reload, and the Back button works.
 */

/** Page sizes offered in the selector. Anything else in the URL falls back to the default. */
export const PAGE_SIZES = [25, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 25;

export interface Paging {
  /** 1-based, clamped into range — `?page=999` on a 3-page list shows page 3. */
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  /** Index of the first item on this page (0-based). */
  start: number;
  /** One past the last item on this page. `start === end` means the page is empty. */
  end: number;
}

/**
 * Read `?page=` and `?per=` and work out the slice for `total` items. Never
 * throws: a missing, negative or non-numeric value reads as the default.
 */
export function readPaging(sp: URLSearchParams, total: number): Paging {
  const per = Number(sp.get('per'));
  const pageSize = (PAGE_SIZES as readonly number[]).includes(per) ? per : DEFAULT_PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const asked = Math.floor(Number(sp.get('page')));
  const page = Math.min(Math.max(Number.isFinite(asked) && asked > 0 ? asked : 1, 1), totalPages);
  const start = (page - 1) * pageSize;
  return { page, pageSize, total, totalPages, start, end: Math.min(start + pageSize, total) };
}

/**
 * The page numbers to show, with `null` for a gap: always the first and last
 * page, and `radius` pages either side of the current one.
 *   pageWindow(6, 20) → [1, null, 5, 6, 7, null, 20]
 * A gap that would hide a single page shows the page instead (1, 2, 3 rather
 * than 1, …, 3), because "…" standing in for one number is worse than the number.
 */
export function pageWindow(current: number, totalPages: number, radius = 1): Array<number | null> {
  const keep = new Set<number>([1, totalPages]);
  for (let p = current - radius; p <= current + radius; p++) {
    if (p >= 1 && p <= totalPages) keep.add(p);
  }
  const sorted = [...keep].sort((a, b) => a - b);
  const out: Array<number | null> = [];
  for (const p of sorted) {
    const prev = out.length ? out[out.length - 1] : null;
    if (typeof prev === 'number' && p - prev === 2) out.push(prev + 1);
    else if (typeof prev === 'number' && p - prev > 2) out.push(null);
    out.push(p);
  }
  return out;
}

/**
 * A link to the same list with some parameters changed, everything else kept —
 * the search, the filters. `null` removes a parameter. Changing the page size
 * or a filter should reset `page`, which the caller does by passing `page: null`.
 */
export function listHref(sp: URLSearchParams, changes: Record<string, string | number | null>): string {
  const next = new URLSearchParams(sp);
  for (const [k, v] of Object.entries(changes)) {
    if (v === null || v === '') next.delete(k);
    else next.set(k, String(v));
  }
  // Page 1 and the default size are the defaults; leaving them out keeps URLs short.
  if (next.get('page') === '1') next.delete('page');
  if (next.get('per') === String(DEFAULT_PAGE_SIZE)) next.delete('per');
  const qs = next.toString();
  return qs ? `?${qs}` : '?';
}
