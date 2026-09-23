/**
 * Turning stored post content into the HTML a reader sees — in ONE place.
 *
 * ## Why this module exists
 *
 * Four surfaces render a post body: the article page, the Page renderer, the
 * posts LIST endpoint and the single-post endpoint. They had converged on the
 * media attributes (`withImageDimensions` below already said so in its
 * docblock) and diverged on everything before them. The two SSR paths ran
 *
 *     filters → sanitizeHtml → lazyLoadContentImages → buildToc
 *
 * and the two API paths ran `buildToc(filters(...))` — no sanitizer, no lazy
 * hints. Both API routes carried a comment promising a decoupled storefront
 * "exactly the markup this CMS would have served". It was not.
 *
 * That mattered twice:
 *
 *  - **Security.** `sanitizeHtml` on write protects the stored content, but a
 *    `post_content` filter runs on READ and can return anything. The SSR
 *    comment is explicit that a filter's output has to pass the sanitizer too,
 *    "or a plugin becomes an XSS vector". The API skipped it — and the
 *    installs that matter here are headless storefronts, which reach the CMS
 *    *only* through these routes.
 *  - **Core Web Vitals.** No `loading="lazy"` / `decoding="async"`, so a
 *    decoupled storefront scored worse than the SSR page purely for being
 *    decoupled — the exact thing the route's comment claimed it would not.
 *
 * The order is load-bearing and is the reason this is a function rather than a
 * convention:
 *
 *  1. **filters first**, because a plugin's output is content.
 *  2. **sanitize second**, because that output is untrusted.
 *  3. **lazy hints third**, never before the sanitizer: the attributes are on
 *     the allow-list, but running them first would let a filter's markup be
 *     rewritten and then sanitized, reversing step 2.
 *  4. **embed facades fourth** (C-44), and necessarily AFTER the sanitizer: the
 *     facade contains a `<button>`, which the sanitizer would discard. What is
 *     STORED is an inert placeholder div whose provider and id the sanitizer
 *     validated; the frame URL is built here from that pair and never read from
 *     content. Running this before the sanitizer would reverse both properties.
 *  5. **PDF viewers fifth**, and after the sanitizer for the same reason the
 *     facades are: an `<iframe>` is not on the allow-list and is never going
 *     on it. What is stored is a plain link inside a marked `<figure>`, and
 *     the frame is built from a URL checked against a shape here. Storing the
 *     link rather than an empty placeholder is what makes the unexpanded form
 *     useful to a consumer that renders `content` itself.
 *  6. **anchors last**, on already-sanitized html, and UNCONDITIONALLY — a
 *     deep link a reader copies out of the address bar must resolve whether or
 *     not the operator renders a contents list.
 *
 * Media facts (width/height and alt) are applied by the caller, because the
 * list endpoint reads the media library once for a whole page of articles and
 * a per-post read there would be one query per row.
 */
import type { Post } from '../core/models';
import { LocalDB } from './localdb';
import { sanitizeHtml, lazyLoadContentImages } from './sanitize';
import { renderEmbedFacades } from './embeds';
import { renderPdfViewers } from './pdf-embed';
import { buildToc, type TocResult } from './toc';
import {
  collectImageSources, applyImageDimensions, sizesFromMedia,
  applyImageAltText, altFromMedia, type ImageSize,
} from './image-dimensions';
import { pluginManager } from './plugin-system';

/**
 * The rendered body and its heading list, from a post's stored content.
 *
 * Takes the post (not just the html) because `post_content` filters receive it
 * — a filter that only sees a string cannot tell a draft from a product page.
 */
export function renderContentHtml(post: Post, locale?: unknown): TocResult {
  // `locale` is the CONTENT locale, for the handful of strings the facade
  // renders. Optional, so every existing caller keeps working and gets English
  // — which is what it got before.
  return buildToc(renderPdfViewers(renderEmbedFacades(lazyLoadContentImages(
    sanitizeHtml(pluginManager.applyFilters('post_content', post.content ?? '', post) as string),
  ), locale), locale));
}

/** The title, through the same filter chain. One name, so no caller invents another. */
export function renderTitle(post: Post): string {
  return pluginManager.applyFilters('post_title', post.title, post) as string;
}

export interface MediaFacts {
  sizes: Map<string, ImageSize>;
  alt: Map<string, string>;
}

/** Nothing known. Shared so the empty case is one object, not four literals. */
const NO_MEDIA_FACTS: MediaFacts = { sizes: new Map(), alt: new Map() };

/**
 * Everything the content pipeline needs from the media library, in ONE read.
 *
 * Batched because the posts LIST endpoint renders a whole page of articles at
 * once, and a per-document lookup there is one read of the media library per
 * post. Skipped entirely when none of the documents has an image.
 *
 * Returns dimensions AND alt text together. They are two attributes on the same
 * `<img>`, sourced from the same row: fetching them separately would double the
 * cost of the exact query this function exists to do once.
 */
export async function mediaFactsForHtml(htmls: readonly string[]): Promise<MediaFacts> {
  const wanted = new Set<string>();
  for (const h of htmls) for (const src of collectImageSources(h)) wanted.add(src);
  if (wanted.size === 0) return NO_MEDIA_FACTS;
  try {
    const media = await LocalDB.getMedia();
    return { sizes: sizesFromMedia(media, wanted), alt: altFromMedia(media, wanted) };
  } catch {
    // A media read that fails must not take the article down. Without the
    // attributes the page still renders; it just shifts and reads its images
    // out unnamed, which is the state every page was in before this existed.
    return NO_MEDIA_FACTS;
  }
}

/**
 * Apply what one read found to one document.
 *
 * Separate from the read so the list route can apply the SAME facts to every
 * post it rendered without asking again.
 */
export function applyMediaFacts(html: string, facts: MediaFacts): string {
  return applyImageAltText(applyImageDimensions(html, facts.sizes), facts.alt);
}

/**
 * Enrich the body images of ONE document — dimensions and alt text.
 *
 * Shared by every renderer so they cannot disagree about which images get which
 * attributes. The name is kept from when it only did dimensions, because four
 * call sites and a test suite use it.
 */
export async function withImageDimensions(html: string): Promise<string> {
  return applyMediaFacts(html, await mediaFactsForHtml([html]));
}

/**
 * The whole pipeline for ONE post: filters, sanitizer, hints, anchors, media.
 *
 * What a single-post API route and an article page both want. The list route
 * uses the pieces instead, so its media read stays batched.
 */
export async function renderPost(post: Post, locale?: unknown): Promise<{ html: string; toc: TocResult; title: string }> {
  const toc = renderContentHtml(post, locale);
  return { html: await withImageDimensions(toc.html), toc, title: renderTitle(post) };
}
