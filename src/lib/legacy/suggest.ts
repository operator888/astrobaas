/**
 * Building the candidate set a recovery page suggests from.
 *
 * Shared by /api/recovery/match and by 404.astro so the storefront page and the
 * endpoint can never drift into suggesting different things for the same URL.
 *
 * ## Why this caches
 *
 * A recovery page runs under exactly the conditions that produce lots of 404s:
 * a hijacked Merchant feed, a crawler sweep, an old sitemap. Reading the whole
 * catalogue per unmatched request would turn somebody else's spam into load on
 * the shop's own database — the same trap the redirect index avoids.
 *
 * A short TTL rather than write invalidation: the cost of being sixty seconds
 * stale is that a just-added product is not offered as a suggestion for a
 * minute, which nobody will notice, and the alternative is a cache-busting hook
 * on every catalogue write for the benefit of a page nobody wants to reach.
 */

import { LocalDB } from '../localdb';
import { isCommerceEnabled } from '../commerce-service';
import { matchPath, type Candidate, type ScoredCandidate } from './recovery-match';

const TTL_MS = 60_000;

let cached: { at: number; candidates: Candidate[] } | null = null;
let inFlight: Promise<Candidate[]> | null = null;

/** Off by default? No — on. This is the switch for a shop that wants it quiet. */
export function recoveryEnabled(): boolean {
  const raw = String(process.env.LEGACY_RECOVERY ?? '').trim().toLowerCase();
  return raw !== 'off' && raw !== 'false' && raw !== '0';
}

async function loadCandidates(): Promise<Candidate[]> {
  // The commerce switch reaches here too: recovery suggestions on a non-shop
  // must not name products — /api/recovery/match is public, and it would be
  // the one place left leaking catalogue names after the API surface 404s.
  const commerceOn = await isCommerceEnabled();
  const [products, categories, brands] = commerceOn
    ? await Promise.all([
      LocalDB.getProducts(),
      LocalDB.getProductCategories(),
      LocalDB.getBrands(),
    ])
    : [[], [], []];

  return [
    // Only ACTIVE products. Offering a draft or archived item to a shopper is a
    // second dead end wearing a helpful face.
    ...products
      .filter((p) => p.status === 'active')
      .map((p) => ({
        kind: 'product' as const,
        id: p.id,
        name: p.name,
        slug: p.slug,
        url: `/shop/${p.slug}`,
      })),
    ...categories.map((c) => ({
      kind: 'category' as const,
      id: c.id,
      name: c.name,
      slug: c.slug,
      url: `/shop?category=${encodeURIComponent(c.slug)}`,
    })),
    ...brands.map((b) => ({
      kind: 'brand' as const,
      id: b.id,
      name: b.name,
      slug: b.slug,
      url: `/shop?brand=${encodeURIComponent(b.slug)}`,
    })),
  ];
}

async function candidates(now: number): Promise<Candidate[]> {
  if (cached && now - cached.at < TTL_MS) return cached.candidates;
  // Memoised on the promise: under a flood, a boolean or a bare check lets every
  // concurrent request past while the first load is still running, and they all
  // read the catalogue at once — the stampede this cache exists to prevent.
  if (!inFlight) {
    inFlight = loadCandidates()
      .then((list) => {
        cached = { at: now, candidates: list };
        return list;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

export interface Suggestion {
  /** The path's words as they were written, accent- and case-folded. */
  tokens: string[];
  /** The same words transliterated to Latin — what they were compared as. */
  latin: string[];
  results: ScoredCandidate[];
}

/**
 * What might this dead path have meant?
 *
 * Returns an EMPTY result rather than throwing when the catalogue cannot be
 * read: this runs on a page whose entire job is to handle a broken request, and
 * failing there would turn a 404 into a 500.
 */
export async function suggestForPath(
  path: string,
  limit = 8,
  now = Date.now(),
): Promise<Suggestion> {
  if (!recoveryEnabled()) return { tokens: [], latin: [], results: [] };
  try {
    const list = await candidates(now);
    return matchPath(path, list, { limit });
  } catch (err) {
    console.error('[astrobaas] recovery suggestions unavailable:', err);
    return { tokens: [], latin: [], results: [] };
  }
}

/** Test seam. Never called by production code. */
export function _resetSuggestCache(): void {
  cached = null;
  inFlight = null;
}
