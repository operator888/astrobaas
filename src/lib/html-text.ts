/**
 * Turning content HTML into text — the one implementation.
 *
 * ## Why this file exists
 *
 * There were five copies of `replace(/<[^>]*>/g, …)` in the tree, and **two of
 * them disagreed**: `link-check.ts` replaced a tag with nothing, everything else
 * replaced it with a space. So `<b>ten</b><b>words</b>` was one word to one
 * caller and two to another, and the byline's read time and the search
 * snippet's excerpt were computed from different text.
 *
 * That disagreement is the whole argument for this module. A tag boundary IS a
 * word boundary — `<p>ten</p><p>words</p>` is two words, and stripping without
 * a space silently under-counts every well-formed document while getting badly
 * formed ones right, which is the worst way round.
 *
 * ## Pure, and client-bundleable
 *
 * No `LocalDB`, no `process.env`, no plugin manager — the same discipline
 * `toc.ts`, `link-check.ts` and `insights.ts` hold. That is what lets the editor
 * import the analyzer built on this and run it on every keystroke with no
 * network call.
 */

/** Entities we decode. Sanitized markup, not arbitrary input — see `decodeEntities`. */
const NAMED: ReadonlyArray<readonly [RegExp, string]> = [
  [/&lt;/g, '<'],
  [/&gt;/g, '>'],
  [/&quot;/g, '"'],
  [/&#39;|&apos;/g, "'"],
  [/&nbsp;/g, ' '],
];

/**
 * Decode the entities that appear in sanitized content.
 *
 * Only the five XML ones plus `&nbsp;` and numeric references. A general entity
 * table would be a decoder nobody audited, and this input has already been
 * through `sanitizeHtml`.
 *
 * **Ampersand LAST.** `&amp;lt;` is the text `&lt;`, not the character `<`;
 * decoding `&amp;` first turns it into a tag-looking string. That ordering was
 * worked out once in `toc.ts` and is the reason this lives in one place.
 */
export function decodeEntities(input: string): string {
  let s = input
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCodePoint(parseInt(h, 16)));
  for (const [re, to] of NAMED) s = s.replace(re, to);
  return s.replace(/&amp;/g, '&');
}

/** A numeric reference outside Unicode throws in `fromCodePoint`; leave it as written. */
function safeCodePoint(n: number): string {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return '';
  try {
    return String.fromCodePoint(n);
  } catch {
    return '';
  }
}

/**
 * The visible text of a fragment of content HTML.
 *
 * A SPACE replaces each tag, then entities decode, then whitespace collapses.
 * That order matters: decoding first would let a `&lt;b&gt;` in the prose look
 * like a tag to the stripper.
 *
 * `<script>` and `<style>` bodies are dropped whole rather than kept as text.
 * The sanitizer already removes them from stored content, but this function is
 * also pointed at strings that never went through it — a plugin filter's output,
 * an imported document — and "function(){…}" counted as forty words is a
 * silently wrong read time.
 */
export function plainText(html: string | null | undefined): string {
  if (!html) return '';
  return decodeEntities(
    String(html)
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<[^>]*>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Word count of text or HTML.
 *
 * Splits on whitespace rather than on `\w`, because `\w` is ASCII-only: a Greek
 * or German article would count zero words, on both of this project's live
 * shops, permanently.
 */
export function countWords(input: string | null | undefined): number {
  const text = /<[a-z!/]/i.test(String(input ?? '')) ? plainText(input) : String(input ?? '').trim();
  if (!text) return 0;
  return text.split(/\s+/).length;
}

/**
 * Split text into sentences.
 *
 * **Greek punctuation is not the same punctuation.** Greek writes a question
 * mark as `;` (U+037E, and in practice the ASCII `;` U+003B) and a semicolon as
 * `·` (ano teleia, U+0387). A splitter that knows only `.!?` sees a Greek
 * article as a handful of enormous sentences and reports "far too long" on
 * perfectly ordinary prose — again, on both live shops, permanently.
 *
 * The terminators are therefore the union, which is safe for Latin text too:
 * `;` and `·` do not end sentences in English, but they do separate clauses, so
 * treating them as boundaries makes the average shorter rather than wrong in
 * the direction that produces a false alarm.
 */
export function sentences(input: string | null | undefined): string[] {
  const text = plainText(input) || String(input ?? '').trim();
  if (!text) return [];
  return text
    .split(/[.!?;·;·…]+[\s"'»)\]]*/u)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Trim to a length without cutting a word in half.
 *
 * Used for excerpts and report labels. Returns the input unchanged when it
 * already fits, so a caller can apply it unconditionally.
 */
export function truncateWords(input: string, max: number): string {
  const text = String(input ?? '');
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(' ');
  // Any space at all wins. The first version only used it past 60% of the
  // budget, which meant a long second word (`hello beautiful …` at 12) fell
  // through to the mid-word cut this function exists to prevent — a shorter
  // honest string beats `beauti…`.
  return `${(space > 0 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
