/**
 * Everything this storefront reads from the CMS, in one place.
 *
 * Build-time only: these run while `astro build` renders pages, never in a
 * shopper's browser. The browser talks to the CMS in exactly two places — the
 * cart (quote) and checkout (place order, start payment) — see src/scripts/.
 *
 * Anonymous on purpose. No API key is needed or used: the catalogue, the blog,
 * the categories and the menu are public, and an anonymous caller is shown
 * only what a shopper may buy. A storefront that holds no secret cannot leak
 * one.
 */
import { createClient } from 'astrobaas/client';
import type { Post, Product, ProductCategory } from 'astrobaas/core';

export const CMS_URL = String(import.meta.env.PUBLIC_CMS_URL ?? '').replace(/\/+$/, '');

export const cms = createClient(CMS_URL, { timeoutMs: 20_000, retries: 2 });

export type { Post, Product, ProductCategory };

/** One menu item as `GET /api/navigation` serves it. */
export interface MenuItem {
  label: string;
  href: string;
  external: boolean;
  newTab: boolean;
  current: boolean;
  children: MenuItem[];
}

/*
 * Memoised per build. A static build renders every product page, and each one
 * would otherwise ask for the same catalogue, categories and currency again.
 */
const once = <T>(fn: () => Promise<T>) => {
  let p: Promise<T> | null = null;
  return () => (p ??= fn());
};

export const allProducts = once(() => cms.products.listAll());

export const allCategories = once(() =>
  cms.request<(ProductCategory & { product_count_total?: number })[]>('GET', '/api/product-categories'));

/** The shop's currency. Products carry cents, not a currency; the shop has one. */
export const shopCurrency = once(async () => {
  const c = await cms.request<{ base?: string }>('GET', '/api/commerce/currencies');
  return typeof c?.base === 'string' ? c.base : 'EUR';
});

/**
 * The CMS's menu, edited at Site → Navigation. Empty when the operator has not
 * set one, and then the layout shows its own links — the same rule the CMS's
 * own themes follow.
 */
export const siteMenu = once(async () => {
  try {
    // The endpoint answers `{ items: [...] }`, not a bare list.
    const data = await cms.request<{ items?: MenuItem[] }>('GET', '/api/navigation');
    return Array.isArray(data?.items) ? data.items : [];
  } catch {
    return [] as MenuItem[]; // an older CMS without the endpoint
  }
});

/** Products in a category AND its subcategories — the CMS expands the tree. */
export function productsIn(slug: string) {
  return cms.products.listAll({ category: slug });
}

export const allPosts = once(() => cms.posts.listAll({}));

/** A product is on sale when the CMS says so and the sale price is lower. */
export function priceOf(p: Product): { now: number; was: number | null } {
  const now = p.price_cents;
  const was = p.on_sale && p.regular_price_cents && p.regular_price_cents > now ? p.regular_price_cents : null;
  return { now, was };
}

/**
 * Should this product appear in shop listings? The merchant's "catalogue
 * visibility": `visible` and `catalog` are listed; `search` is for search
 * results only and `hidden` is reachable by its link alone. The CMS's product
 * list does not apply this itself, so a storefront has to.
 */
export function listed(p: Product): boolean {
  const v = p.catalog_visibility ?? 'visible';
  return v === 'visible' || v === 'catalog';
}
