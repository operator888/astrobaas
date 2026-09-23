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
  const Product = {
    type: 'object',
    properties: {
      custom: { type: 'object', additionalProperties: true, description: 'Values for the fields this merchant declared. Public callers see only the fields marked public; staff see the whole bag. See GET /api/commerce/product-fields for the schema.' },
      id: { type: 'string' }, name: { type: 'string' }, slug: { type: 'string' },
      sku: { type: 'string' }, description: { type: 'string' }, short_description: { type: 'string' },
      price_cents: { type: 'integer' }, regular_price_cents: { type: 'integer' },
      sale_price_cents: { type: 'integer', nullable: true }, on_sale: { type: 'boolean' },
      stock: { type: 'integer', nullable: true }, in_stock: { type: 'boolean' },
      categories: { type: 'array', items: { type: 'string' } }, brand: { type: 'string' },
      images: { type: 'array', items: { type: 'object', properties: { src: { type: 'string' }, alt: { type: 'string' } } } },
      status: { type: 'string', enum: ['active', 'draft', 'archived'] },
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
      kind: { type: 'string', enum: ['percent', 'fixed'] },
      value: { type: 'integer', description: 'Basis points for percent (1000 = 10%), minor units for fixed.' },
      enabled: { type: 'boolean' }, description: { type: 'string' },
      min_subtotal_cents: { type: ['integer', 'null'] },
      starts_at: { type: ['string', 'null'] }, ends_at: { type: ['string', 'null'] },
      usage_limit: { type: ['integer', 'null'] },
      usage_limit_per_customer: { type: ['integer', 'null'] },
      used_count: { type: 'integer' },
      product_ids: { type: 'array', items: { type: 'string' } },
      category_slugs: { type: 'array', items: { type: 'string' } },
      free_shipping: { type: 'boolean' },
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
      tax_id: { type: 'string', description: 'VAT identifier / ΑΦΜ. Never verified against VIES here.' },
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
      items: { type: 'array', items: { type: 'object', properties: { product_id: { type: 'string' }, name: { type: 'string' }, qty: { type: 'integer' }, total_cents: { type: 'integer' } } } },
      created_at: { type: 'string' }, updated_at: { type: 'string' },
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
      schemas: { Post, Product, Order, Address, ShippingMethod, Coupon, DeepHealth, RedirectRule, NotFoundRecord, ContentTypeDef },
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
                'Narrow to records whose DECLARED field holds this value, compared as a string — e.g. `?where.post_id=abc`. Only declared fields: a filter cannot probe `_status` or any other key the server sets and reads as authority. An array field matches if any item does. An unknown field name is ignored rather than refused, so a storefront sending a stale filter gets the unfiltered list instead of a page that will not render — it cannot leak, because a filter only ever narrows what the caller could already see. On a MODERATED type the approval filter is applied first, so this never widens visibility.',
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
          description: 'Optional `scopes` (e.g. ["posts:write"]) restrict the key to resource:action capabilities; omit for full role-based access. `expires_in_days` sets an expiry. `forward_client_ip: true` lets the key\'s server name the shopper a request is for in `X-AstroBaaS-Client-IP` (one address), which per-IP route limits and order risk then use; the header is ignored on every other request.',
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
          summary: 'Search published content (public)',
          parameters: [{ name: 'q', in: 'query', schema: { type: 'string' } }],
          responses: { '200': ok({ type: 'array', items: { type: 'object' } }) },
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
            + 'or not the mail went out, so this cannot be used to ask "is this person on your list?".',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['email'], properties: { email: { type: 'string' } } } } },
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
            { name: 'on_sale', in: 'query', schema: { type: 'boolean' } },
            { name: 'limit', in: 'query', schema: { type: 'integer' } },
            { name: 'offset', in: 'query', schema: { type: 'integer' } },
          ],
          responses: { '200': ok({ type: 'array', items: { $ref: '#/components/schemas/Product' } }) },
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
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': ok({ $ref: '#/components/schemas/Product' }) },
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
      '/api/product-categories': {
        get: { summary: 'List product categories (public)', responses: { '200': ok({ type: 'array', items: { type: 'object' } }) } },
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
              items: { type: 'array', items: { type: 'object', required: ['product_id', 'qty'], properties: { product_id: { type: 'string' }, qty: { type: 'integer' } } } },
              shipping_country: { type: 'string', description: 'ISO-3166 alpha-2.' },
              shipping_postcode: { type: 'string' },
              shipping_method_id: { type: 'string', description: 'An id from available_shipping_methods. Its COST is always re-derived server-side.' },
              coupon_code: { type: 'string' },
              email: { type: 'string', description: 'Only used to evaluate per-customer coupon limits.' },
            } } } },
          },
          responses: {
            '200': ok({ type: 'object', properties: {
              subtotal_cents: { type: 'integer' }, discount_cents: { type: 'integer' },
              shipping_cents: { type: 'integer' }, tax_cents: { type: 'integer' },
              total_cents: { type: 'integer' }, prices_include_tax: { type: 'boolean' },
              requires_shipping: { type: 'boolean' }, weight_grams: { type: 'integer' },
              lines: { type: 'array', items: { type: 'object' }, description: 'Per-line net/tax/discount breakdown.' },
              available_shipping_methods: { type: 'array', items: { type: 'object' } },
              coupon: { type: 'object', description: 'A REJECTED coupon is reported here with a reason, not as an error — the rest of the quote is still valid.' },
            } }),
            '400': errRes('Invalid basket, an order limit exceeded, or an unavailable product'),
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
            '400': errRes('No reason given, an unknown tax class, a line index out of range, or an erased order'),
            '403': errRes('Missing the override_tax capability'),
            '404': errRes('Not found'),
          },
        },
      },
      '/api/commerce/product-fields': {
        get: {
          summary: 'Fields this merchant declared on their products. Public callers get ONLY the fields marked public — no values, no private field names, and no count of what was withheld. Staff get every declaration, which the admin product form needs.',
          responses: { '200': ok({ type: 'object', properties: { fields: { type: 'array', items: { type: 'object' } } } }) },
        },
        put: {
          summary: 'Replace the product-field declarations (admin). Removing a declaration HIDES the field; the values products already store survive.',
          security: [{ bearerApiKey: [] }],
          responses: { '200': ok({ type: 'object' }), '400': errRes('Invalid definitions'), '403': errRes('Admin only') },
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
            content: { 'application/json': { schema: { type: 'object', required: ['email', 'items'], properties: { email: { type: 'string' }, name: { type: 'string' }, phone: { type: 'string' }, address: { type: 'string' }, note: { type: 'string' }, pow_token: { type: 'string', description: 'Solved proof-of-work (challenge::nonce), required only when the shop enables the checkout anti-spam surface.' }, items: { type: 'array', items: { type: 'object', required: ['product_id', 'qty'], properties: { product_id: { type: 'string' }, qty: { type: 'integer' } } } } } } } },
          },
          responses: {
            '201': ok({ type: 'object' }),
            '400': errRes('Invalid payload, unavailable product, an order limit exceeded, a refused coupon (reason checkout.coupon_invalid), or a malformed Idempotency-Key'),
            '403': errRes('Proof-of-work required and missing or invalid (reason checkout.captcha_failed)'),
            '409': errRes('Insufficient stock — another buyer took the units first. Safe to retry with a smaller quantity. Also: IDEMPOTENCY_IN_PROGRESS, or checkout.promotion_unavailable.'),
            '422': errRes('Invalid payload fields (e.g. email), or an Idempotency-Key reused with a different body (IDEMPOTENCY_KEY_REUSED)'),
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
          summary: 'List customers (staff only — PII)', security: [{ bearerApiKey: [] }],
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
          parameters: [{ name: 'surface', in: 'query', required: true, schema: { type: 'string', enum: ['contact', 'newsletter', 'login', 'forgot'] } }],
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
