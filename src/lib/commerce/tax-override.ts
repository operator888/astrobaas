/**
 * Manual tax overrides — a human departing, on purpose, from the engine.
 *
 * Pure: this module rewrites a breakdown and returns a record of what it did.
 * It never touches storage, so the same function answers for the admin screen,
 * the API and the tests.
 *
 * ## Why an override may choose a RULE and never a NUMBER
 *
 * The override carries a `tax_class` or `exempt`, never an amount. An amount
 * would make the stored total inexplicable: `net × rate = tax` would stop
 * holding, `totalsReconcile` would start failing on a legitimately-saved order,
 * and the only way to answer "why is this figure what it is" would be to read
 * a free-text note. Choosing a class keeps the arithmetic derivable and keeps
 * the audit question answerable — WHICH rule, chosen by WHOM, and WHY.
 *
 * ## Why it is append-only
 *
 * The whole point of recording an override is that somebody can later ask why
 * an order's VAT is not what the rules say. A record that can be edited answers
 * that question differently depending on when it is asked, which is not an
 * answer. So overrides accumulate, and the ENGINE'S original breakdown is
 * preserved once, on the first override, and never rewritten.
 */
import type { OrderLineBreakdown, TaxOverride } from '../../core/models';
import type { TaxSettings } from './tax';
import { domesticTaxRates, rateForClass, splitTax } from './tax';

export interface OverrideRequest {
  scope: 'order' | 'line';
  line_index?: number;
  tax_class?: string;
  exempt?: boolean;
  reason?: string;
}

export type OverrideResult =
  | { ok: true; lines: OrderLineBreakdown[]; record: TaxOverride; tax_cents: number; total_cents: number }
  | { ok: false; error: string };

/**
 * The rate an override asks for.
 *
 * `exempt` is 0 and is the one case where a zero is a DECISION rather than a
 * missing rate — which is exactly why it has to be spelled as its own field
 * instead of "a class whose rate happens to be 0". A shop that later edits its
 * zero-rated class would otherwise silently change what an exemption meant.
 */
function requestedRate(settings: TaxSettings, req: OverrideRequest): number | null {
  if (req.exempt === true) return 0;
  if (typeof req.tax_class === 'string' && req.tax_class.trim()) {
    const wanted = req.tax_class.trim().toLowerCase();
    // The SHOP's own country-wide rows only. Country-blind, this accepted a
    // class only another country has (Austria's `reduced-2`) and charged its
    // rate; a class that exists at home only as a territory row has no
    // country-wide rate to apply either. Both are refused.
    const known = domesticTaxRates(settings).some((r) => r.class === wanted && !r.postcodes);
    // An unknown class must NOT fall through to the default rate — that would
    // silently apply a different rate than the one the operator picked, on a
    // screen whose entire purpose is picking the rate deliberately.
    return known ? rateForClass(settings, wanted) : null;
  }
  return null;
}

/**
 * Apply an override to a stored breakdown.
 *
 * Recomputes the affected lines from their own `net_cents`, so the result is
 * still `net + tax = total` line by line and `totalsReconcile` keeps holding on
 * the stored order. Shipping is NOT recomputed here — the caller owns that,
 * because shipping tax lives outside `line_totals`.
 */
export function applyTaxOverride(
  lines: readonly OrderLineBreakdown[],
  settings: TaxSettings,
  req: OverrideRequest,
  actor: string,
  now: string = new Date().toISOString(),
): OverrideResult {
  const reason = String(req.reason ?? '').trim();
  if (!reason) {
    return { ok: false, error: 'A reason is required — an override with no reason is indistinguishable from a mistake' };
  }
  if (req.exempt === true && req.tax_class) {
    return { ok: false, error: 'Choose either a tax class or exempt, not both' };
  }
  const rate = requestedRate(settings, req);
  if (rate === null) {
    return { ok: false, error: 'Specify `exempt: true` or a `tax_class` that exists in the tax table' };
  }
  if (!lines.length) return { ok: false, error: 'This order has no line breakdown to override' };

  let targets: number[];
  if (req.scope === 'line') {
    const i = req.line_index;
    if (!Number.isInteger(i) || i === undefined || i < 0 || i >= lines.length) {
      return { ok: false, error: `line_index must be between 0 and ${lines.length - 1}` };
    }
    targets = [i];
  } else {
    targets = lines.map((_, i) => i);
  }

  /*
   * A CLASS override applies the shop's own rate, so it is refused on a line
   * taxed under another treatment. A German consumer's line (destination,
   * 19%) overridden to `standard` would otherwise silently become Greek 24%,
   * and a reverse-charge or export line would gain the home rate. `exempt`
   * is still allowed: zero is zero in every jurisdiction. Re-rating such a
   * line in its own country's table is a separate feature, not a fallback.
   * Lines with no `tax_treatment` are domestic (every line written before
   * destination resolution existed).
   */
  if (req.exempt !== true) {
    const foreign = targets.find((i) => (lines[i].tax_treatment ?? 'domestic') !== 'domestic');
    if (foreign !== undefined) {
      const l = lines[foreign];
      return {
        ok: false,
        error: `Line ${foreign} is taxed as ${l.tax_treatment}${l.tax_jurisdiction ? ` (${l.tax_jurisdiction})` : ''}; `
          + 'a tax class override applies only to domestic lines. Use `exempt: true`, or override domestic lines one at a time.',
      };
    }
  }

  // The engine's answer on the FIRST targeted line, frozen into the record. One
  // number rather than a list because the record's job is to make the change
  // legible, and `line_totals_original` keeps the full detail.
  const was = lines[targets[0]].tax_rate_bp;

  const next = lines.map((l, i) => {
    if (!targets.includes(i)) return l;
    // Recomputed from `net_cents`, which is tax-exclusive by definition, so
    // this is correct whether the shop prices inclusively or not — the
    // inclusive/exclusive question was already settled when net was computed.
    const split = splitTax(l.net_cents, rate, false);
    return {
      ...l,
      tax_cents: split.tax_cents,
      tax_rate_bp: rate,
      total_cents: l.net_cents + split.tax_cents,
      tax_rate_source: 'override' as const,
    };
  });

  const record: TaxOverride = {
    scope: req.scope,
    ...(req.scope === 'line' ? { line_index: targets[0] } : {}),
    ...(req.exempt === true ? { exempt: true as const } : { tax_class: req.tax_class!.trim().toLowerCase() }),
    reason: reason.slice(0, 500),
    actor,
    at: now,
    was_rate_bp: was,
    now_rate_bp: rate,
  };

  return {
    ok: true,
    lines: next,
    record,
    tax_cents: next.reduce((s, l) => s + l.tax_cents, 0),
    total_cents: next.reduce((s, l) => s + l.total_cents, 0),
  };
}
