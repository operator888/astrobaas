/**
 * Broken link checking (C-14).
 *
 * ## Two halves with very different risk
 *
 * **Internal links are resolved, not fetched.** A link to `/blog/my-post` is
 * checked by looking the slug up in the database. That is instant, exact, and
 * cannot produce a false positive — and it catches the failure that actually
 * happens: an editor renames a slug and every link to it dies silently, because
 * a 404 on an internal link looks exactly like a 404 on a URL nobody ever had.
 *
 * HTTP-fetching our own origin to answer a question the database already answers
 * would be slower, would need the server to be able to reach itself (which is
 * not true behind every proxy), and would turn a report into a load test.
 *
 * **External links are fetched**, which is a different kind of thing entirely:
 * network access to attacker-influenceable URLs, third-party rate limits, and
 * bot protection that answers 403 to anything without a browser. That half is in
 * `sweepExternalLinks` below, is off by default, and is deliberately cautious
 * about calling anything broken.
 *
 * ## What "internal" means here
 *
 * Not "starts with a slash". A link to `https://this-shop.gr/blog/x` written by
 * an author who copied it from their address bar is internal too, and is the
 * form most likely to break, because it survives being pasted into another CMS.
 * So the site's own origin is compared, when we know it.
 */
import type { Post } from '../core/models';
import { plainText } from './html-text';
import { splitLocaleFromPath } from './i18n';

/** One link found in content. */
export interface FoundLink {
  /** The href exactly as written. */
  href: string;
  /** Visible text, tags stripped — so a report can say WHICH link. */
  text: string;
  /** Path with query and fragment removed, for internal resolution. */
  path?: string;
  kind: 'internal' | 'external' | 'anchor' | 'mail' | 'tel' | 'other';
}

const A_TAG = /<a\b[^>]*>([\s\S]*?)<\/a\s*>/gi;
const HREF = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i;

/**
 * Classify one href.
 *
 * `origin` is the site's own absolute origin when known. Without it, absolute
 * URLs are all treated as external — which is the safe direction: reporting a
 * live external link as unchecked is harmless, while reporting the site's own
 * page as broken because we could not tell it was ours is not.
 */
export function classifyHref(href: string, origin?: string | null): FoundLink {
  const raw = (href ?? '').trim();
  const base: FoundLink = { href: raw, text: '', kind: 'other' };
  if (!raw) return base;

  if (raw.startsWith('#')) return { ...base, kind: 'anchor' };
  if (/^mailto:/i.test(raw)) return { ...base, kind: 'mail' };
  if (/^tel:/i.test(raw)) return { ...base, kind: 'tel' };
  // Anything with a scheme we do not handle — javascript:, data:, ftp: — is
  // "other" rather than external. The sanitizer strips the dangerous ones on
  // write; this classification exists so the report does not try to FETCH them.
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^https?:/i.test(raw)) {
    return { ...base, kind: 'other' };
  }

  if (/^https?:\/\//i.test(raw)) {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return { ...base, kind: 'other' };
    }
    if (origin) {
      try {
        // Compare ORIGINS, not string prefixes: `https://shop.gr` and
        // `https://shop.gr:443` are the same origin, and a prefix match would
        // also call `https://shop.gr.evil.test` internal.
        if (new URL(origin).origin === u.origin) {
          return { ...base, kind: 'internal', path: u.pathname };
        }
      } catch { /* unusable configured origin — treat as external */ }
    }
    return { ...base, kind: 'external' };
  }

  if (raw.startsWith('//')) return { ...base, kind: 'external' };
  if (raw.startsWith('/')) {
    return { ...base, kind: 'internal', path: raw.split('#')[0].split('?')[0] };
  }
  // A relative link. Rare in CMS content and genuinely ambiguous — it resolves
  // against whichever page it happens to be rendered on, which for a post that
  // also appears in a feed is more than one place. Reported as 'other' rather
  // than guessed at.
  return { ...base, kind: 'other' };
}

/** Every link in one piece of content. */
export function extractLinks(html: string, origin?: string | null): FoundLink[] {
  if (!html || !html.includes('<a')) return [];
  const out: FoundLink[] = [];
  for (const m of html.matchAll(A_TAG)) {
    const attrs = m[0].slice(0, m[0].indexOf('>'));
    const h = HREF.exec(attrs);
    if (!h) continue;
    const link = classifyHref(h[1] ?? h[2] ?? '', origin);
    link.text = plainText(m[1] ?? '');
    out.push(link);
  }
  return out;
}

/** What an internal path can resolve to. */
/**
 * Bare URLs written in FREE TEXT — a textarea, not markup.
 *
 * `extractLinks` above parses `<a href>` and therefore sees nothing in a
 * contact message or a comment body, which is exactly where the URL count
 * matters: a submission carrying four links is the single most reliable
 * cheap spam signal there is.
 *
 * Lives here rather than in the spam scorer because two callers want the same
 * count for the same reason — the form scorer and the comment scorer — and a
 * copy inside one of them is a copy the other would eventually re-spell.
 *
 * Deliberately generous about what counts: `www.` with no scheme and a bare
 * `example.gr/path` are both links to a reader, and a scorer that only saw
 * `https://` would miss the spelling spammers actually use.
 */
export function extractUrlsFromText(text: unknown): string[] {
  const s = typeof text === 'string' ? text : '';
  if (!s) return [];
  const out: string[] = [];
  const re = /\b(?:https?:\/\/|www\.)[^\s<>"')\]]+|\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)+\/[^\s<>"')\]]*/gi;
  for (const m of s.match(re) ?? []) {
    const cleaned = m.replace(/[.,;:!?]+$/, '');
    if (cleaned && !out.includes(cleaned)) out.push(cleaned);
  }
  return out;
}

export interface InternalTargets {
  /** Published article slugs — reachable at `/blog/<slug>`. */
  articleSlugs: ReadonlySet<string>;
  /** Published page slugs — reachable at `/<slug>`. */
  pageSlugs: ReadonlySet<string>;
  /** First path segments served by a real route file: `blog`, `about`, `api`… */
  builtinRoutes: ReadonlySet<string>;
  /**
   * Does a redirect rule rescue this path? A redirected link is not broken.
   *
   * A PREDICATE, not a set of strings, so the caller passes the real matcher
   * (`matchRedirect`, which the middleware itself uses). Rules can be prefix or
   * wildcard patterns, so an exact-value set would miss most of them — and
   * every miss is a working link reported as broken, which is the one failure
   * this whole module is arranged to avoid.
   */
  redirected: (path: string) => boolean;
  /** Uploaded file paths, for `<a href="/uploads/x.pdf">`. */
  mediaPaths: ReadonlySet<string>;
}

/**
 * Does this internal path resolve to something?
 *
 * Deliberately GENEROUS. A false positive here sends an editor hunting for a
 * link that works, and after two of those nobody opens the report again — so
 * anything this function cannot confidently call broken, it calls fine.
 *
 * Concretely: any path under a built-in route prefix is assumed served, because
 * this module cannot know every route's parameter shape, and a redirect rule
 * covering the path makes it reachable whatever the target is.
 */
export function resolvesInternally(path: string, t: InternalTargets): boolean {
  const raw = (path || '/').split('#')[0].split('?')[0];
  if (raw === '' || raw === '/') return true;

  // A LOCALE PREFIX is not a path segment to resolve. `/de/blog/mein-post` is a
  // live URL on a multilingual install, and this branch made the whole site
  // emit those links — so an author copying one out of the address bar into a
  // post got it reported as broken, which is precisely the false positive the
  // rest of this module is arranged around.
  //
  // splitLocaleFromPath, not a local test: it already knows that only a
  // CONFIGURED, non-default locale counts (the default is served unprefixed,
  // so `/en/...` is not a route), and two answers to that question would
  // eventually disagree. It is also the reason a redirect rule is checked
  // against the ORIGINAL path first — a rule may well name the prefixed form.
  const p = t.redirected(raw) ? raw : splitLocaleFromPath(raw).rest;
  if (p === '' || p === '/') return true;

  const clean = p.replace(/\/+$/, '') || '/';
  if (clean === '/') return true;
  if (t.redirected(clean) || t.redirected(p)) return true;
  if (t.mediaPaths.has(clean) || t.mediaPaths.has(p)) return true;

  const segments = clean.replace(/^\//, '').split('/');
  const first = segments[0];

  if (first === 'blog') {
    // `/blog` itself, and `/blog/<slug>`.
    if (segments.length === 1) return true;
    if (segments.length === 2) return t.articleSlugs.has(segments[1]);
    // Deeper than the route serves — /blog/a/b is a 404.
    return false;
  }

  // A built-in route (or anything below it). Not enumerable from here — the
  // admin alone has dozens of sub-paths — so a prefix match is the honest
  // limit of what this check can assert.
  if (t.builtinRoutes.has(first)) return true;

  // Otherwise it must be a Page at `/<slug>`, which is one segment deep.
  if (segments.length === 1) return t.pageSlugs.has(first);
  return false;
}

/** One broken link, with enough context to fix it. */
export interface BrokenLink {
  /** The post it was found in. */
  postId: string;
  postTitle: string;
  postSlug: string;
  href: string;
  text: string;
  kind: FoundLink['kind'];
  /** Why it is reported. */
  reason: string;
}

export interface InternalScanOptions {
  origin?: string | null;
  targets: InternalTargets;
}

/**
 * Scan every published record for internal links that resolve to nothing.
 *
 * Only PUBLISHED records: a draft with a link to a page not written yet is work
 * in progress, not a defect, and reporting it teaches the author to ignore the
 * report.
 */
export function scanInternalLinks(
  posts: readonly Post[],
  opts: InternalScanOptions,
): BrokenLink[] {
  const out: BrokenLink[] = [];
  for (const post of posts) {
    if (post.status !== 'published') continue;
    for (const link of extractLinks(post.content ?? '', opts.origin)) {
      if (link.kind !== 'internal' || !link.path) continue;
      if (resolvesInternally(link.path, opts.targets)) continue;
      out.push({
        postId: post.id,
        postTitle: post.title || post.slug,
        postSlug: post.slug,
        href: link.href,
        text: link.text,
        kind: 'internal',
        reason: 'No page, post or redirect answers this path.',
      });
    }
  }
  // Stable order: same input, same report, whichever driver returned the rows.
  out.sort((a, b) =>
    a.postTitle.localeCompare(b.postTitle)
    || a.href.localeCompare(b.href)
    || a.postId.localeCompare(b.postId));
  return out;
}

/** Every distinct external URL in published content, with where it was found. */
export function collectExternalLinks(
  posts: readonly Post[],
  origin?: string | null,
): Map<string, { postId: string; postTitle: string; text: string }[]> {
  const out = new Map<string, { postId: string; postTitle: string; text: string }[]>();
  for (const post of posts) {
    if (post.status !== 'published') continue;
    for (const link of extractLinks(post.content ?? '', origin)) {
      if (link.kind !== 'external') continue;
      const list = out.get(link.href) ?? [];
      list.push({ postId: post.id, postTitle: post.title || post.slug, text: link.text });
      out.set(link.href, list);
    }
  }
  return out;
}
