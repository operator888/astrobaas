/**
 * Reading a PDF in the page, instead of downloading it to find out what it is.
 *
 * ## The gap
 *
 * A PDF could always be uploaded — `ingest.ts` verifies `%PDF-` by magic bytes
 * like every other accepted type — but inserting one into a post produced
 * `<p><a href="…">price-list.pdf</a></p>`. That is a download, and a download
 * is a decision: the reader leaves the page, waits, opens a viewer, and only
 * then learns whether the file was the one they wanted. For the documents a
 * CMS actually carries — a price list, a menu, a datasheet, a parish
 * newsletter — the reader wants to *look*, and most of them will not pay a
 * download to do it.
 *
 * ## Why this is a render-time expansion and not stored markup
 *
 * The same reason the embed facades are (see `embeds.ts`, and step 4 of
 * `content-render.ts`): what is STORED stays inert. An `<iframe>` is not on the
 * sanitizer's allow-list and is never going on it — that allow-list is a large
 * part of what keeps the strict CSP honest. So content keeps a plain link
 * inside a marked `<figure>`, the sanitizer validates that on every save, and
 * the frame is built HERE, after sanitization, from a URL that has been checked
 * against a shape rather than trusted.
 *
 * It also means the degradation is the useful one. A consumer that renders
 * stored `content` itself — a headless storefront that skips this pipeline —
 * gets the link, which works. An unexpanded video facade shows nothing; an
 * unexpanded PDF figure is exactly the download link it replaced.
 *
 * ## Same-origin only, and why a CDN install keeps the link
 *
 * A frame needs the framed response to permit it, and we can only set headers
 * on responses this app serves (see `frameOptionsFor` in `security-headers.ts`,
 * which relaxes X-Frame-Options to SAMEORIGIN for exactly this path and nothing
 * else). An install that points `MEDIA_BASE` at a CDN serves its uploads from
 * an origin whose headers we do not control, so those URLs are left as links
 * rather than framed into a box that would be blank on half the world's
 * browsers. The rule is applied to the URL, not to configuration, so the right
 * thing happens per file.
 */
import { escapeHtml } from './escape-html';
import { plainText } from './html-text';
import { publicStrings } from './i18n/public-strings';

/**
 * The marker class on a stored PDF figure.
 *
 * On the sanitizer's core allow-list for the same reason `ab-embed` is: the
 * renderer looks for it, so stripping it on save would make a viewer an author
 * inserted turn back into a bare link the next time they fixed a typo.
 */
export const PDF_CLASS = 'ab-pdf';

/**
 * Is this a URL we may frame?
 *
 * Deliberately a shape test on a relative path, not a URL parse:
 *
 *  - it must be root-relative (`/uploads/…`), which is same-origin by
 *    construction — no scheme to be `javascript:`, no host to be someone
 *    else's;
 *  - `//` is refused, because `//evil.test/x.pdf` is protocol-relative and
 *    parses as a different ORIGIN while looking like a path;
 *  - `..` is refused, so a stored value cannot walk out of the uploads tree
 *    and frame some other route's response;
 *  - it must end in `.pdf`, before any `#fragment`, because that is the only
 *    thing the relaxed frame header applies to.
 *
 * A URL that fails any of these is not an error — it is a link, and it stays
 * one.
 */
export function framablePdfUrl(raw: unknown): string | null {
  const url = String(raw ?? '').trim();
  if (!url.startsWith('/') || url.startsWith('//')) return null;
  const [pathPart] = url.split(/[?#]/);
  if (!pathPart.toLowerCase().endsWith('.pdf')) return null;
  if (pathPart.split('/').includes('..')) return null;
  if (!/^\/uploads\//i.test(pathPart)) return null;
  return pathPart;
}

/** What the editor inserts for a PDF: inert, sanitizer-safe, already useful. */
export function pdfFigureHtml(url: string, label: string): string {
  const text = label.trim() || url.split('/').pop() || 'PDF';
  return `<figure class="${PDF_CLASS}"><a href="${escapeHtml(url)}">${escapeHtml(text)}</a></figure>`;
}

/**
 * Expand every stored PDF figure into a viewer. Runs AFTER the sanitizer.
 *
 * `#view=FitH` asks the browser's own viewer to fit the page width, which is
 * what makes a 1000-pixel-wide frame readable rather than a stamp in the middle
 * of grey. It is a PDF open parameter, not a URL fragment the server sees.
 *
 * The download link below the frame is not decoration: on iOS Safari an inline
 * PDF renders only its first page, and a reader who needs page 4 needs a way
 * out. It is also the whole answer for a browser with no PDF viewer at all.
 */
export function renderPdfViewers(html: string, locale?: unknown): string {
  if (!html || !html.includes(PDF_CLASS)) return html;
  const strings = publicStrings(locale);

  return html.replace(
    /<figure\b([^>]*\bclass="[^"]*\bab-pdf\b[^"]*"[^>]*)>\s*<a\b([^>]*)>([\s\S]*?)<\/a>\s*<\/figure>/g,
    (whole, _figureAttrs: string, anchorAttrs: string, inner: string) => {
      const href = /\bhref="([^"]*)"/.exec(anchorAttrs)?.[1] ?? '';
      const src = framablePdfUrl(href);
      if (!src) return whole;

      /*
       * `plainText`, not a regex of this module's own.
       *
       * The link's text may contain markup — the sanitizer permits `<em>` in
       * there — and it needs to become a plain string for an attribute, which
       * takes text and not tags. A local `.replace(/<[^>]*>/g, '')` is the
       * obvious way to do that and is also how this codebase ended up with
       * five diverging copies of the same stripper, two of which disagreed
       * about whether a tag boundary is a word boundary.
       * `tests/shared-lib.test.mjs` fails the build on a sixth, and it caught
       * this one.
       *
       * It also settles the escaping question by removing it: `plainText`
       * DECODES entities, so what comes back is real text with a real `&` and
       * a real `"`, and it is escaped once, on the way out, for both the
       * attribute and the visible name. No reasoning about what the sanitizer
       * already did, and no double-escaping to get wrong.
       */
      const label = plainText(inner) || strings.pdfDocument;
      const labelHtml = escapeHtml(label);

      return `<figure class="${PDF_CLASS} ab-pdf-viewer">`
        + `<iframe class="ab-pdf-frame" src="${escapeHtml(src)}#view=FitH"`
        + ` title="${labelHtml}" loading="lazy"></iframe>`
        + `<p class="ab-pdf-actions">`
        + `<a class="ab-pdf-download" href="${escapeHtml(src)}" download>${strings.pdfDownload}</a>`
        + `<span class="ab-pdf-name">${labelHtml}</span>`
        + `</p>`
        + `</figure>`;
    },
  );
}
