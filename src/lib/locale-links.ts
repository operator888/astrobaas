/**
 * Locale-aware links for the VISIBLE site.
 *
 * ## The gap this closes
 *
 * i18n landed in the document head first — canonical, hreflang, sitemap and RSS
 * all localise their URLs correctly. Nothing below the head did. Every nav item,
 * footer link and post card carried a hardcoded `href="/blog"`, so the locale
 * prefix was a one-way door: a reader could reach `/de/blog` by typing it, and
 * the first thing they clicked dropped them back into the default language.
 *
 * That made the metadata layer advertise URLs the site itself never linked to —
 * a sitemap full of `/de/...` entries that no crawl path reaches, and hreflang
 * annotations pointing into a section with no way in.
 *
 * ## Two rules, and the reason they differ
 *
 * **A record's link uses the RECORD's locale** (`postHref`). A card for a German
 * article must point at `/de/blog/...` even when it appears in a mixed list,
 * because the slug belongs to that record and no other locale serves it.
 *
 * **A static route's link uses the READER's locale** (`routeHref`). `/about`,
 * `/contact` and `/blog` are one template each, serving every language, so the
 * same path is valid under every prefix and the reader should stay where they
 * are.
 *
 * Getting these the wrong way round is the failure that looks correct in a
 * single-language install and breaks the moment a second locale exists.
 */
import type { Post } from '../core/models';
import { locales, isMultilingual, recordLocale, localePath, defaultLocale } from './i18n';

/**
 * A link to a static route, in the reader's current locale.
 *
 * `routeHref('/blog', 'de')` → `/de/blog`, and → `/blog` when `de` is the
 * default locale or the install is single-language. Safe to call unconditionally.
 */
export function routeHref(
  path: string,
  locale: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return localePath(path, locale, env);
}

/**
 * A link to a record, in the RECORD's own locale.
 *
 * `basePath` is the unprefixed route, e.g. `/blog/my-post`. The locale comes
 * from the record through `recordLocale`, so a post written before i18n existed
 * — which has no `locale` field at all — resolves to the default locale and
 * keeps its existing, unprefixed URL.
 */
export function postHref(
  basePath: string,
  record: { locale?: string } | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return localePath(basePath, recordLocale(record, env), env);
}

/** One entry in the language switcher. */
export interface LocaleOption {
  /** BCP-47 code, e.g. `de`. */
  locale: string;
  /** The language's name IN that language — what a reader looking for it recognises. */
  label: string;
  /** Where the switcher sends them. Always a path, never absolute. */
  href: string;
  /** True for the language currently being read. */
  current: boolean;
  /**
   * True when `href` points at an actual translation of what they are reading,
   * false when it falls back to that language's home page. Exposed so the UI can
   * be honest about which it is rather than promising a translation that is not
   * there.
   */
  translated: boolean;
}

export interface SwitcherOptions {
  /** The unprefixed path currently being read, e.g. `/blog` or `/blog/my-post`. */
  path: string;
  /** The locale currently being read. */
  current: string;
  /**
   * The record on screen, when the page IS a record. Omit for static routes —
   * that is what tells the switcher the path is shared across languages.
   */
  post?: Post | null;
  /** Every post, for finding translations. Only read when `post` is given. */
  all?: readonly Post[];
  /** Builds the unprefixed path for a translation. Required when `post` is given. */
  pathFor?: (p: Post) => string;
  env?: NodeJS.ProcessEnv;
}

/**
 * The language's name in its own language, e.g. `de` → `Deutsch`.
 *
 * Derived rather than tabulated: a hardcoded map covers the languages someone
 * thought of and shows a bare code for the rest, and this CMS lets the operator
 * configure any locale they like. Falls back to the uppercased code if the
 * runtime cannot name it — `Intl.DisplayNames` throws on a malformed tag, and a
 * misconfigured locale must not take the header down.
 */
export function localeLabel(loc: string): string {
  try {
    const name = new Intl.DisplayNames([loc], { type: 'language' }).of(loc);
    if (name && name.toLowerCase() !== loc.toLowerCase()) {
      return name.charAt(0).toLocaleUpperCase(loc) + name.slice(1);
    }
  } catch {
    /* fall through */
  }
  return loc.toUpperCase();
}

/**
 * Resolve `post` to every published translation of it, keyed by locale.
 *
 * Deliberately narrower than `hreflangFor`: that function answers "what may a
 * crawler be told", so it drops the whole set below two members and excludes
 * `noindex`. A human switching language should still be offered a page the
 * operator merely kept out of search results — `noindex` means "do not list
 * this", not "do not serve it".
 */
function translationsByLocale(
  post: Post,
  all: readonly Post[],
  env: NodeJS.ProcessEnv,
): Map<string, Post> {
  const byId = new Map(all.map((p) => [p.id, p]));

  // Walk to the root of the set, guarding against a cycle: `translation_of` is
  // operator-supplied and no driver has a unique or referential constraint on it.
  const seen = new Set<string>();
  let root = post;
  while (root.translation_of && byId.has(root.translation_of) && !seen.has(root.id)) {
    seen.add(root.id);
    root = byId.get(root.translation_of)!;
  }

  const members: Post[] = [root];
  for (const p of all) {
    if (p.id === root.id) continue;
    // Membership is decided by walking each candidate to ITS root, so a chain
    // (de → el → en) collects every link and not only the direct children.
    const s = new Set<string>();
    let cur = p;
    while (cur.translation_of && byId.has(cur.translation_of) && !s.has(cur.id)) {
      s.add(cur.id);
      cur = byId.get(cur.translation_of)!;
    }
    if (cur.id === root.id) members.push(p);
  }

  const out = new Map<string, Post>();
  for (const p of members) {
    if (p.status !== 'published') continue;
    const loc = recordLocale(p, env);
    if (!out.has(loc)) out.set(loc, p);
  }
  return out;
}

/**
 * The language switcher's entries, or `[]` when there is nothing to switch to.
 *
 * Empty on a single-language install, so the caller can render this
 * unconditionally and get no markup at all — the switcher must not appear on the
 * sites that are not multilingual, which is most of them.
 */
export function switcherOptions(opts: SwitcherOptions): LocaleOption[] {
  const env = opts.env ?? process.env;
  if (!isMultilingual(env)) return [];

  const known = locales(env);
  if (known.length < 2) return [];

  const def = defaultLocale(env);
  const translations =
    opts.post && opts.all && opts.pathFor
      ? translationsByLocale(opts.post, opts.all, env)
      : null;

  return known.map((loc) => {
    let href: string;
    let translated = false;

    if (translations) {
      const t = translations.get(loc);
      if (t) {
        href = localePath(opts.pathFor!(t), loc, env);
        translated = true;
      } else {
        // No translation of THIS article exists. The same path under another
        // prefix would 404 — the slug belongs to one record — so the honest
        // destination is that language's home page. Sending the reader to a
        // dead URL to preserve the illusion of a translation is worse than
        // sending them somewhere real.
        href = localePath('/', loc, env);
      }
    } else {
      // A static route: one template serves every language, so the path holds.
      href = localePath(opts.path, loc, env);
      translated = true;
    }

    return {
      locale: loc,
      label: localeLabel(loc),
      href,
      current: loc === (opts.current || def),
      translated,
    };
  });
}
