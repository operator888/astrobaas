/**
 * Links from a record to its term archives (C-128).
 *
 * ## Why this exists as its own module
 *
 * Nothing linked to `/t/` at all: the route was written, the terms were
 * stored, the opt-in was implemented — and no reader could ever arrive at one.
 * An audit found it, and it is the same shape as the print button: a feature
 * that works and that nobody can find has not shipped.
 *
 * It is a module rather than three lines in the article component because the
 * product page and any theme's own article template need the same list, and
 * the rule it encodes — only taxonomies that opted into a public archive get a
 * link — is one that must not be re-derived per template.
 */
import { LocalDB } from './localdb';
import { settingsMap } from './settings-map';
import {
  TAXONOMIES_SETTING, TERM_COLLECTION, TERMS_FIELD,
  validateTaxonomies, getTaxonomy,
} from '../core/taxonomy';

export interface TermLink {
  taxonomy: string;
  slug: string;
  name: string;
  href: string;
}

/**
 * The public term links for one record.
 *
 * Returns `[]` — never throws and never partially renders — for a record with
 * no terms, an install with no taxonomies, or a database that is unavailable.
 * A missing chip is a cosmetic loss; an article that will not render is not.
 */
export async function postTermLinks(record: unknown): Promise<TermLink[]> {
  const terms = (record as Record<string, unknown> | null)?.[TERMS_FIELD];
  if (!terms || typeof terms !== 'object') return [];

  try {
    const map = settingsMap(await LocalDB.getSettings());
    const defs = validateTaxonomies(map[TAXONOMIES_SETTING]).defs;
    if (!defs.length) return [];

    // Read once and indexed, not once per term: an article with six terms
    // would otherwise be six full reads of the collection.
    const rows = await LocalDB.getCustomEntities(TERM_COLLECTION);
    const byKey = new Map<string, { name?: unknown; slug?: unknown }>();
    for (const r of rows as { data?: Record<string, unknown> }[]) {
      const d = r.data ?? {};
      byKey.set(`${String(d.taxonomy)}/${String(d.slug)}`, d);
    }

    const out: TermLink[] = [];
    for (const [taxonomy, slugs] of Object.entries(terms as Record<string, unknown>)) {
      const def = getTaxonomy(defs, taxonomy);
      // Only a taxonomy that opted in. An internal grouping — supplier, margin
      // band — stays internal, and linking it would publish the shop's own
      // vocabulary without anybody asking.
      if (!def || def.publicArchive !== true) continue;
      for (const slug of Array.isArray(slugs) ? slugs : []) {
        const term = byKey.get(`${taxonomy}/${String(slug)}`);
        // A term whose record is gone is not linked: the archive would 404,
        // and offering a link that 404s is worse than offering none.
        if (!term) continue;
        out.push({
          taxonomy: def.label,
          slug: String(slug),
          name: String(term.name || slug),
          // Encoded, because a term slug may be Greek or Cyrillic — which is
          // the rule `core/taxonomy.ts` cited THIS link to justify.
          href: `/t/${encodeURIComponent(taxonomy)}/${encodeURIComponent(String(slug))}`,
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}
