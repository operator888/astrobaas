/**
 * The one place an order total is computed.
 *
 * `POST /api/orders/quote` and `placeOrder()` both price through
 * `priceBasket()`, which calls this.
 * That is the entire point of this module: if the cart page and the charge ran
 * different code, they would eventually disagree, and the customer would be
 * billed something other than what they agreed to. There is no second
 * implementation to drift from.
 *
 * Pure — no storage, no network, no clock of its own. Everything it needs is
 * passed in, so the arithmetic that decides what a customer pays is testable
 * without a database.
 *
 * ## Order of operations, and why it is this order
 *
 *   1. line amounts, from stored prices
 *   2. discount, allocated across lines to the cent
 *   3. tax, on the DISCOUNTED amounts
 *   4. shipping, then tax on shipping
 *   5. total
 *
 * Step 3 after step 2 is the one that matters legally: VAT is due on what the
 * customer actually pays. Taxing the pre-discount amount over-collects on every
 * discounted order, and the error compounds silently.
 */

import {
  splitTax, rateForClass, rateForTreatment, productIsTaxable, shippingIsTaxableFor,
  type TaxTreatment,
  type TaxSettings, type TaxSplit,
} from './tax';
import { allocateDiscount } from './coupons';

/** A basket line, already resolved against stored products. */
export interface TotalsLine {
  product_id: string;
  /** Present when a specific variation was chosen. */
  variant_id?: string;
  name: string;
  qty: number;
  /** Stored unit price, in the install's tax convention. */
  unit_price_cents: number;
  tax_class?: string;
  /** 'taxable' | 'shipping' | 'none' */
  tax_status?: string;
  /** Grams per unit; used for weight-based shipping. */
  weight_grams?: number | null;
  requires_shipping?: boolean;
  categories?: string[];
}

export interface TotalsInput {
  lines: readonly TotalsLine[];
  tax: TaxSettings;
  /**
   * Whose tax rules apply, resolved by the caller and INJECTED.
   *
   * Absent means `{ kind: 'domestic' }`, which is what every install did before
   * destination resolution existed — so this module keeps its old behaviour
   * without a flag, and stays pure: it takes the answer rather than going to
   * storage to find it.
   */
  treatment?: TaxTreatment;
  /** Needed only to match a special-territory postcode row. */
  destination_postcode?: string;
  /** Already validated by applyCoupon(); 0 when none. */
  discount_cents?: number;
  /** Shipping cost already resolved server-side; 0/absent when none. */
  shipping_cents?: number;
  /** Tax class for the shipping line; falls back to the configured one. */
  shipping_tax_class?: string;
}

/** Per-line breakdown, kept on the order so an invoice can be produced. */
export interface OrderLineTotals {
  /**
   * Tax provenance, kept in LOCKSTEP with `OrderLineBreakdown` in core/models.
   *
   * These two interfaces describe the same row and have drifted before —
   * `variant_id` exists on this one and not on that one, and the assignment
   * between them is not a fresh object literal so the compiler never
   * complained. Anything added to one belongs on the other in the same commit.
   */
  tax_treatment?: 'domestic' | 'destination' | 'reverse-charge' | 'export';
  tax_jurisdiction?: string;
  tax_rate_source?: 'engine' | 'override';
  product_id: string;
  variant_id?: string;
  name: string;
  qty: number;
  unit_price_cents: number;
  /** qty × unit, before discount. */
  line_subtotal_cents: number;
  /** This line's share of the order discount. */
  discount_cents: number;
  /** Excluding tax, after discount. */
  net_cents: number;
  tax_cents: number;
  tax_rate_bp: number;
  /** net + tax. What this line contributes to the total. */
  total_cents: number;
}

export interface OrderTotals {
  lines: OrderLineTotals[];
  /** Goods before discount, in the display convention (incl. tax if inclusive). */
  subtotal_cents: number;
  discount_cents: number;
  shipping_cents: number;
  shipping_tax_cents: number;
  /** All tax: goods + shipping. */
  tax_cents: number;
  /** The authoritative amount to charge. */
  total_cents: number;
  /** Shipping INCLUDING its tax — what the shipping line costs the customer. */
  shipping_total_cents: number;
  /** Grams of everything that ships. */
  weight_grams: number;
  requires_shipping: boolean;
  /**
   * Whether the figures above were computed from tax-inclusive prices.
   *
   * Carried on the result rather than inferred from it: an EU invoice has to
   * state which convention it used, and reconciliation cannot be checked
   * without knowing it. (The first version of this module tried to deduce it
   * from the numbers and got it wrong — the deduction is ambiguous when the tax
   * rate is 0.)
   */
  prices_include_tax: boolean;
}

/** Sum of a line before any discount. */
function lineSubtotal(l: TotalsLine): number {
  const qty = Math.max(0, Math.floor(l.qty));
  return Math.round(l.unit_price_cents) * qty;
}

/**
 * Compute every money figure for a basket.
 *
 * The returned `total_cents` is the single authoritative number; every other
 * field exists to explain it. `subtotal - discount + shipping (+ tax when
 * prices are exclusive)` always reconciles to it exactly — asserted in tests,
 * because "the invoice lines do not add up to the charge" is the bug this
 * module exists to make impossible.
 */
export function calculateTotals(input: TotalsInput): OrderTotals {
  const { tax } = input;
  // Absent means domestic — the behaviour every install had before destination
  // resolution existed.
  const treatment: TaxTreatment = input.treatment ?? { kind: 'domestic', jurisdiction: tax.originCountry };
  const inclusive = tax.pricesIncludeTax;

  const subtotals = input.lines.map(lineSubtotal);
  const subtotal_cents = subtotals.reduce((s, n) => s + n, 0);

  // Discount is allocated to the cent so per-line tax can be computed on the
  // discounted amount without the parts drifting from the whole.
  const discountRequested = Math.max(0, Math.round(input.discount_cents ?? 0));
  const discount_alloc = allocateDiscount(subtotals, discountRequested);
  const discount_cents = discount_alloc.reduce((s, n) => s + n, 0);

  const lines: OrderLineTotals[] = input.lines.map((l, i) => {
    const line_subtotal = subtotals[i];
    const lineDiscount = discount_alloc[i];
    const discounted = Math.max(0, line_subtotal - lineDiscount);

    // 'none' and 'shipping' both mean the GOODS are untaxed; 'shipping' only
    // changes whether the delivery charge is taxed.
    const taxable = tax.enabled && productIsTaxable(l.tax_status);
    /*
     * `?? 0` is safe HERE and only here: priceBasket has already refused a
     * basket whose treatment is 'not-configured', so a null at this point
     * cannot be the silent-under-charge case — it would mean the caller skipped
     * that check, and a 0 on a line the calculator was told is taxable is
     * visible in the total rather than hidden.
     */
    const rate_bp = taxable
      ? (rateForTreatment(tax, treatment, l.tax_class, input.destination_postcode) ?? 0)
      : 0;
    const split: TaxSplit = splitTax(discounted, rate_bp, inclusive);

    return {
      product_id: l.product_id,
      variant_id: l.variant_id,
      name: l.name,
      qty: Math.max(0, Math.floor(l.qty)),
      unit_price_cents: Math.round(l.unit_price_cents),
      line_subtotal_cents: line_subtotal,
      discount_cents: lineDiscount,
      net_cents: split.net_cents,
      tax_cents: split.tax_cents,
      tax_rate_bp: split.rate_bp,
      // Stamped only when it is NOT the historical default, so a domestic
      // shop's stored lines keep exactly the bytes they have today.
      // 'not-configured' is excluded by construction, not by accident: priceBasket
      // refuses such a basket before this runs, and saying so in the type means
      // a future caller that skips that check fails to compile rather than
      // writing an unresolvable treatment onto a stored line.
      ...(treatment.kind !== 'domestic' && treatment.kind !== 'not-configured'
        ? { tax_treatment: treatment.kind } : {}),
      ...(treatment.jurisdiction && treatment.jurisdiction !== tax.originCountry
        ? { tax_jurisdiction: treatment.jurisdiction } : {}),
      total_cents: split.gross_cents,
    };
  });

  const goodsTotal = lines.reduce((s, l) => s + l.total_cents, 0);
  const goodsTax = lines.reduce((s, l) => s + l.tax_cents, 0);

  // Shipping. Taxed when the basket contains anything whose tax status says so
  // — a basket of zero-rated goods should not attract VAT on its postage.
  const shipping_cents = Math.max(0, Math.round(input.shipping_cents ?? 0));
  const shippingTaxable =
    tax.enabled &&
    shipping_cents > 0 &&
    input.lines.some((l) => shippingIsTaxableFor(l.tax_status));
  const shippingRate = shippingTaxable
    // The SAME treatment as the goods: place of supply for transport ancillary
    // to a supply of goods follows the goods.
    ? (rateForTreatment(tax, treatment, input.shipping_tax_class ?? tax.shippingClass, input.destination_postcode) ?? 0)
    : 0;
  const shippingSplit = splitTax(shipping_cents, shippingRate, inclusive);

  const weight_grams = input.lines.reduce((s, l) => {
    if (l.requires_shipping === false) return s;
    const per = Math.max(0, Math.round(l.weight_grams ?? 0));
    return s + per * Math.max(0, Math.floor(l.qty));
  }, 0);

  return {
    lines,
    subtotal_cents,
    discount_cents,
    shipping_cents,
    shipping_tax_cents: shippingSplit.tax_cents,
    shipping_total_cents: shippingSplit.gross_cents,
    tax_cents: goodsTax + shippingSplit.tax_cents,
    // Built by SUMMING the parts that were themselves derived exactly, so the
    // invoice always reconciles to the charge.
    total_cents: goodsTotal + shippingSplit.gross_cents,
    weight_grams,
    requires_shipping: input.lines.some((l) => l.requires_shipping !== false),
    prices_include_tax: inclusive,
  };
}

/**
 * Self-check that the parts add up to the whole.
 *
 * Exported so both the tests and the runtime can assert it. Cheap, and the
 * failure it catches — an invoice whose lines do not sum to the amount charged
 * — is the kind that is discovered by an accountant months later.
 */
export function totalsReconcile(t: OrderTotals): boolean {
  // Every line's own parts must add up...
  const linesOk = t.lines.every((l) => l.total_cents === l.net_cents + l.tax_cents);
  // ...the shipping line's parts must add up...
  const shippingOk = t.shipping_total_cents ===
    (t.prices_include_tax ? t.shipping_cents : t.shipping_cents + t.shipping_tax_cents);
  // ...the declared tax must be the tax actually on the lines...
  const taxOk = t.tax_cents === t.lines.reduce((s, l) => s + l.tax_cents, 0) + t.shipping_tax_cents;
  // ...and the charge must be exactly the sum of what the invoice shows.
  const totalOk = t.total_cents ===
    t.lines.reduce((s, l) => s + l.total_cents, 0) + t.shipping_total_cents;
  return linesOk && shippingOk && taxOk && totalOk;
}
