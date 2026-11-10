/**
 * Grouped products: one page showing several products, each bought on its own.
 *
 * The CMS resolves a group's members on every read (`grouped_products`),
 * skips any a shopper may not see, and sets the group's `price_cents` to the
 * lowest member price. This file decides nothing; it only names the shape, so
 * a page can read it with a CMS client whose types predate the field.
 */
import type { Product } from './cms';
import type { StockInfo } from './stock';

export interface GroupMember {
  id: string;
  name: string;
  slug: string;
  sku?: string;
  /** `variable`: options must be chosen on the member's own page. */
  type: 'simple' | 'variable';
  price_cents: number;
  regular_price_cents?: number;
  on_sale?: boolean;
  stock_status?: StockInfo | null;
  image: { src: string; alt?: string } | null;
}

type MaybeGroup = Product & { type?: string; grouped_products?: GroupMember[] };

export function isGroup(p: Product): boolean {
  return (p as MaybeGroup).type === 'grouped';
}

/** The members to show, in the merchant's order. Empty for anything else. */
export function groupMembers(p: Product): GroupMember[] {
  const g = p as MaybeGroup;
  return g.type === 'grouped' && Array.isArray(g.grouped_products) ? g.grouped_products : [];
}
