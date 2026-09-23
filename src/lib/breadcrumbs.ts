/**
 * Breadcrumb trails — computed once, rendered twice.
 *
 * A breadcrumb is two things at the same time: a row of links a reader
 * follows, and a `BreadcrumbList` a crawler reads. Sites get this wrong by
 * building them separately, and then the visible trail says one thing while
 * the structured data says another — which is worse than having neither,
 * because Google treats a mismatch as a reason to distrust the whole page.
 *
 * So the trail is derived HERE, once per request, from data the route already
 * has. The `Breadcrumbs` theme slot renders it; `breadcrumbListJsonLd()` turns
 * the same array into the schema.org node. Neither can drift from the other
 * because neither owns the data.
 *
 * Pure module: no database, no Astro. Routes pass in what they loaded.
 */
import type { BreadcrumbItem } from '../core/theme-slots';
import { absoluteUrl } from './site-url';
import { localePath } from './i18n';

export type { BreadcrumbItem };

/**
 * The root crumb's label.
 *
 * Deliberately NOT the site title: a trail reading "Example Optics › Blog ›
 * Post" repeats a name already in the masthead and the tab, and pushes the
 * useful crumbs out of the visible row on a phone. "Home" is what the
 * position means.
 */
const HOME_LABELS: Record<string, string> = {
  en: 'Home',
  el: 'Αρχική',
  de: 'Startseite',
};

const BLOG_LABELS: Record<string, string> = {
  en: 'Blog',
  el: 'Ιστολόγιο',
  de: 'Blog',
};

/**
 * Public content language, not the admin UI language.
 *
 * `Astro.locals.t` translates the ADMIN chrome from the staff member's
 * preference — using it here would show a Greek visitor English crumbs
 * because an English-speaking admin was logged in. The public language comes
 * from the URL, which is what `locals.locale` carries.
 */
function label(table: Record<string, string>, locale: string | undefined): string {
  const key = (locale ?? 'en').split('-')[0].toLowerCase();
  return table[key] ?? table.en;
}

/**
 * The accessible name of the breadcrumb landmark, in the reader's language.
 *
 * The trail's crumbs were localized from the start while the landmark stayed
 * English, so a German page announced its navigation with an English word
 * read in German phonemes. Exported so every theme override gets it right by
 * using it rather than by remembering to translate a string.
 */
const LANDMARK_LABELS: Record<string, string> = {
  en: 'Breadcrumb',
  el: 'Διαδρομή πλοήγησης',
  de: 'Brotkrümelnavigation',
};

export function breadcrumbLabel(locale: string | undefined): string {
  return label(LANDMARK_LABELS, locale);
}

export interface TrailContext {
  /** Public content locale from the URL (`locals.locale`). */
  locale?: string;
}

/**
 * Every crumb href, in the language the reader is actually browsing.
 *
 * The labels were localized from the start; the hrefs were not, so a German
 * trail read "Startseite › Blog" and both links dropped the reader onto the
 * ENGLISH site. The default locale is never prefixed, so single-locale
 * installs are byte-identical — the same rule hreflang follows, from the same
 * helper.
 */
function href(path: string, locale: string | undefined): string {
  return localePath(path, locale);
}

/** Trail for a blog post: Home › Blog › [Category] › Title. */
export function trailForPost(
  post: { title: string },
  opts: TrailContext & { categoryName?: string; categorySlug?: string } = {},
): BreadcrumbItem[] {
  const items: BreadcrumbItem[] = [
    { name: label(HOME_LABELS, opts.locale), href: href('/', opts.locale) },
    { name: label(BLOG_LABELS, opts.locale), href: href('/blog', opts.locale) },
  ];
  // Categories have no route of their own — the archive filters by query
  // string — so the crumb links where the reader can actually go.
  if (opts.categoryName && opts.categorySlug) {
    items.push({
      name: opts.categoryName,
      href: `${href('/blog', opts.locale)}?category=${encodeURIComponent(opts.categorySlug)}`,
    });
  }
  items.push({ name: post.title });
  return items;
}

/** Trail for the blog archive: Home › Blog, plus the active category filter. */
export function trailForArchive(
  opts: TrailContext & { categoryName?: string } = {},
): BreadcrumbItem[] {
  const items: BreadcrumbItem[] = [
    { name: label(HOME_LABELS, opts.locale), href: href('/', opts.locale) },
  ];
  if (opts.categoryName) {
    items.push({ name: label(BLOG_LABELS, opts.locale), href: href('/blog', opts.locale) });
    items.push({ name: opts.categoryName });
  } else {
    items.push({ name: label(BLOG_LABELS, opts.locale) });
  }
  return items;
}

/**
 * Trail for a CMS Page: Home › Title.
 *
 * Flat by necessity — a Post carries no parent, so there is no hierarchy to
 * walk. Inventing one from slug segments would be a guess presented as a fact.
 */
export function trailForPage(
  page: { title: string },
  opts: TrailContext = {},
): BreadcrumbItem[] {
  return [
    { name: label(HOME_LABELS, opts.locale), href: href('/', opts.locale) },
    { name: page.title },
  ];
}

/**
 * The same trail as a schema.org `BreadcrumbList`.
 *
 * `item` is included only when an absolute origin is known: `resolveSiteUrl()`
 * returns null rather than inventing one, and a BreadcrumbList naming
 * `http://localhost:4321/blog` on a live site is worse than one naming
 * nothing. The final crumb never carries `item` — it is the current page, and
 * Google's own guidance is to omit it.
 *
 * Returns null for a trail too short to be one, so a caller can spread it away.
 */
export function breadcrumbListJsonLd(
  items: BreadcrumbItem[],
  origin: string | null | undefined,
): Record<string, unknown> | null {
  if (items.length < 2) return null;
  return {
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: item.name,
      ...(item.href && origin ? { item: absoluteUrl(item.href, origin) } : {}),
    })),
  };
}
