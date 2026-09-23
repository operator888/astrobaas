/**
 * Which language does THIS request render in?
 *
 * Two different questions live here and conflating them is the classic i18n
 * mistake, so they are two functions:
 *
 *   contentLocale()  what language the PUBLIC page is written in. Decided by
 *                    the URL, because a page in Greek must have a stable Greek
 *                    address that can be linked, cached and indexed.
 *
 *   uiLocale()       what language the ADMIN chrome is in. Decided by the
 *                    person, because it is their tool, not their content. A
 *                    Greek editor writing German product copy wants Greek
 *                    buttons.
 *
 * The public site never consults a person's preference: two visitors must get
 * the same bytes for the same URL, or a CDN cannot cache it and a shared link
 * shows something different to whoever opens it.
 */

import { isKnownLocale, defaultLocale, normalizeLocale } from '../i18n';
import { hasCatalogue, BASE_LOCALE } from './translate';

/** The staff member's stored preference, if they have one. */
export interface LocaleUser {
  locale?: string;
}

/**
 * The admin UI language for this request.
 *
 * Order: the user's saved preference, then `Accept-Language` (so a first login
 * is already in the right language), then the site default, then English.
 *
 * Every candidate must clear TWO gates: the site must serve that locale
 * (`SITE_LOCALES`) and a catalogue must actually exist for it. Without the
 * second, choosing an enabled-but-untranslated locale would render an admin of
 * raw message keys — the site would be "in Polish" and unusable.
 */
export function uiLocale(
  user: LocaleUser | null | undefined,
  acceptLanguage: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const usable = (value: unknown): string | null => {
    const code = String(value ?? '').trim().toLowerCase();
    if (!code) return null;
    if (!isKnownLocale(code, env)) return null;
    return hasCatalogue(code) ? code : null;
  };

  const fromUser = usable(user?.locale);
  if (fromUser) return fromUser;

  for (const tag of parseAcceptLanguage(acceptLanguage)) {
    const hit = usable(tag) ?? usable(tag.split('-')[0]);
    if (hit) return hit;
  }

  return usable(defaultLocale(env)) ?? BASE_LOCALE;
}

/**
 * Parse `Accept-Language` into tags, best first.
 *
 * Bounded at 10 tags. The header is attacker-controlled and free-form; a
 * request carrying a thousand of them must not turn into a thousand lookups on
 * every page.
 */
export function parseAcceptLanguage(raw: string | null | undefined): string[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  return raw
    .split(',')
    .slice(0, 10)
    .map((part) => {
      const [tag, ...rest] = part.trim().split(';');
      const q = rest
        .map((p) => p.trim())
        .find((p) => p.startsWith('q='));
      const weight = q ? Number(q.slice(2)) : 1;
      return { tag: tag.trim().toLowerCase(), weight: Number.isFinite(weight) ? weight : 0 };
    })
    // Only well-formed tags. Anything else is not a language, and letting it
    // through means it reaches Intl.PluralRules, which throws on some inputs.
    .filter((x) => x.tag && /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/.test(x.tag) && x.weight > 0)
    .sort((a, b) => b.weight - a.weight)
    .map((x) => x.tag);
}

/**
 * The language a PUBLIC request should be answered in.
 *
 * The URL prefix decides, because a URL is the only thing that can be shared,
 * cached and indexed. `?locale=` is honoured for the API, where a headless
 * storefront is asking on a visitor's behalf and there is no prefix to read.
 *
 * Returns the site default when nothing says otherwise — which is what makes
 * every existing request byte-identical to before this feature existed.
 */
export function contentLocale(
  pathLocale: string | null | undefined,
  queryLocale: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (pathLocale && isKnownLocale(pathLocale, env)) return normalizeLocale(pathLocale, env);
  if (queryLocale && isKnownLocale(queryLocale, env)) return normalizeLocale(queryLocale, env);
  return defaultLocale(env);
}

/**
 * The value for `<html lang>`.
 *
 * Its own function because it is currently hardcoded to `en` in BaseLayout —
 * so a Greek page has been telling screen readers and search engines it is
 * English. That is wrong today regardless of this feature.
 */
export function htmlLang(locale: string, env: NodeJS.ProcessEnv = process.env): string {
  const code = normalizeLocale(locale, env);
  return code || BASE_LOCALE;
}
