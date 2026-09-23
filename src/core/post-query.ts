/**
 * The post query contract — one definition of what a filtered read MEANS.
 *
 * ## Why this module exists rather than just SQL
 *
 * `getPosts()` returns every row, and eighteen callers use it to render one
 * page. On the doc drivers that is a full JSON parse; on the relational driver
 * it is `SELECT data FROM posts` into memory and then `.slice()`. With a few
 * hundred posts nobody notices. It is still the wrong shape, and it is the
 * shape that stops this being usable at size.
 *
 * The fix needs two implementations — an in-memory one for the doc drivers and
 * a SQL one for the relational driver — and two implementations of a filter is
 * two chances to disagree. A driver that quietly orders differently, or counts
 * `total` before a filter instead of after, produces pagination that skips rows.
 * Nothing throws; the reader just never sees post 11.
 *
 * So the SEMANTICS live here, once, as a pure function. The doc drivers call it
 * directly. The SQL driver mirrors it in `WHERE`/`ORDER BY`/`LIMIT`, and a
 * differential test runs the same queries against all three drivers and asserts
 * identical output. The pure function is the specification; the SQL is an
 * optimisation that must agree with it.
 */
import type { Post } from './models';

export interface PostQuery {
  /** Exact status match. Omit for any. */
  status?: string;
  /**
   * `'page'` → pages only, `'post'` → articles only, `'all'` → both.
   *
   * Absent means ARTICLES ONLY, matching `articlesOnly()` and the API default:
   * a record with no `kind` is an article, which is how every row written
   * before Pages existed keeps its meaning.
   */
  kind?: 'post' | 'page' | 'all';
  categoryId?: string;
  /** Matches `locale`, treating an absent locale as the default. */
  locale?: string;
  /** Exact author match — used by the admin's "my posts" view. */
  authorId?: string;
  /**
   * Visibility, expressed as data so it can be pushed into SQL.
   *
   * The RULE still lives in `src/lib/visibility.ts`; this is only its
   * projection onto a query. `publishedOnly` with `orAuthorId` is exactly what
   * an `author` role sees: everything published, plus their own drafts.
   */
  visibility?: { publishedOnly: true; orAuthorId?: string };
  // NO `search` FIELD — deliberately, after trying twice.
  //
  // A text filter cannot be made to mean the same thing in both
  // implementations without work this contract does not yet do:
  //
  //  - SQLite's `LOWER()` is ASCII-ONLY. `lower('ΓΥΑΛΙΑ')` returns 'ΓΥΑΛΙΑ'
  //    unchanged, while JS `.toLowerCase()` gives 'γυαλια'. On the two live
  //    Greek shops — where ALL-CAPS product titles are routine — a search would
  //    have worked on the doc drivers and silently returned nothing on the
  //    relational one.
  //  - The repo already solved this once: `foldForSearch()` in
  //    lib/text-search.ts exists for exactly this Greek capital/accent problem.
  //    No SQL expression can reproduce it, so honouring it needs a FOLDED
  //    COLUMN written at save time — a real change, not a WHERE clause.
  //  - A `%` or `_` typed into a search box is a wildcard to LIKE and a literal
  //    to JS, so the two disagree again on ordinary punctuation.
  //
  // I shipped `search` twice: once matching content (drivers disagreed on
  // markup), then narrowed to title+slug with a comment claiming parity — which
  // was still false for any non-ASCII capital. A filter whose meaning depends
  // on the driver is worse than no filter, and nothing calls this one. Text
  // search belongs with the folded-index work, where it can be correct.
  /** Page size. Omit for all matching rows. */
  limit?: number;
  offset?: number;
  /** Newest first by default — every listing in the app wants that. */
  sort?: 'created_desc' | 'created_asc';
}

export interface PagedResult<T> {
  items: T[];
  /**
   * Rows matching the filters, BEFORE limit/offset.
   *
   * Counting after the slice would make `hasMore` always false on the last
   * page and pagination silently stop early — so it is defined here rather
   * than left to each driver to guess.
   */
  total: number;
}

/** Absent `kind` means article — the rule every surface shares. */
const matchesKind = (post: Post, kind: PostQuery['kind']): boolean => {
  if (kind === 'all') return true;
  if (kind === 'page') return post.kind === 'page';
  return post.kind !== 'page';
};

/**
 * A post's EFFECTIVE locale.
 *
 * Any value that is not a configured locale counts as the default — not just an
 * absent one. That is `recordLocale()` in lib/i18n.ts, and matching it exactly
 * matters: the route this replaced went through `filterByLocale`, so a post
 * carrying a stale, empty or since-removed locale (`''`, `'fr'` after French
 * was switched off) was still served under the default. Folding only nullish
 * values would make those posts vanish from every list with nothing logged —
 * a regression for exactly the sites that once had a second language.
 */
const effectiveLocale = (post: Post, defaultLocale: string, known: readonly string[]): string => {
  const stored = post.locale;
  return stored && known.includes(stored) ? stored : defaultLocale;
};

const matchesVisibility = (post: Post, v: PostQuery['visibility']): boolean => {
  if (!v) return true;
  if (post.status === 'published') return true;
  return !!v.orAuthorId && post.author_id === v.orAuthorId;
};

/**
 * Apply a query in memory. THE specification of what these filters mean.
 *
 * @param defaultLocale  what an absent or unconfigured `locale` counts as.
 * @param knownLocales    the configured set; anything outside it folds to the
 *   default. Both are passed in rather than imported so this module stays pure
 *   and testable — and so the i18n rule has exactly one definition, in lib.
 */
/**
 * The order posts appear in — the one definition.
 *
 * Pinned first, then manual position ascending with absent LAST, then date, then
 * id. Every layer of that exists for a reason:
 *
 * - **Pinned** is the announcement an editor wants above today's news.
 * - **`menu_order` absent-last** because an editor who positions three posts out
 *   of four hundred means "these three at the front", not "these three, then
 *   chaos". `MAX_SAFE_INTEGER` for absent, the same shape
 *   `commerce-service.ts` already uses for products — the two must read the
 *   same or a shop's blog and its catalogue order by different rules.
 * - **`id` last** makes the order TOTAL. Without it two posts written in the
 *   same millisecond can swap between pages, so one is served twice and another
 *   never — which is a paging bug that looks like a caching bug.
 *
 * `dir` flips only the DATE. Pinning is not a direction: `?sort=created_asc`
 * asking for oldest first must not also mean "pinned last".
 */
export function comparePostsForListing(
  a: Pick<Post, 'pinned' | 'menu_order' | 'created_at' | 'publish_date' | 'id'>,
  b: Pick<Post, 'pinned' | 'menu_order' | 'created_at' | 'publish_date' | 'id'>,
  dir: 1 | -1 = -1,
): number {
  const pa = a.pinned ? 0 : 1;
  const pb = b.pinned ? 0 : 1;
  if (pa !== pb) return pa - pb;

  const ma = typeof a.menu_order === 'number' && Number.isFinite(a.menu_order)
    ? a.menu_order : Number.MAX_SAFE_INTEGER;
  const mb = typeof b.menu_order === 'number' && Number.isFinite(b.menu_order)
    ? b.menu_order : Number.MAX_SAFE_INTEGER;
  if (ma !== mb) return ma - mb;

  const delta = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
  if (delta !== 0) return delta * dir;
  return (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) * dir;
}

export function applyPostQuery(
  posts: readonly Post[],
  query: PostQuery,
  defaultLocale = 'en',
  knownLocales: readonly string[] = [defaultLocale],
): PagedResult<Post> {
  let out = posts.filter((p) =>
    matchesKind(p, query.kind)
    && (query.status === undefined || p.status === query.status)
    && (query.categoryId === undefined || p.category_id === query.categoryId)
    && (query.authorId === undefined || p.author_id === query.authorId)
    && (query.locale === undefined
      || effectiveLocale(p, defaultLocale, knownLocales) === query.locale)
    && matchesVisibility(p, query.visibility));

  // Sort on a COPY. Sorting the array a storage driver handed back mutates its
  // cache — the bug that let an anonymous GET reorder the database.
  const dir = query.sort === 'created_asc' ? 1 : -1;
  out = out.slice().sort((a, b) => comparePostsForListing(a, b, dir));

  const total = out.length;
  const offset = Math.max(0, query.offset ?? 0);
  const items = query.limit === undefined
    ? out.slice(offset)
    : out.slice(offset, offset + Math.max(0, query.limit));

  return { items, total };
}
