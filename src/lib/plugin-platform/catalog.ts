/**
 * `host.catalog` — read-only product and brand reads for compiled plugins.
 *
 * ## Why this exists
 *
 * A compiled external plugin imports nothing from the host (see
 * `src/plugins/external.ts`), so until now it had no way to read the
 * catalogue at all. A product feed, a marketplace sync or a price monitor all
 * start from "give me every product", and the only answer was to reach into
 * storage the plugin cannot import. `@astrobaas/ecommerce-plus` answers 503
 * "Core seam needed" without this.
 *
 * ## What a plugin gets, and why each rule is there
 *
 * - **Every product, every status.** Drafts, archived and `hidden` products
 *   included, because a feed must be able to say WHY a product is left out.
 *   The plugin filters; the host does not guess its rules.
 * - **Copies, never live objects.** On the document drivers
 *   `LocalDB.getProducts()` returns the cached rows themselves (the array is
 *   copied, the elements are not). The test proves the trap on lowdb; the
 *   libSQL document store happened to hand out fresh rows when measured, and
 *   relational parses every row, but no rule relies on that. A plugin that normalised a product in place
 *   would rewrite the shop's stored data on the next unrelated save. So every
 *   product is `structuredClone`d before anything else touches it.
 * - **The derived read fields the product API serves**: `stock_status` (on
 *   the product and on each variant), `reference_price_cents` (Omnibus), and
 *   the media `kind` / `mime_type` / `photos` / `videos`. Derived on READ, the
 *   same helpers `GET /api/products` uses, so a plugin and the storefront
 *   cannot disagree about whether a product is in stock or whether an entry
 *   is a video.
 * - **The PUBLIC custom-field projection**, not the staff one. A plugin's
 *   output is typically public (a Merchant Center feed is fetched by Google
 *   and often by anyone holding the URL), and a field the merchant marked
 *   `staff` — a cost price, a supplier code — has no business there. So the
 *   `custom` bag goes through `projectProductForReader(…, isStaff=false)`:
 *   declared `public` fields only, deny-by-default for everything else. That
 *   is the only part of the anonymous projection applied; product STATUS is
 *   not filtered (see the first rule).
 *
 * Not applied: embed facades (`withProductEmbeds`, presentation HTML) and the
 * `?locale=` projection (the `i18n` sidecar is left in place, so a plugin can
 * read translations itself).
 *
 * ## Size
 *
 * The storage layer has no paged product read: every driver's `getProducts()`
 * returns the whole table, and `GET /api/products` filters in process too. So
 * the source read is one full read whatever this module does. What it CAN
 * bound is the copy: `listProducts()` holds a projected clone of the whole
 * catalogue at once, roughly doubling the catalogue's memory for the duration;
 * `iterateProducts()` reads once and clones/projects one batch at a time, so a
 * consumer that writes as it goes (an XML feed, an upload) keeps only a batch
 * of copies alive. Prefer it past a few thousand products.
 *
 * Iteration fixes WHICH products and in what order when it starts. Each batch
 * is cloned when it is reached, so on lowdb an edit saved mid-iteration can
 * show in a later batch. A true paged storage read (keyset on id) is the
 * real fix for very large catalogues and is not built here.
 */
import { withStockStatus, resolveLowStockThreshold } from '../commerce/stock-status';
import { withOmnibusReference } from '../commerce/price-history';
import { projectProductForReader, withMediaKind, buildMediaKindIndex } from '../product-fields';
import type { MediaKindIndex } from '../product-fields';
import type { Product, ProductImage, ProductVariant, StockStatusInfo } from '../../core/models';
import type { ProductFieldDef } from '../../core/product-fields-def';
import { settingsMap } from '../settings-map';
import { buildBrandDirectory } from '../commerce/brand';

/** A product as `host.catalog` hands it out: a copy, with the read-side fields. */
export type CatalogProduct = Omit<Product, 'variants' | 'images'> & {
  stock_status: StockStatusInfo;
  variants?: (ProductVariant & { stock_status: StockStatusInfo })[];
  reference_price_cents: number | null;
  images: ProductImage[];
  photos: ProductImage[];
  videos: ProductImage[];
};

/**
 * One maker, as `GET /api/brands` lists it.
 *
 * `Product.brand` is FREE TEXT ("Ray-Ban", "RAYBAN", or the lossy slug the
 * WooCommerce importer once wrote), so a lookup by slug against the brand
 * records alone misses most real products. Match a product's `brand` against
 * `spellings` instead: it holds every exact string active products use for
 * this maker.
 */
export interface CatalogBrand {
  /** The handle the storefront's `?brand=` filter resolves. */
  slug: string;
  /** The name to show: a curated record's when there is one, else the most-used spelling. */
  name: string;
  /** The stable identity the core matches brands on. */
  key: string;
  /** Every exact `Product.brand` string active products use for this maker. */
  spellings: string[];
}

export interface CatalogIterateOptions {
  /** Products per batch. Default 500, clamped to 1–5,000. */
  batchSize?: number;
}

export interface PluginCatalog {
  /**
   * Every product, every status, as copies. One full read, one full set of
   * copies: fine for a few thousand products. For larger catalogues use
   * `iterateProducts`.
   */
  listProducts: () => Promise<CatalogProduct[]>;
  /**
   * The same products, in the same order, as batches of copies. Storage is
   * read ONCE when iteration starts (a snapshot); each batch is cloned and
   * projected only when it is asked for.
   */
  iterateProducts: (opts?: CatalogIterateOptions) => AsyncIterable<CatalogProduct[]>;
  /**
   * Every maker, exactly as `GET /api/brands` lists them: makers with active
   * products plus every curated record, one entry per maker.
   */
  listBrands: () => Promise<CatalogBrand[]>;
}

export const CATALOG_BATCH_DEFAULT = 500;
export const CATALOG_BATCH_MAX = 5000;

/** The batch size actually used for a requested one. */
export function catalogBatchSize(requested: unknown): number {
  const n = Math.floor(Number(requested));
  if (!Number.isFinite(n) || n < 1) return CATALOG_BATCH_DEFAULT;
  return Math.min(n, CATALOG_BATCH_MAX);
}

interface ReadContext {
  threshold: number;
  fields: readonly ProductFieldDef[];
  mediaIndex: MediaKindIndex;
  now: number;
}

/**
 * One product, as a plugin may see it. Pure, so it is testable on a literal.
 *
 * The clone comes FIRST: every helper after it spreads only the top level, so
 * cloning later would leave `variants`, `images` and `custom` shared with the
 * cached row.
 */
export function projectCatalogProduct(
  product: Product,
  ctx: ReadContext,
): CatalogProduct {
  const copy = structuredClone(product);
  const derived = withOmnibusReference(withStockStatus(copy, ctx.threshold), ctx.now);
  const projected = projectProductForReader(derived, ctx.fields, false);
  return withMediaKind(projected, ctx.mediaIndex) as unknown as CatalogProduct;
}

async function readSource(): Promise<{ products: Product[]; ctx: ReadContext }> {
  const { LocalDB } = await import('../localdb');
  await LocalDB.init();
  const { getProductFieldDefs } = await import('../commerce-service');
  const [products, settings, fields, media] = await Promise.all([
    LocalDB.getProducts(),
    LocalDB.getSettings(),
    getProductFieldDefs(),
    LocalDB.getMedia(),
  ]);
  return {
    products,
    ctx: {
      threshold: resolveLowStockThreshold(settingsMap(settings)),
      fields,
      mediaIndex: buildMediaKindIndex(media),
      now: Date.now(),
    },
  };
}

export function createPluginCatalog(): PluginCatalog {
  return {
    listProducts: async () => {
      const { products, ctx } = await readSource();
      return products.map((p) => projectCatalogProduct(p, ctx));
    },
    iterateProducts: (opts?: CatalogIterateOptions) => {
      const size = catalogBatchSize(opts?.batchSize);
      return {
        async* [Symbol.asyncIterator]() {
          const { products, ctx } = await readSource();
          for (let i = 0; i < products.length; i += size) {
            yield products.slice(i, i + size).map((p) => projectCatalogProduct(p, ctx));
          }
        },
      };
    },
    listBrands: async () => {
      const { LocalDB } = await import('../localdb');
      await LocalDB.init();
      // The SAME directory GET /api/brands and `?brand=` use — not the raw
      // brand records, which nothing but the admin and the importer writes,
      // so on most shops they are empty or cover a few makers.
      const [products, records] = await Promise.all([LocalDB.getProducts(), LocalDB.getBrands()]);
      const directory = buildBrandDirectory(products, records);
      // Fresh objects of strings: a copy by construction.
      return directory.entries.map((e) => ({
        slug: e.slug,
        name: e.name,
        key: e.key,
        spellings: e.spellings.map((sp) => sp.name),
      }));
    },
  };
}
