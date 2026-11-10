/**
 * What the variant picker shows for each variant: words and formatted money,
 * decided at build time from what the CMS sent.
 *
 * Nothing is computed here. The price is the CMS's `resolved.price_cents` —
 * worked out by the same function the checkout prices an order with, sale
 * window and inheritance included — and the stock words are `stockBadge`'s
 * reading of the CMS's `stock_status`. The browser only swaps these strings
 * in; it never formats or adds up money (tests/storefront-starter.test.mjs).
 *
 * A CMS older than `resolved` sends the variant's own `price_cents`, or none
 * when it inherits; then the product's price is the variant's, and no "was"
 * price is shown rather than a guessed one.
 */
import type { Product } from './cms';
import { formatMoney } from './money';
import { stockBadge, type Stocked } from './stock';
import {
  selectableVariants, variantAxes, selectionLabel, swatchAxes,
  type SelectableVariant, type VariantAxis, type Swatch, type SwatchAttributeLike,
} from './variant-selection';

/** The `resolved` block each variant carries on a current CMS. */
interface Resolved {
  price_cents?: number;
  regular_price_cents?: number;
  on_sale?: boolean;
  sku?: string;
  image?: string;
}

type WireVariant = NonNullable<Product['variants']>[number] & Stocked & { resolved?: Resolved | null };

export interface VariantView {
  id: string;
  /** "Red / M", in the picker's option order. */
  label: string;
  price: string;
  /** The price before the sale, or null when there is no sale to show. */
  was: string | null;
  sku: string;
  /** The image to show for this variant; '' keeps the product's own. */
  image: string;
  stock: { tone: 'in' | 'low' | 'out'; label: string; note: string };
  buyable: boolean;
}

export interface PickerData {
  axes: VariantAxis[];
  variants: SelectableVariant[];
  views: Record<string, VariantView>;
  /**
   * Per axis, in the same order: null when it is drawn as buttons, else each
   * value's swatch (null for a value drawn as its words). See `swatchAxes`.
   */
  swatches: (Record<string, Swatch | null> | null)[];
}

const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n);

export function pickerData(product: Product, currency: string): PickerData {
  const wire = (product.variants ?? []) as WireVariant[];
  const variants = selectableVariants(wire);
  const axes = variantAxes(variants, product.attributes);
  const views: Record<string, VariantView> = {};
  for (const s of variants) {
    const v = wire.find((w) => w.id === s.id)!;
    const r = v.resolved ?? null;
    const now = isInt(r?.price_cents) ? r.price_cents : isInt(v.price_cents) ? v.price_cents : product.price_cents;
    const regular = r?.on_sale && isInt(r.regular_price_cents) && r.regular_price_cents > now ? r.regular_price_cents : null;
    const badge = stockBadge(v);
    views[s.id] = {
      id: s.id,
      label: selectionLabel(axes, s.options),
      price: formatMoney(now, currency),
      was: regular === null ? null : formatMoney(regular, currency),
      sku: r?.sku ?? v.sku ?? product.sku ?? '',
      image: r?.image ?? v.image ?? '',
      stock: { tone: badge.tone, label: badge.label, note: badge.note },
      buyable: s.buyable,
    };
  }
  // `display` and `swatches` are newer than the published astrobaas/core
  // types this starter pins, so the attribute list is read as the wire sends it.
  const attributes = (product.attributes ?? []) as unknown as SwatchAttributeLike[];
  return { axes, variants, views, swatches: swatchAxes(axes, attributes) };
}

/**
 * The data block the picker's script reads, safe inside a non-executable
 * `<script type="application/json">`: a `<` in a merchant's option name
 * cannot close the element.
 */
export function pickerJson(data: PickerData): string {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(new RegExp('\\u2028', 'g'), '\\u2028')
    .replace(new RegExp('\\u2029', 'g'), '\\u2029');
}
