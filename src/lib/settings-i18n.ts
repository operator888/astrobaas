/**
 * Per-locale operator strings (C-136).
 *
 * ## What was actually missing
 *
 * Not the pattern — the pattern already exists three times, with a shared
 * field-by-field rule (`projectTranslations`). It had simply never been pointed
 * at the settings table: `getSiteSettings()` reads `site_title` and
 * `site_tagline` flat and takes no locale at all, so a bilingual shop's German
 * pages carried a Greek site title.
 *
 * ## Where this reaches, precisely
 *
 * Every surface that HAS a request locale: the page `<title>` and chrome
 * through `getSiteSettings`, the RSS feed, and the Open Graph card. The feed
 * and the card each read their own settings map, so wiring `getSiteSettings`
 * alone did not reach them — an audit found both still serving the default
 * title on a localised URL, and this docblock claiming otherwise.
 *
 * ## Where it deliberately does NOT reach: email
 *
 * A transactional email has no request locale. It is sent by a scheduler, a
 * webhook, or a checkout that finished minutes ago, and the only locale
 * available is the RECORD's — which is a different question from "what
 * language does this person read". Guessing it would put a German subject on a
 * Greek customer's order.
 *
 * The email wording is operator-editable per install instead (C-112), which is
 * the honest answer for a single-language shop and an explicit decision for a
 * bilingual one. An earlier version of this note claimed emails were covered.
 * They were not, and now they are named as not covered.
 *
 * ## An explicit whitelist, not "any setting"
 *
 * Only the keys below can be localised. "Any setting" would let somebody create
 * a locale-keyed API credential or a locale-keyed site URL — shapes nobody
 * should be able to make, and which every reader would then have to defend
 * against.
 *
 * ## Blank is not a translation
 *
 * The same rule `projectTranslations` applies to records: a half-filled German
 * block overlays only the fields it actually filled in. Otherwise an operator
 * who translated the tagline and not the title would blank the title on every
 * German page — a data-loss-shaped surprise from an additive edit.
 */

/** The sidecar key. Additive: an install that never sets it is unchanged. */
export const SETTINGS_I18N_KEY = 'site_i18n';

/**
 * The only settings that may carry a translation.
 *
 * Deliberately short. Each one is a string a READER sees, and none of them is a
 * credential, a URL or a switch.
 */
export const LOCALIZABLE_SETTINGS = [
  'site_title',
  'site_tagline',
  'site_author_name',
  'maintenance_message',
] as const;

export type LocalizableSetting = (typeof LOCALIZABLE_SETTINGS)[number];

export function isLocalizable(key: string): key is LocalizableSetting {
  return (LOCALIZABLE_SETTINGS as readonly string[]).includes(key);
}

/** `{ de: { site_title: '…' } }` */
export type SettingsI18n = Record<string, Partial<Record<LocalizableSetting, string>>>;

/**
 * Rebuild a stored sidecar, dropping anything that is not a localisable string.
 *
 * The stored value outlives the screen that wrote it — it can arrive through
 * the settings API, a restore or a hand edit — so an unknown key is DROPPED
 * rather than refused: a sidecar that failed to load because one key was
 * renamed would take every other translation down with it.
 */
/**
 * A locale key, matching `lib/i18n.ts`'s own rule.
 *
 * The first version here was `/^[a-z]{2}(-[a-z0-9]{2,8})?$/` — two letters
 * only, one optional subtag — while `lib/i18n.ts` accepts two OR THREE and any
 * number of subtags. So an install running `ckb` (Sorani Kurdish, one of the
 * right-to-left languages `i18n/direction.ts` was written for in the same
 * commit) could store a translation block that this module silently dropped on
 * every read. Same for `fil`, and for `zh-Hant-TW`.
 *
 * Two validators for one concept is the shape this codebase keeps paying for.
 */
const LOCALE_KEY_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

export function normaliseSettingsI18n(raw: unknown): SettingsI18n {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: SettingsI18n = {};
  for (const [locale, block] of Object.entries(raw as Record<string, unknown>)) {
    const code = String(locale).trim().toLowerCase();
    if (!LOCALE_KEY_RE.test(code)) continue;
    if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
    const kept: Partial<Record<LocalizableSetting, string>> = {};
    for (const [key, value] of Object.entries(block as Record<string, unknown>)) {
      if (!isLocalizable(key)) continue;
      if (typeof value !== 'string') continue;
      // Blank is not a translation — see the header. Storing one would be
      // indistinguishable from an intentional empty title.
      if (!value.trim()) continue;
      kept[key] = value.slice(0, 500);
    }
    if (Object.keys(kept).length > 0) out[code] = kept;
  }
  return out;
}

/**
 * One setting, for one reader.
 *
 * Falls back to the flat value whenever there is no translation — so a caller
 * that passes no locale, or a locale nobody has translated, gets exactly what
 * it got before this module existed.
 */
export function localizedSetting(
  settings: Record<string, unknown> | null | undefined,
  key: string,
  locale: string | null | undefined,
): unknown {
  const map = settings ?? {};
  if (!isLocalizable(key)) return map[key];
  const code = String(locale ?? '').trim().toLowerCase();
  if (!code) return map[key];
  const sidecar = normaliseSettingsI18n(map[SETTINGS_I18N_KEY]);
  const translated = sidecar[code]?.[key];
  return translated ?? map[key];
}

/**
 * A settings map with one locale's translations applied.
 *
 * For a caller that reads several keys and would otherwise ask per key — the
 * site-settings reader, the feed, the OG image. The sidecar is stripped from
 * the result so the shape a reader sees is identical either way.
 */
export function localizedSettings(
  settings: Record<string, unknown> | null | undefined,
  locale: string | null | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(settings ?? {}) };
  const code = String(locale ?? '').trim().toLowerCase();
  const sidecar = normaliseSettingsI18n(out[SETTINGS_I18N_KEY]);
  delete out[SETTINGS_I18N_KEY];
  const overlay = code ? sidecar[code] : undefined;
  if (!overlay) return out;
  for (const key of LOCALIZABLE_SETTINGS) {
    const value = overlay[key];
    if (typeof value === 'string' && value.trim()) out[key] = value;
  }
  return out;
}
