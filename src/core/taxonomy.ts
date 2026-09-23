/**
 * Operator-defined groupings — custom taxonomies (C-128).
 *
 * ## What exists already, and why it is not enough
 *
 * Categories and tags are first-class, and the roadmap's own note offered
 * "enum-field + filtered list" as today's answer. That is a real workaround and
 * it stops working at the first requirement either shop actually has: a Brand
 * is not a fixed list an operator can only change by editing a content type, it
 * has a slug, it needs its own page, and an optician adds one whenever a
 * supplier signs.
 *
 * ## Additive, and destructive of nothing
 *
 * A taxonomy is a DEFINITION in settings and its terms are ordinary records in
 * the existing custom-entity store. Nothing about categories, tags, posts or
 * products changes shape, no migration runs, and an install that never defines
 * a taxonomy is byte-identical to one from before this existed.
 *
 * The assignment lives on the record, in one optional field, for the same
 * reason: `post.terms = { brand: ['ray-ban'] }` is absent on every row written
 * before today, and absent means "no terms", which is what those rows mean.
 *
 * ## Slugs are the identity, names are not
 *
 * A term is addressed by slug everywhere — in the record, in the URL, in a
 * filter. Renaming "Ray-Ban" to "Ray Ban" then changes a label and breaks
 * nothing. Keying on the name would silently unassign every post the moment
 * somebody fixed a typo.
 */

/** How many taxonomies one install may define. A bound, not a design opinion. */
export const MAX_TAXONOMIES = 30;

/** Reserved: these already name something a post carries. */
export const RESERVED_TAXONOMY_SLUGS = new Set([
  'category', 'categories', 'tag', 'tags', 'author', 'date', 'page', 'post', 'search',
]);

export interface TaxonomyDefinition {
  /** kebab-case, stable, and the URL segment. */
  slug: string;
  /** Singular, for a form label: "Brand". */
  label: string;
  /** Plural, for a heading: "Brands". Falls back to the label. */
  labelPlural?: string;
  /**
   * Which collections may carry it: `post`, `page`, `product`, or a content
   * type's name.
   *
   * A list rather than "everything", because a Brand on a blog post is noise in
   * the editor and a Lens Type on a page is a field nobody will ever fill.
   */
  appliesTo: string[];
  /**
   * Does it get a public page at `/t/<taxonomy>/<term>`?
   *
   * Off by default. An internal grouping — "supplier", "margin band" — is one
   * an operator uses to filter the admin, and publishing it would put the
   * shop's own vocabulary on the open web without anybody asking for that.
   */
  publicArchive?: boolean;
}

export interface TaxonomyTerm {
  /** Which taxonomy this belongs to. */
  taxonomy: string;
  slug: string;
  name: string;
  description?: string;
}

/** The settings key the definitions live under. */
export const TAXONOMIES_SETTING = 'custom_taxonomies';

/** The custom-entity collection terms are stored in. */
export const TERM_COLLECTION = 'taxonomy_term';

/** The field on a record that carries its term slugs, keyed by taxonomy slug. */
export const TERMS_FIELD = 'terms';

const SLUG_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/**
 * A TAXONOMY slug: ASCII, because it is a short operator-typed identifier
 * (`brand`, `lens-type`) that also appears in code and in a query string.
 */
export function isTaxonomySlug(value: unknown): boolean {
  return typeof value === 'string' && value.length <= 40 && SLUG_RE.test(value);
}

/**
 * A TERM slug, which is a different rule on purpose.
 *
 * A term's slug is derived from a NAME in the shop's own language. Both live
 * installs write Greek, so an ASCII-only rule would reduce "Ωμέγα" to the empty
 * string and then silently drop the assignment — the record would save, the
 * term would not be on it, and nothing would say why.
 *
 * Greek and Cyrillic letters are therefore allowed alongside ASCII. They are
 * legal in a path once encoded, which is what `encodeURIComponent` in the
 * archive link does.
 *
 * The first draft of this file used ONE rule for both and had exactly that bug:
 * `termSlug('Ωμέγα')` produced a slug its own validator rejected.
 */
const TERM_SLUG_RE = /^[a-z0-9\u0370-\u03ff\u0400-\u04ff]+(-[a-z0-9\u0370-\u03ff\u0400-\u04ff]+)*$/;

export function isTermSlug(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= 40 && TERM_SLUG_RE.test(value);
}

/**
 * Turn a name into a slug.
 *
 * Shared by the admin form and the API so a term created through either has the
 * same slug — two spellings of the same rule is how "Ray-Ban" ends up stored
 * twice.
 */
export function termSlug(name: unknown): string {
  return String(name ?? '')
    .normalize('NFD')
    // Strip combining marks, so "Ωμέγα" and "Ómega" reduce to letters rather
    // than to nothing. Greek is the first language on both live installs.
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9Ͱ-ϿЀ-ӿ]+/g, '-')
    .slice(0, 40)
    // Trimmed AFTER the slice, not before. The other order left a name of
    // exactly the wrong length ending in a hyphen — a slug this module's own
    // validator then rejected, so the API answered 400 for a term whose only
    // sin was being long. The docblock above presented that class of bug as
    // solved when only the Greek half of it was.
    .replace(/^-+|-+$/g, '');
}

export interface TaxonomyValidation {
  ok: boolean;
  errors: string[];
  defs: TaxonomyDefinition[];
}

/**
 * Check a whole set of definitions.
 *
 * The WHOLE set, not one at a time, because two of the rules — duplicate slugs,
 * the count bound — are properties of the set. Every message names the
 * taxonomy it is about: an operator editing a JSON blob of thirty of them
 * cannot act on "invalid".
 */
export function validateTaxonomies(raw: unknown): TaxonomyValidation {
  const errors: string[] = [];
  const defs: TaxonomyDefinition[] = [];

  let list: unknown = raw;
  if (typeof list === 'string') {
    // The relational driver stores settings as TEXT.
    try { list = JSON.parse(list); } catch { return { ok: false, errors: ['Taxonomies must be a list.'], defs: [] }; }
  }
  if (list === null || list === undefined) return { ok: true, errors: [], defs: [] };
  if (!Array.isArray(list)) return { ok: false, errors: ['Taxonomies must be a list.'], defs: [] };
  if (list.length > MAX_TAXONOMIES) {
    return { ok: false, errors: [`At most ${MAX_TAXONOMIES} taxonomies.`], defs: [] };
  }

  const seen = new Set<string>();
  list.forEach((entry, i) => {
    const where = `taxonomy ${i + 1}`;
    if (!entry || typeof entry !== 'object') { errors.push(`${where} is not an object`); return; }
    const e = entry as Record<string, unknown>;
    const slug = String(e.slug ?? '').trim();
    if (!isTaxonomySlug(slug)) {
      errors.push(`${where}: "${slug}" is not a valid slug — lowercase letters, digits and hyphens`);
      return;
    }
    if (RESERVED_TAXONOMY_SLUGS.has(slug)) {
      // Not a style preference: `/t/category/x` beside `/blog/category/x` is
      // two routes for one idea, and the second one an operator builds on will
      // be the wrong one.
      errors.push(`${where}: "${slug}" is reserved — a post already has one`);
      return;
    }
    if (seen.has(slug)) { errors.push(`${where}: "${slug}" is defined twice`); return; }
    seen.add(slug);

    const label = String(e.label ?? '').trim();
    if (!label) { errors.push(`${where} ("${slug}") needs a label`); return; }

    const appliesTo = Array.isArray(e.appliesTo)
      ? e.appliesTo.map((c) => String(c ?? '').trim()).filter(Boolean)
      : [];
    if (!appliesTo.length) {
      // A taxonomy attached to nothing renders nowhere and can never be filled.
      // Refused rather than stored, because the operator would find out by it
      // simply not appearing.
      errors.push(`${where} ("${slug}") applies to nothing — choose at least one collection`);
      return;
    }

    defs.push({
      slug,
      label: label.slice(0, 60),
      labelPlural: String(e.labelPlural ?? '').trim().slice(0, 60) || undefined,
      appliesTo,
      publicArchive: e.publicArchive === true,
    });
  });

  return { ok: errors.length === 0, errors, defs };
}

/** The taxonomies that apply to one collection. */
export function taxonomiesFor(defs: readonly TaxonomyDefinition[], collection: string): TaxonomyDefinition[] {
  return defs.filter((d) => d.appliesTo.includes(collection));
}

export function getTaxonomy(defs: readonly TaxonomyDefinition[], slug: string): TaxonomyDefinition | undefined {
  return defs.find((d) => d.slug === slug);
}

/**
 * Clean the term assignment on a record.
 *
 * Drops taxonomies this install does not define, taxonomies that do not apply
 * to this collection, and anything that is not a slug — so a stale field left
 * by a deleted taxonomy degrades to nothing rather than to a filter nobody can
 * clear. Returns `undefined` when nothing survives, which is what "no terms"
 * looks like on every record written before today.
 */
export function cleanTerms(
  raw: unknown,
  defs: readonly TaxonomyDefinition[],
  collection: string,
): Record<string, string[]> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const allowed = new Map(taxonomiesFor(defs, collection).map((d) => [d.slug, d]));
  const out: Record<string, string[]> = {};
  for (const [taxonomy, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!allowed.has(taxonomy)) continue;
    const slugs = (Array.isArray(value) ? value : [value])
      .map((v) => String(v ?? '').trim())
      .filter((v) => isTermSlug(v));
    // De-duplicated: the same term twice is one assignment, and a list that
    // grows every save is how a record ends up with four hundred copies of
    // "ray-ban".
    const unique = [...new Set(slugs)];
    if (unique.length) out[taxonomy] = unique;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Does this record carry that term? */
export function hasTerm(record: unknown, taxonomy: string, term: string): boolean {
  const terms = (record as Record<string, unknown> | null)?.[TERMS_FIELD];
  if (!terms || typeof terms !== 'object') return false;
  const list = (terms as Record<string, unknown>)[taxonomy];
  return Array.isArray(list) && list.includes(term);
}

/** Every record carrying a term, in the order given. */
export function recordsWithTerm<T>(records: readonly T[], taxonomy: string, term: string): T[] {
  return records.filter((r) => hasTerm(r, taxonomy, term));
}

/**
 * How many records carry each term.
 *
 * For the admin list, where "Brand: Ray-Ban (0)" is the row an operator needs
 * to see — an empty term is either a typo or a supplier they never stocked.
 */
export function termCounts(
  records: readonly unknown[],
  taxonomy: string,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const record of records) {
    const terms = (record as Record<string, unknown> | null)?.[TERMS_FIELD];
    if (!terms || typeof terms !== 'object') continue;
    const list = (terms as Record<string, unknown>)[taxonomy];
    if (!Array.isArray(list)) continue;
    for (const slug of list) counts[String(slug)] = (counts[String(slug)] ?? 0) + 1;
  }
  return counts;
}
