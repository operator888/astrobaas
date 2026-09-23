import { normaliseTranslations, TRANSLATABLE_PRODUCT_FIELDS } from './i18n/catalogue-translations'
import { locales } from './i18n'
/**
 * Commerce service — the domain layer for products, orders and customers.
 *
 * Mirrors post-service.ts: routes stay thin (parse + auth + validate), this
 * module owns business rules, plugin hooks, webhooks and audit. All money is
 * integer cents; the house rule is no floats anywhere in commerce code.
 *
 * Hook contract (see PLUGIN_HOOKS):
 *   before_product_save / after_product_save / after_product_delete
 *   product_price (checkout-time unit price — sales rules plug in here)
 *   before_order_save / after_order_create / after_order_status_change
 */
import { LocalDB } from './localdb'
import { pluginManager, PLUGIN_HOOKS, type OrderLineExtras } from './plugin-system'
import { sanitizeHtml } from './sanitize'
import { fireEvent } from './webhooks'
import { recordAudit, AUDIT, summariseChanges } from './audit'
import { rankBy, PRODUCT_WEIGHTS } from './search/rank'
import { priceBasket } from './commerce/pricing-service'
import { totalsReconcile } from './commerce/totals'
import { normalizeAddress, formatAddressOneLine, isEmptyAddress } from './commerce/address'
import { brandKey, buildBrandDirectory, normalizeBrand, type BrandDirectory } from './commerce/brand'
import { effectiveCategories } from './commerce/collections'
import { scoreOrder, riskFields, hashIp } from './commerce/order-risk'
import { resolveTaxSettings } from './commerce/tax'
import {
  PRODUCT_FIELDS_SETTING, validateProductFieldDefs, type ProductFieldDef,
} from '../core/product-fields-def'
import {
  resolveCurrencySettings, rateFor, convertTotals,
  type CurrencySettings, type ResolvedCurrency,
} from './commerce/currency-rates'
import { canTransition } from './commerce/order-status'
import {
  resolvePaymentHoldSettings, countUnpaidForBuyer, VELOCITY_WINDOW_MS,
  isRoutableClientIp, ipWindowMs,
} from './commerce/payment-hold'
import { resolveAbandonmentSettings } from './commerce/abandonment'
import { normalizeCouponCode } from './commerce/coupons'
import { resolvePurchasable, explainResolveFailure, variantAvailability } from './commerce/variants'
import {
  normalizeMeasurement, normalizeBackorders, normalizeCatalogVisibility, normalizeTaxStatus,
  normalizeClassSlug, normalizeGtin, normalizeTags, normalizeDimensions, normalizeAttributes,
  normalizeDownloads, normalizeLinkedIds, normalizeImages, normalizeVariants, availableFor, PRODUCT_LIMITS,
  GPSR_TEXT_FIELDS,
  deriveSaleState, deriveInStock, normalizeCustomFields, normalizeVariantStock,
  type StockBases,
} from './product-fields'
import { resolveOrderLimits, resolveCommerceEnabled, resolveShopCurrency, type OrderLimits } from './commerce-settings'
import type { Address, Order, OrderItem, OrderStatus, Product } from '../core/models'
import { recordPrice } from './commerce/price-history'

export interface ServiceErr {
  ok: false
  status: number
  message: string
  /** Structured context for a validation refusal, surfaced to API clients. */
  details?: unknown
  /**
   * Stable machine-readable reason, e.g. `checkout.qty_over_limit`.
   *
   * A refusal a CUSTOMER sees has to be translatable, and the message here
   * cannot be: translating it server-side would mean threading a locale through
   * the whole commerce layer — `PriceBasketInput` and `placeOrder` have none —
   * to serve two Next.js storefronts that already have i18n frameworks and
   * would rather have a code.
   *
   * So the code is the contract and the English message is the fallback. A
   * storefront that knows the code renders its own sentence; one that does not
   * shows the message, which is what every client does today.
   */
  code?: string
  /**
   * Values the storefront needs to build its own sentence — `{ max: 3 }` for a
   * quantity cap. Without them a translated message can only be generic, which
   * is how "at most 3 per order" becomes "too many".
   */
  params?: Record<string, string | number>
}
export interface ServiceOk<T> {
  ok: true
  value: T
}
export type ServiceResult<T> = ServiceOk<T> | ServiceErr

const err = (
  status: number,
  message: string,
  details?: unknown,
  code?: string,
  params?: Record<string, string | number>,
): ServiceErr => ({ ok: false, status, message, details, code, params })

/**
 * A refused coupon, coded so the route can decide how much to say.
 *
 * The specific reason travels in `params.reason` (and the shortfall, when it
 * is a minimum-spend refusal); the route collapses both for anyone who is not
 * staff — see publicCouponRejection in commerce/coupons.ts.
 */
function couponRefusal(message: string, reason: string, shortfall?: number): ServiceErr {
  return err(400, message, undefined, 'checkout.coupon_invalid', {
    reason,
    ...(typeof shortfall === 'number' ? { shortfall_cents: shortfall } : {}),
  })
}

/** Settings as a map, or an empty one — a read failure must not fail checkout. */
async function readSettingsMap(): Promise<Record<string, unknown>> {
  try {
    const rows = await LocalDB.getSettings()
    const map: Record<string, unknown> = {}
    for (const r of rows) map[r.key] = r.value
    return map
  } catch {
    return {}
  }
}

/** The shop's "average order", as risk scoring has always measured it: the newest 200. */
const RISK_HISTORY_MIN = 200
/**
 * The most orders one checkout reads. A shop with more open orders than this
 * inside the abandonment window counts only the newest for the unpaid cap —
 * failing open, which for a cap is the side that loses no sale.
 */
const RECENT_ORDERS_MAX = 5000

export const ORDER_STATUSES: OrderStatus[] = [
  'pending', 'processing', 'on-hold', 'completed', 'cancelled', 'refunded', 'failed',
]

/* ── Products ──────────────────────────────────────────────────────── */

/**
 * Normalise the extended product fields in place.
 *
 * Only touches keys the caller actually supplied, so a partial update stays
 * partial — writing defaults for absent keys would silently reset fields the
 * caller never mentioned.
 */
function normalizeExtendedFields(
  p: Partial<Product>, selfId?: string, existingVariants?: Product['variants'],
): void {
  // `brand` had no line here at all — the only catalogue field without one.
  // Nothing trimmed it on any write path, so the admin form, the REST API, the
  // bulk importer and every plugin could each store a different spelling of one
  // maker, and one live shop accumulated 72 strings for 62 brands.
  if ('brand' in p) p.brand = normalizeBrand(p.brand)
  if ('gtin' in p) p.gtin = normalizeGtin(p.gtin)
  if ('tags' in p) p.tags = normalizeTags(p.tags)
  if ('catalog_visibility' in p) p.catalog_visibility = normalizeCatalogVisibility(p.catalog_visibility)
  if ('tax_status' in p) p.tax_status = normalizeTaxStatus(p.tax_status)
  if ('tax_class' in p) p.tax_class = normalizeClassSlug(p.tax_class)
  if ('shipping_class' in p) p.shipping_class = normalizeClassSlug(p.shipping_class)
  if ('backorders' in p) p.backorders = normalizeBackorders(p.backorders)
  if ('weight_grams' in p) p.weight_grams = normalizeMeasurement(p.weight_grams, PRODUCT_LIMITS.maxWeightGrams)
  if ('dimensions_mm' in p) p.dimensions_mm = normalizeDimensions(p.dimensions_mm)
  if ('low_stock_threshold' in p) p.low_stock_threshold = normalizeMeasurement(p.low_stock_threshold, 1_000_000)
  if ('attributes' in p) p.attributes = normalizeAttributes(p.attributes)
  if ('downloads' in p) p.downloads = normalizeDownloads(p.downloads)
  if ('upsell_ids' in p) p.upsell_ids = normalizeLinkedIds(p.upsell_ids, selfId)
  if ('cross_sell_ids' in p) p.cross_sell_ids = normalizeLinkedIds(p.cross_sell_ids, selfId)
  if ('images' in p) p.images = normalizeImages(p.images)
  if ('variants' in p) {
    p.variants = normalizeVariants(p.variants, existingVariants)
    // `type` is derived, never taken from the client.
    p.type = p.variants.length ? 'variable' : 'simple'
  }
  if ('purchase_note' in p && typeof p.purchase_note === 'string') {
    p.purchase_note = sanitizeHtml(p.purchase_note).slice(0, PRODUCT_LIMITS.purchaseNote)
  }
  for (const k of ['virtual', 'downloadable', 'sold_individually', 'reviews_enabled', 'manage_stock', 'requires_shipping'] as const) {
    if (k in p) p[k] = p[k] === true
  }
  // A virtual product is never shipped. Left to the operator these two drift
  // apart and a download gets a shipping quote.
  if (p.virtual === true) p.requires_shipping = false
}

export async function saveProduct(
  input: Partial<Product>,
  id?: string,
  /**
   * Who is doing this. Optional so the bulk importer and plugins keep working
   * unchanged; when absent the audit entry records `system`, which is honest —
   * an import genuinely has no logged-in user behind it.
   */
  actor?: string,
  /**
   * The counts the caller LOADED before it edited (see readStockBases). A
   * count still equal to its base is not written, so a save made from a form
   * opened minutes ago cannot hand back what checkout sold in between.
   * Optional: every caller that sends no base is saved exactly as before.
   */
  bases?: StockBases,
): Promise<ServiceResult<Product>> {
  const isNew = !id
  const filtered = pluginManager.applyFilters(
    PLUGIN_HOOKS.BEFORE_PRODUCT_SAVE, { ...input }, { isNew },
  ) as Partial<Product>

  // Sanitize AFTER the filter so plugins cannot smuggle HTML past the gate.
  if (typeof filtered.description === 'string') {
    filtered.description = sanitizeHtml(filtered.description)
  }
  if (typeof filtered.short_description === 'string') {
    filtered.short_description = sanitizeHtml(filtered.short_description)
  }

  // GPSR text, through the SAME gate and bounded.
  //
  // These are rendered to a buyer before purchase, so an unsanitised warning
  // would be stored HTML on a public page — and they are the fields most likely
  // to arrive from a supplier feed nobody controls. Bounded because a warning
  // is a paragraph, not a document: without a cap a bad feed makes every
  // product row enormous on three storage drivers at once.
  for (const key of GPSR_TEXT_FIELDS) {
    const v = filtered[key]
    if (typeof v === 'string') {
      filtered[key] = sanitizeHtml(v).slice(0, PRODUCT_LIMITS.purchaseNote) as never
    }
  }

  // Per-locale text goes through the SAME gate as the base fields, and here
  // rather than at the route so an import cannot take a laxer path than the
  // form. Without it a translation would be a way around every rule the base
  // fields enforce: unserved locales, non-translatable keys like `stock`,
  // unsanitised HTML, and unbounded length.
  if ('i18n' in filtered) {
    filtered.i18n = normaliseTranslations(filtered.i18n, {
      allowed: locales(),
      fields: TRANSLATABLE_PRODUCT_FIELDS,
      limits: {
        name: 200,
        description: 20000,
        short_description: 2000,
        purchase_note: PRODUCT_LIMITS.purchaseNote,
      },
      sanitize: sanitizeHtml,
    })
  }

  // Money sanity: integers only.
  for (const k of ['price_cents', 'regular_price_cents', 'sale_price_cents'] as const) {
    const v = filtered[k]
    if (v != null && (!Number.isInteger(v) || v < 0)) {
      return err(400, `${k} must be a non-negative integer (cents)`)
    }
  }

  // Extended catalogue fields. Normalised HERE rather than at the route so the
  // rules hold for every writer — the REST API, the bulk importer, the MCP
  // server, and any plugin calling saveProduct directly.
  // Existing variants are passed so an edit REUSES ids for unchanged option
  // combinations — regenerating them would orphan every historical order line.
  const existing = id ? await LocalDB.getProduct(id) : null
  normalizeExtendedFields(filtered, id, existing?.variants)

  // Merchant-declared fields, validated against the merchant's OWN rules —
  // here rather than at the route, so the REST API, the bulk importer, the MCP
  // server and any plugin calling saveProduct all go through the same check.
  if ('custom' in filtered) {
    const custom = normalizeCustomFields(
      filtered.custom, existing?.custom, await getProductFieldDefs(),
    )
    if (!custom.ok) {
      return { ok: false, status: 400, message: 'Invalid custom field values', details: custom.errors }
    }
    if (custom.value === undefined) delete filtered.custom
    else filtered.custom = custom.value
  }

  // A count the caller did not change is not written.
  //
  // The admin editor sends `stock` and every variant's `stock` on every save,
  // at the numbers it LOADED when the dialog opened; writing them back handed
  // checkout's sales back (tests/stock-race.test.mjs, D6, on all three
  // drivers). With a base to compare against, a count equal to it is left to
  // the stored row: the product's by dropping `stock` from the patch — the
  // in_stock rule below then keeps the stored flag — and a variant's by the
  // storage layer, which reads the stored count INSIDE its write (see
  // UpdateProductOptions). Both sides are normalised before the comparison, so
  // "unchanged" means unchanged as stored.
  //
  // A count that differs from its base is the operator setting it and is
  // written as typed, even if the stored count also moved since: a recount of
  // the shelf is an absolute, not a delta, and second-guessing it would leave
  // the operator no way to correct a count at all.
  let keepVariantStock: string[] = []
  if (!isNew && bases) {
    if (bases.stock !== undefined && 'stock' in filtered && filtered.stock === bases.stock) {
      delete filtered.stock
    }
    const variantBases = bases.variants
    if (variantBases && Array.isArray(filtered.variants)) {
      keepVariantStock = filtered.variants
        .filter(v => variantBases.has(v.id) && normalizeVariantStock(variantBases.get(v.id)) === v.stock)
        .map(v => v.id)
    }
  }

  // Derive the server-owned pricing/stock flags for EVERY writer — REST create
  // and update, the admin form, the MCP server, the bulk importer and any
  // plugin calling saveProduct directly.
  //
  // This is the fix for `on_sale` never being set outside the import path. It
  // sits here, after the plugin filter and the field normalisers, so it is the
  // last word: a client that sends `on_sale: true` on a full-price product gets
  // it overwritten rather than believed. The doc comment on
  // WRITABLE_PRODUCT_FIELDS always said these were derived and not accepted;
  // now that is true of the code as well.
  //
  // `existing` is passed so a PARTIAL update is judged against stored values.
  // `PUT { sale_price_cents: 1190 }` is the shape the admin form and most API
  // clients actually send, and resolving it against an empty patch would read
  // as the field being ignored.
  Object.assign(filtered, deriveSaleState(filtered, existing))
  // `in_stock` follows the count. A save that SETS the count derives it from
  // the new one. A save that does not leaves the stored flag alone — unless it
  // disagrees with the stored count, which is the stale row this derivation
  // was added to correct. Checkout maintains the flag atomically together with
  // the count it decrements, while `existing` was read BEFORE this save's
  // write: a flag derived from it re-advertised, as in stock, the last unit a
  // checkout sold in between (tests/stock-race.test.mjs, D3).
  const inStock = deriveInStock(filtered, existing)
  if (isNew || filtered.stock !== undefined || existing?.in_stock !== inStock) {
    filtered.in_stock = inStock
  }

  // The Omnibus evidence, recorded AFTER the sale state is derived, because
  // what must be remembered is the EFFECTIVE price a customer would have paid —
  // not the regular price behind a live discount. `recordPrice` appends only
  // when that number actually moves, so editing a description does not add a
  // duplicate observation.
  filtered.price_history = recordPrice(existing?.price_history, filtered.price_cents)

  // SKUs identify a product to a warehouse, an accountant and a feed. Two rows
  // sharing one is a data-integrity bug that surfaces far from here.
  if (typeof filtered.sku === 'string' && filtered.sku.trim()) {
    const sku = filtered.sku.trim()
    const clash = (await LocalDB.getProducts()).find(p => p.sku === sku && p.id !== id)
    if (clash) return err(400, `SKU "${sku}" is already used by "${clash.name}"`)
    filtered.sku = sku
  }

  if (isNew) {
    const slug = filtered.slug
    if (slug && await LocalDB.getProductBySlug(slug)) {
      return err(400, 'A product with that slug already exists')
    }
    const created = await LocalDB.createProduct({
      status: 'active',
      on_sale: false,
      in_stock: true,
      stock: null,
      categories: [],
      images: [],
      price_cents: 0,
      name: '',
      slug: slug ?? '',
      ...filtered,
    } as Omit<Product, 'id' | 'created_at' | 'updated_at'>)
    recordAudit(AUDIT.PRODUCT_CREATE, {
      actor: actor ?? 'system',
      target: created.slug || created.id,
      metadata: { name: created.name, price_cents: created.price_cents },
    })
    pluginManager.doAction(PLUGIN_HOOKS.AFTER_PRODUCT_SAVE, created)
    fireEvent('product.created', created).catch(() => {})
    return { ok: true, value: created }
  }

  // Slug uniqueness applies to updates too — otherwise two products can share a
  // slug and whichever loses the getProductBySlug race becomes unreachable.
  if (filtered.slug) {
    const clash = await LocalDB.getProductBySlug(filtered.slug)
    if (clash && clash.id !== id) {
      return err(400, 'A product with that slug already exists')
    }
  }

  const updated = await LocalDB.updateProduct(
    id!, filtered, keepVariantStock.length ? { keepVariantStock } : undefined,
  )
  if (!updated) return err(404, 'Product not found')
  // "Who dropped the price" is the question this exists to answer, so
  // price/stock/status carry their before and after; everything else is a field
  // name only. See summariseChanges().
  const changes = summariseChanges(existing as unknown as Record<string, unknown>, filtered as Record<string, unknown>)
  if (changes.length) {
    recordAudit(AUDIT.PRODUCT_UPDATE, {
      actor: actor ?? 'system',
      target: updated.slug || updated.id,
      metadata: { changes, name: updated.name },
    })
  }
  pluginManager.doAction(PLUGIN_HOOKS.AFTER_PRODUCT_SAVE, updated)
  fireEvent('product.updated', updated).catch(() => {})
  return { ok: true, value: updated }
}

export async function removeProduct(id: string, actor?: string): Promise<ServiceResult<{ id: string }>> {
  const existing = await LocalDB.getProduct(id)
  if (!existing) return err(404, 'Product not found')
  await LocalDB.deleteProduct(id)
  recordAudit(AUDIT.PRODUCT_DELETE, {
    actor: actor ?? 'system',
    target: existing.slug || id,
    metadata: { name: existing.name, price_cents: existing.price_cents },
  })
  pluginManager.doAction(PLUGIN_HOOKS.AFTER_PRODUCT_DELETE, existing)
  fireEvent('product.deleted', { id }).catch(() => {})
  return { ok: true, value: { id } }
}

/** Public product list with hook, filters and pagination. */
export async function listProducts(opts: {
  category?: string
  brand?: string
  search?: string
  onSale?: boolean
  featured?: boolean
  includeInactive?: boolean
  limit?: number
  offset?: number
}) {
  const stored = await LocalDB.getProducts()
  let products = pluginManager.applyFilters(PLUGIN_HOOKS.API_PRODUCTS_GET, stored) as Product[]
  if (!opts.includeInactive) products = products.filter(p => p.status === 'active')
  /*
   * The published brand directory — built at most once, and only when a filter
   * needs it. From the STORED products and the brands table, exactly the two
   * arrays GET /api/brands builds it from, so a slug that route publishes means
   * the same brand here. Built from `stored` rather than the list above because
   * the directory must not depend on who is asking (`includeInactive`) or on a
   * plugin's view of the catalogue: the slug is the listing's, and so is the key.
   */
  let directory: BrandDirectory | undefined
  const brandDirectory = async () =>
    (directory ??= buildBrandDirectory(stored, await LocalDB.getBrands()))
  if (opts.category) {
    /*
     * Manual membership OR an automatic rule.
     *
     * The categories are loaded only when a category filter is actually asked
     * for, and only when at least one of them HAS a rule — so a shop with no
     * automatic collections pays nothing for this, and the common path is the
     * same array lookup it has always been.
     */
    const cat = opts.category
    const withRules = (await LocalDB.getProductCategories()).filter(
      (c) => (c as { rule?: unknown }).rule,
    )
    // A rule on `brand` may name a brand by its published slug, and must mean
    // what `?brand=<slug>` means — so it gets the directory. Only the REQUESTED
    // category's rule decides whether a product is in it, so only that rule is
    // checked. One clock for the whole request, so a `within-days` rule cannot
    // flip mid-list.
    const now = Date.now()
    const targetRule = (withRules.find((c) => c.slug === cat) as
      { rule?: { conditions?: { field?: unknown }[] } } | undefined)?.rule
    const brands = (targetRule?.conditions ?? []).some((k) => k?.field === 'brand')
      ? await brandDirectory()
      : undefined
    products = withRules.length
      ? products.filter(p => effectiveCategories(p, withRules, now, brands).includes(cat))
      // `?? []`: `categories` is typed as always present, but a row written
      // around saveProduct (a plugin, a direct storage client, an importer, a
      // row older than the field) can lack it, and one such row made every
      // `?category=` request a 500. The rule branch above guards the same way.
      : products.filter(p => (p.categories ?? []).includes(cat))
  }
  if (opts.brand) {
    /*
     * Matched by IDENTITY, not by string equality.
     *
     * This was `p.brand === opts.brand`, which made every spelling its own
     * filter value: on a shop holding `Rayban` x16 and `RAYBAN` x1,
     * `?brand=Rayban` returned 16 of 17 and `?brand=Ray-Ban` returned none —
     * while `?search=RAYBAN` found all 17, because search folds and this did
     * not. Two filters on one route disagreeing about the same word.
     *
     * `brandKey` also reconciles the two vocabularies stored brands come in:
     * shops the WooCommerce importer filled before it kept names hold a SLUG
     * (`ray-ban`) while the admin form stores display text (`Ray-Ban`). Both
     * fold to `rayban`, so a menu built from either finds the products written
     * by the other.
     *
     * But a PUBLISHED SLUG is resolved first, through the directory that
     * assigned it — never re-folded. `slugify` transliterates and `brandKey`
     * does not, so re-folding sent `?brand=strasse` looking for a brand keyed
     * `strasse` when Straße is keyed `straße`, `?brand=gyalia-opsi` looking for
     * Latin letters in a Greek name, and a curated slug like `rb` looking for a
     * brand called RB. All three were listed with a count and returned nothing.
     * A value that is not a published slug is matched by identity, as before.
     */
    const want = (await brandDirectory()).keyFor(opts.brand)
    if (want) products = products.filter(p => brandKey(p.brand) === want)
  }
  if (opts.onSale) products = products.filter(p => p.on_sale)
  if (opts.featured) products = products.filter(p => p.featured === true)
  // Stable order: explicit position first, then newest.
  products = [...products].sort((a, b) => {
    const pa = a.position ?? Number.MAX_SAFE_INTEGER
    const pb = b.position ?? Number.MAX_SAFE_INTEGER
    if (pa !== pb) return pa - pb
    return (b.created_at ?? '').localeCompare(a.created_at ?? '')
  })
  if (opts.search) {
    // RANKED, not merely filtered. This used to be `matchesSearch`, which
    // returns a boolean — so a shopper typing two words got every product
    // containing either, in storage order, with the one they meant somewhere
    // in the middle. Relevance now comes from lib/search/rank.ts, the same
    // scorer /api/search uses, so the two cannot drift apart again.
    //
    // Accent- and case-insensitivity is inherited from foldForSearch: a shopper
    // types "ΑΛΥΣΙΔΑ" or "αλυσιδα" for a product stored as "αλυσίδα".
    //
    // gtin and tags are searched too: both are identifiers people genuinely
    // paste (a barcode off the packaging, a merchandising tag), and both are
    // short and precise, so including them cannot flood the results the way
    // free-text descriptions would. They are weighted just under the name and
    // ABOVE the brand — someone pasting a barcode knows exactly what they want.
    //
    // The sort above (position, then recency) has already run, and ranking is
    // stable, so equally-relevant products keep the merchandising order the
    // shop chose. That is why this filter runs AFTER the sort and not before.
    // A search module may contribute alternative spellings. Null when none is
    // installed, which is the default and costs nothing: the core tries the
    // literal term first regardless, and only reaches for an expander on the
    // terms that found nothing.
    //
    // The SETTINGS are read here and handed to the hook, rather than the module
    // reading them itself. applyFilters is synchronous and every settings read
    // is async, so a module trying to read its own configuration inside a filter
    // would have to either block or cache — and a cache would keep answering
    // with a synonym table the operator has since edited. The async call site
    // already has to await, so it does the reading.
    const searchSettings = await LocalDB.getSettings().catch(() => [])
    const settings: Record<string, unknown> = Object.create(null)
    for (const row of (searchSettings as { key?: string; value?: unknown }[])) {
      if (typeof row?.key === 'string' && row.key.startsWith('search_')) {
        settings[row.key] = row.value
      }
    }
    // The operator's synonym table is the DEFAULT, not null. Passing null meant
    // only a plugin could ever fill this seam, so a shop that typed
    // «σκελετός, μοντούρα» into Settings saw it work in the blog and not in the
    // catalogue — which is the surface it was written for.
    const { expanderFromSetting } = await import('./search/expander')
    const expand = pluginManager.applyFilters(
      PLUGIN_HOOKS.SEARCH_EXPAND,
      expanderFromSetting(settings.search_synonyms),
      { products, query: opts.search, settings },
    ) as ((term: string) => readonly string[]) | null

    products = rankBy(
      products,
      opts.search,
      (p) => [
        { text: p.name, weight: PRODUCT_WEIGHTS.name },
        { text: p.sku, weight: PRODUCT_WEIGHTS.sku },
        { text: p.gtin, weight: PRODUCT_WEIGHTS.gtin },
        { text: p.brand, weight: PRODUCT_WEIGHTS.brand },
        { text: (p.tags ?? []).join(' '), weight: PRODUCT_WEIGHTS.tags },
      ],
      typeof expand === 'function' ? { expand } : {},
    ).map((r) => r.item)
  }
  const total = products.length
  const limit = Math.min(Math.max(opts.limit ?? 24, 1), 500)
  const offset = Math.max(opts.offset ?? 0, 0)
  const page = products.slice(offset, offset + limit)
  return {
    products: page,
    meta: {
      total, count: page.length, limit, offset,
      page: Math.floor(offset / limit) + 1,
      hasMore: offset + page.length < total,
    },
  }
}

/* ── Bulk catalogue import ─────────────────────────────────────────── */

interface ImportCategory {
  slug: string
  name: string
  parent_slug?: string
  position?: number
}

interface ImportProduct {
  slug: string
  name: string
  sku?: string
  brand?: string
  price_cents: number
  regular_price_cents?: number
  sale_price_cents?: number | null
  stock?: number | null
  categories?: string[]
  status?: string
  featured?: boolean
  position?: number
  description?: string
  short_description?: string
  images?: Array<{ src: string; alt?: string }>
}

/** Accept both our status vocabulary and common CMS synonyms. */
export function normalizeStatus(s: string | undefined): Product['status'] {
  if (s === 'draft' || s === 'archived') return s
  return 'active' // 'active' | 'published' | undefined
}

/**
 * Turn one untrusted import row into a product patch, or explain why it can't be.
 *
 * PURE — no database, no I/O — so the money/sale/stock rules that decide what a
 * shopper is charged are unit-testable in isolation. `knownCategories` is the
 * set of category slugs that exist after the category pass.
 */
export function normalizeImportProduct(
  row: ImportProduct | null | undefined,
  knownCategories: Set<string>,
): { ok: true; patch: Partial<Product> } | { ok: false; reason: string } {
  if (!row?.slug || !row?.name || !Number.isInteger(row.price_cents) || row.price_cents < 0) {
    return { ok: false, reason: `product skipped: missing slug/name or bad price (${row?.slug ?? '?'})` }
  }
  const unknown = (row.categories ?? []).filter(slug => !knownCategories.has(slug))
  if (unknown.length > 0) {
    return { ok: false, reason: `product "${row.slug}" skipped: unknown categories ${unknown.join(', ')}` }
  }

  // The SAME helper the API path uses. Two copies of this rule is how the API
  // and the importer came to disagree about what a sale is in the first place,
  // and the assertion in tests/commerce.test.mjs pins them together.
  const priced = deriveSaleState({
    price_cents: row.price_cents,
    regular_price_cents: row.regular_price_cents ?? row.price_cents,
    sale_price_cents: row.sale_price_cents ?? null,
  })

  return {
    ok: true,
    patch: {
      name: row.name,
      slug: row.slug,
      sku: row.sku || undefined,
      brand: row.brand || undefined,
      price_cents: priced.price_cents,
      regular_price_cents: priced.regular_price_cents,
      sale_price_cents: priced.sale_price_cents,
      on_sale: priced.on_sale,
      stock: row.stock ?? null,
      // null stock = untracked = always purchasable.
      in_stock: row.stock == null ? true : row.stock > 0,
      categories: row.categories ?? [],
      status: normalizeStatus(row.status),
      featured: row.featured === true,
      position: Number.isFinite(row.position) ? row.position : undefined,
      description: row.description ? sanitizeHtml(row.description) : undefined,
      short_description: row.short_description ? sanitizeHtml(row.short_description) : undefined,
      /*
       * `normalizeImages`, not a hand-rolled map.
       *
       * This rebuilt each entry as `{ src, alt }` and therefore STRIPPED
       * `kind` — and `importCatalogue` writes through `LocalDB.updateProduct`
       * rather than `saveProduct`, so `normalizeImages` never ran on this path
       * either. The result was a feed-driven shop permanently in the
       * pre-fix state: every catalogue refresh re-created gallery entries with
       * no kind, on products that were correct an hour earlier, with no error
       * and no log line.
       *
       * Sharing the normaliser also means an import gets the src validation,
       * the de-duplication and the cap for free, instead of a second copy of
       * three rules that were already written once.
       */
      images: normalizeImages(row.images),
    },
  }
}

/** Sum line totals. Integer cents in, integer cents out — never floats. */
export function orderTotalCents(items: Array<{ total_cents: number }>): number {
  return items.reduce((n, i) => n + i.total_cents, 0)
}

/**
 * Upsert an entire catalogue (categories + products), matched by slug.
 * `replace` wipes the existing catalogue first. Each bad row is skipped with a
 * reason rather than failing the batch — the caller decides how strict to be.
 */
export async function importCatalogue(input: {
  categories?: ImportCategory[]
  products?: ImportProduct[]
  replace?: boolean
}): Promise<{
  categories: { created: number; updated: number }
  products: { created: number; updated: number }
  skipped: number
  errors: string[]
}> {
  const errors: string[] = []
  let skipped = 0
  const result = {
    categories: { created: 0, updated: 0 },
    products: { created: 0, updated: 0 },
    skipped: 0,
    errors,
  }

  if (input.replace) {
    for (const p of await LocalDB.getProducts()) await LocalDB.deleteProduct(p.id)
    for (const c of await LocalDB.getProductCategories()) await LocalDB.deleteProductCategory(c.id)
  }

  const existingCats = new Map((await LocalDB.getProductCategories()).map(c => [c.slug, c]))
  for (const c of input.categories ?? []) {
    if (!c?.slug || !c?.name) {
      skipped++; errors.push(`category skipped: missing slug/name (${JSON.stringify(c).slice(0, 80)})`)
      continue
    }
    const patch = {
      name: c.name,
      slug: c.slug,
      parent_slug: c.parent_slug || undefined,
      position: Number.isFinite(c.position) ? c.position : undefined,
    }
    const existing = existingCats.get(c.slug)
    if (existing) {
      await LocalDB.updateProductCategory(existing.id, patch)
      result.categories.updated++
    } else {
      const created = await LocalDB.createProductCategory(patch)
      existingCats.set(c.slug, created)
      result.categories.created++
    }
  }

  const existingProducts = new Map((await LocalDB.getProducts()).map(p => [p.slug, p]))
  const knownCategories = new Set(existingCats.keys())
  for (const p of input.products ?? []) {
    const norm = normalizeImportProduct(p, knownCategories)
    if (!norm.ok) {
      skipped++; errors.push(norm.reason)
      continue
    }
    const existing = existingProducts.get(p.slug)
    if (existing) {
      // A feed moves prices too, and the rule does not care how the price
      // changed — only what it was. Missing this call site would leave every
      // feed-driven shop unable to evidence a reference price.
      norm.patch.price_history = recordPrice(existing.price_history, norm.patch.price_cents ?? existing.price_cents)
      await LocalDB.updateProduct(existing.id, norm.patch)
      result.products.updated++
    } else {
      const created = await LocalDB.createProduct(norm.patch as Omit<Product, 'id' | 'created_at' | 'updated_at'>)
      existingProducts.set(p.slug, created)
      result.products.created++
    }
  }

  result.skipped = skipped
  return result
}

/* ── Orders ────────────────────────────────────────────────────────── */

/**
 * Current order limits from the settings table. Read per checkout so an
 * operator's change takes effect immediately; a storage failure falls back to
 * the clamped defaults rather than leaving checkout uncapped.
 */
export async function getOrderLimits(): Promise<OrderLimits> {
  try {
    const rows = await LocalDB.getSettings()
    const map: Record<string, unknown> = {}
    for (const r of rows) map[r.key] = r.value
    return resolveOrderLimits(map)
  } catch {
    return resolveOrderLimits(null)
  }
}

/**
 * The currency a NEW order is priced in, from the admin setting.
 *
 * Exported because the QUOTE endpoint needs the same answer: a basket priced in
 * one currency and an order placed in another is the worst kind of bug, because
 * the numbers are right and only the symbol is wrong. One reader, two callers.
 *
 * A storage failure falls back to the documented default rather than throwing —
 * the same choice `getOrderLimits` makes, and for the same reason: a hiccup
 * must not fail a checkout that is otherwise fine.
 */
/**
 * The merchant's declared product fields.
 *
 * RE-VALIDATED on every read rather than trusted. The definitions live in a
 * setting, and `POST /api/settings/update` accepts any admin-written JSON for a
 * key that passes SAFE_KEY — so the stored value is client input until it has
 * been through the validator. `custom_content_types` has the identical hole and
 * the identical answer.
 */
/** The shop's own country, for the risk signal that compares against it. */
export async function getTaxOrigin(): Promise<string | undefined> {
  try {
    const rows = await LocalDB.getSettings()
    const map: Record<string, unknown> = {}
    for (const r of rows) map[r.key] = r.value
    return resolveTaxSettings(map).originCountry
  } catch {
    return undefined
  }
}

export async function getProductFieldDefs(): Promise<ProductFieldDef[]> {
  try {
    // `.value`, not the row. getSetting returns the whole { key, value }
    // record, and passing that straight to the validator makes every stored
    // definition parse as "not an array" and vanish — silently, because an
    // empty definition list is a legitimate state.
    const row = await LocalDB.getSetting(PRODUCT_FIELDS_SETTING)
    return validateProductFieldDefs(row?.value).fields
  } catch {
    return []
  }
}

export async function getCurrencySettings(): Promise<CurrencySettings> {
  const base = await getShopCurrency()
  try {
    const rows = await LocalDB.getSettings()
    const map: Record<string, unknown> = {}
    for (const r of rows) map[r.key] = r.value
    return resolveCurrencySettings(map, base)
  } catch {
    return resolveCurrencySettings(null, base)
  }
}

/**
 * Which currency to price this basket in, and at what rate.
 *
 * ONE reader, so the quote endpoint and checkout cannot disagree — the same
 * reason `getShopCurrency` is shared, and the bug it prevents is worse here: a
 * basket quoted in dollars and charged in euros has the right numbers and the
 * wrong symbol, which nobody notices until the card statement.
 *
 * An unknown or disabled currency falls back to the base rather than failing.
 * A storefront asking for a currency the shop does not offer should see the
 * shop's own prices, not an error page — and it can see which codes exist from
 * the quote response.
 */
export async function resolvePresentment(requested: unknown): Promise<{
  settings: CurrencySettings
  currency: string
  rate: ResolvedCurrency | null
}> {
  const settings = await getCurrencySettings()
  const rate = rateFor(settings, requested)
  return { settings, currency: rate ? rate.code : settings.base, rate }
}

export async function getShopCurrency(): Promise<string> {
  try {
    const rows = await LocalDB.getSettings()
    const map: Record<string, unknown> = {}
    for (const r of rows) map[r.key] = r.value
    return resolveShopCurrency(map)
  } catch {
    return resolveShopCurrency(null)
  }
}

/**
 * Whether this install is a shop. A storage failure reads as "not a shop",
 * which only ever HIDES commerce chrome — the request-blocking gate in the
 * middleware makes the opposite choice (fail-open) for exactly the reason
 * this one does not need to: hiding a dashboard card during a hiccup costs
 * nothing, 404ing a live storefront costs orders.
 */
export async function isCommerceEnabled(): Promise<boolean> {
  try {
    const rows = await LocalDB.getSettings()
    const map: Record<string, unknown> = {}
    for (const r of rows) map[r.key] = r.value
    return resolveCommerceEnabled(map)
  } catch {
    return false
  }
}

/**
 * Order numbers now come from an ATOMIC counter (Storage.nextSequence).
 *
 * The previous read-max-then-increment handed two concurrent checkouts the
 * same number — documented in COMMERCE.md as a known limit, and fixed here
 * rather than documented again. The counter is seeded past any existing
 * numbers on first use so an upgraded install does not reissue OG-1001.
 */
let counterSeeded = false
async function allocateOrderNumber(): Promise<string> {
  if (!counterSeeded) {
    counterSeeded = true
    try {
      const existing = await LocalDB.getOrders()
      const max = existing.reduce((n, o) => {
        const m = /^OG-(\d+)$/.exec(o.number ?? '')
        return m ? Math.max(n, Number(m[1])) : n
      }, 1000)
      // Walk the counter up to the historical maximum once. Cheap, and only on
      // the first checkout after an upgrade.
      let current = await LocalDB.nextSequence('order_number')
      while (current <= max) current = await LocalDB.nextSequence('order_number')
      return `OG-${current}`
    } catch {
      /* fall through to a plain allocation */
    }
  }
  return `OG-${await LocalDB.nextSequence('order_number')}`
}

/**
 * Place an order (public checkout path). Server-side pricing: line totals are
 * computed from the stored product prices (through the PRODUCT_PRICE hook) —
 * client-supplied totals are ignored. Stock is decremented when tracked.
 */
export async function placeOrder(input: {
  email: string
  name?: string
  phone?: string
  /** LEGACY one-line address. Still accepted, and still what a storefront that
   *  predates structured addresses sends. When `shipping_address` is supplied
   *  this is IGNORED and re-rendered from it, so the two can never disagree. */
  address?: string
  /** Structured delivery address. */
  shipping_address?: unknown
  /** Structured invoice address. Absent means "same as delivery", and the
   *  server stores a COPY rather than a flag — see Order.billing_address. */
  billing_address?: unknown
  note?: string
  payment_method?: string
  items: Array<{
    product_id: string
    variant_id?: string | null
    qty: number
    /** Per-line prescription, required when the product says it is. */
    prescription?: unknown
  }>
  /** Destination, for shipping + tax. */
  shipping_country?: string
  shipping_postcode?: string
  /**
   * The ordering IP, for local risk signals. HASHED before it is stored and
   * never kept raw — see commerce/order-risk.ts.
   */
  client_ip?: string
  /** Chosen method id. Its COST is re-derived server-side, never accepted. */
  shipping_method_id?: string
  coupon_code?: string
  /**
   * The currency the buyer is being quoted in.
   *
   * A CODE, never an amount — the same rule as `shipping_method_id` and
   * `coupon_code`. The client names what it wants; the server decides whether
   * it is on offer and applies the operator's own rate.
   */
  currency?: string
  /**
   * Which unpaid-order caps apply to this caller (commerce/payment-hold.ts).
   *
   * Absent means NONE, so every existing internal caller — importers,
   * plugins, scripts — behaves as before. The public route sets both for an
   * anonymous shopper, only `email` for an API key (every shopper behind a
   * storefront's server shares its address), and neither for staff.
   */
  buyer_limits?: { email?: boolean; ip?: boolean }
}): Promise<ServiceResult<Order>> {
  if (!input.items?.length) return err(400, 'Order has no items', undefined, 'checkout.no_items')

  // Checkout is public and anonymous, so these caps are an abuse control as much
  // as a UX rule — they bound what one request can drain or inflate.
  const limits = await getOrderLimits()
  if (input.items.length > limits.maxItemsPerOrder) {
    return err(400, `Too many items in one order (max ${limits.maxItemsPerOrder})`, undefined,
      'checkout.too_many_items', { max: limits.maxItemsPerOrder })
  }

  /*
   * The buyer's recent orders, read ONCE and bounded, before any stock moves.
   *
   * Two consumers. The UNPAID CAP needs every open unpaid order in the window
   * an unpaid order can hold stock for — the abandonment window — and runs
   * first, so a refused checkout reserves nothing. RISK SCORING, further down,
   * needs the last half hour for velocity and "enough" orders for the shop's
   * average. It used to read the whole order book and keep the newest 200,
   * which truncated its 30-minute window exactly when a shop was busiest —
   * the moment velocity matters. One indexed read serves both.
   */
  const settingsMap = await readSettingsMap()
  const hold = resolvePaymentHoldSettings(settingsMap)
  const nowMs = Date.now()
  const ipHash = hashIp(input.client_ip, process.env.AUTH_SECRET)
  const capWindowMs = Math.max(VELOCITY_WINDOW_MS, resolveAbandonmentSettings(settingsMap).days * 86_400_000)
  let recent: Order[] = []
  try {
    recent = await LocalDB.getRecentOrders({
      since: new Date(nowMs - capWindowMs).toISOString(),
      atLeast: RISK_HISTORY_MIN,
      atMost: RECENT_ORDERS_MAX,
    })
  } catch {
    // A read failure costs the cap and the velocity signal, never the sale —
    // the write that follows will fail loudly if storage is really down.
  }
  const cap = hold.maxUnpaidPerBuyer
  // The address counts only when it is the shopper's own — see
  // isRoutableClientIp: a loopback or private address is a proxy or a
  // container, and counting it would cap the whole shop as one buyer.
  const capByIp = !!input.buyer_limits?.ip && isRoutableClientIp(input.client_ip)
  if (cap > 0 && (input.buyer_limits?.email || capByIp)) {
    const held = countUnpaidForBuyer(recent, {
      email: input.buyer_limits?.email ? input.email : undefined,
      ipHash: capByIp ? ipHash : undefined,
    }, { email: nowMs - capWindowMs, ip: nowMs - ipWindowMs(hold.holdMinutes) })
    if (held.byEmail >= cap || held.byIp >= cap) {
      return err(429,
        `There are already ${cap} unpaid orders waiting for payment. Pay for or cancel one of them before placing another.`,
        undefined, 'checkout.too_many_unpaid', { max: cap })
    }
  }

  // Stock already taken, so it can be handed back if a later line fails.
  const reserved: Array<{ product_id: string; qty: number; variant_id?: string }> = []
  // A coupon use already counted (claimCouponUse), handed back the same way.
  let couponClaimed: string | null = null
  const rollback = async () => {
    for (const r of reserved) {
      await LocalDB.releaseStock(r.product_id, r.qty, { variantId: r.variant_id ?? null }).catch(() => {})
    }
    reserved.length = 0
    if (couponClaimed) {
      const id = couponClaimed
      couponClaimed = null
      await LocalDB.releaseCouponUse(id).catch(() => {})
    }
  }

  try {
    const items: OrderItem[] = []
    let total = 0

    for (const line of input.items) {
      const qty = Math.floor(Number(line.qty))
      if (!Number.isFinite(qty) || qty < 1) {
        await rollback()
        return err(400, 'Invalid quantity', undefined, 'checkout.invalid_quantity')
      }
      if (qty > limits.maxQtyPerProduct) {
        await rollback()
        return err(400, `At most ${limits.maxQtyPerProduct} of any one product per order`, undefined,
          'checkout.qty_over_limit', { max: limits.maxQtyPerProduct })
      }
      const product = await LocalDB.getProduct(line.product_id)
      if (!product || product.status !== 'active') {
        await rollback()
        return err(400, `Product unavailable: ${line.product_id}`, undefined,
          'checkout.product_unavailable', { product_id: String(line.product_id) })
      }

      // Which variation is being bought? A variable product with no valid
      // variant is refused — an order for "the frame" with no colour cannot be
      // picked from a shelf.
      const resolved = resolvePurchasable(product, line.variant_id)
      if (!resolved) {
        await rollback()
        return err(400, explainResolveFailure(product, line.variant_id).message)
      }

      // Vertical-specific line rules — optical prescriptions, and anything a
      // future vertical needs. Core asks ONE generic question and knows nothing
      // about the answer; `src/plugins/optical` is what makes it mean dioptres.
      //
      // This used to be an inline prescription check: core code that knew what
      // a cylinder axis was, in the middle of checkout. See
      // PLUGIN_HOOKS.ORDER_LINE_EXTRAS.
      //
      // It runs BEFORE the stock reserve on purpose — refusing after reserving
      // would hold a lens out of stock for an order that was never going to
      // ship.
      const extras = pluginManager.applyFilters(
        PLUGIN_HOOKS.ORDER_LINE_EXTRAS,
        { ok: true, patch: {} } as OrderLineExtras,
        { line, product, name: resolved.name },
      ) as OrderLineExtras
      if (!extras || typeof extras !== 'object' || !('ok' in extras)) {
        await rollback()
        return err(500, 'An extension returned an invalid order-line result')
      }
      if (!extras.ok) {
        await rollback()
        // Forward the plugin's own code when it supplies one, so a vertical's
        // refusal is as translatable as core's. `message` stays authoritative
        // for clients that do not know the code, and for plugin builds that
        // predate it.
        return err(400, extras.message, undefined, extras.code, extras.params)
      }

      // Per-product POLICY rules only — the ones that do not depend on the live
      // count, so they are a 400 (your request is wrong). The stock decision
      // deliberately stays with the atomic reserve below, which answers 409
      // (the world changed); deciding it here would both duplicate the check
      // non-atomically and downgrade a retryable conflict to a permanent error.
      const allowed = variantAvailability(resolved, product, qty)
      if (!allowed.ok && allowed.code !== 'insufficient-stock') {
        await rollback()
        return err(400, `${allowed.reason}: ${resolved.name}`)
      }

      // ATOMIC: the availability check and the decrement are one step. Checking
      // stock and decrementing separately lets concurrent checkouts interleave
      // and oversell the item. For a variant this draws down the VARIANT's own
      // count, not a pool shared by every colour.
      const stockOpts = { variantId: resolved.variant_id ?? null }
      const got = await LocalDB.reserveStock(product.id, qty, stockOpts)
      if (!got) {
        // The atomic reserve refused, which means the count ran out between the
        // check above and now. A backorder policy is the only thing that may
        // override it — and it must go through the SAME atomic call with the
        // allowance flag, never a second non-atomic write, or the race returns.
        const policy = normalizeBackorders(product.backorders)
        const backordered = policy !== 'no'
          ? await LocalDB.reserveStock(product.id, qty, { ...stockOpts, allowBackorder: true })
          : false
        if (!backordered) {
          await rollback()
          return err(409, `Insufficient stock for ${resolved.name}`)
        }
      }
      reserved.push({ product_id: product.id, qty, variant_id: resolved.variant_id })

      const unit = pluginManager.applyFilters(
        PLUGIN_HOOKS.PRODUCT_PRICE, resolved.price_cents, product, { qty, variant: resolved },
      ) as number
      if (!Number.isInteger(unit) || unit < 0) {
        await rollback()
        return err(500, 'Price hook returned an invalid price')
      }
      items.push({
        product_id: product.id,
        variant_id: resolved.variant_id,
        // Frozen, not referenced: renaming "Black" to "Matte Black" next year
        // must not change what this customer ordered.
        variant_options: resolved.options,
        name: resolved.name,
        qty,
        total_cents: unit * qty,
        // Whatever the vertical attached, frozen onto the line at purchase.
        ...extras.patch,
      })
      total += unit * qty
    }

    /*
     * Addresses, resolved once so the draft literal below stays readable.
     *
     * Three rules, and the ORDER of them is what makes the flat string and the
     * structured fields incapable of disagreeing:
     *  1. A supplied `shipping_address` WINS. The legacy one-line `address` is
     *     then re-rendered from it rather than taken from the client, so a
     *     storefront that sends both cannot store a delivery address that says
     *     one thing structured and another in the line every current reader
     *     prints.
     *  2. No `billing_address` means "same as delivery", and the server stores
     *     a COPY. Not a flag: see the note on Order.billing_address.
     *  3. A storefront that sends only the flat string keeps working exactly as
     *     before and gets no structured fields — because inventing them from
     *     that string is the parse this codebase refuses to do.
     */
    const addressFields: {
      address?: string
      shipping_address?: Address
      billing_address?: Address
    } = {}
    if (input.shipping_address !== undefined && input.shipping_address !== null) {
      const parsed = normalizeAddress(input.shipping_address)
      if (!parsed.ok) {
        await rollback()
        return err(400, `shipping_address: ${parsed.error}`)
      }
      if (!isEmptyAddress(parsed.value)) {
        addressFields.shipping_address = parsed.value
        addressFields.address = formatAddressOneLine(parsed.value)
      }
    }
    if (addressFields.address === undefined && input.address?.trim()) {
      addressFields.address = input.address.trim()
    }
    if (input.billing_address !== undefined && input.billing_address !== null) {
      const parsed = normalizeAddress(input.billing_address)
      if (!parsed.ok) {
        await rollback()
        return err(400, `billing_address: ${parsed.error}`)
      }
      if (!isEmptyAddress(parsed.value)) addressFields.billing_address = parsed.value
    }
    if (!addressFields.billing_address && addressFields.shipping_address) {
      addressFields.billing_address = { ...addressFields.shipping_address }
    }

    /*
     * WHERE THE PARCEL IS GOING, from whichever field carries it.
     *
     * A storefront that sends a structured `shipping_address` should not ALSO
     * have to repeat the country in a scalar — but until now the scalar was the
     * only thing read, so a modern client sending only the structured address
     * got `country: undefined`.
     *
     * That was a shipping-method bug and is about to be a VAT bug: with
     * destination resolution on, an unknown destination resolves 'domestic' and
     * charges a German buyer Greek VAT. The scalar still WINS when present, so
     * nothing that works today changes.
     */
    const destination = {
      country: input.shipping_country ?? addressFields.shipping_address?.country,
      postcode: input.shipping_postcode ?? addressFields.shipping_address?.postcode,
    }


    // THE shared calculation. `quote` calls the identical function, so a
    // quoted total and a charged total cannot drift apart — the whole reason
    // pricing lives in one place.
    const priced = await priceBasket({
      items: input.items.map(i => ({
        product_id: i.product_id, variant_id: i.variant_id, qty: Math.floor(Number(i.qty)),
      })),
      destination: destination,
      shipping_method_id: input.shipping_method_id,
      coupon_code: input.coupon_code,
      email: input.email,
    }, { checkAvailability: true })

    if (!priced.ok) {
      await rollback()
      return err(priced.status, priced.message)
    }
    // A coupon the customer typed must not be silently dropped: they agreed to
    // a discounted price, so a rejected code is a 400 with the reason, not an
    // order at full price.
    //
    // Coded `checkout.coupon_invalid`, with the specific reason in params. The
    // ROUTE decides who may see that reason (publicCouponRejection): a
    // stranger is told only what a missing code is told, so checkout cannot be
    // used to learn which codes exist.
    if (priced.coupon && !priced.coupon.ok) {
      await rollback()
      return couponRefusal(priced.coupon.message, priced.coupon.reason, priced.coupon.shortfall_cents)
    }

    /*
     * Presentment currency.
     *
     * The basket is priced in the shop's BASE currency — that is where the
     * catalogue's numbers live — and then restated. Converting the priced
     * result rather than the catalogue means tax is computed on the real
     * prices at the real rates, and only the presentation moves.
     */
    const presentment = await resolvePresentment(input.currency)
    if (presentment.rate?.stale && presentment.settings.staleBlocksCheckout) {
      await rollback()
      return err(
        409,
        `The exchange rate for ${presentment.currency} is out of date. Please try again shortly.`,
        undefined,
        'checkout.stale_fx_rate',
      )
    }

    const baseTotals = priced.totals
    const t = presentment.rate
      ? convertTotals(baseTotals, presentment.settings.base, presentment.currency, presentment.rate.rate_ppm)
      : baseTotals

    /*
     * The base-currency view, frozen alongside the rate.
     *
     * Taken from the UNCONVERTED figures, never by dividing the presented ones
     * back. Back-conversion rounds a second time and would disagree with the
     * books by a cent on a bad day — and the whole point of storing this is
     * that the accounts can be reconciled without anyone recomputing anything.
     */
    const fxFields: Partial<Order> = presentment.rate
      ? {
          base_currency: presentment.settings.base,
          base_subtotal_cents: baseTotals.subtotal_cents,
          base_tax_cents: baseTotals.tax_cents,
          base_total_cents: baseTotals.total_cents,
          fx_rate_ppm: presentment.rate.rate_ppm,
          fx_rate_at: presentment.rate.updated_at,
          ...(presentment.rate.stale ? { fx_rate_stale: true } : {}),
        }
      : {}


    let draft: Omit<Order, 'id' | 'created_at' | 'updated_at'> = {
      number: await allocateOrderNumber(),
      status: 'pending',
      // The shop's configured currency, FROZEN onto the order — like the line
      // items and the prescription. This was the literal 'EUR', which made
      // every install on earth a euro shop while the money formatter happily
      // handled any currency, so the platform looked multi-currency and was
      // not. Changing the setting changes the NEXT order and rewrites nothing.
      currency: presentment.currency,
      ...fxFields,
      total_cents: t.total_cents,
      subtotal_cents: t.subtotal_cents,
      discount_cents: t.discount_cents,
      shipping_cents: t.shipping_cents,
      tax_cents: t.tax_cents,
      prices_include_tax: t.prices_include_tax,
      /*
       * SHIPPING TAX, persisted at last.
       *
       * `tax_cents` is goods tax PLUS shipping tax, and the shipping half was
       * never stored — so a stored order could not be reconciled and the
       * receipt could not state its own VAT line. Both were documented holes.
       * Written unconditionally on new orders; absent still means UNKNOWN on an
       * old one, never zero.
       */
      shipping_tax_cents: t.shipping_tax_cents,
      line_totals: t.lines,
      shipping_method_id: priced.shipping?.id,
      shipping_method_name: priced.shipping?.name,
      shipping_country: destination.country?.trim().toUpperCase(),
      shipping_postcode: destination.postcode?.trim(),
      coupon_code: priced.coupon?.ok ? priced.coupon.coupon.code : undefined,
      email: input.email.trim(),
      name: input.name?.trim(),
      phone: input.phone?.trim(),
      ...addressFields,
      note: input.note?.trim(),
      payment_method: input.payment_method?.trim() || 'bank-transfer',
      items,
    }
    draft = pluginManager.applyFilters(
      PLUGIN_HOOKS.BEFORE_ORDER_SAVE, draft, { isNew: true },
    ) as typeof draft

    // Guard the invariant a filter might have broken. NOT a plain line-sum any
    // more: the total legitimately includes shipping and tax, so it is checked
    // against the calculator's own reconciliation instead.
    if (!totalsReconcile(t) || draft.total_cents !== t.total_cents) {
      draft.total_cents = t.total_cents
    }

    /*
     * Local risk signals.
     *
     * After the draft is final so the score sees the real total, and BEFORE the
     * order is written so the fields land in one write. Nothing here can refuse
     * an order — `riskFields` only ever adds, and only when flagged.
     *
     * History is read once and bounded: the signals that need it are all
     * "recently", and scanning an entire order book on every checkout would
     * make the busiest shop the slowest one.
     */
    try {
      // The newest RISK_HISTORY_MIN orders (the shop's "average", as before)
      // plus EVERY order of the last half hour (velocity), from the one read
      // at the top. `recent` is newest first.
      const since = nowMs - VELOCITY_WINDOW_MS
      const history = recent
        .filter((o, i) => i < RISK_HISTORY_MIN || Date.parse(o.created_at) >= since)
        .map((o) => ({
          email: o.email, ip_hash: o.ip_hash, total_cents: o.total_cents,
          created_at: o.created_at, status: o.status,
        }))
      const verdict = scoreOrder({
        order: { ...draft, shipping_address: draft.shipping_address, billing_address: draft.billing_address },
        ipHash,
        history,
        originCountry: (await getTaxOrigin()) ?? undefined,
        nowMs,
      })
      Object.assign(draft, riskFields(verdict, ipHash))
      /*
       * The opt-in RISK HOLD (S4.15; `orders_risk_hold_enabled`, off by
       * default). Scoring still refuses nothing — see order-risk.ts for why a
       * refusal is the wrong answer. What the switch changes is where a
       * high-scoring order STARTS: `on-hold` instead of `pending`, so it is
       * placed, its stock is held, the buyer can pay, and nothing moves it on
       * until a person has looked. The reasons are stored even below the
       * flag threshold, so staff can see why it is held.
       */
      if (hold.riskHold.enabled && verdict.score >= hold.riskHold.score) {
        Object.assign(draft, {
          status: 'on-hold' as OrderStatus,
          risk_held: true,
          risk_flagged: true,
          risk_score: verdict.score,
          risk_reasons: verdict.reasons,
          risk_signals: verdict.signals.map((s) => s.code),
        })
      }
    } catch {
      // A scoring failure must never cost a sale. An unscored order is an
      // unflagged one, which is exactly what every order was until today.
    }

    /*
     * Count the coupon use NOW — atomically, and before the order exists.
     *
     * It used to be counted AFTER the order was written, from the `used_count`
     * pricing had READ, as a best-effort write. Two checkouts with a one-use
     * code both passed pricing's limit check and both wrote 1: the code was
     * used twice and the counter said once (tests/checkout-race.test.mjs, K1
     * and K3). The claim below counts only while the limit still allows it,
     * and `rollback` hands it back if this order is not placed after all.
     */
    if (priced.coupon?.ok) {
      const c = priced.coupon.coupon
      if (!(await LocalDB.claimCouponUse(c.id))) {
        await rollback()
        if (normalizeCouponCode(input.coupon_code)) {
          return couponRefusal('That code has reached its usage limit.', 'usage-limit-reached')
        }
        // An AUTOMATIC rule the buyer never typed: the total they were quoted
        // no longer exists, which is a conflict to re-quote, not their error.
        return err(409, 'A promotion in your basket is no longer available. Please review the total and try again.',
          undefined, 'checkout.promotion_unavailable')
      }
      couponClaimed = c.id
    }

    // Attach/create the customer record.
    let customer = await LocalDB.getCustomerByEmail(draft.email)
    if (!customer) {
      customer = await LocalDB.createCustomer({
        email: draft.email, name: draft.name, phone: draft.phone, address: draft.address,
        // Seed the address book from the delivery address, so a returning
        // buyer's second checkout has something to pick. Only on CREATE: an
        // existing customer's book is theirs, and silently appending to it on
        // every order would grow it without limit and quietly overwrite the
        // default they chose.
        ...(addressFields.shipping_address
          ? {
              addresses: [{
                ...addressFields.shipping_address,
                id: `checkout-${draft.number}`,
                default_shipping: true,
                default_billing: true,
              }],
            }
          : {}),
      })
      fireEvent('customer.created', customer).catch(() => {})
    }
    draft.customer_id = customer.id

    const order = await LocalDB.createOrder(draft)
    // Placed: the stock and the coupon use now belong to the order.
    reserved.length = 0
    couponClaimed = null

    pluginManager.doAction(PLUGIN_HOOKS.AFTER_ORDER_CREATE, order)
    fireEvent('order.created', order).catch(() => {})
    // Tell the owner. Fire-and-forget for the same reason as the line above:
    // the order is already committed, and a mail server having a bad afternoon
    // must not turn a completed sale into a 500.
    notifyOwnerOfSale(order).catch(() => {})
    // And tell the BUYER, which is a different message to a different person —
    // and the one that was missing entirely. Separately dispatched so a failure
    // to reach the shop's own address list cannot also swallow the customer's
    // confirmation, and vice versa.
    confirmToCustomer(order).catch(() => {})
    return { ok: true, value: order }
  } catch (e) {
    // Never strand reserved stock on an unexpected failure.
    await rollback()
    throw e
  }
}

/**
 * Statuses that mean "this order no longer holds inventory". Entering one
 * releases the reserved stock; leaving one re-reserves it.
 */
export const STOCK_RELEASED_STATUSES: OrderStatus[] = ['cancelled', 'refunded']

export function releasesStock(status: OrderStatus): boolean {
  return STOCK_RELEASED_STATUSES.includes(status)
}

export interface SetOrderStatusOptions {
  /**
   * A precondition on the order AS IT IS when the change is made, rather than
   * as the caller last saw it. Return null to go ahead, or the reason to
   * refuse, which is answered as a 409. It is asked again on every re-read,
   * and when it is given the order's payment status is pinned in the write
   * (OrderTransitionGuard), so the fact it approved cannot change between
   * the approval and the move.
   *
   * For the two callers that act on an order they read some time ago: the
   * abandoned-order sweep ("is this still abandonable?") and a payment event
   * ("is the payment still what this event made it?").
   */
  when?: (order: Order) => string | null
  /**
   * Why the order is being cancelled, when it is not a person deciding it
   * (`abandoned`, `hold-expired`). Written in the same step as the move.
   *
   * ## The reason belongs to ONE cancellation
   *
   * `cancelled_reason` is what lets a late PayPal approval reopen an order
   * (payments/service.ts: only the shop's own sweeps' cancellations may be
   * undone by a payment). It used to be written by the sweeps AFTER the move
   * and never removed, so an order the hold cancelled and staff reopened kept
   * saying "hold-expired" while open, and still said it after STAFF cancelled
   * it — and a redelivered approval then reopened and charged an order staff
   * had cancelled (tests/paypal-capture.test.mjs, L/L2/L3).
   *
   * So whenever a move crosses the stock boundary (into or out of
   * cancelled/refunded), the reason is set to this value or REMOVED, in the
   * same write as the status. A cancel without a reason is a person's.
   */
  cancelledReason?: Order['cancelled_reason']
}

/**
 * How many times a request that LOST a status race re-reads and decides
 * again. Every retry means some other request changed this order's status
 * in between; running out takes more competing changes to ONE order than an
 * admin, a webhook and the sweep produce between them.
 */
const STATUS_ATTEMPTS = 5

/**
 * Change an order's fulfilment status, and move its stock with it.
 *
 * ## The status is CLAIMED, not just written
 *
 * The status decides whether an order holds stock, so the status write and
 * the stock movement have to belong to the same request. This used to read
 * the order, move stock by the status it read, and write the new status last
 * — and "guarding on the previous status makes re-cancelling idempotent" was
 * true only of two requests in a row. Two at once (an admin double-click, an
 * admin cancel meeting the provider's refund webhook, one failure event
 * delivered twice, the sweep reaching an order staff are cancelling) both
 * read `processing` and both handed the stock back; the shop then sold units
 * it did not have. lowdb's locked() did not help, because it covers each
 * LocalDB call, not the sequence. `tests/order-status-race.test.mjs`
 * reproduces it on all three drivers.
 *
 * Now the move is `LocalDB.transitionOrderStatus(id, previous, next)`, which
 * lands only if the order is still at `previous`. Exactly one of two racing
 * requests gets the order back, and only that one moves stock or records the
 * change (plugin action, webhook event, audit entry, change-feed entry).
 *
 * ## Which comes first, the claim or the stock
 *
 * ENTERING cancelled/refunded: claim, then release. Releasing cannot fail,
 * and releasing first would let the loser release too.
 *
 * LEAVING them: reserve every line, then claim; a lost claim hands the lines
 * back. Not the other way round. Claiming `processing` first leaves the order
 * saying it holds stock while its lines are only partly retaken; a cancel
 * that lands then releases every line, including the ones never retaken, and
 * if the reopen then runs short it has no correct undo left (D4 in the test
 * pins this). Reserving first means the status only ever claims stock that is
 * already held. The cost is a moment in which a request that goes on to lose
 * holds the units — two reopens of an order whose stock covers exactly one
 * can see the loser refused for stock before the winner has claimed. It gets
 * the 409 a reopen gets when the stock is gone, and nothing is miscounted.
 *
 * If the process dies between the two steps, the stock is short rather than
 * over — held by a cancelled order, or not yet returned by one. The old order
 * (release first, write last) failed the other way, into overselling.
 *
 * ## The loser
 *
 * Re-reads the order and decides again, exactly as the second of two
 * sequential requests would: a repeated cancel is an idempotent success with
 * the order as it now is, a cancel after a refund is the state machine's 409
 * with its own sentence. Never a 500, and never a second stock movement.
 */
export async function setOrderStatus(
  id: string,
  status: OrderStatus,
  actor?: string,
  opts: SetOrderStatusOptions = {},
): Promise<ServiceResult<Order>> {
  if (!ORDER_STATUSES.includes(status)) return err(400, 'Invalid order status')

  for (let attempt = 0; attempt < STATUS_ATTEMPTS; attempt++) {
    const existing = await LocalDB.getOrder(id)
    if (!existing) return err(404, 'Order not found')

    const refusal = opts.when?.(existing)
    if (refusal) return err(409, refusal)

    // Fulfilment is a state machine now: `refunded -> pending` used to be
    // accepted and reads as a shop un-refunding a customer.
    const move = canTransition(existing.status, status)
    if (!move.ok) return err(409, move.reason ?? 'That status change is not allowed')
    const previous = existing.status
    if (previous === status) return { ok: true, value: existing }

    const guard = opts.when ? { paymentStatus: existing.payment_status ?? null } : undefined
    // See SetOrderStatusOptions.cancelledReason. Leaving cancelled/refunded
    // removes the reason; entering them sets this move's own, or none.
    const set: Partial<Order> | undefined = releasesStock(previous) !== releasesStock(status)
      ? { cancelled_reason: releasesStock(status) ? opts.cancelledReason : undefined }
      : undefined

    // Every stock call carries the line's variant, so stock returns to (and is
    // taken from) the pool it came from. Crediting the parent for a cancelled
    // black frame would leave the black count permanently short and the parent
    // permanently over.
    if (releasesStock(previous) && !releasesStock(status)) {
      // Re-opening an order must re-take the stock. If it is gone, refuse
      // rather than quietly reviving an order that can no longer be fulfilled.
      const retaken: Array<{ product_id: string; qty: number; variant_id?: string }> = []
      const giveBack = async () => {
        for (const r of retaken) {
          await LocalDB.releaseStock(r.product_id, r.qty, { variantId: r.variant_id ?? null }).catch(() => {})
        }
      }
      let short: string | null = null
      for (const line of existing.items) {
        if (!line.product_id) continue
        const got = await LocalDB.reserveStock(line.product_id, line.qty, {
          variantId: line.variant_id ?? null,
        })
        if (!got) {
          short = line.name
          break
        }
        retaken.push({ product_id: line.product_id, qty: line.qty, variant_id: line.variant_id })
      }
      if (short !== null) {
        await giveBack()
        // "Out of stock" is only the answer if the order is still where it was
        // read. If another request moved it meanwhile — typically a concurrent
        // reopen that took the last units — decide again from where it is now.
        const now = await LocalDB.getOrder(id)
        if (!now || now.status !== previous) continue
        return err(409, `Cannot reopen order: insufficient stock for ${short}`)
      }
      const updated = await LocalDB.transitionOrderStatus(id, previous, status, guard, set)
      if (!updated) {
        // Lost: whoever won moved the order, and its stock is theirs to account.
        await giveBack()
        continue
      }
      return statusChanged(updated, previous, actor)
    }

    const updated = await LocalDB.transitionOrderStatus(id, previous, status, guard, set)
    if (!updated) continue // lost: re-read, and answer as the second request would

    if (!releasesStock(previous) && releasesStock(status)) {
      // Only the request that won the move gets here, so the order's stock is
      // handed back once however many asked.
      for (const line of existing.items) {
        if (!line.product_id) continue
        await LocalDB.releaseStock(line.product_id, line.qty, {
          variantId: line.variant_id ?? null,
        }).catch(() => {})
      }
    }
    return statusChanged(updated, previous, actor)
  }
  return err(409, 'The order was changed by another request while this one was updating it; reload it and try again')
}

/** What a status change records — once, by the request that made it. */
function statusChanged(updated: Order, previous: OrderStatus, actor?: string): ServiceOk<Order> {
  const { id, status } = updated
  pluginManager.doAction(PLUGIN_HOOKS.AFTER_ORDER_STATUS_CHANGE, updated, previous)
  fireEvent('order.status_changed', { id, previous, status }).catch(() => {})
  recordAudit(AUDIT.ORDER_STATUS, { actor, target: id, metadata: { order: id, previous, status } })
  return { ok: true, value: updated }
}

/**
 * Wire `notifyNewSale` to the real settings table, mail transport and site URL.
 *
 * Separated from the pure module so the rules — who is notified, what the
 * message says, what happens when an address bounces — stay testable without a
 * database or an SMTP account.
 */
/**
 * Wire `sendOrderConfirmation` to settings, the mail transport and the payment
 * registry's own instructions text.
 *
 * The instructions are read from the manual method rather than from a setting
 * of this feature's own, so an operator configures their bank details once and
 * the checkout page and this email cannot disagree about them.
 */
async function confirmToCustomer(order: Order): Promise<void> {
  const { sendOrderConfirmation } = await import('./commerce/order-confirmation')
  const { sendEmail } = await import('./email')
  const { manualInstructions } = await import('./payments/registry')
  const { defaultLocale } = await import('./i18n')

  // Read once and share: the confirmation needs the site title from here and
  // the payment instructions from here, and two reads could see two states.
  const rows = await LocalDB.getSettings()
  const settings: Record<string, unknown> = {}
  for (const r of rows) settings[r.key] = r.value

  await sendOrderConfirmation(order, {
    readSettings: async () => settings,
    send: (msg) => sendEmail(msg),
    // Settings first, then a plugin-declared method's own text. Without the
    // settings source the built-in bank-transfer method had NO way to carry an
    // IBAN on a core install, so the email promised details that could never
    // appear in it.
    instructionsFor: (methodId) => manualInstructions(methodId, settings, defaultLocale()),
    // The SETTING first, then the environment. site_url is what an operator
    // edits in the admin, and reading only the env meant a shop configured
    // through the UI sent emails with no link back to it.
    siteUrl: typeof settings.site_url === 'string' && settings.site_url.trim()
      ? settings.site_url.trim()
      : process.env.SITE_URL,
    allowSend: allowConfirmation,
  })
}

/** Confirmations one address may receive per hour. */
export const CONFIRMATIONS_PER_RECIPIENT_PER_HOUR = 5

/**
 * The per-recipient budget for order confirmations (S4.8).
 *
 * Five an hour: more than any real buyer places, few enough that checkout is
 * useless as a way to flood somebody else's inbox. Keyed on a HASH of the
 * normalised address, because the shared rate-limit store is a table of keys
 * that should not double as a list of customer emails. The counter store
 * fails open, like every counter here: an outage sends the email.
 */
async function allowConfirmation(to: string): Promise<boolean> {
  const { sharedRateLimitStore } = await import('./rate-limit')
  const { createHash } = await import('node:crypto')
  const digest = createHash('sha256').update(`order-confirm|${to.trim().toLowerCase()}`).digest('hex').slice(0, 32)
  const res = await sharedRateLimitStore().consume(`order-confirm:${digest}`, 3_600_000, CONFIRMATIONS_PER_RECIPIENT_PER_HOUR)
  return res.allowed
}

async function notifyOwnerOfSale(order: Order): Promise<void> {
  const { notifyNewSale } = await import('./commerce/sale-notify')
  const { sendEmail } = await import('./email')
  await notifyNewSale(order, {
    readSettings: async () => {
      // getSettings() returns ROWS, not a map. Casting the array straight to a
      // record type-checks under `as` and then reads every key as undefined, so
      // the feature would have been permanently, silently off. Same shape as
      // the abandonment sweep does it.
      const rows = await LocalDB.getSettings()
      const map: Record<string, unknown> = {}
      for (const r of rows) map[r.key] = r.value
      return map
    },
    send: (msg) => sendEmail(msg),
    siteUrl: process.env.SITE_URL,
  })
}
