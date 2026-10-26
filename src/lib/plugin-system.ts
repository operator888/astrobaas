/**
 * Plugin system for AstroBaaS.
 *
 * Plugins are trusted, in-process modules bundled with the app (see
 * src/plugins/). They extend behaviour through two mechanisms:
 *   - filters: transform a value and return it (e.g. rewrite post HTML)
 *   - actions: fire-and-forget side effects (e.g. log on post save)
 *
 * Activation state is persisted in LocalDB (the `plugins` table). On boot,
 * `bootstrap()` registers every bundled plugin and re-activates the ones marked
 * active, so a server restart preserves the operator's choices.
 *
 * Single source of truth for hook names is PLUGIN_HOOKS below; call sites and
 * plugins should reference those constants rather than raw strings.
 */

export type FilterFn = (value: any, ...args: any[]) => any;
export type ActionFn = (...args: any[]) => void | Promise<void>;

import type { PluginRoute } from './plugin-platform/routes';
import type { PluginAdminPage } from './plugin-platform/admin-pages';
import type { PluginMigration } from './plugin-platform/store';
import type { OrderLineAddon } from '../core/models';
export type { PluginRoute, PluginAdminPage, PluginMigration };

export interface Plugin {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  /**
   * Semver range of the host plugin API this plugin needs, e.g. "^1.0.0".
   *
   * Checked when the plugin is loaded EXTERNALLY (ASTROBAAS_PLUGINS): an
   * incompatible module is refused with a reason naming both versions, instead
   * of loading and failing somewhere deep at request time. Optional, because a
   * bundled plugin is compiled against the tree it lives in and the check
   * would only ever agree with the compiler.
   *
   * The host version is MANIFEST_API_VERSION — one version covers manifests
   * and code plugins alike, so "what am I compatible with" has a single answer.
   */
  requiresCore?: string;
  /** Filters: { [hookName]: (value, ...args) => newValue } */
  filters?: Record<string, FilterFn>;
  /** Actions: { [hookName]: (...args) => void } */
  actions?: Record<string, ActionFn>;
  /**
   * API routes this plugin serves.
   *
   * Collected from ACTIVE plugins at bootstrap and dispatched by the catch-all
   * at src/pages/api/[...pluginRoute].ts. A core route file always wins — see
   * lib/plugin-platform/routes.ts for why that is structural.
   */
  routes?: readonly PluginRoute[];
  /**
   * Admin screens, mounted under /admin/plugin/<id>/…
   *
   * Namespaced rather than free-form because admin authorisation is
   * longest-prefix-wins over one shared table, and a plugin path that
   * out-specified a core prefix would decide who may open core screens.
   */
  adminPages?: readonly PluginAdminPage[];
  /**
   * Data transforms for this plugin's own records, versioned independently of
   * core's schema version. Run at bootstrap; `up()` must be idempotent.
   */
  migrations?: readonly PluginMigration[];
  /** Optional lifecycle callbacks. */
  activate?: () => void | Promise<void>;
  deactivate?: () => void | Promise<void>;
}

export interface PluginSettings {
  [key: string]: any;
}

/**
 * Documented hook catalog — the integration points core actually fires. Every
 * constant here is wired into a real, tested code path (no aspirational hooks).
 * See PLUGIN_DEVELOPMENT.md for payload contracts.
 */
export const PLUGIN_HOOKS = {
  /** filter(posts: Post[]) -> Post[] — ONE page, already visibility-filtered by the query. */
  API_POSTS_GET: 'api_posts_get',
  /** filter(html: string, post: Post) -> string — post body HTML (re-sanitized after). */
  POST_CONTENT: 'post_content',
  /** filter(title: string, post: Post) -> string — post title. */
  POST_TITLE: 'post_title',
  /**
   * filter(post: PostInput, ctx: { isNew: boolean }) -> PostInput — runs just
   * before a post is persisted (create or update). Return the (possibly
   * modified) post fields; content is sanitized AFTER this filter, so you can't
   * use it to bypass sanitization.
   */
  BEFORE_POST_SAVE: 'before_post_save',
  /** action(post: Post) — after a post is created or updated. */
  AFTER_POST_SAVE: 'after_post_save',
  /** action(post: Post) — after a post is deleted. */
  AFTER_POST_DELETE: 'after_post_delete',
  /**
   * filter(groups: RobotsGroup[], ctx: { origin: string }) -> RobotsGroup[]
   *
   * Per-crawler groups for robots.txt. Core builds the operator's own choices
   * from the `crawler_policy` setting and hands them here, so a pack can add
   * agents from a MAINTAINED catalogue, rewrite a group, or replace the lot.
   *
   * The seam: core owns the mechanism and a seed list that WILL go stale; a
   * pack owns the catalogue that does not, because new crawlers appear monthly
   * and the difference between "indexes you" and "trains on you" is not
   * derivable from the token. A pack should take the groups it is handed and
   * return them plus its own — replacing the array wholesale discards the
   * operator's explicit choices, which are the one thing it must not overrule.
   */
  ROBOTS_GROUPS: 'robots_groups',
  /**
   * filter(verdict: { block: boolean; reason?: string },
   *        ctx: { userAgent: string; path: string }) -> verdict
   *
   * ENFORCEMENT, which robots.txt cannot do. robots.txt is a REQUEST, and a
   * crawler that ignores it is precisely the crawler an operator wanted to
   * stop. Core calls this on every public request and does nothing by default —
   * it ships the seam, not a blocklist, because blocking by User-Agent needs
   * the same maintained catalogue and gets somebody's real traffic wrong the
   * moment it is stale.
   *
   * A pack returning `{ block: true }` gets a 403.
   */
  CRAWLER_POLICY: 'crawler_policy',
  /**
   * filter(html: string, ctx: { pathname: string }) -> string — extra markup
   * injected into <head> on every public page. Output is sanitized to a safe
   * subset (meta/link only), so it can't inject scripts OR inline styles.
   * For CSS use PLUGIN_STYLES below.
   */
  HEAD_TAGS: 'head_tags',
  /**
   * filter(css: string, ctx: { pathname: string }) -> string — append CSS for
   * public pages. The concatenated result is served as an external stylesheet
   * at /plugins.css and linked from the layout.
   *
   * Why a dedicated hook instead of a <style> tag in HEAD_TAGS: the app ships a
   * hash-based CSP with no 'unsafe-inline', and per-request markup has no
   * build-time hash — an inline <style> would be silently dropped by the
   * browser. Serving it same-origin keeps plugin CSS working under a strict CSP.
   */
  PLUGIN_STYLES: 'plugin_styles',

  /* ── Commerce hooks ─────────────────────────────────────────────── */
  /** filter(products: Product[]) -> Product[] — full product list before filtering/pagination. */
  API_PRODUCTS_GET: 'api_products_get',
  /**
   * filter(expander: TermExpander | null, ctx: { products, query, settings }) -> TermExpander | null
   *
   * Contribute alternative spellings for a search term — Greeklish, typos,
   * synonyms. The core keeps ownership of RELEVANCE (see lib/search/rank.ts);
   * a plugin here only says what a term may also mean, and the core consults it
   * ONLY when the literal term matched nothing, memoised once per query.
   *
   * Returning null means "no expansion" — but null is NOT what you are handed:
   * the initial value is the operator's own expander built from
   * `search_synonyms`, so returning null discards their configuration. A plugin
   * must not assume it is the only one: take the expander it is handed and
   * compose with it rather than discarding it.
   *
   * `ctx.settings` holds every `search_*` setting, read by the CALL SITE and
   * passed in. applyFilters is synchronous and settings reads are not, so a
   * module cannot read its own configuration here — and a module-level cache
   * would keep answering with a table the operator has since edited.
   */
  SEARCH_EXPAND: 'search_expand',
  /**
   * filter(product: ProductInput, ctx: { isNew: boolean }) -> ProductInput —
   * runs just before a product is persisted. Description HTML is sanitized
   * AFTER this filter.
   */
  BEFORE_PRODUCT_SAVE: 'before_product_save',
  /** action(product: Product) — after a product is created or updated. */
  AFTER_PRODUCT_SAVE: 'after_product_save',
  /** action(product: Product) — after a product is deleted. */
  AFTER_PRODUCT_DELETE: 'after_product_delete',
  /**
   * filter(priceCents: number, product: Product, ctx: { qty, variant }) -> number —
   * final unit price at checkout time. The extension point for sales rules,
   * volume discounts, member pricing, etc. Must return integer cents.
   */
  PRODUCT_PRICE: 'product_price',
  /**
   * filter(order: OrderInput, ctx: { isNew: boolean }) -> OrderInput — runs
   * before an order is persisted (checkout or admin edit). Validation happens
   * BEFORE this filter; totals are re-checked after.
   */
  BEFORE_ORDER_SAVE: 'before_order_save',
  /** action(order: Order) — after an order is created (checkout completed). */
  AFTER_ORDER_CREATE: 'after_order_create',
  /** action(order: Order, previousStatus: string) — after an order status change. */
  AFTER_ORDER_STATUS_CHANGE: 'after_order_status_change',
  /**
   * action({ now: number }) — once per scheduler sweep, on the process that
   * holds the scheduler lease (so ONCE per database, not once per replica).
   *
   * For a plugin that has to do something when a date arrives rather than when
   * a request does: issue a recurring invoice, expire a trial, send a digest.
   * The sweep waits for every handler (errors are isolated and logged), so a
   * slow handler delays the next sweep rather than overlapping it. Sweeps run
   * about once a minute, so a handler that does real work should throttle
   * itself and be idempotent. Fires only for ACTIVE plugins, and only after the
   * plugin registry has finished bootstrapping.
   */
  SCHEDULER_TICK: 'scheduler_tick',
  /**
   * filter(result: OrderLineExtras, ctx: { line, product, name }) -> OrderLineExtras
   *
   * The one extension point a VERTICAL needs: inspect an order line against the
   * product being bought, refuse it, or attach extra data that is frozen onto
   * the line at purchase.
   *
   *   { ok: true, patch }      accept, merging `patch` into the stored line
   *   { ok: false, message }   refuse the whole order with a 400
   *
   * This exists because `commerce-service.ts` used to validate optical
   * PRESCRIPTIONS inline — core code that knew what a dioptre was, in the middle
   * of the checkout path. Verticals cannot each carve their own hole in
   * checkout, so core now asks one generic question and the optical plugin
   * answers it.
   *
   * With no plugin registered the initial value passes straight through, which
   * is the required degradation: an install without the optical module accepts
   * the order and keeps whatever was sent as plain stored data rather than
   * 500ing on a field it no longer understands.
   *
   * Note the reduce order matters if two plugins register: a refusal from one
   * must not be overwritten by a later `ok: true`. Implementations should
   * return the incoming value unchanged when it is already `ok: false`.
   */
  ORDER_LINE_EXTRAS: 'order_line_extras',
  /**
   * filter(schema: unknown, ctx: { name: string; variant?: string }) -> unknown
   *
   * A vertical publishes its own machine-readable schema so a decoupled
   * storefront can build a form without hard-coding the domain. Core serves the
   * route and knows nothing about what comes back.
   *
   * The initial value is `null`, and a plugin that does not recognise `name`
   * must return it unchanged. Core answers 404 when the result is still null,
   * which is also exactly the right answer when the module is absent: an
   * install without the vertical looks like one that never had it.
   *
   * Exists because `/api/commerce/prescription-schema` and
   * `/api/commerce/frame-schema` used to IMPORT the optical module directly.
   * That is a core route depending on a paid plugin — it made the module
   * impossible to remove without breaking the build, which is the opposite of
   * what a vertical should be.
   */
  COMMERCE_SCHEMA: 'commerce_schema',
  /**
   * filter(providers: PaymentProvider[]) -> PaymentProvider[]
   *
   * A plugin appends its payment gateway. Collected once at bootstrap and handed
   * to `setPluginProviders()`; the registry refuses an id that already exists,
   * because a provider silently replacing `stripe` would reroute live payments.
   *
   * Exists so a gateway does not have to live in this repository — a Greek
   * instant-payments provider is worth selling, and a bank-specific gateway
   * built for one client belongs to that engagement rather than to every
   * install of the CMS.
   */
  PAYMENT_PROVIDERS: 'payment_providers',
  /**
   * filter(methods: ManualMethodDef[]) -> ManualMethodDef[]
   *
   * A plugin adds a payment method that takes no credentials and calls no API:
   * the buyer is told what to do, does it somewhere else, and a human marks the
   * order paid.
   *
   * Exists because not every payment method is a gateway. Greece's IRIS is the
   * case that forced it — a shop registers with its bank and is paid by its
   * phone number or ΑΦΜ, with nothing to integrate — and `MANUAL_METHODS` was a
   * hardcoded pair no plugin could extend.
   *
   * Each method may carry `instructions` (locale → text) which is served
   * PUBLICLY at /api/payments, because the buyer is who needs to read it. Only
   * things a shop already publishes belong in there — never a credential.
   */
  MANUAL_METHODS: 'manual_methods',
  /**
   * filter(defs: unknown[]) -> unknown[]
   *
   * A plugin declares product fields — the same kind a merchant declares under
   * Settings → Product fields, with values stored in `Product.custom`. Append
   * raw definitions in exactly the shape `PUT /api/commerce/product-fields`
   * accepts: `{ name, label?, help?, rule, visibility? }`. The initial value is
   * `[]`; return the incoming array with yours added.
   *
   * Exists because a vertical plugin needs typed per-product data of its own,
   * and without this it could only ask the merchant to type the definitions in
   * by hand and hope nobody renamed one. Core merges them in `getProductFieldDefs`
   * (see `mergeProductFieldDefs`), so product save validation, the admin
   * product form, the public projection and the bulk paths all see them without
   * knowing a plugin was involved.
   *
   * Each definition is validated on its own: a malformed one is dropped and
   * logged, and never takes the merchant's fields down with it. On a name
   * collision the MERCHANT's definition wins and the plugin's is inactive —
   * installing a plugin must never change what an existing field publishes —
   * and the settings screen names the clash. The editor shows plugin fields
   * read-only, and the PUT refuses a new merchant definition that uses a name a
   * plugin currently provides.
   *
   * With no plugin registered the result is `[]` and the merchant's list is
   * served unchanged. When the plugin is removed its fields simply stop being
   * declared: the values stay in `Product.custom` (undeclared keys are carried
   * through on save), and stop being published on the next read.
   */
  PRODUCT_FIELD_DEFS: 'product_field_defs',
  /**
   * filter(media: ReviewMedia[], ctx: { review: PublicReview; productId: string })
   *   -> ReviewMedia[]
   *
   * THE SEAM for photo and video reviews, which are the paid part of product
   * reviews. Core stores TEXT reviews only and implements no upload, storage,
   * transcoding or media moderation. It calls this filter once per APPROVED
   * review it is about to publish (`GET /api/products/{ref}/reviews`), with an
   * initial value of `[]`, and attaches the result as `media` only when it is
   * non-empty — so an install without a media module serves exactly what it
   * served before the hook existed.
   *
   * A media module keeps its OWN storage keyed by the review id (never in the
   * review record: the key `media` on a review is reserved and is not a
   * declared field, so nothing a submitter posts can land there), and must
   * listen to AFTER_REVIEW_DELETE so an erased review takes its photos with it.
   * Core passes each item through `sanitiseReviewMedia` (lib/reviews.ts), so a
   * filter returning a `javascript:` URL or an unknown kind publishes nothing.
   */
  REVIEW_MEDIA: 'review_media',
  /**
   * action(review: { id: string; product_id: string }, ctx: { reason: 'deleted' | 'erased' })
   *
   * A review was deleted by a moderator, or deleted/anonymised by a GDPR
   * erasure. The other half of REVIEW_MEDIA: whatever a module stored against
   * this review id must go too, or the erasure leaves the person's photographs
   * behind.
   */
  AFTER_REVIEW_DELETE: 'after_review_delete',
  /**
   * filter(verdict: TaxIdVerdict, ctx: { taxId, country?, destination?, settings }) -> TaxIdVerdict
   *
   * SYNCHRONOUS. A verifier (VIES, a national registry) says what it knows
   * about a buyer's tax id: `{ status: 'unchecked' | 'verified' | 'invalid' |
   * 'unverified', country?, … }`. See `TaxIdVerdict` in lib/commerce/tax.ts.
   *
   * Asked from `priceBasket` — so by the quote AND the order — and ONLY where
   * the answer could change the tax: reverse charge switched on, an EU
   * destination other than the shop's country, and a non-empty tax id.
   *
   *   initial `{ status: 'unchecked' }`  no opinion: the shape check decides,
   *                                       exactly as with no plugin.
   *   `verified`    reverse charge if the shop's rules allow, using
   *                 `verdict.country` (ISO, `GR`) over the typed prefix.
   *   `invalid`     no reverse charge; taxed like a consumer.
   *   `unverified`  no reverse charge where a destination rate is on file. It
   *                 NEVER blocks an order: with no rate on file the shape-only
   *                 reverse charge applies instead of a 409.
   *
   * No verdict is itself a refusal: the core captures the tax id and never
   * validates it (see `Address.tax_id`). The only 409 reachable is the one a
   * consumer gets — `invalid` to a destination with no rate on file. A
   * filter must be a cache read — a checkout must not wait on a government
   * web service. `ctx.settings` is every setting, read by the async call site
   * and passed in. Return the incoming value unchanged when it is already
   * `invalid`: a refusal from one verifier must survive the next.
   */
  TAX_ID_VERDICT: 'tax_id_verdict',
  /**
   * filter(rates: TaxRate[], ctx: { settings }) -> TaxRate[]
   *
   * SYNCHRONOUS. Supply tax rate rows — a maintained EU table, a regional
   * pack. Handed a copy of the operator's normalised rows; return them plus
   * your own. Applied by `resolveTaxSettingsWithPlugins`
   * (lib/commerce/tax-plugins.ts), so the quote, the order and the tax
   * override all price with the same table.
   *
   *   - The operator's rows always win: a returned row with the same country,
   *     class and postcodes as one of theirs is dropped, and theirs are kept
   *     even if the filter leaves them out.
   *   - Fail closed: if any filter throws, or the result is not an array, the
   *     operator's rows are used alone.
   *   - Returned rows go through the core's normaliser (not the operator's
   *     50-row cap); every row the core does not use is logged.
   *   - A foreign row is never a domestic rate: domestic lookups read only the
   *     shop's own country.
   *   - Not called with tax off or no `shop_country`.
   *
   * `ctx.settings` is every setting, read by the call site and passed in.
   */
  TAX_RATES: 'tax_rates',
  /**
   * filter(result: LineAddonsResult, ctx: { line, product, variant, qty, name, settings }) -> LineAddonsResult
   *
   * PRICED per-line add-ons — a lens coating, an engraving, gift wrap. Called
   * once per line inside `priceBasket`, so the quote and the order price the
   * same add-ons, starting from `{ ok: true, addons: [] }`.
   *
   *   - `ctx.line` is the request line as posted (`addons`, and `prescription`
   *     in display units), never a stored-units copy.
   *   - `ctx.settings` is every setting, read by the call site: filters are
   *     synchronous.
   *   - The add-ons' `unit_price_cents` are added to the line's unit price
   *     BEFORE coupons, the free-shipping threshold and tax, and the stored
   *     line freezes them as `OrderItem.addons`.
   *   - `{ ok: false, message, code?, params? }` refuses the quote and the
   *     order with a 400. Return an incoming refusal unchanged.
   *   - Fail closed: a filter that throws, returns a Promise or returns a
   *     malformed result refuses the line; so does a selection under
   *     `line.addons` that no filter priced. Never charged without the add-on.
   *
   * See `src/lib/commerce/line-addons.ts` and PLUGIN_DEVELOPMENT.md.
   */
  ORDER_LINE_ADDONS: 'order_line_addons',
  /**
   * filter(issuers: InvoiceIssuer[], ctx: { settings }) -> InvoiceIssuer[]
   *
   * A plugin registers an invoice ISSUER — the myDATA provider pack, a Peppol
   * pack, a bridge to the shop's own ΦΗΜ. Core keeps a frozen, non-fiscal
   * invoice record per order and a credit-memo record per refund
   * (`lib/commerce/invoice-records.ts`); when one becomes final, the chosen
   * issuer's `issue(doc, { order, invoice?, settings, key, attempt,
   * reportLateSuccess })` is called ONCE and what it returns — `{ ok: true,
   * number?, identifiers? }`, `{ ok: false, error, retryable? }` or
   * `{ ok: false, declined: true, reason }` ("not mine": the next issuer is
   * asked, or the record is treated as with no issuer) — is stored on the
   * record. The number it returns is the only document number a record ever
   * carries: core is not a fiscal device.
   *
   * `ctx.settings` is every setting, read by the CALL SITE and passed in:
   * the filter is synchronous, so an issuer leaves itself off the list while
   * its own switch is off without caching it.
   *
   * Exists because every issuer needs the same frozen record (lines, VAT per
   * rate, both parties with the buyer's tax id) and would otherwise rebuild it
   * from the order, each slightly differently.
   *
   * Asked at each use, from active plugins. A record marked
   * `issued_externally` is never sent; with more than one issuer active the
   * shop must choose one (`invoice_issuer`), which is asked first; the others
   * follow in hook order, each only after the one before DECLINED. A failure
   * is never passed on, so a record is never reported twice. `issue()` must
   * be idempotent on `ctx.key` (`astrobaas:<record id>`): a person, or the
   * background sweep after a `retryable` failure or a timeout, retries under
   * it, and only the issuer can know whether the first call landed.
   * Initial value `[]`; append to what you are handed.
   */
  INVOICE_ISSUERS: 'invoice_issuers',
} as const;

/**
 * One priced add-on on an order line — the SAME type that is stored as
 * `OrderItem.addons`, so what a plugin returns and what an order freezes
 * cannot drift apart.
 */
export type LineAddon = OrderLineAddon;

/** Return shape of the {@link PLUGIN_HOOKS.ORDER_LINE_ADDONS} filter. */
export type LineAddonsResult =
  | { ok: true; addons: LineAddon[] }
  | { ok: false; message: string; code?: string; params?: Record<string, string | number> };

/** Return shape of the {@link PLUGIN_HOOKS.ORDER_LINE_EXTRAS} filter. */
export type OrderLineExtras =
  | { ok: true; patch: Record<string, unknown> }
  | {
      ok: false;
      /** English fallback, and what every existing plugin build already returns. */
      message: string;
      /**
       * Stable machine-readable reason, e.g. `optical.prescription_required`.
       *
       * OPTIONAL, so a plugin compiled before this keeps working unchanged.
       * Without it a vertical's checkout refusals are permanently English
       * however complete core's own translations are — core returns
       * `extras.message` straight through, and the plugin is not in this
       * repository.
       */
      code?: string;
      /** Values a storefront needs to build its own sentence. */
      params?: Record<string, string | number>;
    };

export class PluginManager {
  private plugins = new Map<string, Plugin>();
  private activePlugins = new Set<string>();
  private filters = new Map<string, FilterFn[]>();
  private actions = new Map<string, ActionFn[]>();
  private booted = false;

  registerPlugin(plugin: Plugin) {
    // A Map: the later registration wins, and the earlier one vanishes without
    // a word. That is survivable — activatePlugin registers each id's filters
    // once either way — but it is exactly the shape of bug nobody finds, and it
    // became likely the moment a customer could install both a single module
    // and a bundle that contains it. Whichever loaded last then decides which
    // VERSION of the code is running, and nothing says so.
    const existing = this.plugins.get(plugin.id);
    if (existing) {
      console.warn(
        `[astrobaas] plugin "${plugin.id}" was registered twice `
        + `(v${existing.version ?? '?'} then v${plugin.version ?? '?'}); the second one wins. `
        + 'Two packages are probably providing it — check ASTROBAAS_PLUGINS.',
      );
    }
    this.plugins.set(plugin.id, plugin);
  }

  activatePlugin(pluginId: string) {
    const plugin = this.plugins.get(pluginId);
    if (!plugin || this.activePlugins.has(pluginId)) return;
    this.activePlugins.add(pluginId);
    for (const [hook, fn] of Object.entries(plugin.filters ?? {})) {
      if (!this.filters.has(hook)) this.filters.set(hook, []);
      this.filters.get(hook)!.push(fn);
    }
    for (const [hook, fn] of Object.entries(plugin.actions ?? {})) {
      if (!this.actions.has(hook)) this.actions.set(hook, []);
      this.actions.get(hook)!.push(fn);
    }
    try {
      plugin.activate?.();
    } catch (err) {
      console.error(`Plugin ${pluginId} activate() failed:`, err);
    }
  }

  deactivatePlugin(pluginId: string) {
    const plugin = this.plugins.get(pluginId);
    if (!plugin || !this.activePlugins.has(pluginId)) return;
    this.activePlugins.delete(pluginId);
    for (const [hook, fn] of Object.entries(plugin.filters ?? {})) {
      const arr = this.filters.get(hook);
      if (arr) this.filters.set(hook, arr.filter(f => f !== fn));
    }
    for (const [hook, fn] of Object.entries(plugin.actions ?? {})) {
      const arr = this.actions.get(hook);
      if (arr) this.actions.set(hook, arr.filter(f => f !== fn));
    }
    try {
      plugin.deactivate?.();
    } catch (err) {
      console.error(`Plugin ${pluginId} deactivate() failed:`, err);
    }
  }

  /**
   * Whether any active plugin registers a filter for `hookName`. Lets callers
   * skip work (e.g. omitting the /plugins.css <link> when no plugin adds CSS).
   */
  hasFilter(hookName: string): boolean {
    return (this.filters.get(hookName)?.length ?? 0) > 0;
  }

  /** Run a value through every active filter registered for `hookName`. */
  applyFilters(hookName: string, value: any, ...args: any[]) {
    const fns = this.filters.get(hookName);
    if (!fns || !fns.length) return value;
    return fns.reduce((acc, fn) => {
      try {
        return fn(acc, ...args);
      } catch (err) {
        console.error(`Error in filter "${hookName}":`, err);
        return acc;
      }
    }, value);
  }

  /**
   * `applyFilters`, and whether any filter THREW.
   *
   * `applyFilters` isolates a throwing filter by carrying on with the value it
   * was handed — which is the value a filter may already have mutated in place
   * before throwing. A caller that must fail closed (money) needs to know a
   * filter failed so it can discard the result instead.
   */
  applyFiltersReporting(hookName: string, value: any, ...args: any[]): { value: any; threw: boolean } {
    const fns = this.filters.get(hookName);
    if (!fns || !fns.length) return { value, threw: false };
    let threw = false;
    const out = fns.reduce((acc, fn) => {
      try {
        return fn(acc, ...args);
      } catch (err) {
        threw = true;
        console.error(`Error in filter "${hookName}":`, err);
        return acc;
      }
    }, value);
    return { value: out, threw };
  }

  /**
   * Like `doAction`, but resolves after every handler — including async ones —
   * has settled. For callers that must not start the next piece of work until
   * this one is done (the scheduler sweep). Errors are isolated and logged.
   */
  async doActionAwait(hookName: string, ...args: any[]): Promise<void> {
    const fns = this.actions.get(hookName);
    if (!fns) return;
    for (const fn of [...fns]) {
      try {
        await fn(...args);
      } catch (err) {
        console.error(`Error in action "${hookName}":`, err);
      }
    }
  }

  /** Fire all active actions for `hookName` (errors are isolated). */
  doAction(hookName: string, ...args: any[]) {
    const fns = this.actions.get(hookName);
    if (!fns) return;
    for (const fn of fns) {
      try {
        const r = fn(...args);
        if (r && typeof (r as Promise<void>).catch === 'function') {
          (r as Promise<void>).catch(err => console.error(`Error in action "${hookName}":`, err));
        }
      } catch (err) {
        console.error(`Error in action "${hookName}":`, err);
      }
    }
  }

  getPlugins(): Plugin[] {
    return Array.from(this.plugins.values());
  }

  getActivePlugins(): Plugin[] {
    return Array.from(this.activePlugins)
      .map(id => this.plugins.get(id)!)
      .filter(Boolean);
  }

  isPluginActive(pluginId: string): boolean {
    return this.activePlugins.has(pluginId);
  }

  /**
   * Register the bundled plugins and activate those persisted as active.
   * `loadState` returns the set of active plugin ids (from LocalDB). Idempotent.
   */
  async bootstrap(plugins: Plugin[], loadState: () => Promise<Set<string>>) {
    if (this.booted) return;
    this.booted = true;
    for (const p of plugins) this.registerPlugin(p);
    let activeIds: Set<string>;
    try {
      activeIds = await loadState();
    } catch (err) {
      console.error('Plugin bootstrap: failed to load state:', err);
      activeIds = new Set();
    }
    for (const id of activeIds) this.activatePlugin(id);
  }

  /**
   * Drop all registration state so the next bootstrap() re-registers from
   * scratch. Used when a runtime-installed (declarative) plugin is added or
   * removed and the in-process registry must reflect the new set.
   */
  reset() {
    this.plugins.clear();
    this.activePlugins.clear();
    this.filters.clear();
    this.actions.clear();
    this.booted = false;
  }

  /** Test helper (alias of reset). */
  _resetForTest() {
    this.reset();
  }
}

// Singleton instance shared across the SSR process.
export const pluginManager = new PluginManager();
