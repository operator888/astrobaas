/**
 * Synonyms — the core implementation behind the `TermExpander` seam (C-146).
 *
 * ## What core does and what it deliberately does not
 *
 * The relevance scorer has always had an `expand` seam, and until now nothing
 * in the free core filled it: `SEARCH_EXPAND` had exactly one consumer, product
 * search, and no implementation behind it at all.
 *
 * **Synonyms belong in core** because they are DATA the shop owner types. A
 * Greek optician knows that customers search for «σκελετός» when the catalogue
 * says «μοντούρα», and nothing but that person knows it. A list they maintain
 * needs no index, no build step and no memory.
 *
 * **Typo tolerance and Greeklish do not**, and they stay in the paid
 * `@astrobaas/search`. Both need an index built from the shop's own vocabulary —
 * a correction against a dictionary suggests words the shop does not stock, so
 * acting on the suggestion lands the shopper on an empty page. That index is
 * the actual product.
 *
 * ## Bidirectional by default
 *
 * `σκελετός = μοντούρα, frame` means all three find each other. An operator
 * writing a synonym line is stating that these words mean the same thing, not
 * declaring a direction — and a one-way table is the shape where somebody adds
 * a line, tests the word they typed first, and never notices the other half
 * does not work.
 *
 * An explicit `=>` writes a one-way rule for the cases where direction is
 * genuinely meant: `iphone => phone` should not make every phone an iPhone.
 */
import { foldForSearch } from '../text-search';
import { MAX_VARIANTS_PER_TERM } from './rank';
import type { TermExpander } from './rank';

/** Per line, and per side of a line. Keeps a pasted spreadsheet from becoming one rule. */
const MAX_TERMS_PER_LINE = 24;
/** Total lines. A synonym table longer than this is a dictionary, and belongs in the paid index. */
export const MAX_SYNONYM_LINES = 500;

export interface SynonymRule {
  /** Folded terms that trigger this rule. */
  from: string[];
  /** Folded terms it expands to. */
  to: string[];
  /** True for `a, b, c` (every term finds every other); false for `a => b`. */
  bidirectional: boolean;
}

/**
 * Parse an operator's synonym list.
 *
 * One rule per line. `#` starts a comment, blank lines are skipped, and a line
 * that cannot be understood is DROPPED rather than throwing — this is a
 * free-text settings field, and one bad line must not take search down.
 *
 * Everything is folded on the way in, so «Σκελετός» and «σκελετος» are one
 * term. Folding at parse time rather than at query time means the work happens
 * once per settings change instead of once per search.
 */
export function parseSynonyms(raw: unknown): SynonymRule[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  const rules: SynonymRule[] = [];

  // Count RULE lines, the way validateSynonyms does. Slicing the raw array
  // counted comments and blank lines against the limit, so a table the API had
  // just accepted could still lose its tail here — the operator sees the rules
  // saved in the field and some of them never reach a search.
  let seen = 0;
  for (const line of raw.split('\n')) {
    const text = line.split('#')[0].trim();
    if (!text) continue;
    if (++seen > MAX_SYNONYM_LINES) break;

    const arrow = text.indexOf('=>');
    if (arrow >= 0) {
      const from = terms(text.slice(0, arrow));
      const to = terms(text.slice(arrow + 2));
      if (from.length && to.length) rules.push({ from, to, bidirectional: false });
      continue;
    }

    // `a = b, c` and `a, b, c` are the same statement. The `=` form reads
    // better for a one-to-many rule and people write both.
    const all = terms(text.replace(/=/g, ','));
    if (all.length >= 2) rules.push({ from: all, to: all, bidirectional: true });
  }
  return rules;
}

function terms(part: string): string[] {
  const out: string[] = [];
  for (const raw of part.split(',')) {
    const folded = foldForSearch(raw.trim());
    if (folded && !out.includes(folded)) out.push(folded);
    if (out.length >= MAX_TERMS_PER_LINE) break;
  }
  return out;
}

/**
 * Build the expander the scorer calls.
 *
 * Returns `null` when there are no rules, which is what the seam expects for
 * "nothing to add" — `rankBy` then skips the whole expansion path rather than
 * calling a function that always returns an empty array.
 *
 * The lookup is built once, here, rather than scanned per term: a query of four
 * words against a table of two hundred lines would otherwise be eight hundred
 * comparisons per candidate.
 */
function buildSynonymIndex(rules: readonly SynonymRule[]): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  const add = (key: string, value: string) => {
    if (key === value) return;
    const set = index.get(key) ?? new Set<string>();
    set.add(value);
    index.set(key, set);
  };

  for (const rule of rules) {
    for (const from of rule.from) {
      for (const to of rule.to) {
        add(from, to);
        // Bidirectional means every term finds every other, including the
        // other terms on its own side: `a, b, c` must let `b` find `c`.
        if (rule.bidirectional) add(to, from);
      }
    }
  }
  return index;
}

export function synonymExpander(rules: readonly SynonymRule[]): TermExpander | null {
  if (rules.length === 0) return null;
  const index = buildSynonymIndex(rules);

  return (term: string) => {
    const found = index.get(foldForSearch(term));
    return found ? [...found] : [];
  };
}

/**
 * Everything a caller needs, from the raw setting.
 *
 * One function so the post route, the blog archive and the product search
 * cannot each spell the parse-then-build pair differently.
 */
export function expanderFromSetting(raw: unknown): TermExpander | null {
  return synonymExpander(parseSynonyms(raw));
}

/**
 * Why a stored synonym list is unusable, or null when it is fine.
 *
 * Permissive on purpose: the parser already drops what it cannot read, so this
 * only refuses what would be a mistake rather than a typo — a list so long it
 * is a dictionary, or something pasted that is plainly not a synonym list.
 */
export function validateSynonyms(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw !== 'string') return 'must be text';
  const lines = raw.split('\n').filter((l) => l.split('#')[0].trim());
  if (lines.length > MAX_SYNONYM_LINES) {
    return `has ${lines.length} rules; the limit is ${MAX_SYNONYM_LINES}. A list this long wants an index, not a table`;
  }
  if (/<\s*(html|!doctype|script)\b/i.test(raw)) return 'looks like HTML rather than synonym rules';

  // The scorer keeps MAX_VARIANTS_PER_TERM alternatives per term and drops the
  // rest — a guard against a third-party expander returning a dictionary, and
  // it stays. But an operator's OWN table is checked here, at save time, so
  // nothing they wrote is discarded without being told. Rules merge, so a term
  // can pass the per-line limit and still exceed this across several lines.
  //
  // Counted off the SAME index the expander hands the scorer, not a second
  // count written here — a validator that computes the number its own way is
  // a validator that eventually disagrees with what actually happens.
  for (const [term, alternatives] of buildSynonymIndex(parseSynonyms(raw))) {
    if (alternatives.size > MAX_VARIANTS_PER_TERM) {
      return `«${term}» has ${alternatives.size} alternatives; search uses the first ${MAX_VARIANTS_PER_TERM}. Split it or shorten it, so nothing is dropped silently`;
    }
  }
  return null;
}
