/**
 * SVG upload sanitization.
 *
 * SVG is the one image format that is also a PROGRAM: it can carry <script>,
 * event handlers, foreignObject (arbitrary HTML), external references, and
 * CSS that fetches. Serving a hostile one from /uploads is stored XSS on the
 * site's own origin. The media API therefore refused SVG entirely — which
 * pushed every logo and line-drawing out of the media library and into
 * hand-copied static files.
 *
 * This module is the deal that lets SVG in: the file is PARSED and REBUILT
 * through an allow-list (the same `sanitize-html` engine that guards rich
 * text, in XML mode), so only known-inert elements and attributes survive.
 * The rules, each closing a real attack shape:
 *
 *  - No <script>, no event handlers: not in the allow-list, so they cannot
 *    survive re-serialization. Same for <foreignObject> (HTML smuggling),
 *    <image> (external fetch + decoder attack surface), <animate>/<set>
 *    (attribute rewriting — `<set attributeName="href">` re-arms a link
 *    after sanitization), and <a> (an image is not a link; a link INSIDE an
 *    uploaded image is a phishing surface).
 *  - href/xlink:href only ever point INSIDE the document (`#fragment`).
 *    External use/href is exfiltration + SSRF bait; `javascript:` dies here
 *    too, without needing a protocol denylist.
 *  - CSS is scrubbed, both <style> text and style="" attributes: `url(...)`,
 *    `@import`, and `expression(` are removed, so styling survives but
 *    nothing in CSS can fetch or execute.
 *  - Custom entities never expand: the parser does no DTD processing, so a
 *    billion-laughs file comes out flat (the DOCTYPE itself is dropped).
 *
 * The SANITIZED bytes are what gets stored — the hostile original is not
 * kept anywhere, because a "kept original" of an attack file is an attack
 * file at a guessable URL. Serving adds a restrictive per-file CSP on top
 * (see src/pages/uploads/[...path].ts): defense in depth, not the defense.
 */
import sanitizeHtmlLib from 'sanitize-html';

/** Structural elements that draw things. Nothing here executes or fetches. */
const SVG_TAGS = [
  'svg', 'g', 'defs', 'symbol', 'use', 'title', 'desc',
  'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'textPath',
  'linearGradient', 'radialGradient', 'stop', 'pattern',
  'clipPath', 'mask', 'marker', 'filter',
  // The common, inert filter primitives (drop shadows, blurs). feImage is
  // NOT here — it fetches.
  'feGaussianBlur', 'feOffset', 'feBlend', 'feColorMatrix', 'feMerge',
  'feMergeNode', 'feComposite', 'feFlood', 'feDropShadow',
  'style',
];

/**
 * Presentation and geometry attributes. SVG attribute names are
 * case-sensitive (`viewBox`, `gradientUnits`), so the parser below is told
 * not to lower-case anything and this list carries the exact spellings.
 */
const SVG_ATTRS = [
  'id', 'class', 'style',
  'xmlns', 'xmlns:xlink', 'version',
  'width', 'height', 'viewBox', 'preserveAspectRatio',
  'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry',
  'd', 'points', 'transform', 'transform-origin',
  'fill', 'fill-rule', 'fill-opacity',
  'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
  'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-opacity',
  'opacity', 'color', 'display', 'visibility', 'overflow', 'vector-effect',
  'clip-path', 'clip-rule', 'mask', 'filter', 'marker-start', 'marker-mid', 'marker-end',
  'offset', 'stop-color', 'stop-opacity',
  'gradientUnits', 'gradientTransform', 'spreadMethod',
  'patternUnits', 'patternContentUnits', 'patternTransform',
  'clipPathUnits', 'maskUnits', 'maskContentUnits',
  'markerUnits', 'markerWidth', 'markerHeight', 'refX', 'refY', 'orient',
  'filterUnits', 'primitiveUnits', 'stdDeviation', 'dx', 'dy', 'result', 'in', 'in2',
  'flood-color', 'flood-opacity', 'mode', 'type', 'values', 'operator',
  'font-family', 'font-size', 'font-weight', 'font-style',
  'text-anchor', 'dominant-baseline', 'letter-spacing', 'startOffset',
  'href', 'xlink:href',
  'aria-hidden', 'aria-label', 'role', 'focusable',
];

/**
 * Decode CSS escape sequences to their literal characters.
 *
 * CSS lets `url` be spelled `\75 rl`, `u\72 l`, `\000075rl` — the tokenizer
 * decodes all of them back to `url(`, but a regex over the raw text never
 * sees it. So every scrub below runs on the DECODED string: `\75 rl(evil)`
 * becomes `url(evil)` and is caught, and `\40 import` becomes `@import`.
 * Decoding first is what makes the token-level removals actually exhaustive.
 */
function decodeCssEscapes(css: string): string {
  return css
    .replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_m, hex) => {
      const cp = parseInt(hex, 16);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
    })
    .replace(/\\(.)/g, '$1');
}

/** True when the value carries a url() pointing anywhere but a local #fragment. */
function hasExternalUrl(value: string): boolean {
  return /url\s*\(\s*['"]?\s*(?!#)/i.test(decodeCssEscapes(value));
}

/** CSS that fetches or executes, removed wherever CSS survives. */
function scrubSvgCss(css: string): string {
  return decodeCssEscapes(css)
    .replace(/@import[^;]*(;|$)/gi, '')
    .replace(/expression\s*\(/gi, 'removed(')
    .replace(/url\s*\(\s*(['"]?)(?!#)[^)]*\)/gi, 'none')
    .replace(/-moz-binding[^;]*(;|$)/gi, '');
}

const OPTIONS: sanitizeHtmlLib.IOptions = {
  allowedTags: SVG_TAGS,
  allowedAttributes: { '*': SVG_ATTRS },
  // sanitize-html warns that allowing <style> is dangerous, and it is right
  // in general. Here the risk is accounted for twice over: every surviving
  // <style> block is scrubbed of url()/@import/expression in a post-pass
  // below, and the serving route adds `default-src 'none'` per file.
  allowVulnerableTags: true,
  // XML mode: SVG tag and attribute names keep their case, and elements like
  // <title> are not given HTML special treatment.
  parser: { lowerCaseTags: false, lowerCaseAttributeNames: false, xmlMode: true },
  allowedSchemes: [],
  // Per-attribute hard rules that an allow-list alone cannot express.
  transformTags: {
    '*': (tagName, attribs) => {
      const out: Record<string, string> = {};
      for (const [name, value] of Object.entries(attribs)) {
        // References must stay inside the document. This is the whole
        // external-fetch / javascript: / SSRF class in one rule.
        if ((name === 'href' || name === 'xlink:href') && !value.trim().startsWith('#')) continue;
        if (name === 'style') {
          const scrubbed = scrubSvgCss(value);
          if (scrubbed.trim()) out[name] = scrubbed;
          continue;
        }
        // Paint and reference attributes — fill, stroke, filter, mask,
        // clip-path, marker-start/mid/end — accept a `url(...)` value. A
        // local `url(#gradient)` is the common, legitimate case; an EXTERNAL
        // `url(https://attacker/x.svg#f)` is a beacon Firefox fetches
        // (referer + IP leak, SSRF), the href rule above in attribute form.
        // Drop any attribute that points a url() out of the document.
        if (hasExternalUrl(value)) continue;
        out[name] = value;
      }
      return { tagName, attribs: out };
    },
  },
};

/**
 * Cheap structural check: is this buffer an SVG document?
 *
 * Called only AFTER the magic-byte sniff has said "not a raster, not a PDF",
 * so a PNG renamed to .svg never reaches this. Tolerates a BOM, the XML
 * declaration, comments and a DOCTYPE before the root element — all of which
 * real exports carry — but requires the first actual element to be <svg.
 */
export function looksLikeSvg(buf: Buffer): boolean {
  if (buf.length < 4 || buf.length > 10 * 1024 * 1024) return false;
  let text = buf.subarray(0, 4096).toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  // Strip leading XML declaration, comments, doctype and whitespace.
  let prev = '';
  while (prev !== text) {
    prev = text;
    text = text.replace(/^\s+/, '')
      .replace(/^<\?xml[^>]*\?>/i, '')
      .replace(/^<!--[\s\S]*?-->/, '')
      .replace(/^<!DOCTYPE[^>]*>/i, '');
  }
  return /^<svg[\s>]/i.test(text);
}

/**
 * Sanitize an SVG document. Returns the safe serialization, or null when the
 * input does not survive as a usable SVG (no root element left).
 */
export function sanitizeSvg(text: string): string | null {
  let cleaned = sanitizeHtmlLib(text, OPTIONS).trim();
  if (!/^<svg[\s>]/i.test(cleaned)) return null;

  // <style> text survives sanitize-html untouched (style is an allowed tag);
  // scrub each block so CSS cannot fetch or execute.
  cleaned = cleaned.replace(
    /(<style[^>]*>)([\s\S]*?)(<\/style>)/gi,
    (_m, open, css, close) => `${open}${scrubSvgCss(css)}${close}`,
  );

  // An <img src="/uploads/x.svg"> renders nothing without the namespace, and
  // plenty of hand-written files omit it.
  if (!/^<svg[^>]*\sxmlns=/i.test(cleaned)) {
    cleaned = cleaned.replace(/^<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  }
  return cleaned;
}

/**
 * Intrinsic dimensions, best effort: explicit width/height attributes first
 * (px or unitless only — a percentage is not a fact about the image), then
 * the viewBox. Absent is fine; the record simply carries no dimensions.
 */
export function svgDimensions(svg: string): { width?: number; height?: number } {
  const root = svg.match(/^<svg[^>]*>/i)?.[0] ?? '';
  const attr = (name: string): string | null => {
    const m = root.match(new RegExp(`\\b${name}="([^"]*)"`, 'i'));
    return m ? m[1].trim() : null;
  };
  const px = (v: string | null): number | undefined => {
    if (!v) return undefined;
    const m = v.match(/^(\d+(?:\.\d+)?)(px)?$/);
    if (!m) return undefined;
    const n = Math.round(Number(m[1]));
    return n > 0 ? n : undefined;
  };
  const w = px(attr('width'));
  const h = px(attr('height'));
  if (w && h) return { width: w, height: h };
  const vb = attr('viewBox')?.split(/[\s,]+/).map(Number);
  if (vb && vb.length === 4 && vb[2] > 0 && vb[3] > 0) {
    return { width: Math.round(vb[2]), height: Math.round(vb[3]) };
  }
  return w || h ? { width: w, height: h } : {};
}
