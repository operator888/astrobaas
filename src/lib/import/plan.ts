/**
 * Turning a parsed WordPress export into a plan of what to do.
 *
 * Kept apart from both the parser and the writer, and PURE, for one reason:
 * this is where every judgement call lives — which items become posts, which
 * become pages, what a WordPress status means here, what the old permalink
 * was and therefore what redirect it needs. Those decisions are the ones an
 * operator will argue with, and a decision you cannot unit-test is a decision
 * nobody has reviewed.
 *
 * The writer takes this plan and performs it. Nothing here touches a database,
 * the network, or the clock.
 */
import type { WxrDocument } from './wxr';

/** How an imported record will be created. */
export interface PlannedPost {
  wpId: string;
  title: string;
  slug: string;
  content: string;
  excerpt?: string;
  kind: 'post' | 'page';
  status: 'draft' | 'published' | 'review' | 'scheduled';
  publishedAt?: string;
  authorLogin?: string;
  categorySlug?: string;
  /**
   * The category's DISPLAY name from the export.
   *
   * Carried separately from the slug because the two are not recoverable from
   * each other: WordPress's `frames` nicename says nothing about the shop
   * having called it "Frames & Lenses", and un-slugifying would produce
   * "Frames" — a rename nobody asked for, applied to every category on the
   * site, discovered by the operator in their own navigation.
   */
  categoryName?: string;
  tags: string[];
  /** wpId of the attachment WordPress used as the featured image. */
  thumbnailWpId?: string;
  /** The URL this content used to live at, if the export said. */
  originalUrl?: string;
}

/** A file to fetch from the old site. */
export interface PlannedMedia {
  wpId: string;
  url: string;
  title?: string;
}

/** One legacy URL that must keep working. */
export interface PlannedRedirect {
  /** Path on the OLD site, e.g. `/2024/03/how-to-choose-a-frame/`. */
  from: string;
  /** Path on this site. */
  to: string;
}

/** An item the import will not create, and the reason a human can act on. */
export interface SkippedItem {
  wpId: string;
  title: string;
  type: string;
  reason: string;
}

export interface ImportPlan {
  posts: PlannedPost[];
  media: PlannedMedia[];
  redirects: PlannedRedirect[];
  skipped: SkippedItem[];
  authors: { login: string; email?: string; displayName?: string }[];
  siteUrl?: string;
}

export interface PlanOptions {
  /** Bring pages across as well as posts. Default true. */
  includePages?: boolean;
  /** Fetch the media library. Default true. */
  includeMedia?: boolean;
  /**
   * Import content WordPress had in the bin. Default false — restoring
   * somebody's deleted drafts onto a new public site is not a migration, it is
   * a surprise.
   */
  includeTrash?: boolean;
  /** Custom post types to bring in as posts, e.g. `['portfolio']`. */
  extraTypes?: string[];
}

/** Slugify the way the rest of the CMS does, so an imported slug is a normal slug. */
export function slugifyImported(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/**
 * WordPress statuses, mapped to this CMS's.
 *
 * `private` becomes a DRAFT rather than published: WordPress means "visible to
 * logged-in roles", this CMS has no such state for content, and publishing it
 * would put a deliberately non-public page on the open web during a migration
 * — the one moment nobody is watching the front page.
 *
 * `future` (scheduled) keeps its date and lets the scheduler publish it.
 */
export function mapStatus(wpStatus: string): PlannedPost['status'] {
  switch (wpStatus) {
    case 'publish': return 'published';
    case 'pending': return 'review';
    case 'future': return 'scheduled';
    case 'private':
    case 'draft':
    default: return 'draft';
  }
}

/**
 * The path part of an old permalink.
 *
 * Redirects match on the PATH — a query string is never part of the match,
 * because the whole problem is `srsltid` and `gclid` arriving on dead URLs.
 * Returns null for anything that is not a usable path, so a malformed `link`
 * in the export cannot produce a redirect rule that matches everything.
 */
export function permalinkPath(link: string | undefined): string | null {
  if (!link) return null;
  let path: string;
  try {
    path = new URL(link).pathname;
  } catch {
    // Some exports carry a bare path rather than a full URL.
    path = link.split('?')[0].split('#')[0];
  }
  if (!path.startsWith('/')) return null;
  // `//host/path` is a network-path reference, not a path: new URL() throws on
  // it (no base), so it reaches here through the catch branch, and it would
  // become a redirect rule no same-site request can ever match.
  if (path.startsWith('//')) return null;
  if (path === '/') return null;
  // A wildcard in a legacy path would become a rule that swallows the site.
  if (path.includes('*')) return null;
  return path.replace(/\/+$/, '') || null;
}

/**
 * Decide what an export becomes on this install.
 *
 * Every item is either planned or SKIPPED WITH A REASON. An importer that
 * silently drops things is one an operator cannot trust, and "23 of 240 posts
 * are missing" is a support case that starts weeks later with no evidence.
 */
export function planImport(doc: WxrDocument, opts: PlanOptions = {}): ImportPlan {
  const includePages = opts.includePages !== false;
  const includeMedia = opts.includeMedia !== false;
  const includeTrash = opts.includeTrash === true;
  const extraTypes = new Set(opts.extraTypes ?? []);

  const posts: PlannedPost[] = [];
  const media: PlannedMedia[] = [];
  const redirects: PlannedRedirect[] = [];
  const skipped: SkippedItem[] = [];
  const usedSlugs = new Set<string>();

  for (const item of doc.items) {
    const label = { wpId: item.wpId, title: item.title || '(untitled)', type: item.type };

    if (item.type === 'attachment') {
      if (!includeMedia) {
        skipped.push({ ...label, reason: 'media import was turned off' });
      } else if (!item.attachmentUrl) {
        skipped.push({ ...label, reason: 'the export carries no file URL for this attachment' });
      } else {
        media.push({
          wpId: item.wpId,
          url: item.attachmentUrl,
          ...(item.title ? { title: item.title } : {}),
        });
      }
      continue;
    }

    const isPage = item.type === 'page';
    const known = item.type === 'post' || isPage || extraTypes.has(item.type);
    if (!known) {
      skipped.push({ ...label, reason: `custom post type "${item.type}" — pass it in extraTypes to import it as a post` });
      continue;
    }
    if (isPage && !includePages) {
      skipped.push({ ...label, reason: 'page import was turned off' });
      continue;
    }
    if (item.status === 'trash' && !includeTrash) {
      skipped.push({ ...label, reason: 'it was in the WordPress bin' });
      continue;
    }
    if (item.status === 'auto-draft') {
      skipped.push({ ...label, reason: 'it was an empty auto-draft WordPress created and never used' });
      continue;
    }

    const title = item.title || '(untitled)';
    const base = slugifyImported(item.slug || title) || `imported-${item.wpId || posts.length + 1}`;
    // Uniqueness WITHIN the plan. The writer resolves collisions against what
    // is already in the database; this only stops one export from colliding
    // with itself, which it does whenever two posts shared a title.
    let slug = base;
    for (let n = 2; usedSlugs.has(slug); n += 1) slug = `${base.slice(0, 74)}-${n}`;
    usedSlugs.add(slug);

    const originalPath = permalinkPath(item.link);
    const newPath = isPage ? `/${slug}` : `/blog/${slug}`;

    posts.push({
      wpId: item.wpId,
      title,
      slug,
      content: item.content,
      ...(item.excerpt ? { excerpt: item.excerpt } : {}),
      kind: isPage ? 'page' : 'post',
      status: mapStatus(item.status),
      ...(item.publishedAt ? { publishedAt: item.publishedAt } : {}),
      ...(item.authorLogin ? { authorLogin: item.authorLogin } : {}),
      ...(item.categories[0]
        ? {
            categorySlug: slugifyImported(item.categories[0].slug),
            ...(item.categories[0].name ? { categoryName: item.categories[0].name } : {}),
          }
        : {}),
      tags: item.tags,
      ...(item.thumbnailId ? { thumbnailWpId: item.thumbnailId } : {}),
      ...(originalPath ? { originalUrl: originalPath } : {}),
    });

    // A redirect only when the URL actually MOVED. WordPress's default
    // permalink is /YYYY/MM/slug/ and this CMS serves /blog/slug, so most
    // posts move; a page usually does not, and a rule from a path to itself
    // is a redirect loop.
    if (originalPath && originalPath !== newPath) {
      redirects.push({ from: originalPath, to: newPath });
    }
  }

  // Categories are created from what the posts reference; nothing is needed
  // here beyond the slug the post carries.
  return {
    posts,
    media,
    redirects,
    skipped,
    authors: doc.authors,
    ...(doc.siteUrl ? { siteUrl: doc.siteUrl } : {}),
  };
}

/** Human-readable one-liner for a CLI or an admin screen. */
export function summarisePlan(plan: ImportPlan): string {
  const pages = plan.posts.filter((p) => p.kind === 'page').length;
  const articles = plan.posts.length - pages;
  return `${articles} post(s), ${pages} page(s), ${plan.media.length} media file(s), `
    + `${plan.redirects.length} redirect(s), ${plan.skipped.length} skipped`;
}
