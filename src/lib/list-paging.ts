/**
 * `?limit=&offset=&page=` for the public list endpoints, read once.
 *
 * ## The gap this closes
 *
 * `GET /api/posts` and `GET /api/content/{type}` each parsed paging by hand,
 * identically, and both treated "no `limit`" as "everything". So one anonymous
 * request with no query string rendered, sanitised and serialised the whole
 * blog — or the whole comments collection — and the next request did it again.
 * That is the read-amplification shape: cheap to ask, expensive to answer, and
 * the per-IP rate limit counts requests, not work.
 *
 * ## Why the unpaged ceiling is 1000 and not 20
 *
 * Both live storefronts may call these endpoints with no `limit` and render
 * what comes back. A default of 20 would silently truncate a blog archive the
 * day this deploys, and nobody would notice until a reader asked where the old
 * posts went. 1000 is larger than any collection either shop holds, so their
 * responses stay byte-identical, while the cost of one request stops growing
 * with the collection.
 *
 * When the ceiling DOES cut a list, the response says so the way a paged one
 * always has: `meta.total` is the full count and `meta.hasMore` is `true`. The
 * next slice is `?offset=1000` — offset has always been honoured without a
 * limit. `meta.limit` stays `null` when the caller sent none, exactly as
 * before, so a client that branches on it sees no change.
 *
 * An EXPLICIT limit keeps its old ceiling of 200 and its old meaning. This only
 * changes what "no limit" means.
 */

/** The largest page a caller may ask for. Unchanged. */
export const MAX_PAGE_SIZE = 200;

/** How many rows a request with NO `limit` returns, at most. */
export const MAX_UNPAGED_ITEMS = 1000;

export interface ListPaging {
  /** What the caller asked for, clamped — `undefined` when they sent nothing. */
  limit: number | undefined;
  /** How many rows to actually return: `limit`, or the unpaged ceiling. */
  take: number;
  offset: number;
}

/** Read paging from a query string. Never throws; nonsense reads as absent or 0. */
export function parseListPaging(sp: URLSearchParams): ListPaging {
  const limitRaw = sp.get('limit');
  const offsetRaw = sp.get('offset');
  const pageRaw = sp.get('page');
  const limit = limitRaw
    ? Math.min(Math.max(parseInt(limitRaw, 10) || 0, 0), MAX_PAGE_SIZE)
    : undefined;
  let offset = offsetRaw ? Math.max(parseInt(offsetRaw, 10) || 0, 0) : 0;
  // ?page= is a 1-based convenience that computes the offset from the limit.
  if (pageRaw && limit) offset = (Math.max(parseInt(pageRaw, 10) || 1, 1) - 1) * limit;
  return { limit, take: limit ?? MAX_UNPAGED_ITEMS, offset };
}

/** A page of `items` out of an already-filtered list. */
export function takePage<T>(all: readonly T[], paging: ListPaging): T[] {
  return all.slice(paging.offset, paging.offset + Math.max(0, paging.take));
}

/**
 * The envelope fields every paged list publishes, unchanged in shape.
 *
 * `hasMore` is now true whenever rows remain, with or without a limit. Before,
 * it was hard-wired to `false` without one — which was true only because the
 * response held everything.
 */
export function pagingMeta(paging: ListPaging, count: number, total: number) {
  return {
    total,
    count,
    limit: paging.limit ?? null,
    offset: paging.offset,
    page: paging.limit ? Math.floor(paging.offset / paging.limit) + 1 : 1,
    hasMore: paging.offset + count < total,
  };
}
