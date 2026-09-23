/**
 * Theme slots — the template override contract.
 *
 * A theme used to be design tokens only (colors + fonts + custom CSS), which
 * meant it could restyle the site but never change its markup. Slots close that
 * gap: a theme may replace any subset of a FIXED set of components, and anything
 * it doesn't override falls back to the built-in default. That keeps every theme
 * forward-compatible — adding a new slot later cannot break existing themes,
 * because a theme that doesn't know about it simply inherits the default.
 *
 * Themes are BUILD-TIME modules, like code plugins: Astro bundles the server, so
 * overrides are explicit imports in `src/themes/<id>/`, not runtime discovery.
 * (The runtime-installable tier is declarative plugin manifests — see
 * src/core/manifest.ts. Markup cannot be installed at runtime by design.)
 *
 * Slots deliberately do NOT include page-level layouts or routes in v1: a theme
 * presents existing content, it does not add routes or change the app's
 * information architecture. See THEME_DEVELOPMENT.md.
 *
 * @alpha
 */
import type { Post } from './models';
import type { LocaleOption } from '../lib/locale-links';
import type { TocItem } from '../lib/toc';
// Re-exported so a theme typing its TableOfContents override can name the
// item type from 'astrobaas/core' without reaching into lib/.
export type { TocItem };

/** Every overridable slot. Adding one here is additive — themes inherit defaults. */
export const THEME_SLOTS = [
  'Header', 'Footer', 'PostCard', 'PostArticle', 'Sidebar',
  // v2 — the two views that kept every theme looking half-applied: the stock
  // home page and the CMS Page view. With these, activating a theme changes
  // the front door and every subpage, not just the blog.
  'Home', 'PageArticle',
  // v3 — the trail. Its data is computed server-side by the route (a slot must
  // never fetch), and the SAME trail feeds the BreadcrumbList structured data,
  // so what a reader sees and what a crawler is told cannot drift apart.
  'Breadcrumbs',
  // v4 — the contents list. A slot because where a ToC belongs is a design
  // decision: the default puts it above the article, a magazine theme would put
  // it in the sidebar, and an editorial one might not want it at all. Its ITEMS
  // are computed by the content pipeline, not here, so the anchors it links to
  // and the ids in the body are the same list rather than two guesses at it.
  'TableOfContents',
] as const;

export type ThemeSlotName = (typeof THEME_SLOTS)[number];

/* ---------- slot prop contracts ---------- */

export interface HeaderProps {
  siteTitle?: string;
  /** Locale of the current request (for language switchers / links). */
  locale?: string;
  /**
   * Language-switcher entries for THIS page, when the route knows them.
   *
   * Only a record route can build these: switching language on an article has
   * to land on that article's translation, and the translation has its own
   * slug. Left undefined, the switcher assumes a static route — correct for
   * `/blog`, `/about` and the home page, whose one template serves every
   * language at the same path.
   */
  localeOptions?: LocaleOption[];
}

export interface FooterProps {
  siteTitle?: string;
  /**
   * The links the operator has set, from the `social_*` settings. A theme
   * renders the ones it wants; every key here is populated by site.ts, and
   * tests/theme-slots.test.mjs refuses a theme that reads one that is not.
   */
  social?: {
    twitter?: string;
    github?: string;
    linkedin?: string;
    facebook?: string;
    instagram?: string;
    youtube?: string;
  };
  locale?: string;
}

/** A post prepared for listing display (the fields a card actually needs). */
export interface PostCardData extends Post {
  /** Resolved author name (not the id). */
  author: string;
  /** Resolved category name (not the id). */
  category: string;
  /** Featured image, already defaulted to a placeholder. */
  image: string;
  /** ISO date (yyyy-mm-dd) of publication. */
  date: string;
  /** Estimated read time in minutes. */
  readTime: number;
}

export interface PostCardProps {
  post: PostCardData;
}

/** The single-post view. `contentHtml` is ALREADY sanitized — render with set:html. */
export interface PostArticleProps {
  post: Post;
  /** Sanitized post body. Never re-sanitize; never wrap in additional escaping. */
  contentHtml: string;
  author: string;
  category: string;
  date: string;
  readTime: number;
}

export interface SidebarProps {
  /** Where the sidebar is rendered, so a theme can vary it per context. */
  /**
   * Which kind of view the sidebar is rendering beside. `'page'` joined the
   * union with CMS-authored Pages — a theme may reasonably want no sidebar on
   * an About page while keeping one on an article.
   */
  context: 'archive' | 'post' | 'page' | 'home';
  locale?: string;
}

/**
 * The STOCK home page — rendered only while no CMS Page is designated as the
 * front door (`home_page_slug`). A theme replacing it owns the whole first
 * screen: hero, latest posts, whatever its identity calls for.
 */
export interface HomeProps {
  siteTitle?: string;
  siteTagline?: string;
  /** Recent published posts, newest first, prepared like PostCardData. */
  posts: PostCardData[];
  locale?: string;
}

/**
 * A CMS Page (`kind: 'page'`), at `/{slug}` — and at `/` when designated the
 * home page. Distinct from PostArticle deliberately: a Page has no byline, no
 * date, no category, and a theme usually wants them typeset differently.
 */
export interface PageArticleProps {
  post: Post;
  /** Sanitized page body. Never re-sanitize; render with set:html. */
  contentHtml: string;
  /** True when this Page is being served as the site's front door at `/`. */
  isHome: boolean;
}

/**
 * One step of a breadcrumb trail.
 *
 * `href` is absent on the last item: the page you are on is not a link to
 * itself, and screen readers announce it through `aria-current` instead.
 */
export interface BreadcrumbItem {
  name: string;
  /** Site-relative path (`/blog`), never absolute — locale prefixing is the router's job. */
  href?: string;
}

/**
 * The trail for the current page, computed by the route.
 *
 * A trail of fewer than two items is not a trail; the default implementation
 * renders nothing rather than a lone "Home", and every override should do the
 * same. Routes that have no meaningful ancestry (the front door) pass `[]`.
 */
export interface BreadcrumbsProps {
  items: BreadcrumbItem[];
  /**
   * Public content locale. Every other chrome slot receives it; without it a
   * theme cannot translate the landmark label, and a German page announced its
   * breadcrumb navigation with the English word — the one slot in the contract
   * that could not be fixed by a theme.
   */
  locale?: string;
}

export interface TableOfContentsProps {
  /** Headings of the article being read, each already carrying its anchor. */
  items: TocItem[];
  /** Localized heading for the block. */
  label?: string;
  class?: string;
}

/** Maps slot name → its props type, for authors and for the resolver's typing. */
export interface ThemeSlotProps {
  Header: HeaderProps;
  Footer: FooterProps;
  PostCard: PostCardProps;
  PostArticle: PostArticleProps;
  Sidebar: SidebarProps;
  Home: HomeProps;
  PageArticle: PageArticleProps;
  Breadcrumbs: BreadcrumbsProps;
  TableOfContents: TableOfContentsProps;
}

/**
 * A theme's component overrides. Every slot is optional; omitted slots use the
 * built-in default. Values are Astro components — typed loosely here because
 * `.astro` modules have no public component type to import.
 */
export type ThemeComponents = Partial<Record<ThemeSlotName, unknown>>;

/** True when `name` is a real slot (guards untrusted/stale input). */
export function isThemeSlot(name: unknown): name is ThemeSlotName {
  return typeof name === 'string' && (THEME_SLOTS as readonly string[]).includes(name);
}

/** Which slots a theme actually overrides — used by the admin UI and tests. */
export function overriddenSlots(components: ThemeComponents | undefined): ThemeSlotName[] {
  if (!components) return [];
  return THEME_SLOTS.filter((s) => components[s] != null);
}
