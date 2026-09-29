/**
 * Where popular-search counts live, and how they get there.
 *
 * Counted in memory and written every 30 seconds, like the 404 log: a search is
 * the most frequent request a site answers, and one storage write per search
 * would turn every query into a write — on the JSON driver, a rewrite of the
 * whole database file.
 *
 * "Each visitor counts once per query per day" is enforced here with a set of
 * hashes of (visitor, query, day) held in MEMORY only — nothing that identifies
 * a visitor is ever written to storage. The set is cleared when the day
 * changes, and bounded so a flood cannot grow it without limit. Several
 * instances each keep their own set, so a visitor spread across instances can
 * count a few times; the minimum count absorbs that.
 *
 * Several instances flushing at once merge by read-then-write, and the last
 * write wins — counts are approximate by design, and "popular" survives it.
 */
import { createHash, randomBytes } from 'node:crypto';
import { LocalDB } from '../localdb';
import { storableQuery, countQueries, looksLikeBot, type PopularEntry } from './popular';

export const POPULAR_NS = '@core:search-popular';
const RECORD_ID = 'counts';
// 30 s; SEARCH_POPULAR_FLUSH_MS shortens it for the smoke suite, which cannot wait.
const FLUSH_MS = Number(process.env.SEARCH_POPULAR_FLUSH_MS) > 0 ? Number(process.env.SEARCH_POPULAR_FLUSH_MS) : 30_000;
const CACHE_MS = 60_000;
const MAX_SEEN = 50_000;

const pending = new Map<string, number>();
const seen = new Set<string>();
let seenDay = '';
// A per-process salt, so the in-memory hashes are not a lookup table of IPs.
const salt = randomBytes(16).toString('hex');
let timer: ReturnType<typeof setTimeout> | null = null;
let cache: { at: number; entries: PopularEntry[] } | null = null;

/**
 * Note one search. Call it only after the search ran, with how many results it
 * found — a search that found nothing is never counted.
 */
export function notePopularSearch(rawQuery: unknown, results: number, visitor: string | undefined, now = new Date(), userAgent?: string | null): void {
  if (!(results > 0)) return;
  // `undefined` = the caller did not say (tests); a caller that passes the
  // header gets bots filtered.
  if (userAgent !== undefined && looksLikeBot(userAgent)) return;
  const q = storableQuery(rawQuery);
  if (!q) return;
  const day = now.toISOString().slice(0, 10);
  if (day !== seenDay) { seen.clear(); seenDay = day; }
  const key = createHash('sha256').update(`${salt}|${visitor ?? 'anon'}|${q}|${day}`).digest('hex').slice(0, 24);
  if (seen.has(key)) return;
  // Bounded. Full means a flood (or a very busy day): start the set again
  // rather than stop counting for everyone until tomorrow. The cost is that a
  // visitor may count twice in one day, which the minimum count absorbs.
  if (seen.size >= MAX_SEEN) seen.clear();
  seen.add(key);
  pending.set(q, (pending.get(q) ?? 0) + 1);
  schedule();
}

function schedule(): void {
  if (timer) return;
  timer = setTimeout(() => { timer = null; void flushPopular(); }, FLUSH_MS);
  if (typeof timer === 'object' && timer && 'unref' in timer) (timer as { unref: () => void }).unref();
}

export async function flushPopular(now = new Date()): Promise<void> {
  if (!pending.size) return;
  const batch = new Map(pending);
  pending.clear();
  try {
    const at = now.toISOString();
    const entries = countQueries(await readStored(), batch, at);
    await LocalDB.putPluginData(POPULAR_NS, RECORD_ID, { entries });
    cache = { at: Date.now(), entries };
  } catch (err) {
    console.error('[astrobaas] could not save popular searches:', err);
  }
}

async function readStored(): Promise<PopularEntry[]> {
  const row = await LocalDB.getPluginDataRecord(POPULAR_NS, RECORD_ID);
  const e = (row?.data as { entries?: unknown } | undefined)?.entries;
  return Array.isArray(e) ? (e as PopularEntry[]).filter((x) => x && typeof x.query === 'string' && Number.isFinite(x.count)) : [];
}

/** The counts, from a cache refreshed at most once a minute. */
export async function popularEntries(): Promise<PopularEntry[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.entries;
  const entries = await readStored();
  cache = { at: Date.now(), entries };
  return entries;
}

/** Forget every count — the admin's "clear" button. */
export async function clearPopular(): Promise<void> {
  pending.clear();
  await LocalDB.deletePluginDataRecord(POPULAR_NS, RECORD_ID);
  cache = { at: Date.now(), entries: [] };
}
