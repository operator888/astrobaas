/**
 * The editor's content analysis — the "green dot" (C-13).
 *
 * ## Pure, so it runs on every keystroke
 *
 * No `LocalDB`, no `process.env`, no plugin manager — the same discipline
 * `toc.ts`, `link-check.ts` and `insights.ts` hold. That is what lets the post
 * editor import this directly into its `<script>` and re-run it as the author
 * types, with no network call and nothing to rate-limit.
 *
 * ## It reuses the modules that already parse this HTML
 *
 * Headings come from `buildToc`, links from `extractLinks`, images from
 * `imagesMissingAlt`, text from `plainText`. Writing a heading regex here would
 * have been the fourth in the tree, and the first one to disagree with the
 * anchors the page actually renders.
 *
 * ## What it deliberately does NOT do
 *
 * **No Flesch score outside English.** The syllable model has no validated Greek
 * or German port, and a number derived from an English syllable counter over
 * Greek text is exactly the "chart nobody can trace to a fact" that
 * `insights.ts` was written to refuse. Those locales get `unknown`, and the
 * panel says why.
 *
 * **No passive-voice or transition-word detection.** Yoast ships hand-curated
 * word lists per language and there is no Greek one here. Shipping an English
 * list and running it over Greek prose would report confident nonsense.
 *
 * ## A false alarm is the failure that matters
 *
 * An author who is told twice that a correct page is wrong stops reading the
 * panel, and then the real problems go unfixed too. So every check that cannot
 * be computed honestly returns `unknown` rather than guessing, and the effective
 * title and description mirror the SSR fallbacks exactly — scoring a blank
 * `meta_title` as "missing" when the page renders the post title is a lie about
 * the page.
 */
import { plainText, countWords, sentences } from './html-text';
import { buildToc } from './toc';
import { extractLinks } from './link-check';
import { imagesMissingAlt } from './image-dimensions';
import { foldForSearch } from './text-search';

export type CheckVerdict = 'good' | 'improve' | 'bad' | 'unknown';
export type CheckGroup = 'seo' | 'readability';

export interface AnalysisCheck {
  id: string;
  group: CheckGroup;
  verdict: CheckVerdict;
  /** One sentence, addressed to the author, saying what is true and what to do. */
  text: string;
}

export interface ContentFacts {
  title?: string;
  meta_title?: string;
  meta_description?: string;
  excerpt?: string;
  slug?: string;
  content?: string;
  /** The phrase the author wants this page to be found for. Optional. */
  focus_keyphrase?: string;
  /** Content language. Decides whether a readability score can be computed. */
  locale?: string;
  /** Per-record `noindex`. */
  noindex?: boolean;
  /** Site-wide `discourage_indexing`. */
  siteNoindex?: boolean;
}

export interface ContentAnalysis {
  checks: AnalysisCheck[];
  /** 0–100 over the checks that could be judged. */
  score: number;
  dot: 'green' | 'amber' | 'red' | 'grey';
  /** Facts the panel shows next to the dot. */
  stats: { words: number; headings: number; links: number; images: number };
}

/** Google truncates around here. Not a rule — a fact about a search result. */
const TITLE_MAX = 60;
const DESC_MAX = 160;
const DESC_MIN = 70;
/** Below this an article is a note, and the checks below it are noise. */
const THIN_WORDS = 300;
/** Mean words per sentence above which prose gets hard to follow. */
const LONG_SENTENCE = 25;
/** Words between headings above which a reader has nothing to navigate by. */
const LONG_RUN = 350;

/** English only — see the module note. */
const FLESCH_LOCALES = new Set(['en']);

function lang(locale?: string): string {
  return (locale ?? 'en').split('-')[0].toLowerCase();
}

/**
 * Does this text contain the keyphrase?
 *
 * Through `foldForSearch`, so a Greek author's «Γυαλιά Ηλίου» matches a body
 * that says «γυαλιά ηλίου» — accents and capitals are not a different phrase,
 * and a checker that says otherwise is wrong on every Greek page.
 */
function contains(haystack: string, phrase: string): boolean {
  if (!phrase) return false;
  return foldForSearch(haystack).includes(foldForSearch(phrase));
}

/**
 * The same test against a SLUG, where the words are joined by hyphens.
 *
 * `contains` folds case and accents and collapses whitespace; it never turns a
 * hyphen into a space. A slug is hyphenated by construction, so
 * `sunglasses-for-summer` could not contain `sunglasses for summer` and the
 * check reported "the keyphrase is not in the URL" for a URL that is nothing
 * but the keyphrase. Every multi-word keyphrase failed it, which is most of
 * them — and an author who acts on the advice edits a slug that was correct.
 */
function containsInSlug(slug: string, phrase: string): boolean {
  return contains(String(slug ?? '').replace(/[-_]+/g, ' '), phrase);
}

/**
 * Syllables in an English word, approximately.
 *
 * Vowel groups, minus a silent trailing `e`, floor of one. Approximate by
 * design and used only for Flesch, which is itself an approximation — the point
 * is to notice "these sentences are long and the words are heavy", not to
 * publish a number to two decimal places.
 */
function syllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 0;
  const groups = w.match(/[aeiouy]+/g);
  let n = groups ? groups.length : 1;
  if (w.length > 2 && w.endsWith('e') && !/[aeiouy]e$/.test(w)) n -= 1;
  return Math.max(1, n);
}

/** Flesch Reading Ease. English only; the caller checks the locale. */
function flesch(text: string): number | null {
  const sents = sentences(text);
  const words = text.split(/\s+/).filter(Boolean);
  if (sents.length === 0 || words.length === 0) return null;
  const syl = words.reduce((n, w) => n + syllables(w), 0);
  return 206.835 - 1.015 * (words.length / sents.length) - 84.6 * (syl / words.length);
}

/** Longest run of words between two headings — where a reader loses their place. */
function longestRunBetweenHeadings(html: string, headings: number): number {
  if (headings === 0) return countWords(html);
  // Split on the heading tags themselves rather than re-parsing: buildToc has
  // already told us how many there are, and this only needs the gaps.
  const parts = html.split(/<h[2-4]\b[^>]*>/i);
  return parts.reduce((max, part) => Math.max(max, countWords(part)), 0);
}

const good = (id: string, group: CheckGroup, text: string): AnalysisCheck => ({ id, group, verdict: 'good', text });
const improve = (id: string, group: CheckGroup, text: string): AnalysisCheck => ({ id, group, verdict: 'improve', text });
const bad = (id: string, group: CheckGroup, text: string): AnalysisCheck => ({ id, group, verdict: 'bad', text });
const unknown = (id: string, group: CheckGroup, text: string): AnalysisCheck => ({ id, group, verdict: 'unknown', text });

/**
 * Analyse one record.
 *
 * Same inputs, same output — no clock, no randomness, no I/O. That is what lets
 * the editor call it on every keystroke and a test pin every branch.
 */
export function analyzeContent(facts: ContentFacts): ContentAnalysis {
  const html = facts.content ?? '';
  const text = plainText(html);
  const words = countWords(html);
  const toc = buildToc(html);
  const links = extractLinks(html);
  const noAlt = imagesMissingAlt(html);
  const imageCount = (html.match(/<img\b/gi) ?? []).length;
  const internal = links.filter((l) => l.kind === 'internal').length;
  const external = links.filter((l) => l.kind === 'external').length;

  const stats = { words, headings: toc.items.length, links: internal + external, images: imageCount };

  // A page deliberately kept out of search is not failing at being found. Every
  // discoverability check below would be a false alarm, so none of them run.
  if (facts.noindex || facts.siteNoindex) {
    return {
      checks: [unknown('hidden', 'seo', facts.noindex
        ? 'This page is set to stay out of search results, so there is nothing to optimise for search.'
        : 'The whole site is set to stay out of search results, so there is nothing to optimise for search.')],
      score: 0,
      dot: 'grey',
      stats,
    };
  }

  const checks: AnalysisCheck[] = [];

  // ── Title ────────────────────────────────────────────────────────────────
  // The EFFECTIVE title, mirroring blog/[slug].astro exactly. Scoring a blank
  // meta_title as "missing" when the page renders the post title is a lie.
  const title = (facts.meta_title?.trim() || facts.title || '').trim();
  if (!title) checks.push(bad('title', 'seo', 'This page has no title yet.'));
  else if (title.length > TITLE_MAX) {
    checks.push(improve('title', 'seo', `The title is ${title.length} characters; search results cut off around ${TITLE_MAX}.`));
  } else if (title.length < 25) {
    checks.push(improve('title', 'seo', `The title is only ${title.length} characters — there is room to say more.`));
  } else checks.push(good('title', 'seo', `The title fits a search result (${title.length} characters).`));

  // ── Description ──────────────────────────────────────────────────────────
  const desc = (facts.meta_description?.trim() || facts.excerpt || '').trim();
  if (!desc) {
    checks.push(improve('description', 'seo', 'No description, so a search engine will pick a sentence from the page itself.'));
  } else if (desc.length > DESC_MAX) {
    checks.push(improve('description', 'seo', `The description is ${desc.length} characters; it will be cut around ${DESC_MAX}.`));
  } else if (desc.length < DESC_MIN) {
    checks.push(improve('description', 'seo', `The description is ${desc.length} characters — under about ${DESC_MIN} it usually wastes the space.`));
  } else checks.push(good('description', 'seo', `The description fits (${desc.length} characters).`));

  // ── Focus keyphrase ──────────────────────────────────────────────────────
  const phrase = (facts.focus_keyphrase ?? '').trim();
  if (!phrase) {
    // NOT a failure. Most posts do not target a phrase, and marking that red
    // would make the dot red on a perfectly good article.
    checks.push(unknown('keyphrase', 'seo', 'No focus keyphrase set, so the phrase checks are skipped.'));
  } else {
    checks.push(contains(title, phrase)
      ? good('kp-title', 'seo', 'The keyphrase is in the title.')
      : improve('kp-title', 'seo', 'The keyphrase is not in the title, which is where it counts most.'));
    checks.push(contains(desc, phrase)
      ? good('kp-desc', 'seo', 'The keyphrase is in the description.')
      : improve('kp-desc', 'seo', 'The keyphrase is not in the description.'));
    checks.push(containsInSlug(facts.slug ?? '', phrase)
      ? good('kp-slug', 'seo', 'The keyphrase is in the URL.')
      : improve('kp-slug', 'seo', 'The keyphrase is not in the URL.'));

    const firstPara = plainText((html.match(/<p\b[^>]*>[\s\S]*?<\/p>/i) ?? [''])[0]) || text.slice(0, 300);
    checks.push(contains(firstPara, phrase)
      ? good('kp-intro', 'seo', 'The keyphrase appears in the opening paragraph.')
      : improve('kp-intro', 'seo', 'The keyphrase is not in the opening paragraph, where a reader checks they are in the right place.'));

    checks.push(toc.items.some((h) => contains(h.text, phrase))
      ? good('kp-heading', 'seo', 'The keyphrase appears in a subheading.')
      : improve('kp-heading', 'seo', 'The keyphrase is in no subheading.'));

    const folded = foldForSearch(text);
    const needle = foldForSearch(phrase);
    const occurrences = needle ? folded.split(needle).length - 1 : 0;
    const density = words > 0 ? (occurrences * countWords(phrase)) / words : 0;
    if (occurrences === 0) checks.push(bad('kp-body', 'seo', 'The keyphrase does not appear in the text at all.'));
    else if (density > 0.03) checks.push(bad('kp-body', 'seo', `The keyphrase appears ${occurrences} times — often enough to read as padding.`));
    else checks.push(good('kp-body', 'seo', `The keyphrase appears ${occurrences} time${occurrences === 1 ? '' : 's'} in the text.`));
  }

  // ── Links ────────────────────────────────────────────────────────────────
  checks.push(internal > 0
    ? good('links-internal', 'seo', `${internal} link${internal === 1 ? '' : 's'} to your own pages.`)
    : improve('links-internal', 'seo', 'No links to your own pages, so this article is a dead end.'));
  checks.push(external > 0
    ? good('links-external', 'seo', `${external} link${external === 1 ? '' : 's'} out to a source.`)
    : improve('links-external', 'seo', 'No outbound links. Citing a source is worth more than it costs.'));

  // ── Images ───────────────────────────────────────────────────────────────
  if (imageCount === 0) {
    checks.push(improve('images', 'seo', 'No images. One picture makes an article easier to scan.'));
  } else if (noAlt.length > 0) {
    checks.push(bad('images', 'seo', `${noAlt.length} of ${imageCount} image${imageCount === 1 ? '' : 's'} ${noAlt.length === 1 ? 'has' : 'have'} no description, so a screen reader skips ${noAlt.length === 1 ? 'it' : 'them'}.`));
  } else {
    checks.push(good('images', 'seo', `All ${imageCount} image${imageCount === 1 ? '' : 's'} described.`));
  }

  // ── Length ───────────────────────────────────────────────────────────────
  checks.push(words >= THIN_WORDS
    ? good('length', 'readability', `${words} words.`)
    : improve('length', 'readability', `${words} words — short enough that a search engine may treat it as thin.`));

  // ── Headings ─────────────────────────────────────────────────────────────
  if (words < THIN_WORDS && toc.items.length === 0) {
    // A 120-word note does not need subheadings, and demanding them is the kind
    // of false alarm that gets the panel ignored.
    checks.push(good('headings', 'readability', 'Short enough not to need subheadings.'));
  } else if (toc.items.length === 0) {
    checks.push(bad('headings', 'readability', 'No subheadings, so there is nothing to skim by.'));
  } else {
    const run = longestRunBetweenHeadings(html, toc.items.length);
    checks.push(run > LONG_RUN
      ? improve('headings', 'readability', `${run} words go by without a subheading.`)
      : good('headings', 'readability', `${toc.items.length} subheading${toc.items.length === 1 ? '' : 's'}, well spaced.`));
  }

  // ── Sentences ────────────────────────────────────────────────────────────
  const sents = sentences(text);
  if (sents.length === 0) {
    checks.push(unknown('sentences', 'readability', 'Not enough text to judge sentence length.'));
  } else {
    const mean = words / sents.length;
    checks.push(mean > LONG_SENTENCE
      ? improve('sentences', 'readability', `Sentences average ${Math.round(mean)} words. Under ${LONG_SENTENCE} reads more easily.`)
      : good('sentences', 'readability', `Sentences average ${Math.round(mean)} words.`));
  }

  // ── Reading ease ─────────────────────────────────────────────────────────
  if (!FLESCH_LOCALES.has(lang(facts.locale))) {
    checks.push(unknown('flesch', 'readability',
      'A reading-ease score is only meaningful for English; the formula counts English syllables. Sentence length above still applies.'));
  } else {
    const f = flesch(text);
    if (f === null) checks.push(unknown('flesch', 'readability', 'Not enough text to score reading ease.'));
    else if (f < 30) checks.push(improve('flesch', 'readability', `Reading ease ${Math.round(f)} — heavy going.`));
    else if (f < 50) checks.push(improve('flesch', 'readability', `Reading ease ${Math.round(f)} — fairly difficult.`));
    else checks.push(good('flesch', 'readability', `Reading ease ${Math.round(f)}.`));
  }

  // ── Score ────────────────────────────────────────────────────────────────
  // Over the checks that could be JUDGED. An unknown is not a failure: counting
  // "no keyphrase set" against the score would make the dot amber on every post
  // that simply does not target a phrase.
  const judged = checks.filter((c) => c.verdict !== 'unknown');
  const points = judged.reduce((n, c) => n + (c.verdict === 'good' ? 1 : c.verdict === 'improve' ? 0.5 : 0), 0);
  const score = judged.length === 0 ? 0 : Math.round((points / judged.length) * 100);

  return {
    checks,
    score,
    dot: judged.length === 0 ? 'grey' : score >= 80 ? 'green' : score >= 50 ? 'amber' : 'red',
    stats,
  };
}
