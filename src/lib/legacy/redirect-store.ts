/**
 * The live redirect index, and the 404 recorder.
 *
 * The impure half of legacy-URL recovery: everything that touches storage or
 * keeps state, kept apart from the rules in `redirects.ts` so those stay
 * testable without a database.
 *
 * ## Why an in-memory index at all
 *
 * This is consulted on every request that matches no route — which, on a shop
 * with a hijacked Merchant feed, is a crawler flood. A database read per
 * unmatched request would turn somebody else's spam into load on the shop's
 * own database, which is the opposite of the point.
 *
 * So the map is read ONCE, indexed, and rebuilt only when an operator changes
 * it. The common case costs one Map lookup.
 */

import { LocalDB } from '../localdb';
import {
  buildIndex,
  resolveRedirect,
  normalizePath,
  EMPTY_INDEX,
  type RedirectIndex,
  type RedirectMatch,
  type RedirectRule,
} from './redirects';
import { recordHit, type NotFoundRecord } from './not-found-log';

let index: RedirectIndex = EMPTY_INDEX;
let loaded: Promise<void> | null = null;
/** When the current index finished loading (Date.now()); 0 while none has. */
let loadedAt = 0;
let refreshing = false;

/**
 * How stale the map may get when ANOTHER process changed it.
 *
 * `reloadRedirects()` runs after a write, but only in the process that took
 * the write. A second replica kept the map it loaded at boot for as long as it
 * ran: a redirect added in the admin worked on one replica and 404'd on the
 * other, and one deleted kept redirecting. Now a map older than this is
 * re-read in the background — the request that notices is served from the map
 * it already has, so no request waits on the database for it — and the new
 * one replaces it when it is built. Bound: another process's change is live
 * here within 15 s plus one load.
 */
export const REDIRECTS_TTL_MS = 15_000;

/**
 * Load and index the map.
 *
 * Memoised on the PROMISE, not a boolean: a boolean set before the first await
 * lets every concurrent request past while the load is still running, and they
 * would all see an empty index — the same bug the plugin bootstrap had, with
 * the same symptom, on the path that exists to rescue traffic.
 */
export function ensureRedirectsLoaded(): Promise<void> {
  if (loaded && loadedAt && !refreshing && Date.now() - loadedAt >= REDIRECTS_TTL_MS) {
    refreshing = true;
    const startedFor = loaded;
    void LocalDB.getRedirects().then(
      (rules) => {
        // A reloadRedirects() that ran meanwhile has the fresher answer.
        if (loaded === startedFor) {
          index = buildIndex(rules);
          loadedAt = Date.now();
        }
      },
      (err) => {
        // Keep serving the map we have; try again after another TTL.
        console.error('[astrobaas] could not refresh the redirect map:', err);
        loadedAt = Date.now();
      },
    ).finally(() => { refreshing = false; });
  }
  if (!loaded) {
    loaded = (async () => {
      const rules = await LocalDB.getRedirects();
      index = buildIndex(rules);
      loadedAt = Date.now();
    })().catch((err) => {
      // A redirect map that will not load must not take the site down. Serve
      // without it — the visitor gets the 404 they would have got anyway.
      console.error('[astrobaas] could not load the redirect map:', err);
      index = EMPTY_INDEX;
      loaded = null;
    });
  }
  return loaded;
}

/**
 * Rebuild after a write, at once. A write on ANOTHER process reaches this one
 * through the REDIRECTS_TTL_MS refresh in `ensureRedirectsLoaded` instead.
 */
export async function reloadRedirects(): Promise<void> {
  loaded = null;
  await ensureRedirectsLoaded();
}

/** How many rules are live. For the admin and for diagnostics. */
export function redirectIndexSize(): number {
  return index.size;
}

/**
 * Resolve a path against the live map.
 *
 * Synchronous and allocation-light on the miss path, because a miss is the
 * common case under a crawl.
 */
export function matchRedirect(path: string, search = ''): RedirectMatch | null {
  if (index.size === 0) return null;
  return resolveRedirect(index, path, search);
}

/* ------------------------------------------------------------------ *
 * Counting
 * ------------------------------------------------------------------ */

/**
 * Hit counters, flushed on a timer rather than written per request.
 *
 * A counter written synchronously would put a database write on the redirect
 * path — so the busier a rule got, the more it would cost, which is exactly
 * backwards. Buffered in memory and flushed at most once every FLUSH_MS.
 *
 * The cost of a crash is a few lost counts on a statistic. That is the right
 * trade against a write per request.
 */
const FLUSH_MS = 30_000;
const pendingHits = new Map<string, { count: number; at: string }>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

export function noteRedirectHit(rule: RedirectRule, at = new Date().toISOString()): void {
  const prev = pendingHits.get(rule.id);
  pendingHits.set(rule.id, { count: (prev?.count ?? 0) + 1, at });
  scheduleFlush();
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushCounters();
  }, FLUSH_MS);
  // Never hold the process open for a statistic.
  if (typeof flushTimer === 'object' && flushTimer && 'unref' in flushTimer) {
    (flushTimer as { unref: () => void }).unref();
  }
}

export async function flushCounters(): Promise<void> {
  if (pendingHits.size === 0 && pendingNotFound.length === 0) return;

  if (pendingHits.size > 0) {
    const batch = new Map(pendingHits);
    pendingHits.clear();
    try {
      const rules = await LocalDB.getRedirects();
      for (const rule of rules) {
        const pending = batch.get(rule.id);
        if (!pending) continue;
        await LocalDB.saveRedirect({
          ...rule,
          hits: (rule.hits ?? 0) + pending.count,
          last_hit_at: pending.at,
        });
      }
    } catch (err) {
      console.error('[astrobaas] could not flush redirect counters:', err);
    }
  }

  if (pendingNotFound.length > 0) {
    const batch = pendingNotFound.splice(0, pendingNotFound.length);
    try {
      let records: NotFoundRecord[] = await LocalDB.getNotFound();
      for (const hit of batch) records = recordHit(records, hit);
      await LocalDB.putNotFound(records);
    } catch (err) {
      console.error('[astrobaas] could not flush the 404 log:', err);
    }
  }
}

/* ------------------------------------------------------------------ *
 * The 404 log
 * ------------------------------------------------------------------ */

/**
 * Buffered 404s, bounded twice over.
 *
 * The in-memory buffer is capped as well as the stored set: a flood between two
 * flushes must not grow the heap, and dropping the overflow costs a count on a
 * report rather than anything a shopper sees.
 */
const MAX_BUFFERED = 2000;
const pendingNotFound: { path: string; search?: string; referrer?: string; at: string }[] = [];

export function noteNotFound(
  path: string,
  search?: string,
  referrer?: string,
  at = new Date().toISOString(),
): void {
  if (pendingNotFound.length >= MAX_BUFFERED) return;
  pendingNotFound.push({ path: normalizePath(path), search, referrer, at });
  scheduleFlush();
}

/** Test seam. Never called by production code. */
export function _resetForTest(): void {
  index = EMPTY_INDEX;
  loaded = null;
  loadedAt = 0;
  refreshing = false;
  pendingHits.clear();
  pendingNotFound.length = 0;
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
}
