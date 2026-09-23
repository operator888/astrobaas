/**
 * What a product cost, over time — the foundation for the EU Omnibus rule.
 *
 * ## The obligation, in one paragraph
 *
 * Directive (EU) 2019/2161 ("Omnibus") says that when a trader announces a
 * price REDUCTION, they must also state the LOWEST price applied during at
 * least the 30 days before it. Not the previous price, and not the highest —
 * the lowest, so a shop cannot raise a price for a week and then "discount"
 * back to normal. Without stored history that figure is not computable, which
 * meant every advertised discount on an AstroBaaS shop was non-compliant with
 * nothing the operator could do about it.
 *
 * ## Why this is free, in the core
 *
 * A merchant must never be unable to comply with the law because they did not
 * pay. Storing the history is one bounded field and a write when the price
 * moves, so it is core. What sells is the pack on top: the per-country display
 * rules, the "was/now" copy each regulator accepts, and the audit export — all
 * of which need maintaining as national guidance changes, which is exactly what
 * a support commitment is for.
 *
 * ## Why it lives ON the product
 *
 * A separate collection would mean a new entity type on three storage drivers,
 * a row in the change feed for every price edit, and an unbounded table. The
 * obligation looks back 30 days, so a bounded array on the product is the whole
 * requirement: it travels with the record through every driver, through backup
 * and restore, and prunes itself.
 *
 * Integer minor units throughout, like every other price in this system.
 */

/** One observation: this product cost this much, from this moment. */
export interface PricePoint {
  /** Effective price in minor units — what a customer would have paid. */
  p: number;
  /** ISO timestamp the price took effect. */
  at: string;
}

/**
 * How much history to keep.
 *
 * The rule looks back 30 days. Keeping 60 means the window is always fully
 * covered even when a shop edits prices rarely — the point that was live 29
 * days ago may have been recorded 90 days ago, so pruning strictly at 30 would
 * throw away the very figure the rule asks for. See `prunePoints`.
 */
export const PRICE_HISTORY_DAYS = 60;

/** A hard ceiling, so a misbehaving feed cannot grow the field without bound. */
export const PRICE_HISTORY_MAX = 120;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The stored points, oldest first, tolerating a corrupt or absent field. */
export function readPoints(value: unknown): PricePoint[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((x): x is PricePoint =>
      !!x && typeof x === 'object'
      && Number.isFinite((x as PricePoint).p)
      && typeof (x as PricePoint).at === 'string')
    .map((x) => ({ p: Math.round(x.p), at: x.at }))
    .sort((a, b) => a.at.localeCompare(b.at));
}

/**
 * Drop what the window can no longer need.
 *
 * **The point that spans the boundary is KEPT.** A price set 90 days ago and
 * never changed is the price that was live 29 days ago, so deleting it because
 * its timestamp is old would delete the answer. The rule is therefore: keep
 * everything inside the window, plus the single most recent point before it.
 */
export function prunePoints(points: PricePoint[], nowMs: number): PricePoint[] {
  const cutoff = nowMs - PRICE_HISTORY_DAYS * DAY_MS;
  const sorted = [...points].sort((a, b) => a.at.localeCompare(b.at));
  const inside = sorted.filter((x) => Date.parse(x.at) >= cutoff);
  const before = sorted.filter((x) => Date.parse(x.at) < cutoff);
  const kept = before.length ? [before[before.length - 1]!, ...inside] : inside;
  return kept.length > PRICE_HISTORY_MAX ? kept.slice(kept.length - PRICE_HISTORY_MAX) : kept;
}

/**
 * Record `price` if it differs from what is already the latest.
 *
 * Returns the points unchanged when the price has not moved, so a save that
 * edits a product's description does not append a duplicate observation and a
 * sweep that runs every minute does not grow the field.
 */
export function recordPrice(
  existing: unknown,
  price: number | null | undefined,
  nowMs: number = Date.now(),
): PricePoint[] {
  const points = readPoints(existing);
  if (price === null || price === undefined || !Number.isFinite(price)) return points;
  const p = Math.round(price);
  const last = points[points.length - 1];
  if (last && last.p === p) return points;
  return prunePoints([...points, { p, at: new Date(nowMs).toISOString() }], nowMs);
}

/**
 * The lowest price applied in the `days` before `nowMs`, or null.
 *
 * Null means "not enough history to say", and a caller must render nothing
 * rather than guess. Announcing a reference price the shop cannot evidence is
 * the offence this whole module exists to avoid.
 *
 * A point that STARTED before the window still counts, because the price it set
 * was live inside the window — that is why `prunePoints` keeps it.
 */
export function lowestPriceSince(
  existing: unknown,
  nowMs: number = Date.now(),
  days = 30,
): number | null {
  const points = readPoints(existing);
  if (points.length === 0) return null;
  const cutoff = nowMs - days * DAY_MS;
  const inside = points.filter((x) => Date.parse(x.at) >= cutoff);
  const before = points.filter((x) => Date.parse(x.at) < cutoff);
  const relevant = before.length ? [before[before.length - 1]!, ...inside] : inside;
  if (relevant.length === 0) return null;
  return relevant.reduce((lo, x) => (x.p < lo ? x.p : lo), relevant[0]!.p);
}

/**
 * The figure an Omnibus "was" line may state, or null when it must not.
 *
 * ## The window is BEFORE the reduction, not "the last 30 days"
 *
 * The first version of this asked `lowestPriceSince(30 days)` and compared the
 * answer to the current price. That is wrong, and wrong in the direction that
 * makes the feature useless: the current reduced price is itself inside the
 * last 30 days, so it was always the lowest, so the reference was always
 * refused. The directive asks for the lowest price applied in the 30 days
 * BEFORE the reduction — the reduction is the thing being qualified, not part
 * of the evidence for it.
 *
 * So: find when the current price took effect, then look back 30 days from
 * THERE, over the prices that were live before it.
 *
 * Null in four cases, and each is a refusal rather than a gap:
 *  * the product is not on sale — there is no reduction to qualify;
 *  * no history before the reduction — nothing can be evidenced;
 *  * the prior low is not higher than the current price — "was €80, now €80"
 *    is exactly the misleading claim the rule targets;
 *  * the current price is not a number.
 */
export function omnibusReference(
  product: { on_sale?: boolean; price_cents?: number; price_history?: unknown },
  nowMs: number = Date.now(),
  days = 30,
): number | null {
  if (product.on_sale !== true) return null;
  const now = product.price_cents;
  if (!Number.isFinite(now)) return null;

  const points = readPoints(product.price_history);
  if (points.length === 0) return null;

  // Walk back over the trailing run at the current price: that run IS the
  // current reduction, however many times it was re-recorded.
  let i = points.length - 1;
  while (i >= 0 && points[i]!.p === now) i -= 1;
  if (i < 0) return null;               // the price never differed — no reduction
  const reducedAt = Date.parse(points[i + 1]?.at ?? points[i]!.at);
  const priorPoints = points.slice(0, i + 1);

  // The same straddling rule as `prunePoints`: a price set before the window
  // was still live inside it.
  const cutoff = (Number.isFinite(reducedAt) ? reducedAt : nowMs) - days * DAY_MS;
  const inside = priorPoints.filter((x) => Date.parse(x.at) >= cutoff);
  const before = priorPoints.filter((x) => Date.parse(x.at) < cutoff);
  const relevant = before.length ? [before[before.length - 1]!, ...inside] : inside;
  if (relevant.length === 0) return null;

  const low = relevant.reduce((lo, x) => (x.p < lo ? x.p : lo), relevant[0]!.p);
  return low > (now as number) ? low : null;
}

/**
 * The product, plus the one figure a storefront may print beside a sale price.
 *
 * ## Why the CALCULATION is exposed and not just the points
 *
 * The raw `price_history` already travels to a storefront — the product view
 * spreads the record — so for a while this module shipped the evidence and kept
 * the arithmetic. That is the wrong half to keep. The hard part of the Omnibus
 * rule is not storing prices, it is knowing that the window runs from the
 * moment the reduction started rather than from now, and that a point set
 * before the window still counts. Both of those were got wrong in the first
 * implementation here, by somebody reading the directive carefully. Asking
 * every storefront author to rediscover them is asking for the rule to be
 * broken in a way nobody notices.
 *
 * So the API answers the question instead of handing over the workings.
 *
 * `reference_price_cents` is null far more often than not, and null MEANS
 * something: this product may not carry a "was" line. A storefront should
 * render nothing at all rather than fall back to `regular_price_cents`, which
 * is exactly the figure the rule exists to stop shops advertising.
 */
export function withOmnibusReference<T extends {
  on_sale?: boolean; price_cents?: number; price_history?: unknown;
}>(product: T, nowMs: number = Date.now(), days = 30): T & { reference_price_cents: number | null } {
  return { ...product, reference_price_cents: omnibusReference(product, nowMs, days) };
}
