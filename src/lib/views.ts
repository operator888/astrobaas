/**
 * Counting article views, for real.
 *
 * ## What was there before
 *
 * `Post.views` was written as `0` in five places, read in two admin displays,
 * and incremented **nowhere**. The dashboard's "Total views" tile and every
 * per-post count were permanently zero, presented as measurement. The parity
 * scoreboard claimed this shipped and cited `lib/page-view.ts`, which renders a
 * page and contains the word "views" zero times.
 *
 * ## Why a buffer and not an increment per request
 *
 * On the lowdb driver a write is a read-modify-write of the WHOLE document
 * under a lock. The caching adapter's own measurements put a 26.5 MB database
 * at 158.7 ms per parse. Incrementing a counter on every page view would
 * therefore serialise every visitor behind a full document rewrite — a
 * view counter that makes the site slower the more it is read.
 *
 * So views accumulate in memory and are written in one pass on the scheduler's
 * existing tick. The cost of that is the honest one: **a process that dies
 * loses at most one interval of counts.** For a vanity metric on a blog that is
 * the right trade; for anything a decision rests on it would not be, and this
 * is deliberately not billing data.
 *
 * ## What counts, and what does not
 *
 * A view is a human asking for ONE article — a rendered post page, or the
 * public single-post API read that a headless storefront makes for the same
 * purpose. Both live shops are headless, so counting only server-rendered pages
 * would have measured zero for the two installs that matter most.
 *
 * Listing pages, admin reads, feeds and sitemap crawls are not views. Nor are
 * obvious bots: a counter that includes crawlers measures crawler enthusiasm
 * rather than readership, and the number is then worse than none because it
 * looks like readership.
 *
 * ## No personal data, so no consent question
 *
 * A per-post integer. No visitor id, no cookie, no address, nothing retained
 * about who read what. That is what keeps this outside the consent machinery
 * and out of the GDPR export — and it is why it stays an aggregate even though
 * a per-visitor version would be more useful.
 */
import { LocalDB } from './localdb';

/** postId → views accumulated since the last flush. */
const pending = new Map<string, number>();

/**
 * A cap on how many distinct posts we will hold between flushes.
 *
 * Not a real limit in normal use — a blog does not have 50,000 articles read in
 * one minute — but an unbounded map fed by request handlers is a memory leak
 * waiting for an unusual afternoon.
 */
export const MAX_PENDING_POSTS = 50_000;

/**
 * Flush on our own once this many views are waiting.
 *
 * The scheduler's tick is the normal writer, but SCHEDULER_DISABLED=1 is a
 * documented, supported switch — and with it set the counts accumulated in
 * memory and were NEVER written, so a shop that turned the scheduler off got
 * the permanently-zero dashboard back with no way to tell. This makes the
 * counter self-sufficient: the scheduler stays the tidy path, and the buffer
 * writes itself out when it grows, however the process is configured.
 */
export const FLUSH_AT_PENDING = 200;

/** One flush at a time. A second would read the same batch and double-count. */
let flushing = false;
/** The flush in progress, so a shutdown can wait for it (see `flushViewsBeforeExit`). */
let currentFlush: Promise<number> | null = null;

/**
 * User agents that are not readers.
 *
 * Deliberately a short, boring list of substrings rather than a clever
 * heuristic. It catches the crawlers that generate the volume; it will not
 * catch a determined scraper, and pretending otherwise would be the same kind
 * of overclaim this file exists to correct.
 */
const BOT_HINTS = [
  'bot', 'crawl', 'spider', 'slurp', 'facebookexternalhit', 'preview',
  'monitor', 'uptime', 'curl', 'wget', 'python-requests', 'axios',
  'headless', 'lighthouse', 'pingdom', 'gtmetrix', 'semrush', 'ahrefs',
];

/**
 * Is this CALLER a reader, or the shop's own staff?
 *
 * The first version excluded every request with a session, reasoning that an
 * editor opening the admin editor should not inflate the count. True — but an
 * API-KEY caller also has a user (its id starts with `apikey:`), and a headless
 * storefront fetching an article to render it for a visitor IS a reader. Both
 * live shops are headless, so the check excluded exactly the traffic it existed
 * to measure and both counted zero.
 *
 * So: anonymous counts, an API key counts, a signed-in human does not.
 */
export function isReaderRequest(user: { id?: string } | null | undefined): boolean {
  if (!user) return true;
  return typeof user.id === 'string' && user.id.startsWith('apikey:');
}

/** Is this request worth counting as a read by a person? */
export function isCountableAgent(userAgent: unknown): boolean {
  if (typeof userAgent !== 'string') return false;
  const ua = userAgent.trim();
  // No user agent at all is a script, not a browser.
  if (ua === '') return false;
  const lower = ua.toLowerCase();
  return !BOT_HINTS.some((hint) => lower.includes(hint));
}

/**
 * Record one view. Cheap, synchronous, never throws.
 *
 * Callers are request handlers on the hot path, so this does no I/O and returns
 * nothing to await. A caller that forgets to check `isCountableAgent` still
 * gets counted, so the check lives at the call site where the headers are.
 */
export function recordView(postId: unknown): void {
  if (typeof postId !== 'string' || postId === '') return;
  if (!pending.has(postId) && pending.size >= MAX_PENDING_POSTS) return;
  pending.set(postId, (pending.get(postId) ?? 0) + 1);

  // Fire-and-forget once the buffer is big enough. NOT awaited: this runs on a
  // request handler's hot path and a view must never make a page wait on a
  // database write.
  // pendingViewCount(), not pending.size. `size` is the number of DISTINCT
  // POSTS buffered, so a blog with four articles could accumulate a hundred
  // thousand views and never reach a threshold of 200 — the self-flush existed
  // and could not fire on exactly the small sites that need it.
  if (!flushing && pendingViewCount() >= FLUSH_AT_PENDING) {
    void flushViews().catch(() => {});
  }
}

/** How many views are waiting to be written. For the operations screen. */
export function pendingViewCount(): number {
  let total = 0;
  for (const n of pending.values()) total += n;
  return total;
}

/** Testing seam: drop everything buffered without writing it. */
export function resetPendingViews(): void {
  pending.clear();
}

/**
 * Write the buffered counts.
 *
 * Returns how many posts were updated. Called by the scheduler; safe to call
 * concurrently with `recordView`, because the buffer is swapped out FIRST — a
 * view arriving mid-flush lands in the new map and is written next time rather
 * than being lost or double-counted.
 *
 * A post that has since been deleted is skipped, not treated as an error: a
 * view of an article that was removed a moment later is a real thing that
 * happens, and it must not stop the other counts being written.
 */
export async function flushViews(): Promise<number> {
  if (pending.size === 0) return 0;
  // Two concurrent flushes would each swap out a batch, and a failure in one
  // would put counts back that the other had already written.
  if (flushing) return 0;
  flushing = true;
  const run = flushOnce();
  currentFlush = run;
  try {
    return await run;
  } finally {
    flushing = false;
    currentFlush = null;
  }
}

/**
 * The last flush a process makes, on its way out (src/lib/shutdown.ts).
 *
 * `flushViews()` returns 0 at once when another flush is running — right for
 * the scheduler, which will simply try again next tick, and wrong for a
 * process about to exit, for which there is no next tick. If the scheduler's
 * flush happened to be mid-write when the signal arrived, a plain
 * `flushViews()` here would report nothing to do, the process would exit, and
 * every view recorded since that flush swapped its batch out would be lost.
 *
 * So wait for the running one to settle first, then flush whatever is left.
 * `flushOnce` never rejects (it catches and re-buffers), so the wait cannot
 * throw; the loop covers a flush that a request's `recordView` started in the
 * gap.
 */
export async function flushViewsBeforeExit(): Promise<number> {
  let written = 0;
  while (currentFlush) {
    const running = currentFlush;
    written += await running;
    // flushViews' own `finally` clears the slot before this line runs (its
    // continuation was registered first). If it somehow has not, stop rather
    // than spin on a settled promise.
    if (currentFlush === running) break;
  }
  return written + await flushViews();
}

async function flushOnce(): Promise<number> {

  // Swap, then work from the copy. Doing it the other way round loses every
  // view that arrives while the awaits below are in flight.
  const batch = new Map(pending);
  pending.clear();

  try {
    // ONE call for the whole batch, through a write that touches only the
    // counter. `updatePost` would stamp `updated_at` — so a READ would move the
    // modification date the sitemap publishes as `lastmod` — and append a full
    // old+new snapshot to the capped content change feed, evicting real
    // editorial history. It also rewrites the whole document once per post.
    return await LocalDB.bumpPostViews(batch);
  } catch (err) {
    // The buffer is the ONLY copy of these counts, so a transient failure must
    // put them back — but ONLY the ones that did not land. A write that throws
    // part-way through has already committed some, and returning those to the
    // buffer counts them twice on the retry. `written` on the error tells us
    // which; without it, the safe-looking choice is the wrong one.
    const landed = (err as { landed?: unknown })?.landed;
    const already = landed instanceof Set ? landed : new Set<string>();
    for (const [postId, delta] of batch) {
      if (already.has(postId)) continue;
      pending.set(postId, (pending.get(postId) ?? 0) + delta);
    }
    console.error('View flush failed:', err instanceof Error ? err.message : err);
    return 0;
  }
}
