/**
 * Weighted relevance ranking — the one scorer every search path uses.
 *
 * ## Why this exists
 *
 * There were two searches and they disagreed. `/api/search` scored posts with
 * `title ? 3 : 0` plus `body ? 1 : 0` and a bare `String.includes`. Product
 * search went through `matchesSearch`, which returns a BOOLEAN — so a shopper
 * typing two words got an unranked list in storage order. Same shop, same
 * query, two different notions of "relevant", and neither of them ranked.
 *
 * That is the sibling gap this codebase keeps finding: one behaviour
 * implemented twice, drifting silently, because nothing forces them to agree.
 * So relevance lives here, once, as a pure function, and both callers pass
 * their own field weights.
 *
 * ## What `includes` gets wrong, concretely
 *
 * The 436-product catalogue that drove `foldForSearch` also breaks substring
 * matching:
 *
 *   - **Word order.** A shopper types "σκελετός μαύρος"; the product is named
 *     "Μαύρος σκελετός". `includes` finds neither string in the other and
 *     returns nothing, though every word matches.
 *   - **Ranking by nothing.** "οπτικά" appears in the name of one product and
 *     the description of eighty. Unranked, the one that matters is 81st.
 *   - **Keyword stuffing.** A description repeating a word twenty times
 *     out-scores a product whose NAME is that word, under any scheme that adds
 *     up occurrences. So a term counts ONCE per field, at its best match
 *     quality — never per occurrence.
 *
 * ## The rules, in order of strength
 *
 * Per term, per field, the best single match wins:
 *
 *   1. **Whole word** — a token of the field equals the term. Full weight.
 *   2. **Prefix** — a token starts with the term. 60% — this is what makes
 *      type-ahead feel right ("σκελ" finds "σκελετός") without letting a short
 *      query out-rank an exact hit.
 *   3. **Inside a word** — the field contains the term anywhere. 30%. Keeps
 *      compound words and part numbers findable ("7024" in "RB7024-51").
 *
 * A **phrase bonus** is added when the whole folded query appears contiguously,
 * because "μαύρος σκελετός" as typed is a stronger signal than the two words
 * apart.
 *
 * ## AND, not OR
 *
 * Every term must match SOMEWHERE in the item, or it scores zero. OR semantics
 * turn a two-word query into "everything matching either word", which for a
 * catalogue means the second word is decoration. A shopper who adds a word is
 * narrowing, not widening.
 *
 * ## What is deliberately NOT here
 *
 * Typo tolerance, synonyms, Greeklish folding ("skeleto" → "σκελετό"), facets,
 * operator-tunable weights and zero-result analytics are the paid search
 * module. This is the free core: correct, ranked, and enough for a shop that
 * knows what it sells. Nothing here needs replacing to add those — a richer
 * matcher raises the same per-term score through the same seams.
 */
import { foldForSearch } from '../text-search';

/** One searchable field of an item, and how much it counts. */
export interface WeightedField {
  /** Raw text. Folded here — callers must NOT pre-fold. */
  text: unknown;
  /** Relative importance. A title at 6 outranks a body at 1 six to one. */
  weight: number;
}

/**
 * Alternative spellings of one term, best match wins.
 *
 * This is the seam the paid search module plugs into, and the reason it does
 * not have to reimplement relevance. A richer matcher does not want to change
 * how scoring works — it wants to say "when the shopper typed `skeleto`, also
 * accept `σκελετο`", or "`σκελετως` is a typo for `σκελετος`", or "`γυαλια` and
 * `ομματογυαλια` are the same thing". All three are the same operation:
 * one concept, several acceptable spellings.
 *
 * Expanding must never widen the RESULT set the way adding a term would — the
 * alternatives are OR'd with each other and the group as a whole is still
 * AND'd with the other terms. A shopper who types two words still gets things
 * matching both.
 *
 * Return the alternatives WITHOUT the original; it is always tried first and at
 * full strength.
 */
export type TermExpander = (term: string) => readonly string[];

export interface RankOptions {
  /**
   * Added when the entire query appears contiguously in a field, scaled by
   * that field's weight. Default 0.5 — half a whole-word match, enough to
   * break a tie without overturning a stronger word-level result.
   */
  phraseBonus?: number;
  /** Terms shorter than this are dropped, unless the query is only that term. */
  minTermLength?: number;
  /** Alternative spellings per term. See {@link TermExpander}. */
  expand?: TermExpander;
  /**
   * How much an alternative spelling scores against the literal one. Default
   * 0.75 — a product that matches what the shopper actually TYPED must rank
   * above one reached through a guess, or a typo-tolerant search quietly
   * reorders correct results behind approximate ones.
   */
  variantPenalty?: number;
}

const WHOLE_WORD = 1;
const PREFIX = 0.6;
const INSIDE = 0.3;

const DEFAULTS: Required<Omit<RankOptions, 'expand'>> = {
  phraseBonus: 0.5,
  minTermLength: 2,
  variantPenalty: 0.75,
};

/** How many alternatives one term may contribute. A runaway expander is a DoS. */
export const MAX_VARIANTS_PER_TERM = 12;

/**
 * The longest query this module will read, in UTF-16 code units.
 *
 * ## Why a search box needs a ceiling at all
 *
 * The cost of ranking is `terms × fields × tokens`, summed over EVERY item —
 * and every item is the whole published blog or the whole catalogue. The query
 * was the one factor nobody bounded: `GET /api/search?q=` with a few thousand
 * distinct words made one anonymous request do a few thousand passes over
 * every product name, and the middleware's 60/min cannot help with a request
 * that is expensive rather than frequent. It was an algorithmic denial of
 * service with a URL for a payload.
 *
 * 200 is several sentences. Nobody types more into a shop's search box, and a
 * pasted paragraph is still searched — by its first 200 characters.
 *
 * The cap lives HERE rather than in the routes because there are three callers
 * (`/api/search`, the catalogue's `?search=`, and `/blog?q=`) and the one that
 * forgot would be the one somebody found.
 */
export const MAX_QUERY_LENGTH = 200;

/**
 * The most DISTINCT terms one query is searched for.
 *
 * Twelve words is a long query; the thirteenth is not narrowing anything a
 * person can see. And because matching is AND, every extra term is one more
 * full pass that can only remove results — past a dozen the work grows and the
 * answer does not change.
 */
export const MAX_QUERY_TERMS = 12;

/**
 * A raw query cut to {@link MAX_QUERY_LENGTH}, without splitting a character.
 *
 * Exported so a route can echo back what was actually searched — echoing the
 * UNCLIPPED query would hand the amplification straight back in the response.
 *
 * A cut that lands between the two halves of a surrogate pair (an emoji, a rare
 * CJK character) drops the orphaned high half: `foldForSearch` would keep it,
 * and a lone surrogate is not text that can match anything.
 */
export function clipQuery(query: unknown): string {
  if (typeof query !== 'string') return '';
  if (query.length <= MAX_QUERY_LENGTH) return query;
  let cut = query.slice(0, MAX_QUERY_LENGTH);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut;
}

/**
 * First occurrence wins, then the first {@link MAX_QUERY_TERMS}.
 *
 * DEDUPLICATED because a repeated word is not a stronger query: under AND each
 * copy re-checks what the first already proved, and under the scorer each copy
 * ADDS its score again — so `ray ray ray ray` quietly reordered results by
 * repetition, which is keyword stuffing from the other side of the box.
 */
function boundTerms(terms: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of terms) {
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= MAX_QUERY_TERMS) break;
  }
  return out;
}

/**
 * Split folded text into tokens.
 *
 * `\p{L}\p{N}` with the `u` flag rather than `\b` or `\w`: those are ASCII-only
 * in JavaScript, so every Greek word would be one unsplittable token and
 * whole-word matching would never fire — the exact failure `foldForSearch` was
 * written to end.
 */
function tokenize(folded: string): string[] {
  return folded.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/**
 * The terms a query is actually searched for.
 *
 * Exported because the paid module and the admin's "why did this match?" view
 * both need to agree with the scorer about what a query was taken to mean.
 */
export function queryTerms(query: unknown, opts: RankOptions = {}): string[] {
  const { minTermLength } = { ...DEFAULTS, ...opts };
  // Clipped BEFORE folding: NFD normalisation and the regex passes are linear,
  // but linear in a megabyte is still a megabyte of work the answer never uses.
  const all = tokenize(foldForSearch(clipQuery(query)));
  const long = all.filter((t) => t.length >= minTermLength);
  // A one-character query is a real query ("Ω" is a brand). Keep it rather than
  // silently searching for nothing.
  return boundTerms(long.length > 0 ? long : all);
}

/** Best match quality for one term against one already-folded field. */
function termScore(fieldFolded: string, tokens: string[], term: string): number {
  if (tokens.includes(term)) return WHOLE_WORD;
  if (tokens.some((t) => t.startsWith(term))) return PREFIX;
  if (fieldFolded.includes(term)) return INSIDE;
  return 0;
}

/**
 * Score one item's fields against a term list.
 *
 * Returns 0 when any term matches nothing — the AND rule. Callers filter on
 * `> 0` rather than being handed a list they then have to re-check.
 *
 * **Terms are folded here, defensively.** They are normally supplied by
 * `queryTerms` and already folded, and folding is idempotent — but a caller
 * passing a raw term ("σκελετός", with its accent and final sigma) against a
 * folded haystack ("σκελετοσ") would match NOTHING and get a confident zero.
 * A scorer that answers "no results" when it means "you called me wrong" is
 * the silent-failure shape this codebase keeps paying for, and one cheap fold
 * over a handful of short strings ends it.
 */
export function scoreFields(
  fields: readonly WeightedField[],
  rawTerms: readonly string[],
  opts: RankOptions = {},
): number {
  if (rawTerms.length === 0) return 0;
  const { phraseBonus, variantPenalty } = { ...DEFAULTS, ...opts };
  const folded = rawTerms.map((t) => foldForSearch(clipQuery(t)));
  if (folded.some((t) => t === '')) return 0; // a term that folds to nothing cannot match
  // Bounded here too, not only in queryTerms: this function is exported, and a
  // caller that built its own term list — the paid module, a plugin — must not
  // be the way round the ceiling.
  const terms = boundTerms(folded);

  // Fold and tokenize each field ONCE, not once per term.
  const prepared = fields
    .filter((f) => f.weight > 0)
    .map((f) => {
      const folded = foldForSearch(f.text);
      return { folded, tokens: tokenize(folded), weight: f.weight };
    })
    .filter((f) => f.folded !== '');

  if (prepared.length === 0) return 0;

  let total = 0;
  for (const term of terms) {
    let best = 0;
    for (const f of prepared) {
      // Weight multiplies the match QUALITY, so a prefix hit in the title can
      // still beat a whole-word hit in the body — which is what a reader means
      // by relevant.
      const s = termScore(f.folded, f.tokens, term) * f.weight;
      if (s > best) best = s;
    }

    // Only if the literal term found nothing do we spend anything on
    // alternatives. A shop with no search module pays exactly nothing for this
    // branch, and a shop with one pays only on the queries that actually miss.
    if (best === 0 && opts.expand) {
      // A module's expander runs inside the shop's search path. One that throws,
      // or returns something that is not an array, must degrade to "no
      // alternatives" — not 500 the catalogue. A paid module is still a
      // third party from this function's point of view.
      let raw: readonly string[] = [];
      try {
        const got = opts.expand(term);
        if (Array.isArray(got)) raw = got;
      } catch {
        raw = [];
      }
      const variants = raw
        .filter((v): v is string => typeof v === 'string')
        .map((v) => foldForSearch(v))
        .filter((v) => v !== '' && v !== term)
        .slice(0, MAX_VARIANTS_PER_TERM);
      for (const v of variants) {
        for (const f of prepared) {
          const s = termScore(f.folded, f.tokens, v) * f.weight * variantPenalty;
          if (s > best) best = s;
        }
      }
    }

    // One term unmatched anywhere — by any spelling — disqualifies the item.
    if (best === 0) return 0;
    total += best;
  }

  if (terms.length > 1 && phraseBonus > 0) {
    const phrase = terms.join(' ');
    for (const f of prepared) {
      if (f.folded.includes(phrase)) {
        total += phraseBonus * f.weight;
        break; // Once. The phrase being present twice is not twice the signal.
      }
    }
  }

  return total;
}

export interface Ranked<T> {
  item: T;
  score: number;
}

/**
 * Per-query cache for a term expander.
 *
 * Deliberately NOT module-level: a long-lived cache would hold a synonym table
 * an operator has since edited, and search would keep answering with the old
 * one until the process restarted. One query, one cache, no staleness.
 */
function memoize(fn: TermExpander): TermExpander {
  const seen = new Map<string, readonly string[]>();
  return (term: string) => {
    const hit = seen.get(term);
    if (hit) return hit;
    const value = fn(term);
    seen.set(term, value);
    return value;
  };
}

/**
 * Rank a list by relevance, dropping non-matches.
 *
 * Ties are NOT broken here: two items scoring the same keep their input order,
 * which the caller controls and can make meaningful (newest first for posts,
 * in-stock first for products). Sorting is stable in every engine this runs on,
 * so that order survives.
 */
export function rankBy<T>(
  items: readonly T[],
  query: unknown,
  fieldsOf: (item: T) => readonly WeightedField[],
  opts: RankOptions = {},
): Ranked<T>[] {
  const terms = queryTerms(query, opts);
  if (terms.length === 0) return [];

  // Expand each distinct term ONCE for the whole query, not once per item.
  // scoreFields runs per item, so an unmemoised expander is consulted for every
  // non-matching row — on the 436-product catalogue, a query matching three
  // products would call it 433 times. Alternatives depend only on the term, so
  // the answer is the same every time and the work is pure waste. This matters
  // because the paid module's expander does real work: a typo index lookup and
  // a synonym table read.
  const opts2 = opts.expand
    ? { ...opts, expand: memoize(opts.expand) }
    : opts;

  const out: Ranked<T>[] = [];
  for (const item of items) {
    const score = scoreFields(fieldsOf(item), terms, opts2);
    if (score > 0) out.push({ item, score });
  }
  return out.sort((a, b) => b.score - a.score);
}

/**
 * Field weights, named so the two callers cannot drift apart again.
 *
 * These are the numbers, in one place, rather than magic constants at each call
 * site. The paid module makes them operator-tunable; the shape it tunes is this
 * one.
 */
export const POST_WEIGHTS = { title: 6, excerpt: 3, body: 1 } as const;

/**
 * A product's identifiers rank just under its name and ABOVE its brand: a
 * shopper typing an SKU or a barcode knows exactly what they want, and burying
 * that under every product of the same brand is the worst possible answer.
 */
export const PRODUCT_WEIGHTS = {
  name: 6,
  sku: 5,
  gtin: 5,
  brand: 3,
  tags: 2,
  description: 1,
} as const;
