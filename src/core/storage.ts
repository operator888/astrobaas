/**
 * Storage contract for AstroBaaS.
 *
 * The default engine is lowdb (src/lib/localdb.ts), but core, routes, themes,
 * and plugins should depend on THIS interface rather than the concrete class —
 * so a future SQLite/Postgres/remote backend is a drop-in replacement.
 *
 * Methods mirror the lowdb implementation; all are async. Reads return [] / the
 * entity / undefined; mutations return the affected entity or a boolean.
 *
 * @alpha — the method set may grow before 1.0; see STABILITY.md.
 */
import type { AuditQuery } from './audit-query';
import type { PostQuery, PagedResult } from './post-query';
import type { ContentChangeQuery, ContentChangePage } from './change-feed';
import type {
  ShippingMethodRecord,
  CouponRecord,
  Product,
  Brand,
  ProductCategory,
  Order,
  OrderStatus,
  PaymentStatus,
  InvoiceDocument,
  Customer,
  Post,
  Category,
  User,
  MediaFile,
  Theme,
  ThemeConfig,
  Setting,
  ContentChange,
  EntityType,
  PluginRecord,
  ContactMessage,
  Subscriber,
  ConsentLedgerRow,
  CustomEntity,
  PluginDataRecord,
  RedirectRule,
  NotFoundRecord,
  ApiKey,
  Webhook,
  WebhookDelivery,
  AuditEvent,
  PostRevision,
  RefundRecord,
} from './models';

/**
 * How `updateProduct` treats the counts inside a supplied `variants` array.
 *
 * `keepVariantStock` lists ids of variants in `updates.variants` whose count the
 * caller did NOT change — the admin editor sends every variant back with the
 * count it loaded minutes ago (see readStockBases in lib/product-fields.ts).
 * For each, the driver writes the variant as supplied EXCEPT `stock` and
 * `in_stock`, which it takes from the STORED variant with that id, atomically
 * with the write: inside the UPDATE on the relational driver, inside the
 * `locked()` hold on lowdb and doc-blob. A reservation that landed after the
 * caller read the product is therefore kept. A listed id the stored row no
 * longer has keeps the supplied count.
 *
 * Optional and additive. Without it `variants` is written exactly as supplied,
 * which is what an ERP pushing absolute counts means.
 */
export interface UpdateProductOptions {
  keepVariantStock?: readonly string[];
}

/**
 * What `claimCouponUse` counts besides the coupon's total.
 *
 * `emailKey` is `couponEmailKey(email)` (lower-case hex, never the address):
 * with it, the claim also counts one use against that buyer in
 * `redemptions_by_email`, and — when `perEmailLimit` is set — lands only while
 * that buyer is under it. Both counts move in the SAME atomic step as the
 * total, so two checkouts by one buyer cannot both pass a one-per-customer
 * code. `force` counts without checking any limit: re-counting a use that
 * already happened (a cancelled order reopened), never a new sale.
 */
export interface CouponClaimOptions {
  emailKey?: string;
  perEmailLimit?: number | null;
  force?: boolean;
}

/** A per-email key a coupon count may be stored under: lower-case hex only. */
export const COUPON_EMAIL_KEY_RE = /^[a-f0-9]{16,64}$/;

/**
 * What `transitionOrderStatus` requires of the stored order besides its status.
 *
 * `paymentStatus` pins the payment status the caller decided on: the move
 * lands only if `payment_status` is still that value (`null` = the field is
 * absent). The abandoned-order sweep needs it — "cancel this order" is only
 * right while the order is still unpaid, and a payment can land between the
 * sweep's read and its write. `undefined` checks nothing.
 */
export interface OrderTransitionGuard {
  paymentStatus?: PaymentStatus | null;
}

/**
 * A bounded read of the newest orders, for the checks checkout makes on every
 * order (the unpaid cap, risk velocity).
 *
 * Returns, newest first, every order created at or after `since` — and at
 * least the `atLeast` newest orders whatever their age — never more than
 * `atMost`. Both halves matter: the unpaid cap and the velocity signal need
 * "everything recent", which a fixed count truncates exactly when a shop is
 * busiest; the risk scorer's "this shop's average order" needs "enough
 * orders", which a time window empties on a quiet shop. One read serves both.
 */
export interface RecentOrdersQuery {
  since: string;
  /** Default 0. */
  atLeast?: number;
  /** Default 5000. */
  atMost?: number;
}

/**
 * What `claimPaymentEvent` found.
 *
 *  - applied:   the event id was not in the ledger; it is now, with the patch
 *  - duplicate: the event id is already in the ledger — someone applied it
 *  - changed:   the payment status is no longer the one the caller decided on
 *  - missing:   no such order
 */
export type PaymentEventClaim =
  | { outcome: 'applied'; order: Order }
  | { outcome: 'duplicate' }
  | { outcome: 'changed' }
  | { outcome: 'missing' };

export interface PaymentEventClaimOptions {
  /**
   * The payment status the caller's decision was taken on (`null` = absent).
   * The claim lands only while it still holds. `undefined` checks nothing.
   */
  expectPaymentStatus?: PaymentStatus | null;
  /** Also add one to `payment_declines`, in the same write. */
  countDecline?: boolean;
  /** How many event ids the ledger keeps (oldest dropped). */
  history: number;
}

/** What `appendRefund` found. `duplicate` carries the order as it now is. */
export type RefundAppend =
  | { outcome: 'appended'; order: Order }
  | { outcome: 'duplicate'; order: Order }
  | { outcome: 'missing' };

/**
 * What `compareAndSetOrderTags` found.
 *
 *  - applied: the stored tags were still `expected`; `next` is written
 *  - changed: they are not — someone else wrote since the caller read; re-read
 *  - missing: no such order
 */
export type OrderTagsWrite =
  | { outcome: 'applied'; order: Order }
  | { outcome: 'changed' }
  | { outcome: 'missing' };

/** What `compareAndSetOrderTimeline` found — same three answers as `OrderTagsWrite`. */
export type OrderTimelineWrite =
  | { outcome: 'applied'; order: Order }
  | { outcome: 'changed' }
  | { outcome: 'missing' };
/** What `compareAndSetOrderInvoiceRecords` found — the same three answers. */
export type OrderInvoiceRecordsWrite = OrderTagsWrite;

/**
 * The order fields `compareAndSetOrderField` may write. A closed list, because
 * the field name becomes a JSON path in SQL and because each field here has
 * exactly one owning module that does its read-modify-write through it:
 *
 *  - `tags`         — lib/commerce/order-tags.ts
 *  - `entitlements` — lib/commerce/download-entitlements.ts (the download
 *                     count: two downloads at once must not both see "4 of 5")
 */
export const ORDER_CAS_FIELDS = ['tags', 'entitlements'] as const;
export type OrderCasField = (typeof ORDER_CAS_FIELDS)[number];

/** What `compareAndSetOrderField` found. Same three answers as the tags write. */
export type OrderFieldWrite = OrderTagsWrite;

/**
 * What `claimIdempotencyKey` found.
 *
 *  - claimed: nobody holds the key; the caller does now, under `token`
 *  - pending: another request holds it and has not finished
 *  - done:    a request finished under it; `response` is what it answered
 */
export type IdempotencyClaim =
  | { state: 'claimed'; token: string }
  | { state: 'pending'; fingerprint: string }
  | { state: 'done'; fingerprint: string; response: unknown };

export interface Storage {
  /** Open/seed the store and ensure the seed admin exists. Idempotent. */
  init(): Promise<void>;

  // Users
  getUserByEmail(email: string): Promise<User | undefined>;
  touchLogin(userId: string): Promise<void>;
  getUsers(): Promise<User[]>;
  getUser(id: string): Promise<User | undefined>;
  createUser(user: Omit<User, 'id' | 'created_at' | 'updated_at'>): Promise<User>;
  updateUser(id: string, updates: Partial<User>): Promise<User | null>;
  deleteUser(id: string): Promise<boolean>;

  // Posts
  getPosts(): Promise<Post[]>;
  /**
   * Filtered, sorted, paginated read.
   *
   * `getPosts()` stays for callers that genuinely need everything (export,
   * backup, the change feed). This is for the ones that render a page, so the
   * work happens where the data is instead of loading the collection to slice
   * it. Semantics are defined once in `src/core/post-query.ts`; a driver that
   * pushes filters into SQL must agree with that definition, which is what the
   * cross-driver test in the smoke suite checks.
   */
  queryPosts(query: PostQuery): Promise<PagedResult<Post>>;
  getPost(id: string): Promise<Post | undefined>;
  createPost(post: Omit<Post, 'id' | 'created_at' | 'updated_at'>): Promise<Post>;
  updatePost(id: string, updates: Partial<Post>): Promise<Post | null>;
  deletePost(id: string): Promise<boolean>;

  // Categories
  getCategories(): Promise<Category[]>;
  createCategory(category: Omit<Category, 'id' | 'created_at' | 'updated_at'>): Promise<Category>;
  updateCategory(id: string, updates: Partial<Category>): Promise<Category | null>;
  deleteCategory(id: string): Promise<boolean>;

  // Commerce — products
  getProducts(): Promise<Product[]>;
  getProduct(id: string): Promise<Product | null>;
  getProductBySlug(slug: string): Promise<Product | null>;
  createProduct(p: Omit<Product, 'id' | 'created_at' | 'updated_at'>): Promise<Product>;
  updateProduct(id: string, updates: Partial<Product>, opts?: UpdateProductOptions): Promise<Product | null>;
  deleteProduct(id: string): Promise<boolean>;

  // Commerce — brands
  getShippingMethods(): Promise<ShippingMethodRecord[]>;
  createShippingMethod(m: Omit<ShippingMethodRecord, 'id' | 'created_at' | 'updated_at'>): Promise<ShippingMethodRecord>;
  updateShippingMethod(id: string, updates: Partial<ShippingMethodRecord>): Promise<ShippingMethodRecord | null>;
  deleteShippingMethod(id: string): Promise<boolean>;

  getCoupons(): Promise<CouponRecord[]>;
  createCoupon(c: Omit<CouponRecord, 'id' | 'created_at' | 'updated_at'>): Promise<CouponRecord>;
  updateCoupon(id: string, updates: Partial<CouponRecord>): Promise<CouponRecord | null>;
  deleteCoupon(id: string): Promise<boolean>;
  /**
   * ATOMICALLY count one use of a coupon — only while `used_count` is below
   * `usage_limit` (no limit: always). True when counted.
   *
   * The check and the increment are one step, like reserveStock, and for the
   * same reason: placeOrder checked the limit while pricing and wrote
   * `used_count + 1` from the count it had READ after the order existed, so
   * two checkouts with a one-use code both passed and both wrote 1.
   */
  claimCouponUse(id: string, opts?: CouponClaimOptions): Promise<boolean>;
  /**
   * Hand a claimed use back (the order it was claimed for was not placed, or
   * was cancelled before payment). Never below 0. With `emailKey`, that
   * buyer's count is handed back too.
   */
  releaseCouponUse(id: string, opts?: Pick<CouponClaimOptions, 'emailKey'>): Promise<void>;

  /**
   * Atomically increment and return a named counter.
   *
   * Exists because order numbers were allocated read-max-then-increment, which
   * hands two concurrent checkouts the SAME number. Like reserveStock, the read
   * and the write have to be one step — a counter that can be read by two
   * callers before either writes is not a counter.
   */
  nextSequence(name: string): Promise<number>;

  getBrands(): Promise<Brand[]>;
  createBrand(b: Omit<Brand, 'id' | 'created_at' | 'updated_at'>): Promise<Brand>;
  updateBrand(id: string, updates: Partial<Brand>): Promise<Brand | null>;
  deleteBrand(id: string): Promise<boolean>;

  // Commerce — product categories
  getProductCategories(): Promise<ProductCategory[]>;
  createProductCategory(c: Omit<ProductCategory, 'id' | 'created_at' | 'updated_at'>): Promise<ProductCategory>;
  updateProductCategory(id: string, updates: Partial<ProductCategory>): Promise<ProductCategory | null>;
  deleteProductCategory(id: string): Promise<boolean>;

  // Commerce — orders
  getOrders(): Promise<Order[]>;
  getOrder(id: string): Promise<Order | null>;
  createOrder(o: Omit<Order, 'id' | 'created_at' | 'updated_at'>): Promise<Order>;
  updateOrder(id: string, updates: Partial<Order>): Promise<Order | null>;
  /**
   * ATOMICALLY move an order from status `from` to status `to`.
   *
   * Returns the order as written, or null when there is no such order OR its
   * status is no longer `from` (or `guard` no longer holds). Implementations
   * MUST make the comparison and the write one step — a conditional UPDATE
   * on the relational driver, one `locked()` hold on lowdb and doc-blob —
   * and must record the change in the content-change feed exactly as
   * `updateOrder` does, and only when the move landed.
   *
   * This exists because the status decides whether an order holds stock.
   * `setOrderStatus` read the status, moved stock by it, then wrote the new
   * one, so two concurrent cancels both read `processing` and both handed the
   * stock back. Only the caller this returns an order to may move stock for
   * the change; a caller that gets null lost the race and must re-read.
   * `updateOrder` still writes a `status` it is handed, and no core caller
   * hands it one: a status change goes through `setOrderStatus`, and that
   * goes through this.
   */
  transitionOrderStatus(
    id: string,
    from: OrderStatus,
    to: OrderStatus,
    guard?: OrderTransitionGuard,
    /**
     * Fields written IN THE SAME STEP as the status, and only when the move
     * lands; a key set to `undefined` is removed. For facts that belong to
     * the move itself — why an order was cancelled — and so must never be
     * seen with the wrong status, even for the length of one more write.
     */
    set?: Partial<Order>,
  ): Promise<Order | null>;
  deleteOrder(id: string): Promise<boolean>;
  /** Newest orders, bounded — see RecentOrdersQuery. */
  getRecentOrders(query: RecentOrdersQuery): Promise<Order[]>;
  /**
   * The first order (in creation order) carrying this number, or null.
   * A targeted lookup for the public payment-start route, which used to load
   * every order to find one.
   */
  getOrderByNumber(number: string): Promise<Order | null>;
  /**
   * ATOMICALLY apply a verified payment event to an order: append `eventId`
   * to `payment_events` (bounded to `opts.history`) and write `patch` — only
   * if the id is not already in the ledger and, when asked, the payment
   * status is still the expected one. Records the change in the content feed
   * exactly as updateOrder does, and only when it lands.
   *
   * The webhook path used to check the ledger it READ and then write, so two
   * deliveries of one event both got through; and a failure decided on a
   * stale read wrote `failed` over a `paid` that had landed in between.
   * Relational: one conditional UPDATE. lowdb and doc-blob: one locked() hold.
   * An empty `eventId` is applied without a ledger entry.
   */
  claimPaymentEvent(
    id: string,
    eventId: string,
    patch: Partial<Order>,
    opts: PaymentEventClaimOptions,
  ): Promise<PaymentEventClaim>;
  /**
   * ATOMICALLY append a refund the provider confirmed, unless a refund with
   * the same `record.id` is already on the order. In the same step the driver
   * sets `payment_status` from the STORED refunds: `refunded` once they cover
   * `total_cents`, `paid` before (lib/payments/refunds.ts states the rule).
   * Records the change in the content feed when it lands.
   *
   * refundOrder used to write `[...refunds it read, new]`: two partial
   * refunds at once each wrote a one-element array and the second erased the
   * first.
   */
  appendRefund(id: string, record: RefundRecord): Promise<RefundAppend>;
  /**
   * ATOMICALLY replace an order's staff `tags`, but only while the stored
   * value is still `expected` (the raw value the caller read: `undefined` =
   * the field is absent). An empty `next` removes the field, so an untagged
   * order carries no `tags: []`.
   *
   * A staff tag edit is read-modify-write — "add VIP to the ones it has" —
   * and two staff adding different tags at once each wrote their own full
   * list, the second erasing the first. This makes the comparison and the
   * write one step (a conditional UPDATE on the relational driver, one
   * `locked()` hold on lowdb and doc-blob), and the caller retries on
   * `changed`. Records the change in the content feed as `updateOrder` does,
   * and only when it lands. Nothing else on the order is touched, so a
   * payment landing at the same moment is not lost either.
   *
   * Use `lib/commerce/order-tags.ts`; it owns the normalisation and the
   * limits, and this method trusts what it is given.
   */
  compareAndSetOrderTags(id: string, expected: unknown, next: readonly string[]): Promise<OrderTagsWrite>;
  /**
   * ATOMICALLY replace an order's `invoice_records`, but only while the stored
   * value is still `expected` (the raw value the caller read; `undefined` =
   * absent). The same compare-and-set as `compareAndSetOrderTags`, on the
   * same three driver shapes, for the same reason: creating a record, adding
   * a credit memo and claiming a record for an issuer are each
   * read-decide-write, and two at once (a payment webhook and an admin click,
   * two refunds) must not both decide "there is no record yet" and both write
   * one. The loser gets `changed`, re-reads, and finds the winner's record.
   *
   * Only `invoice_records` and `updated_at` are written. Use
   * `lib/commerce/invoice-records.ts`, which owns every rule; this method
   * trusts what it is given.
   */
  compareAndSetOrderInvoiceRecords(
    id: string, expected: unknown, next: readonly InvoiceDocument[],
  ): Promise<OrderInvoiceRecordsWrite>;

  /**
   * ATOMICALLY replace an order's stored `timeline`, but only while the stored
   * value is still `expected` (the raw value the caller read; `undefined` =
   * absent). The same contract as `compareAndSetOrderTags`, for the same
   * reason: an append is read-modify-write, and two requests appending at
   * once each wrote their own full list, the second erasing the first.
   *
   * An empty `next` removes the field. Only `timeline` is touched, so a
   * payment landing at the same moment is not lost. It is NOT an edit of the
   * order as the API presents it (the order endpoints strip the field), so it
   * bumps no `updated_at` and writes no change-feed row: a status change is
   * still exactly one feed entry.
   *
   * Use `lib/commerce/order-timeline.ts`; it owns the entry shape, the bound
   * and the retry loop, and this method trusts what it is given.
   */
  compareAndSetOrderTimeline(id: string, expected: unknown, next: readonly unknown[]): Promise<OrderTimelineWrite>;
  /**
   * The same compare-and-set, for any field in {@link ORDER_CAS_FIELDS}:
   * write `next` to `field` only while the stored value is still `expected`
   * (`undefined` = absent). `next === undefined` removes the field. Only that
   * field and `updated_at` are written, and the change feed records it naming
   * only that field. `compareAndSetOrderTags` is this with `field = 'tags'`.
   */
  compareAndSetOrderField(id: string, field: OrderCasField, expected: unknown, next: unknown): Promise<OrderFieldWrite>;

  // Idempotency keys (POST /api/orders `Idempotency-Key`). Durable, so a
  // retry after a restart still gets the first answer, and — on the
  // relational driver — shared by every process on the database.
  /**
   * Claim `key` for a request whose body hashes to `fingerprint`, for
   * `leaseMs`. An expired lease or record is claimable again. Atomic: of two
   * requests with one key, one gets `claimed`.
   */
  claimIdempotencyKey(key: string, fingerprint: string, leaseMs: number): Promise<IdempotencyClaim>;
  /** Store the answer under a claim, kept for `ttlMs`. A lost lease is left alone. */
  completeIdempotencyKey(key: string, token: string, response: unknown, ttlMs: number): Promise<void>;
  /** Give a claim back unanswered, so the key can be used again at once. */
  releaseIdempotencyKey(key: string, token: string): Promise<void>;

  // Commerce — customers
  getCustomers(): Promise<Customer[]>;
  getCustomer(id: string): Promise<Customer | null>;
  getCustomerByEmail(email: string): Promise<Customer | null>;
  createCustomer(c: Omit<Customer, 'id' | 'created_at' | 'updated_at'>): Promise<Customer>;
  updateCustomer(id: string, updates: Partial<Customer>): Promise<Customer | null>;
  deleteCustomer(id: string): Promise<boolean>;

  // Media
  getMedia(): Promise<MediaFile[]>;
  getMediaFile(id: string): Promise<MediaFile | undefined>;
  createMediaFile(media: Omit<MediaFile, 'id' | 'created_at'>): Promise<MediaFile>;
  updateMediaFile(id: string, updates: Partial<MediaFile>): Promise<MediaFile | null>;
  deleteMediaFile(id: string): Promise<boolean>;

  // Themes
  getThemes(): Promise<Theme[]>;
  /**
   * Create a row for any bundled theme that doesn't have one yet (inactive).
   * Never overwrites an existing row — an operator's customized tokens win over
   * the theme's defaults. Mirrors ensurePlugins(): the code registry is the
   * catalog, the DB holds activation state + customizations.
   */
  ensureThemes(themes: Array<Pick<Theme, 'id' | 'name' | 'description' | 'version' | 'author' | 'settings'>>): Promise<Theme[]>;
  getActiveTheme(): Promise<Theme | undefined>;
  activateTheme(id: string): Promise<Theme | null>;
  updateThemeSettings(id: string, settings: ThemeConfig): Promise<Theme | null>;
  /**
   * Create or update a theme installed from a manifest.
   *
   * Separate from `ensureThemes` because that one is bootstrap — it only ever
   * INSERTS, so a compiled-in theme never clobbers the tokens an operator
   * customized. This one has to update an existing row on upgrade while
   * preserving `settings` and `status`, which are the operator's, not the
   * theme author's.
   */
  upsertDeclarativeTheme(theme: Theme): Promise<Theme>;
  /** Remove a theme row. Only ever called for declarative, inactive themes. */
  deleteTheme(id: string): Promise<boolean>;

  // Settings
  getSettings(): Promise<Setting[]>;
  getSetting(key: string): Promise<Setting | undefined>;
  updateSetting(key: string, value: any): Promise<Setting | null>;

  // Content-change audit log
  /**
   * Every RETAINED change newer than `since`, newest first, snapshots included —
   * at most `CONTENT_CHANGE_CAP` of them, on every driver.
   *
   * Kept for callers that genuinely need the whole retained window. Anything
   * that renders or serves the feed wants `getContentChangesPage`, which is
   * bounded by a page, can leave the snapshots in the database, and pages by
   * cursor.
   */
  getContentChanges(since?: string): Promise<ContentChange[]>;
  /**
   * One bounded page of the change feed, newest first by `(timestamp, id)`.
   *
   * The semantics are defined once, in `core/change-feed.ts`
   * (`applyChangeQuery`), and a driver that pushes the query into SQL must
   * agree with that definition row for row. `limit` is clamped to
   * `CHANGE_PAGE_MAX` by the driver itself, so no caller can ask storage for an
   * unbounded read. With `snapshots: false` the result carries metadata only.
   * `prunedThrough` is the newest eviction among the queried types only —
   * see `recordPrunedChanges` for why never across all of them.
   */
  getContentChangesPage(query: ContentChangeQuery): Promise<ContentChangePage>;
  recordContentChange(
    entityType: EntityType,
    entityId: string,
    action: ContentChange['action'],
    changes: any,
  ): Promise<ContentChange | null>;
  clearContentChanges(): Promise<void>;

  // Contact messages + newsletter
  getMessages(): Promise<ContactMessage[]>;
  createMessage(msg: Omit<ContactMessage, 'id' | 'created_at' | 'read'>): Promise<ContactMessage | null>;
  markMessageRead(id: string, read: boolean): Promise<ContactMessage | null>;
  deleteMessage(id: string): Promise<boolean>;
  getSubscribers(): Promise<Subscriber[]>;
  createSubscriber(email: string): Promise<Subscriber | null>;

  // The consent ledger (src/lib/consent-ledger.ts). APPEND-ONLY: there is
  // deliberately no update and no delete here. The one rewrite is the GDPR
  // erasure's pseudonymisation, which keeps every row and replaces only the
  // address (and drops ip/ua). Its own collection on every driver, never a
  // custom entity: those writes land in the public change feed.
  /** Append one row. Rejects a duplicate id rather than overwriting it. */
  appendConsentRow(row: ConsentLedgerRow): Promise<ConsentLedgerRow>;
  /**
   * Rows in the order they were WRITTEN (oldest first), optionally narrowed to
   * one address and/or one purpose. `limit` keeps the NEWEST n, still oldest first.
   */
  getConsentRows(query?: { email?: string; purpose?: string; limit?: number }): Promise<ConsentLedgerRow[]>;
  /**
   * The erasure: every row for `email` keeps its purpose, decision, version,
   * text hash and times; `email` becomes `replacement`, ip/ua are removed and
   * `erased_at` is set. Returns how many rows were rewritten.
   */
  pseudonymiseConsentRows(email: string, replacement: string, erasedAt: string): Promise<number>;

  // Plugins
  getPlugins(): Promise<PluginRecord[]>;
  ensurePlugins(ids: string[]): Promise<PluginRecord[]>;
  setPluginActive(id: string, active: boolean): Promise<PluginRecord | null>;
  updatePluginSettings(id: string, settings: Record<string, any>): Promise<PluginRecord | null>;
  /** Remove a plugin record entirely (declarative/runtime-installed plugins). */
  deletePlugin(id: string): Promise<boolean>;

  // Custom content types (plugin-registered collections)
  // Plugin-owned data. Namespaced `<plugin-id>:<collection>`; see
  // PluginDataRecord. Deliberately NOT routed through the custom-entity
  // helpers, whose writes land in the public content change feed.
  getPluginData(ns: string): Promise<PluginDataRecord[]>;
  getPluginDataRecord(ns: string, id: string): Promise<PluginDataRecord | undefined>;
  putPluginData(ns: string, id: string, data: Record<string, unknown>): Promise<PluginDataRecord>;
  deletePluginDataRecord(ns: string, id: string): Promise<boolean>;
  /**
   * Drop an entire namespace, or every namespace belonging to a plugin when
   * `ns` is a bare plugin id. Uninstalling used to delete one row from the
   * plugins table and orphan everything the plugin had written.
   */
  deletePluginData(ns: string): Promise<number>;

  // Legacy-URL recovery. The redirect map is read on EVERY unmatched request,
  // so it is loaded once and indexed in memory — see lib/legacy/redirect-store.ts.
  getRedirects(): Promise<RedirectRule[]>;
  saveRedirect(rule: RedirectRule): Promise<RedirectRule>;
  deleteRedirect(id: string): Promise<boolean>;
  /** Bounded set of aggregated 404s. Replaced wholesale; see recordHit(). */
  getNotFound(): Promise<NotFoundRecord[]>;
  putNotFound(records: readonly NotFoundRecord[]): Promise<void>;

  getCustomEntities(type: string): Promise<CustomEntity[]>;
  getCustomEntity(type: string, id: string): Promise<CustomEntity | undefined>;
  createCustomEntity(type: string, data: Record<string, any>): Promise<CustomEntity | null>;
  updateCustomEntity(type: string, id: string, data: Record<string, any>): Promise<CustomEntity | null>;
  deleteCustomEntity(type: string, id: string): Promise<boolean>;

  // API keys (headless / cross-origin / agent auth)
  getApiKeys(): Promise<ApiKey[]>;
  findApiKeyByHash(hash: string): Promise<ApiKey | undefined>;
  createApiKey(rec: Omit<ApiKey, 'id' | 'created_at'>): Promise<ApiKey | null>;
  touchApiKey(id: string): Promise<void>;
  updateApiKey(id: string, patch: Partial<Omit<ApiKey, 'id' | 'created_at'>>): Promise<ApiKey | null>;
  deleteApiKey(id: string): Promise<boolean>;

  // Webhooks (outbound events)
  getWebhooks(): Promise<Webhook[]>;
  createWebhook(rec: Omit<Webhook, 'id' | 'created_at'>): Promise<Webhook | null>;
  deleteWebhook(id: string): Promise<boolean>;

  // Webhook delivery log (retry tracking + manual redelivery)
  createWebhookDelivery(rec: Omit<WebhookDelivery, 'id' | 'created_at' | 'updated_at'>): Promise<WebhookDelivery | null>;
  updateWebhookDelivery(id: string, patch: Partial<Omit<WebhookDelivery, 'id' | 'created_at'>>): Promise<WebhookDelivery | null>;
  getWebhookDelivery(id: string): Promise<WebhookDelivery | undefined>;
  getWebhookDeliveries(opts?: { webhookId?: string; limit?: number }): Promise<WebhookDelivery[]>;

  // Security audit log
  createAuditEvent(rec: Omit<AuditEvent, 'id' | 'created_at'>): Promise<AuditEvent | null>;
  getAuditEvents(opts?: AuditQuery): Promise<AuditEvent[]>;

  /**
   * ATOMICALLY reserve `qty` units of a product's stock.
   *
   * Returns true when reserved (or when the product doesn't track stock), false
   * when there isn't enough. This exists because read-check-then-write is a
   * TOCTOU race: two concurrent checkouts both see stock available and both
   * decrement, overselling the item. Implementations MUST make the check and the
   * decrement a single atomic step.
   */
  /**
   * `opts.allowBackorder` lets the count go NEGATIVE for products whose
   * backorder policy permits it. It stays inside this same atomic call on
   * purpose: doing the backorder as a separate non-atomic write would reopen
   * exactly the oversell race the atomic path exists to close.
   */
  reserveStock(
    productId: string,
    qty: number,
    opts?: { allowBackorder?: boolean; variantId?: string | null },
  ): Promise<boolean>;
  /**
   * Return `qty` units previously reserved (checkout rollback, cancellation,
   * refund). No-op for products that don't track stock.
   */
  releaseStock(productId: string, qty: number, opts?: { variantId?: string | null }): Promise<void>;

  // Post revisions (own collection — see the PostRevision doc comment for why).
  createPostRevision(rec: Omit<PostRevision, 'id' | 'created_at'>): Promise<PostRevision | null>;
  /** Newest first. `limit` caps the result (default 50). */
  getPostRevisions(postId: string, limit?: number): Promise<PostRevision[]>;
  getPostRevision(id: string): Promise<PostRevision | undefined>;
  /** Keep the newest `keep` revisions for a post; delete the rest. Returns how many were removed. */
  prunePostRevisions(postId: string, keep: number): Promise<number>;
  /** Remove every revision of a post (called when the post itself is deleted). */
  deletePostRevisions(postId: string): Promise<number>;

  // Schema version — read/advanced by the migration runner (src/lib/migrations.ts).
  // 0 means "unversioned" (a database that predates the migration system).
  getSchemaVersion(): Promise<number>;
  setSchemaVersion(version: number): Promise<void>;
}
