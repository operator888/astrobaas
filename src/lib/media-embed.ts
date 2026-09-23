/**
 * The markup a media file becomes when an author inserts it into a post (C-40).
 *
 * ## The picker could not insert anything
 *
 * `MediaLibrary` has dispatched a `mediaSelected` event since it was written,
 * and the only listeners set the FEATURED IMAGE. So the library was browsable
 * and unusable for the thing people actually open it for: putting a picture in
 * the middle of an article.
 *
 * ## Every choice here is about surviving the sanitizer
 *
 * The output is re-sanitized at the render boundary, so anything this produces
 * that the allow-list rejects is silently dropped — visible in the editor,
 * missing on the page, and nothing logged. Hence:
 *
 * - `<img …/>` is written **self-closed**, which is the form `sanitize-html`
 *   normalises to. Every template in `core/sections.ts` is written that way for
 *   the same reason, so a round-trip comparison stays byte-identical.
 * - `<figure>` and `<figcaption>` are on the allow-list; a wrapper `<div>` with
 *   a class outside the generated section vocabulary would not be.
 * - `item.url`, never `item.thumb_url`. The thumbnail is a 400px derivative for
 *   a grid tile; putting it in an article body ships a blurry picture that the
 *   dimensions pipeline then reserves the wrong box for.
 */
import { escapeHtml } from './escape-html';
import { framablePdfUrl, pdfFigureHtml } from './pdf-embed';

export interface MediaItem {
  url?: string;
  thumb_url?: string;
  original_name?: string;
  filename?: string;
  mime_type?: string;
  alt_text?: string;
}

function isImage(item: MediaItem): boolean {
  return String(item.mime_type ?? '').startsWith('image/');
}

/** Self-hosted video — an uploaded file, never a YouTube facade. */
export function isVideo(item: MediaItem): boolean {
  return String(item.mime_type ?? '').startsWith('video/');
}

/** What a reader should see as the link text or the alt. */
function label(item: MediaItem): string {
  return (item.alt_text || item.original_name || item.filename || '').trim();
}

/**
 * The HTML to insert for this file.
 *
 * Returns `''` for a record with no url — there is nothing to link to, and
 * inserting an `<img src="">` would render a broken-image icon the author then
 * has to find and delete.
 *
 * A non-image becomes a link rather than an embed. A PDF in an `<img>` is a
 * broken image; a PDF as a link is a download, which is what the author meant.
 */
export function mediaInsertHtml(item: MediaItem): string {
  const url = String(item.url ?? '').trim();
  if (!url) return '';
  const text = label(item);

  /*
   * A self-hosted video.
   *
   * `controls` because a video the visitor cannot pause is one they cannot
   * escape. `preload="metadata"` rather than the browser default of `auto`:
   * `auto` starts pulling the file the moment the page loads, so a product
   * page with a 60 MB clip costs every visitor 60 MB whether or not they ever
   * press play — the operator's bandwidth and the visitor's data plan both.
   * `metadata` fetches the few kilobytes needed to know the duration and show
   * the first frame's dimensions, which is also what stops the page jumping.
   *
   * `<source>` rather than `src` on the element: it is the shape that lets a
   * second encoding be added later without rewriting stored posts, and the
   * `type` lets a browser skip a format it cannot play instead of downloading
   * it to find out.
   *
   * No `autoplay`, and the sanitizer would strip it anyway — the reason is
   * written there.
   */
  if (isVideo(item)) {
    const mime = String(item.mime_type ?? '').trim();
    /*
     * NOTHING INSIDE <video> BUT THE <source>. No fallback link, and the
     * absence is the point.
     *
     * This carried `<a href=…>name</a>` as fallback content, on the reasoning
     * that a browser which cannot play the file could still download it. That
     * reasoning does not survive contact with how browsers work: <video>
     * fallback content renders only where <video> is UNSUPPORTED, which is no
     * browser anyone runs. A browser that supports the element but not the
     * codec shows the element with an error and never looks at the fallback.
     * So the link was already doing nothing for the visitor it was written for.
     *
     * What it DID do was make the stored post depend on where the caret was.
     * Measured in a real editor: inserting with the caret inside the editable
     * goes through `document.execCommand('insertHTML')`, whose sanitiser
     * strips text nodes out of <video> fallback content and leaves
     * `<a href="…"></a>` — a link with no accessible name. Inserting with the
     * caret elsewhere goes through insertAdjacentHTML, which keeps the text.
     * Same file, same button, two different stored strings.
     *
     * Between an element that is inert in every browser and an element that is
     * inert AND makes output non-deterministic, the answer is to remove it.
     */
    const inner = `<video controls preload="metadata" playsinline>`
      + `<source src="${escapeHtml(url)}"${mime ? ` type="${escapeHtml(mime)}"` : ''} />`
      + `</video>`;
    // Wrapped like an image is, so a caption can be added and so themes that
    // style `figure` treat both the same.
    return `<figure>${inner}</figure>`;
  }

  /*
   * A PDF that this app serves becomes a viewer; everything else stays a link.
   *
   * `pdfFigureHtml` stores the link INSIDE a marked figure rather than an
   * iframe: the frame is built at render time, after the sanitizer, for the
   * reasons in pdf-embed.ts. So what is stored is still a working download for
   * any consumer that renders `content` itself, and the reader of a page this
   * CMS renders gets to read the thing in place.
   *
   * A non-PDF — a .txt, a .md, or a PDF on a CDN whose headers we do not
   * control — keeps the plain link. A PDF in an `<img>` is a broken image; a
   * PDF as a link is a download, which is what the author meant.
   */
  if (!isImage(item)) {
    if (framablePdfUrl(url)) return pdfFigureHtml(url, text);
    return `<p><a href="${escapeHtml(url)}">${escapeHtml(text || url)}</a></p>`;
  }

  // NO alt attribute at all when the library has no description — not alt="".
  //
  // This was wrong in the first version and the audit caught it. `alt=""` is
  // correct markup for a DECORATIVE image, and `applyImageAltText` therefore
  // treats it as a deliberate decision and never fills it. So writing it here
  // permanently blocked the render-time filler: describing the file afterwards
  // in the media library would never reach any post that already embedded it,
  // and the missing-alt audit would report nothing because the attribute is
  // technically present.
  //
  // Omitting it leaves the pipeline free to fill it later, and leaves the image
  // in the audit until somebody does. An author who genuinely means decorative
  // types alt="" themselves, which is then honoured.
  const alt = item.alt_text?.trim() ?? '';
  return alt
    ? `<figure><img src="${escapeHtml(url)}" alt="${escapeHtml(alt)}" /></figure>`
    : `<figure><img src="${escapeHtml(url)}" /></figure>`;
}

/**
 * A GALLERY of several files (C-63).
 *
 * ## The gap this closes
 *
 * There was no path from "pick six pictures" to "a gallery of those six".
 * Inserting the gallery section gave two placeholder images, the pattern gave
 * three, and the media library could insert exactly ONE `<figure>` at the
 * caret — so an author swapped each placeholder by hand, and any they forgot
 * shipped the placeholder that came with the theme.
 *
 * ## Built from the same pieces as a single insert
 *
 * Every `<img>` here comes from `mediaInsertHtml`'s exact form: self-closed
 * (what `sanitize-html` normalises to, so the round trip is byte-identical) and
 * with the alt attribute OMITTED rather than empty when the library has no
 * description, so `applyImageAltText` can still fill it at render time.
 *
 * PICK ORDER is gallery order. The alternative — library order — means an
 * author who wants a specific sequence cannot express one, and the product
 * form already treats pick order as meaningful for exactly this reason.
 */
export function galleryHtml(items: readonly MediaItem[]): string {
  const figures = items
    .map((item) => {
      const inner = mediaInsertHtml(item);
      // A non-image came back as a paragraph link, and a file with no url as
      // an empty string. Neither belongs in a gallery grid.
      if (!inner.startsWith('<figure>')) return '';
      return inner.replace('<figure>', '<figure class="ab-gallery-item">');
    })
    .filter(Boolean);

  // Nothing usable: return nothing rather than an empty grid, which renders as
  // a mysterious gap the author then has to find and delete.
  if (figures.length === 0) return '';
  return `<div class="ab-gallery">${figures.join('')}</div>`;
}
