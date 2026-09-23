/**
 * The admin's small shared UI vocabulary — the one implementation.
 *
 * ## Why this file exists
 *
 * Six admin screens carried a byte-identical `flash()`:
 *
 * ```js
 * el.className = 'mb-4 px-3 py-2 rounded-md border text-sm ' +
 *   (kind === 'success' ? 'bg-green-50 …' : 'bg-red-50 …');
 * ```
 *
 * Nine more screens are being added, which would have made fifteen. They would
 * then have drifted on the error colour, which is exactly the kind of
 * inconsistency nobody files a bug about and everybody notices.
 *
 * ## Class names are written out, never composed
 *
 * Tailwind scans source TEXT for class names. A computed `bg-${c}-50` is not in
 * the generated stylesheet and the notice silently renders unstyled — right in
 * dev where the JIT has seen every class, wrong in a production build. So every
 * class here is a complete literal string, and this module can be imported into
 * an admin `<script>` where Tailwind will find them.
 *
 * ## Text is set with `textContent`, never `innerHTML`
 *
 * A flash message frequently contains an error string from the server, which
 * frequently contains something the user typed. `innerHTML` there is a
 * self-XSS with extra steps, and the strict CSP would not save it — the markup
 * would be injected by our own trusted script.
 */

export type NoticeKind = 'success' | 'error' | 'info' | 'warn';

/**
 * The complete class attribute for a notice of this kind.
 *
 * Full literals per branch. See the note above about Tailwind's scanner — the
 * shared prefix is repeated in each string on purpose rather than concatenated,
 * because a concatenation is exactly what the scanner cannot follow.
 */
export function noticeClasses(kind: NoticeKind = 'info'): string {
  switch (kind) {
    case 'success':
      return 'mb-4 px-3 py-2 rounded-md border text-sm bg-green-50 border-green-200 text-green-700';
    case 'error':
      return 'mb-4 px-3 py-2 rounded-md border text-sm bg-red-50 border-red-200 text-red-700';
    case 'warn':
      return 'mb-4 px-3 py-2 rounded-md border text-sm bg-amber-50 border-amber-200 text-amber-800';
    default:
      return 'mb-4 px-3 py-2 rounded-md border text-sm bg-blue-50 border-blue-200 text-blue-700';
  }
}

/**
 * Show a message in a notice element, or hide it.
 *
 * `el` is whatever `getElementById` returned, so it is typed loosely and a
 * missing element is a no-op rather than a thrown error — a screen that changed
 * its markup should not take its own save button down.
 *
 * Passing an empty message hides the notice, which is how a screen clears the
 * previous result before starting a new request.
 */
export function flash(
  el: { className: string; textContent: string | null } | null | undefined,
  message: string,
  kind: NoticeKind = 'success',
): void {
  if (!el) return;
  if (!message) {
    el.className = 'hidden';
    el.textContent = '';
    return;
  }
  el.className = noticeClasses(kind);
  // textContent, never innerHTML: this string routinely carries a server error
  // that routinely carries something the user typed.
  el.textContent = message;
}

/**
 * The class attribute for a small status pill.
 *
 * The second thing the admin repeats. Same literal-strings rule.
 */
export function pillClasses(kind: NoticeKind | 'neutral' = 'neutral'): string {
  switch (kind) {
    case 'success':
      return 'inline-block rounded px-2 py-0.5 text-xs font-medium bg-green-50 text-green-700';
    case 'error':
      return 'inline-block rounded px-2 py-0.5 text-xs font-medium bg-red-50 text-red-700';
    case 'warn':
      return 'inline-block rounded px-2 py-0.5 text-xs font-medium bg-amber-50 text-amber-800';
    case 'info':
      return 'inline-block rounded px-2 py-0.5 text-xs font-medium bg-blue-50 text-blue-700';
    default:
      return 'inline-block rounded px-2 py-0.5 text-xs font-medium bg-gray-100 text-gray-700';
  }
}

/**
 * Wire a character counter to a field.
 *
 * There were two, and they disagreed: the edit screen turned the count red past
 * the limit, the create screen did not — so the same over-long meta title
 * looked fine on one page and wrong on the other.
 *
 * The limits are advisory, which is why going past one is amber rather than an
 * error: 60 and 160 are where a search result is CUT, not a rule, and a title
 * of 62 characters is a judgement call the author is allowed to make.
 */
export function charCount(
  input: { value: string; addEventListener: (t: string, f: () => void) => void } | null | undefined,
  counter: { textContent: string | null; className: string } | null | undefined,
  max: number,
): void {
  if (!input || !counter) return;
  // Only the COLOUR is ours. The old version assigned the whole className, so
  // every layout class the markup put on the counter — a float, a margin, a
  // grid placement — was destroyed the first time the author typed a
  // character. It worked only because the two counters that existed happened
  // to carry exactly the classes it wrote back.
  //
  // Full literals on both sides: Tailwind scans source text, so a computed
  // `text-${c}-600` is absent from the stylesheet and the over-limit state
  // would be invisible in production while working in dev.
  const OVER = 'text-amber-600';
  const UNDER = 'text-gray-500';
  const paint = () => {
    const n = String(input.value ?? '').length;
    counter.textContent = `${n}/${max}`;
    const kept = String(counter.className ?? '')
      .split(/\s+/)
      .filter((c) => c && c !== OVER && c !== UNDER);
    kept.push(n > max ? OVER : UNDER);
    counter.className = kept.join(' ');
  };
  input.addEventListener('input', paint);
  paint();
}

/**
 * Relative time, for "last run 4 minutes ago".
 *
 * `Intl.RelativeTimeFormat` rather than a hand-rolled ladder: it is in the
 * runtime, it is localised, and the hand-rolled version is the next thing that
 * would have appeared in six screens.
 */
export function timeAgo(iso: string | number | Date | null | undefined, now = Date.now(), locale?: string): string {
  if (!iso) return '';
  const t = iso instanceof Date ? iso.getTime() : new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const diff = t - now;
  const abs = Math.abs(diff);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 31_536_000_000], ['month', 2_592_000_000], ['day', 86_400_000],
    ['hour', 3_600_000], ['minute', 60_000], ['second', 1000],
  ];
  try {
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
    for (const [unit, ms] of units) {
      if (abs >= ms || unit === 'second') return rtf.format(Math.round(diff / ms), unit);
    }
  } catch { /* unusable locale — fall through */ }
  return new Date(t).toISOString().slice(0, 16).replace('T', ' ');
}
