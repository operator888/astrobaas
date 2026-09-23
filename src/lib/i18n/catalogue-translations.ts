/**
 * Translating the CATALOGUE — products, brands, categories, shipping methods.
 *
 * ## Why this is not the model posts use
 *
 * A post is a document: a Greek post and its German translation are two works,
 * with their own URLs, publish states and edit histories. Hence `locale` +
 * `translation_of` and one record per language.
 *
 * A product is not a document. It is one physical object with one stock count,
 * one price and one SKU, that happens to need labels in three languages.
 * Cloning it per locale forks inventory identity: 436 products become ~1,308
 * records with `stock`, `price_cents` and variant ids duplicated and nothing
 * keeping them in sync, and `OrderItem.product_id` ends up pointing at whichever
 * clone the buyer happened to use.
 *
 * So the rule, written down because the split must be principled rather than
 * accidental:
 *
 *   **Row per locale where the locale is part of the record's IDENTITY.**
 *   **Field level where the record is one real thing with translated labels.**
 *
 * ## The shape, and why it needs no migration
 *
 * One additive key. Products, brands and categories are stored as opaque JSON
 * blobs (`sql-storage.ts` keeps them as `(id, data)`), so this needs no DDL, no
 * backfill and no migration — which is the hard constraint, because two shops
 * are live with 436 products and real order history.
 *
 * It is not a new pattern either: `ManualMethodDef.instructions` is already a
 * `Record<locale, text>` served publicly.
 *
 * ## Falling back FIELD BY FIELD
 *
 * The single most important rule here. A locale that has translated `name` but
 * not `description` must get the translated name and the base description —
 * never an empty description, and never the whole record falling back because
 * one field was missing.
 *
 * Getting this wrong shows a Greek shopper a blank product name, silently, on a
 * live shop.
 */

/** Fields that carry human-readable text and can therefore be translated. */
export const TRANSLATABLE_PRODUCT_FIELDS = [
  'name', 'description', 'short_description', 'purchase_note',
] as const;
export const TRANSLATABLE_TAXONOMY_FIELDS = ['name', 'description'] as const;

export type TranslatableField = string;

/** `{ de: { name: 'Fassung X' } }` — only the fields that differ. */
export type TranslationMap = Readonly<Record<string, Readonly<Record<string, string>>>>;

/**
 * Anything carrying a translation sidecar.
 *
 * Deliberately WITHOUT an index signature. `interface Translatable { [k: string]:
 * unknown }` would look more permissive and is in fact stricter: TypeScript
 * refuses to assign a concrete interface like `Product` to a type with an index
 * signature, so every call site would need a cast — and a cast at every call
 * site is how the wrong thing eventually gets passed.
 */
export interface Translatable {
  i18n?: TranslationMap;
}

/** Read a field off a record without widening the record's own type. */
function fieldOf(record: object, name: string): unknown {
  return (record as Record<string, unknown>)[name];
}

/**
 * Merge a record's translations for one locale down into its scalar fields.
 *
 * The `i18n` map is REMOVED from the result. That is what lets AstroBaaS ship
 * multilingual before either storefront changes a line: `GET /api/products`
 * with no `?locale=` returns exactly what it returned before, and with one it
 * returns the same SHAPE with different text. Returning `name` as
 * `{en, de}` instead would render `[object Object]` in both live shops the
 * moment it deployed.
 */
export function projectTranslations<T extends Translatable>(
  record: T,
  locale: string | null | undefined,
  fields: readonly string[],
): T {
  const map = record?.i18n;
  // No locale asked for, or nothing translated: hand back the record with the
  // sidecar stripped, so the wire shape is identical either way.
  if (!record || typeof record !== 'object') return record;

  const code = String(locale ?? '').trim().toLowerCase();
  const overlay = code && map && typeof map === 'object' ? map[code] : undefined;

  const out: Record<string, unknown> = { ...(record as object) };
  delete out.i18n;

  if (overlay && typeof overlay === 'object') {
    for (const field of fields) {
      const value = overlay[field];
      // Field by field, and only when there is genuinely something there. An
      // empty string is NOT a translation — it is an untranslated field that
      // somebody saved a blank into, and using it would blank a product name.
      if (typeof value === 'string' && value.trim() !== '') {
        out[field] = value;
      }
    }
  }
  return out as T;
}

/** Project a list. Separate only so call sites read as what they are. */
export function projectAll<T extends Translatable>(
  records: readonly T[],
  locale: string | null | undefined,
  fields: readonly string[],
): T[] {
  return records.map((r) => projectTranslations(r, locale, fields));
}

export interface NormaliseOptions {
  /** Locales this site serves. Anything else is dropped. */
  allowed: readonly string[];
  /** Fields that may be translated. Anything else is dropped. */
  fields: readonly string[];
  /** Per-field maximum length, mirroring the base field's own limit. */
  limits?: Readonly<Record<string, number>>;
  /** Applied to fields that accept HTML, so a translation cannot smuggle any. */
  sanitize?: (html: string) => string;
}

/**
 * Clean an incoming `i18n` map before it is stored.
 *
 * Everything here exists because a translation is an untrusted write path that
 * did not exist before. A locale nobody serves, a field nobody translates, a
 * description ten times longer than the base field allows, or HTML in a field
 * the base version sanitises — each would be a way around a rule the base
 * fields already enforce.
 *
 * Returns undefined when nothing survives, so an empty map is never stored.
 */
export function normaliseTranslations(
  raw: unknown,
  opts: NormaliseOptions,
): TranslationMap | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;

  const allowed = new Set(opts.allowed.map((l) => l.toLowerCase()));
  const fields = new Set(opts.fields);
  const out: Record<string, Record<string, string>> = {};

  for (const [rawLocale, rawValues] of Object.entries(raw as Record<string, unknown>)) {
    const locale = String(rawLocale).trim().toLowerCase();
    if (!allowed.has(locale)) continue;
    if (!rawValues || typeof rawValues !== 'object' || Array.isArray(rawValues)) continue;

    const values: Record<string, string> = {};
    for (const [field, value] of Object.entries(rawValues as Record<string, unknown>)) {
      if (!fields.has(field)) continue;
      if (typeof value !== 'string') continue;
      let text = value;
      if (opts.sanitize && (field === 'description' || field === 'short_description' || field === 'purchase_note')) {
        text = opts.sanitize(text);
      }
      const limit = opts.limits?.[field];
      if (typeof limit === 'number') text = text.slice(0, limit);
      text = text.trim();
      // A blank is an absent translation, not an empty one. Storing it would
      // make projectTranslations have to decide, and it should never have to.
      if (text === '') continue;
      values[field] = text;
    }
    if (Object.keys(values).length) out[locale] = values;
  }

  return Object.keys(out).length ? out : undefined;
}

/** Which locales a record has any translation for. For the admin's tabs. */
export function translatedIn(record: Translatable | null | undefined): string[] {
  const map = record?.i18n;
  if (!map || typeof map !== 'object') return [];
  return Object.keys(map).sort();
}

/**
 * Everything a record can be found by, in every language it has.
 *
 * Staff search a catalogue by whatever name they have to hand, which is often
 * not the one the admin is currently displaying — someone handed a German
 * invoice looks up the German name. So the haystack is every translation, not
 * just the projected one.
 */
export function searchableText(
  record: (Translatable & object) | null | undefined,
  fields: readonly string[],
): string {
  if (!record) return '';
  const parts: string[] = [];
  for (const f of fields) {
    const v = fieldOf(record, f);
    if (typeof v === 'string') parts.push(v);
  }
  const map = record.i18n;
  if (map && typeof map === 'object') {
    for (const values of Object.values(map)) {
      if (!values || typeof values !== 'object') continue;
      for (const f of fields) {
        const v = (values as Record<string, unknown>)[f];
        if (typeof v === 'string') parts.push(v);
      }
    }
  }
  return parts.join(' ');
}
