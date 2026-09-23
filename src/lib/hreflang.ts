/**
 * `hreflang` — telling search engines that two URLs are the same document.
 *
 * The last gap in Phase E. The project ships i18n (configured locales, a
 * `locale` per record, `translation_of` linking a set together, and `/de/`-style
 * URL prefixes) and told search engines none of it. A bilingual shop therefore
 * competed with itself: two pages, similar content, no signal that one is the
 * Greek version of the other, and the engine picks a winner on its own.
 *
 * ## What the tags have to satisfy
 *
 * Google's rule is reciprocity: **every URL in a translation set must list every
 * URL in that set, including itself.** A page that lists its sibling while the
 * sibling stays silent is ignored, so emitting a partial set is not a smaller
 * benefit — it is no benefit. That is why this returns the whole set from one
 * function rather than letting each page assemble its own.
 *
 * `x-default` names the URL for a reader whose language matches nothing. The
 * default locale is the honest answer here, and it is also the un-prefixed URL,
 * so it doubles as the canonical entry point.
 *
 * ## Why a single-language site emits nothing
 *
 * On an install with one configured locale there is no set, and a lone
 * self-referential `hreflang` is noise. `hreflangFor` returns an empty array,
 * every caller renders nothing, and the markup of the two live single-language
 * shops is unchanged.
 */
import type { Post } from '../core/models';
import { locales, defaultLocale, isMultilingual, recordLocale, localePath } from './i18n';

export interface HreflangLink {
  /** BCP-47-ish code, or `x-default`. */
  hreflang: string;
  /** Absolute URL. */
  href: string;
}

/**
 * Every record in the same translation set as `post`, including `post` itself.
 *
 * A set is identified by `translation_of` — conventionally the id of whichever
 * record was written first. The original does not carry the field, so the set
 * is "the original, plus everything pointing at it", and either the post itself
 * or one of its translations can be the entry point.
 */
export function translationSet(post: Post, all: readonly Post[]): Post[] {
  const rootId = post.translation_of ?? post.id;
  const set = all.filter((p) => p.id === rootId || p.translation_of === rootId);
  // A record whose `translation_of` points at something deleted would otherwise
  // vanish from its own set.
  return set.some((p) => p.id === post.id) ? set : [post, ...set];
}


export interface HreflangOptions {
  /** Absolute site origin, no trailing slash. Omit and nothing is emitted. */
  origin: string | null | undefined;
  /** Path for the record WITHOUT a locale prefix, e.g. `/blog/my-post`. */
  pathFor: (post: Post) => string;
  env?: NodeJS.ProcessEnv;
}

/**
 * The complete, reciprocal link set for one record.
 *
 * Empty when the site is single-language, when the origin cannot be resolved,
 * or when the set has only one member — in each case there is nothing true to
 * say, and saying it anyway is worse than silence.
 */
export function hreflangFor(
  post: Post,
  all: readonly Post[],
  opts: HreflangOptions,
): HreflangLink[] {
  const { origin, pathFor, env } = opts;
  if (!origin || !isMultilingual(env)) return [];

  const known = locales(env);
  const set = translationSet(post, all);

  // One record per locale. If two records claim the same language — a
  // duplicated translation — the first wins deterministically rather than
  // emitting two conflicting tags for one hreflang value, which search engines
  // discard the whole set for.
  const byLocale = new Map<string, Post>();
  for (const p of set) {
    // Only PUBLISHED translations: advertising a draft URL hands a crawler a
    // 404, and the set is judged as a whole.
    if (p.status !== 'published') continue;
    // Nor a translation its author hid. Naming a noindexed URL as "the German
    // version of this page" is the contradiction the sitemap and feed filters
    // exist to avoid, one door over — and because a hidden page's own
    // annotations are not honoured, reciprocity breaks and the whole cluster
    // can be discarded. A partial set is not a smaller benefit.
    if (p.noindex) continue;
    const loc = recordLocale(p, env);
    if (!known.includes(loc)) continue;
    if (!byLocale.has(loc)) byLocale.set(loc, p);
  }

  if (byLocale.size < 2) return [];

  const links: HreflangLink[] = [];
  for (const [loc, p] of [...byLocale].sort(([a], [b]) => a.localeCompare(b))) {
    links.push({ hreflang: loc, href: `${origin}${localePath(pathFor(p), loc, env)}` });
  }

  // x-default points at the default-locale version when there is one. Without
  // it, a reader whose language matches nothing is left to the engine's guess.
  const fallback = byLocale.get(defaultLocale(env));
  if (fallback) {
    links.push({
      hreflang: 'x-default',
      href: `${origin}${localePath(pathFor(fallback), defaultLocale(env), env)}`,
    });
  }
  return links;
}
