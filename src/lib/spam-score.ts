/**
 * Scoring a public submission (C-79) — the Akismet-shaped hole, filled locally.
 *
 * ## Why not a third-party service
 *
 * Akismet works by sending every submission — its text, the author's name,
 * their email and their IP — to a third party. On a self-hosted CMS whose
 * selling point is that the operator's data stays theirs, that is a data
 * transfer the operator would have to disclose in their own privacy notice, for
 * a signal they can get most of locally. So this is local, and it is honest
 * about being weaker.
 *
 * ## What it does NOT do
 *
 * No phrase dictionary. A list of "spam words" is a list in one language, and
 * both live installs write Greek: a scorer trained on English marketing copy
 * flags an ordinary Greek enquiry and misses the Greek spam entirely. Every
 * signal below is structural — countable without knowing the language.
 *
 * No IP reputation, no phoning home, and no machine learning on the operator's
 * traffic.
 *
 * ## What a score MEANS
 *
 * Nothing is rejected on this. A submission over the threshold is STORED and
 * FLAGGED — `spam_score` and `spam_flagged` on the record — so a person decides.
 * Rejecting on a heuristic means the one enquiry that mattered is the one that
 * vanished, and the sender is told it went through. Holding costs an operator
 * a glance at a list; rejecting costs them a customer they never hear from.
 */
import { extractUrlsFromText } from './link-check';
import { countWords } from './html-text';

/** At or above this, a submission is flagged for review. */
export const SPAM_THRESHOLD = 5;

export interface SpamSignal {
  /** Stable id, so a UI can explain a score without parsing prose. */
  id: string;
  /** What it added to the score. */
  weight: number;
  /** One sentence a person can act on. */
  reason: string;
}

export interface SpamVerdict {
  score: number;
  flagged: boolean;
  signals: SpamSignal[];
}

/** Free-text values out of a submission, in declaration order. */
function textsOf(values: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const v of Object.values(values ?? {})) {
    if (typeof v === 'string' && v.trim()) out.push(v);
  }
  return out;
}

/**
 * Score one submission.
 *
 * Pure and synchronous: it takes the values and returns a verdict, so it can be
 * unit-tested exhaustively and called from the form path, the comment path and
 * a backfill without any of them needing a database.
 */
export function scoreSubmission(values: Record<string, unknown>): SpamVerdict {
  const signals: SpamSignal[] = [];
  const texts = textsOf(values);
  const joined = texts.join('\n');
  const words = countWords(joined);

  // ── links ────────────────────────────────────────────────────────────
  // The single most reliable cheap signal. A person asking a question rarely
  // includes a link; the whole point of link spam is the link.
  const urls = extractUrlsFromText(joined);
  if (urls.length >= 4) {
    signals.push({ id: 'many-links', weight: 4, reason: `${urls.length} links in the message.` });
  } else if (urls.length >= 2) {
    signals.push({ id: 'links', weight: 2, reason: `${urls.length} links in the message.` });
  }

  // A short message that is mostly link is a different shape from a long one
  // that happens to cite a source.
  if (urls.length >= 1 && words > 0 && words < 15) {
    signals.push({ id: 'link-heavy', weight: 3, reason: 'A very short message built around a link.' });
  }

  // ── markup in a plain-text field ─────────────────────────────────────
  // A form field is plain text. Anchor tags and BBCode in one were typed by
  // software, and by software that expected a forum.
  if (/<a\s|\[url[=\]]|\[link[=\]]/i.test(joined)) {
    signals.push({ id: 'markup', weight: 4, reason: 'Link markup in a plain-text field.' });
  }

  // ── shouting and padding ─────────────────────────────────────────────
  const letters = joined.replace(/[^\p{L}]/gu, '');
  if (letters.length >= 20) {
    const upper = (joined.match(/\p{Lu}/gu) ?? []).length;
    if (upper / letters.length > 0.6) {
      signals.push({ id: 'shouting', weight: 2, reason: 'Mostly capital letters.' });
    }
  }
  // `aaaaaaaa`, `!!!!!!!!` — a keyboard-mash or an attention grab. Six is past
  // anything an emphatic person types.
  if (/(.)\1{7,}/u.test(joined)) {
    signals.push({ id: 'repetition', weight: 2, reason: 'A long run of one repeated character.' });
  }

  // ── no words at all ──────────────────────────────────────────────────
  // A submission whose every text field is punctuation or a bare URL.
  if (words === 0 && joined.trim() !== '') {
    signals.push({ id: 'no-words', weight: 3, reason: 'No actual words in the message.' });
  }

  // ── a name that is an address ────────────────────────────────────────
  // Automated submitters routinely put a URL or an email in the name field.
  for (const [key, v] of Object.entries(values ?? {})) {
    if (typeof v !== 'string' || !/name/i.test(key)) continue;
    if (extractUrlsFromText(v).length > 0 || /@/.test(v)) {
      signals.push({ id: 'name-is-a-link', weight: 4, reason: 'The name field contains a link or an address.' });
      break;
    }
  }

  const score = signals.reduce((n, s) => n + s.weight, 0);
  return { score, flagged: score >= SPAM_THRESHOLD, signals };
}
