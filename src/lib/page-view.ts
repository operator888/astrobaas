/**
 * Rendering a CMS Page, in one place.
 *
 * Two routes render a Page: the root catch-all (`/[...slug]`) and the homepage
 * (`/`, when `home_page_slug` names one). They must agree on all of it — the
 * filter order, the sanitizer, the canonical URL, the JSON-LD — because a
 * disagreement is invisible: the page still renders, just with a different
 * canonical or an unfiltered body on one of the two URLs.
 *
 * The presentation deliberately stays in the `.astro` files. Only the derivation
 * lives here, which is the part worth testing and the part that has to match.
 *
 * `content` is the stored source of truth. What this returns is derived on every
 * request and never written back — the same rule the rest of the codebase
 * follows, and the one whose violation caused the data-loss bug.
 */
import type { Post } from '../core/models';
import { LocalDB } from './localdb';
import { type TocItem } from './toc';
// The content pipeline lives in content-render.ts, shared with the two API
// routes that render the same bodies. It used to live here, which is how the
// API routes came to run a shorter version of it.
import { renderContentHtml, withImageDimensions } from './content-render';
import { resolveSiteUrl } from './site-url';
import { trailForPage, breadcrumbListJsonLd, type BreadcrumbItem } from './breadcrumbs';
import { webPageNode, structuredData } from './structured-data';
import { localePath, recordLocale } from './i18n';

export interface PageViewContext {
  /** `Astro.site` — the build-time configured origin, if any. */
  astroSite?: URL | undefined;
  /** `Astro.url` — used as the last-resort origin for a self-hoster. */
  requestUrl: URL;
  /**
   * The homepage's canonical URL is the origin itself, not `/{slug}`. Serving
   * the same content at `/` and `/{slug}` with two different canonicals would
   * split its ranking between them.
   */
  canonicalPath?: string;
  /**
   * True when this Page is serving as the site's front door. The front door
   * has no ancestry, so it gets an empty trail rather than a lone "Home"
   * crumb pointing at the page you are already on.
   */
  isHome?: boolean;
  /** Public content locale (`Astro.locals.locale`), for crumb labels. */
  locale?: string;
}

export interface PageView {
  title: string;
  description: string;
  /** Sanitized, filtered HTML ready for `set:html`. */
  bodyHtml: string;
  /** Absolute URL, or undefined when no origin can be resolved. */
  canonical: string | undefined;
  /**
   * The resolved site origin, exposed so callers that need to build OTHER
   * absolute URLs (hreflang alternates) do not resolve it a second time and
   * risk disagreeing with the canonical tag on the same page.
   */
  origin: string | null;
  /**
   * The breadcrumb trail, built here so the visible trail and the
   * BreadcrumbList in `jsonLd` are literally the same array.
   */
  trail: BreadcrumbItem[];
  /**
   * schema.org `@graph` (WebPage + BreadcrumbList) — pass through
   * `jsonForScript`, never `JSON.stringify`. Null when there is nothing to
   * say, so the caller can skip the element entirely.
   */
  jsonLd: Record<string, unknown> | null;
  /**
   * The headings in `bodyHtml`, each already carrying its anchor. Returned
   * rather than recomputed by the caller: a second pass would generate its own
   * ids and every link in the rendered list would be a guess at what the body
   * actually says.
   */
  toc: TocItem[];
}

export async function buildPageView(page: Post, ctx: PageViewContext): Promise<PageView> {
  // Filters first, then sanitize — never the reverse. A filter that returns
  // markup has to pass the sanitizer too, or a plugin becomes an XSS vector.
  // Hints added AFTER the sanitizer, never before — see the note in
  // lazyLoadContentImages. Sanitizing output that we then rewrite would reverse
  // the filters-then-sanitize order the line above exists to guarantee.
  // buildToc adds an `id` to every heading UNCONDITIONALLY — the anchors are
  // how a deep link works at all, and a reader who copies one out of the address
  // bar must get the same URL whether or not the operator wants a contents list.
  // Only the rendered ToC block is a setting.
  const toc = renderContentHtml(page);
  const bodyHtml = await withImageDimensions(toc.html);

  const settings = await LocalDB.getSettings();
  const map: Record<string, unknown> = {};
  for (const s of settings) map[s.key] = s.value;

  const origin = resolveSiteUrl({
    setting: map.site_url,
    astroSite: ctx.astroSite,
    requestUrl: ctx.requestUrl,
  });

  const title = page.meta_title?.trim() || page.title;
  const description = page.meta_description?.trim() || page.excerpt || '';
  const path = ctx.canonicalPath ?? `/${page.slug}`;
  // `resolveSiteUrl` returns null rather than inventing localhost, so an
  // unresolvable origin means no canonical tag at all — which is correct.
  // Emitting `http://localhost:4321/about` on a live site is worse than
  // emitting nothing.
  // Through localePath, so the canonical carries the /de/ prefix and AGREES with
  // the hreflang alternates this same page emits. Without it a German page
  // declared the English URL as its real address, which is the contradiction a
  // canonical exists to remove. Home in the default locale stays the bare
  // origin, which is what the smoke test pins and what a reader expects.
  //
  // The locale comes from the RECORD, not from `ctx.locale` (the URL the reader
  // used). The two differ whenever a locale prefix is served content that is not
  // in that language, and every install can reach that state:
  //
  //   * `/de/about` with no German translation of the About page renders the
  //     English one. Canonicalising to `/de/about` declared a second address for
  //     content that already lives at `/about` — one page competing with itself,
  //     which is the whole failure a canonical prevents.
  //   * `/blog/deutscher-post` — the unprefixed URL still serves the record,
  //     because the middleware only ever STRIPS a prefix. The sitemap has always
  //     listed that post at `/de/blog/deutscher-post` (it uses `recordLocale`),
  //     so the URL-derived canonical actively contradicted the sitemap entry.
  //
  // Taking it from the record makes canonical, sitemap, feed and hreflang all
  // name the same URL, because all four now derive it the same way.
  const localised = localePath(path, recordLocale(page));
  const canonical = origin ? `${origin}${localised === '/' ? '' : localised}` : undefined;

  // The trail is built here, not in the route, for the same reason the rest of
  // this view is: `/{slug}` and `/` (a designated home Page) both render
  // through this function, and anything computed twice eventually disagrees.
  const trail = ctx.isHome ? [] : trailForPage(page, { locale: ctx.locale });

  return {
    title,
    description,
    bodyHtml,
    toc: toc.items,
    canonical,
    origin,
    trail,
    // A @graph rather than a lone node, so the breadcrumb travels with the
    // page description instead of needing a second <script> that could never
    // reference it. structuredData drops the nulls.
    jsonLd: structuredData([
      // `localised`, not `path` — the same string the canonical two lines above
      // is built from. Handing the raw `path` here made a localized Page
      // advertise its UNPREFIXED twin as the WebPage `url`, while its own
      // canonical said the prefixed one; both are live 200s serving the same
      // content, so the document contradicted itself.
      //
      // The home case is preserved deliberately: for the default locale
      // `localised` is '/', which the canonical strips to a bare origin, and
      // tests/smoke.mjs pins that. Passing '/' keeps the WebPage url at
      // origin + '/' exactly as before rather than quietly changing it.
      webPageNode({ title: page.title, description, path: localised, dateModified: page.updated_at }, { origin }),
      breadcrumbListJsonLd(trail, origin),
    ]),
  };
}
