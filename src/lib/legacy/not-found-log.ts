/**
 * What a shop is losing to dead URLs.
 *
 * A 404 count on its own is a curiosity. The reason this exists is narrower:
 * on one production shop, 618 requests carrying Shopping and ad click
 * parameters hit 404s in 26 days. Those are people who clicked a paid listing
 * and landed on nothing — money already spent, thrown away at the door — and
 * they are indistinguishable from crawler noise unless somebody looks for the
 * click parameters.
 *
 * So this records not just WHAT was requested and how often, but whether the
 * request arrived with ad money behind it. That is the column a shop sorts by.
 *
 * ## Bounded on purpose
 *
 * A hijacked feed and a crawler flood are exactly the conditions this runs
 * under, so an unbounded table of every distinct 404 path is a way to fill a
 * shop's database with somebody else's spam. Distinct paths are capped, and the
 * least valuable entry is evicted rather than the newest refused — otherwise a
 * flood of junk would lock out the real dead URL that arrives during it.
 */

/**
 * Query parameters that mean money was spent on this click.
 *
 * `srsltid` is Google Shopping's free/paid listing id and `gclid` is an Ads
 * click id — both were in the production sample. The rest are the common
 * campaign trackers; a shop that finds them on a 404 is losing traffic it paid
 * for either way.
 */
export const AD_CLICK_PARAMS: readonly string[] = [
  'srsltid',
  'gclid',
  'gbraid',
  'wbraid',
  'gad_source',
  'msclkid',
  'fbclid',
  'ttclid',
  'utm_source',
  'utm_campaign',
  'utm_medium',
];

/** How many distinct paths to remember. Beyond this the least valuable goes. */
export const MAX_TRACKED_PATHS = 500;

export interface NotFoundRecord {
  /** Normalised path. The identity of the row. */
  path: string;
  hits: number;
  /** Hits that carried an ad or Shopping click parameter. */
  paid_hits: number;
  first_seen: string;
  last_seen: string;
  /** One example referrer, for orientation. Not a history. */
  sample_referrer?: string;
  /** One example of the click parameters seen, for orientation. */
  sample_params?: string;
}

/** Did this request arrive with ad money behind it? */
export function hasAdClickParams(search: string | URLSearchParams): boolean {
  const params = typeof search === 'string'
    ? new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
    : search;
  for (const name of AD_CLICK_PARAMS) {
    if (params.has(name)) return true;
  }
  return false;
}

/** The click parameters actually present, for the report. */
export function adClickParams(search: string | URLSearchParams): string[] {
  const params = typeof search === 'string'
    ? new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
    : search;
  return AD_CLICK_PARAMS.filter((name) => params.has(name));
}

/**
 * Fold one hit into the set of records.
 *
 * Pure, and returns a NEW array, so the aggregation rules are testable without
 * a database — including the eviction, which is the part that only misbehaves
 * under a flood nobody can reproduce by hand.
 */
export function recordHit(
  records: readonly NotFoundRecord[],
  hit: { path: string; search?: string; referrer?: string; at: string },
  cap: number = MAX_TRACKED_PATHS,
): NotFoundRecord[] {
  const path = hit.path;
  if (!path) return [...records];

  const params = adClickParams(hit.search ?? '');
  const paid = params.length > 0;
  const out = [...records];
  const i = out.findIndex((r) => r.path === path);

  if (i >= 0) {
    const prev = out[i];
    out[i] = {
      ...prev,
      hits: prev.hits + 1,
      paid_hits: prev.paid_hits + (paid ? 1 : 0),
      last_seen: hit.at,
      // Keep the FIRST referrer and click params seen. A later crawler hit
      // would otherwise overwrite the human referrer that explains the row.
      sample_referrer: prev.sample_referrer || hit.referrer || undefined,
      sample_params: prev.sample_params || (params.length ? params.join(',') : undefined),
    };
    return out;
  }

  if (out.length >= cap) {
    // Evict the LEAST VALUABLE, not the oldest: a row with paid hits is the
    // entire point of the report, and a flood of one-hit spam must not push it
    // out. Among equals, the stalest goes.
    let worst = 0;
    for (let j = 1; j < out.length; j += 1) {
      const a = out[j];
      const b = out[worst];
      if (a.paid_hits !== b.paid_hits) {
        if (a.paid_hits < b.paid_hits) worst = j;
        continue;
      }
      if (a.hits !== b.hits) {
        if (a.hits < b.hits) worst = j;
        continue;
      }
      if (String(a.last_seen) < String(b.last_seen)) worst = j;
    }
    // Only evict for something at least as valuable as what goes. Otherwise a
    // flood of new junk churns the table and loses everything real.
    const victim = out[worst];
    if (victim.paid_hits > 0 || victim.hits > 1) return out;
    out.splice(worst, 1);
  }

  out.push({
    path,
    hits: 1,
    paid_hits: paid ? 1 : 0,
    first_seen: hit.at,
    last_seen: hit.at,
    sample_referrer: hit.referrer || undefined,
    sample_params: params.length ? params.join(',') : undefined,
  });
  return out;
}

export type NotFoundSort = 'paid' | 'hits' | 'recent';

/**
 * Order the report.
 *
 * `paid` is the default because it answers the question the shop actually has:
 * which dead URLs are costing money. Sorting by raw hits puts a crawler
 * hammering one bad path above a Shopping URL that lost twelve real buyers.
 */
export function sortRecords(
  records: readonly NotFoundRecord[],
  sort: NotFoundSort = 'paid',
): NotFoundRecord[] {
  const out = [...records];
  out.sort((a, b) => {
    if (sort === 'recent') return String(b.last_seen).localeCompare(String(a.last_seen));
    if (sort === 'hits') return b.hits - a.hits || String(b.last_seen).localeCompare(String(a.last_seen));
    return b.paid_hits - a.paid_hits || b.hits - a.hits;
  });
  return out;
}
