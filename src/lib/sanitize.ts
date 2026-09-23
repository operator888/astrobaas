/**
 * Server-side HTML sanitizer for rich-text fields, backed by `sanitize-html`
 * (a real HTML parser + allow-list). Replaces the previous hand-rolled regex
 * tokenizer: malformed markup, entity/whitespace-encoded `javascript:` URLs,
 * nested dangerous tags, comments, and attribute-injection edge cases are now
 * handled by a maintained, parser-accurate library instead of bespoke regexes.
 *
 * Runs server-side only (Node) — sanitize-html uses htmlparser2, not a DOM, so
 * it works in Astro SSR / API routes without jsdom.
 */
import sanitizeHtmlLib from 'sanitize-html';
import { sectionClassList } from '../core/sections';
import { EMBED_CLASS, EMBED_ATTRIBUTES, validEmbed } from './embeds';
import { PDF_CLASS } from './pdf-embed';

/**
 * Opt out of the plugin section namespace entirely.
 *
 * For an operator who wants content classes to be a closed set with no
 * pattern-matched escape hatch — a hosting provider running untrusted sites,
 * say. Off by default because turning it on strips an installed plugin's
 * sections out of content on save, which is data loss for anyone actually
 * using one.
 */
const STRICT_CLASSES = process.env.SANITIZE_STRICT_CLASSES === '1';

/**
 * `ab-x-<pluginId>-<name>`, matched as a shape.
 *
 * Anchored at both ends so it cannot match a longer hostile class, and limited
 * to lowercase/digits/hyphen so nothing that reaches CSS can carry punctuation.
 */
const PLUGIN_SECTION_CLASS_RE = /^ab-x-[a-z][a-z0-9]*(-[a-z0-9]+)+$/;

// data: URIs are permitted only on <img>, and only for raster images
// (never SVG — it can carry script).
const RASTER_DATA_IMAGE = /^data:image\/(png|jpe?g|gif|webp)[;,]/i;

/** The most columns or rows one cell may claim. Beyond this it is a mistake or an attack. */
const MAX_SPAN = 100;

/**
 * Keep a span only when it is a small whole number.
 *
 * `scope` and `headers` need no clamping — they are enumerated or id lists, and
 * the sanitizer's own attribute filter already bounds what they may contain.
 */
function clampSpans(tagName: string, attribs: Record<string, string>) {
  for (const key of ['colspan', 'rowspan', 'span']) {
    if (!(key in attribs)) continue;
    const n = Number.parseInt(attribs[key], 10);
    if (!Number.isFinite(n) || n < 1) delete attribs[key];
    else attribs[key] = String(Math.min(n, MAX_SPAN));
  }
  return { tagName, attribs };
}

const OPTIONS: sanitizeHtmlLib.IOptions = {
  allowedTags: [
    'p', 'br', 'hr', 'span', 'div',
    'a', 'strong', 'em', 'b', 'i', 'u', 's', 'code', 'pre', 'blockquote',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'ul', 'ol', 'li',
    'img', 'figure', 'figcaption',
    // Self-hosted video. `source` too: a <video> whose only child is dropped
    // renders an empty black box, which is the editor-shows-it /
    // storage-drops-it split this list already carries a note about for `img`.
    'video', 'source',
    // A table is more than rows. Without `caption` the element is DISCARDED and
    // its text kept — `<table><caption>Prices</caption>` becomes a bare text
    // node inside `<table>`, which every browser foster-parents OUT, so the
    // caption silently reappears ABOVE the table as loose text. `colgroup`/`col`
    // carry column widths, and `tfoot` a totals row; both were dropped with no
    // sign, so a pasted table lost its structure on save.
    'table', 'caption', 'colgroup', 'col', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
    'sub',
    'sup',
    'mark'],
  allowedClasses: {
    // The ONLY classes content may carry, GENERATED from the section vocabulary
    // in src/core/sections.ts rather than written out here.
    //
    // Generated on purpose: a hand-kept list drifts from the palette, and the
    // failure mode is silent — the editor inserts a section and the sanitizer
    // strips its class on save, so the author sees it work and then lose it.
    // That exact bug shipped once already, as the alignment buttons emitting an
    // inline `style` this sanitizer removed.
    //
    // Still an allow-list, not a denylist: a pasted `class="fixed inset-0"` is
    // dropped, so nothing in content can escape the article and cover the page.
    // Plus the plugin section namespace, matched by SHAPE rather than by
    // looking up what is installed.
    //
    // This is the deliberate choice. The sanitizer runs on every save, so a
    // lookup would mean that saving a page while a plugin is disabled strips
    // that plugin's sections out of it permanently — an author edits a typo and
    // loses a layout. Matching the namespace instead means an uninstalled
    // plugin's sections degrade to unstyled markup and come back when it is
    // reinstalled, which is the same degradation core sections already rely on.
    //
    // The namespace is inert on its own: a class only does something if some
    // stylesheet defines it, and only an installed plugin's CSS does. Operators
    // who want a closed allow-list anyway can set SANITIZE_STRICT_CLASSES=1.
    //
    // `ab-embed` and `ab-pdf` are here for the same reason the section classes
    // are: the renderer looks for them, so stripping one on save would make an
    // embed or a PDF viewer an author inserted vanish the next time they
    // edited the post. Both survive STRICT_CLASSES because they are core, not
    // a plugin's.
    '*': STRICT_CLASSES
      ? [...sectionClassList(), EMBED_CLASS, PDF_CLASS]
      : [...sectionClassList(), EMBED_CLASS, PDF_CLASS, PLUGIN_SECTION_CLASS_RE],
  },
  allowedAttributes: {
    a: ['href', 'title', 'target', 'rel'],
    // `loading` and `decoding` are on this list so the content pipeline can add
    // them (see lazyLoadContentImages). They are inert hints — neither can carry
    // a URL or execute — so allowing them costs nothing, and WITHOUT them the
    // sanitizer silently strips whatever the pipeline adds, which is the
    // editor-shows-it / storage-drops-it split this codebase keeps finding.
    img: ['src', 'alt', 'title', 'width', 'height', 'loading', 'decoding'],
    // Merged cells and the header association a screen reader needs. On `td`
    // and `th` specifically, NOT on `'*'`: a colspan on a div is meaningless,
    // and widening the wildcard is how an allow-list rots.
    td: ['colspan', 'rowspan', 'headers'],
    th: ['colspan', 'rowspan', 'scope', 'headers'],
    col: ['span'],
    colgroup: ['span'],
    // The embed placeholder (C-44). Allowing the ATTRIBUTES is not what makes
    // this safe — `transformTags.div` below validates the pair and deletes both
    // if it does not hold. Listing them here only lets them reach that check.
    div: [...EMBED_ATTRIBUTES],
    /*
     * Video, and the four attributes deliberately NOT here.
     *
     * `controls` is allowed because a video the visitor cannot pause is a
     * video they cannot escape. `poster` and the dimensions are allowed because
     * without them the page jumps when the metadata arrives — the same CLS
     * reason `img` carries width and height.
     *
     * `autoplay` is NOT allowed. An autoplaying video is the single most
     * complained-about thing a page can do, browsers block it with sound
     * anyway, and an operator who wanted it would be pasting it into a field
     * that gets published to strangers. `loop` is out for the same reason.
     * `crossorigin` is out because these files are served from this origin.
     * `controlslist` is out because it exists to REMOVE controls, including
     * download and fullscreen, which is a choice to take away from a visitor.
     *
     * `muted` and `playsinline` ARE allowed: both only matter alongside
     * autoplay, which is refused, and `playsinline` stops iOS hijacking the
     * whole screen when somebody presses play.
     */
    video: ['src', 'controls', 'poster', 'width', 'height', 'preload', 'muted', 'playsinline'],
    source: ['src', 'type'],
    '*': ['class', 'id'],
  },
  // Anything not listed here (javascript:, vbscript:, data: on non-img, …) is
  // stripped. sanitize-html decodes entities/whitespace before this check.
  allowedSchemes: ['http', 'https', 'mailto'],
  // `img` keeps `data:` for inline thumbnails. Video does NOT: a data: URI
  // holding a video is megabytes of base64 inside the post body, and the
  // uploads it should point at are always http(s).
  allowedSchemesByTag: { img: ['http', 'https', 'data'], video: ['http', 'https'], source: ['http', 'https'] },
  allowProtocolRelative: false,
  // Drop disallowed tags but keep their (sanitized) text; script/style/etc.
  // bodies are removed entirely via sanitize-html's nonTextTags default.
  /*
   * `source` is a VOID element, and sanitize-html's default list omits it.
   *
   * Without this the library re-serialises `<source />` as
   * `<source></source>` — which browsers tolerate, but which means the markup
   * the editor inserts is not the markup that gets stored. That difference is
   * how an editor and its storage drift apart, and this codebase has a note
   * about it on `img` for the same reason: a byte-identical round trip is the
   * property a test can actually assert.
   */
  selfClosing: [...(sanitizeHtmlLib.defaults.selfClosing ?? []), 'source'],
  disallowedTagsMode: 'discard',
  transformTags: {
    a: (tagName, attribs) => {
      if ((attribs.target || '').toLowerCase() === '_blank' && !attribs.rel) {
        attribs.rel = 'noopener noreferrer';
      }
      return { tagName, attribs };
    },
    // A pasted `colspan="100000"` is a layout denial-of-service: the browser
    // reserves the columns and the page becomes unusable. Clamped rather than
    // dropped, so a genuine merge survives and an absurd one is made sane.
    td: clampSpans,
    th: clampSpans,
    col: clampSpans,
    colgroup: clampSpans,
    /**
     * The embed placeholder is the only div that may carry data attributes, and
     * it may carry them only when the provider is one we know and the id
     * matches THAT provider's shape (C-44).
     *
     * This is the security boundary, not the allow-list above. Nothing stores a
     * frame URL: the URL is built from the validated pair at render time, so
     * the most an attacker with write access to post HTML can express is a
     * different YouTube video.
     */
    div: (tagName, attribs) => {
      if (!(attribs['data-embed-provider'] || attribs['data-embed-id'])) return { tagName, attribs };
      if (!validEmbed(attribs['data-embed-provider'], attribs['data-embed-id'])) {
        for (const a of EMBED_ATTRIBUTES) delete attribs[a];
        return { tagName, attribs };
      }
      // A poster is OURS or it is nothing — a remote one would make the facade
      // contact a third party before the click, which is the whole point of it.
      //
      // `startsWith('/')` alone is NOT that check: `//evil.example/px.gif` is a
      // protocol-relative URL, it starts with a slash, and the browser fetches
      // it from evil.example. `/\evil.example/px.gif` is a second spelling that
      // some parsers normalise the same way. Both must begin one slash and
      // then something that is not a slash or a backslash.
      const poster = attribs['data-embed-poster'] || '';
      if (poster && !/^\/(?![/\\])/.test(poster)) delete attribs['data-embed-poster'];
      return { tagName, attribs };
    },
    img: (tagName, attribs) => {
      const src = attribs.src || '';
      // http/https are validated by the scheme filter; for data: only raster.
      if (/^data:/i.test(src) && !RASTER_DATA_IMAGE.test(src)) {
        delete attribs.src;
      }
      return { tagName, attribs };
    },
  },
};

export function sanitizeHtml(input: string): string {
  if (!input || typeof input !== 'string') return '';
  return sanitizeHtmlLib(input, OPTIONS);
}

/**
 * Sanitize HTML destined for <head> (plugin head_tags output). Allows a safe
 * metadata subset — meta/link/style — but NEVER <script> or event handlers, so
 * a plugin can add analytics meta, preconnect links, or scoped CSS without
 * being able to inject executable code.
 */
const HEAD_OPTIONS: sanitizeHtmlLib.IOptions = {
  // NOTE: <style> is deliberately NOT allowed. Inline styles are blocked by the
  // hash-based CSP (per-request markup has no build-time hash), and Astro's CSP
  // runtime API can't help because the Node adapter streams — the header is
  // finalized before the layout renders. Plugins contribute CSS through the
  // `plugin_styles` hook instead, which is served as an external stylesheet at
  // /plugins.css. See PLUGIN_DEVELOPMENT.md.
  allowedTags: ['meta', 'link'],
  allowedAttributes: {
    meta: ['name', 'property', 'content', 'charset'],
    link: ['rel', 'href', 'type', 'sizes', 'as', 'crossorigin', 'media'],
  },
  allowedSchemes: ['http', 'https'],
  allowProtocolRelative: false,
};

export function sanitizeHeadHtml(input: string): string {
  if (!input || typeof input !== 'string') return '';
  return sanitizeHtmlLib(input, HEAD_OPTIONS);
}

/** Upper bound on operator-authored theme CSS (keeps /theme.css small + bounded). */
export const MAX_CUSTOM_CSS = 20_000;

/**
 * Sanitize operator-authored CSS before it is stored or served.
 *
 * The CSS is delivered as a standalone same-origin stylesheet (/theme.css), so
 * it is never parsed as HTML and cannot execute. Defence in depth anyway:
 * - strip anything that could close the context if it is ever inlined
 *   (`</style>`, `<script`),
 * - drop `@import`, which would let a stored value pull in a third-party
 *   stylesheet and sidestep the CSP's `style-src` allow-list,
 * - drop legacy `expression(...)` and `javascript:` URLs,
 * - cap the length.
 *
 * This is intentionally a denylist on a non-executable surface, not an attempt
 * at full CSS parsing.
 */
export function sanitizeCustomCss(input: string): string {
  if (!input || typeof input !== 'string') return '';
  return scrubCss(input).slice(0, MAX_CUSTOM_CSS);
}

/** The filtering, without the cap — shared by both entry points. */
function scrubCss(input: string): string {
  return input
    .replace(/<\/?(style|script)\b[^>]*>?/gi, '')
    .replace(/@import\b[^;]*;?/gi, '')
    .replace(/expression\s*\(/gi, '')
    .replace(/javascript:/gi, '');
}

/**
 * Upper bound on a THEME's bundled stylesheet.
 *
 * Larger than the operator cap because a theme legitimately styles a whole
 * site, and it is compiled-in code rather than a value someone typed into a
 * textarea.
 */
export const MAX_THEME_CSS = 100_000;

/**
 * Sanitize a theme's bundled stylesheet.
 *
 * Same filtering as operator CSS — a theme author is trusted not to be hostile,
 * which is not the same as trusted to be correct, and this costs nothing.
 *
 * The difference is what happens when it is too long. `sanitizeCustomCss`
 * truncates, and truncating a stylesheet is worse than it sounds: a cut inside
 * `@media (...) {` swallows every rule after it, so an over-long stylesheet
 * does not degrade, it breaks in a way that looks like a CSS bug. So this
 * refuses the whole thing instead and reports why, which is a condition the
 * theme author can actually see and fix.
 */
export function sanitizeThemeCss(
  input: string | undefined,
  onReject?: (reason: string) => void,
): string {
  if (!input || typeof input !== 'string') return '';
  const scrubbed = scrubCss(input);
  if (scrubbed.length > MAX_THEME_CSS) {
    onReject?.(`theme stylesheet is ${scrubbed.length} bytes, over the ${MAX_THEME_CSS} limit`);
    return '';
  }
  return scrubbed;
}

/**
 * Add loading and decoding hints to images inside stored content.
 *
 * Content images are the ones that actually cost a reader: a long article can
 * carry twenty of them, all below the fold, all fetched eagerly because the
 * rich-text editor writes a bare `<img src alt>`. The two components the theme
 * renders were fixed at their own call sites; this covers everything an author
 * pasted into a body.
 *
 * Applied on the way OUT, not on save. Three reasons:
 *
 *   1. What is stored stays what the author wrote. A performance hint is a
 *      rendering decision, and baking it into the record makes it permanent and
 *      unfixable for content written before we changed our minds.
 *   2. It therefore applies to EXISTING content immediately, with no migration
 *      over two live shops' posts.
 *   3. An image that already carries an explicit `loading` — an author or an
 *      importer that knew what it wanted — is left alone.
 *
 * The FIRST image is deliberately left eager: in an article body it is usually
 * the one just below the fold and often the LCP element on a page with no
 * featured image. Lazy-loading the LCP delays the measurement it appears to
 * help.
 */
export function lazyLoadContentImages(html: string): string {
  if (!html || !html.includes('<img')) return html;
  let seen = 0;
  return html.replace(/<img\b[^>]*>/gi, (tag) => {
    seen += 1;
    // Never override an explicit decision.
    if (/\bloading\s*=/i.test(tag)) return tag;
    const hints = seen === 1 ? ' decoding="async"' : ' loading="lazy" decoding="async"';
    // Insert before the tag's own close, preserving a self-closing slash.
    return tag.replace(/\s*\/?>$/, (end) => `${hints}${end.trim() === '/>' ? ' />' : '>'}`);
  });
}
