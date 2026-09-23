/**
 * Who a post is attributed to, and the link behind their name.
 *
 * ## The bug this replaces
 *
 * Three surfaces resolved the author as
 * `users.find(u => u.id === post.author_id)?.name || 'Unknown Author'`.
 *
 * That fallback fires whenever the id does not resolve — a user who was
 * deleted, a post imported from WordPress, a row restored from a backup taken
 * before the account existed. None of those mean "unknown": the site owner knows
 * perfectly well who publishes their site. "Unknown Author" on a real business
 * page reads as broken software, and it is the first thing a visitor sees.
 *
 * ## What replaces it
 *
 * A cascade, each step true when it is reached:
 *
 *  1. the post's actual author, when the id resolves;
 *  2. the site's configured author (`site_author_name`) — who publishes here
 *     when nothing more specific is known;
 *  3. the site title, which is always set and is a truthful attribution for a
 *     one-person site.
 *
 * There is no step that says "unknown", because at least one of the above is
 * always available.
 *
 * ## Why it is settings-driven rather than hardcoded
 *
 * This ships to everyone. Baking a name into the source would put one person's
 * identity on every install of an open-source CMS. `site_author_name` and
 * `site_author_url` default to empty; an operator fills them in once and their
 * own name appears, linked, on every byline.
 */
import type { Post, User } from '../core/models';

export interface Byline {
  /** Display name. Never empty, never "Unknown Author". */
  name: string;
  /**
   * Absolute URL for the name, or undefined.
   *
   * Only ever the SITE author's URL. A per-user profile URL does not exist as a
   * field, and inventing one from a user record would link somewhere that is
   * not theirs.
   */
  url?: string;
  /** True when this is the configured site author rather than a real account. */
  isSiteAuthor: boolean;
}

export interface BylineContext {
  /** `site_author_name` — who publishes here. */
  siteAuthorName?: string;
  /** `site_author_url` — https, shown as a link on the name. */
  siteAuthorUrl?: string;
  /** Last-resort attribution; always set. */
  siteTitle: string;
}

/** Only http(s). A stored `javascript:` would land in an `href`. */
const safeUrl = (v: string | undefined): string | undefined => {
  const s = (v ?? '').trim();
  if (!s) return undefined;
  return /^https?:\/\//i.test(s) ? s : undefined;
};

export function resolveByline(
  post: Pick<Post, 'author_id'>,
  users: readonly Pick<User, 'id' | 'name'>[],
  ctx: BylineContext,
): Byline {
  const account = users.find((u) => u.id === post.author_id);
  const accountName = (account?.name ?? '').trim();
  if (accountName) return { name: accountName, isSiteAuthor: false };

  const siteAuthor = (ctx.siteAuthorName ?? '').trim();
  if (siteAuthor) {
    return { name: siteAuthor, url: safeUrl(ctx.siteAuthorUrl), isSiteAuthor: true };
  }

  // The site title is always set (it has a default), so the cascade cannot run
  // out — which is the whole point.
  return {
    name: ctx.siteTitle,
    url: safeUrl(ctx.siteAuthorUrl),
    isSiteAuthor: true,
  };
}

/**
 * The site-wide credit line, for a footer or an about box.
 *
 * Returns null when nothing is configured, so a fresh install renders no empty
 * "Built by" with a dangling link.
 */
export function siteCredit(ctx: BylineContext): { name: string; url?: string } | null {
  const name = (ctx.siteAuthorName ?? '').trim();
  if (!name) return null;
  return { name, url: safeUrl(ctx.siteAuthorUrl) };
}
