import { definePlugin, registerContentType } from 'astrobaas/core';

/**
 * Catalog Items — demonstrates a CUSTOM CONTENT TYPE. On activation it registers
 * a "catalog-item" collection with a typed field schema; AstroBaaS then exposes
 * generic CRUD at /api/content/catalog-item (and /catalog-item/<id>), validating
 * every write against these fields. This is the primitive that lets a builder
 * model anything — events, docs, listings — without forking core.
 *
 * NOTE: it deliberately does NOT register "product". Shop products are a
 * first-class collection now (/api/products, see COMMERCE.md), and that name is
 * reserved — a custom type may not shadow a built-in route.
 */
export default definePlugin({
  id: 'product-catalog',
  name: 'Product Catalog',
  version: '1.0.0',
  description: 'Adds a "catalog-item" custom content type (name, price, sku, description). Demo of the custom-content primitive — for a real shop use the built-in products.',
  author: 'AstroBaaS',
  activate() {
    registerContentType({
      name: 'catalog-item',
      label: 'Catalog Item',
      labelPlural: 'Catalog Items',
      // Stated explicitly, because types are private by default now. A demo
      // catalogue is exactly the case the `public` option exists for: it is
      // shop-window data a storefront renders without credentials.
      visibility: 'public',
      fields: [
        { name: 'name', rule: { type: 'string', min: 1, max: 200 } },
        { name: 'price', rule: { type: 'number', min: 0 } },
        { name: 'sku', rule: { type: 'string', max: 64, optional: true } },
        { name: 'description', rule: { type: 'string', max: 5000, optional: true } },
        { name: 'in_stock', rule: { type: 'boolean', optional: true } },
      ],
    });
  },
});
