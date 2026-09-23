/**
 * Writing direction (C-135).
 *
 * ## What the roadmap note got wrong
 *
 * It called this "a theme-token concern". The theme tokens are flex directions
 * (`--header-direction: row | column`) and have nothing to do with writing
 * direction. There was no `dir` attribute anywhere in the codebase at all, so
 * an Arabic or Hebrew locale rendered left-to-right with the punctuation in the
 * wrong places — and no amount of token editing could change that.
 *
 * ## Derived from the locale, never stored
 *
 * A second setting would be a second thing to get wrong: an operator who added
 * Arabic and forgot to tick "right to left" would get a broken site with
 * nothing saying why. The script of a language is a property of the language.
 *
 * The list is the RTL scripts in current use, matched on the language subtag so
 * `ar`, `ar-EG` and `ar_SA` all agree.
 */

/**
 * Languages written right to left.
 *
 * Arabic, Hebrew, Persian, Urdu, Pashto, Sindhi, Uyghur, Yiddish, Divehi,
 * Kurdish (Sorani), Syriac, Samaritan, Mandaic, N'Ko.
 */
const RTL_LANGUAGES = new Set([
  'ar', 'he', 'fa', 'ur', 'ps', 'sd', 'ug', 'yi', 'dv', 'ckb', 'syr', 'smp', 'mid', 'nqo',
]);

export type Direction = 'ltr' | 'rtl';

/**
 * The direction for a locale tag.
 *
 * Anything unrecognised is `ltr`, which is the safe default: a left-to-right
 * site rendered right-to-left is unreadable, while the reverse merely looks
 * wrong to somebody who would notice immediately.
 */
export function directionFor(locale: string | null | undefined): Direction {
  const tag = String(locale ?? '').trim().toLowerCase();
  if (!tag) return 'ltr';
  // The LANGUAGE subtag only: `ar-EG`, `ar_SA` and `ar` are one language.
  const lang = tag.split(/[-_]/)[0];
  return RTL_LANGUAGES.has(lang) ? 'rtl' : 'ltr';
}

/** True when this locale is written right to left. */
export function isRtl(locale: string | null | undefined): boolean {
  return directionFor(locale) === 'rtl';
}
