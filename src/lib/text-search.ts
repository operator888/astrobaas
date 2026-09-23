/**
 * Text folding for search, and transliteration for slugs.
 *
 * Two problems, one root cause: the codebase treated `toLowerCase()` as though
 * it were enough to compare human text, which is true only for ASCII.
 *
 * ## 1. Accent-insensitive search
 *
 * A shopper types what is on their keyboard, not what the catalogue happens to
 * store. In Greek that difference is routine rather than exotic:
 *
 *   - Capitals are written WITHOUT accents ("ΑΛΥΣΙΔΑ"), lower case WITH them
 *     ("αλυσίδα"), so `toLowerCase()` alone yields "αλυσιδα" ≠ "αλυσίδα".
 *   - Many people simply omit accents when typing quickly.
 *   - Sigma has two lower-case forms: final ς and medial σ. `'ΟΔΟΣ'
 *     .toLowerCase()` correctly gives "οδος" with a FINAL sigma, which then
 *     fails to match a stored "οδοσ…" mid-word.
 *
 * Verified against the real 436-product catalogue: "αλυσίδα" matched, while
 * "αλυσιδα" and "ΑΛΥΣΙΔΑ" — the same word as a shopper would actually type it —
 * matched nothing.
 *
 * The same fold fixes French (café/CAFE), German (Müller/MULLER), Spanish
 * (piñata/PINATA) and Vietnamese; it is not a Greek special case.
 *
 * ## 2. Slugs
 *
 * `slugify()` kept only `[a-z0-9]`, so an all-Greek name produced an EMPTY
 * slug. Empty slugs then bypassed the product uniqueness check (`if (slug &&
 * …)`), so every Greek product created without a manual slug collided on `''`
 * and became unreachable by slug. Transliteration fixes that at the source.
 */

/**
 * Combining marks left behind by NFD decomposition.
 *
 * U+0300–U+036F is exactly the block that carries Latin, Cyrillic, monotonic
 * AND polytonic Greek diacritics — including U+0345 (ypogegrammeni), which is
 * what makes `ᾳ` fold to `α`. Deliberately NOT `\p{M}`: that would also strip
 * Thai and Devanagari vowel signs, which are letters-in-effect rather than
 * accents, and mangling them is worse than not folding them.
 */
const COMBINING_MARKS = /[̀-ͯ]/g;

/**
 * Fold text for accent- and case-insensitive comparison.
 *
 * Order matters. NFD first so an accent becomes a separable mark, strip, and
 * only then lower-case: `'Ά'` must reach `'α'` whichever way it was encoded
 * (U+0386 precomposed, or U+0391 + U+0301). Final sigma is folded last, after
 * `toLowerCase()` has had its chance to PRODUCE one.
 */
export function foldForSearch(input: unknown): string {
  if (typeof input !== 'string' || input === '') return '';
  return input
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    // Final sigma ς and medial σ are the same letter. Also ϲ (lunate sigma),
    // which turns up in text copied out of older typography.
    .replace(/[ςϲ]/g, 'σ')
    // Collapse whitespace so "γυαλιά   ηλίου" matches "γυαλιά ηλίου".
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Does any of `fields` contain `query`, ignoring case and accents?
 *
 * Centralised so a search site cannot fold the query but forget the haystack —
 * which silently half-works: it fixes `ΑΛΥΣΙΔΑ` → `αλυσιδα` on the way in and
 * then compares it against an unfolded `αλυσίδα`, matching nothing, exactly as
 * before.
 */
export function matchesSearch(fields: readonly unknown[], query: string): boolean {
  const q = foldForSearch(query);
  if (!q) return true; // an empty query filters nothing
  return fields.some((f) => foldForSearch(f).includes(q));
}

/* ------------------------------------------------------------------ *
 * Transliteration
 * ------------------------------------------------------------------ */

/**
 * Greek → Latin, per-character, following ISO 843 / ELOT 743 conventions.
 *
 * Per-character on purpose. The digraph rules (αυ → af or av depending on what
 * follows) are genuinely ambiguous, and a slug does not need to be a faithful
 * romanisation — it needs to be stable, readable, and unique. `ου → ou` is the
 * one digraph included, because it is unambiguous and common enough that `oy`
 * would look like a typo in every second URL.
 */
const GREEK_MAP: Record<string, string> = {
  α: 'a', β: 'v', γ: 'g', δ: 'd', ε: 'e', ζ: 'z', η: 'i', θ: 'th',
  ι: 'i', κ: 'k', λ: 'l', μ: 'm', ν: 'n', ξ: 'x', ο: 'o', π: 'p',
  ρ: 'r', σ: 's', τ: 't', υ: 'y', φ: 'f', χ: 'ch', ψ: 'ps', ω: 'o',
};

/** Cyrillic → Latin, so Russian/Ukrainian/Bulgarian names slug too. */
const CYRILLIC_MAP: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh',
  з: 'z', и: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o',
  п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts',
  ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e',
  ю: 'yu', я: 'ya', і: 'i', ї: 'i', є: 'ie', ґ: 'g',
};

/**
 * Characters that survive NFKD but are not accents and must be spelled out —
 * otherwise `Müller` and `Muller` slug alike but `Straße` loses a letter.
 */
const LETTER_EXPANSIONS: Record<string, string> = {
  ß: 'ss', æ: 'ae', œ: 'oe', ø: 'o', å: 'a', ð: 'd', þ: 'th', đ: 'd', ł: 'l',
};

/**
 * Transliterate to ASCII-ish text suitable for a slug.
 *
 * Applied AFTER folding, so accented Greek and Latin both arrive here as bare
 * letters and the maps stay small.
 */
export function transliterate(input: string): string {
  const folded = foldForSearch(input);
  let out = '';
  for (let i = 0; i < folded.length; i++) {
    const ch = folded[i];
    // The one digraph worth special-casing.
    if (ch === 'ο' && folded[i + 1] === 'υ') {
      out += 'ou';
      i++;
      continue;
    }
    out += GREEK_MAP[ch] ?? CYRILLIC_MAP[ch] ?? LETTER_EXPANSIONS[ch] ?? ch;
  }
  return out;
}
