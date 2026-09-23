/**
 * schema.org nodes, built in one place.
 *
 * Structured data was three hand-written object literals at three call sites,
 * which is how it usually goes wrong: the blog post carried a rich `@graph`,
 * a CMS Page carried a bare `WebPage`, the archive carried nothing, and the
 * home page carried nothing at all — no `Organization`, no `WebSite`. Every
 * fix had to be made three times, and one of them was always forgotten.
 *
 * These builders are PURE: routes pass in what they already loaded, and get
 * back plain objects to drop into a `@graph`. That makes them unit-testable
 * without a browser or a database, which matters because the failure mode of
 * structured data is silent — a malformed node does not break the page, it
 * just quietly stops earning the rich result it was written for.
 *
 * Two rules run through all of them:
 *
 *  - **Absolute URLs or none.** `resolveSiteUrl()` returns null rather than
 *    inventing an origin, so every `url`/`image`/`item` field is omitted when
 *    the origin is unknown. A live site advertising `http://localhost:4321`
 *    is the failure this codebase guards against everywhere else too.
 *  - **Media goes through the media base.** `/uploads/...` is served from the
 *    CMS's own address (`public_site_url`), which on a decoupled storefront is
 *    a DIFFERENT host from the site URL. String-concatenating the site origin
 *    onto an image path — as the blog page used to — produces a URL that 404s
 *    for the crawler, and double-prefixes an already-absolute imported image
 *    into nonsense.
 *
 * Escaping is NOT this module's job and must not be forgotten: everything here
 * is serialized into a `<script>` through `jsonForScript()`, which escapes the
 * `<` that would otherwise let a post title close the element.
 */
import { absoluteUrl } from './site-url';
import { absoluteMediaUrl } from './media-url';
import { mediaKindOf } from './product-fields';
import { moneyPlain, DEFAULT_CURRENCY } from './money-format';

/** What every builder needs to turn paths into absolute URLs. */
export interface SdContext {
  /** Site origin (`resolveSiteUrl`), or null when unknown. */
  origin: string | null;
  /** Media origin (`resolveMediaBase`) — often the same, not always. */
  mediaBase?: string | null;
  siteTitle?: string;
}

/** Absolute URL for a site path, or undefined when the origin is unknown. */
function url(path: string | undefined, origin: string | null): string | undefined {
  if (!path) return undefined;
  if (!origin) return undefined;
  return absoluteUrl(path, origin);
}

/**
 * Absolute URL for an uploaded image. Uses the MEDIA base, and leaves an
 * already-absolute URL alone — an image imported from an old shop keeps its
 * own host instead of being prefixed into a 404.
 */
function image(src: string | undefined, ctx: SdContext): string | undefined {
  if (!src) return undefined;
  const base = ctx.mediaBase ?? ctx.origin;
  if (!base) return /^https?:\/\//i.test(src) ? src : undefined;
  return absoluteMediaUrl(src, base) || undefined;
}

/**
 * The publisher, as an Organization.
 *
 * Emitted on the home page so every other node can reference it by `@id`
 * rather than repeating it — which is also what stops the site name and logo
 * from disagreeing between pages.
 */
export function organizationNode(ctx: SdContext & { logo?: string }): Record<string, unknown> | null {
  if (!ctx.siteTitle) return null;
  const home = url('/', ctx.origin);
  return {
    '@type': 'Organization',
    ...(home ? { '@id': `${home}#organization` } : {}),
    name: ctx.siteTitle,
    ...(home ? { url: home } : {}),
    ...(image(ctx.logo, ctx) ? { logo: image(ctx.logo, ctx) } : {}),
  };
}

/**
 * The person behind the site.
 *
 * Emitted on the home page beside the Organization, and referenced by `@id`
 * from every article's `author` — so an author is ONE entity with one identity
 * rather than a name repeated on each post that a search engine has to guess is
 * the same human.
 *
 * `sameAs` is the load-bearing part and the reason this node exists at all. A
 * name is not an identity: "Theodoros Dimitriou" resolves to nothing on its
 * own, and it is the LinkedIn, GitHub and company URLs that let a search engine
 * or an assistant connect the byline to a real person with a history. Without
 * them a Person node is decoration.
 *
 * Returns null when the operator has not named an author. An empty Person — a
 * node with `@type` and nothing to say — is worse than none: it asserts that an
 * entity exists and then declines to identify it.
 */
export function personNode(
  ctx: SdContext & {
    authorName?: string;
    authorUrl?: string;
    jobTitle?: string;
    /** Profile URLs — the whole point. */
    sameAs?: string[];
  },
): Record<string, unknown> | null {
  if (!ctx.authorName?.trim()) return null;
  const home = url('/', ctx.origin);
  const profiles = (ctx.sameAs ?? [])
    .map((u) => String(u ?? '').trim())
    // Absolute http(s) only. A relative path in `sameAs` is meaningless — the
    // field's entire purpose is to point OFF this site.
    .filter((u) => /^https?:\/\//i.test(u))
    .slice(0, 25);
  return {
    '@type': 'Person',
    ...(home ? { '@id': `${home}#person` } : {}),
    name: ctx.authorName.trim(),
    ...(ctx.authorUrl?.trim() ? { url: ctx.authorUrl.trim() } : {}),
    ...(ctx.jobTitle?.trim() ? { jobTitle: ctx.jobTitle.trim() } : {}),
    ...(ctx.siteTitle ? { worksFor: { '@id': `${home}#organization` } } : {}),
    ...(profiles.length ? { sameAs: profiles } : {}),
  };
}

/**
 * The site itself, as a WebSite.
 *
 * `potentialAction` advertises the on-site search so a search box can appear
 * under the result — and it is only claimed when the site ACTUALLY has one,
 * because promising a search endpoint that 404s is a penalty, not a feature.
 */
export function webSiteNode(
  ctx: SdContext & { tagline?: string; searchPath?: string },
): Record<string, unknown> | null {
  if (!ctx.siteTitle) return null;
  const home = url('/', ctx.origin);
  return {
    '@type': 'WebSite',
    ...(home ? { '@id': `${home}#website`, url: home } : {}),
    name: ctx.siteTitle,
    ...(ctx.tagline ? { description: ctx.tagline } : {}),
    ...(home ? { publisher: { '@id': `${home}#organization` } } : {}),
    ...(ctx.searchPath && home
      ? {
        potentialAction: {
          '@type': 'SearchAction',
          target: {
            '@type': 'EntryPoint',
            urlTemplate: `${home.replace(/\/$/, '')}${ctx.searchPath}{search_term_string}`,
          },
          'query-input': 'required name=search_term_string',
        },
      }
      : {}),
  };
}

export interface ArticleInput {
  title: string;
  description?: string;
  /** Site-relative path of the article. */
  path: string;
  datePublished?: string;
  dateModified?: string;
  authorName?: string;
  /** Uploaded image path or absolute URL. */
  image?: string;
  categoryName?: string;
}

/** A blog post, as a BlogPosting. */
export function articleNode(a: ArticleInput, ctx: SdContext): Record<string, unknown> {
  const canonical = url(a.path, ctx.origin);
  const home = url('/', ctx.origin);
  /*
   * A FEATURED VIDEO IS NOT AN ARTICLE IMAGE.
   *
   * `featured_image` is a bare string with no kind notion anywhere — no field,
   * no derivation, no guard at the picker. So the same gesture that broke
   * products (open the media picker, click the video) puts an .mp4 into
   * `BlogPosting.image`, which Google rejects, and into `og:image`, where a
   * social card shows nothing.
   *
   * Filtered here rather than at the post route for the reason the product
   * builder learned: this is exported from `astrobaas/core`, and a guarantee
   * that lives in one caller is not a guarantee.
   */
  const img = mediaKindOf(String(a.image ?? '')) === 'video' ? undefined : image(a.image, ctx);
  return {
    '@type': 'BlogPosting',
    headline: a.title,
    ...(a.description ? { description: a.description } : {}),
    ...(a.datePublished ? { datePublished: a.datePublished } : {}),
    ...(a.dateModified ? { dateModified: a.dateModified } : {}),
    ...(canonical ? { mainEntityOfPage: canonical, url: canonical } : {}),
    ...(a.authorName ? { author: { '@type': 'Person', name: a.authorName } } : {}),
    ...(img ? { image: img } : {}),
    ...(a.categoryName ? { articleSection: a.categoryName } : {}),
    ...(home ? { publisher: { '@id': `${home}#organization` } } : {}),
  };
}

/** A CMS Page, as a WebPage. */
export function webPageNode(
  p: { title: string; description?: string; path?: string; dateModified?: string },
  ctx: SdContext,
): Record<string, unknown> {
  const canonical = url(p.path, ctx.origin);
  return {
    '@type': 'WebPage',
    name: p.title,
    ...(p.description ? { description: p.description } : {}),
    ...(canonical ? { url: canonical } : {}),
    ...(p.dateModified ? { dateModified: p.dateModified } : {}),
  };
}

/**
 * A listing page, as a CollectionPage carrying an ItemList.
 *
 * The list is positions and URLs only — repeating each post's whole
 * BlogPosting here would duplicate what the post's own page already declares,
 * and duplicated entities are how a site ends up competing with itself.
 */
export function collectionPageNode(
  c: { title: string; description?: string; path: string; items: { title: string; path: string }[] },
  ctx: SdContext,
): Record<string, unknown> {
  const canonical = url(c.path, ctx.origin);
  return {
    '@type': 'CollectionPage',
    name: c.title,
    ...(c.description ? { description: c.description } : {}),
    ...(canonical ? { url: canonical } : {}),
    ...(c.items.length > 0
      ? {
        mainEntity: {
          '@type': 'ItemList',
          numberOfItems: c.items.length,
          itemListElement: c.items.map((item, i) => ({
            '@type': 'ListItem',
            position: i + 1,
            name: item.title,
            ...(url(item.path, ctx.origin) ? { url: url(item.path, ctx.origin) } : {}),
          })),
        },
      }
      : {}),
  };
}

export interface ProductInput {
  name: string;
  description?: string;
  /** Site-relative path on the STOREFRONT, which may not be this app. */
  path?: string;
  sku?: string;
  gtin?: string;
  brand?: string;
  images?: string[];
  priceCents?: number;
  currency?: string;
  inStock?: boolean;
  /** 'active' | anything else — only an active product is offered. */
  status?: string;
  /**
   * Approved review ratings, for `aggregateRating` (C-35).
   *
   * Emitting this asks Google to show STARS against the shop's name in a
   * result, so the number has to be one the shop can stand behind: only
   * APPROVED reviews count, and a product with none gets no node at all rather
   * than a zero — `aggregateRating` with `reviewCount: 0` is a structured-data
   * error, and a shop that emits it is asking for a manual action.
   */
  ratingCount?: number;
  ratingAverage?: number | null;
}

/**
 * A product, as a Product with an Offer.
 *
 * The core is headless — there is no product route in this app, the two
 * production shops render their own storefronts against the API. So this
 * builder exists for THEM and for themes that render products: it is exported
 * from `astrobaas/core`, and `GET /api/products/{id}` returns the node ready
 * to embed, so a storefront gets correct schema.org without reimplementing
 * price and availability semantics (the two fields Google actually validates).
 *
 * Money is integer cents everywhere in this codebase; schema.org wants a
 * decimal string, and that conversion is exactly the kind of thing that gets
 * done differently in three places if it is not done once here.
 */
export function productNode(p: ProductInput, ctx: SdContext): Record<string, unknown> {
  const canonical = url(p.path, ctx.origin);
  /*
   * VIDEOS ARE FILTERED HERE, inside the builder, and not at the call site.
   *
   * schema.org `image` is an ImageObject or a URL to one. An .mp4 in it is a
   * structured-data error on the surface Google reads, and it is what a shop
   * gets the first time a manager adds a product video.
   *
   * The filter used to live at the one route that calls this. That is the
   * "fixed one of several" shape: `productNode` is EXPORTED from
   * `astrobaas/core`, so every theme, plugin and storefront that builds its own
   * JSON-LD reproduced the bug the route had just fixed. A guarantee that lives
   * in one caller is not a guarantee.
   *
   * The check is on the URL because that is all this builder is given — the
   * same extension rule `mediaKindOf` applies, which is reliable for anything
   * this CMS ingested (the uploader names files from the sniffed type).
   */
  const images = (p.images ?? [])
    .filter((i) => mediaKindOf(typeof i === 'string' ? i : String(i ?? '')) !== 'video')
    .map((i) => image(i, ctx))
    .filter((i): i is string => !!i);
  const available = p.status === 'active' && p.inStock !== false;
  return {
    '@type': 'Product',
    name: p.name,
    ...(p.description ? { description: p.description } : {}),
    ...(canonical ? { url: canonical } : {}),
    ...(p.sku ? { sku: p.sku } : {}),
    ...(p.gtin ? { gtin: p.gtin } : {}),
    ...(p.brand ? { brand: { '@type': 'Brand', name: p.brand } } : {}),
    ...(images.length > 0 ? { image: images } : {}),
    ...(typeof p.priceCents === 'number' && Number.isFinite(p.priceCents)
      ? {
        offers: {
          '@type': 'Offer',
          // `moneyPlain`, not `/100).toFixed(2)`. Dividing by a hundred and
          // fixing two decimals is only right for two-decimal currencies: a
          // JPY shop would publish a price a hundred times too small, in a
          // field Google reads and shows in search results.
          price: moneyPlain(p.priceCents, p.currency || DEFAULT_CURRENCY),
          priceCurrency: p.currency || DEFAULT_CURRENCY,
          availability: available
            ? 'https://schema.org/InStock'
            : 'https://schema.org/OutOfStock',
          ...(canonical ? { url: canonical } : {}),
        },
      }
      : {}),
    // Only when there is something real to say. See ratingCount above.
    ...(typeof p.ratingCount === 'number' && p.ratingCount > 0
      && typeof p.ratingAverage === 'number' && Number.isFinite(p.ratingAverage)
      ? {
        aggregateRating: {
          '@type': 'AggregateRating',
          ratingValue: String(p.ratingAverage),
          reviewCount: p.ratingCount,
          bestRating: '5',
          worstRating: '1',
        },
      }
      : {}),
  };
}

/**
 * The site's identity nodes, for a page that references them.
 *
 * `articleNode` points its `publisher` at the Organization by `@id`, and
 * JSON-LD resolves `@id` PER DOCUMENT — a reference to a node that is not in
 * the same graph is a dangling pointer, and validators report the Article as
 * having an incomplete publisher rather than no publisher at all. So any page
 * that emits an article emits the Organization it names, right here with it.
 */
export function siteIdentityNodes(
  ctx: SdContext & { tagline?: string; searchPath?: string; logo?: string },
  opts: { includeWebSite?: boolean } = {},
): (Record<string, unknown> | null)[] {
  return [
    organizationNode(ctx),
    // WebSite (and its SearchAction) belongs on the front door only: it
    // describes the site as a whole, and repeating it under every article is
    // how a site ends up competing with itself for its own name.
    opts.includeWebSite ? webSiteNode(ctx) : null,
  ];
}

/**
 * Wrap nodes into the single `@graph` document a page emits.
 *
 * One script element per page, always: two separate `ld+json` blocks are legal
 * but make it impossible for nodes to reference each other by `@id`, which is
 * how the article on every page points at one Organization instead of
 * redefining it. Nulls are dropped so callers can pass optional nodes inline.
 */
export function structuredData(
  nodes: (Record<string, unknown> | null | undefined)[],
): Record<string, unknown> | null {
  const graph = nodes.filter((n): n is Record<string, unknown> => !!n);
  if (graph.length === 0) return null;
  return { '@context': 'https://schema.org', '@graph': graph };
}
