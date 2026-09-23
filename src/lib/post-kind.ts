/**
 * Article vs. page — the one place that decides.
 *
 * A Page is a Post with `kind: 'page'`: same record, same editor, same
 * revisions, different route. That single field has to be honoured in six
 * places (the blog archive, the blog permalink, the RSS feed, the posts API,
 * the sitemap, and the root catch-all), and getting it right in five of them is
 * the failure mode this codebase keeps hitting. So the rule lives here and the
 * routes ask; none of them re-implements the comparison.
 *
 * ## Why `undefined` means "article"
 *
 * Every post written before Pages existed has no `kind` at all, including every
 * row on the two production sites. The test is therefore `!== 'page'`, never
 * `=== 'post'`: an absent value keeps its historical meaning and no migration
 * has to touch live content to preserve behaviour.
 *
 * ## Why pages are excluded rather than included
 *
 * An "About" page is not an article. If it were merely *added* to the archive
 * and the feed, then creating one would silently push a dateless, authorless
 * entry into a subscriber's reader and to the top of a blog listing. Excluding
 * is also the change that is byte-identical for anyone with no pages yet, which
 * is what makes it safe to deploy to a running site.
 */
import type { Post } from '../core/models';

/** The stored discriminator. Kept as a constant so no route spells it inline. */
export const PAGE_KIND = 'page' as const;

/** Just enough of a Post to classify one — so callers can pass partials. */
type Kinded = Pick<Post, 'kind'>;

/** A standalone page ("About", "Contact"), routed at the site root. */
export const isPage = (post: Kinded): boolean => post.kind === PAGE_KIND;

/**
 * A dated blog entry. Anything without an explicit `kind` counts, which is what
 * keeps every pre-existing row an article.
 */
export const isArticle = (post: Kinded): boolean => post.kind !== PAGE_KIND;

/** Blog entries only — the archive, the permalink, the feed, the API default. */
export const articlesOnly = <T extends Kinded>(posts: readonly T[]): T[] =>
  posts.filter(isArticle);

/** Pages only — the sitemap's root-path section and the catch-all route. */
export const pagesOnly = <T extends Kinded>(posts: readonly T[]): T[] =>
  posts.filter(isPage);
