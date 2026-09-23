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
} as const;

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
