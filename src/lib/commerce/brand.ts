/**
 * Brands: one maker, however it was typed.
 *
 * ## The problem this solves
 *
 * `Product.brand` is a free-text string typed into the admin form, and the
 * catalogue filter compared it with `===`. A live shop's 447 products held **72
 * distinct brand strings for 62 actual makers**: `Rayban` and `RAYBAN`,
 * `Symbol` and `SYMBOL` and `"Symbol "` with a trailing space, `Dalet` and
 * `DALET`.
 *
 * Nobody notices until a shopper does. `?brand=Rayban` returned 16 of 17
 * products; `?brand=Ray-Ban` returned none at all; and a brands menu built from
 * the raw values listed the same maker three times.
 *
 * ## The key
 *
 * `brandKey` folds accents and case (via the same `foldForSearch` the catalogue
 * search uses, so the two cannot disagree about what "the same text" means) and
 * then removes everything that is not a letter or a digit.
 *
 * Dropping separators is what makes `Ray-Ban` find `Rayban` — the shop's own
 * failing example. It is safe because it drops only *punctuation and spacing*,
 * never a word:
 *
 * | typed | key | |
 * | --- | --- | --- |
 * | `Rayban`, `RAYBAN`, `Ray-Ban` | `rayban` | one maker — merged |
 * | `Solano Clips`, `Solano clips` | `solanoclips` | one line — merged |
 * | `SOLANO` | `solano` | **kept apart** — a different line |
 * | `Tipi Diversi` | `tipidiversi` | **kept apart** |
 * | `Tipi Diversi Clip` | `tipidiversiclip` | **kept apart** |
 *
 * The last two are the shop owner's own warning: `Tipi Diversi` and `Tipi
 * Diversi Clip` are genuinely different product lines, and any rule that merged
 * on a shared prefix would be wrong. A key built from the whole alphanumeric
 * sequence cannot make that mistake — an extra word is an extra key.
 *
 * ## One key for filtering AND for listing
 *
 * Both `?brand=` and the brands listing group by THIS function, which buys a
 * property worth stating outright:
 *
 *   **the count shown beside a brand equals the number of products you get
 *   when you click it.**
 *
 * A listing that grouped more conservatively than the filter would show
 * `Ray-Ban (1)` and `Rayban (16)` and hand you 17 products from either.
 *
 * The listing also publishes a SLUG per brand, and a menu links by slug — so
 * the slug has to lead back to the same key. It does not fold there on its own:
 * `slugify` transliterates (`Straße` → `strasse`, `Γυαλιά Όψη` → `gyalia-opsi`)
 * and a curated record may choose any slug at all (`rb` for Ray-Ban), while
 * this key folds accents and case but never changes script. `buildBrandDirectory`
 * below is the one place a slug is assigned AND resolved, for exactly that
 * reason.
 *
 * ## What this deliberately does NOT do
 *
 * It does not rewrite anything. Grouping on read is backward compatible and
 * needs no migration to have run; a shop gets the fix on deploy. Canonicalising
 * the STORED spellings is a separate, conservative step — see migration v15
 * `canonical-brand-spellings`, which merges only case and whitespace variants,
 * only when one spelling holds two thirds of its group, and REPORTS everything
 * else rather than guessing.
 */
import { foldForSearch } from '../text-search';
import { slugify, stableHash } from '../validate';

/**
 * Tidy a brand for STORAGE, without deciding how it should be spelled.
 *
 * `brand` was the one catalogue field with no normaliser: every other extended
 * field has a line in `normalizeExtendedFields`, and this had none — so nothing
 * trimmed it on any write path, which is how `"Symbol "` with a trailing space
 * became a third spelling of Symbol.
 *
 * Trims and collapses internal whitespace, and caps the length. It does NOT
 * change case: the stored spelling is what the admin table, the storefront and
 * the schema.org `Brand` node all render, and lowercasing every shop's brands
 * to fix a matching bug would be fixing it in the wrong place.
 */
export function normalizeBrand(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const tidy = value.replace(/\s+/g, ' ').trim().slice(0, 120);
  // Absent, not empty string: `?brand=` treats '' as "no brand", and a stored
  // '' would be a product claiming a brand named nothing.
  return tidy || undefined;
}

/**
 * The identity of a brand, whatever it was typed as.
 *
 * Returns '' for anything empty or non-string — an unbranded product. Callers
 * must treat '' as "no brand" rather than as a brand named "", or a catalogue's
 * unbranded products all become one nameless maker in the menu.
 */
export function brandKey(value: unknown): string {
  // foldForSearch first: NFD, combining marks stripped, lowercased, final
  // sigma unified, whitespace collapsed. Shared with catalogue search so
  // "ΓΥΑΛΙΆ" and "γυαλια" cannot mean the same thing in one place and not the
  // other.
  return foldForSearch(value).replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Do two brand strings name the same maker? */
export function sameBrand(a: unknown, b: unknown): boolean {
  const ka = brandKey(a);
  // '' is "no brand", and two unbranded products do not share a brand.
  return ka !== '' && ka === brandKey(b);
}

/** One maker, as the catalogue actually spells it. */
export interface BrandSummary {
  /** The stable identity — what `?brand=` matches on. */
  key: string;
  /** The spelling to SHOW: the one the most products use. */
  name: string;
  /** How many products this maker has, across every spelling. */
  count: number;
  /**
   * Every spelling found, most-used first. Present so an operator can SEE the
   * variants — the admin screen that hides them is the one that let 72
   * spellings accumulate unnoticed.
   */
  spellings: { name: string; count: number }[];
}

/**
 * Group a catalogue's products into makers.
 *
 * PURE and storage-free, so the API route, the admin screen and the migration
 * all reach the same answer from the same rows.
 *
 * The displayed spelling is the most common one, ties broken by the FIRST
 * spelling seen rather than alphabetically: with two spellings on equal counts
 * there is no evidence either is more correct, and product order is at least
 * the shop's own.
 */
export function summarizeBrands(
  products: readonly { brand?: unknown }[],
): BrandSummary[] {
  const groups = new Map<string, Map<string, number>>();
  for (const p of products ?? []) {
    const raw = typeof p?.brand === 'string' ? p.brand.trim() : '';
    if (!raw) continue; // unbranded is not a brand
    const key = brandKey(raw);
    if (!key) continue; // a brand of only punctuation is not a brand either
    let spellings = groups.get(key);
    if (!spellings) groups.set(key, (spellings = new Map()));
    spellings.set(raw, (spellings.get(raw) ?? 0) + 1);
  }

  const out: BrandSummary[] = [];
  for (const [key, spellings] of groups) {
    const ranked = [...spellings.entries()]
      .map(([name, count]) => ({ name, count }))
      // Insertion order is preserved by Map, and sort is stable, so an exact
      // tie keeps the spelling that appeared first in the catalogue.
      .sort((a, b) => b.count - a.count);
    out.push({
      key,
      name: ranked[0].name,
      count: ranked.reduce((s, r) => s + r.count, 0),
      spellings: ranked,
    });
  }
  return out;
}

/**
 * Spellings that look related but are NOT merged.
 *
 * One key being a prefix of another is worth an operator's attention —
 * `Solano Clips` beside `SOLANO` usually means somebody typed the short form
 * once — but it is emphatically NOT evidence of the same brand: `Tipi Diversi`
 * and `Tipi Diversi Clip` are different product lines in this very catalogue.
 *
 * So this REPORTS pairs and merges nothing. The distinction matters: a
 * suggestion a human confirms costs a moment, and a wrong automatic merge
 * silently moves products to another maker where nobody will look for them.
 */
export function relatedBrandPairs(
  summaries: readonly BrandSummary[],
): { a: string; b: string; reason: string }[] {
  const pairs: { a: string; b: string; reason: string }[] = [];
  const sorted = [...summaries].sort((x, y) => x.key.length - y.key.length);
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const shorter = sorted[i];
      const longer = sorted[j];
      if (shorter.key.length >= longer.key.length) continue;
      if (!longer.key.startsWith(shorter.key)) continue;
      pairs.push({
        a: shorter.name,
        b: longer.name,
        reason: `“${longer.name}” starts with “${shorter.name}” — the same maker typed two ways, or two product lines. Only you can tell.`,
      });
    }
  }
  return pairs;
}

/* ─────────────────────────────────────────── the published directory ─── */

/** The fields of a curated Brand record this module reads. The rest rides along in `record`. */
export interface CuratedBrandLike {
  name?: unknown;
  slug?: unknown;
}

/** One entry of `GET /api/brands`, before the route adds presentation. */
export interface BrandEntry<R extends CuratedBrandLike = CuratedBrandLike> extends BrandSummary {
  /** The handle the listing publishes and `?brand=` resolves back. Unique across entries. */
  slug: string;
  curated: boolean;
  /** The curated record behind this entry, when there is one (its id, logo, timestamps). */
  record?: R;
}

export interface BrandDirectory<R extends CuratedBrandLike = CuratedBrandLike> {
  /** Every maker with active products, plus every curated record: one entry per key. */
  entries: BrandEntry<R>[];
  /**
   * The key a brand FILTER value means. A published slug — or a suffixed slug
   * this directory once published, or a curated record's stored slug —
   * resolves to its own brand; anything else is matched by identity.
   */
  keyFor(value: unknown): string;
  /** The key a curated record with this name and slug belongs to. */
  keyOfRecord(record: CuratedBrandLike): string;
  /**
   * The listed brand that already answers to `slug` — by publishing it, or
   * because it IS that brand's name — other than the one `record` belongs to.
   * A curated slug wins in the listing, so a new record taking such a slug
   * would silently re-point that brand's links and filters.
   */
  slugTakenBy(slug: unknown, record: CuratedBrandLike): BrandEntry<R> | undefined;
}

/**
 * The brands a shop publishes, and the way back from each slug to its brand.
 *
 * ## The bug this closes
 *
 * `GET /api/brands` published `slugify(name)` as each brand's slug, and
 * `?brand=` folded whatever it was given with `brandKey`. Those are different
 * functions: `slugify` TRANSLITERATES and `brandKey` does not. So `Straße`
 * published `strasse`, which folds to `strasse` rather than `straße`; `Γυαλιά
 * Όψη` published `gyalia-opsi`, which folds to `gyaliaopsi` rather than
 * `γυαλιαοψη`; and a curated record `{ name: 'Ray-Ban', slug: 'rb' }` published
 * `rb`, which no folding maps to `rayban`. Each of those brands was listed with
 * a count, and clicking it returned nothing — the promise in INTEGRATION.md
 * broken for exactly the shops that write Greek.
 *
 * ## Why resolve the slug instead of transliterating the key
 *
 * Making `brandKey` transliterate would fix the first two and still not the
 * third: `rb` is a name somebody chose, not a spelling of anything. And it
 * would change IDENTITY for the whole catalogue — `Straße` would become the
 * same maker as `Strasse`, `Όψη` the same as `Opsi` — which is a merge nobody
 * asked for between brands that may well be different companies. This module
 * refuses exactly that kind of merge (see `relatedBrandPairs`). So identity
 * stays what it was; only the published handle is resolved back, by the SAME
 * directory that published it, so the two cannot disagree.
 *
 * ## Slugs are unique, and nothing depends on product order
 *
 * Two makers can slugify alike (`Straße` and `Strasse`; `Όψη` and `Opsi`), and
 * a slug two entries share can only lead to one of them. So:
 *
 *  1. A curated record keeps its stored slug. An operator chose it and a
 *     storefront URL may already use it. The first record in storage order
 *     wins a (hand-made) duplicate.
 *  2. Every other entry takes `slugify(name)` — unless that slug is taken, or
 *     it would SHADOW another listed maker: a slug that is itself another
 *     brand's identity (`Straße` may not publish `strasse` while `Strasse`
 *     exists, or `?brand=strasse` would stop meaning Strasse). Either way it
 *     gets the same slug plus a short suffix hashed from its key. Entries claim
 *     in key order, so the same catalogue always publishes the same slugs.
 *
 * A suffix is hashed from the brand's KEY, so it stays resolvable after the
 * collision that produced it is gone: a storefront that cached
 * `strasse-1hdqgjn` keeps reaching Straße when Strasse later leaves the
 * catalogue. What cannot be kept without storing state is who owns a PLAIN
 * slug when a second maker arrives that slugifies alike — the maker the slug
 * spells keeps it, and the other moves to its suffixed slug.
 *
 * ## Which products a curated record describes
 *
 * Its NAME's products, when its name has any. Otherwise the products its SLUG
 * names — the shape the WooCommerce importer wrote until it kept names: it
 * stored each product's brand as a lossy slug and the record as `{ name, slug }`,
 * so `Ørgreen` arrived as products branded `rgreen` and a record
 * `{ name: 'Ørgreen', slug: 'rgreen' }` whose name no product carries. Shops it
 * filled still hold that shape, and the importer still files a NEW product of
 * such a brand under the old slug (see woo-apply.ts). Keyed on its name alone,
 * that record became a second, empty brand that took the slug `rgreen` away
 * from its own products.
 *
 * Only ACTIVE products count: the listing is a storefront surface, and a count
 * that included drafts would promise more than `?brand=` returns.
 *
 * PURE, like the rest of this file: the route, `listProducts` and the
 * collection rules all build the directory from the same two arrays.
 */
export function buildBrandDirectory<R extends CuratedBrandLike>(
  products: readonly { brand?: unknown; status?: unknown }[],
  curated: readonly R[] = [],
  opts: { includeDrafts?: boolean } = {},
): BrandDirectory<R> {
  // `includeDrafts` is for the WRITE guards (POST /api/brands, the importer)
  // and nothing else: a brand whose products are all drafts today publishes
  // its slug the day one goes live, so a new record must not take it now.
  const summaries = summarizeBrands(
    opts.includeDrafts ? (products ?? []) : (products ?? []).filter((p) => p?.status === 'active'),
  );
  const withProducts = new Set(summaries.map((s) => s.key));
  const storedSlug = (record: CuratedBrandLike | undefined) =>
    typeof record?.slug === 'string' ? record.slug.trim() : '';
  const keyOfRecord = (record: CuratedBrandLike): string => {
    const byName = brandKey(record?.name);
    if (byName && withProducts.has(byName)) return byName;
    const bySlug = brandKey(storedSlug(record));
    if (bySlug && withProducts.has(bySlug)) return bySlug;
    return byName;
  };

  const byKey = new Map<string, BrandEntry<R>>();
  for (const s of summaries) byKey.set(s.key, { ...s, slug: '', curated: false });
  for (const record of curated ?? []) {
    const name = typeof record?.name === 'string' ? record.name : '';
    const key = keyOfRecord(record);
    if (!key) continue;
    const derived = byKey.get(key);
    // A curated record wins on PRESENTATION (its name was chosen on purpose)
    // and never on `count`, which is a fact about products. Two records with
    // one key: the later one is shown, as it always was.
    byKey.set(key, {
      key,
      name,
      count: derived?.count ?? 0,
      spellings: derived?.spellings ?? [],
      slug: '',
      curated: true,
      record,
    });
  }
  const entries = [...byKey.values()];
  // A curated record's own name, when it describes products keyed otherwise
  // (the importer's shape), so `?brand=<the name it is shown under>` still
  // finds them. Never over a name that is itself a listed brand.
  const nameAlias = new Map<string, string>();
  for (const record of curated ?? []) {
    const own = brandKey(record?.name);
    const key = keyOfRecord(record);
    if (own && key && own !== key && !byKey.has(own)) nameAlias.set(own, key);
  }

  const slugToKey = new Map<string, string>();
  // A slug that names ANOTHER listed brand with products would silently
  // re-point that brand's name-based filter, so a derived slug may not be one.
  // A curated brand with no products yet displaces nobody: it has no links
  // worth protecting, and the brand already publishing the slug does.
  const shadows = (slug: string, own: string) => {
    const k = brandKey(slug);
    return k !== '' && k !== own && (byKey.get(k)?.count ?? 0) > 0;
  };
  // The slug an entry ASKS for. On a tie between spellings the displayed one
  // is whichever appeared first, so the slug takes the smallest candidate
  // instead — it must never depend on product order.
  const wanted = (e: BrandEntry<R>): string => {
    if (e.curated || !e.spellings.length) return slugify(e.name);
    const top = e.spellings[0].count;
    return e.spellings.filter((s) => s.count === top).map((s) => slugify(s.name)).sort()[0];
  };
  const claim = (entry: BrandEntry<R>, want: string, guardShadow: boolean) => {
    const blocked = (s: string) => slugToKey.has(s) || (guardShadow && shadows(s, entry.key));
    let slug = want;
    if (blocked(slug)) {
      const base = `${want}-${stableHash(entry.key)}`;
      slug = base;
      for (let n = 2; blocked(slug); n++) slug = `${base}-${n}`;
    }
    entry.slug = slug;
    slugToKey.set(slug, entry.key);
  };

  // 1. Curated records' own slugs, in storage order — only the record an entry
  //    actually shows (the later of two same-key records).
  for (const record of curated ?? []) {
    const entry = byKey.get(keyOfRecord(record));
    const slug = storedSlug(record);
    if (entry?.record === record && slug && !entry.slug) claim(entry, slug, false);
  }
  // 2. Everyone else, in key order.
  const rest = entries
    .filter((e) => !e.slug)
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (const entry of rest) claim(entry, wanted(entry), true);

  // 3. A curated record hidden behind a later same-key record still owns its
  //    stored slug for resolution: a legacy URL or an importer link built from
  //    it should keep leading to the brand. Never over a slug already taken,
  //    nor over another brand's name.
  for (const record of curated ?? []) {
    const key = keyOfRecord(record);
    const slug = storedSlug(record);
    if (key && slug && !slugToKey.has(slug) && !shadows(slug, key)) slugToKey.set(slug, key);
  }

  // 4. Every slug a brand could have been given — each spelling's, its
  //    name's, its record's — keeps leading to it: the displayed spelling
  //    changes as products are retyped, and a cached link must not go dead
  //    when it does. Never over a published slug or another brand's name, and
  //    not at all when two brands could claim the same one.
  const basesOf = new Map<string, Set<string>>();
  for (const e of entries) {
    basesOf.set(e.key, new Set([
      slugify(e.name),
      ...e.spellings.map((s) => slugify(s.name)),
      storedSlug(e.record),
    ].filter(Boolean)));
  }
  const alias = new Map<string, string | null>();
  for (const e of entries) {
    for (const b of basesOf.get(e.key) ?? []) {
      if (slugToKey.has(b) || shadows(b, e.key)) continue;
      alias.set(b, alias.has(b) && alias.get(b) !== e.key ? null : e.key);
    }
  }

  // 5. Suffixed slugs outlive their collision: `<base>-<hash of key>` (or
  //    `…-<n>`) resolves to that key whenever the base is one this brand could
  //    have been slugged from. Two keys hashing alike resolve by neither.
  const hashToKey = new Map<string, string | null>();
  for (const e of entries) {
    const h = stableHash(e.key);
    hashToKey.set(h, hashToKey.has(h) && hashToKey.get(h) !== e.key ? null : e.key);
  }
  const bySuffix = (value: string): string | undefined => {
    const at = value.lastIndexOf('-');
    if (at <= 0) return undefined;
    const key = hashToKey.get(value.slice(at + 1));
    return key && basesOf.get(key)?.has(value.slice(0, at)) ? key : undefined;
  };

  return {
    entries,
    keyFor(value: unknown): string {
      if (typeof value === 'string') {
        const v = value.trim();
        const hit = slugToKey.get(v);
        if (hit !== undefined) return hit;
        const aliased = alias.get(v);
        if (aliased) return aliased;
        const numbered = /^(.+)-\d+$/.exec(v);
        const suffixed = bySuffix(v) ?? (numbered ? bySuffix(numbered[1]) : undefined);
        if (suffixed) return suffixed;
      }
      const key = brandKey(value);
      return nameAlias.get(key) ?? key;
    },
    keyOfRecord,
    slugTakenBy(slug: unknown, record: CuratedBrandLike) {
      const s = typeof slug === 'string' ? slug.trim() : '';
      if (!s) return undefined;
      const own = keyOfRecord(record);
      const named = brandKey(s);
      const viaAlias = alias.get(s);
      return entries.find((e) => e.key !== own
        && (e.slug === s || (named !== '' && e.key === named) || e.key === viaAlias));
    },
  };
}

/**
 * Does a product's brand satisfy a brand FILTER value?
 *
 * The predicate collection rules use, resolving the value through the same
 * directory as `?brand=` so a rule written with a published slug means what the
 * link means. Without a directory it is `sameBrand` — identity only.
 */
export function brandMatches(
  productBrand: unknown,
  filterValue: unknown,
  directory?: Pick<BrandDirectory, 'keyFor'>,
): boolean {
  const want = directory ? directory.keyFor(filterValue) : brandKey(filterValue);
  // '' is "no brand": a rule naming nothing matches nothing.
  return want !== '' && brandKey(productBrand) === want;
}
