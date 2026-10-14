/**
 * Invoice numbers (§14 Abs. 4 Nr. 4 UStG: "fortlaufend", "einmalig").
 *
 * Pure: given a series definition, the date of the document and the current
 * counter, return the next number and the new counter. The repository applies
 * it under a lock and records every issued number, so a number is never
 * handed out twice even if two requests finalize at once.
 *
 * Gaps are legal (several series are allowed, and a cancelled draft never got
 * a number in the first place) — but this module only assigns numbers at
 * finalization, so in practice the sequence has none.
 */
import type { Counter, DocumentType, NumberSeries } from './types';

export const DEFAULT_SERIES: Record<DocumentType, NumberSeries> = {
  invoice: { pattern: 'RE-{YYYY}-{SEQ:4}', reset: 'yearly' },
  credit_note: { pattern: 'GS-{YYYY}-{SEQ:4}', reset: 'yearly' },
  quote: { pattern: 'AN-{YYYY}-{SEQ:4}', reset: 'yearly' },
};

export function periodKey(series: NumberSeries, isoDate: string): string {
  const y = isoDate.slice(0, 4);
  const m = isoDate.slice(5, 7);
  if (series.reset === 'yearly') return y;
  if (series.reset === 'monthly') return `${y}-${m}`;
  return 'all';
}

export function renderNumber(pattern: string, isoDate: string, seq: number): string {
  const y = isoDate.slice(0, 4);
  const m = isoDate.slice(5, 7);
  return pattern
    .replace(/\{YYYY\}/g, y)
    .replace(/\{YY\}/g, y.slice(2))
    .replace(/\{MM\}/g, m)
    .replace(/\{SEQ(?::(\d{1,2}))?\}/g, (_, w) => String(seq).padStart(w ? Number(w) : 1, '0'));
}

/** Validate a user-supplied pattern. Returns a problem, or null. */
export function patternProblem(pattern: string): string | null {
  if (typeof pattern !== 'string' || !pattern.trim()) return 'Pattern is empty.';
  if (pattern.length > 40) return 'Pattern is longer than 40 characters.';
  if (!/\{SEQ(?::\d{1,2})?\}/.test(pattern)) return 'Pattern must contain {SEQ} or {SEQ:n}.';
  const stripped = pattern.replace(/\{(YYYY|YY|MM|SEQ(?::\d{1,2})?)\}/g, '');
  if (/[{}]/.test(stripped)) return 'Unknown token in pattern. Allowed: {YYYY} {YY} {MM} {SEQ} {SEQ:n}.';
  // DATEV Belegfeld 1 allows only these characters; keep numbers exportable.
  if (!/^[A-Za-z0-9$&%*+\-/]*$/.test(stripped)) return 'Only letters, digits and $ & % * + - / are allowed (DATEV Belegfeld 1).';
  return null;
}

export function nextNumber(
  series: NumberSeries,
  isoDate: string,
  counter: Counter | undefined,
): { number: string; counter: Counter } {
  const period = periodKey(series, isoDate);
  const value = counter && counter.period === period ? counter.value + 1 : 1;
  return { number: renderNumber(series.pattern, isoDate, value), counter: { period, value } };
}
