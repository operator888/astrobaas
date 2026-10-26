/**
 * `astrobaas/client` — a tiny, dependency-free, isomorphic TypeScript SDK for
 * talking to an AstroBaaS backend over its JSON HTTP API.
 *
 * Designed for headless frontends and AI-generated apps: point it at your
 * backend URL, hand it an API key (minted at POST /api/keys), and call typed
 * methods instead of hand-rolling fetch + envelope unwrapping + error handling.
 *
 *   import { createClient } from 'astrobaas/client';
 *   const baas = createClient('https://cms.example.com', { apiKey: process.env.ASTROBAAS_KEY });
 *   const posts = await baas.posts.list({ status: 'published', limit: 10 });
 *   const post  = await baas.posts.get('hello-world');
 *   const draft = await baas.posts.create({ title: 'From the SDK' });
 *   const items = await baas.content('product').list();
 *
 * Every method returns the unwrapped `data` on success and throws
 * {@link AstroBaasError} on any non-2xx / `{success:false}` response, so you can
 * use ordinary try/catch. Uses the global `fetch` (Node 18+, Deno, browsers);
 * inject a custom one via `options.fetch` for SSR or tests.
 *
 * Types are imported from `astrobaas/core` so the client and server never drift.
 *
 * @alpha — mirrors the API contract in /openapi.json; see STABILITY.md.
 */
import type {
  Post, PostStatus, CustomEntity, Role, User,
  Product, Order, Customer, MediaFile, StockStatusInfo,
} from '../core/models';
// Coupons live with the pricing rules that judge them, not in the core models.
import type { Coupon } from '../lib/commerce/coupons';
import type { OrderAttribution, AttributionReport } from '../lib/commerce/attribution';
import type { ApiResponse } from '../lib/api-response';
import type { SortValue } from '../lib/commerce/product-sort';

/** Every `sort` value `GET /api/products` accepts. See `SORT_VALUES` in the CMS. */
export type ProductSort = SortValue;

/** One line of an order's timeline (`orders.timeline()`). Staff only. */
export interface OrderTimelineItem {
  id: string;
  at: string;
  /** Dotted code, e.g. `status.changed`, `payment.captured`, `refund.issued`, `note.comment`, `bulk.<action>`. */
  event: string;
  category: 'status' | 'payments' | 'shipments' | 'notes' | 'other';
  /** A user id, `provider`, `system[:job]`, `customer`, or null when not recorded. */
  actor: string | null;
  actor_kind: 'staff' | 'system' | 'provider' | 'customer' | 'unknown';
  actor_name: string | null;
  from?: string;
  to?: string;
  /** Minor units of `currency`; positive. The event says which way the money went. */
  amount_cents?: number;
  currency?: string;
  /** Free text: render as text. */
  text?: string;
  added?: string[];
  removed?: string[];
  ref?: string;
  count?: number;
  derived: boolean;
}

export interface ClientOptions {
  /** Bearer API key (abk_…). Sent as `Authorization: Bearer <key>` on every request. */
  apiKey?: string;
  /** Custom fetch implementation (for SSR frameworks or tests). Defaults to global fetch. */
  fetch?: typeof fetch;
  /** Extra headers merged into every request (lowest precedence). */
  headers?: Record<string, string>;
  /** Abort a request after this many ms (unless the call passes its own signal). */
  timeoutMs?: number;
  /** Retry attempts on 429 / 5xx / network errors (default 0 = off). */
  retries?: number;
  /** Base backoff between retries in ms (exponential; default 250). Honors `Retry-After` on 429. */
  retryBackoffMs?: number;
}

/** Thrown on any non-2xx response or `{ success: false }` body. */
export class AstroBaasError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: unknown;
  /**
   * The SPECIFIC reason, e.g. `checkout.too_many_unpaid` or
   * `IDEMPOTENCY_IN_PROGRESS` — what a storefront keys its own message on.
   * `code` is only the HTTP class (`BAD_REQUEST`, `CONFLICT`, …).
   */
  readonly reason?: string;
  /** Values for the reason's sentence, e.g. `{ max: 5 }`. */
  readonly params?: Record<string, string | number>;
  constructor(
    message: string, status: number, code?: string, details?: unknown,
    extra: { reason?: string; params?: Record<string, string | number> } = {},
  ) {
    super(message);
    this.name = 'AstroBaasError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.reason = extra.reason;
    this.params = extra.params;
  }
}

/**
 * A random Idempotency-Key, where the runtime can make one (every browser,
 * Node 19+, Deno). Undefined otherwise — the order is then placed without a
 * key, exactly as before.
 */
function newIdempotencyKey(): string | undefined {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return typeof c?.randomUUID === 'function' ? c.randomUUID() : undefined;
}

/** One row of `posts.related()` — a summary, deliberately not a whole Post. */
export interface RelatedPostSummary {
  id: string;
  slug: string;
  title: string;
  excerpt?: string;
  featured_image?: string;
  publish_date?: string;
  locale?: string;
  /** Higher is more related. Exposed so a storefront can threshold if it wants. */
  score: number;
}

export interface ListPostsOptions {
  status?: PostStatus;
  /** Category id to filter by. */
  category?: string;
  /** Max number of posts (server caps at 200). */
  limit?: number;
  /** Skip this many items (for pagination). */
  offset?: number;
  /** 1-based page number (computes offset from limit; needs limit). */
  page?: number;
  /** BCP-47 locale to filter by (e.g. "de"). Unknown values fall back to the default. */
  locale?: string;
}

/** Pagination metadata returned by list endpoints (in the response `meta`). */
/** Filters `GET /api/products` accepts. Mirrors the route's own parameters. */
export interface ListProductsOptions {
  /** Free-text over name, SKU, GTIN, brand and tags. */
  search?: string;
  category?: string;
  /**
   * A brand `slug` from `GET /api/brands` — it always leads to that brand, even
   * when the name is Greek or transliterates (`Straße` → `strasse`) — or any
   * spelling of the brand's name.
   */
  brand?: string;
  featured?: boolean;
  on_sale?: boolean;
  /**
   * Result order. The default, `relevance`, is the ranked order for a `search`
   * and the shop's own merchandising order otherwise. `price_asc`/`price_desc`
   * order by what a buyer is charged (a variable product by its cheapest
   * variant), `newest` by creation date, `name_asc`/`name_desc` by name in
   * `locale`. Sorting happens on the server over the whole matching set, so it
   * composes with `limit`/`offset`; an unknown value is a 422, not ignored.
   * The order applied is echoed in the page's `meta.sort`.
   */
  sort?: ProductSort;
  /** Language for translated names and for `name_asc`/`name_desc` collation. */
  locale?: string;
  limit?: number;
  offset?: number;
  /**
   * Include products a shopper cannot buy — drafts and archived.
   *
   * Staff only: an anonymous caller gets the public catalogue whatever this
   * says, because the route decides, not the client.
   */
  all?: boolean;
}

/** Filters `GET /api/orders` accepts. Staff only — orders are never public. */
export interface ListOrdersOptions {
  status?: Order['status'];
  /** Only orders carrying this staff tag (any casing). */
  tag?: string;
  limit?: number;
  offset?: number;
}

/** One line of a basket, for `quote()` and `checkout()`. */
export interface BasketLine {
  product_id: string;
  variant_id?: string;
  qty: number;
}

/** What a storefront sends to price a basket or place an order. */
/**
 * A postal address. Mirrors `Address` in core/models — restated here so the
 * package does not force a storefront to import the whole model layer to type
 * one checkout call.
 */
export interface CheckoutAddress {
  name?: string;
  company?: string;
  line1?: string;
  line2?: string;
  city?: string;
  region?: string;
  postcode?: string;
  /** ISO 3166-1 alpha-2. A country name is REFUSED, not guessed — the server
   *  answers 400 rather than storing an address that ships nowhere. */
  country?: string;
  phone?: string;
  /** ΑΦΜ / VAT id, for a buyer who needs an invoice rather than a receipt. */
  tax_id?: string;
}

export interface CheckoutInput {
  email: string;
  items: BasketLine[];
  name?: string;
  phone?: string;
  /** LEGACY one-line address. Still accepted. IGNORED when `shipping_address`
   *  is supplied — the server re-renders this from the structured fields so the
   *  two cannot disagree. */
  address?: string;
  /** Where it goes. */
  shipping_address?: CheckoutAddress;
  /** Who is invoiced. Absent means "same as delivery", and the server stores a
   *  copy rather than a flag. */
  billing_address?: CheckoutAddress;
  note?: string;
  coupon_code?: string;
  payment_method?: string;
  shipping_method_id?: string;
  shipping_country?: string;
  shipping_postcode?: string;
  /**
   * A solved proof-of-work challenge (`challenge::nonce`), required only when
   * the shop has switched the `checkout` anti-spam surface on. See
   * INTEGRATION.md → "Checkout from a storefront".
   */
  pow_token?: string;
  /**
   * The buyer's answer to "I agree to the Terms & Conditions". A real boolean.
   *
   * REQUIRED to be `true` only when the shop has switched
   * `checkout_terms_required` on — read it, with `checkout_terms_label` and
   * `checkout_terms_url`, from `GET /api/settings/get` (`cms.request('GET', '/api/settings/get')`). Refused
   * otherwise with code `checkout.terms_not_accepted`. Optional and stored as
   * sent while the requirement is off. The server stamps the time.
   */
  terms_accepted?: boolean;
  /** Optional privacy-policy consent, stored as sent. Never required. */
  privacy_accepted?: boolean;
  /**
   * Which campaign brought the shopper: first and last touch, each with the
   * time of the visit. Send it ONLY when the shopper granted marketing consent
   * on your storefront — the CMS cannot see your banner and trusts you on this.
   * Known keys only (utm_source, utm_medium, utm_campaign, utm_term,
   * utm_content, gclid, fbclid, msclkid, at); anything else is a 422.
   * See INTEGRATION.md → "Campaign attribution".
   */
  attribution?: { first?: OrderAttribution['first']; last?: OrderAttribution['last'] };
}

export interface PageMeta {
  total: number;
  count: number;
  limit: number | null;
  offset: number;
  page: number;
  hasMore: boolean;
}

/** A page of results: the items plus pagination metadata. */
export type Page<T> = { items: T[] } & PageMeta;

/** Fields accepted by POST /api/posts. Server fills id/author/dates/views. */
export interface CreatePostInput {
  title: string;
  slug?: string;
  content?: string;
  excerpt?: string;
  featured_image?: string;
  status?: PostStatus;
  publish_date?: string;
  category_id?: string;
  tags?: string[];
  meta_title?: string;
  meta_description?: string;
  /** BCP-47 locale. Defaults to the site's default locale. */
  locale?: string;
  /** Groups translations: all translations of one piece share this value. */
  translation_of?: string;
}

/** Editable post fields for a partial update (all optional). */
export interface UpdatePostInput {
  title?: string;
  slug?: string;
  content?: string;
  excerpt?: string;
  featured_image?: string;
  status?: PostStatus;
  publish_date?: string;
  category_id?: string;
  tags?: string[];
  meta_title?: string;
  meta_description?: string;
  locale?: string;
  translation_of?: string;
}

/** Locale configuration from GET /api/locales. */
export interface LocaleConfig {
  locales: string[];
  default: string;
  multilingual: boolean;
}

export interface CreateKeyInput {
  name: string;
  role?: Role;
  /** Least-privilege scopes, e.g. ['posts:write']. Omit for full (role-only) access. */
  scopes?: string[];
  /** Days until the key expires. Omit for a non-expiring key. */
  expires_in_days?: number;
  /**
   * Trust this key's `X-AstroBaaS-Client-IP` header as the shopper's address
   * (a storefront server calling on a shopper's behalf). See INTEGRATION.md.
   */
  forward_client_ip?: boolean;
}

/** Returned once by POST /api/keys — `key` is the plaintext secret, shown only here. */
export interface CreatedKey {
  id: string;
  name: string;
  role: Role;
  prefix: string;
  key: string;
}

/** API-key metadata from GET /api/keys (never includes the secret). */
export interface ApiKeyInfo {
  id: string;
  name: string;
  prefix: string;
  role: Role;
  scopes?: string[];
  expires_at?: string;
  forward_client_ip?: boolean;
  last_used?: string;
  created_at: string;
}

export interface RegisterWebhookInput {
  url: string;
  /** Event names to subscribe to, e.g. ['post.created'] or ['*'] / ['post.*']. */
  events: string[];
  active?: boolean;
}

/** Returned once by POST /api/webhooks — `secret` signs deliveries, shown only here. */
export interface RegisteredWebhook {
  id: string;
  url: string;
  events: string[];
  active: boolean;
  secret: string;
}

/** Webhook metadata from GET /api/webhooks (never includes the secret). */
export interface WebhookInfo {
  id: string;
  url: string;
  events: string[];
  active: boolean;
  created_at: string;
}

/** A row from the webhook delivery log (GET /api/webhooks/deliveries). */
export interface WebhookDeliveryInfo {
  id: string;
  webhook_id: string;
  url: string;
  event: string;
  status: 'pending' | 'success' | 'failed';
  attempts: number;
  last_status?: number;
  last_error?: string;
  created_at: string;
  updated_at: string;
}

/** A security audit-log entry (GET /api/audit). */
export interface AuditEventInfo {
  id: string;
  action: string;
  actor: string;
  target?: string;
  ip?: string;
  metadata?: Record<string, any>;
  created_at: string;
}

/** A bearer API-key principal (no backing user row). */
export interface ApiKeyPrincipal {
  id: string;
  role: Role;
  type: 'apikey';
}

/**
 * The principal returned by `auth.me()`. A cookie session resolves to a full
 * {@link User} (tagged `type: 'user'`); a bearer API key resolves to a synthetic
 * {@link ApiKeyPrincipal}. Discriminate on `.type`.
 */
export type CurrentPrincipal = (User & { type: 'user' }) | ApiKeyPrincipal;

/** Typed accessor for a custom content type registered on the server. */
export interface ContentApi<T = Record<string, any>> {
  /** List all entities of this type. */
  list(): Promise<CustomEntity[]>;
  /** Like list(), but returns a Page with total/hasMore for pagination. */
  page(opts?: { limit?: number; offset?: number; page?: number }): Promise<Page<CustomEntity>>;
  /** Auto-paginate through every entity of this type. */
  listAll(): Promise<CustomEntity[]>;
  /** Fetch one entity by id. */
  get(id: string): Promise<CustomEntity>;
  /** Create an entity (validated against the type's server-side schema). */
  create(data: T): Promise<CustomEntity>;
  /** Replace an entity's data by id. */
  update(id: string, data: T): Promise<CustomEntity>;
  /** Delete an entity by id. */
  remove(id: string): Promise<void>;
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Parse a Retry-After header (delta-seconds or HTTP-date) into ms, or null. */
function retryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(header);
  return Number.isFinite(when) ? Math.max(0, when - Date.now()) : null;
}

export class AstroBaasClient {
  readonly baseUrl: string;
  private apiKey?: string;
  private readonly _fetch: typeof fetch;
  private readonly extraHeaders: Record<string, string>;
  private readonly timeoutMs?: number;
  private readonly retries: number;
  private readonly retryBackoffMs: number;

  constructor(baseUrl: string, options: ClientOptions = {}) {
    if (!baseUrl) throw new Error('createClient: baseUrl is required');
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.extraHeaders = options.headers ?? {};
    this.timeoutMs = options.timeoutMs;
    this.retries = Math.max(0, options.retries ?? 0);
    this.retryBackoffMs = options.retryBackoffMs ?? 250;
    const f = options.fetch ?? (typeof fetch !== 'undefined' ? fetch : undefined);
    if (!f) {
      throw new Error('createClient: no global fetch available — pass options.fetch');
    }
    // Bind to avoid `Illegal invocation` when fetch is the global.
    this._fetch = (input: any, init?: any) => f(input, init);
  }

  /** Rotate the bearer key at runtime (e.g. after refreshing a credential). */
  setApiKey(key: string | undefined): void {
    this.apiKey = key;
  }

  /**
   * Low-level typed request against the API. `path` is relative to baseUrl
   * (leading slash optional). Returns the unwrapped `data`; throws on error.
   * Use this for endpoints not yet covered by a typed helper.
   */
  async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    init: RequestInit = {},
  ): Promise<T> {
    return (await this._send<T>(method, path, body, init)).data;
  }

  /** Internal: perform a request and return the full envelope ({ data, meta }). */
  private async _send<T>(
    method: string,
    path: string,
    body?: unknown,
    init: RequestInit = {},
  ): Promise<{ data: T; meta?: PageMeta }> {
    const url = path.startsWith('http')
      ? path
      : `${this.baseUrl}/${path.replace(/^\/+/, '')}`;
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...this.extraHeaders,
      ...((init.headers as Record<string, string>) ?? {}),
    };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    let payload: BodyInit | undefined;
    if (body !== undefined && body !== null) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }

    const maxAttempts = 1 + this.retries;
    let lastNetworkError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Apply a timeout if configured and the caller didn't pass its own signal.
      let timer: ReturnType<typeof setTimeout> | undefined;
      let signal = init.signal;
      if (!signal && this.timeoutMs) {
        const ctrl = new AbortController();
        timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
        signal = ctrl.signal;
      }

      let res: Response;
      try {
        res = await this._fetch(url, { method, ...init, headers, body: payload, signal });
      } catch (err) {
        if (timer) clearTimeout(timer);
        lastNetworkError = err;
        if (attempt < maxAttempts) {
          await delay(this.backoff(attempt));
          continue;
        }
        const aborted = (err as { name?: string })?.name === 'AbortError';
        throw new AstroBaasError(
          aborted ? `Request timed out after ${this.timeoutMs}ms` : (err as Error)?.message || 'Network error',
          0,
          aborted ? 'TIMEOUT' : 'NETWORK',
        );
      } finally {
        if (timer) clearTimeout(timer);
      }

      // Retry transient server states (429 / 5xx) while attempts remain.
      if ((res.status === 429 || res.status >= 500) && attempt < maxAttempts) {
        const ra = res.status === 429 ? retryAfterMs(res.headers.get('retry-after')) : null;
        await delay(ra ?? this.backoff(attempt));
        continue;
      }

      // 204 / empty body — succeed with null.
      const text = await res.text();
      let parsed: (ApiResponse<T> & { meta?: PageMeta }) | null = null;
      if (text) {
        try {
          parsed = JSON.parse(text) as ApiResponse<T> & { meta?: PageMeta };
        } catch {
          if (!res.ok) throw new AstroBaasError(`HTTP ${res.status}`, res.status);
          return { data: text as unknown as T }; // non-JSON 2xx (rare)
        }
      }

      if (!res.ok || (parsed && parsed.success === false)) {
        const err = parsed && parsed.success === false ? parsed.error : undefined;
        throw new AstroBaasError(err?.message ?? `HTTP ${res.status}`, res.status, err?.code, err?.details, {
          reason: err?.reason, params: err?.params,
        });
      }
      return {
        data: (parsed && parsed.success === true ? parsed.data : (null as unknown)) as T,
        meta: parsed && parsed.success === true ? parsed.meta : undefined,
      };
    }
    // Unreachable in practice (loop returns/throws), but satisfies the type.
    throw new AstroBaasError((lastNetworkError as Error)?.message || 'Request failed', 0);
  }

  /** Exponential backoff (ms) for a given 1-based attempt. */
  private backoff(attempt: number): number {
    return this.retryBackoffMs * 2 ** (attempt - 1);
  }

  /** Build a list query string from common options. */
  private listQuery(opts: { status?: string; category?: string; limit?: number; offset?: number; page?: number; locale?: string }): string {
    const qs = new URLSearchParams();
    if (opts.status) qs.set('status', opts.status);
    if (opts.category) qs.set('category', opts.category);
    if (opts.locale) qs.set('locale', opts.locale);
    if (typeof opts.limit === 'number') qs.set('limit', String(opts.limit));
    if (typeof opts.offset === 'number') qs.set('offset', String(opts.offset));
    if (typeof opts.page === 'number') qs.set('page', String(opts.page));
    const q = qs.toString();
    return q ? `?${q}` : '';
  }

  /**
   * Walk pages of a list endpoint until exhausted, returning a flat array.
   * `fetchPage(offset, size)` returns one Page; we advance by the items returned.
   */
  private async collectPages<T>(fetchPage: (offset: number, size: number) => Promise<Page<T>>, size = 100): Promise<T[]> {
    const out: T[] = [];
    let offset = 0;
    // Safety cap so a misbehaving server can't loop forever.
    for (let i = 0; i < 100_000; i++) {
      const pg = await fetchPage(offset, size);
      out.push(...pg.items);
      if (!pg.hasMore || pg.items.length === 0) break;
      offset += pg.items.length;
    }
    return out;
  }

  /**
   * Query string for the commerce lists.
   *
   * Separate from `listQuery` because the routes genuinely differ: posts take
   * `status`/`locale`/`page`, products take `search`/`brand`/`featured`/`all`.
   * One shared builder would have to accept the union and would then silently
   * send a parameter the route ignores, which reads as a filter that does not
   * work.
   *
   * Booleans are sent only when TRUE, as `1`. The routes read every boolean
   * flag through `queryFlag` (src/lib/http/query-flags.ts), which accepts `1`
   * and `true` and nothing else. A false flag is omitted rather than sent as
   * `false`: "not filtered" is what the caller means, and leaving it out says
   * that to every server version, including ones older than `queryFlag`.
   */
  private commerceQuery(opts: object): string {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(opts)) {
      if (v === undefined || v === null || v === '') continue;
      if (typeof v === 'boolean') { if (v) q.set(k, '1'); continue; }
      q.set(k, String(v));
    }
    const s = q.toString();
    return s ? `?${s}` : '';
  }

  /** Normalize a server page envelope into a typed Page (with sane fallbacks). */
  private toPage<T>(items: T[], meta: PageMeta | undefined): Page<T> {
    return {
      items,
      total: meta?.total ?? items.length,
      count: meta?.count ?? items.length,
      limit: meta?.limit ?? null,
      offset: meta?.offset ?? 0,
      page: meta?.page ?? 1,
      hasMore: meta?.hasMore ?? false,
    };
  }

  /* ---- Posts ---- */
/*
 * ─── Commerce ────────────────────────────────────────────────────────────────
 *
 * The REST API has had products, orders, customers, coupons and media since the
 * beginning; this client covered posts, keys, webhooks, audit and auth and
 * nothing else. So a headless storefront got types for BLOGGING and hand-wrote
 * `fetch` for the shop — which is the half that takes the money.
 *
 * These are thin by design. Every method is the endpoint that already exists,
 * with its real parameters and a type; none of them invents behaviour, because
 * a client that is cleverer than its API is a second place for the rules to
 * live.
 */

  readonly products = {
    /**
     * List the catalogue. Anonymous callers see only what a shopper can buy.
     *
     * `all: true` asks for drafts and archived too, and needs a staff key —
     * the ROUTE decides, so passing it without one simply changes nothing.
     */
    list: (opts: ListProductsOptions = {}): Promise<Product[]> =>
      this.request<Product[]>('GET', `/api/products${this.commerceQuery(opts)}`),
    /** Like list(), with total/hasMore for pagination. */
    page: async (opts: ListProductsOptions = {}): Promise<Page<Product>> => {
      const { data, meta } = await this._send<Product[]>('GET', `/api/products${this.commerceQuery(opts)}`);
      return this.toPage(data ?? [], meta);
    },
    /** Walk every page until exhausted. */
    listAll: (opts: Omit<ListProductsOptions, 'offset'> = {}): Promise<Product[]> =>
      this.collectPages((offset, size) => this.products.page({ ...opts, limit: size, offset })),
    /**
     * One product by id or slug. Active products only, unless `all: true` is
     * passed by catalogue staff — the same rule as `list({ all: true })`.
     */
    get: (ref: string, opts: { all?: boolean } = {}): Promise<Product> =>
      this.request<Product>('GET', `/api/products/${encodeURIComponent(ref)}${opts.all ? '?all=true' : ''}`),
    /**
     * One product's availability: `in-stock`, `low-stock` or `out-of-stock`,
     * plus whether it can still be ordered. Products already carry the same
     * answer as `stock_status`; this is for refreshing it on its own.
     * A product with variants also lists each enabled variant; a grouped
     * product lists each member a shopper can see.
     */
    stockStatus: (ref: string): Promise<StockStatusInfo & {
      product_id: string;
      variants?: (StockStatusInfo & { id: string; options: Record<string, string> })[];
      members?: (StockStatusInfo & { id: string })[];
    }> => this.request('GET', `/api/products/${encodeURIComponent(ref)}/stock-status`),
    /** Create one (staff). */
    create: (input: Partial<Product>): Promise<Product> =>
      this.request<Product>('POST', '/api/products', input),
    /** Partially update one (staff). */
    update: (ref: string, input: Partial<Product>): Promise<Product> =>
      this.request<Product>('PUT', `/api/products/${encodeURIComponent(ref)}`, input),
    /** Delete one (staff). */
    remove: async (ref: string): Promise<void> => {
      await this.request('DELETE', `/api/products/${encodeURIComponent(ref)}`);
    },
    /**
     * Ask to be told when a sold-out product returns.
     *
     * Public, and answers the same way whether it recorded anything or not —
     * so there is nothing here to branch on except a malformed address.
     */
    notifyWhenBack: async (ref: string, email: string, variantId?: string): Promise<void> => {
      await this.request('POST', `/api/products/${encodeURIComponent(ref)}/notify-me`,
        { email, ...(variantId ? { variant_id: variantId } : {}) });
    },
  };

  readonly orders = {
    /** List orders (staff). */
    list: (opts: ListOrdersOptions = {}): Promise<Order[]> =>
      this.request<Order[]>('GET', `/api/orders${this.commerceQuery(opts)}`),
    /** Like list(), with total/hasMore. */
    page: async (opts: ListOrdersOptions = {}): Promise<Page<Order>> => {
      const { data, meta } = await this._send<Order[]>('GET', `/api/orders${this.commerceQuery(opts)}`);
      return this.toPage(data ?? [], meta);
    },
    /** One order by id (staff). */
    get: (id: string): Promise<Order> =>
      this.request<Order>('GET', `/api/orders/${encodeURIComponent(id)}`),
    /**
     * Price a basket without placing anything.
     *
     * Public. Returns the same totals the order will carry — server-priced, so
     * a storefront never computes money itself.
     */
    quote: (input: Omit<CheckoutInput, 'email'> & { email?: string }): Promise<unknown> =>
      this.request('POST', '/api/orders/quote', input),
    /**
     * Place an order. Public: a shopper never needs an account.
     *
     * Prices are computed server-side from the product ids and quantities; any
     * totals sent here are ignored, which is what stops a hostile client
     * claiming an order costs one cent.
     */
    /*
     * Always sent with an `Idempotency-Key` — the caller's, or one generated
     * here — and the SAME key on every retry this client makes. Without it a
     * checkout that timed out and was retried was placed twice; with it the
     * retry gets the first order back (`201`, `Idempotent-Replayed: true`).
     * Pass your own key when YOUR code retries a failed call, so the second
     * `place()` is recognised as the same checkout.
     */
    place: (input: CheckoutInput, opts: { idempotencyKey?: string } = {}): Promise<Order> => {
      const key = opts.idempotencyKey ?? newIdempotencyKey();
      return this.request<Order>('POST', '/api/orders', input, key ? { headers: { 'Idempotency-Key': key } } : {});
    },
    /** Change status, the buyer's note, or the shop's own note (staff). */
    update: (id: string, input: { status?: Order['status']; note?: string; staff_note?: string }): Promise<Order> =>
      this.request<Order>('PUT', `/api/orders/${encodeURIComponent(id)}`, input),
    /**
     * Record tracking, and email the customer the FIRST time (staff).
     *
     * Correcting a number later updates the order without notifying again.
     */
    ship: (id: string, input: { tracking_number?: string; tracking_carrier?: string; tracking_url?: string }):
      Promise<{ id: string; notified: boolean }> =>
      this.request('POST', `/api/orders/${encodeURIComponent(id)}/ship`, input),
    /** The staff tags in use, with how many orders carry each (staff). */
    tags: (): Promise<Array<{ tag: string; count: number; color: string }>> =>
      this.request('GET', '/api/orders/tags'),
    /** Add staff tags to an order — at most 10 per order (staff). */
    addTags: (id: string, tags: string | string[]): Promise<{ id: string; tags: Array<{ tag: string; color: string }>; max: number }> =>
      this.request('POST', `/api/orders/${encodeURIComponent(id)}/tags`, Array.isArray(tags) ? { tags } : { tag: tags }),
    /** Remove one staff tag from an order (staff). */
    removeTag: (id: string, tag: string): Promise<{ id: string; tags: Array<{ tag: string; color: string }>; max: number }> =>
      this.request('DELETE', `/api/orders/${encodeURIComponent(id)}/tags?tag=${encodeURIComponent(tag)}`),
    /** Rename a staff tag on every order that has it (staff). */
    renameTag: (from: string, to: string): Promise<{ tag: string; changed: number; failed: number }> =>
      this.request('PATCH', '/api/orders/tags', { from, to }),
    /** Remove a staff tag from every order that has it (staff). */
    deleteTag: (tag: string): Promise<{ changed: number; failed: number }> =>
      this.request('DELETE', `/api/orders/tags?tag=${encodeURIComponent(tag)}`),
    /**
     * Everything that happened to one order, newest first (staff). `filter` is
     * `status`, `payments`, `shipments`, `notes` or `other`. Part is derived
     * from the order's own fields (`derived: true`), part is stored.
     */
    timeline: (id: string, query: { filter?: string; limit?: number; offset?: number } = {}): Promise<OrderTimelineItem[]> => {
      const q = new URLSearchParams();
      if (query.filter) q.set('filter', query.filter);
      if (query.limit !== undefined) q.set('limit', String(query.limit));
      if (query.offset !== undefined) q.set('offset', String(query.offset));
      const qs = q.toString();
      return this.request('GET', `/api/orders/${encodeURIComponent(id)}/timeline${qs ? `?${qs}` : ''}`);
    },
    /** Add a staff comment to an order's timeline (staff). At most 1000 characters. */
    addTimelineComment: (id: string, text: string): Promise<OrderTimelineItem> =>
      this.request('POST', `/api/orders/${encodeURIComponent(id)}/timeline`, { text }),
    /**
     * Paid orders and revenue by campaign source, medium and campaign over a
     * date range (staff). `from`/`to` are inclusive `YYYY-MM-DD` UTC days.
     */
    attribution: (opts: { from?: string; to?: string; model?: 'first' | 'last' } = {}): Promise<AttributionReport> => {
      const q = new URLSearchParams();
      if (opts.from) q.set('from', opts.from);
      if (opts.to) q.set('to', opts.to);
      if (opts.model) q.set('model', opts.model);
      const qs = q.toString();
      return this.request('GET', `/api/orders/attribution${qs ? `?${qs}` : ''}`);
    },
    /** Refund some or all of an order (staff). */
    refund: (id: string, input: { amount_cents?: number; reason?: string }): Promise<unknown> =>
      this.request('POST', `/api/orders/${encodeURIComponent(id)}/refund`, input),
  };

  readonly customers = {
    /** List customers (staff). */
    list: (opts: { limit?: number; offset?: number } = {}): Promise<Customer[]> =>
      this.request<Customer[]>('GET', `/api/customers${this.commerceQuery(opts)}`),
    /** Like list(), with total/hasMore. */
    page: async (opts: { limit?: number; offset?: number } = {}): Promise<Page<Customer>> => {
      const { data, meta } = await this._send<Customer[]>('GET', `/api/customers${this.commerceQuery(opts)}`);
      return this.toPage(data ?? [], meta);
    },
  };

  readonly coupons = {
    /** List coupons and automatic cart rules (staff). */
    list: (): Promise<Coupon[]> => this.request<Coupon[]>('GET', '/api/coupons'),
    /**
     * Create one (admin).
     *
     * `automatic: true` makes it a cart rule — the same coupon, applied without
     * anybody typing a code.
     */
    create: (input: Partial<Coupon>): Promise<Coupon> =>
      this.request<Coupon>('POST', '/api/coupons', input),
    update: (id: string, input: Partial<Coupon>): Promise<Coupon> =>
      this.request<Coupon>('PUT', `/api/coupons/${encodeURIComponent(id)}`, input),
    remove: async (id: string): Promise<void> => {
      await this.request('DELETE', `/api/coupons/${encodeURIComponent(id)}`);
    },
  };

  readonly media = {
    /** List media files (staff). */
    list: (): Promise<MediaFile[]> => this.request<MediaFile[]>('GET', '/api/media/get'),
    /**
     * Upload a file (staff).
     *
     * Takes a `FormData` rather than a typed body: the endpoint is multipart,
     * and pretending otherwise would mean this client re-encoding the boundary
     * itself. The caller keeps control of the field names the route expects.
     */
    upload: (form: FormData): Promise<MediaFile> =>
      this.request<MediaFile>('POST', '/api/media/upload', undefined, { body: form }),
    update: (id: string, input: { alt?: string; title?: string; folder?: string }): Promise<MediaFile> =>
      this.request<MediaFile>('POST', '/api/media/update', { id, ...input }),
    remove: async (id: string): Promise<void> => {
      await this.request('POST', '/api/media/delete', { id });
    },
  };

  readonly posts = {
    /** List posts. Anonymous callers (no key) see only published posts. */
    list: (opts: ListPostsOptions = {}): Promise<Post[]> =>
      this.request<Post[]>('GET', `/api/posts${this.listQuery(opts)}`),
    /** Like list(), but returns a Page with total/hasMore for pagination. */
    page: async (opts: ListPostsOptions = {}): Promise<Page<Post>> => {
      const { data, meta } = await this._send<Post[]>('GET', `/api/posts${this.listQuery(opts)}`);
      return this.toPage(data ?? [], meta);
    },
    /** Auto-paginate through every matching post (walks pages until exhausted). */
    listAll: (opts: Omit<ListPostsOptions, 'offset' | 'page'> = {}): Promise<Post[]> =>
      this.collectPages((offset, size) => this.posts.page({ ...opts, limit: size, offset })),
    /** Fetch a single post by slug. */
    get: (slug: string): Promise<Post> =>
      this.request<Post>('GET', `/api/posts/${encodeURIComponent(slug)}`),
    /**
     * Posts related to this one — the strip that goes under an article.
     *
     * Scored on shared categories and tags, best first, and EMPTY when nothing
     * is genuinely related: it never falls back to "latest", because a
     * recommendation you cannot trust is worse than none. `limit` defaults to
     * the shop's `related_posts_count` setting (3 unless changed, max 12), so a
     * storefront and the CMS's own blog show the same number.
     *
     * Returns a summary per post — id, slug, title, excerpt, featured image,
     * publish date, locale and the score — not rendered bodies.
     */
    related: (ref: string, opts: { limit?: number } = {}): Promise<RelatedPostSummary[]> =>
      this.request<RelatedPostSummary[]>(
        'GET',
        `/api/posts/${encodeURIComponent(ref)}/related`
          + (opts.limit === undefined ? '' : `?limit=${encodeURIComponent(String(opts.limit))}`),
      ),
    /** Create a post (requires a key with author+ role). */
    create: (input: CreatePostInput): Promise<Post> =>
      this.request<Post>('POST', '/api/posts', input),
    /** Partially update a post by id or slug (author+; ownership enforced). */
    update: (ref: string, input: UpdatePostInput): Promise<Post> =>
      this.request<Post>('PUT', `/api/posts/${encodeURIComponent(ref)}`, input),
    /** Delete a post by id or slug (author+; ownership enforced). */
    remove: async (ref: string): Promise<void> => {
      await this.request<null>('DELETE', `/api/posts/${encodeURIComponent(ref)}`);
    },
  };

  /* ---- Custom content types ---- */
  /** Typed accessor for a registered custom content type, e.g. `content('product')`. */
  content<T = Record<string, any>>(type: string): ContentApi<T> {
    const base = `/api/content/${encodeURIComponent(type)}`;
    return {
      list: () => this.request<CustomEntity[]>('GET', base),
      get: (id: string) => this.request<CustomEntity>('GET', `${base}/${encodeURIComponent(id)}`),
      page: async (opts: { limit?: number; offset?: number; page?: number } = {}) => {
        const { data, meta } = await this._send<CustomEntity[]>('GET', `${base}${this.listQuery(opts)}`);
        return this.toPage(data ?? [], meta);
      },
      listAll: () =>
        this.collectPages((offset, size) =>
          this._send<CustomEntity[]>('GET', `${base}${this.listQuery({ limit: size, offset })}`).then(({ data, meta }) => this.toPage(data ?? [], meta)),
        ),
      create: (data: T) => this.request<CustomEntity>('POST', base, data),
      update: (id: string, data: T) =>
        this.request<CustomEntity>('PUT', `${base}/${encodeURIComponent(id)}`, data),
      remove: async (id: string) => {
        await this.request<null>('DELETE', `${base}/${encodeURIComponent(id)}`);
      },
    };
  }

  /* ---- API keys (admin) ---- */
  readonly keys = {
    list: (): Promise<ApiKeyInfo[]> => this.request<ApiKeyInfo[]>('GET', '/api/keys'),
    create: (input: CreateKeyInput): Promise<CreatedKey> =>
      this.request<CreatedKey>('POST', '/api/keys', input),
    /** Rotate a key's secret in place (returns the new secret once). */
    rotate: (id: string): Promise<CreatedKey> =>
      this.request<CreatedKey>('POST', `/api/keys/${encodeURIComponent(id)}/rotate`),
    revoke: async (id: string): Promise<void> => {
      await this.request<null>('DELETE', `/api/keys/${encodeURIComponent(id)}`);
    },
  };

  /* ---- Webhooks (admin) ---- */
  readonly webhooks = {
    list: (): Promise<WebhookInfo[]> => this.request<WebhookInfo[]>('GET', '/api/webhooks'),
    register: (input: RegisterWebhookInput): Promise<RegisteredWebhook> =>
      this.request<RegisteredWebhook>('POST', '/api/webhooks', input),
    remove: async (id: string): Promise<void> => {
      await this.request<null>('DELETE', `/api/webhooks/${encodeURIComponent(id)}`);
    },
    /** The delivery log (most recent first). Filter by webhook id / cap with limit. */
    deliveries: (opts: { webhook?: string; limit?: number } = {}): Promise<WebhookDeliveryInfo[]> => {
      const qs = new URLSearchParams();
      if (opts.webhook) qs.set('webhook', opts.webhook);
      if (typeof opts.limit === 'number') qs.set('limit', String(opts.limit));
      const q = qs.toString();
      return this.request<WebhookDeliveryInfo[]>('GET', `/api/webhooks/deliveries${q ? `?${q}` : ''}`);
    },
    /** Re-send a recorded delivery's exact signed payload (creates a new attempt). */
    redeliver: (deliveryId: string): Promise<WebhookDeliveryInfo> =>
      this.request<WebhookDeliveryInfo>('POST', `/api/webhooks/deliveries/${encodeURIComponent(deliveryId)}/redeliver`),
  };

  /* ---- Audit log (admin) ---- */
  readonly audit = {
    list: (opts: { action?: string; limit?: number } = {}): Promise<AuditEventInfo[]> => {
      const qs = new URLSearchParams();
      if (opts.action) qs.set('action', opts.action);
      if (typeof opts.limit === 'number') qs.set('limit', String(opts.limit));
      const q = qs.toString();
      return this.request<AuditEventInfo[]>('GET', `/api/audit${q ? `?${q}` : ''}`);
    },
  };

  /**
   * Which languages this site serves. Public — useful before requesting
   * localized content (`posts.list({ locale })`).
   */
  locales = (): Promise<LocaleConfig> => this.request<LocaleConfig>('GET', '/api/locales');

  /* ---- Auth ---- */
  readonly auth = {
    /** The principal the current credential resolves to (bearer key or cookie). */
    me: (): Promise<CurrentPrincipal> => this.request<CurrentPrincipal>('GET', '/api/auth/me'),
    /**
     * Log in with email + password. Returns the user; the server also sets a
     * session cookie (only persisted automatically in a browser/credentialed
     * context). For server-to-server use, prefer an API key via `apiKey`.
     *
     * If the account has two-factor enabled, pass the current TOTP (or a backup)
     * code as the third argument. Without it the server responds 401 with error
     * code `TOTP_REQUIRED` — catch that and retry with a code.
     */
    login: (
      email: string,
      password: string,
      code?: string,
    ): Promise<Pick<User, 'id' | 'email' | 'name' | 'role'>> =>
      this.request('POST', '/api/auth/login', code ? { email, password, code } : { email, password }),
    logout: async (): Promise<void> => {
      await this.request<null>('POST', '/api/auth/logout');
    },
    /** Request a password-reset email. Always resolves (no account enumeration). */
    forgotPassword: async (email: string): Promise<void> => {
      await this.request<null>('POST', '/api/auth/forgot', { email });
    },
    /** Complete a password reset with the token from the email. */
    resetPassword: async (token: string, password: string): Promise<void> => {
      await this.request<null>('POST', '/api/auth/reset', { token, password });
    },
    /**
     * Two-factor (TOTP) management for the signed-in cookie session.
     *  1. `setup()` → returns a `secret` + `otpauth_uri` (show as QR / manual key).
     *  2. `enable(code)` → confirm a code from the app; returns one-time `backup_codes`.
     *  3. `disable(code)` → turn 2FA off (needs a current or backup code).
     */
    twoFactor: {
      setup: (): Promise<{ secret: string; otpauth_uri: string }> =>
        this.request('POST', '/api/2fa/setup'),
      enable: (code: string): Promise<{ enabled: boolean; backup_codes: string[] }> =>
        this.request('POST', '/api/2fa/enable', { code }),
      disable: (code: string): Promise<{ enabled: boolean }> =>
        this.request('POST', '/api/2fa/disable', { code }),
    },
  };
}

/** Create an AstroBaaS API client. */
export function createClient(baseUrl: string, options: ClientOptions = {}): AstroBaasClient {
  return new AstroBaasClient(baseUrl, options);
}

/**
 * Verify an incoming webhook's `X-AstroBaaS-Signature` header against the RAW
 * request body and the webhook's signing secret. For receiver code — universal
 * (WebCrypto, so it runs in Node 18+, Deno, edge, and browsers) and constant-time.
 *
 *   const ok = await verifyWebhookSignature(secret, rawBody, req.headers['x-astrobaas-signature']);
 *   if (!ok) return res.status(401).end();
 *
 * Pass the EXACT bytes received (don't re-serialize the parsed JSON).
 */
export async function verifyWebhookSignature(
  secret: string,
  rawBody: string,
  signatureHeader: string | null | undefined,
): Promise<boolean> {
  if (!secret || !rawBody || !signatureHeader) return false;
  const provided = signatureHeader.startsWith('sha256=') ? signatureHeader.slice(7) : signatureHeader;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sigBuf = await crypto.subtle.sign('HMAC', key, enc.encode(rawBody));
  const expected = Array.from(new Uint8Array(sigBuf), (b) => b.toString(16).padStart(2, '0')).join('');
  // Constant-time compare (lengths already implied equal for SHA-256 hex).
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

/*
 * Choosing a variant, option by option — the availability rule every
 * storefront's picker needs: which values can be chosen given the choices
 * before them, and which variant a full choice names. Pure and
 * dependency-free, so it runs in a browser bundle; the storefront starter's
 * VariantSelector is the worked example.
 */
export {
  toSelectable, selectableVariants, variantAxes, axisStates, optionStates, reconcileSelection,
  matchVariant, selectionFor, initialSelection, missingAxes, selectionLabel, blockedText, droppedChoices,
  swatchAxes, swatchOf, swatchColor, swatchImage, isLightColor,
} from '../lib/commerce/variant-selection';
export type {
  SelectableVariant, VariantAxis, OptionBlock, OptionState, VariantSelection, VariantLike,
  Swatch, SwatchAttributeLike,
} from '../lib/commerce/variant-selection';
