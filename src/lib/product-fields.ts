/**
 * Normalisation for the extended product fields.
 *
 * Pure, so every rule is unit-testable without a database — and there are a lot
 * of rules, because "we added the field to the model" and "the field is safe and
 * behaves" are different claims. The ones that matter most:
 *
 *  - **Measurements are integers.** Grams and millimetres, never floats. A
 *    shipping quote computed from 0.30000000000000004 cm is a support ticket,
 *    and the codebase already made this decision for money.
 *  - **Free-text slugs are constrained.** `tax_class` and `shipping_class` reach
 *    listings and lookups; a 4 kB string or one with markup in it does not.
 *  - **Linked-product ids are ids.** They are rendered as links, so an unchecked
 *    value there is a redirect/injection vector.
 *  - **Downloads are https URLs.** A `javascript:` or `file:` download link is
 *    handed straight to a buyer.
 *  - **Enums fall back to the safe member**, never to whatever was typed —
 *    an unrecognised backorder policy must mean "no", not "yes".
 */

import { validate, type FieldRule } from './validate';
import {
  mediaKindOf, isVideoMedia, resolveMedia,
  type MediaKindIndex,
} from './media-kind';

// The kind rules moved to `media-kind.ts` when posts turned out to need them
// too. Re-exported because a product route asking a product module what a
// gallery entry is remains the natural reading order.
export { mediaKindOf, isVideoMedia, buildMediaKindIndex, type MediaKindIndex } from './media-kind';
import { publicCustomFields, type ProductFieldDef } from '../core/product-fields-def';
import type {
  BackorderPolicy, CatalogVisibility, TaxStatus,
  ProductAttribute, ProductDimensions, ProductDownload, ProductImage, ProductVariant,
} from '../core/models';

/** Caps chosen so a hostile import cannot bloat a row without bound. */
export const PRODUCT_LIMITS = {
  gtin: 64,
  tags: 50,
  tagLength: 64,
  slugLike: 64,
  attributes: 30,
  attributeValues: 50,
  downloads: 20,
  linked: 50,
  purchaseNote: 2000,
  images: 30,
  /** Colour x size for eyewear rarely exceeds this; the cap bounds a bad import. */
  variants: 200,
  /** 1 tonne. Anything heavier is a typo, not a parcel. */
  maxWeightGrams: 1_000_000,
  /** 10 m. Same reasoning. */
  maxDimensionMm: 10_000,
} as const;

const BACKORDER_POLICIES: readonly BackorderPolicy[] = ['no', 'notify', 'yes'];
const CATALOG_VISIBILITIES: readonly CatalogVisibility[] = ['visible', 'catalog', 'search', 'hidden'];
const TAX_STATUSES: readonly TaxStatus[] = ['taxable', 'shipping', 'none'];

/** Slug-ish token: lower-case letters, digits, dash, underscore. */
const SLUGLIKE = /^[a-z0-9][a-z0-9_-]*$/;

function str(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t === '' ? undefined : t.slice(0, max);
}

/** Non-negative integer within a ceiling, or null. Rejects floats outright. */
export function normalizeMeasurement(v: unknown, max: number): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  // Floats are a caller bug — round rather than silently truncating precision
  // the caller thought they had, then bound it.
  const i = Math.round(n);
  if (i < 0) return null;
  return Math.min(i, max);
}

export function normalizeBackorders(v: unknown): BackorderPolicy {
  return BACKORDER_POLICIES.includes(v as BackorderPolicy) ? (v as BackorderPolicy) : 'no';
}

export function normalizeCatalogVisibility(v: unknown): CatalogVisibility {
  return CATALOG_VISIBILITIES.includes(v as CatalogVisibility) ? (v as CatalogVisibility) : 'visible';
}

export function normalizeTaxStatus(v: unknown): TaxStatus {
  return TAX_STATUSES.includes(v as TaxStatus) ? (v as TaxStatus) : 'taxable';
}

/** A class slug the operator's rate table will look up. */
export function normalizeClassSlug(v: unknown): string | undefined {
  const s = str(v, PRODUCT_LIMITS.slugLike);
  if (!s) return undefined;
  const lower = s.toLowerCase();
  return SLUGLIKE.test(lower) ? lower : undefined;
}

/** GTIN/UPC/EAN/ISBN: digits, dashes and spaces only. */
export function normalizeGtin(v: unknown): string | undefined {
  const s = str(v, PRODUCT_LIMITS.gtin);
  if (!s) return undefined;
  return /^[0-9][0-9\s-]*$/.test(s) ? s.replace(/\s+/g, '') : undefined;
}

export function normalizeTags(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  for (const raw of v) {
    const t = str(raw, PRODUCT_LIMITS.tagLength);
    if (t) seen.add(t);
    if (seen.size >= PRODUCT_LIMITS.tags) break;
  }
  return [...seen];
}

export function normalizeDimensions(v: unknown): ProductDimensions | null {
  if (!v || typeof v !== 'object') return null;
  const d = v as Record<string, unknown>;
  const length_mm = normalizeMeasurement(d.length_mm, PRODUCT_LIMITS.maxDimensionMm);
  const width_mm = normalizeMeasurement(d.width_mm, PRODUCT_LIMITS.maxDimensionMm);
  const height_mm = normalizeMeasurement(d.height_mm, PRODUCT_LIMITS.maxDimensionMm);
  // All three or none: a partial box is not a box, and a shipping integration
  // that receives {length: 200, width: null} will do something arbitrary.
  if (length_mm === null || width_mm === null || height_mm === null) return null;
  return { length_mm, width_mm, height_mm };
}

export function normalizeAttributes(v: unknown): ProductAttribute[] {
  if (!Array.isArray(v)) return [];
  const out: ProductAttribute[] = [];
  for (const raw of v.slice(0, PRODUCT_LIMITS.attributes)) {
    if (!raw || typeof raw !== 'object') continue;
    const a = raw as Record<string, unknown>;
    const name = str(a.name, PRODUCT_LIMITS.tagLength);
    if (!name) continue;
    const values = Array.isArray(a.values)
      ? a.values
          .slice(0, PRODUCT_LIMITS.attributeValues)
          .map((x) => str(x, PRODUCT_LIMITS.tagLength))
          .filter((x): x is string => !!x)
      : [];
    if (!values.length) continue; // an attribute with no values says nothing
    out.push({ name, values, visible: a.visible !== false });
  }
  return out;
}

/**
 * Downloads must be https.
 *
 * This URL is handed to a paying customer to click. `javascript:` is XSS,
 * `file:` probes their machine, and plain http downgrades a paid asset to a
 * tamperable one.
 */
export function normalizeDownloads(v: unknown): ProductDownload[] {
  if (!Array.isArray(v)) return [];
  const out: ProductDownload[] = [];
  for (const raw of v.slice(0, PRODUCT_LIMITS.downloads)) {
    if (!raw || typeof raw !== 'object') continue;
    const d = raw as Record<string, unknown>;
    const url = str(d.url, 2000);
    const name = str(d.name, PRODUCT_LIMITS.tagLength) ?? 'Download';
    if (!url) continue;
    // Relative paths are our own media, and therefore fine.
    const isOwnMedia = url.startsWith('/');
    if (!isOwnMedia && !/^https:\/\//i.test(url)) continue;
    out.push({ name, url });
  }
  return out;
}

/** Ids of linked products. Shape-checked because they are rendered as links. */
export function normalizeLinkedIds(v: unknown, selfId?: string): string[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  for (const raw of v) {
    if (typeof raw !== 'string') continue;
    const t = raw.trim();
    if (!t || t.length > 64) continue;
    if (!/^[A-Za-z0-9_-]+$/.test(t)) continue;
    if (selfId && t === selfId) continue; // a product cannot upsell itself
    seen.add(t);
    if (seen.size >= PRODUCT_LIMITS.linked) break;
  }
  return [...seen];
}

/**
 * A variant's count as it is stored: null (untracked) for an absent or empty
 * value, otherwise a bounded, non-negative integer.
 *
 * One function rather than an expression inside normalizeVariants, because
 * saveProduct compares a client's `stock_base` (see readStockBases) with the
 * NORMALISED count, and two spellings of "normalised" would sooner or later
 * disagree about some value — and then a count the operator never touched
 * would be written back as though they had set it.
 */
export function normalizeVariantStock(v: unknown): number | null {
  return normalizeMeasurement(v, 10_000_000);
}

/**
 * Variants.
 *
 * Every variant needs a stable id and at least one chosen option — a variation
 * that varies nothing is not a variation. Ids are generated when absent so an
 * operator adding a colour in the admin does not have to invent one, but an id
 * that already exists is PRESERVED: regenerating it on every save would orphan
 * the variant referenced by every historical order line.
 */
export function normalizeVariants(v: unknown, existing?: ProductVariant[]): ProductVariant[] {
  if (!Array.isArray(v)) return [];
  const out: ProductVariant[] = [];
  const seenIds = new Set<string>();
  const seenCombos = new Set<string>();

  for (const raw of v.slice(0, PRODUCT_LIMITS.variants)) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;

    // Options: a map of attribute name -> chosen value.
    const options: Record<string, string> = {};
    if (r.options && typeof r.options === 'object' && !Array.isArray(r.options)) {
      for (const [k, val] of Object.entries(r.options as Record<string, unknown>)) {
        const key = str(k, PRODUCT_LIMITS.tagLength);
        const value = str(val, PRODUCT_LIMITS.tagLength);
        if (key && value) options[key] = value;
      }
    }
    if (!Object.keys(options).length) continue;

    // Two variants with identical options are ambiguous — a picker could not
    // tell them apart and stock would be split arbitrarily between them.
    const combo = Object.keys(options).sort().map((k) => `${k}=${options[k]}`).join('|');
    if (seenCombos.has(combo)) continue;
    seenCombos.add(combo);

    let id = typeof r.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(r.id) ? r.id : '';
    if (!id || seenIds.has(id)) {
      // Reuse the id of an existing variant with the same options, so editing a
      // product does not break order history.
      const match = (existing ?? []).find(
        (e) => Object.keys(e.options ?? {}).sort().map((k) => `${k}=${e.options[k]}`).join('|') === combo,
      );
      id = match?.id ?? `v-${Math.random().toString(36).slice(2, 10)}`;
    }
    if (seenIds.has(id)) continue;
    seenIds.add(id);

    const stock = normalizeVariantStock(r.stock);
    out.push({
      id,
      options,
      sku: str(r.sku, PRODUCT_LIMITS.slugLike),
      gtin: normalizeGtin(r.gtin),
      price_cents: intOrNull(r.price_cents),
      regular_price_cents: intOrNull(r.regular_price_cents),
      sale_price_cents: r.sale_price_cents === null ? null : intOrNull(r.sale_price_cents),
      stock,
      in_stock: stock === null ? true : stock > 0,
      weight_grams: intOrNull(r.weight_grams),
      // A variant image feeds the cart line's <img>. A video there is a broken
      // thumbnail in the basket, and there is no admin UI for this field — it
      // is a machine-write surface (API, MCP, import), so the guard has to be
      // here rather than in a form.
      image: (() => {
        const v = str(r.image, 1000);
        return v && mediaKindOf(v) === 'video' ? undefined : v;
      })(),
      enabled: r.enabled !== false,
    });
  }
  return out;
}

/** Non-negative integer or null. Money and weights only; rejects floats. */
function intOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

/**
 * Gallery entries, with index 0 as the MAIN item.
 *
 * One ordered list rather than a separate `featured_image` field: two fields
 * can disagree, and then "which one does the storefront show" has two answers.
 * Reordering is the whole feature.
 *
 * `kind` is written out only for video — see the note on ProductImage. So a
 * catalogue of photographs normalises to exactly the bytes it did before this
 * field existed, and a diff of the stored row shows nothing that did not
 * change.
 */
export function normalizeImages(v: unknown): ProductImage[] {
  if (!Array.isArray(v)) return [];
  const out: ProductImage[] = [];
  const seen = new Set<string>();
  for (const raw of v.slice(0, PRODUCT_LIMITS.images)) {
    if (!raw || typeof raw !== 'object') continue;
    const img = raw as Record<string, unknown>;
    // A src is an ADDRESS, so it is REJECTED when it is too long, never
    // truncated. `str` truncates, which is right for alt text and wrong here: a
    // shortened URL is not a shorter address, it is a different one that looks
    // valid and 404s. The import path previously dropped these outright and
    // sharing the normaliser must not quietly turn that into a silent rewrite.
    const rawSrc = typeof img.src === 'string' ? img.src.trim() : '';
    if (!rawSrc || rawSrc.length > 1000) continue;
    const src = rawSrc;
    // Own media or an absolute http(s) URL. No data:, no javascript:.
    if (!src.startsWith('/') && !/^https?:\/\//i.test(src)) continue;
    if (seen.has(src)) continue; // the same photo twice is always a mistake
    seen.add(src);
    const entry: ProductImage = { src, alt: str(img.alt, 300) };
    // The client's `kind` is not consulted. It is derivable from the src, and
    // a value that disagrees with the src is a value that makes the storefront
    // render the wrong element — so the src wins, always.
    if (mediaKindOf(src) === 'video') {
      entry.kind = 'video';
      // A poster, only on a video, and only if it is itself a picture. A video
      // nominated as a poster is the original bug wearing a different hat: the
      // storefront would put an .mp4 into `<video poster>`, which renders
      // nothing at all. Same origin rule as the src.
      const poster = typeof img.poster === 'string' ? img.poster.trim() : '';
      if (poster
        && poster.length <= 1000
        && (poster.startsWith('/') || /^https?:\/\//i.test(poster))
        && mediaKindOf(poster) === 'image') {
        entry.poster = poster;
      }
    }
    out.push(entry);
  }
  return out;
}

/** Move `index` to the front, making it the main image. */
export function setMainImage(images: ProductImage[], index: number): ProductImage[] {
  if (!Number.isInteger(index) || index <= 0 || index >= images.length) return images;
  const copy = [...images];
  const [picked] = copy.splice(index, 1);
  return [picked, ...copy];
}

/**
 * The image a listing should show, or undefined when there is none.
 *
 * The first entry that is NOT a video, rather than simply the first entry. A
 * listing row, a cart line and a search result all render an <img>, and an
 * <img> pointed at an mp4 is a broken-image icon — so a merchant who leads
 * their gallery with a video would break every thumbnail in the shop by
 * reordering it, which is not a thing reordering should be able to do.
 *
 * Undefined when the gallery is ALL video. That is honest: there is no still
 * to show, and returning the video anyway would only move the broken icon.
 * Callers already handle undefined — it is the no-images case.
 */
export function mainImage(images: ProductImage[] | undefined): ProductImage | undefined {
  if (!images || !images.length) return undefined;
  return images.find((img) => !isVideoMedia(img));
}

/** The gallery's video entries, in order. */
export function productVideos(images: ProductImage[] | undefined): ProductImage[] {
  return (images ?? []).filter((img) => isVideoMedia(img));
}

/**
 * Can `qty` of this product be ordered right now?
 *
 * Central because three separate rules interact, and getting the precedence
 * wrong either oversells or refuses a legitimate sale:
 *
 *   1. `sold_individually` caps the line at 1 regardless of anything else.
 *   2. untracked stock (`stock === null`) is unlimited.
 *   3. backorders decide what happens once the count runs out.
 */
export type AvailabilityRejection =
  /** The request itself is wrong — a 400. Retrying it unchanged cannot help. */
  | 'invalid-quantity'
  | 'sold-individually'
  /** The world ran out — a 409. Retrying with less may well succeed. */
  | 'insufficient-stock';

export type Availability =
  | { ok: true }
  | { ok: false; code: AvailabilityRejection; reason: string };

export function availableFor(
  product: {
    stock: number | null;
    sold_individually?: boolean;
    backorders?: BackorderPolicy;
  },
  qty: number,
): Availability {
  if (!Number.isInteger(qty) || qty < 1) {
    return { ok: false, code: 'invalid-quantity', reason: 'Invalid quantity' };
  }
  if (product.sold_individually && qty > 1) {
    return { ok: false, code: 'sold-individually', reason: 'Only one of this item may be ordered at a time' };
  }
  if (product.stock === null || product.stock === undefined) return { ok: true }; // untracked
  if (product.stock >= qty) return { ok: true };
  // Out of stock: only a backorder policy can save it.
  const policy = normalizeBackorders(product.backorders);
  if (policy === 'no') return { ok: false, code: 'insufficient-stock', reason: 'Insufficient stock' };
  return { ok: true };
}

/** Should staff be warned about this product's level? */
export function isLowStock(product: { stock: number | null; low_stock_threshold?: number | null }): boolean {
  if (product.stock === null || product.stock === undefined) return false;
  const t = product.low_stock_threshold;
  if (t === null || t === undefined || !Number.isFinite(t)) return false;
  return product.stock <= t;
}

/**
 * Is a scheduled sale live at `nowMs`?
 *
 * An absent bound is open-ended on that side. Both absent means the schedule
 * says nothing and the stored `on_sale` flag stands on its own.
 */
export function saleActiveAt(
  product: { sale_starts_at?: string | null; sale_ends_at?: string | null },
  nowMs: number,
): boolean | null {
  const start = product.sale_starts_at ? Date.parse(product.sale_starts_at) : null;
  const end = product.sale_ends_at ? Date.parse(product.sale_ends_at) : null;
  const hasStart = start !== null && Number.isFinite(start);
  const hasEnd = end !== null && Number.isFinite(end);
  if (!hasStart && !hasEnd) return null; // no schedule configured
  if (hasStart && nowMs < (start as number)) return false;
  if (hasEnd && nowMs > (end as number)) return false;
  return true;
}

/**
 * The sale rule, in one place.
 *
 * ## Why this exists
 *
 * `on_sale` is documented as server-derived, and for a long time nothing on the
 * products API derived it. It was computed in the CSV import path and hardcoded
 * `false` on create, so a shop manager could set a sale price on 400 products
 * through the admin and no customer ever saw a discount: no strikethrough, no
 * badge, and `?on_sale=true` returned nothing. Nothing errored, which is what
 * made it expensive.
 *
 * The rule itself had drifted into four copies — the importer, the variant
 * resolver, the admin form's client-side preview, and the shape implied by the
 * doc comment. This is the one the server uses; the importer and the variant
 * resolver call it, so a change here cannot be half-applied.
 *
 * ## The rule
 *
 *   regular  = regular_price_cents ?? price_cents
 *   on_sale  = sale_price_cents != null && sale_price_cents < regular
 *   price    = on_sale ? sale_price_cents : regular
 *
 * ## …and the schedule, which is why this is not a one-liner
 *
 * `sale_starts_at` / `sale_ends_at` were stored, validated and unit-tested, and
 * read by nothing in production — `saleActiveAt()` had no caller. Deriving
 * `on_sale` from price alone would therefore have taken every sale somebody had
 * scheduled for next month and made it live, and `price_cents` follows
 * `on_sale`, so that is not a display bug — it charges the sale price early.
 *
 * A window that has not started, or has ended, holds `on_sale` at false.
 * `saleActiveAt` returns `null` when no window is set, which means "the price
 * decides on its own" — so the common no-schedule case is exactly the rule above.
 *
 * **This is derive-on-WRITE.** A sale that becomes due tomorrow flips when the
 * product is next saved, not at midnight; there is no sale scheduler (the
 * scheduler publishes posts and sweeps abandoned orders, nothing else). That is
 * strictly better than the previous behaviour, in which the flag was never set
 * at all, but it is not the same as a scheduler and should not be mistaken for
 * one.
 */
export interface PricingFields {
  price_cents?: number | null;
  regular_price_cents?: number | null;
  sale_price_cents?: number | null;
  sale_starts_at?: string | null;
  sale_ends_at?: string | null;
}

export interface DerivedSaleState {
  price_cents: number;
  regular_price_cents: number;
  sale_price_cents: number | null;
  on_sale: boolean;
}

/** `true` when the key was explicitly supplied — `undefined` counts as absent. */
function supplied<T extends object>(patch: T, key: keyof T): boolean {
  return Object.prototype.hasOwnProperty.call(patch, key) && patch[key] !== undefined;
}

/**
 * Resolve pricing for a write.
 *
 * `stored` is the product as it exists today, and passing it is what makes a
 * PARTIAL update correct: `PUT { sale_price_cents: 1190 }` has to be judged
 * against the stored regular price, not against an otherwise-empty patch. That
 * is how the admin form and most API clients save, so getting it wrong would
 * look like the field being ignored.
 */
export function deriveSaleState(
  patch: PricingFields,
  stored?: PricingFields | null,
  nowMs: number = Date.now(),
): DerivedSaleState {
  // `!= null` and not a falsy check: `sale_price_cents: 0` is a free item, a
  // legitimate price, and a truthiness test would silently drop it.
  const sale = supplied(patch, 'sale_price_cents')
    ? (patch.sale_price_cents ?? null)
    : (stored?.sale_price_cents ?? null);

  // A supplied `price_cents` with no `regular_price_cents` means the operator is
  // setting the price — so it becomes the regular price. Preferring the stored
  // regular here instead would silently revert their edit.
  const regular =
    supplied(patch, 'regular_price_cents') && patch.regular_price_cents != null
      ? patch.regular_price_cents
      : supplied(patch, 'price_cents') && patch.price_cents != null
        ? patch.price_cents
        : stored?.regular_price_cents ?? stored?.price_cents ?? 0;

  const window = saleActiveAt(
    {
      sale_starts_at: supplied(patch, 'sale_starts_at') ? patch.sale_starts_at : stored?.sale_starts_at,
      sale_ends_at: supplied(patch, 'sale_ends_at') ? patch.sale_ends_at : stored?.sale_ends_at,
    },
    nowMs,
  );

  // A "sale" that costs the same or more is not a sale. Guarding this is what
  // stops a bad feed — or a typo — advertising a discount that does not exist.
  const on_sale = sale !== null && sale < regular && window !== false;

  return {
    regular_price_cents: regular,
    sale_price_cents: sale,
    price_cents: on_sale ? sale : regular,
    on_sale,
  };
}

/**
 * `in_stock`, derived from `stock` for the same reason and in the same place.
 *
 * The sibling of the bug above, in the same doc comment and the same function:
 * `in_stock` is also declared server-derived and was also hardcoded `true` on
 * create and never recomputed on update, so a product edited down to `stock: 0`
 * still reported itself in stock.
 *
 * Display only — `availableFor()` gates checkout on `stock`, so nothing was
 * oversold. The cost is a shopper adding a sold-out item and being refused at
 * checkout, and a headless storefront reading `in_stock` from the API and
 * showing the wrong badge.
 *
 * `null` stock means untracked, which is always purchasable.
 */
export function deriveInStock(
  patch: { stock?: number | null },
  stored?: { stock?: number | null } | null,
): boolean {
  const stock = supplied(patch, 'stock') ? (patch.stock ?? null) : (stored?.stock ?? null);
  return stock == null ? true : stock > 0;
}

/**
 * Fields a client may write.
 *
 * An explicit allow-list, shared by POST and PUT so the two cannot drift: a
 * field added to one and forgotten in the other is the classic way a product
 * edit silently loses data. Everything absent here is server-owned (`id`,
 * timestamps, `on_sale`, `in_stock`) and is derived, not accepted.
 */
/**
 * The GPSR fields that hold text a buyer will read.
 *
 * All five, including `gpsr_identifier`: a batch code is short and is not prose,
 * but it is still rendered on a public page and still arrives from supplier
 * feeds, so it goes through the same sanitiser and the same length cap. Named
 * once so the sanitiser and any future renderer cannot disagree about the set.
 */
export const GPSR_TEXT_FIELDS = [
  'gpsr_manufacturer', 'gpsr_eu_responsible', 'gpsr_identifier',
  'gpsr_warnings', 'gpsr_instructions',
] as const;

export const WRITABLE_PRODUCT_FIELDS = [
  // identity + copy
  'name', 'slug', 'sku', 'gtin', 'description', 'short_description', 'purchase_note',
  // Per-locale overrides of the copy above. Accepted here and then cleaned in
  // saveProduct against the SAME limits and sanitiser the base fields use — a
  // translation must not be a way past a rule the base field enforces.
  'i18n',
  // pricing
  'price_cents', 'regular_price_cents', 'sale_price_cents',
  'sale_starts_at', 'sale_ends_at', 'tax_status', 'tax_class',
  // inventory
  'stock', 'manage_stock', 'low_stock_threshold', 'backorders', 'sold_individually',
  // shipping
  'weight_grams', 'dimensions_mm', 'shipping_class', 'requires_shipping',
  // nature
  'virtual', 'downloadable', 'downloads',
  // taxonomy + media
  'brand', 'categories', 'tags', 'images', 'model_url',
  // merchandising
  'upsell_ids', 'cross_sell_ids', 'attributes', 'reviews_enabled',
  'featured', 'position', 'catalog_visibility', 'status',
  // The merchant-declared bag. On the allow-list because otherwise the whole
  // feature is unreachable through every writer — the shared allow-list IS the
  // write path, and a field missing from it renders, accepts input, reports
  // "saved" and stores nothing.
  'custom',
  // Variations. `type` is DERIVED from these, never accepted from a client —
  // a product claiming type:'variable' with no variants would be unbuyable.
  'variants',
  // Optical: whether this product needs an Rx, and which form to collect.
  'requires_prescription', 'prescription_type',
  // GPSR (EU 2023/988). Operator-entered, and they must be writable through the
  // API as well as the form: a shop with four hundred products will fill these
  // from a feed or a CSV, not by hand.
  'gpsr_manufacturer', 'gpsr_eu_responsible', 'gpsr_identifier',
  'gpsr_warnings', 'gpsr_instructions',
] as const;

/** Pick only writable keys from an untrusted body. */
/**
 * Validate and clean the merchant-declared `custom` bag.
 *
 * Two rules, and the second one is the one that gets forgotten:
 *  1. A DECLARED key is validated against the merchant's own rule. A value that
 *     fails is refused, not silently dropped — a form that reports "saved" and
 *     stored nothing is the exact failure the settings screen documents.
 *  2. An UNDECLARED key is CARRIED THROUGH. Deleting a definition is how a
 *     merchant hides a field, and it must not also delete the data. Dropping it
 *     here would destroy an afternoon of entry the moment somebody tidied the
 *     definitions.
 */
export function normalizeCustomFields(
  incoming: unknown,
  existing: Record<string, unknown> | undefined,
  fields: readonly ProductFieldDef[],
): { ok: true; value: Record<string, unknown> | undefined }
  | { ok: false; errors: Record<string, string> } {
  if (incoming === undefined) return { ok: true, value: existing };
  if (incoming === null) return { ok: true, value: undefined };
  if (typeof incoming !== 'object' || Array.isArray(incoming)) {
    return { ok: false, errors: { custom: 'custom must be an object' } };
  }

  const declared = new Map(fields.map((f) => [f.name, f]));
  const supplied = incoming as Record<string, unknown>;

  const schema: Record<string, FieldRule> = {};
  const toCheck: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(supplied)) {
    const def = declared.get(k);
    if (!def) continue;
    // An optional rule plus an absent value is fine; an explicit null clears it.
    if (v === undefined || v === null) continue;
    schema[k] = def.rule;
    toCheck[k] = v;
  }

  const result = validate<Record<string, unknown>>(toCheck, schema);
  if (!result.ok) return { ok: false, errors: result.errors };

  const out: Record<string, unknown> = {};
  // Undeclared keys the product ALREADY had survive.
  for (const [k, v] of Object.entries(existing ?? {})) {
    if (!declared.has(k)) out[k] = v;
  }
  for (const [k, v] of Object.entries(supplied)) {
    if (!declared.has(k)) continue;
    if (v === null || v === undefined) continue;
    out[k] = (result.value as Record<string, unknown>)[k];
  }
  return { ok: true, value: Object.keys(out).length ? out : undefined };
}

/**
 * The product a non-staff caller may see.
 *
 * ONE helper, applied by BOTH product routes, because a projection that lives
 * in one route and not its sibling is how a staff-only cost price gets
 * published by the endpoint nobody remembered.
 *
 * Staff get the object untouched — and that matters more than it looks: the
 * admin edit dialog LOADS through `GET /api/products/{id}` and saves what it
 * loaded, so stripping the bag for staff would quietly write the stripped
 * version back over the product.
 */
/**
 * Guarantee the media kind ON READ, and publish the mime type.
 *
 * ## Why this exists, and why the write-time field was not enough
 *
 * `normalizeImages` stamps `kind` when a product is SAVED. That makes `kind` a
 * property of WHEN THE ROW WAS LAST WRITTEN rather than of what the file is —
 * so a gallery saved before the field existed, or written by any of the import
 * paths, goes out on the wire as `{ src: "…mp4" }`, byte-identical to a
 * photograph.
 *
 * Every INTERNAL consumer survived that, because `isVideoMedia` falls back to
 * the extension. But that fallback lives in the server and **is not in the
 * payload**. So a storefront told to trust `kind` instead of sniffing the
 * filename — which is exactly the advice this whole change exists to give —
 * would REGRESS on precisely the rows that caused the original bug. Deriving on
 * read is what makes `kind` a guarantee of the response rather than a fact
 * about the row's history.
 *
 * ## Where the answer comes from
 *
 * The media table's `mime_type` is authoritative: it is recorded from the
 * upload sniffer, which reads magic bytes. The extension is the fallback, and
 * it is a good one for anything this CMS ingested — `ingest.ts` NAMES the file
 * from the sniffed type, so the two cannot disagree for our own uploads. It is
 * the only available answer for a remote URL in an imported catalogue.
 */
export function withMediaKind<T extends { images?: ProductImage[] }>(
  product: T,
  index?: MediaKindIndex,
): T & { images: ProductImage[]; photos: ProductImage[]; videos: ProductImage[] } {
  const images = (product.images ?? []).map((img) => {
    const resolved = resolveMedia(img.src, index);
    // `isVideoMedia` still gets a say when the media table is silent, because a
    // row already stamped `kind: 'video'` by a save or by the v14 migration is
    // evidence about a src whose extension may since have been rewritten.
    const kind: 'image' | 'video' = resolved.mime_type
      ? resolved.kind
      : (isVideoMedia(img) ? 'video' : 'image');
    return { ...img, kind, ...(resolved.mime_type ? { mime_type: resolved.mime_type } : {}) };
  });

  /*
   * Poster frames (no ffmpeg).
   *
   * A video without a poster shows a blank rectangle until it is played, and
   * every consumer would otherwise have to reimplement "use the first photo" —
   * which is the reimplementation-at-every-consumer pattern this whole change
   * exists to remove. So the fallback is applied ONCE, here, and travels in the
   * payload.
   *
   * The editor's nomination wins. Falling back to the first PHOTOGRAPH, not the
   * first entry, or a gallery whose first item is itself a video would poster
   * the video with the video.
   */
  const fallbackPoster = images.find((i) => i.kind !== 'video')?.src;
  for (const img of images) {
    if (img.kind !== 'video') {
      // A poster on a photograph is meaningless, and an entry that carries one
      // invites a consumer to render the poster instead of the picture.
      if (img.poster) delete img.poster;
      continue;
    }
    if (!img.poster && fallbackPoster) img.poster = fallbackPoster;
  }

  /*
   * `photos` and `videos` are READ-ONLY and deliberately NOT named `images`.
   *
   * The owner's structural argument is right — a field meaning "a picture"
   * should be incapable of holding a video — but it cannot be spelled `images`,
   * because that name is already the WRITE field: it is on
   * WRITABLE_PRODUCT_FIELDS and `saveProduct` replaces the array wholesale.
   * Narrowing it would mean the admin form loads a product without its videos
   * and deletes them the next time somebody fixes a typo, and "the client
   * removed the video" and "the client was never shown the video" would arrive
   * as the same PUT body.
   *
   * So the separation goes on new names, the way `reference_price_cents`
   * already does: a read-only field that is not on the allow-list and is
   * therefore harmlessly echoed back by a read-modify-write client.
   */
  return {
    ...product,
    images,
    photos: images.filter((i) => i.kind !== 'video'),
    videos: images.filter((i) => i.kind === 'video'),
  };
}

export function projectProductForReader<T extends { custom?: Record<string, unknown> }>(
  product: T,
  fields: readonly ProductFieldDef[],
  isStaff: boolean,
): T {
  if (isStaff) return product;
  if (!product.custom) return product;
  const visible = publicCustomFields(product.custom, fields);
  const out = { ...product };
  if (visible) out.custom = visible;
  else delete out.custom;
  return out;
}

export function pickWritableProductFields(body: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!body || typeof body !== 'object') return out;
  for (const k of WRITABLE_PRODUCT_FIELDS) {
    if (k in (body as Record<string, unknown>)) out[k] = (body as Record<string, unknown>)[k];
  }
  return out;
}

/**
 * The counts a client LOADED, sent beside the counts it is saving.
 *
 * ## Why a save has to say what it started from
 *
 * The admin product editor sends `stock` and the whole `variants` array, each
 * variant with its `stock`, on every save — they are fields on the form, and
 * the form sends the form. The numbers in them are the ones the dialog LOADED
 * when it opened, and the dialog stays open for minutes. Every checkout in
 * that time took units from the stored row, and a save that wrote the loaded
 * numbers back handed those units back: stock already sold, on sale again.
 * Writing only the keys a patch carries (the relational driver's patchRow)
 * cannot help, because this patch carries exactly those keys. Measured on all
 * three drivers before this existed: open the editor at stock 5 and Black 3,
 * sell one of each, change only the description, save — 5 and 3.
 *
 * So the editor also sends what it loaded: `stock_base` beside `stock`, and a
 * `stock_base` on each variant it loaded. A count EQUAL to its base is one the
 * operator left alone, and the save takes it from the stored row at write
 * time instead (saveProduct drops `stock` from the patch; the storage layer
 * keeps a variant's stored count — see UpdateProductOptions). A count that
 * DIFFERS from its base is the operator setting it: a recount is an absolute,
 * and is written as typed.
 *
 * ## Additive
 *
 * `stock_base` is on no allow-list, so nothing ever stores it. A client that
 * sends no base — an ERP pushing absolute counts, the MCP server, an admin page
 * loaded before this shipped and still open in a tab — is saved exactly as
 * before. Read from the RAW body, because pickWritableProductFields and
 * normalizeVariants both drop keys they do not store; a route that read it
 * after them would always see nothing, and the fix would silently do nothing.
 *
 * Only a finite number or null is a base. Anything else is ignored rather than
 * guessed at, which falls back to writing the count as sent — today's
 * behaviour, never a new one.
 */
export interface StockBases {
  /** `stock_base`: the product-level count the client loaded. */
  stock?: number | null;
  /** Variant id → the count the client loaded for that variant. */
  variants?: Map<string, number | null>;
}

export function readStockBases(body: unknown): StockBases | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const b = body as Record<string, unknown>;
  const has = (o: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(o, k);
  const asBase = (v: unknown): number | null | undefined =>
    v === null ? null : typeof v === 'number' && Number.isFinite(v) ? v : undefined;

  const out: StockBases = {};
  if (has(b, 'stock_base')) {
    const base = asBase(b.stock_base);
    if (base !== undefined) out.stock = base;
  }
  if (Array.isArray(b.variants)) {
    const map = new Map<string, number | null>();
    for (const raw of b.variants.slice(0, PRODUCT_LIMITS.variants)) {
      if (!raw || typeof raw !== 'object') continue;
      const r = raw as Record<string, unknown>;
      if (typeof r.id !== 'string' || !has(r, 'stock_base')) continue;
      const base = asBase(r.stock_base);
      if (base !== undefined) map.set(r.id, base);
    }
    if (map.size) out.variants = map;
  }
  return out.stock !== undefined || out.variants ? out : undefined;
}
