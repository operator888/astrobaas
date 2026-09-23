#!/usr/bin/env node
/**
 * AstroBaaS MCP server — exposes a running AstroBaaS backend as Model Context
 * Protocol tools so an AI agent (Claude Desktop/Code, etc.) can read and write
 * content directly.
 *
 * Transport: stdio (newline-delimited JSON-RPC 2.0), the MCP stdio standard.
 * Zero dependencies — implements the handshake + tools surface by hand so it
 * runs under `npx` with no install.
 *
 * Configure via env:
 *   ASTROBAAS_URL   base URL of the backend   (default http://localhost:4321)
 *   ASTROBAAS_KEY   bearer API key (mint at POST /api/keys)   [required to write]
 *
 * Example MCP client config (Claude Desktop):
 *   {
 *     "mcpServers": {
 *       "astrobaas": {
 *         "command": "npx",
 *         "args": ["astrobaas-mcp"],
 *         "env": { "ASTROBAAS_URL": "https://cms.example.com", "ASTROBAAS_KEY": "abk_..." }
 *       }
 *     }
 *   }
 */
import process from 'node:process';
import { apiRequest as sharedApiRequest } from './lib/api-client.mjs';

const SERVER_NAME = 'astrobaas';
const SERVER_VERSION = '0.1.0';
// Protocol versions we understand; we echo the client's if supported, else this.
const DEFAULT_PROTOCOL = '2024-11-05';
const SUPPORTED_PROTOCOLS = new Set(['2024-11-05', '2025-03-26', '2025-06-18']);

const BASE = (process.env.ASTROBAAS_URL || 'http://localhost:4321').replace(/\/+$/, '');
const KEY = process.env.ASTROBAAS_KEY || '';

/* ---------- REST helper ----------
 * The shared client in bin/lib/api-client.mjs. This file had the only copy, and
 * the CLI's new content verbs needed the same three things it had already got
 * right — the bearer header, the envelope unwrap, and the fact that a body
 * carrying `success: false` is an error even at HTTP 200. A second copy would
 * have missed the third, because it is the one you only find by hitting it.
 */
async function apiRequest(method, path, body) {
  return sharedApiRequest(method, path, body, { base: BASE, key: KEY });
}

/* ---------- tool definitions ---------- */
const TOOLS = [
  {
    name: 'whoami',
    description: 'Return the principal (id + role) the configured API key resolves to. Use this first to confirm connectivity and permissions.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: () => apiRequest('GET', '/api/auth/me'),
  },
  {
    name: 'list_posts',
    description: 'List posts. Without auth only published posts are returned. Optional filters.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['draft', 'review', 'scheduled', 'published', 'trashed'] },
        category: { type: 'string', description: 'Category id to filter by.' },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
      },
      additionalProperties: false,
    },
    run: (a = {}) => {
      const qs = new URLSearchParams();
      if (a.status) qs.set('status', a.status);
      if (a.category) qs.set('category', a.category);
      if (a.limit) qs.set('limit', String(a.limit));
      const q = qs.toString();
      return apiRequest('GET', `/api/posts${q ? `?${q}` : ''}`);
    },
  },
  {
    name: 'get_post',
    description: 'Fetch a single post by its slug.',
    inputSchema: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'], additionalProperties: false },
    run: (a) => apiRequest('GET', `/api/posts/${encodeURIComponent(a.slug)}`),
  },
  {
    name: 'create_post',
    description: 'Create a post. Requires an API key with author+ role. HTML in content is sanitized server-side.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        content: { type: 'string' },
        excerpt: { type: 'string' },
        status: { type: 'string', enum: ['draft', 'review', 'scheduled', 'published', 'trashed'] },
        category_id: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['title'],
      additionalProperties: false,
    },
    run: (a) => apiRequest('POST', '/api/posts', a),
  },
  {
    name: 'update_post',
    description: 'Update a post by id or slug (partial). Requires an author+ key; ownership enforced.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Post id or slug.' },
        title: { type: 'string' },
        content: { type: 'string' },
        excerpt: { type: 'string' },
        status: { type: 'string', enum: ['draft', 'review', 'scheduled', 'published', 'trashed'] },
        category_id: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['ref'],
      additionalProperties: false,
    },
    run: (a) => {
      const { ref, ...updates } = a;
      return apiRequest('PUT', `/api/posts/${encodeURIComponent(ref)}`, updates);
    },
  },
  {
    name: 'delete_post',
    description: 'Delete a post by id or slug. Requires an author+ key; ownership enforced.',
    inputSchema: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'], additionalProperties: false },
    run: (a) => apiRequest('DELETE', `/api/posts/${encodeURIComponent(a.ref)}`),
  },
  {
    name: 'list_content',
    description: 'List entities of a custom (plugin-registered) content type, e.g. "product".',
    inputSchema: { type: 'object', properties: { type: { type: 'string' } }, required: ['type'], additionalProperties: false },
    run: (a) => apiRequest('GET', `/api/content/${encodeURIComponent(a.type)}`),
  },
  {
    name: 'create_content',
    description: 'Create an entity in a custom content type. `data` is validated against the type schema server-side.',
    inputSchema: {
      type: 'object',
      properties: { type: { type: 'string' }, data: { type: 'object' } },
      required: ['type', 'data'],
      additionalProperties: false,
    },
    run: (a) => apiRequest('POST', `/api/content/${encodeURIComponent(a.type)}`, a.data),
  },
  {
    name: 'update_content',
    description: 'Update a custom content entity by id (merges `data`).',
    inputSchema: {
      type: 'object',
      properties: { type: { type: 'string' }, id: { type: 'string' }, data: { type: 'object' } },
      required: ['type', 'id', 'data'],
      additionalProperties: false,
    },
    run: (a) => apiRequest('PUT', `/api/content/${encodeURIComponent(a.type)}/${encodeURIComponent(a.id)}`, a.data),
  },
  {
    name: 'delete_content',
    description: 'Delete a custom content entity by id.',
    inputSchema: {
      type: 'object',
      properties: { type: { type: 'string' }, id: { type: 'string' } },
      required: ['type', 'id'],
      additionalProperties: false,
    },
    run: (a) => apiRequest('DELETE', `/api/content/${encodeURIComponent(a.type)}/${encodeURIComponent(a.id)}`),
  },

  /* ---------------- commerce: catalogue ---------------- */
  {
    name: 'list_products',
    description:
      'List catalogue products. Public read (no key needed). `meta` carries the order limits (max_qty_per_product, max_items_per_order) — read them rather than assuming, an operator can change them.',
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'Product category id or slug.' },
        featured: { type: 'boolean' },
        search: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
      },
      additionalProperties: false,
    },
    run: (a = {}) => {
      const qs = new URLSearchParams();
      if (a.category) qs.set('category', a.category);
      if (a.featured !== undefined) qs.set('featured', String(a.featured));
      if (a.search) qs.set('search', a.search);
      if (a.limit) qs.set('limit', String(a.limit));
      const q = qs.toString();
      return apiRequest('GET', `/api/products${q ? `?${q}` : ''}`);
    },
  },
  {
    name: 'get_product',
    description: 'Fetch one product by id or slug.',
    inputSchema: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'], additionalProperties: false },
    run: (a) => apiRequest('GET', `/api/products/${encodeURIComponent(a.ref)}`),
  },
  {
    name: 'create_product',
    description:
      'Create a product. Requires a key with products:write. MONEY IS INTEGER CENTS — price_cents: 1999 means 19.99. Floats are rejected.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        slug: { type: 'string', description: 'Optional; derived from the name when omitted. Must be unique.' },
        price_cents: { type: 'integer', minimum: 0, description: 'Integer minor units, never a float.' },
        regular_price_cents: { type: 'integer', minimum: 0 },
        sale_price_cents: { type: 'integer', minimum: 0, description: 'Only counts as a sale when BELOW regular.' },
        description: { type: 'string', description: 'HTML; sanitized server-side.' },
        short_description: { type: 'string' },
        stock: { type: ['integer', 'null'], description: 'null means untracked (always purchasable).' },
        status: { type: 'string', enum: ['active', 'draft', 'archived'] },
        featured: { type: 'boolean' },
        position: { type: 'integer' },
        categories: { type: 'array', items: { type: 'string' } },
      },
      required: ['name', 'price_cents'],
      additionalProperties: false,
    },
    run: (a) => apiRequest('POST', '/api/products', a),
  },
  {
    name: 'update_product',
    description: 'Update a product by id (partial). Requires products:write. Slugs must stay unique.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        slug: { type: 'string' },
        price_cents: { type: 'integer', minimum: 0 },
        regular_price_cents: { type: 'integer', minimum: 0 },
        sale_price_cents: { type: 'integer', minimum: 0 },
        description: { type: 'string' },
        short_description: { type: 'string' },
        stock: { type: ['integer', 'null'] },
        status: { type: 'string', enum: ['active', 'draft', 'archived'] },
        featured: { type: 'boolean' },
        position: { type: 'integer' },
        categories: { type: 'array', items: { type: 'string' } },
      },
      required: ['id'],
      additionalProperties: false,
    },
    run: (a) => {
      const { id, ...updates } = a;
      return apiRequest('PUT', `/api/products/${encodeURIComponent(id)}`, updates);
    },
  },
  {
    name: 'delete_product',
    description: 'Delete a product by id. Requires products:write.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
    run: (a) => apiRequest('DELETE', `/api/products/${encodeURIComponent(a.id)}`),
  },
  {
    name: 'import_products',
    description:
      'Bulk upsert products by slug. Requires products:write. Rows that fail validation are REPORTED, not silently skipped — read the response before assuming a clean import. `replace: true` wipes the catalogue first and is not transactional; back up before using it.',
    inputSchema: {
      type: 'object',
      properties: {
        products: { type: 'array', items: { type: 'object' } },
        replace: { type: 'boolean' },
      },
      required: ['products'],
      additionalProperties: false,
    },
    run: (a) => apiRequest('POST', '/api/commerce/import', a),
  },
  {
    name: 'list_product_categories',
    description: 'List product categories (public read).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: () => apiRequest('GET', '/api/product-categories'),
  },
  {
    name: 'list_brands',
    description: 'List brands (public read).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: () => apiRequest('GET', '/api/brands'),
  },

  /* ---------------- commerce: orders + customers (PII) ---------------- */
  {
    name: 'list_orders',
    description:
      'List orders. STAFF ONLY — orders contain customer PII (email, phone, address). Needs a key with orders:read.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['pending', 'processing', 'on-hold', 'completed', 'cancelled', 'refunded'] },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
        offset: { type: 'integer', minimum: 0 },
      },
      additionalProperties: false,
    },
    run: (a = {}) => {
      const qs = new URLSearchParams();
      if (a.status) qs.set('status', a.status);
      if (a.limit) qs.set('limit', String(a.limit));
      if (a.offset) qs.set('offset', String(a.offset));
      const q = qs.toString();
      return apiRequest('GET', `/api/orders${q ? `?${q}` : ''}`);
    },
  },
  {
    name: 'get_order',
    description: 'Fetch one order by id. Staff only (PII).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
    run: (a) => apiRequest('GET', `/api/orders/${encodeURIComponent(a.id)}`),
  },
  {
    name: 'set_order_status',
    description:
      'Change an order\'s FULFILMENT status. Staff only. This moves stock: cancelled/refunded return it, moving back out re-takes it and fails with 409 if it is gone. It does NOT change payment_status — money is moved by the provider, not from here.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        status: { type: 'string', enum: ['pending', 'processing', 'on-hold', 'completed', 'cancelled', 'refunded'] },
        note: { type: 'string' },
      },
      required: ['id', 'status'],
      additionalProperties: false,
    },
    run: (a) => {
      const { id, ...updates } = a;
      return apiRequest('PUT', `/api/orders/${encodeURIComponent(id)}`, updates);
    },
  },
  {
    name: 'list_customers',
    description: 'List customers. STAFF ONLY — this is PII. Needs a key with customers:read.',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 200 } }, additionalProperties: false },
    run: (a = {}) => apiRequest('GET', `/api/customers${a.limit ? `?limit=${a.limit}` : ''}`),
  },
  {
    name: 'list_payment_methods',
    description:
      'Which payment methods this install can actually take. Use before offering one at checkout — a method that is not configured is refused. Staff keys additionally see which provider credentials are missing (names only).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: () => apiRequest('GET', '/api/payments'),
  },

  /* ---------------- media ---------------- */
  {
    name: 'list_media',
    description: 'List uploaded media (public read). Returns urls usable in post/product HTML.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: () => apiRequest('GET', '/api/media/get'),
  },

  /* ---------------- editorial ---------------- */
  {
    name: 'list_revisions',
    description:
      'Revision history for a post. Session/key required — revisions hold UNPUBLISHED drafts, so this is not public.',
    inputSchema: { type: 'object', properties: { ref: { type: 'string', description: 'Post id or slug.' } }, required: ['ref'], additionalProperties: false },
    run: (a) => apiRequest('GET', `/api/posts/${encodeURIComponent(a.ref)}/revisions`),
  },
  {
    name: 'search',
    description: 'Full-text search across published content.',
    inputSchema: {
      type: 'object',
      properties: { q: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 } },
      required: ['q'],
      additionalProperties: false,
    },
    run: (a) => {
      const qs = new URLSearchParams({ q: a.q });
      if (a.limit) qs.set('limit', String(a.limit));
      return apiRequest('GET', `/api/search?${qs.toString()}`);
    },
  },
  {
    name: 'list_categories',
    description: 'List post categories (public read).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: () => apiRequest('GET', '/api/categories/get'),
  },
  {
    name: 'list_locales',
    description: 'Which languages this site serves, and which is the default. Content carries a `locale` field.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: () => apiRequest('GET', '/api/locales'),
  },

  /* ---------------- site configuration ---------------- */
  {
    name: 'get_settings',
    description:
      'Read site settings. Anonymous callers get only public keys; a staff key returns everything. Never store secrets in settings — the public read path exists.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: () => apiRequest('GET', '/api/settings/get'),
  },
  {
    name: 'update_settings',
    description:
      'Update site settings (admin key required). Pass a flat object of key/value pairs. Do NOT put credentials here — settings have a public read path; use environment variables instead.',
    inputSchema: { type: 'object', properties: { settings: { type: 'object' } }, required: ['settings'], additionalProperties: false },
    run: (a) => apiRequest('POST', '/api/settings/update', a.settings),
  },
  {
    name: 'list_plugins',
    description: 'List installed plugins and whether each is active.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: () => apiRequest('GET', '/api/plugins'),
  },
  {
    name: 'set_plugin_active',
    description: 'Activate or deactivate a plugin by id (admin key required).',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, active: { type: 'boolean' } },
      required: ['id', 'active'],
      additionalProperties: false,
    },
    run: (a) => apiRequest('POST', '/api/plugins/toggle', { id: a.id, active: a.active }),
  },
  {
    name: 'get_theme',
    description: 'Active theme and its design tokens.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: () => apiRequest('GET', '/api/themes/get'),
  },
];

const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/* ---------- JSON-RPC plumbing ---------- */
function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}
function result(id, res) {
  send({ jsonrpc: '2.0', id, result: res });
}
function error(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;

  switch (method) {
    case 'initialize': {
      const requested = params?.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOLS.has(requested) ? requested : DEFAULT_PROTOCOL;
      return result(id, {
        protocolVersion,
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions: `AstroBaaS backend at ${BASE}. Call whoami first to confirm the API key's role. Published posts are exposed as resources (astrobaas://post/<slug>).`,
      });
    }
    case 'notifications/initialized':
    case 'initialized':
      return; // notification — no response
    case 'ping':
      return result(id, {});
    case 'tools/list':
      return result(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case 'tools/call': {
      const tool = TOOL_BY_NAME.get(params?.name);
      if (!tool) return error(id, -32602, `Unknown tool: ${params?.name}`);
      try {
        const data = await tool.run(params.arguments || {});
        return result(id, { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
      } catch (err) {
        // Tool errors are reported in-band (isError) per MCP, not as protocol errors.
        return result(id, { content: [{ type: 'text', text: `Error: ${err?.message || err}` }], isError: true });
      }
    }
    case 'resources/list': {
      // Expose recent posts as readable resources so agents can pull content as
      // context without a tool call. Best-effort: an error yields an empty list.
      try {
        const posts = await apiRequest('GET', '/api/posts?limit=100');
        const resources = (Array.isArray(posts) ? posts : []).map((p) => ({
          uri: `astrobaas://post/${p.slug}`,
          name: p.title,
          description: p.excerpt || undefined,
          mimeType: 'text/html',
        }));
        return result(id, { resources });
      } catch {
        return result(id, { resources: [] });
      }
    }
    case 'resources/read': {
      const uri = params?.uri || '';
      const m = /^astrobaas:\/\/post\/(.+)$/.exec(uri);
      if (!m) return error(id, -32602, `Unknown resource: ${uri}`);
      try {
        const post = await apiRequest('GET', `/api/posts/${encodeURIComponent(m[1])}`);
        return result(id, { contents: [{ uri, mimeType: 'text/html', text: post?.content ?? '' }] });
      } catch (err) {
        return error(id, -32603, `Failed to read ${uri}: ${err?.message || err}`);
      }
    }
    default:
      if (isRequest) return error(id, -32601, `Method not found: ${method}`);
      return; // unknown notification — ignore
  }
}

/* ---------- stdio read loop (newline-delimited JSON) ---------- */
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // skip malformed line
    }
    Promise.resolve(handle(msg)).catch((err) => {
      if (msg && msg.id != null) error(msg.id, -32603, String(err?.message || err));
    });
  }
});
process.stdin.on('end', () => process.exit(0));

// Announce readiness on stderr (never stdout — that's the JSON-RPC channel).
process.stderr.write(`astrobaas-mcp ready (backend: ${BASE})\n`);

// Startup validation (stderr only): probe the credential so misconfiguration is
// obvious in the logs instead of failing silently on the first tool call.
if (!KEY) {
  process.stderr.write('astrobaas-mcp: no ASTROBAAS_KEY set — reads work, writes will be rejected.\n');
} else {
  apiRequest('GET', '/api/auth/me')
    .then((me) => process.stderr.write(`astrobaas-mcp: authenticated as ${me?.role ?? 'unknown'} (${me?.id ?? '?'}).\n`))
    .catch((err) => process.stderr.write(`astrobaas-mcp: WARNING — key check failed against ${BASE}: ${err?.message || err}\n`));
}
