/**
 * The in-dashboard report (C-107).
 *
 * ## The constraint that shapes this entire file
 *
 * **`post.views` is a running total. There is no time axis for traffic.**
 *
 * Nothing in this codebase records *when* a view happened: `bumpPostViews`
 * writes a counter and deliberately does not touch `updated_at` (the sitemap
 * publishes that as `lastmod`, so a read must never move it). The 404 log keeps
 * `first_seen`/`last_seen` bounds and a total, not a rate. There is no event
 * table and no date-bucketed counter anywhere.
 *
 * So a "views this week" chart cannot be drawn from what exists, and every way
 * of faking one is a lie with a plausible-looking shape:
 *
 *   · spreading a running total across days invents a flat history that never
 *     happened;
 *   · using `publish_date` as the x-axis charts *when articles were written*
 *     and labels it traffic;
 *   · dividing 404 hits by `last_seen − first_seen` invents an average rate for
 *     a path that may have been hit 600 times in one afternoon;
 *   · snapshotting totals from today and charting the deltas produces a chart
 *     that is empty for a fortnight and then silently wrong across a restart,
 *     because the view buffer loses up to one flush interval on every process
 *     death.
 *
 * This report therefore splits into two halves and says which is which on the
 * screen. **Traffic is totals and rankings.** **Outcomes are genuine series**,
 * because orders, messages, subscribers and consent receipts each carry a real
 * per-event `created_at`.
 *
 * That division is the honest answer, not a limitation being worked around. A
 * dashboard that shows a beautiful traffic line nobody can trace to a fact is
 * worse than one that says "totals since counting began" and means it.
 *
 * ## Capped sources
 *
 * Several stores evict: messages and audit events keep 5 000, content changes
 * 1 000, the 404 log 500 distinct paths. A series built over a capped store is
 * complete only back to the oldest surviving row, so every series carries
 * `truncated` and the UI says so. Counting 5 000 messages and calling it "all
 * time" is the same category of error as the invented axis, one step later.
 */

/** One bucket of a daily series. */
export interface DayBucket {
  /** `YYYY-MM-DD`, in UTC. */
  day: string;
  count: number;
  /** Summed money, in cents, when the series carries a value. */
  cents?: number;
}

export interface DaySeries {
  buckets: DayBucket[];
  total: number;
  totalCents?: number;
  /** Highest bucket count, for scaling a chart without a second pass. */
  peak: number;
  /**
   * True when the underlying store evicts and we appear to be at its ceiling,
   * so the oldest buckets may be short. The UI must say so rather than implying
   * the window is complete.
   */
  truncated: boolean;
}

/** UTC day key. Local time would move every bucket for half the world. */
export function dayKey(iso: string | number | Date): string | null {
  const d = iso instanceof Date ? iso : new Date(iso);
  const t = d.getTime();
  if (Number.isNaN(t)) return null;
  return d.toISOString().slice(0, 10);
}

export interface DaySeriesOptions {
  /** How many days back, inclusive of today. */
  days: number;
  /** Treated as "now". Injected so a test has no clock. */
  now: number;
  /** The store's row ceiling, when it has one. Drives `truncated`. */
  cap?: number;
}

/**
 * Bucket timestamped records by UTC day.
 *
 * Empty days are emitted as zero, which is a FACT (nothing happened) rather
 * than a gap — a chart that omits them compresses a quiet fortnight into
 * nothing and makes a flat week look busy.
 */
export function daySeries<T>(
  records: readonly T[],
  at: (r: T) => string | number | Date | null | undefined,
  value: ((r: T) => number) | null,
  opts: DaySeriesOptions,
): DaySeries {
  const days = Math.max(1, Math.min(365, Math.trunc(opts.days)));
  const buckets = new Map<string, DayBucket>();
  const start = new Date(opts.now);
  start.setUTCHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(start.getTime() - i * 86_400_000);
    const k = d.toISOString().slice(0, 10);
    buckets.set(k, value ? { day: k, count: 0, cents: 0 } : { day: k, count: 0 });
  }

  const oldest = start.getTime() - (days - 1) * 86_400_000;
  let total = 0;
  let totalCents = 0;
  for (const r of records) {
    const raw = at(r);
    if (raw === null || raw === undefined) continue;
    const k = dayKey(raw);
    if (!k) continue;
    const b = buckets.get(k);
    // Outside the window. Not an error — the store holds more than we chart.
    if (!b) continue;
    b.count += 1;
    total += 1;
    if (value) {
      const v = value(r);
      if (Number.isFinite(v)) {
        b.cents = (b.cents ?? 0) + v;
        totalCents += v;
      }
    }
  }

  const list = [...buckets.values()];
  return {
    buckets: list,
    total,
    ...(value ? { totalCents } : {}),
    peak: list.reduce((m, b) => Math.max(m, b.count), 0),
    // At the ceiling AND the oldest surviving row is inside the window: the
    // window's early days are missing rows that were evicted. Both conditions
    // matter — a store at its cap whose oldest row predates the window is
    // complete for everything we are charting.
    truncated: Boolean(
      opts.cap
      && records.length >= opts.cap
      && records.some((r) => {
        const k = at(r);
        const t = k ? new Date(k as string).getTime() : NaN;
        return Number.isFinite(t) && t >= oldest;
      })
      && !records.some((r) => {
        const k = at(r);
        const t = k ? new Date(k as string).getTime() : NaN;
        return Number.isFinite(t) && t < oldest;
      }),
    ),
  };
}

/** One row of a ranking. */
export interface RankedRow {
  id: string;
  label: string;
  value: number;
  /** Where the row leads, when it has a page. */
  href?: string;
  /** Secondary fact, e.g. a category name or a referrer. */
  detail?: string;
}

/**
 * Top N by value, dropping zeros.
 *
 * Zeros are dropped rather than shown, because a "top posts" list padded with
 * articles nobody has read is not a ranking — it is the post list in id order,
 * wearing a chart. If fewer than N have any views, the list is short and that
 * is the truthful shape.
 */
export function topBy<T>(
  records: readonly T[],
  value: (r: T) => number,
  row: (r: T, v: number) => RankedRow,
  limit = 10,
): RankedRow[] {
  const scored: { r: T; v: number }[] = [];
  for (const r of records) {
    const v = value(r);
    if (Number.isFinite(v) && v > 0) scored.push({ r, v });
  }
  // Value, then label, so two rows with equal counts do not swap between
  // storage drivers — the shape that shows up as a flaking test long before
  // anyone notices it on screen.
  const rows = scored.map(({ r, v }) => row(r, v));
  rows.sort((a, b) => (b.value - a.value) || a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
  return rows.slice(0, Math.max(0, limit));
}

/** Sum a numeric field, tolerating records written before it existed. */
export function sumBy<T>(records: readonly T[], value: (r: T) => unknown): number {
  let n = 0;
  for (const r of records) {
    const v = Number(value(r));
    if (Number.isFinite(v)) n += v;
  }
  return n;
}

/**
 * Group and total, for "views by category" and its siblings.
 *
 * Records whose key is missing land under `fallbackLabel` rather than being
 * dropped: a blog where half the posts have no category should see that, not a
 * chart quietly drawn over the other half.
 */
export function groupTotals<T>(
  records: readonly T[],
  key: (r: T) => { id: string; label: string } | null,
  value: (r: T) => number,
  fallbackLabel = 'Uncategorised',
): RankedRow[] {
  const acc = new Map<string, RankedRow>();
  for (const r of records) {
    const v = Number(value(r));
    if (!Number.isFinite(v) || v <= 0) continue;
    const k = key(r) ?? { id: '', label: fallbackLabel };
    const cur = acc.get(k.id);
    if (cur) cur.value += v;
    else acc.set(k.id, { id: k.id, label: k.label, value: v });
  }
  const rows = [...acc.values()];
  rows.sort((a, b) => (b.value - a.value) || a.label.localeCompare(b.label));
  return rows;
}

/**
 * Bar geometry for an inline SVG, as fractions of the viewBox width.
 *
 * SVG rather than a styled `<div>`, and this is not a stylistic preference: the
 * production CSP has no `'unsafe-inline'` for styles, so `style="width:62%"` is
 * dropped and the bar renders empty — correct under `astro dev`, wrong in
 * production, silent in both. `<rect width="62">` is a PRESENTATION ATTRIBUTE,
 * which the CSP does not govern, so the same number survives.
 *
 * (The one existing bar in the admin, on the translations screen, is broken for
 * the neighbouring reason: its rules live in a scoped `<style>`, which Astro
 * compiles to `.bar[data-astro-cid-…]`, and the element it styles is created by
 * a script and never carries that attribute.)
 */
export function barWidths(values: readonly number[], viewWidth = 100): number[] {
  const max = values.reduce((m, v) => Math.max(m, Number.isFinite(v) ? v : 0), 0);
  if (max <= 0) return values.map(() => 0);
  return values.map((v) => {
    const n = Number.isFinite(v) && v > 0 ? v : 0;
    // A visible minimum for anything non-zero: a bar of 0.3px reads as absent,
    // and "one view" and "no views" are different facts.
    return n === 0 ? 0 : Math.max(0.8, (n / max) * viewWidth);
  });
}
