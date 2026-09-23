/**
 * Message translation.
 *
 * ## The constraint everything here is shaped by
 *
 * Two shops are live. A translation layer that can return `undefined`, throw on
 * a missing key, or change output when no locale was asked for would take them
 * down — so every path through this module ends in a string, and a request that
 * names no locale gets exactly what it got before this existed.
 *
 * ## Why catalogues are modules and not files read at runtime
 *
 * `t()` runs on the request path, potentially hundreds of times per page. A
 * catalogue read from disk or from the database would put I/O behind every
 * label. Catalogues are TypeScript modules instead: resolved once at import,
 * bundled into the build, and `t()` is a map lookup.
 *
 * The cost is that adding a language to the CORE set is a code change. That is
 * the right trade for the languages the project ships, and
 * `registerCatalogue()` exists for the ones it does not — a plugin can add
 * Polish without touching this repository.
 *
 * ## Pluralisation is `Intl.PluralRules`, not `n === 1`
 *
 * English, Greek and German all happen to have two plural forms, so a hand-
 * rolled `n === 1 ? a : b` would look correct for the initial three and be
 * wrong for the fourth. Polish has three, Arabic six. `Intl.PluralRules` is in
 * Node and every browser this supports, and it means a language pack can be
 * added later without revisiting this file.
 */

/** A flat map of message key to translated text. */
export type Catalogue = Readonly<Record<string, string>>;

/**
 * Interpolation values.
 *
 * Deliberately not `unknown`: a translated string ends up in HTML, and letting
 * an arbitrary object stringify itself into it is how `[object Object]` reaches
 * a customer.
 */
export type TranslateParams = Readonly<Record<string, string | number>>;

/** Every catalogue known to this process, by locale code. */
const catalogues = new Map<string, Catalogue>();

/**
 * The locale every lookup falls back to.
 *
 * English rather than the site's default, deliberately: it is the locale the
 * source strings are written in, so it is the one guaranteed to have every key.
 * A site whose default is Greek still falls back to English for a key its Greek
 * catalogue has not translated yet — showing the raw key would be worse.
 */
export const BASE_LOCALE = 'en';

export function registerCatalogue(locale: string, catalogue: Catalogue): void {
  const code = String(locale ?? '').trim().toLowerCase();
  if (!code) return;
  const existing = catalogues.get(code);
  // Merge rather than replace, so a plugin can add or override individual keys
  // without having to restate an entire catalogue to change one label.
  catalogues.set(code, existing ? { ...existing, ...catalogue } : catalogue);
}

export function hasCatalogue(locale: string): boolean {
  return catalogues.has(String(locale ?? '').trim().toLowerCase());
}

/** Locales with a catalogue, sorted. For diagnostics and the admin picker. */
export function translatedLocales(): string[] {
  return [...catalogues.keys()].sort();
}

/** Test seam. Never called in production code. */
export function _resetCatalogues(): void {
  catalogues.clear();
}

/**
 * How many keys a locale is missing relative to the base catalogue.
 *
 * Surfaced in the admin so an incomplete translation is a visible number rather
 * than something a reader discovers one English label at a time.
 */
export function catalogueCoverage(locale: string): { total: number; translated: number; missing: string[] } {
  const base = catalogues.get(BASE_LOCALE) ?? {};
  const target = catalogues.get(String(locale ?? '').trim().toLowerCase()) ?? {};
  const keys = Object.keys(base);
  const missing = keys.filter((k) => typeof target[k] !== 'string' || target[k] === '');
  return { total: keys.length, translated: keys.length - missing.length, missing };
}

/**
 * Substitute `{name}` placeholders.
 *
 * A placeholder with no matching parameter is left in place rather than blanked.
 * "Deleted {count} posts" with the count missing reads as an obvious bug;
 * "Deleted  posts" reads as a sentence and ships.
 */
export function interpolate(template: string, params?: TranslateParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name];
    if (value === undefined || value === null) return whole;
    return String(value);
  });
}

/**
 * Pick the plural form for `count`.
 *
 * Keys are `<key>` plus a CLDR category suffix: `posts_one`, `posts_other`, and
 * for languages that need them `posts_few`, `posts_many`, `posts_zero`,
 * `posts_two`. Falls back to `_other`, then to the bare key.
 */
function pluralKey(key: string, count: number, locale: string, cat: Catalogue): string {
  let category = 'other';
  try {
    category = new Intl.PluralRules(locale).select(count);
  } catch {
    // An unknown locale tag must not break a label.
    category = count === 1 ? 'one' : 'other';
  }
  const withCategory = `${key}_${category}`;
  if (typeof cat[withCategory] === 'string') return withCategory;
  const other = `${key}_other`;
  if (typeof cat[other] === 'string') return other;
  return key;
}

export interface TranslateOptions {
  /** Selects a plural form, and is available to the template as `{count}`. */
  count?: number;
}

/**
 * Look up a message.
 *
 * Resolution order: the requested locale, then the base locale, then the key
 * itself. It never throws and never returns anything but a string — this runs
 * inside page rendering on live shops.
 *
 * A missing key is logged ONCE per key outside production. Logging on every
 * call would bury the signal in a page that renders the same label fifty times,
 * and logging in production would let a page render turn into a log flood.
 */
const warned = new Set<string>();

export function translate(
  locale: string,
  key: string,
  params?: TranslateParams,
  options?: TranslateOptions,
): string {
  const code = String(locale ?? '').trim().toLowerCase();
  const cat = catalogues.get(code);
  const base = catalogues.get(BASE_LOCALE);

  const count = options?.count;
  const lookupKey = typeof count === 'number' && cat
    ? pluralKey(key, count, code, cat)
    : typeof count === 'number' && base
      ? pluralKey(key, count, BASE_LOCALE, base)
      : key;

  let text = cat?.[lookupKey];
  if (typeof text !== 'string' || text === '') {
    text = base?.[lookupKey] ?? base?.[key];
  }
  if (typeof text !== 'string' || text === '') {
    if (process.env.NODE_ENV !== 'production') {
      const id = `${code}:${key}`;
      if (!warned.has(id)) {
        warned.add(id);
        console.warn(`[i18n] missing message "${key}" for locale "${code}"`);
      }
    }
    // The key itself, not an empty string. A visible `admin.orders.title` is a
    // bug report; an empty heading is a mystery.
    return key;
  }

  const merged: TranslateParams | undefined =
    typeof count === 'number' ? { count, ...(params ?? {}) } : params;
  return interpolate(text, merged);
}

/** A `t()` bound to one locale — what a page or component actually uses. */
export type Translator = (key: string, params?: TranslateParams, options?: TranslateOptions) => string;

export function translatorFor(locale: string): Translator {
  return (key, params, options) => translate(locale, key, params, options);
}
