/**
 * Product variants: resolution, inheritance and validation.
 *
 * Pure, so the rules that decide WHICH thing is being bought and at WHAT price
 * are testable without a database.
 *
 * ## Inheritance
 *
 * A variant overrides only what it sets. A shop selling one frame in five
 * colours at one price should state that price once; restating it five times
 * is five places to get it wrong when the price changes. So `price_cents`,
 * `weight_grams`, `sku` and the rest fall back to the parent when absent —
 * with one deliberate exception: **stock never inherits**. A variant's count is
 * its own, because "how many black ones are left" is the entire question a
 * variant exists to answer.
 */

import type { Product, ProductVariant } from '../../core/models';
import { normalizeBackorders, deriveSaleState, mainImage } from '../product-fields';

/** Is this product bought through a variant? */
export function isVariable(product: Pick<Product, 'variants'>): boolean {
  return Array.isArray(product.variants) && product.variants.length > 0;
}

/** Enabled variants only — a disabled one is not buyable. */
export function buyableVariants(product: Pick<Product, 'variants'>): ProductVariant[] {
  return (product.variants ?? []).filter((v) => v.enabled !== false);
}

export function findVariant(
  product: Pick<Product, 'variants'>,
  variantId: string | undefined | null,
): ProductVariant | undefined {
  if (!variantId) return undefined;
  return (product.variants ?? []).find((v) => v.id === variantId);
}

/**
 * The effective values for a purchase, after inheritance.
 *
 * One function so every caller — pricing, stock, invoicing, the storefront —
 * resolves the same way. Two callers resolving independently is how a variant
 * gets charged the parent price on one path and its own on another.
 */
export interface ResolvedPurchasable {
  product_id: string;
  variant_id?: string;
  /** Parent name plus the variant's options, e.g. "Aviator (Black / 52)". */
  name: string;
  price_cents: number;
  regular_price_cents: number;
  sale_price_cents: number | null;
  on_sale: boolean;
  sku?: string;
  gtin?: string;
  /** null = untracked. */
  stock: number | null;
  weight_grams: number | null;
  image?: string;
  options?: Record<string, string>;
}

/** Human label for a set of chosen options. */
export function optionsLabel(options: Record<string, string> | undefined): string {
  if (!options) return '';
  const parts = Object.keys(options)
    .sort()
    .map((k) => options[k])
    .filter(Boolean);
  return parts.join(' / ');
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null;
}

/**
 * Resolve what is actually being bought.
 *
 * Returns null when the product is variable and no valid variant was named —
 * the caller must refuse, because an order for "the frame" without a colour
 * cannot be picked from a shelf.
 */
export function resolvePurchasable(
  product: Product,
  variantId?: string | null,
): ResolvedPurchasable | null {
  if (!isVariable(product)) {
    // A simple product. A variant_id sent for one is a client bug, not a
    // silent fallback — refusing surfaces it instead of shipping the wrong item.
    if (variantId) return null;
    return {
      product_id: product.id,
      name: product.name,
      price_cents: product.price_cents,
      regular_price_cents: product.regular_price_cents ?? product.price_cents,
      sale_price_cents: product.sale_price_cents ?? null,
      on_sale: product.on_sale === true,
      sku: product.sku,
      gtin: product.gtin,
      stock: product.stock ?? null,
      weight_grams: product.weight_grams ?? null,
      // mainImage, not images[0]: a cart line renders an <img>, and a gallery
      // that leads with a video would put an mp4 in it.
      image: mainImage(product.images)?.src,
    };
  }

  const variant = findVariant(product, variantId);
  if (!variant || variant.enabled === false) return null;

  const price = num(variant.price_cents) ?? product.price_cents;
  const regular = num(variant.regular_price_cents) ?? num(variant.price_cents) ??
    product.regular_price_cents ?? product.price_cents;
  const sale = variant.sale_price_cents === null
    ? null
    : num(variant.sale_price_cents) ?? (variant.price_cents != null ? null : product.sale_price_cents ?? null);

  const label = optionsLabel(variant.options);
  // A genuine sale price wins, exactly as it does for a simple product — and
  // "exactly" is enforced rather than reimplemented: this is the same
  // deriveSaleState() the products API and the bulk importer use, so a variant
  // and its parent cannot disagree about what counts as a sale.
  //
  // The inheritance above (variant value, else product value) is variant-specific
  // and stays here; only the sale COMPARISON is shared. `price` is passed as the
  // fallback price_cents so a variant with its own price but no sale keeps it.
  const priced = deriveSaleState({
    price_cents: price,
    regular_price_cents: regular,
    sale_price_cents: sale,
    sale_starts_at: product.sale_starts_at,
    sale_ends_at: product.sale_ends_at,
  });
  return {
    product_id: product.id,
    variant_id: variant.id,
    name: label ? `${product.name} (${label})` : product.name,
    price_cents: priced.on_sale ? priced.price_cents : price,
    regular_price_cents: regular,
    sale_price_cents: sale,
    on_sale: priced.on_sale,
    sku: variant.sku ?? product.sku,
    gtin: variant.gtin ?? product.gtin,
    // Stock NEVER inherits — see the module note.
    stock: variant.stock ?? null,
    weight_grams: num(variant.weight_grams) ?? product.weight_grams ?? null,
    image: variant.image ?? mainImage(product.images)?.src,
    options: variant.options,
  };
}

/** Cheapest buyable variant, for a "from €X" listing price. */
export function priceRange(product: Product): { min: number; max: number } | null {
  const vs = buyableVariants(product);
  if (!vs.length) return null;
  const prices = vs
    .map((v) => resolvePurchasable(product, v.id)?.price_cents)
    .filter((p): p is number => typeof p === 'number');
  if (!prices.length) return null;
  return { min: Math.min(...prices), max: Math.max(...prices) };
}

/** Total stock across variants. null when any variant is untracked. */
export function totalVariantStock(product: Product): number | null {
  const vs = buyableVariants(product);
  if (!vs.length) return product.stock ?? null;
  // One untracked variant makes the product effectively unlimited; reporting a
  // number would understate availability.
  if (vs.some((v) => v.stock === null || v.stock === undefined)) return null;
  return vs.reduce((sum, v) => sum + (v.stock ?? 0), 0);
}

export type VariantRejection = 'variant-required' | 'unknown-variant' | 'variant-not-for-simple';

/** Why a purchasable could not be resolved. Distinct messages, distinct fixes. */
export function explainResolveFailure(
  product: Product,
  variantId?: string | null,
): { code: VariantRejection; message: string } {
  if (!isVariable(product)) {
    return {
      code: 'variant-not-for-simple',
      message: `${product.name} has no variations, so no variant may be specified`,
    };
  }
  if (!variantId) {
    const names = Object.keys(buyableVariants(product)[0]?.options ?? {});
    return {
      code: 'variant-required',
      message: names.length
        ? `Choose ${names.join(' and ')} for ${product.name}`
        : `A variation must be chosen for ${product.name}`,
    };
  }
  return { code: 'unknown-variant', message: `That variation of ${product.name} is not available` };
}

/**
 * Can `qty` be ordered of this purchasable?
 *
 * Mirrors `availableFor` for simple products but reads the VARIANT's count.
 * Kept here rather than overloading the product version so neither has to
 * branch on which shape it received.
 */
export function variantAvailability(
  resolved: Pick<ResolvedPurchasable, 'stock'>,
  product: Pick<Product, 'sold_individually' | 'backorders'>,
  qty: number,
): { ok: true } | { ok: false; code: 'invalid-quantity' | 'sold-individually' | 'insufficient-stock'; reason: string } {
  if (!Number.isInteger(qty) || qty < 1) {
    return { ok: false, code: 'invalid-quantity', reason: 'Invalid quantity' };
  }
  if (product.sold_individually && qty > 1) {
    return { ok: false, code: 'sold-individually', reason: 'Only one of this item may be ordered at a time' };
  }
  if (resolved.stock === null || resolved.stock === undefined) return { ok: true };
  if (resolved.stock >= qty) return { ok: true };
  return normalizeBackorders(product.backorders) === 'no'
    ? { ok: false, code: 'insufficient-stock', reason: 'Insufficient stock' }
    : { ok: true };
}
