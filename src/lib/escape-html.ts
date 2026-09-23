/**
 * Escape a string for safe interpolation into HTML built via innerHTML/template
 * literals on the client. Use this for ANY user-controlled value that ends up
 * inside an innerHTML assignment or an HTML attribute (admin SPA list renders).
 *
 * Covers both text-node and double/single-quoted-attribute contexts.
 */
export function escapeHtml(value: unknown): string {
  const s = value == null ? '' : String(value);
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The XML variant, for a sitemap, a feed, or an SVG.
 *
 * Separate from `escapeHtml` because the apostrophe differs and it is not
 * cosmetic: `&#39;` is a NUMERIC reference, legal in both; `&apos;` is a NAMED
 * one, predefined in XML and **absent from HTML 4**. Writing `&apos;` into an
 * HTML attribute is what an old parser renders literally, and writing `&#39;`
 * into XML is merely uglier — so the two escapers exist rather than one that
 * has to be right about which document it is in.
 *
 * Three copies of this stood in `sitemap.xml.ts`, `rss.xml.ts` and the OG image
 * route. Those three agreed, unlike the five HTML copies above.
 */
export function escapeXml(value: unknown): string {
  const s = value == null ? '' : String(value);
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
