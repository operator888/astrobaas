/**
 * Editorial AI tasks — the writing assistant (C-163) and draft translation
 * (C-134).
 *
 * ## Why one module for two roadmap rows
 *
 * They are the same operation: take the editor's text, give the model one
 * instruction about it, hand the answer back. Written as two features they
 * would be two prompt builders, two endpoints, two sets of bounds, and two
 * places to forget that a machine draft must never be published unread. The
 * difference between "shorten this" and "translate this into German" is one
 * string.
 *
 * ## What a task is NOT allowed to be
 *
 * A task never WRITES. Every one of these returns text to the browser and stops
 * there; a human presses save. An assistant that edits the record directly is a
 * data-loss shape with a friendly name — the operator's own words are gone and
 * the audit log says a person did it.
 *
 * ## The provider is the operator's own
 *
 * There is no AstroBaaS key, here or anywhere. These run through the same
 * bring-your-own credential the public chat bubble uses, which means they cost
 * the operator money per call — so the endpoint that runs them is authenticated,
 * capability-gated and bounded, unlike the public one which is merely bounded.
 */
import { ASSISTANT_LIMITS } from './ai-assistant';
import { sanitizeHtml } from './sanitize';
import { plainText } from './html-text';

export type AiTaskId =
  | 'improve'
  | 'shorten'
  | 'excerpt'
  | 'title'
  | 'meta_description'
  | 'translate';

export interface AiTask {
  id: AiTaskId;
  /** Shown on the button. */
  label: string;
  /** Shown under it, so an editor knows what they are about to spend. */
  hint: string;
  /** Longest input this task accepts, in characters. */
  maxInput: number;
  /** `translate` needs a target language; the rest do not. */
  needsLocale?: boolean;
  /**
   * What the answer IS, which decides how it is cleaned before anybody sees it.
   *
   * `html` goes through the same sanitizer post bodies go through; `text` has
   * its tags removed entirely. The provider is the operator's own, but its base
   * URL is a setting and a hostile one could answer with `<img onerror=…>`.
   * The admin CSP has no `unsafe-inline` and would block that handler — this is
   * the second door, and it is on the server where every caller passes it.
   */
  output: 'html' | 'text';
}

/**
 * The catalogue.
 *
 * `maxInput` is per task rather than global because the inputs differ by two
 * orders of magnitude: a title is a line, an article is a page. One shared cap
 * would either truncate articles or let a title field post 8 kB.
 */
export const AI_TASKS: readonly AiTask[] = [
  {
    id: 'improve',
    output: 'html',
    label: 'Improve writing',
    hint: 'Tightens the prose and fixes grammar. Keeps your meaning, your language and your HTML.',
    maxInput: 12_000,
  },
  {
    id: 'shorten',
    output: 'html',
    label: 'Make it shorter',
    hint: 'Roughly half the length, same points, same language.',
    maxInput: 12_000,
  },
  {
    id: 'excerpt',
    output: 'text',
    label: 'Draft an excerpt',
    hint: 'One or two sentences for listings and cards, from the body you have written.',
    maxInput: 12_000,
  },
  {
    id: 'title',
    output: 'text',
    label: 'Suggest titles',
    hint: 'Five options, one per line. Nothing is applied until you pick one.',
    maxInput: 12_000,
  },
  {
    id: 'meta_description',
    output: 'text',
    label: 'Draft a search description',
    hint: 'Under 160 characters, for the search-result snippet.',
    maxInput: 12_000,
  },
  {
    id: 'translate',
    output: 'html',
    label: 'Draft a translation',
    hint: 'A first draft in another language, for you to read before it goes anywhere.',
    maxInput: 12_000,
    needsLocale: true,
  },
] as const;

export function getAiTask(id: string): AiTask | undefined {
  return AI_TASKS.find((t) => t.id === id);
}

/**
 * A language NAME for the model, from a BCP-47 tag.
 *
 * `Intl.DisplayNames` is in every runtime this ships on, so the list of
 * languages is the platform's rather than a table here that would go stale and
 * be wrong for exactly the locale an operator added last week. English names
 * because the instruction around them is in English; the model is being told
 * which language to write, not being written to in it.
 */
export function languageName(locale: string): string {
  const tag = String(locale ?? '').trim().replace('_', '-');
  if (!tag) return '';
  try {
    const dn = new Intl.DisplayNames(['en'], { type: 'language' });
    return dn.of(tag) ?? tag;
  } catch {
    return tag;
  }
}

/**
 * The instruction sent as the system prompt.
 *
 * ## Two rules every task repeats, deliberately
 *
 * 1. **Answer with the text only.** A model that says "Sure! Here's a tighter
 *    version:" produces an excerpt beginning with "Sure!" the moment an editor
 *    presses apply. Saying it once per prompt is cheaper than stripping
 *    preambles we cannot enumerate.
 *
 * 2. **Keep the language.** Both live installs write Greek. A helper that
 *    silently answers in English because the instruction was in English is not
 *    a rough edge, it is the feature not working. `translate` is the one task
 *    that changes language, and it is told exactly which one.
 *
 * The operator's own assistant persona is NOT used. `cfg.systemPrompt` is
 * written for a shop's visitors ("you are the assistant for Example Optics, be
 * friendly, mention our opening hours"), and inheriting it here would produce
 * an excerpt in a sales voice with opening hours in it.
 */
export function taskPrompt(task: AiTask, targetLocale?: string): string {
  const only = 'Reply with the requested text and nothing else: no preamble, no explanation, no quotation marks around it, no markdown code fence.';
  const keep = 'Write in the same language as the input.';

  switch (task.id) {
    case 'improve':
      return `You are an editor. Rewrite the text the user sends so it reads better: clearer sentences, correct grammar and spelling. Do not add facts, do not remove any, and do not change the meaning. ${keep} If the input contains HTML tags, keep exactly the same tags and structure and change only the text between them. ${only}`;
    case 'shorten':
      return `You are an editor. Rewrite the text the user sends at roughly half the length, keeping every point it makes and dropping only words. ${keep} If the input contains HTML tags, keep the structure valid. ${only}`;
    case 'excerpt':
      return `Write a summary of the text the user sends, for a listing card: one or two sentences, at most 300 characters, plain text with no HTML. It must stand alone for a reader who has not opened the article. ${keep} ${only}`;
    case 'title':
      return `Suggest five alternative titles for the text the user sends. One per line, no numbering, no bullets, each under 70 characters. ${keep} ${only}`;
    case 'meta_description':
      return `Write a search-engine description of the text the user sends: one sentence under 160 characters, plain text, describing what the page is about rather than advertising it. ${keep} ${only}`;
    case 'translate': {
      const name = languageName(targetLocale ?? '');
      // Guarded rather than trusted: an empty language name would produce
      // "Translate into ." and a model that guesses. The endpoint rejects a
      // missing locale before it gets here; this is the second door.
      if (!name) return '';
      return `Translate the text the user sends into ${name}. Translate only — do not summarise, do not improve, do not add or remove anything. If the input contains HTML tags, keep exactly the same tags and structure and translate only the text between them. Leave names of people, brands and products as they are. ${only}`;
    }
    default:
      return '';
  }
}

/**
 * What the model may spend on an answer.
 *
 * The public bubble's 800 tokens is a chat reply. Rewriting a full article
 * needs the whole article back, and a truncated rewrite is worse than none —
 * an editor pastes it in and loses the last third of their post.
 */
export const AI_TASK_REPLY_TOKENS = 4000;

/**
 * Strip markup until decoding cannot produce any more of it.
 *
 * `sanitizeHtml` removes tags; `plainText` removes what is left AND decodes
 * entities, which can reveal tags that were encoded. One round therefore leaves
 * `&lt;img …&gt;` live, and two leave `&amp;lt;img …&gt;` live. Iterating to a
 * fixed point removes the whole family, and converges in practice after two or
 * three rounds because each pass strictly shortens the string.
 *
 * The cap is a backstop, not a limit anybody should reach. If it is ever hit
 * the value is returned with its angle brackets neutralised rather than
 * trusted — a caller of this function writes the result into a DOM field.
 */
function toPlainFixedPoint(input: string): string {
  let current = String(input ?? '');
  for (let i = 0; i < 6; i += 1) {
    const next = plainText(sanitizeHtml(current));
    if (next === current) return next;
    current = next;
  }
  return current.replace(/[<>]/g, '');
}

/** Bounds, checked before a request costs the operator anything. */
export function taskInputProblem(task: AiTask, text: string, targetLocale?: string): string | null {
  if (!text.trim()) return 'There is nothing to work on yet — write something first.';
  if (text.length > task.maxInput) {
    return `That is ${text.length.toLocaleString()} characters; this action takes up to ${task.maxInput.toLocaleString()}.`;
  }
  if (task.needsLocale && !languageName(targetLocale ?? '')) return 'Choose a language to translate into.';
  return null;
}

/**
 * Trim a model's answer.
 *
 * Belt and braces to the "text only" instruction: the fence and the wrapping
 * quotes are the two preambles that survive it often enough to matter, and both
 * are unambiguous to strip. Anything cleverer would start eating real content.
 */
export function cleanTaskReply(task: AiTask, raw: string): string {
  let out = String(raw ?? '').trim();
  const fence = /^```[a-z]*\n([\s\S]*?)\n?```$/i.exec(out);
  if (fence) out = fence[1].trim();
  if (out.length > 1 && out.startsWith('"') && out.endsWith('"') && !out.slice(1, -1).includes('"')) {
    out = out.slice(1, -1).trim();
  }
  out = out.slice(0, ASSISTANT_LIMITS.message * 8);

  // An excerpt or a meta description is a plain-text field. A model that
  // wrapped its answer in <p> would put the tag INTO the field, where it shows
  // up escaped in a listing card and in a search snippet.
  //
  // `plainText`, not a second strip-tags: it drops <script>/<style> BODIES
  // rather than keeping them as words, and decodes entities — so an answer
  // containing `&amp;` becomes `&` in the field instead of the literal five
  // characters. A local regex would have got both wrong, and a guard in
  // shared-lib.test.mjs caught the first draft of this line doing exactly that.
  //
  // But DECODING is the problem as well as the point. A provider answering
  // `&lt;img src=x onerror=…&gt;` survives the sanitizer as escaped text, and
  // `plainText` then turns it back into live markup — which the editor writes
  // into a field, and for the body into `innerHTML`.
  //
  // Running the pair TWICE is not enough either: `&amp;lt;script&amp;gt;`
  // needs three passes, and nothing stops a fourth level of nesting. So it runs
  // to a FIXED POINT — until decoding-then-sanitising stops changing the string
  // — which is the only version of this that does not have a next counterexample.
  // Bounded, because a fixed point is an assumption and a loop is not the place
  // to bet on one.
  if (task.output === 'text') return toPlainFixedPoint(out);
  return sanitizeHtml(out);
}
