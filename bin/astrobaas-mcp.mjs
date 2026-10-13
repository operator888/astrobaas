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
import fs from 'node:fs';
import process from 'node:process';
import { apiRequest as sharedApiRequest } from './lib/api-client.mjs';

const SERVER_NAME = 'astrobaas';
/**
 * The version of the package this file shipped in. It ships twice — as
 * bin/astrobaas-mcp.mjs in `astrobaas` (package.json one level up) and as the
 * root of `astrobaas-mcp` (package.json beside it) — so it reads whichever
 * belongs to it. A literal here said 0.1.0 in every release after 0.1.0.
 */
const SERVER_VERSION = (() => {
  for (const rel of ['./package.json', '../package.json']) {
    try {
      const pkg = JSON.parse(fs.readFileSync(new URL(rel, import.meta.url), 'utf8'));
      if (pkg.name === 'astrobaas' || pkg.name === 'astrobaas-mcp') return pkg.version;
    } catch { /* not this layout */ }
  }
  return '0.0.0';
})();
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

  /* ---------------- finance (src/plugins/finance) ----------------
   * Invoices, payments, expenses and the VAT figures. Needs the Finance plugin
   * active and a key belonging to an admin or manager; scope it to
   * finance:read / finance:write. Money is integer CENTS throughout.
   */
  ...financeTools(),
];

function financeTools() {
  const q = (a, keys) => {
    const qs = new URLSearchParams();
    for (const k of keys) if (a[k] !== undefined && a[k] !== '') qs.set(k, String(a[k]));
    const s = qs.toString();
    return s ? `?${s}` : '';
  };
  const id = { type: 'string', description: 'Document id (doc_…), not the invoice number.' };
  const date = { type: 'string', description: 'YYYY-MM-DD' };
  const line = {
    type: 'object',
    properties: {
      name: { type: 'string' },
      description: { type: 'string' },
      quantity: { type: 'number' },
      unit: { type: 'string', description: 'UN/ECE code: HUR hour, DAY, MON month, ANN year, C62 piece, LS lump sum.' },
      unit_price_cents: { type: 'integer', description: 'Net unit price in cents (gross when price_mode is gross).' },
      tax_rate: { type: 'number', description: '19, 7 or 0 for German VAT.' },
      discount_percent: { type: 'number' },
      period_start: date,
      period_end: date,
    },
    required: ['name', 'quantity', 'unit_price_cents'],
  };
  return [
    {
      name: 'finance_summary',
      description: 'Finance dashboard: revenue this month/year, open and overdue receivables, payables, VAT payable this quarter, drafts, unmatched bank transactions, dunning due, top customers.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: () => apiRequest('GET', `/api/plugin/finance/summary`),
    },
    {
      name: 'finance_list_documents',
      description: 'List invoices, quotes or credit notes. status "overdue" lists unpaid invoices past their due date.',
      inputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['invoice', 'quote', 'credit_note'] },
          status: { type: 'string', enum: ['draft', 'open', 'partially_paid', 'paid', 'cancelled', 'overdue', 'accepted', 'rejected', 'invoiced'] },
          q: { type: 'string', description: 'Search number / customer.' },
          contact_id: { type: 'string' }, from: date, to: date,
        },
        additionalProperties: false,
      },
      run: (a = {}) => apiRequest('GET', `/api/plugin/finance/documents${q(a, ['type', 'status', 'q', 'contact_id', 'from', 'to'])}`),
    },
    {
      name: 'finance_get_document',
      description: 'One invoice/quote/credit note with lines, totals, payments and the customer link.',
      inputSchema: { type: 'object', properties: { id }, required: ['id'], additionalProperties: false },
      run: (a) => apiRequest('GET', `/api/plugin/finance/documents/${encodeURIComponent(a.id)}`),
    },
    {
      name: 'finance_create_document',
      description: 'Create an invoice, quote or credit note as a DRAFT (no number yet). Pass finalize:true to finalize at once — that assigns the number and makes it immutable (GoBD). VAT treatment is derived from the customer unless given.',
      inputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['invoice', 'quote'] },
          contact_id: { type: 'string' },
          lines: { type: 'array', items: line },
          title: { type: 'string' }, intro: { type: 'string' }, closing: { type: 'string' },
          issue_date: date, service_date: date, service_date_end: date, payment_days: { type: 'integer' },
          price_mode: { type: 'string', enum: ['net', 'gross'] },
          tax_treatment: { type: 'string', enum: ['domestic', 'small_business', 'reverse_charge_eu', 'intra_community_supply', 'third_country_service', 'export'] },
          einvoice_format: { type: 'string', enum: ['zugferd', 'xrechnung', 'pdf'] },
          finalize: { type: 'boolean' },
        },
        required: ['contact_id', 'lines'],
        additionalProperties: false,
      },
      run: (a) => apiRequest('POST', `/api/plugin/finance/documents`, a),
    },
    {
      name: 'finance_update_draft',
      description: 'Change a DRAFT document (lines, dates, texts). Finalized documents cannot be changed — cancel with a credit note instead.',
      inputSchema: { type: 'object', properties: { id, changes: { type: 'object' } }, required: ['id', 'changes'], additionalProperties: false },
      run: (a) => apiRequest('PUT', `/api/plugin/finance/documents/${encodeURIComponent(a.id)}`, a.changes),
    },
    {
      name: 'finance_check_document',
      description: 'Validate a draft before finalizing: errors (blocking) and warnings, including e-invoice (XRechnung/ZUGFeRD) requirements.',
      inputSchema: { type: 'object', properties: { id }, required: ['id'], additionalProperties: false },
      run: (a) => apiRequest('GET', `/api/plugin/finance/documents/${encodeURIComponent(a.id)}/check`),
    },
    {
      name: 'finance_finalize_document',
      description: 'Finalize a draft: assigns the next number, freezes it and archives the PDF/XML. IRREVERSIBLE — confirm with the user first.',
      inputSchema: { type: 'object', properties: { id }, required: ['id'], additionalProperties: false },
      run: (a) => apiRequest('POST', `/api/plugin/finance/documents/${encodeURIComponent(a.id)}/finalize`),
    },
    {
      name: 'finance_send_document',
      description: 'Email a finalized document to the customer with the PDF (and XRechnung XML) attached. Sends a real email — confirm first.',
      inputSchema: { type: 'object', properties: { id, to: { type: 'string' }, subject: { type: 'string' }, message: { type: 'string' } }, required: ['id'], additionalProperties: false },
      run: (a) => { const { id: did, ...rest } = a; return apiRequest('POST', `/api/plugin/finance/documents/${encodeURIComponent(did)}/send`, rest); },
    },
    {
      name: 'finance_record_payment',
      description: 'Record money received for an invoice. Omit amount_cents to pay the full open amount.',
      inputSchema: {
        type: 'object',
        properties: { id, amount_cents: { type: 'integer' }, date, method: { type: 'string', enum: ['bank', 'cash', 'stripe', 'paypal', 'card', 'other'] }, reference: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
      run: (a) => { const { id: did, ...rest } = a; return apiRequest('POST', `/api/plugin/finance/documents/${encodeURIComponent(did)}/payments`, rest); },
    },
    {
      name: 'finance_cancel_invoice',
      description: 'Cancel a finalized invoice with a full credit note (Storno). IRREVERSIBLE — confirm first.',
      inputSchema: { type: 'object', properties: { id, reason: { type: 'string' } }, required: ['id'], additionalProperties: false },
      run: (a) => apiRequest('POST', `/api/plugin/finance/documents/${encodeURIComponent(a.id)}/cancel`, { reason: a.reason }),
    },
    {
      name: 'finance_quote_to_invoice',
      description: 'Turn a finalized (or accepted) quote into an invoice draft.',
      inputSchema: { type: 'object', properties: { id }, required: ['id'], additionalProperties: false },
      run: (a) => apiRequest('POST', `/api/plugin/finance/documents/${encodeURIComponent(a.id)}/to-invoice`),
    },
    {
      name: 'finance_list_contacts',
      description: 'Customers and suppliers. Use to find a contact_id.',
      inputSchema: { type: 'object', properties: { q: { type: 'string' }, role: { type: 'string', enum: ['customer', 'vendor'] } }, additionalProperties: false },
      run: (a = {}) => apiRequest('GET', `/api/plugin/finance/contacts${q(a, ['q', 'role'])}`),
    },
    {
      name: 'finance_create_contact',
      description: 'Create a customer or supplier. Needs company_name or a person\'s name; billing_address.country is a 2-letter code. A VAT id enables reverse charge for EU businesses.',
      inputSchema: {
        type: 'object',
        properties: {
          company_name: { type: 'string' }, first_name: { type: 'string' }, last_name: { type: 'string' },
          email: { type: 'string' }, phone: { type: 'string' }, vat_id: { type: 'string' },
          buyer_reference: { type: 'string', description: 'Leitweg-ID for public-sector customers.' },
          billing_address: { type: 'object', properties: { street: { type: 'string' }, zip: { type: 'string' }, city: { type: 'string' }, country: { type: 'string' } } },
          roles: { type: 'object', properties: { customer: { type: 'boolean' }, vendor: { type: 'boolean' } } },
        },
        additionalProperties: false,
      },
      run: (a) => apiRequest('POST', `/api/plugin/finance/contacts`, a),
    },
    {
      name: 'finance_record_sale',
      description: 'One sale from another system (website, licence server) → customer upsert + invoice, finalized and optionally marked paid. Idempotent on source + external_id.',
      inputSchema: {
        type: 'object',
        properties: {
          source: { type: 'string' }, external_id: { type: 'string' },
          customer: { type: 'object' }, lines: { type: 'array', items: line },
          price_mode: { type: 'string', enum: ['net', 'gross'] },
          paid: { type: 'object', properties: { amount_cents: { type: 'integer' }, date, method: { type: 'string' }, reference: { type: 'string' } } },
          send_email: { type: 'boolean' },
        },
        required: ['source', 'external_id', 'customer', 'lines'],
        additionalProperties: false,
      },
      run: (a) => apiRequest('POST', `/api/plugin/finance/sales`, a),
    },
    {
      name: 'finance_list_expenses',
      description: 'Incoming invoices / receipts.',
      inputSchema: { type: 'object', properties: { status: { type: 'string', enum: ['draft', 'open', 'paid'] }, q: { type: 'string' } }, additionalProperties: false },
      run: (a = {}) => apiRequest('GET', `/api/plugin/finance/expenses${q(a, ['status', 'q'])}`),
    },
    {
      name: 'finance_create_expense',
      description: 'Book an expense from a receipt you have read. lines[].category is one of: software, hosting, subcontractors, phone, internet, office, literature, advertising, entertainment, travel, vehicle, consulting, bookkeeping, bank_fees, other. Give gross_cents + tax_rate, or net_cents + tax_cents. Set reverse_charge for invoices without VAT from abroad (§13b).',
      inputSchema: {
        type: 'object',
        properties: {
          supplier_name: { type: 'string' }, supplier_vat_id: { type: 'string' }, supplier_country: { type: 'string' },
          invoice_number: { type: 'string' }, date, due_date: date,
          status: { type: 'string', enum: ['draft', 'open', 'paid'] }, reverse_charge: { type: 'boolean' },
          lines: { type: 'array', items: { type: 'object', properties: { category: { type: 'string' }, description: { type: 'string' }, gross_cents: { type: 'integer' }, net_cents: { type: 'integer' }, tax_cents: { type: 'integer' }, tax_rate: { type: 'number' } } } },
          note: { type: 'string' },
        },
        required: ['supplier_name', 'lines'],
        additionalProperties: false,
      },
      run: (a) => apiRequest('POST', `/api/plugin/finance/expenses`, a),
    },
    {
      name: 'finance_open_items',
      description: 'Open receivables and payables with days overdue.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: () => apiRequest('GET', `/api/plugin/finance/reports/open-items`),
    },
    {
      name: 'finance_vat_report',
      description: 'German VAT return (UStVA) figures by Kennzahl for a period, plus the amount payable (Kz 83).',
      inputSchema: { type: 'object', properties: { from: date, to: date }, required: ['from', 'to'], additionalProperties: false },
      run: (a) => apiRequest('GET', `/api/plugin/finance/reports/vat${q(a, ['from', 'to'])}`),
    },
    {
      name: 'finance_profit_loss',
      description: 'Revenue, expenses by category and result for a period (net, by invoice date).',
      inputSchema: { type: 'object', properties: { from: date, to: date }, required: ['from', 'to'], additionalProperties: false },
      run: (a) => apiRequest('GET', `/api/plugin/finance/reports/pnl${q(a, ['from', 'to'])}`),
    },
    {
      name: 'finance_unmatched_bank_transactions',
      description: 'Bank transactions not yet matched to an invoice or expense.',
      inputSchema: { type: 'object', properties: { year: { type: 'string' } }, additionalProperties: false },
      run: (a = {}) => apiRequest('GET', `/api/plugin/finance/bank/transactions?status=unmatched${a.year ? `&year=${encodeURIComponent(a.year)}` : ''}`),
    },
    {
      name: 'finance_match_bank_transaction',
      description: 'Match a bank transaction to an invoice (kind "document") or expense (kind "expense"). Use finance_bank_suggestions first.',
      inputSchema: { type: 'object', properties: { transaction_id: { type: 'string' }, kind: { type: 'string', enum: ['document', 'expense'] }, id: { type: 'string' } }, required: ['transaction_id', 'kind', 'id'], additionalProperties: false },
      run: (a) => apiRequest('POST', `/api/plugin/finance/bank/transactions/${encodeURIComponent(a.transaction_id)}/match`, { kind: a.kind, id: a.id }),
    },
    {
      name: 'finance_bank_suggestions',
      description: 'Ranked match suggestions for one bank transaction.',
      inputSchema: { type: 'object', properties: { transaction_id: { type: 'string' } }, required: ['transaction_id'], additionalProperties: false },
      run: (a) => apiRequest('GET', `/api/plugin/finance/bank/transactions/${encodeURIComponent(a.transaction_id)}/suggestions`),
    },
    {
      name: 'finance_dunning_suggestions',
      description: 'Overdue invoices due for a reminder, with the next dunning level.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: () => apiRequest('GET', `/api/plugin/finance/dunning`),
    },
    {
      name: 'finance_run_recurring',
      description: 'Create every recurring invoice that is due (retainers, hosting, licences). Idempotent per period.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: () => apiRequest('POST', `/api/plugin/finance/recurring/run`),
    },
  ];
}

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
