/**
 * Guessing what a dead URL was asking for.
 *
 * The signal is in the URL itself. A legacy WordPress shop path carries a brand
 * name, a category word, sometimes a product code — and on these shops it is as
 * likely to be Greek as Latin, and as likely to be percent-encoded as not,
 * because Google indexed whichever form the old site emitted:
 *
 *   /product-category/gynaikeia-gyalia-iliou
 *   /product-category/%CE%B3%CF%85%CE%BD%CE%B1%CE%B9%CE%BA%CE%B5%CE%AF%CE%B1
 *   /shop/ray-ban-rb3025-aviator
 *
 * All three should find the same things. `foldForSearch` strips accents and
 * case; `transliterate` maps Greek to Latin. Comparing on BOTH forms is what
 * lets a Greek query match a Latin slug and the reverse.
 *
 * ## Returning nothing is a real answer
 *
 * A shopper shown three random products trusts the shop less than one shown a
 * search box and an honest "we could not find that page". So a weak match is
 * discarded rather than padded out — `MIN_SCORE` exists to be hit.
 */

import { foldForSearch, transliterate } from '../text-search';

/** Path noise that carries no meaning about the product. */
const STOPWORDS = new Set([
  'product', 'products', 'product-category', 'category', 'categories',
  'shop', 'store', 'page', 'index', 'html', 'php', 'en', 'el', 'gr',
  'tag', 'tags', 'brand', 'brands', 'collection', 'collections',
  'p', 'c', 'item', 'items', 'default', 'home',
]);

/** Below this a match is noise, and noise is worse than an empty result. */
export const MIN_SCORE = 2;

/**
 * The longest path this module reads, before decoding.
 *
 * `GET /api/recovery/match?path=` is public, and matching costs
 * `tokens × candidates` — every token compared, in two scripts, against every
 * active product, category and brand. A path with thousands of distinct
 * words made one anonymous request do thousands of catalogue passes.
 *
 * 1024 is several times the longest legacy URL either shop has in its 404 log;
 * percent-encoded Greek is six characters a letter, and this still leaves room
 * for 150 of them.
 */
export const MAX_PATH_LENGTH = 1024;

/**
 * The most tokens one path is matched on.
 *
 * A real legacy URL has a category, a brand, a model and maybe a colour. The
 * first twelve meaningful words carry everything a suggestion can use; the
 * rest only add passes over the catalogue.
 */
export const MAX_PATH_TOKENS = 12;

/** Both spellings of a token, so Greek and Latin can be compared to each other. */
export interface Token {
  /** Accent- and case-folded, in whatever script it arrived. */
  folded: string;
  /** Transliterated to Latin. Equal to `folded` for Latin input. */
  latin: string;
}

/**
 * Pull meaningful tokens out of a path.
 *
 * Percent-decoding happens FIRST and defensively: these URLs come from a
 * hijacked feed, and a malformed escape must produce a weak match rather than
 * an exception on a page whose whole job is to handle a broken request.
 */
export function tokenizePath(path: string): Token[] {
  let raw = String(path ?? '');
  if (raw.length > MAX_PATH_LENGTH) {
    // Cut BEFORE decoding, and never inside a character: a `%C` left dangling
    // by the cut — or the first byte of a two-byte Greek letter without its
    // second — makes the WHOLE path undecodable, and a Greek URL would then be
    // matched as its percent-encoded bytes, i.e. not at all. So a partial
    // escape is dropped, and then up to three trailing complete escapes (the
    // longest incomplete UTF-8 sequence) until the rest decodes.
    raw = raw.slice(0, MAX_PATH_LENGTH).replace(/%[0-9a-f]?$/i, '');
    for (let i = 0; i < 3; i += 1) {
      try {
        decodeURIComponent(raw);
        break;
      } catch {
        raw = raw.replace(/%[0-9a-f]{2}$/i, '');
      }
    }
  }
  try {
    raw = decodeURIComponent(raw);
  } catch {
    // Keep the raw form. A path we cannot decode still often contains a
    // readable Latin brand name.
  }
  const parts = raw
    .split(/[/\-_+.,%\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const seen = new Set<string>();
  const tokens: Token[] = [];
  for (const part of parts) {
    const folded = foldForSearch(part);
    // One- and two-character fragments match everything and mean nothing.
    if (folded.length < 3) continue;
    if (STOPWORDS.has(folded)) continue;
    // A pure number is usually a page or a WordPress post id, not a product.
    if (/^\d+$/.test(folded) && folded.length < 4) continue;
    if (seen.has(folded)) continue;
    seen.add(folded);
    tokens.push({ folded, latin: transliterate(part) });
    // Distinct, meaningful tokens only count towards the ceiling — stopwords
    // and repeats above were never going to cost a catalogue pass.
    if (tokens.length >= MAX_PATH_TOKENS) break;
  }
  return tokens;
}

/** A thing the recovery page can offer. */
export interface Candidate {
  kind: 'product' | 'category' | 'brand';
  id: string;
  name: string;
  slug: string;
  url: string;
}

export interface ScoredCandidate extends Candidate {
  score: number;
  /** Which tokens matched, so a report can explain the suggestion. */
  matched: string[];
}

/**
 * Score one candidate against the tokens from a dead path.
 *
 * A whole-token hit in the SLUG counts double: a slug is what the old URL was
 * built from, so agreement there is much stronger evidence than the same word
 * appearing somewhere in a description.
 */
export function scoreCandidate(candidate: Candidate, tokens: readonly Token[]): ScoredCandidate {
  const slugFolded = foldForSearch(candidate.slug);
  const slugLatin = transliterate(candidate.slug);
  const nameFolded = foldForSearch(candidate.name);
  const nameLatin = transliterate(candidate.name);

  let score = 0;
  const matched: string[] = [];

  for (const token of tokens) {
    // Compare in both scripts, both directions. This is the whole reason a
    // Greek query finds a Latin slug and the reverse.
    const inSlug = slugFolded.includes(token.folded) || slugLatin.includes(token.latin);
    const inName = nameFolded.includes(token.folded) || nameLatin.includes(token.latin);
    if (!inSlug && !inName) continue;

    matched.push(token.folded);
    score += inSlug ? 2 : 1;
    // A token that is a whole slug segment is a strong signal, not a substring
    // coincidence like "ban" inside "banana".
    if (slugFolded.split('-').includes(token.folded) || slugLatin.split('-').includes(token.latin)) {
      score += 1;
    }
  }

  // A category is a safer suggestion than one product: if the old URL was a
  // category listing, offering the closest category lands the shopper where
  // they can browse, and a single guessed product is more likely to be wrong.
  if (candidate.kind === 'category' && score > 0) score += 1;

  return { ...candidate, score, matched };
}

export interface MatchOptions {
  limit?: number;
  minScore?: number;
}

/**
 * Rank candidates for a dead path.
 *
 * Returns an EMPTY array when nothing clears `minScore`, and the caller is
 * expected to say so rather than to fill the space. That is the honest answer
 * and the one that keeps a shopper's trust.
 */
export function matchPath(
  path: string,
  candidates: readonly Candidate[],
  opts: MatchOptions = {},
): { tokens: string[]; latin: string[]; results: ScoredCandidate[] } {
  const tokens = tokenizePath(path);
  if (tokens.length === 0) return { tokens: [], latin: [], results: [] };

  const minScore = opts.minScore ?? MIN_SCORE;
  const limit = Math.min(Math.max(opts.limit ?? 8, 1), 50);

  const scored = candidates
    .map((c) => scoreCandidate(c, tokens))
    .filter((c) => c.score >= minScore)
    .sort((a, b) => (
      b.score - a.score
      // Categories before products at equal score, for the reason above.
      || (a.kind === b.kind ? 0 : a.kind === 'category' ? -1 : 1)
      || a.name.localeCompare(b.name)
    ))
    .slice(0, limit);

  // Both spellings are reported: `tokens` is what the URL said, `latin` is what
  // it was compared as. An operator asking why a Greek URL did or did not find
  // a Latin slug can see both halves of the answer without reading the code.
  return {
    tokens: tokens.map((t) => t.folded),
    latin: tokens.map((t) => t.latin),
    results: scored,
  };
}
