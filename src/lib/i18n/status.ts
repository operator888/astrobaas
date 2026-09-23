/**
 * What is translated, and what is not.
 *
 * A multilingual site has two different translation models, for good reasons,
 * and an operator has to hold both in their head to answer one question:
 *
 *  - **Content** — a post or page is ONE RECORD PER LANGUAGE, linked by
 *    `translation_of`. A German article is a separate row with its own slug,
 *    its own editing history and its own publish date, because that is what
 *    editorial translation actually is.
 *  - **The catalogue** — a product is ONE RECORD with an `i18n` sidecar,
 *    because a product is one physical object with one price and one stock
 *    count. Splitting it per language would split the stock.
 *
 * The consequence is that "what is missing in German?" cannot be answered by
 * looking at one place, which is why nobody answers it and shops ship with
 * half-translated catalogues. This module answers it once, purely, so the
 * screen that shows it and the tests that pin it read the same numbers.
 *
 * PURE: records in, counts out. No database, no clock.
 */
import { translatedIn } from './catalogue-translations';

export interface LocaleGap {
  locale: string;
  /** Records that exist in the default locale and are missing here. */
  missing: number;
  /** Records that exist here. */
  present: number;
  /** 0–100. 100 when there is nothing to translate. */
  percent: number;
  /** A few examples, so the screen can say WHICH ones. */
  examples: { id: string; title: string }[];
}

export interface TranslationStatus {
  defaultLocale: string;
  locales: string[];
  posts: LocaleGap[];
  products: LocaleGap[];
  /** Catalogue records with SOME fields translated and some not. */
  partial: { id: string; title: string; locale: string; missingFields: string[] }[];
}

const EXAMPLE_LIMIT = 8;

/**
 * Whole percent, and 100 when there is nothing to do rather than 0.
 *
 * FLOORS toward not-done: 199/200 is 99%, never a rounded-up 100 that would
 * paint a full green "done" bar while an item is still missing. Only a genuine
 * present === total reads 100.
 */
function percentOf(present: number, total: number): number {
  if (total === 0) return 100;
  if (present >= total) return 100;
  return Math.min(99, Math.floor((present / total) * 100));
}

type PostLike = {
  id: string;
  title?: string;
  locale?: string;
  translation_of?: string;
  status?: string;
};

/** Statuses that count toward the translation backlog. A draft or a trashed
 *  record is not something a shop needs translated, and a trashed translation
 *  must not report its language as done. */
function translatable(p: PostLike): boolean {
  const st = p.status ?? 'published';
  return st !== 'trash' && st !== 'trashed' && st !== 'draft' && st !== 'auto-draft';
}

/**
 * Which content records are missing in each locale.
 *
 * A translation SET is identified by `translation_of`, conventionally the id
 * of whichever record was written first. A record with no `translation_of` is
 * its own set — that is how a site that has never been translated looks, and
 * it must read as "nothing translated yet" rather than as an error.
 *
 * Only sets that exist in the DEFAULT locale are counted as gaps. An article
 * written directly in German with no English original is not an English
 * translation that somebody forgot; counting it as one would show a shop a
 * backlog it does not have.
 */
export function postGaps(
  posts: readonly PostLike[],
  localeList: readonly string[],
  defaultLocale: string,
): LocaleGap[] {
  // Only translatable records count. A trashed German translation must not
  // make the dashboard report German as done, and a draft is not backlog.
  const live = posts.filter(translatable);

  // Resolve translation_of to a ROOT, following chains: a de record may point
  // at the el record which points at the en original. One-level grouping made
  // such a chain invisible and reported its language as missing.
  const byId = new Map(live.map((p) => [p.id, p]));
  const rootOf = (p: PostLike): string => {
    const seen = new Set<string>();
    let cur = p;
    while (cur.translation_of && byId.has(cur.translation_of) && !seen.has(cur.id)) {
      seen.add(cur.id);
      cur = byId.get(cur.translation_of)!;
    }
    return cur.id;
  };

  const setsByKey = new Map<string, PostLike[]>();
  for (const p of live) {
    const key = rootOf(p);
    const group = setsByKey.get(key);
    if (group) group.push(p);
    else setsByKey.set(key, [p]);
  }

  const localeOf = (p: PostLike) => p.locale || defaultLocale;

  // Only sets with a record in the default locale count toward the total.
  const sets = [...setsByKey.values()].filter((g) => g.some((p) => localeOf(p) === defaultLocale));

  return localeList
    .filter((l) => l !== defaultLocale)
    .map((locale) => {
      const missing: { id: string; title: string }[] = [];
      let present = 0;
      for (const group of sets) {
        if (group.some((p) => localeOf(p) === locale)) present += 1;
        else {
          const source = group.find((p) => localeOf(p) === defaultLocale)!;
          missing.push({ id: source.id, title: source.title || '(untitled)' });
        }
      }
      return {
        locale,
        missing: missing.length,
        present,
        percent: percentOf(present, sets.length),
        examples: missing.slice(0, EXAMPLE_LIMIT),
      };
    });
}

type CatalogueLike = {
  id: string;
  name?: string;
  i18n?: Record<string, Record<string, string>>;
};

/**
 * Which catalogue records carry nothing at all for a locale.
 *
 * "Nothing at all" and "some fields" are different problems with different
 * fixes, so they are reported separately — a product with a German name and no
 * German description is a five-minute job, and one with no German anything is
 * a translation request.
 */
export function catalogueGaps(
  records: readonly CatalogueLike[],
  localeList: readonly string[],
  defaultLocale: string,
): LocaleGap[] {
  return localeList
    .filter((l) => l !== defaultLocale)
    .map((locale) => {
      const missing: { id: string; title: string }[] = [];
      let present = 0;
      for (const r of records) {
        if (translatedIn(r).includes(locale)) present += 1;
        else missing.push({ id: r.id, title: r.name || '(unnamed)' });
      }
      return {
        locale,
        missing: missing.length,
        present,
        percent: percentOf(present, records.length),
        examples: missing.slice(0, EXAMPLE_LIMIT),
      };
    });
}

/**
 * Catalogue records that are PART translated.
 *
 * The failure this catches is specific and silent: a shop translates every
 * product name into German, ships, and every German product page shows an
 * English description under a German heading. The record has an `i18n` entry
 * for `de`, so nothing reports it as untranslated.
 *
 * A field is only "missing" when the record actually HAS it in the default
 * locale. A product with no `short_description` at all is not missing a German
 * one.
 */
export function partialTranslations(
  records: readonly CatalogueLike[],
  localeList: readonly string[],
  defaultLocale: string,
  fields: readonly string[],
): TranslationStatus['partial'] {
  const out: TranslationStatus['partial'] = [];
  for (const r of records) {
    const source = r as unknown as Record<string, unknown>;
    const wanted = fields.filter((f) => {
      const v = source[f];
      return typeof v === 'string' && v.trim() !== '';
    });
    if (wanted.length === 0) continue;

    for (const locale of localeList) {
      if (locale === defaultLocale) continue;
      const entry = r.i18n?.[locale];
      // No entry at all is a whole-record gap, reported by catalogueGaps. This
      // is only about records that LOOK translated.
      if (!entry) continue;
      const missingFields = wanted.filter((f) => {
        const v = entry[f];
        return typeof v !== 'string' || v.trim() === '';
      });
      if (missingFields.length > 0) {
        out.push({ id: r.id, title: r.name || '(unnamed)', locale, missingFields });
      }
    }
  }
  return out;
}
