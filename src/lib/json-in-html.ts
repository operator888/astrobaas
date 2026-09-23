/**
 * Serialise a value for embedding inside an HTML `<script>` element.
 *
 * ## Why `JSON.stringify` alone is not enough
 *
 * `JSON.stringify` escapes quotes and backslashes. It does NOT escape `<`. So
 * a string containing `</script>` closes the element it is sitting inside,
 * whatever the script's `type` is — `application/ld+json` included. Everything
 * after it is parsed as markup.
 *
 * That is how a post title became an HTML injection sink in the `<head>` of
 * every public post page: an `author` — the lowest role that can create a post
 * — controlled raw markup served to every anonymous visitor. Titles are
 * validated as length-bounded strings, not sanitised as HTML, because they are
 * not supposed to be HTML.
 *
 * `<` is a valid JSON escape for `<`, so the output still parses as JSON
 * while being inert as markup. It also fixes a second, quieter failure: a title
 * containing `</script>` broke `JSON.parse` on the emitted blob, so the
 * structured data silently did not work either.
 *
 * ## Why this file exists rather than a fourth copy
 *
 * This exact expression already appeared three times — assistant.js.ts,
 * consent.js.ts, assistant-widget.js.ts — and the fourth site (the JSON-LD
 * block) simply did not use it. Three copies of a security-relevant helper is
 * how the fourth one gets written without it. There is now one.
 */

/**
 * JSON, safe to place between `<script>` and `</script>`.
 *
 * Use this for EVERY `set:html` of serialised data. `JSON.stringify` on its own
 * is not safe in that position.
 */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value ?? null)
    // Closes the enclosing element regardless of the script's type.
    .replace(/</g, '\\u003c')
    // U+2028/U+2029 are literal line terminators in JavaScript source. Harmless
    // in `application/ld+json`, fatal in a classic script, so escape both here
    // rather than relying on the caller to know which context they are in.
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
