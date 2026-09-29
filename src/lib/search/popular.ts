/**
 * Popular searches: the queries visitors run most, offered as suggestions.
 *
 * ## Privacy first, because a search box is where people type anything
 *
 * A query is someone's words. Before one is ever counted, let alone shown to a
 * stranger, it has to pass all of these:
 *
 *  - **it found something.** Only searches that returned results are counted.
 *    A person's name, an email or an order number typed into the box matches no
 *    product, so it is never stored. (Counting the searches that found NOTHING
 *    is zero-result analytics, which belongs to the paid search module.)
 *  - **it does not look personal.** Anything with an `@`, a web address, or a
 *    run of digits (a phone number, a card, an order number) is dropped even if
 *    it matched something. So is anything over 60 characters.
 *  - **many people searched it.** A query is SHOWN only once it reaches the
 *    operator's minimum count (default 5), and each visitor counts once per
 *    query per day — so one person cannot put their own words in front of
 *    everyone by searching them repeatedly.
 *  - **the operator has the last word.** A blocklist hides any query, or any
 *    query containing a blocked word.
 *
 * The pure half lives here; `popular-store.ts` buffers and persists.
 */
import { foldForSearch } from '../text-search';

export const MAX_QUERY_CHARS = 60;
/** Distinct queries kept. The least searched fall off first. */
export const MAX_TRACKED = 500;
/** A query nobody has searched for this long is forgotten. */
export const FORGET_AFTER_MS = 90 * 24 * 60 * 60 * 1000;

export interface PopularEntry {
  /** The query as shown: trimmed, spaces collapsed, lower-cased. */
  query: string;
  count: number;
  last: string;
}

/**
 * The query as it would be stored, or null when it must never be stored.
 * Lower-cased so "Sunglasses" and "sunglasses" are one query.
 */
export function storableQuery(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // Personal-data checks run on the text as typed (an @, a URL, a number)...
  const typed = raw.trim().replace(/\s+/g, ' ').toLowerCase();
  if (typed.includes('@') || /https?:|www\.|\.[a-z]{2,}\//.test(typed) || /[<>{}]/.test(typed)) return null;
  // ...and the stored form keeps letters, digits and single spaces only, the
  // way search itself tokenises: "idiot!", "idiot," and "idiot" are one query,
  // so a blocklist entry catches every spelling.
  const q = typed.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  if (q.length < 2 || q.length > MAX_QUERY_CHARS) return null;
  if (q.includes('@')) return null;                        // an email address
  if (/https?:|www\.|\.[a-z]{2,}\//.test(q)) return null;  // a web address
  if (/\d{5,}/.test(q.replace(/[\s\-().+/]/g, ''))) return null; // phone, card, order numbers
  const digits = (q.match(/\d/g) ?? []).length;
  if (digits / q.replace(/\s/g, '').length > 0.5) return null;   // mostly a number
  if (/[<>{}]/.test(q)) return null;                       // markup is not a search
  return q;
}

/** Count one search. Returns a new list; never mutates. */
export function countQuery(entries: readonly PopularEntry[], query: string, times: number, at: string): PopularEntry[] {
  return countQueries(entries, new Map([[query, times]]), at);
}

/** Count a whole flush at once: one pass and one sort, however many queries. */
export function countQueries(entries: readonly PopularEntry[], batch: ReadonlyMap<string, number>, at: string): PopularEntry[] {
  const byQuery = new Map(entries.map((e) => [e.query, { ...e }]));
  for (const [query, times] of batch) {
    const hit = byQuery.get(query);
    if (hit) { hit.count += times; hit.last = at; } else byQuery.set(query, { query, count: times, last: at });
  }
  return prune([...byQuery.values()], Date.parse(at));
}

/** Forget stale queries, then keep the most searched. */
export function prune(entries: readonly PopularEntry[], nowMs: number): PopularEntry[] {
  return entries
    .filter((e) => nowMs - Date.parse(e.last) < FORGET_AFTER_MS)
    .sort((a, b) => b.count - a.count || b.last.localeCompare(a.last))
    .slice(0, MAX_TRACKED);
}

/** The blocklist setting (one word or phrase per line) as folded terms. */
export function parseBlocklist(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  return raw.split(/\r?\n/).map((l) => normaliseTerms(l)).filter((l) => l.length > 0).slice(0, 500);
}

/** Folded (accents, case) with punctuation as spaces — how queries and the blocklist are compared. */
function normaliseTerms(text: string): string {
  return foldForSearch(text).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/**
 * A crawler, not a person. Links to `/blog?q=<phrase>` planted elsewhere get
 * fetched by search engines from many addresses — enough distinct "visitors"
 * to push a phrase into everyone's suggestions — so bots are never counted.
 */
export function looksLikeBot(userAgent: string | null | undefined): boolean {
  if (!userAgent) return true;
  return /bot|crawl|spider|slurp|facebookexternalhit|preview|headless|curl|wget|python|httpclient|monitor/i.test(userAgent);
}

export function validateBlocklist(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') return 'must be text, one word or phrase per line';
  const lines = value.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length > 500) return 'must have at most 500 lines';
  if (lines.some((l) => l.trim().length > MAX_QUERY_CHARS)) return `each line must be at most ${MAX_QUERY_CHARS} characters`;
  return null;
}

/**
 * Is this query hidden by the blocklist? A blocked word hides any query that
 * contains it as a word; a blocked phrase hides any query containing it.
 */
export function isBlocked(query: string, blocklist: readonly string[]): boolean {
  const f = normaliseTerms(query);
  const words = f.split(' ');
  return blocklist.some((b) => f === b || words.includes(b) || (b.includes(' ') && f.includes(b)));
}

/**
 * The popular searches to suggest for what someone has typed so far: those
 * that start with it (or have a word that does), searched at least `minCount`
 * times, not blocked, most searched first.
 */
export function popularFor(
  entries: readonly PopularEntry[],
  typed: string,
  opts: { minCount: number; blocklist: readonly string[]; limit: number },
): string[] {
  const t = foldForSearch(typed.trim());
  if (t.length < 2) return [];
  return entries
    .filter((e) => e.count >= opts.minCount)
    .filter((e) => {
      const f = foldForSearch(e.query);
      if (f === t) return false; // suggesting exactly what they typed adds nothing
      if (isBlocked(e.query, opts.blocklist)) return false;
      return f.startsWith(t) || f.split(' ').some((w) => w.startsWith(t));
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, opts.limit)
    .map((e) => e.query);
}
