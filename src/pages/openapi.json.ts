import type { APIRoute } from 'astro';

/**
 * /openapi.json — machine-readable OpenAPI 3.1 spec of the public API surface,
 * so SDKs, agents, and tools can introspect AstroBaaS. Public, no auth.
 * Kept hand-curated (not generated) so it stays a deliberate, stable contract.
 */
export const prerender = false;

const ok = (dataSchema: any) => ({
  description: 'Success',
  content: {
    'application/json': {
      schema: {
        type: 'object',
        properties: { success: { type: 'boolean', enum: [true] }, data: dataSchema, message: { type: 'string' } },
        required: ['success', 'data'],
      },
    },
  },
});

/**
 * Documented failure. This spec is what an AI agent reads before writing a
 * client, so the statuses that need DIFFERENT handling must be in it: a 409 on
 * checkout means "someone else took the last unit" and is worth retrying, while
 * a 400 never is. Omitting them produces clients that treat both as fatal.
 */
const errRes = (description: string) => ({
  description,
  content: {
    'application/json': {
      schema: {
        type: 'object',
        properties: {
          success: { type: 'boolean', enum: [false] },
          error: {
            type: 'object',
            properties: { message: { type: 'string' }, code: { type: 'string' }, details: {} },
            required: ['message'],
          },
        },
        required: ['success', 'error'],
      },
    },
  },
});

export const GET: APIRoute = async ({ site, url }) => {
  const base = (site?.toString() || url.origin).replace(/\/$/, '');
  const Post = {
    type: 'object',
    properties: {
      id: { type: 'string' }, title: { type: 'string' }, slug: { type: 'string' },
      content: { type: 'string' }, excerpt: { type: 'string' },
      status: { type: 'string', enum: ['draft', 'review', 'scheduled', 'published', 'trashed'] },
      author_id: { type: 'string' }, category_id: { type: 'string' },
      kind: {
        type: 'string', enum: ['post', 'page'],
        description: 'A "page" is a standalone document served at /{slug}; anything else (including an absent value, which is how every record predating this field is stored) is a blog article at /blog/{slug}.',
      },
      tags: { type: 'array', items: { type: 'string' } },
      created_at: { type: 'string' }, updated_at: { type: 'string' },
    },
  };
  const StockStatusInfo = {
    type: 'object',
    description: 'Derived on every read from the count, the effective low-stock threshold and the backorder policy. Never stored.',
    properties: {
      status: { type: 'string', enum: ['in-stock', 'low-stock', 'out-of-stock'], description: '`out-of-stock` when the count is 0 or less (whatever the threshold); `low-stock` when 0 < count <= threshold_qty; otherwise `in-stock`. Untracked stock is always `in-stock`.' },
      tracked: { type: 'boolean', description: 'False when units are not counted (stock is null).' },
      available_qty: { type: 'integer', nullable: true, description: 'Units on hand, never negative; null when untracked. The same number the product publishes as `stock` — no extra disclosure.' },
      threshold_qty: { type: 'integer', description: 'The product\'s own low_stock_threshold when set, otherwise the shop-wide inventory_low_stock_threshold_qty (default 5). 0 means "never low".' },
      backorderable: { type: 'boolean', description: 'Out of stock, but the product\'s backorder policy still lets an order through.' },
      purchasable: { type: 'boolean', description: 'Whether one unit can be ordered right now — the checkout\'s own rule.' },
    },
  };
  const Product = {
    type: 'object',
    properties: {
      price_from_cents: { type: 'integer', nullable: true, description: 'READ-ONLY, derived on every read, never stored. What a buyer pays at the LOWEST: `price_cents` for a simple product, the cheapest ENABLED variant for one with variants (a variable product\'s own `price_cents` is only the fallback its variants inherit). This is exactly the key `?sort=price_asc|price_desc` orders by, so a client can verify or reproduce the server order from the response. For a GROUPED product: the lowest price among the members a shopper can see ("from €X"), null when none is visible.' },
      price_to_cents: { type: 'integer', nullable: true, description: 'READ-ONLY, derived on read. The dearest enabled variant; equal to `price_from_cents` for a simple product. Show "from €X" when it is greater.' },
      stock_status: { ...StockStatusInfo, description: 'READ-ONLY. For a product with variants it is judged on its enabled variants (their counts summed; untracked if any is untracked), and each variants[] entry carries its own. `in_stock` is the stored flag and is not reliable for such products.' },
      custom: { type: 'object', additionalProperties: true, description: 'Values for the fields this merchant declared. Public callers see only the fields marked public; staff see the whole bag. See GET /api/commerce/product-fields for the schema.' },
      id: { type: 'string' }, name: { type: 'string' }, slug: { type: 'string' },
      sku: { type: 'string' }, description: { type: 'string' }, short_description: { type: 'string' },
      price_cents: { type: 'integer' }, regular_price_cents: { type: 'integer' },
      sale_price_cents: { type: 'integer', nullable: true }, on_sale: { type: 'boolean' },
      stock: { type: 'integer', nullable: true }, in_stock: { type: 'boolean' },
      categories: { type: 'array', items: { type: 'string' } }, brand: { type: 'string' },
      images: { type: 'array', items: { type: 'object', properties: { src: { type: 'string' }, alt: { type: 'string' } } } },
      attributes: {
        type: 'array',
        description: 'The variant axes, in the merchant\'s order (colour before size). A variant picker offers them in this order, each value in its `values` order.',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' }, values: { type: 'array', items: { type: 'string' } }, visible: { type: 'boolean' },
            display: { type: 'string', enum: ['swatch', 'buttons'], description: 'Draw this option\'s values as swatches. Absent (or `buttons` on write, which is stored as absent) = buttons. A picker also draws swatches when every value has one.' },
            swatches: {
              type: 'object',
              description: 'Per value (keys are entries of `values`): its swatch. A colour that is not a hex colour, or an image that is not a media reference, is refused with 400 on save rather than dropped.',
              additionalProperties: {
                type: 'object',
                properties: {
                  color: { type: 'string', pattern: '^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$', description: '`#rgb` or `#rrggbb` on write; stored and returned as lower-case `#rrggbb`.' },
                  image: { type: 'string', description: 'A media reference: `/uploads/...` on this CMS (join `meta.media_base`), or an https URL. Never a video.' },
                },
              },
            },
          },
        },
      },
      variants: {
        type: 'array',
        description: 'The purchasable variations (the most-read fields; ProductVariant in the TypeScript models lists every stored field). An order line for a product with variants must name one by `variant_id`. A disabled variant (`enabled: false`) cannot be ordered and a storefront should not offer it.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            options: { type: 'object', additionalProperties: { type: 'string' }, description: 'Attribute name to value, e.g. {"Colour":"Red","Size":"M"}.' },
            sku: { type: 'string' },
            price_cents: { type: 'integer', nullable: true, description: 'The variant\'s own price; null inherits the product\'s. Read `resolved.price_cents` for what a shopper pays.' },
            stock: { type: 'integer', nullable: true }, in_stock: { type: 'boolean' },
            image: { type: 'string' }, enabled: { type: 'boolean' },
            stock_status: { ...StockStatusInfo, readOnly: true, description: 'READ-ONLY. This variant\'s own availability; `purchasable` is the checkout\'s rule.' },
            resolved: {
              type: 'object',
              readOnly: true,
              description: 'READ-ONLY, derived on every read and never stored: what a shopper gets for THIS variant after inheriting from the product — the price the checkout will charge (sale window applied), and the SKU and image to show. A variant picker updates the page from this, never from its own arithmetic.',
              properties: {
                price_cents: { type: 'integer' }, regular_price_cents: { type: 'integer' }, on_sale: { type: 'boolean' },
                sku: { type: 'string' }, image: { type: 'string' },
              },
            },
          },
        },
      },
      downloadable: { type: 'boolean' },
      downloads: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, url: { type: 'string', description: 'STAFF ONLY — absent for every other reader. `https://…`, `/…` (own public media) or `private:pf_<id>` (a file from POST /api/downloads/upload, served only through a buyer\'s signed link).' } } } },
      download_limit: { type: ['integer', 'null'], description: 'Downloads per purchase. Absent/null = the shop default (downloads_limit_default); 0 = unlimited.' },
      download_expiry_days: { type: ['integer', 'null'], description: 'Days after payment the downloads work. Absent/null = the shop default (downloads_expiry_days_default, 90); 0 = never.' },
      status: { type: 'string', enum: ['active', 'draft', 'archived'] },
      type: { type: 'string', enum: ['simple', 'variable', 'grouped'], description: '`simple` and `variable` are derived from `variants` and any value sent for them is ignored. `grouped` is chosen: a grouped product shows the products in `grouped_product_ids` on one page and is never bought itself — POST /api/orders and /api/orders/quote refuse it as a line (`grouped-not-buyable`); add each member as its own line. A group has no price, sale, stock or variants of its own; those are forced on save. Leaving `grouped` needs a price in the same save (`group.price_required`).' },
      grouped_product_ids: { type: 'array', items: { type: 'string' }, maxItems: 10, description: 'A grouped product\'s members, in display order. Setting it needs 2 to 10; deleting members can leave fewer. Refused on save: duplicates, the product itself, unknown ids, a member that is itself grouped, and a NEW member that has variants. Deleting a product removes it from every group. A product that is a member cannot itself become a group. On a public read, narrowed to the members that reader can see.' },
      grouped_products: {
        type: 'array', description: 'READ-ONLY, grouped products only: the members resolved, in order. A public read skips draft, archived and hidden members; staff see them all with their `status` and `catalog_visibility`.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' }, name: { type: 'string' }, slug: { type: 'string' }, sku: { type: 'string' },
            type: { type: 'string', enum: ['simple', 'variable'], description: '`variable`: a member that gained variants after joining; choose an option on its own page.' },
            price_cents: { type: 'integer', description: 'Current price; the cheapest variant for a `variable` member.' },
            regular_price_cents: { type: 'integer' }, on_sale: { type: 'boolean' },
            stock_status: StockStatusInfo,
            image: { type: 'object', nullable: true, properties: { src: { type: 'string' }, alt: { type: 'string' } } },
            status: { type: 'string', enum: ['active', 'draft', 'archived'] },
            catalog_visibility: { type: 'string', enum: ['visible', 'catalog', 'search', 'hidden'] },
          },
        },
      },
      created_at: { type: 'string' }, updated_at: { type: 'string' },
    },
  };
  const ContentTypeDef = {
    type: 'object',
    required: ['name', 'label', 'fields'],
    properties: {
      name: { type: 'string', description: 'kebab-case; becomes /api/content/<name>' },
      label: { type: 'string' },
      labelPlural: { type: 'string' },
      visibility: { type: 'string', enum: ['public', 'staff'], description: 'Absent means staff — private until the author says otherwise.' },
      source: { type: 'string', enum: ['admin', 'plugin'], description: 'Read-only; which door the type came in through.' },
      fields: {
        type: 'array', maxItems: 40,
        items: {
          type: 'object',
          required: ['name', 'rule'],
          properties: {
            name: { type: 'string' },
            rule: { type: 'object', description: 'A validate() FieldRule: { type: string|number|boolean|id|slug|email|url|enum|array|date, optional?, min?, max?, values?, of? }' },
          },
        },
      },
    },
  }

const DeepHealth = {
    type: 'object',
    properties: {
      ok: { type: 'boolean', description: 'False when any essential check failed. Mirrors the 200/503 status.' },
      status: { type: 'string', enum: ['ok', 'warn', 'fail'] },
      now: { type: 'string', format: 'date-time' },
      failed: { type: 'array', items: { type: 'string' }, description: 'Names of the checks that failed.' },
      warnings: { type: 'array', items: { type: 'string' } },
      checks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', enum: ['image_pipeline', 'uploads_writable', 'public_site_url', 'database', 'rate_limit_store', 'plugins', 'media_records', 'email_channel', 'payment_return_urls'] },
            status: { type: 'string', enum: ['ok', 'warn', 'fail'] },
            detail: { type: 'string', description: 'One sentence an operator can act on.' },
            data: { type: 'object', description: 'Facts, never secrets. Environment variable NAMES appear here; values never do.' },
          },
        },
      },
    },
  }

const RedirectRule = {
    type: 'object',
    properties: {
      id: { type: 'string' },
      match: { type: 'string', description: 'Exact /old/page, prefix /old/*, or one wildcard segment /shop/*/reviews. Matched on the PATH only — a query string is never part of the match, because the whole problem is srsltid and gclid arriving on dead URLs.' },
      target: { type: 'string', description: 'Destination, with $1 standing for whatever the wildcard captured. Empty for a 410. The original query string is carried over unless the target has one of its own.' },
      status: { type: 'integer', enum: [301, 302, 410], description: '410 means gone for good: it carries no destination and is never served as a redirect.' },
      enabled: { type: 'boolean' },
      notes: { type: 'string' },
      hits: { type: 'integer', description: 'How many times the rule has fired. Counted in memory and flushed periodically, so it lags by up to 30 seconds.' },
      last_hit_at: { type: 'string', format: 'date-time' },
      created_at: { type: 'string', format: 'date-time' },
      updated_at: { type: 'string', format: 'date-time' },
    },
  }

  const NotFoundRecord = {
    type: 'object',
    properties: {
      path: { type: 'string' },
      hits: { type: 'integer' },
      paid_hits: { type: 'integer', description: 'Hits that arrived carrying a Google Shopping or Ads click id — money already spent, landing on nothing.' },
      first_seen: { type: 'string', format: 'date-time' },
      last_seen: { type: 'string', format: 'date-time' },
      sample_referrer: { type: 'string' },
      sample_params: { type: 'string' },
    },
  }

const ShippingMethod = {
    type: 'object',
    properties: {
      id: { type: 'string' }, name: { type: 'string' }, enabled: { type: 'boolean' },
      description: { type: 'string' },
      zone: {
        type: 'object',
        properties: {
          countries: { type: 'array', items: { type: 'string' }, description: 'ISO-2 codes, or ["*"] for anywhere.' },
          postcodes: { type: 'array', items: { type: 'string' }, description: 'Patterns: "84600" exact, "846*" prefix, "84000-84999" inclusive numeric range. Absent = the whole country. The most specific matching zone wins.' },
        },
      },
      rate: { type: 'object', description: 'One of {kind:"flat",amount_cents} | {kind:"weight",base_cents,per_kg_cents} | {kind:"free_over",threshold_cents,otherwise_cents}. Weight bills per STARTED kilogram.' },
      tax_class: { type: 'string' },
      min_weight_grams: { type: ['integer', 'null'] },
      max_weight_grams: { type: ['integer', 'null'] },
      position: { type: 'integer' },
    },
  } as const;

  const Coupon = {
    type: 'object',
    properties: {
      id: { type: 'string' }, code: { type: 'string' },
      kind: {
        type: 'string', enum: ['percent', 'fixed', 'bogo50', 'free_shipping', 'gift_product'],
        description: 'Accepted on write as `kind` or `type`. bogo50: in each pair of qualifying units (paired from most to least expensive, across lines) the cheaper is half price; an odd unit left over is full price; one unit alone is refused (coupon.not_applicable). free_shipping: shipping costs 0, nothing off the goods. gift_product: adds one unit of gift_product_id at price 0; refused when it is not in stock.',
      },
      value: { type: 'integer', description: 'Basis points for percent (1000 = 10%), minor units for fixed. 0 for the other kinds.' },
      enabled: { type: 'boolean' }, description: { type: 'string' },
      min_subtotal_cents: { type: ['integer', 'null'] },
      starts_at: { type: ['string', 'null'] },
      ends_at: { type: ['string', 'null'], description: 'Accepted on write as `ends_at` or `expires_at`.' },
      usage_limit: { type: ['integer', 'null'], description: 'Total uses. Accepted on write as `max_redemptions`.' },
      usage_limit_per_customer: { type: ['integer', 'null'], description: 'Uses per buyer email, counted atomically. Accepted on write as `max_redemptions_per_email`.' },
      used_count: { type: 'integer' },
      product_ids: { type: 'array', items: { type: 'string' } },
      category_slugs: { type: 'array', items: { type: 'string' }, description: 'Accepted on write as `categories` (or `conditions.categories`).' },
      brands: { type: 'array', items: { type: 'string' }, description: 'Only products of these brands, matched as ?brand= matches (Ray-Ban = RAYBAN = its published slug). Must hold IN ADDITION to product_ids/category_slugs.' },
      free_shipping: { type: 'boolean' },
      gift_product_id: { type: ['string', 'null'], description: 'For gift_product: a simple (non-variable) product.' },
      email: { type: ['string', 'null'], description: 'Bound to one buyer: validates only for this email, case-insensitively. Stored lower-case.' },
      single_use: { type: 'boolean', description: 'One redemption in total.' },
      revoked_at: { type: ['string', 'null'], description: 'Set when a plugin revoked it (read-only).' },
      source: { type: ['object', 'null'], description: '{ plugin, ref } when a plugin issued it through host.coupons.issue (read-only).' },
      automatic: { type: 'boolean' },
    },
  } as const;

  const Address = {
    type: 'object',
    description:
      'A postal address. Every field is optional: a counter order is a partial '
      + 'address and an order placed before structured addresses existed has none. '
      + 'country is ISO 3166-1 alpha-2 and a country NAME is refused rather than guessed.',
    properties: {
      name: { type: 'string' }, company: { type: 'string' },
      line1: { type: 'string' }, line2: { type: 'string' },
      city: { type: 'string' }, region: { type: 'string' },
      postcode: { type: 'string' },
      country: { type: 'string', minLength: 2, maxLength: 2 },
      phone: { type: 'string' },
      tax_id: { type: 'string', description: 'VAT identifier / ΑΦΜ. CAPTURED, never validated by the core, and never by itself a reason an order is refused. On billing_address (delivery address as fallback) it is what EU reverse charge reads when the shop has switched that on; a TAX_ID_VERDICT plugin may verify it (e.g. against VIES).' },
    },
  };
  // PLUGIN_HOOKS.ORDER_LINE_ADDONS — one shape for what a line request
  // sends and what a priced line carries back, used by the quote and the order.
  const LineAddon = {
    type: 'object',
    required: ['id', 'label', 'unit_price_cents'],
    properties: {
      id: { type: 'string', maxLength: 100 },
      label: { type: 'string', maxLength: 200, description: 'What a receipt prints.' },
      unit_price_cents: { type: 'integer', minimum: 0, description: 'Per unit of the line, in the currency of the order (or quote). ALREADY INSIDE the line total — never add it again.' },
      source: { type: 'string', description: 'The plugin that priced it.' },
      kind: { type: 'string' },
      namespace: { type: 'string', description: 'The request `addons` key it answers.' },
    },
  };
  const lineAddonsRequest = {
    type: 'object',
    maxProperties: 8,
    propertyNames: { pattern: '^[a-z][a-z0-9_-]{0,31}$' },
    additionalProperties: true,
    description: 'Priced add-on selections for this line, keyed by add-on type — e.g. `{ "lens": ["ar", "index-160"] }` for the optical module. Each value is the installed plugin\'s own selection format (JSON, at most 4 levels deep; the whole value at most 2048 bytes). Priced server-side by PLUGIN_HOOKS.ORDER_LINE_ADDONS and added to the line\'s unit price before coupons and tax. Refused with a 400 (never dropped) when the shape is wrong (reason checkout.addons_invalid), when no installed plugin handles add-ons (checkout.addons_unsupported), when a selection was not priced (checkout.addons_unpriced), or when the plugin refuses it (the plugin\'s own reason). null, [] or {} means nothing chosen.',
  };
  // Campaign attribution (commerce/attribution.ts). Known keys only, each capped.
  const AttributionTouch = {
    type: 'object',
    additionalProperties: false,
    required: ['at'],
    properties: {
      utm_source: { type: 'string', maxLength: 100, description: 'Lower-cased on save.' },
      utm_medium: { type: 'string', maxLength: 100, description: 'Lower-cased on save.' },
      utm_campaign: { type: 'string', maxLength: 100 },
      utm_term: { type: 'string', maxLength: 100 },
      utm_content: { type: 'string', maxLength: 100 },
      gclid: { type: 'string', maxLength: 200, pattern: '^[A-Za-z0-9._~-]+$' },
      fbclid: { type: 'string', maxLength: 200, pattern: '^[A-Za-z0-9._~-]+$' },
      msclkid: { type: 'string', maxLength: 200, pattern: '^[A-Za-z0-9._~-]+$' },
      at: { type: 'string', format: 'date-time', description: 'When the campaign visit happened. Not in the future, not older than 90 days.' },
    },
  };
  const OrderAttribution = {
    type: 'object',
    additionalProperties: false,
    description: 'First and last campaign touch. Kept ONLY with the visitor\'s marketing consent; absent otherwise. Personal data: exported with the order, removed by an erasure.',
    properties: { first: AttributionTouch, last: AttributionTouch },
  };
  const AttributionReport = {
    type: 'object',
    properties: {
      model: { type: 'string', enum: ['first', 'last'] },
      from: { type: 'string', format: 'date' },
      to: { type: 'string', format: 'date' },
      orders: { type: 'integer', description: 'Paid orders in the range.' },
      attributed: { type: 'integer' },
      unattributed: { type: 'integer', description: 'Paid orders with no attribution: no marketing consent, no campaign, or older than the feature.' },
      unattributed_revenue: { type: 'object', additionalProperties: { type: 'integer' }, description: 'Minor units, keyed by currency.' },
      rows: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            source: { type: 'string' }, medium: { type: 'string' }, campaign: { type: 'string' },
            currency: { type: 'string', description: 'The shop\'s base currency at the time of each order.' },
            orders: { type: 'integer' },
            revenue_cents: { type: 'integer', description: 'Minor units of `currency` (base_total_cents ?? total_cents).' },
          },
        },
      },
    },
  };
  const Order = {
    type: 'object',
    properties: {
      id: { type: 'string' }, number: { type: 'string' },
      status: { type: 'string', enum: ['pending', 'processing', 'on-hold', 'completed', 'cancelled', 'refunded', 'failed'] },
      currency: { type: 'string', description: 'PRESENTMENT currency — what the buyer was quoted and charged. Every *_cents field is minor units OF THIS currency.' },
      total_cents: { type: 'integer' },
      base_currency: { type: 'string', description: "The shop's base currency. Absent means it equals `currency`." },
      base_total_cents: { type: 'integer', description: 'Indicative accounting value at the frozen rate — NOT what settled; the acquirer converts at its own rate.' },
      base_tax_cents: { type: 'integer' },
      base_subtotal_cents: { type: 'integer' },
      fx_rate_ppm: { type: 'integer', description: 'The rate USED, frozen. Never re-converted: changing a rate must not rewrite what somebody was charged.' },
      fx_rate_at: { type: 'string' },
      fx_rate_stale: { type: 'boolean' },
      customer_id: { type: 'string' }, email: { type: 'string' }, name: { type: 'string' },
      phone: { type: 'string' },
      // The legacy one-line address, kept forever and re-rendered from
      // shipping_address on any order that has one.
      address: { type: 'string' },
      shipping_address: { $ref: '#/components/schemas/Address' },
      billing_address: { $ref: '#/components/schemas/Address' },
      note: { type: 'string' },
      terms_accepted: { type: 'boolean', description: 'What the buyer answered to "I agree to the Terms & Conditions" at checkout, frozen. ABSENT means unknown (an older order, an import, a staff-placed order) — never "accepted". `false` is an explicit refusal and can only be stored while the shop does not require acceptance.' },
      terms_accepted_at: { type: 'string', description: 'When the SERVER recorded the acceptance (ISO 8601). Present only with terms_accepted: true; never taken from the request.' },
      privacy_accepted: { type: 'boolean', description: 'Optional privacy-policy consent, recorded the same way. Never required.' },
      privacy_accepted_at: { type: 'string' },
      entitlements: { type: 'array', items: { $ref: '#/components/schemas/DownloadEntitlement' }, description: 'Download entitlements, one per paid line of a downloadable product. Absent when none. Written only by the downloads module.' },
      tags: { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 40 }, description: 'Staff-only labels ("VIP", "needs review"). Absent when the order has none. Never shown to a buyer. Written only by the tag routes — PUT /api/orders/{id} ignores it.' },
      attribution: OrderAttribution,
      items: { type: 'array', items: { type: 'object', properties: { product_id: { type: 'string' }, name: { type: 'string' }, qty: { type: 'integer' }, total_cents: { type: 'integer', description: 'The line total (qty × unit, add-ons included, before discount), frozen from the same priced line as the order totals; the lines sum to subtotal_cents (on a converted order, to within a cent per line of rounding).' }, addons: { type: 'array', items: LineAddon, description: 'Priced add-ons, frozen at purchase. Absent when none.' } } } },
      invoice_records: { type: 'array', items: { $ref: '#/components/schemas/InvoiceDocument' }, description: 'Invoice and credit-memo records (non-fiscal). Absent until the first. Written only through /api/orders/{id}/invoice-records and the payment, shipping and refund paths — PUT /api/orders/{id} ignores it.' },
      created_at: { type: 'string' }, updated_at: { type: 'string' },
    },
  };
  const InvoiceDocument = {
    type: 'object',
    description: 'A frozen, non-fiscal record of what an order charged (kind invoice) or what a refund gave back (kind credit_memo). Money in minor units of `currency`.',
    properties: {
      id: { type: 'string' }, kind: { type: 'string', enum: ['invoice', 'credit_memo'] },
      order_id: { type: 'string' },
      status: { type: 'string', enum: ['draft', 'final', 'cancelled'] },
      state: { type: 'string', enum: ['draft', 'final', 'cancelled', 'issuing', 'issued', 'issue_failed', 'issued_elsewhere'], description: 'Derived; present in the invoice-records responses.' },
      trigger: { type: 'string', enum: ['paid', 'shipped', 'manual'] },
      created_at: { type: 'string' }, finalised_at: { type: 'string' },
      currency: { type: 'string' }, prices_include_tax: { type: 'boolean' },
      seller: { type: 'object' }, buyer: { type: 'object', description: 'Includes tax_id as captured — never validated by core.' },
      lines: { type: 'array', items: { type: 'object', properties: {
        kind: { type: 'string', enum: ['goods', 'shipping'] }, description: { type: 'string' }, qty: { type: 'integer' },
        net_cents: { type: 'integer' }, tax_rate_bp: { type: 'integer' }, tax_cents: { type: 'integer' }, total_cents: { type: 'integer' },
        invoice_line: { type: 'integer', description: 'Credit memos: the invoice-record line it credits.' },
        tax_treatment: { type: 'string', enum: ['standard', 'reverse-charge', 'export', 'exempt'], description: 'Frozen from the priced order at finalise. ABSENT means core cannot tell (e.g. a 0% line with nothing stamped) — never assume standard.' },
        tax_jurisdiction: { type: 'string', description: 'ISO country whose VAT table priced the line, when not the shop\'s own.' },
      } } },
      vat: { type: 'array', items: { type: 'object', properties: { rate_bp: { type: 'integer' }, base_cents: { type: 'integer' }, tax_cents: { type: 'integer' } } } },
      vat_complete: { type: 'boolean', description: 'False when the order had no per-line VAT breakdown that reconciles to what was charged.' },
      net_cents: { type: 'integer' }, tax_cents: { type: 'integer' }, total_cents: { type: 'integer' },
      invoice_record_id: { type: 'string' }, refund_id: { type: 'string' },
      issuer: { type: 'object', properties: {
        id: { type: 'string' },
        status: { type: 'string', enum: ['issuing', 'issued', 'failed', 'declined'], description: 'declined: every issuer asked said "not mine"; the record is treated as with no issuer (state stays final).' },
        number: { type: 'string' }, identifiers: { type: 'object', additionalProperties: { type: 'string' } }, issued_at: { type: 'string' }, error: { type: 'string' }, attempted_at: { type: 'string' },
        key: { type: 'string', description: 'The idempotency key of every attempt at this record.' },
        attempts: { type: 'integer' },
        retryable: { type: 'boolean', description: 'failed only: retried automatically, with backoff, at next_attempt_at.' },
        next_attempt_at: { type: 'string' },
        declined: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, reason: { type: 'string' } } } },
        late: { type: 'boolean', description: 'issued only: the success arrived after core stopped waiting.' },
      } },
      issued_externally: { type: 'object', properties: { at: { type: 'string' }, actor: { type: 'string' }, number: { type: 'string' } } },
      internal_reference: { type: 'string', description: 'The shop\'s own bookkeeping counter. NOT an invoice number.' },
    },
  };
  const InvoiceRecordList = {
    type: 'object',
    properties: {
      id: { type: 'string' },
      record: { $ref: '#/components/schemas/InvoiceDocument' },
      records: { type: 'array', items: { $ref: '#/components/schemas/InvoiceDocument' } },
      record_on: { type: 'string', enum: ['paid', 'shipped', 'manual'] },
      issuer: { type: ['object', 'null'], properties: { id: { type: 'string' }, label: { type: 'string' } } },
      issuer_chain: { type: 'array', description: 'The issuers asked, in order; the next is asked only when the one before declines a record.', items: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' } } } },
      issuer_problem: { type: 'string' },
    },
  };
  const DownloadEntitlement = {
    type: 'object',
    description: 'One paid order line\'s right to download its product\'s files. Granted when the order reaches processing/completed; revoked on cancel/refund (lifted if the order is reopened) or by staff.',
    properties: {
      id: { type: 'string', example: 'ent_0123456789abcdef01234567' },
      line: { type: 'integer', description: 'Index of the order line.' },
      product_id: { type: 'string' },
      name: { type: 'string' },
      files: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, url: { type: 'string' } } }, description: 'Frozen at grant. A download prefers the product\'s current file of the same name.' },
      download_limit: { type: ['integer', 'null'], description: 'null = unlimited.' },
      download_count: { type: 'integer' },
      expires_at: { type: ['string', 'null'], description: 'null = never.' },
      granted_at: { type: 'string' },
      revoked_at: { type: 'string' },
      revoked_reason: { type: 'string', enum: ['refunded', 'cancelled', 'staff', 'erased'] },
      log: { type: 'array', description: 'The newest 50 downloads. `ip` is removed by an erasure.', items: { type: 'object', properties: { at: { type: 'string' }, file: { type: 'string' }, ip: { type: 'string' } } } },
      state: { type: 'string', enum: ['active', 'expired', 'exhausted', 'revoked', 'inactive'], description: 'Derived on read. `inactive` = the order does not grant downloads right now.' },
      remaining: { type: ['integer', 'null'] },
    },
  };
  const BuyerDownload = {
    type: 'object',
    properties: {
      name: { type: 'string' },
      state: { type: 'string', enum: ['active', 'expired', 'exhausted', 'revoked', 'inactive'] },
      files: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, href: { type: ['string', 'null'], description: 'A signed link to GET /api/downloads/{token}; null unless active. Never the file\'s location.' } } } },
      remaining: { type: ['integer', 'null'] },
      limit: { type: ['integer', 'null'] },
      expires_at: { type: ['string', 'null'] },
    },
  };
  const OrderTagList = {
    type: 'object',
    properties: {
      id: { type: 'string' },
      tags: { type: 'array', items: { type: 'object', properties: { tag: { type: 'string' }, color: { type: 'string', enum: ['red', 'orange', 'amber', 'green', 'teal', 'blue', 'indigo', 'purple', 'pink', 'gray'], description: 'Derived from the tag, never stored: the same tag is the same colour everywhere.' } } } },
      max: { type: 'integer', description: 'The most tags one order may carry (10).' },
    },
  };
  const OrderTimelineItem = {
    type: 'object',
    properties: {
      id: { type: 'string' },
      at: { type: 'string', description: 'When it happened (ISO 8601).' },
      event: { type: 'string', description: 'Dotted code: order.placed, status.changed, payment.captured | failed | refunded | declined | started | needs_refund, refund.issued, shipment.shipped | tracking_updated, note.staff_updated | staff_cleared | customer_edited | comment, tags.changed, tax.override, order.abandoned, order.hold_expired, email.recovery_sent, consent.*, or bulk.<action>. Branch on this, never on a label.' },
      category: { type: 'string', enum: ['status', 'payments', 'shipments', 'notes', 'other'], description: 'The filter this event belongs to.' },
      actor: { type: ['string', 'null'], description: 'A user id, `provider`, `system[:job]`, `customer`, or null when the order does not record who (an order posted before shipments were recorded here).' },
      actor_kind: { type: 'string', enum: ['staff', 'system', 'provider', 'customer', 'unknown'] },
      actor_name: { type: ['string', 'null'], description: 'The staff member\'s name (or e-mail) for a user id; null otherwise.' },
      from: { type: 'string', description: 'status.changed: the previous status.' },
      to: { type: 'string', description: 'status.changed: the new status.' },
      amount_cents: { type: 'integer', description: 'Payments and refunds: minor units of `currency`. Always positive; the event says which way the money went.' },
      currency: { type: 'string' },
      text: { type: 'string', description: 'A note or comment a person typed, a carrier, a payment method, a tax-override reason. Free text: render it as text.' },
      added: { type: 'array', items: { type: 'string' }, description: 'tags.changed: tags added.' },
      removed: { type: 'array', items: { type: 'string' }, description: 'tags.changed: tags removed.' },
      ref: { type: 'string', description: 'A tracking number or refund id.' },
      count: { type: 'integer', description: 'payment.declined: how many attempts were declined.' },
      derived: { type: 'boolean', description: 'True when computed from the order\'s own fields at read time; false when it was stored.' },
    },
  };
  const spec = {
    openapi: '3.1.0',
    info: {
      title: 'AstroBaaS API',
      version: '0.1.0',
      description: 'HTTP API for the AstroBaaS backend. See /llms.txt for an agent brief.',
    },
    servers: [{ url: base }],
    components: {
      securitySchemes: {
        bearerApiKey: { type: 'http', scheme: 'bearer', description: 'API key minted at POST /api/keys.' },
      },
      schemas: { Post, Product, Order, OrderTagList, OrderAttribution, AttributionReport, DownloadEntitlement, BuyerDownload, InvoiceDocument, InvoiceRecordList, OrderTimelineItem, Address, ShippingMethod, Coupon, DeepHealth, RedirectRule, NotFoundRecord, ContentTypeDef },
    },
    paths: {
      '/api/posts': {
        get: {
          summary: 'List posts (published for anonymous; all with auth)',
          parameters: [
            { name: 'status', in: 'query', schema: { type: 'string' } },
            {
              name: 'kind', in: 'query',
              schema: { type: 'string', enum: ['post', 'page', 'all'] },
              description: 'Defaults to articles only, so an existing storefront response never changes when pages are added. Use "page" for pages only or "all" for both.',
            },
            { name: 'category', in: 'query', schema: { type: 'string' } },
            {
              name: 'author', in: 'query', schema: { type: 'string' },
              description: 'Narrow to one author id (C-153). `authorId` already reached both storage drivers — the admin\'s "my posts" view uses it — and was simply never exposed, so an author archive had no way to ask for one person\'s posts without pulling the whole collection.',
            },
            { name: 'limit', in: 'query', schema: { type: 'integer' }, description: 'Page size (max 200).' },
            { name: 'offset', in: 'query', schema: { type: 'integer' }, description: 'Items to skip.' },
            { name: 'page', in: 'query', schema: { type: 'integer' }, description: '1-based page (with limit). Response meta carries total/hasMore.' },
          ],
          responses: { '200': ok({ type: 'array', items: { $ref: '#/components/schemas/Post' } }) },
        },
        post: {
          summary: 'Create a post',
          security: [{ bearerApiKey: [] }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', properties: { title: { type: 'string' }, content: { type: 'string' }, status: { type: 'string' }, kind: { type: 'string', enum: ['post', 'page'] } }, required: ['title'] } } },
          },
          responses: { '201': ok({ $ref: '#/components/schemas/Post' }), '401': { description: 'Unauthorized' } },
        },
      },
      '/api/posts/{ref}': {
        get: {
          summary: 'Get a post by slug or id',
          parameters: [{ name: 'ref', in: 'path', required: true, schema: { type: 'string' }, description: 'Post slug or id.' }],
          responses: { '200': ok({ $ref: '#/components/schemas/Post' }), '404': { description: 'Not found' } },
        },
        put: {
          summary: 'Update a post (partial)',
          security: [{ bearerApiKey: [] }],
          parameters: [{ name: 'ref', in: 'path', required: true, schema: { type: 'string' }, description: 'Post slug or id.' }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { title: { type: 'string' }, content: { type: 'string' }, status: { type: 'string' } } } } } },
          responses: { '200': ok({ $ref: '#/components/schemas/Post' }), '401': { description: 'Unauthorized' }, '403': { description: 'Forbidden' }, '404': { description: 'Not found' } },
        },
        delete: {
          summary: 'Delete a post',
          security: [{ bearerApiKey: [] }],
          parameters: [{ name: 'ref', in: 'path', required: true, schema: { type: 'string' }, description: 'Post slug or id.' }],
          responses: { '200': ok({ type: 'null' }), '401': { description: 'Unauthorized' }, '403': { description: 'Forbidden' }, '404': { description: 'Not found' } },
        },
      },
      '/api/email-templates': {
        get: {
          summary: 'The email templates plus whatever this install has customised, each with a server-rendered preview (C-112). Admin only: these emails carry password resets and sign-in links, so rewording them is the ability to phrase a phishing message in the site\u2019s own voice from the site\u2019s own address.',
          responses: {
            '200': ok({ type: 'object', properties: { templates: { type: 'array', items: { type: 'object' } } } }),
            '403': errRes('Not an admin'),
          },
        },
        put: {
          summary: 'Save one template\u2019s wording. Validated by the SAME function the renderer validates with, so "it saved" and "it will be used" cannot come apart. A body missing a REQUIRED placeholder is refused with the reason \u2014 a password reset without its link sends, looks fine, and is useless.',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['id', 'subject'], properties: { id: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } } } } },
          },
          responses: {
            '200': ok({ type: 'object', properties: { id: { type: 'string' }, preview: { type: 'object' } } }),
            '400': errRes('Empty, over-long, a line break in the subject, an unknown placeholder, or a missing required one'),
            '403': errRes('Not an admin'),
            '404': errRes('No such template'),
          },
        },
        delete: {
          summary: 'Go back to the built-in wording. Clears the stored override rather than writing a copy of the default, so a later improvement to the built-in text reaches this install.',
          parameters: [{ name: 'id', in: 'query', required: true, schema: { type: 'string' } }],
          responses: {
            '200': ok({ type: 'object', properties: { id: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } } }),
            '403': errRes('Not an admin'),
            '404': errRes('No such template'),
          },
        },
      },
      '/api/users/switch': {
        post: {
          summary: 'Act as another user, for support and debugging (C-141). Admin only, never onto another admin, refused while already switched, and time-boxed to an hour. Issues a session for the target plus a signed switch-back cookie holding the admin\u2019s id and session version. Both directions are audited with the real admin as the actor \u2014 actions taken WHILE switched are audited as the impersonated user, and those two bracket entries are what attributes the window to a person.',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['user_id'], properties: { user_id: { type: 'string' } } } } },
          },
          responses: {
            '200': ok({ type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, role: { type: 'string' } } }),
            '400': errRes('Missing user_id, already switched, yourself, or an inactive account'),
            '401': errRes('No session'),
            '403': errRes('Not an admin, or the target is an admin'),
            '404': errRes('No such user'),
          },
        },
        delete: {
          summary: 'Stop acting as another user. Deliberately NOT admin-gated: the caller is currently the impersonated user, whose role is not admin \u2014 possession of the signed switch-back cookie is the authorisation, and it names exactly one account. The admin\u2019s status, role and session version are re-checked before the session is handed back, so an admin deactivated or demoted mid-switch is sent to the login page instead.',
          responses: {
            '200': ok({ type: 'object', properties: { id: { type: 'string' }, role: { type: 'string' } } }),
            '400': errRes('Not currently acting as anyone'),
            '403': errRes('The original session is no longer valid'),
          },
        },
      },
      '/api/taxonomies': {
        get: {
          summary: 'Operator-defined groupings and their terms (C-128). Any signed-in user. Pass `collection` to get per-term record counts for that collection specifically \u2014 "how many posts" and "how many products" are different questions and one number adding them together answers neither.',
          parameters: [{ name: 'collection', in: 'query', schema: { type: 'string' }, description: '`post`, `page`, or a content type name.' }],
          responses: {
            '200': ok({ type: 'object', properties: { taxonomies: { type: 'array', items: { type: 'object' } }, terms: { type: 'array', items: { type: 'object' } }, counts: { type: 'object' } } }),
            '401': errRes('No session'),
          },
        },
        put: {
          summary: 'Replace the taxonomy definitions. Admin only \u2014 this changes what every editor sees on every record, like a content-type change, and is audited for the same reason. The WHOLE set is sent, because duplicate-slug and count rules are properties of the set and a patch cannot express a removal. Removing a taxonomy rewrites NO records: assignments simply stop being read, and return if it is defined again.',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['taxonomies'], properties: { taxonomies: { type: 'array', items: { type: 'object', required: ['slug', 'label', 'appliesTo'], properties: { slug: { type: 'string' }, label: { type: 'string' }, labelPlural: { type: 'string' }, appliesTo: { type: 'array', items: { type: 'string' } }, publicArchive: { type: 'boolean' } } } } } } } },
          },
          responses: {
            '200': ok({ type: 'object', properties: { taxonomies: { type: 'array', items: { type: 'object' } } } }),
            '400': errRes('A reserved or duplicate slug, a missing label, one that applies to nothing, or too many'),
            '403': errRes('Not an admin'),
          },
        },
        post: {
          summary: 'Add a term. Open to anyone who may write content \u2014 it is the same act as typing a category, and gating it on admin would mean the person stocking shelves has to ask somebody else to add a brand. Idempotent: two editors adding the same term at once both succeed.',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['taxonomy', 'name'], properties: { taxonomy: { type: 'string' }, name: { type: 'string' }, slug: { type: 'string', description: 'Derived from the name when omitted. Greek and Cyrillic letters are valid.' }, description: { type: 'string' } } } } },
          },
          responses: {
            '201': ok({ type: 'object', properties: { taxonomy: { type: 'string' }, slug: { type: 'string' }, name: { type: 'string' } } }),
            '400': errRes('No name, or a name that produces no usable slug'),
            '403': errRes('The role cannot write content'),
            '404': errRes('No such taxonomy'),
          },
        },
        delete: {
          summary: 'Remove a term. Admin only. Deletes the TERM RECORD and nothing else \u2014 records keep their assignment, which simply stops being read, so re-creating the term brings them straight back. Rewriting four hundred posts here would be a migration disguised as a button.',
          parameters: [
            { name: 'taxonomy', in: 'query', required: true, schema: { type: 'string' } },
            { name: 'term', in: 'query', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '200': ok({ type: 'object', properties: { taxonomy: { type: 'string' }, slug: { type: 'string' } } }),
            '400': errRes('Missing taxonomy or term'),
            '403': errRes('Not an admin'),
            '404': errRes('No such term'),
          },
        },
      },
      '/api/transfer/{collection}': {
        get: {
          summary: 'Export a collection as CSV or JSON (C-91). `{collection}` is `post`, `page`, or the name of any registered content type — one route rather than one per collection, so an exporter and an importer cannot drift apart. The CSV carries a UTF-8 BOM (without it Excel reads Greek titles as mojibake) and defuses formula cells, so opening your own export in a spreadsheet is not an attack surface. The view counter and created_at are deliberately absent: a re-import would reset them. Requires a session that may author posts.',
          parameters: [
            { name: 'collection', in: 'path', required: true, schema: { type: 'string' }, description: '`post`, `page`, or a registered content type name.' },
            { name: 'format', in: 'query', schema: { type: 'string', enum: ['csv', 'json'] }, description: 'Defaults to csv.' },
          ],
          responses: {
            '200': { description: 'The collection as a file download.', content: { 'text/csv': { schema: { type: 'string' } }, 'application/json': { schema: { type: 'object' } } } },
            '401': errRes('No session'),
            '403': errRes('The role cannot export content'),
            '404': errRes('No such collection'),
          },
        },
        post: {
          summary: 'Import a CSV or JSON file into a collection (C-91). PREVIEWS by default: without `apply: true` it returns what each row would do and why any row would be skipped, computed by the identical function that then performs it. Rows are matched on slug (or id), never on position, so a file the operator sorted still imports correctly; an id that matches nothing on this install is refused rather than duplicated. A new record for `page` is created as a page because the ROUTE says so, never because a column did. Requires the `import_content` capability, the same gate the WordPress importer uses, and is audited.',
          parameters: [{ name: 'collection', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['body'], properties: { body: { type: 'string', description: 'The file\u2019s contents.' }, format: { type: 'string', enum: ['csv', 'json'] }, apply: { type: 'boolean', description: 'Omit or false to preview. True writes.' } } } } },
          },
          responses: {
            '200': ok({ type: 'object', properties: { creates: { type: 'integer' }, updates: { type: 'integer' }, skipped: { type: 'integer' }, created: { type: 'integer' }, updated: { type: 'integer' }, unknownColumns: { type: 'array', items: { type: 'string' } }, rows: { type: 'array', items: { type: 'object' } } } }),
            '400': errRes('Empty, unreadable, or over the row limit'),
            '401': errRes('No session'),
            '403': errRes('The role cannot import content'),
            '404': errRes('No such collection'),
          },
        },
      },
      '/api/content/changes': {
        get: {
          summary: 'The change feed: what changed, newest first, one bounded page at a time',
          description:
            'Public and anonymous — the revalidation feed a headless storefront polls. Entries are ordered by (timestamp, id) descending, so the order is total even when a bulk import writes many changes in one millisecond. '
            + 'Poll with `since` (the newest `timestamp` you have processed); follow `meta.next_cursor` while `meta.has_more` is true. Revalidation is idempotent, so overlapping a poll window is harmless and a gap is not: when in doubt, ask from a little earlier. '
            + 'Anonymous and non-editorial callers get metadata only — id, entity_type, entity_id, action, timestamp, and `fields` (the names an update touched, when known; never for users) — and only for types they may read: core content, products while the shop is on, and custom collections declared `visibility: "public"`. Order events are staff-only. Editors and admins also get each entry\'s `changes` snapshot. '
            + 'At most 1,000 entries are retained on every storage driver, counted across EVERY type — including types a caller is not shown — so a count of what a walk returned says nothing about whether the window overflowed. `meta.truncated` does: it is true when retention evicted a change the caller would have been shown inside its window (after `since`, or anywhere when `since` is absent). Read it from the last page of a walk, which also covers pruning during the walk, and revalidate everything when it is true.',
          security: [{ bearerApiKey: [] }, {}],
          parameters: [
            {
              name: 'since', in: 'query', schema: { type: 'string', format: 'date-time' },
              description: 'Only changes strictly after this instant. Optional: omitted, the newest page is returned (never a 400). Any ISO-8601 form is accepted and compared as an instant; a date-time with no zone designator is read as UTC.',
            },
            {
              name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 1000, default: 1000 },
              description: 'Page size. Defaults to the retention cap, so a client that does not page receives the whole retained window, exactly as before paging existed. Out-of-range or unreadable values are clamped, not refused.',
            },
            {
              name: 'cursor', in: 'query', schema: { type: 'string' },
              description: 'Opaque. `meta.next_cursor` from the previous page, passed back unchanged; the next page holds strictly older entries. A malformed cursor is a 400, so a paging client can never be silently restarted from the top.',
            },
          ],
          responses: {
            '200': {
              description: 'One page. `meta` carries `since` (as sent), `count`, `now`, `limit`, `has_more`, `next_cursor` (null on the last page) and `truncated`.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean' },
                      data: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            id: { type: 'string' },
                            entity_type: { type: 'string' },
                            entity_id: { type: 'string' },
                            action: { type: 'string', enum: ['create', 'update', 'delete'] },
                            timestamp: { type: 'string', format: 'date-time' },
                            fields: { type: 'array', items: { type: 'string' }, description: 'Update only, when known. Absent means "unknown — assume everything changed", never "nothing".' },
                            changes: { description: 'Editorial callers only: the entity snapshot recorded with the change.' },
                          },
                          required: ['id', 'entity_type', 'entity_id', 'action', 'timestamp'],
                        },
                      },
                      meta: {
                        type: 'object',
                        properties: {
                          since: { type: ['string', 'null'] },
                          count: { type: 'integer' },
                          now: { type: 'string', format: 'date-time' },
                          limit: { type: 'integer' },
                          has_more: { type: 'boolean' },
                          next_cursor: { type: ['string', 'null'] },
                          truncated: {
                            type: 'boolean',
                            description: 'True when retention has evicted a change this caller would have been shown, inside the window it asked for — the window is incomplete, so revalidate everything. Only the caller\'s own types count. Read it from the last page of a walk.',
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            '400': errRes('A cursor that was not produced by this endpoint'),
          },
        },
      },
      '/api/content/{type}': {
        get: {
          summary: 'List custom content entities',
          parameters: [
            { name: 'type', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 200 } },
            { name: 'offset', in: 'query', schema: { type: 'integer' } },
            { name: 'page', in: 'query', schema: { type: 'integer' } },
            {
              name: 'where.{field}', in: 'query', schema: { type: 'string' },
              description:
                'Narrow to records whose DECLARED field holds this value, compared as a string — e.g. `?where.post_id=abc`. Only declared fields: a filter cannot probe `_status` or any other key the server sets and reads as authority. An array field matches if any item does. A field the type marks `private` (the author email) is not filterable by anyone who may not read it, and is ignored like an unknown name. An unknown field name is ignored rather than refused, so a storefront sending a stale filter gets the unfiltered list instead of a page that will not render — it cannot leak, because a filter only ever narrows what the caller could already see. On a MODERATED type the approval filter is applied first, so this never widens visibility.',
            },
          ],
          responses: { '200': ok({ type: 'array', items: { type: 'object' } }) },
        },
        post: {
          summary: 'Create a custom content entity, or submit a public form',
          description:
            'Admin/editor by default. A type that declares writable: "public" also accepts ANONYMOUS submissions — this is what turns a content type into a form. A public submission is protected by a honeypot field (hp_url, left empty by humans), the local proof-of-work check when it is enabled for the "forms" surface (pow_token), and a per-address submission limit; it is answered with the new id and nothing else, so a form that anyone may write and only staff may read gives a submitter no way to read what others sent. Fields the type never declared are dropped rather than stored, and submitted_at is set by the server. A type that has NOT opted in answers 404 to an anonymous caller — the same 404 an unknown type gets, so the endpoint cannot be used to discover which collections exist.',
          security: [{ bearerApiKey: [] }, {}],
          parameters: [{ name: 'type', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  description: 'The type\'s declared fields, plus the two form-only fields below.',
                  properties: {
                    hp_url: { type: 'string', description: 'Honeypot. Leave empty; a filled one is answered like success and stored nowhere.' },
                    pow_token: { type: 'string', description: 'Proof-of-work answer from /api/captcha/challenge?surface=forms, when the check is enabled.' },
                  },
                },
              },
            },
          },
          responses: {
            '201': ok({ type: 'object', properties: { id: { type: 'string' } } }),
            '401': { description: 'Unauthorized' },
            '404': { description: 'No such type — or it does not accept public submissions' },
            '429': { description: 'Too many submissions from this address' },
          },
        },
      },
      '/api/keys': {
        get: {
          summary: 'List API keys (admin; metadata only, never the secret)',
          security: [{ bearerApiKey: [] }],
          responses: { '200': ok({ type: 'array', items: { type: 'object' } }) },
        },
        post: {
          summary: 'Mint an API key (admin; secret returned once)',
          description: 'Optional `scopes` (e.g. ["posts:write"]) restrict the key to resource:action capabilities (`<resource>:<read|write|*>`, or a named action: `game:play`, `coupons:validate` — POST /api/orders/quote only — `stats:read`; actions are per resource, so `game:read` is refused); omit for full role-based access. On any API-key request, `X-Client-IP` / `X-Client-UA` name the shopper for plugin routes (`ctx.client`); they are ignored on anonymous and cookie requests. `expires_in_days` sets an expiry. `forward_client_ip: true` lets the key\'s server name the shopper a request is for in `X-AstroBaaS-Client-IP` (one address), which per-IP route limits and order risk then use; the header is ignored on every other request.',
          security: [{ bearerApiKey: [] }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, role: { type: 'string' }, scopes: { type: 'array', items: { type: 'string' } }, expires_in_days: { type: 'integer' }, forward_client_ip: { type: 'boolean' } }, required: ['name'] } } },
          },
          responses: { '201': ok({ type: 'object', properties: { id: { type: 'string' }, key: { type: 'string' }, scopes: { type: 'array', items: { type: 'string' } }, expires_at: { type: 'string' }, forward_client_ip: { type: 'boolean' } } }) },
        },
      },
      '/api/keys/{id}': {
        patch: {
          summary: 'Turn trusted client-IP forwarding on or off for a key (admin)',
          security: [{ bearerApiKey: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', properties: { forward_client_ip: { type: 'boolean' } }, required: ['forward_client_ip'] } } },
          },
          responses: { '200': ok({ type: 'object' }), '404': { description: 'Not found' } },
        },
        delete: {
          summary: 'Revoke an API key (admin)',
          security: [{ bearerApiKey: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': ok({ type: 'null' }), '404': { description: 'Not found' } },
        },
      },
      '/api/keys/{id}/rotate': {
        post: {
          summary: 'Rotate an API key secret in place (admin; new secret returned once)',
          security: [{ bearerApiKey: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': ok({ type: 'object', properties: { id: { type: 'string' }, key: { type: 'string' } } }), '404': { description: 'Not found' } },
        },
      },
      '/api/webhooks': {
        get: {
          summary: 'List registered webhooks (admin; secrets omitted)',
          security: [{ bearerApiKey: [] }],
          responses: { '200': ok({ type: 'array', items: { type: 'object' } }) },
        },
        post: {
          summary: 'Register a webhook (admin; signing secret returned once)',
          description:
            'Deliveries POST to the URL with X-AstroBaaS-Signature: sha256=<hex>, hex = HMAC-SHA256(secret, rawBody). Events: post.created|updated|deleted, content.created|updated|deleted; "*" and "prefix.*" wildcards supported.',
          security: [{ bearerApiKey: [] }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', properties: { url: { type: 'string', format: 'uri' }, events: { type: 'array', items: { type: 'string' } }, active: { type: 'boolean' } }, required: ['url', 'events'] } } },
          },
          responses: { '201': ok({ type: 'object', properties: { id: { type: 'string' }, url: { type: 'string' }, events: { type: 'array', items: { type: 'string' } }, secret: { type: 'string' } } }) },
        },
      },
      '/api/auth/me': {
        get: {
          summary: 'The principal the current credential resolves to',
          description: 'Works for both auth schemes. A cookie session returns the user (type:"user", secrets stripped); a bearer key returns a synthetic principal (type:"apikey").',
          security: [{ bearerApiKey: [] }],
          responses: { '200': ok({ type: 'object' }) },
        },
      },
      '/api/search': {
        get: {
          summary: 'Search published posts (public). Products are searched with GET /api/products?search=',
          parameters: [
            { name: 'q', in: 'query', schema: { type: 'string' } },
            {
              name: 'sort', in: 'query', required: false,
              schema: { type: 'string', enum: ['relevance', 'newest', 'name_asc', 'name_desc'], default: 'relevance' },
              description: 'Order of the (at most 20) results, applied to the whole match set before the top 20 are cut. Posts have no price, so `price_asc`/`price_desc` are **422**, as is any unknown value — never silently ignored. Echoed in `meta.sort`.',
            },
          ],
          responses: { '200': ok({ type: 'array', items: { type: 'object' } }), '422': { description: 'Unknown or inapplicable sort.' } },
        },
      },
      '/api/contact': {
        post: {
          summary: 'Submit the contact form (anonymous, CSRF-protected, rate-limited)',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['name', 'email', 'message'], properties: { name: { type: 'string' }, email: { type: 'string' }, subject: { type: 'string' }, message: { type: 'string' } } } } },
          },
          responses: { '201': ok({ type: 'object' }) },
        },
      },
      '/api/newsletter': {
        post: {
          summary: 'Ask to subscribe (anonymous, CSRF-protected, rate-limited)',
          description:
            'DOUBLE OPT-IN: this stores NOTHING. It emails a signed, single-purpose, '
            + 'seven-day link to the address given, and the address joins the list only when '
            + 'that link is opened. An unconfirmed address is never written anywhere, so the '
            + 'shop never holds a record about somebody who did not ask — which is both the '
            + 'anti-abuse property (you cannot subscribe a stranger) and the lawful-basis one. '
            + 'The 201 is returned whether or not the address is already subscribed and whether '
            + 'or not the mail went out, so this cannot be used to ask "is this person on your list?". '
            + 'A storefront that shows its own consent wording sends it as `consent_text` with a '
            + '`consent_version` label (both or neither); its sha256 rides in the signed link and is '
            + 'written to the consent ledger when the link is clicked. Without them the default '
            + 'core wording is recorded.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['email'],
                  properties: {
                    email: { type: 'string' },
                    consent_text: { type: 'string', maxLength: 5000, description: 'The exact wording the visitor was shown. Hashed, never stored.' },
                    consent_version: { type: 'string', maxLength: 64 },
                  },
                },
              },
            },
          },
          responses: { '201': ok({ type: 'object' }) },
        },
      },
      '/api/newsletter/unsubscribe': {
        get: {
          summary: 'Leave the mailing list (public, token-authorised)',
          description:
            'Opened from the unsubscribe link every outgoing newsletter carries. Public and '
            + 'token-authorised for the same reasons as the confirmation route, and the token has '
            + 'a DIFFERENT signing purpose so a confirmation link — which an attacker who guessed '
            + 'an address could cause to be sent — cannot be replayed to unsubscribe somebody. '
            + 'Valid for a year, deliberately: an expired unsubscribe link is worse than useless, '
            + 'because the only remaining option a trapped recipient has is to mark the message as '
            + 'spam, which costs the shop its deliverability for everyone. Idempotent, removes '
            + 'EVERY matching row (no driver enforces uniqueness), and answers the same way whether '
            + 'the address was on the list or not — telling a caller otherwise would turn this into '
            + 'a way to ask who is subscribed.',
          parameters: [
            { name: 'token', in: 'query', required: true, schema: { type: 'string' } },
          ],
          responses: { '302': { description: 'Redirect to /newsletter/unsubscribed' } },
        },
        post: {
          summary: 'One-click unsubscribe, RFC 8058 (public, token-authorised)',
          description:
            'What Gmail and Outlook call when a reader presses the Unsubscribe button they show '
            + 'at the top of a message. Every campaign carries `List-Unsubscribe-Post: '
            + 'List-Unsubscribe=One-Click`, which is what makes that button appear; the sender '
            + 'then POSTs the List-Unsubscribe URL verbatim, so the token stays in the QUERY '
            + 'string and the body carries only `List-Unsubscribe=One-Click`. Answers a bare 200 '
            + 'rather than a redirect, because no human is looking and a 302 to an HTML page is at '
            + 'best ignored. Exempt from CSRF because the caller is mail infrastructure that '
            + 'cannot hold a cookie — the signed, single-purpose, expiring token is the '
            + 'authentication. Returns 200 for a missing or invalid token too: a machine cannot '
            + 'act on the difference, and a different answer would reveal whether an address is on '
            + 'the list.',
          parameters: [
            { name: 'token', in: 'query', required: true, schema: { type: 'string' } },
          ],
          responses: { '200': { description: 'Accepted; the address is removed if the token named one' } },
        },
      },
      '/api/newsletter/subscribers/delete': {
        post: {
          summary: 'Remove one subscriber (staff)',
          description:
            'Takes one person off the mailing list without the GDPR erasure, which also deletes '
            + 'their customer record, every contact message they sent and their email log. '
            + '"Please stop emailing me" should not cost somebody their order history, and the '
            + 'public unsubscribed page invites readers to reply and ask to be removed by hand. '
            + 'Fires the same `subscriber.unsubscribed` event as the public route, so an ESP is '
            + 'told either way — an address removed here but left live at the provider is the '
            + 'shape that ends in a spam complaint. Staff-gated normally: it takes an id, so '
            + 'unlike the public route it is neither public nor CSRF-exempt. 404 on an id that is '
            + 'already gone, so a second press reports the truth.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['id'],
                  properties: { id: { type: 'string' } },
                },
              },
            },
          },
          responses: {
            '200': { description: 'Removed' },
            '403': { description: 'Staff only' },
            '404': { description: 'No such subscriber' },
          },
        },
      },
      '/api/newsletter/subscribers/export': {
        get: {
          summary: 'Export the newsletter subscribers (staff)',
          description:
            'Read from the consent ledger: ONLY contacts whose newsletter consent is granted AND '
            + 'confirmed (double opt-in) AND not withdrawn since. Each carries its proof — when it '
            + 'was confirmed, the wording version and the sha256 of its text, and what recorded it. '
            + 'Subscribers from before the ledger were recorded by a migration with '
            + '`source: "migration"`. `?format=csv` returns a spreadsheet-safe CSV file.',
          parameters: [
            { name: 'format', in: 'query', required: false, schema: { type: 'string', enum: ['json', 'csv'] } },
          ],
          responses: {
            '200': ok({ type: 'object', properties: { subscribers: { type: 'array', items: { type: 'object' } }, count: { type: 'integer' } } }),
            '403': { description: 'Staff only' },
          },
        },
      },
      '/api/consent/ledger': {
        get: {
          summary: 'The consent ledger for one address (admin, read-only)',
          description:
            'Every consent-ledger row for the address, every purpose, in the order written — '
            + '`{ id, email, purpose, granted, version, text_hash, at, ip?, ua?, source, '
            + 'confirmed_at? }` — and the current state per purpose. The ledger is append-only: '
            + 'no route edits or deletes a row. Administrators only.',
          parameters: [
            { name: 'email', in: 'query', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '200': ok({ type: 'object' }),
            '400': { description: 'Not an email address' },
            '403': { description: 'Administrators only' },
          },
        },
      },
      '/api/consent/ledger/withdraw': {
        post: {
          summary: 'Withdraw a consent, as the operator (admin)',
          description:
            'APPENDS a `granted: false` row (`source: "admin"`) for the address and purpose; '
            + 'nothing recorded before is changed. For `newsletter` the address also leaves the list '
            + 'and `subscriber.unsubscribed` fires. Session + CSRF; audited as '
            + '`privacy.consent.withdraw`.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['email', 'purpose'],
                  properties: { email: { type: 'string' }, purpose: { type: 'string' } },
                },
              },
            },
          },
          responses: {
            '200': ok({ type: 'object' }),
            '400': { description: 'Invalid address or purpose' },
            '403': { description: 'Administrators only' },
          },
        },
      },
      '/api/consent/withdraw': {
        get: {
          summary: 'Withdraw a consent by clicking a link (public, token-signed)',
          description:
            'The link a person clicks in an email (plugins mint it with '
            + '`host.consent.withdrawUrl`). Withdraws the one purpose the token names and '
            + 'redirects to `/consent/withdrawn?ok=1` (or `ok=0` for a bad or expired token).',
          parameters: [
            { name: 'token', in: 'query', required: true, schema: { type: 'string' } },
          ],
          responses: { '302': { description: 'Redirect to the withdrawn page' } },
        },
        post: {
          summary: 'Withdraw a consent from a link (public, token-signed)',
          description:
            'The token (minted by core for one address and ONE purpose, its own signing purpose '
            + 'so no other link can be replayed here) is in the query string, RFC 8058 style, and '
            + 'is the whole authorisation: no session, exempt from CSRF. Appends a withdrawal row '
            + '(`source: "withdraw_link"`). Answers the same 200 for a valid, an invalid and a '
            + 'missing token, so it reveals nothing about who consented.',
          parameters: [
            { name: 'token', in: 'query', required: true, schema: { type: 'string' } },
          ],
          responses: { '200': { description: 'Accepted; the consent is withdrawn if the token named one' } },
        },
      },
      '/api/media/update': {
        patch: {
          summary: 'Edit a media record\'s descriptive fields (staff)',
          description:
            'Sets `alt_text` and `folder`. Nothing that describes the FILE — url, filename, '
            + 'mime type, dimensions, derivatives — can be edited here: those are facts about '
            + 'bytes on disk, and a record that could disagree with its own file would be worse '
            + 'than one that cannot be renamed. Replacing an image is `media/replace`, which '
            + 're-runs the pipeline.\n\n'
            + 'Alt text is refused on a bulk patch. Describing forty pictures with one sentence '
            + 'is worse than describing none, because a screen reader then reads the same wrong '
            + 'caption forty times. Same role gate as uploading.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['ids'],
                  properties: {
                    ids: { type: 'array', items: { type: 'string' }, maxItems: 200 },
                    patch: {
                      type: 'object',
                      properties: {
                        alt_text: { type: 'string', maxLength: 300 },
                        folder: { type: 'string', maxLength: 120 },
                      },
                    },
                  },
                },
              },
            },
          },
          responses: {
            '200': { description: 'Which ids were updated' },
            '400': { description: 'No ids, too many ids, or alt_text on a bulk patch' },
            '403': { description: 'Role cannot edit media' },
          },
        },
      },
      '/api/consent/cookies': {
        get: {
          summary: 'The cookie declaration for this install (public)',
          description:
            'Every cookie this site sets — name, who sets it, which consent category gates it, '
            + 'what it is for and how long it lasts. Generated from configuration rather than '
            + 'from a scan: a provider appears only when its tracking ID is present AND valid, '
            + 'and disappears on the next request when it is cleared, so the declaration cannot '
            + 'go stale the way a periodically re-run scan does.\n\n'
            + 'Public because a decoupled storefront renders its own privacy pages and never '
            + 'loads this CMS\'s templates — a declaration only this origin could serve would '
            + 'be a legal document on the wrong domain. It discloses nothing that devtools does '
            + 'not already show.\n\n'
            + 'The caveats travel WITH the data: `incomplete` is true when a configured vendor '
            + 'may set cookies beyond the documented ones, and `opaque_containers` names tag '
            + 'managers whose contents this CMS cannot see. A client that renders the rows and '
            + 'drops those fields is publishing a completeness claim this API did not make.',
          responses: {
            '200': {
              description: 'The declaration',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean' },
                      data: {
                        type: 'object',
                        properties: {
                          cookies: {
                            type: 'array',
                            items: {
                              type: 'object',
                              properties: {
                                name: { type: 'string', example: '_ga' },
                                provider: { type: 'string', example: 'Google Analytics 4' },
                                category: { type: 'string', enum: ['necessary', 'preferences', 'analytics', 'marketing'] },
                                purpose: { type: 'string' },
                                lifetime: { type: 'string', example: '2 years' },
                                firstParty: { type: 'boolean' },
                                vendorControlled: { type: 'boolean' },
                                helpUrl: { type: 'string' },
                                setWhen: { type: 'string' },
                              },
                            },
                          },
                          incomplete: { type: 'boolean' },
                          opaque_containers: { type: 'array', items: { type: 'string' } },
                          cookieless_providers: { type: 'array', items: { type: 'string' } },
                          vendor_docs: { type: 'array', items: { type: 'object' } },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/api/newsletter/confirm': {
        get: {
          summary: 'Complete a newsletter double opt-in (public, token-authorised)',
          description:
            'Opened from a mail client by clicking the link the POST above sent, so there is '
            + 'no session by definition and none to protect: the token IS the authorisation. It '
            + 'is HMAC-signed with the same primitive the magic-link and password-reset flows '
            + 'use, carries the address, is single-purpose and expires after seven days. '
            + 'A GET that writes is unusual and deliberate — an email client cannot POST — and '
            + 'the write is idempotent, so a prefetching mail client opening the link before the '
            + 'human does not create a second row. Always redirects (302) to a confirmation '
            + 'page, and every kind of bad token gets the SAME redirect: distinguishing expired '
            + 'from forged would tell a prober about the signing key and changes nothing for '
            + 'somebody holding a link that does not work.',
          parameters: [
            { name: 'token', in: 'query', required: true, schema: { type: 'string' } },
          ],
          responses: { '302': { description: 'Redirect to /newsletter/confirmed' } },
        },
      },
      '/api/products': {
        get: {
          summary: 'List products (public; filters + pagination)',
          parameters: [
            { name: 'category', in: 'query', schema: { type: 'string' } },
            {
              name: 'brand', in: 'query', schema: { type: 'string' },
              description: 'A brand `slug` from GET /api/brands (always leads to that brand, whatever script it is written in), or any spelling of the brand name (matched ignoring case, accents, spacing and punctuation).',
            },
            { name: 'search', in: 'query', schema: { type: 'string' } },
            { name: 'on_sale', in: 'query', schema: { type: 'boolean' }, description: '`true` or `1`.' },
            { name: 'featured', in: 'query', schema: { type: 'boolean' }, description: '`true` or `1`.' },
            {
              name: 'all', in: 'query', schema: { type: 'boolean' },
              description: '`true` or `1`: also list drafts and archived products. Staff only; ignored for any other caller.',
            },
            {
              name: 'sort', in: 'query', required: false,
              schema: { type: 'string', enum: ['relevance', 'price_asc', 'price_desc', 'newest', 'name_asc', 'name_desc'], default: 'relevance' },
              description: 'Result order, applied by the server over the WHOLE matching set before `limit`/`offset` cut the page, so it composes with filters and paging (`meta.total` and `meta.hasMore` describe the same set whatever the order). `relevance` (default) is the ranked order for a `search` and the shop\'s merchandising order otherwise. `price_asc`/`price_desc` order by the price a buyer is charged (the sale price while a sale is live; a variable product by its cheapest variant; a product with no price last). `newest` is by creation date. `name_asc`/`name_desc` compare names in the `locale` language. Equal keys keep relevance order, so paging is deterministic. An unknown value is **422** with the allowed values in `error.details.sort`, never silently ignored. `price_*` use `price_from_cents` on each product in the response. The order applied is echoed in `meta.sort`. Popularity and rating are not offered: nothing records either.',
            },
            { name: 'locale', in: 'query', schema: { type: 'string' }, description: 'Language for translated product text and name collation.' },
            { name: 'limit', in: 'query', schema: { type: 'integer' } },
            { name: 'offset', in: 'query', schema: { type: 'integer' } },
          ],
          responses: {
            '200': ok({ type: 'array', items: { $ref: '#/components/schemas/Product' } }),
            '422': { description: 'Unknown `sort` value; `error.details.sort` lists the allowed ones. `meta.sort` on 200 echoes the order applied.' },
          },
        },
        post: {
          summary: 'Create a product (admin/editor)',
          security: [{ bearerApiKey: [] }],
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Product' } } } },
          responses: { '201': ok({ $ref: '#/components/schemas/Product' }) },
        },
      },
      '/api/products/{id}': {
        get: {
          summary: 'Fetch one product by id or slug (public)',
          description: 'Active products only. Catalogue staff (admin/editor/manager, or an API key with such a role whose scopes, if it has any, include `products`) who pass `all=true` also get draft and archived products, the same rule as `GET /api/products?all=true`. Everyone else, and staff without `all=true`, gets 404 for those. The staff response is `Cache-Control: private, no-store`.',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'all', in: 'query', required: false, schema: { type: 'string', enum: ['true', '1'] }, description: 'Catalogue staff only: include draft and archived products. Ignored for anyone else.' },
          ],
          responses: { '200': ok({ $ref: '#/components/schemas/Product' }), '404': { description: 'No such product, or not active and the caller is not catalogue staff' } },
        },
        put: {
          summary: 'Update a product (admin/editor)',
          security: [{ bearerApiKey: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': ok({ $ref: '#/components/schemas/Product' }) },
        },
        delete: {
          summary: 'Delete a product (admin)',
          security: [{ bearerApiKey: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': ok({ type: 'object' }) },
        },
      },
      '/api/brands': {
        // Every maker with active products, grouped so one brand is one entry
        // however it was spelled, PLUS any curated Brand record. Each carries
        // `count`, `key` and `spellings`; a curated one also has `id`, `logo`
        // and timestamps. `count` is a promise about `?brand=`: it is what
        // GET /api/products?brand=<slug> returns, because both group by the
        // same key and the slug is resolved back by the directory that
        // assigned it. Slugs are unique across the listing.
        get: {
          summary: 'List brands with product counts (public)',
          responses: { '200': ok({ type: 'array', items: { type: 'object' } }) },
        },
        post: {
          summary: 'Create a brand (admin/editor)', security: [{ bearerApiKey: [] }],
          responses: { '201': ok({ type: 'object' }) },
        },
      },
      '/api/navigation': {
        get: {
          summary: 'The site menu the operator built at /admin/navigation, resolved for a language. Public. `items` is EMPTY when no menu has been saved — a storefront should then show its own default links. Labels come from the requested locale where a translation exists; internal links carry this CMS\'s locale prefix. Written through POST /api/settings/update (key `navigation`, admin only), which refuses any link that is not /path, #anchor, http(s)://, mailto: or tel:.',
          parameters: [{ name: 'locale', in: 'query', required: false, schema: { type: 'string' }, description: 'Language for labels and internal links, e.g. de.' }],
          responses: {
            '200': ok({ type: 'object', properties: {
              items: { type: 'array', items: { type: 'object', properties: {
                label: { type: 'string' },
                href: { type: 'string' },
                external: { type: 'boolean', description: 'Leaves this site (http(s), mailto: or tel:).' },
                newTab: { type: 'boolean', description: 'Open in a new tab. Only ever true for an external link.' },
                current: { type: 'boolean', description: 'Always false here — there is no current page on an API call.' },
                children: { type: 'array', items: { type: 'object' }, description: 'One level of submenu, same shape.' },
              } } },
            } }),
          },
        },
      },
      '/api/product-bulk': {
        post: {
          summary: 'Change many products at once (catalogue staff; API keys need `products:write`). Target the ticked products with `ids`, or every product the admin list\'s search matches with `filter: { q }`. `ops` may combine several changes; `where` restricts them to products meeting a condition (those that do not are counted as `not_matching`). Every applied change is recorded and can be undone (POST /api/product-bulk/undo). Without `apply: true` it is a PREVIEW: it reports, per product, what would change or why it is skipped, and changes nothing. Applying saves each product through the normal product save, so hooks, `product.updated` webhooks, price history and the audit log all see it; one `product.bulk_edit` audit entry records the batch. Prices change on the REGULAR price, in integer minor units, never below zero; a product whose variants have their own prices is skipped for a flat "set" (use percent or amount). At most 500 products; not a transaction — failures are listed and the rest apply. Off while the shop is switched off.',
          security: [{ bearerApiKey: [] }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['ops'], properties: {
            ids: { type: 'array', items: { type: 'string' }, maxItems: 1000 },
            filter: { type: 'object', properties: { q: { type: 'string', description: 'The admin list search. Instead of ids.' } } },
            where: { type: 'object', description: 'Only change products that meet this condition.', properties: {
              status: { type: 'array', items: { type: 'string', enum: ['active', 'draft', 'archived'] } },
              stock: { type: 'string', enum: ['in', 'out', 'untracked'] },
              on_sale: { type: 'boolean' }, featured: { type: 'boolean' },
              category: { type: 'string', description: 'Includes its subcategories.' },
              price_min: { type: 'integer' }, price_max: { type: 'integer' },
            } },
            apply: { type: 'boolean', description: 'false or absent = preview only.' },
            ops: { type: 'object', properties: {
              status: { type: 'string', enum: ['active', 'draft', 'archived'] },
              featured: { type: 'boolean' },
              addCategories: { type: 'array', items: { type: 'string' }, description: 'Category slugs; each must exist.' },
              removeCategories: { type: 'array', items: { type: 'string' } },
              addTags: { type: 'array', items: { type: 'string' } },
              removeTags: { type: 'array', items: { type: 'string' }, description: 'Matched without regard to case.' },
              price: { type: 'object', properties: { mode: { type: 'string', enum: ['set', 'percent', 'amount'] }, value: { type: 'number', description: 'set/amount: minor units; percent: -99.99 to 500.' } } },
              sale: { type: 'object', properties: { mode: { type: 'string', enum: ['clear', 'percent_off'] }, value: { type: 'number', description: 'percent_off: more than 0, less than 100.' } } },
              stock: { type: ['integer', 'null'], description: 'null = not tracked. Skipped for products with variants.' },
            } },
          } } } } },
          responses: {
            '200': ok({ type: 'object', properties: {
              preview: { type: 'boolean' },
              selected: { type: 'integer' }, will_change: { type: 'integer' }, unchanged: { type: 'integer' }, skipped: { type: 'integer' },
              not_found: { type: 'array', items: { type: 'string' } },
              products: { type: 'array', description: 'Preview only.', items: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, changes: { type: 'array', items: { type: 'string' } }, skipped: { type: 'string' } } } },
              updated: { type: 'integer', description: 'Apply only.' },
              failed: { type: 'array', description: 'Apply only.', items: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, message: { type: 'string' } } } },
            } }),
          },
        },
      },
      '/api/product-bulk/csv': {
        post: {
          summary: 'Update products from CSV text (catalogue staff). One row per product or variant; key columns sku, slug or id (each row uses the first it fills in; a variant\'s SKU updates that variant). Columns price, sale_price (`none` ends the sale), stock (`untracked`), status, featured. An empty cell changes nothing; other columns are ignored and listed. Numbers are plain — no thousands separators; "1,000" is a row error. Previews unless `apply: true`; a file with ANY row error is refused as a whole. Applied like every bulk change: saveProduct per product, stock sold meanwhile kept, the batch undoable. At most 1000 rows, 1.5 MB.',
          security: [{ bearerApiKey: [] }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['csv'], properties: { csv: { type: 'string' }, apply: { type: 'boolean' } } } } } },
          responses: { '200': ok({ type: 'object' }), '400': { description: 'Row errors on apply, or an unusable file.' } },
        },
      },
      '/api/product-bulk/template': {
        get: {
          summary: 'Every product and variant with its current values, as the CSV that POST /api/product-bulk/csv reads (catalogue staff).',
          security: [{ bearerApiKey: [] }],
          responses: { '200': { description: 'text/csv', content: { 'text/csv': { schema: { type: 'string' } } } } },
        },
      },
      '/api/product-bulk/history': {
        get: {
          summary: 'The 20 most recent bulk changes, newest first, for undo (catalogue staff).',
          security: [{ bearerApiKey: [] }],
          responses: { '200': ok({ type: 'array', items: { type: 'object', properties: {
            id: { type: 'string' }, at: { type: 'string' }, actor: { type: 'string' }, kind: { type: 'string', enum: ['bulk', 'csv', 'undo'] },
            label: { type: 'string' }, products: { type: 'integer' }, undone_at: { type: ['string', 'null'] },
          } } }) },
        },
      },
      '/api/product-bulk/undo': {
        post: {
          summary: 'Undo a bulk change (catalogue staff). Restores each field only while it still holds the value the change gave it; anything changed since — a later edit, stock a checkout sold — is left as it is and listed. Previews unless `apply: true`. A change is undone once (409 after); the undo is itself recorded and can be undone.',
          security: [{ bearerApiKey: [] }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['batch'], properties: { batch: { type: 'string' }, apply: { type: 'boolean' } } } } } },
          responses: { '200': ok({ type: 'object' }), '404': { description: 'No such change.' }, '409': { description: 'Already undone.' } },
        },
      },
      '/api/search/popular': {
        delete: {
          summary: 'Forget every counted search, so popular-search suggestions start again from nothing (admin). Audited.',
          security: [{ bearerApiKey: [] }],
          responses: { '200': ok({ type: 'object', properties: { cleared: { type: 'boolean' } } }) },
        },
      },
      '/api/search/suggest': {
        get: {
          summary: 'Suggestions while someone is typing: popular searches, and a few posts, pages, products and categories whose titles match. Public and cached; its own rate bucket. Popular searches are queries that found something, made by at least the operator\'s minimum number of visitors (default 5), not blocklisted, and never anything that looks like an email, web address or number. The operator can switch suggestions off (then `meta.enabled` is false and every list is empty), set the count per kind, and switch popular searches off. Same folding as search (accents, case, Greek matches Latin) and the same synonyms; no typo tolerance. Only what a visitor could open: published posts not hidden from search; active products whose catalogue visibility is `visible` or `search`; categories with their product count. Products and categories only while the shop is switched on. Fewer than 2 characters answers empty lists.',
          parameters: [
            { name: 'q', in: 'query', required: true, schema: { type: 'string' } },
            { name: 'types', in: 'query', required: false, schema: { type: 'string' }, description: 'Comma-separated subset of searches,posts,pages,products,categories. Default: all the site has.' },
            { name: 'limit', in: 'query', required: false, schema: { type: 'integer', maximum: 8 }, description: 'Per type; never more than the operator\'s setting (default 5).' },
            { name: 'locale', in: 'query', required: false, schema: { type: 'string' }, description: 'Only posts and pages in this language.' },
          ],
          responses: {
            '200': ok({ type: 'object', properties: {
              searches: { type: 'array', items: { type: 'string' }, description: 'Popular searches that start with (a word of) the query.' },
              posts: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, slug: { type: 'string' } } } },
              pages: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, slug: { type: 'string' } } } },
              products: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, slug: { type: 'string' }, price_cents: { type: 'integer' }, image: { type: ['string', 'null'] } } } },
              categories: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, slug: { type: 'string' }, count: { type: 'integer' } } } },
            } }),
          },
        },
      },
      '/api/product-categories/{id}': {
        put: {
          summary: 'Rename, move or reorder a product category (admin/editor/manager). `parent_slug: null` moves it to the top level. The slug cannot change — products are filed under it. A parent that does not exist, the category itself, one of its own subcategories, or a move past 5 levels is refused with a 400 that says which.',
          security: [{ bearerApiKey: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': ok({ type: 'object' }), '400': { description: 'Refused move or invalid payload' }, '404': { description: 'No such category' } },
        },
        delete: {
          summary: 'Delete a product category (admin/editor/manager). Refused with 409 while it has subcategories. Products in it are untagged, never deleted; `untagged` says how many.',
          security: [{ bearerApiKey: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': ok({ type: 'object', properties: { id: { type: 'string' }, untagged: { type: 'integer' } } }), '404': { description: 'No such category' }, '409': { description: 'It still has subcategories' } },
        },
      },
      '/api/product-categories': {
        get: { summary: 'List product categories (public), each with `parent_slug`, `product_count` (tagged directly) and `product_count_total` (including every subcategory). Filtering products by `?category=` includes subcategories.', responses: { '200': ok({ type: 'array', items: { type: 'object' } }) } },
        post: {
          summary: 'Create a product category (admin/editor)', security: [{ bearerApiKey: [] }],
          responses: { '201': ok({ type: 'object' }) },
        },
      },
      '/api/commerce/prescription-schema': {
        get: {
          summary: 'The optical prescription rules as data — field ranges, the 0.25 dioptre grid, and the clinical rules — so a storefront can render and pre-validate an Rx form without hard-coding optometry. Public and unauthenticated. The server re-validates every submission regardless; this is a convenience for the client, never the enforcement point.',
          parameters: [{
            name: 'type', in: 'query', required: false,
            schema: { type: 'string', enum: ['spectacles', 'contacts'], default: 'spectacles' },
            description: 'Contacts add base curve and diameter, which are MILLIMETRES on a 0.1 grid — not the 0.25 dioptre grid the powers use.',
          }],
          responses: {
            '200': ok({ type: 'object', properties: {
              type: { type: 'string', enum: ['spectacles', 'contacts'] },
              eyes: { type: 'array', items: { type: 'object', properties: { code: { type: 'string' }, label: { type: 'string' } } } },
              fields: { type: 'object', description: 'Per-field min/max/step/required, in display units (dioptres or mm).' },
              pd: { type: 'object', description: 'Pupillary distance bounds, in millimetres.' },
              rules: { type: 'array', items: { type: 'string' }, description: 'Human-readable clinical rules.' },
            } }),
          },
        },
      },
      '/api/commerce/frame-schema': {
        get: {
          summary: 'Eyewear frame geometry limits, face-measurement limits, the ISO/IEC 7810 ID-1 card dimensions and the fit tolerance — as data, so a storefront can build a size guide and a measurement UI without hard-coding a millimetre. Public and unauthenticated. Returns 404 when the optical module is inactive, because an install without it must behave like a shop that never bought it.',
          responses: {
            '200': ok({ type: 'object', properties: {
              units: { type: 'object', description: 'Which unit each group uses. Frame geometry is WHOLE millimetres; anything measured from a person is TENTHS of a millimetre.' },
              frame: { type: 'object', description: 'Per-field min/max/required for lens width, bridge, temple, lens height and total width — whole mm.' },
              face: { type: 'object', description: 'Face width and PD bounds, in tenths of a millimetre.' },
              methods: { type: 'array', items: { type: 'string' }, description: 'How a measurement may have been obtained.' },
              card: { type: 'object', description: 'ID-1 card dimensions, the reference scale for a photo measurement.' },
              fit_tolerance_mm: { type: 'integer', description: 'How far a frame may sit from the face width and still be a good fit.' },
              pd_lab_grade_methods: { type: 'array', items: { type: 'string' }, description: 'Methods whose PD is precise enough for a LENS ORDER. A PD measured from a photo is not: it is for choosing a frame only, and sending it to a lab produces a remake.' },
            } }),
            '404': { description: 'The optical module is not active on this install.' },
          },
        },
      },
      '/api/orders/quote': {
        post: {
          summary: 'Price a basket WITHOUT creating anything — no order, no customer, no stock reservation. Safe to call on every cart change. Runs the identical calculation as POST /api/orders, so a quoted total and a charged total cannot drift. Public; usable with an orders:write key.',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['items'], properties: {
              items: { type: 'array', items: { type: 'object', required: ['product_id', 'qty'], properties: { product_id: { type: 'string' }, variant_id: { type: 'string' }, qty: { type: 'integer' }, addons: lineAddonsRequest, prescription: { type: 'object', description: 'As POST /api/orders takes it. Not validated by the quote (the order validates it); handed to the add-on filter, which may price by it.' } } } },
              shipping_country: { type: 'string', description: 'ISO-3166 alpha-2.' },
              shipping_postcode: { type: 'string' },
              shipping_method_id: { type: 'string', description: 'An id from available_shipping_methods. Its COST is always re-derived server-side.' },
              coupon_code: { type: 'string' },
              email: { type: 'string', description: 'The buyer\'s email, for coupon rules that depend on it: per-customer limits, and coupons bound to one email (compared case-insensitively). Send the address checkout will send, or an email-bound code is refused (coupon.email_mismatch for staff; coupon.not_found for anyone else, like every refusal but coupon.min_subtotal).' },
              shipping_address: { $ref: '#/components/schemas/Address', description: 'Read as POST /api/orders reads it: its country/postcode are the destination when shipping_country/shipping_postcode are absent. A malformed address is ignored here (the order refuses it).' },
              billing_address: { $ref: '#/components/schemas/Address', description: 'Its tax_id (delivery address as fallback) is the buyer\'s VAT id for EU reverse charge — the same reader POST /api/orders uses, so a quote and the order agree.' },
            } } } },
          },
          responses: {
            '200': ok({ type: 'object', properties: {
              subtotal_cents: { type: 'integer' }, discount_cents: { type: 'integer' },
              shipping_cents: { type: 'integer' }, tax_cents: { type: 'integer' },
              total_cents: { type: 'integer' }, prices_include_tax: { type: 'boolean' },
              requires_shipping: { type: 'boolean' }, weight_grams: { type: 'integer' },
              lines: { type: 'array', items: { type: 'object', properties: {
                addons: { type: 'array', items: LineAddon, description: 'The add-ons priced into this line, already inside unit_price_cents. Absent when none.' },
                coupon_gift: { type: 'boolean', description: 'true on the free unit a gift_product coupon added — always the last line, at unit_price_cents 0.' },
              } }, description: 'Per-line net/tax/discount breakdown.' },
              available_shipping_methods: { type: 'array', items: { type: 'object' } },
              coupon: {
                type: ['object', 'null'],
                description: 'A REJECTED coupon is reported here with a reason, not as an error — the rest of the quote is still valid. Accepted: { ok: true, code, kind, discount_cents, free_shipping, gift_product_id? }. Rejected: { ok: false, reason, refusal, message, shortfall_cents? }, where refusal is one of the stable codes coupon.not_found, coupon.expired, coupon.not_started, coupon.min_subtotal, coupon.not_applicable, coupon.email_mismatch, coupon.already_redeemed, coupon.exhausted. Anyone who is not staff (an anonymous cart, an API key) gets coupon.not_found for every refusal except coupon.min_subtotal, so the endpoint cannot be used to learn which codes exist. POST /api/orders refuses with the same codes in error.params.refusal.',
              },
            } }),
            '400': errRes('Invalid basket, an order limit exceeded, an unavailable product, or refused add-ons (reason checkout.addons_*, or the plugin\'s own)'),
            '500': errRes('An add-on plugin failed or returned an invalid result (reason checkout.addons_failed); nothing is priced without the add-on'),
          },
        },
      },
      '/api/orders/{id}/tax-override': {
        post: {
          summary:
            'Override the VAT the engine computed on a placed order. Requires the `override_tax` capability, which shop managers have by default — deliberately NOT `write_commerce`, which also gates refunds. '
            + 'An override chooses a RULE (`tax_class`) or `exempt: true`, never an amount, so the stored total stays derivable from the rate. A non-empty `reason` is REQUIRED: an override with no reason is indistinguishable from a mistake. '
            + 'APPEND-ONLY — each call adds to `tax_overrides` and the engine\'s own breakdown is preserved once in `line_totals_original` and never rewritten.',
          security: [{ bearerApiKey: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': ok({ $ref: '#/components/schemas/Order' }),
            '400': errRes('No reason given, a tax class with no country-wide rate in the shop\'s own country (a class only another country has is unknown here), a tax class on a line taxed as destination, reverse charge or export (only `exempt` applies there), a line index out of range, or an erased order'),
            '403': errRes('Missing the override_tax capability'),
            '404': errRes('Not found'),
          },
        },
      },
      '/api/commerce/product-fields': {
        get: {
          summary: 'Fields declared on this shop\'s products — the merchant\'s own plus any an active plugin adds. Public callers get ONLY the fields marked public — no values, no private field names, and no count of what was withheld. Staff get every declaration, which the admin product form needs.',
          responses: {
            '200': ok({
              type: 'object',
              properties: {
                fields: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      name: { type: 'string' },
                      label: { type: 'string' },
                      help: { type: 'string' },
                      rule: { type: 'object' },
                      visibility: { type: 'string', enum: ['public', 'staff'], description: 'Staff callers only.' },
                      managed: { type: 'boolean', description: 'Staff callers only, and present only when true: an active plugin provides this field. It is read-only for the merchant — PUT refuses its name.' },
                    },
                  },
                },
                conflicts: {
                  type: 'array', items: { type: 'string' },
                  description: 'Staff callers only: names an active plugin declares that the merchant already defined. The merchant\'s field is kept and the plugin\'s is inactive until the merchant renames or removes theirs.',
                },
              },
            }),
          },
        },
        put: {
          summary: 'Replace the MERCHANT\'s product-field declarations (admin). Plugin-provided fields are not part of this list: a name an active plugin provides is refused with a 422 naming it, and nothing in that request is saved. Removing a declaration HIDES the field; the values products already store survive.',
          security: [{ bearerApiKey: [] }],
          responses: { '200': ok({ type: 'object' }), '403': errRes('Admin only'), '422': errRes('Invalid definitions, or a name an active plugin provides') },
        },
      },
      '/api/commerce/currencies': {
        get: {
          summary: 'Currencies the shop quotes in, with the operator-entered rate for each. Public — a storefront renders a currency picker before anyone signs in. `stale` says the rate is older than the shop\'s configured limit; a storefront may want to mark such a price indicative.',
          responses: {
            '200': ok({
              type: 'object',
              properties: {
                base: { type: 'string' },
                available: { type: 'array', items: { type: 'string' } },
                rates: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      code: { type: 'string' },
                      rate_ppm: { type: 'integer', description: 'Millionths of this currency per one unit of base. 1 EUR = 1.087 USD is 1087000.' },
                      updated_at: { type: 'string' },
                      stale: { type: 'boolean' },
                    },
                  },
                },
              },
            }),
          },
        },
        put: {
          summary: 'Replace the rate table (admin). `updated_at` is stamped server-side and moves only when a rate actually changes — a client-settable timestamp would defeat staleness, which is the only defence against quoting a year-old number.',
          security: [{ bearerApiKey: [] }],
          responses: { '200': ok({ type: 'object' }), '400': errRes('rates must be an array'), '403': errRes('Admin only') },
        },
      },
      '/api/shipping-methods': {
        get: {
          summary: 'Shipping methods. Public — a storefront must render the choices, and a rate is not a secret. Use POST /api/orders/quote to find which apply to a given destination and basket.',
          responses: { '200': ok({ type: 'array', items: { $ref: '#/components/schemas/ShippingMethod' } }) },
        },
        post: {
          summary: 'Create a shipping method (admin). Rates decide what money is taken.',
          security: [{ bearerApiKey: [] }],
          responses: { '201': ok({ $ref: '#/components/schemas/ShippingMethod' }), '400': errRes('Invalid zone or rate'), '403': errRes('Admin only') },
        },
      },
      '/api/shipping-methods/{id}': {
        put: {
          summary: 'Update a shipping method (admin).', security: [{ bearerApiKey: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': ok({ $ref: '#/components/schemas/ShippingMethod' }), '400': errRes('Invalid zone or rate'), '404': errRes('Not found') },
        },
        delete: {
          summary: 'Delete a shipping method (admin).', security: [{ bearerApiKey: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': ok({ type: 'null' }), '404': errRes('Not found') },
        },
      },
      '/api/coupons': {
        get: {
          summary: 'List coupons. STAFF ONLY — the set of live discount codes is exactly what an attacker wants. A shopper validates a code they already know by quoting a basket with it.',
          security: [{ bearerApiKey: [] }],
          responses: { '200': ok({ type: 'array', items: { $ref: '#/components/schemas/Coupon' } }), '403': errRes('Staff only') },
        },
        post: {
          summary: 'Create a coupon (admin).', security: [{ bearerApiKey: [] }],
          responses: { '201': ok({ $ref: '#/components/schemas/Coupon' }), '400': errRes('Invalid code, kind, value or dates'), '403': errRes('Admin only') },
        },
      },
      '/api/coupons/{id}': {
        put: {
          summary: 'Update a coupon (admin).', security: [{ bearerApiKey: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': ok({ $ref: '#/components/schemas/Coupon' }), '400': errRes('Invalid payload'), '404': errRes('Not found') },
        },
        delete: {
          summary: 'Delete a coupon (admin).', security: [{ bearerApiKey: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': ok({ type: 'null' }), '404': errRes('Not found') },
        },
      },
      '/api/products/{id}/stock-status': {
        get: {
          summary: 'Availability of one product: in-stock, low-stock or out-of-stock (public)',
          description:
            'The same `stock_status` every product already carries, on its own, for refreshing a '
            + 'badge without re-fetching the product. `id` is an id or a slug; a product that is '
            + 'not active is 404, exactly as GET /api/products/{id}. A product with variants '
            + 'is judged on its enabled variants and lists each one under `variants`. '
            + 'Untracked stock is `in-stock` with `available_qty: null`. A product '
            + 'below the threshold is `low-stock`; at 0 or less it is `out-of-stock`, and '
            + '`backorderable`/`purchasable` say whether an order is still accepted. The threshold '
            + 'is the product\'s own `low_stock_threshold`, else the shop setting '
            + '`inventory_low_stock_threshold_qty` (default 5). Pull-based: anonymous responses '
            + 'share the public read cache (30 s by default), and nothing is reserved.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': ok({
              type: 'object',
              properties: {
                product_id: { type: 'string' },
                ...StockStatusInfo.properties,
                members: {
                  type: 'array',
                  description: 'Only for a grouped product: one entry per member a shopper can see, in order. The group itself is the best of them (`tracked` false, `available_qty` null).',
                  items: { type: 'object', properties: { id: { type: 'string' }, ...StockStatusInfo.properties } },
                },
                variants: {
                  type: 'array',
                  description: 'Only for a product with variants: one entry per enabled variant.',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      options: { type: 'object', additionalProperties: { type: 'string' } },
                      ...StockStatusInfo.properties,
                    },
                  },
                },
              },
            }),
            '404': errRes('No active product with that id or slug.'),
          },
        },
      },
      '/api/products/{id}/notify-me': {
        post: {
          summary: 'Tell me when this product is back (public)',
          description:
            'The storefront button on a sold-out product. Public and cookie-less like the '
            + 'newsletter box, and through the same shared gate — rate limit, honeypot and '
            + 'optional challenge. ONE message, not a subscription: the row is deleted the '
            + 'moment the notice is sent, so there is nothing to unsubscribe from. That is also '
            + 'why it does not use double opt-in — the newsletter puts a stranger on an ongoing '
            + 'list, whereas the worst a mistyped address achieves here is one email about one '
            + 'product, and a confirmation click would lose most of the people it serves. '
            + 'Answers identically whether it stored anything or not: an address already '
            + 'waiting, a product already in stock and a product that does not exist all return '
            + 'the same message, because distinguishing them would reveal which products exist '
            + 'and who is waiting for them. Only a malformed address is named, because the '
            + 'visitor mistyped and can fix it. Notices are sent by the scheduler, which asks '
            + 'which waiting products became buyable — correct however the stock arrived.',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['email'],
                  properties: {
                    email: { type: 'string', format: 'email' },
                    variant_id: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: {
            '200': { description: 'Recorded, or deliberately indistinguishable from recorded' },
            '400': { description: 'The email address is malformed' },
            '429': { description: 'Rate limited' },
          },
        },
      },
      '/api/products/{id}/reviews': {
        get: {
          summary: 'A product\'s published reviews and their aggregate (public)',
          description:
            'APPROVED reviews only, newest first by default, as an allow-listed projection: '
            + 'id, product_id, rating (1–5), title, body, author_name, verified_buyer, locale, '
            + 'created_at. Never the email, the order number, the spam score or the moderation '
            + 'state. `aggregate` is computed over every approved review of the product (not the '
            + 'page) and is the same number `GET /api/products/{id}` puts in its schema.org '
            + '`aggregateRating`. A review erased at its author\'s request keeps its rating in the '
            + 'aggregate and is left out of the list. `accepting_reviews` says whether to show a form '
            + '(the site switch AND the product\'s own `reviews_enabled`). `media` appears on a '
            + 'review only when a media plugin attaches photos or video through the '
            + '`review_media` hook — core stores text only. `{id}` is the product id or slug; an '
            + 'inactive or unknown product is a 404.',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Product id or slug.' },
            { name: 'rating', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 5 }, description: 'Only reviews with this rating.' },
            { name: 'locale', in: 'query', schema: { type: 'string' }, description: 'Only reviews written in this locale.' },
            { name: 'verified', in: 'query', schema: { type: 'string', enum: ['1', 'true'] }, description: 'Only verified buyers.' },
            { name: 'sort', in: 'query', schema: { type: 'string', enum: ['recent', 'rating_desc', 'rating_asc'] } },
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 50, default: 10 } },
            { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0 } },
            { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1 } },
          ],
          responses: {
            '200': ok({
              type: 'object',
              properties: {
                product_id: { type: 'string' },
                accepting_reviews: { type: 'boolean' },
                aggregate: {
                  type: 'object',
                  properties: {
                    count: { type: 'integer' },
                    average: { type: ['number', 'null'], description: 'One decimal; null with no reviews.' },
                    histogram: {
                      type: 'object',
                      description: 'Count per star, keys "1" to "5".',
                      additionalProperties: { type: 'integer' },
                    },
                  },
                },
                reviews: {
                  type: 'array',
                  items: {
                    type: 'object',
                    required: ['id', 'product_id', 'rating', 'body', 'author_name', 'verified_buyer', 'created_at'],
                    properties: {
                      id: { type: 'string' },
                      product_id: { type: 'string' },
                      rating: { type: 'integer', minimum: 1, maximum: 5 },
                      title: { type: 'string' },
                      body: { type: 'string' },
                      author_name: { type: 'string' },
                      verified_buyer: { type: 'boolean' },
                      locale: { type: 'string' },
                      created_at: { type: 'string', format: 'date-time' },
                      media: {
                        type: 'array',
                        description: 'Only when a media plugin is installed.',
                        items: {
                          type: 'object',
                          properties: {
                            kind: { type: 'string', enum: ['image', 'video'] },
                            url: { type: 'string' },
                            alt: { type: 'string' },
                            thumbnail_url: { type: 'string' },
                          },
                        },
                      },
                    },
                  },
                },
              },
            }),
            '404': { description: 'No such product, or not active' },
          },
        },
        post: {
          summary: 'Submit a product review (public)',
          description:
            'Public and cookie-less, through the shared public gate: per-IP rate limit, honeypot '
            + '(`hp_url`), and a proof of work that is ALWAYS required on this surface — fetch a '
            + 'challenge from `GET /api/captcha/challenge?surface=reviews`, solve it, and send '
            + '`pow_token`. The structural spam score flags and never refuses. `verified_buyer` '
            + 'is computed by the server — true only when the email has a paid order in state '
            + 'processing or completed containing this product — and is never read from the body. '
            + 'A new review is pending until a moderator approves it, unless the shop turned on '
            + '`reviews_auto_approve_verified` (off by default) and the review is from a verified '
            + 'buyer and was not flagged. One review per address per product (a rejected one may '
            + 'be rewritten). The answer is `201 { received: true }` whether the review was '
            + 'stored, auto-approved, dropped as a duplicate or caught by the honeypot: telling '
            + 'them apart would reveal whether an address bought a product.',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Product id or slug.' },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['rating', 'body', 'author_name', 'author_email', 'pow_token'],
                  properties: {
                    rating: { type: 'integer', minimum: 1, maximum: 5 },
                    title: { type: 'string', maxLength: 120 },
                    body: { type: 'string', minLength: 2, maxLength: 4000 },
                    author_name: { type: 'string', minLength: 1, maxLength: 80 },
                    author_email: { type: 'string', format: 'email', description: 'Never published.' },
                    order_number: { type: 'string', maxLength: 40, description: 'Optional. Never published.' },
                    locale: { type: 'string', description: 'A configured site locale; anything else becomes the default.' },
                    pow_token: { type: 'string', description: '`challenge::nonce` from the proof-of-work widget.' },
                    hp_url: { type: 'string', description: 'Honeypot. Leave empty.' },
                  },
                },
              },
            },
          },
          responses: {
            '201': ok({ type: 'object', properties: { received: { type: 'boolean', enum: [true] } } }),
            '403': { description: 'The proof of work was missing, stale or already used' },
            '404': { description: 'No such product, not active, or not taking reviews' },
            '422': { description: 'A field failed validation (named in `error.details`)' },
            '429': { description: 'Rate limited' },
          },
        },
      },
      '/api/reviews': {
        get: {
          summary: 'The review moderation queue (staff: manage_catalog)',
          description:
            'Every moderation state, including rejected and spam, WITH the reviewer\'s email. '
            + 'Defaults to `status=pending`. `meta.counts` holds the per-state totals for the whole '
            + 'collection; `meta.products` maps each product id on the page to its name.',
          security: [{ bearerApiKey: [] }],
          parameters: [
            { name: 'status', in: 'query', schema: { type: 'string', enum: ['pending', 'approved', 'rejected', 'spam', 'all'], default: 'pending' } },
            { name: 'rating', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 5 } },
            { name: 'verified', in: 'query', schema: { type: 'string', enum: ['yes', 'no'] } },
            { name: 'product_id', in: 'query', schema: { type: 'string' } },
            { name: 'q', in: 'query', schema: { type: 'string' }, description: 'Matches name, email, title or body.' },
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
            { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0 } },
          ],
          responses: {
            '200': ok({ type: 'array', items: { type: 'object', description: 'A stored review entity: { id, type, data, created_at, updated_at }.' } }),
            '401': { description: 'Not signed in' },
            '403': { description: 'The role may not moderate reviews' },
          },
        },
      },
      '/api/reviews/moderate': {
        post: {
          summary: 'Approve, reject, mark as spam, re-queue or delete reviews (staff: manage_catalog)',
          description:
            'Up to 200 ids per call, one audit entry (`review.moderate`) naming the actor, the '
            + 'action and every id. Approving stamps `published_at` the first time only; every '
            + 'change of state stamps `moderated_at`. Unknown ids are returned in `missing` rather '
            + 'than failing the batch. Deleting fires the `after_review_delete` plugin action so a '
            + 'media module can drop what it stored.',
          security: [{ bearerApiKey: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['ids', 'action'],
                  properties: {
                    ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 200 },
                    action: { type: 'string', enum: ['approve', 'reject', 'spam', 'pending', 'delete'] },
                  },
                },
              },
            },
          },
          responses: {
            '200': ok({
              type: 'object',
              properties: {
                action: { type: 'string' },
                updated: { type: 'array', items: { type: 'string' } },
                missing: { type: 'array', items: { type: 'string' } },
              },
            }),
            '401': { description: 'Not signed in' },
            '403': { description: 'The role may not moderate reviews' },
            '422': { description: 'Unknown action, or ids missing, duplicated or too many' },
          },
        },
      },
      '/api/orders/{id}/ship': {
        post: {
          summary: 'Record tracking and notify the customer (commerce write)',
          description:
            'Writes tracking details BESIDE the order status rather than into it: `OrderStatus` '
            + 'governs money and stock, and dispatch is neither — an order can be `processing` '
            + 'and already posted, or `completed` and collected in person. Requires a tracking '
            + 'number or an http(s) tracking URL; a URL that is neither is refused by name '
            + 'rather than dropped. The customer is emailed ONCE, on the first call: '
            + '`shipped_at` is the guard, so correcting a typo in a tracking number updates the '
            + 'order without sending a second "on its way". The send is fire-and-forget, because '
            + 'a mail transport that is down must not fail a dispatch already made.',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    tracking_number: { type: 'string', maxLength: 120 },
                    tracking_carrier: { type: 'string', maxLength: 80 },
                    tracking_url: { type: 'string', format: 'uri' },
                  },
                },
              },
            },
          },
          responses: {
            '200': { description: 'Saved; `notified` says whether the customer was emailed' },
            '400': { description: 'No tracking number or URL, or a non-http(s) URL' },
            '403': { description: 'Commerce write permission required' },
            '404': { description: 'No such order' },
          },
        },
      },
      '/api/orders/attribution': {
        get: {
          summary: 'Paid orders and revenue by campaign source, medium and campaign (staff only)',
          description:
            'Built from `order.attribution`, which exists only for visitors who granted marketing consent. '
            + 'Paid orders only, the rule the dashboard uses. Revenue is in the shop\'s base currency. '
            + '`format=csv` returns a spreadsheet (formula-escaped) with the unattributed orders as their own row.',
          security: [{ bearerApiKey: [] }],
          parameters: [
            { name: 'from', in: 'query', schema: { type: 'string', format: 'date' }, description: 'First UTC day, inclusive. Default: 29 days before `to`.' },
            { name: 'to', in: 'query', schema: { type: 'string', format: 'date' }, description: 'Last UTC day, inclusive. Default: today. At most 731 days in all.' },
            { name: 'model', in: 'query', schema: { type: 'string', enum: ['first', 'last'], default: 'last' } },
            { name: 'format', in: 'query', schema: { type: 'string', enum: ['json', 'csv'], default: 'json' } },
          ],
          responses: {
            '200': { ...ok({ $ref: '#/components/schemas/AttributionReport' }), description: 'The report (JSON), or text/csv with format=csv' },
            '400': errRes('A bad date, a reversed or over-long range, or an unknown model/format'),
            '401': errRes('Not signed in'),
            '403': errRes('Your role cannot view orders'),
          },
        },
      },
      '/api/orders/tags': {
        get: {
          summary: 'Staff tags in use, with the number of orders carrying each (staff only)',
          description:
            'The autocomplete list and the sidebar counts. Most used first, then alphabetical. '
            + 'Counts ORDERS, not uses. `meta.max_per_order` and `meta.max_length` carry the limits.',
          security: [{ bearerApiKey: [] }],
          responses: {
            '200': ok({ type: 'array', items: { type: 'object', properties: { tag: { type: 'string' }, count: { type: 'integer' }, color: { type: 'string' } } } }),
            '403': errRes('Your role cannot view orders'),
          },
        },
        patch: {
          summary: 'Rename a staff tag on every order that has it (commerce write)',
          description:
            'Each order is rewritten atomically and merged with any concurrent edit, but the whole '
            + 'rename is NOT one transaction: if it is interrupted some orders are renamed and some '
            + 'are not, and running it again finishes the job. Renaming onto a tag an order already '
            + 'has merges the two. `failed` counts orders that lost a race on every attempt — re-run to '
            + 'catch them. Audited with counts only.',
          security: [{ bearerApiKey: [] }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['from', 'to'], properties: { from: { type: 'string' }, to: { type: 'string', maxLength: 40 } } } } },
          },
          responses: {
            '200': ok({ type: 'object', properties: { tag: { type: 'string' }, changed: { type: 'integer' }, failed: { type: 'integer' } } }),
            '403': errRes('Commerce write permission required'),
            '422': errRes('Not a valid tag (reason order_tags.invalid; params.reason says why)'),
          },
        },
        delete: {
          summary: 'Remove a staff tag from every order that has it (commerce write)',
          description: 'Per-order atomic, not one transaction — see PATCH. Audited with counts only.',
          security: [{ bearerApiKey: [] }],
          parameters: [{ name: 'tag', in: 'query', required: true, schema: { type: 'string' } }],
          responses: {
            '200': ok({ type: 'object', properties: { changed: { type: 'integer' }, failed: { type: 'integer' } } }),
            '403': errRes('Commerce write permission required'),
            '422': errRes('Not a valid tag'),
          },
        },
      },
      '/api/orders/{id}/downloads': {
        get: {
          summary: 'One order\'s download entitlements, with the download log (staff only)',
          security: [{ bearerApiKey: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': ok({ type: 'object', properties: { id: { type: 'string' }, entitlements: { type: 'array', items: { $ref: '#/components/schemas/DownloadEntitlement' } } } }),
            '401': errRes('Not signed in'),
            '403': errRes('Your role cannot view orders'),
            '404': errRes('No such order'),
          },
        },
        post: {
          summary: 'Revoke, restore or reset an entitlement, or grant what a paid order is owed (commerce write)',
          description:
            '`{ "action": "revoke" | "restore" | "reset", "entitlement_id": "ent_…" }`, or `{ "action": "grant" }`. '
            + 'reset puts the count back to 0 and keeps the log. restore undoes any revocation; the download '
            + 'still requires the order to be processing or completed. grant creates entitlements for an order '
            + 'that reached a paid status without them (an import, an order older than this feature) and emails the buyer. Audited.',
          security: [{ bearerApiKey: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['action'], properties: { action: { type: 'string', enum: ['revoke', 'restore', 'reset', 'grant'] }, entitlement_id: { type: 'string' } } } } },
          },
          responses: {
            '200': ok({ type: 'object', properties: { id: { type: 'string' }, entitlements: { type: 'array', items: { $ref: '#/components/schemas/DownloadEntitlement' } } } }),
            '403': errRes('Commerce write permission required'),
            '404': errRes('No such order or entitlement'),
            '409': errRes('The order was erased'),
            '422': errRes('Unknown action or missing entitlement_id (downloads.invalid_action)'),
            '503': errRes('The order was changed by others on every attempt; safe to retry'),
          },
        },
      },
      '/api/downloads': {
        get: {
          summary: 'The buyer\'s downloads for one order, with freshly signed links',
          description:
            'Authorised by the RECEIPT token from the order confirmation email (`?receipt=`). For a headless '
            + 'storefront\'s own downloads page; the CMS /receipt page shows the same. Never returns a file\'s '
            + 'location or the download log. A bad token, an erased or cancelled order and an order without '
            + 'downloads all answer 404.',
          parameters: [{ name: 'receipt', in: 'query', required: true, schema: { type: 'string' } }],
          responses: {
            '200': ok({ type: 'array', items: { $ref: '#/components/schemas/BuyerDownload' } }),
            '404': errRes('No downloads for that receipt'),
          },
        },
      },
      '/api/downloads/{token}': {
        get: {
          summary: 'Download one purchased file through a signed link',
          description:
            'The token is an HMAC over the order, entitlement and file, valid for downloads_link_ttl_hours (24) '
            + 'or until the entitlement expires. Checked live: the order must be processing/completed and not '
            + 'refunded, the entitlement not revoked, not expired and under its limit. The download is COUNTED '
            + '(compare-and-set) before anything is sent. A private file is streamed as an attachment; an https '
            + 'or own-media file is a 302 to it — that URL is then visible to the buyer. HEAD checks the link '
            + 'and does not count. Refusals carry error.reason downloads.link_invalid | not_available | '
            + 'revoked | expired | limit_reached | file_missing | busy.',
          parameters: [{ name: 'token', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': { description: 'The file (private uploads), Content-Disposition: attachment', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } },
            '302': { description: 'Redirect to an externally hosted file, after every check passed' },
            '403': errRes('Invalid/expired link, not paid, revoked, expired, or limit reached (see error.reason)'),
            '404': errRes('The file is no longer available (downloads.file_missing)'),
            '429': errRes('Too many downloads from this address in a minute'),
          },
        },
      },
      '/api/downloads/upload': {
        post: {
          summary: 'Upload a file to sell as a product download, stored privately (catalogue staff)',
          description:
            'Multipart, field `file`. PDF, ZIP, EPUB, MP3, PNG, JPEG, GIF or WebP by magic bytes, up to '
            + 'DOWNLOAD_MAX_FILE_MB (100). Answers `private:pf_<id>` to put in a product\'s downloads[].url — '
            + 'no URL, because the file is served only through a buyer\'s signed link.',
          security: [{ bearerApiKey: [] }],
          requestBody: { required: true, content: { 'multipart/form-data': { schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } } } } },
          responses: {
            '201': ok({ type: 'object', properties: { url: { type: 'string' }, original_name: { type: 'string' }, mime_type: { type: 'string' }, size: { type: 'integer' } } }),
            '400': errRes('Empty, unsupported type, or infected'),
            '401': errRes('Not signed in'),
            '403': errRes('Your role cannot manage products'),
            '413': errRes('Larger than DOWNLOAD_MAX_FILE_MB'),
          },
        },
      },
      '/api/orders/{id}/tags': {
        get: {
          summary: 'One order\'s staff tags (staff only)',
          security: [{ bearerApiKey: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': ok({ $ref: '#/components/schemas/OrderTagList' }),
            '403': errRes('Your role cannot view orders'),
            '404': errRes('No such order'),
          },
        },
        post: {
          summary: 'Add staff tags to an order (commerce write)',
          description:
            'Send `{ "tag": "VIP" }` or `{ "tags": ["VIP", "Fragile"] }`. A tag is trimmed, '
            + 'whitespace-collapsed and at most 40 characters; tags are the same tag whatever '
            + 'their casing, and adding one the order already has is not an error. An order holds at '
            + 'most 10 — a request that would pass it is refused whole, nothing written '
            + '(reason order_tags.too_many). Decided against the list as it is when written, so two '
            + 'staff adding different tags at once both land. There is no "replace all" verb on '
            + 'purpose. Tags are never visible to buyers.',
          security: [{ bearerApiKey: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', properties: { tag: { type: 'string', maxLength: 40 }, tags: { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 40 } } } } } },
          },
          responses: {
            '200': ok({ $ref: '#/components/schemas/OrderTagList' }),
            '403': errRes('Commerce write permission required'),
            '404': errRes('No such order'),
            '409': errRes('The order was edited by others on every attempt (order_tags.busy); nothing was written, safe to retry'),
            '422': errRes('Invalid tag (order_tags.invalid) or more than 10 on the order (order_tags.too_many)'),
          },
        },
        delete: {
          summary: 'Remove one staff tag from an order (commerce write)',
          description: 'Any casing. Removing a tag the order does not have is a no-op, not an error.',
          security: [{ bearerApiKey: [] }],
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'tag', in: 'query', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '200': ok({ $ref: '#/components/schemas/OrderTagList' }),
            '403': errRes('Commerce write permission required'),
            '404': errRes('No such order'),
            '422': errRes('Not a valid tag'),
          },
        },
      },
      '/api/orders/{id}/timeline': {
        get: {
          summary: 'Everything that happened to one order, newest first (staff only)',
          description:
            'Placed, status changes (who, from, to), payments and refunds with amounts, shipping with '
            + 'tracking, staff notes and comments, tag edits, tax overrides. Part of it is derived from '
            + 'the order\'s own fields and part is stored on the order (`derived` says which). '
            + 'Status, payment-verdict, note, comment and tag events are recorded from the release that '
            + 'added this route: an older order shows what its own fields say, not a status history it '
            + 'never kept. `?filter=` is status, payments, shipments, notes, other, or all. '
            + '`?format=csv` returns the whole filtered list as a spreadsheet instead. Never visible to buyers.',
          security: [{ bearerApiKey: [] }],
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'filter', in: 'query', schema: { type: 'string', enum: ['all', 'status', 'payments', 'shipments', 'notes', 'other'] } },
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
            { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0, default: 0 } },
            { name: 'format', in: 'query', schema: { type: 'string', enum: ['json', 'csv'] } },
          ],
          responses: {
            '200': ok({ type: 'array', items: { $ref: '#/components/schemas/OrderTimelineItem' } }),
            '403': errRes('Your role cannot view orders'),
            '404': errRes('No such order'),
            '422': errRes('Unknown filter (order_timeline.invalid_filter)'),
          },
        },
        post: {
          summary: 'Add a staff comment to an order\'s timeline (commerce write)',
          description:
            'Send `{ "text": "Called the customer, collecting Tuesday" }` (at most 1000 characters). '
            + 'Appended atomically: two staff commenting at once both land. At most 100 stored events are '
            + 'kept per order; the oldest are dropped, and derived ones never are.',
          security: [{ bearerApiKey: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['text'], properties: { text: { type: 'string', maxLength: 1000 } } } } },
          },
          responses: {
            '200': ok({ $ref: '#/components/schemas/OrderTimelineItem' }),
            '403': errRes('Commerce write permission required'),
            '404': errRes('No such order'),
            '409': errRes('The order was being edited on every attempt (order_timeline.busy); nothing was written, safe to retry'),
            '422': errRes('Empty or over-long text (order_timeline.invalid, order_timeline.too_long)'),
          },
        },
      },
      '/api/orders/{id}/invoice-records': {
        get: {
          summary: 'An order\'s invoice and credit-memo records (staff only)',
          description:
            'Frozen, NON-FISCAL records: the lines, the VAT per rate, both parties with the buyer\'s VAT id, '
            + 'as charged. Each carries a `state`: draft, final, issuing, issued (with the issuer\'s number), '
            + 'issue_failed (with the issuer\'s message), issued_elsewhere or cancelled. AstroBaaS is not a '
            + 'fiscal device: the only document number a record carries is the one an issuer plugin returned.',
          security: [{ bearerApiKey: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': ok({ $ref: '#/components/schemas/InvoiceRecordList' }),
            '403': errRes('Your role cannot view orders'),
            '404': errRes('No such order'),
          },
        },
        post: {
          summary: 'Create, finalise, cancel, credit or mark an invoice record (admin)',
          description:
            '`action` (default `create`): `create` a record by hand (`finalise: true` makes it final; while the '
            + 'order has a live record nothing is created and that record is returned), `finalise` or `cancel` a '
            + 'draft, `credit` a final record in full (a correction — no money moves; then create a new one), '
            + '`issued_externally` (issued on the shop\'s POS or elsewhere, `number` optional — no issuer is ever '
            + 'called for it), `issue` (send to the issuer again after a failure). A final record is never edited. '
            + 'Two concurrent finalisations make ONE final record. Records are also made by themselves on '
            + 'payment or shipment (setting `invoice_record_on`) and a credit memo follows every refund.',
          security: [{ bearerApiKey: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', properties: {
              action: { type: 'string', enum: ['create', 'finalise', 'cancel', 'credit', 'issued_externally', 'issue'] },
              record_id: { type: 'string', description: 'Required for every action but create.' },
              finalise: { type: 'boolean' },
              number: { type: 'string', maxLength: 100, description: 'issued_externally only: the document number it was issued with.' },
            } } } },
          },
          responses: {
            '200': ok({ $ref: '#/components/schemas/InvoiceRecordList' }),
            '201': ok({ $ref: '#/components/schemas/InvoiceRecordList' }),
            '403': errRes('Administrator only'),
            '404': errRes('No such order or record'),
            '409': errRes('Not allowed in the record\'s state (invoice_records.conflict), or the records kept changing (invoice_records.busy)'),
            '422': errRes('Malformed request (invoice_records.invalid)'),
          },
        },
      },
      '/api/invoice-records/{id}/pdf': {
        get: {
          summary: 'One invoice or credit-memo record as a PDF',
          description:
            'Staff may open any record. A buyer opens a FINAL record of their own order with `?token=`, the '
            + 'receipt token from the confirmation email; anything else is a 404. Without an issuer the PDF says '
            + 'it is not a tax document and prints no document number; an internal reference, if the shop uses '
            + 'one, is labelled as not an invoice number.',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: '`<order id>.inv-<n>` or `<order id>.cm-<n>`' },
            { name: 'token', in: 'query', required: false, schema: { type: 'string' } },
          ],
          responses: {
            '200': { description: 'The PDF', content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } } },
            '404': { description: 'No such record, or not yours to see' },
          },
        },
      },
      '/api/orders/{id}/prescription': {
        delete: {
          summary: 'Remove one prescription from an order line (commerce write)',
          description:
            'Deletes ONLY the `prescription` field of the line named by `?line=<n>` (zero-based). '
            + 'The line keeps its name, quantity and money — those are the books. '
            + 'This exists because a prescription is Article 9 health data that this system '
            + 'deliberately RETAINS through a data-subject erasure: an optician has a '
            + 'professional obligation to keep the practitioner\'s prescription, and it is the '
            + 'record that settles a later dispute about a remake (Article 17(3)(b)). A '
            + 'retention obligation is not forever, and it is the optician who knows when a '
            + 'particular one has outlived it — so removal is one person, one record, one '
            + 'decision. There is no bulk endpoint on purpose. Audited as '
            + '`order.prescription.delete`, naming the order and the line and never the '
            + 'measurements. 404 when the line carries no prescription, so a second press '
            + 'reports the truth.',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'line', in: 'query', required: true, schema: { type: 'integer', minimum: 0 } },
          ],
          responses: {
            '200': { description: 'Removed' },
            '400': { description: 'line is missing or not a whole number' },
            '403': { description: 'Commerce write permission required' },
            '404': { description: 'No such order, line, or no prescription on it' },
          },
        },
      },
      '/api/orders/{id}/refund': {
        get: {
          summary: 'How much of an order is still refundable. ADMIN ONLY — refunds move money out of the business, so this is not an editor capability like the rest of commerce.',
          security: [{ bearerApiKey: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': ok({ type: 'object', properties: { total_cents: { type: 'integer' }, refunded_cents: { type: 'integer' }, refundable_cents: { type: 'integer' }, currency: { type: 'string' }, payment_status: { type: 'string' }, refunds: { type: 'array', items: { type: 'object' } } } }),
            '403': errRes('Admin only'),
            '404': errRes('Order not found'),
          },
        },
        post: {
          summary: 'Issue a refund through the payment provider. Admin only. Omit amount_cents to refund everything still outstanding — that remainder is computed from OUR records, not by asking the provider to refund "the rest". Partial refunds are supported and leave the order paid; only a full refund moves it to refunded (and returns stock).',
          security: [{ bearerApiKey: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: false,
            content: { 'application/json': { schema: { type: 'object', properties: { amount_cents: { type: 'integer', minimum: 1, description: 'Integer minor units. Omit for the full remaining amount.' } } } } },
          },
          responses: {
            '200': ok({ type: 'object', properties: { refund: { type: 'object' }, remaining_cents: { type: 'integer' } } }),
            '400': errRes('Amount is not a positive integer, or exceeds what remains refundable'),
            '403': errRes('Admin only'),
            '404': errRes('Order not found'),
            '409': errRes('Order is not paid, has no provider, or is already fully refunded'),
            '501': errRes('That provider does not support refunds from AstroBaaS'),
            '502': errRes('The provider refused the refund'),
          },
        },
      },
      '/api/legal/withdrawal': {
        get: {
          summary: 'EU right-of-withdrawal notice and the Annex I(B) model form, generated from the shop’s configured trader details. Public — a storefront must render this before checkout. Returns plain text to be escaped by the caller, never HTML.',
          responses: {
            '200': ok({ type: 'object', properties: { enabled: { type: 'boolean' }, withdrawal_days: { type: 'integer' }, trader: { type: 'object' }, instructions: { type: 'string' }, model_form: { type: 'string' }, order_button_label: { type: 'string', description: 'Art. 8(2) requires the order button to state the payment obligation. Use verbatim.' } } }),
            '503': errRes('Trader details are not configured yet, so no notice is published'),
          },
        },
      },
      '/api/legal/templates': {
        get: {
          summary: 'List the ready-made legal-page templates (privacy, terms, cookies, imprint, returns) per locale, with activation state and which business details are still missing.  [admin]',
          responses: { '200': ok({ type: 'array', items: { type: 'object' } }), '403': errRes('Admin only') },
        },
        post: {
          summary: 'Activate one template in one locale: creates a DRAFT page with the trader details substituted (missing ones as visible fill-in markers), linked into the translation set of sibling locales. The operator reviews and publishes.  [admin]',
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['id', 'locale'], properties: { id: { type: 'string' }, locale: { type: 'string', enum: ['en', 'el', 'de'] } } } } } },
          responses: {
            '201': ok({ type: 'object', properties: { id: { type: 'string' }, slug: { type: 'string' }, missing: { type: 'array', items: { type: 'string' } } } }),
            '400': errRes('Unknown template/locale, or a shop template on a non-shop'),
            '409': errRes('Already activated'),
          },
        },
      },
      '/api/assistant/chat': {
        post: {
          summary: 'Proxy a visitor message to the configured AI provider. Public. It is a proxy so the operator’s API key stays server-side and is never shipped to the browser. History roles are constrained to user/assistant — a "system" turn is dropped, so a visitor cannot rewrite the operator’s prompt. Rate-limited like every write.',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['message'], properties: { message: { type: 'string', maxLength: 4000 }, history: { type: 'array', items: { type: 'object', properties: { role: { type: 'string', enum: ['user', 'assistant'] }, content: { type: 'string' } } } } } } } },
          },
          responses: {
            '200': ok({ type: 'object', properties: { reply: { type: 'string' } } }),
            '400': errRes('Missing or over-long message'),
            '404': errRes('No assistant is configured on this install'),
            '502': errRes('The provider was unreachable or returned nothing'),
          },
        },
      },
      '/api/assistant/assist': {
        get: {
          summary: 'The editorial AI catalogue — which tasks exist, and whether an assistant is live at all (C-163, C-134). Requires a session with author_posts: this is the admin sibling of /api/assistant/chat, and unlike that route it is closed, because every run spends the operator’s own provider credit.',
          responses: {
            '200': ok({ type: 'object', properties: { live: { type: 'boolean' }, tasks: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' }, hint: { type: 'string' }, needsLocale: { type: 'boolean' } } } }, locales: { type: 'array', items: { type: 'string' } } } }),
            '401': errRes('No session'),
            '403': errRes('The role cannot write posts'),
          },
        },
        post: {
          summary: 'Run one editorial AI task over supplied text and return the suggestion. NEVER writes: the answer goes back to the caller and a person applies it — which is what makes "draft translation" safe to offer. HTML answers are sanitized and text answers have their tags removed before returning, because the provider base URL is an operator setting. Requires a session with author_posts.',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['task', 'text'], properties: { task: { type: 'string', enum: ['improve', 'shorten', 'excerpt', 'title', 'meta_description', 'translate'] }, text: { type: 'string', maxLength: 12000 }, locale: { type: 'string', description: 'Required for `translate`; must be a locale this install runs.' } } } } },
          },
          responses: {
            '200': ok({ type: 'object', properties: { task: { type: 'string' }, text: { type: 'string' } } }),
            '400': errRes('Unknown task, empty or over-long text, or a missing/unconfigured target locale'),
            '401': errRes('No session'),
            '403': errRes('The role cannot write posts'),
            '404': errRes('No assistant is configured, or the ai-assistant plugin is inactive'),
            '500': errRes('The provider was unreachable or returned nothing'),
          },
        },
      },
      '/api/payments': {
        get: {
          summary: 'Payment methods this install can take. Public. Read it before offering a method at checkout — an unconfigured provider is refused. Staff sessions additionally receive meta.providers naming any missing credentials (names only, never values).',
          responses: { '200': ok({ type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' }, kind: { type: 'string', enum: ['provider', 'manual'] } } } }) },
        },
      },
      '/api/payments/start': {
        post: {
          summary: 'Open a hosted-checkout session for an existing order and get the provider redirect URL. Public (anonymous buyers). Authorised by order_number + the email the order was placed with — number alone is not enough, since numbers are sequential. The amount is taken from the stored order, never from this request.',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['order_number', 'email', 'provider'], properties: { order_number: { type: 'string' }, email: { type: 'string' }, provider: { type: 'string', description: 'An id from GET /api/payments.' } } } } },
          },
          responses: {
            '200': ok({ type: 'object', properties: { redirect_url: { type: 'string' }, provider: { type: 'string' } } }),
            '400': errRes('Missing fields, or a provider that is unknown/not configured'),
            '404': errRes('No order matches that number + email'),
            '409': errRes('Order is already paid, cancelled, or refunded — or its payment hold has run out (reason payment.window_closed)'),
            '502': errRes('The provider refused or was unreachable'),
          },
        },
      },
      '/api/payments/webhook/{provider}': {
        post: {
          summary: 'Provider webhook receiver (Stripe/PayPal/Klarna call this). Public and CSRF-exempt because the caller is a machine; it authenticates itself by signature or by credentialled fetch-back, which is verified before anything changes. Not for client use.',
          parameters: [{ name: 'provider', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': { description: 'Verified. `applied` says whether it changed anything — a verified event about another install, a duplicate delivery, or a wrong amount is still 200 so the provider stops retrying.' },
            '401': { description: 'Signature verification failed. Nothing was changed.' },
            '404': { description: 'Provider unknown or not configured on this install.' },
            '429': { description: 'This address failed verification too often recently; refused before anything is verified. Retry-After says when.' },
          },
        },
      },
      '/api/orders': {
        get: {
          summary: 'List orders (staff only — orders contain PII)',
          security: [{ bearerApiKey: [] }],
          parameters: [
            { name: 'status', in: 'query', schema: { type: 'string' } },
            { name: 'tag', in: 'query', schema: { type: 'string' }, description: 'Only orders carrying this staff tag, any casing. A value that is not a valid tag matches nothing.' },
            { name: 'limit', in: 'query', schema: { type: 'integer' } },
            { name: 'offset', in: 'query', schema: { type: 'integer' } },
          ],
          responses: { '200': ok({ type: 'array', items: { $ref: '#/components/schemas/Order' } }) },
        },
        post: {
          summary: 'Place an order / checkout (anonymous, CSRF-protected same-origin or bearer key, rate-limited). Totals are computed server-side from stored prices. Per-order quantity caps apply — read the current values from GET /api/products (meta.max_qty_per_product, meta.max_items_per_order) rather than hard-coding them. Send an Idempotency-Key so a retry cannot place the order twice. The specific refusal is in error.reason.',
          parameters: [
            { name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string', minLength: 1, maxLength: 255 }, description: 'Per checkout attempt. A retry with the same key and body returns the original 201 (header Idempotent-Replayed: true) for 24 h.' },
          ],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['email', 'items'], properties: { email: { type: 'string' }, name: { type: 'string' }, phone: { type: 'string' }, address: { type: 'string' }, note: { type: 'string' }, pow_token: { type: 'string', description: 'Solved proof-of-work (challenge::nonce), required only when the shop enables the checkout anti-spam surface.' }, terms_accepted: { type: 'boolean', description: 'The buyer\'s answer to the Terms & Conditions box. Must be a real boolean. REQUIRED to be true only when the shop has switched `checkout_terms_required` on (read it, with the label and link, from GET /api/settings/get: checkout_terms_required, checkout_terms_label, checkout_terms_url); otherwise optional and stored as sent. Staff sessions are never refused for it.' }, privacy_accepted: { type: 'boolean', description: 'Optional privacy-policy consent, stored as sent. Never required.' }, attribution: { ...OrderAttribution, description: 'Optional campaign attribution from a headless storefront. Send it ONLY when the shopper granted marketing consent on your storefront. Validated strictly: unknown keys, non-text or over-long values, or an `at` that is not a time are a 422 naming the field. Times come from the shopper\'s device and are judged leniently: a future `at` is clamped to now, a touch older than 90 days is dropped, a first touch later than the last gives way to it — a wrong clock never refuses the order. Send one of first/last and it is used for both. Without this field, a checkout from the CMS\'s own pages uses the visitor\'s first-party `astrobaas_attribution` cookie, and only when the consent cookie grants marketing. Always validated; then not stored for staff sessions, for a browser whose own `astrobaas_consent` cookie on this site refuses marketing, or while the shop has switched attribution off.' }, items: { type: 'array', items: { type: 'object', required: ['product_id', 'qty'], properties: { product_id: { type: 'string' }, variant_id: { type: 'string' }, qty: { type: 'integer' }, prescription: { type: 'object', description: 'Per-line prescription, when the product requires one (validated by the optical module).' }, addons: lineAddonsRequest } } } } } } },
          },
          responses: {
            '201': ok({ type: 'object' }),
            '500': errRes('An add-on plugin failed or returned an invalid result (reason checkout.addons_failed). Fail closed: the order is not placed and nothing is charged.'),
            '400': errRes('Invalid payload, unavailable product, an order limit exceeded, refused add-ons (reason checkout.addons_invalid / addons_unsupported / addons_unpriced, or the plugin\'s own), a refused coupon (reason checkout.coupon_invalid), terms not accepted while the shop requires them (reason checkout.terms_not_accepted), or a malformed Idempotency-Key'),
            '403': errRes('Proof-of-work required and missing or invalid (reason checkout.captcha_failed)'),
            '409': errRes('Insufficient stock — another buyer took the units first. Safe to retry with a smaller quantity. Also: IDEMPOTENCY_IN_PROGRESS, or checkout.promotion_unavailable.'),
            '422': errRes('Invalid payload fields (e.g. email, or terms_accepted / privacy_accepted that is not a boolean), or an Idempotency-Key reused with a different body (IDEMPOTENCY_KEY_REUSED)'),
            '429': errRes('Too many unpaid orders for this buyer (reason checkout.too_many_unpaid); Retry-After is set'),
          },
        },
      },
      '/api/orders/{id}': {
        get: {
          summary: 'Fetch one order (staff only)', security: [{ bearerApiKey: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': ok({ $ref: '#/components/schemas/Order' }) },
        },
        put: {
          summary: 'Update order status/note (staff only). Moving to cancelled/refunded returns the stock; moving back out re-takes it.',
          description: 'Body fields: `status`, `note` (the customer\'s note), `staff_note` (the shop\'s own). An empty-string `staff_note` CLEARS the note (a client that always sends the field with an empty value will clear it); omit the field to leave it alone. `note: ""` is read as "not sent". Changes are recorded on the order\'s timeline (GET /api/orders/{id}/timeline); the response never carries the timeline.',
          security: [{ bearerApiKey: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': ok({ $ref: '#/components/schemas/Order' }),
            '404': errRes('Order not found'),
            '409': errRes('Cannot reopen a cancelled order — its stock has since been sold'),
          },
        },
      },
      '/api/customers': {
        get: {
          summary: 'List customers (staff only — PII), newest first. Paged like GET /api/orders: response meta carries total, count, limit, offset, page and hasMore.',
          security: [{ bearerApiKey: [] }],
          parameters: [
            { name: 'search', in: 'query', schema: { type: 'string' }, description: 'Matches email, name or phone; accent- and case-insensitive.' },
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
            { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0, default: 0 } },
          ],
          responses: { '200': ok({ type: 'array', items: { type: 'object' } }) },
        },
        post: {
          summary: 'Create a customer (staff only)', security: [{ bearerApiKey: [] }],
          responses: { '201': ok({ type: 'object' }) },
        },
      },
      '/api/content/{type}/{id}': {
        get: {
          summary: 'Fetch one custom-content entity (public read)',
          parameters: [
            { name: 'type', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: { '200': ok({ type: 'object' }) },
        },
        put: {
          summary: 'Replace a custom-content entity (admin/editor)',
          security: [{ bearerApiKey: [] }],
          parameters: [
            { name: 'type', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          ],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
          responses: { '200': ok({ type: 'object' }) },
        },
        delete: {
          summary: 'Delete a custom-content entity (admin/editor)',
          security: [{ bearerApiKey: [] }],
          parameters: [
            { name: 'type', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: { '200': ok({ type: 'object' }) },
        },
      },
      '/api/plugins': {
        get: {
          summary: 'List plugins with activation state (admin)',
          description: 'Includes both tiers: kind:"bundled" (compiled in) and kind:"declarative" (installed from a manifest, removable).',
          security: [{ bearerApiKey: [] }],
          responses: { '200': ok({ type: 'array', items: { type: 'object' } }) },
        },
      },
      '/api/forms/{type}/upload': {
        post: {
          summary: 'Attach a file to a public form submission (public)',
          description:
            'Multipart. Anonymous, rate-limited to 5 per 15 minutes per address, and 404 unless the type accepts public writes AND declares a `file` field. The bytes are written OUTSIDE public/uploads and are readable only through GET /api/forms/file/{id}, which requires a session — a content type marked staff-only collecting CVs or prescriptions must not publish them at a guessable URL. The answer carries an id and never a URL: an endpoint that returned a fetchable link would be a public file host with an upload form.',
          parameters: [
            { name: 'type', in: 'path', required: true, schema: { type: 'string' } },
          ],
          requestBody: {
            required: true,
            content: {
              'multipart/form-data': {
                schema: {
                  type: 'object',
                  properties: {
                    file: { type: 'string', format: 'binary' },
                    pow_token: { type: 'string', description: 'The anti-spam answer from /captcha.js.' },
                    hp_url: { type: 'string', description: 'Honeypot. Must be empty.' },
                  },
                },
              },
            },
          },
          responses: {
            '201': ok({
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Store this in the record\'s file field.' },
                original_name: { type: 'string' },
                size: { type: 'integer' },
              },
            }),
            '400': errRes('The file was missing, too large, or not an accepted type'),
            '404': errRes('No such form, or it takes no file attachments'),
            '429': errRes('Too many uploads from this address'),
          },
        },
      },
      '/api/forms/file/{id}': {
        get: {
          summary: 'Download a file attached to a submission (staff)',
          description:
            'Staff only, and that is the whole reason the bytes were written outside public/uploads. Served as an attachment with X-Content-Type-Options: nosniff and Cache-Control: private, no-store — a stranger\'s PDF must not render inline in the same origin as the admin, and it must not sit in a proxy cache.',
          security: [{ bearerApiKey: [] }],
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '200': { description: 'The file.', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } },
            '404': errRes('No such file, or the caller is not signed in'),
          },
        },
      },
      '/api/forms/{type}': {
        get: {
          summary: 'The form schema for one content type (public)',
          description:
            'What a headless storefront needs to DRAW a form: the label, the fields, the steps and the conditions, plus the names of the honeypot and anti-spam fields. Public, but only for a type whose write policy is public — anything else answers 404, the same 404 an unknown name gets, so this cannot be used to enumerate what a site stores. The conditions are presentation only: the server re-evaluates every one of them on submission, so a caller that ignores this document gets the same answer.',
          parameters: [
            { name: 'type', in: 'path', required: true, schema: { type: 'string' }, description: 'Content type name.' },
          ],
          responses: {
            '200': ok({
              type: 'object',
              properties: {
                name: { type: 'string' },
                label: { type: 'string' },
                labelPlural: { type: 'string', nullable: true },
                steps: { type: 'array', nullable: true, items: { type: 'object', properties: { title: { type: 'string' } } } },
                stepCount: { type: 'integer' },
                fields: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      name: { type: 'string' },
                      rule: { type: 'object' },
                      step: { type: 'integer' },
                      showIf: {
                        type: 'object', nullable: true,
                        properties: { field: { type: 'string' }, equals: {} },
                      },
                    },
                  },
                },
                honeypot: { type: 'string' },
                powField: { type: 'string' },
                submitTo: { type: 'string' },
              },
            }),
            '404': errRes('No such form, or that type does not accept public submissions'),
          },
        },
      },
      '/api/newsletter/campaigns': {
        get: {
          summary: 'Campaigns, the subscriber count, and whether mail can leave (staff)',
          description:
            '`emailChannelReady` is returned so a composer can say "this cannot be delivered" BEFORE somebody writes a newsletter, rather than after they press Send.',
          security: [{ bearerApiKey: [] }],
          responses: { '200': ok({ type: 'object' }) },
        },
        post: {
          summary: 'Save a draft, or start sending (staff)',
          description:
            'Sending is a STATE CHANGE, not a loop: this sets status to "sending" and returns, and the scheduler sends a batch at a time from a cursor on the record. A request that looped over the whole list would hold a connection open for minutes, lose everything if the client hung up, and restart from the beginning after a deploy — and sending a newsletter twice is the failure people remember. Each batch is claimed (the cursor moved by a compare-and-set) BEFORE it is sent, so two processes never send the same batch; a process stopped mid-batch leaves those addresses counted in the campaign\'s `unconfirmed_count` rather than sending them again. Every message carries List-Unsubscribe and List-Unsubscribe-Post, which is what makes mail clients offer a one-click unsubscribe instead of routing the message toward the spam button.',
          security: [{ bearerApiKey: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    subject: { type: 'string' },
                    body: { type: 'string' },
                    send: { type: 'boolean', description: 'Absent or false saves a draft.' },
                  },
                },
              },
            },
          },
          responses: {
            '201': ok({ type: 'object' }),
            '400': errRes('Nothing to send, nobody to send to, or no way to deliver it'),
          },
        },
      },
      '/api/backup/run': {
        post: {
          summary: 'Run the off-site backup now (admin)',
          description:
            'Calls the SAME function the scheduler calls — not a second path that does roughly the same thing, because a manual run that succeeded while the scheduled one had been failing for a month would be actively misleading. Refuses with an explanation when no off-site destination is configured, which is a state rather than an error.',
          security: [{ bearerApiKey: [] }],
          responses: {
            '200': ok({ type: 'object' }),
            '400': errRes('No off-site destination is configured'),
          },
        },
      },
      '/api/roles/capabilities': {
        get: {
          summary: 'What each role may do (admin)',
          description:
            'The capability list, every role with its BUILT-IN grants and its EFFECTIVE ones, and the operator\'s overrides. `admin` is listed so a matrix can show it as fixed rather than leaving the reader wondering where it went — it is not editable, because an operator who switched off their own last capability would be locked out of the screen that switches it back on and there is no CLI verb to repair it.',
          security: [{ bearerApiKey: [] }],
          responses: { '200': ok({ type: 'object' }) },
        },
        put: {
          summary: 'Change what a role may do (admin)',
          description:
            'The WHOLE override table, not a patch — the matrix edits the whole thing and a partial write can express a grant but not a revocation. Only the four editable roles and the known capabilities survive; anything else is dropped rather than refused, because a table that failed to load after a capability was renamed would take every other override down with it. An entry equal to the built-in grant is dropped too, so the table holds only real differences. Audited as role.capabilities.update. NOT custom role NAMES: a name the routes have never heard silently answers "no" everywhere, producing a role that can sign in and do nothing.',
          security: [{ bearerApiKey: [] }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', properties: { overrides: { type: 'object' } } } } },
          },
          responses: { '200': ok({ type: 'object' }) },
        },
      },
      '/api/content-types': {
        get: {
          summary: 'Every registered content type with its field schema (staff)',
          description:
            'Plugin-defined and admin-defined types together, each marked with its source. Staff-only: a field schema is a map of what the business stores.',
          security: [{ bearerApiKey: [] }],
          responses: { '200': ok({ type: 'array', items: { $ref: '#/components/schemas/ContentTypeDef' } }) },
        },
        put: {
          summary: 'Replace the admin-defined content types (admin)',
          description:
            'The whole set, not a patch — the builder edits the whole set, and a partial write can express neither a rename nor a delete. Definitions are validated as hard as a hostile plugin manifest; the plugin bootstrap re-runs on success, so a new type answers at /api/content/<name> on the next request. A name a plugin already registered stays the plugin\'s.',
          security: [{ bearerApiKey: [] }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/ContentTypeDef' }, maxItems: 20 } } },
          },
          responses: {
            '200': ok({ type: 'array', items: { $ref: '#/components/schemas/ContentTypeDef' } }),
            '422': errRes('A definition would not work — every problem is named by position'),
          },
        },
      },
      '/api/health/deep': {
        get: {
          summary: 'Deep health check (admin session, or Authorization: Bearer $HEALTH_TOKEN)',
          description:
            'Exercises what a shallow check only introspects: it ENCODES a test image rather than reporting that the module is present, writes and removes a probe file in the uploads directory, counts on the real rate-limit store, and writes to the database. Also reports whether public_site_url is set, and which plugins were requested versus actually loaded.\n\nReturns 503 when any essential check fails, so `curl -fsS` is a sufficient assertion in a deploy script. 404 — not 403 — when unauthenticated: whether this endpoint exists is itself information.\n\n`?write=0` skips the database write probe, which rewrites the whole document on the lowdb and libSQL doc drivers; use it for a frequent poller.',
          parameters: [
            { name: 'write', in: 'query', schema: { type: 'string', enum: ['0', '1'] }, description: 'Set to 0 to skip the database write probe.' },
          ],
          responses: {
            '200': {
              description: 'Every essential check passed. Warnings may still be present.',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/DeepHealth' } } },
            },
            '404': errRes('No admin session and no valid HEALTH_TOKEN'),
            '503': {
              description: 'At least one essential check failed.',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/DeepHealth' } } },
            },
          },
        },
      },
      '/api/import/wordpress': {
        post: {
          summary: 'Import a WordPress export (admin only)',
          description:
            'Upload a WXR file. DRY RUN BY DEFAULT: the response reports what would be created, skipped and redirected, and nothing is written until dry_run=false is sent. Posts, pages, categories and 301 redirects for the URLs that moved are created; author accounts are never created — the logins found in the export are reported so an operator can invite the real people. Re-running the same export is safe: items already imported are skipped rather than duplicated. Exports over the upload ceiling belong on the CLI (scripts/import-wp.mjs), which has no size cap.',
          security: [{ bearerApiKey: [] }],
          requestBody: {
            required: true,
            content: {
              'multipart/form-data': {
                schema: {
                  type: 'object',
                  required: ['file'],
                  properties: {
                    file: { type: 'string', format: 'binary', description: 'The WordPress WXR export (.xml)' },
                    dry_run: { type: 'string', description: 'Send "false" to actually perform the import. Defaults to a rehearsal.' },
                    include_pages: { type: 'string', description: 'Default true.' },
                    include_media: { type: 'string', description: 'List the media library in the plan. Default true.' },
                    include_trash: { type: 'string', description: 'Import what WordPress had in the bin. Default false.' },
                    fetch_media: { type: 'string', description: 'Download the files from the old site. Default false; capped per request.' },
                    extra_types: { type: 'string', description: 'Comma-separated custom post types to import as posts, e.g. "portfolio,recipe".' },
                  },
                },
              },
            },
          },
          responses: {
            '200': ok({
              type: 'object',
              properties: {
                dryRun: { type: 'boolean' },
                createdPosts: { type: 'integer' },
                createdPages: { type: 'integer' },
                createdCategories: { type: 'integer' },
                createdRedirects: { type: 'integer' },
                importedMedia: { type: 'integer' },
                summary: { type: 'string' },
                skipped: {
                  type: 'array',
                  description: 'Every item not written, each with a reason. Nothing is dropped silently.',
                  items: { type: 'object', properties: { title: { type: 'string' }, reason: { type: 'string' } } },
                },
                failed: {
                  type: 'array',
                  items: { type: 'object', properties: { title: { type: 'string' }, reason: { type: 'string' } } },
                },
                authors: {
                  type: 'array',
                  description: 'Author logins found in the export. Reported only — no accounts are created.',
                  items: { type: 'object', properties: { login: { type: 'string' }, email: { type: 'string' }, displayName: { type: 'string' } } },
                },
                source_site: { type: 'string' },
              },
            }),
          },
        },
      },
      '/api/redirects': {
        get: {
          summary: 'The legacy-URL redirect map (admin/editor/manager)',
          description:
            'Rules that rescue old or mistyped addresses. Per-site data, not code: a manager fixes a dead URL without a deploy, and a new rule is live on the next request.',
          security: [{ bearerApiKey: [] }],
          responses: { '200': ok({ type: 'array', items: { $ref: '#/components/schemas/RedirectRule' } }) },
        },
        post: {
          summary: 'Create a redirect rule (admin/editor/manager)',
          description:
            'Refused if the rule could reach /admin or /api, if it would swallow the whole site, or if following it would loop back to itself. A 410 rule carries no destination and is never turned into a redirect.',
          security: [{ bearerApiKey: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['match', 'status'],
                  properties: {
                    match: { type: 'string', description: 'Exact /old/page, prefix /old/*, or one wildcard segment /shop/*/reviews' },
                    target: { type: 'string', description: 'Destination. $1 expands to whatever the wildcard captured. Empty for 410.' },
                    status: { type: 'integer', enum: [301, 302, 410] },
                    enabled: { type: 'boolean' },
                    notes: { type: 'string', maxLength: 500 },
                  },
                },
              },
            },
          },
          responses: {
            '201': ok({ $ref: '#/components/schemas/RedirectRule' }),
            '422': errRes('The rule would not work — the reason is given per field'),
          },
        },
      },
      '/api/redirects/{id}': {
        put: {
          summary: 'Update a redirect rule (admin/editor/manager)',
          security: [{ bearerApiKey: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', properties: { match: { type: 'string' }, target: { type: 'string' }, status: { type: 'integer', enum: [301, 302, 410] }, enabled: { type: 'boolean' }, notes: { type: 'string' } } } } },
          },
          responses: { '200': ok({ $ref: '#/components/schemas/RedirectRule' }), '404': errRes('No such rule') },
        },
        delete: {
          summary: 'Delete a redirect rule (admin/editor/manager)',
          security: [{ bearerApiKey: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': ok({ type: 'object' }), '404': errRes('No such rule') },
        },
      },
      '/api/not-found': {
        get: {
          summary: 'Addresses that led nowhere, and what they cost (admin/editor/manager)',
          description:
            'Sorted by PAID hits by default — requests that arrived carrying a Google Shopping or Ads click id are money already spent that landed on nothing. Staff-only: a list of every address a stranger has probed is reconnaissance if it leaks.',
          security: [{ bearerApiKey: [] }],
          parameters: [
            { name: 'sort', in: 'query', schema: { type: 'string', enum: ['paid', 'hits', 'recent'], default: 'paid' } },
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 50, maximum: 500 } },
          ],
          responses: { '200': ok({ type: 'array', items: { $ref: '#/components/schemas/NotFoundRecord' } }) },
        },
        delete: {
          summary: 'Clear the dead-address log (admin/editor/manager). Redirect rules are not affected.',
          security: [{ bearerApiKey: [] }],
          responses: { '200': ok({ type: 'object', properties: { cleared: { type: 'boolean' } } }) },
        },
      },
      '/api/recovery/match': {
        get: {
          summary: 'What might this dead address have meant? Public.',
          description:
            'Ranks active products, categories and brands against the words in a path, comparing in both Greek and Latin so a percent-encoded Greek URL finds a transliterated slug and the reverse. Returns an EMPTY list rather than padding with weak guesses. Public because a decoupled storefront renders its own recovery page for a visitor who is not logged in; it exposes only what /api/products already publishes anonymously. Answering 200 means the LOOKUP succeeded — the page that calls it must still answer 404.',
          parameters: [
            { name: 'path', in: 'query', required: true, schema: { type: 'string' } },
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 8, maximum: 24 } },
          ],
          responses: {
            '200': ok({ type: 'array', items: { type: 'object', properties: { kind: { type: 'string', enum: ['product', 'category', 'brand'] }, id: { type: 'string' }, name: { type: 'string' }, slug: { type: 'string' }, url: { type: 'string' }, score: { type: 'integer' }, matched: { type: 'array', items: { type: 'string' } } } } }),
            '400': errRes('path is required'),
          },
        },
      },
      '/api/webhooks/{id}': {
        delete: {
          summary: 'Delete a webhook (admin)',
          security: [{ bearerApiKey: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': ok({ type: 'object' }) },
        },
      },
      '/api/commerce/import': {
        post: {
          summary: 'Bulk catalogue upsert — categories + products (admin/editor)',
          description:
            'Rows are matched by slug; invalid rows are skipped and reported rather than failing the batch. `replace: true` wipes the existing catalogue first. Capped at 1000 categories / 10000 products. Governed by the `products` scope for bearer keys.',
          security: [{ bearerApiKey: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    replace: { type: 'boolean' },
                    categories: { type: 'array', items: { type: 'object' } },
                    products: { type: 'array', items: { type: 'object' } },
                  },
                },
              },
            },
          },
          responses: { '200': ok({ type: 'object' }) },
        },
      },
      '/api/stats/orders-this-month': {
        get: {
          summary: 'Paid orders placed this month (opt-in, public)',
          description: 'One number for a storefront\'s social proof: orders with payment_status "paid", counted by the month they were placed in the shop timezone (setting shop_timezone, default UTC). 404 — the same answer as an unknown path — unless the setting public_order_stats_enabled is on. Never revenue, amounts or anything per customer. Cache-Control: public, max-age=60. A scoped API key needs stats:read.',
          responses: {
            '200': ok({
              type: 'object',
              properties: {
                count: { type: 'integer', minimum: 0 },
                month: { type: 'string', pattern: '^\\d{4}-\\d{2}$', description: 'YYYY-MM in the shop timezone.' },
              },
              required: ['count', 'month'],
            }),
            '404': { description: 'The counter is switched off (or the shop is).' },
          },
        },
      },
      '/api/locales': {
        get: {
          summary: 'Languages this site serves (public)',
          description: 'Use the returned codes with ?locale= on list endpoints, or as a /<locale>/ URL prefix. The default locale is never prefixed.',
          responses: { '200': ok({ type: 'object' }) },
        },
      },
      '/api/posts/{ref}/revisions': {
        get: {
          summary: 'Revision history for a post (session required)',
          description: 'Newest first. Revisions contain UNPUBLISHED draft text, so this is never public: admins/editors see any post, authors only their own.',
          security: [{ bearerApiKey: [] }],
          parameters: [
            { name: 'ref', in: 'path', required: true, schema: { type: 'string' }, description: 'Post id or slug.' },
            { name: 'limit', in: 'query', schema: { type: 'integer' } },
          ],
          responses: { '200': ok({ type: 'array', items: { type: 'object' } }) },
        },
        post: {
          summary: 'Autosave a draft revision (does NOT publish)',
          description: 'Stores a snapshot without modifying the live post. An identical consecutive snapshot is skipped (returns saved:false).',
          security: [{ bearerApiKey: [] }],
          parameters: [{ name: 'ref', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: false,
            content: { 'application/json': { schema: { type: 'object', properties: { title: { type: 'string' }, content: { type: 'string' }, excerpt: { type: 'string' } } } } },
          },
          responses: { '201': ok({ type: 'object' }) },
        },
      },
      '/api/posts/{ref}/restore': {
        post: {
          summary: 'Restore a post from a revision',
          description: 'Goes through the normal update path, so the content is re-sanitized and the current state is snapshotted first — restoring is undoable.',
          security: [{ bearerApiKey: [] }],
          parameters: [{ name: 'ref', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['revision_id'], properties: { revision_id: { type: 'string' } } } } },
          },
          responses: { '200': ok({ type: 'object' }) },
        },
      },
      '/api/posts/{ref}/related': {
        get: {
          summary: 'Posts related to this one',
          description:
            'The related-articles strip, for a front end this CMS does not render. Scored on '
            + 'shared categories and tags, best first, and EMPTY when nothing is genuinely '
            + 'related — it never falls back to "latest", because a recommendation the caller '
            + 'cannot trust is worse than none. `limit` defaults to the shop\'s '
            + '`related_posts_count` setting (3 unless changed, capped at 12), resolved through '
            + 'the same helper the server-rendered blog uses so the two cannot answer '
            + 'differently. Returns a SUMMARY per post — no rendered bodies — and deliberately '
            + 'records no view: crediting one to every article merely listed as a suggestion '
            + 'would inflate the analytics. 404 both when the post does not exist and when the '
            + 'caller may not see it.',
          parameters: [
            { name: 'ref', in: 'path', required: true, schema: { type: 'string' }, description: 'Post id or slug' },
            { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 0, maximum: 12 } },
          ],
          responses: {
            '200': { description: 'Related posts, best first; may be an empty list' },
            '404': { description: 'No such post, or not visible to this caller' },
          },
        },
      },
      '/api/posts/{ref}/duplicate': {
        post: {
          summary: 'Duplicate a post or page',
          description:
            'Creates a copy as a DRAFT — duplicating a published post must never publish a second copy of it. '
            + 'The copy is owned by the caller, gets a unique slug, and starts with no revisions, zero views and no `translation_of` '
            + '(carrying it would file the copy as another translation of the same original). Editors and admins may copy any post; an author only their own.',
          security: [{ bearerApiKey: [] }],
          parameters: [{ name: 'ref', in: 'path', required: true, schema: { type: 'string' }, description: 'Post id or slug' }],
          responses: {
            '201': ok({ type: 'object' }),
            '403': errRes('Not permitted to copy this post'),
            '404': errRes('No such post'),
          },
        },
      },
      '/api/themes/install': {
        post: {
          summary: 'Install or upgrade a declarative theme manifest (admin)',
          description:
            'The manifest is DATA — design tokens, a stylesheet and section patterns — fully validated before storage; nothing is executed and no rebuild is needed. '
            + 'Colours must be hex and `style` values must be token keys, so a stored value can select CSS but never be CSS. '
            + 'A pattern whose markup the content sanitizer would rewrite is refused, and the 422 carries the submitted markup beside the sanitized output. '
            + 'Installing does not activate: use POST /api/themes/activate. An upgrade preserves the operator\'s customized tokens and the active flag.',
          security: [{ bearerApiKey: [] }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['manifest'], properties: { manifest: { type: 'object' }, source: { type: 'string' } } } } },
          },
          responses: { '201': ok({ type: 'object' }), '422': errRes('Invalid theme manifest'), '403': errRes('Admin only') },
        },
        delete: {
          summary: 'Uninstall a declarative theme (admin)',
          description: 'Bundled (compiled-in) themes cannot be uninstalled here, and the ACTIVE theme is refused — activate another first so the replacement is a deliberate choice.',
          security: [{ bearerApiKey: [] }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } } },
          },
          responses: { '200': ok({ type: 'object' }), '400': errRes('Bundled, active, or not a manifest theme') },
        },
      },
      '/api/plugins/install': {
        post: {
          summary: 'Install a declarative plugin manifest (admin)',
          description:
            'The manifest is DATA and is fully validated before storage; nothing is executed. Takes effect in the serving process without a restart. '
            + 'Installing with a declared dependency unmet is ALLOWED — an operator cannot be made to install in topological order — and the 201 response carries `unmet_dependencies` describing what is still needed. Activation is what refuses.',
          security: [{ bearerApiKey: [] }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['manifest'], properties: { manifest: { type: 'object' }, source: { type: 'string' } } } } },
          },
          responses: { '201': ok({ type: 'object' }) },
        },
        delete: {
          summary: 'Uninstall a declarative plugin (admin)',
          description:
            'Bundled (compiled-in) plugins cannot be uninstalled here. Refused with 400 while an ACTIVE plugin declares a dependency on this one; the response names the dependents. An inactive dependent does not block.',
          security: [{ bearerApiKey: [] }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } } },
          },
          responses: { '200': ok({ type: 'object' }) },
        },
      },
      '/api/plugins/registry': {
        get: {
          summary: 'Browse the curated plugin registry (admin)',
          description: 'Without ?id, returns the index. With ?id=<plugin>, returns that manifest after verifying its SHA-256. Browsing never installs.',
          security: [{ bearerApiKey: [] }],
          parameters: [{ name: 'id', in: 'query', schema: { type: 'string' } }],
          responses: { '200': ok({ type: 'object' }) },
        },
      },
      '/api/2fa/setup': {
        post: {
          summary: 'Begin TOTP enrollment (session)',
          description: 'Returns a base32 secret + otpauth URI. 2FA is not active until confirmed via /api/2fa/enable.',
          security: [{ bearerApiKey: [] }],
          responses: { '200': ok({ type: 'object' }) },
        },
      },
      '/api/2fa/enable': {
        post: {
          summary: 'Confirm TOTP enrollment (session)',
          description: 'Verifies a code against the pending secret and returns one-time backup codes, shown only here.',
          security: [{ bearerApiKey: [] }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['code'], properties: { code: { type: 'string' } } } } } },
          responses: { '200': ok({ type: 'object' }) },
        },
      },
      '/api/2fa/disable': {
        post: {
          summary: 'Disable two-factor (session; requires a current or backup code)',
          security: [{ bearerApiKey: [] }],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['code'], properties: { code: { type: 'string' } } } } } },
          responses: { '200': ok({ type: 'object' }) },
        },
      },
      '/api/i18n/status': {
        get: {
          summary: 'What is still to translate (staff)',
          description:
            'A multilingual site keeps translations in two shapes — one record per language for articles (linked by translation_of), one record with an i18n sidecar for products — so "what is missing in German?" cannot be answered by looking at either alone. This answers it across both. An article written directly in a non-default language is NOT counted as a gap in the default one. The `partial` list is the case nothing else reports: a product with a translated name and an untranslated description, which has a sidecar entry for the locale and therefore reads as done to any check that looks for the key.',
          security: [{ bearerApiKey: [] }],
          responses: {
            '200': ok({
              type: 'object',
              properties: {
                defaultLocale: { type: 'string' },
                locales: { type: 'array', items: { type: 'string' } },
                posts: { type: 'array', items: { type: 'object' } },
                products: { type: 'array', items: { type: 'object' } },
                partial: { type: 'array', items: { type: 'object' } },
              },
            }),
            '403': { description: 'Your role cannot see the backlog' },
          },
        },
      },
      '/api/operations': {
        get: {
          summary: 'What the scheduler and the mailer have been doing (admin only)',
          description:
            'Answers the two questions that previously needed server logs: why a scheduled post has not gone live, and whether an email actually went out. The scheduler section reports whether the worker is running IN THIS PROCESS — not merely enabled in the environment, which is a different thing and only the first one publishes anything — plus how many posts are waiting, how many are overdue, and the last sweep\'s error if it had one. The email section reports the active transport and a bounded log of recent sends: recipient, subject, transport and outcome. The BODY is never stored; password-reset and sign-in links go through the same sender, and a log holding those would be a list of live credentials readable by every admin. Because the log holds recipient addresses it is personal data, and /api/privacy/subject searches and erases it with everything else.',
          security: [{ bearerApiKey: [] }],
          parameters: [{ name: 'limit', in: 'query', required: false, schema: { type: 'integer', maximum: 500 } }],
          responses: {
            '200': ok({
              type: 'object',
              properties: {
                scheduler: {
                  type: 'object',
                  properties: {
                    enabled: { type: 'boolean' },
                    intervalMs: { type: 'integer' },
                    startedAt: { type: 'string', nullable: true, description: 'Null when the worker never started in this process.' },
                    lastRunAt: { type: 'string', nullable: true },
                    lastPublished: { type: 'integer' },
                    lastCancelled: { type: 'integer' },
                    lastError: { type: 'string', nullable: true },
                    scheduled: { type: 'integer' },
                    overdue: { type: 'integer' },
                    role: {
                      type: 'string', nullable: true, enum: ['leader', 'follower', 'standalone', 'stopped'],
                      description: 'With several processes on one database only the holder of the scheduler lease sweeps: `leader` is this process, `follower` means another one is (see `lease.currentHolder`), `standalone` means SCHEDULER_LEASE=0. Null when the worker never started here.',
                    },
                    sweeps: { type: 'integer', description: 'Sweeps this process has run since it started.' },
                    lease: { type: 'object', nullable: true, description: 'The scheduler lease as this process last saw it: holder, leading, currentHolder, expiresAt, since, ttlMs, lastError.' },
                  },
                },
                backup: {
                  type: 'object',
                  description: 'The off-site backup. `last`, `lastSuccess` and `inProgress` come from the database, so they survive a restart and are the same on every process.',
                  properties: {
                    configured: { type: 'boolean' },
                    target: { type: 'string' },
                    everyHours: { type: 'number' },
                    keep: { type: 'integer' },
                    last: { type: 'object', nullable: true },
                    lastSuccess: { type: 'object', nullable: true },
                    inProgress: { type: 'object', nullable: true, description: 'An attempt that started and has not recorded an outcome — on any process.' },
                    due: { type: 'boolean' },
                  },
                },
                email: {
                  type: 'object',
                  properties: {
                    channelActive: { type: 'boolean' },
                    transport: { type: 'string' },
                    recent: { type: 'array', items: { type: 'object' } },
                  },
                },
              },
            }),
            '403': { description: 'Administrators only' },
          },
        },
      },
      '/api/media/replace': {
        post: {
          summary: 'Swap the file behind a media record, keeping the record',
          description:
            'The record keeps its id, alt text, uploader and creation date, so everything that references it by id shows the new file at once. The new bytes get their own content-addressed URL — uploads are served `immutable` for a year, so writing over the old path would leave browsers and CDNs serving the old file for months — and every stored reference to the old URLs is rewritten in post and page content and in product images. Old files are unlinked, EXCEPT any another record still points at (identical bytes share one path). Replacing a file with the bytes it already has is a no-op. The replacement goes through the same sniffing, SVG sanitization, EXIF stripping and derivative generation as an upload. Same permission rule as deleting: editors and admins may replace anything, others only their own uploads. Audited, because it rewrites stored content.',
          security: [{ bearerApiKey: [] }],
          requestBody: {
            required: true,
            content: {
              'multipart/form-data': {
                schema: {
                  type: 'object',
                  required: ['id', 'file'],
                  properties: {
                    id: { type: 'string', description: 'The media record to replace.' },
                    file: { type: 'string', format: 'binary' },
                  },
                },
              },
            },
          },
          responses: {
            '200': ok({
              type: 'object',
              properties: {
                id: { type: 'string' },
                url: { type: 'string' },
                replaced: {
                  type: 'object',
                  properties: {
                    posts_updated: { type: 'integer' },
                    products_updated: { type: 'integer' },
                    files_removed: { type: 'integer' },
                    files_kept_shared: { type: 'integer' },
                  },
                },
              },
            }),
            '400': { description: 'No id, no file, too large, or bytes we do not accept' },
            '403': { description: 'You may only replace media you uploaded' },
            '404': { description: 'No such media record' },
          },
        },
      },
      '/api/consent/receipt': {
        post: {
          summary: 'Record a consent decision (public)',
          description:
            'Written by the consent banner for a visitor who has no account, via navigator.sendBeacon as the page unloads — so this route is CSRF-EXEMPT (a beacon cannot set the double-submit header). That is safe: it carries no ambient authority to protect, an anonymous opaque browser-generated id that grants the caller nothing. Stores the decision and NOTHING ELSE: which categories, under which version of the text, at what time, under that opaque id, which the browser also keeps in its consent cookie. No address, no user agent, no fingerprint — answering an Article 7(1) obligation by collecting more personal data would be self-defeating. Idempotent on the id (a banner may retry). An out-of-range version is rejected rather than silently rewritten. Rate-limited per address, and a throttled call is still answered as success so a visitor never sees an error over bookkeeping.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['id'],
                  properties: {
                    id: { type: 'string', format: 'uuid', description: 'Generated by the browser. Not derived from anything.' },
                    granted: { type: 'array', items: { type: 'string' }, description: 'Categories granted; unknown names are dropped rather than recorded.' },
                    version: { type: 'integer', description: 'The version of the consent text that was shown.' },
                  },
                },
              },
            },
          },
          responses: {
            '200': ok({ type: 'object', properties: { recorded: { type: 'boolean' } } }),
            '400': { description: 'Missing or malformed receipt id' },
          },
        },
        get: {
          summary: 'Read the consent trail (admin only)',
          description:
            'Without `id`, the most recent decisions; with it, the one receipt a visitor is quoting. Nothing here can be turned into a person — that is the design — so this is a compliance record, not an analytics feed.',
          security: [{ bearerApiKey: [] }],
          parameters: [
            { name: 'id', in: 'query', required: false, schema: { type: 'string', format: 'uuid' } },
            { name: 'limit', in: 'query', required: false, schema: { type: 'integer', maximum: 500 } },
          ],
          responses: {
            '200': ok({ type: 'array', items: { type: 'object' } }),
            '403': { description: 'Administrators only' },
            '404': { description: 'No receipt with that id' },
          },
        },
      },
      '/api/privacy/subject': {
        get: {
          summary: 'Everything this install holds about one email address (admin only)',
          description:
            'Assembles a data-subject access record (GDPR Article 15): the customer record, every order placed with that address OR by that customer, contact messages, the newsletter subscription, the staff account if there is one, and entries in custom collections whose declared email fields carry the address. Credential material is never included. Free-text fields are NOT searched: a message that merely mentions an address is somebody else\'s data too, and sweeping for substrings would answer a data request with a data breach. Audited.',
          security: [{ bearerApiKey: [] }],
          parameters: [{ name: 'email', in: 'query', required: true, schema: { type: 'string' } }],
          responses: {
            '200': ok({ type: 'object' }),
            '400': { description: 'Not an email address' },
            '403': { description: 'Administrators only' },
          },
        },
        post: {
          summary: 'Erase a data subject (admin only, irreversible)',
          description:
            'GDPR Article 17. The customer record, contact messages, newsletter subscription and form submissions are DELETED. Orders are KEPT AND ANONYMISED — totals, line items, dates and tax survive so the shop can still produce its accounts, and everything identifying the person is replaced; Article 17(3)(b) does not require erasing records held to meet a legal obligation. A staff account with the same address is reported and never removed automatically, because deleting a user orphans everything they wrote. Requires confirm: "ERASE". Idempotent, and audited.',
          security: [{ bearerApiKey: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['email', 'confirm'],
                  properties: {
                    email: { type: 'string' },
                    confirm: { type: 'string', enum: ['ERASE'], description: 'The literal word ERASE.' },
                  },
                },
              },
            },
          },
          responses: {
            '200': ok({
              type: 'object',
              properties: {
                ordersAnonymised: { type: 'integer' },
                reviewsAnonymised: {
                  type: 'integer',
                  description: 'Published product reviews kept as a star rating only (name, email, '
                    + 'order number, title and text removed). Unpublished ones are counted in deleted.reviews.',
                },
                deleted: { type: 'object' },
                staffAccountFound: { type: 'boolean' },
                notes: { type: 'array', items: { type: 'string' } },
              },
            }),
            '400': { description: 'Not an email address, or the confirmation was missing' },
            '403': { description: 'Administrators only' },
          },
        },
      },
      '/api/audit': {
        get: {
          summary: 'Security audit log (admin; most recent first)',
          description: 'Logins, API-key/webhook lifecycle, role/status changes, password resets.',
          security: [{ bearerApiKey: [] }],
          parameters: [
            { name: 'action', in: 'query', schema: { type: 'string' }, description: 'Filter by action name.' },
            { name: 'limit', in: 'query', schema: { type: 'integer' } },
          ],
          responses: { '200': ok({ type: 'array', items: { type: 'object' } }) },
        },
      },
      '/api/auth/login': {
        post: {
          summary: 'Log in with email + password',
          description: 'After repeated failed sign-ins for an account (from any address) the response is 403 with `error.code: "POW_REQUIRED"` and a proof-of-work challenge in `error.details.challenge` ({ token, bits }). Solve it (the first nonce n for which SHA-256("<token>.<n>") has `bits` leading zero bits) and resend with `pow_token: "<token>::<n>"`. The account is never locked. A cookie-less client also receives the CSRF cookie on success.',
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { email: { type: 'string' }, password: { type: 'string' }, code: { type: 'string' }, pow_token: { type: 'string' } }, required: ['email', 'password'] } } } },
          responses: {
            '200': { description: 'Logged in (session cookie set)' },
            '401': { description: 'Invalid credentials, or a two-factor code is required' },
            '403': { description: 'Proof-of-work required (POW_REQUIRED) or failed' },
            '429': { description: 'Too many attempts from this address' },
          },
        },
      },
      '/api/webhooks/deliveries': {
        get: {
          summary: 'List the webhook delivery log (admin; most recent first)',
          security: [{ bearerApiKey: [] }],
          parameters: [
            { name: 'webhook', in: 'query', schema: { type: 'string' }, description: 'Filter by webhook id.' },
            { name: 'limit', in: 'query', schema: { type: 'integer' } },
          ],
          responses: { '200': ok({ type: 'array', items: { type: 'object' } }) },
        },
      },
      '/api/webhooks/deliveries/{id}/redeliver': {
        post: {
          summary: 'Re-send a recorded delivery (admin; exact signed payload)',
          security: [{ bearerApiKey: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': ok({ type: 'object' }), '404': { description: 'Not found' } },
        },
      },
      '/api/auth/forgot': {
        post: {
          summary: 'Request a password-reset email',
          description: 'Always returns a generic 200 (no account enumeration). Emails a single-use, 1-hour reset link when the account exists.',
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { email: { type: 'string' } }, required: ['email'] } } } },
          responses: { '200': ok({ type: 'null' }) },
        },
      },
      '/api/auth/reset': {
        post: {
          summary: 'Complete a password reset with an emailed token',
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { token: { type: 'string' }, password: { type: 'string' } }, required: ['token', 'password'] } } } },
          responses: { '200': ok({ type: 'null' }), '400': { description: 'Invalid or expired token' } },
        },
      },
      '/api/auth/magic-link': {
        post: {
          summary: 'Request a passwordless sign-in link by email',
          description: 'Always returns a generic 200 (no account enumeration). Requires an active email channel; emails a single-use, 15-minute link. Throttled per IP+email.',
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { email: { type: 'string' } }, required: ['email'] } } } },
          responses: { '200': ok({ type: 'null' }) },
        },
      },
      '/api/auth/magic': {
        get: {
          summary: 'Consume a sign-in link',
          description: 'Signs the visitor in (or hands them to the 2FA step) and redirects. The token is single-use and bound to the account’s session_version. Every failure is the same neutral redirect to /login.',
          parameters: [{ name: 'token', in: 'query', required: true, schema: { type: 'string' } }],
          responses: { '303': { description: 'Redirect: /admin with a session, /login?twofa=1 for the second factor, or /login?error=magic' } },
        },
      },
      '/api/captcha/challenge': {
        get: {
          summary: 'Issue a proof-of-work anti-spam challenge',
          description: 'Public. Returns {enabled:false} when the surface is unprotected; otherwise a signed single-use challenge the browser solves before submitting the protected form (see /captcha.js).',
          parameters: [{ name: 'surface', in: 'query', required: true, schema: { type: 'string', enum: ['contact', 'newsletter', 'login', 'forgot', 'forms', 'checkout', 'magic-link', 'reviews'] }, description: '`reviews` is always on; the others follow the operator\'s anti-spam settings.' }],
          responses: {
            '200': ok({ type: 'object', properties: { enabled: { type: 'boolean' }, token: { type: 'string' }, bits: { type: 'integer' } }, required: ['enabled'] }),
            '400': { description: 'Unknown surface' },
          },
        },
      },
    },
  };
  return new Response(JSON.stringify(spec, null, 2), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' },
  });
};
